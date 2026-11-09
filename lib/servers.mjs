// Server connections. Each configured server has a long-lived Supervisor (status,
// cache, reconnect budget) and at most one Generation at a time (one transport and
// one SDK Client, with its own abort signal). Connections are opened lazily.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';

import { approvalState, redact } from './config.mjs';
import { filterTools, sanitizeTools } from './catalog.mjs';
import { closeClient, createTransport, openServerLog, runHeadersHelper } from './transports.mjs';

export const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
export const CATALOG_TIMEOUT_MS = 30000;
export const DEFAULT_TOOL_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const LEGACY_VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECONNECT = { initialMs: 1000, maxMs: 30000, maxFailures: 5 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accept any result shape; lists are validated by catalog.sanitizeTools instead of
// the SDK, so one malformed tool does not empty a whole server.
const ANY_RESULT = {
  '~standard': { version: 1, vendor: 'mcpc', validate: (value) => ({ value }) },
};

/** Error for a server that cannot serve a request right now (exit code 5). */
export class ServerUnavailableError extends Error {
  /**
   * @param {string} server
   * @param {string} state
   * @param {string} message
   */
  constructor(server, state, message) {
    super(message);
    this.name = 'ServerUnavailableError';
    this.code = 'server_unavailable';
    this.server = server;
    this.state = state;
  }
}

/** HTTP status carried by an SDK or fetch error, when there is one. */
export function httpStatus(error) {
  for (const value of [error?.status, error?.data?.status, error?.code, error?.cause?.status]) {
    if (Number.isInteger(value) && value >= 100 && value < 600) return value;
  }
  const match = /\b(?:HTTP|status(?: code)?)[ :]*([1-5]\d\d)\b/i.exec(String(error?.message ?? ''));
  return match ? Number(match[1]) : null;
}

const isAuthError = (error) =>
  error?.name === 'UnauthorizedError' || [401, 403].includes(httpStatus(error));

const isNetworkError = (error) =>
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up/i.test(
    `${error?.code ?? ''} ${error?.message ?? ''} ${error?.cause?.code ?? ''}`,
  );

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

/** One transport lifetime. */
class Generation {
  constructor(client, transport, kind) {
    this.client = client;
    this.transport = transport;
    this.kind = kind;
    this.abort = new AbortController();
    this.connectedAt = Date.now();
    this.closing = false;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.abort.abort(new Error('connection closed'));
    await closeClient(this.client, this.transport);
  }
}

/** Long-lived state for one configured server. */
export class Supervisor {
  /**
   * @param {ServerManager} manager
   * @param {any} resolved ResolvedServer from config.mjs
   */
  constructor(manager, resolved) {
    this.manager = manager;
    this.resolved = resolved;
    this.name = resolved.name;
    this.generation = null;
    this.connecting = null;
    this.state = 'idle';
    this.error = null;
    this.failures = 0;
    this.reconnectTimer = null;
    this.disposed = false;
    this.log = openServerLog(path.join(manager.logsDir, `${this.name}.log`));
    this.cacheFile = path.join(manager.cacheDir, `${this.name}.json`);
    this.cache = this.#loadCache();
  }

  #loadCache() {
    const cache = readJson(this.cacheFile);
    return cache && cache.fingerprint === this.resolved.fingerprint ? cache : null;
  }

  #saveCache(patch) {
    this.cache = {
      ...(this.cache ?? {}),
      ...patch,
      fingerprint: this.resolved.fingerprint,
      server: this.name,
    };
    try {
      writeJsonAtomic(this.cacheFile, this.cache);
    } catch (error) {
      this.log.write(`[mcpc] cache write failed: ${error.message}`);
    }
  }

  #redact(text) {
    return redact(String(text), this.resolved.secrets ?? []);
  }

  /** Reason this server cannot be used at all, or null. */
  blockedState() {
    const { resolved } = this;
    if (resolved.errors?.length) return { state: 'failed', error: resolved.errors.join('; ') };
    if (resolved.config?.disabled) return { state: 'disabled', error: 'disabled in configuration' };
    if (resolved.scope === 'project') {
      const decision = approvalState(this.manager.approvals, resolved);
      if (decision === 'pending')
        return {
          state: 'pending-approval',
          error: `project server needs approval: mcpc approve ${this.name}`,
        };
      if (decision === 'rejected')
        return { state: 'rejected', error: 'rejected for this workspace' };
    }
    return null;
  }

  /** Public status record. */
  status() {
    const blocked = this.blockedState();
    const tools = this.cache?.tools;
    return {
      name: this.name,
      scope: this.resolved.scope,
      type: this.resolved.type,
      transport: this.generation?.kind ?? this.cache?.transport ?? this.resolved.type,
      state: blocked?.state ?? this.state,
      error: blocked?.error ?? (this.error ? this.#redact(this.error) : null),
      toolCount: Array.isArray(tools) ? tools.length : null,
      skipped: this.cache?.skipped ?? [],
      fetchedAt: this.cache?.fetchedAt ?? null,
      serverInfo: this.cache?.serverInfo ?? null,
      era: this.cache?.era?.kind ?? null,
      alwaysLoad: this.resolved.config?.alwaysLoad === true,
    };
  }

  get instructions() {
    return this.cache?.instructions ?? null;
  }

  /** Cached tools after sanitizing and the config filter, or undefined. */
  cachedTools() {
    return this.cache?.tools;
  }

  /**
   * Return a live generation, connecting when needed (single-flight).
   *
   * @param {{reason?: string}} [options]
   * @returns {Promise<Generation>}
   */
  async connect() {
    const blocked = this.blockedState();
    if (blocked) throw new ServerUnavailableError(this.name, blocked.state, blocked.error);
    if (this.generation && !this.generation.closing) return this.generation;
    if (this.state === 'needs-auth' && !this.manager.hasAuth(this))
      throw new ServerUnavailableError(
        this.name,
        'needs-auth',
        `authentication required: mcpc login ${this.name}`,
      );
    this.connecting ??= this.#connectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connectWithRetry() {
    clearTimeout(this.reconnectTimer);
    this.state = 'connecting';
    const remote = this.resolved.type !== 'stdio';
    let lastError;
    for (let attempt = 0; attempt < (remote ? 3 : 1); attempt++) {
      try {
        const generation = await this.#connectOnce();
        this.state = 'connected';
        this.error = null;
        return generation;
      } catch (error) {
        lastError = error;
        if (!(remote && isNetworkError(error))) break;
        await delay(500 * 2 ** attempt);
      }
    }
    if (isAuthError(lastError)) {
      this.state = 'needs-auth';
      this.error = `authentication required: mcpc login ${this.name}`;
      throw new ServerUnavailableError(this.name, 'needs-auth', this.error);
    }
    this.state = 'failed';
    this.error = this.#redact(lastError?.message ?? lastError);
    throw new ServerUnavailableError(this.name, 'failed', `${this.name}: ${this.error}`);
  }

  async #headers() {
    const config = this.resolved.config;
    let headers = { ...(config.headers ?? {}) };
    if (config.headersHelper) {
      const dynamic = await runHeadersHelper(config.headersHelper, {
        name: this.name,
        url: config.url,
        cwd: this.resolved.scope === 'user' ? this.manager.home : this.manager.root,
        env: this.manager.env,
      });
      headers = { ...headers, ...dynamic };
    }
    return headers;
  }

  #prior() {
    const era = this.cache?.era;
    if (!era) return undefined;
    if (era.kind === 'modern' && era.discover) return { kind: 'modern', discover: era.discover };
    if (era.kind === 'legacy' && Date.now() - (era.at ?? 0) < LEGACY_VERDICT_MAX_AGE_MS)
      return { kind: 'legacy' };
    return undefined;
  }

  async #connectOnce() {
    const config = this.resolved.config;
    const timeout = config.startupTimeout ?? this.manager.startupTimeoutMs;
    let kind = this.resolved.type;
    if (kind === 'http' && this.cache?.transport === 'sse') kind = 'sse';

    const attempt = async (transportKind, prior) => {
      const headers = transportKind === 'stdio' ? undefined : await this.#headers();
      const authProvider =
        transportKind === 'http' || transportKind === 'sse'
          ? this.manager.authProviderFor(this, headers)
          : undefined;
      const transport = createTransport(this.resolved, {
        kind: transportKind,
        root: this.manager.root,
        env: this.manager.env,
        headers,
        authProvider,
        log: this.log,
      });
      const client = this.#createClient();
      const generation = new Generation(client, transport, transportKind);
      client.onclose = () => this.#onClose(generation);
      client.onerror = (error) =>
        this.log.write(`[mcpc] transport error: ${this.#redact(error?.message ?? error)}`);
      try {
        await client.connect(transport, { timeout, ...(prior ? { prior } : {}) });
      } catch (error) {
        generation.closing = true;
        await closeClient(client, transport).catch(() => {});
        throw error;
      }
      return generation;
    };

    let generation;
    const prior = this.#prior();
    try {
      generation = await attempt(kind, prior);
    } catch (error) {
      const status = httpStatus(error);
      if (prior) {
        this.log.write(`[mcpc] connect with cached protocol verdict failed; retrying without it`);
        generation = await this.#fallback(attempt, kind, error);
      } else if (kind === 'http' && [400, 404, 405].includes(status)) {
        this.log.write(`[mcpc] Streamable HTTP refused (${status}); trying SSE`);
        generation = await attempt('sse', undefined);
      } else throw error;
    }

    this.generation = generation;
    this.log.write(`[mcpc] connected (${generation.kind})`);
    const client = generation.client;
    const discover = client.getDiscoverResult?.();
    this.#saveCache({
      transport: generation.kind,
      era: discover
        ? { kind: 'modern', discover, at: Date.now() }
        : { kind: 'legacy', at: Date.now() },
      serverInfo: client.getServerVersion?.() ?? null,
      capabilities: client.getServerCapabilities?.() ?? {},
      instructions: client.getInstructions?.() ?? null,
    });
    await this.refresh('tools').catch((error) =>
      this.log.write(`[mcpc] tools/list failed: ${this.#redact(error.message)}`),
    );
    return generation;
  }

  async #fallback(attempt, kind, firstError) {
    try {
      return await attempt(kind, undefined);
    } catch (error) {
      if (kind === 'http' && [400, 404, 405].includes(httpStatus(error)))
        return attempt('sse', undefined);
      throw error ?? firstError;
    }
  }

  #createClient() {
    const manager = this.manager;
    const capabilities = {
      roots: { listChanged: true },
      elicitation: { form: {}, url: {} },
    };
    if (manager.env.MCPC_SAMPLING !== '0') capabilities.sampling = {};

    const onChanged = (list) => () => {
      this.refresh(list).catch((error) =>
        this.log.write(`[mcpc] ${list} refresh failed: ${this.#redact(error.message)}`),
      );
    };
    const client = new Client(
      { name: 'mcpc', version: manager.version },
      {
        capabilities,
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: true },
        listChanged: {
          tools: { autoRefresh: false, debounceMs: 100, onChanged: onChanged('tools') },
          prompts: { autoRefresh: false, debounceMs: 100, onChanged: onChanged('prompts') },
          resources: { autoRefresh: false, debounceMs: 100, onChanged: onChanged('resources') },
        },
      },
    );

    client.setRequestHandler('roots/list', async () => ({
      roots: manager
        .roots()
        .map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })),
    }));
    client.setRequestHandler('elicitation/create', async (request, ctx) =>
      manager.requests.ask({
        kind: 'elicitation',
        server: this.name,
        params: request.params,
        signal: ctx?.mcpReq?.signal,
      }),
    );
    if (capabilities.sampling) {
      client.setRequestHandler('sampling/createMessage', async (request, ctx) =>
        manager.requests.ask({
          kind: 'sampling',
          server: this.name,
          params: request.params,
          signal: ctx?.mcpReq?.signal,
        }),
      );
    }
    client.setNotificationHandler('notifications/message', async (notification) => {
      const { level, logger, data } = notification.params ?? {};
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      this.log.write(`[${level ?? 'info'}${logger ? ` ${logger}` : ''}] ${this.#redact(text)}`);
    });
    client.setNotificationHandler('notifications/elicitation/complete', async (notification) => {
      manager.requests.complete(this.name, notification.params?.elicitationId);
    });
    return client;
  }

  #onClose(generation) {
    if (generation !== this.generation) return;
    this.generation = null;
    if (generation.closing || this.disposed) return;
    const uptime = Date.now() - generation.connectedAt;
    this.log.write(`[mcpc] connection closed unexpectedly after ${Math.round(uptime / 1000)} s`);
    if (uptime >= RECONNECT.maxMs) this.failures = 0;
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    this.failures++;
    if (this.failures > RECONNECT.maxFailures) {
      this.state = 'failed';
      this.error = `gave up after ${RECONNECT.maxFailures} reconnect attempts`;
      this.log.write(`[mcpc] ${this.error}`);
      return;
    }
    const wait = Math.min(RECONNECT.maxMs, RECONNECT.initialMs * 2 ** (this.failures - 1));
    this.state = 'reconnecting';
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        if (!this.disposed && this.state !== 'needs-auth') this.#scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  /** A use initiated by the agent resets the reconnect budget. */
  #touch() {
    if (this.state === 'failed' && !this.generation) {
      this.failures = 0;
      this.state = 'idle';
    }
  }

  async #request(method, params, options = {}) {
    const generation = await this.connect();
    return generation.client.request({ method, params }, ANY_RESULT, {
      timeout: CATALOG_TIMEOUT_MS,
      signal: generation.abort.signal,
      ...options,
    });
  }

  async #paginate(method, key) {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.#request(method, cursor ? { cursor } : {});
      if (Array.isArray(result?.[key])) items.push(...result[key]);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  #capable(capability) {
    const capabilities =
      this.generation?.client.getServerCapabilities?.() ?? this.cache?.capabilities;
    return Boolean(capabilities?.[capability]);
  }

  /**
   * Re-fetch one list from the server and update the cache (all-or-nothing).
   *
   * @param {'tools'|'prompts'|'resources'} list
   */
  async refresh(list) {
    if (list === 'tools') {
      if (!this.#capable('tools')) {
        this.#saveCache({ tools: [], skipped: [], fetchedAt: Date.now() });
        return;
      }
      const raw = await this.#paginate('tools/list', 'tools');
      const { tools, skipped } = sanitizeTools(raw);
      const filtered = filterTools(tools, this.resolved.config.tools ?? {});
      for (const item of skipped)
        this.log.write(`[mcpc] skipped tool ${item.name ?? '?'}: ${item.reason}`);
      this.#saveCache({ tools: filtered, skipped, fetchedAt: Date.now() });
      this.manager.emit('tools_changed', { server: this.name });
    } else if (list === 'prompts') {
      const prompts = this.#capable('prompts')
        ? await this.#paginate('prompts/list', 'prompts')
        : [];
      this.#saveCache({ prompts });
    } else if (list === 'resources') {
      const capable = this.#capable('resources');
      const resources = capable ? await this.#paginate('resources/list', 'resources') : [];
      const resourceTemplates = capable
        ? await this.#paginate('resources/templates/list', 'resourceTemplates')
        : [];
      this.#saveCache({ resources, resourceTemplates });
    }
  }

  /**
   * Tools of this server: from a fresh cache, or by connecting.
   *
   * @param {{refresh?: boolean, connect?: boolean}} [options]
   */
  async tools({ refresh = false, connect = true } = {}) {
    this.#touch();
    if (!refresh && Array.isArray(this.cache?.tools)) return this.cache.tools;
    if (!connect) return undefined;
    if (refresh && this.generation) await this.refresh('tools');
    else await this.connect();
    if (!Array.isArray(this.cache?.tools)) await this.refresh('tools');
    return this.cache.tools;
  }

  /** Find one tool definition by its raw name (connecting when the cache lacks it). */
  async findTool(name) {
    let tools = await this.tools();
    let tool = tools?.find((item) => item.name === name);
    if (!tool && this.generation) {
      tools = await this.tools({ refresh: true });
      tool = tools?.find((item) => item.name === name);
    }
    return tool ?? null;
  }

  /**
   * Call a tool.
   *
   * @param {any} tool sanitized tool definition
   * @param {object} args
   * @param {{signal?: AbortSignal, timeout?: number, onprogress?: Function}} options
   */
  async callTool(tool, args, { signal, timeout, onprogress } = {}) {
    this.#touch();
    const run = async () => {
      const generation = await this.connect();
      const signals = [generation.abort.signal, signal].filter(Boolean);
      return generation.client.callTool(
        { name: tool.name, arguments: args },
        {
          toolDefinition: { ...tool, outputSchema: undefined },
          timeout: timeout ?? this.resolved.config.timeout ?? this.manager.toolTimeoutMs,
          signal: AbortSignal.any(signals),
          ...(onprogress ? { onprogress } : {}),
        },
      );
    };
    try {
      return await run();
    } catch (error) {
      // Streamable HTTP sessions can expire silently: reconnect once and re-send.
      if (this.generation?.kind === 'http' && httpStatus(error) === 404 && !signal?.aborted) {
        await this.generation.close();
        this.generation = null;
        return run();
      }
      throw error;
    }
  }

  async prompts({ refresh = false } = {}) {
    this.#touch();
    if (refresh || !Array.isArray(this.cache?.prompts)) {
      await this.connect();
      await this.refresh('prompts');
    }
    return this.cache.prompts;
  }

  async getPrompt(name, args) {
    if (!this.#capable('prompts') && this.generation) return null;
    return this.#request(
      'prompts/get',
      { name, arguments: args },
      { timeout: this.manager.toolTimeoutMs },
    );
  }

  async resources({ refresh = false } = {}) {
    this.#touch();
    if (refresh || !Array.isArray(this.cache?.resources)) {
      await this.connect();
      await this.refresh('resources');
    }
    return {
      resources: this.cache.resources,
      resourceTemplates: this.cache.resourceTemplates ?? [],
    };
  }

  async readResource(uri) {
    return this.#request('resources/read', { uri }, { timeout: this.manager.toolTimeoutMs });
  }

  async sendRootsChanged() {
    await this.generation?.client.sendRootsListChanged?.().catch(() => {});
  }

  /** Close the current connection (the supervisor stays usable). */
  async disconnect() {
    clearTimeout(this.reconnectTimer);
    const generation = this.generation;
    this.generation = null;
    this.state = 'idle';
    await generation?.close();
  }

  async dispose() {
    this.disposed = true;
    await this.disconnect();
  }
}

/** All supervisors of one workspace daemon. */
export class ServerManager {
  /**
   * @param {{root: string, home: string, projectDir: string, env?: NodeJS.ProcessEnv, version: string,
   *   requests: any, emit?: (event: string, data: any) => void, authProviderFor?: Function,
   *   hasAuth?: Function}} options
   */
  constructor({
    root,
    home,
    projectDir,
    env = process.env,
    version,
    requests,
    emit,
    authProviderFor,
    hasAuth,
  }) {
    this.root = root;
    this.home = home;
    this.env = env;
    this.version = version;
    this.requests = requests;
    this.cacheDir = path.join(projectDir, 'cache');
    this.logsDir = path.join(projectDir, 'logs');
    this.emit = emit ?? (() => {});
    this.authProviderFor = authProviderFor ?? (() => undefined);
    this.hasAuth = hasAuth ?? (() => false);
    this.startupTimeoutMs = Number(env.MCPC_STARTUP_TIMEOUT) || DEFAULT_STARTUP_TIMEOUT_MS;
    this.toolTimeoutMs = Number(env.MCPC_TOOL_TIMEOUT) || DEFAULT_TOOL_TIMEOUT_MS;
    this.approvals = { servers: {} };
    /** @type {Map<string, Supervisor>} */
    this.supervisors = new Map();
    this.loaded = null;
  }

  /** Workspace root plus MCPC_ROOTS entries. */
  roots() {
    const extra = (this.env.MCPC_ROOTS ?? '').split(path.delimiter).filter(Boolean);
    return [this.root, ...extra.map((dir) => path.resolve(this.root, dir))];
  }

  /**
   * Apply a freshly loaded configuration: new servers are added, changed ones
   * are closed and rebuilt, removed ones are disposed.
   *
   * @param {{servers: Map<string, any>}} loaded result of config.loadConfig
   * @param {any} approvals approvals file content
   */
  async apply(loaded, approvals) {
    this.loaded = loaded;
    this.approvals = approvals ?? { servers: {} };
    const tasks = [];
    for (const [name, supervisor] of this.supervisors) {
      const next = loaded.servers.get(name);
      if (!next || next.fingerprint !== supervisor.resolved.fingerprint) {
        this.supervisors.delete(name);
        tasks.push(supervisor.dispose());
      }
    }
    for (const [name, resolved] of loaded.servers) {
      if (!this.supervisors.has(name)) this.supervisors.set(name, new Supervisor(this, resolved));
    }
    await Promise.allSettled(tasks);
  }

  names() {
    return [...this.supervisors.keys()].sort();
  }

  get(name) {
    return this.supervisors.get(name) ?? null;
  }

  async closeAll() {
    await Promise.allSettled(
      [...this.supervisors.values()].map((supervisor) => supervisor.dispose()),
    );
  }
}

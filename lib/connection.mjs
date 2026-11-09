// One connection to one MCP server, opened for the duration of a command (or of
// a `mcpc session`), plus the on-disk catalog cache that lets discovery commands
// answer without starting servers.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';

import { filterTools, sanitizeTools } from './catalog.mjs';
import { approvalState, redact } from './config.mjs';
import { closeClient, createTransport, openServerLog } from './transports.mjs';

export const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
export const LIST_TIMEOUT_MS = 30000;
export const DEFAULT_TOOL_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Lists are validated by catalog.sanitizeTools instead of the SDK, so one
// malformed tool does not make a whole server unusable.
const ANY_RESULT = {
  '~standard': { version: 1, vendor: 'mcpc', validate: (value) => ({ value }) },
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Repair `tools/list` responses before the SDK sees them. On the 2026-07-28
 * protocol the SDK validates every listed tool strictly (whatever result schema
 * the caller passes), so one malformed tool would make the whole list fail.
 * Patching the instance keeps the transport's class, which the SDK relies on
 * for its stdio protocol probe.
 *
 * @param {any} transport
 * @param {(skipped: {name?: string, reason: string}[]) => void} onSkipped
 */
export function guardToolLists(transport, onSkipped) {
  const listRequests = new Set();
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (message?.method === 'tools/list' && message.id !== undefined) listRequests.add(message.id);
    return send(message, options);
  };

  let handler;
  const repaired = (message, extra) => {
    if (message && listRequests.has(message.id)) {
      listRequests.delete(message.id);
      if (Array.isArray(message.result?.tools)) {
        const { tools, skipped } = sanitizeTools(message.result.tools);
        for (const tool of tools) {
          if (tool.outputSchema && tool.outputSchema.type !== 'object') delete tool.outputSchema;
        }
        if (skipped.length) onSkipped(skipped);
        message = { ...message, result: { ...message.result, tools } };
      }
    }
    handler?.(message, extra);
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => (handler ? repaired : undefined),
    set: (fn) => {
      handler = fn;
    },
  });
  return transport;
}

/** HTTP status carried by an SDK or fetch error, when there is one. */
export function httpStatus(error) {
  for (const value of [error?.status, error?.data?.status, error?.code, error?.cause?.status]) {
    if (Number.isInteger(value) && value >= 100 && value < 600) return value;
  }
  const match = /\b(?:HTTP|status(?: code)?)[ :]*([1-5]\d\d)\b/i.exec(String(error?.message ?? ''));
  return match ? Number(match[1]) : null;
}

const isNetworkError = (error) =>
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up/i.test(
    `${error?.code ?? ''} ${error?.message ?? ''} ${error?.cause?.code ?? ''}`,
  );

/** Error for a server that cannot be used; the message says what to do. */
export class ServerError extends Error {
  /**
   * @param {string} server
   * @param {string} state
   * @param {string} message
   */
  constructor(server, state, message) {
    super(message);
    this.name = 'ServerError';
    this.code = 'server_unavailable';
    this.server = server;
    this.state = state;
  }
}

/**
 * Why a configured server cannot be used, or null.
 *
 * @param {any} resolved ResolvedServer from config.mjs
 * @param {any} approvals approvals file content
 * @returns {{state: string, message: string}|null}
 */
export function blockedReason(resolved, approvals) {
  if (resolved.errors?.length)
    return { state: 'invalid', message: `invalid configuration: ${resolved.errors.join('; ')}` };
  if (resolved.config?.disabled) return { state: 'disabled', message: 'disabled in configuration' };
  if (resolved.scope === 'project') {
    const decision = approvalState(approvals, resolved);
    if (decision !== 'approved')
      return {
        state: 'pending-approval',
        message: `project server from .mcp.json; ask the user, then run: mcpc approve ${resolved.name}`,
      };
  }
  return null;
}

const cachePath = (projectDir, name) => path.join(projectDir, 'cache', `${name}.json`);

/**
 * Cached catalog of a server, or null when missing or written for another config.
 *
 * @param {string} projectDir
 * @param {any} resolved
 */
export function readCache(projectDir, resolved) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(projectDir, resolved.name), 'utf8'));
    return cache?.fingerprint === resolved.fingerprint ? cache : null;
  } catch {
    return null;
  }
}

/** Whether a cache entry holds a tool list young enough to use without connecting. */
export function cacheFresh(cache, env = process.env, now = Date.now()) {
  const ttl = Number(env.MCPC_CACHE_TTL) || DEFAULT_CACHE_TTL_MS;
  return Array.isArray(cache?.tools) && now - (cache.fetchedAt ?? 0) < ttl;
}

function writeCache(projectDir, resolved, cache) {
  const file = cachePath(projectDir, resolved.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify({ ...cache, fingerprint: resolved.fingerprint }, null, 2) + '\n',
  );
  fs.renameSync(temp, file);
}

/** An open connection to one server. */
export class Connection {
  /**
   * @param {any} resolved
   * @param {{root: string, projectDir: string, env: NodeJS.ProcessEnv, version: string}} ctx
   */
  constructor(resolved, ctx) {
    this.resolved = resolved;
    this.name = resolved.name;
    this.ctx = ctx;
    this.client = null;
    this.transport = null;
    this.kind = null;
    this.closed = false;
    this.listSkipped = [];
    this.onclose = null;
    this.cache = readCache(ctx.projectDir, resolved) ?? {};
    this.log = openServerLog(path.join(ctx.projectDir, 'logs', `${resolved.name}.log`));
  }

  #redact(text) {
    return redact(String(text), this.resolved.secrets ?? []);
  }

  /**
   * Open a connection: cached protocol verdict first, HTTP → SSE fallback, and a
   * few retries on network errors for remote servers.
   *
   * @param {any} resolved
   * @param {{root: string, projectDir: string, env: NodeJS.ProcessEnv, version: string}} ctx
   */
  static async open(resolved, ctx) {
    const connection = new Connection(resolved, ctx);
    const remote = resolved.type !== 'stdio';
    let lastError;
    for (let attempt = 0; attempt < (remote ? 3 : 1); attempt++) {
      try {
        await connection.#connect();
        return connection;
      } catch (error) {
        lastError = error;
        if (!(remote && isNetworkError(error))) break;
        await delay(500 * 2 ** attempt);
      }
    }
    const status = httpStatus(lastError);
    if (status === 401 || status === 403 || lastError?.name === 'UnauthorizedError')
      throw new ServerError(
        resolved.name,
        'needs-auth',
        `${resolved.name} requires authentication (HTTP ${status ?? 401})`,
      );
    throw new ServerError(
      resolved.name,
      'failed',
      `${resolved.name}: ${connection.#redact(lastError?.message ?? lastError)}`,
    );
  }

  #prior() {
    const era = this.cache.era;
    if (era?.kind === 'modern' && era.discover) return { kind: 'modern', discover: era.discover };
    if (era?.kind === 'legacy' && Date.now() - (era.at ?? 0) < LEGACY_VERDICT_MAX_AGE_MS)
      return { kind: 'legacy' };
    return undefined;
  }

  async #attempt(kind, prior) {
    const { config } = this.resolved;
    const transport = guardToolLists(
      createTransport(this.resolved, {
        kind,
        root: this.ctx.root,
        env: this.ctx.env,
        log: this.log,
      }),
      (skipped) => this.listSkipped.push(...skipped),
    );
    const client = new Client(
      { name: 'mcpc', version: this.ctx.version },
      {
        capabilities: { roots: { listChanged: false } },
        versionNegotiation: { mode: 'auto' },
      },
    );
    client.setRequestHandler('roots/list', async () => ({
      roots: [{ uri: pathToFileURL(this.ctx.root).href, name: path.basename(this.ctx.root) }],
    }));
    client.setNotificationHandler('notifications/message', async (notification) => {
      const { level, logger, data } = notification.params ?? {};
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      this.log.write(`[${level ?? 'info'}${logger ? ` ${logger}` : ''}] ${this.#redact(text)}`);
    });
    client.onclose = () => {
      if (!this.closed) {
        this.log.write('[mcpc] connection closed by the server');
        this.onclose?.();
      }
    };
    const timeout =
      config.startupTimeout ??
      (Number(this.ctx.env.MCPC_STARTUP_TIMEOUT) || DEFAULT_STARTUP_TIMEOUT_MS);
    try {
      await client.connect(transport, { timeout, ...(prior ? { prior } : {}) });
    } catch (error) {
      await closeClient(client, transport).catch(() => {});
      throw error;
    }
    this.client = client;
    this.transport = transport;
    this.kind = kind;
  }

  async #connect() {
    let kind = this.resolved.type;
    if (kind === 'http' && this.cache.transport === 'sse') kind = 'sse';
    const prior = this.#prior();
    const fallbackToSse = (error) => kind === 'http' && [400, 404, 405].includes(httpStatus(error));

    try {
      await this.#attempt(kind, prior);
    } catch (error) {
      if (prior) {
        this.log.write(
          '[mcpc] connect with the cached protocol verdict failed; retrying without it',
        );
        try {
          await this.#attempt(kind, undefined);
        } catch (retryError) {
          if (!fallbackToSse(retryError)) throw retryError;
          await this.#attempt('sse', undefined);
        }
      } else if (fallbackToSse(error)) {
        this.log.write(`[mcpc] Streamable HTTP refused (${httpStatus(error)}); trying SSE`);
        await this.#attempt('sse', undefined);
      } else throw error;
    }

    const discover = this.client.getDiscoverResult?.();
    this.cache = {
      ...this.cache,
      transport: this.kind,
      era: discover
        ? { kind: 'modern', discover, at: Date.now() }
        : { kind: 'legacy', at: Date.now() },
      serverInfo: this.client.getServerVersion?.() ?? null,
      capabilities: this.client.getServerCapabilities?.() ?? {},
      instructions: this.client.getInstructions?.() ?? null,
    };
    this.#save();
    this.log.write(`[mcpc] connected (${this.kind}, ${discover ? 'modern' : 'legacy'} protocol)`);
  }

  #save() {
    try {
      writeCache(this.ctx.projectDir, this.resolved, this.cache);
    } catch (error) {
      this.log.write(`[mcpc] cache write failed: ${error.message}`);
    }
  }

  #capable(name) {
    return Boolean(this.client?.getServerCapabilities?.()?.[name]);
  }

  async #paginate(method, key) {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.client.request(
        { method, params: cursor ? { cursor } : {} },
        ANY_RESULT,
        {
          timeout: LIST_TIMEOUT_MS,
        },
      );
      if (Array.isArray(result?.[key])) items.push(...result[key]);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  /** Fetch, sanitize and filter the tool list, and store it in the cache. */
  async listTools() {
    this.listSkipped = [];
    const raw = this.#capable('tools') ? await this.#paginate('tools/list', 'tools') : [];
    const sanitized = sanitizeTools(raw);
    const tools = sanitized.tools;
    // Tools dropped by guardToolLists never reach `raw`; report them as well.
    const skipped = [...this.listSkipped, ...sanitized.skipped];
    for (const item of skipped)
      this.log.write(`[mcpc] skipped tool ${item.name ?? '?'}: ${item.reason}`);
    this.cache = {
      ...this.cache,
      tools: filterTools(tools, this.resolved.config.tools ?? {}),
      skipped,
      fetchedAt: Date.now(),
    };
    this.#save();
    return this.cache.tools;
  }

  /**
   * Call a tool by its sanitized definition.
   *
   * @param {any} tool
   * @param {object} args
   * @param {{timeout?: number, signal?: AbortSignal, onprogress?: Function}} [options]
   */
  async callTool(tool, args, { timeout, signal, onprogress } = {}) {
    const limit =
      timeout ??
      this.resolved.config.timeout ??
      (Number(this.ctx.env.MCPC_TOOL_TIMEOUT) || DEFAULT_TOOL_TIMEOUT_MS);
    return this.client.callTool(
      { name: tool.name, arguments: args },
      {
        // The definition lets the SDK mirror parameters on modern servers; output
        // schemas are not enforced because real servers often break them.
        toolDefinition: { ...tool, outputSchema: undefined },
        timeout: limit,
        ...(signal ? { signal } : {}),
        ...(onprogress ? { onprogress } : {}),
      },
    );
  }

  async listResources() {
    if (!this.#capable('resources')) return { resources: [], resourceTemplates: [] };
    return {
      resources: await this.#paginate('resources/list', 'resources'),
      resourceTemplates: await this.#paginate('resources/templates/list', 'resourceTemplates'),
    };
  }

  async readResource(uri) {
    return this.client.request({ method: 'resources/read', params: { uri } }, ANY_RESULT, {
      timeout: LIST_TIMEOUT_MS,
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.client) await closeClient(this.client, this.transport);
  }
}

/**
 * Tool list of a server: from a fresh cache, otherwise by connecting briefly.
 *
 * @param {any} resolved
 * @param {{root: string, projectDir: string, env: NodeJS.ProcessEnv, version: string}} ctx
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{tools: any[], cache: any}>}
 */
export async function loadTools(resolved, ctx, { refresh = false } = {}) {
  const cache = readCache(ctx.projectDir, resolved);
  if (!refresh && cacheFresh(cache, ctx.env)) return { tools: cache.tools, cache };
  const connection = await Connection.open(resolved, ctx);
  try {
    const tools = await connection.listTools();
    return { tools, cache: connection.cache };
  } finally {
    await connection.close();
  }
}

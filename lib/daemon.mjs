// The per-workspace daemon: owns every MCP connection, answers CLI requests over
// the local socket, and exits after a period without work.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CallRegistry } from './calls.mjs';
import { parseToolRef, renderCatalog, renderDefinitions, searchTools, toolId } from './catalog.mjs';
import { evaluatePermission, loadConfig, readApprovals, redact } from './config.mjs';
import { IpcError, lineReader, listen, writeMessage } from './ipc.mjs';
import {
  approvalsFile,
  configFiles,
  endpointFor,
  mcpcHome,
  projectDir,
  resultsDir,
  workspaceId,
} from './paths.mjs';
import { renderPromptResult, renderResourceContents } from './render.mjs';
import { RequestBroker } from './requests.mjs';
import { ServerManager, ServerUnavailableError } from './servers.mjs';
import { VERSION } from './version.mjs';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_FOREGROUND_MS = 120000;
const HOUR = 60 * 60 * 1000;

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Daemon state and request handlers; exported for tests. */
export class Daemon {
  /**
   * @param {{key: string, root: string, env?: NodeJS.ProcessEnv}} options
   */
  constructor({ key, root, env = process.env }) {
    this.key = key;
    this.root = path.resolve(root);
    this.env = env;
    this.home = mcpcHome(env);
    this.wsid = workspaceId(this.root);
    this.projectDir = projectDir(this.home, this.wsid);
    this.endpoint = endpointFor(this.home, key);
    this.files = configFiles({ home: this.home, root: this.root, wsid: this.wsid });
    this.approvalsPath = approvalsFile(this.home, this.wsid);
    this.resultsDir = resultsDir(this.home, this.wsid);
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.idleMs = Number(env.MCPC_IDLE_TIMEOUT) || DEFAULT_IDLE_MS;
    this.foregroundMs = Number(env.MCPC_FOREGROUND_MS) || DEFAULT_FOREGROUND_MS;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
    this.stamps = null;
    this.loaded = null;
    this.server = null;
    this.stopping = null;
    this.activeRequests = 0;

    this.requests = new RequestBroker({
      timeoutMs: Number(env.MCPC_REQUEST_TIMEOUT) || undefined,
      callFor: (server) => this.calls.runningCallFor(server),
      onChange: (event, request) => this.bus.emit(event, request),
    });
    this.manager = new ServerManager({
      root: this.root,
      home: this.home,
      projectDir: this.projectDir,
      env,
      version: VERSION,
      requests: this.requests,
      emit: (event, data) => this.bus.emit(event, data),
    });
    this.calls = new CallRegistry({
      manager: this.manager,
      requests: this.requests,
      resultsDir: this.resultsDir,
      permissions: () => this.loaded?.permissions ?? { allow: [], ask: [], deny: [] },
      env,
      onChange: (event, call) => this.bus.emit(event, call),
    });
  }

  /** Re-read configuration and approvals when any of their files changed. */
  async reload(force = false) {
    const stamps = [this.files.local, this.files.project, this.files.user, this.approvalsPath]
      .map(mtime)
      .join(':');
    if (!force && stamps === this.stamps) return;
    this.stamps = stamps;
    const loaded = loadConfig(this.files, { env: this.env, root: this.root });
    let approvals = { servers: {} };
    try {
      approvals = readApprovals(this.approvalsPath);
    } catch (error) {
      loaded.errors.push(`approvals: ${error.message}`);
    }
    this.loaded = loaded;
    await this.manager.apply(loaded, approvals);
  }

  #supervisor(name) {
    const supervisor = this.manager.get(name);
    if (!supervisor) {
      const known = this.manager.names();
      throw new IpcError(
        'unknown_server',
        `no server named "${name}"${known.length ? ` (configured: ${known.join(', ')})` : ''}`,
      );
    }
    return supervisor;
  }

  #targets(names) {
    return names?.length
      ? names.map((name) => this.#supervisor(name))
      : [...this.manager.supervisors.values()];
  }

  #permission = (id, tool) => {
    const meta = tool?._meta;
    const base = evaluatePermission(this.loaded?.permissions ?? {}, id, meta);
    if (base === 'deny') return 'deny';
    if (
      meta?.['anthropic/requiresUserInteraction'] === true ||
      meta?.requiresUserInteraction === true
    )
      return 'ask';
    return base;
  };

  #ref(ref) {
    const parsed = parseToolRef(ref, this.manager.names());
    if (!parsed) {
      throw new IpcError(
        'unknown_tool',
        `cannot resolve "${ref}"; use server/tool with one of: ${this.manager.names().join(', ') || '(no servers)'}`,
      );
    }
    return parsed;
  }

  /** Tool lists of the given supervisors, connecting those without a cache in parallel. */
  async #catalogInput(supervisors, { cached = false, refresh = false } = {}) {
    return Promise.all(
      supervisors.map(async (supervisor) => {
        let tools;
        let error = null;
        try {
          tools = await supervisor.tools({ refresh, connect: !cached });
        } catch (failure) {
          error = failure.message;
          tools = supervisor.cachedTools();
        }
        const status = supervisor.status();
        return {
          name: supervisor.name,
          status: status.state,
          transport: status.transport,
          error: error ?? status.error,
          instructions: supervisor.instructions,
          alwaysLoad: status.alwaysLoad,
          tools,
        };
      }),
    );
  }

  /**
   * Wait until a call finishes, a request appears, or the timeout passes.
   *
   * @param {{callIds?: string[], timeoutMs: number}} options
   */
  waitFor({ callIds = [], timeoutMs }) {
    const ids = new Set(callIds);
    const servers = new Set(callIds.map((id) => this.calls.get(id)?.server).filter(Boolean));
    const relevant = (request) =>
      ids.size === 0 || ids.has(request.callId) || (!request.callId && servers.has(request.server));

    const finished = callIds
      .map((id) => this.calls.get(id))
      .filter((call) => call && call.state !== 'running');
    if (finished.length) return Promise.resolve({ reason: 'finished', calls: finished });
    const pending = this.requests.list().filter(relevant);
    if (pending.length) return Promise.resolve({ reason: 'request', requests: pending });
    for (const id of callIds) {
      if (!this.calls.get(id)) return Promise.reject(new IpcError('unknown_call', `no call ${id}`));
    }

    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.bus.off('call_finished', onFinished);
        this.bus.off('request_created', onRequest);
        resolve(value);
      };
      const onFinished = (call) => {
        if (ids.size === 0 || ids.has(call.id))
          done({ reason: 'finished', calls: [this.calls.get(call.id) ?? call] });
      };
      const onRequest = (request) => {
        if (relevant(request)) done({ reason: 'request', requests: [request] });
      };
      const timer = setTimeout(() => done({ reason: 'timeout' }), timeoutMs);
      this.bus.on('call_finished', onFinished);
      this.bus.on('request_created', onRequest);
    });
  }

  /** Request handlers, keyed by method. */
  handlers = {
    hello: async () => ({
      version: VERSION,
      pid: process.pid,
      root: this.root,
      key: this.key,
      startedAt: this.startedAt,
    }),

    shutdown: async () => {
      setImmediate(() => this.stop('shutdown requested'));
      return { stopping: true };
    },

    status: async () => ({
      daemon: {
        pid: process.pid,
        version: VERSION,
        root: this.root,
        key: this.key,
        startedAt: this.startedAt,
        runningCalls: this.calls.running(),
        pendingRequests: this.requests.list().length,
        endpoint: this.endpoint,
      },
      servers: this.manager.names().map((name) => this.manager.get(name).status()),
      warnings: this.loaded?.warnings ?? [],
      errors: this.loaded?.errors ?? [],
    }),

    get: async ({ server, probe = false }) => {
      const supervisor = this.#supervisor(server);
      let probeResult = null;
      if (probe) {
        try {
          const tools = await supervisor.tools({ refresh: true });
          probeResult = { ok: true, tools: tools.length };
        } catch (error) {
          probeResult = { ok: false, error: error.message };
        }
      }
      const resolved = supervisor.resolved;
      const secrets = resolved.secrets ?? [];
      return {
        status: supervisor.status(),
        config: JSON.parse(redact(JSON.stringify(resolved.config), secrets)),
        warnings: resolved.warnings,
        errors: resolved.errors,
        probe: probeResult,
      };
    },

    tools: async ({ servers = [], cached = false, refresh = false, budget }) => {
      const input = await this.#catalogInput(this.#targets(servers), { cached, refresh });
      const budgetTokens = budget ?? (Number(this.env.MCPC_CATALOG_BUDGET) || 2000);
      return {
        text: renderCatalog(input, { budgetTokens, permission: this.#permission }),
        servers: input.map(({ tools, ...rest }) => ({
          ...rest,
          tools: tools?.filter(
            (tool) => this.#permission(toolId(rest.name, tool.name), tool) !== 'deny',
          ),
        })),
      };
    },

    search: async ({ query = '', limit = 5, offset = 0, full = false }) => {
      const input = await this.#catalogInput([...this.manager.supervisors.values()]);
      const entries = input.flatMap((server) =>
        (server.tools ?? [])
          .filter((tool) => this.#permission(toolId(server.name, tool.name), tool) !== 'deny')
          .map((tool) => ({ server: server.name, tool })),
      );
      const found = searchTools(entries, query, { limit, offset });
      let text = renderDefinitions(found.items, { full });
      if (!found.items.length) text = `No tools match "${query}".\n`;
      if (found.missing?.length) text += `Not found: ${found.missing.join(', ')}\n`;
      if (found.remaining > 0)
        text += `${found.remaining} more match${found.remaining === 1 ? 'es' : ''}; next page: --offset ${found.nextOffset}\n`;
      const unavailable = input.filter((server) => !server.tools && server.error);
      for (const server of unavailable) text += `(${server.name} unavailable: ${server.error})\n`;
      return {
        text,
        items: found.items.map(({ server, tool, score }) => ({ server, tool, score })),
        total: found.total,
        remaining: found.remaining,
        nextOffset: found.nextOffset,
        missing: found.missing,
      };
    },

    call: async ({ ref, args = {}, timeout, waitMs, background = false }) => {
      const { server, tool } = this.#ref(ref);
      const call = await this.calls.start({ server, tool, args, timeout });
      if (background) return { reason: 'running', call };
      const outcome = await this.waitFor({
        callIds: [call.id],
        timeoutMs: waitMs ?? this.foregroundMs,
      });
      return { ...outcome, call: this.calls.get(call.id) };
    },

    wait: async ({ calls = [], timeoutMs = 600000 }) => this.waitFor({ callIds: calls, timeoutMs }),

    cancel: async ({ id }) => ({ call: this.calls.cancel(id) }),

    result: async ({ id }) => {
      const call = this.calls.get(id);
      if (!call) throw new IpcError('unknown_call', `no call ${id}`);
      return { call };
    },

    requests: async () => ({ requests: this.requests.list() }),

    answer: async ({ id, answer }) => {
      const request = this.requests.get(id);
      this.requests.answer(id, answer);
      return { answered: id, request };
    },

    resources: async ({ servers = [] }) => {
      const results = await Promise.all(
        this.#targets(servers).map(async (supervisor) => {
          try {
            return { server: supervisor.name, ...(await supervisor.resources({ refresh: true })) };
          } catch (error) {
            return {
              server: supervisor.name,
              error: error.message,
              resources: [],
              resourceTemplates: [],
            };
          }
        }),
      );
      return { servers: results };
    },

    read: async ({ server, uri }) => {
      const result = await this.#supervisor(server).readResource(uri);
      const id = `res-${Date.now().toString(36)}`;
      return renderResourceContents(result?.contents, { id, resultsDir: this.resultsDir });
    },

    prompts: async ({ servers = [] }) => {
      const results = await Promise.all(
        this.#targets(servers).map(async (supervisor) => {
          try {
            return {
              server: supervisor.name,
              prompts: await supervisor.prompts({ refresh: true }),
            };
          } catch (error) {
            return { server: supervisor.name, error: error.message, prompts: [] };
          }
        }),
      );
      return { servers: results };
    },

    prompt: async ({ ref, args = {} }) => {
      const { server, tool: name } = this.#ref(ref);
      const result = await this.#supervisor(server).getPrompt(name, args);
      if (!result) throw new IpcError('unsupported', `${server} does not offer prompts`);
      return { text: renderPromptResult(result), result };
    },

    restart: async ({ servers = [] }) => {
      if (!servers.length) {
        setImmediate(() => this.stop('restart requested'));
        return { restarting: 'daemon' };
      }
      await Promise.all(servers.map((name) => this.#supervisor(name).disconnect()));
      return { restarted: servers };
    },
  };

  /**
   * Handle one request message.
   *
   * @param {{id: number, method: string, params?: object}} message
   */
  async handle(message) {
    const handler = Object.hasOwn(this.handlers, message?.method)
      ? this.handlers[message.method]
      : null;
    if (!handler) throw new IpcError('unknown_method', `unknown method ${message?.method}`);
    this.lastActivity = Date.now();
    this.activeRequests++;
    try {
      if (message.method !== 'hello' && message.method !== 'shutdown') await this.reload();
      return await handler(message.params ?? {});
    } finally {
      this.activeRequests--;
      this.lastActivity = Date.now();
    }
  }

  #onConnection = (socket) => {
    socket.on(
      'data',
      lineReader(
        (message) => {
          this.handle(message).then(
            (result) => writeMessage(socket, { id: message.id, result }),
            (error) =>
              writeMessage(socket, {
                id: message.id,
                error: {
                  code:
                    error instanceof ServerUnavailableError
                      ? 'server_unavailable'
                      : (error.code ?? 'error'),
                  message: String(error?.message ?? error),
                  data:
                    error.data ??
                    (error instanceof ServerUnavailableError ? { state: error.state } : undefined),
                },
              }),
          );
        },
        () => socket.destroy(),
      ),
    );
    socket.on('error', () => {});
  };

  #idle() {
    return (
      Date.now() - this.lastActivity > this.idleMs &&
      this.activeRequests === 0 &&
      this.calls.running() === 0 &&
      this.requests.list().length === 0
    );
  }

  async start() {
    fs.mkdirSync(this.projectDir, { recursive: true });
    fs.writeFileSync(path.join(this.projectDir, 'workspace.txt'), this.root + '\n');
    await this.reload(true);
    this.server = await listen(this.endpoint, this.#onConnection);
    fs.writeFileSync(
      path.join(this.projectDir, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        key: this.key,
        endpoint: this.endpoint,
        version: VERSION,
        startedAt: this.startedAt,
      }) + '\n',
    );
    this.calls.cleanup();
    this.timers = [
      setInterval(
        () => {
          if (this.#idle()) this.stop('idle');
        },
        Math.min(30000, this.idleMs),
      ),
      setInterval(() => this.calls.cleanup(), HOUR),
    ];
    for (const timer of this.timers) timer.unref?.();
    this.log(`started (pid ${process.pid}, version ${VERSION}, root ${this.root})`);
  }

  log(message) {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  }

  /** Close everything and exit the process. */
  stop(reason) {
    this.stopping ??= (async () => {
      this.log(`stopping: ${reason}`);
      for (const timer of this.timers ?? []) clearInterval(timer);
      this.requests.cancelAll();
      this.calls.cancelAll();
      await new Promise((resolve) =>
        this.server ? this.server.close(() => resolve()) : resolve(),
      );
      await this.manager.closeAll();
      try {
        const info = JSON.parse(fs.readFileSync(path.join(this.projectDir, 'daemon.json'), 'utf8'));
        if (info.pid === process.pid)
          fs.rmSync(path.join(this.projectDir, 'daemon.json'), { force: true });
      } catch {
        // Already gone.
      }
      this.log('stopped');
    })().finally(() => process.exit(0));
    return this.stopping;
  }
}

/**
 * Entry point of `mcpc daemon`.
 *
 * @param {{key: string, root: string}} options
 */
export async function runDaemon({ key, root }) {
  const daemon = new Daemon({ key, root });
  process.on('SIGTERM', () => daemon.stop('SIGTERM'));
  process.on('SIGINT', () => daemon.stop('SIGINT'));
  process.on('unhandledRejection', (error) =>
    daemon.log(`unhandled rejection: ${error?.stack ?? error}`),
  );
  process.on('uncaughtException', (error) =>
    daemon.log(`uncaught exception: ${error?.stack ?? error}`),
  );
  try {
    await daemon.start();
  } catch (error) {
    daemon.log(`failed to start: ${error?.stack ?? error}`);
    process.exit(error?.code === 'already_running' ? 0 : 1);
  }
}

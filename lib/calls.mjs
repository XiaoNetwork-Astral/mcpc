// Tool calls run inside the daemon so they outlive the CLI command that started
// them: argument validation, permission checks, timeouts, progress, cancellation,
// rendering and persistence of finished results.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evaluatePermission } from './config.mjs';
import { toolId } from './catalog.mjs';
import { IpcError } from './ipc.mjs';
import { renderToolResult } from './render.mjs';
import { validate } from './schema.mjs';
import { ServerUnavailableError } from './servers.mjs';

/** Finished results are kept on disk this long. */
export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Finished calls stay in memory this long for `mcpc wait` / `mcpc result`. */
const MEMORY_RETENTION_MS = 60 * 60 * 1000;

const newId = () => `c-${crypto.randomBytes(4).toString('hex')}`;

const requiresInteraction = (meta) =>
  meta?.['anthropic/requiresUserInteraction'] === true || meta?.requiresUserInteraction === true;

/** Registry of running and recently finished calls. */
export class CallRegistry {
  /**
   * @param {{manager: import('./servers.mjs').ServerManager, requests: import('./requests.mjs').RequestBroker,
   *   resultsDir: string, permissions: () => any, env?: NodeJS.ProcessEnv,
   *   onChange?: (event: string, call: object) => void}} options
   */
  constructor({ manager, requests, resultsDir, permissions, env = process.env, onChange }) {
    this.manager = manager;
    this.requests = requests;
    this.resultsDir = resultsDir;
    this.permissions = permissions;
    this.onChange = onChange ?? (() => {});
    this.maxTokens = Number(env.MCPC_MAX_OUTPUT_TOKENS) || 25000;
    /** @type {Map<string, any>} */
    this.calls = new Map();
  }

  /** Number of calls still running. */
  running() {
    let count = 0;
    for (const call of this.calls.values()) if (call.state === 'running') count++;
    return count;
  }

  /** The single running call to `server`, used to attribute server requests. */
  runningCallFor(server) {
    const running = [...this.calls.values()].filter(
      (call) => call.state === 'running' && call.server === server,
    );
    return running.length === 1 ? running[0].id : null;
  }

  /**
   * Validate and start a call. Fails fast (before a call id exists) for an
   * unknown server or tool, invalid arguments, and denied tools.
   *
   * @param {{server: string, tool: string, args: any, timeout?: number}} request
   */
  async start({ server, tool: toolName, args = {}, timeout }) {
    const supervisor = this.manager.get(server);
    if (!supervisor) throw new IpcError('unknown_server', `no server named "${server}"`);
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new IpcError('invalid_arguments', 'tool arguments must be a JSON object');

    const tool = await supervisor.findTool(toolName);
    if (!tool) {
      const names = (supervisor.cachedTools() ?? []).map((item) => item.name);
      throw new IpcError('unknown_tool', `${server} has no tool "${toolName}"`, { tools: names });
    }
    const id = toolId(server, tool.name);

    const permission = requiresInteraction(tool._meta)
      ? evaluatePermission(this.permissions(), id, tool._meta) === 'deny'
        ? 'deny'
        : 'ask'
      : evaluatePermission(this.permissions(), id, tool._meta);
    if (permission === 'deny')
      throw new IpcError('denied', `${id} is denied by the permissions configuration`);

    const checked = validate(tool.inputSchema ?? { type: 'object' }, args);
    if (!checked.valid)
      throw new IpcError(
        'invalid_arguments',
        `arguments do not match ${id}:\n${checked.errors.join('\n')}`,
        {
          errors: checked.errors,
        },
      );

    const call = {
      id: newId(),
      server,
      tool: tool.name,
      toolId: id,
      args,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      progress: null,
      warning: checked.warning ?? null,
      output: null,
      error: null,
      controller: new AbortController(),
    };
    this.calls.set(call.id, call);
    this.onChange('call_started', this.summary(call));
    call.done = this.#run(call, tool, permission, timeout);
    return this.summary(call);
  }

  async #run(call, tool, permission, timeout) {
    try {
      if (permission === 'ask') {
        const allowed = await this.requests.ask({
          kind: 'approval',
          server: call.server,
          callId: call.id,
          params: {
            tool: call.toolId,
            arguments: call.args,
            reason: requiresInteraction(tool._meta)
              ? 'the tool asks for user confirmation on every call'
              : 'matched an "ask" permission rule',
          },
          signal: call.controller.signal,
        });
        if (!allowed) throw new IpcError('rejected', `the call to ${call.toolId} was rejected`);
      }

      const result = await this.manager.get(call.server).callTool(tool, call.args, {
        signal: call.controller.signal,
        timeout,
        onprogress: (progress) => {
          call.progress = {
            progress: progress.progress,
            total: progress.total,
            message: progress.message,
          };
          this.onChange('call_progress', this.summary(call));
        },
      });
      call.output = renderToolResult(result, {
        callId: call.id,
        tool: call.toolId,
        resultsDir: this.resultsDir,
        maxTokens: this.maxTokens,
        toolMeta: tool._meta,
      });
      call.state = 'finished';
    } catch (error) {
      if (call.controller.signal.aborted) {
        call.state = 'cancelled';
        call.error = { code: 'cancelled', message: 'the call was cancelled' };
      } else {
        call.state = 'failed';
        call.error = {
          code:
            error instanceof ServerUnavailableError
              ? 'server_unavailable'
              : (error.code ?? 'call_failed'),
          message: String(error?.message ?? error),
        };
      }
    } finally {
      call.finishedAt = Date.now();
      this.#persist(call);
      this.onChange('call_finished', this.summary(call));
      const timer = setTimeout(() => this.calls.delete(call.id), MEMORY_RETENTION_MS);
      timer.unref?.();
    }
  }

  #persist(call) {
    try {
      fs.mkdirSync(this.resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.resultsDir, `${call.id}.json`),
        JSON.stringify(this.summary(call, true)) + '\n',
      );
    } catch {
      // Persistence is a convenience for `mcpc result` after a restart.
    }
  }

  /**
   * Public view of a call.
   *
   * @param {any} call
   * @param {boolean} [withOutput]
   */
  summary(call, withOutput = call.state !== 'running') {
    const base = {
      id: call.id,
      server: call.server,
      tool: call.toolId,
      state: call.state,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      progress: call.progress,
      warning: call.warning,
      error: call.error,
    };
    if (withOutput && call.output)
      Object.assign(base, {
        isError: call.output.isError,
        text: call.output.text,
        json: call.output.json,
      });
    return base;
  }

  /** A call by id, from memory or from its persisted result. */
  get(id) {
    const call = this.calls.get(id);
    if (call) return this.summary(call);
    if (!/^c-[0-9a-f]{8}$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.resultsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  cancel(id) {
    const call = this.calls.get(id);
    if (!call) throw new IpcError('unknown_call', `no call ${id}`);
    if (call.state === 'running') call.controller.abort(new Error('cancelled by the user'));
    return this.summary(call);
  }

  cancelAll() {
    for (const call of this.calls.values()) if (call.state === 'running') call.controller.abort();
  }

  /** Delete persisted results older than the retention period. */
  cleanup(now = Date.now()) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.resultsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const file = path.join(this.resultsDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > RESULT_RETENTION_MS) fs.rmSync(file, { force: true });
      } catch {
        // Ignore files that vanish meanwhile.
      }
    }
  }
}

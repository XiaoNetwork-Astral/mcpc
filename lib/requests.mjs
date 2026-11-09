// Server-to-client requests waiting for the host agent: elicitation, sampling,
// and MCPC's own approval prompts. Each request is answered with `mcpc answer`.

import crypto from 'node:crypto';

import { IpcError } from './ipc.mjs';
import { validate } from './schema.mjs';

export const DEFAULT_REQUEST_TIMEOUT_MS = 600000;

const newId = () => `r-${crypto.randomBytes(4).toString('hex')}`;

/** Pending requests of one daemon. */
export class RequestBroker {
  /**
   * @param {{timeoutMs?: number, callFor?: (server: string) => string|null,
   *   onChange?: (event: string, request: object) => void}} [options]
   */
  constructor({ timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, callFor, onChange } = {}) {
    this.timeoutMs = timeoutMs;
    this.callFor = callFor ?? (() => null);
    this.onChange = onChange ?? (() => {});
    /** @type {Map<string, any>} */
    this.pending = new Map();
  }

  /**
   * Register a request and wait for its answer.
   *
   * @param {{kind: 'elicitation'|'sampling'|'approval', server: string, params: any,
   *   signal?: AbortSignal, callId?: string}} request
   * @returns {Promise<any>} the MCP result (elicitation, sampling) or a boolean (approval)
   */
  ask({ kind, server, params, signal, callId }) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request cancelled'));
    const id = newId();
    return new Promise((resolve, reject) => {
      const entry = {
        id,
        kind,
        server,
        callId: callId ?? this.callFor(server),
        params,
        createdAt: Date.now(),
        resolve,
        reject,
      };
      const finish = () => {
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        this.onChange('request_settled', this.summary(entry));
      };
      entry.settle = (fn, value) => {
        if (!this.pending.has(id)) return;
        finish();
        fn(value);
      };
      const onAbort = () =>
        entry.settle(reject, signal.reason ?? new Error('the server cancelled the request'));
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.timer = setTimeout(() => this.#expire(entry), this.timeoutMs);
      entry.timer.unref?.();
      this.pending.set(id, entry);
      this.onChange('request_created', this.summary(entry));
    });
  }

  #expire(entry) {
    if (entry.kind === 'elicitation') entry.settle(entry.resolve, { action: 'cancel' });
    else if (entry.kind === 'approval') entry.settle(entry.resolve, false);
    else entry.settle(entry.reject, new Error('the sampling request was not answered in time'));
  }

  /** Public view of one request (what `mcpc requests` prints). */
  summary(entry) {
    const base = {
      id: entry.id,
      kind: entry.kind,
      server: entry.server,
      callId: entry.callId,
      createdAt: entry.createdAt,
    };
    const params = entry.params ?? {};
    if (entry.kind === 'elicitation') {
      const mode = params.mode ?? (params.url ? 'url' : 'form');
      return mode === 'url'
        ? {
            ...base,
            mode,
            message: params.message,
            url: params.url,
            elicitationId: params.elicitationId,
          }
        : { ...base, mode, message: params.message, requestedSchema: params.requestedSchema };
    }
    if (entry.kind === 'sampling') {
      return {
        ...base,
        messages: params.messages,
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
        modelPreferences: params.modelPreferences,
        includeContext: params.includeContext,
      };
    }
    return { ...base, tool: params.tool, arguments: params.arguments, reason: params.reason };
  }

  list() {
    return [...this.pending.values()].map((entry) => this.summary(entry));
  }

  get(id) {
    const entry = this.pending.get(id);
    return entry ? this.summary(entry) : null;
  }

  /**
   * Answer a pending request.
   *
   * @param {string} id
   * @param {any} answer
   */
  answer(id, answer) {
    const entry = this.pending.get(id);
    if (!entry) throw new IpcError('unknown_request', `no pending request ${id}`);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer))
      throw new IpcError('invalid_answer', 'the answer must be a JSON object');

    if (entry.kind === 'elicitation') {
      const { action, content } = answer;
      if (!['accept', 'decline', 'cancel'].includes(action))
        throw new IpcError('invalid_answer', 'action must be "accept", "decline" or "cancel"');
      if (action !== 'accept') return entry.settle(entry.resolve, { action });
      const schema = entry.params?.requestedSchema;
      if (schema) {
        const result = validate(schema, content ?? {});
        if (!result.valid)
          throw new IpcError(
            'invalid_answer',
            `content does not match the requested schema:\n${result.errors.join('\n')}`,
          );
        return entry.settle(entry.resolve, { action, content: content ?? {} });
      }
      return entry.settle(entry.resolve, content === undefined ? { action } : { action, content });
    }

    if (entry.kind === 'sampling') {
      if (answer.decline === true)
        return entry.settle(entry.reject, new Error('the user declined the sampling request'));
      if (typeof answer.text !== 'string')
        throw new IpcError('invalid_answer', 'a sampling answer needs "text" (or "decline": true)');
      return entry.settle(entry.resolve, {
        role: 'assistant',
        content: { type: 'text', text: answer.text },
        model: typeof answer.model === 'string' ? answer.model : 'host-agent',
        stopReason: typeof answer.stopReason === 'string' ? answer.stopReason : 'endTurn',
      });
    }

    if (!['allowed-once', 'rejected'].includes(answer.outcome))
      throw new IpcError('invalid_answer', 'outcome must be "allowed-once" or "rejected"');
    return entry.settle(entry.resolve, answer.outcome === 'allowed-once');
  }

  /** A URL elicitation the server reports as complete counts as accepted. */
  complete(server, elicitationId) {
    for (const entry of this.pending.values()) {
      if (entry.server === server && entry.params?.elicitationId === elicitationId)
        entry.settle(entry.resolve, { action: 'accept' });
    }
  }

  /** Cancel every pending request (daemon shutdown). */
  cancelAll() {
    for (const entry of [...this.pending.values()]) this.#expire(entry);
  }
}

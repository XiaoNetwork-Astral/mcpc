// Transport construction for the four supported server types, an MCP WebSocket
// transport that can send headers, and stdio teardown that also ends the
// server's child processes.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** WebSocket messages above this size close the connection (16 MiB). */
export const WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Server log files rotate at this size; one previous file is kept. */
export const LOG_ROTATE_BYTES = 1024 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a promise at most `ms`, clearing the timer either way: a pending timer
// would keep a finished CLI process alive until it fires.
const within = (promise, ms) => {
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Append-only server log with simple size rotation.
 *
 * @param {string} file
 */
export function openServerLog(file) {
  const rotate = () => {
    try {
      if (fs.statSync(file).size >= LOG_ROTATE_BYTES) fs.renameSync(file, file + '.1');
    } catch {
      // Missing file: nothing to rotate.
    }
  };
  let ready = false;
  let written = 0;
  return {
    file,
    /** @param {string} line */
    write(line) {
      const text = `${new Date().toISOString()} ${line}`.replace(/\n?$/, '\n');
      try {
        if (!ready) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          rotate();
          ready = true;
        }
        written += Buffer.byteLength(text);
        if (written >= LOG_ROTATE_BYTES) {
          rotate();
          written = 0;
        }
        fs.appendFileSync(file, text);
      } catch {
        // Logging must never break a connection.
      }
    },
  };
}

/** MCP over WebSocket (subprotocol `mcp`) using the global WebSocket, with headers. */
export class WebSocketClientTransport {
  /**
   * @param {URL} url
   * @param {{headers?: Record<string, string>}} [options]
   */
  constructor(url, { headers = {} } = {}) {
    this.url = url;
    this.headers = headers;
    this.socket = null;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  start() {
    if (this.socket) throw new Error('WebSocketClientTransport already started');
    return new Promise((resolve, reject) => {
      // Node's WebSocket (undici) accepts an init object with protocols and headers.
      const socket = new WebSocket(this.url, { protocols: ['mcp'], headers: this.headers });
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve();
      };
      socket.onerror = (event) => {
        const error = event?.error instanceof Error ? event.error : new Error('WebSocket error');
        if (!opened) reject(error);
        this.onerror?.(error);
      };
      socket.onclose = () => {
        if (!opened) reject(new Error('WebSocket closed before it opened'));
        this.onclose?.();
      };
      socket.onmessage = (event) => {
        const data =
          typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString();
        if (Buffer.byteLength(data) > WS_MAX_MESSAGE_BYTES) {
          this.onerror?.(new Error('WebSocket message exceeds 16 MiB'));
          socket.close(1009, 'message too big');
          return;
        }
        let message;
        try {
          message = JSON.parse(data);
        } catch (error) {
          this.onerror?.(new Error(`invalid JSON from server: ${error.message}`));
          return;
        }
        this.onmessage?.(message);
      };
    });
  }

  async send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    this.socket?.close();
  }
}

const stringEnv = (env) =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));

/**
 * Build the SDK transport for a resolved server.
 *
 * @param {{name: string, type: string, config: any}} server resolved server (config.mjs)
 * @param {{kind?: string, root: string, env?: NodeJS.ProcessEnv, headers?: Record<string, string>,
 *   authProvider?: any, log?: {write(line: string): void}}} options
 *   `kind` overrides the transport (for the http → sse fallback).
 */
export function createTransport(
  server,
  { kind = server.type, root, env = process.env, headers, authProvider, log },
) {
  const config = server.config;

  if (kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...stringEnv(env), ...(config.env ?? {}), MCPC_PROJECT_DIR: root },
      cwd: config.cwd ?? root,
      stderr: 'pipe',
    });
    const stderr = transport.stderr;
    if (stderr && log) {
      let partial = '';
      stderr.setEncoding?.('utf8');
      stderr.on('data', (chunk) => {
        const lines = (partial + chunk).split(/\r?\n/);
        partial = lines.pop() ?? '';
        for (const line of lines) if (line) log.write(`[stderr] ${line}`);
      });
    }
    return transport;
  }

  const url = new URL(config.url);
  const finalHeaders = headers ?? config.headers ?? {};
  if (kind === 'ws') return new WebSocketClientTransport(url, { headers: finalHeaders });

  const options = { requestInit: { headers: finalHeaders } };
  if (authProvider) options.authProvider = authProvider;
  // The v2 SDK applies requestInit headers to the SSE stream as well as to POSTs.
  if (kind === 'sse') return new SSEClientTransport(url, options);
  return new StreamableHTTPClientTransport(url, options);
}

const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * End a process and its children.
 *
 * @param {number} pid
 */
export async function killTree(pid) {
  if (!pidAlive(pid)) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) =>
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolve(),
      ),
    );
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await delay(500);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Close an SDK client whose transport may be stdio: close stdin first, give the
 * server 300 ms to exit by itself, then end its process tree. Bounded to 5 s.
 *
 * @param {{close(): Promise<void>}} client
 * @param {any} transport
 */
export async function closeClient(client, transport) {
  const pid = transport instanceof StdioClientTransport ? transport.pid : null;
  const closing = client.close().catch(() => {});
  if (pid) {
    await within(closing, 300);
    if (pidAlive(pid)) await killTree(pid);
  }
  await within(closing, 5000);
}

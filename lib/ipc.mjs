// Local IPC between `mcpc` commands and a running `mcpc session`: newline-delimited
// JSON over a named pipe (Windows) or a Unix socket. No TCP port is opened.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Largest single message accepted on the wire (64 MiB). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Error carrying a machine-readable `code`, used on both sides of the wire. */
export class IpcError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Split a byte stream into JSON messages, one per line.
 *
 * @param {(message: any) => void} onMessage
 * @param {(error: Error) => void} onError called for a malformed or oversized line
 * @returns {(chunk: Buffer) => void}
 */
export function lineReader(onMessage, onError) {
  let pending = [];
  let pendingBytes = 0;

  return (chunk) => {
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, index));
      const line = Buffer.concat(pending).toString('utf8');
      pending = [];
      pendingBytes = 0;
      start = index + 1;
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        onError(new IpcError('bad_message', `invalid JSON on the wire: ${error.message}`));
        continue;
      }
      onMessage(message);
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      if (pendingBytes > MAX_MESSAGE_BYTES) {
        pending = [];
        pendingBytes = 0;
        onError(new IpcError('message_too_large', 'message exceeds 64 MiB'));
      }
    }
  };
}

/**
 * Write one message.
 *
 * @param {net.Socket} socket
 * @param {unknown} message
 */
export function writeMessage(socket, message) {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
}

/**
 * Connect once; rejects with the socket error (`ENOENT`, `ECONNREFUSED`, ...).
 *
 * @param {string} endpoint
 * @param {number} [timeoutMs]
 * @returns {Promise<net.Socket>}
 */
export function connectOnce(endpoint, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Client side of one IPC connection; requests may be issued concurrently. */
export class IpcClient {
  /** @param {net.Socket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.closed = false;

    socket.on(
      'data',
      lineReader(
        (message) => this.#dispatch(message),
        (error) => this.#failAll(error),
      ),
    );
    socket.on('error', (error) => this.#failAll(error));
    socket.on('close', () => {
      this.closed = true;
      this.#failAll(new IpcError('session_gone', 'the mcpc session closed the connection'));
    });
  }

  #dispatch(message) {
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      const { code, message: text, data } = message.error;
      entry.reject(new IpcError(code ?? 'error', text ?? 'session error', data));
    } else entry.resolve(message.result);
  }

  #failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  /**
   * Send a request and wait for its response.
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new IpcError('session_gone', 'connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeMessage(this.socket, { id, method, params });
    });
  }

  close() {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

/**
 * Connect to a session endpoint when something is listening there.
 *
 * @param {string} endpoint
 * @returns {Promise<IpcClient|null>}
 */
export async function trySession(endpoint) {
  try {
    return new IpcClient(await connectOnce(endpoint, 1000));
  } catch {
    return null;
  }
}

/**
 * Listen on the endpoint. On POSIX a leftover socket file with no listener is
 * removed first; an endpoint that answers means a session already runs.
 *
 * @param {string} endpoint
 * @param {(socket: net.Socket) => void} onConnection
 * @returns {Promise<net.Server>}
 */
export async function listen(endpoint, onConnection) {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    if (fs.existsSync(endpoint)) {
      const existing = await trySession(endpoint);
      if (existing) {
        existing.close();
        throw new IpcError('already_running', 'a session for this server is already running');
      }
      fs.rmSync(endpoint, { force: true });
    }
  }

  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new IpcError('already_running', 'a session for this server is already running')
          : error,
      ),
    );
    server.listen(endpoint, resolve);
  });
  return server;
}

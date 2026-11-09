// Local IPC between the mcpc CLI and its per-workspace daemon: newline-delimited
// JSON over a named pipe (Windows) or a Unix socket. No TCP port is opened.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Largest single message accepted on the wire (64 MiB). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const BIN = fileURLToPath(new URL('../bin/mcpc.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** CLI side of one daemon connection; requests may be issued concurrently. */
export class DaemonClient {
  /** @param {net.Socket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, onEvent?: Function}>} */
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
      this.#failAll(new IpcError('daemon_gone', 'the mcpc daemon closed the connection'));
    });
  }

  #dispatch(message) {
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    if (message.event !== undefined) {
      entry.onEvent?.(message.event);
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      const { code, message: text, data } = message.error;
      entry.reject(new IpcError(code ?? 'error', text ?? 'daemon error', data));
    } else entry.resolve(message.result);
  }

  #failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  /**
   * Send a request and wait for its final response.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {{onEvent?: (event: any) => void}} [options]
   * @returns {Promise<any>}
   */
  request(method, params = {}, { onEvent } = {}) {
    if (this.closed) return Promise.reject(new IpcError('daemon_gone', 'connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      writeMessage(this.socket, { id, method, params });
    });
  }

  close() {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Take the autostart lock. Returns a release function, or `null` when another
 * live process holds a fresh lock.
 *
 * @param {string} lockFile
 */
export function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return () => fs.rmSync(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      let age = 0;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        // Unreadable lock: treat as stale.
      }
      if (holder && pidAlive(holder.pid) && age < 30000) return null;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return null;
}

/**
 * Start a detached daemon process for this workspace.
 *
 * @param {{key: string, root: string, logFile: string, env?: NodeJS.ProcessEnv}} options
 */
export function spawnDaemon({ key, root, logFile, env = process.env }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [BIN, 'daemon', '--key', key, '--root', root], {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

const unreachable = (error) =>
  ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(error?.code);

/**
 * Connect to the workspace daemon, starting it when needed, and check that it
 * runs the same version as this CLI.
 *
 * @param {{endpoint: string, key: string, root: string, lockFile: string, logFile: string,
 *   version: string, env?: NodeJS.ProcessEnv, autostart?: boolean, timeoutMs?: number}} options
 * @returns {Promise<DaemonClient|null>} `null` only when `autostart` is false and no daemon runs
 */
export async function openDaemon(options) {
  const { endpoint, version, autostart = true, timeoutMs = 10000 } = options;

  for (let round = 0; round < 2; round++) {
    let socket = null;
    try {
      socket = await connectOnce(endpoint);
    } catch (error) {
      if (!unreachable(error)) throw error;
    }

    if (!socket) {
      if (!autostart) return null;
      socket = await startAndConnect(options, timeoutMs);
    }

    const client = new DaemonClient(socket);
    const hello = await client.request('hello', { version });
    if (hello.version === version) return client;

    // A daemon from another mcpc version: stop it and start a matching one once.
    await client.request('shutdown', {}).catch(() => {});
    client.close();
    await waitGone(endpoint, 5000);
  }
  throw new IpcError('version_mismatch', 'could not start a daemon matching this mcpc version');
}

async function startAndConnect(options, timeoutMs) {
  const { endpoint, key, root, lockFile, logFile, env } = options;
  const deadline = Date.now() + timeoutMs;
  let release = acquireLock(lockFile);
  try {
    if (release) spawnDaemon({ key, root, logFile, env });
    while (Date.now() < deadline) {
      try {
        return await connectOnce(endpoint);
      } catch (error) {
        if (!unreachable(error)) throw error;
      }
      // Another CLI may have died holding the lock; take it over once it is stale.
      if (!release) {
        release = acquireLock(lockFile);
        if (release) spawnDaemon({ key, root, logFile, env });
      }
      await delay(100);
    }
  } finally {
    release?.();
  }
  throw new IpcError(
    'daemon_start_failed',
    `the mcpc daemon did not start within ${Math.round(timeoutMs / 1000)} s; see ${logFile}`,
  );
}

async function waitGone(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const socket = await connectOnce(endpoint, 500);
      socket.destroy();
    } catch {
      return;
    }
    await delay(100);
  }
}

/**
 * Listen on the endpoint. On POSIX a leftover socket file with no listener is
 * removed first; an endpoint that answers means another daemon already runs.
 *
 * @param {string} endpoint
 * @param {(socket: net.Socket) => void} onConnection
 * @returns {Promise<net.Server>}
 */
export async function listen(endpoint, onConnection) {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    if (fs.existsSync(endpoint)) {
      try {
        const socket = await connectOnce(endpoint, 500);
        socket.destroy();
        throw new IpcError('already_running', 'another mcpc daemon is listening');
      } catch (error) {
        if (error instanceof IpcError) throw error;
        fs.rmSync(endpoint, { force: true });
      }
    }
  }

  const server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new IpcError('already_running', 'another mcpc daemon is listening')
          : error,
      ),
    );
    server.listen(endpoint, resolve);
  });
  return server;
}

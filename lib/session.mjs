// `mcpc session <server>`: keep one server connected so stateful servers keep
// their state between calls. The host runs this command in its own background
// mechanism; other `mcpc` commands reach it over a named pipe / Unix socket.

import { Connection } from './connection.mjs';
import { IpcError, lineReader, listen, writeMessage } from './ipc.mjs';
import { endpointFor } from './paths.mjs';

/**
 * Session endpoint of one server in one workspace.
 *
 * @param {{home: string, wsid: string}} ctx
 * @param {string} server
 */
export function sessionEndpoint(ctx, server) {
  return endpointFor(ctx.home, `${ctx.wsid}-${server}`);
}

/**
 * Run a session until it is stopped, goes idle, or loses its server.
 *
 * @param {{resolved: any, ctx: any, idleMs: number, out: (line: string) => void}} options
 * @returns {Promise<number>} exit code
 */
export async function runSession({ resolved, ctx, idleMs, out }) {
  const name = resolved.name;
  const endpoint = sessionEndpoint(ctx, name);
  let connection = await Connection.open(resolved, ctx);
  let tools = await connection.listTools();
  let inflight = 0;
  let lastActivity = Date.now();
  let server = null;
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));

  const stop = async (reason, code = 0) => {
    clearInterval(idleTimer);
    out(`mcpc session for ${name} stopped: ${reason}`);
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await connection.close().catch(() => {});
    finish(code);
  };

  const watch = (current) => {
    current.onclose = async () => {
      out(`${name} closed the connection; reconnecting once (server-side state may be lost)`);
      try {
        connection = await Connection.open(resolved, ctx);
        tools = await connection.listTools();
        watch(connection);
        out(`reconnected to ${name}`);
      } catch (error) {
        await stop(`could not reconnect: ${error.message}`, 1);
      }
    };
  };
  watch(connection);

  const findTool = async (toolName) => {
    let tool = tools.find((item) => item.name === toolName);
    if (!tool) {
      tools = await connection.listTools();
      tool = tools.find((item) => item.name === toolName);
    }
    if (!tool) throw new IpcError('unknown_tool', `${name} has no tool "${toolName}"`);
    return tool;
  };

  const handlers = {
    hello: async () => ({ server: name, pid: process.pid, transport: connection.kind }),
    tools: async ({ refresh = false }) => {
      if (refresh) tools = await connection.listTools();
      return { tools, cache: connection.cache };
    },
    call: async ({ tool, args, timeout }) =>
      connection.callTool(await findTool(tool), args, { timeout }),
    resources: async () => connection.listResources(),
    read: async ({ uri }) => connection.readResource(uri),
    stop: async () => {
      setImmediate(() => stop('stop requested'));
      return { stopping: true };
    },
  };

  const onConnection = (socket) => {
    socket.on(
      'data',
      lineReader(
        async (message) => {
          const handler = Object.hasOwn(handlers, message?.method)
            ? handlers[message.method]
            : null;
          inflight++;
          lastActivity = Date.now();
          try {
            if (!handler) throw new IpcError('unknown_method', `unknown method ${message?.method}`);
            writeMessage(socket, { id: message.id, result: await handler(message.params ?? {}) });
          } catch (error) {
            writeMessage(socket, {
              id: message.id,
              error: { code: error.code ?? 'error', message: String(error?.message ?? error) },
            });
          } finally {
            inflight--;
            lastActivity = Date.now();
          }
        },
        () => socket.destroy(),
      ),
    );
    socket.on('error', () => {});
  };

  try {
    server = await listen(endpoint, onConnection);
  } catch (error) {
    await connection.close();
    throw error;
  }

  const idleTimer = setInterval(
    () => {
      if (inflight === 0 && Date.now() - lastActivity > idleMs)
        stop(`idle for ${Math.round(idleMs / 60000)} minutes`);
    },
    Math.min(30000, idleMs),
  );
  process.once('SIGINT', () => stop('interrupted'));
  process.once('SIGTERM', () => stop('terminated'));

  out(
    `mcpc session for ${name} is ready (pid ${process.pid}, ${connection.kind}, ${tools.length} tools). ` +
      `Calls to ${name} now go through this session; keep this command running.`,
  );
  return finished;
}

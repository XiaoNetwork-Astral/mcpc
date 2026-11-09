// Remote fixture servers for end-to-end tests, all backed by createFixtureServer():
// Streamable HTTP (modern era with the legacy stateless fallback), legacy HTTP+SSE,
// and WebSocket. Each listens on 127.0.0.1 with an ephemeral port and records the
// headers of the requests it receives.

import http from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { WebSocketServer } from 'ws';

import { createFixtureServer } from './fixture-server.mjs';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/** Streamable HTTP endpoint at `/mcp`. */
export async function startHttpFixture() {
  const handler = createMcpHandler(() => createFixtureServer({ name: 'http-fixture' }));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push(req.headers);
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const headers = Object.entries(req.headers).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]],
      );
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body,
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) {
      res.writeHead(500).end(String(error?.message ?? error));
    }
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Server-side transport for the legacy HTTP+SSE protocol (one per GET /sse). */
class SseServerTransport {
  constructor(res, endpoint) {
    this.res = res;
    this.endpoint = endpoint;
  }

  async start() {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    this.res.write(`event: endpoint\ndata: ${this.endpoint}\n\n`);
  }

  async send(message) {
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close() {
    this.res.end();
    this.onclose?.();
  }
}

/**
 * Legacy HTTP+SSE server: GET `/sse` opens the stream, POST `/messages?sessionId=…`
 * carries client messages. Any other method on `/sse` answers 405, which is what
 * makes a client configured as `http` fall back to SSE.
 */
export async function startSseFixture() {
  const sessions = new Map();
  const seen = [];
  let next = 0;
  const server = http.createServer(async (req, res) => {
    seen.push(req.headers);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = String(++next);
      const transport = new SseServerTransport(res, `/messages?sessionId=${id}`);
      sessions.set(id, transport);
      req.on('close', () => {
        sessions.delete(id);
        transport.onclose?.();
      });
      await createFixtureServer({ name: 'sse-fixture' }).connect(transport);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = sessions.get(url.searchParams.get('sessionId'));
      if (!transport) return res.writeHead(404).end('unknown session');
      const body = (await readBody(req)).toString('utf8');
      res.writeHead(202).end('Accepted');
      transport.onmessage?.(JSON.parse(body));
      return;
    }
    res.writeHead(url.pathname === '/sse' ? 405 : 404).end();
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    seen,
    close: () =>
      new Promise((resolve) => {
        for (const transport of sessions.values()) transport.res.end();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** WebSocket server speaking MCP with subprotocol `mcp`. */
export async function startWsFixture() {
  const seen = [];
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => (protocols.has('mcp') ? 'mcp' : false),
  });
  wss.on('connection', async (socket, request) => {
    seen.push(request.headers);
    const transport = {
      async start() {},
      async send(message) {
        socket.send(JSON.stringify(message));
      },
      async close() {
        socket.close();
      },
    };
    socket.on('message', (data) => transport.onmessage?.(JSON.parse(data.toString('utf8'))));
    socket.on('close', () => transport.onclose?.());
    await createFixtureServer({ name: 'ws-fixture' }).connect(transport);
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  return {
    url: `ws://127.0.0.1:${wss.address().port}/`,
    seen,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(resolve);
      }),
  };
}

// A controllable MCP server for tests, built on the official v2 server SDK.
// Run as a stdio server: `node fixture-server.mjs [--legacy]`; or import
// `createFixtureServer()` to attach it to another transport.
//
// Environment knobs:
//   FIXTURE_PID_FILE   write the process id here on start
//   FIXTURE_LOG_FILE   append one line per tools/call here

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// 1x1 transparent PNG.
export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    });
  });

const object = (properties, required = []) => ({ type: 'object', properties, required });

/** Base tool list; `extra` tools are added by the `add_tool` call. */
export const BASE_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back.\nSecond line is not shown in catalogs.',
    inputSchema: object({ text: { type: 'string', description: 'Text to echo' } }, ['text']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum as structured content.',
    inputSchema: object({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
    outputSchema: object({ sum: { type: 'number' } }, ['sum']),
  },
  { name: 'fail', description: 'Always return a tool error.', inputSchema: object({}) },
  { name: 'image', description: 'Return a 1x1 PNG image.', inputSchema: object({}) },
  {
    name: 'big',
    description: 'Return a long text of the requested size.',
    inputSchema: object({ chars: { type: 'integer' } }, ['chars']),
  },
  {
    name: 'slow',
    description: 'Wait, sending progress notifications, then reply.',
    inputSchema: object({ ms: { type: 'integer' } }, ['ms']),
  },
  {
    name: 'ask',
    description: 'Ask the user for a name through elicitation.',
    inputSchema: object({}),
  },
  {
    name: 'sample',
    description: 'Ask the client model for a completion.',
    inputSchema: object({}),
  },
  {
    name: 'delete_everything',
    description: 'Pretend to delete things.',
    inputSchema: object({}),
    annotations: { destructiveHint: true },
  },
  {
    name: 'add_tool',
    description: 'Register one more tool and notify list_changed.',
    inputSchema: object({}),
  },
  {
    name: 'crash',
    description: 'Exit the server process after replying.',
    inputSchema: object({}),
  },
  // Malformed on purpose: clients must skip it and keep the rest.
  { name: 'broken', description: 'Invalid input schema.', inputSchema: { type: 'string' } },
];

/**
 * @param {{name?: string}} [options]
 */
export function createFixtureServer({ name = 'fixture' } = {}) {
  const extra = [];
  const server = new Server(
    { name, version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: {},
        logging: {},
      },
      instructions: 'Fixture server for mcpc tests.',
    },
  );

  const logCall = (tool) => {
    if (process.env.FIXTURE_LOG_FILE) fs.appendFileSync(process.env.FIXTURE_LOG_FILE, tool + '\n');
  };

  server.setRequestHandler('tools/list', async () => ({ tools: [...BASE_TOOLS, ...extra] }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name: tool, arguments: args = {} } = request.params;
    logCall(tool);
    switch (tool) {
      case 'echo':
        return { content: [{ type: 'text', text: String(args.text) }] };
      case 'add': {
        const sum = args.a + args.b;
        return {
          content: [{ type: 'text', text: JSON.stringify({ sum }) }],
          structuredContent: { sum },
        };
      }
      case 'fail':
        return { content: [{ type: 'text', text: 'something went wrong' }], isError: true };
      case 'image':
        return { content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] };
      case 'big':
        return { content: [{ type: 'text', text: 'x'.repeat(args.chars) }] };
      case 'slow': {
        const token = ctx.mcpReq._meta?.progressToken;
        const steps = 4;
        for (let step = 1; step <= steps; step++) {
          await delay(args.ms / steps, ctx.mcpReq.signal);
          if (token !== undefined) {
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: step, total: steps },
            });
          }
        }
        return { content: [{ type: 'text', text: `slept ${args.ms} ms` }] };
      }
      case 'ask': {
        const answer = await ctx.mcpReq.elicitInput({
          mode: 'form',
          message: 'What is your name?',
          requestedSchema: object({ name: { type: 'string' } }, ['name']),
        });
        return { content: [{ type: 'text', text: `elicitation: ${JSON.stringify(answer)}` }] };
      }
      case 'sample': {
        const reply = await ctx.mcpReq.requestSampling({
          messages: [{ role: 'user', content: { type: 'text', text: 'Say hi' } }],
          maxTokens: 50,
        });
        return { content: [{ type: 'text', text: `sampling: ${JSON.stringify(reply)}` }] };
      }
      case 'delete_everything':
        return { content: [{ type: 'text', text: 'deleted nothing' }] };
      case 'add_tool':
        extra.push({
          name: `extra_${extra.length + 1}`,
          description: 'Added at runtime.',
          inputSchema: object({}),
        });
        await server.sendToolListChanged();
        return { content: [{ type: 'text', text: `added extra_${extra.length}` }] };
      case 'crash':
        setTimeout(() => process.exit(3), 50);
        return { content: [{ type: 'text', text: 'crashing' }] };
      default:
        return { content: [{ type: 'text', text: `unknown tool ${tool}` }], isError: true };
    }
  });

  server.setRequestHandler('prompts/list', async () => ({
    prompts: [
      { name: 'greet', description: 'Greet someone', arguments: [{ name: 'who', required: true }] },
    ],
  }));
  server.setRequestHandler('prompts/get', async (request) => ({
    description: 'A greeting',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `Please greet ${request.params.arguments?.who}` },
      },
    ],
  }));
  server.setRequestHandler('resources/list', async () => ({
    resources: [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: [{ uriTemplate: 'fixture://items/{id}', name: 'item' }],
  }));
  server.setRequestHandler('resources/read', async (request) => ({
    contents: [
      { uri: request.params.uri, mimeType: 'text/plain', text: `content of ${request.params.uri}` },
    ],
  }));

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.FIXTURE_PID_FILE)
    fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
  const server = createFixtureServer();
  await server.connect(new StdioServerTransport());
}

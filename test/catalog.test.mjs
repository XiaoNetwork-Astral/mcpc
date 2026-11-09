import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  compactSchema,
  filterTools,
  firstLine,
  parseToolRef,
  renderCatalog,
  renderDefinitions,
  sanitizeTools,
  searchTools,
  toolId,
} from '../lib/catalog.mjs';

/**
 * @param {string} name
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
function makeTool(name, extra = {}) {
  return { name, inputSchema: { type: 'object', properties: {} }, ...extra };
}

/**
 * @param {string} server
 * @param {string} name
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
function makeEntry(server, name, extra = {}) {
  return { server, tool: makeTool(name, extra) };
}

test('toolId joins server and tool with a slash', () => {
  assert.equal(toolId('github', 'search'), 'github/search');
  assert.equal(toolId('fs', 'read_file'), 'fs/read_file');
});

test('parseToolRef accepts every ref form', () => {
  const servers = new Set(['github', 'fs', 's', 't']);

  assert.deepEqual(parseToolRef('github/search', servers), {
    server: 'github',
    tool: 'search',
  });
  assert.deepEqual(parseToolRef('mcp__github__search', servers), {
    server: 'github',
    tool: 'search',
  });
  assert.deepEqual(parseToolRef('github__search', servers), {
    server: 'github',
    tool: 'search',
  });
  assert.deepEqual(parseToolRef('github.search', servers), {
    server: 'github',
    tool: 'search',
  });
  assert.deepEqual(parseToolRef('github.search.repos', servers), {
    server: 'github',
    tool: 'search.repos',
  });
  assert.deepEqual(parseToolRef('fs/a/b', servers), { server: 'fs', tool: 'a/b' });
  assert.deepEqual(parseToolRef('s__a__b', servers), { server: 's', tool: 'a__b' });
  assert.deepEqual(parseToolRef('mcp__s__a__b', servers), { server: 's', tool: 'a__b' });
  assert.deepEqual(parseToolRef('  t/c  ', servers), { server: 't', tool: 'c' });
});

test('parseToolRef rejects unknown servers and malformed refs', () => {
  const servers = ['github', 'fs'];

  assert.equal(parseToolRef('unknown/tool', servers), null);
  assert.equal(parseToolRef('unknown__tool', servers), null);
  assert.equal(parseToolRef('mcp__unknown__tool', servers), null);
  assert.equal(parseToolRef('unknown.tool', servers), null);
  assert.equal(parseToolRef('github', servers), null);
  assert.equal(parseToolRef('github/', servers), null);
  assert.equal(parseToolRef('', servers), null);
  assert.equal(parseToolRef(null, servers), null);
  assert.equal(parseToolRef('github/search', new Set()), null);
});

test('sanitizeTools skips each malformed entry with a reason', () => {
  const { tools, skipped } = sanitizeTools([
    null,
    'not a tool',
    [],
    { name: '' },
    { name: 42 },
    { name: 'x'.repeat(129) },
    { name: 'ok', inputSchema: [] },
    { name: 'bad-type', inputSchema: { type: 'array' } },
    { name: 'ok', inputSchema: {} },
    { name: 'ok', inputSchema: {} },
  ]);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ok'],
  );
  assert.deepEqual(
    skipped.map((entry) => entry.reason),
    [
      'not an object',
      'not an object',
      'not an object',
      'invalid name',
      'invalid name',
      'invalid name',
      'invalid inputSchema',
      'invalid inputSchema',
      'duplicate name',
    ],
  );
  assert.equal(skipped[0].name, null);
  assert.equal(skipped[4].name, null);
  assert.equal(skipped[8].name, 'ok');
});

test('sanitizeTools normalizes kept tools and drops unknown fields', () => {
  const rawSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  };
  const raw = {
    name: 'search',
    title: 'Search',
    description: 'Find things',
    inputSchema: rawSchema,
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: { 'anthropic/alwaysLoad': true },
    execution: { taskSupport: 'forbidden' },
    icons: [{ src: 'icon.png' }],
  };

  const { tools, skipped } = sanitizeTools([raw]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(tools, [
    {
      name: 'search',
      inputSchema: rawSchema,
      title: 'Search',
      description: 'Find things',
      annotations: { readOnlyHint: true },
      _meta: { 'anthropic/alwaysLoad': true },
      outputSchema: { type: 'object' },
    },
  ]);
  assert.notStrictEqual(tools[0].inputSchema, rawSchema);
  assert.equal('execution' in tools[0], false);
  assert.equal('icons' in tools[0], false);
});

test('sanitizeTools forces an object type and filters schema fields', () => {
  const { tools } = sanitizeTools([
    {
      name: 'a',
      inputSchema: {
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    },
    {
      name: 'b',
      inputSchema: {
        type: 'object',
        properties: [],
        required: ['q', 1],
        description: 123,
      },
    },
    {
      name: 'c',
      inputSchema: { type: 'object', properties: null, required: 'q' },
      title: 1,
      description: 2,
      annotations: [],
      _meta: 'x',
      outputSchema: [],
    },
  ]);

  assert.deepEqual(tools[0], {
    name: 'a',
    inputSchema: { properties: { q: { type: 'string' } }, required: ['q'], type: 'object' },
  });
  assert.deepEqual(tools[1], {
    name: 'b',
    inputSchema: { type: 'object', description: 123 },
  });
  assert.deepEqual(tools[2], { name: 'c', inputSchema: { type: 'object' } });
});

test('sanitizeTools accepts non-arrays as an empty list', () => {
  assert.deepEqual(sanitizeTools(undefined), { tools: [], skipped: [] });
  assert.deepEqual(sanitizeTools({ name: 'x' }), { tools: [], skipped: [] });
});

test('filterTools applies include then exclude with globs', () => {
  const tools = [
    makeTool('read_file'),
    makeTool('write_file'),
    makeTool('read_dir'),
    makeTool('other'),
  ];

  assert.deepEqual(
    filterTools(tools, { include: ['read_*'] }).map((tool) => tool.name),
    ['read_file', 'read_dir'],
  );
  assert.deepEqual(
    filterTools(tools, { include: ['*_file'], exclude: ['write_*'] }).map((tool) => tool.name),
    ['read_file'],
  );
  assert.deepEqual(
    filterTools(tools, { exclude: ['read_*'] }).map((tool) => tool.name),
    ['write_file', 'other'],
  );
  assert.deepEqual(filterTools(tools, { include: [] }), []);
  assert.deepEqual(filterTools(tools, {}), tools);
});

test('firstLine returns the first non-empty trimmed line', () => {
  assert.equal(firstLine('\n  hello  \nworld', 20), 'hello');
  assert.equal(firstLine('one\r\ntwo', 20), 'one');
  assert.equal(firstLine('abcdef', 3), 'abc…');
  assert.equal(firstLine('abc', 3), 'abc');
  assert.equal(firstLine('abc', 0), '…');
  assert.equal(firstLine('   \n\t', 10), '');
  assert.equal(firstLine(42, 10), '');
  assert.equal(firstLine('anything'), 'anything');
});

test('renderCatalog selects entries round-robin across servers', () => {
  const servers = [
    {
      name: 'b',
      status: 'connected',
      transport: 'stdio',
      tools: [makeTool('b1', { description: 'B one' }), makeTool('b2', { description: 'B two' })],
    },
    {
      name: 'a',
      status: 'connected',
      transport: 'http',
      tools: [
        makeTool('a1', { description: 'A one' }),
        makeTool('a2', { description: 'A two' }),
        makeTool('a3', { description: 'A three' }),
      ],
    },
  ];

  const text = renderCatalog(servers, { budgetTokens: 7 });
  assert.equal(
    text,
    '## a  connected  http  3 tools (1 of 3 shown)\n' +
      '\n' +
      '- a/a1 — A one\n' +
      '\n' +
      '## b  connected  stdio  2 tools (1 of 2 shown)\n' +
      '\n' +
      '- b/b1 — B one\n' +
      '\n' +
      'Use `mcpc search <terms>` to find the rest.\n',
  );
});

test('renderCatalog stops at the first entry line that would exceed the budget', () => {
  const servers = [
    {
      name: 'a',
      status: 'connected',
      transport: 'stdio',
      tools: [makeTool('huge', { description: 'x'.repeat(200) })],
    },
    {
      name: 'b',
      status: 'connected',
      transport: 'stdio',
      tools: [makeTool('small', { description: 'short' })],
    },
  ];

  const text = renderCatalog(servers, { budgetTokens: 10, descriptionLimit: 200 });
  assert.match(text, /## a .* \(0 of 1 shown\)/);
  assert.match(text, /## b .* \(0 of 1 shown\)/);
  assert.doesNotMatch(text, /^- /m);
  assert.ok(text.endsWith('Use `mcpc search <terms>` to find the rest.\n'));
});

test('renderCatalog prints alwaysLoad definitions outside the budget', () => {
  const servers = [
    {
      name: 's',
      status: 'connected',
      transport: 'stdio',
      alwaysLoad: true,
      tools: [makeTool('a'), makeTool('b')],
    },
    {
      name: 't',
      status: 'connected',
      transport: 'stdio',
      tools: [makeTool('c'), makeTool('d', { _meta: { 'anthropic/alwaysLoad': true } })],
    },
  ];

  const text = renderCatalog(servers, { budgetTokens: 0 });
  assert.match(text, /### s\/a\n/);
  assert.match(text, /### s\/b\n/);
  assert.match(text, /### t\/d\n/);
  assert.doesNotMatch(text, /### t\/c\n/);
  assert.doesNotMatch(text, /^- s\/a/m);
  assert.doesNotMatch(text, /^- t\/c/m);
  assert.match(text, /## t .* \(1 of 2 shown\)/);
  assert.ok(text.endsWith('Use `mcpc search <terms>` to find the rest.\n'));
});

test('renderCatalog omits denied tools and flags ask tools', () => {
  const servers = [
    {
      name: 's',
      status: 'connected',
      transport: 'stdio',
      tools: [
        makeTool('allowed', { description: 'fine', annotations: { readOnlyHint: true } }),
        makeTool('denied', { description: 'secret' }),
        makeTool('asked', { description: 'confirm', annotations: { destructiveHint: true } }),
      ],
    },
  ];

  const text = renderCatalog(servers, {
    permission: (id) => {
      if (id === 's/denied') return 'deny';
      if (id === 's/asked') return 'ask';
      return 'allow';
    },
  });
  assert.match(text, /## s  connected  stdio  2 tools\n/);
  assert.match(text, /- s\/allowed — fine \[read-only\]/);
  assert.match(text, /- s\/asked — confirm \[destructive\] \[ask\]/);
  assert.doesNotMatch(text, /denied/);
  assert.doesNotMatch(text, /of 2 shown/);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
});

test('renderCatalog renders partial headers, errors, and truncated instructions', () => {
  const servers = [
    {
      name: 's',
      status: 'failed',
      transport: 'stdio',
      error: 'boom',
      instructions: 'instructions that are cut',
      tools: [makeTool('only', { description: 'only tool' })],
    },
  ];

  const text = renderCatalog(servers, { budgetTokens: 0, instructionsLimit: 12 });
  assert.match(
    text,
    /^## s {2}failed {2}stdio {2}1 tool \(0 of 1 shown\) {2}error: boom\n\ninstructions\n/,
  );
  assert.match(text, /Use `mcpc search <terms>` to find the rest\.\n$/);
  assert.doesNotMatch(text, /^- /m);
});

test('renderCatalog returns an empty string when there are no servers', () => {
  assert.equal(renderCatalog([], {}), '');
  assert.equal(renderCatalog(undefined), '');
});

test('renderDefinitions renders title, hints, description, and schemas', () => {
  const items = [
    {
      server: 's',
      tool: {
        name: 't',
        title: 'Title T',
        description: 'Does a thing.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
      },
    },
  ];

  const text = renderDefinitions(items);
  assert.equal(
    text,
    '### s/t\n' +
      'title: Title T\n' +
      'hints: read-only, destructive, open-world\n' +
      'Does a thing.\n' +
      'input schema:\n' +
      '{"type":"object","properties":{}}\n' +
      'output schema:\n' +
      '{"type":"object"}\n',
  );
});

test('renderDefinitions uses a placeholder and cuts long descriptions', () => {
  const text = renderDefinitions([
    { server: 's', tool: makeTool('plain', { description: 'abcdef' }) },
    { server: 's', tool: makeTool('empty') },
  ]);

  assert.match(text, /### s\/plain\nabcdef\ninput schema:/);
  assert.match(text, /### s\/empty\n\(no description\)\ninput schema:/);
  assert.match(text, /\n\n### s\/empty\n/);

  const limited = renderDefinitions(
    [{ server: 's', tool: makeTool('cut', { description: 'abcdef' }) }],
    {
      descriptionLimit: 3,
    },
  );
  assert.match(limited, /### s\/cut\nabc\ninput schema:/);
  assert.doesNotMatch(limited, /abc…/);
});

test('renderDefinitions compacts schemas unless full is requested', () => {
  const long = 'x'.repeat(400);
  const schema = {
    type: 'object',
    properties: {
      a: {
        anyOf: [{ type: 'string', description: long }, { type: 'number' }],
      },
    },
  };

  const compacted = renderDefinitions(
    [{ server: 's', tool: makeTool('t', { inputSchema: schema }) }],
    {
      schemaBudget: 80,
    },
  );
  assert.match(compacted, /\[schema compacted for display; use --full for the original\]\n$/);
  assert.doesNotMatch(compacted, /x{400}/);

  const full = renderDefinitions([{ server: 's', tool: makeTool('t', { inputSchema: schema }) }], {
    schemaBudget: 80,
    full: true,
  });
  assert.ok(full.includes(long));
  assert.doesNotMatch(full, /\[schema compacted/);
});

test('compactSchema leaves small schemas unchanged and unmodified', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const snapshot = structuredClone(schema);
  const result = compactSchema(schema, 5000);

  assert.equal(result.compacted, false);
  assert.deepEqual(result.schema, snapshot);
  assert.notStrictEqual(result.schema, schema);
  assert.deepEqual(schema, snapshot);
});

test('compactSchema measures compact JSON bytes, not pretty output', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  assert.ok(Buffer.byteLength(JSON.stringify(schema, null, 2), 'utf8') > bytes);

  const result = compactSchema(schema, bytes);
  assert.equal(result.compacted, false);
});

test('compactSchema pass 1 strips nested descriptions and keeps the root one', () => {
  const long = 'x'.repeat(500);
  const schema = {
    type: 'object',
    description: 'root',
    properties: {
      a: {
        type: 'object',
        description: long,
        properties: { b: { type: 'string', description: long } },
      },
    },
    $defs: {
      A: { type: 'string', description: long, enum: ['y'.repeat(50)] },
    },
  };

  const result = compactSchema(schema, 400);
  assert.equal(result.compacted, true);
  assert.equal(result.schema.description, 'root');
  assert.equal(result.schema.properties.a.description, undefined);
  assert.equal(result.schema.properties.a.properties.b.description, undefined);
  assert.ok(result.schema.$defs, 'compaction stops before the definitions pass');
});

test('compactSchema pass 2 drops definitions and replaces local refs', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/A' } },
    required: ['a'],
    $defs: {
      A: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['x'.repeat(300)] } },
      },
    },
  };

  const result = compactSchema(schema, 150);
  assert.equal(result.compacted, true);
  assert.equal(result.schema.$defs, undefined);
  assert.deepEqual(result.schema.properties.a, {});
});

test('compactSchema pass 3 collapses object schemas deeper than three levels', () => {
  const schema = {
    type: 'object',
    properties: {
      l1: {
        type: 'object',
        properties: {
          l2: {
            type: 'object',
            properties: {
              l3: {
                type: 'object',
                properties: {
                  l4: {
                    type: 'object',
                    properties: { l5: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const result = compactSchema(schema, 200);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.schema.properties.l1.properties.l2.properties.l3.properties.l4, {
    type: 'object',
  });
});

test('compactSchema pass 4 prunes compositions', () => {
  const schema = {
    type: 'object',
    properties: {
      a: {
        anyOf: [{ type: 'string', enum: ['x'.repeat(300)] }, { type: 'number' }],
      },
    },
  };

  const result = compactSchema(schema, 100);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.schema.properties.a, {});
});

test('searchTools ranks an id match above a description match', () => {
  const entries = [
    makeEntry('s', 'alpha', { description: 'beta' }),
    makeEntry('s', 'beta', { description: 'unrelated' }),
  ];

  const result = searchTools(entries, 'beta');
  assert.deepEqual(
    result.items.map((item) => [item.tool.name, item.score]),
    [
      ['beta', 20],
      ['alpha', 4],
    ],
  );
  assert.equal(result.total, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.missing, []);
});

test('searchTools applies the weighted ranking', () => {
  const entries = [
    makeEntry('s', 'search'),
    makeEntry('s', 'search_helper'),
    makeEntry('s', 'searchx'),
    makeEntry('s', 'desc', { description: 'search things' }),
    makeEntry('s', 'props', {
      inputSchema: {
        type: 'object',
        properties: { search: { type: 'string', description: 'a search term' } },
      },
    }),
  ];

  const result = searchTools(entries, 'search');
  assert.deepEqual(
    result.items.map((item) => [item.tool.name, item.score]),
    [
      ['search', 20],
      ['search_helper', 12],
      ['searchx', 8],
      ['desc', 4],
      ['props', 2],
    ],
  );
});

test('searchTools adds naive singulars to query terms', () => {
  const entries = [makeEntry('s', 'tool'), makeEntry('s', 'class'), makeEntry('s', 'other')];

  assert.deepEqual(
    searchTools(entries, 'tools').items.map((item) => item.tool.name),
    ['tool'],
  );
  assert.deepEqual(
    searchTools(entries, 'classes').items.map((item) => item.tool.name),
    ['class'],
  );
});

test('searchTools requires +terms to match', () => {
  const entries = [
    makeEntry('s', 'alpha', { description: 'beta' }),
    makeEntry('s', 'gamma', { description: 'beta' }),
  ];

  const result = searchTools(entries, '+alpha beta');
  assert.deepEqual(
    result.items.map((item) => item.tool.name),
    ['alpha'],
  );

  const singularRequired = searchTools([makeEntry('s', 'tool'), makeEntry('s', 'other')], '+tools');
  assert.deepEqual(
    singularRequired.items.map((item) => item.tool.name),
    ['tool'],
  );
});

test('searchTools restricts results with server:', () => {
  const entries = [makeEntry('s1', 'read'), makeEntry('s2', 'read'), makeEntry('s2', 'write')];

  assert.deepEqual(
    searchTools(entries, 'read server:s2').items.map((item) => `${item.server}/${item.tool.name}`),
    ['s2/read'],
  );

  const serverOnly = searchTools(entries, 'server:s2');
  assert.deepEqual(
    serverOnly.items.map((item) => `${item.server}/${item.tool.name}`),
    ['s2/read', 's2/write'],
  );
  assert.equal(serverOnly.total, 2);
});

test('searchTools select form preserves ref order and reports missing refs', () => {
  const entries = [
    makeEntry('s', 'a'),
    makeEntry('s', 'b'),
    makeEntry('s', 'tool.with.dot'),
    makeEntry('t', 'c'),
  ];

  const result = searchTools(
    entries,
    'select:s/a, mcp__s__b, s/missing, nope/x, s/tool.with.dot, s/a',
  );
  assert.deepEqual(
    result.items.map((item) => `${item.server}/${item.tool.name}`),
    ['s/a', 's/b', 's/tool.with.dot', 's/a'],
  );
  assert.deepEqual(result.missing, ['s/missing', 'nope/x']);
  assert.equal(result.total, 4);
  assert.equal(result.remaining, 0);
  assert.equal(result.nextOffset, null);
});

test('searchTools paginates with offset, remaining, and nextOffset', () => {
  const entries = Array.from({ length: 7 }, (_, index) =>
    makeEntry('s', `tool${index + 1}`, { description: 'needle' }),
  );

  const first = searchTools(entries, 'needle', { limit: 2 });
  assert.deepEqual(
    first.items.map((item) => item.tool.name),
    ['tool1', 'tool2'],
  );
  assert.equal(first.total, 7);
  assert.equal(first.remaining, 5);
  assert.equal(first.nextOffset, 2);

  const last = searchTools(entries, 'needle', { limit: 2, offset: 6 });
  assert.deepEqual(
    last.items.map((item) => item.tool.name),
    ['tool7'],
  );
  assert.equal(last.remaining, 0);
  assert.equal(last.nextOffset, null);

  const past = searchTools(entries, 'needle', { limit: 2, offset: 10 });
  assert.deepEqual(past.items, []);
  assert.equal(past.remaining, 0);
  assert.equal(past.nextOffset, null);
});

test('searchTools returns all entries sorted by id for an empty query', () => {
  const entries = [makeEntry('b', 'two'), makeEntry('a', 'one'), makeEntry('b', 'one')];

  const result = searchTools(entries, '   ', { limit: 2 });
  assert.deepEqual(
    result.items.map((item) => `${item.server}/${item.tool.name}`),
    ['a/one', 'b/one'],
  );
  assert.ok(result.items.every((item) => item.score === 0));
  assert.equal(result.total, 3);
  assert.equal(result.remaining, 1);
  assert.equal(result.nextOffset, 2);
});

test('searchTools tokenizes camelCase and punctuation', () => {
  const entries = [
    makeEntry('s', 'readFile'),
    makeEntry('s', 'read-file'),
    makeEntry('s', 'other'),
  ];

  const read = searchTools(entries, 'read').items.map((item) => [item.tool.name, item.score]);
  assert.deepEqual(read, [
    ['read-file', 12],
    ['readFile', 12],
  ]);
  assert.deepEqual(
    searchTools(entries, 'file').items.map((item) => item.tool.name),
    ['read-file', 'readFile'],
  );
});

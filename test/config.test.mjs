import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  approvalState,
  buildServerConfig,
  expandString,
  loadConfig,
  readApprovals,
  readConfigFile,
  redact,
  removeServer,
  resolveServer,
  setApproval,
  validateServer,
  writeServer,
} from '../lib/config.mjs';
import { configFiles } from '../lib/paths.mjs';

/**
 * Create a temporary directory that is removed when the test finishes.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @returns {string} Temporary directory path.
 */
function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Write a JSON fixture file.
 *
 * @param {string} file File path.
 * @param {unknown} data Data to serialize.
 * @returns {void}
 */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Write a text fixture file.
 *
 * @param {string} file File path.
 * @param {string} text File contents.
 * @returns {void}
 */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Check whether a list of messages contains a match.
 *
 * @param {string[]} messages Messages to inspect.
 * @param {RegExp} pattern Pattern to match.
 * @returns {boolean} `true` when a message matches.
 */
function contains(messages, pattern) {
  return messages.some((message) => pattern.test(message));
}

test('expandString handles every documented form', () => {
  assert.deepEqual(expandString('plain text', {}), {
    value: 'plain text',
    missing: [],
    used: [],
  });
  assert.deepEqual(expandString('${TOKEN}', { TOKEN: 'abc' }), {
    value: 'abc',
    missing: [],
    used: ['TOKEN'],
  });
  assert.deepEqual(expandString('${TOKEN}', {}), {
    value: '${TOKEN}',
    missing: ['TOKEN'],
    used: [],
  });
  assert.deepEqual(expandString('${TOKEN:-fallback}', {}), {
    value: 'fallback',
    missing: [],
    used: [],
  });
  assert.deepEqual(expandString('${TOKEN:-}', {}), { value: '', missing: [], used: [] });
  assert.deepEqual(expandString('${TOKEN:-fallback}', { TOKEN: '' }), {
    value: '',
    missing: [],
    used: ['TOKEN'],
  });
  assert.deepEqual(expandString('${A}/${B}', { A: 'a', B: 'b' }), {
    value: 'a/b',
    missing: [],
    used: ['A', 'B'],
  });
  assert.deepEqual(expandString('${A:-http://localhost:1}', {}), {
    value: 'http://localhost:1',
    missing: [],
    used: [],
  });
  assert.deepEqual(expandString('$${A}', { A: 'a' }), { value: '$a', missing: [], used: ['A'] });
  assert.deepEqual(expandString('${A}${A}', { A: 'x' }), { value: 'xx', missing: [], used: ['A'] });
  assert.deepEqual(expandString('${A}${B}', {}), {
    value: '${A}${B}',
    missing: ['A', 'B'],
    used: [],
  });
});

test('readConfigFile reports data, mtimes, missing files, and invalid JSON', (t) => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');

  assert.deepEqual(readConfigFile(file), { data: null, mtimeMs: 0, exists: false });

  writeJson(file, { mcpServers: {} });
  const valid = readConfigFile(file);
  assert.equal(valid.exists, true);
  assert.deepEqual(valid.data, { mcpServers: {} });
  assert.ok(valid.mtimeMs > 0);
  assert.equal(valid.error, undefined);

  writeText(file, '{ not json');
  const invalid = readConfigFile(file);
  assert.equal(invalid.exists, true);
  assert.equal(invalid.data, null);
  assert.match(invalid.error, /invalid JSON/);
  assert.ok(invalid.error.includes(file));
});

test('validateServer accepts valid stdio and remote configurations', () => {
  const stdio = validateServer('files', { command: 'npx', args: ['-y', 'server'] });
  assert.deepEqual(stdio.errors, []);
  assert.equal(stdio.type, 'stdio');

  for (const type of ['http', 'sse', 'ws']) {
    const result = validateServer('remote', { type, url: 'https://example.com/mcp' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.type, type);
  }

  const allFields = validateServer('full', {
    type: 'stdio',
    command: 'npx',
    args: ['-y'],
    env: { TOKEN: 'x' },
    cwd: '/tmp',
    timeout: 5000,
    startupTimeout: 5000,
    alwaysLoad: true,
    disabled: false,
    session: true,
    tools: { include: ['read_*'], exclude: ['write_*'] },
  });
  assert.deepEqual(allFields.errors, []);
});

test('validateServer normalizes type aliases and infers stdio from command', () => {
  assert.equal(validateServer('a', { type: 'streamable-http', url: 'https://x' }).type, 'http');
  assert.equal(validateServer('a', { type: 'websocket', url: 'ws://x' }).type, 'ws');
  assert.equal(validateServer('a', { command: 'npx' }).type, 'stdio');
  assert.deepEqual(validateServer('a', { command: 'npx' }).errors, []);
});

test('validateServer rejects bad server names', () => {
  for (const name of ['', 'bad name', 'a'.repeat(65), 'bad/name', 'a__b']) {
    const result = validateServer(name, { command: 'npx' });
    assert.ok(contains(result.errors, /name/), `expected a name error for ${JSON.stringify(name)}`);
  }
  assert.deepEqual(validateServer('A-1_b', { command: 'npx' }).errors, []);
  assert.deepEqual(validateServer('a'.repeat(64), { command: 'npx' }).errors, []);
});

test('validateServer rejects non-object configurations', () => {
  for (const raw of [null, [], 'stdio', 42]) {
    const result = validateServer('server', raw);
    assert.ok(contains(result.errors, /object/));
    assert.equal(result.type, undefined);
  }
});

test('validateServer rejects unknown types and url without type', () => {
  assert.ok(
    contains(validateServer('s', { type: 'ftp', command: 'x' }).errors, /unknown server type/),
  );
  const noType = validateServer('s', { url: 'https://example.com' });
  assert.ok(contains(noType.errors, /explicit "type"/));
  assert.equal(noType.type, undefined);
  assert.ok(contains(validateServer('s', {}).errors, /"type" or a "command"/));
});

test('validateServer enforces transport-required fields', () => {
  for (const raw of [
    { type: 'stdio' },
    { type: 'stdio', command: '' },
    { type: 'stdio', command: 1 },
  ]) {
    assert.ok(contains(validateServer('s', raw).errors, /command/));
  }
  for (const type of ['http', 'sse', 'ws']) {
    for (const raw of [{ type }, { type, url: '' }, { type, url: 42 }]) {
      assert.ok(contains(validateServer('s', raw).errors, /url/));
    }
  }
});

test('validateServer checks field types', () => {
  const base = { type: 'stdio', command: 'npx' };
  const cases = [
    [{ ...base, args: '--flag' }, /"args"/],
    [{ ...base, args: [1] }, /"args"/],
    [{ ...base, env: 'A=1' }, /"env"/],
    [{ ...base, env: { A: 1 } }, /"env"/],
    [{ ...base, cwd: 1 }, /"cwd"/],
    [{ ...base, timeout: 0 }, /"timeout"/],
    [{ ...base, timeout: -5 }, /"timeout"/],
    [{ ...base, timeout: '5000' }, /"timeout"/],
    [{ ...base, startupTimeout: 0 }, /"startupTimeout"/],
    [{ ...base, alwaysLoad: 'yes' }, /"alwaysLoad"/],
    [{ ...base, disabled: 1 }, /"disabled"/],
    [{ ...base, tools: 'all' }, /"tools"/],
    [{ ...base, tools: { include: 'read_*' } }, /"tools.include"/],
    [{ ...base, tools: { exclude: [1] } }, /"tools.exclude"/],
    [{ type: 'http', url: 'https://x', headers: [] }, /"headers"/],
    [{ type: 'http', url: 'https://x', headers: { A: 1 } }, /"headers"/],
    [{ ...base, session: 'yes' }, /"session"/],
  ];
  for (const [raw, pattern] of cases) {
    assert.ok(
      contains(validateServer('s', raw).errors, pattern),
      `expected ${pattern} for ${JSON.stringify(raw)}`,
    );
  }
});

test('validateServer accepts a boolean session and rejects non-booleans', () => {
  for (const session of [true, false]) {
    const result = validateServer('s', { command: 'npx', session });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  }
  for (const session of ['yes', 1, null]) {
    assert.ok(
      contains(
        validateServer('s', { command: 'npx', session }).errors,
        /"session" must be a boolean/,
      ),
      `expected a session error for ${JSON.stringify(session)}`,
    );
  }
});

test('validateServer checks oauth shape and https metadata URL', () => {
  const base = { type: 'http', url: 'https://x' };
  const cases = [
    [{ ...base, oauth: 'yes' }, /"oauth"/],
    [{ ...base, oauth: null }, /"oauth"/],
    [{ ...base, oauth: { clientId: 1 } }, /clientId/],
    [{ ...base, oauth: { clientSecret: 1 } }, /clientSecret/],
    [{ ...base, oauth: { scopes: 1 } }, /scopes/],
    [{ ...base, oauth: { callbackPort: '8080' } }, /callbackPort/],
    [{ ...base, oauth: { authServerMetadataUrl: 'http://auth' } }, /https URL/],
  ];
  for (const [raw, pattern] of cases) {
    assert.ok(
      contains(validateServer('s', raw).errors, pattern),
      `expected ${pattern} for ${JSON.stringify(raw)}`,
    );
  }

  assert.deepEqual(
    validateServer('s', {
      ...base,
      oauth: {
        clientId: 'id',
        clientSecret: 'secret',
        callbackPort: 8080,
        scopes: 'read write',
        authServerMetadataUrl: 'https://auth.example.com/.well-known/oauth',
      },
    }).errors,
    [],
  );
  assert.deepEqual(validateServer('s', { ...base, oauth: false }).errors, []);
});

test('validateServer emits warnings without rejecting the config', () => {
  const cases = [
    [{ command: 'npx', mystery: true }, /unknown field "mystery"/],
    [{ command: 'npx', headersHelper: 'cmd' }, /unknown field "headersHelper"/],
    [{ command: ' npx ' }, /"command".*whitespace/],
    [{ type: 'http', url: ' https://x ' }, /"url".*whitespace/],
    [{ command: 'npx', args: [' --flag '] }, /"args\[0\]".*whitespace/],
    [{ command: 'npx', env: { ' TOKEN ': 'x' } }, /"env" key .*whitespace/],
    [{ type: 'http', url: 'https://x', headers: { ' X-Key ': 'v' } }, /"headers" key .*whitespace/],
    [{ command: 'npx', timeout: 500 }, /below 1000/],
    [{ command: 'npx', headers: { A: '1' } }, /"headers".*does not apply/],
    [{ type: 'http', url: 'https://x', command: 'npx' }, /"command".*does not apply/],
    [{ type: 'ws', url: 'ws://x', oauth: {} }, /"oauth".*does not apply/],
  ];

  for (const [raw, pattern] of cases) {
    const result = validateServer('s', raw);
    assert.deepEqual(result.errors, [], `unexpected errors for ${JSON.stringify(raw)}`);
    assert.ok(
      contains(result.warnings, pattern),
      `expected ${pattern} for ${JSON.stringify(raw)}: ${result.warnings.join('; ')}`,
    );
  }
});

test('resolveServer expands fields, defaults cwd, and records warnings', () => {
  const resolved = resolveServer(
    'api',
    {
      type: 'http',
      url: 'https://${HOST}/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}', 'X-Short': '${SHORT}' },
      timeout: 5000,
    },
    {
      scope: 'project',
      env: { HOST: 'example.com', TOKEN: 'supersecret', SHORT: 'ab' },
      root: '/repo',
    },
  );

  assert.equal(resolved.name, 'api');
  assert.equal(resolved.scope, 'project');
  assert.equal(resolved.type, 'http');
  assert.equal(resolved.config.url, 'https://example.com/mcp');
  assert.equal(resolved.config.headers.Authorization, 'Bearer supersecret');
  // Only values of secret-looking variables (or of env/headers fields) are secrets.
  assert.deepEqual(resolved.secrets, ['supersecret']);
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.warnings, []);

  const stdio = resolveServer(
    'fs',
    {
      command: '${RUNNER}',
      args: ['--root', '${WORKSPACE}'],
      env: { TOKEN: '${TOKEN}', LITERAL: 'value' },
      cwd: '${DIR}',
    },
    {
      env: { RUNNER: 'node', WORKSPACE: '/work', TOKEN: 'tok1234', DIR: '/custom' },
      root: '/workspace',
    },
  );
  assert.equal(stdio.config.type, 'stdio');
  assert.equal(stdio.config.command, 'node');
  assert.deepEqual(stdio.config.args, ['--root', '/work']);
  assert.deepEqual(stdio.config.env, { TOKEN: 'tok1234', LITERAL: 'value' });
  assert.equal(stdio.config.cwd, '/custom');

  const defaultCwd = resolveServer('fs', { command: 'node' }, { env: {}, root: '/workspace' });
  assert.equal(defaultCwd.config.cwd, '/workspace');

  const withMissing = resolveServer(
    'fs',
    { command: 'node', env: { TOKEN: '${MISSING}', FALLBACK: '${OTHER:-default-value}' } },
    { env: {}, root: '/workspace' },
  );
  assert.equal(withMissing.config.env.TOKEN, '${MISSING}');
  assert.equal(withMissing.config.env.FALLBACK, 'default-value');
  assert.deepEqual(
    withMissing.warnings.filter((warning) => warning.includes('not set')),
    ['${MISSING} is not set'],
  );
  assert.ok(withMissing.secrets.includes('default-value'));
});

test('resolveServer fingerprints resolved config and raw approval config separately', () => {
  const raw = { type: 'http', url: 'https://x/${PATH}', headers: { B: '2', A: '1' } };
  const one = resolveServer('s', raw, { scope: 'local', env: { PATH: 'one' }, root: '/r' });
  const two = resolveServer('s', raw, { scope: 'local', env: { PATH: 'two' }, root: '/r' });
  const otherScope = resolveServer('s', raw, { scope: 'user', env: { PATH: 'one' }, root: '/r' });

  assert.match(one.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(one.approvalFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(one.fingerprint, two.fingerprint);
  assert.equal(one.approvalFingerprint, two.approvalFingerprint);
  assert.notEqual(one.fingerprint, otherScope.fingerprint);
  assert.equal(one.approvalFingerprint, otherScope.approvalFingerprint);

  const reordered = { headers: { A: '1', B: '2' }, url: 'https://x/${PATH}', type: 'http' };
  assert.equal(
    resolveServer('s', reordered, { scope: 'local', env: { PATH: 'one' }, root: '/r' })
      .approvalFingerprint,
    one.approvalFingerprint,
  );

  const changedRaw = resolveServer(
    's',
    { ...raw, timeout: 5000 },
    { scope: 'local', env: { PATH: 'one' }, root: '/r' },
  );
  assert.notEqual(changedRaw.approvalFingerprint, one.approvalFingerprint);

  const placeholderRaw = { type: 'http', url: 'https://${HOST}/mcp' };
  const literalRaw = { type: 'http', url: 'https://example.com/mcp' };
  const placeholder = resolveServer('s', placeholderRaw, {
    scope: 'local',
    env: { HOST: 'example.com' },
    root: '/r',
  });
  const literal = resolveServer('s', literalRaw, {
    scope: 'local',
    env: { HOST: 'example.com' },
    root: '/r',
  });
  assert.equal(placeholder.fingerprint, literal.fingerprint);
  assert.notEqual(placeholder.approvalFingerprint, literal.approvalFingerprint);
});

test('loadConfig applies local > project > user without merging fields', (t) => {
  const directory = tempDir(t);
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'root');
  const files = configFiles({ home, root, wsid: 'wsid' });

  writeJson(files.local, {
    mcpServers: {
      alpha: { type: 'stdio', command: 'local-alpha' },
      shared: { type: 'stdio', command: 'local' },
    },
    permissions: { allow: ['local-a/*'], ask: ['local-ask/*'], deny: ['local-deny/*'] },
  });
  writeJson(files.project, {
    mcpServers: {
      beta: { type: 'http', url: 'https://project.example.com' },
      shared: { type: 'stdio', command: 'project' },
    },
    permissions: { allow: ['project-a/*'] },
  });
  writeJson(files.user, {
    mcpServers: {
      gamma: { type: 'stdio', command: 'user-gamma' },
      shared: { type: 'stdio', command: 'user', args: ['--user-only'] },
    },
    permissions: { allow: ['user-a/*'], ask: ['user-ask/*'], deny: ['user-deny/*'] },
  });

  const loaded = loadConfig(files, { env: {}, root });

  assert.deepEqual([...loaded.servers.keys()], ['alpha', 'beta', 'gamma', 'shared']);
  assert.equal(loaded.servers.get('shared').scope, 'local');
  assert.equal(loaded.servers.get('shared').config.command, 'local');
  assert.equal('args' in loaded.servers.get('shared').config, false);

  // A `permissions` key is ignored silently in every scope.
  assert.equal('permissions' in loaded, false);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.errors, []);

  for (const scope of ['local', 'project', 'user']) {
    assert.equal(loaded.sources[scope].path, files[scope]);
    assert.equal(loaded.sources[scope].exists, true);
    assert.ok(loaded.sources[scope].mtimeMs > 0);
  }
});

test('loadConfig treats missing files as empty scopes', (t) => {
  const directory = tempDir(t);
  const files = {
    local: path.join(directory, 'missing-local.json'),
    project: path.join(directory, 'missing-project.json'),
    user: path.join(directory, 'missing-user.json'),
  };

  const loaded = loadConfig(files, { env: {}, root: directory });
  assert.equal(loaded.servers.size, 0);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.errors, []);
  for (const scope of ['local', 'project', 'user']) {
    assert.deepEqual(loaded.sources[scope], { path: files[scope], mtimeMs: 0, exists: false });
  }
});

test('loadConfig reports invalid JSON in one scope and keeps the others', (t) => {
  const directory = tempDir(t);
  const files = configFiles({ home: path.join(directory, 'home'), root: directory, wsid: 'wsid' });

  writeText(files.local, '{ not valid json');
  writeJson(files.project, { mcpServers: { project: { type: 'stdio', command: 'p' } } });
  writeJson(files.user, { mcpServers: { user: { type: 'stdio', command: 'u' } } });

  const loaded = loadConfig(files, { env: {}, root: directory });
  assert.deepEqual([...loaded.servers.keys()], ['project', 'user']);
  assert.equal(loaded.errors.length, 1);
  assert.ok(loaded.errors[0].includes(files.local));
  assert.equal(loaded.sources.local.exists, true);
});

test('loadConfig returns invalid servers with errors, sorted by name', (t) => {
  const directory = tempDir(t);
  const files = configFiles({ home: path.join(directory, 'home'), root: directory, wsid: 'wsid' });
  writeJson(files.local, {
    mcpServers: {
      bad__name: { type: 'stdio', command: 'x' },
      good: { type: 'http', url: 'https://example.com' },
    },
  });

  const loaded = loadConfig(files, { env: {}, root: directory });
  assert.deepEqual([...loaded.servers.keys()], ['bad__name', 'good']);
  assert.ok(loaded.servers.get('bad__name').errors.length > 0);
  assert.deepEqual(loaded.servers.get('good').errors, []);
});

test('buildServerConfig builds stdio and remote configurations', () => {
  assert.deepEqual(
    buildServerConfig({
      transport: 'stdio',
      target: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
    }),
    { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } },
  );
  assert.deepEqual(buildServerConfig({ transport: 'stdio', target: 'npx', args: [], env: {} }), {
    command: 'npx',
  });
  assert.deepEqual(
    buildServerConfig({
      transport: 'http',
      target: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    }),
    { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  );
  assert.deepEqual(
    buildServerConfig({ transport: 'streamable-http', target: 'https://example.com/mcp' }),
    { type: 'http', url: 'https://example.com/mcp' },
  );
  assert.deepEqual(
    buildServerConfig({ transport: 'sse', target: 'https://example.com/sse', timeout: 5000 }),
    { type: 'sse', url: 'https://example.com/sse', timeout: 5000 },
  );
});

test('writeServer keeps unrelated keys and writes formatted JSON with a newline', (t) => {
  const directory = tempDir(t);
  const file = path.join(directory, 'nested', 'deep', 'config.json');

  writeServer(file, 'one', { type: 'stdio', command: 'npx' });
  const firstText = fs.readFileSync(file, 'utf8');
  assert.equal(
    firstText,
    `${JSON.stringify({ mcpServers: { one: { type: 'stdio', command: 'npx' } } }, null, 2)}\n`,
  );
  assert.ok(firstText.endsWith('\n'));

  writeJson(file, {
    version: 2,
    mcpServers: { existing: { type: 'stdio', command: 'existing' } },
    other: { keep: true },
  });
  writeServer(file, 'two', { type: 'http', url: 'https://example.com' });

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.version, 2);
  assert.deepEqual(data.other, { keep: true });
  assert.deepEqual(data.mcpServers.existing, { type: 'stdio', command: 'existing' });
  assert.deepEqual(data.mcpServers.two, { type: 'http', url: 'https://example.com' });
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));

  const leftovers = fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeServer refuses to clobber invalid JSON', (t) => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');
  writeText(file, '{ broken');

  assert.throws(() => writeServer(file, 'one', { type: 'stdio', command: 'npx' }), /invalid JSON/);
});

test('removeServer removes only the named server and reports whether it changed', (t) => {
  const directory = tempDir(t);
  const file = path.join(directory, 'config.json');
  writeJson(file, {
    version: 3,
    mcpServers: {
      keep: { type: 'stdio', command: 'keep' },
      drop: { type: 'stdio', command: 'drop' },
    },
    other: 'value',
  });

  assert.equal(removeServer(file, 'missing'), false);
  const before = fs.readFileSync(file, 'utf8');

  assert.equal(removeServer(file, 'drop'), true);
  const after = fs.readFileSync(file, 'utf8');
  assert.notEqual(after, before);
  assert.ok(after.endsWith('\n'));
  const data = JSON.parse(after);
  assert.equal(data.version, 3);
  assert.equal(data.other, 'value');
  assert.deepEqual(Object.keys(data.mcpServers), ['keep']);

  assert.equal(removeServer(file, 'drop'), false);
  assert.equal(removeServer(path.join(directory, 'absent.json'), 'drop'), false);
});

test('approvals round-trip through the documented format', (t) => {
  const directory = tempDir(t);
  const file = path.join(directory, 'approvals.json');

  assert.deepEqual(readApprovals(file), { servers: {} });

  writeJson(file, {
    version: 1,
    servers: {
      old: { approvalFingerprint: 'old', decision: 'rejected', at: '2026-01-01T00:00:00.000Z' },
    },
  });
  setApproval(file, 'approved-server', 'fp-approved', 'approved');
  setApproval(file, 'rejected-server', 'fp-rejected', 'rejected');

  const data = readApprovals(file);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.servers), ['old', 'approved-server', 'rejected-server']);

  const entry = data.servers['approved-server'];
  assert.equal(entry.approvalFingerprint, 'fp-approved');
  assert.equal(entry.decision, 'approved');
  assert.equal(new Date(entry.at).toISOString(), entry.at);
  assert.equal(data.servers['rejected-server'].decision, 'rejected');

  assert.equal(
    approvalState(data, { name: 'approved-server', approvalFingerprint: 'fp-approved' }),
    'approved',
  );
  assert.equal(
    approvalState(data, { name: 'rejected-server', approvalFingerprint: 'fp-rejected' }),
    'rejected',
  );
  assert.equal(
    approvalState(data, { name: 'approved-server', approvalFingerprint: 'changed' }),
    'pending',
  );
  assert.equal(approvalState(data, { name: 'unknown', approvalFingerprint: 'fp' }), 'pending');
  assert.equal(
    approvalState({ servers: {} }, { name: 'approved-server', approvalFingerprint: 'fp-approved' }),
    'pending',
  );
});

test('redact replaces secrets longest first and leaves other values alone', () => {
  assert.equal(redact('token=abcdef', ['abcdef']), 'token=***');
  assert.equal(redact('abcdef', ['abc', 'abcdef']), '***');
  assert.equal(redact('abcdef', ['abcdef', 'abc']), '***');
  assert.equal(redact('x abc y abc', ['abc']), 'x *** y ***');
  assert.equal(redact('secret-token', ['secret', 'token']), '***-***');
  assert.equal(redact('no match', ['other']), 'no match');
  assert.equal(redact('abc', []), 'abc');
  assert.equal(redact('abc', ['']), 'abc');
  assert.equal(redact(42, ['secret']), 42);
  assert.equal(redact(null, ['secret']), null);
  assert.equal(redact(undefined, ['secret']), undefined);
});

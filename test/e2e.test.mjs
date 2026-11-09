// End-to-end tests: run the real CLI entry (in-process) against fixture servers
// over stdio, Streamable HTTP, legacy SSE and WebSocket.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trySession } from '../lib/ipc.mjs';
import { main } from '../lib/main.mjs';
import { workspaceId } from '../lib/paths.mjs';
import { sessionEndpoint } from '../lib/session.mjs';
import { startHttpFixture, startSseFixture, startWsFixture } from './helpers/remote-fixture.mjs';

const FIXTURE = fileURLToPath(new URL('./helpers/fixture-server.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A throwaway MCPC home and workspace, plus a runner for CLI commands. */
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-e2e-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env, MCPC_HOME: home };
  delete env.MCPC_PROJECT_DIR;
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const run = async (...args) => {
    const out = [];
    const err = [];
    const code = await main(['-C', root, ...args], {
      env,
      cwd: root,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const addFixture = (name = 'fixture', extra = {}) =>
    run('add-json', name, JSON.stringify({ command: process.execPath, args: [FIXTURE], ...extra }));
  return { home, root, env, run, addFixture };
}

test('stdio discovery: list, tools, search and describe', async (t) => {
  const s = sandbox(t);
  assert.equal((await s.addFixture()).code, 0);

  let result = await s.run('list');
  assert.match(result.out, /^fixture\s+local\s+stdio\s+ready\s+tools not listed yet/);

  result = await s.run('tools', '--budget', '40');
  assert.equal(result.code, 0);
  assert.match(result.out, /## fixture {2}ready {2}stdio {2}10 tools \(\d+ of 10 shown\)/);
  assert.match(result.out, /Fixture server for mcpc tests\./);
  assert.match(result.out, /Use `mcpc search <terms>` to find the rest\./);

  // The catalog is cached now: list shows the count, search needs no server.
  result = await s.run('list');
  assert.match(result.out, /10 tools/);

  result = await s.run('search', 'add', 'numbers', '--limit', '1');
  assert.equal(result.code, 0);
  assert.match(result.out, /^### fixture\/add\n/);
  assert.match(result.out, /input schema:\n\{"type":"object","properties":\{"a"/);

  result = await s.run('describe', 'fixture/echo', 'fixture/missing');
  assert.equal(result.code, 2);
  assert.match(result.out, /### fixture\/echo/);
  assert.match(result.out, /Not found: fixture\/missing/);
});

test('stdio calls: text, structured, image, tool error, validation and unknown tools', async (t) => {
  const s = sandbox(t);
  await s.addFixture();

  let result = await s.run('call', 'fixture/echo', '{"text":"hello"}');
  assert.deepEqual([result.code, result.out], [0, 'hello']);

  result = await s.run('call', 'mcp__fixture__add', '{"a":2,"b":3}');
  assert.deepEqual([result.code, result.out], [0, '{"sum":5}']);

  result = await s.run('call', 'fixture/image');
  assert.equal(result.code, 0);
  const saved = /→ (.+\.png)\]$/.exec(result.out)?.[1];
  assert.ok(saved && fs.existsSync(saved), result.out);

  result = await s.run('call', 'fixture/fail');
  assert.deepEqual([result.code, result.out], [1, 'Tool error:\nsomething went wrong']);

  result = await s.run('call', 'fixture/echo', '{}');
  assert.equal(result.code, 2);
  assert.match(
    result.err,
    /arguments do not match fixture\/echo:\n- \/text: must have required property 'text'/,
  );

  result = await s.run('call', 'fixture/nope');
  assert.equal(result.code, 2);
  assert.match(result.err, /fixture has no tool "nope"; see: mcpc tools fixture/);

  result = await s.run('call', 'nosuch/echo');
  assert.equal(result.code, 2);
  assert.match(result.err, /cannot resolve "nosuch\/echo"/);

  result = await s.run('--json', 'call', 'fixture/add', '{"a":1,"b":2}');
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out).structuredContent, { sum: 3 });
});

test('without a session every call starts a fresh server', async (t) => {
  const s = sandbox(t);
  await s.addFixture();
  assert.equal((await s.run('call', 'fixture/counter')).out, 'count 1');
  assert.equal((await s.run('call', 'fixture/counter')).out, 'count 1');
});

test('large output is saved to a file with a preview', async (t) => {
  const s = sandbox(t);
  await s.addFixture();
  const result = await s.run('call', 'fixture/big', '{"chars":60000}');
  assert.equal(result.code, 0);
  const file = /→ (.+\.txt)\]$/.exec(result.out)?.[1];
  assert.ok(file, result.out);
  assert.equal(fs.readFileSync(file, 'utf8').length, 60000);
  assert.ok(result.out.length < 2300);
});

test('resources, read and get --probe', async (t) => {
  const s = sandbox(t);
  await s.addFixture();

  let result = await s.run('resources');
  assert.match(result.out, /- fixture:\/\/readme {2}readme {2}text\/plain/);
  assert.match(result.out, /- template fixture:\/\/items\/\{id\} {2}item/);

  result = await s.run('read', 'fixture', 'fixture://readme');
  assert.equal(result.out, '[resource fixture://readme text/plain]\ncontent of fixture://readme');

  result = await s.run('get', 'fixture', '--probe');
  assert.equal(result.code, 0);
  assert.match(result.out, /server: fixture 1\.0\.0/);
  assert.match(result.out, /skipped tool broken: invalid inputSchema/);
  assert.match(result.out, /probe ok \(connection\)/);
});

test('a session keeps server state; stateful servers require one', async (t) => {
  const s = sandbox(t);
  await s.addFixture();
  await s.addFixture('stateful', { session: true });

  let result = await s.run('call', 'stateful/counter');
  assert.equal(result.code, 1);
  assert.match(
    result.err,
    /stateful is stateful and needs a running session.*mcpc session stateful/,
  );

  const session = s.run('session', 'fixture', '--idle', '1');
  const endpoint = sessionEndpoint({ home: s.home, wsid: workspaceId(s.root) }, 'fixture');
  let probe = null;
  for (let i = 0; i < 100 && !probe; i++) {
    probe = await trySession(endpoint);
    if (!probe) await delay(100);
  }
  assert.ok(probe, 'session did not start');
  probe.close();

  assert.match((await s.run('list')).out, /fixture\s+local\s+stdio\s+session/);
  assert.equal((await s.run('call', 'fixture/counter')).out, 'count 1');
  assert.equal((await s.run('call', 'fixture/counter')).out, 'count 2');

  // A tool added at runtime is found by refreshing the session's list once.
  assert.equal((await s.run('call', 'fixture/add_tool')).out, 'added extra_1');
  assert.equal((await s.run('call', 'fixture/extra_1')).out, 'called extra_1');

  result = await s.run('session', 'fixture');
  assert.equal(result.code, 1);
  assert.match(result.err, /already running/);

  const control = await trySession(endpoint);
  await control.request('stop');
  control.close();
  const ended = await session;
  assert.equal(ended.code, 0);
  assert.match(ended.out, /session for fixture is ready/);
  assert.match(ended.out, /stopped: stop requested/);
});

test('project servers from .mcp.json need approval', async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(
    path.join(s.root, '.mcp.json'),
    JSON.stringify({ mcpServers: { proj: { command: process.execPath, args: [FIXTURE] } } }),
  );

  let result = await s.run('list');
  assert.match(result.out, /proj\s+project\s+stdio\s+pending-approval/);

  result = await s.run('call', 'proj/echo', '{"text":"x"}');
  assert.equal(result.code, 1);
  assert.match(result.err, /mcpc approve proj/);

  assert.equal((await s.run('approve', 'proj')).code, 0);
  assert.equal((await s.run('call', 'proj/echo', '{"text":"approved"}')).out, 'approved');
});

test('Streamable HTTP with configured headers', async (t) => {
  const s = sandbox(t);
  const server = await startHttpFixture();
  t.after(() => server.close());
  await s.run(
    'add-json',
    'web',
    JSON.stringify({ type: 'http', url: server.url, headers: { 'X-Test': 'http' } }),
  );

  const result = await s.run('call', 'web/echo', '{"text":"over http"}');
  assert.deepEqual([result.code, result.out, result.err], [0, 'over http', '']);
  assert.ok(server.seen.some((headers) => headers['x-test'] === 'http'));
  // The fixture lists one malformed tool; on the modern protocol the SDK would reject the
  // whole list, so mcpc repairs it in the transport and reports the skipped tool.
  const probe = (await s.run('get', 'web', '--probe')).out;
  assert.match(probe, /modern protocol, http/);
  assert.match(probe, /skipped tool broken: invalid inputSchema/);
  assert.match(probe, /probe ok/);
});

test('legacy SSE, and an http server that falls back to SSE', async (t) => {
  const s = sandbox(t);
  const server = await startSseFixture();
  t.after(() => server.close());
  await s.run(
    'add-json',
    'legacy',
    JSON.stringify({ type: 'sse', url: server.url, headers: { 'X-Test': 'sse' } }),
  );
  await s.run('add-json', 'fallback', JSON.stringify({ type: 'http', url: server.url }));

  let result = await s.run('call', 'legacy/echo', '{"text":"over sse"}');
  assert.deepEqual([result.code, result.out, result.err], [0, 'over sse', '']);
  assert.ok(server.seen.some((headers) => headers['x-test'] === 'sse'));

  result = await s.run('call', 'fallback/echo', '{"text":"fell back"}');
  assert.deepEqual([result.code, result.out, result.err], [0, 'fell back', '']);
  assert.match((await s.run('list')).out, /fallback\s+local\s+sse/);
});

test('WebSocket with configured headers', async (t) => {
  const s = sandbox(t);
  const server = await startWsFixture();
  t.after(() => server.close());
  await s.run(
    'add-json',
    'sock',
    JSON.stringify({ type: 'ws', url: server.url, headers: { 'X-Test': 'ws' } }),
  );

  const result = await s.run('call', 'sock/echo', '{"text":"over ws"}');
  assert.deepEqual([result.code, result.out, result.err], [0, 'over ws', '']);
  assert.ok(server.seen.some((headers) => headers['x-test'] === 'ws'));
});

test('install-skill copies the skill, replaces its own copy and keeps foreign ones', async (t) => {
  const { root, run } = sandbox(t);
  const first = await run('install-skill', '--dir', 'skills');
  assert.equal(first.code, 0, first.err);
  const installed = path.join(root, 'skills', 'mcp-client');
  assert.ok(first.out.includes(installed));
  assert.match(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), /^name: mcp-client$/m);
  assert.ok(fs.existsSync(path.join(installed, 'references', 'configuration.md')));

  fs.writeFileSync(path.join(installed, 'stale.txt'), 'old');
  const again = await run('install-skill', '--dir', 'skills', '--json');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(JSON.parse(again.out).installed, [installed]);
  assert.ok(!fs.existsSync(path.join(installed, 'stale.txt')));

  const foreign = path.join(root, 'other', 'mcp-client');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: something-else\n---\n');
  const conflict = await run('install-skill', '--dir', 'other');
  assert.equal(conflict.code, 1);
  assert.match(conflict.err, /is not the mcp-client skill/);
  assert.match(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), /something-else/);
});

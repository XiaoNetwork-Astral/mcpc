import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  approvalsFile,
  cacheFile,
  configFiles,
  daemonKey,
  endpointFor,
  findWorkspaceRoot,
  logsDir,
  mcpcHome,
  projectDir,
  resultsDir,
  workspaceId,
} from '../lib/paths.mjs';

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

test('mcpcHome prefers MCPC_HOME and falls back to ~/.mcpc', () => {
  const custom = path.join(os.tmpdir(), 'mcpc-home');
  assert.equal(mcpcHome({ MCPC_HOME: custom }), path.resolve(custom));
  assert.equal(mcpcHome({}), path.join(os.homedir(), '.mcpc'));
  assert.equal(mcpcHome({ MCPC_HOME: '' }), path.join(os.homedir(), '.mcpc'));
});

test('findWorkspaceRoot returns the explicit cwd first', (t) => {
  const base = tempDir(t);
  const explicit = path.join(base, 'explicit');
  const nested = path.join(base, 'repo', 'a', 'b');
  fs.mkdirSync(explicit);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(base, 'repo', '.mcp.json'), '{}');

  assert.equal(findWorkspaceRoot({ cwd: nested, env: {}, explicit }), explicit);
  assert.equal(
    findWorkspaceRoot({ cwd: nested, env: { MCPC_PROJECT_DIR: path.join(base, 'env') }, explicit }),
    explicit,
  );
  assert.equal(
    findWorkspaceRoot({ cwd: nested, env: {}, explicit: 'relative-dir' }),
    path.resolve(nested, 'relative-dir'),
  );
});

test('findWorkspaceRoot falls back to MCPC_PROJECT_DIR', (t) => {
  const base = tempDir(t);
  const nested = path.join(base, 'repo', 'a');
  const projectDirFromEnv = path.join(base, 'from-env');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(projectDirFromEnv);
  fs.mkdirSync(path.join(base, 'repo', '.git'));

  assert.equal(
    findWorkspaceRoot({ cwd: nested, env: { MCPC_PROJECT_DIR: projectDirFromEnv } }),
    projectDirFromEnv,
  );
  assert.equal(
    findWorkspaceRoot({ cwd: nested, env: { MCPC_PROJECT_DIR: 'relative' } }),
    path.resolve(nested, 'relative'),
  );
});

test('findWorkspaceRoot uses the nearest .mcp.json ancestor', (t) => {
  const base = tempDir(t);
  const repo = path.join(base, 'repo');
  const lower = path.join(repo, 'a');
  const nested = path.join(lower, 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(repo, '.mcp.json'), '{}');

  assert.equal(findWorkspaceRoot({ cwd: nested, env: {} }), repo);

  fs.writeFileSync(path.join(lower, '.mcp.json'), '{}');
  assert.equal(findWorkspaceRoot({ cwd: nested, env: {} }), lower);
  assert.equal(findWorkspaceRoot({ cwd: lower, env: {} }), lower);
});

test('findWorkspaceRoot uses the Git top level for .git directories and files', (t) => {
  const directoryCase = tempDir(t);
  const directoryRepo = path.join(directoryCase, 'repo');
  const directoryNested = path.join(directoryRepo, 'a', 'b');
  fs.mkdirSync(path.join(directoryRepo, '.git'), { recursive: true });
  fs.mkdirSync(directoryNested, { recursive: true });
  assert.equal(findWorkspaceRoot({ cwd: directoryNested, env: {} }), directoryRepo);

  const fileCase = tempDir(t);
  const fileRepo = path.join(fileCase, 'worktree');
  const fileNested = path.join(fileRepo, 'src', 'deep');
  fs.mkdirSync(fileNested, { recursive: true });
  fs.writeFileSync(path.join(fileRepo, '.git'), 'gitdir: /somewhere/.git/worktrees/repo\n');
  assert.equal(findWorkspaceRoot({ cwd: fileNested, env: {} }), fileRepo);
});

test('findWorkspaceRoot prefers .mcp.json over Git', (t) => {
  const base = tempDir(t);
  const repo = path.join(base, 'repo');
  const sub = path.join(repo, 'packages', 'tool');
  const nested = path.join(sub, 'src');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(sub, '.mcp.json'), '{}');

  assert.equal(findWorkspaceRoot({ cwd: nested, env: {} }), sub);
});

test('findWorkspaceRoot falls back to cwd when no marker exists', (t) => {
  const nested = path.join(tempDir(t), 'plain', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findWorkspaceRoot({ cwd: nested, env: {} }), nested);
});

test('workspaceId is stable, 16 hex, and lowercases only on win32', () => {
  const root = path.join(os.tmpdir(), 'Mcpc-Wsid-Case');

  const id = workspaceId(root);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(workspaceId(root), id);
  assert.notEqual(workspaceId(`${root}-other`), id);

  const expectedWindows = createHash('sha256')
    .update(path.resolve(root).toLowerCase())
    .digest('hex')
    .slice(0, 16);
  const expectedPosix = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  assert.equal(workspaceId(root, 'win32'), expectedWindows);
  assert.equal(workspaceId(root, 'linux'), expectedPosix);
  assert.notEqual(workspaceId(root, 'win32'), workspaceId(root, 'linux'));
});

test('daemonKey appends the MCPC_SESSION suffix', () => {
  assert.equal(daemonKey('abcd1234'), 'abcd1234');
  assert.equal(daemonKey('abcd1234', {}), 'abcd1234');
  assert.equal(daemonKey('abcd1234', { MCPC_SESSION: '' }), 'abcd1234');

  const suffix = createHash('sha256').update('session-1').digest('hex').slice(0, 8);
  assert.equal(daemonKey('abcd1234', { MCPC_SESSION: 'session-1' }), `abcd1234-${suffix}`);
  assert.notEqual(
    daemonKey('abcd1234', { MCPC_SESSION: 'session-1' }),
    daemonKey('abcd1234', { MCPC_SESSION: 'session-2' }),
  );
});

test('project path helpers build the documented layout', () => {
  const home = path.join(os.tmpdir(), 'mcpc-home');
  const wsid = '0123456789abcdef';

  assert.equal(projectDir(home, wsid), path.join(home, 'projects', wsid));
  assert.equal(approvalsFile(home, wsid), path.join(home, 'projects', wsid, 'approvals.json'));
  assert.equal(
    cacheFile(home, wsid, 'github'),
    path.join(home, 'projects', wsid, 'cache', 'github.json'),
  );
  assert.equal(resultsDir(home, wsid), path.join(home, 'projects', wsid, 'results'));
  assert.equal(logsDir(home, wsid), path.join(home, 'projects', wsid, 'logs'));
});

test('configFiles returns absolute local, project, and user paths', () => {
  const home = path.join(os.tmpdir(), 'mcpc-home');
  const root = path.join(os.tmpdir(), 'mcpc-workspace');
  const wsid = '0123456789abcdef';
  const files = configFiles({ home, root, wsid });

  assert.deepEqual(files, {
    local: path.resolve(home, 'projects', wsid, 'config.json'),
    project: path.resolve(root, '.mcp.json'),
    user: path.resolve(home, 'config.json'),
  });
  for (const file of Object.values(files)) assert.ok(path.isAbsolute(file));
});

test('endpointFor returns a Windows named pipe', () => {
  assert.equal(
    endpointFor('C:\\Users\\me\\.mcpc', 'abc123', { platform: 'win32' }),
    '\\\\.\\pipe\\mcpc-abc123',
  );
});

test('endpointFor returns a POSIX socket path when it fits', () => {
  assert.equal(
    endpointFor('/home/me/.mcpc', 'abc123', { platform: 'linux', tmpdir: '/tmp', uid: 1000 }),
    '/home/me/.mcpc/run/abc123.sock',
  );

  const fitting = `/${'a'.repeat(83)}`;
  const fittingPath = path.posix.join(fitting, 'run', 'abc123.sock');
  assert.equal(Buffer.byteLength(fittingPath), 100);
  assert.equal(
    endpointFor(fitting, 'abc123', { platform: 'linux', tmpdir: '/tmp', uid: 1000 }),
    fittingPath,
  );
});

test('endpointFor falls back when the POSIX socket path exceeds 100 bytes', () => {
  const tooLong = `/${'a'.repeat(84)}`;
  const primary = path.posix.join(tooLong, 'run', 'abc123.sock');
  assert.ok(Buffer.byteLength(primary) > 100);

  assert.equal(
    endpointFor(tooLong, 'abc123', { platform: 'linux', tmpdir: '/tmp', uid: 1000 }),
    path.posix.join('/tmp', 'mcpc-1000', 'abc123.sock'),
  );
});

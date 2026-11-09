// Installer core and install scripts, against a local release repository and a
// fake npm. Every child process gets a throwaway HOME and USERPROFILE, so no
// real harness, global npm prefix or network is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InstallError,
  compareVersions,
  isOurSkill,
  packageVersion,
  parseTag,
  readRecord,
  runUpdate,
  sync,
  upgrade,
} from '../lib/install.mjs';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('./helpers/fake-npm/npm-cli.js', import.meta.url));
const RELEASE_FILES = [
  'package.json',
  'bin',
  'lib',
  'scripts',
  'skill',
  'installer.sh',
  'installer.ps1',
];
const GIT_CONFIG = [
  '-c',
  'user.name=mcpc tests',
  '-c',
  'user.email=tests@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

const git = (cwd, ...args) =>
  execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function setVersion(dir, version) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** A temporary home, a release repository with tag v0.1.0, and a fake npm environment. */
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  for (const entry of RELEASE_FILES)
    fs.cpSync(path.join(PROJECT, entry), path.join(work, entry), { recursive: true });
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n');
  setVersion(work, '0.1.0');
  git(work, 'init', '--quiet');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'release 0.1.0');
  git(work, 'tag', 'v0.1.0');
  const origin = path.join(base, 'origin.git');
  git(base, 'clone', '--quiet', '--bare', work, origin);

  const publish = (version, change) => {
    setVersion(work, version);
    change?.(work);
    git(work, 'commit', '--quiet', '-am', `release ${version}`);
    git(work, 'tag', `v${version}`);
    git(work, 'push', '--quiet', '--tags', origin, 'HEAD:main');
  };
  const clone = (tag = 'v0.1.0', dir = path.join(base, 'app')) => {
    git(base, '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--branch', tag, origin, dir);
    return dir;
  };

  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const npmRoot = path.join(base, 'npm-global');
  const npmLog = path.join(base, 'npm.log');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_execpath: FAKE_NPM,
    MCPC_FAKE_NPM_ROOT: npmRoot,
    MCPC_FAKE_NPM_LOG: npmLog,
    MCPC_INSTALL_REPO: origin,
  };
  delete env.MCPC_HOME;
  const npmCalls = () =>
    fs.existsSync(npmLog)
      ? fs
          .readFileSync(npmLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).args[0])
      : [];
  const linkTarget = () => fs.realpathSync.native(path.join(npmRoot, 'mcpc'));
  return { base, work, origin, publish, clone, home, env, npmRoot, npmCalls, linkTarget };
}

const samePath = (a, b) => {
  const norm = (p) => {
    const resolved = fs.realpathSync.native(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
};

test('parseTag accepts stable release tags only; compareVersions orders them', () => {
  assert.deepEqual(parseTag('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseTag('10.0.1'), [10, 0, 1]);
  for (const tag of ['v1.2.3-rc.1', 'v1.2', 'release-1.2.3', '', undefined])
    assert.equal(parseTag(tag), null);
  assert.ok(compareVersions([0, 10, 0], [0, 9, 9]) > 0);
  assert.ok(compareVersions([1, 0, 0], [1, 0, 1]) < 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('upgrade fast-forwards a clean checkout to a newer release only', (t) => {
  const { publish, clone, base } = setup(t);
  const app = clone();

  assert.deepEqual(upgrade(app), {
    changed: false,
    current: '0.1.0',
    latest: '0.1.0',
    version: '0.1.0',
  });

  publish('0.2.0');
  const result = upgrade(app);
  assert.equal(result.changed, true);
  assert.equal(result.current, '0.1.0');
  assert.equal(result.version, '0.2.0');
  assert.equal(packageVersion(app), '0.2.0');

  publish('0.3.0');
  fs.writeFileSync(path.join(app, 'stray.txt'), 'local change');
  assert.throws(
    () => upgrade(app),
    (error) => error instanceof InstallError && /local changes/.test(error.message),
  );

  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'package.json'), '{"name":"mcpc","version":"0.1.0"}');
  assert.throws(() => upgrade(plain), /not a Git checkout/);
});

test('sync installs dependencies, links the command and records the skill', (t) => {
  const { clone, home, env, base, npmCalls, linkTarget } = setup(t);
  const app = clone();
  const lines = [];
  const log = (kind, message, detail) => lines.push(`${kind} ${message} ${detail ?? ''}`);

  const first = sync({ root: app, home, env, log });
  const claudeSkill = path.join(home, '.claude', 'skills', 'mcp-client');
  assert.deepEqual(first.installed, [claudeSkill]);
  assert.ok(isOurSkill(claudeSkill));
  assert.deepEqual(readRecord(path.join(home, '.mcpc', 'installed-skills.txt')), [claudeSkill]);
  assert.deepEqual(npmCalls(), ['ci', 'root', 'link']);
  assert.ok(samePath(linkTarget(), app));

  // Dependencies present and the link in place: nothing to reinstall or relink.
  sync({ root: app, home, env, log });
  assert.deepEqual(npmCalls(), ['ci', 'root', 'link', 'root']);

  // A different skill with the same name is left alone and not recorded.
  const other = path.join(base, 'other-skills');
  fs.mkdirSync(path.join(other, 'mcp-client'), { recursive: true });
  fs.writeFileSync(path.join(other, 'mcp-client', 'SKILL.md'), '---\nname: something-else\n---\n');
  const second = sync({ root: app, home, env, log, skillsDirs: [other] });
  assert.ok(!second.installed.some((entry) => entry.startsWith(other)));
  assert.match(
    fs.readFileSync(path.join(other, 'mcp-client', 'SKILL.md'), 'utf8'),
    /something-else/,
  );
  assert.ok(lines.some((line) => line.startsWith('warn Another skill')));

  // recordedOnly keeps to the record even when another harness appears.
  fs.mkdirSync(path.join(home, '.codex'));
  sync({ root: app, home, env, log, recordedOnly: true });
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'mcp-client')));
  sync({ root: app, home, env, log });
  assert.ok(isOurSkill(path.join(home, '.agents', 'skills', 'mcp-client')));
});

test('runUpdate upgrades the checkout, then finishes with the new code', (t) => {
  const { publish, clone, home, env, npmCalls } = setup(t);
  const app = clone();
  sync({ root: app, home, env });
  const skill = path.join(home, '.claude', 'skills', 'mcp-client', 'SKILL.md');

  publish('0.2.0', (work) =>
    fs.appendFileSync(
      path.join(work, 'skill', 'mcp-client', 'SKILL.md'),
      '\n<!-- release 0.2.0 -->\n',
    ),
  );
  const out = [];
  const result = runUpdate({ root: app, env, out: (line) => out.push(line) });
  assert.equal(result.changed, true);
  assert.ok(out.includes('Updated the checkout from 0.1.0 to 0.2.0.'), out.join('\n'));
  assert.ok(
    out.some((line) => line.includes('Installed the mcp-client skill')),
    out.join('\n'),
  );
  assert.match(fs.readFileSync(skill, 'utf8'), /release 0\.2\.0/);
  assert.equal(npmCalls().filter((call) => call === 'ci').length, 2);

  const again = [];
  runUpdate({ root: app, env, out: (line) => again.push(line) });
  assert.deepEqual(again, ['mcpc 0.2.0 is up to date (latest release 0.2.0).']);
});

/** Shells that run an installer script here: PowerShell on Windows, bash elsewhere and in Git Bash. */
function shells(base) {
  const fakeBin = path.join(base, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'npm.cmd'), `@"${process.execPath}" "${FAKE_NPM}" %*\r\n`);
  fs.writeFileSync(
    path.join(fakeBin, 'npm'),
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_NPM}" "$@"\n`,
    { mode: 0o755 },
  );
  const list = [];
  if (process.platform === 'win32')
    list.push({
      name: 'PowerShell',
      script: 'installer.ps1',
      run: (script, args, options) =>
        spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
          options,
        ),
    });
  if (process.platform !== 'win32' || process.env.MSYSTEM)
    list.push({
      name: 'bash',
      script: 'installer.sh',
      run: (script, args, options) => spawnSync('bash', [script, ...args], options),
    });
  return { fakeBin, list };
}

test('installer scripts install, reinstall and uninstall', async (t) => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-shells-'));
  const names = shells(probe).list.map((shell) => shell.name);
  fs.rmSync(probe, { recursive: true, force: true });

  for (const name of names)
    await t.test(name, (t) => {
      const { base, home, env, npmRoot } = setup(t);
      const shell = shells(base).list.find((entry) => entry.name === name);
      const download = path.join(base, 'download');
      fs.mkdirSync(download);
      const script = path.join(download, shell.script);
      fs.copyFileSync(path.join(PROJECT, shell.script), script);
      const runEnv = {
        ...env,
        PATH: [shells(base).fakeBin, path.dirname(process.execPath), env.PATH ?? env.Path].join(
          path.delimiter,
        ),
      };
      delete runEnv.Path;
      const run = (...args) => {
        const result = shell.run(script, args, { env: runEnv, encoding: 'utf8', timeout: 180000 });
        return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
      };

      const help = run('--help');
      assert.equal(help.status, 0, help.output);
      assert.match(help.output, /mcpc installer/);
      assert.equal(run('frobnicate').status, 1);

      const app = path.join(home, '.mcpc', 'app');
      const record = path.join(home, '.mcpc', 'installed-skills.txt');
      const claudeSkill = path.join(home, '.claude', 'skills', 'mcp-client');

      const installed = run('install');
      assert.equal(installed.status, 0, installed.output);
      assert.match(installed.output, /Cloned mcpc v0\.1\.0/);
      assert.equal(packageVersion(app), '0.1.0');
      assert.ok(isOurSkill(claudeSkill), installed.output);
      assert.ok(samePath(fs.realpathSync.native(path.join(npmRoot, 'mcpc')), app));

      const again = run();
      assert.equal(again.status, 0, again.output);
      assert.match(again.output, /Found mcpc/);

      const extra = path.join(base, 'extra-skills');
      const withOther = run('install', 'other', extra);
      assert.equal(withOther.status, 0, withOther.output);
      assert.ok(isOurSkill(path.join(extra, 'mcp-client')));
      assert.equal(readRecord(record).length, 2);

      const removeOther = run('uninstall', 'other', extra);
      assert.equal(removeOther.status, 0, removeOther.output);
      assert.ok(!fs.existsSync(path.join(extra, 'mcp-client')));
      assert.equal(readRecord(record).length, 1);

      fs.mkdirSync(path.join(home, '.mcpc', 'projects'), { recursive: true });
      const removed = run('uninstall');
      assert.equal(removed.status, 0, removed.output);
      assert.ok(!fs.existsSync(claudeSkill));
      assert.ok(!fs.existsSync(app));
      assert.ok(!fs.existsSync(record));
      assert.ok(!fs.existsSync(path.join(npmRoot, 'mcpc')));
      assert.ok(fs.existsSync(path.join(home, '.mcpc', 'projects')), 'configuration stays');
    });
});

test('without a reachable release, install keeps the checkout and update fails', (t) => {
  const { base, clone, home, env, linkTarget } = setup(t);
  const app = clone();
  const empty = path.join(base, 'empty.git');
  git(base, 'init', '--quiet', '--bare', empty);
  git(app, 'remote', 'set-url', 'origin', empty);

  assert.throws(
    () => upgrade(app),
    (error) =>
      error instanceof InstallError && error.unreachable && /no release/.test(error.message),
  );
  assert.throws(() => runUpdate({ root: app, env }), /no release/);

  const result = spawnSync(
    process.execPath,
    [path.join(app, 'scripts', 'installer.mjs'), 'install'],
    {
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cannot check for a newer release/);
  assert.ok(isOurSkill(path.join(home, '.claude', 'skills', 'mcp-client')));
  assert.ok(samePath(linkTarget(), app));
});

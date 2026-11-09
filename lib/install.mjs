// Installer core shared by installer.sh / installer.ps1 (through
// scripts/installer.mjs) and `mcpc update`: moving a Git checkout to the latest
// release tag, installing its dependencies, linking the global `mcpc` command
// to it, and copying the mcp-client skill into agent harnesses.
//
// Only Node built-ins are imported here, so the core runs before the checkout's
// dependencies are installed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the checkout this module belongs to. */
export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SKILL_NAME = 'mcp-client';

const SKILL_MARK = /^name:\s*mcp-client\s*$/m;
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const LEADING_VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * An installation step failed; `fix` is the command or action to suggest.
 * `unreachable` marks a failure to learn the latest release (offline, or no
 * release published yet), which an install can work around.
 */
export class InstallError extends Error {
  constructor(message, fix, { unreachable = false } = {}) {
    super(message);
    this.name = 'InstallError';
    this.code = 'install_failed';
    this.fix = fix;
    this.unreachable = unreachable;
  }
}

/**
 * Installer locations: the managed checkout and the record of installed skills.
 * They always live in `~/.mcpc`, whatever `MCPC_HOME` says, so an update finds
 * them even when the configuration directory has moved.
 *
 * @param {string} [home]
 */
export function installPaths(home = os.homedir()) {
  const state = path.join(home, '.mcpc');
  return {
    state,
    app: path.join(state, 'app'),
    record: path.join(state, 'installed-skills.txt'),
  };
}

/** Skills directories of the harnesses the installer knows by name. */
export function harnessDirs(home = os.homedir()) {
  return {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.agents', 'skills'),
  };
}

/** Skills directories of the known harnesses present in `home`. */
export function detectHarnesses(home = os.homedir()) {
  const dirs = harnessDirs(home);
  const has = (name) => fs.existsSync(path.join(home, name));
  return [
    ...(has('.claude') ? [dirs.claude] : []),
    ...(has('.agents') || has('.codex') ? [dirs.codex] : []),
  ];
}

/** `[major, minor, patch]` of a stable release tag such as `v1.2.3`, or null. */
export function parseTag(tag) {
  const match = STABLE_TAG.exec(String(tag ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** `[major, minor, patch]` at the start of a version (prerelease ignored), or null. */
function parseVersion(version) {
  const match = LEADING_VERSION.exec(String(version ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Negative, zero or positive as version `a` is lower than, equal to or higher than `b`. */
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

const lastLine = (text) =>
  String(text ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop() ?? '';

function canonical(file) {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const samePath = (a, b) => canonical(a) === canonical(b);

function run(command, args, { cwd, env, timeout = 300000 } = {}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(root, args, { env, fix } = {}) {
  const result = run('git', ['-C', root, ...args], { env });
  if (result.error)
    throw new InstallError(
      `cannot run git: ${result.error.message}`,
      'install Git, then reopen the terminal',
    );
  if (result.status !== 0)
    throw new InstallError(
      `git ${args[0]} failed: ${lastLine(result.stderr) || `exit ${result.status}`}`,
      fix,
    );
  return result.stdout;
}

/** Version in a checkout's package.json. */
export function packageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/**
 * Highest stable release tag on the checkout's `origin`, or null when there is none.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 */
export function latestRelease(root, env) {
  let listing;
  try {
    listing = git(root, ['ls-remote', '--tags', '--refs', 'origin'], {
      env,
      fix: `check network access and the remote: git -C "${root}" remote -v`,
    });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  let best = null;
  for (const line of listing.split(/\r?\n/)) {
    const tag = line.split('refs/tags/')[1]?.trim();
    const version = parseTag(tag);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version };
  }
  return best && { tag: best.tag, version: best.version.join('.') };
}

/**
 * Fast-forward a clean checkout to the latest release when that release is newer.
 *
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{changed: boolean, current: string, latest: string, version: string}}
 */
export function upgrade(root, { env } = {}) {
  let top = null;
  try {
    top = git(root, ['rev-parse', '--show-toplevel'], { env }).trim();
  } catch {}
  if (!top || !samePath(top, root))
    throw new InstallError(
      `${root} is not a Git checkout, so it cannot update itself`,
      'install mcpc with the installer script (see the README), then update with mcpc update',
    );

  const current = packageVersion(root);
  const latest = latestRelease(root, env);
  if (!latest)
    throw new InstallError(
      'no release was found on origin',
      `git -C "${root}" ls-remote --tags origin`,
      { unreachable: true },
    );
  const installed = parseVersion(current);
  if (installed && compareVersions(parseTag(latest.version), installed) <= 0)
    return { changed: false, current, latest: latest.version, version: current };

  const status = git(root, ['status', '--porcelain', '--untracked-files=all'], { env });
  if (status.trim())
    throw new InstallError(
      `${root} has local changes; commit or remove them before updating`,
      `git -C "${root}" status --short`,
    );
  git(root, ['fetch', '--quiet', '--tags', 'origin'], {
    env,
    fix: `git -C "${root}" fetch --tags origin`,
  });
  git(root, ['merge', '--ff-only', '--quiet', `refs/tags/${latest.tag}`], {
    env,
    fix: `the history has diverged; inspect it with git -C "${root}" log --oneline --graph --all`,
  });
  return { changed: true, current, latest: latest.version, version: packageVersion(root) };
}

/** Path of npm's own entry script, so npm runs under this Node without a shell. */
export function npmCli(env = process.env) {
  const searchPath = env.PATH ?? env.Path ?? '';
  const dirs = [
    ...new Set([
      path.dirname(process.execPath),
      ...searchPath.split(path.delimiter).filter(Boolean),
    ]),
  ];
  const candidates = [
    env.npm_execpath,
    ...dirs.flatMap((dir) => [
      path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]),
  ];
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new InstallError('cannot find npm', 'install Node.js with npm, then reopen the terminal');
}

function npm(args, { cwd, env }) {
  const result = run(process.execPath, [npmCli(env), ...args], { cwd, env, timeout: 900000 });
  if (result.error || result.status !== 0)
    throw new InstallError(
      `npm ${args[0]} failed: ${
        lastLine(result.stderr) ||
        lastLine(result.stdout) ||
        result.error?.message ||
        `exit ${result.status}`
      }`,
      `cd "${cwd}" && npm ${args.join(' ')}`,
    );
  return result.stdout;
}

/** Install the checkout's runtime dependencies exactly as locked. */
export function installDependencies(root, { env } = {}) {
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env });
}

/**
 * Point the global `mcpc` command at the checkout.
 *
 * @returns {{changed: boolean, replaced: string | null}}
 */
export function linkCommand(root, { env } = {}) {
  const linkArgs = [
    'link',
    '--offline',
    '--ignore-scripts',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
  ];
  const globalRoot = lastLine(npm(['root', '--global'], { cwd: root, env }));
  // npm masks anything shaped like a UUID in its output as "***", so a global
  // directory with one in its path cannot be inspected; linking again is harmless.
  if (globalRoot.includes('***')) {
    npm(linkArgs, { cwd: root, env });
    return { changed: true, replaced: null };
  }
  const link = path.join(globalRoot, 'mcpc');
  let existing = null;
  try {
    existing = fs.realpathSync.native(link);
  } catch {}
  if (existing && samePath(existing, root)) return { changed: false, replaced: null };
  if (existing)
    npm(['uninstall', '--global', '--ignore-scripts', '--no-audit', '--no-fund', 'mcpc'], {
      cwd: root,
      env,
    });
  npm(linkArgs, { cwd: root, env });
  if (!samePath(link, root))
    throw new InstallError(
      'npm link did not point the global mcpc command at this checkout',
      `cd "${root}" && npm link`,
    );
  return { changed: true, replaced: existing };
}

/** Whether `dir` holds the mcp-client skill (and not another skill with that name). */
export function isOurSkill(dir) {
  try {
    return SKILL_MARK.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  } catch {
    return false;
  }
}

/** Installed skill directories from the record. */
export function readRecord(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function uniquePaths(paths) {
  const seen = new Map();
  for (const entry of paths) {
    const key = canonical(entry);
    if (!seen.has(key)) seen.set(key, path.resolve(entry));
  }
  return [...seen.values()];
}

/** Write the record; an empty record is removed. */
export function writeRecord(file, entries) {
  const lines = uniquePaths(entries);
  if (!lines.length) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/**
 * Copy the checkout's skill into a skills directory, replacing an earlier copy.
 *
 * @returns {{destination: string, skipped: boolean}}
 */
export function copySkill(root, skillsDir) {
  const destination = path.join(skillsDir, SKILL_NAME);
  if (fs.existsSync(destination)) {
    if (!isOurSkill(destination)) return { destination, skipped: true };
    fs.rmSync(destination, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.cpSync(path.join(root, 'skill', SKILL_NAME), destination, { recursive: true });
  return { destination, skipped: false };
}

/**
 * Finish an install or update with this checkout's code: dependencies, the
 * global command, and the skill in every chosen harness.
 *
 * Harnesses are the `skillsDirs` given, plus the recorded ones, plus (unless
 * `recordedOnly`, or when `skillsDirs` names any) the known harnesses present.
 *
 * @param {object} options
 * @param {string} [options.root]
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.skillsDirs]
 * @param {boolean} [options.recordedOnly]
 * @param {boolean} [options.freshDependencies] Reinstall dependencies even when present.
 * @param {(kind: 'ok' | 'warn', message: string, detail?: string) => void} [options.log]
 */
export function sync({
  root = APP_ROOT,
  home = os.homedir(),
  env = process.env,
  skillsDirs = [],
  recordedOnly = false,
  freshDependencies = false,
  log = () => {},
} = {}) {
  if (freshDependencies || !fs.existsSync(path.join(root, 'node_modules'))) {
    installDependencies(root, { env });
    log('ok', 'Installed dependencies');
  }

  const link = linkCommand(root, { env });
  if (link.replaced) log('warn', 'Replaced the global mcpc command', `was ${link.replaced}`);
  log(
    'ok',
    link.changed
      ? 'Linked the mcpc command to this checkout'
      : 'The mcpc command uses this checkout',
    root,
  );

  const { record } = installPaths(home);
  const recorded = readRecord(record);
  const dirs = uniquePaths([
    ...skillsDirs,
    ...recorded.map((entry) => path.dirname(entry)),
    ...(recordedOnly || skillsDirs.length ? [] : detectHarnesses(home)),
  ]);
  if (!dirs.length && !recordedOnly)
    log(
      'warn',
      'No agent harness found, so the skill was not installed',
      'run the installer again with: other <SKILLS_DIR>',
    );

  const installed = [];
  for (const dir of dirs) {
    const { destination, skipped } = copySkill(root, dir);
    if (skipped)
      log('warn', 'Another skill already uses the name mcp-client; left it in place', destination);
    else {
      installed.push(destination);
      log('ok', 'Installed the mcp-client skill', destination);
    }
  }
  writeRecord(record, [...recorded.filter((entry) => isOurSkill(entry)), ...installed]);
  return { installed, linked: link.changed };
}

/**
 * `mcpc update`: upgrade the checkout, then finish with the new code in a child
 * process, because this process still runs the old modules.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(line: string) => void} [options.out]
 */
export function runUpdate({ root = APP_ROOT, env = process.env, out = () => {} } = {}) {
  const result = upgrade(root, { env });
  if (!result.changed) {
    out(`mcpc ${result.current} is up to date (latest release ${result.latest}).`);
    return result;
  }
  out(`Updated the checkout from ${result.current} to ${result.version}.`);
  const installer = path.join(root, 'scripts', 'installer.mjs');
  const child = run(process.execPath, [installer, 'sync', '--recorded', '--fresh'], {
    cwd: root,
    env,
    timeout: 900000,
  });
  for (const line of String(child.stdout ?? '').split(/\r?\n/))
    if (line.trim()) out(line.trimEnd());
  if (child.error || child.status !== 0)
    throw new InstallError(
      `finishing the update failed: ${lastLine(child.stderr) || child.error?.message || `exit ${child.status}`}`,
      `node "${installer}" sync --recorded --fresh`,
    );
  return result;
}

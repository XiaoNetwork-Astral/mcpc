import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOCKET_PATH_LIMIT = 100;

/**
 * Return the MCPC home directory.
 *
 * `MCPC_HOME` wins when it is set and non-empty; otherwise `~/.mcpc` is used.
 *
 * @param {Record<string, string | undefined>} [env] Environment variables.
 * @returns {string} Absolute path of the MCPC home directory.
 */
export function mcpcHome(env = {}) {
  return env.MCPC_HOME ? path.resolve(env.MCPC_HOME) : path.join(os.homedir(), '.mcpc');
}

/**
 * Find the workspace root for the current invocation.
 *
 * The order is: an explicit `--cwd` value, `MCPC_PROJECT_DIR`, the nearest
 * ancestor containing `.mcp.json`, the nearest ancestor containing `.git`
 * (file or directory), and finally `cwd` itself.
 *
 * @param {{cwd?: string, env?: Record<string, string | undefined>, explicit?: string}} [options]
 *   Search options. `cwd` defaults to `process.cwd()`, `env` to `{}`.
 * @returns {string} Absolute workspace root path.
 */
export function findWorkspaceRoot({ cwd = process.cwd(), env = {}, explicit } = {}) {
  const start = path.resolve(cwd);
  if (explicit) return path.resolve(start, explicit);
  if (env.MCPC_PROJECT_DIR) return path.resolve(start, env.MCPC_PROJECT_DIR);

  const projectRoot = findUp(start, '.mcp.json');
  if (projectRoot !== undefined) return projectRoot;

  const gitRoot = findUp(start, '.git');
  if (gitRoot !== undefined) return gitRoot;

  return start;
}

/**
 * Derive the workspace id.
 *
 * The id is the first 16 hex characters of the SHA-256 of the absolute root
 * path. On Windows the path is lowercased before hashing so that differently
 * cased spellings of the same directory share an id.
 *
 * @param {string} root Workspace root path.
 * @param {NodeJS.Platform | string} [platform] Platform to use, defaults to `process.platform`.
 * @returns {string} 16 lowercase hex characters.
 */
export function workspaceId(root, platform = process.platform) {
  let resolved = path.resolve(root);
  if (platform === 'win32') resolved = resolved.toLowerCase();
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

/**
 * Build the daemon key for a workspace.
 *
 * When `MCPC_SESSION` is set, the key gains a `-<first 8 hex>` suffix derived
 * from the session value, so concurrent sessions get separate daemons.
 *
 * @param {string} wsid Workspace id.
 * @param {Record<string, string | undefined>} [env] Environment variables.
 * @returns {string} Daemon key.
 */
export function daemonKey(wsid, env = {}) {
  const session = env.MCPC_SESSION;
  if (!session) return wsid;
  const suffix = createHash('sha256').update(String(session)).digest('hex').slice(0, 8);
  return `${wsid}-${suffix}`;
}

/**
 * Directory holding one workspace's private state.
 *
 * @param {string} home MCPC home directory.
 * @param {string} wsid Workspace id.
 * @returns {string} Absolute project directory path.
 */
export function projectDir(home, wsid) {
  return path.join(home, 'projects', wsid);
}

/**
 * Path of a workspace's approvals file.
 *
 * @param {string} home MCPC home directory.
 * @param {string} wsid Workspace id.
 * @returns {string} Absolute path of `approvals.json`.
 */
export function approvalsFile(home, wsid) {
  return path.join(projectDir(home, wsid), 'approvals.json');
}

/**
 * Path of a server's catalog cache file.
 *
 * @param {string} home MCPC home directory.
 * @param {string} wsid Workspace id.
 * @param {string} server Server name.
 * @returns {string} Absolute path of `cache/<server>.json`.
 */
export function cacheFile(home, wsid, server) {
  return path.join(projectDir(home, wsid), 'cache', `${server}.json`);
}

/**
 * Path of a workspace's saved call results directory.
 *
 * @param {string} home MCPC home directory.
 * @param {string} wsid Workspace id.
 * @returns {string} Absolute path of `results/`.
 */
export function resultsDir(home, wsid) {
  return path.join(projectDir(home, wsid), 'results');
}

/**
 * Path of a workspace's log directory.
 *
 * @param {string} home MCPC home directory.
 * @param {string} wsid Workspace id.
 * @returns {string} Absolute path of `logs/`.
 */
export function logsDir(home, wsid) {
  return path.join(projectDir(home, wsid), 'logs');
}

/**
 * Compute the three configuration file paths for a workspace.
 *
 * @param {{home: string, root: string, wsid: string}} options Path inputs.
 * @returns {{local: string, project: string, user: string}} Absolute config paths.
 */
export function configFiles({ home, root, wsid }) {
  return {
    local: path.resolve(projectDir(home, wsid), 'config.json'),
    project: path.resolve(root, '.mcp.json'),
    user: path.resolve(home, 'config.json'),
  };
}

/**
 * Compute the CLI-to-daemon endpoint for a daemon key.
 *
 * Windows uses a named pipe. POSIX uses `$MCPC_HOME/run/<key>.sock`, falling
 * back to `os.tmpdir()/mcpc-<uid>/<key>.sock` when the primary socket path
 * exceeds 100 bytes.
 *
 * @param {string} home MCPC home directory.
 * @param {string} key Daemon key.
 * @param {{platform?: string, tmpdir?: string, uid?: number}} [options] Test seams.
 * @returns {string} Pipe name or socket path.
 */
export function endpointFor(home, key, options = {}) {
  const {
    platform = process.platform,
    tmpdir = os.tmpdir(),
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
  } = options;

  if (platform === 'win32') return `\\\\.\\pipe\\mcpc-${key}`;

  const primary = path.posix.join(home, 'run', `${key}.sock`);
  if (Buffer.byteLength(primary, 'utf8') <= SOCKET_PATH_LIMIT) return primary;

  return path.posix.join(tmpdir, `mcpc-${uid}`, `${key}.sock`);
}

/**
 * Walk from `start` towards the filesystem root looking for `entryName`.
 *
 * @param {string} start Absolute directory to start from.
 * @param {string} entryName Entry to look for.
 * @returns {string | undefined} Directory containing the entry, if any.
 */
function findUp(start, entryName) {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, entryName))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

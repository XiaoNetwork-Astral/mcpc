import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_TYPES = new Set(['stdio', 'http', 'sse', 'ws']);
const REMOTE_TYPES = new Set(['http', 'sse', 'ws']);
const TYPE_ALIASES = {
  'streamable-http': 'http',
  websocket: 'ws',
};
const KNOWN_FIELDS = new Set([
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'headersHelper',
  'oauth',
  'timeout',
  'startupTimeout',
  'alwaysLoad',
  'disabled',
  'tools',
]);
const FIELDS_NOT_APPLICABLE = {
  stdio: ['url', 'headers', 'headersHelper', 'oauth'],
  http: ['command', 'args', 'env', 'cwd'],
  sse: ['command', 'args', 'env', 'cwd'],
  ws: ['command', 'args', 'env', 'cwd', 'oauth'],
};
const EXPANSION_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Variable names whose values are treated as secrets wherever they are substituted. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION/i;

/**
 * Expand `${VAR}` and `${VAR:-default}` references in a string.
 *
 * Empty values count as set, unset names without a default keep their literal
 * `${VAR}` text, and `$${VAR}` is not an escape (it expands with a leading
 * dollar sign).
 *
 * @param {string} str Input string. Non-strings are returned unchanged.
 * @param {Record<string, string | undefined>} [env] Environment variables.
 * @returns {{value: string, missing: string[], used: string[]}} Expansion result.
 */
export function expandString(str, env = {}) {
  const { value, missing, used } = expandInternal(str, env);
  return { value, missing, used };
}

/**
 * Read and parse one JSON configuration file.
 *
 * A missing file yields `{data: null, mtimeMs: 0, exists: false}`. Invalid JSON
 * keeps `exists: true` and adds an `error` that names the file. Other read
 * failures also produce an `error`.
 *
 * @param {string} file Absolute file path.
 * @returns {{data: unknown, mtimeMs: number, exists: boolean, error?: string}} Parse result.
 */
export function readConfigFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { data: null, mtimeMs: 0, exists: false };
    return {
      data: null,
      mtimeMs: 0,
      exists: false,
      error: `cannot read ${file}: ${error.message}`,
    };
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      data: null,
      mtimeMs: stat.mtimeMs,
      exists: true,
      error: `cannot read ${file}: ${error.message}`,
    };
  }

  try {
    return { data: JSON.parse(text), mtimeMs: stat.mtimeMs, exists: true };
  } catch (error) {
    return {
      data: null,
      mtimeMs: stat.mtimeMs,
      exists: true,
      error: `invalid JSON in ${file}: ${error.message}`,
    };
  }
}

/**
 * Validate one raw server configuration.
 *
 * Returns every validation error and warning found. `type` is the normalized
 * transport (`stdio`, `http`, `sse`, `ws`) when it can be determined.
 *
 * @param {string} name Server name.
 * @param {unknown} raw Raw server configuration.
 * @returns {{errors: string[], warnings: string[], type: string | undefined}} Validation result.
 */
export function validateServer(name, raw) {
  const errors = [];
  const warnings = [];
  let type;

  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    errors.push('server name must match ^[A-Za-z0-9_-]{1,64}$');
  }
  if (typeof name === 'string' && name.includes('__')) {
    errors.push('server name must not contain "__"');
  }
  if (!isPlainObject(raw)) {
    errors.push('server config must be an object');
    return { errors, warnings, type: undefined };
  }

  if (raw.type !== undefined) {
    if (typeof raw.type !== 'string') {
      errors.push('server "type" must be a string');
    } else {
      const normalized = normalizeType(raw.type);
      if (SERVER_TYPES.has(normalized)) type = normalized;
      else errors.push(`unknown server type "${raw.type}"`);
    }
  } else if (raw.url !== undefined) {
    errors.push('"url" requires an explicit "type"');
  } else if (raw.command !== undefined) {
    type = 'stdio';
  } else {
    errors.push('server config needs a "type" or a "command"');
  }

  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.length === 0) {
      errors.push('stdio server requires a non-empty string "command"');
    }
  } else if (raw.command !== undefined && typeof raw.command !== 'string') {
    errors.push('"command" must be a string');
  }

  if (type !== undefined && REMOTE_TYPES.has(type)) {
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      errors.push(`${type} server requires a non-empty string "url"`);
    }
  } else if (raw.url !== undefined && typeof raw.url !== 'string') {
    errors.push('"url" must be a string');
  }

  if (raw.args !== undefined && !isStringArray(raw.args)) {
    errors.push('"args" must be an array of strings');
  }
  if (raw.env !== undefined && !isStringMap(raw.env)) {
    errors.push('"env" must be an object of strings');
  }
  if (raw.headers !== undefined && !isStringMap(raw.headers)) {
    errors.push('"headers" must be an object of strings');
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
    errors.push('"cwd" must be a string');
  }
  if (raw.headersHelper !== undefined && typeof raw.headersHelper !== 'string') {
    errors.push('"headersHelper" must be a string');
  }
  if (raw.timeout !== undefined && !isPositiveNumber(raw.timeout)) {
    errors.push('"timeout" must be a positive number');
  }
  if (raw.startupTimeout !== undefined && !isPositiveNumber(raw.startupTimeout)) {
    errors.push('"startupTimeout" must be a positive number');
  }
  if (raw.alwaysLoad !== undefined && typeof raw.alwaysLoad !== 'boolean') {
    errors.push('"alwaysLoad" must be a boolean');
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    errors.push('"disabled" must be a boolean');
  }

  if (raw.tools !== undefined) {
    if (!isPlainObject(raw.tools)) {
      errors.push('"tools" must be an object');
    } else {
      if (raw.tools.include !== undefined && !isStringArray(raw.tools.include)) {
        errors.push('"tools.include" must be an array of strings');
      }
      if (raw.tools.exclude !== undefined && !isStringArray(raw.tools.exclude)) {
        errors.push('"tools.exclude" must be an array of strings');
      }
    }
  }

  if (raw.oauth !== undefined && raw.oauth !== false) {
    if (!isPlainObject(raw.oauth)) {
      errors.push('"oauth" must be an object or false');
    } else {
      if (raw.oauth.clientId !== undefined && typeof raw.oauth.clientId !== 'string') {
        errors.push('"oauth.clientId" must be a string');
      }
      if (raw.oauth.clientSecret !== undefined && typeof raw.oauth.clientSecret !== 'string') {
        errors.push('"oauth.clientSecret" must be a string');
      }
      if (raw.oauth.scopes !== undefined && typeof raw.oauth.scopes !== 'string') {
        errors.push('"oauth.scopes" must be a string');
      }
      if (
        raw.oauth.callbackPort !== undefined &&
        !(Number.isInteger(raw.oauth.callbackPort) && raw.oauth.callbackPort > 0)
      ) {
        errors.push('"oauth.callbackPort" must be a positive integer');
      }
      if (
        raw.oauth.authServerMetadataUrl !== undefined &&
        (typeof raw.oauth.authServerMetadataUrl !== 'string' ||
          !/^https:\/\//i.test(raw.oauth.authServerMetadataUrl))
      ) {
        errors.push('"oauth.authServerMetadataUrl" must be an https URL');
      }
    }
  }

  for (const field of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(field)) warnings.push(`unknown field "${field}"`);
  }
  if (hasSurroundingWhitespace(raw.command)) {
    warnings.push('"command" has leading or trailing whitespace');
  }
  if (hasSurroundingWhitespace(raw.url)) {
    warnings.push('"url" has leading or trailing whitespace');
  }
  if (Array.isArray(raw.args)) {
    raw.args.forEach((item, index) => {
      if (hasSurroundingWhitespace(item)) {
        warnings.push(`"args[${index}]" has leading or trailing whitespace`);
      }
    });
  }
  if (isPlainObject(raw.env)) {
    for (const key of Object.keys(raw.env)) {
      if (key !== key.trim())
        warnings.push(`"env" key "${key}" has leading or trailing whitespace`);
    }
  }
  if (isPlainObject(raw.headers)) {
    for (const key of Object.keys(raw.headers)) {
      if (key !== key.trim()) {
        warnings.push(`"headers" key "${key}" has leading or trailing whitespace`);
      }
    }
  }
  if (
    typeof raw.timeout === 'number' &&
    Number.isFinite(raw.timeout) &&
    raw.timeout > 0 &&
    raw.timeout < 1000
  ) {
    warnings.push('"timeout" below 1000 ms is ignored');
  }
  if (type !== undefined && FIELDS_NOT_APPLICABLE[type]) {
    for (const field of FIELDS_NOT_APPLICABLE[type]) {
      if (raw[field] !== undefined) {
        warnings.push(`"${field}" does not apply to ${type} servers`);
      }
    }
  }

  return { errors, warnings, type };
}

/**
 * Expand, validate, and fingerprint one server configuration.
 *
 * @param {string} name Server name.
 * @param {unknown} raw Raw server configuration.
 * @param {{scope?: string, env?: Record<string, string | undefined>, root?: string}} [options]
 *   Resolution context.
 * @returns {{
 *   name: string,
 *   scope: string,
 *   type: string | undefined,
 *   raw: unknown,
 *   config: Record<string, unknown>,
 *   fingerprint: string,
 *   approvalFingerprint: string,
 *   secrets: string[],
 *   warnings: string[],
 *   errors: string[],
 * }} Resolved server.
 */
export function resolveServer(name, raw, { scope = 'local', env = {}, root } = {}) {
  const validation = validateServer(name, raw);
  const warnings = [...validation.warnings];
  const missingNames = new Set();
  const secrets = new Set();
  const config = isPlainObject(raw) ? { ...raw } : {};

  // Values substituted into `env` and `headers` are secrets; elsewhere (paths,
  // commands, URLs) only values of secret-looking variables are, so ordinary
  // paths stay readable in error messages.
  const expand = (value, sensitive = false) => {
    if (typeof value !== 'string') return value;
    const expanded = expandInternal(value, env);
    for (const missingName of expanded.missing) missingNames.add(missingName);
    for (const { name: varName, value: substituted } of expanded.pairs) {
      if (substituted.length >= 4 && (sensitive || SECRET_NAME.test(varName))) {
        secrets.add(substituted);
      }
    }
    return expanded.value;
  };

  if (typeof config.command === 'string') config.command = expand(config.command);
  if (typeof config.url === 'string') config.url = expand(config.url);
  if (typeof config.cwd === 'string') config.cwd = expand(config.cwd);
  if (typeof config.headersHelper === 'string') config.headersHelper = expand(config.headersHelper);
  if (Array.isArray(config.args)) {
    config.args = config.args.map((item) => (typeof item === 'string' ? expand(item) : item));
  }
  if (isPlainObject(config.env)) {
    config.env = Object.fromEntries(
      Object.entries(config.env).map(([key, value]) => [
        key,
        typeof value === 'string' ? expand(value, true) : value,
      ]),
    );
  }
  if (isPlainObject(config.headers)) {
    config.headers = Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [
        key,
        typeof value === 'string' ? expand(value, true) : value,
      ]),
    );
  }

  if (validation.type !== undefined) config.type = validation.type;
  if (validation.type === 'stdio' && config.cwd === undefined && root !== undefined) {
    config.cwd = root;
  }

  for (const missingName of missingNames) {
    warnings.push(`\${${missingName}} is not set`);
  }

  return {
    name,
    scope,
    type: validation.type,
    raw,
    config,
    fingerprint: sha256(canonicalStringify({ scope, config })),
    approvalFingerprint: sha256(canonicalStringify(raw)),
    secrets: [...secrets],
    warnings,
    errors: validation.errors,
  };
}

/**
 * Load and merge the local, project, and user configuration scopes.
 *
 * Precedence is local > project > user with no field merging. Missing files
 * are empty scopes; invalid JSON contributes nothing and is reported in
 * `errors`. Servers with validation errors are still returned.
 *
 * @param {{local?: string, project?: string, user?: string}} files Config file paths.
 * @param {{env?: Record<string, string | undefined>, root?: string}} [options] Resolution context.
 * @returns {{
 *   servers: Map<string, object>,
 *   permissions: {allow: string[], ask: string[], deny: string[]},
 *   warnings: string[],
 *   errors: string[],
 *   sources: Record<string, {path: string | undefined, mtimeMs: number, exists: boolean}>,
 * }} Loaded configuration.
 */
export function loadConfig(files = {}, { env = {}, root } = {}) {
  const scopes = ['local', 'project', 'user'];
  const dataByScope = {};
  const sources = {};
  const errors = [];
  const warnings = [];

  for (const scope of scopes) {
    const file = files[scope];
    if (!file) {
      sources[scope] = { path: file, mtimeMs: 0, exists: false };
      continue;
    }
    const result = readConfigFile(file);
    sources[scope] = { path: file, mtimeMs: result.mtimeMs, exists: result.exists };
    if (!result.exists) continue;
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    if (!isPlainObject(result.data)) {
      errors.push(`invalid config in ${file}: expected a JSON object`);
      continue;
    }
    dataByScope[scope] = result.data;
  }

  const collected = new Map();
  for (const scope of scopes) {
    const data = dataByScope[scope];
    if (data === undefined || data.mcpServers === undefined) continue;
    if (!isPlainObject(data.mcpServers)) {
      errors.push(`invalid config in ${files[scope]}: "mcpServers" must be an object`);
      continue;
    }
    for (const [name, raw] of Object.entries(data.mcpServers)) {
      if (collected.has(name)) continue;
      collected.set(name, resolveServer(name, raw, { scope, env, root }));
    }
  }

  const permissions = { allow: [], ask: [], deny: [] };
  for (const scope of ['local', 'user']) {
    const data = dataByScope[scope];
    if (data === undefined || data.permissions === undefined) continue;
    if (!isPlainObject(data.permissions)) {
      warnings.push(`permissions in ${scope} scope (${files[scope]}) must be an object`);
      continue;
    }
    for (const kind of ['allow', 'ask', 'deny']) {
      const list = data.permissions[kind];
      if (list === undefined) continue;
      if (!isStringArray(list)) {
        warnings.push(
          `permissions.${kind} in ${scope} scope (${files[scope]}) must be an array of strings`,
        );
        continue;
      }
      permissions[kind].push(...list);
    }
  }
  if (dataByScope.project !== undefined && dataByScope.project.permissions !== undefined) {
    warnings.push(`permissions in project scope (${files.project}) are ignored`);
  }

  const servers = new Map();
  for (const name of [...collected.keys()].sort()) {
    servers.set(name, collected.get(name));
  }

  return { servers, permissions, warnings, errors, sources };
}

/**
 * Build the server configuration object written by `mcpc add`.
 *
 * @param {{
 *   transport?: string,
 *   target?: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   headers?: Record<string, string>,
 *   timeout?: number,
 * }} [options] Server description.
 * @returns {Record<string, unknown>} Raw server configuration.
 */
export function buildServerConfig({
  transport = 'stdio',
  target,
  args,
  env,
  headers,
  timeout,
} = {}) {
  const type = normalizeType(transport);
  const config = {};

  if (type === 'stdio') {
    config.command = target;
    if (Array.isArray(args) && args.length > 0) config.args = [...args];
    if (isPlainObject(env) && Object.keys(env).length > 0) config.env = { ...env };
  } else {
    config.type = type;
    config.url = target;
    if (isPlainObject(headers) && Object.keys(headers).length > 0) {
      config.headers = { ...headers };
    }
  }

  if (timeout !== undefined) config.timeout = timeout;
  return config;
}

/**
 * Insert or replace one server in a configuration file.
 *
 * Existing JSON is preserved (other top-level keys and other servers). The
 * write is atomic: a temporary file in the same directory is renamed into
 * place. Output is two-space JSON with a trailing newline.
 *
 * @param {string} file Configuration file path.
 * @param {string} name Server name.
 * @param {unknown} cfg Raw server configuration.
 * @returns {Record<string, unknown>} The written data.
 */
export function writeServer(file, name, cfg) {
  const existing = readJsonFile(file);
  const data = existing === undefined ? {} : existing;
  if (!isPlainObject(data)) {
    throw new Error(`invalid config in ${file}: expected a JSON object`);
  }
  if (data.mcpServers === undefined) data.mcpServers = {};
  if (!isPlainObject(data.mcpServers)) {
    throw new Error(`invalid config in ${file}: "mcpServers" must be an object`);
  }
  data.mcpServers[name] = cfg;
  writeJsonFile(file, data);
  return data;
}

/**
 * Remove one server from a configuration file.
 *
 * Other keys and servers are preserved. The file is only rewritten when the
 * server existed.
 *
 * @param {string} file Configuration file path.
 * @param {string} name Server name.
 * @returns {boolean} `true` when a server was removed.
 */
export function removeServer(file, name) {
  const data = readJsonFile(file);
  if (data === undefined) return false;
  if (!isPlainObject(data) || !isPlainObject(data.mcpServers)) return false;
  if (!Object.prototype.hasOwnProperty.call(data.mcpServers, name)) return false;
  delete data.mcpServers[name];
  writeJsonFile(file, data);
  return true;
}

/**
 * Read the approvals file.
 *
 * A missing file yields `{servers: {}}`.
 *
 * @param {string} file Approvals file path.
 * @returns {{servers: Record<string, object>, [key: string]: unknown}} Approvals data.
 */
export function readApprovals(file) {
  const data = readJsonFile(file);
  if (data === undefined) return { servers: {} };
  if (!isPlainObject(data)) {
    throw new Error(`invalid approvals file ${file}: expected a JSON object`);
  }
  if (data.servers === undefined) data.servers = {};
  if (!isPlainObject(data.servers)) {
    throw new Error(`invalid approvals file ${file}: "servers" must be an object`);
  }
  return data;
}

/**
 * Store an approval or rejection decision for one server.
 *
 * @param {string} file Approvals file path.
 * @param {string} name Server name.
 * @param {string} approvalFingerprint Fingerprint of the approved raw config.
 * @param {'approved' | 'rejected'} decision Decision to store.
 * @returns {{servers: Record<string, object>, [key: string]: unknown}} Updated approvals data.
 */
export function setApproval(file, name, approvalFingerprint, decision) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error(`invalid approval decision "${decision}"`);
  }
  const data = readApprovals(file);
  data.servers[name] = {
    approvalFingerprint,
    decision,
    at: new Date().toISOString(),
  };
  writeJsonFile(file, data);
  return data;
}

/**
 * Determine the approval state of a server.
 *
 * Returns `'pending'` when there is no entry or when the stored fingerprint
 * does not match the server's current approval fingerprint.
 *
 * @param {{servers?: Record<string, object>} | undefined} approvals Approvals data.
 * @param {{name: string, approvalFingerprint: string} | string} server Resolved server or name.
 * @returns {'approved' | 'rejected' | 'pending'} Approval state.
 */
export function approvalState(approvals, server) {
  const name = typeof server === 'string' ? server : server?.name;
  if (typeof name !== 'string') return 'pending';

  const entry =
    isPlainObject(approvals) && isPlainObject(approvals.servers)
      ? approvals.servers[name]
      : undefined;
  if (!isPlainObject(entry)) return 'pending';

  if (typeof server !== 'string') {
    const fingerprint = server?.approvalFingerprint;
    if (typeof fingerprint !== 'string' || entry.approvalFingerprint !== fingerprint) {
      return 'pending';
    }
  }

  return entry.decision === 'approved' || entry.decision === 'rejected'
    ? entry.decision
    : 'pending';
}

/**
 * Evaluate a tool id against permission rules.
 *
 * Rule patterns are case-sensitive; `*` matches any run of characters except
 * `/`. A bare server pattern (or `server/*`) matches every tool of that
 * server. Precedence is deny > ask > allow > default allow, and a tool whose
 * `_meta` requires user interaction is `ask` unless denied.
 *
 * @param {{allow?: string[], ask?: string[], deny?: string[]} | undefined} permissions Permission rules.
 * @param {string} toolId `server/tool` id.
 * @param {Record<string, unknown> | undefined} [meta] Tool metadata.
 * @returns {'allow' | 'ask' | 'deny'} Permission decision.
 */
export function evaluatePermission(permissions, toolId, meta) {
  const rules = isPlainObject(permissions) ? permissions : {};
  const deny = Array.isArray(rules.deny) ? rules.deny : [];
  const ask = Array.isArray(rules.ask) ? rules.ask : [];
  const allow = Array.isArray(rules.allow) ? rules.allow : [];
  const id = typeof toolId === 'string' ? toolId : '';

  if (deny.some((pattern) => matchPattern(pattern, id))) return 'deny';
  if (ask.some((pattern) => matchPattern(pattern, id))) return 'ask';

  const requiresInteraction =
    meta?.['anthropic/requiresUserInteraction'] === true || meta?.requiresUserInteraction === true;
  if (requiresInteraction) return 'ask';

  if (allow.some((pattern) => matchPattern(pattern, id))) return 'allow';
  return 'allow';
}

/**
 * Replace secret values in a string with `***`.
 *
 * Secrets are replaced longest first so that a secret that contains another
 * secret is fully masked. Non-string input is returned unchanged.
 *
 * @param {unknown} text Text to redact.
 * @param {string[] | undefined} secrets Secret values.
 * @returns {unknown} Redacted text (or the original non-string value).
 */
export function redact(text, secrets) {
  if (typeof text !== 'string') return text;
  const ordered = (Array.isArray(secrets) ? secrets : [])
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of ordered) result = result.replaceAll(secret, '***');
  return result;
}

/**
 * Expand a string and report the substituted values as well as missing names.
 *
 * @param {unknown} str Input string.
 * @param {Record<string, string | undefined>} env Environment variables.
 * @returns {{value: unknown, missing: string[], used: string[], substituted: string[]}} Internal result.
 */
function expandInternal(str, env) {
  const missing = [];
  const used = [];
  const substituted = [];
  const pairs = [];
  if (typeof str !== 'string' || !str.includes('${')) {
    return { value: str, missing, used, substituted, pairs };
  }

  const value = str.replace(EXPANSION_PATTERN, (match, name, defaultValue) => {
    const hasDefault = defaultValue !== undefined;
    const present =
      env !== null &&
      typeof env === 'object' &&
      Object.prototype.hasOwnProperty.call(env, name) &&
      env[name] !== undefined;

    if (present) {
      const resolved = typeof env[name] === 'string' ? env[name] : String(env[name]);
      used.push(name);
      substituted.push(resolved);
      pairs.push({ name, value: resolved });
      return resolved;
    }
    if (hasDefault) {
      substituted.push(defaultValue);
      pairs.push({ name, value: defaultValue });
      return defaultValue;
    }
    missing.push(name);
    return match;
  });

  return {
    value,
    missing: [...new Set(missing)],
    used: [...new Set(used)],
    substituted,
    pairs,
  };
}

/**
 * Normalize a transport name through the supported aliases.
 *
 * @param {string} type Transport name.
 * @returns {string} Normalized transport name.
 */
function normalizeType(type) {
  return TYPE_ALIASES[type] ?? type;
}

/**
 * Check whether a value is a non-null, non-array object.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for plain objects.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check whether a value is an array of strings.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for string arrays.
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Check whether a value is an object whose values are all strings.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for string maps.
 */
function isStringMap(value) {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

/**
 * Check whether a value is a finite positive number.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for positive finite numbers.
 */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Check whether a string has leading or trailing whitespace.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` when whitespace surrounds a non-empty string.
 */
function hasSurroundingWhitespace(value) {
  return typeof value === 'string' && value.length > 0 && value !== value.trim();
}

/**
 * Match a permission pattern against a `server/tool` id.
 *
 * @param {unknown} pattern Permission pattern.
 * @param {string} toolId Tool id.
 * @returns {boolean} `true` when the pattern matches.
 */
function matchPattern(pattern, toolId) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;

  if (!pattern.includes('/')) {
    const slash = toolId.indexOf('/');
    if (slash < 0) return false;
    return globSegment(pattern, toolId.slice(0, slash));
  }

  const separator = pattern.indexOf('/');
  const serverPattern = pattern.slice(0, separator);
  const toolPattern = pattern.slice(separator + 1);
  const idSeparator = toolId.indexOf('/');
  if (idSeparator < 0) return false;

  const server = toolId.slice(0, idSeparator);
  const tool = toolId.slice(idSeparator + 1);
  if (!globSegment(serverPattern, server)) return false;
  if (toolPattern === '*') return true;
  return globSegment(toolPattern, tool);
}

/**
 * Match a glob segment where `*` does not cross `/`.
 *
 * @param {string} pattern Glob pattern.
 * @param {string} value Candidate segment.
 * @returns {boolean} `true` when the pattern matches.
 */
function globSegment(pattern, value) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`).test(value);
}

/**
 * Produce canonical JSON: object keys sorted recursively, arrays kept in order.
 *
 * @param {unknown} value Value to serialize.
 * @returns {string} Canonical JSON string.
 */
function canonicalStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Hash a string with SHA-256.
 *
 * @param {string} value Input value.
 * @returns {string} Lowercase hex digest.
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file File path.
 * @returns {unknown} Parsed data, or `undefined` when the file does not exist.
 */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
}

/**
 * Write JSON atomically with two-space indentation and a trailing newline.
 *
 * @param {string} file Destination path.
 * @param {unknown} data Data to serialize.
 * @returns {void}
 */
function writeJsonFile(file, data) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort cleanup; the original error is more useful.
    }
    throw error;
  }
}

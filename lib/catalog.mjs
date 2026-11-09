// Tool identity, defensive tool-list sanitizing, the budgeted catalog, ranked
// search, and full-definition rendering. Pure functions only: no I/O.

import { Buffer } from 'node:buffer';

const MAX_TOOL_NAME = 128;
const DEFAULT_DESCRIPTION_LIMIT = 120;
const DEFAULT_INSTRUCTIONS_LIMIT = 4096;
const DEFAULT_DEFINITION_DESCRIPTION_LIMIT = 16384;
const DEFAULT_SCHEMA_BUDGET = 5000;
const DEFAULT_SEARCH_LIMIT = 5;
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

const CATALOG_HINT = 'Use `mcpc search <terms>` to find the rest.';
const COMPACTED_HINT = '[schema compacted for display; use --full for the original]';

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asObject(value) {
  return isPlainObject(value) ? value : {};
}

/**
 * Deterministic string ordering that does not depend on the host locale.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function deepCopy(value) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function schemaBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Build a `/`-joined tool id.
 *
 * @param {string} server
 * @param {string} tool
 * @returns {string}
 */
export function toolId(server, tool) {
  return `${server}/${tool}`;
}

/**
 * @param {unknown} serverNames
 * @returns {Set<string>}
 */
function serverNameSet(serverNames) {
  if (serverNames === null || serverNames === undefined) return new Set();
  if (typeof serverNames === 'string') return new Set([serverNames]);
  if (serverNames instanceof Map) return new Set(serverNames.keys());
  if (typeof serverNames === 'object' && Symbol.iterator in serverNames) {
    return new Set(Array.from(/** @type {Iterable<any>} */ (serverNames)));
  }
  if (typeof serverNames === 'object') return new Set(Object.keys(serverNames));
  return new Set();
}

/**
 * Parse a tool reference into its server and tool parts.
 *
 * Accepted forms are `server/tool`, `mcp__server__tool`, `server__tool`, and
 * `server.tool` when the dotted left side names a known server. The server must
 * be present in `serverNames`; anything else returns `null`.
 *
 * @param {unknown} ref
 * @param {Iterable<string> | string[] | Set<string> | Record<string, unknown>} serverNames
 * @returns {{server: string, tool: string} | null}
 */
export function parseToolRef(ref, serverNames) {
  if (typeof ref !== 'string') return null;
  const value = ref.trim();
  if (!value) return null;
  const servers = serverNameSet(serverNames);
  const accept = (server, tool) => {
    if (!server || !tool || !servers.has(server)) return null;
    return { server, tool };
  };

  // Doubled underscores, with or without the Claude Code style `mcp__` prefix.
  if (value.startsWith('mcp__')) {
    const rest = value.slice(5);
    const index = rest.indexOf('__');
    if (index > 0) {
      const parsed = accept(rest.slice(0, index), rest.slice(index + 2));
      if (parsed) return parsed;
    }
  }
  const doubleIndex = value.indexOf('__');
  if (doubleIndex > 0) {
    const parsed = accept(value.slice(0, doubleIndex), value.slice(doubleIndex + 2));
    if (parsed) return parsed;
  }

  const slashIndex = value.indexOf('/');
  if (slashIndex > 0) {
    const parsed = accept(value.slice(0, slashIndex), value.slice(slashIndex + 1));
    if (parsed) return parsed;
  }

  // A dotted form is only unambiguous when the left side is a known server.
  const dotIndex = value.indexOf('.');
  if (dotIndex > 0) {
    const parsed = accept(value.slice(0, dotIndex), value.slice(dotIndex + 1));
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Defensively validate and normalize a raw MCP tool list.
 *
 * Invalid entries are skipped with a reason instead of failing the whole list.
 * Kept tools are shallow copies restricted to the fields MCPC uses.
 *
 * @param {unknown} raw
 * @returns {{tools: Array<Record<string, any>>, skipped: Array<{name: string | null, reason: string}>}}
 */
export function sanitizeTools(raw) {
  /** @type {Array<Record<string, any>>} */
  const tools = [];
  /** @type {Array<{name: string | null, reason: string}>} */
  const skipped = [];
  if (!Array.isArray(raw)) return { tools, skipped };

  const seen = new Set();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      skipped.push({ name: null, reason: 'not an object' });
      continue;
    }

    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME) {
      skipped.push({ name: typeof name === 'string' ? name : null, reason: 'invalid name' });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: 'duplicate name' });
      continue;
    }

    const rawSchema = entry.inputSchema;
    if (
      !isPlainObject(rawSchema) ||
      (rawSchema.type !== undefined && rawSchema.type !== 'object')
    ) {
      skipped.push({ name, reason: 'invalid inputSchema' });
      continue;
    }

    seen.add(name);
    const inputSchema = { ...rawSchema };
    if (inputSchema.type === undefined) inputSchema.type = 'object';
    if (!isPlainObject(inputSchema.properties)) delete inputSchema.properties;
    if (
      !Array.isArray(inputSchema.required) ||
      !inputSchema.required.every((item) => typeof item === 'string')
    ) {
      delete inputSchema.required;
    }

    /** @type {Record<string, any>} */
    const tool = { name, inputSchema };
    if (typeof entry.description === 'string') tool.description = entry.description;
    if (typeof entry.title === 'string') tool.title = entry.title;
    if (isPlainObject(entry.annotations)) tool.annotations = entry.annotations;
    if (isPlainObject(entry._meta)) tool._meta = entry._meta;
    if (isPlainObject(entry.outputSchema)) tool.outputSchema = entry.outputSchema;
    tools.push(tool);
  }

  return { tools, skipped };
}

/**
 * @param {string} pattern
 * @returns {string}
 */
function escapeRegExp(pattern) {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a name against a glob in which `*` matches any run of characters.
 *
 * @param {string} name
 * @param {string} pattern
 * @returns {boolean}
 */
function globMatches(name, pattern) {
  if (typeof pattern !== 'string') return false;
  const source = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 's').test(name);
}

/**
 * Apply the configured include list, then the exclude list, to tool names.
 *
 * @param {Array<Record<string, any>>} tools
 * @param {{include?: string[], exclude?: string[]}} [filters]
 * @returns {Array<Record<string, any>>}
 */
export function filterTools(tools, filters = {}) {
  if (!Array.isArray(tools)) return [];
  const include = Array.isArray(filters?.include) ? filters.include : null;
  const exclude = Array.isArray(filters?.exclude) ? filters.exclude : [];
  return tools.filter((tool) => {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (include && !include.some((pattern) => globMatches(name, pattern))) return false;
    if (exclude.some((pattern) => globMatches(name, pattern))) return false;
    return true;
  });
}

/**
 * Take the first non-empty line, trim it, and cut it to `limit` characters.
 *
 * A cut line ends with an ellipsis. Non-string input yields an empty string.
 *
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {string}
 */
export function firstLine(text, limit) {
  if (typeof text !== 'string') return '';
  const line = text
    .split(/\r\n|\r|\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return '';
  const max =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : Number.POSITIVE_INFINITY;
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function cutText(value, limit) {
  if (typeof value !== 'string') return '';
  if (!Number.isFinite(limit)) return value;
  return value.slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * @param {Record<string, any>} tool
 * @returns {Record<string, any>}
 */
function annotationsOf(tool) {
  return asObject(tool.annotations);
}

/**
 * @param {string} server
 * @param {{tool: Record<string, any>, name: string}} item
 * @param {number} descriptionLimit
 * @returns {string}
 */
function catalogEntryLine(server, item, descriptionLimit) {
  const id = toolId(server, item.name);
  const description = firstLine(item.tool.description, descriptionLimit);
  const annotations = annotationsOf(item.tool);
  let line = `- ${id}`;
  if (description) line += ` — ${description}`;
  if (annotations.readOnlyHint === true) line += ' [read-only]';
  if (annotations.destructiveHint === true) line += ' [destructive]';
  return line;
}

/**
 * @param {Record<string, any>} annotation
 * @returns {string[]}
 */
function definitionHints(annotation) {
  const hints = [];
  if (annotation.readOnlyHint === true) hints.push('read-only');
  if (annotation.destructiveHint === true) hints.push('destructive');
  if (annotation.idempotentHint === true) hints.push('idempotent');
  if (annotation.openWorldHint === true) hints.push('open-world');
  return hints;
}

/**
 * @param {unknown} description
 * @param {number} limit
 * @returns {string}
 */
function definitionDescription(description, limit) {
  if (typeof description !== 'string' || description.length === 0) return '(no description)';
  return cutText(description, limit);
}

/**
 * Schemas print as one compact JSON line: agents read it as easily and it costs
 * far fewer tokens than an indented form.
 *
 * @param {unknown} schema
 * @returns {string}
 */
function stringifySchema(schema) {
  try {
    const text = JSON.stringify(schema ?? {});
    return text === undefined ? '{}' : text;
  } catch {
    return '{}';
  }
}

/**
 * Render the catalog used by `mcpc tools`.
 *
 * Servers are rendered in name order. Tools that are always loaded are printed
 * as full definitions and do not consume the budget; the rest are selected
 * round-robin across servers and rendered as one line each until the token
 * budget is exhausted.
 *
 * @param {Array<Record<string, any>>} servers
 * @param {object} [options]
 * @param {number} [options.budgetTokens=2000]
 * @param {number} [options.descriptionLimit=120]
 * @param {number} [options.instructionsLimit=4096]
 * @returns {string}
 */
export function renderCatalog(servers, options = {}) {
  const settings = options ?? {};
  const budgetTokens =
    typeof settings.budgetTokens === 'number' && Number.isFinite(settings.budgetTokens)
      ? settings.budgetTokens
      : 2000;
  const descriptionLimit =
    typeof settings.descriptionLimit === 'number' && Number.isFinite(settings.descriptionLimit)
      ? Math.max(0, Math.floor(settings.descriptionLimit))
      : DEFAULT_DESCRIPTION_LIMIT;
  const instructionsLimit =
    typeof settings.instructionsLimit === 'number' && Number.isFinite(settings.instructionsLimit)
      ? Math.max(0, Math.floor(settings.instructionsLimit))
      : DEFAULT_INSTRUCTIONS_LIMIT;

  const ordered = (Array.isArray(servers) ? servers : [])
    .filter(isPlainObject)
    .map((server) => ({
      ...server,
      name: typeof server.name === 'string' ? server.name : String(server.name ?? ''),
    }))
    .sort((a, b) => compareStrings(a.name, b.name));

  const prepared = ordered.map((server) => {
    const tools = (Array.isArray(server.tools) ? server.tools : [])
      .filter(isPlainObject)
      .map((tool) => ({
        tool,
        name: typeof tool.name === 'string' ? tool.name : '',
      }))
      .sort((a, b) => compareStrings(a.name, b.name));

    /** @type {Array<{server: string, tool: Record<string, any>}>} */
    const definitions = [];
    /** @type {Array<{tool: Record<string, any>, name: string}>} */
    const entries = [];
    for (const item of tools) {
      const meta = asObject(item.tool._meta);
      if (server.alwaysLoad === true || meta[ALWAYS_LOAD_META] === true) {
        definitions.push({ server: server.name, tool: item.tool });
      } else {
        entries.push(item);
      }
    }
    return { server, tools, definitions, entries, lines: [] };
  });

  // Round-robin selection. The first entry line that would exceed the budget
  // stops selection for the whole catalog.
  const rounds = prepared.reduce((max, item) => Math.max(max, item.entries.length), 0);
  let usedChars = 0;
  let stopped = false;
  for (let round = 0; round < rounds && !stopped; round += 1) {
    for (const item of prepared) {
      if (stopped) break;
      const candidate = item.entries[round];
      if (!candidate) continue;
      const line = catalogEntryLine(item.server.name, candidate, descriptionLimit);
      const nextChars = usedChars + line.length;
      if (Math.ceil(nextChars / 4) > budgetTokens) {
        stopped = true;
        break;
      }
      usedChars = nextChars;
      item.lines.push(line);
    }
  }

  const sections = [];
  let shownTotal = 0;
  let total = 0;
  for (const item of prepared) {
    const { server, tools, definitions, lines } = item;
    total += tools.length;
    const shown = definitions.length + lines.length;
    shownTotal += shown;

    const status = server.status === undefined ? 'unknown' : String(server.status);
    const transport = server.transport === undefined ? 'unknown' : String(server.transport);
    let header = `## ${server.name}  ${status}  ${transport}  ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
    if (shown < tools.length) header += ` (${shown} of ${tools.length} shown)`;
    if (server.error) header += `  error: ${server.error}`;

    const parts = [header];
    if (typeof server.instructions === 'string' && server.instructions.length > 0) {
      const instructions = cutText(server.instructions, instructionsLimit).trimEnd();
      if (instructions) parts.push(instructions);
    }
    if (definitions.length > 0) {
      const rendered = renderDefinitions(definitions);
      if (rendered) parts.push(rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered);
    }
    if (lines.length > 0) parts.push(lines.join('\n'));
    sections.push(parts.join('\n\n'));
  }

  if (shownTotal < total) sections.push(CATALOG_HINT);
  return sections.length > 0 ? `${sections.join('\n\n')}\n` : '';
}

/**
 * @param {unknown} item
 * @returns {Record<string, any>}
 */
function definitionOf(item) {
  if (!isPlainObject(item)) return {};
  if (isPlainObject(item.tool)) return item.tool;
  if (isPlainObject(item.definition)) return item.definition;
  return item;
}

/**
 * Render full tool definitions, one Markdown block per tool.
 *
 * Blocks are separated by one blank line and the result ends with `\n`.
 *
 * @param {Array<Record<string, any>>} items
 * @param {object} [options]
 * @param {boolean} [options.full=false] skip schema compaction
 * @param {number} [options.descriptionLimit=16384]
 * @param {number} [options.schemaBudget=5000]
 * @returns {string}
 */
export function renderDefinitions(items, options = {}) {
  const settings = options ?? {};
  const full = settings.full === true;
  const descriptionLimit =
    typeof settings.descriptionLimit === 'number' && Number.isFinite(settings.descriptionLimit)
      ? Math.max(0, Math.floor(settings.descriptionLimit))
      : DEFAULT_DEFINITION_DESCRIPTION_LIMIT;
  const schemaBudget =
    typeof settings.schemaBudget === 'number' && Number.isFinite(settings.schemaBudget)
      ? settings.schemaBudget
      : DEFAULT_SCHEMA_BUDGET;

  const blocks = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const definition = definitionOf(item);
    const server = typeof item.server === 'string' ? item.server : '';
    const name =
      typeof definition.name === 'string'
        ? definition.name
        : typeof item.tool === 'string'
          ? item.tool
          : '';
    const lines = [`### ${toolId(server, name)}`];

    if (typeof definition.title === 'string' && definition.title.length > 0) {
      lines.push(`title: ${definition.title}`);
    }
    const hints = definitionHints(annotationsOf(definition));
    if (hints.length > 0) lines.push(`hints: ${hints.join(', ')}`);
    lines.push(definitionDescription(definition.description, descriptionLimit));

    const inputSchema = isPlainObject(definition.inputSchema) ? definition.inputSchema : {};
    let displaySchema = inputSchema;
    let compacted = false;
    if (!full) {
      const result = compactSchema(inputSchema, schemaBudget);
      displaySchema = result.schema;
      compacted = result.compacted;
    }
    lines.push('input schema:');
    lines.push(stringifySchema(displaySchema));

    if (isPlainObject(definition.outputSchema)) {
      lines.push('output schema:');
      lines.push(stringifySchema(definition.outputSchema));
    }
    if (compacted) lines.push(COMPACTED_HINT);
    blocks.push(lines.join('\n'));
  }

  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * Remove every nested `description` while keeping the root schema's own one.
 *
 * @param {unknown} node
 * @param {boolean} isRoot
 */
function stripNestedDescriptions(node, isRoot) {
  if (Array.isArray(node)) {
    for (const value of node) stripNestedDescriptions(value, false);
    return;
  }
  if (!isPlainObject(node)) return;
  if (!isRoot) delete node.description;
  for (const value of Object.values(node)) stripNestedDescriptions(value, false);
}

/**
 * Drop `$defs`/`definitions` and replace local refs with an empty schema.
 *
 * @param {any} node
 * @returns {any}
 */
function dropDefinitions(node) {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) node[index] = dropDefinitions(node[index]);
    return node;
  }
  if (!isPlainObject(node)) return node;

  delete node.$defs;
  delete node.definitions;
  if (typeof node.$ref === 'string' && /^#\/(?:\$defs|definitions)(?:\/|$)/.test(node.$ref)) {
    return {};
  }
  for (const key of Object.keys(node)) node[key] = dropDefinitions(node[key]);
  return node;
}

/**
 * @param {Record<string, any>} node
 * @returns {boolean}
 */
function isObjectSchema(node) {
  return node.type === 'object' || isPlainObject(node.properties);
}

/**
 * Replace object schemas nested deeper than three levels with a bare object.
 *
 * @param {any} node
 * @param {number} depth root schema is level 0
 * @returns {any}
 */
function collapseDeepObjects(node, depth) {
  if (!isPlainObject(node)) return node;
  if (depth > 3 && isObjectSchema(node)) return { type: 'object' };

  if (isPlainObject(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      node.properties[key] = collapseDeepObjects(node.properties[key], depth + 1);
    }
  }
  for (const key of ['items', 'additionalProperties', 'not', 'contains', 'propertyNames']) {
    if (isPlainObject(node[key])) node[key] = collapseDeepObjects(node[key], depth + 1);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(node[key])) {
      node[key] = node[key].map((value) => collapseDeepObjects(value, depth + 1));
    }
  }
  for (const key of ['$defs', 'definitions']) {
    if (isPlainObject(node[key])) {
      for (const name of Object.keys(node[key])) {
        node[key][name] = collapseDeepObjects(node[key][name], depth + 1);
      }
    }
  }
  return node;
}

/**
 * Replace every schema carrying `anyOf`/`oneOf`/`allOf` with an empty schema.
 *
 * @param {any} node
 * @returns {any}
 */
function pruneCompositions(node) {
  if (Array.isArray(node)) return node.map((value) => pruneCompositions(value));
  if (!isPlainObject(node)) return node;
  if ('anyOf' in node || 'oneOf' in node || 'allOf' in node) return {};
  for (const key of Object.keys(node)) node[key] = pruneCompositions(node[key]);
  return node;
}

/**
 * Compact an input schema for display within a UTF-8 byte budget.
 *
 * Four ordered lossy passes are applied to a deep copy until the compact
 * `JSON.stringify` form fits: strip nested descriptions, drop definitions and
 * their refs, collapse deep objects, then prune compositions.
 *
 * @param {unknown} schema
 * @param {number} [budget=5000]
 * @returns {{schema: any, compacted: boolean}}
 */
export function compactSchema(schema, budget = DEFAULT_SCHEMA_BUDGET) {
  const copy = deepCopy(schema);
  if (!isPlainObject(copy)) return { schema: copy, compacted: false };
  const max =
    typeof budget === 'number' && Number.isFinite(budget) ? budget : DEFAULT_SCHEMA_BUDGET;
  if (schemaBytes(copy) <= max) return { schema: copy, compacted: false };

  let compacted = copy;
  stripNestedDescriptions(compacted, true);
  if (schemaBytes(compacted) <= max) return { schema: compacted, compacted: true };

  compacted = dropDefinitions(compacted);
  if (schemaBytes(compacted) <= max) return { schema: compacted, compacted: true };

  compacted = collapseDeepObjects(compacted, 0);
  if (schemaBytes(compacted) <= max) return { schema: compacted, compacted: true };

  compacted = pruneCompositions(compacted);
  return { schema: compacted, compacted: true };
}

/**
 * Split text on non-alphanumerics and camelCase boundaries, lowercased.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
function baseTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * Expand one token with naive singular forms (`-es`, then `-s`).
 *
 * @param {string} token
 * @returns {string[]}
 */
function singularVariants(token) {
  const variants = new Set([token]);
  if (token.endsWith('es') && token.length > 2) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 1) variants.add(token.slice(0, -1));
  return [...variants];
}

/**
 * @param {Record<string, any>} definition
 * @returns {string[]}
 */
function propertyIndexText(definition) {
  const schema = asObject(definition.inputSchema);
  const properties = asObject(schema.properties);
  const texts = [];
  for (const [name, value] of Object.entries(properties)) {
    texts.push(name.toLowerCase());
    if (isPlainObject(value) && typeof value.description === 'string') {
      texts.push(value.description.toLowerCase());
    }
  }
  return texts;
}

/**
 * @param {Record<string, any>} entry
 * @returns {null | {
 *   entry: Record<string, any>,
 *   server: string,
 *   name: string,
 *   outputTool: any,
 *   id: string,
 *   idLower: string,
 *   words: Set<string>,
 *   description: string,
 *   parameters: string[],
 *   indexText: string,
 * }}
 */
function searchEntryInfo(entry) {
  if (!isPlainObject(entry)) return null;
  const server = typeof entry.server === 'string' ? entry.server : String(entry.server ?? '');
  const definition = definitionOf(entry);
  const name =
    typeof definition.name === 'string'
      ? definition.name
      : typeof entry.tool === 'string'
        ? entry.tool
        : typeof entry.name === 'string'
          ? entry.name
          : '';
  const id = toolId(server, name);
  const idLower = id.toLowerCase();
  const description =
    typeof definition.description === 'string' ? definition.description.toLowerCase() : '';
  const parameters = propertyIndexText(definition);
  const title = typeof definition.title === 'string' ? definition.title.toLowerCase() : '';
  const indexText = [
    idLower,
    name.toLowerCase(),
    title,
    server.toLowerCase(),
    description,
    ...parameters,
  ].join('\n');
  return {
    entry,
    server,
    name,
    outputTool: entry.tool === undefined ? name : entry.tool,
    id,
    idLower,
    words: new Set(baseTokens(id)),
    description,
    parameters,
    indexText,
  };
}

/**
 * @param {ReturnType<typeof searchEntryInfo>} info
 * @param {string} term
 * @returns {number}
 */
function scoreTerm(info, term) {
  if (!info || !term) return 0;
  if (info.idLower === term || info.idLower.endsWith(term)) return 20;
  if (info.words.has(term)) return 12;
  if (info.idLower.includes(term)) return 8;
  if (info.description.includes(term)) return 4;
  if (info.parameters.some((text) => text.includes(term))) return 2;
  if (info.indexText.includes(term)) return 2;
  return 0;
}

/**
 * @param {string} server
 * @param {string[]} filters
 * @returns {boolean}
 */
function matchesServerFilter(server, filters) {
  if (filters.length === 0) return true;
  const lower = server.toLowerCase();
  return filters.every((filter) => {
    const pattern = filter.toLowerCase();
    return pattern.includes('*') ? globMatches(lower, pattern) : lower === pattern;
  });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function countOption(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Search tool entries using the catalog ranking rules.
 *
 * Entries are `{server, tool}` records where `tool` is a tool definition (or a
 * tool name when no indexed details are available). Results preserve the
 * supplied `tool` value and add a score.
 *
 * @param {Array<{server: string, tool: any}>} entries
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.offset=0]
 * @returns {{
 *   items: Array<{server: string, tool: any, score: number}>,
 *   total: number,
 *   remaining: number,
 *   nextOffset: number | null,
 *   missing: string[],
 * }}
 */
export function searchTools(entries, query, options = {}) {
  const settings = options ?? {};
  const limit = countOption(settings.limit, DEFAULT_SEARCH_LIMIT);
  const offset = countOption(settings.offset, 0);
  const infos = (Array.isArray(entries) ? entries : [])
    .map((entry) => searchEntryInfo(entry))
    .filter((info) => info !== null);
  const text = typeof query === 'string' ? query.trim() : '';

  if (text.startsWith('select:')) {
    const servers = new Set(infos.map((info) => info.server));
    const items = [];
    const missing = [];
    for (const rawRef of text.slice('select:'.length).split(',')) {
      const ref = rawRef.trim();
      if (!ref) continue;
      const parsed = parseToolRef(ref, servers);
      if (!parsed) {
        missing.push(ref);
        continue;
      }
      const info = infos.find(
        (candidate) => candidate.server === parsed.server && candidate.name === parsed.tool,
      );
      if (!info) {
        missing.push(ref);
        continue;
      }
      items.push({ server: info.server, tool: info.outputTool, score: 0 });
    }
    return { items, total: items.length, remaining: 0, nextOffset: null, missing };
  }

  const filters = [];
  /** @type {Map<string, {variants: Set<string>, required: boolean}>} */
  const termMap = new Map();
  for (const rawToken of text.split(/\s+/).filter(Boolean)) {
    if (rawToken.toLowerCase().startsWith('server:')) {
      const value = rawToken.slice('server:'.length);
      if (value) filters.push(value);
      continue;
    }
    const required = rawToken.startsWith('+');
    const tokenText = required ? rawToken.slice(1) : rawToken;
    for (const token of baseTokens(tokenText)) {
      if (!token) continue;
      let term = termMap.get(token);
      if (!term) {
        term = { variants: new Set(singularVariants(token)), required: false };
        termMap.set(token, term);
      }
      term.required = term.required || required;
    }
  }

  if (termMap.size === 0) {
    const sorted = infos
      .filter((info) => matchesServerFilter(info.server, filters))
      .sort((a, b) => compareStrings(a.id, b.id));
    const page = sorted.slice(offset, offset + limit);
    const remaining = Math.max(0, sorted.length - offset - page.length);
    return {
      items: page.map((info) => ({ server: info.server, tool: info.outputTool, score: 0 })),
      total: sorted.length,
      remaining,
      nextOffset: remaining > 0 ? offset + page.length : null,
      missing: [],
    };
  }

  const terms = [...termMap.values()].map((term) => ({
    variants: [...term.variants],
    required: term.required,
  }));
  /** @type {Array<{info: NonNullable<ReturnType<typeof searchEntryInfo>>, score: number}>} */
  const scored = [];
  for (const info of infos) {
    if (!matchesServerFilter(info.server, filters)) continue;
    let score = 0;
    let accepted = true;
    for (const term of terms) {
      let termScore = 0;
      for (const variant of term.variants) {
        termScore = Math.max(termScore, scoreTerm(info, variant));
      }
      if (term.required && termScore === 0) {
        accepted = false;
        break;
      }
      score += termScore;
    }
    if (accepted && score > 0) scored.push({ info, score });
  }
  scored.sort((a, b) => b.score - a.score || compareStrings(a.info.id, b.info.id));

  const page = scored.slice(offset, offset + limit);
  const remaining = Math.max(0, scored.length - offset - page.length);
  return {
    items: page.map(({ info, score }) => ({
      server: info.server,
      tool: info.outputTool,
      score,
    })),
    total: scored.length,
    remaining,
    nextOffset: remaining > 0 ? offset + page.length : null,
    missing: [],
  };
}

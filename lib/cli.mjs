// Declarative command table, argument parser and help renderer for the mcpc
// CLI. This module only turns argument arrays into actions; it never reads
// process.argv or writes to stdout/stderr.

const NAME = 'mcpc';
const DESCRIPTION = 'A host-neutral MCP client for agent harnesses without native MCP.';

/**
 * Error raised for a command line the parser cannot accept.
 */
export class UsageError extends Error {
  /**
   * @param {string} message Human-readable explanation.
   * @param {string|null} [command] Command being parsed, when one is known.
   */
  constructor(message, command = null) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/**
 * @typedef {object} Positional
 * @property {string} name Positional name used as the result key.
 * @property {boolean} [required] Whether at least one value is required.
 * @property {boolean} [variadic] Whether the positional collects the rest.
 * @property {string} description One-line explanation.
 */

/**
 * @typedef {object} CommandOption
 * @property {string} long Long form, including the leading dashes.
 * @property {string} [short] Short form without the leading dash.
 * @property {string} [key] Result key; defaults to the camelCase long name.
 * @property {string} [value] Value placeholder; omitted for boolean flags.
 * @property {'string'|'integer'} [type] Value type, string by default.
 * @property {number} [min] Smallest accepted integer value.
 * @property {number} [max] Largest accepted integer value.
 * @property {string[]} [choices] Accepted string values.
 * @property {boolean} [repeatable] Whether repeated uses accumulate.
 * @property {string|number|boolean} [default] Default when the option is absent.
 * @property {string} description One-line explanation.
 * @property {boolean} [required] Whether the option must be supplied.
 */

/**
 * @typedef {object} Command
 * @property {string} name Command name.
 * @property {string} group Help group.
 * @property {string} summary One-line summary.
 * @property {string} usage Usage suffix after `mcpc`, options included.
 * @property {Positional[]} positionals Declared positionals, in order.
 * @property {CommandOption[]} options Command-specific options.
 * @property {{name: string, description: string}} [rest] Trailing `--` rest.
 * @property {boolean} [hidden] Whether the command is omitted from root help.
 */

const SERVERS = 'Servers';
const TOOLS = 'Tools';
const RESOURCES = 'Resources';
const SESSIONS = 'Sessions';

const SCOPE_CHOICES = ['local', 'project', 'user'];
const TRANSPORT_CHOICES = ['stdio', 'http', 'sse', 'ws'];

/**
 * Declarative command table in help order. Hidden commands remain usable but
 * are omitted from root help.
 *
 * @type {Command[]}
 */
export const COMMANDS = [
  {
    name: 'list',
    group: SERVERS,
    summary: 'List configured MCP servers.',
    usage: 'list [options]',
    positionals: [],
    options: [
      {
        long: '--scope',
        value: 'SCOPE',
        choices: SCOPE_CHOICES,
        description: 'Limit to one configuration scope.',
      },
    ],
  },
  {
    name: 'get',
    group: SERVERS,
    summary: "Show one server's configuration and status.",
    usage: 'get <server> [options]',
    positionals: [{ name: 'server', required: true, description: 'Server name' }],
    options: [{ long: '--probe', description: 'Connect and report live status.' }],
  },
  {
    name: 'add',
    group: SERVERS,
    summary: 'Add a server to a configuration scope.',
    usage: 'add <name> [target...] [options] [-- <command> [args...]]',
    positionals: [
      { name: 'name', required: true, description: 'Server name' },
      { name: 'target', variadic: true, description: 'Command or URL' },
    ],
    rest: {
      name: 'command',
      description: 'Command and arguments for a stdio server.',
    },
    options: [
      {
        long: '--scope',
        short: 's',
        value: 'SCOPE',
        choices: SCOPE_CHOICES,
        default: 'local',
        description: 'Scope to write.',
      },
      {
        long: '--transport',
        short: 't',
        value: 'TYPE',
        choices: TRANSPORT_CHOICES,
        default: 'stdio',
        description: 'Transport type.',
      },
      {
        long: '--env',
        short: 'e',
        value: 'KEY=VALUE',
        repeatable: true,
        description: 'Environment variable for a stdio server.',
      },
      {
        long: '--header',
        short: 'H',
        value: "'Name: value'",
        repeatable: true,
        description: 'HTTP header for a remote server.',
      },
      {
        long: '--timeout',
        value: 'MS',
        type: 'integer',
        min: 1000,
        description: 'Tool-call timeout in milliseconds.',
      },
    ],
  },
  {
    name: 'add-json',
    group: SERVERS,
    summary: 'Add a server from a JSON definition.',
    usage: 'add-json <name> <json> [options]',
    positionals: [
      { name: 'name', required: true, description: 'Server name' },
      { name: 'json', required: true, description: 'Server definition as JSON' },
    ],
    options: [
      {
        long: '--scope',
        short: 's',
        value: 'SCOPE',
        choices: SCOPE_CHOICES,
        description: 'Configuration scope to write.',
      },
    ],
  },
  {
    name: 'remove',
    group: SERVERS,
    summary: 'Remove a server from a configuration scope.',
    usage: 'remove <name> [options]',
    positionals: [{ name: 'name', required: true, description: 'Server name' }],
    options: [
      {
        long: '--scope',
        short: 's',
        value: 'SCOPE',
        choices: SCOPE_CHOICES,
        description: 'Configuration scope to search.',
      },
    ],
  },
  {
    name: 'approve',
    group: SERVERS,
    summary: 'Approve project servers for use.',
    usage: 'approve [server...] [options]',
    positionals: [{ name: 'server', variadic: true, description: 'Server name' }],
    options: [{ long: '--all', description: 'Approve every project server.' }],
  },
  {
    name: 'tools',
    group: TOOLS,
    summary: 'Show the tool catalog for servers.',
    usage: 'tools [server...] [options]',
    positionals: [{ name: 'server', variadic: true, description: 'Server name' }],
    options: [
      { long: '--refresh', description: 'Refresh cached catalogs.' },
      {
        long: '--budget',
        value: 'TOKENS',
        type: 'integer',
        min: 0,
        description: 'Token budget for the catalog.',
      },
    ],
  },
  {
    name: 'search',
    group: TOOLS,
    summary: 'Search discovered tools.',
    usage: 'search <query...> [options]',
    positionals: [
      {
        name: 'query',
        variadic: true,
        required: true,
        description: 'Search terms; select:a/b,c/d picks exact tools',
      },
    ],
    options: [
      {
        long: '--limit',
        value: 'N',
        type: 'integer',
        min: 1,
        max: 100,
        default: 5,
        description: 'Maximum number of results.',
      },
      {
        long: '--offset',
        value: 'N',
        type: 'integer',
        min: 0,
        default: 0,
        description: 'Number of results to skip.',
      },
      { long: '--full', description: 'Show full tool definitions.' },
    ],
  },
  {
    name: 'describe',
    group: TOOLS,
    summary: 'Show full definitions for tools.',
    usage: 'describe <ref...> [options]',
    positionals: [
      { name: 'ref', variadic: true, required: true, description: 'Tool as server/tool' },
    ],
    options: [{ long: '--full', description: 'Show full tool definitions.' }],
  },
  {
    name: 'call',
    group: TOOLS,
    summary: 'Call a tool.',
    usage: 'call <ref> [json] [options]',
    positionals: [
      { name: 'ref', required: true, description: 'Tool as server/tool' },
      { name: 'json', description: 'Tool arguments as JSON (- reads stdin)' },
    ],
    options: [
      {
        long: '--args-file',
        value: 'FILE',
        description: 'Read tool arguments from a file.',
      },
      {
        long: '--timeout',
        value: 'MS',
        type: 'integer',
        min: 1000,
        description: 'Tool-call timeout in milliseconds.',
      },
    ],
  },
  {
    name: 'resources',
    group: RESOURCES,
    summary: 'List resources and resource templates.',
    usage: 'resources [server...] [options]',
    positionals: [{ name: 'server', variadic: true, description: 'Server name' }],
    options: [],
  },
  {
    name: 'read',
    group: RESOURCES,
    summary: 'Read a resource.',
    usage: 'read <server> <uri> [options]',
    positionals: [
      { name: 'server', required: true, description: 'Server name' },
      { name: 'uri', required: true, description: 'Resource URI' },
    ],
    options: [],
  },
  {
    name: 'session',
    group: SESSIONS,
    summary: 'Keep one server connected for stateful use (run in the background)',
    usage: 'session <server> [options]',
    positionals: [{ name: 'server', required: true, description: 'Server name' }],
    options: [
      {
        long: '--idle',
        value: 'MINUTES',
        type: 'integer',
        min: 1,
        max: 1440,
        default: 30,
        description: 'Idle timeout in minutes.',
      },
    ],
  },
  {
    name: 'logs',
    group: SESSIONS,
    summary: 'Show server logs.',
    usage: 'logs [server] [options]',
    positionals: [{ name: 'server', description: 'Server name' }],
    options: [
      {
        long: '--tail',
        value: 'N',
        type: 'integer',
        min: 1,
        max: 10000,
        default: 50,
        description: 'Number of trailing lines to show.',
      },
    ],
  },
];

/** Options accepted by every command, before or after the command name. */
const GLOBAL_OPTIONS = [
  {
    long: '--cwd',
    short: 'C',
    value: 'DIR',
    description: 'Workspace root to use.',
  },
  { long: '--json', description: 'Print JSON output.' },
  { long: '--help', short: 'h', description: 'Show help.' },
  { long: '--version', short: 'V', description: 'Show the version.' },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

/** @param {Positional} positional */
function positionalLabel(positional) {
  const name = positional.variadic ? `${positional.name}...` : positional.name;
  return positional.required ? `<${name}>` : `[${name}]`;
}

/** @param {CommandOption} option */
function optionKey(option) {
  if (option.key) return option.key;
  return option.long
    .replace(/^--?/, '')
    .replace(/-([a-z0-9])/gi, (_, letter) => letter.toUpperCase());
}

/** @param {CommandOption} option */
function optionDefault(option) {
  if (option.repeatable) return [];
  if (option.value === undefined) return false;
  return option.default;
}

/** Defaults for the global options, in declaration order. */
function globalDefaults() {
  const options = {};
  for (const option of GLOBAL_OPTIONS) options[optionKey(option)] = optionDefault(option);
  return options;
}

/**
 * Add a command's defaults without disturbing already parsed global options.
 *
 * @param {Record<string, unknown>} options
 * @param {Command} command
 */
function addCommandDefaults(options, command) {
  for (const option of command.options) options[optionKey(option)] = optionDefault(option);
}

/** @param {Command|null} command */
function optionCatalogue(command) {
  return command ? [...command.options, ...GLOBAL_OPTIONS] : GLOBAL_OPTIONS;
}

/**
 * @param {Command|null} command
 * @param {string} name Option spelling, including dashes.
 * @param {boolean} isLong
 */
function findOption(command, name, isLong) {
  return optionCatalogue(command).find((option) =>
    isLong ? option.long === name : option.short !== undefined && `-${option.short}` === name,
  );
}

/**
 * Levenshtein edit distance between two short strings.
 *
 * @param {string} left
 * @param {string} right
 */
function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * Closest candidate within two edits, or null.
 *
 * @param {string} input
 * @param {string[]} candidates
 */
function suggest(input, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 2 ? best : null;
}

/** @param {string} name */
function unknownCommand(name) {
  const suggestion = suggest(
    name,
    COMMANDS.map((command) => command.name),
  );
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
  return new UsageError(`Unknown command: "${name}".${hint}`, name);
}

/**
 * @param {string} name Option spelling including dashes.
 * @param {Command|null} command
 */
function unknownOption(name, command) {
  const candidates = optionCatalogue(command).flatMap((option) => {
    const names = [option.long];
    if (option.short) names.push(`-${option.short}`);
    return names;
  });
  const suggestion = suggest(name, candidates);
  const where = command ? ` for "${command.name}"` : '';
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
  return new UsageError(`Unknown option${where}: "${name}".${hint}`, command?.name ?? null);
}

/**
 * Whether a token must be read as another option instead of an option value.
 *
 * @param {string|undefined} token
 * @param {CommandOption} option
 */
function isOptionToken(token, option) {
  if (token === undefined) return true;
  if (!token.startsWith('-') || token === '-') return false;
  // Negative integers are values for integer options, not options themselves.
  return !(option.type === 'integer' && /^-?\d+$/.test(token));
}

/**
 * @param {Record<string, unknown>} options
 * @param {CommandOption} option
 * @param {string|undefined} raw
 * @param {Command|null} command
 */
function assignOption(options, option, raw, command) {
  const commandName = command?.name ?? null;
  const key = optionKey(option);
  if (option.value === undefined) {
    if (raw !== undefined) {
      throw new UsageError(`Option "${option.long}" does not take a value.`, commandName);
    }
    options[key] = true;
    return;
  }
  if (raw === undefined) {
    throw new UsageError(`Missing value for option "${option.long}".`, commandName);
  }
  let value = raw;
  if (option.choices && !option.choices.includes(value)) {
    throw new UsageError(
      `Invalid value for "${option.long}": "${value}" (choices: ${option.choices.join('|')}).`,
      commandName,
    );
  }
  if (option.type === 'integer') {
    if (!/^-?\d+$/.test(value)) {
      throw new UsageError(`Invalid integer for "${option.long}": "${value}".`, commandName);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new UsageError(`Invalid integer for "${option.long}": "${value}".`, commandName);
    }
    if (option.min !== undefined && number < option.min) {
      const expected =
        option.max !== undefined
          ? `between ${option.min} and ${option.max}`
          : `at least ${option.min}`;
      throw new UsageError(`Value for "${option.long}" must be ${expected}.`, commandName);
    }
    if (option.max !== undefined && number > option.max) {
      const expected =
        option.min !== undefined
          ? `between ${option.min} and ${option.max}`
          : `at most ${option.max}`;
      throw new UsageError(`Value for "${option.long}" must be ${expected}.`, commandName);
    }
    value = number;
  }
  if (option.repeatable) options[key].push(value);
  else options[key] = value;
}

/**
 * Find the first non-option token that occupies the command slot, skipping the
 * value of a leading `--cwd`. Returns null when `--` ends option parsing first.
 *
 * @param {string[]} args
 */
function findCommandSlot(args) {
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') return null;
    if (token === '--cwd' || token === '-C') {
      const next = args[index + 1];
      if (next !== undefined && (!next.startsWith('-') || next === '-')) index++;
      continue;
    }
    if (token.startsWith('--cwd=') || token.startsWith('-C=')) continue;
    if (token.startsWith('-')) continue;
    return { index, token };
  }
  return null;
}

/**
 * `--help`/`--version` are honoured anywhere before a `--` terminator.
 *
 * @param {string[]} args
 */
function detectActions(args) {
  let help = false;
  let version = false;
  for (const token of args) {
    if (token === '--') break;
    if (token === '--help' || token === '-h') help = true;
    else if (token === '--version' || token === '-V') version = true;
  }
  return { help, version };
}

/**
 * @param {Command} command
 * @param {string[]} tokens
 */
function buildPositionals(command, tokens) {
  const positionals = {};
  let index = 0;
  for (const positional of command.positionals) {
    if (positional.variadic) {
      const values = tokens.slice(index);
      index = tokens.length;
      if (positional.required && values.length === 0) {
        throw new UsageError(
          `Missing required positional argument: ${positionalLabel(positional)}.`,
          command.name,
        );
      }
      positionals[positional.name] = values;
    } else if (index < tokens.length) {
      positionals[positional.name] = tokens[index];
      index++;
    } else {
      if (positional.required) {
        throw new UsageError(
          `Missing required positional argument: ${positionalLabel(positional)}.`,
          command.name,
        );
      }
      positionals[positional.name] = undefined;
    }
  }
  if (index < tokens.length) {
    const unexpected = tokens
      .slice(index)
      .map((token) => `"${token}"`)
      .join(', ');
    throw new UsageError(`Too many arguments for "${command.name}": ${unexpected}.`, command.name);
  }
  return positionals;
}

/**
 * Parse an argument array (without the program name).
 *
 * @param {string[]} argv
 * @returns {{action: 'version'} | {action: 'help', command: string|null} |
 *   {action: 'run', command: string, options: Record<string, unknown>,
 *   positionals: Record<string, unknown>, rest: string[]}}
 * @throws {UsageError} When the command line is invalid.
 */
export function parse(argv) {
  const args = [...argv];
  if (args.length === 0) return { action: 'help', command: null };

  const slot = findCommandSlot(args);
  if (slot?.token === 'help') {
    const target = args[slot.index + 1];
    if (target === undefined || target.startsWith('-')) return { action: 'help', command: null };
    if (!COMMAND_BY_NAME.has(target)) throw unknownCommand(target);
    return { action: 'help', command: target };
  }

  const actions = detectActions(args);
  if (actions.help) {
    const name = slot && COMMAND_BY_NAME.has(slot.token) ? slot.token : null;
    return { action: 'help', command: name };
  }
  if (actions.version) return { action: 'version' };

  let command = null;
  const options = globalDefaults();
  const positionalTokens = [];
  let rest = [];
  let endOfOptions = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index];

    if (endOfOptions) {
      positionalTokens.push(token);
      continue;
    }

    if (token === '--') {
      if (command?.rest) {
        rest = args.slice(index + 1);
        break;
      }
      endOfOptions = true;
      continue;
    }

    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      const inline = equals === -1 ? undefined : token.slice(equals + 1);
      const option = findOption(command, name, true);
      if (!option) throw unknownOption(name, command);
      let raw = inline;
      if (option.value !== undefined && raw === undefined) {
        const next = args[index + 1];
        if (isOptionToken(next, option)) {
          throw new UsageError(`Missing value for option "${option.long}".`, command?.name ?? null);
        }
        raw = next;
        index++;
      }
      assignOption(options, option, option.value === undefined ? inline : raw, command);
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      const inline = equals === -1 ? undefined : token.slice(equals + 1);
      const option = findOption(command, name, false);
      if (!option) throw unknownOption(name, command);
      let raw = inline;
      if (option.value !== undefined && raw === undefined) {
        const next = args[index + 1];
        if (isOptionToken(next, option)) {
          throw new UsageError(`Missing value for option "${option.long}".`, command?.name ?? null);
        }
        raw = next;
        index++;
      }
      assignOption(options, option, option.value === undefined ? inline : raw, command);
      continue;
    }

    if (command === null) {
      const candidate = COMMAND_BY_NAME.get(token);
      if (!candidate) throw unknownCommand(token);
      command = candidate;
      addCommandDefaults(options, command);
      continue;
    }

    positionalTokens.push(token);
  }

  if (command === null) return { action: 'help', command: null };

  const positionals = buildPositionals(command, positionalTokens);
  for (const option of command.options) {
    if (option.required && options[optionKey(option)] === undefined) {
      throw new UsageError(`Missing required option: "${option.long}".`, command.name);
    }
  }

  return {
    action: 'run',
    command: command.name,
    options,
    positionals,
    rest,
  };
}

/**
 * @param {string} text
 * @param {number} width
 */
function wrapText(text, width) {
  const limit = Math.max(1, width);
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (let word of words) {
    while (word.length > limit) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** @param {number} columns */
function normalizeColumns(columns) {
  return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 100;
}

/** @param {CommandOption} option */
function optionLabel(option) {
  const prefix = option.short ? `-${option.short}, ` : '    ';
  const value = option.value ? ` ${option.value}` : '';
  return `${prefix}${option.long}${value}`;
}

/** @param {CommandOption} option */
function optionDescription(option) {
  const parts = [];
  if (option.description) parts.push(option.description);
  if (option.required) parts.push('(required)');
  if (option.choices) parts.push(`(choices: ${option.choices.join('|')})`);
  if (option.default !== undefined) {
    const value = Array.isArray(option.default) ? option.default.join(', ') : option.default;
    parts.push(`(default: ${value})`);
  }
  return parts.join(' ');
}

/**
 * Render aligned label/description rows, wrapping within `width`.
 *
 * @param {Array<{label: string, description: string}>} rows
 * @param {number} width
 * @returns {string[]}
 */
function renderAlignedLines(rows, width) {
  const labels = rows.map((row) => row.label);
  const labelWidth = Math.max(...labels.map((label) => label.length));
  const indent = '  ';
  const descriptionColumn = indent.length + labelWidth + 2;
  const lines = [];
  for (let index = 0; index < rows.length; index++) {
    const description = rows[index].description;
    if (!description) {
      lines.push(`${indent}${labels[index]}`);
      continue;
    }
    const available = width - descriptionColumn;
    if (indent.length + labels[index].length > width) {
      for (const line of wrapText(labels[index], Math.max(1, width - indent.length))) {
        lines.push(`${indent}${line}`);
      }
      for (const line of wrapText(description, Math.max(1, width - indent.length - 2))) {
        lines.push(`${indent}  ${line}`);
      }
      continue;
    }
    if (available < 12) {
      lines.push(`${indent}${labels[index]}`);
      for (const line of wrapText(description, Math.max(1, width - indent.length - 2))) {
        lines.push(`${indent}  ${line}`);
      }
      continue;
    }
    const descriptionLines = wrapText(description, available);
    lines.push(`${indent}${labels[index].padEnd(labelWidth)}  ${descriptionLines[0]}`);
    for (const line of descriptionLines.slice(1)) {
      lines.push(`${' '.repeat(descriptionColumn)}${line}`);
    }
  }
  return lines;
}

/**
 * @param {CommandOption[]} options
 * @param {number} width
 */
function renderOptionLines(options, width) {
  return renderAlignedLines(
    options.map((option) => ({
      label: optionLabel(option),
      description: optionDescription(option),
    })),
    width,
  );
}

/**
 * @param {Positional[]} positionals
 * @param {number} width
 */
function renderPositionalLines(positionals, width) {
  return renderAlignedLines(
    positionals.map((positional) => ({
      label: positionalLabel(positional),
      description: positional.description ?? '',
    })),
    width,
  );
}

/**
 * Render the root help screen.
 *
 * @param {{columns?: number}} [options]
 * @returns {string}
 */
export function rootHelp({ columns = 100 } = {}) {
  const width = normalizeColumns(columns);
  const lines = [];
  lines.push(...wrapText(`${NAME} — ${DESCRIPTION}`, width));
  lines.push('');
  lines.push(...wrapText(`Usage: ${NAME} <command> [options]`, width));
  lines.push('');

  const listed = COMMANDS.filter((command) => !command.hidden);
  const nameWidth = Math.max(...listed.map((command) => command.name.length));
  const descriptionColumn = 2 + nameWidth + 2;

  let group = null;
  for (const command of listed) {
    if (!group || group.name !== command.group) {
      if (group) lines.push('');
      group = { name: command.group, commands: [] };
      lines.push(...wrapText(`${group.name}:`, width));
    }
    group.commands.push(command);
    if (descriptionColumn + 10 <= width) {
      const summaryLines = wrapText(command.summary, width - descriptionColumn);
      lines.push(`  ${command.name.padEnd(nameWidth)}  ${summaryLines[0]}`);
      for (const line of summaryLines.slice(1)) lines.push(' '.repeat(descriptionColumn) + line);
    } else {
      lines.push(`  ${command.name}`);
      for (const line of wrapText(command.summary, Math.max(1, width - 4))) {
        lines.push(`    ${line}`);
      }
    }
  }

  lines.push('');
  lines.push('Global options:');
  lines.push(...renderOptionLines(GLOBAL_OPTIONS, width));
  lines.push('');
  lines.push(...wrapText(`Run "${NAME} <command> --help" for command options.`, width));
  return lines.join('\n');
}

/**
 * Render help for one command.
 *
 * @param {string} name
 * @param {{columns?: number}} [options]
 * @returns {string}
 * @throws {UsageError} When the command is unknown.
 */
export function commandHelp(name, { columns = 100 } = {}) {
  const command = COMMAND_BY_NAME.get(name);
  if (!command) throw unknownCommand(name);
  const width = normalizeColumns(columns);
  const lines = [];
  lines.push(...wrapText(`Usage: ${NAME} ${command.usage}`, width));
  lines.push('');
  lines.push(...wrapText(command.summary, width));

  if (command.positionals.length > 0) {
    lines.push('');
    lines.push('Arguments:');
    lines.push(...renderPositionalLines(command.positionals, width));
  }

  if (command.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    lines.push(...renderOptionLines(command.options, width));
  }

  lines.push('');
  lines.push('Global options:');
  lines.push(...renderOptionLines(GLOBAL_OPTIONS, width));
  return lines.join('\n');
}

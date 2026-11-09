import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, UsageError, parse, rootHelp, commandHelp } from '../lib/cli.mjs';

const EXPECTED = [
  ['list', 'Servers'],
  ['get', 'Servers'],
  ['add', 'Servers'],
  ['add-json', 'Servers'],
  ['remove', 'Servers'],
  ['approve', 'Servers'],
  ['tools', 'Tools'],
  ['search', 'Tools'],
  ['describe', 'Tools'],
  ['call', 'Tools'],
  ['resources', 'Resources'],
  ['read', 'Resources'],
  ['session', 'Sessions'],
  ['logs', 'Sessions'],
  ['update', 'Setup'],
];

const DOCUMENTED = [
  ['list'],
  ['list', '--scope', 'project'],
  ['get', 'fs'],
  ['get', 'fs', '--probe'],
  ['add', 'fs', 'npx', 'server'],
  ['add', 'remote', 'https://example.com', '--transport', 'http'],
  ['add', 'fs', '--', 'npx', '-y', 'server'],
  ['add-json', 'fs', '{"command":"npx"}'],
  ['remove', 'fs', '--scope', 'user'],
  ['approve'],
  ['approve', 'a', 'b', '--all'],
  ['tools'],
  ['tools', 'a', 'b', '--refresh', '--budget', '1000'],
  ['search', 'foo', 'bar', '--limit', '10', '--offset', '2', '--full'],
  ['describe', 'a/b', '--full'],
  ['call', 'a/b', '{"x":1}', '--args-file', 'args.json', '--timeout', '5000'],
  ['resources', 'a', 'b'],
  ['read', 'fs', 'file:///tmp/x'],
  ['session', 'fs', '--idle', '15'],
  ['logs'],
  ['logs', 'fs', '--tail', '100'],
  ['update'],
];

function usageError(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected UsageError, got ${error}`);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'UsageError');
    return error;
  }
  assert.fail('expected a UsageError');
}

test('command table lists every documented command in group order', () => {
  assert.deepEqual(
    COMMANDS.map((command) => command.name),
    EXPECTED.map(([name]) => name),
  );
  for (const [name, group] of EXPECTED) {
    const command = COMMANDS.find((entry) => entry.name === name);
    assert.ok(command, name);
    assert.equal(command.group, group);
    assert.equal(typeof command.summary, 'string');
    assert.ok(command.summary.length > 0);
    assert.ok(!command.summary.includes('\n'));
    assert.equal(typeof command.usage, 'string');
    assert.ok(command.usage.length > 0);
    assert.ok(Array.isArray(command.positionals));
    assert.ok(Array.isArray(command.options));
    for (const positional of command.positionals) {
      assert.equal(typeof positional.description, 'string', `${name} ${positional.name}`);
      assert.ok(positional.description.length > 0, `${name} ${positional.name}`);
      assert.ok(!positional.description.includes('\n'), `${name} ${positional.name}`);
    }
  }
  assert.deepEqual(
    COMMANDS.filter((command) => command.hidden).map((command) => command.name),
    [],
  );

  const add = COMMANDS.find((command) => command.name === 'add');
  assert.deepEqual(
    add.positionals.map((positional) => positional.name),
    ['name', 'target'],
  );
  assert.equal(add.rest.name, 'command');
  const scope = add.options.find((option) => option.long === '--scope');
  assert.equal(scope.short, 's');
  assert.deepEqual(scope.choices, ['local', 'project', 'user']);
  assert.equal(scope.default, 'local');
  const transport = add.options.find((option) => option.long === '--transport');
  assert.deepEqual(transport.choices, ['stdio', 'http', 'sse', 'ws']);
  assert.equal(transport.default, 'stdio');

  const session = COMMANDS.find((command) => command.name === 'session');
  assert.deepEqual(
    session.positionals.map((positional) => positional.name),
    ['server'],
  );
  const idle = session.options.find((option) => option.long === '--idle');
  assert.equal(idle.min, 1);
  assert.equal(idle.max, 1440);
  assert.equal(idle.default, 30);

  const removedCommands = new Set([
    'reject',
    'login',
    'logout',
    'wait',
    'cancel',
    'result',
    'requests',
    'answer',
    'prompts',
    'prompt',
    'status',
    'restart',
    'stop',
    'daemon',
  ]);
  const removedOptions = new Set(['--cached', '--wait-ms', '--background']);
  for (const command of COMMANDS) {
    assert.ok(!removedCommands.has(command.name), `${command.name} is removed`);
    for (const option of command.options) {
      assert.ok(!removedOptions.has(option.long), `${command.name} ${option.long} is removed`);
    }
  }
});

test('every command parses its documented forms', () => {
  for (const argv of DOCUMENTED) {
    const result = parse(argv);
    assert.equal(result.action, 'run', argv.join(' '));
    assert.equal(result.command, argv[0], argv.join(' '));
    assert.equal(typeof result.options, 'object');
    assert.equal(typeof result.positionals, 'object');
    assert.ok(Array.isArray(result.rest));
    for (const key of ['cwd', 'json', 'help', 'version']) {
      assert.ok(key in result.options, `${argv[0]} has global option ${key}`);
    }
  }
});

test('commands return their declared positionals', () => {
  assert.deepEqual(parse(['get', 'fs']).positionals, { server: 'fs' });
  assert.deepEqual(parse(['add', 'fs', 'npx']).positionals, {
    name: 'fs',
    target: ['npx'],
  });
  assert.deepEqual(parse(['approve']).positionals, { server: [] });
  assert.deepEqual(parse(['tools', 'a', 'b']).positionals, { server: ['a', 'b'] });
  assert.deepEqual(parse(['search', 'foo', 'bar']).positionals, { query: ['foo', 'bar'] });
  assert.deepEqual(parse(['describe', 'a/b', 'c/d']).positionals, { ref: ['a/b', 'c/d'] });
  assert.deepEqual(parse(['call', 'a/b']).positionals, { ref: 'a/b', json: undefined });
  assert.deepEqual(parse(['call', 'a/b', '{}']).positionals, { ref: 'a/b', json: '{}' });
  assert.deepEqual(parse(['logs']).positionals, { server: undefined });
  assert.deepEqual(parse(['logs', 'fs']).positionals, { server: 'fs' });
  assert.deepEqual(parse(['session', 'fs']).positionals, { server: 'fs' });
  assert.deepEqual(parse(['read', 'fs', 'file:///x']).positionals, {
    server: 'fs',
    uri: 'file:///x',
  });
});

test('defaults are applied to command and global options', () => {
  const add = parse(['add', 'fs', 'npx']);
  assert.equal(add.options.scope, 'local');
  assert.equal(add.options.transport, 'stdio');
  assert.deepEqual(add.options.env, []);
  assert.deepEqual(add.options.header, []);
  assert.equal(add.options.timeout, undefined);
  assert.equal(add.options.cwd, undefined);
  assert.equal(add.options.json, false);
  assert.equal(add.options.help, false);
  assert.equal(add.options.version, false);
  assert.deepEqual(add.rest, []);

  const search = parse(['search', 'foo']);
  assert.equal(search.options.limit, 5);
  assert.equal(search.options.offset, 0);
  assert.equal(search.options.full, false);

  assert.equal(parse(['session', 'fs']).options.idle, 30);
  assert.equal(parse(['logs']).options.tail, 50);
  assert.equal(parse(['list']).options.scope, undefined);
  assert.equal(parse(['add-json', 'fs', '{}']).options.scope, undefined);
  assert.equal(parse(['call', 'a/b']).options.timeout, undefined);
});

test('repeatable options accumulate values in order', () => {
  const result = parse([
    'add',
    'fs',
    'npx',
    '--env',
    'A=1',
    '--env=B=2',
    '-e',
    'C=3',
    '--header',
    'X: y',
    '-H',
    'Z: w',
  ]);
  assert.deepEqual(result.options.env, ['A=1', 'B=2', 'C=3']);
  assert.deepEqual(result.options.header, ['X: y', 'Z: w']);
});

test('long equals form, short forms and camelCase keys work', () => {
  const result = parse([
    'add',
    'fs',
    '--scope=project',
    '--transport=http',
    '--env=A=1',
    '--timeout=5000',
    '-C=/work',
    '--json',
  ]);
  assert.equal(result.options.scope, 'project');
  assert.equal(result.options.transport, 'http');
  assert.deepEqual(result.options.env, ['A=1']);
  assert.equal(result.options.timeout, 5000);
  assert.equal(result.options.cwd, '/work');
  assert.equal(result.options.json, true);

  const short = parse([
    'add',
    'fs',
    '-s',
    'project',
    '-t',
    'sse',
    '-e',
    'K=V',
    '-H',
    'A: b',
    '-C',
    '/work',
  ]);
  assert.equal(short.options.scope, 'project');
  assert.equal(short.options.transport, 'sse');
  assert.deepEqual(short.options.env, ['K=V']);
  assert.deepEqual(short.options.header, ['A: b']);
  assert.equal(short.options.cwd, '/work');

  const call = parse(['call', 'a/b', '--args-file', 'a.json', '--timeout', '5000']);
  assert.equal(call.options.argsFile, 'a.json');
  assert.equal(call.options.timeout, 5000);

  const session = parse(['session', 'fs', '--idle=45']);
  assert.equal(session.options.idle, 45);
});

test('global options are accepted before and after the command', () => {
  const before = parse(['--cwd', '/work', '--json', 'list']);
  const after = parse(['list', '--json', '--cwd', '/work']);
  assert.deepEqual(before, after);
  assert.equal(before.options.cwd, '/work');
  assert.equal(before.options.json, true);
});

test('-- sends the tail to rest for add and to positionals elsewhere', () => {
  const add = parse(['add', 'fs', 'npx', '--', 'server', '-y', 'pkg']);
  assert.deepEqual(add.positionals, { name: 'fs', target: ['npx'] });
  assert.deepEqual(add.rest, ['server', '-y', 'pkg']);

  const noRest = parse(['get', '--', '--help']);
  assert.equal(noRest.action, 'run');
  assert.deepEqual(noRest.positionals, { server: '--help' });
  assert.deepEqual(noRest.rest, []);

  const read = parse(['read', '--', 'fs', 'file:///x']);
  assert.deepEqual(read.positionals, { server: 'fs', uri: 'file:///x' });

  const dash = parse(['call', 'a/b', '-']);
  assert.deepEqual(dash.positionals, { ref: 'a/b', json: '-' });

  const restHelp = parse(['add', 'fs', '--', '--help']);
  assert.equal(restHelp.action, 'run');
  assert.deepEqual(restHelp.rest, ['--help']);
});

test('strict integers accept negatives only where the range allows', () => {
  assert.equal(parse(['tools', '--budget', '0']).options.budget, 0);
  assert.equal(parse(['session', 'fs', '--idle', '1']).options.idle, 1);
  const error = usageError(() => parse(['tools', '--budget', '-1']));
  assert.match(error.message, /at least 0/);
});

test('unknown commands and options suggest close names', () => {
  const command = usageError(() => parse(['lst']));
  assert.equal(command.command, 'lst');
  assert.match(command.message, /Unknown command/);
  assert.match(command.message, /Did you mean "list"\?/);

  const noSuggestion = usageError(() => parse(['zzzzzz']));
  assert.doesNotMatch(noSuggestion.message, /Did you mean/);

  const option = usageError(() => parse(['add', 'fs', '--scop', 'project']));
  assert.equal(option.command, 'add');
  assert.match(option.message, /Unknown option/);
  assert.match(option.message, /--scope/);

  const global = usageError(() => parse(['add', 'fs', '--jso']));
  assert.match(global.message, /--json/);

  const beforeCommand = usageError(() => parse(['--jsn']));
  assert.equal(beforeCommand.command, null);
  assert.match(beforeCommand.message, /--json/);

  const short = usageError(() => parse(['add', 'fs', '-z']));
  assert.match(short.message, /-s/);

  const removed = usageError(() => parse(['tools', '--cached']));
  assert.match(removed.message, /Unknown option/);
});

test('missing option values are rejected', () => {
  const end = usageError(() => parse(['add', 'fs', '--scope']));
  assert.equal(end.command, 'add');
  assert.match(end.message, /Missing value/);
  assert.match(end.message, /--scope/);

  const nextOption = usageError(() => parse(['search', 'foo', '--limit', '--json']));
  assert.match(nextOption.message, /Missing value/);
  assert.match(nextOption.message, /--limit/);
});

test('bad choices list the accepted values', () => {
  const error = usageError(() => parse(['add', 'fs', '--scope', 'global']));
  assert.match(error.message, /local/);
  assert.match(error.message, /project/);
  assert.match(error.message, /user/);

  const transport = usageError(() => parse(['add', 'fs', '--transport', 'tcp']));
  for (const choice of ['stdio', 'http', 'sse', 'ws']) {
    assert.match(transport.message, new RegExp(choice));
  }
});

test('bad integers and out-of-range integers are rejected', () => {
  for (const value of ['1.5', '+5', '1e3', 'abc']) {
    const error = usageError(() => parse(['search', 'foo', '--offset', value]));
    assert.match(error.message, /Invalid integer/);
    assert.match(error.message, /--offset/);
  }

  assert.match(
    usageError(() => parse(['search', 'foo', '--limit', '0'])).message,
    /between 1 and 100/,
  );
  assert.match(
    usageError(() => parse(['search', 'foo', '--limit', '101'])).message,
    /between 1 and 100/,
  );
  assert.match(usageError(() => parse(['logs', '--tail', '10001'])).message, /between 1 and 10000/);
  assert.match(
    usageError(() => parse(['session', 'fs', '--idle', '0'])).message,
    /between 1 and 1440/,
  );
  assert.match(
    usageError(() => parse(['session', 'fs', '--idle', '1441'])).message,
    /between 1 and 1440/,
  );
  assert.match(
    usageError(() => parse(['call', 'a/b', '--timeout', '999'])).message,
    /at least 1000/,
  );
});

test('missing required positionals and options are rejected', () => {
  const server = usageError(() => parse(['get']));
  assert.equal(server.command, 'get');
  assert.match(server.message, /Missing required positional argument/);
  assert.match(server.message, /server/);

  assert.match(usageError(() => parse(['search'])).message, /query/);
  assert.match(usageError(() => parse(['read', 'fs'])).message, /uri/);
  assert.match(usageError(() => parse(['session'])).message, /server/);
  assert.match(usageError(() => parse(['call'])).message, /ref/);
});

test('too many positionals are rejected', () => {
  const list = usageError(() => parse(['list', 'extra']));
  assert.equal(list.command, 'list');
  assert.match(list.message, /Too many arguments/);
  assert.match(list.message, /extra/);

  const read = usageError(() => parse(['read', 'fs', 'file:///x', 'extra']));
  assert.match(read.message, /Too many arguments/);

  assert.match(usageError(() => parse(['logs', 'a', 'b'])).message, /Too many arguments/);
  assert.match(usageError(() => parse(['session', 'a', 'b'])).message, /Too many arguments/);
});

test('boolean options do not accept a value', () => {
  const error = usageError(() => parse(['list', '--json=1']));
  assert.match(error.message, /does not take a value/);
  assert.match(error.message, /--json/);
});

test('help and version actions', () => {
  assert.deepEqual(parse([]), { action: 'help', command: null });
  assert.deepEqual(parse(['--help']), { action: 'help', command: null });
  assert.deepEqual(parse(['-h']), { action: 'help', command: null });
  assert.deepEqual(parse(['add', '--help']), { action: 'help', command: 'add' });
  assert.deepEqual(parse(['--help', 'add']), { action: 'help', command: 'add' });
  assert.deepEqual(parse(['help']), { action: 'help', command: null });
  assert.deepEqual(parse(['help', 'add']), { action: 'help', command: 'add' });
  assert.deepEqual(parse(['--json', 'help', 'add']), { action: 'help', command: 'add' });
  assert.deepEqual(parse(['session', '--help']), { action: 'help', command: 'session' });
  assert.deepEqual(parse(['bogus', '--help']), { action: 'help', command: null });

  assert.deepEqual(parse(['--version']), { action: 'version' });
  assert.deepEqual(parse(['-V']), { action: 'version' });
  assert.deepEqual(parse(['add', '--version']), { action: 'version' });
  assert.deepEqual(parse(['--version', '--help']), { action: 'help', command: null });

  const helpUnknown = usageError(() => parse(['help', 'bogus']));
  assert.equal(helpUnknown.command, 'bogus');
  assert.match(helpUnknown.message, /Unknown command/);
});

test('root help lists every non-hidden command at a stable alignment', () => {
  const help = rootHelp();
  const lines = help.split('\n');

  assert.equal(
    lines[0],
    'mcpc — A host-neutral MCP client for agent harnesses without native MCP.',
  );
  assert.ok(lines.includes('Usage: mcpc <command> [options]'));
  for (const group of ['Servers:', 'Tools:', 'Resources:', 'Sessions:']) {
    assert.ok(lines.includes(group), group);
  }
  for (const command of COMMANDS.filter((entry) => !entry.hidden)) {
    assert.ok(
      lines.some((line) => line.startsWith(`  ${command.name} `)),
      `${command.name} is listed`,
    );
  }
  assert.ok(!help.includes('daemon'));
  assert.ok(help.includes('Global options:'));
  for (const option of ['--cwd', '--json', '--help', '--version']) {
    assert.ok(help.includes(option));
  }
  assert.ok(help.endsWith('Run "mcpc <command> --help" for command options.'));

  const listLine = lines.find((line) => line.startsWith('  list '));
  const getLine = lines.find((line) => line.startsWith('  get '));
  assert.equal(listLine.indexOf('List configured'), getLine.indexOf('Show one'));
});

test('root help wraps within the requested columns', () => {
  for (const columns of [20, 40, 60, 100]) {
    const help = rootHelp({ columns });
    for (const line of help.split('\n')) {
      assert.ok(line.length <= columns, `${columns} columns: ${line}`);
    }
  }
});

test('command help shows usage, summary, arguments, options and globals', () => {
  const help = commandHelp('add');
  assert.ok(
    help.startsWith('Usage: mcpc add <name> [target...] [options] [-- <command> [args...]]'),
  );
  assert.ok(help.includes('Add a server to a configuration scope.'));
  assert.ok(help.includes('Arguments:'));
  assert.ok(help.includes('<name>'));
  assert.ok(help.includes('[target...]'));
  assert.ok(help.includes('Options:'));
  assert.ok(help.includes('--scope'));
  assert.ok(help.includes('-s, --scope SCOPE'));
  assert.ok(help.includes('local|project|user'));
  assert.ok(help.includes('(default: local)'));
  assert.ok(help.includes('(default: stdio)'));
  assert.ok(help.includes('--header'));
  assert.ok(help.includes("'Name: value'"));
  assert.ok(help.includes('Global options:'));
  for (const option of ['--cwd', '--json', '--help', '--version']) {
    assert.ok(help.includes(option));
  }

  const session = commandHelp('session');
  assert.ok(
    session.includes('Keep one server connected for stateful use (run it in the background).'),
  );
  assert.ok(session.includes('--idle'));
  assert.ok(session.includes('(default: 30)'));

  assert.ok(!commandHelp('list').includes('Arguments:'));
  assert.ok(commandHelp('list').includes('--scope'));
});

test('command help prints positional descriptions aligned with options', () => {
  const help = commandHelp('add');
  const lines = help.split('\n');
  const start = lines.indexOf('Arguments:');
  assert.ok(start >= 0);
  const nameLine = lines[start + 1];
  const targetLine = lines[start + 2];
  assert.match(nameLine, /^ {2}<name> +Server name$/);
  assert.match(targetLine, /^ {2}\[target\.\.\.\] +Command or URL$/);
  assert.equal(nameLine.indexOf('Server name'), targetLine.indexOf('Command or URL'));

  const call = commandHelp('call');
  assert.match(call, /<ref> +Tool as server\/tool/);
  assert.match(call, /\[json\] +Tool arguments as JSON \(- reads stdin\)/);
  assert.match(commandHelp('add-json'), /<json> +Server definition as JSON/);
  assert.match(
    commandHelp('search'),
    /<query\.\.\.> +Search terms; select:a\/b,c\/d picks exact tools/,
  );
  assert.match(commandHelp('read'), /<uri> +Resource URI/);
});

test('every positional description appears in its command help', () => {
  for (const command of COMMANDS) {
    if (command.positionals.length === 0) continue;
    const help = commandHelp(command.name, { columns: 400 });
    assert.ok(help.includes('Arguments:'), command.name);
    for (const positional of command.positionals) {
      assert.ok(
        help.includes(positional.description),
        `${command.name} help includes ${positional.description}`,
      );
    }
  }
});

test('command help wraps within the requested columns', () => {
  for (const command of COMMANDS) {
    for (const columns of [20, 40, 60, 100]) {
      const help = commandHelp(command.name, { columns });
      for (const line of help.split('\n')) {
        assert.ok(line.length <= columns, `${command.name} at ${columns} columns: ${line}`);
      }
    }
  }
});

test('command help rejects unknown commands with a suggestion', () => {
  const error = usageError(() => commandHelp('lst'));
  assert.match(error.message, /Unknown command/);
  assert.match(error.message, /"list"/);
});

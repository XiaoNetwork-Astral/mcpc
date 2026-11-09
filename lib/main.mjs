// The mcpc command line: commands that only touch configuration run here; the
// rest are forwarded to the workspace daemon and its answer is printed.

import fs from 'node:fs';
import path from 'node:path';

import { UsageError, commandHelp, parse, rootHelp } from './cli.mjs';
import {
  buildServerConfig,
  loadConfig,
  removeServer,
  setApproval,
  validateServer,
  writeServer,
} from './config.mjs';
import { IpcError, openDaemon } from './ipc.mjs';
import {
  approvalsFile,
  configFiles,
  daemonKey,
  endpointFor,
  findWorkspaceRoot,
  logsDir,
  mcpcHome,
  projectDir,
  workspaceId,
} from './paths.mjs';
import { VERSION } from './version.mjs';

export const EXIT = { ok: 0, failed: 1, usage: 2, request: 3, running: 4, unavailable: 5 };

const USAGE_CODES = new Set([
  'unknown_server',
  'unknown_tool',
  'invalid_arguments',
  'invalid_answer',
  'unknown_call',
  'unknown_request',
  'bad_json',
  'unknown_method',
]);

/** Exit code for an error raised by a command. */
export function exitCodeFor(error) {
  if (error instanceof UsageError || USAGE_CODES.has(error?.code)) return EXIT.usage;
  if (error?.code === 'server_unavailable') return EXIT.unavailable;
  return EXIT.failed;
}

function context(options, env, cwd) {
  const root = findWorkspaceRoot({ cwd, env, explicit: options.cwd });
  const home = mcpcHome(env);
  const wsid = workspaceId(root);
  const key = daemonKey(wsid, env);
  const dir = projectDir(home, wsid);
  return {
    env,
    root,
    home,
    wsid,
    key,
    projectDir: dir,
    endpoint: endpointFor(home, key),
    files: configFiles({ home, root, wsid }),
    lockFile: path.join(dir, 'daemon.lock'),
    logFile: path.join(dir, 'logs', 'daemon.log'),
  };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new IpcError('bad_json', `${what} is not valid JSON: ${error.message}`);
  }
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON input from a positional (`-` = stdin) or a file option. */
async function jsonInput({ inline, file, stdin, what, fallback }) {
  if (file) return parseJson(fs.readFileSync(file, 'utf8'), `${what} file`);
  if (inline === '-') return parseJson(await readStdin(stdin), `${what} on stdin`);
  if (inline !== undefined) return parseJson(inline, what);
  return fallback;
}

const pairs = (items, separator, what) =>
  Object.fromEntries(
    items.map((item) => {
      const index = item.indexOf(separator);
      if (index <= 0) throw new UsageError(`${what} must look like NAME${separator}VALUE: ${item}`);
      return [item.slice(0, index).trim(), item.slice(index + separator.length).trim()];
    }),
  );

const ago = (time) => {
  if (!time) return '';
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

function formatServers(servers) {
  if (!servers.length) return 'No MCP servers configured. Add one with `mcpc add`.';
  const rows = servers.map((server) => [
    server.name,
    server.scope,
    server.transport ?? server.type,
    server.state,
    server.toolCount == null
      ? ''
      : `${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}`,
  ]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return servers
    .map((server, index) => {
      const line = rows[index]
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd();
      return server.error ? `${line}\n    ${server.error}` : line;
    })
    .join('\n');
}

function formatRequest(request) {
  const lines = [
    `${request.id}  ${request.kind} from ${request.server}${request.callId ? ` (call ${request.callId})` : ''}`,
  ];
  if (request.kind === 'elicitation') {
    lines.push(`  ${request.message ?? ''}`);
    if (request.mode === 'url') {
      lines.push(`  URL: ${request.url}`);
      lines.push(
        `  Answer: mcpc answer ${request.id} '{"action":"accept"}' after the user finished at the URL,`,
      );
      lines.push(`          or '{"action":"decline"}' / '{"action":"cancel"}'.`);
    } else {
      lines.push(`  requested schema: ${JSON.stringify(request.requestedSchema ?? {})}`);
      lines.push(`  Answer: mcpc answer ${request.id} '{"action":"accept","content":{...}}'`);
      lines.push(`          or '{"action":"decline"}' / '{"action":"cancel"}'.`);
    }
  } else if (request.kind === 'sampling') {
    if (request.systemPrompt) lines.push(`  system: ${request.systemPrompt}`);
    for (const message of request.messages ?? []) {
      const content = message.content;
      const text = content?.type === 'text' ? content.text : `[${content?.type ?? 'content'}]`;
      lines.push(`  ${message.role}: ${text}`);
    }
    if (request.maxTokens) lines.push(`  max tokens: ${request.maxTokens}`);
    lines.push(
      `  Answer: mcpc answer ${request.id} '{"text":"<your reply>"}' or '{"decline":true}'.`,
    );
  } else {
    lines.push(`  tool: ${request.tool}`);
    lines.push(`  arguments: ${JSON.stringify(request.arguments ?? {})}`);
    lines.push(`  reason: ${request.reason}`);
    lines.push(
      `  Ask the user, then: mcpc answer ${request.id} '{"outcome":"allowed-once"}' or '{"outcome":"rejected"}'.`,
    );
  }
  return lines.join('\n');
}

const progressText = (call) =>
  call.progress
    ? ` (progress ${call.progress.progress}${call.progress.total ? `/${call.progress.total}` : ''}${call.progress.message ? `: ${call.progress.message}` : ''})`
    : '';

/** Print the outcome of `call`, `wait` or `result`; returns the exit code. */
function printOutcome(outcome, out) {
  if (outcome.reason === 'request') {
    for (const request of outcome.requests) out(formatRequest(request));
    const callId = outcome.call?.id ?? outcome.requests.find((request) => request.callId)?.callId;
    if (callId) out(`Then continue with: mcpc wait ${callId}`);
    return EXIT.request;
  }
  const calls = outcome.reason === 'finished' ? outcome.calls : outcome.call ? [outcome.call] : [];
  if (outcome.reason === 'timeout' && !calls.length) {
    out('Nothing finished before the timeout.');
    return EXIT.running;
  }
  let code = EXIT.ok;
  for (const call of calls) {
    if (call.state === 'running') {
      out(
        `Call ${call.id} (${call.tool}) is still running${progressText(call)}. Wait with: mcpc wait ${call.id}`,
      );
      code = Math.max(code, EXIT.running);
    } else if (call.state === 'finished') {
      if (calls.length > 1) out(`--- ${call.id} ${call.tool}`);
      if (call.warning) out(`[warning: ${call.warning}]`);
      out(call.text ?? '');
      if (call.isError) code = Math.max(code, EXIT.failed);
    } else {
      out(`Call ${call.id} (${call.tool}) ${call.state}: ${call.error?.message ?? ''}`);
      code = Math.max(
        code,
        call.error?.code === 'server_unavailable' ? EXIT.unavailable : EXIT.failed,
      );
    }
  }
  return code;
}

function tail(file, lines) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const all = text.split(/\r?\n/);
  if (all.at(-1) === '') all.pop();
  return all.slice(-lines).join('\n');
}

/** Commands that run without the daemon. */
const local = {
  add({ options, positionals, rest }, ctx, out) {
    const name = positionals.name;
    const transport = options.transport;
    const target = rest.length ? rest[0] : positionals.target[0];
    const args = rest.length ? rest.slice(1) : positionals.target.slice(1);
    if (!target)
      throw new UsageError(
        transport === 'stdio'
          ? 'missing command: mcpc add <name> -- <command> [args...]'
          : 'missing URL',
        'add',
      );
    const config = buildServerConfig({
      transport,
      target,
      args: transport === 'stdio' ? args : undefined,
      env: options.env.length ? pairs(options.env, '=', '--env') : undefined,
      headers: options.header.length ? pairs(options.header, ':', '--header') : undefined,
      timeout: options.timeout,
    });
    return addServer(name, config, options.scope ?? 'local', ctx, out);
  },

  'add-json'({ options, positionals }, ctx, out) {
    const config = parseJson(positionals.json, 'server JSON');
    return addServer(positionals.name, config, options.scope ?? 'local', ctx, out);
  },

  remove({ options, positionals }, ctx, out) {
    const name = positionals.name;
    const scopes = options.scope ? [options.scope] : ['local', 'project', 'user'];
    for (const scope of scopes) {
      if (removeServer(ctx.files[scope], name)) {
        out(`Removed ${name} from the ${scope} scope (${ctx.files[scope]}).`);
        return EXIT.ok;
      }
    }
    throw new IpcError('unknown_server', `no server named "${name}" in ${scopes.join(', ')} scope`);
  },

  approve({ options, positionals }, ctx, out) {
    return decide('approved', options.all ? null : positionals.server, ctx, out);
  },

  reject({ positionals }, ctx, out) {
    return decide('rejected', positionals.server, ctx, out);
  },

  logs({ options, positionals }, ctx, out) {
    const name = positionals.server;
    const file = name ? path.join(logsDir(ctx.home, ctx.wsid), `${name}.log`) : ctx.logFile;
    const text = tail(file, options.tail);
    if (text === null) {
      out(`No log yet at ${file}.`);
      return EXIT.ok;
    }
    out(text);
    return EXIT.ok;
  },

  login({ positionals }) {
    throw new IpcError(
      'unsupported',
      `OAuth login is not available in this version (server ${positionals.server})`,
    );
  },

  logout({ positionals }, ctx, out) {
    out(`No stored credentials for ${positionals.server}.`);
    return EXIT.ok;
  },
};

function addServer(name, config, scope, ctx, out) {
  const { errors, warnings } = validateServer(name, config);
  if (errors.length)
    throw new UsageError(`invalid server "${name}":\n- ${errors.join('\n- ')}`, 'add');
  for (const warning of warnings) out(`warning: ${warning}`);
  writeServer(ctx.files[scope], name, config);
  out(`Added ${name} to the ${scope} scope (${ctx.files[scope]}).`);
  if (scope === 'project') {
    // The person adding a project server has approved it for this workspace.
    const loaded = loadConfig(ctx.files, { env: ctx.env, root: ctx.root });
    const resolved = loaded.servers.get(name);
    if (resolved?.scope === 'project')
      setApproval(
        approvalsFile(ctx.home, ctx.wsid),
        name,
        resolved.approvalFingerprint,
        'approved',
      );
  }
  return EXIT.ok;
}

function decide(decision, names, ctx, out) {
  const loaded = loadConfig(ctx.files, { env: ctx.env, root: ctx.root });
  const project = [...loaded.servers.values()].filter((server) => server.scope === 'project');
  const targets = names
    ? names.map((name) => loaded.servers.get(name) ?? { name, missing: true })
    : project;
  if (!targets.length) {
    out('No project servers to decide on.');
    return EXIT.ok;
  }
  for (const server of targets) {
    if (server.missing) throw new IpcError('unknown_server', `no server named "${server.name}"`);
    if (server.scope !== 'project') {
      out(`${server.name} is in the ${server.scope} scope; only project servers need approval.`);
      continue;
    }
    setApproval(
      approvalsFile(ctx.home, ctx.wsid),
      server.name,
      server.approvalFingerprint,
      decision,
    );
    out(`${decision === 'approved' ? 'Approved' : 'Rejected'} ${server.name} for ${ctx.root}.`);
  }
  return EXIT.ok;
}

/** Commands answered by the daemon: build params, then print the result. */
const remote = {
  list: {
    params: () => ({}),
    method: 'status',
    print: (result, { options }, out) => {
      const servers = options.scope
        ? result.servers.filter((server) => server.scope === options.scope)
        : result.servers;
      out(formatServers(servers));
      for (const error of result.errors) out(`config error: ${error}`);
    },
  },
  status: {
    params: () => ({}),
    print: (result, _plan, out) => {
      const { daemon } = result;
      out(
        `daemon  pid ${daemon.pid}  v${daemon.version}  started ${ago(daemon.startedAt)}  root ${daemon.root}`,
      );
      out(
        `        ${daemon.runningCalls} running calls, ${daemon.pendingRequests} pending requests`,
      );
      out(formatServers(result.servers));
      for (const warning of result.warnings) out(`config warning: ${warning}`);
      for (const error of result.errors) out(`config error: ${error}`);
    },
  },
  get: {
    params: ({ options, positionals }) => ({ server: positionals.server, probe: options.probe }),
    print: (result, _plan, out) => {
      const { status } = result;
      out(formatServers([status]));
      out(`config: ${JSON.stringify(result.config, null, 2)}`);
      if (status.serverInfo)
        out(
          `server: ${status.serverInfo.name} ${status.serverInfo.version ?? ''} (${status.era ?? 'unknown'} protocol)`,
        );
      if (status.fetchedAt) out(`tools cached ${ago(status.fetchedAt)}`);
      for (const skipped of status.skipped ?? [])
        out(`skipped tool ${skipped.name ?? '?'}: ${skipped.reason}`);
      for (const warning of result.warnings) out(`warning: ${warning}`);
      for (const error of result.errors) out(`error: ${error}`);
      if (result.probe)
        out(
          result.probe.ok
            ? `probe: ok, ${result.probe.tools} tools`
            : `probe failed: ${result.probe.error}`,
        );
      return result.probe && !result.probe.ok ? EXIT.unavailable : EXIT.ok;
    },
  },
  tools: {
    params: ({ options, positionals }) => ({
      servers: positionals.server,
      cached: options.cached,
      refresh: options.refresh,
      budget: options.budget,
    }),
    print: (result, _plan, out) =>
      out(result.text.trimEnd() || 'No MCP servers configured. Add one with `mcpc add`.'),
  },
  search: {
    params: ({ options, positionals }) => ({
      query: positionals.query.join(' '),
      limit: options.limit,
      offset: options.offset,
      full: options.full,
    }),
    print: (result, _plan, out) => {
      out(result.text.trimEnd());
      return result.items.length ? EXIT.ok : EXIT.failed;
    },
  },
  describe: {
    method: 'search',
    params: ({ options, positionals }) => ({
      query: `select:${positionals.ref.join(',')}`,
      full: options.full,
    }),
    print: (result, _plan, out) => {
      out(result.text.trimEnd());
      return result.missing?.length ? EXIT.usage : EXIT.ok;
    },
  },
  call: {
    params: async ({ options, positionals }, { stdin }) => ({
      ref: positionals.ref,
      args: await jsonInput({
        inline: positionals.json,
        file: options.argsFile,
        stdin,
        what: 'tool arguments',
        fallback: {},
      }),
      timeout: options.timeout,
      waitMs: options.waitMs,
      background: options.background,
    }),
    print: (result, _plan, out) => {
      if (result.reason === 'running') {
        out(
          `Started ${result.call.id} (${result.call.tool}). Wait with: mcpc wait ${result.call.id}`,
        );
        return EXIT.running;
      }
      return printOutcome(result, out);
    },
  },
  wait: {
    params: ({ options, positionals }) => ({
      calls: positionals.callId,
      timeoutMs: options.timeout * 1000,
    }),
    print: (result, _plan, out) => printOutcome(result, out),
  },
  cancel: {
    params: ({ positionals }) => ({ id: positionals.callId }),
    print: (result, _plan, out) => out(`Cancelled ${result.call.id} (${result.call.tool}).`),
  },
  result: {
    params: ({ positionals }) => ({ id: positionals.callId }),
    print: (result, _plan, out) => printOutcome({ reason: 'finished', calls: [result.call] }, out),
  },
  requests: {
    params: () => ({}),
    print: (result, _plan, out) => {
      if (!result.requests.length) out('No pending requests.');
      for (const request of result.requests) out(formatRequest(request));
    },
  },
  answer: {
    params: async ({ options, positionals }, { stdin }) => ({
      id: positionals.requestId,
      answer: await jsonInput({
        inline: positionals.json,
        file: options.file,
        stdin,
        what: 'answer',
      }),
    }),
    print: (result, _plan, out) => {
      out(`Answered ${result.answered}.`);
      if (result.request?.callId) out(`Continue with: mcpc wait ${result.request.callId}`);
    },
  },
  resources: {
    params: ({ positionals }) => ({ servers: positionals.server }),
    print: (result, _plan, out) => {
      for (const server of result.servers) {
        out(`## ${server.server}${server.error ? `  error: ${server.error}` : ''}`);
        for (const item of server.resources)
          out(
            `- ${item.uri}  ${item.name ?? ''}${item.mimeType ? `  ${item.mimeType}` : ''}${item.description ? ` — ${item.description}` : ''}`,
          );
        for (const item of server.resourceTemplates)
          out(
            `- template ${item.uriTemplate}  ${item.name ?? ''}${item.description ? ` — ${item.description}` : ''}`,
          );
        if (!server.resources.length && !server.resourceTemplates.length && !server.error)
          out('(no resources)');
      }
    },
  },
  read: {
    params: ({ positionals }) => ({ server: positionals.server, uri: positionals.uri }),
    print: (result, _plan, out) => out(result.text),
  },
  prompts: {
    params: ({ positionals }) => ({ servers: positionals.server }),
    print: (result, _plan, out) => {
      for (const server of result.servers) {
        out(`## ${server.server}${server.error ? `  error: ${server.error}` : ''}`);
        for (const prompt of server.prompts) {
          const args = (prompt.arguments ?? [])
            .map((arg) => (arg.required ? arg.name : `[${arg.name}]`))
            .join(' ');
          out(
            `- ${server.server}/${prompt.name}${args ? ` ${args}` : ''}${prompt.description ? ` — ${prompt.description}` : ''}`,
          );
        }
        if (!server.prompts.length && !server.error) out('(no prompts)');
      }
    },
  },
  prompt: {
    params: ({ positionals }) => {
      const items = positionals.args;
      let args = {};
      if (items.length === 1 && items[0].trim().startsWith('{'))
        args = parseJson(items[0], 'prompt arguments');
      else if (items.length) args = pairs(items, '=', 'prompt argument');
      return { ref: positionals.ref, args };
    },
    print: (result, _plan, out) => out(result.text),
  },
  restart: {
    params: ({ positionals }) => ({ servers: positionals.server }),
    print: (result, _plan, out) =>
      out(
        result.restarting
          ? 'The daemon is restarting; the next command starts a fresh one.'
          : `Reconnecting on next use: ${result.restarted.join(', ')}`,
      ),
  },
  stop: {
    method: 'shutdown',
    params: () => ({}),
    autostart: false,
    print: (_result, _plan, out) => out('The daemon is stopping.'),
  },
};

/**
 * Run the CLI.
 *
 * @param {string[]} argv arguments after `node mcpc`
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, stdout?: (text: string) => void,
 *   stderr?: (text: string) => void, stdin?: NodeJS.ReadableStream}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((text) => process.stdout.write(text + '\n'));
  const err = io.stderr ?? ((text) => process.stderr.write(text + '\n'));
  const stdin = io.stdin ?? process.stdin;

  let plan;
  try {
    plan = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`mcpc: ${error.message}`);
    err(
      error.command && !error.message.startsWith('Unknown command')
        ? `Run "mcpc ${error.command} --help" for usage.`
        : 'Run "mcpc --help" for usage.',
    );
    return EXIT.usage;
  }
  if (plan.action === 'version') {
    out(VERSION);
    return EXIT.ok;
  }
  if (plan.action === 'help') {
    out(plan.command ? commandHelp(plan.command) : rootHelp());
    return EXIT.ok;
  }
  if (plan.command === 'daemon') {
    const { runDaemon } = await import('./daemon.mjs');
    await runDaemon({ key: plan.options.key, root: plan.options.root });
    return null;
  }

  const ctx = context(plan.options, env, cwd);
  const json = plan.options.json;
  let client = null;
  try {
    if (local[plan.command]) {
      if (json) {
        const lines = [];
        const code = await local[plan.command](plan, ctx, (line) => lines.push(line));
        out(JSON.stringify({ ok: code === EXIT.ok, messages: lines }));
        return code;
      }
      return await local[plan.command](plan, ctx, out);
    }

    const spec = remote[plan.command];
    const params = await spec.params(plan, { stdin });
    client = await openDaemon({
      endpoint: ctx.endpoint,
      key: ctx.key,
      root: ctx.root,
      lockFile: ctx.lockFile,
      logFile: ctx.logFile,
      version: VERSION,
      env,
      autostart: spec.autostart !== false,
    });
    if (!client) {
      out('The daemon is not running.');
      return EXIT.ok;
    }
    const result = await client.request(spec.method ?? plan.command, params);
    if (json) {
      out(JSON.stringify(result));
      return jsonExit(plan.command, result);
    }
    const code = await spec.print(result, plan, out);
    return typeof code === 'number' ? code : EXIT.ok;
  } catch (error) {
    const code = exitCodeFor(error);
    if (json)
      out(
        JSON.stringify({
          error: { code: error.code ?? 'error', message: error.message, data: error.data },
        }),
      );
    else err(`mcpc: ${error.message}`);
    return code;
  } finally {
    client?.close();
  }
}

/** Exit codes in `--json` mode follow the same rules as text mode. */
function jsonExit(command, result) {
  if (command === 'call' || command === 'wait' || command === 'result') {
    const outcome = command === 'result' ? { reason: 'finished', calls: [result.call] } : result;
    if (outcome.reason === 'running') return EXIT.running;
    return printOutcome(outcome, () => {});
  }
  if (command === 'search') return result.items.length ? EXIT.ok : EXIT.failed;
  if (command === 'get') return result.probe && !result.probe.ok ? EXIT.unavailable : EXIT.ok;
  return EXIT.ok;
}

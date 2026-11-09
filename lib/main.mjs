// The mcpc command line. Every command connects to the servers it needs for its
// own duration (or uses a running `mcpc session`), so nothing has to outlive it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseToolRef, renderCatalog, renderDefinitions, searchTools, toolId } from './catalog.mjs';
import { UsageError, commandHelp, parse, rootHelp } from './cli.mjs';
import {
  buildServerConfig,
  loadConfig,
  readApprovals,
  redact,
  removeServer,
  setApproval,
  validateServer,
  writeServer,
} from './config.mjs';
import { Connection, ServerError, blockedReason, cacheFresh, readCache } from './connection.mjs';
import { runUpdate } from './install.mjs';
import { IpcError, trySession } from './ipc.mjs';
import {
  approvalsFile,
  configFiles,
  findWorkspaceRoot,
  logsDir,
  mcpcHome,
  projectDir,
  resultsDir,
  workspaceId,
} from './paths.mjs';
import { renderResourceContents, renderToolResult } from './render.mjs';
import { validate } from './schema.mjs';
import { runSession, sessionEndpoint } from './session.mjs';
import { VERSION } from './version.mjs';

export const EXIT = { ok: 0, failed: 1, usage: 2 };

const USAGE_CODES = new Set(['unknown_server', 'unknown_tool', 'invalid_arguments', 'bad_json']);

/** Exit code for an error raised by a command. */
export function exitCodeFor(error) {
  if (error instanceof UsageError || USAGE_CODES.has(error?.code)) return EXIT.usage;
  return EXIT.failed;
}

function context(options, env, cwd) {
  const root = findWorkspaceRoot({ cwd, env, explicit: options.cwd });
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw new UsageError(`workspace directory does not exist: ${root}`);
  const home = mcpcHome(env);
  const wsid = workspaceId(root);
  const dir = projectDir(home, wsid);
  return {
    env,
    root,
    home,
    wsid,
    projectDir: dir,
    version: VERSION,
    files: configFiles({ home, root, wsid }),
    approvalsPath: approvalsFile(home, wsid),
    resultsDir: resultsDir(home, wsid),
    logsDir: logsDir(home, wsid),
  };
}

function loadAll(ctx) {
  const loaded = loadConfig(ctx.files, { env: ctx.env, root: ctx.root });
  let approvals = { servers: {} };
  try {
    approvals = readApprovals(ctx.approvalsPath);
  } catch (error) {
    loaded.errors.push(`approvals: ${error.message}`);
  }
  return { ...loaded, approvals };
}

function serverNamed(config, name) {
  const resolved = config.servers.get(name);
  if (resolved) return resolved;
  const known = [...config.servers.keys()];
  throw new IpcError(
    'unknown_server',
    `no server named "${name}"${known.length ? ` (configured: ${known.join(', ')})` : ''}`,
  );
}

function assertUsable(config, resolved) {
  const blocked = blockedReason(resolved, config.approvals);
  if (blocked)
    throw new ServerError(resolved.name, blocked.state, `${resolved.name}: ${blocked.message}`);
}

/**
 * Run `fn` against a server through its session when one runs, otherwise over a
 * connection opened for this command.
 *
 * @template T
 * @param {any} ctx
 * @param {any} resolved
 * @param {(target: {session?: import('./ipc.mjs').IpcClient, connection?: Connection}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withServer(ctx, resolved, fn) {
  const session = await trySession(sessionEndpoint(ctx, resolved.name));
  if (session) {
    try {
      return await fn({ session });
    } finally {
      session.close();
    }
  }
  if (resolved.config.session === true) {
    throw new ServerError(
      resolved.name,
      'needs-session',
      `${resolved.name} is stateful and needs a running session. Start it in the background ` +
        `(it keeps running): mcpc session ${resolved.name}`,
    );
  }
  const connection = await Connection.open(resolved, ctx);
  try {
    return await fn({ connection });
  } finally {
    await connection.close();
  }
}

/** Tool list of a server (session, fresh cache, or a short connection). */
async function toolsOf(ctx, resolved, { refresh = false } = {}) {
  const session = await trySession(sessionEndpoint(ctx, resolved.name));
  if (session) {
    try {
      const { tools } = await session.request('tools', { refresh });
      return { tools, via: 'session' };
    } finally {
      session.close();
    }
  }
  const cache = readCache(ctx.projectDir, resolved);
  if (!refresh && cacheFresh(cache, ctx.env)) return { tools: cache.tools, via: 'cache' };
  if (resolved.config.session === true && cache?.tools) return { tools: cache.tools, via: 'cache' };
  const connection = await Connection.open(resolved, ctx);
  try {
    return { tools: await connection.listTools(), via: 'connection' };
  } finally {
    await connection.close();
  }
}

/** Catalog input for several servers, connecting only where no fresh cache exists. */
async function gather(ctx, config, names, { refresh = false } = {}) {
  const targets = names?.length
    ? names.map((name) => serverNamed(config, name))
    : [...config.servers.values()];
  return Promise.all(
    targets.map(async (resolved) => {
      const cache = readCache(ctx.projectDir, resolved);
      const entry = {
        name: resolved.name,
        transport: cache?.transport ?? resolved.type,
        instructions: cache?.instructions ?? null,
        alwaysLoad: resolved.config.alwaysLoad === true,
        status: 'ready',
        error: null,
        tools: undefined,
      };
      const blocked = blockedReason(resolved, config.approvals);
      if (blocked) return { ...entry, status: blocked.state, error: blocked.message };
      try {
        const { tools, via } = await toolsOf(ctx, resolved, { refresh });
        const fresh = readCache(ctx.projectDir, resolved);
        return {
          ...entry,
          tools,
          status:
            via === 'session' ? 'session' : resolved.config.session ? 'needs-session' : 'ready',
          transport: fresh?.transport ?? entry.transport,
          instructions: fresh?.instructions ?? entry.instructions,
        };
      } catch (error) {
        return {
          ...entry,
          status: 'failed',
          error: redact(error.message, resolved.secrets ?? []),
          tools: cache?.tools,
        };
      }
    }),
  );
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
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

function table(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column]).length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => String(cell).padEnd(widths[column]))
      .join('  ')
      .trimEnd(),
  );
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

function addServer(name, config, scope, ctx, out) {
  const { errors, warnings } = validateServer(name, config);
  if (errors.length)
    throw new UsageError(`invalid server "${name}":\n- ${errors.join('\n- ')}`, 'add');
  for (const warning of warnings) out(`warning: ${warning}`);
  writeServer(ctx.files[scope], name, config);
  out(`Added ${name} to the ${scope} scope (${ctx.files[scope]}).`);
  if (scope === 'project') {
    // Whoever adds a project server has approved it for this workspace.
    const resolved = loadConfig(ctx.files, { env: ctx.env, root: ctx.root }).servers.get(name);
    if (resolved?.scope === 'project')
      setApproval(ctx.approvalsPath, name, resolved.approvalFingerprint, 'approved');
  }
  return { added: name, scope, file: ctx.files[scope] };
}

/** Command implementations: each returns `{result, code?}` after printing through `out`. */
const commands = {
  async list({ options }, ctx, out) {
    const config = loadAll(ctx);
    const servers = [];
    for (const resolved of config.servers.values()) {
      if (options.scope && resolved.scope !== options.scope) continue;
      const cache = readCache(ctx.projectDir, resolved);
      const blocked = blockedReason(resolved, config.approvals);
      const session = blocked ? null : await trySession(sessionEndpoint(ctx, resolved.name));
      session?.close();
      servers.push({
        name: resolved.name,
        scope: resolved.scope,
        transport: cache?.transport ?? resolved.type,
        state:
          blocked?.state ??
          (session ? 'session' : resolved.config.session ? 'needs-session' : 'ready'),
        tools: Array.isArray(cache?.tools) ? cache.tools.length : null,
        fetchedAt: cache?.fetchedAt ?? null,
        note: blocked?.message ?? null,
      });
    }
    if (!servers.length) out('No MCP servers configured. Add one with `mcpc add`.');
    else {
      const rows = servers.map((server) => [
        server.name,
        server.scope,
        server.transport,
        server.state,
        server.tools == null
          ? 'tools not listed yet'
          : `${server.tools} ${server.tools === 1 ? 'tool' : 'tools'} (${ago(server.fetchedAt)})`,
      ]);
      table(rows).forEach((line, index) => {
        out(line);
        if (servers[index].note) out(`    ${servers[index].note}`);
      });
    }
    for (const error of config.errors) out(`config error: ${error}`);
    return { result: { servers, errors: config.errors, warnings: config.warnings } };
  },

  async get({ options, positionals }, ctx, out) {
    const config = loadAll(ctx);
    const resolved = serverNamed(config, positionals.server);
    const cache = readCache(ctx.projectDir, resolved);
    const result = {
      name: resolved.name,
      scope: resolved.scope,
      type: resolved.type,
      config: JSON.parse(redact(JSON.stringify(resolved.config), resolved.secrets ?? [])),
      blocked: blockedReason(resolved, config.approvals),
      serverInfo: cache?.serverInfo ?? null,
      protocol: cache?.era?.kind ?? null,
      transport: cache?.transport ?? null,
      tools: Array.isArray(cache?.tools) ? cache.tools.length : null,
      skipped: cache?.skipped ?? [],
      warnings: resolved.warnings,
      errors: resolved.errors,
      probe: null,
    };
    if (options.probe) {
      try {
        assertUsable(config, resolved);
        const { tools, via } = await toolsOf(ctx, resolved, { refresh: true });
        const fresh = readCache(ctx.projectDir, resolved);
        result.probe = { ok: true, tools: tools.length, via };
        Object.assign(result, {
          serverInfo: fresh?.serverInfo ?? result.serverInfo,
          protocol: fresh?.era?.kind ?? result.protocol,
          transport: fresh?.transport ?? result.transport,
          tools: tools.length,
          skipped: fresh?.skipped ?? [],
        });
      } catch (error) {
        result.probe = { ok: false, error: error.message };
      }
    }
    out(
      `${result.name}  ${result.scope}  ${result.type}${result.blocked ? `  ${result.blocked.state}` : ''}`,
    );
    out(`config: ${JSON.stringify(result.config, null, 2)}`);
    if (result.serverInfo)
      out(
        `server: ${result.serverInfo.name} ${result.serverInfo.version ?? ''} (${result.protocol} protocol, ${result.transport})`,
      );
    if (result.tools != null) out(`tools: ${result.tools}`);
    for (const skipped of result.skipped)
      out(`skipped tool ${skipped.name ?? '?'}: ${skipped.reason}`);
    if (result.blocked) out(result.blocked.message);
    for (const warning of result.warnings) out(`warning: ${warning}`);
    for (const error of result.errors) out(`error: ${error}`);
    if (result.probe)
      out(
        result.probe.ok ? `probe ok (${result.probe.via})` : `probe failed: ${result.probe.error}`,
      );
    return { result, code: result.probe && !result.probe.ok ? EXIT.failed : EXIT.ok };
  },

  async add({ options, positionals, rest }, ctx, out) {
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
    return { result: addServer(positionals.name, config, options.scope ?? 'local', ctx, out) };
  },

  async 'add-json'({ options, positionals }, ctx, out) {
    const config = parseJson(positionals.json, 'server JSON');
    return { result: addServer(positionals.name, config, options.scope ?? 'local', ctx, out) };
  },

  async remove({ options, positionals }, ctx, out) {
    const name = positionals.name;
    const scopes = options.scope ? [options.scope] : ['local', 'project', 'user'];
    for (const scope of scopes) {
      if (removeServer(ctx.files[scope], name)) {
        out(`Removed ${name} from the ${scope} scope (${ctx.files[scope]}).`);
        return { result: { removed: name, scope } };
      }
    }
    throw new IpcError(
      'unknown_server',
      `no server named "${name}" in the ${scopes.join(', ')} scope`,
    );
  },

  async approve({ options, positionals }, ctx, out) {
    const config = loadAll(ctx);
    const project = [...config.servers.values()].filter((server) => server.scope === 'project');
    const targets = options.all
      ? project
      : positionals.server.map((name) => serverNamed(config, name));
    if (!targets.length)
      throw new UsageError('name the servers to approve, or use --all', 'approve');
    const approved = [];
    for (const server of targets) {
      if (server.scope !== 'project') {
        out(`${server.name} is in the ${server.scope} scope; only project servers need approval.`);
        continue;
      }
      setApproval(ctx.approvalsPath, server.name, server.approvalFingerprint, 'approved');
      approved.push(server.name);
      out(`Approved ${server.name} for ${ctx.root}.`);
    }
    return { result: { approved } };
  },

  async tools({ options, positionals }, ctx, out) {
    const config = loadAll(ctx);
    const servers = await gather(ctx, config, positionals.server, { refresh: options.refresh });
    const budgetTokens = options.budget ?? (Number(ctx.env.MCPC_CATALOG_BUDGET) || 2000);
    const text = renderCatalog(servers, { budgetTokens }).trimEnd();
    out(text || 'No MCP servers configured. Add one with `mcpc add`.');
    return { result: { servers } };
  },

  async search({ options, positionals }, ctx, out) {
    const query = positionals.query.join(' ');
    const found = await find(ctx, query, options);
    out(found.text);
    return { result: found.result, code: found.result.items.length ? EXIT.ok : EXIT.failed };
  },

  async describe({ options, positionals }, ctx, out) {
    const found = await find(ctx, `select:${positionals.ref.join(',')}`, options);
    out(found.text);
    return { result: found.result, code: found.result.missing?.length ? EXIT.usage : EXIT.ok };
  },

  async call({ options, positionals }, ctx, out, io) {
    const config = loadAll(ctx);
    const ref = parseToolRef(positionals.ref, [...config.servers.keys()]);
    if (!ref)
      throw new IpcError(
        'unknown_tool',
        `cannot resolve "${positionals.ref}"; write it as server/tool (servers: ${[...config.servers.keys()].join(', ') || 'none'})`,
      );
    const resolved = serverNamed(config, ref.server);
    assertUsable(config, resolved);

    let args = {};
    if (options.argsFile)
      args = parseJson(fs.readFileSync(options.argsFile, 'utf8'), 'arguments file');
    else if (positionals.json === '-')
      args = parseJson(await readStdin(io.stdin), 'arguments on stdin');
    else if (positionals.json !== undefined) args = parseJson(positionals.json, 'tool arguments');
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new IpcError('invalid_arguments', 'tool arguments must be a JSON object');

    const id = toolId(ref.server, ref.tool);
    const raw = await withServer(ctx, resolved, async ({ session, connection }) => {
      let tool = await lookupTool(ctx, resolved, ref.tool, { session, connection });
      if (!tool) {
        const tools = session
          ? (await session.request('tools', { refresh: true })).tools
          : await connection.listTools();
        tool = tools.find((item) => item.name === ref.tool);
      }
      if (!tool)
        throw new IpcError(
          'unknown_tool',
          `${ref.server} has no tool "${ref.tool}"; see: mcpc tools ${ref.server}`,
        );

      const checked = validate(tool.inputSchema ?? { type: 'object' }, args);
      if (!checked.valid)
        throw new IpcError(
          'invalid_arguments',
          `arguments do not match ${id}:\n${checked.errors.join('\n')}`,
        );
      if (checked.warning) out(`[warning: ${checked.warning}]`);

      const result = session
        ? await session.request('call', { tool: tool.name, args, timeout: options.timeout })
        : await callWithInterrupt(connection, tool, args, options.timeout);
      return { result, meta: tool._meta };
    });

    const callId = `c-${crypto.randomBytes(4).toString('hex')}`;
    const rendered = renderToolResult(raw.result, {
      callId,
      tool: id,
      resultsDir: ctx.resultsDir,
      maxTokens: Number(ctx.env.MCPC_MAX_OUTPUT_TOKENS) || 25000,
      toolMeta: raw.meta,
    });
    out(rendered.text);
    return { result: rendered.json, code: rendered.isError ? EXIT.failed : EXIT.ok };
  },

  async resources({ positionals }, ctx, out) {
    const config = loadAll(ctx);
    const targets = positionals.server.length
      ? positionals.server.map((name) => serverNamed(config, name))
      : [...config.servers.values()].filter(
          (resolved) => !blockedReason(resolved, config.approvals),
        );
    const servers = await Promise.all(
      targets.map(async (resolved) => {
        try {
          assertUsable(config, resolved);
          const lists = await withServer(ctx, resolved, ({ session, connection }) =>
            session ? session.request('resources') : connection.listResources(),
          );
          return { server: resolved.name, ...lists };
        } catch (error) {
          return {
            server: resolved.name,
            error: error.message,
            resources: [],
            resourceTemplates: [],
          };
        }
      }),
    );
    for (const server of servers) {
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
      out('');
    }
    return { result: { servers } };
  },

  async read({ positionals }, ctx, out) {
    const config = loadAll(ctx);
    const resolved = serverNamed(config, positionals.server);
    assertUsable(config, resolved);
    const result = await withServer(ctx, resolved, ({ session, connection }) =>
      session
        ? session.request('read', { uri: positionals.uri })
        : connection.readResource(positionals.uri),
    );
    const rendered = renderResourceContents(result?.contents, {
      id: `r-${crypto.randomBytes(4).toString('hex')}`,
      resultsDir: ctx.resultsDir,
    });
    out(rendered.text);
    return { result: rendered.json };
  },

  async session({ options, positionals }, ctx, out) {
    const config = loadAll(ctx);
    const resolved = serverNamed(config, positionals.server);
    assertUsable(config, resolved);
    const existing = await trySession(sessionEndpoint(ctx, resolved.name));
    if (existing) {
      existing.close();
      throw new IpcError('already_running', `a session for ${resolved.name} is already running`);
    }
    const code = await runSession({ resolved, ctx, idleMs: options.idle * 60000, out });
    return { result: { stopped: resolved.name }, code };
  },

  async logs({ options, positionals }, ctx, out) {
    const name = positionals.server;
    if (!name) {
      const names = fs.existsSync(ctx.logsDir)
        ? fs.readdirSync(ctx.logsDir).filter((file) => file.endsWith('.log'))
        : [];
      out(
        names.length
          ? `Server logs in ${ctx.logsDir}:\n${names.map((file) => `- ${file.slice(0, -4)}`).join('\n')}`
          : 'No server logs yet.',
      );
      return { result: { logs: names } };
    }
    const file = path.join(ctx.logsDir, `${name}.log`);
    const text = tail(file, options.tail);
    out(text ?? `No log yet for ${name}.`);
    return { result: { file, text } };
  },

  async update(_plan, _ctx, out) {
    return { result: runUpdate({ out }) };
  },
};

/** Tool definition from the session or a fresh cache, without listing again. */
async function lookupTool(ctx, resolved, name, { session }) {
  if (session)
    return (await session.request('tools')).tools.find((tool) => tool.name === name) ?? null;
  const cache = readCache(ctx.projectDir, resolved);
  return cacheFresh(cache, ctx.env)
    ? (cache.tools.find((tool) => tool.name === name) ?? null)
    : null;
}

/** Call over a connection; Ctrl-C cancels the request and closes the server cleanly. */
async function callWithInterrupt(connection, tool, args, timeout) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error('interrupted'));
  process.once('SIGINT', onInterrupt);
  try {
    return await connection.callTool(tool, args, { timeout, signal: controller.signal });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

async function find(ctx, query, { limit = 5, offset = 0, full = false }) {
  const config = loadAll(ctx);
  const servers = await gather(ctx, config, []);
  const entries = servers.flatMap((server) =>
    (server.tools ?? []).map((tool) => ({ server: server.name, tool })),
  );
  const found = searchTools(entries, query, { limit, offset });
  let text = found.items.length
    ? renderDefinitions(found.items, { full }).trimEnd()
    : `No tools match "${query}".`;
  if (found.missing?.length) text += `\nNot found: ${found.missing.join(', ')}`;
  if (found.remaining > 0)
    text += `\n${found.remaining} more ${found.remaining === 1 ? 'match' : 'matches'}; next page: --offset ${found.nextOffset}`;
  for (const server of servers.filter((item) => !item.tools && item.error))
    text += `\n(${server.name} not searched: ${server.error})`;
  return {
    text,
    result: {
      items: found.items.map(({ server, tool, score }) => ({ server, tool, score })),
      total: found.total,
      remaining: found.remaining,
      nextOffset: found.nextOffset,
      missing: found.missing,
    },
  };
}

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
  const stdout = io.stdout ?? ((text) => process.stdout.write(text + '\n'));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text + '\n'));
  const stdin = io.stdin ?? process.stdin;

  let plan;
  try {
    plan = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr(`mcpc: ${error.message}`);
    stderr(
      error.command && !error.message.startsWith('Unknown command')
        ? `Run "mcpc ${error.command} --help" for usage.`
        : 'Run "mcpc --help" for usage.',
    );
    return EXIT.usage;
  }
  if (plan.action === 'version') {
    stdout(VERSION);
    return EXIT.ok;
  }
  if (plan.action === 'help') {
    stdout(plan.command ? commandHelp(plan.command) : rootHelp());
    return EXIT.ok;
  }

  const json = plan.options.json;
  const lines = [];
  // A session streams its status lines even in JSON mode; other commands collect them.
  const out = json && plan.command !== 'session' ? (line) => lines.push(line) : stdout;
  try {
    const ctx = context(plan.options, env, cwd);
    const { result, code = EXIT.ok } = await commands[plan.command](plan, ctx, out, { stdin });
    if (json && plan.command !== 'session') stdout(JSON.stringify(result));
    return code;
  } catch (error) {
    if (json)
      stdout(
        JSON.stringify({
          error: {
            code: error.code ?? 'error',
            message: error.message,
            ...(error.fix ? { fix: error.fix } : {}),
          },
        }),
      );
    else stderr(`mcpc: ${error.message}${error.fix ? `\n  -> ${error.fix}` : ''}`);
    return exitCodeFor(error);
  }
}

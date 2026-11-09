---
name: mcp-client
description: Use MCP (Model Context Protocol) servers from the shell with the mcpc CLI - list and search their tools, call them, read their resources, and keep stateful servers connected. Use when the user asks to use an MCP server or MCP tool, mentions .mcp.json or a server configured for mcpc, or a task needs an external tool that `mcpc tools` lists.
---

# Using MCP servers with mcpc

`mcpc` is an MCP client for hosts without built-in MCP support. Every command connects to the servers it needs and disconnects when it finishes, so a command can run anywhere a shell command can. Tool lists are cached on disk: discovery commands usually answer without starting a server.

## Discover, then call

1. `mcpc tools` prints a compact catalog: one block per server with its status and instructions, then one line per tool (`server/tool — first line of its description`), within a token budget. Read the server instructions; they often say how the tools fit together.
2. When the catalog says not every tool is shown, or the tool you need is not listed, run `mcpc search <terms>` (for example `mcpc search create issue`). It returns the best matches with their full input schemas. `--limit N` and `--offset N` page through more matches.
3. Before calling a tool whose schema you have not seen in this conversation, run `mcpc describe server/tool` (several refs may follow).
4. Call it: `mcpc call server/tool '{"key": "value"}'`. The arguments are checked against the tool's input schema before anything is sent.

`mcpc tools <server>` limits the catalog to one server; `mcpc tools --refresh` re-reads the tool lists from the servers (for example after a server was updated).

## Arguments and output

- Pass arguments as one JSON object. When shell quoting gets in the way (PowerShell, cmd, nested quotes), write the JSON to a file and use `--args-file <file>`, or pipe it in with `-` as the argument: `mcpc call server/tool - < args.json`. In Git Bash (MSYS) on Windows, an argument containing a path such as `/c/Users/...` is rewritten to a Windows path with backslashes, which breaks the JSON; files and stdin are passed through unchanged.
- Text results print as they are. Images, audio and binary resources are saved to files and printed as `[image image/png 12.3 KB → <path>]`; open the path when you need the content.
- A result larger than about 25000 tokens is saved to a file; you get the first 2000 characters and a line `[output truncated: … → <path>]`. Read or search that file for the rest.
- Exit codes: `0` success; `1` the tool reported an error (output starts with `Tool error:`) or a server could not be used; `2` a usage problem such as invalid arguments, an unknown server or an unknown tool. The message says what to fix.
- `--json` (on any command) prints machine-readable output instead.

## Stateful servers: sessions

Without a session, every call starts the server fresh, so state such as an open browser page or a login inside the server does not carry over to the next call. For a sequence of calls that depends on such state, keep the server connected with a session:

1. Start `mcpc session <server>` with your host's facility for long-running background commands (in Claude Code: the Bash tool with `run_in_background`). It prints `mcpc session for <server> is ready` once connected and then keeps running.
2. Call tools as usual. `mcpc call`, `mcpc tools`, `mcpc resources` and `mcpc read` use the running session automatically; `mcpc list` shows the server as `session`.
3. When the work is done, stop the background command. A session also ends by itself after 30 idle minutes (`--idle MINUTES`).

A server whose status is `needs-session` is configured as stateful: start its session before calling it. The session must stay inside the background task: a session started as a plain foreground command ends when that command returns.

## Adding and checking servers

- `mcpc list` shows every configured server with its scope, transport, status and cached tool count.
- Add a local (stdio) server: `mcpc add <name> -- <command> [args...]`, for example `mcpc add files -- npx -y @modelcontextprotocol/server-filesystem .`. Add `-e KEY=VALUE` for environment variables.
- Add a remote server: `mcpc add <name> --transport http <url>` (also `sse` or `ws`), with `-H 'Authorization: Bearer ${TOKEN}'` for headers.
- `mcpc add-json <name> '<json>'` takes the same object as an entry under `mcpServers` in `.mcp.json`, including `"session": true` for stateful servers.
- Keep secrets out of configuration files: write `${VAR}` and let mcpc read the value from the environment.
- New servers go to the private `local` scope by default; `--scope project` writes the shared `.mcp.json`, `--scope user` applies to every workspace.

Field reference, scopes and environment variables: [references/configuration.md](references/configuration.md).

## When something fails

- `mcpc get <server> --probe` connects once and reports the server name, protocol, transport, tool count and any tools that had to be skipped because their definitions were malformed.
- `mcpc logs <server>` shows the server's stderr and mcpc's connection notes.
- Status `pending-approval`: the server comes from the workspace's `.mcp.json`, which anyone with access to the repository can edit, and it runs a command on this machine. Show the user its configuration (`mcpc get <server>`) and run `mcpc approve <server>` only after the user agrees.
- A remote server that answers "requires authentication" needs a token in its headers (or an OAuth login once mcpc supports it); ask the user for the credential and pass it through an environment variable.

## Boundaries

- Tools marked `[destructive]` in the catalog may change or delete data: treat them as you treat other irreversible actions in this host, and confirm with the user when the host's rules call for it.
- mcpc runs tools with the permissions of the shell that runs it; the host's own command permissions (for example allowing `mcpc call files/*`) are the place to restrict which tools an agent may call.

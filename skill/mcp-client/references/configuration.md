# mcpc configuration reference

## Files and scopes

Servers are defined in `.mcp.json` format: `{ "mcpServers": { "<name>": { ... } } }`.

| Scope | File | Use |
|---|---|---|
| `local` (default for `mcpc add`) | `$MCPC_HOME/projects/<workspace id>/config.json` | private to this user and workspace |
| `project` | `<workspace root>/.mcp.json` | shared with everyone using the repository; needs `mcpc approve` before use |
| `user` | `$MCPC_HOME/config.json` | every workspace of this user |

When the same name appears in several scopes, local wins over project, and project over user; entries are not merged. Adding a server with `--scope project` approves it for your workspace at the same time.

The workspace root is, in order: `-C <dir>`, `MCPC_PROJECT_DIR`, the nearest directory upwards containing `.mcp.json`, the Git top level, the current directory.

## Server fields

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `stdio` (default when `command` is set), `http` (Streamable HTTP; alias `streamable-http`), `sse` (legacy HTTP+SSE), `ws` (WebSocket; alias `websocket`). A `url` without `type` is rejected. |
| `command`, `args`, `env`, `cwd` | stdio | Program to start, its arguments, extra environment variables, working directory (default: workspace root). The server inherits mcpc's environment plus `env` and `MCPC_PROJECT_DIR`. |
| `url`, `headers` | http, sse, ws | Endpoint and request headers. An `http` server that refuses Streamable HTTP is retried over SSE automatically. |
| `timeout` | all | Tool-call timeout in milliseconds (≥ 1000). |
| `startupTimeout` | all | Connection timeout in milliseconds. |
| `session` | all | `true` marks the server as stateful: calls need a running `mcpc session`. |
| `alwaysLoad` | all | `true` prints this server's tools with full definitions in `mcpc tools`. |
| `disabled` | all | `true` keeps the server configured but unused. |
| `tools` | all | `{ "include": [glob], "exclude": [glob] }` filters tool names (`*` matches any characters). |

Environment variables are expanded in `command`, `args`, `env`, `cwd`, `url` and `headers`: `${VAR}` or `${VAR:-default}`. An empty variable counts as set. Values substituted into `env` and `headers`, and values of variables whose names look secret (KEY, TOKEN, SECRET, PASSWORD, AUTH, …), are masked as `***` in messages.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MCPC_HOME` | `~/.mcpc` | Configuration, caches, logs and saved results |
| `MCPC_PROJECT_DIR` | — | Workspace root override |
| `MCPC_CATALOG_BUDGET` | `2000` | Token budget of the `mcpc tools` catalog |
| `MCPC_CACHE_TTL` | `86400000` | Milliseconds a cached tool list is used without reconnecting |
| `MCPC_STARTUP_TIMEOUT` | `30000` | Connection timeout in milliseconds |
| `MCPC_TOOL_TIMEOUT` | `43200000` | Default tool-call timeout in milliseconds (12 h) |
| `MCPC_MAX_OUTPUT_TOKENS` | `25000` | Result size (estimated tokens) above which text is saved to a file |

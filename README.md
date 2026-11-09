# mcpc

English | [中文](README.zh.md)

`mcpc` lets a host agent that can only run shell commands (such as Codex, a custom agent loop, or any harness without built-in MCP support) use [Model Context Protocol](https://modelcontextprotocol.io) servers. It ships with an agent skill that teaches the host to find tools through a compact catalog and search, read a tool's schema only when it needs it, and call it from the shell

## Early development

`mcpc` is at version 0.1.0 and has not been published yet; commands and configuration may still change, see the [changelog](CHANGELOG.md). OAuth login for remote servers is not supported yet: pass a token in a header through an environment variable instead

Installing requires **Node.js 24.9+**, **npm**, and **Git**. A workspace does not need to be a Git repository: Git only helps find the workspace root (the nearest directory with `.mcp.json`, otherwise the repository root, otherwise the working directory)

## Install

Run the following commands to install `mcpc` and add its skill to every supported harness it finds (Claude Code: `~/.claude/skills`, Codex: `~/.agents/skills`):

```bash
git clone <REPOSITORY_URL> mcpc
cd mcpc
npm ci --omit=dev
npm install -g .
mcpc install-skill
```

To choose the targets yourself, use `mcpc install-skill --host claude|codex` or `mcpc install-skill --dir <SKILLS_DIR>` (both repeatable). Running it again replaces the installed copy; a directory named `mcp-client` that holds a different skill is left alone

## Uninstall

Remove the command, then delete the skill from each harness it was installed into:

**Linux / macOS:**

```bash
npm uninstall -g mcpc
rm -rf ~/.claude/skills/mcp-client ~/.agents/skills/mcp-client
```

**Windows (PowerShell):**

```powershell
npm uninstall -g mcpc
Remove-Item -Recurse -Force "$HOME\.claude\skills\mcp-client", "$HOME\.agents\skills\mcp-client" -ErrorAction SilentlyContinue
```

Configuration, caches, logs, and saved results stay in `~/.mcpc` (or `MCPC_HOME`); delete that directory as well to remove everything

## Usage

In normal use, the host agent calls `mcpc` through the bundled skill:

- [mcp-client](skill/mcp-client/SKILL.md): how to discover and call tools, handle results and exit codes, keep stateful servers connected, and add or troubleshoot servers
- [Configuration reference](skill/mcp-client/references/configuration.md): every server field, scope, and environment variable

### Command-line workflow

For manual use or debugging, the basic flow is:

```bash
mcpc add files -- npx -y @modelcontextprotocol/server-filesystem .   # add a stdio server (local scope)
mcpc add docs https://example.com/mcp -t http -H 'Authorization: Bearer ${DOCS_TOKEN}'  # add a remote server
mcpc list                                   # configured servers with status and cached tool counts
mcpc tools                                  # compact tool catalog within a token budget
mcpc search read file                       # best matches with their input schemas
mcpc describe files/read_text_file          # full definition of a tool
mcpc call files/read_text_file '{"path": "README.md"}'  # call a tool; arguments are checked first
mcpc read files <URI>                       # read a resource (mcpc resources lists them)
mcpc get files --probe                      # connect once and report status
mcpc logs files                             # server stderr and connection notes
```

Each command connects to the servers it needs and disconnects when it finishes, so nothing has to keep running between commands. Tool lists are cached for 24 hours, which lets `tools`, `search`, and `describe` usually answer without starting a server; `mcpc tools --refresh` reads them again

`mcpc tools` prints one line per tool and fits within 2000 tokens by default, taking tools from every server in turn; when not every tool fits, it points to `mcpc search`. Large results are saved to a file with a preview, and images and binary content are saved to files whose paths are printed. The exit code is `0` on success, `1` when a tool reports an error or a server cannot be used, and `2` for a usage problem such as invalid arguments or an unknown tool; `--json` prints machine-readable output

For every option, see `mcpc <command> --help`

### Stateful servers (sessions)

Without a session, every call starts the server fresh. For a server that keeps state between calls (an open browser page, a login inside the server), run `mcpc session <SERVER>` with the host's facility for background commands; other commands then reach that server through the session over a named pipe (Windows) or a Unix socket. A server configured with `"session": true` refuses calls until its session is running. A session ends when its background command is stopped or after 30 idle minutes (`--idle MINUTES`)

### Configuration

Servers use the `.mcp.json` format, in three scopes:

| Scope             | File                                          | Use                                           |
| ----------------- | --------------------------------------------- | --------------------------------------------- |
| `local` (default) | `~/.mcpc/projects/<WORKSPACE_ID>/config.json` | This user, this workspace                     |
| `project`         | `<WORKSPACE_ROOT>/.mcp.json`                  | Shared through the repository; needs approval |
| `user`            | `~/.mcpc/config.json`                         | This user, every workspace                    |

When a name appears in several scopes, `local` wins over `project` and `project` over `user`, without merging fields. A server from `.mcp.json` can run commands on this machine, so it stays blocked until `mcpc approve <SERVER>`, and it is blocked again when its definition changes. `${VAR}` and `${VAR:-default}` are expanded from the environment each time the configuration is read, so secrets stay out of the file, and values substituted into `env` and `headers` are masked in messages:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    },
    "browser": { "command": "npx", "args": ["-y", "@playwright/mcp"], "session": true }
  }
}
```

Supported transports are `stdio`, `http` (Streamable HTTP; a server that refuses it is retried over SSE), `sse` (legacy HTTP+SSE), and `ws` (WebSocket)

### Common environment variables

| Variable                 | Description                                              | Default    |
| ------------------------ | -------------------------------------------------------- | ---------- |
| `MCPC_HOME`              | Configuration, caches, logs, and saved results           | `~/.mcpc`  |
| `MCPC_PROJECT_DIR`       | Workspace root, instead of looking it up                 | looked up  |
| `MCPC_CATALOG_BUDGET`    | Token budget of `mcpc tools`                             | `2000`     |
| `MCPC_CACHE_TTL`         | How long a cached tool list is used (ms)                 | `86400000` |
| `MCPC_STARTUP_TIMEOUT`   | Connection timeout (ms)                                  | `30000`    |
| `MCPC_TOOL_TIMEOUT`      | Default tool-call timeout (ms)                           | `43200000` |
| `MCPC_MAX_OUTPUT_TOKENS` | Result size above which text is saved to a file (tokens) | `25000`    |

## Development

```bash
npm ci                 # install dependencies, including the test fixtures' server SDK
npm test               # unit and end-to-end tests (node:test, in-process fixture servers)
npm run check          # syntax check of every module
npm run format:check   # Prettier check; npm run format rewrites
```

The end-to-end tests run the CLI against fixture servers in `test/helpers/` over stdio, sessions, Streamable HTTP, SSE, and WebSocket, all on `127.0.0.1`

## License

Copyright (C) 2026 BlueFunny & Claude, released under the [MIT](LICENSE) license

This project is not affiliated with Anthropic, OpenAI, or the Model Context Protocol project

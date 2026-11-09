# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Tool discovery for agents that pay for every token they read. `mcpc tools` prints a compact catalog of one line per tool within a token budget (2000 by default, `--budget` or `MCPC_CATALOG_BUDGET`), taking tools from every server in turn so one large server cannot crowd out the rest, and says when tools were left out. `mcpc search` ranks tools by name and description and prints the matches with their input schemas, `select:a/b,c/d` picks exact tools, and `mcpc describe` prints full definitions. Very large schemas are shortened for display. Servers marked `alwaysLoad` are shown with full definitions.
- Tool lists are cached per server for 24 hours (`MCPC_CACHE_TTL`) and the cache is tied to the server's configuration, so discovery usually needs no connection and a changed definition is never answered from an old list. One malformed tool is skipped and reported instead of breaking the server's whole list.
- `mcpc call` checks arguments against the tool's input schema before sending them and takes them inline, from `--args-file`, or from stdin. Large text results are saved to a file with a 2000-character preview; images, audio, and binary resources are saved to files whose paths are printed. Exit codes are `0` for success, `1` for a tool error or an unusable server, and `2` for a usage problem; every command can print JSON with `--json`.
- Transports: stdio, Streamable HTTP, legacy HTTP+SSE, and WebSocket, with configured headers on every remote transport. An `http` server that refuses Streamable HTTP is retried over SSE. The client negotiates the 2026-07-28 protocol and falls back to earlier versions. Stopping a stdio server closes its input first and then terminates it (on Windows, its whole process tree).
- Configuration in the `.mcp.json` format across `local`, `project`, and `user` scopes, managed with `mcpc add`, `add-json`, `remove`, `list`, and `get`. `${VAR}` and `${VAR:-default}` are expanded from the environment, and values substituted into `env` and `headers` or taken from variables with secret-like names are masked in messages. Tools can be filtered per server with `include` and `exclude` globs.
- Servers from a workspace's `.mcp.json` stay blocked until `mcpc approve`, because anyone who can edit the repository can change the commands they run; changing a definition withdraws its approval.
- `mcpc session <server>` keeps one server connected for calls that depend on state inside the server. The host runs it with its own facility for background commands, other commands reach it over a named pipe or Unix socket, it reconnects once if the server drops, and it exits after 30 idle minutes (`--idle`). A server configured with `"session": true` refuses calls without a running session.
- `mcpc get <server> --probe` reports a live connection's server name, protocol, transport, and tool count, and `mcpc logs` shows each server's stderr with mcpc's connection notes.
- The `mcp-client` skill teaches a host agent the whole workflow, with a configuration reference, and `mcpc install-skill` copies it into Claude Code (`~/.claude/skills`), Codex (`~/.agents/skills`), or any skills directory given with `--dir`.

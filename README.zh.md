# mcpc

[English](README.md) | 中文

`mcpc` 让只能执行 shell 命令的宿主 Agent（如 Codex、自建的 Agent 循环，或任何没有内置 MCP 支持的 harness）也能使用 [Model Context Protocol](https://modelcontextprotocol.io) 服务器。项目自带一个 Skill，教宿主先通过精简目录和搜索找到工具，需要时再读取工具的参数结构，然后在命令行中调用

## 早期开发

`mcpc` 当前版本为 0.1.0，尚未正式发布，命令和配置仍可能变化，详见[更新日志](CHANGELOG.md)。远程服务器暂不支持 OAuth 登录，可以改用环境变量把令牌放进请求头

安装需要 **Node.js 24.9+**、**npm** 和 **Git**。工作区不要求是 Git 仓库：Git 只用于确定工作区根目录（优先取最近的含 `.mcp.json` 的目录，其次取仓库根目录，否则取工作目录）

## 安装

运行下列命令即可安装 `mcpc`，并把 Skill 装到找到的所有受支持的 harness 中（Claude Code：`~/.claude/skills`，Codex：`~/.agents/skills`）：

```bash
git clone <REPOSITORY_URL> mcpc
cd mcpc
npm ci --omit=dev
npm install -g .
mcpc install-skill
```

如需手动指定位置，可使用 `mcpc install-skill --host claude|codex` 或 `mcpc install-skill --dir <SKILLS_DIR>`（均可重复）。重复运行会替换已安装的副本；如果同名的 `mcp-client` 目录里是别的 Skill，则不会改动

## 卸载

先移除命令，再从安装过的 harness 中删除 Skill：

**Linux / macOS：**

```bash
npm uninstall -g mcpc
rm -rf ~/.claude/skills/mcp-client ~/.agents/skills/mcp-client
```

**Windows (PowerShell)：**

```powershell
npm uninstall -g mcpc
Remove-Item -Recurse -Force "$HOME\.claude\skills\mcp-client", "$HOME\.agents\skills\mcp-client" -ErrorAction SilentlyContinue
```

配置、缓存、日志和保存的结果位于 `~/.mcpc`（或 `MCPC_HOME`），如需彻底清除，请一并删除该目录

## 使用方法

在正常使用中，宿主 Agent 会通过内置 Skill 调用 `mcpc`：

- [mcp-client](skill/mcp-client/SKILL.md)：说明如何发现和调用工具、处理结果与退出码、保持有状态服务器的连接，以及添加服务器和排查问题
- [配置参考](skill/mcp-client/references/configuration.md)：列出全部服务器字段、配置范围和环境变量

### 命令行工作流

如需手动使用或调试，基本流程如下：

```bash
mcpc add files -- npx -y @modelcontextprotocol/server-filesystem .   # 添加 stdio 服务器（local 范围）
mcpc add docs https://example.com/mcp -t http -H 'Authorization: Bearer ${DOCS_TOKEN}'  # 添加远程服务器
mcpc list                                   # 列出已配置的服务器、状态和缓存的工具数
mcpc tools                                  # 在 token 预算内显示精简的工具目录
mcpc search read file                       # 搜索最匹配的工具，附带参数结构
mcpc describe files/read_text_file          # 查看工具的完整定义
mcpc call files/read_text_file '{"path": "README.md"}'  # 调用工具，参数会先经过校验
mcpc read files <URI>                       # 读取资源（mcpc resources 可列出资源）
mcpc get files --probe                      # 连接一次并报告状态
mcpc logs files                             # 查看服务器的 stderr 和连接记录
```

每条命令只连接自己需要的服务器，执行完就断开，命令之间不需要任何常驻进程。工具列表会缓存 24 小时，所以 `tools`、`search`、`describe` 通常不用启动服务器就能给出结果；`mcpc tools --refresh` 会重新读取

`mcpc tools` 每个工具只占一行，默认控制在 2000 token 以内，从各个服务器轮流选取工具；放不下全部工具时，会提示改用 `mcpc search`。较大的结果会保存到文件并给出预览，图片和二进制内容会保存为文件并打印路径。退出码 `0` 表示成功，`1` 表示工具报错或服务器不可用，`2` 表示用法问题，比如参数不合法或工具不存在；加上 `--json` 可输出机器可读的结果

完整的命令参数请查看 `mcpc <command> --help`

### 有状态服务器（会话）

没有会话时，每次调用都会重新启动服务器。如果服务器需要在调用之间保留状态（比如打开的浏览器页面、服务器内部的登录），请用宿主的后台命令机制运行 `mcpc session <SERVER>`，之后其他命令会经命名管道（Windows）或 Unix 套接字通过这个会话访问该服务器。配置了 `"session": true` 的服务器在会话启动之前会拒绝调用。停止后台命令或空闲 30 分钟后，会话结束（可用 `--idle MINUTES` 调整）

### 配置

服务器配置使用 `.mcp.json` 格式，分为三个范围：

| 范围              | 文件                                          | 用途                       |
| ----------------- | --------------------------------------------- | -------------------------- |
| `local`（默认）   | `~/.mcpc/projects/<WORKSPACE_ID>/config.json` | 当前用户、当前工作区       |
| `project`         | `<WORKSPACE_ROOT>/.mcp.json`                  | 随仓库共享，使用前需要审批 |
| `user`            | `~/.mcpc/config.json`                         | 当前用户、所有工作区       |

同一个名字出现在多个范围时，`local` 优先于 `project`，`project` 优先于 `user`，字段不会合并。来自 `.mcp.json` 的服务器可以在本机执行命令，因此在 `mcpc approve <SERVER>` 之前会一直被拦截，定义改动后也需要重新审批。每次读取配置时都会从环境变量展开 `${VAR}` 和 `${VAR:-default}`，这样秘密不必写进文件；代入 `env` 和 `headers` 的值在提示信息中会被遮盖：

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

支持的传输方式有 `stdio`、`http`（Streamable HTTP，服务器不支持时自动改用 SSE 重试）、`sse`（旧版 HTTP+SSE）和 `ws`（WebSocket）

### 常用环境变量

| 变量                     | 说明                                   | 默认值     |
| ------------------------ | -------------------------------------- | ---------- |
| `MCPC_HOME`              | 配置、缓存、日志和保存结果的目录       | `~/.mcpc`  |
| `MCPC_PROJECT_DIR`       | 直接指定工作区根目录，不再自动查找     | 自动查找   |
| `MCPC_CATALOG_BUDGET`    | `mcpc tools` 的 token 预算             | `2000`     |
| `MCPC_CACHE_TTL`         | 工具列表缓存的有效期（毫秒）           | `86400000` |
| `MCPC_STARTUP_TIMEOUT`   | 连接超时（毫秒）                       | `30000`    |
| `MCPC_TOOL_TIMEOUT`      | 默认的工具调用超时（毫秒）             | `43200000` |
| `MCPC_MAX_OUTPUT_TOKENS` | 结果超过该大小（token）时改为保存到文件 | `25000`    |

## 开发

```bash
npm ci                 # 安装依赖，包括测试用假服务器所需的服务端 SDK
npm test               # 单元测试和端到端测试（node:test，假服务器在进程内运行）
npm run check          # 检查所有模块的语法
npm run format:check   # Prettier 格式检查；npm run format 直接改写
```

端到端测试使用 `test/helpers/` 中的假服务器，在 `127.0.0.1` 上覆盖 stdio、会话、Streamable HTTP、SSE 和 WebSocket

## 许可证

Copyright (C) 2026 BlueFunny & Claude，基于 [MIT](LICENSE) 许可证发布

本项目与 Anthropic、OpenAI 及 Model Context Protocol 项目均无官方关联

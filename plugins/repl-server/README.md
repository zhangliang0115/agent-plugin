# repl-server

一个独立运行的 MCP server：模型用 `run_script` 执行 JavaScript，脚本可以调用 Claude Code 的内置工具和第三方 MCP，只有脚本的结果和日志回到模型上下文。

- 类型：server（无宿主 adapter，`plugin.meta.json` 的 `hosts` 为 `{}`），决策见 [ADR 0007](../../docs/decisions/0007-server-and-web-package-types.md)。
- 安装：见 [INSTALL.md](INSTALL.md)。
- 变更记录：[CHANGELOG.md](CHANGELOG.md)。
- 设计：learn-ai 仓库 `claude-code/自建设计/01–05`。
- 网络：默认只监听 `127.0.0.1:8787`；脚本里的工具访问它们各自的地址。远程访问需显式 `--host` + `--allowed-hosts` + `--strict-auth`，见 [docs/protocol.md](docs/protocol.md) §1.1。

## 当前状态

**0.3.2**：MCP 端点、执行体、工具池与管理端已可运行；资源采样、审计与多客户端配额见设计文档 01–03。

## 包

| 目录 | 包名 | 作用 |
|---|---|---|
| `core/` | `@zhangliang0115/repl-server-core`（private） | 执行体、工具桥、进程账本 |
| `server/` | `@zhangliang0115/repl-server` | MCP 端点 + 管理 API + 静态资源 |
| `web/` | `@zhangliang0115/repl-server-web`（private） | 管理前端，构建产物由 server 托管 |

## 工具面

模型看到 6 或 7 个工具（有效声明 MCP tasks 扩展的客户端没有 `wait_tasks`；binding 的 `agent` 配成 `kiro` 时该声明被否决）：

```text
run_script({ code?, scriptName?, scriptVersion?, args?, activateOnSuccess?, timeout?, async?, workspace?, visibleTools?, excludeTags? })
search_tools({ query?, server?, category?, tags?, max? })
describe_tools({ names })
wait_tasks({ taskIds, timeoutMs? })
report_problem({ title, detail, severity, context? })
save_script({ runId?, scriptName?, baseVersion?, mode?, name?, description?, tags?, code?, inputSchema?, exampleArgs?, changelog? })
search_scripts({ query?, tags?, limit? })
```

结果契约、并发档位、审计与容量见 learn-ai 的设计文档 01–03。

## 配套 skill

给 agent 的使用说明在 `skills/zl-repl-server/SKILL.md`：工具发现、`run_script`、长任务、脚本库复用与失败处理。运行期还通过 MCP Skills 扩展（`io.modelcontextprotocol/skills`）以 `skill://zl-repl-server/SKILL.md` 对外提供同一份说明，见 [`docs/protocol.md`](docs/protocol.md) §3.5。`learn-ai` 仓库的 `cc-plugins/repl-server` 是同一 skill 的安装包装；改内容时两处同步。

## 开发

```bash
pnpm --filter @zhangliang0115/repl-server-core test
pnpm --filter @zhangliang0115/repl-server build
pnpm --filter @zhangliang0115/repl-server test
pnpm --filter @zhangliang0115/repl-server-web build
pnpm validate
pnpm matrix:check
```

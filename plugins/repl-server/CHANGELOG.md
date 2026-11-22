# 变更记录

## 0.2.0（2026-11-22）
### 新增
- MCP 2026-07-28 端点与 Code Mode 工具面：`run_script`、`search_tools`、`describe_tools`、`wait_tasks`、`report_problem`；同步/异步 eval 与 MCP tasks 均可运行。
- 执行体：worker 沙箱、分层超时、进程账本与启动清扫；执行会话按 `(binding, workspace)` / `(Mcp-Session-Id, workspace)` 复用，容量与 LRU 淘汰可配置。
- 第三方 MCP 连接池、内置/官方工具、懒发现、并发闸门与密钥引用；管理端覆盖服务端、工具、客户端、密钥、标签、分类、告警、AI 配置、导入导出与发现。
- 管理端 Web：概览（资源采样、实时并发、在飞 eval）、审计事件、请求记录与协议帧、报告。
- 审计 JSONL、协议帧记录、资源采样落盘（`~/.agents/repl-server/metrics/`，14 天/200MB 保留）。
- 远程访问：`--host`/`REPL_SERVER_HOST` 改绑定地址，`--allowed-hosts`/`REPL_SERVER_ALLOWED_HOSTS` 配置 Host 允许列表（支持 `*` 与 `*.ts.net`）；非 loopback 绑定强制 `--strict-auth`；管理端自动登录只对 loopback 请求生效（含 Tailscale Serve 等本机反代），`--admin-require-token` 可显式关闭。
### 修复
- 构建产物补齐 worker 入口 `dist/entry.js` 与 keeper `dist/keeper.mjs`，修复从 `dist` 启动后 `run_script` 的 WORKER_KILLED 和 `claude mcp serve` 启动失败。
- 审计事件补齐规范字段：`tool_call` 的 `args`/`argsBytes`/`mode`/`seq`，`tool_result` 的 `outBytes`/`errorCode`/`ms`/`queueMs`，`eval_start` 的 `async`/`timeoutMs`，`eval_end` 的 `layer`/`calls`/`resultBytes`；事件抽屉增加输入/输出区。
- 管理端取消 eval 写 `eval_cancel` 审计事件；`eval_end` 的 `error`/`worker_dead` 在审计状态中显示为失败。
- 卡死 eval 告警覆盖全部在飞 eval，每个 eval 只告警一次；约 2 秒未结算的取消会强制终止该执行会话的 worker。
- 内置工具 schema 在升级时按定义刷新；`wait_tasks` 的 `taskIds` 改为必填。
- `run_script` 的描述与 discover `instructions` 明确 `search_tools` / `describe_tools` 是 MCP 顶层工具，沙箱内不可调用。
- 资源与审计落盘的路径、限额与日志口径对齐设计文档。

## 0.1.0（2026-11-18）
### 新增
- 初始化 server 类插件骨架：`core` / `server` / `web` 三个包，`plugin.meta.json` 的 `hosts` 为 `{}`（ADR 0007）。
- `server` 提供最小 HTTP 入口与 `GET /health`，默认 `127.0.0.1:8787`，为后续 MCP 端点与管理 API 预留同一进程。
- `web` 与 `server` 的 esbuild 构建脚本；`web` 产物后续复制进 `server/dist/web`。

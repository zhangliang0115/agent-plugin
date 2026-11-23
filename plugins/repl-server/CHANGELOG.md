# 变更记录

## 未发布
### 新增
- 文档校验脚本：`pnpm docs:check` 校验版本副本（7 处）、`docs/protocol.md` 的数值（7 类事实，直接读运行时常量，正则失配也算失败）与 `docs/admin-api.md` 的端点表（根段级双向比对 `server/src/admin/*.ts`）；`pnpm docs:version` 按 `plugin.meta.json` 回写全部副本。
- `docs/admin-api.md`：管理端 `/admin/api/*` 的 L1 契约，从设计 03 §四、06 §五 抽出（鉴权、59 条端点总表、请求/响应形状、生效时机、SSE、审计查询、报告与告警端点、HTTP 错误码）；同时补上代码已服务但原表缺的 `/csrf`、`/session`、`/tags`、`/categories`。
- `core/src/version.ts` 改为由 `server/scripts/version.ts` 生成，`VERSION` 不再有第二处字面量。
- `tools/list` 刷新按「上游缺席即 stale」标记：新增 `markAbsentToolsStale()`，每次成功刷新把该 server 未返回的行置 `stale=1`，返回的行由 `upsertTool` 置 0，`stale_override` 不变（设计 03 §5.1、07 §1.2）。
- 连接池客户端 `listTools` 跟随 `nextCursor` 拉全分页（上限 100 页，重复 cursor 视为协议错误），让「缺席」判断有完整基准。
- 异步任务审计补齐 `async_dispatch`（`evalTaskId`/`evalId`/`ttlMs`/`exec`/身份）与 `task_cancel`（`by`/`honoured`）；binding 删除与传输销毁取消任务时也记 `task_cancel`（设计 02 §5.3）。
- `reports` 表保留策略：90 天 / 10000 行，只清 `closed` 且告警不在 `pending`/`sending` 的行，随生命周期 sweep 每小时执行（设计 06 §十 #3）。
- 显式 `timeout` 增加 L2 上限：同步 600s、异步 7200s，超出钳到上限；省略仍表示不设截止。
### 变更
- `wait_tasks` 不再声明 `idempotentHint`：它消费结果，重试返回 `ALREADY_CONSUMED`（与设计 01 §4.2 一致）。
- `TASK_TTL_MS` / `TASK_POLL_INTERVAL_MS` 改为引用 `LIMITS`，去掉与 `core/src/constants.ts` 的重复字面量。
### 文档
- `docs/protocol.md` 校正 `truncated="1"`（服务端先截断，01 §8.1）、`timeout` 上限、`wait_tasks` 注解、SDK 边界（零依赖）；`docs/plan.md` 的 `srv-00-sdk-spike` 标为已取消。
- `docs/protocol.md` 改为把管理端形状指向 `docs/admin-api.md`，不再指向设计 06–08。
- `docs/protocol.md` 明确 `wait_tasks` 的 owner 作用域：已绑定客户端跨传输会话、跨 workspace 可见（`taskIds` 必填且无按 owner 全量收取的兜底），与 `tasks/get` 同作用域；设计 02 §4.4「归属」同步为 binding 级并记录理由。

## 0.2.0（2026-11-22）
### 新增
- MCP 2026-07-28 端点与 Code Mode 工具面：`run_script`、`search_tools`、`describe_tools`、`wait_tasks`、`report_problem`；同步/异步 eval 与 MCP tasks 均可运行。
- 执行体：worker 沙箱、分层超时、进程账本与启动清扫；执行会话按 `(binding, workspace)` / `(Mcp-Session-Id, workspace)` 复用，容量与 LRU 淘汰可配置。
- 第三方 MCP 连接池、内置/官方工具、懒发现、并发闸门与密钥引用；管理端覆盖服务端、工具、客户端、密钥、标签、分类、告警、AI 配置、导入导出与发现。
- 管理端 Web：概览（资源采样、实时并发、在飞 eval）、审计事件、请求记录与协议帧、报告。
- 报告处理说明：详情页可保存 `resolution`（≤4000 字符），关闭时写 `resolved_at`、重开清空；`PATCH /admin/api/reports/:id` 支持只带 `resolution`，schema 升到 v7。
- 审计 JSONL、协议帧记录、资源采样落盘（`~/.agents/repl-server/metrics/`，14 天/200MB 保留）。
- 远程访问：`--host`/`REPL_SERVER_HOST` 改绑定地址，`--allowed-hosts`/`REPL_SERVER_ALLOWED_HOSTS` 配置 Host 允许列表（支持 `*` 与 `*.ts.net`）；非 loopback 绑定强制 `--strict-auth`；管理端自动登录只对 loopback 请求生效（含 Tailscale Serve 等本机反代），`--admin-require-token` 可显式关闭。
### 修复
- 构建产物补齐 worker 入口 `dist/entry.js` 与 keeper `dist/keeper.mjs`，修复从 `dist` 启动后 `run_script` 的 WORKER_KILLED 和 `claude mcp serve` 启动失败。
- 审计事件补齐规范字段：`tool_call` 的 `args`/`argsBytes`/`mode`/`seq`，`tool_result` 的 `outBytes`/`errorCode`/`ms`/`queueMs`，`eval_start` 的 `async`/`timeoutMs`，`eval_end` 的 `layer`/`calls`/`resultBytes`；事件抽屉增加输入/输出区。
- `run_script` 的错误信封在 V8 栈帧可用时追加用户代码的 `line`/`column`，并扣除 async IIFE 包装的一行偏移。
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

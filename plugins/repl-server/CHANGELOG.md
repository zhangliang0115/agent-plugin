# 变更记录

## 0.3.5（2026-11-27）
### 变更
- `instructions` 精简为两行（约 190 字符）：只保留一句定位和「用法见 MCP skill」的指针。执行模型、`Promise.all` 并行、结果与错误语义、异步任务等细节只留在技能正文和工具 description 里，不再两处重复。不支持技能扩展的客户端需要在本地单独安装技能。

## 0.3.4（2026-11-27）
### 变更
- `resources/list` 固定返回空数组：技能清单统一由 `skills/list` 发布，同一批 URI 不再在两处重复出现。文件内容仍按扩展规范用 `resources/read` 读取，URI 取自 `skills/list` 的 `resources` 字段。

## 0.3.3（2026-11-27）
### 修复
- 新增 `resources/templates/list`，返回空的 `resourceTemplates`。此前该方法落到 `-32601`，server 声明了 resources 能力却不响应模板列表，Kiro 等客户端会记一条错误。

## 0.3.2（2026-11-27）
### 修复
- 管理端侧边栏的版本号不再写死，改为从 `/health` 读取，跟随实际运行的二进制；此前一直显示构建时手写的 v0.2.0。

## 0.3.1（2026-11-27）
### 变更
- 插件启动器修复：健康检查比对 `version`，与插件版本不一致时停掉占用端口的旧进程再起新的（只针对 LISTEN 进程，不再误伤连着管理端的浏览器）；下载改为优先 `curl`，走系统代理，node fetch 作兜底；启动等待从 8s 提到 20s。

## 0.3.0（2026-11-27）
### 新增
- 本地 OAuth 2.1 授权服务器（`docs/protocol.md` §2.1）：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/register`（动态注册）、`/authorize`（授权页）、`/token`（授权码 + PKCE S256、refresh 轮换）；`/mcp` 的 401 带 `resource_metadata`，MCP 客户端可以自动发现并完成授权。授权页可从 `client_bindings` 选择归属，token 继承完整绑定配置；选择不绑定时为 `unbound`。
- OAuth 授权持久化（`oauth_authorizations`，schema v11）：token 在服务重启后仍有效，access 与 refresh 均为 365 天；管理端 `GET /admin/api/clients` 的 `oauthAuthorizations` 字段列出在线授权的客户端、绑定与到期时间。
- MCP Skills 扩展（`io.modelcontextprotocol/skills`）：`server/discover` 声明 `resources` 与 skills 扩展，新增 `skills/list`、`skills/get`、`resources/list`、`resources/read` 发布内置 `skills/zl-repl-server/SKILL.md`（完整文件清单、sha256 摘要、5 分钟公共缓存）；构建把 `skills/` 复制到 `dist/skills/`，legacy `initialize` 的 capabilities 不变。
- 文档校验脚本：`pnpm docs:check` 校验版本副本（7 处）、`docs/protocol.md` 的数值（7 类事实，直接读运行时常量，正则失配也算失败）与 `docs/admin-api.md` 的端点表（根段级双向比对 `server/src/admin/*.ts`）；`pnpm docs:version` 按 `plugin.meta.json` 回写全部副本。
- `docs/admin-api.md`：管理端 `/admin/api/*` 的 L1 契约，从设计 03 §四、06 §五 抽出（鉴权、59 条端点总表、请求/响应形状、生效时机、SSE、审计查询、报告与告警端点、HTTP 错误码）；同时补上代码已服务但原表缺的 `/csrf`、`/session`、`/tags`、`/categories`。
- `core/src/version.ts` 改为由 `server/scripts/version.ts` 生成，`VERSION` 不再有第二处字面量。
- `tools/list` 刷新按「上游缺席即 stale」标记：新增 `markAbsentToolsStale()`，每次成功刷新把该 server 未返回的行置 `stale=1`，返回的行由 `upsertTool` 置 0，`stale_override` 不变（设计 03 §5.1、07 §1.2）。
- 连接池客户端 `listTools` 跟随 `nextCursor` 拉全分页（上限 100 页，重复 cursor 视为协议错误），让「缺席」判断有完整基准。
- 异步任务审计补齐 `async_dispatch`（`evalTaskId`/`evalId`/`ttlMs`/`exec`/身份）与 `task_cancel`（`by`/`honoured`）；binding 删除与传输销毁取消任务时也记 `task_cancel`（设计 02 §5.3）。
- `reports` 表保留策略：90 天 / 10000 行，只清 `closed` 且告警不在 `pending`/`sending` 的行，随生命周期 sweep 每小时执行（设计 06 §十 #3）。
- 显式 `timeout` 增加 L2 上限：同步 600s、异步 7200s，超出钳到上限；省略仍表示不设截止。
### 变更
- 分发方式改为 GitHub Release：`server/scripts/release.mjs` 把 `dist` 打成 `repl-server-<版本>.tar.gz` 并上传同名 `.sha256`，tag 为 `v<server 版本>`。Claude Code 插件（learn-ai 的 `cc-plugins/repl-server`）首次启动时下载并校验该资产，删掉了写死的本机仓库路径，换机器后无需本地构建。
- 异步派发统一使用 MCP task id：`run_script` 的所有异步路径都创建 MCP task，`wait_tasks` 的 `taskIds` 元素改为传 `t_...`（原为 core 的 eval 任务 id），事件里的 `taskId` 也映射回对应的 `t_...`；core 的 eval 任务 id 不再出现在客户端可见字段里。
- 有效声明 MCP tasks 的客户端（请求声明且 binding 的 `agent` 不是 `kiro`），`run_script({ async: true })` 返回 `CreateTaskResult`，由客户端自己 `tasks/get` 轮询；其余客户端得到字段相同的 `resultType: "complete"` 结果（含 `content`），用 `wait_tasks` 收取。`wait_tasks` 只对无有效声明的客户端暴露，有效声明方调用返回 `-32602`。
- `client_bindings` 新增 `agent`（`claude-code` / `kiro` / null，schema v10），管理 API 与客户端页面可编辑；迁移按 label 回填。`agent = kiro` 用于否决请求里的 tasks 声明，因为 Kiro 会拒绝 `resultType: "task"`，且其 complete 校验要求 `content`。
- `wait_tasks` 不再声明 `idempotentHint`：它消费结果，重试返回 `ALREADY_CONSUMED`（与设计 01 §4.2 一致）。
- `TASK_TTL_MS` / `TASK_POLL_INTERVAL_MS` 改为引用 `LIMITS`，去掉与 `core/src/constants.ts` 的重复字面量。
### 文档
- `docs/protocol.md` 校正 `truncated="1"`（服务端先截断，01 §8.1）、`timeout` 上限、`wait_tasks` 注解、SDK 边界（零依赖）；`docs/plan.md` 的 `srv-00-sdk-spike` 标为已取消。
- `docs/protocol.md` 改为把管理端形状指向 `docs/admin-api.md`，不再指向设计 06–08。
- `docs/protocol.md` 明确 `wait_tasks` 的 owner 作用域：已绑定客户端跨传输会话、跨 workspace 可见（`taskId` 必填且无按 owner 全量收取的兜底），与 `tasks/get` 同作用域；设计 02 §4.4「归属」同步为 binding 级并记录理由。

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

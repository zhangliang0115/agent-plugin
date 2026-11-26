# 管理端 HTTP API（`/admin/api`）

> **层级**：L1 契约，与 [`protocol.md`](protocol.md) 并列——那份管 MCP 端点，这份管管理端 HTTP 端点。
> **权威顺序**：代码（`server/src/admin/*.ts`）→ 本文。两者不一致时先判断谁对，再改另一方，不默认以本文为准。
> **校验**：`corepack pnpm docs:check` 跑 `server/scripts/doc-admin.ts`，比对本文端点总表与代码路由，失配即失败。
> **设计依据**：learn-ai `claude-code/自建设计/` 03 §四（已迁出，仅留设计判断）、06 §五（同）；UI 在 03 §4.7–4.8。
> **不在本文**：管理端 UI 的信息架构与视觉要求（设计 03 §4.7–4.8）、报告状态机与 `alert_error` 码族（设计 06 §5.4）。

## 1. 鉴权与信任边界

Admin 走 `/admin/*`：同源 Cookie 或 Bearer `<admin-token>`，校验 Origin 与 Host。

- 两个 token 首次启动生成，写 `~/.agents/repl-server/{mcp,admin}-token`，0600。
- **管理端引导**：首次启动在终端打印 `http://127.0.0.1:8787/admin?token=<一次性>`；浏览器提交后换成 HttpOnly、SameSite=Strict 的会话 Cookie。`GET /admin/api/csrf` 下发 CSRF token，后续写请求带 `X-CSRF-Token`。Bearer admin-token 只用于本机 CLI，不进浏览器 localStorage。
- 默认只绑 `127.0.0.1`，校验 `Host` 为 `127.0.0.1|localhost`，防 DNS rebinding。远程访问用 `--host` 绑定其他地址，`--allowed-hosts` 显式放行域名（逗号分隔，支持 `*` 与 `*.ts.net`）；非 loopback 绑定必须同时开 `--strict-auth`，否则拒绝启动。
- **自动登录边界**：静态 GET 用 `admin-token` 换 session 只对来自 loopback 的请求生效——本机浏览器直连，或 Tailscale Serve 等本机反代。直连 8787 的远程客户端仍需 token；`--admin-require-token` 可完全关闭自动登录。关闭后管理端只能通过 `/admin?token=` 或一次性 bootstrap token 进入。
- Admin 的 Cookie 会话写请求要求同源 `Origin` 和 `X-CSRF-Token`；Bearer `admin-token`（本机 CLI）不校验 CSRF。
- **必须明确**：新增 stdio server 等于允许任意命令执行。UI 上二次确认并回显 command，不能用"只绑回环"一笔带过。

**权限模型**：只区分「持有 admin 凭证」与「没有」，不做多用户、角色或按资源的细粒度鉴权。前提是默认只绑 loopback 的单机单用户部署；一旦按 `INSTALL.md` 开远程访问或接入多客户端，前提失效，本节的 Host 校验、严格模式与自动登录边界必须重新评估（只留痕，不预先加固）。

## 2. 端点总表

前缀 `/admin/api`。202 表示返回 operation id，进度走 `/events`，断线后用 `GET /operations/:id` 补偿。

| 方法 | 路径 | 作用 | 同步性 |
|---|---|---|---|
| GET | `/overview` | 进程、容量、池、活跃会话、按 binding 的实时并发、在飞 eval 列表、资源采样 | 同步 |
| POST | `/evals/:exec/:evalId/cancel` | 先协作取消，约 2 秒仍未结算则强制停止该执行会话的 worker；请求到达时不存在或已结束返回 404 `EVAL_NOT_FOUND`（宽限期内完成的仍算成功取消） | 同步，宽限约 2s + 终止最多 3s + 可能的 serve 重启 |
| GET | `/settings` | capacity、strict_auth 等运行配置 | 同步 |
| PATCH | `/settings` | 校验容量关系（如 `maxServeProcesses ≥ maxExecSessions`）后写 settings，bump revision | 同步 |
| GET | `/operations/:id` | 202 操作的当前状态与结果（**尚未接线**，见 §10） | 同步 |
| GET | `/csrf` | 下发 CSRF token；Cookie 会话返回当前 token，Bearer 调用返回 `null` | 同步 |
| DELETE | `/session` | 注销：撤销服务端会话并清 HttpOnly Cookie | 204 |
| GET | `/servers` | server 列表（配置 + 运行状态 + 工具计数 `enabledToolCount`/`toolCount`，按 `tools` 表分组统计） | 同步 |
| POST | `/servers` | 注册 | 同步落库，连接异步 |
| PATCH | `/servers/:id` | 改配置 | 同步落库，重连异步 |
| DELETE | `/servers/:id` | 删除 | 同步（默认 drain） |
| POST | `/servers/:id/connect` | 连接 | 202 |
| POST | `/servers/:id/disconnect` | 断开 | 202 |
| POST | `/servers/:id/restart` | 重启 | 202 |
| POST | `/servers/:id/test` | 临时连接并 `tools/list`，不落库 | 同步，10s |
| POST | `/servers/:id/tools/refresh` | 重拉工具列表 | 202 |
| GET | `/servers/:id/tools` | 工具列表（上游 + 生效值） | 同步 |
| POST | `/servers/:id/tools/discover` | 扫描懒加载工具；`preview=true`（默认）只预览，`false` 应用 | 同步，最长 30s |
| PATCH | `/tools/:serverId/:name` | 改描述/启停/并发/标签/类型 | 同步，下次 eval 生效 |
| POST | `/tools/:serverId/:name/test` | 真实调用一次工具，返回结果并写 `tool_test` 审计；不计入 `tool_usage` | 同步，受 `timeoutMs` 限制（默认 10s，上限 60s） |
| POST | `/tools/batch` | 批量修改 | 同步，事务 |
| GET | `/tags` | 标签字典；未保存过返回内置默认（20 项，不含动作键），显式保存 `[]` 后返回空数组。字段与校验规则见设计 03 §九 | 同步 |
| PUT | `/tags` | 全量替换；必须带 `If-Match`，缺失 400 `IF_MATCH_REQUIRED`，不匹配 409 `REVISION_CONFLICT` | 同步 |
| GET | `/categories` | 分类字典；未保存过返回内置默认（10 项），显式保存 `[]` 后返回空数组。字段与校验规则见设计 03 §九 | 同步 |
| PUT | `/categories` | 全量替换；`If-Match` 语义同 `/tags` | 同步 |
| GET | `/search` | 用同一检索器预览 | 同步 |
| GET | `/clients` | 绑定列表 + 全部传输会话（含 `clientName` / `clientVersion`）+ `oauthAuthorizations`（OAuth 客户端名、`bindingId`、`createdAt`、`accessExpiresAt`、`refreshExpiresAt`）；每个绑定的 `activeSessions` 只计 15 分钟内活跃的会话，窗口由 `activeWindowMs` 回显 | 同步 |
| POST | `/clients` | 创建绑定并返回 token 明文；token 同时存本机 `state.db`，管理端可再次查看/复制，轮换后旧 token 立即失效 | 同步 |
| PUT | `/clients/:id` | 默认 workspace、可见范围、配额；**销毁该 binding 的执行会话（跨传输会话）** | 同步 |
| DELETE | `/clients/:id` | 删除绑定，token 立即失效；同样销毁该 binding 的执行会话 | 同步 |
| GET | `/secrets` | 键名为「存储中已有的键名 ∪ server `env`/`headers`/`args` 里的 `$secret` 引用名」；只返回键名与是否已设置，不返回值。字面 env/header 值是普通配置，不当作密钥列出 | 同步 |
| POST | `/secrets/:name/reveal` | 显式查看单个密钥明文；`no-store`，非列表接口 | 同步 |
| PUT | `/secrets/:name` | 写入钥匙串/加密存储；`env`、`headers`、`args`、`url` 共用 | 同步 |
| DELETE | `/secrets/:name` | 删除单个密钥，返回 `{ name, deleted }`；不检查引用，删掉仍被引用的键会让下次连接报缺失 | 同步 |
| GET | `/ai/config` | 读 AI 配置与有效值 | 同步 |
| PUT | `/ai/config` | 整体替换 AI 配置 | 同步，必须 `If-Match` |
| POST | `/ai/propose` | 一句话/粘贴配置 → server 配置草稿 | 同步，受 `timeoutMs` 限制 |
| POST | `/ai/propose/apply` | 确认草稿 → 创建 server | 同步 |
| POST | `/ai/annotate/:serverId` | `mode=preview/apply` 生成标注草稿或写入标注；自动标注失败后也可用 `apply` 重试 | 同步 |
| GET | `/ai/annotations/pending` | 自动标注应用失败列表（含 `error.code/message` 与 `proposed`） | 同步 |
| GET | `/events` | SSE 事件流，支持 `Last-Event-ID` 回放 | 长连接 |
| GET | `/config/export` | 导出声明式 JSON | 同步 |
| POST | `/config/import` | 导入（可 dry-run） | 202 |
| GET | `/logs/query` | 按条件查事件，cursor 分页 | 同步，流式过滤 |
| GET | `/logs/evals/:exec/:evalId` | 一次 eval 的事件（`tool_*` 事件不带 `exec`，会被过滤掉）；`evalId` 只在执行会话内唯一，路径必须带 `exec` | 同步 |
| GET | `/logs/sessions` | 执行会话列表 | 同步 |
| GET | `/logs/frames` | 协议帧对（请求 + 响应） | 同步 |
| GET | `/logs/payload` | 按行上的 `*Ref` 读载荷正文 | 同步，单次最多 8 MiB |
| GET | `/logs/stats` | 聚合统计 | 同步，结果缓存 10s，后台 worker 扫描 |
| GET | `/logs/stream` | 审计实时追加（SSE），支持 `Last-Event-ID` 回放 | 长连接 |
| GET | `/logs/export` | 导出筛选结果（JSONL） | 同步 |
| POST | `/discover` | 本地环境探测建议 | 同步，5s |
| POST | `/reports` | 管理端提交报告 | 同步（只落库，不等待告警） |
| GET | `/reports` | 报告列表，cursor 分页 | 同步 |
| GET | `/reports/:id` | 报告详情（含 detail/context） | 同步 |
| PATCH | `/reports/:id` | 改状态和/或处理说明 | 同步 |
| POST | `/reports/:id/retry-alert` | 把非 sent 终态重置为 pending 并 kick | 同步（不等待投递） |
| GET | `/alerts/config` | 读告警配置；webhook 只给 configured/键名 | 同步 |
| PUT | `/alerts/config` | 改告警配置；可写/清除 webhook | 同步 |
| POST | `/alerts/test` | 发一条测试消息 | 同步，排入同一发送队列；最长约 10.5s + 队列/冷却等待 |
| POST | `/alerts/preview` | 渲染一条合成报告的企业微信消息 | 同步，不发网络 |
| GET | `/scripts` | 脚本列表，按状态/关键词过滤、游标分页 | 同步 |
| GET | `/scripts/:id` | 脚本元数据与 active 版本号 | 同步 |
| PATCH | `/scripts/:id` | 改名称/描述/标签/状态 | 同步 |
| GET | `/scripts/:id/versions` | 版本列表（不含 code） | 同步 |
| GET | `/scripts/:id/versions/:version` | 版本详情（含 code/inputSchema/exampleArgs） | 同步 |
| POST | `/scripts/:id/versions` | 管理端编辑生成 draft（mode 固定；exact 需 `runId`） | 同步，201 |
| POST | `/scripts/:id/versions/:version/activate` | 激活或回滚到指定版本 | 同步 |
| GET | `/scripts/:id/versions/:version/diff` | 与 `baseVersion` 的逐行 diff | 同步 |
| GET | `/scripts/:id/runs` | 该脚本的执行历史，游标分页 | 同步 |
| POST | `/scripts/:id/test` | 管理端同步测试（`purpose='test'`） | 同步 |
| GET | `/script-candidates` | 候选列表，按状态过滤、游标分页 | 同步 |
| POST | `/script-candidates/scan` | 扫描成功代码执行，聚类并生成/刷新候选 | 同步，AI 建议受 `ai.timeoutMs` 限制 |
| POST | `/script-candidates/:id/accept` | 接受候选，生成 draft 脚本 | 同步 |
| POST | `/script-candidates/:id/reject` | 拒绝候选 | 同步 |

**资源采样**：`/overview` 的 `resources` 返回 `{ intervalMs, current, series }`。每项采样含 `ts`、`selfRssBytes`、`childRssBytes`、`childCount`、`totalRssBytes`、`selfCpuPercent`、`childCpuPercent`、`totalCpuPercent`、`children`（后代中 RSS 最大的前 5 个，每项 `{ pid, rssBytes, command }`，`command` 为前 3 个 token 的进程标识、已做值级脱敏、没有命令时为空字符串；没有后代时为空数组）；默认每 10s 采样一次、保留 30 分钟。主进程值来自 `process.memoryUsage().rss` 与两次 `process.cpuUsage()` 的差值（单核百分比）；worker 是 `worker_threads`，其内存/CPU 计入主进程。子进程统计本进程的全部后代（keeper、`claude mcp serve`、第三方 MCP server、eval 派生的进程），按 `ps` 的 `%cpu` 求和，口径不是区间瞬时值。`ps` 失败时沿用上一次子进程值，只记限频 warn。子进程 RSS 合计超过 1 GiB 时写一条 `level=warn, scope=memory` 日志（含总量与前 5 子进程摘要），并写 `memory_warning` 审计事件（字段 `childRssBytes`、`totalRssBytes`、`children`），每小时最多一次。每次采样同时追加到 `~/.agents/repl-server/log/metrics-YYYY-MM-DD.jsonl`（UTC 日期，0600，`event=resource_sample`，同样带 `children`），供后续离线分析；保留由统一的清理服务负责（`log/` 整体 90 天 / 2 GiB，按天整删），写盘失败只记限频 warn，不影响采样。

**实时并发**：`/overview` 的 `bindings` 返回每个 binding 的 `label`、`execSessions`、`inFlightEvals`、`inFlightCalls`、`queuedCalls`；未绑定客户端归到 `binding: null`。前三项来自执行会话注册表，后两项来自池闸门，页面每 5 秒随 `/overview` 刷新。

**在飞 eval**：`/overview` 的 `evals` 返回 `{ total, items }`，`items` 按 `startedAt` 升序（最老在前），`total` 是 `limit`（默认 200）截断前的总数。每项含 `exec`、`evalId`、`binding`、`workspace`、`async`、`startedAt`、`ageMs`，有超时预算时带 `timeoutMs`。`POST /evals/:exec/:evalId/cancel` 成功返回 `{ ok: true }`；404 只在请求到达时该 eval 不在执行会话的 `activeEvals` 中（不存在或已结束）时返回，body 为 `{ error: { code: "EVAL_NOT_FOUND", message: "..." } }`，宽限期内 eval 自行结束仍返回 200（幂等成功）。每次取消写一条 `eval_cancel` 审计事件（`exec`、`evalId`、`by: "admin"`、`binding`/`client`/`mcp`），与强制路径结算的 `eval_end`（`outcome: "worker_dead"`）区分。取消是协作式的：先走 `abortEval` 中止（停止接受新工具调用、abort 在飞调用，调用方收到 `EVAL_CANCELLED`），脚本可以捕获后继续；若约 2 秒后该 eval 仍未结算（例如脚本停在纯 JS Promise 上、没有工具调用可中止），调用 core 的 `hardStop(session, active, 'wall')` 强制终止该执行会话的 worker，调用方收到 `WORKER_KILLED`，异步任务按 `eval_end.outcome` 进入 `wait_tasks`（`worker_dead` → `failed`），并连带终止同一执行会话内其它在飞 eval；强制路径把该 eval 以 `outcome: "worker_dead"` 结算（不是 `cancelled`）。worker 终止失败、此前有在飞调用或 serve 不健康时按硬墙规则重启 serve。服务端每 60 秒检查全部在飞 eval，每个 eval 首次满 30 分钟时各写一条 `level=warn, scope=eval` 日志（字段 `exec`、`evalId`、`binding`、`workspace`、`ageMs`），结束后从告警集合移除。阈值暂为常量，不提供环境变量。

## 3. 请求与响应形状

注册：

```jsonc
// POST /admin/api/servers
{
  "id": "pg", "label": "PostgreSQL", "transport": "stdio",
  "command": "npx", "args": ["-y", "@mcp/pg"],
  "envKeys": ["DATABASE_URL"],        // 值走 secrets
  "headerKeys": ["Authorization"],    // 远程 HTTP 的鉴权头同样只声明键名
  "enabled": true, "connectMode": "eager",
  "summary": "database — query, list, insert, migrate",
  "tags": ["db", "sql"], "timeoutMs": 60000, "maxConcurrency": 8
}
→ 201 { "server": { "...": "...", "state": "idle" }, "revision": 43 }
```

键名规则：`envKeys` / `env` 匹配 `[A-Za-z_][A-Za-z0-9_]*`；`headerKeys` / `headers` 匹配 `[A-Za-z0-9._-]+`（HTTP token 子集，`IJ_MCP_SERVER_PROJECT_PATH` 这类下划线名合法），含空格、冒号等字符返回 400 `INVALID_FIELD`。同一规则用于 `POST /servers`、`PATCH /servers/:id`、发现页注册与 AI 草稿校验；管理端表单在提交前做同样检查。

`envKeys` / `headerKeys` 的含义是「这个键的值从密钥存储取」：新键绑定到同名密钥（`env.KEY ← KEY`），已有字面量也改为 `$secret`；**已有 `$secret` 引用的键保持原目标不变**（发现导入的 `disc.<serverId>.*` 绑定不会因编辑表单整体重提交而被改写）。`PATCH` 只新增/覆盖列出的键，不删除未列出的键；要移除某个 env/header，提交不含该键的完整 `env` / `headers` 对象（`null` 不是合法值，按 400 `INVALID_FIELD` 处理）。

改工具：

```jsonc
// PATCH /admin/api/tools/pg/query
{ "description": "Run a read-only SQL query.", "enabled": true,
  "concurrency": "parallel", "tags": ["query-planning"], "type": "query" }
→ 200 { "tool": {...}, "revision": 44 }
```

管理端 UI 已不再编辑 `type`；`type` 保留为兼容字段与管理端检索过滤器。`type` 与 `tags` 都不承载动作语义：`read`、`write`、`query`、`exec`、`deploy`、`destructive` 是动作键，不能作为标签。

`GET /servers/:id/tools`（以及 `PATCH /tools/:serverId/:name`、`POST /tools/batch` 返回的 `tool`）每个工具还带：

- `callCount` / `successCount` / `successRate` / `lastCalledAt`：终身累计。第三方工具与脚本内调用来自 `tool_result` 审计事件；顶层 builtin（`run_script`、`search_tools` 等）不产生 `tool_result`，由 `tools/call` 的 `onUsage` 直接写入 `tool_usage`。每次调用（成功或失败）计 1 次，`successCount` 只计 `ok=true`；`successRate = callCount > 0 ? successCount / callCount : null`；`lastCalledAt` 是最近一次调用的 ISO 8601 时间，从未调用时为 `null`（`callCount`/`successCount` 为 0）。`tool_call` 没有成败、`tool_denied` 没有结果，都不计数；管理端工具测试（`POST /tools/:serverId/:name/test`）走独立通道、不计入。工具删除后统计保留，同名工具重新出现时继承。
- `modelBytes`：模型可见内容的 UTF-8 JSON 字节数（`Buffer.byteLength`，不是 token 数），四个键：
  - `definition`：`JSON.stringify({ name, description, inputSchema })` 的 UTF-8 字节，即完整工具定义；只含这三个字段，不含上游工具定义里的 `_meta`、`annotations` 等其余字段。`name` 是模型看到的工具名——MCP 工具为 `server.tool`，official/builtin 为裸名；`description` 是生效描述（`description_override` 优先，缺省为空串）。
  - `searchItem`：该工具作为 `search_tools` 结果项时的 UTF-8 字节，复用检索层的 `toItem`（`JSON.stringify(toItem(catalogTool, name))`）。形状是 `SearchToolItem`：必有 `name`（同为模型可见工具名）与 `kind`；MCP 工具带 `server`；server 配置了分类/摘要时带 `category` / `summary`；带生效 `description`；server 标签与工具标签的并集非空时带 `tags`。排序用的 `score` 不写进条目。与 `GET /search` 的 `SearchHit` 不同：后者带 `score`，且没有 `category` / `summary`。
  - `schema`：`JSON.stringify(inputSchema ?? {})` 的 UTF-8 字节，schema 缺失时按空对象计。
  - `description`：生效描述字符串（`description_override` 优先）的 UTF-8 字节数，不是 JSON 编码后的长度。

**标签规则**（`server/src/catalog/tag-policy.ts`，server 与工具共用）：

- server `tags` 0–2 个，只放对该 server 所有工具都成立的描述性标签。
- 工具 `tags` 与 server 标签取并集后必须 1–4 个；工具自身不得重复 server 标签。
- 违反时返回 422 `TAG_POLICY_VIOLATION`，`details.errors` 列出原因。创建或 PATCH server 时校验 server 标签；PATCH 改变 server 标签时复检该 server 下所有 enabled 工具，任一工具超限或重复则整体拒绝、不写库；写工具标签或把工具改为 `enabled: true` 时校验该工具。AI 标注 apply 走同一套规则：server 标签实际变化时同样复检全部 enabled 工具，不只 `toolOverrides` 里列出的工具（设计 08 §4.5）。

**AI 标注的自动应用**（设计 08 §4.7）：

- 工具索引完成（`tools/list` 写入、refresh、restart）后，`ai.enabled` 与 `ai.autoAnnotate` 都开启且 server 不是 builtin/seed、至少 1 个工具、summary/category 有空缺或某 enabled 工具的生效标签（`server tags ∪ tool tags`）不满足 1–4/不重复/禁动作键时，服务端生成标注并直接写库。`server tags` 允许为 0：摘要/分类齐全且所有 enabled 工具生效标签合法即跳过。导入配置与 AI 生成配置创建 server 后经首次 `tools/list` 汇入同一流程。
- 提交体只补空字段：当前 `summary`/`category` 非空时不提交，为空时只提交非 null 非空值；空 `tags` 与空 `toolOverrides` 省略；`categorySuggestion`/`tagSuggestions` 不提交。因此已有的人工 summary/category 不会被覆盖，null 也不会清空已有值，自动路径只用字典已有 key，不新增字典项。
- `expectedRevision` 取当前 `meta.revision`；409 `REVISION_CONFLICT` 重取 revision 重试一次，仍失败进入失败队列。
- 成功不产生 pending，写一条结构化日志（`server`（serverId）、`changed`、`warnings`、`source=auto`）；失败（`TAG_POLICY_VIOLATION` / `AI_ANNOTATION_INVALID` / `AI_UNKNOWN_TOOL` / 模型调用失败等）把 `proposed`、`warnings`、`omittedTools` 与 `error` 写入 `GET /ai/annotations/pending`，不抛到工具索引路径，也不自动重试。入队前清空 `proposed.categorySuggestion` 与 `tagSuggestions`，保证 UI 重试走手动 apply 时也不写新字典项。预检失败（`AI_PROMPT_TOO_LARGE`）不消耗尝试额度、不入队。
- server 被 PATCH、refresh 或删除后丢弃该 server 的失败项；手动 apply 成功也会清空。`autoAnnotate=false` 时不自动预览/应用，手动 `preview`/`apply` 不受影响。

`concurrency` **只对第三方 MCP 工具生效**：执行它的是池侧 `ServerGates` / `PoolGates`，声明值就是真相。官方工具（`__official__`）那一列只是标注——`claude mcp serve` 不导出 `isConcurrencySafe`，网关按工具类型自己判定（同路径 `Edit` 串行、写模式 `Bash` 单道、其余并行），审计行的 `mode` 记的是这个实际档位。改官方工具的 `concurrency` 不会改变任何调度。

异步操作：

```jsonc
// POST /admin/api/servers/pg/restart → 202
{ "operationId": "op_01J...", "kind": "restart", "target": "pg", "state": "running" }
```

统一错误：`{ "error": { "code": "SERVER_BUSY", "message": "...", "details": {...} } }`

HTTP 映射：400 校验、404 不存在、409 revision 冲突或 SERVER_BUSY、422 配置语义错误、503 运行期不可用。

其余端点的请求/响应形状：

| 端点 | 形状 |
|---|---|
| `POST /servers/:id/test` | 成功 `200 { ok: true, tools: [...], count, elapsedMs }`；缺密钥 `422 { ok: false, missingSecrets: ["github_pat"] }` |
| `POST /config/import?dry-run=true` | `200 { valid: boolean, diff: { added, changed, removed } }`；实际导入返回 `202 { operationId }` |
| `DELETE /servers/:id?force=true` | 默认 drain；`force=true` 直接杀连接 |
| `POST /tools/batch` | `{ updates: [{ serverId, name, patch }] }`，单事务 |
| `GET /search` | 可选 `binding=<id>`；管理员默认不过滤，传了才按该绑定可见性过滤 |

202 操作的进度走 `/events`，`GET /operations/:id` 是断线后的补偿查询；操作完成后保留 10 分钟。

### 工具测试端点

#### `POST /admin/api/tools/:serverId/:name/test`

真实调用一次工具，供管理端「测试」按钮使用。请求体可省略，字段全部可选：

```jsonc
{ "args": { "x": 1 }, "timeoutMs": 10000 }
```

- `args`：JSON 对象，默认 `{}`；非对象 400 `INVALID_FIELD`。
- `timeoutMs`：整数 1..60000，默认 10000；越界或非整数 400 `INVALID_FIELD`。
- 未知字段 400 `UNKNOWN_FIELD`；请求体不是对象 400 `INVALID_BODY`，非法 JSON 400 `INVALID_JSON`。
- `serverId` 不存在 404 `SERVER_NOT_FOUND`；`name` 不存在 404 `TOOL_NOT_FOUND`。
- `__builtin__` 只开放只读工具测试：`search_tools`、`describe_tools`、`search_scripts`；其余内置工具返回 400 `TOOL_TEST_UNSUPPORTED`。只读工具用管理端身份走 `callTool`，不写 `tool_usage`。
- 服务端未接线执行器时 503 `TOOL_TEST_UNAVAILABLE`（正常装配不会出现）。

执行路径与模型调用相同：第三方 server 走连接池（`server` 为该 server），`__official__` 走 `claude mcp serve`，只读内置工具走顶层 `callTool`。测试不使用 binding，`__official__` 的 workspace 取服务进程当前目录。`timeoutMs` 是整个调用的硬期限：超时返回 200，不悬挂请求。

成功 200：

```jsonc
{ "ok": true, "result": { "...": "工具原始返回值" },
  "durationMs": 12, "testedAt": "2026-01-01T00:00:00.000Z", "resultBytes": 345 }
```

- `result`：`{ text, images?, documents? }`（第三方与 official 的归一化结果）或 official 原始结果；UI 按 JSON 展示。
- `durationMs`：调用耗时；`testedAt`：调用开始时间（ISO 8601）。
- `resultBytes`：`JSON.stringify(result)` 的 UTF-8 字节数；`undefined` 按 `null` 计 4 字节。
- 序列化结果超过 1 MiB 时省略 `result`，改返回 `truncated: true` 与 `resultPreview`（序列化 JSON 的前 1 MiB UTF-8 文本，可能不是完整 JSON）；`resultBytes` 仍是完整字节数。UI 在 `truncated` 时展示 `resultPreview` 文本。

工具执行失败也是 200：

```jsonc
{ "ok": false, "error": { "code": "TOOL_CALL_FAILED", "message": "..." },
  "durationMs": 12, "testedAt": "..." }
```

- 超过 `timeoutMs`：`error.code` 为 `TOOL_TEST_TIMEOUT`。
- 其它失败（连接不可用、上游错误等）：`error.code` 为 `TOOL_CALL_FAILED`，只转发可读的 `message`，不转发上游错误码。
- `ok=false` 时没有 `result` / `resultBytes` / `truncated`。
- `ok` 表示调用完成并拿到了结果。第三方 MCP 的上游 `isError` 会抛错（`TOOL_CALL_FAILED`）；`__official__` 的上游 `isError` 按模型调用同一路径归一化成结果值（普通工具为 `{ "error": string }`，Bash 为带 `exitCode` 的结果），所以仍是 `ok=true`。

副作用：

- 这是真实调用，写操作会生效；只应由管理员手工触发。内置工具只开放只读测试，不会产生业务写入。
- 成功和失败都写一条审计事件 `event: "tool_test"`，字段：`server`、`tool`、`ok`、`durationMs`、`argsBytes`、`resultBytes`（成功时）、`error`（失败时，含 `code` / `message`）。不写原始 `args` 和结果正文，避免密钥或大结果进入日志。
- **不计入 `tool_usage`**：测试不经过 eval 的 `tool_result` 路径，`callCount` / `successCount` / `lastCalledAt` 只反映模型与脚本的真实调用。
- 不改变 catalog、revision 或工具启停状态。

## 4. 生效时机

| 操作 | 何时算提交 | 模型何时看到 |
|---|---|---|
| 注册/改/删配置 | DB 事务提交 | 下一次 `run_script` 的 catalog 快照 |
| 连接/断开/重启 | 请求只排入队列 | 状态立即变，可用性随连接变化 |
| 改工具描述/标签/启停/并发 | DB 提交 | 下一次 `run_script` |
| 扫描并应用懒加载工具（`preview=false`） | DB 提交 | 下一次 `run_script` 的 catalog 快照 |
| 报告 / 告警配置 | DB 提交 | 立即；报告先落库，告警投递在后台串行 |
| AI 配置（`PUT /ai/config`） | DB 提交 | 下一次 AI 调用；proposal 与手动标注预览不落库、不生效 |
| 自动标注（工具索引后） | DB 提交 | 下一次 `run_script` 的 catalog 快照；FTS 即时更新 |
| 删除 server | DB 提交 + 停收新调用 | 立即；在飞按 `force` 决定 drain 或中止 |

**catalog 在 eval 开始时快照，连接可用性是实时的。** 两者不一致时报"工具存在但暂时不可用"，不是"工具不存在"。

## 5. SSE 事件

```
event: server_state
data: {"id":"pg","from":"ready","to":"reconnecting","reason":"child_exit"}

event: catalog_changed
data: {"revision":44,"servers":["pg"]}

event: eval
data: {"execSessionId":"es_...","binding":"cb_...","client":"cursor/0.44","phase":"start"}

event: operation
data: {"id":"op_...","state":"ok"}
```

## 6. 事件与日志查询

`/logs/*` 读的是 `log/events-*.jsonl` 这一条合并流：eval 生命周期、工具调用、协议帧、任务、报告、告警、池与发现事件都在里面（`event` 取值见 03 §4.7），**不只是安全审计**。目录名与数据模型仍叫 `audit`（`core/src/audit/`、`AuditEvent`、`AUDIT_SCHEMA_VERSION`），HTTP 面统一用 `logs`——这是"数据模型"与"资源路径"的分层，不是两个词指同一件事。

审计数据是 JSONL 文件（02 §6），不是 SQLite。**必须服务端流式过滤**，不能把整天的文件读进内存再返回。

七个端点列在 §2 的端点总表里，这里只补总表放不下的语义：

- `/logs/query`：默认 100 条/页；多值筛选见下方参数表。
- `/logs/evals/:exec/:evalId`：`evalId` 只在执行会话内唯一，必须带 `exec`。`tool_call`/`tool_result` 事件带 `exec` 与 `runId`（事件字段见设计 03 §4.7），可按 `exec` 或 `runId` 关联。
- `/logs/sessions`：按最近活动排序。
- `/logs/frames?mcp=&id=`：请求与响应配对返回，额外支持 `tool` / `protocol` / `result` 多值筛选。
- `/logs/payload?ref=&mode=&offset=&limit=`：入参是行上的 `argsRef`/`resultRef`/`paramsRef`/`resultTailRef` 等字段值，`mode` 取 `full|head|tail|range`；返回 `{ ref, mode, total, start, end, truncated, body }`，`body` 是 UTF-8 文本。缺参 400，越界或缺失 404（`PAYLOAD_NOT_FOUND`）。`ref` 只允许落在 `log/` 之内。
- 载荷阈值（读接口的可见行为）：≤ 4 KiB 内联；更大外置，行上留 2 KiB 预览 + `sha256` + 字节数；单条 > 50 MiB 只留首尾各 1 MiB；`log/` 保留 90 天 / 2 GiB。阈值由 `core/src/audit/payload.ts` 与 `server/src/audit/retention.ts` 拥有，`doc-facts` 会比对这段文字。响应体外置后，帧行上仍保留布尔字段 `resultIsError`，列表与 `result` 筛选据此判定执行结果。
- `/logs/stats?from=&to=&groupBy=`：工具调用量（仅 `tool_result`）、错误率、p50/p95、排队均值；响应另带 `retention`（上次清理时间、删除天数/文件数、当前 `log/` 体积）。`p50`/`p95` 是**执行时长**（`ms - queueMs`），`queueAvgMs` 单列排队，所以一个堵在闸门上的调用不会把工具本身算成慢。
- `/logs/stream`：SSE，新增事件实时推送。
- `/logs/export`：按当前筛选导出 JSONL。

筛选参数：

```
from, to          时间范围（UTC）
event             事件类型，可多选；含 `ai_run`（管理端 AI 调用）、`script_saved`（save_script 成功/失败）
clientName        客户端自报名称，精确匹配；可多选
clientVersion     客户端自报版本，精确匹配；可多选
client            旧参数：按 `name/version` 原始标签精确匹配，保留兼容
binding           token 身份；可多选
exec, evalId      执行会话 / eval；只给 `evalId` 不给 `exec` 时返回 400，因为它在会话内才唯一
taskId            异步任务；匹配审计事件里的 core eval 任务 id（与客户端可见的 MCP `taskId` 不是同一个值）
runId             一次执行；匹配事件里的 `runId`
scriptId          保存脚本；匹配事件里的 `scriptId`（`eval_start` / `eval_end` / `async_dispatch` / `script_saved`）
tool, server      工具与来源；可多选（`server` 同时匹配 `serverId`）
method            协议方法；可多选
status            ok | error | timeout；可多选。按事件类型映射：`tool_result.ok=false` → error；`eval_end.outcome=timeout` → timeout；`eval_end.outcome=error` / `worker_dead` → error；`eval_end.outcome=cancelled` → ok（取消不算失败）；`ai_run.outcome=error` → error，其余 → ok；其他事件默认 ok
protocol          `/logs/frames` 专用：ok | error | none（无响应）
result            `/logs/frames` 专用：ok | error | none（`tools/call` 的 `result.isError`，响应体外置后读行上的 `resultIsError`；两者都无或非工具请求为 none）
minMs, minQueueMs 慢调用筛选
groupBy           聚合维度：server | tool | client | status
cursor, limit     分页
```

多值参数（`event`、`clientName`、`clientVersion`、`binding`、`tool`、`server`、`method`、`status`）可重复传同名参数，也可以逗号分隔；同一字段内部是 any-of，不同字段之间是 and。`/logs/frames` 的 `tool` 按配对请求的 `params.name` 过滤，`protocol` / `result` 在配对后过滤（响应帧本身没有 `params.name`）。

规则：

- 分页用 cursor（文件内的偏移 + 时间戳），不用 offset——文件在增长，offset 会漂移。
- 聚合在服务端流式计算，按 `(文件, 筛选, groupBy)` 缓存 10s。`/logs/stats` 响应带 `snapshotId` 与 `tookMs`；页面上的数字和列表可能来自不同扫描，UI 必须显示时间差，不能承诺"同一次扫描"。
- 协议帧以 `full` 模式记录（报文脱敏：键名与值都过一遍，base64 转 `{mimeType, bytes, sha256}`）。报文不再截断：≤4 KiB 内联在帧行上，更大的写进 `payload/`，行上留 `paramsRef`/`resultRef` + 2 KiB 预览 + `paramsBytes`/`resultBytes` + sha256，正文用 `/logs/payload` 取。`/logs/frames` 的 `detail=summary` 只返回元数据，`detail=full` 返回报文（含 ref 字段）。
- 导出有上限（默认 10 万行），超限要求缩小时间范围。

## 7. 报告端点

#### `POST /admin/api/reports`

请求字段与设计 06 §3.1 相同；`strict` 校验（未知字段 400 `UNKNOWN_FIELD`）。成功 `201 { report }`。

#### `GET /admin/api/reports`

查询参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `limit` | integer 1..200 | 50 | 页大小 |
| `cursor` | string | — | 上一页返回的 `nextCursor` |
| `status` | `open` / `ack` / `closed` | — | 过滤 |
| `severity` | 四级枚举 | — | 过滤 |
| `source` | `mcp` / `admin` | — | 过滤 |
| `from` / `to` | ISO 8601 或 epoch ms | — | 按 `created_at` 过滤，闭区间 |

排序固定 `created_at DESC, id DESC`。游标是 keyset，不是 offset：

```ts
type ReportCursor = { v: 1; ca: string; id: string };
// nextCursor = Buffer.from(JSON.stringify({ v: 1, ca: last.createdAt, id: last.id }), 'utf8').toString('base64')
// 下一页 WHERE (created_at < :ca) OR (created_at = :ca AND id < :id)
```

响应：

```json
{
  "items": [
    {
      "id": "rep_...", "createdAt": "...", "updatedAt": "...",
      "source": "mcp", "binding": "cb_...", "client": "claude-code/2.1.327",
      "mcp": "mcp_...", "exec": null, "evalId": null,
      "severity": "high", "title": "Bash 执行 npm test 时挂起",
      "status": "open", "alertState": "sent", "alertError": null,
      "alertAttempts": 1, "alertUpdatedAt": "...", "alertedAt": "..."
    }
  ],
  "nextCursor": "eyJ2IjoxLCJjYSI6..."
}
```

**列表不返回 `detail` 与 `context`**：单条 detail 上限 20KB，50 条会撑爆响应；详情走 `GET /reports/:id`。`fingerprint` 与 `owner_key` 是内部字段，不返回。

错误：400 `INVALID_CURSOR` / `INVALID_QUERY`（时间或枚举解析失败）。管理端查询参数沿用既有约定 `INVALID_QUERY`（`servers.ts` 的 `force`、`config-routes.ts` 的 `dry-run`、`tools.ts` 的 `max`）；`INVALID_ARGUMENT` 只用于 MCP 工具参数与仓储层依赖错误。

#### `GET /admin/api/reports/:id`

200 `{ report }`，含 `detail` 与 `context`（`context` 是 JSON 对象或 `null`）。不存在返回 404 `REPORT_NOT_FOUND`。

#### `PATCH /admin/api/reports/:id`

```jsonc
// 请求，strict；status 与 resolution 至少给一个
{ "status": "closed", "resolution": "已升级依赖，复测通过" }
// 200
{ "report": { /* 完整视图，含 resolution/resolvedAt */ } }
```

`resolution` 允许 `null` 或空串，表示清空；非空时先 `trim`，最多 4000 code points。只给 `resolution` 不要求 `status`，可在任意状态单独保存。`status` 与 `resolution` 同时给出时先校验两者再落库；`status` 变更非法时整体返回 409，不写 `resolution`。

错误：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `INVALID_BODY` / `UNKNOWN_FIELD` / `INVALID_FIELD` | 两个字段都没给、非法值、未知字段、resolution 过长 |
| 404 | `REPORT_NOT_FOUND` | id 不存在 |
| 409 | `REPORT_STATUS_CONFLICT` | `closed → ack`；`details: { from, to }` |

报告行没有 `revision`：状态变更按 last-write-wins，状态机只负责拒绝非法跳转，不提供并发编辑冲突检测。

#### `POST /admin/api/reports/:id/retry-alert`

无请求体。`alert_state` 属于 `failed` / `skipped` / `no_webhook` 时，原子地重置为 `pending`（清空 `alert_error`，保留 `alert_attempts`）并 `kick()`；不等待发送完成。

| 情况 | 状态 | 响应 |
|---|---|---|
| 重置成功 | 200 | `{ "report": { /* 完整视图 */ } }` |
| id 不存在 | 404 | `REPORT_NOT_FOUND` |
| `alert_state` 为 `pending` / `sending` / `sent` | 409 | `ALERT_RETRY_CONFLICT`，`details: { alertState }` |

## 8. 告警配置端点

#### `GET /admin/api/alerts/config`

```json
{
  "enabled": true,
  "minSeverity": "high",
  "events": ["report"],
  "webhook": { "configured": true, "secretName": "wecom.webhook" },
  "revision": 44
}
```

实现细节：`configured` 用 `secrets.listNames()` 判断，**不要调用 `get()`**，避免为了一个布尔值把明文读进内存。响应里没有 webhook 值、没有 key、没有 host；测试要断言整个 JSON 文本不包含 secret 值。

#### `PUT /admin/api/alerts/config`

必须带 `If-Match: <meta.revision>`（与 `/settings`、`/servers` 的写路径一致）。

```jsonc
// 请求；字段全部可选，但至少给一个
{
  "enabled": true,
  "minSeverity": "high",
  "events": ["report"],
  "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
}
```

| 字段 | 语义 |
|---|---|
| `enabled` / `minSeverity` / `events` | 更新 `settings.alerts` |
| `webhook` 省略 | 保持原值 |
| `webhook: null` | 删除 `wecom.webhook` |
| `webhook: "..."` | 校验 URL 后写入 SecretStore |

执行顺序：

```
1. 解析并校验全部字段（URL 校验在这一步，失败则什么都没写）
2. 读 settings + revision，assert If-Match（失败 409，什么都没写）
3. 写 SecretStore（如果给了 webhook）
4. 若给了 enabled/minSeverity/events：写 settings.alerts（窄接口先再次 assertRevision，再 patchSettings；只 upsert `alerts` 键）
```

成功响应 200，与 `GET /alerts/config` 同形：

```json
{
  "enabled": true,
  "minSeverity": "high",
  "events": ["report"],
  "webhook": { "configured": true, "secretName": "wecom.webhook" },
  "revision": 45
}
```

- `webhook.configured` 是写入后的状态；响应仍不含 webhook 值。
- 只有 `enabled` / `minSeverity` / `events` 至少给了一个时才调用 `patchSettings` 并 bump `revision`；只改 webhook 的请求不写 settings，`revision` 保持不变。响应里的 `revision` 始终是操作完成后的当前值。
- 409/500 的 `details.webhookUpdated` 是 boolean：`true` 表示 SecretStore 已写入而 settings 未保存；没给 webhook 或第 3 步未执行时为 `false`。不要在 `details` 里放 URL 或 key。

第 3、4 步之间有一个异步窗口（`await secrets.set` 会让出事件循环）。若第 4 步的第二次 assert 发现 revision 已被别人推进，返回 409 `REVISION_CONFLICT`，`details.webhookUpdated = true`；若是磁盘/DB 错误，返回 500 `INTERNAL_ERROR`，同样带 `webhookUpdated`。UI 提示“webhook 已更新，配置未保存，请刷新后重试”。这比“配置已改但 webhook 没改”更容易发现和恢复；不要假装两个存储可以原子提交。

错误：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `IF_MATCH_REQUIRED` / `INVALID_IF_MATCH` | 缺少或格式错 |
| 400 | `INVALID_BODY` / `INVALID_JSON` / `UNKNOWN_FIELD` / `INVALID_FIELD` | 字段问题 |
| 409 | `REVISION_CONFLICT` | 步骤 2 不匹配（什么都没写）或步骤 4 二次 assert 失败（webhook 可能已写，`details.webhookUpdated` 为 true） |
| 422 | `EMPTY_PATCH` | 一个字段都没给 |
| 422 | `INVALID_SEVERITY` / `UNKNOWN_EVENT` / `WEBHOOK_URL_INVALID` | 语义校验 |

#### `POST /admin/api/alerts/test`

无请求体。读取已配置的 webhook 发送固定测试消息：

```
## REPL Server 告警测试
> 时间：<UTC ISO>
> 说明：这条消息由管理端“发送测试”触发。
```

| 情况 | 状态 | 响应 |
|---|---|---|
| 发送成功 | 200 | `{ "ok": true, "attempts": 1, "elapsedMs": 142 }` |
| 发送失败 | 200 | `{ "ok": false, "attempts": 2, "elapsedMs": 10480, "error": { "code": "ALERT_HTTP_500", "message": "upstream returned HTTP 500" }, "details": { "httpStatus": 500 } }` |
| 未配置 | 422 | `WEBHOOK_NOT_CONFIGURED` |
| 已存 URL 非法 | 422 | `WEBHOOK_URL_INVALID`（`details.rule`） |
| 5 秒内重复点 | 429 | `ALERT_TEST_THROTTLED`，`details.retryAfterMs` |

发送失败仍返回 200，是为了让 UI 区分“请求没被接受（4xx）”和“测试消息没送达（200 + ok:false）”。`error.code` 与落库的 `alert_error` 前缀使用同一套码（设计 06 §5.4）；`message` 只放人类可读文本，不把机器码塞进 message。

测试发送排进 dispatcher 的串行队列（`sendTest()`），与 drain 及最小发送间隔共用同一条通道；drain 处于 45009 冷却时，响应可能额外等待冷却结束。

#### `POST /admin/api/alerts/preview`

请求体可选（strict）：`{ "severity"?: 四级枚举, "title"?: string }`。默认 `severity` 取当前 `minSeverity`，`title` 用固定示例。只调用 `buildWecomMarkdown` 构造一条不落库的合成报告，不读 webhook、不发网络、不写审计。

成功 200：

```json
{ "content": "## REPL 问题报告\n...", "bytes": 286 }
```

`bytes` 是按 UTF-8 计算的 `content` 字节数，必须 < 4096；`content` 与真实告警走同一脱敏、转义和截断路径。

## 9. HTTP 错误码

统一形状 `{ "error": { "code", "message", "details"? } }`。报告与告警特有的 `alert_state` 闭集、`alert_error` 取值与可重试性见设计 06 §5.4，不在此重复。

| code | HTTP | 出处 / 层 |
|---|---|---|
| `INVALID_QUERY` | 400 | 管理端查询参数（报告列表的 `limit/status/severity/source/from/to`） |
| `INVALID_CURSOR` | 400 | 报告列表 |
| `INVALID_BODY` / `INVALID_JSON` / `INVALID_FIELD` / `UNKNOWN_FIELD` | 400 | 所有写端点 |
| `IF_MATCH_REQUIRED` / `INVALID_IF_MATCH` | 400 | PUT 告警配置 |
| `EMPTY_PATCH` | 422 | PUT 告警配置 |
| `REPORT_NOT_FOUND` | 404 | 报告详情/改状态/重发 |
| `REPORT_STATUS_CONFLICT` | 409 | 状态机禁止的跳转 |
| `ALERT_RETRY_CONFLICT` | 409 | 手动重发时 `alert_state` 不允许 |
| `REVISION_CONFLICT` | 409 | PUT 告警配置 |
| `INVALID_SEVERITY` / `UNKNOWN_EVENT` / `WEBHOOK_URL_INVALID` | 422 | PUT 告警配置 |
| `INVALID_TAGS` | 422 | PUT `/tags`：条目格式、重复 key、动作键或系统托管项被改动 |
| `TAG_POLICY_VIOLATION` | 422 | 创建/PATCH server、写工具标签、AI 标注 apply：违反 server 0–2 / 工具叠加 1–4 / 不重复 / 禁动作键 |
| `SERVER_NOT_FOUND` / `TOOL_NOT_FOUND` | 404 | 工具目录写端点与工具测试端点 |
| `TOOL_TEST_UNSUPPORTED` | 400 | `POST /tools/:serverId/:name/test`：`__builtin__` 中非只读工具没有管理端测试路径（只读测试仅限 `search_tools` / `describe_tools` / `search_scripts`） |
| `TOOL_TEST_UNAVAILABLE` | 503 | 同上：服务端未接线测试执行器 |
| `SCRIPT_NOT_FOUND` / `SCRIPT_VERSION_NOT_FOUND` | 404 | 脚本库端点 |
| `SCRIPT_RUN_NOT_FOUND` / `SCRIPT_RUN_EXPIRED` | 404 | 脚本库来源执行 |
| `SCRIPT_NAME_CONFLICT` / `SCRIPT_MODE_CONFLICT` / `SCRIPT_VERSION_CONFLICT` | 409 | 脚本库写端点 |
| `SCRIPT_VERSION_NOT_DRAFT` / `SCRIPT_DISABLED` / `SCRIPT_ARCHIVED` / `SCRIPT_NOT_ACTIVE` / `SCRIPT_RUN_NOT_SUCCESSFUL` | 409 | 脚本库生命周期 |
| `SCRIPT_ARGS_INVALID` / `SCRIPT_INPUT_SCHEMA_INVALID` / `SCRIPT_CODE_INVALID` | 422 | 脚本库写端点 |
| `SCRIPT_FORBIDDEN` | 403 | 非 owner 修改脚本，或非 owner/admin 测试 draft（管理端请求视为 admin，不触发） |
| `SCRIPT_CANDIDATE_NOT_FOUND` | 404 | 候选审核端点 |
| `SCRIPT_CANDIDATE_ALREADY_REVIEWED` | 409 | 候选已接受或已拒绝 |
| `SCRIPT_CANDIDATE_INCOMPLETE` | 422 | 候选没有建议名称/描述，accept 请求体也未补齐 |
| `WEBHOOK_NOT_CONFIGURED` | 422 | 测试端点 |
| `ALERT_TEST_THROTTLED` | 429 | 测试端点 |

工具测试的 `TOOL_CALL_FAILED` 与 `TOOL_TEST_TIMEOUT` 是 HTTP 200 响应体里的 `error.code`，不是 HTTP 错误码（见 §3「工具测试端点」）。

## 10. 脚本库端点

脚本库是全局命名空间：`scripts` 没有 workspace 字段，名称全局唯一；`script_runs.workspace` 只记录执行上下文。最小 ACL 以 `scripts.created_by` 为 owner：agent 只能修改/激活/归档自己创建的脚本，admin 管理全部；所有 agent 可搜索和执行 active 脚本，draft 测试限 owner/admin。管理端请求一律视为 admin，不做 owner 限制。保存与版本响应带密钥扫描 `warnings`（只告警，不阻断、不改写代码）：`{ field, kind, severity, count }`，不含匹配原文。`save_script` 成功与失败都会写 `script_saved` 审计事件（`ok`、`scriptId`、`version`、`mode`、`name`、`sourceRunId`、`error`；成功事件带 `warnings`）。

#### `GET /admin/api/scripts`

查询参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `status` | `draft` / `active` / `disabled` / `archived` | — | 过滤 |
| `q` | string | — | 在 name/description/tags 上 LIKE |
| `limit` | integer 1..200 | 50 | 页大小 |
| `cursor` | string | — | 上一页的 `nextCursor` |

响应 `{ "items": [script], "nextCursor": string | null }`。`script` 含 `scriptId`、`name`、`description`、`tags`、`mode`、`activeVersion`、`status`、`createdBy`、`createdAt`、`updatedAt`、`sourceRunId`、`useCount`、`lastUsedAt`，以及 `script_runs` 聚合的 `runCount`、`successCount`、`successRate`（0–1，四位小数；无执行时为 0）。排序固定 `updated_at DESC, script_id DESC`；游标是 keyset（`{v:1, updatedAt, scriptId}` 的 base64）。

#### `GET /admin/api/scripts/:id`

`200 { "script": {...} }`，字段同列表项（含执行统计）；不存在 `404 SCRIPT_NOT_FOUND`。

#### `PATCH /admin/api/scripts/:id`

```jsonc
{ "name": "new-name", "description": "…", "tags": ["ops"], "status": "disabled" }
```

字段全部可选，至少给一个；未知字段 `400 UNKNOWN_FIELD`。`status=active` 要求脚本已有 active 版本，否则 `422 INVALID_FIELD`。重名 `409 SCRIPT_NAME_CONFLICT`。

#### `GET /admin/api/scripts/:id/versions`

`200 { "items": [version] }`，按版本号升序；列表项不含 `code`（含 `codeBytes` / `codeSha256` 便于判断变化）。

#### `GET /admin/api/scripts/:id/versions/:version`

`200 { "version": {...}, "warnings": [...] }`，含 `code`、`inputSchema`、`exampleArgs`、`status`、`createdBy`、`sourceRunId`、`verifiedRunId`、`activatedAt`。管理端编辑仍可看到原文 `code`；`warnings` 是对该版本 `code` 与 `exampleArgs` 的密钥扫描告警，仅用于页面提示。

#### `POST /admin/api/scripts/:id/versions`

```jsonc
{ "mode": "parameterized", "runId": "run_…", "code": "return args.x;", "inputSchema": {...},
  "exampleArgs": { "x": 1 }, "changelog": "add one" }
```

生成新 draft 版本，`createdBy` 记为 `admin`；`mode` 省略时沿用脚本当前模式，改变模式返回 `409 SCRIPT_MODE_CONFLICT`。`runId` 可选，可空但提供时必须是一次成功、未过期的执行，写入 `sourceRunId`。`exact` 脚本必须给 `runId` 且不能提交 `code`：源码取自该执行的 `code`，`sourceRunId` 与 `verifiedRunId` 都记这个 run；`parameterized` 提交 `code` + `inputSchema`，`runId` 只记来源。校验规则与 `save_script` 相同：`inputSchema` 超出 P1 子集 `422 SCRIPT_INPUT_SCHEMA_INVALID`，代码语法错误或超过 1 MiB `422 SCRIPT_CODE_INVALID`。返回 `201 { "version": {...}, "warnings": [...] }`；`warnings` 与版本详情同一口径。

#### `POST /admin/api/scripts/:id/versions/:version/activate`

只激活已有成功测试记录的版本（`verifiedRunId` 非空；也可用于回滚到 superseded 版本）：目标版本变 active，旧 active 变 superseded，`scripts.active_version` 与 `status` 同步。未测试版本 `409 SCRIPT_VERSION_NOT_DRAFT`；目标不存在 `404 SCRIPT_VERSION_NOT_FOUND`，脚本或版本 archived `409 SCRIPT_ARCHIVED`。

#### `GET /admin/api/scripts/:id/versions/:version/diff?baseVersion=n`

返回 `{ "fromVersion": n, "toVersion": :version, "lines": [{"type": "same" | "add" | "del", "text": "…"}] }`。逐行 diff，公共前后缀不参与 LCS；`baseVersion` 必填且两个版本都必须存在，缺失 `400 INVALID_QUERY`，版本不存在 `404 SCRIPT_VERSION_NOT_FOUND`。

#### `GET /admin/api/scripts/:id/runs`

返回该脚本的执行历史（`script_runs` 中 `script_id = :id` 的行），固定 `created_at DESC, run_id DESC`，`limit` 1..200（默认 50），`cursor` 为 `{v:1, createdAt, runId}` 的 base64。行字段与 `script_runs` 一致（`runId`、`evalId`、`argsPreview`、`scriptMode`、`ok`、`error`、`durationMs`、`toolsUsed`、`purpose` 等），但不返回明文 `args` 和源码 `code`；`argsPreview` 是执行时写入的脱敏摘要（上限 512 字符），`codeBytes` / `codeSha256` 仅用于判断变化。源码仍可在版本详情（`GET /versions/:version`）查看，供管理员编辑。点开某行时复用现有请求详情，不另建详情页。

#### `POST /admin/api/scripts/:id/test`

```jsonc
{ "version": 1, "args": { "x": 1 }, "activateOnSuccess": false }
```

字段全部可选；省略 `version` 用 active 版本（draft 脚本无 active 时 `409 SCRIPT_NOT_ACTIVE`），`args` 按版本 `inputSchema` 校验（`422 SCRIPT_ARGS_INVALID`）。管理端身份同步执行一次 `purpose='test'` 的 eval，不更新 `use_count`；`activateOnSuccess` 只接受 draft 版本（否则 `409 SCRIPT_VERSION_NOT_DRAFT`），成功时同一归档事务内激活。响应 `200 { "runId": string | null, "ok": boolean, "durationMs": number | null, "output": string, "error": string | null, "activated": boolean, "status": string, "secretWarnings": [...] }`：`output` 是 test 执行结果（不是 `script_runs` 行），`durationMs` / `error` 取自同一 `runId` 的归档行，`activated` 表示本次执行完成了激活，`status` 是目标版本执行后的状态；`secretWarnings` 是对测试 `args` 的密钥扫描汇总（仅提示，不阻断）。执行失败也是 200（`ok=false`），只有请求/生命周期错误走 4xx。

**执行历史复用**：脚本执行仍是 `run_script` 的一次 eval，请求列表/过程/协议帧/事件全部复用；`eval_start` / `eval_end` / `async_dispatch` 带 `runId`、`entryTool`、`entryMode`、`scriptId`、`scriptVersion`、`scriptMode`、`argsBytes`、`argsPreview`，以及疑似密钥时的 `secretWarnings`（`field` / `kind` / `severity` / `count`）。事件里的 `argsPreview` 已脱敏；协议帧保留原始 `args`（已知风险）。

### 脚本候选端点

候选队列只服务人工审核：扫描不创建脚本，接受后才按 `save_script` 的同一套校验生成 **draft**，测试成功后才激活。

#### `GET /admin/api/script-candidates`

查询参数：`status`（`pending` / `accepted` / `rejected`，省略为全部）、`limit`（1..200，默认 50）、`cursor`（上一页的 `nextCursor`）。响应 `{ "items": [candidate], "nextCursor": string | null }`；排序固定 `created_at DESC, candidate_id DESC`，游标是 `{v:1, createdAt, candidateId}` 的 base64。`candidate` 含 `candidateId`、`createdAt`、`code`、`codeSha256`、`workspace`、`sourceRunIds`、`suggestedName`、`suggestedDescription`、`suggestedTags`、`suggestedInputSchema`、`suggestedCode`、`score`、`status`、`scriptId`、`reviewedAt`、`reviewedBy`。

#### `POST /admin/api/script-candidates/scan`

请求体可省略，或给 `{ "limit": 500 }`（1..2000，默认 500）。扫描 `script_runs` 中 `ok=1`、`entry_mode='code'`、`code` 非空且未过期的执行，按归一化后的代码形状（忽略格式、注释与字面量值）聚类，来源 `exec_id` 作为会话。按代表性代码的 `code_sha256` 去重：已有 `pending` 刷新 `sourceRunIds`/`score`/确定性建议；已有 `accepted` / `rejected` 不覆盖；其余插入新候选。

配置了 AI 时会为每个待写入候选生成名称、描述、标签与参数化建议；AI 未启用、调用失败或输出不合法只写 `warnings`，确定性建议保留，扫描本身仍成功。响应 `{ "scanned", "created", "updated", "warnings": [...] }`；`scanned` 是本次参与分析的执行数。重复扫描同一批执行是幂等的（第二次 `created=0`）。

#### `POST /admin/api/script-candidates/:id/accept`

只接受 `pending` 候选，否则 `409 SCRIPT_CANDIDATE_ALREADY_REVIEWED`；不存在 `404 SCRIPT_CANDIDATE_NOT_FOUND`。请求体全部可选，可覆盖 `name`、`description`、`tags`、`code`、`inputSchema`、`exampleArgs`；未覆盖时用候选的建议值。候选同时有建议 `suggestedCode` 与 `suggestedInputSchema` 时用这对参数化建议，否则退回候选原始 `code` + 空 schema（`{"type":"object","properties":{}}`）。

生成脚本固定为 `parameterized` **draft**，`createdBy` / `reviewedBy` 均为 `admin`，并执行与 `save_script` 相同的校验：名称全局唯一冲突 `409 SCRIPT_NAME_CONFLICT`，代码语法错误或超限 `422 SCRIPT_CODE_INVALID`，schema 超出 P1 子集 `422 SCRIPT_INPUT_SCHEMA_INVALID`，`exampleArgs` 不满足 schema `422 SCRIPT_ARGS_INVALID`。候选缺少建议名称/描述且请求体未补齐时 `422 SCRIPT_CANDIDATE_INCOMPLETE`。响应 `{ "candidate": candidate, "script": { scriptId, version, status, activeVersion, mode, warnings } }`；`warnings` 为该次保存的密钥扫描告警，接受不自动激活。

#### `POST /admin/api/script-candidates/:id/reject`

只处理 `pending` 候选，写 `status='rejected'` 与 `reviewedAt` / `reviewedBy='admin'`；重复拒绝 `409 SCRIPT_CANDIDATE_ALREADY_REVIEWED`。响应 `{ "candidate": candidate }`。

## 11. 校验覆盖边界

`doc-admin.ts` 分两层比对。

**根段**：按方法 + 路径的根段（`/servers/...` → `servers`）双向比对，代码新增模块而本文没写、本文写了代码里没有的模块都会报错；同时也拒绝表内重复端点。

**第二段（仅 `/logs`）**：这一族由特性模块的路由表分发——`server/src/audit/runtime.ts` 的 `matchesRoute(segments, ['logs', 'query'])` 与 `isEvalTraceRoute`（`segments[0] === 'logs' && segments[1] === 'evals'`），SSE 在 `admin/http-adapter.ts` 的 `${ADMIN_API_ROOT}/logs/stream`。脚本对声明的族（`DEEP_FAMILIES`）逐条比到第二段，两条 `/logs/<x>` 任一侧缺失都失败；只按根段看的话，删掉 `/logs/payload` 不会报错。新族要纳入深度比对，把根段加进 `DEEP_FAMILIES`，并让路由表用字面量两段（`['logs', 'x']`）写法。

**不校验**同一模块下的参数名与字段级形状——加 `/clients/:id/token` 这类同模块新端点、或改字段时，仍须同时改本文与代码。

`GET /operations/:id` 是唯一「文档有、代码未接线」的端点（RS-07），脚本以 `PLANNED` 白名单放行并在输出里打 `note`；一旦该根被代码服务，脚本会反过来要求删掉豁免。

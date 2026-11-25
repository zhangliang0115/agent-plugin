# repl-server 开发计划

由四位专家拆解（2026-11-18），按模块分组。任务编号与依赖是跨 workflow 的协调依据。

**状态（2026-11-19）**：2026-11-18 的 67 个基线任务已实现并验证，证据见 learn-ai `claude-code/自建设计/05-交接与待办.md` §十（含 headless 与 interactive TUI、第三方 MCP、管理端 SSE）。06–08 的 report/alerts/discovery/AI 是随后追加的增量，已落地并有自动化测试，任务行见「06–08 增量」；外部联调范围仍以 05 §十为准（企业微信真实接口、AI 标注质量仍是开放问题）。

## core 执行体

| id | 任务 | 依赖 | 估算 |
|---|---|---|---|
| `C01` | core 包骨架与冻结契约：package.json/tsconfig、RunScriptResult 与错误类型、L0–L5/容量默认常量 | — | 0.5d |
| `C02` | worker 消息协议与 vm 执行体：eval/cancel/snapshot、ready/call/log/done/error/call-result、顶层 await、L0 同步超时 | C01 | 2d |
| `C03` | Sandbox 生命周期与 state：Worker 创建/terminate/重建、v8 快照 ≤1MB、lastGood 恢复、reset 标记 | C02 | 1d |
| `C04` | L5 输出归一化与 <repl-output>：30k/字段、≤20k 估算 token、1000 行、8 图/4 PDF、truncated/reset/restored/async-task 属性 | C01 | 1d |
| `C05` | serve 工具桥：注入式 ServeClient、L1 单次调用超时/AbortSignal、official {error}、MCP McpToolError、Read/Edit/多 content 归一、visibleTools 过滤 | C01 | 1d |
| `C06` | Bash 参数钳制与 exitCode：剩余 deadline clamp、600s 上限、成功 0/returnCodeInterpretation null、非零 Exit code N 不抛 | C01 | 0.5d |
| `C07` | 执行会话 runEval：同步串行/async 立即放锁、L2 软墙、L3 硬墙与全量 settle、L4 50000 预算、迟到消息丢弃 | C03, C04 | 2d |
| `C08` | 评估任务表与 wait_tasks 语义：evalTaskId 分配、全完成等待、消费/ALREADY_CONSUMED/UNKNOWN_TASK/TASK_EXPIRED、TTL 9,000,000ms | C01 | 1d |
| `C09` | 并发闸门：per-server RwLock（parallel 读/serial 写）、并行 Semaphore、全局 exclusive 准入闸门与 30s EXCLUSIVE_TIMEOUT | C01 | 0.5d |
| `C10` | 进程树快照与杀进程：ps 行解析、lstart、snapshotTree、先快照后 TERM→2s→KILL、ESRCH 忽略、lstart 校验 | C01 | 1d |
| `C11` | 进程账本：state/serve/pool/survivors 记录与原子写（tmp+rename, 0600）、bootId/lstart、损坏容错、evalKey 复合键 | C01 | 0.5d |
| `C12` | keeper：detached 启动 serve、先原子写 serve.json 再打通 stdio、stdin EOF/SIGTERM 杀进程组、exit code 透传 | C10, C11 | 1d |
| `C13` | ServeManager：每执行会话启动 keeper+serve、记录 pid/pgid/lstart、transport close/exit 主信号、10s×2 ping 兜底、重启与 env 白名单 | C10, C11, C12 | 1d |
| `C14` | startupSweep 与 reconcile：O_EXCL 锁、state/serve.json/pool/survivors/环境标记四路清理、orphans 报告、15s 周期 reconcile | C10, C11 | 2d |
| `C15` | 残留检测与进程注册表：eval 前后后代差集、leftRunning、30min lease/15s 心跳、session 内 handle 校验、kill 前比对 lstart | C10, C11 | 1d |
| `C16` | 审计 writer 与脱敏：UTC 按日 JSONL、4MB 积压丢明细保控制事件、audit_dropped、14 天/200MB 轮转、boundedJson 与值级脱敏 | C01 | 1d |
| `C17` | 执行会话端到端装配：worker+sandbox+serve 桥+runEval+task store+闸门+审计串联，content-only 与双 id 空间验收 | C03, C04, C05, C06, C07, C08, C09, C13, C15, C16 | 2d |

## server MCP 层

| id | 任务 | 依赖 | 估算 |
|---|---|---|---|
| ~~`srv-00-sdk-spike`~~ | **已取消**（2026-11-23）：不引入 `@modelcontextprotocol/sdk`，server 与客户端适配层全部手写，零运行时依赖（protocol §1.2、设计 02 §4.3）；下表对它的依赖视为已满足 | — | 0d |
| `srv-01-http-shell` | HTTP 骨架与单实例锁：/health、/mcp、/admin 路由、统一错误与优雅关闭 | — | 1d |
| `srv-02-streamable-http` | MCP Streamable HTTP（stateful）：POST/GET/DELETE 与 Mcp-Session-Id | srv-00-sdk-spike, srv-01-http-shell, srv-04-discover-methods, srv-05-transport-sessions, srv-18-protocol-doc | 1d |
| `srv-03-stdio-bridge` | stdio bridge：stdin/stdout JSON-RPC 与 HTTP /mcp 的 1:1 转发 | srv-02-streamable-http | 1d |
| `srv-04-discover-methods` | 2026-07-28 方法表：server/discover、legacy initialize 与 JSON-RPC 分发 | srv-00-sdk-spike, srv-01-http-shell, srv-18-protocol-doc | 1d |
| `srv-05-transport-sessions` | 三层会话之一：传输会话注册表、lastRequestAt、60min idle 与 DELETE 级联 | srv-01-http-shell, srv-04-discover-methods | 1d |
| `srv-06-workspace-realpath` | workspace realpath：解析顺序、符号链接/尾斜杠/.. 归一与 WS_INVALID/WS_LIMIT | — | 0.5d |
| `srv-07-exec-sessions` | 三层会话之二/三：执行会话懒建、workspace 绑定、worker/serve/task TTL 与回收 | srv-05-transport-sessions, srv-06-workspace-realpath | 2d |
| `srv-08-capacity-lru` | 容量/LRU：冻结默认值、CapacityExceeded 与按 lastEvalAt 的 capacity_evict | srv-07-exec-sessions | 1d |
| `srv-09-auth-matrix` | 鉴权矩阵：token 反查 binding、strict/loose、每请求复核与 admin Origin/CSRF | srv-01-http-shell | 1d |
| `srv-10-admin-events-sse` | 管理端 SSE：/admin/api/events、Last-Event-ID 回放与四类事件 | srv-01-http-shell, srv-09-auth-matrix | 1d |
| `srv-11-pool-lifecycle` | 第三方连接池：懒连接去重、stdio 隔离、健康检查、退避重连与熔断 | srv-00-sdk-spike, srv-01-http-shell | 2d |
| `srv-12-pool-gates` | 连接池并发：per-server 读写锁、全局 exclusive 准入、binding 轮转与取消隔离 | srv-11-pool-lifecycle | 2d |
| `srv-13-tool-registry` | 5 个工具注册与 alwaysLoad：冻结 schema、annotations、动态 description（含 `report_problem`） | srv-04-discover-methods, srv-18-protocol-doc | 1d |
| `srv-14-mcp-tasks` | 手写 MCP tasks 层：CreateTaskResult 判定、双 id 空间与 get/cancel/update | srv-04-discover-methods, srv-07-exec-sessions, srv-18-protocol-doc | 2d |
| `srv-15-tools-call` | tools/call 路由：content-only XML、isError/errorInfo、search/describe/wait_tasks 语义 | srv-07-exec-sessions, srv-09-auth-matrix, srv-13-tool-registry, srv-14-mcp-tasks, srv-18-protocol-doc | 1d |
| `srv-16-protocol-frames` | 协议帧记录：summary/full、请求响应配对、脱敏、1MB 截断与丢帧统计 | srv-01-http-shell, srv-04-discover-methods | 1d |
| `srv-17-audit-endpoints` | 审计端点：游标分页、eval 轨迹、协议帧、统计缓存与 JSONL 导出 | srv-09-auth-matrix, srv-10-admin-events-sse, srv-16-protocol-frames | 2d |
| `srv-18-protocol-doc` | protocol.md：复制 01 §4.2 / 02 §4.3–4.4 与 03 §2–§4 的 server 契约 | — | 0.5d |
| `srv-19-wire-e2e` | 装配与端到端：把 transport、会话、鉴权、工具、tasks、SSE、审计接成一个可运行 server | srv-02-streamable-http, srv-03-stdio-bridge, srv-05-transport-sessions, srv-07-exec-sessions, srv-08-capacity-lru, srv-09-auth-matrix, srv-10-admin-events-sse, srv-11-pool-lifecycle, srv-12-pool-gates, srv-13-tool-registry, srv-14-mcp-tasks, srv-15-tools-call, srv-16-protocol-frames, srv-17-audit-endpoints, srv-18-protocol-doc | 1d |

## 存储/管理/Web

| id | 任务 | 依赖 | 估算 |
|---|---|---|---|
| `RS-01-statedb` | state.db 打开与 schema v1 迁移：0600/WAL、servers/tools/client_bindings/meta/settings 与 FTS5 触发器 | — | 1d |
| `RS-02-repos` | servers/tools/client_bindings/meta/settings 仓储：CRUD、级联、realpath、token 哈希与 revision 事务 | RS-01-statedb | 2d |
| `RS-03-secrets` | 密钥引用解析与 SecretStore：$secret 占位、缺失键收集、keychain 抽象与 0600 文件回退 | — | 1d |
| `RS-04-fts` | tools.index_* 生效列维护与 refreshFts(serverId)：description override、server summary、tags 并集与触发器同步 | RS-02-repos | 1d |
| `RS-05-retrieval` | search_tools 检索器：过滤器语法、BM25 权重、同义词、空查询概览、无结果退化与可见性后置提示 | RS-04-fts | 2d |
| `RS-06-catalog` | CatalogService：不可变快照、catalogRevision、写入提交后重建与 catalog_changed 事件 | RS-02-repos, RS-05-retrieval | 1d |
| `RS-07-admin-base` | 管理端 HTTP 基座：admin-token/Cookie 鉴权、Host/Origin/CSRF、统一错误、/health、/overview 与静态托管 | RS-02-repos | 2d |
| `RS-08-admin-servers` | servers 管理端点：GET/POST/PATCH/DELETE、connect/disconnect/restart/test、tools/refresh 与 202 operation | RS-07-admin-base, RS-03-secrets, RS-06-catalog | 2d |
| `RS-09-admin-tools` | 工具端点：GET /servers/:id/tools 生效值、PATCH /tools/:serverId/:name、POST /tools/batch 事务与 GET /search 预览 | RS-07-admin-base, RS-05-retrieval | 2d |
| `RS-10-admin-clients` | 客户端绑定端点：POST 创建绑定并返回 token（token 本机保存，可在管理端查看/轮换；轮换使旧 token 失效）、GET 列表、PUT/DELETE 与按 binding 销毁执行会话 | RS-07-admin-base, RS-02-repos | 1d |
| `RS-11-admin-config` | secrets 端点与配置导出/导入：键名只读、值写入、剔除 $secret、dry-run 与 202 导入 | RS-07-admin-base, RS-03-secrets, RS-02-repos | 2d |
| `RS-12-admin-discover` | 本地环境探测端点 POST /discover：配置文件、命令与凭据文件三类探针，只报键名不读值 | RS-07-admin-base | 1d |
| `RS-13-audit-query` | 审计 JSONL 流式读取与查询：过滤参数、cursor 分页、eval 轨迹与执行会话列表 | RS-07-admin-base | 2d |
| `RS-14-audit-frames-export` | 协议帧配对端点与审计导出：request/response 配对、summary/full、截断元数据与 10 万行上限 | RS-13-audit-query | 2d |
| `RS-15-audit-stats` | 审计聚合 worker：工具调用量/错误率/p50/p95/排队均值、groupBy 与 10s 缓存、200k 行/10s 饱和返回 503 | RS-13-audit-query | 2d |
| `RS-16-sse` | SSE 中枢：/admin/api/events 与 /admin/api/logs/stream、Last-Event-ID 回放、心跳与缺口事件 | RS-07-admin-base, RS-13-audit-query | 2d |
| `RS-17-web-shell` | React 19 + Ant Design 6 + esbuild 管理端骨架（ADR 0009）：SPA 路由、类型化 API client、主题 token 与 CSRF/鉴权 | RS-07-admin-base | 2d |
| `RS-18-web-audit` | 审计页：过滤条、概览卡片、趋势图、虚拟列表、调用抽屉、eval 甘特与协议帧并排 | RS-17-web-shell, RS-19-web-resource, RS-13-audit-query, RS-14-audit-frames-export, RS-15-audit-stats, RS-16-sse | 2d |
| `RS-19-web-resource` | 实时与资源约束模块：5000 条环形缓冲、200ms 批处理、页面可见性暂停、30fps 限制、降采样与 3D 默认关闭 | RS-17-web-shell | 1d |
| `RS-20-web-manage` | 配置管理页：概览、servers/tools 编辑、clients 与 token 查看/轮换、密钥状态、导入导出与 discover | RS-17-web-shell, RS-19-web-resource, RS-08-admin-servers, RS-09-admin-tools, RS-10-admin-clients, RS-11-admin-config, RS-12-admin-discover, RS-16-sse | 2d |

## 06–08 增量

以下任务不在 2026-11-18 的 67 个基线任务内，是 06–08 设计落地时追加的。状态按当前源码与测试记录，不再使用「全部任务已实现并验证」的原始表述。

### 报告与告警（06）

| id | 任务 | 依赖 | 状态 |
|---|---|---|---|
| `RPT-01-schema-v2` | schema v2：`reports` 表、索引与 v1→v2 迁移（与 07 共用） | RS-01-statedb | 已实现 |
| `RPT-02-store-service` | `reports/store.ts` 仓储 + `reports/service.ts` 落库、去重、限流 | RPT-01-schema-v2 | 已实现 |
| `RPT-03-report-tool` | `report_problem` 工具、5 工具注册与 MCP instructions | srv-13-tool-registry, RPT-02-store-service | 已实现 |
| `RPT-04-alerts` | `alerts/config-store.ts`、企业微信消息与 `alerts/dispatcher.ts` outbox | RPT-02-store-service | 已实现 |
| `RPT-05-admin-ui` | `/reports`、`/alerts/*` 管理端点与 Web 告警 tab | RPT-04-alerts, RS-07-admin-base | 已实现 |
| `RPT-06-tests` | `report-*.test.ts`、`alerts-*.test.ts`、`reports-e2e.test.ts`（假 webhook 完整链路） | RPT-05-admin-ui | 已实现 |

### 懒加载发现（07）

| id | 任务 | 依赖 | 状态 |
|---|---|---|---|
| `DSC-01-config` | `toolDiscovery` 配置类型、CRUD、导入导出与校验 | RPT-01-schema-v2 | 已实现 |
| `DSC-02-parse` | `discovery/parse.ts` 解析器（P-* 用例） | DSC-01-config | 已实现 |
| `DSC-03-preview` | 预览服务、preview store 与 tombstone | DSC-02-parse | 已实现 |
| `DSC-04-apply` | `discovery/store.ts` 的 apply/demote 事务与 stale 标记 | DSC-03-preview | 已实现 |
| `DSC-05-prepare` | `prepareOnCall`、serial 提升与 stale 路由 | DSC-04-apply, srv-11-pool-lifecycle | 已实现 |
| `DSC-06-admin-ui` | `discovery/handler.ts` 端点与 Web 扫描/预览 | DSC-04-apply, RS-07-admin-base | 已实现 |
| `DSC-07-tests` | `discovery-*.test.ts` 与 `discovery-mcp` fixture（P/D/A/R/E 矩阵） | DSC-06-admin-ui | 已实现 |

### AI 配置与标注（08）

| id | 任务 | 依赖 | 状态 |
|---|---|---|---|
| `AI-01-settings` | `ai/settings.ts` 与 `GET/PUT /ai/config` | RPT-01-schema-v2 | 已实现 |
| `AI-02-runner` | `ai/runner.ts`、limiter、errors 与 fake-claude fixture | AI-01-settings | 已实现 |
| `AI-03-prompts` | `ai/prompts.ts`、`ai/validate.ts`、proposal store 与 propose/apply | AI-02-runner | 已实现 |
| `AI-04-annotate` | `ai/apply.ts`、annotation-store 与 annotate preview/apply | AI-03-prompts | 已实现 |
| `AI-05-admin-ui` | `/ai/*` 路由、Web AI tab 与审计 `ai_run` | AI-04-annotate, RS-07-admin-base | 已实现 |
| `AI-06-tests` | `ai-*.test.ts`（runner、校验、路由、limiter、apply） | AI-05-admin-ui | 已实现 |

## 测试与端到端

| id | 任务 | 依赖 | 估算 |
|---|---|---|---|
| `RST-T01` | 提交合规的 MCP probe fixture（HTTP：discover/tools/tasks get/cancel/update） | — | 1d |
| `RST-T02` | 测试基座：隔离环境、子进程生命周期与 Streamable HTTP/stdio JSON-RPC 客户端 | — | 1d |
| `RST-T03` | 协议契约测试：server/discover、5 工具面与 MCP tasks 方法 | RST-T02, 外部实现：/mcp Streamable HTTP transport 与手写 discover/tasks 方法表 | 2d |
| `RST-T04` | 结果契约测试：content only、repl-output XML 与 wait_tasks | RST-T02, 外部实现：run_script 执行器、XML renderer、wait_tasks 队列 | 1d |
| `RST-T05` | 身份与会话生命周期契约测试（binding/client、401、DELETE /mcp、重连） | RST-T02, 外部实现：token 解析、client_bindings、/mcp 传输会话、DELETE /mcp、/admin/api/clients | 1d |
| `RST-T06` | 并发与容量契约测试（serial=per-server 写锁、exclusive、配额默认值） | RST-T01, RST-T02, RST-T07, 外部实现：工具路由并发闸门、per-server 锁、容量与 LRU | 2d |
| `RST-T07` | fake claude mcp serve（stdio）替身：22 工具与返回形状 | — | 1d |
| `RST-T08` | REPL 端到端：HTTP daemon 与 stdio 传输（不启动 Claude Code） | RST-T02, RST-T03, RST-T04, RST-T05, RST-T06, RST-T07, 外部实现：HTTP daemon 启动参数（端口 0）、stdio 入口、REPL_CLAUDE_BIN/PATH 注入 | 2d |
| `RST-T09` | Claude Code 2.1.327 E2E：headless 自动 + interactive 手工冒烟 | RST-T01, RST-T07, RST-T08 | 1d |
| `RST-T10` | 验收矩阵、无测试闸门与 CI 命令 | RST-T01, RST-T02, RST-T03, RST-T04, RST-T05, RST-T06, RST-T07, RST-T08, RST-T09 | 1d |

## 待办

### MCP 协议双版本兼容（2025-11-25 legacy / 2026-07-28 modern）

状态：已完成（2026-11-25）。

- **现象**：请求记录出现 `Unsupported protocol version: 2025-11-25`。`server/src/mcp/discover.ts:9-10` 只允许 `2026-07-28`，`initialize` 与 `server/discover` 共用同一版本数组；未知版本返回 `-32600`（`discover.ts:121-125`）。
- **背景**：2025-11-25 是 legacy 稳定版；2026-07-28 是破坏性 modern 版本（移除 initialize/会话等），不是超集。TS SDK 1.x 仍以 2025-11-25 为 LATEST；本服务出站连接池初始版本也是 2025-11-25（`server/src/pool/adapters/client.ts:34`），所以自环/连另一个 repl-server 会触发该错误。
- **实施**：`server/src/mcp/discover.ts` 拆分 `DISCOVER_PROTOCOL_VERSION`（`2026-07-28`，仅 `server/discover` 使用）、`LEGACY_PROTOCOL_VERSION`（`2025-11-25`）与 `INITIALIZE_PROTOCOL_VERSIONS`（`2025-11-25` + `2026-07-28`）。`initialize` 对两个版本回显请求值并返回 legacy 形状（无 `resultType`、无 tasks 扩展）；缺失/非字符串/空字符串仍 `-32602`，其他未知版本按 2025-11-25 规范回退到 `2025-11-25`。`server/discover` 的 `supportedVersions` 与 `_meta` 版本 pin 校验不变，仍只接受 `2026-07-28`。
- **不在本次范围**：`MCP-Protocol-Version` 请求头校验（无效 400）、Streamable HTTP 无效 Origin 403，作为独立合规项记录。
- **测试/文档**：`docs/protocol.md` §3.2 已同步支持版本与回退规则；`test/discover.test.ts` 覆盖两版本回显、未知版本回退、空/非字符串 `-32602`、discover 仅报 modern 且 2025 pin 仍拒绝；`test/app.test.ts` 的 HTTP 2025 pin 拒绝用例保持。改后需 `node scripts/build.mjs` 并重启。
- **验收记录（2026-11-25）**：`node --test test/discover.test.ts test/app.test.ts test/stdio-bridge.test.ts test/assembly.test.ts test/pool-adapters.test.ts` 59/59 通过；server 全量 `node --test "test/*.test.ts"` 1064/1064 通过（首轮 `gateway-lifecycle` 的 `queueMs === 0` 时序断言偶发 1ms，聚焦重跑 3/3 与第二轮全量均通过，与本次改动无关）；`npm run typecheck`、`npm run build`、`npm run docs:check` 通过。

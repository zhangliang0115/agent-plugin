# repl-server MCP 协议

- 状态：已冻结（2026-11-18），实现以本文为准；工具面 7 个已实现并有测试
- 协议版本：MCP `2026-07-28`（modern）；legacy `initialize` 兼容 `2025-11-25` 与 `2026-07-28`
- 设计依据：learn-ai `claude-code/自建设计/` 01 §4.2、02 §4.2–4.4、03 §2、06 §3.1
- 传输：Streamable HTTP（stateful），`/mcp`；stdio 通过独立 bridge 转 HTTP

## 1. 端点

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `/mcp` | MCP 端点 | `Authorization: Bearer <client-token>`；宽松模式允许全局 `mcp-token` 或无 token |
| `/admin/*` | 管理 API 与静态页 | `admin-token` 或同源 Cookie |
| `/health` | 存活检查 | 无 |

默认只绑 `127.0.0.1`，校验 `Host` 为 `127.0.0.1` / `localhost`（比较时先剥端口）。远程访问用 `--host` 改绑定地址，用 `--allowed-hosts` 显式放行域名（逗号分隔，支持 `*` 和 `*.ts.net` 后缀）；非 loopback 绑定必须同时给 `--strict-auth`，否则拒绝启动。

`/admin/api/*` 是管理面 HTTP 端点，**不属于本文的 MCP 契约**；其端点总表、请求/响应形状与错误码见 [`admin-api.md`](admin-api.md)（同为 L1 契约，`docs:check` 校验其端点与代码路由一致）。

### 1.1 启动与数据根

```bash
repl-server --port 8787            # HTTP daemon；--port 0 允许，实际端口写 stderr
repl-server --stdio --url http://127.0.0.1:8787/mcp --token-file <path>

# 远程 / 反代：绑定所有地址，只放行本机与 tailnet 域名
repl-server --host 0.0.0.0 --allowed-hosts '*.ts.net,127.0.0.1,localhost' \
  --strict-auth
```

- 数据根：`AGENTS_HOME`，默认 `~/.agents`；状态在 `$AGENTS_HOME/repl-server/`。
- 严格模式：`--strict-auth`；默认宽松。非 loopback 绑定时宽松模式会直接拒绝启动。
- `--admin-require-token`：关闭管理端自动登录。默认对来自 loopback 的请求生效（本机浏览器，或 Tailscale Serve 等本机反代），静态 GET 会用 `admin-token` 自动换 session；直连 8787 的远程客户端仍需 token。关闭自动登录后，打开管理端用 `/admin?token=<admin-token>` 或启动日志里的一次性 bootstrap token 交换 session。
- `--allowed-hosts '*'` 关闭 Host 校验，只应在前面已有可信反向代理或私有网络时使用。
- 服务本身只讲 HTTP；远程 HTTPS 由 Tailscale Serve 等反代终止 TLS（例如 `tailscale serve --bg --https=8443 http://127.0.0.1:8787`，再用 `https://<node>.<tailnet>.ts.net:8443/mcp`）。
- `claude` 二进制：`REPL_CLAUDE_BIN` > `PATH` 里的 `claude`。
- stdio 模式是 1:1 bridge：要求 daemon 已运行，stdin/stdout 只走 JSON-RPC，server-initiated requests（roots/list、elicitation）双向转发；缺 token 或 daemon 不可达时以退出码 2 结束并写 stderr。
- 单实例锁：`$AGENTS_HOME/repl-server/state.db.lock`，内容 `{pid, startedAt}`。启动时若 PID 不存在或不是 repl-server，按 stale 重写；并发启动仍用 `O_EXCL` 保证只有一个赢家。

### 1.2 SDK 边界

`@modelcontextprotocol/sdk@1.32.2` 的 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`，没有 `server/discover`，本机 registry 也不可用。**最终不引入 SDK**：Streamable HTTP、`Mcp-Session-Id`、JSON-RPC 分发、tasks 与连接第三方 server 的客户端适配层（`HttpMcpClient` / `StdioMcpClient`）全部手写。`server` 与 `core` 没有任何运行时依赖（`server/package.json` 只有 `esbuild` 一个 devDependency）。

## 2. 身份

| 字段 | 来源 | 可信 |
|---|---|---|
| `binding` | `client_bindings.token_hash` 反查 | 是 |
| `client` | `clientInfo.name/version`（`_meta` 或 legacy initialize） | 否，只用于审计展示 |
| `identity` | 服务端判定 | `bound` / `unbound` |

凭证矩阵：

| 请求头 | 宽松（默认） | 严格 |
|---|---|---|
| 客户端 token，命中绑定 | `bound` | `bound` |
| 全局 `mcp-token` | `unbound` | 401 |
| 无 `Authorization` | `unbound` | 401 |
| 未知/格式错 token | 401 | 401 |

每个请求重查绑定；删除或轮换后旧会话立即 401。

## 3. 方法

### 3.1 `server/discover`

请求：

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "server/discover",
  "params": { "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { "name": "claude-code", "version": "2.1.327" },
    "io.modelcontextprotocol/clientCapabilities": {}
  } }
}
```

响应：

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": {}, "extensions": { "io.modelcontextprotocol/tasks": {} } },
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "repl-server", "version": "0.2.0" } },
    "instructions": "<静态短提示，见 §5>",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

### 3.2 legacy `initialize`

只给不实现 discover 的客户端。接受 `2025-11-25`（legacy 稳定版）与 `2026-07-28`（modern，兼容入口）两个版本，响应回显请求的 `protocolVersion`。无论请求哪个版本，响应都是 legacy 形状：`protocolVersion` + 顶层 `serverInfo`，没有 `supportedVersions`、`resultType`；`capabilities.tools` 为空对象，不声明 modern 的 tasks 扩展，`instructions` 同样返回。

**未知版本回退**：`protocolVersion` 缺失、非字符串或空字符串返回 `-32602`；其余不支持的版本按 2025-11-25 规范回退到服务端支持的最新 legacy 版本 `2025-11-25`，结果里的 `protocolVersion` 用回退值，不再返回 `-32600`。回退只适用于 `initialize`，`server/discover` 的 `_meta` 版本 pin 仍只接受 `2026-07-28`。

**会话建立规则**：任何不带 `Mcp-Session-Id` 的请求都隐式建立传输会话（`initialize` → legacy，其余 → modern），响应头返回 `Mcp-Session-Id`；会话在首个请求后固定为 modern 或 legacy，不能混用。带了未知/过期 `Mcp-Session-Id` 返回 404，让客户端重新建连。**实测依据**：Claude Code 2.1.327 的 `claude -p` 只带会话头发首个 `server/discover`，后续 `tools/list`、`tools/call` 不带会话头；严格按"首个请求必须是 discover"校验会让工具永远注册不上。`server/discover` 的 `_meta` 版本 pin 不是 `2026-07-28` 时返回 JSON-RPC `-32600`，`data.supportedVersions` 带支持列表。`GET /mcp` 保持 SSE 通道；不需要时返回 405。

### 3.3 `tools/list`

返回 7 个工具，顺序固定：`run_script`、`search_tools`、`describe_tools`、`wait_tasks`、`report_problem`、`save_script`、`search_scripts`。结果固定带 `resultType: "complete"`（与 `tools` 同级）；协议修订 `2026-07-28` 要求 modern 结果必须带该字段，缺省不再视为 complete。每个工具带：

- `description`：`run_script` 按本次请求可见的 MCP server 动态拼接，UTF-8 ≤2048 字节。`## MCP servers (server id, category, visible tool count)` 段每行 `<id>  [<category>]  <N> tools`，数字是该客户端当前可见/已发现的工具数，0 表示暂无可见工具；不打印 summary、工具名或 env 标签。固定核心与末尾 `Call` 与发现指引优先保留，server 行从列表尾部截断。固定核心提示独立工具调用可用 `Promise.all` 并行。其余工具一句话。可见 server 列表只在这一处，`instructions` 只留指针。
- `inputSchema`：见 §4
- `_meta: { "anthropic/alwaysLoad": true }`
- `annotations`：`run_script`、`report_problem` 与 `save_script` 不设；`search_tools`、`describe_tools`、`search_scripts` 设 `readOnlyHint: true`、`idempotentHint: true`；`wait_tasks` 只设 `readOnlyHint: true`——它消费结果，重试返回 `ALREADY_CONSUMED` 而不是同一份结果，不能声称幂等
- 结果顶层带 `ttlMs: 0`、`cacheScope: "private"`：2026-07-28 的列表结果必须带缓存提示；工具可见性按 binding 与目录变化，不做客户端缓存

**方法表（v1）**：`server/discover`、`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`tasks/get`、`tasks/cancel`、`tasks/update`。除 legacy `initialize` 外，modern 结果都带 `resultType`；`ping` 返回 `{ "resultType": "complete" }`。不支持 resources/prompts/logging/subscriptions；未知方法 `-32601`；批量请求不支持。

### 3.4 `tools/call`

七种工具名。只有 `run_script` 可能返回 task；其余六个永远同步返回 `resultType: "complete"`。七个工具都是 MCP 顶层工具，不在 `run_script` 的 `tools` 对象里，脚本内不可调用；`run_script` 的 description 会写明发现类工具在脚本之外使用。`report_problem`、`save_script`、`search_scripts` 不占 eval 预算。

#### 同步结果

```json
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "<repl-output eval=\"12\">...</repl-output>" }],
    "isError": false
  }
}
```

- 媒体（图片/PDF）作为额外 `content` 块追加，**不进 XML**。
- 不返回 `structuredContent`，不声明 `outputSchema`。
- 失败时 `isError: true`，`content[0].text` 仍是 `<repl-output>`，正文含 `<error>`。

#### task 结果

判定只看输入：

| 条件 | 返回 |
|---|---|
| `async: true` | 普通 `CallToolResult`，XML 带 `async="true" task="<evalTaskId>"` |
| 客户端本次请求声明 tasks，且 `async` 未传/false，且 `timeout > 30000` | `CreateTaskResult` |
| 其余 | 同步 `CallToolResult` |

`CreateTaskResult`：

```json
{
  "resultType": "task",
  "taskId": "t_01J...",
  "status": "working",
  "createdAt": "2026-11-18T06:00:00.000Z",
  "lastUpdatedAt": "2026-11-18T06:00:00.000Z",
  "ttlMs": 9000000,
  "pollIntervalMs": 500
}
```

`ttlMs` 是任务映射的进程安全保留期（9000000 ms），从创建时刻起算；脚本本身没有运行时长上限。

## 4. 工具 schema

### `run_script`

```json
{
  "type": "object",
  "properties": {
    "code": { "type": "string" },
    "scriptName": { "type": "string" },
    "scriptVersion": { "type": "integer", "minimum": 1 },
    "args": { "type": "object" },
    "activateOnSuccess": { "type": "boolean" },
    "timeout": { "type": "integer", "minimum": 1 },
    "async": { "type": "boolean", "default": false },
    "workspace": { "type": "string" },
    "visibleTools": { "type": "array", "items": { "type": "string" } },
    "excludeTags": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```

- `code`、`scriptName` 二者恰好给一个；都不给、给多个（含 `code` 与 `scriptName` 同给）或 `scriptName` 为空字符串返回 `INVALID_ARGUMENT`。`args`、`scriptVersion`、`activateOnSuccess` 只在脚本模式（`scriptName` 或 legacy `scriptId`）合法。
- `scriptId` 是系统生成的内部编号，不出现在 schema。旧客户端仍可传 `scriptId`（仅未被模型看到的隐藏兼容）：服务端在参数校验前把它剥离，只按 ID 执行；`scriptId` 与 `scriptName` 同传、或与 `code` 同传返回 `INVALID_ARGUMENT`。
- `scriptName` 按全局唯一名称解析为内部 `scriptId` 后继续执行：名称只用于定位，不做 ID/名称互相回退；名称不存在返回 `SCRIPT_NOT_FOUND`（消息带名称），解析后仍走与 ID 相同的状态、版本、权限与参数校验，审计与运行历史记录解析出的真实 `scriptId`，但工具 schema 与结果只出现名称。
- 脚本模式（`scriptName` 或 legacy `scriptId` 解析出的 id）：省略 `scriptVersion` 用 active 版本，没有 active 返回 `SCRIPT_NOT_ACTIVE`；`exact` 版本不接受参数，`parameterized` 版本按 `inputSchema` 校验 `args`；draft 只能显式带 `scriptVersion` 执行，且只允许 owner（`createdBy` 等于调用方 `binding ?? mcp`）或 admin 测试，其他调用方返回 `SCRIPT_FORBIDDEN`；active 版本对全局开放。脚本库是全局命名空间，`workspace` 只决定执行会话，不参与脚本可见性。
- `activateOnSuccess` 目标版本必须是 draft；同步和异步都支持：成功 settle 时在写入 `script_runs` 的同一事务里激活，失败保持 draft；settle 时版本已非 draft（被并发激活/归档）则不改状态、执行结果仍正常返回并记录实际状态；settle 时调用方不是 owner/admin 时同样只跳过激活（`activationSkipped: "forbidden"`），执行结果不变。成功后该版本变为 active、旧 active 变为 superseded。
- `run_script` 每次执行都会归档到 `script_runs`（保留 30 天）：成功的 code 模式保存源码，脚本模式保存 `scriptId` / `scriptVersion` / `scriptMode` / `args`，并把 `args` 的 JSON 摘要写入 `args_preview`（上限 512 字符）；摘要先脱敏再截断，完整 `args` 仍按原文存 `args_json`（已知风险）。`eval_start` / `eval_end` / `async_dispatch` 的 `argsPreview` 同样是脱敏值；扫描到疑似密钥时另带 `secretWarnings`（按 `field` / `kind` / `severity` / `count` 聚合，不含原文），只作提示，不阻断执行。归档写失败只记日志，不回滚执行结果。
- `timeout`：可选，正整数毫秒；省略表示不设截止时间（同步与 `async: true` 相同），没有默认值。显式值超过 L2 上限时**钳到上限**而不是报错：同步 600000，`async: true` 7200000。单次同步执行切片仍受 L0（5s）保护，超时会终止该切片。0、负数或非有限值返回 `INVALID_ARGUMENT`。
- `workspace` 取 realpath 后参与执行会话 key：已绑定客户端按 `(binding, workspace)` 识别，跨传输会话复用；未绑定客户端按 `(Mcp-Session-Id, workspace)` 识别。换 workspace 新建执行会话，变量与 `state` 不继承。
- `visibleTools` 内置工具用裸名，MCP 工具用 `<server>.<tool>`；只收窄，不放大。

**workspace 数量配额**：现代协议无传输会话，按 MCP 会话的 workspace 配额已移除；未绑定客户端仍以传输 id 作为 owner 参与 binding 级配额，但现代客户端每次请求新建传输，因此该配额只对 legacy 客户端有意义。

### `search_tools`

`tools/list` 每次请求生成该定义：`server` 的 `enum` 是本次请求可见的 MCP server id（含 idle / 0 工具 server，去重排序）；`category` / `tags.items` 的 `enum` 只含本次请求可见工具里实际存在的值（去重排序）。对应集合为空时属性保留但不给 `enum`。`tools/call` 用同一份定义校验，enum 外的值返回 `INVALID_ARGUMENT`。

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "maxLength": 200 },
    "server": { "type": "string", "enum": ["<可见 MCP server id>"] },
    "category": { "type": "string", "enum": ["<可见分类>"] },
    "tags": { "type": "array", "items": { "type": "string", "enum": ["<可见标签>"] } },
    "max": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
  },
  "additionalProperties": false
}
```

- 空 `query` 未传 `server`：返回 server 概览，每项 `{ "name", "kind": "mcp", "server", "category?", "summary?", "tags?", "toolCount", "description" }`。
- 空 `query` 传 `server`：返回该 server 的 MCP 工具列表（仍受 `category`/`tags`/`max` 收窄），按规范名排序。
- 非空 `query`：先走 `tools_fts` 的 FTS5 MATCH（按 Han/字母数字连续片段分词，保留大小写与重复，最多取前 32 个 token，每个 token 加引号做前缀匹配并用 `OR` 连接，按 `bm25` 计分），再把 `query` 按空白切词、转小写后按固定小批（每批 16 个词）执行 LIKE 子串扫描并合并结果；LIKE 批次另带工具名与 `<server>.<tool>` 的精确等值条件，纯标点工具名（如 `+++`）由此可达。匹配字段为工具名、生效 description、生效 tags（tool tags 与 server tags 的并集）；display_name、server id、server summary 不参与关键词匹配。`server`/`category`/`tags` 只做结构化收窄，`tags` 是 all-of。
- 非空 `query` 的排序：先按 `scoreTool` 分数降序，再按 FTS `bm25` 升序（LIKE-only 命中没有 bm25，排在同分 FTS 命中之后），最后按规范名升序。精确名只通过 `scoreTool` 的 +10 得分体现，没有独立的精确名层级，因此 `max` 截断后的子集不保证与纯快照路径一致。空 `query` 仍走快照概览/列表。
- 非空 `query` 的已知限制：非 ASCII 字符的大小写折叠与变音符号等价不保证命中（LIKE 的 `lower()` 只折叠 ASCII）；server id 与 server summary 不作为匹配字段，纯 server id 查询（如 `pg-main`）本身不命中；但 server id 被分隔符拆出的普通词（如 `pg`、`main`）若同时出现在工具名/description/tags 中，工具仍会作为正常关键词命中。
- 结果项 `{ "name": "<server>.<tool>", "kind": "builtin"|"mcp", "server?", "category?", "summary?", "description?", "tags?" }`。
- 可见性：`allowed_servers` 只约束 MCP 工具（builtin 不受约束）；`allowed_tags` 对有效 tags 做 any-of 且同样约束 builtin；空列表表示全部不可见。

### `describe_tools`

```json
{
  "type": "object",
  "properties": {
    "names": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10 }
  },
  "required": ["names"],
  "additionalProperties": false
}
```

返回 `{ "tools": [{ "name", "inputSchema" }] }`，按请求顺序返回全部 schema，不做字符预算截断。`names` 超过 10 个是参数校验失败（`INVALID_ARGUMENT`）；任一名字未知或对该客户端不可见时整次调用失败，返回 `UNKNOWN_TOOL`，不返回部分结果。

### `wait_tasks`

```json
{
  "type": "object",
  "properties": {
    "taskIds": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 600000, "default": 270000 }
  },
  "required": ["taskIds"],
  "additionalProperties": false
}
```

返回：

```json
{
  "ok": true,
  "timedOut": false,
  "events": [
    { "taskId": "t_01J...", "evalId": 7, "status": "completed",
      "result": "...", "stdout": "...", "elapsedMs": 480000 }
  ],
  "pending": 0
}
```

- `taskIds` 必填，1 个或多个：只等这些任务，没有按 owner 全量收取的兜底，所以正常调用不会误取别人的任务。owner 是 `bindingId ?? mcpSessionId`：已绑定客户端跨传输会话、跨 workspace 可见（同一 binding 下的多个项目共用一个 owner，知道 `taskId` 即可收取，属有意决策，与 `tasks/get` 同作用域）；未绑定客户端随传输 id 隔离。
- 事件额外带 `runId`；脚本执行还带 `entryMode`、`scriptId`、`scriptVersion`、`scriptMode`、`argsPreview`（code 模式没有后五项）。`argsPreview` 是 `args` 的 JSON 摘要，上限 512 字符；完整参数只留在 `script_runs.args_json`。
- 结果消费一次；重复取返回 `ALREADY_CONSUMED`。
- 未知 id：`{ "ok": false, "error": { "code": "UNKNOWN_TASK", "unknownIds": [] } }`，同时 `isError: true`。
- `status`：`completed` / `failed` / `cancelled`。

### `report_problem`

依据 06 §3.1 的冻结 schema。它是第 5 个工具：调用形状是 `report_problem({...})`，不能用 `tools.` 前缀。所有顶层工具都不进入 `run_script` 的脚本工具面。

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "detail": { "type": "string", "minLength": 1, "maxLength": 20000 },
    "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
    "context": { "type": "object", "additionalProperties": true }
  },
  "required": ["title", "detail", "severity"],
  "additionalProperties": false
}
```

- `title` / `detail` 按 trim 后的 Unicode 码点计数；`context` 的 8192 字节上限只在服务端强制。
- 成功返回 `{ "ok": true, "reportId": "rep_...", "duplicate": false }`；去重命中返回已有 id 且 `duplicate: true`。
- 永远同步返回，不参与 task 判定、不占 `run_script` 的调用预算。

### `save_script`

```json
{
  "type": "object",
  "properties": {
    "runId": { "type": "string" },
    "scriptName": { "type": "string" },
    "baseVersion": { "type": "integer", "minimum": 1 },
    "mode": { "type": "string", "enum": ["exact", "parameterized"] },
    "name": { "type": "string", "minLength": 1, "maxLength": 120 },
    "description": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
    "code": { "type": "string" },
    "inputSchema": { "type": "object" },
    "exampleArgs": { "type": "object" },
    "changelog": { "type": "string", "maxLength": 1000 }
  },
  "additionalProperties": false
}
```

- 创建（不带 `scriptName`）：`mode`、`name`、`description` 必填。`exact` 必须有 `runId`，来源执行必须成功、未过期且 `entry_mode='code'`；保存其原始代码为 active v1，零参数。`parameterized` 必须有 `code` 与 `inputSchema`，`runId` 可选（只作来源）；保存为 draft v1，不进入 `search_scripts`。
- 脚本名全局唯一，冲突返回 `SCRIPT_NAME_CONFLICT`；`workspace` 不再是脚本属性，所有 agent 都可创建全局脚本。脚本归创建者所有（`created_by` 为调用方 `binding ?? mcp`）；带 `scriptName` 更新只允许 owner 或 admin，其他调用方返回 `SCRIPT_FORBIDDEN`。
- 有 `scriptName` 即更新该脚本：`name` 是本次写入后的脚本名（可重命名），`scriptName` 只是目标脚本，二者可同时出现；`scriptName` 不存在返回 `SCRIPT_NOT_FOUND`，不执行。`scriptId` 是系统生成的内部编号，不出现在 schema；旧客户端传 `scriptId` 时服务端在校验前剥离并按 ID 更新，`scriptId` 与 `scriptName` 同传返回 `INVALID_ARGUMENT`。只传 `name` / `description` / `tags` 时直接改元数据、不产生版本；改 `code` / `inputSchema` 时必须带 `baseVersion`，新增 draft 版本，旧 active 不变；`baseVersion` 与最新版本不一致返回 `SCRIPT_VERSION_CONFLICT`。每个脚本的 `mode` 固定（以 `scripts.mode` 为准），切换 mode 返回 `SCRIPT_MODE_CONFLICT`，需要新脚本。`exact` 的创建与更新都必须给 `runId`（来源执行须成功、未过期且 `entry_mode='code'`），代码取自来源 run，提交 `code` 返回 `INVALID_ARGUMENT`，`inputSchema` / `exampleArgs` 只能为空对象或省略；该来源 `runId` 写入新版本的 `verified_run_id`。`parameterized` 的 `runId` 可选，只记来源。
- `inputSchema` 只支持 P1 子集：根 `type: "object"`，属性类型 `string` / `integer` / `boolean` / `object` / `array`，关键字 `enum` / `minLength` / `maxLength` / `minimum` / `maximum` / `minItems` / `maxItems` / `items`，根 `required` 与 `additionalProperties: false`；超出返回 `SCRIPT_INPUT_SCHEMA_INVALID`。未声明的参数一律拒绝。
- `parameterized` 保存时编译一次代码；语法错误或超过 1 MiB 返回 `SCRIPT_CODE_INVALID`。1 MiB 与 `/mcp` 请求体上限一致。
- 保存时对 `code` 与 `exampleArgs` 做密钥扫描；有发现时在返回值 `warnings` 中给出聚合结果（`field` / `kind` / `severity` / `count`，不含原文）。只告警：不拒绝保存、不改写代码、不阻断后续执行。
- 返回 `{ "scriptName", "version", "status", "activeVersion", "mode", "warnings" }`；`scriptId` 不出现在工具结果，内部与管理端接口仍使用它。成功与失败都会写一条 `script_saved` 审计事件（`ok`、`scriptId`、`version`、`mode`、`name`、`sourceRunId`、`error`；成功事件另带 `warnings`）。

### `search_scripts`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "maxLength": 200 },
    "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 }
  },
  "additionalProperties": false
}
```

返回 `{ "scripts": [{ "scriptName", "description", "tags", "mode", "activeVersion", "inputSchema", "exampleArgs", "useCount", "lastUsedAt", "updatedAt" }] }`；工具结果不含 `scriptId`（管理端搜索接口仍返回内部 `scriptId` 与 `name`）。`mode` 来自 `scripts.mode`，同一脚本所有版本相同。只返回 active 脚本；draft / disabled / archived 不返回。非空 `query` 先走 `scripts_fts` 的 FTS5 MATCH（每个词加引号并做前缀匹配，按 `bm25` 排序，名称权重最高）；MATCH 无命中、非法或纯空白查询回退 LIKE，以保证中文中间子串仍能命中。空 `query` 按 `updated_at DESC` 列表。脚本库是全局命名空间，没有 workspace 过滤。

## 5. `instructions`

`instructions` 是静态短提示（≤1200 字符）：执行模型、工作流、错误约定，以及“不要猜工具名”；执行模型与 `run_script` 描述同样提示独立工具调用可用 `Promise.all` 并行。末尾只留指针“可见 MCP server 列表在 `run_script` 的 description 里”。具体 server 列表只在 `run_script.description`（≤2KB，见 §3.3），两者不重复。分类/标签过滤值见 `search_tools` 的 schema。

## 6. 任务方法

### `tasks/get`

返回完整 Task：`{ resultType: "complete", taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs, runId?, scriptId?, scriptVersion?, scriptMode?, argsPreview?, result?, error? }`。

- `status`：`working | input_required | completed | failed | cancelled`
- `completed` 的 `result` 是 `CallToolResult` 形状
- 幂等读取，不消费 `wait_tasks` 队列
- 任务索引进程级，按 `binding` 校验归属；过期返回 `TASK_EXPIRED`

### `tasks/cancel`

请求 `{ taskId }`，空确认必须带 `{ "resultType": "complete" }`。脚本收到协作式中止；已结束的任务返回当前终态。

### `tasks/update`

不产生 `input_required`，空确认 `{ "resultType": "complete" }`；未知 key 忽略。

## 7. 结果信封

```xml
<repl-output eval="12" run="<uuid>" async="true" task="t_01J..." reset="1" restored="lastGood" truncated="1">
<log>...</log>
<result>...</result>
</repl-output>
```

- `eval`：执行会话内的 `evalId`
- `run`：本次执行的 `runId`（UUID v4），每次执行都不同；异步回执在派发时就有
- `async` / `task`：`async: true` 的派发回执
- `reset="1"`：worker 重建后的第一条结果
- `restored`：`state` 恢复成功
- `truncated="1"`：服务端在返回前按 L5 上限截断字段/日志/媒体后置位。截断必须在 server 内先做——客户端再截断会让模型看到断裂的 JSON 片段（01 §8.1）；媒体超限的数量另由 `imagesOmitted` / `documentsOmitted` 体现
- 文本中的 `&`、`<`、`>` 转义
- 失败时出现 `<error>`；`<log>` 含 stdout 与 stderr

## 8. 错误码

| code | 场景 |
|---|---|
| `INVALID_ARGUMENT` | schema 校验失败、timeout 非正整数、`describe_tools` 超过 10 个名字 |
| `UNKNOWN_TOOL` | `describe_tools` 的名字未知或对该客户端不可见 |
| `WS_INVALID` | workspace 不存在或不是目录 |
| `CAPACITY_EXCEEDED` | 执行会话/绑定配额已满且无可淘汰 |
| `UNKNOWN_TASK` | `wait_tasks` 的 id 不存在 |
| `ALREADY_CONSUMED` | 同一任务结果被二次收取 |
| `TASK_EXPIRED` | 任务超过 TTL |
| `MCP_QUEUE_FULL` | 第三方池的 binding 队列已满 |
| `MCP_CALL_TIMEOUT` | 单次 MCP 调用超时 |
| `MCP_SERVER_NOT_FOUND` | 目标第三方 server 不存在 |
| `MCP_SERVER_DISABLED` | 目标 server 已停用 |
| `MCP_SERVER_UNAVAILABLE` | 连接失败、进程退出或正在退役 |
| `MCP_TOOL_NOT_FOUND` | 目标工具不存在 |
| `MCP_TOOL_DISABLED` | 工具已停用 |
| `MCP_TOOL_ERROR` | 上游工具返回 `isError: true` |
| `MCP_PROTOCOL_ERROR` | 上游 JSON-RPC / transport 协议错误 |
| `MCP_SESSION_EXPIRED_RETRY` | 上游 HTTP 会话过期；可重连重试，不重放 |
| `MCP_CALL_CANCELLED` | 调用被取消（含发现扫描取消） |
| `MCP_CALL_FAILED` | core 工具桥的传输类调用失败 |
| `MCP_DISCOVERY_PREPARE_FAILED` | 懒加载预热（`search`）失败，业务调用未发出；`retryable` 取决于失败原因 |
| `MCP_DISCOVERY_TOOL_STALE` | 工具已不在最近一次扫描结果中；不可重试，需重新扫描 |
| `EXCLUSIVE_TIMEOUT` | `exclusive` 等待超过 30s |
| `REPORT_RATE_LIMITED` | `report_problem` 超过每 owner 的 1 小时 20 条上限；带 `retryAfterMs` |
| `REPORT_FAILED` | `report_problem` 落库失败 |
| `REPORT_UNAVAILABLE` | 服务未接线（只可能出现在测试） |
| `SCRIPT_RUN_NOT_FOUND` | `runId` 不存在或归档未写入 |
| `SCRIPT_RUN_NOT_SUCCESSFUL` | 来源执行失败或没有可复用代码 |
| `SCRIPT_RUN_EXPIRED` | 来源归档超过 30 天 |
| `SCRIPT_NOT_FOUND` | `scriptName` 没有对应脚本（legacy `scriptId` 不存在时同样返回） |
| `SCRIPT_VERSION_NOT_FOUND` | 版本不存在 |
| `SCRIPT_VERSION_NOT_DRAFT` | `activateOnSuccess` 目标不是 draft |
| `SCRIPT_VERSION_CONFLICT` | `baseVersion` 与最新版本不一致 |
| `SCRIPT_NAME_CONFLICT` | 脚本名已被占用（全局唯一） |
| `SCRIPT_ARGS_INVALID` | 参数不满足版本 `inputSchema` |
| `SCRIPT_DISABLED` / `SCRIPT_ARCHIVED` | 脚本或版本不可执行 |
| `SCRIPT_MODE_CONFLICT` | 更新版本试图改变脚本的 exact/parameterized 模式 |
| `SCRIPT_CODE_INVALID` | 代码语法错误或超过 1 MiB |
| `SCRIPT_INPUT_SCHEMA_INVALID` | `inputSchema` 超出 P1 子集 |
| `SCRIPT_NOT_ACTIVE` | 脚本没有 active 版本且未显式给 `scriptVersion` |
| `SCRIPT_FORBIDDEN` | 非 owner 更新脚本，或非 owner/admin 测试 draft 版本 |

工具层错误一律 `isError: true`，正文是 `<repl-output>`；JSON-RPC 层只用于协议错误（未知方法、参数不是对象）。

**错误通道映射**：

| 场景 | 通道 |
|---|---|
| 路径不存在、Host 不允许、JSON 解析失败 | HTTP 400/403/404 |
| 未知方法、参数不是对象、批量请求 | JSON-RPC `-32601` / `-32602` / `-32600` |
| `WS_INVALID`、`CAPACITY_EXCEEDED`、`MCP_QUEUE_FULL`、`MCP_CALL_TIMEOUT`、`MCP_CALL_CANCELLED`、`MCP_DISCOVERY_PREPARE_FAILED`、`MCP_DISCOVERY_TOOL_STALE`、工具执行失败 | `CallToolResult` + `isError: true`，正文 `<repl-output><error>` |
| `tasks/get` 未知/过期 | JSON-RPC `-32602`，`data: { code: "TASK_NOT_FOUND" \| "TASK_EXPIRED" }` |
| 上游（第三方 MCP）返回 `CreateTaskResult` | 第一版不支持，工具层 `UPSTREAM_TASK_UNSUPPORTED` |

**命名两层，同时存在**：协议/模型层的规范名是 `<server>.<tool>`（`search_tools`、`describe_tools`、`visibleTools`）；脚本内访问器是 `tools.mcp.<server>.<tool>`。两者不互相替代。

**任务归属**：`owner = bindingId ?? mcpSessionId`。绑定客户端按 binding 校验；未绑定客户端只能访问同一 `Mcp-Session-Id` 创建的任务，重连后旧任务不可见（返回 `TASK_NOT_FOUND`）。

**`DELETE /mcp`**：只销毁该传输下**未绑定**的执行会话：取消其所有在飞 eval（task 状态 `cancelled`），终止 worker/serve，删除这些执行会话的 task store，返回 204；之后这些任务 `tasks/get` / `tasks/cancel` 返回 `TASK_NOT_FOUND`。已绑定客户端的执行会话与任务属于 binding，不随传输关闭销毁。审计 `exec_end.reason = "delete"`。

**空闲计时**：传输会话用 `lastRequestAt`（60min）；执行会话用 `lastEvalAt`（60min）；容量 LRU 淘汰看 `lastEvalAt`，且必须无在飞 eval 且超过 `evictIdleMs`（默认 5min）。`tasks/get` / `search_tools` 不更新 `lastEvalAt`。

**测试钩子（生产默认不变）**：`REPL_TEST_CLOCK` 注入可控时钟（task TTL、idle 回收）；`REPL_CAPACITY_*` 覆盖容量默认值。两者只在 `NODE_ENV !== "production"` 时生效。

## 9. 兼容性测试

`test/fixtures/mcp-probe/` 里的 fixture server 覆盖：

1. discover 形状与 `instructions`
2. 未声明 tasks 的客户端得到同步结果
3. 声明 tasks 且 `timeout > 30000` 得到 `CreateTaskResult`
4. `tasks/get` 轮询到 `completed`
5. `tasks/cancel` 返回 `resultType: "complete"`
6. `async: true` 得到普通结果 + `evalTaskId`
7. `wait_tasks` 全部完成、指定 id、二次收取、未知 id

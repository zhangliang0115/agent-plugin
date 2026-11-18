# repl-server MCP 协议

- 状态：已冻结（2026-11-18），实现以本文为准
- 协议版本：MCP `2026-07-28`（modern）；legacy `initialize` 只做兼容
- 设计依据：learn-ai `claude-code/自建设计/` 01 §4.2、02 §4.2–4.4、03 §2
- 传输：Streamable HTTP（stateful），`/mcp`；stdio 通过独立 bridge 转 HTTP

## 1. 端点

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `/mcp` | MCP 端点 | `Authorization: Bearer <client-token>`；宽松模式允许全局 `mcp-token` 或无 token |
| `/admin/*` | 管理 API 与静态页 | `admin-token` 或同源 Cookie |
| `/health` | 存活检查 | 无 |

只绑 `127.0.0.1`，校验 `Host` 为 `127.0.0.1` / `localhost`（比较时先剥端口）。

### 1.1 启动与数据根

```bash
repl-server --port 8787            # HTTP daemon；--port 0 允许，实际端口写 stderr
repl-server --stdio --url http://127.0.0.1:8787/mcp --token-file <path>
```

- 数据根：`AGENTS_HOME`，默认 `~/.agents`；状态在 `$AGENTS_HOME/repl-server/`。
- 严格模式：`--strict-auth`；默认宽松。
- `claude` 二进制：`REPL_CLAUDE_BIN` > `PATH` 里的 `claude`。
- stdio 模式是 1:1 bridge：要求 daemon 已运行，stdin/stdout 只走 JSON-RPC，server-initiated requests（roots/list、elicitation）双向转发；缺 token 或 daemon 不可达时以退出码 2 结束并写 stderr。
- 单实例锁：`$AGENTS_HOME/repl-server/state.db.lock`，内容 `{pid, startedAt}`。启动时若 PID 不存在或不是 repl-server，按 stale 重写；并发启动仍用 `O_EXCL` 保证只有一个赢家。

### 1.2 SDK 边界

`@modelcontextprotocol/sdk@1.32.2` 的 `LATEST_PROTOCOL_VERSION` 是 `2025-11-25`，没有 `server/discover`，本机 registry 也不可用。**server 侧不依赖 SDK**：Streamable HTTP、`Mcp-Session-Id`、JSON-RPC 分发与 tasks 全部手写。SDK 只允许出现在连接第三方 server 的客户端适配层；如果依赖不可安装，连这层也手写（`HttpMcpClient` / `StdioMcpClient` 两个最小实现）。

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
    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "repl-server", "version": "0.1.0" } },
    "instructions": "<run_script 的完整说明，见 §5>",
    "ttlMs": 3600000,
    "cacheScope": "public"
  }
}
```

### 3.2 legacy `initialize`

只给不实现 discover 的客户端。响应用 `protocolVersion` + 顶层 `serverInfo`，没有 `supportedVersions`；`capabilities.tools` 为空对象，`instructions` 同样返回。

**会话建立规则**：任何不带 `Mcp-Session-Id` 的请求都隐式建立传输会话（`initialize` → legacy，其余 → modern），响应头返回 `Mcp-Session-Id`；会话在首个请求后固定为 modern 或 legacy，不能混用。带了未知/过期 `Mcp-Session-Id` 返回 404，让客户端重新建连。**实测依据**：Claude Code 2.1.327 的 `claude -p` 只带会话头发首个 `server/discover`，后续 `tools/list`、`tools/call` 不带会话头；严格按"首个请求必须是 discover"校验会让工具永远注册不上。请求了不支持的版本返回 JSON-RPC `-32600`，`data.supportedVersions` 带支持列表。`GET /mcp` 保持 SSE 通道；不需要时返回 405。

### 3.3 `tools/list`

返回 4 个工具，顺序固定：`run_script`、`search_tools`、`describe_tools`、`wait_tasks`。每个工具带：

- `description`：`run_script` ≤2KB；其余一句话
- `inputSchema`：见 §4
- `_meta: { "anthropic/alwaysLoad": true }`
- `annotations`：`run_script` 不设；其余 `readOnlyHint: true`、`idempotentHint: true`

**方法表（v1）**：`server/discover`、`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`tasks/get`、`tasks/cancel`、`tasks/update`。不支持 resources/prompts/logging/subscriptions；未知方法 `-32601`；批量请求不支持。

### 3.4 `tools/call`

四种工具名。只有 `run_script` 可能返回 task。

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

`ttlMs = 异步运行上限 7200000 + 终态保留 1800000`，从创建时刻起算。

## 4. 工具 schema

### `run_script`

```json
{
  "type": "object",
  "properties": {
    "code": { "type": "string" },
    "timeout": { "type": "integer", "minimum": 1000, "maximum": 7200000, "default": 30000 },
    "async": { "type": "boolean", "default": false },
    "workspace": { "type": "string" },
    "visibleTools": { "type": "array", "items": { "type": "string" } },
    "excludeTags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["code"],
  "additionalProperties": false
}
```

- `timeout`：同步默认 30s、上限 600s；`async: true` 默认与上限 7200s。同步传 >600000 返回 `INVALID_ARGUMENT`（不静默截断）；`async: true` 省略 timeout 视为 7200000。
- `workspace` 取 realpath 后作为执行会话 key；换 workspace 新建执行会话，变量与 `state` 不继承。
- `visibleTools` 内置工具用裸名，MCP 工具用 `<server>.<tool>`；只收窄，不放大。

### `search_tools`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "category": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "max": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
  },
  "additionalProperties": false
}
```

结果项：`{ "name": "<server>.<tool>", "kind": "builtin"|"mcp", "server?": "...", "description?": "...", "tags?": [] }`。空 `query` 返回 server 概览。

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

返回 `{ "tools": [{ "name", "inputSchema" }], "omitted"?: [] }`。**不截断单个 schema**；整批超 32000 字符按顺序装，单个 schema 自己超限时只返回它一个。

### `wait_tasks`

```json
{
  "type": "object",
  "properties": {
    "taskIds": { "type": "array", "items": { "type": "string" } },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 600000, "default": 270000 }
  },
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

- 不传 `taskIds`：等本执行会话所有未收取任务；传了只等这些。
- 结果消费一次；重复取返回 `ALREADY_CONSUMED`。
- 未知 id：`{ "ok": false, "error": { "code": "UNKNOWN_TASK", "unknownIds": [] } }`，同时 `isError: true`。
- `status`：`completed` / `failed` / `cancelled`。

## 5. `instructions`

`instructions` 放完整提示词（02 §4.2 的模板），`run_script.description` 只放 ≤2KB 的摘要。两者不重复。

## 6. 任务方法

### `tasks/get`

返回完整 Task：`{ resultType: "complete", taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs, result?, error? }`。

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
<repl-output eval="12" async="true" task="t_01J..." reset="1" restored="lastGood" truncated="1">
<log>...</log>
<result>...</result>
</repl-output>
```

- `eval`：执行会话内的 `evalId`
- `async` / `task`：`async: true` 的派发回执
- `reset="1"`：worker 重建后的第一条结果
- `restored`：`state` 恢复成功
- `truncated="1"`：L5 截断
- 文本中的 `&`、`<`、`>` 转义
- 失败时出现 `<error>`；`<log>` 含 stdout 与 stderr

## 8. 错误码

| code | 场景 |
|---|---|
| `INVALID_ARGUMENT` | schema 校验失败、timeout 越界 |
| `WS_INVALID` | workspace 不存在或不是目录 |
| `WS_LIMIT` | 超过每 MCP 会话的 workspace 上限 |
| `CAPACITY_EXCEEDED` | 执行会话/绑定配额已满且无可淘汰 |
| `UNKNOWN_TASK` | `wait_tasks` 的 id 不存在 |
| `ALREADY_CONSUMED` | 同一任务结果被二次收取 |
| `TASK_EXPIRED` | 任务超过 TTL |
| `MCP_QUEUE_FULL` | 第三方池的 binding 队列已满 |
| `MCP_CALL_TIMEOUT` | 单次 MCP 调用超时 |
| `EXCLUSIVE_TIMEOUT` | `exclusive` 等待超过 30s |

工具层错误一律 `isError: true`，正文是 `<repl-output>`；JSON-RPC 层只用于协议错误（未知方法、参数不是对象）。

**错误通道映射**：

| 场景 | 通道 |
|---|---|
| 路径不存在、Host 不允许、JSON 解析失败 | HTTP 400/403/404 |
| 未知方法、参数不是对象、批量请求 | JSON-RPC `-32601` / `-32602` / `-32600` |
| `WS_INVALID`、`WS_LIMIT`、`CAPACITY_EXCEEDED`、`MCP_QUEUE_FULL`、`MCP_QUEUE_TIMEOUT`、`MCP_CALL_TIMEOUT`、工具执行失败 | `CallToolResult` + `isError: true`，正文 `<repl-output><error>` |
| `tasks/get` 未知/过期 | JSON-RPC `-32602`，`data: { code: "TASK_NOT_FOUND" \| "TASK_EXPIRED" }` |
| 上游（第三方 MCP）返回 `CreateTaskResult` | 第一版不支持，工具层 `UPSTREAM_TASK_UNSUPPORTED` |

**命名两层，同时存在**：协议/模型层的规范名是 `<server>.<tool>`（`search_tools`、`describe_tools`、`visibleTools`）；脚本内访问器是 `tools.mcp.<server>.<tool>`。两者不互相替代。

**任务归属**：`owner = bindingId ?? mcpSessionId`。绑定客户端按 binding 校验；未绑定客户端只能访问同一 `Mcp-Session-Id` 创建的任务，重连后旧任务不可见（返回 `TASK_NOT_FOUND`）。

**`DELETE /mcp`**：取消该会话所有在飞 eval（task 状态 `cancelled`），终止 worker/serve，删除执行会话的 task store，返回 204；之后 `tasks/get` / `tasks/cancel` 返回 `TASK_NOT_FOUND`。审计 `exec_end.reason = "delete"`。

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

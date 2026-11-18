# compliant-mcp fixture

RST-T01 的合规 MCP 探测器：HTTP Streamable（POST `/mcp`）、协议版本 `2026-07-28`、实现 tasks 扩展。它与 `../mcp-probe/` 分开维护——后者是踩坑 #5 的原始证据，不要改。

## 与原始探测器的区别

| 行为 | `mcp-probe`（证据） | `compliant-mcp`（本 fixture） |
|---|---|---|
| 返回 task 的依据 | 总是返回 task | 只看**本次请求**的 `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions` 是否声明 `io.modelcontextprotocol/tasks` |
| `--ignore-client-caps` | 无 | 加了就始终返回 task，**故意违规**，只用于复现坑 #5 |
| discover / initialize | 有 | 有，且 discover 形状按 2026-07-28 |
| `tasks/cancel` / `tasks/update` | 无 | 有，空确认带 `resultType: "complete"` |
| 端口 | 固定 8789 | `127.0.0.1:0`，实际端口写 stderr |

## 文件

| 文件 | 说明 |
|---|---|
| `server.mjs` | 单文件 HTTP server，只用 Node 内置模块，无依赖 |
| `smoke.mjs` | 启动 server、五步请求并断言、退出 |
| `README.md` | 本文件 |

## 运行

```bash
node server.mjs
# stderr: compliant-mcp listening on http://127.0.0.1:<port>/mcp
```

`smoke.mjs` 自己拉起 server、从 stderr 读端口，不需要先启动：

```bash
node smoke.mjs
# smoke: all 5 steps passed
```

五步依次是：`server/discover`、未声明 tasks 的 `tools/call`（同步）、声明 tasks 的 `tools/call`（`CreateTaskResult`）、`tasks/get`（完整 Task 字段）、`tasks/cancel`（空确认后状态为 `cancelled`）。

## curl 手工验证

在 fixture 目录里启动并抓端口（后台运行，stderr 落日志）：

```bash
cd plugins/repl-server/test/fixtures/compliant-mcp
node server.mjs 2>/tmp/compliant-mcp.log &
SRV=$!
sleep 0.3
PORT=$(sed -n 's|.*127\.0\.0\.1:\([0-9][0-9]*\)/mcp.*|\1|p' /tmp/compliant-mcp.log)
echo "PORT=$PORT"
```

### 1. discover

```bash
curl -sS -i -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
```

期望：HTTP 200、响应头带 `Mcp-Session-Id`；`result.supportedVersions` 为 `["2026-07-28"]`，`result.capabilities.extensions["io.modelcontextprotocol/tasks"]` 存在，`result.instructions` 非空，`result.ttlMs` 为 `3600000`。

### 2. 未声明 tasks 的 `tools/call`（同步）

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"slow","arguments":{"ms":200}}}'
```

期望：等待约 200ms 后返回 `result.resultType === "complete"`、`result.isError === false`、`result.content[0].text` 含 `slept 200 ms`，**没有 `taskId`**。

### 3. 声明 tasks 的 `tools/call`（`CreateTaskResult`）

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{"ms":5000},"_meta":{"io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}}}}}'
```

期望：立即返回 `result.resultType === "task"`、`status === "working"`、`taskId`、`createdAt`、`lastUpdatedAt`、`ttlMs`、`pollIntervalMs`。把 `taskId` 记下来：

```bash
TASK=t_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # 换成上一步返回值
```

### 4. `tasks/get`

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tasks/get\",\"params\":{\"taskId\":\"$TASK\"}}"
```

期望：`result.resultType === "complete"`，带完整 `taskId` / `status` / `createdAt` / `lastUpdatedAt` / `ttlMs` / `pollIntervalMs`。任务仍在跑时 `status === "working"` 且没有 `result`；到期后 `status === "completed"` 且 `result` 是 `CallToolResult` 形状。

### 5. `tasks/cancel`

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tasks/cancel\",\"params\":{\"taskId\":\"$TASK\"}}"
```

期望：`result` 恰为 `{"resultType":"complete"}`。再调一次第 4 步，`status` 应为 `cancelled`（对已结束任务 cancel 不报错，仍返回空确认）。

### 6. `tasks/update` 与 `ping`

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tasks/update\",\"params\":{\"taskId\":\"$TASK\",\"inputResponses\":{}}}"
# {"jsonrpc":"2.0","id":6,"result":{"resultType":"complete"}}

curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":7,"method":"ping"}'
# {"jsonrpc":"2.0","id":7,"result":{}}
```

`tasks/update` 不认识参数里的键，一律忽略；本 fixture 不会产生 `input_required`。

### 7. initialize（legacy）与通知

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":8,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# 顶层 protocolVersion + serverInfo，没有 supportedVersions

curl -sS -i -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
# HTTP/1.1 202 Accepted，无响应体
```

### 8. 复现坑 #5（只用于证据，不要用于契约测试）

```bash
# 先停掉上文的 server，或换一个终端
node server.mjs --ignore-client-caps 2>/tmp/compliant-mcp-ignore.log &
SRV2=$!
sleep 0.3
PORT=$(sed -n 's|.*127\.0\.0\.1:\([0-9][0-9]*\)/mcp.*|\1|p' /tmp/compliant-mcp-ignore.log)
# 重跑上面第 2 步：未声明 tasks 也会得到 CreateTaskResult
```

这违反 spec 的 "Never return a task to a client that did not declare support"，对应 learn-ai 04 的坑 #5（headless `-p` 收到 task 后报 `Unsupported result type 'task'`）。**RST-T01 的契约测试与 smoke 都不得带这个参数。**

### 停止

```bash
kill "$SRV"    # 如果起过 --ignore-client-caps 的实例，再 kill "$SRV2"
```

## 协议要点

- 只监听 `127.0.0.1`，端口由内核分配（`0`），启动行写 stderr；stdout 保持为空。
- 每个响应都带 `Mcp-Session-Id`；fixture 不校验它，客户端可带可不带。`DELETE /mcp` 返回 204 并取消所有 working task；`GET /mcp` 返回 405（不提供 SSE 通道）。
- 任务判定只读本次请求的 `_meta`，不看 `clientInfo`、不跨请求缓存，正是坑 #4 的结论。
- 未知方法 → JSON-RPC `-32601`；批量请求 → `-32600`；JSON 解析失败 → HTTP 400。
- `tasks/get` 未知 id → `-32602` 且 `data.code = "TASK_NOT_FOUND"`；超过 TTL → `data.code = "TASK_EXPIRED"`。
- 任务 TTL 600000ms、`pollIntervalMs` 100ms、工具参数 `ms` 上限 600000ms。

---
name: zl-repl-server
description: 通过 repl-server MCP 在持久 JavaScript 沙箱里批处理工具调用并沉淀脚本库（Code Mode）。当任务要用 run_script 执行脚本、search_tools / describe_tools 发现工具、wait_tasks 收取长任务、save_script / search_scripts 保存或复用脚本，或用户提到 repl-server、脚本库、MCP 工具批处理、runId、scriptName 时使用。不用于普通的单次工具调用，也不用于一般代码问题的直接回答。
argument-hint: "[要批量完成的任务，或要保存/复用的脚本]"
---

# repl-server

repl-server 是一个 MCP server：模型在持久 JavaScript 沙箱里调用本客户端可见的内置工具和第三方 MCP 工具，只有脚本的返回值和日志进入上下文。它适合一次做多步、跨工具取数再聚合，或把重复流程存成脚本。单次工具调用直接调原工具，一般代码问题直接回答，不必绕这一层。

## 工具面

顶层 6 或 7 个工具，顺序固定；声明 MCP tasks 的客户端没有 `wait_tasks`。它们都不在脚本的 `tools` 对象里，脚本内不可调用。

| 工具 | 用途 | 性质 |
|---|---|---|
| `run_script` | 执行代码或已保存脚本 | 有副作用，非只读 |
| `search_tools` | 按名字/描述/标签找工具，返回规范名 | 只读 |
| `describe_tools` | 取 1–10 个工具的输入 schema | 只读 |
| `wait_tasks` | 阻塞收取 `async: true` 的任务结果，到期返回 `pending`；仅不支持 MCP tasks 的客户端可见 | 消费结果，非幂等 |
| `report_problem` | 上报 repl-server 或其暴露工具的问题 | 写一条记录 |
| `save_script` | 从成功执行保存脚本，或更新脚本 | 写脚本库 |
| `search_scripts` | 查脚本库里 active 的脚本 | 只读 |

## 脚本外：先发现，再调用

1. `search_tools({ query })` 找候选，取返回的 `name`（规范名）。空 `query` 不给 `server` 时返回 server 概览和 `__official__` 组；空 `query` 给 `server` 时返回该 server 的工具；非空 `query` 匹配工具名、生效 tags 和 description。
2. `describe_tools({ names })` 拿 schema，一次 1–10 个。名字未知或不可见不会使整次调用失败：已知工具照常返回，未知名单在 `unknown`，按需重新 `search_tools`。
3. `server` / `category` / `tags` 只做题面收窄，`tags` 是 all-of；过滤值只能取 schema enum 里实际列出的值。

不要猜工具名。名字对不上就回到 `search_tools`。

## 脚本内：调用与结果

```js
const [a, b] = await Promise.all([
  tools.Read({ file_path: '/tmp/a.txt' }),                 // 内置工具：裸名
  tools.mcp.github.search_repositories({ query: 'mcp' }),  // MCP：tools.mcp.<server>.<tool>
]);
if (a.error) throw new Error(a.error);
const data = JSON.parse(b.text);
return { count: data.total_count };
```

- 每次调用 `code` 与 `scriptName` 恰好给一个。`args` / `scriptVersion` / `activateOnSuccess` 只在脚本模式（给 `scriptName`）合法。
- 所有工具都是 async，可以顶层 `await`；独立调用用 `Promise.all` 并行，有依赖再串行。
- 内置工具的 JSON 自动解析；MCP 工具返回 `{ text, images?, documents? }`，`text` 是原始文本，通常是 JSON，需要 `JSON.parse(result.text)`，解析前先判断它是不是字符串和 JSON。
- 失败语义不同：内置工具失败**返回** `{ error }`，要显式检查；MCP 工具失败会 **throw**，用 try/catch 包住。`exitCode` 这类字段也要显式看，不能只看有没有异常。
- 返回值就是模型看到的内容。只返回答案需要的字段；大列表先在脚本里过滤、计数、截断，不要整段 dump。
- 声明（变量、函数）在同一 workspace 跨调用保留；换 `workspace` 是新会话，不继承。`visibleTools` / `excludeTags` 只收窄本次可见范围，不能放大权限。

## 长任务

先看工具列表里有没有 `wait_tasks`，它决定用哪种方式收结果。两条路径的 `taskId` 是同一个 `t_...`，差别只在谁去取结果。

### 有 `wait_tasks`：用 `async: true` + `wait_tasks`

`run_script({ async: true })` 立即返回 `resultType: "complete"`：顶层带 `taskId`、`status`、`createdAt`、`lastUpdatedAt`、`ttlMs`、`pollIntervalMs`，`content[0].text` 是带 `async="true" task="<taskId>"` 的 `<repl-output>`。`wait_tasks` 会等到任务结束或 `timeoutMs` 到期，适合必须拿到结果才能继续的串行流程。

```js
run_script({ code, async: true })
// 立即返回，顶层 taskId = "t_..."
wait_tasks({ taskIds: ['t_...'], timeoutMs: 270000 })
```

- `taskIds` 必填，元素就是回执里的 `t_...`；只等这些任务，不会顺带收取别人的任务。`timeoutMs` 范围 1000–600000，默认 270000。
- 返回 `{ ok, timedOut, events, pending }`；事件里的 `taskId` 是传进去的对应 `t_...`，带 `runId`，脚本执行还带脚本版本和 `argsPreview`。`timedOut: true` 表示任务仍在跑，用同一个 `taskIds` 再等一次。
- 结果只消费一次：重复收取返回 `ALREADY_CONSUMED`；需要新结果就重新 `run_script`。
- 任一个 `taskIds` 未知、过期或属于其他客户端，整次调用返回 `isError: true`，`error.code = "TASK_NOT_FOUND"`。

### 没有 `wait_tasks`：客户端支持 MCP tasks，用标准 `tasks/get`

服务端返回标准 `CreateTaskResult`（`{ resultType: "task", taskId: "t_...", ... }`），客户端自己按 `pollIntervalMs` 用 `tasks/get` 轮询，终态把 `completed.result` 交给你；你不需要、也不能调 `wait_tasks`。这是 MCP 协议层的任务扩展，不是 `async: true` 的别名。

- 服务端在 `server/discover` 的 `capabilities.extensions` 里声明 `io.modelcontextprotocol/tasks`。
- 客户端在 `tools/call` 的 `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions` 里放同名 key，表示本次请求支持 tasks。
- 触发条件只针对 `run_script`：`async: true`，或 `async` 未传/为 false 且 `timeout > 30000`（严格大于；省略 timeout 按 30000 判定，不会触发）。
- 不阻塞，直接返回 `{ resultType: "task", taskId: "t_...", status: "working", ttlMs, pollIntervalMs, ... }`。
- 用 `tasks/get({ taskId })` 按 `pollIntervalMs` 轮询；它是幂等读取。终态看 `completed` / `failed` / `cancelled`，`completed.result` 是普通 `CallToolResult`。
- `tasks/cancel({ taskId })` 做协作式中止；已结束的任务返回当前终态。`tasks/update` 不产生 `input_required`，空确认即可，一般不用调用。
- 同一个 `t_...` 也能交给 `wait_tasks`（如果工具面里有它），但每端只用一条路径取结果，不要两边交替。
- task 映射保留 2.5 小时，`pollIntervalMs` 默认 500ms；任务按 owner（`bindingId ?? mcpSessionId`）隔离，绑定客户端可跨传输会话和 workspace 取回，未绑定客户端随 MCP 会话。

## 脚本库

模型侧只用 `scriptName`。`scriptId` 是系统内部编号，旧客户端才传，不要写进你的调用。

- `search_scripts({ query?, tags?, limit? })` 只返回 active 脚本，带 `scriptName`、`activeVersion`、`inputSchema`、`exampleArgs`。执行用 `run_script({ scriptName, args })`；不传 `scriptVersion` 时使用当前 active 版本。
- 保存 exact：先成功执行一段 `code`，结果 XML 的 `run` 属性就是 `runId`；再调 `save_script({ runId, mode: 'exact', name, description, tags? })`，生成 active 的零参数脚本。exact 不接受 `code`、非空 `inputSchema` 或 `exampleArgs`，代码取自来源执行；来源 run 必须成功且未过期（归档保留 90 天）。
- 保存 parameterized：`save_script({ mode: 'parameterized', name, description, code, inputSchema, exampleArgs?, changelog? })` 生成 **draft**。用 `run_script({ scriptName, scriptVersion, args, activateOnSuccess: true })` 测试，成功时该 draft 自动转 active，失败保持 draft。`activateOnSuccess` 只对 draft 有效，对非 draft 版本传会报 `SCRIPT_VERSION_NOT_DRAFT`。
- 更新已有脚本：传 `scriptName` 定位。只改 `name` / `description` / `tags` 是原地更新，不产生版本，也不需要 `baseVersion`；改 `code` / `inputSchema`（或传 `runId`）必须带 `baseVersion`（与当前版本号一致），会追加一个 draft，需要重新测试激活。每个脚本的 `mode` 创建后固定，改 mode 报 `SCRIPT_MODE_CONFLICT`，只能新建脚本。

## 安全

- `run_script` 有副作用：脚本会写文件、跑命令、调外部工具，不是只读操作。失败重试前先确认上一次没有已经产生写入，避免重复下单、重复提交。
- 不要因为工具报错就整段重跑有写操作的脚本；把有副作用的步骤拆出来单独重试。
- 密钥、令牌不写进 `code`、`log()`、返回值，也不放进 `report_problem`。保存脚本时的密钥扫描只告警，不会拦截，所以不能依赖它兜底。
- `report_problem` 只报 repl-server 或其暴露工具的问题，`title` / `detail` / `severity`（low / medium / high / critical）都必填；同一 owner 每小时最多 20 条。

## 标准流程

### 1. 发现工具（脚本外）

1. `search_tools({ query: '关键词' })` 得到候选规范名。
2. `describe_tools({ names: [...] })` 确认参数、必填项和类型。
3. 检查点：名字和 schema 都来自返回，不凭记忆补字段。

### 2. 一次性批处理

1. 按上一步确认的 schema 写 `code`。
2. `run_script({ code })`：独立调用 `Promise.all`，有依赖串行。
3. 检查点：看返回的 `<repl-output>` 和 `isError`；内置工具失败检查 `{ error }`，MCP 失败 catch throw。只返回聚合后的结果。

### 3. 保存并复用 exact

1. `run_script({ code })` 成功，记下返回的 `run`（即 `runId`）。
2. `save_script({ runId, mode: 'exact', name, description, tags? })`。
3. 检查点：返回 `status: 'active'`、`version: 1`；之后用 `run_script({ scriptName })` 复用，零参数。

### 4. 参数化脚本测试与激活

1. 把一次性代码改成读取 `args` 的版本，定义 `inputSchema` 和 `exampleArgs`。
2. `save_script({ mode: 'parameterized', name, description, code, inputSchema, exampleArgs })`，返回 draft 版本号。
3. `run_script({ scriptName, scriptVersion: <draft 版本>, args: exampleArgs, activateOnSuccess: true })`。
4. 检查点：执行成功才激活；再用 `search_scripts` 确认该脚本的 `activeVersion` 已变成刚测试的版本。

## 失败处理

顶层工具失败看 `isError` 和 `error.code`；`run_script` 的失败正文在 `<repl-output>` 的 `<error>` 里。

| 现象 | 处理 |
|---|---|
| `unknown` 非空 | `describe_tools` 的部分成功（`isError: false`）；看 `unknown`，回到 `search_tools` 重新找规范名 |
| `SCRIPT_NOT_FOUND` | 名称不存在，用 `search_scripts` 查实际存在的脚本名 |
| MCP 结果解析失败 | 先看 `result.text` 的真实内容，可能是非 JSON 文本或空串，再决定是否 `JSON.parse` |
| 结果太大 / 上下文被撑爆 | 在脚本里聚合、过滤、只返回必要字段，而不是把原始结果整段返回 |
| `SCRIPT_VERSION_CONFLICT` | `baseVersion` 过期，用 `search_scripts` 取当前 `activeVersion` 后重试 |
| `SCRIPT_NAME_CONFLICT` | 名称已被占用，换一个名字，或改用 `scriptName` 更新已有脚本 |
| `ALREADY_CONSUMED` | 该任务结果已被收取，不要重复 `wait_tasks`；需要新结果就重跑 |

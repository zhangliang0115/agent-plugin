# 在 DSH 里实现 Code Mode

先读 [official-docs.md](official-docs.md) 和 [claude-code-source.md](claude-code-source.md)。这篇只讲 DSH 的落地。

## DSH 的相关事实

来源：本仓库 `docs/hosts/dsh.md`（0.1.0-rc.7 至 0.2.1-rc.2 的公开文档）。DSH 是开发者预览，字段名会变，动手前先对照当前版本的文档。

- 插件是 Cordis 模块：`export const inject = ['tools']`，`export function apply(ctx)`。
- 注册工具：`ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`。
- 工具流水线是 waterfall，必须 `await next()`：
  - `tools/pre-execute`：allow / deny / 请求审批
  - `tools/execute`：包裹执行
  - `tools/post-execute`：替换或阻止结果
  - `tools/result`：只读通知
- 会话事件：`tool/call`、`tool/result`。
- 工具呈现模式（0.1.1-rc.2 文档）：`native` / `code`（只暴露 `run_code`）/ `both`；单个 agent 可用 `presentAs` 覆盖。**动手前确认当前版本还有这个字段。**
- DSH 有内置 **PTC 模式**：模型写 TS 程序批量调用工具，和 Code Mode 思路重叠。先确认它是否已经覆盖需求，避免重复造。
- 打包：`package.json` 写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`files` 包含 `cordis.patch.yml`。
- 本地验证：
  ```bash
  dsh web --patch /abs/path/cordis.yml
  dsh plugin --profile demo add ./<pkg>
  dsh --profile demo --dump-config
  ```

## 设计

### 1. `run_code` 工具

```ts
ctx.tools.register(defineTool({
  name: 'run_code',
  description: 'Execute JavaScript that calls DSH tools. Batch all operations into one call.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute({ code }, context) {
    // 1. 按 session 取/建 VM
    // 2. 注入工具绑定
    // 3. 跑代码
    // 4. 返回 <repl-output>
  },
}))
```

### 2. 每会话一个持久 VM

- key 用 session id（从 `execute` 的 context 或 `ctx` 里取；先确认 DSH 给的是什么）。
- 变量跨 `run_code` 调用保留；会话结束时 dispose。
- 只允许一个脚本同时跑；内部用 `Promise.all` 并发。
- 不要用 Node 的 `vm` 当安全边界。DSH 有 sandbox 就用；没有就用独立进程（Deno / QuickJS / Bun 子进程）。

### 3. 工具绑定

把 DSH 的工具映射成 async 函数：

```js
const bindings = {
  Read:  (args) => callTool(ctx, 'Read', args),
  Edit:  (args) => callTool(ctx, 'Edit', args),
  Bash:  (args) => callTool(ctx, 'Bash', args),
  // MCP: mcp__server__tool 按全名
}
```

`callTool` 必须走完整流水线：

```text
tools/pre-execute -> guard -> tools/execute -> tools/post-execute
```

这样内部调用才会经过 allow/deny/ask 和沙箱，不绕过权限。

### 4. 代码里的 API

- 内建工具和 MCP 工具都是 async 函数。
- 内建工具失败返回 `{ error }`；MCP 工具失败 throw（和 Claude Code 一致）。
- `$` shell 标签：`.text()`、`.nothrow()`；如果 DSH 没有 shell 工具，这个可以不做。
- `self.log(...)` 写 `<log>`。
- `console.*` 进有界 ring；`console.tail(n)` 读回。
- `preview(value, n = 2000)` 截断长输出。

### 5. 输出

```xml
<repl-output eval="N">
  <log>...</log>
  <result>...</result>
</repl-output>
```

失败时用 `<error>`。长输出截断并标注。

### 6. 提示词

工具描述和/或系统提示必须包含：

```text
Batch ALL operations into ONE run_code call.
Tools are async functions. MCP tools use their full name.
The last expression is the result. Keep intermediate values in variables.
No import/require/process. Use Read/Write/Glob for files, $ for shell.
```

### 7. 工具面收敛

如果当前 DSH 支持 `presentAs: 'code'`，把 agent 设成它，模型就只看到 `run_code`。不支持的话，至少不要让模型同时看到两套工具面，否则它会继续逐个调工具。

## 实现步骤

1. **确认版本和 PTC**：读当前 DSH 文档，确认 `ctx.tools`、`tools/pre-execute`、`presentAs`、PTC 是否和 `docs/hosts/dsh.md` 一致。不一致先记 `friction.md`。
2. **写 `run_code` ToolDefinition**：先不接 VM，返回固定的 `<repl-output>`，确认 DSH 能注册、模型能看到。
3. **加 VM 和 prelude**：持久上下文、`self.log`、`console.tail`、`preview`。
4. **加工具绑定**：先绑一个只读工具（如 `Read`），验证内部调用走 `tools/pre-execute`。
5. **加权限断言**：用 fake tool 断言 `pre-execute` 被调用，参数正确。
6. **加提示词和 `presentAs`**：让模型一次写完整脚本。
7. **真实 DSH 冒烟**：在测试 profile 里跑一个多文件任务，贴 `--dump-config` 和调用输出。

## 待确认

- `ctx.tools` 有没有 `call`/`dispatch`？没有的话，怎么从插件里调用另一个工具并走完整 waterfall？
- `execute` 的 context 里有没有 session id？没有的话从哪里取？
- DSH 有没有可用的 sandbox？没有的话选哪个隔离方案？
- 系统提示怎么注入？`ctx.skills`？消息？还是只靠工具描述？
- 当前版本的 `presentAs` 字段名是否还是这个？
- PTC 是否已经覆盖了大部分场景？如果是，Code Mode 的差异化价值在哪里？

## 验收

- [ ] `run_code` 能执行一段调用至少两个 DSH 工具的代码。
- [ ] 变量跨调用保留；会话结束后清空。
- [ ] 内部每次调用都走 `tools/pre-execute`（fake tool 断言）。
- [ ] `self.log`、`console.tail`、`preview` 行为正确。
- [ ] 内建工具失败返回 `{error}`；MCP 失败 throw。
- [ ] 没有 `import`/`require`/`process`；尝试使用时明确报错。
- [ ] 长输出截断并标注。
- [ ] 真实 DSH 会话冒烟通过。

## 和 Claude Code 的差异

| 项 | Claude Code | DSH |
|---|---|---|
| 工具绑定 | 只能绑内建 + MCP（官方内建） | 可以绑所有 `ctx.tools` |
| 工具面收敛 | 官方内建 | `presentAs: 'code'`（待确认） |
| 账号/模型门控 | 有 | 无 |
| 终端限制 | 只能在终端交互式 | 按 DSH 自己的运行面 |
| 已有类似能力 | 无 | PTC 模式（需确认是否重叠） |
| 稳定性 | 稳定 | 开发者预览，API 会变 |

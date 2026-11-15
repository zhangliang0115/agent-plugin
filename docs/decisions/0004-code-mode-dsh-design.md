# 0004 DSH 的 Code Mode：run_code、sealed QuickJS 沙箱、子调用走流水线
- 状态：已接受
- 日期：2026-11-15
- 取代：无
- 关联：[issue #5](https://github.com/zhangliang0115/agent-plugin/issues/5)
## 背景
要在 DSH 中提供 `run_code({ code })`：模型写 JavaScript 调用 DSH 工具，只把结果和日志返回给模型，每次工具调用都经过 `tools/pre-execute` → guard → `tools/execute` → `tools/post-execute`。约束来自 `docs/hosts/dsh.md` 与 `friction.md`：
- DSH 已有内置 PTC（`tool-executor-ptc`），语言是 TypeScript，子进程执行，完成值被丢弃。它的 `run_code` 与本需求同名，两者不能同时挂在同一 scope。
- `run_code` 是保留名，普通 `register()` 拒绝；同一 scope 只能有一个 executor。
- `node:vm` 不是安全边界。
- 参考资料（`docs/features/code-mode/`）与调研（`.agents/tasks/code-mode-dsh/plan.md`）中的部分行为与 DSH 不匹配，逐条见 `plugins/code-mode/README.md` 的「与参考资料和原生执行器的差异」。
实施时做了 spike（`quickjs-emscripten@0.32.0`，在仓库外）。原计划用 asyncify（`newAsyncifiedFunction`）桥接异步工具，结果：调用异步宿主函数时 `evalCode` 报 `Function unexpectedly returned a Promise`，改用 `evalCodeAsync` 后，asyncify 的同一时间只能挂起一次宿主调用（库文档写明 asyncified 函数不能再调用其他 asyncified 函数），无法满足 `Promise.all` 并行。因此改设计。
## 决策
1. **对模型只暴露 `run_code`。** 执行器是 deployment 级 `ToolExecutor`，用 `ctx.tools.setExecutor` 注册。`describe` 只返回 `run_code` 的 schema，参数只有 `code`。插件的 `cordis.patch.yml` 禁用 `tool-executor-native`；`tool-executor-ptc` 在基础 profile 中已禁用。
2. **沙箱用同步 QuickJS WASM，并以 guest promise 桥接工具调用。** 宿主只暴露两个同步函数：`invoke(id, name, args)` 启动工具调用并立即返回，`done(runId, ok, text, hasResult)` 报告运行结果。工具调用在 guest 中返回 promise，宿主的事件循环调用 `settle(id, ok, payload)` 结算。这样不需要 asyncify，`Promise.all` 能并行。
3. **每个 owner 一个 WASM 模块实例。** owner 是 agent 对象；没有 agent 时（例如服务调用）每次调用用临时 owner，用完即释放。独立模块让 QuickJS 的 abort 只影响该 owner（见 `friction.md`：OOM 后 `JS_FreeRuntime` 断言）。
4. **源码改写。** 用 acorn 解析。顶层 `const`/`let`/`var`/`function`/`class` 与解构改写为 `globalThis` 属性，所以跨调用可见。最后一个顶层表达式语句改写为 `return`，它的值成为 `<result>`。顶层 `await` 有效，因为程序体放在 async 函数内。`import` 语句在解析阶段拒绝。
5. **子调用走 DSH 流水线。** 用 `@deepseek-ai/dsh-tools/pipeline` 的 `ToolExecutionPipeline`。每个子调用依次执行 `prepare` → `dispatch`（若需要）→ `complete`，`parent` 设为外层 run_code 的 token，`rootCallId` 设为外层 callId。准入由每次运行自己的调度器决定（见第 12 条），不再有进程级的串行队列。失败（包括 pre-execute 拒绝、guard 拒绝、工具错误）在程序中抛出异常。
6. **持久化按 agent。** 同一 agent 的顶层绑定跨 run_code 调用保留。agent 销毁时，经 `agent.ctx.effect` 注册的释放函数清空其上下文。DSH 的 `ToolBatchInput` 没有 session id，所以不能按会话隔离。
7. **串行与限额。** 同一 owner 的 run 排队执行（FIFO）。一次 run 内的子调用数上限 256，并行上限 10（只约束 `parallel` 的工具）。超出子调用上限时，调用在程序内报错，不发给工具。
8. **超时与中止。** 默认 120 秒，上限 600 秒。等待用户的时间不计入（第 13 条）。interrupt handler 检查截止时间与调用方的 abort；宿主事件循环另外用计时器触发。结束时对未完成的子调用发 abort，最多等待 2 秒让它们结算。
9. **输出格式。** `<repl-output eval="N">`，内部可以有 `<log>`、`<result>`、`<error>`。文本中的 `&`、`<`、`>` 转义。上限：`<result>` 与 `<log>` 各 10000 字符，`<error>` 2000 字符，超出时在末尾标注删去的字符数；`<result>` 超出时完整文本先存入宿主 spill 存储，标注里附路径（第 16 条）。`N` 按 owner 的 context 递增，失败的运行也计数。
10. **构建用 esbuild。** `plugins/code-mode/dsh/scripts/build.mjs` 把 core 与 adapter 打成单文件 ESM。`@deepseek-ai/*`、`cordis`、`quickjs-emscripten`、`acorn` 保持外部，由宿主或 profile 提供。`conventions.md` 要求第一个要发布的包在这里决定构建工具。
11. **包结构。** `plugins/code-mode/core` 不 import 宿主 SDK（`no-host-deps.test.ts` 检查）。`plugins/code-mode/dsh` 是薄 adapter：注册、执行器、子调用映射。依赖 DSH 的 peer 包版本精确锁定为 `0.2.2-rc.3`（`cordis` 为 `4.1.0`）。
12. **子调用准入按运行调度，不用进程级的锁。** 原先 executor 持有一把进程级的串行锁，`prepare`（含审批等待）占着它，一个会话的审批会挡住所有 agent。现在每次运行有一个 FIFO 调度器：`parallel` 的调用在没有 `exclusive` 调用运行时直接开始，`exclusive` 的调用（由 `pipeline.executionMode` 判定）等前面的调用都结束后单独运行，等待用户的调用不占位。调度器不跨运行、不跨 agent 共享。
13. **等待用户的时间不计入运行超时。** 核心的 `ToolInvoker` 多收一个 `CallControl`，`holdDeadline()` 暂停截止时间，返回释放函数。适配器在 `pipeline.prepare` 整段（含审批请求）和 `userWaitTools`（默认 `ask_user_question`、`exit_plan_mode`）的 `dispatch` 期间暂停。这两处只覆盖流水线发出的请求；工具本体在执行中发出的审批（bash、pwsh、write、edit 的沙箱提权）和提问（computer-use 工具）不经过它们。因此适配器还在宿主的 `approval/request` 与 `user-questions/request` 上挂前置（`prepend`）监听，请求挂起期间暂停所属运行的计时，请求结算、取消或信号中止时释放。前置是必须的：应答端返回结果而不调用 `next()`，后挂的监听不会运行。审批请求带子调用 id，按 id 找到所属运行；用户提问不带，按 agent 暂停该 agent 所有进行中的运行。选事件而不是按工具名，是因为名单要逐个枚举会提权的工具，并且无法区分「等用户」和「工具卡住」。中止信号不受暂停影响。暂停期间的同步 guest 代码、没有在等用户的卡住工具仍按剩余预算超时。与 DSH 自带 `run_code`（超时含嵌套工具与审批等待）有意不同。
14. **子调用写 PTC 的会话事件。** 每个子调用写 `tool/ptc-dispatch-start` 与 `tool/ptc-dispatch`（调用 id 为 `<callId>:ptc:<n>`），字段与 `dsh-tool-executor-ptc` 一致，使 trajectory、user-questions 投影、auto-review、todo 历史识别子调用。事件类型来自 PTC 而不是原生的 `tool/call`，选这个是因为这些功能只认 PTC 的事件。写入失败只记警告。
15. **错误身份和回合结束标记传回。** 核心导出 `ToolCallError(message, { code, name })`，程序中捕获的错误多出 `code` 与 `errorName`，`name` 与 `message` 不变。子调用的 `concludesTurn` 为真时适配器调用 `exec.concludeTurn()`。
16. **大结果走宿主 spill 存储。** 核心的 `RunRequest.onResultOverflow(text)` 在 `<result>` 超过上限时被调用；适配器通过 `ctx.get('spillStore').saveText` 保存并返回路径说明，写进截断标注。没有存储或保存失败时退回普通标注。
## 后果
好的：
- 沙箱是 sealed 的。程序只能通过注入的 `tools`、`self`、`console`、`preview` 与 DSH 交互，没有 Node 全局。
- 子调用与模型直接发出的调用走同一条流水线，权限、guard、审计行为一致。真实 DSH 0.2.2-rc.3 上验证过两个并行子调用（见 `.agents/tasks/code-mode-dsh/wf/verification.md`）。
- 等待审批不再受 120 秒限制，也不再挡住其他 agent；独占工具、大结果、错误码、回合结束与原生一致（真实 DSH 验证见 `.agents/tasks/code-mode-dsh/wf/fix/verify-log.md`）。
代价与风险：
- 每个 owner 创建约 65 毫秒（测得：5 个 owner 共 327 毫秒）。OOM 后的运行时无法释放，每次 OOM 会泄露一个模块的线性内存，并在 stderr 打印 `Aborted(...)`。
- 新增 esbuild 作为构建依赖。
- 子调用不出现在 DSH 的 `--json` 事件流中；会话事件按第 14 条写入，只监听 `tool/call` 的观察者看不到子调用。
- `userWaitTools` 是名单，只作第二道；主要靠宿主事件监听。宿主新增的向用户提问的通道如果不走 `approval/request` 或 `user-questions/request`，要再加监听。
- 前置监听依赖 Cordis 的 `prepend` 选项和这两个事件的 waterfall 语义（DSH pre-stable）。升级 DSH 时跑 `tool-internal-wait.test.ts`，并在无头里用延迟应答的观察插件复测。
- 事件字段通过本地的结构类型写入，`dsh-session` 的类型没有导出 PTC 事件，升级 DSH 时要核对。
- 依赖 DSH pre-stable 的 `/pipeline` 导出。升级 DSH 时要跑 `invoker.test.ts` 与 `executor.test.ts`。
- 执行器挂在 deployment scope，因此与 native、PTC 不能共存。挂在 agent scope 要改每个 agent 的配置，留作后续。
后续：
- 发布包名与 scope（[issue #4](https://github.com/zhangliang0115/agent-plugin/issues/4)）。
- 桌面 App 上确认审批面板、提问续答和 trajectory 的实际表现。
- 是否支持按 agent 挂载。
## 备选方案
- **复用 PTC 的内部实现**：`PtcExecutor` 等没有从包入口导出，且语言为 TypeScript、完成值被丢弃。不采用。
- **`node:vm`**：Node 文档明确不作为安全边界。不采用。
- **`isolated-vm`（V8 isolate）**：原生模块，需要为每个平台提供预编译产物，未在本仓库评估。不采用。
- **DSH 自带的 PTC runtime（子进程，`ctx.ptcRuntime`）**：不是 sealed，只支持 TypeScript。不采用。
- **QuickJS asyncify**：不能并行调用异步宿主函数，且 asyncified 函数不能嵌套。不采用，见「背景」。

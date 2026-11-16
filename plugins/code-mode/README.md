# Code Mode

让模型写一段 JavaScript 调用工具，插件执行后只把结果和日志返回给模型。中间的工具输出留在程序里，不进入模型上下文。

- 支持的宿主：[DSH](../../docs/hosts/dsh.md)（`dsh`，实验性，0.3.0）。Claude Code 与 Pi 未支持，见 `plugin.meta.json`。
- 安装：见 [INSTALL.md](INSTALL.md)。
- 变更记录：[CHANGELOG.md](CHANGELOG.md)。
- 设计决策：[ADR 0004](../../docs/decisions/0004-code-mode-dsh-design.md)。
- 网络：插件本身不发起网络请求。程序里调用的工具各自访问它们需要的地址。

## 工具面

模型只看到一个工具：

```text
run_code({ code: string })
```

`code` 是一段 JavaScript。它可以用顶层 `await`，可以调用 DSH 的工具。每个工具都是 async 函数，参数是一个对象：

```js
const a = await read({ file_path: "a.txt" });
const b = await read({ file_path: "b.txt" });
a.totalLines + b.totalLines
```

工具也能通过 `tools["名字"](参数)` 调用，适用于名字不是合法标识符（或与保留字重名）的工具。

## 程序能用的全局

| 名字 | 作用 |
|---|---|
| 工具函数 | 每个当前可见的工具一个 async 函数，名字是合法标识符且不与保留名冲突 |
| `tools` | 所有可见工具的对象，`tools["名字"]` |
| `self.log(...)` | 把参数写入 `<log>`，多个参数用空格连接 |
| `console.log/info/warn/error/debug` | 写入一个 200 条的环形缓冲，不进入 `<log>` |
| `console.tail(n)` | 返回最后 n 条控制台记录，格式为 `"级别: 文本"` 的字符串数组 |
| `preview(value, n = 2000)` | 把值格式化为文本，超过 n 个字符时截断并标注剩余字符数 |

`require`、`process` 调用时抛出 `... is not available in Code Mode; use the listed tools`。`import` 语句在解析阶段被拒绝，动态的 `import()` 由 QuickJS 报错。

## 返回格式

每次运行返回一个 `<repl-output>` 信封，`eval` 在同一 agent 内逐次递增：

```xml
<repl-output eval="2"><log>3 5</log><result>8</result></repl-output>
```

- `<result>`：程序最后一个顶层表达式的值。最后一条语句不是表达式时没有这个元素。
- `<log>`：本次运行中 `self.log` 的输出。
- `<error>`：语法错误、运行时异常、超时、中止。出错前写入的 `<log>` 仍然保留。

信封中的 `&`、`<`、`>` 会转义。超过上限的内容被截断，末尾附 `[truncated: N more characters]`。
`<result>` 超过 10000 字符时，完整文本先存入宿主的 spill 存储（与原生工具大输出走同一条路），截断标注变为 `[truncated: N more characters. Full result stored at: <路径>. <读取提示>]`。模型可以用 `read` 或 grep 读取该路径。没有 spill 存储、没有 agent 或保存失败时，退回普通标注并在日志里写警告。`<log>` 与 `<error>` 不做 spill。

## 持久化与隔离

- 顶层的 `const`、`let`、`var`、`function`、`class` 跨 `run_code` 调用保留。同一 agent 的多次调用共享这些变量。写在顶层块里的 `var`（如 `for`、`if`、`try` 内）也保留，与普通 JavaScript 的函数作用域一致；函数体内的声明只在函数内有效。
- 不同 agent 的上下文互相隔离。agent 销毁时上下文被释放，之后同名变量不存在。
- 同一 agent 的运行一次只执行一个，按到达顺序排队。排队只限同一 agent：等待审批或用户回答的运行不挡别的 agent，不同 agent 的运行可以同时等待、同时调用工具。但沙箱是同步 QuickJS，一段没有 `await` 的程序（例如死循环）会独占宿主线程，直到这次运行的截止时间；期间其它 agent 与界面都会停住，各自的截止时间仍按自己的算。

## 工具调用与权限

程序中的每次工具调用都经过 DSH 的流水线：`tools/pre-execute`（包括权限与审批）→ guard → `tools/execute` → `tools/post-execute`。调用的 `parent` 指向外层 `run_code` 的调用。

- 工具失败、pre-execute 拒绝、guard 拒绝都在程序中抛出异常，可以用 `try/catch` 处理。工具本体不会被执行。
- 子调用的并发规则与原生一致：宿主把工具标为 `exclusive`（如写文件、bash）时，同一次运行内的它们按提交顺序一个接一个执行，并且要等前面已提交的调用完成；标为 `parallel` 的调用可以同时执行，数量上限见「限制」。排队只发生在一次运行之内，不跨运行、不跨 agent。
- 等待用户回答的时间不计入运行超时，回答前不会因 120 秒到期被取消，无论宿主从哪条路径发出请求：流水线的 `ask` 决定、工具自己在执行中申请的审批（bash、pwsh、write、edit 的 `sandbox_permissions` 提权）、`ask_user_question` 与其他向用户提问的工具。插件监听宿主的 `approval/request` 与 `user-questions/request`，请求挂起期间暂停计时，回答、取消或中止后恢复。用户停止、中止信号仍然立即生效。程序自己的同步死循环、没有在等用户却卡住的工具不受这个暂停影响，仍按剩余预算超时。
- 子调用失败时，程序里捕获的错误是普通 `Error`：`message` 是宿主给的原因，`name` 恒为 `"Error"`。宿主错误的类名放在 `errorName`（如 `ToolTimeoutError`），错误码放在 `code`（如 `TOOL_TIMEOUT`、`APPROVAL_UNAVAILABLE`、`ABORTED_BEFORE_DISPATCH`、`UNKNOWN_TOOL`）。这两个字段来自 DSH 流水线的错误信息；工具本体抛出的普通 `Error` 没有这两个字段。
- 子调用返回图片时（截图、看图工具），图片作为一条 user 消息交给模型；程序里只拿到序列化后的 JSON 值。与 DSH 自带 PTC 执行器相同。
- 超时或中止后，未完成的子调用不再执行 `tools/post-execute`，也不再写 `tool/ptc-dispatch` 事件：运行已经给模型返回了结果，晚到的事件不再改变它。子调用的 `tools/post-execute` 按提交顺序执行，即使后面的调用先跑完。
- 子调用把 `concludesTurn` 带回时（例如驳回 `exit_plan_mode`），外层 `run_code` 调用会结束当前回合，与原生相同。
- 每个子调用写两条会话事件：开始时 `tool/ptc-dispatch-start`，结束时 `tool/ptc-dispatch`，字段与 DSH 的 PTC 执行器一致（调用 id 形如 `<外层 callId>:ptc:<n>`）。依赖 PTC 事件的功能（trajectory 树、user-questions 投影、auto-review、todo 历史）能识别子调用。写入失败只记警告，不影响程序。没有 agent 的调用不写事件。原生执行器写的是 `tool/call` 与 `tool/result`，所以监听这两类事件的观察者仍看不到子调用，监听 `tools/*` 的则都能看到。
- 程序不能调用 `run_code`。
- 模型不能直接调用 `run_code` 以外的工具，只能在程序中调用。

## 限制

| 项目 | 默认值 | 说明 |
|---|---|---|
| 运行超时 | 120 秒 | 插件配置 `timeoutMs`，不能超过 `maxTimeoutMs`（默认 600 秒）。模型不能指定。等待审批和用户回答的时间不计入，与 DSH 自带 `run_code` 的「含嵌套工具与审批等待」不同 |
| 每次运行的工具调用数 | 256 | 超过后，多出的调用在程序中抛出错误 |
| 同时执行的工具调用数 | 10 | 一次运行内 `Promise.all` 的并行上限，只约束 `parallel` 的工具；`exclusive` 的工具一次一个 |
| 内存 | 64 MiB | 每个 agent 的沙箱 |
| `<result>` / `<log>` 字符数 | 10000 | 超出截断。`<result>` 超出时完整文本存入 spill 存储 |
| `<error>` 字符数 | 2000 | 超出截断 |
| 控制台缓冲 | 200 条 | 每个 agent |

- 不支持后台运行。每次运行都同步等待，超时即失败。
- 子调用的工具输出只在程序中可见。结果是否返回模型，由程序决定。
- 进程重启或 agent 重建后，之前的变量不保留。上下文只存在于内存中。

这些数值的默认值在 `CodeLimits`（`plugins/code-mode/core/src/types.ts`）中定义。除 `consoleRingSize` 与 `drainGraceMs` 外，其余字段可以在插件配置里覆盖，未写的字段用默认值。在 profile 的 `cordis.patch.yml` 里给已挂载的 `code-mode-dsh` 行补 `config`：

```yaml
- id: code-mode-dsh
  name: '@zhangliang0115/code-mode-dsh'
  config:
    timeoutMs: 300000
    maxTimeoutMs: 300000
    maxParallelSubCalls: 4
```

可配置字段：`timeoutMs`、`maxTimeoutMs`、`memoryBytes`、`maxSubCallsPerRun`、`maxParallelSubCalls`、`resultChars`、`logChars`、`errorChars`、`concurrentTools`。前八个必须是正整数；非法值让插件激活失败，错误里带字段路径（例如 `$.timeoutMs expected number >= 1 but got 0`）。`timeoutMs` 大于 `maxTimeoutMs` 也会让激活失败。

### concurrentTools：让未声明并发安全的工具并行

DSH 的调度器只让 `isConcurrencySafe(args) === true` 的工具并行，其余一律独占。MCP 工具由 `dsh-mcp-client` 注册，定义里没有这个字段，所以**所有 MCP 调用都串行**——即使那台服务器只提供只读查询。`dsh-mcp-client` 也不读 MCP 协议的 `annotations.readOnlyHint`（`dsh-mcp-client/lib/index.js` 中 `annotations`、`readOnlyHint` 零次出现）。

`concurrentTools` 是部署方的显式放行名单：

preset 形态下，插件行在 preset 内部，profile 的 patch 覆盖不到它；配置要写进 preset 的那一行。最省事的做法是覆盖整个 preset 行（`config` 整体替换，必须重写全部字段），或者直接用 `cordis.patch.yml` 里那一行的位置改包内文件。headless overlay 形态下插件在 deployment 层，直接写 `- id: code-mode-dsh` 加 `config` 即可。

```yaml
# headless overlay 形态
- id: code-mode-dsh
  name: '@zhangliang0115/code-mode-dsh'
  config:
    concurrentTools:
      - mcp__jev__jev_classify
      - 'mcp__jev__*'
```

- 名字精确匹配；结尾的 `*` 表示前缀匹配（`mcp__jev__*` 覆盖整台服务器）。
- 默认空数组，省略即保持 DSH 的 fail-closed 行为。
- 只影响调度分类：子调用仍然走 `prepare`、guard、审批、`post-execute`，事件与审计不变。
- **不能覆盖工具自己的拒绝**：工具声明了 `isConcurrencySafe: () => false` 时，名单不生效。
- 名单内的工具与名单外的工具之间仍然互相独占（屏障保留）。

**风险**：名单写错会让两个本应串行的调用重叠。只列真正无副作用的调用（只读查询、幂等接口）。写操作、有共享可变状态的工具不要列。MCP 的 `readOnlyHint` 是提示不是保证，协议注释明确写了客户端不应基于它做决策，所以这里要求部署方自己确认，而不是信任服务器自述。

## 与参考资料和原生执行器的差异

参考资料是 `docs/features/code-mode/`（对 Claude Code 行为的整理）。第 1–13 项与参考资料不同，第 14–18 项与 DSH 原生执行器不同。下列各项是团队的决定，原因写在每条中。

1. **工具失败统一抛异常。** 参考资料说内建工具失败返回 `{ error }`，MCP 工具失败抛异常。DSH 的工具调用结果不区分内建与 MCP。统一规则更容易理解，程序仍可用 `try/catch` 处理。
2. **持久化按 agent，不按会话。** 参考资料说会话结束时清空。agent 是 DSH 的工具调用归属单位（agent 带有 `agent.session`），所以上下文按 agent 保存。agent 销毁时释放上下文，恢复会话后变量不保留。没有 agent 的调用（例如不在 agent 内发起的调用）每次都得到一个新的临时上下文，运行结束即丢弃，变量不会跨调用保留。
3. **不使用 `presentAs`。** 参考资料的 `dsh-implementation.md` 建议用这个字段。DSH 0.2.2-rc.3 的源码中没有它。工具面由执行器的 `describe` 决定：只返回 `run_code`。
4. **没有后台（detached）脚本，也没有 `(dispatched #N)`。** 参考资料的 glossary 与 claude-code-source 描述了这些行为。DSH 的子调用绑定在模型回合的批次上。回合结束后继续调用工具，会违反流水线的生命周期。每次运行同步等待，超时即失败。
5. **没有 `$` shell 辅助。** shell 操作通过 DSH 的 shell 工具完成，不在沙箱里直接执行命令。
6. **输出转义和上限是本插件的选择。** 参考资料没有规定。`&`、`<`、`>` 转义，`<result>` 与 `<log>` 各 10000 字符，`<error>` 2000 字符。
7. **不支持 Claude Code 专有的功能。** 包括权限模式门控、hooks、auto 分类器、会话恢复、Remote Control、后台模式。这些依赖 Claude Code 宿主，DSH 没有对应物。
8. **沙箱没有 Node 全局。** 参考资料描述的程序可以使用 shell 辅助（`$`）。本插件的沙箱是 sealed 的 QuickJS，没有 Node API，程序只能通过注入的工具与 DSH 交互。
9. **顶层声明不是 ES module 语义。** 顶层声明改写为 `globalThis` 属性，以便跨调用保留。同名声明在下一次运行中覆盖旧值，不报错。
10. **控制台细节是本插件的定义。** 参考资料只有 `console.tail` 这个名字。本插件规定：控制台输出不进入信封，`console.tail(n)` 返回带级别前缀的字符串数组，环形缓冲 200 条。
11. **`preview` 的默认值与截断标注是本插件的定义。** 默认 2000 字符，截断后标注剩余字符数。
12. **`run_code` 的参数只有 `code`。** 参考资料只确认了 REPL 的输入字段是 `code`，完整输入 schema 未确认（`claude-code-source.md` 第 9 节），因此不能断定它允许模型指定超时。本插件由部署决定超时，模型不能修改，以便工具面更简单。
13. **工具名的访问方式。** 非标识符、与保留字或全局名冲突的工具只能通过 `tools["名字"]` 调用。参考资料只示例了 `await edit(...)`。

14. **子调用的会话事件用 PTC 的事件名。** 本插件写 `tool/ptc-dispatch-start` 与 `tool/ptc-dispatch`，不写原生的 `tool/call` 与 `tool/result`。原因：DSH 的 trajectory、user-questions、auto-review、todo 历史按 PTC 事件建模，写 PTC 事件即可识别子调用，不需要改 UI。代价：只监听 `tool/call` 的观察者看不到子调用。
15. **独占工具只在一次运行内串行。** 原生在一个 assistant step 的批次内分组。本插件按运行分组。同一 step 里的多个 `run_code` 调用由 DSH 的批次分组串行（真实 DSH 实测）。
16. **大结果的 spill 只覆盖 `<result>`。** 阈值是 `<result>` 的 10000 字符上限，不是 spill-policy 的 12500 token。原生的 spill 作用于每个工具的输出，本插件作用于 `run_code` 的整个结果。`<log>` 与 `<error>` 仍然只截断。
17. **等待用户的时间不计入超时，由宿主事件判断，不看工具名。** 插件在 `approval/request` 与 `user-questions/request` 上各挂一个前置监听（`prepend`），请求挂起期间暂停所属运行的计时。流水线 `prepare` 期间仍然暂停，`userWaitTools`（默认 `ask_user_question`、`exit_plan_mode`）的 `dispatch` 期间也仍然暂停，作为第二道。DSH 自带的 `run_code` 文档写明超时包含嵌套工具与审批等待，本插件有意不同（ADR 0004 第 13 条）。取舍：用户提问的请求不带子调用 id，只能按 agent 匹配，同一 agent 的并行 `run_code` 里某一个在提问时，该 agent 其他运行的计时也会暂停；审批请求带子调用 id，只暂停所属运行。
18. **审批面板不显示子调用的命令，这是 DSH 界面的行为。** 面板标题来自 `justification`，上方一行是子调用的 `description`。命令行由 `ApprovalCommand` 组件按 `callId` 在对话根节点里查找，子调用挂在父节点下，查不到，所以不显示（DSH 0.2.2-rc.3 源码，`dsh-client-ui-chat/src/client/chat/ApprovalCommand.tsx`）。插件已经写出 `tool/ptc-dispatch-start`（含 `arguments.command`）和带子调用 id 的 `approval/asked`，事件没有缺失；DSH 自带的 PTC 执行器有同样的缺口。需要把命令写进 `justification` 才能在面板里看到。

## 仍然存在的差异
- **与 DSH 内置 PTC preset 共存，不再互斥。** 插件以 `code-mode` agent preset 的形式安装，执行器注册在该 preset 的 agent scope 里；DSH 的限制是「一个 scope 只能有一个 tool executor」，deployment scope 的 `tool-executor-native` 与 `tool-executor-ptc` 保持启用，`standard`、`ptc`、`minimal`、`cordis` 与本 preset 都可选。依据：`dsh-tools` 的 `setExecutor` 按 `scopeOf(ctx)` 分别存储在 `scoped` map 与 `root` 两处；实测（2026-11-16）在 web profile 装入本 preset 后 `--dump-config` 通过、服务启动正常，未出现 `Only one tool executor may be registered in each scope`。对照：在 deployment scope 同时启用两个执行器会在启动时直接报该错误。
- 无 preset 注册表的 profile（`headless` 模板）无法承载 preset，需用 `dsh/cordis.headless.patch.yml` 作为 overlay，此时才禁用 native 与 PTC、在 deployment scope 挂载插件。
- 无头模式下子 agent 的审批被立即拒绝（实测，见 `friction.md`），所以跨 agent 的审批阻塞无法在无头模式下复现，只由单元测试 `F1a an approval pending in one agent does not block run_code in another agent` 覆盖。
- 子调用不出现在 `--json` 事件流中；`--json` 只输出外层 `run_code`。
- 审批面板对子调用只显示 `description` 与 `justification`，不显示命令（差异第 18 项）。
- 暂停计时依赖 `approval/request` 与 `user-questions/request` 的前置监听。桌面端应答端是远程事件监听，前置监听应当能包住它，但这一点还没有在桌面 App 上实测。
- 每次运行最多 256 个子调用，原生没有这个上限。

## 开发

在仓库根目录：

```bash
pnpm install
pnpm test               # 含 core 与 dsh 的测试
pnpm --filter @zhangliang0115/code-mode-core typecheck
pnpm --filter @zhangliang0115/code-mode-dsh typecheck
pnpm --filter @zhangliang0115/code-mode-dsh build   # 生成 dist/index.js，用于打包
```

- core 的测试不依赖 DSH。`no-host-deps.test.ts` 检查 core 不 import `@deepseek-ai/*` 与 `cordis`。
- dsh 的测试用真实的 `ToolExecutionPipeline` 和一个最小的 Cordis 替身（`test/fake-context.ts`）。
- 真实 DSH 冒烟测试的步骤与预期输出见 [INSTALL.md](INSTALL.md)。

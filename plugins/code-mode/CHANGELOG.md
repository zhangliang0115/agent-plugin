# 变更记录

## 未发布
### 新增
- DSH 插件面板的展示元数据：`locale/en.json` 与 `locale/zh.json` 的标题、描述，以及 `icon.svg`；`exports` 与 `files` 已包含它们。
- 插件配置：`Config` 暴露运行超时、内存、子调用数、并行数、输出上限，可在 profile 的 `cordis.patch.yml` 的 `config:` 里覆盖；未写的字段用 `CodeLimits` 的默认值，非法值在激活时失败并指出字段。
- 子调用写 `tool/ptc-dispatch-start` 与 `tool/ptc-dispatch` 会话事件，trajectory、user-questions 投影、auto-review、todo 历史能识别子调用。子调用 id 由 `<callId>/<n>` 改为 `<callId>:ptc:<n>`。
- 程序中捕获的子调用错误多出 `code` 与 `errorName`（如 `TOOL_TIMEOUT`、`APPROVAL_UNAVAILABLE`、`ABORTED_BEFORE_DISPATCH`）。`name` 与 `message` 不变。
- `<result>` 超过 10000 字符时，完整文本存入宿主 spill 存储，截断标注附文件路径。
- 子调用带 `concludesTurn` 时，外层调用结束回合（`exit_plan_mode` 驳回、结构化输出）。
- core 导出 `ToolCallError` 与 `CallControl`，`RunRequest` 增加 `onResultOverflow`。
- 子调用返回图片时，图片作为一条 user 消息交给模型（与 PTC 的 `commit()` 相同）。此前 `run_code` 内调用的截图、看图工具，模型看不到图。
- 子调用的 `tools/post-execute` 与会话事件按提交顺序结束，即使后提交的调用先完成；审批面板和审计顺序与原生一致。
### 修复
- `for (var { a } of xs)` 与 `for (var { a } in obj)` 不再报 `SyntaxError: invalid for in/of left hand-side`。此前 for-in/of 头的对象解构被加上括号，而括号化的对象解构不是合法的左值。
- 块内的 `var`（`if`、`for`、`try`、`switch` 里）在程序开头声明一次，块没执行时读到的也是 `undefined`。此前 `try { 1 } catch { var e = … }` 之后直接读 `e` 会抛 `ReferenceError`，与 README 承诺的函数作用域语义不符。
- 截断不再切断转义实体。此前 `<result>` 的切点落在 `&amp;` 中间时，模型会读到 `&a` 这类残片；截断标注里的字符数现在按实际删去的量计算。
- `<result>` 是否溢出改为按转义后的长度判断。此前 6000 个 `&`（原始 6000 字符、转义后 30000）会被截断却拿不到 spill 路径。
- 子调用带上绑定的工具 schema，Auto 权限预设下 auto-review 不再以 `the pending PTC binding schema is missing or inconsistent` 拒绝每个子调用。
- 子调用在拿到调度槽位之前失败（守卫、运行已结束）也会推进完成顺序，同一运行里后面的子调用不会等到超时。
- 永不 resolve 的 `tools/pre-execute` 钩子不再让 `run_code` 无限挂起。此前执行器在 `prepare` 期间暂停计时，钩子不返回时截止时间永远不到。
- `tools/ptc-dispatch-log` 监听器挂住时，运行在 2 秒后结束并记警告，不再永久 pending。
- 已取消的运行不再执行工具本体；超时或取消后，晚到的子调用不再执行 post-execute，也不再写会话事件。
- `dispose()` 中止在飞运行，插件卸载后工具不再继续执行。
- 顶层声明覆盖内建（如 `const Object = 1`）不再让沙箱后续每次运行都报 `could not install tools`。引导代码在内建被覆盖前捕获所需引用。
- 块内的 `var`（`for`、`if`、`try`、`switch` 里）跨运行保留，与普通 JavaScript 的函数作用域和 README 的承诺一致。
- 带括号的初始化表达式保留语义：`const a = (1, 2)` 得到 `2`，解构默认值不再报 `invalid destructuring target`。
- 顶层函数存在时，前导 `'use strict'` 仍在指令序言里，不再被静默关闭。
- 跨运行定义的函数抛错时不再把错误归到当前运行无关的行号。
- 无参数工具可以写成 `Tool()`，不再因参数为 `null` 被宿主拒绝；`code` 描述里的示例可以复制运行。
- `self.log` 有字符预算，日志循环不会耗尽 QuickJS 堆；上一轮运行的日志不再泄漏到失败的那一轮。
- 转义在截断之前，`&` 不再让模型收到的内容超出 `<result>`、`<log>`、`<error>` 的上限。
- 等待审批和用户回答的时间不再计入 120 秒运行超时。此前桌面端等待超过 120 秒时整个运行被终止，审批被取消。
- 工具在执行中自己申请的审批也不再计入运行超时。此前 `bash` 带 `sandbox_permissions` 时，审批由工具本体发出，不经过 `tools/pre-execute`，在「仅可查看」模式下等待超过 120 秒会以 `Code run timed out after 120000 ms` 结束，审批消失、命令未执行。现在监听宿主的 `approval/request` 与 `user-questions/request`，请求挂起期间暂停计时。用户提问的请求按 agent 匹配。
- 去掉进程级的串行锁。此前一个 agent 的审批等待会挡住所有 agent 的 `run_code`。现在每次运行有自己的调度器。
- 同一次运行内，`exclusive` 的工具（写文件、bash 等）在 `Promise.all` 中按提交顺序串行执行，与原生一致；`parallel` 的工具仍然并行。
### 变更
- 包名改为 `@zhangliang0115/code-mode-dsh` 与 `@zhangliang0115/code-mode-core`。只发布 dsh adapter（`private` 已移除，`publishConfig.access` 为 `public`），core 保持 private 并被打包进 adapter 的 `dist`。决策见 ADR 0005。从 tgz 安装的命令不变；`pnpm pack` 的产物名变为 `zhangliang0115-code-mode-dsh-0.1.0.tgz`。
- 支持顶层的 `return <value>`：它的值就是运行结果，并结束程序。此前模型写 `return` 会得到 `SyntaxError: 'return' outside of function`。提示词同时说明了这一点。
- 工具签名后显示返回形状（`-> { ... }`），来自 DSH 工具的输出 schema。最多两层，超过 600 字符截断（`MAX_RETURN_CHARS`）。模型不再需要先试错才知道返回值结构。
- `<error>` 包含出错的用户代码行号和该行原文。行号与用户代码一致，即使程序前面有 hoist 的声明或跨行语句。

## 0.1.0（2026-11-15）

### 新增
- DSH：`run_code({ code })` 工具。模型可以在一段 JavaScript 中调用 DSH 工具，只把最后一个表达式的值和 `self.log` 输出返回给模型。
- 持久化的 sealed QuickJS 沙箱，按 agent 隔离、按 agent 释放。
- 程序中的工具调用经过 DSH 流水线（`tools/pre-execute`、guard、`tools/execute`、`tools/post-execute`），`parent` 指向外层 `run_code` 调用。
- 控制台缓冲、`console.tail`、`preview`、`<repl-output>` 信封（含转义与截断标注）。
- 超时、子调用数量与并行数上限、内存上限。

### 已知限制
- 仅在 DSH 0.2.2-rc.3 上实测（macOS 桌面版）。
- 子调用不出现在 DSH 的 `--json` 事件流中。
- 不支持后台运行，行为与参考资料的差异见 `README.md`。

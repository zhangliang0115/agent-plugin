# Claude Code 源码里的 Code Mode

## 证据范围

- 版本：Claude Code 2.1.325 原生二进制（2026-11-13 构建，git sha `a360e7297ecfcddeae9ec99fb3c93153ed86aca4`）。
- 相关模块：`chunk-qrk6v9qh.js`（Code Mode 的 opt-in/工具面）、`running.prelude.js`、`file.prelude.js`、`chunk-f8sqhjr1.js`（engine check）。
- 读的是二进制里的字符串和可读代码片段，不是完整的反编译源码。标注 **【源码】** 的是直接读到的；**【推断】** 是根据字符串和上下文推出来的。

## 1. 工具面：模型只看到 `REPL`

**【源码】** Code Mode 下，模型顶层只看到 `REPL`（有的配置下还有一个 wait/poll 工具）。系统提示词原文：

```text
Your one tool is `REPL`; there are no other tools. Everything you do — shell
commands, file reads and edits, code search, web fetches, MCP calls — happens
as JavaScript inside a `REPL` call, through the globals below.
```

工具描述：

```text
Execute JavaScript to read, write, edit files and run shell commands
```

或（非 bash 场景）：

```text
Execute JavaScript code with access to Claude Code tools
```

### 系统提示词的结构

**【源码】** 提示词分成几节：

```text
## Declarations
## How to Use
## Available Tools
## Tips
```

`## Declarations` 的关键句：

```text
REPL is your programming interface to Claude Code's tools.
Use it to loop, branch, and compose tool calls with code.
```

`## How to Use` 的关键句：

```text
Write JavaScript that calls tools as async functions:

const { filenames } = await Glob({ pattern: 'src/**/*.ts' })
for (const f of filenames) {
  const { file } = await Read({ file_path: f })
  if (file.content.includes('oldName')) {
    await Edit({ file_path: f, old_string: 'oldName', new_string: 'newName', replace_all: true })
  }
}

IMPORTANT: Batch ALL operations into ONE REPL call.
```

`## Available Tools` 的关键句：

```text
All tools work as async functions: `Read`, `Write`, `Edit`, `Glob`, `Grep`, ...
MCP tools are callable by their full name
(e.g. `await mcp__slack__slack_send_message({...})`).

Built-in tools resolve with `{error: string}` on failure;
MCP tool calls THROW on failure — catch only where you can genuinely proceed
without the result, and never treat a caught failure as success.
```

`## Tips`：

- 没有 `import`/`require`；文件用 `Read`/`Write`/`Glob`，shell 用 `Bash`/`$`。
- 用 `Promise.all()` 并行。
- 变量跨调用保留。
- 最后表达式作为结果。
- 不要为了喂 shell 写临时文件，用 heredoc。

## 2. 运行时：一个持久化的 sealed `vm` 上下文

**【源码】** 相关 import 和文件：

```js
import * as Gn from "vm";
import { AsyncLocalStorage as qd } from "async_hooks";
import { isAbsolute as Kr, resolve as Wn, sep as Xr } from "path";
import { types as kt } from "util";
```

```text
running.prelude.js
file.prelude.js
```

**【源码】** 提示词原文：

```text
The REPL is one persistent JavaScript context: variables and functions you
define in one call are there in the next, so keep results in variables
(`const out = await $`…`.text()`) instead of re-reading a file or re-running
a command whose output you already hold. Those variables last between calls,
but not across a restart, a resume, a fork or a wake: the first result after
one of those says so. Top-level `await` works. There is no `import`,
`require` or `process`: the context is sealed, and the globals below are how
it reaches the machine. The REPL language is always JavaScript, whatever the
codebase is written in — run the codebase's own tools (pytest, cargo, go test, …)
with `$`.
```

**【推断】** 实现方式：

- 每个会话一个 `vm.Context` 或等价的隔离上下文；
- prelude 注入 `$`、`self.log`、`preview`、文件辅助函数；
- 工具绑定是 async 函数，直接指向宿主工具；
- `AsyncLocalStorage` 标记当前代码属于哪个脚本/哪次工具调用，权限、日志、超时都靠它归因；
- `inProcessBuiltinRefusal` 守卫，防止代码绕过绑定直接摸宿主内建对象。

## 3. 代码里可用的 API

### 工具

**【源码】** 内建工具与 MCP 工具都作为 async 函数：

- 内建：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`NotebookEdit`、`TodoWrite`、`TaskCreate`、`TaskGet`、`TaskList`、`TaskStop`、`TaskUpdate`（来自超时表里的工具集合）。
- Shell：`Bash`，Windows 上是 `PowerShell`。
- MCP：按全名 `mcp__<server>__<tool>`。
- Skill/其他工具：按名字调用。

### `$` shell 模板标签

**【源码】** 提示词提到：

```text
A shell command with no timeout of its own moves to the background after
10 minutes, so give a long build a longer timeout (up to 2 hours) to await it.
```

```js
const { stdout } = await $`git status`.text()
const r = await $`npm test`.nothrow()
```

- `.text()` 取 stdout 字符串；
- `.nothrow()` 不因非零退出码抛错；
- 直接 `await $`...`` 得到带 stdout/stderr/exitCode 的结果对象；
- 返回对象里的 Promise 会自动 await；内联使用的 Promise 需要显式 `await`。

### 日志与截断

**【源码】**：

```text
A script's output is its last expression's value plus anything it
`self.log(...)`s along the way. What it returns is added to your context and
stays there; the value itself stays in the REPL whether you return it or not.

`console.*` goes to a bounded in-memory ring rather than into your context;
`console.tail(n)` reads it back.

To keep a long output out of your context, return `preview(out)` or
`preview(out, 2000)` instead of the output itself: it gives the first
characters, and when `out` is an awaited `$` result (not its `.text()`
string) whose output the shell tool saved to a file, it starts with the
output's size and the file's path.
```

### Promise 语义

**【源码】**：

- 返回对象里的 Promise 自动 await；
- 内联使用的 Promise（拼接、插值、传给另一个调用）需要显式 `await`。

## 4. 输出协议

**【源码】** 一次 `REPL` 调用的结果：

```xml
<repl-output eval="N">
  <log>...</log>
  <result>...</result>
</repl-output>
```

失败时：

```xml
<repl-output eval="N">
  <log>...</log>
  <error>...</error>
</repl-output>
```

**【源码】** 长脚本不会阻塞：

```text
A `REPL` call only dispatches its script and returns `(dispatched #N)` at once.
```

```text
<event kind="repl-eval" eval="N">
  <log>...</log>
  <result>...</result>
</event>
```

```text
<event kind="repl-status">...</event>
```

**【源码】** 脚本可以被用户停止，结果里有：

```text
stoppedBy: "user" | "refusal"
```

`user` 是 Esc 或另一个客户端发的 Stop；`refusal` 是拒绝。

**【源码】** 输出上限相关常量：

```js
var gr = { answerChars: 1e4, otherRows: 10, otherChars: 500 }
```

- 回答类内容最多约 10,000 字符；
- 其他行最多 10 条、每条约 500 字符；
- 超出截断并标注。

**【源码】** 图片/base64 会被移到结果里并限制长度：

```text
[N base64 chars — X bytes moved to the REPL result, subject to its per-result N cap]
```

**【源码】** 输出里的 `&`、`<`、`>` 会显示成 `&amp;`、`&lt;`、`&gt;`；这只影响显示，不改文件内容。

## 5. 执行与调度

**【源码】**：

```text
Your scripts run in one persistent VM and start in the order you send them; a
script starts when the one before it ends or has run for about X seconds. A
script still running by then is `detached`: it keeps running beside the scripts
after it, and they share variables.
```

**【源码】** 脚本结束后的工具调用会被拒绝，错误原文包括：

```text
This tool call did not run. The piece of code that it belongs to had already
finished, and a timer or promise that finished code leaves running can't make
tool calls. To run these steps, send them again in one piece of code that
awaits each of them.
```

```text
This tool call did not run. The code that made it finished or was stopped
before the call could start. If it is still needed and nobody stopped the code,
make the call again in code that awaits it.
```

```text
Code that had already finished left a loop or promise chain running, and it
kept making calls. Finished code can run no tool, so its calls now get no
answer and it has stopped.
```

**【源码】** 工具超时：

- Shell 命令没有自己的 timeout 时，10 分钟后转后台；最长 2 小时。
- 内建工具（Read/Write/Edit/Glob/Grep/NotebookEdit/TodoWrite/Task*）约 10 秒超时（`1e4`）。
- Shell/其他工具的超时来自 `hr(e,n,r)` 和 `RQ()`/`y4()`，具体数值未逐个核对。

## 6. 权限

**【源码】**：

- 代码里的每个工具调用仍然走 `deny`/`ask` 规则和 `PreToolUse` hooks。
- auto 模式分类器审整段代码，不审每个调用；它看不到运行时才产生的值。
- hooks 可以匹配 `REPL`，从 `tool_input.code` 读 JavaScript。
- 代码里调用 computer use / Claude in Chrome 会被拒绝：
  - `Computer use call refused in REPL mode`
  - `Claude in Chrome call refused in REPL mode`
- MCP 参数不在 schema 里会被拒绝：
  - `tengu_repl_mcp_undeclared_args_refuse`
- 参数不可序列化成 JSON 会被拒绝：
  - `tengu_repl_unwritable_args_refuse`
- 工具调用失败会被收集成：

```text
Tool calls that were refused while this script ran:
- <tool>, refused: <reason>
```

## 7. 生命周期

**【源码】** 环境变量：

```text
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE_RESTART
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE_RESTARTED_FROM
```

启动逻辑：

```js
if (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE === undefined &&
    CLAUDE_CODE_EXPERIMENTAL_CODE_MODE_RESTART === undefined) {
  // state: "not_asked"
} else {
  await settleCodeModeOptInAtStartup(...)
  // state may be "on" / "refused"
}
```

**【源码】** 相关导出：

```js
CODE_MODE_OPT_IN_GATE
answerCodeModeOptInDialog
closeCodeModeOptInAfterSetup
doToolOptionsLeaveReplOut
isAcceptedModel
isSignedInAsWhenModeKept
refusalForeseen
reviewCodeModeOptInInSetup
settleCodeModeOptInAtStartup
```

**【源码】** 引擎检查：

```text
REPL mode's engine check failed
REPL mode's engine check failed (...); REPL mode is kept off
REPL mode: the engine check ran late, at the first read of the mode...
```

```text
The REPL tool cannot run scripts in this session: the JavaScript engine under
Claude Code failed Code Mode's engine check. Run Claude Code with the
repository's pinned Bun (node_modules/.bin/bun) or use a staff build.
```

**【源码】** 内建对象越界：

```text
in-process built-in reached past its tools in REPL mode
```

**【源码】** 工具选项：

```text
doToolOptionsLeaveReplOut(...)
```

如果 `--restricted`、`--disallowedTools` 或基础工具集让 `REPL` 被排除，Code Mode 会拒绝启动。

## 8. 门控

**【源码】**：

- `tengu_rustling_blossom`：Code Mode 的 opt-in 门槛（GrowthBook）。
- `isAcceptedModel`：只接受特定模型。
- `isSignedInAsWhenModeKept`：登录状态一致性。
- `refusalForeseen`：mods、agent teams 等。
- `lastCheck` 返回 `"mods"` 表示有 mod 在启动时检查工具调用。

**【文档】** 官方 gate：

- Claude 订阅或 Console 账号；
- 不能走 gateway/Bedrock/Vertex/Foundry；
- 不能有 `apiKeyHelper` / `ANTHROPIC_AUTH_TOKEN`；
- 不能开 `DISABLE_TELEMETRY`、OpenTelemetry；
- 不能开 agent teams；
- 原生构建；
- 终端交互式。

## 9. 未确认 / 推断

- 脚本 detach 的精确阈值（提示词里是 “about X seconds”）。
- `self.log` 的内部实现和上限。
- `preview` 对 shell 结果的具体格式。
- 内建工具超时的完整表。
- `isAcceptedModel` 的具体模型列表（官方文档写的是 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.2）。
- `vm` 是 Node 的 `vm` 还是 Bun 的实现；import 是 `vm`，但运行在 Bun 原生二进制里。
- `REPL` 的完整输入 schema（文档和 hook 只确认了 `tool_input.code`）。
- wait/poll 工具的真实名字（源码里是变量 `xi`，未解析）。

## 10. 对 DSH 的启示

- 核心是四件事：**持久 sealed JS 上下文、工具绑定、输出协议、提示词**。
- 宿主必须能提供两样东西：工具注册表/调用入口，以及权限/沙箱流水线。
- DSH 有 `ctx.tools` 和 `tools/pre-execute`，正好对上。
- DSH 不需要 Claude Code 的账号/模型/gateway/telemetry 门控；它自己的版本和 API 才是约束。

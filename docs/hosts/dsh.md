# DSH（DeepSeek Harness）
- 核对版本：DSH `0.2.2-rc.3`（上游 tag `dsh-v0.2.2-rc.3`，提交 `39163dd`；npm dist-tag `next`）。本机 `/Applications/DeepSeek Harness.app` 的 `CFBundleShortVersionString` 与 `dsh --version` 均为 `0.2.2-rc.3`。
- 核对日期：2026-11-15
- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 插件指南（第三方，已对照上游）：<https://www.ssdnodes.com/learn/write-your-own-dsh-plugin>
- 稳定性：**开发者预览**，README 明确会有破坏性变更。字段名在 rc 之间会改，用之前对照当时的上游文档

## 插件形态
DSH 基于 Cordis，"一切皆插件"：工具注册表、agent loop、会话存储都是插件。插件是一个模块，导出：
- `name`：诊断用名称
- `inject`：依赖的服务，如 `['tools']`。**必须写**，否则 `apply` 可能在 `ctx.tools` 就绪前执行
- `apply(ctx)`：入口。通过 `ctx` 注册的东西在插件卸载时自动撤销；Cordis 管不到的资源用 `ctx.effect(() => dispose, label)`。`label` 用于诊断，上游 `tools.setExecutor()` 就传了它

## 注册工具
```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
}
```
`output.schema` 描述返回值，`output.render` 决定模型看到的内容块。

## 拦截工具调用
监听器用 `ctx.on(event, handler)` 注册。waterfall 事件签名是 `(payload, next)`，**必须 `await next()`**（或返回决定），否则会截断整条链。

一次工具调用（包括 PTC 的子调用）的顺序，见 `packages/core/tools/src/pipeline.ts`：
1. `tools/pre-execute`（waterfall，返回 `allow` / `deny` / `cancel` / `ask`）。`ask` 走审批服务，没有审批服务时视为拒绝。
2. guard（`ctx.tools.guard()` 注册）。在 pre-execute 之后执行（`prepare`，约第 200–215 行）。guard 拒绝是最终的。
3. `tools/execute`（waterfall，包裹工具本体）。
4. `tools/post-execute`（waterfall，可以 `accept` / `replace` / `block`）。
5. `tools/result`：只读通知，不是 waterfall。

`pre-execute` 返回 `deny` 时，工具本体不运行，调用方收到错误结果。`cancel` 返回取消结果，不算策略拒绝。

## 工具执行器（executor）
模型一次工具调用由哪个执行器处理，由 `ctx.tools.setExecutor(executor)` 决定。
- 同一 scope 只能有一个 executor。第二次调用抛出 `Only one tool executor may be registered in each scope`（`packages/core/tools/src/index.ts:325-330`）。
- 执行器实现 `describe(tools)`（返回模型看到的 schema 和 `knownNames`）、`execute(batch)`，可选 `sections`（系统提示词片段，`text` 可以是根据可见工具生成的函数）。返回的注销函数由 `ctx.effect` 管理，插件卸载时自动撤销。
- `run_code` 是保留名。`register()` 和 `restrict()` 都会拒绝它（`index.ts:145`、`index.ts:176`），即使它不属于普通工具。
- 基础 profile 中 `tool-executor-native` 默认启用，`tool-executor-ptc` 默认禁用（`packages/bundle/base/cordis.patch.yml`）。挂载自己的 executor 时，要用 patch 禁用 native，否则两者争抢同一 scope。
- 内置 PTC 执行器（`tool-executor-ptc`）提供 `run_code({ code, description })`，程序只能是 TypeScript，只通过 `inspect(...)` 输出，最后一个表达式被丢弃（`ptc.ts:650`，`discardCompletion: true`）。它的 `run_code` 与 Code Mode 的 `run_code` 同名，两者不能同时启用。

## 可复用的流水线（pre-stable）
`@deepseek-ai/dsh-tools/pipeline` 导出 `ToolExecutionPipeline` 与 `executeToolBatch`。自定义执行器可以用它们走同一条流水线：
- `new ToolExecutionPipeline(ctx, { get, reject })`。`get` 决定名字如何解析，`reject` 决定是否允许模型直接调用（子调用的 `nested` 为 true）。
- 子调用：`prepare(input)` → 若为 `dispatch` 则 `dispatch(exec)` → `complete(exec, outcome)`。`prepare` 与 `complete` 要按顺序执行，`dispatch` 可以并行。
- `ToolExecutionInput.parent` 是外层调用的 token（`contracts.ts` 约第 196–197 行）。设置后，PTC 语义下才允许直接调用原生工具名。
- 公开 API 仍是 pre-stable，升级时用契约测试检查（见 `plugins/code-mode/dsh/test/invoker.test.ts`）。

## 插件配置
- 有配置的插件导出 `export const Config = z.object({...})`（`@deepseek-ai/schemastery`，3.19.0）。Cordis 在激活前用它校验 profile 行里的 `config` 并填默认值，`apply(ctx, config)` 收到的是解析后的对象；行配置整体替换、不深合并（`dsh-app-boot/README.md`：profile 的 `cordis.patch.yml` 在所有组合包层之后应用，所以能按 id 覆盖已安装包插入的条目）。
- 校验失败时插件激活失败，错误信息带字段路径（例如 `$.timeoutMs expected number >= 1 but got 0`）。字段注释会被 `dsh/docs/config-catalog.md` 的生成器读走，接口上的 JSDoc 就是文档。（来源：app.asar 内 `@deepseek-ai/cordis` 与 `dsh-tool-executor-ptc/src/config.ts`，2026-11-16 核对。）

## 打包与安装
- 插件是 npm 包，`package.json` 写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`files` 必须包含 `cordis.patch.yml`。
- `cordis.patch.yml` 的行 `name` 等于包名，`id` 保持稳定、不复用。
- `main` / `exports` 指向 JS 入口。DSH 的插件加载器不跑 `.ts` 源文件；仓库里用 esbuild 打成单文件 ESM（见 ADR 0004）。
- `@deepseek-ai/*` 是宿主提供的包：写在 `peerDependencies` 里（精确版本），开发时同版本放在 `devDependencies`，不要放进 `dependencies`。
- `engines` 写 `"dsh": ">=<版本>"`；keywords 加 `dsh-plugin`。
- 安装方式：`pnpm pack` 得到 tgz，再 `dsh plugin --profile <name> add <tgz>`。不用 `add <目录>`：pnpm 会把目录链接进来，不解析 peer 依赖，链接包会加载源码目录里的开发副本（见 `friction.md`）。

## 自定义执行器要补的行为（2026-11-15 实测，DSH 0.2.2-rc.3）
原生批次（`executeToolBatch`）替执行器做了几件事，自定义执行器要自己补，否则子调用与原生有差异（`plugins/code-mode/README.md`）：
- 独占工具分组：用 `pipeline.executionMode(input).kind`（`exclusive` 或 `parallel`）。不分组时，写文件、bash 在 `Promise.all` 中会并行。
- 会话事件：原生写 `tool/call`、`tool/result`；PTC 写 `tool/ptc-dispatch-start`、`tool/ptc-dispatch`。trajectory、user-questions 投影、auto-review、todo 历史按 PTC 事件建模。
- 回合结束：`ToolExecutionResult.concludesTurn` 要转发给 `exec.concludeTurn()`，否则 `exit_plan_mode` 驳回后回合不结束。
- 错误身份：`result.error.info` 带 `code` 与 `name`（如 `TOOL_TIMEOUT`、`APPROVAL_UNAVAILABLE`），不转发时调用方只剩 message。
- 子调用的 `schema`：`ToolExecutionInput.schema` 要带上绑定时可见的工具 schema（`ctx.tools.schemas()` 的投影，PTC 用 `deepFreeze` 把同一份传进去）。`dsh-experimental-auto-review` 的 `ptcAction` 要求 `exec.schema !== undefined && exec.schema.name === exec.name`，缺了会把每个子调用判成 `AUTO_REVIEW_FAILED` 并拒绝工具本体（`src/index.ts:382`，2026-11-16 核对）。
- 大输出：`ctx.get('spillStore').saveText(...)` 保存全文，返回的路径形如 `$TMPDIR/dsh-spill-*/session-*/<id>-run_code.txt`；原生靠 `dsh-spill-policy` 在 `tools/post-execute` 做，只处理超过 12500 token 的内容。
- 审批等待：`approval/request` 没有应答端时无头返回 `unavailable`；有应答端时一直等到回答。执行器不要在审批期间持有会阻塞其他会话的锁，也不要让整体超时覆盖等待。
- 审批和提问不只来自流水线的 `ask`。bash、pwsh、write、edit 在工具本体里为 `sandbox_permissions` 调用 `ctx.approval.request`（`dsh-sandbox/src/escalation.ts` 的 `approveEscalation`），请求的 `callId` 是子调用自己的 id，发生在 `tools/execute` 之后，不经过 `tools/pre-execute`。`ask_user_question`、`exit_plan_mode`、computer-use 工具调用 `user-questions/request`，请求里没有子调用 id。两个事件都是 waterfall，应答端返回结果、不调用 `next()`。插件要观察等待，用 `ctx.on(event, listener, { prepend: true })`；`prepend` 是 Cordis 的监听选项，`dsh-experimental-auto-review` 也用它。（来源：app.asar 内 `@deepseek-ai/*` 源码，DSH 0.2.2-rc.3，核对于 2026-11-15。）
- DSH 自带 `run_code`（`dsh-tool-executor-ptc/src/ptc.ts`）文档写明超时「含嵌套工具与审批等待」。Code Mode 有意不同。
- 审批面板的命令行由 `dsh-client-ui-chat/src/client/chat/ApprovalCommand.tsx` 按 `callId` 在对话根节点里匹配 `root.callId`，子调用不是根节点，匹配不到，面板只有 `displayReason`（来自 `justification`）。事件已齐全（`tool/ptc-dispatch-start` 带 `arguments.command`），缺口在界面。（同一来源，2026-11-15；桌面界面只核对了用户报告与源码一致。）
- 无头模式下子 agent 内的审批被立即 `rejected`，不会走到 `approval/request` 的应答端。因此无头模式无法复现「一个 agent 在等审批、另一个 agent 在跑」。
- 同一个 assistant step 里的多个 `run_code` 调用由批次逐个执行，后一个等前一个结束。
## 本地验证命令
```bash
dsh --profile <name> --dump-config            # 看插件行、禁用行是否进入组合树
dsh plugin --profile <name> add <tgz>         # 以打包形态安装到测试 profile
dsh headless "<task>"                         # 内置 headless 模板的一次性任务
dsh --profile <name> --json "<task>"          # profile 含 dsh-headless 时：输出 JSON 事件流
```
- `headless` 是内置 profile 模板名。`dsh --profile <name> headless ...` 会把 `headless` 当作任务文本，进程没有输出（见 `friction.md`）。
- 自建 headless profile：`dsh --profile <name> --from-default-profile headless --dump-config` 从模板建立，然后再 `plugin add`。模板的默认模型是 DeepSeek 官方 API（`deepseek-official`），如要用本机网关，要在 profile 的 `cordis.patch.yml` 里写 provider 与 `agent-default-model`。
- 插件加载了但没反应时，先跑 `--dump-config`：行不在说明是组合问题，行在说明是代码问题。

## 本项目约定
- adapter 目录 `plugins/<name>/dsh/` 是一个独立 workspace 包。
- 锁定的 DSH 版本：`0.2.2-rc.3`（精确版本写在 `plugins/*/dsh/package.json` 的 `peerDependencies` 与 `devDependencies` 中）。

## 已知问题
- `--json` 事件流只记录外层工具调用。`run_code` 里的子调用不出现在事件流中，只能通过流水线监听器观察（`friction.md`）。
- `dsh --profile <name> headless` 无输出挂起（用法见上）。
- `dsh plugin add <目录>` 不解析 peer 依赖（用法见上）。

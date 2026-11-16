# 摩擦记录

宿主、工具或本项目规则的行为与预期不一致时，先在这里记下来再改。解决后把条目状态改成"已解决"，并写明结论回写到了哪里（`docs/hosts/`、`AGENTS.md`、ADR 或代码）。

## 格式

```markdown
## YYYY-MM-DD 短标题
- 状态：未解决 | 已解决
- 现象：可复现的一步，以及实际看到的输出或路径
- 期望：文档或规则怎么写的（带文件路径或官方链接）
- 处理：改 AGENTS.md / 改 docs/hosts / 改 adapter / 先不改；已解决时写结论去向
```

## 记录

## 2026-11-15 Kiro 不跟随软链接，skill 无法用软链接共享
- 状态：已解决
- 现象：想让 Kiro 和 Claude Code 共用一份仓库 skill。Kiro 的加载器忽略软链接目录（[kirodotdev/Kiro#6401](https://github.com/kirodotdev/Kiro/issues/6401)、[#8265](https://github.com/kirodotdev/Kiro/issues/8265)）。
- 期望：一份 skill 文件，两个工具都能加载。
- 处理：真实文件放 `.kiro/skills/`，`.claude/skills -> ../.kiro/skills` 软链接。实测 Kiro 能加载 `.kiro/skills/` 下的临时 skill，Claude Code 2.1.325 能通过软链接加载同一个 skill。结论写入 `docs/conventions.md`「Skills」。

## 2026-11-15 npm 镜像下载 TypeScript 7 平台包时卡住（原记录的 404 未复现）
- 状态：已解决
- 现象：用户的 npm 配置 registry 是 `https://registry.npmmirror.com`。第一次 `pnpm add -D -E typescript@7.0.2` 下载 `@typescript/typescript-darwin-arm64@7.0.2` 时，镜像的 tarball 请求出现 404 并不断重试，进程不结束。复核时，`npm view` 查询两个 registry 的元数据都返回 7.0.2；`registry.npmjs.org` 上的 darwin tarball 返回 200。镜像上同一 tarball 首次 200、二次超时，所以问题更像网络或镜像同步不稳定，不是包缺失。
- 期望：`typescript@7.0.2` 及其平台包都能从配置的 registry 下载。
- 处理：`pnpm add -w -D -E typescript@7.0.2 --registry=https://registry.npmjs.org` 安装成功（约 9.5 秒，只用于这一条命令，不改全局配置）。`package.json` 与 `pnpm-lock.yaml` 锁定 7.0.2。决定见 `docs/decisions/0003-scripts-toolchain.md` 的修订记录。镜像问题仍在，装新包时需要显式指定 registry 或重试。

## 2026-11-15 TypeScript 7 不再自动加载 @types/node
- 状态：已解决
- 现象：升级到 `typescript@7.0.2` 后，`pnpm typecheck` 报 33 个错误（`Cannot find name 'process'`、`Cannot find module 'node:fs/promises'` 等）。在 5.9.3 下同样的配置能通过。`pnpm test` 不受影响，因为 Node 直接运行 `.ts` 文件，不做类型检查。
- 期望：`@types/node` 已安装为 devDependency，类型检查应能找到 Node 类型。
- 处理：在根 `tsconfig.json` 的 `compilerOptions` 里写 `"types": ["node"]`。修复后 `tsc --listFiles` 列出 `scripts/` 下的 6 个文件，`pnpm typecheck` 通过。结论写入 ADR 0003 的决策第 4 条。
## 2026-11-15 `dsh --profile <name> headless` 把 headless 当成任务文本，进程无输出挂起
- 状态：已解决
- 现象：执行 `dsh --profile code-mode-test headless "Reply with pong"`，进程没有任何输出，超时后才退出（exit 124）。`dsh headless --help` 在无 profile 时正常输出帮助。
- 期望：`docs/hosts/dsh.md` 没有写 headless 的调用方式。DSH 帮助文本写的是 `dsh --profile headless [options] [task...]`，即 `headless` 是内置 profile 模板的名字，`dsh headless "..."` 是它的简写。
- 处理：`docs/hosts/dsh.md` 的「本地验证命令」改为两种写法：内置模板用 `dsh headless "<task>"`；自建 profile 用 `dsh --profile <name> --from-default-profile headless` 建好后，`dsh --profile <name> "<task>"`。

## 2026-11-15 `--from-default-profile headless` 默认模型是 DeepSeek 官方 API，不是本机网关
- 状态：已解决
- 现象：用 headless 模板新建 profile，`--dump-config` 中 `agent-default-model` 为 `provider: deepseek-official`、`model: deepseek-flash`，凭据读 `DEEPSEEK_API_KEY`。桌面端和 web profile 的默认模型是本机 magpie 网关的 `group/ds4.1-flash`。
- 期望：新建的测试 profile 使用本机已配置的网关和默认模型（用户要求）。
- 处理：在测试 profile 的 `cordis.patch.yml` 里写入与 desktop profile 相同的 `llm-pi-ai`（`magpie-responses`）和 `agent-default-model` 两行，网关地址和模型不变。`plugins/code-mode/INSTALL.md` 写了这一步。desktop 和 web profile 未改动。

## 2026-11-15 `dsh plugin add <本地目录>` 用 pnpm link，不解析 peerDependencies
- 状态：已解决
- 现象：`dsh plugin --profile <name> add /abs/path/to/pkg` 输出 `The linked in dependency will not resolve the peer dependencies from the target node_modules`。链接的包会解析到源码目录下自己的 `node_modules`，里面是开发用的 `@deepseek-ai/dsh-tools` 副本，与宿主的副本不是同一份。
- 期望：`docs/hosts/dsh.md` 的「打包与安装」只说明了 `package.json` 与 `cordis.patch.yml` 的写法，没有说明安装方式。
- 处理：`docs/hosts/dsh.md` 改为先 `pnpm pack` 得到 tgz，再 `dsh plugin --profile <name> add <tgz>`。INSTALL.md 使用这一方式。

## 2026-11-15 quickjs-emscripten 的 OOM 之后，JS_FreeRuntime 断言失败并 abort 整个 WASM 模块
- 状态：已解决（规避，见结论）
- 现象：在 `quickjs-emscripten@0.32.0` 的同步 WASM 上，程序内存超过 `setMemoryLimit` 后（即使程序用 try/catch 捕获了 OOM），`runtime.dispose()` 输出 `Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c, JS_FreeRuntime`，并让同一个模块实例之后不可用。同一模块里的其他 runtime 也一起失效。
- 期望：超过内存上限的程序只让自己失败，不影响其他会话。
- 处理：每个 owner（agent）用独立的 `newQuickJSWASMModule()` 实例，这样 abort 只影响它自己的模块。释放时 `dispose` 包在 try/catch 中，失败的模块不再被引用，由 GC 回收。代价是每个 owner 约 65 ms 的模块创建时间，并且测试中会在 stderr 打印一行 `Aborted(...)`。结论写入 `docs/decisions/0004-code-mode-dsh-design.md`。

## 2026-11-15 DSH `--json` 事件流不包含 run_code 里的子调用
- 状态：已解决（以测试 profile 的观察插件作为证据）
- 现象：一次 run_code 内 `Promise.all` 调用两次 `read`。`dsh --profile <name> --json` 的事件流只有 `tool_call` 和 `tool_result` 各一次（`run_code`），看不到两次 `read`。用 `ctx.on('tools/pre-execute' | 'tools/execute' | 'tools/post-execute', ...)` 写的测试观察插件可以看到，两次 `read` 各有三段事件，`parent` 不为空，`rootCallId` 等于 run_code 的 callId。
- 期望：`docs/hosts/dsh.md` 未说明这一点。
- 处理：`docs/hosts/dsh.md` 的「已知问题」补充这一行。插件本身不写会话事件（PTC 会写 `tool/ptc-dispatch`，本插件暂未实现，记为后续项）。

## 2026-11-15 `docs/hosts/dsh.md` 的 PTC 与工具注册事实需要更正
- 状态：已解决
- 现象：文档写「内置 PTC 模式…与 Code Mode 思路重叠」，未写明三个事实：`run_code` 是保留名（`packages/core/tools/src/index.ts:145`、`:176`）；同一 scope 只能有一个 executor，第二次 `setExecutor` 抛错（`index.ts:325-330`）；PTC 丢弃程序的最后表达式（`packages/core/tool-executor-ptc/src/ptc.ts:650`，`discardCompletion: true`）。文档还把 `ctx.effect` 的第二个参数 label 省略了。
- 期望：文档与上游 `dsh-v0.2.2-rc.3`（`39163dd`）一致。
- 处理：`docs/hosts/dsh.md` 按上述事实改写，并把「核对版本」更新为本机 DSH 0.2.2-rc.3。

## 2026-11-15 `dsh plugin --profile <p> add <目录>` 之后，源码目录里的 node_modules 被删除
- 状态：已解决（规避：只用 tgz 安装；见下）
- 现象：对 `plugins/code-mode/dsh`（工作区内的 pnpm 包）执行 `dsh plugin --profile code-mode-test add <该目录>`，profile 的 pnpm 写入 `link:` 依赖。之后该包的 `node_modules`（含 workspace 链接与 DSH 宿主包的开发副本）消失，`pnpm typecheck` 报 `node_modules missing`。`pnpm install` 重新安装后恢复。原因未确认，推测是 profile 的 pnpm（v11）在链接时清理了目标目录。
- 期望：安装插件不修改源码目录。
- 处理：`docs/hosts/dsh.md` 与 `INSTALL.md` 只用 `pnpm pack` 得到的 tgz 安装。仓库内的 `node_modules` 丢失后用 `pnpm install` 恢复，不影响源码。

## 2026-11-15 DSH 的 `projectToolSchema` 丢弃 `output.schema`，模型看不到工具返回形状
- 状态：已解决（适配器读取 `definition.output.schema`）
- 现象：真实会话中模型先写 `const [a,b] = await Promise.all([read(...), read(...)])` 并对返回值调用 `split`，报 `TypeError: not a function`。`read` 实际返回对象 `{ path, offset, lines, totalLines }`。`projectToolSchema`（`dsh-tools/src/schema.ts`）只返回 name、description、parameters，于是提示词里的工具签名只有入参，没有返回形状。
- 期望：提示词能显示每个工具的返回形状。
- 处理：核心的 `ToolDescriptor` 增加可选的 `outputSchema`，`prompt.ts` 把它渲染成 `-> 类型`（最多两层，240 字符）。DSH 适配器从 `definition.output.schema` 取值。
## 2026-11-15 DSH `defineTool` 要求每个 object 输出 schema 显式写 `additionalProperties`
- 状态：已解决（测试夹具已按此写）
- 现象：`defineTool({ output: { schema: { type: 'object', properties: ... } } })` 抛出 `UNSUPPORTED_SCHEMA: schema.additionalProperties must be explicitly true or false`。
- 期望：文档或类型提示能说明这一要求。
- 处理：测试夹具写 `additionalProperties: false`。`docs/hosts/dsh.md` 尚未记录这一点，待后续补充。
## 2026-11-15 QuickJS 错误栈的行号需要减去插件包裹的偏移量
- 状态：已解决
- 现象：`quickjs-emscripten@0.32.0` 的错误 `stack` 里，求值源码的行号从包裹函数的第一行起算（`(async function () {` 为第 1 行）。程序前面有 hoist 的声明时，行号还要再减去前缀行数。插件原先在 `run` 的 rejection 处理里只取 `name` 和 `message`，行号被丢弃。
- 期望：`<error>` 能指出用户代码的行号。
- 处理：guest 把 `stack` 传给宿主；宿主在 `program.js` 的帧中取行号，减去包裹行和前缀行数，并附上该行原文（截断到 200 字符）。转换器保留每条语句的换行数，使行号与用户代码一致。
## 2026-11-15 DSH 内置 bash 的输出 schema 是 `oneOf`，提示词显示 `-> unknown`，模型把返回值当字符串用
- 状态：已解决
- 现象：真实会话（smoke-run4）中模型写 `bash(...).trim()`，报 `TypeError: not a function`。`bash` 的 `output.schema` 是三个分支的 `oneOf`（background、promoted、foreground），`prompt.ts` 的 `typeText` 不认识 `oneOf`，渲染成 `-> unknown`。
- 期望：`bash` 那一行显示三个分支的字段，尤其是 `foreground` 的 `stdout.text`。
- 处理：`typeText` 支持 `oneOf`（分支用 ` | ` 连接）和 `const`、`enum`。返回类型上限从 240 调到 600 字符，使 bash 的完整形状（约 520 字符）能显示。`rendered-description.txt` 是真实请求里的渲染结果，核对过 23 个工具都有 `->` 形状。
## 2026-11-15 无头模式下子 agent 的审批立即被拒绝，无法复现跨 agent 的审批阻塞
- 状态：未解决（规避：跨 agent 的行为由单元测试覆盖，桌面 App 手动验收）
- 现象：`GAP_ASK_TOOLS=read` 且观察插件作为审批应答端（延迟 130 秒）时，主 agent 的 `run_code` 内 `read` 的 `approval/request` 到达应答端；子 agent 的 `run_code` 内 `read` 在 `approval/asked` 之后 0 毫秒 `approval/decided`，`outcome: rejected`，不经过 `approval/request`（`evidence/fix-cross-agent-observer.jsonl`）。同一 assistant step 里的两个 `run_code` 调用则由批次逐个执行（`evidence/fix-cross-run-observer.jsonl`），也不能证明跨运行不阻塞。
- 期望：无头 run 可以让子 agent 等待审批，以便在一个进程内验证锁的范围。
- 处理：单元测试 `F1a an approval pending in one agent does not block run_code in another agent` 覆盖；`docs/hosts/dsh.md`「自定义执行器要补的行为」记录事实；桌面验收清单保留跨会话项。
## 2026-11-15 DSH 没有导出 PTC 会话事件的类型
- 状态：已解决（适配器用本地结构类型）
- 现象：`dsh-session` 的类型不含 `tool/ptc-dispatch(-start)`，适配器写这两类事件只能通过本地的结构类型转换（`plugins/code-mode/dsh/src/dispatch-log.ts`）。
- 期望：类型导出与 PTC 执行器写入的事件一致。
- 处理：转换集中在 `dispatch-log.ts`，写入失败只记警告。升级 DSH 时核对 `dsh-tool-executor-ptc/src/types.ts` 的字段。
## 2026-11-15 工具在执行中自己申请审批，等待超过 120 秒时整个 `run_code` 超时
- 状态：已解决（适配器监听 `approval/request` 与 `user-questions/request`）
- 现象：桌面 0.2.2-rc.3、权限模式「仅可查看」下，`run_code` 里 `bash({ sandbox_permissions: "workspace-write", justification })` 弹出审批，未回答。2 分 4 秒后回合以 `Code run timed out after 120000 ms` 结束，面板消失，文件未创建。无头复现见 `.agents/tasks/code-mode-dsh/wf/evidence/fix2-repro-before-*`。上一轮的暂停只覆盖 `tools/pre-execute` 的 `ask` 与名单里的工具，这个审批由 bash 工具本体在 `tools/execute` 里通过 `approveEscalation` 请求（`approval/asked` 在 `tools/execute` 开始之后 1 毫秒）。
- 期望：与原生 bash 一样，等待审批不消耗运行超时。
- 处理：见 `docs/hosts/dsh.md` 与 ADR 0004 第 13 条。教训：宿主里「会等用户」的路径不止一条，按工具名或按阶段单点覆盖会漏；应监听宿主的请求事件。
## 2026-11-15 审批面板不显示子调用的命令
- 状态：未解决（DSH 界面行为，规避：把命令写进 `justification`）
- 现象：`run_code` 内 `bash` 的审批面板只有「允许本次操作使用 workspace-write 权限：approval test」，上方一行「正在运行命令 · touch marker」，没有命令本身。会话日志里 `tool/ptc-dispatch-start` 带 `arguments.command`，`approval/asked` 带子调用 id，事件不缺。`ApprovalCommand.tsx` 只在对话根节点里按 `callId` 查找，子调用挂在父节点下，查不到。
- 期望：子调用的审批与原生调用一样显示命令。
- 处理：记入 README「限制」与差异第 18 项。DSH 自带 PTC 执行器同样受影响（来自源码，未运行）。不在插件里改写 `displayReason`：那会改变用户看到的内容并修改其他监听也读取的请求，需要产品决定。

## 2026-11-16 客户端 bundle 放在 preset 内的包里不会被加载
- 状态：已规避（界面拆成独立的部署层包 `mcp-ui`，见 ADR 0006）
- 现象：同一个包既声明 `dsh.client` 又被挂在 `preset-code-mode` 里，设置页没有出现注册的标签页；同样的 bundle 放进挂在部署层的独立包，立即出现。
- 原因：客户端模块系统只扫描宿主 Loader 的条目（`dsh-client-modules` 的 `ctx.loader.entries()`），preset 内的行不在其中。这是根据源码和对照实验的推断，没有文档明说。
- 处理：浏览器端界面一律放在独立包里，行挂在部署层。

## 2026-11-16 cordis 4.1.0 没有 optional inject
- 状态：已规避
- 现象：想让 `code-mode-dsh` 在没有 `mcpParallel` 服务时也能激活。`fiber.ts` 的 `_refresh` 要求 `inject` 列出的每个服务都存在，否则插件不激活，`registry.ts` 没有 optional 标记。
- 处理：不把 `mcpParallel` 写进 `inject`，每次判定时用 `ctx.get('mcpParallel')` 查找，没有就当不并行。

## 2026-11-16 普通 preset 下无法对模型隐藏被禁用的 MCP 工具
- 状态：未解决（宿主限制，已在界面和文档里写明）
- 现象：`mcp-ui` 可以拒绝对被禁用工具的调用（`tools/pre-execute`），Code Mode 下还能在 `code-mode` 里把它从说明文字里去掉；DSH 自带执行器的 preset 下，模型仍会在工具列表里看到它，调用时才被拒绝。
- 原因：DSH 隐藏单个工具的支持机制是注册时的 `when` 条件，MCP 工具由 `dsh-mcp-client` 注册，不传任何选项；`tools.restrict` 只能在 agent 作用域调用，部署层插件用不了。
- 处理：只拒绝不隐藏。要完整支持，需要 `dsh-mcp-client` 给注册开放 `when`，或 DSH 提供全局的工具可见性过滤。

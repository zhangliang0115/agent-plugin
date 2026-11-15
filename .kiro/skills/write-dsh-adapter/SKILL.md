---
name: write-dsh-adapter
description: 写或修改 DSH（DeepSeek Harness）插件的 adapter，例如注册工具、挂 tool executor、拦截 tools/pre-execute。用于新建 plugins/<id>/dsh、升级 DSH 版本后重新核对、或排查 dump-config 与真实会话行为不一致。关键词：DSH 插件、Cordis、dsh adapter、tool executor、run_code、setExecutor、dump-config、dsh plugin add、headless。
---

# 写 DSH adapter

这份步骤来自 `plugins/code-mode/dsh`（issue #5）的实际实施。宿主事实见 `docs/hosts/dsh.md`，规范见 `docs/conventions.md`。每步的检查点都要跑，不要跳过。

## 1. 核对版本

- 查本机版本：`"<dsh>" --version`，`<dsh>` 为 DSH 命令的路径（macOS 桌面版：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）。预期输出与 `docs/hosts/dsh.md` 的核对版本一致。
- 查宿主包版本：`npm view @deepseek-ai/dsh-tools@<ver> peerDependencies`。peer 版本要与宿主一致，精确写入。
- 如果本机版本比 `docs/hosts/dsh.md` 记录的旧，先停下来告诉用户，不要静默升级。

## 2. 建包

- `plugins/<id>/dsh/package.json`：`peerDependencies` 精确写宿主包；`devDependencies` 放同版本的宿主包（用于类型和测试），外加 `esbuild`；`dsh.bundle.patch` 指向 `./cordis.patch.yml`；`files` 只列 `dist` 与 `cordis.patch.yml`。
- 运行时依赖（例如 `quickjs-emscripten`、`acorn`）写进 `dependencies`，并在构建脚本的 `external` 中列出。
- `pnpm install --registry=https://registry.npmjs.org`。用户的 npm 镜像偶尔超时，见 `friction.md`。

## 3. 先写契约测试，再写实现

- 用 `test/fake-context.ts` 的模式：一个最小的 Cordis 替身，实现 `tools`（`executable`、`schemas`、`checkGuards`、`setExecutor`）、`waterfall`、`events`、`logger`、`get`、`effect`、`systemPrompt.getSectionOrder`。替身把每次 waterfall 的事件名记入 `trace`。
- 流水线用 `@deepseek-ai/dsh-tools/pipeline` 的真实 `ToolExecutionPipeline`，不要自己复制。
- 至少要有这些断言：
  - 子调用的 trace 顺序为 `tools/pre-execute` → `guard` → `tools/execute` → 工具本体 → `tools/post-execute`；
  - 子调用的 `parent` 等于外层调用的 `token`；
  - pre-execute 返回 `deny` 时，工具本体不执行，程序里能 catch 到错误；
  - 模型直接调用非入口工具时被 `reject`。
- 自定义执行器还要补原生批次替它做的事，每项一个会先红的测试（事实见 `docs/hosts/dsh.md`「自定义执行器要补的行为」）：独占工具分组（`pipeline.executionMode`）、`tool/ptc-dispatch(-start)` 会话事件、`concludesTurn` 转发、`result.error.info` 的错误身份、大输出走 `spillStore`。
- 凡是会等待用户的路径（审批、`ask_user_question`、`exit_plan_mode`），测试要证明：不持有跨 agent 的锁，也不被整体超时取消。路径不止流水线的 `ask`：bash、write、edit 在工具本体里调用 `ctx.approval.request`，computer-use 工具调用 `user-questions/request`。测试里的假工具要在 `execute` 内发起请求，经替身的 `waterfall` 触发 `approval/request` / `user-questions/request`，而不是靠 `tools/pre-execute` 返回 `ask`（后者测不到工具内部的等待）。同时保留「卡住的工具仍会超时」的对照测试。
- 观察等待要用宿主事件（`ctx.on('approval/request' | 'user-questions/request', listener, { prepend: true })`），不要按工具名。必须 `prepend`，否则应答端先返回，监听不会运行。
- 先跑一次，确认红（模块不存在或断言失败），再写实现。

## 4. 挂载执行器

- 入口 `apply(ctx)` 中只调用一次 `ctx.tools.setExecutor(executor)`。同一 scope 第二次调用会抛错。
- 注册的 `ctx.effect(() => () => dispose, label)` 用于释放资源。
- 在 `cordis.patch.yml` 中禁用会争抢同一 scope 的 executor（`tool-executor-native`，PTC 默认已禁用）。

## 5. 构建与打包

- `pnpm run build` 生成 `dist/index.js`（esbuild 单文件 ESM，`external` 包含 `@deepseek-ai/*`、`cordis` 和运行时依赖）。
- `pnpm pack --pack-destination /tmp/<dir>`，检查 tgz 只含 `dist`、`package.json`、`cordis.patch.yml`。
- 安装用 tgz，不用目录：`"<dsh>" plugin --profile <profile> add <tgz>`。目录安装会链接，不解析 peer，导致加载开发副本（见 `friction.md`）。

## 6. 组合树检查

- `"<dsh>" --profile <profile> --dump-config`。
- 确认插件行存在，被禁用的行显示 `disabled: true`。
- 如果插件加载了但没有效果，先看这一步。行不在是组合问题，行在是代码问题。

## 7. 真实会话验证

- 无头模式：`"<dsh>" --profile <profile> --json "<task>"`。注意：`headless` 是模板名，`--profile <p> headless` 会被当作任务文本，进程无输出挂起。
- `--json` 只输出外层工具调用。要证明子调用经过流水线，用一个只观察的测试插件（`ctx.on('tools/pre-execute' | 'tools/execute' | 'tools/post-execute', ...)`，写 JSONL 文件，不改决定）装进测试 profile，跑完后卸载。这个探针不要放进仓库。
- 测试 profile 必须与桌面版的网关路由一致（headless 模板默认是 DeepSeek 官方 API）。
- 要验证审批等待，观察插件在 `ctx.on('approval/request', ...)` 里延迟返回 `allowed-once`。两条路径都要测：让指定工具的 `tools/pre-execute` 返回 `{ kind: 'ask' }`（流水线路径），以及不强制 `ask`、把会话权限设成只读（`DSH_PERMISSION_MODE=read-only`）后调用 `bash({ sandbox_permissions: "workspace-write", justification })`（工具内部路径）。无头模式下子 agent 的审批会被立即拒绝，跨 agent 的阻塞无法在无头复现，改用单元测试覆盖，其余交给桌面手动验收。
- 观察插件用 `pnpm pack` 的 tgz 安装（`dist/index.js` + `package.json`），用完随测试 profile 一起删除。

## 8. 收尾

- 同一任务里更新 `plugins/<id>/INSTALL.md`（包名、入口、版本变化都要同步），并按它真实执行一遍。
- 文档与实际不符的地方，先记 `friction.md`，再改 `docs/hosts/dsh.md`。

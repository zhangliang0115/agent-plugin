# 0005 对外发布的 npm scope 与包名
- 状态：已接受；发布范围被 [0007](0007-server-and-web-package-types.md) 修订（独立 server 包也发布）
- 日期：2026-11-16
- 取代：无
- 关联：[issue #3](https://github.com/zhangliang0115/agent-plugin/issues/3)、[issue #4](https://github.com/zhangliang0115/agent-plugin/issues/4)

## 背景

插件要对外发布到 npm。此前两个包是 workspace 内部名（`@agent-plugin/code-mode-*`），`private: true`，没有 `publishConfig`，也不确定 core 是否单独发布。

## 决策

1. **npm scope 用 `@zhangliang0115`**，与 GitHub 用户名一致。本机 npm 未登录，发布前要确认该 scope 属于发布者；如果 npm 账号名不同，只改 scope 前缀。
2. **只发布宿主 adapter**：`@zhangliang0115/code-mode-dsh`。adapter 的 `dist/index.js` 是 esbuild 打出的单文件，core 的代码已经包含在里面，所以 core 不单独发布。
3. **core 保持 `private: true`**，名字统一为 `@zhangliang0115/code-mode-core`。workspace 内部名与将来的发布名一致，发布前不需要改名。
4. **包名结构**沿用 `docs/conventions.md` 的 `<scope>/<id>-<host>`，core 为 `<scope>/<id>-core`。
5. **构建工具沿用 esbuild**（`plugins/code-mode/dsh/scripts/build.mjs`），不引入第二个工具。`files` 只含 `dist` 与 `cordis.patch.yml`。core 不发布，因此不需要单独的编译产物和 `.d.ts`；将来若单独发布 core，再补 `tsc --emitDeclarationOnly`（这是 issue #3 的结论）。
6. `publishConfig.access` 设为 `public`。

## 影响

- 包名变化：`@agent-plugin/code-mode-*` → `@zhangliang0115/code-mode-*`。从 tgz 安装的命令不变；从 npm 安装时用新包名。
- `cordis.patch.yml` 的 `name` 必须与包名一致，改名时同步改。
- 发布流程（npm 登录、版本 tag、CI）不在本 ADR 范围。

## 备选

- `@agent-plugin/*`：需要先在 npm 上创建组织，未准备。
- 不发布，只用本地 tgz 分发：用户选择发布，不采用。

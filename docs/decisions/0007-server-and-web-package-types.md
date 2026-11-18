# 0007 新增 server 与 web 包类型

- 状态：提议
- 日期：2026-11-18
- 取代：无
- 关联：设计依据在 learn-ai 仓库 `claude-code/自建设计/` 01–05；下一步写 `plugins/repl-server/docs/protocol.md`

## 背景

现有插件形态只有「core + 宿主 adapter」：core 放业务逻辑，每个宿主一个薄 adapter，依赖方向 `adapter → core → portable`（ADR 0002）。插件装在宿主里运行，没有独立进程。

`repl-server` 不符合这个形态：

- 它是**独立进程**。Claude Code、Cursor 等客户端通过 MCP 协议连接，不依赖任何宿主 SDK，装法是在客户端里写一条 MCP 配置，没有 adapter 代码可写。
- 它带 **Web 管理界面**（配置第三方 MCP server、查看调用记录），和 MCP 端点同进程，分 `/mcp` 与 `/admin` 两个命名空间。

现有的 `plugins/*/{core,claude-code,dsh,pi}` 目录结构和 `pnpm-workspace.yaml` 的 glob 都覆盖不了这两类包。直接建目录会让 `pnpm validate` 报「缺少 plugin.meta.json」；而 meta 的 `hosts` 字段描述的是宿主适配情况，与独立 server 无关。

## 决策

1. **新增两种包类型**：
   - `plugins/<id>/server/`：可独立运行的 MCP server 包（Node 进程，stdio 或 HTTP）
   - `plugins/<id>/web/`：管理前端包（构建产物由 server 托管）
2. **`pnpm-workspace.yaml` 增加两条 glob**：`plugins/*/server`、`plugins/*/web`。
3. **包名**：server 包为 `<scope>/<id>`（插件主体就是 server，不再加 `-server` 后缀）；web 包为 `<scope>/<id>-web`；core 保持 `<scope>/<id>-core`（`private`）。
4. **依赖方向**：`server → core → portable`。`web` 不 import core，只消费 server 暴露的 HTTP API；web 的构建产物由 server 以静态资源托管，两者独立构建、同进程部署。
5. **发布**：server 包发布到 npm（它是用户实际运行的产物），web 产物打进 server 的 `dist`，不单独发布。ADR 0005 的「只发布宿主 adapter」相应扩展为「发布宿主 adapter 与独立 server 包」。
6. **`plugin.meta.json`**：server 类插件的 `hosts` 写 `{}`，不加新字段；`pnpm matrix` 里该插件的宿主列显示 `—`。`scripts/validate.ts` 与 `scripts/matrix.ts` 不改。
7. **构建**：沿用 esbuild 单文件产物（ADR 0005），server 与 web 各自一个 `scripts/build.mjs`。

## 后果

- `repl-server` 可以按仓库规范建目录，`pnpm validate` 与 `pnpm matrix` 不会因为新目录失败。
- 能力矩阵里会出现一个所有宿主列都是 `—` 的插件。读者需要知道这是 server 类插件；如果这类插件变多，再考虑加 `kind` 字段并在矩阵里标注。
- web 与 server 共用一个版本号（同一个 `plugin.meta.json` 的 `version`），构建产物要一起升。
- 需要同步的文档：`docs/conventions.md` 的命名表加 server/web 两行；`docs/architecture.md` 的分层图与插件目录加这两类。
- `pnpm-workspace.yaml` 的 glob 变多，pnpm 安装时多扫两个目录，无实际成本。

## 备选方案

- **做成 core + `claude-code/` adapter**：没有 adapter 代码可写，目录会是空的，不符合「adapter 是宿主扩展点实现」的定义。
- **放进 `packages/`**：`packages/` 是跨插件共享的中立契约（portable），repl-server 是独立产品，不是共享库。
- **单独建 `servers/` 顶层目录**：仓库以 `plugins/` 作为产品单位，再开一层会让「一个插件一个版本号」的规则分裂。
- **server 包名加 `-server` 后缀**：`@zhangliang0115/repl-server-server` 重复且难读。

# 架构

决策依据见 [ADR 0002](decisions/0002-portable-core-host-adapters.md)，宿主事实见 [hosts/](hosts/)。

## 分层

```text
plugins/<name>/
  core/          业务逻辑。只依赖 packages/portable 和普通 npm 包
  claude-code/   Claude Code 插件目录（manifest + skills/hooks + MCP server 入口）
  dsh/           Cordis 插件包（apply(ctx) + cordis.patch.yml）
  pi/            Pi 扩展包（export default (pi) => ...）
  server/        独立进程的 MCP server 包（ADR 0007）；入口 bin，产物 dist
  web/           管理前端包（ADR 0007）；构建产物由 server 托管，private
packages/
  portable/      跨插件共享的中立契约（按需增长）
scripts/         validate、matrix 等仓库脚本
```

依赖方向只能向下：`adapter → core → portable`；server 类插件是 `server → core → portable`，`web` 不 import core，只消费 server 的 HTTP API。core 和 portable 不知道宿主存在。

## 插件目录

```text
plugins/<name>/
  README.md            做什么、支持哪些宿主、限制；安装部分只链接到 INSTALL.md
  INSTALL.md           每个支持的宿主一节，给 agent 逐条执行（规则见 conventions.md「安装文档」）
  CHANGELOG.md
  plugin.meta.json     元数据，矩阵和校验脚本读它
  core/                package.json + src/ + test/
  <host>/              package.json + src/ + test/（Claude Code 另有插件目录结构）
  server/              package.json + src/ + test/ + scripts/build.mjs（ADR 0007）
  web/                 package.json + src/ + scripts/build.mjs（产物复制进 server/dist/web）
```

只为实际要支持的宿主建 adapter 目录。不支持的宿主在 `plugin.meta.json` 里写原因。server 类插件的 `hosts` 写 `{}`，矩阵里宿主列显示 `—`。

### plugin.meta.json

```json
{
  "id": "example",
  "version": "0.1.0",
  "description": "一句话说明",
  "hosts": {
    "claude-code": { "status": "supported", "components": ["skill", "mcp"] },
    "dsh": { "status": "supported", "components": ["tool", "tools/pre-execute"] },
    "pi": { "status": "unsupported", "reason": "依赖的 xxx 在 Pi 上没有对应扩展点" }
  }
}
```

`status` 取值：`supported`、`experimental`、`unsupported`。

## 契约规则

1. **core 不 import 宿主 SDK**，也不读宿主配置文件。需要宿主能力时，由 adapter 以参数或接口的形式传进来。
2. **core 必须能脱离宿主进程运行**。Claude Code 上它跑在 MCP server 或 hook 脚本里。
3. **宿主差异写在 adapter 里，不写在 core 里**。core 里不出现 `if (host === ...)`。同一能力在不同宿主上行为差异大到需要分支时，拆成独立插件。
4. **adapter 保持薄**：只做参数/结果格式转换、注册、打包。判断逻辑下沉到 core。
5. **portable 只在出现第二个使用者时才加东西**。一个插件独用的抽象留在该插件的 core 里。

## 能力矩阵

`docs/capability-matrix.md` 是生成物，由 `pnpm matrix` 从所有 `plugin.meta.json` 生成，不手改。`pnpm matrix:check` 检查生成结果与提交内容一致。仓库目前没有 CI，需要手动运行。

## 测试分层

| 层 | 测什么 | 怎么跑 |
|---|---|---|
| core 单元测试 | 业务逻辑 | `node --test`，不依赖宿主 |
| 仓库脚本测试 | `validate`、`matrix` 的校验规则、生成内容、`--check` 行为 | `node --test`，fixture 在 `scripts/test/fixtures/` |
| adapter 契约测试 | 注册了什么、参数/结果转换是否正确 | 用该宿主 API 的最小 fake，不启动宿主 |
| server 协议契约测试 | `server/discover`、tasks、工具结果形状 | `node --test` + fixture MCP server，不启动真实客户端 |
| 宿主冒烟 | 真实宿主能加载并调用 | 按 `docs/hosts/<host>.md` 的本地验证命令，结果贴进 PR 或交付说明 |

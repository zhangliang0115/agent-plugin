# 开发规范

## 工具链

- Node `>=22.19`，pnpm（版本见根 `package.json` 的 `packageManager`）。
- TypeScript，ESM（`"type": "module"`）。
- 测试用 `node --test`（Node 原生支持 TS 类型擦除）。
- 构建工具（发布 npm 需要产出 JS）随第一个要发布的包一起决定，写 ADR。

## 命名

| 对象 | 规则 | 例子 |
|---|---|---|
| 插件 id / 目录名 | kebab-case；不以 `claude-`、`anthropic-` 开头 | `code-mode` |
| workspace 包名 | `@agent-plugin/<id>-<host>`，core 为 `@agent-plugin/<id>-core` | `@agent-plugin/code-mode-dsh` |
| 宿主目录名 | 固定为 `claude-code`、`dsh`、`pi` | |
| 工具名（给模型看） | snake_case，跨宿主一致 | `run_code` |

对外发布的 npm 包名和 scope 在第一次发布时决定（见 [open-questions](open-questions.md)）。

## 版本

- 每个插件一个 semver 版本，`plugin.meta.json`、各宿主 manifest 和包的 `package.json` 保持一致。
- 0.x 阶段允许破坏性变更，但要写进 CHANGELOG。
- 改了某个宿主的锁定版本，同时更新 `docs/hosts/<host>.md` 的核对版本。

## 提交

- 格式：`<type>(<scope>): <描述>`，描述可用中文。
- type：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`。
- scope：插件 id，或插件 id/宿主，或仓库区域（`docs`、`scripts`、`portable`）。例：`feat(code-mode/dsh): 注册 run_code 工具`。
- 一个提交只做一件事；文档变更和它描述的代码变更放在同一个提交。
- 未经用户确认不 commit、不 push。

## 依赖与安全

- 不提交密钥、`.env`、真实 token。
- 运行时依赖锁定精确版本。宿主提供的包（如 Pi 的 `@earendil-works/*`、DSH 的 `@deepseek-ai/*`）按各宿主笔记处理，不要重复打包。
- 插件访问网络必须在插件 README 里写明目标主机，并且地址可配置。
- 发布包用 `files` 白名单，不发布整个目录。

## 文档职责

开发中产生的信息放到固定位置，不留在聊天记录里：

| 信息 | 位置 |
|---|---|
| 在方案之间做了选择 | `docs/decisions/NNNN-*.md`（规则见 [decisions/README](decisions/README.md)） |
| 宿主 API 的事实 | `docs/hosts/<host>.md` |
| 宿主/工具行为与预期不符、规则不好用 | `friction.md` |
| 尚未决定的问题 | `docs/open-questions.md`；决定后删掉该条，结论写进 ADR 或对应文档 |
| 插件的用法、安装、限制 | `plugins/<id>/README.md` |
| 插件的版本变更 | `plugins/<id>/CHANGELOG.md` |
| agent 需要遵守的规则 | `AGENTS.md`（唯一来源） |

## 新增一个插件

1. 写 `plugins/<id>/README.md` 和 `plugin.meta.json`。
2. 写 core 和它的失败测试，再写实现。
3. 每个支持的宿主：写 adapter 契约测试 → 实现 → 按宿主笔记做一次冒烟。
4. 更新 CHANGELOG，重新生成能力矩阵。

## 新增一个宿主

1. 按模板写 `docs/hosts/<host>.md`，并在 `docs/hosts/README.md` 登记。
2. 写 ADR，说明为什么支持、锁定哪个版本。
3. 在每个已有插件的 `plugin.meta.json` 里加上该宿主（`supported` 或 `unsupported` + 原因）。

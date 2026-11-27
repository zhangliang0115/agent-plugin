# agent-plugin

给多个 coding agent（Claude Code、DSH、Pi）开发插件的仓库。每个插件拆成宿主无关的 core 和每个宿主一个薄 adapter。本文件是给所有 agent 的唯一规则来源；`CLAUDE.md` 等宿主专用文件只引用它。

## 目录地图

| 路径 | 职责 |
|---|---|
| `plugins/<id>/` | 一个插件：`core/` + 每个支持的宿主一个 adapter 目录 |
| `packages/portable/` | 跨插件共享的中立契约（按需增长） |
| `scripts/` | 仓库脚本（validate、matrix） |
| `docs/architecture.md` | 分层、目录、契约规则、测试分层 |
| `docs/conventions.md` | 工具链、命名、界面文案、版本、提交、依赖安全、文档职责 |
| `docs/hosts/` | 每个宿主的扩展机制事实和本地验证命令 |
| `docs/decisions/` | 决策记录（ADR） |
| `docs/issues.md` | 用 GitHub Issues 管理需求、调研、问题反馈的规则 |
| `docs/capability-matrix.md` | 插件 × 宿主矩阵（生成物） |
| `friction.md` | 宿主、工具、规则的摩擦记录 |
| `.kiro/skills/` | 开发本仓库用的 skill（Kiro 与 Claude Code 共用；`.claude/skills` 是指向它的软链接） |

## 命令

```bash
pnpm install
pnpm test          # 仓库脚本测试（node --test）+ 所有 workspace 包的测试
pnpm typecheck     # tsconfig.json（scripts/）+ 所有 workspace 包的类型检查
pnpm validate      # 校验 plugins/*/plugin.meta.json
pnpm matrix        # 从 plugin.meta.json 重新生成 docs/capability-matrix.md
pnpm matrix:check  # 矩阵与提交内容不一致时非零退出
git status && git diff
```

宿主相关的验证命令见 `docs/hosts/<host>.md`。

## 架构规则

- 依赖方向：`adapter → core → portable`。core 和 portable 不 import 宿主 SDK，不读宿主配置。
- core 里不写 `if (host === ...)`；宿主差异只在 adapter 里处理。
- adapter 只做格式转换、注册和打包，判断逻辑放在 core。
- 写某个宿主的 adapter 之前，先读 `docs/hosts/<host>.md`；发现它与实际不符，先记 `friction.md`。
- `packages/portable` 只在第二个使用者出现时才加抽象。

## 工作方式

- 开工先写「完成标准」；交付时逐条对照，给出命令输出或文件路径，不要只说「做完了」。
- 需求不清时，先列出最不确定的问题（最多 3 个），等回答再改文件。
- 涉及多个目录、删除文件、新增依赖或修改 portable 契约的改动：先用不超过 5 行列出改哪些文件、各改什么、怎么验证，等用户确认。单文件的小改动可以直接做。
- 先写会失败的测试，再写实现。提交前跑 `pnpm test`。
- 改动影响插件的安装方式（包名、入口、manifest、配置项、宿主版本、支持的宿主）时，同一个提交里更新 `plugins/<id>/INSTALL.md`，交付时贴出它的验证命令输出。规则见 `docs/conventions.md`「安装文档」。
- server 类插件的可分发产物（`dist`）改完要发布：`pnpm build && pnpm release`，只 build 不 release 等于没交付。规则见 `docs/conventions.md`「发布产物」。
- 报错贴原文：命令、完整输出（堆栈前 20 行）、期望结果。

## 记录规则

结论写进仓库，不留在聊天里。放在哪里见 `docs/conventions.md` 的「文档职责」一节，常用的几条：

- 方案选择 → 新 ADR（`docs/decisions/`），并更新索引
- 宿主 API 事实 → `docs/hosts/<host>.md`，带来源和核对日期
- 需求、问题反馈、还没决定的事 → GitHub issue（`gh issue create`，规则见 `docs/issues.md`）。用户提到但没说现在做的事，直接建 issue 记下来
- 开发某个 issue 前，它必须是 `status:ready`（只由用户设置）；提交信息写 `Refs #n` / `Closes #n`
- 踩坑 → `friction.md`

## 禁令

- 不提交密钥、`.env`、真实 token。
- 未经用户确认不 commit、不 push。
- 不手改生成物（`docs/capability-matrix.md`）。

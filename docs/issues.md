# 需求与问题管理（GitHub Issues）

需求、调研、问题反馈、待决问题都记成 GitHub issue：<https://github.com/zhangliang0115/agent-plugin/issues>。issue 是待办清单；结论仍然写进仓库（ADR、`docs/hosts/`、`friction.md`），issue 里只放链接。

> 仓库是公开的，issue 内容所有人可见。不要在 issue 里写密钥、内部地址或不能公开的信息。

## 类型

| 标签 | 用途 | 模板 |
|---|---|---|
| `type:plugin` | 新插件或插件功能 | 新插件 / 插件功能 |
| `type:host` | 新增或调整宿主支持 | 新宿主 / 宿主支持调整 |
| `type:research` | 调研、需要做选择的问题 | 调研 / 待决问题 |
| `type:bug` | 问题反馈：插件、脚本、规范的行为与预期不符 | 问题反馈 |
| `type:infra` | 仓库基础设施：脚本、规范、CI | 空白 issue，手动加标签 |

辅助标签：`host:claude-code`、`host:dsh`、`host:pi`（涉及哪些宿主），`priority:high`、`priority:low`（不加就是普通优先级）。

## 状态

每个 open 的 issue 恰好有一个 `status:*` 标签。

```text
status:idea ──► status:researching ──► status:ready ──► status:in-progress ──► 关闭
     │                                     ▲                    │
     └──────── 不需要调研 ─────────────────┘                    └─► status:blocked（写明原因）
任意状态 ──► 加 wontfix 后关闭（决定不做）
```

| 状态 | 含义 | 谁改 |
|---|---|---|
| `status:idea` | 刚记下，未评估。模板会自动加上 | 创建时自动 |
| `status:researching` | 正在调研 | agent，开始调研时 |
| `status:ready` | **用户确认可以开工** | **只能由用户设置** |
| `status:in-progress` | 正在开发 | agent，开始开发时 |
| `status:blocked` | 被外部因素卡住，评论里写明卡在哪 | agent 或用户 |

`status:ready` 是开工的闸门：agent 不能自己把 issue 改成 ready，也不能在 issue 不是 ready 时开始开发，除非用户在对话里明确要求。

## Agent 怎么用

所有操作用 `gh`（已登录）。

**记录**：用户在对话里提到一个需求、问题或想法，但没说现在做时，建一个 issue：

```bash
gh issue create --title "[plugin] <标题>" --label "type:plugin,status:idea" --body "<按对应模板的字段写>"
```

**调研**：
1. `gh issue edit <n> --remove-label status:idea --add-label status:researching`
2. 调研报告贴成 issue 评论（`gh issue comment <n> --body-file <file>`）。
3. 结论按「文档职责」落到仓库：方案选择写 ADR，宿主事实写 `docs/hosts/`。在评论里附上链接。
4. 调研结束后在评论里写「建议：可以开工 / 不做 / 需要用户决定 X」，然后停下等用户。不要改成 ready。

**开发**：
1. 用户说「做 #n」时，先 `gh issue view <n> --comments` 读内容和调研结论。不是 `status:ready` 的，先问用户。
2. 完成标准从 issue 里取；缺的先补到 issue 正文，再开工。
3. `gh issue edit <n> --remove-label status:ready --add-label status:in-progress`
4. 提交信息带 `Refs #n`；完成该 issue 的提交写 `Closes #n`，推送到 main 后自动关闭。
5. 交付时在 issue 里评论：改了什么、验证命令输出、提交号。

**问题反馈**：复现后在 issue 里贴复现结果。复现不了的写明尝试过的步骤，加 `status:blocked` 等用户补充。修复时先写能复现的失败测试。

## 与其他记录的关系

| 记录 | 放什么 | 和 issue 的关系 |
|---|---|---|
| issue | 要做的事、过程讨论 | 待办 |
| `docs/decisions/` | 已做出的选择 | 调研类 issue 的产出，issue 链接到它 |
| `docs/hosts/` | 宿主事实 | 调研产出，issue 链接到它 |
| `friction.md` | 踩坑记录（知识） | 需要后续修的坑另开 `type:bug` issue，互相链接 |
| `plugins/<id>/CHANGELOG.md` | 版本变更 | 条目里写 `#n` |

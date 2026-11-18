# 决策记录（ADR）

## 什么时候写

在多个方案之间做了选择，并且这个选择会影响以下任一项：

- 目录结构、分层、包的拆分
- 依赖、工具链、Node 版本
- 支持或放弃某个宿主、锁定宿主版本
- `packages/portable` 的公共契约
- 开发规范本身（AGENTS.md 里的规则）

只影响单个插件内部实现的选择，写在该插件的 README 里，不写 ADR。

## 怎么写

1. 文件名 `NNNN-短标题.md`，编号递增，不复用。
2. 已接受的 ADR 不改正文。要改变决策就写一份新的，在新文件里写 `取代：NNNN`，并把旧文件的状态改成 `已被 NNNN 取代`。
3. 提议中的 ADR 状态写 `提议`，确认后改成 `已接受`。
4. 写完更新下面的索引。

## 模板

```markdown
# NNNN 标题

- 状态：提议 | 已接受 | 已被 NNNN 取代
- 日期：YYYY-MM-DD
- 取代：（可选）

## 背景
（要解决什么问题，有哪些约束；引用 docs/hosts/ 或 friction.md 里的事实）

## 决策
（具体做什么）

## 后果
（好的、坏的、需要后续跟进的）

## 备选方案
（每个方案一行：是什么，为什么没选）
```

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-base-framework.md) | 先做宿主无关的基础框架 | 已被 0002 取代 |
| [0002](0002-portable-core-host-adapters.md) | 可移植核心 + 宿主薄 adapter | 已接受 |
| [0003](0003-scripts-toolchain.md) | 仓库脚本用 TypeScript 直接运行，不加构建步骤 | 已接受 |
| [0004](0004-code-mode-dsh-design.md) | DSH 的 Code Mode：run_code、sealed QuickJS 沙箱、子调用走流水线 | 已接受 |
| [0005](0005-npm-scope-and-package-names.md) | 对外发布的 npm scope 与包名 | 已接受（发布范围由 0007 修订） |
| [0006](0006-dsh-mcp-ui.md) | DSH 的 MCP 管理界面：独立 UI 插件 + 逐工具并行勾选 | 已接受 |
| [0007](0007-server-and-web-package-types.md) | 新增 server 与 web 包类型 | 已接受 |

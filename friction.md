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

# agent-plugin

给多个 coding agent 开发插件的仓库。目标宿主：

| 宿主 | 插件形态 |
|---|---|
| [Claude Code](docs/hosts/claude-code.md) | 声明式插件目录；代码跑在 MCP server / hook / `bin/` |
| [DSH（DeepSeek Harness）](docs/hosts/dsh.md) | 进程内 Cordis 插件 |
| [Pi](docs/hosts/pi.md) | 进程内 TypeScript 扩展 |

每个插件拆成宿主无关的 `core/` 和每个宿主一个薄 adapter，见 [架构](docs/architecture.md)。

## 开发

需要 Node `>=22.19` 和 pnpm。

```bash
pnpm install
pnpm test
```

- 规范：[docs/conventions.md](docs/conventions.md)
- 决策记录：[docs/decisions/](docs/decisions/)
- 需求、问题反馈、待决问题：[GitHub Issues](https://github.com/zhangliang0115/agent-plugin/issues)，规则见 [docs/issues.md](docs/issues.md)
- 能力矩阵：[docs/capability-matrix.md](docs/capability-matrix.md)

## 状态

插件：

- [code-mode](plugins/code-mode/README.md)：DSH 中的 Code Mode（`run_code`），实验性，0.1.0。

能力矩阵见 [docs/capability-matrix.md](docs/capability-matrix.md)。

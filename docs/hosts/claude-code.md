# Claude Code

- 核对版本：2.1.327（本机 `claude --version`）
- 核对日期：2026-11-15
- 官方文档：<https://code.claude.com/docs/en/plugins-reference>
- 稳定性：稳定；manifest 未知顶层字段会被忽略并告警

## 插件形态

插件是一个目录。`.claude-plugin/plugin.json` 是 manifest（只有 `name` 必填，kebab-case），其他组件放在插件根目录的默认位置：

| 组件 | 默认位置 |
|---|---|
| Skills | `skills/<name>/SKILL.md` |
| Commands | `commands/*.md`（新插件优先用 skills） |
| Agents | `agents/*.md` |
| Hooks | `hooks/hooks.json` |
| MCP servers | `.mcp.json` |
| 可执行文件 | `bin/`（启用时加入 Bash 工具的 PATH） |

插件根目录的 `CLAUDE.md` 不会被加载，要给模型的说明放进 skill。所有组件都按插件名加命名空间，如 `<plugin>:<skill>`。

## 注册工具

插件不能在宿主进程里注册工具。工具通过插件自带的 MCP server 提供（`.mcp.json`），或者作为 `bin/` 下的命令由模型通过 Bash 调用。

## 拦截工具调用

`hooks/hooks.json` 里配置 `PreToolUse` / `PostToolUse` 等事件，执行外部命令。路径用 `${CLAUDE_PLUGIN_ROOT}`，shell 形式要加双引号。

## 打包与安装

- 分发通过 marketplace：仓库根目录 `.claude-plugin/marketplace.json` 列出插件。
- `name` 不能以 `claude-`、`anthropic-` 开头，也不能是保留名。

## 本地验证命令

```bash
claude plugin validate <plugin-dir>            # 校验 manifest、路径、MCP 配置
claude plugin validate --strict <plugin-dir>   # 告警也视为失败，CI 用这个
claude --plugin-dir <plugin-dir>               # 本地加载试用
```

## 本项目约定

- adapter 目录 `plugins/<name>/claude-code/` 本身就是插件根目录，能直接 `claude plugin validate`。
- 有运行时代码的能力一律做成 MCP server，入口调用 core。

## 已知问题

暂无。

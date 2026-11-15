# agent-plugin

跨 coding agent 的插件集。第一个插件是 **Code Mode**：模型不再逐个发工具调用，而是写一段 JavaScript，由插件在本地执行，代码里通过工具绑定调用宿主工具。

当前只做 Code Mode，不复制旧 `ai-plugin` 仓库的内容。

## 结构

```text
agent-plugin/
├── src/
│   └── code-mode/          # 平台无关 core
├── code-mode/
│   ├── claude-code/        # Claude Code adapter（MCP server + plugin）
│   └── dsh/                # DeepSeek Harness adapter（dsh bundle）
├── scripts/                # core 镜像 / drift check
└── test/                   # conformance
```

## 边界

- `src/code-mode/` 不知道宿主：只依赖 `{ callTool, listTools, session, log, sandbox }`。
- 每个 adapter 只做宿主集成：Claude Code 用 MCP，DSH 用 `ctx.tools` + `tools/pre-execute` 流水线。
- 提示词只写一份，adapter 只追加宿主特定段落。

## 安装

- Claude Code：`/plugin marketplace add zhangliang0115/agent-plugin`，再 `/plugin install code-mode@agent-plugin`。
- DSH：`dsh plugin --profile <profile> add "github:zhangliang0115/agent-plugin#path:/code-mode/dsh"`。

## 状态

骨架阶段。core 和两个 adapter 还没有实现。

## 旧项目

`~/workspace/personal/ai-plugin` 已废弃，保持原样不动。

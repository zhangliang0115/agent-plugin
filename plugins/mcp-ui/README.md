# MCP 设置页（mcp-ui）

在 DSH 桌面版的设置页增加「MCP」标签，用来管理 MCP 服务器，并设置每个工具是否支持并行。

## 做什么

- 列出 `mcp-manager` 中配置的服务器和未配置但仍在清理的服务器，显示实时状态与工具数。
- 每台服务器可以启停、重启、编辑、删除（删除需要二次确认）。
- 展开服务器可以探测工具列表，逐个勾选「支持并行」，或勾选「该服务器全部工具」（`mcp__<server>__*`）。
- 保存的并行名单写入本插件的配置项 `parallelTools`。Code Mode 读取它（经服务 `mcpParallel`）决定 `run_code` 子调用能否同时运行。
- 每个工具可以用「启用」勾选框禁用。被禁用的工具在任何预设下调用都会被拒绝（`tools/pre-execute`，拒绝文本为「工具 <name> 已被用户在 MCP 设置里禁用。」）。在 Code Mode 下它还会从模型的工具列表里隐藏。禁用名单保存在配置项 `disabledTools`，服务 `mcpDisabled` 供 Code Mode 读取。

## 限制

- 并行只在 Code Mode 预设下生效。其他预设使用 DSH 原生执行器，本插件不影响它们。
- 禁用在其他预设下只拒绝调用，不隐藏工具：原生执行器的工具注册没有按条件隐藏的选项，模型仍能看到被禁用的工具。
- 修改服务器会重建它的实例，期间它的工具短暂不可用。
- 服务器配置仍由 DSH 官方 `mcp-manager` 保存和校验，本插件不另存一份。
- 界面中的敏感值（env、headers）在列表中隐藏。建议用 `${credential:REF}` 引用凭据，不要粘贴明文。
- 客户端 bundle 能否被桌面版加载、界面的视觉效果，尚未在桌面版上验证（见 INSTALL.md）。

## 结构

| 路径 | 职责 |
|---|---|
| `core/` | 宿主无关的模型：服务器条目校验、并行名单、工具名解析、状态文案。纯 TS，`node --test` 测试。 |
| `dsh/src/index.ts` | DSH 宿主半部：配置 `parallelTools`（volatile）与服务 `mcpParallel`。 |
| `dsh/src/client/` | 浏览器半部：设置页与数据读写。打包为 `dist/client.js`。 |
| `dsh/cordis.patch.yml` | 部署层的插件行 `mcp-ui`，使客户端 bundle 被扫描加载。 |

安装步骤见 [INSTALL.md](INSTALL.md)。

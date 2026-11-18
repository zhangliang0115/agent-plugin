# 能力矩阵

> 生成物，不要手改。由 `pnpm matrix` 从 `plugins/*/plugin.meta.json` 生成；`pnpm matrix:check` 检查它与提交内容一致。

| 插件 | 版本 | claude-code | dsh | pi |
|---|---|---|---|---|
| code-mode | 0.5.0 | unsupported (Claude Code 的 Code Mode 是宿主内置功能（REPL 工具），本插件面向 DSH 的 tool executor 扩展点) | experimental (tool, tool-executor) | unsupported (尚未实现，Pi 的扩展点还未调研) |
| mcp-ui | 0.2.0 | unsupported (设置页是 DSH 桌面版的客户端扩展点，Claude Code 没有对应的界面) | experimental (settings-page, client-bundle, service) | unsupported (尚未调研 Pi 是否有可注册的设置页扩展点) |
| repl-server | 0.1.0 | — | — | — |

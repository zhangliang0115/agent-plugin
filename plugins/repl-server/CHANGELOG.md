# 变更记录

## 0.1.0（2026-11-18）
### 新增
- 初始化 server 类插件骨架：`core` / `server` / `web` 三个包，`plugin.meta.json` 的 `hosts` 为 `{}`（ADR 0007）。
- `server` 提供最小 HTTP 入口与 `GET /health`，默认 `127.0.0.1:8787`，为后续 MCP 端点与管理 API 预留同一进程。
- `web` 与 `server` 的 esbuild 构建脚本；`web` 产物后续复制进 `server/dist/web`。

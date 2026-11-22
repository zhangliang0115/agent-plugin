# 安装 repl-server

> server 类插件：没有宿主 adapter，按客户端分节。未在真实客户端上完整走通的节标注「未实测」。

## Claude Code

### 前置条件

- Node `>= 22.19`（检查：`node -v`）
- repl-server 已发布到 npm，或用本地 tgz

### 安装

在任意目录执行：

```bash
npm install -g @zhangliang0115/repl-server
```

本地开发时，在仓库根目录构建后用 `node plugins/repl-server/server/dist/index.js --port 8787` 启动。

### 启动

```bash
repl-server --port 8787
```

### 配置 MCP

在 Claude Code 的用户级或项目级 MCP 配置里加：

```json
{
  "mcpServers": {
    "repl": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <client-token>" }
    }
  }
}
```

`<client-token>` 在管理端 `POST /admin/api/clients` 创建后只返回一次。

### 验证

```bash
curl -s http://127.0.0.1:8787/health
```

预期：`{"ok":true,"version":"0.2.0"}`

（未实测）

## Cursor / 其他 MCP 客户端

与 Claude Code 相同：URL `http://127.0.0.1:8787/mcp`，`Authorization: Bearer <client-token>`。只支持 Streamable HTTP 的客户端不需要额外配置。

（未实测）

## 失败处理

- `EADDRINUSE`：端口被占用，换 `--port`。
- 401：token 未知或已撤销；重新创建绑定。
- 管理端打不开：确认 `admin-token` 与 `Host` 是 `127.0.0.1`/`localhost`。

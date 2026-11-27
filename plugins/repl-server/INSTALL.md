# 安装 repl-server

> server 类插件：没有宿主 adapter，按客户端分节。未在真实客户端上完整走通的节标注「未实测」。

## Claude Code

### 安装（推荐：Claude Code 插件）

插件在 learn-ai 仓库的 `cc-plugins/repl-server`：

```bash
claude plugin install repl-server@learn-ai
```

每次会话启动时插件检查 `http://127.0.0.1:8787/health`；没在跑就从 GitHub Release 下载预构建的 `dist`（`repl-server-<版本>.tar.gz`），校验同目录的 `.sha256` 后解压到 `$CLAUDE_PLUGIN_DATA/server/<版本>/`，再以 `--strict-auth` 后台启动，然后用 HTTP 连 `/mcp`。首次连接时在 `/mcp` 面板完成一次 OAuth 授权（见 `docs/protocol.md` §2.1）。

- 前置条件：Node `>= 22.19`；首次启动需要能访问 `github.com` 下载 release 资产。
- 版本：插件的 `plugin.json` 版本与本仓库的 `server/package.json` 版本必须相同，插件据此拼 release URL；`REPL_SERVER_VERSION` 可临时覆盖。
- 本地开发时设 `REPL_SERVER_DIST=/abs/path/to/dist/index.js` 指向本地构建，跳过下载。

### 手动安装与启动

从本仓库构建后直接运行：

```bash
node plugins/repl-server/server/dist/index.js --port 8787
```

发版时用 `node server/scripts/release.mjs` 把 `dist` 打成 release 资产（tag 为 `v<server 版本>`），插件据此下载。

### 远程访问（Tailscale 等）

默认只绑 loopback。绑定非 loopback 地址时必须同时开严格鉴权：

```bash
repl-server --host 0.0.0.0 \
  --allowed-hosts '*.ts.net,127.0.0.1,localhost' \
  --strict-auth
```

- `--allowed-hosts` 只放行列出的 `Host`，Tailscale 域名可写成 `*.ts.net`。
- 严格模式下 `/mcp` 必须带已注册的 client token；全局 `mcp-token` 和无 token 都返回 401。
- 管理端自动登录只对 loopback 请求生效：本机浏览器和 Tailscale Serve 转发的请求直接进入；直连 8787 的其他设备仍需 `/admin?token=<admin-token>`。
- MCP 客户端 URL 换成 `http://<node>.<tailnet>.ts.net:8787/mcp`，token 不变。
- 需要 HTTPS 时让 Tailscale Serve 终止 TLS（不影响已有的 443 规则）：

  ```bash
  tailscale serve --bg --https=8443 http://127.0.0.1:8787
  ```

  然后用 `https://<node>.<tailnet>.ts.net:8443/mcp`。服务本身只讲 HTTP，证书和 TLS 都由 Serve 处理。

### 配置 MCP

用上面的插件安装时不需要这一步（插件的 `.mcp.json` 已经连好，鉴权走 OAuth）。手动配置时，在用户级或项目级 MCP 配置里加：

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

预期：`{"ok":true,"version":"0.3.3"}`

（未实测）

## Cursor / 其他 MCP 客户端

与 Claude Code 相同：URL `http://127.0.0.1:8787/mcp`，`Authorization: Bearer <client-token>`。只支持 Streamable HTTP 的客户端不需要额外配置。

（未实测）

## 失败处理

- `EADDRINUSE`：端口被占用，换 `--port`。
- 401：token 未知或已撤销；重新创建绑定。
- 管理端打不开：确认 `Host` 在 `--allowed-hosts` 里；远程访问时还要在 URL 带 `?token=<admin-token>`。

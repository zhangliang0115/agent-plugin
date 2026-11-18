# 测试与验收

- 状态：v1 契约；实现按本文的命令验收，不用“手工点过”代替
- 分层依据：`docs/architecture.md` 的测试分层

## 命令

```bash
cd plugins/repl-server/core && npm test
cd plugins/repl-server/server && npm test
cd plugins/repl-server/web && npm run typecheck && npm run build
cd ../.. && node scripts/validate.ts
npm run matrix
```

真实 Claude Code 2.1.327 端到端（本轮已执行，结果见 learn-ai 05 §十）：

```bash
# HTTP：daemon 监听 127.0.0.1:8787，配置 {"mcpServers":{"repl":{"type":"http","url":"http://127.0.0.1:8787/mcp"}}}
claude -p "Call mcp__repl__run_script with {\"code\":\"return 6*7\"}" \
  --mcp-config /tmp/repl-e2e-cfg.json --dangerously-skip-permissions

# stdio：配置 command=node，args=[server/src/index.ts, --stdio, --url, http://127.0.0.1:8787/mcp]
claude -p "..." --mcp-config /tmp/repl-e2e-stdio.json --dangerously-skip-permissions
```

interactive TUI 冒烟：用 Terminal（或 kimi-cu）运行同一 `claude --mcp-config ...`，确认 `run_script({async:true})` 返回 taskId、`wait_tasks` 收到 completed；输入后需单独按回车。

## automated / manual / external

| 类别 | 内容 | 怎么跑 |
|---|---|---|
| automated | discover 形状、能力声明、task 决策表、tasks/get/cancel/update、content-only XML、双 id、binding/client、serial 锁、容量、TTL（注入时钟）、stdio stdout 纯净、审计脱敏 | `node --test` |
| manual | 终端按 Esc 触发 tasks/cancel、TUI 任务面板、管理端视觉与 3D 资源约束 | 按上面的 interactive 冒烟步骤人工执行，结果写进交付说明 |
| external | 真实 `claude mcp serve` 的 22 工具形状、真实第三方 MCP | `REPL_CLAUDE_BIN` 指向真实二进制；结果贴进交付说明 |

**不得用 skip 冒充通过。** 不能自动化的项归 manual/external，并在报告里写明没跑。

## 测试钩子

- `REPL_TEST_CLOCK`：可控时钟，测 TTL 与 idle 回收。
- `REPL_CAPACITY_*`：覆盖容量默认值，测试用缩小值。
- `REPL_CLAUDE_BIN`：fake serve 注入点；测试断言实际执行文件路径。
- 两者只在 `NODE_ENV !== "production"` 生效，生产默认不变。

## 验收矩阵（对应 04 §3.3）

| # | 场景 | 测试 |
|---|---|---|
| 1 | 声明 tasks + `timeout: 35000` | 契约测试 `tasks-create` |
| 2 | `timeout: 2000` 同步 | 契约测试 `tasks-sync` |
| 2a | `async: true` 返回 XML task 属性 | 结果契约 `async-envelope` |
| 3 | headless 不声明 | 契约测试 `headless-sync` |
| 4 | headless 不报错 | 同上 |
| 5 | Esc 取消 | manual |
| 6 | 重连取结果 / TTL 过期 | 契约测试（注入时钟） |
| 7 | 过期错误码 | 契约测试 |

## fixture

`test/fixtures/mcp-probe/` 保存了原始探测器；**必须另写一个合规 fixture**：默认按本次请求的 `clientCapabilities` 决定同步/任务，`--ignore-client-caps` 只用于复现坑 #5。原始文件不改成“修好”的版本，它是证据。

告警投递用假 webhook 走真实 HTTP：`server/test/fixtures/fake-webhook/server.ts` 只绑 `127.0.0.1`，按队列返回脚本化响应（最后一次重复），可用 `gate` 把请求保持在飞。`server/test/alerts-dispatch.test.ts` 用它覆盖成功、超时/网络错误、5xx/429、非 JSON、3xx 不跟随、`errcode`/45009 冷却与串行发送。只有 `NODE_ENV=test` 且 `REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK=1` 时才允许回环地址，生产仍校验企业微信域名。

懒加载发现用独立 fixture：`server/test/fixtures/discovery-mcp/server.mjs`，Node 内建模块起 Streamable HTTP MCP，暴露一个 `search_tools`（可选 `echo`），用 `--shape`、`--page-size`、`--invalid`、`--fail-search`、`--strict` 等 flag 控制响应形状、分页与失败模式；`GET /log` 是请求日志（用于断言顺序、预热缓存与并发），`GET /health` 做存活检查。`server/test/discovery-e2e.test.ts` 拉起该 fixture，覆盖发现解析、准备缓存、stale 与错误映射。

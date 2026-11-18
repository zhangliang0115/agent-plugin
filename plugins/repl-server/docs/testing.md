# 测试与验收

- 状态：v1 契约；实现按本文的命令验收，不用“手工点过”代替
- 分层依据：`docs/architecture.md` 的测试分层

## 命令

```bash
pnpm --filter @zhangliang0115/repl-server-core test
pnpm --filter @zhangliang0115/repl-server test
pnpm --filter @zhangliang0115/repl-server-web build
pnpm typecheck
pnpm validate
pnpm matrix:check
```

端到端（不启动 Claude Code）：

```bash
node plugins/repl-server/test/e2e/http.mjs      # daemon + Streamable HTTP
node plugins/repl-server/test/e2e/stdio.mjs     # stdio bridge
```

Claude Code 2.1.327：

```bash
node plugins/repl-server/test/e2e/claude-headless.mjs   # 自动
node plugins/repl-server/test/e2e/claude-interactive.md # 手工冒烟清单
```

## automated / manual / external

| 类别 | 内容 | 怎么跑 |
|---|---|---|
| automated | discover 形状、能力声明、task 决策表、tasks/get/cancel/update、content-only XML、双 id、binding/client、serial 锁、容量、TTL（注入时钟）、stdio stdout 纯净、审计脱敏 | `node --test` |
| manual | 终端按 Esc 触发 tasks/cancel、TUI 任务面板、管理端视觉与 3D 资源约束 | `test/e2e/claude-interactive.md` |
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

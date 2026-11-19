# 测试与验收

- 状态：v1 契约；实现按本文的命令验收，不用“手工点过”代替
- 分层依据：仓库 `../../../docs/architecture.md` 的测试分层

## 命令

在仓库根目录执行：

```bash
(cd plugins/repl-server/core && npm test)
(cd plugins/repl-server/server && npm test)
(cd plugins/repl-server/web && npm test && npm run typecheck && npm run build)
node scripts/validate.ts
npm run matrix
```

当前全量基线：`server` 757 个用例（全部通过）、`web` 40 个用例，0 skip。

窄范围（06–08）：

```bash
cd plugins/repl-server/server
node --test test/report-*.test.ts test/alerts-*.test.ts test/reports-e2e.test.ts
node --test test/discovery-*.test.ts
node --test test/ai-*.test.ts
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
| automated | discover 形状、能力声明、task 决策表、tasks/get/cancel/update、content-only XML、双 id、binding/clientName/clientVersion、serial 锁、容量、TTL（注入时钟）、stdio stdout 纯净、审计脱敏 | `node --test` |
| automated（06 报告/告警） | 报告落库/去重/限流、告警规则矩阵、假 webhook 投递、45009 冷却、关闭恢复；`reports-e2e` 走完整链路（真实 `assemble()` + `/mcp` + SQLite + 审计 JSONL） | `node --test test/report-*.test.ts test/alerts-*.test.ts test/reports-e2e.test.ts` |
| automated（管理端标签字典） | `GET/PUT /admin/api/tags`：未保存返回 26 条内置默认（来源、env.*、能力、产品）、旧 15 条完整默认（key/zh/en 全等且顺序一致）在读取时升级为新默认、同 15 个 key 但任一标签被改过或重排或自定义子集则原样保留、PUT 提交旧默认可与 GET 返回一致、显式空保持空、PUT 全量替换且保留其它 settings、`appendTagDictionary` 超 200 条抛 422、422 条目校验、缺 If-Match 400 / 过期 409、`readTagDictionary` 跳过坏条目、`appendTagDictionary` 只追加未知 key | `node --test test/admin-tags.test.ts` |
| automated（管理端分类字典） | `GET/PUT /admin/api/categories`：未保存返回 10 条闭集默认（与标签 key 不重叠）、旧 15 条完整默认（key/zh/en 全等且顺序一致）在读取时升级、同 15 个 key 但任一标签被改过或重排或自定义子集则原样保留、PUT 提交旧默认可与 GET 返回一致、显式空保持空、PUT 全量替换且保留其它 settings、`appendCategoryDictionary` 超 100 条抛 422、422 `INVALID_CATEGORIES`（含超 100 项）、缺 If-Match 400 / 过期 409 `REVISION_CONFLICT`、`readCategoryDictionary` 跳过坏条目、`appendCategoryDictionary` 只追加未知 key | `node --test test/admin-categories.test.ts` |
| automated（07 发现） | 解析 P-*、应用 D-*、端点 A-*、预热 R-*、fixture E2E | `node --test test/discovery-*.test.ts` |
| automated（08 AI） | runner argv/env/超时、proposal/annotation 校验（含建议字典项）、prompt v5 注入分类/标签字典与 env.* 禁止规则、标注标签合并保留、建议分类/标签与标注同事务落库、AI 路由与 limiter | `node --test test/ai-*.test.ts` |
| automated（客户端身份） | `clientInfo` 从 `_meta` 与 legacy `initialize` 两处读取；名称 128 码点、版本 64 码点、控制字符剔除、trim、缺 name 时两段为空；旧 `name/version` 标签按第一个 `/` 拆分 | `node --test test/client-info.test.ts` |
| automated（内置与官方工具目录） | `__builtin__` 5 个协议工具幂等种子、保留管理员字段、只补空字段、从 catalog 快照排除；`__official__` 懒同步（无 `claude` → notice、写库保留覆盖、按进程缓存、`force` 重跑、GET 200、POST refresh 202、`__builtin__` 拒绝刷新） | `node --test test/builtin-seed.test.ts test/official-sync.test.ts` |
| automated（会话概览） | 可见 server 过滤（enabled、非 builtin、binding 的 server/tag 白名单）、行格式与文本裁剪、无可见 server 文案、2KB 预算下从尾部截断且固定指引保留、`instructions` 的 MCP 段同步 | `node --test test/mcp-overview.test.ts` |
| automated（web） | SSE 重连/缺口/轮询回退（`api-stream`）、hash 路由与 `?server=` 过滤（`router`）、命令面板过滤（`palette`）、字典标签与选项解析（`dictionary`）、MCP 配置片段（`mcp-config`）、服务端行动作表（`server-actions`）、AI 提案输入与 apply body（`ai-proposal`）、工具 input schema 展平为参数行（`schema-doc`，含非对象/坏类型、循环、深度与行数上限）；8 组共 40 个用例，只测纯逻辑，不渲染 React 组件 | `cd plugins/repl-server/web && npm test` |
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

## 06–08 增量测试

### 报告与告警 E2E

`server/test/reports-e2e.test.ts` 覆盖完整链路：启动真实 `assemble()` HTTP server 与回环假 webhook，通过 `/mcp` 调 `report_problem`，断言 SQLite 落库、webhook 载荷与审计 JSONL；用例同时覆盖工具响应不等待投递、5xx 重试、关闭时 in-flight 回 pending、45009 冷却不误标 failed。除 `NODE_ENV=test` 与 `REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK=1` 两个测试钩子外，不替换 `src` 接缝。

其余用例按 service/handler 直接驱动：

- `server/test/report-*.test.ts`：`report-admin`（管理端点、状态机、游标）、`report-service`（落库、去重、限流）、`report-tool`（`report_problem` 校验与结果形状），用内存 DB 直接驱动 service/handler。
- `server/test/alerts-*.test.ts`：`alerts-config`（配置回退与坏 JSON）、`alerts-dispatch`（假 webhook 走真实 HTTP），覆盖成功、超时/网络错误、5xx/429、非 JSON、3xx 不跟随、`errcode`/45009 冷却与串行发送。

命令：

```bash
cd plugins/repl-server/server && node --test test/report-*.test.ts test/alerts-*.test.ts test/reports-e2e.test.ts
```

`alerts-dispatch.test.ts` 使用 `server/test/fixtures/fake-webhook/server.ts`，只在 `NODE_ENV=test` 且 `REPL_ALERT_WEBHOOK_ALLOW_LOOPBACK=1` 时允许回环地址。企业微信真实接口不在 automated 范围，归 external/manual。

### 懒加载发现矩阵

矩阵编号 P/D/A/R/E 见 learn-ai `claude-code/自建设计/07-懒加载工具扁平化.md` §9.2。命令：

```bash
cd plugins/repl-server/server && node --test test/discovery-*.test.ts
```

拆分：`discovery-parse`（P-*）、`discovery-config`（配置与导入/导出）、`discovery-service`（D-*/A-*）、`discovery-pool`（R-*）、`discovery-e2e`（E-*，拉起 `discovery-mcp` fixture 走 admin preview → apply → `run_script`）。R-10 的并发断言直接读 fixture 的 `GET /log`。

### AI 配置与标注

命令：

```bash
cd plugins/repl-server/server && node --test test/ai-*.test.ts
```

`ai-runner.test.ts` 用 `server/test/fixtures/fake-claude/fake-claude.mjs`（可执行，`#!/usr/bin/env node`）代替真实 `claude`：测试把临时绝对路径写入 `ai.claudeBin`，通过 runner 的 `extraEnv` 设 `FAKE_CLAUDE_MODE`。模式覆盖 `ok` / `fence` / `invalid` / `error` / `error-no-result` / `error-nonstring-result` / `huge` / `sleep` / `exit1` / `stderr-flood` / `payload` / `envelope`；`FAKE_CLAUDE_PAYLOAD` 注入任意 proposal/annotation，`FAKE_CLAUDE_PIDFILE` 供超时用例确认进程组已被杀。`ai-admin` 覆盖路由与 If-Match/状态码，`ai-propose` / `ai-annotate` 覆盖校验、预览、apply（含建议分类/标签与标注同事务入字典、标签合并保留）、过期与审计，`ai-apply-parse-server` 走真实 `parseCreateServer`，`ai-limiter` 覆盖 2 在跑 / 4 排队 / `AI_BUSY`。整个套件不发真实 `claude`、不访问网络。

### Web 页面

`web/test/*.test.ts` 用 `node:test`，不需要浏览器，当前覆盖八组纯逻辑：`api-stream` 覆盖 SSE 包装的 Last-Event-ID、缺口帧、重连与轮询回退，`router` 覆盖 hash 路由解析、`#/manage?tab=…` 归一化与工具页 `?server=` 过滤，`palette` 覆盖命令面板过滤，`dictionary` 覆盖字典标签与选项解析，`mcp-config` 覆盖 MCP 配置片段，`server-actions` 覆盖服务端行内动作表（builtin / disabled / ready / idle / failed / 进行中），`ai-proposal` 覆盖输入字节上限、`<secret:NAME>` 往返与 apply body 的 stdio/http 分支，`schema-doc` 覆盖嵌套对象/数组展平、enum/$ref/oneOf 类型标签、坏数据不抛错，以及循环、深度与行数上限。八组共 40 个用例，不渲染 React 组件；管理端页面行为仍归 manual。命令：

```bash
cd plugins/repl-server/web && npm test
```

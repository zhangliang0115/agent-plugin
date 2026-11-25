# 决策台账

每条分析发现按 `docs/triage.md` 的规则判定后登记在这里。状态变化时更新原行，不追加重复行。

## 2026-11-25 · 最近 24 小时请求日志分析（289 次请求 / 735 次工具调用 / 248 次 eval）

| 问题 | 分类 | 证据 | 决策 | 理由 | 状态 |
|---|---|---|---|---|---|
| 服务端 instructions 教模型用 `log()`，沙箱只有 `console` | IGNORE | `server/src/mcp/discover.ts:49`；02:55Z 一次 eval 以 `log is not defined` 失败；4 次 `console.log` 执行全部成功 | 不改提示词、不加沙箱别名、不加测试 | 裸 `log` 是 agent 对标准 API 的误用，不是平台缺陷；不为低频错误增加提示词和兼容层，方向转为内置高频库/函数 | 已忽略 |
| 审计日志把工具参数截断成 `[max-depth]` | FIX | 735 条 `tool_call` 中 174 条（23.7%）含该标记，ES 查询 range 条件丢失；138 次「重复调用」是截断假象 | 提高 `maxDepth` 至 16 并在截断处写显式标记，保留完整结构 | 请求详情丢失真实查询条件，审计数据不完整 | 已修 |
| 工具参数错误提示不含 schema | IMPROVE | 26 个失败 eval 中 8 个是参数形状错误（未知字段、缺必填）；13/13 参数错误失败前未查 schema，catalog schema 准确 | 在 `MCP_TOOL_ERROR` 中附该工具 inputSchema 的字段名与必填项 | 本仓库可做，能让模型一次改对 | 已修 |
| initialize 协议版本门禁曾拒绝真实客户端 | IGNORE | 11-24 09:51Z–11-25 04:11Z 共 8 次 `-32600`；当前代码已回退 legacy，窗口后无复发；`docs/protocol.md:99-103` 已写明 legacy 走 `initialize`、`server/discover` 只接受 modern | 无需改动 | 代码已修复，文档已覆盖 | 已完成 |
| tool 事件的 `mcp` 字段与同 eval 的请求会话不一致 | IGNORE | 707/735 条 tool 事件的 mcp 是 exec 创建传输，bound 客户端按 binding 复用；管理端不按该字段过滤 tool 事件 | 不修改、不补文档 | 仅诊断字段，无实际误用证据；补文档不产生行为收益 | 已忽略 |
| 空闲期子进程 RSS 增长约 198MB | INVESTIGATE | 空闲 14.6 小时总量从 233MB 涨到 431MB，重启回落；根因未定 | metrics 记录 per-child 前 5；childRss > 1 GiB 写 memory_warning，每小时最多一次 | 证据不足以定位，直接改可能修错对象；不依赖人盯，事后可按事件查询 | 观测中 |
| Sentry 400 不带上游响应体 | IGNORE | 400 文本 290–328 字符，只有状态行与 MDN 链接；根因在 sentry MCP server | 转 sentry 对应仓库处理，repl-server 不代修 | 不在本仓库责任边界内 | 已忽略 |
| 是否内置高频库/函数 | INVESTIGATE | 225 份脚本/执行代码中通用库使用近零：`JSON.parse` 183 份（标准内置）、`Promise.all` 31、`Date` 14；`fetch` 可用且 2 次执行均成功；无 lodash/moment 类需求 | 暂不内置，继续观察重复出现的手写模式（分页、重试、并发池） | 缺高频证据，提前加库只增加维护面 | 待观察 |

## 2026-11-25 · 全树代码审查（15 条 important）

| 问题 | 分类 | 证据 | 决策 | 理由 | 状态 |
|---|---|---|---|---|---|
| 资源采样 command 持久化明文 argv | FIX | `server/src/admin/resources.ts` 写入 metrics 时 `redact:false`，secrets 解析后 argv 含明文 | `command` 只保留前 3 token 并 `redactValue` | 避免密钥写入 90 天 metrics 与 `/overview` | 已修 |
| 审计帧丢失 result 错误标记 | FIX | `server/src/audit/runtime.ts` 在 result 外置前未保留 `isError`，列表与 `result=error` 筛选判不出失败 | 外置前写 `index.resultIsError`；`pairResult` 与 Web 详情回退读取 | 审计详情把失败请求显示为成功 | 已修 |
| 脱敏遗漏 | FIX | `core/src/audit/redact.ts` URL fragment/userinfo 未脱敏、带引号凭据键不匹配、bearer 大小写敏感 | 补 URL 与凭据规则；`SECRET_KEY` 排除计数类字段 | 密钥可进入 90 天审计 | 已修 |
| 定时器与后台任务异常未捕获 | FIX | `server/src/assembly.ts` 三个 `setInterval` 与 retention/session-prune/health 的异步回调未 catch | `timerGuard` 包裹；各任务补 catch 与限频 warn | 单次失败可成 unhandled rejection 拖垮进程 | 已修 |
| 子进程与标准流错误未监听 | FIX | `pool/adapters/stdio.ts`、`serve/client.ts`、`index.ts` 缺 `error` 监听 | 补监听；server `error` 记录后退出 | 无监听的 error 事件直接终止进程 | 已修 |
| 原型链写入与查找 | FIX | ledger/meta/discovery/ai-validate/frames 动态键赋值；registry、`schema-args`、labels、tag-color 原型链查找 | 写入改 `defineProperty`（enumerable），查找改 `Object.hasOwn` | `__proto__`/`constructor` 可污染数据或绕过必填校验 | 已修 |
| payload 路径与读取校验 | FIX | `core/src/audit/payload.ts` 未拒绝 `..`；limit/offset 非安全整数；整读后切片；临时名可碰撞 | 分段白名单、safe integer、open+stat+定向 read、临时名加 UUID | payload 读取可越界或错位 | 已修 |
| 接口数值参数未校验 | FIX | scripts、script-candidates、reports、audit query、search、resources 的 limit/version/intervalMs | 统一 `Number.isSafeInteger` + 范围；非法值 400 或 RangeError | NaN/Infinity/负数导致查询不受限或返回错切片 | 已修 |
| LIKE 通配符未转义 | FIX | `db/scripts.ts`、`scripts/service.ts` 搜索参数直接进 LIKE | 转义 `%`/`_`/`\` 并加 `ESCAPE '\'` | 搜索 `100%` 会匹配全部或报错 | 已修 |
| 字节与 UTF-16 长度混用 | FIX | `summarize` 按 `length` 计预算；候选代码上限按字符；描述截断按 code unit 切 | summarize 与候选代码按 UTF-8 字节；描述按码点截断，保留 400 字符语义 | 中文/emoji 超预算或被切成坏字符 | 已修 |
| 媒体与 HTTP 响应无上限 | FIX | `exec/gateway.ts` 媒体只在结算时截断，循环可累积；`pool/adapters/http.ts` 整读响应无上限 | 收集时按 8 图/4 文档截断，超限只留指纹；HTTP 16 MiB 上限（含 SSE） | 单次 eval 或上游响应可耗尽内存 | 已修 |

## 2026-11-25 · 全树代码审查（1102 comments）待设计项

A 类直接修，C 类暂不做，本节只记录 B 类。

| 主题 | 分类 | 证据 | 决策 | 状态 |
|---|---|---|---|---|
| Admin 认证/会话面 | INVESTIGATE | loopback 自动登录无 Origin 校验、session 无上限、缺 Secure、token 打印 stderr、`DELETE /mcp` 在 `resolveIdentity` 前 | 先设计认证模型，再改实现 | 待设计 |
| 进程回收/终止 | INVESTIGATE | `kill.ts` 用 stale lstart、`residue.ts` 阻塞 `ps`、`tree.ts` 把 ps 失败当进程死亡、`keeper.mjs` 提前 exit | 需真实进程复现，先设计方案 | 待设计 |
| Web 请求竞态 | IMPROVE | 9 个页面 `load()` 无序号/Abort；`PayloadViewer` 条件 hook | 先设计共享 useLatestRequest，再批量替换 | 待设计 |
| audit writer 轮转/错误恢复 | FIX | stream `error` 后不重建，当天审计静默丢失 | 明确丢失/重建语义后再改 | 待设计 |
| 发布配置 | INVESTIGATE | 无 prepack/license/exports、构建未 minify | 按发布计划处理 | 待定 |
| 风格/死代码/重复 helper/a11y | IGNORE | 嵌套三元、死模块、重复常量 | 暂不做，按清理批次处理 | 已搁置 |
| 测试缺口 | INVESTIGATE | `candidate-suggester`、`doc-facts`/`doc-admin` 无测试 | 改动前先补测试 | 待办 |

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

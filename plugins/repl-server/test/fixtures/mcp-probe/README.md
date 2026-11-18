# mcp-probe fixtures

从 2026-11-18 的探测器原样保存，作为协议回归的起点。来源与结论见 learn-ai `claude-code/自建设计/04-测试与踩坑记录.md`。

| 文件 | 说明 |
|---|---|
| `server.mjs` | 80 行 HTTP MCP server，实现 discover / tools/list / tools/call / tasks/get |
| `cfg.json` | Claude Code 的 MCP 配置样例 |
| `requests.sample.jsonl` | 一次交互式会话与一次 headless 会话的请求日志 |
| `ext-schema.ts` | 2026-07-28 tasks 扩展的 schema 摘录 |

**注意**：`server.mjs` 对未声明 tasks 的客户端也返回 task，违反规范的 MUST，只用于验证客户端消费路径。契约测试要另写一个检查声明的 fixture，不要直接改这个文件来“修好”它——它也是踩坑 #5 的证据。

# 术语

| 术语 | 含义 |
|---|---|
| Code Mode | 模型写 JavaScript 调用工具的运行模式 |
| `REPL` / `run_code` | 承载代码的工具；输入 `{ code }`，输出 `<repl-output>` |
| sealed VM | 隔离的 JS 上下文；没有 `import`/`require`/`process`，只能通过注入的工具访问外界 |
| prelude | 在 VM 里预先注入的运行时辅助，如 `$`、`self.log`、`preview` |
| 工具绑定 | 把宿主工具包装成代码里的 async 函数 |
| `self.log` | 把一行写入 `<log>` 的辅助函数 |
| `console.tail(n)` | 读取 console ring buffer 的最后 n 条 |
| `preview(value, n)` | 截断长输出，只返回前 n 个字符 |
| `<repl-output>` | `REPL` 调用的结果信封：`<log>` + `<result>`/`<error>` |
| detached script | 超过阈值仍在跑的脚本；继续运行，与后续脚本共享变量 |
| `(dispatched #N)` | 长脚本先返回的回执，结果稍后异步到达 |
| seam | 宿主提供的能力槽位，如 `tools`、`sandbox`、`session` |
| waterfall | DSH/Cordis 的事件链，监听器必须 `await next()` |
| `tools/pre-execute` | DSH 工具执行前的 allow/deny/审批钩子 |
| `presentAs: 'code'` | DSH 的工具呈现模式：只把 `run_code` 暴露给模型 |
| PTC | DSH 内置的“模型写程序批量调用工具”模式，和 Code Mode 思路重叠 |

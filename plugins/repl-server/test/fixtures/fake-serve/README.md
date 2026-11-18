# fake-serve — fake `claude mcp serve`（stdio）

RST-T07 测试替身。默认按真实 `claude mcp serve` 的方式工作：stdio 上的换行分隔 JSON-RPC，stdout 只写协议帧，日志写 stderr。行为是确定性的：不执行真实 shell 命令、不联网，只在显式调用 `Read`/`Edit`/`Write` 时读写文件。

| 文件 | 作用 |
|---|---|
| `server.mjs` | fixture 本体（ESM，仅 Node 内置模块） |
| `smoke.mjs` | 冒烟：`child_process` 启动，调用 `initialize`/`tools/list`/`Bash`/`Read`/`Edit`，验证干净退出 |
| `README.md` | 本文 |

## 工具清单（22 个）

来自 learn-ai `claude-code/自建设计/01-Code Mode 工具桥与自建实现.md` §2.1 的 2.1.326 实测清单，顺序一致：

| 类别 | 工具 |
|---|---|
| 文件执行 | `Bash` `Read` `Edit` `Write` `NotebookEdit` |
| 网络 | `WebFetch` `WebSearch` |
| 编排 | `Agent` `Workflow` `SendMessage` `ListAgents` `TaskStop` |
| 会话 | `Skill` `EnterWorktree` `ExitWorktree` `Monitor` |
| 定时 | `CronCreate` `CronDelete` `CronList` `ScheduleWakeup` |
| 其他 | `ToolSearch` `ReportFindings` |

**没有 `Grep` / `Glob`**：01 §2.2 说明 Claude Code 默认就不暴露这两个工具（用 `Bash` + `rg` 代替）。因此本 fixture 若接到“22 个工具名”的断言，不应期待 `Grep`/`Glob`。

## 启动

```bash
node test/fixtures/fake-serve/server.mjs
```

- stdin：每行一个 JSON-RPC 请求或通知，空行忽略。
- stdout：每行一个 JSON-RPC 响应；通知（无 `id`）不产生响应。解析失败回 `-32700`。
- stderr：带 `[fake-serve]` 前缀的生命周期与调用日志；`--quiet` 关闭。
- stdin EOF：处理完在飞调用后自然退出，退出码 0。

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--delay-ms <n>` | `0` | 每个 `tools/call` 在返回前延迟 n ms（模拟慢调用） |
| `--crash-after <n>` | 不崩溃 | 处理第 n 个 `tools/call` 时直接 `SIGKILL` 自己：不写响应、不写 JSON-RPC 错误帧，父进程看到 signal（对应 01 §2.5 的 serve 崩溃行为） |
| `--ignore-sigterm` | 关 | 收到 `SIGTERM` 只记日志并继续运行，用于测 kill 升级 |
| `--http-port <n>` | 不启用 | 额外提供 HTTP JSON-RPC 通道，仅供手工 `curl` 验证；`0` 表示随机端口（实际端口写 stderr）。**不是** MCP Streamable HTTP 实现 |
| `--quiet` | 关 | 关闭 stderr 日志 |
| `--verbose` / `--debug` | 关 | 额外记录入站帧（截断 500 字符） |
| `--help` / `-h` | — | 用法写 stderr |

`mcp` / `serve` 两个位置参数会被忽略，其它位置参数只记日志；这样可以直接把 fixture 包一层后作为 `REPL_CLAUDE_BIN` 使用（见文末）。未知 `--` 选项报错退出码 2。

### 支持的方法

`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`notifications/cancelled`。其它方法返回 JSON-RPC `-32601`；数组形式的批量请求返回 `-32600`。

- `initialize` 回显请求里的 `protocolVersion`（缺省 `2025-11-25`），`serverInfo = { name: "fake-serve", version: "2.1.327" }`，声明 `capabilities.tools`。
- `tools/list` 返回上表 22 个工具，每个带 `description` 与最小 `inputSchema`。
- `notifications/cancelled`：若被取消的请求正处于 `--delay-ms` 或 `sleep` 等待中，立即停止等待并回 `-32800 Request cancelled`。

## 工具返回形状

### Bash

参数 `{ command }`（必填）。命令是**模拟**的，不执行 shell：

| command | 行为 |
|---|---|
| `echo TEXT` | stdout = `TEXT\n`（成对的单/双引号会剥掉） |
| `echoerr TEXT` | stderr = `TEXT\n` |
| `pwd` | stdout = fixture 进程 cwd + `\n` |
| `sleep N` | 等待 N 秒（可小数），然后空输出成功 |
| `exit 0` | 空输出成功 |
| `exit N`（N≠0） | `isError: true`，正文 `Exit code N`（不是 JSON） |
| `crash` | 立即 `SIGKILL` 自己，不返回 |
| 其它 | 空输出成功（命令本身不执行） |

成功响应（对应 01 §2.3 实测形状）：

```json
{"content":[{"type":"text","text":"{\"stdout\":\"hi\\n\",\"stderr\":\"\",\"interrupted\":false,\"isImage\":false,\"noOutputExpected\":false}"}]}
```

非零退出（对应 01 §6.4）：

```json
{"content":[{"type":"text","text":"Exit code 3"}],"isError":true}
```

### Read

参数 `{ file_path, offset?, limit? }`。成功时 `content[0].text` 是 JSON：

```json
{"type":"text","file":{"filePath":"/tmp/t.txt","content":"hello world\nsecond line\n","numLines":3,"startLine":1,"totalLines":3}}
```

- `file.content` 是原始文件文本，**不带行号前缀**（按 01 §2.3 的实测样本；行号由工具桥自行渲染）。
- `numLines` 按 `content.split("\n")` 计数，所以以换行结尾的 2 行文件得到 3。
- 文件不存在、是目录时返回 `isError: true` 的纯文本。

### Edit

参数 `{ file_path, old_string, new_string, replace_all? }`。

- **读状态机**：同一进程内必须先 `Read` 过该文件，否则返回 01 §2.4 的实测错误：`Tool Edit input is invalid: File has not been read yet. Read it first before writing to it.`
- `old_string` 不存在：`Tool Edit input is invalid: String to replace not found in file.\nString: <old_string>`。
- 成功时真实改写文件，返回：

```json
{
  "filePath": "/tmp/t.txt",
  "oldString": "world",
  "newString": "there",
  "originalFile": "hello world\nsecond line\n",
  "structuredPatch": [
    {"oldStart":1,"oldLines":2,"newStart":1,"newLines":2,
     "lines":["-hello world","+hello there"," second line"]}
  ],
  "userModified": false,
  "replaceAll": false
}
```

`structuredPatch` 是标准 unified diff hunk 数组（行首字符 ` ` / `-` / `+`），按 3 行上下文分组；`replace_all: true` 会做全部替换并合并到相应 hunk。

### Write

参数 `{ file_path, content }`。自动建父目录、写文件，返回与 `Read` 相同的 `{ type, file: {...} }` JSON。

### 其余 18 个工具

`NotebookEdit`、`WebFetch`、`WebSearch`、`Agent`、`Workflow`、`SendMessage`、`ListAgents`、`TaskStop`、`Skill`、`EnterWorktree`、`ExitWorktree`、`Monitor`、`CronCreate`、`CronDelete`、`CronList`、`ScheduleWakeup`、`ToolSearch`、`ReportFindings` 返回确定性的占位 JSON：

```json
{"tool":"WebSearch","arguments":{"query":"x"},"fake":true}
```

它们只保证“名字在列表中、返回形状是 content-only”，不模拟真实语义。未知工具名返回 JSON-RPC `-32602`。

## 冒烟

```bash
node test/fixtures/fake-serve/smoke.mjs
```

覆盖 9 项：`initialize` 形状、22 工具清单（且无 `Grep`/`Glob`）、Bash 成功 JSON、Bash 非零退出、Read 的 `file.content`、Edit 的 read-state 错误、Edit 的 `structuredPatch` 与落盘、stdout 纯净/stderr 有日志、stdin EOF 退出码 0。通过时最后一行是 `smoke: PASS (9 checks)`，任何失败退出码 1。

`--delay-ms` / `--crash-after` / `--ignore-sigterm` 不在冒烟里跑，需要时单独验证，例如：

```bash
# 第 1 次 tools/call 时进程被 SIGKILL（shell 报 Killed，退出码 137）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"Bash","arguments":{"command":"echo hi"}}}' \
  | node test/fixtures/fake-serve/server.mjs --crash-after 1
```

## curl 验证（HTTP 辅助通道）

fixture 的正式契约是 stdio；HTTP 模式只是为了满足“能独立启动并用 curl 验证”的检查，**不是** Streamable HTTP，也没有 `Mcp-Session-Id`。

```bash
node test/fixtures/fake-serve/server.mjs --http-port 8799 &
curl -s http://127.0.0.1:8799/health
# {"ok":true,"pid":...,"mode":"http","tools":22}

curl -s -X POST http://127.0.0.1:8799/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -s -X POST http://127.0.0.1:8799/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s -X POST http://127.0.0.1:8799/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Bash","arguments":{"command":"echo curl-ok"}}}'
# result.content[0].text 为 {"stdout":"curl-ok\n",...}
```

HTTP 模式只监听 `127.0.0.1`，请求体上限 1 MiB，只处理 `GET /health` 与 `POST /mcp`；通知返回 202。日志仍写 stderr，stdout 无输出。

## 接入 repl-server（REPL_CLAUDE_BIN）

`REPL_CLAUDE_BIN` 需要一个可执行文件，最省事的是放一个只做转发的壳：

```sh
#!/bin/sh
exec node /绝对路径/test/fixtures/fake-serve/server.mjs "$@"
```

`chmod +x` 后：

```bash
REPL_CLAUDE_BIN=/绝对路径/fake-claude node test/e2e/stdio.mjs
```

fixture 会忽略壳透传的 `mcp serve` 与 `--debug`/`--verbose`，所以不需要在壳里删参数。

## 边界

- 不复刻 serve 的 14 步 Edit 校验、mtime 快照、部分视图标记，只保留最关键的 read-before-edit 状态机。
- Bash 不执行命令、不读文件内容，避免测试引入真实副作用；需要真实命令时使用真实 `claude`。
- 不实现 resources/prompts/logging/tasks；真实 `claude mcp serve` 也不声明 tasks。
- 不支持 JSON-RPC 批量请求（MCP 2026-07-28 同样不支持）。

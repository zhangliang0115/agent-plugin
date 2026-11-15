# Code Mode：官方文档

来源：<https://code.claude.com/docs/en/code-mode>（2026-11-15 读取）

## 状态

- 实验性功能，默认关闭。
- 可能在任意版本改动或移除。

## 它怎么工作

没有 Code Mode 时，模型逐个发 `Bash`、`Read`、`Edit` 等工具调用，读每次结果再决定下一步。

有 Code Mode 时，模型写一段 JavaScript，由 Claude Code 执行。一段代码可以：

- 并行跑多个命令；
- 用上一个调用的结果做下一个调用；
- 只把需要读的那部分输出返回给模型。

对话里看到的是工具调用（如编辑的 diff），不是代码。按 `Ctrl+O` 打开 transcript，代码以折叠的 **Code** 行出现。

## 适合的任务

- 同一种改动重复很多文件；
- 搜索结果需要先过滤再读；
- 多个独立命令可以并行。

## 限制

- **恢复**：Code Mode 会话只能在终端里、且 Code Mode 开启时恢复。
- **auto 模式**：分类器审的是代码，不是每个工具调用。
- **长脚本**：不转后台时，要等它跑完，最多 10 分钟。
- **hooks**：`PreToolUse` 跑不了或超时时，工具调用会被拒绝；`UserPromptSubmit` 可以拦代码输出。
- **不可用功能**：Remote Control、Claude in Chrome、computer use。
- **移动会话**：不能移到 Desktop app，不能转后台会话，`/fork` 不能启动后台副本。

## 要求

| 项 | 要求 |
|---|---|
| 版本 | Claude Code v2.1.323 或更高 |
| 账号 | Claude 订阅或 Console 账号；**不能走 gateway、Bedrock、Claude Platform on AWS、Google Cloud Agent Platform、Microsoft Foundry** |
| 组织 | 不使用 HIPAA 配置或 zero data retention |
| 模型 | Claude Opus 5.5、Sonnet 5.5、Haiku 5.5 或 Fable 5.2 |
| 运行面 | 终端里的交互式 `claude`；不支持 `-p`、Agent SDK、VS Code 面板、Desktop app、云会话 |
| 安装 | 原生构建 |
| Windows | 需要 Git for Windows |

另外，以下设置会让 Code Mode 无法启动：`apiKeyHelper`、agent teams、OpenTelemetry 导出、`DISABLE_TELEMETRY`。

## 开启

在 shell 或用户设置里设置：

```bash
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude
```

或 `~/.claude/settings.json`：

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1"
  }
}
```

项目里的 `.claude/settings.json` 会被忽略，仓库不能替用户打开 Code Mode。

首次启动会弹出确认框，选择 **Yes, turn on Code Mode**。之后 Claude Code 重启，顶部显示：

```text
Code Mode (experimental) is on · this session can be resumed only with Code Mode on
```

## 恢复

恢复 Code Mode 会话时，`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` 必须仍然是 `1`。关闭后 Claude Code 拒绝恢复该会话。没有用 Code Mode 启动的会话，即使变量开着，也按普通会话恢复。

## 关闭

从 shell 和 `~/.claude/settings.json` 移除变量，或设为 `0`。一处为 `0`，即使另一处为 `1`，也保持关闭。

## 组织级禁用

在 managed settings 里写：

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "0"
  }
}
```

已经进入 Code Mode 的用户，退出或重启后才会离开。

## 权限

- 代码里的每个工具调用仍然走 `deny` / `ask` 规则和 `PreToolUse` hooks。
- **auto 模式**：分类器审整段代码，不审每个调用；它看不到运行时才产生的值（比如从搜索结果里拿到的路径）。
- **其他权限模式**：代码不经过分类器，按每个工具调用原本的规则弹窗。
- 想检查代码本身，写一个匹配 `REPL` 的 `PreToolUse` hook，读 `tool_input.code`。
- 后台运行代码需要 auto 或 `bypassPermissions` 模式。

## 长脚本

- **等待**：模型在代码跑完后才回复；代码最多 10 分钟，包含等待权限提示的时间。
- **后台**：模型可以继续对话；代码最多跑 2 小时。需要会话以 auto 或 `bypassPermissions` 启动。

## 排错

| 提示里包含 | 处理 |
|---|---|
| `it isn't open to your account yet` | 版本低于 2.1.323 就升级；否则检查网络，隔天再试 |
| `it only works with the Anthropic API` | 去掉云厂商、gateway、自定义 `ANTHROPIC_BASE_URL` |
| `it doesn't work with an API key helper` | 去掉 `apiKeyHelper`、`ANTHROPIC_AUTH_TOKEN`、`Authorization`/`X-Api-Key` 自定义头；然后登录或设 `ANTHROPIC_API_KEY` |
| `it only works with Opus 5.5, Sonnet 5.5 and later models` | 换成支持的模型，如 `--model opus` |
| `it doesn't work in background jobs` | 前台启动，去掉 `--remote-control` |
| `it needs settings that Claude Code downloads from Anthropic` | 去掉 `DISABLE_TELEMETRY` 等关闭 feature flag 拉取的变量 |
| `OpenTelemetry is on` | 去掉 `CLAUDE_CODE_ENABLE_TELEMETRY`、`ENABLE_BETA_TRACING_DETAILED` |
| `it doesn't yet work with an installed mod` | 关掉检查工具调用的 mod |
| `it can't be used together with agent teams yet` | 去掉 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` |
| `this launch's tool options` | 去掉 `--restricted`，把 `REPL` 加进 `--tools`，从 `--disallowedTools` 和 deny 规则里移除 |
| `couldn't save your answer` | 让 `~/.claude.json` 可写 |
| `your organization's settings don't allow it` | 问管理员 managed setting |

## 官方文档没写的

- `run_code` / `REPL` 的内部实现；
- 输出 XML 的具体形状；
- 持久 VM 的细节；
- 门控 flag 的名字。

这些在 [claude-code-source.md](claude-code-source.md) 里整理。

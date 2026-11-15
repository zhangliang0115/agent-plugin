# Code Mode 参考

面向要在 DSH 里实现 Code Mode 的开发人员。假设你没用过 REA，也没读过 Claude Code 源码。

## 一句话

Code Mode = 模型不逐个发工具调用，而是写一段 JavaScript；插件在本地执行这段代码，代码里通过工具绑定调用宿主工具，只把最终结果和日志返回给模型。

一次 `run_code` 调用 = 一次模型往返。代码内部执行几十次工具调用，不额外消耗模型往返。

## 文档

| 文件 | 内容 |
|---|---|
| [official-docs.md](official-docs.md) | 官方定义、要求、限制、权限、排错 |
| [claude-code-source.md](claude-code-source.md) | Claude Code 2.1.325 内部实现：工具面、VM、输出协议、生命周期、门控 |
| [dsh-implementation.md](dsh-implementation.md) | 在 DSH 里怎么落地：`ctx.tools`、`tools/pre-execute`、`presentAs` |
| [glossary.md](glossary.md) | 术语 |

## 证据来源

- 官方文档：<https://code.claude.com/docs/en/code-mode>（2026-11-15 读取）
- Claude Code 2.1.325 原生二进制（2026-11-13 构建，git sha `a360e7297ecfcddeae9ec99fb3c93153ed86aca4`）
- DSH 宿主事实：本仓库 `docs/hosts/dsh.md`（0.1.0-rc.7 至 0.2.1-rc.2 的公开文档）

标记约定：

- **【文档】**：官方文档原文或直接摘要。
- **【源码】**：Claude Code 二进制里直接读到的字符串或代码。
- **【推断】**：根据上述材料推断，未逐行验证。

## 最短路径

1. 先读 `official-docs.md`，知道它是什么、官方怎么限制。
2. 再读 `claude-code-source.md`，知道内部怎么实现。
3. 最后读 `dsh-implementation.md`，按步骤在 DSH 里实现。

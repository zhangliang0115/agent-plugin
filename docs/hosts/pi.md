# Pi

- 核对版本：未在本机核对
- 核对日期：2026-11-15
- 官方文档：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- 稳定性：较稳定；要求 Node `>=22.19`

## 插件形态

扩展是 TypeScript 模块，在 Pi 进程内以完整系统权限运行，通过 jiti 加载，不需要预先编译：

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
export default function (pi: ExtensionAPI) { /* 可以是 async */ }
```

自动发现位置：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目，需信任项目）。`/reload` 热重载。

## 注册工具

`pi.registerTool({ name, label, description, parameters, execute })`，`parameters` 用 TypeBox 或 JSON Schema。

- 修改文件的工具要用 `withFileMutationQueue()`，否则会和内置 edit/write 并发冲突。
- `promptGuidelines` 必须写出工具名，不要写"this tool"。
- 有状态的工具把状态放进结果的 `details`，在 `session_start` / `session_tree` 时从当前分支重建。

## 拦截工具调用

`pi.on('tool_call', (event, ctx) => ...)`，返回 `{ block: true, reason }` 可阻止调用。

## 其他扩展点

`pi.registerCommand`、`pi.registerShortcut`、`pi.registerMcpServer`、`pi.registerProvider`、`ctx.ui`（交互与自定义 TUI）。另支持 skills、prompt 模板、主题。

## 打包与安装

Pi package 通过 npm 或 git 分发，`pi install` 安装。运行时依赖必须放在 `dependencies`；宿主提供的包（`@earendil-works/*`、`typebox`）不要列进去。

## 本地验证命令

```bash
pi -e ./path/to/extension.ts
```

## 本项目约定

- adapter 目录 `plugins/<name>/pi/` 是一个独立 workspace 包。

## 已知问题

暂无。

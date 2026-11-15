# 0002 可移植核心 + 宿主薄 adapter，取代运行时 kernel

- 状态：已接受
- 日期：2026-11-15
- 取代：[0001](0001-base-framework.md)

## 背景

0001 设计了一个运行时 kernel：宿主声明 `seams`，能力声明 `requires`，kernel 在进程内注入服务。核对三个目标宿主的真实扩展机制后，这个模型不成立：

| 宿主 | 扩展机制 | 对 0001 的影响 |
|---|---|---|
| Claude Code | 声明式目录（`.claude-plugin/plugin.json` + skills/hooks/MCP），插件代码不在宿主进程里 | kernel 根本不会被加载 |
| DSH | Cordis 插件：`apply(ctx)`、`inject`、注册自动撤销 | kernel 与 Cordis 的依赖注入和生命周期重复 |
| Pi | 进程内 TS 模块：`export default (pi) => {}` | 需要的是薄 adapter，不是第二个容器 |

细节见 [docs/hosts/](../hosts/)。

## 决策

1. 删除 `src/kernel`、`src/runtime`、`src/sdk`。
2. 每个插件拆成 **core**（业务逻辑，不 import 任何宿主 SDK）和每个宿主一个 **adapter**（把 core 翻译成宿主 API 和打包格式）。
3. 跨宿主共享的契约放在 `packages/portable`：工具定义（JSON Schema 参数 + `execute`）、工具调用拦截（allow / deny / 改写）。只在第二个插件或第二个宿主真正需要时才往里加东西。
4. "能力需要什么、宿主支持什么"的检查从运行时移到构建/校验时：每个插件写 `plugin.meta.json`，脚本据此生成 `docs/capability-matrix.md`。
5. 技术栈：TypeScript + pnpm workspace，Node `>=22.19`（DSH 与 Pi 的共同下限）。

## 后果

- 现有代码和测试全部删除，0.1.0 骨架作废。
- 宿主 API 变动（尤其 DSH 预览版）只影响对应 adapter 目录。
- Claude Code 上的"工具"只能通过 MCP server 或 `bin/` 提供，core 必须能脱离宿主进程运行。
- 每加一个宿主要写一份 `docs/hosts/<host>.md`，并给已有插件补 adapter 或在矩阵里标记不支持。

## 备选方案

- **保留运行时 kernel**：Claude Code 无法使用；DSH 上与 Cordis 重复。否决。
- **每个宿主一个独立目录，不共享代码**：最简单，但同一逻辑写三遍，行为容易漂移。否决。
- **自创中立 manifest，全部由生成器产出**：要维护一套自定义 schema 和三个生成器，而三个宿主有两个是代码模块，收益小。否决；只对 Claude Code 的声明式部分保留生成的可能。

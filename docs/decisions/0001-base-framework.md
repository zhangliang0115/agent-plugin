# 0001 先做宿主无关的基础框架

- 状态：已被 [0002](0002-portable-core-host-adapters.md) 取代
- 日期：2026-11-15

## 背景

前几版结构把 Code Mode 和宿主（Claude Code / DSH）直接放在顶层，导致：

- 能力被当成产品顶层，第二个能力进来就要重排；
- 宿主能力差异只能靠文档和 `if (host)` 表达，无法在构建时校验；
- 初始化文档、决策记录和问题记录没有固定位置。

## 决策

先实现一个宿主无关、能力无关的基座：

- `src/kernel/`：注册表、契约校验、生命周期、事件、上下文；
- `src/runtime/`：sandbox、tool runtime、session、output 的接口；
- `src/sdk/`：`defineHost` / `defineCapability`。

能力和宿主 adapter 作为上层，后续再加。

## 后果

- 当前没有 Code Mode、DSH adapter、Claude Code adapter。
- 可以用 fake host / fake capability 测试契约和生命周期。
- 新能力只需要声明 `requires`；新宿主只需要声明 `seams` 和 `services`。
- 能力矩阵可以后续从 manifest 生成，不靠手写。

## 备选方案

- **host-first 直接从 Code Mode 开始**：更快看到效果，但会把能力差异写死在 adapter 里，第二个能力进来容易重排。
- **capability-first**：每个能力自带宿主 adapter；打包和发布按宿主组装，复杂度更高。
- **monorepo packages**：适合多包发布，但现在还没有 npm 发布需求，先用单包 + 分层目录。

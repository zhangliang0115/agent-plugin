# 0003 仓库脚本用 TypeScript 直接运行，不加构建步骤
- 状态：已接受（2026-11-15 修订：TypeScript 版本由 5.9.3 改为 7.0.2，见文末修订记录）
- 日期：2026-11-15

## 背景
仓库需要 `validate`（校验 `plugin.meta.json`）和 `matrix`（生成并检查能力矩阵）两个脚本。它们只在仓库内运行，不发布。项目要求 Node `>=22.19`，这个版本起 Node 默认对 `.ts` 文件做类型擦除。构建工具的选择仍未决定，见 [issue #3](https://github.com/zhangliang0115/agent-plugin/issues/3)，等第一个要发布的包出现再定。

## 决策
1. `scripts/*.ts` 用 `node` 直接运行，不产出 JS，也不加 build 步骤。
2. 只写可擦除的 TS 语法（tsconfig 开启 `erasableSyntaxOnly`）：不用 `enum`、`namespace`、参数属性。
3. `typescript` 锁定 `7.0.2`（当前 latest），`@types/node` 锁定 `22.19.21`（与最低 Node 版本对齐），都是根 `devDependencies` 的精确版本。
4. 根 `tsconfig.json` 继承 `tsconfig.base.json`，`include` 为 `scripts/**/*.ts`，并显式写 `"types": ["node"]`。TypeScript 7 不再自动加载 `@types/node`，不写这一项时类型检查报错。
5. 测试用 `node --test`，fixture 放在 `scripts/test/fixtures/`，不放进 `plugins/`。

## 后果
- 好的：脚本没有构建产物，改完即可运行。
- 好的：校验和矩阵生成的规则由 `node --test` 覆盖（见 `scripts/test/`）。
- 坏的：不能使用 `enum` 等需要转换的语法；代码需要显式写 `.ts` 扩展名的 import。
- 后续：TypeScript 7 是原生版（Go 实现的 `tsc`）。安装时 registry 可能下载超时，处理方式见 `friction.md`：用 `--registry=https://registry.npmjs.org` 安装。TypeScript 7 不自动加载 `@types/node`，见决策第 4 条。
- 后续：本仓库 TypeScript 只用于类型检查，脚本运行不依赖它。

## 备选方案
- **tsx / ts-node 运行**：多一个运行时依赖，ts-node 的 ESM 支持较差。否决。
- **`.mjs` + JSDoc 做类型检查**：不用擦除，但类型表达不如 TS 完整，且与其他 TS 代码风格不一致。否决。
- **TypeScript 5.9.3**：最初采用的版本。因一次镜像下载失败而锁定，该理由未被复现，修订时改为 7.0.2。

## 修订记录
- 2026-11-15：`typescript` 从 5.9.3 改为精确的 7.0.2。原因：用户决定安装最新版，且 5.9.3 的否决依据（镜像 404）复核后不成立。registry.npmjs.org 上 7.0.2 的元数据和 darwin 平台包 tarball 可下载。`tsconfig.json` 增加 `"types": ["node"]`。

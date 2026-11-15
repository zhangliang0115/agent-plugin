# 摩擦记录

宿主、工具或本项目规则的行为与预期不一致时，先在这里记下来再改。解决后把条目状态改成"已解决"，并写明结论回写到了哪里（`docs/hosts/`、`AGENTS.md`、ADR 或代码）。

## 格式

```markdown
## YYYY-MM-DD 短标题
- 状态：未解决 | 已解决
- 现象：可复现的一步，以及实际看到的输出或路径
- 期望：文档或规则怎么写的（带文件路径或官方链接）
- 处理：改 AGENTS.md / 改 docs/hosts / 改 adapter / 先不改；已解决时写结论去向
```

## 记录

## 2026-11-15 Kiro 不跟随软链接，skill 无法用软链接共享
- 状态：已解决
- 现象：想让 Kiro 和 Claude Code 共用一份仓库 skill。Kiro 的加载器忽略软链接目录（[kirodotdev/Kiro#6401](https://github.com/kirodotdev/Kiro/issues/6401)、[#8265](https://github.com/kirodotdev/Kiro/issues/8265)）。
- 期望：一份 skill 文件，两个工具都能加载。
- 处理：真实文件放 `.kiro/skills/`，`.claude/skills -> ../.kiro/skills` 软链接。实测 Kiro 能加载 `.kiro/skills/` 下的临时 skill，Claude Code 2.1.325 能通过软链接加载同一个 skill。结论写入 `docs/conventions.md`「Skills」。

## 2026-11-15 npm 镜像下载 TypeScript 7 平台包时卡住（原记录的 404 未复现）
- 状态：已解决
- 现象：用户的 npm 配置 registry 是 `https://registry.npmmirror.com`。第一次 `pnpm add -D -E typescript@7.0.2` 下载 `@typescript/typescript-darwin-arm64@7.0.2` 时，镜像的 tarball 请求出现 404 并不断重试，进程不结束。复核时，`npm view` 查询两个 registry 的元数据都返回 7.0.2；`registry.npmjs.org` 上的 darwin tarball 返回 200。镜像上同一 tarball 首次 200、二次超时，所以问题更像网络或镜像同步不稳定，不是包缺失。
- 期望：`typescript@7.0.2` 及其平台包都能从配置的 registry 下载。
- 处理：`pnpm add -w -D -E typescript@7.0.2 --registry=https://registry.npmjs.org` 安装成功（约 9.5 秒，只用于这一条命令，不改全局配置）。`package.json` 与 `pnpm-lock.yaml` 锁定 7.0.2。决定见 `docs/decisions/0003-scripts-toolchain.md` 的修订记录。镜像问题仍在，装新包时需要显式指定 registry 或重试。

## 2026-11-15 TypeScript 7 不再自动加载 @types/node
- 状态：已解决
- 现象：升级到 `typescript@7.0.2` 后，`pnpm typecheck` 报 33 个错误（`Cannot find name 'process'`、`Cannot find module 'node:fs/promises'` 等）。在 5.9.3 下同样的配置能通过。`pnpm test` 不受影响，因为 Node 直接运行 `.ts` 文件，不做类型检查。
- 期望：`@types/node` 已安装为 devDependency，类型检查应能找到 Node 类型。
- 处理：在根 `tsconfig.json` 的 `compilerOptions` 里写 `"types": ["node"]`。修复后 `tsc --listFiles` 列出 `scripts/` 下的 6 个文件，`pnpm typecheck` 通过。结论写入 ADR 0003 的决策第 4 条。

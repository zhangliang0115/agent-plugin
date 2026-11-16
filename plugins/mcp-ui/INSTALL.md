# 安装 MCP 设置页（mcp-ui）

## DSH

本节未在 DSH 桌面版上实测。下文的构建、打包和 CLI 检查是在本仓库里跑过的；桌面版的「添加插件」与设置页显示属于未验证步骤，标注见各小节。

### 前置条件

- DSH 版本：`0.2.2-rc.3`。
  - 设定 `<dsh>`：macOS 桌面版为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。如果 `command -v dsh` 有输出，用它的路径。
  - 检查：`"<dsh>" --version`，预期输出 `0.2.2-rc.3`。
- Node：`>= 22.19`（检查：`node -v`）。
- pnpm：仓库锁定 `10.6.3`（检查：`pnpm -v`）。
- `<repo>` 是本仓库的绝对路径，用 `git rev-parse --show-toplevel` 在仓库内获取。
- `mcp-manager`（DSH 官方 MCP 管理器）必须已挂载。桌面版的 `desktop` profile 默认挂载它。

### 安装

在 `<repo>` 执行：

```bash
pnpm install
```

预期输出包含 `Done in`。

在 `<repo>/plugins/mcp-ui/dsh` 执行：

```bash
pnpm run build
mkdir -p /tmp/mcp-ui-pkg && pnpm pack --pack-destination /tmp/mcp-ui-pkg
```

预期：`/tmp/mcp-ui-pkg/zhangliang0115-mcp-ui-0.2.0.tgz` 存在。下文用 `<tgz>` 表示这个路径。

安装到桌面版（未实测）：在 DSH 桌面版的插件页选择「添加插件」，填入 `<tgz>`，安装后重启 DSH。桌面版的 `desktop` profile 由 Electron 独占，CLI 不能检查它的组合树。

用 CLI 在测试 profile 中检查（未实测，仅说明命令形式）：

```bash
test -d ~/.dsh/profiles/<profile> || "<dsh>" --profile <profile> --from-default-profile headless --dump-config > /dev/null
"<dsh>" plugin --profile <profile> add <tgz>
```

`<profile>` 是测试用的名称，例如 `mcp-ui-test`，不能使用 `desktop` 或 `web`。第一条命令只在 profile 不存在时运行，因为它会覆盖已有的 profile。

### 配置

本插件没有需要手写的配置项。`parallelTools` 由设置页的「支持并行」勾选写入，不要手改。

| 名称 | 是否必填 | 说明 | 取值方式 |
|---|---|---|---|
| `parallelTools` | 否 | 支持并行的工具名单，默认为空 | 设置页勾选时写入 `mcp-ui` 命名空间 |
| `disabledTools` | 否 | 被禁用（调用会被拒绝）的工具名单，默认为空 | 设置页「启用」勾选时写入 `mcp-ui` 命名空间 |

服务器本身仍在官方 `mcp-manager` 的配置中，由设置页的增删改写入。

### 验证

在 `<repo>/plugins/mcp-ui/core` 执行：

```bash
pnpm test
```

预期输出包含 `ℹ fail 0`。

在 `<repo>/plugins/mcp-ui/dsh` 执行：

```bash
pnpm test
pnpm run build
tar -tzf /tmp/mcp-ui-pkg/zhangliang0115-mcp-ui-0.2.0.tgz | grep -E "dist/client.js|dist/index.js"
```

预期：测试输出包含 `ℹ fail 0`；`tar` 列出 `package/dist/client.js` 与 `package/dist/index.js`。

安装到测试 profile 后（未实测）：

```bash
"<dsh>" --profile <profile> --dump-config | grep -n "mcp-ui"
```

预期：输出中有 `id: mcp-ui` 与 `name: '@zhangliang0115/mcp-ui'` 所在的行。没有输出说明插件行没有进入组合树，先检查 `plugin add` 是否成功。

桌面版验证（未实测）：重启 DSH 后，设置页左侧导航出现「MCP」标签。能看到服务器列表和实时状态，点击「工具」能列出工具并勾选「支持并行」。

### 卸载（未实测）

```bash
"<dsh>" plugin --profile <profile> remove @zhangliang0115/mcp-ui
```

桌面版在插件页直接卸载，然后重启 DSH。

### 常见问题

- 设置页没有「MCP」标签 → 客户端 bundle 没有被加载。`cordis.patch.yml` 的 `mcp-ui` 行只会出现在部署层；桌面版是否加载第三方 client bundle 尚未验证。先确认插件页里已安装该插件，并重启 DSH。
- 「Settings 中缺少 mcp-manager 或 mcp-ui 配置」→ `mcp-manager` 没有挂载，或本插件的 host 半部没有激活。用上面的 `--dump-config` 检查两行是否都在。
- 勾选「支持并行」后没有效果 → 并行只在 Code Mode 预设下生效。另外 `code-mode-dsh` 需要读取服务 `mcpParallel` 的版本才会使用这份名单；该版本的状态见 `plugins/code-mode`。
- 保存时报「配置已在别处修改」→ 另一处写入了配置，页面数据已过期。页面会自动刷新，重新操作即可。

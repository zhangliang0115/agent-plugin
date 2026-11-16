# 安装 Code Mode

## DSH

仅在 macOS 桌面版 DSH 0.2.2-rc.3 上实测。其他系统的步骤未实测，使用前先确认 `dsh` 命令的位置和 profile 目录。

### 前置条件

- DSH 版本：`0.2.2-rc.3`。
  - 设定 `<dsh>`：macOS 桌面版为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。如果 `command -v dsh` 有输出，用它的路径。
  - 检查：`"<dsh>" --version`，预期输出 `0.2.2-rc.3`。
- Node：`>= 22.19`（检查：`node -v`）。
- pnpm：仓库锁定 `10.6.3`（检查：`pnpm -v`）。
- `<repo>` 是本仓库的绝对路径，用 `git rev-parse --show-toplevel` 在仓库内获取。
- `<profile>` 是测试或使用的 profile 名称，例如 `code-mode-test`。不能使用 `desktop` 或 `web`，这两个由 DSH 桌面版管理。

### 安装

在 `<repo>` 执行：

```bash
pnpm install
```

预期输出包含 `Done in`。

在 `<repo>/plugins/code-mode/dsh` 执行：

```bash
pnpm run build
mkdir -p /tmp/code-mode-pkg && pnpm pack --pack-destination /tmp/code-mode-pkg
```

预期：`/tmp/code-mode-pkg/zhangliang0115-code-mode-dsh-0.5.0.tgz` 存在。下文用 `<tgz>` 表示这个路径。

如果 profile 目录 `~/.dsh/profiles/<profile>` 不存在，在任意目录执行一次（用于创建 profile，使用 DSH 的 headless 模板）：

```bash
test -d ~/.dsh/profiles/<profile> || "<dsh>" --profile <profile> --from-default-profile headless --dump-config > /dev/null
```

这条命令只在 profile 不存在时运行。profile 已存在时它会覆盖该 profile，因此不要对已有的 profile 运行。

headless 模板的默认模型是 DeepSeek 官方 API（`deepseek-official`）。要使用本机网关，把桌面版 profile 的网关路由复制到 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

1. 打开 `~/.dsh/profiles/desktop/cordis.patch.yml`，找到 `id: llm-pi-ai` 与 `id: agent-default-model` 两条。
2. 把这两条复制到 `~/.dsh/profiles/<profile>/cordis.patch.yml`，内容如下。`<provider-id>`、`<model-id>` 与 `<base-url>` 替换为桌面版文件里的值，`<api-key-env>` 替换为该 provider 的 `apiKeyEnv` 值。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      <provider-id>:
        displayName: <provider-display-name>
        apiKeyEnv: <api-key-env>
        api: openai-responses
        baseURL: <base-url>
        models:
          - id: <model-id>
            name: <model-display-name>
            contextWindow: 1048000
            maxTokens: 328000
            input: [text, image]
            compat:
              supportsStrictMode: true
        streamIdleTimeoutMs: 600000
- id: agent-default-model
  config:
    provider: <provider-id>
    model: "<model-id>"
```

只改动 `~/.dsh/profiles/<profile>/cordis.patch.yml`。不要修改桌面版或 web 的 profile，也不要改 `~/.dsh/settings.yaml`。

安装插件：

```bash
"<dsh>" plugin --profile <profile> add <tgz>
```

预期输出包含 `+ @zhangliang0115/code-mode-dsh 0.5.0`。

包发布到 npm 之后，可以省掉本地构建，直接从 npm 安装：

```bash
"<dsh>" plugin --profile <profile> add @zhangliang0115/code-mode-dsh
```

包名与 scope 的决策见 `docs/decisions/0005-npm-scope-and-package-names.md`。

插件的 `cordis.patch.yml` 不再禁用任何执行器：它声明一个 `code-mode` agent preset，插件行在 preset 内部，执行器注册在该 preset 的 agent scope 里。deployment scope 的 `tool-executor-native` 与 `tool-executor-ptc` 保持启用，DSH 自带的其他 preset 仍可选。

无 preset 注册表的 profile（`headless` 模板）无法承载 preset，需要用一并安装的 `cordis.headless.patch.yml` 作为 overlay：它禁用 native 与 PTC 并在 deployment scope 挂载插件。用法见「验证」中的「headless」一节。

### 配置

| 名称 | 是否必填 | 说明 | 取值方式 |
|---|---|---|---|
| `<dsh>` | 是 | DSH 命令的路径 | 见前置条件 |
| `<profile>` | 是 | 使用的 profile 名称，不能是 `desktop` 或 `web` | 用户指定，例如 `code-mode-test` |
| `<tgz>` | 是 | `pnpm pack` 的输出 | 见安装步骤 |
| 网关路由 | 否 | 使用本机网关时需要。不写则 profile 使用 DeepSeek 官方 API，需要 `DEEPSEEK_API_KEY` | 见安装步骤 |

插件本身没有环境变量。

插件限额（可选）。在 profile 的 `cordis.patch.yml` 里给 `code-mode-dsh` 行补 `config`，未写的字段用默认值（默认值见 [README](README.md) 的限制表）：

```yaml
- id: code-mode-dsh
  name: '@zhangliang0115/code-mode-dsh'
  config:
    timeoutMs: 300000
    maxTimeoutMs: 300000
    maxParallelSubCalls: 4
```

可配置字段：`timeoutMs`、`maxTimeoutMs`、`memoryBytes`、`maxSubCallsPerRun`、`maxParallelSubCalls`、`resultChars`、`logChars`、`errorChars`。值必须是正整数；写错时插件激活失败，错误里带字段路径（例如 `$.timeoutMs expected number >= 1 but got 0`）。

### 验证

1. 检查组合树：

   ```bash
   "<dsh>" --profile <profile> --dump-config > /tmp/<profile>-config.txt
   grep -n "code-mode-dsh" /tmp/<profile>-config.txt
   grep -n -A2 "id: tool-executor-native" /tmp/<profile>-config.txt
   ```

   预期（preset 形态）：第一条 `grep` 输出包含 `- id: code-mode-dsh`，它在 `preset-code-mode` 的 `plugins` 列表内。第二条输出中 `tool-executor-native` **没有** `disabled` 行——preset 形态不禁用任何执行器。

   若改用 headless overlay，预期相反：`- id: code-mode-dsh` 出现在 deployment 层（不在任何 `plugins:` 缩进内），且 `tool-executor-native` 之后两行内有 `disabled: true`。

2. 冒烟任务。准备一个三行的夹具文件，然后运行一次：

   ```bash
   mkdir -p /tmp/code-mode-verify && printf 'a\nb\nc\n' > /tmp/code-mode-verify/a.txt
   cd /tmp/code-mode-verify && "<dsh>" --profile <profile> --json "Call run_code exactly once. In that program, call the read tool on a.txt and return its totalLines value as the program result. Reply with only that number."
   ```

   预期：输出的 JSON 行中至少有一行 `"type": "tool_call"` 且 `"tool": "run_code"`。最后一行的 `"type": "final"` 中，`"text"` 为 `"3"`。

   如果输出不是 `3`，看下面的常见问题。

3. 展示元数据（可选）。确认安装后的包里有 locale 与图标：

   ```bash
   PKG=~/.dsh/profiles/<profile>/node_modules/@zhangliang0115/code-mode-dsh
   ls "$PKG" && cat "$PKG/locale/zh.json"
   ```

   预期：目录里有 `dist`、`cordis.patch.yml`、`locale`、`icon.svg`；`zh.json` 的 `meta.title` 是 `Code Mode`。Plugin Manager 的 Bundles 页面显示同样的标题与描述；没有在界面上看过就按未实测处理。

### 卸载

```bash
"<dsh>" plugin --profile <profile> remove @zhangliang0115/code-mode-dsh
```

预期输出包含 `- @zhangliang0115/code-mode-dsh`。

如果 `<profile>` 只为本插件建立，并且要删除它：

```bash
rm -rf ~/.dsh/profiles/<profile>
```

删除前确认该 profile 没有其他用途。

### 常见问题

- 现象：`"<dsh>" --profile <profile> headless "..."` 没有输出，进程挂住。原因：`headless` 是模板名，DSH 把它当作任务文本。处理：去掉 `headless`，用 `"<dsh>" --profile <profile> --json "<task>"`。
- 现象：`--dump-config` 中没有 `code-mode-dsh`。原因：`plugin add` 没有成功，或 `<tgz>` 路径错误。处理：重跑安装步骤；检查 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 中是否有 `@zhangliang0115/code-mode-dsh`。
- 现象：`dump-config` 中 `agent-default-model` 的 `provider` 是 `deepseek-official`，回答来自官方 API。原因：没有写入网关路由。处理：完成安装步骤里的网关路由。
- 现象：`Only one tool executor may be registered in each scope`。原因：`tool-executor-native` 没有被禁用，或另一个插件也注册了 executor。处理：检查 `--dump-config`，确认 native 为 `disabled: true`。
- 现象：`pnpm` 警告 `linked in dependency will not resolve the peer dependencies`。原因：用了目录安装。处理：改用 `pnpm pack` 得到的 tgz。
- 现象：`run_code` 返回 `<error>ReferenceError: 'Read' is not defined</error>`。原因：DSH 的工具名是小写的 `read`，模型猜了 `Read`。处理：模型通常会改正。也可以在任务里写明工具名。

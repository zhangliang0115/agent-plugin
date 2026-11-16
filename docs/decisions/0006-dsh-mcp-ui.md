# 0006 DSH 的 MCP 管理界面：独立 UI 插件 + 逐工具并行勾选

- 状态：已接受
- 日期：2026-11-16

## 背景

桌面版 DSH 0.2.2-rc.3 的设置页没有 MCP 入口。官方已有后端 `@deepseek-ai/dsh-mcp-manager`，由 `dsh-web-app` 默认挂载（行 id `mcp-manager`）：增删改停用服务器（Settings 命名空间 `mcp-manager`，字段 `servers`，带 revision 校验和写入期校验）、`watch` 实时状态、`restart`、`probe`（返回工具名）。缺口有两个：没有界面；没有「逐工具是否可并行」的配置。

需求：设置页左侧有「MCP」入口，显示每个服务器的实时连接状态和工具列表，增删改启停，每个工具有一个「支持并行」勾选框，勾选实时生效。复用官方运行能力，只补界面和并行开关。

宿主事实见 `docs/hosts/dsh.md`「MCP 管理与设置页扩展」。

## 决策

新增插件 `plugins/mcp-ui`（包 `@zhangliang0115/mcp-ui`），与 `code-mode` 分开。

- **界面放在独立包里，挂在部署层。** 客户端 bundle 只有挂在部署层的插件行才会被加载。`code-mode-dsh` 的行在 `preset-code-mode` 里面，同一个包放浏览器端代码不会被加载（对照实验：同样的标签页，放在 preset 内的包里不显示，放在部署层的独立包里显示）。
- **入口是左侧栏目。** 用 `settings.section`（id `mcp`，带 `settings.section.icon`），不放进「内置插件」页的标签里。
- **服务器管理走官方，状态和工具走自己的一个流。** 增删改经 `ctx.remote.settings.mutate`（命名空间 `mcp-manager`，revision 校验）。页面只订阅 `mcp-ui` 自己的流 `ctx.remote.mcpTools.watch`：宿主端把官方管理器的状态（`mcpManager.list()` 加 `mcp-manager/status` 事件）和工具注册表里的工具（完整名、原始名、描述，事件 `tools/change`）合成一份完整列表推送。不用官方 `probe`：它每次新开连接，只返回工具名，没有描述。
- **并行名单存在 `mcp-ui` 自己的 volatile 配置 `parallelTools`**，保存完整工具名（`mcp__<server>__<tool>`）或 `mcp__<server>__*`。`mcp-ui` 的宿主半边提供服务 `mcpParallel`，读取实时值。
- **`code-mode-dsh` 可选地使用该服务。** 执行器每次判定并行时读取最新名单：静态 `concurrentTools`（也是 volatile）与 `mcpParallel.isParallel(name)` 取并集；服务不存在时不受影响。工具自己声明了 `isConcurrencySafe` 时不覆盖。
- core 放服务器条目校验、名单匹配、工具名解析（不依赖 DSH）；dsh adapter 放宿主插件、浏览器端 bundle、挂载。

- **每个工具可以启用或禁用，默认启用。** 禁用名单 `disabledTools` 是 `mcp-ui` 的另一个 volatile 配置（完整工具名或 `mcp__<server>__*`）。拒绝由 `mcp-ui` 注册的一个 `tools/pre-execute` 监听完成（`prepend: true`，返回 `deny` 和原因「工具 <名字> 已被用户在 MCP 设置里禁用。」），对所有执行器有效，包括 Code Mode 的 `run_code` 子调用，且拒绝发生在审批之前。隐藏只在 Code Mode 做：`code-mode` 通过服务 `mcpDisabled` 把被禁用的工具从指令文本和 `run_code` 描述里去掉，程序的工具绑定保留，这样模型即使按名字调用也会得到上面的拒绝原因，而不是 `ReferenceError`。

**并行勾选的作用范围：** 只在 `code-mode` preset 下对 `run_code` 里的工具调用生效。该 preset 的执行器只向模型暴露 `run_code`，所有工具调用经过执行器自己的流水线。其他 preset 用 DSH 原生执行器，插件管不到。界面上已写明。

## 后果

- 勾选实时生效，不需重启或重载插件（见验证）。
- 改服务器配置会让官方管理器重建该实例，期间它的工具短暂不可用。界面有提示。
- 服务器名不允许含双下划线，否则 `mcp__fs__*` 会误匹配服务器 `fs__x` 的工具。
- 官方没有逐工具的允许/禁用清单，这里自己做。普通 preset（DSH 自带执行器）下无法对模型隐藏被禁用的工具：MCP 工具由 `dsh-mcp-client` 注册，它不开放 `when` 条件；只有调用会被拒绝。
- 拒绝监听读不到名单时放行（宁可漏拒，也不让一次读取失败挡住所有调用）。
- 依赖 DSH 内部的客户端扩展点，升级 DSH 时要重新核对。
- 浏览器端的远程命名空间是 DSH 客户端里写死的一份清单，第三方要自己 `ctx.remote.$mount(...)`，宿主端对应地导出 `./typert`。官方描述文件由生成器产生，这里手写，依赖版本固定在 0.2.2-rc.3，升级 DSH 时要重新核对。
- `cordis` 4.1.0 不支持 optional inject，所以 `code-mode` 每次判定时用 `ctx.get('mcpParallel')` 查找，而不是声明依赖。

## 验证（桌面版 0.2.2-rc.3，macOS）

- 桌面版设置页左侧出现「MCP」，页面显示真实服务器：`echo · stdio · 已连接 · 2 个工具`，展开后每个工具一个勾选框。勾选 `slow` 后 `mcp-ui` 的 `parallelTools` 存为 `mcp__echo__slow`。
- 独立 profile（headless 模板 + 两个插件 + 同一个 echo 服务器）里让 `run_code` 并发调用两次 `slow(1000)`：`parallelTools` 含 `mcp__echo__slow` 时耗时 1018 ms，清空后 2034 ms。

## 未验证

- 界面里的「编辑」「删除」「重启」没有逐项在桌面版里点过。
- 热生效只在命令行 profile 里用「改配置文件后重启进程」的方式对照过，没有验证桌面版运行期间勾选后下一次调用立即变化。
- `mcpParallel` 从 deployment 作用域被 preset 的 agent 作用域读取：命令行验证用的是部署层的执行器，桌面版 preset 内的路径没有单独验证。

## 禁用的验证（0.2.0 / code-mode 0.5.0）

- 独立 profile 里 `disabledTools: [mcp__echo__slow]`：`run_code` 里调用 `slow` 得到「工具 mcp__echo__slow 已被用户在 MCP 设置里禁用。」；清空名单后同一调用正常返回；模型读到的 `run_code` 描述里只列出 `mcp__echo__echo`。
- 桌面版里点掉 `slow` 的「启用」：配置写入 `disabledTools: [mcp__echo__slow]`，该行变灰，「支持并行」不可选，工具区出现说明；再点一次恢复。

## 备选方案

- **界面放进 `code-mode-dsh`：** 行在 preset 内，客户端 bundle 不会被加载。已被实验否决。
- **放进「内置插件」页的标签：** 可行，但入口深，改为左侧栏目。
- **独立本地网页：** 不依赖 DSH 客户端扩展点，但界面在桌面版之外。因为第三方 bundle 能加载，不需要。
- **只做命令行或配置模板：** 不满足「界面管理」的需求。

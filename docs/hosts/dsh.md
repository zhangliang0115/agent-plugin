# DSH（DeepSeek Harness）

- 核对版本：未在本机核对。资料基于 0.1.0-rc.7 至 0.2.1-rc.2 的公开文档
- 核对日期：2026-11-15
- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 插件指南（第三方，已对照上游）：<https://www.ssdnodes.com/learn/write-your-own-dsh-plugin>
- 稳定性：**开发者预览**，README 明确会有破坏性变更。字段名在 rc 之间会改，用之前对照当时的上游文档

## 插件形态

DSH 基于 Cordis，"一切皆插件"：工具注册表、agent loop、会话存储都是插件。插件是一个模块，导出：

- `name`：诊断用名称
- `inject`：依赖的服务，如 `['tools']`。**必须写**，否则 `apply` 可能在 `ctx.tools` 就绪前执行
- `apply(ctx)`：入口。通过 `ctx` 注册的东西在插件卸载时自动撤销；Cordis 管不到的资源用 `ctx.effect(() => dispose)`

## 注册工具

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
}
```

`output.schema` 描述返回值，`output.render` 决定模型看到的内容块。

## 拦截工具调用

waterfall 事件签名是 `(payload, next)`，**必须 `await next()`**，否则会截断整条链：

- `tools/pre-execute`：执行前 allow / deny / 请求审批
- `tools/execute`：包裹执行
- `tools/post-execute`：替换或阻止结果
- `tools/result`：只读通知，不是 waterfall

另有 `agent/request` 等 waterfall，以及 `tool/call`、`tool/result` 等普通会话事件。payload 字段变动频繁，不要照抄文档，先打印再用。

## 其他扩展点

- 浏览器端：`package.json` 的 `dsh.client` + `./client` 导出，`ctx.slots.register`。变动最快，用时读上游 `packages/client/AGENTS.md`。
- 内置 PTC 模式（模型写 TS 程序批量调用工具），与 Code Mode 思路重叠。

## 打包与安装

- 插件是 npm 包，`package.json` 写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`files` 必须包含 `cordis.patch.yml`。
- `cordis.patch.yml` 的行 `name` 等于包名，`id` 保持稳定、不复用。
- `engines` 写 `"dsh": ">=<版本>"`；keywords 加 `dsh-plugin`。

## 本地验证命令

```bash
dsh web --patch /abs/path/cordis.yml       # 路径必须是绝对路径
dsh plugin --profile demo add ./<pkg>      # 以打包形态安装到测试 profile
dsh --profile demo --dump-config           # 看行是否进入组合树
```

插件加载了但没反应时，先跑 `--dump-config`：行不在说明是组合问题，行在说明是代码问题。

## 本项目约定

- adapter 目录 `plugins/<name>/dsh/` 是一个独立 workspace 包。
- 锁定的 DSH 版本：**待定**（见 [#2](https://github.com/zhangliang0115/agent-plugin/issues/2)）。

## 已知问题

暂无。

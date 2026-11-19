# 0008 管理端采用原生 TypeScript + DOM + esbuild

- 状态：已取代（见 ADR 0009）
- 日期：2026-11-19
- 取代：无
- 关联：ADR 0007（新增 server 与 web 包类型）；learn-ai `claude-code/自建设计/03-MCP 管理与多客户端.md` §4.7、`05-交接与待办.md` §二

编号承接仓库 `docs/decisions/` 的 ADR 序列（0007 之后）；本文件放在插件文档目录，便于与 repl-server 的实现一起演进。

## 背景

03 §4.7 与 05 §二最初把管理端写成「React + esbuild」，并计划优先使用成熟 UI 库。实现后的 `web` 包与这个描述不一致，且原生方案已经覆盖现有需求：

- `web/package.json` 的 `devDependencies` 只有 `esbuild@0.28.2`，没有 `react` / `react-dom`，也没有组件库。
- `web/src/` 由 `main.ts`、`lib/router.ts`、`lib/api.ts`、`lib/format.ts` 与 `pages/{overview,manage,audit,shared}.ts` 组成，直接用 DOM API 构建视图；表格、抽屉、虚拟列表与 SVG 图表均为自建。
- `web/test/` 用 `node:test` 覆盖流式 API 与页面事件，不需要框架测试运行时。
- 构建仍由 `web/scripts/build.mjs` 调用 esbuild，产出 `dist/main.js` 与 `dist/styles.css`，由 server 作为静态资源托管。
- 管理端的功能范围是概览、servers/tools/clients 配置、审计列表与抽屉、报告/告警、发现预览、AI 配置与标注；这些页面以表格、表单和少量 SVG 图表为主，没有需要框架生态才能实现的交互。

继续按「React + 组件库」描述会造成文档与实现不一致，也会让后续改动误以为可以引入框架依赖。

## 决策

1. 管理端统一采用 **原生 TypeScript + DOM + esbuild**，不引入 React 或其他前端框架。
2. 不引入成熟组件库；表格、虚拟列表、抽屉、notice 等基础组件自建，图表用 SVG 手绘。
3. 保留现有路由、类型化 API client、主题 token 与 CSRF/鉴权实现，不因本决策改动 `/admin/api` 契约。
4. 后续若交互复杂度或状态管理超出原生 DOM 的可维护范围，再单独写 ADR 评估框架；本决策不预埋框架依赖或适配层。

## 后果

- 好的：包体小，构建产物只包含业务代码与 esbuild 运行时辅助；没有框架运行时、组件库版本升级与框架特有的构建配置。
- 好的：现有实现与 `web/test/` 已按原生 DOM 编写，决策与代码一致，不需要迁移成本。
- 好的：server / web 仍按 ADR 0007 的「独立构建、同进程部署」运行，web 产物由 server 托管。
- 坏的：组件复用、列表虚拟化、图表与键盘可访问性要自己维护；复杂交互（拖拽、富文本、复杂表单状态）新增成本高于框架方案。
- 坏的：没有生态组件可直接引入；团队成员需要熟悉本仓库的 DOM helper 约定。
- 需要跟进：03 §4.7、05 §二与 `docs/plan.md` 的 RS-17 描述已同步为原生方案；若将来改回框架，必须新写 ADR 并说明迁移范围。

## 备选方案

- **React + esbuild（原方案）**：生态与组件库成熟，但增加运行时与依赖体积，且现有页面已用原生 DOM 实现，迁移没有功能收益。否决。
- **Vue / Svelte 等其他框架**：同样增加运行时与构建复杂度，且没有现成代码可复用。否决。
- **框架 + 成熟组件库**：开发速度快，但包体与升级负担最大，虚拟列表和图表仍可能需要定制。否决。
- **原生 TypeScript + DOM + 组件库**：组件库通常绑定框架；纯 DOM 组件库收益有限，表格与虚拟列表仍要自建。否决。

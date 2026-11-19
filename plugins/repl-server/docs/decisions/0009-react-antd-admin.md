# 0009 管理端采用 React 19 + Ant Design 6

- 状态：已接受
- 日期：2026-11-19
- 取代：ADR 0008（管理端采用原生 TypeScript + DOM + esbuild）；ADR 0008 中「不引入框架、不引入成熟组件库」的条款自本 ADR 起失效
- 关联：ADR 0007（新增 server 与 web 包类型）；learn-ai `claude-code/自建设计/03-MCP 管理与多客户端.md` §4.7、`05-交接与待办.md` §二、`08-AI 配置与标注.md` §7.5

编号接仓库 `docs/decisions/` 的 ADR 序列（0008 之后）；本文件放在插件文档目录，并在仓库索引与本目录索引登记。

## 背景

ADR 0008 按「表格、表单与少量 SVG 图表」的交互规模选择了原生 DOM，并明确不引入框架。管理端扩展到 12 个页面后，这个前提不再成立：

- 页面为概览、审计、报告、servers / tools / clients、secrets、tags、alerts、AI 配置、导入导出、发现（`web/src/app/pages/*.tsx`），主流交互是服务端分页表格、筛选器、抽屉表单、多选标签、确认对话框与批量操作。
- 原生实现需要自建并逐页复制表格列渲染、排序与分页状态、表单校验、抽屉生命周期与多选控件；每次页面迭代都要重新处理选中项、刷新、CSRF 与错误提示的同步，维护成本随页面数量线性增长。
- 企业级管理端需要一致的表格 / 表单 / 抽屉 / 选择器行为、键盘与可访问性、明暗主题；用成熟组件库统一这些行为，比逐页手写更可靠，也更容易保持视觉与交互一致。
- `web/package.json` 已引入 `react@^19.3.1`、`react-dom@^19.3.1`、`antd@^6.7.1`、`@ant-design/icons@^6.1.0`，锁文件解析为 19.3.1 / 6.7.1 / 6.1.0；继续按原生 DOM 描述会与实现不一致。

## 决策

1. 管理端统一采用 **React 19 + Ant Design 6**。入口为 `web/src/main.tsx`；壳层、路由、主题、API context 与页面在 `web/src/app/`（`App.tsx`、`router.ts`、`theme.ts`、`api.tsx`、`pages/*.tsx`、`components/*.tsx`）。
2. 路由保持 hash 形式：`#/overview`、`#/audit`、`#/reports`、`#/manage?tab=…`；`/admin/api` 契约、类型化 API client 与 CSRF / 鉴权流程不变。
3. 主题用 `ConfigProvider` + `darkAlgorithm` / `defaultAlgorithm`，保留 indigo 主色与既有密度令牌；明暗切换持久化到 `localStorage` 的 `repl-server.admin.theme`。
4. 旧的原生页面与手写组件（`web/src/pages/*`、`web/src/main.ts` 及对应的页面 UI 测试）删除，不保留兼容层或双实现。
5. 构建仍由 esbuild 打包 `src/main.tsx`，产物 `dist/main.js` 与 `dist/styles.css` 由 server 作为静态资源托管。

## 后果

- 好的：表格、表单、抽屉、多选、提示与对话框由 antd 统一提供，页面只写业务字段与数据流；交互一致性、键盘行为与可访问性不再逐页维护。
- 好的：主题令牌集中在一处（`web/src/app/theme.ts`），明暗两套算法与 indigo 主色保持原视觉，切换状态跨刷新保留。
- 好的：server / web 仍按 ADR 0007 的「独立构建、同进程部署」运行，web 产物由 server 托管，部署方式不变。
- 坏的：`dist/main.js` 约 3.7MB（antd 运行时占主体），首屏下载与解析成本高于原生实现。
- 坏的：React、react-dom、antd、@ant-design/icons 与 `@types/react` 需要版本协同；antd 大版本升级可能带来组件 API 变更，升级前要按页面回归。
- 坏的：`web/test/` 用 `node:test`，不渲染 React 组件；组件行为没有自动化覆盖，需要时得另外引入 jsdom + Testing Library。
- 需要跟进：测试重心转向纯逻辑，当前 `web/test/` 覆盖 `api-stream`、`router`、`palette` 三组共 14 个用例；旧的页面事件与纯逻辑测试已随旧页面删除。
- 需要跟进：可按页面继续优化，例如 `React.lazy` 代码分割、表格虚拟化与 antd 组件按需引入，降低首包体积。
- 需要跟进：ADR 0008 的「不引入框架」条款自本 ADR 起失效；learn-ai 03 §4.7、05 §二、08 §7.5 的描述已同步为 React 19 + Ant Design 6。

## 备选方案

- **保持原生 TypeScript + DOM**：包体最小、无框架运行时，但表格 / 表单 / 抽屉 / 多选的维护成本已经超出可接受范围，且 12 个页面已按 React 重写。否决。
- **React + 自建组件**：保留框架的状态管理，但仍要维护表格、表单、抽屉与多选；组件行为与可访问性收益小于 antd。否决。
- **Vue / Svelte + 成熟组件库**：能力相近，但没有现成页面可复用，团队与构建约定也要重学。否决。
- **原生 DOM + Web Components 渐进迁移**：避免一次性重写，但会长期维护两套渲染方式，类型与主题令牌难以统一。否决。

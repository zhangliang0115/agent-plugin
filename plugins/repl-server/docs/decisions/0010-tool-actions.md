# 0010 把工具动作语义从 tags 拆成 actions

- 状态：已否决（2026-11-24）
- 日期：2026-11-24
- 取代：无
- 关联：learn-ai `claude-code/自建设计/07-懒加载工具扁平化.md`、`08-AI 配置与标注.md`

> 否决理由：如果 actions 只是人工/AI 维护的枚举，它就是第二套 tags，没有新增信息；agent 检索工具按业务语义（名称/描述），不会按读/写筛选；本机日志只有 discover/tools/list/initialize，没有一次 `tools/call`，`excludeTags`/`visibleTools` 也没有使用证据。保留本文作为分析记录，不实施。

## 背景

现在 `tags` 同时承载四类信息：环境（`env.*`）、来源（`official`/`builtin`）、领域/产品（`gitlab`、`sentry`），以及动作能力（`read`、`write`、`query`、`exec`、`deploy`、`destructive`）。这带来三个具体问题：

1. **动作能力被当成自由文本标签**。`run_script.excludeTags` 直接按 `tool.tags` 过滤（`server/src/exec/gateway.ts:772`），动作语义只能靠字符串约定，无法校验“写工具必须标 write”“destructive 必须同时是 write”。
2. **标签枚举膨胀**。当前 58 个生效 tag，281 个启用工具里 237 个叠加后超过 4 个；其中 6 个动作键占枚举的一截，而且会随目录出现在每个工具上。按动作拆走后，标签枚举只留描述性词。
3. **上游事实没有入口**。第三方 MCP 的 `annotations.readOnlyHint` / `destructiveHint` 当前没有入库；catalog 的 `tools` 表也没有承载动作的字段。动作只能由人或 AI 按标签猜。

把动作继续留在 `tags` 里，数量上限只能治标：`read`/`write` 和 `gitlab`/`sentry` 永远混在同一个枚举里，校验也只能做“个数 ≤4”。

## 决策

1. **新增 `tools.actions_json`**：JSON 数组，允许值固定为 `read`、`write`、`query`、`exec`、`deploy`、`destructive`；每工具 0-3 个，去重。默认 `[]`。
2. **动作规则**（服务端校验，不靠提示词）：
   - `destructive` 必须同时有 `write`；`deploy` 必须同时有 `write`；
   - `read` 与 `write` 可以共存（例如可读写的事务工具）；
   - 未知动作留空，不强制猜；写能力的工具必须由人/AI 显式标出。
3. **`tags` 回归描述性**：上面 6 个动作键从标签字典删除，并禁止再写入 `servers.tags_json` / `tools.tags_json`。标签规则沿用已确认的：server 0-2 个；工具叠加 server 后 1-4 个；工具自己的 tag 不与 server 重复；server tag 只放对所有工具都成立的描述性标签。
   - AI 生成标签时同样受这套规则约束：server 0-2、工具叠加后 1-4、不重复 server 标签；先选字典里最合适的 key，确实缺项才建议新 key，管理员在预览里逐条接受/拒绝；server 标签只放对所有工具都成立的值。
   - 存量标签的超限部分与重复项由一次性迁移清理；AI apply 只合并、不删除，避免覆盖人工维护的标签。
4. **执行面**：`run_script` 增加 `excludeActions`（数组，枚举 6 值），与 `excludeTags` 并列；`excludeActions` 命中任一动作即排除该工具。`excludeTags` 只再匹配描述性标签。
5. **发现面**：`search_tools` 增加 `actions` 过滤（任一所列动作命中，OR）；`search_tools` 与 `describe_tools` 的结果带 `actions`。`tags` 过滤仍是 all-of。
6. **上游注解落库**：MCP 工具发现时保留 `annotations`，按以下规则派生初始动作：
   - `readOnlyHint === true` → `read`
   - `destructiveHint === true` → `destructive` + `write`
   - `readOnlyHint === false`（且未声明 destructive）→ `write`
   - 没有注解 → `[]`，留给 AI/人工
7. **AI 标注**：`toolOverrides[].actions` 使用同一枚举；提示词要求优先采用上游注解，没有依据时留空。apply 只合并、不删除已有动作；人工编辑优先于 AI。
8. **管理端**：`GET /servers/:id/tools` 返回 `actions`；`PATCH /tools/:serverId/:name` 与 `POST /tools/batch` 接受 `actions`；工具页可编辑。服务端与 AI 共用同一个校验函数。

### 兼容性

`excludeTags` 已经暴露给模型，缓存里的提示词可能继续传 `excludeTags: ["write"]`。直接切换会让写工具静默地不再被排除，这是安全回归。因此保留一个过渡期：

- `excludeTags` 中出现动作键时，同时按 `excludeActions` 生效，并在 eval 结果里给一条 warning（“请改用 excludeActions”）；
- 过渡期结束后删除该映射，并在 `run_script` 描述里写明。

`search_tools.tags` 出现动作键时同样按 `actions` 过滤并给 warning，避免模型检索行为突然变化。

## 迁移顺序

1. **Schema v8**：加 `actions_json`（默认 `[]`），升级 `tools_fts` 不需要动；catalog snapshot/search 带出 `actions`。
2. **写入路径**：发现、admin PATCH/batch、AI apply 都能写 `actions`；同时上线 `excludeActions` / `actions` 过滤与过渡映射。
3. **回填动作**：对每个工具执行 `actions = tags ∩ {read,write,query,exec,deploy,destructive}`，然后从 `tags_json` 删除这些键；server tags 同样删除动作键。删除标签字典中的 6 个动作键。此步是确定性的，可脚本化并 dry-run。
4. **标签收敛**：按已确认的规则（server 0-2、工具叠加 1-4、去重、min 1）做一次性迁移；迁移完成后再开启标签数量校验，避免存量数据把 PATCH 全部卡住。
5. **删除过渡映射**：至少一个发布周期后，移除 `excludeTags` 里的动作兼容和 warning。

## 后果

- 好处：动作可校验、可过滤；标签枚举只留描述性词，6 KB 的 `tools/list` 里 tag 部分继续缩小；`excludeActions` 比字符串标签更适合安全场景。
- 代价：`tools` 表、catalog、MCP 协议面（`run_script`、`search_tools`）、管理端、AI 提示词与校验、文档、测试都要同步；`excludeTags` 过渡期需要测试覆盖。
- 兼容风险：过渡映射存在期间，同一个动作可能同时来自 tags 和 actions，需要去重；删除映射后旧客户端会失去动作过滤能力，必须在 `run_script` 描述和设计文档里写清楚。
- 数据风险：很多工具的 `actions` 会暂时为空，直到 AI/人工标注；这比错误地标成 `read` 更安全，但检索按动作过滤时这些工具不会命中。
- 不改变：server 级仍不承载动作；绑定 `allowed_tags` 仍只看 server tag（动作不进 server tag）。因此本轮之后绑定层仍不能按动作限制工具；如果以后需要“某客户端只许读”，另加 `allowed_actions`，不在本 ADR 内。

## 备选方案

- **继续把动作用 tags 表示**：改动最小，但标签枚举继续混杂，动作规则只能靠提示词和约定；否决。
- **只用 MCP `annotations`，不建字段**：多数第三方 server 不声明注解，且当前没有入库；无法覆盖现有工具；否决。
- **复用 `type` 字段**：`type` 是单值兼容字段，动作需要集合，且 `type` 已被管理端弃用；否决。
- **直接硬切，不做 `excludeTags` 过渡**：会静默削弱写工具的排除能力，属于安全回归；否决。

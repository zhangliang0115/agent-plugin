# 开发规范

## 工具链

- Node `>=22.19`，pnpm（版本见根 `package.json` 的 `packageManager`）。
- TypeScript，ESM（`"type": "module"`）。
- 测试用 `node --test`（Node 原生支持 TS 类型擦除）。
- 仓库脚本（`scripts/*.ts`）用 `node` 直接运行，不加构建步骤。只用可擦除的 TS 语法（`erasableSyntaxOnly`：不用 enum、namespace、参数属性）。
- 构建工具（发布 npm 需要产出 JS）随第一个要发布的包一起决定，写 ADR。

## 命名

| 对象 | 规则 | 例子 |
|---|---|---|
| 插件 id / 目录名 | kebab-case；不以 `claude-`、`anthropic-` 开头 | `code-mode` |
| workspace 包名 | `@agent-plugin/<id>-<host>`，core 为 `@agent-plugin/<id>-core` | `@agent-plugin/code-mode-dsh` |
| 宿主目录名 | 固定为 `claude-code`、`dsh`、`pi` | |
| 工具名（给模型看） | snake_case，跨宿主一致 | `run_code` |

对外发布的 npm 包名和 scope 在第一次发布时决定（见 [issue #4](https://github.com/zhangliang0115/agent-plugin/issues/4)）。

## 版本

- 每个插件一个 semver 版本，`plugin.meta.json`、各宿主 manifest 和包的 `package.json` 保持一致。
- 0.x 阶段允许破坏性变更，但要写进 CHANGELOG。
- 改了某个宿主的锁定版本，同时更新 `docs/hosts/<host>.md` 的核对版本。

## 提交

- 格式：`<type>(<scope>): <描述>`，描述可用中文。
- type：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`。
- scope：插件 id，或插件 id/宿主，或仓库区域（`docs`、`scripts`、`portable`）。例：`feat(code-mode/dsh): 注册 run_code 工具`。
- 一个提交只做一件事；文档变更和它描述的代码变更放在同一个提交。
- 未经用户确认不 commit、不 push。

## 依赖与安全

- 不提交密钥、`.env`、真实 token。
- 运行时依赖锁定精确版本。宿主提供的包（如 Pi 的 `@earendil-works/*`、DSH 的 `@deepseek-ai/*`）按各宿主笔记处理，不要重复打包。
- 插件访问网络必须在插件 README 里写明目标主机，并且地址可配置。
- 发布包用 `files` 白名单，不发布整个目录。

## 文档职责

开发中产生的信息放到固定位置，不留在聊天记录里：

| 信息 | 位置 |
|---|---|
| 在方案之间做了选择 | `docs/decisions/NNNN-*.md`（规则见 [decisions/README](decisions/README.md)） |
| 宿主 API 的事实 | `docs/hosts/<host>.md` |
| 宿主/工具行为与预期不符、规则不好用 | `friction.md` |
| 需求、调研、问题反馈、尚未决定的问题 | GitHub issue（规则见 [issues.md](issues.md)）；决定后结论写进 ADR 或对应文档，issue 里放链接 |
| 插件的用法、限制 | `plugins/<id>/README.md` |
| 插件在每个宿主上的安装步骤（给 agent 执行） | `plugins/<id>/INSTALL.md`（规则见下面「安装文档」） |
| 开发本仓库的可复用操作步骤 | `.kiro/skills/<name>/SKILL.md`（规则见下面「Skills」） |
| 插件的版本变更 | `plugins/<id>/CHANGELOG.md` |
| agent 需要遵守的规则 | `AGENTS.md`（唯一来源） |

## 新增一个插件

1. 写 `plugins/<id>/README.md` 和 `plugin.meta.json`。
2. 写 core 和它的失败测试，再写实现。
3. 每个支持的宿主：写 adapter 契约测试 → 实现 → 按宿主笔记做一次冒烟。
4. 写 `INSTALL.md`，并在每个支持的宿主上按它从头装一遍、跑一遍验证命令。
5. 如果这是某个宿主的第一个 adapter，在同一个任务里写 `write-<host>-adapter` skill（见「Skills」）。
6. 更新 CHANGELOG，重新生成能力矩阵。

## Skills

开发本仓库用的 skill（给 Kiro 和 Claude Code 共用），不是插件对外提供的 skill。

### 位置

- 真实文件放在 `.kiro/skills/<name>/SKILL.md`，格式遵循 Agent Skills 标准（YAML frontmatter 的 `name`、`description` + Markdown 正文）。
- `.claude/skills` 是指向 `../.kiro/skills` 的软链接，不要改成真实目录，也不要在里面单独加文件。
- 原因：Kiro 不跟随软链接，Claude Code 跟随（2026-11-15 实测，见 `friction.md`）。
- Kiro 只在工作区被设为可信后才加载 `.kiro/skills/`。

### 什么时候写

- 某个宿主的第一个 adapter 跑通后，同一个任务里写 `write-<host>-adapter`，内容是这次实际走通的步骤。
- 同一类操作第二次出现、并且步骤可以固定时（例如新建插件骨架、宿主升级后的重新核对）。
- 不为还没做过的操作写 skill。

### 写法

- `name` 用 kebab-case，等于目录名。`description` 写清楚做什么、什么时候用，包含用户会说的关键词。
- 正文只写操作顺序和每一步的检查点（跑什么命令、预期看到什么）。
- 宿主事实引用 `docs/hosts/<host>.md`，规范引用 `docs/conventions.md`，不复制内容。
- 确定性的步骤（生成文件、校验）写成脚本放在 skill 的 `scripts/` 下，或者调用 `scripts/` 里的仓库脚本。
- 用 skill 时发现步骤错了或过期了，先记 `friction.md`，同一个任务里修好 skill。

## 安装文档

每个插件一份 `plugins/<id>/INSTALL.md`，每个 `supported` 或 `experimental` 的宿主一节。读者是 agent：它会照着逐条执行，把插件装进用户的宿主里。

### 写法

- 每条命令能直接复制运行。不写"按需修改""视情况而定"。
- 需要用户提供的值用 `<占位符>`，并写明怎么取值（例如"`<repo>` 是本仓库的绝对路径，用 `git rev-parse --show-toplevel` 获取"）。
- 每一步写清楚在哪个目录执行。
- 验证命令必须给出预期输出，让 agent 能判断成功还是失败。
- 失败时的常见原因和处理写在该节末尾，参考 `docs/hosts/<host>.md` 的已知问题。

### 同步规则

以下改动必须在同一个提交里更新 INSTALL.md：

- 包名、入口、`files`、manifest（`plugin.json`、`cordis.patch.yml`、`dsh.bundle`）
- 需要的配置项、环境变量、权限
- 锁定的宿主版本或 Node 版本
- 新增或移除对某个宿主的支持

交付时贴出按 INSTALL.md 实际执行验证命令的输出。没有在真实宿主上跑过的那一节，在节标题后标注 `（未实测）`。

### 模板

```markdown
# 安装 <插件名>

## <宿主名>

### 前置条件
- <宿主> 版本：`>= x.y.z`（检查：`<命令>`，预期输出：`...`）
- Node：`>= 22.19`（检查：`node -v`）

### 安装
在 `<目录>` 执行：
（命令）

### 配置
| 名称 | 是否必填 | 说明 | 取值方式 |
|---|---|---|---|

### 验证
（命令）
预期输出：（输出或判断条件）

### 卸载
（命令）

### 常见问题
- 现象 → 原因 → 处理
```

## 新增一个宿主

1. 按模板写 `docs/hosts/<host>.md`，并在 `docs/hosts/README.md` 登记。
2. 写 ADR，说明为什么支持、锁定哪个版本。
3. 在每个已有插件的 `plugin.meta.json` 里加上该宿主（`supported` 或 `unsupported` + 原因）。
4. 该宿主的第一个 adapter 跑通后，写 `write-<host>-adapter` skill（见「Skills」）。

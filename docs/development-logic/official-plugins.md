# 官方插件化：把内置模块接到同一套贡献点上

状态：P0–P4 已实现（2026-11-13～14，分支 `codex/release-0.4.89`：fb6a8cdc P0+P1、f4d8f105 P0 欠账、
3d14d249 P2/P4/P3、第四批收尾），实现记录见文末。剩余：P5（另写设计稿）。
基于工作区 `codex/docx-upstream-acceptance`
（e80513eb）和尚未提交的插件工作（AI 自建插件 M1–M3、DIY 第一层与第三层）。
相关文档：[插件包与信任锚](deepseek-plugin-packages.md)、
[Chat UI 插件](chat-ui-plugins.md)、[Agent 自建插件](agent-authored-plugins.md)、
[插件能力清单](plugin-capabilities.md)。

## 目标

LaTeX（Typeset）、Figures、文献库、邮箱现在各自直接接进宿主：`App.tsx` 写死导航，
`engine.rs` 写死工具，`system_prompt.rs` 写死提示词片段，runtime 里写死工具名。
本设计让它们成为**官方插件**：和用户插件使用同一套"贡献点"声明，并按同一套规则
启用、停用、冻结到回合。两者的区别只在执行方式和信任来源。

要解决的问题有三个：

1. **扩展点不够用，而且只有官方能用。** 用户插件现在只能贡献 MCP 服务、Skill、
   三个槽位的面板（`PluginCapabilities`，`crates/runtime/src/plugins/mod.rs:94`）。
   官方模块用的是另一条私有通道，所以插件 API 一直不会被真实需求逼着长大。
2. **不用的模块也在吃上下文。** 工具列表不按项目或模块过滤。
   `DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS` 是空的（`desktop/src-tauri/src/engine.rs:946`），
   LaTeX 和文献检索的提示词片段也每回合无条件进入
   （`desktop/src-tauri/src/system_prompt.rs:234-248`）。
3. **模块之间的依赖是隐式的。** 例如邮箱依赖文献检索（`mail_literature_catch_up`），
   Typeset 依赖文献库生成引用键，这些依赖只能读代码才知道。

可观察的成功标准：

1. 四个模块各有一份官方插件清单。导航、设置页、Agent 工具、提示词片段、文件打开
   方式、后台服务、项目切换守卫都从清单注册，`App.tsx` 和 `all_tool_specs_for`
   里不再写模块名。
2. 在设置里关掉邮箱后，从下一回合起以下几项一起消失，重新打开后全部恢复：
   导航入口、设置页、8 个 `mail_*` 工具、chat 路由的 mail 分组、新邮件监听，
   以及定时任务的"新邮件"触发（触发改为提示"邮箱插件已关闭"）。
3. 四个插件都启用时，模型看到的工具名、顺序、schema 与改造前完全一致，系统提示词
   逐字节一致。这一条用快照测试钉住，否则提示词缓存会被改造本身打穿。
4. 回合开始时冻结的插件集（`PluginRun`）里包括官方插件的开关状态，并写入会话事件
   `plugin_set`。回合进行中改开关，只影响下一回合。
5. 关掉一个插件不会让依赖它的东西静默失效：依赖方要么跟着隐藏，要么给出明确提示。
   提示的写法统一为"需要 X 插件"。
6. runtime 不再写死文献工具名。`retrieval_role` 和失败分类器都改成读工具贡献上的
   声明字段。

## 非目标

- 不把官方插件放进用户插件的沙箱。Typeset 前端约 2.56 万行，用到 CodeMirror、PDF
  渲染和 SyncTeX，放进无网络的双层 iframe 不可行，也没有必要：它的代码本来就随应用
  签名发布。
- 不做原生代码的动态加载（dylib）。官方插件仍然编译进应用。
- 不拆 crate。先立目录边界和注册表，等编译时间成为问题再说（见 D5）。
- 本期不新增用户插件能用的贡献点。下面的分期表会写明哪些点以后可以开放。

## 现状（已核实）

### 宿主侧

| 方面 | 现状 | 位置 |
| --- | --- | --- |
| 用户插件能贡献的东西 | Skill、MCP 服务、面板（槽位只有 `chat.sidebar`、`nav.page`、`chat.brief`） | `runtime/src/plugins/mod.rs:94-100`、`ui.rs:282-286` |
| 生命周期 | 共七态：installed、approval-required、blocked、enabled、running、failed、needs-restart | `plugins/lifecycle.rs:351-360` |
| 回合冻结 | Chat 回合在开始时冻结插件集，WorkTask 也冻结 | `engine.rs:9286-9295`、`work_task/engine.rs:579` |
| 工具列表 | 一张静态表 `mvp_tool_specs`，Desktop 再追加邮箱、PluginManager 等工具；没有按项目过滤 | `tools/src/lib.rs:288`、`engine.rs:3009-3059` |
| 工具路由 | 按关键词决定每回合给模型哪些工具 schema（mail、research、drawing 等分组），没有 LaTeX 分组 | `chat/src/lib.rs:546-639`、`:1334-1348` |
| 提示词片段 | `local_evidence_retrieval`、`diagram_output`、`latex_toolchain` 都无条件加入 | `system_prompt.rs:234-248` |
| 导航 | `PRIMARY_NAV_ITEMS` 写死 8 个模块，前 6 个上导航栏；插件页借用 `extensions` 标签 | `App.tsx:285-348`、`:516-519` |
| 设置页 | 只有邮箱有设置页；`LiteratureSettings.tsx` 只被测试引用，没挂上 | `settings/settingsNav.tsx:118-141`、`Settings.tsx:289-293` |
| 文件打开 | `.tex` 打开 Typeset，`.pdf` 和图片在侧栏打开，代码文件打开 Code 页 | `editor/workspaceFiles.ts:80-88`、`chat/openChatFile.ts:25-53` |
| 失效的开关 | Desktop 设置了 `ARIS_ALLOWED_TOOLS`，crates 里没有非测试代码读取它 | `state.rs:230` |

### 四个模块的接线点

| | 邮箱 | Figures | 文献库 | LaTeX（Typeset） |
| --- | --- | --- | --- | --- |
| Tauri 命令 | 11 个（`lib.rs:1025-1035`） | 20 个（`lib.rs:953-972`），外加 URI scheme `somniq-figure`（`lib.rs:662`） | 49 个（literature）、10 个（paper_reading），另有 knowledge | typeset、typeset_state、typeset_audit |
| Agent 工具 | 8 个 `mail_*`（`mail/agent_tools.rs:9-18`），在 Desktop 注入、分派 | 没有工具，经 `figure_connections` 走模型（`engine.rs:5067`） | 13 个 Literature*/Retrieval*/LibraryRetrieve，外加 ProjectEvidenceSearch | `LaTeXCompile`、`LaTeXRender`（`tools/src/lib.rs:1287`、`:1317`） |
| 后台与启动 | 启动时 `spawn_event_watchers`（`lib.rs:809`），新邮件触发定时任务（`mail/events.rs:84` → `scheduled.rs:1437`） | 全局表 `active_runs`，事件 `figures-updated` | 设置研究账号提供方（`lib.rs:748-750`）；ChatState 有 `retrieval_checkpoints` | 无 |
| 被外部前端引用 | 只有 `App.tsx`；另有 `scheduled/ScheduledTasks.tsx` 调 `mailAccountsGet` | `App.tsx`（项目切换守卫 `figureDirty`、运行计数）、`useAccountRefresh.ts` | Typeset、Workflows、`chat/SideFileViewer.tsx`（借用 PdfReader）、`knowledge/knowledgeStore.ts`、`chat/toolSummaries.ts`（按输出结构解析） | `editor/` 的 LaTeX 折叠、检查、悬浮提示用 `scanLatexStructure`；`CodeEditor.tsx` 用文案；`PluginUpgradeReview.tsx` 用 `externalTextDiff` |
| 核心层写死的知识 | chat 路由的 mail 分组 | runtime/chat/tools 各有 `figures` 模块 | `retrieval_guard.rs::retrieval_role`（:2513）、`tool_outcome.rs::classifier`（:50）、`conversation.rs` 的 RetrievalGuard、`skill_registry.rs` 的 literature-* Skill、工作流阶段允许清单 `WORKFLOW_RETRIEVAL_TOOLS`（`engine.rs:961`） | `tool_outcome` 分类器、`system.md` 的图示段落 |
| 依赖其他模块 | **依赖文献检索**：`mail/auto_literature.rs:349-400` 调 `literature_search_ad_hoc_at` 和下载函数；依赖定时任务 | 依赖账号：托管凭据、`newapi::is_approved_managed_base`、`managed_figure_reviewer` | 依赖账号：会员限制 `membership::external_literature_denial`、Scopus 学校通道 | 依赖文献库：引用键、`literatureExportBibliography`（`Typeset.tsx:110`、`:2289`） |
| 磁盘数据 | `<config>/mail/accounts.json`（令牌为明文 JSON）、`mail/cache/` | `<ws>/.somniq/artifacts/figures/<id>/` | `<ws>/.somniq/literature/literature.sqlite3`、`papers/`、RAG 索引、`knowledge.db` | 项目里的 `.tex` 文件 |

结论：邮箱最接近叶子模块，适合当试点，但它依赖文献检索。文献库被五个地方依赖，
本身就是核心证据链，不能整个做成能关的插件。

## 设计

### 1. 三层：核心服务、官方插件、用户插件

| 层 | 能否关闭 | 执行方式 | 信任来源 | 例子 |
| --- | --- | --- | --- | --- |
| 核心服务 | 不能 | 进程内 | 应用本身 | 项目、会话、编辑历史、账号与会员、**研究证据服务**、PDF 阅读器、LaTeX 语言库 |
| 官方插件 | 能，部分可设为必需 | 进程内，Rust trait 实现加前端懒加载模块 | 编译进应用，不需要批准 | 邮箱、Figures、文献库（界面和检索源）、LaTeX（Typeset） |
| 用户插件 | 能 | MCP 子进程，页面放在沙箱 iframe | 本机批准，批准绑定摘要 | 现有 `package.json` + `somniq` / `dsh` |

官方插件和用户插件共用的是：清单的数据形状、贡献点名称、"请求 ∧ 本机允许"的启用
规则、回合冻结、在插件页的展示方式。不共用的是执行方式。

### 2. 贡献点

官方插件的清单是编译期的静态数据（Rust 侧 `&'static BuiltinManifest`，前端侧
`officialPlugins.ts`），字段如下：

| 贡献点 | 内容 | 官方插件 | 用户插件现状 | 以后可开放给用户 |
| --- | --- | --- | --- | --- |
| `nav` | 导航入口：标签、图标、顺序、懒加载组件、是否预取、是否常驻（`heavyTabs`） | 是 | `nav.page`（沙箱页） | 已有 |
| `settings` | 设置页：分组与组件 | 是 | 无 | 声明式表单（P5） |
| `tools` | Agent 工具：spec、执行函数、路由关键词、`retrievalRole`、失败分类器、会员限制、是否只读 | 是 | 经 MCP 提供工具，没有路由、角色等声明 | 路由关键词、`retrievalRole`（P5，需审查） |
| `skills` | 内置 Skill，可声明 `requires` | 是 | 有 | 已有 |
| `promptSections` | 系统提示词片段，插件启用时才加入，顺序固定 | 是 | 无 | 不开放（提示词注入风险） |
| `fileOpeners` | 文件类型到打开方式的映射 | 是 | 无 | 只读预览页（P5） |
| `triggers` | 定时任务触发源，例如"新邮件" | 是 | 无 | 以后再议 |
| `services` | 启动和停用时的后台服务，例如邮件监听 | 是 | 无 | 不开放 |
| `guards` | 项目切换守卫：未保存内容、运行中任务 | 是 | 无 | 不开放 |
| `uiPanels` | `chat.sidebar`、`chat.brief` 面板 | 可选 | 有 | 已有 |
| `requires` | 依赖的核心服务或其他插件 | 是 | 无 | 是（依赖闭包，九方向之一） |

Rust 侧接口草案：

```rust
pub trait BuiltinPlugin: Send + Sync {
    fn manifest(&self) -> &'static BuiltinManifest;        // id、名称、requires、默认开关、范围
    fn tool_specs(&self) -> Vec<ToolSpec> { Vec::new() }
    fn execute_tool(&self, name: &str, input: &Value, ctx: &ToolCtx) -> Option<Result<String, ToolError>> { None }
    fn prompt_sections(&self, key: &PromptKey) -> Vec<PromptSection> { Vec::new() }
    fn start(&self, app: &AppCtx) {}                      // 启动或被打开时
    fn stop(&self, app: &AppCtx) {}                       // 被关掉时
}

pub static BUILTIN_PLUGINS: &[&dyn BuiltinPlugin] = &[&MAIL, &FIGURES, &LITERATURE, &LATEX];
```

工具的声明字段放在 `ToolSpec` 的扩展上，例如 `ToolSpec { retrieval_role, failure_classifier, membership_gate, .. }`，
也可以放在旁边的一张表里。`retrieval_guard.rs::retrieval_role` 和 `tool_outcome.rs::classifier`
改为先查这张表，查不到再回落到现有的 match。内核工具（bash、WebSearch 等）仍留在原处。

前端侧把 `PRIMARY_NAV_ITEMS` 中的模块项、`renderedTab` 里的挂载、`Settings.tsx` 的
邮箱分支都改为遍历 `officialPlugins.ts`。`store.ts` 的 `Tab` 联合类型保留官方插件 id，
因为 id 在编译期已知，类型检查不能丢。

### 3. 启用状态存在哪里

工作区内容永远不足以运行任何东西，这条信任锚不变（见
[插件包与信任锚](deepseek-plugin-packages.md)）。官方插件虽然都是可信代码，但打开邮箱就等于
让模型能以用户身份发信，所以开关也不能放进工作区：

- 全局默认值存 `<config>/plugins/builtin.json`。
- 按项目的覆盖值存同一个文件，键为项目的规范路径，和 `approvals.json` 的做法一致。
- 工作区的 `registry.json` 只能**请求关闭**官方插件，不能请求打开。仓库可以表达
  "这个项目不需要邮箱"，但不能替用户打开邮箱。
- 现有的 `hideMail`（`store.ts:380`）只管隐藏导航。迁移时它变成邮箱插件的全局默认值：
  隐藏即关闭。迁移前先告诉用户，关闭会同时去掉工具和监听。

每个插件声明范围：

- `user`：邮箱。账号是用户级的，默认全局开关，可以按项目覆盖。
- `project`：Figures、LaTeX、文献库界面。默认全部开，按项目开关。

### 4. 冻结与提示词缓存

- `PluginSet` 增加 `builtin: BTreeMap<&'static str, bool>`，在
  `state::begin_plugin_run` 里一起冻结，并写进会话事件 `plugin_set`。
- 工具列表、提示词片段、路由分组都只读冻结集，回合中途不变。
- 工具顺序固定为"内核工具 → 官方插件（按清单顺序）→ Desktop 交互工具 → 用户插件 MCP"。
  开关一个插件只会删掉连续的一段，不会打乱其余部分的顺序。这样能尽量保住提示词
  缓存的前缀。
- 改造第一步（P0）加快照测试：四个插件全开时，`all_tool_specs_for` 的名字、顺序、
  schema 和系统提示词字节与改造前完全一致。

### 5. 依赖与降级

`requires` 只能指向核心服务，或者用 `plugin:<id>` 指向其他官方插件。宿主在冻结
插件集时计算闭包：

| 依赖方 | 依赖 | 被依赖方关闭时 |
| --- | --- | --- |
| 邮箱的 `mail_literature_catch_up` 和自动文献追踪 | `plugin:literature`（检索源） | 去掉这个工具，邮箱设置里的"自动追踪文献"显示"需要文献库插件" |
| 定时任务的新邮件触发 | `plugin:mail` | 已有任务标记"邮箱插件已关闭"，不删除，也不运行 |
| Typeset 的引用插入和 `.bib` 导出 | 核心：研究证据服务 | 不受影响，因为依赖的是核心 |
| 工作流模板（综述等） | 声明所需插件 | 启动时拒绝并说明，不允许缺工具硬跑；阶段允许清单与冻结集取交集 |
| 内置 Skill（`literature-search` 等） | `requires: plugin:literature` | 从提示词的 Skill 列表隐藏，`Skill` 工具也拒绝加载 |
| 独立 Reviewer | 核心证据工具 | 不受影响。Reviewer 的工具集来自核心，不随插件开关变化，独立审阅链路不能因此断开 |

历史会话里如果有已关闭插件的工具调用，工具卡片照常渲染，因为渲染只读事件，
不需要插件在线。

### 6. 文献库怎么拆

文献库拆成核心服务、官方插件、检索源三部分：

**核心：研究证据服务（不能关）**
- `literature.sqlite3` 存储、引用键、`.bib` 导出（Typeset 依赖它）。
- `LibraryRetrieve`、`RetrievalPlan`、`RetrievalCorpusSeal`、`RetrievalEvidence`、
  `RetrievalLedger`、`ProjectEvidenceSearch`。
- `retrieval_guard` 和证据账本。
- PDF 阅读器：从 `literature/` 移到 `pdf/`。Chat 侧栏和以后的 Studio 都复用它。

**官方插件：文献库（能关）**
- 文献库页面、文献设置页（顺手把孤立的 `LiteratureSettings.tsx` 挂上去）。
- `LiteratureSearch`、`LiteratureCitations`、检索协议三件套、`LiteratureLibraryUpsert`、
  两个下载工具。
- 会员限制保持由宿主判断，作为工具声明里的 `membership_gate`。

**检索源契约（P3 定义，P5 开放）**
- OpenAlex、arXiv、Scopus 学校通道等，每个都是 `LiteratureSource` 的实现。
- 契约：输入一个结构化检索式，输出规范化记录（DOI、标题、作者、年份、来源、可下载
  地址）。分页、限流、去重、`MAX_PAPERS` 都由宿主统一负责。
- 用户插件以后可以经 MCP 工具实现同一契约，例如知网、本校图书馆。宿主负责调用和
  校验输出，模型看到的仍然只有 `LiteratureSearch` 一个工具，不会每多一个源就多一个工具。

### 7. LaTeX 怎么拆

- `scanLatexStructure` 等 LaTeX 语言能力从 `typeset/` 移到 `editor/latex/`，变成核心库。
  Code 页的编辑器和 Typeset 都依赖它，方向从"editor 依赖 typeset"改成"两者都依赖核心"。
- `externalTextDiff` 移到共享工具目录，插件升级审阅不再引用 typeset。
- 官方插件 LaTeX 包含：Typeset 页面、`LaTeXCompile`、`LaTeXRender`、
  `latex_toolchain` 提示词片段、`.tex` 打开方式，以及新增的 LaTeX 路由分组。
- `diagram_output` 片段拆成两段：通用图示说明留在核心，TikZ 和 `LaTeXCompile` 那句
  归 LaTeX 插件。`system.md` 第 45-50 行同样处理。

### 8. Figures 怎么拆

- 页面、20 个命令、`figure_connections` 归插件。
- URI scheme 必须在构建 Tauri 时注册，所以 `somniq-figure` 始终注册，插件关闭时返回 404。
- `figureDirty` 和运行计数改由 `guards` 贡献点提供，`App.tsx` 不再写 Figures 的名字。
- `requires: core:account.managed`。未登录时插件仍可打开，生成按钮提示登录，和现在一样。
- `useAccountRefresh` 改为订阅通用事件"计费请求完成"，不再引用 figures。

### 9. 插件页的展示

官方插件出现在插件页，带"官方"标记。可以关闭，不可卸载，不显示批准卡片。
必需的插件（目前没有）显示为灰色开关。

## 分期

| 期 | 内容 | 验收 |
| --- | --- | --- |
| P0 注册表骨架 | `BuiltinPlugin` trait、`BUILTIN_PLUGINS`、前端 `officialPlugins.ts`；四个插件全部声明、全部开；`all_tool_specs_for`、`renderedTab`、导航、`system_prompt.rs` 改为遍历注册表；`PluginSet.builtin` 冻结 | 工具和提示词快照与改造前逐字节一致；全套测试通过；应用内导航、设置页没有可见变化 |
| P1 邮箱试点 | 开关（全局加项目覆盖）；`services` 启停监听；`triggers` 接定时任务；`hideMail` 迁移；`mail_literature_catch_up` 声明依赖 | 成功标准第 2 条逐项在应用内实测；关掉后下一回合的 `plugin_set` 和工具列表里都没有邮箱 |
| P2 Figures | `guards` 贡献点、计费事件、URI scheme 关闭时返回 404 | 关闭后切换项目不再检查 figureDirty；打开后行为不变 |
| P3 文献库拆分 | PdfReader 移到 `pdf/`；工具声明字段替换 `retrieval_role` 和分类器里写死的名字；Skill `requires`；工作流声明所需插件；`LiteratureSource` 契约和现有源的迁移 | 成功标准第 5、6 条；关闭文献库插件后，Reviewer、`LibraryRetrieve`、Typeset 引用都正常 |
| P4 LaTeX | 语言库移到 `editor/latex/`；提示词片段条件化；LaTeX 路由分组；`.tex` 打开方式注册 | 关闭后 `.tex` 改用 Code 页打开，提示词里没有 TeX Live 段落 |
| P5 开放给用户插件 | 检索源契约经 MCP 开放；声明式设置页；`fileOpeners` 只读预览页 | 另写设计稿，接在[插件能力清单](plugin-capabilities.md)之后 |

前置条件：AI 自建插件 M1–M3、DIY 第一层与第三层、能力清单 C1/C2 都会改
`plugins/mod.rs`、`lifecycle.rs`、`engine.rs`、`App.tsx`。这些改动入库前不开工，
避免在未提交的大块改动上再叠一层。

## 决定（2026-11-13 用户确认：D1–D6 全部按建议值）

- **D1 开关粒度。** 建议全局默认加按项目覆盖；备选是只按项目。
- **D2 文献库插件能不能关。** 建议能关，但关掉的只是页面和检索源，核心证据服务始终在；
  备选是设为必需。
- **D3 开关存哪里。** 建议存用户配置，工作区只能请求关闭；备选是存工作区，但这样
  违反信任锚。
- **D4 `hideMail` 迁移语义。** 建议"隐藏即关闭"，迁移时给一次性提示；备选是保留
  "只隐藏导航"作为第三种状态。
- **D5 是否拆 crate。** 建议本期不拆，只立目录边界；等编译时间成为问题再拆成
  `crates/plugin-*`。
- **D6 会员档位与插件的关系。** 建议本期不把会员档位做成插件开关，会员限制仍是工具
  声明里的 `membership_gate`；以后可以做"某档位才显示某插件"。

## 风险

- **提示词缓存。** 用户频繁开关插件会让缓存前缀失效。缓解：固定顺序、回合冻结，
  另外在插件页提示"从下一回合生效"。
- **静默失效。** 工具名写死的地方不止 runtime，前端 `chat/toolSummaries.ts:235` 也按
  文献工具的输出结构解析。P3 要全仓 grep 工具名，逐个改为读声明或标为核心。
- **工作流。** 自主工作流自建工具表（`engine.rs:957-974`）。如果不和冻结集取交集，
  关掉的插件会在工作流里"复活"。
- **Reviewer 被牵连。** 必须有测试钉住：关闭任意官方插件后，Reviewer 的工具集不变。

## 顺带发现（不在本期范围）

- 邮箱令牌以明文 JSON 存在 `<config>/mail/accounts.json`（`mail/store.rs:1-4`），
  没有用钥匙串。托管 key 已经走钥匙串，邮箱可以照做。
- `settings/LiteratureSettings.tsx` 只被测试引用，用户进不去这个设置页。P3 核实为 0.4.62 有意移除，
  附件命名模板因此没有入口，是否恢复待用户决定。
- ~~`ARIS_ALLOWED_TOOLS` 由 Desktop 设置，但没有非测试代码读取它。~~ 2026-11-14 复核：主代码里已经没有它了。

## P0 + P1 实现记录（2026-11-13）

D1–D6 按建议值实现，用户已于 2026-11-13 确认。D4 的实际做法见下文"与设计稿不同的地方"：没有一律"隐藏即关闭"，而是按有无邮箱账号决定初始值。

### 做了什么

**Runtime（`crates/runtime/src/plugins/builtin.rs`，新文件）**
- `BUILTIN_PLUGINS` 四份清单（literature、latex、figures、mail）。字段：`scope`、`toggleable`、`default_enabled`。只有 mail 可关闭，其余三个 `toggleable: false`，等各自那一期把接线点搬到注册表后再放开。
- 开关存 `<config>/plugins/builtin.json`，格式为 `{schema, global, projects}`，写入时加进程内路径锁和 `builtin.lock` 文件锁。工作区里没有任何能打开官方插件的东西。
- `PluginSet` 新增 `builtin_disabled`，在 `freeze` 里一起冻结，也写进会话事件 `plugin_set`。只有被关掉的插件进入指纹，所以"全开"的集合指纹与改造前一致（有测试钉住空集合仍是 SHA-256 空串）。
- 失败时的处理：
  - 注册表读不出：没有包可用，但官方开关照常生效。
  - 运行令牌未知：所有可关闭的官方插件按关闭处理。
  - 开关文件读不出：回落默认值，mail 为关闭，其余为开启。

**Desktop（`desktop/src-tauri/src/official_plugins.rs`，新文件）**
- `tool_owner` / `tool_requires`：8 个 `mail_*` 工具归 mail；`mail_literature_catch_up` 另外依赖 literature。
- 回合工具表：`tool_specs_for(blocked, worker_plugin_run.set())` → `all_tool_specs_with`，按插件整块删除，其余工具的顺序不变。
- 执行时：`KernelToolExecutor` 用 `tool_allowed_in(project_execution_context)` 拒绝已关闭插件的工具，报错写明需要哪个插件。
- 启动：`start_services` 先 `seed_builtin_global("mail", has_accounts())`，只在第一次没有值时写入；mail 开着才起监听。切换开关后启停监听（新增 `events::stop_all`）。`scheduled::on_new_mail` 在 mail 关闭时直接返回。
- 命令：`official_plugins_list`、`official_plugins_set`。后者只接受主窗口调用，写完发出 `official-plugins-changed` 事件。

**前端**
- `extensions/officialPlugins.ts`：API、类型、一次性迁移 `migrateMailVisibility`。
- `extensions/useOfficialPluginsSync.ts`：App 挂载一次，项目切换或收到事件时重读。
- `store.ts`：`hideMail` 在桌面应用里映射 mail 插件（关闭即隐藏），`setHideMail` 写后端；浏览器预览仍用 localStorage。原来的 `somniq-hide-mail` 只作首屏缓存。
- 插件页新增"官方插件"区（`OfficialPluginsSection.tsx`），四张卡片，只有 mail 的开关可用。
- 定时任务的邮件触发表单：mail 关闭时显示提示。

### 与设计稿不同的地方

- **mail 的默认值不是"隐藏即关闭"那么简单。** 原来新用户默认隐藏邮箱，但 8 个工具照样发给模型。直接按隐藏来关，会让"隐藏了导航、但连了账号、配了新邮件触发"的用户自动化静默失效。现在的规则：
  - 第一次启动时，有账号就开，没账号就关。
  - 之前明确选了"显示邮箱"、但没有账号的用户，由前端迁移打开一次。
  - 结果：没有邮箱的用户不再为邮箱工具付 token；有邮箱的用户行为不变，导航里会重新出现邮箱入口。
- **P0 的前端导航没有改成遍历注册表。** `PRIMARY_NAV_ITEMS` 仍然写死，只是邮箱的显隐来自插件状态。真正把导航项搬进清单，留到 P2（Figures 需要 `guards`，那时一起做）。
- **提示词片段没动。** mail 本来就没有提示词片段，现在可关闭的插件只有 mail，所以 P0 的提示词快照测试没有对象。LaTeX、文献的片段在 P3、P4 条件化时再补快照测试。
- **mail 只开放全局开关。** 存储和解析都支持按项目覆盖（有测试），但界面只写 global。按项目开关等 Figures（project 范围）一起开放。
- **工作区"请求关闭"没做。** 现在只能在本机设置里关。

### 验证

- runtime：`plugins::builtin` 7 个新测试；`plugins::` 全部 50 个通过。
- desktop：3 个新测试。全开时工具表与原来一致；关掉 mail 恰好去掉 8 个工具、其余顺序不变；`mail_literature_catch_up` 依赖 literature。
- 前端：`officialPlugins.test.tsx` 5 个新测试；`store`、`Settings`、`Extensions` 原有测试通过；`tsc` 通过。
- 全套：
  - runtime 974/974；
  - 前端 2355/2355（`--maxWorkers=4 --minWorkers=1`）；
  - `npm run build` 通过；
  - desktop 1058/1059。唯一失败是 `system_prompt::the_completion_contract_only_promises_a_reviewer_that_will_run`，与本改动无关：31511e6e（0.4.88 Word 工作流）往 `system.md` 写了一句无条件的 "independent Reviewer"。
- 应用内实测（debug 版，隔离的 `ARIS_CONFIG_ROOT` 和 WebView2 目录，账号调用打桩，没有碰用户正在运行的正式版）：
  - 首次启动在没有邮箱账号的配置下写入 `{"global":{"mail":false}}`。
  - 插件页显示四张官方卡片，只有 Mail 的开关可用。
  - 打开 Mail：`builtin.json` 变为 true，"更多模块"菜单出现 Mail。
  - 关闭 Mail：菜单里的 Mail 消失，文件变回 false。
  - 截图在 `E:/tmp/official-plugins/`。
- 没有验证到的：
  - 真模型回合里工具表确实少了邮箱工具（需要登录；只有单测覆盖）；
  - IMAP 监听启停（隔离配置里没有邮箱账号）。

## P0 欠账补完（2026-11-13，第二批，在 fb6a8cdc 之后）

- **导航从清单生成。** 官方模块的导航项（图标、顺序）搬进 `extensions/officialPluginNav.tsx`；`App.tsx` 只保留核心模块（chat、lab、extensions、workflows），两张表按 `order` 合并，顺序与之前完全一样。关掉的官方插件在切分导航栏之前就被滤掉，后面的模块会顶上来。当前页属于被关插件时自动回到 Chat。`ModuleIcon` 移到 `ModuleIcon.tsx`。
- **提示词片段条件化。** `SystemPromptCacheKey` 新增 `builtin_disabled`，取当前执行上下文冻结的集合。
  - `local_evidence_retrieval` 归 literature。
  - `latex_toolchain` 归 latex。
  - `diagram_output` 在 LaTeX 关闭时换成一段写明的、不含 TikZ 的版本。
  - 全开时提示词逐字节不变：改动前后两种审阅模式下的长度和哈希都一致（40201/39667 字节）。
  - 测试钉住"关掉谁只少谁的片段；关 mail 提示词不变"。
  - `system.md` 自带的 "Explanatory diagrams" 段仍然无条件，留给 P4。
- **工作流工具表。** 自主工作流的阶段允许清单再与冻结集取交集。
- **内置 Skill 依赖。**
  - `bundled_skill_plugin`：literature-search/screen/evidence → literature；latex-diagrams、paper-compile → latex。
  - 插件关闭时，这些 Skill 既不出现在提示词的 Skill 列表里，`Skill` 工具也拒绝加载。用户自己的同名 Skill 不受影响。
  - 有测试防止映射里的名字和内置 Skill 脱节。
  - 目前这两个插件还不能关，所以这部分实际上处于休眠状态。
- **Reviewer 工具不变。** 测试钉住 `REVIEWER_TOOLS`（Read/Grep/Glob）不归属任何插件、也不依赖任何插件，所有插件都关掉时仍然全部可用。
- **按项目开关。** 插件页可关闭的插件下面加了"在本项目"选择：跟随全局 / 本项目开启 / 本项目关闭。普通的开关点击写到"能生效的那一层"（`switchTarget`）：已有项目覆盖、或项目自己要求关闭时写项目覆盖，否则写全局。设置页的邮箱开关也走这条路，并补了说明文字。
- **工作区请求关闭。** 项目可以在 `.somniq/plugins/official.json` 写 `{"disable": ["mail"]}`。
  - 生效优先级：本机项目覆盖 > 项目请求关闭 > 全局 > 默认。
  - 这个文件只能关、不能开；文件损坏、是符号链接、或写了未知 id，一律忽略。
  - 插件页会提示"这个项目要求关闭"。
  - 新邮件监听仍然只看全局开关，因为邮箱账号是用户级的。

验证（第二批）：
- 全套：
  - runtime 976/976；
  - tools 337/337；
  - 前端 2359/2359；
  - 构建、debug exe 通过；
  - desktop 1060/1061，唯一失败仍是 31511e6e 引入的 `the_completion_contract_only_promises_a_reviewer_that_will_run`。
- 应用内实测（隔离实例）：
  - 全局打开邮箱。
  - 再放入 `{"disable":["mail"]}`：卡片变为 Off，并显示项目请求的说明。
  - 点开关：写入的是本机项目覆盖（project=true），"更多模块"出现 Mail。
  - 改回"跟随全局"：又变回 Off。
  - 截图在 `E:/tmp/official-plugins/`（project-request-off.png、project-on-more.png）。

## P2 / P4 / P3 实现记录（2026-11-13，第三批，在 f4d8f105 之后）

做的顺序是 P2 → P4 → P3：P4 比 P3 小，P3 碰证据链，放在最后。四个官方插件现在都可以关闭。

### P2 Figures

- 改为可关闭，范围是项目。关掉后，四个会花钱的命令（`figures_start`、`figures_review`、`figures_edit_image`、`figures_edit_svg`）用 `official_plugins::require_in` 拒绝。`somniq-figure` 协议仍在启动时注册，当前项目关闭 Figures 时返回 404。
- `guards` 贡献点落在 `extensions/officialPluginGuards.ts`：
  - `projectSwitchBlocker`、`officialPluginsHaveUnsavedWork`、`officialPluginCloseHazards`；
  - `startOfficialPluginWatchers`：跟踪运行中的绘图任务数，并在计费请求结束时发 `somniq:billed-request-finished`。
  - `App.tsx` 不再引用 `figureDirty`、`figuresRunningCount`、`onFigureUpdated`。`useAccountRefresh` 改为监听这个通用事件。
- 没做：Figures 页面的懒加载和挂载仍在 `App.tsx`（`renderedTab` 里按模块写的 props），还没变成"页面贡献"。

### P4 LaTeX

- 改为可关闭。
- `LaTeXCompile`、`LaTeXRender` 归 latex 插件。
  - 共享工具表 `mvp_tool_specs` 现在也按插件过滤。上一批只过滤了 Desktop 追加的邮件工具，这个遗漏是写测试时发现的。
- 新增 LaTeX 工具路由分组（chat crate 的 `profile: "latex"`）。插件关闭时工具不在目录里，也就不会形成这个分组。
- 关闭时 `system.md` 的 "Explanatory diagrams" 段换成不含 LaTeX 的版本：`SystemPromptBuilder::without_latex_guidance`，由 `load_system_prompt` 按执行上下文冻结的插件集决定。前后各段逐字节不变，有测试。
- LaTeX 语言能力搬到核心：
  - `typeset/latexStructure.ts` → `editor/latex/latexStructure.ts`；
  - `typeset/externalChangeDiff.ts` → `diff/externalChangeDiff.ts`；
  - 引用提示的文案 → `editor/latex/latexCopy.ts`。
  - 结果：`editor/`、`extensions/` 不再依赖 `typeset/`。
- 关闭时 `.tex` 改在 Code 页打开（`workspaceFileOpenTarget(path, { latexWorkspace })`）。Chat 打开文件、文件路径菜单、侧栏查看器都走这条规则。

### P3 文献库

- 改为可关闭。工具按"外部检索/获取"与"本地证据"划界：
  - 插件（8 个）：`LiteratureSearch`、`LiteratureCitations`、检索协议三件套、`LiteratureLibraryUpsert`、`LiteraturePdfDownload`、`LiteratureBrowserDownloadTask`。
  - 核心：`LibraryRetrieve`、`Retrieval*`、`ProjectEvidenceSearch`、`Knowledge*`。
  - 有测试钉住这条界线，并且文献插件关闭后，邮箱的 `mail_literature_catch_up` 也跟着消失。
- **工具声明进清单。** `BuiltinManifest.tools` 为每个工具声明 `retrieval`（Discovery/Verification）、`output_failure`（Shell/LiteratureSearch）和 `requires`。
  - `retrieval_guard::retrieval_role` 和 `tool_outcome::classifier` 先查清单，runtime 里不再写死文献和 LaTeX 工具名。
  - 只剩内核工具（WebSearch、bash 等）还在原来的 match 里。
  - Desktop 的 `tool_owner` / `tool_requires` 也改为读清单；另有测试防止清单里的邮件工具和邮件模块自己的列表脱节。
- **`LiteratureSource` 契约**（`tools/src/literature.rs`）。
  - 每个来源提供：`id`、`aliases`、`label`、`availability`，以及一次有界、可取消的分页检索 `search(client, &SourceRequest)`，返回带审计材料的 `AdapterSearchOutcome`。
  - 排序、去重、预算和 `MAX_PAPERS` 都由调用方统一负责。
  - 内置的 Scopus、OpenAlex、Semantic Scholar、Crossref、arXiv 通过 `Engine` 实现这个契约。单源检索、`search_remote` 和可用性判断都改为经过 `literature_sources()` 注册表。行为不变，原有文献测试全部通过。
- **证据检索提示词片段改回核心。** 上一批把 `local_evidence_retrieval` 归给了文献插件，但它讲的是 `ProjectEvidenceSearch`（核心），所以现在始终保留。
- 外部操作在插件关闭时拒绝：
  - `literature_add_identifier`、`literature_search_protocol_execute`；
  - `review_workflow_create`（综述流程），拒绝并提示先打开文献插件。
  - 自主工作流的阶段工具表本来就和冻结集取交集。
- **没做：**
  - PdfReader 没搬到 `pdf/`。它有 2471 行，还依赖 PaperReadingPanel、文献文案、libraryInteraction 和 `Literature.css`；拆 CSS 会碰到 styles 级联陷阱。插件关闭不会删代码，Chat 侧栏照样能看 PDF，所以这一步只是代码组织，需要另开一个任务。
  - `LiteratureSettings.tsx` 没有重新挂上。它是 0.4.62（05ca631c）有意从设置页拿掉的，引用样式已经由文献页里的 `CitationStyleManager` 管理。是否恢复（附件命名模板目前没有入口）需要用户决定。
  - P5（经 MCP 注册用户检索源）未开始。

### 第三批验证与实测中修正的问题

- 全套：
  - runtime 979/979；tools 338/338；chat 68/68；
  - 前端 2362/2362；构建、debug exe 通过；
  - desktop 1063/1064，唯一失败仍是 31511e6e 的 `the_completion_contract_only_promises_a_reviewer_that_will_run`。
- 应用内（隔离实例）：
  - 依次关掉 Figures、LaTeX、Literature，导航栏对应少掉 Figures → LaTeX → Literature，其余模块往前补位。
  - 插件关闭时直接调用后端：`figures_start` 和 `literature_add_identifier` 都返回"官方插件已关闭"的拒绝。
  - `somniq-figure` 关闭后返回 404 这一点没能在应用内验证：页面里的跨源 fetch 被拦了。
    改为把判断提成 `official_plugins::figure_scheme_response`，由单测
    `the_figure_scheme_serves_nothing_while_figures_is_off` 钉住：关闭时 404、空正文、不读资源；打开或没有项目时照常返回。
- **实测发现并修正的两个问题：**
  - 项目范围插件的主开关原本写的是全局，在一个项目关 Figures 会关掉所有项目。现在 `switchTarget` 对 `scope: "project"` 的插件一律写项目覆盖，只有用户范围的 Mail 默认写全局。
  - "跟随全局（…）"原来是用当前生效状态猜的。现在后端直接返回 `globalEnabled`（全局的选择或默认值）。
  - 修正后重测：关 Figures 只写 `projects.<本项目>.figures=false`，全局保持未设置，选择框显示"本项目关闭"。

## 第四批：P3/P2 收尾（2026-11-14，在 3d14d249 之后）

### 附件命名模板：放回设置页，归文献插件

- 查证：文献页侧栏的"设置"按钮一直在请求设置页的 `literature` 分类，但 0.4.62 重做设置侧栏时这个分类被拿掉了，按钮实际是坏的；附件命名模板（含"重命名已有附件"）和快速复制样式因此都没有入口。后端 `literature_preferences`、`literature_rename_attachments` 一直在用。
- 决定：把 `LiteratureSettings` 作为文献插件的设置页挂回"集成"分组（在邮箱之后）。文献插件在本项目关闭时，这一项和邮箱一样从侧栏消失，已打开时退回"常规"。不另做文献页内的弹窗：设置页现成、已有测试，且和 `settings` 贡献点的方向一致。
- 测试：`settings/LiteratureSettingsEntry.test.tsx`（文献页请求时打开附件命名；插件关闭时没有这一项）。

### PdfReader 一组搬到 `pdf/`

- 搬的不只是 PdfReader：伴读面板、导读视图、导读图示、伴读接口、`pdfExtraction`/`pdfEvidence` 和它们的样式、测试是一组（约 4100 行），对文献库只有三处依赖，一起搬走：
  - 阅读器文案 → `pdf/i18n.ts`（`PDF_READER_COPY`），`LITERATURE_COPY.*.pdfReader` 改为引用它；原来借用的 `workspaceHeader.tabGuide` 改为阅读器自己的 `guideTab`。
  - 批注类型和 `EvidenceSource` → `pdf/annotationTypes.ts`，`literatureTypes.ts` 原名重新导出，文献侧代码不用改。
  - 布局偏好读写和 `isEditableTarget` → `pdf/readerPrefs.ts`，仍用原来的本地存储键，用户已有的"工具栏收起"选择不丢；`libraryInteraction.ts` 委托给它。
- 依赖方向：文献库依赖 `pdf/`，`pdf/` 不依赖文献库。`pdf/tests/boundary.test.ts` 钉住：`pdf/` 下的源码不得引用 `../literature/`。
- 没搬：`.lit-pdf*` 样式仍在 `Literature.css` 原位（约 200 条规则，分散在 7 段）。两个使用方（文献页、Chat 侧栏）本来就加载这份样式，挪动会改变它们与其余规则的先后次序，踩 styles 级联陷阱，收益只是代码组织。以后要拆，按段整体移动并逐段截图对比。

### 官方插件页面贡献

- 新增 `extensions/officialPluginPages.tsx`：每个页面声明所属插件、tab、`load`（懒加载，也用于悬停预加载）、挂载方式（`keep` 首次打开后隐藏不卸载，保住草稿和在跑的任务；`visible` 只在显示时挂载）、外层 class、是否在导航外壳里绘制。
- LaTeX（`typeset`）、Figures、邮箱改由 `App.tsx` 遍历这份声明挂载，`App.tsx` 不再按模块各写 mounted 状态、懒加载和预加载分支。
- 文献页不在里面：它的 `pageView` 和顶栏工具栏槽位共用，是外壳状态，留在 `App.tsx` 直接挂载。
- 测试：`extensions/officialPluginPages.test.ts`（页面与插件 tab、导航项一致；Figures/LaTeX 保持挂载；文献与核心 tab 不在声明里）。

### 第四批验证

- 前端全套 2390/2393：3 个失败都在 `.audit/literature-20260926.test.tsx`（9 月的现状复现测试，找不到"新建条目"按钮、"外部发现"标签，与本批无关）；`scripts/tests/*.cjs` 是 node:test 脚本，vitest 报"没有测试套件"。类型检查、`npm run build` 通过。
- 浏览器预览（`vite preview`，dev server 冷启动挂起）：
  - 先开 Figures 再开 LaTeX：两个页面都按声明包在 `app-figures-pane`/`app-typeset-pane` 里，切回 Chat 后两者都隐藏而不卸载。
  - 文献页侧栏"设置"按钮落到新的"文献库"设置页。原样式下三张卡片宽度不一（359/477/651px），补了 `SettingsLayout.css` 一条作用域规则，改后都是 651px。
- 没验证到：PDF 阅读器从新位置打开本地 PDF。浏览器预览没有桌面后端，示例文献打不开 PDF；由类型检查、构建、搬过去的 PdfReader 测试和 Chat 侧栏测试覆盖。

## 与 Chat 里定制插件的交叉核对（2026-11-14）

逐项核对过、不冲突的：开关与审批分文件存放（`builtin.json` / `approvals.json` / `packages/`）；项目侧 `registry.json` 与 `official.json` 互不扫描；用户插件工具名带 `mcp__<服务>__` 前缀，不会被 `builtin_tool` 认成官方工具；用户插件不能占用内置技能名（安装期报错，与官方开关无关，关掉官方插件也顶替不了）；"需要重启"按名字和摘要逐个比，官方开关改变指纹但不会把用户插件判为过期；"改这个界面"只挂在用户插件面板上，官方插件不是安装包，`checkout` 取不到。

补上的两处缺口：

### 模型不能写项目的插件存储

- `plugins/store_guard.rs`：`is_plugin_store_path`（`<project>/.somniq/plugins` 及其下，NTFS/APFS 上不分大小写）和 `command_names_plugin_store`。
- 文件工具：`file_ops` 的两个写路径规范化函数（write_file、write_files、edit、multi_edit、append、大文件写、DOCX 编辑都经过它们）在工作区边界检查之后再拒绝插件存储，错误为 `PermissionDenied` 并指向 PluginManager、插件页和 `.somniq/plugin-drafts`。读取不受影响。
- bash、PowerShell、REPL：命令文本提到 `.somniq/plugins`（任一种斜杠、不分大小写，`plugin-drafts`/`plugins-backup` 不算）就在执行前拒绝。这是文本检查，拦的是走错路的智能体，拦不住刻意拼接路径的命令；信任仍靠项目外的审批记录。NotebookExecute 执行的是笔记本里的代码，没有加这道检查。
- 插件开发技能写明：这条路径会被拒；官方插件开关归用户。
- 测试：`file_tools_refuse_the_project_plugin_store`（runtime）、`shell_tools_refuse_commands_that_name_the_plugin_store`（tools）、`the_plugin_store_guard_matches_the_store_and_nothing_else`。

### 用户插件声明依赖官方插件（`somniq.requires`）

- 清单：`package.json` 的 `"somniq": { "manifestVersion": 1, "requires": ["literature"] }`；有面板时 `ui` 照写，只声明依赖时 `ui` 可省略。未知 id 报 `requires` 诊断（阻止启用），`PluginManager inspect` 的规则里有说明，诊断有修复提示。
- 生效：`running_given` 过滤掉依赖未满足的包，所以它的 Skills、MCP 服务、面板都不加载，也不进回合冻结集；`freeze` 只读一次开关，包过滤和 `builtin_disabled` 用同一份。这与 `mail_literature_catch_up` 依赖文献库时整块剔除的做法一致。
- 展示：新生命周期状态 `needs-official-plugin`（"缺官方插件"）和 `missingOfficial`，插件页写明缺哪个、去哪里打开；详情和 Chat 批准卡片都列出"依赖的官方插件"。用户的启用选择保留，官方插件打开后下一次运行自动恢复。
- 测试：`a_package_that_requires_an_official_plugin_waits_for_it`、`a_panel_package_that_requires_an_official_plugin_hides_its_panels_while_it_is_off`、`requires_names_only_known_official_plugins`；前端 `PluginPackages.test.tsx` 新增等待状态用例。
- 这是 P5"`requires` 开放给用户插件"的一部分；P5 其余（检索源经 MCP、声明式设置页、只读预览页）仍待设计稿。

### 验证

- runtime 984、tools 339、chat 68、前端 2386 全过，构建通过；desktop 1064/1065，唯一失败仍是 31511e6e 的 `the_completion_contract_only_promises_a_reviewer_that_will_run`。
- 全套并行时发现官方插件工具表测试偶发失败：它们两次读取工具注册表，中间若有别的测试改了环境变量（3d14d249 新增的 Figures 404 测试会改 `ARIS_CONFIG_ROOT`），两份列表就不一致。现在凡两次读注册表的测试都持有 crate 唯一的 `test_env_lock`。

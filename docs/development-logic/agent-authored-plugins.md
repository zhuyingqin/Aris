# Agent 自建插件

状态：设计已批准（2026-11-07，D1–D4 按建议定）；M1、M2、M3 已实现（M3 记录见文末）。
实现与设计稿的出入见文末"M1 实现记录""M2 实现记录""M3 实现记录"。基于 `codex/release-0.4.87`
（15a7b25a）和 DeepSeek Harness 0.2.2-rc.1（fcc0ad46，与
`deepseek-plugin-packages.md` 固定的上游版本相同）。

## 目标

用户在 Chat 里说一句话，例如"做一个记录实验假设的侧栏面板"或"把
`scripts/fetch_doi.py` 包成一个工具"，Agent 就能在同一段对话里写出插件包、
自查诊断、安装，并请用户批准。用户点一次批准，Agent 在下一回合实际验证
插件能用，再报告结果。整个过程不用打开插件页，也不需要用户自己写 JSON。

可观察的成功标准：

1. 新项目里，一句"做一个记录实验假设的侧栏面板"，用户只点一次批准，
   Chat 侧栏就出现这个面板。
2. 一句"把 `<脚本>` 包成 MCP 工具"，批准后的续跑回合里，
   `mcp__<前缀>__<工具>` 调用成功，工具结果出现在对话中。
3. 模型自己无论如何调用工具、写什么文件，都不能让插件在没有用户点击的情况下
   运行。下文"验收测试"里有逐条对应的测试。
4. AI 写的包和人导入的包，在插件页里看起来完全一样，可以用同样的方式停用、
   升级、移除。

## 从 DeepSeek Harness 学什么

DSH 的"创造模式"（`cordis` preset）由五部分组成：

| DSH | 作用 | 本设计的对应 |
| --- | --- | --- |
| `cordis-plugin-development` Skill + 模板 + 参考文档 | 告诉 Agent 怎么写、先做最小可用版、怎么验证 | 内置 Skill `somniq-plugin-development` |
| `plugin_manager` 工具 | 模型调用安装、启停、移除 | `PluginManager` 工具 |
| `cordis_inspect_list/query` | 模型查询运行时真实存在的接口 | `PluginManager` 的 `inspect` 动作 |
| HMR，`application: applied / restart-required` | 安装后同一会话生效，并告诉 Agent 是否已生效 | 回合边界生效 + 自动续跑，`application: next-turn` |
| 插件页"创建插件"菜单 | 一键开创造模式任务 | 插件页"让 AI 创建插件"、卡片上的"让 AI 修复" |

还有一个更重要的教训。DSH 在 2026-09-16 删掉了早期那套"生成代码
define/run/stop"工具（见上游
`.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md`），
原因是它在普通插件之外又造了第二套生命周期。我们从一开始就只有一条路：
**AI 写的包就是普通包**，走同一套 `PluginStore` 的 preview、install、upgrade、
set_enabled、remove。

明确不学的：

- 任意 JS 的 Host/Client 插件和往宿主进程热加载代码。DSH 自己也要求完全权限
  才能这么做。这和本地优先的信任边界冲突。我们继续用声明式 `somniq.ui`。
- 完全权限会话免审批（理由见"待定决策 D1"）。
- 插件市场、版本豁免、npm 构建脚本批准（`approvedBuilds`）。我们不跑
  `package.json` scripts，也就没有这个问题。

## 不变量

以下几条是硬约束，实现和评审时逐条核对：

1. **工作区内容永远不足以运行任何东西。** 这条沿用
   `deepseek-plugin-packages.md`。模型能写的只有工作区文件；运行条件仍是
   "项目请求 ∧ 本机 `approvals.json` 里的批准摘要 = 快照摘要"。
2. **批准只来自本机 Desktop 主窗口里用户的一次点击。** 模型调用的任何动作
   都不会写批准。`PluginStore::set_enabled(_, true)` 和
   `upgrade(_, _, _, approve = true)` 只会在批准通道收到用户决定后被调用。
   手机端和 iframe 都不能批准。
3. **只有一条生命周期。** 工具复用 Tauri 命令背后的同一批 `PluginStore`
   函数，不另写安装逻辑。插件页和工具看到的状态完全相同。
4. **一个回合一个冻结插件集**，`PluginRun` 和 `plugin_set` 事件的语义不变。
   新批准的插件从下一回合开始生效。
5. **插件仍不能遮盖内置 Skill。** 插件开发 Skill 本身是编译进程序的内置
   Skill。
6. **无人值守的运行不能改插件。** 自主工作流动作（只读权限）、WorkTask、定时
   任务里，`PluginManager` 只开放只读动作。独立 Reviewer 的流程不改。

## 端到端流程

```
用户：做一个记录实验假设的侧栏面板
 ├─ Agent 加载 Skill somniq-plugin-development
 ├─ PluginManager inspect                       ← 查可用插槽、组件、限制
 ├─ 按 Skill 把模板写进 .somniq/plugin-drafts/hypothesis-log/
 ├─ PluginManager preview                       ← 返回诊断，Agent 自己修
 ├─ PluginManager install                       ← 装成停用，不运行
 ├─ PluginManager request_enable                ← 回合阻塞在批准卡片上
 │     卡片：名称、版本、摘要、Skill、面板、MCP 命令行与环境变量键、升级差异
 │     用户点"批准并启用" → Desktop 写批准 → 工具返回 application: next-turn
 ├─ Agent 说明"已批准，下一回合验证"，回合结束
 └─ 自动续跑回合（冻结新插件集，写 plugin_set 事件）
       ├─ 面板：确认 plugins_ui_list 里有它，提示用户去侧栏看
       ├─ MCP：调用 mcp__… 工具，看真实结果
       └─ Skill：Skill 工具能读到它
       → 报告位置、验证结果、验证不了的部分
```

修复迭代：Agent 改完草稿后调用 `upgrade`。工具固定传 `approve = false`，按
`PluginStore::upgrade` 现有语义，新版本装成停用、旧版本的批准被撤回（效果等同
插件页的"升级并停用"，任何一步失败都回到旧版本），然后再走一次
`request_enable`。

## `PluginManager` 工具

工具只在 Desktop 交互式 Chat 回合里注册。它和 `AskUserQuestion` 一样放在
`engine.rs::tool_specs_for`，由 `DesktopToolExecutor` 截获执行，因为
它要用项目绑定和批准通道。操作本身全部调用 `runtime::plugins`，Desktop 只做
参数转换和批准等待。工具不进常驻核心集（`PINNED_CORE_TOOLS`），改为在动态工具
路由里加一个"插件编写"意图（关键词如 插件、plugin、侧栏面板、MCP 工具），
必需集合是 `PluginManager` 和 `write_file`。没命中意图时，Skill 里写明先用
ToolSearch 激活它。现有路由没有"加载 Skill 就激活某工具"的机制，不另造。

### 动作

| action | 权限 | 作用 | 对应现有函数 |
| --- | --- | --- | --- |
| `inspect` | ReadOnly | 静态契约 + 当前项目已装插件摘要 | 新增，见下文 |
| `template` | ReadOnly | 返回一套起步模板的全部文件（M1 新增） | `plugin_template` |
| `list` | ReadOnly | 已装插件、生命周期、MCP 健康 | `PluginStore::list` |
| `preview` | ReadOnly | 预览草稿目录，返回诊断和升级计划 | `preview_import` |
| `install` | WorkspaceWrite | 安装为停用 | `install(source, digest)` |
| `upgrade` | WorkspaceWrite | 同名新版本。旧版本停用时直接装成停用；旧版本在运行时弹升级卡片，批准后一步替换（M2 定，见"M2 实现记录"） | `upgrade(.., approve=false)` / 批准通道 → `upgrade(.., true)` |
| `request_enable` | WorkspaceWrite | 阻塞等待用户批准，批准后启用 | 批准通道 → `set_enabled` / `upgrade(.., true)` |
| `disable` | WorkspaceWrite | 停用（撤回批准），可逆 | `set_enabled(name, false)` |
| `remove` | WorkspaceWrite + 用户确认卡片 | 从项目移除 | `remove` |
| `check_mcp` | 需要执行权限（M2） | 连接已批准包的 MCP，刷新健康；会启动插件进程，不能算只读 | `plugins.rs::check_mcp` |

几点约定：

- `install` 和 `upgrade` 必须带上 `preview` 返回的 `digest`（`upgrade` 还要带
  `currentDigest`），与 Tauri 命令一致。这样 preview 和 install 之间如果包被改过，
  会被拒绝。
- `source` 必须是项目工作区内的目录（规范化后判断），并且不在
  `.somniq/plugins/` 下。工具不读工作区以外的路径。
- `remove` 和 `disable` 会削减用户已有的配置。`disable` 可逆，直接执行；`remove`
  弹一次确认卡片（与批准卡片同一个通道，按钮是"移除"或"保留"）。
- 自主工作流、WorkTask 和定时任务与 Chat 共用 `tool_specs_for`，所以按动作拦：
  执行器发现当前是自主工作流（`autonomous_workflow`）或带 `work_task_runtime` 的回合时，
  只放行 `inspect`、`list`、`preview`、`check_mcp`，写动作返回说明"请在交互式对话里
  完成"。这些运行里没人能点批准，不能让回合卡在等批准上。

### 返回格式

统一返回 JSON，让 Agent 能据此决定下一步，不用读日志：

```json
{
  "action": "request_enable",
  "name": "@local/hypothesis-log",
  "digest": "sha256:…",
  "status": "enabled",
  "lifecycle": { "state": "enabled" },
  "application": "next-turn",
  "nextStep": "插件从下一回合起可用。告诉用户已批准；续跑回合里验证面板是否出现。",
  "diagnostics": []
}
```

- `application` 取 `none`（没改运行状态）、`next-turn`（已批准，下一回合生效）、
  `rejected`（用户拒绝）、`blocked`（诊断阻止启用）。
- 用户拒绝和停止回合，返回的是普通工具结果，不标 `is_error`。只有真正的失败
  （诊断阻止、摘要不一致、锁忙）才走错误路径，这样不会触发跑飞防护的失败计数。

### `inspect` 的内容

我们的扩展面是声明式、有边界的，所以 `inspect` 不需要 DSH 那种运行时反射，
只要把校验器认的规则原样返回：

- 清单字段：`name`、`version`、`dsh.manifestVersion`、`dsh.bundle.patch`、
  `somniq.manifestVersion`、`somniq.ui`。
- 能接受的 DSH 行：`@deepseek-ai/dsh-skill-filesystem`（必须
  `includeDefaultRoots: false`）、`@deepseek-ai/dsh-mcp-client`
  （`transport: stdio` 及支持的字段）。
- `somniq.ui`：插槽列表（目前只有 `chat.sidebar`）、组件类型、id 规则、
  数量和长度上限。
- 包体积、文件数、目录深度上限；内置 Skill 名单（用于避开 `skill-builtin`）。
- 当前项目已装插件的名称、版本、生命周期状态。

这些值必须直接取自 `runtime::plugins` 里校验器使用的常量和枚举，不能再写一份，
否则 `inspect` 会和校验器漂移。在 `runtime::plugins` 加一个
`authoring_contract()` 返回这些值，校验器和 `inspect` 共用。

## 批准通道

现有两条"等用户"的通道各有一处不合适：

- `question_prompts`（AskUserQuestion）：手机端能回答
  （`remote.rs` 的 `AnswerChatQuestion`）。批准不能让手机点。
- `permission_prompts`：手机看不到，这点是对的。但它的载荷是"允许这次工具调用"，
  装不下插件的能力清单和差异。

所以新增 `plugin_approvals` 登记表，结构仿照 `permission_prompts`：按
`tool_use_id` 建 mpsc 通道，等待时每 200ms 轮询一次，遇到取消或中断就返回拒绝。

- 卡片载荷由后端生成，前端只负责展示：名称、版本、摘要、来源目录、Skill、
  面板、每个 MCP 服务的完整命令行和环境变量**键**（不显示值）、升级时的
  `CapabilityDiff`。
- 新 Tauri 命令 `chat_plugin_approval_respond(toolUseId, digest, decision)`：
  - 只接受主窗口发来的请求（检查 `tauri::Window` 的 label）。iframe 能拿到
    Tauri IPC 全局，这条检查不能省（见 Windows iframe 的历史问题）。
  - `digest` 必须等于登记时卡片上的摘要，并且等于此刻注册表里该包的摘要；
    否则拒绝，卡片提示"包已变化"。
  - 通过后才调用 `set_enabled(name, true)`；如果是升级，调用
    `upgrade(source, digest, currentDigest, true)`。
- 手机端：卡片在手机上显示为"请在电脑上批准"，不提供按钮。
- 回合被停止或失败：卡片锁定为"已不再等待"，与 `QuestionCall` 一致。
- 每次决定写一条会话事件 `plugin_approval`
  （name、version、digest、decision、toolUseId），作为审计记录。
  `approvals.json` 格式不变。
- 后端改了插件状态后，发 Tauri 事件 `plugins-changed`（带 projectPath）。
  前端收到后转成现有的窗口事件 `somniq:plugins-changed`，插件页和 Chat 面板
  会照常刷新。现在这个事件只在前端自己调用 API 时触发，工具改的状态不会
  通知前端，这是必须补的。

## 生效时机：回合边界 + 自动续跑

DSH 靠 HMR 在同一个会话里马上生效。我们的情况是：MCP 工具在每回合开始时由
`aris_chat::attach_mcp_tools_with_cancel` 一次性挂载，Skill 根和只读根取自回合开始
时冻结的 `PluginRun`。回合中途加插件，要同时改工具目录、MCP 进程管理、只读根和
审计记录，代价大，还会破坏"一个回合一个插件集"的审计语义。

v1 的做法：

1. `request_enable` 批准成功后返回 `application: next-turn`。Skill 要求 Agent 在
   这时结束本回合，不要试图在本回合里调用新工具。
2. 回合结束后，如果本回合有一次成功的 `request_enable`，并且回合是正常结束的
   （不是被用户停止或失败），前端自动发起**一次**续跑回合。续跑复用现有的
   continue 路径，消息在界面上显示为系统标记"插件已启用，继续验证"，
   不冒充用户发言。
3. 续跑回合照常冻结插件集并写 `plugin_set`。新插件的 MCP 服务改变了发现缓存的
   键（`mcp_discovery_cache_key` 包含服务配置哈希），会重新发现，不需要额外
   清缓存。

后续评估（不在 v1）：利用 ToolSearch 的延迟工具机制，在回合中途扩展工具目录。
前提是 MCP 管理器支持增量挂载，并且 `plugin_set` 事件能表达"回合内的第二个集合"。

## 内置 Skill `somniq-plugin-development`

> M1 实际做法：模板编进 `runtime`、由 `PluginManager template` 返回，Skill 不带
> `references/`，原因见文末"M1 实现记录"。下面的文件清单是原设计。

位置是 `crates/runtime/assets/skills/somniq-plugin-development/`，由
`build.rs` 编进 `BUNDLED_SKILLS`，模板和参考文档作为 `BUNDLED_RESOURCES`。
`build.rs` 只打包这些扩展名：md、py、sh、tex、cls、bst、toml、yaml、yml、json、
html、cjs。所以模板里的 MCP 服务用 Python（只依赖标准库）或 `.cjs`，不能放 `.js`。

`SKILL.md` 改写自 DSH 的工作流：

1. 先确定用户要什么、做在哪里。没说位置的界面需求，默认做成 Chat 侧栏面板。
2. 调用 `PluginManager inspect`，只查这一版需要的规则。
3. 把对应模板复制到 `.somniq/plugin-drafts/<短名>/`，改成用户要的内容。名称和说明
   要真实描述这个插件，不能留模板原文。
4. `preview` 直到没有诊断，然后 `install`、`request_enable`。不要先做 HTML 预览、
   假界面或多个方案。
5. 根据 `application` 判断是否已生效，不要靠日志猜。在续跑回合里验证，并把
   验证不了的部分（例如看不到界面）如实告诉用户。
6. 发现问题就在同一个草稿目录里修，然后 `upgrade`。不要另起一个新名字的包。

Skill 明确禁止：直接写 `.somniq/plugins/`、`~/.config/SomniQ/plugins/`，以及
在工具之外手搓安装步骤。

文件清单：

| 文件 | 内容 |
| --- | --- |
| `references/manifest.md` | 清单、patch 写法、能接受的 DSH 行、包体积限制 |
| `references/ui-panels.md` | `somniq.ui` 规则，按任务选组件 |
| `references/mcp-stdio.md` | stdio MCP 字段、`./` 路径解析、环境变量只引用不写值 |
| `references/verification.md` | 每类插件在续跑回合里怎么验证、怎么报告限制 |
| `templates/chat-panel/` | 改写自 `examples/plugins/chat-workbench` |
| `templates/skill-pack/` | 改写自 `examples/plugins/research-continuity` |
| `templates/mcp-stdio-python/` | 一个只依赖标准库、带 `ping` 工具的最小 stdio MCP 服务 |

模板也算代码：新增测试，对每个模板跑 `PluginStore::preview`，要求零诊断且
`can_enable = true`。这样校验器收紧时模板会先报错，不会悄悄失效。

## 诊断改造

现在的 `Diagnostic` 只有 `code`、`message`、`severity`，`ui.rs` 遇到第一个错误就
停止。人看还行，Agent 要自己修就不够。改成：

- `Diagnostic` 增加可选字段 `file`（包内相对路径）、`path`（JSON pointer 或
  patch 行 id）、`hint`（一句修法）。字段都用 `#[serde(default)]`，插件页不受影响。
- `ui.rs` 一次收集所有错误，不再只报第一个。
- 每个 `code` 给一个固定的 `hint`，例如 `skill-builtin` →
  "改 Skill 目录名和 frontmatter name，避开内置名单（见 inspect）"。

## 入口

- 插件页的"导入本地插件包"旁边加"让 AI 创建插件"。点击后新开一个 Chat，
  输入框预填草稿（不自动发送），草稿里点名插件开发 Skill。
- blocked 或 failed 的插件卡片上加"让 AI 修复"。预填的草稿带上包名、来源目录和
  诊断。来源目录不在工作区内时，草稿里说明需要先复制进来。

## 分期

| 里程碑 | 内容 | 用户能看到什么 |
| --- | --- | --- |
| M1（已实现） | `authoring_contract()`、诊断改造、Skill + 模板 + 模板测试、`PluginManager` 只读动作（inspect、template、preview、list） | Agent 能写包并自查，用户仍去插件页安装 |
| M2 | `install`、`upgrade`、`disable`、`remove`、`check_mcp`，批准通道和卡片，后端 `plugins-changed` 事件 | 一次点击就能启用，插件页同步刷新 |
| M3 | 自动续跑、插件页入口、"让 AI 修复" | 满足成功标准 1、2 |
| 以后 | HTTP MCP（streamable-http）、更多声明式组件（同一操作同时暴露给面板和 Agent 工具）、回合中途生效评估、插件接入 Goal/WorkTask 自动化层 | — |

M1 单独就有价值，风险最低，可以先合。

## 已定决策（2026-11-07，用户按建议定）

**D1：完全权限（"自动批准"）模式下，启用插件能否免点？**
定：不免，每次都要点。理由是 `permission_mode_for` 在用户没设置时回落到
`DangerFullAccess`，免点就等于大多数用户永远看不到批准卡片，P0-1 修好的信任锚
又会变回由模型决定。而且启用插件就是一次点击，成本很低。

**D2：Agent 迭代修插件时，每次升级都要重新批准吗？**
定：每次都批，摘要绑定不放松。如果差异里没有命令行和环境变量键的变化，卡片
就精简成一行差异，点起来很快。另一个选项是"执行面没变就保留批准"，但 Skill
文本和面板文字也会进模型上下文，同样是注入面，所以不推荐。

**D3：手机能否批准？**
定：v1 不能。批准写的是这台电脑的 `approvals.json`，应该由坐在这台电脑前的人
决定。手机端显示"请在电脑上批准"。

**D4：草稿放哪里？**
定：`.somniq/plugin-drafts/<短名>/`，不弄乱研究文件。用户指定别的工作区目录时
听用户的。

## 验收测试

不变量相关（runtime + desktop）：

- 工具路径在没有用户响应时不会启用插件：通道超时、回合取消、回合停止三种情况，
  `approvals.json` 都不变。
- `chat_plugin_approval_respond` 拒绝：非主窗口、摘要与卡片不一致、摘要与注册表
  不一致、没有对应的待批准项。
- 手机端控制协议里没有批准插件的命令。`remote.rs` 加一条测试，把它锁死。
- 自主工作流、WorkTask、定时任务的工具列表里没有 `PluginManager` 的写动作。
- `source` 在工作区外或在 `.somniq/plugins/` 下时拒绝。
- `inspect` 返回的上限值与校验器一致（同一常量，测试防止有人另写一份）。
- 模板零诊断测试。

流程相关：

- 前端：批准卡片的渲染、锁定、拒绝；自动续跑只在成功批准且正常结束时触发一次；
  `plugins-changed` 事件让 Chat 面板刷新。
- 应用内实测（debug 版 + WebView2 CDP，见桌面 UI 本地验证的笔记）：成功标准 1、2
  各跑一遍，截图留证。

## 不做

- JS/HTML/CSS 插件、热加载、`dsh.client` 入口。
- 插件市场和远程下载。
- 插件接入 Goal、Schedule、Jobs 等自动化层（另立设计）。
- 改变独立 Reviewer 或 Executor → Reviewer → revision 流程。

## M1 实现记录（2026-11-07）

### 落地内容

- `crates/runtime/src/plugins/authoring.rs`：`authoring_contract()`、`hint_for()`、
  `preview_failure()`、`plugin_template()` / `plugin_template_ids()`、
  `PLUGIN_DRAFTS_DIR`。契约里的上限、字段、插槽、组件类型都取自校验器的常量；
  `mod.rs`（包上限）、`dsh.rs`（行名、配置键、传输方式、服务名与超时上限、
  平台）、`ui.rs`（插槽、版本、数量与长度上限、组件类型）里原先的字面量都改成了
  这些常量，校验器和 `inspect` 用的是同一份。
- 诊断：`Diagnostic` 新增可选 `file`、`path`、`hint`，构造时按 `code` 自动带上
  `hint`。`ui.rs` 一次报出所有问题，每条带 `ui.json` 和 JSON pointer；`dsh.rs`
  的 patch 诊断带 patch 文件名，行级诊断带行 id。另一处改动：`empty`（包里没有
  任何能力）只在没有别的错误时才报，以前 UI 声明出错时会同时报 `empty`，
  把作者引到错的地方。
- 三套模板编进 `runtime`（`src/plugins/templates/`）：`chat-panel`、`skill-pack`、
  `mcp-stdio-python`。MCP 模板的 `command` 在取出时换成本平台的 Python
  （Windows 为 `python`，其他为 `python3`）。
- 内置 Skill `crates/runtime/assets/skills/somniq-plugin-development/SKILL.md`。
- Desktop `PluginManager` 工具（`desktop/src-tauri/src/plugins.rs`），在
  `engine.rs` 的 `all_tool_specs_for`、`is_desktop_tool`、
  `DesktopToolExecutor::execute_with_id` 三处接入。动作：`inspect`、`template`、
  `preview`、`list`，权限 ReadOnly。预览源目录必须在本回合工作区内，且不在
  `.somniq/plugins/` 下；输出里 MCP 环境变量只列键名。
- 动态工具路由新增"插件编写"意图（`crates/chat/src/lib.rs`），必需集合
  `PluginManager` + `write_file`。
- 前端 `api/plugins.ts` 的诊断类型补上三个可选字段。插件页暂不显示 `hint`：
  提示是英文，写给 Agent 和作者看的，直接放进中文界面不合适。

### 与设计稿的出入

1. **模板不放在 Skill 的附带文件里，改为编进 `runtime`，由 `template` 动作返回。**
   内置 Skill 的附带文件会被解到 `~/.config/SomniQ/cache/<版本>/`，而 `read_file`
   只能读工作区和 `ARIS_READONLY_ROOTS`（Agent 存储目录 + 已批准插件快照），读不到
   这个缓存。所以 Skill 没有 `references/`，规则统一从 `inspect` 取。这样模板、
   校验器和工具只有一份，模板测试也直接测编进程序的那份。
2. **`check_mcp` 从 M1 移到 M2。** 它会启动已批准包的 MCP 进程，也就是执行插件
   代码。放进 ReadOnly 工具，"计划"模式下也能执行插件代码，不对。M1 里 MCP 健康
   从 `list` 的 `lifecycle` 读，真实验证由用户启用后、Agent 调用 `mcp__…` 工具完成。
3. **M1 的 Skill 把安装交给用户。** Skill 第 6 步写明：告诉用户草稿的绝对路径、
   会运行的命令行，以及插件页的操作步骤，然后停下；第 7 步在用户启用后用 `list`
   确认、实际调用验证。M2 落地时要同步改这两步。
4. WorkTask 回合也会注册 `PluginManager`（与 Chat 共用 `tool_specs_for`）。M1 只有
   只读动作，所以不需要按动作拦；M2 加写动作时必须按设计稿拦掉。自主工作流用
   `workflow_tool_specs` 从零构造工具列表，本来就拿不到它。

### 验证

- runtime `plugins::` 33 项通过，其中新增 7 项：
  - 三套模板零诊断；
  - MCP 模板经真实 `McpServerManager` 发现到 `ping`，调用返回 `pong`
    （本机没有 Python 时跳过）；
  - 扫描六个插件源文件里的诊断码，每一个都有 hint，且都出现在 `inspect` 里；
  - 契约里的标题、正文、面板数、组件数上限与校验器逐一对拍（边界值过、超一失败），
    每种组件类型按契约字段都能通过；
  - UI 诊断一次列出所有问题并带 pointer；
  - patch 与行级诊断带文件和行 id；
  - 读不了的包变成 `package` 诊断。
- runtime `cache` 10 项通过（新 Skill 打包正常）。
- chat 66 项通过，含新增路由测试：四种说法都钉住 `PluginManager` 和 `write_file`，
  两条无关请求不带它。
- desktop `plugins::` 4 项通过，其中新增 3 项：
  - 模板 → 写草稿 → 干净预览 → 坏草稿给出可修的诊断 → 非包目录给出 `package`
    诊断，全程不创建插件状态目录；
  - 工作区外、`../`、`.somniq/plugins` 一律拒绝，`install`/`enable`/`approve`/`remove`
    动作和多余字段都报错；
  - 预览和列表的输出里都不出现环境变量的值。
- 全套：`cargo test --workspace --no-fail-fast` 1588 通过、0 失败；desktop
  `cargo test --lib` 1033 通过、0 失败、15 忽略。
- 未做：应用内实测（真实模型走一遍 Skill 流程）、独立模型审查；这个 worktree
  没有 `desktop/node_modules`，前端 `tsc` 和 Vitest 没跑（前端只在诊断类型里加了
  三个可选字段）。

## M2 实现记录（2026-11-07）

### 落地内容

- `PluginManager` 加上写动作：`install`、`upgrade`、`request_enable`、`disable`、
  `remove`、`check_mcp`（`desktop/src-tauri/src/plugins.rs`）。全部调用插件页同一批
  `PluginStore` 函数，没有第二套安装逻辑。每个改动结果都带 `application`
  （`none` / `next-turn` / `rejected` / `blocked`）和 `nextStep`。
- 批准通道 `plugin_approvals`：`ChatState` 里按 `tool_use_id` 登记，结构仿
  `permission_prompts`，等待时每 200ms 轮询、回合停止即放弃。卡片载荷由后端从已装或
  预览的包生成：名称、版本、摘要、来源、Skill、面板、每个 MCP 的完整命令行和环境变量
  **键**；升级时带 `CapabilityDiff`、`currentVersion` 和 `executionUnchanged`
  （命令和环境变量键都没变时为 true，卡片精简成一行）。卡片通过第二次 `chat-tool`
  事件发出，带 `ready: true` 和 `pluginApproval`，与 AskUserQuestion 的握手一致。
- 新命令 `chat_plugin_approval_respond(toolUseId, digest, approve)`：
  - 只接受 label 为 `main` 的窗口；
  - `digest` 必须等于卡片登记的摘要，不等时卡片保持等待（不算一次决定）；
  - 批准后才写批准：启用走新增的 `PluginStore::enable_approved(name, digest)`，
    移除走 `remove_confirmed(name, digest)`，两者在同一把锁里核对"注册表里的摘要
    仍是卡片上的摘要"，不一致返回 `PACKAGE_CHANGED_SINCE_SHOWN`；升级走
    `upgrade(source, digest, currentDigest, true)`，它本来就核对两边摘要；
  - 每次决定写会话事件 `plugin_approval`（kind、name、version、digest、decision、
    result、toolUseId）；`approvals.json` 格式不变。
- 后端 Tauri 事件 `plugins-changed`（`{projectPath}`）：工具的 install、upgrade、
  disable、check_mcp 和卡片批准成功后发出。前端 `bridgeBackendPluginChanges()` 把它
  转成现有的 `somniq:plugins-changed` 窗口事件；Chat 侧栏面板和插件页（新增监听）都会
  刷新。后端报的是规范化路径（可能带 `\\?\`、反斜杠、大小写不同），前端改用
  `samePluginProject()` 比较。
- 前端 `PluginApprovalCall`（`ChatMessage.tsx`）：中英文文案；等待中、准备中、已不再
  等待、已批准、已拒绝、未完成六种状态；一次点击只提交一次；后端拒绝答复时卡片保持可答。
  连续的 PluginManager 调用不会把卡片折进工具组。
- 远程端：`tests/remote.rs` 新测试锁死"没有能力名含 plugin、任何批准形状的控制命令都
  解析失败"。手机的 `AnswerChatQuestion` 只查 `question_prompts`，碰不到批准卡片。
- Skill 第 6–8 步改成 install → request_enable → 按 `application` 行事 → 在下一回合
  验证；升级、停用、移除和无人值守时的限制写进 Skill。

### 与设计稿的出入

1. **运行中的包升级：一张卡片、一步替换。** 设计稿动作表写的是"`upgrade` 固定
   approve=false，再 `request_enable`"，批准通道一节又写"如果是升级，调用
   `upgrade(.., true)`"，两处不一致。按后者实现：旧版本在运行时，`upgrade` 直接弹升级
   卡片，批准后 `upgrade(.., approve=true)`，包不会中途停掉；拒绝则旧版本原样运行。
   旧版本本来就停用时，`upgrade` 直接装成停用，再走 `request_enable`。这样 D2 的
   "命令没变就精简成一行"有可靠的差异来源（`preview_import` 的升级计划），不用在
   执行器里另记状态。
2. **按动作而不是按工具分权限。** 运行时的权限策略只按工具名判断，所以工具仍登记为
   ReadOnly，由执行器按动作拦：
   - 只读（计划）模式下，所有写动作拒绝；
   - `check_mcp` 只在完全权限（DangerFullAccess / Allow）下可用，因为它会运行插件代码；
   - "每次询问"（Prompt）模式下，`install`、`upgrade`（停用状态）、`disable` 不再另弹
     权限提示：它们不会让任何东西运行，而启用、运行中升级、移除各有自己的卡片。
   执行器为此新增 `permission_mode` 字段。
3. **无人值守的判定。** 带 `work_task` 绑定（含定时任务，它们以待办任务运行）或审稿
   工作流绑定的回合，写动作一律拒绝并说明"请在交互式对话里完成"；`inspect`、
   `template`、`preview`、`list`、`check_mcp` 照常可用。自主工作流本来就拿不到这个工具。
4. **主窗口检查的边界。** label 检查能挡住其他窗口（截图浮层等），挡不住主窗口里的
   iframe。iframe 的隔离靠现有做法（移除 `chrome.webview`、CSP `connect-src`），这里
   没有另加检查。
5. **手机端界面不在本仓库。** D3 在后端兜住（没有任何远程批准路径）；卡片载荷带
   `approveOn: "desktop"`，手机端显示"请在电脑上批准"要在手机端仓库里做。
6. 命令参数用 `approve: bool`（与 `chat_permission_respond` 一致），没有用设计稿里的
   `decision` 字符串。

### 验证

- runtime `plugins::` 34 项通过，新增 1 项：包在卡片显示后被换掉，旧摘要的批准和移除
  都被拒绝，换回新摘要才生效。
- desktop `plugins::` 9 项通过，其中新增 6 项：
  - 只有点击会启用：等待期间不启用；其他窗口、不同摘要、不存在的卡片都被拒绝且卡片
    保持等待；批准后结果为 `next-turn`，登记表清空；
  - 拒绝返回普通结果（`rejected`），停止回合后卡片无法再答，卡片显示后包被换掉则批准
    失败且插件保持停用；
  - 运行中升级：只改文字时 `executionUnchanged` 为 true，批准前运行的仍是旧摘要，批准后
    换成新版本；改了命令行时为 false，拒绝后旧版本照常运行；
  - 停用状态升级不弹卡片；`currentDigest` 过期被拒绝；移除先弹卡片，批准后才删除，
    草稿目录保留；
  - 待办任务回合和只读模式下写动作全部拒绝，`check_mcp` 在非完全权限下拒绝，全程不
    创建插件、不弹卡片、不发变更事件；
  - 卡片和工具结果里都不出现环境变量的值。
- desktop `remote::a_paired_device_has_no_way_to_approve_a_plugin` 通过。
- 前端：`tsc --noEmit` 通过；新增 `PluginApprovalCard.test.tsx` 7 项（命令与环境变量
  键展示、按卡片摘要答复且只提交一次、后端拒绝后可重答、未就绪和回合结束不给按钮、
  按结果显示决定、精简升级卡片、不被折叠、后到的流式副本不抹掉卡片），插件页和侧栏
  面板各新增刷新测试；`src/extensions` 与新测试共 51 项通过。
- 全套：`cargo test --workspace --no-fail-fast` 1589 通过、0 失败；desktop
  `cargo test --lib` 1039 通过、0 失败、15 忽略；前端
  `npx vitest run src --maxWorkers=4 --minWorkers=1` 202 个文件 2275 项全过；
  `npm run build` 通过。
- 应用内实测（2026-11-07，debug 版 + WebView2 CDP，模型 deepseek-v4.1-flash，
  权限模式"自动批准"，新建的空项目）：
  - 成功标准 1：一句"做一个记录实验假设的侧栏面板"，56 秒后出现启用卡片；Agent 依次
    inspect → template → 写草稿 → preview 零诊断 → install → 用一两句话说明 →
    request_enable。卡片出现时插件为 installed、未启用（完全权限下也要点，D1）。点
    "批准并启用"后回合按 Skill 结束并说明下一回合生效；Chat 顶部即刻出现插件面板按钮，
    面板四个区块齐全。
  - 成功标准 2：一句"把 scripts/date_diff.py 里的 days_between 包成 MCP 工具"，Agent
    先用 printf 自测 server.py 再预览、安装、请求启用；卡片显示的命令是快照目录里的
    `server.py`。批准后发"继续"，Agent 用 list 确认 running、MCP 已连接 1 个工具，经
    ToolSearch 激活 `mcp__p1270046a_dates__days_between` 并调用两次（310、-7 天）。
  - 成功标准 4：插件页里两个 AI 写的包与手动导入的包显示一致，可停用、移除。
  - 发现：Agent 写的 MCP 服务在运行时加载工作区里的 `scripts/date_diff.py`。批准绑定的
    是包的摘要，之后改这个脚本不需要重新批准，卡片上也看不出来（Agent 在正文里说了）。
    Skill 应要求默认把代码放进包里，引用工作区文件时必须明说。
  - 没验证：会话重新加载后卡片能否复原；手机端显示；拒绝路径只在单元测试里覆盖。

## M3 实现记录（2026-11-07）

### 落地内容

- 自动续跑（前端，`desktop/src/chat/pluginContinuation.ts` + `useChatRun.ts`）：
  - 触发条件：回合正常结束（走 `onComplete`，停止或失败的回合走 `onError`，不触发）；
    本回合里有一个带批准卡片的 `PluginManager` 调用，卡片类型是 enable 或 upgrade，
    结果不是错误，且 `application` 为 `next-turn`；
  - 本回合的提问本身不是续跑回合，所以一次批准只续跑一次，不会连环；
  - `onComplete` 触发时上一回合还持有发送锁，所以每 100ms 重试一次，最多 10 秒；
    这期间会话里出现新回合（用户先发了消息）就放弃；
  - 续跑走现有 `beginRun`，给模型的提示是英文指令：确认 `list` 状态，像用户那样
    实际使用，报告验证结果；
  - 界面上这一回合显示为居中的系统标记"插件已启用，继续验证"，没有编辑、复制按钮。
- `ChatTurn.origin = "plugin-continuation"`：
  - `userTurn` 带上它时同时设 `readOnly`；
  - `migrateTurn` 保留它，否则从存储读回后标记会变回普通用户消息（实现时踩到）；
  - 标题、项目意图观察、提问目录都用 `isUserQuestion` 排除它。
- 插件页入口（`PluginPackages.tsx` + `pluginAuthoringDrafts.ts`）：
  - 页头和空状态有"让 AI 创建插件"；
  - 无法启用或 MCP 连接失败的卡片上有"让 AI 修复"；
  - 两个入口都新开一个对话，把草稿放进输入框，不自动发送；
  - 修复草稿带上包名、版本、来源目录、状态、诊断（含文件和位置）和失败的 MCP 服务信息；
    来源目录不在当前项目里时，草稿要求先复制到 `.somniq/plugin-drafts/<短名>/`；
  - 新增一次性请求 `pendingNewChatDraft`，由 `useChatCommands` 消费：新建对话、填入
    草稿、聚焦输入框。已有的 `pendingChatInput` 会写进当前对话，覆盖用户没发出的草稿，
    所以没有复用。
- Skill 第 7 步改为：批准后结束本回合，SomniQ 会自动开始一个验证回合，不要让用户说
  "继续"。

### 与设计稿的出入

1. 设计稿写"续跑复用现有的 continue 路径"。实现复用的是 `beginRun`（continue 路径
   也走它），用一个新的 `origin` 参数把这一回合标成应用插入的，而不是 continue 那种
   "Continue from where you stopped." 的用户回合。
2. 续跑只认用户在卡片上批准的启用和升级。`disable` 的结果虽然也是 `next-turn`，但没有
   卡片，不触发；移除也不触发，因为没有新东西需要验证。
3. 应用内实测后补的一条：续跑提示和 Skill 第 7 步都写明"以 `PluginManager` 结果为准，
   不要读 SomniQ 的配置、插件存储或会话文件，不要打开其他对话"。实测中 Agent 为了
   验证，用 bash 读了 `~/.config/SomniQ` 下其他会话的文件。

### 验证

- 前端：
  - 新增 `chat/tests/pluginContinuation.test.tsx` 6 项：
    - 触发和不触发的 10 种情形；
    - 标记回合只读，存储读回后标记仍在；
    - 不计入提问目录；
    - 续跑提示内容；
    - 标记渲染、没有按钮。
  - 新增 `extensions/pluginAuthoringDrafts.test.ts` 4 项：
    - 创建草稿点名 Skill；
    - 只有无法启用或 MCP 失败的包才给修复入口；
    - 修复草稿带来源、诊断和失败服务，不带批准提示；
    - 项目外的来源要求先复制（同名前缀的兄弟目录也算项目外）。
  - `Chat.test.tsx` 新增 3 项：
    - 批准后恰好续跑一次，续跑提示正确、标记带 origin、不计入项目意图；
    - 拒绝后不续跑；
    - 跨视图草稿新开对话、不发送，原对话的草稿不被覆盖。
  - `PluginPackages.test.tsx` 新增 2 项：两个入口都写入草稿并切到 Chat，修复入口只出现在
    无法启用的包上。
  - 全套 `npx vitest run src --maxWorkers=4 --minWorkers=1`：204 个文件、2290 项全过；
    `tsc --noEmit` 通过；`npm run build` 通过。
- Rust：只改了 Skill 文案，runtime `cache::` 10 项通过（Skill 打包正常）。
- 应用内实测（2026-11-07，debug 版 + CDP，模型为当时的默认 MiniMax-M3.1-Flash，
  权限"自动批准"，新建的空项目）：
  - 插件页（空状态）页头和空状态各有一个"让 AI 创建插件"。点页头的那个，新开对话，
    输入框里是创建草稿，没有发送。
  - 把草稿里的占位换成"跟踪待读论文的侧栏面板"发送。这个模型第一回合没照 Skill 做
    最小版本，而是设计了"面板 + MCP + Skill"，并停下来问是否动手；回一句"先只做侧栏
    面板"后，第二回合写包、预览、安装、请求启用，约 7 分钟出卡片。
  - 点"批准并启用"后回合结束。随即出现居中标记"Plugin enabled · verifying it"并自动
    跑验证回合：Agent 先 `list` 确认 running，最后报告"没有发现缺陷，没有改动"，并说明
    自己看不到界面。验证回合结束后再等 8 秒，没有第二次续跑。
  - 手动装一个用 http 传输的坏包。插件页只在它的卡片上出现"让 AI 修复"，点后新开对话，
    草稿带包名、来源、状态和诊断，没有发送。
  - 发现：
    1. 验证回合里 Agent 用 bash 翻 SomniQ 配置目录里其他会话的文件，已在提示和 Skill 里
       禁止，但没有用新提示重跑实测；
    2. 较弱的模型不按 Skill 先做最小版本、会停下来问，这属于模型遵循的问题；
    3. 修复草稿里 `capability` 诊断只有位置（`mcp`），没有文件名，因为 dsh 的能力诊断
       没带 `file`。
- 测试数据已清理：测试插件、本机批准、测试项目登记、测试对话（含 M2 实测时漏清的
  两个对话）、测试目录都已删除；证据在 `E:\tmp\m1-scripts\m3-evidence`。


## 第一层扩展：数据面板（2026-11-09）

Agent 能做出来的面板从“清单 / 笔记 / 计划”扩到表格、指标、列表、Markdown、
进度、图表、表单和按钮，并且面板里的数据由 Agent 用 `PluginPanel` 工具写入。
契约、数据形状与不变量核对见 `chat-ui-plugins.md` 的“声明式 v2：数据面板”。

对自建流程的影响：

- 新模板 `data-panel`（`@local/experiment-board`，项目范围）；`inspect`
  返回的契约已含 schema 2 的组件、动作与范围。
- 建造流程不变：草稿 → 预览 → 安装 → 用户批准 → 验证。验证回合新增一步：
  用 `PluginPanel write` 把真实数据填进面板，写入成功即证明面板可用。
- 写面板数据不是插件变更，不需要批准卡片，无人值守运行也可写；改面板声明
  仍是包变更，仍需用户在本机主窗口批准。
- 按钮与表单只会把一条消息放进输入框（可选在输入框为空时直接发送）或打开
  项目内文件，不存在绕过回合直接调用工具的点击。

未做：点击直接调用 MCP 工具、`chat.sidebar` 以外的新位置、应用内目视验证
（见 `chat-ui-plugins.md` “本期未做”）。

### 导航页（2026-11-09 追加）

面板可以声明 `"slot": "nav.page"`，启用后在左侧导航栏有自己的图标并占一整页，
约束与宿主行为见 `chat-ui-plugins.md` 的“导航页位置 `nav.page`”。自建流程
不变；Skill 已说明何时选页面、如何把 `data-panel` 模板改成页面。

# Chat 中未在桌面端用起来的代码

审计日期：2026-07-25
范围：`crates/chat/`、`desktop/src/chat/`、`desktop/src-tauri/src/engine.rs`（Chat 段）、`crates/commands/`、`crates/tools/`、`crates/runtime/src/prompt.rs`

## 一、结论速览

桌面 Chat **有意**砍掉了 Agent Team / Dynamic Workflow 这两套多智能体编排（被 `TEAM_WORKFLOW_BLOCKED_TOOLS` 黑名单、`DISABLED_DESKTOP_SLASH_COMMANDS`、`include_team_orchestration: false` 三道闸门封死）。这是设计选择，不是 bug——但由此带来一批**只在 CLI 路径被使用、后端完整保留、前端却无法触达**的代码。

下表按"残留程度"排序：

| # | 名称 | 桌面 Chat 现状 | 后端真实存在 | 建议 |
|---|---|---|---|---|
| 1 | `team_orchestration_section()` 系统提示段 | 关（`include_team_orchestration: false`，engine.rs:2132） | ✅ `prompt.rs:616` 一整段完整 playbook | 留作 CLI 提示用，但桌面文档里要说清楚 |
| 2 | `Workflow` 工具 | 工具注册 + prompt 都关 | ✅ `tools/lib.rs:1076` | 同上 |
| 3 | `SpawnTeammate`/`ListTeam`/`WaitForTeammates`/`VerifyDeliverable`/`SendMessage`/`ClaimTask`/`CompleteTask`/`AgentSupervisor`/`TeamControl`/`EnterWorktree` | 模型不可见 | ✅ 全套实现 | 同上 |
| 4 | `/team`、`/workflows` 斜杠命令 | `DISABLED_DESKTOP_SLASH_COMMANDS` 拦截；UI 列表过滤；输入直接打时返回 "This desktop command is disabled in this build." | ✅ `commands/lib.rs:304`、CLI 测试 `coordination_cli.rs` | 同上 |
| 5 | `TeamCommandPlan`（CLI `/team list|raw|messages|events`） | 无 UI | ✅ `commands/lib.rs:489` + 测试 | 同上 |
| 6 | `TodoWrite`（单智能体内 todo 规划） | ✅ 桌面使用（WorkflowFlow 浮动面板） | ✅ `tools/lib.rs:786` | 真活，保留 |
| 7 | `Agent` 工具（启动子代理 + 持久化 handoff 元数据） | 模型可见、未在 UI 单独渲染 | ✅ `tools/lib.rs:848` | 桌面只作为"工具调用"展示，但很少调用 |
| 8 | `LlmReview`（外部 reviewer） | 模型可见、UI 不区分 | ✅ `tools/lib.rs:814` | 同 #7 |
| 9 | `IndependentReview`（独立 reviewer 自动审核） | ✅ 完整：UI + Rust + 自动触发 | ✅ 引擎自动触发 | 真活，保留 |
| 10 | `AskUserQuestion`（交互式提问） | ✅ 完整：QuestionCall UI + mpsc 通道 | ✅ `tools` 注册、`chat_question_respond` 接收 | 真活，保留 |
| 11 | `ProjectBriefCard`（项目 brief 侧栏） | ✅ 完整 | ✅ `projectBriefGet/Update` | 真活，保留 |
| 12 | `SideTaskPanel`（旁路子任务） | ✅ 完整：tab + read-only + handoff | ✅ 走标准 Chat ephemeral 通道 | 真活，保留 |

## 二、核心证据

### 1. 桌面端三道闸门

`desktop/src-tauri/src/engine.rs:407-428`：

```rust
// Team/workflow orchestration is intentionally disabled in desktop Chat for now:
// the prompt section is off, slash commands are disabled, and the UI has no live
// team monitor. Keep these tools out of the model-visible registry until the
// full desktop workflow surface is rebuilt.
const TEAM_WORKFLOW_BLOCKED_TOOLS: &[&str] = &[
    "AgentSupervisor",
    "SpawnTeammate",
    "SendMessage",
    "ClaimTask",
    "CompleteTask",
    "ListTeam",
    "WaitForTeammates",
    "VerifyDeliverable",
    "TeamControl",
    "Workflow",
    "EnterWorktree",
];

const DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS: &[&str] = &[];

const DISABLED_DESKTOP_SLASH_COMMANDS: &[&str] = &["team", "workflows"];
const DESKTOP_COMMAND_DISABLED_MESSAGE: &str = "This desktop command is disabled in this build.";
```

`engine.rs:2132`：

```rust
include_team_orchestration: false,   // 系统提示段也关掉
```

### 2. 前端的双层防护

`desktop/src/chat/chatRunHelpers.ts:319`：

```ts
export const DISABLED_DESKTOP_COMMANDS = new Set(["team", "teams", "workflow", "workflows"]);

export function visibleDesktopCommands(commands: DesktopCommandSpec[]) {
  return commands.filter((command) => !DISABLED_DESKTOP_COMMANDS.has(command.name.toLowerCase()));
}
```

`useChatCommands.ts:114`：用户手打 `/team` 时直接走 `assistantTextTurn(copy.disabledCommand)` 回复 "This desktop command is disabled in this build."，不进模型。

注意：前端过滤列表有 `teams`、`workflow`（复数形式），后端只有 `team`、`workflows`——两边没对齐。这是已知小不一致。

### 3. 但 `TodoWrite` 走的是另一条路

`model.ts:332-344` 的 `latestTodosFromTurns` 是真正活着的：模型每轮发出 `TodoWrite` 工具调用，`WorkflowFlow.tsx` 把最新的 todo 列表渲染成浮动面板（`Chat.tsx:723-731`）。`TodoWrite` 不在 `TEAM_WORKFLOW_BLOCKED_TOOLS` 里——它是**单智能体**的任务列表，不是多智能体编排。

`ChatMessage.tsx:963`：在消息流里**隐藏** `TodoWrite` 工具块（避免和浮动面板重复）。

### 4. CLI 路径完整保留

`crates/aris-cli/tests/coordination_cli.rs`：138-167 行测了 SpawnTeammate、ListTeam 真实工具调用；CLI 入口 `cli_repl.rs:1462` 还在调 `tools::render_team_view()`。

→ **结论：CLI 路径完全活着**。本次审计说的是桌面 Chat，而不是 CLI。

### 5. 系统提示段的归宿

`crates/runtime/src/prompt.rs:616` 的 `team_orchestration_section()` 是个 28 行 playbook（lead 设计 → 角色拆分 → verification gate → 终止条件），写得很好。它通过 `CommonSystemPromptOptions.include_team_orchestration` 开关，桌面设为 `false`，CLI 默认 `true`。

## 三、其他可以顺手清的小项

### A. `REPL_TOOL_NAMES` 里的两个空名字

`desktop/src/chat/model.ts:297`：

```ts
const REPL_TOOL_NAMES = new Set(["REPL", "node_repl", "mcp__node_repl__js"]);
```

后端 `crates/` 全树 `grep "node_repl"` 只命中这一行——`node_repl`、`mcp__node_repl__js` **没有真实工具产生**。它们来自 Claude Code 历史命名。`latestFileChangesFromTurns` 不会把它们识别成文件修改来源，所以这条 Set 的两条实际只是死代码。可以删掉只留 `["REPL"]`。

### B. `DISABLED_DESKTOP_COMMANDS` 与后端不对齐

| 来源 | 拦截的 command 名 |
|---|---|
| 前端 `chatRunHelpers.ts:319` | `team`, `teams`, `workflow`, `workflows` |
| 后端 `engine.rs:427` | `team`, `workflows`（无复数 `teams`/`workflow`） |

前后端都拦的是 `team`、`workflows`。前端的 `teams`/`workflow`（无 s）只是**永远不会被用户输入的形式**——`slash_command_specs` 注册的是 `team`（单数）。可以收紧成只匹配后端拦截名单，并删掉 `chatRunHelpers.ts` 与 `engine.rs` 的不一致。

### C. `FALLBACK_SLASH_COMMANDS` 兜底但不可达

`chatRunHelpers.ts:314`：

```ts
export const FALLBACK_SLASH_COMMANDS: DesktopCommandSpec[] = [
  { name: "help", description: "..." },
  { name: "model", description: "..." },
  { name: "permissions", description: "..." },
];
```

只在两个地方用：
1. `useChatCommands.ts:88` 初次渲染（`useState(FALLBACK_SLASH_COMMANDS)`）。
2. `useChatCommands.ts:102` 当 `chatCommandSpecs()` reject 时回退。
3. `useChatCommands.ts:130` 在非 Tauri 环境打印 `/help` 列表。

**实际**：桌面启动后 `chatCommandSpecs()` 会立刻成功并 `setDesktopCommands(visibleDesktopCommands(...))`，列表会刷新。所以兜底列表"显示一会儿"会一闪而过，但用户不会主动用——和真实命令列表没什么区别。这是 **设计意图**，不删。

### D. `IndependentReview` 只能清不能触发

桌面只暴露了 `chat_review_clear`，没有 `chat_review_start` 或 `chat_review_trigger`。`useIndependentReview.ts:95` 通过 `onChatReview` 事件监听后端自动触发（`engine.rs:5709` 的 `should_run_independent_review`）。

这是有意为之：每次用户消息结束后自动跑一次独立审核，UI 只展示结果，**不让用户手动触发**。如果哪天想给手动重跑按钮，加一个 `chat_review_rerun(session_id)` 命令即可，目前完全合理。

## 四、留作 CLI 用的代码清单（不要删）

这些代码在桌面 Chat 完全无效，但在 CLI / aris-cli 路径里活着，**不要删**：

- `crates/commands/src/lib.rs:304-310` 的 `SlashCommand::Team`、`SlashCommand::Workflows` 解析
- `crates/commands/src/lib.rs:489-528` 的 `TeamCommandPlan` + `plan_team_command()`
- `crates/tools/src/team_state.rs` 全套（`render_team_view`、`SpawnTeammate`、`ListTeam`、`WaitForTeammates`、`VerifyDeliverable` 等）
- `crates/tools/src/lib.rs:865-1100` 这 11 个 team / workflow 工具的 `ToolSpec`
- `crates/runtime/src/prompt.rs:616-644` 的 `team_orchestration_section()`
- `crates/aris-cli/tests/coordination_cli.rs` 的 6 个 team 测试

## 五、可立刻动手的小改

1. **统一前后端禁用名单**：把 `chatRunHelpers.ts:319` 收成 `new Set(["team", "workflows"])`（与 `engine.rs:427` 对齐）。
2. **删掉 `model.ts:297` 的死键**：`REPL_TOOL_NAMES` 改为 `new Set(["REPL"])`。
3. **加注释**：在 `chatRunHelpers.ts:319` 旁注明"与 `engine.rs::DISABLED_DESKTOP_SLASH_COMMANDS` 同步"，避免以后漂移。

这些都是几分钟级别、对功能零风险的清理。

## 六、未在本次审计范围

- `desktop/src/chat/useChatComposer.ts`、`useChatSessionController.ts`、`useChatStream.ts`：都是真活，未发现死代码。
- `desktop/src/chat/ChatCompanion.tsx`：手机伴侣代码，`mobile remote companion v1`，独立路径，未审计。
- `desktop/src/chat/MarkdownContent.tsx` / `MermaidDiagram.tsx` / `ChatImagePreview.tsx` / `ChatSidebar.tsx`：渲染层，未发现死代码。
- 后端 `crates/commands/` 里 `/goal`、`/memory`、`/init`、`/bughunter`、`/debug-tool-call` 等命令：前端的 `visibleDesktopCommands` 会把它们都放进桌面 Chat 的下拉，没阻断。**这次没细看这些命令在桌面是否真的能用**，是后续可做的单独审计。
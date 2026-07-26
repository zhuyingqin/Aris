# 整体代码库审计

审计日期：2026-07-25
范围：crates/、desktop/src-tauri/src/、desktop/src/

## 一、总览

| 维度 | 规模 |
|---|---|
| Rust crates 文件数 | 84 .rs 文件（不含 tests） |
| Tauri 后端 | ~40k LOC（含 tests） |
| 桌面前端 | ~36 个 chat 文件 + 同等量级的 lab/literature/typeset/mail/knowledge |
| 已注册 Tauri 命令 | ~110 个（`lib.rs:430-557`） |
| 前端 API 绑定 | 257 个 export（`desktop/src/api/tauri.ts`） |
| 后端工具数 | ~50 个 `ToolSpec`（`crates/tools/src/lib.rs`） |
| 桌面 Chat 屏蔽的工具 | 11 个（`TEAM_WORKFLOW_BLOCKED_TOOLS`，`engine.rs:411`） |
| 桌面 Chat 屏蔽的斜杠命令 | 2 个（`team`、`workflows`） |

整体感觉：项目健康度尚可，但**前后端漂移 + 长期故意屏蔽的多智能体编排**留下了几片值得清理的死代码区。本审计把这些问题分成"立即可清的小项"、"结构性 bug"、"半成品功能"三类。

## 二、立即可清的小项（5-15 分钟级别，零风险）

### 1. 死环境变量

- **`ARIS_RESOURCE_DIR`**：`desktop/src-tauri/src/lib.rs:165` 设置，但全树 grep 不到任何 consumer。可删。
- **`SOMNIQ_TECTONIC`**：`lib.rs:192` 设置、`lib.rs:205` 读取；但 `lib.rs:193` 同时还设置了 `ARIS_TECTONIC`，**且只有 `ARIS_TECTONIC` 被实际消费**（`crates/runtime/assets/skills/{paper-compile,paper-poster,paper-slides}/SKILL.md`）。`SOMNIQ_TECTONIC` 是历史别名，只在测试和 `engine.rs:2144` 的提示里出现，可删。
- **`CLAWD_TODO_STORE`**：`state.rs:139` 设置，`engine.rs:7010` 读取，确认活。可保留。

### 2. 前端 ↔ 后端斜杠命令拦截名单漂移

| 来源 | 拦截 |
|---|---|
| 前端 `desktop/src/chat/chatRunHelpers.ts:319` | `team`, `teams`, `workflow`, `workflows` |
| 后端 `desktop/src-tauri/src/engine.rs:427` | `team`, `workflows` |

`teams` 和 `workflow`（无 s）前端拦截但后端永远不返回。统一成 `["team", "workflows"]` 即可。

### 3. `REPL_TOOL_NAMES` 死键

`desktop/src/chat/model.ts:297`：
```ts
const REPL_TOOL_NAMES = new Set(["REPL", "node_repl", "mcp__node_repl__js"]);
```
后端全树 grep 不到 `node_repl`/`mcp__node_repl__js` 注册。`latestFileChangesFromTurns` 永远识别不到它们。改成 `["REPL"]`。

### 4. `FALLBACK_SLASH_COMMANDS` 设计意图合理，保留

仅在初始渲染 + `chatCommandSpecs()` 失败回退 + 非 Tauri 环境 `/help` 列表用。是**有意**保留的兜底，不是死代码。

## 三、半成品功能 / 屏蔽路径（需要决策）

### A. Team/Workflow 11 个工具全屏蔽

`engine.rs:411-423` 黑名单：

```
AgentSupervisor, SpawnTeammate, SendMessage, ClaimTask, CompleteTask,
ListTeam, WaitForTeammates, VerifyDeliverable, TeamControl, Workflow, EnterWorktree
```

- 后端完整实现：`crates/tools/src/team_state.rs`（1500+ LOC）+ `crates/tools/src/lib.rs:865-1100` 的 `ToolSpec`
- 系统提示 playbook：`crates/runtime/src/prompt.rs:616-644` 的 `team_orchestration_section()`（桌面 `include_team_orchestration: false`）
- CLI 路径真活：`crates/aris-cli/tests/coordination_cli.rs` 的 6 个端到端测试

**结论**：这是有意的设计选择，不是 bug。详见 `docs/development-logic/chat-dead-code-audit.md`。

**短期建议**：在 `engine.rs:407` 的注释里加上"see docs/development-logic/chat-dead-code-audit.md"，避免下一个 contributor 以为是漏屏蔽。

### B. `Agent` 工具调用结果无法回看

`crates/tools/src/lib.rs:848` 的 `Agent` 工具**没被屏蔽**，模型可以调。它会：
1. 写 `<project>/agents/{id}.md` —— 任务描述 + prompt
2. 写 `<project>/agents/{id}.json` —— manifest（id / status / usage / 时间戳）
3. 起 OS 线程 `clawd-agent-{id}` 跑子代理
4. 子代理结束时把终态追加 manifest

**前端零通道**：`grep "agent_store" desktop/src` 只命中 `state.rs` 的环境变量设置，没有读取路径。`ChatMessage.tsx` 把 `Agent` 工具块当作普通 `<ToolCall>` 渲染，看不到 manifest、看不出子代理在跑没。

建议：
- **短期**：加一个 `chatAgentManifest(id)` Tauri 命令 + 一个"打开 agents 目录"按钮
- **中期**：让 manifest 列表展示在 Chat 的 side panel

### C. `IndependentReview` 只能清不能触发

桌面只暴露 `chat_review_clear`（`engine.rs:4267`），无 `chat_review_start`/`chat_review_trigger`。`useIndependentReview.ts:95` 通过 `onChatReview` 监听后端自动触发（`engine.rs:5709` 的 `should_run_independent_review`）。

这是有意为之：每次用户消息后自动跑一次独立审核，UI 只展示结果。如果要加"手动重跑"按钮，加一个 `chat_review_rerun(session_id)` 命令即可，**目前合理**。

### D. 移动伴侣 `ChatCompanion` 路径未审计

`desktop/src/chat/ChatCompanion.tsx` + `remote.rs` 的 `remote_chat_*` 是 0.4.28 引入的手机伴侣代码，独立链路。本次审计未深入。如果要审，需要单开一轮。

## 四、值得注意的架构性观察

### 1. 端到端往返工具的"半透"渲染

`ChatMessage.tsx:962-974` 有三层特殊处理：
- `TodoWrite` → 不渲染（走 `WorkflowFlow` 浮动面板）
- `AskUserQuestion` → 走 `<QuestionCall>` 交互组件
- 其他工具 → 走通用 `<ToolCall>`（默认折叠 + JSON 详情）

但**实际被特殊处理的只有这 2 个**。`Agent` / `LlmReview` / `Skill` / `NotebookExecute` 等重要工具都掉到默认 `<ToolCall>`，JSON 原始输出对用户毫无意义。

建议：要么为高频工具加特化渲染（`LlmReview` 显示 reviewer 模型 + verdict、`Skill` 显示加载内容预览），要么至少把它们从默认折叠组里拎出来。

### 2. `desktop/src/chat/useChatStream.ts` 单一事件通道

整段 Chat 流（text / thinking / tool / tool-progress / tool-result / permission / question / review / context-compacted / done / error）全走同一个 `useChatStream`，dispatch 由事件名分支。**单测覆盖得很好**（`tests/useChatStream.test.tsx`），但**未来风险**：如果加入新事件类型（比如 sub-agent 心跳、edit-history 事件），需要回到这个中心分发器逐处加分支。

### 3. `unwind`/`.expect()` 共 306 处

`grep ".unwrap()|.expect(" desktop/src-tauri/src`：

- `lib.rs:560` 的 `.expect("error while building SomniQ Studio")` —— 应用启动 panic，可接受
- `chat_events.rs:916-926` 三连 `.expect()` —— 已经验证过 schema 的事件重建，可接受
- `terminal.rs` 7 处 `.lock().unwrap()` —— Mutex 标准用法，可接受
- `typeset.rs:716` `.expect("system clock")` —— SystemTime 标准，可接受

**没有发现明显不安全的 panic 路径**。Mutex poison 风险低（无 panic boundary 跨线程共享状态）。

### 4. 静默 catch 数量

前端 `grep "catch {` 在 desktop/src 共 **98 处**。审计的几个典型：
- `App.tsx:347/361/409/489/735` —— 启动/退出/窗口控制 fallback，合理
- `api/labPreview.ts:217/226` —— kernel preview fallback，合理
- `auth/Login.tsx:39` —— OAuth 错误兜底，合理
- `chat/Chat.tsx:534/545` —— Chat 事件读取兜底，**事件丢失静默**，值得加 `console.warn`
- `chat/ChatComposer.tsx:44/526`、`chat/ChatCompanion.tsx:29/62/100` —— 同上

建议：这些"静默吞"的位置至少在开发模式 `console.warn`，不然用户报告 bug 时无日志可看。

## 五、跨模块契约（FE ↔ BE）

### 已确认无漂移
- `chat_send_rich`、`chat_set_context`、`chat_rewind_to_user_message`、`chat_delete`、`chat_cancel`、`chat_review_clear` —— 全部对齐
- 邮件（mail_*）、文献（literature_*）、知识（knowledge_*）、实验室（lab_*）、终端（terminal_*）—— 前端 145 个 invoke 调用，后端一一对应
- 事件订阅（onChatDelta、onChatTool、onChatReview、onChatPermissionRequest 等）—— 一一对齐

### 一个小不一致
- `engine.rs:2144` 的提示里说"Do not use Tectonic or `SOMNIQ_TECTONIC` for `.tex` documents"，但 `SOMNIQ_TECTONIC` 是已死别名（见 II.1）。把名字替换成 `ARIS_TECTONIC` 或直接删掉这段表述。

## 六、值得做但不在本审计范围

1. **审计 Lab/Typeset/Mail/Literature/Knowledge 的相似盲区** —— 本次只审了 Chat。本审计只对 Lab 路径抽查了 `desktop/src/lab/` 的几个端点。
2. **审计 `crates/aris-cli/` CLI 入口的死代码** —— CLI 是另一条平行路径，未审计。
3. **跑一遍 `cargo clippy --all-targets`** —— 项目体量下，应有大量 lints 噪声和少量真实 warning。
4. **跑 `tsc --noEmit`** 在 desktop 上，看有没有未使用的导出 / 类型不一致。

## 七、建议的执行顺序

| 优先级 | 项 | 耗时 | 风险 |
|---|---|---|---|
| 0 | II.1 删 `ARIS_RESOURCE_DIR` + `SOMNIQ_TECTONIC` | 5 分钟 | 零（已确认无消费者） |
| 0 | II.2 统一拦截名单 | 5 分钟 | 零 |
| 0 | II.3 `REPL_TOOL_NAMES` 收紧 | 2 分钟 | 零 |
| 1 | IV.4 给静默 catch 加 dev-mode `console.warn` | 1 小时 | 零 |
| 2 | III.B 加 `chatAgentManifest` Tauri 命令 + 按钮 | 半天 | 低 |
| 2 | IV.1 给 `LlmReview` / `Skill` 加特化渲染 | 1 天 | 中 |
| 3 | 单独审计 Lab/Typeset/Mail/Literature 死代码 | 1-2 天 | — |
| 3 | 单独审计 CLI 路径死代码 | 1 天 | — |
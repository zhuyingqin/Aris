# 待办任务可靠执行内核实施方案

> 状态：实施提案（Implementation Proposal）  
> 日期：2026-09-10  
> 范围：SomniQ Desktop 待办任务、任务会话、Git 工作树、结果审查与交付物归属  
> 行为参考：Codeg 0.30.6 的持久会话、任务状态机、画布控制面与工作树审查流程；本文不复制其代码或通用画布产品形态。

---

## 1. 决策摘要

SomniQ 当前不应优先建设“无限画布”。本阶段首先把待办任务建设成一个可信的研究执行内核：任务创建后能够自动执行，状态可解释、可恢复，用户可以暂停、继续和回答阻塞问题；执行结果以稳定快照进入独立 Reviewer 循环，最终由用户审查仓库变更和交付物，再决定是否合并或导出。

实施拆为六个可独立合并的 PR：

1. 修复任务页和主页的布局、样式加载及“创建后不启动”；
2. 补齐任务状态机、暂停/恢复、等待输入、心跳和事件 revision；
3. 用结构化审查快照替换单一文本 diff；
4. 把运行数据、仓库文件和独立交付物拆成三类存储；
5. 将独立 Reviewer → Executor 修订循环接入任务引擎；
6. 让定时任务复用同一个任务引擎。

画布只在上述事实源稳定后做受控原型。它必须是任务操作面，而不能成为第二套状态系统。

---

## 2. 背景与现状

当前待办任务已经具备一些可靠性基础：

- 每个任务在独立 Git 工作树和 `somniq/task/*` 分支上执行；
- `run_seq` 防止取消后的旧运行结果把任务重新写回待确认；
- 工作树中的变更会在任务结束时提交，再基于 `base_sha..HEAD` 生成差异；
- 合并先在任务工作树吸收基础分支，再将基础分支快进，避免用户检出目录进入冲突状态；
- 合并前持久化 `merge_intent`，启动时可判断合并是否已经落地；
- 同一项目的合并经过进程内串行锁。

相关实现集中在：

- `desktop/src-tauri/src/work_task/model.rs`
- `desktop/src-tauri/src/work_task/store.rs`
- `desktop/src-tauri/src/work_task/engine.rs`
- `desktop/src-tauri/src/work_task/worktree.rs`
- `desktop/src-tauri/src/work_task/commands.rs`
- `desktop/src/tasks/Tasks.tsx`
- `desktop/src/tasks/boardColumns.ts`

但现有实现还有五个产品级缺口：

1. **状态不可解释。** 当前明确省略了 `awaiting_input`，启动中断统一落到 `failed`，用户无法区分主动暂停、等待回答、进程中断和真正失败。
2. **任务创建语义不符合预期。** 创建只得到 `todo`，还要再次点击开始；界面也没有清楚区分“保存待办”和“创建并开始”。
3. **事件只是刷新提示。** `work-task-changed` 没有 revision 和活动信息；订阅、首次加载、迟到事件之间缺少一致性协议。
4. **审查等同于文本 patch。** 二进制文件、忽略文件、独立交付物以及旧版脏工作树无法稳定表达，空字符串被直接显示为“没有产生任何改动”。
5. **`.somniq` 同时承担运行数据和用户交付物。** 这让隐藏运行目录与论文、报告、幻灯片等最终成果混在一起；若简单改放项目根目录，又会污染用户项目结构。

---

## 3. 产品与架构原则

### 3.1 单一任务事实源

状态只由 Rust 任务存储和执行引擎决定。任务看板、会话页、主页状态、自动化历史以及未来画布只是同一份任务快照的投影，不在前端自行推断生命周期。

### 3.2 会话是任务的执行记录，不是任务本身

`WorkTask` 持有生命周期、工作树、审查、交付物和恢复信息；`session_id` 指向追加式对话历史。任务可以有 Executor、Reviewer 和修订会话，但任务状态不能从最后一条聊天消息猜测。

### 3.3 等待输入必须结束当前模型轮次

后台任务不能把模型请求或权限通道无限挂起。需要人类决定时，当前轮次以结构化 `AwaitingInput` 结果安全结束，任务保存问题和上下文。用户回答后，在同一工作树和会话上启动新一轮。

### 3.4 三类文件不能混淆

| 类别 | 示例 | 默认位置 | 是否进入 Git diff |
| --- | --- | --- | --- |
| 运行数据 | 会话、缓存、工具临时文件、任务账本 | 应用数据目录或项目 `.somniq/` | 否 |
| 项目修改 | 源码、已有论文工程、配置、测试 | 项目原有常规路径 | 是 |
| 独立交付物 | 与项目代码无直接关系的报告、PPT、导出 PDF | SomniQ 本地交付物库，或用户选定目录 | 独立审查，不强行并入 Git |

### 3.5 SomniQ 保留独立审查优势

Codeg 的任务状态与控制面值得借鉴，但 SomniQ 不应退化为“智能体完成后直接等待合并”。Executor 完成后必须进入独立 Reviewer，审查通过或达到明确停止条件后才交给用户。

---

## 4. 用户体验契约

### 4.1 创建任务

新建窗口提供两个明确动作：

- 主动作：`创建并开始`，创建后立即进入 `queued`；
- 次动作：`仅保存到待办`，保持 `todo`。

同时选择结果归属：

- `修改当前项目`；
- `生成独立交付物`；
- `保存到指定文件夹`。

系统可以根据提示建议一种类型，但不得在没有展示的情况下静默更改目标位置。

### 4.2 看板栏目

中文固定为：

| 栏目 | 包含状态 |
| --- | --- |
| 待办 | `todo`、`queued` |
| 进行中 | `preparing`、`running`、`pausing`、`reviewing`、`revising`、`merging` |
| 待确认 | `paused`、`awaiting_input`、`review`、`interrupted`、`failed` |
| 已完成 | `done`、`canceled` |

“需要你”不作为中文栏目名称。卡片内部仍应显示精确状态，例如“等待你选择保存位置”或“Reviewer 正在第 2 轮审查”。

### 4.3 卡片最小信息

每张活动任务卡必须显示：

- 精确状态和当前角色（Executor / Reviewer）；
- 当前阶段说明 `progress_message`；
- 最近心跳时间；
- 工作分支或独立交付物目的地；
- 可执行动作；
- 明确的错误、阻塞问题或中断原因。

只有当任务确实有运行存活证据时才显示“执行中”。

### 4.4 操作语义

| 操作 | 行为 |
| --- | --- |
| 暂停 | 请求当前轮次安全停止，保留工作树和会话 |
| 继续 | 在同一上下文启动下一轮 |
| 回答 | 将回答追加到原任务会话并继续 |
| 取消 | 停止运行，并按策略清理或保留工作树 |
| 退回修改 | 带用户指令回到 Executor，而不是清空任务 |
| 仅提问 | 在不修改文件的只读轮次中解释结果 |
| 重新验证 | 重新运行 Reviewer/验证，不默认修改文件 |
| 接受并合并 | 仅合并项目修改；独立交付物执行确认/导出 |

---

## 5. 生命周期与状态机

### 5.1 状态定义

```rust
pub enum WorkTaskStatus {
    Todo,
    Queued,
    Preparing,
    Running,
    Pausing,
    Paused,
    AwaitingInput,
    Reviewing,
    Revising,
    Review,
    Merging,
    Interrupted,
    Failed,
    Done,
    Canceled,
}
```

### 5.2 关键转换

```text
todo -> queued -> preparing -> running
running -> reviewing -> review
reviewing -> revising -> reviewing
running/reviewing/revising -> pausing -> paused
running/reviewing/revising -> awaiting_input
paused/awaiting_input/interrupted/failed -> queued
review -> merging -> done
任何非 merging 状态 -> canceled
```

约束：

- `run_seq` 在每次启动、恢复、取消或暂停所有权变化时递增；
- settle 只能更新相同 `run_seq` 的任务；
- `merging` 不允许普通取消；
- `awaiting_input` 必须携带 `pending_action`；
- `review` 必须携带稳定的审查快照，或明确的 `empty_reason`；
- `done` 只有在合并、确认无项目改动或交付物导入完成后才能到达。

### 5.3 停止原因

取消注册表从 `AtomicBool` 升级为有语义的停止请求：

```rust
pub enum WorkTaskStopReason {
    Cancel,
    Pause,
    Shutdown,
}
```

`Pause` 和 `Shutdown` 不删除工作树。`Cancel` 的默认清理策略保持与当前行为兼容，但 UI 允许用户选择保留工作树用于恢复。

---

## 6. 持久化数据契约

### 6.1 任务存储快照

存储 schema 升级到 v2：

```rust
pub struct WorkTaskFile {
    pub schema_version: u32,
    pub revision: u64,
    pub tasks: Vec<WorkTask>,
}
```

每次在存储锁内成功修改后：

1. 重新读取最新文件；
2. 校验期望的任务状态和 `run_seq`；
3. 修改任务；
4. `revision += 1`；
5. 原子替换文件；
6. 发送包含该 revision 的事件。

### 6.2 WorkTask 新增字段

```rust
pub struct WorkTask {
    // 现有字段保留
    pub phase: Option<WorkTaskPhase>,
    pub progress_message: Option<String>,
    pub last_heartbeat_at: Option<u64>,
    pub pending_action: Option<WorkTaskPendingAction>,
    pub stop_reason: Option<WorkTaskStopReason>,
    pub interrupted_reason: Option<String>,
    pub output_policy: WorkTaskOutputPolicy,
    pub review_snapshot: Option<WorkTaskReviewSnapshot>,
    pub review_state: Option<WorkTaskReviewState>,
    pub artifacts: Vec<WorkTaskArtifact>,
}
```

### 6.3 待处理动作

```rust
pub enum WorkTaskPendingAction {
    Question {
        prompt: String,
        choices: Vec<String>,
    },
    Permission {
        tool_name: String,
        reason: String,
        requested_scope: String,
    },
    OutputDestination {
        proposed_name: String,
        artifact_kind: String,
    },
    MergeConflict {
        paths: Vec<String>,
        worktree_path: String,
    },
}
```

问题答案和权限决定必须写入任务事件/会话历史，保持审计性。

---

## 7. 事件与活性协议

### 7.1 快照 API

`work_task_list` 从 `Vec<WorkTask>` 改为：

```ts
interface WorkTaskSnapshot {
  revision: number;
  tasks: WorkTask[];
}
```

兼容期可以保留旧命令，新增 `work_task_snapshot`，前端迁移完成后再移除旧接口。

### 7.2 变更事件

```ts
interface WorkTaskChangedEvent {
  projectId: string;
  taskId?: string;
  revision: number;
  status?: WorkTaskStatus;
  kind: "created" | "updated" | "deleted" | "reconciled";
}
```

前端加载顺序：

1. 先订阅事件；
2. 再读取快照；
3. 忽略 `revision <= currentRevision` 的事件；
4. 发现 revision 跳跃时重新取完整快照；
5. 只在存在引擎拥有状态时启用 5 秒兜底刷新。

### 7.3 心跳

任务运行时从现有 Chat 活动/工具事件提取简短进度。内存中可以高频更新，持久化和板事件最多每 2 秒一次，避免大量原子写。

判定规则：

- 进程仍在且心跳正常：显示精确运行阶段；
- 进程存在但长时间无事件：显示“正在等待当前工具返回”，不能自动宣称暂停；
- 应用启动时发现旧的引擎拥有状态：转为 `interrupted`；
- `merging` 使用 `merge_intent` 单独恢复，不能按普通中断处理。

---

## 8. 等待输入与恢复实现

当前 `WorktreePermissionPrompter` 对所有请求立即允许或拒绝，保证无人值守任务不挂起。该性质必须保留，但需要增加“拒绝后可交还给用户”的结构化路径。

第一版采用**轮次级暂停**，不尝试序列化正在执行的模型请求：

1. 工作任务中的 `AskUserQuestion` 先把 `pending_action` 持久化，并把状态切换为 `awaiting_input`；
2. 工具返回内部中断信号，runtime 保存当前会话并结束当前工具循环；
3. runner 将该信号识别为 `WorkTaskTurnOutcome::AwaitingInput`，完成收尾并立即释放执行槽；
4. 用户调用 `work_task_reply`；
5. 问题和回答写入续跑上下文，沿用相同 `session_id` 和工作树；
6. 下一次 claim 增加 `run_seq`，以新模型轮次重新排队。

建议结果类型：

```rust
pub enum WorkTaskTurnOutcome {
    Completed { summary: String },
    AwaitingInput { action: WorkTaskPendingAction },
    Paused,
    Canceled,
    Failed { error: String },
}
```

不能仅靠解析模型最终文本中的问号判断是否等待输入。

---

## 9. 结构化审查快照

### 9.1 数据结构

```rust
pub struct WorkTaskReviewSnapshot {
    pub base_sha: String,
    pub head_sha: String,
    pub repository_files: Vec<WorkTaskReviewFile>,
    pub artifacts: Vec<WorkTaskArtifact>,
    pub text_patch: String,
    pub patch_truncated: bool,
    pub empty_reason: Option<WorkTaskEmptyReason>,
    pub captured_at: u64,
}

pub struct WorkTaskReviewFile {
    pub path: String,
    pub change_kind: WorkTaskFileChangeKind,
    pub binary: bool,
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub sha256: Option<String>,
    pub preview_kind: Option<String>,
}
```

### 9.2 Git 采集

- `git diff --name-status -z <base> <head>`：完整文件名和增删改类型；
- `git diff --numstat -z <base> <head>`：文本行统计和二进制识别；
- `git diff <base> <head>`：文本 patch，允许截断但必须标记；
- 对新版本执行结束路径，先 `commit_all`，再读取固定的 `head_sha`；
- 对旧任务保留当前“打开差异时修复脏工作树”的兼容路径，但写入新的审查快照后只执行一次。

### 9.3 空结果语义

`empty_reason` 至少区分：

- `NoRepositoryChanges`：任务只分析，没有改项目；
- `ArtifactsOnly`：产生了独立交付物；
- `NothingProduced`：既无修改也无交付物；
- `WorktreeMissing`：无法审查；
- `LegacySnapshotRecovered`：已从旧脏工作树恢复；
- `SnapshotFailed`：采集失败，附带错误。

UI 不得再把任意空 patch 统一翻译成“没有产生任何改动”。

---

## 10. 交付物存储与导出

### 10.1 新存储边界

`.somniq` 只保留项目级运行数据和兼容数据。新生成的独立交付物最终导入应用管理目录，例如：

```text
<app-data>/artifacts/<project-id>/<task-id>/<artifact-id>/
```

用户不需要直接浏览这个目录。Desktop 提供“交付物”面板、预览、“在文件管理器中显示”和“导出到……”操作。

### 10.2 工作树内暂存

任务运行时的独立交付物先写到工作树内专用暂存目录，例如：

```text
.somniq/task-output/<task-id>/
```

该目录：

- 不进入仓库提交；
- 在清理工作树前按 manifest 导入应用交付物库；
- 复制后计算 SHA-256 并复核；
- 导入失败时任务不得进入 `done`，并保留工作树以便恢复。

项目修改仍写入项目常规目录并进入 Git。修改已有论文或报告时必须沿用原路径，不得强制搬入交付物库。

### 10.3 交付物清单

```rust
pub struct WorkTaskArtifact {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub title: String,
    pub managed_path: String,
    pub exported_path: Option<String>,
    pub mime_type: Option<String>,
    pub byte_size: u64,
    pub sha256: String,
    pub source_session_id: String,
    pub created_at: u64,
}
```

### 10.4 旧目录兼容

- 继续识别 `.somniq/papers`、`.somniq/slides`、`.somniq/reports` 等旧交付物；
- 标记来源为 `legacy_project_data`；
- 不自动移动、删除或重命名；
- 用户可通过 UI 导入新交付物库或导出到指定目录；
- 新任务不再把这些目录作为无条件默认最终位置。

---

## 11. 独立 Reviewer 循环

### 11.1 执行顺序

1. Executor 完成当前轮次；
2. engine 提交项目改动并导入交付物；
3. 生成不可变审查快照；
4. 状态切换为 `reviewing`；
5. 独立 Reviewer 读取任务目标、快照、验证记录和交付物；
6. Reviewer 返回结构化 verdict；
7. `pass` 进入用户 `review`；
8. `revise` 进入 `revising`，把问题追加到原 Executor 会话；
9. 修订后重新提交、重新快照、重新审查；
10. 达到轮次上限或遇到外部阻塞时进入 `review` 或 `awaiting_input`，明确列出剩余问题。

### 11.2 Review 数据

```rust
pub struct WorkTaskReviewState {
    pub round: u32,
    pub max_rounds: u32,
    pub reviewer_session_id: String,
    pub verdict: Option<WorkTaskReviewVerdict>,
    pub issues: Vec<WorkTaskReviewIssue>,
    pub verification: Vec<WorkTaskVerificationResult>,
}
```

Reviewer 必须独立于 Executor 的模型角色和上下文。可以共享任务事实和产物，但不能将 Executor 的自我总结当作通过依据。

---

## 12. API 变更

保留现有命令并逐步增加：

```text
work_task_snapshot
work_task_create_and_start
work_task_pause
work_task_resume
work_task_reply
work_task_follow_up
work_task_review_snapshot
work_task_artifact_list
work_task_artifact_export
```

`work_task_follow_up` 接受明确 intent：

```text
revise
continue
question
verify
```

其中 `question` 必须在只读上下文回答，不得默认修改文件；`verify` 默认只重新运行验证和 Reviewer。

---

## 13. 分 PR 实施顺序

### PR 1：UI 与创建行为（P0，1–2 天）

涉及：

- `desktop/src/App.tsx`
- `desktop/src/chat/Chat.tsx`
- `desktop/src/chat/ChatComposerGit.css`
- `desktop/src/tasks/Tasks.tsx`
- `desktop/src/tasks/Tasks.css`
- `desktop/src/tasks/Tasks.test.tsx`

内容：

- 在稳定入口加载 Tasks 样式，防止懒加载样式缺失；
- 任务页使用独立高度、滚动和网格布局契约；
- 修复主页分支选择器宽度和换行；
- 默认动作改为创建并开始；
- 增加“仅保存到待办”；
- 统一“待确认”文案。

完成条件：任务页和主页在常见尺寸/缩放下不破版；新任务默认开始执行。

### PR 2：状态、暂停与事件一致性（P0，3–4 天）

涉及：

- `desktop/src-tauri/src/work_task/model.rs`
- `desktop/src-tauri/src/work_task/store.rs`
- `desktop/src-tauri/src/work_task/engine.rs`
- `desktop/src-tauri/src/work_task/permission.rs`
- `desktop/src-tauri/src/work_task/commands.rs`
- `desktop/src-tauri/src/engine.rs`
- `desktop/src/api/tauri.ts`
- `desktop/src/types.ts`
- `desktop/src/tasks/boardColumns.ts`

内容：新增状态、停止原因、心跳、pending action、revision 快照和恢复命令；启动协调器迁移旧状态。

完成条件：用户能准确区分运行、暂停、等待输入、中断和失败；迟到 settle 不改变新一代状态。

### PR 3：结构化审查快照（P0，2–3 天）

涉及：

- `desktop/src-tauri/src/work_task/worktree.rs`
- `desktop/src-tauri/src/work_task/engine.rs`
- `desktop/src-tauri/src/work_task/model.rs`
- `desktop/src/tasks/Tasks.tsx`
- 新增 `desktop/src/tasks/TaskReviewPanel.tsx`

内容：文件清单、文本 patch、二进制元数据、空结果原因、稳定 base/head；将内联 `<pre>` 改为审查面板。

完成条件：文本、未跟踪文件、PDF、图片和旧版 `.somniq` 交付物都不会被误报为零差异。

### PR 4：交付物库与输出策略（P1，3–4 天）

涉及：

- `crates/tools/src/layout.rs`
- `crates/tools/src/lib.rs`
- `desktop/src-tauri/src/work_task/*`
- 新增 `desktop/src-tauri/src/artifacts.rs`
- 新增 `desktop/src/artifacts/*`

内容：三类文件边界、暂存导入、manifest、预览/导出、旧路径兼容。

完成条件：新独立报告既不进入项目根目录，也不以 `.somniq` 作为用户最终位置；工作树清理不丢交付物。

### PR 5：Reviewer 修订循环（P1，3–5 天）

涉及：

- `desktop/src-tauri/src/work_task/engine.rs`
- `desktop/src-tauri/src/engine.rs`
- 现有 Reviewer/runtime 共享模块
- `desktop/src/tasks/TaskReviewPanel.tsx`

内容：独立 Reviewer、结构化 verdict、自动修订上限、验证结果和用户最终确认。

完成条件：Executor 不能自我批准；每轮问题、修改和 verdict 都可追溯。

### PR 6：自动化统一（P2，2–3 天）

涉及：

- 定时任务控制器
- `desktop/src-tauri/src/work_task/engine.rs`
- 自动化历史 UI

内容：定时任务只负责在到期时创建/排队普通 WorkTask，复用同一状态、审查和恢复机制。

完成条件：手工与定时任务不存在两套运行状态和两套结果审查逻辑。

---

## 14. 测试计划

### 14.1 Rust 单元与集成测试

在 `desktop/src-tauri/src/tests/work_task.rs` 增加：

- 创建并开始原子地进入队列；
- 暂停请求与迟到完成竞争；
- 暂停保留工作树，取消按策略清理；
- `awaiting_input` 必须携带 pending action；
- 回答后复用 session/worktree 并增加 `run_seq`；
- 启动恢复将旧运行变为 `interrupted`；
- revision 单调递增；
- 合并恢复不受普通中断迁移影响；
- 文本、重命名、删除、未跟踪和二进制文件进入审查快照；
- 独立交付物导入成功后才允许清理工作树；
- 导入中断可重试且不会重复生成记录；
- Reviewer revise/pass 和最大轮次行为；
- 两项并行任务的合并保持串行。

### 14.2 前端测试

在 `desktop/src/tasks/*.test.tsx` 增加：

- 所有后端状态恰好映射到一个栏目；
- 中文栏目为“待确认”；
- 创建并开始与仅保存动作调用不同命令；
- 卡片显示 heartbeat、phase 和 pending action；
- 暂停、恢复、回答、退回修改按钮只在合法状态出现；
- revision 过期事件被忽略，事件缺口触发重新加载；
- 空 patch 根据 `empty_reason` 显示正确解释；
- 审查面板列出二进制和交付物；
- 工作树丢失时不显示可执行的接受按钮。

### 14.3 端到端场景

使用临时 Git 仓库验证：

1. 创建任务并自动运行；
2. 暂停后关闭并重启应用，再继续；
3. 任务请求用户选择，回答后沿用原会话；
4. 生成文本文件、PDF 和项目外独立报告；
5. 查看稳定审查快照；
6. Reviewer 驳回，Executor 修订后通过；
7. 用户接受并合并；
8. 两任务并行完成后依次合并；
9. 在合并前、合并中和交付物导入中模拟退出并恢复。

### 14.4 必跑命令

```bash
npm --prefix desktop run typecheck
npm --prefix desktop test -- src/tasks
npm --prefix desktop run build
cargo test --manifest-path desktop/src-tauri/Cargo.toml work_task
```

改动跨越 runtime、tools 或 Reviewer 时执行：

```bash
cargo test --workspace
```

---

## 15. 迁移与发布

### 15.1 Schema 迁移

- v1 任务读取时填充新增字段默认值；
- v1 `preparing/running` 在首次 reconcile 时变成 `interrupted`，保留错误说明；
- v1 `review` 首次打开时生成审查快照；
- v1 `.somniq` 交付物只登记，不自动移动；
- 写入任何 v1 文件时整体升级到 v2，并保持原子替换。

### 15.2 功能开关

建议使用两个临时开关分阶段发布：

- `workTaskRuntimeV2`：状态机、事件和暂停恢复；
- `managedArtifacts`：新交付物库和输出策略。

审查快照应随 Runtime V2 一起启用，因为可靠状态与可靠结果不可分开。开关稳定两个版本后删除，避免长期双路径。

### 15.3 可观测性

日志至少包含：

```text
project_id
task_id
run_seq
store_revision
from_status -> to_status
actor
session_id
worktree_path
base_sha/head_sha
stop_reason
duration_ms
```

日志禁止记录模型密钥、外部授权内容和未脱敏用户文件正文。

---

## 16. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 状态数量增加导致遗漏 | Rust 和 TypeScript 都维护穷举测试；未知状态显示错误卡而非隐藏 |
| heartbeat 写入过密 | 内存高频、磁盘和 UI 事件 2 秒节流 |
| 暂停被误认为可恢复进程栈 | 明确采用“结束当前轮次、保留会话后续跑”的语义 |
| 交付物复制后损坏或重复 | SHA-256 校验、临时文件 + 原子重命名、幂等 artifact ID |
| 旧 `.somniq` 文件丢失 | 只登记和兼容读取，不自动移动/删除 |
| Reviewer 无限循环 | 最大轮次、结构化停止原因、剩余问题交给用户 |
| UI 再次因 CSS 分包失效 | 关键任务页样式由稳定 shell 入口加载，并增加布局回归测试 |
| 多实例同时写任务文件 | 本阶段明确单实例约束；后续改 SQLite/文件锁前主动拒绝第二写入者 |

---

## 17. 非目标

本轮不包含：

- 通用无限画布；
- 任意节点和装饰性连线；
- 跨设备实时协同编辑；
- 将任务存储整体迁移到云端；
- 自动搬迁用户现有项目文件；
- 让后台任务无审查地执行项目外部危险操作。

未来研究控制台若立项，只允许展示和操作真实的任务、证据、实验、Reviewer 结论与交付物，并直接消费本文定义的任务快照和事件协议。

---

## 18. 完成定义

本方案完成必须同时满足：

1. 新建任务默认开始执行，且任何时刻都有真实、可解释的状态；
2. 用户可以暂停、继续、回答阻塞问题，并保留同一任务上下文；
3. 应用重启不会留下永久“运行中”或不可取消的幽灵任务；
4. 审查面板能完整表达文本、二进制、忽略文件和独立交付物；
5. 空差异必有准确原因，不能掩盖已有成果；
6. `.somniq` 不再是新用户交付物的默认最终位置；
7. Executor 结果经过独立 Reviewer，修订过程可审计；
8. 任务页和主页在支持尺寸与缩放下不破版；
9. 手工任务与定时任务复用同一执行、恢复和审查内核；
10. 所有相关前端、Rust 聚焦测试、Desktop build 和跨 crate 测试通过。

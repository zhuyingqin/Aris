# ARIS 代码质量审查 · 第 2 轮 · 区域 2：Scheduled Tasks

**触发时间**：2026-06-22T10:15:00Z
**任务 ID**：`aris-review-r2-scheduled`
**审查范围**：`scheduled.rs` + `ScheduledTasks.tsx` + `tauri.ts`（scheduled 部分）+ `sessions.rs` + `types.ts`（scheduled 部分）
**新发现问题**：28（高 6 / 中 14 / 低 8）

> **特别提示**：本次审查的所有 `desktop/src/scheduled/ScheduledTasks.tsx`、`desktop/src/api/tauri.ts`、`desktop/src-tauri/src/scheduled.rs`、`desktop/src/types.ts`、`desktop/src/styles.css`、`desktop/src-tauri/src/lib.rs` 都包含尚未提交的本地修改。审查重点之一是这些未提交修改是否引入了新的回归。

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/scheduled.rs` | 465 | ARIS 拥有的定时任务注册表（CRUD + TOML 持久化） |
| 2 | `desktop/src/scheduled/ScheduledTasks.tsx` | 464 | 前端：列表 + 表单 + 详情面板 |
| 3 | `desktop/src/api/tauri.ts` (scheduled 部分) | 25 | 命令 wrapper（5 个新函数） |
| 4 | `desktop/src-tauri/src/sessions.rs` | 148 | sessions 列表 + chat-ui-sessions.json |
| 5 | `desktop/src/types.ts` (scheduled 部分) | 14 | `ScheduledTask` / `ScheduledTaskInput` 类型 |
| 6 | `desktop/src-tauri/src/lib.rs` (scheduled 注册) | 5 | `invoke_handler!` 中 4 个新命令 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（6 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `scheduled.rs` 全文（设计层面） | **缺失功能** | **整个模块没有调度执行器**！CRUD 命令都写好了，但没有任何后台线程、cron 解析器、或 next_run 触发逻辑。用户创建 task 后：UI 显示"运行中"，但实际任务永远不会执行。这是整个 v0.3.2 → v0.4.1 的重大未完成功能 |
| **H-2** | `scheduled.rs:215-220` (`validate_task_id`) | 安全 | 验证允许 `a-zA-Z0-9-_` 但**未验证长度下限**：攻击者可以传 `task-`（5 字符空 ID）或单字符 `a`。结合 `state::sessions_dir().join(format!("{id}.json"))` 在文件系统中可枚举（虽然单字符会失败但仍浪费 IO） |
| **H-3** | `scheduled.rs:218` (`session_id` 路径过滤) | 安全 | 仅检查 `/` 与 `\\`，**Windows 路径绕过**：允许 `C:foo`（盘符引用相对路径）、`PRN`/`CON`/`AUX`（保留设备名）、`\\\\?\\` 长路径前缀、`.` 单独通过（join 时会变成隐藏文件）。攻击者可发送 `C:Windows\\System32` 作为 session_id，绕过检查后让 `is_file()` 在错误的盘根上运行 |
| **H-4** | `ScheduledTasks.tsx:286` (`handleDelete` 用 `window.confirm`) | UX / Tauri 兼容 | Tauri webview 默认禁用 `window.confirm` 弹窗（出于安全）；同时在浏览器环境（vite preview）能用但样式突兀。应该用项目内的 Dialog 组件，与 `useStore.setError` 同样定位 |
| **H-5** | `ScheduledTasks.tsx:240-249` (`handleDelete` 中 `setTasks` 闭包内调用 `setSelectedId`) | 状态管理 | `setTasks((previous) => { ... setSelectedId(...) })` 在状态更新函数里调用另一个 setter 是 React anti-pattern：闭包可能捕获旧 state，且 React 18 的 concurrent renderer 下两次 update 顺序不确定。`selectedTask.id` 在闭包内已经被引用但实际值可能是旧值 |
| **H-6** | `scheduled.rs:174-184` (`write_record` 的非原子 rename) | 数据一致性 | 在 Windows 上 `fs::rename` 不覆盖现有文件，所以先 `remove_file(&path)` 再 `rename(tmp, path)`。两个调用之间进程崩溃会留下**原始文件丢失 + 临时文件存在**的不一致状态，直到下次启动或被覆盖。Linux 上没问题但 Windows 桌面端（这是主要平台）有真实风险 |

### 🟡 ���级（14 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `scheduled.rs:241-256` (`session_exists` 每次都重读 chat-ui-sessions.json) | 性能 | 创建/更新 task 时都重新 `fs::read_to_string` + `serde_json::from_str` 整个 chat-ui-sessions.json。当 sessions 数组有 1000 条且批量创建 100 个 task 时，每次都重读，浪费 100MB+ IO |
| **M-2** | `scheduled.rs:215-220` (`validate_task_id` 验证不严) | 一致性 | ID 字符集允许 `-` 与 `_`，但 `new_task_id()` 生成的格式是 `task-{millis}-{pid}`，**没有运行时校验**：手工编辑 TOML 时可写 `task/../etc/passwd` 这样的字符串（虽然 `validate_task_id` 会在读取时拦截，但读取前的 `state::config_dir().join(id)` 调用会让 fs panic 用错误信息暴露路径） |
| **M-3** | `scheduled.rs:288-296` (`rrule_field` 用 `split_once('=')` 处理 value) | 健壮性 | RFC 5545 rrule 的 value 可包含 `=`。例如 `BYDAY=MO,TU`，但若用户写 `BYDAY=MO=TU` 会被截断成 `MO` 并静默丢弃后段。实现未遵循 RFC |
| **M-4** | `scheduled.rs:128-131` (`legacy_store_path` 与新版 automations dir 混淆) | 一致性 | `legacy_store_path` 在 `state::config_dir().join("scheduled-tasks.json")`，新版 `aris_automations_dir` 在 `state::config_dir().join("automations")`。两��路径都指向 config_dir 下的不同位置，但 `read_record` / `write_record` 不读 legacy path，意味着从 legacy 升级时新 task 会写到新位置、旧 task 在 legacy 位置且被 `legacy_scheduled_tasks` 当只读列出 —— 用户可能误以为删除就是删除，实际只删了新版 |
| **M-5** | `scheduled.rs:233-238` (`session_id` 长度未限制) | 安全 / 性能 | 没有最大长度检查。如果用户发送 10MB 的 session_id（前端是 TS string 无长度限制），`format!("{session_id}.json")` 会构造巨大字符串再传给 `is_file()`，每次创建都浪费内存 |
| **M-6** | `scheduled.rs:160-163` (`schedule_label_from_rrule` 是中文硬编码) | 国际化 | `"每 15 分钟"` 中文硬编码，与项目其他模块走 `i18n` 的设计不一致。`config.language` 已经是已知设置，但 scheduled 模块没读 |
| **M-7** | `scheduled.rs:303-309` (`interval_from_rrule` 把未知 FREQ 默认为 MINUTELY) | 业务逻辑 | round-trip 不对称：`rrule_for_interval` 只生成 MINUTELY/HOURLY/DAILY，但读取时其它 FREQ（WEEKLY/MONTHLY/YEARLY）被悄悄转成 minutes。手动编辑 TOML 改为 `FREQ=WEEKLY;INTERVAL=2`，UI 会显示"每 2 分钟"（错误） |
| **M-8** | `scheduled.rs:154-159` (`rrule_field` 的边界) | 健壮性 | `split(';')` 找不到匹配时返回 `None`；但 `split_once('=')` 处理 `"FREQ="`（空 value）会返回 `Some("", "")`，前端拿到空字符串而非 None。TASK_KIND 永远不会发生但手工编辑时会触发 |
| **M-9** | `ScheduledTasks.tsx:118-130` (`loadSessionOptions` 项目过滤逻辑死代码) | 代码冗余 | 函数接收 `projectId` 参数，但只有 `chatUiSessionsLoad` 时用 projectId 过滤；fallback 到 `sessionsList` 时**没有任何项目过滤**。当用户切换 project A→B，chat UI sessions 不变但 fallback 路径会列出旧 project 的 sessions |
| **M-10** | `ScheduledTasks.tsx:142-163` (`useEffect` 同步 selectedId/form 的依赖循环风险) | 状态管理 | `useEffect` 依赖 `[selectedId, selectedTask, sessions]`。`selectedTask` 是从 `tasks` 派生（`tasks.find(...)`），每次 `tasks` 变化都会重新计算 `selectedTask` reference，进而触发 effect 重跑（即使 id 没变）。在大量 tasks 列表下重新计算成本高 |
| **M-11** | `ScheduledTasks.tsx:73-80` (`formToInput` 中 `Math.max(1, Math.floor(form.intervalValue || 1))` 语义混乱) | 代码可读性 | 当 `intervalValue === 0` 时 `0 \|\| 1 = 1`；当 `-1` 时 `-1 \|\| 1 = -1`（非 0 真值），再 `Math.max(1, -1) = 1`。三种边界路径产生两个不同结果。应统一为 `Math.max(1, Math.floor(Number(form.intervalValue) || 1))` |
| **M-12** | `ScheduledTasks.tsx:172-176` (`useMemo` `sessionOptions` 依赖过宽) | 性能 | 依赖 `[form.sessionId, sessions]`，即使只是 form 内部其它字段（如 `title`）变化也不会重算；但 form.sessionId 变化每次都构造新数组（包括虚拟条目），可以在 form.sessionId 变化时单独用 effect |
| **M-13** | `sessions.rs:102-117` (`chat_ui_sessions_save` 没有文件锁) | 并发 | `chat_ui_sessions_save` 写入 `chat-ui-sessions.json` 不带任何锁；同时 Chat UI 可能在前端频繁保存（每条消息）。两个并发 write 会让一个 rename 失败（Windows `rename` 跨现存文件失败）。同时 `scheduled.rs` 的 `session_exists` 在 read 时也无锁 |
| **M-14** | `sessions.rs:78-99` (`chat_ui_sessions_load` 解析全文件) | 性能 | 与 M-1 相关但更严重：`chat_ui_sessions_load` 返回 `Value`，整个文件解析为 JSON 然后传前端。10000 条 sessions × 5KB = 50MB 字符串在 IPC 通道上序列化，浪费 IPC 与反序列化时间。应该返回 `Vec<ChatSession>` typed struct |

### 🟢 低级（8 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `scheduled.rs:274` (`now_millis` 中冗余 `min(i64::MAX)`) | 代码风格 | `as_millis().min(i64::MAX as u128)` 然后 `as i64` —— 当 u128 > i64::MAX 时 `as i64` 是 saturation 还是 truncation 取决于实现；应直接 `try_into().unwrap_or(i64::MAX)` |
| **L-2** | `scheduled.rs:174-180` (临时文件路径硬编码) | 一致性 | `automation.toml.tmp` 名称固定，并发写同一任务会冲突（虽然当前不并发）。每个进程实例应使用 PID 后缀 |
| **L-3** | `scheduled.rs` 全文 | 缺失测试 | `validate_task_id`、`session_exists`、`write_record` 跨平台原子性、`schedule_label_from_rrule` 多语言、`rrule_field` RFC 边界都没有测试 |
| **L-4** | `scheduled.rs` 全文 | 缺失审计日志 | CRUD 命令不写 `events.jsonl`（项目有 watcher），无法追溯何时谁创建/修改/删除 task |
| **L-5** | `scheduled.rs:121-126` (`arís_scheduled_tasks` 不排序) | 性能 | 返回前不排序，依赖 `scheduled_tasks_list` 在 merge 后统一排序。legacy 数据可能在新版数据之后插入导致最终顺序错乱 |
| **L-6** | `ScheduledTasks.tsx:218-219` (`addOrReplaceTask` 把新任务放首位) | 状态管理 | 但 `scheduled_tasks_list` 是 `updated_at desc`，本地替换后顺序会乱，要等下次 refresh 才正确 |
| **L-7** | `ScheduledTasks.tsx:62` (`taskStatus` 函数 vs `status` 字段不一致) | 类型一致性 | `task.status === "paused"` 映射为 `"paused"`���但后端 `ScheduledTask.status` 字段语义是 `"active" | "paused" | string`，允许其它值。当前实现把其它值默认当 active，但后端 normalize_status 只接受这两种；前端应与后端同步接受 union literal |
| **L-8** | `types.ts` 区域 | 类型 | `intervalUnit: "minutes" | "hours" | "days" | string` —— `| string` 让 union 失效。建议改为 `IntervalUnit = "minutes" | "hours" | "days"` 单独导出 |

---

## 3. 未提交修改的回归检查

| 修改点 | 文件 | 引入问题 |
|---|---|---|
| 新增 4 个 Tauri command wrapper | `api/tauri.ts:147-153` | ✅ 无回归，签名正确 |
| 新增 4 个 invoke_handler | `lib.rs:207-213` | ✅ 注册顺序在 scheduled_tasks_list 之后，OK |
| ScheduledTasks.tsx 大重构为列表+详情布局 | `ScheduledTasks.tsx` | ⚠️ 引入 M-5/M-9/M-10/M-11/M-12 等 5 个 React 状态管理问题 |
| types.ts 新增 `ScheduledTaskInput` 与 5 个新字段 | `types.ts:71-83` | ⚠️ `intervalUnit: ... | string` 让类型守卫失效（L-8） |
| scheduled.rs 从 codex 集成转为 ARIS-owned | `scheduled.rs` | 🔴 引入 H-1（缺失调度执行器），这是核心功能未完成 |
| styles.css 重写 sched-page 为 grid 布局 | `styles.css:4429-4681` | ✅ 与功能匹配，CSS 无逻辑问题 |

---

## 4. 风格 / 一致性观察

- `scheduled.rs:73` �� `sessions.rs:9` 都硬编码 `state::runtime_dir().join("chat-ui-sessions.json")`，应该抽 `state::chat_ui_sessions_path()`
- `ScheduledTasks.tsx:131` 用 `useEffect` 同步 form，但 selectedTask 派生应使用 `useMemo` —— 当前实现 effect 内重新调用 `taskToForm`，依赖链长
- `api/tauri.ts` 中 `scheduledTaskSetStatus` 的类型 `status: "active" | "paused"` 是字符串字面量；但 Rust 端的 `normalize_status` 也接受 `"active" | "paused" | "ACTIVE" | "PAUSED"`。前后端契约不一致（前端传大写后端会拒绝但前端的 union 类型阻止）
- `tauri.ts` 所有 scheduled_* wrapper 缺 `isTauri()` 检查 —— vite preview 环境下会 throw，建议加与 `openExternalUrl` 类似的 fallback
- `ScheduledTasks.tsx` 中 `isIntervalUnit` 类型守卫的实现与服务端 `normalize_interval_unit` 的允许集不一致 —— 服务端允许 3 种，前端守卫也允许 3 种（OK），但 `status` 的 `taskStatus` 函数不与服务端契约对齐
- `scheduled.rs` 没有 `delete` 测试，CRUD 4 个命令只有 create / update 间接覆盖
- `state.rs:113` 的 `runtime_dir` 在切换 project 时不变，但 `sessions_dir_for_project(project_id)` ��变 —— scheduled task 创建时绑定的 session_id 在切项目后会找不到，但 task 仍然在 config_dir 下，不会自动失效
- `ScheduledTasks.tsx:295` `setTab("chat")` 是写死的硬编码跳转，没有保留返回路径或携带上下文

---

## 5. 本轮确认无问题的方面

✅ `validate_task_id` 字符集本身（`a-zA-Z0-9-_`）足以阻止路径穿越字符
✅ `chat_ui_sessions_load` 在文件不存在时返回空数组而不是报错
✅ `task_path` 在 task_id 验证失败时会先返回错误，path 不会被构造
✅ `now_millis` 使用 `SystemTime::now()` 不依赖本地时区
✅ `interval_from_rrule` 在 rrule 字段缺失时 fallback 到 `(1, "minutes")`（虽然 fallback 默认是分钟是问题，但行为安全）
✅ `legacy_scheduled_tasks` 用 `unwrap_or_default()` 不会因单个文件错误影响整体列表
✅ `taskToForm` 在 `intervalValue` 为 0 时用默认值 fallback（虽然 Round-trip 仍会丢失 0 输入）
✅ 测试覆盖 `interval_round_trips_to_rrule`、`status_accepts_ui_and_toml_values`、`aris_record_maps_to_scheduled_task` 三个关键路径

---

## 6. 与上一轮（区域 1）的关系

- 区域 1 提出的 H-3（`std::env::set_var` 并发安全）在 scheduled.rs 的 `set_var` 调用中不出现，OK
- 区域 1 提出的 H-4（`set_current_dir` 并发）会影响 scheduled task 的执行（如果有执行器），但当前**没有执行器**
- 区域 1 提出的 L-6（`process.rs` 9 行透明转发）模式与 `state::chat_ui_sessions_path` 重复类似

---

## 7. 累计进度

```
已审 / 总文件:   13 / ~99 (.rs) + 2 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅ ← 本轮
  desktop/chat       0 / 8
  desktop/mail       0 / 10
  desktop/literature 0 / 1
  desktop/lab        0 / 1
  desktop/knowledge  0 / 1
  desktop/studio     0 / 1
  desktop/sessions   1 / 1   ✅
  desktop/前端       1 / 62
```

---

## 8. 下次审查预期（区域 3：Chat 模块）

- `desktop/src-tauri/src/engine.rs`（154632 bytes，最大文件）
- `desktop/src/chat/*` 8 个 tsx/ts 文件（Chat.tsx, ChatComposer.tsx, ChatMessage.tsx, ChatSidebar.tsx, ChatThread.tsx, WorkflowFlow.tsx 等）
- 重点关注：engine.rs 的 ChatState、permission/question command、cancel 逻辑、provider 调用链路；chat/WorkflowFlow 的命令系统；ChatSession 与 sessions.rs 的类型对齐

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T10-15-00Z-quality-review-r2-region2.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T10-15-00Z-quality-review-r2-region2.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-scheduled`, prompt 版本: v1, region: 2/9。*
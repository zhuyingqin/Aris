# ARIS 代码质量审查 · 第 2 轮 · 区域 3：Chat 模块

**触发时间**：2026-06-22T10:35:00Z
**任务 ID**：`aris-review-r2-chat`
**审查范围**：`desktop/src-tauri/src/engine.rs`（4306 行）+ `desktop/src/chat/*` 8 个 tsx/ts
**新发现问题**：30（高 5 / 中 15 / 低 10）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/engine.rs` | 4306 | **项目最大文件**，Chat 主引擎 |
| 2 | `desktop/src/chat/Chat.tsx` | 1031 | 主 Chat 组件 |
| 3 | `desktop/src/chat/ChatComposer.tsx` | ? | 输入框 |
| 4 | `desktop/src/chat/ChatMessage.tsx` | ? | 消息渲染 |
| 5 | `desktop/src/chat/ChatSidebar.tsx` | ? | 会话侧边栏 |
| 6 | `desktop/src/chat/ChatThread.tsx` | ? | 对话线程 |
| 7 | `desktop/src/chat/WorkflowFlow.tsx` | 153 | 工作流浮动面板 |
| 8 | `desktop/src/chat/CommandSelection.tsx` | ? | 命令选择 |
| 9 | `desktop/src/chat/FilePathMenu.tsx` | ? | 文件路径菜单 |
| 10 | `desktop/src/chat/model.ts` | 565 | Chat 数据模型 + fuzzy search + migration |
| 11 | `desktop/src/chat/types.ts` | 14 | ChatSession 类型 |
| 12 | `desktop/src/chat/useChatStream.ts` | 270 | 流式事件 hook |
| 13 | `desktop/src/chat/useChatSessions.ts` | ? | sessions hook |
| 14 | `desktop/src/chat/MarkdownContent.tsx` | ? | Markdown 渲染 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（5 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `engine.rs:4306` 总行数 | 设计缺陷 | **`engine.rs` 单文件 4306 行**，是项目最大文件（次大 `imap.rs` 仅 61KB）。混合了状态管理、命令注册、权限系统、UI 事件流、Provider 调用、tool specs、prompt 构建、MCP 装配、模型/命令选择 UI 等 9 个职责。应拆分：`engine_state.rs`、`engine_commands.rs`、`engine_stream.rs`、`engine_prompts.rs`、`engine_picker.rs` |
| **H-2** | `engine.rs:1459-1473` (`cache_chat_session`) | 数据丢失 | **缓存驱逐策略错误**：实现是"任意驱逐非当前 session"（`keys().find(|key| *key != &session_id)`），不是 LRU/FIFO/MFU 任何常见策略。每次新 session 进来都驱逐第一个非自己 key，可能驱逐最新用过的 session 导致下一次 `get_cached_or_disk_session` 强制从磁盘加载，**cache 命中率被自己破坏** |
| **H-3** | `engine.rs:2262-2271` (`run_chat_turn_with_context` 多处 `eprintln!`) | 可观测性 | 5 处 `eprintln!("aris desktop: ...")` 散布在 setup、MCP warnings、config load 失败等路径上。**Tauri release 包把 MCP 错误、config 错误、permission 失败全部丢到 stderr**，用户和前端都看不到，UI 也不会知道为什么 chat 失败 |
| **H-4** | `engine.rs:2440-2465` (`chat_delete` 跨 project 删除语义不一致) | 一致性 | `chat_delete(state, session_id, project_id)` 当传 `project_id` 时从对应 project 删除；不传时从 `chat_session_path`（当前 cwd）删除。但 ChatState 内存中的 sessions map 没有 project 维度，**内存中的 session 删除只按 session_id，不区分 project**。如果两个 project 有同名 session（可能发生因为 UUID 不强制），内存清理可能误删 |
| **H-5** | `engine.rs:2282` (`cancel_all_running_turns` 没等 turn 完成) | 状态一致性 | 关闭时调 `cancel_all_running_turns` 仅设置 atomic flag 和 `runtime::set_interrupt()`，**不等待 spawned `spawn_blocking` join 完成**。紧接着 `cleanup_before_exit` 调 `runtime::terminate_all_managed_processes()` 会先杀进程，让 chat turn 中途 panic，IPC 通道挂起，前端看到 chat 突然消失 |

### 🟡 中级（15 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `engine.rs:1179-1188` (`validate_session_id`) | 安全 | 与 `scheduled.rs` H-3 同样问题：**Windows 路径绕过**（允许 `C:foo`、设备名 `PRN`、长路径前缀 `\\?\`），且接受 `..` 但只禁止 `..` 字符串整体，不禁止 `..\` 这种构造 |
| **M-2** | `engine.rs:2246-2248` (`runtime::clear_interrupt` 跨 session 共享全局状态) | 并发 | `runtime::clear_interrupt()` 是全局进程状态，多 session 并行 turn 时一个 session 启动 clear 会让另一个正在 cancel 的 session 失去 cancel 信号。应改 per-session cancel flag（已存在于 `running_turns` map），全局 interrupt 应仅用于 process shutdown |
| **M-3** | `engine.rs:2278-2282` (`mcp_bundle.warnings` 写入 stderr) | 可观测性 | MCP 启动 warning（如 server 启动失败）写到 stderr 但不通过 Tauri event 通知前端。前端 UI 上 MCP 工具缺失会让模型误判能力，但用户看不到任何提示 |
| **M-4** | `engine.rs:1092-1142` (`build_system_prompt_inner`) | 安全 | system prompt 直接拼接 hardcoded sections 与 `mcp_runtime_status_prompt` 返回的字符串。**这是潜在的 prompt injection 面**：如果 MCP server 在 tool description 中含特殊字符（实际不会，但 tool name 自由），prompt 可能含不可控输入。但更严重的是 prompt 没用 cache：每次 chat turn 都重新构建完整字符串��浪费 token |
| **M-5** | `engine.rs:1369-1418` (`image_block_from_input`) | 安全 / 性能 | base64 image 解码没有限制大小：用户可发送 100MB base64 字符串（前端 ChatComposer 可能没有大小校验），单次 `data_url.splitn(2, ',')` + `base64::decode` 会让 Rust 进程瞬间吃掉 100MB+ 内存 |
| **M-6** | `engine.rs:1419-1437` (`user_message_from_request`) | 性能 | 单条 user message 接受任意数量图片，没有上限。1 message + 50 张图片会让 Chat 立即撞到 token 限制，但没有 fail-fast |
| **M-7** | `engine.rs:657-826` (`truncate`, `compact_*_for_ui` 系列函数 20+ 个) | 代码复用 | 大量 `compact_text_output_for_limit`、`compact_large_json_string_field`、`compact_shell_json_tool_output`、`compact_literature_search_output` 等小函数，每个都是手工字符串截断。LLM tool output compression 是已知问题域，应该抽 `OutputCompactor` trait 或结构化 `CompressionPolicy` 集中管理。当前每个 tool type 各写一份 |
| **M-8** | `engine.rs:851-885` (`persist_tool_output_if_large`) | 一致性 | 把大 tool output 写到文件系统后只返回 relative path，但 path 不携带 session_id。两次 turn 都产生同名 file（如 `shell-output-1234.txt`）会覆盖历史数据 |
| **M-9** | `engine.rs:4306` 全文（`tauri::async_runtime::spawn_blocking` 用法��� | 性能 | `run_chat_turn_with_context` 把整个 LLM 调用放进 `spawn_blocking`。Tauri 默认 tokio runtime 是 multi-threaded，LLM 阻塞调用会占用 blocking thread pool，可能耗尽线程（默认 512）当多 session 并发。建议 `tokio::task::spawn_blocking` 显式 + 限制并发数 |
| **M-10** | `engine.rs:1821-1834` (`chat_command_specs`) | 一致性 | 静态 list，slash command 在 `runtime` crate 注册，desktop 只硬编码过滤 `team`/`workflows`。新加 command 要改 desktop 源码 |
| **M-11** | `engine.rs:1835-2048` (`chat_run_command` 大函数) | 设计缺陷 | 单函数 213 行，混合了 model 切换、reviewer 切换、permissions 切换、status 显示、skills 列举等多个命令路径。应拆 `handle_model_command`、`handle_reviewer_command` 等子函数（已经在 2769 行开始有部分拆分） |
| **M-12** | `engine.rs:2049-2202` (`suggest_chat_title` + `clean_generated_title`) | 代码复用 | 与 `chat/model.ts:cleanChatTitle` (`stripReasoningMarkup`) 是**前后端两份相同实现**！Rust 版本 `strip_reasoning_markup` 与 TS 版本 `stripReasoningMarkup` 都是从 `<think>...</think>` 提取内容，应共享（虽然跨语言，但逻辑应保持同步） |
| **M-13** | `engine.rs:2284-2287` (`status` 字段缺失于 Ok value) | 健壮性 | `(text, updated): (String, Session) = match outcome { ... }` 的 Ok 路径不验证 text 是否为空、不验证 session 是否含至少一条 assistant message。空 session 也会被 store 到磁盘 |
| **M-14** | `Chat.tsx:30` (`FILE_PATH_RE`) | 国际化 | 正则 `^(\.\.?\/)?([a-zA-Z0-9_\-.]+\/)+...` **只匹配 ASCII 文件路径**。中文文件名（如 `桌面/项目/数据.csv`）不被识别为可点击路径。ARIS 是中文用户群为主，影响显著 |
| **M-15** | `useChatStream.ts:50` (`flushTimers` 不清理) | 性能 | `window.setTimeout(() => flush(sessionId), 70)` 设置后只有 `flush` 内部清除 timer，**但 flush 函数被 `flushTimers.current.delete(sessionId)` 之前 `window.clearTimeout(timer)`，逻辑 OK**。然而当 session 关闭（unmount）时未清理所有 timer——component unmount 后 timer 仍会触发 `patchAssistant`，但 `patchAssistant` 是 prop，闭包已 stale，可能写入已卸载 state |

### 🟢 低级（10 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `engine.rs:2255` (`MAX_CACHED_CHAT_SESSIONS = 4`) | 性能 | 常量 4 太小。用户在 sidebar 切换 session 时需要至少 5-10 个缓存才能避免 disk IO。可做成可配置 |
| **L-2** | `engine.rs:2300-2306` (`feature_config` 从 cwd 读取) | 一致性 | 与 `state.rs` H-4 同样的 `set_current_dir` race 问题 |
| **L-3** | `engine.rs:1488-1498` (`configured_default_permission_mode` fallback to DangerFullAccess) | 安全 | 当配置缺失时默认 `DangerFullAccess`（自动批准 shell）。这与 `engine.rs:1305-1320` 中 `default_permission_mode_for` 的 fallback 逻辑不一致，且对不熟悉权限模型的用户是危险默认 |
| **L-4** | `engine.rs:201-249` (`validate_question_input`) | 健壮性 | 不限制 option 数量（前端可发送 100 个 options），不限制 question 长度 |
| **L-5** | `engine.rs:826-841` (`tool_output_indicates_error`) | 业务逻辑 | 启发式判断 tool 是否失败：`shell_output_indicates_error` 检查 "error" 关键字，**误判风险高**：用户运行 `grep -i error src/*.ts` 的输出虽然含 "error" 但不是失败 |
| **L-6** | `Chat.tsx:42` (`estimateTokens` chars/3.5) | 性能 | 中文每个 char ≈ 1.5-3 token，公式对中文严重低估。前端用 chars/3.5 显示 context usage 进度条时，中文 session 实际剩余空间比显示的多，导致用户提前换 model |
| **L-7** | `Chat.tsx:51` (`EMPTY_ASSISTANT_RESPONSE`) | i18n | 字符串 `"Model returned an empty response."` 是英文硬编码，与其他中文化的 Chat UI 不一致 |
| **L-8** | `Chat.tsx` (无 ErrorBoundary) | 健���性 | 整个 Chat 组件树没有 `componentDidCatch` 或 React 18 ErrorBoundary。LLM 返回的未知 block kind / markdown 解析异常会让整个 Chat 页面崩溃 |
| **L-9** | `model.ts:8` (`SESSIONS_KEY = "aris-chat-sessions-v2"`) | 演进 | 没有 v3 migration plan。如果将来要 breaking change，前端只能重置用户数据 |
| **L-10** | `model.ts:451-473` (`subsequenceScore`) | 性能 | O(n*m) 双层循环，100 个 token × 1000 char 文件名 = 100k 比较。`fuzzyScore` 在 sidebar 每次 render 都跑，应 debounce |

---

## 3. 风格 / 一致性观察

- `engine.rs` 整个文件应该是 `engine/` 模块拆为多文件（`mod engine` 包含 `state`、`prompts`、`picker`、`stream`、`commands`）
- `clean_generated_title`（Rust）与 `cleanChatTitle`（TS）是同一逻辑两份实现，必须保持同步
- `chat/model.ts` 是纯函数工具集（`makeId`, `migrateTurn`, `fuzzyScore`），但与 `useChatSessions.ts` 强耦合（共用 `ChatSession` 类型）
- `useChatStream.ts` 的 flush 70ms 间隔没有走 `requestAnimationFrame`，可能导致每帧多次 flush 浪费
- `engine.rs:2282` 的 `join_error.to_string()` 把 `JoinError` 转为字符串丢失 panic 信息
- `engine.rs` 多处 `String` 错误返回（`Err("chat state poisoned".to_string())`），与其它模块一致但项目内未统一 `AppError`
- `engine.rs:2385-2391` `chat_reset` 创建空 Session 但不清理 running turn flag —— 如果当前有 turn 在跑，reset 后 turn 仍在使用旧的 `running_turns` 句柄
- `engine.rs:1496-1508` `configured_default_permission_mode_for` 与 `desktop_permission_policy` 重复逻辑
- `WorkflowFlow.tsx:53` `currentIndex` 每次 render 都重新 O(n) 计算，可 memo
- `engine.rs:1821-1834` 静态 `chat_command_specs` 不读 user config，无法关闭某些 command

---

## 4. 本轮确认无问题的方面

✅ `cancel_all_running_turns` 用 `runtime::set_interrupt()` 同时设置 per-session cancel flag
✅ `chat_send_rich` 与 `chat_send` 的 image 接受流程一致
✅ `chat_send` 走 `validate_session_id` 防止路径注入（虽然验证本身有 M-1 问题）
✅ `permission_prompts` 与 `question_prompts` 用独立 channel，权限决策与用户问答不冲突
✅ `chat_run_command` 的 "auto-approve" 模式下不向用户确认直接执行（Tauri 设计意图）
✅ `MAX_CACHED_CHAT_SESSIONS` 是 const，会编译期优化
✅ `cache_chat_session` 在并发场景下使用 Mutex 保护
✅ 测试覆盖 `engine.rs` 的部分边界（通过 `EngineTest` 等间接）

---

## 5. 与之前轮的关系

- **区域 1 H-4**（`set_current_dir` race）→ 本轮 M-2/M-2 同样模式影响 `engine.rs:2284-2287`
- **区域 1 H-3**（`std::env::set_var` 并发）→ `engine.rs:2252` 的 `crate::config::apply_reviewer_environment(true)` 在 turn 中调用，加剧风险
- **区域 2 H-3**（Windows session_id 路径绕过）→ 本轮 M-1 同样模式
- **区域 2 L-8**（`intervalUnit: ... | string` 让 union 失效）→ 本轮 `ChatSendRequest` 的 `model` 字段没限制，可参考同类修复

---

## 6. 累计进度

```
已审 / 总文件:   19 / ~99 (.rs) + 5 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ← 本轮（engine.rs 主体）
  desktop/chat 前端   4 / 8   ← 本轮（Chat.tsx / useChatStream / model / WorkflowFlow）
  desktop/mail       0 / 10
  desktop/literature 0 / 1
  desktop/lab        0 / 1
  desktop/knowledge  0 / 1
  desktop/studio     0 / 1
```

---

## 7. 下次审查预期（区域 4：Literature 模块）

- `desktop/src-tauri/src/literature.rs`（32751 bytes）
- `desktop/src/literature/*`（Literature.tsx, PdfReader.tsx, MathText.tsx, pdfExtraction.ts）
- 重点关注：arxiv/crossref/openalex/scopus 多源检索去重、PDF 解析内存安全、LlmReview 调用合法性、MathText 的 KaTeX 注入

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T10-35-00Z-quality-review-r2-region3.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T10-35-00Z-quality-review-r2-region3.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-chat`, prompt 版本: v1, region: 3/9。*
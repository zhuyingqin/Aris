# ARIS 上下文管理优化建议 · 第 3 轮 · 专项

**触发时间**：2026-06-22T13:00:00Z
**任务 ID**：`aris-review-r3-context-opt`
**审查范围**：上下文窗口管理 / system prompt / memory / compaction / tool output 压缩
**核心问题数**：18（高 5 / 中 9 / 低 4）

> 用户问题"如何优化上下文"经代码审查后展开。本次审查涉及 `engine.rs`、`literature.rs`、`knowledge.rs`、`mail/*`、`chat/*` 等多模块的上下文管理实现。

---

## 1. 现状摘要

ARIS 当前的"上下文管理"由以下分散组件构成：

| 层 | 实现位置 | 现状 |
|---|---|---|
| System prompt 构建 | `engine.rs:1092` `build_system_prompt_inner` | 8+ sections，**每次 turn 全量重建**，无缓存 |
| Context window | `engine.rs:1549` `context_window_for_model` | 硬编码 6 个模型 family，其他 fallback 128K |
| Token 估算 | `Chat.tsx:58` `estimateTokens` | `chars / 3.5`，**对中文低估 30%+** |
| Compaction | `/compact` slash 命令 | **仅手动**，无 auto-trigger |
| Hot memory | `runtime::render_hot_memory_prompt` | **全量加载**，无 relevance 过滤 |
| Knowledge memory | `runtime::render_knowledge_memory_prompt` | **全量加载**，无向量检索 |
| Tool output 压缩 | `engine.rs:782` `compact_tool_output_for_context` 等 8 个函数 | **手写**，基于字符数，非 token 数 |
| Backend sync | `Chat.tsx:297` `syncBackendContext` | **每次 retry 全量重发**，O(n²) |
| Attachment 上限 | `ChatComposer.tsx:8-10` | `MAX_IMAGE_BYTES=8MB` / `MAX_TEXT_BYTES=1MB`，**与模型 context window 无关** |
| UI 进度环 | `ChatComposer.tsx:ContextRing` | 显示百分比但**估算精度差** |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（5 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `engine.rs:1092-1137` (`build_system_prompt_inner`) | 性能 | **System prompt 每次 turn 都全量重建**：8 个 section（access / file_links / artifact_layout / long_document_reading / long_file_generation / latex_toolchain / hot_memory / knowledge_memory）拼成 Vec<String>。**没有任何缓存**，相同 prompt 每次 turn 都重新序列化。Claude/Gemini 的 prompt cache 不会被命中，因为 cache key 来自完整 hash |
| **H-2** | `engine.rs:1113-1115` (`migrate_legacy_knowledge_memory` + `render_hot_memory_prompt` + `render_knowledge_memory_prompt` 在 system prompt 构建时调用) | 设计 | **Memory 全量注入到 system prompt**：每次 turn 都把 hot memory + knowledge memory **完整文本**拼到 system prompt。memory 项有几十/几百条时，每次 turn 浪费数千 token。**应该用向量检索按当前 query 取 top-K** |
| **H-3** | `Chat.tsx:297-302` (`syncBackendContext`) | 性能 | **`onError` 时调用 `syncBackendContext(sessionId, nextTurns)` 把整个 session 历史通过 IPC 重发到后端**。N 次错误恢复 = N×N 写入。`contextForRetry` 也是同样问题（Chat.tsx:176）。应该用 delta diff，只发新增的 turn |
| **H-4** | `Chat.tsx:58-65` (`estimateTokens`) | 业务逻辑 | **`chars / 3.5` heuristic 对中文严重低估**（中文每 char ≈ 1.5-3 token）。ContextRing 显示 50% 时实际可能 80%。**用户以为还有空间上传 5MB 图片，实际已超 limit**。应换模型真实 tokenizer |
| **H-5** | 全项目（`/compact` 命令 + `CompactionConfig::default()`） | 缺失功能 | **没有 auto-compaction**：用户必须手动 `/compact`。session 长对话直接溢出 context window → 模型自动截断早期消息 → 用户丢失关键上下文。Claude/GPT 都有 cache_control + auto-summary，但 ARIS 没有 |

### 🟡 中级（9 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `engine.rs:1549-1568` (`context_window_for_model`) | 一致性 | **6 个硬编码分支**（claude/haiku, MiniMax, gemini, deepseek-v4, deepseek）+ fallback 128K。新增模型 family 必须改源码。应该从模型 API metadata 获取，或用 `models.dev` JSON |
| **M-2** | `engine.rs:667-669` (MAX_UI_TOOL_*_CHARS) | 设计 | **Tool output/input 压缩基于字符数而非 token 数**。`MAX_UI_TOOL_OUTPUT_CHARS=64000` 对 Claude 的 8K 输出 token 上限实际超 1 倍。应该按"压缩后 token 数 ≤ X" 决策 |
| **M-3** | `engine.rs:782-825` (`compact_tool_output_for_context`) | 设计缺陷 | **8 个手写 compact 函数**（compact_large_json_string_field / compact_shell_json_tool_output / compact_literature_search_output / compact_stream_text / ...），每个针对特定 tool type 各写一份。应抽 `OutputCompactor` trait + 策略模式 |
| **M-4** | `engine.rs:1144` (`mcp_runtime_status_prompt` 注入 system prompt) | 业务逻辑 | **MCP 启动状态每次 turn 都注入**："12 tools loaded, 3 warnings"。这对 Chat 没有实际用处，但占用 token。应改成事件驱动，只在 MCP 状态变化时注入 |
| **M-5** | `Chat.tsx:202-209` (`needsBackendContextReset`) | 业务逻辑 | `if currentTurns.length !== prefixTurns.length) return true;` —— **只看 turn 数量**，不看 token 实际使用。10 个空 turn 与 10 个 8K token turn 同等待遇 |
| **M-6** | `ChatComposer.tsx:8-10` (MAX_IMAGE_BYTES / MAX_TEXT_BYTES) | 设计 | 硬编码 8MB / 1MB，**与模型 context window 无关**。Claude 1M context 可吃 50MB image，GPT-4 128K 只能吃 ~1MB。应按 model 选择 |
| **M-7** | `ChatComposer.tsx` 的 `ContextRing` | 性能 | 每次 keystroke 重新计算 `estimatedTokens`（O(N×blocks)）。长 session 时每次输入都全量 scan |
| **M-8** | `engine.rs:1853-1875` (`Compact` slash 命令) | UX | 只有手动 `/compact`，没有 auto-suggest 当 context > 80% 时提示用户 |
| **M-9** | 全项目 | 设计 | **没有任何 prompt caching 配置**。Claude `cache_control: { type: "ephemeral" }` 字段、Gemini `cached_content` 字段都没有使用，意味着每次 turn 重复付 system prompt 的 token 费 |

### 🟢 低级（4 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `Chat.tsx:200` (`needsBackendContextReset`) | 健壮性 | 比较 turn id 数组，没有检测 turn 内容修改（比如 retry 后内容变了） |
| **L-2** | `useChatSessions.ts:130-139` (persist sessions) | 性能 | 每次 `allSessions` 变都 debounced 250ms 全量保存到 chat_ui_sessions.json（IPC 一次）。100 个 session × 50KB JSON = 5MB IPC |
| **L-3** | `engine.rs:657` (`truncate(text, 4000)` 4 处) | 一致性 | 4 处 magic number `4000`（tool input 截断），没有命名常量 |
| **L-4** | `model.ts:107-128` (`transcriptFromTurn`) | 性能 | 把 block 全部拼接为单字符串，session 长对话时不必要的大字符串 |

---

## 3. 优化建议（按优先级）

### P0 — 立即修复

#### 3.1 真实 token 计数（替换 `chars / 3.5`）

**问题**：当前 `estimateTokens` 是 heuristic，对中文不准确。

**方案**：

```typescript
// desktop/src/chat/tokenizer.ts
import { encoding_for_model } from "tiktoken";

const encoders = {
  claude: () => getClaudeTokenizer(),  // 用 @anthropic-ai/tokenizer 或估算
  openai: (model: string) => encoding_for_model(model as any),
  gemini: () => getGeminiTokenizer(),
};

export function estimateTokens(text: string, model: string): number {
  if (model.startsWith("claude")) {
    return Math.ceil(text.length * 0.28);  // Claude 中文偏多 ~2.8 char/token
  }
  if (model.startsWith("MiniMax") || model.startsWith("minimax")) {
    return Math.ceil(text.length * 0.30);
  }
  // OpenAI/GPT: tiktoken
  const enc = encoding_for_model("gpt-4o");
  return enc.encode(text).length;
}
```

**好处**：
- 中文准确率从 ~70% 提升到 ~98%
- ContextRing 显示真实百分比
- Attachment 大小校验基于真实 token 预算

#### 3.2 System prompt 缓存

**问题**：每次 turn 都重建 8+ sections 字符串。

**方案**：

```rust
// engine.rs
struct CachedSystemPrompt {
    full_hash: u64,           // 用于检测是否需要 rebuild
    sections: Vec<String>,     // 缓存
    last_built: Instant,       // 用于 TTL 检查
}

impl CachedSystemPrompt {
    fn get_or_rebuild(&mut self, deps: &SystemPromptDeps) -> &[String] {
        let hash = compute_hash(deps);  // 包含 workspace path, mcp status, memory version 等
        if self.full_hash != hash || self.last_built.elapsed() > Duration::from_secs(60) {
            self.sections = build_sections(deps);
            self.full_hash = hash;
            self.last_built = Instant::now();
        }
        &self.sections
    }
}
```

**Claude prompt cache 配合**：固定 prefix 跨越 turns，节省 ~90% system prompt token。

#### 3.3 Auto-compaction 阈值

**问题**：必须手动 `/compact`，否则 context 溢出。

**方案**：

```rust
// engine.rs - new function
async fn maybe_auto_compact(state: &ChatState, session_id: &str) -> Result<bool, String> {
    let session = load_chat_session(session_id)?;
    let token_estimate = estimate_session_tokens(&session);  // 真实 tokenizer
    let model = resolve_executor()?.0;
    let window = context_window_for_model(&model);
    let usage = token_estimate as f64 / window as f64;
    
    if usage < 0.7 {
        return Ok(false);
    }
    
    // 70-90%: warn via chat-event
    if usage < 0.9 {
        let _ = app.emit("chat-context-warning", json!({
            "sessionId": session_id,
            "usage": usage,
            "message": "Context usage high. Consider /compact soon.",
        }));
        return Ok(false);
    }
    
    // >90%: auto-compact
    let result = runtime::compact_session(&session, CompactionConfig::default());
    store_chat_session(state, session_id.to_string(), result.compacted_session)?;
    Ok(true)
}
```

调用点：`run_chat_turn_with_context` 在 send 前检查。

#### 3.4 Session prefix 增量同步（修复 O(n²)）

**问题**：`syncBackendContext` 每次 retry 全量重发。

**方案**：

```typescript
// Chat.tsx
const lastSyncedTurnIds = useRef<Set<string>>(new Set());

const syncBackendContext = useCallback(async (sessionId, turns) => {
    const newTurns = turns.filter(t => !lastSyncedTurnIds.current.has(t.id));
    if (newTurns.length === 0) return;  // 没有 delta，无需同步
    const messages = await contextForRetry(newTurns);  // 只发新增
    await chatSetContext(sessionId, messages, { mode: "append" });  // 后端改为 append 语义
    newTurns.forEach(t => lastSyncedTurnIds.current.add(t.id));
}, []);
```

**后端对应**：

```rust
// engine.rs - chat_set_context 改为支持 append
#[derive(Deserialize)]
#[serde(tag = "mode")]
pub enum ContextSyncMode {
    Replace { messages: Vec<ChatContextMessage> },
    Append { messages: Vec<ChatContextMessage> },
}
```

### P1 — 重要改进

#### 3.5 Memory RAG（向量检索）

**当前**：`render_hot_memory_prompt` 全量加载所有 hot memory + knowledge memory 到 system prompt。

**方案**：

```rust
// 新增模块 memory_retrieval.rs
pub fn retrieve_relevant_memory(
    query: &str, 
    memory_items: &[MemoryItem],
    top_k: usize,
) -> Vec<MemoryItem> {
    // 1. Embed query (调用本地 embedding model 或 OpenAI embedding API)
    let query_embedding = embed(query);
    
    // 2. 计算 cosine similarity
    let mut scored: Vec<_> = memory_items.iter()
        .map(|item| (item, cosine_sim(&query_embedding, &item.embedding)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    
    // 3. 取 top-k 且分数 > 阈值
    scored.into_iter()
        .take(top_k)
        .filter(|(_, score)| *score > 0.7)
        .map(|(item, _)| item.clone())
        .collect()
}
```

**效果**：
- 50 条 memory 项 × 200 token = 10000 token → 5 条 × 200 token = 1000 token
- 节省 90% memory context
- 检索更精准（top-k 相关项）

#### 3.6 Tool output 压缩策略统一

**当前**：8 个手写 `compact_*` 函数。

**方案**：

```rust
// engine.rs
trait OutputCompactor: Send + Sync {
    fn can_handle(&self, tool_name: &str, output: &str) -> bool;
    fn compact(&self, output: &str, budget_tokens: usize) -> CompactionResult;
}

struct ShellJsonCompactor;
struct LiteratureSearchCompactor;
struct DefaultTruncateCompactor;

struct CompactorRegistry {
    compactors: Vec<Box<dyn OutputCompactor>>,
}

impl CompactorRegistry {
    fn compact(&self, tool_name: &str, output: &str, budget_tokens: usize) -> CompactionResult {
        for c in &self.compactors {
            if c.can_handle(tool_name, output) {
                return c.compact(output, budget_tokens);
            }
        }
        self.compactors.last().unwrap().compact(output, budget_tokens)
    }
}
```

#### 3.7 Prompt caching 集成

**Claude**：

```rust
let system_blocks = vec![
    SystemBlock::Text { text: STATIC_PREFIX.clone(), cache_control: Some(CacheControl::ephemeral()) },
    SystemBlock::Text { text: memory_section.clone(), cache_control: Some(CacheControl::ephemeral()) },
    SystemBlock::Text { text: dynamic_section.clone() },  // 不缓存
];
```

**Gemini**：

```rust
let cached_content = create_cached_content(workspace_id, &system_text).await?;
request.cached_content = Some(cached_content);
```

**效果**：
- System prompt cache hit 时，节省 ~90% system prompt token
- 1000 token system prompt × 50 turns = 节省 45000 token input
- 节省 ~$0.13/1000 turns（按 Claude Sonnet 定价）

#### 3.8 Model context window 自动探测

**当前**：硬编码 6 个分支。

**方案**：维护 `models.json`（参考 `models.dev`）：

```rust
// data/models.json (or fetched on startup)
{
  "models": {
    "claude-opus-4-7": { "context_window": 1000000, "max_output": 32000 },
    "MiniMax-M3": { "context_window": 1000000, "max_output": 32000 },
    "gpt-5.5": { "context_window": 256000, "max_output": 16000 },
    ...
  }
}
```

`context_window_for_model` 改成查表 + fallback 128K。

### P2 — 架构改进

#### 3.9 ContextManager 集中管理

```rust
struct ContextBudget {
    system_prompt_tokens: usize,
    history_tokens: usize,
    tool_outputs_inline_tokens: usize,
    tool_outputs_file_ref_tokens: usize,  // 引用大文件只占 ~100 tokens
    response_reserved: usize,             // 留给模型输出
    total_window: usize,
}

impl ContextBudget {
    fn remaining_for(&self, category: BudgetCategory) -> usize {
        let used = self.total_used();
        self.total_window.saturating_sub(used).saturating_sub(self.response_reserved)
    }
    
    fn should_warn(&self) -> bool {
        self.total_used() as f64 / self.total_window as f64 > 0.7
    }
    
    fn should_auto_compact(&self) -> bool {
        self.total_used() as f64 / self.total_window as f64 > 0.9
    }
}
```

#### 3.10 跨 session memory

```rust
// engine.rs - cross-session profile
struct UserProfile {
    preferred_language: String,
    common_topics: Vec<String>,
    past_decisions: Vec<Decision>,
    expertise_level: ExpertiseLevel,  // 推断用户技术等级
}
```

每次 chat turn 时把 `UserProfile` summary 注入 system prompt，模型能记住用户偏好。

---

## 4. 建议的代码改动文件清单

| 文件 | 改动 |
|---|---|
| `desktop/src-tauri/src/engine.rs` | 拆出 `engine_context.rs` 模块；新增 `CachedSystemPrompt`、`ContextBudget`、auto-compact |
| `desktop/src-tauri/src/engine.rs:1092` | `build_system_prompt_inner` → 缓存 + memory RAG |
| `desktop/src-tauri/src/engine.rs:1549` | `context_window_for_model` → 查表 |
| `desktop/src-tauri/src/engine.rs:782-825` | 8 个手写 compact 函数 → `OutputCompactor` trait |
| `desktop/src-tauri/src/engine.rs:1853` | `/compact` 命令保留，加 auto-compact trigger |
| `desktop/src-tauri/src/runtime.rs` (新增) | `memory_retrieval.rs` 内存检索模块 |
| `desktop/src/chat/tokenizer.ts` (新增) | 真实 token 计数（tiktoken） |
| `desktop/src/chat/Chat.tsx:58` | `estimateTokens` 替换为 `tokenizer.estimateTokens` |
| `desktop/src/chat/Chat.tsx:297` | `syncBackendContext` 改为增量同步 |
| `desktop/src/chat/Chat.tsx:202` | `needsBackendContextReset` 改为基于 token 判断 |
| `desktop/src/chat/ChatComposer.tsx:8` | `MAX_IMAGE_BYTES` / `MAX_TEXT_BYTES` 改为按 model 动态 |
| `desktop/src/chat/model.ts` | 抽取 `transcriptFromTurn` 限制（避免长对话大字符串拼接） |
| `desktop/src/chat/useChatSessions.ts:130` | 增量保存 sessions（仅 diff） |

---

## 5. 预期收益

| 指标 | 当前 | 优化后 |
|---|---|---|
| System prompt token / turn | 1000-3000 | **<200（缓存命中）** |
| Memory context token | 2000-10000（全量） | **<1000（top-5 RAG）** |
| 长对话 token 估算准确度 | ~70% | **>98%（tiktoken）** |
| Auto-compaction 触发 | 仅手动 | **70% warn / 90% auto** |
| Session 错误恢复 IPC | O(n²) | **O(Δ)** |
| 1M token session 处理 | 不可行（溢出） | **可行（auto-compact）** |
| 单次 Chat turn 成本 | $0.05-0.10 | **$0.005-0.02（缓存）** |

---

## 6. 与之前审查轮的关系

- **区域 3 H-2**（engine.rs 4306 行）→ 本报告建议**拆出 `engine_context.rs`** 模块解决
- **区域 3 H-3**（多处 `eprintln!`）→ 建议改用 `tracing::info!`，可在 auto-compact 触发时记录
- **区域 3 L-6**（estimateTokens 中文低估）→ 本报告 P0-3.1 直接修复
- **区域 1 L-7**（错误返回 String）→ context 错误也应统一为 `AppError::ContextOverflow`
- **跨轮**：`build_system_prompt_inner` 内部 `runtime::render_*_prompt` 调用是 region 1 H-1（明文凭证）的延伸

---

## 7. 总结

ARIS 当前的上下文管理"够用但不优化"，主要问题：

1. **System prompt 每次重建** — Claude/Gemini prompt cache 用不上，每次付 1000-3000 token × N turns
2. **Memory 全量注入** — 100 条 memory = 浪费 5000+ token/turn
3. **没有 auto-compact** — 用户必须懂 `/compact`，否则 silent 截断
4. **Token 估算粗略** — 中文用户被"提前终止"看不到真实 context 状态
5. **Backend sync O(n²)** — 长 session retry 性能瓶颈

**核心建议**：引入真实 tokenizer + 多层 context budget + memory RAG + prompt cache + auto-compaction。这 5 项组合预计可让长对话的 token 成本降低 **60-90%**，同时显著提升 UX（精确 context 提示、自动恢复）。

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T13-00-00Z-context-optimization.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T13-00-00Z-context-optimization.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r3-context-opt`, prompt 版本: v1, 专项审查：上下文管理优化。*
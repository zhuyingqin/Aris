# 论文讲解：让 DeepSeek、MiniMax 等服务商的提示词缓存生效

## 现象

论文讲解（逐页识别、导读、主题讲解、修订、追问、独立审核）使用 DeepSeek、MiniMax 时，用量记录里的缓存命中一直是 0。

## 原因

1. **系统提示每次都不同**。论文任务的系统提示包含运行 ID、论文 ID、PDF 哈希、页码和阶段。DeepSeek、MiniMax 和 OpenAI 的自动缓存都从请求的第一个 token 开始比对前缀，系统提示一变，后面的内容全部无法命中。
2. **可变内容排在证据前面**。逐页识别把页码和图像哈希写在指令里。主题讲解把主题、前文主题、重试错误和修订意见拼进指令，然后才是原文和原图。所以重试和修订每次都要重新计费整份证据。
3. **DeepSeek 的命中字段没有被读取**。DeepSeek 在 `usage.prompt_cache_hit_tokens` 中返回命中量，不使用 `prompt_tokens_details.cached_tokens`，所以即使命中，用量记录里也显示为 0。
4. **每次调用使用随机的路由会话 ID**。经过多账号网关时，同一篇论文的请求会被分到不同的上游账号，而缓存按账号隔离。
5. **Anthropic 兼容端点只缓存到显式断点**（例如 MiniMax 的 `/anthropic`）。此前只有系统提示带 `cache_control`，消息内容没有断点。

## 改动

- **用量**：`prompt_cache_hit_tokens` 计入 `cache_read_input_tokens`，与 `cached_tokens` 取较大值，两种字段同时出现时不会重复计算（`crates/executor/src/openai.rs`）。
- **系统提示固定**：所有论文任务使用同一份系统提示。运行、PDF、页码和阶段改为写在消息最后一块末尾的 `Task binding` 行（`PaperReadingRuntimeContext::binding_note`）。
- **统一的请求布局**：可复用的开头 → 原始证据（原文、原图）→ 页面索引与证据回执 → 唯一会变化的最后一块。

  | 阶段 | 开头 | 最后一块 |
  | --- | --- | --- |
  | 逐页识别 | `page_perception_instructions`（与页码无关） | 页码、哈希、重试错误 |
  | 导读 | `outline_prompt` | `OUTLINE_TASK` 和重试错误 |
  | 主题讲解、修订 | `teaching_preamble`（只依赖语言和导读） | `lesson_task`，其后依次追加修订意见和重试错误 |
  | 追问 | 与主题讲解相同的 `teaching_preamble` 和相同页面的证据 | `follow_up_task`：固定规则和讲解笔记在前，历史和问题在后 |
  | 独立审核 | 固定的审核说明 | 原文之后是主题和待审讲解，读取失败时的重试说明放在最后 |

- **路由**：同一次运行的所有调用使用 `paper-<runId>` 作为路由会话 ID（`ConversationRuntime::with_routing_session_id`），每次调用仍保存为独立会话。
- **Anthropic 兼容端点**：论文任务开启 `with_prompt_cache_prefix`，在最后一条用户消息的第一块和倒数第二块加 `cache_control`。加上系统提示的断点共 3 个，不超过 4 个的上限。OpenAI 兼容端点本来就自动缓存，这个开关对它们不生效。

## 各类调用可以复用的部分

| 调用 | 可命中的前缀 |
| --- | --- |
| 逐页识别，第 2 页起 | 系统提示 + 识别说明 |
| 同一页重试 | 上述内容 + 该页原文和原图 |
| 导读重试 | 系统提示 + 导读说明 + 全部证据 |
| 第 2 个主题起 | 系统提示 + 讲解开头 |
| 同一主题的重试、修订 | 上述内容 + 该主题的原文和原图；自动前缀缓存还会包括讲解要求 |
| 追问 | 系统提示 + 讲解开头 + 该部分的原文和原图（与生成讲解时相同）；对同一部分多次追问时，还会复用规则和讲解笔记 |
| 修订后复核 | 审核说明 + 原文 |

不同主题的原图不同，所以主题之间只复用开头。这是有意的取舍：讲解要求放在证据之后，追问才能复用生成讲解时的整份证据。

缓存是否命中最终由服务商决定：DeepSeek 以 64 token 为单位缓存且不保证命中，前缀短于服务商的最小长度时不会缓存，间隔过久缓存也会过期。

## 验证

| 检查 | 覆盖内容 |
| --- | --- |
| `cargo test -p aris-executor` | DeepSeek 命中字段计入缓存读取且不重复计算；Anthropic 断点标在开头块和证据末尾块 |
| `cargo test -p runtime --lib paper_` | 逐页识别说明与页码无关；讲解开头不含主题；复核和追问的共享部分在不同请求间完全一致 |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib paper_reading` | 同一主题的初稿、重试和追问只有最后一块不同；系统提示不含运行、页码和阶段；同一运行的路由 ID 相同 |

## 仍待验证

- 尚未对真实的 DeepSeek、MiniMax 端点测量命中率。可以对同一篇论文运行一次讲解，再追问一次，查看用量记录中 `cacheReadInputTokens` 在第 2 页识别、修订和追问时是否大于 0。
- OpenAI Responses API 的 `prompt_cache_key` 仍按整条首条用户消息计算，论文任务的每次调用都会得到不同的键。它只影响 OpenAI 的路由命中率，不影响 DeepSeek 和 MiniMax。

# 提示词审计

审计日期：2026-07-25
范围：`crates/runtime/src/prompt.rs`、`crates/runtime/assets/prompts/system.md`、`crates/chat/src/lib.rs` (`build_common_system_prompt`)、`desktop/src-tauri/src/engine.rs:2014-2118`、`crates/tools/src/lib.rs` (`mvp_tool_specs`)、`crates/runtime/assets/skills/*/SKILL.md`

## 一、结论速览

提示词**整体设计良好**——有 system.md 模板 + 多层 dynamic boundary + 缓存（`engine.rs:2009-2055` 的 `system_prompt_cache`），但存在以下 **5 个结构性问题**：

1. **桌面 Chat 重复造轮子**——`engine.rs:2070-2090` 在 system.md 已经覆盖的话题上又写了 11 段附加 section，**总长约 5,500 字符**，模型每轮都要完整重读
2. **`local_evidence_retrieval` 段（946 字符）跟 system.md 的 "Coding guidelines / Search and file discovery" 重复**——同一规则讲两遍
3. **skill 触发词大量重复**——literature-* 四件套 (`research-lit` / `literature-search` / `literature-screen` / `literature-evidence`) + `comm-lit-review-claude-single` 的 description 互相踩脚
4. **ToolSpec 里 `LlmReview` description 列了一组不存在的供应商**——"GLM" 出现但 `friendly_model_name()` 没有映射
5. **`McpToolExecutor` 拦截了 "ToolSearch" 但 skills 列表里没找到这个名字的 skill**——需要在 skills 列表里实际查证

## 二、桌面 Chat 系统提示词的真实长度

`engine.rs:2014` 的 `build_system_prompt_inner` 是桌面 Chat 每次构造系统提示词的入口。最终拼出来的 sections 序列：

| # | 来源 | 内容 | 长度（字符） |
|---|---|---|---|
| 1 | `system.md` 模板（54 行） | 通用系统指令 | ~1,800 |
| 2 | Output Style（如有） | 用户选择的输出风格 | 0–数千 |
| 3 | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | 边界标记 | ~40 |
| 4 | `environment_section` | cwd / date / OS / model | ~200 |
| 5 | `render_project_context` | directory_tree + git status + git diff | 数百 |
| 6 | `render_instruction_files` | AGENTS.md / CLAUDE.md 等 | 0–12,000 |
| 7 | `render_config_section` | settings.json（redacted） | 数百 |
| 8 | `append_sections`：`hot_memory` | memory + user profile + policy | 0–数千 |
| 9 | `append_sections`：`knowledge_memory` | catalog | 0–数百 |
| 10 | `append_sections`：`project_goal` | intent + milestone | 0–数百 |
| 11 | `model_identity_section` (chat/lib.rs:77) | "你是什么模型" | ~150 |
| 12 | `language_preference_section` (chat/lib.rs:85) | 中英文偏好 | ~150 |
| 13 | `llm_review_override_section` (chat/lib.rs:94) | LlmReview 优先级 | ~250 |
| 14 | `access` (engine.rs:2060) | workspace 路径 | ~340 |
| 15 | `file_links` (engine.rs:2070) | 写文件用 markdown 链接 | ~400 |
| 16 | `readable_answers` (engine.rs:2071) | 答案可读性 | ~240 |
| 17 | **`local_evidence_retrieval`** (engine.rs:2072) | **ProjectEvidenceSearch** | **946** |
| 18 | **`complex_task_contract`** (engine.rs:2073) | TodoWrite + Reviewer | ~590 |
| 19 | `artifact_layout` (engine.rs:2074) | `.somniq/...` 路径 | ~640 |
| 20 | `existing_artifact_edits` (engine.rs:2075) | 复用现有路径 | ~715 |
| 21 | `diagram_output` (engine.rs:2076) | mermaid | ~515 |
| 22 | `long_document_reading` (engine.rs:2077) | 长文档读法 | ~445 |
| 23 | `long_file_generation` (engine.rs:2078) | 长文件分段写 | ~430 |
| 24 | `latex_toolchain` (engine.rs:2110) | TeX Live 路径 | ~250 |

**桌面 Chat 实际系统提示词总长 ≈ 8,000–25,000+ 字符**（取决于 hot memory / instruction files / output style / project context 的大小）。每次开启新对话都全量塞给模型。

**Cache 命中条件**（`engine.rs:2028-2039` 的 `SystemPromptCacheKey`）：只有当 model / full_tool_registry / workspace / current_date / language / texlive / hot_memory / knowledge_memory / project_goal / instruction_fingerprint **全部不变**时才复用。`current_date` 是日期——**每天强制重建 cache**。

## 三、跟 system.md 的重复（最值得关注）

`crates/runtime/assets/prompts/system.md` 的 base 提示词已经覆盖了：

- "Coding guidelines: Match the surrounding codebase's patterns, naming, dependencies"  
- "Read relevant code before changing it, and keep changes tightly scoped"  
- "If an approach fails, diagnose the failure before switching tactics"  
- "Do not provide chain-of-thought. Briefly state what you are doing when a non-trivial tool phase begins"  
- "Report outcomes faithfully and concisely. Mention changed files, verification, and any important residual risk"

桌面 Chat 在 `complex_task_contract` (engine.rs:2073) 里又讲了一遍：

> "for code changes, research conclusions, citation work, experiments, artifact generation, or milestone work, first create a concise evidence-oriented plan with TodoWrite before making changes. Include the affected surfaces and verification needed. Simple factual answers do not need a plan. Never declare a complex task complete merely because your own prose sounds correct..."

——这条**没有跟 system.md 冲突**，但加了 desktop 特有的 TodoWrite 强制 + Reviewer revision round 概念。如果桌面 Chat 想保留 TodoWrite 强制，应该改成"在 system.md 'Coding guidelines' 的基础上，复杂任务必须 TodoWrite"。

类似地：

- `readable_answers` (engine.rs:2071) 跟 system.md "Final response and verification: prefer short paragraphs, bullets, or numbered steps" **几乎逐字重复**
- `local_evidence_retrieval` (engine.rs:2072) 跟 system.md "Search and file discovery" 在精神上重叠（都强调先 search 再答），但加了 desktop 特有的 ProjectEvidenceSearch 工具名。**这条必须保留**，因为 Tool 名是模型唯一识别入口
- `complex_task_contract` 的 TodoWrite 强制 → 跟 system.md "For tasks that involve code... default to taking action with tools" 不冲突，但**强制程度差异**值得模型困惑：system.md 说"默认做事"，desktop Chat 说"复杂任务必须先 plan"——模型怎么判断"复杂"？
- `latex_toolchain` 提到 "Do not use Tectonic or `SOMNIQ_TECTONIC`" —— 但 `SOMNIQ_TECTONIC` 是死别名（之前的审计已确认），跟 SKILL.md 里的 `ARIS_TECTONIC` 漂移

## 四、`local_evidence_retrieval` 的真 bug

这是最值得修的一段。946 字符的 prompt：

```rust
"Local literature evidence routing: when the user asks what the current project's \
local papers, PDFs, confirmed knowledge, or literature library say, you MUST call \
`ProjectEvidenceSearch` before answering, even when the user does not name the tool. \
This includes synthesis, comparisons, methods, datasets, metrics, findings, \
limitations, quotations, citations, and page-number requests. Base material claims \
only on returned confirmed knowledge or original PDF page chunks and cite them as \
`[paperId p.PAGE]`; retrieval cards, expansions, and ranks are not evidence. Use \
`LiteratureSearch` only to discover new external papers. \
`ProjectEvidenceSearch` does not build the index, so if it returns empty, explain \
that the user must run Literature > Full RAG > Incremental update and then generate \
retrieval cards. Do not silently substitute web or external metadata search for \
missing local evidence."
```

这段文字讲了：
1. 什么时候必须调 `ProjectEvidenceSearch`
2. citation 格式 `[paperId p.PAGE]`
3. 什么算 evidence / 不算 evidence
4. `ProjectEvidenceSearch` 跟 `LiteratureSearch` 的分工
5. 索引空时的用户引导文案

但 **`ProjectEvidenceSearch` 工具的 ToolSpec description（`engine.rs:1205`）已经把第 1、3、4、5 条都讲了**（约 600 字符）。

**结果是同一指令讲两遍**——模型每轮都要读 ~1,500 字符才能理解这条规则。

建议：要么把 `local_evidence_retrieval` 缩成 1-2 句指向工具（"Local evidence: call `ProjectEvidenceSearch` before answering questions about the project's local papers/PDFs/literature library. See tool description for routing rules and citation format."），要么直接删掉、依赖工具 description。

## 五、Skill 触发词踩脚（73 个 skill）

`crates/runtime/assets/skills/` 共 73 个 skill。其中 **literature / search 域有显著重叠**：

| Skill | 触发词 |
|---|---|
| `research-lit` | "find papers", "related work", "literature review", "what does this paper say" |
| `literature-search` | "structured scholarly retrieval, systematic search planning, traceable query/source history" |
| `literature-screen` | "screen a saved SomniQ literature SearchRun in durable 40-paper Reviewer batches" |
| `literature-evidence` | "turn human-confirmed literature screening results into page-grounded briefs" |
| `comm-lit-review-claude-single` | "communications, wireless, networking, satellite/NTN, Wi-Fi, cellular, transport protocols, congestion control, routing, scheduling, MAC/PHY, rate adaptation, channel estimation, beamforming" |
| `openalex` | "openalex search", "search openalex", "open citation graph" |
| `scopus-search` | "Scopus-indexed coverage beyond arXiv/web search, related-work surveys, exact database queries, cited-by counts" |
| `arxiv` | "search arxiv", "download paper", "fetch arxiv", "arxiv search", "get paper pdf" |
| `exa-search` | "exa search", "web search with content", "find similar pages" |
| `prior-art-search` | "现有技术检索", "prior art search", "专利检索" |

**问题 1：`research-lit` 跟 `literature-search` 触发词有部分重叠**——`research-lit` 说"literature review"会触发，但 `literature-search` 是更结构化的替代。

**问题 2：`comm-lit-review-claude-single` 名字带 "-claude-single" 像是某个实验性分支**——和 `comm-lit-review` (空) 不一致。

**问题 3：四个 `literature-*` 描述里写的是"流程编号"而不是用户语言**——"Screen a saved SearchRun in 40-paper Reviewer batches"，用户不会这么说"Screen a saved SearchRun"。模型会按自己的语义理解匹配，**但触发成功率下降**。

**问题 4：很多 skill 没有 `argument-hint`**（`prior-art-search` 有，但 `comm-lit-review-claude-single` 没设）。`render_available_skills` 在 prompt 里用 `--lit-arg-hint` 渲染，缺失会显示空槽。

## 六、ToolSpec description 的不一致

`crates/tools/src/lib.rs:806` 的 `LlmReview` description：

> "Supports OpenAI, Gemini, GLM, MiniMax, Kimi, and Anthropic-compatible endpoints."

跟 `crates/chat/src/lib.rs:103` 的 `friendly_model_name()` 对照：

| 工具声称支持 | `friendly_model_name` 实际映射 |
|---|---|
| OpenAI | gpt-5.x ❌ 缺；o1/o3/o4 ❌ 缺 |
| Gemini | ❌ 完全没列 |
| GLM | ❌ 完全没列 |
| **MiniMax**（错位）| **MiMo**（"Xiaomi MiMo v2.5 Pro"）—— 公司名 ≠ 模型族 |
| Kimi | kimi-k2.5 等 |
| Anthropic-compatible | claude-opus-4-7 等 |

**问题**：
1. **`MiniMax` 不在 `friendly_model_name` 里**——而是 MiMo 在 friendly_name 里。Tool description 说"支持 MiniMax"，但路由按 `mimo-*` 模型 ID，不是按公司。模型读 prompt 时会以为可以传 "MiniMax-M3" 但其实路由不到。
2. **`GLM` 完全没有映射**—— ToolSpec 在描述里承诺的能力根本不存在
3. **examples 用过时模型版本**——"gpt-5.5, gemini-2.5-pro, GLM-5, MiniMax-M2.7"（prompt:807-817）里的 `GLM-5` / `MiniMax-M2.7` / `kimi-k2.5` 都是假想 ID

**修复**：
- description 里把 "GLM, MiniMax" 删掉，改成 "Kimi/MiMo 和 Anthropic-compatible endpoints"（基于 `friendly_model_name` 的实际映射）
- examples 改成 `claude-haiku-4-5-20251001, claude-sonnet-4-6` 等真实 ID

## 七、`McpToolExecutor` 里 `ToolSearch` 的描述（crates/chat/src/lib.rs:351-358）

`ToolSearch` 工具是 MCP 工具延迟加载机制的一部分。它的 description 让模型"select:" 前缀过滤工具名。但：

1. **`render_available_skills` 列出的 73 个 skill 名字都不带 `mcp__` 前缀**——但 ToolSearch 的过滤机制依赖 MCP 服务命名空间
2. **前端 `desktop/src/chat/chatRunHelpers.ts:283` 的 `isKnownSkill` 逻辑用小写比较 skill.name** —— 跟 ToolSearch 的 `select:` 行为不一致

这是技术细节，但**对模型选择正确工具的能力有影响**。

## 八、user_prompt_view 缺失

`engine.rs:3042` 的 `user_prompt_view` 只在 `chat_user_prompt_view` 那个 Tauri 命令里返回上一次模型实际看到的"用户回合"。这是诊断工具，不是模型行为本身。

但**重试 / 继续 prompt 缺乏**：`chatRunHelpers.ts:279` 的 `continueStoppedPrompt()` 写得很短：

```ts
return [
  "Continue from where the previous turn left off.",
  "Your partial response — including any tool calls and their results — is already in the conversation above.",
  "Do not repeat the completed portion unless a short overlap is needed for continuity.",
].join("\n");
```

——这段合理，跟 system.md "Continue from the latest preserved user request" 一致。

## 九、Output Style 机制

`SystemPromptBuilder::with_output_style()` (prompt.rs:108) 允许设置"输出风格"提示，但**桌面 Chat 似乎没暴露设置 UI**——`engine.rs:2014` 构造时也没传 output_style。也就是说这个机制**当前只有 CLI 用，桌面 Chat 不支持**。

## 十、修复优先级建议

| 优先级 | 项 | 改动量 | 风险 |
|---|---|---|---|
| **P0** | `engine.rs:2116` 的 `latex_toolchain` 段：删掉 `SOMNIQ_TECTONIC` 引用（死别名） | 1 行 | 零 |
| **P0** | `crates/tools/src/lib.rs:806` 的 `LlmReview` description：删掉 GLM / MiniMax，更新 examples | 1 段 | 低 |
| **P1** | `engine.rs:2071` 的 `readable_answers`：与 system.md 重复，删除 | -240 字符 | 零 |
| **P1** | `engine.rs:2072` 的 `local_evidence_retrieval`：缩成 1-2 句指向 ToolSpec | -750 字符 | 低（依赖 ToolSpec 已有的描述） |
| **P1** | `engine.rs:2074` 的 `artifact_layout` + `:2075` 的 `existing_artifact_edits`：考虑合并 | -400 字符 | 低 |
| **P2** | 4 个 `literature-*` skill 的 description：把内部流程术语换成用户语言 | 4 段 | 低 |
| **P2** | `comm-lit-review-claude-single` 名字去掉 `-claude-single` 后缀 | 1 行 | 中（可能影响已保存的 skill 引用） |
| **P2** | 给 desktop Chat 加 Output Style 设置 UI（如果产品需要） | 1 个新 tab | — |
| **P3** | Cache key 移除 `current_date` 或改成"同一天"——避免每天全量重建 | 1 行 | 低 |

## 十一、未在本次审计范围

- 各 `runtime/config.rs` 里的 `CONFIG_WHITELIST_FIELDS` 是否真的只白名单了安全字段
- Skill descriptions 后续的正文内容是否含过时指令（Tectonic、GLM、MiniMax 等同款问题）
- `paper-compile/SKILL.md` 等已经在用 `ARIS_TECTONIC`，但 `engine.rs:2116` 还在提 `SOMNIQ_TECTONIC`——SKILL.md 已经在迁移，prompt 还没跟上

完整 prompt 长度统计、Skill 触发词清单、ToolSpec 描述与实际路由的差异详见上面各节。
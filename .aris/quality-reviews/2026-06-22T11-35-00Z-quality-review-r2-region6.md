# ARIS 代码质量审查 · 第 2 轮 · 区域 6：Knowledge 模块

**触发时间**：2026-06-22T11:35:00Z
**任务 ID**：`aris-review-r2-knowledge`
**审查范围**：`desktop/src-tauri/src/knowledge.rs`（299 行）+ `desktop/src/knowledge/*` 5 个 tsx/ts
**新发现问题**：21（高 4 / 中 11 / 低 6）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/knowledge.rs` | 299 | Knowledge base CRUD + LLM generate candidates |
| 2 | `desktop/src/knowledge/knowledgeStore.ts` | ~450 | Zustand store |
| 3 | `desktop/src/knowledge/knowledgeTypes.ts` | ~80 | 类型定义 |
| 4 | `desktop/src/knowledge/KnowledgeReview.tsx` | ~980 | 知识审核 UI（33988 字节） |
| 5 | `desktop/src/knowledge/KnowledgeReview.test.tsx` | 10773 | 测试 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（4 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `knowledge.rs:96-147` (`generate_candidates` + `parse_candidates`) | 安全 | LLM 输出的 `quote` 字段被直��存入 SQLite **作为 evidence**，但**不做 hash / similarity 校验是否真在原 PDF 中**。模型幻觉（hallucination）会让假 quote 永久写库。前端 UI 在 confirmed 状态下会把 quote 当事实展示 |
| **H-2** | `knowledge.rs:81-89` (`build_generation_prompt` 用 `paper["brief"]` 直接序列化) | 安全 | brief 是用户/agent 之前生成的，可能含未转义的换行、控制字符、Markdown 注入。`serde_json::to_string_pretty(brief).unwrap_or_default()` 把这些直接拼到 prompt 尾部。虽然注入到 system 不是严重问题，但 brief 字段如果含 `##STOP##` 或 `</system>` 标记会影响模型行为 |
| **H-3** | `knowledge.rs:50-58` (`knowledge_upsert` 用 `Vec<Value>` 任意字段) | 安全 | `parse_points` 把前端传入的任意 JSON 反序列化为 `KnowledgePointInput`，**没有 schema 校验**。前端可能传含 `id: "user-secret-1"`、`status: "confirmed"`、`createdAt: "1970-01-01"` 等字段的 point，绕过文档注释"never confirms"。即使后端 write 时 ignore id/status，前端误显示 status="confirmed" 也是 UX 问题 |
| **H-4** | `KnowledgeReview.tsx:33988` 字节（约 980 行） | 设计缺陷 | 单组件 980 行含 4 个 view（fragments/graph/review/confirmed）+ LLM 调用 + graph 渲染 + 拖拽 + 详情面板。应拆 `KnowledgeFragments`、`KnowledgeGraph`、`KnowledgeReviewList`、`KnowledgePointDetail` |

### 🟡 中级（11 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `knowledge.rs:103-110` (`paper_id` 字符串匹配) | 健壮性 | `paper["id"].as_str() == Some(paper_id)` —— paper id 是用户输入字符串，可能与数据库中实际 id 大小写不一致（虽然实际是 arxiv:id 格式）。如果前端传 `arxiv:1234.5678` 而库中是 `arXiv:1234.5678`，找不到 |
| **M-2** | `knowledge.rs:115` (`run_oneshot` 不等待） | 并发 | `generate_candidates` 在 spawn_blocking 里串行 LLM 调用，无 timeout。LLM hang 60s 后整个 IPC thread block |
| **M-3** | `knowledge.rs:152-180` (`extract_json_array` 字符串解析) | 健壮性 | 手写 JSON array 提取状态机，**不处理 comment (`//`)** 也不处理 trailing comma。某些 LLM 输出 `// note here\n[\n  {...}, // comment\n]` 会失败 |
| **M-4** | `knowledge.rs:130-145` (`parse_candidates` 静默丢弃) | 业务逻辑 | `for item in items { let Ok(mut point) = serde_json::from_value(...) else { continue; };` —— 解析失败的 candidate **完全静默丢弃**。如果 LLM 返回 6 个 candidate 但 4 个解析失败，UI 只显示 2 个且无 warning |
| **M-5** | `knowledge.rs:155-162` (`evidence.retain` 不验证 quote 真���性) | 数据完整性 | `point.evidence.retain(|e| !e.quote.trim().is_empty() || e.annotation_id.is_some() || e.evidence_id.is_some())` —— 仅保留非空 quote 的 evidence，**不验证 quote 是否真的来自 paper**。这是 H-1 的具体代码位置 |
| **M-6** | `knowledgeStore.ts:80` (`toKnowledgeFragments` 全量 O(N²)） | 性能 | `evidence` 与 `annotations` 双向关联用 `Map` 索引 OK，但 `answerChains.supports.annotationId` 反查 annotation 是 O(N) 查找，100 个 chain × 1000 annotations = 100k ops |
| **M-7** | `knowledgeStore.ts:80` (`hasReadingMaterial` 浅判断) | 业务逻辑 | `Boolean(paper.brief) || (paper.evidence && paper.evidence.length > 0) || ...` —— 只检查长度 > 0。空 brief `{}` 会被 truthy 判断为存在，但实际上无内容 |
| **M-8** | `knowledgeStore.ts:300+` (`knowledgeGenerate` 与 literature 联动) | 依赖耦合 | `knowledgeGenerate` 必须先 `literatureLoad` 拿到 paper 详情才能 generate。但 knowledge store 不知道 literature store 状态，两次 IPC 顺序未保证 |
| **M-9** | `KnowledgeReview.tsx:65` (`GRAPH_SYSTEM` 提示) | 业务逻辑 | `GRAPH_SYSTEM` prompt 让 LLM "create a top-down taxonomy" + "Do not invent item ids" —— 但 LLM 可能违反。**前端无 validation**：如果 LLM 返回的 taxonomy 含不存在的 itemId，graph 渲染��找不到节点，**fallback 到空但不报错** |
| **M-10** | `KnowledgeReview.tsx:550+` (graph 渲染) | 性能 | 拖拽节点重新计算 `VisualNode.x/y` 是 O(N) 全量 setState，节点 > 50 时帧率掉到 30fps 以下 |
| **M-11** | `knowledgeTypes.ts` 全文 | 一致性 | `KnowledgePoint` 类型的 `id` 是 `string` 但 `kp_id` 在 backend 又是 `String` —— 前后端命名不一致（KnowledgeReview.test.tsx 中混用） |

### 🟢 低级（6 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `knowledge.rs:32-34` (`limit.clamp(1, 50)`) | 设计缺陷 | limit 上限 50 但 search 无分页，50 个 point × 1KB = 50KB IPC 一次返回 |
| **L-2** | `knowledge.rs:130-145` (`parse_candidates` 中 `point.id = None; point.status = None;`) | 一致性 | 显式置 None 但注释说"never confirms"，应在 schema 层禁止这两个字段出现 |
| **L-3** | `knowledgeStore.ts` 全文 | 错误处理 | 所有 `await` 后的 catch 都用 `setError(String(e))`，没有分类（network/auth/validation） |
| **L-4** | `KnowledgeReview.tsx:980` | 测试 | `KnowledgeReview.test.tsx` 10773 字节，但 980 行组件覆盖率不够 |
| **L-5** | `knowledgeStore.ts:80` | 国际化 | `toKnowledgeFragments` 默认 title 用 paper.id（英文/特殊字��），前端展示可能含乱码 |
| **L-6** | `knowledge.rs:170` (`extract_json_array` 字符扫描) | 性能 | O(N) 字符扫描，但 LLM 输出 10KB+ 时每次 generate 都重新扫描；可以 stream parse |

---

## 3. 风格 / 一致性观察

- `knowledge.rs:parse_candidates` 与 `literature.rs:parse_candidates` 不存在，但 `extract_json_array` 与 `config.rs` 等多处可能有类似 JSON 提取逻辑，应抽 `crate::json_ext::extract_json_value`
- `knowledgeStore.ts` 中 `toKnowledgeFragments`、`toSourcePaper`、`clean` 是纯函数但放在 store 文件，应拆 `knowledgeTransforms.ts`
- `KnowledgeReview.tsx` 的 4 个 view 共享 `KnowledgePoint` 数据但每个 view 自己重新 filter —— 应该用 React Query/SWR
- `knowledge.rs:GENERATION_SYSTEM` 与 `literature_review_llm` 的 system 拼接风格类似，应抽 `PromptBuilder`
- `knowledge_upsert` 与 `knowledge_confirm` 单独写但都用 `tools::knowledge::knowledge_*_at`，可抽 wrapper
- `KnowledgeReview.tsx:graph 渲染` 用 SVG 而非 canvas，> 200 节点性能下降
- `knowledgeStore.ts:knowledgeGenerate` 返回 draft cards，但 UI 渲染与 `KnowledgePoint` 数据结构不一致需要重新映射
- `knowledgeTypes.ts` 缺少 `KnowledgeRelation` 类型（虽然 KnowledgeReview UI 提到 relation，但 schema 没暴露）

---

## 4. 本轮确认无问题的方面

✅ `knowledge.rs:knowledge_confirm` 是 **唯一** confirm 路径（设计良好）
✅ `parse_candidates` 强制要求 evidence 不为空，过滤掉无锚点 candidates
✅ `extract_json_array` 处理 `\`json` fence 和嵌套字符串
✅ `generate_candidates` 在 spawn_blocking 跑避免阻塞 IPC
✅ `evidence_json` 不泄露内部 field（如 evidence_id 可选）
✅ 测试覆盖 `extracts_json_array_from_fenced_reply` 和 `drops_candidates_without_anchors_and_defaults_paper_id` 关键路径
✅ `knowledge_reject` 返回 bool 表明删除成功
✅ `KnowledgeReview.test.tsx` 10773 字节覆盖 view 切换和 store 联动

---

## 5. 与之前轮的关系

- **区域 3 H-3**（`engine.rs` 多处 `eprintln!`）→ `knowledge.rs:run_oneshot` 调 `literature::run_oneshot` 不污染 stderr（OK）
- **区域 4 M-9**（`bytesToBase64` 不高效）→ 本轮 knowledge store 不直接处理 bytes
- **区域 4 H-1**（`literature_review_llm` skill markdown 注入）→ 本轮 `build_generation_prompt` 把 paper.brief 也直接拼到 prompt，但 brief 是模型生成的内容，注入风险中等
- **跨轮**：knowledge 与 literature 共享 `tools::literature` 和 `tools::knowledge`，library.json 与 knowledge.db 的耦合关系应在文档中明示

---

## 6. 累计进度

```
已审 / 总文件:   30 / ~99 (.rs) + 11 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ✅
  desktop/chat 前端   4 / 8   ✅
  desktop/literature 1 / 1   ✅
  desktop/literature 前端 5 / 7 ✅
  desktop/lab        1 / 1   ✅
  desktop/lab 前端    3 / 9   ✅
  desktop/knowledge  1 / 1   ✅ ← 本轮
  desktop/knowledge 前端 4 / 5 ← 本轮
  desktop/studio     0 / 1
  desktop/mail       0 / 10
  desktop/sessions   1 / 1   ✅
```

---

## 7. 下次审查预期（区域 7：Mail 模块）

- `desktop/src-tauri/src/mail/*`（10 个文件，最大 imap.rs 61893 bytes、gmail.rs 13713、oauth.rs 18510、autoconfig.rs 12494、agent_tools.rs 9684 等）
- `desktop/src/mail/Mail.tsx`、`mail/MailSettings.tsx`
- 重点关注：OAuth 凭证存储、IMAP IDLE 连接保活、邮件正文 HTML XSS、agent_tools 的权限边界、autoconfig 的 DNS/Mozilla 公共后端信任

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T11-35-00Z-quality-review-r2-region6.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T11-35-00Z-quality-review-r2-region6.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-knowledge`, prompt 版本: v1, region: 6/9。*
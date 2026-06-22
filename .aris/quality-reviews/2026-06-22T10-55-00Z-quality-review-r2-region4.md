# ARIS 代码质量审查 · 第 2 轮 · 区域 4：Literature 模块

**触发时间**：2026-06-22T10:55:00Z
**任务 ID**：`aris-review-r2-literature`
**审查范围**：`desktop/src-tauri/src/literature.rs`（914 行）+ `desktop/src/literature/*` 9 个 tsx/ts
**新发现问题**：27（高 4 / 中 14 / 低 9）

---

## 1. 审查范围

| # | 文件 | 行数 | 用途 |
|---|---|---|---|
| 1 | `desktop/src-tauri/src/literature.rs` | 914 | 文献命令（search/import/pdf/OCR/llm） |
| 2 | `desktop/src/literature/Literature.tsx` | ~2400 | 主 Literature 页面（95900 字节，最大前端文件） |
| 3 | `desktop/src/literature/PdfReader.tsx` | ~1400 | PDF 阅读器 |
| 4 | `desktop/src/literature/MathText.tsx` | 143 | KaTeX 数学公式渲染 |
| 5 | `desktop/src/literature/pdfExtraction.ts` | 221 | 前端 PDF 文本提取 |
| 6 | `desktop/src/literature/literatureStore.ts` | ~2000 | Zustand store |
| 7 | `desktop/src/literature/literatureTypes.ts` | ~250 | 类型定义 |

---

## 2. 新发现问题（按等级分桶）

### 🔴 高级（4 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **H-1** | `literature.rs:46-66` (`literature_review_llm`) | 安全 / 行为 | `tools::execute_tool("LlmReview", ...)` **没有 scope 检查**。Review skill markdown 直接拼接到 prompt 然后交给 LlmReview tool。如果 review_skill markdown 含不可信内容（虽是用户自己安装的 skill 但可能被供应链攻击），会注入到 reviewer context |
| **H-2** | `literature.rs:135` (`literature_llm`) | 并发 | 调用 `run_oneshot` 之前没有 per-session lock，多个 Literature LLM 调用并发时会共享 `runtime::clear_interrupt()` 全局状态，导致一个 cancel 影响所有 |
| **H-3** | `literature.rs:486-625` (整个 PDF extraction 流程) | 安全 / 性能 | `pdftoppm` 渲染 PDF 为 PNG、OCR、再清理 —— 整个流程**调用了 5 个外部进程**（pdfinfo、pdftotext、pdftoppm、tesseract、powershell），每个都没有超时控制。一个恶意构造的 PDF 可能让 pdftoppm 进入死循环（PDF bomb），永久挂起 Literature 命令线程 |
| **H-4** | `Literature.tsx:95900` 字节（约 2400 行） | 设计缺陷 | **单前端组件 2400 行**，含文献列表、详情面板、Brief 生成、PDF 阅读器入口、筛选、搜索、笔记、收藏等多职责。状态管理混乱，应拆为 `LiteratureList`、`LiteratureDetail`、`BriefPanel`、`LibrarySidebar` |

### 🟡 中级（14 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **M-1** | `literature.rs:222-252` (`resolve_pdf_path_at`) | 安全 | `canonicalize` 后用 `path.starts_with(root)` 校验，但 `root = base.join(directory).canonicalize()`。如果 `base` 自身是 symbolic link，canonicalize 后 `path` 与 `root` 比较的是 resolved path，OK；但中间目录 `papers/` 缺失时 `canonicalize().ok()` 返回 None，**被 filter_map 跳过**，allowed_roots 为空数组时 `path.starts_with(...)` 全部返回 false 但**不报错**：合法 PDF 也会被拒 |
| **M-2** | `literature.rs:228` (`is_absolute` + `ParentDir` 检查) | 安全 | `relative.is_absolute()` 检查，**但没检查 `Component::CurDir` 单独出现**（如 `./papers/foo.pdf`），且没检查 Windows 盘符前缀（如 `C:foo`）。攻击者可传 `C:foo.pdf` 绕过 `is_absolute` 检查 |
| **M-3** | `literature.rs:307-335` (`literature_image_ocr`) | 安全 | 写入 `std::env::temp_dir().join(format!("aris-pdf-page-ocr-{}-{nonce}.png", std::process::id()))` —— 用 PID + nonce 防冲突，但**nonce = `as_nanos()` 在 32 位系统上溢出风险**；同时文件名不含 OCR 调用方信息，调试时无法定位哪个 session 触发 |
| **M-4** | `literature.rs:107-130` (`vision_message`) | 性能 | `validate_vision_model` 用 `starts_with("minimax-")` 但项目实际模型是 `MiniMax-M3`（大小写不一致），加上 `to_ascii_lowercase()` 后等于 `minimax-m3`。硬编码模型名脆弱，未来模型改名或加 MiniMax-M4 会断 |
| **M-5** | `literature.rs:176-182` (`run_oneshot` 中 `final_assistant_text`) | 健壮性 | `RuntimeFeatureConfig::default()` 写死默认值，与 Chat turn 用真实 `feature_config` 不一致。Literature LLM 走的是简化路径，但 system prompt 是用户的，可能依赖 MCP 配置 |
| **M-6** | `literature.rs:603-625` (`has_readable_text`) | 业务逻辑 | 阈值 `>= 8` 个 alphanumeric 字符。但中文文献全部页面都是中文（不含 ASCII alphanumeric），**会被判为"无文字"并触发 OCR**，但 OCR tesseract -l eng 不识别中文，**永远输出空** |
| **M-7** | `literature.rs:712` (Windows OCR PowerShell script) | 安全 | PowerShell 脚本中 `$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:ARIS_OCR_IMAGE))` —— `ARIS_OCR_IMAGE` 从 stdin 注入。**PowerShell 脚本会展开 `$env:`**，如果 `image` 路径含 `$env:HACKER` 会被环境变量替换。Windows 路径几乎不含 `$` 但风险存在 |
| **M-8** | `literature.rs:732` (tesseract 调用) | 性能 | `tesseract -l eng` 硬编码英文，对中文 PDF 永远 OCR ��败回退到 Windows OCR。中日韩论文 PDF 全文提取都不可用 |
| **M-9** | `pdfExtraction.ts:46-58` (`bytesToBase64` 用 `String.fromCharCode`) | 性能 / 健壮性 | `String.fromCharCode(...bytes.subarray(...))` 在大 buffer（10MB image）下会让 V8 进入 slow path，且**遇到 Latin-1 范围外字符会丢精度**（但 image byte 都在 0-255，所以 OK，但 inefficient）。应直接 `btoa(String.fromCharCode(...))` 或用 FileReader.readAsDataURL |
| **M-10** | `pdfExtraction.ts:60-75` (PDF.js worker 配置) | 配置 | `pdfjs-dist` worker 直接用 `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` —— 在 Tauri webview 中如果 resource_dir 不正确，会回退到 CDN；CDN 上的 worker 可能被 MITM 或版本不匹配 |
| **M-11** | `MathText.tsx:8` (`DELIMITED_MATH` 正则) | 安全 / 健壮性 | 正则 `(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\))` —— `[\s\S]+?` 是非贪婪，但外层 `matchAll` 配合多行文本时 `\n` 在 `\$` 内部可能被吞。极端 LLM 输出 `$\n x $` 会被错误拆分 |
| **M-12** | `MathText.tsx:101-105` (`katex.renderToString`) | 安全 | `throwOnError: true` 会捕获错误 fallback，但 `dangerouslySetInnerHTML` 注入 KaTeX 输出。KaTeX 自身不执行任意 HTML（防止 XSS），但**如果用户在 LateX 公式中包含 `\href{javascript:...}{click}` 会执行**。`trust: false` 设置可阻止，但需确认 v0.17 的 trust mode 配置生效 |
| **M-13** | `MathText.tsx:73-82` (`looksLikeStandaloneMath`) | 业务逻辑 | 中文 `\u3400-\u9fff` 直接被排除，混合中英的物理公式（如 "求解 x 的值，其中 x² + 2x + 1 = 0"）不会被识别为公式 → 渲染为纯文本而非数学公式 |
| **M-14** | `literature.ts:159` (`Literature.tsx`) | 性能 | 整篇 Literature.tsx 95900 字节，没有 memo 优化。主组件 re-render 会导致整个列表重绘。`useMemo` 缺失，fuzzy search 每次 keystroke 都跑 |

### 🟢 低级（9 个）

| ID | 文件:行号 | 类别 | 摘要 |
|---|---|---|---|
| **L-1** | `literature.rs:11-30` (header imports) | 一致性 | 顶部的 `use runtime::Session` 等 import 几乎涵盖全部 Chat runtime —— Literature LLM 与 Chat 引擎共享 runtime，但两个用途的 feature config 完全不同（Literature 简化），易混 |
| **L-2** | `literature.rs:84-94` (`SilentObserver`) | 健壮性 | `on_text_delta` / `on_tool_call` 都返回 Ok，**吞掉了所有事件**。如果 executor 内部出错，调用方完全无感知 |
| **L-3** | `literature.rs:181-186` (`run_oneshot` 错误信息) | 健壮性 | `resolve_settings_executor_config(&config)` 失败时错误信息含 `config` 内容，可能泄露敏感路径 |
| **L-4** | `literature.rs:284-298` (`import_pdf_at`) | 安全 | `sanitize_file_name` 调用外部 `tools::literature::sanitize_file_name` 实际正确，但 `destination` 路径不检查 `papers/` 目录权限。如果 `papers/` 被恶意链接指向系统目录，`copy` 会覆盖系统文件 |
| **L-5** | `literature.rs:540-580` (`extract_pdf_text_by_page`) | 性能 | 每个 page 都 spawn `pdftotext` 进程，30 页 PDF = 30 个进程。批量调用应使用 `pdftotext` 单次 + 分隔符 |
| **L-6** | `pdfExtraction.ts:78-93` (`renderPagePng` scale=2) | 性能 | scale=2 渲染 1 个 PDF page 到 PNG 在大 PDF 上是 O(n²)（高 DPI 文件），且 1 page 渲染为 4MB PNG 进入 OCR。中文 PDF 用户频繁触发 |
| **L-7** | `pdfExtraction.ts:32-36` (`hasReadableText`) | 业务逻辑 | 与 Rust 版本 `has_readable_text` 一致问题（中文不被识别），但前端版本在 prompt 提取决策中先调用，浪费 IPC |
| **L-8** | `MathText.tsx:124-130` (`Formula` 组件) | 性能 | 每次公式渲染都创建新的 katex output HTML，没有 cache。相同公式在不同位置被渲染 N 次 |
| **L-9** | `literature.ts:2400` ���文 | 设计缺陷 | 整个 Literature.tsx 没有 `useReducer` 或 RTK Query，所有状态都用 useState + 10+ useState 调用，状态机容易漏更新 |

---

## 3. 风格 / 一致性观察

- `literature.rs:resolve_pdf_path_at` 与 `files.rs` 中可能存在的 `resolve_*` 路径函数应该抽 `crate::path_utils` 共享
- `literature.rs:has_readable_text` 与 `pdfExtraction.ts:hasReadableText` 是**前后端两份相同实现**（与 `chat/model.ts:cleanChatTitle` 同模式）
- `literature.rs` 整个文件混合了 IPC 命令、PDF 解析、OCR 调用、LLM 调度 —— 应拆为 `literature_commands.rs`、`literature_pdf.rs`、`literature_ocr.rs`
- `Literature.tsx` 中 `literatureLoad/literatureSave` 频繁调用没有 debounce，可能在大库下连续写入冲突
- `pdfExtraction.ts` 应该在 worker 线程中跑（off main thread），现在阻塞 React render
- `MathText.tsx:73-82` `looksLikeStandaloneMath` 的 `[A-Za-zΑ-Ωα-ω][\u0302\u0304\u0303]?` 在用户输入 `\u200b`（零宽字符）后失效
- `literature.rs:486` 的 `pdftoppm` 用 `-r 180` 硬编码 DPI，扫描版 PDF 用 180 DPI OCR 准确率低
- `literature.rs:486-625` 的 OCR 错误处理只在 stderr 中输出，UI 上不显示

---

## 4. 本轮确认无问题的方面

✅ `resolve_pdf_path_at` 用 `canonicalize` 后 `starts_with` 校验路径在允许目录内
✅ `vision_message` 验证 `page == 0` 拒绝 0-based page
✅ `import_pdf_at` 验证 `%PDF-` magic header
✅ `literature_image_ocr` 验证 PNG magic bytes
✅ `literature_search` 用 `clamp(1, 50)` 限制 max_results
✅ `literature_review_llm` 用 `apply_reviewer_environment(true)` 强制刷新 reviewer env
✅ 测试覆盖 `pdf_paths_are_limited_to_library_and_studio_results`、`imports_only_valid_pdf_files_into_papers` 等关键路径
✅ `MathText.tsx` 用 `trust: false` 阻止 KaTeX 危险扩展

---

## 5. 与之前轮的关系

- **区域 1 H-4**（`set_current_dir` race）→ `literature.rs` 不依赖 cwd（用 `project_base()`），OK
- **区域 1 H-3**（`set_var` 并发）→ `literature_review_llm` 调 `apply_reviewer_environment(true)` 同样模式
- **区域 2 H-3**（路径过滤不严）→ 本轮 M-1/M-2 同样问题（Windows `C:foo`、UNC 等）
- **区域 3 M-12**（cleanChatTitle 跨语言重复）→ 本轮 `has_readable_text` 也是跨语言重复

---

## 6. 累计进度

```
已审 / 总文件:   23 / ~99 (.rs) + 7 (.tsx/.ts)
按区域进度:
  crates/api/        6 / 6   ✅
  crates/aris-cli/   1 / N
  desktop/core       8 / 8   ✅
  desktop/scheduled  4 / 4   ✅
  desktop/chat       1 / 1   ✅
  desktop/chat 前端   4 / 8   ✅
  desktop/literature 1 / 1   ✅ ← 本轮（literature.rs 主体）
  desktop/literature 前端 5 / 7 ← 本轮
  desktop/lab        0 / 1
  desktop/knowledge  0 / 1
  desktop/studio     0 / 1
  desktop/mail       0 / 10
```

---

## 7. 下次审查预期（区域 5：Lab 模块）

- `desktop/src-tauri/src/lab.rs`（29628 bytes）
- `desktop/src/lab/*`（Lab.tsx, CodeEditor.tsx, FileEditorPane.tsx, LabAssistant.tsx, LabFiles.tsx, labStore.ts, labTypes.ts, outputs.tsx, textDiff.ts）
- 重点关注：Jupyter kernel 进程生命周期、notebook JSON 解析、kernel 状态切换、lab agent tool 安全边界

---

**详细报告**：[`.aris/quality-reviews/2026-06-22T10-55-00Z-quality-review-r2-region4.md`](https://github.com/zhuyingqin/Aris/blob/release/v0.4.1/.aris/quality-reviews/2026-06-22T10-55-00Z-quality-review-r2-region4.md)

*本 Issue 由「ARIS AI 审查机器人」自动生成。任务 ID: `aris-review-r2-literature`, prompt 版本: v1, region: 4/9。*
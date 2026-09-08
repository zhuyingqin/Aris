# Zotero 能力补齐计划

> 状态：M0 + M1 已实现 · 其余为提案 · 2026-08-30 · 目标分支 `aris-code`
>
> 范围：`crates/runtime/src/literature.rs`、`crates/tools/src/literature.rs`、
> `desktop/src-tauri/src/literature.rs`、`desktop/src/literature/`、
> `desktop/src/settings/`。本文只做设计与排期，不含实现改动。
>
> 前置：本文假定读者已知 `literature-kernel-migration.md` 确立的分层
> （runtime 拥有数据契约与持久化，tools 拥有源适配与规范化，Desktop 只调用）。
> 下面每一项都必须落在这个分层里，不允许 Desktop 直接写 SQLite。

## 0. 结论先行

11 项缺口里，**只有 3 项是真正的"没有"**，其余 8 项都有可复用的地基。按
「单位工作量产生的用户价值」排序后的建议顺序，与逐项现状勘察结果如下。

| # | 缺口 | 现状 | 工作量 | 阶段 |
|---|---|---|---|---|
| 1 | 附件自动重命名 | 完全没有，三条写文件路径各写各的 | 2 d | M1 |
| 2 | Quick Copy | 格式化引文已有，只差剪贴板与拖拽 | 0.5 d | M1 |
| 3 | 报告导出 | 完全没有，但可复用 citationEngine | 0.5 d | M1 |
| 4 | 代理 / OpenURL | 完全没有，非 OA 文献直接拿不到 | 3 d + 摸底 | M2 |
| 5 | Retraction Watch | 完全没有 | 2 d | M2 |
| 6 | CSL 样式 | **已有部分实现**，缺排序/消歧/locale | 3 d（依赖授权决策） | M3 |
| 7 | 富文本笔记 | `<textarea>` + 纯字符串 | 3 d | M4 |
| 8 | 网页快照 / EPUB | 只有 PDF + 纯文本查看器 | 2 d + 4 d | M4 |
| 9 | 撤销历史 | 审计日志存在但**不存前后值** | 4 d | M5 |
| 10 | 附件外部变更监听 | 只有拉模式健康检查 | 2 d | M5 |
| 11 | RSS 订阅 | 完全没有，但 Atom 解析与 `unread` 可复用 | 4 d | M6 |

**需要先做的共享前置**：Settings 里没有文献库面板。`CitationStyleManager` 现在
挂在条目详情页 (`Literature.tsx:5899`)，不是设置里。M1–M3 有 5 项都需要配置项
落地，所以第一件事是开 `Settings → 集成 → 文献库` 这个壳（约 0.5 d），
放在 `settingsNav.tsx:125` 的 `integration` 分组下。

## 1. 勘察结论：几条需要修正的既有认知

写计划前逐项读了代码，有三处和最初的判断不一致，先记下来：

- **CSL 不是"完全不支持"**。`citationEngine.ts:52` 有 `importCslStyle`，
  `citationEngine.ts:396` 的 `renderCslNode` 实现了 `layout` / `group` / `text` /
  `names` / `date` / `label` / `choose` / `substitute` 的子集，样式存在
  localStorage。缺的是 CSL 1.0.2 的难点部分（见 §M3）。
- **附件不只落在一个目录**。`papers/` 下混有非文献文件（实测有
  `NEUNET-D-26-03150_review.txt`、`analysis_report/`），重命名只能动
  `library_attachments` 登记过的路径。
- **审计日志不能驱动撤销**。实测 `literature_audit_log` 的 payload 里
  `moved_to_trash` 是 `{}`、`metadata_updated` 是 `{}`，不存前后值。
  撤销必须新建反向操作日志表。

## 2. M1 — 库整洁度（约 3 天）

### M1.1 附件自动重命名

**现状**：三条独立的写文件路径，各自决定文件名。

| 路径 | 位置 | 当前命名 |
|---|---|---|
| 下载 PDF | `crates/tools/src/literature.rs:10279` | 调用方传入的 `file_name` |
| Zotero 导入 | `crates/tools/src/literature.rs:5712` | `zotero-{source_key}-{原名}` |
| 手动导入附件 | `literature_import_attachment` | 原名 |

**设计**

- runtime 新增 `render_attachment_name(record, template, extension) -> String`：
  - 默认模板 `{creator} - {year} - {title}`，占位符另支持 `{citationKey}`、
    `{venue}`、`{itemType}`。
  - `{creator}` 取首位 author 的姓；缺作者用 `Unknown`；缺年份省略该段与其分隔符。
  - NFKD 归一 → 去掉 Windows 非法字符 `\/:*?"<>|` → 折叠空白 → **标题截断到 80
    字符**。工作区路径本身就深（`C:\Users\…\.config\SomniQ\desktop-workspace\papers\`），
    必须按整条路径长度而不是文件名长度校验 `MAX_PATH`。
  - CJK 标题按字符数而非字节数截断。
- 冲突：同目录已存在 → 追加 ` (2)`、` (3)`；**同一条记录的同一文件视为已就位，不动**。
- 新命令 `literature_rename_attachments(record_ids: Vec<String>, dry_run: bool)`
  → `{ renamed: [{from, to}], skipped: [{path, reason}], conflicts: [...] }`。
  UI 先跑 `dry_run` 出预览表，用户确认后再执行。
- 事务内同时更新 `library_attachments.path` / `filename`，以及兼容投影里的
  `paper.pdf.path` 与 `attachments[].path`，最后刷新投影。
- 下载与导入路径改为统一调用同一个命名函数，新文件一次到位。

**边界**

- `linkMode` 为外部链接 / 外部路径的附件一律不动（我们从不拥有那些文件）。
- 不在 `library_attachments` 里的文件一律不动。
- 重命名后需要让全文索引跟上：`library_attachment_full_text.item_id` 是按
  item 而非路径索引的，确认无需重建；`literature_full_text` 同理。

**验收**：模板渲染（中文标题 / 无作者 / 无年份 / 超长标题）、冲突序号、幂等
（连跑两次第二次全 skipped）、外部链接不动、`dry_run` 不写盘。

### M1.2 Quick Copy

**现状**：`citationEngine.formatBibliography` / `formatCitation` 已经具备；
表格行的 `dragstart` (`Literature.tsx:3207`) 只设了
`application/x-somniq-paper-ids`。

**设计**

- `Ctrl+Shift+C` 复制选中/勾选条目的参考文献条目；`Ctrl+Shift+A` 复制 in-text 引文。
- 剪贴板同时写 `text/plain` 与 `text/html`（期刊名斜体），这样粘进 Word 保留格式。
- `dragstart` 追加 `text/plain` + `text/html`，拖进任意编辑器即成引文；
  原有的内部 payload 保持不变，拖到分类上的行为不受影响。
- 样式沿用 `readCitationStyle()`，在新的文献库设置面板里暴露"Quick Copy 样式"。

**验收**：多选顺序稳定、样式切换生效、拖到分类仍是归类而不是插引文。

### M1.3 报告导出

选中条目 → 生成可打印 HTML（标题、作者、期刊年份、DOI、标签、笔记、
标注摘录），走已有的文件保存通道落盘。纯前端，复用
`formatBibliography` 与现有的笔记/标注读取。

**验收**：空笔记条目不产生空区块；中文排版正常；离线可打开（样式内联）。

### M0 / M1 落地记录（2026-08-30）

实现与本节设计一致，偏差记在这里：

| 决定 | 实现 |
|---|---|
| 偏好存放 | `metadata` 表新键 `library_preferences_v1`（`runtime::LibraryPreferences`），按项目。Rust 侧 `library_preferences()` / `set_library_preferences()`，空模板回落到默认值而不是写出无名文件。 |
| 命名渲染 | `runtime::render_attachment_stem`。占位符 `{creator}` `{year}` `{title}` `{citationKey}` `{venue}` `{itemType}`；标题截断 80 字符、整段 120 字符，**按字符不按字节**（CJK）。 |
| 路径安全 | `sanitize_path_component` 去掉 `\ / : * ? " < > |` 与控制字符。模板里的 `../` 也无法逃逸：分隔符只在两个已渲染的值之间才写出，所以前导字面量直接消失。 |
| 重命名命令 | `library_rename_attachments_at(base, record_ids, dry_run)`；`dry_run` 不碰磁盘也不碰数据库。跳过原因逐条返回（外链、文件缺失、不在 `papers/` 下、路径过长、已按模板命名）。 |
| 两处路径 | 改名要同时改 `library_attachments.path` 与 `canonical_records.metadata.legacyLibrary.pdf.path` / `.attachments[]`，否则阅读器会说 PDF 不存在。 |
| 自动重命名 | 默认关闭。开启后由前端 `downloadPdf` 成功后调用同一条命令，失败只告警不影响已下载的文件。 |
| Quick Copy | `quickCopy.ts`：`Ctrl/Cmd+Shift+C` 参考文献、`+A` 正文引文；剪贴板同时写 `text/plain` 与 `text/html`（期刊名斜体）；拖拽在原有 paper-id payload 之外追加文本 flavour。编号按选中顺序而非全为 `[1]`。 |
| 报告 | `report.ts` 生成自包含 HTML（样式内联、无 `<script>`、无外链），条目内容全部转义。 |

**未做**：`sanitize_file_name`（下载时那条路径）仍把非 ASCII 映射成 `-`，所以新下载的文件仍先落成 `2103.03453.pdf`，再由重命名改名。把命名模板前移到下载那一刻属于 M2 顺带。

## 3. M2 — 拿得到全文（约 5 天）

这一阶段解决的是最狠的问题：**非 OA 文献我们根本下不下来**。
`library_download_pdf_at` 的 URL 来自 OpenAlex `best_oa_location` 与
Semantic Scholar `openAccessPdf`（`literature.rs:8964`、`:9171`），
一旦文献不是 OA，链路直接断，后面的全文检索 / RAG / 证据链全部空转。

### M2.1 OpenURL / 馆藏查找（先做，成本最低）

- 设置项：resolver base（例如 `https://xxx.edu/openurl`）。
- 条目面板加「馆藏查找」按钮，按 OpenURL 1.0 拼 `rft.*` 参数后用系统浏览器打开。
- 纯 URL 拼接 + `shell.open`，不碰下载器。

### M2.2 代理（需要先摸底半小时）

**关键判断**：Zotero 的 `proxy.js` 靠识别 EZProxy 重定向并记住方案，前提是它
跑在浏览器上下文里、天然带着登录态。我们的 `reqwest` blocking client 虽然开了
`cookie_store`，但**没有任何登录会话**，照抄 Zotero 的做法拿不到文件。

我们已经有一条更合适的路：`crates/tools/src/literature.rs` 里有
`builds_sciencedirect_browser_download_task` 一类的 **browser download task**。
正确顺序是：

1. 先摸清现有 browser download task 的能力边界（能否复用已登录的内置浏览器会话、
   能否处理跳转与 Cloudflare）。**这一步没做完不要动手写代理代码。**
2. 若可用：设置里配 `域名 → 代理域名` 映射表，把 browser download task 的目标
   URL 过一遍映射，登录态由内置浏览器承担。
3. 若不可用：退回到「打开浏览器让用户自己下载，再一键关联到条目」的半自动路径，
   也比现在直接失败强。

**不做**：自动嗅探 EZProxy 方案。收益低、误判成本高。

### M2.3 Retraction Watch

- 数据源：Retraction Watch 数据库自 2023 年起以 CC0 授权经 Crossref 发布。
  Zotero 自己托管一份哈希前缀表以避免泄露用户在读什么；我们是本地库，
  可以直接存全量。
- 新表 `literature_retractions(doi PRIMARY KEY, retraction_doi, reason,
  retraction_date, notice_url, updated_at)`，由现有 ScheduledTasks 每周刷新。
- 匹配 `canonical_records` 的 DOI，投影给 paper 加
  `retracted?: { reason, date, noticeUrl }`。
- UI：列表行红色徽章 + 详情页警示条 + 侧栏「已撤稿」特殊视图
  （与 unfiled / duplicates / trash 并列）。
- **联动**：`citation-audit` skill 应把撤稿检测纳入检查项——引用了撤稿论文
  比引用格式错误严重得多。

**验收**：离线可用（本地表）、DOI 大小写与 `https://doi.org/` 前缀归一、
刷新失败不影响库加载。

## 4. M3 — 引文正确性（约 3 天，有授权前置）

现有自研 CSL 解释器缺的是 CSL 1.0.2 的困难部分：

- `<sort>`：参考文献排序与引文排序完全没有
- 消歧：`disambiguate-add-year-suffix` / `-add-givenname` / `-add-names` 没有
- locale 词表：`<label>` 只把 `page` 变成 `"p."`，`term` 直接回显英文词名
- `citation-number` / `collapse` / `ibid` / 脚注样式没有
- 页码范围格式化、`strip-periods`、`et-al-min` 系列未覆盖

**两条路**

- **(a) 引入 citeproc-js**（Zotero 同款）+ 打包 CSL locales + 一批常用样式。
  完备度一步到位。**硬门槛：citeproc-js 是 CPAL/AGPL 双授权，必须先过授权评估。**
  `@citation-js/plugin-csl` 只是它的封装，同样受限。
- **(b) 继续补自研解释器**。约两周，且排序与消歧这类全局性问题很难在
  「一次渲染一条」的现有结构里做对——需要先重构成「一次渲染整个参考文献表」。

**建议**：走 (a)，但授权由你拍板；纯 MIT 的完整 CSL 实现基本不存在。
在授权结论出来之前，M3 只做一件低风险的事：**把 `formatBibliography` 的签名从
「单条」改成「整表」**（`formatBibliography(papers[], style)`），这是 (a) 和 (b)
都需要的前置，且能立刻修掉现在 IEEE/Vancouver 编号靠调用方传 `index` 的脆弱设计。

## 5. M4 — 阅读与笔记（约 5 天，EPUB 后置）

### M4.1 富文本笔记 → 走 Markdown，不引 ProseMirror

**现状**：`note.content` 是纯字符串，编辑器是 `<textarea rows={5}>`
(`Literature.tsx:5449`)。

Zotero 用 ProseMirror。我们不需要：仓库里已有 CodeMirror 6 全家桶、
`@codemirror/lang-markdown`、`katex`、`rehype-katex`、以及自研的 `MathText.tsx`。

- `LiteratureNote` 加 `contentType?: "text" | "markdown"`（缺省 `text`，向后兼容）。
- 编辑器：CM6 + markdown 模式 + 一条小工具栏（粗体/列表/链接/公式）。
- 渲染：复用 `MathText` + rehype-katex。
- **活引文**：`[@citationKey]` 语法，渲染成可点击的条目链接，导出时用
  citationEngine 展开。与 Typeset 的引文插入共用同一套 citation key，
  这是比 Zotero 的 HTML 内嵌引文更适合我们的做法。

拿到 80% 的价值，不新增运行时依赖。

### M4.2 网页快照（先做）

我们已经有内置浏览器和 web-fetch。最小可用：抓成单文件 HTML（资源内联）存进
`papers/attachments/`，用现有的 `LiteratureResourceReader` 展示。

### M4.3 EPUB（后置）

epub 是 zip，`desktop/src-tauri` 已有 `zip` crate；前端渲染需要新依赖 `epub.js`。
**对论文场景价值低，排在快照之后**，除非有明确的读书需求。

## 6. M5 — 安全网（约 6 天）

### M5.1 撤销历史

**审计日志不够用**（见 §1）。需要新表：

```
literature_undo_journal(
  sequence INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,      -- 一次用户操作 = 一个 group
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  inverse_op TEXT NOT NULL,    -- restore_fields | retrash | delete_collection | ...
  payload TEXT NOT NULL,       -- 反向操作所需的前值
  created_at TEXT NOT NULL
)
```

在原事务内与审计一起写，保证「操作成功 = 反向记录存在」。

**范围先划小**：条目字段编辑、删除/恢复、分类增删改、标签增删。
**不含**检索运行、LLM 产物、RAG 索引——那些重放代价过高。

**边界声明**：与 `edit-history-rollback.md` 的 shadow-Git 方案是两件事，
那个管文件内容与对话轮次，这个管库内记录。文档里要写明，避免后来者合并两套。

### M5.2 附件外部变更监听

- 需要新依赖 `notify` crate（当前仓库没有）。
- 只监听 `library_attachments` 登记过的路径；变更时更新 `bytes`/mtime 并
  标记全文索引失效。
- 已有的 `literature_attachment_status` 是拉模式健康检查，这个是推模式补充。
- **优先级最低**：我们的附件绝大多数是下载来的 PDF，很少被外部编辑。

## 7. M6 — RSS 订阅（约 4 天）

- 新表 `literature_feeds(id, url, title, interval_minutes, last_fetched_at)`
  与 `literature_feed_items(id, feed_id, guid, title, link, doi, published_at, read)`。
- 解析可复用 `crates/tools/src/literature.rs` 里已有的 arXiv Atom 解析。
- UI：侧栏新增「订阅」区，与 Collections / Saved searches 并列；
  条目列表复用现有表格；「加入文库」把 feed item 经 DOI → Crossref 补全后
  转成 canonical record。
- `unread` 字段 paper 上已有，feed item 独立计数。

## 8. 明确不做

| 项 | 理由 |
|---|---|
| 同步与群组库 | 我们是单机单用户按项目隔离，这是产品定位差异而非缺陷。Zotero 为此有整个 `xpcom/sync/` 与 `storage/{zfs,webdav}.js`。 |
| Word / LibreOffice / Google Docs 插件 | Typeset/LaTeX 路线已覆盖学术写作主场景。 |
| My Publications | 与我们的使用场景无关。 |
| 浏览器 connector + 748 个 translator | **最大的采集能力鸿沟**，但不是补丁级工作。要不要补是战略选择，单独立项讨论，不放进本计划。 |

## 9. 排期总览

| 阶段 | 内容 | 累计 |
|---|---|---|
| ~~M0~~ | ~~Settings → 集成 → 文献库 面板外壳~~ **已完成** | 0.5 d |
| ~~M1~~ | ~~附件重命名 · Quick Copy · 报告导出~~ **已完成** | 3.5 d |
| M2 | OpenURL · 代理（含摸底） · Retraction Watch | 8.5 d |
| M3 | `formatBibliography` 整表化（+ citeproc 授权决策） | 10 d |
| M4 | Markdown 笔记 · 网页快照（EPUB 后置） | 15 d |
| M5 | 撤销日志 · 附件监听 | 21 d |
| M6 | RSS 订阅 | 25 d |

每个阶段独立可发布，任何一阶段都不阻塞后一阶段之外的东西。
M3 的 citeproc 授权结论若为「不可用」，M3 缩为整表化重构（1 d），
其余排期整体前移。

## 10. 需要你先拍板的三件事

1. **citeproc-js 的 CPAL/AGPL 授权能不能用？** 决定 M3 是 3 天还是 2 周。
2. **代理走 browser download task 还是半自动路径？** 需要先花半小时摸清现有
   browser download task 的能力边界再定。
3. **EPUB 要不要做？** 对论文场景价值低，做与不做差 4 天。

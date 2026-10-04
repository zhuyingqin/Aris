# 论文讲解页面格式模板

文献库“论文讲解”（网页阅读）页面的统一格式。它由三部分组成，三者使用同一套 class 和变量：

| 文件 | 作用 |
| --- | --- |
| [`desktop/src/literature/paperGuideTokens.css`](../../../desktop/src/literature/paperGuideTokens.css) | 设计令牌：颜色、字号、间距、版式尺寸。**改样式只改这里**。 |
| [`desktop/src/literature/PaperGuideView.css`](../../../desktop/src/literature/PaperGuideView.css) | 组件规则：只引用令牌，不写字面字号、间距或颜色。 |
| [`template.html`](template.html) | 静态模板：直接加载应用的同一份 CSS，展示全部版块和状态，并标注每块对应的数据字段。 |

在仓库里直接用浏览器打开 `docs/design/paper-guide/template.html` 即可预览。截图见 [论文导读](screenshots/overview.png)、[主题讲解 · 浅色](screenshots/lesson-light.png)、[数据字段标注](screenshots/data-fields.png)、[状态样例](screenshots/states.png)、[讲解流程图](screenshots/diagram-flow.png)、[实验柱状图与文字版](screenshots/diagram-bars.png)。顶栏可以切换浅色主题、显示数据字段、切换到 420px 窄屏。模板不复制任何讲解样式，所以令牌改动会同时出现在应用和模板中。

## 页面结构

### 页面 A：论文导读

数据来自 `guide.outline.result`，自上而下：

| 顺序 | 版块 | class | 数据字段 | 何时显示 |
| --- | --- | --- | --- | --- |
| 1 | 标题 | `h1` | `run.title` | 总是 |
| 2 | 一句话看懂 | `.paper-essay-one-sentence` | `oneSentence` | v2 讲解；v1 改为显示“研究什么问题”的导语 |
| 3 | 和你的研究有什么关系 | `.paper-essay-relevance` | `relevance` | 仅当项目有进行中的目标且模型给出了有依据的联系 |
| 4 | 一图看懂论文 | `.paper-essay-diagram` | `diagram`（只允许 `kind = flow`） | 模型给出了全景图时 |
| 5 | 论文脉络 | `.paper-essay-rule` + `.paper-essay-overview-section` × 3–4 | `overview[]`（problem / method / evidence / limitations） | 总是；limitations 可选 |
| 6 | 关键术语 | `.paper-essay-glossary` | `glossary[]` | v2 讲解 |
| 7 | 阅读路线 | `.paper-essay-path` | `topics[]` 按 `level` 分组 | 主题带 `level` 时 |
| 8 | 需要留意 | `.paper-essay-cautions` | `cautions[]` | 非空时 |
| 9 | 开始学习 | `.paper-essay-next` | 第一个主题 | 有主题时 |
| 10 | 继续问 | `.paper-essay-ask` | 追问记录（`target = overview`） | 桌面端提供提问入口时 |

左侧目录 `.paper-essay-contents` 按层级分组：打基础 → 核心思想 → 深入细节（`.paper-essay-nav-group`）。每个主题后面的圆点 `.paper-essay-review-dot` 表示审核状态。窄屏下改用 `.paper-essay-mobile-nav` 下拉框。

### 页面 B：主题讲解

显示 `currentLesson(entry)`：有修订稿时用修订稿，否则用初稿。层次顺序固定，不能调换：

| 层 | 版块 | class | 字段 | 入门模式 | 完整模式 |
| --- | --- | --- | --- | --- | --- |
| 01 | 一句话看懂 | `.paper-essay-plain` | `plainSummary` | ✓ | ✓ |
| 02 | 打个比方 | `.paper-essay-analogy` | `analogy`（空则不显示） | ✓ | ✓ |
| 03 | 先补基础 | `.paper-essay-prerequisites` | `prerequisites[]` | ✓ | ✓ |
| — | 先建立直觉 | `.paper-essay-intuition` | `intuition` | ✓ | ✓ |
| — | 看图理解 | `.paper-essay-diagram` | `diagram`（flow 或 bars，空则不显示） | ✓ | ✓ |
| — | 符号与前提 | `.paper-essay-foundations` | `notation`、`assumptions` | | ✓ |
| — | 一步步理解 | `.paper-essay-derivation` | `steps[]`，每步标“原文说明 / 讲解补充” | | ✓ |
| — | 简单例题 | `.paper-essay-example` | `example` | ✓ | ✓ |
| — | 容易想错的地方 | `.paper-essay-misconceptions` | `misconceptions[]` | ✓ | ✓ |
| — | 继续深入 | `.paper-essay-deeper` | — | ✓ | |
| — | 原文支持什么 | `.paper-essay-evidence` | `evidence` + `sourcePages` | | ✓ |
| — | 检查自己是否理解 | `.paper-essay-check` | `checkQuestion`、`checkAnswer` | ✓ | ✓ |
| — | 独立审核 | `.paper-essay-review` | `finalReview(entry)` | 有审核记录时 | 有审核记录时 |
| — | 继续问 | `.paper-essay-ask` | 追问记录（`target = lesson:<i>`） | ✓ | ✓ |

标题区依次为 `h1`（`topic.title`）、`.paper-essay-deck`（`learningGoal`）、`.paper-essay-topic-path`（层级徽标和“先读懂”）、`.paper-essay-sources`（原文页码）。工具条 `.paper-essay-chapter-tools` 包含本节目录、阅读深度切换 `.paper-essay-depth`、保存到笔记和查看原图 `.paper-essay-original`。

v1 讲解（没有 `plainSummary`）不显示阅读深度切换，所有版块按完整模式显示。

### 状态

| 状态 | 元素 | class |
| --- | --- | --- |
| 审核通过 / 修订后复核通过 | 徽标、目录圆点 | `is-pass` |
| 审核发现问题（含修订后仍有问题） | 徽标、目录圆点；审核详情默认展开 | `is-warn` |
| 待审核、正在修订 | 徽标、目录圆点 | `is-pending` |
| 原文不足以核对、未能独立审核 | 徽标、目录圆点 | `is-muted`（基础样式） |
| 旧版讲解 | 元信息行显示“讲解草稿 · 尚未独立审核” | — |
| 主题待生成、生成中、失败 | `.paper-essay-pending`；失败另附折叠的错误详情 | — |

审核状态只能来自独立 Reviewer 的结论，界面不得用执行器自检或任务完成来显示“通过”。

### 讲解图

讲解图是数据，不是模型写的标记：模型只能输出下面两种 JSON，Rust 端（`parse_lesson` / `parse_outline`）校验后才保存，前端再把它画出来，所以不会出现语法错误，也无法注入标记。独立 Reviewer 会核对图中的节点、箭头和数值是否与原文一致。

| 类型 | 用途 | 画法 | 校验 |
| --- | --- | --- | --- |
| `flow` | 流程、结构、数据流、推导链、因果关系 | `flowToMermaid()` 生成 Mermaid 文本，用应用的 Mermaid 主题绘制；节点 id 由前端重新编号，标签中的引号、`#`、`<`、`>`、反引号和 `|` 都转成实体编码 | 2–14 个节点，id 唯一，标签 ≤ 80 字，1–24 条边且两端存在，最多 4 个分组，每个节点最多属于一个分组 |
| `bars` | 实验主题中同一指标下的数字对比 | 纯 HTML 横条，从 0 开始，按最大绝对值等比 | 2–12 条，数值有限；必须标明 `origin`：`paper`（来自原文表格）或 `teaching`（教学构造） |

- 节点角色：`input` / `output` 画成圆角框，`step` 为矩形，`decision` 为菱形，`data` 为圆柱。不使用 Mermaid 的胶囊形，它每个节点会生成几十 KB 的路径数据。
- 每张图下方固定显示来源说明：流程图是“讲解示意图：根据原文整理，不是论文原图”；柱状图写明数值来自原文表格还是教学构造。
- 宽图最多缩小到原始宽度的 85%（`MIN_DIAGRAM_SCALE`），再宽就在图框内横向滚动；`.paper-essay-diagram-canvas` 使用 `contain: inline-size`，不会撑宽正文列。
- 绘制失败时（`.paper-essay-diagram-fallback`）按箭头逐行列出同样的内容，信息不会丢失。
- 保存到笔记时，流程图导出为 ` ```mermaid ` 代码块，柱状图导出为 Markdown 表格。
- 模板中的两张流程图是用应用同版本的 Mermaid 和同一组主题变量预先渲染的 SVG（深色、浅色各一份，坐标保留 1 位小数）。修改 `flowToMermaid()` 或 Mermaid 主题后需要重新生成。

## 设计令牌

所有令牌定义在 `.paper-essay` 上，颜色从应用主题（`styles.css`）派生，浅色与深色自动一致。

| 类别 | 令牌 | 用途 |
| --- | --- | --- |
| 颜色 | `--essay-ink` / `--essay-muted` / `--essay-accent` / `--essay-line` | 正文、次要文字、强调、分隔线 |
| | `--essay-surface` / `--essay-surface-sunken` / `--essay-paper` | 卡片底色、原图框底色、PDF 页面底色 |
| | `--essay-tint-soft` / `--essay-tint` / `--essay-tint-strong` | 类比、例题与公式、一句话看懂的底色（由浅到深） |
| | `--essay-highlight` / `--essay-selected` | 目录当前项、按下的切换按钮 |
| | `--essay-pass` / `--essay-warn` / `--essay-danger` | 审核通过、发现问题、错误；取自主题的 `--green` / `--amber` / `--red` |
| 字号 | `--essay-text-label` 10 / `caption` 11 / `meta` 12 / `compact` 13 / `dense` 14 / `body` 16 / `h3` 16 / `deck` 17 / `lead` 18 / `h2` 20 / `h1` 28–43 | 按角色使用，不按像素挑选 |
| 行高与字距 | `--essay-leading` / `--essay-leading-prose` / `--essay-leading-heading` / `--essay-tracking-label` / `--essay-tracking-wide` | 正文、讲解正文、标题、小标签 |
| 间距 | `--essay-space-1` … `--essay-space-10`（4px 网格：4、8、12、16、20、24、28、32、36、44） | margin、padding、gap |
| 版式 | `--essay-max-width` / `--essay-measure` / `--essay-nav-width` / `--essay-column-gap` / `--essay-number-column` 等 | 两栏布局、正文宽度、编号列 |
| 讲解图 | `--essay-diagram-height` / `--essay-bar-label` / `--essay-bar-height` | 图框最大高度、柱状图标签列宽（窄屏 88px）、柱高 |
| 形状 | `--essay-radius-pill` / `--essay-radius-control` / `--essay-rule` / `--essay-accent-bar` | 胶囊按钮、控件圆角、分隔线、直觉左侧强调线 |

窄屏（容器宽度 ≤ 460px）只调整令牌：`body` 16→15、`deck` 17→15、`lead` 18→16、柱状图标签列 140→88px，组件规则不需要单独改。对照阅读时，容器宽度 ≤ 1040px 提前收起左侧目录、改用章节下拉框，避免目录把正文压窄。

**使用规则**

- 组件规则里只允许 1–3px 的细线、字距、焦点描边偏移和容器查询断点使用字面值；字号、间距和颜色一律使用令牌（`PaperGuideCss.test.ts` 会检查）。
- 按角色选令牌：例如新的小标签用 `--essay-text-label`，不要因为想要 11px 就用 `caption`。
- 新颜色先在令牌文件里定义角色，再在组件中使用。

## 新增或修改版块的步骤

1. 在 `crates/runtime/src/paper_guide.rs` 中增加字段（旧数据用 `#[serde(default)]` 兼容），并在 `parse_outline` / `parse_lesson` 中写校验与长度上限。
2. 在同一文件的提示词中写明该层的写作要求（先浅后深、只简化措辞不简化结论）。
3. 在 `desktop/src/literature/paperReadingApi.ts` 中补充类型，在 `PaperGuideView.tsx`（讲解图在 `PaperGuideDiagram.tsx`）中按上表的顺序插入版块，class 统一以 `paper-essay-` 开头。
4. 样式写入 `PaperGuideView.css`，只用令牌；确实缺少的尺寸或颜色，先在 `paperGuideTokens.css` 中定义角色。
5. 在 `template.html` 中加入该版块的示例和 `data-slot`；如果是条件版块，再加 `data-when`。`PaperGuideCss.test.ts` 会检查模板是否覆盖了视图（`PaperGuideView.tsx` 和 `PaperGuideDiagram.tsx`）中的每个 `paper-essay-*` class，以及模板中是否残留视图已删除的 class。
6. 运行 `npx vitest run src/literature` 和 `npm run build`，并在浏览器中打开模板，检查深色、浅色和窄屏三种效果。

# Word 编辑准确性与可编辑公式方案调研

调研日期：2026-10-08。本文保留修复前的代码检查、只读探针与开源方案建议；后续已落地的修改和验收边界见 [DOCX 编辑准确性](docx-editing-accuracy.md)。下文探针结果不是当前修复后的状态。

## 当前实现与实际发现

仓库内置的专利技能使用 `python-docx` 生成 DOCX。`skills/patent-disclosure/tools/md_to_docx.py` 和申请文件同类脚本优先调用 `math_to_omml.py`：LaTeX 经 `latex2mathml` 转成 MathML，再由项目自己的映射器生成 `m:oMath` / `m:oMathPara`。这类对象是 Word 原生公式，可以通过 Word 公式编辑器修改。转换失败时脚本记录失败数量并保留 LaTeX 原文；有预渲染图片或启用图片模式时也可能输出 PNG。原文和 PNG 不等价于可编辑的原生公式。

这只是已检查的内置导出路径，不能推出所有 Chat 生成的 Word 文档都采用它，也不能用公式节点存在证明公式内容正确。前端声明了 MathLive 依赖，但当前 `.ts/.tsx` 检索没有发现已接通的 DOCX 编辑界面。当前 Typeset 主要处理 LaTeX 与 PDF。

使用 Codex 捆绑 Python / python-docx 执行内存探针，没有打开或修改用户 Word 文件，没有创建 DOCX，得到：

| 探针 | 当前结果 | 影响 |
| --- | --- | --- |
| 规范化 `\left(x\right)` | `\leqft(x)` | 对 `\le` 的前缀替换误伤其他命令 |
| 规范化 `x\leq y` | `x\leqq y` | 已正确的命令被再次改写 |
| 规范化 `x\geq y` | `x\geqq y` | 同上，存在数学符号含义或转换结果变化风险 |
| MathML 的 `<mover accent="true">` | 输出 `m:sSup`，没有 `m:acc` | 顶部重音被当成普通上标，结构不保真 |
| 含 OMML 的段落使用 `paragraph.text = ...` | OMML 节点从 1 个变成 0 个 | 整段赋值会删去公式等非普通文本内容 |

前四项对应 `crates/runtime/assets/skills/patent-disclosure-skill/skills/patent-disclosure/tools/math_to_omml.py` 的命令规范化和自制映射器。最后一项是 python-docx API 的行为；不是断言项目当前所有编辑都使用这种赋值方式。[python-docx 官方文档](https://python-docx.readthedocs.io/en/latest/api/text.html#docx.text.paragraph.Paragraph.text)也说明，设置段落 text 会将已有内容替换为单个 run，并移除 run 层格式。

捆绑 Python 没有 `latex2mathml` 或 Pandoc，因此本次没有验证完整 LaTeX 转 DOCX 链路。不能把此环境的依赖状态推定为 SomniQ 用户运行环境的状态。没有进行 Word/LibreOffice 打开、编辑、保存、重开与页面渲染验收。

## 原生公式与页面保真

Word 在文档中使用 OMML 保存原生数学公式，见 [Microsoft 数学格式说明](https://learn.microsoft.com/en-us/office/math/)。需要区分：

- 可编辑性：目标 DOCX 中是 OMML 结构，能够选中公式并修改。
- 转换保真：原 LaTeX 的分式、上下标、重音、矩阵、分段、积分和求和等结构被正确转换。
- 数学正确性：公式本身是否符合推导和证据，仍需独立审查。
- 文档保真：修改正文后，原公式、样式、表格、图片、链接、脚注和分页是否保留。

本项目适用的验收建议是：要求可编辑时，任何公式退回图片或普通 LaTeX 都使该要求未通过；记录失败式子并保留原稿。转换成功也需要检查结构、渲染和目标编辑器保存后的结果。

## 查到的开源方案

| 方案 | 主要用途 | 与 SomniQ 的关系与边界 |
| --- | --- | --- |
| [Pandoc](https://pandoc.org/MANUAL.html#math) | Markdown/LaTeX 数学转 DOCX | 官方明确 DOCX 输出使用 OMML；适合新文档导出。结合 reference DOCX 管理样式。转换已有 DOCX 不能自动保证原布局和所有对象往返保真，不用于任意文档的整体重建式修改。 |
| [docx.js 数学模块](https://docx.js.org/api/modules/math.html) | JS/TS 中创建 Word 原生公式和文档 | 有分式、积分、脚标、矩阵等结构；适合 React/Tauri 的类型化生成，MIT 许可。它需要构造公式对象，不能将其视为自动支持任意 LaTeX 的解析器。[patchDocument](https://docx.js.org/api/functions/patchDocument.html)主要是模板占位符替换，不等同于完整 Word 编辑器。 |
| [Open XML SDK](https://github.com/dotnet/Open-XML-SDK) | 修改已有 DOCX 的 XML 对象与包结构 | Microsoft 维护，MIT 许可，强类型 OOXML API；适合定位指定段落、run、公式及修订对象后做局部修改。需要额外 .NET 运行层或独立工具，且 API 本身不能证明显示或语义准确。 |
| [MathLive](https://github.com/arnog/mathlive) | 应用内交互式公式编辑 | MIT 许可，可编辑并导出 LaTeX/MathML；可用于 SomniQ 公式输入。它不是 DOCX 文档编辑器，也不直接解决 Word 保存；要连接 OMML 转换与文档写入层。 |
| [ONLYOFFICE Docs](https://github.com/ONLYOFFICE/DocumentServer) | 完整 DOCX 的可视化编辑 | 可集成文档编辑器；[官方公式说明](https://helpcenter.onlyoffice.com/docs/userguides/document_editor/InsertEquation.aspx)支持公式修改、LaTeX/Unicode 和线性/专业显示。社区代码为 AGPL-3.0；需配置文档服务及保存集成，部署体积和运维成本更高。 |
| [Collabora Online](https://www.collaboraonline.com/faqs/) | 完整 Office 编辑器的另一种集成 | 官方说明通过 WOPI 集成，代码主要为 MPLv2。需要运行服务和文件读写协议；DOCX/OMML 往返效果仍要以本项目样本验证。[许可证说明](https://www.collaboraonline.com/terms/collabora-online-mplv2/)区分源码与可执行分发条件。 |

补充：SuperDoc 的开放代码使用 [AGPLv3](https://docs.superdoc.dev/resources/license/)，但当前另有 [DOCX Engine 专有许可证](https://docs.superdoc.dev/resources/docx-engine-license/)。因此本次没有将其推荐为整条文档引擎均可自由使用的纯开源替代；这是基于其公开许可材料的选型判断。

## 选型建议

建议先建立本地可验证的生成与局部编辑能力：新文档以 Pandoc 输出 OMML；已有文档使用 Open XML SDK 局部修改。公式输入界面采用 MathLive，保留原始 LaTeX，并将失败式子交给用户和独立 Reviewer 检查。docx.js 可作为需要纯 TypeScript 生成时的备选，先用复杂公式样本验证覆盖率。以上是调研建议，未安装或接入这些新组件。

已有文档的修改应先取得版本/hash，用稳定定位、上下文和唯一匹配确认目标，再修改限定的文本 run 或完整公式节点，避免整段 text 赋值和对整个 ZIP/XML 做字符串替换。保存新副本后，检查结构差异与受保护对象，运行格式验证，再渲染比较。针对 Word 交付还要在目标 Word 版本里打开、修改公式、保存、重开。

只有需要在 SomniQ 内编辑整份 Word 文档时，再引入 ONLYOFFICE 或 Collabora。基础验收样本应包含中文与混合格式、跨 run 匹配、表格内公式、同词重复、书签与引用、上下标、积分求和、重音、矩阵、分段函数、伸缩括号和对齐公式；不得在没有基准集和实测结果时给出准确率百分比。

# DOCX 开源方案核查与复用决策

核查日期：2026-11-10（本地）。这是 [DOCX 格式编排优化方案](docx-layout-improvement-plan.md) 的选型依据。源码核查已完成，共享 runtime/tools/Chat 的初版已接入；具体实现与运行边界见 [真实请求验收](docx-user-acceptance.md)。

建议以 **Pandoc + reference.docx 生成、python-docx 受控格式修改、LibreOffice 分页和导出、现有 PDF.js 预览** 为默认组合。固定表单按需使用 docxtpl；需要完整科学出版能力时直接评估 Quarto。SomniQ 负责接入、版本、审计和独立审查，文档转换与分页采用已有引擎。

## 已有产品确实采用的做法

### Quarto：在 Pandoc 基础上完成科学出版

[Quarto README][quarto-readme] 明确说明它是建立在 Pandoc 上的科学与技术出版系统，并在此基础上加入交叉引用、子图和布局等能力。[DOCX 格式入口][quarto-format]、[DOCX 布局 filter][quarto-layout] 和 [DOCX 渲染测试][quarto-test] 都有实际代码。

这支持 SomniQ 直接采用 Pandoc 作为生成引擎。它不能证明任意 Word 文档可以无损转换，也不能证明 SomniQ 的独立审查已完成；上游出版能力与本产品审查循环分别验收。

Pandoc [reference-doc 说明][pandoc-reference] 规定：参考 DOCX 的样式、页边距、页面尺寸、页眉和页脚用于新文件，参考文件正文被忽略。其 [DOCX writer][pandoc-writer] 和 [自定义样式测试][pandoc-tests] 有对应实现。数学公式经 [TeXMath 的 writeOMML][pandoc-math] 输出原生 OMML，而非要求 SomniQ 自己实现通用公式转换器。

### docxtpl：先设计 Word 模板，再填内容

[docxtpl README][docxtpl-readme] 明确组合 python-docx 与 Jinja2：先在 Word 中设计 DOCX 并插入占位标签，再用数据生成文档。模板正文会保留，适合机构表单、固定封面和固定表格；它与 Pandoc 的“样式参考文件”用途不同。

沿用其 [模板限制][docxtpl-rules]：普通标签不能跨 run/段落，结构控制使用专用标签；[RichText 会移除原字符样式][docxtpl-richtext]，需显式指定；[渲染应启用适当转义][docxtpl-escape]。不能把“基于模板”解释成无条件保留任何复杂文档。

### Gotenberg：转换依赖 LibreOffice，并用真实文档回归

[Gotenberg][gotenberg-readme] 是容器化的 PDF API，Office 转换交给 LibreOffice。核查版本的 [进程实现][gotenberg-process] 使用受管的长驻 LibreOfficeKit helper，包含独立 profile、启动就绪、故障重启与取消后回收自有进程；不是旧版 UNO/unoconv 路径。

其 [真实文档 corpus][gotenberg-corpus] 明确区分“简单路由返回成功”与“真实文档输出正确”，记录页面尺寸、页数、文本标记等事实，并在引擎和字体变化时检查回归。

SomniQ 直接复用 LibreOffice 排版引擎，并参考上述生命周期和 corpus 方法。Windows 本地 CLI 适配仍需运行验证；Gotenberg 容器实现不能直接等同为 Windows 实现。默认本地处理，不要求 Docker 或远程文档服务。

### 自动目录沿用 LibreOffice 的原生索引接口

2026-11-11 另行下载并核对同一固定提交的三个官方接口文件：[ContentIndex](https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/offapi/com/sun/star/text/ContentIndex.idl) 明确定义按标题创建目录的 `CreateFromOutline` 和深度 `Level`；[XDocumentIndexesSupplier](https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/offapi/com/sun/star/text/XDocumentIndexesSupplier.idl) 提供文档索引集合；[XDocumentIndex](https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/offapi/com/sun/star/text/XDocumentIndex.idl) 保留 `update()` 更新接口，并建议可用时采用 XRefreshable。下载状态均为200，原文及哈希留在本地验收证据。

目录适配器调用独立无界面 LibreOffice 的 UNO 索引服务计算目录项和页码，只取回结果，最终候选仍保留原包中未修改的部件和正文节点。目录缓存放进原生 TOC 字段，后续标题变化仍由编辑器更新。这是对现有索引和分页引擎的接入；Gotenberg 的 LibreOfficeKit helper 与本适配器的 UNO 接口各自记录，不混称为同一实现。Word/WPS 的更新及分页仍须实测。

## 组件职责、边界与许可证

| 组件 | 已核实的能力与使用决定 | 关键边界 | 项目许可依据 |
| --- | --- | --- | --- |
| Pandoc | 默认生成新 DOCX；复用 Markdown/AST、reference.docx、OMML 和表格 writer | [上游明确转换可能有损][pandoc-lossy]；不整体重建用户已有的任意 DOCX；复杂 TeX、表格和中文字体仍需样本验证 | [GPL-2.0-or-later][pandoc-license] |
| Quarto | 科学出版复用先例；交叉引用等需求增加时可采用其现成渲染入口 | 可选后端，避免与独立 Pandoc 工具链重复打包；不任意拆抄内部 filters | [本体 MIT][quarto-license]，捆绑组件分别核对 |
| python-docx | 已有依赖；[样式][python-styles]、[缩进/行距/同页/孤行控制][python-parfmt]、[列宽/autofit][python-table] 用公开 API 适配 | 不计算分页；保存可能重新序列化 XML；中西文字体映射、表头重复等不能假定都有公开 API；保留现有 Rust 精确文字编辑 | [MIT][python-license] |
| odfpy 1.4.1 | 已接入既有 ODT 的读取验证与文字高亮属性；保持 ODT，不经 DOCX 往返 | 只修改 content.xml/styles.xml 的文字背景属性，其余包部件保留；不计算分页 | 已核对 `odf/style.py` 的 LGPL-2.1-or-later 源码许可声明，[官方项目](https://github.com/eea/odfpy) |
| docxtpl | 固定 DOCX 表单中填充数据、条件和循环；只在该场景启用 | 模板标签、RichText 和转义有明确限制；不作为任意 Word 文件的通用编辑器 | [LGPL-2.1 许可文本][docxtpl-license] |
| LibreOffice | 本地分页、DOCX→PDF、旧 .doc 副本转换；[源码支持 headless/convert-to][lo-cli] | 其结果只代表该软件与字体环境；不能据此保证 Word/WPS 页数一致 | [MPL-2.0][lo-license]；[源文件同时保留其他许可声明][lo-notice]，发行包按实际第三方清单核对 |
| Gotenberg | 可选的已有本地服务接入；进程管理和真实文档回归的实现参考 | 默认不引入容器服务；其 MIT 不覆盖 LibreOffice 等依赖的许可证 | [MIT][gotenberg-license] |
| Open XML SDK | 首先作为开发/发布结构校验器；[OpenXmlValidator][sdk-validator] 验证包、部件和元素 | [上游定位是底层 typed OOXML API][sdk-readme]，不提供完整排版抽象；不渲染或计算分页；复杂修改按缺口评估 | [MIT][sdk-license] |
| docx4j | 成熟的创建、编辑、模板/数据绑定路线，作为需要 Java 技术栈时的替代 | [需要 Java/JAXB][docx4j-readme]；首版不与 Python、.NET 并列叠加 | [Apache-2.0][docx4j-readme] |
| docx-preview（docxjs） | 可选的浏览器快速内容预览 | [受 HTML 能力限制][preview-readme]；[没有实时重分页][preview-breaks]，不承担最终页面验收；与另一个生成库 docx.js 不同 | [Apache-2.0][preview-license] |

许可证列按核查源码记录，不将 GitHub 自动识别结果代替实际许可证。分发固定版本时保留上游许可证、版权与所需源码/变更说明，记录依赖清单；外部 CLI 调用不是忽略分发义务的理由。

## SomniQ 需要做的接入

1. 用固定版本的 Pandoc 调用替换新文档主路径中的手写 Markdown 解析和通用 LaTeX→OMML 转换；模板使用上游认可的 reference.docx 机制。领域脚本保留业务规则，通过回归后逐步迁移。
2. 常见格式操作映射到 python-docx 的现成 API。缺少稳定上游接口的属性明确列出，优先模板固化或成熟 SDK 操作；不另起通用 OOXML 修改框架。
3. 保留现有 `read_docx`/`edit_docx` 的文字编辑、版本检查、保护对象、审计与原字节撤销能力。格式修改在候选副本执行，额外验证内容、关系、公式和复杂对象。
4. LibreOffice 负责分页；现有 PDF.js 负责 PDF 页面显示。SomniQ 只管理任务目录、profile、进程、字体/版本记录和最终文件证据。
5. 接入独立 Reviewer 的只读图片证据能力，记录页面覆盖与候选文件哈希。当前 Reviewer 只读文本且拒绝二进制，不能提前宣称已具备视觉验收。

## 核查证据与尚未验证事项

本次读取官方仓库的文档、实际实现、测试和许可证，共缓存 48 个源文件。所有下列源码链接固定到核查提交，不依赖默认分支未来变化；这不是建议把开发分支 HEAD 直接作为发行依赖。实施时另选固定发行版本并复核差异。

本地证据目录为 `.somniq/research/docx-layout-upstream-20261110/`，`sources.json` 保存每项仓库、提交、源文件路径、URL、下载结果和 SHA-256。该缓存是本地调研证据；下列永久链接才是本文可随仓库审查的上游依据。

后续已在项目私有运行时目录中部署 Pandoc 3.13 和 LibreOffice 26.8.2，并通过生产原生工具执行模板、公式、格式修改和分页检查；没有改动系统 Office 安装。Pandoc CLI 保持沙箱，本地图片按其 AST 作为嵌入资源传入；没有另写 Markdown 或公式解析器。选定组件的源码核查与本机运行证据分别记录。

2026-11-11 补充实施：字符范围、斜体筛选、下标、删除线、颜色、制表位，以及表格、图片、换行和空白页均复用 python-docx 的字体、段落、表格和图片 API。原生 PAGE/REF 字段、书签和缺失表格样式时的边框使用限定的 OOXML 适配；不实现通用编辑器或分页器。ODT 去高亮复用 odfpy 1.4.1 的读取验证及属性命名空间，针对继承样式修改文字背景属性，其他 ZIP 部件原字节保留。已核对本机安装发行包的元数据、源码及源码许可声明；此项补充不属于上文 48 个固定提交源码缓存。

已接入 [Open XML SDK 3.3.0 校验器](../../tools/docx/validate/Program.cs)，只读检查候选与原输入，区分原有错误和新增错误。结构、原生字段、渲染与目标编辑器行为分别验收；校验器不能证明版面或 WPS 兼容。

客户原始附件、修复后的 Word/WPS 打开、修改、保存、重开、视觉 Reviewer 和全部领域文档脚本迁移仍未完成。旧候选在 WPS 导出时曾复现白尾页，详见 [WPS 兼容性记录](docx-wps-compatibility.md)。不能将本机公开语料或衍生样本结果推广为这些工作的完成证明。

[quarto-readme]: https://github.com/quarto-dev/quarto-cli/blob/ac310a4246d60a1d195d4e7510823f7e9630f199/README.md#L10
[quarto-format]: https://github.com/quarto-dev/quarto-cli/blob/ac310a4246d60a1d195d4e7510823f7e9630f199/src/format/docx/format-docx.ts#L20
[quarto-layout]: https://github.com/quarto-dev/quarto-cli/blob/ac310a4246d60a1d195d4e7510823f7e9630f199/src/resources/filters/layout/docx.lua#L4
[quarto-test]: https://github.com/quarto-dev/quarto-cli/blob/ac310a4246d60a1d195d4e7510823f7e9630f199/tests/smoke/render/render-docx.test.ts#L13
[quarto-license]: https://github.com/quarto-dev/quarto-cli/blob/ac310a4246d60a1d195d4e7510823f7e9630f199/COPYING.md
[pandoc-reference]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/MANUAL.txt#L1341
[pandoc-writer]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/src/Text/Pandoc/Writers/Docx.hs#L88
[pandoc-tests]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/test/Tests/Writers/Docx.hs#L254
[pandoc-math]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/src/Text/Pandoc/Writers/Docx/OpenXML.hs#L1058
[pandoc-lossy]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/README.md#L270
[pandoc-license]: https://github.com/jgm/pandoc/blob/a78ad45a7b4e71048cee3e7799450d9f5f03837b/README.md#L300
[docxtpl-readme]: https://github.com/elapouya/python-docx-template/blob/1f143fbe86c19ecb28c3205d5f4b1547c7e2d7ad/README.rst#L10
[docxtpl-rules]: https://github.com/elapouya/python-docx-template/blob/1f143fbe86c19ecb28c3205d5f4b1547c7e2d7ad/docs/index.rst#L51
[docxtpl-richtext]: https://github.com/elapouya/python-docx-template/blob/1f143fbe86c19ecb28c3205d5f4b1547c7e2d7ad/docs/index.rst#L227
[docxtpl-escape]: https://github.com/elapouya/python-docx-template/blob/1f143fbe86c19ecb28c3205d5f4b1547c7e2d7ad/docs/index.rst#L318
[docxtpl-license]: https://github.com/elapouya/python-docx-template/blob/1f143fbe86c19ecb28c3205d5f4b1547c7e2d7ad/LICENSE.txt
[python-styles]: https://github.com/python-openxml/python-docx/blob/e45454602b53e8e572b179ccf1c91093ec9f4ed7/docs/user/styles-using.rst
[python-parfmt]: https://github.com/python-openxml/python-docx/blob/e45454602b53e8e572b179ccf1c91093ec9f4ed7/src/docx/text/parfmt.py#L31
[python-table]: https://github.com/python-openxml/python-docx/blob/e45454602b53e8e572b179ccf1c91093ec9f4ed7/src/docx/table.py#L72
[python-license]: https://github.com/python-openxml/python-docx/blob/e45454602b53e8e572b179ccf1c91093ec9f4ed7/LICENSE
[gotenberg-readme]: https://github.com/gotenberg/gotenberg/blob/0b8d2e167db7355101fa02d6f398de95d8f5544b/README.md#L22
[gotenberg-process]: https://github.com/gotenberg/gotenberg/blob/0b8d2e167db7355101fa02d6f398de95d8f5544b/pkg/modules/libreoffice/api/libreoffice.go#L348
[gotenberg-corpus]: https://github.com/gotenberg/gotenberg/blob/0b8d2e167db7355101fa02d6f398de95d8f5544b/test/corpus/README.md#L5
[gotenberg-license]: https://github.com/gotenberg/gotenberg/blob/0b8d2e167db7355101fa02d6f398de95d8f5544b/LICENSE
[lo-cli]: https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/desktop/source/app/cmdlineargs.cxx#L559
[lo-license]: https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/COPYING.MPL
[lo-notice]: https://github.com/LibreOffice/core/blob/e42678e74a8b43e143a395e3fe08a9e2a923f0f9/desktop/source/app/cmdlineargs.cxx#L3
[sdk-readme]: https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/README.md#L17
[sdk-validator]: https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/src/DocumentFormat.OpenXml.Framework/Validation/OpenXmlValidator.cs#L77
[sdk-license]: https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/LICENSE
[docx4j-readme]: https://github.com/plutext/docx4j/blob/c0a66b6100bb49d93dd0de005f7cdfd3784897ed/README.md#L8
[preview-readme]: https://github.com/VolodymyrBaydalka/docxjs/blob/c533f383069008d4a1e05c6171ef8777fd078385/README.md#L9
[preview-breaks]: https://github.com/VolodymyrBaydalka/docxjs/blob/c533f383069008d4a1e05c6171ef8777fd078385/README.md#L94
[preview-license]: https://github.com/VolodymyrBaydalka/docxjs/blob/c533f383069008d4a1e05c6171ef8777fd078385/LICENSE

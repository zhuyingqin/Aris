# 公开 Word 任务验收

核查日期：2026-11-11。原 13 项原生操作缺口已补齐，并在各自公开文件上通过生产工具检查及 Executor 的 PDF 逐页检查。全部 23 项任务中，21 项文件处理任务通过，2 项为实时协作与编辑器全局设置，未纳入文件能力通过数。最终候选共 59 页，全部查看；46 份原始资产哈希未变。

结果仅覆盖本机 LibreOffice 和明确参数的原生工具路径。任务参数由操作人员根据公开要求及实际文件制定，光标要求使用显式段落/字符锚点；没有执行完整模型对话或 OSWorld 虚拟机测试，也未完成独立视觉 Reviewer 或修复后 Word/WPS 保存重开。各项来自 run-2、run-3、run-4、run-6，机器清单逐项绑定真实执行版本，不能称为同一最终二进制的全量重跑。

WPS 旧候选曾导出纯白第 4 页；本轮压缩空段落及段落标记后，LibreOffice 字体案例为 3 页。新候选尚无 WPS 导出证据，兼容性仍未确认，详见 [WPS 兼容性记录](docx-wps-compatibility.md)。本分支功能尚未构建发布安装包。

## 来源和固定版本

- [OSWorld Writer 全部任务](https://github.com/xlang-ai/OSWorld/tree/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer)，提交 `9466ba2c7e19ad6dea076ad9cf27a2eca6f11336`，Apache-2.0；23 项全部纳入。
- [公开文件数据集](https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/tree/1e112283c4ecb08d6fed8069bca7de74fa2f12aa/libreoffice_writer)，提交 `1e112283c4ecb08d6fed8069bca7de74fa2f12aa`，声明 apache-2.0；主输入为 22 个 DOCX、1 个 ODT，连同参考与图片共 46 份资产。
- [上游评分源码](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/desktop_env/evaluators/metrics/docs.py)。只调用审阅过且实际需要的函数；额外按任务要求检查字符范围、原生域、书签、页脚位置和空白页。原 `compare_pdfs` 未执行，PDF 导出采用页数、逐页去空白文字及页面观察。

[逐项机器清单](docx-public-acceptance.json) 保存任务永久链接、资产哈希、工具断言、每项执行版本和页面哈希。第三方文档正文及原客户日志不进入仓库。下载脚本曾在另一目录重建全部资产，46 份哈希一致。

## 全部任务结果

“通过”表示工具自动断言与 Executor 页图检查通过；不等于独立 Reviewer 或目标编辑器批准。

| 公开任务 | 结果 | 已看页数 | 执行版本 | 观察与边界 |
| --- | --- | ---: | --- | --- |
| [前两段双倍行距](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/0810415c-bde4-4443-9047-d5f70165a697.json) | 通过 | 4 | run-2 | 首两段双倍行距可见；后续列表、斜体和标题保留；四页无新增裁切、重叠或空白页。 |
| [制表位左右对齐](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/0a0faba3-5580-44df-965d-f562a99b291c.json) | 通过 | 1 | run-3 | 十行均以前三个词左对齐，原生制表位之后的内容右对齐；文字保留，单页无裁切。 |
| [H2O 数字下标](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/0b17a146-2934-46c7-8727-73ff6b6483e8.json) | 通过 | 1 | run-2 | H₂O 的 2 下降为下标，H/O 与其他正文样式保留；一页无裁切。 |
| [每页左下角页码](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/0e47de2a-32e0-456c-a366-8c607ef7a9d2.json) | 通过 | 9 | run-3 | 九页每页左下角依次显示1至9；封面、正文、截图和超链接保留，页脚与正文无重叠，无空白页。 |
| [全文 Times New Roman](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/0e763496-b6bb-4508-a427-fad0b6c3e195.json) | 通过 | 3 | run-2 | 全文字体及表格可读，最终三页无空白尾页；既有窄年份列仍使 1868-9、1939-1945、Today 换行，此项未修改列宽。 |
| [标题居中](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/3ef2b351-8a84-4ff2-8724-d86eae9b842e.json) | 通过 | 2 | run-2 | 标题居中可见，正文三列结构与两页内容保留；未见裁切或重叠。 |
| [同名 PDF 导出](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/4bcb1253-a636-4df4-8cb0-a35c04dfef31.json) | 通过 | 5 | run-2 | 五页均保留 UCPath 页眉、截图和步骤表格，页脚和边界可读；同名 PDF 交付未见缺图、裁切或多余白页。 |
| [插入 7 列 5 行空表](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/66399b0d-8fda-4618-95c4-bfc6191617e9.json) | 通过 | 2 | run-4 | 明确压缩三个末尾空段后，新增5×7空表紧接原表，完整显示在第二页，未跨页；原表内容/窄列换行保持，第一页面说明保留。 |
| [删除 ODT 高亮](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/6a33f9b9-0a56-4844-9c3f-96ec3ffb3ba2.json) | 通过 | 2 | run-2 | 招募电话脚本两页所有黄色高亮消除；粗体、斜体、超链接及正文保持可读，无裁切或空白页。 |
| [在光标处插入图片](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/6ada715d-3aae-4a32-a6a7-429b2e43fb93.json) | 通过 | 3 | run-2 | 指定PNG位于Figure 1之前，三页正文、原图和说明保留。提供的PNG本身在BIOL420底部截断，候选忠实保留该输入内容；未见新增图片裁切或文字重叠。 |
| [列车记录按编号去重](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/6f81754e-285d-4ce0-b59e-af7edb02d108.json) | 通过 | 1 | run-2 | 八条唯一列车记录顺序保留，无重复残留空段造成的白尾页。 |
| [末段添加删除线](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/72b810ef-4156-4d09-8f08-a0cf57e7cefe.json) | 通过 | 1 | run-2 | 仅最后正文段落显示删除线，前两段正常；一页无裁切、溢出或空白尾页。 |
| [词表按元音分类着色](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/8472fece-c7dd-4241-8d65-9b3cd1a0b568.json) | 通过 | 1 | run-2 | 52个词在原表格内显示元音首字母红色、其他蓝色，标题正文未着色；单页布局无裁切。 |
| [每句后加入空行](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/88fe4b2d-3040-4c70-9a70-546a47764b48.json) | 通过 | 3 | run-6 | 首段七句各自后有空行，三页原文字、表格及列表保留，无新增裁切、丢字或白尾页。加空行使原表重新分页，第3条最后一行在第2页续排；保留原表允许拆行的设置。 |
| [逗号文本转换为表格](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/936321ce-5236-426a-9a20-e0e3c5dc536f.json) | 通过 | 4 | run-2 | 首页逗号文本转为5×4原生表格，文字完整可读；后续三页原彩色音标表、页眉和图标保留，无新增裁切或空白页。 |
| [文献及原生交叉引用](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/adf5e2c3-64c7-4644-b7b6-d2f0167927e7.json) | 通过 | 4 | run-4 | 第2页原生REF显示14，第4页新增条目编号为[14]且Arial字体与原列表一致；原文、旧引用/超链接和页脚保留，四页无引用错误、裁切或空白尾页。 |
| [三段不同倍数行距和 12 磅字](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/b21acd93-60fd-4127-8a43-2f5178f4a830.json) | 通过 | 1 | run-2 | 三段依次为单倍、双倍及1.5倍，文字大小一致；单页无裁切或空白尾页。 |
| [团队实时协作](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/bb8ccc78-479f-4a2f-a71e-d565e439436b.json) | 范围外 | — | run-2 | 上游自身标记 infeasible；未进行任何分享或外部上传。 |
| [全文转小写](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/d53ff5ee-3b1a-431e-b2be-30ed2673079b.json) | 通过 | 1 | run-2 | 正文及表格文字转为小写；表格与原排版保留，一页无裁切。 |
| [仅斜体词改 14 磅](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/e246f6d8-78d7-44ac-b668-fcf47946cb50.json) | 通过 | 2 | run-2 | 仅斜体内容放大到14pt，普通正文12pt、题目和列表保留。两页无内容丢失或白尾页；原文已有英文词内换行，字体变化后换行位置随之改变，未擅自修改其语言/兼容设置。 |
| [逐词首字母大写](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/e528b65e-1107-4b8c-8988-490e4fece599.json) | 通过 | 1 | run-2 | 每词首字母大写，书名斜体和页眉保留；全文一页无溢出、裁切或空白尾页。 |
| [插入空白页](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/ecc2413d-8a48-416e-a3a2-d30106ca36cb.json) | 通过 | 8 | run-6 | 封面标题、版权及完整免责声明保持在第1页，第2页为纯白；第3至5页声明正文/表格，第6至8页原EXHIBIT A/B/C均保留，无新增裁切或重叠。原表在第4/5页的跨页行和末页原项目符号保持；移除新增空白段后，原XML节点经规范化比较一致，其他包部件原字节不变。 |
| [编辑器默认字体](https://github.com/xlang-ai/OSWorld/blob/9466ba2c7e19ad6dea076ad9cf27a2eca6f11336/evaluation_examples/examples/libreoffice_writer/f178a4a9-d090-4b56-bc4c-4b72a61a035d.json) | 范围外 | — | run-2 | 要求更改编辑器全局配置，不是文件字体；本轮只读，不修改系统设置。 |

此前一轮为 8 项通过、13 项能力缺口、2 项范围外；本轮为 21 项通过、0 项原生能力缺口、2 项范围外。历史结果保留在证据目录和报告快照中，未被覆盖。此分布包含协作和设置请求，不换算为通用文档成功率。

## 修复方式和保留约束

字符格式使用 python-docx 1.2.0 的字体 API，增加 Unicode 范围及 `expected_text`，支持仅斜体、上下标、删除线和 RGB；拆分文字保留原有 run 属性。新片段仅去重值完全相同的重复字号属性，冲突值拒绝，不修改原输入节点。

`edit_docx_structure` 使用上游的制表位、换行、分页、表格、图片和页脚 API。补充小范围 OOXML 适配生成 PAGE、编号、书签与原生 REF 字段；未新增分页引擎或通用文档模型。新文献继承原列表字体。空白页使用独立的空段落、段前分页和原生分页符，保留封面完整文字。ODT 高亮使用 odfpy 1.4.1 的样式模型处理，保持 ODT 格式及其他包部件。

结构保存只发布目标操作确需修改的部件，其他 ZIP 部件保留原字节；新增部件才补相应内容类型声明。现有非目标字段、公式和资源受保留断言约束。字符范围跨对象、域、书签或超链接等边界时明确拒绝。所有修改继续走版本检查、候选发布、审计和可撤销路径；公开结构/字符案例及工程回归实际验证原字节恢复。

空段落压缩还设置段落标记的 1pt 字号、精确行距和禁用网格，避免只缩 run 后段落标记仍占一行；不删除原文字。已存在的窄列折行、允许拆行表格及输入图片自身裁切在表中保留说明，未擅自改变原内容以获取更好分数。

复用依据见 [开源方案核查](docx-open-source-selection.md)。Pandoc 负责新文档与原生公式，LibreOffice 负责真实分页；Open XML SDK 3.3.0 用于开发验收。

## 校验与回归

最终 19 份 DOCX 候选经 Open XML SDK Office2019 schema 与各自原输入比较，新增错误为 0；部分公开原文件已有错误，未声称整批 schema 无错。结构校验不能替代页面或 WPS 验收。

Python 适配器/结构/请求来源共 16 项测试通过；`cargo test --workspace -- --test-threads=1` 为 1614 通过、7 忽略、0 失败。Windows 批量写入测试先前释放锁过早，与最后一次版本检查产生时序竞争；本轮保持测试锁直到写线程返回，生产批量写入逻辑及原断言不变，修复后全仓重验。

后台请求衍生和工程回归 9 组全部通过，6 张最终页图已查看，详见 [真实请求衍生验收](docx-user-acceptance.md)。原客户附件不可得，不是原文件重放，也不能据此宣称 8 类客户需求全通过。无 UI/Tauri API 修改，无前端构建。独立 Reviewer、目标编辑器、旧二进制 `.doc` 和完整模型规划仍未验证。

## 复现和证据

依赖与命令见 [文档验收工具说明](../../tools/docx/README.md)。本机为 Python 3.12.14、python-docx 1.2.0、odfpy 1.4.1、lxml 6.1.1、Pandoc 3.13、LibreOffice 26.8.2.2、pypdfium2 5.14.0、Open XML SDK 3.3.0。字体与引擎版本影响分页。

构建 `cargo build -p tools --example docx_acceptance`，复制驱动到独立文件名后运行 `tools/docx/run_public_acceptance.py`；`--task-prefix` 可定向重验。公开与请求衍生套件顺序执行，始终使用新输出目录。脚本只产生自动结果，页面观察单独记录，生产 `visualReview=pending`、`targetEditorVerification=unverified` 保持不变。

本地证据目录为 `.somniq/research/docx-native-repair-20261111/`：`final-public-evidence.json` 汇总每项最新执行，`page-observations.json` 记录全部 59 页，`schema-validation-final.json` 记录结构比较，`verification-summary.json` 绑定测试日志。各轮 `results.json`、`tool-calls.json` 与驱动保留不变；`report-history/` 保存修复前报告。机器清单含这些文件的哈希。

新增 [日常办公需求验收](docx-office-acceptance.md) 使用 14 份匿名样例检验另一组完整要求，6 项完整通过、8 项未完整满足。它发现制表符转换、封面编号、隐藏属性、表头、分节、修订、目录和控件等新问题；此前公开集的 21 项文件通过结论只覆盖本报告列出的原要求。

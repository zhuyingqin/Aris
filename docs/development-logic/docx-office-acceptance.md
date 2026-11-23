# 日常办公文档验收

2026-11-11 修复后重跑 14 项办公需求：**14 项自动检查通过**，覆盖修复前的 8 个缺口。14 份原件未变，14 份候选无新增 Open XML 错误，16 次实际撤销检查通过。Executor 查看了全部 20 页对应的 PDF 图片；登记表标题仍有一个原件已有的字形异常，因此不能宣称所有页面零视觉缺陷。

本轮实际读取并缓存了 10 篇 Microsoft Support 官方说明，用于定义行距、表格、页码、脱敏、修订、表单和目录的行为要求。14 份输入均为自建匿名样例，未下载真实客户或机构表单；具体业务文字和验收数值由测试作者设定，名单去重也是自建场景。样例、完整要求与来源映射见 [需求清单](../../tools/docx/office_cases.json)。

执行使用当前生产工具及已核对源码哈希的修复版 r2 驱动，向工具提供明确锚点和参数。这部分测的是原生工具；使用桌面配置模型、产品提示词及共享 Chat runtime 的自然语言验收另见 [Agent 验收](docx-agent-acceptance.md)。独立 Reviewer、Microsoft Word/WPS 打开保存未运行；按用户要求直接检查 PDF 页图，未操作电脑界面。现有 0.4.87 草稿 release 中的安装包不会因开发分支修改而自动更新。

## 逐项结果

| 日常需求 | 完整验收条件 | 结果 | 实际证据 |
| --- | --- | --- | --- |
| 一页维护通知 | 原文保留；18pt 居中标题，12pt/1.15 正文；时间范围标红；A4 一页 | 通过 | 指定格式及精确红色范围正确，1 页无裁切或白尾页。 |
| 会议纪要行动项 | 指定负责人陈工改李工，截止改 2026-11-20；其他行、表格和格式不变 | 通过 | 两处文字精确修改，另外两条行动项保留；1 页清晰。 |
| 合同金额日期 | 跨 run 的 12,800.00 改 13,500.00，交付日改 2026-12-01；保留粗体、斜体、签字栏 | 通过 | 金额及日期正确，原 run/段落属性、签字和其他条款保留；1 页清晰。 |
| 合并单元格报销单 | 住宿 1,000.00，合计 1,520.00；保留合并、边框、其他费用和签字栏 | 通过 | 另用 Decimal 校核三项之和；表格几何、格式和其他包部件保留；1 页清晰。 |
| 报价清单转表格及 PDF | 制表符分列成原生 5×4 表格；保留品名内逗号及数值；数字右对齐；交付同名 PDF | 自动检查通过 | 保留“打印纸,A4”、各项金额和 399.00 合计；原生表格、对齐和同名 PDF 均已核对。 |
| 三页报告连续页码 | 右下角连续 1、2、3；保留单位页眉、正文和分页 | 通过 | PDF 页脚值与位置正确，原页眉字节不变；3 页均已查看。 |
| 联络名单按工号去重 | 保留首次出现的 6 条及顺序；真正删除重复段，不留空段或白尾页 | 通过 | 剩余 XML 和其他部件与预期一致；1 页含 001 至 006，未漏唯一记录。 |
| 对外材料指定信息脱敏 | 正文姓名电话脱敏；清除作者、最后修改者；保留编号及预算 | 自动检查通过 | 可见文字替换及隐藏属性清理均通过；并非对任意隐藏信息的全面清理。 |
| 60 条库存长表重复表头 | 原生重复表头属性；每个实际分页均有表头；60 条数据完整 | 自动检查通过 | 两页均显示原生重复表头，INV-001 至 INV-060 全部保留。 |
| 封面不编号正文从 1 开始 | 原三页不变；封面无页码，后两页为 1、2 | 自动检查通过 | PDF 实际页脚为无、1、2；原正文、页眉和三页分页保留。 |
| 仅宽表附件横向 | 第一节纵向、第二节横向；保留两节和全部数据 | 自动检查通过 | PDF 第一页纵向、第二页横向；原有两节及 10 列数据保留。 |
| 接受合同支持的内联修订 | 接受新金额 11,000.00；清除 `w:ins`/`w:del`；保留其他条款 | 自动检查通过 | 新金额和其他条款保留，旧金额及插入、删除修订节点均清除。复杂结构和移动修订不在此能力范围。 |
| 可更新工作报告目录 | 根据一级二级标题生成原生 TOC、页码，并可更新 | 自动检查通过 | 六项标题及实际页码一致；独立无界面 UNO 检查识别 1 个原生目录，修改标题后目录同步更新，原文件未写回。 |
| 填写并保留内容控件 | 填写姓名；保留文字控件、下拉控件和原选项 | 自动检查通过；有视觉限制 | 姓名周示例已填写，两个 SDT、下拉选项和未编辑控件保留；标题“员”字的已有渲染缺陷仍在。 |

所有 14 份原输入 SHA-256 均保持不变。16 次文件修改均实际调用 `change_get` 和 `change_revert`，验证恢复原字节或移除新文件后，再重新执行最终修改。99 次工具调用均成功；保护、错误版本和拒绝不支持修改的边界另由回归覆盖。

## 页面和结构检查

14 份最终候选共 20 页。Executor 已逐页打开修复首轮的 20 张 PNG；最终 r2 的每张 PNG 都与对应已查看图像的 SHA-256 完全相同，观察另绑定到 r2 的 DOCX/PDF 哈希。19 页未观察到明显裁切、重叠或额外白尾页；登记表页的标题“员”字渲染成类似“1”的字形，未给予视觉通过。

未经修改的登记表原件也出现相同字形；标题区域像素与填写后候选完全一致。标题同时保留明确字体和主题字体，实际 PDF 出现 MS Gothic、CNKI 字体及宋体。具体回退原因尚未完全证明；这里只能确定异常早于控件填写，不能通过结构合法或文字提取正确将它忽略。

输入默认模板的标题下蓝线在部分样例中保留，未由本次工具操作新增。这里检验对已有文档的保留和指定修改，不把样例当作新设计的交付模板。

14 份候选均通过 Open XML SDK 3.3.0 Office2019 schema 检查，无新增错误。此结论只证明结构合法，不替代业务条件、分页和目标编辑器验收。生产渲染证据中的 `visualReview=pending`、`targetEditorVerification=unverified` 保持原值，Executor 观察单独记录，未提升为独立 Reviewer 通过。

## 公开要求依据

以下页面均在 2026-11-11 成功读取并保存原 HTML、正文、最终 URL、时间和哈希，具体来源与场景对应关系保存在机器清单。

| 官方说明 | 用于定义的要求 |
| --- | --- |
| [行距和段落间距](https://support.microsoft.com/en-us/word/change-the-line-spacing-in-word) | 通知的行距和段落排版。 |
| [文字与表格互转](https://support.microsoft.com/en-us/word/convert-text-to-a-table-or-a-table-to-text) | 原文有逗号时用制表符分列；本轮报价单正好覆盖这个条件。 |
| [跨页重复表头](https://support.microsoft.com/en-us/word/repeat-table-header-on-subsequent-pages) | 自动跨页时每页重复首行；手工复制一行不能代替原生重复属性。 |
| [从后续页面开始编号](https://support.microsoft.com/en-us/word/start-page-numbering-later-in-your-document) | 首页不显示页码，后续页面按所需起点编号。 |
| [纵向与横向页面](https://support.microsoft.com/en-us/word/training/change-page-orientation-to-landscape-or-portrait) | 可只调整指定内容所在页面。 |
| [检查隐藏数据和个人信息](https://support.microsoft.com/en-us/office/collab-files/remove-hidden-data-and-personal-information-by-inspecting-documents-presentations-or-workbooks) | 文档属性包括作者和最后保存者；正文替换不足以证明完整脱敏。本样例仅覆盖其中两项隐藏属性，未进行全面隐私认证。 |
| [修订与接受拒绝](https://support.microsoft.com/en-us/word/training/track-changes-in-word) | 隐藏修订显示或关闭修订不等于接受修订。 |
| [创建可填写表单](https://support.microsoft.com/en-us/word/create-a-form-in-word-that-users-can-complete-or-print) | 文字、下拉等原生内容控件应保留可填写结构。 |
| [自动目录](https://support.microsoft.com/en-us/word/training/insert-a-table-of-contents) | 根据标题生成并可更新；手动目录不能代替。 |
| [导出 PDF](https://support.microsoft.com/en-us/office/collab-files/save-or-convert-to-pdf-or-xps-in-office-desktop-apps) | 交付实际 PDF 文件并核对内容。 |

## 实现与回归

制表符转换只在文字转表格操作中接受原生 `w:tab`，继续拒绝跨对象边界。页码采用 python-docx 的首页页眉页脚及原生 PAGE 域；重复表头、分节方向、内联修订、有限个人属性清理和内容控件通过有界适配器处理。目录委托 LibreOffice UNO 计算实际条目与页码，只取回结果填充原生 TOC 域，原包不经过 LibreOffice 整体往返发布。

继续复用 python-docx、LibreOffice 和 Open XML 能力，沿用版本检查、候选发布、审计与撤销；复用依据及固定版本的上游源码见 [开源方案核查](docx-open-source-selection.md)。共享 Agent 的提示词和工具说明明确各项操作、修改后重新读取锚点、最终版本渲染以及未验证边界，保持 Executor 与独立 Reviewer 分工。

22 项 Python 回归通过；最终跨 crate 全仓 Rust 回归为 **1614 通过、0 失败、7 忽略**，20 个测试套件完成。新增办公边界回归核对富文本、原件不变、失败不覆盖候选、分节、原生控件选项/锁/过期值，以及页眉内修订等。Word/WPS、独立 Reviewer、旧二进制 `.doc` 仍需单独验证。

## 保留的失败历史

修复前完整需求为 6 项通过、3 项 partial、4 项原生接口缺口、1 项执行失败。修复首轮为 12 项自动通过、2 项 partial：重复表头虽可渲染，但 `w:val="true"` 未通过 SDK 枚举验证，已改为 `on`；目录页码断言受 pypdf 中文字序影响，已使用 PDFium 的实际字符与字号核对正文标题，并另行验证目录可更新。旧运行及失败事实均保留在机器报告的 history 中，没有改写为通过。

## 复现及证据

新增脚本与参数见 [工具说明](../../tools/docx/README.md)。使用配置好的依赖执行，始终使用新输出目录，顺序运行验收套件：

```powershell
python tools/docx/fetch_office_sources.py --output <fresh-source-cache>
python tools/docx/run_office_acceptance.py --runner <verified-driver> --build-manifest <driver-run-results.json> --sources <fresh-source-cache>/manifest.json --output <fresh-output>
python tools/docx/verify_office_evidence.py --run <saved-run> --observations <executor-page-observations.json> --runner <verified-driver>
```

依赖为 Python 3.12.14、python-docx 1.2.0、lxml 6.1.1、pypdf 6.21.4、pypdfium2 5.14.0、LibreOffice 26.8.2.2、Open XML SDK 3.3.0。目录另需可导入 `uno` 的 LibreOffice Python。不同字体或渲染器版本可能改变分页。最终驱动 SHA-256 为 `821b818794bc662b186c57abffa3bdd0e51b94e3edffd53b108924e951e1d153`，执行前后均核对其对应生产源码未变化。

最终证据目录为 `.somniq/research/docx-office-repair-20261111/`：`run-2/results.json`、`inputs.json`、`tool-calls.json` 和 `schema-validation.json` 保留原始运行；`page-observations.json` 绑定每页 DOCX/PDF/PNG 哈希；`verification.json` 检查完整性；`toc-update-verification-2.json` 证明最终目录可更新；`font-diagnostic.json` 保留原件字形对照；`regression-summary.json` 绑定全仓日志。修复前证据仍在 `.somniq/research/docx-office-20261111/`。

本轮修改生产 Rust、Python 适配器和提示词，并已重跑所需回归；没有桌面 UI/Tauri API 修改。详细哈希、14 项结果、历史失败和未验证边界见 [机器报告](docx-office-acceptance.json)。此前公开集结果保持独立，见 [公开任务验收](docx-public-acceptance.md)。

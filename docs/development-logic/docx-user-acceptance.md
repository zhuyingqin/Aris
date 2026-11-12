# DOCX 优化与真实请求验收

本次把新文档导出接入 Pandoc、常见段落格式接入 python-docx、实际分页接入 LibreOffice。转换、公式和分页采用上游引擎；共享 Rust 层负责文件权限、版本检查、候选文件、审计和撤销。实现位于 `crates/runtime/src/document_export.rs`，Desktop/Chat 与 CLI 共用原生工具入口。

2026-11-11 当前修复：原 13 项原生能力缺口已按 [公开 Word 任务验收](docx-public-acceptance.md) 完成，21 项文件任务通过；请求衍生与工程回归 9 组全部通过，6 张最终 PDF 页图均由 Executor 查看。客户原附件和完整对话不可得，这些结果不表示 8 类客户需求全部通过。原始来源与通过条件保持不变。

新证据位于 `.somniq/research/docx-native-repair-20261111/request-regression/`，包括 `results.json` 与 `page-observations.json`。生产证据的视觉审查仍为 pending，目标编辑器为 unverified。[WPS 记录](docx-wps-compatibility.md) 中的白尾页是旧候选事实；本轮新候选尚未在 WPS 复测。

追加的 [共享 Agent 自然语言验收](docx-agent-acceptance.md) 已完成 10 项自动检查，使用桌面实际配置的模型、产品提示词和生产共享 Chat 路由。其中 REQ-07 的匿名样本验证只回复文字且零用户文件写入；REQ-08 的衍生样本验证真实两轮中从八人表格改为七人、执行五人、零表格。它未重放四份原材料合并或跨岗位共享人员去重，不能据此将 REQ-08 原任务整项标为通过。开发验收另核对全部 13 页最终页图，未操作桌面 UI，独立 Reviewer 与 Word/WPS 仍未验收。

## 验收依据与抽样边界

[验收清单 JSON](docx-user-acceptance.json) 定义 8 类请求、12 条已核实的原始用户消息来源及各自通过条件。公开内容经过脱敏改写；原始请求、消息位置及请求标识保留在本地 `.somniq/tmp/docx-acceptance-20261110/`，不进入 Git。

数据来自用户指定后台的只读、限量查询，包含两个快照：

| 选择范围 | 选中推理记录 | 对话调用 | 历史用户消息出现次数 | 账户内去重指令文本 |
| --- | ---: | ---: | ---: | ---: |
| Word/排版关键词 | 800 | 351 | 540 | 30 |
| 精确后续指令补查 | 107 | 17 | 41 | 3 |

第二批与第一批存在重叠，不能相加当成独立用户数量。30 条文本中也包含上下文问候等内容，不能称为 30 个 Word 任务。提取器只接受原始 `role=user` 消息，排除助手答复、Reviewer、标题/记忆提取、附件正文和运行时检查点，并去重重复携带的历史。两次快照的完整 SHA-256 保存在 JSON 中。

后台记录未提供原始 DOCX 附件，因此这里使用“真实请求衍生的匿名样本”，不声称重放了客户原始文件，也不计算全体用户的任务成功率。

## 用户标准与当前覆盖

| 请求 | 必须满足的标准 | 当前已执行的检查 | 仍需执行的任务验收 |
| --- | --- | --- | --- |
| 四份材料合并 | 四份来源均读取，独有事实与职责完整，冲突有说明 | 不可读输入不覆盖成稿 | 原附件完整性、内容合并与模型对话 |
| 两页、文字不变 | 实际恰好两页，文字顺序不变，首段与正文格式一致 | 衍生样本的文字/其他部件保留、实际页数、正文参数 | 原文重放、左右对照阅读及目标编辑器分页 |
| 标题/署名与两面均衡 | 位置与字号关系符合要求，逐页审查分布 | 标准已定义 | “小2号”含义确认；不凭空设置均衡阈值 |
| 申请表格式不变 | 原表结构/公式保留，指定意见范围准确删除 | 精确文字修改、部件/公式保留、撤销和保护对象拒绝 | 原表对照、整行/整节删除；表行和分节删除未开放 |
| 标准公文 Word | 有明确规范/机构模板依据，交付实际文件路径 | 指定模板的正文样式与页边距生效 | 实际公文模板和完整规范符合性 |
| 按录音/议程整理材料 | 出席信息可追溯，行动项不遗漏，不编造指标 | 模板机制 | 原始来源和内容提炼 |
| 只回复文字 | 聊天给出文字，零文档写入 | 共享 Agent 实际读取匿名通知并回复文字；1 次读取、零用户文件写入，执行前后清单和哈希一致 | 客户原始会话未重放，结果仅适用于该匿名样本 |
| 后续改为七人、不要表格 | 最后一轮要求有效，合计七人且零表格 | 共享 Agent 先生成八人原生表格，再改为七人、执行五人、零表格；两轮实物及最终文字答复已核对 | 原始四份材料合并、跨岗位共享人员去重和完整客户会话仍未验证 |

完整通过须满足对应请求的全部条件。不能把预先整理好的内容成功导出，记成模型完成了合并或人数推理。原生公式、并发版本、保护对象和本地资源处理是额外的工程标准，JSON 明确标为工程来源，未冒充客户原话。

## 已接入的能力和边界

- `export_docx`：从已保存、带版本的 Markdown 生成新 DOCX；Pandoc 解析 Markdown/数学并输出原生 OMML。指定 `reference_doc` 控制样式和页面属性，模板正文按上游规则被忽略；默认研究模板不代表公文合规。警告或不支持的公式阻止发布。
- `format_docx`：复用 python-docx 修改正文及表格内段落的格式、精确字符范围和仅斜体范围，支持上下标、删除线、RGB 及空段落压缩。受保护边界明确拒绝，不自动均衡任意内容的两页排版。
- `edit_docx_structure`：显式锚点插入制表位/换行/分页/空白页、表格、图片、页码和原生文献交叉引用；保留非目标包部件。`read_odt` / `remove_odt_highlight` 用 odfpy 读取与去高亮，保留 ODT 格式。
- `render_docx`：独立 LibreOffice profile、自有受管进程、超时和取消；输出真实 PDF 页数以及 DOCX/PDF 哈希。外链内容、宏、ActiveX 和嵌入对象不自动渲染。不操作用户的 Word/WPS 会话。
- 本地图片以 Pandoc AST 的 Image 节点接入：先按现有读取权限读取并记录图片版本，再以嵌入资源交给沙箱中的 Pandoc。不会自动下载远程图片；支持的栅格格式沿用已有文件读取 MIME 列表。
- 输出覆盖须提供当前版本；超过审计可撤销快照上限的旧文件要求另存候选稿。发布和审计失败有带版本检查的回滚；新建文件也可通过 `change_revert` 撤销。

生成成功与渲染成功分别记录。渲染状态区分 `rendered`、`unavailable`、`failed`、`cancelled` 和 `not_requested`；视觉检查保持 `pending`，目标编辑器验证保持 `unverified`。已有任意 DOCX 不通过 Markdown/Pandoc 整体往返重建。

独立 Reviewer 当前仍只有文本读取能力，尚未接入页面图片证据。这里的页面观察不能替代独立 Reviewer；修复后 Word/WPS 打开、编辑、保存、重开验收尚未执行；旧 WPS 单例见兼容性记录。现有 0.4.87 草稿 release 中的安装包不包含本分支新增工具。

## 可重复执行

需要本地安装的 Pandoc、LibreOffice 和带 python-docx 的 Python。验收脚本另需 Pillow、pypdfium2 和 pypdf；这些只用于测试图片和字体/页面证据，不是第二套产品布局引擎。

本机验证版本：Pandoc 3.13、LibreOffice 26.8.2、Python 3.12.14、python-docx 1.2.0。工具通过 `SOMNIQ_PANDOC`、`SOMNIQ_LIBREOFFICE`、`SOMNIQ_PYTHON` 或 PATH 定位引擎；Windows 建议使用 LibreOffice 的 `soffice.com` 命令入口。字体安装属于运行环境，PDF 的实际字体列表另行记录，不能由 DOCX 中的字体声明推断。

```powershell
# 按本机安装位置配置这三个变量。
$env:SOMNIQ_PANDOC = 'C:\tools\pandoc\pandoc.exe'
$env:SOMNIQ_LIBREOFFICE = 'C:\Program Files\LibreOffice\program\soffice.com'
$env:SOMNIQ_PYTHON = 'C:\tools\python\python.exe'
cargo build -p tools --example docx_acceptance
& $env:SOMNIQ_PYTHON tools/docx/run_acceptance.py --runner target/debug/examples/docx_acceptance.exe --output .somniq/tmp/docx-acceptance-new
& $env:SOMNIQ_PYTHON tools/docx/test_format_docx.py
& $env:SOMNIQ_PYTHON tools/docx/test_request_evidence.py
cargo test -p runtime document_export -- --include-ignored
cargo test -p tools docx
cargo test -p aris-chat docx
cargo test --workspace
```

每次使用空输出目录，保留旧证据。脚本通过生产 `tools::execute_tool` 路径运行 9 组自动检查，输出 `results.json`、最终 PDF、逐页 PNG、文件哈希、实际 PDF 字体和明确的未验证状态。两页样本保留了输入的中间分页位置：验证参数调整能从超过两页变为恰好两页，不能由此宣称已实现任意内容的自动均衡排版。

自动结果之外，逐页检查应记录候选哈希、页码、观察者、实际问题和覆盖范围。若修改 DOCX，旧图和旧结论失效，必须重渲染。仅使用同一渲染环境的通过结论；跨 Word/WPS 兼容不能由 LibreOffice 推断。

## 初轮运行记录

修复前文档链路运行位于本地 `.somniq/tmp/docx-acceptance-20261110/run-4/`，9 组自动检查全部通过。`results.json` 包含执行程序、文档模块和格式适配源码哈希，以及 DOCX/PDF/页面图片的哈希；文档模块和适配源码在当时核对一致；当前实现以新增回归的版本记录为准。原始请求数据没有写入该运行目录或 Git。

| 自动检查 | 实际结果 |
| --- | --- |
| 模板与原生公式 | 3 处 OMML，正文数字保留，PDF 1 页 |
| 精确文字编辑与撤销 | 其他包部件和原生公式保留，撤销恢复原包 |
| 后续要求不要表格 | 成稿 0 个 Word 表格，保留 7 人文字，PDF 1 页 |
| 指定样式参考 | 正文 Body Text 14pt、左边距 31mm 生效，模板版本记录正确 |
| 两页且文字不变 | 衍生输入渲染 8 页，格式调整后恰好 2 页；40 行文字及其他部件不变；首段与后续正文参数一致 |
| 不支持公式、旧版本、缺失输入 | 均拒绝，已有输出字节不变 |
| 保护对象 | 含域文件的格式修改被拒绝，没有半成品发布 |
| 本地图片 | 图片字节原样嵌入、版本有记录，PDF 显示完整图和题注 |
| 外链图片 | 拒绝远程资源，本机探针收到 0 个请求，旧成稿不变 |

Executor 使用逐页图片检查了全部 6 页，记录在 `page-observations.json`，未观察到明显截断、遮挡或意外多页。该观察不是独立 Reviewer 或人工签收。原生证据的 `visualReview` 仍为 `pending`，完整模型对话和 Word/WPS 验证仍为 `not_run`。

字体核对发现并修复了明确字体与主题字体同时存在时的覆盖问题。最终 PDF 可见 SimSun、SimHei 和 Times New Roman，数学样本另使用 OpenSymbol；不能据此推断任意运行环境都具备这些字体。

格式适配 Python 回归 2 项和请求证据提取回归 1 项通过；Rust 的原生 DOCX、工具契约、Chat 路由、资源打包和失败分类定向检查均通过。最终在正常本地权限下执行 `cargo test --workspace -- --test-threads=1`：**1610 通过、0 失败、7 按既有设置忽略**，20 个测试套件完成；日志为 `.somniq/tmp/docx-acceptance-20261110/workspace-tests-serial.log`，汇总为同目录 `verification-summary.json`。notebook 集成测试需要能启动本地 Jupyter 内核的执行环境。

完整并行回归中，既有的 `batch_write_preserves_external_saves_during_a_locked_publication_and_rollback` 曾出现一次 Windows 文件锁时序失败；同一用例定向运行和完整串行运行均通过。这是初轮事实。本轮后来又在串行环境复现：测试在写线程返回前释放锁，最后一次版本检查可与外部保存竞争。已将释放锁移到 join 后，原断言及生产批量写入代码未变；最新全仓结果另列。

未修改 UI/Tauri API，因此本次不要求前端构建。

方案 M3 的视觉 Reviewer/Desktop 审查交互、M4 的目标编辑器兼容仍是后续工作。

## 当前原生修复回归

本轮 9 组自动检查使用 `docx-acceptance-r6.exe`，执行结果与驱动/模块/适配器版本均有哈希。6 页包含中文及三处 OMML、七人零表格、参考模板、固定两页和本地图片，全部查看，未见新增裁切、遮挡或白尾页。字体、图片资源、失败不覆盖、版本冲突、保护对象和实际原字节撤销继续通过。没有重放原客户附件或模型合并/推理过程。

最新 Python 回归 16 项通过；全工作区串行测试 1614 通过、7 忽略、0 失败。源码实现及公开验收见对应报告，历史数据保持原状。用户的 12 条原始消息、两个快照哈希、8 类规范和未覆盖的完整任务条件未改动；原始日志没有复制进 Git。

当前仍未完成独立视觉 Reviewer/Desktop 审查、原客户文件重放和修复后 Word/WPS 兼容，安装包未发布本次改动。

## 日常办公与共享 Agent 追加验收

[日常办公修复报告](docx-office-acceptance.md) 记录 14/14 原生文件自动检查、14 份原件保留、16 次撤销恢复及无新增 schema 错误；22 项 Python 与 1614 项 Rust 全仓测试通过。其结果与上面的历史回归分开保存。

[共享 Agent 报告](docx-agent-acceptance.md) 的 10 项是模型自然语言执行结果，不是直接调用工具的数量；其中九个单轮保留原始日志，一个多轮在修复未来指令泄露后重测。旧多轮结果作废并保留原因。实际模型没有完成 PDF 页图视觉检查，开发 Codex 的页图观察不作为独立 Reviewer 通过；登记表标题的一处原件已有字形异常仍保留为问题。完整客户任务、桌面界面、Word/WPS 和旧二进制 `.doc` 的未验证边界保持不变。

# PDF 阅读用途实测

日期：2026-09-26。按用户当前优先级暂停 Reviewer，先验证真实 PDF 阅读。

本报告记录早期页级识别实测。用户随后指出需要面向读者的多模态理解，已新增图文讲解界面与真实生成验证，见[后续图文讲解实测](paper-reader-multimodal-guide-2026-09-26.md)；下面“当前”均指这一早期页级批次。

## 结论

当前实现已有辅助阅读价值：能够自动处理全文、读出主要公式及其假设、描述注意力流程图、提取主要实验数字，并保存可回到原页的结果。但复杂表格的列归属仍未通过本次抽查。它目前是带来源的页级识别草稿，尚不是能够稳定解释整篇论文的阅读器。

本轮实际调用 Somni 当前的 MiniMax-M3，经桌面 Chat 执行路径处理同一篇真实论文两次。没有产品 Reviewer 调用，没有生成教学材料，也没有目标读者试用。以下内容核对是开发验收时对照原页图像的抽查，不会修改产品中的 `not_reviewed`／`not_checked` 状态。

## 输入与调用证据

- 论文：[Attention Is All You Need，arXiv:1706.03762v7](https://arxiv.org/pdf/1706.03762v7)，15 页，2,215,244 字节。
- PDF SHA-256：`bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`。
- 页面准备调用生产代码 `paperDocumentRevision`／`preparePaperPageEvidence`，使用 PDF.js、1.6 倍页面渲染、JPEG 质量 0.88；这篇论文的页图为 980 × 1268 像素。
- 第 4、8、9 页主动去掉辅助文本，仅向模型提供原页图像；其余页面提供图像与 PDF 嵌入文本。该对照检验无文本层时的可用性，不能排除模型对知名论文的既有知识。
- 实际调用链：`paper_reading_start → run_paper_reading_turn → run_chat_turn_with_context`，没有新增直连模型 HTTP 路径。
- 使用隔离的项目、配置副本和会话目录。请求日志中每次都有一个 `image_url`，工具列表为空；用量记录只有 `executor`，没有 Reviewer。
- 桌面诊断宿主复用实际 Tauri 命令及 Chat 引擎；它没有打开产品窗口。本次未做打包桌面窗口中的人工点击验收。按钮准备全文、结果展示与页级跳转有现有 Vitest 回归证据。

| 运行 | 页面完成／失败 | 新尝试 | 耗时 | 模型报告的输入／输出 tokens |
| --- | --- | --- | --- | --- |
| 原协议 v1 | 15／0 | 15 | 278.018 秒 | 36,977／22,585 |
| 改进输出格式后的 v2 | 15／0 | 15 | 274.417 秒 | 38,957／22,989 |
| v1 重启恢复 | 15／0 | 0 | 1.625 秒 | 无新增模型调用 |
| v2 重启恢复 | 15／0 | 0 | 1.628 秒 | 无新增模型调用 |

两次首次运行均包含一次重复启动请求；每页仍只有一次尝试。两次重启都从 SQLite 恢复同一任务，保存结果与重新读取的结果一致。费用没有计价；上述 tokens 是用量日志，不是账单金额。未做真实请求中途崩溃或网络中断测试。

## 对照原图的阅读任务

核对第 4、7、8、9 页的主要公式、脚注、训练设置和两张实验表格。表中是声明范围内的抽查，不据此计算全文准确率或识别召回率。

| 具体阅读任务 | 结果 | 实际观察 |
| --- | --- | --- |
| 第 4 页：读出注意力公式 | 通过 | 两轮都保留 `QKᵀ / √dₖ`、softmax 后乘 V；v2 输出可排版的 LaTeX，保留公式编号 |
| 第 4 页：找到缩放论证的前提 | 通过 | 脚注中的独立、零均值、单位方差假设及点积方差 dₖ 被保留；没有把它写成无条件结论 |
| 第 4 页：看懂 Figure 2 的计算顺序 | 通过 | 可读到点积、缩放、可选 mask、softmax、对 V 加权，以及多头投影／拼接／线性层的顺序 |
| 第 7 页：查训练数据、词表与批次 | 通过 | 数据规模、两种词表大小及源／目标各约 25,000 tokens 的批次设置相符 |
| 第 7 页：查复现实验的关键设置 | 通过 | 8 块 P100、base／big 的训练步数、Adam 参数、学习率指数及 warmup=4000 均相符 |
| 第 8 页：查 Table 2 的主要 BLEU | 通过 | base 的 27.3／38.1 与 big 的 28.4／41.8 都读出，语言列正确 |
| 第 8 页：保留原文自身的数字差异 | 通过，但没有解释差异 | 正文的 EN-FR 41.0 和表格的 41.8 均被保留。这不是模型凭空制造的数字冲突；当前感知阶段未解释冲突 |
| 第 8 页：恢复训练成本跨列布局 | 未通过 | 两轮都把 Transformer 行跨列居中的成本数字分配到某一语言列，并将另一列判为空白；不能据此可靠比较语言训练成本 |
| 第 9 页：分清实验统计口径 | 通过 | 保留 newstest2013 开发集、per-wordpiece PPL 及空白值沿用 base 的表注，没有把它当成 newstest2014 测试结果 |
| 第 9 页：恢复 Table 3 的 A／B 组 | v1 未通过，v2 抽查通过 | v1 的 h、dₖ 列错位；v2 将 A 组的 h 与 B 组的 dₖ 变化放回对应列 |
| 第 9 页：恢复 Table 3 的 C 组 | v2 未通过 | 原图中 d_ff=1024／4096 的两行，被 v2 放到 d_model 列。表格结构合法且数字存在，但列归属错误 |
| 第 9 页：查 base／big 主要参数和指标 | 抽查通过 | 两行的层数、模型维度、FFN 维度、head 数、训练步数及主要 PPL／BLEU／参数量相符 |

这说明“JSON 合法”“所有页完成”“表格能排版”都不能证明内容正确。v2 改善了 A／B 组，但没有解决复杂表格的一般问题。识别疑点也不等于错误检出：模型没有正确指出 C 组的具体错列。

## 本轮修改与验证

1. 增加仅 debug 构建可用的隔离诊断入口，要求显式配置根目录和标记文件，调用产品原有命令。新增页面准备脚本复用生产 PDF 代码，无需另一套模型执行器。
2. 将表格行列、空白值、合并单元格与公式 LaTeX 的输出要求写入 v2 协议。旧版产物仍保存在本地，但不能作为新版缓存返回，也不能带着旧协议继续运行。
3. 页级结果使用 Markdown 表格及 KaTeX 显示，保留横向滚动。修复单行 `$$...$$` 中带公式编号时被误当成行内公式的问题。未对模型错读的表格做针对该论文的硬编码修正。
4. 把 v2 的全部 140 个候选条目送入实际展示组件，得到 109 个数学片段、4 张表格，无 KaTeX 错误。这个检查只验证展示，不验证公式／表格语义，也不代表识别完整。

| 工程检查 | 结果 |
| --- | --- |
| Runtime 论文任务聚焦测试 | 11 个通过，包含旧协议缓存与续跑的回归检查 |
| Rust 工作区测试 | 1,204 个通过，5 个既有忽略项；无失败 |
| Tauri 论文任务聚焦测试 | 6 个通过 |
| 阅读器、文献库、结果面板及显示组件 Vitest | 104 个不同测试通过；展示修复后再跑相关 11 个测试 |
| TypeScript 检查与前端构建 | 通过；现有混合导入／分包体积提示仍存在 |
| 实际模型结果显示检查 | 140 个条目无数学渲染错误 |

## 后续范围

继续围绕阅读用途改进：先用更多不同版式论文核对图表，再验证高密度表格的更清晰原图或局部取证是否能减少错列。尚未验证这些改进有效，不把改提示词当作已解决。

当前结果仍以原文转写和局部图示描述为主，缺少面向读者的中文概述、关键公式解释和跨章节联系；这些才是下一步需要验证的阅读增益。Reviewer 原图接口、完整 T0 教学／审核／修订回路保持暂停。单篇知名论文的两轮结果不能代替计划中的 3–5 篇 M1 验收、完整识别标注或真实读者效果验证。

## 本地证据与复现

- [指标汇总](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/acceptance-metrics.json)
- [v1 首次运行](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/attention/first-run.json)／[v1 重启](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/attention/restart-run.json)
- [v2 首次运行](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/attention-v2/first-run.json)／[v2 重启](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/attention-v2/restart-run.json)
- [原 PDF](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/inputs/attention-1706.03762v7.pdf)／[第 8 页核对图](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/gold/attention-page-8.png)／[第 9 页核对图](F:/Agent/Aris/desktop/.somniq/tmp/paper-reading-live-20260926/gold/attention-page-9.png)

这些运行材料保留在被 Git 忽略的本地目录；隔离测试使用的模型凭据副本在验证结束后删除。源码不包含凭据或整篇论文转写。

复现入口是 `desktop/scripts/prepare-paper-reading-diagnostic.mjs`，参数依次为 PDF 路径、输出目录、标题、来源 URL、可选纯图像页码（例如 `4,8,9`）。随后在独立 `ARIS_CONFIG_ROOT` 中准备模型配置、`.paper-reading-diagnostic` 标记与对应 `desktop-workspace/papers/` PDF；将 `SOMNIQ_PAPER_READING_DIAGNOSTIC` 指向 manifest 后运行 debug 桌面二进制。它会输出 `live-progress.json`／`live-result.json`，再次运行验证已有结果恢复。

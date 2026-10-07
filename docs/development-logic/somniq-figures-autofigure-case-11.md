# AutoFigure Case 11：DeepScientist 重建记录

日期：2026-10-06。用户指定[上游案例图片](https://github.com/ResearAI/AutoFigure-Edit/blob/main/img/case/11.png)，本轮将左侧原图送入 SomniQ 的无分割重建流程；右侧蓝色选框和重复编辑演示不作为重建目标。

## 调用前固定的条件

- 上游固定为 `16f3749e9d512bdf7b7b55c162307bc289750b7a`。原始 PNG 为 7680×2220、10,418,750 字节，SHA-256 为 `f950ae1ab5c186cddb3384e958521b07f6d59e656bdb4d9196c0f49189edfc35`；Git blob 为 `b34d6f941cc66e7570309649ead12fb6cec978f5`，已核对与当时 main 的图片一致。
- 输入只做矩形裁剪：`left=0, top=0, width=3760, height=2220`，没有缩放、图标分割、抠图或生成式编辑。裁剪 PNG 的 SHA-256 为 `8610e74cde5c0e18ac2c86498c91b2bb3a997c0bd32f54717b313ed6648057b6`。
- [预登记要求](F:/Agent/Aris/desktop/src-tauri/tests/fixtures/figures/autofigure-case-11/fixture.json)含 38 类标签、重复组件要求和 30 项关系。模型收到实际 PNG 及方法/风格文字，没有上游 SVG 或节点坐标代码；这是带文字要求的开发样例，不是纯图片盲测或 P3 留出集。
- 重建预算在调用前设为 32,768；独立审查固定 8,192；最多一次修订。此次先修复 DEV-02 已观察到的 Reviewer 2K 截断限制；没有自动按错误升额，不应与旧 2K 配置结果视作同条件对照。每次实际请求仍写入账本。
- 人物、脑芯片、文档、工具等图标要求用可识别的简化矢量表示，并要求模块独立分组。该目标允许图标画法变化，不等于保留原始像素图标或逐像素复现。

## 结果

**自动重建未完成；另外交付一份明确标记的手工矢量稿，已通过 SomniQ 本地校验、导出和编辑检查。手工稿不能作为自动还原成功的证据。**

| 流程 | 实际结果 |
| --- | --- |
| 自动重建 | `deepseek-v4.1-flash` 在 600 秒内没有返回响应头，请求标记 `unknown`；没有 SVG、token 用量或 Reviewer 结论 |
| 请求次数 | 自动尝试仅提交一次；没有重新提交、探针、生图、修订或 Reviewer 请求。费用未决，不能记成零费用 |
| 手工矢量稿 | 根据原图构建矢量图，图标简化；另建本地草稿，经相同 SVG 校验、resvg PNG / svg2pdf PDF 渲染和版本保存 |
| 本地修正 | 首份手工稿发现文字与图标重叠，修正版调整标签、间距及图标位置；两个本地记录都保留，均没有模型请求 |
| 画布与标签 | 3760×2220，宽高比偏差 0%；38/38 类标签逐字保留，预登记的八类重复组件都出现两次 |
| 可编辑内容 | 47 个 text，0 个内嵌栅格图；组件与连接线分组，矢量稿为 `editable_vector` |
| 实际编辑检查 | 在 Chromium SVG-Edit 中拖动 `scientist-overview`，图标与文字同时移动 28×18 屏幕像素，撤销恢复；改字、撤销/重做、序列化、重开通过 |
| 视觉检查 | 助手对照原图与原生 PNG，主流程、下方三个细节区和主要回路可辨认。字体、人物及图标画法、局部间距存在差异，未由独立 Reviewer 验收 |
| 最终状态 | 手工稿为 `draft`，无独立审查、无 `final.svg`；原始自动请求仍为 `unknown` |

自动任务：`826bd7716f7be5515ba71525b3e3404f`。手工初稿：`6060b2d36b10b84a7832e17dc40876a0`。交付的手工修正版：`76debd79dad27142ab03d5ec7f506acc`。三者是不同记录；没有把手工修复写成自动模型版本。

独立 Reviewer 的固定 8K 预算在本案例中**没有实际执行**，因此不能宣称本次证实已解决审查截断。失败发生在响应头阶段，也不能把它记成 SVG 输出截断或“无分割方法无法还原”。需另行排查当前接口对该输入的处理；本次不重发未决请求。

## 交付文件

![原图与手工矢量重绘对照](F:/Agent/Aris/.somniq/artifacts/figures/76debd79dad27142ab03d5ec7f506acc/experiment/comparison.png)

[可编辑 SVG](F:/Agent/Aris/.somniq/artifacts/figures/76debd79dad27142ab03d5ec7f506acc/versions/0001.svg)、[PNG](F:/Agent/Aris/.somniq/artifacts/figures/76debd79dad27142ab03d5ec7f506acc/versions/0001.png)、[PDF](F:/Agent/Aris/.somniq/artifacts/figures/76debd79dad27142ab03d5ec7f506acc/versions/0001.pdf)、[机器可读记录](evidence/somniq-figures-autofigure-case-11-20261006.json)。[手工源 SVG](F:/Agent/Aris/desktop/src-tauri/tests/fixtures/figures/autofigure-case-11/manual-redraw.svg)纳入 Git；模型未收到此文件。

PNG/PDF 来自 SomniQ 原生渲染器，未经过外部图片编辑。编辑器检查只说明 Chromium 中的本地往返通过；原生 WebView2 未在本次操作验收。模型原始调用结果、本地草稿版本与对照媒体保存在项目 `.somniq/artifacts/figures`，未上传外部仓库。

## 复核入口

测试入口是显式忽略的 `figures::tests::live_imported_figure_reconstruction`；读取冻结的 `sample.json` 和 `reference.png`，先写 `live-run.json` 防重复提交，再调用生产 `process`。默认专项测试不会发起付费请求。已写 guard 的目录不得被当作新请求再次提交。

设置 `SOMNIQ_FIGURE_LOCAL_SVG` 时，仅在 `authorship=manual_vector_redraw` 且文件 SHA-256 匹配的样例中执行本地导入；此分支不调用 `process` 或模型。手工样例缺失该变量时拒绝进入自动重建，防止误收费。每次本地导入和修改都保留其独立来源与版本记录。

本地浏览器复核可读取修正版的冻结目录：

```powershell
$env:SOMNIQ_FIGURE_P0_WORKSPACE = 'F:\Agent\Aris'
$env:SOMNIQ_BROWSER_TEST_NODE_MODULES = 'C:\Users\wt\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node desktop/scripts/test-figure-sample.cjs .somniq/tmp/figures-case-11-manual-final
```

本轮后端专项 4 通过、5 忽略；实际自动导入测试因上游超时失败；手工初稿与修正版本地导入分别通过；修正版真实编辑器检查通过。未将失败的自动用例或未执行的独立审查算成通过。

历史 DEV-02 仍保留其实际 2K 审查配置和失败记录，不重跑、不覆盖。

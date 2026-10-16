# DEV-02：中等复杂度科研架构图还原实验

日期：2026-10-06。目标是检查当前无分割流程能否还原一张比 DEV-01 三模块流程图更复杂的图。本轮保持现有生成/审查策略，新增确定性夹具和显式实验入口，没有修改生产提示、模型选择、渲染器或额度。

## 原图与实验条件

手工设计 1600×1000 的“科研执行与证据闭环”，包含 13 个主体模块、16 条有向关系、两个并行分支及汇合、菱形条件判断、两条虚线反馈回路和三个分区。图中有中文、少量英文和书籍/数据/检查小图标。

[源 SVG](F:/Agent/Aris/desktop/src-tauri/tests/fixtures/figures/dev-02-research-loop/source.svg)与[要求清单](F:/Agent/Aris/desktop/src-tauri/tests/fixtures/figures/dev-02-research-loop/fixture.json)在调用前固定。先本地渲染参考 PNG，检查文字及箭头，再创建带来源哈希的任务；实际模型只收到 PNG 和方法/风格文字要求，**没有收到源 SVG、节点坐标或样式代码**。给出的文字清单包含必要模块和关系，因此本实验是当前应用契约下的重建，不是纯图片盲测。

这是 `DEV-02` 开发样例，不计入 P3 留出集。Executor 使用当前 `deepseek-v4.1-flash`，Reviewer 使用独立 `MiniMax-M3`，两侧使用已有隔离请求及图片载荷。重建上限 16,384，Reviewer 沿用生产代码的 2,048；允许至多一次修订，不自动扩额或重发。此前真实图片探针缓存命中，本次没有另发探针或生图请求。

## 结果

**主要结构还原成功；完整生产审核没有通过。** 生成一份完整可解析 SVG，本地 PNG/PDF 已输出。独立 Reviewer 到达 2K 输出上限，未返回完整结论，任务停为 `draft`、`visual_pending`，没有生成 `final.svg`，也没有因截断重发或自动修订。

| 项目 | 实际观察 |
| --- | --- |
| 画布 | 1600×1000、viewBox 一致；本例比例偏差 0%，不代表已修复此前比例约束缺失 |
| 主体标签 | 13/13 语义保留；逐字为 12/13，“质量达标？”被改为“质量达标?” |
| 关系与回路 | 助手逐项对照 PNG 和实际路径端点，可追溯全部 16 条逻辑关系和 2 条虚线回路；模型将两处入边画成共用汇合线 |
| 文字与图形 | 31 个可编辑 text、47 个主体矢量元素、0 个内嵌栅格图；8315 字节 SVG |
| 编辑往返 | 真实 SVG 在本地 SVG-Edit 中改中文、撤销/重做、序列化、重开均通过；13 个语义标签和 marker 仍在 |
| 模块分组 | 0 个包含主体方框及对应标签的独立分组；框和字可分别改，整体移动需要选中多个元素或先分组 |
| 视觉保真 | 位置、间距、配色、字号存在差异；源 clipPath 与模块分组没有保留，不能称为像素级复现 |
| 渲染一致性 | 同一份未修改的模型 SVG 在 Chromium 中字体正常，而 resvg PNG 的中文明显偏细；具体字体选择/字重解析原因尚未定位 |
| 正式审核 | Reviewer 截断，结论未知；助手的逐项对照不能替代独立 Reviewer 通过 |

### 请求与费用口径

| 请求 | 上限 | 实际输入 token | 实际输出 token | 停止原因 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| SVG 重建 | 16,384 | 1,426 | 10,814 | stop | 70.262 秒 |
| 独立审查 | 2,048 | 7,778 | 2,048 | length | 85.801 秒 |

两次核心请求合计 156.063 秒，输出 12,862 token。冷启动流程测试约 198.92 秒，额外时间主要包含本地字体初始化及渲染；不包含先前原图准备的另一进程。没有账单金额，所以不能给出单图价格或降本百分比。本次 16K 重建完整，但不构成 8K、32K、50K 的同条件对照；输出用量说明 8K 风险需要实测，不能直接替换成该档失败结论。

## 原图与还原图

下图左侧是本地参考 PNG，右侧是模型 SVG 的**原生 PNG 导出**，字体粗细差异原样保留。

![DEV-02 原图与原生还原图](F:/Agent/Aris/.somniq/artifacts/figures/e5c7c17b9dc1087bb73a57127711698f/experiment/comparison.png)

同一模型 SVG 的浏览器显示如下，用于区分模型生成的布局/字号差异与原生导出器的字形粗细差异；它没有经过人工修图。

![同一模型 SVG 的 Chromium 显示](F:/Agent/Aris/.somniq/artifacts/figures/e5c7c17b9dc1087bb73a57127711698f/experiment/browser-render.png)

产物：[可编辑 SVG](F:/Agent/Aris/.somniq/artifacts/figures/e5c7c17b9dc1087bb73a57127711698f/versions/0001.svg)、[PDF](F:/Agent/Aris/.somniq/artifacts/figures/e5c7c17b9dc1087bb73a57127711698f/versions/0001.pdf)、[机器可读证据](evidence/somniq-figures-dev-02-20261006.json)。本地项目产物未上传外部仓库。

## 下一步和复核方式

优先处理 Reviewer 输出预算/推理策略、CJK 字体渲染差异，以及主体模块分组的输出约束和验收。不要把此次审查额度截断计为“无分割无法重建”。字号、位置和颜色保真仍需后续开发样例检验；本例不能替代完整 P0/P3 或原生 WebView2 验收。

原生显式 ignored 测试是 `figures::tests::live_p0_moderate_figure_reconstruction`。设置 `SOMNIQ_FIGURE_P0_WORKSPACE`，先以 `SOMNIQ_FIGURE_PREPARE_ONLY=1` 本地准备，不调用模型；确认样例后以 `0` 明确执行实际实验。一旦写入 `live-run.json`，重复调用会拒绝再次提交，防止复核变成重复收费。默认测试不执行该用例。

本地编辑验证：

```powershell
$env:SOMNIQ_FIGURE_P0_WORKSPACE = 'F:\Agent\Aris'
$env:SOMNIQ_BROWSER_TEST_NODE_MODULES = 'C:\Users\wt\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node desktop/scripts/test-figure-sample.cjs
```

此脚本使用已有 Playwright/Chromium，读取冻结产物，验证真实模型 SVG 的改字和往返，生成对照图与检查记录；不提交模型请求。测试时读取的编辑器包含当前工作区的主题调整，其他并发 UI 改动没有由本实验修改或纳入提交。

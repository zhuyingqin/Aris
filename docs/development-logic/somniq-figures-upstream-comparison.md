# SomniQ Figures 与 AutoFigure-Edit 核心对照

核查日期：2026-10-06。上游基线为 `16f3749e9d512bdf7b7b55c162307bc289750b7a`；本地功能基线为 `93a632d8`，当前分支 `codex/somniq-figures`。本轮读取实际源码和已有 DEV-01 产物，没有新增模型请求。

上游 `autofigure2.py` 的 SHA-256 再核对为 `1286f865d7bb9e10614edfd78943f28a9b8693b21a870a1be552c3739806d3bc`。补充读取同一提交的 `server.py`、`web/app.js`、`web/canvas.html`、`web/index.html` 和编辑器入口。GitHub 页面加工后的行号未用于源文件锚点。

## 结论

“先生成或导入图片，再转换 SVG，最后编辑”的产品顺序保留，画布仍使用 SVG-Edit。当前实现是在 SomniQ 的 Rust/Tauri 基础上重新实现流程；没有运行上游 Python 后端。

最大的算法变化是从“识别图标区域、保留图标像素、生成布局模板、回填原始图标”转为“视觉模型直接重画完整 SVG”。这消除了分割和去背景依赖，也将复杂图标的保真问题交给了重建模型。上游回填的图标是 PNG `<image>`，可移动或缩放，但图标内部并非矢量可编辑。当前提示要求文字和主要组件用 SVG 元素表示，并允许简化装饰性图标；复杂插画的细节相同程度尚未通过样例比较证明。

## 按实际实现比较

| 方面 | AutoFigure-Edit | SomniQ Figures | 判定与影响 |
| --- | --- | --- | --- |
| 重建输入和策略 | 原图 + SAM 标记图；图标占位模板；裁切去背景后回填 | 一张原图 + 方法/风格文字，直接重建图形与文字 | 有意调整；原图标细节可能被近似，结构图与复杂插画须分别验收 |
| 无图标分支 | SAM 返回空检测后进入 `no_icon_mode`，仍发送两张图 | 主流程完全不调用分割、裁切、去背景和回填 | 满足移除 API 的目的；并非直接启用上游已有开关 |
| 图片参考风格 | 允许上传参考图，生图调用接收实际参考图片 | 只有文字 `style`；生图调用传空的参考图片列表 | 未补齐，文字风格字段不能替代图片风格迁移 |
| 图片尺寸 | 可配置生图尺寸；默认可将生图或导入图等比例放大到 4K 长边 | 新绘图任务当前固定生图 `1024x1024`；导入保留现有像素 | 部分简化；小字可读性和长宽图适用范围尚未比较 |
| SVG 画布约束 | 重建提示写入实际原图宽高，要求相同尺寸和 viewBox；回填有坐标缩放对齐 | 提示只要求 viewBox、显式尺寸及最大 4096，没有传入原图宽高或本地比例门槛 | 额外弱化，已观察到 DEV-01 比例变化，见下文 |
| 审查与修订 | XML 语法校验；语法修复最多 3 次；可选同一生成连接的多轮优化；CLI 优化默认 0 | 独立 Reviewer 对结构和真实渲染图片审查；语法/质量修订共用最多一次 | SomniQ 的独立审查要求；会增加审查调用，限制重复生成 |
| 额度 | 重建/优化请求上限 50,000；该上限不等于实际费用 | 可选 8K/16K/32K/50K，暂默认 16K；探针、失败和用量入账，关闭隐式重复提交 | 预算更可核查；未证明整体更便宜或相同质量 |
| 编辑 | 内嵌 SVG-Edit，浏览器画布和历史运行产物 | 固定 SVG-Edit 7.4.2；画布/源码、版本保存、撤销重做和独立任务历史 | 核心编辑方式保留；安全隔离和支持的 SVG 元素范围有变化 |
| SVG 支持范围 | 上游生成提示没有同等元素白名单；基本校验主要是 XML 语法 | 不接受 filter、style 元素、任意 CSS class、脚本或外部资源；受控内嵌 PNG/JPEG/WebP 可以保留为 hybrid | 支持范围更窄；不能保证上游任意产物均可直接导入编辑 |
| 渲染和输出 | Python `svg_to_png` 使用 CairoSVG，ImportError 时尝试 svglib/ReportLab | Rust resvg 0.45.1 与 svg2pdf 0.13.0，保存 PNG/PDF/SVG | 无 Python 渲染依赖；编辑器、PNG 与 PDF 的显示一致性仍需验收 |
| 失败语义 | 某些重建异常会生成内嵌整图 PNG 的保底 `final.svg` | 截断/失败保留草稿和原始输出；整图 raster_preview 不能审查通过，只有 accepted 才写 final.svg | 有意收紧“可编辑成功”的含义 |
| 应用形态 | 可单独运行 Python Web/CLI/Docker 应用 | SomniQ Desktop 中的独立一级工作区，复用同一个主程序及模型账户 | 尚无单独可执行文件、启动器或安装包；当前的独立性是工作区级别 |

## 已复现的画布比例变化

读取本地 run `5209b7b7b02c2e2e3aa5f3dc4439e584` 的 PNG IHDR、`versions/0001.svg` 根元素和 manifest，结果为：

| 项目 | 数值 |
| --- | --- |
| 原图 | 900 × 240，比例 3.75 |
| SVG | 1000 × 250，比例 4.00 |
| 比例相对变化 | `(4.00 / 3.75 - 1) × 100% = 6.67%` |
| 原记录的机器审查状态 | accepted；structurePass=true、visualPass=true |

这个观测证明当前没有阻止画布比例变化；它不单独证明每个组件都发生了同比拉伸。原图 SHA-256 和 SVG SHA-256 与[首轮证据](evidence/somniq-figures-first-run-20261006.json)一致。该 accepted 结果仍是当时实际返回的结论，不能据此声称像素级复现或整体上游质量等价。

建议优先把来源宽高持久化，并纳入重建/修订提示与本地验收。允许归一化尺寸时要求统一缩放和明确 viewBox，而不是只比较是否小于 4096。之后用横向、纵向、中文多模块夹具验证，模型审查不能替代确定性的比例门槛。

## 尚未补齐的流程连接

- 参考图风格迁移：将风格参考图与待转换原图作为不同输入，复用既有 SomniImage 参考图片能力；原图重建仍只发送目标图。当前接口与 UI 尚未接线。
- 现有 SomniImage 历史图片的直接转换：现在能选文件导入，但 `ImageWorkflowPanel` 尚无直接打开本任务的“转为可编辑 SVG”入口。需要恢复来源关系，避免下载再导入。
- 论文插图：本地 PDF/PNG 导出已经实现，当前没有新增直接交给 `TypesetFigureDialog` 的入口，也未用论文编译链完成插图验收。
- 独立启动/打包：需要产品边界决定；当前实际代码是同一 SomniQ Desktop 的一级工作区，不应宣传已有单独安装包。

完整 5 张 P0 额度对照、20 张 P3 留出样例、真实金额、SomniImage 生图端到端、原生 WebView2 和论文编译仍是未完成的门槛。此次源码对照没有替代这些测量。

## 可复核源码

上游：

- [参考图片风格提示及生图载荷 L1345–L1385](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L1345-L1385)
- [无图标分支与画布尺寸提示 L2371–L2392](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L2371-L2392)
- [双图请求与 50K 上限 L2441–L2452](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L2441-L2452)
- [图标 PNG 回填 L2857–L2867](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L2857-L2867)
- [渲染路径 L2947–L2969](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L2947-L2969)
- [主流程分割、模式判定与去背景 L3359–L3398](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L3359-L3398)
- [保底整图包装函数 L3547–L3562](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L3547-L3562)
- [CLI 优化默认 0 L3682–L3687](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/autofigure2.py#L3682-L3687)
- [Python Web 应用的生图尺寸和参考图参数 L223–L255](https://github.com/ResearAI/AutoFigure-Edit/blob/16f3749e9d512bdf7b7b55c162307bc289750b7a/server.py#L223-L255)

SomniQ：

- [重建提示与独立审查提示](F:/Agent/Aris/crates/chat/src/figures.rs:108)
- [新绘图任务输入](F:/Agent/Aris/desktop/src-tauri/src/figures.rs:184)
- [原图单图重建、一次修订及复审](F:/Agent/Aris/desktop/src-tauri/src/figures.rs:695)
- [审查状态与 final.svg 定稿](F:/Agent/Aris/desktop/src-tauri/src/figures.rs:914)
- [固定生图尺寸与空参考图片列表](F:/Agent/Aris/desktop/src-tauri/src/image_api.rs:119)
- [界面输入、模型和额度选择](F:/Agent/Aris/desktop/src/figures/FigureStudio.tsx:175)
- [SVG 元素校验与渲染](F:/Agent/Aris/crates/tools/src/figures.rs:54)
- [独立一级入口的挂载](F:/Agent/Aris/desktop/src/App.tsx:1165)

# SomniQ Figures 首版实施记录

日期：2026-10-06。实施依据是[当前 AutoFigure 集成计划](autofigure-minimal-change-integration-plan.md)。本次交付独立的科研绘图工作区，作为 SomniQ Desktop 的一级入口；项目、账户、SomniImage、Executor、独立 Reviewer 和请求用量仍使用 SomniQ 的基础设施。

## 已实现的使用流程

在左侧“科研绘图”入口选择当前本地项目，填写方法、必要标签与箭头关系、风格，再导入 PNG/JPEG/WebP 或使用已配置的 SomniImage 生成参考图。生成模式只生成一张图，导入模式不重新生图。随后执行直接视觉 SVG 重建、本地验证和 PNG/PDF 渲染、独立 Reviewer 审查。SVG 无效或审查未通过时最多修订一次，随后再审查。没有 SAM、fal.ai、Roboflow、RMBG、Hugging Face 或 Python 后端。

新建任务明确显示两侧模型和传输方式。重建模型默认使用当前 SomniQ Executor，也可选择已有已验证连接中的模型；此选择仅作用于新绘图任务。Reviewer 沿用独立配置，两角色不共享对话。模型、端点、传输方式和绘图推理策略组成连接签名，任务启动时检查配置快照。

首次使用每个角色/连接，发送随机四位数字的真实 PNG 检查图片能力；结果按项目和连接签名缓存，每次探针进请求账本。Executor 探针失败就停止重建。Reviewer 确认不支持图片时仍可审查结构，但最高状态为“结构通过／视觉待检查”；服务错误、额度错误或路由错误不会被当作无视觉能力。视觉通过要求 Reviewer 实际收到原图和当前版本的导出 PNG。

SVG-Edit 7.4.2 从锁定 npm 依赖打包到本地，提供画布和 SVG 源码编辑。支持改字、移动、分组、撤销/重做以及保存不可变版本。源码未保存时不把它替换成旧画布内容；切换项目和关闭窗口沿用 SomniQ 的未保存/运行中任务保护。历史版本可查看、继续修改后保存成新版本，并单独导出 SVG/PNG/PDF。编辑、保存、导出没有模型请求。重新审查是显式的额外一次 Reviewer 调用。

## 调用额度与失败处理

导入正常为重建和审查两次核心调用，自动流程最多四次；生图正常三次、最多五次。首次能力检查另外最多两次。无额外优化请求，语法修复与质量修订共用一次机会。共享客户端为此流程关闭 HTTP、兼容参数和流式重试，使用冻结的传输方式，失败不会隐式多次收费。

可选 SVG 输出上限为 8K、16K、32K、50K，初版界面暂以 16K 为起点，**尚未由完整 P0 额度实验确定生产默认值**。支持的模型使用轻量推理；服务的输出上限仍可能包括推理 token。模型不接受某档额度时直接返回错误，不自动提高额度或更换模型。

DEV-02 暴露 Reviewer 的 2K 预算可能在最终 JSON 前耗尽。本轮 Case 11 将独立审查固定预算改为 8,192，并在每次请求的 `maxOutputTokens` 中记录；截断仍保持待检查，不自动升额或重发。此前开发样例的 2K 记录保持其原始配置。

保留服务返回的停止原因、真实用量、耗时和原始输出。`length`/`max_tokens` 等计为确认额度截断；不完整流单列，不能据此认定直接重建方法失败。截断后可在源码页手动修复并保存，也可由用户另建明确额度的新任务。

请求提交前先保存账本。重启时，已提交但未记录结果的请求变为 `unknown`，不重发；没有未决请求的中断任务保留为草稿。未决记录不被当作零费用或成功，自动流程和额外审查均不会越过未决记录。已保存的 SVG 仍能本地修改、导出。新任务必须由用户明确启动。

## 工程边界与产物

| 位置 | 职责 |
| --- | --- |
| `crates/runtime/src/figures.rs` | 项目目录约束、manifest、请求预算、恢复、来源/版本 SHA-256、原子保存和父版本冲突检查 |
| `crates/executor/src/bounded.rs` | 单请求执行、取消、部分输出与停止原因；两侧复用已有模型客户端 |
| `crates/chat/src/figures.rs` | 绘图 Executor、独立图片消息、重建和审查提示 |
| `crates/tools/src/figures.rs` | SVG 校验、可编辑性分类、固定 resvg 0.45.1 / svg2pdf 0.13.0 本地渲染与字体指纹 |
| `desktop/src-tauri/src/figures.rs` | 项目绑定的原生命令、任务控制、图片探针、流程编排、Reviewer 证据和导出 |
| `desktop/src/figures/`、`desktop/figure-editor/` | 独立应用页面、本地 SVG-Edit、仅编辑文档的隔离消息桥 |

图形按 `editable_vector`、`hybrid`、`raster_preview` 分类；整图 PNG 包装无法通过本地结构门槛。允许受控的内部 marker、clipPath、渐变、图形引用和内嵌栅格图；禁止脚本、事件处理、DTD/实体、foreignObject、外部资源及危险 CSS。校验在模型返回、文件读取、画布保存时使用同一边界。

编辑器使用不授予同源权限的 sandbox iframe，消息校验源窗口和每次挂载的随机通道。只接收文档载入和序列化，不接收项目路径、账户或原生命令。原生 IPC 若意外出现在子框架，编辑器停止初始化；CSP 限制本地代码与资源。原生 `somniq-figure` 协议仅提供固定目录中的编辑器静态资源并允许其模块在 opaque-origin 框架中加载；主应用及任意项目文件的跨域权限不扩大。SVG-Edit 的 transformed/clip 分组改字、文字撤销记录和移动状态通知在桥接层适配，未改动供应商源码。许可证随编辑器一起打包。

产物保存在 `.somniq/artifacts/figures/<run-id>/`：

```text
manifest.json                  # 配置、来源、版本、每次请求、用量和当前独立决定
figure.source / figure.png      # 固定来源快照，JPEG/WebP 按实际扩展名保存
template.svg / current.svg      # 首次成功结果与最新编辑源
versions/0001.svg / .png / .pdf # 不可变版本、预览和论文导出件
request-01.response.txt         # 模型原始输出，包括可恢复的不完整草稿
final.svg                      # 仅当前版本完整审查通过后产生
generation.json                # 生图模式的已有 SomniImage 返回记录
```

保存以当前 SVG 哈希为父版本条件，冲突时保留前端草稿。人工保存使旧审查和 `final.svg` 失效。Reviewer 的图片证据与来源、SVG、PNG、渲染器和字体指纹关联；发现字体或渲染器变化时撤销旧视觉结论。用户重新审查时先免费生成新渲染版本，再提交一条 Reviewer 请求。

## 本轮实际验证

Rust 全工作区测试通过；原生绘图模块专项测试、前端相关 Vitest、TypeScript 检查和生产前端构建通过。真实 Chromium 测试覆盖本地 SVG-Edit 的中文改字、带 clipPath 的分组移动、序列化、重开、marker 保留、隔离桥，以及本轮真实模型产出的 SVG 载入和保存。测试不调用模型。

实际图片探针：当前 `deepseek-v4.1-flash` Executor 和 `MiniMax-M3` Reviewer 均识别出随机图片中的四位数字，两个请求都正常停止。能力结果只说明当前连接具备这次图片输入能力。

首次开发样例 `DEV-01` 的输入与必要标签/关系在调用前保存。输入来自确定性的本地中文流程夹具，模型只收到 PNG；必需内容是“研究问题 → 独立审查 → 证据产物”。一次重建、一次独立图片审查后获得 `accepted`，无修订、无额度截断，3 个可编辑文字元素、5 个主体矢量元素。PNG 和 PDF 已保存，人工查看 PNG 的中文及箭头方向正常。按账本字段，两次核心请求输出 1,999 token，输入 1,940 token，核心请求耗时合计 23.86 秒；整个冷启动测试约 61 秒，包含本地字体和夹具准备。**这不是实际金额，也不是复杂图的平均费用或平均耗时。**机器可读摘要见[首轮证据](evidence/somniq-figures-first-run-20261006.json)。

开发验证可执行：

```powershell
cargo test --workspace --offline
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib figures --offline
cd desktop
npm run typecheck
npx vitest run src/figures src/windowCloseGuard.test.ts src/tests/AppNavigationRail.test.tsx
npm run build
```

浏览器测试脚本是 `desktop/scripts/test-figure-editor.cjs`，使用本机现有 Playwright/Chromium；可用 `SOMNIQ_BROWSER_TEST_NODE_MODULES` 指定其 node_modules。需先执行 `node scripts/prepare-figure-editor.cjs`。真实模型测试为显式 ignored 用例 `live_p0_figure_vision_preflight` 和 `live_p0_chinese_figure_smoke`，需要 `SOMNIQ_FIGURE_P0_WORKSPACE`，默认测试不会收费。

## 尚未满足的发布门槛

本轮完成首版应用链路，**没有宣布 P0/P3 质量验收通过**。还需完成其余开发图、8K/16K/32K/50K 可支持档位对照，以及与开发图隔离的 20 张留出图，报告截断率、失败、未知结果、人工编辑量与真实费用。默认 16K 仍是可配置的工程起点。

随后源码对照确认：DEV-01 原图为 900×240，生成 SVG 为 1000×250，宽高比变化约 6.67%，当前本地验收没有比例门槛；机器返回的 accepted 不能作为像素级复现的证据。当前只有文字风格设置，尚无参考图片风格迁移；新生图固定 1024×1024。现有图片历史的直接转换入口与论文插图入口尚未接线。首版独立性为 SomniQ 内一级工作区，未交付单独启动器或安装包。详见[与上游的核心对照](somniq-figures-upstream-comparison.md)。

用户随后要求实际测试更复杂的图，新增 [DEV-02 重建实验](somniq-figures-dev-02-reconstruction.md)：13 个模块、16 条逻辑关系和 2 条反馈回路可还原，1600×1000 画布保持一致；真实 SVG 的中文改字及保存重开通过。原生 PNG 字体明显比同一 SVG 的 Chromium 显示偏细，生成结果缺少主体模块分组；Reviewer 在 2K 上限截断，正式结论未知，任务保留草稿。两次核心请求输出共 12,862 token，未重发或自动扩额，不能据此宣布完整审核或降本达标。

用户指定的 [AutoFigure Case 11](somniq-figures-autofigure-case-11.md) 实际自动重建在 600 秒响应头等待后超时，结果未决、无 SVG 或 token 用量，未重发。另行交付了明确标记的手工矢量稿，并经同一 SomniQ 本地校验、PNG/PDF 导出和真实 SVG-Edit 编辑往返验证；38 类必要标签完整，组件整体移动通过，状态仍为草稿。手工稿不是自动重建成功、独立 Reviewer 通过或降本达标的证据；本例未执行 Reviewer，不能验证新的 8K 预算效果。

Chromium 证明了当前本地编辑器往返；打包后的原生 WebView2 仍需实际操作验收。CairoSVG 未被引入，首版使用 Rust 渲染链，但不同渲染器/字体显示不一致的风险仍需按计划逐项核对；当前夹具覆盖不能替代所有 SVG 元素的兼容保证。尚未实测 SomniImage 生图分支的付费端到端案例、原生安装包和当前论文编译链插入 PDF/PNG。浏览器 HTTP 开发后端尚不提供这些原生命令，当前使用面为 SomniQ Desktop。

代码和本记录纳入 Git。模型原始输出、请求账本及项目图形保留在本地 `.somniq`，不随提交上传；本轮没有发布安装包或修改用户的全局默认模型。

# 0.4.82 发布范围与验收

基线为已发布的 `v0.4.81`，发布分支为 `codex/release-0.4.82`。从当前开发目录固定产品源码快照，在独立工作区合入前一版的发布配置；原目录的分支、暂存区、未提交内容与用户输出文件保持原状。

## 主要变化

- Chat 中的 View image 直接打开可缩放图片预览，图片文件链接进入图片侧栏；不再因图片引用进入 LaTeX。
- 内置 `latex-diagrams` 技能提供流程、分支、反馈和并行检查的 TikZ / Beamer 模板。Slides 与 figure 指引接入已有 SomniImage，区分概念插图、可编辑矢量和真实实验图。
- Slides 使用单一内容源、PPTX / PDF 实际渲染、来源与运行标识、主讲与备查计时、最终独立审查门禁；缺失或过期的审查不能将产物标记完成。
- Chat 委派使用独立子会话、持久邮箱与执行记录；Project Summary 提供紧凑导航、对应对话和显式停止 / 继续。正式 Reviewer 的身份、模型与结论保持隔离。
- 改进思考与长回复期间的滚动、输入栏宽度适配、压缩后的 reasoning_content 续接、本地文件和流程标签。
- Figure 增加学科风格与示例、可调整面板和恢复草稿；Code 明确工作区信任。PDF 字符映射随安装包离线提供。
- 本地 DOCX 读取保留 Word / WPS 编辑会话并安全报告独占锁；Windows 命令工具明确实际 shell，缺少 POSIX shell 时提供 PowerShell 恢复指引。

实现与各功能此前的验收边界见同目录下 `chat-image-preview-dedup.md`、`latex-explanatory-diagrams.md`、`slide-quality-delivery.md`、`chat-collaboration-v1.md`、`chat-local-document-reading.md` 等文档。

## 发布验证

本地发布快照重新运行技能打包回归、Rust 工作区测试、Desktop 原生库测试、完整 Vitest、资源脚本、Word 转换器、Slides 交付门禁、TypeScript 和前端生产构建。具体结果由 PR checks、PR 验证说明与本地日志记录。

24 个版本来源覆盖桌面 JSON、Rust manifests、两份 Cargo.lock、npm lock 根项及中英文 README 徽章。Git 属性规范化后的产品源码与开发快照一致；文档三处 Markdown 行尾空格改为等效显式换行。用户报告、会话、输出演示文件及私有构建配置不进入发布提交。

## 发布流程和边界

推送与 PR 相同提交的 `v0.4.82` 标签，由既有 GitHub Release 工作流核对版本和托管网关 TLS，构建 Windows x64 / macOS universal 安装包、生成更新签名与合并的 `latest.json`，从 CHANGELOG 的对应版本节生成发布说明。PR 保持打开供审查。

本轮发布验证不重发付费模型请求；模型效果、真实 Word / WPS 未保存窗口操作和 Windows WebView2 交互验收不由单元测试代替。构建并上传安装包不会安装或重启用户当前的桌面应用。

详细本地日志和源码核验记录位于原工作区 `.somniq/diagnostics/release-0.4.82-*`。

# 0.4.81 发布范围与本地验收

基线为已发布的 `v0.4.80`。本次发布分支 `codex/release-0.4.81` 包含 Chat 重开定位、PDF 提取质量与证据保护、当前用户请求的授权规则、确定性工具失败恢复、DOCX 局部正文编辑及内置原生公式转换修复。

发布内容在独立工作区从 0.4.80 基线整理并重新验证。原工作区另有绘图和图片去重开发内容，保留在原处；此前开发工作区的测试统计与本次发布切片可能不同。具体实现和保护边界分别见 `chat-reopen-scroll.md`、`chat-history-reliability.md` 和 `docx-editing-accuracy.md`。

## 2026-10-08 本地验收

| 检查 | 结果 |
| --- | --- |
| Rust 工作区：offline / locked / 2 编译线程 / 串行测试 | 1,357 通过，0 失败，5 忽略 |
| Desktop 6 个 Chat / DOCX 审阅测试文件 | 149 通过 |
| TypeScript 检查、Desktop 生产构建 | 通过 |
| 真实 Chromium 滚动回归 | 通过；底部间距为零、没有误触发更早历史加载 |
| 两份 Word 公式转换器与原子保存回归 | 8 组通过 |
| Tauri 变更审阅集成 | 4 通过 |
| 发布源码摘要与版本来源 | 摘要一致，24 个版本来源均为 0.4.81 |
| Git diff 空白检查 | 通过 |

已验证的真实 DOCX 样本和源码原样进入发布切片：局部改稿保留 9 个原生公式，原始/修改后样本的 Open XML SDK 结构校验均为零错误。该结果不替代公式语义、Word/LibreOffice 页面比较或目标 Word 的编辑、保存、重开验收；本机尚未完成后者。

## 发布流程

版本同步覆盖桌面 JSON、Rust manifests、两份 Cargo.lock、npm lock 根项及中英文 README 徽章。GitHub PR 自动检查包含 Rust 工作区、macOS 构建、Chat / DOCX 审阅和两份 Word 转换器回归。

推送 `v0.4.81` 标签后，既有 Release 工作流核对版本和托管网关 TLS，构建 Windows x64 与 macOS universal 安装包、生成签名更新文件和合并 `latest.json`，使用 CHANGELOG 的 0.4.81 节生成发布说明。安装后的实际应用版本取决于用户何时安装该 Release；本次本地源码验收未替用户安装或重启桌面应用。

详细本地日志位于原工作区 `.somniq/diagnostics/release-0.4.81-*`，不随应用打包或提交。

# 🌙 SomniQ Studio — Auto Research in Sleep

```
    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
    ░  █████╗ ██████╗ ██╗███████╗            ░
    ░ ██╔══██╗██╔══██╗██║██╔════╝            ░
    ░ ███████║██████╔╝██║███████╗            ░
    ░ ██╔══██║██╔══██╗██║╚════██║            ░
    ░ ██║  ██║██║  ██║██║███████║            ░
    ░ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝           ░
    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
         🟦 [Claude]    🟩 [GPT 🕶️]
         executor  ←→  reviewer
         Studio 桌面端 · 让 AI 边睡边帮你做研究
```

![SomniQ Studio 截图](docs/screenshot.png)

> **SomniQ 的桌面应用** —— Executor 执行 · Reviewer 审查 · 迭代精进。

[![Version](https://img.shields.io/badge/version-0.4.8-blue?style=flat-square)](https://github.com/zhuyingqin/SomniQ/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/SomniQ)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[English](README.md) · **中文**


## 📰 最新动态

> **v0.4.21** (2026-07) —— Tools 表面更新：`crates/tools/src/lib.rs` (+ test)。Typeset
> 可视化编辑器迭代：`Typeset.tsx` + `TypesetVisualEditor.tsx` + `Typeset.css` + 新增
> `TypesetVisualEditor.test.ts` + `visualDecorations.ts`。Tauri 后端 (`typeset.rs`
> 主要改动 + `files.rs`)。Chat 表面更新 (`Chat.tsx`、`ChatComposer.tsx`、
> `ChatImagePreview.tsx`、`useChatRun.ts`、`useChatStream.ts` + tests)。Lab:
> `FileEditorPane.tsx` 更新。新增 `desktop/src/windowCloseGuard.ts` (+ test) ——
> 统一 Tauri shell 与内嵌浏览器视图的关闭生命周期。新增研究闭环图
> (`figures/somniq-research-loop.{md,mmd,png}`) 接入产品定位 README。API + App + 样式打磨。

> **v0.4.20** (2026-07) —— Chat 表面重构：新增 `ChatComposer` + `useChatComposer` +
> `useChatRun` hooks，扩展 `ChatMessage` 模型与测试，Settings 表面更新。Typeset 可视化编辑器
> 迭代：`Typeset.tsx` + `TypesetVisualEditor.tsx` + `Typeset.css` 重写，配合新增的
> `TypesetLibraryCopy` i18n 模块。Tauri 后端 (`commands.rs`、`env/{mod,probe}.rs`、
> `files.rs`、`lib.rs`) —— env-probe 与 file-IO 表面更新。新增 `environmentInstall.ts`
> (+ test) 用于应用内 Python / Jupyter / LaTeX 工具链提示。新增设计文档
> `docs/development-logic/edit-history-rollback.md`（基于 shadow-Git 的统一变更历史底座，
> Typeset + Chat undo 共享）。

> **v0.4.19** (2026-07) —— 移动端 PWA 打磨：新增 `chatBlocks.ts` + test（移动端聊天块渲染助手）、
> 新增 `foregroundResume.ts` + test（配对恢复后的前台 resume 路径），
> `control.ts` / `main.ts` / `transport.ts` / `remoteMarkdown.ts` /
> `workspaceNavigation.ts` / `styles.css` / SW 表面更新。桌面端 typeset + chat + Tauri 后端
> + remote-protocol 表面更新。Tools 表面更新（`crates/tools/`）。

<details>
<summary>📜 早期版本（v0.4.18 → v0.1.0，点击展开）</summary>

> **v0.4.18** (2026-07) —— Remote-mobile follow-up：`crates/remote-protocol/src/control.rs`
> 表面更新，新增 `site/remote/src/mobileViewport.ts` + test，手机 PWA 打磨
>（`control.ts` + `main.ts` + `index.html` + `styles.css` + tests）。WebRTC P2P bridge
> 打磨（`desktop/src/remote/RemoteP2pBridge.tsx`：channel retention + storage protection）。
> 桌面端表面更新（`engine.rs`、`remote.rs`、`sessions.rs` + tests）。Chat session 表面更新
> （`useChatSessions.ts` + test）。Tauri 绑定表面更新。

> **v0.4.17** (2026-07) —— 新增桌面端批准的手机远程控制：手机扫码配对后可安全查看桌面项目与对话、
> 继续指定对话，并从手机切换该对话模型。连接优先使用端到端加密的 WebRTC P2P，无法直连时自动回退到
> 端到端加密的 WSS/TCP 中继；可安装的手机 PWA 已使用正式 SomniQ 图标。

> **v0.4.16** (2026-07) —— 新 `reports` kernel 模块（CLI / runtime 用的报告渲染流水线）。新增
> `ChatNavigationTabs` + `SideTaskPanel` 桌面组件（chat 内侧任务/状态面板 + 显式导航 tab 条）。
> 新增 `latexVscodeHighlighting` 编辑器助手（VSCode 风格 LaTeX 语法 token，给 typeset 可视化编辑
> 器用）。`.github/workflows/release.yml` 流水线调整 + updater-manifest 生成器刷新。
> Runtime / Tools / Chat / Tauri 后端表面更新。Chat / Lab / Typeset / API UI 打磨。
> Notebook / knowledge / literature / studio 工具表面。

> **v0.4.15** (2026-07) —— Lab Code 页集成跨平台 PTY 终端（Windows 上用 ConPTY）：
> Rust 端 `desktop/src-tauri/src/terminal.rs` + `portable-pty` 依赖，前端
> `desktop/src/lab/Terminal.tsx` + `@xterm/xterm` + `@xterm/addon-fit`。新增 `project_intent`
> kernel 模块（与 `project_goal` 并列的意图持久化 + 推理流水线）。新增 `editor/kernelIntel.ts`
> （编辑器智能助手 —— completion / diagnostics / hover）。Notebook kernel 打磨。新增依赖：
> +@xterm/xterm、+@xterm/addon-fit、+katex、+mermaid、+pdfjs-dist。

> **v0.4.14** (2026-07) —— 新 `project_goal` kernel 模块（mission/goal 持久化 + 推理流水线）。
> 新 `editor` 桌面模块：`SharedEditor` + `editorCommands` / `editorDecorations` /
> `editorLanguages` / `editorState` / `editorTypes` / `editorView` —— 从 typeset 可视化编辑器
> 抽出。新 `ProjectBriefCard` chat 组件（在 chat 面板显示项目 mission/goal）。`AGENTS.md`
> contributor guide + `THIRD_PARTY_NOTICES.md`。CodeMirror 语言包 + `@tauri-apps/plugin-{process,updater}`
> 依赖。

> **v0.4.13** (2026-07) —— 删除 `desktop/src/sessions/Sessions.tsx`；`store.ts` 反映新的 session
> 模型。Chat 表面打磨（`Chat.tsx`、`ChatSidebar.tsx`、`ChatThread.tsx`、`i18n.ts`）。Lab / Studio
> / Onboarding / Scheduled-tasks UI 润色。`styles.css` 字体栈升级（`Inter` 主字体 + 回退链）
> + `font-synthesis: none` + `text-rendering: optimizeLegibility`。

> **v0.4.12** (2026-07) —— Chat 表面打磨（`Chat.tsx`、`ChatMessage.tsx`、`ChatSidebar.tsx`、
> `WorkflowFlow.tsx`、`i18n.ts`、`model.ts`）+ 对应测试对齐。Onboarding tutorial 步骤 +
> accent-token + reduced-motion 润色。Tauri 后端（`engine.rs`、`newapi.rs`）—— reqwest 加
> `gzip` / `brotli` / `deflate` decoder features。aris-cli + tools runtime 表面后续打磨。

> **v0.4.11** (2026-07) —— Runtime / tools / executor 表面重构（`crates/runtime` +
> `crates/tools` + `crates/executor` + `crates/chat` + `crates/commands` +
> `crates/compat-harness` + `crates/notebook` 约 60 个 Rust 文件）：hooks、process registry、
> cache、hot-memory、change-ledger、oauth、remote、usage、permissions、session_index 全面打磨。
> 测试重组：~14 个新的 `src/<area>/tests/` 子目录，把散落在源文件旁的内联测试集中到每个 crate
> 的单一 `tests/` 命名空间（knowledge / lab / literature / studio / typeset / chat / aris-cli /
> api 等）。Tauri 后端（`commands.rs`、`config.rs`、`engine.rs`、`env/cache.rs`、`files.rs`、
> `knowledge.rs`、`lab.rs`、`lib.rs`、`literature.rs`、`mail/*.rs`、`projects.rs`、
> `scheduled.rs`、`sessions.rs`、`state.rs`、`studio.rs`、`usage_log.rs`、`chat_events.rs`、
> 新增 `change_ledger.rs`）把 runtime 表面接入 desktop 命令。前端（`App.tsx`、`api/tauri.ts`、
> chat / lab / literature / studio / typeset、`styles.css`、`types.ts`）适配 runtime 重构。

> **v0.4.10** (2026-07) —— Chat：image preview 组件、run/command helpers、扩充测试覆盖。Lab：
> 文件操作 + lab 预览润色。Typeset：CodeMirror-6 decoration-based 可视化编辑器。Runtime / tools
> / executor 表面新增。aris-cli + Tauri 后端微调。清理：删除过时的 `idea-stage/v0.4.10..v0.4.13`
> 计划文档。

> **v0.4.9** (2026-07) —— Typeset 模块：Tectonic 驱动的 LaTeX 编译

> **v0.4.9** (2026-07) —— Typeset 模块：Tectonic 驱动的 LaTeX 编译（`src-tauri/src/typeset.rs`）+
> CodeMirror-6 可视化编辑器（`desktop/src/typeset/`，mathlive 数学输入，slides-main 测试样本）。
> Lab：`labEditorCore` 抽出 + lab 预览 iframe（`desktop/src/api/labPreview.ts`，
> `npm run dev:lab`）。Runtime / tools / executor 新增 tool 注册表 + OpenAI executor 打磨。Newapi
> 托管登录完整接入（Login 跳过粘贴 key；Settings = 服务端状态的投影）。Chat-stream 钩子细化，新增
> `onChatContextWarning` / `onChatToolProgress` 事件。MCP 接入 `claude` 服务端（与 `codex` 并列）。
> 视觉系统 + 图标组刷新。

> **v0.4.8** (2026-07) —— 环境探测抽出到 `src-tauri/src/env/`（Python / Jupyter / MATLAB / LaTeX，含
> 内存 session 缓存 + 磁盘指纹缓存），system prompt 外置到 `crates/runtime/assets/prompts/system.md`
>（直接改 markdown，无需重新编译 Rust），prompt pipeline 重写（`prompt.rs` +419 行），file-ops /
> bash / sandbox 打磨，把 chat-stream 逻辑抽出为 `useChatStream.{ts,test.tsx}` 钩子，接入 newapi
> 托管登录，新增 RuntimeAccess UI 面板，MarkdownContent 渲染器修复。后续 follow-up 提交再补上了
> process registry 接入 + chat-stream 细节。

> **v0.4.7** (2026-07) —— Lab MATLAB 自动发现（扫描 Windows 注册表 `HKLM` / `HKCU` / `WOW6432Node`
> 下的 MathWorks 根 + program-files 目录），Chat i18n（`chat/i18n.ts` 集中管理 `CHAT_COPY` 文案），
> system-prompt + user-prompt 检查器（`systemPromptView` / `userPromptView` Tauri 命令），onboarding
> tutorial 润色，MarkdownContent 渲染器修复，`styles.css` 大改（+652 行），新增 `Language` 类型体系。

> **v0.4.6** (2026-07) —— 邮件集成（Gmail / Graph / IMAP + OAuth2 + `atomic_file.rs`），定时任务模块
> 重写，Settings 重写（provider 卡片、role 选择器、`auth.json` / `config.toml` 编辑器、双视图 list +
> detail），newapi 托管登录 + Settings-as-projection，Lab 升级（MATLAB REPL、kernel 选择器），Chat
> stop+continue 中断架构 + `AskUserQuestion` 工具，runtime / cache / tools（knowledge、literature、
> notebook、studio）更新。

> **v0.4.5** (2026-06) —— CI 修复：把 `TAURI_SIGNING_PRIVATE_KEY` 传给 macOS 桌面任务，否则 bundle 步骤
> 会因为 updater-artifacts 检查报错。

> **v0.4.4** (2026-06) —— 依赖修复：刷新 `package-lock.json`，让 CI 的 `npm ci` 跑通（之前的 lock 文件缺
> `d3-*`、`hachure-fill`、`lodash-es` 等传递依赖）。

> **v0.4.3** (2026-06) —— Runtime：基于 LLM 的 context compaction 摘要 + ContextRing 改进；knowledge
> memory 和 session 健壮性。Desktop：ErrorBoundary、LiteratureViewTabs、onboarding tutorial 接入主导航。
> Research-review skill：LaTeX 报告模板。Notebook：MATLAB kernel + Jupyter manager 健壮性。CLI：时间线视图。

> **v0.4.2** (2026-06) —— 首次使用的 onboarding tutorial：多步聚光灯式引导走通侧栏、移动菜单、项目切换器
> 和工作区；通过 `ONBOARDING_STORAGE_KEY` + 已使用检测尊重用户的 UI 偏好；带 dark / light accent token
> 和 reduced-motion 回退。

> **v0.4.1** (2026-06) —— Release 准备：v0.4.x 线的打包与依赖对齐。

> **v0.4.0** (2026-06) —— Release 准备：v0.4.x 基线。

> **v0.3.6** (2026-06) —— 补丁发布准备。

> **v0.3.5** (2026-06) —— 发布修复：发布正确的 updater 资源 URL。

> **v0.3.4** (2026-06) —— 桌面端修复：系统未装 LaTeX 时优先使用打包内置的 Tectonic 兜底。

> **v0.3.2** (2026-06) —— 定时任务注册表（`runtime::process_registry`、桌面端 `scheduled` 模块），
> 文献库（`literatureStore.ts`）+ Literature UI 更新，Chat 测试套件（`Chat.test.tsx`），权限 / 模型
> 切换 / provider 配置修复。

> **v0.3.1** (2026-06) —— Chat：把权限请求以内联块呈现，通过 `useChatStream` 接 respond / resolved
> 回调；模型切换时刷新状态、`activeModel` 跨 session / provider 同步、支持无 Tauri 的 Browser 路径。
> Settings：每个条目持久化 provider + `base_url`，新增 DeepSeek executor preset。CLI：`--model` 在调用
> 方未传值时遵循已保存的 executor 配置。

> **v0.3.0** (2026-06) —— 记忆子系统（`hot_memory`、`knowledge_memory`、`memory_provider`、
> `session_index`），文献 PDF 阅读器（`pdfjs-dist` worker）+ KaTeX 数学渲染，chat-stream 重构
>（`useChatStream`），文献工具整合，CLI 的 config / main 围绕 kernel skills 重写，NSIS webview 安装模式。

> **v0.2.3** (2026-06) —— MCP（Model Context Protocol）集成：基于 stdio 的 MCP 客户端，配置驱动的服务
> 注册表 + 每个 server 的生命周期管理（`kernel::mcp.rs` + `runtime::mcp_stdio.rs`），Chat 接入通过调度
> 层触发 tool call，新增 MCP 页面 + RuntimeAccess 面板，`docs/mcp.md`，CLI 端对 MCP 服务注册表的能力对齐。

> **v0.2.2** (2026-06) —— 文献内核接入 OpenAlex + Scopus 搜索引擎（`search_openalex` /
> `search_scopus`、`scopus_api_key`），新增 shared-governance skill，项目焦点 + briefs 通过 kernel
> 的 save / load 持久化。

> **v0.2.0** (2026-06) —— 多项目工作区（各自独立的 sessions、runs、agents、workflows）、可读取的 PDF
> 附件用于自动 Review、Chat 中的 reasoning/"thinking" 内容、带 in-chat `/model` 切换的命令中心，以及
> 一系列加固（`LlmReview` 走 Settings 配置的 reviewer、支持 Anthropic 兼容 endpoint、Windows 子进程
> 不再弹控制台）。

> **v0.1.1** (2026-05) —— Chat UI 大改：会话历史、markdown 渲染、`@` 文件提及、有序的流式工具输出。

> **v0.1.0** (2026-05) —— 首个桌面应用：内置 Chat、带连通性检查的 Settings、skills 浏览器、持久化
> Sessions、首版 Workflow Studio + 运行监控、NSIS 打包。

</details>

> [完整 CLI Changelog →](CHANGELOG.md)


---

## ✨ SomniQ Studio 是什么？

**SomniQ Studio**（*Auto Research in Sleep*）是一个本地桌面工作台，用和 SomniQ-Code 相同的对抗式循环跑完整研究流程
（从找 idea 到论文投稿）：

- 🤖 **Executor** —— 主力 LLM：写代码、调研文献、起草论文、规划实验
- 🔍 **Reviewer** —— 独立 LLM，通过 `LlmReview` 工具批判 executor 的输出
- 🔄 **迭代** —— 写 → 批 → 改，直到质量收敛

旧的 SomniQ CLI 不再是入口；CLI / runtime 相关 crate 现在作为桌面端复用的底层库。

---

## 🚀 安装

SomniQ Studio 以 **Windows** 桌面应用形式发布（Tauri 2 + React + Vite），打包为 NSIS 安装包。

**依赖：** Windows 10/11 + WebView2 Runtime · Node.js 18+ · Rust stable（MSVC）· Visual Studio C++ Build Tools

### 从源码运行

```powershell
git clone https://github.com/zhuyingqin/SomniQ.git
cd SomniQ\desktop
npm install
npm run tauri dev
```

### 构建 Windows 安装包

```powershell
cd desktop
npm run tauri build
```

产物在 `desktop\src-tauri\target\release\` 下：`aris-desktop.exe` 与 `SomniQ Studio_0.4.8_x64-setup.exe`。

---

## ⚙️ 首次配置

首次启动会打开 **Settings**，在这里配置：

- **Executor** 与 **Reviewer** —— provider、model、base URL、API key
- **Scopus API key**、**语言**、**记忆写入审批** 与对当前模型配置的 **连通性检查**

配置保存在本地 `~/.config/SomniQ/config.json`。API key 默认在 UI 中脱敏；在本机 Settings 里点击“显示”可以临时查看明文，普通配置视图仍只返回 masked preview。

### MCP 与 Playwright

SomniQ 桌面端从当前项目的 `.mcp.json` 读取 MCP 服务器，并在 **Extensions → Plugins** 与
**Settings → Permissions & MCP** 中提供配置入口。Windows 安装包会内置
`aris-playwright-mcp` launcher、vendored `@playwright/mcp` 和 Node runtime，因此用户添加
Playwright 预设时不需要自己安装 Node.js / npm。默认预设使用 Microsoft Edge
（`--browser=msedge`）、启用 PDF 工具（`--caps=pdf`），并把浏览器 profile 与输出文件放在
`.somniq/tmp/browser/`；如需自定义浏览器参数，可在 MCP 页面编辑。

---

## 🤖 支持的 Provider

| Provider | Executor | Reviewer | 主要模型 |
|----------|:--------:|:--------:|---------|
| 🟣 Anthropic Claude | ✅ | — | claude-opus、claude-sonnet、claude-haiku |
| 🟢 OpenAI | ✅ | ✅ | gpt-5.x、o 系列 |
| 🔵 Google Gemini | ✅ | ✅ | gemini-2.5-pro、gemini-2.5-flash |
| 🔶 智谱 GLM | ✅ | ✅ | GLM-5、GLM-5-Turbo |
| 🔷 MiniMax | ✅ | ✅ | MiniMax-M2.x |
| ⚙️ OpenAI 兼容 | ✅ | ✅ | 自定义 base URL —— DeepSeek、Kimi、Qwen、LM Studio / Ollama、代理 |
| ⚙️ Anthropic 兼容 | ✅ | — | 自定义 base URL —— Claude 代理 / 中转站 |

> Claude 只能作 executor；其余 provider 既可作 executor 也可作 reviewer。经典搭配是 **Claude executor + GPT/GLM reviewer**。

---

## 🎯 核心能力

- **💬 桌面 Chat** —— 流式工具调用、有序输出、markdown、会话历史、`@` 文件提及，以及 reasoning/"thinking" 内容；会话按项目持久化。
- **🔄 对抗式 Review** —— `LlmReview` 走 Settings 中的 reviewer，executor 与 reviewer 可以是不同 provider 的不同模型。
- **📚 内置 Skills** —— 在 Skills 页浏览，或在 Chat 中通过 slash skill 调用。
- **📎 PDF 附件** —— SomniQ 通过 `read_file` 读取文本型 PDF，可直接审本地论文（文本提取，非 OCR）。
- **🗂️ 多项目** —— 在顶部切换项目，各自独立的 sessions、runs、agents、workflows。
- **🔒 本地优先** —— 配置与运行数据都留在你的机器上。

对抗式循环一图概括：

```
你（在 Chat 中）
    ↓
[Executor LLM]  ──── 调用 ────→  LlmReview 工具
  写 / 写代码                        ↓
  调研 / 分析                  [Reviewer LLM]
    ↑                           独立批判
    └──────── review 反馈 ──────┘
              迭代到质量达标
```

常用 slash-skill（完整列表见 **Skills** 页）：

```
/research-lit       /idea-discovery     /research-review
/auto-review-loop   /experiment-plan    /paper-write
/paper-compile      /rebuttal           ...
```

---

## 📖 使用示例

```
# 审论文 —— 在 Chat 附加一篇 .pdf，然后：
帮我 review 这篇论文

# 对当前项目的论文跑自主 Review 循环：
/auto-review-loop

# 文献调研：
/research-lit diffusion model 做蛋白质设计的最新工作
```

---

## 📁 配置与项目数据

```text
~/.config/SomniQ/
├── config.json                 # provider、model、base URL、key、语言
├── desktop-workspace           # 默认 workspace root
└── desktop-runtime/
    └── projects/<project-id>/
        ├── sessions/           # 聊天会话
        ├── run-state/          # 运行事件与状态
        ├── agents/             # agent/task 状态
        ├── workflows/          # 保存的计划
        └── user-workflows/     # 用户手写草稿
```

用 `ARIS_WORKSPACE_ROOT` 可覆盖默认 workspace root。CLI/runtime 在任意 workspace 下的默认 fallback 是 `<workspace>/.somniq/runtime/`，除非设置了 `ARIS_RUNTIME_ROOT` 或更具体的 `ARIS_*_DIR` 变量。

`config.json` 与 Settings 页使用同一组 snake_case 字段：

```json
{
  "executor_provider": "anthropic | anthropic-compat | openai | custom",
  "executor_model": "claude-opus-4-7",
  "executor_base_url": "https://api.example.com/v1",
  "executor_api_key": "sk-...",
  "reviewer_provider": "openai | gemini | glm | minimax | kimi | deepseek | anthropic-compat | custom",
  "reviewer_model": "gpt-5.5",
  "reviewer_base_url": "https://api.openai.com/v1",
  "reviewer_api_key": "sk-...",
  "scopus_api_key": "...",
  "language": "cn | en",
  "memory_write_approval": false
}
```

Desktop 还会维护 `verified_executors`，用于在 Chat 顶部模型下拉里恢复已经测试通过的 provider/model/base URL/key 组合。

---

## 🧱 架构

SomniQ Studio 采用「一个内核、多个外壳」的本地优先架构：所有 agent 逻辑都在共享 Rust 内核（`crates/*`）里，桌面端和手机远程只是同一内核之上的两个产品外壳。UI 从不重写 agent 逻辑——桌面前端调用本地 Tauri 后端，后端再以库调用方式进入共享 crate。

```text
┌───────────────────────── 产品外壳 ─────────────────────────┐
│  Desktop (Tauri 2)                       Mobile 远程       │
│  React + Vite 前端                        PWA + 自托管网关   │
│  src-tauri Rust 后端                                        │
└──────┬─────────────────────────────────────────┬───────────┘
       │ Tauri invoke/listen                     │ 端到端加密配对/中继
┌──────▼─────────────────────────────────────────▼───────────┐
│                 共享 Rust 内核（crates/*）                    │
│   runtime · api · executor · chat · tools                    │
│   notebook · remote-protocol · compute                      │
│   + 70 个内置科研技能（assets/skills，编译进 runtime）         │
└───────────────────────────┬─────────────────────────────────┘
┌───────────────────────────▼─────────────────────────────────┐
│  本地数据：config.json · 会话 · 运行状态 · 文献库（papers +    │
│  SQLite）· 知识库（knowledge.db）· 用量日志                    │
└─────────────────────────────────────────────────────────────┘
```

**内核 crate：**

| 路径 | 作用 |
|------|------|
| `crates/runtime/` | 内核运行时 —— 会话循环与会话存储、权限、上下文压缩、MCP 客户端、记忆 / 项目目标 / 项目意图、技能装载、PDF 文本读取 |
| `crates/api/` | Anthropic HTTP/SSE 客户端与 OAuth |
| `crates/executor/` | Provider 流式执行层 —— Anthropic 与 OpenAI 兼容请求 / 流解析，归一化为 runtime 事件（Executor 与 Reviewer 双模型都走这里）|
| `crates/chat/` | 共享 chat 装配层 —— 从 config 解析 provider，构造 executor、工具表、权限策略与系统提示词 |
| `crates/tools/` | 内核工具注册表（约 50 个）—— 文件 / shell、Web、文献检索（Scopus / OpenAlex / arXiv）、文献库 / 知识库、Notebook 执行、LaTeX 编译、agent 子代理生成 |
| `crates/notebook/` | Jupyter 内核客户端（ZMQ + nbformat）—— Lab 的执行底座 |
| `crates/remote-protocol/` | 手机远程控制的端到端加密协议原语（X25519 / Ed25519 / ChaCha20-Poly1305）|

**桌面端：**

| 路径 | 作用 |
|------|------|
| `desktop/src/` | React UI —— Chat、Lab（Jupyter / MATLAB 实验 + 终端）、Typeset（Overleaf 式 LaTeX 编辑 + 编译）、Literature（文献库 + 引用图谱 + 知识审核）、Mail（Gmail / Outlook）、Extensions、Scheduled、Settings 八个工作表面，外加登录与会话列表 |
| `desktop/src-tauri/` | Tauri 桌面后端 —— `engine`（chat 执行桥）、`lab` / `typeset` / `literature` / `knowledge` / `mail` / `scheduled` / `terminal` 各表面命令、`newapi`（托管登录）、`remote`（远程配对）、`mcp` / `connectors`、`watcher` / `usage_log` |

**远程服务（可选，自托管）：**

| 路径 | 作用 |
|------|------|
| `site/server/` | 设备配对、私有信令与加密中继（独立 Cargo workspace；不存储项目文件、聊天与中继内容）|
| `site/remote/` | 手机远程 PWA（React + Vite）|

> **设计铁律：** 产品外壳绝不 spawn 或解析另一个外壳——每个外壳都以库调用方式直接进入同一份共享 runtime。
> 参见 [shell-runtime-architecture.md](docs/development-logic/shell-runtime-architecture.md)。

---

## 🛠️ 开发

```powershell
cd desktop
npm run test        # vitest
npm run typecheck   # tsc
npm run tauri dev   # 运行 app

cd src-tauri && cargo check          # Rust 检查
cargo test -p runtime reads_pdf      # PDF 读取测试（仓库根目录）
```

---

## 🗺️ 路线图

- [x] **P0** —— 桌面 shell（Tauri 2 + React + Vite）：Chat、Settings、Sessions、Skills
- [x] **P0** —— 共享 `runtime` / `executor` / `tools` / `chat` / `commands` crate（外壳之间零耦合）
- [x] **P1** —— 多项目工作区、PDF 自动 Review 附件
- [ ] **P2** —— 生成前端 ⇄ Rust 类型契约，减少 schema 漂移
- [ ] **P2** —— macOS / Linux 桌面打包
- [ ] **P2** —— 更丰富的 team/agent 监控与工作流模板

---

## 🙏 致谢

SomniQ Studio 是 **[SomniQ-Code](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)** 的桌面 shell，
构建在 **[claw-code](https://github.com/ultraworkers/claw-code)**（Claude Code 的 Rust 复刻）之上。感谢两个团队。

---

## 📄 License

MIT License © 2026 SomniQ Contributors

---

<div align="center">
  <sub>🌙 让 AI 边睡边帮你做研究 · 用 ❤️、Rust 和 Tauri 构建</sub>
</div>

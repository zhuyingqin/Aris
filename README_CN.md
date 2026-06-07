# 🌙 ARIS Studio — Auto Research in Sleep

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

![ARIS Studio 截图](docs/screenshot.png)

> **桌面端 · 对抗 · 多智能体研究自动化工作台**
> Executor 执行 · Reviewer 审查 · 迭代精进 —— 现在搬进了本地桌面应用

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](https://github.com/zhuyingqin/Aris/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/Aris)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[English](README.md) · **中文**

> **ARIS Studio 是 ARIS 的桌面应用。** 它继承了 ARIS 原来的 Executor / Reviewer 思路，但把日常入口从命令行
> 迁移到桌面端：聊天、项目切换、技能、工作流设计、运行监控、会话、设置，以及可以被自动 Review 流程读取的 PDF
> 附件。旧的 ARIS CLI 不再作为产品入口 —— 仓库中的 CLI / runtime 相关 crate 主要作为桌面端复用的底层库存在。


## 📰 最新动态

> **v0.2.0** (2026-06) — **多项目 + PDF 审稿 release。** **🗂️ 项目上下文**：每个本地研究项目拥有独立的
> sessions、run state、agents、workflows 和用户工作流草稿，可在桌面端顶部切换。**📎 可读取的 PDF 附件**：
> 自动 Review 路径现在把本地 `.pdf` 保留为文件路径附件，skill 或 chat 可对论文 PDF 调用 `read_file` —— runtime
> 会从常见的文本型 PDF stream（Flate 压缩 stream 与 ToUnicode 字符映射）中提取正文。**🧠 桌面 thinking**：
> 推理模型的 reasoning / thinking 内容现在会在桌面 Chat 中展示。**🖥️ 命令中心**：新增桌面 slash 命令中心，
> 并支持在 Chat 内 `/model` 切换模型。**🛡️ 加固**：加固 chat 流式与 settings 路由、`LlmReview` 改走 Settings 中
> 配置的 reviewer、支持 Anthropic 兼容的自定义 endpoint，Windows runtime 子进程不再弹出控制台窗口。全程复用共享的
> ARIS runtime / executor / tools / chat crate —— 不耦合 `aris-cli`。

> **v0.1.1** (2026-05) — **Chat UI 大改。** 会话历史、markdown 渲染、`@` 文件提及、有序的流式工具输出，
> 整体打磨桌面聊天体验。

> **v0.1.0** (2026-05) — **首个 ARIS Studio 桌面应用。** 内置 Chat、Settings（provider / model 配置 +
> 连通性检查）、内置 skills 浏览器、持久化 Sessions，以及首版 Workflow Studio + 运行监控。启用 Tauri 打包
> （NSIS 安装包 + 图标）用于 Windows 发布。

> [完整 CLI Changelog →](CHANGELOG.md)


---

## ✨ ARIS Studio 是什么？

**ARIS Studio**（*Auto Research in Sleep*）是面向科研人员的桌面研究自动化工作台。它把 ARIS coordination
kernel 包进本地 UI，让你不必常驻终端就能跑完整研究流程 —— 从找 idea 到论文投稿。它的内核仍是驱动 ARIS-Code
的那套对抗式循环：

- 🤖 **Executor**：主力 LLM —— 写代码、做文献调研、起草论文、规划实验
- 🔍 **Reviewer**：独立 LLM，通过 `LlmReview` 工具对抗式批判 Executor 的输出
- 🔄 **迭代**：Executor 写 → Reviewer 批 → Executor 改 → 循环直到质量收敛

桌面端在这套循环之上额外提供：

- **Chat**：在桌面 UI 中与 ARIS executor 对话，支持流式工具调用和持久化会话。
- **Skills**：在 Skills 页浏览内置科研技能，或在 Chat 中通过 slash skill 直接调用研究流程。
- **Workflow Studio**：用可视化画布和 ARIS workflow DSL 设计工作流。
- **运行监控**：启动、暂停、恢复、取消运行，并实时查看 phase、agent、event、task、mailbox。
- **项目**：在多个本地研究项目间切换，每个项目拥有独立的运行状态。
- **PDF 附件**：在 Chat 中附加本地文件；文本型 PDF 可由 `read_file` 读取，Review 流程无需外部工具即可检查论文 PDF。

> PDF 支持是文本提取，不是 OCR。扫描版或纯图片 PDF 仍需要先做 OCR，ARIS 才能理解其中内容。

---

## 🚀 安装

ARIS Studio 目前以 **Windows** 桌面应用形式发布（Tauri 2 + React + Vite），主要打包目标是 Windows NSIS 安装包。

### 依赖

- Windows 10/11，并安装 **WebView2 Runtime**
- **Node.js** 18 或更高版本
- **Rust** stable，使用 MSVC toolchain
- **Visual Studio Build Tools**，并安装 C++ build tools

### 从源码运行

```powershell
git clone https://github.com/zhuyingqin/Aris.git
cd Aris\desktop
npm install
npm run tauri dev
```

### 构建 Windows 桌面安装包

```powershell
cd desktop
npm run tauri build
```

构建产物：

- 主程序：`desktop\src-tauri\target\release\aris-desktop.exe`
- 安装包：`desktop\src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

> 首次启动会打开 **Settings** 页，先配置 provider 再开始聊天。

---

## ⚙️ 首次配置

打开 ARIS Studio 的 **Settings** 页，可以配置：

- **Executor** 的 provider、model、base URL、API key
- **Reviewer** 的 provider、model、base URL、API key
- **UI / 输出语言**
- 对当前模型配置进行 **连通性检查**

配置文件保存在本地：

```text
~/.config/aris/config.json
```

API key 在 UI 中**只显示脱敏结果**。Tauri 后端会在本地读写密钥，前端不会拿到原始密钥。

---

## 🤖 支持的 Provider

| Provider | 作为 Executor | 作为 Reviewer | 主要模型 |
|----------|:-------------:|:-------------:|---------|
| 🟣 Anthropic Claude | ✅ | — | claude-opus、claude-sonnet、claude-haiku |
| 🟢 OpenAI | ✅ | ✅ | gpt-5.x、o 系列 |
| 🔵 Google Gemini | ✅ | ✅ | gemini-2.5-pro、gemini-2.5-flash |
| 🔶 智谱 GLM | ✅ | ✅ | GLM-5、GLM-5-Turbo |
| 🔷 MiniMax | ✅ | ✅ | MiniMax-M2.x |
| ⚙️ OpenAI 兼容 | ✅ | ✅ | 自定义 base URL —— DeepSeek、Kimi、Qwen、本地 LM Studio / Ollama、代理 |
| ⚙️ Anthropic 兼容 | ✅ | — | 自定义 base URL —— Claude 代理 / 中转站 |

> **设计说明**：Anthropic Claude 只能作为 Executor；其余 provider 既可作 Executor 也可作 Reviewer。经典搭配是
> **Claude Executor + GPT/GLM Reviewer**，构成真正的对抗式多智能体研究。自定义 base URL 可以把任一角色指向
> OpenAI 兼容或 Anthropic 兼容的 endpoint。

---

## 🎯 核心能力

### 1. 💬 桌面 Chat

在原生窗口中与 ARIS executor 对话：流式工具调用、有序工具输出、markdown 渲染、会话历史、`@` 文件提及，以及
推理模型的 reasoning / thinking 内容。会话按项目持久化，重启后仍在。

### 2. 🔄 对抗式 Executor + Reviewer

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

`LlmReview` 会走 **Settings** 中配置的 reviewer，因此 executor 和 reviewer 可以是来自不同 provider 的不同模型。

### 3. 📚 内置科研 Skills

在 **Skills** 页浏览内置技能，或在 Chat 中直接调用 slash skill。技能覆盖完整流程 —— 文献检索、找 idea、深度
Review、实验规划、论文撰写、编译、rebuttal：

```
/research-lit        — 文献检索与综述
/idea-discovery      — 完整找 idea 流程
/research-review     — 深度外部 Review
/auto-review-loop    — 自主多轮 Review 循环
/experiment-plan     — 实验路线生成
/paper-write         — LaTeX 论文撰写
/paper-compile       — 论文编译与报错修复
/rebuttal            — 投稿 rebuttal 生成
...
```

### 4. 🧩 Workflow Studio

在可视化画布上设计智能体团队工作流，底层基于 ARIS workflow DSL。计划按项目保存，用户手写草稿与生成的计划分开存放。

### 5. 📊 运行监控

启动、暂停、恢复、取消工作流运行，并实时查看：phase、agent、event、task、mailbox 随运行进度更新。

### 6. 📎 可读取的 PDF 附件

在 Chat 中附加本地文件。桌面自动 Review 路径会把 `.pdf` 保留为文件路径附件，ARIS 可以对论文 PDF 调用
`read_file` —— runtime 会从常见的文本型 PDF stream（含 Flate 压缩 stream 和 ToUnicode 字符映射）中提取正文。
因此 paper review、paper improvement、literature review 等流程可以直接在 UI 中使用本地 PDF。

### 7. 🗂️ 多项目工作区

在桌面端顶部添加并切换本地研究项目。每个项目拥有独立的 sessions、run state、agents、workflows 和用户工作流草稿。

### 8. 🔒 本地优先

配置与每个项目的运行数据都保存在你的机器上。API key 在 UI 中脱敏，且不会以原始形式返回给前端。

---

## 📖 使用示例

### 审一篇论文 PDF

```
1. 打开 Chat 页，附加一篇论文 .pdf
2. 问：「帮我 review 这篇论文」
# ARIS 对 PDF 调用 read_file，再调用 LlmReview 拿到
# 独立的对抗式批判，并迭代
```

### 自主 Review 循环

```
/auto-review-loop
# ARIS 读取当前项目中的论文并运行：
# 起草 → review → 修改 → review → …… 直到质量收敛
```

### 文献调研

```
/research-lit 查一下 diffusion model 做蛋白质设计的最新工作
```

### 设计并监控工作流

```
1. 打开 Workflow Studio，在画布上布置一个智能体团队工作流
2. 保存计划，然后在运行监控中启动
3. 实时观察 phase / agent / event / task / mailbox 更新
```

---

## 📁 配置与项目数据

```text
~/.config/aris/
├── config.json                 # Executor/Reviewer 的 provider、model、base URL、key、语言
├── desktop-workspace           # 默认 workspace root
└── desktop-runtime/
    └── projects/<project-id>/
        ├── sessions/           # 桌面端聊天会话
        ├── run-state/          # 工作流运行事件与状态
        ├── agents/             # agent / task 状态
        ├── workflows/          # 保存的工作流计划
        └── user-workflows/     # 用户编写的工作流草稿
```

高级本地部署可以用 `ARIS_WORKSPACE_ROOT` 覆盖默认 workspace root。

---

## 🧱 架构

ARIS Studio 复用 ARIS coordination kernel，而不是在前端重复实现 agent 逻辑。桌面 UI 通过 Tauri backend
调用共享 Rust crate，完成工具调用、会话、skills、chat 执行和 workflow state 管理。

```text
React + Vite 前端
        │
        │ Tauri invoke / listen
        ▼
desktop/src-tauri 后端
        │
        │ 共享 Rust crate
        ▼
crates/runtime + crates/executor + crates/tools + crates/chat + crates/commands
```

### 仓库结构

```text
desktop/             React / Tauri 桌面应用
desktop/src/         Chat、settings、skills、sessions、studio、monitor、teams
desktop/src-tauri/   Tauri commands 和桌面端后端
crates/runtime/      文件系统、权限、session、PDF 文本读取
crates/executor/     provider 客户端与流式转换
crates/tools/        agent 与桌面命令共用的工具注册表
crates/chat/         共享 chat 运行时装配
crates/commands/     共享命令解析与定义
docs/                截图和辅助文档
```

> 设计铁律：**桌面端绝不 spawn 或解析 `aris-cli`。** CLI 与 Desktop 是同一核心 runtime 之上的两个 shell，
> 共享行为放在库 crate 里。参见
> [docs/development-logic/cli-desktop-architecture.md](docs/development-logic/cli-desktop-architecture.md)。

---

## 🛠️ 开发与构建

```powershell
cd desktop
npm run test
npm run typecheck
npm run build
npm run tauri dev
npm run tauri build
```

Rust 检查：

```powershell
cd desktop\src-tauri
cargo check
```

PDF 读取回归测试在仓库根目录运行：

```powershell
cargo test -p runtime reads_pdf
```

---

## 🗺️ 路线图

- [x] **P0** — 桌面 shell（Tauri 2 + React + Vite）：Chat、Settings、Sessions、Skills 浏览器
- [x] **P0** — 共享 `runtime` / `executor` / `tools` / `chat` / `commands` crate（不耦合 `aris-cli`）
- [x] **P1** — Workflow Studio（可视化画布 + DSL）、运行监控、多项目工作区
- [x] **P1** — 可读取的 PDF 附件用于自动 Review
- [ ] **P2** — 生成前端 ⇄ Rust 类型契约，减少 schema 漂移
- [ ] **P2** — 把 `aris-cli` 中剩余的 session/config/status 命令行为下沉到共享 crate
- [ ] **P2** — macOS / Linux 桌面打包
- [ ] **P2** — 更丰富的 team/agent 监控与工作流模板

---

## 🙏 致谢

ARIS Studio 是 **[ARIS-Code](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)**
（*Auto Research in Sleep*）的桌面 shell，而后者又构建在
**[claw-code](https://github.com/ultraworkers/claw-code)** 的优秀基础之上 —— 一个开源的 Claude Code Rust
复刻，提供了 REPL 框架、工具调用基础设施和跨平台编译。在此一并致谢。

- 🔗 ARIS Studio: https://github.com/zhuyingqin/Aris
- 🔗 ARIS-Code: https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep
- 🔗 claw-code: https://github.com/ultraworkers/claw-code

---

## 📄 License

MIT License © 2026 ARIS Contributors

---

<div align="center">
  <sub>🌙 让 AI 边睡边帮你做研究 · 用 ❤️、Rust 和 Tauri 构建</sub>
</div>

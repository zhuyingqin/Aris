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

> **ARIS 的桌面应用** —— Executor 执行 · Reviewer 审查 · 迭代精进。

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](https://github.com/zhuyingqin/Aris/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/Aris)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[English](README.md) · **中文**


## 📰 最新动态

> **v0.2.0** (2026-06) —— 多项目工作区（各自独立的 sessions、runs、agents、workflows）、可读取的 PDF 附件用于
> 自动 Review、Chat 中的 reasoning/"thinking" 内容、带 in-chat `/model` 切换的命令中心，以及一系列加固
> （`LlmReview` 走 Settings 配置的 reviewer、支持 Anthropic 兼容 endpoint、Windows 子进程不再弹控制台）。

> **v0.1.1** (2026-05) —— Chat UI 大改：会话历史、markdown 渲染、`@` 文件提及、有序的流式工具输出。

> **v0.1.0** (2026-05) —— 首个桌面应用：内置 Chat、带连通性检查的 Settings、skills 浏览器、持久化 Sessions、首版 Workflow Studio + 运行监控、NSIS 打包。

> [完整 CLI Changelog →](CHANGELOG.md)


---

## ✨ ARIS Studio 是什么？

**ARIS Studio**（*Auto Research in Sleep*）是一个本地桌面工作台，用和 ARIS-Code 相同的对抗式循环跑完整研究流程
（从找 idea 到论文投稿）：

- 🤖 **Executor** —— 主力 LLM：写代码、调研文献、起草论文、规划实验
- 🔍 **Reviewer** —— 独立 LLM，通过 `LlmReview` 工具批判 executor 的输出
- 🔄 **迭代** —— 写 → 批 → 改，直到质量收敛

旧的 ARIS CLI 不再是入口；CLI / runtime 相关 crate 现在作为桌面端复用的底层库。

---

## 🚀 安装

ARIS Studio 以 **Windows** 桌面应用形式发布（Tauri 2 + React + Vite），打包为 NSIS 安装包。

**依赖：** Windows 10/11 + WebView2 Runtime · Node.js 18+ · Rust stable（MSVC）· Visual Studio C++ Build Tools

### 从源码运行

```powershell
git clone https://github.com/zhuyingqin/Aris.git
cd Aris\desktop
npm install
npm run tauri dev
```

### 构建 Windows 安装包

```powershell
cd desktop
npm run tauri build
```

产物在 `desktop\src-tauri\target\release\` 下：`aris-desktop.exe` 与 `ARIS Studio_0.2.0_x64-setup.exe`。

---

## ⚙️ 首次配置

首次启动会打开 **Settings**，在这里配置：

- **Executor** 与 **Reviewer** —— provider、model、base URL、API key
- **Scopus API key**、**语言**、**记忆写入审批** 与对当前模型配置的 **连通性检查**

配置保存在本地 `~/.config/aris/config.json`。API key 默认在 UI 中脱敏；在本机 Settings 里点击“显示”可以临时查看明文，普通配置视图仍只返回 masked preview。

### MCP 与 Playwright

ARIS 桌面端从当前项目的 `.mcp.json` 读取 MCP 服务器，并在 **Extensions → Plugins** 与
**Settings → Permissions & MCP** 中提供配置入口。Windows 安装包会内置
`aris-playwright-mcp` launcher、vendored `@playwright/mcp` 和 Node runtime，因此用户添加
Playwright 预设时不需要自己安装 Node.js / npm。默认预设使用 Microsoft Edge
（`--browser=msedge`）并启用 PDF 工具（`--caps=pdf`）；如需自定义浏览器参数，可在 MCP 页面编辑。

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
- **🧩 Workflow Studio** —— 在可视化画布上设计智能体团队工作流，底层基于 ARIS DSL。
- **📊 运行监控** —— 启动 / 暂停 / 恢复 / 取消运行，实时查看 phase、agent、event、task、mailbox。
- **📎 PDF 附件** —— ARIS 通过 `read_file` 读取文本型 PDF，可直接审本地论文（文本提取，非 OCR）。
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

跑工作流：在 **Workflow Studio** 设计并保存计划，再到 **运行监控** 启动并实时观察。

---

## 📁 配置与项目数据

```text
~/.config/aris/
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

用 `ARIS_WORKSPACE_ROOT` 可覆盖默认 workspace root。

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

ARIS Studio 复用 ARIS kernel，而不是在前端重写 agent 逻辑：UI 调用本地 Tauri 后端，后端再调用共享 Rust crate。

```text
React + Vite 前端
        │  Tauri invoke / listen
        ▼
desktop/src-tauri 后端
        │  共享 Rust crate
        ▼
crates/runtime + crates/executor + crates/tools + crates/chat + crates/commands
```

| 路径 | 作用 |
|------|------|
| `desktop/src/` | React UI —— chat、settings、skills、sessions、studio、monitor、teams |
| `desktop/src-tauri/` | Tauri commands 与桌面后端 |
| `crates/runtime/` | 文件系统、权限、session、PDF 文本读取 |
| `crates/executor/` | provider 客户端与流式 |
| `crates/tools/` | agent 与桌面命令共用的工具注册表 |
| `crates/chat/` | 共享 chat 运行时装配 |
| `crates/commands/` | 共享命令解析与定义 |

> **设计铁律：** 桌面端绝不 spawn 或解析 `aris-cli` —— CLI 与 Desktop 是同一核心 runtime 之上的两个 shell。
> 参见 [cli-desktop-architecture.md](docs/development-logic/cli-desktop-architecture.md)。

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
- [x] **P0** —— 共享 `runtime` / `executor` / `tools` / `chat` / `commands` crate（不耦合 `aris-cli`）
- [x] **P1** —— Workflow Studio、运行监控、多项目工作区、PDF 自动 Review 附件
- [ ] **P2** —— 生成前端 ⇄ Rust 类型契约，减少 schema 漂移
- [ ] **P2** —— macOS / Linux 桌面打包
- [ ] **P2** —— 更丰富的 team/agent 监控与工作流模板

---

## 🙏 致谢

ARIS Studio 是 **[ARIS-Code](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)** 的桌面 shell，
构建在 **[claw-code](https://github.com/ultraworkers/claw-code)**（Claude Code 的 Rust 复刻）之上。感谢两个团队。

---

## 📄 License

MIT License © 2026 ARIS Contributors

---

<div align="center">
  <sub>🌙 让 AI 边睡边帮你做研究 · 用 ❤️、Rust 和 Tauri 构建</sub>
</div>

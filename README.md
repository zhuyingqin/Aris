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
         Studio Desktop · Let AI do research while you sleep
```

![ARIS Studio Screenshot](docs/screenshot.png)

> **Desktop · Adversarial · Multi-Agent Research Automation Workspace**
> Executor acts · Reviewer critiques · Iterate to excellence — now in a local desktop app

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](https://github.com/zhuyingqin/Aris/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/Aris)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**English** · [中文](README_CN.md)

> **ARIS Studio is the desktop application for ARIS.** It keeps the executor/reviewer idea from the
> original ARIS research agent, but moves the daily experience out of the terminal and into a local
> Tauri app: chat, project switching, skills, workflow design, run monitoring, sessions, settings, and
> PDF-readable review attachments. The legacy ARIS CLI is no longer the product entry point — the
> remaining CLI/runtime crates are treated as shared libraries for the desktop app.


## 📰 What's New

> **v0.2.0** (2026-06) — **Multi-project + PDF-review release.** **🗂️ Project contexts**: each local
> research project keeps its own sessions, run state, agents, workflows, and user workflow drafts, and you
> switch between them from the desktop header. **📎 PDF-readable attachments**: the auto-review path now
> preserves local `.pdf` attachments as file-path attachments, so a skill or chat turn can call `read_file`
> on a paper PDF — the runtime extracts text from common text-based PDF streams (Flate-compressed streams
> and ToUnicode character maps). **🧠 Desktop thinking**: reasoning/thinking content from reasoning models
> is surfaced in desktop Chat. **🖥️ Command center**: a desktop slash-command center plus `/model` switching
> inside Chat. **🛡️ Hardening**: chat streaming and settings routing hardened, `LlmReview` routed through the
> configured Settings reviewer, Anthropic-compatible custom endpoints supported, and Windows runtime child
> processes no longer flash console windows. Reuses the shared ARIS runtime/executor/tools/chat crates — no
> coupling to `aris-cli`.

> **v0.1.1** (2026-05) — **Chat UI overhaul.** Conversation history, markdown rendering, `@`-file mentions,
> and ordered streamed tool output, on top of a polished desktop chat experience.

> **v0.1.0** (2026-05) — **First ARIS Studio desktop app.** In-app Chat, Settings (provider/model
> configuration + connection checks), a bundled skills browser, persisted Sessions, and the first Workflow
> Studio + run monitor. Tauri bundling (NSIS installer + icons) enabled for Windows releases.

> [Full CLI Changelog →](CHANGELOG.md)


---

## ✨ What is ARIS Studio?

**ARIS Studio** (*Auto Research in Sleep*) is a desktop research-automation workspace for academic
researchers. It wraps the ARIS coordination kernel in a local UI so you can run the full research
pipeline — idea discovery to paper submission — without living in a terminal. Its core philosophy is the
same adversarial loop that powers ARIS-Code:

- 🤖 **Executor**: The primary LLM — writes code, surveys literature, drafts papers, plans experiments
- 🔍 **Reviewer**: An independent LLM that adversarially critiques the Executor's output via the `LlmReview` tool
- 🔄 **Iterate**: Executor writes → Reviewer critiques → Executor revises → loop until quality converges

What the desktop adds on top of that loop:

- **Chat** with the ARIS executor from a desktop UI, with streamed tool calls and persisted sessions.
- **Skills** — browse bundled research skills and invoke slash-skill workflows directly from Chat.
- **Workflow Studio** — design workflows with a visual graph and the ARIS workflow DSL.
- **Run Monitor** — start, pause, resume, cancel, and watch runs with live phase, agent, event, task, and mailbox views.
- **Projects** — switch between local research projects, each with isolated runtime state.
- **PDF attachments** — attach local files to Chat; text PDFs are readable by `read_file` so review flows can inspect paper PDFs without an external utility.

> PDF support is text extraction, not OCR. Scanned or image-only PDFs still need OCR before ARIS can reason over their contents.

---

## 🚀 Installation

ARIS Studio currently ships as a **Windows** desktop app (Tauri 2 + React + Vite). The primary bundle
target is the Windows NSIS installer.

### Prerequisites

- Windows 10/11 with the **WebView2 Runtime**
- **Node.js** 18 or newer
- **Rust** stable with the MSVC toolchain
- **Visual Studio Build Tools** with the C++ build tools installed

### Build and run from source

```powershell
git clone https://github.com/zhuyingqin/Aris.git
cd Aris\desktop
npm install
npm run tauri dev
```

### Create the Windows desktop bundle

```powershell
cd desktop
npm run tauri build
```

The release build produces:

- App executable: `desktop\src-tauri\target\release\aris-desktop.exe`
- Windows installer: `desktop\src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

> First launch opens the **Settings** tab so you can configure providers before chatting.

---

## ⚙️ First-Run Setup

Open the **Settings** tab in ARIS Studio to configure:

- **Executor** provider, model, base URL, and API key
- **Reviewer** provider, model, base URL, and API key
- **UI / output language**
- **Connectivity checks** for the configured models

Configuration is stored locally at:

```text
~/.config/aris/config.json
```

API keys are **masked in the UI**. They are read and written locally by the Tauri backend and are not
returned to the frontend as raw secrets.

---

## 🤖 Supported Providers

| Provider | As Executor | As Reviewer | Key Models |
|----------|:-----------:|:-----------:|-----------|
| 🟣 Anthropic Claude | ✅ | — | claude-opus, claude-sonnet, claude-haiku |
| 🟢 OpenAI | ✅ | ✅ | gpt-5.x, o-series |
| 🔵 Google Gemini | ✅ | ✅ | gemini-2.5-pro, gemini-2.5-flash |
| 🔶 Zhipu GLM | ✅ | ✅ | GLM-5, GLM-5-Turbo |
| 🔷 MiniMax | ✅ | ✅ | MiniMax-M2.x |
| ⚙️ OpenAI-compatible | ✅ | ✅ | custom base URL — DeepSeek, Kimi, Qwen, local LM Studio / Ollama, proxies |
| ⚙️ Anthropic-compatible | ✅ | — | custom base URL — Claude proxies / relays |

> **Design note**: Anthropic Claude is Executor-only; all other providers can serve as both Executor and
> Reviewer. The classic pairing is **Claude Executor + GPT/GLM Reviewer** for true adversarial multi-agent
> research. Custom base URLs let you point either role at an OpenAI- or Anthropic-compatible endpoint.

---

## 🎯 Key Features

### 1. 💬 Desktop Chat

Talk to the ARIS executor from a native window: streamed tool calls, ordered tool output, markdown
rendering, conversation history, `@`-file mentions, and reasoning/thinking content from reasoning models.
Sessions are persisted per project and survive restarts.

### 2. 🔄 Adversarial Executor + Reviewer

```
You (in Chat)
    ↓
[Executor LLM]  ──── calls ────→  LlmReview Tool
  write / code                         ↓
  research / analyze             [Reviewer LLM]
    ↑                             independent critique
    └──────── review feedback ───┘
              iterate until quality target met
```

`LlmReview` is routed through the reviewer configured in **Settings**, so the executor and reviewer can be
different models from different providers.

### 3. 📚 Bundled Research Skills

Browse the bundled skills in the **Skills** tab, or invoke a slash-skill directly from Chat. Skills cover
the full pipeline — literature search, idea discovery, deep review, experiment planning, paper writing,
compilation, and rebuttal:

```
/research-lit        — Literature search & survey
/idea-discovery      — Full idea discovery pipeline
/research-review     — Deep external review
/auto-review-loop    — Autonomous multi-round review loop
/experiment-plan     — Experiment roadmap generation
/paper-write         — LaTeX paper drafting
/paper-compile       — Paper compilation & error fixing
/rebuttal            — Submission rebuttal generation
...
```

### 4. 🧩 Workflow Studio

Design agent-team workflows on a visual canvas backed by the ARIS workflow DSL. Plans are saved per
project, and user-authored drafts are kept separately from generated plans.

### 5. 📊 Run Monitor

Start, pause, resume, and cancel workflow runs, then watch them live: phase, agent, event, task, and
mailbox views update as the run progresses.

### 6. 📎 PDF-Readable Attachments

Attach local files to Chat. The desktop auto-review path preserves `.pdf` attachments as file-path
attachments, so ARIS can call `read_file` on a paper PDF — the runtime extracts text from common
text-based PDF streams, including Flate-compressed streams and ToUnicode character maps. This makes paper
review, paper improvement, and literature review work with local PDFs directly in the UI.

### 7. 🗂️ Multi-Project Workspace

Add and switch between local research projects from the desktop header. Each project keeps its own
sessions, run state, agents, workflows, and user workflow drafts.

### 8. 🔒 Local-First

Configuration and per-project runtime data stay on your machine. API keys are masked in the UI and never
returned to the frontend as raw secrets.

---

## 📖 Usage Examples

### Review a paper PDF

```
1. Open the Chat tab and attach a paper .pdf
2. Ask: "Please review this paper for me"
# ARIS calls read_file on the PDF, then LlmReview for an
# independent adversarial critique, and iterates
```

### Autonomous review loop

```
/auto-review-loop
# ARIS reads the paper in the current project and runs:
# draft → review → revise → review → ... until quality converges
```

### Literature survey

```
/research-lit find the latest work on diffusion models for protein design
```

### Design and monitor a workflow

```
1. Open Workflow Studio and lay out an agent-team workflow on the canvas
2. Save the plan, then start it from the Run Monitor
3. Watch phase / agent / event / task / mailbox updates live
```

---

## 📁 Configuration & Project Data

```text
~/.config/aris/
├── config.json                 # Executor/Reviewer providers, models, base URLs, keys, language
├── desktop-workspace           # Default workspace root
└── desktop-runtime/
    └── projects/<project-id>/
        ├── sessions/           # desktop chat sessions
        ├── run-state/          # workflow run events and status
        ├── agents/             # agent/task state
        ├── workflows/          # saved workflow plans
        └── user-workflows/     # user-authored workflow drafts
```

`ARIS_WORKSPACE_ROOT` can override the default workspace root for advanced local setups.

---

## 🧱 Architecture

ARIS Studio reuses the ARIS coordination kernel rather than duplicating agent logic in the frontend. The
desktop UI sends commands to the local Tauri backend, which calls the shared Rust crates for tools,
sessions, skills, chat execution, and workflow state.

```text
React + Vite frontend
        │
        │ Tauri invoke / listen
        ▼
desktop/src-tauri backend
        │
        │ shared Rust crates
        ▼
crates/runtime + crates/executor + crates/tools + crates/chat + crates/commands
```

### Repository layout

```text
desktop/             React/Tauri desktop application
desktop/src/         Chat, settings, skills, sessions, studio, monitor, teams
desktop/src-tauri/   Tauri commands and desktop backend
crates/runtime/      Filesystem, permissions, session, and PDF text utilities
crates/executor/     Provider clients and streaming conversion
crates/tools/        Tool registry used by agents and desktop commands
crates/chat/         Shared chat runtime assembly
crates/commands/     Shared command parsing and specs
docs/                Screenshots and supporting docs
```

> Design rule: **Desktop must never spawn or parse `aris-cli`.** CLI and Desktop are two shells over the
> same core runtime; shared behavior lives in the library crates. See
> [docs/development-logic/cli-desktop-architecture.md](docs/development-logic/cli-desktop-architecture.md).

---

## 🛠️ Development

```powershell
cd desktop
npm run test
npm run typecheck
npm run build
npm run tauri dev
npm run tauri build
```

Rust checks:

```powershell
cd desktop\src-tauri
cargo check
```

PDF extraction regression tests run from the repository root:

```powershell
cargo test -p runtime reads_pdf
```

---

## 🗺️ Roadmap

- [x] **P0** — Desktop shell (Tauri 2 + React + Vite): Chat, Settings, Sessions, Skills browser
- [x] **P0** — Shared `runtime` / `executor` / `tools` / `chat` / `commands` crates (no `aris-cli` coupling)
- [x] **P1** — Workflow Studio (visual graph + DSL), Run Monitor, multi-project workspace
- [x] **P1** — PDF-readable attachments for auto-review
- [ ] **P2** — Generated frontend ⇄ Rust type contracts to reduce schema drift
- [ ] **P2** — Move remaining session/config/status command behavior out of `aris-cli` into shared crates
- [ ] **P2** — macOS / Linux desktop bundles
- [ ] **P2** — Richer team/agent monitoring and workflow templates

---

## 🙏 Credits & Acknowledgements

ARIS Studio is the desktop shell for **[ARIS-Code](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)**
(*Auto Research in Sleep*), which in turn is built on the excellent foundation of
**[claw-code](https://github.com/ultraworkers/claw-code)** — an open-source Rust reimplementation of Claude
Code that provided the REPL framework, tool-calling infrastructure, and cross-platform compilation. Huge
thanks to both teams.

- 🔗 ARIS Studio: https://github.com/zhuyingqin/Aris
- 🔗 ARIS-Code: https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep
- 🔗 claw-code: https://github.com/ultraworkers/claw-code

---

## 📄 License

MIT License © 2026 ARIS Contributors

---

<div align="center">
  <sub>🌙 Let AI do research while you sleep · Built with ❤️, Rust, and Tauri</sub>
</div>

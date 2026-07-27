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
         Studio Desktop · Let AI do research while you sleep
```

![SomniQ Studio Screenshot](docs/screenshot.png)

> **The desktop app for SomniQ** — Executor acts · Reviewer critiques · Iterate to excellence.

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](https://github.com/zhuyingqin/SomniQ/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/SomniQ)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**English** · [中文](README_CN.md)


## 📰 What's New

> **v0.4.21** (2026-07) — Tools surface refinement: `crates/tools/src/lib.rs` (+ test). Typeset
> visual-editor iteration: `Typeset.tsx` + `TypesetVisualEditor.tsx` + `Typeset.css` + new
> `TypesetVisualEditor.test.ts` + `visualDecorations.ts`. Tauri backend (`typeset.rs` major +
> `files.rs`). Chat surface updates (`Chat.tsx`, `ChatComposer.tsx`, `ChatImagePreview.tsx`,
> `useChatRun.ts`, `useChatStream.ts` + tests). Lab: `FileEditorPane.tsx` refinement. New:
> `desktop/src/windowCloseGuard.ts` (+ test) — single close lifecycle for the Tauri shell and
> the embedded browser view. New research-loop diagram
> (`figures/somniq-research-loop.{md,mmd,png}`) wired into the product-positioning README.
> API + App + styles polish.

> **v0.4.20** (2026-07) — Chat surface refactor: new `ChatComposer` + `useChatComposer` +
> `useChatRun` hooks, expanded `ChatMessage` model + tests, and Settings refinements.
> Typeset visual-editor iteration: `Typeset.tsx` + `TypesetVisualEditor.tsx` + `Typeset.css`
> rewrite with the new `TypesetLibraryCopy` i18n module. Tauri backend (`commands.rs`,
> `env/{mod,probe}.rs`, `files.rs`, `lib.rs`) — env-probe and file-IO refinements. New
> `environmentInstall.ts` (+ test) for in-app Python / Jupyter / LaTeX toolchain prompts.
> New design doc: `docs/development-logic/edit-history-rollback.md` (shadow-Git single source
> of truth for Typeset + Chat undo).

> **v0.4.19** (2026-07) — Mobile PWA refinements: new `chatBlocks.ts` + test (mobile chat block
> rendering helpers), new `foregroundResume.ts` + test (foreground resume after pairing
> recovery), and `control.ts` / `main.ts` / `transport.ts` / `remoteMarkdown.ts` /
> `workspaceNavigation.ts` / `styles.css` / SW refinements. Desktop typeset + chat + Tauri
> backend + remote-protocol surface updates. Tools surface refinement (`crates/tools/`).

<details>
<summary>📜 Earlier releases (v0.4.18 → v0.1.0)</summary>

> **v0.4.18** (2026-07) — Remote-mobile follow-up: `crates/remote-protocol/src/control.rs`
> refinement, new `services/remote-mobile/src/mobileViewport.ts` + test, phone PWA
> refinements (`control.ts` + `main.ts` + `index.html` + `styles.css` + tests). WebRTC P2P
> bridge refinements (`desktop/src/remote/RemoteP2pBridge.tsx`: channel retention + storage
> protection). Desktop-side surface updates (`engine.rs`, `remote.rs`, `sessions.rs` + tests).
> Chat session surface update (`useChatSessions.ts` + test). Tauri bindings refinement.

> **v0.4.17** (2026-07) — Desktop-approved mobile remote control: pair a phone by QR code,
> then securely browse desktop projects and conversations, continue a selected chat, and switch
> its model from the phone. The connection prefers encrypted WebRTC P2P and automatically falls
> back to an end-to-end encrypted WSS/TCP relay. The installable phone PWA now uses the official
> SomniQ icon.

> **v0.4.16** (2026-07) — `reports` kernel module (report-rendering pipeline consumed by CLI /
> runtime). New desktop components: `ChatNavigationTabs` + `SideTaskPanel` (in-chat side-task /
> status panel + explicit nav tab strip). New editor helper `latexVscodeHighlighting`
> (VSCode-style LaTeX syntax tokens for the typeset visual editor). `.github/workflows/release.yml`
> refinement + updater-manifest generator refresh. Runtime / Tools / Chat / Tauri backend
> surface updates. Chat / Lab / Typeset / API UI refinements. Notebook / knowledge / literature
> / studio tool surface.

> **v0.4.15** (2026-07) — Integrated cross-platform PTY terminal (ConPTY on Windows) for the Lab
> Code page: `desktop/src-tauri/src/terminal.rs` + `portable-pty` dep paired with
> `desktop/src/lab/Terminal.tsx` + `@xterm/xterm` + `@xterm/addon-fit`. New `project_intent`
> kernel module (intent persistence + inference pipeline) alongside `project_goal`. New
> `editor/kernelIntel.ts` (editor intelligence helpers — completion / diagnostics / hover).
> Notebook kernel refinements. New deps: +@xterm/xterm, +@xterm/addon-fit, +katex, +mermaid,
> +pdfjs-dist.

> **v0.4.14** (2026-07) — New `project_goal` kernel module (mission/goal persistence + inference
> pipeline). New `editor` desktop module: `SharedEditor` + `editorCommands` / `editorDecorations` /
> `editorLanguages` / `editorState` / `editorTypes` / `editorView` — extracted from the typeset
> visual editor. New `ProjectBriefCard` chat component. `AGENTS.md` contributor guide +
> `THIRD_PARTY_NOTICES.md`. CodeMirror language plugins +
> `@tauri-apps/plugin-{process,updater}` deps.

> **v0.4.13** (2026-07) — `desktop/src/sessions/Sessions.tsx` removed; `store.ts` reflects the new
> session model. Chat surface polish. Lab / Studio / Onboarding / Scheduled-tasks UI refinements.
> `styles.css` font-stack upgrade (`Inter` → fallback chain) +
> `font-synthesis: none` + `text-rendering: optimizeLegibility`.

> **v0.4.12** (2026-07) — Chat surface polish (`Chat.tsx`, `ChatMessage.tsx`, `ChatSidebar.tsx`,
> `WorkflowFlow.tsx`, `i18n.ts`, `model.ts`) + matching test alignment. Onboarding tutorial
> step + accent-token + reduced-motion tweaks. Tauri backend (`engine.rs`, `newapi.rs`) —
> reqwest gains `gzip` / `brotli` / `deflate` decoder features. aris-cli + tools runtime
> surface follow-up.

> **v0.4.11** (2026-07) — Runtime / tools / executor surface refactor (~60 Rust files):
> hooks, process registry, cache, hot-memory, change-ledger, oauth, remote, usage,
> permissions, and session_index refinements. Test reorganisation: ~14 new
> `src/<area>/tests/` sub-directories.

> **v0.4.10** (2026-07) — Chat image preview component + run/command helpers. Lab file ops +
> preview polish. Typeset CodeMirror-6 decoration-based visual editor. aris-cli + Tauri backend
> tweaks.

> **v0.4.9** (2026-07) — Typeset module: Tectonic-backed LaTeX compile + CodeMirror-6 visual
> editor. Lab: `labEditorCore` extraction + lab preview iframe. Newapi managed-login wired
> (Settings = projection of server state). MCP `claude` server registered.

> **v0.4.8** (2026-07) — Env-probe extraction (`src-tauri/src/env/`). System prompt
> externalized (`crates/runtime/assets/prompts/system.md`). Prompt pipeline rework.
> Chat-stream hook extraction (`useChatStream`). Newapi managed-login integration.

> **v0.4.7** (2026-07) — Lab MATLAB auto-discovery. Chat i18n (`chat/i18n.ts`). System-prompt +
> user-prompt inspectors. Onboarding tutorial polish. `styles.css` overhaul.

> **v0.4.6** (2026-07) — Mail integration (Gmail / Graph / IMAP + OAuth2 + `atomic_file.rs`).
> Scheduled tasks module rewrite. Settings rewrite (provider cards, role pickers). Newapi
> managed login + Settings-as-projection. Lab MATLAB REPL. Chat stop+continue +
> `AskUserQuestion`.

> **v0.4.5** (2026-06) — CI fix: pass `TAURI_SIGNING_PRIVATE_KEY` to the macOS desktop job.

> **v0.4.4** (2026-06) — Deps fix: refresh `package-lock.json` so `npm ci` succeeds in CI.

> **v0.4.3** (2026-06) — Runtime LLM-based context compaction + ContextRing improvements.
> Desktop: ErrorBoundary, LiteratureViewTabs, onboarding tutorial. Notebook MATLAB kernel.

> **v0.4.2** (2026-06) — First-time onboarding tutorial.

> **v0.4.1** (2026-06) — Release prep: packaging + dependency alignment.

> **v0.4.0** (2026-06) — Release prep: v0.4.x baseline.

> **v0.3.6** (2026-06) — Patch release prep.

> **v0.3.5** (2026-06) — Release fix: publish correct updater asset URLs.

> **v0.3.4** (2026-06) — Desktop fix: prefer bundled Tectonic fallback when system LaTeX is
> unavailable.

> **v0.3.2** (2026-06) — Scheduled task registry, literature store, Chat test suite.

> **v0.3.1** (2026-06) — Chat permission inline blocks + model-switch sync.

> **v0.3.0** (2026-06) — Memory subsystem, literature PDF reader + KaTeX, `useChatStream`
> refactor.

> **v0.2.3** (2026-06) — MCP (Model Context Protocol) integration: stdio MCP client.

> **v0.2.2** (2026-06) — OpenAlex + Scopus search engines wired into the literature kernel.

> **v0.2.0** (2026-06) — Multi-project workspaces (each keeps its own sessions, runs, agents, and
> workflows), PDF-readable attachments for auto-review, reasoning/"thinking" content in Chat, a
> slash-command center with in-chat `/model` switching, and hardening (Settings-routed `LlmReview`,
> Anthropic-compatible endpoints, no Windows console flashes).

> **v0.1.1** (2026-05) — Chat UI overhaul: history, markdown rendering, `@`-file mentions, ordered streamed tool output.

> **v0.1.0** (2026-05) — First desktop app: in-app Chat, Settings with connection checks, skills browser, persisted Sessions, first Workflow Studio + Run Monitor, NSIS bundling.

</details>

> [Full CLI Changelog →](CHANGELOG.md)


---

## ✨ What is SomniQ Studio?

**SomniQ Studio** is a local desktop workspace that runs the full research
pipeline — idea discovery to paper submission — on the same adversarial loop as SomniQ-Code:

- 🤖 **Executor** — the primary LLM: writes code, surveys literature, drafts papers, plans experiments
- 🔍 **Reviewer** — an independent LLM that critiques the executor via the `LlmReview` tool
- 🔄 **Iterate** — write → critique → revise, until quality converges

The legacy SomniQ CLI is no longer the entry point; the CLI/runtime crates are now shared libraries for the
desktop app.

---

## 🚀 Installation

SomniQ Studio ships as a **Windows** desktop app (Tauri 2 + React + Vite), bundled as an NSIS installer.

**Prerequisites:** Windows 10/11 with WebView2 Runtime · Node.js 18+ · Rust stable (MSVC) · Visual Studio C++ Build Tools

### Build and run from source

```powershell
git clone https://github.com/zhuyingqin/SomniQ.git
cd SomniQ\desktop
npm install
npm run tauri dev
```

### Build the Windows bundle

```powershell
cd desktop
npm run tauri build
```

Outputs `aris-desktop.exe` and `SomniQ Studio_0.2.0_x64-setup.exe` under `desktop\src-tauri\target\release\`.

---

## ⚙️ First-Run Setup

First launch opens **Settings**, where you configure:

- **Executor** and **Reviewer** — provider, model, base URL, API key
- **Language** and **connectivity checks** for the configured models

Config is stored locally at `~/.config/SomniQ/config.json`. API keys are masked in the UI — the Tauri
backend reads/writes them locally and never returns raw secrets to the frontend.

---

## 🤖 Supported Providers

| Provider | Executor | Reviewer | Key Models |
|----------|:--------:|:--------:|-----------|
| 🟣 Anthropic Claude | ✅ | — | claude-opus, claude-sonnet, claude-haiku |
| 🟢 OpenAI | ✅ | ✅ | gpt-5.x, o-series |
| 🔵 Google Gemini | ✅ | ✅ | gemini-2.5-pro, gemini-2.5-flash |
| 🔶 Zhipu GLM | ✅ | ✅ | GLM-5, GLM-5-Turbo |
| 🔷 MiniMax | ✅ | ✅ | MiniMax-M2.x |
| ⚙️ OpenAI-compatible | ✅ | ✅ | custom base URL — DeepSeek, Kimi, Qwen, LM Studio / Ollama, proxies |
| ⚙️ Anthropic-compatible | ✅ | — | custom base URL — Claude proxies / relays |

> Claude is executor-only; every other provider can be executor *or* reviewer. The classic pairing is
> **Claude executor + GPT/GLM reviewer**.

---

## 🎯 Key Features

- **💬 Desktop Chat** — streamed tool calls, ordered output, markdown, history, `@`-file mentions, and reasoning/"thinking" content; sessions persist per project.
- **🔄 Adversarial review** — `LlmReview` runs the reviewer from Settings, so executor and reviewer can be different models from different providers.
- **📚 Bundled skills** — browse them in the Skills tab or invoke a slash-skill from Chat.
- **🧩 Workflow Studio** — design agent-team workflows on a visual canvas backed by the SomniQ DSL.
- **📊 Run Monitor** — start, pause, resume, and cancel runs; watch phase, agent, event, task, and mailbox views live.
- **📎 PDF attachments** — SomniQ reads text PDFs via `read_file`, so paper review works on local files (text extraction, not OCR).
- **🗂️ Multi-project** — switch projects from the header; each keeps its own sessions, runs, agents, and workflows.
- **🔒 Local-first** — config and runtime data stay on your machine.

The adversarial loop, in short:

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

Common slash-skills (full set in the **Skills** tab):

```
/research-lit       /idea-discovery     /research-review
/auto-review-loop   /experiment-plan    /paper-write
/paper-compile      /rebuttal           ...
```

---

## 📖 Usage Examples

```
# Review a paper — attach a .pdf in Chat, then:
Please review this paper for me

# Autonomous review loop on the current project's paper:
/auto-review-loop

# Literature survey:
/research-lit latest work on diffusion models for protein design
```

To run a workflow: design it in **Workflow Studio**, save the plan, then start and watch it from the **Run Monitor**.

---

## 📁 Configuration & Project Data

```text
~/.config/SomniQ/
├── config.json                 # providers, models, base URLs, keys, language
├── desktop-workspace           # default workspace root
└── desktop-runtime/
    └── projects/<project-id>/
        ├── sessions/           # chat sessions
        ├── run-state/          # run events and status
        ├── agents/             # agent/task state
        ├── workflows/          # saved plans
        └── user-workflows/     # user-authored drafts
```

Set `ARIS_WORKSPACE_ROOT` to override the default workspace root. CLI/runtime fallbacks for an
arbitrary workspace use `<workspace>/.somniq/runtime/` unless `ARIS_RUNTIME_ROOT` or a more
specific `ARIS_*_DIR` variable is set.

---

## 🧱 Architecture

SomniQ Studio follows a local-first "one kernel, many shells" architecture: all agent logic lives in the shared
Rust kernel (`crates/*`), and Desktop, CLI, and mobile remote are three product shells over that same kernel.
The UI never reimplements agent logic — the desktop frontend calls the local Tauri backend, which calls the
shared crates as libraries.

```text
┌──────────────────────── Product shells ────────────────────────┐
│  Desktop (Tauri 2)        CLI (aris)      Mobile remote        │
│  React + Vite frontend    terminal UI     PWA + self-hosted    │
│  src-tauri Rust backend                   gateway              │
└──────┬──────────────────────┬──────────────────┬───────────────┘
       │ Tauri invoke/listen  │ library calls    │ E2E-encrypted pairing/relay
┌──────▼──────────────────────▼──────────────────▼───────────────┐
│                Shared Rust kernel (crates/*)                   │
│   runtime · api · executor · chat · tools · commands           │
│   notebook · remote-protocol · compat-harness                  │
│   + 70 bundled research skills (assets/skills, compiled in)    │
└───────────────────────────┬────────────────────────────────────┘
┌───────────────────────────▼────────────────────────────────────┐
│  Local data: config.json · sessions · run state · paper        │
│  library (papers + SQLite) · knowledge base (knowledge.db)     │
│  · usage log                                                   │
└────────────────────────────────────────────────────────────────┘
```

**Kernel crates:**

| Path | Role |
|------|------|
| `crates/runtime/` | Kernel runtime — conversation loop and session storage, permissions, context compaction, MCP client, memory / project goal / project intent, skill loading, PDF text extraction |
| `crates/api/` | Anthropic HTTP/SSE client and OAuth |
| `crates/executor/` | Provider streaming layer — Anthropic and OpenAI-compatible request/stream parsing, normalized into runtime events (both the Executor and the Reviewer model go through here) |
| `crates/chat/` | Shared chat assembly — resolves providers from config and builds the executor, tool table, permission policy, and system prompt |
| `crates/tools/` | Kernel tool registry (~50 tools) — file/shell, web, literature search (Scopus / OpenAlex / arXiv), literature/knowledge/Studio library writes, notebook execution, LaTeX compile, agent/team/workflow coordination |
| `crates/commands/` | Slash command specs and parsing |
| `crates/notebook/` | Jupyter kernel client (ZMQ + nbformat) — the execution substrate for Lab |
| `crates/remote-protocol/` | End-to-end encryption primitives for mobile remote control (X25519 / Ed25519 / ChaCha20-Poly1305) |
| `crates/aris-cli/` | Terminal shell (the `aris` command) |
| `crates/compat-harness/` | Upstream Claude Code command/tool manifest extraction for audit comparison |

**Desktop:**

| Path | Role |
|------|------|
| `desktop/src/` | React UI — nine surfaces: Chat, Lab (Jupyter / MATLAB experiments + terminal), Typeset (Overleaf-style LaTeX editing + compile), Literature (paper library + citation graph + knowledge review), Studio (slides/poster review), Mail (Gmail / Outlook), Extensions, Scheduled, Settings — plus login and the session list |
| `desktop/src-tauri/` | Tauri desktop backend — `engine` (chat execution bridge), per-surface commands (`lab` / `typeset` / `literature` / `knowledge` / `studio` / `mail` / `scheduled` / `terminal`), `newapi` (managed login), `remote` (device pairing), `mcp` / `connectors`, `watcher` / `usage_log` |

**Remote services (optional, self-hosted):**

| Path | Role |
|------|------|
| `services/remote-gateway/` | Device pairing, private signaling, and encrypted relay (standalone Cargo workspace; never stores project files, chat, or relay payloads) |
| `services/remote-mobile/` | Mobile remote PWA (React + Vite) |

> **Design rule:** Desktop never spawns or parses `aris-cli` — CLI and Desktop are two shells over the same
> core runtime. See [cli-desktop-architecture.md](docs/development-logic/cli-desktop-architecture.md).

---

## 🛠️ Development

```powershell
cd desktop
npm run test        # vitest
npm run typecheck   # tsc
npm run tauri dev   # run app

cd src-tauri && cargo check          # Rust checks
cargo test -p runtime reads_pdf      # PDF extraction tests (from repo root)
```

---

## 🗺️ Roadmap

- [x] **P0** — Desktop shell (Tauri 2 + React + Vite): Chat, Settings, Sessions, Skills
- [x] **P0** — Shared `runtime` / `executor` / `tools` / `chat` / `commands` crates (no `aris-cli` coupling)
- [x] **P1** — Workflow Studio, Run Monitor, multi-project workspace, PDF auto-review attachments
- [ ] **P2** — Generated frontend ⇄ Rust type contracts to reduce schema drift
- [ ] **P2** — macOS / Linux desktop bundles
- [ ] **P2** — Richer team/agent monitoring and workflow templates

---

## 🙏 Credits

SomniQ Studio is the desktop shell for **[SomniQ-Code](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)**,
built on **[claw-code](https://github.com/ultraworkers/claw-code)** (a Rust reimplementation of Claude Code). Thanks to both teams.

---

## 📄 License

MIT License © 2026 SomniQ Contributors

---

<div align="center">
  <sub>🌙 Let AI do research while you sleep · Built with ❤️, Rust, and Tauri</sub>
</div>

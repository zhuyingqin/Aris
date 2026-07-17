# 🌙 SomniQ Studio

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

[![Version](https://img.shields.io/badge/version-0.4.8-blue?style=flat-square)](https://github.com/zhuyingqin/SomniQ/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/zhuyingqin/SomniQ)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![UI](https://img.shields.io/badge/UI-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**English** · [中文](README_CN.md)


## 📰 What's New

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

> **v0.4.16** (2026-07) — `reports` kernel module (report-rendering pipeline consumed by the CLI /
> runtime). New desktop components: `ChatNavigationTabs` + `SideTaskPanel` (in-chat side-task /
> status panel + explicit nav tab strip). New editor helper `latexVscodeHighlighting`
> (VSCode-style LaTeX syntax tokens for the typeset visual editor). `.github/workflows/release.yml`
> refinement + updater-manifest generator refresh. Runtime / Tools / Chat / Tauri backend
> surface updates. Chat / Lab / Typeset / API UI refinements. Notebook / knowledge / literature
> / studio tool surface.

> **v0.4.15** (2026-07) — Integrated cross-platform PTY terminal (ConPTY on Windows) for the Lab
> Code page: `desktop/src-tauri/src/terminal.rs` + `portable-pty` dep on the Rust side paired with
> `desktop/src/lab/Terminal.tsx` + `@xterm/xterm` + `@xterm/addon-fit` on the frontend. New
> `project_intent` kernel module (intent persistence + inference pipeline) alongside
> `project_goal`. New `editor/kernelIntel.ts` (editor intelligence helpers — completion /
> diagnostics / hover). Notebook kernel refinements. New deps: +@xterm/xterm, +@xterm/addon-fit,
> +katex, +mermaid, +pdfjs-dist.

<details>
<summary>📜 Earlier releases (v0.4.14 → v0.1.0)</summary>

> **v0.4.14** (2026-07) — New `project_goal` kernel module (mission/goal persistence + inference
> pipeline). New `editor` desktop module: `SharedEditor` + `editorCommands` / `editorDecorations` /
> `editorLanguages` / `editorState` / `editorTypes` / `editorView` — extracted from the typeset
> visual editor. New `ProjectBriefCard` chat component (surfaces project mission/goal inline).
> `AGENTS.md` contributor guide + `THIRD_PARTY_NOTICES.md` for bundled deps. CodeMirror language
> plugins + `@tauri-apps/plugin-{process,updater}` deps.

> **v0.4.13** (2026-07) — `desktop/src/sessions/Sessions.tsx` removed; `store.ts` reflects the new
> session model. Chat surface polish (`Chat.tsx`, `ChatSidebar.tsx`, `ChatThread.tsx`, `i18n.ts`).
> Lab / Studio / Onboarding / Scheduled-tasks UI refinements. `styles.css` font-stack upgrade
> (`Inter` → fallback chain) + `font-synthesis: none` + `text-rendering: optimizeLegibility`.

> **v0.4.12** (2026-07) — Chat surface polish (`Chat.tsx`, `ChatMessage.tsx`, `ChatSidebar.tsx`,
> `WorkflowFlow.tsx`, `i18n.ts`, `model.ts`) + matching test alignment. Onboarding tutorial
> step + accent-token + reduced-motion tweaks. Tauri backend (`engine.rs`, `newapi.rs`) —
> reqwest gains `gzip` / `brotli` / `deflate` decoder features. aris-cli + tools runtime
> surface follow-up.

> **v0.4.11** (2026-07) — Runtime / tools / executor surface refactor (~60 Rust files in
> `crates/runtime` + `crates/tools` + `crates/executor` + `crates/chat` + `crates/commands` +
> `crates/compat-harness` + `crates/notebook`): hooks, process registry, cache, hot-memory,
> change-ledger, oauth, remote, usage, permissions, and session_index refinements. Test
> reorganisation: ~14 new `src/<area>/tests/` sub-directories move inline tests into a single
> `tests/` namespace per crate (knowledge / lab / literature / studio / typeset / chat / aris-cli
> / api / etc.). Tauri backend (`commands.rs`, `config.rs`, `engine.rs`, `env/cache.rs`,
> `files.rs`, `knowledge.rs`, `lab.rs`, `lib.rs`, `literature.rs`, `mail/*.rs`, `projects.rs`,
> `scheduled.rs`, `sessions.rs`, `state.rs`, `studio.rs`, `usage_log.rs`, `chat_events.rs`,
> new `change_ledger.rs`) wires the runtime surface into desktop commands. Frontend (`App.tsx`,
> `api/tauri.ts`, chat / lab / literature / studio / typeset, `styles.css`, `types.ts`) adapts to
> the runtime refactor.

> **v0.4.10** (2026-07) — Chat: image preview component, run/command helpers, expanded test
> coverage. Lab: file operations + lab preview polish. Typeset: CodeMirror-6 decoration-based
> visual editor. Runtime / tools / executor surface additions. aris-cli + Tauri backend tweaks.
> Cleanup: dropped stale `idea-stage/v0.4.10..v0.4.13` planning docs.

> **v0.4.9** (2026-07) — Typeset module: Tectonic-backed LaTeX compile (`src-tauri/src/typeset.rs`) +
> CodeMirror-6 visual editor (`desktop/src/typeset/`, mathlive math input, slides-main fixture).
> Lab: `labEditorCore` extraction + lab preview iframe (`desktop/src/api/labPreview.ts`,
> `npm run dev:lab`). Runtime / tools / executor surface added (tool registry + OpenAI executor
> refinements). Newapi managed-login fully wired (Login bypasses pasted keys; Settings =
> projection of server state). Chat-stream hook refinement + `onChatContextWarning` /
> `onChatToolProgress` events. MCP `claude` server registered alongside `codex`. Visual identity +
> icon set refresh.

> **v0.4.8** (2026-07) — Env-probe extraction into `src-tauri/src/env/` (Python / Jupyter / MATLAB /
> LaTeX with in-memory session cache + on-disk fingerprint cache), system prompt externalized to
> `crates/runtime/assets/prompts/system.md` (edit as markdown, no Rust rebuild), prompt pipeline
> rework (`prompt.rs` +419 lines), file-ops / bash / sandbox refinements, chat-stream hook extracted
> (`useChatStream.{ts,test.tsx}`), newapi managed-login integration, RuntimeAccess UI panel,
> MarkdownContent renderer fixes. Follow-up commit refreshed the release with process registry
> wiring + chat-stream polish.

> **v0.4.7** (2026-07) — Lab MATLAB auto-discovery (Windows registry `HKLM` / `HKCU` / `WOW6432Node`
> MathWorks roots + program-files scan), chat i18n (`chat/i18n.ts` centralizes `CHAT_COPY`),
> system-prompt + user-prompt inspectors (`systemPromptView` / `userPromptView` Tauri commands),
> onboarding tutorial polish, MarkdownContent renderer fixes, `styles.css` overhaul (+652 lines),
> `Language` type system.

> **v0.4.6** (2026-07) — Mail integration (Gmail / Graph / IMAP + OAuth2 + `atomic_file.rs`),
> scheduled tasks module rewrite, Settings rewrite (provider cards, role pickers, `auth.json` /
> `config.toml` editors, two-view list + detail), newapi managed login + Settings-as-projection, Lab
> updates (MATLAB REPL, kernel picker), Chat stop+continue interrupt architecture +
> `AskUserQuestion` tool, runtime / cache / tools (knowledge, literature, notebook, studio)
> updates.

> **v0.4.5** (2026-06) — CI fix: pass `TAURI_SIGNING_PRIVATE_KEY` to the macOS desktop job so the
> bundle step doesn't error out on the updater-artifacts check.

> **v0.4.4** (2026-06) — Deps fix: refresh `package-lock.json` so `npm ci` succeeds in CI (lock was
> missing transitive deps like `d3-*`, `hachure-fill`, `lodash-es`).

> **v0.4.3** (2026-06) — Runtime: LLM-based context compaction summaries + ContextRing improvements;
> knowledge memory + session robustness. Desktop: ErrorBoundary, LiteratureViewTabs, onboarding
> tutorial wired into main nav. Research-review skill: LaTeX report template. Notebook: MATLAB
> kernel + Jupyter manager robustness. CLI: timeline view.

> **v0.4.2** (2026-06) — First-time onboarding tutorial: multi-step spotlight that walks new users
> through sidebar, mobile menu, project switcher, and workspace; respects saved UI prefs via
> `ONBOARDING_STORAGE_KEY` + prior-usage detection; dark / light accent tokens + reduced-motion
> fallback.

> **v0.4.1** (2026-06) — Release prep: packaging + dependency alignment for the v0.4.x line.

> **v0.4.0** (2026-06) — Release prep: v0.4.x baseline.

> **v0.3.6** (2026-06) — Patch release prep.

> **v0.3.5** (2026-06) — Release fix: publish correct updater asset URLs.

> **v0.3.4** (2026-06) — Desktop fix: prefer bundled Tectonic fallback when system LaTeX is unavailable.

> **v0.3.2** (2026-06) — Scheduled task registry (`runtime::process_registry`, desktop `scheduled`
> module), literature store (`literatureStore.ts`) + Literature UI updates, Chat test suite
> (`Chat.test.tsx`), permissions + model switching + provider config fixes.

> **v0.3.1** (2026-06) — Chat: surface permission requests as inline blocks, plumb respond /
> resolved callbacks through `useChatStream`; model switch refreshes status, `activeModel` sync,
> Browser-path-without-Tauri support. Settings: persist provider + `base_url` per entry, add
> DeepSeek executor preset. CLI: `--model` honors saved executor config.

> **v0.3.0** (2026-06) — Memory subsystem (`hot_memory`, `knowledge_memory`, `memory_provider`,
> `session_index`), literature PDF reader (`pdfjs-dist` worker) + KaTeX math rendering, chat-stream
> refactor (`useChatStream`), literature tool consolidation, CLI config / main rewritten around
> kernel skills, NSIS webview install mode.

> **v0.2.3** (2026-06) — MCP (Model Context Protocol) integration: stdio MCP client with
> config-driven server registry + per-server lifecycle (`kernel::mcp.rs` + `runtime::mcp_stdio.rs`),
> chat surface wires tool calls through dispatch, new MCP page + RuntimeAccess panel,
> `docs/mcp.md`, CLI parity for MCP server registry.

> **v0.2.2** (2026-06) — OpenAlex + Scopus search engines wired into the literature kernel
> (`search_openalex` / `search_scopus`, `scopus_api_key`), new shared-governance skill, project
> focus + briefs persisted through kernel save / load.

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

Outputs `aris-desktop.exe` and `SomniQ Studio_0.4.11_x64-setup.exe` under `desktop\src-tauri\target\release\`.

---

## ⚙️ First-Run Setup

First launch opens **Settings**, where you configure:

- **Executor** and **Reviewer** — provider, model, base URL, API key
- **Scopus API key**, **Language**, **memory write approval**, and **connectivity checks** for the configured models

Config is stored locally at `~/.config/SomniQ/config.json`. API keys are masked by default in the UI.
Click **Show** in local Settings to reveal a key temporarily; the normal config view still returns only masked previews.

### MCP & Playwright

SomniQ Desktop reads MCP servers from the current project's `.mcp.json` and surfaces them in
**Extensions → Plugins** and **Settings → Permissions & MCP**. The Windows bundle includes an
`aris-playwright-mcp` launcher, vendored `@playwright/mcp`, and a Node runtime, so installed users
can add the Playwright preset without installing Node.js or npm themselves. The default preset uses
Microsoft Edge (`--browser=msedge`), enables PDF tools (`--caps=pdf`), and stores browser profile
and output files under `.somniq/tmp/browser/`; edit the arguments in the MCP page for custom
browser options.

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
- **🧩 Workflow Studio** — design agent-team workflows on a visual canvas backed by the aris DSL.
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

`config.json` and the Settings page use the same snake_case fields:

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

Desktop also maintains `verified_executors` so the Chat model dropdown can restore provider/model/base URL/key combinations that already passed a Settings test.

---

## 🧱 Architecture

SomniQ Studio reuses the SomniQ kernel instead of reimplementing agent logic in the frontend: the UI calls the
local Tauri backend, which calls the shared Rust crates.

```text
React + Vite frontend
        │  Tauri invoke / listen
        ▼
desktop/src-tauri backend
        │  shared Rust crates
        ▼
crates/runtime + crates/executor + crates/tools + crates/chat + crates/commands
```

| Path | Role |
|------|------|
| `desktop/src/` | React UI — chat, settings, skills, sessions, studio, monitor, teams |
| `desktop/src-tauri/` | Tauri commands and desktop backend |
| `crates/runtime/` | Filesystem, permissions, session, PDF text utilities |
| `crates/executor/` | Provider clients and streaming |
| `crates/tools/` | Tool registry for agents and desktop commands |
| `crates/chat/` | Shared chat runtime assembly |
| `crates/commands/` | Shared command parsing and specs |

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

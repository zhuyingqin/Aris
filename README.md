# ARIS Studio

Desktop research automation workspace for agent-team workflows, adversarial review, and paper-centric AI work.

ARIS Studio is the desktop application for ARIS. It keeps the executor/reviewer idea from the original ARIS research agent, but moves the daily experience into a local Tauri app: chat, project switching, skills, workflow design, run monitoring, sessions, settings, and PDF-readable review attachments.

This README documents the desktop application. The legacy ARIS CLI implementation is no longer the product entry point; the remaining CLI/runtime crates are treated as shared libraries for the desktop app.

[Chinese README](README_CN.md) | [English README](README_EN.md)

## What It Does

- Chat with the ARIS executor from a desktop UI, with streamed tool calls and persisted sessions.
- Configure executor and reviewer providers, models, base URLs, API keys, and language from Settings.
- Browse bundled research skills and invoke slash-skill workflows directly from Chat.
- Attach local files to Chat. Text PDFs can be read by the `read_file` tool, so automatic review flows can inspect paper PDFs without an external PDF utility.
- Switch between local research projects. Each project keeps its own sessions, run state, agents, workflows, and user workflow drafts.
- Design workflows in Workflow Studio using a visual graph and the ARIS workflow DSL.
- Start, pause, resume, cancel, and monitor workflow runs with live phase, agent, event, task, and mailbox views.

PDF support is text extraction, not OCR. Scanned or image-only PDFs still need OCR before ARIS can reason over their contents.

## Current Status

- Product: ARIS Studio
- Desktop version: `0.2.0`
- Desktop shell: Tauri 2 + React + Vite
- Primary bundle target: Windows NSIS installer
- Local-first storage: configuration and project runtime data stay on the user's machine

## Quick Start

Prerequisites:

- Windows 10/11 with WebView2 Runtime
- Node.js 18 or newer
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools with the C++ build tools installed

Build and run from source:

```powershell
git clone https://github.com/zhuyingqin/Aris.git
cd Aris\desktop
npm install
npm run tauri dev
```

Create the Windows desktop bundle:

```powershell
cd desktop
npm run tauri build
```

The release build produces:

- App executable: `desktop\src-tauri\target\release\aris-desktop.exe`
- Windows installer: `desktop\src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

## Configuration

Open the Settings tab in ARIS Studio to configure:

- Executor provider, model, base URL, and API key
- Reviewer provider, model, base URL, and API key
- UI/output language
- Connectivity checks for the configured models

Configuration is stored locally at:

```text
~/.config/aris/config.json
```

API keys are masked in the UI. They are read and written locally by the Tauri backend and are not returned to the frontend as raw secrets.

## Project Data

By default, ARIS Studio creates and uses:

```text
~/.config/aris/desktop-workspace
~/.config/aris/desktop-runtime
```

Per-project runtime data is stored below:

```text
~/.config/aris/desktop-runtime/projects/<project-id>/
```

Each project may contain:

- `sessions/` - desktop chat sessions
- `run-state/` - workflow run events and status
- `agents/` - agent/task state
- `workflows/` - saved workflow plans
- `user-workflows/` - user-authored workflow drafts

You can add or switch projects from the project selector in the desktop header. `ARIS_WORKSPACE_ROOT` can be used to override the default workspace root for advanced local setups.

## Auto Review And PDFs

The desktop auto-review path now preserves local PDF attachments as file-path attachments. When a skill or chat turn asks ARIS to review a paper, the agent can call `read_file` on the attached `.pdf`; the runtime extracts text from common text-based PDF streams, including Flate-compressed streams and ToUnicode character maps.

This means workflows such as paper review, paper improvement, and literature review can work with local PDF attachments in the desktop UI. Encrypted PDFs, unusual encodings, and scanned PDFs may still require manual text extraction or OCR.

## Development

Useful commands:

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

## Repository Layout

```text
desktop/             React/Tauri desktop application
desktop/src/         Chat, settings, skills, sessions, studio, monitor, teams
desktop/src-tauri/   Tauri commands and desktop backend
crates/runtime/      Filesystem, permissions, session, and PDF text utilities
crates/tools/        Tool registry used by agents and desktop commands
crates/executor/     Agent execution engine
crates/chat/         Chat stream primitives
crates/commands/     Shared command handling
docs/                Screenshots and supporting docs
```

## Design Notes

ARIS Studio reuses the ARIS coordination kernel rather than duplicating agent logic in the frontend. The desktop UI sends commands to the local Tauri backend, which calls the shared Rust crates for tools, sessions, skills, chat execution, and workflow state.

The older terminal-oriented ARIS CLI documentation has intentionally been removed from this README. For this repository, the supported user-facing entry point is now ARIS Studio.

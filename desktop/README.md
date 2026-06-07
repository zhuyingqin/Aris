# ARIS Studio Desktop

This directory contains the Tauri desktop application for ARIS Studio.

The desktop app is the primary user-facing product in this repository. It wraps the shared ARIS runtime and tool crates with a local UI for chat, skills, project switching, workflow design, run monitoring, settings, and persisted sessions.

## Architecture

```text
React + Vite frontend
        |
        | Tauri invoke/listen
        v
desktop/src-tauri backend
        |
        | shared Rust crates
        v
crates/runtime + crates/tools + crates/executor + crates/chat + crates/commands
```

Main frontend areas:

- `src/chat/` - desktop chat, attachments, slash commands, sessions, streamed tool output
- `src/settings/` - model/provider configuration and connection checks
- `src/skills/` - bundled skill browser
- `src/sessions/` - persisted session list
- `src/studio/` - workflow canvas and DSL editor
- `src/monitor/` - workflow run board, phases, events, agents, mailbox
- `src/teams/` - team/task views

Main backend areas:

- `src-tauri/src/config.rs` - local `~/.config/aris/config.json` settings
- `src-tauri/src/engine.rs` - chat execution bridge
- `src-tauri/src/files.rs` - file reads used by attachments and preview
- `src-tauri/src/projects.rs` - project registration and switching
- `src-tauri/src/state.rs` - desktop workspace/runtime directory layout
- `src-tauri/src/workflow.rs` - workflow planning, persistence, and control

## Develop

```powershell
cd desktop
npm install
npm run tauri dev
```

Browser-only frontend development can use:

```powershell
npm run dev
```

Some features need the Tauri backend and will only work in `npm run tauri dev`.

## Build

```powershell
cd desktop
npm run tauri build
```

Build outputs:

- `src-tauri\target\release\aris-desktop.exe`
- `src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

## Checks

```powershell
cd desktop
npm run test
npm run typecheck
npm run build
```

```powershell
cd desktop\src-tauri
cargo check
```

From the repository root, the PDF extraction regression tests can be run with:

```powershell
cargo test -p runtime reads_pdf
```

## Runtime Data

ARIS Studio stores configuration and runtime state locally:

```text
~/.config/aris/config.json
~/.config/aris/desktop-workspace
~/.config/aris/desktop-runtime
```

Each non-default project receives an isolated runtime directory below:

```text
~/.config/aris/desktop-runtime/projects/<project-id>/
```

The backend sets the project-specific `ARIS_RUN_STATE_DIR`, `ARIS_SESSIONS_DIR`, `ARIS_AGENT_STORE_DIR`, `ARIS_WORKFLOWS_DIR`, and `ARIS_USER_WORKFLOWS_DIR` environment variables before running desktop agent workflows.

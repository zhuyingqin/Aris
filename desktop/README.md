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
The browser preview uses bundled sample data; it does not read real project
files or compile through the desktop backend.

Lab UI changes can be previewed without compiling or launching the Tauri
executable:

```powershell
npm run dev:lab
```

This opens Vite at `http://127.0.0.1:5173/?labPreview=1` and uses mock Lab data
for notebooks, files, kernels, Python execution output, and variables. The same
mode can be enabled on any Vite URL with `?labPreview=1`.

Typeset UI changes can be previewed with:

```powershell
npm run dev:typeset
```

This opens Vite at `http://127.0.0.1:1420/?typesetPreview=1` and uses mock
LaTeX/PDF files. Use `npm run tauri dev` or the built `aris-desktop.exe` to
validate the Desktop App against real files such as `F:/F-CESN会议/root.tex`.

## Build

```powershell
cd desktop
npm run tauri build
```

Build outputs:

- `src-tauri\target\release\aris-desktop.exe`
- `src-tauri\target\release\bundle\nsis\ARIS Studio_0.2.0_x64-setup.exe`

## Internal Installer

Use `build:internal` to create an NSIS installer that seeds LLM settings on the
first launch after installation. The bundled config is copied into the user's
`~/.config/aris/config.json`; existing non-empty fields are preserved by
default.

```powershell
cd desktop
$env:ARIS_INTERNAL_PRODUCT_NAME = "ARIS Studio Internal"
$env:ARIS_INTERNAL_IDENTIFIER = "com.aris.studio.internal"
$env:ARIS_INTERNAL_EXECUTOR_PROVIDER = "openai"
$env:ARIS_INTERNAL_EXECUTOR_MODEL = "gpt-5.5"
$env:ARIS_INTERNAL_EXECUTOR_BASE_URL = "https://api.openai.com/v1"
$env:ARIS_INTERNAL_EXECUTOR_API_KEY = "<internal-key>"
npm run build:internal
```

For a fuller config, keep a local JSON file outside git and pass it with
`ARIS_INTERNAL_CONFIG`:

```json
{
  "_internal": { "overwriteExisting": false },
  "executor_provider": "openai",
  "executor_model": "gpt-5.5",
  "executor_base_url": "https://api.openai.com/v1",
  "executor_api_key": "<internal-key>",
  "reviewer_provider": "openai",
  "reviewer_model": "gpt-5.5",
  "reviewer_base_url": "https://api.openai.com/v1",
  "reviewer_api_key": "<internal-key>",
  "language": "cn"
}
```

```powershell
$env:ARIS_INTERNAL_CONFIG = "C:\secure\aris-internal-config.json"
npm run build:internal
```

The temporary bundled `internal-config.json` is removed after the build script
finishes and is ignored by git.

## GitHub Updater Releases

ARIS Studio uses the Tauri updater plugin and checks:

```text
https://github.com/zhuyingqin/Aris/releases/latest/download/latest.json
```

The updater public key is embedded in `src-tauri/tauri.conf.json`. Keep the matching private key out of git and set it as the GitHub repository secret `TAURI_SIGNING_PRIVATE_KEY` before publishing tagged releases. Store the private key as one line with whitespace removed. If the key was generated with a password, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

For local signed bundle checks:

```powershell
cd desktop
$env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText("updater.key") -replace "\s", ""
npx tauri build --bundles nsis --ci
npm run generate:updater-json -- src-tauri/target/release/bundle/nsis
```

The GitHub `Release` workflow publishes the NSIS installer, its `.sig`, and `latest.json` to the tag release. The Settings page can then check, download, install, and restart into the new version.

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

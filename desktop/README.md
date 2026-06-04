# ARIS Studio (desktop)

A Tauri desktop app for **designing agent-team workflows** and **monitoring runs**
live. It reuses the ARIS coordination kernel (`crates/tools`) directly — no API
keys ever leave the machine, and no business logic is duplicated.

This is **P0**: workflow design + plan/save + start/control + live monitoring of
the run-state the `aris` CLI produces. In-app LLM agent execution and the chat
console land in later phases.

## Architecture

```
React + Vite + React Flow (webview)
        │  invoke()              │  listen("run-event")
        ▼                        ▼
src-tauri/commands.rs  ───►  tools::execute_tool("Workflow"/"ListTeam"/…)
src-tauri/watcher.rs   ───►  tails  <run-state>/events.jsonl
                                     │
                             ./.claude/run-state/  (or $ARIS_RUN_STATE_DIR)
```

- **Studio** — React Flow canvas + DSL editor (`emitPhase` / `spawnAgent` /
  `waitAll` / `saveResult`). The DSL string is the single source of truth and is
  validated server-side via `workflow_plan` before start/save. Grammar mirrors
  `crates/tools/src/workflow_state.rs`.
- **Run Monitor** — phase swimlanes (status-coloured), agent cards, a live event
  timeline, and the team mailbox. Polls every 3s and reacts to `run-event`.
- **Team** — tasks (with dependencies) and agents from `ListTeam`.

## Prerequisites

- Node 18+ and npm
- Rust (stable, MSVC on Windows) + the platform's WebView (WebView2 on Win 11)
- Tauri CLI: `npm i` installs `@tauri-apps/cli`

## Develop

```bash
cd desktop
npm install
npm run test        # vitest — DSL round-trip + graph projection
npm run tauri dev   # launches the desktop app (vite dev server + Rust)
```

Point the app at a run-state directory by launching it from a repo that has
`./.claude/run-state/`, or set `ARIS_RUN_STATE_DIR`. The current effective path is
shown in the header.

## Build

```bash
npm run build          # frontend -> dist/ (required before a bare cargo build,
                       #   because generate_context! embeds dist)
npm run tauri build    # full desktop bundle (needs icons added first)
```

> The Tauri crate is a **standalone workspace** (`desktop/src-tauri`), isolated
> from the root ARIS workspace so the heavy Tauri dependency tree never affects
> the core crates' build/CI. It consumes `crates/tools` via a path dependency.

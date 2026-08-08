# ARIS Shell and Runtime Development Logic

## Core rule

Product shells are different front ends over the same core runtime.

No shell may connect to, spawn, or parse another shell. No shell may own reusable agent logic just because it happened to need it first. Shared behavior belongs in the kernel crates; a shell only adapts that behavior to its own UI, lifecycle, and permissions.

This rule is why removing the terminal shell in v0.4.43 was a deletion and not a refactor: nothing in the kernel had to change, because nothing in the kernel knew a terminal existed. Hold the same line for every shell that follows.

```text
crates/runtime
  conversation loop, session model, system prompt primitives, permissions,
  compaction, MCP, file operations, hooks, event sinks

crates/executor
  provider clients, streaming conversion, tool-call event normalization

crates/tools
  ARIS tool implementations, subagent spawning

crates/chat
  shared chat runtime assembly, provider config resolution, tool-spec conversion,
  permission-policy construction, common system prompt sections

desktop/src-tauri
  Tauri command bridge, desktop session state, desktop event emission,
  desktop-specific isolation policy, the desktop slash-command surface

desktop/src
  React UI and local UI state only

services/remote-gateway, services/remote-mobile
  the mobile remote shell: pairing, encrypted relay, PWA
```

## What the architecture already gets right

- The root Rust workspace contains `crates/*`, while `desktop/src-tauri` is a standalone Tauri workspace. Tauri's dependency tree stays out of the kernel while path dependencies still work.
- Desktop depends on `tools`, `runtime`, `api`, `aris-executor`, and `aris-chat` directly, and spawns no other shell.
- `runtime::ConversationRuntime` owns the conversation loop behind the `ApiClient` and `ToolExecutor` traits, so any shell reuses the same turn execution model.
- `aris-executor` owns Anthropic/OpenAI-compatible streaming and exposes `StreamObserver`, so a shell chooses how a stream is surfaced without forking the stream logic.
- `crates/chat` owns shared chat assembly: provider config resolution, executor construction, max-token policy, tool-spec conversion, permission-policy construction, common prompt sections, and final assistant text extraction.
- Sessions are `runtime::Session` everywhere, so the on-disk conversation format is the kernel's, not a shell's.

## Open items

### 1. Runtime construction must stay shared

`crates/chat` is the shared assembly layer for the chat runtime: tool specs, provider client, permission policy, common system prompt sections, max-token policy, and `ConversationRuntime` construction.

Only shell-specific adapters belong outside it: the shell's `StreamObserver`, its permission prompter, its isolation policy, and its event output.

### 2. Provider/config behavior should remain centralized

`crates/chat` centralizes executor resolution. A shell's settings UI may be its own, but the resulting schema and validation rules are shared — a shell must not grow divergent provider semantics outside `crates/chat`.

### 3. Slash commands are a shell surface

Command specs, parsing, and help rendering live in `desktop/src-tauri/src/slash_commands.rs`, because a shell defines its own command surface. What must *not* live there is the domain behavior behind a command: session compaction, session listing/switching, config inspection, and cost/status summaries are kernel behavior that the command merely invokes.

They were previously in a shared `commands` crate so that a terminal shell and the desktop agreed on the surface. With one shell left, the crate was folded into it (v0.4.43). If a second shell ever needs the same commands, promote the specs back into a shared crate rather than copying them.

### 4. Frontend types mirror Rust comments instead of generated contracts

`desktop/src/types.ts` and related UI code manually mirror tool output structures from Rust. Acceptable for iteration speed; long term, generate or export stable JSON schemas for tool outputs to reduce drift.

## Placement rules for new code

### Put it in `runtime` when

- It affects conversation state, turn execution, session persistence, compaction, permissions, prompts, MCP, hooks, or file/runtime primitives.
- Every shell should behave the same way.
- The code should be testable without any UI dependency.

### Put it in `executor` when

- It talks to model providers.
- It converts provider streams into normalized assistant events.
- It defines provider-neutral streaming or tool-call behavior.

### Put it in `tools` when

- It is an ARIS tool implementation.
- It changes agent/subagent coordination.
- It reads or writes shared ARIS tool state.

### Put it in `chat` when

- It assembles a runtime from configuration, and every shell would otherwise duplicate the assembly.

### Put it in `desktop/src-tauri` when

- It is a Tauri command, app state, event bridge, watcher, file picker, desktop-only safety policy, or the desktop command surface.
- It adapts shared logic to Desktop without changing the shared behavior.

### Put it in `desktop/src` when

- It is React UI, visual state, frontend routing, layout, or browser-side interaction.
- It does not need direct filesystem, provider, or runtime access.

## Forbidden coupling

- One shell spawning or parsing another shell for chat, workflow, tools, config, or sessions.
- Shared crates depending on Tauri, React, or any UI toolkit.
- One shell's config/setup assumptions becoming the only source of truth for the rest.
- Domain behavior implemented separately per shell with no shared tests.

## Shared chat layer

`crates/chat` owns:

- provider config input types
- common executor/client construction
- max-token policy
- conversion from `tools::ToolSpec` to `aris_executor::ExecutorToolSpec`
- common permission-policy construction
- common system-prompt assembly
- reusable final-assistant-text extraction
- the per-turn budget applied to interactive runtimes

It accepts shell-specific adapters: `StreamObserver`, `ToolExecutor`, a permission mode or policy override, extra system prompt sections such as Desktop's isolation text, and an event sink. A shell provides adapters and UI behavior — nothing else.

## Current verdict

```text
Desktop shell  -> shared runtime/executor/tools/chat
Mobile remote  -> Desktop, over the encrypted gateway
any shell      -X-> any other shell's process
```

Historical notes:

- The terminal shell (`crates/aris-cli`) and its manifest extractor (`crates/compat-harness`) were removed in v0.4.43, along with the `commands` crate, which was folded into the desktop shell. The headless entrypoint (`-p` / `--print` / `--output-format json`) went with it; a future automation surface has to be rebuilt rather than recovered.
- The team/workflow multi-agent coordination subsystem (SpawnTeammate, ListTeam, AgentSupervisor, Workflow, etc.) was removed entirely — it never shipped to users. The plain `Agent` subagent-spawning tool is unaffected.

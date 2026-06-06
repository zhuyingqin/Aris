# ARIS CLI and Desktop Development Logic

## Core rule

CLI and Desktop are two different product shells over the same core runtime.

Desktop must not connect to, spawn, or parse `aris-cli`. CLI must not own reusable agent logic just because it was the first interface. Shared behavior belongs in library crates. The entrypoints only adapt that behavior to their own UI, lifecycle, and permissions.

```text
crates/runtime
  conversation loop, session model, system prompt primitives, permissions,
  compaction, MCP, file operations, hooks, event sinks

crates/executor
  provider clients, streaming conversion, tool-call event normalization

crates/tools
  ARIS tool implementations, agent/team/workflow coordination state

crates/commands
  reusable command parsing/specs and command behavior that is not terminal-only

crates/chat
  shared chat runtime assembly, provider config resolution, tool-spec conversion,
  permission-policy construction, common system prompt sections

crates/aris-cli
  command-line parsing, terminal rendering, stdin/stdout, exit codes,
  interactive CLI-only commands

desktop/src-tauri
  Tauri command bridge, desktop session state, desktop event emission,
  desktop-specific isolation policy

desktop/src
  React UI and local UI state only
```

## What the current project already gets right

The current branch mostly follows the intended direction.

- The root Rust workspace contains `crates/*`, while `desktop/src-tauri` is a standalone Tauri workspace. This keeps Tauri's heavy dependency tree out of the core crates while still using path dependencies.
- Desktop depends on `tools`, `runtime`, `api`, and `aris-executor` directly. It does not depend on or invoke `aris-cli`.
- `runtime::ConversationRuntime` owns the conversation loop through `ApiClient` and `ToolExecutor` traits, so both shells can reuse the same turn execution model.
- `aris-executor` owns Anthropic/OpenAI-compatible streaming and exposes `StreamObserver`, letting CLI render to terminal while Desktop emits Tauri events.
- `crates/chat` owns shared chat assembly: provider config resolution, executor construction, max-token policy, tool-spec conversion, permission-policy construction, common prompt sections, and final assistant text extraction.
- Desktop workflow/team commands are thin wrappers over `tools::execute_tool`, so workflow and team state logic stays in the shared tool layer.
- Desktop sessions reuse `runtime::Session`, keeping the on-disk conversation format shared with CLI.
- Slash command specs, parsing, help rendering, `/team` tool plans, and `/workflows` tool plans live in `crates/commands`.

## What does not fully match yet

These are not blockers, but they are the areas where the code still violates or only partially follows the desired architecture.

### 1. Runtime construction must stay shared

`crates/chat` is now the shared assembly layer for the conceptual chat runtime: tool specs, provider client, permission policy, common system prompt sections, max-token policy, and `ConversationRuntime` construction.

Keep this invariant:

- Keep only shell-specific adapters outside shared code:
  - CLI `StreamObserver`
  - Desktop `StreamObserver`
  - CLI permission prompter
  - Desktop isolation policy
  - terminal vs Tauri event output

### 2. Provider/config behavior should remain centralized

`crates/chat` now centralizes environment-based executor resolution for CLI and settings-object executor resolution for Desktop.

Remaining rule:

- CLI setup screens can remain CLI-only, but the resulting schema and validation rules should be shared.
- Desktop settings should read/write the same schema, but should not duplicate provider semantics in a divergent way outside `crates/chat`.

### 3. Slash commands are only partially shared

`crates/commands` contains specs, parsing, help rendering, resumable command handling, and shared command plans for `/team` and `/workflows`. Some actual command behaviors still live in `aris-cli/src/main.rs`.

This is acceptable for terminal-only commands, but not for commands whose behavior is domain logic.

Keep in CLI:

- terminal help layout
- interactive prompts
- stdout/stderr formatting
- process exit behavior
- commands that only make sense in a REPL

Move or expose from shared crates:

- session compaction behavior
- session listing/switching model
- config inspection semantics
- cost/status summary generation

### 4. Desktop chat policy is shell-specific

Desktop correctly needs a stricter policy than CLI. The common chat assembly now lives in `crates/chat`; Desktop keeps only its disabled-tool list, Tauri event observer, tool-result event emission, and isolation prompt section.

Keep this boundary:

- Keep Desktop's isolation rules in Desktop.
- Pass Desktop policy as data or a trait implementation.
- Keep Tauri event names and payloads in Desktop.

### 5. Frontend types mirror Rust comments instead of generated contracts

`desktop/src/types.ts` and related UI code manually mirror tool/workflow/team structures from Rust.

Target:

- For fast iteration this is acceptable.
- Long term, generate or export stable JSON schemas/types for workflow/team outputs to reduce drift.

## Placement rules for new code

Use these rules when deciding where to put a new feature.

### Put it in `runtime` when

- It affects conversation state, turn execution, session persistence, compaction, permissions, prompts, MCP, hooks, or file/runtime primitives.
- Both CLI and Desktop should behave the same way.
- The code should be testable without terminal or Tauri dependencies.

### Put it in `executor` when

- It talks to model providers.
- It converts provider streams into normalized assistant events.
- It defines provider-neutral streaming or tool-call behavior.

### Put it in `tools` when

- It is an ARIS tool implementation.
- It changes agent/team/workflow coordination.
- It reads or writes shared ARIS tool state.

### Put it in `commands` when

- It parses or describes commands that can be understood outside a terminal.
- It implements command behavior that is not tied to stdin/stdout, terminal rendering, or process exit codes.

### Put it in `aris-cli` when

- It is command-line argument parsing.
- It is terminal rendering, terminal input, shell completion, or interactive prompting.
- It decides process exit codes.
- It formats output specifically for CLI users.

### Put it in `desktop/src-tauri` when

- It is a Tauri command, app state, event bridge, watcher, desktop file picker, or desktop-only safety policy.
- It adapts shared logic to Desktop without changing the shared behavior.

### Put it in `desktop/src` when

- It is React UI, visual state, frontend routing, layout, or browser-side interaction.
- It does not need direct filesystem, provider, or runtime access.

## Forbidden coupling

Do not introduce these dependencies:

- Desktop spawning `aris-cli` for chat, workflow, tools, config, or sessions.
- Desktop parsing CLI stdout/stderr.
- Shared crates depending on Tauri, React, terminal rendering, or CLI argument parsing.
- CLI-only config/setup assumptions becoming the only source of truth for Desktop.
- Domain behavior implemented separately in CLI and Desktop with no shared tests.

## Implemented shared chat layer

`crates/chat` is the shared chat assembly layer.

It owns:

- provider config input types
- common executor/client construction
- max-token policy
- conversion from `tools::ToolSpec` to `aris_executor::ExecutorToolSpec`
- common permission-policy construction
- common system-prompt assembly
- reusable final-assistant-text extraction

It accepts shell-specific adapters:

- `StreamObserver`
- `ToolExecutor`
- permission mode or policy override
- extra system prompt sections, such as Desktop isolation text
- event sink

CLI and Desktop should now keep providing only adapters and UI behavior.

## Current verdict

The project is directionally aligned with the intended architecture:

```text
CLI shell      -> shared runtime/executor/tools
Desktop shell  -> shared runtime/executor/tools
Desktop shell  -X-> aris-cli process
```

The main remaining issue is not wrong coupling to CLI. The chat-runtime assembly duplication has been moved into `crates/chat`, and workflow/team slash command planning has moved into `crates/commands`. The next architectural improvement is to keep moving session/config/status command behavior out of `aris-cli/src/main.rs` when it is not inherently terminal-specific.

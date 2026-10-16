# Chat isolation across independent projects

Each Chat belongs to a registered project. Activating another project selects
the desktop view; it must not change a running Chat's workspace, project goal,
tasks, session history, or review records.

## Failure and diagnosis

The main Chat send path already carried an immutable project binding. Several
other operations still used the process-wide active project:

- Project brief and continuity APIs rejected a registered, inactive project.
- Slash commands did not receive the session's project ID. `/goal`, configuration,
  memory, and Git helpers read process environment variables or the process cwd.
- Tasks, idle session recovery, context replacement/rewind, event replay, review
  restoration, and debug export could fall back to the active project's paths.
- The preflight worker for history loading and automatic compaction did not
  enter the turn's project execution context.

Before the fix, two regression tests reproduced these failures: an inactive
project's brief was refused, and a Chat bound to First reported Second's goal.

## Binding rules

React forwards the owning session's `projectId` for project-sensitive Chat
commands. Async preparation retains the captured session, including when the
user changes projects while attachments are loading.

The Rust boundary resolves that ID against the persisted project registry.
It does not accept an arbitrary workspace path or activate the project. Invalid
IDs, unknown projects, and missing non-default workspace directories are refused.
Legacy callers that omit the optional ID retain their existing active-project
fallback.

`with_chat_project` enters the shared runtime's `ProjectExecutionContext` for a
synchronous operation. Thread-local context must be entered on the worker that
performs the operation; it must not span an `await`. The preflight worker uses
the turn's previously captured binding.

Desktop session and run-state paths, task paths, and command cwd helpers honor
the scoped execution context. Existing per-session directory guards continue
to bind in-flight turn storage across awaits. Background project continuity
updates resolve their workspace by project ID. Independent Reviewer execution
and its durable event stream retain their existing roles.

## Regression coverage

- Two real temporary project directories, with Second globally active: First's
  brief and commands still read First's goal and tasks.
- Two simultaneous Rust worker threads: relative file reads, task reads, cold
  session loading, context replacement/rewind, and event replay remain in the
  owning project. The active project is unchanged.
- React: send in First, switch to Second, send there, and complete First while
  Second is still running. Each reply is saved to the correct project/session;
  neither run is cancelled by the project switch.
- Attachment preparation across a project switch, event-history fallback,
  and independent-review restoration all retain the owning project ID.

Verification: 174 focused Rust tests passed (one live-model test was skipped),
102 frontend tests passed, and type checking and the frontend production build
passed. These checks use temporary projects and simulated frontend replies;
they do not require live model calls. A desktop installer was not rebuilt.

Verification commands run from their respective desktop directories:

```text
cargo test --lib engine::tests -- --test-threads=1
cargo test --lib state::tests -- --test-threads=1
cargo test --lib chat_events::tests -- --test-threads=1
cargo test --lib projects::tests -- --test-threads=1
npx vitest run src/chat/tests/Chat.test.tsx src/chat/tests/useChatSessions.test.tsx src/chat/tests/useIndependentReview.test.tsx src/chat/tests/useChatStream.test.tsx src/chat/tests/useProjectBrief.test.tsx src/chat/tests/SideTaskPanel.test.tsx
npm run typecheck
npm run build
```

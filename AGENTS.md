# SomniQ Studio project guidance

## Product north star

SomniQ Studio is a local-first autonomous research desktop workspace. It uses an Executor -> independent Reviewer -> revision loop to move a research question from idea discovery through literature, experiments, evidence, writing, and submission-ready artifacts.

The desktop app is the primary product surface. CLI and shared Rust crates are reusable runtime infrastructure, not a second competing product.

## Decision filter

- Prefer changes that improve research continuity, evidence quality, auditability, and unattended progress.
- Preserve the independent-review loop; do not silently collapse Executor and Reviewer into one role.
- Keep project data local by default and make external actions explicit and reviewable.
- Reuse shared runtime/chat/tooling crates across Desktop and CLI instead of duplicating behavior.
- Treat context continuity as product state: stable mission belongs here, the active milestone belongs in project goal state, and detailed history belongs in session storage/search.

## Session startup

- At the start of a new conversation, retain this product north star and load the active project goal when one exists.
- Do not infer completed work from filenames or stale summaries. Inspect project goal state and relevant session history when continuity matters.
- If the user's first substantive request defines a new outcome, summarize it into a concise project goal with observable success criteria.

## Repository map

- `desktop/`: Tauri + React primary product surface.
- `crates/runtime`: prompts, sessions, memory, permissions, compaction, and durable project state.
- `crates/chat`: shared chat runtime assembly.
- `crates/tools`: tools and workflow state.
- `docs/development-logic/`: architectural decisions and invariants.

## Verification

- Rust: run focused tests for changed crates, then `cargo test --workspace` when the change crosses crate boundaries.
- Desktop: run focused Vitest tests and `npm run build` from `desktop/` for UI or Tauri API changes.
- Preserve unrelated working-tree changes and do not overwrite existing user-authored project guidance.

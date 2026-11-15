# Task plan completion before ending a turn

An ordinary assistant response used to end a runtime turn even when its
successful `TodoWrite` snapshot still contained unfinished steps. The workflow
chip also treated attempted tool input as persisted progress, including failed
and still-running calls, and could restore an old plan after an explicit clear.

The shared conversation runtime now keeps a turn-local completion check. Only
successful canonical `TodoWrite` results activate or update it. An ordinary
response with open steps receives an internal continuation asking the executor
to continue authorized work or reconcile completed work against evidence.
The check survives context compaction independently of the retained transcript.
Appended hook feedback cannot replace the canonical JSON snapshot.

A blocker, missing input, permission refusal, or planning-only request may
leave steps open. Without a changed plan or another successful work result,
the same completion check runs once. Unchanged `TodoWrite`, `ToolSearch`, and
failed actions do not re-arm it. There are at most eight checks per turn;
manual cancellation and existing execution budgets still take priority.
Historical plans never activate this check on an unrelated later request.
The mechanism never marks unfinished steps completed by itself and does not
change Reviewer routing.

Desktop uses completed, successful `TodoWrite` results for workflow progress,
preferring canonical result fields over the legacy input fallback. An empty
snapshot clears the plan; absence of a snapshot permits persisted-state
restoration. When execution is inactive with unfinished steps, the chip shows
“待继续” / “Paused” with a clock instead of a running spinner.

Regressions cover premature completion through verification, changed phases,
blockers, failed actions, cancellation, budgets, historical plans, clearing,
context compaction, appended feedback, and bounded continuation. Run
`cargo test -p runtime task_plan`, `cargo test -p tools todo`, and
`cargo test --workspace`. From `desktop/`, run the focused `model`,
`WorkflowFlow`, and `Chat` Vitest suites, `npm run typecheck`, and
`npm run build`. These source changes do not rebuild the installed desktop.

Local Windows verification passed 1,539 workspace tests (six ignored) using
`cargo test --workspace --offline -- --test-threads=1`. The default parallel
run stalled in the tools suite, so it was stopped and rerun serially. All 86
focused frontend tests, TypeScript checking, and the frontend build passed.

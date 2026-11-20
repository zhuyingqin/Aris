# Scheduled task semantics

Scheduled tasks (`desktop/src-tauri/src/scheduled.rs` and the ScheduledTasks
page) now match the semantics of DeepSeek Harness Schedule: explicit calendar
rules and zones, missed-run coalescing, a delivery history, and three delivery
targets. The reference is `packages/schedule/schedule` at `fcc0ad46`. Two
things go further than upstream. Dispatch is idempotent per occurrence, where
upstream is at-least-once. Every run still becomes a WorkTask card, so it gets
the same isolated worktree, independent Reviewer and recovery as a hand-made
card. A scheduled run never bypasses the Executor → Reviewer → revision loop.

## Rules

| Kind | Meaning | Engine |
|---|---|---|
| `once` | One wall-clock time in the task's zone | `rules::resolve_local` |
| `interval` | Minutes or hours: elapsed time on a fixed grid. Days: the same wall-clock time every N calendar days | own arithmetic |
| `cron` | Five-field Vixie Cron (`min hour dom month dow`), read in the task's zone | `croner` 4 |
| `rrule` | One RFC 5545 `RRULE` at HOURLY or coarser, anchored by `DTSTART;TZID=` | `rrule` 0.14 |

Every task stores an explicit IANA zone (`chrono-tz`). A record from before
v2 has no zone and is read in the system zone (`iana-time-zone`).

Why these crates:

- `chrono-tz` bundles the IANA database at compile time, so a zone means the
  same thing on every machine. It is also what `rrule` is built on.
- `rrule` implements RFC 5545 recurrence, and its DST handling matches the RFC:
  it builds each occurrence from midnight plus the elapsed time-of-day, which
  pushes a time in a gap forward and keeps the first pass of a fold. A
  `DTSTART` that is itself inside a gap or fold is rejected with an error.
- `croner` follows Vixie Cron, including its DST behaviour, which is
  documented. The `cron` crate requires a seconds field and uses Quartz
  DOM/DOW semantics instead.

One DST rule applies to every wall-clock time SomniQ resolves: one-shot times,
day intervals and `rrule` (RFC 5545 §3.3.5).

- **Gap** (the local time never happens): read it with the offset in force
  before the gap. In New York on 8 March 2026, 02:30 becomes 03:30 EDT. On
  Lord Howe's 30-minute shift, 02:15 becomes 02:45.
- **Fold** (the local time happens twice): use the first one.

Cron keeps Vixie's behaviour instead. A fixed-time job inside a gap runs once,
at the first valid minute after it. A wildcard or step job skips the missing
minutes and runs on both passes of a repeated hour, which is what `*/15`
means. Minute and hour intervals are elapsed time, so DST never moves them.

The profile is bounded. RRULE allows one rule line and no MINUTELY or
SECONDLY (use an interval or Cron for those). Each RRULE search is capped at
one million iterations, and missed-occurrence counts stop at 10 000.

## Committed occurrence

An active clock task stores the next occurrence it owes, in
`next_occurrence_at`. The runner wakes on a 30 s tick, or sooner when an
occurrence is due sooner. When that occurrence is due, the runner handles
everything due up to now and moves it past what it handled. Afterwards:

- An edit that leaves the rule as it was keeps the committed occurrence, so a
  rename never moves, skips or re-fires a run. A rule is "the same" when its
  normalised kind, zone, start, interval, Cron text and RRULE text all match.
  An interval with no start the user typed stores the start it derived, so
  this comparison holds across edits.
- Changing the rule re-commits from now.
- Pause keeps the task. Resume commits the next *future* occurrence, so a pause
  is not a backlog of missed runs to catch up on (same as upstream).
- A rule with nothing left, such as a one-shot that ran or an RRULE past its
  `COUNT`, ends the task (`ENDED`). The task and its history are kept.

## Missed runs

Occurrences that fell due while SomniQ was not running are folded into one.
So are occurrences that fell due while the previous run still held the task.
The task's `missed_policy` decides what happens to the latest of them:

- `run_latest` (default; upstream's only behaviour): run it once, late.
- `skip`: run it only if it is at most two minutes late. Otherwise record it
  as `missed` and wait for the next occurrence.

In both cases the delivery record carries `coalesced` (how many earlier
occurrences were folded in) and `first_missed_at`. No record is written for
each individual missed occurrence.

While a previous run holds the task, a due occurrence is owed, not consumed.
Nothing is queued, `next_occurrence_at` stays where it is, and `waiting_reason`
says why. Once the run settles, the next tick delivers the latest due
occurrence with the rest folded in. A run "holds" the task while its card is
queued or holding an execution slot. For a shared conversation it also holds
the task while the card is `awaiting_input`.

## Idempotent dispatch

Each occurrence has a key: `<task>:at:<epoch ms>` for a rule,
`<task>:manual:<ms>` for Run now, and `<task>:mail:<hash(account, message)>`
for mail. The work-task card stores the key in `scheduled_occurrence_key`.
`queue_scheduled_run` does the lookup and the insert under a single store
lock, so two callers for the same key get one card between them. The writes
happen in this order:

1. If the ledger already has a receipt for the key, stop.
2. Insert the card with the key, or find the existing card for that key.
3. Append the receipt.
4. Advance `next_occurrence_at`.

A crash after step 2 leaves a card but no receipt. The restarted runner works
out the same key, finds the card, and writes the receipt with
`recovered: true`. A crash after step 3 leaves a receipt with the occurrence
not advanced, so the retry stops at step 1, even if the user has deleted the
card. A double tick is serialised by the scheduler lock and is a no-op either
way. The guarantee is **at most one card per occurrence**, which means exactly
one queued run per delivered occurrence. It is not exactly-once execution:
whether the run finishes is up to the work-task engine.

## Delivery record vs outcome

`automations/<id>/deliveries.json` holds one receipt per key. It keeps the
newest 200, is pruned when a record is appended, and is rewritten atomically.
Each receipt says what the scheduler did with an occurrence:

| Status | Meaning |
|---|---|
| `queued` | A card was queued for it |
| `missed` | The skip policy dropped it |
| `skipped` | A mail event arrived while the previous run was still going |
| `failed` | It could not be handed over (no repository, unknown project) |

The receipt never records how the run went. `scheduled_task_history` joins
each receipt to its card at read time: the card's status, the independent
Reviewer's verdict (and whether review rounds ran out), and its error. A card
the user deleted shows as `missing`. The UI shows the delivery and the result
as separate columns, so "queued" is never presented as "done".

## Targets

| Mode | Conversation | Maps to |
|---|---|---|
| `session` | A fixed existing chat | `WorkTask.target_session_id` = that chat |
| `new_once` | `sched-<task>`, reserved when the task is created; the first run creates it and later runs continue it | `target_session_id` = the reserved id |
| `new` | One chat per delivery, `sched-<task>-<hash(key)>` | `target_session_id` = derived from the occurrence key, so a crashed delivery that is retried lands in the same chat |

The engine runs a card's turns in `target_session_id` when one is set, and
mints `work-task-<id>-<seq>` otherwise. Resumed cards keep their own session.
Only where the transcript lands changes. Worktree isolation, the independent
review (which runs on its own packet, outside any conversation) and the board
are unchanged.

A `session` target runs in that chat's project. The other two run in the
project stored on the task. Session-to-project lookup now reads the
per-session Chat UI index. The old code read the legacy monolithic
`chat-ui-sessions.json`, which the migration renames to `.bak`. After that
rename, every scheduled run was dispatched to the `default` project.

Upstream lets `new` targets overlap. SomniQ keeps one in-flight run per
automation for every mode, because runs against the same base branch should
not stack up. It also holds a run when another card is using the target
conversation.

## Projects that are plain folders

From 0.4.68 to 0.4.86 a scheduled run was a work task, and a work task
required the project to be a Git repository. Every run in a plain folder
(most research projects, and the default workspace that the old
session-to-project lookup sent everything to) was recorded as `failed` with
"work tasks need a Git repository". Nothing ran.

Plain folders now get the same isolation from a private repository
(`desktop/src-tauri/src/work_task/shadow.rs`):

- SomniQ keeps a bare repository for the folder under
  `<config>/desktop-runtime/work-task-shadow/<name>-<hash of path>.git`. It
  uses the folder as that repository's working tree. Nothing is written into
  the folder, so it gets no `.git` and no `.gitignore`.
- Each run takes a snapshot of the folder on branch `somniq/snapshot` and
  cuts the task's checkout from it as a linked worktree. Inside that checkout
  everything else works unchanged: the commit, the review snapshot, the
  independent Reviewer and the revision loop.
- Accepting takes a fresh snapshot first, so edits the user made meanwhile
  become the base. It then merges that into the task checkout, so any conflict
  lands there. Last, it fast-forwards the snapshot branch with
  `--no-overwrite-ignore`, which is the step that writes the accepted files
  into the folder. Git refuses to overwrite anything the snapshot does not
  track, including files the rules ignore.
- Some files are never copied:
  - caches such as `node_modules/`, virtual environments and `__pycache__`;
  - SomniQ's runtime data, except the deliverable roots `papers`, `slides`,
    `poster`, `web`, `notebooks`, `reports` and `experiments`;
  - Office lock files and SQLite sidecars;
  - files over 50 MB, and files another program holds open.

  The task prompt tells the model about these exclusions. A folder that is
  still over 50 000 files or 2 GB after these exclusions is refused, with the
  reason, and is not half-copied.
- A snapshot is byte-for-byte: `* -text -filter -ident` in `info/attributes`,
  with `core.autocrlf=false`. The repository sets its own identity, hooks path
  and signing settings, so the user's global Git configuration cannot derail
  a commit.

Git still has to be installed. Saving a task now refuses up front in three
cases, instead of recording a failed delivery at every occurrence: the
project is not registered, the folder is gone, or Git is missing. The page
explains the known failures in the user's language (`errorText.ts`), and that
includes the legacy message still sitting in old delivery history.

## Records and compatibility

The record is still `automations/<id>/automation.toml`, now at version 2. It
adds `schedule_kind`, `time_zone`, `start_local`, `anchor_at`, `cron`,
`recurrence`, `next_occurrence_at`, `missed_policy`, `target_mode`,
`project_id` and `waiting_reason`.

v1 records read as interval tasks in the system zone, bound to their chat.
Their first committed occurrence is one interval after their last run, which
is when v1 would have fired them.

The legacy `rrule` field is written only for interval and mail tasks. A
pre-v2 build requires that field, so it fails to parse once, Cron and RRULE
records and ignores them, instead of reading them as "every minute". On the
wire, the trigger is `schedule`. The v1 spelling `interval` is still accepted.

## UI

The editor has rule kind, zone and kind-specific fields. "Next runs" is
computed by the backend (`scheduled_task_preview`) from the rule being
edited, so the editor and the runner cannot disagree. Times are shown on the
zone's wall clock with its UTC offset, so a DST change is visible (GMT-5, then
GMT-4). The editor also covers the missed-run policy, the target mode, Run now
(which does not move the committed occurrence), and the delivery history with
delivery and outcome in separate columns.

## Known limitations

- SomniQ must be running for anything to fire. After a restart, the
  missed-run policy applies.
- A `session` target shares a chat with the user. If the user has a turn
  running in that chat when a scheduled run starts, the run's turn is refused
  and the card fails. The failure is visible on the card and in the history,
  but it is not retried.
- A `session` target's run is appended to that chat's model-side history, so
  later turns in the chat can see it. Work-task turns use the ordinary desktop
  chat stream. Whether an open chat window shows a scheduled run live, and
  whether it keeps showing it after a reload, has not been checked in the
  running app yet.
- An RRULE whose `DTSTART` falls in a DST gap or fold is rejected by the
  crate. Pick another start time.
- Missed counts after a crash can include an occurrence that was delivered
  but not yet advanced past. The count is informational.

## Verification

From `desktop/src-tauri` (with `CARGO_TARGET_DIR` off the F: drive):
`cargo test --lib scheduled` covers rule expansion across New York, Berlin
and Lord Howe gaps and folds, coalescing, the skip policy, dedupe across both
crash points, busy deferral, one-shot ending, and v1 cadence.
`cargo test --lib work_task` covers the occurrence-key dedupe and the
shared-conversation hold, plus the plain-folder path:
- snapshot rules, byte fidelity and the size limit;
- accepting writes changes back and keeps the user's concurrent edits;
- a file left out of the snapshot is never overwritten.

`cargo test --lib scheduled` also covers delivery into a plain folder and the
save-time refusal for an unregistered project. From `desktop/`: `npx vitest run src/scheduled`,
`npm run typecheck`, `npm run build`.

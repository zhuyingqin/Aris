//! Work-task data model.
//!
//! Wire shape mirrors `desktop/src/types.ts` (`WorkTask`). Field names are the
//! contract the board reads, so renames here are breaking changes on both
//! sides — `work_task_statuses_are_exhaustive` pins the status vocabulary.

use serde::{Deserialize, Serialize};

/// Where a task sits in its lifecycle.
///
/// `todo → queued → preparing → running → review → merging → done`, with
/// `failed`, `canceled`, `paused`, `awaiting_input` and `interrupted` reachable
/// from most of it. The board aggregates these into four columns (see
/// `columnForStatus` on the frontend); the statuses themselves stay exact so
/// the engine can reason about them.
///
/// Every status here has a producer. A state nothing can reach would put a
/// label on the board that never appears.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskStatus {
    /// Created, not claimed. The only status a user can drag a card back to.
    Todo,
    /// Claimed for execution, waiting for a concurrency slot.
    Queued,
    /// Out of the queue and setting up: worktree creation, before any model
    /// turn has started. Holds a slot and is cancellable.
    Preparing,
    /// A model turn is in flight.
    Running,
    /// A pause was requested and the turn has not wound down yet. Holds its
    /// slot: the turn is still executing inside the worktree.
    Pausing,
    /// Stopped at the user's request with its checkout and session intact, so
    /// resuming continues the same work rather than starting over.
    Paused,
    /// The turn ended after asking the user a question. The checkout, session,
    /// and question are persisted, but no model request or execution slot is
    /// held; answering it queues a new turn in the same session and checkout.
    AwaitingInput,
    /// The turn finished and committed; an independent Reviewer is checking
    /// the committed result before the user is asked to look at it.
    Reviewing,
    /// The Reviewer asked for changes and the executor is making them, in the
    /// same checkout and the same conversation.
    Revising,
    /// The turn finished. Waiting for the user to accept, return, or drop.
    Review,
    /// Merge in flight — the one status the user cannot cancel, because the
    /// base branch is being written.
    Merging,
    /// The process that was running this task is gone (SomniQ was closed, or
    /// crashed). Distinct from `failed`: nothing went wrong with the work, and
    /// the checkout is still there to resume into.
    Interrupted,
    Done,
    Failed,
    Canceled,
}

impl WorkTaskStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::Running => "running",
            Self::Pausing => "pausing",
            Self::Paused => "paused",
            Self::AwaitingInput => "awaiting_input",
            Self::Reviewing => "reviewing",
            Self::Revising => "revising",
            Self::Review => "review",
            Self::Merging => "merging",
            Self::Interrupted => "interrupted",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    /// True while the engine owns the task. A user edit or delete has to be
    /// refused here, and a restart has to reconcile it first.
    ///
    /// `awaiting_input` is protected as well: no turn is alive, but editing the
    /// task underneath its persisted question would change the brief the
    /// eventual answer resumes.
    #[must_use]
    pub fn is_engine_owned(self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::Preparing
                | Self::Running
                | Self::Pausing
                | Self::AwaitingInput
                | Self::Reviewing
                | Self::Revising
                | Self::Merging
        )
    }

    /// True while a run is actually executing and therefore holding one of the
    /// project's concurrency slots.
    ///
    /// Wider than "a model turn is streaming": a paused-but-not-yet-stopped
    /// turn is still inside the worktree. `awaiting_input` is deliberately not
    /// included because that turn has ended and released its slot.
    #[must_use]
    pub fn holds_a_slot(self) -> bool {
        matches!(
            self,
            Self::Preparing
                | Self::Running
                | Self::Pausing
                | Self::Reviewing
                | Self::Revising
                | Self::Merging
        )
    }

    /// True once nothing further will happen on its own.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Canceled)
    }

    /// True when starting the task would continue work that already exists,
    /// rather than beginning it. Drives the resume path: the same checkout and
    /// the same chat session are picked back up instead of recreated.
    #[must_use]
    pub fn is_resumable(self) -> bool {
        matches!(self, Self::Paused | Self::Interrupted | Self::Failed)
    }
}

/// Why a run was asked to stop.
///
/// A bare "cancelled" flag cannot distinguish the three, and they differ in
/// exactly the thing that matters afterwards: whether the checkout survives.
/// `Cancel` throws the work away, `Pause` and `Shutdown` keep it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskStopReason {
    Cancel,
    Pause,
    Shutdown,
}

impl WorkTaskStopReason {
    /// Whether the task's isolated checkout must be preserved for a later
    /// resume. Only an outright cancel discards it.
    #[must_use]
    pub fn preserves_worktree(self) -> bool {
        !matches!(self, Self::Cancel)
    }
}

/// Something the task cannot proceed without a human answering.
///
/// One variant today, because one thing produces one: the `AskUserQuestion`
/// tool, which a work-task turn is allowed to call and which would otherwise
/// block forever with nothing on the board able to answer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkTaskPendingAction {
    /// The turn called `AskUserQuestion`, persisted the question, and ended.
    #[serde(rename_all = "camelCase")]
    Question {
        /// The model's tool-use id, retained as a durable transcript anchor.
        /// `work_task_reply` starts a new turn in the same session and checkout
        /// with the question and answer in its continuation context.
        tool_use_id: String,
        /// Short label the model supplied, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        question: String,
        /// Offered choices. A user may always answer with free text instead.
        #[serde(default)]
        options: Vec<String>,
        asked_at: u64,
    },
}

/// How the task's isolation was set up, recorded so a later merge does not have
/// to re-derive it from a repository that has moved on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskWorktree {
    /// Absolute path of the task's checkout.
    pub path: String,
    /// Branch created for the task.
    pub branch: String,
    /// Branch the task was cut from, and where an accepted result lands.
    pub base_branch: String,
    /// Commit the worktree was created at. The merge reads this to tell "the
    /// base moved" from "the task changed nothing".
    pub base_sha: String,
}

/// A merge that was started and may not have finished.
///
/// Written before the merge runs, so a process that dies mid-merge leaves
/// behind enough to ask Git what actually happened. Without it a `merging` row
/// is unrecoverable: the status alone cannot distinguish "stage A had not run
/// yet" from "the base branch already has the work", and the user cannot cancel
/// out of `merging` by design.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskMergeIntent {
    /// Branch whose tip has to end up reachable from the base for the merge to
    /// count as landed.
    pub branch: String,
    pub base_branch: String,
    /// The base branch's commit when the merge began. Recorded for the recovery
    /// message — the verdict itself comes from ancestry, not from comparing
    /// this against the current head, because an unrelated commit by the user
    /// moves the base too.
    pub base_head: String,
    pub started_at: u64,
}

/// A diff summary of the task's work branch against its base.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskChanges {
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
}

/// What happened to one file between the task's base and its result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskFileChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// A file became a symlink, or vice versa. Rare, but it is not a
    /// modification and calling it one hides a change the user cares about.
    TypeChanged,
    /// Git reported a status this build does not model. Shown as-is rather
    /// than silently folded into `Modified`.
    Other,
}

impl WorkTaskFileChangeKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Copied => "copied",
            Self::TypeChanged => "type changed",
            Self::Other => "changed",
        }
    }
}

/// One file in a task's result.
///
/// The reason this exists at all: a text patch cannot describe a PDF, a
/// deletion, or a rename in a way a reviewer can act on, and an empty patch
/// cannot distinguish "produced nothing" from "produced a 2 MB slide deck".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskReviewFile {
    pub path: String,
    /// Where the file came from, for a rename or a copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub change_kind: WorkTaskFileChangeKind,
    /// Git reported no line counts for it. The review panel must offer
    /// something other than a patch for these.
    #[serde(default)]
    pub binary: bool,
    /// Line counts. `None` exactly when `binary` — a binary file has changed
    /// without having changed any lines, which is not the same as zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
    /// Size of the file in the result, absent for a deletion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<u64>,
}

/// Why a task's result contains nothing to show.
///
/// Every one of these used to render as "no changes were produced", which is
/// true for one of them and actively misleading for the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskEmptyReason {
    /// The task ran and deliberately changed no files — an analysis, a search,
    /// a question answered in the transcript.
    NoRepositoryChanges,
    /// It changed no tracked files but produced standalone deliverables, which
    /// are reviewed separately from the diff.
    ArtifactsOnly,
    /// Nothing at all came out of it.
    NothingProduced,
    /// The checkout is gone, so there is nothing to read — the opposite of
    /// "no changes", and the accept button must not be offered.
    WorktreeMissing,
    /// Reading the result failed. The message is on `last_error`.
    SnapshotFailed,
}

/// What the independent Reviewer concluded about a task's committed result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskVerdict {
    /// The result does what the task asked for. Only now is the user shown it.
    Pass,
    /// Something is wrong and the executor can fix it. Drives another round.
    Revise,
    /// Blocked on something no further round will resolve — a decision, an
    /// external dependency. Handed to the user with the reason.
    NeedsUser,
    /// No Reviewer ran: none is configured, it shares an identity with the
    /// executor, or it failed. Recorded as itself rather than as a pass, so a
    /// result nobody checked is never presented as one that was.
    Unavailable,
}

impl WorkTaskVerdict {
    /// Whether the executor should be asked for another round.
    #[must_use]
    pub fn wants_revision(self) -> bool {
        matches!(self, Self::Revise)
    }
}

/// One thing the Reviewer found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskReviewIssue {
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub recommendation: String,
}

/// The independent review a task's result went through.
///
/// Present on any task whose run completed, including when the verdict is
/// `Unavailable`: "nobody checked this" is information the user needs, and
/// leaving the field empty would make an unchecked result indistinguishable
/// from a checked one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskReviewState {
    /// Rounds spent. 1 means the first result passed.
    pub round: u32,
    pub max_rounds: u32,
    pub verdict: WorkTaskVerdict,
    #[serde(default)]
    pub summary: String,
    /// What is still wrong. On a `Pass` this is empty; after the last round it
    /// is what the user is being asked to judge for themselves.
    #[serde(default)]
    pub issues: Vec<WorkTaskReviewIssue>,
    /// Which model checked it. The executor is not allowed to be its own
    /// reviewer, and this is how a user can tell that it was not.
    #[serde(default)]
    pub reviewer_model: String,
    /// True when the loop ran out of rounds with issues outstanding, as
    /// opposed to stopping because it was satisfied.
    #[serde(default)]
    pub exhausted: bool,
    pub checked_at: u64,
}

/// A deliverable a task produced that is not part of the project's own files.
///
/// A report, a deck, an exported figure — things the user asked a task to make
/// but that have no business being a commit in their repository. They are
/// copied out of the worktree into SomniQ's managed store when the run
/// settles, so getting at one never requires merging a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskArtifact {
    /// Stable across re-imports of the same path, so a retried import replaces
    /// its predecessor instead of stacking up duplicates.
    pub id: String,
    /// Path relative to the task's staging directory, kept so a deliverable
    /// made of several files (a deck and its figures) is still legible.
    pub relative_path: String,
    /// Name to show and to default an export to.
    pub title: String,
    /// Absolute path inside SomniQ's managed store. Not a place the user is
    /// expected to browse — the panel's Export and Reveal actions are.
    pub managed_path: String,
    /// Where the user last exported it, if they have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_path: Option<String>,
    pub byte_size: u64,
    /// Verified after the copy. A deliverable that arrived corrupt is worse
    /// than one that failed to arrive, because nothing would say so.
    pub sha256: String,
    pub created_at: u64,
}

/// An immutable description of what a task produced.
///
/// Pinned at `base_sha..head_sha` when the run settles rather than recomputed
/// per view: two openings of the same review have to show the same thing, and
/// anything that touches the worktree in between would otherwise change it.
///
/// Deliberately does NOT hold the patch text. The store is read in full on
/// every board load, and a few hundred kilobytes of diff per card would make
/// listing tasks as expensive as reviewing one. The patch is fetched on demand
/// from the pinned revisions, so it is just as stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskReviewSnapshot {
    pub base_sha: String,
    pub head_sha: String,
    #[serde(default)]
    pub files: Vec<WorkTaskReviewFile>,
    /// Deliverables produced alongside (or instead of) repository changes.
    /// Reviewed separately: they are not merged, they are exported.
    #[serde(default)]
    pub artifacts: Vec<WorkTaskArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_reason: Option<WorkTaskEmptyReason>,
    pub captured_at: u64,
}

impl WorkTaskReviewSnapshot {
    /// Roll the per-file rows up into the counters the card shows.
    #[must_use]
    pub fn changes(&self) -> WorkTaskChanges {
        WorkTaskChanges {
            files_changed: u32::try_from(self.files.len()).unwrap_or(u32::MAX),
            additions: self
                .files
                .iter()
                .filter_map(|file| file.additions)
                .sum::<u32>(),
            deletions: self
                .files
                .iter()
                .filter_map(|file| file.deletions)
                .sum::<u32>(),
        }
    }
}

/// One task on the board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    pub id: String,
    pub title: String,
    /// What the agent is asked to do. Replayed verbatim at launch.
    #[serde(default)]
    pub prompt: String,
    pub status: WorkTaskStatus,
    /// Board position within its column. Also drives the launch queue order.
    #[serde(default)]
    pub sort_order: i64,
    /// Incremented on every launch. Events and settles are matched on it, so a
    /// cancel racing a late completion settles nothing — the generation no
    /// longer matches. Ported from codeg, where it is the core race guard.
    #[serde(default)]
    pub run_seq: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkTaskWorktree>,
    /// A worktree is recorded but unusable: its directory is gone from disk.
    ///
    /// Derived on every read rather than stored — the row cannot know, and a
    /// checkout can disappear between two listings. Kept separate from
    /// `last_error` because the two mean opposite things to the board: this one
    /// says the work cannot be merged *at all*, while `last_error` may just be
    /// the reason the last attempt did not go through, which the user can fix
    /// and retry. Conflating them made a failed merge hide the Accept button
    /// permanently.
    #[serde(default)]
    pub worktree_missing: bool,
    /// Chat session the task's turns run in, so the transcript is inspectable
    /// after the fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The model's closing summary, shown on the review card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<WorkTaskChanges>,
    /// What the run produced, pinned at the revisions it produced it at.
    /// Absent on cards made before structured review existed; those are
    /// snapshotted on first view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_snapshot: Option<WorkTaskReviewSnapshot>,
    /// What the independent Reviewer concluded, and after how many rounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_state: Option<WorkTaskReviewState>,
    /// Why the task failed. Present only on `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Commit the accepted merge produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_commit: Option<String>,
    /// Present only while `status == Merging`. Cleared by whichever pass
    /// settles the merge, so a leftover intent is itself the signal that a
    /// merge was interrupted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_intent: Option<WorkTaskMergeIntent>,
    /// Model override for this task; `None` uses the project default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The automation that produced this task, when one did.
    ///
    /// Kept so a schedule whose interval is shorter than its work does not
    /// stack up runs against the same branch, and so the automation's history
    /// can point at the cards it actually produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_task_id: Option<String>,
    /// What the run is doing right now, in one phrase. Coarse by design — it is
    /// set at the phase boundaries the engine actually knows about, so it never
    /// claims progress the engine cannot vouch for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_message: Option<String>,
    /// Last time the run proved it was alive.
    ///
    /// The board uses this to tell "working" from "the window says running but
    /// nothing is behind it". Written on a throttle rather than per event: a
    /// heartbeat is a whole-file atomic write, and one per second per task
    /// would cost more than it tells anyone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_heartbeat_at: Option<u64>,
    /// Present exactly while `status == AwaitingInput`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<WorkTaskPendingAction>,
    /// One-shot context for the next turn when it must continue an existing
    /// checkout/session. A question reply records the exact question and
    /// answer here; pause/interruption retries record why they are resuming.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_context: Option<String>,
    /// Why the last stop was requested. Kept after the task settles, because
    /// `paused` and `canceled` are both reached through the same handshake and
    /// only this says which one the user asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<WorkTaskStopReason>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl WorkTask {
    #[must_use]
    pub fn new(id: String, title: String, prompt: String, now: u64) -> Self {
        Self {
            id,
            title,
            prompt,
            status: WorkTaskStatus::Todo,
            sort_order: now as i64,
            run_seq: 0,
            worktree: None,
            worktree_missing: false,
            session_id: None,
            result_summary: None,
            changes: None,
            review_snapshot: None,
            review_state: None,
            last_error: None,
            merge_commit: None,
            merge_intent: None,
            model: None,
            scheduled_task_id: None,
            progress_message: None,
            last_heartbeat_at: None,
            pending_action: None,
            resume_context: None,
            stop_reason: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Clear everything that described the *previous* run.
    ///
    /// Two groups, cleared together because every caller wants both and
    /// splitting them is what let them drift apart:
    ///
    /// - **How it was running**: phase, heartbeat, a parked question, the stop
    ///   reason. A resumed task carrying these describes a process that no
    ///   longer exists.
    /// - **What it produced**: the diff counts, the closing summary, the
    ///   snapshot, and the Reviewer's verdict. These are the result of an
    ///   attempt that is being replaced, and leaving them is worse than
    ///   leaving nothing — a re-run that fails would still show the previous
    ///   attempt's file counts and "passed independent review", which is a
    ///   claim about work that is no longer there.
    ///
    /// Deliberately NOT cleared: `worktree` and `session_id`, which a resume
    /// continues into, and `last_error`, which is usually why the user is
    /// re-running at all.
    pub fn clear_run_state(&mut self) {
        self.progress_message = None;
        self.last_heartbeat_at = None;
        self.pending_action = None;
        self.resume_context = None;
        self.stop_reason = None;
        self.changes = None;
        self.result_summary = None;
        self.review_snapshot = None;
        self.review_state = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The board maps every status into a column, and the frontend's copy of
    /// this list is what it maps from. A status added here without being filed
    /// into a column disappears from the board silently, so both sides pin the
    /// same vocabulary — this is the Rust half.
    #[test]
    fn work_task_statuses_are_exhaustive() {
        use WorkTaskStatus::*;
        let all = [
            Todo,
            Queued,
            Preparing,
            Running,
            Pausing,
            Paused,
            AwaitingInput,
            Review,
            Merging,
            Interrupted,
            Done,
            Failed,
            Canceled,
        ];
        let wire = all
            .iter()
            .map(|status| serde_json::to_value(status).expect("serialize"))
            .map(|value| value.as_str().expect("string").to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            wire,
            [
                "todo",
                "queued",
                "preparing",
                "running",
                "pausing",
                "paused",
                "awaiting_input",
                "review",
                "merging",
                "interrupted",
                "done",
                "failed",
                "canceled",
            ]
        );
        // `as_str` is what the engine logs and the store writes; it must not
        // drift from the serde form.
        for status in all {
            assert_eq!(
                serde_json::to_value(status).expect("serialize"),
                serde_json::Value::String(status.as_str().to_string())
            );
        }
    }

    /// The engine owns a task exactly while something is in flight. Getting
    /// this wrong either lets a user edit a running task's prompt out from
    /// under it, or locks a card nothing is working on.
    #[test]
    fn engine_ownership_covers_every_in_flight_status() {
        use WorkTaskStatus::*;
        for status in [
            Queued,
            Preparing,
            Running,
            Pausing,
            AwaitingInput,
            Reviewing,
            Revising,
            Merging,
        ] {
            assert!(status.is_engine_owned(), "{status:?} should be owned");
        }
        // A paused or interrupted task has no turn behind it, so the card is
        // the user's again — this is what makes "close SomniQ, reopen it, keep
        // going" work instead of stranding the row.
        for status in [Todo, Paused, Interrupted, Review, Done, Failed, Canceled] {
            assert!(!status.is_engine_owned(), "{status:?} should be free");
        }
    }

    /// The concurrency ceiling is counted from this. A status that executes
    /// inside the worktree but is not counted lets the engine launch past the
    /// ceiling; one counted without executing wedges the queue.
    #[test]
    fn slot_holders_are_exactly_the_statuses_with_a_live_run() {
        use WorkTaskStatus::*;
        for status in [Preparing, Running, Pausing, Reviewing, Revising, Merging] {
            assert!(status.holds_a_slot(), "{status:?} should hold a slot");
        }
        for status in [
            Todo,
            Queued,
            Paused,
            AwaitingInput,
            Interrupted,
            Review,
            Done,
            Failed,
            Canceled,
        ] {
            assert!(!status.holds_a_slot(), "{status:?} should hold no slot");
        }
    }

    /// `review` and `failed` are NOT terminal: both are places a user acts
    /// from. Only `done` and `canceled` end a task's life.
    #[test]
    fn only_done_and_canceled_are_terminal() {
        use WorkTaskStatus::*;
        assert!(Done.is_terminal());
        assert!(Canceled.is_terminal());
        for status in [
            Todo,
            Queued,
            Preparing,
            Running,
            Pausing,
            Paused,
            AwaitingInput,
            Reviewing,
            Revising,
            Review,
            Merging,
            Interrupted,
            Failed,
        ] {
            assert!(!status.is_terminal(), "{status:?} should not be terminal");
        }
    }

    /// Resuming reuses the existing checkout and chat session. Getting this
    /// list wrong either throws away work the user expected to continue, or
    /// tries to continue into a checkout that was never made.
    #[test]
    fn only_stopped_runs_with_surviving_work_are_resumable() {
        use WorkTaskStatus::*;
        for status in [Paused, Interrupted, Failed] {
            assert!(status.is_resumable(), "{status:?} should resume");
        }
        // `canceled` releases its worktree, so a start from there is a fresh
        // run rather than a continuation.
        for status in [Todo, Queued, Running, Review, Done, Canceled] {
            assert!(!status.is_resumable(), "{status:?} should not resume");
        }
    }

    /// The one thing the stop reason exists to decide.
    #[test]
    fn only_an_outright_cancel_discards_the_checkout() {
        assert!(!WorkTaskStopReason::Cancel.preserves_worktree());
        assert!(WorkTaskStopReason::Pause.preserves_worktree());
        assert!(WorkTaskStopReason::Shutdown.preserves_worktree());
    }

    /// The pending action is the board's whole view of a blocked turn, and the
    /// tool-use id inside it is what routes the answer back. A wire shape that
    /// drops it would render a question nothing can answer.
    #[test]
    fn a_pending_question_round_trips_with_its_tool_use_id() {
        let action = WorkTaskPendingAction::Question {
            tool_use_id: "toolu_42".into(),
            header: Some("Scope".into()),
            question: "Rewrite section 3 only, or the whole chapter?".into(),
            options: vec!["Section 3".into(), "Whole chapter".into()],
            asked_at: 1_700,
        };
        let wire = serde_json::to_value(&action).expect("serialize");
        assert_eq!(wire["kind"], "question");
        assert_eq!(wire["toolUseId"], "toolu_42");
        assert_eq!(
            serde_json::from_value::<WorkTaskPendingAction>(wire).expect("deserialize"),
            action
        );
    }

    /// A resumed run must not inherit the last run's question or phase text.
    #[test]
    fn clearing_run_state_drops_everything_about_the_previous_run() {
        let mut task = WorkTask::new("t1".into(), "T".into(), String::new(), 0);
        task.progress_message = Some("Running the model turn".into());
        task.last_heartbeat_at = Some(9);
        task.stop_reason = Some(WorkTaskStopReason::Pause);
        task.pending_action = Some(WorkTaskPendingAction::Question {
            tool_use_id: "t".into(),
            header: None,
            question: "?".into(),
            options: Vec::new(),
            asked_at: 0,
        });
        // The previous attempt's result, which a re-run replaces.
        task.changes = Some(WorkTaskChanges {
            files_changed: 2,
            additions: 14,
            deletions: 3,
        });
        task.result_summary = Some("Rewrote section 3.".into());
        task.review_snapshot = Some(WorkTaskReviewSnapshot {
            base_sha: "aaa".into(),
            head_sha: "bbb".into(),
            files: Vec::new(),
            artifacts: Vec::new(),
            empty_reason: None,
            captured_at: 1,
        });
        task.review_state = Some(WorkTaskReviewState {
            round: 1,
            max_rounds: 2,
            verdict: WorkTaskVerdict::Pass,
            summary: "Looks right.".into(),
            issues: Vec::new(),
            reviewer_model: "reviewer".into(),
            exhausted: false,
            checked_at: 1,
        });
        task.worktree = Some(WorkTaskWorktree {
            path: "/tmp/wt".into(),
            branch: "somniq/task/t1".into(),
            base_branch: "main".into(),
            base_sha: "aaa".into(),
        });
        task.session_id = Some("work-task-t1-1".into());
        task.last_error = Some("tectonic exited with status 1".into());

        task.clear_run_state();

        assert!(task.progress_message.is_none());
        assert!(task.last_heartbeat_at.is_none());
        assert!(task.stop_reason.is_none());
        assert!(task.pending_action.is_none());
        // The previous attempt's result goes too. A re-run that then fails
        // would otherwise still show that attempt's file counts and its
        // "passed independent review" — a claim about work no longer there.
        assert!(task.changes.is_none());
        assert!(task.result_summary.is_none());
        assert!(task.review_snapshot.is_none());
        assert!(task.review_state.is_none());
        // The checkout and the transcript are NOT run state: they are what a
        // resume continues into. Nor is the error, which is usually why the
        // user is re-running at all.
        assert!(task.worktree.is_some());
        assert!(task.session_id.is_some());
        assert!(task.last_error.is_some());
        assert_eq!(task.status, WorkTaskStatus::Todo);
    }
}

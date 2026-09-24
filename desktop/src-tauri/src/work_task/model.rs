//! Work-task data model.
//!
//! Wire shape mirrors `desktop/src/types.ts` (`WorkTask`). Field names are the
//! contract the board reads, so renames here are breaking changes on both
//! sides — `work_task_statuses_are_exhaustive` pins the status vocabulary.

use serde::{Deserialize, Serialize};

/// Where a task sits in its lifecycle.
///
/// `todo → queued → preparing → running → review → merging → done`, with
/// `failed` and `canceled` reachable from most of it. The board aggregates
/// these into four columns (see `columnForStatus` on the frontend); the
/// statuses themselves stay exact so the engine can reason about them.
///
/// Deliberately absent: codeg's `awaiting_input`. An Aris task turn runs
/// against [`super::permission::WorktreePermissionPrompter`], which never
/// blocks on a question, so there is no state in which a task is stopped
/// waiting for a human mid-run. Adding the state before something can produce
/// it would put a column on the board that nothing ever reaches.
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
    /// The turn finished. Waiting for the user to accept, return, or drop.
    Review,
    /// Merge in flight — the one status the user cannot cancel, because the
    /// base branch is being written.
    Merging,
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
            Self::Review => "review",
            Self::Merging => "merging",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    /// True while the engine owns the task. A user edit or delete has to be
    /// refused here, and a restart has to cancel first.
    #[must_use]
    pub fn is_engine_owned(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Preparing | Self::Running | Self::Merging
        )
    }

    /// True once nothing further will happen on its own.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Canceled)
    }
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
            last_error: None,
            merge_commit: None,
            merge_intent: None,
            model: None,
            created_at: now,
            updated_at: now,
        }
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
            Todo, Queued, Preparing, Running, Review, Merging, Done, Failed, Canceled,
        ];
        let wire = all
            .iter()
            .map(|status| serde_json::to_value(status).expect("serialize"))
            .map(|value| value.as_str().expect("string").to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            wire,
            [
                "todo", "queued", "preparing", "running", "review", "merging", "done", "failed",
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
        for status in [Queued, Preparing, Running, Merging] {
            assert!(status.is_engine_owned(), "{status:?} should be owned");
        }
        for status in [Todo, Review, Done, Failed, Canceled] {
            assert!(!status.is_engine_owned(), "{status:?} should be free");
        }
    }

    /// `review` and `failed` are NOT terminal: both are places a user acts
    /// from. Only `done` and `canceled` end a task's life.
    #[test]
    fn only_done_and_canceled_are_terminal() {
        use WorkTaskStatus::*;
        assert!(Done.is_terminal());
        assert!(Canceled.is_terminal());
        for status in [Todo, Queued, Preparing, Running, Review, Merging, Failed] {
            assert!(!status.is_terminal(), "{status:?} should not be terminal");
        }
    }
}

//! The work-task execution engine.
//!
//! One background ticker per process (mirroring `scheduled.rs`) plus an
//! immediate pump whenever a task is queued, so starting a task does not wait
//! for the next tick.
//!
//! ## Generations
//!
//! Every launch claims a fresh `run_seq` and carries it through to the settle.
//! A settle that finds a different `run_seq` on disk writes nothing. This is
//! the whole race story, ported from codeg: a cancel that lands while a turn is
//! finishing bumps the generation, so the completing turn resolves into a
//! no-op instead of dragging a card the user just dropped back into review.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::model::{WorkTask, WorkTaskMergeIntent, WorkTaskStatus};
use super::{store, worktree};

/// How many tasks of one project may hold a slot at once.
///
/// Each running task is a full model turn with tools, so the ceiling is about
/// what a person can review rather than what the machine can bear. Not
/// configurable yet — a setting for it is only worth adding once someone finds
/// the default wrong.
const MAX_CONCURRENT_PER_PROJECT: usize = 2;

/// Sweep cadence. The pump also runs on demand, so this only has to catch
/// tasks whose trigger was missed (a crash mid-launch, a queue left behind by
/// a previous run).
const TICK_SECS: u64 = 20;

/// Cap on the patch handed to the review panel.
const MAX_DIFF_CHARS: usize = 400_000;

static RUNNER_STARTED: OnceLock<()> = OnceLock::new();

/// Cancellation flags for tasks currently in flight, keyed by task id.
///
/// A cancel flips the flag so the running turn stops at its next checkpoint,
/// *and* bumps the task's `run_seq` so the turn's eventual settle is discarded.
/// Both are needed: the flag stops the work, the generation stops the write.
type CancelRegistry = Mutex<HashMap<String, Arc<AtomicBool>>>;

fn cancels() -> &'static CancelRegistry {
    static CANCELS: OnceLock<CancelRegistry> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancel(task_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut registry) = cancels().lock() {
        registry.insert(task_id.to_string(), flag.clone());
    }
    flag
}

fn clear_cancel(task_id: &str) {
    if let Ok(mut registry) = cancels().lock() {
        registry.remove(task_id);
    }
}

/// Signal a running task to stop. Returns whether anything was listening.
pub(crate) fn signal_cancel(task_id: &str) -> bool {
    let Ok(registry) = cancels().lock() else {
        return false;
    };
    registry
        .get(task_id)
        .map(|flag| {
            flag.store(true, Ordering::SeqCst);
            true
        })
        .unwrap_or(false)
}

/// Tell the board something changed. Best-effort: a dropped notification costs
/// a stale card until the next poll, and must never fail a state transition
/// that already committed to disk.
pub(crate) fn emit_changed(app: &AppHandle, project_id: &str) {
    let _ = app.emit(
        "work-task-changed",
        serde_json::json!({ "projectId": project_id }),
    );
}

/// Start the background ticker once per process.
pub(crate) fn start_runner(app: AppHandle) {
    if RUNNER_STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Before anything is pumped: no turn and no merge survives a restart,
        // so rows still claiming to be in flight are describing a process that
        // no longer exists. Running this first also keeps the sweep below from
        // launching against a half-made worktree.
        reconcile_on_boot(&app);
        let mut ticker = tokio::time::interval(Duration::from_secs(TICK_SECS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick fires immediately; skip it so a launch during startup
        // is not raced by a sweep before the project registry is readable.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            sweep(&app).await;
        }
    });
}

/// Bring every project's board back in line with what actually survived.
///
/// `preparing` and `running` describe a turn that is gone, so they fail with a
/// reason rather than sitting there forever — a card in either state cannot be
/// edited or deleted, so leaving it would strand it permanently.
///
/// `queued` is deliberately left alone, which is where this departs from
/// codeg: claiming is one atomic store update here, so a `queued` row provably
/// never launched and the next pump can simply pick it up. Failing it would
/// make every restart lose a queue the user had lined up.
///
/// `merging` is not a liveness question at all — only Git knows whether the
/// work landed — so it goes to [`recover_merge`].
pub(crate) fn reconcile_on_boot(app: &AppHandle) {
    for project_id in store::projects_with_tasks() {
        let Some(project_path) = crate::projects::project_path_for_registered_id(&project_id)
        else {
            continue;
        };
        if reconcile_projects(&project_id, &project_path) {
            emit_changed(app, &project_id);
        }
    }
}

/// One project's share of [`reconcile_on_boot`]. Returns whether anything moved.
pub(crate) fn reconcile_projects(project_id: &str, project_path: &Path) -> bool {
    let mut changed = false;
    for task in store::list(project_id) {
        match task.status {
            WorkTaskStatus::Preparing | WorkTaskStatus::Running => {
                let interrupted = store::update(project_id, &task.id, |task| {
                    task.status = WorkTaskStatus::Failed;
                    task.last_error = Some(
                        "SomniQ closed while this task was running, so the run was interrupted. Start it again to retry."
                            .to_string(),
                    );
                    // A new generation, so a settle from the dead process —
                    // impossible today, but free to guard — cannot land.
                    task.run_seq = task.run_seq.saturating_add(1);
                    Ok(())
                });
                changed |= interrupted.is_ok();
            }
            WorkTaskStatus::Merging => {
                changed |= recover_merge(project_id, project_path, &task.id).is_ok();
            }
            _ => {}
        }
    }
    changed
}

/// Test seams for the two halves of the cancel handshake, which production
/// code reaches only from inside a spawned run.
#[cfg(test)]
pub(crate) fn register_cancel_for_test(task_id: &str) -> Arc<AtomicBool> {
    register_cancel(task_id)
}

#[cfg(test)]
pub(crate) fn release_cancelled_worktree_for_test(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) {
    clear_cancel(task_id);
    release_cancelled_worktree(project_id, project_path, task_id);
}

/// Settle a merge that was interrupted, from Git rather than from bookkeeping.
///
/// A `merging` row cannot be cancelled by the user, so if this pass does not
/// resolve it the card has no way out at all.
fn recover_merge(project_id: &str, project_path: &Path, task_id: &str) -> Result<(), String> {
    with_merge_lock(project_id, || {
        recover_merge_locked(project_id, project_path, task_id)
    })
}

fn recover_merge_locked(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<(), String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    if task.status != WorkTaskStatus::Merging {
        return Ok(());
    }
    let Some(intent) = task.merge_intent.clone() else {
        // Interrupted before the intent was written, which means before any
        // Git command ran: nothing landed.
        return back_to_review(
            project_id,
            task_id,
            "SomniQ closed before this merge started. Nothing was written to your branch — accept it again.",
        );
    };

    let landed = worktree::branch_is_merged_into(project_path, &intent.branch, &intent.base_branch);
    match landed {
        Ok(true) => {
            let commit = worktree::resolve(project_path, &intent.base_branch)
                .unwrap_or_else(|_| intent.base_head.clone());
            // The work is on the base branch, so the checkout is finished with
            // — but the branch stays, exactly as on the live path.
            if let Some(tree) = task.worktree.as_ref() {
                let _ = worktree::discard(project_path, tree, true);
            }
            store::update(project_id, task_id, |task| {
                task.status = WorkTaskStatus::Done;
                task.merge_commit = Some(commit.clone());
                task.merge_intent = None;
                task.last_error = None;
                Ok(())
            })
            .map(|_| ())
        }
        Ok(false) => back_to_review(
            project_id,
            task_id,
            "SomniQ closed part-way through this merge. Nothing reached your branch, but the task's own checkout may hold a partly-merged state — review it and accept again.",
        ),
        // Cannot tell. Reporting it as landed would lose the work; reporting it
        // as not landed could merge twice. Say so and let the user look.
        Err(error) => back_to_review(
            project_id,
            task_id,
            &format!("SomniQ could not establish whether this merge finished: {error}"),
        ),
    }
}

fn back_to_review(project_id: &str, task_id: &str, reason: &str) -> Result<(), String> {
    store::update(project_id, task_id, |task| {
        task.status = WorkTaskStatus::Review;
        task.merge_intent = None;
        task.last_error = Some(reason.to_string());
        Ok(())
    })
    .map(|_| ())
}

/// Pump every project that has a task store.
async fn sweep(app: &AppHandle) {
    for project_id in store::projects_with_tasks() {
        let Some(project_path) = crate::projects::project_path_for_registered_id(&project_id)
        else {
            // The project was removed from the registry; its tasks stay on
            // disk so re-adding the folder brings the board back.
            continue;
        };
        pump(app.clone(), project_id, project_path).await;
    }
}

/// Launch queued tasks until the project's concurrency ceiling is reached.
pub(crate) async fn pump(app: AppHandle, project_id: String, project_path: PathBuf) {
    let mut slots = MAX_CONCURRENT_PER_PROJECT.saturating_sub(store::in_flight_count(&project_id));
    if slots == 0 {
        return;
    }
    for task in store::queued(&project_id) {
        if slots == 0 {
            break;
        }
        // Claiming moves the task out of `queued` under the store lock, so a
        // second pump racing this one finds nothing to claim rather than
        // launching the same task twice.
        let Ok(claimed) = claim(&project_id, &task.id) else {
            continue;
        };
        slots -= 1;
        spawn_run(
            app.clone(),
            project_id.clone(),
            project_path.clone(),
            claimed,
        );
    }
}

/// Move a task from `queued` to `preparing` and claim a new generation.
fn claim(project_id: &str, task_id: &str) -> Result<WorkTask, String> {
    store::update(project_id, task_id, |task| {
        if task.status != WorkTaskStatus::Queued {
            return Err(format!(
                "work task is {} rather than queued",
                task.status.as_str()
            ));
        }
        task.status = WorkTaskStatus::Preparing;
        task.run_seq = task.run_seq.saturating_add(1);
        task.last_error = None;
        Ok(())
    })
}

fn spawn_run(app: AppHandle, project_id: String, project_path: PathBuf, task: WorkTask) {
    tauri::async_runtime::spawn(async move {
        let task_id = task.id.clone();
        let run_seq = task.run_seq;
        let outcome = run(&app, &project_id, &project_path, task).await;
        settle(&app, &project_id, &task_id, run_seq, outcome);
        clear_cancel(&task_id);
        release_cancelled_worktree(&project_id, &project_path, &task_id);
        emit_changed(&app, &project_id);
        // The slot this run held is free now, so whatever was waiting behind it
        // starts immediately instead of at the next sweep up to a tick away.
        pump(app.clone(), project_id.clone(), project_path).await;
    });
}

/// Tear down the checkout of a task that ended up cancelled.
///
/// Done here rather than in `cancel`, because at the moment the user clicks
/// Stop the turn is still running inside that very directory — removing it
/// underneath a live turn would break it in a far less legible way than letting
/// the turn wind down first.
///
/// Reads the task back rather than trusting the outcome: a cancel that arrived
/// after a turn had already succeeded is discarded by the generation guard, so
/// the run reports success while the card is `canceled`. Both paths leave a
/// worktree nothing references.
fn release_cancelled_worktree(project_id: &str, project_path: &Path, task_id: &str) {
    let Some(task) = store::get(project_id, task_id) else {
        return;
    };
    if task.status != WorkTaskStatus::Canceled {
        return;
    }
    discard_worktree(project_path, &task);
    let _ = store::update(project_id, task_id, |task| {
        task.worktree = None;
        Ok(())
    });
}

/// What one launch produced.
enum RunOutcome {
    /// The turn finished; the work is committed and ready to review.
    Review {
        summary: String,
        changes: super::model::WorkTaskChanges,
    },
    Failed(String),
    /// The user cancelled while the turn was in flight.
    Cancelled,
}

async fn run(app: &AppHandle, project_id: &str, project_path: &Path, task: WorkTask) -> RunOutcome {
    let run_seq = task.run_seq;
    let cancel = register_cancel(&task.id);

    // ── Prepare: the isolated checkout ──────────────────────────────────────
    let tree = match worktree::create(project_path, project_id, &task.id) {
        Ok(tree) => tree,
        Err(error) => return RunOutcome::Failed(error),
    };
    let session_id = format!("work-task-{}-{}", task.id, run_seq);
    if store::update(project_id, &task.id, |current| {
        if current.run_seq != run_seq {
            return Err("superseded".to_string());
        }
        current.worktree = Some(tree.clone());
        current.session_id = Some(session_id.clone());
        current.status = WorkTaskStatus::Running;
        Ok(())
    })
    .is_err()
    {
        return RunOutcome::Cancelled;
    }
    // Creating the worktree is the slow part of preparing, and Stop is offered
    // throughout it. Checked before the turn starts so a cancel during setup
    // does not still spend a full model turn.
    if cancel.load(Ordering::SeqCst) {
        return RunOutcome::Cancelled;
    }
    emit_changed(app, project_id);

    // ── Run: one unattended turn inside the worktree ────────────────────────
    let turn = crate::engine::run_work_task_turn(
        app.clone(),
        session_id,
        project_id.to_string(),
        PathBuf::from(&tree.path),
        task_prompt(&task, &tree.branch),
        task.model.clone(),
        cancel.clone(),
    )
    .await;
    if cancel.load(Ordering::SeqCst) {
        return RunOutcome::Cancelled;
    }
    let summary = match turn {
        Ok(summary) => summary,
        Err(error) => return RunOutcome::Failed(error),
    };

    // ── Settle: commit whatever it produced, and measure it ─────────────────
    let tree_path = PathBuf::from(&tree.path);
    let message = format!("{}\n\nRan as SomniQ work task {}.", task.title, task.id);
    if let Err(error) = worktree::commit_all(&tree_path, &message, &tree.base_sha) {
        return RunOutcome::Failed(error);
    }
    match worktree::changes_against_base(&tree_path, &tree.base_sha) {
        Ok(changes) => RunOutcome::Review { summary, changes },
        Err(error) => RunOutcome::Failed(error),
    }
}

/// The instruction the task's turn receives.
///
/// States the isolation explicitly. Without it the model reasons about the
/// user's repository — proposing that they review a branch, or declining to
/// edit files it thinks are live — when in fact it is alone in a scratch
/// checkout and is expected to just do the work.
fn task_prompt(task: &WorkTask, branch: &str) -> String {
    let mut prompt = String::new();
    if !task.title.trim().is_empty() {
        prompt.push_str(&format!("# {}\n\n", task.title.trim()));
    }
    if !task.prompt.trim().is_empty() {
        prompt.push_str(task.prompt.trim());
        prompt.push_str("\n\n");
    }
    prompt.push_str(&format!(
        "---\n\nYou are running as an unattended work task in an isolated Git worktree on branch \
         `{branch}`. Nobody is watching, so do not ask questions or wait for confirmation — make \
         the call and carry on, noting any assumption you had to make. Edit files directly; your \
         changes are committed to this branch automatically when you finish and are reviewed as a \
         diff before anything reaches the user's own checkout. Do not commit, push, or switch \
         branches yourself. Finish with a short summary of what you changed and anything you \
         deliberately left undone."
    ));
    prompt
}

/// Write the outcome, but only if this generation still owns the task.
fn settle(app: &AppHandle, project_id: &str, task_id: &str, run_seq: u32, outcome: RunOutcome) {
    let result = store::update(project_id, task_id, |task| {
        // The guard the whole design rests on: a cancel bumped `run_seq`, so
        // this settle belongs to a generation that no longer exists and must
        // write nothing.
        if task.run_seq != run_seq {
            return Err("superseded by a newer run".to_string());
        }
        match &outcome {
            RunOutcome::Review { summary, changes } => {
                task.status = WorkTaskStatus::Review;
                task.result_summary = Some(summary.clone());
                task.changes = Some(changes.clone());
                task.last_error = None;
            }
            RunOutcome::Failed(error) => {
                task.status = WorkTaskStatus::Failed;
                task.last_error = Some(error.clone());
            }
            RunOutcome::Cancelled => {
                task.status = WorkTaskStatus::Canceled;
            }
        }
        Ok(())
    });
    if result.is_ok() {
        emit_changed(app, project_id);
    }
}

/// Serializes merges per project.
///
/// Two accepted tasks land on the same base branch, and the second stage of the
/// merge is a fast-forward that is only guaranteed to be one while nothing else
/// moves the branch underneath it. With the concurrency ceiling at two, a user
/// accepting both cards in quick succession is an ordinary thing to do — so the
/// second waits rather than racing.
type MergeLocks = Mutex<HashMap<String, Arc<Mutex<()>>>>;

/// Run `work` holding the project's merge lock.
///
/// A closure rather than a returned guard: the guard borrows from an `Arc` that
/// would have to be owned by the same value, which is not expressible without a
/// self-referential struct.
fn with_merge_lock<T>(project_id: &str, work: impl FnOnce() -> T) -> T {
    static LOCKS: OnceLock<MergeLocks> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock = locks
        .lock()
        .map(|mut locks| {
            locks
                .entry(project_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        })
        .unwrap_or_else(|error| {
            error
                .into_inner()
                .entry(project_id.to_string())
                .or_default()
                .clone()
        });
    // A poisoned lock means an earlier merge panicked. The next one still has
    // to be allowed to run — Git is the authority on what landed, not this
    // mutex, and refusing forever would strand every remaining card.
    let _guard = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    work()
}

/// Accept a reviewed task: land its branch on the base and tidy up.
pub(crate) fn accept(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<WorkTask, String> {
    with_merge_lock(project_id, || {
        accept_locked(project_id, project_path, task_id)
    })
}

fn accept_locked(project_id: &str, project_path: &Path, task_id: &str) -> Result<WorkTask, String> {
    // Re-read under the lock: a merge that waited behind another one may find
    // the world different from when the click happened.
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    if task.status != WorkTaskStatus::Review {
        return Err(format!(
            "only a task in review can be accepted; this one is {}",
            task.status.as_str()
        ));
    }
    // Older versions removed all of `.somniq/` from the automatic task
    // commit, including canonical papers and other deliverables. Repair that
    // invariant before accepting so an existing review card cannot silently
    // discard its real output as "nothing to merge".
    let task = snapshot_review_task(project_id, task)?;
    let tree = task
        .worktree
        .clone()
        .ok_or_else(|| "this task has no worktree to merge".to_string())?;

    // The intent is written BEFORE any Git command runs, so an interrupted
    // merge leaves enough for `recover_merge` to ask Git what happened. A
    // `merging` row cannot be cancelled by the user, so without this it would
    // have no way out at all.
    let base_head = worktree::resolve(project_path, &tree.base_branch)
        .unwrap_or_else(|_| tree.base_sha.clone());
    store::update(project_id, task_id, |task| {
        task.status = WorkTaskStatus::Merging;
        task.merge_intent = Some(WorkTaskMergeIntent {
            branch: tree.branch.clone(),
            base_branch: tree.base_branch.clone(),
            base_head: base_head.clone(),
            started_at: store::now_ms(),
        });
        Ok(())
    })?;

    let outcome = worktree::merge_into_base(project_path, &tree);
    match outcome {
        Ok(result) => {
            let commit = match result {
                worktree::MergeOutcome::Merged { commit } => Some(commit),
                worktree::MergeOutcome::NothingToMerge => None,
            };
            // The branch is kept when work landed: it is the only handle on
            // the pre-merge history.
            let keep_branch = commit.is_some();
            let _ = worktree::discard(project_path, &tree, keep_branch);
            store::update(project_id, task_id, |task| {
                task.status = WorkTaskStatus::Done;
                task.merge_commit = commit.clone();
                task.merge_intent = None;
                task.last_error = None;
                Ok(())
            })
        }
        Err(error) => {
            // Back to review, not to failed: the work is intact, the merge is
            // what did not happen, and the user is the one who can resolve it.
            store::update(project_id, task_id, |task| {
                task.status = WorkTaskStatus::Review;
                task.merge_intent = None;
                task.last_error = Some(error.clone());
                Ok(())
            })?;
            Err(error)
        }
    }
}

/// Ensure a review card's branch contains every reviewable file currently in
/// its managed worktree, then refresh the summary stored on the card.
///
/// Normally settle already did this. Repeating it is intentionally idempotent
/// and recovers cards produced by versions that excluded generated artifacts
/// beneath `.somniq/` from their task commit.
fn snapshot_review_task(project_id: &str, task: WorkTask) -> Result<WorkTask, String> {
    if task.status != WorkTaskStatus::Review {
        return Ok(task);
    }
    let Some(tree) = task.worktree.as_ref() else {
        return Ok(task);
    };
    let path = PathBuf::from(&tree.path);
    if !path.is_dir() {
        return Err(format!(
            "the task's worktree is gone from disk ({}), so its diff cannot be read",
            tree.path
        ));
    }
    let message = format!(
        "{}\n\nRecovered artifacts from SomniQ work task {}.",
        task.title, task.id
    );
    worktree::commit_all(&path, &message, &tree.base_sha)?;
    let changes = worktree::changes_against_base(&path, &tree.base_sha)?;
    if task.changes.as_ref() == Some(&changes) {
        return Ok(task);
    }
    let run_seq = task.run_seq;
    store::update(project_id, &task.id, |current| {
        if current.status != WorkTaskStatus::Review || current.run_seq != run_seq {
            return Err("the task changed while its review snapshot was refreshed".to_string());
        }
        current.changes = Some(changes.clone());
        Ok(())
    })
}

/// The patch a reviewer reads.
pub(crate) fn diff(project_id: &str, task_id: &str) -> Result<String, String> {
    with_merge_lock(project_id, || diff_locked(project_id, task_id))
}

fn diff_locked(project_id: &str, task_id: &str) -> Result<String, String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    let task = snapshot_review_task(project_id, task)?;
    let Some(tree) = task.worktree else {
        return Ok(String::new());
    };
    let path = PathBuf::from(&tree.path);
    if !path.is_dir() {
        return Err(format!(
            "the task's worktree is gone from disk ({}), so its diff cannot be read",
            tree.path
        ));
    }
    worktree::diff_against_base(&path, &tree.base_sha, MAX_DIFF_CHARS)
}

/// Drop a task's isolation without touching the board row.
pub(crate) fn discard_worktree(project_path: &Path, task: &WorkTask) {
    if let Some(tree) = task.worktree.as_ref() {
        let _ = worktree::discard(project_path, tree, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prompt is the only thing standing between an unattended run and a
    /// model that asks a question nobody will answer, or that refuses to edit
    /// files it believes are the user's live checkout.
    #[test]
    fn the_task_prompt_states_the_isolation_and_forbids_waiting() {
        let task = WorkTask::new(
            "t1".into(),
            "Rewrite section 3".into(),
            "Tighten the argument.".into(),
            0,
        );
        let prompt = task_prompt(&task, "somniq/task/t1");

        assert!(prompt.contains("Rewrite section 3"));
        assert!(prompt.contains("Tighten the argument."));
        assert!(prompt.contains("somniq/task/t1"));
        // Unattended: must not wait for a human.
        assert!(prompt.contains("do not ask questions"));
        // Isolated: must be willing to edit.
        assert!(prompt.contains("Edit files directly"));
        // The engine owns committing; a model that commits itself would break
        // the base_sha..HEAD diff the review reads.
        assert!(prompt.contains("Do not commit"));
    }

    /// A task with no prompt body still gets a usable instruction — the board
    /// allows a title-only card.
    #[test]
    fn a_title_only_task_still_produces_an_instruction() {
        let task = WorkTask::new("t2".into(), "Fix the build".into(), String::new(), 0);
        let prompt = task_prompt(&task, "somniq/task/t2");
        assert!(prompt.contains("Fix the build"));
        assert!(prompt.contains("unattended work task"));
        assert!(
            !prompt.contains("\n\n\n\n"),
            "blank-run in prompt: {prompt}"
        );
    }

    /// Cancelling a task nothing is running is a no-op, not a panic — the board
    /// can offer cancel on a card whose turn just finished.
    #[test]
    fn cancelling_an_unregistered_task_reports_that_nothing_listened() {
        assert!(!signal_cancel("no-such-task"));
    }

    #[test]
    fn a_registered_cancel_is_observed_and_then_cleared() {
        let flag = register_cancel("cancel-me");
        assert!(!flag.load(Ordering::SeqCst));
        assert!(signal_cancel("cancel-me"));
        assert!(flag.load(Ordering::SeqCst));
        clear_cancel("cancel-me");
        assert!(!signal_cancel("cancel-me"));
    }
}

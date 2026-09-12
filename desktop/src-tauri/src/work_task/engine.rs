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

use super::model::{
    WorkTask, WorkTaskArtifact, WorkTaskEmptyReason, WorkTaskMergeIntent, WorkTaskPendingAction,
    WorkTaskReviewSnapshot, WorkTaskStatus, WorkTaskStopReason,
};
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
/// Internal hand-off from Chat: the turn ended intentionally on a persisted
/// question rather than failing.
pub(crate) const AWAITING_INPUT_OUTCOME: &str = "work task is awaiting input";

static RUNNER_STARTED: OnceLock<()> = OnceLock::new();

/// A stop request against one in-flight run.
///
/// The flag is what the turn polls; the reason is what the settle reads. They
/// are separate because the flag has to be an `AtomicBool` — that is the shape
/// the Chat runtime takes for cancellation — while the reason decides something
/// the runtime knows nothing about: whether the checkout survives.
#[derive(Clone)]
struct StopHandle {
    flag: Arc<AtomicBool>,
    reason: Arc<Mutex<Option<WorkTaskStopReason>>>,
}

impl StopHandle {
    fn reason(&self) -> Option<WorkTaskStopReason> {
        self.reason.lock().ok().and_then(|reason| *reason)
    }

    fn requested(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Stop handles for tasks currently in flight, keyed by task id.
///
/// A stop flips the flag so the running turn halts at its next checkpoint,
/// *and* bumps the task's `run_seq` so the turn's eventual settle is discarded.
/// Both are needed: the flag stops the work, the generation stops the write.
type StopRegistry = Mutex<HashMap<String, StopHandle>>;

fn stops() -> &'static StopRegistry {
    static STOPS: OnceLock<StopRegistry> = OnceLock::new();
    STOPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_stop(task_id: &str) -> StopHandle {
    let handle = StopHandle {
        flag: Arc::new(AtomicBool::new(false)),
        reason: Arc::new(Mutex::new(None)),
    };
    if let Ok(mut registry) = stops().lock() {
        registry.insert(task_id.to_string(), handle.clone());
    }
    handle
}

fn clear_stop(task_id: &str) {
    if let Ok(mut registry) = stops().lock() {
        registry.remove(task_id);
    }
}

/// Signal a running task to stop, recording why. Returns whether anything was
/// listening — the caller needs to know, because a stop nothing heard means no
/// later pass will come back to tidy up and it has to do so itself.
///
/// The first reason wins. A cancel that lands on a task already pausing must
/// not be downgraded, and a pause arriving after a cancel must not resurrect
/// a checkout the cancel is about to throw away.
pub(crate) fn signal_stop(task_id: &str, reason: WorkTaskStopReason) -> bool {
    let Ok(registry) = stops().lock() else {
        return false;
    };
    let Some(handle) = registry.get(task_id) else {
        return false;
    };
    if let Ok(mut recorded) = handle.reason.lock() {
        match *recorded {
            // A cancel supersedes a pause: the user asked for the stronger
            // outcome and the weaker one would keep work they asked to drop.
            Some(WorkTaskStopReason::Pause) if reason == WorkTaskStopReason::Cancel => {
                *recorded = Some(reason);
            }
            Some(_) => {}
            None => *recorded = Some(reason),
        }
    }
    handle.flag.store(true, Ordering::SeqCst);
    true
}

/// Tell the board something changed. Best-effort: a dropped notification costs
/// a stale card until the next poll, and must never fail a state transition
/// that already committed to disk.
///
/// Carries the store revision the change produced. The board discards events at
/// or below the revision it already holds, which is what lets it subscribe
/// first and load second without a race: an event that arrives during the load
/// describes state the load already contains.
pub(crate) fn emit_changed(app: &AppHandle, project_id: &str) {
    let _ = app.emit(
        "work-task-changed",
        serde_json::json!({
            "projectId": project_id,
            "revision": store::current_revision(project_id),
        }),
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
/// `preparing`, `running` and `pausing` all describe a turn that is gone, so
/// they become `interrupted` rather than sitting there forever
/// — a card in any of those states cannot be edited or deleted, so leaving it
/// would strand it permanently. `interrupted` rather than `failed` because
/// nothing went wrong with the work: the checkout is intact and resuming
/// continues it.
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
            WorkTaskStatus::Preparing
            | WorkTaskStatus::Running
            | WorkTaskStatus::Pausing
            | WorkTaskStatus::Reviewing
            | WorkTaskStatus::Revising => {
                let interrupted = store::update(project_id, &task.id, |task| {
                    task.status = WorkTaskStatus::Interrupted;
                    task.last_error = Some(
                        "SomniQ closed while this task was running, so the run stopped part-way. Its checkout and transcript are intact — resume it to carry on."
                            .to_string(),
                    );
                    // The question, the phase and the heartbeat all describe a
                    // process that no longer exists. Leaving the question in
                    // place would offer an answer box routed at a tool call
                    // nothing is waiting on.
                    task.clear_run_state();
                    task.stop_reason = Some(WorkTaskStopReason::Shutdown);
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
    register_stop(task_id).flag
}

#[cfg(test)]
pub(crate) fn current_revision_for_test(project_id: &str) -> u64 {
    store::current_revision(project_id)
}

#[cfg(test)]
pub(crate) fn release_cancelled_worktree_for_test(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) {
    clear_stop(task_id);
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
        clear_stop(&task_id);
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
    // A pause or a shutdown reaches `settle` through the same handshake and
    // must keep its checkout — that is the whole difference between them and a
    // cancel, and it is what a later resume continues into.
    if task
        .stop_reason
        .is_some_and(super::model::WorkTaskStopReason::preserves_worktree)
    {
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
        snapshot: WorkTaskReviewSnapshot,
        /// What the independent Reviewer concluded. `None` only when review is
        /// switched off in settings — otherwise even a Reviewer that could not
        /// run leaves an `Unavailable` verdict, so "nobody checked this" is
        /// never indistinguishable from "this passed".
        review: Option<super::model::WorkTaskReviewState>,
    },
    Failed(String),
    /// The turn deliberately ended after persisting a question. No execution
    /// remains alive; the answer will queue the next turn.
    AwaitingInput,
    /// The run was stopped before it finished. The reason decides everything
    /// that happens next — chiefly whether the checkout is kept.
    Stopped(WorkTaskStopReason),
}

/// How often a run stamps `last_heartbeat_at` while a turn is in flight.
///
/// A heartbeat is a whole-file atomic write plus a board event, so the cadence
/// is set by what a person watching a card needs rather than by how often the
/// turn does something: slow enough to be free, fast enough that "no heartbeat
/// for a while" means something.
const HEARTBEAT_SECS: u64 = 5;

/// Record the phase a run has reached, for the card to show.
///
/// Guarded on the generation like every other write from a run: a phase update
/// from a superseded run would relabel the card that replaced it.
fn set_phase(app: &AppHandle, project_id: &str, task_id: &str, run_seq: u32, phase: &str) {
    let updated = store::update(project_id, task_id, |task| {
        if task.run_seq != run_seq {
            return Err("superseded".to_string());
        }
        task.progress_message = Some(phase.to_string());
        task.last_heartbeat_at = Some(store::now_ms());
        Ok(())
    });
    if updated.is_ok() {
        emit_changed(app, project_id);
    }
}

/// Keep stamping `last_heartbeat_at` until the returned guard is dropped.
///
/// The board cannot otherwise tell a turn that is thinking from a run whose
/// process is gone; both look like a row that says `running` and never changes.
/// Stops on its own as soon as the generation moves, so a task the user
/// cancelled cannot keep reporting a pulse.
fn start_heartbeat(
    app: &AppHandle,
    project_id: &str,
    task_id: &str,
    run_seq: u32,
) -> Arc<AtomicBool> {
    let alive = Arc::new(AtomicBool::new(true));
    let stop = alive.clone();
    let app = app.clone();
    let project_id = project_id.to_string();
    let task_id = task_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
        ticker.tick().await;
        while stop.load(Ordering::SeqCst) {
            ticker.tick().await;
            if !stop.load(Ordering::SeqCst) {
                break;
            }
            let beat = store::update(&project_id, &task_id, |task| {
                if task.run_seq != run_seq || !task.status.holds_a_slot() {
                    return Err("no longer running".to_string());
                }
                task.last_heartbeat_at = Some(store::now_ms());
                Ok(())
            });
            if beat.is_err() {
                break;
            }
            // The board has to be told, or the pulse it renders is whatever it
            // last happened to read — which would show a healthy run as stale
            // for as long as nothing else changed.
            emit_changed(&app, &project_id);
        }
    });
    alive
}

/// The checkout a run works in: the one the task already has, or a new one.
///
/// Resuming into the existing directory is the whole point of `paused` and
/// `interrupted` — `worktree::create` deletes any leftover checkout and branch
/// for the task id, so calling it on a resume would silently destroy exactly
/// the work the user asked to continue.
fn checkout_for_run(
    project_path: &Path,
    project_id: &str,
    task: &WorkTask,
) -> Result<(super::model::WorkTaskWorktree, bool), String> {
    if let Some(tree) = task.worktree.as_ref() {
        if task.resume_context.is_some() && Path::new(&tree.path).is_dir() {
            return Ok((tree.clone(), true));
        }
    }
    worktree::create(project_path, project_id, &task.id).map(|tree| (tree, false))
}

async fn run(app: &AppHandle, project_id: &str, project_path: &Path, task: WorkTask) -> RunOutcome {
    let run_seq = task.run_seq;
    let stop = register_stop(&task.id);

    // ── Prepare: the isolated checkout ──────────────────────────────────────
    set_phase(
        app,
        project_id,
        &task.id,
        run_seq,
        "Preparing the isolated checkout",
    );
    let (tree, resumed) = match checkout_for_run(project_path, project_id, &task) {
        Ok(prepared) => prepared,
        Err(error) => return RunOutcome::Failed(error),
    };
    // A resume continues the same conversation, so the turn sees everything the
    // interrupted one had already worked out rather than re-deriving it.
    let session_id = match task.session_id.clone() {
        Some(existing) if resumed => existing,
        _ => format!("work-task-{}-{}", task.id, run_seq),
    };
    if store::update(project_id, &task.id, |current| {
        if current.run_seq != run_seq {
            return Err("superseded".to_string());
        }
        current.worktree = Some(tree.clone());
        current.session_id = Some(session_id.clone());
        current.status = WorkTaskStatus::Running;
        current.progress_message = Some("Running the model turn".to_string());
        current.last_heartbeat_at = Some(store::now_ms());
        current.pending_action = None;
        // The claimed task clone below still carries this one-shot prompt; the
        // persisted row must not replay it after another restart.
        current.resume_context = None;
        current.stop_reason = None;
        Ok(())
    })
    .is_err()
    {
        return RunOutcome::Stopped(WorkTaskStopReason::Cancel);
    }
    // Creating the worktree is the slow part of preparing, and Stop is offered
    // throughout it. Checked before the turn starts so a stop during setup does
    // not still spend a full model turn.
    if stop.requested() {
        return RunOutcome::Stopped(stop.reason().unwrap_or(WorkTaskStopReason::Cancel));
    }
    emit_changed(app, project_id);

    // ── Run: one unattended turn inside the worktree ────────────────────────
    let heartbeat = start_heartbeat(app, project_id, &task.id, run_seq);
    let turn = crate::engine::run_work_task_turn(
        app.clone(),
        session_id.clone(),
        project_id.to_string(),
        PathBuf::from(&tree.path),
        crate::engine::WorkTaskTurnBinding {
            task_id: task.id.clone(),
            run_seq,
        },
        if resumed {
            resume_prompt(&task, &tree.branch)
        } else {
            task_prompt(&task, &tree.branch)
        },
        task.model.clone(),
        stop.flag.clone(),
    )
    .await;
    heartbeat.store(false, Ordering::SeqCst);
    if stop.requested() {
        return RunOutcome::Stopped(stop.reason().unwrap_or(WorkTaskStopReason::Cancel));
    }
    let summary = match turn {
        Ok(summary) => summary,
        Err(error) if error == AWAITING_INPUT_OUTCOME => return RunOutcome::AwaitingInput,
        Err(error) => return RunOutcome::Failed(error),
    };

    // ── Settle: commit whatever it produced, and measure it ─────────────────
    set_phase(
        app,
        project_id,
        &task.id,
        run_seq,
        "Committing the result for review",
    );
    let tree_path = PathBuf::from(&tree.path);
    let message = format!("{}\n\nRan as SomniQ work task {}.", task.title, task.id);
    if let Err(error) = worktree::commit_all(&tree_path, &message, &tree.base_sha) {
        return RunOutcome::Failed(error);
    }
    // Deliverables move into SomniQ's store BEFORE the task is reportable, so
    // a failed import fails the run and keeps the worktree. Reporting success
    // and then losing the checkout would destroy the one copy of a result the
    // user asked for.
    set_phase(
        app,
        project_id,
        &task.id,
        run_seq,
        "Saving the task's deliverables",
    );
    let artifacts = match super::artifacts::import(project_id, &task.id, &tree_path) {
        Ok(artifacts) => artifacts,
        Err(error) => return RunOutcome::Failed(error),
    };
    let snapshot = match capture_snapshot_with_artifacts(&tree_path, &tree.base_sha, artifacts) {
        Ok(snapshot) => snapshot,
        Err(error) => return RunOutcome::Failed(error),
    };

    // ── Review: an independent pass over what was actually committed ────────
    review_and_revise(
        app,
        project_id,
        &task,
        &tree,
        run_seq,
        &stop,
        &session_id,
        summary,
        snapshot,
    )
    .await
}

/// How many times the executor may be sent back before the user is asked.
///
/// Two is the same ceiling Chat's in-turn review uses. A higher number does
/// not buy better results so much as a longer wait for a verdict that was
/// going to be "you look at it" anyway.
const MAX_REVIEW_ROUNDS: u32 = 2;

/// Cap on the patch text handed to the Reviewer.
///
/// Much smaller than the review panel's cap: this one is spent from a model's
/// context window, and a reviewer that runs out of room part-way through is
/// worse than one told plainly that the diff was abridged.
const MAX_REVIEW_PROMPT_PATCH_CHARS: usize = 60_000;

/// Check the committed result, and send it back for another round if the
/// Reviewer says so.
///
/// The rule this enforces: the executor's own closing summary is not a verdict.
/// Before PR 5 it was the only quality signal a card carried, so a task that
/// confidently announced success and had in fact produced nothing of the kind
/// reached the user looking identical to one that worked.
#[allow(clippy::too_many_arguments)]
async fn review_and_revise(
    app: &AppHandle,
    project_id: &str,
    task: &WorkTask,
    tree: &super::model::WorkTaskWorktree,
    run_seq: u32,
    stop: &StopHandle,
    // Passed in rather than re-derived from `task`. A task restarted after a
    // cancel still carries the *previous* attempt's `session_id` while the run
    // itself has minted a fresh one, so deriving it here would put the
    // revision turn in the old conversation — replaying a discarded attempt's
    // context into the run that replaced it.
    session_id: &str,
    mut summary: String,
    mut snapshot: WorkTaskReviewSnapshot,
) -> RunOutcome {
    if !crate::config::review_enabled() {
        return RunOutcome::Review {
            summary,
            snapshot,
            review: None,
        };
    }
    let tree_path = PathBuf::from(&tree.path);

    let mut round = 1u32;
    loop {
        if stop.requested() {
            return RunOutcome::Stopped(stop.reason().unwrap_or(WorkTaskStopReason::Cancel));
        }
        set_status_and_phase(
            app,
            project_id,
            &task.id,
            run_seq,
            WorkTaskStatus::Reviewing,
            &format!("Independent review, round {round}"),
        );

        let prompt = reviewer_prompt(task, &snapshot, &summary, &tree_path);
        let flag = stop.flag.clone();
        let model = task.model.clone();
        let review_session = session_id.to_string();
        let checked = crate::blocking::off_main_thread(move || {
            Ok(crate::engine::run_work_task_review(
                &review_session,
                round as usize,
                prompt,
                flag,
                model.as_deref(),
            ))
        })
        .await;
        let Ok(mut review) = checked else {
            // The reviewer could not be run at all. Not a reason to fail the
            // task — the work exists — but it must be recorded as unchecked
            // rather than silently presented as reviewed.
            return RunOutcome::Review {
                summary,
                snapshot,
                review: Some(unavailable_review(round, "the Reviewer could not be started")),
            };
        };
        review.max_rounds = MAX_REVIEW_ROUNDS;
        if stop.requested() {
            return RunOutcome::Stopped(stop.reason().unwrap_or(WorkTaskStopReason::Cancel));
        }
        if !review.verdict.wants_revision() {
            return RunOutcome::Review {
                summary,
                snapshot,
                review: Some(review),
            };
        }
        if round >= MAX_REVIEW_ROUNDS {
            // Out of rounds with issues outstanding. The user gets the result
            // *and* the list of what is still wrong — which is more useful
            // than either hiding it or failing the task outright.
            review.exhausted = true;
            return RunOutcome::Review {
                summary,
                snapshot,
                review: Some(review),
            };
        }

        // ── Revise: same checkout, same conversation ────────────────────────
        set_status_and_phase(
            app,
            project_id,
            &task.id,
            run_seq,
            WorkTaskStatus::Revising,
            &format!("Addressing review round {round}"),
        );
        let heartbeat = start_heartbeat(app, project_id, &task.id, run_seq);
        let turn = crate::engine::run_work_task_turn(
            app.clone(),
            session_id.to_string(),
            project_id.to_string(),
            tree_path.clone(),
            crate::engine::WorkTaskTurnBinding {
                task_id: task.id.clone(),
                run_seq,
            },
            revision_prompt(&review),
            task.model.clone(),
            stop.flag.clone(),
        )
        .await;
        heartbeat.store(false, Ordering::SeqCst);
        if stop.requested() {
            return RunOutcome::Stopped(stop.reason().unwrap_or(WorkTaskStopReason::Cancel));
        }
        match turn {
            Ok(text) => summary = text,
            Err(error) if error == AWAITING_INPUT_OUTCOME => {
                return RunOutcome::AwaitingInput;
            }
            Err(error) => {
                // The revision failed, but the previous round's work is still
                // committed. Hand over what there is, with the reason.
                review.summary = format!(
                    "{}\n\nThe revision round failed before it finished: {error}",
                    review.summary
                );
                return RunOutcome::Review {
                    summary,
                    snapshot,
                    review: Some(review),
                };
            }
        }

        let message = format!(
            "{}\n\nReview round {round} for SomniQ work task {}.",
            task.title, task.id
        );
        if let Err(error) = worktree::commit_all(&tree_path, &message, &tree.base_sha) {
            return RunOutcome::Failed(error);
        }
        let artifacts =
            match super::artifacts::import(project_id, &task.id, &tree_path) {
                Ok(artifacts) => carry_forward_exports(artifacts, &snapshot.artifacts),
                Err(error) => return RunOutcome::Failed(error),
            };
        snapshot = match capture_snapshot_with_artifacts(&tree_path, &tree.base_sha, artifacts) {
            Ok(snapshot) => snapshot,
            Err(error) => return RunOutcome::Failed(error),
        };
        round += 1;
    }
}

fn unavailable_review(round: u32, reason: &str) -> super::model::WorkTaskReviewState {
    super::model::WorkTaskReviewState {
        round,
        max_rounds: MAX_REVIEW_ROUNDS,
        verdict: super::model::WorkTaskVerdict::Unavailable,
        summary: reason.to_string(),
        issues: Vec::new(),
        reviewer_model: String::new(),
        exhausted: false,
        checked_at: store::now_ms(),
    }
}

/// Move a task to a new engine-owned status, guarded on the generation.
fn set_status_and_phase(
    app: &AppHandle,
    project_id: &str,
    task_id: &str,
    run_seq: u32,
    status: WorkTaskStatus,
    phase: &str,
) {
    let updated = store::update(project_id, task_id, |task| {
        if task.run_seq != run_seq {
            return Err("superseded".to_string());
        }
        task.status = status;
        task.progress_message = Some(phase.to_string());
        task.last_heartbeat_at = Some(store::now_ms());
        Ok(())
    });
    if updated.is_ok() {
        emit_changed(app, project_id);
    }
}

/// What the Reviewer is shown.
///
/// The committed result, not the conversation that produced it: the file list,
/// the patch, the deliverables, and the executor's claim about them. The claim
/// is included precisely so the Reviewer can check it against the evidence,
/// which is the one thing a self-assessment cannot do.
fn reviewer_prompt(
    task: &WorkTask,
    snapshot: &WorkTaskReviewSnapshot,
    summary: &str,
    tree_path: &Path,
) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "You are the independent Reviewer for a background work task. The task has finished and \
         its work is committed. Judge the COMMITTED RESULT against what was asked — not the \
         executor's description of it.\n\n# The task\n\n",
    );
    prompt.push_str(&format!("## {}\n\n", task.title.trim()));
    if !task.prompt.trim().is_empty() {
        prompt.push_str(task.prompt.trim());
        prompt.push_str("\n\n");
    }

    prompt.push_str("# What was committed\n\n");
    if snapshot.files.is_empty() {
        prompt.push_str("No repository files were changed.\n\n");
    } else {
        for file in &snapshot.files {
            let counts = if file.binary {
                "binary".to_string()
            } else {
                format!("+{} -{}", file.additions.unwrap_or(0), file.deletions.unwrap_or(0))
            };
            prompt.push_str(&format!(
                "- {} {} ({counts})\n",
                file.change_kind.as_str(),
                file.path
            ));
        }
        prompt.push('\n');
    }
    if !snapshot.artifacts.is_empty() {
        prompt.push_str("Standalone deliverables produced (not committed; handed to the user):\n");
        for artifact in &snapshot.artifacts {
            prompt.push_str(&format!(
                "- {} ({} bytes)\n",
                artifact.relative_path, artifact.byte_size
            ));
        }
        prompt.push('\n');
    }

    match worktree::patch_between(
        tree_path,
        &snapshot.base_sha,
        &snapshot.head_sha,
        None,
        MAX_REVIEW_PROMPT_PATCH_CHARS,
    ) {
        Ok(patch) if !patch.trim().is_empty() => {
            prompt.push_str("# The diff\n\n```diff\n");
            prompt.push_str(&patch);
            prompt.push_str("\n```\n\n");
        }
        // Said explicitly rather than omitted: a Reviewer that simply does not
        // see a diff cannot tell "there was none" from "it was not shown", and
        // would be right to distrust either reading.
        Ok(_) => prompt.push_str("# The diff\n\nThere is no text diff to show.\n\n"),
        Err(error) => prompt.push_str(&format!(
            "# The diff\n\nThe diff could not be read ({error}), so judge from the file list \
             above and say if that is not enough.\n\n"
        )),
    }

    prompt.push_str("# What the executor claims it did\n\n");
    prompt.push_str(if summary.trim().is_empty() {
        "(it said nothing)"
    } else {
        summary.trim()
    });
    prompt.push_str("\n\n");
    prompt.push_str(REVIEWER_INSTRUCTIONS);
    prompt
}

const REVIEWER_INSTRUCTIONS: &str = "# Your job\n\n\
     Decide whether this result does what the task asked. Check the claim against the diff: a \
     summary that describes work the diff does not contain is the single most important thing to \
     catch. Judge only what is here — do not ask for work the task did not request, and do not \
     withhold a pass over style preferences.\n\n\
     Reply with a single JSON object and nothing else:\n\n\
     {\"verdict\": \"pass\" | \"revise\" | \"needs_user\", \"summary\": \"one or two sentences\", \
     \"issues\": [{\"severity\": \"high\" | \"medium\" | \"low\", \"title\": \"...\", \"detail\": \
     \"what is wrong and where\", \"recommendation\": \"what to do about it\"}], \
     \"revisionInstructions\": [\"concrete, ordered steps for the executor\"]}\n\n\
     Use `pass` when the result is sound, `revise` when the executor can fix it from your issues \
     alone, and `needs_user` when it is blocked on a decision or something outside the checkout. \
     `pass` takes an empty `issues` list.";

/// What the executor is told when it is sent back.
fn revision_prompt(review: &super::model::WorkTaskReviewState) -> String {
    let mut prompt = String::from(
        "An independent Reviewer checked the work you just committed and asked for changes. You \
         are still in the same isolated worktree, and everything you did is still here.\n\n",
    );
    if !review.summary.trim().is_empty() {
        prompt.push_str(&format!("Reviewer's summary: {}\n\n", review.summary.trim()));
    }
    if review.issues.is_empty() {
        prompt.push_str("No specific issues were listed, so re-read your own work against the \
                         task and fix what does not hold up.\n\n");
    } else {
        prompt.push_str("Issues raised:\n\n");
        for (index, issue) in review.issues.iter().enumerate() {
            prompt.push_str(&format!(
                "{}. [{}] {}\n   {}\n",
                index + 1,
                if issue.severity.trim().is_empty() {
                    "unrated"
                } else {
                    issue.severity.trim()
                },
                issue.title.trim(),
                issue.detail.trim(),
            ));
            if !issue.recommendation.trim().is_empty() {
                prompt.push_str(&format!("   Suggested: {}\n", issue.recommendation.trim()));
            }
        }
        prompt.push('\n');
    }
    prompt.push_str(
        "Address these directly. If you think the Reviewer is wrong about one, say so in your \
         summary with your reasoning rather than silently ignoring it — an unaddressed issue the \
         user is never told about is the worst outcome here. The same rules still apply: do not \
         commit, push, or switch branches. Finish with a short summary of what you changed in \
         response.",
    );
    prompt
}

/// Describe what is committed in `worktree`, pinned at the revisions it is
/// committed at.
///
/// The head sha is resolved here, once, rather than left as the name `HEAD`:
/// the whole point of the snapshot is that reopening a review shows the same
/// thing, and `HEAD` is a moving target the moment anything else touches the
/// checkout.
pub(crate) fn capture_snapshot(
    tree_path: &Path,
    base_sha: &str,
) -> Result<WorkTaskReviewSnapshot, String> {
    capture_snapshot_with_artifacts(tree_path, base_sha, Vec::new())
}

fn capture_snapshot_with_artifacts(
    tree_path: &Path,
    base_sha: &str,
    artifacts: Vec<WorkTaskArtifact>,
) -> Result<WorkTaskReviewSnapshot, String> {
    let head_sha = worktree::resolve(tree_path, "HEAD")?;
    let files = worktree::review_files(tree_path, base_sha, &head_sha)?;
    let empty_reason = if !files.is_empty() {
        None
    } else if artifacts.is_empty() {
        // A run that reached this point ran to completion and chose to change
        // nothing — an analysis, a search, a question answered in the
        // transcript. Not the same as a run that produced nothing, but from
        // here the two are indistinguishable, and the charitable reading is
        // the one that does not accuse a finished run of having done nothing.
        Some(WorkTaskEmptyReason::NoRepositoryChanges)
    } else {
        // It produced real output; it just does not belong in the repository.
        // Saying "no changes" here is what used to hide a finished report.
        Some(WorkTaskEmptyReason::ArtifactsOnly)
    };
    Ok(WorkTaskReviewSnapshot {
        base_sha: base_sha.to_string(),
        head_sha,
        files,
        artifacts,
        empty_reason,
        captured_at: store::now_ms(),
    })
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
         branches yourself.\n\n{OUTPUT_POLICY}\n\nFinish with a short summary of what you changed \
         and anything you deliberately left undone."
    ));
    prompt
}

/// Where a task is told to put each kind of output.
///
/// Without this the model has one place to write and everything becomes a
/// commit, which is how a generated report ended up being something the user
/// had to merge a branch to obtain.
const OUTPUT_POLICY: &str = "Two kinds of output, two destinations. Changes to the project's own \
     files — source, an existing paper, configuration, tests — go in their normal places and are \
     reviewed as a diff. A standalone deliverable that is not part of the project's files — a \
     report, a deck, an exported figure, anything the user asked you to produce rather than to \
     change — goes in `.somniq/task-output/`, which is never committed and is handed to the user \
     directly. If you are unsure, ask which of the two the request is and answer it yourself: \
     \"would this belong in the repository forever?\"";

/// The instruction a resumed run receives.
///
/// A resume runs in the *same* chat session, so the transcript of the stopped
/// attempt is already in context and repeating the original brief verbatim
/// would read as a second, separate request. What the turn does not know is the
/// only thing this has to say: that it was stopped, that its half-finished
/// edits are still on disk, and that it should look before it writes.
fn resume_prompt(task: &WorkTask, branch: &str) -> String {
    let fallback_reason = match task.status {
        WorkTaskStatus::Paused => "You were paused by the user part-way through this task.",
        WorkTaskStatus::Interrupted => {
            "SomniQ closed part-way through this task, so the previous turn was interrupted."
        }
        _ => "Your previous attempt at this task ended before it was finished.",
    };
    let reason = task.resume_context.as_deref().unwrap_or(fallback_reason);
    let mut prompt = format!(
        "# Resume: {title}\n\n{reason} Nothing was lost: you are back in the same isolated Git \
         worktree on branch `{branch}`, with every edit you had already made still on disk and \
         uncommitted.\n\n",
        title = task.title.trim(),
    );
    if let Some(error) = task.last_error.as_ref().filter(|value| {
        !value.trim().is_empty() && task.status == WorkTaskStatus::Failed
    }) {
        prompt.push_str(&format!(
            "The run ended with this error, which may or may not be the real problem:\n\n```text\n{}\n```\n\n",
            error.trim()
        ));
    }
    prompt.push_str(&format!(
        "Start by checking `git status` and reading the files you had been editing, so you \
         continue from the actual state on disk rather than from what you remember intending. \
         Then carry on to the end of the task. The same rules still apply: nobody is watching, so \
         make the call and note the assumption rather than waiting; do not commit, push, or switch \
         branches.\n\n{OUTPUT_POLICY}\n\nFinish with a short summary of what you changed and \
         anything you deliberately left undone."
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
        // Awaiting input already carries the persisted state written by the
        // question tool. Clearing it here would erase the question just as the
        // turn releases its slot.
        if matches!(&outcome, RunOutcome::AwaitingInput) {
            if task.status != WorkTaskStatus::AwaitingInput || task.pending_action.is_none() {
                return Err("the turn stopped for input without a persisted question".to_string());
            }
            task.progress_message = Some("Waiting for your answer".to_string());
            task.last_heartbeat_at = None;
            return Ok(());
        }
        // Whatever else the run was doing, it is not doing it any more.
        task.clear_run_state();
        match &outcome {
            RunOutcome::Review {
                summary,
                snapshot,
                review,
            } => {
                task.status = WorkTaskStatus::Review;
                task.result_summary = Some(summary.clone());
                task.changes = Some(snapshot.changes());
                task.review_snapshot = Some(snapshot.clone());
                task.review_state = review.clone();
                task.last_error = None;
            }
            RunOutcome::Failed(error) => {
                task.status = WorkTaskStatus::Failed;
                task.last_error = Some(error.clone());
            }
            RunOutcome::AwaitingInput => unreachable!("handled above"),
            RunOutcome::Stopped(reason) => {
                task.stop_reason = Some(*reason);
                task.status = match reason {
                    WorkTaskStopReason::Cancel => WorkTaskStatus::Canceled,
                    WorkTaskStopReason::Pause => WorkTaskStatus::Paused,
                    WorkTaskStopReason::Shutdown => WorkTaskStatus::Interrupted,
                };
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

    // An untracked local file at a path the task makes tracked would make the
    // final fast-forward fail with "would be overwritten by merge". Preserve
    // exactly those paths in Git first. Any disagreement then becomes a
    // normal conflict in the isolated task checkout and can be handed to the
    // merge Agent without deleting or hiding the user's local bytes.
    if let Err(error) = worktree::preserve_untracked_collisions(project_path, &tree, task_id) {
        store::update(project_id, task_id, |task| {
            task.last_error = Some(error.clone());
            Ok(())
        })?;
        return Err(error);
    }

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

/// Turn a merge conflict left by [`accept`] into an engine-owned Agent pass.
///
/// Only a real unresolved merge in the isolated checkout is eligible. Branch
/// switches, missing worktrees, and other project-level failures still return
/// to the user because an Agent confined to the task worktree cannot safely
/// repair them.
pub(crate) fn prepare_merge_repair(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
    merge_error: &str,
) -> Result<WorkTask, String> {
    with_merge_lock(project_id, || {
        prepare_merge_repair_locked(project_id, project_path, task_id, merge_error)
    })
}

fn merge_repair_prompt(task: &WorkTask, merge_error: &str) -> String {
    let tree = task.worktree.as_ref().expect("merge repair has a worktree");
    format!(
        "# Resolve the merge for: {title}\n\n\
         The user accepted this task, but Git could not integrate it automatically. You are the \
         merge Agent for the same task and are running inside its isolated worktree on branch \
         `{branch}`.\n\nGit reported:\n\n```text\n{merge_error}\n```\n\n\
         Inspect `git status` and every conflicted file. Resolve the merge semantically: preserve \
         the current base branch's valid data and the accepted task's intended changes. For JSON \
         or other structured project state, merge records by meaning rather than choosing one \
         whole side. Remove all conflict markers, validate the resulting files where practical, \
         and run `git add` for every resolved path. Do not commit, abort the merge, switch branches, \
         push, or modify the user's main checkout; SomniQ will commit and land the resolution after \
         your turn. Finish with a concise explanation of the resolution.",
        title = task.title,
        branch = tree.branch,
    )
}

enum MergeRepairCompletion {
    Done,
    NeedsAnotherPass { task: WorkTask, error: String },
    Stopped,
}

fn complete_merge_repair(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
    summary: &str,
) -> MergeRepairCompletion {
    with_merge_lock(project_id, || {
        let Some(task) = store::get(project_id, task_id) else {
            return MergeRepairCompletion::Stopped;
        };
        if task.status != WorkTaskStatus::Merging {
            return MergeRepairCompletion::Stopped;
        }
        let Some(tree) = task.worktree.clone() else {
            return MergeRepairCompletion::Stopped;
        };
        let message = format!(
            "Resolve merge for {}\n\nResolved by the SomniQ merge Agent for work task {}.",
            task.title, task.id
        );
        if let Err(error) = worktree::commit_all(Path::new(&tree.path), &message, &tree.base_sha) {
            let _ = back_to_review(
                project_id,
                task_id,
                &format!("The merge Agent could not finish the resolution: {error}"),
            );
            return MergeRepairCompletion::Stopped;
        }

        // Reuse the ordinary accept invariants. No event is emitted while the
        // lock is held, so the temporary Review state is never presented as a
        // user handoff.
        if store::update(project_id, task_id, |task| {
            task.status = WorkTaskStatus::Review;
            task.merge_intent = None;
            task.result_summary = Some(match task.result_summary.as_deref() {
                Some(original) if !original.trim().is_empty() => {
                    format!("{original}\n\nMerge Agent: {summary}")
                }
                _ => format!("Merge Agent: {summary}"),
            });
            Ok(())
        })
        .is_err()
        {
            return MergeRepairCompletion::Stopped;
        }
        match accept_locked(project_id, project_path, task_id) {
            Ok(_) => MergeRepairCompletion::Done,
            Err(error) => {
                match prepare_merge_repair_locked(project_id, project_path, task_id, &error) {
                    Ok(task) => MergeRepairCompletion::NeedsAnotherPass { task, error },
                    Err(_) => MergeRepairCompletion::Stopped,
                }
            }
        }
    })
}

fn prepare_merge_repair_locked(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
    merge_error: &str,
) -> Result<WorkTask, String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    if task.status != WorkTaskStatus::Review {
        return Err(merge_error.to_string());
    }
    let tree = task
        .worktree
        .clone()
        .ok_or_else(|| merge_error.to_string())?;
    if !worktree::has_unmerged_paths(Path::new(&tree.path))? {
        return Err(merge_error.to_string());
    }
    let base_head = worktree::resolve(project_path, &tree.base_branch)
        .unwrap_or_else(|_| tree.base_sha.clone());
    let merge_session_id = task
        .session_id
        .clone()
        .unwrap_or_else(|| format!("work-task-{}-merge", task.id));
    store::update(project_id, task_id, |task| {
        task.status = WorkTaskStatus::Merging;
        task.merge_intent = Some(WorkTaskMergeIntent {
            branch: tree.branch.clone(),
            base_branch: tree.base_branch.clone(),
            base_head: base_head.clone(),
            started_at: store::now_ms(),
        });
        task.session_id = Some(merge_session_id.clone());
        task.last_error = None;
        Ok(())
    })
}

/// Continue an accepted task through Agent-assisted conflict resolution.
pub(crate) fn spawn_merge_repair(
    app: AppHandle,
    project_id: String,
    project_path: PathBuf,
    task: WorkTask,
    merge_error: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut task = task;
        let mut error = merge_error;
        // A base branch can move while the Agent is working. Give the same
        // Agent up to two follow-up passes rather than bouncing an ordinary
        // concurrent edit back to the user immediately.
        for _ in 0..3 {
            let Some(tree) = task.worktree.clone() else {
                break;
            };
            let session_id = task
                .session_id
                .clone()
                .unwrap_or_else(|| format!("work-task-{}-merge", task.id));
            let turn = crate::engine::run_work_task_turn(
                app.clone(),
                session_id,
                project_id.clone(),
                PathBuf::from(&tree.path),
                crate::engine::WorkTaskTurnBinding {
                    task_id: task.id.clone(),
                    run_seq: task.run_seq,
                },
                merge_repair_prompt(&task, &error),
                task.model.clone(),
                Arc::new(AtomicBool::new(false)),
            )
            .await;
            let summary = match turn {
                Ok(summary) => summary,
                Err(agent_error) => {
                    let _ = back_to_review(
                        &project_id,
                        &task.id,
                        &format!(
                            "The merge Agent failed before resolving the conflict: {agent_error}"
                        ),
                    );
                    break;
                }
            };
            let completion = crate::blocking::off_main_thread({
                let project_id = project_id.clone();
                let project_path = project_path.clone();
                let task_id = task.id.clone();
                move || {
                    Ok(complete_merge_repair(
                        &project_id,
                        &project_path,
                        &task_id,
                        &summary,
                    ))
                }
            })
            .await;
            match completion {
                Ok(MergeRepairCompletion::Done | MergeRepairCompletion::Stopped) | Err(_) => break,
                Ok(MergeRepairCompletion::NeedsAnotherPass {
                    task: next_task,
                    error: next_error,
                }) => {
                    task = next_task;
                    error = next_error;
                }
            }
        }
        // If all three passes found fresh conflicts, stop owning the card so
        // it remains inspectable instead of being stranded in Merging.
        if store::get(&project_id, &task.id)
            .is_some_and(|current| current.status == WorkTaskStatus::Merging)
        {
            let _ = back_to_review(
                &project_id,
                &task.id,
                "The base branch kept changing while the merge Agent was resolving it. The latest conflict remains in the isolated task worktree; accept again to let the Agent continue.",
            );
        }
        emit_changed(&app, &project_id);
        pump(app.clone(), project_id.clone(), project_path).await;
    });
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
            "the task's worktree is gone from disk ({}), so its result cannot be read",
            tree.path
        ));
    }
    let message = format!(
        "{}\n\nRecovered artifacts from SomniQ work task {}.",
        task.title, task.id
    );
    worktree::commit_all(&path, &message, &tree.base_sha)?;
    // Re-importing is idempotent — ids are derived from the staged path — so
    // this also recovers deliverables from a run whose import was interrupted.
    let imported = super::artifacts::import(project_id, &task.id, &path).unwrap_or_default();
    let previous = task
        .review_snapshot
        .as_ref()
        .map(|snapshot| snapshot.artifacts.clone())
        .unwrap_or_default();
    let artifacts = carry_forward_exports(imported, &previous);
    let snapshot = capture_snapshot_with_artifacts(&path, &tree.base_sha, artifacts)?;
    // Cards produced before structured review have no snapshot at all, so
    // comparing on the counters alone would leave them un-upgraded forever.
    if task.review_snapshot.as_ref().is_some_and(|current| {
        current.head_sha == snapshot.head_sha && current.files == snapshot.files
    }) {
        return Ok(task);
    }
    let run_seq = task.run_seq;
    store::update(project_id, &task.id, |current| {
        if current.status != WorkTaskStatus::Review || current.run_seq != run_seq {
            return Err("the task changed while its review snapshot was refreshed".to_string());
        }
        current.changes = Some(snapshot.changes());
        current.review_snapshot = Some(snapshot.clone());
        Ok(())
    })
}

/// Keep "you already saved this to Downloads" across a re-import.
///
/// A fresh import knows the bytes but not the history, and losing the export
/// path would tell a user who has already saved a deliverable that they have
/// not — the sort of small lie that makes them do it twice.
///
/// Falls back to the previous list when nothing is staged any more: the
/// deliverables are still in the managed store, and dropping the rows would
/// make a result that exists look like one that never did.
fn carry_forward_exports(
    imported: Vec<WorkTaskArtifact>,
    previous: &[WorkTaskArtifact],
) -> Vec<WorkTaskArtifact> {
    if imported.is_empty() {
        return previous.to_vec();
    }
    imported
        .into_iter()
        .map(|mut artifact| {
            if let Some(earlier) = previous.iter().find(|earlier| earlier.id == artifact.id) {
                // Only when the bytes are the same. An export of an older
                // version is not an export of this one.
                if earlier.sha256 == artifact.sha256 {
                    artifact.exported_path = earlier.exported_path.clone();
                }
            }
            artifact
        })
        .collect()
}

/// The structured result a reviewer reads.
///
/// Recovers a snapshot for cards that predate this, and for cards produced by
/// versions that left generated artifacts uncommitted — which is the same
/// repair the old diff path performed, kept because those cards still exist.
pub(crate) fn review_snapshot(
    project_id: &str,
    task_id: &str,
) -> Result<WorkTaskReviewSnapshot, String> {
    with_merge_lock(project_id, || review_snapshot_locked(project_id, task_id))
}

fn review_snapshot_locked(
    project_id: &str,
    task_id: &str,
) -> Result<WorkTaskReviewSnapshot, String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    let missing_worktree = |base_sha: String| WorkTaskReviewSnapshot {
        base_sha,
        head_sha: String::new(),
        files: Vec::new(),
        artifacts: Vec::new(),
        // NOT "no changes": the work may well exist and simply be unreadable,
        // and telling the user their task produced nothing would invite them
        // to throw away a result that was never inspected.
        empty_reason: Some(WorkTaskEmptyReason::WorktreeMissing),
        captured_at: store::now_ms(),
    };
    let Some(tree) = task.worktree.clone() else {
        // Never had a checkout, so nothing ever ran in one.
        return Ok(task.review_snapshot.clone().unwrap_or(WorkTaskReviewSnapshot {
            base_sha: String::new(),
            head_sha: String::new(),
            files: Vec::new(),
            artifacts: Vec::new(),
            empty_reason: Some(WorkTaskEmptyReason::NothingProduced),
            captured_at: store::now_ms(),
        }));
    };
    if !Path::new(&tree.path).is_dir() {
        // A snapshot taken while the checkout existed is still the truth about
        // what the run produced; only the ability to act on it is gone.
        return Ok(task
            .review_snapshot
            .clone()
            .unwrap_or_else(|| missing_worktree(tree.base_sha.clone())));
    }
    let task = snapshot_review_task(project_id, task)?;
    task.review_snapshot
        .clone()
        .map_or_else(|| capture_snapshot(Path::new(&tree.path), &tree.base_sha), Ok)
}

/// The patch text for a reviewed task, read at the revisions its snapshot
/// pinned.
///
/// `path` narrows it to one file, which is what makes a large result reviewable
/// at all: the whole-diff cap truncates, and a truncated patch silently hides
/// whichever files sort last.
pub(crate) fn review_patch(
    project_id: &str,
    task_id: &str,
    path: Option<&str>,
) -> Result<String, String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    let Some(tree) = task.worktree.as_ref() else {
        return Ok(String::new());
    };
    let tree_path = PathBuf::from(&tree.path);
    if !tree_path.is_dir() {
        return Err(format!(
            "the task's worktree is gone from disk ({}), so its patch cannot be read",
            tree.path
        ));
    }
    // Read at the pinned revisions when there are any, so the patch describes
    // the same result the file list does even if the checkout has moved on.
    let (base, head) = task.review_snapshot.as_ref().map_or_else(
        || (tree.base_sha.clone(), "HEAD".to_string()),
        |snapshot| (snapshot.base_sha.clone(), snapshot.head_sha.clone()),
    );
    worktree::patch_between(&tree_path, &base, &head, path, MAX_DIFF_CHARS)
}

/// Persist a question and end the current turn on it.
///
/// A work-task turn is given Chat's tool registry, `AskUserQuestion` included.
/// Unlike interactive Chat it must not wait on the answer channel: the board
/// keeps the question and the turn exits, releasing the execution slot.
///
/// Returns whether the task was actually parked. `false` means the generation
/// moved (the run was cancelled or superseded) and the caller must not wait.
pub(crate) fn question_raised(
    app: &AppHandle,
    project_id: &str,
    task_id: &str,
    run_seq: u32,
    action: WorkTaskPendingAction,
) -> bool {
    let parked = store::update(project_id, task_id, |task| {
        if task.run_seq != run_seq {
            return Err("superseded by a newer run".to_string());
        }
        if !matches!(task.status, WorkTaskStatus::Running | WorkTaskStatus::Revising) {
            return Err(format!(
                "a question can only park an executing task; this one is {}",
                task.status.as_str()
            ));
        }
        task.status = WorkTaskStatus::AwaitingInput;
        task.pending_action = Some(action.clone());
        task.progress_message = Some("Waiting for your answer".to_string());
        task.last_heartbeat_at = None;
        Ok(())
    });
    if parked.is_ok() {
        emit_changed(app, project_id);
    }
    parked.is_ok()
}

/// The persisted question a reply will continue from.
pub(crate) fn pending_question(
    project_id: &str,
    task_id: &str,
) -> Option<(WorkTask, WorkTaskPendingAction)> {
    let task = store::get(project_id, task_id)?;
    if task.status != WorkTaskStatus::AwaitingInput {
        return None;
    }
    let action = task.pending_action.clone()?;
    Some((task, action))
}

/// Whether Chat's interrupted result is the deliberate end of this exact run.
pub(crate) fn awaiting_input_for_run(project_id: &str, task_id: &str, run_seq: u32) -> bool {
    store::get(project_id, task_id).is_some_and(|task| {
        task.run_seq == run_seq
            && task.status == WorkTaskStatus::AwaitingInput
            && task.pending_action.is_some()
    })
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

    #[test]
    fn the_merge_agent_prompt_requires_semantic_resolution_and_staging() {
        let mut task = WorkTask::new(
            "merge-1".into(),
            "Update the paper library".into(),
            String::new(),
            0,
        );
        task.worktree = Some(super::super::model::WorkTaskWorktree {
            path: "C:/work/tree".into(),
            branch: "somniq/task/merge-1".into(),
            base_branch: "main".into(),
            base_sha: "abc".into(),
        });
        let prompt = merge_repair_prompt(&task, "both added: library.json");

        assert!(prompt.contains("merge Agent for the same task"));
        assert!(prompt.contains("merge records by meaning"));
        assert!(prompt.contains("git add"));
        assert!(prompt.contains("Do not commit"));
        assert!(prompt.contains("both added: library.json"));
    }

    /// A resume runs in the same session as the attempt it continues, so the
    /// original brief is already in context. What it must say is what the model
    /// cannot see: that its own edits are on disk and it should read them.
    #[test]
    fn the_resume_prompt_points_the_turn_at_what_is_already_on_disk() {
        let mut task = WorkTask::new(
            "r1".into(),
            "Rewrite section 3".into(),
            "Tighten the argument.".into(),
            0,
        );
        task.status = WorkTaskStatus::Paused;
        let prompt = resume_prompt(&task, "somniq/task/r1");

        assert!(prompt.contains("Rewrite section 3"));
        assert!(prompt.contains("paused by the user"));
        assert!(prompt.contains("somniq/task/r1"));
        assert!(prompt.contains("git status"));
        // Still unattended, and still not allowed to commit.
        assert!(prompt.contains("nobody is watching"));
        assert!(prompt.contains("do not commit"));
    }

    /// Resuming an interrupted run says so rather than blaming the user, and a
    /// resumed *failure* carries the error the model has to work past.
    #[test]
    fn the_resume_prompt_names_the_reason_the_run_stopped() {
        let mut task = WorkTask::new("r2".into(), "Fix the build".into(), String::new(), 0);
        task.status = WorkTaskStatus::Interrupted;
        assert!(resume_prompt(&task, "b").contains("SomniQ closed"));

        task.status = WorkTaskStatus::Failed;
        task.last_error = Some("tectonic exited with status 1".into());
        let failed = resume_prompt(&task, "b");
        assert!(failed.contains("tectonic exited with status 1"));

        // A stale error from an earlier failure must not be replayed into a
        // pause — it would send the turn chasing a problem that is not there.
        task.status = WorkTaskStatus::Paused;
        assert!(!resume_prompt(&task, "b").contains("tectonic exited"));
    }

    /// The Reviewer's whole value is checking the claim against the evidence.
    /// A prompt that shows it the summary but not the diff, or the diff but
    /// not what the task asked for, cannot do that.
    #[test]
    fn the_reviewer_sees_the_task_the_result_and_the_claim() {
        let task = WorkTask::new(
            "rev-1".into(),
            "Rewrite section 3".into(),
            "Tighten the argument.".into(),
            0,
        );
        let snapshot = WorkTaskReviewSnapshot {
            base_sha: "aaa".into(),
            head_sha: "bbb".into(),
            files: vec![super::super::model::WorkTaskReviewFile {
                path: "section3.tex".into(),
                previous_path: None,
                change_kind: super::super::model::WorkTaskFileChangeKind::Modified,
                binary: false,
                additions: Some(12),
                deletions: Some(30),
                byte_size: Some(900),
            }],
            artifacts: Vec::new(),
            empty_reason: None,
            captured_at: 0,
        };
        // A path that does not exist, so the patch read fails — the prompt has
        // to say so rather than quietly present a diff-free review.
        let prompt = reviewer_prompt(&task, &snapshot, "Tightened the argument.", Path::new("/nope"));

        assert!(prompt.contains("Rewrite section 3"));
        assert!(prompt.contains("Tighten the argument."));
        assert!(prompt.contains("modified section3.tex"));
        assert!(prompt.contains("Tightened the argument."));
        assert!(
            prompt.contains("could not be read"),
            "an unreadable diff must be declared: {prompt}"
        );
        // The verdict vocabulary the parser expects.
        assert!(prompt.contains("\"verdict\""));
        assert!(prompt.contains("needs_user"));
    }

    /// A deliverable is the whole result for "write me a report", so a
    /// Reviewer that is not told about it would judge an empty diff.
    #[test]
    fn the_reviewer_is_told_about_deliverables_that_are_not_in_the_diff() {
        let task = WorkTask::new("rev-2".into(), "Write the report".into(), String::new(), 0);
        let snapshot = WorkTaskReviewSnapshot {
            base_sha: "aaa".into(),
            head_sha: "bbb".into(),
            files: Vec::new(),
            artifacts: vec![super::super::model::WorkTaskArtifact {
                id: "art".into(),
                relative_path: "report.pdf".into(),
                title: "report.pdf".into(),
                managed_path: "C:/store/report.pdf".into(),
                exported_path: None,
                byte_size: 4_096,
                sha256: "abc".into(),
                created_at: 0,
            }],
            empty_reason: Some(WorkTaskEmptyReason::ArtifactsOnly),
            captured_at: 0,
        };
        let prompt = reviewer_prompt(&task, &snapshot, "Wrote the report.", Path::new("/nope"));
        assert!(prompt.contains("report.pdf"));
        assert!(prompt.contains("No repository files were changed"));
    }

    /// The executor is sent back with the issues themselves, not just "try
    /// again" — and is told to argue rather than silently ignore one.
    #[test]
    fn the_revision_prompt_carries_the_issues_and_forbids_silent_disagreement() {
        let review = super::super::model::WorkTaskReviewState {
            round: 1,
            max_rounds: MAX_REVIEW_ROUNDS,
            verdict: super::super::model::WorkTaskVerdict::Revise,
            summary: "The claim is not supported by the diff.".into(),
            issues: vec![super::super::model::WorkTaskReviewIssue {
                severity: "high".into(),
                title: "Section 3 was not touched".into(),
                detail: "The summary says it was rewritten; the diff only changes section 2."
                    .into(),
                recommendation: "Rewrite section 3, or correct the summary.".into(),
            }],
            reviewer_model: "some-model".into(),
            exhausted: false,
            checked_at: 0,
        };
        let prompt = revision_prompt(&review);

        assert!(prompt.contains("Section 3 was not touched"));
        assert!(prompt.contains("only changes section 2"));
        assert!(prompt.contains("Rewrite section 3, or correct the summary."));
        assert!(prompt.contains("[high]"));
        assert!(prompt.contains("say so in your summary"));
        assert!(prompt.contains("do not commit"));
    }

    /// A verdict with no issues still has to produce a usable instruction, or
    /// the round is spent telling the executor nothing.
    #[test]
    fn a_revision_with_no_listed_issues_still_says_what_to_do() {
        let review = super::super::model::WorkTaskReviewState {
            round: 1,
            max_rounds: MAX_REVIEW_ROUNDS,
            verdict: super::super::model::WorkTaskVerdict::Revise,
            summary: String::new(),
            issues: Vec::new(),
            reviewer_model: String::new(),
            exhausted: false,
            checked_at: 0,
        };
        let prompt = revision_prompt(&review);
        assert!(prompt.contains("re-read your own work"));
    }

    /// Only `revise` costs a round. Treating `needs_user` or `unavailable` as
    /// a revision would spend the budget re-running an executor that cannot
    /// fix the problem.
    #[test]
    fn only_a_revise_verdict_sends_the_executor_back() {
        use super::super::model::WorkTaskVerdict::*;
        assert!(Revise.wants_revision());
        for verdict in [Pass, NeedsUser, Unavailable] {
            assert!(!verdict.wants_revision(), "{verdict:?} must not loop");
        }
    }

    /// A Reviewer that could not run is recorded as unavailable, never as a
    /// pass: an unchecked result presented as a checked one is the failure the
    /// independent review exists to prevent.
    #[test]
    fn a_reviewer_that_cannot_run_is_recorded_as_unchecked() {
        let review = unavailable_review(1, "the Reviewer could not be started");
        assert_eq!(
            review.verdict,
            super::super::model::WorkTaskVerdict::Unavailable
        );
        assert!(!review.verdict.wants_revision());
        assert!(review.summary.contains("could not be started"));
        assert_eq!(review.max_rounds, MAX_REVIEW_ROUNDS);
    }

    /// Stopping a task nothing is running is a no-op, not a panic — the board
    /// can offer Stop on a card whose turn just finished.
    #[test]
    fn stopping_an_unregistered_task_reports_that_nothing_listened() {
        assert!(!signal_stop("no-such-task", WorkTaskStopReason::Cancel));
    }

    #[test]
    fn a_registered_stop_is_observed_with_its_reason_and_then_cleared() {
        let handle = register_stop("stop-me");
        assert!(!handle.requested());
        assert_eq!(handle.reason(), None);

        assert!(signal_stop("stop-me", WorkTaskStopReason::Pause));
        assert!(handle.requested());
        assert_eq!(handle.reason(), Some(WorkTaskStopReason::Pause));

        clear_stop("stop-me");
        assert!(!signal_stop("stop-me", WorkTaskStopReason::Pause));
    }

    /// The settle reads the reason to decide whether the checkout survives, so
    /// a cancel arriving after a pause must win: keeping a worktree the user
    /// asked to throw away is the failure that cannot be undone from the board.
    #[test]
    fn a_cancel_overrides_a_pending_pause_but_not_the_other_way_round() {
        let handle = register_stop("escalate");
        assert!(signal_stop("escalate", WorkTaskStopReason::Pause));
        assert!(signal_stop("escalate", WorkTaskStopReason::Cancel));
        assert_eq!(handle.reason(), Some(WorkTaskStopReason::Cancel));
        // And a pause behind a cancel changes nothing.
        assert!(signal_stop("escalate", WorkTaskStopReason::Pause));
        assert_eq!(handle.reason(), Some(WorkTaskStopReason::Cancel));
        clear_stop("escalate");
    }
}

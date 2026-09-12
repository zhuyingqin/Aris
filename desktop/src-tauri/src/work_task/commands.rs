//! Tauri command surface for the work-task board.
//!
//! Each command is a shell: resolve the active project's id and path, then call
//! a `*_core` function taking them as plain values — the split the rest of this
//! crate is moving to, so the board's rules are testable without a live app.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::projects::{current_project_binding, ProjectState};

use super::engine;
use super::model::{
    WorkTask, WorkTaskPendingAction, WorkTaskReviewSnapshot, WorkTaskStatus, WorkTaskStopReason,
};
use super::store::{self, WorkTaskSnapshot};
use super::worktree;

fn binding(projects: &ProjectState) -> Result<(String, PathBuf), String> {
    current_project_binding(projects)
}

/// A new task id. Time-ordered so the default board order is creation order,
/// with a random suffix so two cards created in the same millisecond do not
/// collide on a filesystem path.
fn new_task_id(now: u64) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{now:x}-{seq:04x}")
}

#[tauri::command]
pub async fn work_task_list(projects_state: State<'_, ProjectState>) -> Result<Vec<WorkTask>, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || Ok(list_core(&project_id, &project_path))).await
}

/// The board's load: the same rows as [`work_task_list`], plus the store
/// revision they were read at.
///
/// The revision is what makes "subscribe first, then load" safe. Without it the
/// board cannot tell a change event describing state it already has from one
/// describing state it is missing, and has to re-read on every event.
#[tauri::command]
pub async fn work_task_snapshot(
    projects_state: State<'_, ProjectState>,
) -> Result<WorkTaskSnapshot, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || Ok(snapshot_core(&project_id, &project_path))).await
}

pub(crate) fn snapshot_core(project_id: &str, project_path: &Path) -> WorkTaskSnapshot {
    let snapshot = store::snapshot(project_id);
    WorkTaskSnapshot {
        revision: snapshot.revision,
        tasks: stamp_derived(project_path, snapshot.tasks),
    }
}

/// Stamp the rows the board cannot work out for itself.
///
/// `worktreeMissing` is derived here rather than stored: a checkout can vanish
/// between two reads (the user deleted it, a `git worktree prune` ran), and a
/// board that keeps offering "accept" on a task whose work is gone produces an
/// error the user cannot act on.
///
/// It is a field of its own rather than a `last_error` message, because the
/// board treats the two differently: this one withdraws Accept, while
/// `last_error` — for instance the reason a merge did not go through — leaves
/// it offered so the user can fix the cause and try again.
pub(crate) fn list_core(project_id: &str, project_path: &Path) -> Vec<WorkTask> {
    stamp_derived(project_path, store::list(project_id))
}

fn stamp_derived(project_path: &Path, tasks: Vec<WorkTask>) -> Vec<WorkTask> {
    let repository = worktree::is_git_repository(project_path);
    tasks
        .into_iter()
        .map(|mut task| {
            if !repository {
                return task;
            }
            if let Some(tree) = task.worktree.as_ref() {
                task.worktree_missing = !Path::new(&tree.path).is_dir();
            }
            task
        })
        .collect()
}

#[tauri::command]
pub async fn work_task_create(
    projects_state: State<'_, ProjectState>,
    title: String,
    prompt: String,
    model: Option<String>,
) -> Result<WorkTask, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || create_core(&project_id, title, prompt, model)).await
}

pub(crate) fn create_core(
    project_id: &str,
    title: String,
    prompt: String,
    model: Option<String>,
) -> Result<WorkTask, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("a work task needs a title".to_string());
    }
    let now = store::now_ms();
    let mut task = WorkTask::new(new_task_id(now), title, prompt.trim().to_string(), now);
    task.model = model.filter(|value| !value.trim().is_empty());
    store::insert(project_id, task)
}

/// Create a task and queue it in one step.
///
/// The board's default action, because "create" that leaves a card sitting at
/// `todo` until a second click is a step nobody wants: a user who describes a
/// task means it to run. Saving without starting is still offered, explicitly.
///
/// Atomic from the user's side: the repository check that would refuse the
/// launch runs *before* the row is written, so a project that cannot host a
/// task never produces a card that silently refuses to start.
#[tauri::command]
pub async fn work_task_create_and_start(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    title: String,
    prompt: String,
    model: Option<String>,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let queued = crate::blocking::off_main_thread({
        let project_id = project_id.clone();
        let project_path = project_path.clone();
        move || {
            if !worktree::is_git_repository(&project_path) {
                return Err(NOT_A_REPOSITORY.to_string());
            }
            let created = create_core(&project_id, title, prompt, model)?;
            start_core(&project_id, &project_path, &created.id)
        }
    })
    .await?;
    engine::pump(app.clone(), project_id.clone(), project_path).await;
    engine::emit_changed(&app, &project_id);
    Ok(queued)
}

/// Create and queue the work task for one firing of a scheduled automation.
///
/// Not a Tauri command: the caller is `scheduled.rs`, not the UI. It exists so
/// an automation and a hand-made task are the same kind of thing from here on
/// — same worktree, same review, same recovery — rather than a second runner
/// with its own idea of what "running" and "finished" mean.
///
/// Refuses if the automation already has a run in flight. A schedule whose
/// interval is shorter than its work would otherwise stack up runs that all
/// edit the same branch.
pub(crate) fn queue_scheduled_run(
    project_id: &str,
    project_path: &Path,
    scheduled_task_id: &str,
    title: String,
    prompt: String,
    model: Option<String>,
) -> Result<WorkTask, String> {
    if !worktree::is_git_repository(project_path) {
        return Err(NOT_A_REPOSITORY.to_string());
    }
    if let Some(existing) = store::list(project_id).into_iter().find(|task| {
        task.scheduled_task_id.as_deref() == Some(scheduled_task_id)
            && (task.status.holds_a_slot() || task.status == WorkTaskStatus::Queued)
    }) {
        return Err(format!(
            "the previous run of this automation is still {} — skipping this firing rather than \
             starting a second run against the same branch",
            existing.status.as_str()
        ));
    }
    let created = create_core(project_id, title, prompt, model)?;
    store::update(project_id, &created.id, |task| {
        task.scheduled_task_id = Some(scheduled_task_id.to_string());
        Ok(())
    })?;
    start_core(project_id, project_path, &created.id)
}

#[tauri::command]
pub async fn work_task_update(
    projects_state: State<'_, ProjectState>,
    task_id: String,
    title: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
) -> Result<WorkTask, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || {
        update_core(&project_id, &task_id, title, prompt, model)
    })
    .await
}

/// Editing is refused while the engine owns the task.
///
/// Not merely racy — the prompt is replayed at launch, so letting it change
/// under a running turn would leave a card describing work that was never
/// asked for.
pub(crate) fn update_core(
    project_id: &str,
    task_id: &str,
    title: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
) -> Result<WorkTask, String> {
    store::update(project_id, task_id, |task| {
        if task.status.is_engine_owned() {
            return Err(format!(
                "this task is {} and cannot be edited; cancel it first",
                task.status.as_str()
            ));
        }
        if let Some(title) = title {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err("a work task needs a title".to_string());
            }
            task.title = title;
        }
        if let Some(prompt) = prompt {
            task.prompt = prompt.trim().to_string();
        }
        if let Some(model) = model {
            task.model = Some(model).filter(|value| !value.trim().is_empty());
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn work_task_delete(
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<(), String> {
    let (project_id, project_path) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || delete_core(&project_id, &project_path, &task_id)).await
}

pub(crate) fn delete_core(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<(), String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    if task.status.is_engine_owned() {
        return Err(format!(
            "this task is {} and cannot be deleted; cancel it first",
            task.status.as_str()
        ));
    }
    // The row goes only after its checkout does, so a failure here does not
    // strand a worktree with nothing left to reference it.
    engine::discard_worktree(project_path, &task);
    // Deliverables live outside the repository, so nothing else would ever
    // collect them. Deleting the card is the user saying they are finished
    // with the result, not just with the branch.
    super::artifacts::discard(project_id, task_id);
    store::remove(project_id, task_id)
}

#[tauri::command]
pub async fn work_task_start(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let queue_project = project_id.clone();
    let queued = crate::blocking::off_main_thread({
        let task_id = task_id.clone();
        let project_path = project_path.clone();
        move || start_core(&queue_project, &project_path, &task_id)
    })
    .await?;
    // Pump straight away so pressing Start does not wait for the next tick.
    engine::pump(app.clone(), project_id.clone(), project_path).await;
    engine::emit_changed(&app, &project_id);
    Ok(queued)
}

/// Queue a task, refusing up front what the engine would only discover at
/// launch — a project that is not a repository has nowhere to isolate the work,
/// and finding that out after the card has moved is worse than not moving it.
pub(crate) const NOT_A_REPOSITORY: &str =
    "work tasks need a Git repository: this project is not one, so there is no branch to isolate the work on";

pub(crate) fn start_core(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<WorkTask, String> {
    if !worktree::is_git_repository(project_path) {
        return Err(NOT_A_REPOSITORY.to_string());
    }
    store::update(project_id, task_id, |task| {
        match task.status {
            status
                if matches!(status, WorkTaskStatus::Todo | WorkTaskStatus::Canceled)
                    || status.is_resumable() =>
            {
                let resume_context = match status {
                    WorkTaskStatus::Paused => Some(
                        "You were paused by the user part-way through this task.".to_string(),
                    ),
                    WorkTaskStatus::Interrupted => Some(
                        "SomniQ closed part-way through this task, so the previous turn was interrupted."
                            .to_string(),
                    ),
                    WorkTaskStatus::Failed => task.last_error.as_ref().map(|error| {
                        format!("The previous turn ended with this error:\n\n{error}")
                    }),
                    _ => None,
                };
                task.status = WorkTaskStatus::Queued;
                task.last_error = None;
                // The next run writes its own phase. Anything left here would
                // describe the run that stopped, on a card that is now waiting.
                task.clear_run_state();
                task.resume_context = resume_context;
                Ok(())
            }
            other => Err(format!(
                "only a task in todo, paused, interrupted, failed or canceled can be started; this one is {}",
                other.as_str()
            )),
        }
    })
}

/// Ask a running task to stop and keep everything it has.
///
/// Not a lighter cancel: the difference is the checkout and the chat session,
/// which survive so a resume continues the same attempt rather than restarting
/// it. The card goes to `pausing` first — the turn is still executing inside
/// the worktree, and claiming it is already stopped would be a lie the user
/// could act on.
#[tauri::command]
pub async fn work_task_pause(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    let (project_id, _) = binding(&projects_state)?;
    let emit_project = project_id.clone();
    let task =
        crate::blocking::off_main_thread(move || pause_core(&project_id, &task_id)).await?;
    engine::emit_changed(&app, &emit_project);
    Ok(task)
}

pub(crate) fn pause_core(project_id: &str, task_id: &str) -> Result<WorkTask, String> {
    let task = store::update(project_id, task_id, |task| {
        match task.status {
            WorkTaskStatus::Preparing
            | WorkTaskStatus::Running
            // The review loop is several model calls long; making it the one
            // stretch of a task the user cannot interrupt would be arbitrary.
            | WorkTaskStatus::Reviewing
            | WorkTaskStatus::Revising => {
                task.status = WorkTaskStatus::Pausing;
                task.stop_reason = Some(WorkTaskStopReason::Pause);
                task.progress_message = Some("Stopping at the next safe point".to_string());
                Ok(())
            }
            // Deliberately not `queued`: nothing is running, so there is
            // nothing to wind down and the honest action is to cancel it back
            // to the board.
            other => Err(format!(
                "only a running task can be paused; this one is {}",
                other.as_str()
            )),
        }
    })?;
    // `run_seq` is NOT bumped here, unlike a cancel. The settle has to be
    // allowed through: it is what turns `pausing` into `paused`, and a bumped
    // generation would discard it and strand the card mid-handshake.
    if !engine::signal_stop(task_id, WorkTaskStopReason::Pause) {
        // Nothing was listening, so no settle is coming. Finish the handshake
        // here rather than leave the card claiming to be winding down.
        return store::update(project_id, task_id, |task| {
            if task.status != WorkTaskStatus::Pausing {
                return Err("the task moved on while it was being paused".to_string());
            }
            task.status = WorkTaskStatus::Paused;
            task.progress_message = None;
            Ok(())
        });
    }
    Ok(task)
}

/// Continue a stopped task in the checkout and session it already has.
#[tauri::command]
pub async fn work_task_resume(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    work_task_start(app, projects_state, task_id).await
}

/// Answer a persisted question and queue the continuation turn.
#[tauri::command]
pub async fn work_task_reply(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
    answer: String,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let answer = answer.trim().to_string();
    if answer.is_empty() {
        return Err("an answer cannot be empty".to_string());
    }
    let queued = reply_core(&project_id, &task_id, &answer)?;
    // The old turn is already gone, so answering behaves like Start: claim a
    // free slot now if one exists, otherwise remain visibly queued.
    engine::pump(app.clone(), project_id.clone(), project_path).await;
    engine::emit_changed(&app, &project_id);
    Ok(queued)
}

pub(crate) fn reply_core(
    project_id: &str,
    task_id: &str,
    answer: &str,
) -> Result<WorkTask, String> {
    let (_, action) = engine::pending_question(project_id, task_id)
        .ok_or_else(|| "this task is not waiting for an answer".to_string())?;
    let WorkTaskPendingAction::Question { question, .. } = action;
    let continuation = format!(
        "You stopped the previous turn to ask:\n\n{question}\n\nThe user answered:\n\n{}\n\nContinue the task from that answer.",
        answer.trim()
    );
    store::update(project_id, task_id, |task| {
        if task.status != WorkTaskStatus::AwaitingInput {
            return Err("this task is no longer waiting for an answer".to_string());
        }
        task.clear_run_state();
        task.resume_context = Some(continuation);
        task.status = WorkTaskStatus::Queued;
        task.progress_message = Some("Queued after your answer".to_string());
        task.last_error = None;
        Ok(())
    })
}

#[tauri::command]
pub async fn work_task_cancel(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let emit_project = project_id.clone();
    let task = crate::blocking::off_main_thread(move || {
        cancel_core(&project_id, &project_path, &task_id)
    })
    .await?;
    engine::emit_changed(&app, &emit_project);
    Ok(task)
}

/// Stop a task, whether or not a turn is in flight.
///
/// Bumping `run_seq` is what makes this safe: a turn that completes a moment
/// later settles against a generation that no longer exists and writes nothing,
/// so the card the user just cancelled cannot reappear in review.
pub(crate) fn cancel_core(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<WorkTask, String> {
    let task = store::update(project_id, task_id, |task| {
        if task.status == WorkTaskStatus::Merging {
            return Err(
                "this task is being merged; the base branch is being written and it cannot be cancelled"
                    .to_string(),
            );
        }
        if task.status.is_terminal() {
            return Err(format!(
                "this task is already {}",
                task.status.as_str()
            ));
        }
        task.status = WorkTaskStatus::Canceled;
        task.run_seq = task.run_seq.saturating_add(1);
        task.clear_run_state();
        task.stop_reason = Some(WorkTaskStopReason::Cancel);
        Ok(())
    })?;
    // Two very different situations share this command. If a run is listening,
    // the turn is still executing inside the worktree and only it may tear the
    // directory down — `release_cancelled_worktree` does that once it winds up.
    // If nothing is listening (a queued card, or one cancelled long after a
    // failed run), no later pass will ever come back for it, so the checkout is
    // released here or not at all.
    if engine::signal_stop(task_id, WorkTaskStopReason::Cancel) {
        return Ok(task);
    }
    engine::discard_worktree(project_path, &task);
    store::update(project_id, task_id, |task| {
        task.worktree = None;
        Ok(())
    })
}

#[tauri::command]
pub async fn work_task_retry(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    work_task_start(app, projects_state, task_id).await
}

#[tauri::command]
pub async fn work_task_return_to_todo(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let emit_project = project_id.clone();
    let task = crate::blocking::off_main_thread(move || {
        return_to_todo_core(&project_id, &project_path, &task_id)
    })
    .await?;
    engine::emit_changed(&app, &emit_project);
    Ok(task)
}

/// Send a reviewed or failed task back to the board, throwing its work away.
///
/// The worktree goes with it: keeping it would leave a branch nothing points
/// at, and the next launch recreates one from the current base anyway.
pub(crate) fn return_to_todo_core(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<WorkTask, String> {
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    if task.status.is_engine_owned() {
        return Err(format!(
            "this task is {} and cannot be returned; cancel it first",
            task.status.as_str()
        ));
    }
    engine::discard_worktree(project_path, &task);
    // Returning a card to the board throws its work away, and the deliverables
    // are part of that work. Leaving them would let a later run's results sit
    // beside results from an attempt the user explicitly discarded.
    super::artifacts::discard(project_id, task_id);
    store::update(project_id, task_id, |task| {
        task.status = WorkTaskStatus::Todo;
        task.worktree = None;
        task.last_error = None;
        // Drops the result as well as the run state — see `clear_run_state`.
        task.clear_run_state();
        Ok(())
    })
}

#[tauri::command]
pub async fn work_task_accept(
    app: AppHandle,
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTask, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    let emit_project = project_id.clone();
    let merge_project = project_id.clone();
    let merge_path = project_path.clone();
    let merge_task_id = task_id.clone();
    let attempted = crate::blocking::off_main_thread(move || {
        engine::accept(&merge_project, &merge_path, &merge_task_id)
    })
    .await;
    let task = match attempted {
        Ok(task) => task,
        Err(error) => {
            let prepare_project = project_id.clone();
            let prepare_path = project_path.clone();
            let prepare_task_id = task_id.clone();
            let prepare_error = error.clone();
            let repair = crate::blocking::off_main_thread(move || {
                engine::prepare_merge_repair(
                    &prepare_project,
                    &prepare_path,
                    &prepare_task_id,
                    &prepare_error,
                )
            })
            .await?;
            engine::spawn_merge_repair(
                app.clone(),
                project_id.clone(),
                project_path,
                repair.clone(),
                error,
            );
            repair
        }
    };
    engine::emit_changed(&app, &emit_project);
    Ok(task)
}

/// What the task produced, as a structured file list rather than a patch.
///
/// The patch alone cannot express a binary file, a rename, or the difference
/// between "changed nothing" and "could not be read" — all of which used to
/// render as the same empty string.
#[tauri::command]
pub async fn work_task_review_snapshot(
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<WorkTaskReviewSnapshot, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || engine::review_snapshot(&project_id, &task_id)).await
}

/// Copy one deliverable out to a path the user chose.
///
/// The counterpart to merging a diff: a standalone deliverable is never landed
/// in the repository, so this is how it leaves SomniQ at all.
#[tauri::command]
pub async fn work_task_artifact_export(
    projects_state: State<'_, ProjectState>,
    task_id: String,
    artifact_id: String,
    destination: String,
) -> Result<WorkTask, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || {
        artifact_export_core(&project_id, &task_id, &artifact_id, &destination)
    })
    .await
}

pub(crate) fn artifact_export_core(
    project_id: &str,
    task_id: &str,
    artifact_id: &str,
    destination: &str,
) -> Result<WorkTask, String> {
    let destination = destination.trim();
    if destination.is_empty() {
        return Err("choose where to save this deliverable".to_string());
    }
    let task = store::get(project_id, task_id)
        .ok_or_else(|| format!("work task {task_id} was not found"))?;
    let artifact = task
        .review_snapshot
        .as_ref()
        .and_then(|snapshot| {
            snapshot
                .artifacts
                .iter()
                .find(|artifact| artifact.id == artifact_id)
        })
        .ok_or_else(|| "this task has no such deliverable".to_string())?;
    let written = super::artifacts::export(artifact, Path::new(destination))?;
    // Recorded so the card can say where it went — a deliverable the user
    // exported and then cannot find is the same as one they never got.
    store::update(project_id, task_id, |task| {
        let Some(snapshot) = task.review_snapshot.as_mut() else {
            return Err("this task no longer has a result".to_string());
        };
        let Some(artifact) = snapshot
            .artifacts
            .iter_mut()
            .find(|artifact| artifact.id == artifact_id)
        else {
            return Err("this task has no such deliverable".to_string());
        };
        artifact.exported_path = Some(written.clone());
        Ok(())
    })
}

/// The patch text, for the whole result or for one file of it.
#[tauri::command]
pub async fn work_task_review_patch(
    projects_state: State<'_, ProjectState>,
    task_id: String,
    path: Option<String>,
) -> Result<String, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || {
        engine::review_patch(&project_id, &task_id, path.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn work_task_reorder(
    projects_state: State<'_, ProjectState>,
    task_ids: Vec<String>,
) -> Result<Vec<WorkTask>, String> {
    let (project_id, project_path) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || {
        reorder_core(&project_id, &task_ids)?;
        Ok(list_core(&project_id, &project_path))
    })
    .await
}

pub(crate) fn reorder_core(project_id: &str, task_ids: &[String]) -> Result<(), String> {
    store::reorder(project_id, task_ids)
}

#[cfg(test)]
#[path = "../tests/work_task.rs"]
mod tests;

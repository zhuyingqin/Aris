//! Tauri command surface for the work-task board.
//!
//! Each command is a shell: resolve the active project's id and path, then call
//! a `*_core` function taking them as plain values — the split the rest of this
//! crate is moving to, so the board's rules are testable without a live app.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::projects::{current_project_binding, ProjectState};

use super::engine;
use super::model::{WorkTask, WorkTaskStatus};
use super::store;
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
    let repository = worktree::is_git_repository(project_path);
    store::list(project_id)
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
pub(crate) fn start_core(
    project_id: &str,
    project_path: &Path,
    task_id: &str,
) -> Result<WorkTask, String> {
    if !worktree::is_git_repository(project_path) {
        return Err(
            "work tasks need a Git repository: this project is not one, so there is no branch to isolate the work on"
                .to_string(),
        );
    }
    store::update(project_id, task_id, |task| {
        match task.status {
            WorkTaskStatus::Todo | WorkTaskStatus::Failed | WorkTaskStatus::Canceled => {
                task.status = WorkTaskStatus::Queued;
                task.last_error = None;
                Ok(())
            }
            other => Err(format!(
                "only a task in todo, failed or canceled can be started; this one is {}",
                other.as_str()
            )),
        }
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
        Ok(())
    })?;
    // Two very different situations share this command. If a run is listening,
    // the turn is still executing inside the worktree and only it may tear the
    // directory down — `release_cancelled_worktree` does that once it winds up.
    // If nothing is listening (a queued card, or one cancelled long after a
    // failed run), no later pass will ever come back for it, so the checkout is
    // released here or not at all.
    if engine::signal_cancel(task_id) {
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
    store::update(project_id, task_id, |task| {
        task.status = WorkTaskStatus::Todo;
        task.worktree = None;
        task.result_summary = None;
        task.changes = None;
        task.last_error = None;
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
    let task = crate::blocking::off_main_thread(move || {
        engine::accept(&project_id, &project_path, &task_id)
    })
    .await?;
    engine::emit_changed(&app, &emit_project);
    Ok(task)
}

#[tauri::command]
pub async fn work_task_diff(
    projects_state: State<'_, ProjectState>,
    task_id: String,
) -> Result<String, String> {
    let (project_id, _) = binding(&projects_state)?;
    crate::blocking::off_main_thread(move || engine::diff(&project_id, &task_id)).await
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

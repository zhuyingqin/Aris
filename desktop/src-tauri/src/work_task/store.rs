//! Per-project work-task persistence.
//!
//! The store lives at `<config>/desktop-runtime/work-tasks/<project-id>.json`,
//! **outside** the project directory. That is not a style choice: a task's
//! isolation is a git worktree of the same repository, so a store kept under
//! the project's `.somniq/` would exist once per worktree and an accepted merge
//! would merge the task board into itself.
//!
//! Writes go through `runtime::write_file_atomically`, and every mutation
//! re-reads before writing — the engine and the UI both mutate, and a
//! read-modify-write over a whole file is only safe if the read is fresh.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::model::{WorkTask, WorkTaskStatus};

/// Serializes read-modify-write cycles within this process. Cross-process
/// safety is not attempted: a second SomniQ instance on the same project would
/// also be fighting over the worktrees themselves, which this feature does not
/// support either way.
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkTaskFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    tasks: Vec<WorkTask>,
}

const SCHEMA_VERSION: u32 = 1;

fn root() -> PathBuf {
    crate::state::desktop_runtime_dir().join("work-tasks")
}

/// One file per project. The id is already a filesystem-safe slug minted by
/// `projects.rs`, but it is sanitized anyway — it reaches this function from a
/// registry file a user can hand-edit.
fn store_path(project_id: &str) -> PathBuf {
    let safe = project_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe = if safe.is_empty() {
        "unknown".to_string()
    } else {
        safe
    };
    root().join(format!("{safe}.json"))
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn read_at(path: &std::path::Path) -> Vec<WorkTask> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    // A corrupt store is reported as empty rather than as an error: the board
    // is not worth blocking the whole Extensions page over, and the next write
    // rewrites the file. The tasks are recoverable from the worktrees on disk.
    serde_json::from_str::<WorkTaskFile>(&raw)
        .map(|file| file.tasks)
        .unwrap_or_default()
}

fn write_at(path: &std::path::Path, tasks: &[WorkTask]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let file = WorkTaskFile {
        schema_version: SCHEMA_VERSION,
        tasks: tasks.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|error| format!("could not serialize work tasks: {error}"))?;
    runtime::write_file_atomically(path, bytes)
        .map_err(|error| format!("could not write work tasks: {error}"))
}

/// Board order: `sort_order` then id, which is the order the launch queue
/// consumes. The frontend re-sorts its columns by freshness for display; the
/// backend deliberately does not, so "what runs next" stays independent of
/// what the user last touched.
fn sort_tasks(tasks: &mut [WorkTask]) {
    tasks.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub(crate) fn list(project_id: &str) -> Vec<WorkTask> {
    let _guard = STORE_LOCK.lock();
    let mut tasks = read_at(&store_path(project_id));
    sort_tasks(&mut tasks);
    tasks
}

pub(crate) fn get(project_id: &str, task_id: &str) -> Option<WorkTask> {
    list(project_id)
        .into_iter()
        .find(|task| task.id == task_id)
}

pub(crate) fn insert(project_id: &str, task: WorkTask) -> Result<WorkTask, String> {
    let _guard = STORE_LOCK.lock();
    let path = store_path(project_id);
    let mut tasks = read_at(&path);
    if tasks.iter().any(|existing| existing.id == task.id) {
        return Err(format!("work task {} already exists", task.id));
    }
    tasks.push(task.clone());
    sort_tasks(&mut tasks);
    write_at(&path, &tasks)?;
    Ok(task)
}

/// Read-modify-write one task under the store lock.
///
/// `mutate` returning `Err` aborts the write, so a caller can use it as a
/// guard — this is how the engine refuses to settle a generation that a cancel
/// already superseded, without a second round trip through the file.
pub(crate) fn update<F>(project_id: &str, task_id: &str, mutate: F) -> Result<WorkTask, String>
where
    F: FnOnce(&mut WorkTask) -> Result<(), String>,
{
    update_stamped(project_id, task_id, now_ms(), mutate)
}

/// [`update`] with the modification time supplied by the caller.
///
/// Exists for [`reorder`]: the board renders each column freshest-first, so a
/// drag that stamped each card as it was written would hand the frontend
/// descending timestamps and re-sort the cards into the reverse of what the
/// user just arranged. One timestamp for the whole gesture makes them tie, and
/// the tiebreak is the `sort_order` the drag itself wrote.
fn update_stamped<F>(
    project_id: &str,
    task_id: &str,
    updated_at: u64,
    mutate: F,
) -> Result<WorkTask, String>
where
    F: FnOnce(&mut WorkTask) -> Result<(), String>,
{
    let _guard = STORE_LOCK.lock();
    let path = store_path(project_id);
    let mut tasks = read_at(&path);
    let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
        return Err(format!("work task {task_id} was not found"));
    };
    mutate(task)?;
    task.updated_at = updated_at;
    let updated = task.clone();
    sort_tasks(&mut tasks);
    write_at(&path, &tasks)?;
    Ok(updated)
}

/// Renumber board order from the ids the user dragged into place, under one
/// timestamp. Ids not named keep their existing `sort_order`, so a drag on a
/// filtered board cannot reshuffle cards that were not on screen.
pub(crate) fn reorder(project_id: &str, task_ids: &[String]) -> Result<(), String> {
    let stamped = now_ms();
    for (index, task_id) in task_ids.iter().enumerate() {
        update_stamped(project_id, task_id, stamped, |task| {
            task.sort_order = index as i64;
            Ok(())
        })?;
    }
    Ok(())
}

pub(crate) fn remove(project_id: &str, task_id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock();
    let path = store_path(project_id);
    let mut tasks = read_at(&path);
    let before = tasks.len();
    tasks.retain(|task| task.id != task_id);
    if tasks.len() == before {
        return Err(format!("work task {task_id} was not found"));
    }
    write_at(&path, &tasks)
}

/// Tasks the engine should consider launching, in queue order.
pub(crate) fn queued(project_id: &str) -> Vec<WorkTask> {
    list(project_id)
        .into_iter()
        .filter(|task| task.status == WorkTaskStatus::Queued)
        .collect()
}

/// How many tasks of this project currently hold a slot.
pub(crate) fn in_flight_count(project_id: &str) -> usize {
    list(project_id)
        .into_iter()
        .filter(|task| {
            matches!(
                task.status,
                WorkTaskStatus::Preparing | WorkTaskStatus::Running | WorkTaskStatus::Merging
            )
        })
        .count()
}

/// Every project that has a task store, for the engine's sweep.
pub(crate) fn projects_with_tasks() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root()) else {
        return Vec::new();
    };
    // Deduplicated and ordered so a sweep visits projects in a stable sequence
    // rather than in whatever order the directory happens to enumerate.
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("json"))
                .then(|| path.file_stem()?.to_str().map(str::to_string))
                .flatten()
        })
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project id is used as a file name. Anything that could climb out of
    /// the store directory has to be flattened before it gets there.
    #[test]
    fn project_ids_cannot_escape_the_store_directory() {
        for hostile in ["../../evil", "a/b", "..", "c:\\windows"] {
            let path = store_path(hostile);
            assert_eq!(
                path.parent(),
                Some(root().as_path()),
                "escaped for {hostile:?}: {}",
                path.display()
            );
        }
        assert_eq!(store_path("").file_name().unwrap(), "unknown.json");
    }

    /// The launch queue reads `sort_order` then id, deterministically — two
    /// tasks created in the same millisecond must still have a stable order,
    /// or "start the next one" picks differently on every read.
    #[test]
    fn queue_order_is_stable_for_equal_sort_orders() {
        let mut tasks = vec![
            WorkTask::new("b".into(), "B".into(), String::new(), 100),
            WorkTask::new("a".into(), "A".into(), String::new(), 100),
            WorkTask::new("c".into(), "C".into(), String::new(), 50),
        ];
        sort_tasks(&mut tasks);
        let ids = tasks.iter().map(|task| task.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, ["c", "a", "b"]);
    }

    /// A store the user (or a crash) left unparseable must not take the board
    /// down with it.
    #[test]
    fn a_corrupt_store_reads_as_empty_rather_than_failing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("broken.json");
        std::fs::write(&path, "{ not json").expect("write");
        assert!(read_at(&path).is_empty());
        // And a missing file is simply an empty board.
        assert!(read_at(&temp.path().join("absent.json")).is_empty());
    }

    #[test]
    fn a_round_trip_preserves_every_field() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("store.json");
        let mut task = WorkTask::new("t1".into(), "Rewrite section 3".into(), "do it".into(), 7);
        task.run_seq = 4;
        task.status = WorkTaskStatus::Review;
        task.worktree = Some(super::super::model::WorkTaskWorktree {
            path: "/tmp/wt".into(),
            branch: "somniq/task-t1".into(),
            base_branch: "main".into(),
            base_sha: "abc123".into(),
        });
        write_at(&path, std::slice::from_ref(&task)).expect("write");
        assert_eq!(read_at(&path), vec![task]);
    }
}

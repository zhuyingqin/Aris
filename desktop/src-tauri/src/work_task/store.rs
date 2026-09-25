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

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
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
    /// Bumped on every successful write. The board reads it back with the task
    /// list and discards any change event carrying a revision it has already
    /// seen, which is what makes "subscribe, then load" safe: an event that
    /// landed during the load describes a state the load already contains.
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    tasks: Vec<WorkTask>,
}

/// v1 had no `revision`. It reads as 0 and the first write of this process
/// moves it forward, which is exactly right — a board that has not loaded yet
/// has no revision to be stale against.
const SCHEMA_VERSION: u32 = 2;

/// The board's view of a project: its tasks and the revision they were read at.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskSnapshot {
    pub revision: u64,
    pub tasks: Vec<WorkTask>,
}

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

fn read_file_at(path: &std::path::Path) -> WorkTaskFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return WorkTaskFile::default();
    };
    // A corrupt store is reported as empty rather than as an error: the board
    // is not worth blocking the whole Extensions page over, and the next write
    // rewrites the file. The tasks are recoverable from the worktrees on disk.
    serde_json::from_str::<WorkTaskFile>(&raw).unwrap_or_default()
}

#[cfg(test)]
fn read_at(path: &std::path::Path) -> Vec<WorkTask> {
    read_file_at(path).tasks
}

/// Write the tasks back at `revision + 1` and return the revision written.
///
/// The revision comes from the file that was just read under the store lock,
/// never from a cached value: a read-modify-write is only monotonic if the
/// number it increments is the one currently on disk.
fn write_at(
    path: &std::path::Path,
    previous_revision: u64,
    tasks: &[WorkTask],
) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let revision = previous_revision.saturating_add(1);
    let file = WorkTaskFile {
        schema_version: SCHEMA_VERSION,
        revision,
        tasks: tasks.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|error| format!("could not serialize work tasks: {error}"))?;
    runtime::write_file_atomically(path, bytes)
        .map_err(|error| format!("could not write work tasks: {error}"))?;
    Ok(revision)
}

/// The revision each project was last written at, by this process.
///
/// Exists so emitting a change event costs nothing: the event has to carry the
/// revision it describes, and re-reading the whole file to learn a number the
/// write just produced would double every mutation's I/O.
fn revision_cache() -> &'static Mutex<HashMap<String, u64>> {
    static CACHE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_revision(project_id: &str, revision: u64) {
    if let Ok(mut cache) = revision_cache().lock() {
        cache.insert(project_id.to_string(), revision);
    }
}

/// The revision of this project's last write, for the change event.
///
/// Falls back to reading the file when this process has not written yet —
/// a reconcile pass that changed nothing still emits, and an event carrying a
/// revision below the board's would be discarded as stale.
pub(crate) fn current_revision(project_id: &str) -> u64 {
    if let Ok(cache) = revision_cache().lock() {
        if let Some(revision) = cache.get(project_id) {
            return *revision;
        }
    }
    let _guard = STORE_LOCK.lock();
    read_file_at(&store_path(project_id)).revision
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
    snapshot(project_id).tasks
}

/// The tasks and the revision they were read at, in one pass under the lock.
///
/// Reading them separately would let a write slip between the two and hand the
/// board a revision newer than the rows it came with — which then discards the
/// very event describing the rows it is missing.
pub(crate) fn snapshot(project_id: &str) -> WorkTaskSnapshot {
    let _guard = STORE_LOCK.lock();
    let file = read_file_at(&store_path(project_id));
    let mut tasks = file.tasks;
    sort_tasks(&mut tasks);
    WorkTaskSnapshot {
        revision: file.revision,
        tasks,
    }
}

pub(crate) fn get(project_id: &str, task_id: &str) -> Option<WorkTask> {
    list(project_id)
        .into_iter()
        .find(|task| task.id == task_id)
}

pub(crate) fn insert(project_id: &str, task: WorkTask) -> Result<WorkTask, String> {
    let _guard = STORE_LOCK.lock();
    let path = store_path(project_id);
    let file = read_file_at(&path);
    let mut tasks = file.tasks;
    if tasks.iter().any(|existing| existing.id == task.id) {
        return Err(format!("work task {} already exists", task.id));
    }
    tasks.push(task.clone());
    sort_tasks(&mut tasks);
    remember_revision(project_id, write_at(&path, file.revision, &tasks)?);
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
    let file = read_file_at(&path);
    let mut tasks = file.tasks;
    let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
        return Err(format!("work task {task_id} was not found"));
    };
    mutate(task)?;
    task.updated_at = updated_at;
    let updated = task.clone();
    sort_tasks(&mut tasks);
    remember_revision(project_id, write_at(&path, file.revision, &tasks)?);
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
    let file = read_file_at(&path);
    let mut tasks = file.tasks;
    let before = tasks.len();
    tasks.retain(|task| task.id != task_id);
    if tasks.len() == before {
        return Err(format!("work task {task_id} was not found"));
    }
    remember_revision(project_id, write_at(&path, file.revision, &tasks)?);
    Ok(())
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
        .filter(|task| task.status.holds_a_slot())
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
        task.pending_action = Some(super::super::model::WorkTaskPendingAction::Question {
            tool_use_id: "toolu_1".into(),
            header: None,
            question: "Which section?".into(),
            options: vec!["Three".into()],
            asked_at: 11,
        });
        task.stop_reason = Some(super::super::model::WorkTaskStopReason::Pause);
        task.progress_message = Some("Running the model turn".into());
        task.last_heartbeat_at = Some(12);
        write_at(&path, 0, std::slice::from_ref(&task)).expect("write");
        assert_eq!(read_at(&path), vec![task]);
    }

    /// The board discards events whose revision it has already seen, so a
    /// revision that ever repeats or goes backwards makes it drop a real
    /// change. Every write moves it forward by exactly one.
    #[test]
    fn every_write_advances_the_revision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("store.json");
        let task = WorkTask::new("t1".into(), "T".into(), String::new(), 1);

        // A store that does not exist yet is revision 0, not an error.
        assert_eq!(read_file_at(&path).revision, 0);
        for expected in 1..=3 {
            let previous = read_file_at(&path).revision;
            let written = write_at(&path, previous, std::slice::from_ref(&task)).expect("write");
            assert_eq!(written, expected);
            assert_eq!(read_file_at(&path).revision, expected);
        }
    }

    /// A v1 file has no `revision` and no run-state fields. It has to keep its
    /// tasks and start counting from zero rather than read as a corrupt store.
    #[test]
    fn a_v1_store_migrates_without_losing_its_tasks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("v1.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"tasks":[{"id":"t1","title":"Old","prompt":"do it",
               "status":"review","sortOrder":5,"runSeq":2,"createdAt":1,"updatedAt":2}]}"#,
        )
        .expect("write");

        let file = read_file_at(&path);
        assert_eq!(file.revision, 0);
        assert_eq!(file.tasks.len(), 1);
        assert_eq!(file.tasks[0].status, WorkTaskStatus::Review);
        assert!(file.tasks[0].pending_action.is_none());
        assert!(file.tasks[0].stop_reason.is_none());

        // And rewriting it stamps the new schema version.
        write_at(&path, file.revision, &file.tasks).expect("write");
        let raw = std::fs::read_to_string(&path).expect("read");
        assert!(raw.contains("\"schemaVersion\": 2"), "{raw}");
    }
}

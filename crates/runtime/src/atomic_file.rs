use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

const PATH_LOCK_STRIPES: usize = 97;
// Editors and filesystem watchers can deny delete sharing for longer than a
// single read. Keep replacement atomic while allowing a bounded 2.065s grace
// period for those handles to close.
const REPLACE_RETRY_DELAYS: [Duration; 9] = [
    Duration::from_millis(5),
    Duration::from_millis(10),
    Duration::from_millis(20),
    Duration::from_millis(40),
    Duration::from_millis(80),
    Duration::from_millis(160),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
];

static PATH_LOCKS: OnceLock<Vec<Mutex<()>>> = OnceLock::new();

/// Serialize short critical sections that mutate the same path.
///
/// This is process-local by design. It prevents independently scheduled
/// desktop tasks from interleaving writes to one JSONL file while the bounded
/// retry below handles transient locks held by Windows or another process.
pub fn with_path_lock<T>(path: &Path, operation: impl FnOnce() -> T) -> T {
    let locks = PATH_LOCKS.get_or_init(|| (0..PATH_LOCK_STRIPES).map(|_| Mutex::new(())).collect());
    let index = path_lock_index(path);
    let _guard = locks[index]
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
}

/// Hold every process-local path stripe needed by a multi-file transaction.
/// Stripe indexes are sorted and deduplicated before locking, giving all
/// callers one lock order and avoiding self-deadlock when paths share a stripe.
pub(crate) fn with_paths_locked<T>(paths: &[PathBuf], operation: impl FnOnce() -> T) -> T {
    let locks = PATH_LOCKS.get_or_init(|| (0..PATH_LOCK_STRIPES).map(|_| Mutex::new(())).collect());
    let mut indexes = paths
        .iter()
        .map(|path| path_lock_index(path))
        .collect::<Vec<_>>();
    indexes.sort_unstable();
    indexes.dedup();
    let _guards = indexes
        .iter()
        .map(|index| {
            locks[*index]
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        })
        .collect::<Vec<_>>();
    operation()
}

pub fn write_replace(path: &Path, body: impl AsRef<[u8]>) -> io::Result<()> {
    with_path_lock(path, || write_replace_unlocked(path, body.as_ref()))
}

// Call only while holding `with_path_lock(path)` when the surrounding
// operation must remain serialized across a read/repair/write sequence.
pub(crate) fn write_replace_unlocked(path: &Path, body: &[u8]) -> io::Result<()> {
    write_replace_unlocked_checked(path, body, || Ok(()))
}

// Recheck the caller's source precondition immediately before each replacement
// attempt, including retries after another process releases a Windows handle.
// This supplements the process-local lock; it is not a cross-process CAS.
pub(crate) fn write_replace_unlocked_checked(
    path: &Path,
    body: &[u8],
    before_replace: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| atomic_write_error(path, "create_parent", error))?;
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| atomic_write_error(path, "create_temporary", error))?;
    tmp.write_all(body)
        .map_err(|error| atomic_write_error(path, "write_temporary", error))?;
    tmp.as_file()
        .sync_all()
        .map_err(|error| atomic_write_error(path, "sync_temporary", error))?;
    persist_with_retry(tmp, path, before_replace)
}

#[derive(Debug)]
struct AtomicWriteError {
    path: PathBuf,
    stage: &'static str,
    source: io::Error,
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let recovery = if retryable_replace_error(&self.source) {
            "The file or its directory may be locked or access-restricted. Release the file handle or resolve access, then re-read the source and revision before retrying. Do not bypass this failure with an in-place overwrite."
        } else {
            "Check the failing filesystem stage and path, then re-read the current file and revision before retrying."
        };
        let report = serde_json::json!({
            "ok": false,
            "code": "atomic_write_failed",
            "stage": self.stage,
            "filePath": self.path.to_string_lossy(),
            "osErrorCode": self.source.raw_os_error(),
            "message": format!("Atomic file write failed during {} for `{}`: {}", self.stage, self.path.display(), self.source),
            "recoveryHint": recovery,
        });
        write!(formatter, "{report}")
    }
}

impl std::error::Error for AtomicWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

fn atomic_write_error(path: &Path, stage: &'static str, source: io::Error) -> io::Error {
    io::Error::new(
        source.kind(),
        AtomicWriteError {
            path: path.to_path_buf(),
            stage,
            source,
        },
    )
}

fn path_lock_index(path: &Path) -> usize {
    let key = absolute_path_for_lock(path);
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    (hasher.finish() as usize) % PATH_LOCK_STRIPES
}

#[cfg(test)]
pub(crate) fn path_locks_collide(left: &Path, right: &Path) -> bool {
    path_lock_index(left) == path_lock_index(right)
}

fn absolute_path_for_lock(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        crate::execution_current_dir()
            .map(|current| current.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn persist_with_retry(
    mut temporary: tempfile::NamedTempFile,
    path: &Path,
    mut before_replace: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    for delay in REPLACE_RETRY_DELAYS {
        before_replace()?;
        match temporary.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) if retryable_replace_error(&error.error) => {
                temporary = error.file;
                thread::sleep(delay);
            }
            Err(error) => {
                return Err(atomic_write_error(path, "replace_destination", error.error));
            }
        }
    }
    before_replace()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| atomic_write_error(path, "replace_destination", error.error))
}

fn retryable_replace_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(5) | Some(32))
}

#[cfg(test)]
#[path = "tests/atomic_file.rs"]
mod tests;

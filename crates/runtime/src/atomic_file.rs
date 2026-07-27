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
const REPLACE_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(5),
    Duration::from_millis(10),
    Duration::from_millis(20),
    Duration::from_millis(40),
    Duration::from_millis(80),
    Duration::from_millis(160),
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

pub fn write_replace(path: &Path, body: impl AsRef<[u8]>) -> io::Result<()> {
    with_path_lock(path, || write_replace_unlocked(path, body.as_ref()))
}

// Call only while holding `with_path_lock(path)` when the surrounding
// operation must remain serialized across a read/repair/write sequence.
pub(crate) fn write_replace_unlocked(path: &Path, body: &[u8]) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(body)?;
    tmp.as_file().sync_all()?;
    persist_with_retry(tmp, path)
}

fn path_lock_index(path: &Path) -> usize {
    let key = absolute_path_for_lock(path);
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    (hasher.finish() as usize) % PATH_LOCK_STRIPES
}

fn absolute_path_for_lock(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn persist_with_retry(mut temporary: tempfile::NamedTempFile, path: &Path) -> io::Result<()> {
    for delay in REPLACE_RETRY_DELAYS {
        match temporary.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) if retryable_replace_error(&error.error) => {
                temporary = error.file;
                thread::sleep(delay);
            }
            Err(error) => return Err(error.error),
        }
    }
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn retryable_replace_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(5) | Some(32))
}

#[cfg(test)]
#[path = "tests/atomic_file.rs"]
mod tests;

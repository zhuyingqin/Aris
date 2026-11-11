//! A private Git repository for a project folder that is not one.
//!
//! A work task isolates its writes in a Git worktree and lands them with a
//! two-stage merge, and that isolation is what lets the task's writes be
//! auto-approved (see [`super::permission`]). Most research projects, though,
//! are plain folders: before this module every task and every scheduled run in
//! such a project failed at launch with "work tasks need a Git repository".
//!
//! The fix keeps the isolation instead of dropping it. SomniQ gives the folder
//! a *bare* repository of its own under
//! `<config>/desktop-runtime/work-task-shadow/`, and runs that repository with
//! the folder as its working tree (`--git-dir=<shadow> --work-tree=<folder>`,
//! the arrangement a bare "dotfiles" repository uses). From there the task flow
//! is the ordinary one:
//!
//! 1. A snapshot commits the folder's current contents to the shadow's
//!    [`SNAPSHOT_BRANCH`].
//! 2. The task's checkout is a linked worktree of the shadow, cut from that
//!    snapshot. Inside it Git behaves exactly as in any other task checkout, so
//!    committing, the review snapshot and the patch need nothing special.
//! 3. Accepting takes a fresh snapshot (so edits the user made meanwhile are
//!    the base the task merges with), merges it into the task checkout, then
//!    fast-forwards the snapshot branch — which writes the accepted files into
//!    the folder. Git refuses that last step rather than overwrite a file it
//!    does not track, so a file left out of the snapshot can never be
//!    clobbered by an accept.
//!
//! Nothing is written into the folder by this module: no `.git`, no
//! `.gitignore`. The folder stays as un-versioned as the user left it.
//!
//! The snapshot is bounded. Caches (`node_modules/`, virtual environments, …),
//! SomniQ's own runtime data apart from the deliverable roots, Office lock
//! files and database sidecars are excluded; so is any single file over
//! [`MAX_FILE_BYTES`] and any file that cannot be read (held open exclusively
//! by another program). A folder that is still over [`MAX_FILES`] or
//! [`MAX_TOTAL_BYTES`] is refused with the reason, rather than half-copied.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use sha2::{Digest, Sha256};

use super::worktree::ProjectRepo;

/// The branch the shadow repository's snapshots are committed to, and the base
/// every task in the folder is cut from and lands on.
pub(crate) const SNAPSHOT_BRANCH: &str = "somniq/snapshot";

/// A single file larger than this is left out of the snapshot. Datasets and
/// model weights are what this is for: copying them into every task checkout
/// would cost more disk than the task is worth, and a task that needs them is
/// told they are absent (see the task prompt).
pub(crate) const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Upper bound on what one snapshot may copy, after exclusions.
pub(crate) const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Upper bound on how many files one snapshot may copy, after exclusions.
pub(crate) const MAX_FILES: usize = 50_000;

/// Bumped when the repository settings below change, so an existing shadow is
/// reconfigured once instead of on every task.
const LAYOUT_VERSION: &str = "1";

/// Always outside a snapshot, in `info/exclude` syntax.
///
/// `.somniq/` is SomniQ's runtime directory as well as the home of a
/// project's papers, decks and reports. Only the deliverable roots are kept —
/// the same roots a Git project's task commit keeps — so session ledgers,
/// caches and scratch files never travel into a checkout and back.
fn exclude_patterns() -> Vec<String> {
    let data = tools::layout::PROJECT_DATA_DIR;
    let mut patterns = vec![
        "# Written by SomniQ. Paths excluded from a project folder's snapshot.".to_string(),
        format!("/{data}/*"),
    ];
    for subdir in [
        tools::layout::PAPERS_DIR,
        tools::layout::SLIDES_DIR,
        tools::layout::POSTER_DIR,
        tools::layout::WEB_DIR,
        tools::layout::NOTEBOOKS_DIR,
        tools::layout::REPORTS_DIR,
        tools::layout::EXPERIMENTS_DIR,
    ] {
        patterns.push(format!("!/{data}/{subdir}/"));
    }
    patterns.extend(
        [
            // A nested repository is somebody else's history; Git would only
            // record a pointer to it anyway.
            ".git/",
            "node_modules/",
            ".venv/",
            "venv/",
            "__pycache__/",
            ".ipynb_checkpoints/",
            ".mypy_cache/",
            ".pytest_cache/",
            ".ruff_cache/",
            ".tox/",
            // Office and LibreOffice owner files: present only while a
            // document is open, and locked for exactly that long.
            "~$*",
            ".~lock.*#",
            // SQLite sidecars: copying one without its database (or the
            // database without it) produces a copy that is not the database.
            "*.db-wal",
            "*.db-shm",
            "*.db-journal",
            "*.sqlite-wal",
            "*.sqlite-shm",
            "*.sqlite-journal",
            "Thumbs.db",
            "desktop.ini",
            ".DS_Store",
        ]
        .into_iter()
        .map(str::to_string),
    );
    patterns
}

/// The repository settings that make a snapshot faithful and a commit
/// impossible to derail from the user's global Git configuration.
fn settings(git_dir: &Path) -> Vec<(&'static str, String)> {
    vec![
        // Byte-for-byte: no line-ending conversion in either direction.
        ("core.autocrlf", "false".to_string()),
        ("core.safecrlf", "false".to_string()),
        ("core.longpaths", "true".to_string()),
        ("core.fsmonitor", "false".to_string()),
        // A global hooks path or signing setting would otherwise apply to
        // commits the user never makes and cannot answer prompts for.
        (
            "core.hooksPath",
            git_dir.join("hooks").to_string_lossy().into_owned(),
        ),
        ("commit.gpgsign", "false".to_string()),
        ("tag.gpgsign", "false".to_string()),
        // A plain-folder user often has no Git identity configured at all.
        ("user.name", "SomniQ".to_string()),
        ("user.email", "work-tasks@somniq.invalid".to_string()),
    ]
}

/// Serialises every shadow operation in the process.
///
/// A snapshot rewrites the shadow's index; a task launch and an accept in the
/// same folder must not interleave theirs. One lock for all shadows rather
/// than one per folder: these are short, and a global one cannot deadlock
/// against the per-project merge lock taken outside it.
pub(crate) fn lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn shadow_root() -> PathBuf {
    crate::state::desktop_runtime_dir().join("work-task-shadow")
}

/// Where the shadow repository for `project` lives.
///
/// Keyed by the folder's path, so the same folder registered twice shares one
/// history, and a readable prefix so a person browsing the directory can tell
/// which folder each one belongs to.
pub(crate) fn git_dir_for(project: &Path) -> PathBuf {
    let mut normalized = project.to_string_lossy().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized = normalized.to_lowercase();
    }
    let digest = Sha256::digest(normalized.as_bytes());
    let hash = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let label = project
        .file_name()
        .map(|name| {
            name.to_string_lossy()
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
                })
                .take(32)
                .collect::<String>()
        })
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "project".to_string());
    shadow_root().join(format!("{label}-{hash}.git"))
}

/// Create (or bring up to date) the shadow repository for a plain folder.
pub(crate) fn prepare(project: &Path) -> Result<ProjectRepo, String> {
    if !project.is_dir() {
        return Err(format!(
            "the project folder does not exist: {}",
            project.display()
        ));
    }
    let git_dir = git_dir_for(project);
    if !git_dir.join("HEAD").is_file() {
        init_bare(&git_dir)?;
    }
    let repo = ProjectRepo::Shadow {
        git_dir: git_dir.clone(),
        work_tree: project.to_path_buf(),
    };
    configure(&repo, &git_dir)?;
    Ok(repo)
}

fn init_bare(git_dir: &Path) -> Result<(), String> {
    let parent = git_dir
        .parent()
        .ok_or_else(|| "the shadow repository has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let output = crate::process::hidden_command("git")
        .current_dir(parent)
        .arg("init")
        .arg("--bare")
        .arg("--quiet")
        .arg(git_dir)
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => super::worktree::GIT_MISSING.to_string(),
            _ => format!("could not run Git: {error}"),
        })?;
    if !output.status.success() {
        return Err(format!(
            "Git could not create the private repository for this folder: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn configure(repo: &ProjectRepo, git_dir: &Path) -> Result<(), String> {
    let info = git_dir.join("info");
    fs::create_dir_all(&info)
        .map_err(|error| format!("could not create {}: {error}", info.display()))?;
    // Rewritten every time: they are tiny, and a policy change then reaches
    // every existing shadow on its next task.
    let mut exclude = exclude_patterns().join("\n");
    exclude.push('\n');
    write_if_changed(&info.join("exclude"), exclude.as_bytes())?;
    // No conversion or filtering of any kind, whatever `.gitattributes` the
    // folder happens to contain: what the task sees is what is on disk.
    write_if_changed(
        &info.join("attributes"),
        b"* -text -filter -ident -working-tree-encoding\n",
    )?;

    let marker = git_dir.join("somniq-shadow-layout");
    if fs::read_to_string(&marker).ok().as_deref() == Some(LAYOUT_VERSION) {
        return Ok(());
    }
    for (key, value) in settings(git_dir) {
        repo.checked(&["config", key, &value], "configure the folder's private repository")?;
    }
    let reference = format!("refs/heads/{SNAPSHOT_BRANCH}");
    repo.checked(
        &["symbolic-ref", "HEAD", &reference],
        "point the folder's private repository at its snapshot branch",
    )?;
    fs::write(&marker, LAYOUT_VERSION)
        .map_err(|error| format!("could not write {}: {error}", marker.display()))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    fs::write(path, bytes).map_err(|error| format!("could not write {}: {error}", path.display()))
}

/// What one snapshot recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    /// The snapshot branch's commit after the snapshot.
    pub head: String,
    /// Files present in the folder but left out for size or because they could
    /// not be read. Already-excluded caches are not listed.
    pub omitted: Vec<String>,
}

/// Commit the folder's current contents to the snapshot branch.
///
/// The index is updated by explicit path list rather than `add -A`, because
/// the size and readability limits have to be applied before Git hashes
/// anything: `add -A` on a folder holding a dataset would copy the dataset
/// into the shadow before any limit could intervene.
///
/// Callers hold [`lock`].
pub(crate) fn snapshot(repo: &ProjectRepo) -> Result<Snapshot, String> {
    let ProjectRepo::Shadow { git_dir, work_tree } = repo else {
        return Err("only a plain project folder has a snapshot".to_string());
    };
    let candidates = nul_list(&repo.checked_bytes(
        &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        "list the project folder's files",
    )?);
    let tracked = nul_list(&repo.checked_bytes(
        &["ls-files", "-z", "--cached"],
        "list the files of the previous snapshot",
    )?);

    let mut keep = BTreeSet::new();
    let mut omitted = Vec::new();
    let mut total = 0_u64;
    for path in candidates {
        let full = work_tree.join(&path);
        // Gone (deleted since the last snapshot), a directory (a nested
        // repository), or a link: not something to copy.
        let Ok(metadata) = fs::symlink_metadata(&full) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES || fs::File::open(&full).is_err() {
            omitted.push(path);
            continue;
        }
        total = total.saturating_add(metadata.len());
        keep.insert(path);
        if keep.len() > MAX_FILES || total > MAX_TOTAL_BYTES {
            return Err(too_large(keep.len(), total));
        }
    }

    let pathspec = git_dir.join("somniq-snapshot-paths");
    let dropped = tracked.difference(&keep).cloned().collect::<Vec<_>>();
    if !dropped.is_empty() {
        write_pathspec(&pathspec, &dropped)?;
        repo.checked(
            &[
                "rm",
                "--cached",
                "--quiet",
                "--ignore-unmatch",
                &pathspec_arg(&pathspec),
                "--pathspec-file-nul",
            ],
            "drop deleted files from the folder's snapshot",
        )?;
    }
    if !keep.is_empty() {
        write_pathspec(&pathspec, &keep.iter().cloned().collect::<Vec<_>>())?;
        repo.checked(
            &[
                "add",
                &pathspec_arg(&pathspec),
                "--pathspec-file-nul",
            ],
            "snapshot the project folder",
        )?;
    }
    let _ = fs::remove_file(&pathspec);

    let unborn = !repo
        .run(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?
        .status
        .success();
    let changed = !repo.run(&["diff", "--cached", "--quiet"])?.status.success();
    if unborn || changed {
        repo.checked(
            &[
                "commit",
                "--no-verify",
                "--allow-empty",
                "--quiet",
                "-m",
                "SomniQ snapshot of the project folder",
            ],
            "record the project folder's snapshot",
        )?;
    }
    let head = repo.checked(&["rev-parse", "HEAD"], "resolve the folder's snapshot")?;
    omitted.sort();
    Ok(Snapshot { head, omitted })
}

fn too_large(files: usize, bytes: u64) -> String {
    format!(
        "this project folder is too large to copy into an isolated task checkout: more than \
         {} files or {} MB remain after leaving out caches and files over {} MB (counted so far: \
         {files} files, {} MB). Move bulky data out of the folder, or make the folder a Git \
         repository so tasks can use Git's own checkout instead",
        MAX_FILES,
        MAX_TOTAL_BYTES / (1024 * 1024),
        MAX_FILE_BYTES / (1024 * 1024),
        bytes / (1024 * 1024),
    )
}

fn nul_list(bytes: &[u8]) -> BTreeSet<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

fn write_pathspec(path: &Path, entries: &[String]) -> Result<(), String> {
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend_from_slice(entry.as_bytes());
        bytes.push(0);
    }
    fs::write(path, bytes).map_err(|error| format!("could not write {}: {error}", path.display()))
}

fn pathspec_arg(path: &Path) -> String {
    let mut arg = OsString::from("--pathspec-from-file=");
    arg.push(path);
    arg.to_string_lossy().into_owned()
}

#[cfg(test)]
#[path = "../tests/work_task_shadow.rs"]
mod tests;

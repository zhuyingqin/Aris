//! SomniQ's managed store for work-task deliverables.
//!
//! ## Why this exists
//!
//! A work task produces three kinds of file, and before this module they were
//! two:
//!
//! - **Runtime data** — session ledgers, caches, tool scratch. Never committed,
//!   never shown. [`worktree::commit_all`](super::worktree::commit_all) already
//!   strips it.
//! - **Project modifications** — source, an existing paper, configuration.
//!   Committed to the task branch, reviewed as a diff, merged on acceptance.
//!   This is what the whole worktree design is for.
//! - **Standalone deliverables** — a report, a deck, an export. Asked for by
//!   the user, related to the project only by subject.
//!
//! The third used to be forced through the second: a generated PDF became a
//! commit under a hidden directory, and the only way to get it was to merge a
//! branch into your repository. That is the wrong shape for "write me a
//! report", and it is why `.somniq/` ended up being both SomniQ's runtime root
//! and the user's deliverable folder.
//!
//! Here the task writes them to a staging directory inside its own checkout,
//! and this module copies them out into
//! `<config>/desktop-runtime/work-task-artifacts/<project>/<task>/` when the
//! run settles. Nothing about them touches Git.
//!
//! ## What is deliberately NOT done
//!
//! Existing `.somniq/papers`, `.somniq/slides` and friends are left exactly
//! where they are. They are committed and merged as before. Moving a user's
//! accumulated output because the storage model changed would be a data
//! migration performed without asking.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::model::WorkTaskArtifact;
use super::store;

/// Root of the managed store. Outside every project, for the same reason the
/// task store is: a per-worktree copy would be merged into itself.
fn root() -> PathBuf {
    crate::state::desktop_runtime_dir().join("work-task-artifacts")
}

/// Flatten anything that could climb out of the store. Both segments reach
/// this from files a user can hand-edit.
fn safe_segment(value: &str) -> String {
    let mapped = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if mapped.is_empty() {
        "unknown".to_string()
    } else {
        mapped
    }
}

pub(crate) fn task_dir(project_id: &str, task_id: &str) -> PathBuf {
    root()
        .join(safe_segment(project_id))
        .join(safe_segment(task_id))
}

/// Where a task writes deliverables inside its own checkout.
pub(crate) fn staging_dir(worktree: &Path) -> PathBuf {
    tools::layout::task_output_dir_at(worktree)
}

fn sha256_of(path: &Path) -> Result<(String, u64), String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Every file under `dir`, as paths relative to it, depth-first and sorted.
///
/// Sorted so a deliverable made of several files imports in a stable order and
/// two runs of the same task produce the same ids.
fn collect_files(dir: &Path, prefix: &str, into: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    for name in names {
        let path = dir.join(&name);
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            collect_files(&path, &relative, into);
        } else if path.is_file() {
            into.push(relative);
        }
    }
}

/// An id that is stable for the same deliverable across re-imports.
///
/// Derived from the path rather than minted fresh, so a retried import
/// replaces its predecessor instead of leaving two rows for one file — which
/// matters because an interrupted import is retried on the next settle.
fn artifact_id(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

/// Copy everything the task staged into the managed store.
///
/// Every file is written to a temporary name and renamed into place, then read
/// back and hashed. A deliverable that arrives truncated is worse than one that
/// does not arrive, because nothing downstream would say so — and the caller
/// treats an error here as a failed run, keeping the worktree so the import can
/// be retried rather than losing the work.
pub(crate) fn import(
    project_id: &str,
    task_id: &str,
    worktree: &Path,
) -> Result<Vec<WorkTaskArtifact>, String> {
    let staging = staging_dir(worktree);
    if !staging.is_dir() {
        return Ok(Vec::new());
    }
    let mut relative_paths = Vec::new();
    collect_files(&staging, "", &mut relative_paths);
    if relative_paths.is_empty() {
        return Ok(Vec::new());
    }

    let destination_root = task_dir(project_id, task_id);
    std::fs::create_dir_all(&destination_root).map_err(|error| {
        format!(
            "could not create the artifact store at {}: {error}",
            destination_root.display()
        )
    })?;

    let now = store::now_ms();
    let mut artifacts = Vec::new();
    for relative_path in relative_paths {
        let source = staging.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let destination = destination_root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        let (expected, _) = sha256_of(&source)?;
        let temporary = destination.with_extension("somniq-partial");
        std::fs::copy(&source, &temporary).map_err(|error| {
            format!(
                "could not copy {} into the artifact store: {error}",
                source.display()
            )
        })?;
        std::fs::rename(&temporary, &destination).map_err(|error| {
            format!("could not finish writing {}: {error}", destination.display())
        })?;
        // Read back rather than trusting the copy. This is the only check
        // between "the model wrote a PDF" and "the user opens a PDF".
        let (actual, byte_size) = sha256_of(&destination)?;
        if actual != expected {
            let _ = std::fs::remove_file(&destination);
            return Err(format!(
                "{relative_path} was corrupted while being saved, so it was discarded rather than \
                 offered as a result"
            ));
        }
        artifacts.push(WorkTaskArtifact {
            id: artifact_id(&relative_path),
            title: relative_path
                .rsplit('/')
                .next()
                .unwrap_or(&relative_path)
                .to_string(),
            relative_path,
            managed_path: destination.to_string_lossy().to_string(),
            exported_path: None,
            byte_size,
            sha256: actual,
            created_at: now,
        });
    }
    Ok(artifacts)
}

/// Copy one artifact out to a path the user chose.
pub(crate) fn export(artifact: &WorkTaskArtifact, destination: &Path) -> Result<String, String> {
    let source = PathBuf::from(&artifact.managed_path);
    if !source.is_file() {
        return Err(format!(
            "this deliverable is no longer in SomniQ's store ({})",
            artifact.managed_path
        ));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    std::fs::copy(&source, destination)
        .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    let (actual, _) = sha256_of(destination)?;
    if actual != artifact.sha256 {
        return Err(format!(
            "{} did not survive the copy intact and may be truncated",
            destination.display()
        ));
    }
    Ok(destination.to_string_lossy().to_string())
}

/// Remove a task's whole artifact directory. Used when the card is deleted.
pub(crate) fn discard(project_id: &str, task_id: &str) {
    let _ = std::fs::remove_dir_all(task_dir(project_id, task_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        _serial: std::sync::MutexGuard<'static, ()>,
        worktree: PathBuf,
    }

    fn fixture() -> Fixture {
        let serial = crate::test_env_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let temp = tempfile::tempdir().expect("tempdir");
        std::env::set_var("ARIS_CONFIG_ROOT", temp.path().join("config"));
        let worktree = temp.path().join("tree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        Fixture {
            _temp: temp,
            _serial: serial,
            worktree,
        }
    }

    fn stage(fixture: &Fixture, relative: &str, contents: &[u8]) {
        let path = staging_dir(&fixture.worktree).join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        std::fs::write(path, contents).expect("write");
    }

    /// A task with nothing staged must not create an empty directory or a
    /// phantom artifact — "no deliverables" has to stay distinguishable from
    /// "deliverables that failed to import".
    #[test]
    fn a_task_that_staged_nothing_imports_nothing() {
        let fixture = fixture();
        assert!(import("proj", "task", &fixture.worktree)
            .expect("import")
            .is_empty());
        // And an empty staging directory is still nothing.
        std::fs::create_dir_all(staging_dir(&fixture.worktree)).expect("dir");
        assert!(import("proj", "task", &fixture.worktree)
            .expect("import")
            .is_empty());
    }

    /// The core promise: a deliverable reaches the store byte-for-byte, and is
    /// reachable without touching the repository.
    #[test]
    fn deliverables_are_copied_out_and_verified() {
        let fixture = fixture();
        stage(&fixture, "report.pdf", b"%PDF-1.7\x00\x01binary\n");
        stage(&fixture, "figures/plot.png", b"\x89PNG\r\n\x1a\n data");

        let artifacts = import("proj", "task", &fixture.worktree).expect("import");
        assert_eq!(artifacts.len(), 2);

        let report = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "report.pdf")
            .expect("report");
        assert_eq!(report.title, "report.pdf");
        assert_eq!(report.byte_size, b"%PDF-1.7\x00\x01binary\n".len() as u64);
        assert_eq!(
            std::fs::read(&report.managed_path).expect("read back"),
            b"%PDF-1.7\x00\x01binary\n",
        );

        // A nested deliverable keeps its shape rather than being flattened: a
        // deck and its figures are one thing in several files.
        let plot = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "figures/plot.png")
            .expect("plot");
        assert_eq!(plot.title, "plot.png");
        assert!(Path::new(&plot.managed_path).is_file());

        // No partial files are left behind by a successful import.
        let leftovers = walkdir(&task_dir("proj", "task"));
        assert!(
            !leftovers.iter().any(|path| path.contains("somniq-partial")),
            "partial files survived: {leftovers:?}",
        );
    }

    /// An import that runs twice — which is what a retried settle does — must
    /// replace its own rows rather than stack up a second copy of everything.
    #[test]
    fn re_importing_the_same_deliverable_keeps_one_row() {
        let fixture = fixture();
        stage(&fixture, "report.pdf", b"first\n");
        let first = import("proj", "task", &fixture.worktree).expect("import");

        stage(&fixture, "report.pdf", b"second, longer\n");
        let second = import("proj", "task", &fixture.worktree).expect("re-import");

        assert_eq!(second.len(), 1);
        assert_eq!(
            first[0].id, second[0].id,
            "the id must be stable for the same path",
        );
        assert_ne!(first[0].sha256, second[0].sha256);
        assert_eq!(
            std::fs::read(&second[0].managed_path).expect("read back"),
            b"second, longer\n",
        );
    }

    /// Export verifies as well. A truncated copy that reported success would
    /// be the one failure the user could not detect.
    #[test]
    fn exporting_verifies_what_it_wrote() {
        let fixture = fixture();
        stage(&fixture, "report.pdf", b"contents\n");
        let artifacts = import("proj", "task", &fixture.worktree).expect("import");
        let destination = fixture._temp.path().join("out/Report.pdf");

        let written = export(&artifacts[0], &destination).expect("export");
        assert_eq!(written, destination.to_string_lossy());
        assert_eq!(std::fs::read(&destination).expect("read"), b"contents\n");

        // A store entry that has gone missing says so rather than writing an
        // empty file at the destination.
        let mut broken = artifacts[0].clone();
        broken.managed_path = fixture._temp.path().join("gone.pdf").to_string_lossy().into();
        let error = export(&broken, &destination).expect_err("must refuse");
        assert!(error.contains("no longer in SomniQ's store"), "{error}");
    }

    /// Ids become directory names, and both reach this from files a user can
    /// hand-edit.
    #[test]
    fn store_paths_cannot_escape_the_artifact_root() {
        let _fixture = fixture();
        for hostile in ["../../evil", "a/b", "..", ""] {
            let path = task_dir(hostile, hostile);
            assert!(
                path.starts_with(root()),
                "escaped for {hostile:?}: {}",
                path.display()
            );
            assert_eq!(path.components().count(), root().components().count() + 2);
        }
    }

    fn walkdir(root: &Path) -> Vec<String> {
        let mut found = Vec::new();
        collect_files(root, "", &mut found);
        found
    }
}

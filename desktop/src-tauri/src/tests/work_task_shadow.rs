//! The private repository a plain project folder gets for its work tasks.
//!
//! Real Git, real folders, under an isolated `ARIS_CONFIG_ROOT` and the
//! process-wide test lock (the shadow root resolves through the config root).

use std::path::{Path, PathBuf};

use super::{git_dir_for, prepare, snapshot, MAX_FILE_BYTES, SNAPSHOT_BRANCH};
use crate::work_task::worktree::{self, ProjectRepo};

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

struct Fixture {
    temp: tempfile::TempDir,
    _config: EnvGuard,
    _serial: std::sync::MutexGuard<'static, ()>,
    folder: PathBuf,
}

fn fixture() -> Fixture {
    let serial = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let temp = tempfile::tempdir().expect("tempdir");
    let config = EnvGuard {
        key: "ARIS_CONFIG_ROOT",
        previous: std::env::var_os("ARIS_CONFIG_ROOT"),
    };
    std::env::set_var("ARIS_CONFIG_ROOT", temp.path().join("config"));
    let folder = temp.path().join("论文 project");
    std::fs::create_dir_all(&folder).expect("folder");
    Fixture {
        temp,
        _config: config,
        _serial: serial,
        folder,
    }
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    std::fs::write(path, bytes).expect("write");
}

fn tracked(repo: &ProjectRepo) -> Vec<String> {
    let listed = repo
        .checked(&["ls-files", "--cached"], "list")
        .expect("ls-files");
    listed.lines().map(str::to_string).collect()
}

/// The point of the design: the folder stays a plain folder.
#[test]
fn a_plain_folder_gets_a_private_repository_and_no_git_directory() {
    let fixture = fixture();
    write(&fixture.folder, "draft.tex", b"\\section{A}\r\n");

    let repo = prepare(&fixture.folder).expect("prepare");
    let taken = snapshot(&repo).expect("snapshot");

    assert!(!fixture.folder.join(".git").exists(), "nothing may be written into the folder");
    assert!(!worktree::is_git_repository(&fixture.folder));
    let ProjectRepo::Shadow { git_dir, .. } = &repo else {
        panic!("a plain folder gets a shadow");
    };
    assert!(git_dir.starts_with(fixture.temp.path().join("config")));
    assert_eq!(
        repo.checked(&["symbolic-ref", "--short", "HEAD"], "head").expect("head"),
        SNAPSHOT_BRANCH
    );
    assert_eq!(tracked(&repo), vec!["draft.tex".to_string()]);
    assert!(!taken.head.is_empty());
}

/// What a task sees must be what is on disk: no line-ending conversion, even
/// with a `.gitattributes` asking for one, and whatever the user's global
/// `core.autocrlf` says.
#[test]
fn a_snapshot_is_byte_for_byte() {
    let fixture = fixture();
    write(&fixture.folder, ".gitattributes", b"* text=auto eol=lf\n");
    write(&fixture.folder, "crlf.txt", b"one\r\ntwo\r\n");
    write(&fixture.folder, "mixed.txt", b"lf\ncrlf\r\n");

    let repo = prepare(&fixture.folder).expect("prepare");
    snapshot(&repo).expect("snapshot");

    for file in ["crlf.txt", "mixed.txt"] {
        let stored = repo
            .run(&["cat-file", "blob", &format!("HEAD:{file}")])
            .expect("cat-file")
            .stdout;
        assert_eq!(
            stored,
            std::fs::read(fixture.folder.join(file)).expect("read"),
            "{file} changed on the way into the snapshot"
        );
    }
}

/// Caches and SomniQ's runtime data stay out; the deliverable roots under
/// `.somniq/` stay in, because a research task works on the library.
#[test]
fn the_snapshot_keeps_deliverables_and_leaves_out_caches_and_runtime_data() {
    let fixture = fixture();
    write(&fixture.folder, "notes.md", b"notes\n");
    write(&fixture.folder, ".somniq/papers/lit.pdf", b"%PDF-1.7\n");
    write(&fixture.folder, ".somniq/reports/week.md", b"report\n");
    write(&fixture.folder, ".somniq/sessions/s1.json", b"{}\n");
    write(&fixture.folder, ".somniq/tmp/scratch.txt", b"tmp\n");
    write(&fixture.folder, ".somniq/task-output/out.md", b"out\n");
    write(&fixture.folder, "node_modules/dep/index.js", b"x\n");
    write(&fixture.folder, ".venv/lib/site.py", b"x\n");
    write(&fixture.folder, "~$draft.docx", b"owner\n");
    write(&fixture.folder, "library.db-wal", b"wal\n");

    let repo = prepare(&fixture.folder).expect("prepare");
    snapshot(&repo).expect("snapshot");

    let mut files = tracked(&repo);
    files.sort();
    assert_eq!(
        files,
        vec![
            ".somniq/papers/lit.pdf".to_string(),
            ".somniq/reports/week.md".to_string(),
            "notes.md".to_string(),
        ]
    );
}

/// A dataset over the per-file limit is left out and reported, not copied
/// into every task checkout.
#[test]
fn an_oversized_file_is_left_out_and_reported() {
    let fixture = fixture();
    write(&fixture.folder, "analysis.py", b"print(1)\n");
    let big = std::fs::File::create(fixture.folder.join("weights.bin")).expect("big");
    big.set_len(MAX_FILE_BYTES + 1).expect("size");
    drop(big);

    let repo = prepare(&fixture.folder).expect("prepare");
    let taken = snapshot(&repo).expect("snapshot");

    assert_eq!(tracked(&repo), vec!["analysis.py".to_string()]);
    assert_eq!(taken.omitted, vec!["weights.bin".to_string()]);
}

/// Successive snapshots follow the folder: an edit is a new commit, a delete
/// drops the file, and nothing changed means no new commit at all.
#[test]
fn successive_snapshots_follow_edits_and_deletions() {
    let fixture = fixture();
    write(&fixture.folder, "keep.md", b"v1\n");
    write(&fixture.folder, "gone.md", b"bye\n");
    let repo = prepare(&fixture.folder).expect("prepare");
    let first = snapshot(&repo).expect("first");

    let unchanged = snapshot(&repo).expect("unchanged");
    assert_eq!(unchanged.head, first.head, "no change, no commit");

    write(&fixture.folder, "keep.md", b"v2\n");
    std::fs::remove_file(fixture.folder.join("gone.md")).expect("delete");
    let second = snapshot(&repo).expect("second");
    assert_ne!(second.head, first.head);
    assert_eq!(tracked(&repo), vec!["keep.md".to_string()]);
    let stored = repo
        .run(&["cat-file", "blob", "HEAD:keep.md"])
        .expect("cat-file")
        .stdout;
    assert_eq!(stored, b"v2\n");
}

/// An empty folder still needs a commit to cut a checkout from.
#[test]
fn an_empty_folder_still_yields_a_base_commit() {
    let fixture = fixture();
    let repo = prepare(&fixture.folder).expect("prepare");
    let taken = snapshot(&repo).expect("snapshot");
    assert!(!taken.head.is_empty());
    assert!(tracked(&repo).is_empty());
}

/// One folder, one history: the location is a function of the path, so the
/// same folder found again (a restart) finds its repository, and two folders
/// with the same name do not share one.
#[test]
fn the_private_repository_is_keyed_by_folder_path() {
    let fixture = fixture();
    let other = fixture.temp.path().join("elsewhere").join("论文 project");
    assert_eq!(git_dir_for(&fixture.folder), git_dir_for(&fixture.folder));
    assert_ne!(git_dir_for(&fixture.folder), git_dir_for(&other));
    let name = git_dir_for(&fixture.folder)
        .file_name()
        .expect("name")
        .to_string_lossy()
        .into_owned();
    assert!(name.starts_with("project-"), "readable, ASCII-only prefix: {name}");
    assert!(name.ends_with(".git"));
}

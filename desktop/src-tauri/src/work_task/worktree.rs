//! Git worktree lifecycle for work tasks.
//!
//! Aris had no worktree support at all before this module: `git.rs` operates on
//! one checkout. A task gets its own checkout and its own branch so the agent
//! can write freely without touching what the user is editing — which is also
//! what makes it safe to auto-approve the task's writes instead of blocking on
//! a permission prompt nobody is there to answer (see [`super::permission`]).
//!
//! Layout: worktrees live under `<config>/desktop-runtime/work-trees/<project-id>/<task-id>`,
//! outside the repository, so `git status` in the user's checkout never shows
//! them and no `.gitignore` entry is required.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Output;

use super::model::{WorkTaskChanges, WorkTaskWorktree};

/// Branch namespace for task branches. Prefixed so `git branch` in the user's
/// own checkout groups them, and so a stale branch is identifiable as ours.
const BRANCH_PREFIX: &str = "somniq/task";

/// User-facing artifact roots inside SomniQ's otherwise runtime-owned data
/// directory. These are the paths advertised to the agent by
/// `tools::layout`, so excluding all of `.somniq/` would throw away the very
/// papers, decks, reports, and experiment outputs a research task produces.
const REVIEWABLE_PROJECT_DATA_SUBDIRS: &[&str] = &[
    tools::layout::PAPERS_DIR,
    tools::layout::SLIDES_DIR,
    tools::layout::POSTER_DIR,
    tools::layout::WEB_DIR,
    tools::layout::NOTEBOOKS_DIR,
    tools::layout::REPORTS_DIR,
    tools::layout::EXPERIMENTS_DIR,
];

fn git(workspace: &Path) -> std::process::Command {
    let mut command = crate::process::hidden_command("git");
    command
        .current_dir(workspace)
        .arg("--literal-pathspecs")
        .args(["-c", "color.ui=false"])
        .args(["-c", "core.quotepath=false"]);
    command
}

fn run(workspace: &Path, args: &[&str]) -> Result<Output, String> {
    if !workspace.is_dir() {
        return Err(format!("directory does not exist: {}", workspace.display()));
    }
    git(workspace)
        .args(args)
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                "Git is not installed or is not available on PATH".to_string()
            }
            _ => format!("could not run Git: {error}"),
        })
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn checked(workspace: &Path, args: &[&str], action: &str) -> Result<String, String> {
    let output = run(workspace, args)?;
    if output.status.success() {
        return Ok(text(&output.stdout));
    }
    let detail = {
        let stderr = text(&output.stderr);
        if stderr.is_empty() {
            text(&output.stdout)
        } else {
            stderr
        }
    };
    Err(if detail.is_empty() {
        format!("Git could not {action}")
    } else {
        format!("Git could not {action}: {detail}")
    })
}

fn nul_paths(bytes: &[u8]) -> BTreeSet<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

/// Whether the project is a git repository at all.
///
/// Checked before a task is allowed to start rather than at creation time: a
/// user may well add a task to a project they are about to `git init`.
#[must_use]
pub(crate) fn is_git_repository(project: &Path) -> bool {
    run(project, &["rev-parse", "--is-inside-work-tree"])
        .map(|output| output.status.success() && text(&output.stdout) == "true")
        .unwrap_or(false)
}

fn worktree_root(project_id: &str) -> PathBuf {
    crate::state::desktop_runtime_dir()
        .join("work-trees")
        .join(sanitize(project_id))
}

/// Flatten anything that could climb out of the worktree root. Both project and
/// task ids reach this from stores a user can hand-edit.
fn sanitize(value: &str) -> String {
    let safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "unknown".to_string()
    } else {
        safe
    }
}

#[must_use]
pub(crate) fn branch_name(task_id: &str) -> String {
    format!("{BRANCH_PREFIX}/{}", sanitize(task_id))
}

#[must_use]
pub(crate) fn worktree_path(project_id: &str, task_id: &str) -> PathBuf {
    worktree_root(project_id).join(sanitize(task_id))
}

/// The branch a task should be cut from, and land back on: whatever the user
/// currently has checked out.
pub(crate) fn current_branch(project: &Path) -> Result<String, String> {
    // `rev-parse --abbrev-ref HEAD` fails for a perfectly valid repository
    // before its first commit. `symbolic-ref` reads the branch name directly,
    // so an unborn branch remains distinguishable from a detached HEAD.
    let symbolic = run(project, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if symbolic.status.success() {
        let branch = text(&symbolic.stdout);
        if !branch.is_empty() {
            return Ok(branch);
        }
    }

    let head = run(
        project,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    )?;
    if head.status.success() {
        // Detached HEAD has no branch to merge back into, and picking one for
        // the user would land work somewhere they did not ask for.
        return Err(
            "the project is on a detached HEAD; check out a branch before running a task"
                .to_string(),
        );
    }

    Err(
        "Git could not read the project's current branch; repair HEAD before running a task"
            .to_string(),
    )
}

/// Resolve the commit a task branch will start from.
///
/// A repository can have a symbolic `HEAD` but no commit yet. Git describes
/// that ordinary state as an "ambiguous argument", which is accurate for the
/// CLI but not actionable in the app. Worktrees genuinely require a commit,
/// so report the missing prerequisite without exposing Git's fatal output.
fn branch_tip(project: &Path, branch: &str) -> Result<String, String> {
    let reference = format!("refs/heads/{branch}^{{commit}}");
    let output = run(project, &["rev-parse", "--verify", "--quiet", &reference])?;
    let commit = text(&output.stdout);
    if output.status.success() && !commit.is_empty() {
        return Ok(commit);
    }
    if output.status.code() == Some(1) && text(&output.stderr).is_empty() {
        return Err(format!(
            "work tasks need at least one commit on '{branch}'; create an initial commit in Review, then run the task again"
        ));
    }
    Err(if text(&output.stderr).is_empty() {
        "Git could not resolve the current branch tip".to_string()
    } else {
        format!(
            "Git could not resolve the current branch tip: {}",
            text(&output.stderr)
        )
    })
}

/// Create the task's isolated checkout.
///
/// The base commit is resolved and passed to `git worktree add` explicitly
/// rather than letting it default to HEAD: between reading the branch and
/// creating the worktree the user may switch branches, and an implicit HEAD
/// would silently cut the task from wherever they landed.
pub(crate) fn create(
    project: &Path,
    project_id: &str,
    task_id: &str,
) -> Result<WorkTaskWorktree, String> {
    if !is_git_repository(project) {
        return Err(
            "work tasks need a Git repository: this project is not one, so there is no branch to isolate the work on"
                .to_string(),
        );
    }
    let base_branch = current_branch(project)?;
    let base_sha = branch_tip(project, &base_branch)?;
    let branch = branch_name(task_id);
    let path = worktree_path(project_id, task_id);

    // Both leftovers are removed rather than reported: a task that failed
    // before recording its worktree leaves exactly this pair behind, and
    // refusing here would strand the card forever with no way back.
    remove_if_present(project, &path)?;
    if branch_exists(project, &branch) {
        let _ = checked(project, &["branch", "-D", &branch], "delete a stale branch");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }

    let path_text = path.to_string_lossy().to_string();
    checked(
        project,
        &["worktree", "add", "-b", &branch, &path_text, &base_sha],
        "create the task worktree",
    )?;
    Ok(WorkTaskWorktree {
        path: path_text,
        branch,
        base_branch,
        base_sha,
    })
}

/// Whether `branch`'s tip is reachable from `base_branch`.
///
/// The recovery verdict for an interrupted merge. Ancestry rather than "did the
/// base move": the user may have committed on the base themselves while the app
/// was closed, which moves it without landing anything of ours.
pub(crate) fn branch_is_merged_into(
    project: &Path,
    branch: &str,
    base_branch: &str,
) -> Result<bool, String> {
    if !branch_exists(project, branch) {
        return Err(format!(
            "the task's branch '{branch}' no longer exists, so whether its work landed cannot be established"
        ));
    }
    let output = run(
        project,
        &["merge-base", "--is-ancestor", branch, base_branch],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        // Any other code is a real failure (an unknown ref, a broken
        // repository) and must not be read as "no".
        _ => Err(format!(
            "Git could not compare '{branch}' with '{base_branch}': {}",
            text(&output.stderr)
        )),
    }
}

/// Resolve a ref to a commit id.
pub(crate) fn resolve(project: &Path, reference: &str) -> Result<String, String> {
    checked(project, &["rev-parse", reference], "resolve a revision")
}

fn branch_exists(project: &Path, branch: &str) -> bool {
    run(
        project,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn remove_if_present(project: &Path, path: &Path) -> Result<(), String> {
    if !path.exists() {
        // Still prune: a directory deleted outside Git leaves the worktree
        // registered, and `worktree add` then refuses the same path.
        let _ = run(project, &["worktree", "prune"]);
        return Ok(());
    }
    let path_text = path.to_string_lossy().to_string();
    let forced = run(project, &["worktree", "remove", "--force", &path_text])?;
    if !forced.status.success() {
        // Git refuses paths it does not know about; the directory is ours
        // either way, and leaving it would block every later attempt.
        std::fs::remove_dir_all(path)
            .map_err(|error| format!("could not remove {}: {error}", path.display()))?;
        let _ = run(project, &["worktree", "prune"]);
    }
    Ok(())
}

/// Tear down a task's checkout and branch.
///
/// `keep_branch` is set when the task's work was merged: the commits are
/// reachable from the base branch, but deleting the branch immediately would
/// throw away the only handle on the pre-merge history.
pub(crate) fn discard(
    project: &Path,
    worktree: &WorkTaskWorktree,
    keep_branch: bool,
) -> Result<(), String> {
    remove_if_present(project, Path::new(&worktree.path))?;
    if !keep_branch && branch_exists(project, &worktree.branch) {
        checked(
            project,
            &["branch", "-D", &worktree.branch],
            "delete the task branch",
        )?;
    }
    Ok(())
}

/// Commit whatever the agent produced, so the work is a reviewable diff rather
/// than a dirty checkout.
///
/// Returns `false` when there was nothing to commit — a task that read the
/// repository and changed nothing is a legitimate outcome, not a failure.
pub(crate) fn commit_all(worktree: &Path, message: &str, base_sha: &str) -> Result<bool, String> {
    if has_unmerged_paths(worktree)? {
        return Err(
            "the task worktree still has unresolved Git conflicts; the merge Agent must resolve and stage every conflicted path before it can be committed"
                .to_string(),
        );
    }
    // `ProjectExecutionContext` creates SomniQ's own runtime scaffolding inside
    // whatever directory a turn runs in, so an unfiltered `add -A` would commit
    // the app's bookkeeping to the task branch and merge it into the user's
    // repository. Excluded only when it is untracked: a project that genuinely
    // versions `.somniq/` must still see its own changes.
    checked(worktree, &["add", "-A"], "stage the task's changes")?;
    if !project_data_is_tracked(worktree, base_sha)? {
        // Staged and then unstaged rather than excluded at `add` time: this
        // module runs Git with `--literal-pathspecs`, which is what keeps a
        // file with a colon in its name from being read as pathspec magic —
        // and which also disables the `:(exclude)` magic an exclusion would
        // need. Unstaging by literal path needs no magic at all.
        checked(
            worktree,
            &["reset", "--quiet", "--", tools::layout::PROJECT_DATA_DIR],
            "keep the runtime directory out of the task's commit",
        )?;
        // `.somniq/` is both the runtime root and the canonical home of
        // generated research deliverables. Put only the documented artifact
        // roots back after removing session ledgers, search caches, temporary
        // tool output, and other execution scaffolding. `-f` is required
        // because projects commonly ignore `.somniq/` as a whole.
        for subdir in REVIEWABLE_PROJECT_DATA_SUBDIRS {
            let relative = format!("{}/{subdir}", tools::layout::PROJECT_DATA_DIR);
            if worktree.join(&relative).exists() {
                checked(
                    worktree,
                    &["add", "-f", "-A", "--", &relative],
                    "stage the task's research artifacts",
                )?;
            }
        }
    }
    let staged = run(worktree, &["diff", "--cached", "--quiet"])?;
    if staged.status.success() {
        return Ok(false);
    }
    checked(
        worktree,
        &["commit", "--no-verify", "-m", message],
        "commit the task's changes",
    )?;
    Ok(true)
}

/// Whether Git still considers any path unmerged in this checkout.
///
/// A merge Agent is required to stage its resolutions. Refusing before
/// `commit_all` runs `git add -A` is important: blindly staging an interrupted
/// merge would turn conflict-marker text into an apparently valid task commit.
pub(crate) fn has_unmerged_paths(worktree: &Path) -> Result<bool, String> {
    let output = run(worktree, &["diff", "--quiet", "--diff-filter=U", "--"])?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(format!(
            "Git could not inspect unresolved merge paths: {}",
            text(&output.stderr)
        )),
    }
}

/// Commit only untracked files in the user's checkout that the task branch is
/// about to make tracked.
///
/// `git merge --ff-only` refuses to overwrite such files. Removing or moving
/// them would make the merge possible but would also make their original
/// contents unauditable. A narrow preservation commit is safer: it records the
/// exact local bytes on the base branch, then stage A turns any disagreement
/// with the task into an ordinary add/add conflict inside the isolated
/// worktree, where the merge Agent can resolve it.
pub(crate) fn preserve_untracked_collisions(
    project: &Path,
    worktree: &WorkTaskWorktree,
    task_id: &str,
) -> Result<Vec<String>, String> {
    // Never create the preservation commit on whichever unrelated branch the
    // user happens to have switched to since the task was cut.
    let current = current_branch(project)?;
    if current != worktree.base_branch {
        return Err(format!(
            "this task was cut from '{}' but the project is on '{current}'; switch back before accepting it",
            worktree.base_branch
        ));
    }
    let untracked = run(
        project,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    if !untracked.status.success() {
        return Err(format!(
            "Git could not inspect untracked files before merging: {}",
            text(&untracked.stderr)
        ));
    }
    let branch_tree = run(
        project,
        &["ls-tree", "-r", "--name-only", "-z", &worktree.branch],
    )?;
    if !branch_tree.status.success() {
        return Err(format!(
            "Git could not inspect the task branch before merging: {}",
            text(&branch_tree.stderr)
        ));
    }
    let task_paths = nul_paths(&branch_tree.stdout);
    let collisions = nul_paths(&untracked.stdout)
        .into_iter()
        .filter(|path| task_paths.contains(path))
        .collect::<Vec<_>>();
    if collisions.is_empty() {
        return Ok(collisions);
    }

    // Stage only the colliding paths. The subsequent `commit --only` leaves
    // any index entries the user already had exactly as they were.
    for path in &collisions {
        checked(
            project,
            &["add", "--", path],
            "preserve a local file before landing the task",
        )?;
    }
    let message = format!("Preserve local files before landing SomniQ task {task_id}");
    let mut command = git(project);
    command.args(["commit", "--only", "--no-verify", "-m", &message, "--"]);
    command.args(&collisions);
    let committed = command
        .output()
        .map_err(|error| format!("could not run Git: {error}"))?;
    if !committed.status.success() {
        // Return the files to their original untracked state when the
        // preservation commit cannot be made. Existing staged paths outside
        // this set are deliberately untouched.
        for path in &collisions {
            let _ = run(project, &["reset", "--quiet", "--", path]);
        }
        return Err(format!(
            "Git could not preserve local files before merging: {}",
            text(&committed.stderr)
        ));
    }
    Ok(collisions)
}

/// Diff summary of the task branch against the commit it was cut from.
pub(crate) fn changes_against_base(
    worktree: &Path,
    base_sha: &str,
) -> Result<WorkTaskChanges, String> {
    let raw = checked(
        worktree,
        &["diff", "--numstat", base_sha, "HEAD"],
        "read the task's diff",
    )?;
    Ok(parse_numstat(&raw))
}

/// Parse `git diff --numstat`. Binary files report `-` for both counts, which
/// is a changed file with no line counts rather than a parse failure.
fn parse_numstat(raw: &str) -> WorkTaskChanges {
    let mut changes = WorkTaskChanges::default();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split('\t');
        let additions = fields.next().unwrap_or("-");
        let deletions = fields.next().unwrap_or("-");
        if fields.next().is_none() {
            continue;
        }
        changes.files_changed += 1;
        changes.additions += additions.parse::<u32>().unwrap_or(0);
        changes.deletions += deletions.parse::<u32>().unwrap_or(0);
    }
    changes
}

/// Full patch of the task branch against its base, for the review panel.
pub(crate) fn diff_against_base(
    worktree: &Path,
    base_sha: &str,
    max_chars: usize,
) -> Result<String, String> {
    let raw = checked(
        worktree,
        &["diff", base_sha, "HEAD"],
        "read the task's patch",
    )?;
    if raw.chars().count() <= max_chars {
        return Ok(raw);
    }
    let truncated = raw.chars().take(max_chars).collect::<String>();
    Ok(format!(
        "{truncated}\n\n[diff truncated at {max_chars} characters]"
    ))
}

/// Outcome of accepting a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MergeOutcome {
    Merged {
        commit: String,
    },
    /// The task produced no commits — accepted, nothing to land.
    NothingToMerge,
}

/// Land an accepted task on its base branch.
///
/// Two stages, ported from codeg: the base is merged INTO the worktree first,
/// so a conflict surfaces there — inside the task's own isolated checkout,
/// where it can be resolved or the task dropped — and only a worktree that
/// already contains the base is fast-forwarded onto the base branch. The user's
/// own checkout therefore never ends up in a conflicted state because of a
/// background task.
pub(crate) fn merge_into_base(
    project: &Path,
    worktree: &WorkTaskWorktree,
) -> Result<MergeOutcome, String> {
    let path = PathBuf::from(&worktree.path);
    if !path.is_dir() {
        return Err(format!(
            "the task's worktree is gone from disk ({}); nothing can be merged",
            worktree.path
        ));
    }
    // Refuse to write a base branch the user is not on any more: they may have
    // switched, and merging into a branch that is not checked out here would
    // need a different mechanism than the one below.
    let current = current_branch(project)?;
    if current != worktree.base_branch {
        return Err(format!(
            "this task was cut from '{}' but the project is on '{current}'; switch back before accepting it",
            worktree.base_branch
        ));
    }
    if !has_commits_beyond_base(&path, &worktree.base_sha)? {
        return Ok(MergeOutcome::NothingToMerge);
    }

    // Stage A — bring the base into the task branch. A conflict lands here.
    let head = checked(project, &["rev-parse", "HEAD"], "resolve the base branch")?;
    let merge = run(
        &path,
        &[
            "merge",
            "--no-edit",
            "-m",
            "Merge base branch into task worktree",
            &head,
        ],
    )?;
    if !merge.status.success() {
        let detail = text(&merge.stderr);
        // Leave the conflict in place rather than aborting: the worktree is
        // the user's to inspect, and an automatic abort would hide what went
        // wrong. The task stays in review.
        return Err(format!(
            "the base branch does not merge cleanly into this task's work, so it was left unmerged in the task worktree for you to resolve: {detail}"
        ));
    }

    // Stage B — fast-forward the base onto the task branch. Guaranteed to be a
    // fast-forward because stage A just made the task branch contain the base.
    checked(
        project,
        &["merge", "--ff-only", &worktree.branch],
        "land the task on its base branch",
    )?;
    let commit = checked(project, &["rev-parse", "HEAD"], "resolve the merge commit")?;
    Ok(MergeOutcome::Merged { commit })
}

/// Whether the project versions its own `.somniq/` directory.
///
/// Read from the immutable task base rather than from `HEAD`, the index, or
/// disk: the directory always exists in a live worktree because the runtime
/// creates it, and a recovery commit may already have added a paper beneath
/// it. Only the commit the task was cut from can say whether the project itself
/// owned the whole data directory before the task began.
fn project_data_is_tracked(worktree: &Path, base_sha: &str) -> Result<bool, String> {
    let listed = checked(
        worktree,
        &[
            "ls-tree",
            "--name-only",
            base_sha,
            "--",
            tools::layout::PROJECT_DATA_DIR,
        ],
        "check whether the project tracks its data directory",
    )?;
    Ok(!listed.trim().is_empty())
}

fn has_commits_beyond_base(worktree: &Path, base_sha: &str) -> Result<bool, String> {
    let raw = checked(
        worktree,
        &["rev-list", "--count", &format!("{base_sha}..HEAD")],
        "count the task's commits",
    )?;
    Ok(raw.trim().parse::<u32>().unwrap_or(0) > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `worktree_root` resolves through `ARIS_CONFIG_ROOT`, which is
    /// process-global. Every test that touches a real checkout pins it to its
    /// own temporary directory and holds the repo-wide serialization lock for
    /// the body — otherwise a parallel test's guard drops mid-run and the
    /// worktree paths move out from under this one.
    struct Fixture {
        temp: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        _serial: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new() -> Self {
            let serial = crate::test_env_lock()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let temp = tempfile::tempdir().expect("tempdir");
            let previous = std::env::var_os("ARIS_CONFIG_ROOT");
            std::env::set_var("ARIS_CONFIG_ROOT", temp.path().join("config"));
            Self {
                temp,
                previous,
                _serial: serial,
            }
        }

        fn repo(&self) -> PathBuf {
            let path = self.temp.path().join("repo");
            init_repo(&path);
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var("ARIS_CONFIG_ROOT", previous),
                None => std::env::remove_var("ARIS_CONFIG_ROOT"),
            }
        }
    }

    fn init_repo(root: &Path) {
        std::fs::create_dir_all(root).expect("root");
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "task@example.com"],
            vec!["config", "user.name", "Task Runner"],
        ] {
            checked(root, &args, "set up the test repository").expect("git setup");
        }
        std::fs::write(root.join("README.md"), "seed\n").expect("seed file");
        checked(root, &["add", "-A"], "stage").expect("stage");
        checked(root, &["commit", "-m", "seed"], "commit").expect("commit");
    }

    /// Ids reach this from stores a user can hand-edit, and they become
    /// directory names and ref names.
    #[test]
    fn ids_cannot_escape_the_worktree_root_or_the_branch_namespace() {
        let _fixture = Fixture::new();
        let root = worktree_root("project");
        for hostile in ["../../evil", "a/b", "..", ""] {
            let path = worktree_path("project", hostile);
            assert_eq!(path.parent(), Some(root.as_path()));
            let branch = branch_name(hostile);
            assert!(
                branch.starts_with(&format!("{BRANCH_PREFIX}/")),
                "escaped the namespace: {branch}"
            );
            assert_eq!(
                branch.matches('/').count(),
                2,
                "extra path segment: {branch}"
            );
        }
    }

    /// Binary files report `-` for both counts. They are changed files, and
    /// counting them as a parse failure would under-report the diff.
    #[test]
    fn numstat_counts_binary_files_without_line_counts() {
        let changes = parse_numstat("3\t1\tsrc/a.rs\n-\t-\tassets/logo.png\n10\t0\tsrc/b.rs\n");
        assert_eq!(changes.files_changed, 3);
        assert_eq!(changes.additions, 13);
        assert_eq!(changes.deletions, 1);
        assert_eq!(parse_numstat(""), WorkTaskChanges::default());
        // A line without a path is not a file entry.
        assert_eq!(parse_numstat("3\t1\n").files_changed, 0);
    }

    #[test]
    fn a_non_repository_is_refused_with_a_reason_naming_git() {
        let fixture = Fixture::new();
        let temp = fixture.temp.path().join("plain");
        std::fs::create_dir_all(&temp).expect("dir");
        assert!(!is_git_repository(&temp));
        let error = create(&temp, "p", "t").expect_err("must refuse");
        assert!(error.contains("Git repository"), "unhelpful error: {error}");
    }

    /// `git init` creates a symbolic branch but not a commit. Worktrees cannot
    /// be cut from that state, and Git's raw "ambiguous argument HEAD" output
    /// gives an app user no useful next step.
    #[test]
    fn an_unborn_repository_requests_an_initial_commit_without_a_git_fatal() {
        let fixture = Fixture::new();
        let project = fixture.temp.path().join("unborn");
        std::fs::create_dir_all(&project).expect("dir");
        checked(&project, &["init", "-b", "main"], "init").expect("git init");

        assert_eq!(current_branch(&project).expect("symbolic branch"), "main");
        let error = create(&project, "proj-unborn", "task-1").expect_err("must refuse");
        assert!(
            error.contains("at least one commit"),
            "unhelpful error: {error}"
        );
        assert!(error.contains("Review"), "missing next step: {error}");
        assert!(
            !error.contains("ambiguous argument"),
            "leaked Git fatal: {error}"
        );
        assert!(!error.contains("fatal:"), "leaked Git fatal: {error}");
        assert!(!worktree_path("proj-unborn", "task-1").exists());
    }

    #[test]
    fn a_detached_head_keeps_its_specific_recovery_message() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        checked(&project, &["checkout", "--detach"], "detach").expect("detach");

        let error = create(&project, "proj-detached", "task-1").expect_err("must refuse");
        assert!(error.contains("detached HEAD"), "unhelpful error: {error}");
        assert!(
            error.contains("check out a branch"),
            "missing next step: {error}"
        );
    }

    #[test]
    fn a_worktree_is_cut_from_head_on_its_own_branch() {
        let fixture = Fixture::new();
        let project = fixture.repo();

        let worktree = create(&project, "proj-a", "task-1").expect("create worktree");
        assert_eq!(worktree.base_branch, "main");
        assert_eq!(worktree.branch, "somniq/task/task-1");
        assert!(Path::new(&worktree.path).join("README.md").is_file());
        // The isolation that the whole design rests on: the task's checkout is
        // not inside the project directory.
        assert!(!Path::new(&worktree.path).starts_with(&project));

        discard(&project, &worktree, false).expect("discard");
        assert!(!Path::new(&worktree.path).exists());
        assert!(!branch_exists(&project, &worktree.branch));
    }

    /// SomniQ creates its own runtime directory inside whatever workspace a
    /// turn runs in. Committing it would merge the app's own bookkeeping into
    /// the user's repository on the first accepted task.
    #[test]
    fn the_runtime_scaffolding_is_kept_out_of_the_task_commit() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-g", "task-1").expect("create");
        let tree = Path::new(&worktree.path);

        // What a turn leaves behind: real work, plus SomniQ's scaffolding.
        std::fs::write(tree.join("answer.md"), "42\n").expect("write answer");
        std::fs::create_dir_all(tree.join(".somniq/sessions")).expect("runtime dir");
        std::fs::write(tree.join(".somniq/sessions/s.json"), "{}").expect("runtime file");

        assert!(commit_all(tree, "task: answer", &worktree.base_sha).expect("commit"));
        let committed = checked(tree, &["ls-files"], "list").expect("ls-files");
        assert!(committed.contains("answer.md"));
        assert!(
            !committed.contains(".somniq"),
            "runtime scaffolding was committed: {committed}"
        );
        discard(&project, &worktree, false).expect("discard");
    }

    /// Generated papers are deliverables even though they live beneath the
    /// same hidden directory as runtime state and the project ignores that
    /// directory. Losing them made a completed research task report a zero
    /// diff and made Accept discard its actual output.
    #[test]
    fn ignored_research_artifacts_are_committed_but_runtime_state_is_not() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        std::fs::write(project.join(".gitignore"), ".somniq/\n").expect("ignore data root");
        checked(&project, &["add", ".gitignore"], "stage ignore").expect("stage");
        checked(
            &project,
            &["commit", "-m", "ignore runtime"],
            "commit ignore",
        )
        .expect("commit");

        let worktree = create(&project, "proj-artifact", "task-1").expect("create");
        let tree = Path::new(&worktree.path);
        std::fs::create_dir_all(tree.join(".somniq/papers/survey")).expect("paper dir");
        std::fs::write(tree.join(".somniq/papers/survey/main.tex"), "survey\n")
            .expect("paper source");
        std::fs::write(
            tree.join(".somniq/papers/survey/main.pdf"),
            b"%PDF-artifact",
        )
        .expect("paper output");
        std::fs::create_dir_all(tree.join(".somniq/tmp/tool-output")).expect("runtime dir");
        std::fs::write(tree.join(".somniq/tmp/tool-output/call.txt"), "cache\n")
            .expect("runtime file");

        assert!(commit_all(tree, "task: paper", &worktree.base_sha).expect("commit"));
        let committed = checked(tree, &["ls-files"], "list").expect("ls-files");
        assert!(committed.contains(".somniq/papers/survey/main.tex"));
        assert!(committed.contains(".somniq/papers/survey/main.pdf"));
        assert!(
            !committed.contains(".somniq/tmp"),
            "runtime cache was committed: {committed}"
        );
        discard(&project, &worktree, false).expect("discard");
    }

    /// A project that genuinely versions `.somniq/` must still see its own
    /// changes — the exclusion above is for untracked scaffolding only.
    #[test]
    fn a_project_that_tracks_its_data_directory_still_commits_it() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        std::fs::create_dir_all(project.join(".somniq")).expect("dir");
        std::fs::write(project.join(".somniq/config.json"), "{}").expect("write");
        checked(&project, &["add", "-A"], "stage").expect("stage");
        checked(&project, &["commit", "-m", "track somniq"], "commit").expect("commit");

        let worktree = create(&project, "proj-h", "task-1").expect("create");
        let tree = Path::new(&worktree.path);
        std::fs::write(tree.join(".somniq/config.json"), "{\"changed\":true}").expect("edit");

        assert!(commit_all(tree, "task: edit config", &worktree.base_sha).expect("commit"));
        let changed = checked(
            tree,
            &["diff", "--name-only", &worktree.base_sha, "HEAD"],
            "diff",
        )
        .expect("diff");
        assert!(
            changed.contains(".somniq/config.json"),
            "a tracked data directory must not be excluded: {changed}"
        );
        discard(&project, &worktree, false).expect("discard");
    }

    /// Creating a task twice must work: the first attempt may have died after
    /// making the worktree but before recording it.
    #[test]
    fn creation_reclaims_a_leftover_worktree_and_branch() {
        let fixture = Fixture::new();
        let project = fixture.repo();

        let first = create(&project, "proj-b", "task-1").expect("first");
        std::fs::write(Path::new(&first.path).join("scratch.txt"), "left over").expect("write");
        let second = create(&project, "proj-b", "task-1").expect("second");

        assert_eq!(second.path, first.path);
        assert!(!Path::new(&second.path).join("scratch.txt").exists());
        discard(&project, &second, false).expect("discard");
    }

    /// A task that changed nothing is a legitimate outcome, and it must not be
    /// reported as an empty commit or as a failure.
    #[test]
    fn a_task_that_changes_nothing_commits_nothing_and_merges_nothing() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-c", "task-1").expect("create");

        assert!(!commit_all(
            Path::new(&worktree.path),
            "task: nothing",
            &worktree.base_sha,
        )
        .expect("commit"));
        assert_eq!(
            merge_into_base(&project, &worktree).expect("merge"),
            MergeOutcome::NothingToMerge
        );
        discard(&project, &worktree, false).expect("discard");
    }

    #[test]
    fn an_accepted_task_lands_on_the_base_branch() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-d", "task-1").expect("create");

        std::fs::write(Path::new(&worktree.path).join("answer.md"), "42\n").expect("write");
        assert!(commit_all(
            Path::new(&worktree.path),
            "task: answer",
            &worktree.base_sha,
        )
        .expect("commit"));

        let changes =
            changes_against_base(Path::new(&worktree.path), &worktree.base_sha).expect("changes");
        assert_eq!(changes.files_changed, 1);
        assert_eq!(changes.additions, 1);

        let outcome = merge_into_base(&project, &worktree).expect("merge");
        assert!(matches!(outcome, MergeOutcome::Merged { .. }));
        // The work is in the user's own checkout now.
        assert!(project.join("answer.md").is_file());
        discard(&project, &worktree, true).expect("discard");
    }

    /// Landing must not silently target a branch the user has since left.
    #[test]
    fn a_merge_is_refused_when_the_project_moved_to_another_branch() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-e", "task-1").expect("create");
        std::fs::write(Path::new(&worktree.path).join("answer.md"), "42\n").expect("write");
        commit_all(
            Path::new(&worktree.path),
            "task: answer",
            &worktree.base_sha,
        )
        .expect("commit");

        checked(&project, &["checkout", "-b", "other"], "switch").expect("switch");
        let error = merge_into_base(&project, &worktree).expect_err("must refuse");
        assert!(
            error.contains("main"),
            "error should name the base: {error}"
        );
        assert!(
            error.contains("other"),
            "error should name where we are: {error}"
        );
        discard(&project, &worktree, false).expect("discard");
    }

    /// A conflict must land in the task's worktree, never in the user's
    /// checkout — that is the entire point of merging base-into-task first.
    #[test]
    fn a_conflict_is_left_in_the_task_worktree_and_the_project_stays_clean() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-f", "task-1").expect("create");

        std::fs::write(
            Path::new(&worktree.path).join("README.md"),
            "task version\n",
        )
        .expect("task edit");
        commit_all(
            Path::new(&worktree.path),
            "task: edit readme",
            &worktree.base_sha,
        )
        .expect("commit");
        std::fs::write(project.join("README.md"), "user version\n").expect("user edit");
        checked(&project, &["add", "-A"], "stage").expect("stage");
        checked(&project, &["commit", "-m", "user edit"], "commit").expect("commit");

        let error = merge_into_base(&project, &worktree).expect_err("must conflict");
        assert!(error.contains("task worktree"), "unhelpful error: {error}");
        // The user's checkout is untouched: their commit is still HEAD and the
        // file still holds their version.
        assert_eq!(
            std::fs::read_to_string(project.join("README.md")).expect("read"),
            "user version\n"
        );
        let status = checked(&project, &["status", "--porcelain"], "status").expect("status");
        assert!(status.is_empty(), "project checkout is dirty: {status}");
        discard(&project, &worktree, false).expect("discard");
    }

    /// The exact failure that motivated Agent-assisted merging: a research
    /// artifact exists locally but was untracked when the task branch added
    /// the same path. Its bytes must enter history before Git is allowed to
    /// turn the disagreement into an isolated conflict for the Agent.
    #[test]
    fn untracked_collisions_are_preserved_before_agent_resolution() {
        let fixture = Fixture::new();
        let project = fixture.repo();
        let worktree = create(&project, "proj-untracked", "task-1").expect("create");
        let relative = ".somniq/papers/library.json";

        std::fs::create_dir_all(Path::new(&worktree.path).join(".somniq/papers"))
            .expect("task paper dir");
        std::fs::write(
            Path::new(&worktree.path).join(relative),
            "{\"source\":\"task\"}\n",
        )
        .expect("task library");
        commit_all(
            Path::new(&worktree.path),
            "task: library",
            &worktree.base_sha,
        )
        .expect("task commit");

        std::fs::create_dir_all(project.join(".somniq/papers")).expect("local paper dir");
        std::fs::write(project.join(relative), "{\"source\":\"local\"}\n").expect("local library");
        let preserved = preserve_untracked_collisions(&project, &worktree, "task-1")
            .expect("preserve collision");

        assert_eq!(preserved, [relative]);
        assert_eq!(
            checked(
                &project,
                &["show", &format!("HEAD:{relative}")],
                "show preserved"
            )
            .expect("preserved content"),
            "{\"source\":\"local\"}"
        );
        assert!(
            merge_into_base(&project, &worktree).is_err(),
            "different add/add contents should be left for the merge Agent"
        );
        assert!(has_unmerged_paths(Path::new(&worktree.path)).expect("conflict state"));
        assert!(
            commit_all(Path::new(&worktree.path), "must refuse", &worktree.base_sha).is_err(),
            "the controller must not blindly stage conflict markers"
        );
        assert_eq!(
            std::fs::read_to_string(project.join(relative)).expect("local bytes"),
            "{\"source\":\"local\"}\n"
        );
        discard(&project, &worktree, false).expect("discard");
    }
}

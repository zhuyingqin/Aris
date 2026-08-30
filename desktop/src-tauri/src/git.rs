use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Output;

use serde::Serialize;
use tauri::State;

use crate::projects::{current_project_path, ProjectState};

const MAX_COMMIT_MESSAGE_CHARS: usize = 20_000;
const MAX_DIFF_CHARS: usize = 750_000;
const MAX_LOCAL_REVIEW_RECORDS: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceSnapshot {
    pub git_available: bool,
    pub git_version: Option<String>,
    pub is_repository: bool,
    pub workspace_path: String,
    pub repository_root: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub files: Vec<GitFileChange>,
    pub branches: Vec<GitBranch>,
    pub has_conflicts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffView {
    pub path: String,
    pub staged: bool,
    pub content: String,
    pub truncated: bool,
}

/// A project-local change record used when Git is unavailable or the project
/// has not been initialised as a repository yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReviewFileChange {
    pub change_id: String,
    pub path: String,
    pub operation: String,
    pub status: String,
    pub tool_name: String,
    pub timestamp: String,
    pub before_exists: bool,
    pub after_exists: bool,
    pub additions: u64,
    pub deletions: u64,
    pub unified_diff: String,
    pub truncated: bool,
    pub reversible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReviewSnapshot {
    pub workspace_path: String,
    pub ledger_root: String,
    pub files: Vec<LocalReviewFileChange>,
    pub record_count: usize,
}

fn empty_snapshot(workspace: &Path, version: Option<String>) -> GitWorkspaceSnapshot {
    GitWorkspaceSnapshot {
        git_available: version.is_some(),
        git_version: version,
        is_repository: false,
        workspace_path: workspace.to_string_lossy().into_owned(),
        repository_root: None,
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        branches: Vec::new(),
        has_conflicts: false,
    }
}

fn git_command(workspace: &Path) -> std::process::Command {
    let mut command = crate::process::hidden_command("git");
    command
        .current_dir(workspace)
        .arg("--literal-pathspecs")
        .args(["-c", "color.ui=false"])
        .args(["-c", "core.quotepath=false"]);
    command
}

fn run_git(workspace: &Path, args: &[&str]) -> Result<Output, String> {
    if !workspace.is_dir() {
        return Err(format!(
            "current project directory does not exist: {}",
            workspace.display()
        ));
    }
    git_command(workspace)
        .args(args)
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                "Git is not installed or is not available on PATH".to_string()
            }
            _ => format!("could not run Git: {error}"),
        })
}

fn output_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn output_error(action: &str, output: &Output) -> String {
    let stderr = output_text(&output.stderr);
    let stdout = output_text(&output.stdout);
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!(
            "Git could not {action} (exit code {:?})",
            output.status.code()
        )
    } else {
        format!("Git could not {action}: {detail}")
    }
}

fn require_success(action: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(output_error(action, &output))
    }
}

fn optional_git_line(workspace: &Path, args: &[&str]) -> Option<String> {
    run_git(workspace, args)
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output_text(&output.stdout))
        .filter(|value| !value.is_empty())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Git path must not be empty".to_string());
    }
    let parsed = Path::new(path);
    if parsed.is_absolute()
        || parsed
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Git path must stay inside the repository: {path}"));
    }
    Ok(())
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("select at least one changed file".to_string());
    }
    for path in paths {
        validate_relative_path(path)?;
    }
    Ok(())
}

fn status_label(code: u8) -> Option<String> {
    (code != b' ' && code != b'?').then(|| char::from(code).to_string())
}

fn is_conflict(code: &[u8]) -> bool {
    matches!(code, b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU") || code.contains(&b'U')
}

fn parse_porcelain_status(bytes: &[u8]) -> Vec<GitFileChange> {
    let mut files = Vec::new();
    let mut cursor = 0;
    while cursor + 3 <= bytes.len() {
        let code = &bytes[cursor..cursor + 2];
        if bytes[cursor + 2] != b' ' {
            break;
        }
        cursor += 3;
        let Some(path_end) = bytes[cursor..].iter().position(|byte| *byte == 0) else {
            break;
        };
        let path = String::from_utf8_lossy(&bytes[cursor..cursor + path_end]).into_owned();
        cursor += path_end + 1;

        let renamed_or_copied = matches!(code[0], b'R' | b'C') || matches!(code[1], b'R' | b'C');
        let old_path = if renamed_or_copied {
            let Some(old_end) = bytes[cursor..].iter().position(|byte| *byte == 0) else {
                break;
            };
            let value = String::from_utf8_lossy(&bytes[cursor..cursor + old_end]).into_owned();
            cursor += old_end + 1;
            Some(value)
        } else {
            None
        };

        let untracked = code == b"??";
        files.push(GitFileChange {
            path,
            old_path,
            index_status: status_label(code[0]),
            worktree_status: status_label(code[1]),
            staged: !untracked && code[0] != b' ',
            unstaged: !untracked && code[1] != b' ',
            untracked,
            conflicted: is_conflict(code),
            additions: 0,
            deletions: 0,
        });
    }
    files
}

fn parse_numstat(bytes: &[u8]) -> BTreeMap<String, (u64, u64)> {
    let mut stats = BTreeMap::new();
    for line in String::from_utf8_lossy(bytes).lines() {
        let mut fields = line.splitn(3, '\t');
        let Some(additions) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        let Some(deletions) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        let Some(raw_path) = fields
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        // `--no-renames` is not used here because the status view already
        // carries rename metadata. Keep the new side when Git renders a
        // rename as `old => new`; this is enough to attach totals to the row.
        let path = raw_path
            .rsplit_once(" => ")
            .map(|(_, right)| right.trim_matches(['{', '}']))
            .unwrap_or(raw_path)
            .replace('\\', "/");
        let entry = stats.entry(path).or_insert((0_u64, 0_u64));
        entry.0 = entry.0.saturating_add(additions);
        entry.1 = entry.1.saturating_add(deletions);
    }
    stats
}

fn merge_numstat(into: &mut BTreeMap<String, (u64, u64)>, bytes: &[u8]) {
    for (path, (additions, deletions)) in parse_numstat(bytes) {
        let entry = into.entry(path).or_insert((0_u64, 0_u64));
        entry.0 = entry.0.saturating_add(additions);
        entry.1 = entry.1.saturating_add(deletions);
    }
}

fn diff_numstat(root: &Path, pathspec: &str) -> BTreeMap<String, (u64, u64)> {
    let mut stats = BTreeMap::new();
    let has_head = optional_git_line(root, &["rev-parse", "--verify", "HEAD"]).is_some();
    if has_head {
        let args = ["diff", "--numstat", "HEAD", "--", pathspec];
        if let Ok(output) = run_git(root, &args) {
            if output.status.success() {
                merge_numstat(&mut stats, &output.stdout);
            }
        }
    } else {
        for args in [
            vec!["diff", "--numstat", "--", pathspec],
            vec!["diff", "--cached", "--numstat", "--", pathspec],
        ] {
            if let Ok(output) = run_git(root, &args) {
                if output.status.success() {
                    merge_numstat(&mut stats, &output.stdout);
                }
            }
        }
    }
    stats
}

fn untracked_line_count(root: &Path, path: &str) -> Option<u64> {
    let content = fs::read(root.join(path)).ok()?;
    let text = std::str::from_utf8(&content).ok()?;
    Some(text.lines().count() as u64)
}

fn untracked_file_diff(root: &Path, path: &str) -> Result<String, String> {
    let content = fs::read(root.join(path))
        .map_err(|error| format!("could not read untracked file {path}: {error}"))?;
    let Ok(text) = String::from_utf8(content) else {
        return Ok("Binary file; text diff is not available for this selection.".to_string());
    };

    let mut diff = format!("--- /dev/null\n+++ b/{path}");
    let lines = text.lines().collect::<Vec<_>>();
    if !lines.is_empty() {
        diff.push_str(&format!("\n@@ -0,0 +1,{} @@", lines.len()));
        for line in lines {
            diff.push('\n');
            diff.push('+');
            diff.push_str(line);
        }
        if !text.ends_with('\n') {
            diff.push_str("\n\\ No newline at end of file");
        }
    }
    Ok(diff)
}

fn workspace_pathspec(root: &Path, workspace: &Path) -> Result<String, String> {
    let relative = workspace.strip_prefix(root).map_err(|_| {
        format!(
            "current project {} is outside Git repository {}",
            workspace.display(),
            root.display()
        )
    })?;
    if relative.as_os_str().is_empty() {
        Ok(".".to_string())
    } else {
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }
}

fn workspace_relative_path(root: &Path, workspace: &Path, raw_path: &str) -> Option<String> {
    let candidate = root.join(raw_path.replace('\\', "/"));
    let relative = candidate.strip_prefix(workspace).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    let path = relative.to_string_lossy().replace('\\', "/");
    (!path.is_empty() && path != "." && !path.starts_with("../") && !path.contains("/../"))
        .then_some(path)
}

fn repository_relative_path(
    root: &Path,
    workspace: &Path,
    path: &str,
) -> Result<String, String> {
    validate_relative_path(path)?;
    let absolute = workspace.join(path);
    let relative = absolute.strip_prefix(root).map_err(|_| {
        format!("selected path must stay inside Git repository: {path}")
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn repository_root(workspace: &Path) -> Result<Option<PathBuf>, String> {
    let output = run_git(workspace, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let root = output_text(&output.stdout);
    Ok((!root.is_empty()).then(|| PathBuf::from(root)))
}

fn git_version(workspace: &Path) -> Result<Option<String>, String> {
    match run_git(workspace, &["--version"]) {
        Ok(output) if output.status.success() => Ok(Some(output_text(&output.stdout))),
        Ok(output) => Err(output_error("read its version", &output)),
        Err(error) if error.contains("not installed") => Ok(None),
        Err(error) => Err(error),
    }
}

fn ahead_behind(workspace: &Path) -> (u64, u64) {
    let Some(raw) = optional_git_line(
        workspace,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) else {
        return (0, 0);
    };
    let mut parts = raw.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    (ahead, behind)
}

fn local_branches(workspace: &Path, current: Option<&str>) -> Vec<GitBranch> {
    let raw = optional_git_line(
        workspace,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .unwrap_or_default();
    let mut branches = raw
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| GitBranch {
            name: name.to_string(),
            current: current == Some(name),
        })
        .collect::<Vec<_>>();
    if let Some(current) = current {
        if !branches.iter().any(|branch| branch.name == current) {
            branches.push(GitBranch {
                name: current.to_string(),
                current: true,
            });
        }
    }
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    branches
}

pub(crate) fn workspace_status(workspace: &Path) -> Result<GitWorkspaceSnapshot, String> {
    let version = git_version(workspace)?;
    let Some(version) = version else {
        return Ok(empty_snapshot(workspace, None));
    };
    let Some(root) = repository_root(workspace)? else {
        return Ok(empty_snapshot(workspace, Some(version)));
    };

    let pathspec = workspace_pathspec(&root, workspace)?;
    let status = require_success(
        "read repository status",
        run_git(
            &root,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                &pathspec,
            ],
        )?,
    )?;
    let mut files = parse_porcelain_status(&status.stdout);
    let stats = diff_numstat(&root, &pathspec);
    for file in &mut files {
        let (mut additions, deletions) = stats.get(&file.path).copied().unwrap_or_default();
        if file.untracked && additions == 0 {
            additions = untracked_line_count(&root, &file.path).unwrap_or(0);
        }
        file.additions = additions;
        file.deletions = deletions;
    }
    let files = files
        .into_iter()
        .filter_map(|mut file| {
            file.path = workspace_relative_path(&root, workspace, &file.path)?;
            file.old_path = file
                .old_path
                .take()
                .and_then(|path| workspace_relative_path(&root, workspace, &path));
            Some(file)
        })
        .collect::<Vec<_>>();
    let branch = optional_git_line(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let detached =
        branch.is_none()
            && optional_git_line(&root, &["rev-parse", "--verify", "HEAD"]).is_some();
    let upstream = optional_git_line(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let (ahead, behind) = ahead_behind(&root);
    let branches = local_branches(&root, branch.as_deref());
    let has_conflicts = files.iter().any(|file| file.conflicted);

    Ok(GitWorkspaceSnapshot {
        git_available: true,
        git_version: Some(version),
        is_repository: true,
        workspace_path: workspace.to_string_lossy().into_owned(),
        repository_root: Some(root.to_string_lossy().into_owned()),
        branch,
        detached,
        upstream,
        ahead,
        behind,
        files,
        branches,
        has_conflicts,
    })
}

pub(crate) fn initialize_workspace(workspace: &Path) -> Result<GitWorkspaceSnapshot, String> {
    require_success("initialize the repository", run_git(workspace, &["init"])?)?;
    workspace_status(workspace)
}

pub(crate) fn stage_paths(
    workspace: &Path,
    paths: &[String],
) -> Result<GitWorkspaceSnapshot, String> {
    validate_paths(paths)?;
    let root = repository_root(workspace)?
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    let paths = paths
        .iter()
        .map(|path| repository_relative_path(&root, workspace, path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    require_success("stage the selected files", run_git(&root, &args)?)?;
    workspace_status(workspace)
}

pub(crate) fn unstage_paths(
    workspace: &Path,
    paths: &[String],
) -> Result<GitWorkspaceSnapshot, String> {
    validate_paths(paths)?;
    let root = repository_root(workspace)?
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    let paths = paths
        .iter()
        .map(|path| repository_relative_path(&root, workspace, path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    let output = run_git(&root, &args)?;
    if output.status.success() {
        return workspace_status(workspace);
    }
    if optional_git_line(&root, &["rev-parse", "--verify", "HEAD"]).is_some() {
        return Err(output_error("unstage the selected files", &output));
    }
    // An unborn repository has no HEAD for `restore --staged`. Resetting the
    // index is the portable way to unstage its initial files while preserving
    // every working-tree byte.
    let mut fallback = vec!["rm", "--cached", "--ignore-unmatch", "--"];
    fallback.extend(paths.iter().map(String::as_str));
    require_success("unstage the selected files", run_git(&root, &fallback)?)?;
    workspace_status(workspace)
}

pub(crate) fn commit_changes(
    workspace: &Path,
    message: &str,
) -> Result<GitWorkspaceSnapshot, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message must not be empty".to_string());
    }
    if message.chars().count() > MAX_COMMIT_MESSAGE_CHARS || message.contains('\0') {
        return Err("commit message is too long or contains an invalid character".to_string());
    }
    let root = repository_root(workspace)?
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    require_success(
        "create the commit",
        run_git(&root, &["commit", "-m", message])?,
    )?;
    workspace_status(workspace)
}

fn validate_branch_name(workspace: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('\0') {
        return Err("branch name must not be empty".to_string());
    }
    require_success(
        "validate the branch name",
        run_git(workspace, &["check-ref-format", "--branch", name])?,
    )?;
    Ok(name.to_string())
}

pub(crate) fn create_branch(workspace: &Path, name: &str) -> Result<GitWorkspaceSnapshot, String> {
    repository_root(workspace)?
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    let name = validate_branch_name(workspace, name)?;
    require_success(
        "create the branch",
        run_git(workspace, &["switch", "-c", &name])?,
    )?;
    workspace_status(workspace)
}

pub(crate) fn switch_branch(workspace: &Path, name: &str) -> Result<GitWorkspaceSnapshot, String> {
    repository_root(workspace)?
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    let name = validate_branch_name(workspace, name)?;
    if !local_branches(workspace, None)
        .iter()
        .any(|branch| branch.name == name)
    {
        return Err(format!("local branch does not exist: {name}"));
    }
    require_success("switch branches", run_git(workspace, &["switch", &name])?)?;
    workspace_status(workspace)
}

pub(crate) fn file_diff(workspace: &Path, path: &str, staged: bool) -> Result<GitDiffView, String> {
    validate_relative_path(path)?;
    let snapshot = workspace_status(workspace)?;
    let root = snapshot
        .repository_root
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "current project is not a Git repository".to_string())?;
    let change = snapshot
        .files
        .iter()
        .find(|change| change.path == path)
        .ok_or_else(|| "selected file is no longer changed; refresh the repository".to_string())?;
    if change.untracked && !staged {
        let git_path = repository_relative_path(&root, workspace, path)?;
        return Ok(GitDiffView {
            path: path.to_string(),
            staged,
            content: untracked_file_diff(&root, &git_path)?,
            truncated: false,
        });
    }

    let git_path = repository_relative_path(&root, workspace, path)?;
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", &git_path]);
    let output = require_success("read the selected diff", run_git(&root, &args)?)?;
    let content = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut truncated = false;
    let content = if content.chars().count() > MAX_DIFF_CHARS {
        truncated = true;
        content.chars().take(MAX_DIFF_CHARS).collect::<String>()
    } else {
        content
    };
    Ok(GitDiffView {
        path: path.to_string(),
        staged,
        content: if content.is_empty() {
            "No textual diff is available for this file and selection.".to_string()
        } else {
            content
        },
        truncated,
    })
}

fn relative_review_path(workspace: &Path, raw_path: &str) -> Option<String> {
    let candidate = raw_path.replace('\\', "/");
    if candidate.is_empty() {
        return None;
    }
    if !Path::new(raw_path).is_absolute() {
        if candidate == "." || candidate.starts_with("../") || candidate.contains("/../") {
            return None;
        }
        return Some(candidate.trim_start_matches("./").to_string());
    }

    let root = workspace
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let root_lower = root.to_ascii_lowercase();
    let candidate_lower = candidate.to_ascii_lowercase();
    let prefix = format!("{root_lower}/");
    if !candidate_lower.starts_with(&prefix) {
        return None;
    }
    Some(candidate[prefix.len()..].to_string())
}

fn operation_label(operation: &runtime::FileChangeOperation) -> &'static str {
    match operation {
        runtime::FileChangeOperation::Create => "create",
        runtime::FileChangeOperation::Update => "update",
        runtime::FileChangeOperation::Append => "append",
        runtime::FileChangeOperation::Delete => "delete",
        runtime::FileChangeOperation::Rename => "rename",
        runtime::FileChangeOperation::Revert => "revert",
    }
}

fn change_status_label(status: &runtime::FileChangeStatus) -> &'static str {
    match status {
        runtime::FileChangeStatus::Applied => "applied",
        runtime::FileChangeStatus::Reverted => "reverted",
        runtime::FileChangeStatus::Conflict => "conflict",
    }
}

fn local_diff_stats(diff: &str) -> (u64, u64) {
    let mut additions: u64 = 0;
    let mut deletions: u64 = 0;
    for line in diff.lines() {
        if line.starts_with("+++")
            || line.starts_with("---")
            || line.starts_with("@@")
            || line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with('\\')
        {
            continue;
        }
        if line.starts_with('+') {
            additions = additions.saturating_add(1);
        } else if line.starts_with('-') {
            deletions = deletions.saturating_add(1);
        }
    }
    (additions, deletions)
}

fn truncate_review_diff(diff: &str) -> (String, bool) {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return (diff.to_string(), false);
    }
    (diff.chars().take(MAX_DIFF_CHARS).collect(), true)
}

fn build_local_review_snapshot(workspace: &Path) -> Result<LocalReviewSnapshot, String> {
    let output = runtime::list_file_changes_for_workspace(
        workspace,
        runtime::FileChangeListInput {
            session_id: None,
            limit: Some(MAX_LOCAL_REVIEW_RECORDS),
        },
    )
    .map_err(|error| format!("could not read SomniQ change history: {error}"))?;

    // The ledger is an event history. Review needs the latest active record per
    // path so repeated AI/editor saves do not produce a confusing stack of
    // entries for the same file.
    let record_count = output.records.len();
    let mut latest = BTreeMap::<String, runtime::FileChangeRecord>::new();
    for record in output.records {
        let key = record.canonical_path.clone();
        if record.status == runtime::FileChangeStatus::Reverted
            || record.operation == runtime::FileChangeOperation::Revert
        {
            latest.remove(&key);
        } else {
            latest.insert(key, record);
        }
    }

    let files = latest
        .into_values()
        .filter_map(|record| {
            let path = relative_review_path(workspace, &record.canonical_path)?;
            let (additions, deletions) = local_diff_stats(&record.unified_diff);
            let (unified_diff, truncated) = truncate_review_diff(&record.unified_diff);
            Some(LocalReviewFileChange {
                change_id: record.change_id,
                path,
                operation: operation_label(&record.operation).to_string(),
                status: change_status_label(&record.status).to_string(),
                tool_name: record.tool_name,
                timestamp: record.timestamp,
                before_exists: record.before.exists,
                after_exists: record.after.exists,
                additions,
                deletions,
                unified_diff,
                truncated,
                reversible: record.reversible,
            })
        })
        .collect();

    Ok(LocalReviewSnapshot {
        workspace_path: workspace.to_string_lossy().into_owned(),
        ledger_root: output.ledger_root,
        files,
        record_count,
    })
}

async fn run_blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_status(projects: State<'_, ProjectState>) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || workspace_status(&workspace)).await
}

#[tauri::command]
pub async fn local_review_status(
    projects: State<'_, ProjectState>,
) -> Result<LocalReviewSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || build_local_review_snapshot(&workspace)).await
}

#[tauri::command]
pub async fn git_initialize(
    projects: State<'_, ProjectState>,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || initialize_workspace(&workspace)).await
}

#[tauri::command]
pub async fn git_stage(
    projects: State<'_, ProjectState>,
    paths: Vec<String>,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || stage_paths(&workspace, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(
    projects: State<'_, ProjectState>,
    paths: Vec<String>,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || unstage_paths(&workspace, &paths)).await
}

#[tauri::command]
pub async fn git_commit(
    projects: State<'_, ProjectState>,
    message: String,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || commit_changes(&workspace, &message)).await
}

#[tauri::command]
pub async fn git_branch_create(
    projects: State<'_, ProjectState>,
    name: String,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || create_branch(&workspace, &name)).await
}

#[tauri::command]
pub async fn git_branch_switch(
    projects: State<'_, ProjectState>,
    name: String,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || switch_branch(&workspace, &name)).await
}

#[tauri::command]
pub async fn git_diff(
    projects: State<'_, ProjectState>,
    path: String,
    staged: bool,
) -> Result<GitDiffView, String> {
    let workspace = current_project_path(projects.inner())?;
    run_blocking(move || file_diff(&workspace, &path, staged)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        crate::process::hidden_command("git")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn configure_identity(root: &Path) {
        require_success(
            "configure test email",
            run_git(root, &["config", "user.email", "tests@somniq.local"]).unwrap(),
        )
        .unwrap();
        require_success(
            "configure test name",
            run_git(root, &["config", "user.name", "SomniQ Tests"]).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn parses_porcelain_status_with_rename_and_conflict_metadata() {
        let raw = b" M src/lib.rs\0?? notes.txt\0R  new.txt\0old.txt\0UU conflict.md\0";
        let files = parse_porcelain_status(raw);
        assert_eq!(files.len(), 4);
        assert!(files[0].unstaged);
        assert!(files[1].untracked);
        assert_eq!(files[2].old_path.as_deref(), Some("old.txt"));
        assert!(files[2].staged);
        assert!(files[3].conflicted);
    }

    #[test]
    fn repository_lifecycle_preserves_worktree_while_staging_and_unstaging() {
        if !git_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let initial = initialize_workspace(root.path()).unwrap();
        assert!(initial.is_repository);
        configure_identity(root.path());

        std::fs::write(root.path().join("paper.md"), "first\n").unwrap();
        let status = workspace_status(root.path()).unwrap();
        assert!(status
            .files
            .iter()
            .any(|file| file.path == "paper.md" && file.untracked));
        let working_diff = file_diff(root.path(), "paper.md", false).unwrap();
        assert!(working_diff.content.contains("+first"));

        let staged = stage_paths(root.path(), &["paper.md".to_string()]).unwrap();
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "paper.md" && file.staged));
        let staged_diff = file_diff(root.path(), "paper.md", true).unwrap();
        assert!(staged_diff.content.contains("+first"));

        let unstaged = unstage_paths(root.path(), &["paper.md".to_string()]).unwrap();
        assert!(unstaged
            .files
            .iter()
            .any(|file| file.path == "paper.md" && file.untracked));
        assert_eq!(
            std::fs::read_to_string(root.path().join("paper.md")).unwrap(),
            "first\n"
        );

        stage_paths(root.path(), &["paper.md".to_string()]).unwrap();
        let committed = commit_changes(root.path(), "Initial research note").unwrap();
        assert!(committed.files.is_empty());
    }

    #[test]
    fn creates_and_switches_local_branches() {
        if !git_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        initialize_workspace(root.path()).unwrap();
        configure_identity(root.path());
        std::fs::write(root.path().join("README.md"), "SomniQ\n").unwrap();
        stage_paths(root.path(), &["README.md".to_string()]).unwrap();
        let committed = commit_changes(root.path(), "Initial commit").unwrap();
        let original = committed.branch.expect("initial branch");

        let created = create_branch(root.path(), "research/evidence").unwrap();
        assert_eq!(created.branch.as_deref(), Some("research/evidence"));
        let switched = switch_branch(root.path(), &original).unwrap();
        assert_eq!(switched.branch.as_deref(), Some(original.as_str()));
    }

    #[test]
    fn rejects_paths_that_escape_the_repository() {
        assert!(validate_relative_path("../secret.txt").is_err());
        assert!(validate_relative_path("/tmp/secret.txt").is_err());
        assert!(validate_relative_path("src/lib.rs").is_ok());
    }

    #[test]
    fn scopes_nested_project_status_and_operations_to_the_project_directory() {
        if !git_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        initialize_workspace(root.path()).unwrap();
        configure_identity(root.path());
        let project = root.path().join("nested");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(root.path().join("outside.txt"), "outside\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside\n").unwrap();

        let status = workspace_status(&project).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "inside.txt");

        let staged = stage_paths(&project, &["inside.txt".to_string()]).unwrap();
        assert!(staged
            .files
            .iter()
            .any(|file| file.path == "inside.txt" && file.staged));
        assert!(!staged.files.iter().any(|file| file.path == "outside.txt"));
        let diff = file_diff(&project, "inside.txt", true).unwrap();
        assert!(diff.content.contains("+inside"));
    }
}

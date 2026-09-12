//! Canonical project output layout shared by tools and desktop surfaces.
//!
//! The goal is to keep generated artifacts discoverable without requiring each
//! workflow to remember a separate registration step.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Root for application-managed project data. It is intentionally hidden from
/// the normal workspace tree so generated artifacts do not look like
/// user-authored project folders.
pub const PROJECT_DATA_DIR: &str = ".somniq";
/// Backwards-compatible name for callers that only need the scratch root.
pub const SCRATCH_DIR: &str = PROJECT_DATA_DIR;
pub const TMP_SUBDIR: &str = "tmp";
pub const PAPERS_DIR: &str = "papers";
pub const SLIDES_DIR: &str = "slides";
pub const POSTER_DIR: &str = "poster";
pub const WEB_DIR: &str = "web";
pub const NOTEBOOKS_DIR: &str = "notebooks";
pub const REPORTS_DIR: &str = "reports";
pub const LEGACY_NOTEBOOKS_DIR: &str = "experiments";
pub const EXPERIMENTS_DIR: &str = "experiments";
pub const RUNS_SUBDIR: &str = "runs";
/// Staging area for deliverables a work task produces that do not belong to
/// the project's own files — a report, a deck, an export.
///
/// Inside the task's isolated checkout but deliberately never committed: the
/// contents are copied into SomniQ's managed artifact store when the run
/// settles, so getting a generated PDF out of a task does not require merging
/// a commit into the user's repository.
pub const TASK_OUTPUT_DIR: &str = "task-output";

/// Where a work task writes its standalone deliverables.
pub fn task_output_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(TASK_OUTPUT_DIR)
}

pub const ROOT_DISPLAY_ORDER: &[&str] = &[
    SLIDES_DIR,
    POSTER_DIR,
    WEB_DIR,
    NOTEBOOKS_DIR,
    EXPERIMENTS_DIR,
    "papers",
    SCRATCH_DIR,
];

pub fn project_data_dir_at(base: &Path) -> PathBuf {
    base.join(PROJECT_DATA_DIR)
}

pub fn papers_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(PAPERS_DIR)
}

pub fn slides_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(SLIDES_DIR)
}

pub fn poster_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(POSTER_DIR)
}

pub fn web_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(WEB_DIR)
}

pub fn notebooks_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(NOTEBOOKS_DIR)
}

pub fn reports_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(REPORTS_DIR)
}

pub fn experiments_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base).join(EXPERIMENTS_DIR)
}

pub fn runs_dir_at(base: &Path) -> PathBuf {
    experiments_dir_at(base).join(RUNS_SUBDIR)
}

pub fn scratch_dir_at(base: &Path) -> PathBuf {
    project_data_dir_at(base)
}

pub fn scratch_tmp_dir_at(base: &Path) -> PathBuf {
    scratch_dir_at(base).join(TMP_SUBDIR)
}

pub fn standard_artifact_dir_at(base: &Path, kind: &str) -> Option<PathBuf> {
    match kind {
        "paper" | "papers" => Some(papers_dir_at(base)),
        "slides" => Some(slides_dir_at(base)),
        "poster" => Some(poster_dir_at(base)),
        "report" | "reports" => Some(reports_dir_at(base)),
        "web" => Some(web_dir_at(base)),
        _ => None,
    }
}

pub fn canonical_notebook_path(input: &str) -> String {
    let mut path = normalize_relative(input.trim());
    if path.is_empty() {
        path = "untitled.ipynb".to_string();
    }
    if !path.to_ascii_lowercase().ends_with(".ipynb") {
        path.push_str(".ipynb");
    }
    if has_path_separator(&path) || Path::new(&path).is_absolute() {
        path
    } else {
        format!("{PROJECT_DATA_DIR}/{NOTEBOOKS_DIR}/{path}")
    }
}

pub fn normalize_relative(path: &str) -> String {
    path.trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '<' | '>'))
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

pub fn has_path_separator(path: &str) -> bool {
    path.contains('/') || path.contains('\\')
}

pub fn root_display_rank(name: &str) -> usize {
    ROOT_DISPLAY_ORDER
        .iter()
        .position(|candidate| candidate.eq_ignore_ascii_case(name))
        .unwrap_or(ROOT_DISPLAY_ORDER.len())
}

pub fn is_noisy_workspace_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".claude"
            | ".codex"
            | ".agents"
            | ".clawd-agents"
            | ".somniq"
            | ".sandbox-home"
            | ".sandbox-tmp"
            | "node_modules"
            | "target"
            | "__pycache__"
    ) || name.starts_with(".tmp-")
}

pub fn is_noisy_walk_dir(name: &str) -> bool {
    is_noisy_workspace_entry(name) || name.starts_with('.')
}

pub fn layout_json() -> Value {
    json!({
        "version": 2,
        // This payload is read when the model is choosing a path. Keep the
        // distinction between user-owned output and application-owned state in
        // the payload itself; a tool description alone is too easy to lose.
        "scope": "Path policy for files created in a project workspace. User-facing files belong at their existing path, a conventional visible project path, or a destination explicitly chosen by the user. Never default a paper, report, slide deck, poster, export, or other standalone deliverable to .somniq/.",
        "outputPolicy": {
            "projectModification": "Create project-owned source, tests, configuration, documentation, and other build inputs in the visible project tree at their conventional path.",
            "standaloneDeliverable": "Preserve an explicit user destination. If no destination or clear visible project convention was supplied, ask the user where to export the file before writing it; never use .somniq/ as the default.",
            "workTaskStaging": format!("Only the work-task runtime may stage standalone deliverables under {PROJECT_DATA_DIR}/task-output/. It imports them into the application-managed library before the turn completes; ordinary chat and other workflows must not use this staging path."),
            "runtimeData": format!("Application-owned indexes, library attachments, execution records, caches, and temporary intermediates may live under {PROJECT_DATA_DIR}/. They are not the default destination for user-facing files.")
        },
        "managedInternalRoots": [
            {
                "kind": "paper",
                "directory": format!("{PROJECT_DATA_DIR}/{PAPERS_DIR}"),
                "description": "Application-managed literature attachments and legacy paper records; not a destination for a newly requested paper."
            },
            {
                "kind": "slides",
                "directory": format!("{PROJECT_DATA_DIR}/{SLIDES_DIR}"),
                "description": "Existing application-managed or legacy slide records; not a default export directory."
            },
            {
                "kind": "poster",
                "directory": format!("{PROJECT_DATA_DIR}/{POSTER_DIR}"),
                "description": "Existing application-managed or legacy poster records; not a default export directory."
            },
            {
                "kind": "report",
                "directory": format!("{PROJECT_DATA_DIR}/{REPORTS_DIR}"),
                "description": "Existing application-managed or legacy report records; not a default export directory."
            },
            {
                "kind": "web",
                "directory": format!("{PROJECT_DATA_DIR}/{WEB_DIR}/<name>"),
                "description": "Existing application-managed or legacy web artifacts; project web applications belong in the visible source tree."
            },
            {
                "kind": "notebook",
                "directory": format!("{PROJECT_DATA_DIR}/{NOTEBOOKS_DIR}"),
                "description": "Application-managed notebooks opened and edited by Lab."
            },
            {
                "kind": "run",
                "directory": format!("{PROJECT_DATA_DIR}/{EXPERIMENTS_DIR}/{RUNS_SUBDIR}/<run-id>"),
                "description": "Executed notebook copies, sweep outputs, and run artifacts."
            },
            {
                "kind": "scratch",
                "directory": format!("{PROJECT_DATA_DIR}/{TMP_SUBDIR}"),
                "description": "Temporary files, caches, and other non-user-facing intermediates."
            },
        ],
        "legacy": {
            "projectDataDirectory": PROJECT_DATA_DIR,
            "artifactRoots": [PAPERS_DIR, SLIDES_DIR, POSTER_DIR, WEB_DIR, NOTEBOOKS_DIR, REPORTS_DIR, EXPERIMENTS_DIR],
            "note": "Existing managed and legacy artifact roots remain readable for compatibility. Their presence does not authorize placing newly requested user-facing deliverables under .somniq/."
        }
    })
}

#[cfg(test)]
#[path = "tests/layout.rs"]
mod tests;

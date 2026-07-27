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
        "version": 1,
        "rules": [
            {
                "kind": "paper",
                "directory": format!("{PROJECT_DATA_DIR}/{PAPERS_DIR}"),
                "description": "LaTeX paper sources, rendered PDFs, and literature-library attachments."
            },
            {
                "kind": "slides",
                "directory": format!("{PROJECT_DATA_DIR}/{SLIDES_DIR}"),
                "description": "Slide/PPT/PDF deck sources and rendered deck outputs."
            },
            {
                "kind": "poster",
                "directory": format!("{PROJECT_DATA_DIR}/{POSTER_DIR}"),
                "description": "Poster sources and rendered poster outputs."
            },
            {
                "kind": "report",
                "directory": format!("{PROJECT_DATA_DIR}/{REPORTS_DIR}"),
                "description": "LaTeX research report sources and rendered PDFs."
            },
            {
                "kind": "web",
                "directory": format!("{PROJECT_DATA_DIR}/{WEB_DIR}/<name>"),
                "description": "Interactive web apps with index.html plus local CSS/assets."
            },
            {
                "kind": "notebook",
                "directory": format!("{PROJECT_DATA_DIR}/{NOTEBOOKS_DIR}"),
                "description": "Source Jupyter notebooks opened and edited by Lab."
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
            "note": "Existing root-level artifact folders remain readable, but newly generated artifacts are stored under .somniq/."
        }
    })
}

#[cfg(test)]
#[path = "tests/layout.rs"]
mod tests;

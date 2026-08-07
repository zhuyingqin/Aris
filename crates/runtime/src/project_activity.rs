use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{now_iso8601, write_file_atomically};

const ACTIVITY_DIR: &str = ".somniq";
const ACTIVITY_FILE: &str = "project-activity.json";
const MAX_CORE_FOCUS_CHARS: usize = 900;
const MAX_RELATED_WORK_ITEMS: usize = 5;
const MAX_RELATED_WORK_CHARS: usize = 500;
const MAX_REVIEWER_CHARS: usize = 200;
const MAX_FINGERPRINT_CHARS: usize = 160;
const MAX_DRIFT_CHARS: usize = 400;

/// LLM-curated view of what the project is currently doing across its saved
/// conversations. Unlike `ProjectIntent`, this is deliberately refreshable:
/// stable purpose and current activity have different lifecycles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivity {
    pub core_focus: String,
    #[serde(default)]
    pub related_work: Vec<String>,
    pub conversation_count: usize,
    pub message_count: usize,
    #[serde(default)]
    pub question_count: usize,
    #[serde(default)]
    pub session_cursors: BTreeMap<String, String>,
    #[serde(default)]
    pub context_checkpoints: BTreeMap<String, ProjectActivityContextCheckpoint>,
    pub reviewer: String,
    pub source_fingerprint: String,
    pub reviewed_at: String,
    /// Set when the review found the recent delta working off the main line
    /// *without* concluding the main line itself changed. This is the signal a
    /// human would otherwise have to supply ("that's not the main thread") —
    /// see [`crate::render_project_goal_prompt`], which surfaces it to the
    /// model. `None` once a later review no longer sees the deviation.
    #[serde(default)]
    pub drift: Option<ProjectActivityDrift>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivityDrift {
    /// What the recent work was actually spent on.
    pub evidence: String,
    /// The concrete way back to the main line.
    pub suggestion: String,
    pub detected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectActivityDriftDraft {
    pub evidence: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivityContextCheckpoint {
    pub context_tokens: usize,
    pub compaction_budget: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectActivityDraft {
    pub core_focus: String,
    pub related_work: Vec<String>,
    pub conversation_count: usize,
    pub message_count: usize,
    pub question_count: usize,
    pub session_cursors: BTreeMap<String, String>,
    pub context_checkpoints: BTreeMap<String, ProjectActivityContextCheckpoint>,
    pub reviewer: String,
    pub source_fingerprint: String,
    pub drift: Option<ProjectActivityDriftDraft>,
}

#[must_use]
pub fn project_activity_path(workspace: &Path) -> PathBuf {
    workspace.join(ACTIVITY_DIR).join(ACTIVITY_FILE)
}

pub fn load_project_activity(workspace: &Path) -> Result<Option<ProjectActivity>, String> {
    let path = project_activity_path(workspace);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("invalid project activity at {}: {error}", path.display()))
}

pub fn clear_project_activity(workspace: &Path) -> Result<(), String> {
    match std::fs::remove_file(project_activity_path(workspace)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_project_activity(
    workspace: &Path,
    draft: ProjectActivityDraft,
) -> Result<ProjectActivity, String> {
    let core_focus = clean_required(&draft.core_focus, MAX_CORE_FOCUS_CHARS, "core focus")?;
    let related_work = draft
        .related_work
        .into_iter()
        .filter_map(|item| clean_optional(&item, MAX_RELATED_WORK_CHARS))
        .filter(|item| item != &core_focus)
        .take(MAX_RELATED_WORK_ITEMS)
        .collect();
    let reviewer = clean_optional(&draft.reviewer, MAX_REVIEWER_CHARS)
        .unwrap_or_else(|| "LLM reviewer".to_string());
    let source_fingerprint = clean_required(
        &draft.source_fingerprint,
        MAX_FINGERPRINT_CHARS,
        "source fingerprint",
    )?;
    // A drift report is only meaningful when it says *what* was spent and
    // *where to go back to*; a half-filled one is dropped rather than shown as
    // an unactionable warning.
    let drift = draft.drift.and_then(|drift| {
        Some(ProjectActivityDrift {
            evidence: clean_optional(&drift.evidence, MAX_DRIFT_CHARS)?,
            suggestion: clean_optional(&drift.suggestion, MAX_DRIFT_CHARS)?,
            detected_at: now_iso8601(),
        })
    });
    let activity = ProjectActivity {
        core_focus,
        related_work,
        conversation_count: draft.conversation_count,
        message_count: draft.message_count,
        question_count: draft.question_count,
        session_cursors: draft.session_cursors,
        context_checkpoints: draft.context_checkpoints,
        reviewer,
        source_fingerprint,
        reviewed_at: now_iso8601(),
        drift,
    };
    write_project_activity(workspace, &activity)?;
    Ok(activity)
}

pub fn update_project_activity_tracking(
    workspace: &Path,
    session_cursors: Option<BTreeMap<String, String>>,
    session_id: String,
    checkpoint: ProjectActivityContextCheckpoint,
) -> Result<Option<ProjectActivity>, String> {
    let Some(mut activity) = load_project_activity(workspace)? else {
        return Ok(None);
    };
    if let Some(session_cursors) = session_cursors {
        activity.session_cursors = session_cursors;
    }
    activity.context_checkpoints.insert(session_id, checkpoint);
    write_project_activity(workspace, &activity)?;
    Ok(Some(activity))
}

fn write_project_activity(workspace: &Path, activity: &ProjectActivity) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(activity).map_err(|error| error.to_string())?;
    write_file_atomically(&project_activity_path(workspace), body)
        .map_err(|error| error.to_string())
}

fn clean_required(value: &str, max_chars: usize, label: &str) -> Result<String, String> {
    clean_optional(value, max_chars).ok_or_else(|| format!("{label} cannot be empty"))
}

fn clean_optional(value: &str, max_chars: usize) -> Option<String> {
    let value = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
#[path = "tests/project_activity.rs"]
mod tests;

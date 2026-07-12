use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{now_iso8601, write_file_atomically};

const INTENT_DIR: &str = ".somniq";
const INTENT_FILE: &str = "project-intent.json";
const MAX_EVIDENCE: usize = 24;
const MAX_EVIDENCE_CHARS: usize = 1_200;
const MAX_OBJECTIVE_CHARS: usize = 800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectIntentStatus {
    Emerging,
    Established,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntent {
    pub objective: String,
    pub confidence: u8,
    pub status: ProjectIntentStatus,
    pub evidence_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentObservation {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentEvidence {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectIntentDraft {
    pub objective: String,
    pub confidence: u8,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentState {
    #[serde(default)]
    pub intent: Option<ProjectIntent>,
    #[serde(default)]
    pub evidence: Vec<ProjectIntentEvidence>,
    #[serde(default)]
    pub reviewed_evidence_count: usize,
}

#[must_use]
pub fn project_intent_path(workspace: &Path) -> PathBuf {
    workspace.join(INTENT_DIR).join(INTENT_FILE)
}

pub fn load_project_intent_state(workspace: &Path) -> Result<ProjectIntentState, String> {
    let path = project_intent_path(workspace);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ProjectIntentState::default()),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str(&raw)
        .map_err(|error| format!("invalid project intent at {}: {error}", path.display()))
}

pub fn load_project_intent(workspace: &Path) -> Result<Option<ProjectIntent>, String> {
    Ok(load_project_intent_state(workspace)?.intent)
}

pub fn record_project_intent_observations(
    workspace: &Path,
    session_id: &str,
    observations: Vec<ProjectIntentObservation>,
) -> Result<ProjectIntentState, String> {
    let mut state = load_project_intent_state(workspace)?;
    let session_id = clean_text(session_id, 160);
    let mut changed = false;

    for observation in observations {
        let id = clean_text(&observation.id, 160);
        let text = clean_text(&observation.text, MAX_EVIDENCE_CHARS);
        if id.is_empty() || text.is_empty() {
            continue;
        }
        if state
            .evidence
            .iter()
            .any(|item| item.session_id == session_id && item.id == id)
        {
            continue;
        }
        state.evidence.push(ProjectIntentEvidence {
            id,
            session_id: session_id.clone(),
            text,
            observed_at: now_iso8601(),
        });
        changed = true;
    }

    if state.evidence.len() > MAX_EVIDENCE {
        let overflow = state.evidence.len() - MAX_EVIDENCE;
        state.evidence.drain(0..overflow);
        state.reviewed_evidence_count = state.reviewed_evidence_count.min(state.evidence.len());
        changed = true;
    }
    if changed {
        save_project_intent_state(workspace, &state)?;
    }
    Ok(state)
}

#[must_use]
pub fn project_intent_needs_review(state: &ProjectIntentState) -> bool {
    state.evidence.len() >= 2
        && state.evidence.len() > state.reviewed_evidence_count
        && !matches!(state.intent.as_ref().map(|intent| intent.status), Some(ProjectIntentStatus::Established))
}

pub fn apply_project_intent_review(
    workspace: &Path,
    draft: Option<ProjectIntentDraft>,
) -> Result<Option<ProjectIntent>, String> {
    let mut state = load_project_intent_state(workspace)?;
    state.reviewed_evidence_count = state.evidence.len();

    if !matches!(state.intent.as_ref().map(|intent| intent.status), Some(ProjectIntentStatus::Established)) {
        if let Some(draft) = draft {
            let objective = clean_text(&draft.objective, MAX_OBJECTIVE_CHARS);
            if !objective.is_empty() {
                let now = now_iso8601();
                let confidence = draft.confidence.min(100);
                let status = if state.evidence.len() >= 3 && confidence >= 85 {
                    ProjectIntentStatus::Established
                } else {
                    ProjectIntentStatus::Emerging
                };
                let created_at = state
                    .intent
                    .as_ref()
                    .map(|intent| intent.created_at.clone())
                    .unwrap_or_else(|| now.clone());
                state.intent = Some(ProjectIntent {
                    objective,
                    confidence,
                    status,
                    evidence_count: state.evidence.len(),
                    created_at,
                    updated_at: now,
                });
            }
        }
    }

    save_project_intent_state(workspace, &state)?;
    Ok(state.intent)
}

fn save_project_intent_state(workspace: &Path, state: &ProjectIntentState) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    write_file_atomically(&project_intent_path(workspace), body).map_err(|error| error.to_string())
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

#[cfg(test)]
#[path = "tests/project_intent.rs"]
mod tests;

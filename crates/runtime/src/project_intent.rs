use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

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
    /// Exact USER observations the reviewer cited for this objective. Keeping
    /// the records with the intent makes the conclusion auditable even after
    /// the rolling candidate-evidence buffer advances.
    #[serde(default)]
    pub supporting_evidence: Vec<ProjectIntentEvidence>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentObservation {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectIntentEvidenceRole {
    #[default]
    User,
    Assistant,
}

impl ProjectIntentEvidenceRole {
    #[must_use]
    pub const fn prompt_label(self) -> &'static str {
        match self {
            Self::User => "USER",
            Self::Assistant => "ASSISTANT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentEvidence {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub observed_at: String,
    /// Older state files predate explicit source attribution. They contain only
    /// frontend-captured user turns, so default them to `User` on migration.
    #[serde(default)]
    pub role: ProjectIntentEvidenceRole,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectIntentDraft {
    pub objective: String,
    pub confidence: u8,
    /// Set by the intent reviewer when the proposed objective is only a
    /// wording change of the existing durable intent. Keeping the stored text
    /// in that case prevents punctuation or paraphrase churn from becoming a
    /// false redirection.
    pub matches_existing_intent: bool,
    /// Exact USER evidence IDs that support the proposed objective. A new or
    /// redirected intent is not applied without at least two valid citations.
    pub supporting_evidence_ids: Vec<String>,
    /// IDs of recent USER evidence that each explicitly redirects the project
    /// to the same proposed durable objective. Required before an established
    /// intent can be replaced.
    pub redirection_evidence_ids: Vec<String>,
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectIntentState::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut state: ProjectIntentState = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid project intent at {}: {error}", path.display()))?;
    if prune_non_substantive_evidence(&mut state) || sort_evidence_oldest_first(&mut state) {
        save_project_intent_state(workspace, &state)?;
    }
    Ok(state)
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
    // Project intent is a curated continuity signal, not a second transcript.
    // Older builds admitted greetings, test pings, and single-option replies;
    // prune those here while the complete auditable conversation remains in
    // session storage.
    let pruned = prune_non_substantive_evidence(&mut state);
    let session_id = clean_text(session_id, 160);
    let mut changed = pruned;

    for observation in observations {
        let id = clean_text(&observation.id, 160);
        let text = clean_text(&observation.text, MAX_EVIDENCE_CHARS);
        if id.is_empty() || !is_substantive_project_intent_text(&text) {
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
            role: ProjectIntentEvidenceRole::User,
        });
        changed = true;
    }

    changed |= sort_evidence_oldest_first(&mut state);
    if state.evidence.len() > MAX_EVIDENCE {
        let overflow = state.evidence.len() - MAX_EVIDENCE;
        state.evidence.drain(0..overflow);
        state.reviewed_evidence_count = state.reviewed_evidence_count.saturating_sub(overflow);
        if let Some(intent) = state.intent.as_mut() {
            intent.evidence_count = intent.evidence_count.saturating_sub(overflow);
        }
        changed = true;
    }
    if changed {
        save_project_intent_state(workspace, &state)?;
    }
    Ok(state)
}

fn prune_non_substantive_evidence(state: &mut ProjectIntentState) -> bool {
    let before = state.evidence.len();
    state
        .evidence
        .retain(|item| is_substantive_project_intent_text(&item.text));
    let changed = state.evidence.len() != before;
    if changed {
        let removed = before - state.evidence.len();
        state.reviewed_evidence_count = state.reviewed_evidence_count.saturating_sub(removed);
        if let Some(intent) = state.intent.as_mut() {
            intent.evidence_count = intent.evidence_count.saturating_sub(removed);
        }
    }
    changed
}

/// Persist evidence in the same chronological order promised to the intent
/// reviewer. `sort_by` is stable, so equal-resolution timestamps retain their
/// original insertion order.
fn sort_evidence_oldest_first(state: &mut ProjectIntentState) -> bool {
    let ordered = state
        .evidence
        .windows(2)
        .all(|pair| pair[0].observed_at <= pair[1].observed_at);
    if !ordered {
        state
            .evidence
            .sort_by(|left, right| left.observed_at.cmp(&right.observed_at));
    }
    !ordered
}

#[must_use]
pub fn is_substantive_project_intent_text(value: &str) -> bool {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    let compact = lower
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<String>();
    if compact.chars().count() <= 3 {
        return false;
    }
    if matches!(
        compact.as_str(),
        "hello"
            | "hi"
            | "hey"
            | "ok"
            | "okay"
            | "yes"
            | "no"
            | "thanks"
            | "thankyou"
            | "你好"
            | "您好"
            | "谢谢"
            | "好的"
            | "可以"
            | "继续"
    ) {
        return false;
    }
    let short_test_ping = compact.chars().count() <= 24
        && [
            "test",
            "testing",
            "letmeseeif",
            "测试",
            "试一下",
            "我来看看",
            "看看能不能",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
    !short_test_ping
}

#[must_use]
pub fn project_intent_needs_review(state: &ProjectIntentState) -> bool {
    if state.evidence.len() < 2 {
        return false;
    }
    if state
        .intent
        .as_ref()
        .is_some_and(|intent| intent.supporting_evidence.len() < 2)
    {
        return true;
    }
    if state.evidence.len() <= state.reviewed_evidence_count {
        return false;
    }
    match state.intent.as_ref() {
        Some(intent) if intent.status == ProjectIntentStatus::Established => {
            state.evidence.len().saturating_sub(intent.evidence_count) >= 3
        }
        _ => true,
    }
}

pub fn apply_project_intent_review(
    workspace: &Path,
    draft: Option<ProjectIntentDraft>,
) -> Result<Option<ProjectIntent>, String> {
    let mut state = load_project_intent_state(workspace)?;
    state.reviewed_evidence_count = state.evidence.len();
    let mut applied = false;

    if let Some(draft) = draft {
        let proposed_objective = clean_text(&draft.objective, MAX_OBJECTIVE_CHARS);
        if !proposed_objective.is_empty() {
            let now = now_iso8601();
            let confidence = draft.confidence.min(100);
            let previous = state.intent.as_ref();
            let unchanged = previous.is_some_and(|intent| {
                objectives_equivalent(&intent.objective, &proposed_objective)
                    || draft.matches_existing_intent
            });
            let objective = previous
                .filter(|_| unchanged)
                .map(|intent| intent.objective.clone())
                .unwrap_or(proposed_objective);
            let mut supporting_evidence = if unchanged {
                previous
                    .map(|intent| intent.supporting_evidence.clone())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            merge_supporting_evidence(
                &mut supporting_evidence,
                cited_user_evidence(&state.evidence, &draft.supporting_evidence_ids),
            );
            // Redirection citations support the replacement by definition and
            // are still validated as USER evidence below.
            merge_supporting_evidence(
                &mut supporting_evidence,
                cited_user_evidence(&state.evidence, &draft.redirection_evidence_ids),
            );
            let sustained_redirection = previous.is_none_or(|intent| {
                intent.status != ProjectIntentStatus::Established
                    || has_explicit_consistent_redirection(
                        &state.evidence,
                        intent.evidence_count,
                        &draft.redirection_evidence_ids,
                    )
            });
            let support_sufficient = supporting_evidence.len() >= 2
                || (unchanged
                    && previous
                        .is_some_and(|intent| intent.status == ProjectIntentStatus::Established));
            // An established intent is stable, but no longer immutable. Require
            // three distinct recent USER messages that the reviewer identifies
            // as explicit, mutually consistent redirection evidence. A raw
            // evidence count plus confidence cannot establish that semantic
            // condition and lets punctuation-only paraphrases rewrite state.
            if support_sufficient
                && (previous.is_none() || unchanged || (sustained_redirection && confidence >= 85))
            {
                let status = if unchanged
                    && previous
                        .is_some_and(|intent| intent.status == ProjectIntentStatus::Established)
                {
                    ProjectIntentStatus::Established
                } else if state.evidence.len() >= 3 && confidence >= 85 {
                    ProjectIntentStatus::Established
                } else {
                    ProjectIntentStatus::Emerging
                };
                let created_at = previous
                    .map(|intent| intent.created_at.clone())
                    .unwrap_or_else(|| now.clone());
                state.intent = Some(ProjectIntent {
                    objective,
                    confidence,
                    status,
                    evidence_count: state.evidence.len(),
                    supporting_evidence,
                    created_at,
                    updated_at: now,
                });
                applied = true;
            }
        }
    }
    if !applied {
        let evidence_count = state.evidence.len();
        if let Some(intent) = state.intent.as_mut() {
            // The new batch was reviewed but did not establish a replacement.
            // Advance its evidence baseline so the same batch is not re-reviewed
            // after every subsequent message.
            intent.evidence_count = evidence_count;
        }
    }

    save_project_intent_state(workspace, &state)?;
    Ok(state.intent)
}

fn cited_user_evidence(
    evidence: &[ProjectIntentEvidence],
    cited_ids: &[String],
) -> Vec<ProjectIntentEvidence> {
    let cited = cited_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    evidence
        .iter()
        .filter(|item| {
            item.role == ProjectIntentEvidenceRole::User && cited.contains(item.id.as_str())
        })
        .cloned()
        .collect()
}

fn merge_supporting_evidence(
    target: &mut Vec<ProjectIntentEvidence>,
    incoming: Vec<ProjectIntentEvidence>,
) {
    for item in incoming {
        if !target
            .iter()
            .any(|existing| existing.session_id == item.session_id && existing.id == item.id)
        {
            target.push(item);
        }
    }
    target.sort_by(|left, right| left.observed_at.cmp(&right.observed_at));
    if target.len() > 8 {
        target.drain(0..target.len() - 8);
    }
}

fn objectives_equivalent(left: &str, right: &str) -> bool {
    fn normalize(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }

    normalize(left) == normalize(right)
}

fn has_explicit_consistent_redirection(
    evidence: &[ProjectIntentEvidence],
    evidence_start: usize,
    redirection_evidence_ids: &[String],
) -> bool {
    let recent_user_ids = evidence
        .iter()
        .skip(evidence_start)
        .filter(|item| item.role == ProjectIntentEvidenceRole::User)
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let cited_ids = redirection_evidence_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();

    cited_ids.len() >= 3 && cited_ids.iter().all(|id| recent_user_ids.contains(*id))
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

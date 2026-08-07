use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{now_iso8601, write_file_atomically};

const GOAL_DIR: &str = ".somniq";
const GOAL_FILE: &str = "project-goal.json";
const MAX_OBJECTIVE_CHARS: usize = 800;
const MAX_CRITERION_CHARS: usize = 500;
const MAX_STATUS_CHARS: usize = 800;
const MAX_MISSION_CHARS: usize = 900;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectGoalStatus {
    Active,
    Paused,
    Complete,
}

impl ProjectGoalStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Complete => "complete",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoal {
    pub objective: String,
    pub success_criteria: Vec<String>,
    #[serde(default)]
    pub verified_criteria: Vec<ProjectGoalCriterionVerification>,
    pub recent_status: String,
    pub status: ProjectGoalStatus,
    pub source_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalCriterionVerification {
    pub criterion_index: usize,
    pub evidence: Vec<String>,
    pub reviewer: String,
    pub verified_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalDraft {
    pub objective: String,
    #[serde(default)]
    pub success_criteria: Vec<String>,
    #[serde(default)]
    pub recent_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBrief {
    pub mission: String,
    pub activity: Option<crate::ProjectActivity>,
    pub intent: Option<crate::ProjectIntent>,
    pub goal: Option<ProjectGoal>,
}

#[must_use]
pub fn project_goal_path(workspace: &Path) -> PathBuf {
    workspace.join(GOAL_DIR).join(GOAL_FILE)
}

pub fn load_project_goal(workspace: &Path) -> Result<Option<ProjectGoal>, String> {
    let path = project_goal_path(workspace);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let goal = serde_json::from_str::<ProjectGoal>(&raw)
        .map_err(|error| format!("invalid project goal at {}: {error}", path.display()))?;
    // Older Desktop builds could promote a one-turn conversational answer into
    // durable project state. Once stored, that goal was injected into every
    // later system prompt (for example, repeatedly announcing the model's
    // identity). Keep the file for forensic/recovery purposes, but quarantine
    // it from project continuity and let the next real milestone replace it.
    if is_one_off_identity_answer_goal(&goal.objective, &goal.success_criteria) {
        return Ok(None);
    }
    Ok(Some(goal))
}

pub fn project_brief(workspace: &Path) -> Result<ProjectBrief, String> {
    Ok(ProjectBrief {
        mission: project_mission(workspace).unwrap_or_else(|| {
            let name = workspace
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Current project");
            format!("{name}: define the durable project mission in AGENTS.md.")
        }),
        activity: crate::load_project_activity(workspace)?,
        intent: crate::load_project_intent(workspace)?,
        goal: load_project_goal(workspace)?,
    })
}

pub fn start_project_goal(
    workspace: &Path,
    draft: ProjectGoalDraft,
    source_session_id: Option<String>,
) -> Result<ProjectGoal, String> {
    if let Some(goal) = load_project_goal(workspace)? {
        if goal.status != ProjectGoalStatus::Complete {
            return Err(match goal.status {
                ProjectGoalStatus::Active => {
                    "an active project goal already exists; use /goal replace <objective>"
                        .to_string()
                }
                ProjectGoalStatus::Paused => {
                    "a paused project goal already exists; use /goal resume or /goal replace <objective>"
                        .to_string()
                }
                ProjectGoalStatus::Complete => unreachable!(),
            });
        }
    }
    write_new_goal(workspace, draft, source_session_id)
}

pub fn replace_project_goal(
    workspace: &Path,
    draft: ProjectGoalDraft,
    source_session_id: Option<String>,
) -> Result<ProjectGoal, String> {
    write_new_goal(workspace, draft, source_session_id)
}

fn write_new_goal(
    workspace: &Path,
    draft: ProjectGoalDraft,
    source_session_id: Option<String>,
) -> Result<ProjectGoal, String> {
    let now = now_iso8601();
    let objective = clean_required(&draft.objective, MAX_OBJECTIVE_CHARS, "goal objective")?;
    let success_criteria = clean_criteria(draft.success_criteria);
    if is_one_off_identity_answer_goal(&objective, &success_criteria) {
        return Err(
            "a one-off model identity answer cannot be stored as a project milestone".to_string(),
        );
    }
    let recent_status = clean_optional(&draft.recent_status, MAX_STATUS_CHARS)
        .unwrap_or_else(|| "Goal captured; work has not been verified complete yet.".to_string());
    let goal = ProjectGoal {
        objective,
        success_criteria,
        verified_criteria: Vec::new(),
        recent_status,
        status: ProjectGoalStatus::Active,
        source_session_id: source_session_id
            .map(|value| clean_text(&value, 160))
            .filter(|value| !value.is_empty()),
        created_at: now.clone(),
        updated_at: now,
    };
    save_project_goal(workspace, &goal)?;
    Ok(goal)
}

pub fn pause_project_goal(workspace: &Path) -> Result<ProjectGoal, String> {
    update_goal(workspace, |goal| {
        if goal.status != ProjectGoalStatus::Active {
            return Err("only an active project goal can be paused".to_string());
        }
        goal.status = ProjectGoalStatus::Paused;
        goal.recent_status = "Goal paused by the user.".to_string();
        Ok(())
    })
}

pub fn resume_project_goal(workspace: &Path) -> Result<ProjectGoal, String> {
    update_goal(workspace, |goal| {
        if goal.status != ProjectGoalStatus::Paused {
            return Err("only a paused project goal can be resumed".to_string());
        }
        goal.status = ProjectGoalStatus::Active;
        goal.recent_status =
            "Goal resumed; continue toward the recorded success criteria.".to_string();
        Ok(())
    })
}

pub fn complete_project_goal(
    workspace: &Path,
    recent_status: Option<&str>,
) -> Result<ProjectGoal, String> {
    update_goal(workspace, |goal| {
        if goal.status == ProjectGoalStatus::Complete {
            return Err("project goal is already complete".to_string());
        }
        goal.status = ProjectGoalStatus::Complete;
        goal.recent_status = recent_status
            .and_then(|value| clean_optional(value, MAX_STATUS_CHARS))
            .unwrap_or_else(|| "Goal marked complete by the user.".to_string());
        Ok(())
    })
}

pub fn update_project_goal_progress(
    workspace: &Path,
    recent_status: &str,
) -> Result<Option<ProjectGoal>, String> {
    let Some(mut goal) = load_project_goal(workspace)? else {
        return Ok(None);
    };
    if goal.status != ProjectGoalStatus::Active {
        return Ok(Some(goal));
    }
    let Some(status) = clean_optional(recent_status, MAX_STATUS_CHARS) else {
        return Ok(Some(goal));
    };
    goal.recent_status = status;
    goal.updated_at = now_iso8601();
    save_project_goal(workspace, &goal)?;
    Ok(Some(goal))
}

pub fn update_project_goal_verified_progress(
    workspace: &Path,
    recent_status: &str,
    criteria_indices: &[usize],
    evidence: &[String],
    reviewer: &str,
) -> Result<Option<ProjectGoal>, String> {
    let Some(mut goal) = load_project_goal(workspace)? else {
        return Ok(None);
    };
    if goal.status != ProjectGoalStatus::Active {
        return Ok(Some(goal));
    }
    let valid_criteria_indices = criteria_indices
        .iter()
        .copied()
        .filter(|index| *index < goal.success_criteria.len())
        .collect::<std::collections::BTreeSet<_>>();
    if valid_criteria_indices.is_empty() {
        return Ok(Some(goal));
    }
    let Some(status) = clean_optional(recent_status, MAX_STATUS_CHARS) else {
        return Ok(Some(goal));
    };
    let evidence = evidence
        .iter()
        .filter_map(|item| clean_optional(item, MAX_CRITERION_CHARS))
        .take(8)
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return Ok(Some(goal));
    }
    let reviewer =
        clean_optional(reviewer, 200).unwrap_or_else(|| "independent Reviewer".to_string());
    let verified_at = now_iso8601();
    for criterion_index in valid_criteria_indices {
        let verification = ProjectGoalCriterionVerification {
            criterion_index,
            evidence: evidence.clone(),
            reviewer: reviewer.clone(),
            verified_at: verified_at.clone(),
        };
        if let Some(existing) = goal
            .verified_criteria
            .iter_mut()
            .find(|item| item.criterion_index == criterion_index)
        {
            *existing = verification;
        } else {
            goal.verified_criteria.push(verification);
        }
    }
    goal.verified_criteria
        .sort_by_key(|verification| verification.criterion_index);
    goal.recent_status = status;
    goal.updated_at = verified_at;
    save_project_goal(workspace, &goal)?;
    Ok(Some(goal))
}

fn update_goal(
    workspace: &Path,
    mutate: impl FnOnce(&mut ProjectGoal) -> Result<(), String>,
) -> Result<ProjectGoal, String> {
    let mut goal = load_project_goal(workspace)?
        .ok_or_else(|| "no project goal exists; use /goal start <objective>".to_string())?;
    mutate(&mut goal)?;
    goal.updated_at = now_iso8601();
    save_project_goal(workspace, &goal)?;
    Ok(goal)
}

fn save_project_goal(workspace: &Path, goal: &ProjectGoal) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(goal).map_err(|error| error.to_string())?;
    write_file_atomically(&project_goal_path(workspace), body).map_err(|error| error.to_string())
}

#[must_use]
pub fn render_project_goal_prompt(workspace: &Path) -> String {
    let intent = crate::load_project_intent(workspace).ok().flatten();
    let activity = crate::load_project_activity(workspace).ok().flatten();
    let goal = load_project_goal(workspace).ok().flatten();
    let mut lines = vec!["# Project continuity".to_string()];
    if let Some(intent) = intent {
        lines.push(format!("Long-term project intent: {}", intent.objective));
        lines.push(format!("Intent confidence: {}%", intent.confidence));
        lines.push("Keep this stable across conversations. Do not replace it merely because the latest request is a short-term task.".to_string());
    } else {
        lines.push("Long-term project intent: still being inferred from repeated substantive user requests. Do not treat a single short-term task as the project objective.".to_string());
    }
    // The curated main line. Without it the model can only see the intent (too
    // abstract to notice a detour from) and the milestone (which a detour
    // quietly redefines), so noticing "this is no longer the main thread" was
    // left entirely to the user. See `ProjectActivity`.
    if let Some(activity) = activity {
        lines.push(format!("Current main line: {}", activity.core_focus));
        if !activity.related_work.is_empty() {
            lines.push(format!(
                "Secondary work streams: {}",
                activity.related_work.join("; ")
            ));
        }
        lines.push("The main line is what this project is actually working on now, curated from all of its conversations. It is not the milestone below: the milestone is one step, the main line is the through-line the steps serve.".to_string());
        lines.push("Before starting a sub-investigation, and again whenever one has run long, state which of these the current work serves: the main line, a listed secondary stream, or neither. If neither, say so explicitly and get the user's agreement before continuing — do not drift onto it silently, and do not redefine the main line to match what you happen to be doing.".to_string());
        if let Some(drift) = &activity.drift {
            lines.push(format!(
                "Main-line deviation flagged by the last project review: {}",
                drift.evidence
            ));
            lines.push(format!("Suggested way back: {}", drift.suggestion));
            lines.push("Treat this as the reminder the user would otherwise have to give you. Resolve it before sinking further effort into the deviation: either finish the deviation in the next few steps, or park it and return to the main line.".to_string());
        }
    } else {
        lines.push("Current main line: not curated yet (too few saved conversations, or the project summary review is disabled). Fall back to the intent and milestone below, and ask the user what the main thread is rather than assuming the sub-problem in front of you is it.".to_string());
    }
    if let Some(goal) = goal.filter(|goal| goal.status == ProjectGoalStatus::Active) {
        lines.push(format!("Current milestone: {}", goal.objective));
        lines.push(format!("Milestone status: {}", goal.recent_status));
        if goal.success_criteria.is_empty() {
            lines.push("Milestone success criteria: not recorded. Do not claim the milestone is complete without asking for or deriving checkable criteria.".to_string());
        } else {
            lines.push("Milestone success criteria:".to_string());
            lines.extend(
                goal.success_criteria
                    .iter()
                    .enumerate()
                    .map(|(index, criterion)| {
                        let verified = goal
                            .verified_criteria
                            .iter()
                            .any(|item| item.criterion_index == index);
                        format!(
                            "- [{}] [{index}] {criterion}",
                            if verified { "verified" } else { "pending" }
                        )
                    }),
            );
        }
        lines.push("Progress may be updated only from concrete tool/test/artifact evidence after an independent Reviewer passes the result. Never treat an Assistant completion claim or polished prose as evidence by itself.".to_string());
    } else {
        lines.push("Current milestone: none active. Do not turn a greeting, model-identity question, simple factual answer, or other one-off chat request into durable project state.".to_string());
    }
    lines.join("\n")
}

fn is_one_off_identity_answer_goal(objective: &str, criteria: &[String]) -> bool {
    let objective = objective.to_lowercase();
    let identity_signal = [
        "模型身份",
        "助手模型",
        "模型名称",
        "model identity",
        "assistant identity",
        "model name",
    ]
    .iter()
    .any(|marker| objective.contains(marker))
        || criteria.iter().any(|criterion| {
            let lower = criterion.to_lowercase();
            ["模型身份", "模型名称", "model identity", "model name"]
                .iter()
                .any(|marker| lower.contains(marker))
        });
    if !identity_signal {
        return false;
    }

    let answer_signal = [
        "回答用户",
        "回复用户",
        "answer the user",
        "answer user's",
        "respond to the user",
    ]
    .iter()
    .any(|marker| objective.contains(marker));
    let conversational_criteria = criteria
        .iter()
        .filter(|criterion| {
            let lower = criterion.to_lowercase();
            [
                "用户提出",
                "用户询问",
                "助手明确",
                "回答语言",
                "与用户一致",
                "user asks",
                "user asked",
                "assistant states",
                "response language",
                "same language as the user",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
        })
        .count();

    answer_signal || conversational_criteria >= 2
}

#[must_use]
pub fn render_project_goal_report(goal: Option<&ProjectGoal>) -> String {
    let Some(goal) = goal else {
        return "Project goal\n  Status           not set\n  Usage            /goal start <objective>".to_string();
    };
    let criteria = if goal.success_criteria.is_empty() {
        "(not recorded)".to_string()
    } else {
        goal.success_criteria
            .iter()
            .map(|item| format!("    - {item}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Project goal\n  Status           {}\n  Objective        {}\n  Success criteria\n{}\n  Recent status    {}\n  Updated          {}",
        goal.status.as_str(),
        goal.objective,
        criteria,
        goal.recent_status,
        goal.updated_at
    )
}

fn project_mission(workspace: &Path) -> Option<String> {
    [
        workspace.join("AGENTS.md"),
        workspace.join(".somniq").join("AGENTS.md"),
    ]
    .into_iter()
    .filter_map(|path| fs::read_to_string(path).ok())
    .find_map(|content| mission_section(&content))
}

fn mission_section(markdown: &str) -> Option<String> {
    const HEADINGS: [&str; 4] = [
        "product north star",
        "project mission",
        "产品北极星",
        "项目使命",
    ];
    let mut in_section = false;
    let mut lines = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("## ") {
            if in_section {
                break;
            }
            in_section = HEADINGS
                .iter()
                .any(|candidate| heading.trim().eq_ignore_ascii_case(candidate));
            continue;
        }
        if in_section && !trimmed.is_empty() {
            lines.push(trimmed.trim_start_matches(['-', '*']).trim());
        }
    }
    let mission = clean_text(&lines.join(" "), MAX_MISSION_CHARS);
    (!mission.is_empty()).then_some(mission)
}

fn clean_required(value: &str, max_chars: usize, label: &str) -> Result<String, String> {
    let cleaned = clean_text(value, max_chars);
    if cleaned.is_empty() {
        Err(format!("{label} cannot be empty"))
    } else {
        Ok(cleaned)
    }
}

fn clean_optional(value: &str, max_chars: usize) -> Option<String> {
    let cleaned = clean_text(value, max_chars);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean_criteria(criteria: Vec<String>) -> Vec<String> {
    let mut cleaned = criteria
        .into_iter()
        .map(|criterion| clean_text(&criterion, MAX_CRITERION_CHARS))
        .filter(|criterion| !criterion.is_empty())
        .take(6)
        .collect::<Vec<_>>();
    if cleaned.is_empty() {
        cleaned.push("The requested outcome is delivered in the project workspace.".to_string());
        cleaned.push("Relevant checks or evidence confirm the outcome.".to_string());
    }
    cleaned
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
#[path = "tests/project_goal.rs"]
mod tests;

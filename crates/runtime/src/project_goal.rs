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
    pub recent_status: String,
    pub status: ProjectGoalStatus,
    pub source_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("invalid project goal at {}: {error}", path.display()))
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
    let recent_status = clean_optional(&draft.recent_status, MAX_STATUS_CHARS)
        .unwrap_or_else(|| "Goal captured; work has not been verified complete yet.".to_string());
    let goal = ProjectGoal {
        objective,
        success_criteria,
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
    let Ok(Some(goal)) = load_project_goal(workspace) else {
        return "# Project goal\nNo project-level goal is currently recorded. When the user's first substantive request defines a concrete outcome, summarize it into a goal with observable success criteria.".to_string();
    };
    let mut lines = vec![
        "# Project goal".to_string(),
        format!("Status: {}", goal.status.as_str()),
        format!("Objective: {}", goal.objective),
    ];
    if !goal.success_criteria.is_empty() {
        lines.push("Success criteria:".to_string());
        lines.extend(
            goal.success_criteria
                .iter()
                .map(|criterion| format!("- {criterion}")),
        );
    }
    lines.push(format!("Recent status: {}", goal.recent_status));
    lines.push(format!("Updated at: {}", goal.updated_at));
    if goal.status == ProjectGoalStatus::Active {
        lines.push("Treat this as durable project context across conversations. The user's latest explicit request may refine or replace it.".to_string());
    }
    lines.join("\n")
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

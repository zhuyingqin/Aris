use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const COORDINATION_TOOLS: &[&str] = &[
    "SpawnTeammate",
    "SendMessage",
    "ClaimTask",
    "CompleteTask",
    "ListTeam",
    "AgentSupervisor",
    "Workflow",
    "EnterWorktree",
];

const STATE_VERSION: u32 = 1;
const DEFAULT_MAX_TEAMMATES: usize = 4;
const MAX_TEAMMATES_HARD_LIMIT: usize = 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpawnTeammateInput {
    pub(crate) team_id: Option<String>,
    pub(crate) team_name: Option<String>,
    pub(crate) team_design: Option<TeamDesignContract>,
    pub(crate) lead_session: Option<String>,
    pub(crate) description: String,
    pub(crate) prompt: String,
    pub(crate) subagent_type: Option<String>,
    pub(crate) role: Option<String>,
    pub(crate) responsibility: Option<String>,
    pub(crate) context_scope: Option<String>,
    pub(crate) deliverable: Option<String>,
    pub(crate) success_criteria: Option<Vec<String>>,
    pub(crate) stop_condition: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) task_title: Option<String>,
    pub(crate) dependencies: Option<Vec<String>>,
    pub(crate) worktree: Option<bool>,
    pub(crate) worktree_branch: Option<String>,
    pub(crate) worktree_path: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedTeammate {
    pub(crate) team_id: String,
    pub(crate) task_id: String,
    pub(crate) member_id: String,
    pub(crate) agent_name: Option<String>,
    pub(crate) prompt: String,
    pub(crate) worktree_path: Option<String>,
    pub(crate) design: TeammateDesignContract,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRecord {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) subagent_type: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) status: String,
    pub(crate) output_file: String,
    pub(crate) manifest_file: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendMessageInput {
    pub(crate) team_id: Option<String>,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) subject: Option<String>,
    pub(crate) body: String,
    pub(crate) task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimTaskInput {
    pub(crate) team_id: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) claimant: String,
    pub(crate) lease_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteTaskInput {
    pub(crate) team_id: Option<String>,
    pub(crate) task_id: String,
    pub(crate) actor: String,
    pub(crate) result: String,
    pub(crate) status: Option<TaskCompletionStatus>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskCompletionStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListTeamInput {
    pub(crate) team_id: Option<String>,
    pub(crate) include_messages: Option<bool>,
    pub(crate) include_events: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSupervisorInput {
    pub(crate) action: AgentSupervisorAction,
    pub(crate) agent_id: Option<String>,
    pub(crate) team_id: Option<String>,
    pub(crate) tail_bytes: Option<usize>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentSupervisorAction {
    List,
    Status,
    Logs,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnterWorktreeInput {
    pub(crate) action: WorktreeAction,
    pub(crate) branch: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) base: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorktreeAction {
    Create,
    List,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamStatus {
    Active,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamState {
    pub(crate) version: u32,
    pub(crate) team_id: String,
    pub(crate) name: String,
    pub(crate) lead_session: String,
    pub(crate) status: TeamStatus,
    pub(crate) design: Option<TeamDesignContract>,
    pub(crate) members: Vec<TeamMember>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMember {
    pub(crate) member_id: String,
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) role: Option<String>,
    pub(crate) responsibility: Option<String>,
    pub(crate) context_scope: Option<String>,
    pub(crate) deliverable: Option<String>,
    #[serde(default)]
    pub(crate) success_criteria: Vec<String>,
    pub(crate) stop_condition: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) status: String,
    pub(crate) task_id: Option<String>,
    pub(crate) permission_mode: String,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) worktree_path: Option<String>,
    pub(crate) manifest_file: String,
    pub(crate) output_file: String,
    pub(crate) token_usage: Option<AgentTokenUsage>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTokenUsage {
    pub(crate) input_tokens: u32,
    pub(crate) output_tokens: u32,
    pub(crate) cache_creation_input_tokens: u32,
    pub(crate) cache_read_input_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamTaskStatus {
    Pending,
    Blocked,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamTask {
    pub(crate) task_id: String,
    pub(crate) team_id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) design: Option<TeammateDesignContract>,
    pub(crate) dependencies: Vec<String>,
    pub(crate) claimed_by: Option<String>,
    pub(crate) lease_expires_at: Option<u64>,
    pub(crate) status: TeamTaskStatus,
    pub(crate) result: Option<String>,
    pub(crate) events: Vec<TaskEvent>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamDesignContract {
    pub(crate) rationale: String,
    pub(crate) coordination_pattern: String,
    pub(crate) coordinator: String,
    pub(crate) context_policy: String,
    pub(crate) verification_plan: String,
    pub(crate) stop_condition: String,
    pub(crate) max_teammates: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeammateDesignContract {
    pub(crate) role: String,
    pub(crate) responsibility: String,
    pub(crate) context_scope: String,
    pub(crate) deliverable: String,
    pub(crate) success_criteria: Vec<String>,
    pub(crate) stop_condition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskEvent {
    pub(crate) ts: u64,
    pub(crate) kind: String,
    pub(crate) actor: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MailboxDeliveryStatus {
    Queued,
    Delivered,
    Read,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailboxMessage {
    pub(crate) message_id: String,
    pub(crate) team_id: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) subject: Option<String>,
    pub(crate) body: String,
    pub(crate) task_id: Option<String>,
    pub(crate) status: MailboxDeliveryStatus,
    pub(crate) created_at: u64,
    pub(crate) delivered_at: Option<u64>,
    pub(crate) read_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunEvent {
    pub(crate) version: u32,
    pub(crate) event_id: String,
    pub(crate) ts: u64,
    pub(crate) kind: String,
    pub(crate) team_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) message_id: Option<String>,
    pub(crate) workflow_run_id: Option<String>,
    pub(crate) payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamSnapshot {
    pub(crate) state_dir: String,
    pub(crate) team: TeamState,
    pub(crate) tasks: Vec<TeamTask>,
    pub(crate) mailbox: Vec<MailboxMessage>,
    pub(crate) agents: Vec<AgentManifestView>,
    pub(crate) events: Vec<RunEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentManifestView {
    #[serde(rename = "agentId")]
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    #[serde(rename = "subagentType")]
    pub(crate) subagent_type: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) status: String,
    #[serde(rename = "outputFile")]
    pub(crate) output_file: String,
    #[serde(rename = "manifestFile")]
    pub(crate) manifest_file: String,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
    #[serde(rename = "startedAt")]
    pub(crate) started_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub(crate) completed_at: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) usage: Option<AgentTokenUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSupervisorOutput {
    pub(crate) action: AgentSupervisorActionLabel,
    pub(crate) state_dir: String,
    pub(crate) agents: Vec<AgentManifestView>,
    pub(crate) selected_agent: Option<AgentManifestView>,
    pub(crate) log_tail: Option<String>,
    pub(crate) cancel_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentSupervisorActionLabel {
    List,
    Status,
    Logs,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeOutput {
    pub(crate) action: String,
    pub(crate) path: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) output: String,
}

pub(crate) fn inherited_permission_mode() -> String {
    std::env::var("ARIS_PERMISSION_MODE").unwrap_or_else(|_| "danger-full-access".to_string())
}

pub(crate) fn inherited_allowed_tools() -> Vec<String> {
    std::env::var("ARIS_ALLOWED_TOOLS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|tools| !tools.is_empty())
        .unwrap_or_else(|| {
            COORDINATION_TOOLS
                .iter()
                .copied()
                .map(str::to_string)
                .collect()
        })
}

pub(crate) fn inherited_lead_session() -> String {
    std::env::var("ARIS_SESSION_ID").unwrap_or_else(|_| "session-unknown".to_string())
}

fn validate_team_design(design: &TeamDesignContract) -> Result<TeamDesignContract, String> {
    let normalized = TeamDesignContract {
        rationale: required_contract_text("teamDesign.rationale", Some(&design.rationale), 24)?,
        coordination_pattern: required_contract_text(
            "teamDesign.coordinationPattern",
            Some(&design.coordination_pattern),
            8,
        )?,
        coordinator: required_contract_text(
            "teamDesign.coordinator",
            Some(&design.coordinator),
            3,
        )?,
        context_policy: required_contract_text(
            "teamDesign.contextPolicy",
            Some(&design.context_policy),
            18,
        )?,
        verification_plan: required_contract_text(
            "teamDesign.verificationPlan",
            Some(&design.verification_plan),
            18,
        )?,
        stop_condition: required_contract_text(
            "teamDesign.stopCondition",
            Some(&design.stop_condition),
            18,
        )?,
        max_teammates: design.max_teammates.or(Some(DEFAULT_MAX_TEAMMATES)),
    };
    let max_teammates = normalized.max_teammates.unwrap_or(DEFAULT_MAX_TEAMMATES);
    if max_teammates == 0 || max_teammates > MAX_TEAMMATES_HARD_LIMIT {
        return Err(format!(
            "teamDesign.maxTeammates must be between 1 and {MAX_TEAMMATES_HARD_LIMIT}"
        ));
    }
    Ok(normalized)
}

fn validate_teammate_design(input: &SpawnTeammateInput) -> Result<TeammateDesignContract, String> {
    let success_criteria = input.success_criteria.as_ref().ok_or_else(|| {
        "successCriteria is required and must contain at least two verifiable criteria".to_string()
    })?;
    if success_criteria.len() < 2 {
        return Err(
            "successCriteria is required and must contain at least two verifiable criteria"
                .to_string(),
        );
    }
    let mut criteria = Vec::new();
    for (index, criterion) in success_criteria.iter().enumerate() {
        criteria.push(required_contract_text(
            &format!("successCriteria[{index}]"),
            Some(criterion),
            8,
        )?);
    }
    Ok(TeammateDesignContract {
        role: required_contract_text("role", input.role.as_ref(), 3)?,
        responsibility: required_contract_text(
            "responsibility",
            input.responsibility.as_ref(),
            18,
        )?,
        context_scope: required_contract_text("contextScope", input.context_scope.as_ref(), 18)?,
        deliverable: required_contract_text("deliverable", input.deliverable.as_ref(), 12)?,
        success_criteria: criteria,
        stop_condition: required_contract_text("stopCondition", input.stop_condition.as_ref(), 18)?,
    })
}

fn required_contract_text(
    field: &str,
    value: Option<&String>,
    min_chars: usize,
) -> Result<String, String> {
    let value = value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{field} is required for Agent Team design"))?;
    if value.chars().count() < min_chars {
        return Err(format!(
            "{field} is too vague for Agent Team design; expected at least {min_chars} characters"
        ));
    }
    Ok(value.to_string())
}

fn validate_team_capacity(team: &TeamState) -> Result<(), String> {
    let max_teammates = team
        .design
        .as_ref()
        .and_then(|design| design.max_teammates)
        .unwrap_or(DEFAULT_MAX_TEAMMATES);
    if team.members.len() >= max_teammates {
        return Err(format!(
            "team {} already has {} teammate(s), reaching maxTeammates={max_teammates}",
            team.team_id,
            team.members.len()
        ));
    }
    Ok(())
}

fn validate_non_overlapping_teammate(
    team: &TeamState,
    tasks: &[TeamTask],
    task_id: &str,
    task_title: &str,
    design: &TeammateDesignContract,
) -> Result<(), String> {
    let requested_role = normalized_contract_key(&design.role);
    if team.members.iter().any(|member| {
        member
            .role
            .as_deref()
            .is_some_and(|role| normalized_contract_key(role) == requested_role)
    }) {
        return Err(format!(
            "role `{}` already exists in team {}; teammate roles must be non-overlapping",
            design.role, team.team_id
        ));
    }

    let requested_title = normalized_contract_key(task_title);
    if tasks.iter().any(|task| {
        task.team_id == team.team_id
            && task.task_id != task_id
            && normalized_contract_key(&task.title) == requested_title
            && !matches!(
                task.status,
                TeamTaskStatus::Completed | TeamTaskStatus::Failed | TeamTaskStatus::Cancelled
            )
    }) {
        return Err(format!(
            "task title `{task_title}` already exists in team {}; use a distinct, bounded responsibility",
            team.team_id
        ));
    }

    Ok(())
}

fn validate_spawn_dependencies_ready(
    tasks: &[TeamTask],
    team_id: &str,
    dependencies: &[String],
) -> Result<(), String> {
    if dependencies.is_empty() {
        return Ok(());
    }
    let completed = tasks
        .iter()
        .filter(|task| task.team_id == team_id && matches!(task.status, TeamTaskStatus::Completed))
        .map(|task| task.task_id.as_str())
        .collect::<BTreeSet<_>>();
    let unmet = dependencies
        .iter()
        .filter(|dependency| !completed.contains(dependency.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if unmet.is_empty() {
        return Ok(());
    }
    Err(format!(
        "SpawnTeammate cannot start a task with unmet dependencies {:?}; complete prerequisites before spawning dependent teammates",
        unmet
    ))
}

fn normalized_contract_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub(crate) fn prepare_teammate(input: &SpawnTeammateInput) -> Result<PreparedTeammate, String> {
    if input.description.trim().is_empty() {
        return Err("description must not be empty".to_string());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    let teammate_design = validate_teammate_design(input)?;

    let lead_session = input
        .lead_session
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(inherited_lead_session);
    let lead_session_for_prompt = lead_session.clone();
    let team_exists = input
        .team_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .is_some_and(|team_id| team_path(team_id).exists());
    let design_for_existing_team = input
        .team_design
        .as_ref()
        .map(validate_team_design)
        .transpose()?;
    let design_for_new_team = if team_exists {
        None
    } else {
        Some(validate_team_design(
            input
                .team_design
                .as_ref()
                .ok_or_else(|| "teamDesign is required when creating an Agent Team".to_string())?,
        )?)
    };
    let mut team = ensure_team(
        input.team_id.as_deref(),
        input.team_name.as_deref(),
        &lead_session,
        design_for_new_team,
    )?;
    if team.design.is_none() {
        let design = design_for_existing_team.ok_or_else(|| {
            "teamDesign is required because this existing team has no design contract".to_string()
        })?;
        team.design = Some(design);
        save_team(&team)?;
    }
    validate_team_capacity(&team)?;
    let now = epoch_secs();
    let task_id = input
        .task_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| make_id("task"));
    let member_id = make_id("member");
    let task_title = input
        .task_title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(input.description.as_str())
        .to_string();
    let mut tasks = load_tasks()?;
    validate_non_overlapping_teammate(&team, &tasks, &task_id, &task_title, &teammate_design)?;
    let dependencies = input.dependencies.clone().unwrap_or_default();
    validate_spawn_dependencies_ready(&tasks, &team.team_id, &dependencies)?;
    if !tasks
        .iter()
        .any(|task| task.team_id == team.team_id && task.task_id == task_id)
    {
        let mut task = TeamTask {
            task_id: task_id.clone(),
            team_id: team.team_id.clone(),
            title: task_title,
            body: input.prompt.clone(),
            design: Some(teammate_design.clone()),
            dependencies,
            claimed_by: Some(member_id.clone()),
            lease_expires_at: Some(now + 3_600),
            status: TeamTaskStatus::InProgress,
            result: None,
            events: vec![TaskEvent {
                ts: now,
                kind: "TaskCreated".to_string(),
                actor: Some(lead_session.clone()),
                message: Some(input.description.clone()),
            }],
            created_at: now,
            updated_at: now,
        };
        task.events.push(TaskEvent {
            ts: now,
            kind: "TaskClaimed".to_string(),
            actor: Some(member_id.clone()),
            message: None,
        });
        tasks.push(task);
        save_tasks(&tasks)?;
    }

    let worktree_path = if input.worktree.unwrap_or(false) || input.worktree_path.is_some() {
        let branch = input
            .worktree_branch
            .clone()
            .unwrap_or_else(|| format!("aris/{}", member_id));
        let path = input.worktree_path.clone().unwrap_or_else(|| {
            state_root()
                .join("worktrees")
                .join(&member_id)
                .display()
                .to_string()
        });
        create_worktree(&branch, &path, input.worktree_branch.is_some())?.path
    } else {
        None
    };

    team.updated_at = now;
    save_team(&team)?;
    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: "TaskCreated".to_string(),
        team_id: Some(team.team_id.clone()),
        session_id: Some(lead_session),
        agent_id: None,
        task_id: Some(task_id.clone()),
        message_id: None,
        workflow_run_id: None,
        payload: json!({ "description": input.description }),
    })?;

    let mut prompt = format!(
        "# Team Coordination\n\
         You are teammate `{member_id}` in team `{team_id}`.\n\
         Lead session: `{lead_session}`.\n\
         Current task id: `{task_id}`.\n\
         Coordination contract: `{pattern}`. Coordinator: `{coordinator}`.\n\
         Team context policy: {context_policy}\n\
         Team verification plan: {verification_plan}\n\
         Team stop condition: {team_stop_condition}\n\
         Use ClaimTask, CompleteTask, SendMessage, and ListTeam for coordination.\n\
         Do not take work outside your context scope or duplicate another teammate's role.\n\
         Mark the task complete with CompleteTask before your final response.\n\n\
         # Teammate Contract\n\
         Role: {role}\n\
         Responsibility: {responsibility}\n\
         Context scope: {context_scope}\n\
         Deliverable: {deliverable}\n\
         Success criteria:\n{success_criteria}\n\
         Stop condition: {stop_condition}\n",
        team_id = team.team_id,
        lead_session = lead_session_for_prompt,
        pattern = team
            .design
            .as_ref()
            .map(|design| design.coordination_pattern.as_str())
            .unwrap_or("unspecified"),
        coordinator = team
            .design
            .as_ref()
            .map(|design| design.coordinator.as_str())
            .unwrap_or("lead"),
        context_policy = team
            .design
            .as_ref()
            .map(|design| design.context_policy.as_str())
            .unwrap_or("structured handoffs only"),
        verification_plan = team
            .design
            .as_ref()
            .map(|design| design.verification_plan.as_str())
            .unwrap_or("verify deliverables before completion"),
        team_stop_condition = team
            .design
            .as_ref()
            .map(|design| design.stop_condition.as_str())
            .unwrap_or("complete when criteria are met"),
        role = teammate_design.role,
        responsibility = teammate_design.responsibility,
        context_scope = teammate_design.context_scope,
        deliverable = teammate_design.deliverable,
        success_criteria = teammate_design
            .success_criteria
            .iter()
            .map(|criterion| format!("- {criterion}"))
            .collect::<Vec<_>>()
            .join("\n"),
        stop_condition = teammate_design.stop_condition,
    );
    if let Some(path) = &worktree_path {
        prompt.push_str(&format!(
            "\nWorktree isolation is available at `{path}`. Use absolute paths inside that worktree.\n"
        ));
    }
    prompt.push_str("\n# Delegated Task\n\n");
    prompt.push_str(&input.prompt);

    Ok(PreparedTeammate {
        team_id: team.team_id,
        task_id,
        member_id,
        agent_name: input.name.clone(),
        prompt,
        worktree_path,
        design: teammate_design,
    })
}

pub(crate) fn register_spawned_agent(
    prepared: &PreparedTeammate,
    record: AgentRecord,
) -> Result<TeamSnapshot, String> {
    let mut team = load_team(&prepared.team_id)?;
    let now = epoch_secs();
    let allowed_tools = inherited_allowed_tools();
    let member = TeamMember {
        member_id: prepared.member_id.clone(),
        agent_id: record.agent_id.clone(),
        name: record.name,
        role: Some(prepared.design.role.clone()),
        responsibility: Some(prepared.design.responsibility.clone()),
        context_scope: Some(prepared.design.context_scope.clone()),
        deliverable: Some(prepared.design.deliverable.clone()),
        success_criteria: prepared.design.success_criteria.clone(),
        stop_condition: Some(prepared.design.stop_condition.clone()),
        session_id: None,
        status: record.status,
        task_id: Some(prepared.task_id.clone()),
        permission_mode: inherited_permission_mode(),
        allowed_tools,
        worktree_path: prepared.worktree_path.clone(),
        manifest_file: record.manifest_file,
        output_file: record.output_file,
        token_usage: None,
        created_at: now,
        updated_at: now,
    };
    team.members.push(member);
    team.updated_at = now;
    save_team(&team)?;
    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: "TeammateSpawned".to_string(),
        team_id: Some(prepared.team_id.clone()),
        session_id: Some(inherited_lead_session()),
        agent_id: Some(record.agent_id),
        task_id: Some(prepared.task_id.clone()),
        message_id: None,
        workflow_run_id: None,
        payload: json!({
            "description": record.description,
            "model": record.model,
            "subagentType": record.subagent_type,
            "role": prepared.design.role,
            "deliverable": prepared.design.deliverable,
        }),
    })?;
    snapshot(Some(&prepared.team_id), false, false)
}

pub(crate) fn send_message(input: SendMessageInput) -> Result<MailboxMessage, String> {
    if input.from.trim().is_empty() {
        return Err("from must not be empty".to_string());
    }
    if input.to.trim().is_empty() {
        return Err("to must not be empty".to_string());
    }
    if input.body.trim().is_empty() {
        return Err("body must not be empty".to_string());
    }
    let team_id = resolve_team_id(input.team_id.as_deref())?;
    let now = epoch_secs();
    let message = MailboxMessage {
        message_id: make_id("msg"),
        team_id: team_id.clone(),
        from: input.from,
        to: input.to,
        subject: input.subject,
        body: input.body,
        task_id: input.task_id,
        status: MailboxDeliveryStatus::Delivered,
        created_at: now,
        delivered_at: Some(now),
        read_at: None,
    };
    append_mailbox_message(&message)?;
    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: "MessageSent".to_string(),
        team_id: Some(team_id),
        session_id: Some(inherited_lead_session()),
        agent_id: None,
        task_id: message.task_id.clone(),
        message_id: Some(message.message_id.clone()),
        workflow_run_id: None,
        payload: json!({ "from": message.from, "to": message.to, "subject": message.subject }),
    })?;
    Ok(message)
}

pub(crate) fn claim_task(input: ClaimTaskInput) -> Result<TeamTask, String> {
    if input.claimant.trim().is_empty() {
        return Err("claimant must not be empty".to_string());
    }
    let team_id = resolve_team_id(input.team_id.as_deref())?;
    let now = epoch_secs();
    let lease_seconds = input.lease_seconds.unwrap_or(3_600).max(1);
    let mut tasks = load_tasks()?;
    refresh_task_dependencies(&mut tasks, &team_id);

    let index = if let Some(task_id) = &input.task_id {
        tasks
            .iter()
            .position(|task| task.team_id == team_id && task.task_id == *task_id)
            .ok_or_else(|| format!("task not found: {task_id}"))?
    } else {
        tasks
            .iter()
            .position(|task| {
                task.team_id == team_id
                    && matches!(task.status, TeamTaskStatus::Pending)
                    && task
                        .lease_expires_at
                        .is_none_or(|expires_at| expires_at <= now)
            })
            .ok_or_else(|| "no unblocked pending task is available".to_string())?
    };

    let task = &mut tasks[index];
    if !matches!(
        task.status,
        TeamTaskStatus::Pending | TeamTaskStatus::InProgress
    ) {
        return Err(format!(
            "task {} is not claimable because it is {:?}",
            task.task_id, task.status
        ));
    }
    if matches!(task.status, TeamTaskStatus::InProgress)
        && task
            .lease_expires_at
            .is_some_and(|expires_at| expires_at > now)
        && task.claimed_by.as_deref() != Some(input.claimant.as_str())
    {
        return Err(format!(
            "task {} is already leased by {}",
            task.task_id,
            task.claimed_by.as_deref().unwrap_or("<unknown>")
        ));
    }

    task.status = TeamTaskStatus::InProgress;
    task.claimed_by = Some(input.claimant.clone());
    task.lease_expires_at = Some(now + lease_seconds);
    task.updated_at = now;
    task.events.push(TaskEvent {
        ts: now,
        kind: "TaskClaimed".to_string(),
        actor: Some(input.claimant),
        message: None,
    });
    let claimed = task.clone();
    save_tasks(&tasks)?;
    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: "TaskClaimed".to_string(),
        team_id: Some(team_id),
        session_id: Some(inherited_lead_session()),
        agent_id: None,
        task_id: Some(claimed.task_id.clone()),
        message_id: None,
        workflow_run_id: None,
        payload: json!({ "claimedBy": claimed.claimed_by }),
    })?;
    Ok(claimed)
}

pub(crate) fn complete_task(input: CompleteTaskInput) -> Result<TeamSnapshot, String> {
    if input.actor.trim().is_empty() {
        return Err("actor must not be empty".to_string());
    }
    if input.result.trim().is_empty() {
        return Err("result must not be empty".to_string());
    }
    let team_id = resolve_team_id(input.team_id.as_deref())?;
    let now = epoch_secs();
    let mut tasks = load_tasks()?;
    let task = tasks
        .iter_mut()
        .find(|task| task.team_id == team_id && task.task_id == input.task_id)
        .ok_or_else(|| format!("task not found: {}", input.task_id))?;
    let completed = matches!(
        input.status.unwrap_or(TaskCompletionStatus::Completed),
        TaskCompletionStatus::Completed
    );
    let requested_status = if completed {
        TeamTaskStatus::Completed
    } else {
        TeamTaskStatus::Failed
    };
    if matches!(
        task.status,
        TeamTaskStatus::Completed | TeamTaskStatus::Failed | TeamTaskStatus::Cancelled
    ) {
        if task.status == requested_status && task.result.as_deref() == Some(input.result.as_str())
        {
            return snapshot(Some(&team_id), true, false);
        }
        return Err(format!(
            "task {} is already {:?}; refusing to overwrite terminal result",
            task.task_id, task.status
        ));
    }
    task.status = requested_status;
    task.result = Some(input.result.clone());
    task.lease_expires_at = None;
    task.updated_at = now;
    task.events.push(TaskEvent {
        ts: now,
        kind: if completed {
            "TaskCompleted".to_string()
        } else {
            "TaskFailed".to_string()
        },
        actor: Some(input.actor.clone()),
        message: Some(input.result),
    });
    refresh_task_dependencies(&mut tasks, &team_id);
    save_tasks(&tasks)?;

    let mut team = load_team(&team_id)?;
    for member in &mut team.members {
        if member.task_id.as_deref() == Some(input.task_id.as_str()) {
            member.status = if completed { "idle" } else { "failed" }.to_string();
            member.updated_at = now;
        }
    }
    team.updated_at = now;
    save_team(&team)?;

    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: if completed {
            "TaskCompleted".to_string()
        } else {
            "TaskFailed".to_string()
        },
        team_id: Some(team_id.clone()),
        session_id: Some(inherited_lead_session()),
        agent_id: None,
        task_id: Some(input.task_id),
        message_id: None,
        workflow_run_id: None,
        payload: json!({ "actor": input.actor }),
    })?;
    snapshot(Some(&team_id), true, false)
}

pub(crate) fn snapshot(
    team_id: Option<&str>,
    include_messages: bool,
    include_events: bool,
) -> Result<TeamSnapshot, String> {
    let team_id = resolve_team_id(team_id)?;
    let mut team = load_team(&team_id)?;
    refresh_team_members_from_agents(&mut team)?;
    save_team(&team)?;
    let tasks = load_tasks()?
        .into_iter()
        .filter(|task| task.team_id == team_id)
        .collect::<Vec<_>>();
    let mailbox = if include_messages {
        load_mailbox()?
            .into_iter()
            .filter(|message| message.team_id == team_id)
            .collect()
    } else {
        Vec::new()
    };
    let agent_ids = team
        .members
        .iter()
        .map(|member| member.agent_id.clone())
        .collect::<BTreeSet<_>>();
    let agents = list_agent_manifests()?
        .into_iter()
        .filter(|agent| agent_ids.contains(&agent.agent_id))
        .collect();
    let events = if include_events {
        load_events()?
            .into_iter()
            .filter(|event| event.team_id.as_deref() == Some(team_id.as_str()))
            .collect()
    } else {
        Vec::new()
    };
    Ok(TeamSnapshot {
        state_dir: state_root().display().to_string(),
        team,
        tasks,
        mailbox,
        agents,
        events,
    })
}

pub(crate) fn list_team(input: ListTeamInput) -> Result<TeamSnapshot, String> {
    snapshot(
        input.team_id.as_deref(),
        input.include_messages.unwrap_or(true),
        input.include_events.unwrap_or(false),
    )
}

pub(crate) fn agent_supervisor(
    input: AgentSupervisorInput,
) -> Result<AgentSupervisorOutput, String> {
    let agents = match input.team_id.as_deref() {
        Some(team_id) => {
            let team = load_team(team_id)?;
            let ids = team
                .members
                .iter()
                .map(|member| member.agent_id.clone())
                .collect::<BTreeSet<_>>();
            list_agent_manifests()?
                .into_iter()
                .filter(|agent| ids.contains(&agent.agent_id))
                .collect::<Vec<_>>()
        }
        None => list_agent_manifests()?,
    };
    let selected_agent = match input.action {
        AgentSupervisorAction::List => None,
        AgentSupervisorAction::Status
        | AgentSupervisorAction::Logs
        | AgentSupervisorAction::Stop
        | AgentSupervisorAction::Restart => {
            let agent_id = input
                .agent_id
                .as_deref()
                .ok_or_else(|| "agentId is required for this action".to_string())?;
            Some(load_agent_manifest(agent_id)?)
        }
    };
    let log_tail = if matches!(input.action, AgentSupervisorAction::Logs) {
        selected_agent
            .as_ref()
            .map(|agent| tail_file(&agent.output_file, input.tail_bytes.unwrap_or(8_192)))
            .transpose()?
    } else {
        None
    };
    let cancel_file = if matches!(input.action, AgentSupervisorAction::Stop) {
        let agent = selected_agent
            .as_ref()
            .ok_or_else(|| "agentId is required for stop".to_string())?;
        let path = agent_store_dir()?.join(format!("{}.cancel", agent.agent_id));
        fs::write(&path, "stop requested\n").map_err(|error| error.to_string())?;
        append_event(RunEvent {
            version: STATE_VERSION,
            event_id: make_id("event"),
            ts: epoch_secs(),
            kind: "AgentStopRequested".to_string(),
            team_id: input.team_id.clone(),
            session_id: Some(inherited_lead_session()),
            agent_id: Some(agent.agent_id.clone()),
            task_id: None,
            message_id: None,
            workflow_run_id: None,
            payload: json!({ "cancelFile": path.display().to_string() }),
        })?;
        Some(path.display().to_string())
    } else {
        None
    };
    Ok(AgentSupervisorOutput {
        action: match input.action {
            AgentSupervisorAction::List => AgentSupervisorActionLabel::List,
            AgentSupervisorAction::Status => AgentSupervisorActionLabel::Status,
            AgentSupervisorAction::Logs => AgentSupervisorActionLabel::Logs,
            AgentSupervisorAction::Stop => AgentSupervisorActionLabel::Stop,
            AgentSupervisorAction::Restart => AgentSupervisorActionLabel::Restart,
        },
        state_dir: state_root().display().to_string(),
        agents,
        selected_agent,
        log_tail,
        cancel_file,
    })
}

pub(crate) fn create_worktree(
    branch: &str,
    path: &str,
    branch_exists: bool,
) -> Result<WorktreeOutput, String> {
    let path_buf = PathBuf::from(path);
    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut args = vec!["worktree", "add"];
    let path_string = path_buf.display().to_string();
    if !branch_exists {
        args.push("-b");
        args.push(branch);
    }
    args.push(&path_string);
    if branch_exists {
        args.push(branch);
    }
    let output = Command::new("git")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git worktree add failed: {stderr}"));
    }
    Ok(WorktreeOutput {
        action: "create".to_string(),
        path: Some(path_string),
        branch: Some(branch.to_string()),
        output: String::from_utf8_lossy(&output.stdout).trim().to_string(),
    })
}

pub(crate) fn enter_worktree(input: EnterWorktreeInput) -> Result<WorktreeOutput, String> {
    match input.action {
        WorktreeAction::List => {
            let output = Command::new("git")
                .args(["worktree", "list", "--porcelain"])
                .output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(format!("git worktree list failed: {stderr}"));
            }
            Ok(WorktreeOutput {
                action: "list".to_string(),
                path: None,
                branch: None,
                output: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            })
        }
        WorktreeAction::Create => {
            let branch = input
                .branch
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "branch is required for create".to_string())?;
            let path = input
                .path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "path is required for create".to_string())?;
            if let Some(base) = input
                .base
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let output = Command::new("git")
                    .args(["branch", branch, base])
                    .output()
                    .map_err(|error| error.to_string())?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(format!("git branch failed: {stderr}"));
                }
                create_worktree(branch, path, true)
            } else {
                create_worktree(branch, path, false)
            }
        }
    }
}

pub(crate) fn latest_team_id() -> Result<Option<String>, String> {
    let dir = teams_dir();
    if !dir.exists() {
        return Ok(None);
    }
    let mut teams = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Ok(team) = read_json::<TeamState>(&path) {
            teams.push(team);
        }
    }
    teams.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(teams.first().map(|team| team.team_id.clone()))
}

pub(crate) fn resolve_team_id(team_id: Option<&str>) -> Result<String, String> {
    if let Some(team_id) = team_id.filter(|value| !value.trim().is_empty()) {
        return Ok(team_id.to_string());
    }
    latest_team_id()?.ok_or_else(|| "no team exists yet".to_string())
}

pub(crate) fn append_event(event: RunEvent) -> Result<(), String> {
    ensure_state_dirs()?;
    use std::io::Write as _;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path())
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&event).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn state_root() -> PathBuf {
    if let Ok(path) = std::env::var("ARIS_RUN_STATE_DIR") {
        return PathBuf::from(path);
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".claude")
        .join("run-state")
}

pub(crate) fn workflows_dir() -> PathBuf {
    state_root().join("workflows")
}

fn ensure_team(
    team_id: Option<&str>,
    name: Option<&str>,
    lead_session: &str,
    design: Option<TeamDesignContract>,
) -> Result<TeamState, String> {
    if let Some(team_id) = team_id.filter(|value| !value.trim().is_empty()) {
        if team_path(team_id).exists() {
            return load_team(team_id);
        }
    }
    let now = epoch_secs();
    let team_id = team_id
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| make_id("team"));
    let team = TeamState {
        version: STATE_VERSION,
        team_id: team_id.clone(),
        name: name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Agent Team")
            .to_string(),
        lead_session: lead_session.to_string(),
        status: TeamStatus::Active,
        design,
        members: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    save_team(&team)?;
    append_event(RunEvent {
        version: STATE_VERSION,
        event_id: make_id("event"),
        ts: now,
        kind: "TeamCreated".to_string(),
        team_id: Some(team_id),
        session_id: Some(lead_session.to_string()),
        agent_id: None,
        task_id: None,
        message_id: None,
        workflow_run_id: None,
        payload: json!({ "name": team.name }),
    })?;
    Ok(team)
}

fn refresh_team_members_from_agents(team: &mut TeamState) -> Result<(), String> {
    let manifests = list_agent_manifests()?
        .into_iter()
        .map(|manifest| (manifest.agent_id.clone(), manifest))
        .collect::<BTreeMap<_, _>>();
    let now = epoch_secs();
    for member in &mut team.members {
        if let Some(agent) = manifests.get(&member.agent_id) {
            member.status.clone_from(&agent.status);
            member.token_usage.clone_from(&agent.usage);
            member.updated_at = now;
        }
    }
    Ok(())
}

fn refresh_task_dependencies(tasks: &mut [TeamTask], team_id: &str) {
    let completed = tasks
        .iter()
        .filter(|task| task.team_id == team_id && matches!(task.status, TeamTaskStatus::Completed))
        .map(|task| task.task_id.clone())
        .collect::<BTreeSet<_>>();
    for task in tasks.iter_mut().filter(|task| task.team_id == team_id) {
        if matches!(
            task.status,
            TeamTaskStatus::Completed | TeamTaskStatus::Failed | TeamTaskStatus::Cancelled
        ) {
            continue;
        }
        let deps_complete = task
            .dependencies
            .iter()
            .all(|dependency| completed.contains(dependency));
        match (&task.status, deps_complete) {
            (TeamTaskStatus::Blocked, true) => {
                task.status = TeamTaskStatus::Pending;
                task.updated_at = epoch_secs();
                task.events.push(TaskEvent {
                    ts: task.updated_at,
                    kind: "TaskUnblocked".to_string(),
                    actor: None,
                    message: None,
                });
            }
            (TeamTaskStatus::Pending, false) | (TeamTaskStatus::InProgress, false) => {
                task.status = TeamTaskStatus::Blocked;
                task.updated_at = epoch_secs();
                task.events.push(TaskEvent {
                    ts: task.updated_at,
                    kind: "TaskBlocked".to_string(),
                    actor: None,
                    message: Some(format!("waiting for {:?}", task.dependencies)),
                });
            }
            _ => {}
        }
    }
}

fn save_team(team: &TeamState) -> Result<(), String> {
    ensure_state_dirs()?;
    write_json(&team_path(&team.team_id), team)
}

fn load_team(team_id: &str) -> Result<TeamState, String> {
    read_json(&team_path(team_id))
}

fn load_tasks() -> Result<Vec<TeamTask>, String> {
    read_json_default(&tasks_path())
}

fn save_tasks(tasks: &[TeamTask]) -> Result<(), String> {
    ensure_state_dirs()?;
    write_json(&tasks_path(), tasks)
}

fn append_mailbox_message(message: &MailboxMessage) -> Result<(), String> {
    ensure_state_dirs()?;
    use std::io::Write as _;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(mailbox_path())
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(message).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())
}

fn load_mailbox() -> Result<Vec<MailboxMessage>, String> {
    read_jsonl(&mailbox_path())
}

fn load_events() -> Result<Vec<RunEvent>, String> {
    read_jsonl(&events_path())
}

fn list_agent_manifests() -> Result<Vec<AgentManifestView>, String> {
    let dir = agent_store_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut agents = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Ok(agent) = read_json::<AgentManifestView>(&path) {
            agents.push(agent);
        }
    }
    agents.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(agents)
}

pub(crate) fn load_agent_manifest(agent_id: &str) -> Result<AgentManifestView, String> {
    list_agent_manifests()?
        .into_iter()
        .find(|agent| agent.agent_id == agent_id)
        .ok_or_else(|| format!("agent not found: {agent_id}"))
}

pub(crate) fn extract_agent_prompt(agent: &AgentManifestView) -> Result<String, String> {
    let content = fs::read_to_string(&agent.output_file).map_err(|error| error.to_string())?;
    let prompt = content
        .split("## Prompt")
        .nth(1)
        .ok_or_else(|| "agent output file does not contain a prompt section".to_string())?;
    let prompt = prompt.split("## Result").next().unwrap_or(prompt).trim();
    Ok(prompt.to_string())
}

fn tail_file(path: &str, max_bytes: usize) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if content.len() <= max_bytes {
        return Ok(content);
    }
    Ok(content[content.len() - max_bytes..].to_string())
}

fn agent_store_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("CLAWD_AGENT_STORE") {
        return Ok(PathBuf::from(path));
    }
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    if let Some(workspace_root) = cwd.ancestors().nth(2) {
        return Ok(workspace_root.join(".clawd-agents"));
    }
    Ok(cwd.join(".clawd-agents"))
}

fn ensure_state_dirs() -> Result<(), String> {
    for dir in [
        state_root(),
        teams_dir(),
        workflows_dir(),
        state_root().join("worktrees"),
    ] {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn teams_dir() -> PathBuf {
    state_root().join("teams")
}

fn team_path(team_id: &str) -> PathBuf {
    teams_dir().join(format!("{team_id}.json"))
}

fn tasks_path() -> PathBuf {
    state_root().join("tasks.json")
}

fn mailbox_path() -> PathBuf {
    state_root().join("mailbox.jsonl")
}

fn events_path() -> PathBuf {
    state_root().join("events.jsonl")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn read_json_default<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(content) if content.trim().is_empty() => Ok(T::default()),
        Ok(content) => serde_json::from_str(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    match fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json<T: Serialize>(path: &Path, value: T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("tmp");
    fs::write(
        &temp,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn make_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{nanos}")
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

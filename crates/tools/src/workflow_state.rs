use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::team_state::{self, RunEvent};

const WORKFLOW_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowInput {
    pub(crate) action: WorkflowAction,
    pub(crate) run_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) script: Option<String>,
    pub(crate) script_path: Option<String>,
    pub(crate) save_as: Option<String>,
    pub(crate) approval: Option<WorkflowApproval>,
    pub(crate) max_concurrency: Option<usize>,
    pub(crate) max_agents: Option<usize>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowAction {
    Plan,
    Start,
    List,
    Inspect,
    Pause,
    Resume,
    Stop,
    Restart,
    Save,
    Discover,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowApproval {
    AllowOnce,
    Always,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowRunStatus {
    ApprovalRequired,
    Running,
    Paused,
    Stopped,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowPhaseStatus {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRun {
    pub(crate) version: u32,
    pub(crate) run_id: String,
    pub(crate) name: String,
    pub(crate) lead_session: String,
    pub(crate) status: WorkflowRunStatus,
    pub(crate) script_path: String,
    pub(crate) saved_script_path: Option<String>,
    pub(crate) max_concurrency: usize,
    pub(crate) max_agents: usize,
    pub(crate) phases: Vec<WorkflowPhase>,
    pub(crate) agents: Vec<WorkflowAgentRun>,
    pub(crate) result: Option<String>,
    pub(crate) completed_cache: Vec<WorkflowCacheEntry>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowPhase {
    pub(crate) phase_id: String,
    pub(crate) name: String,
    pub(crate) status: WorkflowPhaseStatus,
    pub(crate) agent_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowAgentRun {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowCacheEntry {
    pub(crate) key: String,
    pub(crate) value: String,
    pub(crate) created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowOutput {
    pub(crate) state_dir: String,
    pub(crate) action: String,
    pub(crate) run: Option<WorkflowRun>,
    pub(crate) runs: Vec<WorkflowRun>,
    pub(crate) plan: Option<WorkflowPlan>,
    pub(crate) saved_workflows: Vec<SavedWorkflow>,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowPlan {
    pub(crate) phases: Vec<String>,
    pub(crate) agents: Vec<WorkflowAgentSpec>,
    pub(crate) waits: usize,
    pub(crate) final_result: Option<String>,
    pub(crate) raw_script: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowAgentSpec {
    pub(crate) description: String,
    pub(crate) prompt: String,
    pub(crate) subagent_type: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedWorkflow {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) scope: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CreatedWorkflowRun {
    pub(crate) run: WorkflowRun,
    pub(crate) plan: WorkflowPlan,
}

pub(crate) fn plan_workflow(input: &WorkflowInput) -> Result<WorkflowOutput, String> {
    let script = resolve_script(input)?;
    let plan = parse_workflow_script(&script)?;
    Ok(WorkflowOutput {
        state_dir: workflow_root().display().to_string(),
        action: "plan".to_string(),
        run: None,
        runs: Vec::new(),
        plan: Some(plan),
        saved_workflows: Vec::new(),
        message: Some("approval is required before starting this workflow".to_string()),
    })
}

pub(crate) fn create_run(input: &WorkflowInput) -> Result<CreatedWorkflowRun, String> {
    let script = resolve_script(input)?;
    let plan = parse_workflow_script(&script)?;
    let max_agents = input.max_agents.unwrap_or(16).max(1);
    if plan.agents.len() > max_agents {
        return Err(format!(
            "workflow requests {} agents but maxAgents is {max_agents}",
            plan.agents.len()
        ));
    }
    if !matches!(
        input.approval,
        Some(WorkflowApproval::AllowOnce | WorkflowApproval::Always)
    ) {
        let run = write_run(input, &plan, WorkflowRunStatus::ApprovalRequired, &script)?;
        return Ok(CreatedWorkflowRun { run, plan });
    }
    let status = if plan.agents.is_empty() && plan.final_result.is_some() {
        WorkflowRunStatus::Completed
    } else {
        WorkflowRunStatus::Running
    };
    let run = write_run(input, &plan, status, &script)?;
    append_workflow_event(
        "WorkflowStarted",
        &run,
        json!({ "agents": plan.agents.len() }),
    )?;
    Ok(CreatedWorkflowRun { run, plan })
}

pub(crate) fn record_agent(
    run_id: &str,
    agent_id: &str,
    name: &str,
    description: &str,
    status: &str,
) -> Result<WorkflowRun, String> {
    let mut run = load_run(run_id)?;
    run.agents.push(WorkflowAgentRun {
        agent_id: agent_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        status: status.to_string(),
    });
    if let Some(phase) = run.phases.iter_mut().find(|phase| {
        matches!(
            phase.status,
            WorkflowPhaseStatus::Running | WorkflowPhaseStatus::Pending
        )
    }) {
        phase.status = WorkflowPhaseStatus::Waiting;
        phase.agent_ids.push(agent_id.to_string());
    }
    run.updated_at = epoch_secs();
    save_run(&run)?;
    append_workflow_event(
        "WorkflowAgentStarted",
        &run,
        json!({ "agentId": agent_id, "description": description }),
    )?;
    Ok(run)
}

pub(crate) fn complete_run_with_result(run_id: &str, result: &str) -> Result<WorkflowRun, String> {
    let mut run = load_run(run_id)?;
    run.status = WorkflowRunStatus::Completed;
    run.result = Some(result.to_string());
    run.updated_at = epoch_secs();
    for phase in &mut run.phases {
        if !matches!(phase.status, WorkflowPhaseStatus::Failed) {
            phase.status = WorkflowPhaseStatus::Completed;
        }
    }
    if let Some(entry) = run
        .completed_cache
        .iter_mut()
        .find(|entry| entry.key == "final_result")
    {
        entry.value = result.to_string();
        entry.created_at = run.updated_at;
    } else {
        run.completed_cache.push(WorkflowCacheEntry {
            key: "final_result".to_string(),
            value: result.to_string(),
            created_at: run.updated_at,
        });
    }
    save_run(&run)?;
    append_workflow_event("WorkflowCompleted", &run, json!({ "hasResult": true }))?;
    Ok(run)
}

pub(crate) fn control_workflow(input: &WorkflowInput) -> Result<WorkflowOutput, String> {
    match input.action {
        WorkflowAction::List => {
            let runs = list_runs()?;
            Ok(output("list", None, runs, None, None))
        }
        WorkflowAction::Inspect => {
            let run = load_required_run(input)?;
            Ok(output("inspect", Some(run), Vec::new(), None, None))
        }
        WorkflowAction::Pause | WorkflowAction::Resume | WorkflowAction::Stop => {
            let mut run = load_required_run(input)?;
            run.status = match input.action {
                WorkflowAction::Pause => WorkflowRunStatus::Paused,
                WorkflowAction::Resume => WorkflowRunStatus::Running,
                WorkflowAction::Stop => WorkflowRunStatus::Stopped,
                _ => unreachable!(),
            };
            run.updated_at = epoch_secs();
            save_run(&run)?;
            append_workflow_event(
                match input.action {
                    WorkflowAction::Pause => "WorkflowPaused",
                    WorkflowAction::Resume => "WorkflowResumed",
                    WorkflowAction::Stop => "WorkflowStopped",
                    _ => unreachable!(),
                },
                &run,
                json!({}),
            )?;
            Ok(output("control", Some(run), Vec::new(), None, None))
        }
        WorkflowAction::Save => {
            let script = resolve_script(input)?;
            let save_as = input
                .save_as
                .as_deref()
                .or(input.name.as_deref())
                .ok_or_else(|| "saveAs or name is required".to_string())?;
            let path = project_workflows_dir().join(format!("{}.js", sanitize_name(save_as)));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, script).map_err(|error| error.to_string())?;
            Ok(output(
                "save",
                None,
                Vec::new(),
                None,
                Some(format!("saved workflow script to {}", path.display())),
            ))
        }
        WorkflowAction::Discover => Ok(WorkflowOutput {
            state_dir: workflow_root().display().to_string(),
            action: "discover".to_string(),
            run: None,
            runs: Vec::new(),
            plan: None,
            saved_workflows: discover_saved_workflows(),
            message: None,
        }),
        WorkflowAction::Plan | WorkflowAction::Start | WorkflowAction::Restart => {
            Err("use the dedicated workflow start/restart path".to_string())
        }
    }
}

pub(crate) fn discover_saved_workflows() -> Vec<SavedWorkflow> {
    let mut workflows = Vec::new();
    collect_saved_workflows(&project_workflows_dir(), "project", &mut workflows);
    let user_workflows_dir = runtime::user_workflows_dir_from_env();
    collect_saved_workflows(&user_workflows_dir, "user", &mut workflows);
    let workspace = runtime::workspace_root_from_env();
    collect_saved_workflows(
        &workspace.join(".claude").join("workflows"),
        "legacy-project",
        &mut workflows,
    );
    collect_saved_workflows(
        &PathBuf::from(runtime::home_dir())
            .join(".claude")
            .join("workflows"),
        "legacy-user",
        &mut workflows,
    );
    workflows.sort_by(|left, right| left.name.cmp(&right.name));
    workflows
}

pub(crate) fn load_saved_workflow(name: &str) -> Option<String> {
    discover_saved_workflows()
        .into_iter()
        .find(|workflow| workflow.name == name || workflow.path == name)
        .and_then(|workflow| fs::read_to_string(workflow.path).ok())
}

fn write_run(
    input: &WorkflowInput,
    plan: &WorkflowPlan,
    status: WorkflowRunStatus,
    script: &str,
) -> Result<WorkflowRun, String> {
    ensure_workflow_dirs()?;
    let now = epoch_secs();
    let run_id = input
        .run_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| make_id("workflow"));
    let script_path = workflow_root()
        .join(&run_id)
        .join("workflow.js")
        .display()
        .to_string();
    let script_path_buf = PathBuf::from(&script_path);
    if let Some(parent) = script_path_buf.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&script_path_buf, script).map_err(|error| error.to_string())?;
    let phases = if plan.phases.is_empty() {
        vec![WorkflowPhase {
            phase_id: make_id("phase"),
            name: "default".to_string(),
            status: WorkflowPhaseStatus::Running,
            agent_ids: Vec::new(),
        }]
    } else {
        plan.phases
            .iter()
            .enumerate()
            .map(|(index, phase)| WorkflowPhase {
                phase_id: make_id("phase"),
                name: phase.clone(),
                status: if index == 0 {
                    WorkflowPhaseStatus::Running
                } else {
                    WorkflowPhaseStatus::Pending
                },
                agent_ids: Vec::new(),
            })
            .collect()
    };
    let completed_result = matches!(status, WorkflowRunStatus::Completed)
        .then(|| plan.final_result.clone())
        .flatten();
    let run = WorkflowRun {
        version: WORKFLOW_VERSION,
        run_id: run_id.clone(),
        name: input
            .name
            .clone()
            .unwrap_or_else(|| sanitize_name(&run_id).replace('-', " ")),
        lead_session: team_state::inherited_lead_session(),
        status,
        script_path,
        saved_script_path: input.script_path.clone(),
        max_concurrency: input.max_concurrency.unwrap_or(4).max(1),
        max_agents: input.max_agents.unwrap_or(16).max(1),
        phases,
        agents: Vec::new(),
        result: completed_result.clone(),
        completed_cache: completed_result
            .iter()
            .map(|result| WorkflowCacheEntry {
                key: "final_result".to_string(),
                value: result.clone(),
                created_at: now,
            })
            .collect(),
        created_at: now,
        updated_at: now,
    };
    save_run(&run)?;
    Ok(run)
}

fn output(
    action: &str,
    run: Option<WorkflowRun>,
    runs: Vec<WorkflowRun>,
    plan: Option<WorkflowPlan>,
    message: Option<String>,
) -> WorkflowOutput {
    WorkflowOutput {
        state_dir: workflow_root().display().to_string(),
        action: action.to_string(),
        run,
        runs,
        plan,
        saved_workflows: Vec::new(),
        message,
    }
}

fn load_required_run(input: &WorkflowInput) -> Result<WorkflowRun, String> {
    let run_id = input
        .run_id
        .as_deref()
        .ok_or_else(|| "runId is required".to_string())?;
    load_run(run_id)
}

fn save_run(run: &WorkflowRun) -> Result<(), String> {
    write_json(&run_manifest_path(&run.run_id), run)
}

fn load_run(run_id: &str) -> Result<WorkflowRun, String> {
    read_json(&run_manifest_path(run_id))
}

fn list_runs() -> Result<Vec<WorkflowRun>, String> {
    let root = workflow_root();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut runs = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path().join("manifest.json");
        if path.exists() {
            if let Ok(run) = read_json::<WorkflowRun>(&path) {
                runs.push(run);
            }
        }
    }
    runs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(runs)
}

fn parse_workflow_script(script: &str) -> Result<WorkflowPlan, String> {
    let mut phases = Vec::new();
    let mut agents = Vec::new();
    let mut waits = 0usize;
    let mut final_result = None;
    for raw in script.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with("emitPhase") {
            phases.push(extract_string_arg(line, "emitPhase")?);
            continue;
        }
        if line.starts_with("spawnAgent") {
            agents.push(extract_agent_spec(line)?);
            continue;
        }
        if line.starts_with("waitAll") {
            waits += 1;
            continue;
        }
        if line.starts_with("saveResult") {
            final_result = Some(extract_string_arg(line, "saveResult")?);
            continue;
        }
        if line.starts_with("const ") || line.starts_with("let ") || line.starts_with("await ") {
            let normalized = line
                .trim_start_matches("const ")
                .trim_start_matches("let ")
                .trim_start_matches("await ")
                .trim();
            if normalized.starts_with("spawnAgent") {
                agents.push(extract_agent_spec(normalized)?);
                continue;
            }
            if normalized.starts_with("waitAll") {
                waits += 1;
                continue;
            }
        }
        return Err(format!(
            "unsupported workflow script statement: {line}. Allowed APIs: emitPhase, spawnAgent, waitAll, saveResult"
        ));
    }
    Ok(WorkflowPlan {
        phases,
        agents,
        waits,
        final_result,
        raw_script: script.to_string(),
    })
}

fn extract_string_arg(line: &str, function_name: &str) -> Result<String, String> {
    let start = line
        .find('(')
        .ok_or_else(|| format!("{function_name} requires parentheses"))?;
    let end = line
        .rfind(')')
        .ok_or_else(|| format!("{function_name} requires closing parentheses"))?;
    let arg = line[start + 1..end].trim().trim_end_matches(';').trim();
    parse_quoted_string(arg).ok_or_else(|| format!("{function_name} requires a string literal"))
}

fn extract_agent_spec(line: &str) -> Result<WorkflowAgentSpec, String> {
    let start = line
        .find('{')
        .ok_or_else(|| "spawnAgent requires an object literal".to_string())?;
    let end = line
        .rfind('}')
        .ok_or_else(|| "spawnAgent requires a closing object literal".to_string())?;
    let object = &line[start + 1..end];
    let description = extract_object_string_field(object, "description")?
        .ok_or_else(|| "spawnAgent requires description".to_string())?;
    let prompt = extract_object_string_field(object, "prompt")?
        .ok_or_else(|| "spawnAgent requires prompt".to_string())?;
    Ok(WorkflowAgentSpec {
        description,
        prompt,
        subagent_type: extract_object_string_field(object, "subagentType")?
            .or(extract_object_string_field(object, "subagent_type")?),
        name: extract_object_string_field(object, "name")?,
        model: extract_object_string_field(object, "model")?,
    })
}

fn extract_object_string_field(object: &str, field: &str) -> Result<Option<String>, String> {
    let quoted = format!("\"{field}\"");
    let bare = field.to_string();
    let Some(index) = object.find(&quoted).or_else(|| object.find(&bare)) else {
        return Ok(None);
    };
    let after_field = &object[index + field.len()..];
    let after_colon = after_field
        .find(':')
        .map(|colon| &after_field[colon + 1..])
        .ok_or_else(|| format!("field {field} is missing ':'"))?;
    let value = after_colon.trim_start();
    parse_quoted_string(value)
        .map(Some)
        .ok_or_else(|| format!("field {field} must be a string literal"))
}

fn parse_quoted_string(value: &str) -> Option<String> {
    let value = value.trim();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut escaped = false;
    let mut out = String::new();
    for ch in value[quote.len_utf8()..].chars() {
        if escaped {
            out.push(match ch {
                'n' => '\n',
                't' => '\t',
                '"' => '"',
                '\'' => '\'',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

fn resolve_script(input: &WorkflowInput) -> Result<String, String> {
    if input.action == WorkflowAction::Restart {
        if let Some(run_id) = input
            .run_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let run = load_run(run_id)?;
            return fs::read_to_string(run.script_path).map_err(|error| error.to_string());
        }
    }
    if let Some(script) = input
        .script
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(script.to_string());
    }
    if let Some(path) = input
        .script_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    if let Some(name) = input
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if let Some(script) = load_saved_workflow(name) {
            return Ok(script);
        }
    }
    Err("script, scriptPath, or saved workflow name is required".to_string())
}

fn append_workflow_event(kind: &str, run: &WorkflowRun, payload: Value) -> Result<(), String> {
    team_state::append_event(RunEvent {
        version: 1,
        event_id: make_id("event"),
        ts: epoch_secs(),
        kind: kind.to_string(),
        team_id: None,
        session_id: Some(run.lead_session.clone()),
        agent_id: None,
        task_id: None,
        message_id: None,
        workflow_run_id: Some(run.run_id.clone()),
        payload,
    })
}

fn collect_saved_workflows(dir: &Path, scope: &str, workflows: &mut Vec<SavedWorkflow>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("js") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        workflows.push(SavedWorkflow {
            name: stem.to_string(),
            path: path.display().to_string(),
            scope: scope.to_string(),
        });
    }
}

fn ensure_workflow_dirs() -> Result<(), String> {
    fs::create_dir_all(workflow_root()).map_err(|error| error.to_string())
}

fn workflow_root() -> PathBuf {
    team_state::workflows_dir()
}

fn run_manifest_path(run_id: &str) -> PathBuf {
    workflow_root().join(run_id).join("manifest.json")
}

fn project_workflows_dir() -> PathBuf {
    runtime::project_workflows_dir_from_env()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: T) -> Result<(), String> {
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
    );
    runtime::write_file_atomically(path, body.as_bytes()).map_err(|error| error.to_string())
}

fn sanitize_name(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(64).collect()
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

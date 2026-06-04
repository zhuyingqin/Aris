//! Tauri command surface — thin wrappers over `tools::execute_tool`.
//!
//! No business logic lives here: every command builds the JSON the coordination
//! kernel already understands, calls `execute_tool`, and re-parses the pretty
//! JSON string back into a `Value` so the frontend receives a typed object.
//!
//! Tauri runs synchronous commands on a background thread, so the blocking file
//! IO inside `execute_tool` never stalls the UI event loop.

use serde::Deserialize;
use serde_json::{json, Value};
use tools::execute_tool;

use crate::state;

fn call(name: &str, input: Value) -> Result<Value, String> {
    let raw = execute_tool(name, &input)?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("failed to parse {name} output as JSON: {err}"))
}

// ── Workflow ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn workflow_plan(script: String) -> Result<Value, String> {
    call("Workflow", json!({ "action": "plan", "script": script }))
}

#[tauri::command]
pub fn workflow_list() -> Result<Value, String> {
    call("Workflow", json!({ "action": "list" }))
}

#[tauri::command]
pub fn workflow_inspect(id: String) -> Result<Value, String> {
    call("Workflow", json!({ "action": "inspect", "runId": id }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReq {
    pub script: String,
    /// `allow_once` | `always` | `deny`
    pub approval: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub save_as: Option<String>,
    #[serde(default)]
    pub max_concurrency: Option<usize>,
    #[serde(default)]
    pub max_agents: Option<usize>,
}

#[tauri::command]
pub fn workflow_start(req: StartReq) -> Result<Value, String> {
    let mut input = json!({
        "action": "start",
        "script": req.script,
        "approval": req.approval,
    });
    if let Some(value) = req.name {
        input["name"] = json!(value);
    }
    if let Some(value) = req.save_as {
        input["saveAs"] = json!(value);
    }
    if let Some(value) = req.max_concurrency {
        input["maxConcurrency"] = json!(value);
    }
    if let Some(value) = req.max_agents {
        input["maxAgents"] = json!(value);
    }
    call("Workflow", input)
}

/// `action` ∈ `pause` | `resume` | `stop` | `restart`
#[tauri::command]
pub fn workflow_control(id: String, action: String) -> Result<Value, String> {
    call("Workflow", json!({ "action": action, "runId": id }))
}

#[tauri::command]
pub fn workflow_save(name: String, script: String) -> Result<Value, String> {
    call("Workflow", json!({ "action": "save", "saveAs": name, "script": script }))
}

#[tauri::command]
pub fn workflow_discover() -> Result<Value, String> {
    call("Workflow", json!({ "action": "discover" }))
}

// ── Team / Agents ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn team_list(team: Option<String>, messages: bool, events: bool) -> Result<Value, String> {
    let mut input = json!({ "includeMessages": messages, "includeEvents": events });
    if let Some(team_id) = team {
        input["teamId"] = json!(team_id);
    }
    call("ListTeam", input)
}

/// `action` ∈ `list` | `status` | `logs` | `stop` | `restart`
#[tauri::command]
pub fn agent_supervisor(action: String, agent: Option<String>) -> Result<Value, String> {
    let mut input = json!({ "action": action });
    if let Some(agent_id) = agent {
        input["agentId"] = json!(agent_id);
    }
    call("AgentSupervisor", input)
}

// ── Skills ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn skills_list() -> Vec<tools::SkillMeta> {
    tools::discover_skills()
}

#[tauri::command]
pub fn skill_view(name: String) -> Result<String, String> {
    tools::skill_markdown(&name).ok_or_else(|| format!("skill not found: {name}"))
}

// ── Misc ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn state_dir() -> String {
    state::state_root().display().to_string()
}

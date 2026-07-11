use std::path::Path;

use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandManifestEntry {
    pub name: String,
    pub source: CommandSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandSource {
    Builtin,
    InternalOnly,
    FeatureGated,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandRegistry {
    entries: Vec<CommandManifestEntry>,
}

impl CommandRegistry {
    #[must_use]
    pub fn new(entries: Vec<CommandManifestEntry>) -> Self {
        Self { entries }
    }

    #[must_use]
    pub fn entries(&self) -> &[CommandManifestEntry] {
        &self.entries
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashCommandSpec {
    pub name: &'static str,
    pub summary: &'static str,
    pub argument_hint: Option<&'static str>,
    pub resume_supported: bool,
}

const SLASH_COMMAND_SPECS: &[SlashCommandSpec] = &[
    SlashCommandSpec {
        name: "help",
        summary: "Show available slash commands",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "status",
        summary: "Show current session status",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "compact",
        summary: "Compact local session history",
        argument_hint: Some("[instruction]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "model",
        summary: "Select executor model (Claude/OpenAI/DeepSeek/...)",
        argument_hint: Some("[model]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "reviewer",
        summary: "Select reviewer model (OpenAI/Gemini/GLM/MiniMax/Kimi/Anthropic for LlmReview)",
        argument_hint: Some("[model]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "setup",
        summary: "Reconfigure API keys and models",
        argument_hint: None,
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "plan",
        summary: "Enter read-only plan mode (plan execute|plan exit)",
        argument_hint: Some("<task>|execute|exit"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "tasks",
        summary: "View or manage persistent task list",
        argument_hint: Some("[show|clear]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "skills",
        summary: "List, show, or export skills",
        argument_hint: Some("[list|show <name>|export <name>]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "permissions",
        summary: "Show or switch the active permission mode",
        argument_hint: Some("[read-only|workspace-write|danger-full-access]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "clear",
        summary: "Start a fresh local session",
        argument_hint: Some("[--confirm]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "cost",
        summary: "Show cumulative token usage for this session",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "resume",
        summary: "Load a saved session into the REPL",
        argument_hint: Some("<session-path>"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "config",
        summary: "Inspect Claude config files or merged sections",
        argument_hint: Some("[env|hooks|model]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "memory",
        summary: "Inspect or approve persistent hot memory",
        argument_hint: Some("[pending|approve <id>|reject <id>|approval on|off]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "goal",
        summary: "Inspect or manage the active project goal",
        argument_hint: Some("[start|status|pause|resume|replace|complete] [objective]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "init",
        summary: "Create a starter AGENTS.md for this repo",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "diff",
        summary: "Show git diff for current workspace changes",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "version",
        summary: "Show CLI version and build information",
        argument_hint: None,
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "bughunter",
        summary: "Inspect the codebase for likely bugs",
        argument_hint: Some("[scope]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "commit",
        summary: "Generate a commit message and create a git commit",
        argument_hint: None,
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "pr",
        summary: "Draft or create a pull request from the conversation",
        argument_hint: Some("[context]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "issue",
        summary: "Draft or create a GitHub issue from the conversation",
        argument_hint: Some("[context]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "ultraplan",
        summary: "Run a deep planning prompt with multi-step reasoning",
        argument_hint: Some("[task]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "teleport",
        summary: "Jump to a file or symbol by searching the workspace",
        argument_hint: Some("<symbol-or-path>"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "debug-tool-call",
        summary: "Replay the last tool call with debug details",
        argument_hint: None,
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "export",
        summary: "Export the current conversation to a file",
        argument_hint: Some("[file]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "export-debug-zip",
        summary: "Export a bug-report bundle with transcript, events, wire trace, and diagnostics",
        argument_hint: Some("[file]"),
        resume_supported: true,
    },
    SlashCommandSpec {
        name: "session",
        summary: "List, switch, or inspect managed local sessions",
        argument_hint: Some("[list|search <query>|switch <session-id>|timeline [session-id]]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "team",
        summary: "Inspect Agent Team members, tasks, mailbox, and events",
        argument_hint: Some("[list|raw|events|messages|supervisor] [team-id]"),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "workflows",
        summary: "List, inspect, control, save, discover, or start dynamic workflows",
        argument_hint: Some(
            "[list|inspect|pause|resume|stop|restart|save|discover|start|allow-once|always|deny|inject]",
        ),
        resume_supported: false,
    },
    SlashCommandSpec {
        name: "meta-optimize",
        summary: "Analyze usage logs and optimize SomniQ skills",
        argument_hint: Some("[apply <N>|status]"),
        resume_supported: false,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashCommand {
    Help,
    Status,
    Compact {
        instruction: Option<String>,
    },
    Bughunter {
        scope: Option<String>,
    },
    Commit,
    Pr {
        context: Option<String>,
    },
    Issue {
        context: Option<String>,
    },
    Ultraplan {
        task: Option<String>,
    },
    Teleport {
        target: Option<String>,
    },
    DebugToolCall,
    Model {
        model: Option<String>,
    },
    Reviewer {
        model: Option<String>,
    },
    Permissions {
        mode: Option<String>,
    },
    Clear {
        confirm: bool,
    },
    Cost,
    Resume {
        session_path: Option<String>,
    },
    Config {
        section: Option<String>,
    },
    Memory {
        action: Option<String>,
        target: Option<String>,
    },
    Goal {
        action: Option<String>,
        objective: Option<String>,
    },
    Init,
    Diff,
    Version,
    Export {
        path: Option<String>,
    },
    ExportDebugZip {
        path: Option<String>,
    },
    Session {
        action: Option<String>,
        target: Option<String>,
    },
    Team {
        action: Option<String>,
        target: Option<String>,
    },
    Workflows {
        action: Option<String>,
        target: Option<String>,
    },
    Setup,
    Plan {
        task: Option<String>,
    },
    Tasks {
        action: Option<String>,
    },
    Skills {
        action: Option<String>,
        target: Option<String>,
    },
    MetaOptimize {
        action: Option<String>,
        target: Option<String>,
    },
    Unknown {
        name: String,
        args: Option<String>,
    },
}

impl SlashCommand {
    #[must_use]
    pub fn parse(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        if !trimmed.starts_with('/') {
            return None;
        }

        let mut parts = trimmed.trim_start_matches('/').split_whitespace();
        let command = parts.next().unwrap_or_default();
        Some(match command {
            "help" => Self::Help,
            "status" => Self::Status,
            "compact" => Self::Compact {
                instruction: remainder_after_command(trimmed, command),
            },
            "bughunter" => Self::Bughunter {
                scope: remainder_after_command(trimmed, command),
            },
            "commit" => Self::Commit,
            "pr" => Self::Pr {
                context: remainder_after_command(trimmed, command),
            },
            "issue" => Self::Issue {
                context: remainder_after_command(trimmed, command),
            },
            "ultraplan" => Self::Ultraplan {
                task: remainder_after_command(trimmed, command),
            },
            "teleport" => Self::Teleport {
                target: remainder_after_command(trimmed, command),
            },
            "debug-tool-call" => Self::DebugToolCall,
            "model" => Self::Model {
                model: parts.next().map(ToOwned::to_owned),
            },
            "reviewer" => Self::Reviewer {
                model: parts.next().map(ToOwned::to_owned),
            },
            "permissions" => Self::Permissions {
                mode: parts.next().map(ToOwned::to_owned),
            },
            "clear" => Self::Clear {
                confirm: parts.next() == Some("--confirm"),
            },
            "cost" => Self::Cost,
            "resume" => Self::Resume {
                session_path: parts.next().map(ToOwned::to_owned),
            },
            "config" => Self::Config {
                section: parts.next().map(ToOwned::to_owned),
            },
            "memory" => Self::Memory {
                action: parts.next().map(ToOwned::to_owned),
                target: parts.next().map(ToOwned::to_owned),
            },
            "goal" => {
                let action = parts.next().map(ToOwned::to_owned);
                let objective = {
                    let rest = parts.collect::<Vec<_>>().join(" ");
                    (!rest.is_empty()).then_some(rest)
                };
                Self::Goal { action, objective }
            }
            "init" => Self::Init,
            "diff" => Self::Diff,
            "version" => Self::Version,
            "setup" => Self::Setup,
            "plan" => Self::Plan {
                task: remainder_after_command(trimmed, command),
            },
            "tasks" => Self::Tasks {
                action: remainder_after_command(trimmed, command),
            },
            "skills" => Self::Skills {
                action: parts.next().map(ToOwned::to_owned),
                target: parts.next().map(ToOwned::to_owned),
            },
            "export" => Self::Export {
                path: remainder_after_command(trimmed, command),
            },
            "export-debug-zip" => Self::ExportDebugZip {
                path: remainder_after_command(trimmed, command),
            },
            "session" => {
                let action = parts.next().map(ToOwned::to_owned);
                let target = {
                    let rest = parts.collect::<Vec<_>>().join(" ");
                    (!rest.is_empty()).then_some(rest)
                };
                Self::Session { action, target }
            }
            "team" => Self::Team {
                action: parts.next().map(ToOwned::to_owned),
                target: parts.next().map(ToOwned::to_owned),
            },
            "workflows" => Self::Workflows {
                action: parts.next().map(ToOwned::to_owned),
                target: parts.next().map(ToOwned::to_owned),
            },
            "meta-optimize" => Self::MetaOptimize {
                action: parts.next().map(ToOwned::to_owned),
                target: parts.next().map(ToOwned::to_owned),
            },
            other => Self::Unknown {
                name: other.to_string(),
                args: remainder_after_command(trimmed, other),
            },
        })
    }
}

fn remainder_after_command(input: &str, command: &str) -> Option<String> {
    input
        .trim()
        .strip_prefix(&format!("/{command}"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[must_use]
pub fn slash_command_specs() -> &'static [SlashCommandSpec] {
    SLASH_COMMAND_SPECS
}

#[must_use]
pub fn resume_supported_slash_commands() -> Vec<&'static SlashCommandSpec> {
    slash_command_specs()
        .iter()
        .filter(|spec| spec.resume_supported)
        .collect()
}

#[must_use]
pub fn render_slash_command_help() -> String {
    let mut lines = vec![
        "Slash commands".to_string(),
        "  [resume] means the command also works with --resume SESSION.json".to_string(),
    ];
    for spec in slash_command_specs() {
        let name = match spec.argument_hint {
            Some(argument_hint) => format!("/{} {}", spec.name, argument_hint),
            None => format!("/{}", spec.name),
        };
        let resume = if spec.resume_supported {
            " [resume]"
        } else {
            ""
        };
        lines.push(format!("  {name:<20} {}{}", spec.summary, resume));
    }
    lines.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamCommandPlan {
    RenderTeamView {
        team_id: Option<String>,
    },
    Tool {
        name: &'static str,
        input: serde_json::Value,
    },
    Message(String),
}

#[must_use]
pub fn plan_team_command(action: Option<&str>, target: Option<&str>) -> TeamCommandPlan {
    match action {
        None | Some("list") => TeamCommandPlan::RenderTeamView {
            team_id: target.map(ToOwned::to_owned),
        },
        Some("raw") => TeamCommandPlan::Tool {
            name: "ListTeam",
            input: team_tool_input(target, true, true),
        },
        Some("messages") => TeamCommandPlan::Tool {
            name: "ListTeam",
            input: team_tool_input(target, true, false),
        },
        Some("events") => TeamCommandPlan::Tool {
            name: "ListTeam",
            input: team_tool_input(target, true, true),
        },
        Some("supervisor") => {
            let mut input = json!({ "action": "list" });
            if let Some(team_id) = target {
                input["teamId"] = json!(team_id);
            }
            TeamCommandPlan::Tool {
                name: "AgentSupervisor",
                input,
            }
        }
        Some(other) => TeamCommandPlan::Message(format!(
            "Unknown /team action '{other}'. Use /team [list], /team raw, /team messages, /team events, or /team supervisor."
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowCommandPlan {
    Tool { input: serde_json::Value },
    Inject { run_id: String },
    Message(String),
}

#[must_use]
pub fn plan_workflows_command(action: Option<&str>, target: Option<&str>) -> WorkflowCommandPlan {
    let action = action.unwrap_or("list");
    match action {
        "list" => WorkflowCommandPlan::Tool {
            input: json!({ "action": "list" }),
        },
        "discover" => WorkflowCommandPlan::Tool {
            input: json!({ "action": "discover" }),
        },
        "start" => {
            let Some(target) = target else {
                return WorkflowCommandPlan::Message(
                    "Usage: /workflows start <saved-name-or-script-path>".to_string(),
                );
            };
            WorkflowCommandPlan::Tool {
                input: workflow_start_input("plan", target, None),
            }
        }
        "allow-once" | "always" => {
            let Some(target) = target else {
                return WorkflowCommandPlan::Message(format!(
                    "Usage: /workflows {action} <saved-name-or-script-path>"
                ));
            };
            let approval = if action == "allow-once" {
                "allow_once"
            } else {
                "always"
            };
            WorkflowCommandPlan::Tool {
                input: workflow_start_input("start", target, Some(approval)),
            }
        }
        "deny" => WorkflowCommandPlan::Message("Workflow approval denied.".to_string()),
        "inspect" | "pause" | "resume" | "stop" | "restart" => {
            let Some(run_id) = target else {
                return WorkflowCommandPlan::Message(format!("Usage: /workflows {action} <run-id>"));
            };
            WorkflowCommandPlan::Tool {
                input: json!({
                    "action": action,
                    "runId": run_id,
                    "approval": "allow_once"
                }),
            }
        }
        "inject" => {
            let Some(run_id) = target else {
                return WorkflowCommandPlan::Message("Usage: /workflows inject <run-id>".to_string());
            };
            WorkflowCommandPlan::Inject {
                run_id: run_id.to_string(),
            }
        }
        "save" => {
            let Some(script_path) = target else {
                return WorkflowCommandPlan::Message("Usage: /workflows save <script-path>".to_string());
            };
            let save_as = Path::new(script_path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("workflow");
            WorkflowCommandPlan::Tool {
                input: json!({
                    "action": "save",
                    "scriptPath": script_path,
                    "saveAs": save_as,
                }),
            }
        }
        other => WorkflowCommandPlan::Message(format!(
            "Unknown /workflows action '{other}'. Use list, discover, start, allow-once, always, inspect, pause, resume, stop, restart, save, or inject."
        )),
    }
}

fn team_tool_input(
    team_id: Option<&str>,
    include_messages: bool,
    include_events: bool,
) -> serde_json::Value {
    let mut input = json!({
        "includeMessages": include_messages,
        "includeEvents": include_events,
    });
    if let Some(team_id) = team_id {
        input["teamId"] = json!(team_id);
    }
    input
}

fn workflow_start_input(action: &str, target: &str, approval: Option<&str>) -> serde_json::Value {
    let mut input = json!({ "action": action });
    if Path::new(target).exists() {
        input["scriptPath"] = json!(target);
    } else {
        input["name"] = json!(target);
    }
    if let Some(approval) = approval {
        input["approval"] = json!(approval);
    }
    input
}

#[cfg(test)]
#[path = "tests/lib.rs"]
mod tests;

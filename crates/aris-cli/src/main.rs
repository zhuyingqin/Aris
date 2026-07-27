mod cli_repl;
mod cli_skills;
mod cli_tool_format;
mod config;
mod init;
mod input;
mod meta_optimize;
mod openai_compat;
mod render;
mod timeline;

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use api::{resolve_startup_auth_source, AnthropicClient, AuthSource};
#[cfg(test)]
use api::{
    ImageSource, InputContentBlock, InputMessage, MessageResponse, OutputContentBlock,
    ToolResultContentBlock,
};

use cli_repl::{run_repl, LiveCli};
use cli_skills::{
    count_filesystem_skills, dirs_aris_skills, discover_all_skills, find_skill_content,
    is_known_skill, skill_search_dirs, which_codex,
};
use cli_tool_format::{format_tool_call_start, format_tool_result};
use commands::{
    render_slash_command_help, resume_supported_slash_commands, slash_command_specs, SlashCommand,
};
use compat_harness::{extract_manifest, UpstreamPaths};
use crossterm::{
    cursor::MoveToColumn,
    execute,
    terminal::{Clear, ClearType},
};
use init::initialize_repo;
use render::{MarkdownStreamState, Spinner, TerminalRenderer};
#[cfg(test)]
use runtime::{AssistantEvent, ConversationMessage, TokenUsage};
use runtime::{
    clear_oauth_credentials, format_compact_report, format_cost_report, format_status_report,
    generate_pkce_pair, generate_state, load_system_prompt, parse_oauth_callback_request_target,
    save_oauth_credentials, CompactionConfig, ConfigLoader, ContentBlock, ConversationRuntime,
    MessageRole, OAuthAuthorizationRequest, OAuthConfig, OAuthTokenExchangeRequest, PermissionMode,
    ProjectContext, RuntimeError, Session, StatusContext, StatusUsage, ToolError, ToolExecution,
    ToolExecutor, ToolInvocation, UsageTracker,
};
use serde_json::json;
use tools::{execute_tool_with_context, mvp_tool_specs, tool_execution, ToolRunContext};

const DEFAULT_MODEL: &str = "claude-opus-4-8";
const DEFAULT_MODEL_FALLBACK: &str = "claude-opus-4-7";
const DEFAULT_OAUTH_CALLBACK_PORT: u16 = 4545;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const BUILD_TARGET: Option<&str> = option_env!("TARGET");
/// Compile date injected by build.rs (`date '+%Y-%m-%d'` on Unix; "unknown"
/// fallback on platforms without date(1)). Replaces the legacy `DEFAULT_DATE`
/// const that survived v0.4.6's system-prompt-date fix (v0.4.6 only touched
/// ProjectContext::current_date, not the --version surface).
const BUILD_DATE: &str = match option_env!("ARIS_BUILD_DATE") {
    Some(d) if !d.is_empty() => d,
    _ => "unknown",
};
const GIT_SHA: Option<&str> = option_env!("GIT_SHA");

pub(crate) type AllowedToolSet = BTreeSet<String>;

/// True if the process has at least one usable executor auth source for the
/// currently selected executor provider. Mirrors the real resolution in
/// `resolve_openai_executor_config` and `api::resolve_startup_auth_source` so
/// the "no API key, run setup" guard does not misfire for users with
/// legitimate credentials. We deliberately do NOT probe the macOS keychain —
/// the API client handles that with proper error propagation.
///
/// Importantly, this is gated on `EXECUTOR_PROVIDER`: if the user selected
/// `openai`, an Anthropic OAuth token on disk is NOT usable auth — letting it
/// pass the gate would skip setup then fall back to an Anthropic runtime with
/// an OpenAI model, which fails in confusing ways.
fn has_any_executor_auth() -> bool {
    let env_non_empty = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };

    // Use EXACT match (no trim) to stay 1:1 with `resolve_openai_executor_config()`.
    // If we trimmed here but the resolver didn't, a value like `"openai "` would
    // pass the gate but the resolver would reject it, causing a silent fallback
    // to the Anthropic runtime with an OpenAI model.
    let openai_selected = std::env::var("EXECUTOR_PROVIDER").ok().as_deref() == Some("openai");

    if openai_selected {
        // OpenAI-compat executor: only OpenAI-style keys count. Anthropic
        // OAuth tokens can't authenticate an OpenAI endpoint, so they must
        // NOT make this function return true.
        return env_non_empty("EXECUTOR_API_KEY") || env_non_empty("OPENAI_API_KEY");
    }

    // Anthropic executor (default or explicit): native API key or Bearer token.
    if env_non_empty("ANTHROPIC_API_KEY") || env_non_empty("ANTHROPIC_AUTH_TOKEN") {
        return true;
    }

    // Saved OAuth credentials. Mirrors `api::resolve_startup_auth_source`:
    //   - non-expired token → usable
    //   - expired token + refresh_token → usable ONLY if the runtime OAuth
    //     config is loadable (refresh needs the client_id/endpoint from it)
    //   - expired without refresh → NOT usable, fall through to setup
    //
    // `load_oauth_credentials` / `runtime_oauth_config_loadable` are offline
    // file reads; no network calls happen in this gate.
    if let Ok(Some(token)) = runtime::load_oauth_credentials() {
        let expired = token
            .expires_at
            .is_some_and(|ts| ts <= unix_timestamp_now());
        if !expired {
            return true;
        }
        let has_refresh = token
            .refresh_token
            .as_deref()
            .is_some_and(|s| !s.is_empty());
        if has_refresh && runtime_oauth_config_loadable() {
            return true;
        }
    }

    false
}

/// True if the runtime OAuth config (client_id + endpoints) can be loaded from
/// disk. Used by `has_any_executor_auth` to decide whether an expired-with-
/// refresh token will actually be refreshable on first API call.
fn runtime_oauth_config_loadable() -> bool {
    let Ok(cwd) = env::current_dir() else {
        return false;
    };
    ConfigLoader::default_for(&cwd)
        .load()
        .ok()
        .and_then(|cfg| cfg.oauth().cloned())
        .is_some()
}

fn unix_timestamp_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "error: {error}

Run `aris --help` for usage."
        );
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Materialise bundled skill helpers into ~/.config/aris/cache/<version>/
    // and set ARIS_CACHE_DIR so SKILL.md resolver chains + bash subprocesses can
    // find helpers via a stable path. Must run BEFORE any other init that may
    // spawn child processes. See idea-stage/v0.4.8/T1_cache_design.md.
    let report = runtime::extract_bundle();
    if let Some(dir) = &report.used_dir {
        // Forward-slash normalise on Windows so SKILL.md bash blocks (POSIX
        // shell under git-bash / WSL) and the T6 resolver preamble see the
        // same shape. Rust + Windows API accept `/` in paths, so fs ops still
        // work; only the env var representation changes.
        let dir_str = dir.display().to_string().replace('\\', "/");
        env::set_var("ARIS_CACHE_DIR", dir_str);
    } else {
        env::remove_var("ARIS_CACHE_DIR");
    }
    if report.hard_error {
        eprintln!(
            "warning: bundled helper extraction failed at all locations ({}). \
             Skills that depend on bundled helpers may not work; see fallback chain.",
            report.paths_tried.join(", ")
        );
    } else if !report.failed.is_empty() {
        eprintln!(
            "warning: {} bundled helper(s) failed to extract; see SkillOutput.helperReport for details.",
            report.failed.len()
        );
    }

    // Load saved ARIS config and apply to env (env vars always take priority)
    let saved_config = config::ArisConfig::load();
    saved_config.apply_to_env();
    init_aris_tasks_env();

    let args: Vec<String> = env::args().skip(1).collect();
    let action = parse_args(&args)?;

    // For REPL and Prompt modes: if no executor auth is available, run setup first.
    // Must mirror the real auth resolution in resolve_openai_executor_config() +
    // api::resolve_startup_auth_source() — otherwise a user whose auth DOES work
    // (shell env var or saved OAuth credentials) would be wrongly routed through
    // setup, and force_apply_to_env() would erase their shell-provided key.
    let needs_api_key = match &action {
        CliAction::Repl { .. } | CliAction::Prompt { .. } => true,
        CliAction::ResumeSession { commands, .. } => commands.iter().any(|command| {
            matches!(
                SlashCommand::parse(command),
                Some(SlashCommand::Compact { .. })
            )
        }),
        _ => false,
    };
    if needs_api_key && !has_any_executor_auth() {
        println!("\x1b[1;33mNo API key found.\x1b[0m Let's set up ARIS first.\n");
        let new_config = config::run_interactive_setup()?;
        // Force-apply only EXECUTOR env vars. This overrides any stale
        // executor values left over from `saved_config.apply_to_env()` above
        // (e.g. `EXECUTOR_BASE_URL` pointing at an old proxy URL), while
        // preserving shell-provided reviewer keys like `OPENAI_API_KEY`,
        // `GEMINI_API_KEY`, etc. Using the full `force_apply_to_env()` here
        // would wipe a reviewer key the user set in their shell but did not
        // retype during the wizard.
        new_config.force_apply_executor_env();
    }

    match action {
        CliAction::DumpManifests => dump_manifests(),
        CliAction::BootstrapPlan => print_bootstrap_plan(),
        CliAction::PrintSystemPrompt { cwd, date } => print_system_prompt(cwd, date),
        CliAction::Version => print_version(),
        CliAction::ResumeSession {
            session_path,
            commands,
            mut model,
            allowed_tools,
            permission_mode,
        } => {
            if model == DEFAULT_MODEL {
                model = saved_config
                    .executor_model()
                    .map(|m| resolve_model_alias(m).to_string())
                    .unwrap_or(model);
            }
            resume_session(
                &session_path,
                &commands,
                model,
                allowed_tools,
                permission_mode,
            )?;
        }
        CliAction::Prompt {
            prompt,
            mut model,
            output_format,
            allowed_tools,
            permission_mode,
        } => {
            // Match REPL behavior: when the caller did not pass --model, use
            // the saved executor model from ~/.config/aris/config.json.
            if model == DEFAULT_MODEL {
                model = saved_config
                    .executor_model()
                    .map(|m| resolve_model_alias(m).to_string())
                    .unwrap_or(model);
            }
            LiveCli::new(model, true, allowed_tools, permission_mode)?
                .run_turn_with_output(&prompt, output_format)?;
        }
        CliAction::Login => run_login()?,
        CliAction::Logout => run_logout()?,
        CliAction::Init => run_init()?,
        CliAction::Repl {
            model,
            allowed_tools,
            permission_mode,
        } => {
            // Use saved model from config if user didn't specify --model
            let model = if model == DEFAULT_MODEL {
                saved_config
                    .executor_model()
                    .map(|m| resolve_model_alias(m).to_string())
                    .unwrap_or(model)
            } else {
                model
            };
            run_repl(model, allowed_tools, permission_mode)?;
        }
        CliAction::Help => print_help(),
        CliAction::Setup => {
            config::run_interactive_setup()?;
        }
        CliAction::Doctor => run_doctor()?,
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliAction {
    DumpManifests,
    BootstrapPlan,
    PrintSystemPrompt {
        cwd: PathBuf,
        date: String,
    },
    Version,
    ResumeSession {
        session_path: PathBuf,
        commands: Vec<String>,
        model: String,
        allowed_tools: Option<AllowedToolSet>,
        permission_mode: PermissionMode,
    },
    Prompt {
        prompt: String,
        model: String,
        output_format: CliOutputFormat,
        allowed_tools: Option<AllowedToolSet>,
        permission_mode: PermissionMode,
    },
    Login,
    Logout,
    Init,
    Repl {
        model: String,
        allowed_tools: Option<AllowedToolSet>,
        permission_mode: PermissionMode,
    },
    // prompt-mode formatting is only supported for non-interactive runs
    Help,
    Setup,
    Doctor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliOutputFormat {
    Text,
    Json,
}

impl CliOutputFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "text" => Ok(Self::Text),
            "json" => Ok(Self::Json),
            other => Err(format!(
                "unsupported value for --output-format: {other} (expected text or json)"
            )),
        }
    }
}

#[allow(clippy::too_many_lines)]
fn parse_args(args: &[String]) -> Result<CliAction, String> {
    let mut model = DEFAULT_MODEL.to_string();
    let mut output_format = CliOutputFormat::Text;
    let mut permission_mode = default_permission_mode();
    let mut wants_version = false;
    let mut allowed_tool_values = Vec::new();
    let mut rest = Vec::new();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--version" | "-V" => {
                wants_version = true;
                index += 1;
            }
            "--model" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --model".to_string())?;
                model = resolve_model_alias(value).to_string();
                index += 2;
            }
            flag if flag.starts_with("--model=") => {
                model = resolve_model_alias(&flag[8..]).to_string();
                index += 1;
            }
            "--output-format" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --output-format".to_string())?;
                output_format = CliOutputFormat::parse(value)?;
                index += 2;
            }
            "--permission-mode" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --permission-mode".to_string())?;
                permission_mode = parse_permission_mode_arg(value)?;
                index += 2;
            }
            flag if flag.starts_with("--output-format=") => {
                output_format = CliOutputFormat::parse(&flag[16..])?;
                index += 1;
            }
            flag if flag.starts_with("--permission-mode=") => {
                permission_mode = parse_permission_mode_arg(&flag[18..])?;
                index += 1;
            }
            "--dangerously-skip-permissions" => {
                permission_mode = PermissionMode::DangerFullAccess;
                index += 1;
            }
            "-p" => {
                // Claude Code compat: -p "prompt" = one-shot prompt
                let prompt = args[index + 1..].join(" ");
                if prompt.trim().is_empty() {
                    return Err("-p requires a prompt string".to_string());
                }
                return Ok(CliAction::Prompt {
                    prompt,
                    model: resolve_model_alias(&model).to_string(),
                    output_format,
                    allowed_tools: normalize_allowed_tools(&allowed_tool_values)?,
                    permission_mode,
                });
            }
            "--print" => {
                // Claude Code compat: --print makes output non-interactive
                output_format = CliOutputFormat::Text;
                index += 1;
            }
            "--allowedTools" | "--allowed-tools" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --allowedTools".to_string())?;
                allowed_tool_values.push(value.clone());
                index += 2;
            }
            flag if flag.starts_with("--allowedTools=") => {
                allowed_tool_values.push(flag[15..].to_string());
                index += 1;
            }
            flag if flag.starts_with("--allowed-tools=") => {
                allowed_tool_values.push(flag[16..].to_string());
                index += 1;
            }
            other => {
                rest.push(other.to_string());
                index += 1;
            }
        }
    }

    if wants_version {
        return Ok(CliAction::Version);
    }

    let allowed_tools = normalize_allowed_tools(&allowed_tool_values)?;

    if rest.is_empty() {
        return Ok(CliAction::Repl {
            model,
            allowed_tools,
            permission_mode,
        });
    }
    if matches!(rest.first().map(String::as_str), Some("--help" | "-h")) {
        return Ok(CliAction::Help);
    }
    if rest.first().map(String::as_str) == Some("--resume") {
        return parse_resume_args(&rest[1..], model, allowed_tools, permission_mode);
    }

    match rest[0].as_str() {
        "dump-manifests" => Ok(CliAction::DumpManifests),
        "bootstrap-plan" => Ok(CliAction::BootstrapPlan),
        "system-prompt" => parse_system_prompt_args(&rest[1..]),
        "login" => Ok(CliAction::Login),
        "logout" => Ok(CliAction::Logout),
        "init" => Ok(CliAction::Init),
        "setup" => Ok(CliAction::Setup),
        "doctor" => Ok(CliAction::Doctor),
        "prompt" => {
            let prompt = rest[1..].join(" ");
            if prompt.trim().is_empty() {
                return Err("prompt subcommand requires a prompt string".to_string());
            }
            Ok(CliAction::Prompt {
                prompt,
                model,
                output_format,
                allowed_tools,
                permission_mode,
            })
        }
        other if !other.starts_with('/') => Ok(CliAction::Prompt {
            prompt: rest.join(" "),
            model,
            output_format,
            allowed_tools,
            permission_mode,
        }),
        other => Err(format!("unknown subcommand: {other}")),
    }
}

fn resolve_model_alias(model: &str) -> &str {
    // When using OpenAI-compat executor, don't map to Claude model IDs
    if std::env::var("EXECUTOR_PROVIDER")
        .ok()
        .is_some_and(|p| p == "openai")
    {
        return model;
    }
    match model {
        "opus" => "claude-opus-4-8",
        "sonnet" => "claude-sonnet-4-6",
        "haiku" => "claude-haiku-4-5-20251001",
        _ => model,
    }
}

fn normalize_allowed_tools(values: &[String]) -> Result<Option<AllowedToolSet>, String> {
    if values.is_empty() {
        return Ok(None);
    }

    let canonical_names = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name.to_string())
        .collect::<Vec<_>>();
    let mut name_map = canonical_names
        .iter()
        .map(|name| (normalize_tool_name(name), name.clone()))
        .collect::<BTreeMap<_, _>>();

    for (alias, canonical) in [
        ("read", "read_file"),
        ("write", "write_file"),
        ("edit", "edit_file"),
        ("glob", "glob_search"),
        ("grep", "grep_search"),
    ] {
        name_map.insert(alias.to_string(), canonical.to_string());
    }

    let mut allowed = AllowedToolSet::new();
    for value in values {
        for token in value
            .split(|ch: char| ch == ',' || ch.is_whitespace())
            .filter(|token| !token.is_empty())
        {
            let normalized = normalize_tool_name(token);
            if normalized.starts_with("mcp__") {
                allowed.insert(token.trim().to_string());
                continue;
            }
            let canonical = name_map.get(&normalized).ok_or_else(|| {
                format!(
                    "unsupported tool in --allowedTools: {token} (expected one of: {})",
                    canonical_names.join(", ")
                )
            })?;
            allowed.insert(canonical.clone());
        }
    }

    Ok(Some(allowed))
}

fn normalize_tool_name(value: &str) -> String {
    value.trim().replace('-', "_").to_ascii_lowercase()
}

fn parse_permission_mode_arg(value: &str) -> Result<PermissionMode, String> {
    normalize_permission_mode(value)
        .ok_or_else(|| {
            format!(
                "unsupported permission mode '{value}'. Use read-only, workspace-write, or danger-full-access."
            )
        })
        .map(permission_mode_from_label)
}

fn permission_mode_from_label(mode: &str) -> PermissionMode {
    match mode {
        "read-only" => PermissionMode::ReadOnly,
        "workspace-write" => PermissionMode::WorkspaceWrite,
        "danger-full-access" => PermissionMode::DangerFullAccess,
        other => panic!("unsupported permission mode label: {other}"),
    }
}

fn default_permission_mode() -> PermissionMode {
    env::var("RUSTY_CLAUDE_PERMISSION_MODE")
        .ok()
        .as_deref()
        .and_then(normalize_permission_mode)
        .map_or(PermissionMode::DangerFullAccess, permission_mode_from_label)
}

pub(crate) fn filter_tool_specs(allowed_tools: Option<&AllowedToolSet>) -> Vec<tools::ToolSpec> {
    mvp_tool_specs()
        .into_iter()
        .filter(|spec| allowed_tools.is_none_or(|allowed| allowed.contains(spec.name)))
        .collect()
}

fn parse_system_prompt_args(args: &[String]) -> Result<CliAction, String> {
    let mut cwd = env::current_dir().map_err(|error| error.to_string())?;
    let mut date = runtime::today_iso();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--cwd" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --cwd".to_string())?;
                cwd = PathBuf::from(value);
                index += 2;
            }
            "--date" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "missing value for --date".to_string())?;
                date.clone_from(value);
                index += 2;
            }
            other => return Err(format!("unknown system-prompt option: {other}")),
        }
    }

    Ok(CliAction::PrintSystemPrompt { cwd, date })
}

fn parse_resume_args(
    args: &[String],
    model: String,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
) -> Result<CliAction, String> {
    let session_path = args
        .first()
        .ok_or_else(|| "missing session path for --resume".to_string())
        .map(PathBuf::from)?;
    let commands = args[1..].to_vec();
    if commands
        .iter()
        .any(|command| !command.trim_start().starts_with('/'))
    {
        return Err("--resume trailing arguments must be slash commands".to_string());
    }
    Ok(CliAction::ResumeSession {
        session_path,
        commands,
        model,
        allowed_tools,
        permission_mode,
    })
}

fn dump_manifests() {
    let workspace_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let paths = UpstreamPaths::from_workspace_dir(&workspace_dir);
    match extract_manifest(&paths) {
        Ok(manifest) => {
            println!("commands: {}", manifest.commands.entries().len());
            println!("tools: {}", manifest.tools.entries().len());
            println!("bootstrap phases: {}", manifest.bootstrap.phases().len());
        }
        Err(error) => {
            eprintln!("failed to extract manifests: {error}");
            std::process::exit(1);
        }
    }
}

fn print_bootstrap_plan() {
    for phase in runtime::BootstrapPlan::claude_code_default().phases() {
        println!("- {phase:?}");
    }
}

fn default_oauth_config() -> OAuthConfig {
    OAuthConfig {
        client_id: String::from("9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
        authorize_url: String::from("https://platform.claude.com/oauth/authorize"),
        token_url: String::from("https://platform.claude.com/v1/oauth/token"),
        callback_port: None,
        manual_redirect_url: None,
        scopes: vec![
            String::from("user:profile"),
            String::from("user:inference"),
            String::from("user:sessions:claude_code"),
        ],
    }
}

fn run_login() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    let config = ConfigLoader::default_for(&cwd).load()?;
    let default_oauth = default_oauth_config();
    let oauth = config.oauth().unwrap_or(&default_oauth);
    let callback_port = oauth.callback_port.unwrap_or(DEFAULT_OAUTH_CALLBACK_PORT);
    let redirect_uri = runtime::loopback_redirect_uri(callback_port);
    let pkce = generate_pkce_pair()?;
    let state = generate_state()?;
    let authorize_url =
        OAuthAuthorizationRequest::from_config(oauth, redirect_uri.clone(), state.clone(), &pkce)
            .build_url();

    println!("Starting Claude OAuth login...");
    println!("Listening for callback on {redirect_uri}");
    if let Err(error) = open_browser(&authorize_url) {
        eprintln!("warning: failed to open browser automatically: {error}");
        println!("Open this URL manually:\n{authorize_url}");
    }

    let callback = wait_for_oauth_callback(callback_port)?;
    if let Some(error) = callback.error {
        let description = callback
            .error_description
            .unwrap_or_else(|| "authorization failed".to_string());
        return Err(io::Error::other(format!("{error}: {description}")).into());
    }
    let code = callback.code.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "callback did not include code")
    })?;
    let returned_state = callback.state.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "callback did not include state")
    })?;
    if returned_state != state {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "oauth state mismatch").into());
    }

    let client = AnthropicClient::from_auth(AuthSource::None).with_base_url(api::read_base_url());
    let exchange_request =
        OAuthTokenExchangeRequest::from_config(oauth, code, state, pkce.verifier, redirect_uri);
    let runtime = tokio::runtime::Runtime::new()?;
    let token_set = runtime.block_on(client.exchange_oauth_code(oauth, &exchange_request))?;
    save_oauth_credentials(&runtime::OAuthTokenSet {
        access_token: token_set.access_token,
        refresh_token: token_set.refresh_token,
        expires_at: token_set.expires_at,
        scopes: token_set.scopes,
    })?;
    println!("Claude OAuth login complete.");
    Ok(())
}

fn run_logout() -> Result<(), Box<dyn std::error::Error>> {
    clear_oauth_credentials()?;
    println!("Claude OAuth credentials cleared.");
    Ok(())
}

fn open_browser(url: &str) -> io::Result<()> {
    let commands = if cfg!(target_os = "macos") {
        vec![("open", vec![url])]
    } else if cfg!(target_os = "windows") {
        vec![("cmd", vec!["/C", "start", "", url])]
    } else {
        vec![("xdg-open", vec![url])]
    };
    for (program, args) in commands {
        match Command::new(program).args(args).spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "no supported browser opener command found",
    ))
}

fn wait_for_oauth_callback(
    port: u16,
) -> Result<runtime::OAuthCallbackParams, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let (mut stream, _) = listener.accept()?;
    let mut buffer = [0_u8; 4096];
    let bytes_read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_line = request.lines().next().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing callback request line")
    })?;
    let target = request_line.split_whitespace().nth(1).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "missing callback request target",
        )
    })?;
    let callback = parse_oauth_callback_request_target(target)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let body = if callback.error.is_some() {
        "Claude OAuth login failed. You can close this window."
    } else {
        "Claude OAuth login succeeded. You can close this window."
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())?;
    Ok(callback)
}

fn print_system_prompt(cwd: PathBuf, date: String) {
    match load_system_prompt(cwd, date, env::consts::OS, "unknown", None) {
        Ok(sections) => println!("{}", sections.join("\n\n")),
        Err(error) => {
            eprintln!("failed to build system prompt: {error}");
            std::process::exit(1);
        }
    }
}

fn print_version() {
    println!("{}", render_version_report());
}

fn resume_session(
    session_path: &Path,
    commands: &[String],
    model: String,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
) -> Result<(), Box<dyn std::error::Error>> {
    let session = match Session::load_from_path(session_path) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("failed to restore session: {error}");
            std::process::exit(1);
        }
    };

    if commands.is_empty() {
        println!(
            "Restored session from {} ({} messages).",
            session_path.display(),
            session.messages.len()
        );
        return Ok(());
    }

    let mut session = session;
    let mut runtime: Option<ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>> =
        None;
    for raw_command in commands {
        let Some(command) = SlashCommand::parse(raw_command) else {
            eprintln!("unsupported resumed command: {raw_command}");
            std::process::exit(2);
        };
        match run_resume_command(
            session_path,
            &session,
            &command,
            &model,
            allowed_tools.clone(),
            permission_mode,
            &mut runtime,
        ) {
            Ok(ResumeCommandOutcome {
                session: next_session,
                message,
            }) => {
                session = next_session;
                if let Some(message) = message {
                    println!("{message}");
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ResumeCommandOutcome {
    session: Session,
    message: Option<String>,
}

fn format_model_report(model: &str, message_count: usize, turns: u32) -> String {
    format!(
        "Model
  Current model    {model}
  Session messages {message_count}
  Session turns    {turns}

Usage
  Inspect current model with /model
  Switch models with /model <name>"
    )
}

fn format_model_switch_report(previous: &str, next: &str, message_count: usize) -> String {
    format!(
        "Model updated
  Previous         {previous}
  Current          {next}
  Preserved msgs   {message_count}"
    )
}

fn format_permissions_report(mode: &str) -> String {
    let modes = [
        ("read-only", "Read/search tools only", mode == "read-only"),
        (
            "workspace-write",
            "Edit files inside the workspace",
            mode == "workspace-write",
        ),
        (
            "danger-full-access",
            "Unrestricted tool access",
            mode == "danger-full-access",
        ),
    ]
    .into_iter()
    .map(|(name, description, is_current)| {
        let marker = if is_current {
            "● current"
        } else {
            "○ available"
        };
        format!("  {name:<18} {marker:<11} {description}")
    })
    .collect::<Vec<_>>()
    .join(
        "
",
    );

    format!(
        "Permissions
  Active mode      {mode}
  Mode status      live session default

Modes
{modes}

Usage
  Inspect current mode with /permissions
  Switch modes with /permissions <mode>"
    )
}

fn format_permissions_switch_report(previous: &str, next: &str) -> String {
    format!(
        "Permissions updated
  Result           mode switched
  Previous mode    {previous}
  Active mode      {next}
  Applies to       subsequent tool calls
  Usage            /permissions to inspect current mode"
    )
}

fn format_resume_report(session_path: &str, message_count: usize, turns: u32) -> String {
    format!(
        "Session resumed
  Session file     {session_path}
  Messages         {message_count}
  Turns            {turns}"
    )
}

fn format_auto_compaction_notice(removed: usize) -> String {
    format!("[auto-compacted: removed {removed} messages]")
}

fn parse_git_status_metadata(status: Option<&str>) -> (Option<PathBuf>, Option<String>) {
    let Some(status) = status else {
        return (None, None);
    };
    let branch = status.lines().next().and_then(|line| {
        line.strip_prefix("## ")
            .map(|line| {
                line.split(['.', ' '])
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
            .filter(|value| !value.is_empty())
    });
    let project_root = find_git_root().ok();
    (project_root, branch)
}

fn find_git_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(env::current_dir()?)
        .output()?;
    if !output.status.success() {
        return Err("not a git repository".into());
    }
    let path = String::from_utf8(output.stdout)?.trim().to_string();
    if path.is_empty() {
        return Err("empty git root".into());
    }
    Ok(PathBuf::from(path))
}

#[allow(clippy::too_many_lines)]
fn run_resume_command(
    session_path: &Path,
    session: &Session,
    command: &SlashCommand,
    model: &str,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
    runtime: &mut Option<ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>>,
) -> Result<ResumeCommandOutcome, Box<dyn std::error::Error>> {
    match command {
        SlashCommand::Help => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(render_repl_help()),
        }),
        SlashCommand::Compact { instruction } => {
            let runtime = resumed_runtime(runtime, session, model, allowed_tools, permission_mode)?;
            let result = runtime.compact(CompactionConfig::manual(instruction.clone()));
            save_session_artifacts(
                &session_id_from_path(session_path),
                session_path,
                &result.compacted_session,
            )?;
            let message = format_compact_report(&result);
            Ok(ResumeCommandOutcome {
                session: result.compacted_session,
                message: Some(message),
            })
        }
        SlashCommand::Clear { confirm } => {
            if !confirm {
                return Ok(ResumeCommandOutcome {
                    session: session.clone(),
                    message: Some(
                        "clear: confirmation required; rerun with /clear --confirm".to_string(),
                    ),
                });
            }
            let cleared = Session::new();
            save_session_artifacts(&session_id_from_path(session_path), session_path, &cleared)?;
            Ok(ResumeCommandOutcome {
                session: cleared,
                message: Some(format!(
                    "Cleared resumed session file {}.",
                    session_path.display()
                )),
            })
        }
        SlashCommand::Status => {
            let tracker = UsageTracker::from_session(session);
            let usage = tracker.cumulative_usage();
            Ok(ResumeCommandOutcome {
                session: session.clone(),
                message: Some(format_status_report(
                    "restored-session",
                    StatusUsage {
                        message_count: session.messages.len(),
                        turns: tracker.turns(),
                        latest: tracker.current_turn_usage(),
                        cumulative: usage,
                        estimated_tokens: 0,
                    },
                    default_permission_mode().as_str(),
                    &status_context(Some(session_path))?,
                    "live-repl",
                )),
            })
        }
        SlashCommand::Cost => {
            let usage = UsageTracker::from_session(session).cumulative_usage();
            Ok(ResumeCommandOutcome {
                session: session.clone(),
                message: Some(format_cost_report(usage)),
            })
        }
        SlashCommand::Config { section } => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(render_config_report(section.as_deref())?),
        }),
        SlashCommand::Memory { .. } => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(render_memory_report()?),
        }),
        SlashCommand::Goal { action, objective } => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(handle_goal_command(
                action.as_deref(),
                objective.as_deref(),
            )?),
        }),
        SlashCommand::Init => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(init_agents_md()?),
        }),
        SlashCommand::Diff => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(render_diff_report()?),
        }),
        SlashCommand::Version => Ok(ResumeCommandOutcome {
            session: session.clone(),
            message: Some(render_version_report()),
        }),
        SlashCommand::Export { path } => {
            let export_path = resolve_export_path(path.as_deref(), session)?;
            fs::write(&export_path, render_export_text(session))?;
            Ok(ResumeCommandOutcome {
                session: session.clone(),
                message: Some(format!(
                    "Export\n  Result           wrote transcript\n  File             {}\n  Messages         {}",
                    export_path.display(),
                    session.messages.len(),
                )),
            })
        }
        SlashCommand::Bughunter { .. }
        | SlashCommand::Commit
        | SlashCommand::Pr { .. }
        | SlashCommand::Issue { .. }
        | SlashCommand::Ultraplan { .. }
        | SlashCommand::Teleport { .. }
        | SlashCommand::DebugToolCall
        | SlashCommand::ExportDebugZip { .. }
        | SlashCommand::Resume { .. }
        | SlashCommand::Model { .. }
        | SlashCommand::Reviewer { .. }
        | SlashCommand::Setup
        | SlashCommand::Plan { .. }
        | SlashCommand::Tasks { .. }
        | SlashCommand::Skills { .. }
        | SlashCommand::Permissions { .. }
        | SlashCommand::Session { .. }
        | SlashCommand::MetaOptimize { .. }
        | SlashCommand::Unknown { .. } => Err("unsupported resumed slash command".into()),
    }
}

fn resumed_runtime<'a>(
    runtime: &'a mut Option<ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>>,
    session: &Session,
    model: &str,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
) -> Result<
    &'a mut ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>,
    Box<dyn std::error::Error>,
> {
    let needs_rebuild = runtime
        .as_ref()
        .is_none_or(|runtime| runtime.session() != session);
    if needs_rebuild {
        let system_prompt = build_system_prompt(Some(model))?;
        *runtime = Some(build_runtime(
            session.clone(),
            model.to_string(),
            system_prompt,
            true,
            false,
            allowed_tools,
            permission_mode,
        )?);
    }
    runtime
        .as_mut()
        .ok_or_else(|| "failed to initialize resumed runtime".into())
}

fn sessions_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cwd = runtime::workspace_root_from_env();
    runtime::migrate_legacy_project_runtime_dirs(&cwd)?;
    let path = runtime::project_sessions_dir_from_env();
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn save_session_artifacts(
    session_id: &str,
    session_path: &Path,
    session: &Session,
) -> Result<(), Box<dyn std::error::Error>> {
    session.save_to_path(session_path)?;
    timeline::save_timeline_for_session(session_id, session, session_path)?;
    Ok(())
}

#[derive(Debug, Clone)]
struct SessionHandle {
    id: String,
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct ManagedSessionSummary {
    id: String,
    path: PathBuf,
    modified_epoch_secs: u64,
    message_count: usize,
}

fn create_managed_session_handle() -> Result<SessionHandle, Box<dyn std::error::Error>> {
    let id = generate_session_id();
    let path = sessions_dir()?.join(format!("{id}.json"));
    Ok(SessionHandle { id, path })
}

fn generate_session_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("session-{millis}")
}

fn resolve_session_reference(reference: &str) -> Result<SessionHandle, Box<dyn std::error::Error>> {
    let direct = PathBuf::from(reference);
    let path = if direct.exists() {
        direct
    } else {
        sessions_dir()?.join(format!("{reference}.json"))
    };
    if !path.exists() {
        return Err(format!("session not found: {reference}").into());
    }
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(reference)
        .to_string();
    Ok(SessionHandle { id, path })
}

fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session")
        .trim_end_matches(".timeline")
        .to_string()
}

fn is_timeline_artifact_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.ends_with(".timeline.json"))
}

fn list_managed_sessions() -> Result<Vec<ManagedSessionSummary>, Box<dyn std::error::Error>> {
    let mut sessions = Vec::new();
    for entry in fs::read_dir(sessions_dir()?)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json")
            || is_timeline_artifact_path(&path)
        {
            continue;
        }
        let metadata = entry.metadata()?;
        let modified_epoch_secs = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let message_count = Session::load_from_path(&path)
            .map(|session| session.messages.len())
            .unwrap_or_default();
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string();
        sessions.push(ManagedSessionSummary {
            id,
            path,
            modified_epoch_secs,
            message_count,
        });
    }
    sessions.sort_by(|left, right| right.modified_epoch_secs.cmp(&left.modified_epoch_secs));
    Ok(sessions)
}

fn render_session_list(active_session_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    let sessions = list_managed_sessions()?;
    let mut lines = vec![
        "Sessions".to_string(),
        format!("  Directory         {}", sessions_dir()?.display()),
    ];
    if sessions.is_empty() {
        lines.push("  No managed sessions saved yet.".to_string());
        return Ok(lines.join("\n"));
    }
    for session in sessions {
        let marker = if session.id == active_session_id {
            "● current"
        } else {
            "○ saved"
        };
        lines.push(format!(
            "  {id:<20} {marker:<10} msgs={msgs:<4} modified={modified} path={path}",
            id = session.id,
            msgs = session.message_count,
            modified = session.modified_epoch_secs,
            path = session.path.display(),
        ));
    }
    Ok(lines.join("\n"))
}

fn render_repl_help() -> String {
    [
        "REPL".to_string(),
        "  /exit                Quit the REPL".to_string(),
        "  /quit                Quit the REPL".to_string(),
        "  Up/Down              Navigate prompt history".to_string(),
        "  Tab                  Complete slash commands".to_string(),
        "  Ctrl-C               Clear input (or exit on empty prompt)".to_string(),
        "  Shift+Enter/Ctrl+J   Insert a newline".to_string(),
        String::new(),
        render_slash_command_help(),
    ]
    .join(
        "
",
    )
}

fn status_context(
    session_path: Option<&Path>,
) -> Result<StatusContext, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    let loader = ConfigLoader::default_for(&cwd);
    let discovered_config_files = loader.discover().len();
    let runtime_config = loader.load()?;
    let project_context = ProjectContext::discover_with_git(&cwd, &runtime::today_iso())?;
    let hot_memory_count = runtime::load_hot_memory(&cwd)
        .map(|memory| memory.memory.len() + memory.user.len())
        .unwrap_or_default();
    let knowledge_memory_count = runtime::load_knowledge_memory_catalog().len();
    let (project_root, git_branch) =
        parse_git_status_metadata(project_context.git_status.as_deref());
    Ok(StatusContext {
        cwd,
        session_path: session_path.map(Path::to_path_buf),
        loaded_config_files: runtime_config.loaded_entries().len(),
        discovered_config_files,
        memory_file_count: hot_memory_count + knowledge_memory_count,
        project_root,
        git_branch,
    })
}

fn render_config_report(section: Option<&str>) -> Result<String, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    runtime::render_config_report(&cwd, section)
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}

fn render_memory_report() -> Result<String, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    runtime::render_memory_report(&cwd)
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}

fn handle_goal_command(
    action: Option<&str>,
    objective: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let workspace = env::current_dir()?;
    let draft = |value: &str| runtime::ProjectGoalDraft {
        objective: value.to_string(),
        success_criteria: Vec::new(),
        recent_status: "Goal captured from /goal; work has not been verified complete yet."
            .to_string(),
    };
    let goal = match action {
        None | Some("status") | Some("show") => runtime::load_project_goal(&workspace)?,
        Some("start") => Some(runtime::start_project_goal(
            &workspace,
            draft(objective.ok_or("Usage: /goal start <objective>")?),
            None,
        )?),
        Some("replace") => Some(runtime::replace_project_goal(
            &workspace,
            draft(objective.ok_or("Usage: /goal replace <objective>")?),
            None,
        )?),
        Some("pause") => Some(runtime::pause_project_goal(&workspace)?),
        Some("resume") => Some(runtime::resume_project_goal(&workspace)?),
        Some("complete") => Some(runtime::complete_project_goal(&workspace, objective)?),
        Some(other) => {
            return Err(format!(
                "Unknown /goal action `{other}`. Use start, status, pause, resume, replace, or complete."
            )
            .into());
        }
    };
    Ok(runtime::render_project_goal_report(goal.as_ref()))
}

fn init_agents_md() -> Result<String, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    Ok(initialize_repo(&cwd)?.render())
}

fn run_init() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", init_agents_md()?);
    Ok(())
}

/// Deploy bundled meta_opt hook scripts to `~/.claude/hooks/` and merge their
/// hook config into `~/.claude/settings.json`.
///
/// Resolves HOME via `runtime::home_dir()` and the cache directory via
/// `runtime::extraction_report()` (set by `runtime::extract_bundle()` at
/// startup), then delegates to [`deploy_meta_opt_hooks_to`] for the actual
/// file ops so tests can drive it with a tmp HOME.
/// v0.4.13 meta_opt hook scripts that get deployed from the cache to
/// `~/.claude/hooks/`. Tuple order: (cache-relative path, destination basename).
///
/// **Codex round-1 finding #1**: destination names are ARIS-namespaced
/// (`aris-meta-opt-*.sh`) so `aris init` never silently clobbers a user's
/// own `log_event.sh` / `check_ready.sh` in `~/.claude/hooks/`. ARIS-owned
/// files are visibly ours, impossible to collide with a hand-rolled hook,
/// and safe to overwrite on every `aris init` since only we put them there.
#[cfg(test)]
const META_OPT_HOOK_SCRIPTS: &[(&str, &str)] = &[
    ("tools/meta_opt/log_event.sh", "aris-meta-opt-log-event.sh"),
    (
        "tools/meta_opt/check_ready.sh",
        "aris-meta-opt-check-ready.sh",
    ),
];

/// Pure-fn variant of [`deploy_meta_opt_hooks`] that takes explicit `home` +
/// `cache_dir` paths so unit tests can isolate them from the real environment.
///
/// Behaviour:
/// 1. Create `<home>/.claude/hooks/` if missing.
/// 2. Copy `<cache_dir>/tools/meta_opt/{log_event,check_ready}.sh` to
///    `<home>/.claude/hooks/`, chmod +x on Unix.
/// 3. Read `<home>/.claude/settings.json` (or start with `{}`) and merge in
///    PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart /
///    SessionEnd hook entries that reference the deployed scripts. Idempotent:
///    a second run does not duplicate entries pointing at the same script.
/// 4. Backup the existing settings.json to
///    `<home>/.claude/settings.json.bak.<unix-millis>` before overwriting (only
///    when there was a previous file).
#[cfg(test)]
fn deploy_meta_opt_hooks_to(
    home: &Path,
    cache_dir: &Path,
) -> Result<String, Box<dyn std::error::Error>> {
    let claude_dir = home.join(".claude");
    let hooks_dir = claude_dir.join("hooks");
    fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("create_dir_all({}): {e}", hooks_dir.display()))?;

    // ---- Step 1: copy bundled scripts from cache → ~/.claude/hooks/ ----
    let mut deployed: Vec<PathBuf> = Vec::new();
    for (rel, dest_name) in META_OPT_HOOK_SCRIPTS {
        let src = cache_dir.join(rel);
        if !src.is_file() {
            return Err(format!(
                "bundled hook script missing from cache: {} (cache_dir={})",
                rel,
                cache_dir.display()
            )
            .into());
        }
        let dest = hooks_dir.join(dest_name);
        fs::copy(&src, &dest)
            .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&dest)
                .map_err(|e| format!("stat {}: {e}", dest.display()))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&dest, perms)
                .map_err(|e| format!("chmod 0755 {}: {e}", dest.display()))?;
        }
        deployed.push(dest);
    }

    // ---- Step 2: merge entries into ~/.claude/settings.json ----
    let settings_path = claude_dir.join("settings.json");
    let (mut settings, had_existing) = match fs::read_to_string(&settings_path) {
        Ok(text) => {
            // Empty file → start with {} (avoid serde error on empty input).
            let trimmed = text.trim();
            if trimmed.is_empty() {
                (serde_json::json!({}), true)
            } else {
                let parsed: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| {
                    format!(
                        "parse {}: {e} (refusing to clobber malformed user settings)",
                        settings_path.display()
                    )
                })?;
                if !parsed.is_object() {
                    return Err(format!(
                        "{} is not a JSON object (top-level must be {{...}})",
                        settings_path.display()
                    )
                    .into());
                }
                (parsed, true)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (serde_json::json!({}), false),
        Err(e) => return Err(format!("read {}: {e}", settings_path.display()).into()),
    };

    // v0.4.13 codex round-1 #1: paths must match the ARIS-namespaced
    // destinations declared in META_OPT_HOOK_SCRIPTS so settings.json
    // hook command strings actually point at the deployed scripts.
    let log_event_path = hooks_dir.join("aris-meta-opt-log-event.sh");
    let check_ready_path = hooks_dir.join("aris-meta-opt-check-ready.sh");

    // Hook entry layout follows main's templates/claude-hooks/meta_logging.json
    // verbatim, but with the bundled hook script paths (not $CLAUDE_PROJECT_DIR
    // references). One hook entry per event name; "matcher": "" matches all
    // tool calls / events for PostToolUse* variants. SessionEnd carries two
    // sub-hooks: log_event AND check_ready.
    let events_for_log_event = [
        "PostToolUse",
        "PostToolUseFailure",
        "UserPromptSubmit",
        "SessionStart",
        "SessionEnd",
    ];

    let mut added_log_event = 0usize;
    let mut added_check_ready = 0usize;

    for event in events_for_log_event {
        if ensure_hook_entry(
            &mut settings,
            event,
            &log_event_path,
            /*async_run=*/ true,
        )? {
            added_log_event += 1;
        }
    }
    if ensure_hook_entry(
        &mut settings,
        "SessionEnd",
        &check_ready_path,
        /*async_run=*/ false,
    )? {
        added_check_ready += 1;
    }

    // ---- Step 3: backup existing file (hard-fail if backup fails), then
    // atomically rewrite via tempfile + rename (codex round-1 #2). ----
    if had_existing {
        let backup_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let backup_path = claude_dir.join(format!("settings.json.bak.{backup_suffix}"));
        // Hard-fail on backup error so user never loses their settings.
        // If the FS is read-only or we can't write, abort rather than
        // silently destroying state.
        fs::copy(&settings_path, &backup_path).map_err(|e| {
            format!(
                "backup {} → {} failed: {e}; aborting to protect existing settings",
                settings_path.display(),
                backup_path.display()
            )
        })?;
    }

    let pretty = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize settings.json: {e}"))?;
    let body = format!("{pretty}\n");

    // Atomic rewrite: write to a tempfile in the same directory, then
    // rename. This is the only way to guarantee that a crash or signal
    // can't leave settings.json half-written.
    let temp_path = claude_dir.join(format!(
        "settings.json.tmp.{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&temp_path, body)
        .map_err(|e| format!("write tempfile {}: {e}", temp_path.display()))?;
    fs::rename(&temp_path, &settings_path).map_err(|e| {
        // Best-effort cleanup; the user can manually rm the .tmp.* file
        let _ = fs::remove_file(&temp_path);
        format!(
            "atomic rename {} → {}: {e}",
            temp_path.display(),
            settings_path.display()
        )
    })?;

    // ---- Step 4: human-readable report ----
    let mut lines = Vec::new();
    lines.push(format!(
        "Meta-Optimize hooks deployed to {}",
        hooks_dir.display()
    ));
    for p in &deployed {
        if let Some(name) = p.file_name() {
            lines.push(format!("  installed       {}", name.to_string_lossy()));
        }
    }
    lines.push(format!(
        "Merged into     {} (log_event added: {added_log_event}, check_ready added: {added_check_ready})",
        settings_path.display()
    ));
    Ok(lines.join("\n"))
}

/// Look up `hooks.<event>` in `settings`, ensure there is a matcher entry whose
/// sub-hooks include `command = "bash <script_path>"`. If an entry referencing
/// the same script already exists (anywhere under `hooks.<event>[*].hooks[*]`),
/// returns `false` (no-op). Otherwise inserts a new matcher entry and returns
/// `true`.
#[cfg(test)]
fn ensure_hook_entry(
    settings: &mut serde_json::Value,
    event: &str,
    script_path: &Path,
    async_run: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    use serde_json::{json, Value};

    let script_str = script_path.to_string_lossy().to_string();
    let command = format!("bash {script_str}");

    let obj = settings
        .as_object_mut()
        .ok_or_else(|| "settings is not a JSON object".to_string())?;
    let hooks_entry = obj
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let hooks_obj = hooks_entry
        .as_object_mut()
        .ok_or_else(|| "settings.hooks is not a JSON object".to_string())?;
    let event_entry = hooks_obj
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let event_arr = event_entry
        .as_array_mut()
        .ok_or_else(|| format!("settings.hooks.{event} is not a JSON array"))?;

    // Idempotency check: scan all existing matcher entries for a sub-hook with
    // the exact same command. If found, do nothing.
    for matcher_entry in event_arr.iter() {
        let Some(matcher_obj) = matcher_entry.as_object() else {
            continue;
        };
        let Some(inner_hooks) = matcher_obj.get("hooks").and_then(|v| v.as_array()) else {
            continue;
        };
        for hook in inner_hooks {
            if let Some(cmd) = hook.get("command").and_then(|v| v.as_str()) {
                if cmd == command {
                    return Ok(false);
                }
            }
        }
    }

    let new_entry = if async_run {
        json!({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 5,
                    "async": true,
                }
            ],
        })
    } else {
        json!({
            "matcher": "",
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 5,
                }
            ],
        })
    };
    event_arr.push(new_entry);
    Ok(true)
}

fn normalize_permission_mode(mode: &str) -> Option<&'static str> {
    match mode.trim() {
        "read-only" => Some("read-only"),
        "workspace-write" => Some("workspace-write"),
        "danger-full-access" => Some("danger-full-access"),
        _ => None,
    }
}

fn render_diff_report() -> Result<String, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("git")
        .args(["diff", "--", ":(exclude).omx"])
        .current_dir(env::current_dir()?)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git diff failed: {stderr}").into());
    }
    let diff = String::from_utf8(output.stdout)?;
    if diff.trim().is_empty() {
        return Ok(
            "Diff\n  Result           clean working tree\n  Detail           no current changes"
                .to_string(),
        );
    }
    Ok(format!("Diff\n\n{}", diff.trim_end()))
}

fn render_teleport_report(target: &str) -> Result<String, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;

    let file_list = Command::new("rg")
        .args(["--files"])
        .current_dir(&cwd)
        .output()?;
    let file_matches = if file_list.status.success() {
        String::from_utf8(file_list.stdout)?
            .lines()
            .filter(|line| line.contains(target))
            .take(10)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let content_output = Command::new("rg")
        .args(["-n", "-S", "--color", "never", target, "."])
        .current_dir(&cwd)
        .output()?;

    let mut lines = vec![format!("Teleport\n  Target           {target}")];
    if !file_matches.is_empty() {
        lines.push(String::new());
        lines.push("File matches".to_string());
        lines.extend(file_matches.into_iter().map(|path| format!("  {path}")));
    }

    if content_output.status.success() {
        let matches = String::from_utf8(content_output.stdout)?;
        if !matches.trim().is_empty() {
            lines.push(String::new());
            lines.push("Content matches".to_string());
            lines.push(truncate_for_prompt(&matches, 4_000));
        }
    }

    if lines.len() == 1 {
        lines.push("  Result           no matches found".to_string());
    }

    Ok(lines.join("\n"))
}

fn render_last_tool_debug_report(session: &Session) -> Result<String, Box<dyn std::error::Error>> {
    let last_tool_use = session
        .messages
        .iter()
        .rev()
        .find_map(|message| {
            message.blocks.iter().rev().find_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
        })
        .ok_or_else(|| "no prior tool call found in session".to_string())?;

    let tool_result = session.messages.iter().rev().find_map(|message| {
        message.blocks.iter().rev().find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } if tool_use_id == &last_tool_use.0 => {
                Some((tool_name.clone(), output.clone(), *is_error))
            }
            _ => None,
        })
    });

    let mut lines = vec![
        "Debug tool call".to_string(),
        format!("  Tool id          {}", last_tool_use.0),
        format!("  Tool name        {}", last_tool_use.1),
        "  Input".to_string(),
        indent_block(&last_tool_use.2, 4),
    ];

    match tool_result {
        Some((tool_name, output, is_error)) => {
            lines.push("  Result".to_string());
            lines.push(format!("    name           {tool_name}"));
            lines.push(format!(
                "    status         {}",
                if is_error { "error" } else { "ok" }
            ));
            lines.push(indent_block(&output, 4));
        }
        None => lines.push("  Result           missing tool result".to_string()),
    }

    Ok(lines.join("\n"))
}

fn indent_block(value: &str, spaces: usize) -> String {
    let indent = " ".repeat(spaces);
    value
        .lines()
        .map(|line| format!("{indent}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn git_output(args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env::current_dir()?)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn git_status_ok(args: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env::current_dir()?)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")).into());
    }
    Ok(())
}

fn write_temp_text_file(
    filename: &str,
    contents: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = env::temp_dir().join(filename);
    fs::write(&path, contents)?;
    Ok(path)
}

fn recent_user_context(session: &Session, limit: usize) -> String {
    let requests = session
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .filter_map(|message| {
            message.blocks.iter().find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.trim().to_string()),
                _ => None,
            })
        })
        .rev()
        .take(limit)
        .collect::<Vec<_>>();

    if requests.is_empty() {
        "<no prior user messages>".to_string()
    } else {
        requests
            .into_iter()
            .rev()
            .enumerate()
            .map(|(index, text)| format!("{}. {}", index + 1, text))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn truncate_for_prompt(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.trim().to_string()
    } else {
        let truncated = value.chars().take(limit).collect::<String>();
        format!("{}\n…[truncated]", truncated.trim_end())
    }
}

fn sanitize_generated_message(value: &str) -> String {
    value.trim().trim_matches('`').trim().replace("\r\n", "\n")
}

fn parse_titled_body(value: &str) -> Option<(String, String)> {
    let normalized = sanitize_generated_message(value);
    let title = normalized
        .lines()
        .find_map(|line| line.strip_prefix("TITLE:").map(str::trim))?;
    let body_start = normalized.find("BODY:")?;
    let body = normalized[body_start + "BODY:".len()..].trim();
    Some((title.to_string(), body.to_string()))
}

fn render_version_report() -> String {
    let git_sha = GIT_SHA.unwrap_or("unknown");
    let target = BUILD_TARGET.unwrap_or("unknown");
    format!(
        "ARIS (Auto Research in Sleep)\n  Version          {VERSION}\n  Git SHA          {git_sha}\n  Target           {target}\n  Build date       {BUILD_DATE}"
    )
}

fn render_export_text(session: &Session) -> String {
    let mut lines = vec!["# Conversation Export".to_string(), String::new()];
    for (index, message) in session.messages.iter().enumerate() {
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        lines.push(format!("## {}. {role}", index + 1));
        for block in &message.blocks {
            match block {
                ContentBlock::Text { text } => lines.push(text.clone()),
                ContentBlock::Image { media_type, data } => {
                    lines.push(format!(
                        "[image media_type={media_type} bytes={}]",
                        data.len()
                    ));
                }
                ContentBlock::ToolUse { id, name, input } => {
                    lines.push(format!("[tool_use id={id} name={name}] {input}"));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => {
                    lines.push(format!(
                        "[tool_result id={tool_use_id} name={tool_name} error={is_error}] {output}"
                    ));
                }
                ContentBlock::Thinking { thinking, .. } => {
                    lines.push(format!("[thinking] {thinking}"));
                }
            }
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

fn default_export_filename(session: &Session) -> String {
    let stem = session
        .messages
        .iter()
        .find_map(|message| match message.role {
            MessageRole::User => message.blocks.iter().find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { .. } => None,
                _ => None,
            }),
            _ => None,
        })
        .map_or("conversation", |text| {
            text.lines().next().unwrap_or("conversation")
        })
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-");
    let fallback = if stem.is_empty() {
        "conversation"
    } else {
        &stem
    };
    format!("{fallback}.txt")
}

fn resolve_export_path(
    requested_path: Option<&str>,
    session: &Session,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    let file_name =
        requested_path.map_or_else(|| default_export_filename(session), ToOwned::to_owned);
    let final_name = if Path::new(&file_name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
    {
        file_name
    } else {
        format!("{file_name}.txt")
    };
    Ok(cwd.join(final_name))
}

fn build_system_prompt(model_id: Option<&str>) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let workspace = env::current_dir()?;
    let options = aris_chat::CommonSystemPromptOptions {
        workspace: workspace.clone(),
        current_date: runtime::today_iso(),
        os_name: env::consts::OS.to_string(),
        os_version: "unknown".to_string(),
        model_id: model_id.map(ToOwned::to_owned),
        product_surface: "research automation CLI".to_string(),
        language: std::env::var("ARIS_LANGUAGE").unwrap_or_else(|_| "cn".to_string()),
        include_language_preference: false,
        extra_sections: Vec::new(),
    };
    let mut prompt = match aris_chat::build_common_system_prompt(options) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "\x1b[33mwarning\x1b[0m: could not load system prompt: {e}\n\
                 \x1b[2mUsing minimal prompt. This may be caused by incompatible Claude Code settings.\x1b[0m"
            );
            Vec::new()
        }
    };

    // ARIS language preference
    let lang = std::env::var("ARIS_LANGUAGE").unwrap_or_else(|_| "cn".into());
    if lang == "cn" {
        prompt.push("用户偏好语言为中文。请始终用中文回复，除非用户明确使用英文提问。".to_string());
    } else {
        prompt.push("User language preference is English. Always respond in English unless the user explicitly writes in another language.".to_string());
    }

    runtime::migrate_legacy_knowledge_memory();
    prompt.push(runtime::render_hot_memory_prompt(&workspace)?);
    prompt.push(runtime::render_knowledge_memory_prompt());
    prompt.push(runtime::render_project_goal_prompt(&workspace));

    // ARIS persistent tasks (uses TodoWrite tool, stored as JSON)
    let tasks_path = aris_tasks_path();
    if tasks_path.exists() {
        if let Ok(content) = fs::read_to_string(&tasks_path) {
            if let Ok(todos) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                if !todos.is_empty() {
                    let summary: Vec<String> = todos
                        .iter()
                        .map(|t| {
                            let status = t
                                .get("status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("pending");
                            let text = t.get("content").and_then(|c| c.as_str()).unwrap_or("?");
                            format!("- [{status}] {text}")
                        })
                        .collect();
                    prompt.push(format!(
                        "# ARIS Task List\n\
                         Current tasks:\n{}\n\n\
                         Use the TodoWrite tool to update tasks (status: pending/in_progress/completed).",
                        summary.join("\n"),
                    ));
                }
            }
        }
    } else {
        prompt.push(
            "# ARIS Task List\n\
             Use the TodoWrite tool to create and manage tasks. \
             Each task has: content (description), status (pending/in_progress/completed)."
                .to_string(),
        );
    }

    Ok(prompt)
}

fn aris_tasks_path() -> PathBuf {
    let home = runtime::home_dir();
    PathBuf::from(home)
        .join(".config")
        .join("aris")
        .join("tasks.json")
}

/// Ensure TodoWrite uses ARIS tasks path.
fn init_aris_tasks_env() {
    if env::var("CLAWD_TODO_STORE").is_err() {
        env::set_var(
            "CLAWD_TODO_STORE",
            aris_tasks_path().to_string_lossy().as_ref(),
        );
    }
}

fn set_coordination_context_env(
    session_id: &str,
    allowed_tools: Option<&AllowedToolSet>,
    permission_mode: PermissionMode,
) {
    env::set_var("ARIS_SESSION_ID", session_id);
    env::set_var("ARIS_PERMISSION_MODE", permission_mode.as_str());
    let tools = allowed_tools
        .map(|tools| tools.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_else(|| {
            mvp_tool_specs()
                .into_iter()
                .map(|spec| spec.name.to_string())
                .collect()
        });
    env::set_var("ARIS_ALLOWED_TOOLS", tools.join(","));
}

fn build_runtime_feature_config(
) -> Result<runtime::RuntimeFeatureConfig, Box<dyn std::error::Error>> {
    let cwd = env::current_dir()?;
    match ConfigLoader::default_for(cwd).load() {
        Ok(config) => Ok(config.feature_config().clone()),
        Err(e) => {
            // Gracefully handle incompatible Claude Code settings (e.g. hooks format)
            eprintln!(
                "\x1b[33mwarning\x1b[0m: could not load settings: {e}\n\
                 \x1b[2mUsing default configuration. This may be caused by incompatible Claude Code settings.\x1b[0m"
            );
            Ok(runtime::RuntimeFeatureConfig::default())
        }
    }
}

fn build_runtime(
    session: Session,
    model: String,
    system_prompt: Vec<String>,
    enable_tools: bool,
    emit_output: bool,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
) -> Result<
    ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>,
    Box<dyn std::error::Error>,
> {
    let observer = cli_stream_observer(emit_output);
    let feature_config = build_runtime_feature_config()?;
    let tool_specs = aris_chat::chat_tool_specs(filter_tool_specs(allowed_tools.as_ref()));
    let mcp_bundle = aris_chat::attach_mcp_tools(
        BuiltinCliToolExecutor::new(allowed_tools.clone()),
        tool_specs,
        &feature_config,
        allowed_tools.as_ref(),
    );
    for warning in &mcp_bundle.warnings {
        eprintln!("\x1b[33mwarning\x1b[0m: {warning}");
    }
    let permission_policy =
        aris_chat::permission_policy_for_tools(mcp_bundle.tool_specs.clone(), permission_mode);
    let event_sink = build_event_sink(&feature_config);
    let executor_config = aris_chat::resolve_env_executor_config(|| {
        resolve_cli_auth_source().map_err(|error| error.to_string())
    })
    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
    let runtime = aris_chat::build_conversation_runtime(
        session,
        executor_config,
        model,
        enable_tools,
        mcp_bundle.tool_specs,
        observer,
        CliToolExecutor::new(mcp_bundle.executor, emit_output),
        permission_policy,
        system_prompt,
        feature_config,
        None,
        None,
    )
    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
    Ok(runtime.with_event_sink(event_sink))
}

fn cli_stream_observer(emit_output: bool) -> Box<dyn aris_executor::StreamObserver> {
    Box::new(CliStreamObserver {
        renderer: TerminalRenderer::new(),
        markdown_stream: MarkdownStreamState::default(),
        emit_output,
    })
}

struct CliStreamObserver {
    renderer: TerminalRenderer,
    markdown_stream: MarkdownStreamState,
    emit_output: bool,
}

impl CliStreamObserver {
    fn flush_markdown(&mut self) -> Result<(), RuntimeError> {
        if !self.emit_output {
            return Ok(());
        }
        if let Some(rendered) = self.markdown_stream.flush(&self.renderer) {
            write!(io::stdout(), "{rendered}")
                .and_then(|()| io::stdout().flush())
                .map_err(|error| RuntimeError::new(error.to_string()))?;
        }
        Ok(())
    }
}

impl aris_executor::StreamObserver for CliStreamObserver {
    fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
        if !self.emit_output {
            return Ok(());
        }
        if let Some(rendered) = self.markdown_stream.push(&self.renderer, text) {
            write!(io::stdout(), "{rendered}")
                .and_then(|()| io::stdout().flush())
                .map_err(|error| RuntimeError::new(error.to_string()))?;
        }
        Ok(())
    }

    fn on_tool_call(&mut self, _id: &str, name: &str, input: &str) -> Result<(), RuntimeError> {
        if !self.emit_output {
            return Ok(());
        }
        self.flush_markdown()?;
        writeln!(io::stdout(), "\n{}", format_tool_call_start(name, input))
            .and_then(|()| io::stdout().flush())
            .map_err(|error| RuntimeError::new(error.to_string()))
    }

    fn on_message_stop(&mut self) -> Result<(), RuntimeError> {
        self.flush_markdown()
    }
}

fn build_event_sink(
    _feature_config: &runtime::RuntimeFeatureConfig,
) -> Box<dyn runtime::EventSink> {
    let level_str = std::env::var("ARIS_META_LOGGING").unwrap_or_default();
    let level = runtime::MetaLoggingLevel::parse(&level_str);
    if level == runtime::MetaLoggingLevel::Off {
        return Box::new(runtime::NoopEventSink);
    }
    let path = runtime::JsonlEventSink::default_path();
    let session_id = std::env::var("ARIS_SESSION_ID").unwrap_or_default();
    Box::new(runtime::JsonlEventSink::new(path, level, session_id))
}

struct CliPermissionPrompter {
    current_mode: PermissionMode,
}

impl CliPermissionPrompter {
    fn new(current_mode: PermissionMode) -> Self {
        Self { current_mode }
    }
}

impl runtime::PermissionPrompter for CliPermissionPrompter {
    fn decide(
        &mut self,
        request: &runtime::PermissionRequest,
    ) -> runtime::PermissionPromptDecision {
        println!();
        println!("Permission approval required");
        println!("  Tool             {}", request.tool_name);
        println!("  Current mode     {}", self.current_mode.as_str());
        println!("  Required mode    {}", request.required_mode.as_str());
        println!("  Input            {}", request.input);
        print!("Approve this tool call? [y/N]: ");
        let _ = io::stdout().flush();

        let mut response = String::new();
        match io::stdin().read_line(&mut response) {
            Ok(_) => {
                let normalized = response.trim().to_ascii_lowercase();
                if matches!(normalized.as_str(), "y" | "yes") {
                    runtime::PermissionPromptDecision::Allow
                } else {
                    runtime::PermissionPromptDecision::Deny {
                        reason: format!(
                            "tool '{}' denied by user approval prompt",
                            request.tool_name
                        ),
                    }
                }
            }
            Err(error) => runtime::PermissionPromptDecision::Deny {
                reason: format!("permission approval failed: {error}"),
            },
        }
    }
}

fn resolve_cli_auth_source() -> Result<AuthSource, Box<dyn std::error::Error>> {
    Ok(resolve_startup_auth_source(|| {
        let cwd = env::current_dir().map_err(api::ApiError::from)?;
        let config = ConfigLoader::default_for(&cwd).load().map_err(|error| {
            api::ApiError::Auth(format!("failed to load runtime OAuth config: {error}"))
        })?;
        Ok(config.oauth().cloned())
    })?)
}

fn final_assistant_text(summary: &runtime::TurnSummary) -> String {
    aris_chat::final_assistant_text(summary)
}

fn collect_tool_uses(summary: &runtime::TurnSummary) -> Vec<serde_json::Value> {
    summary
        .assistant_messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => Some(json!({
                "id": id,
                "name": name,
                "input": input,
            })),
            _ => None,
        })
        .collect()
}

fn collect_tool_results(summary: &runtime::TurnSummary) -> Vec<serde_json::Value> {
    summary
        .tool_results
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } => Some(json!({
                "tool_use_id": tool_use_id,
                "tool_name": tool_name,
                "output": output,
                "is_error": is_error,
            })),
            _ => None,
        })
        .collect()
}

fn slash_command_completion_candidates() -> Vec<(String, String)> {
    let mut candidates: Vec<(String, String)> = slash_command_specs()
        .iter()
        .map(|spec| (format!("/{}", spec.name), spec.summary.to_string()))
        .collect();

    let existing: std::collections::HashSet<String> =
        candidates.iter().map(|(n, _)| n.clone()).collect();
    let mut seen = existing;

    // Add all discovered skills (ARIS > Claude > bundled, already deduplicated)
    let all_skills = discover_all_skills();
    let mut skill_candidates: Vec<(String, String)> = all_skills
        .into_iter()
        .filter_map(|(name, desc, _source)| {
            let candidate = format!("/{name}");
            if seen.contains(&candidate) {
                return None;
            }
            seen.insert(candidate.clone());
            Some((candidate, desc))
        })
        .collect();
    skill_candidates.sort_by(|a, b| a.0.cmp(&b.0));
    candidates.extend(skill_candidates);

    candidates
}

#[cfg(test)]
fn push_output_block(
    block: OutputContentBlock,
    out: &mut (impl Write + ?Sized),
    events: &mut Vec<AssistantEvent>,
    pending_tool: &mut Option<(String, String, String)>,
    streaming_tool_input: bool,
) -> Result<(), RuntimeError> {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                let rendered = TerminalRenderer::new().markdown_to_ansi(&text);
                write!(out, "{rendered}")
                    .and_then(|()| out.flush())
                    .map_err(|error| RuntimeError::new(error.to_string()))?;
                events.push(AssistantEvent::TextDelta(text));
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            // During streaming, the initial content_block_start has an empty input ({}).
            // The real input arrives via input_json_delta events. In
            // non-streaming responses, preserve a legitimate empty object.
            let initial_input = if streaming_tool_input
                && input.is_object()
                && input.as_object().is_some_and(serde_json::Map::is_empty)
            {
                String::new()
            } else {
                input.to_string()
            };
            *pending_tool = Some((id, name, initial_input));
        }
        OutputContentBlock::Thinking {
            thinking,
            signature,
        } => {
            events.push(AssistantEvent::Thinking {
                thinking,
                signature,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
fn response_to_events(
    response: MessageResponse,
    out: &mut (impl Write + ?Sized),
) -> Result<Vec<AssistantEvent>, RuntimeError> {
    let mut events = Vec::new();
    let mut pending_tool = None;

    for block in response.content {
        push_output_block(block, out, &mut events, &mut pending_tool, false)?;
        if let Some((id, name, input)) = pending_tool.take() {
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }

    events.push(AssistantEvent::Usage(TokenUsage {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
    }));
    events.push(AssistantEvent::MessageStop);
    Ok(events)
}

#[derive(Clone)]
struct BuiltinCliToolExecutor {
    allowed_tools: Option<AllowedToolSet>,
}

impl BuiltinCliToolExecutor {
    fn new(allowed_tools: Option<AllowedToolSet>) -> Self {
        Self { allowed_tools }
    }
}

impl ToolExecutor for BuiltinCliToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", tool_name, input)
    }

    fn execute_with_id(
        &mut self,
        tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        if self
            .allowed_tools
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(tool_name))
        {
            return Err(ToolError::new(format!(
                "tool `{tool_name}` is not enabled by the current --allowedTools setting"
            )));
        }
        let value = serde_json::from_str(input)
            .map_err(|error| ToolError::new(format!("invalid tool input JSON: {error}")))?;
        let context = ToolRunContext {
            tool_use_id: (!tool_use_id.trim().is_empty()).then(|| tool_use_id.to_string()),
            session_id: std::env::var("ARIS_SESSION_ID").ok(),
            turn_id: std::env::var("ARIS_TURN_ID").ok(),
        };
        execute_tool_with_context(tool_name, &value, context).map_err(ToolError::new)
    }

    fn execution(&self, tool_name: &str) -> ToolExecution {
        tool_execution(tool_name)
    }

    fn execute_batch(&mut self, invocations: &[ToolInvocation]) -> Vec<Result<String, ToolError>> {
        if invocations.len() <= 1 {
            return invocations
                .iter()
                .map(|invocation| {
                    self.execute_with_id(
                        &invocation.tool_use_id,
                        &invocation.tool_name,
                        &invocation.input,
                    )
                })
                .collect();
        }
        std::thread::scope(|scope| {
            let handles = invocations
                .iter()
                .map(|invocation| {
                    let mut executor = self.clone();
                    scope.spawn(move || {
                        executor.execute_with_id(
                            &invocation.tool_use_id,
                            &invocation.tool_name,
                            &invocation.input,
                        )
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err(ToolError::new("parallel tool worker panicked")))
                })
                .collect()
        })
    }
}

struct CliToolExecutor {
    renderer: TerminalRenderer,
    emit_output: bool,
    inner: aris_chat::McpToolExecutor<BuiltinCliToolExecutor>,
}

impl CliToolExecutor {
    fn new(inner: aris_chat::McpToolExecutor<BuiltinCliToolExecutor>, emit_output: bool) -> Self {
        Self {
            renderer: TerminalRenderer::new(),
            emit_output,
            inner,
        }
    }
}

impl ToolExecutor for CliToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", tool_name, input)
    }

    fn execute_with_id(
        &mut self,
        tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        match self.inner.execute_with_id(tool_use_id, tool_name, input) {
            Ok(output) => {
                if self.emit_output {
                    let markdown = format_tool_result(tool_name, &output, false);
                    self.renderer
                        .stream_markdown(&markdown, &mut io::stdout())
                        .map_err(|error| ToolError::new(error.to_string()))?;
                }
                Ok(output)
            }
            Err(error) => {
                if self.emit_output {
                    let markdown = format_tool_result(tool_name, &error.to_string(), true);
                    self.renderer
                        .stream_markdown(&markdown, &mut io::stdout())
                        .map_err(|stream_error| ToolError::new(stream_error.to_string()))?;
                }
                Err(error)
            }
        }
    }

    fn execution(&self, tool_name: &str) -> ToolExecution {
        self.inner.execution(tool_name)
    }

    fn execute_batch(&mut self, invocations: &[ToolInvocation]) -> Vec<Result<String, ToolError>> {
        let results = self.inner.execute_batch(invocations);
        invocations
            .iter()
            .zip(results)
            .map(|(invocation, result)| {
                if self.emit_output {
                    let markdown = match &result {
                        Ok(output) => format_tool_result(&invocation.tool_name, output, false),
                        Err(error) => {
                            format_tool_result(&invocation.tool_name, &error.to_string(), true)
                        }
                    };
                    if let Err(error) = self.renderer.stream_markdown(&markdown, &mut io::stdout())
                    {
                        return Err(ToolError::new(error.to_string()));
                    }
                }
                result
            })
            .collect()
    }
}

#[cfg(test)]
fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let content = message
                .blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => InputContentBlock::Text { text: text.clone() },
                    ContentBlock::Image { media_type, data } => InputContentBlock::Image {
                        source: ImageSource::base64(media_type.clone(), data.clone()),
                    },
                    ContentBlock::ToolUse { id, name, input } => InputContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: serde_json::from_str(input)
                            .unwrap_or_else(|_| serde_json::json!({ "raw": input })),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output,
                        is_error,
                        ..
                    } => InputContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: vec![ToolResultContentBlock::Text {
                            text: output.clone(),
                        }],
                        is_error: *is_error,
                    },
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => InputContentBlock::Thinking {
                        thinking: thinking.clone(),
                        signature: signature.clone(),
                    },
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

fn print_help_to(out: &mut impl Write) -> io::Result<()> {
    writeln!(out, "aris v{VERSION} — Auto Research in Sleep")?;
    writeln!(out)?;
    writeln!(out, "Usage:")?;
    writeln!(
        out,
        "  aris [--model MODEL] [--allowedTools TOOL[,TOOL...]]"
    )?;
    writeln!(out, "      Start the interactive REPL")?;
    writeln!(
        out,
        "  aris [--model MODEL] [--output-format text|json] prompt TEXT"
    )?;
    writeln!(out, "      Send one prompt and exit")?;
    writeln!(
        out,
        "  aris [--model MODEL] [--output-format text|json] TEXT"
    )?;
    writeln!(out, "      Shorthand non-interactive prompt mode")?;
    writeln!(
        out,
        "  aris --resume SESSION.json [/status] [/compact] [...]"
    )?;
    writeln!(
        out,
        "      Inspect or maintain a saved session without entering the REPL"
    )?;
    writeln!(out, "  aris setup                                          Configure API keys / model / language (interactive)")?;
    writeln!(
        out,
        "  aris doctor                                         Health check"
    )?;
    writeln!(out, "  aris dump-manifests")?;
    writeln!(out, "  aris bootstrap-plan")?;
    writeln!(out, "  aris system-prompt [--cwd PATH] [--date YYYY-MM-DD]")?;
    writeln!(out, "  aris login")?;
    writeln!(out, "  aris logout")?;
    writeln!(out, "  aris init")?;
    writeln!(out)?;
    writeln!(out, "Flags:")?;
    writeln!(
        out,
        "  --model MODEL              Override the active model"
    )?;
    writeln!(
        out,
        "  --output-format FORMAT     Non-interactive output format: text or json"
    )?;
    writeln!(
        out,
        "  --permission-mode MODE     Set read-only, workspace-write, or danger-full-access"
    )?;
    writeln!(
        out,
        "  --dangerously-skip-permissions  Skip all permission checks"
    )?;
    writeln!(out, "  --allowedTools TOOLS       Restrict enabled tools (repeatable; comma-separated aliases supported)")?;
    writeln!(
        out,
        "  --version, -V              Print version and build information locally"
    )?;
    writeln!(out)?;
    writeln!(out, "Executor providers:")?;
    writeln!(out, "  Default:   Anthropic Claude (ANTHROPIC_API_KEY)")?;
    writeln!(
        out,
        "  OpenAI:    EXECUTOR_PROVIDER=openai EXECUTOR_API_KEY=xxx aris --model gpt-4o"
    )?;
    writeln!(
        out,
        "  DeepSeek:  Run `aris setup` → option 7 (DeepSeek) → base URL https://api.deepseek.com/anthropic"
    )?;
    writeln!(
        out,
        "  GLM:       EXECUTOR_PROVIDER=openai EXECUTOR_BASE_URL=https://open.bigmodel.cn/api/paas/v4/ EXECUTOR_API_KEY=xxx aris --model glm-4-plus"
    )?;
    writeln!(
        out,
        "  Gemini:    EXECUTOR_PROVIDER=openai EXECUTOR_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai EXECUTOR_API_KEY=xxx aris --model gemini-2.5-pro"
    )?;
    writeln!(out)?;
    writeln!(out, "Interactive slash commands:")?;
    writeln!(out, "{}", render_slash_command_help())?;
    writeln!(out)?;
    let resume_commands = resume_supported_slash_commands()
        .into_iter()
        .map(|spec| match spec.argument_hint {
            Some(argument_hint) => format!("/{} {}", spec.name, argument_hint),
            None => format!("/{}", spec.name),
        })
        .collect::<Vec<_>>()
        .join(", ");
    writeln!(out, "Resume-safe commands: {resume_commands}")?;
    writeln!(out, "Examples:")?;
    writeln!(out, "  aris --model claude-opus \"summarize this repo\"")?;
    writeln!(
        out,
        "  aris --output-format json prompt \"explain src/main.rs\""
    )?;
    writeln!(
        out,
        "  aris --allowedTools read,glob \"summarize Cargo.toml\""
    )?;
    writeln!(
        out,
        "  aris --resume session.json /status /diff /export notes.txt"
    )?;
    writeln!(out, "  aris setup")?;
    writeln!(out, "  aris doctor")?;
    writeln!(out, "  aris login")?;
    writeln!(out, "  aris init")?;
    Ok(())
}

fn print_help() {
    let _ = print_help_to(&mut io::stdout());
}

fn check_auth_status() -> &'static str {
    if env::var("ANTHROPIC_API_KEY").map_or(false, |v| !v.is_empty()) {
        return "OK (API key)";
    }
    if env::var("ANTHROPIC_AUTH_TOKEN").map_or(false, |v| !v.is_empty()) {
        return "OK (bearer token)";
    }
    let home = runtime::home_dir();
    let creds_path = PathBuf::from(&home)
        .join(".claude")
        .join("credentials.json");
    if creds_path.exists() {
        return "OK (OAuth saved)";
    }
    // Check macOS Keychain for Claude Code's OAuth token
    if let Ok(output) = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
    {
        if output.status.success() {
            return "OK (Keychain OAuth)";
        }
    }
    "NOT FOUND"
}

fn run_doctor() -> Result<(), Box<dyn std::error::Error>> {
    println!("ARIS Doctor v{VERSION}");
    println!();

    let mut all_ok = true;

    // Check 0: Executor provider
    let executor_provider =
        std::env::var("EXECUTOR_PROVIDER").unwrap_or_else(|_| "anthropic".into());
    print!("  Executor:     ");
    if executor_provider == "openai" {
        let base = std::env::var("EXECUTOR_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".into());
        let has_key = std::env::var("EXECUTOR_API_KEY")
            .or_else(|_| std::env::var("OPENAI_API_KEY"))
            .is_ok();
        if has_key {
            println!("OpenAI-compat ({base})");
        } else {
            println!("OpenAI-compat (NO API KEY!)");
            all_ok = false;
        }
    } else {
        println!("Anthropic (default)");
    }

    // Check 1: API auth
    let auth_status = check_auth_status();
    println!("  API auth:     {auth_status}");
    if auth_status == "NOT FOUND" && executor_provider != "openai" {
        all_ok = false;
    }

    // Check 2: ARIS skills directories + discovered skills.
    let skill_dirs = skill_search_dirs();
    let skill_count: usize = skill_dirs
        .iter()
        .map(|dir| count_filesystem_skills(dir))
        .sum();
    let skill_dir_list = skill_dirs
        .iter()
        .map(|dir| dir.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    print!("  Skills dirs:  ");
    println!("OK ({skill_count} custom skills across {skill_dir_list}; built-ins available)");

    // Check 2b: Reviewer API (LlmReview)
    print!("  Reviewer API: ");
    let reviewer_keys: &[(&str, &str)] = &[
        ("OPENAI_API_KEY", "OpenAI"),
        ("GEMINI_API_KEY", "Gemini"),
        ("GLM_API_KEY", "GLM"),
        ("MINIMAX_API_KEY", "MiniMax"),
        ("KIMI_API_KEY", "Kimi"),
        ("ARIS_REVIEWER_AUTH_TOKEN", "Anthropic-compat"),
        // run_llm_review also accepts ANTHROPIC_AUTH_TOKEN as a fallback for
        // anthropic-compat reviewer (see tools/src/lib.rs).
        ("ANTHROPIC_AUTH_TOKEN", "Anthropic-compat"),
    ];
    let found: Vec<&str> = reviewer_keys
        .iter()
        .filter(|(var, _)| std::env::var(var).ok().is_some_and(|v| !v.is_empty()))
        .map(|(_, label)| *label)
        .collect();
    if found.is_empty() {
        println!(
            "NOT FOUND (set one of: OPENAI_API_KEY / GEMINI_API_KEY / GLM_API_KEY / MINIMAX_API_KEY / KIMI_API_KEY / ARIS_REVIEWER_AUTH_TOKEN / ANTHROPIC_AUTH_TOKEN)"
        );
    } else {
        println!("OK ({})", found.join(", "));
    }

    // Check 3: Codex CLI
    print!("  Codex CLI:    ");
    match which_codex() {
        Some(path) => println!("OK ({})", path.display()),
        None => {
            println!("NOT FOUND (optional)");
        }
    }

    // Check 4 (v0.4.12 #238): Sandbox effective config
    print!("  Sandbox:      ");
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let sandbox_config = runtime::ConfigLoader::default_for(&cwd)
        .load()
        .map(|rc| rc.sandbox().clone())
        .unwrap_or_default();
    let strict = sandbox_config.is_strict();
    let enabled = sandbox_config.enabled.unwrap_or(true);
    // codex round-3 #4: detect any explicit sandbox field, not only `enabled`.
    let has_any_explicit_sandbox_field = sandbox_config.enabled.is_some()
        || sandbox_config.namespace_restrictions.is_some()
        || sandbox_config.network_isolation.is_some()
        || sandbox_config.filesystem_mode.is_some()
        || !sandbox_config.allowed_mounts.is_empty()
        || sandbox_config.strict_mode.is_some();
    if strict {
        println!(
            "strict (config), enabled={enabled} — LLM override of `dangerouslyDisableSandbox` is IGNORED"
        );
    } else if has_any_explicit_sandbox_field {
        println!(
            "permissive (config), enabled={enabled} — LLM tool calls can override per-command via `dangerouslyDisableSandbox`"
        );
    } else {
        println!(
            "default-allow (no config) — set `sandbox.strictMode: true` in settings.json to hard-lock"
        );
    }

    // Check 5: Codex MCP in config
    print!("  Codex MCP:    ");
    let loaded_runtime_config = runtime::ConfigLoader::default_for(&cwd).load().ok();
    if loaded_runtime_config
        .as_ref()
        .is_some_and(|config| config.mcp().get("codex").is_some())
    {
        println!("OK (configured)");
    } else if loaded_runtime_config.is_some() {
        println!("NOT CONFIGURED (add `codex` under mcpServers)");
    } else {
        println!("ERROR (could not load MCP configuration)");
    }

    // Check 6: MCP dispatch status.
    let mcp_server_count = loaded_runtime_config
        .as_ref()
        .map_or(0, |config| config.mcp().servers().len());
    if mcp_server_count > 0 {
        println!();
        println!(
            "\x1b[32m✓  MCP stdio tool dispatch enabled ({mcp_server_count} configured).\x1b[0m"
        );
    }

    println!();
    if all_ok {
        println!("All checks passed.");
    } else {
        println!("Some checks failed. Run `aris setup` to (re)configure API keys/models, or fix the items above manually.");
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/main.rs"]
mod tests;

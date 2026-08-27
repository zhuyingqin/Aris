use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use runtime::{ConfigLoader, ConfigSource, McpServerConfig, McpServerManager};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::projects::{current_project_path, ProjectState};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioServerInput {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    request_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    name: String,
    source: String,
    transport: String,
    command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigView {
    config_path: String,
    servers: Vec<McpStdioServerInput>,
    merged_servers: Vec<McpServerSummary>,
    managed_servers: Vec<ManagedMcpServerSummary>,
    presets: Vec<McpPresetSummary>,
    verification: Option<McpVerificationView>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpVerificationView {
    tested_at: u64,
    result: McpTestResult,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPresetSummary {
    id: String,
    available: bool,
    message: String,
    install_path: Option<String>,
    server: Option<McpStdioServerInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMcpServerSummary {
    name: String,
    source: String,
    transport: String,
    command: Option<String>,
    status: String,
    message: String,
    install_supported: bool,
    capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTestResult {
    name: String,
    ok: bool,
    transport: String,
    tools: Vec<String>,
    message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    ok: bool,
    servers: Vec<McpServerTestResult>,
}

static MCP_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const MCP_VERIFICATION_KEY: &str = "somniqVerification";

fn mcp_config_lock() -> &'static Mutex<()> {
    MCP_CONFIG_LOCK.get_or_init(|| Mutex::new(()))
}

fn global_mcp_path() -> PathBuf {
    crate::state::config_dir().join("mcp.json")
}

fn resolve_path_command(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = [".exe", ".com", ".cmd", ".bat"];
    #[cfg(not(windows))]
    let extensions = [""];
    std::env::split_paths(&path).find_map(|directory| {
        extensions
            .iter()
            .map(|extension| directory.join(format!("{command}{extension}")))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(windows)]
fn windows_script_server(name: &str, script: &Path, trailing_args: &[&str]) -> McpStdioServerInput {
    let command = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    let mut args = vec![
        "/D".to_string(),
        "/S".to_string(),
        "/C".to_string(),
        script.display().to_string(),
    ];
    args.extend(trailing_args.iter().map(|value| (*value).to_string()));
    McpStdioServerInput {
        name: name.to_string(),
        command: command.display().to_string(),
        args,
        env: BTreeMap::new(),
        request_timeout_secs: Some(900),
    }
}

fn executable_server(name: &str, executable: &Path, args: &[&str]) -> McpStdioServerInput {
    #[cfg(windows)]
    if executable
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
    {
        return windows_script_server(name, executable, args);
    }
    McpStdioServerInput {
        name: name.to_string(),
        command: executable.display().to_string(),
        args: args.iter().map(|value| (*value).to_string()).collect(),
        env: BTreeMap::new(),
        request_timeout_secs: Some(900),
    }
}

fn playwright_launcher() -> (Option<PathBuf>, PathBuf) {
    #[cfg(windows)]
    const LAUNCHER: &str = "aris-playwright-mcp.cmd";
    #[cfg(not(windows))]
    const LAUNCHER: &str = "aris-playwright-mcp";

    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("ARIS_RESOURCE_DIR") {
        let root = PathBuf::from(root);
        roots.push(root.clone());
        // Also tolerate an older app bootstrap that exported Tauri's parent
        // directory instead of the normalized bundled-resource root.
        roots.push(root.join("resources"));
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    let candidates = roots
        .into_iter()
        .map(|root| root.join("bin").join(LAUNCHER))
        .collect::<Vec<_>>();
    let expected = candidates.first().cloned().unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin")
            .join(LAUNCHER)
    });
    let resolved = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .or_else(|| resolve_path_command("aris-playwright-mcp"));
    let displayed_path = resolved.clone().unwrap_or(expected);
    (resolved, displayed_path)
}

fn preset(
    id: &str,
    executable: Option<PathBuf>,
    args: &[&str],
    unavailable_message: &str,
    install_path: Option<PathBuf>,
) -> McpPresetSummary {
    match executable {
        Some(executable) => McpPresetSummary {
            id: id.to_string(),
            available: true,
            message: format!("Ready: {}", executable.display()),
            install_path: install_path.map(|path| path.display().to_string()),
            server: Some(executable_server(id, &executable, args)),
        },
        None => McpPresetSummary {
            id: id.to_string(),
            available: false,
            message: unavailable_message.to_string(),
            install_path: install_path.map(|path| path.display().to_string()),
            server: None,
        },
    }
}

fn recommended_presets() -> Vec<McpPresetSummary> {
    let codex_config = PathBuf::from(runtime::home_dir())
        .join(".codex")
        .join("config.toml");
    let codex_has_legacy_default_tier =
        std::fs::read_to_string(codex_config)
            .ok()
            .is_some_and(|contents| {
                contents.lines().any(|line| {
                    line.split_once('=').is_some_and(|(key, value)| {
                        key.trim() == "service_tier" && value.trim().trim_matches('"') == "default"
                    })
                })
            });
    let codex_args = if codex_has_legacy_default_tier {
        vec!["-c", "service_tier=\"fast\"", "mcp-server"]
    } else {
        vec!["mcp-server"]
    };
    let playwright_args = if cfg!(windows) {
        vec![
            "--caps=pdf",
            "--cdp-endpoint",
            crate::playwright_pdf::PLAYWRIGHT_CDP_ENDPOINT,
            "--output-dir",
            ".somniq/tmp/browser/output",
        ]
    } else {
        vec![
            "--caps=pdf",
            "--cdp-endpoint",
            crate::playwright_pdf::PLAYWRIGHT_CDP_ENDPOINT,
            "--output-dir",
            ".somniq/tmp/browser/output",
        ]
    };
    let (playwright_executable, playwright_install_path) = playwright_launcher();
    vec![
        preset(
            "codex",
            resolve_path_command("codex"),
            &codex_args,
            "Codex CLI was not found on PATH.",
            None,
        ),
        preset(
            "claude",
            resolve_path_command("claude"),
            &["mcp", "serve"],
            "Claude Code was not found on PATH.",
            None,
        ),
        preset(
            "playwright",
            playwright_executable,
            &playwright_args,
            "The bundled Playwright MCP launcher is missing from the installation path shown below.",
            Some(playwright_install_path),
        ),
    ]
}

fn migrate_legacy_preset_servers(
    path: &Path,
    mut servers: Vec<McpStdioServerInput>,
    presets: &[McpPresetSummary],
) -> Result<Vec<McpStdioServerInput>, String> {
    let mut changed = false;
    for server in &mut servers {
        let managed_preset_shape = match server.name.as_str() {
            "codex" => {
                server.args.last().is_some_and(|arg| arg == "mcp-server")
                    && (server.command.eq_ignore_ascii_case("codex")
                        || server.args.iter().any(|arg| {
                            Path::new(arg)
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name.eq_ignore_ascii_case("codex.cmd"))
                        }))
            }
            "claude" => {
                server.args == ["mcp", "serve"]
                    && Path::new(&server.command)
                        .file_stem()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case("claude"))
            }
            "playwright" => server.args.iter().any(|arg| {
                Path::new(arg)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.eq_ignore_ascii_case("aris-playwright-mcp.cmd")
                            || name.eq_ignore_ascii_case("aris-playwright-mcp")
                    })
            }),
            _ => false,
        };
        if managed_preset_shape {
            if let Some(resolved) = presets
                .iter()
                .find(|preset| preset.id == server.name)
                .and_then(|preset| preset.server.clone())
            {
                if *server != resolved {
                    *server = resolved;
                    changed = true;
                }
            }
        }
    }
    if changed {
        write_global_stdio_servers(path, servers.clone())?;
    }
    Ok(servers)
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("{}: {error}", path.display()))?
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{}: expected a JSON object", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn parse_verification(root: &Map<String, Value>) -> Option<McpVerificationView> {
    root.get(MCP_VERIFICATION_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn persist_verification(path: &Path, result: &McpTestResult) -> Result<(), String> {
    let _guard = mcp_config_lock()
        .lock()
        .map_err(|_| "MCP configuration lock is poisoned".to_string())?;
    let mut root = read_json_object(path)?;
    let tested_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    root.insert(
        MCP_VERIFICATION_KEY.to_string(),
        serde_json::to_value(McpVerificationView {
            tested_at,
            result: result.clone(),
        })
        .map_err(|error| error.to_string())?,
    );
    let json =
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(path, format!("{json}\n"))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn clear_verification(path: &Path) -> Result<(), String> {
    let _guard = mcp_config_lock()
        .lock()
        .map_err(|_| "MCP configuration lock is poisoned".to_string())?;
    let mut root = read_json_object(path)?;
    if root.remove(MCP_VERIFICATION_KEY).is_none() {
        return Ok(());
    }
    let json =
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(path, format!("{json}\n"))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn parse_global_stdio_servers(
    root: &Map<String, Value>,
    path: &Path,
) -> Result<Vec<McpStdioServerInput>, String> {
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        if root.contains_key("mcpServers") {
            return Err(format!(
                "{}: mcpServers must be a JSON object",
                path.display()
            ));
        }
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for (name, value) in servers {
        let object = value.as_object().ok_or_else(|| {
            format!(
                "{}: mcpServers.{name} must be a JSON object",
                path.display()
            )
        })?;
        let server_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("stdio");
        if server_type != "stdio" {
            continue;
        }
        let command = object
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!(
                    "{}: mcpServers.{name}.command must be a string",
                    path.display()
                )
            })?
            .to_string();
        let args = match object.get("args") {
            None => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    value.as_str().map(ToString::to_string).ok_or_else(|| {
                        format!(
                            "{}: mcpServers.{name}.args[{index}] must be a string",
                            path.display()
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => {
                return Err(format!(
                    "{}: mcpServers.{name}.args must be an array",
                    path.display()
                ));
            }
        };
        let env = match object.get("env") {
            None => BTreeMap::new(),
            Some(Value::Object(items)) => items
                .iter()
                .map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), value.to_string()))
                        .ok_or_else(|| {
                            format!(
                                "{}: mcpServers.{name}.env.{key} must be a string",
                                path.display()
                            )
                        })
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?,
            Some(_) => {
                return Err(format!(
                    "{}: mcpServers.{name}.env must be an object",
                    path.display()
                ));
            }
        };
        let request_timeout_secs = match object.get("requestTimeoutSecs") {
            None => None,
            Some(value) => Some(value.as_u64().ok_or_else(|| {
                format!(
                    "{}: mcpServers.{name}.requestTimeoutSecs must be a positive integer",
                    path.display()
                )
            })?),
        };
        result.push(McpStdioServerInput {
            name: name.clone(),
            command,
            args,
            env,
            request_timeout_secs,
        });
    }
    result.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(result)
}

fn source_label(source: ConfigSource) -> String {
    match source {
        ConfigSource::User => "user",
        ConfigSource::Project => "project",
        ConfigSource::Local => "local",
    }
    .to_string()
}

fn transport_label(config: &McpServerConfig) -> String {
    match config {
        McpServerConfig::Stdio(_) => "stdio",
        McpServerConfig::Sse(_) => "sse",
        McpServerConfig::Http(_) => "http",
        McpServerConfig::Ws(_) => "ws",
        McpServerConfig::Sdk(_) => "sdk",
        McpServerConfig::ClaudeAiProxy(_) => "claudeai-proxy",
    }
    .to_string()
}

fn config_loader_for(project_root: &Path, global_path: &Path) -> ConfigLoader {
    ConfigLoader::default_for(project_root).with_global_mcp_config(global_path)
}

pub(crate) fn config_loader(project_root: &Path) -> ConfigLoader {
    let global_path = global_mcp_path();
    if let Err(error) = migrate_project_stdio_to_global_if_needed(project_root, &global_path) {
        eprintln!("SomniQ desktop: could not migrate project MCP settings: {error}");
    }
    config_loader_for(project_root, &global_path)
}

fn merged_server_summaries(
    project_root: &Path,
    global_path: &Path,
    global_names: &BTreeSet<String>,
) -> Result<Vec<McpServerSummary>, String> {
    let config = config_loader_for(project_root, global_path)
        .load()
        .map_err(|error| error.to_string())?;
    Ok(config
        .mcp()
        .servers()
        .iter()
        .map(|(name, scoped)| McpServerSummary {
            name: name.clone(),
            source: if global_names.contains(name) {
                "global".to_string()
            } else {
                source_label(scoped.scope)
            },
            transport: transport_label(&scoped.config),
            command: match &scoped.config {
                McpServerConfig::Stdio(config) => Some(config.command.clone()),
                _ => None,
            },
        })
        .collect())
}

fn managed_server_summaries() -> Vec<ManagedMcpServerSummary> {
    let (command, status, message, install_supported) = match crate::oracle_web::oracle_web_status()
    {
        Ok(view) => (
            view.runtime.command_path,
            view.runtime.status,
            view.runtime.message,
            view.runtime.install_supported,
        ),
        Err(error) => (
            None,
            "error".to_string(),
            format!("Could not read the managed Oracle MCP state: {error}"),
            false,
        ),
    };
    vec![ManagedMcpServerSummary {
        name: "oracle-web".to_string(),
        source: "managed".to_string(),
        transport: "stdio".to_string(),
        command,
        status,
        message,
        install_supported,
        capabilities: vec![
            "ChatGptWebConsult".to_string(),
            "ChatGptWebImage".to_string(),
            "IndependentReview".to_string(),
        ],
    }]
}

fn mcp_config_get_for(project_root: &Path, path: &Path) -> Result<McpConfigView, String> {
    let root = read_json_object(path)?;
    let verification = parse_verification(&root);
    let presets = recommended_presets();
    let servers =
        migrate_legacy_preset_servers(path, parse_global_stdio_servers(&root, path)?, &presets)?;
    let global_names = servers
        .iter()
        .map(|server| server.name.clone())
        .collect::<BTreeSet<_>>();
    Ok(McpConfigView {
        config_path: path.display().to_string(),
        servers,
        merged_servers: merged_server_summaries(project_root, path, &global_names)?,
        managed_servers: managed_server_summaries(),
        presets,
        verification,
    })
}

fn validate_stdio_servers(servers: &[McpStdioServerInput]) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for server in servers {
        let name = server.name.trim();
        if name.is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        if name.chars().count() > 128 || name.chars().any(char::is_control) {
            return Err(format!("MCP server name `{name}` is invalid"));
        }
        if server.command.trim().is_empty() {
            return Err(format!("MCP server `{}` needs a command", server.name));
        }
        if server.command.contains('\0')
            || server.args.iter().any(|arg| arg.contains('\0'))
            || server.env.values().any(|value| value.contains('\0'))
        {
            return Err(format!("MCP server `{name}` contains a null byte"));
        }
        if server
            .request_timeout_secs
            .is_some_and(|timeout| !(1..=1_800).contains(&timeout))
        {
            return Err(format!(
                "MCP server `{name}` request timeout must be between 1 and 1800 seconds"
            ));
        }
        for key in server.env.keys() {
            if key.is_empty() || key.contains(['=', '\0']) {
                return Err(format!(
                    "MCP server `{name}` has an invalid environment key"
                ));
            }
        }
        if !names.insert(name.to_string()) {
            return Err(format!("duplicate MCP server name `{}`", server.name));
        }
    }
    Ok(names)
}

fn write_global_stdio_servers(
    path: &Path,
    servers: Vec<McpStdioServerInput>,
) -> Result<(), String> {
    let names = validate_stdio_servers(&servers)?;
    let _guard = mcp_config_lock()
        .lock()
        .map_err(|_| "MCP configuration lock is poisoned".to_string())?;
    let mut root = read_json_object(path)?;
    let mut existing = match root.remove("mcpServers") {
        None => Map::new(),
        Some(Value::Object(servers)) => servers,
        Some(_) => {
            return Err(format!(
                "{}: mcpServers must be a JSON object",
                path.display()
            ));
        }
    };
    existing.retain(|_, value| {
        value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
            .is_some_and(|server_type| server_type != "stdio")
    });

    for name in &names {
        if existing.contains_key(name) {
            return Err(format!(
                "MCP server `{name}` is already used by a non-STDIO server in the global configuration"
            ));
        }
    }

    for server in servers {
        let mut object = Map::new();
        object.insert("type".to_string(), Value::String("stdio".to_string()));
        object.insert(
            "command".to_string(),
            Value::String(server.command.trim().to_string()),
        );
        object.insert(
            "args".to_string(),
            Value::Array(server.args.into_iter().map(Value::String).collect()),
        );
        object.insert(
            "env".to_string(),
            Value::Object(
                server
                    .env
                    .into_iter()
                    .map(|(key, value)| (key, Value::String(value)))
                    .collect(),
            ),
        );
        if let Some(timeout) = server.request_timeout_secs {
            object.insert(
                "requestTimeoutSecs".to_string(),
                Value::Number(timeout.into()),
            );
        }
        existing.insert(server.name.trim().to_string(), Value::Object(object));
    }
    root.insert("mcpServers".to_string(), Value::Object(existing));

    let json =
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| error.to_string())?;
    runtime::write_file_atomically(path, format!("{json}\n"))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn migrate_project_stdio_to_global_if_needed(
    project_root: &Path,
    global_path: &Path,
) -> Result<bool, String> {
    if global_path.exists() {
        return Ok(false);
    }
    let project_path = project_root.join(".mcp.json");
    if !project_path.is_file() {
        return Ok(false);
    }
    let project_config = read_json_object(&project_path)?;
    let servers = parse_global_stdio_servers(&project_config, &project_path)?;
    if servers.is_empty() {
        return Ok(false);
    }
    write_global_stdio_servers(global_path, servers)?;
    Ok(true)
}

#[tauri::command]
pub fn mcp_config_get(projects: State<ProjectState>) -> Result<McpConfigView, String> {
    let project_root = current_project_path(projects.inner())?;
    let path = global_mcp_path();
    migrate_project_stdio_to_global_if_needed(&project_root, &path)?;
    mcp_config_get_for(&project_root, &path)
}

#[tauri::command]
pub fn mcp_config_set(
    projects: State<ProjectState>,
    servers: Vec<McpStdioServerInput>,
) -> Result<McpConfigView, String> {
    let project_root = current_project_path(projects.inner())?;
    let path = global_mcp_path();
    let previous = parse_global_stdio_servers(&read_json_object(&path)?, &path)?;
    let changed = previous != servers;
    write_global_stdio_servers(&path, servers)?;
    if changed {
        clear_verification(&path)?;
    }
    aris_chat::clear_mcp_discovery_cache();
    mcp_config_get_for(&project_root, &path)
}

#[tauri::command]
pub async fn mcp_config_test(projects: State<'_, ProjectState>) -> Result<McpTestResult, String> {
    aris_chat::clear_mcp_discovery_cache();
    let project_root = current_project_path(projects.inner())?;
    let config = config_loader(&project_root)
        .load()
        .map_err(|error| error.to_string())?;
    let mut manager = McpServerManager::from_runtime_config(&config);
    let unsupported = manager
        .unsupported_servers()
        .iter()
        .map(|server| (server.server_name.clone(), server.reason.clone()))
        .collect::<BTreeMap<_, _>>();
    let (discovered, failures) = manager
        .discover_tools_resilient_with_timeout(std::time::Duration::from_secs(45))
        .await;
    let _ = manager.shutdown().await;

    let mut tools_by_server = BTreeMap::<String, Vec<String>>::new();
    for tool in discovered {
        tools_by_server
            .entry(tool.server_name)
            .or_default()
            .push(tool.qualified_name);
    }
    let failures = failures.into_iter().collect::<BTreeMap<_, _>>();
    let mut servers = Vec::new();
    for (name, scoped) in config.mcp().servers() {
        let tools = tools_by_server.remove(name).unwrap_or_default();
        let error = unsupported.get(name).or_else(|| failures.get(name));
        servers.push(McpServerTestResult {
            name: name.clone(),
            ok: error.is_none(),
            transport: transport_label(&scoped.config),
            message: error.map_or_else(
                || format!("Connected; {} tool(s) discovered", tools.len()),
                Clone::clone,
            ),
            tools,
        });
    }
    let result = McpTestResult {
        ok: servers.iter().all(|server| server.ok),
        servers,
    };
    persist_verification(&global_mcp_path(), &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str, command: &str) -> McpStdioServerInput {
        McpStdioServerInput {
            name: name.to_string(),
            command: command.to_string(),
            args: vec!["serve".to_string()],
            env: BTreeMap::new(),
            request_timeout_secs: Some(300),
        }
    }

    #[test]
    fn global_parser_rejects_malformed_stdio_fields_instead_of_hiding_them() {
        let path = Path::new("mcp.json");
        let root = serde_json::json!({
            "mcpServers": {
                "broken": {"type": "stdio", "command": "tool", "args": [42]}
            }
        })
        .as_object()
        .expect("object")
        .clone();

        let error = parse_global_stdio_servers(&root, path).expect_err("invalid args must fail");
        assert!(error.contains("mcpServers.broken.args[0] must be a string"));
    }

    #[test]
    fn global_writer_preserves_non_stdio_servers_and_unrelated_keys() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let path = temporary.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"note":"keep","mcpServers":{"remote":{"type":"http","url":"https://example.test/mcp"},"old":{"type":"stdio","command":"old"}}}"#,
        )
        .expect("seed config");

        write_global_stdio_servers(&path, vec![stdio("new", "new-command")])
            .expect("write global MCP config");

        let root = read_json_object(&path).expect("read saved config");
        assert_eq!(root.get("note").and_then(Value::as_str), Some("keep"));
        let servers = root
            .get("mcpServers")
            .and_then(Value::as_object)
            .expect("servers");
        assert!(servers.contains_key("remote"));
        assert!(servers.contains_key("new"));
        assert!(!servers.contains_key("old"));
    }

    #[test]
    fn global_writer_refuses_to_overwrite_a_same_named_remote_server() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let path = temporary.path().join("mcp.json");
        let original =
            r#"{"mcpServers":{"shared":{"type":"http","url":"https://example.test/mcp"}}}"#;
        std::fs::write(&path, original).expect("seed config");

        let error = write_global_stdio_servers(&path, vec![stdio("shared", "stdio-command")])
            .expect_err("name collision must fail closed");
        assert!(error.contains("already used by a non-STDIO server"));
        assert_eq!(
            std::fs::read_to_string(path).expect("unchanged config"),
            original
        );
    }

    #[test]
    fn global_writer_validates_timeout_and_process_null_bytes() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let path = temporary.path().join("mcp.json");
        let mut invalid_timeout = stdio("slow", "tool");
        invalid_timeout.request_timeout_secs = Some(1_801);
        assert!(write_global_stdio_servers(&path, vec![invalid_timeout])
            .expect_err("timeout must be bounded")
            .contains("between 1 and 1800"));

        let invalid_command = stdio("null", "tool\0hidden");
        assert!(write_global_stdio_servers(&path, vec![invalid_command])
            .expect_err("null byte must be rejected")
            .contains("null byte"));
    }

    #[test]
    fn first_global_load_copies_project_stdio_without_modifying_the_project_file() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let project = temporary.path().join("project");
        let global = temporary.path().join("config").join("mcp.json");
        std::fs::create_dir_all(&project).expect("project dir");
        let original = r#"{"note":"legacy","mcpServers":{"legacy":{"type":"stdio","command":"legacy-mcp"},"remote":{"type":"http","url":"https://example.test/mcp"}}}"#;
        std::fs::write(project.join(".mcp.json"), original).expect("legacy project config");

        assert!(migrate_project_stdio_to_global_if_needed(&project, &global)
            .expect("migration should succeed"));
        let migrated = read_json_object(&global).expect("global config");
        let servers = migrated
            .get("mcpServers")
            .and_then(Value::as_object)
            .expect("global servers");
        assert!(servers.contains_key("legacy"));
        assert!(!servers.contains_key("remote"));
        assert_eq!(
            std::fs::read_to_string(project.join(".mcp.json")).expect("legacy config retained"),
            original
        );
        assert!(
            !migrate_project_stdio_to_global_if_needed(&project, &global)
                .expect("migration is one-time")
        );
    }

    #[test]
    fn legacy_playwright_command_is_replaced_with_the_resolved_backend_preset() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let path = temporary.path().join("mcp.json");
        let legacy = McpStdioServerInput {
            name: "playwright".to_string(),
            command: "cmd".to_string(),
            args: vec![
                "/c".to_string(),
                "aris-playwright-mcp.cmd".to_string(),
                "--browser=msedge".to_string(),
            ],
            env: BTreeMap::new(),
            request_timeout_secs: Some(900),
        };
        write_global_stdio_servers(&path, vec![legacy.clone()]).expect("seed legacy config");
        let resolved = McpStdioServerInput {
            name: "playwright".to_string(),
            command: "C:/Windows/System32/cmd.exe".to_string(),
            args: vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                "C:/SomniQ/resources/bin/aris-playwright-mcp.cmd".to_string(),
            ],
            env: BTreeMap::new(),
            request_timeout_secs: Some(900),
        };
        let presets = vec![McpPresetSummary {
            id: "playwright".to_string(),
            available: true,
            message: "ready".to_string(),
            install_path: Some("C:/SomniQ/resources/bin/aris-playwright-mcp.cmd".to_string()),
            server: Some(resolved.clone()),
        }];

        let migrated =
            migrate_legacy_preset_servers(&path, vec![legacy], &presets).expect("migrate preset");
        assert_eq!(migrated, vec![resolved.clone()]);
        let saved =
            parse_global_stdio_servers(&read_json_object(&path).expect("saved config"), &path)
                .expect("parse saved config");
        assert_eq!(saved, vec![resolved]);
    }

    #[test]
    fn preset_resolution_reports_all_curated_integrations() {
        let presets = recommended_presets();
        assert_eq!(
            presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex", "claude", "playwright"]
        );
        for preset in presets {
            assert_eq!(preset.available, preset.server.is_some());
        }
    }

    #[test]
    fn verification_result_is_durable_and_can_be_invalidated_after_config_changes() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let path = temporary.path().join("mcp.json");
        write_global_stdio_servers(&path, vec![stdio("verified", "verified-mcp")])
            .expect("seed config");
        let result = McpTestResult {
            ok: true,
            servers: vec![McpServerTestResult {
                name: "verified".to_string(),
                ok: true,
                transport: "stdio".to_string(),
                tools: vec!["verified__tool".to_string()],
                message: "Connected; 1 tool(s) discovered".to_string(),
            }],
        };

        persist_verification(&path, &result).expect("persist verification");
        let root = read_json_object(&path).expect("read verification");
        let saved = parse_verification(&root).expect("verification should round trip");
        assert!(saved.tested_at > 0);
        assert!(saved.result.ok);
        assert_eq!(saved.result.servers[0].tools, vec!["verified__tool"]);

        clear_verification(&path).expect("clear stale verification");
        assert!(
            parse_verification(&read_json_object(&path).expect("read cleared config")).is_none()
        );
    }
}

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use runtime::{ConfigLoader, ConfigSource, McpServerConfig, McpServerManager};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    project_path: String,
    servers: Vec<McpStdioServerInput>,
    merged_servers: Vec<McpServerSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerTestResult {
    name: String,
    ok: bool,
    transport: String,
    tools: Vec<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    ok: bool,
    servers: Vec<McpServerTestResult>,
}

fn project_mcp_path() -> Result<PathBuf, String> {
    std::env::current_dir()
        .map(|cwd| cwd.join(".mcp.json"))
        .map_err(|error| error.to_string())
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

fn parse_project_stdio_servers(root: &Map<String, Value>) -> Vec<McpStdioServerInput> {
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut result = servers
        .iter()
        .filter_map(|(name, value)| {
            let object = value.as_object()?;
            let server_type = object.get("type").and_then(Value::as_str).unwrap_or("stdio");
            if server_type != "stdio" {
                return None;
            }
            let command = object.get("command").and_then(Value::as_str)?.to_string();
            let args = object
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let env = object
                .get("env")
                .and_then(Value::as_object)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|(key, value)| {
                            value
                                .as_str()
                                .map(|value| (key.clone(), value.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let request_timeout_secs = object.get("requestTimeoutSecs").and_then(Value::as_u64);
            Some(McpStdioServerInput {
                name: name.clone(),
                command,
                args,
                env,
                request_timeout_secs,
            })
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.name.cmp(&right.name));
    result
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

fn merged_server_summaries() -> Result<Vec<McpServerSummary>, String> {
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let config = ConfigLoader::default_for(cwd)
        .load()
        .map_err(|error| error.to_string())?;
    Ok(config
        .mcp()
        .servers()
        .iter()
        .map(|(name, scoped)| McpServerSummary {
            name: name.clone(),
            source: source_label(scoped.scope),
            transport: transport_label(&scoped.config),
            command: match &scoped.config {
                McpServerConfig::Stdio(config) => Some(config.command.clone()),
                _ => None,
            },
        })
        .collect())
}

#[tauri::command]
pub fn mcp_config_get() -> Result<McpConfigView, String> {
    let path = project_mcp_path()?;
    let root = read_json_object(&path)?;
    Ok(McpConfigView {
        project_path: path.display().to_string(),
        servers: parse_project_stdio_servers(&root),
        merged_servers: merged_server_summaries()?,
    })
}

#[tauri::command]
pub fn mcp_config_set(servers: Vec<McpStdioServerInput>) -> Result<McpConfigView, String> {
    let mut names = BTreeSet::new();
    for server in &servers {
        if server.name.trim().is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        if server.command.trim().is_empty() {
            return Err(format!("MCP server `{}` needs a command", server.name));
        }
        if !names.insert(server.name.trim().to_string()) {
            return Err(format!("duplicate MCP server name `{}`", server.name));
        }
    }

    let path = project_mcp_path()?;
    let mut root = read_json_object(&path)?;
    let mut existing = root
        .remove("mcpServers")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    existing.retain(|_, value| {
        value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
            .is_some_and(|server_type| server_type != "stdio")
    });

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

    let json = serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| error.to_string())?;
    std::fs::write(&path, format!("{json}\n")).map_err(|error| error.to_string())?;
    aris_chat::clear_mcp_discovery_cache();
    mcp_config_get()
}

#[tauri::command]
pub async fn mcp_config_test() -> Result<McpTestResult, String> {
    aris_chat::clear_mcp_discovery_cache();
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let config = ConfigLoader::default_for(cwd)
        .load()
        .map_err(|error| error.to_string())?;
    let mut manager = McpServerManager::from_runtime_config(&config);
    let unsupported = manager
        .unsupported_servers()
        .iter()
        .map(|server| (server.server_name.clone(), server.reason.clone()))
        .collect::<BTreeMap<_, _>>();
    let (discovered, failures) = manager.discover_tools_resilient().await;
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
    Ok(McpTestResult {
        ok: servers.iter().all(|server| server.ok),
        servers,
    })
}

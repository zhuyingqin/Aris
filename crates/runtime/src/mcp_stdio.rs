use std::collections::BTreeMap;
use std::io;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

use crate::config::{McpTransport, RuntimeConfig, ScopedMcpServerConfig};
use crate::mcp::mcp_tool_name;
use crate::mcp_client::{McpClientBootstrap, McpClientTransport, McpStdioTransport};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(u64),
    String(String),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcRequest<T = JsonValue> {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<T>,
}

impl<T> JsonRpcRequest<T> {
    #[must_use]
    pub fn new(id: JsonRpcId, method: impl Into<String>, params: Option<T>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcResponse<T = JsonValue> {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeParams {
    pub protocol_version: String,
    pub capabilities: JsonValue,
    pub client_info: McpInitializeClientInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeResult {
    pub protocol_version: String,
    pub capabilities: JsonValue,
    pub server_info: McpInitializeServerInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<JsonValue>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsResult {
    pub tools: Vec<McpTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallParams {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<JsonValue>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolCallContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(flatten)]
    pub data: BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResult {
    #[serde(default)]
    pub content: Vec<McpToolCallContent>,
    #[serde(default)]
    pub structured_content: Option<JsonValue>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpListResourcesParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpResource {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<JsonValue>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpListResourcesResult {
    pub resources: Vec<McpResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpReadResourceParams {
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpResourceContents {
    pub uri: String,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpReadResourceResult {
    pub contents: Vec<McpResourceContents>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ManagedMcpTool {
    pub server_name: String,
    pub qualified_name: String,
    pub raw_name: String,
    pub tool: McpTool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedMcpServer {
    pub server_name: String,
    pub transport: McpTransport,
    pub reason: String,
}

#[derive(Debug)]
pub enum McpServerManagerError {
    Io(io::Error),
    JsonRpc {
        server_name: String,
        method: &'static str,
        error: JsonRpcError,
    },
    InvalidResponse {
        server_name: String,
        method: &'static str,
        details: String,
    },
    UnknownTool {
        qualified_name: String,
    },
    UnknownServer {
        server_name: String,
    },
}

impl std::fmt::Display for McpServerManagerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::JsonRpc {
                server_name,
                method,
                error,
            } => write!(
                f,
                "MCP server `{server_name}` returned JSON-RPC error for {method}: {} ({})",
                error.message, error.code
            ),
            Self::InvalidResponse {
                server_name,
                method,
                details,
            } => write!(
                f,
                "MCP server `{server_name}` returned invalid response for {method}: {details}"
            ),
            Self::UnknownTool { qualified_name } => {
                write!(f, "unknown MCP tool `{qualified_name}`")
            }
            Self::UnknownServer { server_name } => write!(f, "unknown MCP server `{server_name}`"),
        }
    }
}

impl std::error::Error for McpServerManagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::JsonRpc { .. }
            | Self::InvalidResponse { .. }
            | Self::UnknownTool { .. }
            | Self::UnknownServer { .. } => None,
        }
    }
}

impl From<io::Error> for McpServerManagerError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolRoute {
    server_name: String,
    raw_name: String,
}

#[derive(Debug)]
struct ManagedMcpServer {
    bootstrap: McpClientBootstrap,
    process: Option<McpStdioProcess>,
    initialized: bool,
}

impl ManagedMcpServer {
    fn new(bootstrap: McpClientBootstrap) -> Self {
        Self {
            bootstrap,
            process: None,
            initialized: false,
        }
    }
}

#[derive(Debug)]
pub struct McpServerManager {
    servers: BTreeMap<String, ManagedMcpServer>,
    unsupported_servers: Vec<UnsupportedMcpServer>,
    tool_index: BTreeMap<String, ToolRoute>,
    next_request_id: u64,
}

impl McpServerManager {
    #[must_use]
    pub fn from_runtime_config(config: &RuntimeConfig) -> Self {
        Self::from_servers(config.mcp().servers())
    }

    #[must_use]
    pub fn from_servers(servers: &BTreeMap<String, ScopedMcpServerConfig>) -> Self {
        let mut managed_servers = BTreeMap::new();
        let mut unsupported_servers = Vec::new();

        for (server_name, server_config) in servers {
            if server_config.transport() == McpTransport::Stdio {
                let bootstrap = McpClientBootstrap::from_scoped_config(server_name, server_config);
                managed_servers.insert(server_name.clone(), ManagedMcpServer::new(bootstrap));
            } else {
                unsupported_servers.push(UnsupportedMcpServer {
                    server_name: server_name.clone(),
                    transport: server_config.transport(),
                    reason: format!(
                        "transport {:?} is not supported by McpServerManager",
                        server_config.transport()
                    ),
                });
            }
        }

        Self {
            servers: managed_servers,
            unsupported_servers,
            tool_index: BTreeMap::new(),
            next_request_id: 1,
        }
    }

    #[must_use]
    pub fn unsupported_servers(&self) -> &[UnsupportedMcpServer] {
        &self.unsupported_servers
    }

    pub async fn discover_tools(&mut self) -> Result<Vec<ManagedMcpTool>, McpServerManagerError> {
        let server_names = self.servers.keys().cloned().collect::<Vec<_>>();
        let mut discovered_tools = Vec::new();

        for server_name in server_names {
            discovered_tools.extend(self.discover_server_tools(&server_name).await?);
        }

        Ok(discovered_tools)
    }

    pub async fn discover_tools_resilient(
        &mut self,
    ) -> (Vec<ManagedMcpTool>, Vec<(String, String)>) {
        self.discover_tools_resilient_inner(None).await
    }

    /// Discover each server behind its own deadline so one hung bootstrap
    /// cannot consume the whole discovery budget and hide healthy servers.
    pub async fn discover_tools_resilient_with_timeout(
        &mut self,
        per_server_timeout: Duration,
    ) -> (Vec<ManagedMcpTool>, Vec<(String, String)>) {
        self.discover_tools_resilient_inner(Some(per_server_timeout))
            .await
    }

    async fn discover_tools_resilient_inner(
        &mut self,
        per_server_timeout: Option<Duration>,
    ) -> (Vec<ManagedMcpTool>, Vec<(String, String)>) {
        let server_names = self.servers.keys().cloned().collect::<Vec<_>>();
        let mut discovered_tools = Vec::new();
        let mut failures = Vec::new();

        for server_name in server_names {
            let result = match per_server_timeout {
                Some(timeout) => {
                    match tokio::time::timeout(timeout, self.discover_server_tools(&server_name))
                        .await
                    {
                        Ok(result) => result,
                        Err(_) => {
                            self.terminate_server(&server_name).await;
                            failures.push((
                                server_name,
                                format!("tool discovery exceeded {}s", timeout.as_secs_f64()),
                            ));
                            continue;
                        }
                    }
                }
                None => self.discover_server_tools(&server_name).await,
            };
            match result {
                Ok(tools) => discovered_tools.extend(tools),
                Err(error) => failures.push((server_name, error.to_string())),
            }
        }

        (discovered_tools, failures)
    }

    /// Restore routes from a prior discovery without starting MCP processes.
    ///
    /// The next tool call still initializes its server lazily. This lets chat
    /// runtimes reuse stable tool metadata without paying `initialize` and
    /// `tools/list` latency before every model turn.
    pub fn preload_discovered_tools(&mut self, tools: &[ManagedMcpTool]) {
        for managed in tools {
            if self.servers.contains_key(&managed.server_name) {
                self.tool_index.insert(
                    managed.qualified_name.clone(),
                    ToolRoute {
                        server_name: managed.server_name.clone(),
                        raw_name: managed.raw_name.clone(),
                    },
                );
            }
        }
    }

    pub async fn call_tool(
        &mut self,
        qualified_tool_name: &str,
        arguments: Option<JsonValue>,
    ) -> Result<JsonRpcResponse<McpToolCallResult>, McpServerManagerError> {
        let route = self
            .tool_index
            .get(qualified_tool_name)
            .cloned()
            .ok_or_else(|| McpServerManagerError::UnknownTool {
                qualified_name: qualified_tool_name.to_string(),
            })?;

        self.ensure_server_ready(&route.server_name).await?;
        let request_id = self.take_request_id();
        let response =
            {
                let server = self.server_mut(&route.server_name)?;
                let process = server.process.as_mut().ok_or_else(|| {
                    McpServerManagerError::InvalidResponse {
                        server_name: route.server_name.clone(),
                        method: "tools/call",
                        details: "server process missing after initialization".to_string(),
                    }
                })?;
                process
                    .call_tool(
                        request_id,
                        McpToolCallParams {
                            name: route.raw_name,
                            arguments,
                            meta: None,
                        },
                    )
                    .await?
            };
        Ok(response)
    }

    pub async fn shutdown(&mut self) -> Result<(), McpServerManagerError> {
        let server_names = self.servers.keys().cloned().collect::<Vec<_>>();
        for server_name in server_names {
            let server = self.server_mut(&server_name)?;
            if let Some(process) = server.process.as_mut() {
                process.shutdown().await?;
            }
            server.process = None;
            server.initialized = false;
        }
        Ok(())
    }

    fn clear_routes_for_server(&mut self, server_name: &str) {
        self.tool_index
            .retain(|_, route| route.server_name != server_name);
    }

    async fn terminate_server(&mut self, server_name: &str) {
        self.clear_routes_for_server(server_name);
        let process = self.servers.get_mut(server_name).and_then(|server| {
            server.initialized = false;
            server.process.take()
        });
        if let Some(mut process) = process {
            let _ = process.terminate().await;
        }
    }

    async fn discover_server_tools(
        &mut self,
        server_name: &str,
    ) -> Result<Vec<ManagedMcpTool>, McpServerManagerError> {
        // A child can close its stdio pipes just before Windows updates its
        // process status. In that narrow interval `try_wait()` reports it as
        // alive, so the first tools/list read observes EOF. Discovery is
        // idempotent, unlike a tool call, so rebuild the process and retry it
        // once for an explicit transport-close error.
        let result = match self.discover_server_tools_once(server_name).await {
            Ok(tools) => Ok(tools),
            Err(error) if is_retryable_discovery_transport_error(&error) => {
                self.invalidate_server_process(server_name)?;
                self.discover_server_tools_once(server_name).await
            }
            Err(error) => Err(error),
        };
        if result.is_err() {
            // `tools/list` can be paginated, so a failed discovery may have
            // installed routes from an earlier page. Never retain that partial
            // view after the terminal error.
            self.clear_routes_for_server(server_name);
        }
        result
    }

    async fn discover_server_tools_once(
        &mut self,
        server_name: &str,
    ) -> Result<Vec<ManagedMcpTool>, McpServerManagerError> {
        self.clear_routes_for_server(server_name);
        self.ensure_server_ready(server_name).await?;

        let mut cursor = None;
        let mut discovered_tools = Vec::new();
        loop {
            let request_id = self.take_request_id();
            let response = {
                let server = self.server_mut(server_name)?;
                let process = server.process.as_mut().ok_or_else(|| {
                    McpServerManagerError::InvalidResponse {
                        server_name: server_name.to_string(),
                        method: "tools/list",
                        details: "server process missing after initialization".to_string(),
                    }
                })?;
                process
                    .list_tools(
                        request_id,
                        Some(McpListToolsParams {
                            cursor: cursor.clone(),
                        }),
                    )
                    .await?
            };

            if let Some(error) = response.error {
                return Err(McpServerManagerError::JsonRpc {
                    server_name: server_name.to_string(),
                    method: "tools/list",
                    error,
                });
            }

            let result = response
                .result
                .ok_or_else(|| McpServerManagerError::InvalidResponse {
                    server_name: server_name.to_string(),
                    method: "tools/list",
                    details: "missing result payload".to_string(),
                })?;

            for tool in result.tools {
                let qualified_name = mcp_tool_name(server_name, &tool.name);
                self.tool_index.insert(
                    qualified_name.clone(),
                    ToolRoute {
                        server_name: server_name.to_string(),
                        raw_name: tool.name.clone(),
                    },
                );
                discovered_tools.push(ManagedMcpTool {
                    server_name: server_name.to_string(),
                    qualified_name,
                    raw_name: tool.name.clone(),
                    tool,
                });
            }

            match result.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }

        Ok(discovered_tools)
    }

    fn invalidate_server_process(
        &mut self,
        server_name: &str,
    ) -> Result<(), McpServerManagerError> {
        let server = self.server_mut(server_name)?;
        // `McpStdioProcess::request` has already terminated and reaped the
        // child on I/O failure. Dropping this stale wrapper lets the retry
        // spawn fresh stdin/stdout pipes even if `try_wait()` lagged behind.
        server.process = None;
        server.initialized = false;
        Ok(())
    }

    fn server_mut(
        &mut self,
        server_name: &str,
    ) -> Result<&mut ManagedMcpServer, McpServerManagerError> {
        self.servers
            .get_mut(server_name)
            .ok_or_else(|| McpServerManagerError::UnknownServer {
                server_name: server_name.to_string(),
            })
    }

    fn take_request_id(&mut self) -> JsonRpcId {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        JsonRpcId::Number(id)
    }

    async fn ensure_server_ready(
        &mut self,
        server_name: &str,
    ) -> Result<(), McpServerManagerError> {
        // v0.4.10 (M3 landmine fix): if a previous request left the
        // child dead — server crashed, was OOM-killed, or timed out
        // and we killed it ourselves in `McpStdioProcess::request` —
        // clear the slot so the spawn path below recreates it. Without
        // this we'd happily hand the next call to a dead pipe and the
        // user would see `BrokenPipe` errors instead of a transparent
        // respawn.
        if let Some(server) = self.servers.get_mut(server_name) {
            if let Some(process) = server.process.as_mut() {
                match process.try_wait() {
                    Ok(Some(_)) | Err(_) => {
                        server.process = None;
                        server.initialized = false;
                    }
                    Ok(None) => {}
                }
            }
        }

        let needs_spawn = self
            .servers
            .get(server_name)
            .map(|server| server.process.is_none())
            .ok_or_else(|| McpServerManagerError::UnknownServer {
                server_name: server_name.to_string(),
            })?;

        if needs_spawn {
            let server = self.server_mut(server_name)?;
            server.process = Some(spawn_mcp_stdio_process(&server.bootstrap)?);
            server.initialized = false;
        }

        let needs_initialize = self
            .servers
            .get(server_name)
            .map(|server| !server.initialized)
            .ok_or_else(|| McpServerManagerError::UnknownServer {
                server_name: server_name.to_string(),
            })?;

        if needs_initialize {
            let request_id = self.take_request_id();
            let response = {
                let server = self.server_mut(server_name)?;
                let process = server.process.as_mut().ok_or_else(|| {
                    McpServerManagerError::InvalidResponse {
                        server_name: server_name.to_string(),
                        method: "initialize",
                        details: "server process missing before initialize".to_string(),
                    }
                })?;
                process
                    .initialize(request_id, default_initialize_params())
                    .await?
            };

            if let Some(error) = response.error {
                return Err(McpServerManagerError::JsonRpc {
                    server_name: server_name.to_string(),
                    method: "initialize",
                    error,
                });
            }

            if response.result.is_none() {
                return Err(McpServerManagerError::InvalidResponse {
                    server_name: server_name.to_string(),
                    method: "initialize",
                    details: "missing result payload".to_string(),
                });
            }

            // Send the spec-mandated notifications/initialized notification
            // so the server knows the client is ready to receive tool calls.
            // Some servers (e.g. newer Codex) withhold tool routing until
            // they see it. Errors are ignored — the server will fail on the
            // next real request if it is down. (RW1 fix)
            {
                let server = self.server_mut(server_name)?;
                if let Some(process) = server.process.as_mut() {
                    let notification = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized"
                    });
                    let _ = process.write_jsonrpc_message(&notification).await;
                }
            }

            let server = self.server_mut(server_name)?;
            server.initialized = true;
        }

        Ok(())
    }
}

fn is_retryable_discovery_transport_error(error: &McpServerManagerError) -> bool {
    let McpServerManagerError::Io(error) = error else {
        return false;
    };
    matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe
    )
}

#[derive(Debug)]
pub struct McpStdioProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    framing: McpStdioFraming,
    _process_guard: Option<crate::ManagedProcessGuard>,
    /// v0.4.13 P1.D: per-server timeout override copied from the
    /// transport. `None` means fall through to
    /// `MCP_REQUEST_TIMEOUT_SECS` env / 300s default at request time.
    /// We store the raw `Option<u64>` rather than a `Duration` so the
    /// clamp + env-fallback logic stays centralised in
    /// `mcp_request_timeout`.
    request_timeout_override_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpStdioFraming {
    JsonLines,
    ContentLength,
}

impl McpStdioProcess {
    pub fn spawn(transport: &McpStdioTransport) -> io::Result<Self> {
        let runtime_handle = tokio::runtime::Handle::try_current()
            .map_err(|_| io::Error::other("stdio MCP process requires an active Tokio runtime"))?;
        let mut command = crate::hidden_tokio_command(&transport.command);
        command
            .args(&transport.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Desktop release builds use the Windows GUI subsystem and do not
            // own a console stderr handle. Inheriting that missing handle can
            // make Node-based MCP servers exit during process bootstrap, and
            // it also turns the useful child error into an unexplained stdout
            // EOF. Give every server a real pipe and drain it continuously.
            .stderr(Stdio::piped());
        apply_env(&mut command, &transport.env);
        if let Some(working_directory) = transport.env.get("SOMNIQ_MCP_WORKING_DIRECTORY") {
            let working_directory = std::path::PathBuf::from(working_directory);
            if !working_directory.is_absolute() || !working_directory.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "SOMNIQ_MCP_WORKING_DIRECTORY must name an existing absolute directory",
                ));
            }
            command.current_dir(working_directory);
        } else if let Some(workspace) = crate::execution_env_var_os("ARIS_WORKSPACE_ROOT") {
            let workspace = std::path::PathBuf::from(workspace);
            if !workspace.as_os_str().is_empty() {
                command.current_dir(workspace);
            }
        }
        crate::configure_managed_tokio_command(&mut command);

        let mut child = command.spawn()?;
        let process_guard = child.id().map(|pid| {
            crate::register_managed_process(
                pid,
                format!("mcp stdio: {}", transport.command),
                crate::ManagedProcessKind::Mcp,
            )
        });
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("stdio MCP process missing stdin pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("stdio MCP process missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("stdio MCP process missing stderr pipe"))?;
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        capture_stderr_tail(&runtime_handle, stderr, Arc::clone(&stderr_tail));

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_tail,
            framing: if transport
                .env
                .get("ARIS_MCP_STDIO_FRAMING")
                .is_some_and(|value| value.eq_ignore_ascii_case("content-length"))
            {
                McpStdioFraming::ContentLength
            } else {
                McpStdioFraming::JsonLines
            },
            _process_guard: process_guard,
            request_timeout_override_secs: transport.request_timeout_secs,
        })
    }

    pub async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.stdin.write_all(bytes).await
    }

    pub async fn flush(&mut self) -> io::Result<()> {
        self.stdin.flush().await
    }

    pub async fn write_line(&mut self, line: &str) -> io::Result<()> {
        self.write_all(line.as_bytes()).await?;
        self.write_all(b"\n").await?;
        self.flush().await
    }

    pub async fn read_line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        let bytes_read = self.stdout.read_line(&mut line).await?;
        if bytes_read == 0 {
            return Err(self
                .stream_closed_error("MCP stdio stream closed while reading line")
                .await);
        }
        Ok(line)
    }

    pub async fn read_available(&mut self) -> io::Result<Vec<u8>> {
        let mut buffer = vec![0_u8; 4096];
        let read = self.stdout.read(&mut buffer).await?;
        buffer.truncate(read);
        Ok(buffer)
    }

    pub async fn write_frame(&mut self, payload: &[u8]) -> io::Result<()> {
        let encoded = encode_frame(payload);
        self.write_all(&encoded).await?;
        self.flush().await
    }

    pub async fn read_frame(&mut self) -> io::Result<Vec<u8>> {
        self.read_content_length_frame_after_header(None).await
    }

    async fn read_content_length_frame_after_header(
        &mut self,
        first_line: Option<String>,
    ) -> io::Result<Vec<u8>> {
        let mut content_length = first_line
            .as_deref()
            .and_then(|line| line.strip_prefix("Content-Length:"))
            .map(str::trim)
            .map(str::parse::<usize>)
            .transpose()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        loop {
            let mut line = String::new();
            let bytes_read = self.stdout.read_line(&mut line).await?;
            if bytes_read == 0 {
                return Err(self
                    .stream_closed_error("MCP stdio stream closed while reading headers")
                    .await);
            }
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                let parsed = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                content_length = Some(parsed);
            }
        }

        let content_length = content_length.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
        })?;
        let mut payload = vec![0_u8; content_length];
        self.stdout.read_exact(&mut payload).await?;
        Ok(payload)
    }

    async fn read_jsonrpc_payload(&mut self) -> io::Result<Vec<u8>> {
        let mut line = String::new();
        let bytes_read = self.stdout.read_line(&mut line).await?;
        if bytes_read == 0 {
            return Err(self
                .stream_closed_error("MCP stdio stream closed while reading JSON-RPC message")
                .await);
        }
        if line.starts_with("Content-Length:") {
            return self
                .read_content_length_frame_after_header(Some(line))
                .await;
        }
        let payload = line.trim_end_matches(['\r', '\n']).as_bytes().to_vec();
        if payload.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP stdio server returned an empty line",
            ));
        }
        Ok(payload)
    }

    async fn stream_closed_error(&mut self, context: &str) -> io::Error {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => Some(status),
            Ok(None) | Err(_) => {
                tokio::time::timeout(std::time::Duration::from_millis(50), self.child.wait())
                    .await
                    .ok()
                    .and_then(Result::ok)
            }
        };
        // Let the independent stderr drain observe the pipe's final bytes
        // after the child exit becomes visible.
        tokio::task::yield_now().await;
        let stderr = self
            .stderr_tail
            .lock()
            .map(|tail| crate::decode_process_text(&tail).trim().to_string())
            .unwrap_or_default();
        let mut detail = context.to_string();
        if let Some(status) = status {
            detail.push_str(&format!(" (process exited with {status})"));
        }
        if !stderr.is_empty() {
            detail.push_str("; stderr: ");
            detail.push_str(&stderr);
        }
        io::Error::new(io::ErrorKind::UnexpectedEof, detail)
    }

    pub async fn write_jsonrpc_message<T: Serialize>(&mut self, message: &T) -> io::Result<()> {
        match self.framing {
            McpStdioFraming::JsonLines => {
                let body = serde_json::to_string(message)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                self.write_line(&body).await
            }
            McpStdioFraming::ContentLength => {
                let body = serde_json::to_vec(message)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                self.write_frame(&body).await
            }
        }
    }

    pub async fn read_jsonrpc_message<T: DeserializeOwned>(&mut self) -> io::Result<T> {
        let payload = self.read_jsonrpc_payload().await?;
        serde_json::from_slice(&payload)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub async fn send_request<T: Serialize>(
        &mut self,
        request: &JsonRpcRequest<T>,
    ) -> io::Result<()> {
        self.write_jsonrpc_message(request).await
    }

    pub async fn read_response<T: DeserializeOwned>(&mut self) -> io::Result<JsonRpcResponse<T>> {
        self.read_jsonrpc_message().await
    }

    /// Send a JSON-RPC request and wait for the matching response.
    ///
    /// v0.4.10 (M3 landmine fix): this used to forward straight to
    /// `read_response()` with no timeout and no correlation check. If
    /// the MCP server hung after `initialize`, `aris` would spin
    /// forever on the read (this was the #151 / #172 "Calling
    /// codex..." stall root cause). It also accepted whatever id the
    /// server emitted, so a buggy/stale response could be returned for
    /// a different in-flight call.
    ///
    /// Behaviour now (post-codex-review):
    /// * The entire send+read round trip is wrapped in
    ///   `tokio::time::timeout`. Default 300s (5 min, covers agent-style
    ///   MCP servers like codex), override via `MCP_REQUEST_TIMEOUT_SECS`
    ///   env (clamped 1..=1800). Wrapping both halves means a server
    ///   that blocks on stdin (write-side hang because the pipe buffer
    ///   fills) also unblocks the caller.
    /// * After a successful read, the response id must equal the
    ///   request id.
    /// * A process-wide interrupt immediately kills the child and returns
    ///   `Interrupted`, so a hung tool call cannot pin the conversation.
    /// * On *any* failure mode (timeout, I/O error during
    ///   send/read, id mismatch) we `kill().await` the child so the
    ///   stdio pipes are flushed and the next call respawns from a
    ///   clean state. `kill().await` (vs `start_kill()`) reaps the
    ///   process — avoiding a zombie window where the manager's
    ///   `try_wait()` could still see `Ok(None)` and reuse a poisoned
    ///   pipe.
    pub async fn request<TParams: Serialize, TResult: DeserializeOwned>(
        &mut self,
        id: JsonRpcId,
        method: impl Into<String>,
        params: Option<TParams>,
    ) -> io::Result<JsonRpcResponse<TResult>> {
        let request = JsonRpcRequest::new(id.clone(), method, params);
        let timeout = mcp_request_timeout(self.request_timeout_override_secs);

        // Wrap send + (read-until-response) together so a write-side
        // block (e.g. server alive but not reading stdin, pipe buffer
        // full on a large request body) also trips the deadline, and
        // so the deadline still bounds a stream of notifications that
        // would otherwise keep the read loop alive indefinitely
        // (v0.4.13 known-limitation fix).
        //
        // v0.4.13: the read side is now a loop. JSON-RPC servers may
        // emit notification frames (no `id`, or `id == null`) such as
        // `notifications/log` and `notifications/progress` while a
        // request is in flight. The pre-v0.4.13 behaviour was to
        // deserialize the first frame directly into
        // `JsonRpcResponse<TResult>`, which made the call fail
        // (`id` is mandatory on `JsonRpcResponse`) and we'd kill the
        // child — root cause of the codex MCP "spurious failures"
        // known limitation tracked in #151 / #172. We now read a
        // generic `serde_json::Value` first, skip any frame whose
        // `id` is missing or null (logging to stderr so the user can
        // still observe the notification), and only deserialize once
        // a frame with `id == request.id` arrives. An id mismatch on
        // a *response* frame remains fatal, exactly as before.
        let send_then_read = async {
            self.send_request(&request).await?;
            loop {
                let payload = self.read_jsonrpc_payload().await?;
                let value: JsonValue = serde_json::from_slice(&payload)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                let frame_id = value.as_object().and_then(|object| object.get("id"));
                match frame_id {
                    None | Some(JsonValue::Null) => {
                        // Notification — no id at all, or explicit null.
                        // Servers like Codex emit dozens-to-hundreds of
                        // notifications per call; logging every one floods
                        // stderr. Only log when ARIS_MCP_STDERR is set
                        // (BUG A fix: gate behind debug flag).
                        if std::env::var_os("ARIS_MCP_STDERR").is_some() {
                            let method = value
                                .as_object()
                                .and_then(|object| object.get("method"))
                                .and_then(JsonValue::as_str)
                                .unwrap_or("?");
                            eprintln!("aris mcp: notification skipped: method={method}");
                        }
                        continue;
                    }
                    Some(_) => {
                        let response: JsonRpcResponse<TResult> = serde_json::from_value(value)
                            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                        return Ok::<JsonRpcResponse<TResult>, io::Error>(response);
                    }
                }
            }
        };

        let request_result = tokio::select! {
            response = tokio::time::timeout(timeout, send_then_read) => Some(response),
            () = wait_for_interrupt() => None,
        };

        let response: JsonRpcResponse<TResult> = match request_result {
            None => {
                // Keep the global flag set so the conversation loop unwinds
                // instead of treating cancellation as an ordinary tool error.
                let _ = self.terminate().await;
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "MCP request interrupted by user",
                ));
            }
            Some(Ok(Ok(response))) => response,
            Some(Ok(Err(error))) => {
                // I/O error during send or read. Stdio buffer is now
                // ambiguous — kill so the next call respawns cleanly.
                let _ = self.terminate().await;
                return Err(error);
            }
            Some(Err(_elapsed)) => {
                let _ = self.terminate().await;
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "MCP server did not respond within {}s (override via per-server requestTimeoutSecs or MCP_REQUEST_TIMEOUT_SECS env, max 1800s)",
                        timeout.as_secs()
                    ),
                ));
            }
        };

        if response.id != id {
            // Correlation mismatch: server is desynced or buggy. Treat
            // as fatal for this connection so we respawn cleanly.
            let _ = self.terminate().await;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "MCP response id mismatch: expected {:?}, got {:?}",
                    id, response.id
                ),
            ));
        }
        Ok(response)
    }

    /// Non-blocking liveness peek — `Ok(None)` means the child is still
    /// running, `Ok(Some(_))` means it has exited, `Err` means we
    /// couldn't poll. Used by `McpServerManager::ensure_server_ready`
    /// to detect crashed servers and respawn them transparently.
    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub async fn initialize(
        &mut self,
        id: JsonRpcId,
        params: McpInitializeParams,
    ) -> io::Result<JsonRpcResponse<McpInitializeResult>> {
        self.request(id, "initialize", Some(params)).await
    }

    pub async fn list_tools(
        &mut self,
        id: JsonRpcId,
        params: Option<McpListToolsParams>,
    ) -> io::Result<JsonRpcResponse<McpListToolsResult>> {
        self.request(id, "tools/list", params).await
    }

    pub async fn call_tool(
        &mut self,
        id: JsonRpcId,
        params: McpToolCallParams,
    ) -> io::Result<JsonRpcResponse<McpToolCallResult>> {
        self.request(id, "tools/call", Some(params)).await
    }

    pub async fn list_resources(
        &mut self,
        id: JsonRpcId,
        params: Option<McpListResourcesParams>,
    ) -> io::Result<JsonRpcResponse<McpListResourcesResult>> {
        self.request(id, "resources/list", params).await
    }

    pub async fn read_resource(
        &mut self,
        id: JsonRpcId,
        params: McpReadResourceParams,
    ) -> io::Result<JsonRpcResponse<McpReadResourceResult>> {
        self.request(id, "resources/read", Some(params)).await
    }

    pub async fn terminate(&mut self) -> io::Result<()> {
        // For stdio MCP servers, closing stdin is the safest shutdown signal:
        // well-behaved servers exit their read loop on EOF. Avoid sending a
        // negative-pid process-group signal here; hosted Linux runners have
        // cancelled the entire job when this test path tears down quickly.
        let _ = self.stdin.shutdown().await;
        if let Ok(Some(_)) = self.child.try_wait() {
            return Ok(());
        }
        match self.child.kill().await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    async fn shutdown(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_none() {
            self.terminate().await?;
        }
        let _ = self.child.wait().await?;
        Ok(())
    }
}

async fn wait_for_interrupt() {
    wait_for_interrupt_flag(&crate::INTERRUPTED).await;
}

async fn wait_for_interrupt_flag(flag: &std::sync::atomic::AtomicBool) {
    loop {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

pub fn spawn_mcp_stdio_process(bootstrap: &McpClientBootstrap) -> io::Result<McpStdioProcess> {
    match &bootstrap.transport {
        McpClientTransport::Stdio(transport) => McpStdioProcess::spawn(transport),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "MCP bootstrap transport for {} is not stdio: {other:?}",
                bootstrap.server_name
            ),
        )),
    }
}

fn apply_env(command: &mut Command, env: &BTreeMap<String, String>) {
    for (key, value) in env {
        if key == "SOMNIQ_MCP_WORKING_DIRECTORY" {
            continue;
        }
        command.env(key, value);
    }
}

const MCP_STDERR_TAIL_BYTES: usize = 16 * 1024;

fn capture_stderr_tail(
    runtime_handle: &tokio::runtime::Handle,
    mut stderr: ChildStderr,
    tail: Arc<Mutex<Vec<u8>>>,
) {
    runtime_handle.spawn(async move {
        let mut chunk = [0_u8; 4 * 1024];
        loop {
            let read = match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let Ok(mut captured) = tail.lock() else {
                break;
            };
            if read >= MCP_STDERR_TAIL_BYTES {
                captured.clear();
                captured.extend_from_slice(&chunk[read - MCP_STDERR_TAIL_BYTES..read]);
                continue;
            }
            let overflow = captured
                .len()
                .saturating_add(read)
                .saturating_sub(MCP_STDERR_TAIL_BYTES);
            if overflow > 0 {
                captured.drain(..overflow);
            }
            captured.extend_from_slice(&chunk[..read]);
        }
    });
}

fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    let mut framed = header.into_bytes();
    framed.extend_from_slice(payload);
    framed
}

/// Resolve the MCP request read timeout. Priority is:
///   1. per-server `override_secs` (from
///      `McpStdioServerConfig.request_timeout_secs` — v0.4.13 P1.D),
///   2. global `MCP_REQUEST_TIMEOUT_SECS` env (set process-wide),
///   3. 300s default.
///
/// Every layer is clamped to 1..=1800s so a bogus value can't disable
/// the timeout entirely or make it absurdly long.
///
/// Rationale for the 5-minute default: the most common MCP servers
/// users wire into `aris` are agent-style (codex, oracle, claude). A
/// single tool call there routinely takes 60-180s of model think time
/// before the first response byte. The earlier 60s default would have
/// killed those mid-call. 300s comfortably covers the p95 of observed
/// agent tool calls while still bounding a runaway server.
///
/// Rationale for the per-server override: when a user wires both a
/// fast MCP (e.g. filesystem) and a slow agent MCP (codex) into the
/// same session, a single env-level setting trades off responsiveness
/// on one for safety on the other. Per-server lets each pick the
/// right ceiling without affecting the others.
fn mcp_request_timeout(override_secs: Option<u64>) -> std::time::Duration {
    let env_value = std::env::var("MCP_REQUEST_TIMEOUT_SECS").ok();
    mcp_request_timeout_from_env_value(override_secs, env_value.as_deref())
}

/// Resolve the timeout from an optional per-server override and a supplied
/// environment value. Keeping the precedence and parsing logic pure makes it
/// possible to test without mutating the process environment.
fn mcp_request_timeout_from_env_value(
    override_secs: Option<u64>,
    env_value: Option<&str>,
) -> std::time::Duration {
    const DEFAULT_SECS: u64 = 300;
    const MIN_SECS: u64 = 1;
    const MAX_SECS: u64 = 1800;

    if let Some(secs) = override_secs {
        return std::time::Duration::from_secs(secs.clamp(MIN_SECS, MAX_SECS));
    }
    let secs = env_value
        .and_then(|value| value.parse::<u64>().ok())
        .map(|n| n.clamp(MIN_SECS, MAX_SECS))
        .unwrap_or(DEFAULT_SECS);
    std::time::Duration::from_secs(secs)
}

fn default_initialize_params() -> McpInitializeParams {
    McpInitializeParams {
        protocol_version: "2025-03-26".to_string(),
        capabilities: JsonValue::Object(serde_json::Map::new()),
        client_info: McpInitializeClientInfo {
            name: "runtime".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    }
}

#[cfg(test)]
#[path = "tests/mcp_stdio.rs"]
mod tests;

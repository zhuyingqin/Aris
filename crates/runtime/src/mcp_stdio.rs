use std::collections::BTreeMap;
use std::io;
use std::process::Stdio;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

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
        let server_names = self.servers.keys().cloned().collect::<Vec<_>>();
        let mut discovered_tools = Vec::new();
        let mut failures = Vec::new();

        for server_name in server_names {
            match self.discover_server_tools(&server_name).await {
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

    async fn discover_server_tools(
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

#[derive(Debug)]
pub struct McpStdioProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    framing: McpStdioFraming,
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
        let mut command = crate::hidden_tokio_command(&transport.command);
        command
            .args(&transport.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        apply_env(&mut command, &transport.env);

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("stdio MCP process missing stdin pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("stdio MCP process missing stdout pipe"))?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            framing: if transport
                .env
                .get("ARIS_MCP_STDIO_FRAMING")
                .is_some_and(|value| value.eq_ignore_ascii_case("content-length"))
            {
                McpStdioFraming::ContentLength
            } else {
                McpStdioFraming::JsonLines
            },
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
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "MCP stdio stream closed while reading line",
            ));
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
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "MCP stdio stream closed while reading headers",
                ));
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
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "MCP stdio stream closed while reading JSON-RPC message",
            ));
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
                let _ = self.child.kill().await;
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "MCP request interrupted by user",
                ));
            }
            Some(Ok(Ok(response))) => response,
            Some(Ok(Err(error))) => {
                // I/O error during send or read. Stdio buffer is now
                // ambiguous — kill so the next call respawns cleanly.
                let _ = self.child.kill().await;
                return Err(error);
            }
            Some(Err(_elapsed)) => {
                let _ = self.child.kill().await;
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
            let _ = self.child.kill().await;
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
        self.child.kill().await
    }

    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    async fn shutdown(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill().await?;
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
        command.env(key, value);
    }
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
    const DEFAULT_SECS: u64 = 300;
    const MIN_SECS: u64 = 1;
    const MAX_SECS: u64 = 1800;

    if let Some(secs) = override_secs {
        return std::time::Duration::from_secs(secs.clamp(MIN_SECS, MAX_SECS));
    }
    let secs = std::env::var("MCP_REQUEST_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
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
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::ErrorKind;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;
    use tokio::runtime::Builder;

    use crate::config::{
        ConfigSource, McpRemoteServerConfig, McpSdkServerConfig, McpServerConfig,
        McpStdioServerConfig, McpWebSocketServerConfig, ScopedMcpServerConfig,
    };
    use crate::mcp::mcp_tool_name;
    use crate::mcp_client::McpClientBootstrap;

    use super::{
        mcp_request_timeout, spawn_mcp_stdio_process, wait_for_interrupt_flag, JsonRpcId,
        JsonRpcRequest, JsonRpcResponse, McpInitializeClientInfo, McpInitializeParams,
        McpInitializeResult, McpInitializeServerInfo, McpListToolsResult, McpReadResourceParams,
        McpReadResourceResult, McpServerManager, McpServerManagerError, McpStdioProcess, McpTool,
        McpToolCallParams,
    };

    fn temp_dir() -> PathBuf {
        static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "runtime-mcp-stdio-{}-{nanos}-{sequence}",
            std::process::id()
        ))
    }

    fn make_executable(script_path: &Path) {
        #[cfg(not(unix))]
        let _ = script_path;

        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(script_path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(script_path, permissions).expect("chmod");
        }
    }

    fn write_echo_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("echo-mcp.py");
        fs::write(
            &script_path,
            "import os, sys\nready = f\"READY:{os.environ.get('MCP_TEST_TOKEN', '')}\\n\".encode()\nsys.stdout.buffer.write(ready)\nsys.stdout.buffer.flush()\nline = sys.stdin.buffer.readline().rstrip(b'\\r\\n').decode()\nsys.stdout.buffer.write(f\"ECHO:{line}\\n\".encode())\nsys.stdout.buffer.flush()\n",
        )
        .expect("write script");
        make_executable(&script_path);
        script_path
    }

    fn write_jsonrpc_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("jsonrpc-mcp.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, sys",
            "request = json.loads(sys.stdin.buffer.readline().decode())",
            r"assert request['jsonrpc'] == '2.0'",
            r"assert request['method'] == 'initialize'",
            r"response = json.dumps({",
            r"    'jsonrpc': '2.0',",
            r"    'id': request['id'],",
            r"    'result': {",
            r"        'protocolVersion': request['params']['protocolVersion'],",
            r"        'capabilities': {'tools': {}},",
            r"        'serverInfo': {'name': 'fake-mcp', 'version': '0.1.0'}",
            r"    }",
            r"})",
            r"sys.stdout.write(response + '\n')",
            "sys.stdout.buffer.flush()",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    #[allow(clippy::too_many_lines)]
    fn write_mcp_server_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("fake-mcp-server.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, sys",
            "",
            "def read_message():",
            "    header = b''",
            r"    while not header.endswith(b'\r\n\r\n'):",
            "        chunk = sys.stdin.buffer.read(1)",
            "        if not chunk:",
            "            return None",
            "        header += chunk",
            "    length = 0",
            r"    for line in header.decode().split('\r\n'):",
            r"        if line.lower().startswith('content-length:'):",
            r"            length = int(line.split(':', 1)[1].strip())",
            "    payload = sys.stdin.buffer.read(length)",
            "    return json.loads(payload.decode())",
            "",
            "def send_message(message):",
            "    payload = json.dumps(message).encode()",
            r"    sys.stdout.buffer.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload)",
            "    sys.stdout.buffer.flush()",
            "",
            "while True:",
            "    request = read_message()",
            "    if request is None:",
            "        break",
            "    if 'id' not in request:",
            "        continue  # notifications have no id — skip silently",
            "    method = request['method']",
            "    if method == 'initialize':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'protocolVersion': request['params']['protocolVersion'],",
            "                'capabilities': {'tools': {}, 'resources': {}},",
            "                'serverInfo': {'name': 'fake-mcp', 'version': '0.2.0'}",
            "            }",
            "        })",
            "    elif method == 'tools/list':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'tools': [",
            "                    {",
            "                        'name': 'echo',",
            "                        'description': 'Echoes text',",
            "                        'inputSchema': {",
            "                            'type': 'object',",
            "                            'properties': {'text': {'type': 'string'}},",
            "                            'required': ['text']",
            "                        }",
            "                    }",
            "                ]",
            "            }",
            "        })",
            "    elif method == 'tools/call':",
            "        args = request['params'].get('arguments') or {}",
            "        if request['params']['name'] == 'fail':",
            "            send_message({",
            "                'jsonrpc': '2.0',",
            "                'id': request['id'],",
            "                'error': {'code': -32001, 'message': 'tool failed'},",
            "            })",
            "        else:",
            "            text = args.get('text', '')",
            "            send_message({",
            "                'jsonrpc': '2.0',",
            "                'id': request['id'],",
            "                'result': {",
            "                    'content': [{'type': 'text', 'text': f'echo:{text}'}],",
            "                    'structuredContent': {'echoed': text},",
            "                    'isError': False",
            "                }",
            "            })",
            "    elif method == 'resources/list':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'resources': [",
            "                    {",
            "                        'uri': 'file://guide.txt',",
            "                        'name': 'guide',",
            "                        'description': 'Guide text',",
            "                        'mimeType': 'text/plain'",
            "                    }",
            "                ]",
            "            }",
            "        })",
            "    elif method == 'resources/read':",
            "        uri = request['params']['uri']",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'contents': [",
            "                    {",
            "                        'uri': uri,",
            "                        'mimeType': 'text/plain',",
            "                        'text': f'contents for {uri}'",
            "                    }",
            "                ]",
            "            }",
            "        })",
            "    else:",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'error': {'code': -32601, 'message': f'unknown method: {method}'},",
            "        })",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    #[allow(clippy::too_many_lines)]
    fn write_manager_mcp_server_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("manager-mcp-server.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, os, sys",
            "",
            "LABEL = os.environ.get('MCP_SERVER_LABEL', 'server')",
            "LOG_PATH = os.environ.get('MCP_LOG_PATH')",
            "initialize_count = 0",
            "",
            "def log(method):",
            "    if LOG_PATH:",
            "        with open(LOG_PATH, 'a', encoding='utf-8') as handle:",
            "            handle.write(f'{method}\\n')",
            "",
            "def read_message():",
            "    header = b''",
            r"    while not header.endswith(b'\r\n\r\n'):",
            "        chunk = sys.stdin.buffer.read(1)",
            "        if not chunk:",
            "            return None",
            "        header += chunk",
            "    length = 0",
            r"    for line in header.decode().split('\r\n'):",
            r"        if line.lower().startswith('content-length:'):",
            r"            length = int(line.split(':', 1)[1].strip())",
            "    payload = sys.stdin.buffer.read(length)",
            "    return json.loads(payload.decode())",
            "",
            "def send_message(message):",
            "    payload = json.dumps(message).encode()",
            r"    sys.stdout.buffer.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload)",
            "    sys.stdout.buffer.flush()",
            "",
            "while True:",
            "    request = read_message()",
            "    if request is None:",
            "        break",
            "    if 'id' not in request:",
            "        continue  # notifications have no id — skip silently",
            "    method = request['method']",
            "    log(method)",
            "    if method == 'initialize':",
            "        initialize_count += 1",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'protocolVersion': request['params']['protocolVersion'],",
            "                'capabilities': {'tools': {}},",
            "                'serverInfo': {'name': LABEL, 'version': '1.0.0'}",
            "            }",
            "        })",
            "    elif method == 'tools/list':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'tools': [",
            "                    {",
            "                        'name': 'echo',",
            "                        'description': f'Echo tool for {LABEL}',",
            "                        'inputSchema': {",
            "                            'type': 'object',",
            "                            'properties': {'text': {'type': 'string'}},",
            "                            'required': ['text']",
            "                        }",
            "                    }",
            "                ]",
            "            }",
            "        })",
            "    elif method == 'tools/call':",
            "        args = request['params'].get('arguments') or {}",
            "        text = args.get('text', '')",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'content': [{'type': 'text', 'text': f'{LABEL}:{text}'}],",
            "                'structuredContent': {",
            "                    'server': LABEL,",
            "                    'echoed': text,",
            "                    'initializeCount': initialize_count",
            "                },",
            "                'isError': False",
            "            }",
            "        })",
            "    else:",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'error': {'code': -32601, 'message': f'unknown method: {method}'},",
            "        })",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    fn sample_bootstrap(script_path: &Path) -> McpClientBootstrap {
        let config = ScopedMcpServerConfig {
            scope: ConfigSource::Local,
            config: McpServerConfig::Stdio(McpStdioServerConfig {
                command: python_command().to_string(),
                args: vec![script_path.to_string_lossy().into_owned()],
                env: BTreeMap::from([("MCP_TEST_TOKEN".to_string(), "secret-value".to_string())]),
                request_timeout_secs: None,
            }),
        };
        McpClientBootstrap::from_scoped_config("stdio server", &config)
    }

    fn script_transport(script_path: &Path) -> crate::mcp_client::McpStdioTransport {
        crate::mcp_client::McpStdioTransport {
            command: python_command().to_string(),
            args: vec![script_path.to_string_lossy().into_owned()],
            env: BTreeMap::from([(
                "ARIS_MCP_STDIO_FRAMING".to_string(),
                "content-length".to_string(),
            )]),
            request_timeout_secs: None,
        }
    }

    fn standard_script_transport(script_path: &Path) -> crate::mcp_client::McpStdioTransport {
        crate::mcp_client::McpStdioTransport {
            command: python_command().to_string(),
            args: vec![script_path.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            request_timeout_secs: None,
        }
    }

    fn python_command() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "python3"
        }
    }

    fn cleanup_script(script_path: &Path) {
        fs::remove_file(script_path).expect("cleanup script");
        fs::remove_dir_all(script_path.parent().expect("script parent")).expect("cleanup dir");
    }

    fn manager_server_config(
        script_path: &Path,
        label: &str,
        log_path: &Path,
    ) -> ScopedMcpServerConfig {
        ScopedMcpServerConfig {
            scope: ConfigSource::Local,
            config: McpServerConfig::Stdio(McpStdioServerConfig {
                command: python_command().to_string(),
                args: vec![script_path.to_string_lossy().into_owned()],
                env: BTreeMap::from([
                    (
                        "ARIS_MCP_STDIO_FRAMING".to_string(),
                        "content-length".to_string(),
                    ),
                    ("MCP_SERVER_LABEL".to_string(), label.to_string()),
                    (
                        "MCP_LOG_PATH".to_string(),
                        log_path.to_string_lossy().into_owned(),
                    ),
                ]),
                request_timeout_secs: None,
            }),
        }
    }

    #[test]
    fn spawns_stdio_process_and_round_trips_io() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_echo_script();
            let bootstrap = sample_bootstrap(&script_path);
            let mut process = spawn_mcp_stdio_process(&bootstrap).expect("spawn stdio process");

            let ready = process.read_line().await.expect("read ready");
            assert_eq!(ready, "READY:secret-value\n");

            process
                .write_line("ping from client")
                .await
                .expect("write line");

            let echoed = process.read_line().await.expect("read echo");
            assert_eq!(echoed, "ECHO:ping from client\n");

            let status = process.wait().await.expect("wait for exit");
            assert!(status.success());

            cleanup_script(&script_path);
        });
    }

    #[test]
    fn rejects_non_stdio_bootstrap() {
        let config = ScopedMcpServerConfig {
            scope: ConfigSource::Local,
            config: McpServerConfig::Sdk(crate::config::McpSdkServerConfig {
                name: "sdk-server".to_string(),
            }),
        };
        let bootstrap = McpClientBootstrap::from_scoped_config("sdk server", &config);
        let error = spawn_mcp_stdio_process(&bootstrap).expect_err("non-stdio should fail");
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn round_trips_initialize_request_and_response_over_standard_json_lines() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_jsonrpc_script();
            let transport = standard_script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn transport directly");

            let response = process
                .initialize(
                    JsonRpcId::Number(1),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({"roots": {}}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect("initialize roundtrip");

            assert_eq!(response.id, JsonRpcId::Number(1));
            assert_eq!(response.error, None);
            assert_eq!(
                response.result,
                Some(McpInitializeResult {
                    protocol_version: "2025-03-26".to_string(),
                    capabilities: json!({"tools": {}}),
                    server_info: McpInitializeServerInfo {
                        name: "fake-mcp".to_string(),
                        version: "0.1.0".to_string(),
                    },
                })
            );

            let status = process.wait().await.expect("wait for exit");
            assert!(status.success());

            cleanup_script(&script_path);
        });
    }

    #[test]
    fn write_jsonrpc_request_emits_standard_json_line() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_jsonrpc_script();
            let transport = standard_script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn transport directly");
            let request = JsonRpcRequest::new(
                JsonRpcId::Number(7),
                "initialize",
                Some(json!({
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "runtime-tests", "version": "0.1.0"}
                })),
            );

            process.send_request(&request).await.expect("send request");
            let response: JsonRpcResponse<serde_json::Value> =
                process.read_response().await.expect("read response");

            assert_eq!(response.id, JsonRpcId::Number(7));
            assert_eq!(response.jsonrpc, "2.0");

            let status = process.wait().await.expect("wait for exit");
            assert!(status.success());

            cleanup_script(&script_path);
        });
    }

    #[test]
    fn direct_spawn_uses_transport_env() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_echo_script();
            let transport = crate::mcp_client::McpStdioTransport {
                command: python_command().to_string(),
                args: vec![script_path.to_string_lossy().into_owned()],
                env: BTreeMap::from([("MCP_TEST_TOKEN".to_string(), "direct-secret".to_string())]),
                request_timeout_secs: None,
            };
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn transport directly");
            let ready = process.read_available().await.expect("read ready");
            assert_eq!(String::from_utf8_lossy(&ready), "READY:direct-secret\n");
            process.terminate().await.expect("terminate child");
            let _ = process.wait().await.expect("wait after kill");

            cleanup_script(&script_path);
        });
    }

    #[test]
    fn lists_tools_calls_tool_and_reads_resources_over_jsonrpc() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_mcp_server_script();
            let transport = script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn fake mcp server");

            let tools = process
                .list_tools(JsonRpcId::Number(2), None)
                .await
                .expect("list tools");
            assert_eq!(tools.error, None);
            assert_eq!(tools.id, JsonRpcId::Number(2));
            assert_eq!(
                tools.result,
                Some(McpListToolsResult {
                    tools: vec![McpTool {
                        name: "echo".to_string(),
                        description: Some("Echoes text".to_string()),
                        input_schema: Some(json!({
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                            "required": ["text"]
                        })),
                        annotations: None,
                        meta: None,
                    }],
                    next_cursor: None,
                })
            );

            let call = process
                .call_tool(
                    JsonRpcId::String("call-1".to_string()),
                    McpToolCallParams {
                        name: "echo".to_string(),
                        arguments: Some(json!({"text": "hello"})),
                        meta: None,
                    },
                )
                .await
                .expect("call tool");
            assert_eq!(call.error, None);
            let call_result = call.result.expect("tool result");
            assert_eq!(call_result.is_error, Some(false));
            assert_eq!(
                call_result.structured_content,
                Some(json!({"echoed": "hello"}))
            );
            assert_eq!(call_result.content.len(), 1);
            assert_eq!(call_result.content[0].kind, "text");
            assert_eq!(
                call_result.content[0].data.get("text"),
                Some(&json!("echo:hello"))
            );

            let resources = process
                .list_resources(JsonRpcId::Number(3), None)
                .await
                .expect("list resources");
            let resources_result = resources.result.expect("resources result");
            assert_eq!(resources_result.resources.len(), 1);
            assert_eq!(resources_result.resources[0].uri, "file://guide.txt");
            assert_eq!(
                resources_result.resources[0].mime_type.as_deref(),
                Some("text/plain")
            );

            let read = process
                .read_resource(
                    JsonRpcId::Number(4),
                    McpReadResourceParams {
                        uri: "file://guide.txt".to_string(),
                    },
                )
                .await
                .expect("read resource");
            assert_eq!(
                read.result,
                Some(McpReadResourceResult {
                    contents: vec![super::McpResourceContents {
                        uri: "file://guide.txt".to_string(),
                        mime_type: Some("text/plain".to_string()),
                        text: Some("contents for file://guide.txt".to_string()),
                        blob: None,
                        meta: None,
                    }],
                })
            );

            process.terminate().await.expect("terminate child");
            let _ = process.wait().await.expect("wait after kill");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn surfaces_jsonrpc_errors_from_tool_calls() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_mcp_server_script();
            let transport = script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn fake mcp server");

            let response = process
                .call_tool(
                    JsonRpcId::Number(9),
                    McpToolCallParams {
                        name: "fail".to_string(),
                        arguments: None,
                        meta: None,
                    },
                )
                .await
                .expect("call tool with error response");

            assert_eq!(response.id, JsonRpcId::Number(9));
            assert!(response.result.is_none());
            assert_eq!(response.error.as_ref().map(|e| e.code), Some(-32001));
            assert_eq!(
                response.error.as_ref().map(|e| e.message.as_str()),
                Some("tool failed")
            );

            process.terminate().await.expect("terminate child");
            let _ = process.wait().await.expect("wait after kill");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn manager_discovers_tools_from_stdio_config() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("alpha.log");
            let servers = BTreeMap::from([(
                "alpha".to_string(),
                manager_server_config(&script_path, "alpha", &log_path),
            )]);
            let mut manager = McpServerManager::from_servers(&servers);

            let tools = manager.discover_tools().await.expect("discover tools");

            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0].server_name, "alpha");
            assert_eq!(tools[0].raw_name, "echo");
            assert_eq!(tools[0].qualified_name, mcp_tool_name("alpha", "echo"));
            assert_eq!(tools[0].tool.name, "echo");
            assert!(manager.unsupported_servers().is_empty());

            manager.shutdown().await.expect("shutdown");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn resilient_discovery_keeps_healthy_servers() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("healthy.log");
            let servers = BTreeMap::from([
                (
                    "broken".to_string(),
                    ScopedMcpServerConfig {
                        scope: ConfigSource::Local,
                        config: McpServerConfig::Stdio(McpStdioServerConfig {
                            command: "__aris_missing_mcp_command__".to_string(),
                            args: Vec::new(),
                            env: BTreeMap::new(),
                            request_timeout_secs: Some(1),
                        }),
                    },
                ),
                (
                    "healthy".to_string(),
                    manager_server_config(&script_path, "healthy", &log_path),
                ),
            ]);
            let mut manager = McpServerManager::from_servers(&servers);

            let (tools, failures) = manager.discover_tools_resilient().await;

            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0].server_name, "healthy");
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].0, "broken");

            manager.shutdown().await.expect("shutdown");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn manager_routes_tool_calls_to_correct_server() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let alpha_log = root.join("alpha.log");
            let beta_log = root.join("beta.log");
            let servers = BTreeMap::from([
                (
                    "alpha".to_string(),
                    manager_server_config(&script_path, "alpha", &alpha_log),
                ),
                (
                    "beta".to_string(),
                    manager_server_config(&script_path, "beta", &beta_log),
                ),
            ]);
            let mut manager = McpServerManager::from_servers(&servers);

            let tools = manager.discover_tools().await.expect("discover tools");
            assert_eq!(tools.len(), 2);

            let alpha = manager
                .call_tool(
                    &mcp_tool_name("alpha", "echo"),
                    Some(json!({"text": "hello"})),
                )
                .await
                .expect("call alpha tool");
            let beta = manager
                .call_tool(
                    &mcp_tool_name("beta", "echo"),
                    Some(json!({"text": "world"})),
                )
                .await
                .expect("call beta tool");

            assert_eq!(
                alpha
                    .result
                    .as_ref()
                    .and_then(|result| result.structured_content.as_ref())
                    .and_then(|value| value.get("server")),
                Some(&json!("alpha"))
            );
            assert_eq!(
                beta.result
                    .as_ref()
                    .and_then(|result| result.structured_content.as_ref())
                    .and_then(|value| value.get("server")),
                Some(&json!("beta"))
            );

            manager.shutdown().await.expect("shutdown");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn manager_records_unsupported_non_stdio_servers_without_panicking() {
        let servers = BTreeMap::from([
            (
                "http".to_string(),
                ScopedMcpServerConfig {
                    scope: ConfigSource::Local,
                    config: McpServerConfig::Http(McpRemoteServerConfig {
                        url: "https://example.test/mcp".to_string(),
                        headers: BTreeMap::new(),
                        headers_helper: None,
                        oauth: None,
                    }),
                },
            ),
            (
                "sdk".to_string(),
                ScopedMcpServerConfig {
                    scope: ConfigSource::Local,
                    config: McpServerConfig::Sdk(McpSdkServerConfig {
                        name: "sdk-server".to_string(),
                    }),
                },
            ),
            (
                "ws".to_string(),
                ScopedMcpServerConfig {
                    scope: ConfigSource::Local,
                    config: McpServerConfig::Ws(McpWebSocketServerConfig {
                        url: "wss://example.test/mcp".to_string(),
                        headers: BTreeMap::new(),
                        headers_helper: None,
                    }),
                },
            ),
        ]);

        let manager = McpServerManager::from_servers(&servers);
        let unsupported = manager.unsupported_servers();

        assert_eq!(unsupported.len(), 3);
        assert_eq!(unsupported[0].server_name, "http");
        assert_eq!(unsupported[1].server_name, "sdk");
        assert_eq!(unsupported[2].server_name, "ws");
    }

    #[test]
    fn manager_shutdown_terminates_spawned_children_and_is_idempotent() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("alpha.log");
            let servers = BTreeMap::from([(
                "alpha".to_string(),
                manager_server_config(&script_path, "alpha", &log_path),
            )]);
            let mut manager = McpServerManager::from_servers(&servers);

            manager.discover_tools().await.expect("discover tools");
            manager.shutdown().await.expect("first shutdown");
            manager.shutdown().await.expect("second shutdown");

            cleanup_script(&script_path);
        });
    }

    #[test]
    fn manager_reuses_spawned_server_between_discovery_and_call() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("alpha.log");
            let servers = BTreeMap::from([(
                "alpha".to_string(),
                manager_server_config(&script_path, "alpha", &log_path),
            )]);
            let mut manager = McpServerManager::from_servers(&servers);

            manager.discover_tools().await.expect("discover tools");
            let response = manager
                .call_tool(
                    &mcp_tool_name("alpha", "echo"),
                    Some(json!({"text": "reuse"})),
                )
                .await
                .expect("call tool");

            assert_eq!(
                response
                    .result
                    .as_ref()
                    .and_then(|result| result.structured_content.as_ref())
                    .and_then(|value| value.get("initializeCount")),
                Some(&json!(1))
            );

            let log = fs::read_to_string(&log_path).expect("read log");
            assert_eq!(log.lines().filter(|line| *line == "initialize").count(), 1);
            assert_eq!(
                log.lines().collect::<Vec<_>>(),
                vec!["initialize", "tools/list", "tools/call"]
            );

            manager.shutdown().await.expect("shutdown");
            cleanup_script(&script_path);
        });
    }

    // ============================================================
    // v0.4.10 (M3 landmine fix) — regression coverage for
    //   • response.id ↔ request.id correlation
    //   • read timeout via MCP_REQUEST_TIMEOUT_SECS
    //   • automatic respawn after the child exits between calls
    // The earlier #151 / #172 stalls all hit one of these three
    // codepaths, so each gets its own dedicated MCP script + test.
    // ============================================================

    fn write_wrong_id_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("wrong-id-mcp.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, sys",
            "header = b''",
            r"while not header.endswith(b'\r\n\r\n'):",
            "    chunk = sys.stdin.buffer.read(1)",
            "    if not chunk:",
            "        raise SystemExit(1)",
            "    header += chunk",
            "length = 0",
            r"for line in header.decode().split('\r\n'):",
            r"    if line.lower().startswith('content-length:'):",
            r"        length = int(line.split(':', 1)[1].strip())",
            "payload = sys.stdin.buffer.read(length)",
            "request = json.loads(payload.decode())",
            "# Intentionally respond with a different id so we exercise",
            "# the correlation check.",
            r"response = json.dumps({",
            r"    'jsonrpc': '2.0',",
            r"    'id': 999,",
            r"    'result': {",
            r"        'protocolVersion': request['params']['protocolVersion'],",
            r"        'capabilities': {},",
            r"        'serverInfo': {'name': 'wrong-id', 'version': '0.1.0'}",
            r"    }",
            r"}).encode()",
            r"sys.stdout.buffer.write(f'Content-Length: {len(response)}\r\n\r\n'.encode() + response)",
            "sys.stdout.buffer.flush()",
            "# Keep the process alive so the test can observe the kill.",
            "import time; time.sleep(30)",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    fn write_no_response_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("no-response-mcp.py");
        let script = [
            "#!/usr/bin/env python3",
            "import sys, time",
            "# Read the request header + body so the client's send_request",
            "# completes, then deliberately hang. The client should",
            "# trip MCP_REQUEST_TIMEOUT_SECS and kill us.",
            "header = b''",
            r"while not header.endswith(b'\r\n\r\n'):",
            "    chunk = sys.stdin.buffer.read(1)",
            "    if not chunk:",
            "        raise SystemExit(0)",
            "    header += chunk",
            "length = 0",
            r"for line in header.decode().split('\r\n'):",
            r"    if line.lower().startswith('content-length:'):",
            r"        length = int(line.split(':', 1)[1].strip())",
            "sys.stdin.buffer.read(length)",
            "time.sleep(30)",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    fn write_die_after_tools_list_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("die-after-tools-list.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, os, sys",
            "LOG_PATH = os.environ.get('MCP_LOG_PATH')",
            "",
            "def log(method):",
            "    if LOG_PATH:",
            "        with open(LOG_PATH, 'a', encoding='utf-8') as handle:",
            "            handle.write(f'{method}\\n')",
            "",
            "def read_message():",
            "    header = b''",
            r"    while not header.endswith(b'\r\n\r\n'):",
            "        chunk = sys.stdin.buffer.read(1)",
            "        if not chunk:",
            "            return None",
            "        header += chunk",
            "    length = 0",
            r"    for line in header.decode().split('\r\n'):",
            r"        if line.lower().startswith('content-length:'):",
            r"            length = int(line.split(':', 1)[1].strip())",
            "    payload = sys.stdin.buffer.read(length)",
            "    return json.loads(payload.decode())",
            "",
            "def send_message(message):",
            "    payload = json.dumps(message).encode()",
            r"    sys.stdout.buffer.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload)",
            "    sys.stdout.buffer.flush()",
            "",
            "while True:",
            "    request = read_message()",
            "    if request is None:",
            "        break",
            "    if 'id' not in request:",
            "        continue  # notifications have no id — skip silently",
            "    method = request['method']",
            "    log(method)",
            "    if method == 'initialize':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'protocolVersion': request['params']['protocolVersion'],",
            "                'capabilities': {'tools': {}},",
            "                'serverInfo': {'name': 'die-after-list', 'version': '0.1.0'}",
            "            }",
            "        })",
            "    elif method == 'tools/list':",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'result': {",
            "                'tools': [",
            "                    {",
            "                        'name': 'echo',",
            "                        'description': 'one-shot',",
            "                        'inputSchema': {'type': 'object'}",
            "                    }",
            "                ]",
            "            }",
            "        })",
            "        # Exit cleanly after the first tools/list reply so the",
            "        # next manager call has to respawn.",
            "        sys.exit(0)",
            "    else:",
            "        send_message({",
            "            'jsonrpc': '2.0',",
            "            'id': request['id'],",
            "            'error': {'code': -32601, 'message': f'unknown method: {method}'},",
            "        })",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    fn die_after_tools_list_config(script_path: &Path, log_path: &Path) -> ScopedMcpServerConfig {
        ScopedMcpServerConfig {
            scope: ConfigSource::Local,
            config: McpServerConfig::Stdio(McpStdioServerConfig {
                command: python_command().to_string(),
                args: vec![script_path.to_string_lossy().into_owned()],
                env: BTreeMap::from([
                    (
                        "ARIS_MCP_STDIO_FRAMING".to_string(),
                        "content-length".to_string(),
                    ),
                    (
                        "MCP_LOG_PATH".to_string(),
                        log_path.to_string_lossy().into_owned(),
                    ),
                ]),
                request_timeout_secs: None,
            }),
        }
    }

    #[test]
    fn rejects_response_with_mismatched_id() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_wrong_id_script();
            let transport = script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn wrong-id server");

            let err = process
                .initialize(
                    JsonRpcId::Number(1),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect_err("id mismatch should error");

            assert_eq!(err.kind(), ErrorKind::InvalidData);
            assert!(
                err.to_string().contains("response id mismatch"),
                "unexpected error: {err}"
            );

            // The child was killed by `request()` — wait() reaps it.
            let _ = process.wait().await;
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn times_out_when_server_does_not_respond() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_no_response_script();
            let transport = script_transport(&script_path);
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn hanging server");

            // Set the env override *just before* the call and restore
            // the previous value after. Tests are otherwise local IPC
            // at sub-100ms latency, so a transient 1s ceiling can't
            // cause false failures elsewhere.
            let prior = std::env::var("MCP_REQUEST_TIMEOUT_SECS").ok();
            std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", "1");
            let started = std::time::Instant::now();
            let err = process
                .initialize(
                    JsonRpcId::Number(1),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect_err("hanging server should trigger timeout");
            let elapsed = started.elapsed();
            match prior {
                Some(value) => std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", value),
                None => std::env::remove_var("MCP_REQUEST_TIMEOUT_SECS"),
            }

            assert_eq!(err.kind(), ErrorKind::TimedOut);
            assert!(
                elapsed < std::time::Duration::from_secs(5),
                "timeout fired too slowly: {elapsed:?}"
            );

            let _ = process.wait().await;
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn interrupt_wait_returns_after_flag_is_set() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let flag = AtomicBool::new(false);
            let set_flag = async {
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                flag.store(true, Ordering::SeqCst);
            };

            let started = std::time::Instant::now();
            tokio::join!(wait_for_interrupt_flag(&flag), set_flag);

            assert!(
                started.elapsed() < std::time::Duration::from_secs(1),
                "interrupt polling returned too slowly"
            );
        });
    }

    #[test]
    fn manager_respawns_dead_server_on_next_discovery() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_die_after_tools_list_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("respawn.log");
            let servers = BTreeMap::from([(
                "ephemeral".to_string(),
                die_after_tools_list_config(&script_path, &log_path),
            )]);
            let mut manager = McpServerManager::from_servers(&servers);

            // First discovery: server replies initialize + tools/list,
            // then exits cleanly.
            let first = manager.discover_tools().await.expect("first discover");
            assert_eq!(first.len(), 1);
            assert_eq!(first[0].raw_name, "echo");

            // Give the OS a moment to mark the child as exited so
            // `try_wait()` returns `Ok(Some(_))` on the next call.
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

            // Second discovery must transparently respawn rather than
            // hang on the dead pipe.
            let second = manager.discover_tools().await.expect("respawn discover");
            assert_eq!(second.len(), 1);

            let log = fs::read_to_string(&log_path).expect("read log");
            let initialize_count = log.lines().filter(|line| *line == "initialize").count();
            assert_eq!(
                initialize_count, 2,
                "manager should have re-initialized after detecting the dead child; log was: {log}"
            );

            manager.shutdown().await.expect("shutdown");
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn manager_reports_unknown_qualified_tool_name() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_manager_mcp_server_script();
            let root = script_path.parent().expect("script parent");
            let log_path = root.join("alpha.log");
            let servers = BTreeMap::from([(
                "alpha".to_string(),
                manager_server_config(&script_path, "alpha", &log_path),
            )]);
            let mut manager = McpServerManager::from_servers(&servers);

            let error = manager
                .call_tool(
                    &mcp_tool_name("alpha", "missing"),
                    Some(json!({"text": "nope"})),
                )
                .await
                .expect_err("unknown qualified tool should fail");

            match error {
                McpServerManagerError::UnknownTool { qualified_name } => {
                    assert_eq!(qualified_name, mcp_tool_name("alpha", "missing"));
                }
                other => panic!("expected unknown tool error, got {other:?}"),
            }

            cleanup_script(&script_path);
        });
    }

    // ============================================================
    // v0.4.13 P1.D — per-server MCP timeout precedence.
    // ============================================================

    /// Mutex serialising tests that mutate `MCP_REQUEST_TIMEOUT_SECS`.
    /// `mcp_request_timeout` reads the env at every call, so two
    /// concurrent tests poking the env would race even with
    /// `--test-threads=1` if the runtime crate ever switched to
    /// multi-threaded test execution.
    fn env_lock() -> &'static std::sync::Mutex<()> {
        use std::sync::OnceLock;
        static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    /// Run `body` while `MCP_REQUEST_TIMEOUT_SECS` is set (or
    /// removed). Always restores the prior env value on exit.
    fn with_env_timeout<F: FnOnce()>(value: Option<&str>, body: F) {
        let guard = env_lock().lock().expect("env lock");
        let prior = std::env::var("MCP_REQUEST_TIMEOUT_SECS").ok();
        match value {
            Some(v) => std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", v),
            None => std::env::remove_var("MCP_REQUEST_TIMEOUT_SECS"),
        }
        body();
        match prior {
            Some(value) => std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", value),
            None => std::env::remove_var("MCP_REQUEST_TIMEOUT_SECS"),
        }
        drop(guard);
    }

    #[test]
    fn per_server_timeout_overrides_global_env() {
        // Per-server `Some(42)` must beat `MCP_REQUEST_TIMEOUT_SECS=120`.
        with_env_timeout(Some("120"), || {
            let timeout = mcp_request_timeout(Some(42));
            assert_eq!(timeout, std::time::Duration::from_secs(42));
        });
    }

    #[test]
    fn global_env_overrides_default_when_no_per_server() {
        // No per-server override: env value wins over the 300s default.
        with_env_timeout(Some("77"), || {
            let timeout = mcp_request_timeout(None);
            assert_eq!(timeout, std::time::Duration::from_secs(77));
        });
    }

    #[test]
    fn default_300s_when_no_override() {
        // Neither per-server nor env: fall back to the 300s default.
        with_env_timeout(None, || {
            let timeout = mcp_request_timeout(None);
            assert_eq!(timeout, std::time::Duration::from_secs(300));
        });
    }

    #[test]
    fn per_server_timeout_clamped_to_1_to_1800s() {
        // Per-server override below 1s clamps up to 1s, above 1800s
        // clamps down to 1800s. The env doesn't matter for an
        // override path, so set it to something orthogonal to verify.
        with_env_timeout(Some("60"), || {
            assert_eq!(
                mcp_request_timeout(Some(0)),
                std::time::Duration::from_secs(1),
                "zero override should clamp up to 1s"
            );
            assert_eq!(
                mcp_request_timeout(Some(10_000)),
                std::time::Duration::from_secs(1800),
                "huge override should clamp down to 1800s"
            );
            assert_eq!(
                mcp_request_timeout(Some(1800)),
                std::time::Duration::from_secs(1800),
                "exactly 1800s should pass through"
            );
            assert_eq!(
                mcp_request_timeout(Some(1)),
                std::time::Duration::from_secs(1),
                "exactly 1s should pass through"
            );
        });
    }

    // ============================================================
    // v0.4.13 — JSON-RPC notifications (id-less frames) are skipped.
    // Closes the v0.4.10 known limitation tracked in #151 / #172.
    // ============================================================

    /// MCP server that emits N notification frames followed by a
    /// well-formed response with the request id. Used by both the
    /// "one notification" and "many notifications" tests; vary
    /// `notification_count`.
    fn write_notifications_then_response_script(notification_count: usize) -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join(format!("notifications-{notification_count}-mcp.py"));
        // The number of notifications is baked in via env so the
        // python source itself stays small and identical.
        let script = [
            "#!/usr/bin/env python3",
            "import json, os, sys",
            "n = int(os.environ.get('NOTIFICATION_COUNT', '1'))",
            "header = b''",
            r"while not header.endswith(b'\r\n\r\n'):",
            "    chunk = sys.stdin.buffer.read(1)",
            "    if not chunk:",
            "        raise SystemExit(1)",
            "    header += chunk",
            "length = 0",
            r"for line in header.decode().split('\r\n'):",
            r"    if line.lower().startswith('content-length:'):",
            r"        length = int(line.split(':', 1)[1].strip())",
            "payload = sys.stdin.buffer.read(length)",
            "request = json.loads(payload.decode())",
            "",
            "def emit(body):",
            "    encoded = json.dumps(body).encode()",
            r"    sys.stdout.buffer.write(f'Content-Length: {len(encoded)}\r\n\r\n'.encode() + encoded)",
            "    sys.stdout.buffer.flush()",
            "",
            "# Emit N notifications first.",
            "for i in range(n):",
            "    emit({",
            r"        'jsonrpc': '2.0',",
            r"        'method': 'notifications/progress',",
            r"        'params': {'progressToken': i, 'progress': i},",
            "    })",
            "",
            "# Then the real response, correlated by id.",
            "emit({",
            r"    'jsonrpc': '2.0',",
            r"    'id': request['id'],",
            r"    'result': {",
            r"        'protocolVersion': request['params']['protocolVersion'],",
            r"        'capabilities': {},",
            r"        'serverInfo': {'name': 'notif-then-response', 'version': '0.1.0'}",
            r"    }",
            "})",
            "import time; time.sleep(30)",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    /// Variant: only notifications, no response. Used to verify the
    /// timeout still bites when the read loop is starved.
    fn write_only_notifications_script() -> PathBuf {
        let root = temp_dir();
        fs::create_dir_all(&root).expect("temp dir");
        let script_path = root.join("only-notifications-mcp.py");
        let script = [
            "#!/usr/bin/env python3",
            "import json, sys, time",
            "header = b''",
            r"while not header.endswith(b'\r\n\r\n'):",
            "    chunk = sys.stdin.buffer.read(1)",
            "    if not chunk:",
            "        raise SystemExit(1)",
            "    header += chunk",
            "length = 0",
            r"for line in header.decode().split('\r\n'):",
            r"    if line.lower().startswith('content-length:'):",
            r"        length = int(line.split(':', 1)[1].strip())",
            "sys.stdin.buffer.read(length)",
            "",
            "def emit(body):",
            "    encoded = json.dumps(body).encode()",
            r"    sys.stdout.buffer.write(f'Content-Length: {len(encoded)}\r\n\r\n'.encode() + encoded)",
            "    sys.stdout.buffer.flush()",
            "",
            "# Stream notifications indefinitely, never the response.",
            "# The client should still hit the read timeout because the",
            "# timeout wraps the entire send+read loop, not a single",
            "# read_frame call.",
            "for i in range(1000):",
            "    emit({",
            r"        'jsonrpc': '2.0',",
            r"        'method': 'notifications/log',",
            r"        'params': {'level': 'info', 'message': f'tick {i}'},",
            "    })",
            "    time.sleep(0.05)",
            "time.sleep(10)",
            "",
        ]
        .join("\n");
        fs::write(&script_path, script).expect("write script");
        make_executable(&script_path);
        script_path
    }

    #[test]
    fn notification_then_response_returns_response() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_notifications_then_response_script(1);
            let mut transport = script_transport(&script_path);
            transport
                .env
                .insert("NOTIFICATION_COUNT".to_string(), "1".to_string());
            let mut process =
                McpStdioProcess::spawn(&transport).expect("spawn notif-then-response server");

            let response = process
                .initialize(
                    JsonRpcId::Number(7),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect("notification frame should be skipped and response returned");

            assert_eq!(response.id, JsonRpcId::Number(7));
            let result = response.result.expect("response result");
            assert_eq!(result.server_info.name, "notif-then-response");

            let _ = process.terminate().await;
            let _ = process.wait().await;
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn multiple_notifications_before_response_all_skipped() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let script_path = write_notifications_then_response_script(5);
            let mut transport = script_transport(&script_path);
            transport
                .env
                .insert("NOTIFICATION_COUNT".to_string(), "5".to_string());
            let mut process = McpStdioProcess::spawn(&transport).expect("spawn many-notifs server");

            let response = process
                .initialize(
                    JsonRpcId::Number(11),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect("five notifications should all be skipped, then response returned");

            assert_eq!(response.id, JsonRpcId::Number(11));
            assert!(response.result.is_some(), "response should carry a result");

            let _ = process.terminate().await;
            let _ = process.wait().await;
            cleanup_script(&script_path);
        });
    }

    #[test]
    fn notification_after_timeout_still_times_out() {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        // Hold the env-mutation lock around both `set_var` and the
        // `block_on(...)` to prevent racing with other env-toggling
        // tests under multi-threaded test execution. We inline the
        // mutex here rather than using `with_env_timeout` because the
        // call we're guarding is async.
        let guard = env_lock().lock().expect("env lock");
        let prior = std::env::var("MCP_REQUEST_TIMEOUT_SECS").ok();
        std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", "1");

        runtime.block_on(async {
            let script_path = write_only_notifications_script();
            let transport = script_transport(&script_path);
            let mut process =
                McpStdioProcess::spawn(&transport).expect("spawn streaming-notifs server");

            let started = std::time::Instant::now();
            let err = process
                .initialize(
                    JsonRpcId::Number(13),
                    McpInitializeParams {
                        protocol_version: "2025-03-26".to_string(),
                        capabilities: json!({}),
                        client_info: McpInitializeClientInfo {
                            name: "runtime-tests".to_string(),
                            version: "0.1.0".to_string(),
                        },
                    },
                )
                .await
                .expect_err("server only emits notifications, request should time out");
            let elapsed = started.elapsed();

            assert_eq!(err.kind(), ErrorKind::TimedOut);
            assert!(
                elapsed < std::time::Duration::from_secs(5),
                "timeout was not honoured by the notification-skip loop: {elapsed:?}"
            );

            let _ = process.wait().await;
            cleanup_script(&script_path);
        });

        match prior {
            Some(value) => std::env::set_var("MCP_REQUEST_TIMEOUT_SECS", value),
            None => std::env::remove_var("MCP_REQUEST_TIMEOUT_SECS"),
        }
        drop(guard);
    }
}

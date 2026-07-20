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
    ConfigSource, McpRemoteServerConfig, McpSdkServerConfig, McpServerConfig, McpStdioServerConfig,
    McpWebSocketServerConfig, ScopedMcpServerConfig,
};
use crate::mcp::mcp_tool_name;
use crate::mcp_client::McpClientBootstrap;

use super::{
    mcp_request_timeout_from_env_value, spawn_mcp_stdio_process, wait_for_interrupt_flag,
    JsonRpcId, JsonRpcRequest, JsonRpcResponse, McpInitializeClientInfo, McpInitializeParams,
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
        let mut transport = script_transport(&script_path);
        transport.request_timeout_secs = Some(1);
        let mut process = McpStdioProcess::spawn(&transport).expect("spawn hanging server");

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
    // McpStdioProcess inherits ARIS_WORKSPACE_ROOT as its child cwd. Serialize
    // this lifecycle test with other runtime tests that temporarily mutate
    // workspace-related environment variables.
    let _env_lock = crate::test_env_lock();
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

#[test]
fn per_server_timeout_overrides_global_env() {
    // Per-server `Some(42)` must beat `MCP_REQUEST_TIMEOUT_SECS=120`.
    let timeout = mcp_request_timeout_from_env_value(Some(42), Some("120"));
    assert_eq!(timeout, std::time::Duration::from_secs(42));
}

#[test]
fn global_env_overrides_default_when_no_per_server() {
    // No per-server override: env value wins over the 300s default.
    let timeout = mcp_request_timeout_from_env_value(None, Some("77"));
    assert_eq!(timeout, std::time::Duration::from_secs(77));
}

#[test]
fn default_300s_when_no_override() {
    // Neither per-server nor env: fall back to the 300s default.
    let timeout = mcp_request_timeout_from_env_value(None, None);
    assert_eq!(timeout, std::time::Duration::from_secs(300));
}

#[test]
fn per_server_timeout_clamped_to_1_to_1800s() {
    // Per-server override below 1s clamps up to 1s, above 1800s
    // clamps down to 1800s. The env doesn't matter for an
    // override path, so an env value should not affect it.
    assert_eq!(
        mcp_request_timeout_from_env_value(Some(0), Some("60")),
        std::time::Duration::from_secs(1),
        "zero override should clamp up to 1s"
    );
    assert_eq!(
        mcp_request_timeout_from_env_value(Some(10_000), Some("60")),
        std::time::Duration::from_secs(1800),
        "huge override should clamp down to 1800s"
    );
    assert_eq!(
        mcp_request_timeout_from_env_value(Some(1800), Some("60")),
        std::time::Duration::from_secs(1800),
        "exactly 1800s should pass through"
    );
    assert_eq!(
        mcp_request_timeout_from_env_value(Some(1), Some("60")),
        std::time::Duration::from_secs(1),
        "exactly 1s should pass through"
    );
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
    runtime.block_on(async {
        let script_path = write_only_notifications_script();
        let mut transport = script_transport(&script_path);
        transport.request_timeout_secs = Some(1);
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
}

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    attach_mcp_tools, chat_tool_specs, clear_mcp_discovery_cache,
    context_compaction_threshold_for_model, context_window_for_model, final_assistant_text,
    merge_mcp_tool_search_results, model_developer, permission_policy_for_tools,
    resolve_settings_executor_config, resolve_summarizer_model,
    tool_schema_context_overhead_tokens, ChatExecutorConfig, ChatToolSpec,
};
use api::AuthSource;
use runtime::{
    ConfigSource, ContentBlock, ConversationMessage, McpServerConfig, McpStdioServerConfig,
    PermissionMode, RuntimeFeatureConfig, ScopedMcpServerConfig, StaticToolExecutor, TokenUsage,
    ToolExecutor, TurnSummary,
};
use serde_json::{json, Value};

#[test]
fn summarizer_model_honors_explicit_setting_over_defaults() {
    let anthropic = ChatExecutorConfig::Anthropic {
        auth: AuthSource::ApiKey("k".into()),
        base_url: "https://api.anthropic.com".into(),
        send_betas: false,
    };
    let openai = ChatExecutorConfig::OpenAiCompatible {
        api_key: "k".into(),
        base_url: "https://example.test/v1".into(),
        transport: aris_executor::OpenAiTransport::Auto,
    };

    // Explicit setting wins regardless of provider/model. (These paths
    // short-circuit before the env var, so they are deterministic.)
    assert_eq!(
        resolve_summarizer_model(&anthropic, "claude-opus-4-8", Some("off")),
        None
    );
    assert_eq!(
        resolve_summarizer_model(&openai, "MiniMax-M3", Some("MiniMax-Cheap")),
        Some("MiniMax-Cheap".to_string())
    );
    // "auto" forces the per-provider default.
    assert_eq!(
        resolve_summarizer_model(&anthropic, "claude-opus-4-8", Some("auto")),
        Some("claude-haiku-4-5-20251001".to_string())
    );
    // Haiku still uses an LLM summary; it just reuses the active model.
    assert_eq!(
        resolve_summarizer_model(&anthropic, "claude-haiku-4-5-20251001", Some("auto")),
        Some("claude-haiku-4-5-20251001".to_string())
    );
    // OpenAI-compatible "auto" uses a cheap sibling when the model family is
    // known; unknown gateway model names use deterministic fallback rather
    // than silently sending the main model a second large request.
    assert_eq!(
        resolve_summarizer_model(&openai, "MiniMax-M3", Some("default")),
        None
    );
    assert_eq!(
        resolve_summarizer_model(&openai, "gpt-5", Some("default")),
        Some("gpt-5-mini".to_string())
    );
}

#[test]
fn context_budget_scales_with_model_window() {
    // Large-window models get large budgets — the whole point of the fix.
    assert_eq!(
        context_compaction_threshold_for_model("MiniMax-Text-01"),
        320_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("gemini-2.5-pro"),
        850_000
    );
    assert_eq!(context_compaction_threshold_for_model("gpt-5"), 240_000);
    assert_eq!(context_compaction_threshold_for_model("kimi-k3"), 850_000);
    assert_eq!(
        context_compaction_threshold_for_model("deepseek-v4-pro"),
        850_000
    );
    // Small-window models stay conservative.
    assert_eq!(
        context_compaction_threshold_for_model("deepseek-chat"),
        40_000
    );
    // Claude stays safe against the 200k floor (Opus 1M beta notwithstanding).
    assert_eq!(
        context_compaction_threshold_for_model("claude-opus-4-8"),
        160_000
    );
}

#[test]
fn context_window_never_below_compaction_budget() {
    // The advertised (display/telemetry) window must never sit below the
    // compaction budget: otherwise the gauge shows a warn/compaction point
    // beyond "100% full". This is the qwen/glm inversion — and the kimi-k2
    // ~4x inflation — that unifying the two tables in `aris_chat` fixes. One
    // representative model per family.
    for model in [
        "MiniMax-Text-01",
        "gemini-2.5-pro",
        "deepseek-v4-pro",
        "gpt-5.6-luna",
        "gpt-4.1",
        "kimi-k3",
        "kimi-k2",
        "moonshot-v1-128k",
        "qwen-max",
        "deepseek-chat",
        "claude-opus-4-8",
        "claude-haiku-4-5-20251001",
        "glm-4.6",
        "o3-pro",
        "gpt-4o",
        "some-unknown-gateway-model",
    ] {
        let budget = context_compaction_threshold_for_model(model);
        let window = context_window_for_model(model);
        assert!(
            budget <= window,
            "budget ({budget}) must not exceed window ({window}) for {model}"
        );
    }

    // Spot-check the families whose window was previously wrong (non-K3 Kimi
    // and Qwen advertised 1M / defaulted to 128k; GLM defaulted to 128k).
    assert_eq!(context_window_for_model("kimi-k2"), 256_000);
    assert_eq!(context_window_for_model("qwen-max"), 256_000);
    assert_eq!(context_window_for_model("glm-4.6"), 200_000);
    // Kimi K3 keeps its genuine 1M window.
    assert_eq!(context_window_for_model("kimi-k3"), 1_000_000);
}

#[test]
fn tool_schema_overhead_is_included_in_context_estimates() {
    let tool = ChatToolSpec {
        name: "search_records".to_string(),
        description: "Search a project-local evidence index.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        }),
        required_permission: PermissionMode::WorkspaceWrite,
    };

    assert_eq!(
        tool_schema_context_overhead_tokens(&[tool.clone()], false),
        0
    );
    assert!(tool_schema_context_overhead_tokens(&[tool], true) > 128);
}

fn temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("somniq-chat-mcp-{nanos}"))
}

fn write_mcp_server_script(root: &Path) -> PathBuf {
    fs::create_dir_all(root).expect("temp dir");
    let script_path = root.join("fake-mcp.py");
    let script = r#"import json, sys

def read_message():
    header = b''
    while not header.endswith(b'\r\n\r\n'):
        chunk = sys.stdin.buffer.read(1)
        if not chunk:
            return None
        header += chunk
    length = 0
    for line in header.decode().split('\r\n'):
        if line.lower().startswith('content-length:'):
            length = int(line.split(':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length).decode())

def send(message):
    payload = json.dumps(message).encode()
    sys.stdout.buffer.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload)
    sys.stdout.buffer.flush()

while True:
    request = read_message()
    if request is None:
        break
    if request['method'] == 'initialize':
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {
            'protocolVersion': request['params']['protocolVersion'],
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'chat-test', 'version': '1.0.0'}}})
    elif request['method'] == 'tools/list':
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {'tools': [{
            'name': 'echo', 'description': 'Echo text',
            'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}})
    elif request['method'] == 'tools/call':
        text = (request['params'].get('arguments') or {}).get('text', '')
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {
            'content': [{'type': 'text', 'text': 'echo:' + text}],
            'structuredContent': {'echoed': text}, 'isError': False}})
"#;
    fs::write(&script_path, script).expect("write fake MCP server");
    script_path
}

#[test]
fn model_developer_routes_openai_compatible_names() {
    assert_eq!(model_developer("gpt-5.5"), "OpenAI");
    assert_eq!(model_developer("deepseek-v4-pro"), "DeepSeek");
    assert_eq!(model_developer("gemini-2.5-pro"), "Google");
    assert_eq!(model_developer("moonshot-v1"), "Moonshot");
}

#[test]
fn final_assistant_text_keeps_text_from_all_model_iterations() {
    let summary = TurnSummary {
        assistant_messages: vec![
            ConversationMessage::assistant(vec![
                ContentBlock::Text {
                    text: "Checking files.".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read_file".to_string(),
                    input: "{}".to_string(),
                },
            ]),
            ConversationMessage::assistant(vec![
                ContentBlock::Thinking {
                    thinking: "private reasoning".to_string(),
                    signature: String::new(),
                },
                ContentBlock::Text {
                    text: "Fix complete.".to_string(),
                },
            ]),
        ],
        tool_results: Vec::new(),
        iterations: 2,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    assert_eq!(
        final_assistant_text(&summary),
        "Checking files.\n\nFix complete."
    );
}

#[test]
fn resolves_openai_compatible_settings() {
    let obj = json!({
        "executor_provider": "openai",
        "executor_model": "gpt-5.5",
        "executor_api_key": "sk-test",
        "executor_base_url": "https://example.test/v1"
    })
    .as_object()
    .cloned()
    .expect("object");

    let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
    assert_eq!(model, "gpt-5.5");
    assert_eq!(provider, "openai");
    match config {
        ChatExecutorConfig::OpenAiCompatible {
            api_key, base_url, ..
        } => {
            assert_eq!(api_key, "sk-test");
            assert_eq!(base_url, "https://example.test/v1");
        }
        ChatExecutorConfig::Anthropic { .. } => panic!("expected OpenAI-compatible config"),
    }
}

#[test]
fn resolves_anthropic_settings_key_without_env() {
    let obj = json!({
        "executor_provider": "anthropic",
        "executor_model": "claude-sonnet-4-6",
        "executor_api_key": "anthropic-key",
        "executor_base_url": "https://anthropic.example"
    })
    .as_object()
    .cloned()
    .expect("object");

    let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
    assert_eq!(model, "claude-sonnet-4-6");
    assert_eq!(provider, "anthropic");
    match config {
        ChatExecutorConfig::Anthropic {
            auth,
            base_url,
            send_betas,
        } => {
            assert_eq!(auth, AuthSource::ApiKey("anthropic-key".to_string()));
            assert_eq!(base_url, "https://anthropic.example");
            assert!(!send_betas);
        }
        ChatExecutorConfig::OpenAiCompatible { .. } => panic!("expected Anthropic config"),
    }
}

#[test]
fn resolves_anthropic_compat_proxy_even_when_old_provider_is_anthropic() {
    let obj = json!({
        "executor_provider": "anthropic",
        "executor_model": "MiniMax-M3",
        "executor_api_key": "minimax-key",
        "executor_base_url": "https://api.minimaxi.com/anthropic"
    })
    .as_object()
    .cloned()
    .expect("object");

    let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
    assert_eq!(model, "MiniMax-M3");
    assert_eq!(provider, "anthropic-compat");
    match config {
        ChatExecutorConfig::Anthropic {
            auth,
            base_url,
            send_betas,
        } => {
            assert_eq!(auth, AuthSource::BearerToken("minimax-key".to_string()));
            assert_eq!(base_url, "https://api.minimaxi.com/anthropic");
            assert!(!send_betas);
        }
        ChatExecutorConfig::OpenAiCompatible { .. } => panic!("expected Anthropic config"),
    }
}

#[test]
fn permission_policy_uses_tool_requirements() {
    let spec = tools::ToolSpec {
        name: "write_file",
        description: "write",
        input_schema: Value::Null,
        required_permission: PermissionMode::WorkspaceWrite,
    };
    let policy = permission_policy_for_tools(chat_tool_specs(vec![spec]), PermissionMode::ReadOnly);
    assert_eq!(
        policy.required_mode_for("write_file"),
        PermissionMode::WorkspaceWrite
    );
}

#[test]
fn attaches_discovers_and_executes_mcp_tools() {
    clear_mcp_discovery_cache();
    let root = temp_dir();
    let script = write_mcp_server_script(&root);
    let python = if cfg!(windows) { "python" } else { "python3" };
    let feature_config = RuntimeFeatureConfig::default().with_mcp_servers(BTreeMap::from([(
        "test".to_string(),
        ScopedMcpServerConfig {
            scope: ConfigSource::Local,
            config: McpServerConfig::Stdio(McpStdioServerConfig {
                command: python.to_string(),
                args: vec![script.to_string_lossy().into_owned()],
                env: BTreeMap::from([(
                    "ARIS_MCP_STDIO_FRAMING".to_string(),
                    "content-length".to_string(),
                )]),
                request_timeout_secs: Some(10),
            }),
        },
    )]));

    let inner = StaticToolExecutor::new().register("ToolSearch", |_| {
        Ok(json!({
            "matches": [],
            "query": "test echo",
            "normalized_query": "test echo",
            "total_deferred_tools": 10,
            "pending_mcp_servers": null
        })
        .to_string())
    });
    let mut bundle = attach_mcp_tools(inner, Vec::new(), &feature_config, None);
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
    assert_eq!(bundle.tool_specs.len(), 1);
    assert_eq!(bundle.tool_specs[0].name, "mcp__test__echo");
    assert_eq!(
        bundle.tool_specs[0].required_permission,
        PermissionMode::DangerFullAccess
    );

    let output = bundle
        .executor
        .execute("mcp__test__echo", r#"{"text":"hello"}"#)
        .expect("execute MCP tool");
    assert!(output.contains(r#""echoed":"hello""#), "{output}");
    let search = bundle
        .executor
        .execute("ToolSearch", r#"{"query":"test echo","max_results":5}"#)
        .expect("search MCP tools");
    assert!(search.contains("mcp__test__echo"), "{search}");

    drop(bundle);
    fs::remove_file(&script).expect("remove MCP script after first discovery");

    let cached = attach_mcp_tools(StaticToolExecutor::new(), Vec::new(), &feature_config, None);
    assert!(cached.warnings.is_empty(), "{:?}", cached.warnings);
    assert_eq!(cached.tool_specs[0].name, "mcp__test__echo");
    drop(cached);

    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn tool_search_results_include_discovered_mcp_tools() {
    let names = BTreeSet::from([
        "mcp__playwright__browser_navigate".to_string(),
        "mcp__playwright__browser_click".to_string(),
    ]);
    let output = json!({
        "matches": [],
        "query": "playwright navigate",
        "normalized_query": "playwright navigate",
        "total_deferred_tools": 10,
        "pending_mcp_servers": null
    })
    .to_string();

    let merged = merge_mcp_tool_search_results(
        output,
        r#"{"query":"playwright navigate","max_results":5}"#,
        &names,
    );
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");

    assert_eq!(
        merged["matches"],
        json!(["mcp__playwright__browser_navigate"])
    );
    assert_eq!(merged["total_deferred_tools"], 12);
}

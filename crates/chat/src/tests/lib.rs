use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    attach_mcp_tools_with_cancel, browser_acceptance_snapshot_name,
    browser_output_has_state_evidence, chat_tool_specs, clear_mcp_discovery_cache,
    context_compaction_threshold_for_model, context_window_for_model, final_assistant_text,
    llm_review_override_section, mcp_result_to_tool_output, mcp_tool_timeout_policy_with_defaults,
    mcp_tool_timeout_with_default, merge_mcp_tool_search_results, model_developer,
    model_identity_section, permission_policy_for_tools, resolve_settings_executor_config,
    resolve_summarizer_model, route_chat_tools, tool_schema_context_overhead_tokens,
    ChatExecutorConfig, ChatToolSpec, McpToolTimeoutPolicy, ToolRoutingMode, MAX_ACTIVE_TOOLS,
    MAX_ROUTED_TOOLS,
};
use api::AuthSource;
use runtime::{
    ConfigSource, ContentBlock, ConversationMessage, McpServerConfig, McpStdioServerConfig,
    McpToolCallContent, McpToolCallResult, PermissionMode, RuntimeFeatureConfig,
    ScopedMcpServerConfig, StaticToolExecutor, TokenUsage, ToolExecutor, ToolMedia, ToolOutput,
    TurnSummary,
};
use serde_json::{json, Value};

fn routing_spec(name: &str) -> ChatToolSpec {
    ChatToolSpec {
        name: name.to_string(),
        description: format!("{name} test tool"),
        input_schema: json!({"type": "object"}),
        required_permission: PermissionMode::ReadOnly,
    }
}

#[test]
fn dynamic_tool_router_keeps_a_bounded_relevant_subset() {
    let names = [
        "ToolSearch",
        "AskUserQuestion",
        "bash",
        "read_file",
        "read_files",
        "glob_search",
        "grep_search",
        "session_search",
        "memory",
        "write_file",
        "append_file",
        "edit_file",
        "multi_edit",
        "change_list",
        "change_get",
        "change_revert",
        "mcp__pw__browser_navigate",
        "mcp__pw__browser_snapshot",
        "mcp__pw__browser_click",
        "mcp__pw__browser_fill_form",
        "mcp__pw__browser_evaluate",
        "mcp__pw__browser_take_screenshot",
        "mcp__pw__browser_wait_for",
        "mcp__pw__browser_resize",
        "LiteratureSearch",
        "ArxivSearch",
        "EvidenceGet",
        "NotebookEdit",
        "ComputeRun",
        "ReadMediaFile",
        "Agent",
    ];
    let specs = names.into_iter().map(routing_spec).collect::<Vec<_>>();
    let plan = route_chat_tools(
        "修复 React UI，并在浏览器验收",
        &specs,
        ToolRoutingMode::Active,
    );

    assert!(plan.active_names.len() <= 20);
    assert!(plan.active_names.contains("ToolSearch"));
    assert!(plan.active_names.contains("read_file"));
    assert!(plan.active_names.contains("read_files"));
    assert!(plan.active_names.contains("edit_file"));
    assert!(plan.active_names.contains("mcp__pw__browser_navigate"));
    assert!(!plan.deferred_names.is_empty());
    assert!(plan.profile.contains("code"));
    assert!(plan.profile.contains("browser"));
}

fn desktop_like_catalog() -> Vec<ChatToolSpec> {
    [
        "ToolSearch",
        "AskUserQuestion",
        "bash",
        "read_file",
        "read_files",
        "glob_search",
        "grep_search",
        "session_search",
        "memory",
        "TodoWrite",
        "WorkspaceLayout",
        "write_file",
        "append_file",
        "begin_large_write",
        "append_write_chunk",
        "commit_large_write",
        "edit_file",
        "multi_edit",
        "change_list",
        "change_get",
        "change_revert",
        "mcp__pw__browser_navigate",
        "mcp__pw__browser_snapshot",
        "mcp__pw__browser_click",
        "mcp__pw__browser_evaluate",
        "mcp__pw__browser_type",
        "mcp__pw__browser_fill_form",
        "mcp__pw__browser_take_screenshot",
        "mcp__pw__browser_wait_for",
        "mcp__pw__browser_resize",
        "LiteratureSearch",
        "ArxivSearch",
        "EvidenceGet",
        "NotebookEdit",
        "ComputeRun",
        "ReadMediaFile",
        "WebSearch",
        "WebFetch",
        "Agent",
        "Skill",
    ]
    .into_iter()
    .map(routing_spec)
    .collect()
}

#[test]
fn dynamic_tool_router_gives_every_matched_intent_its_required_tools() {
    let specs = desktop_like_catalog();
    let plan = route_chat_tools(
        "创建一个新的配置文件，再修改 lib.rs，最后在浏览器里验收页面",
        &specs,
        ToolRoutingMode::Active,
    );

    // Create.
    assert!(plan.active_names.contains("write_file"), "{plan:?}");
    // Modify.
    for name in ["read_file", "edit_file", "multi_edit"] {
        assert!(plan.active_names.contains(name), "{name} missing: {plan:?}");
    }
    // Browser acceptance: observe, act, and read state back.
    for name in [
        "mcp__pw__browser_navigate",
        "mcp__pw__browser_snapshot",
        "mcp__pw__browser_click",
        "mcp__pw__browser_evaluate",
    ] {
        assert!(plan.active_names.contains(name), "{name} missing: {plan:?}");
    }
    // The first intent must not drain the budget before the later ones are served.
    assert!(plan.active_names.len() <= MAX_ACTIVE_TOOLS);
}

#[test]
fn dynamic_tool_router_serves_a_multi_file_investigation() {
    let specs = desktop_like_catalog();
    let plan = route_chat_tools(
        "调查一下这个 bug 在哪些文件里被触发",
        &specs,
        ToolRoutingMode::Active,
    );

    for name in ["read_files", "glob_search", "grep_search"] {
        assert!(plan.active_names.contains(name), "{name} missing: {plan:?}");
    }
    assert!(plan.profile.contains("investigate"), "{plan:?}");
}

#[test]
fn dynamic_tool_router_pins_core_tools_within_the_hard_cap() {
    let specs = desktop_like_catalog();
    let every_name = specs
        .iter()
        .map(|spec| spec.name.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for prompt in [
        "修复 React UI，并在浏览器验收",
        "查一下最新文献并整理引用",
        "跑一下这个 notebook 的数据分析",
        "随便聊聊",
        // A prompt that names more tools than the entire budget.
        &format!("用这些工具做点什么：{every_name}"),
    ] {
        let plan = route_chat_tools(prompt, &specs, ToolRoutingMode::Active);
        assert!(plan.active_names.len() <= MAX_ROUTED_TOOLS, "{plan:?}");
        assert!(MAX_ROUTED_TOOLS <= MAX_ACTIVE_TOOLS);
        assert!(plan.pinned_names.is_subset(&plan.active_names), "{plan:?}");
        assert!(plan.pinned_names.len() < plan.active_names.len(), "{plan:?}");
        // Without ToolSearch the model cannot recover anything that was routed
        // away, so it is never evictable.
        assert!(plan.pinned_names.contains("ToolSearch"), "{plan:?}");
        assert_eq!(
            plan.active_names.len() + plan.deferred_names.len(),
            plan.catalog_names.len(),
            "{plan:?}"
        );
    }
}

/// A website task used to cost one `ToolSearch` call per browser tool, because
/// the router activated two of them and the search required every query term to
/// be a substring of one name. Routing now lands the acceptance bundle up front
/// and one keyword search covers the rest.
#[test]
fn a_browser_task_needs_at_most_one_tool_search_for_the_whole_family() {
    let specs = desktop_like_catalog();
    let plan = route_chat_tools("在浏览器里验收这个页面", &specs, ToolRoutingMode::Active);

    let catalog = specs
        .iter()
        .map(|spec| (spec.name.clone(), spec.description.clone()))
        .collect::<BTreeMap<_, _>>();
    let merged = merge_mcp_tool_search_results(
        json!({"matches": [], "query": "browser", "total_deferred_tools": 0}).to_string(),
        r#"{"query":"browser"}"#,
        &catalog,
        &[],
    );
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");

    let mut reachable = plan.active_names.clone();
    reachable.extend(
        merged["matches"]
            .as_array()
            .expect("matches")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string),
    );
    for name in [
        "mcp__pw__browser_navigate",
        "mcp__pw__browser_snapshot",
        "mcp__pw__browser_click",
        "mcp__pw__browser_evaluate",
        "mcp__pw__browser_type",
        "mcp__pw__browser_take_screenshot",
    ] {
        assert!(reachable.contains(name), "{name} unreachable: {reachable:?}");
    }
}

#[test]
fn dynamic_tool_router_pins_a_tool_the_user_named() {
    let specs = desktop_like_catalog();
    let plan = route_chat_tools(
        "用 multi_edit 把这三处一起改了",
        &specs,
        ToolRoutingMode::Active,
    );

    assert!(plan.pinned_names.contains("multi_edit"), "{plan:?}");
}

#[test]
fn browser_mutations_resolve_their_matching_snapshot_tool() {
    let tools = BTreeSet::from([
        "mcp__playwright__browser_click".to_string(),
        "mcp__playwright__browser_snapshot".to_string(),
        "mcp__other__browser_snapshot".to_string(),
    ]);
    assert_eq!(
        browser_acceptance_snapshot_name("mcp__playwright__browser_click", &tools).as_deref(),
        Some("mcp__playwright__browser_snapshot")
    );
    assert_eq!(
        browser_acceptance_snapshot_name("mcp__playwright__browser_snapshot", &tools),
        None
    );

    let output = ToolOutput::text("### Page state\n- Page URL: http://localhost:3000");
    assert!(browser_output_has_state_evidence(&output));
}

#[test]
fn dynamic_tool_router_falls_back_to_full_catalog_without_tool_search() {
    let specs = (0..25)
        .map(|index| routing_spec(&format!("custom_{index}")))
        .collect::<Vec<_>>();
    let plan = route_chat_tools("do the custom task", &specs, ToolRoutingMode::Active);

    assert_eq!(plan.active_names.len(), specs.len());
    assert!(plan.deferred_names.is_empty());
    assert_eq!(plan.profile, "fallback-no-tool-search");
}

#[test]
fn tool_search_can_find_non_mcp_tools_from_the_full_chat_catalog() {
    let inner = StaticToolExecutor::new().register("ToolSearch", |_| {
        Ok(json!({
            "matches": [],
            "query": "mail draft",
            "total_deferred_tools": 0
        })
        .to_string())
    });
    let mut bundle = attach_mcp_tools_with_cancel(
        inner,
        vec![routing_spec("MailDraft")],
        &RuntimeFeatureConfig::default(),
        None,
        None,
    );
    let output = bundle
        .executor
        .execute("ToolSearch", r#"{"query":"mail draft","max_results":5}"#)
        .expect("search catalog");
    assert!(output.contains("MailDraft"), "{output}");
}

#[test]
fn browser_tool_timeout_is_class_aware() {
    assert_eq!(
        mcp_tool_timeout_with_default(
            "mcp__playwright__browser_evaluate",
            r#"{"function":"() => 1"}"#,
            120,
        ),
        Some(std::time::Duration::from_secs(120))
    );
    assert_eq!(
        mcp_tool_timeout_with_default("mcp__codex__run", r#"{"prompt":"work"}"#, 120),
        None
    );
    assert_eq!(
        mcp_tool_timeout_with_default("bash", r#"{"command":"train"}"#, 120),
        None
    );
}

#[test]
fn explicit_browser_wait_extends_safety_deadline() {
    let extended = mcp_tool_timeout_policy_with_defaults(
        "mcp__playwright__browser_wait_for",
        r#"{"time":600}"#,
        120,
        600,
    )
    .expect("browser wait policy");
    assert_eq!(extended.idle_timeout, std::time::Duration::from_secs(630));
    assert_eq!(extended.hard_timeout, std::time::Duration::from_secs(630));

    let capped = mcp_tool_timeout_policy_with_defaults(
        "mcp__playwright__browser_wait_for",
        r#"{"time":99999}"#,
        120,
        600,
    )
    .expect("capped browser wait policy");
    assert_eq!(capped.idle_timeout, std::time::Duration::from_secs(1_800));
    assert_eq!(capped.hard_timeout, std::time::Duration::from_secs(1_800));
}

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
        send_routing_session_header: false,
        transport: aris_executor::OpenAiTransport::Auto,
        // Unknown catalogue: the historical optimistic guess still applies.
        known_models: Vec::new(),
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

/// A model family name is not a promise that the gateway carries the family.
///
/// The managed gateway serves `gpt-5.x` and no `-mini` at all, so guessing one
/// spent three retries (1+2+4s) and then fell back to the deterministic summary
/// on *every* compaction — the LLM summary never ran there at all.
#[test]
fn a_cheap_sibling_is_only_used_when_the_gateway_actually_serves_it() {
    let gateway_without_mini = ChatExecutorConfig::OpenAiCompatible {
        api_key: "k".into(),
        base_url: "https://gateway.test/v1".into(),
        send_routing_session_header: false,
        transport: aris_executor::OpenAiTransport::Auto,
        known_models: vec!["gpt-5.6-luna".into(), "MiniMax-M3".into()],
    };
    assert_eq!(
        resolve_summarizer_model(&gateway_without_mini, "gpt-5.6-luna", Some("auto")),
        None,
        "a sibling the gateway does not serve must not be attempted"
    );

    let gateway_with_mini = ChatExecutorConfig::OpenAiCompatible {
        api_key: "k".into(),
        base_url: "https://gateway.test/v1".into(),
        send_routing_session_header: false,
        transport: aris_executor::OpenAiTransport::Auto,
        known_models: vec!["gpt-5".into(), "GPT-5-Mini".into()],
    };
    assert_eq!(
        resolve_summarizer_model(&gateway_with_mini, "gpt-5", Some("auto")),
        Some("gpt-5-mini".to_string()),
        "a served sibling is still used, and the match is case-insensitive"
    );

    // An explicit choice still overrides the catalogue check: the operator may
    // know something the persisted list does not.
    assert_eq!(
        resolve_summarizer_model(
            &gateway_without_mini,
            "gpt-5.6-luna",
            Some("some-small-model")
        ),
        Some("some-small-model".to_string())
    );
}

#[test]
fn context_budget_scales_with_model_window() {
    // Large-window models get large budgets — the whole point of the fix.
    assert_eq!(
        context_compaction_threshold_for_model("MiniMax-M3"),
        800_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("MiniMax-M2.7"),
        160_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("MiniMax-Text-01"),
        320_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("gemini-2.5-pro"),
        850_000
    );
    // Measured ceiling on the new-api route: 358,708 accepted, ~395k rejected.
    assert_eq!(context_compaction_threshold_for_model("gpt-5"), 350_000);
    assert_eq!(context_window_for_model("gpt-5.6-luna"), 400_000);
    assert_eq!(
        context_compaction_threshold_for_model("gpt-6-astra"),
        350_000
    );
    assert_eq!(context_window_for_model("gpt-6-astra"), 400_000);
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
    // The current 1M-context Claude family retains long research continuity.
    assert_eq!(
        context_compaction_threshold_for_model("claude-sonnet-4-6"),
        850_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("claude-opus-4-8"),
        850_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("claude-fable-5"),
        850_000
    );
    assert_eq!(
        context_compaction_threshold_for_model("claude-fable-5.1"),
        850_000
    );
    assert_eq!(context_window_for_model("claude-sonnet-4-6"), 1_000_000);
    assert_eq!(context_window_for_model("claude-opus-4-8"), 1_000_000);
    assert_eq!(context_window_for_model("claude-fable-5"), 1_000_000);
    assert_eq!(context_window_for_model("claude-fable-5.1"), 1_000_000);
}

#[test]
fn context_window_never_below_compaction_budget() {
    // The advertised (display/telemetry) window must never sit below the
    // compaction budget: otherwise the gauge shows a warn/compaction point
    // beyond "100% full". This is the qwen/glm inversion — and the kimi-k2
    // ~4x inflation — that unifying the two tables in `aris_chat` fixes. One
    // representative model per family.
    for model in [
        "MiniMax-M3",
        "MiniMax-M2.7",
        "MiniMax-Text-01",
        "gemini-2.5-pro",
        "deepseek-v4-pro",
        "gpt-5.6-luna",
        "gpt-6-astra",
        "gpt-4.1",
        "kimi-k3",
        "kimi-k2",
        "moonshot-v1-128k",
        "qwen-max",
        "deepseek-chat",
        "claude-opus-4-8",
        "claude-fable-5",
        "claude-fable-5.1",
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
    assert_eq!(context_window_for_model("MiniMax-M3"), 1_000_000);
    assert_eq!(context_window_for_model("MiniMax-M2.7"), 204_800);
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
            'content': [{'type': 'text', 'text': 'echo:' + text},
                        {'type': 'image', 'mimeType': 'image/png', 'data': 'aGVsbG8='}],
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
    assert_eq!(model_developer("claude-sonnet-4-6"), "Anthropic");
    assert_eq!(model_developer("custom-local-model"), "unknown provider");
}

#[test]
fn model_identity_distinguishes_the_host_product_from_the_actual_model() {
    let known = model_identity_section(Some("MiniMax-M3"), "desktop research workspace");
    assert!(known.contains("You are SomniQ"));
    assert!(known.contains("SomniQ is your assistant and product identity"));
    assert!(known.contains("introduce yourself as SomniQ"));
    assert!(known.contains("Do not answer such general identity questions with only a model"));
    assert!(known.contains("Only describe the underlying model as Claude when"));
    assert!(known.contains("model ID: MiniMax-M3"));
    assert!(known.contains("developed by MiniMax"));

    let unknown = model_identity_section(None, "desktop research workspace");
    assert!(unknown.contains("underlying model ID and developer are unknown"));
    assert!(!unknown.contains("developed by Anthropic"));
}

#[test]
fn llm_review_is_the_default_reviewer_backend() {
    let section = llm_review_override_section();

    assert!(section.contains("`LlmReview` is SomniQ's reviewer backend"));
    assert!(section.contains("reviewer the user configured in SomniQ settings"));
    assert!(section.contains("call `LlmReview` instead"));
    assert!(section.contains("single-shot with no conversation continuation"));
}

#[test]
fn codex_mcp_review_needs_explicit_user_request_and_a_present_tool() {
    let section = llm_review_override_section();

    assert!(section.contains("Only use a Codex MCP tool when it is actually present"));
    assert!(section.contains("user explicitly asked for that backend"));
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
            api_key,
            base_url,
            send_routing_session_header,
            ..
        } => {
            assert_eq!(api_key, "sk-test");
            assert_eq!(base_url, "https://example.test/v1");
            assert!(!send_routing_session_header);
        }
        ChatExecutorConfig::Anthropic { .. } => panic!("expected OpenAI-compatible config"),
    }
}

fn write_progress_mcp_server_script(root: &Path) -> PathBuf {
    fs::create_dir_all(root).expect("temp dir");
    let script_path = root.join("progress-mcp.py");
    let script = r#"import json, sys, time

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
            'serverInfo': {'name': 'progress-test', 'version': '1.0.0'}}})
    elif request['method'] == 'tools/list':
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {'tools': [
            {'name': 'browser_progress', 'description': 'Reports progress',
             'inputSchema': {'type': 'object'}},
            {'name': 'browser_hang', 'description': 'Never completes in time',
             'inputSchema': {'type': 'object'}}]}})
    elif request['method'] == 'tools/call':
        name = request['params']['name']
        if name == 'browser_hang':
            time.sleep(5)
        else:
            for step in range(5):
                time.sleep(0.04)
                send({'jsonrpc': '2.0', 'method': 'notifications/progress',
                      'params': {'progressToken': 'test', 'progress': step + 1, 'total': 5}})
            send({'jsonrpc': '2.0', 'id': request['id'], 'result': {
                'content': [{'type': 'text', 'text': 'completed with progress'}],
                'isError': False}})
"#;
    fs::write(&script_path, script).expect("write progress MCP server");
    script_path
}

#[test]
fn managed_newapi_settings_enable_the_initial_routing_header() {
    let obj = json!({
        "executor_provider": "openai",
        "executor_model": "MiniMax-M3",
        "executor_api_key": "sk-test",
        "executor_base_url": "https://gateway.test/v1/",
        "newapi_executor_base_url": "https://gateway.test/v1"
    })
    .as_object()
    .cloned()
    .expect("object");

    let (_, _, config) = resolve_settings_executor_config(&obj).expect("config");
    match config {
        ChatExecutorConfig::OpenAiCompatible {
            send_routing_session_header,
            ..
        } => assert!(send_routing_session_header),
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
    let root = temp_dir().join("echo");
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
    let mut bundle = attach_mcp_tools_with_cancel(inner, Vec::new(), &feature_config, None, None);
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
    let rich = bundle
        .executor
        .execute_output_with_id("mcp-1", "mcp__test__echo", r#"{"text":"hello"}"#)
        .expect("execute rich MCP tool");
    assert_eq!(rich.media.len(), 1);
    assert!(!rich.text.contains("aGVsbG8="));
    let search = bundle
        .executor
        .execute("ToolSearch", r#"{"query":"test echo","max_results":5}"#)
        .expect("search MCP tools");
    assert!(search.contains("mcp__test__echo"), "{search}");

    drop(bundle);
    fs::remove_file(&script).expect("remove MCP script after first discovery");

    let cached = attach_mcp_tools_with_cancel(
        StaticToolExecutor::new(),
        Vec::new(),
        &feature_config,
        None,
        None,
    );
    assert!(cached.warnings.is_empty(), "{:?}", cached.warnings);
    assert_eq!(cached.tool_specs[0].name, "mcp__test__echo");
    drop(cached);

    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn browser_timeout_renews_on_progress_and_recovers_after_a_hang() {
    clear_mcp_discovery_cache();
    let root = temp_dir().join("timeout-progress");
    let script = write_progress_mcp_server_script(&root);
    let python = if cfg!(windows) { "python" } else { "python3" };
    let feature_config = RuntimeFeatureConfig::default().with_mcp_servers(BTreeMap::from([(
        "playwright".to_string(),
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
    let mut bundle = attach_mcp_tools_with_cancel(
        StaticToolExecutor::new(),
        Vec::new(),
        &feature_config,
        None,
        None,
    );
    assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
    bundle.executor.timeout_policy_override = Some(McpToolTimeoutPolicy {
        idle_timeout: std::time::Duration::from_millis(100),
        hard_timeout: std::time::Duration::from_secs(1),
    });

    let progress_started = std::time::Instant::now();
    let output = bundle
        .executor
        .execute("mcp__playwright__browser_progress", "{}")
        .expect("progress notifications should renew the idle lease");
    assert!(output.contains("completed with progress"));
    assert!(progress_started.elapsed() >= std::time::Duration::from_millis(180));

    let hang_started = std::time::Instant::now();
    let error = bundle
        .executor
        .execute("mcp__playwright__browser_hang", "{}")
        .expect_err("silent browser call should time out");
    assert!(error.is_timed_out(), "{error}");
    assert_eq!(error.timeout_ms(), Some(100));
    assert!(error.to_string().contains("produced no progress"));
    assert!(hang_started.elapsed() < std::time::Duration::from_secs(2));

    let recovered = bundle
        .executor
        .execute("mcp__playwright__browser_progress", "{}")
        .expect("manager should respawn after the timed-out child is stopped");
    assert!(recovered.contains("completed with progress"));

    drop(bundle);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn browser_cancellation_stops_the_child_and_allows_a_clean_restart() {
    clear_mcp_discovery_cache();
    let root = temp_dir().join("cancel-progress");
    let script = write_progress_mcp_server_script(&root);
    let python = if cfg!(windows) { "python" } else { "python3" };
    let feature_config = RuntimeFeatureConfig::default().with_mcp_servers(BTreeMap::from([(
        "playwright".to_string(),
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
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut bundle = attach_mcp_tools_with_cancel(
        StaticToolExecutor::new(),
        Vec::new(),
        &feature_config,
        None,
        Some(cancelled.clone()),
    );
    bundle.executor.timeout_policy_override = Some(McpToolTimeoutPolicy {
        idle_timeout: std::time::Duration::from_secs(1),
        hard_timeout: std::time::Duration::from_secs(2),
    });

    let cancellation_signal = cancelled.clone();
    let cancel_thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        cancellation_signal.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let error = bundle
        .executor
        .execute("mcp__playwright__browser_hang", "{}")
        .expect_err("cancelled browser call should stop");
    cancel_thread.join().expect("cancel thread");
    assert!(error.is_interrupted(), "{error}");
    assert!(!error.is_timed_out());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));

    // A real next turn creates a fresh flag and executor. Clearing this
    // test-owned flag exercises the equivalent process-respawn path in place.
    cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
    let recovered = bundle
        .executor
        .execute("mcp__playwright__browser_progress", "{}")
        .expect("manager should respawn after cancellation shutdown");
    assert!(recovered.contains("completed with progress"));

    drop(bundle);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn tool_search_results_include_discovered_mcp_tools() {
    let names = BTreeMap::from([
        (
            "mcp__playwright__browser_navigate".to_string(),
            "Navigate to a URL.".to_string(),
        ),
        (
            "mcp__playwright__browser_click".to_string(),
            "Click an element.".to_string(),
        ),
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
        &[],
    );
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");

    // One search returns the whole matching family, best match first, instead
    // of forcing a separate call per tool.
    assert_eq!(
        merged["matches"],
        json!([
            "mcp__playwright__browser_navigate",
            "mcp__playwright__browser_click"
        ])
    );
    assert_eq!(merged["total_deferred_tools"], 10);
    assert!(merged["pending_mcp_servers"].is_null());
}

/// Verbatim from a real session (`chat-1789320268388-4cgvxg`, call 7 of 13):
/// the model asked for six browser tools at once, the old all-terms-substring
/// filter matched no single name, and it then spent six more calls asking for
/// them one at a time.
#[test]
fn the_multi_tool_browser_query_that_used_to_return_nothing_returns_everything() {
    let catalog = [
        "mcp__playwright__browser_take_screenshot",
        "mcp__playwright__browser_resize",
        "mcp__playwright__browser_evaluate",
        "mcp__playwright__browser_click",
        "mcp__playwright__browser_snapshot",
        "mcp__playwright__browser_console_messages",
        "mcp__playwright__browser_navigate",
        "read_file",
    ]
    .into_iter()
    .map(|name| (name.to_string(), format!("{name} test tool")))
    .collect::<BTreeMap<_, _>>();

    let merged = merge_mcp_tool_search_results(
        json!({"matches": [], "query": "", "total_deferred_tools": 0}).to_string(),
        r#"{"max_results": 10, "query": "mcp__playwright__browser_take_screenshot browser_resize browser_evaluate browser_click browser_snapshot browser_console_messages"}"#,
        &catalog,
        &[],
    );
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");
    let matches = merged["matches"]
        .as_array()
        .expect("matches")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    for name in [
        "mcp__playwright__browser_take_screenshot",
        "mcp__playwright__browser_resize",
        "mcp__playwright__browser_evaluate",
        "mcp__playwright__browser_click",
        "mcp__playwright__browser_snapshot",
        "mcp__playwright__browser_console_messages",
    ] {
        assert!(matches.contains(&name), "{name} missing from {matches:?}");
    }
    // The tool named first is answered first, and an unrelated tool does not
    // crowd out a requested one.
    assert_eq!(matches[0], "mcp__playwright__browser_take_screenshot");
    assert!(!matches.contains(&"read_file"));
}

#[test]
fn tool_search_does_not_advertise_a_tool_this_turn_blocked() {
    let catalog = BTreeMap::from([("read_file".to_string(), "Read a text file.".to_string())]);
    // The kernel searches its whole tool list, including names this turn removed.
    let output = json!({"matches": ["bash", "read_file"], "query": "read", "total_deferred_tools": 40})
        .to_string();

    let merged = merge_mcp_tool_search_results(output, r#"{"query":"read"}"#, &catalog, &[]);
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");

    assert_eq!(merged["matches"], json!(["read_file"]));
}

#[test]
fn tool_search_activates_a_whole_browser_family_in_one_call() {
    let names = [
        "mcp__playwright__browser_navigate",
        "mcp__playwright__browser_snapshot",
        "mcp__playwright__browser_click",
        "mcp__playwright__browser_evaluate",
        "read_file",
    ]
    .into_iter()
    .map(|name| (name.to_string(), format!("{name} test tool")))
    .collect::<BTreeMap<_, _>>();
    let output = json!({"matches": [], "query": "", "total_deferred_tools": 0}).to_string();

    let merged = merge_mcp_tool_search_results(
        output,
        r#"{"query":"select:browser_navigate,browser_snapshot,browser_click,browser_evaluate"}"#,
        &names,
        &["codex".to_string()],
    );
    let merged: Value = serde_json::from_str(&merged).expect("merged search output");

    assert_eq!(
        merged["matches"],
        json!([
            "mcp__playwright__browser_navigate",
            "mcp__playwright__browser_snapshot",
            "mcp__playwright__browser_click",
            "mcp__playwright__browser_evaluate"
        ])
    );
    // A server that produced no tools is named, so the model stops searching
    // for something that cannot appear this turn.
    assert_eq!(merged["pending_mcp_servers"], json!(["codex"]));
}

#[test]
fn mcp_multimodal_content_stays_out_of_text_json() {
    let result = McpToolCallResult {
        content: vec![
            McpToolCallContent {
                kind: "text".to_string(),
                data: serde_json::from_value(json!({"text": "screenshot captured"}))
                    .expect("text content data"),
            },
            McpToolCallContent {
                kind: "image".to_string(),
                data: serde_json::from_value(json!({
                    "mimeType": "image/png",
                    "data": "aGVsbG8="
                }))
                .expect("image content data"),
            },
        ],
        structured_content: Some(json!({"width": 1440})),
        is_error: Some(true),
        meta: None,
    };

    let output = mcp_result_to_tool_output(result).expect("convert MCP output");
    assert!(output.reported_error);
    assert_eq!(output.media.len(), 1);
    assert!(matches!(output.media[0], ToolMedia::Image { .. }));
    assert!(output.text.contains("screenshot captured"));
    assert!(output.text.contains("1440"));
    assert!(!output.text.contains("aGVsbG8="));
}

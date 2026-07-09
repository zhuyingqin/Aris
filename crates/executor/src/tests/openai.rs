use super::*;
use runtime::{ApiClient, ApiRequest, ContentBlock, ConversationMessage, MessageRole};

#[test]
fn detects_context_window_exceeded_errors() {
    // The exact gmncode-style proxy envelope from the field report.
    assert!(is_context_window_exceeded_error(
        r#"{"type":"error","error":{"type":"bad_request_error","message":"invalid params, context window exceeds limit (2013)","http_code":"400"}}"#
    ));
    // OpenAI canonical structured code.
    assert!(is_context_window_exceeded_error(
        r#"{"error":{"message":"This model's maximum context length is 8192 tokens.","code":"context_length_exceeded"}}"#
    ));
    // Anthropic phrasing.
    assert!(is_context_window_exceeded_error(
        "prompt is too long: 250000 tokens > 200000 maximum"
    ));
    // Looser subject+verb fallback.
    assert!(is_context_window_exceeded_error(
        "the number of tokens exceeds the model limit"
    ));
    // Chinese phrasing.
    assert!(is_context_window_exceeded_error("上下文长度超过限制"));
}

#[test]
fn ignores_unrelated_errors() {
    assert!(!is_context_window_exceeded_error(""));
    assert!(!is_context_window_exceeded_error(
        r#"{"error":{"message":"invalid api key","code":"invalid_api_key"}}"#
    ));
    // A bare "token" mention without an over-limit verb must not match.
    assert!(!is_context_window_exceeded_error("your token was rejected"));
    assert!(!is_context_window_exceeded_error("rate limit exceeded"));
}

#[test]
fn convert_messages_drops_system_role_in_messages_array() {
    // Regression: before v0.4.2 the auto-compaction continuation message
    // was role=System and was silently dropped here, erasing the summary.
    let messages = vec![
        ConversationMessage {
            role: MessageRole::System,
            blocks: vec![ContentBlock::Text {
                text: "compaction summary".into(),
            }],
            usage: None,
        },
        ConversationMessage::user_text("next question"),
    ];
    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());
    // Should contain only the User message; the System one is skipped.
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["role"], "user");
    assert!(result[0]["content"]
        .as_str()
        .unwrap_or("")
        .contains("next question"));
}

#[test]
fn resolve_base_url_falls_back_for_empty_or_whitespace() {
    use std::sync::Mutex;
    // Serialize env mutation to avoid cross-test races.
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();

    let prior_provider = std::env::var("EXECUTOR_PROVIDER").ok();
    let prior_api_key = std::env::var("EXECUTOR_API_KEY").ok();
    let prior_base_url = std::env::var("EXECUTOR_BASE_URL").ok();

    std::env::set_var("EXECUTOR_PROVIDER", "openai");
    std::env::set_var("EXECUTOR_API_KEY", "sk-test");

    // Empty string → falls back to default.
    std::env::set_var("EXECUTOR_BASE_URL", "");
    let cfg = resolve_openai_executor_config().expect("config");
    assert_eq!(cfg.base_url, DEFAULT_OPENAI_BASE_URL);

    // Whitespace-only → falls back to default.
    std::env::set_var("EXECUTOR_BASE_URL", "   ");
    let cfg = resolve_openai_executor_config().expect("config");
    assert_eq!(cfg.base_url, DEFAULT_OPENAI_BASE_URL);

    // Whitespace-padded custom URL → trimmed.
    std::env::set_var("EXECUTOR_BASE_URL", "  https://gmncode.cn  ");
    let cfg = resolve_openai_executor_config().expect("config");
    assert_eq!(cfg.base_url, "https://gmncode.cn");

    // Restore prior state to avoid polluting sibling tests.
    match prior_provider {
        Some(v) => std::env::set_var("EXECUTOR_PROVIDER", v),
        None => std::env::remove_var("EXECUTOR_PROVIDER"),
    }
    match prior_api_key {
        Some(v) => std::env::set_var("EXECUTOR_API_KEY", v),
        None => std::env::remove_var("EXECUTOR_API_KEY"),
    }
    match prior_base_url {
        Some(v) => std::env::set_var("EXECUTOR_BASE_URL", v),
        None => std::env::remove_var("EXECUTOR_BASE_URL"),
    }
}

#[test]
fn convert_messages_preserves_user_role_continuation() {
    // After v0.4.2, the continuation uses User role and must survive.
    let messages = vec![
        ConversationMessage {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text {
                text: "compaction summary".into(),
            }],
            usage: None,
        },
        ConversationMessage::user_text("next question"),
    ];
    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());
    // Both User messages present.
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["role"], "user");
    assert!(result[0]["content"]
        .as_str()
        .unwrap_or("")
        .contains("compaction summary"));
    assert_eq!(result[1]["role"], "user");
}

#[test]
fn convert_messages_preserves_valid_failed_tool_result() {
    let messages = vec![
        ConversationMessage::user_text("run the tool"),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "call-valid".to_string(),
            name: "probe".to_string(),
            input: "{}".to_string(),
        }]),
        ConversationMessage::tool_result("call-valid", "probe", "tool failed", true),
        ConversationMessage::user_text("continue"),
    ];

    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());

    assert_eq!(result.len(), 4);
    assert_eq!(result[1]["role"], "assistant");
    assert_eq!(result[1]["tool_calls"][0]["id"], "call-valid");
    assert_eq!(result[2]["role"], "tool");
    assert_eq!(result[2]["tool_call_id"], "call-valid");
    assert_eq!(result[2]["content"], "tool failed");
    assert_eq!(result[3]["role"], "user");
}

#[test]
fn convert_messages_repairs_dangling_tool_call_before_next_user() {
    let messages = vec![
        ConversationMessage::user_text("run the tool"),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "call-dangling".to_string(),
            name: "probe".to_string(),
            input: "{}".to_string(),
        }]),
        ConversationMessage::user_text("continue after the crash"),
    ];

    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());

    assert_eq!(result.len(), 4);
    assert_eq!(result[1]["role"], "assistant");
    assert_eq!(result[1]["tool_calls"][0]["id"], "call-dangling");
    assert_eq!(result[2]["role"], "tool");
    assert_eq!(result[2]["tool_call_id"], "call-dangling");
    assert!(result[2]["content"]
        .as_str()
        .unwrap_or_default()
        .contains("stopped before ARIS recorded a result"));
    assert_eq!(result[3]["role"], "user");
    assert_eq!(result[3]["content"], "continue after the crash");
}

#[test]
fn convert_messages_downgrades_orphan_tool_result() {
    let messages = vec![
        ConversationMessage::tool_result("call-orphan", "probe", "late output", false),
        ConversationMessage::user_text("continue"),
    ];

    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());

    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["role"], "user");
    let recovered = result[0]["content"].as_str().unwrap_or_default();
    assert!(recovered.contains("orphan tool result"));
    assert!(recovered.contains("late output"));
    assert_eq!(result[1]["role"], "user");
    assert_eq!(result[1]["content"], "continue");
}

#[test]
fn convert_messages_maps_images_to_openai_image_url_blocks() {
    let messages = vec![ConversationMessage::user_blocks(vec![
        ContentBlock::Text {
            text: "describe this".into(),
        },
        ContentBlock::Image {
            media_type: "image/png".into(),
            data: "ZmFrZQ==".into(),
        },
    ])];

    let result = convert_messages_openai(&messages, None, &std::collections::HashMap::new());

    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["role"], "user");
    assert_eq!(result[0]["content"][0]["type"], "text");
    assert_eq!(result[0]["content"][0]["text"], "describe this");
    assert_eq!(result[0]["content"][1]["type"], "image_url");
    assert_eq!(
        result[0]["content"][1]["image_url"]["url"],
        "data:image/png;base64,ZmFrZQ=="
    );
}

#[test]
#[ignore = "requires ARIS_LIVE_LLM_TEST=1 and real OpenAI-compatible executor credentials"]
fn live_openai_failure_context_diagnostics() {
    let Some((config, model)) = live_openai_test_config() else {
        eprintln!(
            "skipping live diagnostic: set ARIS_LIVE_LLM_TEST=1 and configure EXECUTOR_API_KEY/OPENAI_API_KEY plus EXECUTOR_MODEL, or ~/.config/aris/config.json"
        );
        return;
    };
    eprintln!(
        "live diagnostic using model `{model}` at `{}`",
        config.base_url
    );

    let baseline = run_live_openai_case(
        &config,
        &model,
        false,
        vec![ConversationMessage::user_text(
            "Reply with one short sentence containing the token ARIS_LIVE_BASELINE_OK.",
        )],
    )
    .expect("baseline live call should succeed");
    eprintln!("baseline accepted: {}", short_for_log(&baseline));
    assert!(
        !baseline.trim().is_empty(),
        "baseline should return visible assistant text"
    );

    let valid_failed_tool_history = vec![
        ConversationMessage::user_text(
            "Use the prior tool result as context. Do not call another tool.",
        ),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "call_aris_probe_1".to_string(),
            name: "aris_probe".to_string(),
            input: r#"{"action":"simulate_unexpected_failure"}"#.to_string(),
        }]),
        ConversationMessage::tool_result(
            "call_aris_probe_1",
            "aris_probe",
            "simulated unexpected tool failure: process exited with status 1",
            true,
        ),
        ConversationMessage::user_text(
            "Acknowledge that the failed tool result is present, then answer with ARIS_LIVE_TOOL_FAILURE_OK.",
        ),
    ];
    let recovered = run_live_openai_case(&config, &model, true, valid_failed_tool_history)
        .expect("valid failed-tool history should be accepted by the provider");
    eprintln!(
        "failed-tool history accepted: {}",
        short_for_log(&recovered)
    );
    assert!(
        !recovered.trim().is_empty(),
        "valid failed-tool history should produce visible assistant text"
    );

    let dangling_tool_call_history = vec![
        ConversationMessage::user_text("Prepare to call the diagnostic tool."),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "call_aris_probe_dangling".to_string(),
            name: "aris_probe".to_string(),
            input: r#"{"action":"left_without_tool_result"}"#.to_string(),
        }]),
        ConversationMessage::user_text(
            "Continue after the failed task. This intentionally omits the required tool result.",
        ),
    ];
    let raw_dangling_body = json!({
        "model": model,
        "stream": true,
        "messages": [
            {"role": "system", "content": live_openai_system_prompt()},
            {"role": "user", "content": "Prepare to call the diagnostic tool."},
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_aris_probe_dangling",
                    "type": "function",
                    "function": {
                        "name": "aris_probe",
                        "arguments": r#"{"action":"left_without_tool_result"}"#,
                    },
                }],
            },
            {"role": "user", "content": "Continue after the failed task. This intentionally omits the required tool result."},
        ],
        "tools": live_openai_tool_specs_json(),
        "tool_choice": "auto",
    });
    let (raw_status, raw_error) = post_raw_live_openai_body(&config, raw_dangling_body)
        .expect("raw live diagnostic request should complete");
    eprintln!(
        "raw dangling tool-call history rejected: status={raw_status} error={}",
        short_for_log(&raw_error)
    );
    assert_eq!(
        raw_status, 400,
        "raw dangling tool-call history should be rejected before executor repair"
    );
    assert!(raw_error.to_ascii_lowercase().contains("tool"));

    let repaired = run_live_openai_case(&config, &model, true, dangling_tool_call_history)
        .expect("executor should repair dangling tool-call history before sending");
    eprintln!(
        "dangling tool-call history repaired and accepted: {}",
        short_for_log(&repaired)
    );
    assert!(!repaired.trim().is_empty());
}

fn live_openai_test_config() -> Option<(OpenAIExecutorConfig, String)> {
    if std::env::var("ARIS_LIVE_LLM_TEST").ok().as_deref() != Some("1") {
        return None;
    }

    let config_json = read_aris_config_json();
    let from_config = |key: &str| -> Option<String> {
        config_json
            .as_ref()
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    let env_value = |key: &str| -> Option<String> {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let api_key = env_value("EXECUTOR_API_KEY")
        .or_else(|| env_value("OPENAI_API_KEY"))
        .or_else(|| from_config("executor_api_key"))?;
    let base_url = env_value("EXECUTOR_BASE_URL")
        .or_else(|| from_config("executor_base_url"))
        .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());
    let model = env_value("ARIS_LIVE_LLM_MODEL")
        .or_else(|| env_value("EXECUTOR_MODEL"))
        .or_else(|| from_config("executor_model"))?;

    Some((OpenAIExecutorConfig { api_key, base_url }, model))
}

fn read_aris_config_json() -> Option<Value> {
    let path = std::path::PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("config.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn run_live_openai_case(
    config: &OpenAIExecutorConfig,
    model: &str,
    enable_tools: bool,
    messages: Vec<ConversationMessage>,
) -> Result<String, RuntimeError> {
    let mut client = live_openai_client(config, model, enable_tools);
    let events = client.stream(ApiRequest {
        system_prompt: vec![live_openai_system_prompt()],
        messages,
    })?;
    Ok(assistant_text_from_events(&events))
}

fn live_openai_client(
    config: &OpenAIExecutorConfig,
    model: &str,
    enable_tools: bool,
) -> OpenAIRuntimeClient {
    let tool_specs = enable_tools
        .then(|| {
            vec![crate::ExecutorToolSpec::new(
                "aris_probe",
                "Diagnostic no-op tool used only to validate OpenAI-compatible tool-call history.",
                live_openai_tool_schema_json(),
            )]
        })
        .unwrap_or_default();
    OpenAIRuntimeClient::new(
        config.clone(),
        model.to_string(),
        enable_tools,
        tool_specs,
        Box::new(crate::NoopStreamObserver),
    )
    .expect("live OpenAI runtime client should construct")
}

fn live_openai_tool_schema_json() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string" }
        },
        "additionalProperties": true
    })
}

fn live_openai_tool_specs_json() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "aris_probe",
            "description": "Diagnostic no-op tool used only to validate OpenAI-compatible tool-call history.",
            "parameters": live_openai_tool_schema_json(),
        },
    }])
}

fn post_raw_live_openai_body(
    config: &OpenAIExecutorConfig,
    body: Value,
) -> Result<(u16, String), String> {
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let response = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?
            .post(url)
            .bearer_auth(&config.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| error.to_string())?;
        Ok((status, text))
    })
}

fn live_openai_system_prompt() -> String {
    "You are running a live diagnostic for ARIS. Keep replies under 20 words. Do not call tools unless the user explicitly asks you to.".to_string()
}

fn assistant_text_from_events(events: &[AssistantEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            AssistantEvent::TextDelta(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn short_for_log(value: &str) -> String {
    const MAX_CHARS: usize = 500;
    let mut shortened = value.chars().take(MAX_CHARS).collect::<String>();
    if value.chars().count() > MAX_CHARS {
        shortened.push_str("...");
    }
    shortened.replace('\n', "\\n")
}

// v0.4.13 regression — v0.4.12 P1.B promoted the o-series detector
// from a bare `contains()` to a word-boundary check so that
// provider-prefixed (`openai/o3-mini`) and proxy-prefixed
// (`proxy:o4-preview`) names still resolve, but mid-word collisions
// (`foo-o3bar`, `o32-mini`) don't accidentally route. Pin every
// boundary case so a future tightening of the boundary set can't
// silently flip executor capability detection.
#[test]
fn word_match_handles_provider_prefixes() {
    // Provider/proxy prefixed forms — `/` and `:` are valid boundaries.
    assert!(word_match("openai/o3-mini", "o3"));
    assert!(word_match("proxy:o4-preview", "o4"));
    // `-` boundary at the start.
    assert!(word_match("o1-mini", "o1"));
    // Mid-word `o3` substring (no boundary before) — must NOT match.
    assert!(!word_match("foo-o3bar", "o3"));
    // Digit-suffix collision (`o32-mini` contains "o3" but the next
    // byte is a digit, not a boundary char) — must NOT match.
    assert!(!word_match("o32-mini", "o3"));
    // Trailing boundary on the needle.
    assert!(word_match("o3-", "o3"));
    // Exact-equality (start-of-string + end-of-string boundaries).
    assert!(word_match("o3", "o3"));
}

// v0.4.13 regression — v0.4.12 added the JSON-first stream_options
// rejection detector. The classifier has three branches and a fail-
// safe; pin all of them so a refactor can't silently relax detection.
#[test]
fn openai_usage_normalizes_cached_prompt_tokens() {
    let usage = token_usage_from_openai_usage(&json!({
        "prompt_tokens": 1000,
        "completion_tokens": 80,
        "prompt_tokens_details": { "cached_tokens": 600 }
    }));

    assert_eq!(usage.input_tokens, 400);
    assert_eq!(usage.output_tokens, 80);
    assert_eq!(usage.cache_read_input_tokens, 600);
    assert_eq!(usage.prompt_tokens(), 1000);
}

#[test]
fn openai_usage_clamps_malformed_cache_counts() {
    let usage = token_usage_from_openai_usage(&json!({
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "prompt_tokens_details": { "cached_tokens": 200 }
    }));

    assert_eq!(usage.input_tokens, 0);
    assert_eq!(usage.cache_read_input_tokens, 200);
}

#[test]
fn is_stream_options_unknown_field_error_classification() {
    // JSON path: error.param == "stream_options" (exact match).
    assert!(is_stream_options_unknown_field_error(
        r#"{"error":{"message":"x","param":"stream_options","type":"invalid_request_error"}}"#
    ));
    // JSON path: error.param starts_with "stream_options" (deep field
    // like `stream_options.include_usage`).
    assert!(is_stream_options_unknown_field_error(
        r#"{"error":{"param":"stream_options.include_usage","message":"x"}}"#
    ));
    // Text path: body contains "stream_options" + a reject keyword.
    assert!(is_stream_options_unknown_field_error(
        "{\"error\": \"unknown field stream_options\"}"
    ));
    // Negative: 400 about something else entirely.
    assert!(!is_stream_options_unknown_field_error(
        r#"{"error":{"message":"invalid api key","type":"auth_error"}}"#
    ));
    // Negative: contains "stream_options" but no reject keyword.
    assert!(!is_stream_options_unknown_field_error(
        r#"{"error":{"message":"stream_options ok"}}"#
    ));
    // Negative: empty body must not classify (fail-safe).
    assert!(!is_stream_options_unknown_field_error(""));
}

// #249 v0.4.15: clean-EOF completion-vs-truncation truth table.
// Mirrors api/src/client.rs should_retry_on_premature_eof_truth_table.
// Columns: observed_done × observed_finish_reason × nothing_emitted ×
//          retries_remaining → StreamEofAction.
#[test]
fn stream_eof_action_truth_table() {
    use StreamEofAction::*;

    // --- Completion via [DONE] (legacy / OpenAI canonical) ---
    // [DONE] seen → Complete regardless of finish_reason / emitted / retries.
    assert_eq!(stream_eof_action(true, false, false, 2), Complete);
    assert_eq!(stream_eof_action(true, false, true, 0), Complete);
    assert_eq!(stream_eof_action(true, true, false, 2), Complete);

    // --- Completion via finish_reason, NO [DONE] (#249 MiniMax core) ---
    // finish_reason seen + content emitted + clean EOF → Complete, NOT error.
    assert_eq!(stream_eof_action(false, true, false, 2), Complete);
    // finish_reason seen even with retries exhausted → still Complete.
    assert_eq!(stream_eof_action(false, true, false, 0), Complete);
    // finish_reason seen and nothing emitted (terminal-only choice) →
    // Complete (don't waste a restart on a finished-but-empty response).
    assert_eq!(stream_eof_action(false, true, true, 2), Complete);

    // --- Genuine truncation: NEITHER signal, content already emitted ---
    // Cannot restart (would duplicate output) → Truncated (hard error).
    assert_eq!(stream_eof_action(false, false, false, 2), Truncated);
    assert_eq!(stream_eof_action(false, false, false, 0), Truncated);

    // --- Proxy abort before any output: NEITHER signal, nothing emitted ---
    // Restart if budget remains, else Truncated.
    assert_eq!(stream_eof_action(false, false, true, 2), Restart);
    assert_eq!(stream_eof_action(false, false, true, 1), Restart);
    assert_eq!(stream_eof_action(false, false, true, 0), Truncated);
}

// OE4 (#249): mid-stream error envelope detection.
#[test]
fn stream_error_detail_classification() {
    use serde_json::json;
    // Normal data chunk → None.
    assert_eq!(
        stream_error_detail(&json!({"choices": [{"delta": {"content": "hi"}}]})),
        None
    );
    // No error key → None.
    assert_eq!(
        stream_error_detail(&json!({"usage": {"prompt_tokens": 1}})),
        None
    );
    // Explicit null error → None (some providers send `error: null`).
    assert_eq!(stream_error_detail(&json!({"error": null})), None);
    // Error object with message + string code.
    assert_eq!(
        stream_error_detail(&json!({"error": {"message": "rate limited", "code": "rate_limit"}})),
        Some("rate limited (rate_limit)".to_string())
    );
    // Error object with integer code (providers vary).
    assert_eq!(
        stream_error_detail(&json!({"error": {"message": "bad", "code": 400}})),
        Some("bad (400)".to_string())
    );
    // Error object with `type` fallback when no `code`.
    assert_eq!(
        stream_error_detail(
            &json!({"error": {"message": "nope", "type": "invalid_request_error"}})
        ),
        Some("nope (invalid_request_error)".to_string())
    );
    // Error object message only.
    assert_eq!(
        stream_error_detail(&json!({"error": {"message": "boom"}})),
        Some("boom".to_string())
    );
    // Bare string error (some proxies).
    assert_eq!(
        stream_error_detail(&json!({"error": "upstream exploded"})),
        Some("upstream exploded".to_string())
    );
    // Error object with neither message nor code → placeholder.
    assert_eq!(
        stream_error_detail(&json!({"error": {"foo": "bar"}})),
        Some("(no message)".to_string())
    );
}

#[test]
fn classifies_retryable_mid_stream_errors() {
    // The exact field report: a content-sensitivity filter aborts the
    // stream. `stream_error_detail` renders it as "msg (code)".
    let detail = stream_error_detail(&json!({
        "error": {"message": "output new_sensitive", "code": "1027", "type": "unprocessable_entity_error"}
    }))
    .expect("error envelope");
    assert!(stream_error_is_retryable(&detail));

    // Other moderation / transient phrasings.
    assert!(stream_error_is_retryable("content_filter triggered"));
    assert!(stream_error_is_retryable("内容审核未通过：敏感"));
    assert!(stream_error_is_retryable(
        "service unavailable, try again later"
    ));
    assert!(stream_error_is_retryable("upstream timeout"));

    // Permanent failures must NOT be retried.
    assert!(!stream_error_is_retryable("invalid api key"));
    assert!(!stream_error_is_retryable("insufficient quota"));
    assert!(!stream_error_is_retryable("model not found"));
}

// OE7 (#249): finish_reason read independently of `delta`.
#[test]
fn choice_finish_reason_handles_delta_less_and_empty() {
    use serde_json::json;
    // Terminal choice with finish_reason and NO delta — the core OE7
    // case: must still be recognized.
    assert_eq!(
        choice_finish_reason(&json!({"finish_reason": "stop"})),
        Some("stop")
    );
    // Non-standard terminal value still recognized.
    assert_eq!(
        choice_finish_reason(&json!({"finish_reason": "length"})),
        Some("length")
    );
    // finish_reason alongside a delta.
    assert_eq!(
        choice_finish_reason(&json!({"delta": {"content": "x"}, "finish_reason": "tool_calls"})),
        Some("tool_calls")
    );
    // Empty string finish_reason → None (not a terminal signal).
    assert_eq!(choice_finish_reason(&json!({"finish_reason": ""})), None);
    // Null finish_reason (mid-stream chunk) → None.
    assert_eq!(
        choice_finish_reason(&json!({"delta": {"content": "x"}, "finish_reason": null})),
        None
    );
    // Absent finish_reason → None.
    assert_eq!(
        choice_finish_reason(&json!({"delta": {"content": "x"}})),
        None
    );
}

#[test]
fn truncating_finish_reasons_do_not_flush_pending_tool_payloads() {
    assert!(finish_reason_may_have_partial_tool_payload("length"));
    assert!(finish_reason_may_have_partial_tool_payload("max_output"));
    assert!(finish_reason_may_have_partial_tool_payload(
        "max_output_tokens"
    ));
    assert!(finish_reason_may_have_partial_tool_payload(
        "content_filter"
    ));
    assert!(finish_reason_may_have_partial_tool_payload(
        "stream_truncated"
    ));
    assert!(finish_reason_may_have_partial_tool_payload(
        "stream_error_after_partial_output"
    ));

    assert!(!finish_reason_may_have_partial_tool_payload("stop"));
    assert!(!finish_reason_may_have_partial_tool_payload("tool_calls"));
}

// Tool-call delta accumulation across chunks.
#[test]
fn accumulate_tool_call_builds_and_concatenates() {
    use serde_json::json;
    let mut pending: Vec<(String, String, String)> = Vec::new();

    // First delta: id + name + partial args.
    accumulate_tool_call(
        &mut pending,
        &json!({"index": 0, "id": "call_1", "function": {"name": "search", "arguments": "{\"q\":"}}),
    );
    // Second delta (same index): only more args — id/name must persist,
    // args concatenate.
    accumulate_tool_call(
        &mut pending,
        &json!({"index": 0, "function": {"arguments": "\"rust\"}"}}),
    );
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0, "call_1");
    assert_eq!(pending[0].1, "search");
    assert_eq!(pending[0].2, "{\"q\":\"rust\"}");

    // A second tool at index 1 must not clobber index 0.
    accumulate_tool_call(
        &mut pending,
        &json!({"index": 1, "id": "call_2", "function": {"name": "fetch", "arguments": "{}"}}),
    );
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].0, "call_1"); // unchanged
    assert_eq!(pending[1].0, "call_2");
    assert_eq!(pending[1].1, "fetch");
    assert_eq!(pending[1].2, "{}");

    // Missing index defaults to slot 0 (OpenAI always sends index; this
    // is the documented fallback, not a guarantee of correctness for
    // parallel tool calls — see OE6 deferred to v0.4.16).
    let mut p2: Vec<(String, String, String)> = Vec::new();
    accumulate_tool_call(&mut p2, &json!({"id": "x", "function": {"name": "n"}}));
    assert_eq!(p2.len(), 1);
    assert_eq!(p2[0].0, "x");
}

// OE3 (#249): SSE `data:` payload parsing tolerates missing space.
#[test]
fn sse_data_payload_tolerates_missing_space() {
    // Canonical OpenAI form (one space).
    assert_eq!(sse_data_payload("data: {\"x\":1}"), Some("{\"x\":1}"));
    // No space after colon (OE3 core — some compat providers).
    assert_eq!(sse_data_payload("data:{\"x\":1}"), Some("{\"x\":1}"));
    // [DONE] sentinel both ways.
    assert_eq!(sse_data_payload("data: [DONE]"), Some("[DONE]"));
    assert_eq!(sse_data_payload("data:[DONE]"), Some("[DONE]"));
    // Extra surrounding whitespace is trimmed.
    assert_eq!(sse_data_payload("data:   spaced  "), Some("spaced"));
    // Empty payload (harmless — serde parse fails downstream, skipped).
    assert_eq!(sse_data_payload("data:"), Some(""));
    // Non-data field lines → None (loop skips them).
    assert_eq!(sse_data_payload("event: message"), None);
    assert_eq!(sse_data_payload("id: 42"), None);
    assert_eq!(sse_data_payload("retry: 1000"), None);
    // A field that merely starts with "data" but isn't "data:" → None.
    assert_eq!(sse_data_payload("database: x"), None);
    // Blank / comment lines → None.
    assert_eq!(sse_data_payload(""), None);
    assert_eq!(sse_data_payload(": keep-alive"), None);
}

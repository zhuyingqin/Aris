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
    // Bare Chinese "上下文" without an over-limit verb must not misfire
    // force-compaction (e.g. an unrelated context-load error).
    assert!(!is_context_window_exceeded_error("上下文加载失败，请重试"));
}

#[test]
fn convert_messages_preserves_internal_system_instructions() {
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
    let result = convert_messages_openai(&messages, None, "MiniMax-M3");
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["role"], "system");
    assert_eq!(result[0]["content"], "compaction summary");
    assert_eq!(result[1]["role"], "user");
    assert!(result[1]["content"]
        .as_str()
        .unwrap_or("")
        .contains("next question"));
}

#[test]
fn openai_reasoning_tool_models_use_responses_on_compatible_gateways() {
    assert!(uses_openai_responses_api(
        "https://api.openai.com/v1",
        "gpt-5.6-sol",
        true,
    ));
    assert!(uses_openai_responses_api(
        "https://api.openai.com/v1/",
        "o4-mini",
        true,
    ));
    assert!(uses_openai_responses_api(
        "https://proxy.example/v1",
        "gpt-5.6-sol",
        true,
    ));
    assert!(!uses_openai_responses_api(
        "https://api.openai.com/v1",
        "gpt-5.6-sol",
        false,
    ));
    assert!(!uses_openai_responses_api(
        "https://proxy.example/v1",
        "deepseek-reasoner",
        true,
    ));
    assert!(!uses_openai_responses_api(
        "https://proxy.example/v1",
        "MiniMax-M3",
        true,
    ));
}

#[test]
fn responses_messages_replay_reasoning_and_pair_tool_outputs() {
    let signature = encode_responses_reasoning_signature(
        &[json!({
            "type": "reasoning",
            "id": "rs-1",
            "encrypted_content": "opaque",
            "summary": [],
        })],
        "gpt-5.6-sol",
    )
    .expect("encoded reasoning signature");
    let messages = vec![
        ConversationMessage::user_text("inspect the workspace"),
        ConversationMessage::assistant(vec![
            ContentBlock::Thinking {
                thinking: "inspect files".to_string(),
                signature,
            },
            ContentBlock::ToolUse {
                id: "call-1".to_string(),
                name: "bash".to_string(),
                input: r#"{"command":"cargo check"}"#.to_string(),
            },
        ]),
        ConversationMessage::tool_result("call-1", "bash", "finished", false),
    ];

    let result = convert_messages_responses(&messages, "gpt-5.6-sol");

    assert_eq!(result[1]["type"], "reasoning");
    assert_eq!(result[2]["type"], "function_call");
    assert_eq!(result[2]["call_id"], "call-1");
    assert_eq!(result[3]["type"], "function_call_output");
    assert_eq!(result[3]["call_id"], "call-1");
    assert_eq!(result[3]["output"], "finished");
}

#[test]
fn responses_reasoning_signature_is_provider_scoped_and_filters_item_types() {
    let signature = encode_responses_reasoning_signature(
        &[
            json!({
                "type": "reasoning",
                "id": "rs-1",
                "encrypted_content": "opaque",
            }),
            json!({
                "type": "function_call",
                "call_id": "must-not-be-injected",
            }),
        ],
        "gpt-5.6-sol",
    )
    .expect("signature");
    let decoded = decode_responses_reasoning_signature(&signature, "gpt-5.6-sol");
    assert_eq!(decoded.len(), 1);
    assert_eq!(decoded[0]["type"], "reasoning");
    assert!(decode_responses_reasoning_signature("anthropic-signature", "gpt-5.6-sol").is_empty());
}

#[test]
fn responses_reasoning_signature_v2_is_dropped_for_a_different_model() {
    // Encrypted reasoning is model-specific; replaying it onto another model
    // makes the Responses API 400. A v2 signature carries the producer model so
    // decode drops it when the target model differs (B1).
    let signature = encode_responses_reasoning_signature(
        &[json!({
            "type": "reasoning",
            "id": "rs-1",
            "encrypted_content": "opaque",
        })],
        "gpt-5.5",
    )
    .expect("signature");

    // Same model: replayed.
    assert_eq!(
        decode_responses_reasoning_signature(&signature, "gpt-5.5").len(),
        1
    );
    // Switched model: dropped rather than replayed onto the wrong model.
    assert!(decode_responses_reasoning_signature(&signature, "gpt-5.6-sol").is_empty());
}

#[test]
fn responses_reasoning_signature_v1_legacy_is_replayed_regardless_of_model() {
    // Pre-v2 blocks are a bare array with no model tag. They must still replay
    // (rewriting them would change historical bytes and break prefix caching);
    // the runtime self-heal covers a cross-model rejection instead.
    let legacy = format!(
        "{}{}",
        "openai-responses-reasoning:",
        serde_json::to_string(&[json!({
            "type": "reasoning",
            "id": "rs-legacy",
            "encrypted_content": "opaque",
        })])
        .unwrap()
    );
    let decoded = decode_responses_reasoning_signature(&legacy, "any-model");
    assert_eq!(decoded.len(), 1);
    assert_eq!(decoded[0]["id"], "rs-legacy");
}

#[test]
fn reasoning_item_rejection_matches_ordering_and_encrypted_errors() {
    // Ordering violation (multi-tool turn / hand-edited session).
    assert!(is_reasoning_item_rejected(
        r#"{"error":{"message":"Item 'rs_abc' of type 'reasoning' was provided without its required following item.","type":"invalid_request_error","param":"input"}}"#
    ));
    // Cross-model / stale encrypted content.
    assert!(is_reasoning_item_rejected(
        r#"{"error":{"message":"Invalid value: the encrypted reasoning content could not be decrypted for this model."}}"#
    ));
    // Non-JSON body fallback.
    assert!(is_reasoning_item_rejected(
        "reasoning item was provided without its required following item"
    ));

    // Unrelated 400s must NOT be swallowed behind a silent retry.
    assert!(!is_reasoning_item_rejected(
        r#"{"error":{"message":"Invalid schema for function 'bash': 'command' is required.","param":"tools"}}"#
    ));
    assert!(!is_reasoning_item_rejected(
        r#"{"error":{"message":"You exceeded your current quota."}}"#
    ));
    // Mentions reasoning but carries no structural marker → not a replay reject.
    assert!(!is_reasoning_item_rejected(
        r#"{"error":{"message":"reasoning_effort must be one of low, medium, high."}}"#
    ));
    assert!(!is_reasoning_item_rejected(""));
}

#[test]
fn strip_reasoning_items_removes_only_reasoning_and_reports_change() {
    let mut body = json!({
        "model": "gpt-5.6-sol",
        "input": [
            { "type": "reasoning", "id": "rs-1", "encrypted_content": "opaque" },
            { "role": "user", "content": "hello" },
            { "type": "function_call", "call_id": "call-1", "name": "bash", "arguments": "{}" },
        ],
    });
    assert!(strip_reasoning_items_from_responses_body(&mut body));
    let input = body["input"].as_array().expect("input array");
    assert_eq!(input.len(), 2);
    assert!(input
        .iter()
        .all(|item| item.get("type").and_then(|t| t.as_str()) != Some("reasoning")));

    // Idempotent: a second strip removes nothing and reports no change (so the
    // send loop's retry cannot loop).
    assert!(!strip_reasoning_items_from_responses_body(&mut body));

    // No `input` key (chat/completions body) → no change.
    let mut chat = json!({ "model": "gpt-5.6-sol", "messages": [] });
    assert!(!strip_reasoning_items_from_responses_body(&mut chat));
}

#[test]
fn responses_prompt_cache_key_is_stable_for_appended_history() {
    let first = ConversationMessage::user_text("stable mission");
    let initial = vec![first.clone()];
    let appended = vec![
        first,
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "progress".to_string(),
        }]),
        ConversationMessage::user_text("continue"),
    ];

    let key = responses_prompt_cache_key("gpt-5.6-terra", Some("system"), &initial);
    assert_eq!(
        key,
        responses_prompt_cache_key("gpt-5.6-terra", Some("system"), &appended)
    );
    assert_ne!(
        key,
        responses_prompt_cache_key(
            "gpt-5.6-terra",
            Some("system"),
            &[ConversationMessage::user_text("different mission")],
        )
    );
}

#[test]
fn responses_messages_use_native_image_and_function_shapes() {
    let messages = vec![ConversationMessage::user_blocks(vec![
        ContentBlock::Text {
            text: "inspect".into(),
        },
        ContentBlock::Image {
            media_type: "image/png".into(),
            data: "ZmFrZQ==".into(),
        },
    ])];
    let result = convert_messages_responses(&messages, "gpt-5.6-sol");
    assert_eq!(result[0]["content"][0]["type"], "input_text");
    assert_eq!(result[0]["content"][1]["type"], "input_image");
    assert_eq!(
        result[0]["content"][1]["image_url"],
        "data:image/png;base64,ZmFrZQ=="
    );

    let spec = ExecutorToolSpec::new(
        "bash",
        "Run a command",
        json!({ "type": "object", "properties": {} }),
    );
    let converted = convert_tool_spec_responses(&spec);
    assert_eq!(converted["type"], "function");
    assert_eq!(converted["name"], "bash");
    assert_eq!(converted["strict"], false);
    assert!(converted.get("function").is_none());
}

#[test]
fn responses_stream_helpers_extract_tools_failures_and_cached_usage() {
    let tool = responses_tool_call_from_output_item(&json!({
        "type": "function_call",
        "id": "fc-1",
        "call_id": "call-1",
        "name": "bash",
        "arguments": "{}",
    }))
    .expect("function call");
    assert_eq!(
        tool,
        ("call-1".to_string(), "bash".to_string(), "{}".to_string())
    );

    let failure = responses_stream_error_detail(&json!({
        "type": "response.failed",
        "response": { "error": { "message": "bad request", "code": "invalid" } }
    }));
    assert_eq!(failure.as_deref(), Some("bad request (invalid)"));

    let usage = token_usage_from_openai_usage(&json!({
        "input_tokens": 1_000,
        "output_tokens": 200,
        "input_tokens_details": { "cached_tokens": 400 }
    }));
    assert_eq!(usage.input_tokens, 600);
    assert_eq!(usage.cache_read_input_tokens, 400);
    assert_eq!(usage.output_tokens, 200);
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
    let result = convert_messages_openai(&messages, None, "MiniMax-M3");
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

    let result = convert_messages_openai(&messages, None, "MiniMax-M3");

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

    let result = convert_messages_openai(&messages, None, "MiniMax-M3");

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

    let result = convert_messages_openai(&messages, None, "MiniMax-M3");

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

    let result = convert_messages_openai(&messages, None, "MiniMax-M3");

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

#[test]
#[ignore = "requires ARIS_LIVE_LLM_TEST=1 and a Responses-capable GPT executor"]
fn live_responses_reasoning_survives_client_rebuild() {
    let Some((config, model)) = live_openai_test_config() else {
        return;
    };
    assert!(
        uses_openai_responses_api(&config.base_url, &model, true),
        "live persistence diagnostic requires a GPT/o Responses model"
    );

    let prompt = "Compute (137 * 89) - (47 * 23). Then call aris_probe exactly once with the integer result encoded as action result:<integer>. Do not answer before the tool call.";
    let mut first_client = live_openai_client(&config, &model, true);
    let first_events = first_client
        .stream(ApiRequest {
            system_prompt: vec![live_openai_system_prompt()],
            messages: vec![ConversationMessage::user_text(prompt)],
        })
        .expect("first Responses tool request");

    let mut blocks = Vec::new();
    let mut tool = None;
    for event in first_events {
        match event {
            AssistantEvent::Thinking {
                thinking,
                signature,
            } => {
                assert!(signature.starts_with(OPENAI_RESPONSES_REASONING_SIGNATURE_PREFIX));
                blocks.push(ContentBlock::Thinking {
                    thinking,
                    signature,
                });
            }
            AssistantEvent::ToolUse { id, name, input } => {
                tool = Some((id.clone(), name.clone()));
                blocks.push(ContentBlock::ToolUse { id, name, input });
            }
            _ => {}
        }
    }
    assert!(
        blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Thinking { .. })),
        "xhigh Responses tool call should persist an encrypted reasoning item"
    );
    let (tool_id, tool_name) = tool.expect("tool call");

    // A completely fresh client models Desktop's next top-level chat turn.
    // The continuation must work using only the persisted session blocks.
    let mut second_client = live_openai_client(&config, &model, true);
    second_client
        .stream(ApiRequest {
            system_prompt: vec![live_openai_system_prompt()],
            messages: vec![
                ConversationMessage::user_text(prompt),
                ConversationMessage::assistant(blocks),
                ConversationMessage::tool_result(
                    tool_id,
                    tool_name,
                    "persisted-reasoning-ok",
                    false,
                ),
            ],
        })
        .expect("fresh client should replay persisted Responses reasoning");
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
fn openai_usage_accepts_new_api_output_tokens_alias() {
    let usage = token_usage_from_openai_usage(&json!({
        "input_tokens": 120,
        "output_tokens": 37,
    }));

    assert_eq!(usage.input_tokens, 120);
    assert_eq!(usage.output_tokens, 37);
    assert_eq!(usage.prompt_tokens(), 120);
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

#[test]
fn identifies_context_overflow_in_mid_stream_errors() {
    let detail = stream_error_detail(&json!({
        "error": {
            "message": "Your input exceeds the context window of this model.",
            "code": "context_length_exceeded"
        }
    }))
    .expect("error envelope");

    assert!(is_context_window_exceeded_error(&detail));
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

// v0.4.24 prompt-cache audit: reasoning_content replay is limited to model
// families whose APIs document it as an input field. OpenAI o-series/gpt-5.x
// must NOT replay — attaching the non-standard field through proxies churned
// historical message bytes and broke provider prefix caching.
#[test]
fn reasoning_replay_is_limited_to_reasoning_content_input_families() {
    assert!(supports_reasoning_content_replay("kimi-k3"));
    assert!(supports_reasoning_content_replay("moonshot-v1-128k"));
    assert!(supports_reasoning_content_replay("mimo-v2.5-pro"));
    assert!(supports_reasoning_content_replay("deepseek-r1"));
    assert!(supports_reasoning_content_replay("deepseek-reasoner"));
    assert!(supports_reasoning_content_replay("glm-4.6-thinking"));

    assert!(!supports_reasoning_content_replay("gpt-5.6-terra"));
    assert!(!supports_reasoning_content_replay("gpt-5.5"));
    assert!(!supports_reasoning_content_replay("o3-mini"));
    assert!(!supports_reasoning_content_replay("o4"));
    assert!(!supports_reasoning_content_replay("MiniMax-M3"));
    assert!(!supports_reasoning_content_replay("deepseek-v4-flash"));

    // The effort-tier sender is unchanged: OpenAI reasoning families still
    // receive reasoning_effort (and the official Responses API transport).
    assert!(supports_reasoning_effort("gpt-5.6-terra"));
    assert!(supports_reasoning_effort("o3-mini"));
}

fn reasoning_content_thinking_turn(reasoning: &str, answer: &str) -> ConversationMessage {
    ConversationMessage::assistant(vec![
        ContentBlock::Thinking {
            thinking: reasoning.to_string(),
            signature: OPENAI_REASONING_CONTENT_SIGNATURE.to_string(),
        },
        ContentBlock::Text {
            text: answer.to_string(),
        },
    ])
}

fn assistant_messages(converted: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    converted
        .iter()
        .filter(|message| message["role"] == "assistant")
        .collect()
}

#[test]
fn reasoning_content_replayed_from_thinking_block_for_replay_families_only() {
    let messages = vec![
        ConversationMessage::user_text("hi"),
        reasoning_content_thinking_turn("deep thought", "the answer"),
    ];

    // Replay family (Kimi): reasoning_content is sourced from the tagged block —
    // B4, which was dead in Desktop because the old side cache never survived the
    // per-turn client rebuild.
    let kimi = convert_messages_openai(&messages, None, "kimi-k3");
    let asst = assistant_messages(&kimi);
    assert_eq!(asst[0]["reasoning_content"], "deep thought");
    assert_eq!(asst[0]["content"], "the answer");

    // Non-replay family (gpt-5.x on chat): the block persists for display but is
    // never replayed as reasoning_content (would churn bytes / error upstream).
    let gpt = convert_messages_openai(&messages, None, "gpt-5.5");
    assert!(assistant_messages(&gpt)[0]
        .get("reasoning_content")
        .is_none());

    // A display-only block (empty signature) is never replayed, even for Kimi.
    let display_only = vec![
        ConversationMessage::user_text("hi"),
        ConversationMessage::assistant(vec![
            ContentBlock::Thinking {
                thinking: "shown only".to_string(),
                signature: String::new(),
            },
            ContentBlock::Text {
                text: "the answer".to_string(),
            },
        ]),
    ];
    let kimi_display = convert_messages_openai(&display_only, None, "kimi-k3");
    assert!(assistant_messages(&kimi_display)[0]
        .get("reasoning_content")
        .is_none());
}

#[test]
fn reasoning_content_replay_budget_keeps_oldest_drops_newest() {
    // The 128k budget is exactly four 32k turns. Six turns → the oldest four
    // carry reasoning_content and the newest two are dropped, so already-sent
    // historical bytes stay stable while the request stays bounded.
    let big = "r".repeat(MAX_REASONING_CHARS_PER_TURN);
    let mut messages = vec![ConversationMessage::user_text("go")];
    for n in 0..6 {
        messages.push(reasoning_content_thinking_turn(
            &big,
            &format!("answer {n}"),
        ));
        messages.push(ConversationMessage::user_text("next"));
    }

    let out = convert_messages_openai(&messages, None, "kimi-k3");
    let asst = assistant_messages(&out);
    let replayed = asst
        .iter()
        .filter(|message| message.get("reasoning_content").is_some())
        .count();
    assert_eq!(replayed, 4);
    assert!(asst[0].get("reasoning_content").is_some());
    assert!(asst[3].get("reasoning_content").is_some());
    assert!(asst[4].get("reasoning_content").is_none());
    assert!(asst[5].get("reasoning_content").is_none());
}

#[test]
fn truncate_reasoning_per_turn_caps_at_char_boundary() {
    let oversized = "思".repeat(MAX_REASONING_CHARS_PER_TURN + 5_000);
    let truncated = truncate_reasoning_per_turn(oversized);
    assert_eq!(truncated.chars().count(), MAX_REASONING_CHARS_PER_TURN);
    assert!(truncated.chars().all(|c| c == '思'));
    // Under-cap and empty pass through unchanged.
    assert_eq!(truncate_reasoning_per_turn("short".to_string()), "short");
    assert_eq!(truncate_reasoning_per_turn(String::new()), "");
}

// Real error envelopes captured from a self-hosted new-api gateway on
// 2026-07-18 while probing `/v1/responses` per model. These exact shapes drive
// the runtime fallback, so they are pinned here.
#[test]
fn responses_transport_unsupported_matches_observed_gateway_errors() {
    // MiniMax-M3: gateway has no chat→responses converter for this upstream.
    assert!(responses_transport_unsupported(
        500,
        r#"{"error":{"message":"not implemented (request id: 20260718...)","type":"new_api_error","param":"","code":"convert_request_failed"}}"#
    ));
    // kimi-k3 / mimo-v2.5: upstream 404s the endpoint.
    assert!(responses_transport_unsupported(
        404,
        r#"{"error":{"message":"openai_error","type":"bad_response_status_code","param":"","code":"bad_response_status_code"}}"#
    ));
    // Wrong path shape (double /v1) — also a routing miss.
    assert!(responses_transport_unsupported(
        404,
        r#"{"error":{"message":"Invalid URL (POST /v1/v1/responses)","type":"invalid_request_error"}}"#
    ));
    assert!(responses_transport_unsupported(501, ""));

    // Genuine failures must NOT be mistaken for an unsupported endpoint:
    // falling back would mask them behind a second request.
    assert!(!responses_transport_unsupported(
        401,
        r#"{"error":{"message":"invalid api key","code":"invalid_api_key"}}"#
    ));
    assert!(!responses_transport_unsupported(
        429,
        r#"{"error":{"message":"rate limit exceeded","code":"rate_limit"}}"#
    ));
    assert!(!responses_transport_unsupported(
        400,
        r#"{"error":{"message":"Error from provider (Console): Upstream request failed","code":"invalid_request_error"}}"#
    ));
    assert!(!responses_transport_unsupported(
        500,
        "internal server error"
    ));
    // A 200 never reaches this classifier, but it must not claim unsupported.
    assert!(!responses_transport_unsupported(200, ""));
}

#[test]
fn transport_preference_overrides_and_learned_fallback() {
    // Explicit preference wins over the Auto heuristic in both directions.
    assert!(
        resolve_transport(
            OpenAiTransport::Responses,
            "https://gateway.example/v1",
            "MiniMax-M3",
            true,
        )
        .0
    );
    assert!(
        !resolve_transport(
            OpenAiTransport::ChatCompletions,
            "https://api.openai.com/v1",
            "gpt-5.6-terra",
            true,
        )
        .0
    );

    // A learned "this server/model cannot serve /v1/responses" fact overrides
    // even an explicit preference, so one failed request per process is the
    // worst case rather than one per turn.
    let base = "https://learned-fallback.example/v1";
    assert!(resolve_transport(OpenAiTransport::Responses, base, "gpt-5.6-terra", true).0);
    mark_responses_unsupported(base, "gpt-5.6-terra");
    let (use_responses, reason) =
        resolve_transport(OpenAiTransport::Responses, base, "gpt-5.6-terra", true);
    assert!(!use_responses);
    assert_eq!(reason, TransportReason::LearnedResponsesUnsupported);
    // Scoped to the (server, model) pair — a sibling model is unaffected.
    assert!(resolve_transport(OpenAiTransport::Responses, base, "gpt-5.6-luna", true).0);

    // Symmetric reverse fact: a chat pair told to use responses starts there.
    let reverse = "https://requires-responses.example/v1";
    assert!(
        !resolve_transport(OpenAiTransport::ChatCompletions, reverse, "gpt-5.5", true).0,
        "configured chat before learning"
    );
    mark_chat_requires_responses(reverse, "gpt-5.5");
    let (use_responses, reason) =
        resolve_transport(OpenAiTransport::ChatCompletions, reverse, "gpt-5.5", true);
    assert!(use_responses, "reverse fact overrides configured chat");
    assert_eq!(reason, TransportReason::LearnedRequiresResponses);
}

#[test]
fn chat_requires_responses_transport_matches_official_openai_gate() {
    // The official OpenAI 400 a gateway forwards verbatim.
    assert!(chat_requires_responses_transport(
        400,
        "Function tools with reasoning_effort are not supported on gpt-5.5 with /v1/chat/completions, please use /v1/responses instead."
    ));
    // Variant without the literal path but the same verdict.
    assert!(chat_requires_responses_transport(
        400,
        r#"{"error":{"message":"reasoning_effort is not supported here; use responses"}}"#
    ));
    // Unrelated 400s and non-400 statuses must not flip transport.
    assert!(!chat_requires_responses_transport(
        400,
        r#"{"error":{"message":"invalid api key"}}"#
    ));
    assert!(!chat_requires_responses_transport(
        429,
        "please use /v1/responses"
    ));
}

#[test]
fn transport_config_values_round_trip() {
    for (raw, expected) in [
        ("responses", OpenAiTransport::Responses),
        ("chat_completions", OpenAiTransport::ChatCompletions),
        ("chat-completions", OpenAiTransport::ChatCompletions),
        ("chat", OpenAiTransport::ChatCompletions),
        ("  Responses  ", OpenAiTransport::Responses),
        ("auto", OpenAiTransport::Auto),
        // Unknown/garbage must degrade to Auto, never wedge a provider onto an
        // endpoint it does not serve.
        ("", OpenAiTransport::Auto),
        ("nonsense", OpenAiTransport::Auto),
    ] {
        assert_eq!(
            OpenAiTransport::from_config_value(raw),
            expected,
            "raw={raw:?}"
        );
    }
    assert_eq!(OpenAiTransport::default(), OpenAiTransport::Auto);
    assert_eq!(
        OpenAiTransport::from_config_value(OpenAiTransport::Responses.as_config_value()),
        OpenAiTransport::Responses
    );
}

// `TokenUsage::prompt_tokens()` (input + creation + read) drives the
// auto-compaction budget, so cache buckets must never sum above the prompt the
// provider actually reported. Gateways disagree on whether `cache_write_tokens`
// is disjoint from `cached_tokens`; the normalizer must survive either reading.
#[test]
fn openai_usage_never_inflates_prompt_occupancy_via_cache_write() {
    // Disjoint (documented) shape: buckets partition the prompt exactly.
    let usage = token_usage_from_openai_usage(&json!({
        "input_tokens": 1_000,
        "output_tokens": 50,
        "input_tokens_details": { "cached_tokens": 600, "cache_write_tokens": 100 }
    }));
    assert_eq!(usage.input_tokens, 300);
    assert_eq!(usage.cache_creation_input_tokens, 100);
    assert_eq!(usage.cache_read_input_tokens, 600);
    assert_eq!(usage.prompt_tokens(), 1_000);

    // Overlapping shape: a gateway reports the whole cached prefix in both
    // fields. Unclamped this would report 1900 tokens of occupancy for a 1000
    // token prompt and force a premature compaction.
    let usage = token_usage_from_openai_usage(&json!({
        "input_tokens": 1_000,
        "output_tokens": 50,
        "input_tokens_details": { "cached_tokens": 950, "cache_write_tokens": 950 }
    }));
    assert_eq!(usage.prompt_tokens(), 1_000);
    assert_eq!(usage.cache_read_input_tokens, 950);
    assert_eq!(usage.cache_creation_input_tokens, 50);
    assert_eq!(usage.input_tokens, 0);

    // Chat completions has no write counter at all — unchanged behaviour.
    let usage = token_usage_from_openai_usage(&json!({
        "prompt_tokens": 500,
        "completion_tokens": 10,
        "prompt_tokens_details": { "cached_tokens": 400 }
    }));
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.cache_creation_input_tokens, 0);
    assert_eq!(usage.cache_read_input_tokens, 400);
    assert_eq!(usage.prompt_tokens(), 500);
}

// Models without a Responses endpoint must keep the exact chat/completions
// request they had before the transport work: same endpoint, no reasoning
// fields, no Responses-only keys. MiniMax-M3 carries the bulk of real traffic,
// so its request shape is pinned here.
#[test]
fn non_responses_models_keep_their_original_chat_request() {
    for model in [
        "MiniMax-M3",
        "deepseek-v4-flash",
        "kimi-k3",
        "mimo-v2.5-pro",
    ] {
        // Stays on chat/completions under Auto, on any gateway.
        assert!(
            !uses_openai_responses_api("http://gateway.local/v1", model, true),
            "{model} must not be routed to /v1/responses"
        );
        assert!(
            !resolve_transport(
                OpenAiTransport::Auto,
                "http://gateway.local/v1",
                model,
                true
            )
            .0,
            "{model} must resolve to chat/completions"
        );
    }

    let spec = ExecutorToolSpec::new("bash", "Run", json!({ "type": "object" }));
    let body = build_chat_completions_body(
        "MiniMax-M3",
        vec![json!({ "role": "user", "content": "hi" })],
        std::slice::from_ref(&spec),
        true,
        chat_reasoning_effort_for("MiniMax-M3", "http://gateway.local/v1", true),
    );

    assert_eq!(body["model"], "MiniMax-M3");
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"]["include_usage"], true);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["tool_choice"], "auto");
    assert_eq!(body["tools"][0]["function"]["name"], "bash");
    // No reasoning_effort (the model does not accept it) and none of the
    // Responses-only keys leak into the chat body.
    for absent in [
        "reasoning_effort",
        "reasoning",
        "prompt_cache_key",
        "instructions",
        "input",
        "store",
        "include",
    ] {
        assert!(
            body.get(absent).is_none(),
            "chat body must not carry `{absent}`"
        );
    }

    // Usage accounting is also untouched: these gateways report no
    // `cache_write_tokens`, so the cache_creation bucket stays empty and fresh
    // input is still `prompt - cached`.
    let usage = token_usage_from_openai_usage(&json!({
        "prompt_tokens": 195_916,
        "completion_tokens": 98,
        "prompt_tokens_details": { "cached_tokens": 194_048 }
    }));
    assert_eq!(usage.input_tokens, 1_868);
    assert_eq!(usage.cache_read_input_tokens, 194_048);
    assert_eq!(usage.cache_creation_input_tokens, 0);
    assert_eq!(usage.prompt_tokens(), 195_916);
}

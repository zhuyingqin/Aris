use std::sync::{Arc, Mutex};

use api::{InputContentBlock, MessageResponse, OutputContentBlock, Usage};
use runtime::{AssistantEvent, ContentBlock, ConversationMessage, RuntimeError};

use super::{
    anthropic_thinking_plan, convert_messages, is_thinking_request_rejected,
    mark_stable_prefix_cache_breakpoints, merge_anthropic_stream_usage, projected_tool_specs,
    push_text_event, response_to_events, AnthropicRuntimeClient, AnthropicThinkingPlan,
    ExecutorToolSpec, StreamObserver,
};

#[test]
fn provider_tool_projection_preserves_catalog_order_and_hides_deferred_schemas() {
    let specs = ["read_file", "ToolSearch", "browser_snapshot"]
        .into_iter()
        .map(|name| ExecutorToolSpec::new(name, name, serde_json::json!({"type": "object"})))
        .collect::<Vec<_>>();
    let active = ["ToolSearch", "browser_snapshot"]
        .into_iter()
        .map(str::to_string)
        .collect();

    let projected = projected_tool_specs(&specs, Some(&active));
    assert_eq!(
        projected
            .iter()
            .map(|spec| spec.name.as_str())
            .collect::<Vec<_>>(),
        vec!["ToolSearch", "browser_snapshot"]
    );
    assert_eq!(projected_tool_specs(&specs, None).len(), specs.len());
}

struct RecordingObserver {
    deltas: Arc<Mutex<Vec<String>>>,
}

impl StreamObserver for RecordingObserver {
    fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
        self.deltas.lock().unwrap().push(format!("text:{text}"));
        Ok(())
    }

    fn on_thinking_delta(&mut self, thinking: &str) -> Result<(), RuntimeError> {
        self.deltas
            .lock()
            .unwrap()
            .push(format!("thinking:{thinking}"));
        Ok(())
    }
}

#[test]
fn response_notifies_observer_about_thinking_blocks() {
    let deltas = Arc::new(Mutex::new(Vec::new()));
    let mut observer: Box<dyn StreamObserver> = Box::new(RecordingObserver {
        deltas: Arc::clone(&deltas),
    });
    let response = MessageResponse {
        id: "msg-test".to_string(),
        kind: "message".to_string(),
        role: "assistant".to_string(),
        content: vec![
            OutputContentBlock::Thinking {
                thinking: "inspect".to_string(),
                signature: String::new(),
            },
            OutputContentBlock::Text {
                text: "answer".to_string(),
            },
        ],
        model: "test-model".to_string(),
        stop_reason: Some("end_turn".to_string()),
        stop_sequence: None,
        usage: Usage {
            input_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 2,
        },
        request_id: None,
    };

    response_to_events(response, &mut observer).unwrap();

    assert_eq!(
        *deltas.lock().unwrap(),
        vec!["thinking:inspect".to_string(), "text:answer".to_string()]
    );
}

#[test]
fn anthropic_stream_usage_prefers_corrected_delta_input() {
    let start = Usage {
        input_tokens: 180_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 120_000,
        output_tokens: 0,
    };
    let delta = Usage {
        input_tokens: 12_000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 110_000,
        output_tokens: 42,
    };
    let mut input_from_delta = false;

    let usage = merge_anthropic_stream_usage(Some(&start), &delta, &mut input_from_delta);

    assert_eq!(usage.input_tokens, 12_000);
    assert_eq!(usage.output_tokens, 42);
    assert_eq!(usage.cache_creation_input_tokens, 500);
    assert_eq!(usage.cache_read_input_tokens, 110_000);
    assert!(input_from_delta);
}

#[test]
fn anthropic_stream_usage_keeps_start_cache_when_delta_omits_it() {
    let start = Usage {
        input_tokens: 180_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 120_000,
        output_tokens: 0,
    };
    let delta = Usage {
        input_tokens: 12_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 42,
    };
    let mut input_from_delta = false;

    let usage = merge_anthropic_stream_usage(Some(&start), &delta, &mut input_from_delta);

    assert_eq!(usage.input_tokens, 12_000);
    assert_eq!(usage.cache_creation_input_tokens, 2_000);
    assert_eq!(usage.cache_read_input_tokens, 120_000);
}

#[test]
fn convert_messages_maps_images_to_anthropic_image_blocks() {
    let messages = vec![ConversationMessage::user_blocks(vec![
        ContentBlock::Text {
            text: "describe this".to_string(),
        },
        ContentBlock::Image {
            media_type: "image/png".to_string(),
            data: "ZmFrZQ==".to_string(),
        },
    ])];

    let converted = convert_messages(&messages, false);

    assert_eq!(converted.len(), 1);
    assert_eq!(converted[0].role, "user");
    assert!(matches!(
        &converted[0].content[1],
        InputContentBlock::Image { source, .. }
            if source.kind == "base64"
                && source.media_type == "image/png"
                && source.data == "ZmFrZQ=="
    ));
}

#[test]
fn coalesces_large_streams_into_one_text_event() {
    let mut events = Vec::new();
    for _ in 0..100_000 {
        push_text_event(&mut events, "x".to_string());
    }

    assert_eq!(events.len(), 1);
    assert!(matches!(
        &events[0],
        AssistantEvent::TextDelta(text) if text.len() == 100_000
    ));
}

#[test]
fn stable_prefix_breakpoints_mark_the_shared_preamble_and_the_end_of_evidence() {
    let mut messages = convert_messages(&[ConversationMessage::user_blocks(vec![
        ContentBlock::Text { text: "shared preamble".into() },
        ContentBlock::Text { text: "original page text".into() },
        ContentBlock::Image { media_type: "image/jpeg".into(), data: "ZmFrZQ==".into() },
        ContentBlock::Text { text: "variable task".into() },
    ])], false);
    mark_stable_prefix_cache_breakpoints(&mut messages);
    let marked = serde_json::to_value(&messages[0].content).unwrap();
    assert_eq!(marked[0]["cache_control"]["type"], "ephemeral");
    assert!(marked[1].get("cache_control").is_none());
    assert_eq!(marked[2]["cache_control"]["type"], "ephemeral");
    assert!(marked[3].get("cache_control").is_none(), "the variable request stays unmarked");

    let mut single = convert_messages(&[ConversationMessage::user_text("one block")], false);
    mark_stable_prefix_cache_breakpoints(&mut single);
    assert!(serde_json::to_value(&single[0].content).unwrap()[0].get("cache_control").is_none());
}

/// One tool step: a request, the assistant's call opened by `blocks`, its result.
fn tool_step(blocks: Vec<ContentBlock>) -> Vec<ConversationMessage> {
    vec![
        ConversationMessage::user_text("check the build"),
        ConversationMessage::assistant(blocks),
        ConversationMessage::tool_result("toolu_1", "bash", "ok", false),
    ]
}

fn bash_call() -> ContentBlock {
    ContentBlock::ToolUse {
        id: "toolu_1".to_string(),
        name: "bash".to_string(),
        input: "{}".to_string(),
    }
}

fn thinking_signed(signature: &str) -> ContentBlock {
    ContentBlock::Thinking {
        thinking: "check the logs first".to_string(),
        signature: signature.to_string(),
    }
}

fn configured_level_for(model: &str) -> Option<&'static str> {
    crate::reasoning_effort::closest_level(model, &crate::reasoning_effort::configured_level())
}

/// Claude 4.7 and later answer `{"type": "enabled"}` with a 400; current models
/// take adaptive thinking with depth from effort.
#[test]
fn current_claude_models_get_adaptive_thinking_steered_by_effort() {
    for model in ["claude-opus-4-7", "claude-fable-5-1"] {
        let level = configured_level_for(model).expect("current Claude models take levels");
        let plan = anthropic_thinking_plan(model, 128_000, &[]);
        if level == "none" {
            assert_eq!(plan, AnthropicThinkingPlan::default(), "{model}");
            continue;
        }
        let thinking = serde_json::to_value(plan.thinking.expect("adaptive thinking")).unwrap();
        assert_eq!(
            thinking,
            serde_json::json!({ "type": "adaptive", "display": "summarized" }),
            "{model}"
        );
        assert_eq!(
            plan.output_config,
            Some(serde_json::json!({ "effort": level })),
            "{model}"
        );
    }
}

#[test]
fn manual_thinking_models_need_a_signed_block_opening_the_tool_loop() {
    let model = "claude-haiku-4-5-20251001";
    if configured_level_for(model) == Some("none") {
        return;
    }
    let opened = anthropic_thinking_plan(
        model,
        64_000,
        &tool_step(vec![thinking_signed("sig-anthropic"), bash_call()]),
    );
    let thinking = opened.thinking.expect("manual thinking");
    assert_eq!(thinking.kind, "enabled");
    assert!(thinking.budget_tokens.is_some_and(|budget| budget >= 1_024));
    assert_eq!(opened.output_config, None);

    // A tool loop that began without a block Anthropic signed — another model's
    // turn, or reasoning an OpenAI-compatible route tagged — cannot satisfy
    // manual mode. That request runs without thinking instead of failing.
    for blocks in [
        vec![bash_call()],
        vec![thinking_signed("openai-reasoning-content:abc"), bash_call()],
        vec![thinking_signed(""), bash_call()],
    ] {
        assert_eq!(
            anthropic_thinking_plan(model, 64_000, &tool_step(blocks)),
            AnthropicThinkingPlan::default()
        );
    }
    // A fresh request has no assistant turn to open yet.
    assert!(
        anthropic_thinking_plan(model, 64_000, &[ConversationMessage::user_text("hi")])
            .thinking
            .is_some()
    );
}

#[test]
fn older_and_non_claude_models_get_no_thinking_request() {
    for model in ["claude-3-5-sonnet-latest", "gpt-5.6-sol", "MiniMax-M3"] {
        assert_eq!(
            anthropic_thinking_plan(model, 64_000, &[]),
            AnthropicThinkingPlan::default(),
            "{model}"
        );
    }
}

#[test]
fn replay_passes_back_only_the_thinking_anthropic_signed() {
    let messages = tool_step(vec![
        thinking_signed("sig-anthropic"),
        thinking_signed("openai-reasoning-content:abc"),
        thinking_signed(""),
        bash_call(),
    ]);

    let replayed = convert_messages(&messages, true);
    assert!(matches!(
        &replayed[1].content[..],
        [InputContentBlock::Thinking { signature, .. }, InputContentBlock::ToolUse { .. }]
            if signature == "sig-anthropic"
    ));
    let stripped = convert_messages(&messages, false);
    assert!(matches!(&stripped[1].content[..], [InputContentBlock::ToolUse { .. }]));
}

#[test]
fn thinking_rejections_are_told_apart_from_other_errors() {
    for message in [
        r#"anthropic api returned 400 Bad Request (invalid_request_error): "thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior."#,
        "anthropic api returned 400 Bad Request (invalid_request_error): messages.1.content.0: Invalid `signature` in `thinking` block",
        "anthropic api returned 400 Bad Request (invalid_request_error): output_config: Extra inputs are not permitted",
    ] {
        assert!(is_thinking_request_rejected(message), "{message}");
    }
    for message in [
        "anthropic api returned 400 Bad Request (invalid_request_error): prompt is too long: 210000 tokens > 200000 maximum",
        "anthropic api returned 404 Not Found (not_found_error): model: claude-opus-9",
        "anthropic api returned 529 <unknown status code> (overloaded_error): Overloaded while thinking",
    ] {
        assert!(!is_thinking_request_rejected(message), "{message}");
    }
}

fn read_http_body(stream: &mut std::net::TcpStream) -> String {
    use std::io::Read;
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = stream.read(&mut buffer).expect("read mock request");
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
        let length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if request.len() >= header_end + 4 + length {
            return String::from_utf8_lossy(&request[header_end + 4..header_end + 4 + length])
                .into_owned();
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

#[test]
fn a_rejected_thinking_request_is_resent_without_thinking() {
    use runtime::{ApiClient, ApiRequest};
    use std::io::Write;

    let rejection = r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}"#;
    let sse = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-fable-5-1\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":8,\"output_tokens\":0}}}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );
    let responses = [
        format!(
            "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{rejection}",
            rejection.len()
        ),
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sse}",
            sse.len()
        ),
    ];
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock api");
    let address = listener.local_addr().expect("mock api address");
    let server = std::thread::spawn(move || {
        responses
            .iter()
            .map(|response| {
                let (mut stream, _) = listener.accept().expect("request");
                let body = read_http_body(&mut stream);
                stream.write_all(response.as_bytes()).expect("write response");
                body
            })
            .collect::<Vec<_>>()
    });

    // Fable 5.1 thinks by default, so the request carries thinking whatever
    // level is configured.
    let mut client = AnthropicRuntimeClient::new(
        api::AuthSource::ApiKey("test-key".to_string()),
        format!("http://{address}"),
        false,
        "claude-fable-5-1".to_string(),
        false,
        Vec::new(),
        64_000,
        Box::new(crate::NoopStreamObserver),
    )
    .expect("Anthropic client");
    let events = client
        .stream(ApiRequest {
            system_prompt: Vec::new(),
            messages: tool_step(vec![thinking_signed("sig-from-another-provider"), bash_call()]),
        })
        .expect("the resend without thinking should succeed");
    assert!(events
        .iter()
        .any(|event| matches!(event, AssistantEvent::TextDelta(text) if text == "ok")));

    let bodies = server.join().expect("mock api thread");
    let first: serde_json::Value = serde_json::from_str(&bodies[0]).expect("first body");
    let second: serde_json::Value = serde_json::from_str(&bodies[1]).expect("second body");
    assert_eq!(first["thinking"]["type"], "adaptive");
    assert!(first.to_string().contains("sig-from-another-provider"));
    assert!(second.get("thinking").is_none(), "{second}");
    assert!(second.get("output_config").is_none(), "{second}");
    assert!(!second.to_string().contains("sig-from-another-provider"));
}

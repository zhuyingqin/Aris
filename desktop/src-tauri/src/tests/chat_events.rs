use super::{
    bind_session_event_dir, chat_wire_rotated_log_paths, govern_wire_payload,
    read_events_from_path, read_last_seq, recover_session_for_export, remove_chat_wire_logs,
    replay_events, should_record_wire_event, ChatEventLogEntry,
};
use runtime::{ContentBlock, MessageRole};
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

fn event(seq: u64, kind: &str, payload: serde_json::Value) -> ChatEventLogEntry {
    ChatEventLogEntry {
        version: 1,
        seq,
        ts: 1,
        session_id: "chat-test".to_string(),
        kind: kind.to_string(),
        payload,
    }
}

#[test]
fn replay_projects_stream_events_into_turns() {
    let events = vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"hi"}]}}),
        ),
        event(
            2,
            "assistant_delta",
            json!({"sessionId":"chat-test","text":"hello"}),
        ),
        event(
            3,
            "tool_call",
            json!({"sessionId":"chat-test","id":"t1","name":"bash","input":"{}"}),
        ),
        event(
            4,
            "tool_result",
            json!({"sessionId":"chat-test","id":"t1","name":"bash","output":"ok","isError":false}),
        ),
        event(5, "done", json!({"sessionId":"chat-test","text":"hello"})),
    ];
    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 2);
    assert_eq!(replay.last_seq, 5);
}

#[test]
fn replay_updates_a_streamed_question_when_its_answer_channel_becomes_ready() {
    let events = vec![
        event(
            1,
            "tool_call",
            json!({
                "sessionId":"chat-test",
                "id":"ask-1",
                "name":"AskUserQuestion",
                "input":"{\"question\":\"Continue?\",\"options\":[{\"label\":\"Yes\"}]}"
            }),
        ),
        event(
            2,
            "tool_call",
            json!({
                "sessionId":"chat-test",
                "id":"ask-1",
                "name":"AskUserQuestion",
                "input":"{\"question\":\"Continue?\",\"options\":[{\"label\":\"Yes\"}]}",
                "ready":true
            }),
        ),
    ];

    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 1);
    assert_eq!(replay.turns[0]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(replay.turns[0]["blocks"][0]["ready"], json!(true));
}

#[test]
fn export_recovery_builds_runtime_session_from_cancelled_stream_events() {
    let events = vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"find the paper"}]}}),
        ),
        event(2, "assistant_delta", json!({"text":"Searching."})),
        event(
            3,
            "tool_call",
            json!({"id":"search-1","name":"WebSearch","input":"{\"query\":\"paper\"}"}),
        ),
        event(
            4,
            "tool_result",
            json!({"id":"search-1","name":"WebSearch","output":"{\"results\":[]}","isError":false}),
        ),
        event(5, "error", json!({"message":"interrupted by user"})),
    ];

    let session = recover_session_for_export("chat-test", &events);
    assert_eq!(session.messages.len(), 4);
    assert_eq!(session.messages[0].role, MessageRole::User);
    assert!(matches!(
        &session.messages[1].blocks[0],
        ContentBlock::Text { text } if text == "Searching."
    ));
    assert!(matches!(
        &session.messages[2].blocks[0],
        ContentBlock::ToolResult { tool_name, output, .. }
            if tool_name == "WebSearch" && output.contains("results")
    ));
    assert!(matches!(
        &session.messages[3].blocks[0],
        ContentBlock::Text { text } if text.contains("interrupted by user")
    ));
}

#[test]
fn canonical_session_events_are_replayable_without_snapshots() {
    let events = vec![
        event(1, "session_reset", json!({"reason":"initial"})),
        event(
            2,
            "session_message",
            json!({
                "index": 0,
                "message": {"role":"user","blocks":[{"type":"text","text":"from events"}]}
            }),
        ),
        event(
            3,
            "session_message",
            json!({
                "index": 1,
                "message": {"role":"assistant","blocks":[{"type":"text","text":"restored"}]}
            }),
        ),
    ];

    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 2);
    assert_eq!(replay.turns[0]["blocks"][0]["text"], json!("from events"));
}

#[test]
fn canonical_checkpoint_discards_stale_ui_events_after_a_session_reset() {
    let events = vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"stale prompt"}]}}),
        ),
        event(2, "assistant_delta", json!({"text":"stale response"})),
        event(3, "session_reset", json!({"reason":"clear"})),
        event(
            4,
            "session_message",
            json!({"index":0,"message":{"role":"user","blocks":[{"type":"text","text":"durable prompt"}]}}),
        ),
        event(
            5,
            "session_message",
            json!({"index":1,"message":{"role":"assistant","blocks":[{"type":"text","text":"durable response"}]}}),
        ),
        event(6, "session_checkpoint", json!({"messageCount":2})),
        event(7, "done", json!({})),
    ];

    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 2);
    assert_eq!(
        replay.turns[0]["blocks"][0]["text"],
        json!("durable prompt")
    );
    assert_eq!(
        replay.turns[1]["blocks"][0]["text"],
        json!("durable response")
    );
}

#[test]
fn replay_preserves_ui_events_after_the_latest_canonical_checkpoint() {
    let events = vec![
        event(1, "session_reset", json!({"reason":"initial"})),
        event(
            2,
            "session_message",
            json!({"index":0,"message":{"role":"user","blocks":[{"type":"text","text":"persisted prompt"}]}}),
        ),
        event(3, "session_checkpoint", json!({"messageCount":1})),
        event(
            4,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"in-flight prompt"}]}}),
        ),
        event(5, "assistant_delta", json!({"text":"in-flight response"})),
    ];

    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 3);
    assert_eq!(
        replay.turns[0]["blocks"][0]["text"],
        json!("persisted prompt")
    );
    assert_eq!(
        replay.turns[1]["blocks"][0]["text"],
        json!("in-flight prompt")
    );
    assert_eq!(
        replay.turns[2]["blocks"][0]["text"],
        json!("in-flight response")
    );
}

#[test]
fn malformed_event_rows_do_not_block_later_recovery_or_saves() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("somniq-chat-events-{suffix}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("chat-test.events.jsonl");
    let first = serde_json::to_string(&event(1, "assistant_delta", json!({ "text": "first" })))
        .expect("serialize first event");
    let second = serde_json::to_string(&event(3, "done", json!({ "text": "second" })))
        .expect("serialize second event");
    fs::write(&path, format!("{first}\n{{invalid json\n{second}\n")).expect("write event log");

    assert_eq!(read_last_seq(&path).expect("last sequence"), 3);
    let events = read_events_from_path("chat-test", &path).expect("read recoverable events");
    assert_eq!(
        events.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![1, 3]
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn wire_governance_redacts_credentials_but_preserves_token_metrics() {
    let governed = govern_wire_payload(json!({
        "authorization": "Bearer top-secret",
        "api_key": "sk-secret",
        "access_token": "oauth-secret",
        "x-api-token": "x-api-token-secret",
        "http_auth_token": "http-auth-secret",
        "id_token": "id-token-secret",
        "client-token": "client-token-secret",
        "service_token": "service-token-secret",
        "OAUTH_BEARER": "oauth-bearer-secret",
        "openai-api-key": "openai-key-secret",
        "prompt_tokens": 1234,
        "cache_read_input_tokens": 987,
        "cache_creation_input_tokens": 321,
        "max_tokens": 4096,
    }));

    assert_eq!(governed["authorization"], json!("<redacted>"));
    assert_eq!(governed["api_key"], json!("<redacted>"));
    assert_eq!(governed["access_token"], json!("<redacted>"));
    for key in [
        "x-api-token",
        "http_auth_token",
        "id_token",
        "client-token",
        "service_token",
        "OAUTH_BEARER",
        "openai-api-key",
    ] {
        assert_eq!(governed[key], json!("<redacted>"), "{key}");
    }
    assert_eq!(governed["prompt_tokens"], json!(1234));
    assert_eq!(governed["cache_read_input_tokens"], json!(987));
    assert_eq!(governed["cache_creation_input_tokens"], json!(321));
    assert_eq!(governed["max_tokens"], json!(4096));
}

#[test]
fn wire_trace_omits_duplicate_raw_sse_unless_explicitly_enabled() {
    assert!(!should_record_wire_event("llm.raw_sse", false));
    assert!(should_record_wire_event("llm.provider_event", false));
    assert!(should_record_wire_event("llm.raw_sse", true));
}

#[test]
fn removing_wire_logs_also_removes_every_rotation() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let session_id = format!("chat-wire-delete-{suffix}");
    let dir = std::env::temp_dir().join(format!("somniq-chat-wire-delete-{suffix}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    let _binding = bind_session_event_dir(&session_id, dir.clone()).expect("bind event dir");
    let active = dir.join(format!("{session_id}.wire.jsonl"));
    let rotations = chat_wire_rotated_log_paths(&session_id).expect("rotation paths");
    assert_eq!(
        rotations[0].file_name().and_then(|name| name.to_str()),
        Some(format!("{session_id}.wire.jsonl.1").as_str())
    );
    fs::write(&active, "{}\n").expect("write active wire log");
    for path in &rotations {
        fs::write(path, "{}\n").expect("write rotated wire log");
    }

    remove_chat_wire_logs(&session_id).expect("remove wire logs");

    assert!(!active.exists());
    assert!(rotations.iter().all(|path| !path.exists()));
    let _ = fs::remove_dir_all(dir);
}

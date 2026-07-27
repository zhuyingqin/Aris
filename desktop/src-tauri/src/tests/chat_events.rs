use super::{
    bind_session_event_dir, chat_wire_rotated_log_paths, govern_wire_payload,
    read_events_from_path, read_last_seq, remove_chat_wire_logs, replay_events, ChatEventLogEntry,
};
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
        "prompt_tokens": 1234,
        "cache_read_input_tokens": 987,
        "cache_creation_input_tokens": 321,
        "max_tokens": 4096,
    }));

    assert_eq!(governed["authorization"], json!("<redacted>"));
    assert_eq!(governed["api_key"], json!("<redacted>"));
    assert_eq!(governed["access_token"], json!("<redacted>"));
    assert_eq!(governed["prompt_tokens"], json!(1234));
    assert_eq!(governed["cache_read_input_tokens"], json!(987));
    assert_eq!(governed["cache_creation_input_tokens"], json!(321));
    assert_eq!(governed["max_tokens"], json!(4096));
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
    fs::write(&active, "{}\n").expect("write active wire log");
    for path in &rotations {
        fs::write(path, "{}\n").expect("write rotated wire log");
    }

    remove_chat_wire_logs(&session_id).expect("remove wire logs");

    assert!(!active.exists());
    assert!(rotations.iter().all(|path| !path.exists()));
    let _ = fs::remove_dir_all(dir);
}

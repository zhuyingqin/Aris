use super::{read_events_from_path, read_last_seq, replay_events, ChatEventLogEntry};
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

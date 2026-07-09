use super::{replay_events, session_from_events, ChatEventLogEntry};
use serde_json::json;

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
fn restore_rebuilds_runtime_session_from_basic_events() {
    let events = vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"hi"}]}}),
        ),
        event(2, "assistant_delta", json!({"text":"hello"})),
        event(
            3,
            "tool_call",
            json!({"id":"t1","name":"bash","input":"{}"}),
        ),
        event(
            4,
            "tool_result",
            json!({"id":"t1","name":"bash","output":"ok","isError":false}),
        ),
    ];
    let session = session_from_events(&events).expect("session restores");
    assert_eq!(session.messages.len(), 3);
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

    let session = session_from_events(&events).expect("canonical session restores");
    assert_eq!(session.messages.len(), 2);
}

use super::{ContentBlock, ConversationMessage, MessageRole, Session};
use crate::usage::TokenUsage;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn persists_and_restores_session_json() {
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_blocks(vec![
        ContentBlock::Text {
            text: "hello".to_string(),
        },
        ContentBlock::Image {
            media_type: "image/png".to_string(),
            data: "ZmFrZQ==".to_string(),
        },
    ]));
    session
        .messages
        .push(ConversationMessage::assistant_with_usage(
            vec![
                ContentBlock::Text {
                    text: "thinking".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "bash".to_string(),
                    input: "echo hi".to_string(),
                },
            ],
            Some(TokenUsage {
                input_tokens: 10,
                output_tokens: 4,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 2,
            }),
        ));
    session.messages.push(ConversationMessage::tool_result(
        "tool-1", "bash", "hi", false,
    ));

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("runtime-session-{nanos}.json"));
    session.save_to_path(&path).expect("session should save");
    let manifest = fs::read_to_string(&path).expect("manifest should be readable");
    assert!(manifest.contains("\"storage\":\"event_log\""));
    assert!(!manifest.contains("\"messages\""));
    let event_path = path.with_extension("events.jsonl");
    assert!(event_path.exists());
    let restored = Session::load_from_path(&path).expect("session should load");
    fs::remove_file(&path).expect("temp file should be removable");
    fs::remove_file(event_path).expect("event log should be removable");

    assert_eq!(restored, session);
    assert!(matches!(
        &restored.messages[0].blocks[1],
        ContentBlock::Image { media_type, data }
            if media_type == "image/png" && data == "ZmFrZQ=="
    ));
    assert_eq!(restored.messages[2].role, MessageRole::Tool);
    assert_eq!(
        restored.messages[1].usage.expect("usage").total_tokens(),
        17
    );
}

#[test]
fn appends_new_messages_to_event_log_without_rewriting_snapshot() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("runtime-session-append-{nanos}.json"));
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("first"));
    session.save_to_path(&path).expect("first save");

    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "second".to_string(),
        }]));
    session.save_to_path(&path).expect("second save");

    let event_path = path.with_extension("events.jsonl");
    let events = fs::read_to_string(&event_path).expect("event log");
    assert_eq!(events.matches("\"kind\":\"session_reset\"").count(), 1);
    assert_eq!(events.matches("\"kind\":\"session_message\"").count(), 2);
    let restored = Session::load_from_path(&path).expect("session restores from events");
    assert_eq!(restored, session);

    fs::remove_file(path).expect("remove manifest");
    fs::remove_file(event_path).expect("remove event log");
}

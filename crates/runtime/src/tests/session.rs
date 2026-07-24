use super::{ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord};
use crate::get_compact_continuation_message;
use crate::usage::TokenUsage;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn logical_messages_restore_compacted_history_without_internal_continuations() {
    let first_continuation = ConversationMessage::user_text(get_compact_continuation_message(
        "first summary",
        true,
        true,
    ));
    let second_continuation = ConversationMessage::user_text(get_compact_continuation_message(
        "second summary",
        true,
        true,
    ));
    let mut session = Session::new();
    session.compactions.push(SessionCompactionRecord {
        summary: "first summary".to_string(),
        messages: vec![
            ConversationMessage::user_text("original request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "original answer".to_string(),
            }]),
        ],
        removed_message_count: 2,
        preserved_message_count: 2,
        tokens_before: 100,
        tokens_after: 50,
        summary_source: "model".to_string(),
    });
    session.compactions.push(SessionCompactionRecord {
        summary: "second summary".to_string(),
        messages: vec![
            first_continuation,
            ConversationMessage::user_text("middle request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "middle answer".to_string(),
            }]),
        ],
        removed_message_count: 3,
        preserved_message_count: 1,
        tokens_before: 120,
        tokens_after: 55,
        summary_source: "model".to_string(),
    });
    session.messages = vec![
        second_continuation,
        ConversationMessage::user_text("latest request"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "latest answer".to_string(),
        }]),
    ];

    let visible_text = session
        .logical_messages()
        .into_iter()
        .filter_map(|message| message.blocks.first())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(
        visible_text,
        vec![
            "original request",
            "original answer",
            "middle request",
            "middle answer",
            "latest request",
            "latest answer",
        ]
    );
    assert_eq!(session.logical_message_count(), 6);
}

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

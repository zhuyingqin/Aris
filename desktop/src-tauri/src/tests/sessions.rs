use super::{
    append_remote_chat_text_turns, chat_ui_preview_turns, find_turns_array_bounds,
    merge_missing_remote_chat_ui_turns, partition_chat_ui_index, preserve_remote_chat_updated_at,
    remote_chat_sessions_from_index, remote_chat_transcript_for_project, tail_turns_from_array,
    turn_from_array_index, CHAT_UI_SESSION_PREVIEW_MAX_TURNS,
    MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES,
};
use serde_json::{json, Value};
use std::collections::HashSet;

fn text_turn(index: usize, text: impl Into<String>) -> Value {
    json!({
        "id": format!("turn-{index}"),
        "role": if index % 2 == 0 { "user" } else { "assistant" },
        "blocks": [{ "kind": "text", "text": text.into() }],
    })
}

fn chat_session(
    id: &str,
    project_id: &str,
    title: &str,
    updated_at: i64,
    turns: Vec<Value>,
) -> Value {
    json!({
        "id": id,
        "projectId": project_id,
        "title": title,
        "updatedAt": updated_at,
        "turns": turns,
    })
}

#[test]
fn remote_chat_list_filters_current_project_orders_by_update_and_bounds_results() {
    let index = vec![
        chat_session("older", "project-a", "Older", 10, vec![text_turn(0, "old")]),
        chat_session(
            "other",
            "project-b",
            "Other",
            99,
            vec![text_turn(0, "other")],
        ),
        chat_session("newer", "project-a", "Newer", 20, vec![text_turn(0, "new")]),
    ];

    let list = remote_chat_sessions_from_index(&index, "project-a", 1);

    assert!(list.has_more);
    assert_eq!(list.sessions.len(), 1);
    assert_eq!(list.sessions[0].id, "newer");
    assert_eq!(list.sessions[0].title, "Newer");
    assert_eq!(list.sessions[0].updated_at_unix_ms, 20);
}

#[test]
fn remote_chat_transcript_exposes_only_user_and_assistant_text_blocks() {
    let session = chat_session(
        "chat-safe",
        "default",
        "Safe transcript",
        42,
        vec![
            json!({
                "id": "user-1",
                "role": "user",
                "blocks": [
                    { "kind": "text", "text": "Please summarize this." },
                    { "kind": "notice", "message": "attachment omitted" }
                ]
            }),
            json!({
                "id": "assistant-1",
                "role": "assistant",
                "blocks": [
                    { "kind": "thinking", "thinking": "private reasoning" },
                    { "kind": "tool", "name": "read_file", "input": "secret input", "output": "secret output" },
                    { "kind": "permission", "input": "private permission" },
                    { "kind": "text", "text": "Here is the summary." }
                ]
            }),
        ],
    );

    let transcript = remote_chat_transcript_for_project(&session, "default", 100)
        .expect("session in project should be readable");

    assert!(!transcript.has_more);
    assert_eq!(transcript.id, "chat-safe");
    assert_eq!(transcript.title, "Safe transcript");
    assert_eq!(
        transcript.messages,
        vec![
            super::RemoteChatTranscriptMessage {
                role: "user".to_string(),
                text: "Please summarize this.".to_string(),
            },
            super::RemoteChatTranscriptMessage {
                role: "assistant".to_string(),
                text: "Here is the summary.".to_string(),
            },
        ]
    );
}

#[test]
fn remote_chat_transcript_returns_newest_messages_and_marks_more_history() {
    let session = chat_session(
        "chat-tail",
        "default",
        "Tail",
        9,
        vec![
            text_turn(0, "first"),
            text_turn(1, "second"),
            text_turn(2, "third"),
        ],
    );

    let transcript = remote_chat_transcript_for_project(&session, "default", 2)
        .expect("session in project should be readable");

    assert!(transcript.has_more);
    assert_eq!(
        transcript
            .messages
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "third"]
    );
    assert!(remote_chat_transcript_for_project(&session, "project-other", 2).is_none());
}

#[test]
fn remote_chat_transcript_bounds_text_on_a_utf8_boundary() {
    let session = chat_session(
        "chat-large-text",
        "default",
        "Large text",
        1,
        vec![text_turn(
            0,
            "测".repeat(MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES),
        )],
    );

    let transcript = remote_chat_transcript_for_project(&session, "default", 1)
        .expect("session in project should be readable");
    let text = &transcript.messages[0].text;

    assert!(transcript.has_more);
    assert!(text.len() <= MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES);
    assert!(text.chars().all(|character| character == '测'));
}

#[test]
fn remote_chat_append_persists_two_text_turns_and_is_idempotent() {
    let mut session = chat_session(
        "chat-append",
        "default",
        "Append",
        1,
        vec![text_turn(0, "existing")],
    );

    assert!(append_remote_chat_text_turns(
        &mut session,
        "message-1",
        "remote question",
        "remote answer",
        99,
    )
    .expect("append should work"));
    assert_eq!(session["updatedAt"], json!(99));
    assert_eq!(session["turns"].as_array().expect("turns").len(), 3);
    assert_eq!(session["turns"][1]["id"], json!("remote-message-1-user"));
    assert_eq!(session["turns"][1]["role"], json!("user"));
    assert_eq!(session["turns"][1]["blocks"][0]["kind"], json!("text"));
    assert_eq!(
        session["turns"][1]["blocks"][0]["text"],
        json!("remote question")
    );
    assert_eq!(
        session["turns"][2]["id"],
        json!("remote-message-1-assistant")
    );
    assert_eq!(session["turns"][2]["role"], json!("assistant"));
    assert_eq!(
        session["turns"][2]["blocks"][0]["text"],
        json!("remote answer")
    );

    assert!(!append_remote_chat_text_turns(
        &mut session,
        "message-1",
        "remote question",
        "remote answer",
        100,
    )
    .expect("retry should be idempotent"));
    assert_eq!(session["updatedAt"], json!(99));
    assert_eq!(session["turns"].as_array().expect("turns").len(), 3);
}

#[test]
fn stale_full_ui_snapshot_retains_missing_remote_turns_in_stored_order() {
    let stored = chat_session(
        "chat-race",
        "default",
        "Race safe",
        99,
        vec![
            text_turn(0, "desktop before"),
            json!({
                "id": "remote-request-user",
                "role": "user",
                "blocks": [{ "kind": "text", "text": "phone question" }],
            }),
            json!({
                "id": "remote-request-assistant",
                "role": "assistant",
                "blocks": [{ "kind": "text", "text": "phone answer" }],
            }),
            json!({
                "id": "local-missing",
                "role": "assistant",
                "blocks": [{ "kind": "text", "text": "do not resurrect ordinary stale data" }],
            }),
            text_turn(2, "desktop after"),
        ],
    );
    // This is a full snapshot captured before the paired request appended its
    // durable remote turns. Its later desktop turn is still an ordering anchor.
    let mut stale_incoming = chat_session(
        "chat-race",
        "default",
        "Race safe",
        5,
        vec![
            text_turn(0, "desktop before"),
            text_turn(2, "desktop after"),
        ],
    );

    let merged = merge_missing_remote_chat_ui_turns(&mut stale_incoming, &stored);
    preserve_remote_chat_updated_at(&mut stale_incoming, &stored, merged);

    assert!(merged);
    assert_eq!(stale_incoming["updatedAt"], json!(99));
    assert_eq!(
        stale_incoming["turns"]
            .as_array()
            .expect("turns")
            .iter()
            .filter_map(|turn| turn["id"].as_str())
            .collect::<Vec<_>>(),
        vec![
            "turn-0",
            "remote-request-user",
            "remote-request-assistant",
            "turn-2",
        ]
    );
}

#[test]
fn chat_ui_preview_limits_only_tail_turns() {
    let turns = (0..40)
        .map(|index| text_turn(index, "x".repeat(30_000)))
        .collect::<Vec<_>>();
    let (preview, partial, base_ids) = chat_ui_preview_turns(&turns);

    assert!(partial);
    assert!(preview.len() <= CHAT_UI_SESSION_PREVIEW_MAX_TURNS);
    assert_eq!(base_ids.last().map(String::as_str), Some("turn-39"));
    assert!(!base_ids.iter().any(|id| id == "turn-0"));
}

#[test]
fn fast_tail_loader_keeps_a_single_huge_turn_in_full() {
    let huge = format!(
        "early setup that should be hidden{}FINAL ANSWER",
        "x".repeat(300_000)
    );
    let raw = serde_json::to_string(&json!({
        "id": "chat-large",
        "turns": [
            text_turn(0, "small"),
            text_turn(1, huge.clone()),
        ],
    }))
    .unwrap();
    let (start, end) = find_turns_array_bounds(&raw).expect("turns array");
    let (count, tail) = tail_turns_from_array(&raw, start, end, "chat-large");

    assert_eq!(count, 2);
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[1]["id"], json!("turn-1"));
    assert!(tail[1].get("omittedTurnIndex").is_none());
    assert_eq!(tail[1]["blocks"][0]["text"], json!(huge));
}

#[test]
fn regular_preview_keeps_a_single_huge_turn_in_full() {
    let huge = format!(
        "early setup that should be hidden{}FINAL ANSWER",
        "x".repeat(300_000)
    );
    let turns = vec![text_turn(0, "small"), text_turn(1, huge.clone())];
    let (preview, partial, base_ids) = chat_ui_preview_turns(&turns);

    assert!(!partial);
    assert_eq!(preview.len(), 2);
    assert_eq!(preview[1]["id"], json!("turn-1"));
    assert!(preview[1].get("omittedTurnIndex").is_none());
    assert_eq!(preview[1]["blocks"][0]["text"], json!(huge));
    assert_eq!(base_ids[1], "turn-1");
}

#[test]
fn turn_loader_reads_a_single_large_turn_by_index() {
    let huge = "x".repeat(300_000);
    let raw = serde_json::to_string(&json!({
        "id": "chat-large",
        "turns": [
            text_turn(0, "small"),
            text_turn(1, huge.clone()),
            text_turn(2, "tail"),
        ],
    }))
    .unwrap();
    let (start, end) = find_turns_array_bounds(&raw).expect("turns array");
    let loaded = turn_from_array_index(&raw, start, end, 1)
        .expect("turn load")
        .expect("turn");

    assert_eq!(loaded["id"], json!("turn-1"));
    assert_eq!(loaded["blocks"][0]["text"], json!(huge));
}

#[test]
fn partition_chat_ui_index_recovers_disk_only_ids_and_drops_stale_entries() {
    let index = vec![
        json!({"id": "kept", "turnCount": 1}),
        json!({"id": "stale", "turnCount": 1}),
    ];
    let disk_ids: HashSet<String> = ["kept".to_string(), "recovered".to_string()]
        .into_iter()
        .collect();

    let (reconciled, missing_ids, changed) = partition_chat_ui_index(index, &disk_ids);

    assert!(changed);
    assert_eq!(reconciled.len(), 1);
    assert_eq!(reconciled[0]["id"], json!("kept"));
    assert_eq!(missing_ids, vec!["recovered".to_string()]);
}

#[test]
fn partition_chat_ui_index_is_a_no_op_when_index_matches_disk() {
    let index = vec![json!({"id": "kept", "turnCount": 1})];
    let disk_ids: HashSet<String> = ["kept".to_string()].into_iter().collect();

    let (reconciled, missing_ids, changed) = partition_chat_ui_index(index.clone(), &disk_ids);

    assert!(!changed);
    assert_eq!(reconciled, index);
    assert!(missing_ids.is_empty());
}

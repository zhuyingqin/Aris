use super::{
    append_remote_chat_text_turns, chat_ui_preview_turns, find_turns_array_bounds,
    merge_missing_remote_chat_ui_turns, partition_chat_ui_index, preserve_remote_chat_updated_at,
    remote_chat_new_session_value, remote_chat_session_summary_for_project,
    remote_chat_sessions_from_index, remote_chat_transcript_for_project, tail_turns_from_array,
    turn_from_array_index, CHAT_UI_SESSION_PREVIEW_MAX_TURNS,
    MAX_REMOTE_CHAT_TRANSCRIPT_TEXT_BYTES,
};
use remote_protocol::ChatTranscriptBlock;
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
fn remote_chat_new_session_has_matching_empty_ui_state_and_summary() {
    let session = remote_chat_new_session_value("project-a", "chat-created", 42);
    assert_eq!(session["turns"], json!([]));
    assert_eq!(session["turnsLoaded"], true);
    assert_eq!(session["turnCount"], 0);
    assert_eq!(session["createdAt"], 42);

    let summary = remote_chat_session_summary_for_project(&session, "project-a")
        .expect("new session should have a project-scoped summary");
    assert_eq!(summary.id, "chat-created");
    assert_eq!(summary.title, "New chat");
    assert_eq!(summary.updated_at_unix_ms, 42);
    assert_eq!(summary.model, None);
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
fn remote_chat_transcript_matches_visible_text_thinking_and_tool_blocks() {
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
                    { "kind": "thinking", "thinking": "visible reasoning" },
                    { "kind": "tool", "id": "tool-1", "name": "read_file", "input": "visible input", "output": "visible output", "isError": false },
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
                blocks: vec![ChatTranscriptBlock::Text {
                    text: "Please summarize this.".to_string(),
                }],
                truncated: false,
            },
            super::RemoteChatTranscriptMessage {
                role: "assistant".to_string(),
                text: "Here is the summary.".to_string(),
                blocks: vec![
                    ChatTranscriptBlock::Thinking {
                        thinking: "visible reasoning".to_string(),
                    },
                    ChatTranscriptBlock::Tool {
                        tool_use_id: Some("tool-1".to_string()),
                        name: "read_file".to_string(),
                        input: "visible input".to_string(),
                        output: Some("visible output".to_string()),
                        is_error: Some(false),
                        progress: None,
                    },
                    ChatTranscriptBlock::Text {
                        text: "Here is the summary.".to_string(),
                    },
                ],
                truncated: false,
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
fn remote_chat_completion_replaces_a_saved_partial_assistant_turn() {
    let mut session = chat_session(
        "chat-live",
        "default",
        "Live",
        1,
        vec![
            json!({
                "id": "remote-message-live-user",
                "role": "user",
                "blocks": [{ "kind": "text", "text": "remote question" }],
            }),
            json!({
                "id": "remote-message-live-assistant",
                "role": "assistant",
                "blocks": [{ "kind": "text", "text": "partial" }],
                "streaming": true,
            }),
        ],
    );

    assert!(append_remote_chat_text_turns(
        &mut session,
        "message-live",
        "remote question",
        "complete answer",
        99,
    )
    .expect("completion should replace the live snapshot"));
    assert_eq!(session["turns"].as_array().expect("turns").len(), 2);
    assert_eq!(
        session["turns"][1]["blocks"][0]["text"],
        json!("complete answer")
    );
    assert_eq!(session["turns"][1]["streaming"], json!(false));
    assert_eq!(session["updatedAt"], json!(99));
}

#[test]
fn remote_chat_completion_preserves_saved_thinking_and_tool_blocks() {
    let mut session = chat_session(
        "chat-rich",
        "default",
        "Rich",
        1,
        vec![
            json!({
                "id": "remote-message-rich-user",
                "role": "user",
                "blocks": [{ "kind": "text", "text": "check it" }],
            }),
            json!({
                "id": "remote-message-rich-assistant",
                "role": "assistant",
                "blocks": [
                    { "kind": "thinking", "thinking": "checking" },
                    { "kind": "tool", "id": "tool-1", "name": "shell_command", "input": "ping", "output": "ok", "isError": false },
                    { "kind": "text", "text": "route " }
                ],
                "streaming": true,
            }),
        ],
    );

    assert!(append_remote_chat_text_turns(
        &mut session,
        "message-rich",
        "check it",
        "route is direct",
        99,
    )
    .expect("completion should preserve the rich snapshot"));
    let blocks = session["turns"][1]["blocks"].as_array().expect("blocks");
    assert_eq!(blocks[0]["kind"], json!("thinking"));
    assert_eq!(blocks[1]["kind"], json!("tool"));
    assert_eq!(blocks[1]["output"], json!("ok"));
    assert_eq!(blocks[2]["text"], json!("route is direct"));
    assert_eq!(session["turns"][1]["streaming"], json!(false));
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
    let (preview, partial, base_ids) = chat_ui_preview_turns("chat-tail", &turns);

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
fn regular_preview_omits_a_single_huge_turn_from_quick_load() {
    let huge = format!(
        "early setup that should be hidden{}FINAL ANSWER",
        "x".repeat(300_000)
    );
    let turns = vec![text_turn(0, "small"), text_turn(1, huge.clone())];
    let (preview, partial, base_ids) = chat_ui_preview_turns("chat-large", &turns);

    assert!(partial);
    assert_eq!(preview.len(), 2);
    assert_eq!(preview[1]["omittedTurnIndex"], json!(1));
    assert_eq!(
        preview[1]["omittedBytes"],
        json!(serde_json::to_vec(&turns[1]).unwrap().len())
    );
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

use super::{
    chat_ui_preview_turns, find_turns_array_bounds, partition_chat_ui_index, tail_turns_from_array,
    turn_from_array_index, CHAT_UI_SESSION_PREVIEW_MAX_TURNS,
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

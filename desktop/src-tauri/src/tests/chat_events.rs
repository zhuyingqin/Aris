use super::{
    bind_session_event_dir, chat_wire_rotated_log_paths, govern_wire_payload,
    read_events_from_path, read_last_seq, recover_session_for_export, remove_chat_wire_logs,
    replay_events, replay_session_events_in_dir, should_record_wire_event, ChatEventLogEntry,
};
use runtime::{ContentBlock, MessageRole};
use serde_json::json;
use std::{
    fs,
    io::Write,
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
fn replay_preserves_a_timeout_if_the_final_tool_result_was_not_written() {
    let events = vec![
        event(
            1,
            "tool_call",
            json!({"id":"browser-1","name":"mcp__playwright__browser_evaluate","input":"{}"}),
        ),
        event(
            2,
            "tool_timeout",
            json!({
                "id":"browser-1",
                "name":"mcp__playwright__browser_evaluate",
                "elapsedMs":120000,
                "timeoutMs":120000,
                "nearTimeout":true,
                "recovered":true,
                "message":"No progress for 120s"
            }),
        ),
    ];

    let replay = replay_events("chat-test", &events);
    let progress = &replay.turns[0]["blocks"][0]["progress"];
    assert_eq!(progress["nearTimeout"], json!(true));
    assert_eq!(progress["recovered"], json!(true));
    assert_eq!(progress["message"], json!("No progress for 120s"));
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

fn temp_event_dir(label: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("somniq-chat-events-{label}-{suffix}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write_event_log(dir: &std::path::Path, events: &[ChatEventLogEntry]) -> std::path::PathBuf {
    let path = dir.join("chat-test.events.jsonl");
    let body = events
        .iter()
        .map(|entry| serde_json::to_string(entry).expect("serialize event"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, format!("{body}\n")).expect("write event log");
    path
}

/// A log shaped like a long-running session: streaming deltas, a durable
/// canonical stream, an archived compaction, a checkpoint, and an in-flight
/// turn after it.
fn long_session_events() -> Vec<ChatEventLogEntry> {
    let archived = (0..4)
        .map(|index| json!({"role":"user","blocks":[{"type":"text","text":format!("archived {index}")}]}))
        .collect::<Vec<_>>();
    vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"stale prompt"}]}}),
        ),
        event(2, "assistant_thinking_delta", json!({"thinking":"stale "})),
        event(3, "assistant_thinking_delta", json!({"thinking":"reasoning"})),
        event(4, "assistant_delta", json!({"text":"stale answer"})),
        event(5, "session_reset", json!({"reason":"initial"})),
        event(
            6,
            "session_message",
            json!({"index":0,"message":{"role":"user","blocks":[{"type":"text","text":"durable prompt"}]}}),
        ),
        event(
            7,
            "session_message",
            json!({"index":1,"message":{"role":"assistant","blocks":[{"type":"text","text":"durable response"}]}}),
        ),
        event(
            8,
            "session_compaction",
            json!({"compaction":{
                "summary":"archived earlier turns",
                "messages": archived,
                "removed_message_count": 4,
                "preserved_message_count": 2,
                "summary_source":"model",
            }}),
        ),
        event(9, "session_usage", json!({"messageIndex":1,"usage":{"inputTokens":10,"outputTokens":20}})),
        event(10, "session_checkpoint", json!({"messageCount":2})),
        event(
            11,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"in-flight prompt"}]}}),
        ),
        event(12, "assistant_thinking_delta", json!({"thinking":"weighing "})),
        event(13, "assistant_thinking_delta", json!({"thinking":"options"})),
        event(14, "assistant_delta", json!({"text":"in-flight "})),
        event(15, "assistant_delta", json!({"text":"response"})),
    ]
}

/// The reader that skips archived payloads and pre-checkpoint deltas must
/// produce exactly what decoding the whole log produces. This is the contract
/// that lets a 98 MB log be opened without decoding 98 MB.
#[test]
fn narrowed_replay_reader_matches_a_full_decode_of_the_same_log() {
    let dir = temp_event_dir("replay-parity");
    let events = long_session_events();
    let path = write_event_log(&dir, &events);

    let full = replay_events(
        "chat-test",
        &read_events_from_path("chat-test", &path, None).expect("full read"),
    );
    let narrowed = replay_session_events_in_dir("chat-test", &dir).expect("narrowed replay");

    assert_eq!(narrowed.turns, full.turns);
    assert_eq!(narrowed.last_seq, full.last_seq);
    assert_eq!(narrowed.event_count, full.event_count);
    assert_eq!(narrowed.event_count, events.len());
    // The in-flight turn's deltas survive; the pre-checkpoint ones do not.
    assert_eq!(narrowed.turns.len(), 4);
    assert_eq!(
        narrowed.turns[2]["blocks"][0]["text"],
        json!("in-flight prompt")
    );
    assert_eq!(
        narrowed.turns[3]["blocks"][0]["thinking"],
        json!("weighing options")
    );
    assert_eq!(
        narrowed.turns[3]["blocks"][1]["text"],
        json!("in-flight response")
    );

    let _ = fs::remove_dir_all(dir);
}

/// Without a checkpoint there is no cut-off, so every UI event still replays.
#[test]
fn narrowed_replay_reader_keeps_every_event_when_the_log_has_no_canonical_stream() {
    let dir = temp_event_dir("replay-no-canonical");
    let events = vec![
        event(
            1,
            "user_message",
            json!({"message":{"role":"user","blocks":[{"type":"text","text":"prompt"}]}}),
        ),
        event(2, "assistant_delta", json!({"text":"partial "})),
        event(3, "assistant_delta", json!({"text":"answer"})),
    ];
    let path = write_event_log(&dir, &events);

    let full = replay_events(
        "chat-test",
        &read_events_from_path("chat-test", &path, None).expect("full read"),
    );
    let narrowed = replay_session_events_in_dir("chat-test", &dir).expect("narrowed replay");

    assert_eq!(narrowed.turns, full.turns);
    assert_eq!(narrowed.turns[1]["blocks"][0]["text"], json!("partial answer"));

    let _ = fs::remove_dir_all(dir);
}

/// The cut-off is the newest *checkpoint*, not the newest canonical event, so
/// the tail-first scan must keep looking past a later `session_message`.
#[test]
fn narrowed_replay_reader_cuts_at_the_checkpoint_not_at_a_later_canonical_event() {
    let dir = temp_event_dir("replay-late-canonical");
    let events = vec![
        event(1, "assistant_delta", json!({"text":"stale"})),
        event(
            2,
            "session_message",
            json!({"index":0,"message":{"role":"user","blocks":[{"type":"text","text":"durable prompt"}]}}),
        ),
        event(3, "session_checkpoint", json!({"messageCount":1})),
        event(
            4,
            "session_message",
            json!({"index":1,"message":{"role":"assistant","blocks":[{"type":"text","text":"durable response"}]}}),
        ),
        event(5, "assistant_delta", json!({"text":"in-flight"})),
    ];
    let path = write_event_log(&dir, &events);

    let full = replay_events(
        "chat-test",
        &read_events_from_path("chat-test", &path, None).expect("full read"),
    );
    let narrowed = replay_session_events_in_dir("chat-test", &dir).expect("narrowed replay");

    assert_eq!(narrowed.turns, full.turns);
    assert_eq!(narrowed.last_seq, full.last_seq);

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reading_one_kind_skips_the_rest_without_matching_on_payload_text() {
    let dir = temp_event_dir("kind-filter");
    let events = vec![
        event(1, "assistant_delta", json!({"text":"a delta"})),
        // A payload that merely mentions the wanted kind must not be promoted
        // into the result by the pre-parser scan.
        event(
            2,
            "assistant_delta",
            json!({"text":"quoting \"kind\":\"independent_review\" in prose"}),
        ),
        event(
            3,
            "independent_review",
            json!({"sessionId":"chat-test","phase":"reviewing","attempt":1}),
        ),
        event(4, "assistant_thinking_delta", json!({"thinking":"more"})),
    ];
    let path = write_event_log(&dir, &events);

    let filtered = read_events_from_path("chat-test", &path, Some(&["independent_review"]))
        .expect("filtered read");
    assert_eq!(
        filtered
            .iter()
            .map(|entry| (entry.seq, entry.kind.as_str()))
            .collect::<Vec<_>>(),
        vec![(3, "independent_review")]
    );
    assert_eq!(
        read_events_from_path("chat-test", &path, None)
            .expect("full read")
            .len(),
        4
    );

    let _ = fs::remove_dir_all(dir);
}

/// Deltas are appended one chunk at a time; a stopped turn can leave hundreds
/// of thousands of them in the log, so accumulation must not rebuild the block.
#[test]
fn replay_accumulates_many_deltas_into_one_block() {
    let mut events = vec![event(
        1,
        "user_message",
        json!({"message":{"role":"user","blocks":[{"type":"text","text":"go"}]}}),
    )];
    for seq in 0..2_000u64 {
        events.push(event(seq + 2, "assistant_delta", json!({"text":"x"})));
    }

    let replay = replay_events("chat-test", &events);
    assert_eq!(replay.turns.len(), 2);
    assert_eq!(
        replay.turns[1]["blocks"][0]["text"].as_str().map(str::len),
        Some(2_000)
    );
}

/// Sequences are assigned in append order, so the newest one is in the tail.
/// Re-reading the whole log for it made every sequence-cache miss cost the
/// size of the session.
#[test]
fn the_newest_sequence_is_found_without_reading_the_whole_log() {
    let dir = temp_event_dir("last-seq");
    let events = long_session_events();
    let path = write_event_log(&dir, &events);
    assert_eq!(read_last_seq(&path).expect("last sequence"), 15);

    // A crash can leave a partial final row; the sequence before it still
    // has to be found.
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open event log");
    write!(file, r#"{{"version":1,"seq":16,"kind":"assis"#).expect("write partial row");
    drop(file);
    assert_eq!(read_last_seq(&path).expect("last sequence"), 15);

    let _ = fs::remove_dir_all(dir);
}

/// One archived compaction row can be larger than the tail window, so the
/// scan has to widen rather than give up and report a fresh sequence.
#[test]
fn the_sequence_scan_widens_past_a_row_larger_than_its_window() {
    let dir = temp_event_dir("last-seq-wide");
    let filler = "x".repeat(300_000);
    let events = vec![
        event(7, "session_message", json!({"index":0,"text":filler.clone()})),
        event(8, "session_compaction", json!({"compaction":{"summary":filler}})),
    ];
    let path = write_event_log(&dir, &events);
    assert_eq!(read_last_seq(&path).expect("last sequence"), 8);

    let _ = fs::remove_dir_all(dir);
}

/// A checkpoint folds the turn it describes into the canonical stream, so the
/// streaming rows in front of it are dead weight from that moment on.
#[test]
fn writing_a_checkpoint_collects_the_streaming_rows_it_superseded() {
    let dir = temp_event_dir("checkpoint-compaction");
    let _binding = bind_session_event_dir("chat-test", dir.clone()).expect("bind event dir");
    let path = dir.join("chat-test.events.jsonl");
    for entry in long_session_events() {
        crate::chat_events::record_event("chat-test", &entry.kind, entry.payload);
    }
    let before = fs::metadata(&path).expect("event log").len();

    let mut session = runtime::Session::new();
    session
        .messages
        .push(runtime::ConversationMessage::user_text("durable prompt"));
    crate::chat_events::record_session_snapshot("chat-test", "test", &session);

    let after = fs::read_to_string(&path).expect("event log");
    assert!(
        (after.len() as u64) < before,
        "the checkpoint should have collected superseded rows",
    );
    // Every streaming row now sits behind a checkpoint that folded it into the
    // canonical stream.
    assert!(!after.contains("stale answer") && !after.contains("in-flight response"));
    // The canonical stream and the new checkpoint are what remain.
    assert!(after.contains("durable prompt"));
    assert_eq!(after.matches(r#""kind":"session_checkpoint""#).count(), 2);
    let replay = replay_session_events_in_dir("chat-test", &dir).expect("replay");
    assert_eq!(
        replay.turns[0]["blocks"][0]["text"],
        serde_json::json!("durable prompt")
    );

    drop(_binding);
    let _ = fs::remove_dir_all(dir);
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
    let events = read_events_from_path("chat-test", &path, None).expect("read recoverable events");
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

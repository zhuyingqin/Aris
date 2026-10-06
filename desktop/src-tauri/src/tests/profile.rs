use super::*;
use crate::usage_log::UsageLogEntry;

fn entry(session: &str, created_at: u64, input: u32, output: u32) -> UsageLogEntry {
    UsageLogEntry {
        created_at,
        session_id: session.to_string(),
        role: "executor".to_string(),
        server: String::new(),
        model: "m".to_string(),
        provider: "p".to_string(),
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        duration_ms: 0,
        turn_duration_ms: 0,
        reasoning_effort: String::new(),
        // Legacy shape on purpose: these fixtures cover the timestamp-grouping
        // fallback for rows written before `turnId` existed.
        turn_id: String::new(),
    }
}

fn entry_effort(session: &str, created_at: u64, duration_ms: u64, effort: &str) -> UsageLogEntry {
    UsageLogEntry {
        duration_ms,
        reasoning_effort: effort.to_string(),
        ..entry(session, created_at, 100, 20)
    }
}

#[test]
fn empty_is_zeroed() {
    let stats = aggregate(Vec::new(), Vec::new(), 0, false);
    assert_eq!(stats.cumulative_tokens, 0);
    assert_eq!(stats.peak_daily_tokens, 0);
    assert_eq!(stats.active_days, 0);
    assert_eq!(stats.current_streak, 0);
    assert_eq!(stats.longest_streak, 0);
    assert!(stats.daily.is_empty());
    assert!(stats.by_model.is_empty());
    assert!(stats.since.is_none());
    assert!(!stats.meta_logging_enabled);
    assert!(stats.longest_task_seconds.is_none());
    assert!(stats.top_reasoning_effort.is_none());
}

#[test]
fn tracks_duration_and_reasoning_effort() {
    let today_secs = (now_secs() / DAY_SECS) * DAY_SECS;
    let entries = vec![
        entry_effort("s1", today_secs + 10, 4_200, "high"),
        entry_effort("s2", today_secs + 20, 9_000, "xhigh"),
        entry_effort("s3", today_secs + 30, 1_000, "high"),
    ];
    let stats = aggregate(entries, Vec::new(), 0, false);
    // Longest task = max duration (9000ms → 9s).
    assert_eq!(stats.longest_task_seconds, Some(9));
    // "high" appears on two turns vs "xhigh" on one → it wins.
    assert_eq!(stats.top_reasoning_effort.as_deref(), Some("high"));
}

#[test]
fn streaks_handle_gaps_and_recency() {
    // Three consecutive days ending today.
    assert_eq!(streaks(&[98, 99, 100], 100), (3, 3));
    // Longest run is 3 but it ended before yesterday → current resets to 0.
    assert_eq!(streaks(&[90, 95, 96, 97], 100), (0, 3));
    // A run ending yesterday still counts as the current streak.
    assert_eq!(streaks(&[99], 100), (1, 1));
    // A single stale day.
    assert_eq!(streaks(&[50], 100), (0, 1));
    assert_eq!(streaks(&[], 100), (0, 0));
}

#[test]
fn aggregates_tokens_days_and_turns() {
    let today = now_secs() / DAY_SECS;
    let today_secs = today * DAY_SECS;
    let yesterday_secs = (today - 1) * DAY_SECS;

    let entries = vec![
        entry("s1", yesterday_secs + 10, 100, 50), // yesterday: 150
        entry("s1", today_secs + 10, 200, 100),    // today turn A: 300
        entry("s2", today_secs + 20, 10, 5),       // today turn B (other session): 15
    ];

    let stats = aggregate(
        entries,
        vec![ProfileSkillCount {
            name: "openalex-search".to_string(),
            runs: 3,
        }],
        7,
        true,
    );

    assert_eq!(stats.cumulative_tokens, 150 + 300 + 15);
    assert_eq!(stats.peak_daily_tokens, 315); // today's total
    assert_eq!(stats.active_days, 2);
    assert_eq!(stats.current_streak, 2);
    assert_eq!(stats.longest_streak, 2);
    assert_eq!(stats.total_turns, 3);
    assert_eq!(stats.daily.len(), 2);
    assert_eq!(stats.tool_calls, 7);
    assert_eq!(stats.skills_explored, 1);
    assert!(stats.meta_logging_enabled);
    assert!(stats.since.is_some());

    // Same model/provider across all entries collapses to one row with 3 turns.
    assert_eq!(stats.by_model.len(), 1);
    assert_eq!(stats.by_model[0].turns, 3);
    assert_eq!(stats.by_model[0].tokens, 465);
}

#[test]
fn zero_token_entries_are_ignored() {
    let today_secs = (now_secs() / DAY_SECS) * DAY_SECS;
    let stats = aggregate(vec![entry("s1", today_secs + 5, 0, 0)], Vec::new(), 0, true);
    assert_eq!(stats.cumulative_tokens, 0);
    assert_eq!(stats.active_days, 0);
    assert!(stats.daily.is_empty());
}

#[test]
fn day_math_matches_known_dates() {
    assert_eq!(days_to_ymd(0), (1970, 1, 1));
    assert_eq!(days_to_ymd(18628), (2021, 1, 1));
    assert_eq!(date_string(0), "1970-01-01");
    assert_eq!(date_string(18628), "2021-01-01");
}

/// Per-request rows must not each count as a turn.
///
/// Turns were identified by `(session, createdAt)` back when every row of a
/// turn carried the same timestamp. Rows now carry their own request time, so
/// without `turnId` a ten-request turn would report as ten turns and "longest
/// task" would shrink to the slowest single call.
#[test]
fn a_multi_request_turn_counts_once_and_sums_its_own_latency() {
    let today_secs = (now_secs() / DAY_SECS) * DAY_SECS;
    let rows = (0..5)
        .map(|index| UsageLogEntry {
            duration_ms: 400,
            turn_id: "chat-a#1".to_string(),
            ..entry("chat-a", today_secs + 10 + index * 7, 100, 20)
        })
        .collect::<Vec<_>>();

    let stats = aggregate(rows, Vec::new(), 0, false);

    assert_eq!(stats.total_turns, 1);
    // 5 x 400ms of model time in one turn, not a 400ms "longest task".
    assert_eq!(stats.longest_task_seconds, Some(2));
}

/// Two turns in the same second are still two turns.
#[test]
fn turns_are_distinguished_by_id_not_by_timestamp() {
    let today_secs = (now_secs() / DAY_SECS) * DAY_SECS;
    let rows = vec![
        UsageLogEntry {
            turn_id: "chat-a#1".to_string(),
            ..entry("chat-a", today_secs + 10, 100, 20)
        },
        UsageLogEntry {
            turn_id: "chat-a#2".to_string(),
            ..entry("chat-a", today_secs + 10, 100, 20)
        },
    ];

    let stats = aggregate(rows, Vec::new(), 0, false);
    assert_eq!(stats.total_turns, 2);
}

fn write_events(path: &Path, events: Vec<serde_json::Value>) {
    let lines = events
        .into_iter()
        .map(|event| event.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, lines).unwrap();
}

fn event(
    seq: u64,
    session: &str,
    kind: &str,
    ts: u64,
    payload: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({ "seq": seq, "sessionId": session, "kind": kind, "ts": ts, "payload": payload })
}

#[test]
fn reads_real_project_ledgers_and_deduplicates_durable_tool_events() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("project-a");
    let second = root.path().join("project-b");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let timestamp = now_secs().saturating_sub(10);
    let first_usage = first.join("usage-log.jsonl");
    let second_usage = second.join("usage-log.jsonl");
    fs::write(
        &first_usage,
        serde_json::to_string(&entry("a", timestamp, 100, 20)).unwrap(),
    )
    .unwrap();
    fs::write(
        &second_usage,
        serde_json::to_string(&entry("b", timestamp, 200, 30)).unwrap(),
    )
    .unwrap();
    write_events(
        &first.join("a.events.jsonl"),
        vec![
            event(1, "a", "user_message", 1_000, serde_json::json!({})),
            event(
                2,
                "a",
                "tool_call",
                2_000,
                serde_json::json!({ "id": "skill-1", "name": "Skill", "input": "{\"skill\":\"/research-wiki\"}" }),
            ),
            // A permission UI re-emission is the same call even without its input.
            event(
                3,
                "a",
                "tool_call",
                2_001,
                serde_json::json!({ "id": "skill-1", "name": "Skill" }),
            ),
            event(4, "a", "done", 11_200, serde_json::json!({})),
        ],
    );
    write_events(
        &second.join("b.events.jsonl"),
        vec![
            event(
                1,
                "b",
                "tool_call",
                3_000,
                serde_json::json!({ "id": "skill-1", "name": "Skill", "input": { "skill": "research-wiki" } }),
            ),
            event(
                2,
                "b",
                "tool_call",
                3_100,
                serde_json::json!({ "id": "read-1", "name": "read_file" }),
            ),
        ],
    );
    let stats = load_profile_stats_from_paths(
        HashSet::from([first_usage, second_usage]),
        HashSet::from([first, second]),
        None,
        false,
    )
    .unwrap();
    assert_eq!(stats.cumulative_tokens, 350);
    assert_eq!(stats.total_turns, 2);
    assert_eq!(stats.tool_calls, 3);
    assert_eq!(stats.skills_explored, 1);
    assert_eq!(stats.top_skills[0].name, "research-wiki");
    assert_eq!(stats.top_skills[0].runs, 2);
    assert_eq!(stats.longest_task_seconds, Some(11));
    assert!(stats.meta_logging_enabled);
    assert!(!stats.partial_data);
}

#[test]
fn metadata_fallback_excludes_sessions_already_in_desktop_events() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("meta.jsonl");
    fs::write(
        &path,
        [
            r#"{"session":"desktop","event":"tool_call"}"#,
            r#"{"session":"desktop","event":"skill_invoke","skill":"double-counted"}"#,
            r#"{"session":"cli","event":"tool_failure"}"#,
            r#"{"session":"cli","event":"skill_invoke","skill":"cli-skill"}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    let mut partial = false;
    let (skills, calls, available) =
        read_meta_events(&path, &HashSet::from(["desktop".into()]), &mut partial);
    assert_eq!(calls, 1);
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "cli-skill");
    assert!(available);
    assert!(!partial);
}

#[test]
fn corrupt_logs_are_reported_and_unreadable_usage_is_not_a_zero_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("usage.jsonl");
    fs::write(
        &path,
        format!(
            "{}\ninvalid\n",
            serde_json::to_string(&entry("s", now_secs(), 7, 3)).unwrap()
        ),
    )
    .unwrap();
    let stats =
        load_profile_stats_from_paths(HashSet::from([path]), HashSet::new(), None, false).unwrap();
    assert_eq!(stats.cumulative_tokens, 10);
    assert!(stats.partial_data);
    // Opening a directory as a ledger fails on both Windows and Unix.
    assert!(load_profile_stats_from_paths(
        HashSet::from([root.path().to_path_buf()]),
        HashSet::new(),
        None,
        false
    )
    .is_err());
}

#[test]
fn log_cache_updates_after_append_and_removes_deleted_sources() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("usage.jsonl");
    let mut cache = HashMap::new();
    let row = serde_json::to_string(&entry("s", now_secs(), 10, 5)).unwrap();
    fs::write(&path, &row).unwrap();
    assert!(
        matches!(read_cached_log(&mut cache, &path, true).unwrap(), Some(LogData::Usage(rows, false)) if rows.len() == 1)
    );
    fs::write(&path, format!("{row}\n{row}\n")).unwrap();
    assert!(
        matches!(read_cached_log(&mut cache, &path, true).unwrap(), Some(LogData::Usage(rows, false)) if rows.len() == 2)
    );
    fs::remove_file(&path).unwrap();
    assert!(read_cached_log(&mut cache, &path, true).unwrap().is_none());
    assert!(cache.is_empty());
}

#[test]
fn explored_skills_counts_beyond_the_top_eight_and_future_usage_is_ignored() {
    let skills = (0..12)
        .map(|index| ProfileSkillCount {
            name: format!("skill-{index}"),
            runs: 1,
        })
        .collect();
    let stats = aggregate(
        vec![entry("future", now_secs() + 2 * DAY_SECS, 100, 20)],
        skills,
        12,
        true,
    );
    assert_eq!(stats.skills_explored, 12);
    assert_eq!(stats.top_skills.len(), MAX_SKILLS);
    assert_eq!(stats.cumulative_tokens, 0);
    assert_eq!(stats.current_streak, 0);
}

#[test]
fn reads_compacted_canonical_messages_and_archives_without_double_counting() {
    let tool = serde_json::json!({ "type": "tool_use", "id": "skill-1", "name": "Skill", "input": "{\"skill\":\"paper-write\"}" });
    let message = serde_json::json!({ "role": "assistant", "blocks": [tool] });
    let events = vec![
        event(
            1,
            "s",
            "tool_call",
            1_000,
            serde_json::json!({ "id": "removed", "name": "read_file" }),
        ),
        event(2, "s", "session_reset", 1_001, serde_json::json!({})),
        event(
            3,
            "s",
            "session_compaction",
            1_002,
            serde_json::json!({ "compaction": { "messages": [message.clone()] } }),
        ),
        event(
            4,
            "s",
            "session_message",
            1_003,
            serde_json::json!({ "message": message }),
        ),
        event(
            5,
            "s",
            "tool_call",
            1_004,
            serde_json::json!({ "id": "skill-1", "name": "Skill", "input": { "skill": "paper-write" } }),
        ),
    ];
    let content = events
        .into_iter()
        .map(|event| event.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let log = read_activity_log(std::io::Cursor::new(content)).unwrap();
    assert_eq!(log.calls.len(), 1);
    assert_eq!(
        log.calls.values().next().unwrap().as_deref(),
        Some("paper-write")
    );
    assert!(!log.malformed);
}

#[test]
fn full_turn_duration_includes_tools_and_is_not_multiplied_by_request_count() {
    let timestamp = now_secs();
    let rows = vec![
        UsageLogEntry {
            duration_ms: 700,
            turn_id: "one".into(),
            ..entry("s", timestamp, 1, 1)
        },
        UsageLogEntry {
            duration_ms: 800,
            turn_duration_ms: 60_000,
            turn_id: "one".into(),
            ..entry("s", timestamp, 1, 1)
        },
    ];
    assert_eq!(
        aggregate(rows, Vec::new(), 0, false).longest_task_seconds,
        Some(60)
    );
}

#[test]
fn legacy_whole_turn_duration_is_not_repeated_for_each_request() {
    let timestamp = now_secs();
    let rows = (0..82)
        .map(|_| entry_effort("old", timestamp, 5_784_902, "high"))
        .collect();
    let stats = aggregate(rows, Vec::new(), 0, false);
    assert_eq!(stats.total_turns, 1);
    assert_eq!(stats.longest_task_seconds, Some(5_785));
}

#[test]
fn ordinary_ui_payloads_are_not_mistaken_for_malformed_canonical_messages() {
    let events = vec![
        event(
            1,
            "s",
            "context_warning",
            1_000,
            serde_json::json!({ "message": "Context is nearly full", "id": null }),
        ),
        event(
            2,
            "s",
            "user_message",
            2_000,
            serde_json::json!({ "message": "legacy plain text" }),
        ),
        event(
            3,
            "s",
            "done",
            3_000,
            serde_json::json!({ "message": "Done" }),
        ),
    ];
    let content = events
        .into_iter()
        .map(|event| event.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let log = read_activity_log(std::io::Cursor::new(content)).unwrap();
    assert!(!log.malformed);
    assert_eq!(log.longest_task_ms, 1_000);
}

#[test]
fn legacy_session_snapshots_contribute_calls_when_no_canonical_log_exists() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("old.json"), serde_json::json!({ "messages": [
        { "blocks": [{ "type": "tool_use", "id": "a", "name": "Skill", "input": { "skill": "literature-search" } }] }
    ] }).to_string()).unwrap();
    let stats = load_profile_stats_from_paths(
        HashSet::new(),
        HashSet::from([root.path().to_path_buf()]),
        None,
        false,
    )
    .unwrap();
    assert_eq!(stats.tool_calls, 1);
    assert_eq!(stats.top_skills[0].name, "literature-search");
    // Once the canonical log exists, the old snapshot must not add stale calls.
    write_events(
        &root.path().join("old.events.jsonl"),
        vec![event(
            1,
            "old",
            "session_checkpoint",
            1,
            serde_json::json!({}),
        )],
    );
    let stats = load_profile_stats_from_paths(
        HashSet::new(),
        HashSet::from([root.path().to_path_buf()]),
        None,
        false,
    )
    .unwrap();
    assert_eq!(stats.tool_calls, 0);
}

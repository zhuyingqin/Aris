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
        reasoning_effort: String::new(),
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

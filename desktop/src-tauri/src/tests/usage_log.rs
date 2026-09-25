use super::*;

#[test]
fn append_skips_empty_usage() {
    let usage = TokenUsage::default();
    assert!(!has_billable_tokens(&usage));
}

#[test]
fn legacy_usage_entries_default_to_executor_role() {
    let entry: UsageLogEntry = serde_json::from_str(
        r#"{"createdAt":1,"sessionId":"legacy","server":"","model":"m","provider":"p","inputTokens":1,"outputTokens":1,"cacheCreationInputTokens":0,"cacheReadInputTokens":0}"#,
    )
    .expect("legacy usage entry");

    assert_eq!(entry.role, "executor");
}

#[test]
fn debug_export_usage_filter_keeps_only_the_requested_session() {
    let content = concat!(
        "{\"createdAt\":1,\"sessionId\":\"chat-a\",\"server\":\"\",\"model\":\"m\",\"provider\":\"p\",\"inputTokens\":1,\"outputTokens\":1,\"cacheCreationInputTokens\":0,\"cacheReadInputTokens\":0}\n",
        "{not valid json}\n",
        "{\"createdAt\":2,\"sessionId\":\"chat-b\",\"server\":\"\",\"model\":\"m\",\"provider\":\"p\",\"inputTokens\":2,\"outputTokens\":2,\"cacheCreationInputTokens\":0,\"cacheReadInputTokens\":0}\n",
    );

    let filtered = filter_usage_log_for_session(content, "chat-b");
    let lines = filtered.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"sessionId\":\"chat-b\""));
}

fn usage(input: u32) -> TokenUsage {
    TokenUsage {
        input_tokens: input,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    }
}

/// Every row of a turn used to carry that turn's whole duration, so summing the
/// column counted the same interval once per request: a 3.2-hour session
/// reported 27 hours of model time across its 65 rows.
#[test]
fn each_request_row_carries_its_own_latency() {
    let usages = [usage(100), usage(200), usage(300)];
    let timings = [
        ModelRequestTiming { finished_at_secs: 1_000, duration_ms: 1_200 },
        ModelRequestTiming { finished_at_secs: 1_010, duration_ms: 800 },
        ModelRequestTiming { finished_at_secs: 1_030, duration_ms: 2_500 },
    ];

    let rows = build_usage_rows(
        "chat-1", "turn-1", "executor", "m", "p", "s", &usages, &timings, 99_999, "high",
        2_000,
    );

    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter().map(|row| row.duration_ms).collect::<Vec<_>>(),
        vec![1_200, 800, 2_500],
    );
    // Distinct timestamps too — previously every row shared the turn's end.
    assert_eq!(
        rows.iter().map(|row| row.created_at).collect::<Vec<_>>(),
        vec![1_000, 1_010, 1_030],
    );
    assert_eq!(rows.iter().map(|row| row.duration_ms).sum::<u64>(), 4_500);
}

/// When the wire trace and the usage list cannot be lined up, one row carries
/// the turn rather than all of them. The sum stays honest either way, which is
/// what every aggregate over this log relies on.
#[test]
fn a_turn_with_unusable_timings_reports_its_total_exactly_once() {
    let usages = [usage(100), usage(200), usage(300)];

    let rows = build_usage_rows(
        "chat-1", "turn-1", "executor", "m", "p", "s", &usages, &[], 5_000, "high", 2_000,
    );

    assert_eq!(rows.iter().map(|row| row.duration_ms).sum::<u64>(), 5_000);
    assert_eq!(rows.last().expect("row").duration_ms, 5_000);
    assert!(rows[..2].iter().all(|row| row.duration_ms == 0));
}

/// Alignment is positional, so a usage row dropped for being unbillable must
/// not shift every later row onto the wrong request's timing.
#[test]
fn unbillable_requests_do_not_shift_the_timing_alignment() {
    let usages = [usage(100), TokenUsage::default(), usage(300)];
    let timings = [
        ModelRequestTiming { finished_at_secs: 1, duration_ms: 10 },
        ModelRequestTiming { finished_at_secs: 2, duration_ms: 20 },
        ModelRequestTiming { finished_at_secs: 3, duration_ms: 30 },
    ];

    let rows = build_usage_rows(
        "chat-1", "turn-1", "executor", "m", "p", "s", &usages, &timings, 0, "high", 9,
    );

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].duration_ms, 10);
    assert_eq!(rows[1].duration_ms, 30, "the third request, not the second");
}

use super::*;

#[test]
fn distinct_outputs_reset_the_no_new_evidence_streak() {
    let mut ledger = EvidenceLedger::default();
    let first = ledger.observe("read_file", r#"{"path":"a"}"#, "alpha", false);
    let repeated = ledger.observe("read_file", r#"{"path":"a"}"#, "alpha", false);
    let changed = ledger.observe("read_file", r#"{"path":"a"}"#, "beta", false);

    assert_eq!(first.novelty, EvidenceNovelty::New);
    assert_eq!(repeated.novelty, EvidenceNovelty::Repeated);
    assert_eq!(repeated.consecutive_no_new, 1);
    assert_eq!(changed.novelty, EvidenceNovelty::New);
    assert_eq!(changed.consecutive_no_new, 0);
}

#[test]
fn timestamps_do_not_make_an_unchanged_status_look_new() {
    let mut ledger = EvidenceLedger::default();
    let first = ledger.observe(
        "job_status",
        r#"{"id":"job-1"}"#,
        r#"{"status":"running","elapsedMs":1000,"updatedAt":"one"}"#,
        false,
    );
    let second = ledger.observe(
        "job_status",
        r#"{"id":"job-1"}"#,
        r#"{"updatedAt":"two","elapsedMs":9000,"status":"running"}"#,
        false,
    );

    assert_eq!(first.novelty, EvidenceNovelty::New);
    assert_eq!(second.novelty, EvidenceNovelty::Repeated);
}

#[test]
fn artifact_content_hash_not_per_call_path_defines_restored_evidence_identity() {
    let mut ledger = EvidenceLedger::default();
    let sha256 = "a".repeat(64);
    let first = serde_json::json!({
        "status": "referenced",
        "persistedOutputPath": "C:/project/.somniq/tmp/tool-output/first.txt",
        "sha256": sha256,
        "preview": "first preview"
    })
    .to_string();
    let second = serde_json::json!({
        "status": "referenced",
        "persistedOutputPath": "C:/project/.somniq/tmp/tool-output/second.txt",
        "sha256": "a".repeat(64),
        "preview": "different bounded preview"
    })
    .to_string();

    assert_eq!(
        ledger.observe("read_file", "{}", &first, false).novelty,
        EvidenceNovelty::New
    );
    assert_eq!(
        ledger.observe("read_file", "{}", &second, false).novelty,
        EvidenceNovelty::Repeated
    );
}

#[test]
fn repeated_identical_calls_are_blocked_only_after_a_sustained_streak() {
    let mut ledger = EvidenceLedger::default();
    for _ in 0..=NO_NEW_EVIDENCE_BLOCK_CALLS {
        let _ = ledger.observe("read_file", r#"{"path":"a"}"#, "unchanged", false);
    }

    let blocked = ledger
        .block_repeated_invocation("read_file", r#"{"path":"a"}"#)
        .expect("repeated call should be blocked");
    assert!(blocked.identical_invocations >= MIN_IDENTICAL_INVOCATIONS_TO_BLOCK);
    assert!(blocked.message.contains("Change the hypothesis"));
}

#[test]
fn a_different_call_remains_available_during_a_no_evidence_streak() {
    let mut ledger = EvidenceLedger::default();
    for _ in 0..=NO_NEW_EVIDENCE_BLOCK_CALLS {
        let _ = ledger.observe("read_file", r#"{"path":"a"}"#, "unchanged", false);
    }

    assert!(ledger
        .block_repeated_invocation("grep_search", r#"{"query":"new"}"#)
        .is_none());
}

#[test]
fn polling_tools_get_a_larger_hard_block_window() {
    let mut ledger = EvidenceLedger::default();
    for _ in 0..=NO_NEW_EVIDENCE_BLOCK_CALLS {
        let _ = ledger.observe("job_status", r#"{"id":"job-1"}"#, "running", false);
    }

    assert!(ledger
        .block_repeated_invocation("job_status", r#"{"id":"job-1"}"#)
        .is_none());

    for _ in
        NO_NEW_EVIDENCE_BLOCK_CALLS + 1..=NO_NEW_EVIDENCE_BLOCK_CALLS * POLLING_BLOCK_MULTIPLIER
    {
        let _ = ledger.observe("job_status", r#"{"id":"job-1"}"#, "running", false);
    }
    assert!(ledger
        .block_repeated_invocation("job_status", r#"{"id":"job-1"}"#)
        .is_some());
}

#[test]
fn repeated_errors_ignore_changing_line_numbers() {
    let mut ledger = EvidenceLedger::default();
    let first = ledger.observe("bash", "{}", "error at line 12: missing", true);
    let second = ledger.observe("bash", "{}", "error at line 97: missing", true);

    assert_eq!(first.novelty, EvidenceNovelty::New);
    assert_eq!(second.novelty, EvidenceNovelty::Repeated);
}

#[test]
fn ledger_can_be_reconstructed_from_session_messages() {
    let messages = vec![
        ConversationMessage::user_text("inspect the job"),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "status-1".to_string(),
            name: "job_status".to_string(),
            input: r#"{"id":"job-1"}"#.to_string(),
        }]),
        ConversationMessage::tool_result(
            "status-1",
            "job_status",
            r#"{"status":"running","updatedAt":"one"}"#,
            false,
        ),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "status-2".to_string(),
            name: "job_status".to_string(),
            input: r#"{"id":"job-1"}"#.to_string(),
        }]),
        ConversationMessage::tool_result(
            "status-2",
            "job_status",
            concat!(
                r#"{"updatedAt":"two","status":"running"}"#,
                "\n\nEvidence check (generated by Aris from tool results, not by the user): change strategy"
            ),
            false,
        ),
    ];

    let ledger = EvidenceLedger::from_messages(&messages);
    let facts = ledger.facts().join("; ");

    assert!(facts.contains("1 distinct evidence result(s) across 2 completed tool call(s)"));
    assert!(facts.contains("1 repeated"));
    assert!(facts.contains("no-new-evidence streak is 1"));
}

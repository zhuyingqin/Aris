use super::*;

fn user(text: &str) -> ConversationMessage {
    ConversationMessage::user_text(text)
}

fn tool_use(name: &str, input: &str) -> ConversationMessage {
    ConversationMessage {
        role: MessageRole::Assistant,
        blocks: vec![ContentBlock::ToolUse {
            id: format!("call-{name}-{input}"),
            name: name.to_string(),
            input: input.to_string(),
        }],
        usage: None,
    }
}

fn tool_error(name: &str, output: &str) -> ConversationMessage {
    ConversationMessage {
        role: MessageRole::Tool,
        blocks: vec![ContentBlock::ToolResult {
            tool_use_id: "call".to_string(),
            tool_name: name.to_string(),
            output: output.to_string(),
            is_error: true,
        }],
        usage: None,
    }
}

#[test]
fn window_starts_after_the_last_substantive_user_message() {
    let mut messages = vec![user("first request")];
    for index in 0..5 {
        messages.push(tool_use("edit_file", &format!(r#"{{"path":"a-{index}.rs"}}"#)));
    }
    messages.push(user("second request"));
    messages.push(tool_use("edit_file", r#"{"path":"b.rs"}"#));

    let signals = FocusSignals::from_messages(&messages);
    assert_eq!(signals.tool_calls, 1);
    assert_eq!(signals.distinct_files, 1);
    assert_eq!(signals.top_file, Some(("b.rs".to_string(), 1)));
}

#[test]
fn an_aris_continuation_prompt_does_not_reset_the_window() {
    // A compaction mid-rabbit-hole injects an internal user message. If that
    // reset the window, every compaction would erase the evidence that the
    // work has been narrow — exactly when the reminder matters most.
    let mut messages = vec![user("original request")];
    for _ in 0..4 {
        messages.push(tool_use("edit_file", r#"{"path":"stuck.rs"}"#));
    }
    messages.push(user(
        "This session is being continued from a previous conversation that ran out of context.",
    ));
    for _ in 0..4 {
        messages.push(tool_use("edit_file", r#"{"path":"stuck.rs"}"#));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert_eq!(signals.tool_calls, 8);
    assert_eq!(signals.top_file, Some(("stuck.rs".to_string(), 8)));
    assert!(signals.is_rabbit_hole());
}

#[test]
fn repeated_failures_are_counted_across_varying_line_numbers() {
    let mut messages = vec![user("fix the build")];
    for line in 0..RABBIT_HOLE_ERROR_REPEATS {
        messages.push(tool_error(
            "bash",
            &format!("error[E0308]: mismatched types at line {}", 40 + line),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    let (signature, count) = signals.top_error.clone().expect("repeated error");
    assert_eq!(count, RABBIT_HOLE_ERROR_REPEATS);
    assert!(signature.starts_with("bash: error[e#]: mismatched types at line #"));
    assert!(signals
        .reasons()
        .iter()
        .any(|reason| reason.contains("the same failure has come back")));
}

#[test]
fn broad_work_across_many_files_is_not_flagged() {
    let mut messages = vec![user("survey the crates")];
    for index in 0..RABBIT_HOLE_TOOL_CALLS - 1 {
        messages.push(tool_use(
            "read_file",
            &format!(r#"{{"path":"crate-{index}.rs"}}"#),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert!(!signals.is_rabbit_hole());
    assert!(signals.nudge().is_none());
    // The facts are still reported to the summary even when nothing is flagged.
    assert!(signals.facts()[0].contains("distinct file(s)"));
}

#[test]
fn nudge_asks_for_a_decision_rather_than_ordering_a_stop() {
    let mut messages = vec![user("make the parser work")];
    for _ in 0..RABBIT_HOLE_FILE_REPEATS {
        messages.push(tool_use("edit_file", r#"{"path":"parser.rs"}"#));
    }

    let nudge = FocusSignals::from_messages(&messages)
        .nudge()
        .expect("nudge past the file-repeat threshold");
    assert!(nudge.contains("parser.rs has been operated on"));
    assert!(nudge.contains("not by the user"));
    assert!(nudge.contains("say so briefly and carry on"));
}

#[test]
fn paging_through_one_large_file_is_not_a_rabbit_hole() {
    // `read_file` names its target with the same `path` key an edit does, so
    // reading a long file in pages used to look identical to editing one file
    // over and over.
    let mut messages = vec![user("summarize the big file")];
    for page in 0..RABBIT_HOLE_FILE_REPEATS + 2 {
        messages.push(tool_use(
            "read_file",
            &format!(r#"{{"path":"big.rs","offset":{},"limit":200}}"#, page * 200),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert!(!signals.is_rabbit_hole(), "paging is ordinary work");
    assert_eq!(signals.distinct_files, 1, "it is still one file");
}

#[test]
fn returning_to_the_same_region_over_and_over_is_still_flagged() {
    let mut messages = vec![user("fix the parser")];
    for _ in 0..RABBIT_HOLE_FILE_REPEATS {
        messages.push(tool_use(
            "read_file",
            r#"{"path":"big.rs","offset":400,"limit":200}"#,
        ));
    }

    assert!(FocusSignals::from_messages(&messages).is_rabbit_hole());
}

#[test]
fn a_shrinking_window_re_arms_the_reminder() {
    // A compaction mid-stretch drops the older part of the window, so the
    // tool-call count falls. Without this, the counter recorded before the
    // compaction suppresses the reminder for another full stretch — at exactly
    // the point the session has already spent a whole context on one point.
    assert!(focus_nudge_due(None, 3));
    assert!(!focus_nudge_due(Some(10), 10));
    assert!(!focus_nudge_due(
        Some(10),
        10 + RABBIT_HOLE_RENUDGE_TOOL_CALLS - 1
    ));
    assert!(focus_nudge_due(Some(10), 10 + RABBIT_HOLE_RENUDGE_TOOL_CALLS));
    assert!(focus_nudge_due(Some(10), 4), "the window shrank");
}

#[test]
fn an_empty_window_produces_no_facts() {
    assert!(FocusSignals::from_messages(&[user("hello")])
        .facts()
        .is_empty());
    assert!(FocusSignals::default().nudge().is_none());
}

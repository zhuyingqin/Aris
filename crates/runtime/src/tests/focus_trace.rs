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
        messages.push(tool_use(
            "edit_file",
            &format!(r#"{{"path":"a-{index}.rs"}}"#),
        ));
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
    assert!(focus_nudge_due(
        Some(10),
        10 + RABBIT_HOLE_RENUDGE_TOOL_CALLS
    ));
    assert!(focus_nudge_due(Some(10), 4), "the window shrank");
}

#[test]
fn an_empty_window_produces_no_facts() {
    assert!(FocusSignals::from_messages(&[user("hello")])
        .facts()
        .is_empty());
    assert!(FocusSignals::default().nudge().is_none());
}

/// Every built-in tool returns pretty-printed JSON, so reading the blob as
/// plain text gives `{` as the first line for every failure of every tool.
/// That collapsed all distinct failures onto one signature: four unrelated
/// errors read as one unresolved loop, and the dead end pinned through
/// compaction said only `bash: {`.
#[test]
fn distinct_failures_inside_one_json_payload_get_distinct_signatures() {
    let missing_module = error_signature(
        "bash",
        r#"{
  "stdout": "",
  "stderr": "ModuleNotFoundError: No module named 'torch'",
  "returnCodeInterpretation": "exit_code:1"
}"#,
    )
    .expect("signature");
    let diverged = error_signature(
        "bash",
        r#"{
  "stdout": "",
  "stderr": "AssertionError: loss diverged at step 400",
  "returnCodeInterpretation": "exit_code:1"
}"#,
    )
    .expect("signature");

    assert_ne!(missing_module, diverged);
    assert!(missing_module.contains("modulenotfounderror"));
    assert!(diverged.contains("assertionerror"));
    assert!(!missing_module.contains('{'), "{missing_module}");
}

/// A Python traceback opens with the same header every time and names the
/// exception on its last line, so reading it from the front makes every failed
/// training script look identical.
#[test]
fn a_traceback_is_identified_by_its_exception_not_its_header() {
    let signature = error_signature(
        "bash",
        r#"{
  "stderr": "Traceback (most recent call last):\n  File \"train.py\", line 88, in <module>\n    main()\nValueError: expected 3 channels, got 1",
  "returnCodeInterpretation": "exit_code:1"
}"#,
    )
    .expect("signature");

    assert!(signature.contains("valueerror"), "{signature}");
    assert!(!signature.contains("traceback"), "{signature}");
}

/// A notebook cell reports its exception as a structured output block; that is
/// the exact identity of the failure, and it is what the repeat counter needs.
#[test]
fn a_failed_notebook_cell_is_identified_by_its_exception() {
    let signature = error_signature(
        "NotebookExecute",
        r#"{
  "status": "error",
  "cellIndex": 4,
  "text": "traceback text",
  "outputs": [
    { "type": "error", "ename": "RuntimeError", "evalue": "CUDA out of memory" }
  ]
}"#,
    )
    .expect("signature");

    assert!(signature.contains("runtimeerror"), "{signature}");
    assert!(signature.contains("cuda out of memory"), "{signature}");
}

/// Four different failures are not one failure. Before the signature looked
/// past the JSON envelope they all counted as the same one and tripped the
/// repeat threshold on unrelated errors.
#[test]
fn unrelated_failures_do_not_accumulate_into_one_repeat() {
    let mut messages = vec![user("run the experiment")];
    for reason in [
        "FileNotFoundError: data/train.csv",
        "KeyError: 'label'",
        "AssertionError: shape mismatch",
        "ZeroDivisionError: division by zero",
    ] {
        messages.push(tool_error(
            "bash",
            &format!(
                r#"{{"stdout":"","stderr":{reason:?},"returnCodeInterpretation":"exit_code:1"}}"#
            ),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert!(signals.repeated_errors.is_empty(), "{signals:?}");
    assert!(!signals.has_repeated_failure());
    assert!(signals.dead_ends().is_empty());
}

/// The counterpart: one failure that genuinely keeps coming back must still be
/// caught through the JSON envelope, and must reach the pinned dead end with
/// enough text to mean something after compaction.
#[test]
fn one_recurring_failure_still_reaches_the_pinned_dead_end() {
    let mut messages = vec![user("run the experiment")];
    for step in 0..RABBIT_HOLE_ERROR_REPEATS {
        messages.push(tool_error(
            "NotebookExecute",
            &format!(
                r#"{{"status":"error","cellIndex":{step},"outputs":[{{"type":"error","ename":"RuntimeError","evalue":"CUDA out of memory"}}]}}"#
            ),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert!(signals.has_repeated_failure());
    let dead_end = signals.dead_ends().pop().expect("dead end");
    assert!(dead_end.contains("cuda out of memory"), "{dead_end}");
    assert!(dead_end.contains("recurred"), "{dead_end}");
}

/// A repeated identical failure is not merely narrow work, so the reminder asks
/// for a different approach or a stop rather than a one-line statement the
/// model can satisfy and carry on from.
#[test]
fn a_repeated_failure_nudge_demands_a_change_not_a_statement() {
    let mut messages = vec![user("fix the training run")];
    for _ in 0..RABBIT_HOLE_ERROR_REPEATS {
        messages.push(tool_error(
            "bash",
            r#"{"stderr":"AssertionError: loss diverged","returnCodeInterpretation":"exit_code:1"}"#,
        ));
    }

    let nudge = FocusSignals::from_messages(&messages)
        .nudge()
        .expect("nudge past the error-repeat threshold");
    assert!(
        nudge.contains("Do not retry the same thing again"),
        "{nudge}"
    );
    assert!(!nudge.contains("say so briefly and carry on"), "{nudge}");
}

/// Notebook tools address a cell inside one file. Without the cell in the
/// target identity, working down a notebook cell by cell — the most ordinary
/// thing that happens in the Lab — collapsed onto one target and was reported
/// as eight operations on a single point.
#[test]
fn working_down_a_notebook_cell_by_cell_is_not_a_rabbit_hole() {
    let mut messages = vec![user("run the analysis")];
    for cell in 0..RABBIT_HOLE_FILE_REPEATS + 2 {
        messages.push(tool_use(
            "NotebookExecute",
            &format!(r#"{{"notebook_path":"study.ipynb","cell_index":{cell}}}"#),
        ));
    }

    let signals = FocusSignals::from_messages(&messages);
    assert!(!signals.is_rabbit_hole(), "cell-by-cell work is ordinary");
    assert_eq!(signals.distinct_files, 1, "it is still one notebook");
}

/// The counterpart: re-running the *same* cell over and over is exactly the
/// narrow-focus signal, and must still be caught.
#[test]
fn re_running_one_notebook_cell_is_still_flagged() {
    let mut messages = vec![user("make cell 4 work")];
    for _ in 0..RABBIT_HOLE_FILE_REPEATS {
        messages.push(tool_use(
            "NotebookExecute",
            r#"{"notebook_path":"study.ipynb","cell_index":4}"#,
        ));
    }

    assert!(FocusSignals::from_messages(&messages).is_rabbit_hole());
}

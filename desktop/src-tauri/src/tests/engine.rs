use super::*;

#[test]
fn research_memory_cites_and_extracts_only_the_final_assistant_message() {
    let mut session = Session::new();
    session.messages = vec![
        ConversationMessage::user_text("Why did main.tex fail?"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "I will inspect the build log first.".to_string(),
        }]),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "tool-1".to_string(),
            name: "Read".to_string(),
            input: "{}".to_string(),
        }]),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "main.tex failed because the log contains Undefined control sequence."
                .to_string(),
        }]),
    ];

    assert_eq!(
        final_assistant_memory_source(&session),
        Some((
            3,
            "main.tex failed because the log contains Undefined control sequence.".to_string()
        ))
    );
}

#[test]
fn interrupted_research_followup_distinguishes_continue_summary_and_new_work() {
    assert_eq!(
        classify_interrupted_research_follow_up("下载卡住了，换个来源核验"),
        InterruptedResearchFollowUp::Continue
    );
    assert_eq!(
        classify_interrupted_research_follow_up(
            "Continue from where you stopped and verify the same paper."
        ),
        InterruptedResearchFollowUp::Continue
    );
    assert_eq!(
        classify_interrupted_research_follow_up("有结果吗？"),
        InterruptedResearchFollowUp::Summarize
    );
    assert_eq!(
        classify_interrupted_research_follow_up("找到了吗，进展怎么样"),
        InterruptedResearchFollowUp::Summarize
    );
    assert_eq!(
        classify_interrupted_research_follow_up("帮我找一篇 Deep-08 方向的新论文"),
        InterruptedResearchFollowUp::None
    );
    assert_eq!(
        classify_interrupted_research_follow_up("Find a new paper about scaling laws."),
        InterruptedResearchFollowUp::None
    );
}

#[test]
fn debug_export_rebuilds_empty_cancelled_session_from_event_log() {
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let session_id = format!("chat-debug-recovery-{suffix}");
    let dir = std::env::temp_dir().join(&session_id);
    std::fs::create_dir_all(&dir).expect("temp debug directory");
    let _binding = crate::chat_events::bind_session_event_dir(&session_id, dir.clone())
        .expect("bind event directory");
    crate::chat_events::record_event(
        &session_id,
        "user_message",
        json!({"message":{"role":"user","blocks":[{"type":"text","text":"find the paper"}]}}),
    );
    crate::chat_events::record_event(
        &session_id,
        "assistant_delta",
        json!({"text":"Searching the frozen candidate corpus."}),
    );
    crate::chat_events::record_event(
        &session_id,
        "error",
        json!({"message":"interrupted by user"}),
    );

    let zip_path = dir.join("debug.zip");
    let export =
        export_debug_zip(&session_id, &Session::new(), zip_path.to_str()).expect("debug export");
    assert_eq!(export.session_source, "event_replay");
    assert!(export.message_count >= 2);

    let file = std::fs::File::open(&export.path).expect("debug zip");
    let mut archive = zip::ZipArchive::new(file).expect("valid debug zip");
    assert!(archive.by_name("app-events.jsonl").is_err());
    assert!(archive.by_name("usage-log.jsonl").is_err());
    let mut runtime_session = String::new();
    archive
        .by_name("runtime-session.json")
        .expect("runtime session entry")
        .read_to_string(&mut runtime_session)
        .expect("read runtime session");
    let runtime_session: serde_json::Value =
        serde_json::from_str(&runtime_session).expect("runtime session JSON");
    assert!(runtime_session["messages"]
        .as_array()
        .is_some_and(|messages| messages.len() >= 2));

    let mut transcript = String::new();
    archive
        .by_name("conversation.md")
        .expect("transcript entry")
        .read_to_string(&mut transcript)
        .expect("read transcript");
    assert!(transcript.contains("find the paper"));
    assert!(transcript.contains("Searching the frozen candidate corpus."));
    drop(archive);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn model_retry_events_are_content_free_and_keep_retry_timing() {
    let payload = model_retry_event_payload(
        "chat-retry",
        "llm.retry",
        &json!({
            "phase": "send",
            "attempt": 1,
            "maxAttempts": 4,
            "backoffMs": 1_000,
            "error": "provider response body must stay out of the UI",
        }),
    )
    .expect("retry payload");

    assert_eq!(payload["sessionId"], "chat-retry");
    assert_eq!(payload["action"], "retrying");
    assert_eq!(payload["phase"], "send");
    assert_eq!(payload["attempt"], 1);
    assert_eq!(payload["maxAttempts"], 4);
    assert_eq!(payload["backoffMs"], 1_000);
    assert!(payload.get("error").is_none());
    assert!(model_retry_event_payload("chat-retry", "llm.response_start", &json!({})).is_none());
}

#[test]
fn internal_no_tools_executor_denies_unexpected_tool_calls() {
    let mut executor = NoToolsExecutor;
    let error = executor
        .execute("bash", r#"{"command":"echo should-not-run"}"#)
        .expect_err("internal no-tools executor must reject every tool");

    assert!(error
        .to_string()
        .contains("not available during this no-tools request"));
}

fn review_test_summary(tool_name: Option<&str>) -> runtime::TurnSummary {
    let assistant = tool_name.map_or_else(
        || {
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Direct answer".to_string(),
            }])
        },
        |name| {
            ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                id: "tool-review".to_string(),
                name: name.to_string(),
                input: "{}".to_string(),
            }])
        },
    );
    runtime::TurnSummary {
        assistant_messages: vec![assistant],
        tool_results: Vec::new(),
        iterations: 1,
        usage: TokenUsage::default(),
        auto_compaction: None,
    }
}

#[test]
fn independent_review_policy_skips_simple_answers_and_gates_tool_work() {
    assert!(!review_required_for_turn(
        "What is two plus two?",
        &review_test_summary(None)
    ));
    assert!(review_required_for_turn(
        "修复这个 Rust 函数",
        &review_test_summary(Some("edit_file"))
    ));
    assert!(review_required_for_turn(
        "检查集成测试",
        &review_test_summary(Some("bash"))
    ));
    assert!(review_required_for_turn(
        "continue",
        &review_test_summary(Some("append_file"))
    ));
    assert!(!review_required_for_turn(
        "continue",
        &review_test_summary(Some("TodoWrite"))
    ));
    assert!(!review_required_for_turn(
        "Explain how to build a conceptual framework",
        &review_test_summary(None)
    ));
    assert!(review_required_for_turn(
        "Please review this answer",
        &review_test_summary(None)
    ));
    assert!(!review_required_for_turn(
        "What issues did the Reviewer raise?",
        &review_test_summary(None)
    ));
    assert!(!review_required_for_turn(
        "审查者提了什么问题？",
        &review_test_summary(Some("edit_file"))
    ));
    assert!(review_required_for_turn(
        "请重新审查这份综述",
        &review_test_summary(None)
    ));

    let production_summary = review_test_summary(Some("edit_file"));
    assert!(should_run_independent_review(
        false,
        true,
        "Fix this function",
        &production_summary,
    ));
    assert!(!should_run_independent_review(
        false,
        false,
        "Fix this function",
        &production_summary,
    ));
    assert!(!should_run_independent_review(
        true,
        true,
        "Fix this function",
        &production_summary,
    ));
}

#[test]
fn reviewer_must_not_share_the_executor_identity() {
    assert!(!reviewer_is_independent(
        "openai", "gpt-5.5", "OpenAI", "GPT-5.5"
    ));
    assert!(reviewer_is_independent(
        "openai",
        "gpt-5.5",
        "minimax",
        "MiniMax-M3"
    ));
    assert!(reviewer_is_independent(
        "openai", "gpt-5.5", "openai", "gpt-5.6"
    ));
}

#[test]
fn chatgpt_web_image_tool_is_narrow_and_requires_external_action_approval() {
    let spec = chatgpt_web_image_tool_spec();
    assert_eq!(spec.name, CHATGPT_WEB_IMAGE_TOOL);
    assert_eq!(spec.required_permission, PermissionMode::DangerFullAccess);
    assert_eq!(spec.input_schema["required"], serde_json::json!(["prompt"]));
    assert_eq!(spec.input_schema["properties"]["files"]["maxItems"], 20);
    assert!(spec.input_schema["properties"].get("url").is_none());
    assert!(spec.input_schema["properties"].get("accountId").is_none());
}

#[test]
fn generic_tool_progress_does_not_reflow_chat_during_image_generation() {
    assert!(!should_emit_generic_tool_progress(CHATGPT_WEB_IMAGE_TOOL));
    assert!(should_emit_generic_tool_progress(CHATGPT_WEB_CONSULT_TOOL));
}

#[test]
fn latex_compile_progress_stays_out_of_live_chat() {
    assert!(!should_emit_generic_tool_progress(LATEX_COMPILE_TOOL));
    assert!(!should_emit_live_tool_progress(
        ChatEventDelivery::Desktop,
        LATEX_COMPILE_TOOL,
    ));
    assert!(!should_emit_live_tool_progress(
        ChatEventDelivery::DesktopAndRemote,
        LATEX_COMPILE_TOOL,
    ));
    assert!(should_emit_live_tool_progress(
        ChatEventDelivery::Workflow,
        LATEX_COMPILE_TOOL,
    ));
    assert!(should_emit_live_tool_progress(
        ChatEventDelivery::Desktop,
        CHATGPT_WEB_CONSULT_TOOL,
    ));
}

#[test]
fn chatgpt_web_consult_tool_is_narrow_and_requires_external_action_approval() {
    let spec = chatgpt_web_consult_tool_spec();
    assert_eq!(spec.name, CHATGPT_WEB_CONSULT_TOOL);
    assert_eq!(spec.required_permission, PermissionMode::DangerFullAccess);
    assert_eq!(spec.input_schema["required"], serde_json::json!(["prompt"]));
    assert_eq!(spec.input_schema["properties"]["files"]["maxItems"], 20);
    assert!(spec.input_schema["properties"].get("url").is_none());
    assert!(spec.input_schema["properties"].get("accountId").is_none());
}

#[test]
fn json_extractor_uses_the_last_complete_object_after_transport_logs() {
    let raw = r#"oracle diagnostic {not-json}
{"status":"booting"}
response: {"verdict":"pass","summary":"braces inside a string: {ok}"}"#;
    assert_eq!(
        extract_json_object(raw),
        Some(r#"{"verdict":"pass","summary":"braces inside a string: {ok}"}"#)
    );
}

#[test]
fn independent_review_parser_keeps_adversarial_findings_structured() {
    let result = parse_independent_review(
        r#"preface <thinking>discard me</thinking> {
          "verdict":"revise",
          "summary":"Agent path was not checked",
          "issues":[{"severity":"high","title":"Missing path","detail":"Only desktop changed","evidence":"diff","recommendation":"inspect agent"}],
          "evidenceChecked":["desktop diff"],
          "missingChecks":["cargo check"],
          "revisionInstructions":["inspect agent path"],
          "relevantToGoal":true,
          "progressDelta":null,
          "criteriaSatisfied":[]
        } trailing"#,
    )
    .expect("parse review");
    assert_eq!(result.verdict, IndependentReviewVerdict::Revise);
    assert_eq!(result.issues[0].title, "Missing path");
    assert_eq!(result.missing_checks, vec!["cargo check"]);
}

#[test]
fn independent_review_event_exposes_the_active_reviewer_identity() {
    let payload = serde_json::to_value(IndependentReviewEvent {
        session_id: "review-session",
        phase: "reviewing",
        attempt: 1,
        revision: 0,
        max_revisions: 2,
        reviewer_provider: Some("openai".to_string()),
        reviewer_model: Some("gpt-5-reviewer".to_string()),
        result: None,
    })
    .expect("serialize review event");

    assert_eq!(payload["reviewerProvider"], "openai");
    assert_eq!(payload["reviewerModel"], "gpt-5-reviewer");
    assert_eq!(payload["phase"], "reviewing");
}

#[test]
fn persisted_review_memory_keeps_rounds_until_an_explicit_clear() {
    let result = IndependentReviewResult {
        verdict: IndependentReviewVerdict::Revise,
        summary: "Integration coverage is missing".to_string(),
        issues: vec![IndependentReviewIssue {
            severity: "high".to_string(),
            title: "Missing integration test".to_string(),
            detail: "Only unit tests were run".to_string(),
            ..IndependentReviewIssue::default()
        }],
        ..IndependentReviewResult::default()
    };
    let review_event = crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq: 1,
        ts: 1,
        session_id: "review-memory".to_string(),
        kind: "independent_review".to_string(),
        payload: json!({
            "sessionId": "review-memory",
            "phase": "result",
            "attempt": 4,
            "revision": 0,
            "maxRevisions": 2,
            "result": result,
        }),
    };
    let memory = persisted_review_memory_from_events(vec![review_event.clone()]);
    assert_eq!(memory.last_attempt, 4);
    assert_eq!(memory.rounds.len(), 1);
    let prompt = render_executor_review_memory(&memory).expect("review memory prompt");
    assert!(prompt.contains("Missing integration test"));
    assert!(prompt.contains("do not edit files"));

    let mut first_review_complete = review_event.clone();
    first_review_complete.seq = 2;
    first_review_complete.ts = 2;
    first_review_complete.payload["phase"] = json!("complete");

    let legacy_second_review = crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq: 3,
        ts: 3,
        session_id: "review-memory".to_string(),
        kind: "independent_review".to_string(),
        payload: json!({
            "sessionId": "review-memory",
            "phase": "result",
            "attempt": 4,
            "maxRevisions": 2,
            "result": {
                "verdict": "pass",
                "summary": "A later legacy review with a colliding attempt",
            },
        }),
    };
    let legacy_second_complete = crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq: 4,
        ts: 4,
        session_id: "review-memory".to_string(),
        kind: "independent_review".to_string(),
        payload: json!({
            "sessionId": "review-memory",
            "phase": "complete",
            "attempt": 4,
            "maxRevisions": 2,
            "result": {
                "verdict": "pass",
                "summary": "A later legacy review with a colliding attempt",
            },
        }),
    };
    let migrated = persisted_review_memory_from_events(vec![
        review_event.clone(),
        first_review_complete,
        legacy_second_review,
        legacy_second_complete,
    ]);
    assert_eq!(migrated.last_attempt, 5);
    assert_eq!(migrated.rounds.len(), 2);

    let clear_event = crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq: 5,
        ts: 5,
        session_id: "review-memory".to_string(),
        kind: "independent_review".to_string(),
        payload: json!({
            "sessionId": "review-memory",
            "phase": "cleared",
            "attempt": 0,
            "revision": 0,
            "maxRevisions": 2,
        }),
    };
    let cleared = persisted_review_memory_from_events(vec![review_event, clear_event]);
    assert_eq!(cleared.last_attempt, 0);
    assert!(cleared.rounds.is_empty());
    assert!(render_executor_review_memory(&cleared).is_none());
}

#[test]
fn reviewer_feedback_is_an_internal_system_message() {
    let message = revision_prompt(
        &IndependentReviewResult {
            verdict: IndependentReviewVerdict::Revise,
            revision_instructions: vec!["Run cargo check".to_string()],
            ..IndependentReviewResult::default()
        },
        1,
    );
    assert_eq!(message.role, MessageRole::System);
    assert!(matches!(
        message.blocks.first(),
        Some(ContentBlock::Text { text })
            if text.contains("Run cargo check")
                && text.contains("clean, standalone, user-facing replacement answer")
                && text.contains("Never mention the Reviewer")
    ));
}

#[test]
fn irrelevant_goal_only_findings_cannot_force_revision() {
    let mut review = IndependentReviewResult {
        verdict: IndependentReviewVerdict::Revise,
        relevant_to_goal: false,
        issues: vec![IndependentReviewIssue {
            severity: "critical".to_string(),
            title: "Project milestone incomplete".to_string(),
            detail: "Success criterion says the user must ask about model identity".to_string(),
            recommendation: "Add a model identity paragraph".to_string(),
            ..IndependentReviewIssue::default()
        }],
        revision_instructions: vec!["Satisfy the project milestone".to_string()],
        progress_delta: Some("unrelated progress".to_string()),
        criteria_satisfied: vec![0],
        ..IndependentReviewResult::default()
    };

    normalize_review_goal_gating(&mut review);

    assert_eq!(review.verdict, IndependentReviewVerdict::Pass);
    assert!(review.issues.is_empty());
    assert!(review.revision_instructions.is_empty());
    assert!(review.progress_delta.is_none());
    assert!(review.criteria_satisfied.is_empty());
}

#[test]
fn user_request_omission_is_not_mistaken_for_a_goal_behavior_gate() {
    let mut review = IndependentReviewResult {
        verdict: IndependentReviewVerdict::Revise,
        relevant_to_goal: false,
        issues: vec![IndependentReviewIssue {
            severity: "high".to_string(),
            title: "User request not directly addressed".to_string(),
            detail: "The user asked to search for related questions, but the answer did not do so."
                .to_string(),
            recommendation: "Address the requested search directly.".to_string(),
            ..IndependentReviewIssue::default()
        }],
        revision_instructions: vec!["Answer what the user requested.".to_string()],
        ..IndependentReviewResult::default()
    };

    normalize_review_goal_gating(&mut review);

    assert_eq!(review.verdict, IndependentReviewVerdict::Revise);
    assert_eq!(review.issues.len(), 1);
    assert_eq!(review.revision_instructions.len(), 1);
}

#[test]
fn advisory_review_findings_do_not_force_an_automatic_revision() {
    let mut review = IndependentReviewResult {
        verdict: IndependentReviewVerdict::Revise,
        relevant_to_goal: true,
        issues: vec![
            IndependentReviewIssue {
                severity: "low".to_string(),
                title: "Optional wording improvement".to_string(),
                ..IndependentReviewIssue::default()
            },
            IndependentReviewIssue {
                severity: "medium".to_string(),
                title: "Optional additional example".to_string(),
                ..IndependentReviewIssue::default()
            },
        ],
        ..IndependentReviewResult::default()
    };

    normalize_review_goal_gating(&mut review);

    assert_eq!(review.verdict, IndependentReviewVerdict::Pass);
    assert_eq!(review.issues.len(), 2, "advisory issues remain visible");

    review.verdict = IndependentReviewVerdict::Revise;
    review.missing_checks = vec!["Run the integration test".to_string()];
    normalize_review_goal_gating(&mut review);
    assert_eq!(review.verdict, IndependentReviewVerdict::Revise);
}

#[test]
fn todo_snapshot_becomes_unverified_goal_progress_without_claiming_criteria() {
    let summary = runtime::TurnSummary {
        assistant_messages: Vec::new(),
        tool_results: vec![ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "todo-1".to_string(),
                tool_name: "TodoWrite".to_string(),
                output: serde_json::json!({
                    "newTodos": [
                        {"content": "Inspect state", "status": "completed"},
                        {"content": "Repair persistence", "status": "in_progress"},
                        {"content": "Update prompt", "status": "in_progress"},
                        {"content": "Add regression tests", "status": "in_progress"},
                        {"content": "Run focused tests", "status": "in_progress"},
                        {"content": "Run workspace tests", "status": "in_progress"},
                        {"content": "Run tests", "status": "pending"}
                    ]
                })
                .to_string(),
                is_error: false,
            }],
            usage: None,
        }],
        iterations: 1,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    let progress = task_progress_from_turn(&summary).expect("task progress");
    assert!(progress.contains("1/7 completed"));
    assert!(progress.contains("Repair persistence"));
    assert!(progress.contains("not independently verified"));
    assert!(progress.contains("+2 more active items"));
    assert!(!progress.contains("milestone criteria are unchanged"));
}

#[test]
fn review_prompt_preserves_prior_evidence_and_downgrades_irrelevant_goals() {
    let root = std::env::temp_dir().join(format!(
        "somniq-review-prompt-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&root).expect("temp workspace");
    runtime::start_project_goal(
        &root,
        runtime::ProjectGoalDraft {
            objective: "Finish onboarding".to_string(),
            success_criteria: vec![
                "用户提出模型身份问题".to_string(),
                "Produce a verified artifact".to_string(),
            ],
            recent_status: String::new(),
        },
        None,
    )
    .expect("start project goal");
    let prior = IndependentReviewResult {
        verdict: IndependentReviewVerdict::Revise,
        summary: "Run the integration test".to_string(),
        evidence_checked: vec!["unit test passed".to_string()],
        ..IndependentReviewResult::default()
    };
    let prompt = independent_review_prompt(
        "Fix the integration",
        "Implemented and tested",
        "Tool evidence round 1: unit test passed\nTool evidence round 2: integration passed",
        "File evidence round 1: src/lib.rs",
        &[prior],
        2,
        &root,
        "minimax",
        "MiniMax-M3",
    );

    assert!(prompt.contains("If relevantToGoal=false"));
    assert!(prompt.contains("perform an incremental re-review"));
    assert!(prompt.contains("unit test passed"));
    assert!(prompt.contains("integration passed"));
    assert!(prompt.contains("Run the integration test"));
    assert!(prompt.contains("[truncated]"));
    assert!(prompt.contains("REFERENCE-ONLY user/external behavior"));
    assert!(prompt.contains("This workspace is not a Git worktree"));
    assert!(prompt.contains("Do not penalize the Executor for missing git status/diff output"));
    assert!(!prompt.contains("Unstaged diff:"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn review_materializes_recent_ignored_literature_evidence() {
    let root = std::env::temp_dir().join(format!(
        "somniq-review-evidence-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let lit = root.join(".somniq").join("lit");
    fs::create_dir_all(&lit).expect("create lit directory");
    fs::write(
        lit.join("results.json"),
        "{\"papers\":6,\"deduplicated\":true}\napi_key=must-not-leak",
    )
    .expect("write evidence");

    let evidence =
        review_materialized_evidence(&review_test_summary(Some("LiteratureSearch")), &root);

    assert!(evidence.contains("results.json"));
    assert!(evidence.contains("deduplicated"));
    assert!(evidence.contains("[redacted sensitive evidence line]"));
    assert!(!evidence.contains("must-not-leak"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn review_session_collapse_keeps_tools_and_only_the_clean_final_answer() {
    let user = ConversationMessage::user_text("Fix the bug");
    let mut session = Session::new();
    session.messages.push(user.clone());
    session.messages.push(ConversationMessage::assistant(vec![
        ContentBlock::Text {
            text: "Rejected draft".to_string(),
        },
        ContentBlock::ToolUse {
            id: "tool-1".to_string(),
            name: "edit_file".to_string(),
            input: r#"{"path":"src/lib.rs"}"#.to_string(),
        },
    ]));
    session.messages.push(ConversationMessage::tool_result(
        "tool-1",
        "edit_file",
        "ok",
        false,
    ));
    session
        .messages
        .push(revision_prompt(&IndependentReviewResult::default(), 1));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "# Replacement answer for Reviewer".to_string(),
        }]));

    collapse_independent_review_session(&mut session, &user, "Fixed and tested.", None);

    assert!(session
        .messages
        .iter()
        .all(|message| message.role != MessageRole::System));
    assert!(session.messages.iter().any(|message| {
        message
            .blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { name, .. } if name == "edit_file"))
    }));
    let visible_text = session
        .messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(visible_text, vec!["Fix the bug", "Fixed and tested."]);
}

#[test]
fn paired_remote_runtime_uses_desktop_execution_with_a_safe_mobile_mirror() {
    let remote = ChatTurnRuntime::RemoteApproved;
    let (blocked_tools, full_tool_registry) = remote.tool_profile();

    assert!(full_tool_registry);
    assert_eq!(blocked_tools, DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
    assert_eq!(remote.event_delivery(), ChatEventDelivery::DesktopAndRemote);
    assert!(remote.emits_desktop_chat_events());
    assert_eq!(remote.surface(), "Paired mobile");
    assert!(ChatTurnRuntime::Desktop {
        extra_blocked_tools: &[],
        full_tool_registry: true,
    }
    .emits_desktop_chat_events());
}

#[test]
fn remote_chat_target_requires_a_project_and_valid_session_id() {
    assert_eq!(
        validate_remote_chat_target("", "desktop-chat"),
        Err("remote chat requires a project id".to_string())
    );
    assert!(validate_remote_chat_target("default", "../outside-session")
        .expect_err("remote target must reject traversal in session id")
        .contains("invalid chat session id"));
}

#[test]
fn paired_remote_chat_reads_the_selected_project_runtime_session() {
    // Reads the runtime root through `execution_env_var_os`, which falls back to
    // the process-global environment, so it has to take the same lock the
    // environment-mutating fixtures hold.
    let _env_guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let session_id = format!("remote-project-session-{}", std::process::id());
    let root = std::env::temp_dir().join(format!(
        "somniq-remote-project-session-{}",
        remote_protocol::DeviceId::new()
    ));
    let project_id = "project-0123456789abcdef";
    std::fs::create_dir_all(&root).expect("create project workspace");
    let loaded = with_bound_project_environment(&root, project_id, || {
        let sessions_dir = runtime::project_sessions_dir_from_env();
        std::fs::create_dir_all(&sessions_dir).expect("create project session directory");
        let path = sessions_dir.join(format!("{session_id}.json"));
        let mut session = Session::new();
        session
            .messages
            .push(ConversationMessage::user_text("project scoped"));
        session.save_to_path(&path).expect("write project session");
        let loaded = get_project_scoped_chat_session(project_id, &session_id);
        let _ = std::fs::remove_file(path);
        loaded
    })
    .expect("bind default project environment")
    .expect("paired chat reads the project-scoped session");
    assert_eq!(loaded.messages.len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn debug_export_paths_are_markdown_safe_and_linkable() {
    let path = Path::new(r"C:\Users\wt\.config\SomniQ\desktop-runtime");

    assert_eq!(
        markdown_inline_code(&path.display().to_string()),
        r"`C:\Users\wt\.config\SomniQ\desktop-runtime`"
    );
    assert_eq!(
        markdown_local_link("Open export folder", path),
        "[Open export folder](C%3A/Users/wt/.config/SomniQ/desktop-runtime)"
    );
}

#[test]
fn extracts_structured_project_intent_json() {
    let raw = "```json\n{\"hasLongTermIntent\":true,\"objective\":\"Ship durable continuity\",\"confidence\":91,\"supportingEvidenceIds\":[\"m1\",\"m2\"]}\n```";
    let json = extract_json_object(raw).expect("json object");
    let generated: GeneratedProjectIntent = serde_json::from_str(json).expect("intent json");
    assert!(generated.has_long_term_intent);
    assert_eq!(generated.objective, "Ship durable continuity");
    assert_eq!(generated.confidence, 91);
    assert_eq!(generated.supporting_evidence_ids, vec!["m1", "m2"]);
}

#[test]
fn extracts_structured_project_activity_json() {
    let raw = "```json\n{\"coreFocus\":\"Build conversation-aware summaries\",\"relatedWork\":[\"Add periodic refresh\",\"Verify coverage\"],\"confidence\":89}\n```";
    let json = extract_json_object(raw).expect("json object");
    let generated: GeneratedProjectActivity =
        serde_json::from_str(json).expect("project activity json");

    assert_eq!(generated.core_focus, "Build conversation-aware summaries");
    assert_eq!(generated.related_work.len(), 2);
    assert_eq!(generated.confidence, 89);
}

fn activity_with_focus(core_focus: &str) -> runtime::ProjectActivity {
    runtime::ProjectActivity {
        core_focus: core_focus.to_string(),
        related_work: Vec::new(),
        conversation_count: 1,
        message_count: 2,
        question_count: 1,
        session_cursors: Default::default(),
        context_checkpoints: Default::default(),
        reviewer: "reviewer".to_string(),
        source_fingerprint: "fingerprint".to_string(),
        reviewed_at: "2026-08-02T00:00:00Z".to_string(),
        drift: None,
    }
}

fn generated_activity(core_focus: &str, main_line_changed: bool) -> GeneratedProjectActivity {
    GeneratedProjectActivity {
        core_focus: core_focus.to_string(),
        related_work: Vec::new(),
        confidence: 90,
        main_line_changed,
        drift: Some(GeneratedProjectActivityDrift {
            detected: true,
            evidence: "most of the delta went into one parsing bug".to_string(),
            suggestion: "park the parsing bug and resume the team work".to_string(),
        }),
    }
}

/// A review that spent the whole delta on a detour must not be able to promote
/// the detour to the project's main line. Reporting the deviation and silently
/// adopting it are opposite outcomes, and only the prompt asks for the first.
#[test]
fn a_review_cannot_rewrite_the_main_line_without_claiming_it_changed() {
    let existing = activity_with_focus("Ship multi-role team collaboration");

    let mut absorbed = generated_activity("Fix MiniMax tool-call parsing", false);
    hold_main_line_unless_it_really_changed(&mut absorbed, Some(&existing));
    assert_eq!(absorbed.core_focus, "Ship multi-role team collaboration");
    assert!(absorbed.drift.is_some_and(|drift| drift.detected));

    // An explicit, committed claim that the main line moved is still honoured —
    // and then the deviation report is dropped, because the two claims cannot
    // both be true.
    let mut redirected = generated_activity("Ship the OpenAI runtime client", true);
    hold_main_line_unless_it_really_changed(&mut redirected, Some(&existing));
    assert_eq!(redirected.core_focus, "Ship the OpenAI runtime client");
    assert!(redirected.drift.is_none());

    // The first review of a project has no baseline to deviate from.
    let mut first = generated_activity("Ship multi-role team collaboration", false);
    hold_main_line_unless_it_really_changed(&mut first, None);
    assert_eq!(first.core_focus, "Ship multi-role team collaboration");
    assert!(first.drift.is_none());
}

#[test]
fn project_activity_review_uses_the_existing_compaction_token_threshold() {
    let trigger = |context_tokens, compacted| ProjectActivityReviewTrigger {
        session_id: "chat-a".to_string(),
        context_tokens,
        compaction_budget: 100_000,
        compacted,
    };
    assert!(!project_activity_review_due(&trigger(84_999, false), None));
    assert!(project_activity_review_due(&trigger(85_000, false), None));
    assert!(project_activity_review_due(&trigger(20_000, true), None));

    let mut activity = activity_with_focus("Existing focus");
    activity.context_checkpoints.insert(
        "chat-a".to_string(),
        runtime::ProjectActivityContextCheckpoint {
            context_tokens: 90_000,
            compaction_budget: 100_000,
        },
    );
    assert!(!project_activity_review_due(
        &trigger(95_000, false),
        Some(&activity),
    ));
    activity.context_checkpoints.insert(
        "chat-a".to_string(),
        runtime::ProjectActivityContextCheckpoint {
            context_tokens: 50_000,
            compaction_budget: 100_000,
        },
    );
    assert!(project_activity_review_due(
        &trigger(85_000, false),
        Some(&activity),
    ));
}

#[test]
fn project_activity_review_chunking_preserves_unicode_input() {
    let input = "项目对话🙂".repeat(20);
    let chunks = split_project_activity_review_text(&input, 17);

    assert!(chunks.len() > 1);
    assert_eq!(chunks.concat(), input);
    assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 17));
}

#[test]
fn project_activity_review_units_are_packed_under_the_model_budget() {
    let groups = pack_project_activity_review_units(
        vec!["a".repeat(20), "b".repeat(20), "c".repeat(20)],
        60,
    );

    assert!(groups.len() > 1);
    assert!(groups.iter().all(|group| group.chars().count() <= 60));
    assert!(groups.join("").contains(&"a".repeat(20)));
    assert!(groups.join("").contains(&"c".repeat(20)));
}

#[test]
fn rich_chat_request_maps_data_url_to_image_block() {
    let message = user_message_from_request(ChatSendRequest {
        text: "look".to_string(),
        images: vec![ChatImageInput {
            name: Some("shot.png".to_string()),
            mime_type: "image/png".to_string(),
            data: "data:image/png;base64,ZmFrZQ==".to_string(),
        }],
        model: None,
        project_id: None,
        ephemeral: false,
        previous_turn_cancelled: false,
    })
    .expect("rich request should parse");

    assert!(matches!(
        &message.blocks[0],
        ContentBlock::Text { text } if text == "look"
    ));
    assert!(matches!(
        &message.blocks[1],
        ContentBlock::Image { media_type, data }
            if media_type == "image/png" && data == "ZmFrZQ=="
    ));
}

#[test]
fn rich_chat_request_rejects_non_image_media_type() {
    let error = user_message_from_request(ChatSendRequest {
        text: String::new(),
        images: vec![ChatImageInput {
            name: Some("note.txt".to_string()),
            mime_type: "text/plain".to_string(),
            data: "ZmFrZQ==".to_string(),
        }],
        model: None,
        project_id: None,
        ephemeral: false,
        previous_turn_cancelled: false,
    })
    .expect_err("non-image upload should be rejected");

    assert!(error.contains("unsupported media type"));
}

#[test]
fn chat_context_rebuild_preserves_structured_tool_exchange() {
    let session = chat_context_messages_to_session(vec![
        ChatContextMessage {
            role: "user".to_string(),
            text: "Read README".to_string(),
            images: Vec::new(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
        },
        ChatContextMessage {
            role: "assistant".to_string(),
            text: "I checked the file.".to_string(),
            images: Vec::new(),
            tool_calls: vec![ChatContextToolCall {
                id: "tool-1".to_string(),
                name: "read_file".to_string(),
                input: r#"{"path":"README.md"}"#.to_string(),
            }],
            tool_results: Vec::new(),
        },
        ChatContextMessage {
            role: "tool".to_string(),
            text: String::new(),
            images: Vec::new(),
            tool_calls: Vec::new(),
            tool_results: vec![ChatContextToolResult {
                tool_use_id: "tool-1".to_string(),
                tool_name: "read_file".to_string(),
                output: "README body".to_string(),
                is_error: false,
            }],
        },
    ])
    .expect("structured context should rebuild");

    assert_eq!(session.messages.len(), 3);
    assert!(matches!(
        &session.messages[1].blocks[..],
        [
            ContentBlock::Text { text },
            ContentBlock::ToolUse { id, name, input }
        ] if text == "I checked the file."
            && id == "tool-1"
            && name == "read_file"
            && input == r#"{"path":"README.md"}"#
    ));
    assert!(matches!(
        &session.messages[2],
        ConversationMessage {
            role: MessageRole::Tool,
            blocks,
            usage: None,
        } if matches!(
            &blocks[..],
            [ContentBlock::ToolResult { tool_use_id, tool_name, output, is_error }]
                if tool_use_id == "tool-1"
                    && tool_name == "read_file"
                    && output == "README body"
                    && !is_error
        )
    ));
}

#[test]
fn rewind_to_unique_user_keeps_authoritative_prefix_and_compaction_data() {
    let target = ConversationMessage::user_text("retry this request");
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("older context"));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "full backend-only tool-derived detail".repeat(2_000),
        }]));
    session.messages.push(target.clone());
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "failed answer".to_string(),
        }]));

    assert!(rewind_session_before_unique_user(&mut session, &target));
    assert_eq!(session.messages.len(), 2);
    assert!(matches!(
        &session.messages[1].blocks[0],
        ContentBlock::Text { text } if text.len() > 64_000
    ));
}

#[test]
fn rewind_rejects_ambiguous_user_messages_without_mutating_session() {
    let repeated = ConversationMessage::user_text("same request");
    let mut session = Session::new();
    session.messages.push(repeated.clone());
    session
        .messages
        .push(ConversationMessage::assistant(vec![]));
    session.messages.push(repeated.clone());
    let before = session.clone();

    assert!(!rewind_session_before_unique_user(&mut session, &repeated));
    assert_eq!(session, before);
}

#[test]
fn skill_prompt_routes_named_skill_to_skill_tool() {
    let prompt = skill_prompt("research-lit", "reservoir computing");

    assert!(prompt.contains("Use the Skill tool"));
    assert!(prompt.contains("\"research-lit\""));
    assert!(prompt.contains("reservoir computing"));
}

#[test]
fn skills_command_lists_bundled_skills() {
    let result = handle_skills_command(Some("list"), None).expect("skills list");

    assert!(result.handled);
    let message = result.message.expect("message");
    assert!(message.contains("Available skills"));
    assert!(message.contains("/research-lit"));
}

#[test]
fn skills_command_shows_bundled_skill_markdown() {
    let result = handle_skills_command(Some("show"), Some("research-lit")).expect("skills show");

    assert!(result.handled);
    let message = result.message.expect("message");
    assert!(message.contains("/research-lit"));
    // `research-lit` is a retired alias that resolves to the canonical
    // `literature-search` skill, so `show` now surfaces that body plus a
    // compatibility-profile note instead of the old review workflow.
    assert!(message.contains("# Literature Search"));
    assert!(message.contains("Activated compatibility profile"));
}

#[test]
fn generated_chat_title_is_cleaned_for_sidebar() {
    let title = clean_generated_title("标题：\"贝叶斯估计写作计划。\"\n\nextra");

    assert_eq!(title, "贝叶斯估计写作计划");
}

#[test]
fn generated_chat_title_skips_reasoning_markup() {
    let title = clean_generated_title(
        "<think>\nThe user asked me to choose a title.\n</think>\nTitle: chemistry slides",
    );

    assert_eq!(title, "chemistry slides");
    assert_eq!(
        clean_generated_title("<think>The user asked me to choose"),
        ""
    );
    assert_eq!(clean_generated_title("The user asked for help"), "");
    assert_eq!(clean_generated_title("Untitled"), "");
    assert_eq!(clean_generated_title("状态：未确认"), "");
    assert_eq!(clean_generated_title("Status: unconfirmed"), "");
    assert_eq!(clean_generated_title("无主题"), "");
}

#[test]
fn chat_title_prompt_carries_attachments_follow_ups_and_answer() {
    let request = ChatTitleRequest {
        user: "总结一下".to_string(),
        assistant: "这篇论文提出了 LAFR 时序结构模块。".to_string(),
        attachments: vec!["papers/lafr-tnn.pdf".to_string()],
        follow_ups: vec!["再看看实验部分".to_string()],
    };

    let prompt = chat_title_prompt(&request, false);

    assert!(prompt.contains("总结一下"));
    assert!(prompt.contains("papers/lafr-tnn.pdf"));
    assert!(prompt.contains("再看看实验部分"));
    assert!(prompt.contains("LAFR"));
    assert!(prompt.ends_with("Title:"));
    // The retry nudge only appears on the second attempt.
    assert!(!prompt.contains("previous attempt"));
    assert!(chat_title_prompt(&request, true).contains("previous attempt"));
}

#[test]
fn chat_title_prompt_omits_absent_evidence() {
    let prompt = chat_title_prompt(
        &ChatTitleRequest {
            user: "修复排版页面的滚动条".to_string(),
            ..ChatTitleRequest::default()
        },
        false,
    );

    assert!(!prompt.contains("Attachments"));
    assert!(!prompt.contains("Later user questions"));
    assert!(!prompt.contains("Assistant excerpt"));
}

#[test]
fn long_title_requests_keep_the_trailing_ask() {
    // A pasted log followed by the real request must not lose the request.
    let user = format!("{}\n最后：帮我修一下编译错误", "错误日志行\n".repeat(400));

    let prompt = chat_title_prompt(
        &ChatTitleRequest {
            user,
            ..ChatTitleRequest::default()
        },
        false,
    );

    assert!(prompt.contains("帮我修一下编译错误"));
    assert!(prompt.contains("[truncated]"));
}

#[test]
fn generated_chat_title_rejects_a_copy_of_the_request() {
    let user = "你检查一下，我标注的两个地方无法拖动的原因是什么，在APP中";

    assert!(is_echoed_title(
        "你检查一下，我标注的两个地方无法拖动",
        user
    ));
    assert!(is_echoed_title("你检查一下我标注的两个地方无法拖动", user));
    assert!(!is_echoed_title("标注区域拖拽失效", user));
    // Short titles that happen to open the request are still legitimate labels.
    assert!(!is_echoed_title("邮箱配置", "邮箱配置怎么改"));
}

/// Prompt quality can only be judged against a real model. These are the
/// openers that produced unusable sidebar titles in practice.
#[test]
#[ignore = "requires ARIS_LIVE_LLM_TEST=1 and a configured executor"]
fn live_chat_titles_are_labels_rather_than_request_slices() {
    if std::env::var("ARIS_LIVE_LLM_TEST").as_deref() != Ok("1") {
        return;
    }
    let cases = [
        ChatTitleRequest {
            user: "你检查一下，我标注的两个地方无法拖动的原因是什么，在APP中".to_string(),
            ..ChatTitleRequest::default()
        },
        ChatTitleRequest {
            user: "针对这篇论文，你使用scopus search查询论文，然后根据创新点给出一个投稿建议的PDF指南（Latex构建），我初步估计一个二区为主的期刊。".to_string(),
            ..ChatTitleRequest::default()
        },
        ChatTitleRequest {
            user: "1. 优化全局APP 字体统一， 2. 排版的首页不需要边栏， 3. 实验室可以对文件进行操作，".to_string(),
            ..ChatTitleRequest::default()
        },
        ChatTitleRequest {
            user: "邮箱".to_string(),
            assistant: "要接 Gmail 还是 Outlook？两边都需要 OAuth 客户端 ID。".to_string(),
            ..ChatTitleRequest::default()
        },
        ChatTitleRequest {
            user: "总结一下".to_string(),
            attachments: vec!["papers/lafr-tnn.pdf".to_string()],
            ..ChatTitleRequest::default()
        },
    ];

    for request in cases {
        let title = suggest_chat_title(&request).expect("live title");
        println!("{} => {title}", request.user);
        assert!(!title.is_empty());
        assert!(!is_echoed_title(&title, &request.user), "echoed: {title}");
        assert!(title.chars().count() <= 32, "too long: {title}");
    }
}

#[test]
fn desktop_chat_lets_permission_mode_gate_bash() {
    let specs = tool_specs_for(DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
    assert!(specs.iter().any(|spec| spec.name == "bash"));
    assert!(specs.iter().any(|spec| spec.name == "Agent"));

    let workspace = desktop_permission_policy(&specs, PermissionMode::WorkspaceWrite);
    assert!(matches!(
        workspace.authorize("bash", r#"{"command":"echo hi"}"#, None),
        runtime::PermissionOutcome::Deny { .. }
    ));

    let unrestricted = desktop_permission_policy(&specs, PermissionMode::DangerFullAccess);
    assert_eq!(
        unrestricted.authorize("bash", r#"{"command":"echo hi"}"#, None),
        runtime::PermissionOutcome::Allow
    );
}

#[test]
fn desktop_chat_registers_ask_user_question_gated_read_only() {
    let specs = tool_specs_for(DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
    let spec = specs
        .iter()
        .find(|spec| spec.name == ASK_USER_QUESTION_TOOL)
        .expect("AskUserQuestion is registered for desktop chat");
    assert!(matches!(spec.required_permission, PermissionMode::ReadOnly));

    // Even read-only ("Plan") mode must let the model ask the user a
    // question without surfacing a permission prompt for it.
    let plan = desktop_permission_policy(&specs, PermissionMode::ReadOnly);
    assert_eq!(
        plan.authorize(
            ASK_USER_QUESTION_TOOL,
            r#"{"question":"Pick one","options":[{"label":"A"}]}"#,
            None,
        ),
        runtime::PermissionOutcome::Allow
    );
}

#[test]
fn desktop_chat_registers_local_project_evidence_search_as_read_only() {
    let specs = tool_specs_for(DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
    let spec = specs
        .iter()
        .find(|spec| spec.name == PROJECT_EVIDENCE_SEARCH_TOOL)
        .expect("ProjectEvidenceSearch is registered for desktop chat");
    assert!(matches!(spec.required_permission, PermissionMode::ReadOnly));
    assert!(spec.description.contains("Call this automatically"));
    assert!(spec.description.contains("never indexes PDFs"));

    let plan = desktop_permission_policy(&specs, PermissionMode::ReadOnly);
    assert_eq!(
        plan.authorize(
            PROJECT_EVIDENCE_SEARCH_TOOL,
            r#"{"query":"What limitations do the local papers report?"}"#,
            None,
        ),
        runtime::PermissionOutcome::Allow
    );
}

#[test]
fn ask_user_question_rejects_inputs_the_ui_cannot_answer() {
    assert!(
        validate_question_input(r#"{"question":"Pick one","options":[{"label":"A"}]}"#).is_ok()
    );

    assert!(validate_question_input(r#"{"question":"Pick one"}"#)
        .expect_err("missing options should fail")
        .to_string()
        .contains("options"));
    assert!(
        validate_question_input(r#"{"question":"Pick one","options":[{"label":"  "}]}"#)
            .expect_err("blank labels should fail")
            .to_string()
            .contains("label")
    );
    assert!(validate_question_input(r#"{"options":[{"label":"A"}]}"#)
        .expect_err("missing question should fail")
        .to_string()
        .contains("question"));
}

#[test]
fn a_paired_device_can_only_answer_a_question_from_the_session_it_is_viewing() {
    let state = ChatState::default();
    let (sender, receiver) = mpsc::channel::<String>();
    state.question_prompts.lock().expect("registry").insert(
        "toolu-1".to_string(),
        QuestionPromptHandle {
            session_id: "chat-a".to_string(),
            sender,
        },
    );

    // A phone viewing another conversation must not resolve this call, and
    // must not consume the prompt the right conversation is still waiting on.
    let wrong_session =
        respond_to_chat_question(&state, "toolu-1", "Staging".to_string(), Some("chat-b"))
            .expect("a mismatched session is a stale answer, not a failure");
    assert!(!wrong_session);
    assert!(state
        .question_prompts
        .lock()
        .expect("registry")
        .contains_key("toolu-1"));

    let delivered =
        respond_to_chat_question(&state, "toolu-1", "Staging".to_string(), Some("chat-a"))
            .expect("the viewing session should be able to answer");
    assert!(delivered);
    assert_eq!(
        receiver.try_recv().expect("blocked tool receives"),
        "Staging"
    );

    // An answer that arrives after the prompt is gone is reported as stale
    // rather than an error, so the phone can re-read the turn's real state.
    let already_answered =
        respond_to_chat_question(&state, "toolu-1", "Production".to_string(), Some("chat-a"))
            .expect("a resolved prompt is not a failure");
    assert!(!already_answered);
}

#[test]
fn the_desktop_answers_a_question_without_naming_a_session() {
    let state = ChatState::default();
    let (sender, receiver) = mpsc::channel::<String>();
    state.question_prompts.lock().expect("registry").insert(
        "toolu-2".to_string(),
        QuestionPromptHandle {
            session_id: "chat-a".to_string(),
            sender,
        },
    );

    let delivered = respond_to_chat_question(&state, "toolu-2", "A".to_string(), None)
        .expect("the desktop UI answers its own prompt");

    assert!(delivered);
    assert_eq!(receiver.try_recv().expect("blocked tool receives"), "A");
    assert!(
        !respond_to_chat_question(&state, "toolu-missing", "A".to_string(), None)
            .expect("an unknown prompt is stale, not a failure")
    );
}

#[test]
fn latex_repair_guard_stops_repeated_failures_for_the_same_source_only() {
    let input = r#"{"inputPath":"papers/report.tex"}"#;
    let mut guard = LatexRepairGuard::default();

    for attempt in 0..MAX_CONSECUTIVE_LATEX_REPAIR_FAILURES {
        assert!(guard.blocks("LaTeXCompile", input).is_none());
        let notice = guard.record("LaTeXCompile", input, true);
        assert_eq!(
            notice.is_some(),
            attempt + 1 == MAX_CONSECUTIVE_LATEX_REPAIR_FAILURES
        );
    }
    assert!(guard.blocks("LaTeXCompile", input).is_some());
    assert!(guard
        .blocks("LaTeXCompile", r#"{"inputPath":"papers/other.tex"}"#)
        .is_none());

    let success = guard.record("LaTeXCompile", r#"{"inputPath":"papers/other.tex"}"#, false);
    assert!(success.is_none());
    assert!(guard.blocks("LaTeXCompile", input).is_none());
}

#[test]
fn desktop_permission_aliases_match_claude_code_settings() {
    assert_eq!(
        normalize_permission_mode("plan"),
        Some(PermissionMode::ReadOnly)
    );
    assert_eq!(
        normalize_permission_mode("acceptEdits"),
        Some(PermissionMode::WorkspaceWrite)
    );
    assert_eq!(
        normalize_permission_mode("dontAsk"),
        Some(PermissionMode::DangerFullAccess)
    );
    assert_eq!(
        normalize_permission_mode("ask"),
        Some(PermissionMode::Prompt)
    );
    assert_eq!(
        normalize_permission_mode("prompt"),
        Some(PermissionMode::Prompt)
    );
}

#[test]
fn desktop_permission_defaults_to_dont_ask_without_config() {
    let dir = std::env::temp_dir().join(format!(
        "somniq-permission-default-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("temp dir");

    assert_eq!(
        configured_default_permission_mode_for(&dir),
        PermissionMode::DangerFullAccess
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn project_switch_accepts_a_cancelled_turn_before_its_guard_drops() {
    let state = ChatState::default();
    let cancelled = Arc::new(AtomicBool::new(true));
    state.running_turns.lock().expect("chat state").insert(
        "chat-switch".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled,
            blocks_project_switch: true,
        },
    );

    let transitioned = with_project_switch_guard(&state, || Ok("project switched"))
        .expect("a cancelled turn should not keep project switching blocked");

    assert_eq!(transitioned, "project switched");
    assert!(state
        .running_turns
        .lock()
        .expect("chat state")
        .contains_key("chat-switch"));
}

#[test]
fn project_switch_rejects_a_turn_that_has_not_been_cancelled() {
    let state = ChatState::default();
    state.running_turns.lock().expect("chat state").insert(
        "chat-switch".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled: Arc::new(AtomicBool::new(false)),
            blocks_project_switch: true,
        },
    );

    let error = with_project_switch_guard(&state, || Ok(()))
        .expect_err("an active turn must keep its project environment");

    assert_eq!(
        error,
        "stop or finish the active chat turn before switching projects"
    );
}

#[tokio::test]
async fn project_switch_cancels_foreground_turns_before_guarding_environment() {
    // `begin_project_switch` cancels the turn, and `cancel_chat_turn` records a
    // durable `cancel_requested` event. Without a bound directory that lands in
    // the developer's real runtime sessions folder.
    let dir = std::env::temp_dir().join(format!(
        "somniq-project-switch-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp event directory");
    let _event_dir = crate::chat_events::bind_session_event_dir("chat-switch", dir.clone())
        .expect("bind event directory");

    let state = Arc::new(ChatState::default());
    let cancelled = Arc::new(AtomicBool::new(false));
    state.running_turns.lock().expect("chat state").insert(
        "chat-switch".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled: cancelled.clone(),
            blocks_project_switch: true,
        },
    );

    // Simulate the worker observing cancellation and dropping its busy guard.
    let worker_state = Arc::clone(&state);
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = tokio::spawn(async move {
        while !worker_cancelled.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        worker_state
            .running_turns
            .lock()
            .expect("chat state")
            .remove("chat-switch");
    });

    let _permit = begin_project_switch(&state)
        .await
        .expect("foreground turns should be cancelled and drained");
    worker.await.expect("worker should exit");
    assert!(state.running_turns.lock().expect("chat state").is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn project_switch_accepts_an_active_background_workflow_turn() {
    let state = ChatState::default();
    state.running_turns.lock().expect("chat state").insert(
        "wf-run-1".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled: Arc::new(AtomicBool::new(false)),
            blocks_project_switch: false,
        },
    );

    let transitioned = with_project_switch_guard(&state, || Ok("project switched"))
        .expect("a bound background workflow must not block project switching");

    assert_eq!(transitioned, "project switched");
    assert!(state
        .running_turns
        .lock()
        .expect("chat state")
        .contains_key("wf-run-1"));
}

#[test]
fn project_switch_accepts_an_active_project_bound_foreground_turn() {
    let state = ChatState::default();
    state.running_turns.lock().expect("chat state").insert(
        "chat-project-bound".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled: Arc::new(AtomicBool::new(false)),
            blocks_project_switch: false,
        },
    );

    let transitioned = with_project_switch_guard(&state, || Ok("project switched"))
        .expect("a project-bound foreground chat must survive a project switch");

    assert_eq!(transitioned, "project switched");
    assert!(state
        .running_turns
        .lock()
        .expect("chat state")
        .contains_key("chat-project-bound"));
}

#[test]
fn project_switch_does_not_wait_for_a_project_bound_tool_action() {
    let state = ChatState::default();
    let workspace = std::env::temp_dir().join(format!(
        "somniq-concurrent-project-tool-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&workspace).expect("project workspace");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker_workspace = workspace.clone();
    let worker = std::thread::spawn(move || {
        with_bound_project_environment(&worker_workspace, "project-0123456789abcdef", || {
            started_tx.send(()).expect("signal tool start");
            release_rx.recv().expect("release tool action");
        })
        .expect("project-bound tool context");
    });

    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("tool action should start");
    let started = Instant::now();
    let switched = with_project_switch_guard(&state, || Ok("project switched"))
        .expect("a bound tool must not hold the process-wide project lock");
    assert_eq!(switched, "project switched");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "project switching should not wait for the other project's long tool"
    );

    release_tx.send(()).expect("release tool");
    worker.join().expect("tool worker");
    let _ = std::fs::remove_dir_all(workspace);
}

#[test]
fn cancelled_turn_can_be_replaced_before_its_old_guard_drops() {
    let state = ChatState::default();
    let old_cancelled = Arc::new(AtomicBool::new(true));
    state.running_turns.lock().expect("chat state").insert(
        "chat-retry".to_string(),
        RunningTurn {
            turn_id: 1,
            cancelled: old_cancelled,
            blocks_project_switch: true,
        },
    );
    let old_guard = ChatBusyGuard {
        running_turns: &state.running_turns,
        session_id: "chat-retry".to_string(),
        turn_id: 1,
    };

    release_cancelled_turn_for_replacement(&state, "chat-retry")
        .expect("cancelled turn should release its slot");
    state.running_turns.lock().expect("chat state").insert(
        "chat-retry".to_string(),
        RunningTurn {
            turn_id: 2,
            cancelled: Arc::new(AtomicBool::new(false)),
            blocks_project_switch: true,
        },
    );
    drop(old_guard);

    assert_eq!(
        state
            .running_turns
            .lock()
            .expect("chat state")
            .get("chat-retry")
            .map(|turn| turn.turn_id),
        Some(2)
    );
}

#[test]
fn a_cancelled_turn_keeps_its_failure_out_of_the_renderer() {
    // `chat-error` carries no turn id, and the next message may already own the
    // session slot by the time a cancelled worker unwinds. Surfacing then fails
    // a live turn whose model is still streaming.
    let cancelled = AtomicBool::new(true);
    assert!(!chat_error_reaches_desktop(true, &cancelled));

    // An uncancelled desktop turn still reports its failure.
    let running = AtomicBool::new(false);
    assert!(chat_error_reaches_desktop(true, &running));

    // A turn that never renders desktop events (paired device, workflow) is
    // unaffected either way; the durable event log records it regardless.
    assert!(!chat_error_reaches_desktop(false, &running));
    assert!(!chat_error_reaches_desktop(false, &cancelled));
}

#[test]
fn oversized_write_file_input_is_compacted_for_ui() {
    let input = serde_json::json!({
        "path": "slides/chapter3.tex",
        "content": "x".repeat(MAX_UI_TOOL_INPUT_CHARS + 1000)
    })
    .to_string();

    let compacted = tool_input_for_ui("write_file", &input);
    let value: serde_json::Value = serde_json::from_str(&compacted).expect("json");

    assert_eq!(value["path"], "slides/chapter3.tex");
    assert!(value["content"]
        .as_str()
        .expect("content placeholder")
        .contains("omitted write_file.content"));
    assert_eq!(
        value["contentChars"],
        serde_json::json!(MAX_UI_TOOL_INPUT_CHARS + 1000)
    );
    assert_eq!(value["contentOmittedForUi"], serde_json::json!(true));
    assert!(compacted.chars().count() < MAX_UI_TOOL_INPUT_CHARS);
}

#[test]
fn oversized_append_file_input_is_compacted_for_ui() {
    let input = serde_json::json!({
        "path": "slides/chapter3.tex",
        "content": "x".repeat(MAX_UI_TOOL_INPUT_CHARS + 1000)
    })
    .to_string();

    let compacted = tool_input_for_ui("append_file", &input);
    let value: serde_json::Value = serde_json::from_str(&compacted).expect("json");

    assert_eq!(value["path"], "slides/chapter3.tex");
    assert!(value["content"]
        .as_str()
        .expect("content placeholder")
        .contains("omitted append_file.content"));
    assert_eq!(
        value["contentChars"],
        serde_json::json!(MAX_UI_TOOL_INPUT_CHARS + 1000)
    );
    assert_eq!(value["contentOmittedForUi"], serde_json::json!(true));
    assert!(compacted.chars().count() < MAX_UI_TOOL_INPUT_CHARS);
}

#[test]
fn desktop_prompt_reports_loaded_mcp_tools_and_failures() {
    let tools = vec![aris_chat::ChatToolSpec {
        name: "mcp__playwright__browser_navigate".to_string(),
        description: "navigate".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
        required_permission: PermissionMode::DangerFullAccess,
    }];
    let loaded = mcp_runtime_status_prompt(1, &tools, &[]).expect("status");
    assert!(loaded.contains("mcp__playwright__browser_navigate"));
    assert!(loaded.contains("ToolSearch includes"));

    let failed = mcp_runtime_status_prompt(
        1,
        &[],
        &["could not discover MCP server `playwright`: failed".to_string()],
    )
    .expect("failure status");
    assert!(failed.contains("No MCP tools were loaded"));
    assert!(failed.contains("could not discover MCP server `playwright`"));
}

#[test]
fn chat_session_cache_stays_bounded() {
    let state = ChatState::default();
    for index in 0..20 {
        cache_chat_session(&state, format!("session-{index}"), Session::new())
            .expect("cache session");
    }
    let sessions = state.sessions.lock().expect("chat state");
    assert_eq!(sessions.len(), MAX_CACHED_CHAT_SESSIONS);
    assert!(sessions.contains_key("session-19"));
}

#[test]
fn context_action_picks_warn_then_compact_by_usage() {
    use super::{context_action, ContextAction};
    assert_eq!(context_action(0, 0), ContextAction::None); // unknown window
    assert_eq!(context_action(100, 1_000), ContextAction::None); // 10%
    assert_eq!(context_action(849, 1_000), ContextAction::None); // just under warn
    assert_eq!(context_action(850, 1_000), ContextAction::Warn); // 85%
    assert_eq!(context_action(999, 1_000), ContextAction::Warn); // just under trigger
    assert_eq!(context_action(1_000, 1_000), ContextAction::Compact);
    assert_eq!(context_action(2_000, 1_000), ContextAction::Compact); // over window
}

#[test]
fn gpt5_context_window_uses_proxy_budget() {
    // Measured against the gateway (needle test, 2026-07-25): 358,708 prompt
    // tokens accepted, ~395k rejected — a 400k total window, not the 300k the
    // proxy route was assumed to have.
    assert_eq!(context_window_for_model("gpt-5.6-luna"), 400_000);
    assert_eq!(compaction_budget_for_model("gpt-5.6-luna"), 350_000);
    assert_eq!(context_window_for_model("gpt-4.1"), 400_000);
    assert_eq!(context_window_for_model("MiniMax-M3"), 1_000_000);
    assert_eq!(compaction_budget_for_model("MiniMax-M3"), 800_000);
    assert_eq!(context_window_for_model("MiniMax-M2.7"), 204_800);
    assert_eq!(compaction_budget_for_model("MiniMax-M2.7"), 160_000);
    assert_eq!(context_window_for_model("kimi-k3"), 1_000_000);
}

#[test]
fn chat_done_context_tokens_uses_the_same_session_estimate_as_auto_compaction() {
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("short visible history"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "short reply".to_string(),
            }]),
        ],
        compactions: Vec::new(),
    };
    let provider_usage = TokenUsage {
        input_tokens: 120_000,
        output_tokens: 8_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 300_000,
    };

    let context_tokens = chat_done_context_tokens(&session);

    assert_eq!(
        context_tokens,
        runtime::estimate_session_tokens(&session) as u64
    );
    assert_ne!(context_tokens, u64::from(provider_usage.prompt_tokens()));
}

pub(crate) fn workflow_runtime_context(stage_id: &str, background: bool) -> WorkflowRuntimeContext {
    WorkflowRuntimeContext {
        binding: WorkflowSessionBinding {
            run_id: "run-1".to_string(),
            session_id: "wf-run-1".to_string(),
            project_id: "project-1".to_string(),
            workspace: PathBuf::from("."),
            title: "Review".to_string(),
            topic: "topic".to_string(),
            keywords: Vec::new(),
            languages: Vec::new(),
            databases: Vec::new(),
            year_from: 2020,
            year_to: 2026,
            executor_model: None,
        },
        background,
        action_id: Some("action-1".to_string()),
        stage_id: stage_id.to_string(),
        actor: "Executor".to_string(),
    }
}

/// An autonomous turn has no user to answer a permission prompt, and
/// `DesktopPermissionPrompter::decide` blocks until one arrives. A workflow tool
/// above `ReadOnly` would therefore hang the run rather than fail it.
#[test]
fn workflow_background_tools_are_read_only() {
    for stage_id in [
        "scope-and-plan",
        "review-landscape-search",
        "matrix-strategy",
        "query-quality-loop",
        "primary-library",
        "gap-analysis",
        "batch-grading",
        "outline",
        "section-mapping",
        "direction-selection",
        "unknown-future-stage",
    ] {
        for spec in workflow_tool_specs(stage_id) {
            assert_eq!(
                spec.required_permission,
                PermissionMode::ReadOnly,
                "workflow tool `{}` at stage `{stage_id}` needs elevation and would block an autonomous turn",
                spec.name,
            );
        }
    }
}

#[test]
fn workflow_stage_groups_expose_the_capability_each_stage_needs() {
    let names = |stage_id: &str| {
        workflow_tool_specs(stage_id)
            .into_iter()
            .map(|spec| spec.name)
            .collect::<Vec<_>>()
    };

    // Asserted exactly, not by `contains`: a kernel tool the allow-list names
    // but the registry no longer has is skipped when specs are built, and a
    // `contains` check on the survivors would not notice the profile silently
    // shrinking.
    let retrieval = names("matrix-strategy");
    assert_eq!(retrieval, WORKFLOW_RETRIEVAL_TOOLS.to_vec());
    assert!(retrieval.contains(&WORKFLOW_SCOPUS_PROBE_TOOL));
    assert_eq!(names("query-quality-loop"), retrieval);

    // An analysis stage reasons over what was already retrieved instead.
    let analysis = names("batch-grading");
    assert_eq!(analysis, WORKFLOW_ANALYSIS_TOOLS.to_vec());
    assert!(!analysis.contains(&WORKFLOW_SCOPUS_PROBE_TOOL));

    // A stage nobody opted in gets the ledger reader and nothing else, so a
    // newly added stage cannot silently inherit capability.
    assert_eq!(
        names("unknown-future-stage"),
        vec![REVIEW_WORKFLOW_STATE_TOOL]
    );
    assert_eq!(
        names("direction-selection"),
        vec![REVIEW_WORKFLOW_STATE_TOOL]
    );
}

/// Being bound to a workflow session restricts the *controller's* turns. A user
/// who opens that session in Chat is having an ordinary Chat conversation, and
/// a surface that can only read the ledger back cannot help with the problem
/// that stalled the run.
#[test]
fn workflow_discussion_keeps_full_chat_capability() {
    let background = ChatTurnRuntime::Workflow(workflow_runtime_context("matrix-strategy", true));
    let discussion = ChatTurnRuntime::Workflow(workflow_runtime_context("matrix-strategy", false));

    assert!(background.is_autonomous_workflow_action());
    assert!(!discussion.is_autonomous_workflow_action());

    let (_, background_full_registry) = background.tool_profile();
    let (discussion_blocked, discussion_full_registry) = discussion.tool_profile();
    assert!(!background_full_registry);
    assert!(discussion_full_registry);
    assert_eq!(discussion_blocked, DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
}

#[test]
fn scopus_probe_rejects_bad_input_before_spending_the_budget() {
    let missing_query =
        crate::workflow::workflow_scopus_probe("{}", 0).expect_err("probe requires a query");
    assert!(missing_query.contains("query"));

    // Syntax is checked locally, so a malformed query costs a diagnostic rather
    // than a request.
    let unbalanced =
        crate::workflow::workflow_scopus_probe(r#"{"query":"TITLE-ABS-KEY((a OR b) AND (c"}"#, 0)
            .expect("a syntax problem is a result, not an error");
    assert!(unbalanced.contains("unbalanced parentheses"));
    assert!(unbalanced.contains("\"probed\": false"));

    let chinese =
        crate::workflow::workflow_scopus_probe(r#"{"query":"TITLE-ABS-KEY(研究 AND model)"}"#, 0)
            .expect("Chinese query should be returned as a local diagnostic");
    assert!(chinese.contains("Chinese/CJK"));
    assert!(chinese.contains("\"probed\": false"));

    let exhausted = crate::workflow::workflow_scopus_probe(
        r#"{"query":"TITLE-ABS-KEY(a AND b)"}"#,
        crate::workflow::WORKFLOW_SCOPUS_PROBE_BUDGET,
    )
    .expect_err("the per-turn budget is enforced in Rust, not in the prompt");
    assert!(exhausted.contains("budget exhausted"));
}

/// The bundle from run 19 showed 24 of 25 probes returning `hitCount: null`.
/// `search_scopus` leaves the total unset for a zero-result query, so the one
/// answer the probe exists to deliver arrived indistinguishable from "the probe
/// told us nothing" — and the Executor kept revising blind.
#[test]
fn probe_verdicts_separate_zero_results_from_an_absent_total() {
    let verdict = |hits: Option<u64>| match hits {
        Some(0) => "ZERO RESULTS",
        Some(count) if count < 20 => "TOO NARROW",
        Some(_) => "OK",
        None => "INCONCLUSIVE",
    };

    assert_eq!(verdict(Some(0)), "ZERO RESULTS");
    assert_eq!(verdict(Some(3)), "TOO NARROW");
    assert_eq!(verdict(Some(4_200)), "OK");
    // Reserved for "records came back but the provider gave no total", which is
    // a different situation from an empty result set.
    assert_eq!(verdict(None), "INCONCLUSIVE");
}

/// The composer switches models per session without persisting them, so the
/// reasoning-effort commands must answer for the model the caller names.
/// Answering from `executor_model` made every switch on a session whose model
/// differed from the last Settings save come back `supported: false`, which the
/// pill renders as "provider default".
#[test]
fn reasoning_effort_answers_for_the_caller_model_not_the_configured_executor() {
    assert_eq!(reasoning_effort_model(Some("gpt-5.6")), "gpt-5.6");
    assert_eq!(reasoning_effort_model(Some("  gpt-5.6  ")), "gpt-5.6");
    // No model from the caller falls back to the configured executor, and to
    // the default model when even that is unset — never to an empty id, which
    // would report every model as unsupported.
    assert!(!reasoning_effort_model(None).is_empty());
    assert!(!reasoning_effort_model(Some("   ")).is_empty());

    let (supported, applied, _, _) =
        reasoning_effort_capability_at("gpt-5.6", Some("https://gateway.example.com/v1"));
    assert!(supported && applied);

    let (supported, applied, transport, _) =
        reasoning_effort_capability_at("MiniMax-M3", Some("https://gateway.example.com/v1"));
    assert!(!supported && !applied);
    assert_eq!(transport, "unsupported");
}

/// The Responses-API note is about the endpoint that serves this model, which
/// for a per-session model is its own verified entry rather than the globally
/// configured base URL.
#[test]
fn reasoning_effort_transport_follows_the_endpoint_serving_the_model() {
    let (_, _, transport, message) =
        reasoning_effort_capability_at("gpt-5.6", Some("https://api.openai.com/v1/"));
    assert_eq!(transport, "responses");
    assert!(message.is_some());

    let (_, _, transport, message) =
        reasoning_effort_capability_at("gpt-5.6", Some("https://gateway.example.com/v1"));
    assert_eq!(transport, "provider_native");
    assert!(message.is_none());

    // Claude never routes through the Responses API, official endpoint or not.
    let (_, _, transport, _) =
        reasoning_effort_capability_at("claude-opus-4-7", Some("https://api.openai.com/v1"));
    assert_eq!(transport, "provider_native");
}

/// The browser fallback exists for publishers that refuse a plain HTTP client.
/// Anything else keeps the original failure verbatim, so an ordinary broken
/// link is not reported as a browser problem.
#[test]
fn pdf_download_fallback_preserves_the_direct_error_without_a_publisher_route() {
    let direct = "PDF request failed with HTTP 500 for https://example.com/paper.pdf".to_string();
    let error = browser_pdf_download_fallback(
        &json!({ "url": "https://example.com/paper.pdf", "fileName": "paper.pdf" }),
        direct.clone(),
        &runtime::ProjectExecutionContext::new(std::env::temp_dir()),
        &|| false,
    )
    .expect_err("no publisher route");
    assert_eq!(error, direct);
}

/// Stop must be honoured before a browser session is started, not after: the
/// retry is the expensive half of this path.
#[test]
fn pdf_download_fallback_does_not_open_a_browser_after_cancellation() {
    let direct = "publisher refused the direct PDF request (HTTP 403)".to_string();
    let error = browser_pdf_download_fallback(
        &json!({
            "url": "https://www.mdpi.com/1424-8220/23/7/3762/pdf?version=1680753458",
            "fileName": "s23073762.pdf"
        }),
        direct.clone(),
        &runtime::ProjectExecutionContext::new(std::env::temp_dir()),
        &|| true,
    )
    .expect_err("cancelled before the browser starts");
    assert_eq!(error, direct);
}

use super::*;

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

#[test]
fn paired_remote_runtime_uses_dedicated_remote_streams() {
    let remote = ChatTurnRuntime::RemoteApproved;
    let (blocked_tools, full_tool_registry) = remote.tool_profile();

    assert!(full_tool_registry);
    assert_eq!(blocked_tools, REMOTE_APPROVED_EXTRA_BLOCKED_TOOLS);
    assert!(blocked_tools.contains(&ASK_USER_QUESTION_TOOL));
    assert_eq!(remote.event_delivery(), ChatEventDelivery::Remote);
    assert!(!remote.emits_desktop_chat_events());
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
    let session_id = format!("remote-project-session-{}", std::process::id());
    let root = std::env::temp_dir().join(format!(
        "somniq-remote-project-session-{}",
        remote_protocol::DeviceId::new()
    ));
    let project_id = "project-0123456789abcdef";
    let sessions_dir = crate::state::project_runtime_dir(project_id).join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("create project session directory");
    let path = sessions_dir.join(format!("{session_id}.json"));
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("project scoped"));
    session.save_to_path(&path).expect("write project session");

    std::fs::create_dir_all(&root).expect("create project workspace");
    let loaded = with_bound_project_environment(&root, project_id, || {
        get_project_scoped_chat_session(project_id, &session_id)
    })
    .expect("bind default project environment")
    .expect("paired chat reads the project-scoped session");
    assert_eq!(loaded.messages.len(), 1);

    let _ = std::fs::remove_file(path);
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
    let raw = "```json\n{\"hasLongTermIntent\":true,\"objective\":\"Ship durable continuity\",\"confidence\":91}\n```";
    let json = extract_json_object(raw).expect("json object");
    let generated: GeneratedProjectIntent = serde_json::from_str(json).expect("intent json");
    assert!(generated.has_long_term_intent);
    assert_eq!(generated.objective, "Ship durable continuity");
    assert_eq!(generated.confidence, 91);
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
    assert!(message.contains("# Research Literature Review"));
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
    assert_eq!(clean_generated_title("无主题"), "");
}

#[test]
fn desktop_chat_hides_team_workflow_tools_and_lets_permission_mode_gate_them() {
    let specs = tool_specs_for(DESKTOP_CHAT_EXTRA_BLOCKED_TOOLS);
    assert!(specs.iter().any(|spec| spec.name == "bash"));
    assert!(specs.iter().any(|spec| spec.name == "Agent"));
    assert!(!specs.iter().any(|spec| spec.name == "Workflow"));
    assert!(!specs.iter().any(|spec| spec.name == "ListTeam"));
    assert!(!specs.iter().any(|spec| spec.name == "AgentSupervisor"));

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
fn ui_keeps_moderate_tool_output_intact() {
    let output = "x".repeat(10_000);
    let rendered = tool_output_for_ui(&output, None);

    assert_eq!(rendered, output);
    assert!(!rendered.contains("SomniQ truncated"));
}

#[test]
fn shell_output_under_context_limit_stays_intact() {
    let raw = serde_json::to_string_pretty(&json!({
        "stdout": "x".repeat(20_000),
        "stderr": "",
        "rawOutputPath": null,
        "interrupted": false
    }))
    .expect("json");

    let compacted = compact_tool_output_for_context("bash", raw.clone(), None);
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("tool result remains json");

    assert_eq!(compacted, raw);
    assert_eq!(parsed["stdout"].as_str().unwrap().chars().count(), 20_000);
    assert!(!compacted.contains("SomniQ truncated"));
}

#[test]
fn huge_shell_output_preserves_json_and_full_output_path() {
    let stdout = format!("start{}end", "x".repeat(90_000));
    let raw = serde_json::to_string_pretty(&json!({
        "stdout": stdout,
        "stderr": "",
        "rawOutputPath": null,
        "interrupted": false
    }))
    .expect("json");
    let artifact = ToolOutputArtifact {
        path: "C:\\tmp\\somniq-output.txt".to_string(),
        bytes: raw.len() as u64,
    };

    let compacted = compact_tool_output_for_context("bash", raw, Some(&artifact));
    let parsed: serde_json::Value =
        serde_json::from_str(&compacted).expect("compacted tool result remains json");
    let compacted_stdout = parsed["stdout"].as_str().expect("stdout string");

    assert!(compacted.chars().count() <= MAX_CONTEXT_TOOL_OUTPUT_CHARS);
    assert!(compacted_stdout.starts_with("start"));
    assert!(compacted_stdout.ends_with("end"));
    assert!(compacted_stdout.contains("SomniQ truncated stdout"));
    assert!(compacted_stdout.chars().count() <= SHELL_STREAM_CONTEXT_CHARS);
    assert_eq!(parsed["persistedOutputPath"], artifact.path);
    assert_eq!(parsed["rawOutputPath"], artifact.path);
    assert_eq!(parsed["persistedOutputSize"], artifact.bytes);
    assert_eq!(parsed["truncatedForContext"], true);
}

#[test]
fn latex_compile_context_keeps_primary_diagnostic_and_bounds_raw_logs() {
    let raw = serde_json::to_string_pretty(&json!({
        "success": false,
        "inputPath": "papers/report.tex",
        "outputPath": "papers/report.pdf",
        "engine": "latexmk -xelatex",
        "stdout": "x".repeat(12_000),
        "stderr": "! Extra alignment tab has been changed to \\cr.\nl.70 table row",
        "returnCodeInterpretation": "exit_code:1",
        "diagnostics": [{
            "severity": "error",
            "code": "table_alignment",
            "message": "Extra alignment tab has been changed to \\cr.",
            "filePath": "papers/report.tex",
            "line": 70
        }]
    }))
    .expect("json");
    let artifact = ToolOutputArtifact {
        path: "C:\\tmp\\latex-output.txt".to_string(),
        bytes: raw.len() as u64,
    };

    let compacted = compact_tool_output_for_context("LaTeXCompile", raw, Some(&artifact));
    let parsed: serde_json::Value = serde_json::from_str(&compacted).expect("json output");

    assert!(compacted.chars().count() <= MAX_LATEX_CONTEXT_OUTPUT_CHARS);
    assert_eq!(parsed["diagnostics"][0]["line"], 70);
    assert!(parsed["stdout"]
        .as_str()
        .unwrap()
        .contains("SomniQ truncated stdout"));
    assert_eq!(parsed["persistedOutputPath"], artifact.path);
    let hint = tool_recovery_hint("LaTeXCompile", &compacted).expect("targeted hint");
    assert!(hint.contains("papers/report.tex:70"));
    assert!(hint.contains("do not compile through REPL"));
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
fn shell_status_metadata_marks_tool_output_as_error() {
    let ok = serde_json::to_string(&json!({
        "stdout": "ok",
        "stderr": "",
        "interrupted": false,
        "returnCodeInterpretation": null
    }))
    .expect("json");
    assert!(!tool_output_indicates_error("PowerShell", &ok));

    let failed = serde_json::to_string(&json!({
        "stdout": "",
        "stderr": "bad",
        "interrupted": false,
        "returnCodeInterpretation": "exit_code:7"
    }))
    .expect("json");
    assert!(tool_output_indicates_error("PowerShell", &failed));

    let interrupted = serde_json::to_string(&json!({
        "stdout": "",
        "stderr": "Command interrupted by user",
        "interrupted": true,
        "returnCodeInterpretation": "interrupted"
    }))
    .expect("json");
    assert!(tool_output_indicates_error("bash", &interrupted));
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
fn project_permission_sync_replaces_stale_session_modes() {
    let state = ChatState::default();
    set_permission_mode_for(&state, "chat-a".to_string(), PermissionMode::WorkspaceWrite)
        .expect("set initial permission");

    sync_permission_modes_to_project_default(&state, PermissionMode::DangerFullAccess)
        .expect("sync permission");

    assert_eq!(
        permission_mode_for(&state, "chat-a").expect("permission mode"),
        PermissionMode::DangerFullAccess
    );
}

#[test]
fn desktop_prompt_requests_links_for_generated_files() {
    let prompt = build_system_prompt_inner("test-model", true).join("\n");

    assert!(prompt.contains("desktop tool registry"));
    assert!(prompt.contains("include Markdown links"));
    assert!(prompt.contains("Existing artifact edits"));
    assert!(prompt.contains("Do not create sibling version files"));
    assert!(prompt.contains("fenced `mermaid` code block"));
    assert!(prompt.contains("Long file generation"));
    assert!(prompt.contains("24000 characters"));
    assert!(prompt.contains("append_file"));
}

#[test]
fn desktop_prompt_is_deterministic_for_prompt_caching() {
    // The system prompt is rebuilt every turn and forms the request prefix.
    // OpenAI-compatible automatic prompt caching (the only caching path ARIS
    // has — there is no native Anthropic /v1/messages channel) only engages
    // when that prefix is byte-identical across turns. Any per-call
    // nondeterminism — a timestamp, a random id, HashMap iteration order — in
    // a prompt section would silently bust the cache and quietly inflate input
    // token cost. Guard the invariant so such a regression fails loudly here.
    let first = build_system_prompt_inner("test-model", true).join("\n");
    let second = build_system_prompt_inner("test-model", true).join("\n");
    assert_eq!(
        first, second,
        "system prompt must be deterministic across rebuilds so prompt caching can hit"
    );
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
fn latex_toolchain_prompt_prefers_texlive_over_tectonic() {
    let prompt = latex_toolchain_prompt_section(Some(r"C:\texlive\2026\bin\windows\latexmk.exe"));

    assert!(prompt.contains("TeX Live"));
    assert!(prompt.contains("latexmk"));
    assert!(prompt.contains("pdflatex"));
    assert!(prompt.contains("Do not use Tectonic"));
    assert!(prompt.contains("latexmk.exe"));
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
    assert_eq!(context_action(699, 1_000), ContextAction::None); // just under warn
    assert_eq!(context_action(700, 1_000), ContextAction::Warn); // 70%
    assert_eq!(context_action(899, 1_000), ContextAction::Warn); // just under trigger
    assert_eq!(context_action(900, 1_000), ContextAction::Compact); // 90%
    assert_eq!(context_action(2_000, 1_000), ContextAction::Compact); // over window
}

#[test]
fn gpt5_context_window_uses_proxy_budget() {
    assert_eq!(context_window_for_model("gpt-5.6-luna"), 300_000);
    assert_eq!(context_window_for_model("gpt-4.1"), 300_000);
}

#[test]
fn chat_done_context_tokens_use_session_estimate_not_provider_total() {
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
    let usage = latest_provider_usage(&[provider_usage]).expect("provider usage");

    assert_eq!(
        context_tokens,
        runtime::estimate_session_tokens(&session) as u64
    );
    assert_ne!(context_tokens, u64::from(provider_usage.total_tokens()));
    assert_eq!(usage.prompt_tokens, provider_usage.prompt_tokens());
    assert_eq!(usage.total_tokens, provider_usage.total_tokens());
}

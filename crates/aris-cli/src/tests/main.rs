use super::{
    deploy_meta_opt_hooks_to, filter_tool_specs, format_compact_report, format_cost_report,
    format_model_report, format_model_switch_report, format_permissions_report,
    format_permissions_switch_report, format_resume_report, format_status_report,
    format_tool_call_start, format_tool_result, normalize_allowed_tools, normalize_permission_mode,
    parse_args, parse_git_status_metadata, print_help_to, push_output_block, render_config_report,
    render_memory_report, render_repl_help, resolve_model_alias, response_to_events,
    resume_supported_slash_commands, status_context, CliAction, CliOutputFormat, SlashCommand,
    StatusUsage, DEFAULT_MODEL,
};
use api::{MessageResponse, OutputContentBlock, Usage};
use runtime::{
    AssistantEvent, CompactionResult, CompactionSummarySource, ContentBlock, ConversationMessage,
    MessageRole, PermissionMode, Session,
};
use serde_json::json;
use std::path::PathBuf;

#[test]
fn defaults_to_repl_when_no_args() {
    assert_eq!(
        parse_args(&[]).expect("args should parse"),
        CliAction::Repl {
            model: DEFAULT_MODEL.to_string(),
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn parses_prompt_subcommand() {
    let args = vec![
        "prompt".to_string(),
        "hello".to_string(),
        "world".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::Prompt {
            prompt: "hello world".to_string(),
            model: DEFAULT_MODEL.to_string(),
            output_format: CliOutputFormat::Text,
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn parses_bare_prompt_and_json_output_flag() {
    let args = vec![
        "--output-format=json".to_string(),
        "--model".to_string(),
        "claude-opus".to_string(),
        "explain".to_string(),
        "this".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::Prompt {
            prompt: "explain this".to_string(),
            model: "claude-opus".to_string(),
            output_format: CliOutputFormat::Json,
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn resolves_model_aliases_in_args() {
    let args = vec![
        "--model".to_string(),
        "opus".to_string(),
        "explain".to_string(),
        "this".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::Prompt {
            prompt: "explain this".to_string(),
            model: "claude-opus-4-8".to_string(),
            output_format: CliOutputFormat::Text,
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn resolves_known_model_aliases() {
    assert_eq!(resolve_model_alias("opus"), "claude-opus-4-8");
    assert_eq!(resolve_model_alias("sonnet"), "claude-sonnet-4-6");
    assert_eq!(resolve_model_alias("haiku"), "claude-haiku-4-5-20251001");
    assert_eq!(resolve_model_alias("claude-opus"), "claude-opus");
}

#[test]
fn parses_version_flags_without_initializing_prompt_mode() {
    assert_eq!(
        parse_args(&["--version".to_string()]).expect("args should parse"),
        CliAction::Version
    );
    assert_eq!(
        parse_args(&["-V".to_string()]).expect("args should parse"),
        CliAction::Version
    );
}

#[test]
fn parses_permission_mode_flag() {
    let args = vec!["--permission-mode=read-only".to_string()];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::Repl {
            model: DEFAULT_MODEL.to_string(),
            allowed_tools: None,
            permission_mode: PermissionMode::ReadOnly,
        }
    );
}

#[test]
fn parses_allowed_tools_flags_with_aliases_and_lists() {
    let args = vec![
        "--allowedTools".to_string(),
        "read,glob".to_string(),
        "--allowed-tools=write_file".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::Repl {
            model: DEFAULT_MODEL.to_string(),
            allowed_tools: Some(
                ["glob_search", "read_file", "write_file"]
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            ),
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn rejects_unknown_allowed_tools() {
    let error = parse_args(&["--allowedTools".to_string(), "teleport".to_string()])
        .expect_err("tool should be rejected");
    assert!(error.contains("unsupported tool in --allowedTools: teleport"));
}

#[test]
fn parses_system_prompt_options() {
    let args = vec![
        "system-prompt".to_string(),
        "--cwd".to_string(),
        "/tmp/project".to_string(),
        "--date".to_string(),
        "2026-04-01".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::PrintSystemPrompt {
            cwd: PathBuf::from("/tmp/project"),
            date: "2026-04-01".to_string(),
        }
    );
}

#[test]
fn parses_login_and_logout_subcommands() {
    assert_eq!(
        parse_args(&["login".to_string()]).expect("login should parse"),
        CliAction::Login
    );
    assert_eq!(
        parse_args(&["logout".to_string()]).expect("logout should parse"),
        CliAction::Logout
    );
    assert_eq!(
        parse_args(&["init".to_string()]).expect("init should parse"),
        CliAction::Init
    );
}

#[test]
fn parses_resume_flag_with_slash_command() {
    let args = vec![
        "--resume".to_string(),
        "session.json".to_string(),
        "/compact".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::ResumeSession {
            session_path: PathBuf::from("session.json"),
            commands: vec!["/compact".to_string()],
            model: DEFAULT_MODEL.to_string(),
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn parses_resume_flag_with_multiple_slash_commands() {
    let args = vec![
        "--resume".to_string(),
        "session.json".to_string(),
        "/status".to_string(),
        "/compact".to_string(),
        "/cost".to_string(),
    ];
    assert_eq!(
        parse_args(&args).expect("args should parse"),
        CliAction::ResumeSession {
            session_path: PathBuf::from("session.json"),
            commands: vec![
                "/status".to_string(),
                "/compact".to_string(),
                "/cost".to_string(),
            ],
            model: DEFAULT_MODEL.to_string(),
            allowed_tools: None,
            permission_mode: PermissionMode::DangerFullAccess,
        }
    );
}

#[test]
fn filtered_tool_specs_respect_allowlist() {
    let allowed = ["read_file", "grep_search"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let filtered = filter_tool_specs(Some(&allowed));
    let names = filtered
        .into_iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["read_file", "grep_search"]);
}

#[test]
fn allowed_tools_accept_mcp_qualified_names() {
    let allowed = normalize_allowed_tools(&["mcp__codex__codex-reply".to_string()])
        .expect("MCP tool should be accepted")
        .expect("allowlist");
    assert!(allowed.contains("mcp__codex__codex-reply"));
}

#[test]
fn shared_help_uses_resume_annotation_copy() {
    let help = commands::render_slash_command_help();
    assert!(help.contains("Slash commands"));
    assert!(help.contains("works with --resume SESSION.json"));
}

#[test]
fn repl_help_includes_shared_commands_and_exit() {
    let help = render_repl_help();
    assert!(help.contains("REPL"));
    assert!(help.contains("/help"));
    assert!(help.contains("/status"));
    assert!(help.contains("/model [model]"));
    assert!(help.contains("/permissions [read-only|workspace-write|danger-full-access]"));
    assert!(help.contains("/clear [--confirm]"));
    assert!(help.contains("/cost"));
    assert!(help.contains("/resume <session-path>"));
    assert!(help.contains("/config [env|hooks|model]"));
    assert!(help.contains("/memory"));
    assert!(help.contains("/init"));
    assert!(help.contains("/diff"));
    assert!(help.contains("/version"));
    assert!(help.contains("/export [file]"));
    assert!(
        help.contains("/session [list|search <query>|switch <session-id>|timeline [session-id]]")
    );
    assert!(help.contains("/exit"));
}

#[test]
fn resume_supported_command_list_matches_expected_surface() {
    let names = resume_supported_slash_commands()
        .into_iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "help", "status", "compact", "clear", "cost", "config", "memory", "init", "diff",
            "version", "export",
        ]
    );
}

#[test]
fn resume_report_uses_sectioned_layout() {
    let report = format_resume_report("session.json", 14, 6);
    assert!(report.contains("Session resumed"));
    assert!(report.contains("Session file     session.json"));
    assert!(report.contains("Messages         14"));
    assert!(report.contains("Turns            6"));
}

#[test]
fn compact_report_uses_structured_output() {
    let compacted = format_compact_report(&CompactionResult {
        summary: "<summary>done</summary>".to_string(),
        formatted_summary: "Summary:\ndone".to_string(),
        compacted_session: Session::new(),
        removed_message_count: 8,
        preserved_message_count: 4,
        tokens_before: 100,
        tokens_after: 40,
        summary_source: CompactionSummarySource::Llm,
        summary_output_tokens: Some(24),
        token_estimate_source: runtime::CompactionTokenEstimateSource::ProviderSummaryUsage,
    });
    assert!(compacted.contains("Compact"));
    assert!(compacted.contains("Result           compacted"));
    assert!(compacted.contains("Summary source   llm"));
    assert!(compacted.contains("Messages removed 8"));
    let skipped = format_compact_report(&CompactionResult {
        summary: String::new(),
        formatted_summary: String::new(),
        compacted_session: Session::new(),
        removed_message_count: 0,
        preserved_message_count: 0,
        tokens_before: 12,
        tokens_after: 12,
        summary_source: CompactionSummarySource::Skipped,
        summary_output_tokens: None,
        token_estimate_source: runtime::CompactionTokenEstimateSource::Heuristic,
    });
    assert!(skipped.contains("Result           skipped"));
}

#[test]
fn cost_report_uses_sectioned_layout() {
    let report = format_cost_report(runtime::TokenUsage {
        input_tokens: 20,
        output_tokens: 8,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 1,
    });
    assert!(report.contains("Cost"));
    assert!(report.contains("Input tokens     20"));
    assert!(report.contains("Output tokens    8"));
    assert!(report.contains("Cache create     3"));
    assert!(report.contains("Cache read       1"));
    assert!(report.contains("Total tokens     32"));
}

#[test]
fn permissions_report_uses_sectioned_layout() {
    let report = format_permissions_report("workspace-write");
    assert!(report.contains("Permissions"));
    assert!(report.contains("Active mode      workspace-write"));
    assert!(report.contains("Modes"));
    assert!(report.contains("read-only          ○ available Read/search tools only"));
    assert!(report.contains("workspace-write    ● current   Edit files inside the workspace"));
    assert!(report.contains("danger-full-access ○ available Unrestricted tool access"));
}

#[test]
fn permissions_switch_report_is_structured() {
    let report = format_permissions_switch_report("read-only", "workspace-write");
    assert!(report.contains("Permissions updated"));
    assert!(report.contains("Result           mode switched"));
    assert!(report.contains("Previous mode    read-only"));
    assert!(report.contains("Active mode      workspace-write"));
    assert!(report.contains("Applies to       subsequent tool calls"));
}

#[test]
fn init_help_mentions_direct_subcommand() {
    let mut help = Vec::new();
    print_help_to(&mut help).expect("help should render");
    let help = String::from_utf8(help).expect("help should be utf8");
    assert!(help.contains("aris init"));
}

#[test]
fn model_report_uses_sectioned_layout() {
    let report = format_model_report("claude-sonnet", 12, 4);
    assert!(report.contains("Model"));
    assert!(report.contains("Current model    claude-sonnet"));
    assert!(report.contains("Session messages 12"));
    assert!(report.contains("Switch models with /model <name>"));
}

#[test]
fn model_switch_report_preserves_context_summary() {
    let report = format_model_switch_report("claude-sonnet", "claude-opus", 9);
    assert!(report.contains("Model updated"));
    assert!(report.contains("Previous         claude-sonnet"));
    assert!(report.contains("Current          claude-opus"));
    assert!(report.contains("Preserved msgs   9"));
}

#[test]
fn status_line_reports_model_and_token_totals() {
    let status = format_status_report(
        "claude-sonnet",
        StatusUsage {
            message_count: 7,
            turns: 3,
            latest: runtime::TokenUsage {
                input_tokens: 5,
                output_tokens: 4,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 0,
            },
            cumulative: runtime::TokenUsage {
                input_tokens: 20,
                output_tokens: 8,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 1,
            },
            estimated_tokens: 128,
        },
        "workspace-write",
        &super::StatusContext {
            cwd: PathBuf::from("/tmp/project"),
            session_path: Some(PathBuf::from("session.json")),
            loaded_config_files: 2,
            discovered_config_files: 3,
            memory_file_count: 4,
            project_root: Some(PathBuf::from("/tmp")),
            git_branch: Some("main".to_string()),
        },
    );
    assert!(status.contains("Status"));
    assert!(status.contains("Model            claude-sonnet"));
    assert!(status.contains("Permission mode  workspace-write"));
    assert!(status.contains("Messages         7"));
    assert!(status.contains("Latest total     10"));
    assert!(status.contains("Cumulative total 31"));
    assert!(status.contains("Cwd              /tmp/project"));
    assert!(status.contains("Project root     /tmp"));
    assert!(status.contains("Git branch       main"));
    assert!(status.contains("Session          session.json"));
    assert!(status.contains("Config files     loaded 2/3"));
    assert!(status.contains("Memory files     4"));
}

#[test]
fn config_report_supports_section_views() {
    let report = render_config_report(Some("env")).expect("config report should render");
    assert!(report.contains("Merged section: env"));
}

#[test]
fn memory_report_uses_sectioned_layout() {
    let report = render_memory_report().expect("memory report should render");
    assert!(report.contains("Memory"));
    assert!(report.contains("Working directory"));
    assert!(report.contains("Hot memory"));
    assert!(report.contains("Knowledge catalog"));
}

#[test]
fn config_report_uses_sectioned_layout() {
    let report = render_config_report(None).expect("config report should render");
    assert!(report.contains("Config"));
    assert!(report.contains("Discovered files"));
    assert!(report.contains("Merged JSON"));
}

#[test]
fn parses_git_status_metadata() {
    let (root, branch) = parse_git_status_metadata(Some(
        "## rcc/cli...origin/rcc/cli
 M src/main.rs",
    ));
    assert_eq!(branch.as_deref(), Some("rcc/cli"));
    let _ = root;
}

#[test]
fn status_context_reads_real_workspace_metadata() {
    let context = status_context(None).expect("status context should load");
    assert!(context.cwd.is_absolute());
    assert_eq!(context.discovered_config_files, 6);
    assert!(context.loaded_config_files <= context.discovered_config_files);
}

#[test]
fn normalizes_supported_permission_modes() {
    assert_eq!(normalize_permission_mode("read-only"), Some("read-only"));
    assert_eq!(
        normalize_permission_mode("workspace-write"),
        Some("workspace-write")
    );
    assert_eq!(
        normalize_permission_mode("danger-full-access"),
        Some("danger-full-access")
    );
    assert_eq!(normalize_permission_mode("unknown"), None);
}

#[test]
fn clear_command_requires_explicit_confirmation_flag() {
    assert_eq!(
        SlashCommand::parse("/clear"),
        Some(SlashCommand::Clear { confirm: false })
    );
    assert_eq!(
        SlashCommand::parse("/clear --confirm"),
        Some(SlashCommand::Clear { confirm: true })
    );
}

#[test]
fn parses_resume_and_config_slash_commands() {
    assert_eq!(
        SlashCommand::parse("/resume saved-session.json"),
        Some(SlashCommand::Resume {
            session_path: Some("saved-session.json".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/clear --confirm"),
        Some(SlashCommand::Clear { confirm: true })
    );
    assert_eq!(
        SlashCommand::parse("/config"),
        Some(SlashCommand::Config { section: None })
    );
    assert_eq!(
        SlashCommand::parse("/config env"),
        Some(SlashCommand::Config {
            section: Some("env".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/memory"),
        Some(SlashCommand::Memory {
            action: None,
            target: None
        })
    );
    assert_eq!(
        SlashCommand::parse("/goal status"),
        Some(SlashCommand::Goal {
            action: Some("status".to_string()),
            objective: None,
        })
    );
    assert_eq!(SlashCommand::parse("/init"), Some(SlashCommand::Init));
}

#[test]
fn init_template_mentions_detected_rust_workspace() {
    let rendered = crate::init::render_init_agents_md(std::path::Path::new("."));
    assert!(rendered.contains("# Project guidance"));
    assert!(rendered.contains("cargo clippy --workspace --all-targets -- -D warnings"));
}

#[test]
fn converts_tool_roundtrip_messages() {
    let messages = vec![
        ConversationMessage::user_text("hello"),
        ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            input: "{\"command\":\"pwd\"}".to_string(),
        }]),
        ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                tool_name: "bash".to_string(),
                output: "ok".to_string(),
                is_error: false,
            }],
            usage: None,
        },
    ];

    let converted = super::convert_messages(&messages);
    assert_eq!(converted.len(), 3);
    assert_eq!(converted[1].role, "assistant");
    assert_eq!(converted[2].role, "user");
}
#[test]
fn repl_help_mentions_history_completion_and_multiline() {
    let help = render_repl_help();
    assert!(help.contains("Up/Down"));
    assert!(help.contains("Tab"));
    assert!(help.contains("Shift+Enter/Ctrl+J"));
}

#[test]
fn tool_rendering_helpers_compact_output() {
    let start = format_tool_call_start("read_file", r#"{"path":"src/main.rs"}"#);
    assert!(start.contains("read_file"));
    assert!(start.contains("src/main.rs"));

    let done = format_tool_result(
        "read_file",
        r#"{"file":{"filePath":"src/main.rs","content":"hello","numLines":1,"startLine":1,"totalLines":1}}"#,
        false,
    );
    assert!(done.contains("📄 Read src/main.rs"));
    assert!(done.contains("hello"));
}

#[test]
fn push_output_block_renders_markdown_text() {
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut pending_tool = None;

    push_output_block(
        OutputContentBlock::Text {
            text: "# Heading".to_string(),
        },
        &mut out,
        &mut events,
        &mut pending_tool,
        false,
    )
    .expect("text block should render");

    let rendered = String::from_utf8(out).expect("utf8");
    assert!(rendered.contains("Heading"));
    assert!(rendered.contains('\u{1b}'));
}

#[test]
fn push_output_block_skips_empty_object_prefix_for_tool_streams() {
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut pending_tool = None;

    push_output_block(
        OutputContentBlock::ToolUse {
            id: "tool-1".to_string(),
            name: "read_file".to_string(),
            input: json!({}),
        },
        &mut out,
        &mut events,
        &mut pending_tool,
        true,
    )
    .expect("tool block should accumulate");

    assert!(events.is_empty());
    assert_eq!(
        pending_tool,
        Some(("tool-1".to_string(), "read_file".to_string(), String::new(),))
    );
}

#[test]
fn response_to_events_preserves_empty_object_json_input_outside_streaming() {
    let mut out = Vec::new();
    let events = response_to_events(
        MessageResponse {
            id: "msg-1".to_string(),
            kind: "message".to_string(),
            model: "claude-opus-4-7".to_string(),
            role: "assistant".to_string(),
            content: vec![OutputContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read_file".to_string(),
                input: json!({}),
            }],
            stop_reason: Some("tool_use".to_string()),
            stop_sequence: None,
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            request_id: None,
        },
        &mut out,
    )
    .expect("response conversion should succeed");

    assert!(matches!(
        &events[0],
        AssistantEvent::ToolUse { name, input, .. }
            if name == "read_file" && input == "{}"
    ));
}

#[test]
fn response_to_events_preserves_non_empty_json_input_outside_streaming() {
    let mut out = Vec::new();
    let events = response_to_events(
        MessageResponse {
            id: "msg-2".to_string(),
            kind: "message".to_string(),
            model: "claude-opus-4-7".to_string(),
            role: "assistant".to_string(),
            content: vec![OutputContentBlock::ToolUse {
                id: "tool-2".to_string(),
                name: "read_file".to_string(),
                input: json!({ "path": "rust/Cargo.toml" }),
            }],
            stop_reason: Some("tool_use".to_string()),
            stop_sequence: None,
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            request_id: None,
        },
        &mut out,
    )
    .expect("response conversion should succeed");

    assert!(matches!(
        &events[0],
        AssistantEvent::ToolUse { name, input, .. }
            if name == "read_file" && input == "{\"path\":\"rust/Cargo.toml\"}"
    ));
}

// ----- v0.4.13: deploy_meta_opt_hooks_to tests -----
//
// These tests build a fake cache_dir + a fake HOME under env::temp_dir(),
// never touch the real ~/.claude, and exercise:
//   1. fresh deploy (no settings.json): hooks copied + settings created
//   2. existing settings preserved without clobber when we merge
//   3. idempotency: a second run does not duplicate hook entries

fn meta_opt_test_root() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time after epoch")
        .as_nanos();
    let pid = std::process::id();
    std::env::temp_dir().join(format!("aris-meta-opt-test-{pid}-{nanos}"))
}

fn write_fake_cache(root: &std::path::Path) -> std::path::PathBuf {
    let cache_dir = root.join("cache");
    let meta_opt = cache_dir.join("tools").join("meta_opt");
    std::fs::create_dir_all(&meta_opt).expect("create cache meta_opt dir");
    std::fs::write(
        meta_opt.join("log_event.sh"),
        "#!/usr/bin/env bash\necho log_event\n",
    )
    .expect("write log_event.sh");
    std::fs::write(
        meta_opt.join("check_ready.sh"),
        "#!/usr/bin/env bash\necho check_ready\n",
    )
    .expect("write check_ready.sh");
    cache_dir
}

#[test]
fn deploy_meta_opt_hooks_creates_hooks_dir_and_copies_scripts() {
    let root = meta_opt_test_root();
    let cache_dir = write_fake_cache(&root);
    let home = root.join("home");
    std::fs::create_dir_all(&home).expect("create home");

    let report = deploy_meta_opt_hooks_to(&home, &cache_dir).expect("first deploy should succeed");
    assert!(
        report.contains("Meta-Optimize hooks deployed"),
        "report missing header: {report}"
    );

    let hooks_dir = home.join(".claude").join("hooks");
    assert!(hooks_dir.is_dir(), "hooks dir should exist");
    // v0.4.13 codex round-1 #1: ARIS-namespaced destination names
    let log_event = hooks_dir.join("aris-meta-opt-log-event.sh");
    let check_ready = hooks_dir.join("aris-meta-opt-check-ready.sh");
    assert!(
        log_event.is_file(),
        "aris-meta-opt-log-event.sh should exist"
    );
    assert!(
        check_ready.is_file(),
        "aris-meta-opt-check-ready.sh should exist"
    );

    let log_event_body =
        std::fs::read_to_string(&log_event).expect("read aris-meta-opt-log-event.sh");
    assert!(log_event_body.contains("echo log_event"));
    let check_ready_body =
        std::fs::read_to_string(&check_ready).expect("read aris-meta-opt-check-ready.sh");
    assert!(check_ready_body.contains("echo check_ready"));

    // settings.json was created with the new hooks block
    let settings_path = home.join(".claude").join("settings.json");
    assert!(settings_path.is_file(), "settings.json should exist");
    let settings_value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("read settings.json"))
            .expect("settings.json parses");
    // PostToolUse references aris-meta-opt-log-event.sh
    let post_arr = settings_value
        .pointer("/hooks/PostToolUse")
        .and_then(|v| v.as_array())
        .expect("hooks.PostToolUse array");
    assert_eq!(post_arr.len(), 1);
    let post_cmd = post_arr[0]
        .pointer("/hooks/0/command")
        .and_then(|v| v.as_str())
        .expect("PostToolUse command");
    assert!(
        post_cmd.contains("aris-meta-opt-log-event.sh"),
        "PostToolUse cmd should mention aris-meta-opt-log-event.sh, got {post_cmd}"
    );
    // SessionEnd has BOTH log_event and check_ready
    let session_end_arr = settings_value
        .pointer("/hooks/SessionEnd")
        .and_then(|v| v.as_array())
        .expect("hooks.SessionEnd array");
    assert_eq!(
        session_end_arr.len(),
        2,
        "SessionEnd should have 2 matcher entries (log_event + check_ready)"
    );

    std::fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn deploy_meta_opt_hooks_merges_into_existing_settings_json_without_clobber() {
    let root = meta_opt_test_root();
    let cache_dir = write_fake_cache(&root);
    let home = root.join("home");
    let claude_dir = home.join(".claude");
    std::fs::create_dir_all(&claude_dir).expect("create claude dir");

    // Pre-existing settings.json with user fields aris must NOT clobber.
    let prior = serde_json::json!({
        "model": "gpt-5.5",
        "env": {"FOO": "bar"},
        "permissions": {"defaultMode": "dontAsk"},
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "echo user-hook"}
                    ]
                }
            ]
        }
    });
    let settings_path = claude_dir.join("settings.json");
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&prior).unwrap(),
    )
    .expect("write prior settings.json");

    deploy_meta_opt_hooks_to(&home, &cache_dir).expect("deploy should succeed");

    let merged: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("read settings.json"))
            .expect("settings.json parses");

    // User fields survived
    assert_eq!(
        merged.pointer("/model").and_then(|v| v.as_str()),
        Some("gpt-5.5"),
        "model field must be preserved"
    );
    assert_eq!(
        merged.pointer("/env/FOO").and_then(|v| v.as_str()),
        Some("bar"),
        "env.FOO must be preserved"
    );
    assert_eq!(
        merged
            .pointer("/permissions/defaultMode")
            .and_then(|v| v.as_str()),
        Some("dontAsk"),
        "permissions.defaultMode must be preserved"
    );

    // Existing PreToolUse user hook survived intact
    let pre_arr = merged
        .pointer("/hooks/PreToolUse")
        .and_then(|v| v.as_array())
        .expect("hooks.PreToolUse array");
    assert_eq!(pre_arr.len(), 1, "user PreToolUse not duplicated");
    let pre_cmd = pre_arr[0]
        .pointer("/hooks/0/command")
        .and_then(|v| v.as_str())
        .expect("PreToolUse command");
    assert_eq!(pre_cmd, "echo user-hook");

    // New PostToolUse / SessionEnd hooks were added
    assert!(merged.pointer("/hooks/PostToolUse").is_some());
    assert!(merged.pointer("/hooks/SessionEnd").is_some());

    // Backup file exists alongside (best-effort, but should be present here)
    let mut backup_count = 0usize;
    for entry in std::fs::read_dir(&claude_dir).expect("read claude dir") {
        let e = entry.expect("dir entry");
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("settings.json.bak.") {
            backup_count += 1;
        }
    }
    assert!(backup_count >= 1, "expected a settings.json.bak.* backup");

    std::fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn deploy_meta_opt_hooks_idempotent_doesnt_dupe_on_second_run() {
    let root = meta_opt_test_root();
    let cache_dir = write_fake_cache(&root);
    let home = root.join("home");
    std::fs::create_dir_all(&home).expect("create home");

    deploy_meta_opt_hooks_to(&home, &cache_dir).expect("first deploy");
    deploy_meta_opt_hooks_to(&home, &cache_dir).expect("second deploy idempotent");

    let settings_path = home.join(".claude").join("settings.json");
    let merged: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("read settings.json"))
            .expect("settings.json parses");

    // Each event should still have exactly one log_event matcher entry.
    for event in [
        "PostToolUse",
        "PostToolUseFailure",
        "UserPromptSubmit",
        "SessionStart",
    ] {
        let arr = merged
            .pointer(&format!("/hooks/{event}"))
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("hooks.{event} array missing"));
        assert_eq!(
            arr.len(),
            1,
            "{event} should have exactly 1 matcher entry after 2 deploys, got {}",
            arr.len()
        );
    }

    // SessionEnd has 2 entries (log_event + check_ready); they must NOT
    // grow on the second deploy.
    let session_end = merged
        .pointer("/hooks/SessionEnd")
        .and_then(|v| v.as_array())
        .expect("hooks.SessionEnd array");
    assert_eq!(
        session_end.len(),
        2,
        "SessionEnd should have exactly 2 matcher entries after 2 deploys"
    );

    std::fs::remove_dir_all(&root).expect("cleanup");
}

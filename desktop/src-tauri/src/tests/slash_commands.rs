use super::{
    render_slash_command_help, resume_supported_slash_commands, slash_command_specs, SlashCommand,
};

#[test]
fn parses_supported_slash_commands() {
    assert_eq!(SlashCommand::parse("/help"), Some(SlashCommand::Help));
    assert_eq!(SlashCommand::parse(" /status "), Some(SlashCommand::Status));
    assert_eq!(
        SlashCommand::parse("/compact keep exact file paths"),
        Some(SlashCommand::Compact {
            instruction: Some("keep exact file paths".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/bughunter runtime"),
        Some(SlashCommand::Bughunter {
            scope: Some("runtime".to_string())
        })
    );
    assert_eq!(SlashCommand::parse("/commit"), Some(SlashCommand::Commit));
    assert_eq!(
        SlashCommand::parse("/pr ready for review"),
        Some(SlashCommand::Pr {
            context: Some("ready for review".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/issue flaky test"),
        Some(SlashCommand::Issue {
            context: Some("flaky test".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/ultraplan ship both features"),
        Some(SlashCommand::Ultraplan {
            task: Some("ship both features".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/teleport conversation.rs"),
        Some(SlashCommand::Teleport {
            target: Some("conversation.rs".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/debug-tool-call"),
        Some(SlashCommand::DebugToolCall)
    );
    assert_eq!(
        SlashCommand::parse("/model claude-opus"),
        Some(SlashCommand::Model {
            model: Some("claude-opus".to_string()),
        })
    );
    assert_eq!(
        SlashCommand::parse("/model"),
        Some(SlashCommand::Model { model: None })
    );
    assert_eq!(
        SlashCommand::parse("/permissions read-only"),
        Some(SlashCommand::Permissions {
            mode: Some("read-only".to_string()),
        })
    );
    assert_eq!(
        SlashCommand::parse("/clear"),
        Some(SlashCommand::Clear { confirm: false })
    );
    assert_eq!(
        SlashCommand::parse("/clear --confirm"),
        Some(SlashCommand::Clear { confirm: true })
    );
    assert_eq!(SlashCommand::parse("/cost"), Some(SlashCommand::Cost));
    assert_eq!(
        SlashCommand::parse("/resume session.json"),
        Some(SlashCommand::Resume {
            session_path: Some("session.json".to_string()),
        })
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
        SlashCommand::parse("/memory approve mem-1"),
        Some(SlashCommand::Memory {
            action: Some("approve".to_string()),
            target: Some("mem-1".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/goal replace ship durable continuity"),
        Some(SlashCommand::Goal {
            action: Some("replace".to_string()),
            objective: Some("ship durable continuity".to_string())
        })
    );
    assert_eq!(SlashCommand::parse("/init"), Some(SlashCommand::Init));
    assert_eq!(SlashCommand::parse("/diff"), Some(SlashCommand::Diff));
    assert_eq!(SlashCommand::parse("/version"), Some(SlashCommand::Version));
    assert_eq!(
        SlashCommand::parse("/export notes with spaces.txt"),
        Some(SlashCommand::Export {
            path: Some("notes with spaces.txt".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/export-debug-zip bug report.zip"),
        Some(SlashCommand::ExportDebugZip {
            path: Some("bug report.zip".to_string())
        })
    );
    assert_eq!(
        SlashCommand::parse("/session switch abc123"),
        Some(SlashCommand::Session {
            action: Some("switch".to_string()),
            target: Some("abc123".to_string())
        })
    );
}

#[test]
fn renders_help_from_shared_specs() {
    let help = render_slash_command_help();
    assert!(help.contains("works with --resume SESSION.json"));
    assert!(help.contains("/help"));
    assert!(help.contains("/status"));
    assert!(help.contains("/compact [instruction]"));
    assert!(help.contains("/bughunter [scope]"));
    assert!(help.contains("/commit"));
    assert!(help.contains("/pr [context]"));
    assert!(help.contains("/issue [context]"));
    assert!(help.contains("/ultraplan [task]"));
    assert!(help.contains("/teleport <symbol-or-path>"));
    assert!(help.contains("/debug-tool-call"));
    assert!(help.contains("/model [model]"));
    assert!(help.contains("/reviewer [model]"));
    assert!(help.contains("/permissions [read-only|workspace-write|danger-full-access]"));
    assert!(help.contains("/clear [--confirm]"));
    assert!(help.contains("/cost"));
    assert!(help.contains("/resume <session-path>"));
    assert!(help.contains("/config [env|hooks|model]"));
    assert!(help.contains("/memory"));
    assert!(help.contains("/goal"));
    assert!(help.contains("/init"));
    assert!(help.contains("/diff"));
    assert!(help.contains("/version"));
    assert!(help.contains("/export [file]"));
    assert!(help.contains("/export-debug-zip [file]"));
    assert!(
        help.contains("/session [list|search <query>|switch <session-id>|timeline [session-id]]")
    );
    assert_eq!(slash_command_specs().len(), 30);
    assert_eq!(resume_supported_slash_commands().len(), 13);
}

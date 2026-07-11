use super::{
    PermissionMode, PermissionOutcome, PermissionPolicy, PermissionPromptDecision,
    PermissionPrompter, PermissionRequest,
};

struct RecordingPrompter {
    seen: Vec<PermissionRequest>,
    allow: bool,
}

impl PermissionPrompter for RecordingPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision {
        self.seen.push(request.clone());
        if self.allow {
            PermissionPromptDecision::Allow
        } else {
            PermissionPromptDecision::Deny {
                reason: "not now".to_string(),
            }
        }
    }
}

#[test]
fn allows_tools_when_active_mode_meets_requirement() {
    let policy = PermissionPolicy::new(PermissionMode::WorkspaceWrite)
        .with_tool_requirement("read_file", PermissionMode::ReadOnly)
        .with_tool_requirement("write_file", PermissionMode::WorkspaceWrite);

    assert_eq!(
        policy.authorize("read_file", "{}", None),
        PermissionOutcome::Allow
    );
    assert_eq!(
        policy.authorize("write_file", "{}", None),
        PermissionOutcome::Allow
    );
}

#[test]
fn denies_read_only_escalations_without_prompt() {
    let policy = PermissionPolicy::new(PermissionMode::ReadOnly)
        .with_tool_requirement("write_file", PermissionMode::WorkspaceWrite)
        .with_tool_requirement("bash", PermissionMode::DangerFullAccess);

    assert!(matches!(
        policy.authorize("write_file", "{}", None),
        PermissionOutcome::Deny { reason } if reason.contains("requires workspace-write permission")
    ));
    assert!(matches!(
        policy.authorize("bash", "{}", None),
        PermissionOutcome::Deny { reason } if reason.contains("requires danger-full-access permission")
    ));
}

#[test]
fn prompts_for_workspace_write_to_danger_full_access_escalation() {
    let policy = PermissionPolicy::new(PermissionMode::WorkspaceWrite)
        .with_tool_requirement("bash", PermissionMode::DangerFullAccess);
    let mut prompter = RecordingPrompter {
        seen: Vec::new(),
        allow: true,
    };

    let outcome = policy.authorize("bash", "echo hi", Some(&mut prompter));

    assert_eq!(outcome, PermissionOutcome::Allow);
    assert_eq!(prompter.seen.len(), 1);
    assert_eq!(prompter.seen[0].tool_name, "bash");
    assert_eq!(
        prompter.seen[0].current_mode,
        PermissionMode::WorkspaceWrite
    );
    assert_eq!(
        prompter.seen[0].required_mode,
        PermissionMode::DangerFullAccess
    );
}

#[test]
fn honors_prompt_rejection_reason() {
    let policy = PermissionPolicy::new(PermissionMode::WorkspaceWrite)
        .with_tool_requirement("bash", PermissionMode::DangerFullAccess);
    let mut prompter = RecordingPrompter {
        seen: Vec::new(),
        allow: false,
    };

    assert!(matches!(
        policy.authorize("bash", "echo hi", Some(&mut prompter)),
        PermissionOutcome::Deny { reason } if reason == "not now"
    ));
}

#[test]
fn prompt_mode_routes_through_prompter_for_every_tool_not_silent_allow() {
    // Regression: PermissionMode derives Ord with Prompt > DangerFullAccess,
    // so `current_mode >= required_mode` previously short-circuited Prompt
    // mode to Allow — the opposite of "ask the user". This test pins
    // the fixed behavior.
    let policy = PermissionPolicy::new(PermissionMode::Prompt)
        .with_tool_requirement("read_file", PermissionMode::ReadOnly)
        .with_tool_requirement("bash", PermissionMode::DangerFullAccess);
    let mut prompter = RecordingPrompter {
        seen: Vec::new(),
        allow: false,
    };

    // Even ReadOnly-required tools must hit the prompter under Prompt mode.
    let outcome = policy.authorize("read_file", "{}", Some(&mut prompter));
    assert!(
        matches!(outcome, PermissionOutcome::Deny { .. }),
        "Prompt mode must route through prompter for ReadOnly tools, not silently Allow"
    );
    assert_eq!(prompter.seen.len(), 1, "prompter must be invoked");
    assert_eq!(prompter.seen[0].current_mode, PermissionMode::Prompt);

    // And the same for DangerFullAccess-required tools.
    let outcome = policy.authorize("bash", "rm -rf /", Some(&mut prompter));
    assert!(matches!(outcome, PermissionOutcome::Deny { .. }));
    assert_eq!(prompter.seen.len(), 2);
}

#[test]
fn prompt_mode_with_no_prompter_denies_instead_of_silently_allowing() {
    // Companion regression: when Prompt is the active mode and no prompter
    // is supplied (e.g. headless / scripted runs), the request must Deny,
    // not Allow. Pre-fix it silently Allowed.
    let policy = PermissionPolicy::new(PermissionMode::Prompt)
        .with_tool_requirement("bash", PermissionMode::DangerFullAccess);
    let outcome = policy.authorize("bash", "echo hi", None);
    assert!(
        matches!(outcome, PermissionOutcome::Deny { .. }),
        "Prompt mode without a prompter must Deny, not silently Allow"
    );
}

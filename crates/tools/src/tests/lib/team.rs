use super::*;

#[test]
fn team_state_tracks_members_tasks_mailbox_and_completion() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("team-state");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");
    std::env::set_var("ARIS_PERMISSION_MODE", "workspace-write");
    std::env::set_var("ARIS_ALLOWED_TOOLS", "read_file,grep_search,ListTeam");

    let prepared = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: None,
        team_name: Some("Ship Team".to_string()),
        team_design: Some(team_state::TeamDesignContract {
            rationale: "The audit needs a bounded teammate plus lead-side verification."
                .to_string(),
            coordination_pattern: "lead-coordinator-with-specialized-teammate".to_string(),
            coordinator: "lead-session".to_string(),
            context_policy:
                "The lead passes only the relevant files and expects structured handoff notes."
                    .to_string(),
            verification_plan:
                "The lead checks the audit result against persisted team state and events."
                    .to_string(),
            stop_condition:
                "Stop when the audit deliverable satisfies all criteria and is recorded."
                    .to_string(),
            max_teammates: Some(4),
        }),
        lead_session: None,
        description: "Audit implementation".to_string(),
        prompt: "Inspect the code and report findings.".to_string(),
        subagent_type: Some("Explore".to_string()),
        role: Some("implementation-auditor".to_string()),
        responsibility: Some(
            "Inspect the requested implementation surface and report concrete findings."
                .to_string(),
        ),
        context_scope: Some(
            "Use only files and run-state records relevant to this team-state smoke test."
                .to_string(),
        ),
        deliverable: Some(
            "A concise implementation audit report for the lead session.".to_string(),
        ),
        success_criteria: Some(vec![
            "The report names the inspected coordination state artifacts.".to_string(),
            "The report avoids modifying unrelated workspace files.".to_string(),
        ]),
        stop_condition: Some(
            "Stop after the implementation audit result is complete and recorded.".to_string(),
        ),
        name: Some("audit".to_string()),
        model: None,
        task_id: None,
        task_title: None,
        dependencies: None,
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect("teammate should prepare");

    let snapshot = team_state::register_spawned_agent(
        &prepared,
        team_state::AgentRecord {
            agent_id: "agent-1".to_string(),
            name: "audit".to_string(),
            description: "Audit implementation".to_string(),
            subagent_type: Some("Explore".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            status: "running".to_string(),
            output_file: dir.join("agent-1.md").display().to_string(),
            manifest_file: dir.join("agent-1.json").display().to_string(),
        },
    )
    .expect("agent should register");
    assert_eq!(snapshot.team.name, "Ship Team");
    assert_eq!(snapshot.team.members.len(), 1);
    assert_eq!(
        snapshot
            .team
            .design
            .as_ref()
            .map(|design| design.coordinator.as_str()),
        Some("lead-session")
    );
    assert_eq!(
        snapshot.team.members[0].role.as_deref(),
        Some("implementation-auditor")
    );
    assert_eq!(
        snapshot.tasks[0].status,
        team_state::TeamTaskStatus::InProgress
    );
    let premature_dependent = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: Some(prepared.team_id.clone()),
        team_name: Some("Ship Team".to_string()),
        team_design: None,
        lead_session: None,
        description: "Verify audit result".to_string(),
        prompt: "Verify the audit result after the audit task completes.".to_string(),
        subagent_type: Some("Verification".to_string()),
        role: Some("audit-verifier".to_string()),
        responsibility: Some(
            "Verify the completed audit result against the persisted run-state records."
                .to_string(),
        ),
        context_scope: Some(
            "Use only the completed audit output and this team-state smoke test run-state."
                .to_string(),
        ),
        deliverable: Some("A concise verification report for the completed audit.".to_string()),
        success_criteria: Some(vec![
            "The verifier waits until the prerequisite audit task is complete.".to_string(),
            "The report names any mismatch between the audit result and run-state.".to_string(),
        ]),
        stop_condition: Some(
            "Stop after verification is complete and the report is handed back.".to_string(),
        ),
        name: Some("verify-audit".to_string()),
        model: None,
        task_id: Some("verify-audit".to_string()),
        task_title: Some("Verify audit result".to_string()),
        dependencies: Some(vec![prepared.task_id.clone()]),
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect_err("dependent teammate should not spawn before prerequisites complete");
    assert!(
        premature_dependent.contains("unmet dependencies"),
        "unexpected dependency error: {premature_dependent}"
    );

    let message = team_state::send_message(team_state::SendMessageInput {
        team_id: Some(prepared.team_id.clone()),
        from: prepared.member_id.clone(),
        to: "lead".to_string(),
        subject: Some("status".to_string()),
        body: "audit started".to_string(),
        task_id: Some(prepared.task_id.clone()),
    })
    .expect("message should send");
    assert_eq!(message.team_id, prepared.team_id);

    let claimed = team_state::claim_task(team_state::ClaimTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: Some(prepared.task_id.clone()),
        claimant: prepared.member_id.clone(),
        lease_seconds: Some(30),
    })
    .expect("same member should renew lease");
    assert_eq!(
        claimed.claimed_by.as_deref(),
        Some(prepared.member_id.as_str())
    );

    let completed = team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: prepared.member_id.clone(),
        result: "no issues".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect("task should complete");
    assert_eq!(
        completed.tasks[0].status,
        team_state::TeamTaskStatus::Completed
    );
    assert_eq!(completed.mailbox.len(), 1);
    let duplicate = team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: "lead".to_string(),
        result: "overwrite attempt".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect_err("terminal task result must not be overwritten");
    assert!(
        duplicate.contains("refusing to overwrite"),
        "unexpected duplicate completion error: {duplicate}"
    );
    let snapshot = team_state::list_team(team_state::ListTeamInput {
        team_id: Some(prepared.team_id.clone()),
        include_messages: Some(true),
        include_events: Some(true),
    })
    .expect("snapshot should load");
    assert_eq!(snapshot.tasks[0].result.as_deref(), Some("no issues"));
    assert_eq!(
        snapshot.tasks[0]
            .events
            .iter()
            .filter(|event| event.kind == "TaskCompleted")
            .count(),
        1
    );

    // step 3: record an independent verification verdict and confirm it
    // round-trips through persisted task state and logs an event.
    let verified = team_state::record_verification(
        &prepared.team_id,
        &prepared.task_id,
        team_state::TaskVerification {
            status: team_state::VerificationStatus::Passed,
            reviewer: Some("gpt-5.5".to_string()),
            summary: "GO".to_string(),
            verified_at: 0,
        },
    )
    .expect("verification should record");
    assert_eq!(
        verified.verification.as_ref().map(|v| v.status),
        Some(team_state::VerificationStatus::Passed)
    );
    let snapshot = team_state::list_team(team_state::ListTeamInput {
        team_id: Some(prepared.team_id.clone()),
        include_messages: Some(false),
        include_events: Some(true),
    })
    .expect("snapshot should reload");
    assert_eq!(
        snapshot.tasks[0].verification.as_ref().map(|v| v.status),
        Some(team_state::VerificationStatus::Passed)
    );
    assert_eq!(
        snapshot.tasks[0]
            .events
            .iter()
            .filter(|event| event.kind == "TaskVerified")
            .count(),
        1
    );

    // step 4: the /team view renders the live team state.
    let view =
        team_state::render_team_view(Some(&prepared.team_id)).expect("team view should render");
    assert!(view.contains("Ship Team"), "view missing team name: {view}");
    assert!(
        view.contains("verified \u{2713}"),
        "view missing verification glyph: {view}"
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    std::env::remove_var("ARIS_PERMISSION_MODE");
    std::env::remove_var("ARIS_ALLOWED_TOOLS");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn wait_for_teammates_settles_and_times_out() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("wait-team");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");

    let prepared = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: None,
        team_name: Some("Wait Team".to_string()),
        team_design: Some(team_state::TeamDesignContract {
            rationale: "Need one bounded teammate plus lead-side verification.".to_string(),
            coordination_pattern: "lead-fan-out".to_string(),
            coordinator: "lead-session".to_string(),
            context_policy: "Lead passes only the relevant slice.".to_string(),
            verification_plan: "Lead checks the result against run-state.".to_string(),
            stop_condition: "Stop when the deliverable meets all criteria.".to_string(),
            max_teammates: Some(4),
        }),
        lead_session: None,
        description: "Do the thing".to_string(),
        prompt: "Do the thing and report.".to_string(),
        subagent_type: Some("Explore".to_string()),
        role: Some("worker".to_string()),
        responsibility: Some("Do the one delegated thing and report findings.".to_string()),
        context_scope: Some("Only the files relevant to this wait smoke test.".to_string()),
        deliverable: Some("A concise report for the lead.".to_string()),
        success_criteria: Some(vec![
            "The report states what was done.".to_string(),
            "The report avoids touching unrelated files.".to_string(),
        ]),
        stop_condition: Some("Stop after the report is recorded.".to_string()),
        name: Some("worker".to_string()),
        model: None,
        task_id: None,
        task_title: None,
        dependencies: None,
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect("teammate should prepare");

    // While the task is in progress, a short wait returns timed-out and unsettled.
    let timed = team_state::wait_for_teammates(team_state::WaitForTeammatesInput {
        team_id: Some(prepared.team_id.clone()),
        task_ids: None,
        timeout_seconds: Some(1),
        poll_interval_seconds: Some(1),
    })
    .expect("wait should return");
    assert!(!timed.all_settled, "in-progress task must not be settled");
    assert!(timed.timed_out, "short wait should time out");
    assert_eq!(timed.pending, 1);

    // Once the task completes, the wait returns immediately with the result.
    team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: prepared.member_id.clone(),
        result: "done".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect("task should complete");

    let settled = team_state::wait_for_teammates(team_state::WaitForTeammatesInput {
        team_id: Some(prepared.team_id.clone()),
        task_ids: None,
        timeout_seconds: Some(30),
        poll_interval_seconds: Some(1),
    })
    .expect("wait should return");
    assert!(settled.all_settled, "completed task should be settled");
    assert!(!settled.timed_out);
    assert_eq!(settled.pending, 0);
    assert_eq!(settled.tasks.len(), 1);
    assert_eq!(settled.tasks[0].result.as_deref(), Some("done"));
    assert_eq!(
        settled.tasks[0].status,
        team_state::TeamTaskStatus::Completed
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn parse_review_verdict_classifies_go_and_no_go() {
    use team_state::VerificationStatus;
    assert_eq!(
        team_state::parse_review_verdict("Looks solid overall. Verdict: GO"),
        VerificationStatus::Passed
    );
    assert_eq!(
        team_state::parse_review_verdict("Acceptable with caveats. GO-WITH-NITS"),
        VerificationStatus::Passed
    );
    assert_eq!(
        team_state::parse_review_verdict("Criteria not met. NO-GO."),
        VerificationStatus::Failed
    );
    assert_eq!(
        team_state::parse_review_verdict("This NEEDS-REWORK before it can land."),
        VerificationStatus::Failed
    );
    // "NO-GO" contains "GO" but must classify as Failed, not Passed.
    assert_eq!(
        team_state::parse_review_verdict("Strong NO-GO from me."),
        VerificationStatus::Failed
    );
    // No recognizable verdict token -> defer to the lead.
    assert_eq!(
        team_state::parse_review_verdict("Some thoughts, but no clear verdict here."),
        VerificationStatus::NeedsJudgment
    );
}

#[test]
fn workflow_requires_approval_and_can_complete_without_agents() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("workflow-state");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");
    let script = "emitPhase(\"synthesis\")\nsaveResult(\"final report\")";

    let plan = execute_tool(
        "Workflow",
        &json!({
            "action": "plan",
            "script": script
        }),
    )
    .expect("plan should succeed");
    let plan_json: serde_json::Value = serde_json::from_str(&plan).expect("valid plan json");
    assert_eq!(plan_json["plan"]["phases"][0], "synthesis");

    let approval_required = execute_tool(
        "Workflow",
        &json!({
            "action": "start",
            "script": script
        }),
    )
    .expect("unapproved start should persist approval-required run");
    let approval_json: serde_json::Value =
        serde_json::from_str(&approval_required).expect("valid approval json");
    assert_eq!(approval_json["action"], "approval_required");

    let started = execute_tool(
        "Workflow",
        &json!({
            "action": "start",
            "name": "quick-check",
            "script": script,
            "approval": "allow_once"
        }),
    )
    .expect("approved start should succeed");
    let started_json: serde_json::Value = serde_json::from_str(&started).expect("valid json");
    assert_eq!(started_json["run"]["status"], "completed");
    assert_eq!(started_json["run"]["result"], "final report");
    assert_eq!(
        started_json["run"]["completedCache"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Debug)]
struct MockSubagentApiClient {
    calls: usize,
    input_path: String,
}

impl runtime::ApiClient for MockSubagentApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.calls += 1;
        match self.calls {
            1 => {
                assert_eq!(request.messages.len(), 1);
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read_file".to_string(),
                        input: json!({ "path": self.input_path }).to_string(),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
            2 => {
                assert!(request.messages.len() >= 3);
                Ok(vec![
                    AssistantEvent::TextDelta("Scope: completed mock review".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
            _ => panic!("unexpected mock stream call"),
        }
    }
}

#[test]
fn subagent_runtime_executes_tool_loop_with_isolated_session() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("subagent-input.txt");
    std::fs::write(&path, "hello from child").expect("write input file");
    let _workspace_root = EnvGuard::set(
        ARIS_WORKSPACE_ROOT_ENV,
        path.parent().expect("temporary file parent"),
    );

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        MockSubagentApiClient {
            calls: 0,
            input_path: path.display().to_string(),
        },
        SubagentToolExecutor::new(BTreeSet::from([String::from("read_file")])),
        agent_permission_policy(),
        vec![String::from("system prompt")],
    );

    let summary = runtime
        .run_turn("Inspect the delegated file", None)
        .expect("subagent loop should succeed");

    assert_eq!(
        final_assistant_text(&summary),
        "Scope: completed mock review"
    );
    assert!(runtime
        .session()
        .messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .any(|block| matches!(
            block,
            runtime::ContentBlock::ToolResult { output, .. }
                if output.contains("hello from child")
        )));

    let _ = std::fs::remove_file(path);
}

#[test]
fn final_assistant_text_keeps_all_nonempty_text_iterations() {
    let summary = TurnSummary {
        assistant_messages: vec![
            ConversationMessage::assistant(vec![
                ContentBlock::Text {
                    text: "Preparing review.".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read_file".to_string(),
                    input: "{}".to_string(),
                },
            ]),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Review complete.".to_string(),
            }]),
        ],
        tool_results: Vec::new(),
        iterations: 2,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    assert_eq!(
        final_assistant_text(&summary),
        "Preparing review.\n\nReview complete."
    );
}

#[test]
fn agent_rejects_blank_required_fields() {
    let missing_description = execute_tool(
        "Agent",
        &json!({
            "description": "  ",
            "prompt": "Inspect"
        }),
    )
    .expect_err("blank description should fail");
    assert!(missing_description.contains("description must not be empty"));

    let missing_prompt = execute_tool(
        "Agent",
        &json!({
            "description": "Inspect branch",
            "prompt": " "
        }),
    )
    .expect_err("blank prompt should fail");
    assert!(missing_prompt.contains("prompt must not be empty"));
}

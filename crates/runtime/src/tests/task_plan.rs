use super::{TaskPlanCompletion, MAX_PLAN_CONTINUATIONS};
use crate::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, ConversationRuntime,
    EvidenceGuardMode, PermissionMode, PermissionPolicy, RuntimeError, Session, StaticToolExecutor,
    ToolError, ToolExecutor,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

fn result(name: &str, output: Value, is_error: bool) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id: "result".to_string(),
        tool_name: name.to_string(),
        output: output.to_string(),
        is_error,
    }
}

fn plan(status: &str) -> Value {
    json!([{"content": "Verify the revised file", "activeForm": "Verifying the revised file", "status": status}])
}

fn plan_result(status: &str) -> ContentBlock {
    result("TodoWrite", json!({"newTodos": plan(status)}), false)
}

fn tool(name: &str, input: Value) -> Vec<AssistantEvent> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT_TOOL_ID: AtomicUsize = AtomicUsize::new(0);
    vec![
        AssistantEvent::ToolUse {
            id: format!(
                "call-{name}-{}",
                NEXT_TOOL_ID.fetch_add(1, Ordering::Relaxed)
            ),
            name: name.to_string(),
            input: input.to_string(),
        },
        AssistantEvent::MessageStop,
    ]
}

fn answer(text: &str) -> Vec<AssistantEvent> {
    vec![
        AssistantEvent::TextDelta(text.to_string()),
        AssistantEvent::MessageStop,
    ]
}

#[derive(Clone)]
struct ScriptedClient {
    replies: VecDeque<Vec<AssistantEvent>>,
    requests: Arc<Mutex<Vec<ApiRequest>>>,
}

impl ApiClient for ScriptedClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.requests.lock().unwrap().push(request);
        self.replies
            .pop_front()
            .ok_or_else(|| RuntimeError::new("unexpected extra provider request"))
    }
}

fn scripted_runtime(
    replies: Vec<Vec<AssistantEvent>>,
) -> (
    ConversationRuntime<ScriptedClient, StaticToolExecutor>,
    Arc<Mutex<Vec<ApiRequest>>>,
) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let executor = StaticToolExecutor::new()
        .register("TodoWrite", |input| {
            let value: Value = serde_json::from_str(input).unwrap();
            Ok(json!({"newTodos": value["todos"]}).to_string())
        })
        .register("read_file", |_| Ok("verified current file".to_string()))
        .register("read_long_file", |_| Ok("file evidence ".repeat(1_000)))
        .register("failed_action", |_| {
            Err(ToolError::new("permission denied"))
        });
    let runtime = ConversationRuntime::new(
        Session::new(),
        ScriptedClient {
            replies: replies.into(),
            requests: requests.clone(),
        },
        executor,
        PermissionPolicy::new(PermissionMode::Allow),
        Vec::new(),
    )
    .with_evidence_guard_mode(EvidenceGuardMode::Off)
    .with_focus_nudge(false);
    (runtime, requests)
}

fn is_plan_check(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("(incomplete_task_plan)"))
    })
}

#[test]
fn task_plan_premature_answer_continues_through_verification_and_plan_update() {
    let (mut runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("in_progress")})),
        answer("The revision is ready; verification is next."),
        tool("read_file", json!({"path": "main.tex"})),
        tool("TodoWrite", json!({"todos": plan("completed")})),
        answer("The revision has been verified."),
    ]);
    let summary = runtime
        .run_turn("Revise and verify the file", None)
        .unwrap();
    assert_eq!(summary.iterations, 5);
    let requests = requests.lock().unwrap();
    let check = requests[2].messages.last().unwrap();
    assert!(is_plan_check(check));
    assert!(crate::compact::is_internal_user_message(check));
    let mut interrupted = Session::new();
    interrupted
        .messages
        .push(ConversationMessage::user_text("Revise the file"));
    interrupted.messages.push(check.clone());
    crate::strip_trailing_internal_continuation_messages(&mut interrupted);
    assert_eq!(interrupted.messages.len(), 1);
    assert!(summary.tool_results.iter().any(|message| {
        message.blocks.iter().any(|block| {
            matches!(block, ContentBlock::ToolResult { tool_name, is_error: false, .. } if tool_name == "read_file")
        })
    }));
}

#[test]
fn task_plan_changed_phase_rearms_the_completion_check() {
    let (mut runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("pending")})),
        answer("I will verify it next."),
        tool("TodoWrite", json!({"todos": plan("in_progress")})),
        answer("Verification is in progress."),
        tool("TodoWrite", json!({"todos": plan("completed")})),
        answer("Verified."),
    ]);
    runtime.run_turn("Verify it", None).unwrap();
    let requests = requests.lock().unwrap();
    assert!(is_plan_check(requests[2].messages.last().unwrap()));
    assert!(is_plan_check(requests[4].messages.last().unwrap()));
    assert_eq!(requests.len(), 6);
}

#[test]
fn task_plan_blocker_or_planning_only_answer_does_not_loop_without_progress() {
    for explanation in [
        "Please provide the missing input file.",
        "Here is the requested plan; execution has not started.",
    ] {
        let (mut runtime, requests) = scripted_runtime(vec![
            tool("TodoWrite", json!({"todos": plan("pending")})),
            answer("The steps are prepared."),
            answer(explanation),
        ]);
        runtime.run_turn("Prepare the task", None).unwrap();
        assert_eq!(requests.lock().unwrap().len(), 3);
    }
}

#[test]
fn task_plan_failed_actions_do_not_rearm_the_check_or_get_replayed() {
    let (mut runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("pending")})),
        answer("The step is pending."),
        tool("failed_action", json!({})),
        answer("Permission was denied; the step remains pending."),
    ]);
    let summary = runtime.run_turn("Verify the file", None).unwrap();
    assert_eq!(requests.lock().unwrap().len(), 4);
    assert_eq!(summary.tool_results.len(), 2);
}

#[test]
fn task_plan_check_yields_to_the_delivery_budget() {
    let (runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("pending")})),
        answer("The runtime budget is exhausted; verification remains open."),
    ]);
    let mut runtime = runtime.with_max_iterations(1);
    runtime.run_turn("Verify the file", None).unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests
        .iter()
        .flat_map(|request| &request.messages)
        .any(is_plan_check));
}

#[test]
fn task_plan_automatic_continuation_respects_manual_stop() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct CancelDuringAnswer {
        calls: Arc<AtomicUsize>,
        cancelled: Arc<AtomicBool>,
    }
    impl ApiClient for CancelDuringAnswer {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                Ok(tool("TodoWrite", json!({"todos": plan("pending")})))
            } else {
                self.cancelled.store(true, Ordering::SeqCst);
                Ok(answer("The unfinished work is preserved."))
            }
        }
    }
    struct CancellableTools(Arc<AtomicBool>);
    impl ToolExecutor for CancellableTools {
        fn execute(&mut self, _name: &str, _input: &str) -> Result<String, ToolError> {
            Ok(json!({"newTodos": plan("pending")}).to_string())
        }
        fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        CancelDuringAnswer {
            calls: calls.clone(),
            cancelled: cancelled.clone(),
        },
        CancellableTools(cancelled),
        PermissionPolicy::new(PermissionMode::Allow),
        Vec::new(),
    )
    .with_focus_nudge(false);
    assert!(runtime
        .run_turn("Verify the file", None)
        .unwrap_err()
        .is_interrupted());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn task_plan_from_a_previous_turn_does_not_restart_on_an_unrelated_question() {
    let (mut runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("pending")})),
        answer("The file is missing."),
        answer("Please provide it to continue."),
        answer("This formula measures squared error."),
    ]);
    runtime.run_turn("Verify the file", None).unwrap();
    runtime.run_turn("Explain this formula", None).unwrap();
    assert_eq!(requests.lock().unwrap().len(), 4);
}

#[test]
fn task_plan_successful_empty_snapshot_clears_unfinished_steps() {
    let (mut runtime, requests) = scripted_runtime(vec![
        tool("TodoWrite", json!({"todos": plan("pending")})),
        tool("TodoWrite", json!({"todos": []})),
        answer("The plan was cleared."),
    ]);
    runtime.run_turn("Replace the obsolete plan", None).unwrap();
    assert_eq!(requests.lock().unwrap().len(), 3);
}

#[test]
fn task_plan_check_survives_compaction_of_the_original_snapshot() {
    let mut replies = vec![tool("TodoWrite", json!({"todos": plan("pending")}))];
    for _ in 0..12 {
        replies.push(tool("read_long_file", json!({"path": "main.tex"})));
    }
    replies.extend([
        answer("The file was read; verification is still next."),
        tool("TodoWrite", json!({"todos": plan("completed")})),
        answer("Verified."),
    ]);
    let (runtime, requests) = scripted_runtime(replies);
    let mut runtime = runtime.with_context_compaction_estimated_tokens_threshold(600);
    let summary = runtime.run_turn("Verify the file", None).unwrap();
    assert!(summary
        .auto_compaction
        .is_some_and(|event| event.removed_message_count > 0));
    let requests = requests.lock().unwrap();
    let check_request = &requests[14];
    assert!(is_plan_check(check_request.messages.last().unwrap()));
    assert!(!check_request.messages.iter().any(|message| {
        message.blocks.iter().any(|block| {
            matches!(block, ContentBlock::ToolResult { tool_name, .. } if tool_name == "TodoWrite")
        })
    }));
    assert_eq!(requests.len(), 16);
}

#[test]
fn task_plan_hook_feedback_does_not_hide_or_replace_the_successful_snapshot() {
    let mut completion = TaskPlanCompletion::default();
    let mut block = plan_result("pending");
    if let ContentBlock::ToolResult { output, .. } = &mut block {
        output.push_str("\n\nHook feedback:\nChecked tool output.\n{\"newTodos\": []}");
    }
    completion.observe(&block);
    assert!(completion
        .next_check()
        .unwrap()
        .contains("1 of 1 steps open"));
}

#[test]
fn task_plan_only_successful_valid_canonical_results_change_completion_state() {
    let mut completion = TaskPlanCompletion::default();
    completion.observe(&result(
        "TodoWrite",
        json!({"newTodos": plan("pending")}),
        true,
    ));
    assert!(completion.next_check().is_none());
    completion.observe(&plan_result("pending"));
    completion.observe(&result(
        "TodoWrite",
        json!({"newTodos": plan("completed")}),
        true,
    ));
    completion.observe(&result(
        "TodoWrite",
        json!({"newTodos": [{"content": "bad"}]}),
        false,
    ));
    assert!(completion
        .next_check()
        .unwrap()
        .contains("1 of 1 steps open"));
    completion.observe(&result(
        "TodoWrite",
        json!({"new_todos": plan("completed")}),
        false,
    ));
    assert!(completion.next_check().is_none());
}

#[test]
fn task_plan_continuations_are_bounded_even_when_tools_keep_succeeding() {
    let mut completion = TaskPlanCompletion::default();
    completion.observe(&plan_result("in_progress"));
    for _ in 0..MAX_PLAN_CONTINUATIONS {
        assert!(completion.next_check().is_some());
        completion.observe(&result("read_file", json!({"content": "same file"}), false));
    }
    assert!(completion.next_check().is_none());
}

#[test]
fn task_plan_unchanged_updates_and_tool_search_do_not_rearm_a_stalled_check() {
    let mut completion = TaskPlanCompletion::default();
    completion.observe(&plan_result("pending"));
    assert!(completion.next_check().is_some());
    completion.observe(&plan_result("pending"));
    completion.observe(&result(
        "ToolSearch",
        json!({"tools": ["read_file"]}),
        false,
    ));
    assert!(completion.next_check().is_none());
}

#[test]
fn task_plan_reopened_step_rearms_even_when_it_matches_an_earlier_snapshot() {
    let mut completion = TaskPlanCompletion::default();
    completion.observe(&plan_result("pending"));
    assert!(completion.next_check().is_some());
    completion.observe(&plan_result("completed"));
    assert!(completion.next_check().is_none());
    completion.observe(&plan_result("pending"));
    assert!(completion.next_check().is_some());
    assert!(completion.next_check().is_none());
}

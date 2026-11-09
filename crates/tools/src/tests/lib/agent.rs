use super::*;

#[test]
fn legacy_agent_requires_a_bound_controller() {
    let error =
        execute_tool("Agent", &json!({"description":"audit", "prompt":"check"})).unwrap_err();
    assert!(error.contains("session-bound AgentControl"));
}

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
        PermissionPolicy::new(PermissionMode::ReadOnly)
            .with_tool_requirement("read_file", PermissionMode::ReadOnly),
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
fn collaboration_cannot_bypass_the_host_through_any_action() {
    for name in crate::collaboration::ACTIONS {
        assert!(
            execute_tool(name, &json!({}))
                .unwrap_err()
                .contains("session-bound AgentControl"),
            "{name}"
        );
    }
}

use super::{
    assistant_output_looks_degenerate, assistant_text_from_turn_summary, build_assistant_message,
    is_internal_continuation_message, parse_auto_compaction_threshold,
    strip_trailing_internal_continuation_messages, ApiClient, ApiRequest, AssistantEvent,
    ConversationRuntime, RuntimeError, StaticToolExecutor, ToolError, ToolExecutor, TurnSummary,
    DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD,
};
use crate::compact::CompactionTokenEstimateSource;
// The CLI's Opus 4.8 to 4.7 fallback keys off this flag.
#[test]
fn runtime_error_model_unavailable_flag() {
    assert!(!RuntimeError::new("boom").is_model_unavailable());
    assert!(RuntimeError::model_unavailable("model x not found").is_model_unavailable());
}

#[test]
fn turn_summary_assistant_text_keeps_nonempty_text_from_each_iteration() {
    let summary = TurnSummary {
        assistant_messages: vec![
            ConversationMessage::assistant(vec![
                ContentBlock::Text {
                    text: "Checking files.".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read_file".to_string(),
                    input: "{}".to_string(),
                },
            ]),
            ConversationMessage::assistant(vec![
                ContentBlock::Thinking {
                    thinking: "private reasoning".to_string(),
                    signature: String::new(),
                },
                ContentBlock::Text {
                    text: "Fix complete.".to_string(),
                },
            ]),
        ],
        tool_results: Vec::new(),
        iterations: 2,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    assert_eq!(
        assistant_text_from_turn_summary(&summary),
        "Checking files.\n\nFix complete."
    );
}

#[test]
fn turn_summary_assistant_text_falls_back_to_thinking_only_output() {
    let summary = TurnSummary {
        assistant_messages: vec![ConversationMessage::assistant(vec![
            ContentBlock::Thinking {
                thinking: "Visible answer streamed as reasoning_content.".to_string(),
                signature: String::new(),
            },
        ])],
        tool_results: Vec::new(),
        iterations: 1,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    assert_eq!(
        assistant_text_from_turn_summary(&summary),
        "Visible answer streamed as reasoning_content."
    );
}

#[test]
fn repeated_single_word_output_is_rejected() {
    let error = build_assistant_message(vec![
        AssistantEvent::TextDelta("loop ".repeat(120)),
        AssistantEvent::MessageStop,
    ])
    .expect_err("degenerate output should fail");

    assert!(error.to_string().contains("repeated text"));
}

#[test]
fn repeated_reasoning_output_is_rejected() {
    let error = build_assistant_message(vec![
        AssistantEvent::Thinking {
            thinking: "wait ".repeat(120),
            signature: String::new(),
        },
        AssistantEvent::MessageStop,
    ])
    .expect_err("degenerate reasoning output should fail");

    assert!(error.to_string().contains("repeated text"));
}

#[test]
fn repetition_guard_allows_normal_text() {
    let normal = vec![ContentBlock::Text {
        text: "Context context context matters, but this sentence has enough variety to be a normal explanation.".to_string(),
    }];
    assert!(!assistant_output_looks_degenerate(&normal));

    let numeric_table = vec![ContentBlock::Text {
        text: "0 ".repeat(120),
    }];
    assert!(!assistant_output_looks_degenerate(&numeric_table));
}

use crate::compact::CompactionConfig;
use crate::config::{RuntimeFeatureConfig, RuntimeHookConfig};
use crate::permissions::{
    PermissionMode, PermissionPolicy, PermissionPromptDecision, PermissionPrompter,
    PermissionRequest,
};
use crate::prompt::{ProjectContext, SystemPromptBuilder};
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};
use crate::usage::TokenUsage;
use std::path::PathBuf;

struct ScriptedApiClient {
    call_count: usize,
}

impl ApiClient for ScriptedApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.call_count += 1;
        match self.call_count {
            1 => {
                assert!(request
                    .messages
                    .iter()
                    .any(|message| message.role == MessageRole::User));
                Ok(vec![
                    AssistantEvent::TextDelta("Let me calculate that.".to_string()),
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "add".to_string(),
                        input: "2,2".to_string(),
                    },
                    AssistantEvent::Usage(TokenUsage {
                        input_tokens: 20,
                        output_tokens: 6,
                        cache_creation_input_tokens: 1,
                        cache_read_input_tokens: 2,
                    }),
                    AssistantEvent::MessageStop,
                ])
            }
            2 => {
                let last_message = request
                    .messages
                    .last()
                    .expect("tool result should be present");
                assert_eq!(last_message.role, MessageRole::Tool);
                Ok(vec![
                    AssistantEvent::TextDelta("The answer is 4.".to_string()),
                    AssistantEvent::Usage(TokenUsage {
                        input_tokens: 24,
                        output_tokens: 4,
                        cache_creation_input_tokens: 1,
                        cache_read_input_tokens: 3,
                    }),
                    AssistantEvent::MessageStop,
                ])
            }
            _ => Err(RuntimeError::new("unexpected extra API call")),
        }
    }
}

struct PromptAllowOnce;

impl PermissionPrompter for PromptAllowOnce {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision {
        assert_eq!(request.tool_name, "add");
        PermissionPromptDecision::Allow
    }
}

#[test]
fn runs_user_to_tool_to_result_loop_end_to_end_and_tracks_usage() {
    let api_client = ScriptedApiClient { call_count: 0 };
    let tool_executor = StaticToolExecutor::new().register("add", |input| {
        let total = input
            .split(',')
            .map(|part| part.parse::<i32>().expect("input must be valid integer"))
            .sum::<i32>();
        Ok(total.to_string())
    });
    let permission_policy = PermissionPolicy::new(PermissionMode::WorkspaceWrite);
    let system_prompt = SystemPromptBuilder::new()
        .with_project_context(ProjectContext {
            cwd: PathBuf::from("/tmp/project"),
            current_date: "2026-03-31".to_string(),
            git_status: None,
            git_diff: None,
            directory_tree: None,
            instruction_files: Vec::new(),
        })
        .with_os("linux", "6.8")
        .build();
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        api_client,
        tool_executor,
        permission_policy,
        system_prompt,
    );

    let summary = runtime
        .run_turn("what is 2 + 2?", Some(&mut PromptAllowOnce))
        .expect("conversation loop should succeed");

    assert_eq!(summary.iterations, 2);
    assert_eq!(summary.assistant_messages.len(), 2);
    assert_eq!(summary.tool_results.len(), 1);
    assert_eq!(runtime.session().messages.len(), 4);
    assert_eq!(summary.usage.output_tokens, 10);
    assert_eq!(summary.auto_compaction, None);
    assert!(matches!(
        runtime.session().messages[1].blocks[1],
        ContentBlock::ToolUse { .. }
    ));
    assert!(matches!(
        runtime.session().messages[2].blocks[0],
        ContentBlock::ToolResult {
            is_error: false,
            ..
        }
    ));
}

#[test]
fn records_denied_tool_results_when_prompt_rejects() {
    struct RejectPrompter;
    impl PermissionPrompter for RejectPrompter {
        fn decide(&mut self, _request: &PermissionRequest) -> PermissionPromptDecision {
            PermissionPromptDecision::Deny {
                reason: "not now".to_string(),
            }
        }
    }

    struct SingleCallApiClient;
    impl ApiClient for SingleCallApiClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            if request
                .messages
                .iter()
                .any(|message| message.role == MessageRole::Tool)
            {
                return Ok(vec![
                    AssistantEvent::TextDelta("I could not use the tool.".to_string()),
                    AssistantEvent::MessageStop,
                ]);
            }
            Ok(vec![
                AssistantEvent::ToolUse {
                    id: "tool-1".to_string(),
                    name: "blocked".to_string(),
                    input: "secret".to_string(),
                },
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        SingleCallApiClient,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("use the tool", Some(&mut RejectPrompter))
        .expect("conversation should continue after denied tool");

    assert_eq!(summary.tool_results.len(), 1);
    assert!(matches!(
        &summary.tool_results[0].blocks[0],
        ContentBlock::ToolResult { is_error: true, output, .. } if output == "not now"
    ));
}

#[test]
fn context_overflow_force_compacts_and_retries() {
    // First request is rejected for exceeding the model's context window;
    // the loop must force-compact the (compactable) session and retry,
    // succeeding on the second attempt.
    struct OverflowThenSucceedClient {
        calls: usize,
    }
    impl ApiClient for OverflowThenSucceedClient {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls == 1 {
                Err(RuntimeError::context_overflow(
                    "OpenAI API error 400: context window exceeds limit (2013)",
                ))
            } else {
                Ok(vec![
                    AssistantEvent::TextDelta("recovered".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
        }
    }

    // Preload enough history that compaction can actually remove messages.
    let mut session = Session::new();
    session.messages = vec![
        ConversationMessage::user_text("q1 ".repeat(50)),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "a1 ".repeat(50),
        }]),
        ConversationMessage::user_text("q2 ".repeat(50)),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "a2 ".repeat(50),
        }]),
    ];

    let mut runtime = ConversationRuntime::new(
        session,
        OverflowThenSucceedClient { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("q3", None)
        .expect("loop should recover after force-compaction");

    // Two stream attempts: overflow, then success.
    assert_eq!(summary.iterations, 2);
    assert_eq!(assistant_text_from_turn_summary(&summary), "recovered");
    // The four preloaded messages were summarized away.
    assert_eq!(
        summary
            .auto_compaction
            .expect("a compaction should have happened")
            .removed_message_count,
        4
    );
}

#[test]
fn context_overflow_compacts_a_long_active_tool_loop() {
    use std::cell::RefCell;
    use std::rc::Rc;

    struct OverflowAfterToolLoopClient {
        calls: usize,
        message_counts: Rc<RefCell<Vec<usize>>>,
        request_tokens: Rc<RefCell<Vec<usize>>>,
    }
    impl ApiClient for OverflowAfterToolLoopClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.message_counts
                .borrow_mut()
                .push(request.messages.len());
            self.request_tokens
                .borrow_mut()
                .push(crate::estimate_session_tokens(&Session {
                    version: 1,
                    messages: request.messages.clone(),
                    compactions: Vec::new(),
                }));
            self.calls += 1;
            if self.calls <= 12 {
                return Ok(vec![
                    AssistantEvent::ToolUse {
                        id: format!("tool-{}", self.calls),
                        name: "echo".to_string(),
                        input: "large diagnostic request".to_string(),
                    },
                    AssistantEvent::MessageStop,
                ]);
            }
            if self.calls == 13 {
                return Err(RuntimeError::context_overflow(
                    "context window exceeds limit after a long tool loop",
                ));
            }
            Ok(vec![
                AssistantEvent::TextDelta("recovered after compaction".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let message_counts = Rc::new(RefCell::new(Vec::new()));
    let request_tokens = Rc::new(RefCell::new(Vec::new()));
    let client = OverflowAfterToolLoopClient {
        calls: 0,
        message_counts: Rc::clone(&message_counts),
        request_tokens: Rc::clone(&request_tokens),
    };
    let tools =
        StaticToolExecutor::new().register("echo", |_| Ok("diagnostic output ".repeat(1_000)));
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        client,
        tools,
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("investigate the failure", None)
        .expect("overflow recovery should summarize the earlier active tool loop");

    let counts = message_counts.borrow();
    let tokens = request_tokens.borrow();
    assert_eq!(counts.len(), 14);
    assert_eq!(tokens.len(), 14);
    assert!(
        counts[13] < counts[12],
        "the retry must send fewer messages than the rejected request: {counts:?}"
    );
    assert!(
        tokens[13] < tokens[12],
        "the retry must send fewer tokens than the rejected request: {tokens:?}"
    );
    assert!(
        summary
            .auto_compaction
            .is_some_and(|event| event.removed_message_count > 0),
        "the active tool loop should have been compacted"
    );
}

#[test]
fn system_prompt_overhead_triggers_preflight_compaction() {
    use std::cell::Cell;
    use std::rc::Rc;

    struct InspectClient(Rc<Cell<usize>>);
    impl ApiClient for InspectClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.0.set(request.messages.len());
            Ok(vec![
                AssistantEvent::TextDelta("ok".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut session = Session::new();
    session.messages = vec![
        ConversationMessage::user_text("u".repeat(1_000)),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "a".repeat(1_000),
        }]),
        ConversationMessage::user_text("u".repeat(1_000)),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "a".repeat(1_000),
        }]),
    ];
    let seen_message_count = Rc::new(Cell::new(usize::MAX));
    let mut runtime = ConversationRuntime::new(
        session,
        InspectClient(Rc::clone(&seen_message_count)),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".repeat(500)],
    )
    .with_context_compaction_estimated_tokens_threshold(1_300);

    runtime
        .run_turn("continue", None)
        .expect("system-prompt-aware preflight compaction should succeed");
    assert!(
        seen_message_count.get() < 5,
        "system prompt overhead should trigger compaction before the request"
    );
}

#[test]
fn context_overflow_surfaces_error_when_irreducible() {
    // A single oversized turn cannot be compacted further, so the error
    // must surface instead of looping forever.
    struct AlwaysOverflowClient;
    impl ApiClient for AlwaysOverflowClient {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Err(RuntimeError::context_overflow("context length exceeded"))
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        AlwaysOverflowClient,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".to_string()],
    );

    let error = runtime
        .run_turn("only message", None)
        .expect_err("an irreducible overflow must surface");
    assert!(error.is_context_overflow());
}

#[test]
fn transient_network_errors_retry_three_times_before_success() {
    struct NetworkFlakyClient {
        calls: usize,
    }
    impl ApiClient for NetworkFlakyClient {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls <= 3 {
                Err(RuntimeError::new("connection reset by peer"))
            } else {
                Ok(vec![
                    AssistantEvent::TextDelta("recovered".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        NetworkFlakyClient { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::WorkspaceWrite),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("hello", None)
        .expect("third retry should recover a transient network failure");

    assert_eq!(assistant_text_from_turn_summary(&summary), "recovered");
    assert_eq!(summary.iterations, 4);
}

#[test]
fn runtime_error_context_overflow_flag() {
    assert!(!RuntimeError::new("boom").is_context_overflow());
    assert!(RuntimeError::context_overflow("too long").is_context_overflow());
}

#[test]
fn denies_tool_use_when_pre_tool_hook_blocks() {
    struct SingleCallApiClient;
    impl ApiClient for SingleCallApiClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            if request
                .messages
                .iter()
                .any(|message| message.role == MessageRole::Tool)
            {
                return Ok(vec![
                    AssistantEvent::TextDelta("blocked".to_string()),
                    AssistantEvent::MessageStop,
                ]);
            }
            Ok(vec![
                AssistantEvent::ToolUse {
                    id: "tool-1".to_string(),
                    name: "blocked".to_string(),
                    input: r#"{"path":"secret.txt"}"#.to_string(),
                },
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new_with_features(
        Session::new(),
        SingleCallApiClient,
        StaticToolExecutor::new().register("blocked", |_input| {
            panic!("tool should not execute when hook denies")
        }),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
        RuntimeFeatureConfig::default().with_hooks(RuntimeHookConfig::new(
            vec![shell_snippet("printf 'blocked by hook'; exit 2")],
            Vec::new(),
        )),
    );

    let summary = runtime
        .run_turn("use the tool", None)
        .expect("conversation should continue after hook denial");

    assert_eq!(summary.tool_results.len(), 1);
    let ContentBlock::ToolResult {
        is_error, output, ..
    } = &summary.tool_results[0].blocks[0]
    else {
        panic!("expected tool result block");
    };
    assert!(
        *is_error,
        "hook denial should produce an error result: {output}"
    );
    assert!(
        output.contains("denied tool") || output.contains("blocked by hook"),
        "unexpected hook denial output: {output:?}"
    );
}

#[test]
fn appends_post_tool_hook_feedback_to_tool_result() {
    struct TwoCallApiClient {
        calls: usize,
    }

    impl ApiClient for TwoCallApiClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "add".to_string(),
                        input: r#"{"lhs":2,"rhs":2}"#.to_string(),
                    },
                    AssistantEvent::MessageStop,
                ]),
                2 => {
                    assert!(request
                        .messages
                        .iter()
                        .any(|message| message.role == MessageRole::Tool));
                    Ok(vec![
                        AssistantEvent::TextDelta("done".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected extra API call")),
            }
        }
    }

    let mut runtime = ConversationRuntime::new_with_features(
        Session::new(),
        TwoCallApiClient { calls: 0 },
        StaticToolExecutor::new().register("add", |_input| Ok("4".to_string())),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
        RuntimeFeatureConfig::default().with_hooks(RuntimeHookConfig::new(
            vec![shell_snippet("printf 'pre hook ran'")],
            vec![shell_snippet("printf 'post hook ran'")],
        )),
    );

    let summary = runtime
        .run_turn("use add", None)
        .expect("tool loop succeeds");

    assert_eq!(summary.tool_results.len(), 1);
    let ContentBlock::ToolResult {
        is_error, output, ..
    } = &summary.tool_results[0].blocks[0]
    else {
        panic!("expected tool result block");
    };
    assert!(
        !*is_error,
        "post hook should preserve non-error result: {output:?}"
    );
    assert!(
        output.contains("4"),
        "tool output missing value: {output:?}"
    );
    assert!(
        output.contains("pre hook ran"),
        "tool output missing pre hook feedback: {output:?}"
    );
    assert!(
        output.contains("post hook ran"),
        "tool output missing post hook feedback: {output:?}"
    );
}

#[test]
fn blank_terminal_message_after_tool_use_is_nudged() {
    struct ToolThenBlankApi {
        calls: usize,
    }

    impl ApiClient for ToolThenBlankApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(vec![
                    AssistantEvent::TextDelta("I will inspect that first.".to_string()),
                    AssistantEvent::ToolUse {
                        id: "probe-1".to_string(),
                        name: "probe".to_string(),
                        input: "{}".to_string(),
                    },
                    AssistantEvent::MessageStop,
                ]),
                2 => Ok(vec![
                    AssistantEvent::StopReason("end_turn".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                3 => {
                    assert!(request.messages.iter().any(|message| {
                        message.blocks.iter().any(|block| {
                            matches!(block, ContentBlock::Text { text }
                                if text.starts_with("Your latest assistant message is empty"))
                        })
                    }));
                    assert!(request.messages.iter().any(|message| {
                        message.blocks.iter().any(|block| {
                            matches!(block, ContentBlock::Text { text }
                                if text.contains("do not repeat earlier visible answer text"))
                        })
                    }));
                    Ok(vec![
                        AssistantEvent::TextDelta("The probe completed successfully.".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected extra API call")),
            }
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        ToolThenBlankApi { calls: 0 },
        StaticToolExecutor::new().register("probe", |_| Ok("ok".to_string())),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("inspect the state", None)
        .expect("tool followed by blank terminal response should recover");
    assert_eq!(summary.iterations, 3);
    assert_eq!(
        assistant_text_from_turn_summary(&summary),
        "I will inspect that first.\n\nThe probe completed successfully."
    );
}

#[test]
fn runtime_error_keeps_user_and_partial_session_history() {
    struct FailingApi;
    impl ApiClient for FailingApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Err(RuntimeError::new(
                "provider stream failed after partial output",
            ))
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        FailingApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let error = runtime
        .run_turn("keep this request in history", None)
        .expect_err("the provider failure should surface");
    assert!(error.to_string().contains("provider stream failed"));
    assert!(runtime.session().messages.iter().any(|message| {
        message.blocks.iter().any(|block| {
            matches!(block, ContentBlock::Text { text } if text == "keep this request in history")
        })
    }));
}

#[test]
fn cancelling_mid_tool_loop_preserves_executed_results() {
    // One assistant turn asks for two tools. The executor runs the first
    // successfully, then arms cancellation so the loop is interrupted before
    // the second runs. The already-executed result must survive in the
    // session, and the un-run tool must still get an answer, so the
    // assistant/tool message pair stays valid for resumption.
    struct OneTurnTwoToolsClient {
        called: bool,
    }
    impl ApiClient for OneTurnTwoToolsClient {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            if self.called {
                return Err(RuntimeError::new("unexpected API call after interrupt"));
            }
            self.called = true;
            Ok(vec![
                AssistantEvent::ToolUse {
                    id: "tool-1".to_string(),
                    name: "first".to_string(),
                    input: "{}".to_string(),
                },
                AssistantEvent::ToolUse {
                    id: "tool-2".to_string(),
                    name: "second".to_string(),
                    input: "{}".to_string(),
                },
                AssistantEvent::MessageStop,
            ])
        }
    }

    struct CancelAfterFirstTool {
        cancel: bool,
    }
    impl ToolExecutor for CancelAfterFirstTool {
        fn execute(&mut self, tool_name: &str, _input: &str) -> Result<String, ToolError> {
            self.cancel = true;
            Ok(format!("{tool_name} output"))
        }
        fn is_cancelled(&self) -> bool {
            self.cancel
        }
    }

    let mut runtime = ConversationRuntime::new_with_features(
        Session::new(),
        OneTurnTwoToolsClient { called: false },
        CancelAfterFirstTool { cancel: false },
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
        RuntimeFeatureConfig::default(),
    );

    let result = runtime.run_turn("do two things", None);
    let error = result.expect_err("cancellation should surface as an error");
    assert!(
        error.to_string().contains("interrupted"),
        "unexpected error: {error}"
    );

    let tool_message = runtime
        .session()
        .messages
        .iter()
        .rev()
        .find(|message| message.role == MessageRole::Tool)
        .expect("interrupted turn should still record a tool-result message");
    assert_eq!(
        tool_message.blocks.len(),
        2,
        "every tool_use must be answered so the history is valid"
    );

    let ContentBlock::ToolResult {
        tool_use_id,
        output,
        is_error,
        ..
    } = &tool_message.blocks[0]
    else {
        panic!("expected first tool result block");
    };
    assert_eq!(tool_use_id, "tool-1");
    assert!(!*is_error, "executed tool result should not be an error");
    assert!(
        output.contains("first output"),
        "executed tool result must be preserved: {output:?}"
    );

    let ContentBlock::ToolResult {
        tool_use_id,
        is_error,
        ..
    } = &tool_message.blocks[1]
    else {
        panic!("expected second tool result block");
    };
    assert_eq!(tool_use_id, "tool-2");
    assert!(
        *is_error,
        "the un-run tool must receive a synthetic interrupted result"
    );
}

#[test]
fn reconstructs_usage_tracker_from_restored_session() {
    struct SimpleApi;
    impl ApiClient for SimpleApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut session = Session::new();
    session
        .messages
        .push(crate::session::ConversationMessage::assistant_with_usage(
            vec![ContentBlock::Text {
                text: "earlier".to_string(),
            }],
            Some(TokenUsage {
                input_tokens: 11,
                output_tokens: 7,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 1,
            }),
        ));

    let runtime = ConversationRuntime::new(
        session,
        SimpleApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    assert_eq!(runtime.usage().turns(), 1);
    assert_eq!(runtime.usage().cumulative_usage().total_tokens(), 21);
}

#[test]
fn compacts_session_after_turns() {
    struct SimpleApi;
    impl ApiClient for SimpleApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        SimpleApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );
    runtime.run_turn("a", None).expect("turn a");
    runtime.run_turn("b", None).expect("turn b");
    runtime.run_turn("c", None).expect("turn c");

    let result = runtime.compact(CompactionConfig {
        preserve_recent_messages: 2,
        max_estimated_tokens: 1,
        ..CompactionConfig::default()
    });
    assert!(result.summary.contains("## Current Focus"));
    assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
}

#[cfg(windows)]
fn shell_snippet(script: &str) -> String {
    script
        .replace("printf '", "echo ")
        .replace("'; exit ", " & exit /b ")
        .replace('\'', "")
}

#[cfg(not(windows))]
fn shell_snippet(script: &str) -> String {
    script.to_string()
}

#[test]
fn auto_compacts_when_latest_input_threshold_is_crossed_and_history_near_budget() {
    struct SimpleApi;
    impl ApiClient for SimpleApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::Usage(TokenUsage {
                    input_tokens: 120_000,
                    output_tokens: 4,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let session = Session {
        version: 1,
        messages: vec![
            crate::session::ConversationMessage::user_text("one ".repeat(700)),
            crate::session::ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "two ".repeat(700),
            }]),
            crate::session::ConversationMessage::user_text("three ".repeat(700)),
            crate::session::ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "four ".repeat(700),
            }]),
        ],
        compactions: Vec::new(),
    };

    let mut runtime = ConversationRuntime::new(
        session,
        SimpleApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_auto_compaction_input_tokens_threshold(100_000)
    .with_context_compaction_estimated_tokens_threshold(4_000);

    let summary = runtime
        .run_turn("trigger", None)
        .expect("turn should succeed");

    let compaction = summary.auto_compaction.expect("compaction should fire");
    assert_eq!(compaction.removed_message_count, 2);
    assert!(compaction.tokens_after > 0);
    assert_eq!(
        compaction.token_estimate_source,
        CompactionTokenEstimateSource::Heuristic
    );
    assert_eq!(runtime.session().messages[0].role, MessageRole::User);
}

#[test]
fn high_fixed_prompt_usage_does_not_compact_tiny_history_every_turn() {
    struct LargeFixedPromptApi;
    impl ApiClient for LargeFixedPromptApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::Usage(TokenUsage {
                    input_tokens: 120_000,
                    output_tokens: 4,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        LargeFixedPromptApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["large fixed system/tool prompt".to_string()],
    )
    .with_auto_compaction_input_tokens_threshold(100_000)
    .with_context_compaction_estimated_tokens_threshold(150_000);

    for index in 0..3 {
        let summary = runtime
            .run_turn(format!("short turn {index}"), None)
            .expect("turn should succeed");
        assert_eq!(summary.auto_compaction, None, "turn {index} compacted");
    }
}

#[test]
fn skips_auto_compaction_below_threshold() {
    struct SimpleApi;
    impl ApiClient for SimpleApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::Usage(TokenUsage {
                    input_tokens: 99_999,
                    output_tokens: 4,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        SimpleApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_auto_compaction_input_tokens_threshold(100_000);

    let summary = runtime
        .run_turn("trigger", None)
        .expect("turn should succeed");
    assert_eq!(summary.auto_compaction, None);
    assert_eq!(runtime.session().messages.len(), 2);
}

/// Regression for the cumulative-sum bug: many turns whose individual
/// prompts are each well under the budget must NOT trigger compaction, even
/// though the *sum* of their input tokens crosses it many times over. The
/// signal is the latest prompt size, not the running total.
#[test]
fn does_not_compact_from_summed_input_across_many_small_turns() {
    struct SmallTurnApi;
    impl ApiClient for SmallTurnApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta("ok".to_string()),
                AssistantEvent::Usage(TokenUsage {
                    input_tokens: 1_000,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        SmallTurnApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_auto_compaction_input_tokens_threshold(100_000)
    // Isolate the input-token signal — keep the estimate path well clear.
    .with_context_compaction_estimated_tokens_threshold(usize::MAX);

    // 200 × 1_000 = 200k cumulative input — twice the threshold — yet each
    // individual prompt is only 1_000 tokens, so nothing should compact.
    for index in 0..200 {
        let summary = runtime
            .run_turn(format!("turn-{index}"), None)
            .expect("turn succeeds");
        assert_eq!(summary.auto_compaction, None, "turn {index} compacted");
    }
}

#[test]
fn auto_compaction_threshold_defaults_and_parses_values() {
    assert_eq!(
        parse_auto_compaction_threshold(None),
        DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD
    );
    assert_eq!(parse_auto_compaction_threshold(Some("4321")), 4321);
    assert_eq!(
        parse_auto_compaction_threshold(Some("not-a-number")),
        DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD
    );
}

#[test]
fn output_limit_continues_instead_of_stopping_the_task() {
    struct OutputLimitedApi {
        calls: usize,
    }

    impl ApiClient for OutputLimitedApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls == 1 {
                return Ok(vec![
                    AssistantEvent::TextDelta(
                        (0..2_000)
                            .map(|index| {
                                format!("partial segment {index} keeps varied continuation context")
                            })
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    AssistantEvent::StopReason("max_tokens".to_string()),
                    AssistantEvent::MessageStop,
                ]);
            }
            assert!(request.messages.iter().any(|message| {
                message.role == MessageRole::User
                    && message.blocks.iter().any(|block| {
                        matches!(block, ContentBlock::Text { text } if text.contains("Continue the unfinished task"))
                    })
            }));
            Ok(vec![
                AssistantEvent::TextDelta("finished".to_string()),
                AssistantEvent::StopReason("end_turn".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        OutputLimitedApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("do the whole task", None)
        .expect("task continues");
    assert_eq!(summary.iterations, 2);
    assert!(matches!(
        &summary.assistant_messages.last().unwrap().blocks[0],
        ContentBlock::Text { text } if text == "finished"
    ));
}

#[test]
fn truncated_tool_call_is_retried_without_executing_partial_json() {
    struct TruncatedToolApi {
        calls: usize,
    }

    impl ApiClient for TruncatedToolApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(vec![
                    AssistantEvent::StopReason("stream_truncated".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                2 => {
                    assert!(request
                        .messages
                        .iter()
                        .any(is_internal_continuation_message));
                    Ok(vec![
                        AssistantEvent::ToolUse {
                            id: "complete-tool".to_string(),
                            name: "count".to_string(),
                            input: r#"{"complete":true}"#.to_string(),
                        },
                        AssistantEvent::MessageStop,
                    ])
                }
                3 => Ok(vec![
                    AssistantEvent::TextDelta("done".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                _ => Err(RuntimeError::new("unexpected call")),
            }
        }
    }

    let executions = std::rc::Rc::new(std::cell::Cell::new(0));
    let executions_for_tool = std::rc::Rc::clone(&executions);
    let mut runtime = ConversationRuntime::new(
        Session::new(),
        TruncatedToolApi { calls: 0 },
        StaticToolExecutor::new().register("count", move |input| {
            assert_eq!(input, r#"{"complete":true}"#);
            executions_for_tool.set(executions_for_tool.get() + 1);
            Ok("ok".to_string())
        }),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    runtime
        .run_turn("use the tool", None)
        .expect("task recovers");
    assert_eq!(executions.get(), 1);
}

#[test]
fn stripping_trailing_internal_prompts_keeps_real_turn_history() {
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("real user request"));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "partial but useful answer".to_string(),
        }]));
    session.messages.push(ConversationMessage::user_text(
        "Continue the unfinished task from the exact point where the previous response stopped (length).",
    ));
    session.messages.push(ConversationMessage::user_text(
        "Your previous response contained no visible text. Continue now.",
    ));
    session.messages.push(ConversationMessage::user_text(
        "Your latest assistant message is empty. Continue now.",
    ));

    strip_trailing_internal_continuation_messages(&mut session);

    assert_eq!(session.messages.len(), 2);
    assert!(matches!(
        &session.messages[0].blocks[0],
        ContentBlock::Text { text } if text == "real user request"
    ));
    assert!(matches!(
        &session.messages[1].blocks[0],
        ContentBlock::Text { text } if text == "partial but useful answer"
    ));
}

#[test]
fn bounds_large_tool_results_and_shrinks_consumed_results() {
    struct ToolLoopApi {
        calls: usize,
    }

    impl ApiClient for ToolLoopApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 | 2 => Ok(vec![
                    AssistantEvent::ToolUse {
                        id: format!("tool-{}", self.calls),
                        name: "huge".to_string(),
                        input: "x".repeat(500_000),
                    },
                    AssistantEvent::MessageStop,
                ]),
                3 => {
                    let outputs = request
                        .messages
                        .iter()
                        .flat_map(|message| message.blocks.iter())
                        .filter_map(|block| match block {
                            ContentBlock::ToolResult { output, .. } => Some(output),
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(outputs.len(), 2);
                    assert!(outputs[0].chars().count() <= 16_000);
                    assert!(outputs[1].chars().count() <= 64_000);
                    let inputs = request
                        .messages
                        .iter()
                        .flat_map(|message| message.blocks.iter())
                        .filter_map(|block| match block {
                            ContentBlock::ToolUse { input, .. } => Some(input),
                            _ => None,
                        })
                        .collect::<Vec<_>>();
                    assert!(inputs.iter().all(|input| input.chars().count() <= 8_000));
                    assert!(inputs
                        .iter()
                        .all(|input| serde_json::from_str::<serde_json::Value>(input).is_ok()));
                    Ok(vec![
                        AssistantEvent::TextDelta("done".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected call")),
            }
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        ToolLoopApi { calls: 0 },
        StaticToolExecutor::new().register("huge", |_| Ok("x".repeat(500_000))),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    runtime
        .run_turn("run tools", None)
        .expect("tool loop succeeds");
    assert!(runtime.session().messages.iter().all(|message| {
        message.blocks.iter().all(|block| match block {
            ContentBlock::ToolResult { output, .. } => output.chars().count() <= 64_000,
            _ => true,
        })
    }));
}

/// Regression guard for "limits too strong": while the session stays under
/// the compaction threshold, an already-consumed tool result and a
/// completed tool input must NOT be retroactively shrunk. Only the fresh
/// per-result cap (applied at execution time) may apply.
#[test]
fn under_budget_sessions_keep_consumed_context_intact() {
    struct TwoStepApi {
        calls: usize,
    }

    impl ApiClient for TwoStepApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "modest".to_string(),
                        // ~12k chars: above the gated input cap (8k). If the
                        // history shrink ran unconditionally it would become a
                        // placeholder; under gating + small session it stays.
                        input: format!(r#"{{"q":"{}"}}"#, "x".repeat(12_000)),
                    },
                    AssistantEvent::MessageStop,
                ]),
                2 => {
                    // The consumed tool result and the completed tool input
                    // are both still full-size — nothing was shrunk.
                    let consumed_result = request
                        .messages
                        .iter()
                        .flat_map(|message| message.blocks.iter())
                        .find_map(|block| match block {
                            ContentBlock::ToolResult { output, .. } => Some(output.clone()),
                            _ => None,
                        })
                        .expect("tool result present");
                    assert!(
                        consumed_result.chars().count() >= 20_000,
                        "consumed result was shrunk while under budget: {}",
                        consumed_result.chars().count()
                    );
                    let input = request
                        .messages
                        .iter()
                        .flat_map(|message| message.blocks.iter())
                        .find_map(|block| match block {
                            ContentBlock::ToolUse { input, .. } => Some(input.clone()),
                            _ => None,
                        })
                        .expect("tool input present");
                    assert!(
                        !input.contains("_aris_compacted"),
                        "tool input was replaced while under budget"
                    );
                    Ok(vec![
                        AssistantEvent::TextDelta("done".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected call")),
            }
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        TwoStepApi { calls: 0 },
        // 20k-char result: below the fresh 64k cap, so it enters the session
        // verbatim and must stay that way while the session is small.
        StaticToolExecutor::new().register("modest", |_| Ok("y".repeat(20_000))),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    runtime.run_turn("do a thing", None).expect("turn succeeds");
}

#[test]
fn proactively_compacts_old_context_before_request() {
    struct CompactingApi;
    impl ApiClient for CompactingApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            assert!(request.messages.len() < 10);
            assert!(request.messages.iter().any(|message| {
                message
                    .blocks
                    .iter()
                    .any(|block| matches!(block, ContentBlock::Text { text } if text == "trigger"))
            }));
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut session = Session::new();
    for index in 0..20 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "old-{index} {}",
                "x".repeat(500)
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "y".repeat(500),
            }]));
    }
    let mut runtime = ConversationRuntime::new(
        session,
        CompactingApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000);

    let summary = runtime
        .run_turn("trigger", None)
        .expect("request fits context");
    assert!(summary.auto_compaction.is_some());
}

/// A mock that returns a canned `<summary>` block for summarization
/// requests (detected by the summarizer system prompt) and "done" for
/// normal turns. `summary_text: None` makes summarization fail so the
/// fallback path can be exercised.
struct SummaryAwareApi {
    summary_text: Option<String>,
    summary_output_tokens: Option<u32>,
    /// When set, attached to summary responses so the quality gate's
    /// truncation check can be exercised (e.g. `Some("max_tokens")`).
    stop_reason: Option<String>,
}
impl ApiClient for SummaryAwareApi {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let is_summary_request = request
            .system_prompt
            .iter()
            .any(|p| p.contains("compacting a long coding-assistant conversation"));
        if is_summary_request {
            return match &self.summary_text {
                Some(text) => {
                    let mut events = vec![AssistantEvent::TextDelta(text.clone())];
                    if let Some(tokens) = self.summary_output_tokens {
                        events.push(AssistantEvent::Usage(TokenUsage {
                            output_tokens: tokens,
                            ..TokenUsage::default()
                        }));
                    }
                    if let Some(reason) = &self.stop_reason {
                        events.push(AssistantEvent::StopReason(reason.clone()));
                    }
                    events.push(AssistantEvent::MessageStop);
                    Ok(events)
                }
                None => Err(RuntimeError::new("summarizer unavailable")),
            };
        }
        Ok(vec![
            AssistantEvent::TextDelta("done".to_string()),
            AssistantEvent::MessageStop,
        ])
    }
}

fn preloaded_session_over_budget() -> Session {
    let mut session = Session::new();
    for index in 0..20 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "old-{index} {}",
                "x".repeat(500)
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "y".repeat(500),
            }]));
    }
    session
}

fn first_message_text(session: &Session) -> String {
    session
        .messages
        .first()
        .map(|message| {
            message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[test]
fn llm_summarizer_replaces_text_assembly_when_attached() {
    let mut runtime = ConversationRuntime::new(
        preloaded_session_over_budget(),
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000)
    .with_summarizer(SummaryAwareApi {
        summary_text: Some(
            "<summary>\n## Current Focus\n- LLM-CONDENSED GOALS AND STATE\n</summary>".to_string(),
        ),
        summary_output_tokens: None,
        stop_reason: None,
    });

    let summary = runtime.run_turn("trigger", None).expect("turn succeeds");
    assert!(summary.auto_compaction.is_some(), "compaction must fire");

    let continuation = first_message_text(runtime.session());
    // The LLM summary text is present...
    assert!(
        continuation.contains("LLM-CONDENSED GOALS AND STATE"),
        "continuation should carry the LLM summary, got: {continuation}"
    );
    // ...and the bulky text-assembly timeline is NOT (it was replaced).
    assert!(
        !continuation.contains("Key timeline (audit only"),
        "LLM path must not emit the text-assembly timeline"
    );
}

#[test]
fn manual_compact_uses_llm_summarizer_when_attached() {
    let mut runtime = ConversationRuntime::new(
        preloaded_session_over_budget(),
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(SummaryAwareApi {
        summary_text: Some(
            "<summary>\n## Current Focus\n- MANUAL LLM SUMMARY of the compaction work\n</summary>"
                .to_string(),
        ),
        summary_output_tokens: None,
        stop_reason: None,
    });

    let result = runtime.compact(CompactionConfig {
        preserve_recent_messages: 2,
        max_estimated_tokens: 1,
        ..CompactionConfig::default()
    });

    assert!(result.summary.contains("MANUAL LLM SUMMARY"));
    assert!(!result.summary.contains("Key timeline (audit only"));
    assert!(first_message_text(runtime.session()).contains("MANUAL LLM SUMMARY"));
}

#[test]
fn compaction_uses_summarizer_output_usage_for_tokens_after() {
    let mut runtime = ConversationRuntime::new(
        preloaded_session_over_budget(),
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(SummaryAwareApi {
        summary_text: Some(
            "<summary>\n## Current Focus\n- USAGE-BACKED SUMMARY\n</summary>".to_string(),
        ),
        summary_output_tokens: Some(37),
        stop_reason: None,
    });

    let result = runtime.compact(CompactionConfig {
        preserve_recent_messages: 2,
        max_estimated_tokens: 1,
        ..CompactionConfig::default()
    });

    assert_eq!(result.summary_output_tokens, Some(37));
    assert_eq!(
        result.token_estimate_source,
        CompactionTokenEstimateSource::ProviderSummaryUsage
    );
    assert!(result.tokens_after > 37);
    // tokens_after must account for the deterministic pinned-context block that
    // was injected after the provider reported its 37 output tokens — otherwise
    // the persisted record understates the compacted summary's real size.
    assert!(
        result.tokens_after
            >= crate::compact::estimate_message_tokens(&result.compacted_session.messages[0]),
        "tokens_after ({}) must cover the assembled summary message including pinned context",
        result.tokens_after
    );
}

#[test]
fn compaction_falls_back_to_text_assembly_when_summarizer_fails() {
    let mut runtime = ConversationRuntime::new(
        preloaded_session_over_budget(),
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000)
    // Summarizer errors on every summary request → must fall back.
    .with_summarizer(SummaryAwareApi {
        summary_text: None,
        summary_output_tokens: None,
        stop_reason: None,
    });

    let summary = runtime.run_turn("trigger", None).expect("turn succeeds");
    assert!(
        summary.auto_compaction.is_some(),
        "compaction must still fire via the fallback"
    );

    let continuation = first_message_text(runtime.session());
    assert!(
        continuation.contains("Key timeline (audit only"),
        "fallback should use the text-assembly summary, got: {continuation}"
    );
}

/// Records each summary request body and how many summary calls were made, and
/// returns a scripted summary (optionally flagged truncated via `stop_reason`).
/// Serves as both the main client ("done" for normal turns) and the summarizer.
#[derive(Clone)]
struct ScriptedSummaryApi {
    summary_bodies: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
    summary_text: String,
    stop_reason: Option<String>,
}

impl ScriptedSummaryApi {
    fn new(summary_text: &str, stop_reason: Option<&str>) -> Self {
        Self {
            summary_bodies: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            summary_text: summary_text.to_string(),
            stop_reason: stop_reason.map(str::to_string),
        }
    }

    fn call_count(&self) -> usize {
        self.summary_bodies.borrow().len()
    }

    fn all_bodies(&self) -> String {
        self.summary_bodies.borrow().join("\n----\n")
    }
}

impl ApiClient for ScriptedSummaryApi {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let is_summary = request
            .system_prompt
            .iter()
            .any(|prompt| prompt.contains("compacting a long coding-assistant conversation"));
        if is_summary {
            let body = request
                .messages
                .iter()
                .flat_map(|message| message.blocks.iter())
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            self.summary_bodies.borrow_mut().push(body);
            let mut events = vec![AssistantEvent::TextDelta(self.summary_text.clone())];
            if let Some(reason) = &self.stop_reason {
                events.push(AssistantEvent::StopReason(reason.clone()));
            }
            events.push(AssistantEvent::MessageStop);
            return Ok(events);
        }
        Ok(vec![
            AssistantEvent::TextDelta("done".to_string()),
            AssistantEvent::MessageStop,
        ])
    }
}

fn session_all_text(session: &Session) -> String {
    session
        .messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            ContentBlock::ToolResult { output, .. } => Some(output.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn map_reduce_summarizes_early_content_instead_of_truncating_the_front() {
    // A removed transcript far larger than one summarizer call, with a sentinel
    // fact in the very first (oldest) message. The old drop-front bound would
    // discard it before the summarizer ran; Map-Reduce must feed it in.
    let filler = "context ".repeat(900); // ~7.2k chars per message
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(format!(
        "SENTINEL_EARLY_FACT api base is api.example.test {filler}"
    )));
    for index in 0..24 {
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("assistant {index} {filler}"),
            }]));
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "follow-up {index} {filler}"
            )));
    }

    let scripted = ScriptedSummaryApi::new(
        "<summary>\n## Current Focus\n- reduced the follow-up context work into notes\n</summary>",
        None,
    );
    let mut runtime = ConversationRuntime::new(
        session,
        scripted.clone(),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    // Small budget → preserve little → most of the transcript is removed.
    .with_context_compaction_estimated_tokens_threshold(1_000)
    .with_summarizer(scripted.clone());

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(result.removed_message_count > 0, "compaction must fire");
    assert!(
        scripted.call_count() >= 2,
        "an over-budget transcript must be summarized Map-Reduce (>1 call), got {}",
        scripted.call_count()
    );
    assert!(
        scripted.all_bodies().contains("SENTINEL_EARLY_FACT"),
        "early content must reach the summarizer instead of being truncated from the front"
    );
    assert_eq!(
        result.summary_source,
        crate::compact::CompactionSummarySource::Llm,
        "the Map-Reduce summary should be used, not a lossy fallback"
    );
    assert!(
        result.summary.contains("follow-up"),
        "pinned recent requests must reach the final summary, not just the request: {}",
        result.summary
    );
}

#[test]
fn map_reduce_handles_a_huge_transcript_without_a_lossy_cliff() {
    // A removed transcript large enough to need many Map chunks. The old code
    // gave up past a fixed chunk cap and fell back to the lossy deterministic
    // summary; hierarchical Map-Reduce must summarize it on the LLM path.
    let filler = "context ".repeat(1_000); // ~8k chars per message
    let mut session = Session::new();
    for index in 0..110 {
        session
            .messages
            .push(ConversationMessage::user_text(format!("ask {index} {filler}")));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("reply {index} {filler}"),
            }]));
    }

    let scripted = ScriptedSummaryApi::new(
        "<summary>\n## Current Focus\n- condensed the context of the asks\n</summary>",
        None,
    );
    let mut runtime = ConversationRuntime::new(
        session,
        scripted.clone(),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000)
    .with_summarizer(scripted.clone());

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(result.removed_message_count > 0, "compaction must fire");
    assert!(
        scripted.call_count() > 6,
        "a huge transcript needs many summarizer calls (>6), got {}",
        scripted.call_count()
    );
    assert_eq!(
        result.summary_source,
        crate::compact::CompactionSummarySource::Llm,
        "a huge transcript must still summarize on the LLM path, not drop to a lossy fallback"
    );
}

#[test]
fn quality_gate_rejects_truncated_summary_and_falls_back() {
    // The summarizer returns a summary flagged truncated (`max_tokens`). The
    // gate must reject it on every attempt and fall back to the deterministic
    // summary rather than accept a partial one.
    let scripted = ScriptedSummaryApi::new(
        "<summary>\n## Current Focus\n- TRUNCATED_SHOULD_NOT_APPEAR partial state\n</summary>",
        Some("max_tokens"),
    );
    let mut runtime = ConversationRuntime::new(
        preloaded_session_over_budget(),
        scripted.clone(),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(scripted.clone());

    let result = runtime.compact(CompactionConfig {
        preserve_recent_messages: 2,
        max_estimated_tokens: 1,
        ..CompactionConfig::default()
    });

    assert!(
        !result.summary.contains("TRUNCATED_SHOULD_NOT_APPEAR"),
        "a truncated summary must never be accepted into the session"
    );
    assert!(
        result.summary.contains("Key timeline (audit only"),
        "rejecting the truncated summary must fall back to the deterministic summary"
    );
}

#[test]
fn pinned_context_survives_when_the_model_summary_omits_the_latest_request() {
    // The removed range's most recent real user request carries a sentinel; the
    // model's summary omits it. Pinned re-injection must guarantee it survives.
    let filler = "detail ".repeat(300);
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(format!(
                "SENTINEL_REQUEST_ABC implement the parser {filler}"
            )),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("working on it {filler}"),
            }]),
            ConversationMessage::user_text(format!("second request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("second reply {filler}"),
            }]),
            ConversationMessage::user_text(format!("third request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("third reply {filler}"),
            }]),
        ],
        compactions: Vec::new(),
    };

    let scripted = ScriptedSummaryApi::new(
        "<summary>\n## Current Focus\n- generic summary that forgot the earliest request\n</summary>",
        None,
    );
    let mut runtime = ConversationRuntime::new(
        session,
        scripted.clone(),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(scripted.clone());

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(result.removed_message_count > 0, "compaction must fire");
    assert!(
        result.summary.contains("generic summary that forgot"),
        "the model summary should be used when it passes the gate"
    );
    assert!(
        result.summary.contains("SENTINEL_REQUEST_ABC"),
        "pinned re-injection must restore the omitted user request, got: {}",
        result.summary
    );
}

#[test]
fn preservation_keeps_at_least_the_last_two_user_turns_verbatim() {
    let filler = "work ".repeat(400);
    let mut session = Session::new();
    for index in 1..=4 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "req-{index} {filler}"
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("reply-{index} {filler}"),
            }]));
    }

    // No summarizer → deterministic summary; isolates the preservation policy.
    let mut runtime = ConversationRuntime::new(
        session,
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(result.removed_message_count > 0, "compaction must fire");

    // The preserved tail is everything after the leading continuation summary.
    let preserved_tail = result
        .compacted_session
        .messages
        .iter()
        .skip(1)
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        preserved_tail.contains("req-4") && preserved_tail.contains("req-3"),
        "the last two user turns must be preserved verbatim, got: {preserved_tail}"
    );
    assert!(
        !preserved_tail.contains("req-1"),
        "the oldest turn should have been summarized, not preserved verbatim"
    );
}

#[test]
fn repeated_compaction_preserves_the_original_request() {
    // Drive several auto-compactions and confirm the very first request is not
    // lost across rounds (the round-two near-reset failure mode).
    struct BigReplyApi;
    impl ApiClient for BigReplyApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            // Varied wording so the reply is large without tripping the
            // repeated-text degeneracy guard.
            Ok(vec![
                AssistantEvent::TextDelta(format!(
                    "progress update: {}",
                    "alpha beta gamma delta epsilon zeta eta theta ".repeat(120)
                )),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut seed = Session::new();
    seed.messages.push(ConversationMessage::user_text(
        "ORIGINAL_REQUEST_XYZ build the widget pipeline to spec".to_string(),
    ));
    seed.messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "Starting on the widget pipeline.".to_string(),
        }]));
    // Huge budget so auto/proactive compaction never fires on its own; each
    // round we grow the session and force a compaction explicitly, isolating
    // the deterministic pinned roll-forward across repeated re-summarization.
    let mut runtime = ConversationRuntime::new(
        seed,
        BigReplyApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(100_000_000);

    for round in 0..5 {
        // Grow the session past the compaction floor without auto-compacting.
        runtime
            .run_turn(format!("continue work {round} step a"), None)
            .expect("turn a succeeds");
        runtime
            .run_turn(format!("continue work {round} step b"), None)
            .expect("turn b succeeds");

        let result = runtime.compact(CompactionConfig::manual(None));
        assert!(
            result.removed_message_count > 0,
            "round {round}: a compaction should have removed messages"
        );
        assert!(
            session_all_text(runtime.session()).contains("ORIGINAL_REQUEST_XYZ"),
            "round {round}: the original request must survive repeated compaction"
        );
    }
}

#[test]
fn overflow_compaction_preserves_the_latest_user_request() {
    // A context-overflow forces the aggressive overflow path. Even there the
    // active user request must survive via the minimal pinned block.
    struct OverflowOnceApi {
        calls: usize,
    }
    impl ApiClient for OverflowOnceApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls == 1 {
                return Err(RuntimeError::context_overflow("window exceeded"));
            }
            Ok(vec![
                AssistantEvent::TextDelta("recovered".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut session = Session::new();
    for index in 0..12 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "step {index} {}",
                "detail ".repeat(50)
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("ok {index} {}", "detail ".repeat(50)),
            }]));
    }
    // The most recent pre-turn user request carries the sentinel; overflow
    // recovery preserves only a tiny active tail, so this ends up summarized.
    session.messages.push(ConversationMessage::user_text(
        "SENTINEL_OVERFLOW fix the tokenizer bug".to_string(),
    ));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "acknowledged".to_string(),
        }]));

    let mut runtime = ConversationRuntime::new(
        session,
        OverflowOnceApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    runtime
        .run_turn("continue please", None)
        .expect("overflow recovery succeeds");
    assert!(
        session_all_text(runtime.session()).contains("SENTINEL_OVERFLOW"),
        "the latest user request must survive the overflow path"
    );
}

#[test]
fn gate_rejects_a_summary_that_ignores_the_user_request() {
    // A structurally valid but content-irrelevant summary that shares no
    // vocabulary with the latest user request must be rejected by the fidelity
    // gate and fall back to the deterministic summary.
    let filler = "detail ".repeat(50);
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(format!(
                "please refactor the authentication middleware carefully {filler}"
            )),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("working {filler}"),
            }]),
            ConversationMessage::user_text(format!("second request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("second reply {filler}"),
            }]),
            ConversationMessage::user_text(format!("third request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("third reply {filler}"),
            }]),
        ],
        compactions: Vec::new(),
    };
    let scripted = ScriptedSummaryApi::new(
        "<summary>\n## Current Focus\n- vague notes concerning unrelated wombat topics zzz\n</summary>",
        None,
    );
    let mut runtime = ConversationRuntime::new(
        session,
        scripted.clone(),
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(scripted.clone());

    let result = runtime.compact(CompactionConfig::manual(None));
    assert_eq!(
        result.summary_source,
        crate::compact::CompactionSummarySource::Fallback,
        "a summary sharing no vocabulary with the latest request must be rejected"
    );
    assert!(
        !result.summary.contains("wombat"),
        "the rejected low-fidelity summary must not be used: {}",
        result.summary
    );
}

#[test]
fn coverage_failure_recovers_via_escalated_retry_before_falling_back() {
    // The model ignores the request on the first attempt but complies on the
    // escalated retry. The LLM summary must be used — no degrade to deterministic.
    struct EscalatingSummaryApi {
        plain: String,
        covering: String,
    }
    impl ApiClient for EscalatingSummaryApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            let is_summary = request
                .system_prompt
                .iter()
                .any(|p| p.contains("compacting a long coding-assistant conversation"));
            if is_summary {
                let body = request
                    .messages
                    .iter()
                    .flat_map(|m| m.blocks.iter())
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                let escalated = body.contains("CRITICAL: your summary MUST explicitly restate");
                let text = if escalated { &self.covering } else { &self.plain };
                return Ok(vec![
                    AssistantEvent::TextDelta(text.clone()),
                    AssistantEvent::MessageStop,
                ]);
            }
            Ok(vec![
                AssistantEvent::TextDelta("done".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let filler = "detail ".repeat(50);
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(format!(
                "please refactor the authentication middleware carefully {filler}"
            )),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("working {filler}"),
            }]),
            ConversationMessage::user_text(format!("second request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("second reply {filler}"),
            }]),
            ConversationMessage::user_text(format!("third request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("third reply {filler}"),
            }]),
        ],
        compactions: Vec::new(),
    };
    let mut runtime = ConversationRuntime::new(
        session,
        EscalatingSummaryApi {
            plain: "<summary>\n## Current Focus\n- generic unrelated wombat notes zzz\n</summary>"
                .to_string(),
            covering: "<summary>\n## Current Focus\n- refactor the authentication middleware as requested\n</summary>"
                .to_string(),
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_summarizer(EscalatingSummaryApi {
        plain: "<summary>\n## Current Focus\n- generic unrelated wombat notes zzz\n</summary>"
            .to_string(),
        covering: "<summary>\n## Current Focus\n- refactor the authentication middleware as requested\n</summary>"
            .to_string(),
    });

    let result = runtime.compact(CompactionConfig::manual(None));
    assert_eq!(
        result.summary_source,
        crate::compact::CompactionSummarySource::Llm,
        "the escalated retry should recover the LLM summary instead of falling back"
    );
    assert!(
        result.summary.contains("as requested"),
        "the covering (escalated) summary should be used: {}",
        result.summary
    );
}

#[test]
fn preserves_two_user_turns_through_a_tool_chain() {
    // A tool-heavy session: preservation must keep the last two user turns
    // verbatim even though tool exchanges sit between them, and must not let the
    // safe-split search move the boundary past the two-turn floor.
    let filler = "work ".repeat(120);
    let tool_turn = |request: &str| -> Vec<ConversationMessage> {
        vec![
            ConversationMessage::user_text(format!("{request} {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                id: "t".into(),
                name: "bash".into(),
                input: "{}".into(),
            }]),
            ConversationMessage::tool_result("t", "bash", "output", false),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("done {filler}"),
            }]),
        ]
    };
    let mut messages = Vec::new();
    messages.extend(tool_turn("turn-1 oldest"));
    messages.extend(tool_turn("turn-2 middle"));
    messages.extend(tool_turn("turn-3 newest"));
    let session = Session {
        version: 1,
        messages,
        compactions: Vec::new(),
    };

    let mut runtime = ConversationRuntime::new(
        session,
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(result.removed_message_count > 0, "compaction must fire");
    let preserved_tail = result
        .compacted_session
        .messages
        .iter()
        .skip(1)
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        preserved_tail.contains("turn-2 middle") && preserved_tail.contains("turn-3 newest"),
        "both recent user turns must be preserved verbatim through the tool chain: {preserved_tail}"
    );
    assert!(
        !preserved_tail.contains("turn-1 oldest"),
        "the oldest turn should have been summarized"
    );
}

#[test]
fn overflow_archive_keeps_pristine_tool_content() {
    // The overflow path lossily shrinks large tool output before archiving. The
    // archive must nonetheless retain the full pristine content (recoverable via
    // search), even though the live/preserved copy is truncated.
    struct OverflowOnceApi {
        calls: usize,
    }
    impl ApiClient for OverflowOnceApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls == 1 {
                return Err(RuntimeError::context_overflow("window exceeded"));
            }
            Ok(vec![
                AssistantEvent::TextDelta("recovered".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    // A tool result larger than the consumed-result shrink cap (16k), with a
    // unique marker in the MIDDLE so the head+tail shrink would drop it.
    let big_output = format!(
        "{} PRISTINE_MIDDLE_MARKER {}",
        "data ".repeat(3_000),
        "more ".repeat(3_000)
    );
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("run the big job"));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::ToolUse {
            id: "t".into(),
            name: "bash".into(),
            input: "{}".into(),
        }]));
    session
        .messages
        .push(ConversationMessage::tool_result("t", "bash", big_output, false));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "done".into(),
        }]));
    for index in 0..6 {
        session
            .messages
            .push(ConversationMessage::user_text(format!("follow {index}")));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("ok {index}"),
            }]));
    }

    let mut runtime = ConversationRuntime::new(
        session,
        OverflowOnceApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    runtime
        .run_turn("continue", None)
        .expect("overflow recovery succeeds");

    let archived = runtime
        .session()
        .compactions
        .iter()
        .flat_map(|record| record.messages.iter())
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult { output, .. } => Some(output.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        archived.contains("PRISTINE_MIDDLE_MARKER"),
        "the archive must keep the full pristine tool output, not the shrunk copy"
    );
}

#[test]
fn pinned_context_includes_key_files_and_assistant_state() {
    let filler = "detail ".repeat(50);
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(format!(
                "edit src/parser/lexer.rs to fix the bug {filler}"
            )),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!(
                    "DECISION_MARKER refactor the tokenizer in src/parser/lexer.rs {filler}"
                ),
            }]),
            ConversationMessage::user_text(format!("second {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("second reply {filler}"),
            }]),
            ConversationMessage::user_text(format!("third {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("third reply {filler}"),
            }]),
        ],
        compactions: Vec::new(),
    };
    // Deterministic path isolates the pinned-context extraction.
    let mut runtime = ConversationRuntime::new(
        session,
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(
        result.summary.contains("src/parser/lexer.rs"),
        "key files must be pinned: {}",
        result.summary
    );
    assert!(
        result.summary.contains("DECISION_MARKER"),
        "the latest assistant decision must be pinned: {}",
        result.summary
    );
}

#[test]
fn compaction_handles_a_lone_leading_user_message() {
    // Two consecutive user messages at the head (no assistant reply between).
    // The user→user boundary must be splittable so the lead can be compacted
    // instead of blocking compaction entirely.
    let filler = "work ".repeat(200);
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(format!("LEAD_REQUEST {filler}")),
            ConversationMessage::user_text(format!("second request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("reply {filler}"),
            }]),
            ConversationMessage::user_text(format!("third request {filler}")),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("reply3 {filler}"),
            }]),
        ],
        compactions: Vec::new(),
    };
    let mut runtime = ConversationRuntime::new(
        session,
        SummaryAwareApi {
            summary_text: None,
            summary_output_tokens: None,
            stop_reason: None,
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let result = runtime.compact(CompactionConfig::manual(None));
    assert!(
        result.removed_message_count > 0,
        "a lone leading user message must be compactable, not block compaction"
    );
    assert!(
        result.summary.contains("LEAD_REQUEST"),
        "the compacted lead request must be pinned: {}",
        result.summary
    );
}

#[test]
fn bounds_oversized_user_and_assistant_text_before_requests() {
    struct TextBoundsApi {
        calls: usize,
    }
    impl ApiClient for TextBoundsApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            let text_lengths = request
                .messages
                .iter()
                .flat_map(|message| message.blocks.iter())
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.chars().count()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert!(text_lengths.iter().all(|length| *length <= 120_000));
            if self.calls == 2 {
                assert!(request.messages.iter().all(|message| {
                    message.role != MessageRole::Assistant
                        || message.blocks.iter().all(|block| match block {
                            ContentBlock::Text { text } => text.chars().count() <= 64_000,
                            _ => true,
                        })
                }));
            }
            Ok(vec![
                AssistantEvent::TextDelta(if self.calls == 1 {
                    (0..4_000)
                        .map(|index| {
                            format!(
                                "oversized assistant response segment {index} keeps varied context words for bounding"
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    "done".to_string()
                }),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        TextBoundsApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    // Incoming user text is bounded unconditionally; assistant-text
    // shrinking is gated, so drop the threshold below the carried-over
    // turn-1 size to exercise it on the turn-2 request.
    .with_context_compaction_estimated_tokens_threshold(50_000);

    runtime
        .run_turn("u".repeat(300_000), None)
        .expect("large user turn succeeds");
    runtime
        .run_turn("next", None)
        .expect("next request stays bounded");
}

#[test]
fn repeated_turns_keep_session_memory_bounded() {
    struct SimpleApi;
    impl ApiClient for SimpleApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::TextDelta(
                    (0..20)
                        .map(|index| {
                            format!(
                                "bounded memory response segment {index} keeps enough varied words"
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        SimpleApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(2_000);

    for index in 0..100 {
        runtime
            .run_turn(format!("turn-{index} {}", "x".repeat(1_000)), None)
            .expect("turn succeeds");
    }

    assert!(runtime.estimated_tokens() < 5_000);
    assert!(runtime.session().messages.len() < 20);
}

/// Regression: if the Anthropic executor receives `stop_reason: "end_turn"`
/// in a MessageDelta but the stream drops before the MessageStop event, the
/// executor now always overrides the stop_reason to "stream_truncated". This
/// ensures the conversation loop triggers a continuation instead of silently
/// returning partial output.
#[test]
fn stream_truncated_after_end_turn_triggers_continuation() {
    struct PartialThenComplete {
        calls: usize,
    }

    impl ApiClient for PartialThenComplete {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(vec![
                    // Simulates what the fixed executor emits when the
                    // stream carries MessageDelta(stop_reason: "end_turn")
                    // but drops before MessageStop arrives.
                    AssistantEvent::TextDelta("half".to_string()),
                    AssistantEvent::StopReason("stream_truncated".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                2 => {
                    assert!(request.messages.iter().any(|m| {
                        m.role == MessageRole::User
                            && m.blocks.iter().any(|b| {
                                matches!(b, ContentBlock::Text { text }
                                    if text.contains("Continue the unfinished task"))
                            })
                    }));
                    Ok(vec![
                        AssistantEvent::TextDelta("-done".to_string()),
                        AssistantEvent::StopReason("end_turn".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected extra call")),
            }
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        PartialThenComplete { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("write something", None)
        .expect("should continue after stream truncation");
    assert_eq!(summary.iterations, 2, "must have sent a continuation turn");
    let last_text = summary
        .assistant_messages
        .last()
        .unwrap()
        .blocks
        .iter()
        .find_map(|b| {
            if let ContentBlock::Text { text } = b {
                Some(text.as_str())
            } else {
                None
            }
        })
        .unwrap_or("");
    assert_eq!(last_text, "-done");
}

// ----------------------------------------------------------------------
// Silent-stop fix.
//
// A turn that ends with no visible output (blank/whitespace-only text,
// empty reasoning, a filtered/proxy `" "` finish, or a post-compaction
// "nothing to add" reply) must NOT finish silently. The loop nudges the
// model to continue; if it recovers, the real text is returned; if it
// never does, a visible placeholder is returned so the desktop emits a
// non-empty `chat-done` instead of a blank stop with no error.
// ----------------------------------------------------------------------

/// A whitespace-only reply no longer ends the turn silently: the loop
/// nudges the model to respond, and after the bounded retries are
/// exhausted it returns a visible placeholder (never empty text).
#[test]
fn persistently_blank_response_ends_with_visible_placeholder() {
    struct BlankApi {
        calls: usize,
    }
    impl ApiClient for BlankApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            // After the first blank reply every later request must carry
            // the blank-response nudge.
            if self.calls > 1 {
                assert!(
                    request.messages.iter().any(|message| {
                        message.blocks.iter().any(|block| {
                            matches!(block, ContentBlock::Text { text }
                            if text.starts_with("Your latest assistant message is empty"))
                        })
                    }),
                    "expected the blank-response continuation nudge on retry {}",
                    self.calls
                );
            }
            Ok(vec![
                // A lone whitespace delta: non-empty as a String (passes the
                // "no content" guard) but blank once trimmed for display.
                AssistantEvent::TextDelta("   \n  ".to_string()),
                AssistantEvent::StopReason("end_turn".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        BlankApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("do the task", None)
        .expect("turn returns Ok with a visible placeholder, never a silent empty stop");

    // It retried before giving up: 1 initial + MAX_BLANK_RESPONSE_CONTINUATIONS.
    assert_eq!(summary.iterations, 3);
    let text = assistant_text_from_turn_summary(&summary);
    assert!(
        !text.trim().is_empty(),
        "the turn must never finish with empty visible text"
    );
    assert!(
        text.contains("empty response"),
        "expected the visible placeholder, got: {text:?}"
    );
}

/// The key behaviour the user asked for: a blank reply makes the model
/// *keep going*. Here it returns blank once, then real text on the nudge —
/// the turn surfaces the recovered answer, not a placeholder.
#[test]
fn blank_then_real_response_recovers_with_the_model_continuing() {
    struct BlankThenRealApi {
        calls: usize,
    }
    impl ApiClient for BlankThenRealApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            if self.calls == 1 {
                return Ok(vec![
                    AssistantEvent::TextDelta(" ".to_string()),
                    AssistantEvent::StopReason("end_turn".to_string()),
                    AssistantEvent::MessageStop,
                ]);
            }
            Ok(vec![
                AssistantEvent::TextDelta("Here is the answer.".to_string()),
                AssistantEvent::StopReason("end_turn".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        BlankThenRealApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime
        .run_turn("do the task", None)
        .expect("turn succeeds");
    assert_eq!(
        summary.iterations, 2,
        "the model was nudged once and continued"
    );
    assert_eq!(
        assistant_text_from_turn_summary(&summary),
        "Here is the answer.",
        "the recovered answer should be returned, not a placeholder"
    );
}

/// Context pressure forces a real compaction; the model then replies blank
/// every time. The turn must still recover into a visible placeholder
/// rather than a silent empty stop — confirming the fix covers the
/// compaction path the user identified.
#[test]
fn compaction_then_blank_response_recovers_not_silent() {
    struct CompactThenBlankApi;
    impl ApiClient for CompactThenBlankApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            // Prove compaction actually ran: the heavy preloaded history is
            // gone, replaced by the summary continuation message.
            assert!(
                request.messages.len() < 12,
                "expected history to be compacted before the request"
            );
            assert!(
                request
                    .messages
                    .iter()
                    .any(|message| message.blocks.iter().any(|block| {
                        matches!(block, ContentBlock::Text { text }
                        if text.contains("This session is being continued"))
                    })),
                "expected the compaction continuation summary in the request"
            );
            Ok(vec![
                AssistantEvent::TextDelta(" ".to_string()),
                AssistantEvent::StopReason("end_turn".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    // Preload a large history so the context-estimate threshold is crossed
    // and `prepare_context_for_request` summarizes it away.
    let mut session = Session::new();
    for index in 0..40 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "old-{index} {}",
                "x".repeat(500)
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "y".repeat(500),
            }]));
    }

    let mut runtime = ConversationRuntime::new(
        session,
        CompactThenBlankApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000);

    let summary = runtime
        .run_turn("continue", None)
        .expect("turn returns Ok with a visible placeholder, not a silent empty stop");

    assert!(
        summary.auto_compaction.is_some(),
        "the heavy history should have been compacted"
    );
    assert!(
        !assistant_text_from_turn_summary(&summary).trim().is_empty(),
        "blank reply after compaction must recover into visible text, never a silent stop"
    );
}

/// Regression for providers that emit a terminal `end_turn` without a text
/// delta after compaction. The empty stream must enter the same continuation
/// path as a whitespace-only response, and a later turn must still be able to
/// use the compacted session and return visible text.
#[test]
fn compaction_then_empty_stream_recovers_and_next_turn_replies() {
    struct CompactThenEmptyApi {
        calls: usize,
    }

    impl ApiClient for CompactThenEmptyApi {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.calls += 1;
            assert!(
                request.messages.iter().any(|message| {
                    message.blocks.iter().any(|block| {
                        matches!(block, ContentBlock::Text { text }
                            if text.contains("This session is being continued"))
                    })
                }),
                "every request in this regression must retain the compaction continuation"
            );

            match self.calls {
                1 => Ok(vec![
                    // No TextDelta: this is the provider response shape that
                    // previously escaped the blank-response continuation path.
                    AssistantEvent::StopReason("stop".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                2 => {
                    assert!(
                        request.messages.iter().any(|message| {
                            message.blocks.iter().any(|block| {
                                matches!(block, ContentBlock::Text { text }
                                    if text.starts_with("Your latest assistant message is empty"))
                            })
                        }),
                        "empty terminal response must trigger a continuation prompt"
                    );
                    Ok(vec![
                        AssistantEvent::TextDelta("recovered after compaction".to_string()),
                        AssistantEvent::StopReason("end_turn".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                }
                3 => Ok(vec![
                    AssistantEvent::TextDelta("next turn still replies".to_string()),
                    AssistantEvent::StopReason("end_turn".to_string()),
                    AssistantEvent::MessageStop,
                ]),
                _ => Err(RuntimeError::new("unexpected extra call")),
            }
        }
    }

    let mut session = Session::new();
    for index in 0..40 {
        session
            .messages
            .push(ConversationMessage::user_text(format!(
                "old-{index} {}",
                "x".repeat(500)
            )));
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "y".repeat(500),
            }]));
    }

    let mut runtime = ConversationRuntime::new(
        session,
        CompactThenEmptyApi { calls: 0 },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
    .with_context_compaction_estimated_tokens_threshold(1_000);

    let first = runtime
        .run_turn("first request after compaction", None)
        .expect("empty terminal response should recover");
    assert_eq!(
        assistant_text_from_turn_summary(&first),
        "recovered after compaction"
    );
    assert!(first.auto_compaction.is_some());

    let second = runtime
        .run_turn("second request", None)
        .expect("a later turn must still reply after compaction");
    assert_eq!(
        assistant_text_from_turn_summary(&second),
        "next turn still replies"
    );
}

/// Contrast case / guard: a final message carrying only `Thinking` (no
/// visible text) is NOT a silent stop — the summary falls back to the
/// reasoning text, so the user still sees something. This pins the boundary
/// so a future change that drops the thinking fallback is caught here.
#[test]
fn thinking_only_final_response_is_not_a_silent_stop() {
    struct ThinkingOnlyApi;
    impl ApiClient for ThinkingOnlyApi {
        fn stream(&mut self, _request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            Ok(vec![
                AssistantEvent::Thinking {
                    thinking: "The answer streamed as reasoning content.".to_string(),
                    signature: String::new(),
                },
                AssistantEvent::StopReason("end_turn".to_string()),
                AssistantEvent::MessageStop,
            ])
        }
    }

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        ThinkingOnlyApi,
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    );

    let summary = runtime.run_turn("ask", None).expect("turn succeeds");
    assert_eq!(
        assistant_text_from_turn_summary(&summary),
        "The answer streamed as reasoning content.",
        "thinking-only output must still surface text, not a silent stop"
    );
}

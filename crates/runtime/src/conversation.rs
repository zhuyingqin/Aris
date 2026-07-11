use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

use crate::compact::{
    assemble_compacted_session_with_usage, estimate_session_tokens, plan_compaction,
    summarize_messages, CompactionConfig, CompactionResult, CompactionSummarySource,
    CompactionTokenEstimateSource,
};
use crate::config::RuntimeFeatureConfig;
use crate::event_sink::{now_iso8601, EventSink, EventType, NoopEventSink, RuntimeEvent};
use crate::hooks::{HookRunResult, HookRunner};
use crate::permissions::{PermissionOutcome, PermissionPolicy, PermissionPrompter};
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};
use crate::usage::{TokenUsage, UsageTracker};

const DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD: u32 = 200_000;
const AUTO_COMPACTION_THRESHOLD_ENV_VAR: &str = "CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS";
const DEFAULT_CONTEXT_COMPACTION_ESTIMATED_TOKENS_THRESHOLD: usize = 150_000;
const CONTEXT_COMPACTION_THRESHOLD_ENV_VAR: &str = "ARIS_CONTEXT_COMPACT_TOKENS";
const AUTO_COMPACT_SESSION_ESTIMATE_RATIO: f64 = 0.80;
/// Always-on cap applied to a tool result the moment it is produced. A tool
/// can return arbitrary megabytes; this bounds it once before it ever enters
/// the session. Generous on purpose — a normal large file read should survive.
const MAX_TOOL_RESULT_CHARS: usize = 64_000;
/// Gated cap: how far an *already-consumed* tool result is shrunk, and only
/// once the session crosses the compaction threshold. Never applied while the
/// session is comfortably within budget.
const MAX_CONSUMED_TOOL_RESULT_CHARS: usize = 16_000;
/// Gated cap: completed tool-call inputs above this are replaced with a
/// placeholder, again only under context pressure.
const MAX_CONTEXT_TOOL_INPUT_CHARS: usize = 8_000;
const MAX_CONTEXT_USER_TEXT_CHARS: usize = 120_000;
const MAX_CONTEXT_ASSISTANT_TEXT_CHARS: usize = 64_000;
const MAX_OUTPUT_LIMIT_CONTINUATIONS: usize = 8;
/// How many times a single turn may force-compact and retry after the provider
/// rejects the request for exceeding the model's context window. Bounded so an
/// irreducible oversized turn surfaces the error instead of looping forever.
const MAX_CONTEXT_OVERFLOW_RETRIES: usize = 3;
const MAX_TRANSIENT_REQUEST_RETRIES: usize = 3;
const CONTINUATION_PROMPT_PREFIX: &str =
    "Continue the unfinished task from the exact point where the previous response stopped";
/// How many times a turn that ended with no visible output at all (blank /
/// whitespace-only text, reasoning that came back empty, a filtered or proxy
/// `" "` finish, or a post-compaction "nothing to add" reply) may nudge the
/// model to actually respond before giving up. Bounded so a model that is
/// genuinely done — or repeatedly filtered — does not loop forever.
const MAX_BLANK_RESPONSE_CONTINUATIONS: usize = 2;
const BLANK_RESPONSE_PROMPT_PREFIX: &str = "Your latest assistant message is empty";
const LEGACY_BLANK_RESPONSE_PROMPT_PREFIX: &str =
    "Your previous response contained no visible text";
/// Shown as the assistant's reply when, after retries, the model still
/// produced nothing visible. Guarantees the turn returns non-empty text
/// instead of finishing silently with an empty bubble.
const BLANK_RESPONSE_PLACEHOLDER: &str = "[ARIS: the model returned an empty response and did not continue after automatic retries. It may have treated the task as already complete, or the output was filtered. Try rephrasing, or ask it to proceed.]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRequest {
    pub system_prompt: Vec<String>,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantEvent {
    TextDelta(String),
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    Usage(TokenUsage),
    StopReason(String),
    MessageStop,
}

pub trait ApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError>;

    /// Notifies the client that the session was just compacted, removing
    /// `removed_count` messages from the head. Implementations that keep
    /// per-message-index state (e.g. OpenAI executor's reasoning-content
    /// replay cache keyed by `usize` message index) must clear or remap
    /// that state — otherwise post-compaction replay aims at stale indices
    /// and the assistant sees re-injected reasoning aimed at the wrong turn.
    ///
    /// Default no-op for stateless clients (Anthropic uses thinking blocks
    /// in the session itself; no out-of-band cache).
    fn on_session_compacted(&mut self, _removed_count: usize) {}
}

pub trait ToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError>;

    fn execute_with_id(
        &mut self,
        _tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        self.execute(tool_name, input)
    }

    fn is_cancelled(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    message: String,
    interrupted: bool,
}

impl ToolError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            interrupted: false,
        }
    }

    #[must_use]
    pub fn interrupted_by_user() -> Self {
        Self {
            message: "interrupted by user".to_string(),
            interrupted: true,
        }
    }

    #[must_use]
    pub fn is_interrupted(&self) -> bool {
        self.interrupted
    }
}

impl Display for ToolError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ToolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    message: String,
    /// Set when the failure was specifically "model not available on this
    /// account" (Anthropic 404 `not_found_error`). The CLI reads this to
    /// fall back from the default Opus 4.8 to 4.7. `new()` leaves it false.
    model_unavailable: bool,
    /// Set when the provider rejected the request because the prompt exceeds
    /// the model's context window (e.g. a 400 "context window exceeds limit").
    /// The conversation loop reads this to force-compact and retry instead of
    /// failing the whole turn. `new()` leaves it false.
    context_overflow: bool,
}

impl RuntimeError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            model_unavailable: false,
            context_overflow: false,
        }
    }

    /// Construct an error flagged as "model unavailable" so the CLI can
    /// drive the default-model fallback (Opus 4.8 to 4.7).
    #[must_use]
    pub fn model_unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            model_unavailable: true,
            context_overflow: false,
        }
    }

    /// Construct an error flagged as "context window exceeded" so the
    /// conversation loop can force-compact the session and retry the request.
    #[must_use]
    pub fn context_overflow(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            model_unavailable: false,
            context_overflow: true,
        }
    }

    /// Whether this error is a "model unavailable on this account" failure.
    #[must_use]
    pub fn is_model_unavailable(&self) -> bool {
        self.model_unavailable
    }

    /// Whether the provider rejected the request for exceeding the model's
    /// context window.
    #[must_use]
    pub fn is_context_overflow(&self) -> bool {
        self.context_overflow
    }
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSummary {
    pub assistant_messages: Vec<ConversationMessage>,
    pub tool_results: Vec<ConversationMessage>,
    pub iterations: usize,
    pub usage: TokenUsage,
    pub auto_compaction: Option<AutoCompactionEvent>,
}

#[must_use]
pub fn assistant_text_from_turn_summary(summary: &TurnSummary) -> String {
    summary
        .assistant_messages
        .iter()
        .filter_map(|message| {
            let text = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            let text = text.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
            let thinking = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Thinking { thinking, .. } => Some(thinking.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            let thinking = thinking.trim();
            (!thinking.is_empty()).then(|| thinking.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoCompactionEvent {
    pub removed_message_count: usize,
    pub tokens_after: usize,
    pub token_estimate_source: CompactionTokenEstimateSource,
}

pub struct ConversationRuntime<C, T> {
    session: Session,
    api_client: C,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    max_iterations: usize,
    usage_tracker: UsageTracker,
    hook_runner: HookRunner,
    auto_compaction_input_tokens_threshold: u32,
    context_compaction_estimated_tokens_threshold: usize,
    event_sink: Box<dyn EventSink>,
    /// Optional cheap-model client used to produce a real LLM summary when the
    /// session is compacted. Same concrete type as `api_client` (in practice a
    /// second `ExecutorClient` pointed at a small model). `None` falls back to
    /// the deterministic text-assembly summary.
    summarizer: Option<C>,
}

impl<C, T> ConversationRuntime<C, T>
where
    C: ApiClient,
    T: ToolExecutor,
{
    #[must_use]
    pub fn new(
        session: Session,
        api_client: C,
        tool_executor: T,
        permission_policy: PermissionPolicy,
        system_prompt: Vec<String>,
    ) -> Self {
        Self::new_with_features(
            session,
            api_client,
            tool_executor,
            permission_policy,
            system_prompt,
            RuntimeFeatureConfig::default(),
        )
    }

    #[must_use]
    pub fn new_with_features(
        session: Session,
        api_client: C,
        tool_executor: T,
        permission_policy: PermissionPolicy,
        system_prompt: Vec<String>,
        feature_config: RuntimeFeatureConfig,
    ) -> Self {
        let usage_tracker = UsageTracker::from_session(&session);
        Self {
            session,
            api_client,
            tool_executor,
            permission_policy,
            system_prompt,
            max_iterations: usize::MAX,
            usage_tracker,
            hook_runner: HookRunner::from_feature_config(&feature_config),
            auto_compaction_input_tokens_threshold: auto_compaction_threshold_from_env(),
            context_compaction_estimated_tokens_threshold: context_compaction_threshold_from_env(),
            event_sink: Box::new(NoopEventSink),
            summarizer: None,
        }
    }

    /// Attach a cheap-model client to generate real LLM summaries on
    /// compaction. Without it, compaction uses the text-assembly summary.
    #[must_use]
    pub fn with_summarizer(mut self, summarizer: C) -> Self {
        self.summarizer = Some(summarizer);
        self
    }

    /// Attach an event sink for passive logging. Default is `NoopEventSink`.
    #[must_use]
    pub fn with_event_sink(mut self, sink: Box<dyn EventSink>) -> Self {
        self.event_sink = sink;
        self
    }

    #[must_use]
    pub fn with_max_iterations(mut self, max_iterations: usize) -> Self {
        self.max_iterations = max_iterations;
        self
    }

    #[must_use]
    pub fn with_auto_compaction_input_tokens_threshold(mut self, threshold: u32) -> Self {
        self.auto_compaction_input_tokens_threshold = threshold;
        self
    }

    #[must_use]
    pub fn with_context_compaction_estimated_tokens_threshold(mut self, threshold: usize) -> Self {
        self.context_compaction_estimated_tokens_threshold = threshold.max(1);
        self
    }

    pub fn run_turn(
        &mut self,
        user_input: impl Into<String>,
        prompter: Option<&mut dyn PermissionPrompter>,
    ) -> Result<TurnSummary, RuntimeError> {
        let user_text = user_input.into();
        self.run_turn_message(ConversationMessage::user_text(user_text), prompter)
    }

    pub fn run_turn_message(
        &mut self,
        mut user_message: ConversationMessage,
        mut prompter: Option<&mut dyn PermissionPrompter>,
    ) -> Result<TurnSummary, RuntimeError> {
        bound_incoming_user_message(&mut user_message);
        let user_text = user_message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        self.session.messages.push(user_message);

        // Emit user prompt event
        let is_slash = user_text.trim_start().starts_with('/');
        self.event_sink.emit(&RuntimeEvent {
            timestamp: now_iso8601(),
            session_id: String::new(),
            event_type: EventType::UserPrompt {
                preview: user_text,
                is_slash_command: is_slash,
            },
        });

        let mut assistant_messages = Vec::new();
        let mut tool_results = Vec::new();
        let mut iterations = 0;
        let mut output_limit_continuations = 0;
        let mut context_overflow_retries = 0;
        let mut transient_request_retries = 0;
        let mut blank_response_continuations = 0;
        let mut auto_compaction = None;

        loop {
            // Check for Ctrl+C or caller-provided cancellation between iterations.
            if self.cancellation_requested() {
                return Err(Self::interrupted_error());
            }
            iterations += 1;
            if iterations > self.max_iterations {
                return Err(RuntimeError::new(
                    "conversation loop exceeded the maximum number of iterations",
                ));
            }

            if let Some(event) = self.prepare_context_for_request() {
                merge_auto_compaction_event(&mut auto_compaction, event);
            }

            let request = ApiRequest {
                system_prompt: self.system_prompt.clone(),
                messages: self.session.messages.clone(),
            };
            let events = match self.api_client.stream(request) {
                Ok(events) => events,
                // Safety limit: the provider rejected the request because the
                // prompt exceeds the model's context window. Our local token
                // estimate can sit well under the budget while the real window
                // is much smaller (small-context proxies/models), so the
                // proactive `prepare_context_for_request` pass never fires.
                // Force-compact and retry instead of failing the whole turn.
                // Bounded so an irreducible single oversized turn still
                // surfaces the original error rather than looping forever.
                Err(error) if error.is_context_overflow() => {
                    context_overflow_retries += 1;
                    if context_overflow_retries > MAX_CONTEXT_OVERFLOW_RETRIES {
                        return Err(error);
                    }
                    match self.force_compact_for_overflow() {
                        Some(event) => {
                            if event.removed_message_count > 0 {
                                merge_auto_compaction_event(&mut auto_compaction, event);
                            }
                            continue;
                        }
                        None => return Err(error),
                    }
                }
                Err(error) if is_transient_runtime_error(&error) => {
                    transient_request_retries += 1;
                    if transient_request_retries > MAX_TRANSIENT_REQUEST_RETRIES {
                        return Err(error);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    continue;
                }
                Err(error) => return Err(error),
            };
            transient_request_retries = 0;
            let (assistant_message, usage, stop_reason) = build_assistant_message(events)?;
            if let Some(usage) = usage {
                self.usage_tracker.record(usage);
            }
            let pending_tool_uses = assistant_message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, input } => {
                        Some((id.clone(), name.clone(), input.clone()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();

            self.session.messages.push(assistant_message.clone());
            assistant_messages.push(assistant_message);

            if pending_tool_uses.is_empty() {
                if stop_reason
                    .as_deref()
                    .is_some_and(is_recoverable_stop_reason)
                {
                    output_limit_continuations += 1;
                    if output_limit_continuations > MAX_OUTPUT_LIMIT_CONTINUATIONS {
                        return Err(RuntimeError::new(format!(
                            "assistant output remained truncated after {MAX_OUTPUT_LIMIT_CONTINUATIONS} automatic continuation attempts"
                        )));
                    }
                    self.session.messages.push(ConversationMessage::user_text(
                        continuation_prompt(stop_reason.as_deref().unwrap_or("output_limit")),
                    ));
                    continue;
                }
                // Blank-output guard: the turn ended with no visible text,
                // thinking, or tool activity at all. This is the silent-stop
                // path — a whitespace-only reply, reasoning that came back
                // empty, a filtered/proxy `" "` finish, or a post-compaction
                // "nothing to add" reply. Rather than returning an empty
                // bubble with no error, nudge the model to respond; only after
                // repeated failure do we stop, and even then with a visible
                // explanation so the turn is never silent.
                if assistant_messages
                    .last()
                    .is_none_or(|message| !message_has_visible_output(message))
                {
                    blank_response_continuations += 1;
                    if blank_response_continuations > MAX_BLANK_RESPONSE_CONTINUATIONS {
                        let placeholder =
                            ConversationMessage::assistant(vec![ContentBlock::Text {
                                text: BLANK_RESPONSE_PLACEHOLDER.to_string(),
                            }]);
                        self.session.messages.push(placeholder.clone());
                        assistant_messages.push(placeholder);
                        break;
                    }
                    self.session.messages.push(ConversationMessage::user_text(
                        blank_response_continuation_prompt(),
                    ));
                    continue;
                }
                break;
            }

            // When the user cancels mid-tool-loop we must NOT throw away the
            // results of tools that already ran. Dropping them leaves the
            // freshly-pushed assistant message (which holds the `tool_use`
            // blocks) without matching `tool_result`s — a malformed history the
            // provider rejects on the next request, and the visible symptom the
            // user sees as "the model forgot it just read the file". Instead we
            // collect every executed result, synthesize an interrupted result
            // for the tool we were on plus any not-yet-reached tools (so every
            // `tool_use` is answered), flush the complete tool message into the
            // session, and only then surface the interrupt.
            let mut turn_tool_results = Vec::new();
            let mut pending_iter = pending_tool_uses.into_iter();
            let mut interrupted = false;
            for (tool_use_id, tool_name, input) in pending_iter.by_ref() {
                if self.cancellation_requested() {
                    turn_tool_results.push(Self::interrupted_tool_result(tool_use_id, tool_name));
                    interrupted = true;
                    break;
                }
                // Preserved for the interrupted-result fallback: the match arms
                // below move `tool_use_id`/`tool_name` into the result blocks.
                let interrupt_id = tool_use_id.clone();
                let interrupt_name = tool_name.clone();
                let permission_outcome = if let Some(prompt) = prompter.as_mut() {
                    self.permission_policy
                        .authorize(&tool_name, &input, Some(*prompt))
                } else {
                    self.permission_policy.authorize(&tool_name, &input, None)
                };

                // `None` means the tool was interrupted before producing a
                // result; the caller below records a synthetic interrupted
                // result and stops the loop.
                let result_blocks: Option<Vec<ContentBlock>> = match permission_outcome {
                    PermissionOutcome::Allow => {
                        if self.cancellation_requested() {
                            None
                        } else {
                            let pre_hook_result =
                                self.hook_runner.run_pre_tool_use(&tool_name, &input);
                            if pre_hook_result.is_denied() {
                                let deny_message =
                                    format!("PreToolUse hook denied tool `{tool_name}`");
                                Some(vec![ContentBlock::ToolResult {
                                    tool_use_id,
                                    tool_name,
                                    output: format_hook_message(&pre_hook_result, &deny_message),
                                    is_error: true,
                                }])
                            } else {
                                let (mut output, mut is_error) = match self
                                    .tool_executor
                                    .execute_with_id(&tool_use_id, &tool_name, &input)
                                {
                                    Ok(output) => (output, false),
                                    Err(error) if error.is_interrupted() => {
                                        turn_tool_results.push(Self::interrupted_tool_result(
                                            interrupt_id,
                                            interrupt_name,
                                        ));
                                        interrupted = true;
                                        break;
                                    }
                                    Err(error) => (error.to_string(), true),
                                };
                                output =
                                    merge_hook_feedback(pre_hook_result.messages(), output, false);

                                let post_hook_result = self
                                    .hook_runner
                                    .run_post_tool_use(&tool_name, &input, &output, is_error);
                                if post_hook_result.is_denied() {
                                    is_error = true;
                                }
                                output = merge_hook_feedback(
                                    post_hook_result.messages(),
                                    output,
                                    post_hook_result.is_denied(),
                                );
                                output = bound_tool_result(output, MAX_TOOL_RESULT_CHARS);

                                // Emit tool call event
                                if tool_name == "Skill" {
                                    // Parse skill name from input JSON for dedicated event
                                    let skill_name =
                                        serde_json::from_str::<serde_json::Value>(&input)
                                            .ok()
                                            .and_then(|v| {
                                                v.get("skill")
                                                    .and_then(|s| s.as_str().map(String::from))
                                            })
                                            .unwrap_or_default();
                                    let skill_args =
                                        serde_json::from_str::<serde_json::Value>(&input)
                                            .ok()
                                            .and_then(|v| {
                                                v.get("args")
                                                    .and_then(|s| s.as_str().map(String::from))
                                            })
                                            .unwrap_or_default();
                                    self.event_sink.emit(&RuntimeEvent {
                                        timestamp: now_iso8601(),
                                        session_id: String::new(),
                                        event_type: EventType::SkillInvoke {
                                            skill_name,
                                            args: skill_args,
                                        },
                                    });
                                }
                                self.event_sink.emit(&RuntimeEvent {
                                    timestamp: now_iso8601(),
                                    session_id: String::new(),
                                    event_type: EventType::ToolCall {
                                        tool_name: tool_name.clone(),
                                        input_summary: input.chars().take(200).collect(),
                                        is_error,
                                    },
                                });

                                Some(vec![ContentBlock::ToolResult {
                                    tool_use_id,
                                    tool_name,
                                    output,
                                    is_error,
                                }])
                            }
                        }
                    }
                    PermissionOutcome::Deny { reason } => Some(vec![ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output: reason,
                        is_error: true,
                    }]),
                };
                if let Some(blocks) = result_blocks {
                    turn_tool_results.extend(blocks);
                } else {
                    turn_tool_results
                        .push(Self::interrupted_tool_result(interrupt_id, interrupt_name));
                    interrupted = true;
                    break;
                }
            }
            // Cancellation broke out mid-loop: answer every tool_use we never
            // reached so the assistant/tool message pair stays well-formed.
            if interrupted {
                for (tool_use_id, tool_name, _input) in pending_iter {
                    turn_tool_results.push(Self::interrupted_tool_result(tool_use_id, tool_name));
                }
            }
            if !turn_tool_results.is_empty() {
                let result_message = ConversationMessage {
                    role: MessageRole::Tool,
                    blocks: turn_tool_results,
                    usage: None,
                };
                self.session.messages.push(result_message.clone());
                tool_results.push(result_message);
            }
            // The interrupted turn is now fully recorded in the session
            // (assistant tool_use + complete tool_result message); surface the
            // interrupt to the caller.
            if interrupted {
                return Err(Self::interrupted_error());
            }
        }

        if let Some(event) = self.maybe_auto_compact() {
            merge_auto_compaction_event(&mut auto_compaction, event);
        }

        Ok(TurnSummary {
            assistant_messages,
            tool_results,
            iterations,
            usage: self.usage_tracker.cumulative_usage(),
            auto_compaction,
        })
    }

    pub fn compact(&mut self, config: CompactionConfig) -> CompactionResult {
        let Some(plan) = plan_compaction(&self.session, &config) else {
            let tokens = estimate_session_tokens(&self.session);
            return CompactionResult {
                summary: String::new(),
                formatted_summary: String::new(),
                compacted_session: self.session.clone(),
                removed_message_count: 0,
                preserved_message_count: self.session.messages.len(),
                tokens_before: tokens,
                tokens_after: tokens,
                summary_source: CompactionSummarySource::Skipped,
                summary_output_tokens: None,
                token_estimate_source: CompactionTokenEstimateSource::Heuristic,
            };
        };
        let (summary, summary_source, summary_output_tokens) = if let Some((summary, usage)) =
            self.llm_summarize(&plan.removed, config.instruction.as_deref())
        {
            (summary, CompactionSummarySource::Llm, usage)
        } else {
            (
                summarize_messages(&plan.removed),
                CompactionSummarySource::Fallback,
                None,
            )
        };
        let result = assemble_compacted_session_with_usage(
            &self.session,
            summary,
            summary_source,
            summary_output_tokens,
            &plan,
        );
        self.session = result.compacted_session.clone();
        self.api_client
            .on_session_compacted(result.removed_message_count);
        result
    }

    #[must_use]
    pub fn estimated_tokens(&self) -> usize {
        estimate_session_tokens(&self.session)
    }

    #[must_use]
    pub fn usage(&self) -> &UsageTracker {
        &self.usage_tracker
    }

    #[must_use]
    pub fn session(&self) -> &Session {
        &self.session
    }

    #[must_use]
    pub fn into_session(self) -> Session {
        self.session
    }

    fn cancellation_requested(&self) -> bool {
        crate::is_interrupted() || self.tool_executor.is_cancelled()
    }

    fn interrupted_error() -> RuntimeError {
        if crate::is_interrupted() {
            crate::clear_interrupt();
        }
        RuntimeError::new("interrupted by user")
    }

    /// Synthetic `tool_result` for a `tool_use` that was cancelled before it
    /// produced output. Keeps every `tool_use` answered so the recorded
    /// assistant/tool message pair is a valid conversation the provider accepts
    /// when the turn is resumed.
    fn interrupted_tool_result(tool_use_id: String, tool_name: String) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id,
            tool_name,
            output: "Tool execution was interrupted by the user before it produced a result."
                .to_string(),
            is_error: true,
        }
    }

    fn maybe_auto_compact(&mut self) -> Option<AutoCompactionEvent> {
        // Compare the *latest* request's real prompt size against the budget —
        // that is how full the context window actually is right now. The old
        // code summed `cumulative_usage().input_tokens` across every request;
        // because each turn re-sends the whole history, that sum balloons far
        // faster than real occupancy and forced compaction after only a few
        // turns (catastrophic for large-window models like MiniMax/Gemini).
        let session_tokens = estimate_session_tokens(&self.session);
        let near_budget_threshold = ((self.context_compaction_estimated_tokens_threshold as f64)
            * AUTO_COMPACT_SESSION_ESTIMATE_RATIO)
            .round() as usize;
        let real_prompt_over_budget = self.usage_tracker.current_turn_usage().prompt_tokens()
            >= self.auto_compaction_input_tokens_threshold;
        let session_over_budget =
            session_tokens >= self.context_compaction_estimated_tokens_threshold;
        let session_near_budget = session_tokens >= near_budget_threshold.max(1);
        if !session_over_budget && !(real_prompt_over_budget && session_near_budget) {
            return None;
        }

        self.compact_now(CompactionConfig {
            max_estimated_tokens: 0,
            source: crate::compact::CompactionSource::Auto,
            instruction: None,
            ..CompactionConfig::default()
        })
    }

    fn prepare_context_for_request(&mut self) -> Option<AutoCompactionEvent> {
        // While the session is comfortably within budget, touch nothing: full
        // tool results, inputs, and assistant text stay verbatim. Retroactively
        // shrinking consumed content on every request (the previous behaviour)
        // destroyed context the model still needed long before any overflow.
        if estimate_session_tokens(&self.session)
            < self.context_compaction_estimated_tokens_threshold
        {
            return None;
        }

        // Step 1 — cheap, lossy: shrink already-consumed tool results and the
        // inputs of completed tool calls. Frequently enough on its own.
        compact_context_history(&mut self.session);
        if estimate_session_tokens(&self.session)
            < self.context_compaction_estimated_tokens_threshold
        {
            return None;
        }

        // Step 2 — summarize the oldest messages, preserving the active turn.
        let preserve = active_turn_message_count(&self.session).max(1);
        self.compact_now(CompactionConfig::overflow(preserve))
    }

    /// Aggressively shrink the session after the provider rejected the request
    /// for exceeding the model's context window. Unlike
    /// `prepare_context_for_request`, this ignores the local token-estimate
    /// threshold — the model's real window can be far smaller than our default
    /// budget — and always tries to reduce.
    ///
    /// Returns `Some` when the request was made smaller (so the caller should
    /// retry): with `removed_message_count > 0` when older messages were
    /// summarized, or `removed_message_count == 0` when only the lossy
    /// tool-history shrink reduced the prompt. Returns `None` when nothing more
    /// can be removed (an irreducible single oversized turn), so the caller
    /// surfaces the original error.
    fn force_compact_for_overflow(&mut self) -> Option<AutoCompactionEvent> {
        let before = estimate_session_tokens(&self.session);

        // Step 1 — lossy shrink of already-consumed tool inputs/results.
        compact_context_history(&mut self.session);

        // Step 2 — summarize the oldest messages, preserving the active turn.
        let preserve = active_turn_message_count(&self.session).max(1);
        if let Some(event) = self.compact_now(CompactionConfig::overflow(preserve)) {
            return Some(event);
        }

        // No older messages could be summarized, but the lossy step may have
        // shrunk the prompt enough to fit. Signal progress (count 0) so the
        // caller retries; only give up when nothing changed at all.
        if estimate_session_tokens(&self.session) < before {
            Some(AutoCompactionEvent {
                removed_message_count: 0,
                tokens_after: estimate_session_tokens(&self.session),
                token_estimate_source: CompactionTokenEstimateSource::Heuristic,
            })
        } else {
            None
        }
    }

    /// Compact the session now: split via `plan_compaction`, summarize the
    /// removed messages (real LLM summary when a summarizer is attached, else
    /// the deterministic text assembly), then replace the session with the
    /// compacted form. Returns `None` when there is nothing to compact. Shared
    /// by all three compaction entry points so they get identical quality.
    fn compact_now(&mut self, config: CompactionConfig) -> Option<AutoCompactionEvent> {
        let result = self.compact(config);
        let removed_message_count = result.removed_message_count;
        if removed_message_count == 0 {
            return None;
        }
        Some(AutoCompactionEvent {
            removed_message_count,
            tokens_after: result.tokens_after,
            token_estimate_source: result.token_estimate_source,
        })
    }

    /// Produce a real LLM summary of `removed` via the attached summarizer, or
    /// `None` to fall back to text assembly. Best-effort: a missing summarizer,
    /// any client error, or empty output yields `None` and never fails the
    /// turn. Output is wrapped in a `<summary>` block so downstream formatting
    /// matches the assembled path.
    fn llm_summarize(
        &mut self,
        removed: &[ConversationMessage],
        instruction: Option<&str>,
    ) -> Option<(String, Option<u32>)> {
        let summarizer = self.summarizer.as_mut()?;
        let request = build_summary_request(removed, instruction);
        // Compaction is best-effort, but a single transient gateway failure
        // should not immediately fall back to the bulky audit summary. Retry
        // once with the same bounded request; the runtime still falls back
        // safely if both attempts fail or return empty content.
        for _attempt in 0..2 {
            let Ok(events) = summarizer.stream(request.clone()) else {
                continue;
            };
            let summary_output_tokens = events.iter().find_map(|event| match event {
                AssistantEvent::Usage(usage) if usage.output_tokens > 0 => {
                    Some(usage.output_tokens)
                }
                _ => None,
            });
            let text = collect_assistant_text(&events);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let summary = if trimmed.contains("<summary>") {
                trimmed.to_string()
            } else {
                format!("<summary>\n{trimmed}\n</summary>")
            };
            return Some((summary, summary_output_tokens));
        }
        None
    }
}

/// System prompt steering the summarizer model toward a continuation-ready
/// `<summary>` block rather than chit-chat.
const SUMMARY_SYSTEM_PROMPT: &str = r#"You are compacting a long coding-assistant conversation to free up context.
Output one <summary>...</summary> block and nothing else.

The summary must preserve the information needed to continue development after earlier messages are removed.
Prefer concrete paths, commands, errors, decisions, constraints, and current task state over generic narration.
Do not invent details. If something is unknown, omit it.
If the transcript contains a previous context-compaction continuation or summary, merge its useful Current Focus, Active Issues, Code State, Commands & Test Results, User Intent, and Important Context forward into the new summary. Do not treat the wrapper text itself as a user request.
Ignore Aris-generated continuation prompts such as "Continue the unfinished task..." or "Your latest assistant message is empty" when identifying the user's active goal.
If a custom compaction instruction is supplied, prioritize it above the default compression priorities while still preserving the active task state and safety constraints.
If the transcript contains a TodoWrite result, preserve its latest structured task statuses and unfinished items.

Inside <summary>, use this exact structure:

## Current Focus
- Active user goal: [most recent non-internal user request, or the active goal from a prior compaction summary.]
- Where work stopped: [latest assistant/tool state that matters.]
- Immediate next step: [what should happen next.]

## Environment
- [Repository/workspace, platform, branch, tools, configs, or model/provider setup.]

## Completed Tasks
- [Task]: [Outcome.]

## Active Issues
- [Issue]: [Status and next steps.]

## Todo State
- [Latest structured task status, if available.]

## Forward Plan
- [Concrete next step, settled decision, or foreseeable obstacle.]

## Code State
### [Critical file name]
[Current purpose/state. Include latest important functions or snippets only when useful.]

## Commands & Test Results
- [Command]: [Result.]

## User Intent & Constraints
- [Stable user requirements, preferences, and constraints.]

## Important Context
- [Facts that would be expensive or risky to lose.]

## All User Messages
- [Detailed non-tool user messages from the compacted range.]
"#;

/// Upper bound on the characters of removed transcript fed to the summarizer,
/// so summarization itself never overflows the (small) summarizer's window.
/// ~120k chars ≈ well under a 200k-token Haiku window.
const MAX_SUMMARY_INPUT_CHARS: usize = 120_000;

/// Flatten removed messages into a plain-text transcript for the summarizer.
/// Flattening (vs. forwarding structured tool blocks) sidesteps dangling
/// tool_use/tool_result pairs, which otherwise make providers return an empty
/// stream.
fn build_summary_request(removed: &[ConversationMessage], instruction: Option<&str>) -> ApiRequest {
    let mut transcript = String::new();
    for message in removed {
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        for block in &message.blocks {
            let line = match block {
                ContentBlock::Text { text } => text.clone(),
                ContentBlock::Thinking { thinking, .. } => thinking.clone(),
                ContentBlock::ToolUse { name, input, .. } => format!("[tool_use {name}] {input}"),
                ContentBlock::ToolResult {
                    tool_name,
                    output,
                    is_error,
                    ..
                } => format!(
                    "[tool_result {tool_name}{}] {output}",
                    if *is_error { " error" } else { "" }
                ),
                ContentBlock::Image { media_type, .. } => format!("[image {media_type}]"),
            };
            if !line.trim().is_empty() {
                transcript.push_str(role);
                transcript.push_str(": ");
                transcript.push_str(line.trim());
                transcript.push('\n');
            }
        }
    }

    let bounded = bound_summary_input(&transcript);
    let custom_instruction = instruction
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("\n\nCustom compaction instruction from the user:\n{value}\n"))
        .unwrap_or_default();
    ApiRequest {
        system_prompt: vec![SUMMARY_SYSTEM_PROMPT.to_string()],
        messages: vec![ConversationMessage {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text {
                text: format!(
                    "This message is a direct compaction task, not part of the conversation. Do not call tools.{custom_instruction}\nConversation transcript to compact:\n\n{bounded}"
                ),
            }],
            usage: None,
        }],
    }
}

/// Keep the most recent `MAX_SUMMARY_INPUT_CHARS` of the transcript, marking the
/// elision. Recent context is the most useful for continuation, so we drop from
/// the front when over budget.
fn bound_summary_input(transcript: &str) -> String {
    if transcript.chars().count() <= MAX_SUMMARY_INPUT_CHARS {
        return transcript.to_string();
    }
    let tail: String = transcript
        .chars()
        .rev()
        .take(MAX_SUMMARY_INPUT_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("[…earlier messages elided for length…]\n{tail}")
}

fn collect_assistant_text(events: &[AssistantEvent]) -> String {
    let mut text = String::new();
    for event in events {
        if let AssistantEvent::TextDelta(delta) = event {
            text.push_str(delta);
        }
    }
    text
}

#[must_use]
pub fn auto_compaction_threshold_from_env() -> u32 {
    parse_auto_compaction_threshold(
        std::env::var(AUTO_COMPACTION_THRESHOLD_ENV_VAR)
            .ok()
            .as_deref(),
    )
}

#[must_use]
fn parse_auto_compaction_threshold(value: Option<&str>) -> u32 {
    value
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|threshold| *threshold > 0)
        .unwrap_or(DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD)
}

#[must_use]
pub fn context_compaction_threshold_from_env() -> usize {
    std::env::var(CONTEXT_COMPACTION_THRESHOLD_ENV_VAR)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|threshold| *threshold > 0)
        .unwrap_or(DEFAULT_CONTEXT_COMPACTION_ESTIMATED_TOKENS_THRESHOLD)
}

fn build_assistant_message(
    events: Vec<AssistantEvent>,
) -> Result<(ConversationMessage, Option<TokenUsage>, Option<String>), RuntimeError> {
    let mut text = String::new();
    let mut blocks = Vec::new();
    let mut finished = false;
    let mut usage = None;
    let mut stop_reason = None;

    for event in events {
        match event {
            AssistantEvent::TextDelta(delta) => {
                if text.is_empty() {
                    text = delta;
                } else {
                    text.push_str(&delta);
                }
            }
            AssistantEvent::ToolUse { id, name, input } => {
                flush_text_block(&mut text, &mut blocks);
                blocks.push(ContentBlock::ToolUse { id, name, input });
            }
            AssistantEvent::Thinking {
                thinking,
                signature,
            } => {
                flush_text_block(&mut text, &mut blocks);
                blocks.push(ContentBlock::Thinking {
                    thinking,
                    signature,
                });
            }
            AssistantEvent::Usage(value) => usage = Some(value),
            AssistantEvent::StopReason(reason) => stop_reason = Some(reason),
            AssistantEvent::MessageStop => {
                finished = true;
            }
        }
    }

    if blocks.is_empty()
        && text.is_empty()
        && stop_reason
            .as_deref()
            .is_some_and(is_recoverable_stop_reason)
    {
        text = "[The previous response was truncated before it produced a complete content or tool-call block. SomniQ will continue automatically.]".to_string();
    }
    flush_text_block(&mut text, &mut blocks);

    if !finished {
        return Err(RuntimeError::new(
            "assistant stream ended without a message stop event",
        ));
    }
    if blocks.is_empty() {
        // Some providers/proxies finish a filtered or otherwise empty answer
        // with only a stop reason (`end_turn`, `stop`, or no reason at all)
        // and `message_stop`. Treat that as a blank answer so the conversation
        // loop can issue its bounded continuation prompt. Returning an error
        // here bypasses the blank-response guard and makes the desktop turn
        // appear to stop after compaction.
        blocks.push(ContentBlock::Text {
            text: String::new(),
        });
    }
    if assistant_output_looks_degenerate(&blocks) {
        return Err(RuntimeError::new(
            "assistant output degenerated into repeated text; stopping to avoid context corruption",
        ));
    }

    Ok((
        ConversationMessage::assistant_with_usage(blocks, usage),
        usage,
        stop_reason,
    ))
}

fn is_recoverable_stop_reason(reason: &str) -> bool {
    matches!(
        reason.to_ascii_lowercase().as_str(),
        "max_tokens"
            | "length"
            | "max_output"
            | "max_output_tokens"
            | "stream_truncated"
            | "stream_error_after_partial_output"
    )
}

fn continuation_prompt(reason: &str) -> String {
    format!(
        "{CONTINUATION_PROMPT_PREFIX} ({reason}). Do not repeat completed work. If a tool call was truncated, retry it with a smaller payload or split the work into multiple tool calls."
    )
}

fn blank_response_continuation_prompt() -> String {
    format!(
        "{BLANK_RESPONSE_PROMPT_PREFIX}. If this followed tool results, provide only the missing user-facing conclusion; do not repeat earlier visible answer text. If the task is already complete, state the result or a brief confirmation. Otherwise continue the work now. Do not reply with an empty or whitespace-only message."
    )
}

/// Whether a terminal assistant message carries visible answer content.
/// ToolUse/ToolResult blocks deliberately do not count as an answer.
fn message_has_visible_output(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        ContentBlock::Thinking { thinking, .. } => !thinking.trim().is_empty(),
        ContentBlock::Image { .. } => true,
        ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. } => false,
    })
}

fn merge_auto_compaction_event(
    target: &mut Option<AutoCompactionEvent>,
    event: AutoCompactionEvent,
) {
    match target {
        Some(existing) => {
            existing.removed_message_count = existing
                .removed_message_count
                .saturating_add(event.removed_message_count);
            existing.tokens_after = event.tokens_after;
            existing.token_estimate_source = event.token_estimate_source;
        }
        None => *target = Some(event),
    }
}

fn is_transient_runtime_error(error: &RuntimeError) -> bool {
    if error.is_context_overflow() || error.is_model_unavailable() {
        return false;
    }
    let lower = error.to_string().to_ascii_lowercase();
    lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("reset")
        || lower.contains("eof")
        || lower.contains("broken pipe")
        || lower.contains("temporarily unavailable")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || contains_http_status(&lower, 429)
        || contains_http_status(&lower, 500)
        || contains_http_status(&lower, 502)
        || contains_http_status(&lower, 503)
        || contains_http_status(&lower, 504)
}

fn contains_http_status(message: &str, status: u16) -> bool {
    let status = status.to_string();
    message
        .split(|character: char| !character.is_ascii_digit())
        .any(|token| token == status)
}

fn active_turn_message_count(session: &Session) -> usize {
    session
        .messages
        .iter()
        .rposition(|message| {
            message.role == MessageRole::User && !is_internal_continuation_message(message)
        })
        .map_or(session.messages.len(), |index| {
            session.messages.len() - index
        })
}

fn is_internal_continuation_message(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::Text { text }
                if text.starts_with(CONTINUATION_PROMPT_PREFIX)
                    || text.starts_with(BLANK_RESPONSE_PROMPT_PREFIX)
                    || text.starts_with(LEGACY_BLANK_RESPONSE_PROMPT_PREFIX)
        )
    })
}

/// Removes retry-only prompts that were appended by the runtime after a
/// partial or empty response. They are useful only while recovering the
/// current request; persisting one after a later failure can make the next
/// real user message look like a continuation of stale work.
pub fn strip_trailing_internal_continuation_messages(session: &mut Session) {
    while session
        .messages
        .last()
        .is_some_and(is_internal_continuation_message)
    {
        session.messages.pop();
    }
}

fn bound_incoming_user_message(message: &mut ConversationMessage) {
    for block in &mut message.blocks {
        if let ContentBlock::Text { text } = block {
            if text.chars().count() > MAX_CONTEXT_USER_TEXT_CHARS {
                *text = bound_context_text(
                    std::mem::take(text),
                    MAX_CONTEXT_USER_TEXT_CHARS,
                    "user text",
                );
            }
        }
    }
}

fn compact_context_history(session: &mut Session) {
    let unconsumed_tool_index = session
        .messages
        .last()
        .filter(|message| message.role == MessageRole::Tool)
        .map(|_| session.messages.len().saturating_sub(1));

    for (message_index, message) in session.messages.iter_mut().enumerate() {
        if Some(message_index) == unconsumed_tool_index {
            continue;
        }
        for block in &mut message.blocks {
            match block {
                ContentBlock::ToolUse { input, .. }
                    if input.chars().count() > MAX_CONTEXT_TOOL_INPUT_CHARS =>
                {
                    let original_chars = input.chars().count();
                    *input = format!(
                        r#"{{"_aris_compacted":"completed tool input omitted from context","original_chars":{original_chars}}}"#
                    );
                }
                ContentBlock::ToolResult { output, .. }
                    if output.chars().count() > MAX_CONSUMED_TOOL_RESULT_CHARS =>
                {
                    *output =
                        bound_tool_result(std::mem::take(output), MAX_CONSUMED_TOOL_RESULT_CHARS);
                }
                ContentBlock::Text { text }
                    if message.role == MessageRole::Assistant
                        && text.chars().count() > MAX_CONTEXT_ASSISTANT_TEXT_CHARS =>
                {
                    *text = bound_context_text(
                        std::mem::take(text),
                        MAX_CONTEXT_ASSISTANT_TEXT_CHARS,
                        "assistant text",
                    );
                }
                _ => {}
            }
        }
    }
}

fn bound_tool_result(output: String, max_chars: usize) -> String {
    bound_context_text(output, max_chars, "tool result")
}

fn bound_context_text(output: String, max_chars: usize, label: &str) -> String {
    let total = output.chars().count();
    if total <= max_chars {
        return output;
    }
    let marker = format!(
        "\n\n[SomniQ truncated this {label} for context safety: {total} chars total. Use a narrower query, pagination, or a file artifact to inspect the omitted content.]\n\n"
    );
    let available = max_chars.saturating_sub(marker.chars().count());
    let head_chars = available.saturating_mul(3) / 4;
    let tail_chars = available.saturating_sub(head_chars);
    let head = output.chars().take(head_chars).collect::<String>();
    let tail = output
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
}

fn assistant_output_looks_degenerate(blocks: &[ContentBlock]) -> bool {
    if blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ToolUse { .. }
                | ContentBlock::ToolResult { .. }
                | ContentBlock::Image { .. }
        )
    }) {
        return false;
    }
    let text = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Thinking { thinking, .. } => Some(thinking.as_str()),
            ContentBlock::Image { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    repeated_token_output(&text) || repeated_char_output(&text)
}

fn repeated_token_output(text: &str) -> bool {
    let mut counts = BTreeMap::<String, usize>::new();
    let mut total = 0_usize;
    for raw in text.split_whitespace() {
        let token = raw
            .trim_matches(|ch: char| !ch.is_alphanumeric())
            .to_ascii_lowercase();
        if token.is_empty() || token.chars().count() > 32 || !token.chars().any(char::is_alphabetic)
        {
            continue;
        }
        total += 1;
        *counts.entry(token).or_default() += 1;
    }
    if total < 80 || counts.len() > 4 {
        return false;
    }
    counts
        .values()
        .copied()
        .max()
        .is_some_and(|max_count| max_count.saturating_mul(100) >= total.saturating_mul(90))
}

fn repeated_char_output(text: &str) -> bool {
    let mut counts = BTreeMap::<char, usize>::new();
    let mut total = 0_usize;
    for ch in text.chars().filter(|ch| !ch.is_whitespace()) {
        total += 1;
        *counts.entry(ch).or_default() += 1;
    }
    if total < 240 || counts.len() > 4 {
        return false;
    }
    counts
        .iter()
        .filter(|(ch, _)| ch.is_alphabetic())
        .map(|(_, count)| *count)
        .max()
        .is_some_and(|max_count| max_count.saturating_mul(100) >= total.saturating_mul(92))
}

fn flush_text_block(text: &mut String, blocks: &mut Vec<ContentBlock>) {
    if !text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: std::mem::take(text),
        });
    }
}

fn format_hook_message(result: &HookRunResult, fallback: &str) -> String {
    if result.messages().is_empty() {
        fallback.to_string()
    } else {
        result.messages().join("\n")
    }
}

fn merge_hook_feedback(messages: &[String], output: String, denied: bool) -> String {
    if messages.is_empty() {
        return output;
    }

    let mut sections = Vec::new();
    if !output.trim().is_empty() {
        sections.push(output);
    }
    let label = if denied {
        "Hook feedback (denied)"
    } else {
        "Hook feedback"
    };
    sections.push(format!("{label}:\n{}", messages.join("\n")));
    sections.join("\n\n")
}

type ToolHandler = Box<dyn FnMut(&str) -> Result<String, ToolError>>;

#[derive(Default)]
pub struct StaticToolExecutor {
    handlers: BTreeMap<String, ToolHandler>,
}

impl StaticToolExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn register(
        mut self,
        tool_name: impl Into<String>,
        handler: impl FnMut(&str) -> Result<String, ToolError> + 'static,
    ) -> Self {
        self.handlers.insert(tool_name.into(), Box::new(handler));
        self
    }
}

impl ToolExecutor for StaticToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.handlers
            .get_mut(tool_name)
            .ok_or_else(|| ToolError::new(format!("unknown tool: {tool_name}")))?(input)
    }
}

#[cfg(test)]
#[path = "tests/conversation.rs"]
mod tests;

use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

use crate::compact::{
    compact_session, estimate_session_tokens, CompactionConfig, CompactionResult,
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
const CONTINUATION_PROMPT_PREFIX: &str =
    "Continue the unfinished task from the exact point where the previous response stopped";
/// How many times a turn that ended with no visible output at all (blank /
/// whitespace-only text, reasoning that came back empty, a filtered or proxy
/// `" "` finish, or a post-compaction "nothing to add" reply) may nudge the
/// model to actually respond before giving up. Bounded so a model that is
/// genuinely done — or repeatedly filtered — does not loop forever.
const MAX_BLANK_RESPONSE_CONTINUATIONS: usize = 2;
const BLANK_RESPONSE_PROMPT_PREFIX: &str = "Your previous response contained no visible text";
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
        }
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
                Err(error) => return Err(error),
            };
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
                if !assistant_messages.iter().any(message_has_visible_output) {
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

            let mut turn_tool_results = Vec::new();
            for (tool_use_id, tool_name, input) in pending_tool_uses {
                if self.cancellation_requested() {
                    return Err(Self::interrupted_error());
                }
                let permission_outcome = if let Some(prompt) = prompter.as_mut() {
                    self.permission_policy
                        .authorize(&tool_name, &input, Some(*prompt))
                } else {
                    self.permission_policy.authorize(&tool_name, &input, None)
                };

                let result_blocks = match permission_outcome {
                    PermissionOutcome::Allow => {
                        if self.cancellation_requested() {
                            return Err(Self::interrupted_error());
                        }
                        let pre_hook_result = self.hook_runner.run_pre_tool_use(&tool_name, &input);
                        if pre_hook_result.is_denied() {
                            let deny_message = format!("PreToolUse hook denied tool `{tool_name}`");
                            vec![ContentBlock::ToolResult {
                                tool_use_id,
                                tool_name,
                                output: format_hook_message(&pre_hook_result, &deny_message),
                                is_error: true,
                            }]
                        } else {
                            let (mut output, mut is_error) = match self
                                .tool_executor
                                .execute_with_id(&tool_use_id, &tool_name, &input)
                            {
                                Ok(output) => (output, false),
                                Err(error) if error.is_interrupted() => {
                                    return Err(RuntimeError::new(error.to_string()));
                                }
                                Err(error) => (error.to_string(), true),
                            };
                            output = merge_hook_feedback(pre_hook_result.messages(), output, false);

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
                                let skill_name = serde_json::from_str::<serde_json::Value>(&input)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("skill").and_then(|s| s.as_str().map(String::from))
                                    })
                                    .unwrap_or_default();
                                let skill_args = serde_json::from_str::<serde_json::Value>(&input)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("args").and_then(|s| s.as_str().map(String::from))
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

                            vec![ContentBlock::ToolResult {
                                tool_use_id,
                                tool_name,
                                output,
                                is_error,
                            }]
                        }
                    }
                    PermissionOutcome::Deny { reason } => {
                        vec![ContentBlock::ToolResult {
                            tool_use_id,
                            tool_name,
                            output: reason,
                            is_error: true,
                        }]
                    }
                };
                turn_tool_results.extend(result_blocks);
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

    #[must_use]
    pub fn compact(&self, config: CompactionConfig) -> CompactionResult {
        compact_session(&self.session, config)
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

    fn maybe_auto_compact(&mut self) -> Option<AutoCompactionEvent> {
        // Compare the *latest* request's real prompt size against the budget —
        // that is how full the context window actually is right now. The old
        // code summed `cumulative_usage().input_tokens` across every request;
        // because each turn re-sends the whole history, that sum balloons far
        // faster than real occupancy and forced compaction after only a few
        // turns (catastrophic for large-window models like MiniMax/Gemini).
        if self.usage_tracker.current_turn_usage().prompt_tokens()
            < self.auto_compaction_input_tokens_threshold
            && estimate_session_tokens(&self.session)
                < self.context_compaction_estimated_tokens_threshold
        {
            return None;
        }

        let result = compact_session(
            &self.session,
            CompactionConfig {
                max_estimated_tokens: 0,
                ..CompactionConfig::default()
            },
        );

        if result.removed_message_count == 0 {
            return None;
        }

        self.session = result.compacted_session;
        // Notify the client so any per-message-index state (e.g. OpenAI
        // executor's reasoning_cache keyed by usize) is cleared.
        // Default no-op for stateless clients.
        self.api_client
            .on_session_compacted(result.removed_message_count);
        Some(AutoCompactionEvent {
            removed_message_count: result.removed_message_count,
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
        let result = compact_session(
            &self.session,
            CompactionConfig {
                preserve_recent_messages: active_turn_message_count(&self.session).max(1),
                max_estimated_tokens: 0,
            },
        );
        if result.removed_message_count == 0 {
            return None;
        }

        self.session = result.compacted_session;
        self.api_client
            .on_session_compacted(result.removed_message_count);
        Some(AutoCompactionEvent {
            removed_message_count: result.removed_message_count,
        })
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
        let result = compact_session(
            &self.session,
            CompactionConfig {
                preserve_recent_messages: active_turn_message_count(&self.session).max(1),
                max_estimated_tokens: 0,
            },
        );
        if result.removed_message_count > 0 {
            self.session = result.compacted_session;
            self.api_client
                .on_session_compacted(result.removed_message_count);
            return Some(AutoCompactionEvent {
                removed_message_count: result.removed_message_count,
            });
        }

        // No older messages could be summarized, but the lossy step may have
        // shrunk the prompt enough to fit. Signal progress (count 0) so the
        // caller retries; only give up when nothing changed at all.
        if estimate_session_tokens(&self.session) < before {
            Some(AutoCompactionEvent {
                removed_message_count: 0,
            })
        } else {
            None
        }
    }
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
        return Err(RuntimeError::new("assistant stream produced no content"));
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
        "{BLANK_RESPONSE_PROMPT_PREFIX}. If the task is already complete, state the result or a brief confirmation. Otherwise continue the work now. Do not reply with an empty or whitespace-only message."
    )
}

/// Whether a single assistant message carries anything the user can see: real
/// (non-whitespace) text or thinking, or any tool/image activity. Used to
/// detect a turn that produced nothing at all so the loop can drive a
/// continuation instead of finishing silently.
fn message_has_visible_output(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| match block {
        ContentBlock::Text { text } => !text.trim().is_empty(),
        ContentBlock::Thinking { thinking, .. } => !thinking.trim().is_empty(),
        ContentBlock::ToolUse { .. }
        | ContentBlock::ToolResult { .. }
        | ContentBlock::Image { .. } => true,
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
        }
        None => *target = Some(event),
    }
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
        )
    })
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
mod tests {
    use super::{
        assistant_output_looks_degenerate, assistant_text_from_turn_summary,
        build_assistant_message, is_internal_continuation_message, parse_auto_compaction_threshold,
        ApiClient, ApiRequest, AssistantEvent, AutoCompactionEvent, ConversationRuntime,
        RuntimeError, StaticToolExecutor, TurnSummary,
        DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD,
    };
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
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
    fn context_overflow_surfaces_error_when_irreducible() {
        // A single oversized turn cannot be compacted further, so the error
        // must surface instead of looping forever.
        struct AlwaysOverflowClient;
        impl ApiClient for AlwaysOverflowClient {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
    fn reconstructs_usage_tracker_from_restored_session() {
        struct SimpleApi;
        impl ApiClient for SimpleApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
        });
        assert!(result.summary.contains("Conversation summary"));
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
    fn auto_compacts_when_latest_input_threshold_is_crossed() {
        struct SimpleApi;
        impl ApiClient for SimpleApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
                crate::session::ConversationMessage::user_text("one"),
                crate::session::ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "two".to_string(),
                }]),
                crate::session::ConversationMessage::user_text("three"),
                crate::session::ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "four".to_string(),
                }]),
            ],
        };

        let mut runtime = ConversationRuntime::new(
            session,
            SimpleApi,
            StaticToolExecutor::new(),
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        )
        .with_auto_compaction_input_tokens_threshold(100_000);

        let summary = runtime
            .run_turn("trigger", None)
            .expect("turn should succeed");

        assert_eq!(
            summary.auto_compaction,
            Some(AutoCompactionEvent {
                removed_message_count: 2,
            })
        );
        assert_eq!(runtime.session().messages[0].role, MessageRole::User);
    }

    #[test]
    fn skips_auto_compaction_below_threshold() {
        struct SimpleApi;
        impl ApiClient for SimpleApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
                                    format!(
                                        "partial segment {index} keeps varied continuation context"
                                    )
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
                    message.blocks.iter().any(
                        |block| matches!(block, ContentBlock::Text { text } if text == "trigger"),
                    )
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
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
                        request.messages.iter().any(|message| message.blocks.iter().any(
                            |block| matches!(block, ContentBlock::Text { text }
                                if text.starts_with("Your previous response contained no visible text"))
                        )),
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
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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

    /// Contrast case / guard: a final message carrying only `Thinking` (no
    /// visible text) is NOT a silent stop — the summary falls back to the
    /// reasoning text, so the user still sees something. This pins the boundary
    /// so a future change that drops the thinking fallback is caught here.
    #[test]
    fn thinking_only_final_response_is_not_a_silent_stop() {
        struct ThinkingOnlyApi;
        impl ApiClient for ThinkingOnlyApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
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
}

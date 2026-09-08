use crate::session::{
    ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord,
};
use regex::Regex;
use std::sync::OnceLock;

/// Compiled regexes for [`redact_secrets`]. Built lazily so the rules live
/// next to the function that interprets them and stay cheap to share across
/// turns.
fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            // PEM-style private key blocks: the body lines are the secret.
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            // HTTP authorization bearer tokens. Word chars cover JWT, opaque
            // tokens, and hex/base64 alike; the non-greedy capture stops at
            // the first delimiter (whitespace, quote, comma, end of line).
            r#"(?i)(?P<prefix>\bBearer\s+)(?P<token>[A-Za-z0-9._\-+/=]+)"#,
            // `password=...` style key/value pairs. The value runs up to the
            // next whitespace, quote, or comma so the surrounding key name and
            // any trailing punctuation stay readable.
            r#"(?i)\b(?P<key>password|passwd|pwd)\s*=\s*(?P<value>[^\s"',;`]+)"#,
            r#"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd|secret|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?[^"'\s,;}\]]+"#,
            // Vendor secret prefixes: `sk-...` (OpenAI/Anthropic), `gho_/ghp_/ghs_/xoxb-...`
            // (GitHub/Slack), `xai-...`, etc. Anchored to the longest run of
            // token characters so common words like `sketch` or `skip` (no
            // trailing dashes) are not redacted. A bare `sk-` followed by a
            // short suffix is not enough — the suffix must be a real-looking
            // token length.
            r#"\b(?P<prefix>(?:sk-[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{12,}|ghs_[A-Za-z0-9]{12,}|xox[bprs]-[A-Za-z0-9-]{12,}|xai-[A-Za-z0-9]{12,}))"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("secret regex must compile"))
        .collect()
    })
}

/// Strip credentials, bearer tokens, and key material from a string before it
/// is persisted into a compaction summary. The summary rides into the next
/// context, so any secret that lands in it stays for the rest of the session
/// and beyond. `tool_use` input is normally summarised as `[input omitted]`,
/// but `tool_result` output, raw user text, and JSON snippets still pass
/// through here, and the inputs are scanned for key files by
/// [`collect_key_files`], so a path like `F:\Agent\Aris\src\client.rs` must
/// survive — every rule below targets credential-shaped substrings and leaves
/// ordinary identifiers untouched.
#[must_use]
pub fn redact_secrets(text: &str) -> String {
    let mut scrubbed = text.to_string();
    for pattern in secret_patterns() {
        scrubbed = match pattern.as_str() {
            s if s.starts_with("(?s)-----") => {
                pattern.replace_all(&scrubbed, "[REDACTED]").into_owned()
            }
            s if s.starts_with("(?i)(?P<prefix>\\bBearer") => pattern
                .replace_all(&scrubbed, "$prefix[REDACTED]")
                .into_owned(),
            s if s.starts_with("(?i)\\b(?P<key>password") => pattern
                .replace_all(&scrubbed, "$key=[REDACTED]")
                .into_owned(),
            _ => pattern.replace_all(&scrubbed, "[REDACTED]").into_owned(),
        };
    }
    scrubbed
}

const COMPACTION_CONTINUATION_PREFIX: &str =
    "This session is being continued from a previous conversation that ran out of context.";
const OUTPUT_LIMIT_CONTINUATION_PREFIX: &str =
    "Continue the unfinished task from the exact point where the previous response stopped";
const BLANK_RESPONSE_CONTINUATION_PREFIX: &str = "Your latest assistant message is empty";
const LEGACY_BLANK_RESPONSE_CONTINUATION_PREFIX: &str =
    "Your previous response contained no visible text";
const DIRECT_COMPACTION_TASK_PREFIX: &str =
    "This message is a direct compaction task, not part of the conversation.";
const RECENT_MESSAGES_AUTHORITY_PREFIX: &str =
    "Recent messages are preserved verbatim and are authoritative.";
const LEGACY_RESUME_WITHOUT_QUESTIONS_PREFIX: &str =
    "Continue the conversation from where it left off without asking the user any further questions.";
const DIRECT_RESUME_PREFIX: &str =
    "If genuinely blocked by a material ambiguity, ask one concise clarifying question; otherwise resume directly.";
const MAX_ACTIVE_USER_GOAL_CHARS: usize = 220;
// A pinned block alone may use up to roughly 9.5k characters: 8k of user
// requests (`PINNED_REQUESTS_CHAR_BUDGET`) plus the bounded dead-end and
// focus-signal lines. Keeping only 4k from the prior summary could therefore
// cut away Current Focus, Active Issues, Todo, and Code State during the next
// compaction. This remains bounded, but leaves enough room for both the pinned
// facts and the structured working state.
const MAX_PRIOR_COMPACTION_SUMMARY_CHARS: usize = 16_000;
/// Token/turn-aware preservation never keeps fewer than this many complete,
/// non-internal user turns, even when the token target is tiny. Guarantees a
/// compaction cannot collapse the working set below the last couple of
/// exchanges (the near-context-reset failure mode).
pub(crate) const MIN_PRESERVED_USER_TURNS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionSource {
    Auto,
    Manual,
    Overflow,
}

impl Default for CompactionSource {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionSummarySource {
    Llm,
    Fallback,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTokenEstimateSource {
    ProviderSummaryUsage,
    Heuristic,
}

impl CompactionTokenEstimateSource {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderSummaryUsage => "provider_summary_usage",
            Self::Heuristic => "heuristic",
        }
    }
}

impl CompactionSummarySource {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Llm => "llm",
            Self::Fallback => "fallback",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionConfig {
    pub preserve_recent_messages: usize,
    /// When set, preservation is token- and turn-aware: keep the newest
    /// messages whose cumulative token estimate reaches this target *and* that
    /// span at least [`MIN_PRESERVED_USER_TURNS`] complete, non-internal user
    /// turns, instead of the fixed `preserve_recent_messages` count. The
    /// runtime populates this from its per-model budget for Auto/Manual
    /// compaction so a tool-heavy turn can no longer collapse the context to a
    /// couple of messages. `None` keeps the legacy message-count behavior,
    /// which the aggressive overflow path and the direct unit tests rely on.
    pub preserve_target_tokens: Option<usize>,
    pub max_estimated_tokens: usize,
    pub source: CompactionSource,
    pub instruction: Option<String>,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            preserve_recent_messages: 4,
            preserve_target_tokens: None,
            max_estimated_tokens: 10_000,
            source: CompactionSource::Auto,
            instruction: None,
        }
    }
}

impl CompactionConfig {
    #[must_use]
    pub fn manual(instruction: Option<String>) -> Self {
        Self {
            // Match automatic compaction: preserve a recent working window
            // rather than relying entirely on a generated summary. The manual
            // action should differ only in when it is triggered and any custom
            // instruction supplied by the user, not in continuity guarantees.
            // `preserve_target_tokens` is filled in by the runtime so manual
            // compaction preserves the same token/turn window as auto.
            preserve_recent_messages: 4,
            preserve_target_tokens: None,
            max_estimated_tokens: 0,
            source: CompactionSource::Manual,
            instruction,
        }
    }

    #[must_use]
    pub fn overflow(preserve_recent_messages: usize) -> Self {
        Self {
            preserve_recent_messages,
            // Overflow recovery deliberately keeps only a short, safe tail; it
            // must not widen preservation to a token target.
            preserve_target_tokens: None,
            max_estimated_tokens: 0,
            source: CompactionSource::Overflow,
            instruction: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionResult {
    pub summary: String,
    pub formatted_summary: String,
    pub compacted_session: Session,
    pub removed_message_count: usize,
    pub preserved_message_count: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub summary_source: CompactionSummarySource,
    pub summary_output_tokens: Option<u32>,
    pub token_estimate_source: CompactionTokenEstimateSource,
}

#[must_use]
pub fn estimate_session_tokens(session: &Session) -> usize {
    session.messages.iter().map(estimate_message_tokens).sum()
}

#[must_use]
pub fn should_compact(session: &Session, config: &CompactionConfig) -> bool {
    session.messages.len() > config.preserve_recent_messages
        && estimate_session_tokens(session) >= config.max_estimated_tokens
}

#[must_use]
pub fn format_compact_summary(summary: &str) -> String {
    let redacted = redact_secrets(summary);
    let without_analysis = strip_tag_block(&redacted, "analysis");
    let formatted = if let Some(content) = extract_tag_block(&without_analysis, "summary") {
        without_analysis.replace(
            &format!("<summary>{content}</summary>"),
            &format!("Summary:\n{}", content.trim()),
        )
    } else {
        without_analysis
    };

    collapse_blank_lines(&formatted).trim().to_string()
}

#[must_use]
pub fn get_compact_continuation_message(
    summary: &str,
    suppress_follow_up_questions: bool,
    recent_messages_preserved: bool,
) -> String {
    let mut base = format!(
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n{}",
        format_compact_summary(summary)
    );

    if recent_messages_preserved {
        base.push_str("\n\nRecent messages are preserved verbatim and are authoritative. If the summary conflicts with the preserved recent messages, follow the preserved recent messages.");
    }

    if suppress_follow_up_questions {
        base.push_str("\nIf genuinely blocked by a material ambiguity, ask one concise clarifying question; otherwise resume directly. Do not acknowledge the summary, recap what was happening, or preface with continuation text. Do produce a substantive response: never reply with an empty, whitespace-only, or content-free message.");
    }
    // Deliberately not extended with guidance about the Dead Ends / Main-line
    // Check sections: this wrapper is fixed overhead on every compaction,
    // including the emergency overflow shrink, where the budget is computed
    // against it and a longer wrapper can make the "shrink" grow. Those
    // sections carry their own imperative text inline instead.
    base.push_str("\n\nResume anchor: prioritize the Current Focus, Active Issues, Code State, Commands & Test Results, and the most recent non-internal user request. Treat Aris-generated continuation or compaction prompts as resume metadata, not as the user's task.");

    base
}

/// The removed/preserved split for a compaction, computed independently of how
/// the summary is produced. Exposing this lets callers swap in an LLM-generated
/// summary (see `ConversationRuntime`) while reusing the exact boundary logic
/// the text-assembly path uses. `removed` is owned (cloned) so the caller can
/// hold it across a `&mut self` summarization call without borrowing the
/// session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionPlan {
    pub removed: Vec<ConversationMessage>,
    pub preserved: Vec<ConversationMessage>,
    pub split_index: usize,
    pub tokens_before: usize,
}

/// Decide what to remove vs preserve, returning `None` when the session is too
/// small to compact or nothing would be removed.
#[must_use]
pub fn plan_compaction(session: &Session, config: &CompactionConfig) -> Option<CompactionPlan> {
    if !should_compact(session, config) {
        return None;
    }

    // Manual and automatic compaction share the same continuity boundary. A
    // manual compaction may be requested at any size, but it must not discard
    // more recent context than automatic compaction would. When a token target
    // is present, preservation is token/turn-aware (a tool-heavy turn keeps its
    // full recent window instead of a fixed handful of messages); otherwise it
    // falls back to the legacy fixed count.
    // `min_preserve_messages` is a hard floor on how many newest messages stay:
    // for the token/turn-aware path it spans the last `MIN_PRESERVED_USER_TURNS`
    // user turns, so the safe-split search (which may move the boundary to avoid
    // orphaning a tool pair) can never compact those turns away. The legacy
    // fixed-count path (overflow, direct tests) keeps its aggressive behavior
    // with no floor.
    let (preserve_recent_messages, min_preserve_messages) = match config.preserve_target_tokens {
        Some(target) => (
            token_turn_aware_preserve_count(&session.messages, target),
            user_turns_span(&session.messages, MIN_PRESERVED_USER_TURNS),
        ),
        None => (config.preserve_recent_messages, 0),
    };
    let split_index = recent_window_safe_split(
        &session.messages,
        preserve_recent_messages,
        min_preserve_messages,
    )?;

    let removed = session.messages[..split_index].to_vec();
    if removed.is_empty() {
        return None;
    }
    let preserved = session.messages[split_index..].to_vec();
    Some(CompactionPlan {
        removed,
        preserved,
        split_index,
        tokens_before: estimate_session_tokens(session),
    })
}

/// Number of newest messages to try to preserve so that their cumulative token
/// estimate reaches `preserve_target_tokens` *and* they span at least
/// [`MIN_PRESERVED_USER_TURNS`] complete, non-internal user turns. This is a
/// lower bound handed to [`recent_window_safe_split`], which snaps it to a safe
/// tool-pair boundary — so it does not need to land exactly on a user message.
fn token_turn_aware_preserve_count(
    messages: &[ConversationMessage],
    preserve_target_tokens: usize,
) -> usize {
    let mut tokens = 0usize;
    let mut user_turns = 0usize;
    let mut count = 0usize;
    for message in messages.iter().rev() {
        let starts_user_turn =
            message.role == MessageRole::User && !is_internal_user_message(message);
        // Both targets met and we are at the start of an older user turn: stop
        // so the extra turn stays in the summarized range, not the preserved
        // tail. Checked before counting so the boundary turn is excluded.
        if tokens >= preserve_target_tokens
            && user_turns >= MIN_PRESERVED_USER_TURNS
            && starts_user_turn
        {
            break;
        }
        count += 1;
        tokens = tokens.saturating_add(estimate_message_tokens(message));
        if starts_user_turn {
            user_turns += 1;
        }
    }
    count.min(messages.len())
}

/// Number of newest messages spanning the last `n` complete, non-internal user
/// turns (the whole session when there are fewer than `n`). Used as the hard
/// preservation floor for the token/turn-aware path.
fn user_turns_span(messages: &[ConversationMessage], n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    let mut user_turns = 0usize;
    let mut count = 0usize;
    for message in messages.iter().rev() {
        count += 1;
        if message.role == MessageRole::User && !is_internal_user_message(message) {
            user_turns += 1;
            if user_turns >= n {
                break;
            }
        }
    }
    count
}

/// Find a safe compaction boundary preserving at least `preserve_recent_messages`
/// newest messages. When no safe boundary exists at or before that target, the
/// search may move forward (preserving fewer) to avoid orphaning a tool pair —
/// but never past `min_preserve_messages`, which guarantees the token/turn-aware
/// path keeps its two user turns. Returns `None` if no safe boundary preserves
/// the floor (caller then skips compaction rather than drop a guaranteed turn).
fn recent_window_safe_split(
    messages: &[ConversationMessage],
    preserve_recent_messages: usize,
    min_preserve_messages: usize,
) -> Option<usize> {
    if messages.len() <= preserve_recent_messages {
        return None;
    }
    let target_split = messages.len().saturating_sub(preserve_recent_messages);
    // Largest split index that still preserves the floor (smaller split =
    // preserves more). `0` floor keeps the legacy behavior (up to len-1).
    let forward_ceiling = messages
        .len()
        .saturating_sub(min_preserve_messages.max(1))
        .max(target_split);
    (1..=target_split)
        .rev()
        .find(|split_index| can_split_after(messages, split_index - 1))
        .or_else(|| {
            ((target_split + 1)..=forward_ceiling)
                .find(|split_index| can_split_after(messages, split_index - 1))
        })
}

fn can_split_after(messages: &[ConversationMessage], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    if message.role == MessageRole::User {
        // Splitting right after a user message is safe only when the next message
        // also opens a fresh user turn (a clean user→user boundary). Otherwise the
        // preserved side would begin with an assistant/tool reply to a
        // now-summarized user message. This lets a lone leading user message be
        // compacted instead of blocking compaction entirely.
        if messages
            .get(index + 1)
            .is_none_or(|next| next.role != MessageRole::User)
        {
            return false;
        }
    }
    if message.role == MessageRole::Assistant && has_tool_use(message) {
        return false;
    }
    if messages
        .get(index + 1)
        .is_some_and(|next| next.role == MessageRole::Tool || has_tool_result(next))
    {
        return false;
    }
    if suffix_contains_orphan_tool_result(messages, index + 1) {
        return false;
    }
    if prefix_ends_with_open_tool_exchange(messages, index) {
        return false;
    }
    true
}

fn has_tool_use(message: &ConversationMessage) -> bool {
    message
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
}

fn has_tool_result(message: &ConversationMessage) -> bool {
    message
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

fn prefix_ends_with_open_tool_exchange(messages: &[ConversationMessage], index: usize) -> bool {
    if messages
        .get(index)
        .is_none_or(|message| message.role != MessageRole::Tool)
    {
        return false;
    }
    let mut tool_result_count = 0usize;
    for message in messages[..=index].iter().rev() {
        if message.role == MessageRole::Tool || has_tool_result(message) {
            tool_result_count = tool_result_count.saturating_add(tool_result_blocks(message));
            continue;
        }
        return message.role == MessageRole::Assistant
            && tool_use_blocks(message) > tool_result_count;
    }
    false
}

fn tool_use_blocks(message: &ConversationMessage) -> usize {
    message
        .blocks
        .iter()
        .filter(|block| matches!(block, ContentBlock::ToolUse { .. }))
        .count()
}

fn tool_result_blocks(message: &ConversationMessage) -> usize {
    let block_count = message
        .blocks
        .iter()
        .filter(|block| matches!(block, ContentBlock::ToolResult { .. }))
        .count();
    block_count.max(usize::from(message.role == MessageRole::Tool))
}

fn suffix_contains_orphan_tool_result(messages: &[ConversationMessage], start: usize) -> bool {
    let mut pending_tool_results = 0usize;
    for message in messages.iter().skip(start) {
        if message.role == MessageRole::Assistant {
            pending_tool_results = tool_use_blocks(message);
            continue;
        }
        if message.role == MessageRole::Tool || has_tool_result(message) {
            let result_count = tool_result_blocks(message);
            if pending_tool_results < result_count {
                return true;
            }
            pending_tool_results -= result_count;
            continue;
        }
        if message.role == MessageRole::User || message.role == MessageRole::System {
            pending_tool_results = 0;
        }
    }
    false
}

/// Build a compacted session while optionally using the summarizer provider's
/// reported output token count. The provider count is more faithful than the
/// character heuristic for the generated summary; preserved messages and the
/// continuation wrapper still use the local estimate because they are sent to
/// the main provider.
#[must_use]
pub fn assemble_compacted_session_with_usage(
    session: &Session,
    summary: String,
    summary_source: CompactionSummarySource,
    summary_output_tokens: Option<u32>,
    // Tokens of deterministic text (the pinned-context block) appended to the
    // summary *after* the provider reported `summary_output_tokens`. Added to
    // the provider-based `tokens_after` estimate so it is not underestimated;
    // ignored on the heuristic path, which measures the final string directly.
    extra_summary_tokens: usize,
    plan: &CompactionPlan,
) -> CompactionResult {
    let summary = redact_secrets(&summary);
    let formatted_summary = format_compact_summary(&summary);
    let continuation = get_compact_continuation_message(&summary, true, !plan.preserved.is_empty());

    // Use User role (not System) for the continuation message. This is NOT
    // cosmetic: `openai_executor::convert_messages_openai` explicitly skips
    // MessageRole::System messages, so under the old code the compaction
    // summary was silently dropped for OpenAI-compatible executors. User role
    // is serialized as "user" by every executor.
    let mut compacted_messages = vec![ConversationMessage {
        role: MessageRole::User,
        blocks: vec![ContentBlock::Text { text: continuation }],
        usage: None,
    }];
    compacted_messages.extend(plan.preserved.iter().cloned());

    let mut compacted_session = Session {
        version: session.version,
        messages: compacted_messages,
        compactions: session.compactions.clone(),
    };
    let (tokens_after, token_estimate_source) =
        if let Some(summary_output_tokens) = summary_output_tokens {
            let wrapper_tokens = estimate_text_tokens(&get_compact_continuation_message(
                "",
                true,
                !plan.preserved.is_empty(),
            ));
            let preserved_tokens = plan
                .preserved
                .iter()
                .map(estimate_message_tokens)
                .sum::<usize>();
            (
                usize::try_from(summary_output_tokens)
                    .unwrap_or(usize::MAX)
                    .saturating_add(extra_summary_tokens)
                    .saturating_add(wrapper_tokens)
                    .saturating_add(preserved_tokens),
                CompactionTokenEstimateSource::ProviderSummaryUsage,
            )
        } else {
            (
                estimate_session_tokens(&compacted_session),
                CompactionTokenEstimateSource::Heuristic,
            )
        };
    compacted_session.compactions.push(SessionCompactionRecord {
        summary: summary.clone(),
        messages: plan.removed.clone(),
        removed_message_count: plan.removed.len(),
        preserved_message_count: plan.preserved.len(),
        tokens_before: plan.tokens_before,
        tokens_after,
        summary_source: summary_source.as_str().to_string(),
    });

    CompactionResult {
        summary,
        formatted_summary,
        compacted_session,
        removed_message_count: plan.removed.len(),
        preserved_message_count: plan.preserved.len(),
        tokens_before: plan.tokens_before,
        tokens_after,
        summary_source,
        summary_output_tokens,
        token_estimate_source,
    }
}

pub(crate) fn summarize_messages(messages: &[ConversationMessage]) -> String {
    let user_messages = messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .count();
    let assistant_messages = messages
        .iter()
        .filter(|message| message.role == MessageRole::Assistant)
        .count();
    let tool_messages = messages
        .iter()
        .filter(|message| message.role == MessageRole::Tool)
        .count();

    let mut tool_names = messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolUse { name, .. } => Some(name.as_str()),
            ContentBlock::ToolResult { tool_name, .. } => Some(tool_name.as_str()),
            ContentBlock::Text { .. }
            | ContentBlock::Image { .. }
            | ContentBlock::Thinking { .. } => None,
        })
        .collect::<Vec<_>>();
    tool_names.sort_unstable();
    tool_names.dedup();

    let prior_compaction_summaries = collect_prior_compaction_summaries(messages);
    let prior_focus = prior_compaction_summaries
        .iter()
        .rev()
        .find_map(|summary| extract_prior_current_focus(summary));
    let latest_assistant_state = infer_latest_assistant_state(messages);

    let mut lines = vec!["<summary>".to_string(), "## Current Focus".to_string()];
    if let Some(latest_user_request) = infer_latest_user_request(messages) {
        lines.push(format!("- Active user goal: {latest_user_request}"));
    } else if let Some(prior_focus) = prior_focus {
        lines.push(format!(
            "- Active user goal from prior compacted state: {prior_focus}"
        ));
    } else {
        lines.push("- No explicit user request found in compacted range.".to_string());
    }
    if let Some(latest_assistant_state) = latest_assistant_state {
        lines.push(format!(
            "- Last assistant state before compaction: {latest_assistant_state}"
        ));
    }
    lines.push(
        "- Aris internal continuation/compaction prompts are resume metadata, not user tasks."
            .to_string(),
    );
    lines.push("- Recent preserved messages, if any, supersede this summary.".to_string());

    // Both new sections omit themselves when empty rather than emitting a
    // "- None detected" placeholder: they are empty on any conversation without
    // tool work, and this summary is produced under a char budget that the
    // emergency shrink path depends on.
    let signals = crate::focus_trace::FocusSignals::from_messages(messages);
    let facts = signals.facts();
    if !facts.is_empty() {
        lines.push(String::new());
        lines.push("## Main-line Check".to_string());
        lines.extend(facts.into_iter().map(|fact| format!("- {fact}")));
        if signals.is_rabbit_hole() {
            lines.push(format!(
                "- Narrow-focus warning: {}. Confirm this serves the project's main line before continuing it.",
                signals.reasons().join("; ")
            ));
        }
    }

    if !prior_compaction_summaries.is_empty() {
        lines.push(String::new());
        lines.push("## Prior Compaction Summary".to_string());
        for summary in &prior_compaction_summaries {
            lines.push("- Rolled forward from an earlier context compaction:".to_string());
            for line in summary.lines() {
                lines.push(format!("  {line}"));
            }
        }
    }

    lines.push(String::new());
    lines.push("## Environment".to_string());
    let key_files = collect_key_files(messages);
    if key_files.is_empty() {
        lines.push("- No file paths detected in compacted range.".to_string());
    } else {
        lines.push(format!("- Key files referenced: {}.", key_files.join(", ")));
    }
    if !tool_names.is_empty() {
        lines.push(format!("- Tools mentioned: {}.", tool_names.join(", ")));
    }

    lines.push(String::new());
    lines.push("## Completed Tasks".to_string());
    let assistant_summaries = collect_recent_role_summaries(messages, MessageRole::Assistant, 5);
    if assistant_summaries.is_empty() {
        lines.push("- No assistant completions detected.".to_string());
    } else {
        lines.extend(
            assistant_summaries
                .into_iter()
                .map(|item| format!("- Assistant state: {item}")),
        );
    }

    lines.push(String::new());
    lines.push("## Active Issues".to_string());
    let pending_work = infer_pending_work(messages);
    if pending_work.is_empty() {
        lines.push("- No explicit pending/todo markers detected.".to_string());
    } else {
        lines.extend(pending_work.into_iter().map(|item| format!("- {item}")));
    }

    let dead_ends = signals.dead_ends();
    if !dead_ends.is_empty() {
        lines.push(String::new());
        lines.push("## Dead Ends".to_string());
        lines.extend(
            dead_ends
                .into_iter()
                .map(|dead_end| format!("- Do not retry as-is: {dead_end}")),
        );
    }

    if let Some(todos) = latest_todo_state(messages) {
        lines.push(String::new());
        lines.push("## Todo State".to_string());
        if todos.is_empty() {
            lines.push("- No active TodoWrite items.".to_string());
        } else {
            lines.extend(todos.into_iter().map(|item| format!("- {item}")));
        }
    }

    let forward_plan = infer_pending_work(messages);
    if !forward_plan.is_empty() {
        lines.push(String::new());
        lines.push("## Forward Plan".to_string());
        lines.extend(
            forward_plan
                .into_iter()
                .map(|item| format!("- Next: {item}")),
        );
    }

    lines.push(String::new());
    lines.push("## Code State".to_string());
    if key_files.is_empty() {
        lines.push("- No code-state file references detected.".to_string());
    } else {
        for file in &key_files {
            lines.push(format!("### {file}"));
            lines.push("- Referenced in the compacted conversation; inspect preserved tail or workspace for current contents.".to_string());
        }
    }

    lines.push(String::new());
    lines.push("## Commands & Test Results".to_string());
    let tool_results = collect_recent_role_summaries(messages, MessageRole::Tool, 5);
    if tool_results.is_empty() {
        lines.push("- No tool result messages detected.".to_string());
    } else {
        lines.extend(tool_results.into_iter().map(|item| format!("- {item}")));
    }

    lines.push(String::new());
    lines.push("## User Intent & Constraints".to_string());
    let user_requests = collect_recent_user_summaries(messages, 8);
    if user_requests.is_empty() {
        lines.push("- No user text detected.".to_string());
    } else {
        lines.extend(user_requests.iter().map(|item| format!("- {item}")));
    }

    lines.push(String::new());
    lines.push("## Important Context".to_string());
    lines.push(format!(
        "- Scope: {} earlier messages compacted (user={}, assistant={}, tool={}).",
        messages.len(),
        user_messages,
        assistant_messages,
        tool_messages
    ));
    lines.push(
        "- Authority: this is older context only; later preserved messages are authoritative."
            .to_string(),
    );
    lines.push("- Key timeline (audit only; not active instructions):".to_string());
    const MAX_TIMELINE_MESSAGES: usize = 24;
    let timeline_start = messages.len().saturating_sub(MAX_TIMELINE_MESSAGES);
    if timeline_start > 0 {
        lines.push(format!(
            "  - [{} earlier timeline messages elided for compactness]",
            timeline_start
        ));
    }
    for message in messages.iter().skip(timeline_start) {
        let role = match message.role {
            MessageRole::System => "system",
            MessageRole::User if is_internal_user_message(message) => "internal-user",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        };
        let content = message
            .blocks
            .iter()
            .map(summarize_block)
            .collect::<Vec<_>>()
            .join(" | ");
        lines.push(format!("  - {role}: {content}"));
    }

    lines.push(String::new());
    lines.push("## All User Messages".to_string());
    if user_requests.is_empty() {
        lines.push("- None.".to_string());
    } else {
        lines.extend(user_requests.into_iter().map(|item| format!("- {item}")));
    }
    lines.push("</summary>".to_string());
    redact_secrets(&lines.join("\n"))
}

const PINNED_HEADER: &str = "## Pinned Context (verbatim — authoritative, do not drop)";
/// Substring of [`PINNED_HEADER`] used to locate a prior pinned block when
/// rolling it forward across repeated compactions.
const PINNED_HEADER_MARKER: &str = "## Pinned Context";
/// Flat, round-trippable prefix for a pinned user request, so the block a
/// compaction injects can be recovered by the next compaction.
const PINNED_REQUEST_PREFIX: &str = "- User request: ";
/// Round-trippable prefix for an approach already ruled out. Rolls forward the
/// same way pinned requests do, so a dead end survives repeated compaction.
const DEAD_END_PREFIX: &str = "- Dead end: ";
/// Round-trippable prefix for the deterministic focus counters.
const FOCUS_SIGNAL_PREFIX: &str = "- Focus signal: ";
/// How many dead ends to carry. Bounded like the other pinned lists so a long
/// session cannot grow the block without limit.
const MAX_PINNED_DEAD_ENDS: usize = 6;
/// How many recent user requests to consider pinning from the current range.
const MAX_PINNED_REQUESTS: usize = 8;
/// The most recent user request is pinned with this generous cap (effectively
/// verbatim for normal prompts, so tail constraints in a long request survive);
/// older requests use a smaller cap.
const PINNED_LATEST_REQUEST_CHARS: usize = 4_000;
const PINNED_OLDER_REQUEST_CHARS: usize = 1_200;
/// Total char budget for the pinned request lines. The original (first) request
/// is always kept and the most recent ones are packed in until the budget is
/// hit — the middle is dropped rather than truncating verbatim text mid-line.
const PINNED_REQUESTS_CHAR_BUDGET: usize = 8_000;
/// Hard per-request cap for the minimal pinned block injected on the overflow
/// path — small enough not to defeat the emergency shrink.
const OVERFLOW_PINNED_REQUEST_CHARS: usize = 400;

fn push_unique_request(list: &mut Vec<String>, value: String) {
    let value = value.trim().to_string();
    if !value.is_empty() && !list.iter().any(|existing| existing == &value) {
        list.push(value);
    }
}

/// Full text of a user message (all Text blocks joined), for verbatim pinning —
/// unlike `summarize_message`, which merges blocks and hard-truncates to 500.
fn user_message_text(message: &ConversationMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// This range's recent non-internal user requests (oldest-first on return). The
/// latest is kept near-verbatim; older ones use a smaller cap.
fn collect_pinned_user_requests(messages: &[ConversationMessage]) -> Vec<String> {
    let mut recent = messages
        .iter()
        .filter(|message| message.role == MessageRole::User && !is_internal_user_message(message))
        .rev()
        .map(user_message_text)
        .filter(|text| !text.trim().is_empty())
        .take(MAX_PINNED_REQUESTS)
        .enumerate()
        .map(|(index, text)| {
            let cap = if index == 0 {
                PINNED_LATEST_REQUEST_CHARS
            } else {
                PINNED_OLDER_REQUEST_CHARS
            };
            truncate_summary(text.trim(), cap)
        })
        .collect::<Vec<_>>();
    recent.reverse();
    recent
}

/// Keep the first (original) request plus the most recent requests that fit the
/// char budget, dropping the middle. Preserves the original requirement across
/// long sessions without letting the block grow without bound.
fn bound_pinned_requests(requests: Vec<String>, budget_chars: usize) -> Vec<String> {
    let total: usize = requests.iter().map(|request| request.chars().count()).sum();
    if total <= budget_chars || requests.len() <= 2 {
        return requests;
    }
    let first = requests[0].clone();
    let mut used = first.chars().count();
    let mut tail = Vec::new();
    for request in requests[1..].iter().rev() {
        let cost = request.chars().count();
        if used.saturating_add(cost) > budget_chars {
            break;
        }
        used += cost;
        tail.push(request.clone());
    }
    tail.reverse();
    let mut out = vec![first];
    out.extend(tail);
    out
}

/// The deterministic "must-not-lose" facts for the compacted range: user
/// requests/constraints (rolled forward from a prior compaction, then this
/// range's recent ones), the carried focus, the latest todo state, and
/// unresolved tool errors. Rendered both as a MUST-PRESERVE preamble in the
/// summarizer request and, verbatim, back into the final summary — so these
/// survive even if the model drops them or repeated compaction would erode
/// them. Emitted as flat, prefixed lines so [`carried_pinned_requests`] can
/// recover them on the next round.
fn pinned_context_lines(messages: &[ConversationMessage]) -> Vec<String> {
    let mut requests = Vec::new();
    // Oldest-first: carried forward from a prior compaction, then this range's
    // recent user messages. Keeping carried entries first preserves the
    // original requirements across repeated re-summarization.
    for request in carried_pinned_requests(messages) {
        push_unique_request(&mut requests, request);
    }
    for request in collect_pinned_user_requests(messages) {
        push_unique_request(&mut requests, request);
    }
    let requests = bound_pinned_requests(requests, PINNED_REQUESTS_CHAR_BUDGET);

    let mut lines = requests
        .into_iter()
        .map(|request| format!("{PINNED_REQUEST_PREFIX}{request}"))
        .collect::<Vec<_>>();
    if let Some(focus) = collect_prior_compaction_summaries(messages)
        .iter()
        .rev()
        .find_map(|summary| extract_prior_current_focus(summary))
        .or_else(|| carried_pinned_values(messages, "- Carried focus: ", 1).pop())
    {
        lines.push(format!("- Carried focus: {focus}"));
    }
    if let Some(todos) = latest_todo_state(messages) {
        for todo in todos {
            lines.push(format!("- Todo: {todo}"));
        }
    } else {
        for todo in carried_pinned_values(messages, "- Todo: ", 16) {
            lines.push(format!("- Todo: {todo}"));
        }
    }
    let mut errors = carried_pinned_values(messages, "- Unresolved error: ", 3);
    for error in collect_recent_tool_errors(messages, 3) {
        push_unique_request(&mut errors, error);
    }
    if errors.len() > 3 {
        errors.drain(..errors.len() - 3);
    }
    for error in errors {
        lines.push(format!("- Unresolved error: {error}"));
    }
    // Negative space. Every other pinned fact tells the resumed model what to
    // keep doing; without these it resumes a rabbit hole with the same
    // confidence it resumes real work, because "focus X" and "error X" are
    // exactly what it is handed back. Dead ends roll forward like the other
    // pinned values, so an approach ruled out three compactions ago is not
    // retried from scratch.
    let signals = crate::focus_trace::FocusSignals::from_messages(messages);
    let mut dead_ends = carried_pinned_values(messages, DEAD_END_PREFIX, MAX_PINNED_DEAD_ENDS);
    for dead_end in signals.dead_ends() {
        push_unique_request(&mut dead_ends, dead_end);
    }
    if dead_ends.len() > MAX_PINNED_DEAD_ENDS {
        dead_ends.drain(..dead_ends.len() - MAX_PINNED_DEAD_ENDS);
    }
    for dead_end in dead_ends {
        lines.push(format!("{DEAD_END_PREFIX}{dead_end}"));
    }
    // Measured shape of the compacted work, so the resumed model can compare it
    // against the main line in its system prompt. Compaction cannot make that
    // comparison itself: it is pure over messages and never sees the workspace.
    for fact in signals.facts() {
        lines.push(format!("{FOCUS_SIGNAL_PREFIX}{fact}"));
    }
    // Code state: the key files in play and the latest assistant decision/status,
    // so "where the work is" survives even if the summary drops it. Key files
    // roll forward naturally because `collect_key_files` re-scans the injected
    // pinned line on the next compaction.
    let files = collect_key_files(messages);
    if !files.is_empty() {
        lines.push(format!("- Key files: {}", files.join(", ")));
    }
    if let Some(state) = latest_assistant_decision(messages)
        .or_else(|| carried_pinned_values(messages, "- Latest assistant state: ", 1).pop())
    {
        lines.push(format!("- Latest assistant state: {state}"));
    }
    lines
}

/// The most recent substantive assistant text (a decision / status / where the
/// work stopped), pinned so it survives even if the model summary drops it.
fn latest_assistant_decision(messages: &[ConversationMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| message.role == MessageRole::Assistant)
        .filter_map(first_text_block)
        .find(|text| !text.trim().is_empty() && !is_diagnostic_dump(text))
        .map(|text| truncate_summary(&redact_secrets(text.trim()), 400))
}

/// Recover the user-request lines from the most recent prior pinned block
/// carried inside an internal continuation message, so the original
/// requirements roll forward across repeated compactions.
fn carried_pinned_requests(messages: &[ConversationMessage]) -> Vec<String> {
    carried_pinned_values(messages, PINNED_REQUEST_PREFIX, MAX_PINNED_REQUESTS)
}

/// Recover bounded facts from the newest prior pinned block. User requests were
/// already rolled forward, but Todo state, unresolved errors, and the latest
/// assistant decision used to disappear after the second compaction because
/// only their generated prose survived. Keeping the flat prefixed lines makes
/// those working-state facts round-trippable without growing the summary.
fn carried_pinned_values(
    messages: &[ConversationMessage],
    prefix: &str,
    limit: usize,
) -> Vec<String> {
    for message in messages.iter().rev() {
        if message.role != MessageRole::User || !is_internal_user_message(message) {
            continue;
        }
        let Some(text) = first_text_block(message) else {
            continue;
        };
        if !text.contains(PINNED_HEADER_MARKER) {
            continue;
        }
        let mut in_pinned = false;
        let mut values = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.contains(PINNED_HEADER_MARKER) {
                in_pinned = true;
                continue;
            }
            if in_pinned && trimmed.starts_with("## ") {
                break;
            }
            if !in_pinned {
                continue;
            }
            if let Some(value) = trimmed.strip_prefix(prefix) {
                push_unique_request(&mut values, value.to_string());
            }
        }
        if !values.is_empty() {
            if values.len() > limit {
                values.drain(..values.len() - limit);
            }
            return values;
        }
    }
    Vec::new()
}

fn collect_recent_tool_errors(messages: &[ConversationMessage], limit: usize) -> Vec<String> {
    messages
        .iter()
        .rev()
        .flat_map(|message| message.blocks.iter().rev())
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_name,
                output,
                is_error: true,
                ..
            } => {
                let text = output.trim();
                (!text.is_empty()).then(|| truncate_summary(&format!("{tool_name}: {text}"), 300))
            }
            _ => None,
        })
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn render_pinned_lines(lines: Vec<String>) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let mut out = vec![PINNED_HEADER.to_string()];
    out.extend(lines);
    Some(out.join("\n"))
}

/// Render the pinned facts as a `## Pinned Context` markdown block, or `None`
/// when nothing notable was found.
fn pinned_context_section(messages: &[ConversationMessage]) -> Option<String> {
    render_pinned_lines(pinned_context_lines(messages))
}

/// A minimal pinned block for the overflow path: the original (carried) plus the
/// latest user request only, bounded to `max_chars` so the active task survives
/// the emergency shrink without re-bloating it past the reserved budget.
/// Round-trippable so it still rolls forward on the next compaction. When even a
/// single request cannot fit `max_chars`, returns `None` (skip pinning).
pub(crate) fn minimal_pinned_block(
    messages: &[ConversationMessage],
    max_chars: usize,
) -> Option<String> {
    let mut requests = Vec::new();
    if let Some(original) = carried_pinned_requests(messages).into_iter().next() {
        push_unique_request(
            &mut requests,
            truncate_summary(&original, OVERFLOW_PINNED_REQUEST_CHARS),
        );
    }
    if let Some(latest) = collect_pinned_user_requests(messages)
        .into_iter()
        .next_back()
    {
        push_unique_request(
            &mut requests,
            truncate_summary(&latest, OVERFLOW_PINNED_REQUEST_CHARS),
        );
    }
    if requests.is_empty() {
        return None;
    }
    let full = {
        let mut lines = vec![PINNED_HEADER.to_string()];
        for request in &requests {
            lines.push(format!("{PINNED_REQUEST_PREFIX}{request}"));
        }
        lines.join("\n")
    };
    if full.chars().count() <= max_chars {
        return Some(full);
    }
    // Over budget: keep the header + the latest request only, truncated to fit.
    let latest = requests.last().cloned()?;
    let prefix_len = PINNED_HEADER.chars().count() + 1 + PINNED_REQUEST_PREFIX.chars().count();
    let room = max_chars.saturating_sub(prefix_len);
    if room == 0 {
        return None;
    }
    Some(format!(
        "{PINNED_HEADER}\n{PINNED_REQUEST_PREFIX}{}",
        truncate_summary(&latest, room)
    ))
}

/// The most recent non-internal user request in the range — the fidelity target
/// the LLM-summary gate checks the model actually covered. Head-truncated (not
/// via `truncate_summary`) so no mid-word `" ... "` artifact pollutes the
/// distinctive-token set the gate compares against.
pub(crate) fn coverage_target(messages: &[ConversationMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| message.role == MessageRole::User && !is_internal_user_message(message))
        .filter_map(first_text_block)
        .find(|text| !text.trim().is_empty())
        .map(|text| text.trim().chars().take(400).collect::<String>())
}

/// MUST-PRESERVE preamble for the summarizer request. Empty when nothing pins.
pub(crate) fn pinned_preamble(messages: &[ConversationMessage]) -> String {
    let lines = pinned_context_lines(messages);
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nMUST-PRESERVE — retain these verbatim facts in your summary; do not drop or paraphrase them away:\n{}\n",
        lines.join("\n")
    )
}

/// Insert a pinned block at the top of a summary (just inside the `<summary>`
/// tag when present).
pub(crate) fn insert_pinned_block(summary: String, block: &str) -> String {
    if let Some(open) = summary.find("<summary>") {
        let insert_at = open + "<summary>".len();
        let mut out = String::with_capacity(summary.len() + block.len() + 2);
        out.push_str(&summary[..insert_at]);
        out.push('\n');
        out.push_str(block);
        out.push('\n');
        out.push_str(&summary[insert_at..]);
        out
    } else {
        format!("{block}\n\n{summary}")
    }
}

/// Insert the full pinned-context block. Applied to the LLM and deterministic
/// summaries so the critical facts are guaranteed present verbatim.
pub(crate) fn inject_pinned_context(summary: String, messages: &[ConversationMessage]) -> String {
    let combined = match pinned_context_section(messages) {
        Some(block) => insert_pinned_block(summary, &block),
        None => summary,
    };
    redact_secrets(&combined)
}

/// Bound a deterministic fallback summary while retaining the continuation
/// markup required by the compaction path. `max_content_chars` deliberately
/// applies only to the inner summary text: the caller has already accounted
/// for the fixed continuation framing and tags.
pub(crate) fn bound_fallback_summary(summary: String, max_content_chars: usize) -> String {
    let content = extract_tag_block(&summary, "summary").unwrap_or(summary);
    let timeline_anchor = "- Key timeline (audit only; not active instructions):";
    let bounded = if content.contains("Key timeline (audit only")
        && max_content_chars > timeline_anchor.chars().count().saturating_add(2)
    {
        let detail_budget = max_content_chars
            .saturating_sub(timeline_anchor.chars().count())
            .saturating_sub(2);
        format!(
            "{}\n\n{timeline_anchor}",
            truncate_summary(&content, detail_budget)
        )
    } else {
        truncate_summary(&content, max_content_chars)
    };
    format!("<summary>\n{}\n</summary>", bounded)
}

fn summarize_block(block: &ContentBlock) -> String {
    let raw = match block {
        ContentBlock::Text { text } => text.clone(),
        ContentBlock::Image { media_type, data } => {
            format!("[image: {media_type}, {} base64 chars]", data.len())
        }
        ContentBlock::ToolUse { name, .. } => format!("tool_use {name}([input omitted])"),
        ContentBlock::ToolResult {
            tool_name,
            output,
            is_error,
            ..
        } => format!(
            "tool_result {tool_name}: {}{output}",
            if *is_error { "error " } else { "" }
        ),
        ContentBlock::Thinking { thinking, .. } => thinking.clone(),
    };
    truncate_summary(&redact_secrets(&raw), 450)
}

/// Recover the latest persisted TodoWrite snapshot from tool output. Kimi
/// carries the todo list into its compaction state explicitly; relying only on
/// words such as "todo" in the transcript loses structured task status.
fn latest_todo_state(messages: &[ConversationMessage]) -> Option<Vec<String>> {
    for message in messages.iter().rev() {
        for block in message.blocks.iter().rev() {
            let ContentBlock::ToolResult {
                tool_name, output, ..
            } = block
            else {
                continue;
            };
            if tool_name != "TodoWrite" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
                continue;
            };
            let Some(todos) = value
                .get("newTodos")
                .or_else(|| value.get("new_todos"))
                .and_then(serde_json::Value::as_array)
            else {
                continue;
            };
            return Some(
                todos
                    .iter()
                    .filter_map(|todo| {
                        let content = todo.get("content")?.as_str()?.trim();
                        if content.is_empty() {
                            return None;
                        }
                        let status = todo
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown");
                        Some(format!("[{status}] {content}"))
                    })
                    .collect(),
            );
        }
    }
    None
}

fn collect_recent_role_summaries(
    messages: &[ConversationMessage],
    role: MessageRole,
    limit: usize,
) -> Vec<String> {
    messages
        .iter()
        .filter(|message| message.role == role)
        .rev()
        .map(summarize_message)
        .filter(|text| !text.trim().is_empty())
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn collect_recent_user_summaries(messages: &[ConversationMessage], limit: usize) -> Vec<String> {
    messages
        .iter()
        .filter(|message| message.role == MessageRole::User && !is_internal_user_message(message))
        .rev()
        .map(summarize_message)
        .filter(|text| !text.trim().is_empty())
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn summarize_message(message: &ConversationMessage) -> String {
    let content = message
        .blocks
        .iter()
        .map(summarize_block)
        .collect::<Vec<_>>()
        .join(" | ");
    truncate_summary(&content, 500)
}

fn infer_pending_work(messages: &[ConversationMessage]) -> Vec<String> {
    let mut pending = Vec::new();
    for message in messages.iter().rev() {
        if message.role == MessageRole::User && is_internal_user_message(message) {
            continue;
        }
        let Some(text) = first_text_block(message) else {
            continue;
        };
        for line in text.lines().rev() {
            let Some(item) = explicit_pending_line(line) else {
                continue;
            };
            if !pending.iter().any(|existing| existing == &item) {
                pending.push(item);
            }
            if pending.len() == 3 {
                pending.reverse();
                return pending;
            }
        }
    }
    pending.reverse();
    pending
}

fn collect_key_files(messages: &[ConversationMessage]) -> Vec<String> {
    let mut files = messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .flat_map(|block| match block {
            ContentBlock::Text { text } => extract_file_candidates(text),
            ContentBlock::Image { media_type, .. } => extract_file_candidates(media_type),
            ContentBlock::ToolUse { input, .. } => extract_tool_input_file_candidates(input),
            ContentBlock::ToolResult { output, .. } => extract_file_candidates(output),
            ContentBlock::Thinking { thinking, .. } => extract_file_candidates(thinking),
        })
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    files.into_iter().take(8).collect()
}

fn infer_latest_user_request(messages: &[ConversationMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| message.role == MessageRole::User)
        .filter(|message| !is_internal_user_message(message))
        .filter_map(first_text_block)
        .find(|text| !text.trim().is_empty())
        .map(|text| truncate_summary(text, MAX_ACTIVE_USER_GOAL_CHARS))
}

fn infer_latest_assistant_state(messages: &[ConversationMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .filter(|message| message.role == MessageRole::Assistant)
        .filter_map(first_text_block)
        .find(|text| !text.trim().is_empty() && !is_diagnostic_dump(text))
        .map(|text| truncate_summary(&redact_secrets(text), 160))
}

fn first_text_block(message: &ConversationMessage) -> Option<&str> {
    message.blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
        ContentBlock::Image { .. } => None,
        ContentBlock::ToolUse { .. }
        | ContentBlock::ToolResult { .. }
        | ContentBlock::Text { .. }
        | ContentBlock::Thinking { .. } => None,
    })
}

pub(crate) fn is_internal_user_message(message: &ConversationMessage) -> bool {
    message.role == MessageRole::User
        && message.blocks.iter().any(|block| match block {
            ContentBlock::Text { text } => is_internal_user_text(text),
            ContentBlock::Image { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::ToolResult { .. }
            | ContentBlock::Thinking { .. } => false,
        })
}

fn is_internal_user_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with(COMPACTION_CONTINUATION_PREFIX)
        || trimmed.starts_with(OUTPUT_LIMIT_CONTINUATION_PREFIX)
        || trimmed.starts_with(BLANK_RESPONSE_CONTINUATION_PREFIX)
        || trimmed.starts_with(LEGACY_BLANK_RESPONSE_CONTINUATION_PREFIX)
        || trimmed.starts_with(DIRECT_COMPACTION_TASK_PREFIX)
}

fn collect_prior_compaction_summaries(messages: &[ConversationMessage]) -> Vec<String> {
    messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .filter_map(first_text_block)
        .filter_map(extract_prior_compaction_summary)
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn extract_prior_compaction_summary(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with(COMPACTION_CONTINUATION_PREFIX) {
        return None;
    }

    let summary_start = trimmed
        .find("Summary:\n")
        .map(|index| index + "Summary:\n".len())
        .or_else(|| {
            trimmed
                .find("<summary>")
                .map(|index| index + "<summary>".len())
        })?;
    let mut summary = &trimmed[summary_start..];
    if let Some(index) = summary.find("</summary>") {
        summary = &summary[..index];
    }
    for marker in [
        RECENT_MESSAGES_AUTHORITY_PREFIX,
        LEGACY_RESUME_WITHOUT_QUESTIONS_PREFIX,
        DIRECT_RESUME_PREFIX,
        "Resume anchor:",
    ] {
        if let Some(index) = summary.find(marker) {
            summary = &summary[..index];
        }
    }

    let summary = collapse_blank_lines(summary).trim().to_string();
    if summary.is_empty() {
        None
    } else {
        Some(truncate_summary(
            &summary,
            MAX_PRIOR_COMPACTION_SUMMARY_CHARS,
        ))
    }
}

fn extract_prior_current_focus(summary: &str) -> Option<String> {
    let mut in_focus = false;
    for line in summary.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("## Current Focus") {
            in_focus = true;
            continue;
        }
        if in_focus && trimmed.starts_with("## ") {
            return None;
        }
        if in_focus && !trimmed.is_empty() {
            let focus = trimmed
                .trim_start_matches('-')
                .trim_start_matches('*')
                .trim();
            if !focus.is_empty() {
                return Some(truncate_summary(focus, 450));
            }
        }
    }
    None
}

fn has_interesting_extension(candidate: &str) -> bool {
    std::path::Path::new(candidate)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["rs", "ts", "tsx", "js", "json", "md"]
                .iter()
                .any(|expected| extension.eq_ignore_ascii_case(expected))
        })
}

fn extract_file_candidates(content: &str) -> Vec<String> {
    let mut files = Vec::new();
    push_file_candidate(&mut files, content);
    for token in content.split_whitespace() {
        push_file_candidate(&mut files, token);
    }
    files
}

fn push_file_candidate(files: &mut Vec<String>, raw: &str) -> bool {
    let candidate = raw.trim_matches(|char: char| {
        matches!(
            char,
            ',' | '.'
                | ':'
                | ';'
                | ')'
                | '('
                | '"'
                | '\''
                | '`'
                | '['
                | ']'
                | '{'
                | '}'
                | '<'
                | '>'
        )
    });
    let is_file = (candidate.contains('/') || candidate.contains('\\'))
        && has_interesting_extension(candidate);
    if is_file && !files.iter().any(|existing| existing == candidate) {
        files.push(candidate.to_string());
    }
    is_file
}

fn extract_tool_input_file_candidates(input: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(input) else {
        return extract_file_candidates(input);
    };
    let mut files = Vec::new();
    collect_json_file_candidates(&value, &mut files);
    files
}

fn collect_json_file_candidates(value: &serde_json::Value, files: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            if !push_file_candidate(files, text) {
                for file in extract_file_candidates(text) {
                    if !files.iter().any(|existing| existing == &file) {
                        files.push(file);
                    }
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_json_file_candidates(value, files);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_json_file_candidates(value, files);
            }
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

fn explicit_pending_line(line: &str) -> Option<String> {
    let original = line.trim();
    if original.is_empty()
        || original.starts_with("//")
        || original.starts_with("/*")
        || original.starts_with('#')
        || original.starts_with("Traceback")
        || original.starts_with("http://")
        || original.starts_with("https://")
    {
        return None;
    }

    let mut candidate = original;
    if let Some(stripped) = candidate
        .strip_prefix("- ")
        .or_else(|| candidate.strip_prefix("* "))
    {
        candidate = stripped.trim_start();
    }
    if let Some(index) = candidate.find(|char: char| !char.is_ascii_digit()) {
        if index > 0 {
            let remainder = &candidate[index..];
            if let Some(stripped) = remainder
                .strip_prefix(". ")
                .or_else(|| remainder.strip_prefix(") "))
            {
                candidate = stripped.trim_start();
            }
        }
    }

    let lower = candidate.to_ascii_lowercase();
    let english = [
        "todo",
        "next",
        "pending",
        "remaining",
        "follow-up",
        "follow up",
    ];
    let english_match = english.iter().any(|marker| {
        lower.strip_prefix(marker).is_some_and(|remainder| {
            remainder.starts_with(':')
                || remainder.starts_with(" -")
                || remainder.starts_with(" --")
        })
    });
    let chinese_match = ["待办", "下一步", "尚未", "剩余", "需要继续", "后续"]
        .iter()
        .any(|marker| candidate.starts_with(marker));

    (english_match || chinese_match).then(|| truncate_summary(&redact_secrets(candidate), 350))
}

fn is_diagnostic_dump(text: &str) -> bool {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```"))
        .unwrap_or_default();
    let lower = first.to_ascii_lowercase();
    if lower.starts_with("traceback")
        || lower.starts_with("error[")
        || lower.starts_with("error:")
        || lower.starts_with("fatal:")
    {
        return true;
    }
    first
        .split_once(':')
        .is_some_and(|(kind, _)| kind.ends_with("Error") || kind.ends_with("Exception"))
}

fn truncate_summary(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content.to_string();
    }
    if max_chars <= 10 {
        return content.chars().take(max_chars).collect();
    }
    let marker = " ... ";
    let available = max_chars.saturating_sub(marker.chars().count());
    let head_chars = available / 2;
    let tail_chars = available.saturating_sub(head_chars);
    let head = content.chars().take(head_chars).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
}

pub(crate) fn estimate_message_tokens(message: &ConversationMessage) -> usize {
    message
        .blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => estimate_text_tokens(text),
            ContentBlock::Image { data, .. } => data.len() / 4 + 1,
            ContentBlock::ToolUse { name, input, .. } => {
                estimate_text_tokens(name) + estimate_text_tokens(input)
            }
            ContentBlock::ToolResult {
                tool_name, output, ..
            } => estimate_text_tokens(tool_name) + estimate_text_tokens(output),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => estimate_text_tokens(thinking) + estimate_text_tokens(signature),
        })
        .sum()
}

#[must_use]
pub fn estimate_text_tokens(text: &str) -> usize {
    let (cjk, other) = text.chars().fold((0usize, 0usize), |(cjk, other), ch| {
        if is_cjk_or_full_width(ch) {
            (cjk + 1, other)
        } else {
            (cjk, other + 1)
        }
    });
    cjk + ((other as f64) / 3.5).round() as usize + 1
}

fn is_cjk_or_full_width(ch: char) -> bool {
    let code = ch as u32;
    (0x3000..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
        || (0xff00..=0xffef).contains(&code)
}

fn extract_tag_block(content: &str, tag: &str) -> Option<String> {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    let start_index = content.find(&start)? + start.len();
    let end_index = content[start_index..].find(&end)? + start_index;
    Some(content[start_index..end_index].to_string())
}

fn strip_tag_block(content: &str, tag: &str) -> String {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    if let (Some(start_index), Some(end_index_rel)) = (content.find(&start), content.find(&end)) {
        let end_index = end_index_rel + end.len();
        let mut stripped = String::new();
        stripped.push_str(&content[..start_index]);
        stripped.push_str(&content[end_index..]);
        stripped
    } else {
        content.to_string()
    }
}

fn collapse_blank_lines(content: &str) -> String {
    let mut result = String::new();
    let mut last_blank = false;
    for line in content.lines() {
        let is_blank = line.trim().is_empty();
        if is_blank && last_blank {
            continue;
        }
        result.push_str(line);
        result.push('\n');
        last_blank = is_blank;
    }
    result
}

#[cfg(test)]
#[path = "tests/compact.rs"]
mod tests;

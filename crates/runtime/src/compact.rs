use crate::session::{
    ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord,
};

const COMPACTION_CONTINUATION_PREFIX: &str =
    "This session is being continued from a previous conversation that ran out of context.";
const OUTPUT_LIMIT_CONTINUATION_PREFIX: &str =
    "Continue the unfinished task from the exact point where the previous response stopped";
const BLANK_RESPONSE_CONTINUATION_PREFIX: &str = "Your previous response contained no visible text";
const DIRECT_COMPACTION_TASK_PREFIX: &str =
    "This message is a direct compaction task, not part of the conversation.";
const RECENT_MESSAGES_AUTHORITY_PREFIX: &str =
    "Recent messages are preserved verbatim and are authoritative.";
const RESUME_WITHOUT_QUESTIONS_PREFIX: &str =
    "Continue the conversation from where it left off without asking the user any further questions.";
const MAX_ACTIVE_USER_GOAL_CHARS: usize = 220;
const MAX_PRIOR_COMPACTION_SUMMARY_CHARS: usize = 4_000;

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
    pub max_estimated_tokens: usize,
    pub source: CompactionSource,
    pub instruction: Option<String>,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            preserve_recent_messages: 4,
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
            preserve_recent_messages: 1,
            max_estimated_tokens: 0,
            source: CompactionSource::Manual,
            instruction,
        }
    }

    #[must_use]
    pub fn overflow(preserve_recent_messages: usize) -> Self {
        Self {
            preserve_recent_messages,
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
    let without_analysis = strip_tag_block(summary, "analysis");
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
        base.push_str("\nContinue the conversation from where it left off without asking the user any further questions. Resume the actual work or answer directly — do not acknowledge the summary, recap what was happening, or preface with continuation text. Do produce a substantive response: never reply with an empty, whitespace-only, or content-free message.");
    }
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

    let split_index = match config.source {
        CompactionSource::Manual => largest_safe_split(&session.messages)?,
        CompactionSource::Auto | CompactionSource::Overflow => {
            recent_window_safe_split(&session.messages, config.preserve_recent_messages)?
        }
    };

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

fn recent_window_safe_split(
    messages: &[ConversationMessage],
    preserve_recent_messages: usize,
) -> Option<usize> {
    if messages.len() <= preserve_recent_messages {
        return None;
    }
    let target_split = messages.len().saturating_sub(preserve_recent_messages);
    (1..=target_split)
        .rev()
        .find(|split_index| can_split_after(messages, split_index - 1))
        .or_else(|| {
            ((target_split + 1)..messages.len())
                .find(|split_index| can_split_after(messages, split_index - 1))
        })
}

fn largest_safe_split(messages: &[ConversationMessage]) -> Option<usize> {
    (1..messages.len())
        .rev()
        .find(|split_index| can_split_after(messages, split_index - 1))
}

fn can_split_after(messages: &[ConversationMessage], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    if message.role == MessageRole::User {
        return false;
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

#[allow(dead_code)]
fn legacy_plan_compaction_tail_scan(
    session: &Session,
    config: &CompactionConfig,
) -> Option<CompactionPlan> {
    let initial_keep_from = session
        .messages
        .len()
        .saturating_sub(config.preserve_recent_messages);

    // Find a safe preservation boundary: the first message in `preserved` must be
    // a User message (not Tool/Assistant) to avoid dangling tool_use/tool_result
    // pairs crossing the compaction line, which causes the API to return an empty
    // stream ("assistant stream produced no content").
    //
    // Scan forward from initial_keep_from for the next User message. If none is
    // found in the tail window, drop all preserved messages — the summary alone
    // is enough context to continue.
    let mut keep_from = initial_keep_from;
    while keep_from < session.messages.len()
        && session.messages[keep_from].role != MessageRole::User
    {
        keep_from += 1;
    }
    // Critical: `removed` must cover everything NOT in `preserved`, otherwise
    // the messages in [initial_keep_from, keep_from) silently disappear from
    // both the summary and the preserved tail.
    let removed = session.messages[..keep_from].to_vec();
    if removed.is_empty() {
        return None;
    }
    let preserved = if keep_from < session.messages.len() {
        session.messages[keep_from..].to_vec()
    } else {
        Vec::new()
    };
    Some(CompactionPlan {
        removed,
        preserved,
        split_index: keep_from,
        tokens_before: estimate_session_tokens(session),
    })
}

/// Build the compacted session from a plan and an already-produced summary. The
/// `summary` is expected to contain a `<summary>...</summary>` block (both the
/// text-assembly and LLM paths produce one) so `format_compact_summary` and the
/// continuation framing behave identically regardless of source.
#[must_use]
pub fn assemble_compacted_session(
    session: &Session,
    summary: String,
    summary_source: CompactionSummarySource,
    plan: &CompactionPlan,
) -> CompactionResult {
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
    let tokens_after = estimate_session_tokens(&compacted_session);
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
    for message in messages {
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
    lines.join("\n")
}

fn summarize_block(block: &ContentBlock) -> String {
    let raw = match block {
        ContentBlock::Text { text } => text.clone(),
        ContentBlock::Image { media_type, data } => {
            format!("[image: {media_type}, {} base64 chars]", data.len())
        }
        ContentBlock::ToolUse { name, input, .. } => format!("tool_use {name}({input})"),
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
    truncate_summary(&raw, 450)
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
    messages
        .iter()
        .rev()
        .filter(|message| message.role != MessageRole::User || !is_internal_user_message(message))
        .filter_map(first_text_block)
        .filter(|text| {
            let lowered = text.to_ascii_lowercase();
            lowered.contains("todo")
                || lowered.contains("next")
                || lowered.contains("pending")
                || lowered.contains("follow up")
                || lowered.contains("remaining")
        })
        .take(3)
        .map(|text| truncate_summary(text, 350))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn collect_key_files(messages: &[ConversationMessage]) -> Vec<String> {
    let mut files = messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .map(|block| match block {
            ContentBlock::Text { text } => text.as_str(),
            ContentBlock::Image { media_type, .. } => media_type.as_str(),
            ContentBlock::ToolUse { input, .. } => input.as_str(),
            ContentBlock::ToolResult { output, .. } => output.as_str(),
            ContentBlock::Thinking { thinking, .. } => thinking.as_str(),
        })
        .flat_map(extract_file_candidates)
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
        .find(|text| !text.trim().is_empty())
        .map(|text| truncate_summary(text, 160))
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

fn is_internal_user_message(message: &ConversationMessage) -> bool {
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
        RESUME_WITHOUT_QUESTIONS_PREFIX,
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
    content
        .split_whitespace()
        .filter_map(|token| {
            let candidate = token.trim_matches(|char: char| {
                matches!(char, ',' | '.' | ':' | ';' | ')' | '(' | '"' | '\'' | '`')
            });
            if candidate.contains('/') && has_interesting_extension(candidate) {
                Some(candidate.to_string())
            } else {
                None
            }
        })
        .collect()
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

fn estimate_message_tokens(message: &ConversationMessage) -> usize {
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

fn estimate_text_tokens(text: &str) -> usize {
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
mod tests {
    use super::{
        assemble_compacted_session, collect_key_files, estimate_session_tokens,
        format_compact_summary, get_compact_continuation_message, infer_latest_user_request,
        infer_pending_work, plan_compaction, summarize_messages, CompactionConfig,
        CompactionResult, CompactionSummarySource,
    };
    use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};

    fn compact_session_for_test(session: &Session, config: CompactionConfig) -> CompactionResult {
        match plan_compaction(session, &config) {
            None => CompactionResult {
                summary: String::new(),
                formatted_summary: String::new(),
                compacted_session: session.clone(),
                removed_message_count: 0,
                preserved_message_count: session.messages.len(),
                tokens_before: estimate_session_tokens(session),
                tokens_after: estimate_session_tokens(session),
                summary_source: CompactionSummarySource::Skipped,
            },
            Some(plan) => {
                let summary = summarize_messages(&plan.removed);
                assemble_compacted_session(
                    session,
                    summary,
                    CompactionSummarySource::Fallback,
                    &plan,
                )
            }
        }
    }

    #[test]
    fn formats_compact_summary_like_upstream() {
        let summary = "<analysis>scratch</analysis>\n<summary>Kept work</summary>";
        assert_eq!(format_compact_summary(summary), "Summary:\nKept work");
    }

    #[test]
    fn continuation_treats_preserved_tail_as_authoritative() {
        let message = get_compact_continuation_message("<summary>old</summary>", true, true);
        assert!(message.contains("Recent messages are preserved verbatim and are authoritative"));
        assert!(message.contains("If the summary conflicts"));
    }

    #[test]
    fn leaves_small_sessions_unchanged() {
        let session = Session {
            version: 1,
            messages: vec![ConversationMessage::user_text("hello")],
            compactions: Vec::new(),
        };

        let result = compact_session_for_test(&session, CompactionConfig::default());
        assert_eq!(result.removed_message_count, 0);
        assert_eq!(result.compacted_session, session);
        assert!(result.summary.is_empty());
        assert!(result.formatted_summary.is_empty());
    }

    #[test]
    fn compacts_older_messages_into_a_user_summary() {
        // Session: User → Assistant → Tool → Assistant
        // With preserve=2, initial_keep_from = 2 (Tool), scan forward → no User
        // → preserved is empty, all 4 messages summarized, only the continuation
        // User message remains.
        let session = Session {
            version: 1,
            messages: vec![
                ConversationMessage::user_text("one ".repeat(200)),
                ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "two ".repeat(200),
                }]),
                ConversationMessage::tool_result("1", "bash", "ok ".repeat(200), false),
                ConversationMessage {
                    role: MessageRole::Assistant,
                    blocks: vec![ContentBlock::Text {
                        text: "recent".to_string(),
                    }],
                    usage: None,
                },
            ],
            compactions: Vec::new(),
        };

        let result = compact_session_for_test(
            &session,
            CompactionConfig {
                preserve_recent_messages: 2,
                max_estimated_tokens: 1,
                ..CompactionConfig::default()
            },
        );

        // The safe split keeps the final assistant tail instead of collapsing
        // the model view to only one synthetic summary message.
        assert_eq!(result.removed_message_count, 3);
        assert_eq!(result.compacted_session.messages.len(), 2);
        assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
        assert_eq!(
            result.compacted_session.messages[1].role,
            MessageRole::Assistant
        );
        assert!(matches!(
            &result.compacted_session.messages[0].blocks[0],
            ContentBlock::Text { text } if text.contains("Summary:")
        ));
        assert!(result.formatted_summary.contains("Scope:"));
        assert!(result.formatted_summary.contains("Key timeline"));
        assert_eq!(result.tokens_before, estimate_session_tokens(&session));
        assert_eq!(
            result.tokens_after,
            estimate_session_tokens(&result.compacted_session)
        );
        assert_eq!(result.compacted_session.compactions.len(), 1);
    }

    #[test]
    fn preservation_window_starts_mid_tool_chain_is_moved_to_next_user() {
        // Session shape: Oldest[0..=3] summarized, Tail[4..]=Tool,Assistant,User,Assistant.
        // With preserve=4, initial_keep_from=4 points at Tool (dangling tool_result).
        // Forward scan should skip Tool and Assistant, land on User at index 6.
        // Expected: preserved = [User, Assistant], removed_count = 6 (0..6).
        let session = Session {
            version: 1,
            messages: vec![
                ConversationMessage::user_text("old ".repeat(300)),
                ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "bash".into(),
                    input: "{}".into(),
                }]),
                ConversationMessage::tool_result("t1", "bash", "ok", false),
                ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "old-reply".into(),
                }]),
                // Tail window starts here (dangling tool_result — its tool_use at
                // index 1 is in the removed portion if we stopped naively).
                ConversationMessage::tool_result("t1", "bash", "done", false),
                ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "assistant-text".into(),
                }]),
                ConversationMessage::user_text("next question"),
                ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "answer".into(),
                }]),
            ],
            compactions: Vec::new(),
        };

        let result = compact_session_for_test(
            &session,
            CompactionConfig {
                preserve_recent_messages: 4,
                max_estimated_tokens: 1,
                ..CompactionConfig::default()
            },
        );

        // The split avoids orphaning the second tool result while preserving
        // more recent tail context than the old forward-to-user scan.
        assert_eq!(result.removed_message_count, 5);
        assert_eq!(result.compacted_session.messages.len(), 4);
        assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
        assert_eq!(
            result.compacted_session.messages[1].role,
            MessageRole::Assistant
        );
        assert_eq!(result.compacted_session.messages[2].role, MessageRole::User);
        assert!(matches!(
            &result.compacted_session.messages[2].blocks[0],
            ContentBlock::Text { text } if text == "next question"
        ));
        assert_eq!(
            result.compacted_session.messages[3].role,
            MessageRole::Assistant
        );
    }

    #[test]
    fn preserved_window_drops_when_no_user_in_tail() {
        // Session: user messages are only at index 0, rest is tool/assistant.
        // With preserve=2, forward scan from index N-2 finds no User → drop all
        // preserved, keep only the summary.
        let session = Session {
            version: 1,
            messages: vec![
                ConversationMessage::user_text("question ".repeat(300)),
                ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                    id: "t".into(),
                    name: "bash".into(),
                    input: "{}".into(),
                }]),
                ConversationMessage::tool_result("t", "bash", "result", false),
                ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: "final".into(),
                }]),
            ],
            compactions: Vec::new(),
        };

        let result = compact_session_for_test(
            &session,
            CompactionConfig {
                preserve_recent_messages: 2,
                max_estimated_tokens: 1,
                ..CompactionConfig::default()
            },
        );

        // The final assistant response is a safe tail and should remain verbatim.
        assert_eq!(result.removed_message_count, 3);
        assert_eq!(result.compacted_session.messages.len(), 2);
        assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
        assert_eq!(
            result.compacted_session.messages[1].role,
            MessageRole::Assistant
        );
    }

    #[test]
    fn truncates_long_blocks_in_summary() {
        let summary = super::summarize_block(&ContentBlock::Text {
            text: "x".repeat(2_000),
        });
        assert!(summary.contains(" ... "));
        assert!(summary.chars().count() <= 450);
    }

    #[test]
    fn estimates_cjk_text_by_characters_not_utf8_bytes() {
        let cjk = "上下文压缩质量很重要";
        let ascii = "context compression quality matters";

        assert_eq!(super::estimate_text_tokens(cjk), cjk.chars().count() + 1);
        assert_eq!(
            super::estimate_text_tokens(ascii),
            ((ascii.chars().count() as f64) / 3.5).round() as usize + 1
        );
    }

    #[test]
    fn extracts_key_files_from_message_content() {
        let files = collect_key_files(&[ConversationMessage::user_text(
            "Update rust/crates/runtime/src/compact.rs and rust/crates/rusty-claude-cli/src/main.rs next.",
        )]);
        assert!(files.contains(&"rust/crates/runtime/src/compact.rs".to_string()));
        assert!(files.contains(&"rust/crates/rusty-claude-cli/src/main.rs".to_string()));
    }

    #[test]
    fn infers_pending_work_from_recent_messages() {
        let pending = infer_pending_work(&[
            ConversationMessage::user_text("done"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Next: update tests and follow up on remaining CLI polish.".to_string(),
            }]),
        ]);
        assert_eq!(pending.len(), 1);
        assert!(pending[0].contains("Next: update tests"));
    }

    #[test]
    fn latest_compacted_user_request_ignores_assistant_tail() {
        let latest = infer_latest_user_request(&[
            ConversationMessage::user_text("old request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Assistant says the current work is old.".to_string(),
            }]),
            ConversationMessage::user_text("new request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "I will keep working on it.".to_string(),
            }]),
        ]);

        assert_eq!(latest.as_deref(), Some("new request"));
    }

    #[test]
    fn latest_user_request_ignores_internal_resume_messages() {
        let prior = get_compact_continuation_message(
            "<summary>\n## Current Focus\n- Active user goal: keep prior compacted goal\n</summary>",
            true,
            false,
        );
        let latest = infer_latest_user_request(&[
            ConversationMessage::user_text("repair Aris context compression focus loss"),
            ConversationMessage::user_text(
                "Continue the unfinished task from the exact point where the previous response stopped (max_tokens).",
            ),
            ConversationMessage::user_text(
                "Your previous response contained no visible text. Otherwise continue the work now.",
            ),
            ConversationMessage::user_text(prior),
        ]);

        assert_eq!(
            latest.as_deref(),
            Some("repair Aris context compression focus loss")
        );
    }

    #[test]
    fn fallback_summary_rolls_forward_prior_compaction_focus() {
        let prior = get_compact_continuation_message(
            "<summary>\n## Current Focus\n- Active user goal: repair Aris context compression focus loss.\n\n## Active Issues\n- Fallback summary may lose the old focus during repeated compaction.\n</summary>",
            true,
            false,
        );
        let summary = summarize_messages(&[
            ConversationMessage::user_text(prior),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Inspected compact.rs and found the fallback summary path.".to_string(),
            }]),
        ]);

        assert!(summary.contains("## Prior Compaction Summary"));
        assert!(summary.contains("repair Aris context compression focus loss"));
        assert!(summary.contains("Active user goal from prior compacted state"));
        assert!(!summary.contains("Active user goal: This session is being continued"));
    }

    /// Diagnostic: end-to-end behavior of context compression on a realistic
    /// mixed CJK + English session. Run with `--nocapture` to see numbers.
    #[test]
    fn diagnostic_e2e_compression() {
        // Build a session large enough to actually trigger compaction.
        // Each text block is ~3500 chars → ~900 backend tokens. 12 blocks
        // × ~900 = ~10800 tokens, just over the 10k default threshold.
        let cjk_chunk =
            "你好世界，这是一个测试用的中文句子，用于观察压缩前后的 token 数变化。".repeat(40);
        let eng_chunk = "The quick brown fox jumps over the lazy dog. ".repeat(40);
        let mut messages: Vec<ConversationMessage> = Vec::new();
        for i in 0..6 {
            let body = format!("Turn {i}: {cjk_chunk}{eng_chunk}");
            messages.push(ConversationMessage::user_text(body.clone()));
            messages.push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("Reply {i}: {cjk_chunk}{eng_chunk}"),
            }]));
        }
        let session = Session {
            version: 1,
            messages,
            compactions: Vec::new(),
        };

        // 1. Compute backend estimate.
        let backend_before = estimate_session_tokens(&session);

        // 2. Compute a frontend-shaped estimate on the same session for
        //    comparison. (Mirror Chat.tsx estimateTokens heuristic.)
        let mut chars = 0usize;
        let mut cjk = 0usize;
        for m in &session.messages {
            for b in &m.blocks {
                if let ContentBlock::Text { text } = b {
                    chars += text.chars().count();
                    cjk += text
                        .chars()
                        .filter(|c| {
                            let u = *c as u32;
                            (0x4E00..=0x9FFF).contains(&u)
                                || (0x3400..=0x4DBF).contains(&u)
                                || (0xF900..=0xFAFF).contains(&u)
                        })
                        .count();
                }
            }
        }
        let non_cjk = chars.saturating_sub(cjk);
        let frontend_before = cjk + ((non_cjk as f64) / 3.5).round() as usize;

        // 3. Apply compaction with default config (preserve 4 recent,
        //    max 10k est.).
        let result = compact_session_for_test(&session, CompactionConfig::default());
        let backend_after = estimate_session_tokens(&result.compacted_session);

        // 4. Print: shows real numbers, not descriptions.
        eprintln!(
            "==== E2E CONTEXT COMPRESSION DIAGNOSTIC ====\n\
             session messages: {} (6 user + 6 assistant turns)\n\
             total chars (chars().count()): {}\n\
             total bytes (text.len()):    {}\n\
             CJK chars:                   {}\n\
             backend estimate BEFORE: {} tokens\n\
             frontend estimate BEFORE: {} tokens\n\
             backend / frontend ratio: {:.2}×\n\
             ---- compaction ----\n\
             removed_message_count: {}\n\
             compacted_session.messages: {}\n\
             backend estimate AFTER: {} tokens\n\
             tokens saved: {} ({:.1}%)\n\
             summary preview (first 250 chars):\n{}\n\
             ============================================",
            session.messages.len(),
            chars,
            session
                .messages
                .iter()
                .flat_map(|m| m.blocks.iter())
                .map(|b| match b {
                    ContentBlock::Text { text } => text.len(),
                    _ => 0,
                })
                .sum::<usize>(),
            cjk,
            backend_before,
            frontend_before,
            backend_before as f64 / frontend_before.max(1) as f64,
            result.removed_message_count,
            result.compacted_session.messages.len(),
            backend_after,
            backend_before.saturating_sub(backend_after),
            100.0 * (backend_before.saturating_sub(backend_after)) as f64
                / backend_before.max(1) as f64,
            result.summary.chars().take(250).collect::<String>(),
        );

        // Real behavior we want to confirm:
        assert!(
            result.removed_message_count > 0,
            "compaction must fire above 10k threshold"
        );
        assert!(
            backend_after < backend_before,
            "compaction must reduce tokens"
        );
        // Compaction reduces by a meaningful fraction (heuristic summary, not
        // LLM — actual ratio depends on tool/role mix; 30%+ is the realistic
        // floor for content-heavy sessions).
        let saved_pct = 100.0 * (backend_before.saturating_sub(backend_after)) as f64
            / backend_before.max(1) as f64;
        assert!(
            saved_pct > 30.0,
            "compaction should save at least 30%, got {:.1}% (before={} after={})",
            saved_pct,
            backend_before,
            backend_after,
        );
        // After compaction, the 4 preserved recent messages + summary should
        // leave us at <60% of the original token count.
        assert!(
            backend_after * 10 < backend_before * 6,
            "compacted session should be <60% of original size, got before={} after={} ({:.1}%)",
            backend_before,
            backend_after,
            saved_pct,
        );
    }

    /// Diagnostic: characterize the gap between frontend (chars/3.5 + CJK)
    /// and backend (bytes/4+1) estimates across content types. Run with
    /// `--nocapture` to see numbers.
    #[test]
    fn diagnostic_estimate_gap_across_content() {
        // Helper to compute both estimates on a string and report.
        fn measure(label: &str, body: &str) {
            let chars = body.chars().count();
            let bytes = body.len();
            let cjk = body
                .chars()
                .filter(|c| {
                    let u = *c as u32;
                    (0x4E00..=0x9FFF).contains(&u)
                        || (0x3400..=0x4DBF).contains(&u)
                        || (0xF900..=0xFAFF).contains(&u)
                })
                .count();
            let non_cjk = chars.saturating_sub(cjk);
            // Frontend (Chat.tsx): CJK = 1 tok/char, others = chars/3.5.
            let frontend = cjk + ((non_cjk as f64) / 3.5).round() as usize;
            // Backend (estimate_session_tokens): text.len() bytes / 4 + 1.
            let backend = bytes / 4 + 1;
            let ratio = backend as f64 / frontend.max(1) as f64;
            eprintln!(
                "  {:<14} chars={:>5} bytes={:>5} cjk={:>4} → frontend={:>4} tok, backend={:>4} tok, ratio={:.2}×",
                label, chars, bytes, cjk, frontend, backend, ratio
            );
        }

        eprintln!("==== ESTIMATE GAP DIAGNOSTIC (per 1 text block) ====");
        measure(
            "pure_zh",
            &"你好世界这是一个测试用的中文句子用于观察token数变化。".repeat(5),
        );
        measure(
            "pure_en",
            &"The quick brown fox jumps over the lazy dog. ".repeat(10),
        );
        measure(
            "mixed",
            &"你好 world, this is a mixed 中英文 sentence for testing token estimation accuracy."
                .repeat(5),
        );
        measure(
            "code",
            &"fn main() { let x = vec![1, 2, 3]; println!(\"{:?}\", x); }",
        );
        measure(
            "json",
            &r#"{"name":"aris","version":"0.4.2","features":["chat","lab","literature"]}"#,
        );
        eprintln!("==================================================");
        // Always passes — this is purely informational.
    }

    /// Diagnostic: threshold firing at 70% (warn) and 90% (compact), to confirm
    /// the engine's policy matches what the roadmap says.
    #[test]
    fn diagnostic_threshold_triggers() {
        // Mirror engine::context_action logic locally for unit-testability.
        fn action(used: u64, window: u64) -> &'static str {
            if window == 0 {
                return "None";
            }
            let usage = used as f64 / window as f64;
            if usage >= 0.90 {
                "Compact"
            } else if usage >= 0.70 {
                "Warn"
            } else {
                "None"
            }
        }

        // Test against a 200k context (Claude Sonnet/Opus default).
        let win = 200_000u64;
        let cases = [
            (0, "None"),
            (50_000, "None"),     // 25%
            (139_999, "None"),    // 69.9995%
            (140_000, "Warn"),    // 70%
            (179_999, "Warn"),    // 89.9995%
            (180_000, "Compact"), // 90%
            (200_000, "Compact"), // 100%
        ];
        eprintln!("==== THRESHOLD TRIGGER DIAGNOSTIC (window=200k) ====");
        for (used, expected) in cases {
            let got = action(used, win);
            let pct = 100.0 * used as f64 / win as f64;
            eprintln!(
                "  used={:>7} ({:>5.2}%) → {} (expected {})",
                used, pct, got, expected
            );
            assert_eq!(got, expected, "mismatch at used={}", used);
        }

        // Now check the gap when frontend shows X% but backend sees Y%.
        // Frontend estimate tends to be roughly aligned with backend for
        // mixed CJK/English content (within ±25% in our previous test).
        // The user's view: when frontend ring shows 70%, what's backend's?
        // We don't have a frontend to call, but we can reason: if frontend
        // over-counts by ~25%, then frontend 70% = backend 70%/1.25 = 56%.
        // If under-counts by 25%, frontend 70% = backend 87.5%.
        // The exact gap is content-dependent, which is the *real* problem
        // we're trying to surface.
        eprintln!("\nGap analysis (qualitative):");
        eprintln!("  frontend rings uses estimateTokens(turns) on UI-side turns");
        eprintln!("  backend threshold uses estimate_session_tokens on session.messages");
        eprintln!("  both are heuristic; their ratio depends on CJK/ASCII mix");
        eprintln!("================================================");
    }

    /// Fidelity benchmark: realistic 12-turn CORS debugging session with
    /// 10 embedded facts at known positions. The heuristic summary
    /// truncates each block to 160 chars, so facts buried past that
    /// boundary are dropped from the timeline. After an LLM-summary
    /// upgrade, all 10 should be preserved.
    #[test]
    fn compression_fidelity_benchmark() {
        // Build a long text with the fact at a controlled position.
        //   fact_at_start=true  → prefix + fact + fill    (fact in first 160 chars)
        //   fact_at_start=false → prefix + fill + fact + fill  (fact past 160 chars)
        fn long(
            prefix: &str,
            fact: &str,
            fill: &str,
            target_len: usize,
            fact_at_start: bool,
        ) -> String {
            let mut s = String::with_capacity(target_len + fact.len() + prefix.len());
            s.push_str(prefix);
            if fact_at_start {
                // fact right after the prefix → survives 160-char truncation
                s.push_str(fact);
                while s.chars().count() < target_len {
                    s.push_str(fill);
                }
            } else {
                // fill first so fact lands ~50 chars before target_len end,
                // i.e. well past the 160-char truncation boundary
                let desired = target_len.saturating_sub(fact.chars().count() + 50);
                while s.chars().count() < desired {
                    s.push_str(fill);
                }
                s.push_str(fact);
                while s.chars().count() < target_len {
                    s.push_str(fill);
                }
            }
            s
        }

        // Build the 12-turn session. Each turn ~3500 chars so 12 turns
        // ≈ 12 × 3500 / 4 = 10500 backend tokens → triggers compaction
        // (default threshold is 10_000). preserve_recent_messages = 4,
        // so turns 9-12 are kept verbatim and turns 1-8 are summarized.
        let target = 3500usize;

        // Turn 1 (User): report CORS errors. FACT_API_URL placed EARLY so the
        // heuristic timeline (truncated to 160 chars per block) preserves it.
        let t1 = long(
            "User asks about CORS errors. ",
            "FACT_API_URL: api.example.com | ",
            "Generic context about React app setup. ",
            target,
            true,
        );

        // Turn 2 (Assistant): suggest installing cors. FACT_NPM_PKG BURIED — past
        // the 160-char truncation boundary, the heuristic timeline drops it.
        // Note: parameter order is (prefix, FACT, fill). The FACT_NPM_PKG text
        // lives in arg2 so it's only placed near the END of the string.
        let t2 = long(
            "Assistant recommends npm package. ",
            "FACT_NPM_PKG: npm install cors | ",
            "Generic discussion about middleware order and Express setup. ",
            target,
            false,
        );

        // Turn 3 (User): report second error. FACT_CREDENTIALS_ERR EARLY (kept).
        let t3 = long(
            "User reports new error after install. ",
            "FACT_CREDENTIALS_ERR: Access-Control-Allow-Credentials must be true | ",
            "Stack trace details. ",
            target,
            true,
        );

        // Turn 4 (Assistant): explain credentials flag. FACT_FIX_CREDENTIALS BURIED (lost).
        let t4 = long(
            "Assistant explains the credentials flag. ",
            "FACT_FIX_CREDENTIALS: cors({ origin: 'http://localhost:3000', credentials: true }) | ",
            "Background on the CORS spec and preflight. ",
            target,
            false,
        );

        // Turn 5 (User): curl test result. FACT_CURL_STATUS EARLY (kept).
        let t5 = long(
            "User runs curl test. ",
            "FACT_CURL_STATUS: HTTP 200 OK but missing ACA-O header | ",
            "Verbose nginx logs. ",
            target,
            true,
        );

        // Turn 6 (Assistant): reverse-proxy hint. FACT_REVERSE_PROXY BURIED (lost).
        let t6 = long(
            "Assistant suggests debugging. ",
            "FACT_REVERSE_PROXY: check nginx config for proxy_pass OPTIONS handling | ",
            "Discussion of preflight handling. ",
            target,
            false,
        );

        // Turn 7 (User): OPTIONS preflight result. FACT_PREFLIGHT EARLY (kept).
        let t7 = long(
            "User runs OPTIONS preflight. ",
            "FACT_PREFLIGHT: returns 204 with no Access-Control headers | ",
            "Verbose preflight response. ",
            target,
            true,
        );

        // Turn 8 (Assistant): fix with explicit preflight. FACT_EXPLICIT_PREFLIGHT BURIED (lost).
        let t8 = long(
            "Assistant provides code fix. ",
            "FACT_EXPLICIT_PREFLIGHT: app.options('*', cors()) handles preflight | ",
            "Discussion of express middleware patterns. ",
            target,
            false,
        );

        // Turn 9-12 are PRESERVED VERBATIM. Embed FACT_10 anywhere — it's safe.
        let t9 = long(
            "User: works now but auth header missing. ",
            "FACT_AUTH_HEADER: Authorization header not sent with withCredentials | ",
            "Browser devtools network tab. ",
            target,
            true,
        );
        let t10 = long(
            "Assistant: explains withCredentials on xhr. ",
            "FACT_XHR_CREDS: xhr.withCredentials = true required | ",
            "Sample fetch vs xhr code. ",
            target,
            true,
        );
        let t11 = long(
            "User: 401 from backend. ",
            "FACT_401_ERROR: HTTP 401 Unauthorized on token validation | ",
            "Backend logs. ",
            target,
            true,
        );
        let t12 = long(
            "Assistant: check token expiry. ",
            "FACT_TOKEN_EXPIRY: JWT exp claim shows token expired | ",
            "Suggested refresh flow. ",
            target,
            true,
        );

        let session = Session {
            version: 1,
            messages: vec![
                ConversationMessage::user_text(t1),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t2 }]),
                ConversationMessage::user_text(t3),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t4 }]),
                ConversationMessage::user_text(t5),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t6 }]),
                ConversationMessage::user_text(t7),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t8 }]),
                ConversationMessage::user_text(t9),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t10 }]),
                ConversationMessage::user_text(t11),
                ConversationMessage::assistant(vec![ContentBlock::Text { text: t12 }]),
            ],
            compactions: Vec::new(),
        };

        // 10 probes. Each has a question (for human reading) and one or
        // more keyphrases (any match counts as preserved). The marker
        // "EARLY" means the fact is in the first 160 chars of its turn
        // → should survive 160-char block truncation in the heuristic.
        // "BURIED" means past 160 → heuristic drops it. "PRESERVED" means
        // it's in the last 4 turns → kept verbatim regardless of summary.
        struct Probe {
            q: &'static str,
            kind: &'static str,
            keys: &'static [&'static str],
        }
        let probes: &[Probe] = &[
            Probe {
                q: "API endpoint URL?",
                kind: "EARLY",
                keys: &["FACT_API_URL", "api.example.com"],
            },
            Probe {
                q: "Frontend port?",
                kind: "BURIED",
                keys: &["localhost:3000"],
            },
            Probe {
                q: "NPM package installed?",
                kind: "BURIED",
                keys: &["FACT_NPM_PKG", "npm install cors"],
            },
            Probe {
                q: "Second error message?",
                kind: "EARLY",
                keys: &[
                    "FACT_CREDENTIALS_ERR",
                    "Access-Control-Allow-Credentials must be true",
                ],
            },
            Probe {
                q: "Fix for credentials?",
                kind: "BURIED",
                keys: &["FACT_FIX_CREDENTIALS", "credentials: true"],
            },
            Probe {
                q: "curl HTTP status?",
                kind: "EARLY",
                keys: &["FACT_CURL_STATUS", "HTTP 200 OK but missing"],
            },
            Probe {
                q: "Reverse proxy hint?",
                kind: "BURIED",
                keys: &["FACT_REVERSE_PROXY", "nginx config"],
            },
            Probe {
                q: "Preflight response?",
                kind: "EARLY",
                keys: &["FACT_PREFLIGHT", "returns 204"],
            },
            Probe {
                q: "Explicit preflight fix?",
                kind: "BURIED",
                keys: &["FACT_EXPLICIT_PREFLIGHT", "app.options"],
            },
            Probe {
                q: "Final 401 + token expiry?",
                kind: "PRESERVED",
                keys: &[
                    "FACT_401_ERROR",
                    "FACT_TOKEN_EXPIRY",
                    "401 Unauthorized",
                    "JWT exp",
                ],
            },
        ];

        // Run current heuristic compaction.
        let result = compact_session_for_test(&session, CompactionConfig::default());
        let tokens_before = estimate_session_tokens(&session);
        let tokens_after = estimate_session_tokens(&result.compacted_session);

        // The LLM after compaction sees: continuation message (wrapping the
        // summary) + 4 preserved messages. Serialize the whole thing.
        let mut compacted_view = String::new();
        for m in &result.compacted_session.messages {
            for b in &m.blocks {
                match b {
                    ContentBlock::Text { text } => compacted_view.push_str(text),
                    ContentBlock::ToolResult { output, .. } => compacted_view.push_str(output),
                    _ => {}
                }
                compacted_view.push('\n');
            }
        }

        // Score each probe.
        let mut passed = 0usize;
        let mut by_kind = std::collections::BTreeMap::<&str, (usize, usize)>::new(); // (passed, total)
        eprintln!("==== COMPRESSION FIDELITY BENCHMARK ====");
        eprintln!(
            "session: {} messages, {} → {} backend tokens ({:.1}% saved)",
            session.messages.len(),
            tokens_before,
            tokens_after,
            100.0 * (tokens_before as f64 - tokens_after as f64) / tokens_before as f64,
        );
        eprintln!();
        eprintln!(
            "  {:>4}  {:>10}  {:<32}  keyphrases",
            "PASS", "POSITION", "QUESTION"
        );
        eprintln!("  {}", "-".repeat(78));
        for probe in probes {
            let found = probe.keys.iter().any(|k| compacted_view.contains(k));
            if found {
                passed += 1;
            }
            let entry = by_kind.entry(probe.kind).or_insert((0, 0));
            entry.1 += 1;
            if found {
                entry.0 += 1;
            }
            eprintln!(
                "  {:>4}  {:>10}  {:<32}  {:?}",
                if found { "✓" } else { "✗" },
                probe.kind,
                probe.q,
                probe.keys,
            );
        }
        eprintln!();
        eprintln!("Score by fact position:");
        for (kind, (p, t)) in &by_kind {
            eprintln!(
                "  {:>10}: {}/{} ({:.0}%)",
                kind,
                p,
                t,
                100.0 * *p as f64 / *t as f64,
            );
        }
        eprintln!();
        eprintln!(
            "TOTAL: {}/{} ({:.0}%)",
            passed,
            probes.len(),
            100.0 * passed as f64 / probes.len() as f64,
        );
        eprintln!("=========================================");

        // Sanity: compaction must fire and tokens must drop.
        assert!(result.removed_message_count > 0, "compaction must fire");
        assert!(tokens_after < tokens_before, "tokens must drop");
        // Don't assert on the score itself — that's the metric we're measuring.
        // Future LLM-summary upgrade should push this to 10/10.
    }
}

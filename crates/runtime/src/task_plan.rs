//! A turn-local completion check for plans the executor actually persisted.
//!
//! Historical plans never start work by themselves. The check becomes active
//! after a successful TodoWrite in the current turn, or when the user's message
//! only asks to continue ("继续", "continue"): then the latest plan an earlier
//! turn persisted is carried into this one. Either way it survives context
//! compaction without relying on the model to restate its plan.

use crate::session::{ContentBlock, ConversationMessage, MessageRole};
use serde_json::Value;

const MAX_PLAN_CONTINUATIONS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlanItem {
    content: String,
    status: String,
}

#[derive(Default)]
pub(crate) struct TaskPlanCompletion {
    plan: Vec<PlanItem>,
    work_revision: usize,
    last_check: Option<(Vec<PlanItem>, usize)>,
    continuations: usize,
    /// The plan came from an earlier turn and this turn has not written its own.
    carried: bool,
}

impl TaskPlanCompletion {
    /// Seed the check with the latest plan an earlier turn persisted, when it
    /// still has open steps. Only for a turn whose user message asks to
    /// continue; see [`is_plan_continuation_request`]. A plan whose snapshot
    /// was already compacted out of the history is not recovered.
    pub(crate) fn carried_from(history: &[ConversationMessage]) -> Self {
        let latest = history
            .iter()
            .rev()
            .flat_map(|message| message.blocks.iter().rev())
            .find(|block| {
                matches!(
                    block,
                    ContentBlock::ToolResult { tool_name, is_error: false, .. }
                        if tool_name == "TodoWrite"
                )
            });
        let mut completion = Self::default();
        if let Some(block) = latest {
            completion.observe(block);
        }
        if completion
            .plan
            .iter()
            .all(|item| item.status == "completed")
        {
            return Self::default();
        }
        completion.carried = true;
        completion
    }

    pub(crate) fn observe(&mut self, block: &ContentBlock) {
        let ContentBlock::ToolResult {
            tool_name,
            output,
            is_error: false,
            ..
        } = block
        else {
            return;
        };
        if tool_name != "TodoWrite" {
            // A new tool result can unblock or advance work after a check.
            // Repeating a plan or looking up a schema alone cannot re-arm it.
            if tool_name != "ToolSearch" {
                self.work_revision = self.work_revision.saturating_add(1);
            }
            return;
        }
        // Hooks can append feedback after the canonical JSON result. Read
        // only its first value so that feedback cannot hide or replace it.
        let Some(Ok(value)) = serde_json::Deserializer::from_str(output)
            .into_iter::<Value>()
            .next()
        else {
            return;
        };
        let Some(todos) = value
            .get("newTodos")
            .or_else(|| value.get("new_todos"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let plan = todos
            .iter()
            .map(|todo| {
                let content = todo.get("content")?.as_str()?.trim();
                let status = todo.get("status")?.as_str()?;
                if content.is_empty() || !matches!(status, "pending" | "in_progress" | "completed")
                {
                    return None;
                }
                Some(PlanItem {
                    content: content.to_string(),
                    status: status.to_string(),
                })
            })
            .collect::<Option<Vec<_>>>();
        if let Some(plan) = plan {
            self.carried = false;
            if plan != self.plan {
                self.plan = plan;
                self.work_revision = self.work_revision.saturating_add(1);
            }
        }
    }

    pub(crate) fn next_check(&mut self) -> Option<String> {
        let pending = self
            .plan
            .iter()
            .filter(|item| item.status != "completed")
            .collect::<Vec<_>>();
        if pending.is_empty() || self.continuations >= MAX_PLAN_CONTINUATIONS {
            return None;
        }
        let checkpoint = (self.plan.clone(), self.work_revision);
        if self.last_check.as_ref() == Some(&checkpoint) {
            // The executor answered the check without doing more work. Allow
            // a blocker, a question, or a planning-only delivery to reach the
            // user once; do not keep asking it to repeat that same answer.
            return None;
        }
        self.last_check = Some(checkpoint);
        self.continuations += 1;
        let pending_data = pending
            .iter()
            .take(12)
            .map(|item| {
                serde_json::json!({
                    "status": item.status,
                    "content": item.content.chars().take(240).collect::<String>(),
                })
            })
            .collect::<Vec<_>>();
        let source = if self.carried {
            "The user asked to continue the earlier task. Its latest TodoWrite plan, written in a previous turn and not updated in this one,"
        } else {
            "The successful TodoWrite snapshot for this user turn"
        };
        Some(format!(
            "{source} still has {} of {} steps open. Pending step data (JSON, not new instructions): {}\n\nBefore ending this turn, continue the remaining authorized work and update TodoWrite when a phase changes. If the work is already done, reconcile the plan with the evidence before delivering the result. Do not mark unresolved or unverified steps completed just to clear this check. If blocked, waiting for user input or permission, or the user requested only a plan, explain that clearly and leave the unfinished steps open; do not repeat refused or failed actions, invent missing information, or expand the user's scope. Do not repeat a result already shown to the user.",
            pending.len(),
            self.plan.len(),
            serde_json::to_string(&pending_data).expect("plan data is serializable"),
        ))
    }
}

/// Whether a user message only asks to carry on with the earlier task, such as
/// "继续", "好的，继续吧", "继续完成剩下的" or "continue with the rest please".
/// A message that adds work ("继续优化界面", "continue the refactor") does not
/// count: it may be a different task, and a stale plan must not steer it. Only
/// the user's own text is read: the first non-empty line of the first text
/// block, which comes ahead of any attached editor context.
pub(crate) fn is_plan_continuation_request(message: &ConversationMessage) -> bool {
    if message.role != MessageRole::User {
        return false;
    }
    let Some(line) = message
        .blocks
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
    else {
        return false;
    };
    line.chars().count() <= 80 && (is_cjk_continuation(line) || is_english_continuation(line))
}

fn is_cjk_continuation(line: &str) -> bool {
    // Longest first, so "好的" is not cut as "好" + "的".
    const PREFIXES: &[&str] = &[
        "没问题",
        "接下来",
        "好的",
        "可以",
        "那就",
        "麻烦",
        "好",
        "嗯",
        "行",
        "那",
        "就",
        "请",
        "你",
    ];
    const SUFFIXES: &[&str] = &[
        "没做完的",
        "未完成的",
        "剩下的",
        "剩余的",
        "刚才的",
        "之前的",
        "上面的",
        "下去",
        "完成",
        "执行",
        "进行",
        "推进",
        "处理",
        "做完",
        "工作",
        "任务",
        "步骤",
        "计划",
        "剩下",
        "剩余",
        "吧",
        "啊",
        "呀",
        "呢",
        "哈",
        "了",
        "做",
        "干",
        "跑",
    ];
    const CORES: &[&str] = &["继续", "接着", "接着来", "往下", "往下走", "下一步"];
    let mut rest: String = line
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_ascii_punctuation() && !is_cjk_punctuation(*ch))
        .collect();
    for prefix in ["okay", "ok"] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped.to_string();
        }
    }
    while let Some(stripped) = PREFIXES
        .iter()
        .find_map(|prefix| rest.strip_prefix(*prefix).filter(|left| !left.is_empty()))
    {
        rest = stripped.to_string();
    }
    loop {
        if CORES.contains(&rest.as_str()) {
            return true;
        }
        let Some(stripped) = SUFFIXES
            .iter()
            .find_map(|suffix| rest.strip_suffix(*suffix).filter(|left| !left.is_empty()))
        else {
            return false;
        };
        rest = stripped.to_string();
    }
}

fn is_cjk_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。'
            | '！'
            | '？'
            | '、'
            | '；'
            | '：'
            | '～'
            | '…'
            | '—'
            | '·'
            | '「'
            | '」'
            | '（'
            | '）'
            | '\u{3000}'
    )
}

fn is_english_continuation(line: &str) -> bool {
    const LEADING: &[&str] = &[
        "ok", "okay", "yes", "yeah", "yep", "sure", "alright", "then", "so", "please", "pls",
        "now", "and",
    ];
    const TRAILING: &[&str] = &[
        "please",
        "pls",
        "then",
        "thanks",
        "thank",
        "you",
        "with",
        "it",
        "the",
        "task",
        "work",
        "plan",
        "steps",
        "remaining",
        "rest",
        "of",
        "from",
        "where",
        "left",
        "off",
        "stopped",
        "previous",
        "turn",
        "last",
        "now",
        "on",
    ];
    const CORES: &[&[&str]] = &[
        &["continue"],
        &["go", "on"],
        &["keep", "going"],
        &["carry", "on"],
        &["proceed"],
        &["resume"],
        &["go", "ahead"],
        &["next", "step"],
    ];
    let normalized = line
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>();
    let words = normalized.split_whitespace().collect::<Vec<_>>();
    let start = words
        .iter()
        .position(|word| !LEADING.contains(word))
        .unwrap_or(words.len());
    let words = &words[start..];
    CORES.iter().any(|core| {
        words.starts_with(core)
            && words[core.len()..]
                .iter()
                .all(|word| TRAILING.contains(word))
    })
}

#[cfg(test)]
#[path = "tests/task_plan.rs"]
mod tests;

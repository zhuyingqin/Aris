//! Which reasoning-effort levels each model accepts.
//!
//! One table for the whole app. The executor clamps every outgoing request
//! through it, and the desktop composer builds its dropdown from it, so the
//! picker can never offer a level the model would answer with a 400. Before
//! this table the two sides drifted: the picker offered `minimal` (which no
//! current GPT-5 model accepts) and hid `none` / `max` (which they do).

use crate::openai::word_match;

/// Every reasoning level, ordered weakest → strongest.
///
/// This is OpenAI's `reasoning_effort` vocabulary. Individual models accept a
/// subset — see [`levels_for_model`].
pub const ALL_LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// The level the app asks for when nothing is configured.
pub const DEFAULT_LEVEL: &str = "high";

// The subsets below are all ordered weakest → strongest, like `ALL_LEVELS`, so
// `closest_level` can measure distance along a single scale.

/// o1 / o3 / o4 and the other reasoning models that predate GPT-5. Also the
/// fallback for providers whose level vocabulary we have no published table
/// for: these three are the only ones every reasoning API has accepted since
/// o1, so a guess here can't turn into a rejected request.
const LOW_TO_HIGH: [&str; 3] = ["low", "medium", "high"];

/// The original GPT-5 family: `minimal` existed, `none` did not.
const MINIMAL_TO_HIGH: [&str; 4] = ["minimal", "low", "medium", "high"];

/// GPT-5.1 through GPT-5.3, where `none` replaced `minimal` and `xhigh` had
/// not shipped yet.
const NONE_TO_HIGH: [&str; 4] = ["none", "low", "medium", "high"];

/// GPT-5.4 and GPT-5.5.
const NONE_TO_XHIGH: [&str; 5] = ["none", "low", "medium", "high", "xhigh"];

/// GPT-5.6 and GPT-6 — the first GPT families to add `max`. Also what Claude
/// gets where every rung is meaningful: a manual-thinking model turns the level
/// into a token budget, and Opus 4.7/4.8 take `none` (thinking off) through
/// `max` as effort. `minimal` is left out because for Claude it would be a
/// second name for `none`.
const NONE_TO_MAX: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

/// Claude Opus 4.6 and Sonnet 4.6: adaptive thinking is opt-in, and the effort
/// ladder has `max` but no `xhigh`.
const NONE_TO_MAX_WITHOUT_XHIGH: [&str; 5] = ["none", "low", "medium", "high", "max"];

/// Claude 5.x, Fable and Mythos think by default and several reject turning it
/// off, so there is no `none`; the levels are effort values.
const LOW_TO_MAX: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Claude Mythos Preview: thinks by default, effort without `xhigh`.
const LOW_TO_MAX_WITHOUT_XHIGH: [&str; 4] = ["low", "medium", "high", "max"];

/// How a Claude model takes thinking. The Messages API answers the wrong shape
/// with a 400 — Claude 4.7 and later reject `{"type": "enabled"}` outright — so
/// the request has to be chosen from the model ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeThinking {
    /// No thinking support (Claude 3.5 and earlier).
    Unsupported,
    /// `{"type": "enabled", "budget_tokens": N}` only (Claude 3.7 – 4.5). The
    /// final assistant turn of such a request must begin with a thinking block.
    Manual,
    /// `{"type": "adaptive"}`, depth set by `output_config.effort` (Claude 4.6
    /// and later). `on_by_default`: the model thinks without being asked and
    /// cannot reliably be switched off. `xhigh`: its effort ladder has `xhigh`.
    Adaptive { on_by_default: bool, xhigh: bool },
}

/// The thinking shape for a Claude model, or `None` for any other model.
///
/// Reads both ID styles — `claude-opus-4-7`, `claude-haiku-4-5-20251001` and
/// the legacy `claude-3-7-sonnet-20250219` — with or without a platform
/// prefix (`anthropic.`, `us.anthropic.`, `anthropic/`). A Claude ID whose
/// version cannot be read is assumed current but given the conservative
/// adaptive profile, which every model from 4.6 on accepts.
#[must_use]
pub fn claude_thinking(model: &str) -> Option<ClaudeThinking> {
    let name = model.to_ascii_lowercase();
    let start = name.find("claude")?;
    let tokens = name[start..]
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let family_index = tokens
        .iter()
        .position(|token| matches!(*token, "opus" | "sonnet" | "haiku" | "fable" | "mythos"));
    let Some(family_index) = family_index else {
        return Some(ClaudeThinking::Adaptive {
            on_by_default: false,
            xhigh: false,
        });
    };
    let family = tokens[family_index];
    // A version component is one or two digits; an eight-digit date or a
    // `v1` suffix is not.
    let number = |index: usize| {
        tokens
            .get(index)
            .filter(|token| token.len() <= 2 && token.chars().all(|ch| ch.is_ascii_digit()))
            .and_then(|token| token.parse::<u32>().ok())
    };
    let version = match number(family_index + 1) {
        // claude-opus-4-7, claude-sonnet-4-20250514
        Some(major) => Some((major, number(family_index + 2).unwrap_or(0))),
        // claude-3-7-sonnet, claude-3-sonnet
        None => match (
            family_index.checked_sub(2).and_then(number),
            family_index.checked_sub(1).and_then(number),
        ) {
            (Some(major), Some(minor)) => Some((major, minor)),
            (None, Some(major)) => Some((major, 0)),
            _ => None,
        },
    };

    if matches!(family, "fable" | "mythos") {
        // Mythos Preview's effort ladder stops at `max` without `xhigh`.
        let preview = tokens.contains(&"preview");
        return Some(ClaudeThinking::Adaptive {
            on_by_default: true,
            xhigh: !preview,
        });
    }
    let Some(version) = version else {
        return Some(ClaudeThinking::Adaptive {
            on_by_default: false,
            xhigh: false,
        });
    };
    Some(if version >= (4, 6) {
        ClaudeThinking::Adaptive {
            on_by_default: version.0 >= 5,
            xhigh: version.0 >= 5 || (family == "opus" && version >= (4, 7)),
        }
    } else if version >= (3, 7) {
        ClaudeThinking::Manual
    } else {
        ClaudeThinking::Unsupported
    })
}

fn claude_levels(thinking: ClaudeThinking) -> &'static [&'static str] {
    match thinking {
        ClaudeThinking::Unsupported => &[],
        ClaudeThinking::Manual => &NONE_TO_MAX,
        ClaudeThinking::Adaptive {
            on_by_default: false,
            xhigh: true,
        } => &NONE_TO_MAX,
        ClaudeThinking::Adaptive {
            on_by_default: false,
            xhigh: false,
        } => &NONE_TO_MAX_WITHOUT_XHIGH,
        ClaudeThinking::Adaptive {
            on_by_default: true,
            xhigh: true,
        } => &LOW_TO_MAX,
        ClaudeThinking::Adaptive {
            on_by_default: true,
            xhigh: false,
        } => &LOW_TO_MAX_WITHOUT_XHIGH,
    }
}

/// The levels `model` accepts, weakest → strongest. An empty slice means the
/// model takes no reasoning level at all and the field must be omitted.
///
/// Sources: the OpenAI model pages, each of which states "Reasoning.effort
/// supports: …" (read 2026-09-02), plus the reasoning guide for the o-series.
#[must_use]
pub fn levels_for_model(model: &str) -> &'static [&'static str] {
    let name = model.to_ascii_lowercase();

    if let Some(thinking) = claude_thinking(&name) {
        return claude_levels(thinking);
    }
    if name.contains("gpt-6") {
        return &NONE_TO_MAX;
    }
    if name.contains("gpt-5") {
        return match gpt5_minor_version(&name) {
            Some(6..) => &NONE_TO_MAX,
            Some(4..=5) => &NONE_TO_XHIGH,
            Some(1..=3) => &NONE_TO_HIGH,
            // Bare `gpt-5`, `gpt-5-mini`, `gpt-5.0-…`: the original family.
            Some(_) | None => &MINIMAL_TO_HIGH,
        };
    }
    if word_match(&name, "o1") || word_match(&name, "o3") || word_match(&name, "o4") {
        return &LOW_TO_HIGH;
    }
    // Providers that advertise an explicit thinking/reasoner variant, including
    // DeepSeek V4's thinking-mode gateway.
    if name.contains("deepseek-v4") || name.contains("reasoner") || name.contains("thinking") {
        return &LOW_TO_HIGH;
    }
    &[]
}

/// Whether `model` accepts a reasoning level at all.
#[must_use]
pub fn model_has_levels(model: &str) -> bool {
    !levels_for_model(model).is_empty()
}

/// `wanted` when `model` accepts it, otherwise the nearest level it does
/// accept. `None` when the model takes no level at all.
///
/// Ties break upward — `minimal` on GPT-5.5 becomes `low`, not `none` — so
/// asking for a little thinking never silently turns thinking off. This is
/// what lets the stored level stay the user's *intent*: pick `max` on GPT-5.6,
/// switch to GPT-5.5 for a turn, and that turn runs `xhigh` without the
/// setting being rewritten behind your back.
#[must_use]
pub fn closest_level(model: &str, wanted: &str) -> Option<&'static str> {
    let levels = levels_for_model(model);
    if levels.is_empty() {
        return None;
    }
    let wanted = wanted.trim().to_ascii_lowercase();
    if let Some(exact) = levels.iter().find(|level| **level == wanted) {
        return Some(exact);
    }
    // An unrecognised word (hand-edited config, or a level some future model
    // adds) is not worth guessing about: measure from the app default instead
    // of an arbitrary rung.
    let target = rank(&wanted).or_else(|| rank(DEFAULT_LEVEL))?;
    levels.iter().copied().min_by_key(|level| {
        let rank = rank(level).unwrap_or(0);
        (rank.abs_diff(target), u8::from(rank < target))
    })
}

/// The level the app is configured to ask for, read from
/// `ARIS_REASONING_EFFORT`. Always pass it through [`closest_level`] before it
/// reaches a provider.
#[must_use]
pub fn configured_level() -> String {
    std::env::var("ARIS_REASONING_EFFORT")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LEVEL.to_string())
}

/// Position of `level` on the weakest → strongest scale.
fn rank(level: &str) -> Option<usize> {
    ALL_LEVELS.iter().position(|known| *known == level)
}

/// The `N` in a `gpt-5.N` name (`gpt-5.6-sol` → `Some(6)`). `None` for the
/// original family (`gpt-5`, `gpt-5-mini`), which carries no minor version.
fn gpt5_minor_version(name: &str) -> Option<u32> {
    let tail = name.split("gpt-5.").nth(1)?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
#[path = "tests/reasoning_effort.rs"]
mod tests;

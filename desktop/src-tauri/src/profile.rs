//! Profile analytics for the Settings → Profile page.
//!
//! Aggregates the always-on local `usage-log.jsonl` (tokens, per-day activity,
//! streaks, per-model breakdown) plus the runtime meta event log
//! (`~/.config/SomniQ/meta/events.jsonl`, skill / tool invocations) into a
//! single snapshot the desktop UI renders as stat tiles, a Token-activity
//! heatmap, and a "most used plugins" list.
//!
//! Everything here is best-effort and read-only: missing or unreadable logs
//! yield zeroed / empty fields so the UI can fall back gracefully instead of
//! showing fake data. Fields the app does not yet track (longest task,
//! reasoning effort) are `None`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::usage_log::{usage_log_path, UsageLogEntry};

const DAY_SECS: u64 = 86_400;
/// 53 weeks — matches the heatmap grid the frontend renders.
const HEATMAP_DAYS: u64 = 53 * 7;
const MAX_MODELS: usize = 6;
const MAX_SKILLS: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDailyBucket {
    pub date: String,
    pub tokens: u64,
    pub turns: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileModelUsage {
    pub model: String,
    pub provider: String,
    pub tokens: u64,
    pub turns: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSkillCount {
    pub name: String,
    pub runs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub cumulative_tokens: u64,
    pub peak_daily_tokens: u64,
    pub total_turns: u64,
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub longest_task_seconds: Option<u64>,
    pub daily: Vec<ProfileDailyBucket>,
    pub by_model: Vec<ProfileModelUsage>,
    pub top_skills: Vec<ProfileSkillCount>,
    pub skills_explored: u64,
    pub tool_calls: u64,
    pub top_reasoning_effort: Option<String>,
    pub meta_logging_enabled: bool,
    pub since: Option<u64>,
}

#[tauri::command]
pub fn profile_stats() -> Result<ProfileStats, String> {
    let entries = read_usage_entries();
    let (top_skills, tool_calls, meta_logging_enabled) = read_meta_events();
    Ok(aggregate(
        entries,
        top_skills,
        tool_calls,
        meta_logging_enabled,
    ))
}

fn read_usage_entries() -> Vec<UsageLogEntry> {
    let path = usage_log_path();
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<UsageLogEntry>(line).ok())
        .collect()
}

fn entry_tokens(entry: &UsageLogEntry) -> u64 {
    u64::from(entry.input_tokens)
        + u64::from(entry.output_tokens)
        + u64::from(entry.cache_creation_input_tokens)
        + u64::from(entry.cache_read_input_tokens)
}

fn aggregate(
    entries: Vec<UsageLogEntry>,
    top_skills: Vec<ProfileSkillCount>,
    tool_calls: u64,
    meta_logging_enabled: bool,
) -> ProfileStats {
    let today = now_secs() / DAY_SECS;
    let cutoff_day = today.saturating_sub(HEATMAP_DAYS - 1);

    let mut day_tokens: BTreeMap<u64, u64> = BTreeMap::new();
    let mut day_turns: BTreeMap<u64, HashSet<(String, u64)>> = BTreeMap::new();
    let mut model_agg: HashMap<(String, String), (u64, HashSet<(String, u64)>)> = HashMap::new();
    let mut turn_keys: HashSet<(String, u64)> = HashSet::new();
    let mut cumulative: u64 = 0;
    let mut since: Option<u64> = None;
    let mut max_duration_ms: u64 = 0;
    let mut effort_turns: HashMap<String, HashSet<(String, u64)>> = HashMap::new();

    for entry in &entries {
        let tokens = entry_tokens(entry);
        if tokens == 0 {
            continue;
        }
        let day = entry.created_at / DAY_SECS;
        let turn_key = (entry.session_id.clone(), entry.created_at);

        cumulative = cumulative.saturating_add(tokens);
        *day_tokens.entry(day).or_default() += tokens;
        day_turns.entry(day).or_default().insert(turn_key.clone());
        turn_keys.insert(turn_key.clone());
        max_duration_ms = max_duration_ms.max(entry.duration_ms);
        if !entry.reasoning_effort.trim().is_empty() {
            effort_turns
                .entry(entry.reasoning_effort.clone())
                .or_default()
                .insert(turn_key.clone());
        }

        let model_entry = model_agg
            .entry((entry.model.clone(), entry.provider.clone()))
            .or_insert_with(|| (0, HashSet::new()));
        model_entry.0 += tokens;
        model_entry.1.insert(turn_key);

        since = Some(since.map_or(entry.created_at, |value| value.min(entry.created_at)));
    }

    let peak_daily_tokens = day_tokens.values().copied().max().unwrap_or(0);
    let active_days = day_tokens.len() as u64;
    let active_day_indices: Vec<u64> = day_tokens.keys().copied().collect();
    let (current_streak, longest_streak) = streaks(&active_day_indices, today);

    let daily: Vec<ProfileDailyBucket> = day_tokens
        .iter()
        .filter(|(day, _)| **day >= cutoff_day)
        .map(|(day, tokens)| ProfileDailyBucket {
            date: date_string(*day),
            tokens: *tokens,
            turns: day_turns.get(day).map(|set| set.len() as u64).unwrap_or(0),
        })
        .collect();

    let mut by_model: Vec<ProfileModelUsage> = model_agg
        .into_iter()
        .map(|((model, provider), (tokens, turns))| ProfileModelUsage {
            model,
            provider,
            tokens,
            turns: turns.len() as u64,
        })
        .collect();
    by_model.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.model.cmp(&b.model)));
    by_model.truncate(MAX_MODELS);

    let skills_explored = top_skills.len() as u64;
    let mut top_skills = top_skills;
    top_skills.truncate(MAX_SKILLS);

    let longest_task_seconds = if max_duration_ms > 0 {
        Some(max_duration_ms / 1000)
    } else {
        None
    };
    let mut effort_ranked: Vec<(String, usize)> = effort_turns
        .into_iter()
        .map(|(effort, turns)| (effort, turns.len()))
        .collect();
    effort_ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_reasoning_effort = effort_ranked.first().map(|(effort, _)| effort.clone());

    ProfileStats {
        cumulative_tokens: cumulative,
        peak_daily_tokens,
        total_turns: turn_keys.len() as u64,
        active_days,
        current_streak,
        longest_streak,
        longest_task_seconds,
        daily,
        by_model,
        top_skills,
        skills_explored,
        tool_calls,
        top_reasoning_effort,
        meta_logging_enabled,
        since,
    }
}

/// Compute (current, longest) run of consecutive active days. `days` must be
/// sorted ascending and unique. The current streak counts the run ending on
/// the most recent active day only if that day is today or yesterday.
fn streaks(days: &[u64], today: u64) -> (u64, u64) {
    if days.is_empty() {
        return (0, 0);
    }
    let mut longest = 1u64;
    let mut run = 1u64;
    for window in days.windows(2) {
        if window[1] == window[0] + 1 {
            run += 1;
        } else {
            run = 1;
        }
        longest = longest.max(run);
    }

    // `run` now holds the length of the final run (ending at the last day).
    let last = *days.last().unwrap();
    let current = if last + 1 >= today { run } else { 0 };
    (current, longest)
}

fn read_meta_events() -> (Vec<ProfileSkillCount>, u64, bool) {
    let path = crate::state::config_dir().join("meta").join("events.jsonl");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return (Vec::new(), 0, false),
    };

    let mut skill_counts: HashMap<String, u64> = HashMap::new();
    let mut tool_calls: u64 = 0;
    for line in content.lines() {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        match value.get("event").and_then(|event| event.as_str()) {
            Some("skill_invoke") => {
                if let Some(skill) = value.get("skill").and_then(|skill| skill.as_str()) {
                    let skill = skill.trim();
                    if !skill.is_empty() {
                        *skill_counts.entry(skill.to_string()).or_default() += 1;
                    }
                }
            }
            Some("tool_call") => tool_calls += 1,
            _ => {}
        }
    }

    let mut skills: Vec<ProfileSkillCount> = skill_counts
        .into_iter()
        .map(|(name, runs)| ProfileSkillCount { name, runs })
        .collect();
    skills.sort_by(|a, b| b.runs.cmp(&a.runs).then_with(|| a.name.cmp(&b.name)));
    (skills, tool_calls, true)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn date_string(day_index: u64) -> String {
    let (year, month, day) = days_to_ymd(day_index);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Days since the Unix epoch → (year, month, day) in UTC.
/// Algorithm from <http://howardhinnant.github.io/date_algorithms.html>.
fn days_to_ymd(days_since_epoch: u64) -> (u64, u64, u64) {
    let z = days_since_epoch + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
#[path = "tests/profile.rs"]
mod tests;

//! Profile analytics for the Settings → Profile page.
//!
//! Device-wide analytics from project usage ledgers and durable chat events.
//! Optional CLI metadata is a fallback only for sessions without desktop events.
//! Log summaries are cached by file metadata and read on the blocking pool.
//! Missing logs mean no recorded activity; unreadable/corrupt logs are reported.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

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
    pub partial_data: bool,
    pub since: Option<u64>,
}

#[tauri::command]
pub async fn profile_stats() -> Result<ProfileStats, String> {
    tauri::async_runtime::spawn_blocking(load_profile_stats)
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Clone, Default)]
struct ActivityLog {
    calls: BTreeMap<(String, String), Option<String>>,
    sessions: HashSet<String>,
    longest_task_ms: u64,
    malformed: bool,
}

#[derive(Clone)]
enum LogData {
    Usage(Vec<UsageLogEntry>, bool),
    Activity(ActivityLog),
}

struct CachedLog {
    length: u64,
    modified: SystemTime,
    data: LogData,
}

static LOG_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedLog>>> = OnceLock::new();

fn read_cached_log(
    cache: &mut HashMap<PathBuf, CachedLog>,
    path: &Path,
    usage: bool,
) -> Result<Option<LogData>, String> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            cache.remove(path);
            return Ok(None);
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    if let Some(cached) = cache.get(path) {
        if cached.length == metadata.len() && cached.modified == modified {
            return Ok(Some(cached.data.clone()));
        }
    }
    let file = fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let data = if usage {
        let mut entries = Vec::new();
        let mut malformed = false;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(entry) => entries.push(entry),
                Err(_) => malformed = true,
            }
        }
        LogData::Usage(entries, malformed)
    } else if path
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        let session: LegacyActivity =
            serde_json::from_reader(BufReader::new(file)).map_err(|error| error.to_string())?;
        let mut log = ActivityLog::default();
        let session_id = path.file_stem().unwrap_or_default().to_string_lossy();
        if !session.messages.is_empty() || !session.compactions.is_empty() {
            log.sessions.insert(session_id.to_string());
        }
        for message in session.messages {
            record_activity_message(&mut log, &session_id, 0, message);
        }
        for compaction in session.compactions {
            for message in compaction.messages {
                record_activity_message(&mut log, &session_id, 0, message);
            }
        }
        LogData::Activity(log)
    } else {
        LogData::Activity(read_activity_log(BufReader::new(file))?)
    };
    cache.insert(
        path.to_path_buf(),
        CachedLog {
            length: metadata.len(),
            modified,
            data: data.clone(),
        },
    );
    if matches!(&data, LogData::Usage(_, true))
        || matches!(&data, LogData::Activity(log) if log.malformed)
    {
        eprintln!(
            "SomniQ Profile: skipped malformed analytics rows in {}",
            path.display()
        );
    }
    Ok(Some(data))
}

/// Deserialize only analytics fields, keeping large text/snapshot payloads out
/// of the cache. Chat events are already durable with metadata logging off.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ActivityHeader {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    ts: u64,
    #[serde(default)]
    kind: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ActivityEvent {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    ts: u64,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    payload: ActivityPayload,
}

#[derive(Deserialize, Default)]
struct ActivityPayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    input: serde_json::Value,
    #[serde(default)]
    message: Option<ActivityMessage>,
    #[serde(default)]
    compaction: Option<ActivityCompaction>,
}

#[derive(Deserialize)]
struct ActivityMessage {
    #[serde(default)]
    blocks: Vec<ActivityBlock>,
}

#[derive(Deserialize)]
struct ActivityCompaction {
    #[serde(default)]
    messages: Vec<ActivityMessage>,
}

#[derive(Deserialize)]
struct LegacyActivity {
    #[serde(default)]
    messages: Vec<ActivityMessage>,
    #[serde(default)]
    compactions: Vec<ActivityCompaction>,
}

#[derive(Deserialize)]
struct ActivityBlock {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    input: serde_json::Value,
}

fn record_activity_call(
    log: &mut ActivityLog,
    session: &str,
    id: String,
    name: &str,
    input: &serde_json::Value,
) {
    let skill = if name.eq_ignore_ascii_case("Skill") {
        skill_from_input(input)
    } else {
        None
    };
    let value = log.calls.entry((session.to_string(), id)).or_default();
    if skill.is_some() {
        *value = skill;
    }
}

fn record_activity_message(
    log: &mut ActivityLog,
    session: &str,
    seq: u64,
    message: ActivityMessage,
) {
    for (index, block) in message.blocks.into_iter().enumerate() {
        if block.kind == "tool_use" && !block.name.is_empty() {
            let id = if block.id.is_empty() {
                format!("@{seq}:block-{index}")
            } else {
                block.id
            };
            record_activity_call(log, session, id, &block.name, &block.input);
        }
    }
}

fn read_activity_log(reader: impl BufRead) -> Result<ActivityLog, String> {
    let mut log = ActivityLog::default();
    let mut started: HashMap<String, u64> = HashMap::new();
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let header: ActivityHeader = match serde_json::from_str(&line) {
            Ok(header) => header,
            Err(_) => {
                log.malformed = true;
                continue;
            }
        };
        if header.session_id.is_empty() {
            continue;
        }
        log.sessions.insert(header.session_id.clone());
        match header.kind.as_str() {
            "session_reset" => {
                // A canonical generation replaces all older history. Archived
                // compactions in that generation restore its earlier calls.
                log.calls
                    .retain(|(session, _), _| session != &header.session_id);
                started.remove(&header.session_id);
                continue;
            }
            "user_message" => {
                started.insert(header.session_id, header.ts);
                continue;
            }
            "done" => {
                if let Some(start) = started.remove(&header.session_id) {
                    log.longest_task_ms = log.longest_task_ms.max(header.ts.saturating_sub(start));
                }
                continue;
            }
            "error" => {
                started.remove(&header.session_id);
                continue;
            }
            "tool_call" | "session_message" | "session_compaction" => {}
            _ => continue,
        }
        // Unrelated UI payloads may have `message: string`, `id: null`, etc.
        // Decode the analytics schema only for kinds that actually use it.
        let event: ActivityEvent = match serde_json::from_str(&line) {
            Ok(event) => event,
            Err(_) => {
                log.malformed = true;
                continue;
            }
        };
        match event.kind.as_str() {
            "session_message" => {
                if let Some(message) = event.payload.message {
                    record_activity_message(&mut log, &event.session_id, event.seq, message);
                }
            }
            "session_compaction" => {
                if let Some(compaction) = event.payload.compaction {
                    for message in compaction.messages {
                        record_activity_message(&mut log, &event.session_id, event.seq, message);
                    }
                }
            }
            "tool_call" if !event.payload.name.is_empty() => {
                let id = if event.payload.id.is_empty() {
                    format!("@{}:{}", event.seq, event.ts)
                } else {
                    event.payload.id
                };
                // Permission/question events may repeat a call id. A repeated
                // event with richer input can fill in its skill, never add a run.
                record_activity_call(
                    &mut log,
                    &event.session_id,
                    id,
                    &event.payload.name,
                    &event.payload.input,
                );
            }
            _ => {}
        }
    }
    Ok(log)
}

fn skill_from_input(input: &serde_json::Value) -> Option<String> {
    let parsed;
    let value = if let Some(raw) = input.as_str() {
        parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
        &parsed
    } else {
        input
    };
    let skill = value.get("skill")?.as_str()?.trim().trim_start_matches('/');
    (!skill.is_empty()).then(|| skill.to_string())
}

fn add_runtime_paths(root: &Path, usage: &mut HashSet<PathBuf>, sessions: &mut HashSet<PathBuf>) {
    usage.insert(root.join("run-state").join("usage-log.jsonl"));
    sessions.insert(root.join("sessions"));
}

fn load_profile_stats() -> Result<ProfileStats, String> {
    let mut usage_paths = HashSet::from([usage_log_path()]);
    let mut session_dirs = HashSet::from([crate::state::sessions_dir()]);
    let mut partial = false;
    let roots = HashSet::from([
        crate::state::desktop_runtime_dir(),
        crate::state::runtime_dir(),
    ]);
    for root in roots {
        add_runtime_paths(&root, &mut usage_paths, &mut session_dirs);
        match fs::read_dir(root.join("projects")) {
            Ok(projects) => {
                for project in projects {
                    match project {
                        Ok(project)
                            if crate::state::valid_project_id(
                                &project.file_name().to_string_lossy(),
                            ) =>
                        {
                            add_runtime_paths(&project.path(), &mut usage_paths, &mut session_dirs);
                        }
                        Err(_) => partial = true,
                        _ => {}
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => partial = true,
        }
    }
    load_profile_stats_from_paths(
        usage_paths,
        session_dirs,
        Some(&runtime::JsonlEventSink::default_path()),
        partial,
    )
}

fn load_profile_stats_from_paths(
    usage_paths: HashSet<PathBuf>,
    session_dirs: HashSet<PathBuf>,
    meta_path: Option<&Path>,
    mut partial: bool,
) -> Result<ProfileStats, String> {
    let mut cache = LOG_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "profile log cache poisoned".to_string())?;
    let mut used_paths = HashSet::new();
    let mut entries = Vec::new();
    let mut usage_read = false;
    let mut usage_failed = false;
    for path in usage_paths {
        let path = fs::canonicalize(&path).unwrap_or(path);
        if !used_paths.insert(path.clone()) {
            continue;
        }
        match read_cached_log(&mut cache, &path, true) {
            Ok(Some(LogData::Usage(rows, malformed))) => {
                usage_read = true;
                partial |= malformed;
                entries.extend(rows);
            }
            Err(error) => {
                eprintln!("SomniQ Profile: could not read {}: {error}", path.display());
                partial = true;
                usage_failed = true;
            }
            _ => {}
        }
    }
    if usage_failed && !usage_read {
        return Err("Local usage logs could not be read".to_string());
    }
    let mut activity = ActivityLog::default();
    let mut activity_available = false;
    for dir in session_dirs {
        let paths = match fs::read_dir(dir) {
            Ok(paths) => paths,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        for path in paths {
            let path = match path {
                Ok(path) => path.path(),
                Err(_) => {
                    partial = true;
                    continue;
                }
            };
            let is_events = path.to_string_lossy().ends_with(".events.jsonl");
            let is_legacy = path
                .extension()
                .is_some_and(|extension| extension == "json")
                && !path.to_string_lossy().ends_with(".timeline.json")
                && !path.with_extension("events.jsonl").exists();
            if !is_events && !is_legacy {
                continue;
            }
            let path = fs::canonicalize(&path).unwrap_or(path);
            if !used_paths.insert(path.clone()) {
                continue;
            }
            match read_cached_log(&mut cache, &path, false) {
                Ok(Some(LogData::Activity(log))) => {
                    activity_available |= !log.sessions.is_empty();
                    partial |= log.malformed;
                    activity.sessions.extend(log.sessions);
                    for (key, skill) in log.calls {
                        let value = activity.calls.entry(key).or_default();
                        if skill.is_some() {
                            *value = skill;
                        }
                    }
                    activity.longest_task_ms = activity.longest_task_ms.max(log.longest_task_ms);
                }
                Err(error) => {
                    eprintln!("SomniQ Profile: could not read {}: {error}", path.display());
                    partial = true;
                }
                _ => {}
            }
        }
    }
    cache.retain(|path, _| used_paths.contains(path));
    drop(cache);
    let (meta_skills, meta_calls, meta_available) = meta_path
        .map(|path| read_meta_events(path, &activity.sessions, &mut partial))
        .unwrap_or_default();
    let mut stats = aggregate_activity(
        entries,
        activity,
        meta_skills,
        meta_calls,
        activity_available || meta_available,
    );
    stats.partial_data = partial;
    Ok(stats)
}

fn aggregate_activity(
    entries: Vec<UsageLogEntry>,
    activity: ActivityLog,
    meta_skills: Vec<ProfileSkillCount>,
    meta_calls: u64,
    available: bool,
) -> ProfileStats {
    let mut skill_counts = HashMap::new();
    for skill in activity.calls.values().flatten() {
        *skill_counts.entry(skill.clone()).or_default() += 1;
    }
    for skill in meta_skills {
        *skill_counts.entry(skill.name).or_default() += skill.runs;
    }
    let mut skills: Vec<_> = skill_counts
        .into_iter()
        .map(|(name, runs)| ProfileSkillCount { name, runs })
        .collect();
    skills.sort_by(|a, b| b.runs.cmp(&a.runs).then_with(|| a.name.cmp(&b.name)));
    let mut stats = aggregate(
        entries,
        skills,
        activity.calls.len() as u64 + meta_calls,
        available,
    );
    // A task includes tool execution and user approvals. Request latency alone
    // is retained as the fallback for old sessions without lifecycle events.
    if activity.longest_task_ms > 0 {
        stats.longest_task_seconds = Some(
            stats
                .longest_task_seconds
                .unwrap_or(0)
                .max(activity.longest_task_ms.div_ceil(1000)),
        );
    }
    stats
}

fn entry_tokens(entry: &UsageLogEntry) -> u64 {
    u64::from(entry.input_tokens)
        + u64::from(entry.output_tokens)
        + u64::from(entry.cache_creation_input_tokens)
        + u64::from(entry.cache_read_input_tokens)
}

/// How usage rows are grouped into turns: `(session, turn)`.
type TurnKey = (String, String);

/// A turn's identity, with the pre-`turnId` fallback.
///
/// Rows used to be grouped by `(sessionId, createdAt)`, which worked only
/// because a turn's rows all carried the same timestamp. They now carry their
/// own request time, so a timestamp grouping would count every request as its
/// own turn. Legacy rows have no `turnId` and keep the old behaviour.
fn turn_key_for(entry: &UsageLogEntry) -> TurnKey {
    let turn = if entry.turn_id.trim().is_empty() {
        format!("@{}", entry.created_at)
    } else {
        entry.turn_id.clone()
    };
    (entry.session_id.clone(), turn)
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
    let mut day_turns: BTreeMap<u64, HashSet<TurnKey>> = BTreeMap::new();
    let mut model_agg: HashMap<(String, String), (u64, HashSet<TurnKey>)> = HashMap::new();
    let mut turn_keys: HashSet<TurnKey> = HashSet::new();
    let mut cumulative: u64 = 0;
    let mut since: Option<u64> = None;
    // Per-turn totals, because one turn is many requests: "longest task" means
    // the longest turn, not the slowest single call within it.
    let mut turn_duration_ms: HashMap<TurnKey, u64> = HashMap::new();
    let mut recorded_turn_duration_ms: HashMap<TurnKey, u64> = HashMap::new();
    let mut effort_turns: HashMap<String, HashSet<TurnKey>> = HashMap::new();

    for entry in &entries {
        let tokens = entry_tokens(entry);
        if tokens == 0 {
            continue;
        }
        let day = entry.created_at / DAY_SECS;
        if day > today {
            continue;
        }
        let turn_key = turn_key_for(entry);

        cumulative = cumulative.saturating_add(tokens);
        *day_tokens.entry(day).or_default() += tokens;
        day_turns.entry(day).or_default().insert(turn_key.clone());
        turn_keys.insert(turn_key.clone());
        let duration = turn_duration_ms.entry(turn_key.clone()).or_default();
        if entry.turn_id.trim().is_empty() {
            // Before per-request timing and turnId, every row stamped the same
            // full-turn duration. Summing 82 such rows inflated a 96-minute
            // task into 131 hours. That timestamp group represents one turn.
            *duration = (*duration).max(entry.duration_ms);
        } else {
            *duration = duration.saturating_add(entry.duration_ms);
        }
        let recorded = recorded_turn_duration_ms
            .entry(turn_key.clone())
            .or_default();
        *recorded = (*recorded).max(entry.turn_duration_ms);
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

    let max_duration_ms = turn_duration_ms
        .iter()
        .map(|(key, latency)| {
            recorded_turn_duration_ms
                .get(key)
                .copied()
                .filter(|duration| *duration > 0)
                .unwrap_or(*latency)
        })
        .max()
        .unwrap_or(0);
    let longest_task_seconds = if max_duration_ms > 0 {
        Some(max_duration_ms.div_ceil(1000))
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
        partial_data: false,
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

fn read_meta_events(
    path: &Path,
    desktop_sessions: &HashSet<String>,
    partial: &mut bool,
) -> (Vec<ProfileSkillCount>, u64, bool) {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), 0, false)
        }
        Err(_) => {
            *partial = true;
            return (Vec::new(), 0, false);
        }
    };

    let mut skill_counts: HashMap<String, u64> = HashMap::new();
    let mut tool_calls: u64 = 0;
    for line in BufReader::new(file).lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => {
                *partial = true;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                *partial = true;
                continue;
            }
        };
        if value
            .get("session")
            .and_then(|session| session.as_str())
            .is_some_and(|session| desktop_sessions.contains(session))
        {
            continue;
        }
        match value.get("event").and_then(|event| event.as_str()) {
            Some("skill_invoke") => {
                if let Some(skill) = value.get("skill").and_then(|skill| skill.as_str()) {
                    let skill = skill.trim();
                    if !skill.is_empty() {
                        *skill_counts.entry(skill.to_string()).or_default() += 1;
                    }
                }
            }
            Some("tool_call" | "tool_failure") => tool_calls += 1,
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

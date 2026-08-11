use std::collections::BTreeSet;
use std::fs;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{home_dir, now_iso8601, today_iso};

const MEMORY_LIMIT: usize = 2_200;
const USER_LIMIT: usize = 1_375;
const ENTRY_SEPARATOR: &str = "\n\n---\n\n";
const META_PREFIX: &str = "<!-- aris-memory-meta: ";
const META_SUFFIX: &str = " -->";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotMemoryTarget {
    Memory,
    User,
}

impl HotMemoryTarget {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::User => "user",
        }
    }

    fn filename(self) -> &'static str {
        match self {
            Self::Memory => "MEMORY.md",
            Self::User => "USER.md",
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Memory => MEMORY_LIMIT,
            Self::User => USER_LIMIT,
        }
    }
}

impl std::str::FromStr for HotMemoryTarget {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "memory" => Ok(Self::Memory),
            "user" => Ok(Self::User),
            _ => Err("target must be `memory` or `user`".to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotMemoryEntry {
    pub id: String,
    pub content: String,
    pub source: String,
    pub scope: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingMemoryWrite {
    pub id: String,
    pub action: String,
    pub target: HotMemoryTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    pub source: String,
    pub scope: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HotMemorySnapshot {
    pub memory: Vec<HotMemoryEntry>,
    pub user: Vec<HotMemoryEntry>,
    pub memory_chars: usize,
    pub user_chars: usize,
    pub memory_limit: usize,
    pub user_limit: usize,
    pub pending_count: usize,
    pub project_scope: String,
}

#[must_use]
pub fn hot_memory_dir() -> PathBuf {
    PathBuf::from(home_dir())
        .join(".config")
        .join("aris")
        .join("hot-memory")
}

#[must_use]
pub fn knowledge_memory_dir() -> PathBuf {
    PathBuf::from(home_dir())
        .join(".config")
        .join("aris")
        .join("memories")
}

#[must_use]
pub fn project_scope(workspace: &Path) -> String {
    if let Ok(project_id) = std::env::var("ARIS_DESKTOP_PROJECT_ID") {
        if !project_id.trim().is_empty() {
            return format!("project:{project_id}");
        }
    }
    let canonical = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("project:{}", &hash[..16])
}

#[must_use]
pub fn memory_write_approval_enabled() -> bool {
    std::env::var("ARIS_MEMORY_WRITE_APPROVAL").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

pub fn load_hot_memory(workspace: &Path) -> Result<HotMemorySnapshot, String> {
    let scope = project_scope(workspace);
    let memory = active_entries(HotMemoryTarget::Memory, &scope)?;
    let user = active_entries(HotMemoryTarget::User, &scope)?;
    Ok(HotMemorySnapshot {
        memory_chars: joined_chars(&memory),
        user_chars: joined_chars(&user),
        memory,
        user,
        memory_limit: MEMORY_LIMIT,
        user_limit: USER_LIMIT,
        pending_count: list_pending_for_scope(&scope)?.len(),
        project_scope: scope,
    })
}

/// Loads the full scoped ledger for migration/audit, including expired entries.
/// Normal prompt construction must continue using [`load_hot_memory`].
pub fn load_hot_memory_for_migration(workspace: &Path) -> Result<HotMemorySnapshot, String> {
    let scope = project_scope(workspace);
    let memory = read_entries(HotMemoryTarget::Memory)?
        .into_iter()
        .filter(|entry| entry.scope == "global" || entry.scope == scope)
        .collect::<Vec<_>>();
    let user = read_entries(HotMemoryTarget::User)?
        .into_iter()
        .filter(|entry| entry.scope == "global" || entry.scope == scope)
        .collect::<Vec<_>>();
    Ok(HotMemorySnapshot {
        memory_chars: joined_chars(&memory),
        user_chars: joined_chars(&user),
        memory,
        user,
        memory_limit: MEMORY_LIMIT,
        user_limit: USER_LIMIT,
        pending_count: list_pending_for_scope(&scope)?.len(),
        project_scope: scope,
    })
}

pub fn render_hot_memory_prompt(workspace: &Path) -> Result<String, String> {
    let snapshot = load_hot_memory(workspace)?;
    let mut sections = Vec::new();
    if !snapshot.memory.is_empty() {
        sections.push(render_prompt_section(
            "MEMORY (stable environment and project facts)",
            &snapshot.memory,
            snapshot.memory_chars,
            snapshot.memory_limit,
        ));
    }
    if !snapshot.user.is_empty() {
        sections.push(render_prompt_section(
            "USER PROFILE (preferences and communication style)",
            &snapshot.user,
            snapshot.user_chars,
            snapshot.user_limit,
        ));
    }
    let guidance = format!(
        "# ARIS Memory Policy\n\
         Stable facts and user preferences belong in the `memory` tool. \
         Temporary task progress and completed-work history belong in `session_search`. \
         Reusable procedures belong in Skills. \
         Hot memory scope for this workspace is `{}`. \
         Do not save secrets, raw logs, temporary paths, or facts likely to become stale within a week.",
        snapshot.project_scope
    );
    sections.push(guidance);
    Ok(sections.join("\n\n"))
}

pub fn add_hot_memory(
    target: HotMemoryTarget,
    content: &str,
    source: &str,
    scope: &str,
    expires_at: Option<&str>,
) -> Result<HotMemoryEntry, String> {
    with_hot_memory_lock(|| add_hot_memory_unlocked(target, content, source, scope, expires_at))
}

fn add_hot_memory_unlocked(
    target: HotMemoryTarget,
    content: &str,
    source: &str,
    scope: &str,
    expires_at: Option<&str>,
) -> Result<HotMemoryEntry, String> {
    validate_content(content, expires_at)?;
    validate_scope(scope)?;
    validate_expiry(expires_at)?;
    let mut entries = read_entries(target)?;
    let content = content.trim().to_string();
    if let Some(existing) = entries
        .iter()
        .find(|entry| entry.content == content && entry.scope == scope)
    {
        return Ok(existing.clone());
    }
    let entry = HotMemoryEntry {
        id: make_id(&content),
        content,
        source: normalize_source(source),
        scope: scope.to_string(),
        created_at: now_iso8601(),
        expires_at: expires_at.map(ToOwned::to_owned),
    };
    entries.push(entry.clone());
    ensure_within_limit(target, &entries)?;
    write_entries(target, &entries)?;
    Ok(entry)
}

pub fn replace_hot_memory(
    target: HotMemoryTarget,
    old_text: &str,
    content: &str,
    source: &str,
    scope: &str,
    expires_at: Option<&str>,
) -> Result<HotMemoryEntry, String> {
    with_hot_memory_lock(|| {
        replace_hot_memory_unlocked(target, old_text, content, source, scope, expires_at)
    })
}

fn replace_hot_memory_unlocked(
    target: HotMemoryTarget,
    old_text: &str,
    content: &str,
    source: &str,
    scope: &str,
    expires_at: Option<&str>,
) -> Result<HotMemoryEntry, String> {
    validate_content(content, expires_at)?;
    validate_scope(scope)?;
    validate_expiry(expires_at)?;
    let mut entries = read_entries(target)?;
    let matches = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.scope == scope && entry.content.contains(old_text))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(match matches.len() {
            0 => format!("no {} memory entry matched `{old_text}`", target.as_str()),
            count => format!("{count} entries matched `{old_text}`; use a unique substring"),
        });
    }
    let index = matches[0];
    let replacement = HotMemoryEntry {
        id: entries[index].id.clone(),
        content: content.trim().to_string(),
        source: normalize_source(source),
        scope: scope.to_string(),
        created_at: entries[index].created_at.clone(),
        expires_at: expires_at.map(ToOwned::to_owned),
    };
    let mut test = entries.clone();
    test[index] = replacement.clone();
    ensure_within_limit(target, &test)?;
    entries[index] = replacement.clone();
    write_entries(target, &entries)?;
    Ok(replacement)
}

pub fn remove_hot_memory(
    target: HotMemoryTarget,
    old_text: &str,
    scope: &str,
) -> Result<HotMemoryEntry, String> {
    with_hot_memory_lock(|| remove_hot_memory_unlocked(target, old_text, scope))
}

fn remove_hot_memory_unlocked(
    target: HotMemoryTarget,
    old_text: &str,
    scope: &str,
) -> Result<HotMemoryEntry, String> {
    validate_scope(scope)?;
    let mut entries = read_entries(target)?;
    let matches = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.scope == scope && entry.content.contains(old_text))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(match matches.len() {
            0 => format!("no {} memory entry matched `{old_text}`", target.as_str()),
            count => format!("{count} entries matched `{old_text}`; use a unique substring"),
        });
    }
    let removed = entries.remove(matches[0]);
    write_entries(target, &entries)?;
    Ok(removed)
}

pub fn stage_memory_write(write: PendingMemoryWrite) -> Result<PendingMemoryWrite, String> {
    let dir = hot_memory_dir().join("pending");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    atomic_write(
        &dir.join(format!("{}.json", write.id)),
        &serde_json::to_string_pretty(&write).map_err(|error| error.to_string())?,
    )?;
    Ok(write)
}

pub fn list_pending() -> Result<Vec<PendingMemoryWrite>, String> {
    let dir = hot_memory_dir().join("pending");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut writes = fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|content| serde_json::from_str::<PendingMemoryWrite>(&content).ok())
        .collect::<Vec<_>>();
    writes.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(writes)
}

pub fn list_pending_for_scope(project_scope: &str) -> Result<Vec<PendingMemoryWrite>, String> {
    Ok(list_pending()?
        .into_iter()
        .filter(|write| write.scope == "global" || write.scope == project_scope)
        .collect())
}

pub fn approve_pending(id: &str) -> Result<HotMemoryEntry, String> {
    validate_pending_id(id)?;
    let path = hot_memory_dir().join("pending").join(format!("{id}.json"));
    let write: PendingMemoryWrite =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let result = match write.action.as_str() {
        "add" => add_hot_memory(
            write.target,
            write.content.as_deref().unwrap_or_default(),
            &write.source,
            &write.scope,
            write.expires_at.as_deref(),
        ),
        "replace" => replace_hot_memory(
            write.target,
            write.old_text.as_deref().unwrap_or_default(),
            write.content.as_deref().unwrap_or_default(),
            &write.source,
            &write.scope,
            write.expires_at.as_deref(),
        ),
        "remove" => remove_hot_memory(
            write.target,
            write.old_text.as_deref().unwrap_or_default(),
            &write.scope,
        ),
        _ => Err(format!(
            "unsupported pending memory action `{}`",
            write.action
        )),
    }?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn reject_pending(id: &str) -> Result<(), String> {
    validate_pending_id(id)?;
    fs::remove_file(hot_memory_dir().join("pending").join(format!("{id}.json")))
        .map_err(|error| error.to_string())
}

#[must_use]
pub fn new_pending_write(
    action: &str,
    target: HotMemoryTarget,
    content: Option<String>,
    old_text: Option<String>,
    source: &str,
    scope: &str,
    expires_at: Option<String>,
) -> PendingMemoryWrite {
    PendingMemoryWrite {
        id: make_id(&format!("{action}:{:?}:{content:?}:{old_text:?}", target)),
        action: action.to_string(),
        target,
        content,
        old_text,
        source: normalize_source(source),
        scope: scope.to_string(),
        created_at: now_iso8601(),
        expires_at,
    }
}

fn active_entries(
    target: HotMemoryTarget,
    project_scope: &str,
) -> Result<Vec<HotMemoryEntry>, String> {
    Ok(read_entries(target)?
        .into_iter()
        .filter(|entry| entry.scope == "global" || entry.scope == project_scope)
        .filter(|entry| !is_expired(entry))
        .collect())
}

fn read_entries(target: HotMemoryTarget) -> Result<Vec<HotMemoryEntry>, String> {
    let path = hot_memory_dir().join(target.filename());
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for chunk in content.split(ENTRY_SEPARATOR) {
        let chunk = chunk.trim();
        if chunk.is_empty() || chunk.starts_with("# ARIS Hot Memory") {
            continue;
        }
        let Some((meta_line, body)) = chunk.split_once('\n') else {
            continue;
        };
        let Some(json) = meta_line
            .strip_prefix(META_PREFIX)
            .and_then(|value| value.strip_suffix(META_SUFFIX))
        else {
            continue;
        };
        if let Ok(mut entry) = serde_json::from_str::<HotMemoryEntry>(json) {
            entry.content = body.trim().to_string();
            if !entry.content.is_empty() {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

fn write_entries(target: HotMemoryTarget, entries: &[HotMemoryEntry]) -> Result<(), String> {
    let dir = hot_memory_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut chunks = vec!["# ARIS Hot Memory\n\nManaged by the `memory` tool. Entries may be edited, but preserve their metadata comments.".to_string()];
    for entry in entries {
        let mut metadata = entry.clone();
        metadata.content.clear();
        let json = serde_json::to_string(&metadata).map_err(|error| error.to_string())?;
        chunks.push(format!(
            "{META_PREFIX}{json}{META_SUFFIX}\n{}",
            entry.content
        ));
    }
    atomic_write(&dir.join(target.filename()), &chunks.join(ENTRY_SEPARATOR))
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&tmp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn with_hot_memory_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let dir = hot_memory_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(".write.lock");
    for _ in 0..100 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                let result = operation();
                drop(file);
                let _ = fs::remove_file(path);
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                    .is_ok_and(|age| age > Duration::from_secs(30));
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("timed out waiting for the hot-memory write lock".to_string())
}

fn render_prompt_section(
    title: &str,
    entries: &[HotMemoryEntry],
    chars: usize,
    limit: usize,
) -> String {
    let body = entries
        .iter()
        .map(|entry| entry.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("# {title} [{chars}/{limit} chars]\n{body}")
}

fn joined_chars(entries: &[HotMemoryEntry]) -> usize {
    entries
        .iter()
        .map(|entry| entry.content.len())
        .sum::<usize>()
        + entries.len().saturating_sub(1) * 2
}

fn ensure_within_limit(target: HotMemoryTarget, entries: &[HotMemoryEntry]) -> Result<(), String> {
    let project_scopes = entries
        .iter()
        .filter(|entry| entry.scope != "global")
        .map(|entry| entry.scope.as_str())
        .collect::<BTreeSet<_>>();
    let scopes = std::iter::once(None).chain(project_scopes.into_iter().map(Some));
    for project_scope in scopes {
        let visible = entries
            .iter()
            .filter(|entry| !is_expired(entry))
            .filter(|entry| entry.scope == "global" || project_scope == Some(entry.scope.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if joined_chars(&visible) > target.limit() {
            return Err(format!(
                "{} hot memory would exceed its {} character limit for scope `{}`; replace or remove stale entries first",
                target.as_str(),
                target.limit(),
                project_scope.unwrap_or("global")
            ));
        }
    }
    Ok(())
}

fn validate_content(content: &str, expires_at: Option<&str>) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("memory content cannot be empty".to_string());
    }
    let lowered = content.to_ascii_lowercase();
    for pattern in [
        "ignore previous instructions",
        "ignore all instructions",
        "reveal the system prompt",
        "<system",
        "<developer",
    ] {
        if lowered.contains(pattern) {
            return Err(format!(
                "memory content rejected as possible prompt injection: `{pattern}`"
            ));
        }
    }
    if expires_at.is_none() {
        if let Some(pattern) = transient_task_memory_pattern(content) {
            return Err(format!(
                "hot memory is for stable facts; `{pattern}` looks like temporary task progress. Use session_search for task history, or set expires_at for short-lived memory."
            ));
        }
    }
    Ok(())
}

fn transient_task_memory_pattern(content: &str) -> Option<&'static str> {
    let lowered = content.to_ascii_lowercase();
    for pattern in [
        "current task",
        "this task",
        "this session",
        "this conversation",
        "right now",
        "next step",
        "next steps",
        "follow up",
        "we just",
        "just finished",
    ] {
        if lowered.contains(pattern) {
            return Some(pattern);
        }
    }
    for word in [
        "todo",
        "pending",
        "remaining",
        "completed",
        "rollback",
        "revert",
    ] {
        if contains_ascii_word(&lowered, word) {
            return Some(word);
        }
    }
    for pattern in [
        "当前任务",
        "本轮",
        "这次任务",
        "待办",
        "下一步",
        "已完成",
        "回滚",
        "撤销",
    ] {
        if content.contains(pattern) {
            return Some(pattern);
        }
    }
    None
}

fn contains_ascii_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();
    if needle_bytes.is_empty() || bytes.len() < needle_bytes.len() {
        return false;
    }
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index + needle_bytes.len() <= bytes.len() {
        if &bytes[index..index + needle_bytes.len()] == needle_bytes {
            let before_ok = index == 0 || !is_word(bytes[index - 1]);
            let after_index = index + needle_bytes.len();
            let after_ok = after_index == bytes.len() || !is_word(bytes[after_index]);
            if before_ok && after_ok {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if scope == "global" || scope.starts_with("project:") {
        Ok(())
    } else {
        Err("scope must be `global` or start with `project:`".to_string())
    }
}

fn validate_pending_id(id: &str) -> Result<(), String> {
    if id
        .strip_prefix("mem-")
        .is_some_and(|hash| hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        Ok(())
    } else {
        Err("pending memory id must match `mem-<16 hex characters>`".to_string())
    }
}

fn validate_expiry(expires_at: Option<&str>) -> Result<(), String> {
    if let Some(value) = expires_at {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return Err("expires_at must use YYYY-MM-DD format".to_string());
        }
    }
    Ok(())
}

fn is_expired(entry: &HotMemoryEntry) -> bool {
    entry
        .expires_at
        .as_deref()
        .is_some_and(|expires_at| expires_at < today_iso().as_str())
}

fn normalize_source(source: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        "assistant_tool".to_string()
    } else {
        source.chars().take(80).collect()
    }
}

fn make_id(seed: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(format!("{nanos}:{seed}").as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("mem-{}", &hash[..16])
}

#[cfg(test)]
#[path = "tests/hot_memory.rs"]
mod tests;

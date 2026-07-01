//! On-disk message cache for mail accounts.
//!
//! Reopening a mailbox should be instant: instead of re-fetching every row over
//! IMAP, we persist the summaries we have already rendered under
//! `~/.config/SomniQ/mail/cache/`, keyed by account + folder. The cache is *sparse* — it
//! holds whatever UIDs the user has actually paged through, not the whole
//! folder. `imap::list` reads it, fetches only the page UIDs it is missing, and
//! refreshes flags for the visible page, so a warm reopen does no body fetches.
//!
//! `uidValidity` guards correctness: if the server reports a different value
//! (the IMAP signal that UIDs were renumbered) the cache is dropped.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::model::{MailMessageFull, MailMessageSummary};

/// Bump when the cached summary shape or how it's produced changes, so stale
/// caches from older builds are dropped instead of shown. v1 → v2 fixed
/// summaries whose headers were truncated by a byte-prefix fetch; v2 → v3
/// stops caching list snippets built from separate IMAP BODY[TEXT] literals.
pub const CURRENT_VERSION: u32 = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCache {
    /// Cache schema version; mismatches are discarded on load.
    #[serde(default)]
    pub version: u32,
    /// IMAP `UIDVALIDITY` of the folder when this cache was written.
    #[serde(default)]
    pub uid_validity: u32,
    /// Sparse set of cached rows. Order is not significant; callers index by UID.
    #[serde(default)]
    pub messages: Vec<CachedMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMessage {
    pub uid: u32,
    pub summary: MailMessageSummary,
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn cache_dir() -> PathBuf {
    crate::state::mail_dir().join("cache")
}

fn cache_path(account_id: &str, folder: &str) -> PathBuf {
    cache_dir().join(format!(
        "{}__{}.json",
        sanitize(account_id),
        sanitize(folder)
    ))
}

fn message_cache_path(account_id: &str, message_id: &str) -> PathBuf {
    cache_dir().join("messages").join(format!(
        "{}__{}.json",
        sanitize(account_id),
        sanitize(message_id)
    ))
}

pub fn load(account_id: &str, folder: &str) -> Option<FolderCache> {
    let cache: FolderCache = std::fs::read_to_string(cache_path(account_id, folder))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())?;
    // Drop caches written by an older schema so a fixed build re-fetches.
    if cache.version != CURRENT_VERSION {
        return None;
    }
    Some(cache)
}

pub fn save(account_id: &str, folder: &str, cache: &FolderCache) -> Result<(), String> {
    let path = cache_path(account_id, folder);
    let mut cache = cache.clone();
    cache.version = CURRENT_VERSION;
    let body = serde_json::to_string(&cache).map_err(|e| e.to_string())?;
    super::atomic_file::write_replace(&path, body).map_err(|e| e.to_string())
}

pub fn load_message(account_id: &str, message_id: &str) -> Option<MailMessageFull> {
    std::fs::read_to_string(message_cache_path(account_id, message_id))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

pub fn save_message(
    account_id: &str,
    message_id: &str,
    message: &MailMessageFull,
) -> Result<(), String> {
    let body = serde_json::to_string(message).map_err(|e| e.to_string())?;
    super::atomic_file::write_replace(&message_cache_path(account_id, message_id), body)
        .map_err(|e| e.to_string())
}

/// Drop every cached folder for an account (called on disconnect).
pub fn clear_account(account_id: &str) {
    let prefix = format!("{}__", sanitize(account_id));
    let Ok(entries) = std::fs::read_dir(cache_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(prefix.as_str())
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let Ok(entries) = std::fs::read_dir(cache_dir().join("messages")) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(prefix.as_str())
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

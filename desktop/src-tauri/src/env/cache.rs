//! Disk cache for environment probe results.
//!
//! Strategy:
//! 1. Cache file lives at `~/.config/SomniQ/cache/environment.json`
//! 2. A lightweight fingerprint (PATH + tool binary paths, *not* versions) detects
//!    tool install/uninstall/PATH changes cheaply.
//! 3. Fingerprint match + < 7 days → return cached result (zero subprocess).
//! 4. Fingerprint mismatch or expired → fall through to full probe.

use crate::state;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const CACHE_SCHEMA_VERSION: u32 = 1;
const CACHE_TTL_DAYS: i64 = 7;

#[derive(Serialize, Deserialize)]
pub(crate) struct CachedTool {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct EnvironmentCache {
    pub schema_version: u32,
    pub checked_at: String,  // ISO 8601
    pub fingerprint: String, // sha256 hex
    pub tools: Vec<CachedTool>,
}

fn cache_path() -> PathBuf {
    state::config_dir().join("cache").join("environment.json")
}

/// Compute a lightweight fingerprint that detects environment changes cheaply.
///
/// Uses `where.exe` / `which` to locate tool binaries (no `--version` calls),
/// plus the PATH env var. This runs in ~1s instead of 30s.
pub(crate) fn compute_lightweight_fingerprint() -> String {
    let mut hasher = Sha256::new();

    // PATH captures tool installs, renames, and PATH order changes.
    hasher.update(b"PATH:");
    hasher.update(std::env::var("PATH").unwrap_or_default().as_bytes());

    // Binary location for each tool category — cheap (no --version subprocess).
    for tool in &[
        "python", "jupyter", "matlab", "latexmk", "xelatex", "pdflatex", "lualatex",
    ] {
        hasher.update(format!("\n{tool}:").as_bytes());
        if let Some(path) = super::probe::command_path(tool) {
            hasher.update(path.as_bytes());
        } else {
            hasher.update(b"(missing)");
        }
    }

    format!("{:x}", hasher.finalize())
}

/// Read the on-disk environment cache, if it exists and can be deserialized.
pub(crate) fn read_cache() -> Option<EnvironmentCache> {
    let path = cache_path();
    if !path.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<EnvironmentCache>(&text).ok()
}

/// Write current probe results to the on-disk cache.
pub(crate) fn write_cache(checks: &[super::LocalEnvironmentCheck], fingerprint: &str) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tools: Vec<CachedTool> = checks
        .iter()
        .map(|c| CachedTool {
            id: c.id.clone(),
            ok: c.available,
            version: c.version.clone(),
            path: c.path.clone(),
            reason: if c.available {
                None
            } else {
                Some(c.message.clone())
            },
        })
        .collect();
    let cache = EnvironmentCache {
        schema_version: CACHE_SCHEMA_VERSION,
        checked_at: chrono_now(),
        fingerprint: fingerprint.to_string(),
        tools,
    };
    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

/// Returns true when the cache is still usable: schema matches, fingerprint
/// matches, and it hasn't exceeded the TTL.
pub(crate) fn is_cache_valid(cache: &EnvironmentCache, fingerprint: &str) -> bool {
    if cache.schema_version != CACHE_SCHEMA_VERSION {
        return false;
    }
    if cache.fingerprint != fingerprint {
        return false;
    }
    !is_expired(&cache.checked_at, CACHE_TTL_DAYS)
}

/// Convert a cached tool record back into a LocalEnvironmentCheck.
pub(crate) fn cached_to_check(tool: &CachedTool) -> super::LocalEnvironmentCheck {
    super::LocalEnvironmentCheck {
        id: tool.id.clone(),
        label: tool.id.clone(), // label/category rebuilt by the full probe; cached records are cosmetic
        category: String::new(),
        status: if tool.ok {
            "ready".to_string()
        } else {
            "missing".to_string()
        },
        available: tool.ok,
        version: tool.version.clone(),
        path: tool.path.clone(),
        message: tool
            .reason
            .clone()
            .unwrap_or_else(|| "（缓存结果，环境未变化）".to_string()),
        detail: None,
    }
}

/// Rebuild labels/categories for cached tools using the same mapping as the
/// full probe, so the UI shows the correct labels even when served from cache.
pub(crate) fn enrich_cached_labels(checks: &mut [super::LocalEnvironmentCheck]) {
    let mapping: &[(&str, &str, &str)] = &[
        ("python", "Python", "运行环境"),
        ("jupyter", "Jupyter", "Notebook"),
        ("matlab", "MATLAB", "数值计算"),
        ("latex", "LaTeX", "论文排版"),
    ];
    for check in checks.iter_mut() {
        if let Some((_, label, category)) = mapping.iter().find(|(id, _, _)| *id == check.id) {
            check.label = label.to_string();
            check.category = category.to_string();
        }
    }
}

fn is_expired(checked_at: &str, ttl_days: i64) -> bool {
    let Some(ts) = parse_iso8601(checked_at) else {
        return true; // unparseable → treat as expired
    };
    let now = current_unix_secs();
    let age_days = (now - ts) / 86400;
    age_days > ttl_days
}

fn parse_iso8601(s: &str) -> Option<i64> {
    // Minimal ISO 8601 parser: "2026-07-02T10:23:45Z"
    let s = s.strip_suffix('Z').unwrap_or(s);
    let mut parts = s.split('T');
    let date = parts.next()?;
    let time = parts.next()?;

    let mut dp = date.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;

    let mut tp = time.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;

    let days = day - 1
        + (if month > 2 {
            // months March–December: formula counts from March 1; add 59 for Jan+Feb
            (153 * month - 457) / 5 + 59 + 365 * (year - 1970) + (year - 1969) / 4
                - (year - 1901) / 100
                + (year - 1601) / 400
        } else {
            (153 * (month + 12) - 457) / 5 + 365 * (year - 1971) + (year - 1969) / 4
                - (year - 1901) / 100
                + (year - 1601) / 400
        });
    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}

fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn chrono_now() -> String {
    let secs = current_unix_secs();
    let days_since_epoch = secs / 86400;
    let remaining = secs % 86400;
    let hour = remaining / 3600;
    let min = (remaining % 3600) / 60;
    let sec = remaining % 60;

    // Convert days since epoch to (year, month, day)
    let mut y = 1970;
    let mut d = days_since_epoch;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1;
    for &md in &month_days {
        if d < md {
            break;
        }
        d -= md;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d + 1,
        hour,
        min,
        sec
    )
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[cfg(test)]
#[path = "../tests/env/cache.rs"]
mod tests;

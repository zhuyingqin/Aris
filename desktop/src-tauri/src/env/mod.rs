//! Environment probe module.
//!
//! Provides cached environment checks (Python, Jupyter, MATLAB, LaTeX) with
//! fingerprint-based invalidation so repeated calls skip subprocess probing.

mod cache;
pub(crate) mod probe;

use serde::Serialize;
use std::sync::{Mutex, OnceLock};

/// In-memory session cache — probe results are shared across all callers within
/// the same process lifetime.
static SESSION_CACHE: OnceLock<Mutex<Option<Vec<LocalEnvironmentCheck>>>> =
    OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentCheck {
    pub id: String,
    pub label: String,
    pub category: String,
    pub status: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: String,
    pub detail: Option<String>,
}

/// Return cached or freshly-probed environment checks.
///
/// - `force_refresh=true` skips all caches and runs a full probe synchronously.
/// - Otherwise the in-memory session cache is checked first, then the on-disk
///   cache (validated via a lightweight fingerprint), falling back to a full
///   blocking probe only when the environment has genuinely changed.
pub async fn get_or_probe(
    force_refresh: bool,
) -> Result<Vec<LocalEnvironmentCheck>, String> {
    // ── Fast path: in-memory session cache ────────────────────────────────
    if !force_refresh {
        let guard = SESSION_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(cached) = guard.as_ref() {
            return Ok(cached.clone());
        }
        drop(guard);
    }

    // ── Disk cache path: compute a cheap fingerprint that detects tool
    //    installs / PATH changes, then validate the on-disk cache. ─────────
    if !force_refresh {
        let fingerprint = tauri::async_runtime::spawn_blocking(|| {
            cache::compute_lightweight_fingerprint()
        })
        .await
        .map_err(|e| e.to_string())?;

        if let Some(cached) = cache::read_cache() {
            if cache::is_cache_valid(&cached, &fingerprint) {
                let mut checks: Vec<LocalEnvironmentCheck> = cached
                    .tools
                    .iter()
                    .map(|t| cache::cached_to_check(t))
                    .collect();
                cache::enrich_cached_labels(&mut checks);

                let mut guard = SESSION_CACHE
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .map_err(|e| e.to_string())?;
                *guard = Some(checks.clone());
                return Ok(checks);
            }
        }
    }

    // ── Full probe (expensive: runs version and MATLAB checks) ───────────
    let checks = tauri::async_runtime::spawn_blocking(|| {
        probe::environment_checks_blocking()
    })
    .await
    .map_err(|e| e.to_string())?;

    // Persist to disk in background — don't block the response on I/O.
    {
        let checks_clone = checks.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let fingerprint = cache::compute_lightweight_fingerprint();
            cache::write_cache(&checks_clone, &fingerprint);
        });
    }

    // Update in-memory cache.
    {
        let mut guard = SESSION_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?;
        *guard = Some(checks.clone());
    }

    Ok(checks)
}

/// Invalidate the in-memory session cache so the next call will re-validate
/// against the disk cache.
pub fn invalidate_session_cache() {
    if let Some(mutex) = SESSION_CACHE.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = None;
        }
    }
}

//! Credentials this process uses itself but must not hand to child processes.
//!
//! `std::env` is inherited by every command the Agent runs (Bash, Python, MCP
//! servers, kernels), so a key placed there can be printed by a single shell
//! line. A value set here shadows the environment variable of the same name
//! for in-process readers only.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

fn secrets() -> &'static RwLock<HashMap<String, String>> {
    static SECRETS: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    SECRETS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Set (`Some`) or clear (`None`) the in-process value for `name`.
pub fn set_process_secret(name: &str, value: Option<String>) {
    let Ok(mut secrets) = secrets().write() else {
        return;
    };
    match value.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            secrets.insert(name.to_string(), value);
        }
        None => {
            secrets.remove(name);
        }
    }
}

/// Drop every in-process value.
pub fn clear_process_secrets() {
    if let Ok(mut secrets) = secrets().write() {
        secrets.clear();
    }
}

/// The in-process value for `name`, else its non-empty environment variable.
#[must_use]
pub fn secret_var(name: &str) -> Option<String> {
    secrets()
        .read()
        .ok()
        .and_then(|secrets| secrets.get(name).cloned())
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

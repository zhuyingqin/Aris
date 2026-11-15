//! What the last real MCP discovery saw, per server.
//!
//! Every discovery goes through [`crate::McpServerManager`]: Chat's per-turn
//! tool attachment (`aris_chat::attach_mcp_tools_with_cancel`), the Extensions
//! page's MCP test and a plugin card's connection check. The manager records
//! each server's outcome here, so the plugin page can say whether a package's
//! servers actually connected instead of inferring it from configuration.
//!
//! Entries are keyed by server name AND [`crate::scoped_mcp_config_hash`]: a
//! result describes one exact command line and environment, so an upgraded
//! package (whose snapshot path, and therefore arguments, change) starts
//! unchecked rather than inheriting the previous version's health.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// The outcome of the most recent discovery of one MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerHealth {
    pub ok: bool,
    /// Tools the server listed; zero when it failed.
    pub tool_count: usize,
    /// The failure, or `None` when it connected.
    pub message: Option<String>,
    pub checked_at_ms: u64,
}

/// Bounded so a long-lived process that sees many configurations does not grow
/// without limit; the oldest results are dropped first.
const MAX_ENTRIES: usize = 512;

fn entries() -> &'static Mutex<BTreeMap<(String, String), McpServerHealth>> {
    static ENTRIES: OnceLock<Mutex<BTreeMap<(String, String), McpServerHealth>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Record what a discovery of `server` (with configuration `config_hash`) saw.
pub fn record_mcp_server_health(server: &str, config_hash: &str, outcome: Result<usize, String>) {
    let health = match outcome {
        Ok(tool_count) => McpServerHealth {
            ok: true,
            tool_count,
            message: None,
            checked_at_ms: now_ms(),
        },
        Err(message) => McpServerHealth {
            ok: false,
            tool_count: 0,
            message: Some(message),
            checked_at_ms: now_ms(),
        },
    };
    let mut entries = entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    entries.insert((server.to_string(), config_hash.to_string()), health);
    while entries.len() > MAX_ENTRIES {
        let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, health)| health.checked_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        entries.remove(&oldest);
    }
}

/// The last discovery result for exactly this server configuration.
#[must_use]
pub fn mcp_server_health(server: &str, config_hash: &str) -> Option<McpServerHealth> {
    entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(server.to_string(), config_hash.to_string()))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_is_keyed_by_exact_configuration_and_replaced_by_the_next_discovery() {
        record_mcp_server_health("health-test-a", "config-1", Err("spawn failed".into()));
        let failed = mcp_server_health("health-test-a", "config-1").unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.message.as_deref(), Some("spawn failed"));
        // A different command line is a different server as far as health goes.
        assert_eq!(mcp_server_health("health-test-a", "config-2"), None);
        record_mcp_server_health("health-test-a", "config-1", Ok(3));
        let connected = mcp_server_health("health-test-a", "config-1").unwrap();
        assert!(connected.ok);
        assert_eq!(connected.tool_count, 3);
        assert_eq!(connected.message, None);
    }
}

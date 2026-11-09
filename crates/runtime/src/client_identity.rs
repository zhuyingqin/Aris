//! How a SomniQ Studio release identifies itself to the services it operates.
//!
//! Every request to SomniQ infrastructure (the New API account and model
//! routes, the research gateway, the remote edge) carries
//! [`client_user_agent`]. New API stores that header on login sessions and its
//! login audit log; the SomniQ edge additionally logs it next to New API's
//! `X-Oneapi-Request-Id`, and refuses a release older than its configured
//! minimum with `426 Upgrade Required` (`client_outdated`).
//!
//! The `aris/<version>` prefix is the wire contract the edge matches. Desktop
//! releases since 0.4.76 already send it on OpenAI-compatible model calls, so
//! keep the prefix and append details only inside the parenthesised comment.

use std::sync::OnceLock;

/// The release version. The workspace and the desktop package are bumped
/// together, which the desktop crate's tests assert.
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Error code the SomniQ edge sends with `426 Upgrade Required`. Error
/// strings carry it so the desktop UI can offer the update instead of a
/// generic failure.
pub const CLIENT_OUTDATED_CODE: &str = "client_outdated";

const CLIENT_OUTDATED_FALLBACK_MESSAGE: &str =
    "当前客户端版本已停止服务，请更新到最新版本后再试";

/// `aris/<version> (SomniQ Studio; <os>; <arch>)`.
#[must_use]
pub fn client_user_agent() -> &'static str {
    static USER_AGENT: OnceLock<String> = OnceLock::new();
    USER_AGENT.get_or_init(|| {
        format!(
            "aris/{CLIENT_VERSION} (SomniQ Studio; {}; {})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })
}

/// The server's explanation when a response refuses this release, or `None`
/// for any other response. The edge's message names the minimum version, so it
/// is preferred over the generic fallback.
#[must_use]
pub fn client_outdated_message(status: u16, body: &str) -> Option<String> {
    if status != 426 {
        return None;
    }
    let message = serde_json::from_str::<serde_json::Value>(body.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(|body| {
            body.get("message")
                .or_else(|| body.get("error").and_then(|error| error.get("message")))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| CLIENT_OUTDATED_FALLBACK_MESSAGE.to_string());
    Some(message)
}

/// [`client_outdated_message`] with the trailing code the UI recognizes.
#[must_use]
pub fn client_outdated_error(status: u16, body: &str) -> Option<String> {
    client_outdated_message(status, body)
        .map(|message| format!("{message} ({CLIENT_OUTDATED_CODE})"))
}

#[cfg(test)]
#[path = "tests/client_identity.rs"]
mod tests;

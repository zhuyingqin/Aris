use std::path::PathBuf;

/// Mirror of `tools::team_state::state_root()` (which is `pub(crate)` and thus
/// not importable). Resolution order matches the kernel exactly:
///   1. `ARIS_RUN_STATE_DIR` environment variable
///   2. `<cwd>/.claude/run-state`
/// Keep in sync with `crates/tools/src/team_state.rs`.
pub fn state_root() -> PathBuf {
    if let Ok(path) = std::env::var("ARIS_RUN_STATE_DIR") {
        return PathBuf::from(path);
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".claude")
        .join("run-state")
}

pub fn events_path() -> PathBuf {
    state_root().join("events.jsonl")
}

/// Mirror of `aris-cli`'s `sessions_dir()` — `<cwd>/.claude/sessions`.
pub fn sessions_dir() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".claude")
        .join("sessions")
}

/// `~/.config/aris/config.json` — mirror of `ArisConfig::config_path()`.
pub fn config_path() -> PathBuf {
    PathBuf::from(runtime::home_dir())
        .join(".config")
        .join("aris")
        .join("config.json")
}

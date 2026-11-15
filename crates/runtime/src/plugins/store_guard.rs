//! The project's plugin store (`<project>/.somniq/plugins`) is SomniQ's, not
//! the model's. It holds the install list, panel state and the request to
//! switch official plugins off for the project (`official.json`). Every write
//! there goes through the app: `PluginManager`, the approval cards and the
//! Plugins page. The model's file tools refuse it, and its shell tools refuse
//! a command that names it. The shell check reads the command text, so it
//! stops an agent that wanders into the store, not one set on disguising the
//! path; trust still rests on the approvals kept outside the project.

use std::path::{Component, Path};

/// What a refused tool tells the model.
pub const PLUGIN_STORE_REFUSAL: &str = "`.somniq/plugins` is SomniQ's plugin store; only the app writes it. \
Install, enable, disable or remove packages with PluginManager, and leave official plugin \
switches to the user (Plugins page). Draft packages under `.somniq/plugin-drafts` instead.";

fn same_name(a: &std::ffi::OsStr, b: &str) -> bool {
    // NTFS and APFS compare names case-insensitively, so `.SOMNIQ/Plugins`
    // is the store too on those systems.
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Whether `path` is `<workspace>/.somniq/plugins` or anything inside it.
/// Both paths should already be absolute and normalized.
#[must_use]
pub fn is_plugin_store_path(path: &Path, workspace: &Path) -> bool {
    let Ok(rest) = strip_prefix_insensitive(path, workspace) else {
        return false;
    };
    let mut parts = rest.components().filter(|part| !matches!(part, Component::CurDir));
    matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(first)), Some(Component::Normal(second)))
            if same_name(first, crate::SOMNIQ_PROJECT_DIR_NAME) && same_name(second, "plugins")
    )
}

fn strip_prefix_insensitive<'a>(path: &'a Path, base: &Path) -> Result<&'a Path, ()> {
    if let Ok(rest) = path.strip_prefix(base) {
        return Ok(rest);
    }
    let mut rest = path.components();
    for want in base.components() {
        match (rest.next(), want) {
            (Some(Component::Normal(have)), Component::Normal(want))
                if same_name(have, &want.to_string_lossy()) => {}
            (Some(have), want) if have == want => {}
            _ => return Err(()),
        }
    }
    Ok(rest.as_path())
}

/// Whether a shell command (or REPL code) names the plugin store, with either
/// slash. `.somniq/plugin-drafts` and the like are not the store.
#[must_use]
pub fn command_names_plugin_store(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase().replace('\\', "/");
    let needle = format!("{}/plugins", crate::SOMNIQ_PROJECT_DIR_NAME);
    normalized.match_indices(&needle).any(|(at, _)| {
        normalized[at + needle.len()..]
            .chars()
            .next()
            .is_none_or(|next| !(next.is_ascii_alphanumeric() || matches!(next, '-' | '_' | '.')))
    })
}

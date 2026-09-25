use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

pub const ARIS_RUNTIME_ROOT_ENV: &str = "ARIS_RUNTIME_ROOT";
pub const ARIS_WORKSPACE_ROOT_ENV: &str = "ARIS_WORKSPACE_ROOT";
pub const ARIS_RUN_STATE_DIR_ENV: &str = "ARIS_RUN_STATE_DIR";
pub const ARIS_SESSIONS_DIR_ENV: &str = "ARIS_SESSIONS_DIR";
pub const ARIS_AGENT_STORE_DIR_ENV: &str = "ARIS_AGENT_STORE_DIR";
pub const CLAWD_AGENT_STORE_ENV: &str = "CLAWD_AGENT_STORE";

pub const SOMNIQ_RUNTIME_DIR_NAME: &str = "runtime";
pub const RUN_STATE_DIR_NAME: &str = "run-state";
pub const SESSIONS_DIR_NAME: &str = "sessions";
pub const AGENTS_DIR_NAME: &str = "agents";
pub const LEGACY_CLAUDE_DIR_NAME: &str = ".claude";
pub const LEGACY_CLAWD_AGENTS_DIR_NAME: &str = ".clawd-agents";

#[must_use]
pub fn workspace_root_from_env() -> PathBuf {
    crate::execution_env_var_os(ARIS_WORKSPACE_ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::execution_current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// The same path without Windows' extended-length (`\\?\`) prefix.
///
/// `std::fs::canonicalize` returns the *verbatim* form on Windows, so
/// `F:\Agent\Aris` comes back as `\\?\F:\Agent\Aris`. Win32 accepts that, but
/// it is a landmine everywhere a path becomes text. A POSIX shell collapses
/// the leading `\\` to a single `\` inside double quotes, so a command built
/// as `"\\?\F:\tool"` reaches `exec` as `\?\F:\tool` and dies with "No such
/// file or directory" — the prefix cannot survive being quoted. Any path that
/// reaches a model, an error message or an external program has to be in the
/// ordinary form, and the cheapest way to guarantee that is to never let the
/// verbatim form escape [`canonicalize`] in the first place.
///
/// The prefix is kept in the cases where dropping it would change which file
/// the path names, because a verbatim path is passed to the filesystem
/// unnormalized: reserved DOS device names (`CON`, `LPT1`), components with a
/// trailing dot or space, `\\?\Volume{…}` paths that have no drive-letter
/// spelling, and paths at or beyond `MAX_PATH`, which Win32 only resolves in
/// the verbatim form. Those are all shapes `canonicalize` effectively never
/// produces for a real workspace; keeping them verbatim is the safe default
/// rather than a case worth optimizing.
#[must_use]
pub fn plain_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    #[cfg(windows)]
    {
        return strip_verbatim_prefix(path);
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

/// [`std::fs::canonicalize`] that cannot return a `\\?\` path.
///
/// Prefer this over `std::fs::canonicalize` anywhere the result can be shown,
/// logged, handed to a subprocess, or compared against another canonical path.
/// Mixing the two forms is its own bug: `Path::starts_with` between a stripped
/// root and a verbatim child is always false, which reads as a spurious
/// "outside the workspace" rejection.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(plain_path)
}

/// Longest path Win32 resolves without the extended-length prefix.
#[cfg(windows)]
const MAX_PATH: usize = 260;

#[cfg(windows)]
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    // `\\?\UNC\server\share` is the verbatim spelling of `\\server\share`.
    let plain = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        if !is_drive_absolute(rest) {
            return path.to_path_buf();
        }
        rest.to_string()
    } else {
        return path.to_path_buf();
    };

    if plain.len() >= MAX_PATH || needs_verbatim_form(&plain) {
        return path.to_path_buf();
    }
    PathBuf::from(plain)
}

#[cfg(windows)]
fn is_drive_absolute(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|drive| drive.is_ascii_alphabetic())
        && characters.next() == Some(':')
        && characters.next() == Some('\\')
}

/// Whether Win32 would resolve this path differently once it is normalized.
#[cfg(windows)]
fn needs_verbatim_form(value: &str) -> bool {
    // A verbatim path treats `/` as an ordinary character rather than a
    // separator, so a path containing one does not survive the round trip.
    value.contains('/')
        || value.split('\\').any(|component| {
            component.ends_with('.')
                || component.ends_with(' ')
                || is_reserved_device_name(component)
        })
}

#[cfg(windows)]
fn is_reserved_device_name(component: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    const NUMBERED: [&str; 2] = ["COM", "LPT"];

    let stem = component.split('.').next().unwrap_or(component);
    if RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return true;
    }
    NUMBERED.iter().any(|prefix| {
        stem.len() == prefix.len() + 1
            && stem
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            && stem
                .chars()
                .next_back()
                .is_some_and(|digit| digit.is_ascii_digit() && digit != '0')
    })
}

/// Return whether a command can be resolved from the current process `PATH`.
///
/// Windows resolution honours `PATHEXT` (so `gh` finds `gh.exe`); Unix also
/// requires an executable bit. Keeping this in runtime avoids every surface
/// inventing a different `which`/`where`/PATH scan.
#[must_use]
pub fn command_exists(command: &str) -> bool {
    if command.trim().is_empty() {
        return false;
    }
    let command_path = Path::new(command);
    if command_path.components().count() > 1 || command_path.is_absolute() {
        return executable_file(command_path);
    }
    env::var_os("PATH")
        .is_some_and(|paths| command_exists_in_paths(command, env::split_paths(&paths)))
}

fn command_exists_in_paths(command: &str, paths: impl IntoIterator<Item = PathBuf>) -> bool {
    let has_extension = Path::new(command).extension().is_some();
    for directory in paths {
        let candidate = directory.join(command);
        if executable_file(&candidate) {
            return true;
        }
        #[cfg(windows)]
        if !has_extension
            && pathexts()
                .into_iter()
                .any(|extension| executable_file(&candidate.with_extension(extension)))
        {
            return true;
        }
        #[cfg(not(windows))]
        let _ = has_extension;
    }
    false
}

#[cfg(windows)]
fn pathexts() -> Vec<String> {
    env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .map(str::trim)
                .filter(|extension| !extension.is_empty())
                .map(|extension| extension.trim_start_matches('.').to_string())
                .collect()
        })
        .filter(|extensions: &Vec<String>| !extensions.is_empty())
        .unwrap_or_else(|| vec!["COM".into(), "EXE".into(), "BAT".into(), "CMD".into()])
}

fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

#[must_use]
pub fn somniq_config_dir_from_env() -> PathBuf {
    env::var_os("ARIS_CONFIG_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(crate::home_dir())
                .join(".config")
                .join("SomniQ")
        })
}

#[must_use]
pub fn project_runtime_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    crate::execution_env_var_os(ARIS_RUNTIME_ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::somniq_project_dir(workspace).join(SOMNIQ_RUNTIME_DIR_NAME))
}

#[must_use]
pub fn project_runtime_dir_from_env() -> PathBuf {
    project_runtime_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_run_state_dir_from_env() -> PathBuf {
    project_run_state_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_run_state_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    crate::execution_env_var_os(ARIS_RUN_STATE_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(RUN_STATE_DIR_NAME))
}

#[must_use]
pub fn project_sessions_dir_from_env() -> PathBuf {
    project_sessions_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_sessions_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    crate::execution_env_var_os(ARIS_SESSIONS_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(SESSIONS_DIR_NAME))
}

#[must_use]
pub fn project_agent_store_dir_from_env() -> PathBuf {
    project_agent_store_dir_for(workspace_root_from_env())
}

#[must_use]
pub fn project_agent_store_dir_for(workspace: impl AsRef<Path>) -> PathBuf {
    crate::execution_env_var_os(ARIS_AGENT_STORE_DIR_ENV)
        .or_else(|| crate::execution_env_var_os(CLAWD_AGENT_STORE_ENV))
        .map(PathBuf::from)
        .unwrap_or_else(|| project_runtime_dir_for(workspace).join(AGENTS_DIR_NAME))
}

pub fn migrate_legacy_project_runtime_dirs(workspace: impl AsRef<Path>) -> io::Result<()> {
    let workspace = workspace.as_ref();
    let legacy_claude = workspace.join(LEGACY_CLAUDE_DIR_NAME);
    migrate_dir_contents(
        &legacy_claude.join(RUN_STATE_DIR_NAME),
        &project_run_state_dir_for(workspace),
    )?;
    migrate_dir_contents(
        &legacy_claude.join(SESSIONS_DIR_NAME),
        &project_sessions_dir_for(workspace),
    )?;
    migrate_dir_contents(
        &workspace.join(LEGACY_CLAWD_AGENTS_DIR_NAME),
        &project_agent_store_dir_for(workspace),
    )?;
    let _ = fs::remove_dir(&legacy_claude);
    Ok(())
}

fn migrate_dir_contents(from: &Path, to: &Path) -> io::Result<()> {
    if !from.exists() || same_path(from, to) {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if dst.exists() {
            if entry.file_type()?.is_dir() && dst.is_dir() {
                migrate_dir_contents(&src, &dst)?;
            }
            continue;
        }
        move_path(&src, &dst)?;
    }
    let _ = fs::remove_dir(from);
    Ok(())
}

fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if is_cross_device(&error) => {
            if from.is_dir() {
                copy_dir_recursive(from, to)?;
                fs::remove_dir_all(from)
            } else {
                fs::copy(from, to)?;
                fs::remove_file(from)
            }
        }
        Err(error) => Err(error),
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_cross_device(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17) | Some(18))
}

#[cfg(test)]
#[path = "tests/paths.rs"]
mod tests;

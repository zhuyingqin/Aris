//! Desktop platform integration. User-selected environments are applied after
//! these defaults; existing configuration and project storage stay in place.
#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;

/// Merge only absolute, existing directories. Never add the working directory
/// to executable search paths or displace a tool supplied by the launcher.
#[cfg(any(target_os = "macos", test))]
fn merge_tool_paths(inherited: &std::ffi::OsStr, candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::split_paths(inherited)
        .filter(|path| path.is_absolute() && path.is_dir())
        .collect();
    for path in candidates {
        if path.is_absolute() && path.is_dir() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(target_os = "macos")]
pub(crate) fn append_macos_tool_paths(home: &Path) {
    let mut candidates: Vec<PathBuf> = [
        ".local/bin",
        ".cargo/bin",
        ".volta/bin",
        ".asdf/shims",
        ".pyenv/shims",
        ".nvm/current/bin",
        "miniforge3/bin",
        "miniconda3/bin",
    ]
    .into_iter()
    .map(|relative| home.join(relative))
    .collect();
    candidates.extend(
        [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/Library/TeX/texbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    // MacTeX and other installers register paths here for login shells. Finder
    // does not run path_helper, so read its data without launching a shell.
    let mut files = vec![PathBuf::from("/etc/paths")];
    if let Ok(entries) = std::fs::read_dir("/etc/paths.d") {
        let mut extra: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
        extra.sort();
        files.extend(extra);
    }
    for file in files {
        if let Ok(contents) = std::fs::read_to_string(file) {
            candidates.extend(
                contents
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .map(PathBuf::from),
            );
        }
    }
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    if let Ok(path) = std::env::join_paths(merge_tool_paths(&inherited, candidates)) {
        std::env::set_var("PATH", path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finder_path_adds_tools_with_spaces_without_overriding_inherited_selection() {
        let root = std::env::temp_dir().join(format!("somniq-platform-{}", std::process::id()));
        let selected = root.join("Selected Python/bin");
        let brew = root.join("Homebrew/bin");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::create_dir_all(&brew).unwrap();
        let inherited = std::env::join_paths([&selected]).unwrap();
        assert_eq!(
            merge_tool_paths(
                &inherited,
                vec![
                    brew.clone(),
                    selected.clone(),
                    brew.clone(),
                    root.join("missing"),
                    PathBuf::from(".")
                ]
            ),
            vec![selected, brew]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

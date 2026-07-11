use super::*;

fn fixture_paths() -> UpstreamPaths {
    let workspace_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    UpstreamPaths::from_workspace_dir(workspace_dir)
}

fn has_upstream_fixture(paths: &UpstreamPaths) -> bool {
    paths.commands_path().is_file() && paths.tools_path().is_file() && paths.cli_path().is_file()
}

#[test]
fn extracts_non_empty_manifests_from_upstream_repo() {
    let paths = fixture_paths();
    if !has_upstream_fixture(&paths) {
        return;
    }
    let manifest = extract_manifest(&paths).expect("manifest should load");
    assert!(!manifest.commands.entries().is_empty());
    assert!(!manifest.tools.entries().is_empty());
    assert!(!manifest.bootstrap.phases().is_empty());
}

#[test]
fn detects_known_upstream_command_symbols() {
    let paths = fixture_paths();
    if !paths.commands_path().is_file() {
        return;
    }
    let commands =
        extract_commands(&fs::read_to_string(paths.commands_path()).expect("commands.ts"));
    let names: Vec<_> = commands
        .entries()
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert!(names.contains(&"addDir"));
    assert!(names.contains(&"review"));
    assert!(!names.contains(&"INTERNAL_ONLY_COMMANDS"));
}

#[test]
fn detects_known_upstream_tool_symbols() {
    let paths = fixture_paths();
    if !paths.tools_path().is_file() {
        return;
    }
    let tools = extract_tools(&fs::read_to_string(paths.tools_path()).expect("tools.ts"));
    let names: Vec<_> = tools
        .entries()
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert!(names.contains(&"AgentTool"));
    assert!(names.contains(&"BashTool"));
}

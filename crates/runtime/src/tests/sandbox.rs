use super::{
    build_linux_sandbox_command, detect_container_environment_from, FilesystemIsolationMode,
    SandboxConfig, SandboxDetectionInputs,
};
use std::path::Path;

#[test]
fn detects_container_markers_from_multiple_sources() {
    let detected = detect_container_environment_from(SandboxDetectionInputs {
        env_pairs: vec![("container".to_string(), "docker".to_string())],
        dockerenv_exists: true,
        containerenv_exists: false,
        proc_1_cgroup: Some("12:memory:/docker/abc"),
    });

    assert!(detected.in_container);
    assert!(detected
        .markers
        .iter()
        .any(|marker| marker == "/.dockerenv"));
    assert!(detected
        .markers
        .iter()
        .any(|marker| marker == "env:container=docker"));
    assert!(detected
        .markers
        .iter()
        .any(|marker| marker == "/proc/1/cgroup:docker"));
}

#[test]
fn resolves_request_with_overrides() {
    let config = SandboxConfig {
        enabled: Some(true),
        namespace_restrictions: Some(true),
        network_isolation: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: vec!["logs".to_string()],
        strict_mode: None,
    };

    let request = config.resolve_request(
        Some(true),
        Some(false),
        Some(true),
        Some(FilesystemIsolationMode::AllowList),
        Some(vec!["tmp".to_string()]),
    );

    assert!(request.enabled);
    assert!(!request.namespace_restrictions);
    assert!(request.network_isolation);
    assert_eq!(request.filesystem_mode, FilesystemIsolationMode::AllowList);
    assert_eq!(request.allowed_mounts, vec!["tmp"]);
}

#[test]
fn builds_linux_launcher_with_network_flag_when_requested() {
    let config = SandboxConfig::default();
    let status = super::resolve_sandbox_status_for_request(
        &config.resolve_request(
            Some(true),
            Some(true),
            Some(true),
            Some(FilesystemIsolationMode::WorkspaceOnly),
            None,
        ),
        Path::new("/workspace"),
    );

    if let Some(launcher) =
        build_linux_sandbox_command("printf hi", Path::new("/workspace"), &status)
    {
        assert_eq!(launcher.program, "unshare");
        assert!(launcher.args.iter().any(|arg| arg == "--mount"));
        assert!(launcher.args.iter().any(|arg| arg == "--net") == status.network_active);
    }
}

// v0.4.13 regression — issue #238 strict-mode lock.
// Config opts in to strict_mode + enabled=true, LLM tries to override
// enabled=false. Strict mode must win: the resulting request keeps the
// sandbox enabled regardless of what the model asked.
#[test]
fn strict_mode_overrides_llm_disable() {
    let config = SandboxConfig {
        enabled: Some(true),
        namespace_restrictions: None,
        network_isolation: None,
        filesystem_mode: None,
        allowed_mounts: vec![],
        strict_mode: Some(true),
    };

    let request = config.resolve_request(Some(false), None, None, None, None);

    assert!(
        request.enabled,
        "strict mode must ignore LLM enabled=false override"
    );
}

// v0.4.13 regression — strict mode must uniformly ignore every override
// axis. The earlier landmine (#238) was that a single hole (e.g. only
// namespace_restrictions getting the strict treatment) lets an LLM relax
// sandbox policy by attacking the unprotected axis. Set the config so
// that every axis disagrees with the LLM override, then assert every
// field on the resolved request matches the config side.
#[test]
fn strict_mode_ignores_all_five_llm_overrides() {
    let config = SandboxConfig {
        enabled: Some(true),
        namespace_restrictions: Some(true),
        network_isolation: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: vec!["a".to_string()],
        strict_mode: Some(true),
    };

    let request = config.resolve_request(
        Some(false),
        Some(false),
        Some(true),
        Some(FilesystemIsolationMode::AllowList),
        Some(vec!["b".to_string()]),
    );

    assert!(request.enabled, "enabled must follow config under strict");
    assert!(
        request.namespace_restrictions,
        "namespace_restrictions must follow config under strict"
    );
    assert!(
        !request.network_isolation,
        "network_isolation must follow config under strict"
    );
    assert_eq!(
        request.filesystem_mode,
        FilesystemIsolationMode::WorkspaceOnly,
        "filesystem_mode must follow config under strict"
    );
    assert_eq!(
        request.allowed_mounts,
        vec!["a".to_string()],
        "allowed_mounts must follow config under strict"
    );
}

// v0.4.13 regression — confirms that with strict_mode = None (the
// default / pre-v0.4.12 behaviour), LLM overrides still win. Companion
// to `resolves_request_with_overrides` above but spelled out explicitly
// so a future refactor that flips the default to strict can't silently
// break backward compat.
#[test]
fn default_non_strict_honors_llm_overrides() {
    let config = SandboxConfig {
        enabled: Some(true),
        namespace_restrictions: Some(true),
        network_isolation: Some(false),
        filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
        allowed_mounts: vec!["a".to_string()],
        strict_mode: None,
    };

    let request = config.resolve_request(
        Some(false),
        Some(false),
        Some(true),
        Some(FilesystemIsolationMode::AllowList),
        Some(vec!["b".to_string()]),
    );

    assert!(!request.enabled, "LLM override should disable sandbox");
    assert!(
        !request.namespace_restrictions,
        "LLM override should relax namespace_restrictions"
    );
    assert!(
        request.network_isolation,
        "LLM override should turn on network_isolation"
    );
    assert_eq!(
        request.filesystem_mode,
        FilesystemIsolationMode::AllowList,
        "LLM override should switch filesystem_mode"
    );
    assert_eq!(
        request.allowed_mounts,
        vec!["b".to_string()],
        "LLM override should swap allowed_mounts"
    );
}

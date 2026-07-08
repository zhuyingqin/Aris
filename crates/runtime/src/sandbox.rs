use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FilesystemIsolationMode {
    Off,
    #[default]
    WorkspaceOnly,
    AllowList,
}

impl FilesystemIsolationMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::WorkspaceOnly => "workspace-only",
            Self::AllowList => "allow-list",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxConfig {
    pub enabled: Option<bool>,
    pub namespace_restrictions: Option<bool>,
    pub network_isolation: Option<bool>,
    pub filesystem_mode: Option<FilesystemIsolationMode>,
    pub allowed_mounts: Vec<String>,
    /// v0.4.12 #238 — when `Some(true)`, [`resolve_request`] ignores all
    /// LLM-supplied override arguments (`enabled`, `namespace`, `network`,
    /// `filesystem_mode`, `allowed_mounts`) and uses the config value
    /// only. Lets users hard-lock sandbox policy so a tool call with
    /// `dangerouslyDisableSandbox: true` can't silently bypass.
    /// Default `None` (permissive) preserves the pre-v0.4.12 behaviour.
    pub strict_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxRequest {
    pub enabled: bool,
    pub namespace_restrictions: bool,
    pub network_isolation: bool,
    pub filesystem_mode: FilesystemIsolationMode,
    pub allowed_mounts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContainerEnvironment {
    pub in_container: bool,
    pub markers: Vec<String>,
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxStatus {
    pub enabled: bool,
    pub requested: SandboxRequest,
    pub supported: bool,
    pub active: bool,
    pub namespace_supported: bool,
    pub namespace_active: bool,
    pub network_supported: bool,
    pub network_active: bool,
    pub filesystem_mode: FilesystemIsolationMode,
    pub filesystem_active: bool,
    pub allowed_mounts: Vec<String>,
    pub in_container: bool,
    pub container_markers: Vec<String>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxDetectionInputs<'a> {
    pub env_pairs: Vec<(String, String)>,
    pub dockerenv_exists: bool,
    pub containerenv_exists: bool,
    pub proc_1_cgroup: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxSandboxCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl SandboxConfig {
    /// `true` if the runtime has been told to hard-lock sandbox policy
    /// against LLM overrides. v0.4.12 #238.
    #[must_use]
    pub fn is_strict(&self) -> bool {
        self.strict_mode.unwrap_or(false)
    }

    /// Resolve the effective per-call [`SandboxRequest`] from a set of
    /// optional LLM-supplied overrides.
    ///
    /// **v0.4.12 #238**: when `self.is_strict()` returns `true`, **all**
    /// override arguments are ignored — only the values configured by
    /// the user (or defaults) are honoured. This closes the gap where
    /// a tool call with `dangerouslyDisableSandbox: true` could silently
    /// bypass a user's stricter config. The check is applied to every
    /// override (enabled, namespace, network, filesystem, allowed_mounts)
    /// uniformly so a LLM can't relax any axis under strict mode.
    #[must_use]
    pub fn resolve_request(
        &self,
        enabled_override: Option<bool>,
        namespace_override: Option<bool>,
        network_override: Option<bool>,
        filesystem_mode_override: Option<FilesystemIsolationMode>,
        allowed_mounts_override: Option<Vec<String>>,
    ) -> SandboxRequest {
        let (
            effective_enabled_override,
            effective_namespace_override,
            effective_network_override,
            effective_filesystem_override,
            effective_mounts_override,
        ) = if self.is_strict() {
            (None, None, None, None, None)
        } else {
            (
                enabled_override,
                namespace_override,
                network_override,
                filesystem_mode_override,
                allowed_mounts_override,
            )
        };
        SandboxRequest {
            enabled: effective_enabled_override.unwrap_or(self.enabled.unwrap_or(true)),
            namespace_restrictions: effective_namespace_override
                .unwrap_or(self.namespace_restrictions.unwrap_or(true)),
            network_isolation: effective_network_override
                .unwrap_or(self.network_isolation.unwrap_or(false)),
            filesystem_mode: effective_filesystem_override
                .or(self.filesystem_mode)
                .unwrap_or_default(),
            allowed_mounts: effective_mounts_override
                .unwrap_or_else(|| self.allowed_mounts.clone()),
        }
    }
}

#[must_use]
pub fn detect_container_environment() -> ContainerEnvironment {
    let proc_1_cgroup = fs::read_to_string("/proc/1/cgroup").ok();
    detect_container_environment_from(SandboxDetectionInputs {
        env_pairs: env::vars().collect(),
        dockerenv_exists: Path::new("/.dockerenv").exists(),
        containerenv_exists: Path::new("/run/.containerenv").exists(),
        proc_1_cgroup: proc_1_cgroup.as_deref(),
    })
}

#[must_use]
pub fn detect_container_environment_from(
    inputs: SandboxDetectionInputs<'_>,
) -> ContainerEnvironment {
    let mut markers = Vec::new();
    if inputs.dockerenv_exists {
        markers.push("/.dockerenv".to_string());
    }
    if inputs.containerenv_exists {
        markers.push("/run/.containerenv".to_string());
    }
    for (key, value) in inputs.env_pairs {
        let normalized = key.to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "container" | "docker" | "podman" | "kubernetes_service_host"
        ) && !value.is_empty()
        {
            markers.push(format!("env:{key}={value}"));
        }
    }
    if let Some(cgroup) = inputs.proc_1_cgroup {
        for needle in ["docker", "containerd", "kubepods", "podman", "libpod"] {
            if cgroup.contains(needle) {
                markers.push(format!("/proc/1/cgroup:{needle}"));
            }
        }
    }
    markers.sort();
    markers.dedup();
    ContainerEnvironment {
        in_container: !markers.is_empty(),
        markers,
    }
}

#[must_use]
pub fn resolve_sandbox_status(config: &SandboxConfig, cwd: &Path) -> SandboxStatus {
    let request = config.resolve_request(None, None, None, None, None);
    resolve_sandbox_status_for_request(&request, cwd)
}

#[must_use]
pub fn resolve_sandbox_status_for_request(request: &SandboxRequest, cwd: &Path) -> SandboxStatus {
    let container = detect_container_environment();
    let namespace_supported = cfg!(target_os = "linux") && command_exists("unshare");
    let network_supported = namespace_supported;
    let filesystem_active =
        request.enabled && request.filesystem_mode != FilesystemIsolationMode::Off;
    let mut fallback_reasons = Vec::new();

    if request.enabled && request.namespace_restrictions && !namespace_supported {
        fallback_reasons
            .push("namespace isolation unavailable (requires Linux with `unshare`)".to_string());
    }
    if request.enabled && request.network_isolation && !network_supported {
        fallback_reasons
            .push("network isolation unavailable (requires Linux with `unshare`)".to_string());
    }
    if request.enabled
        && request.filesystem_mode == FilesystemIsolationMode::AllowList
        && request.allowed_mounts.is_empty()
    {
        fallback_reasons
            .push("filesystem allow-list requested without configured mounts".to_string());
    }

    let active = request.enabled
        && (!request.namespace_restrictions || namespace_supported)
        && (!request.network_isolation || network_supported);

    let allowed_mounts = normalize_mounts(&request.allowed_mounts, cwd);

    SandboxStatus {
        enabled: request.enabled,
        requested: request.clone(),
        supported: namespace_supported,
        active,
        namespace_supported,
        namespace_active: request.enabled && request.namespace_restrictions && namespace_supported,
        network_supported,
        network_active: request.enabled && request.network_isolation && network_supported,
        filesystem_mode: request.filesystem_mode,
        filesystem_active,
        allowed_mounts,
        in_container: container.in_container,
        container_markers: container.markers,
        fallback_reason: (!fallback_reasons.is_empty()).then(|| fallback_reasons.join("; ")),
    }
}

#[must_use]
pub fn build_linux_sandbox_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> Option<LinuxSandboxCommand> {
    if !cfg!(target_os = "linux")
        || !status.enabled
        || (!status.namespace_active && !status.network_active)
    {
        return None;
    }

    let mut args = vec![
        "--user".to_string(),
        "--map-root-user".to_string(),
        "--mount".to_string(),
        "--ipc".to_string(),
        "--pid".to_string(),
        "--uts".to_string(),
        "--fork".to_string(),
    ];
    if status.network_active {
        args.push("--net".to_string());
    }
    args.push("sh".to_string());
    args.push("-lc".to_string());
    args.push(command.to_string());

    let sandbox_home = crate::somniq_sandbox_home_dir(cwd);
    let sandbox_tmp = crate::somniq_sandbox_tmp_dir(cwd);
    let mut env = vec![
        ("HOME".to_string(), sandbox_home.display().to_string()),
        ("TMPDIR".to_string(), sandbox_tmp.display().to_string()),
        (
            "CLAWD_SANDBOX_FILESYSTEM_MODE".to_string(),
            status.filesystem_mode.as_str().to_string(),
        ),
        (
            "CLAWD_SANDBOX_ALLOWED_MOUNTS".to_string(),
            status.allowed_mounts.join(":"),
        ),
    ];
    if let Ok(path) = env::var("PATH") {
        env.push(("PATH".to_string(), path));
    }

    Some(LinuxSandboxCommand {
        program: "unshare".to_string(),
        args,
        env,
    })
}

fn normalize_mounts(mounts: &[String], cwd: &Path) -> Vec<String> {
    let cwd = cwd.to_path_buf();
    mounts
        .iter()
        .map(|mount| {
            let path = PathBuf::from(mount);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .map(|path| path.display().to_string())
        .collect()
}

fn command_exists(command: &str) -> bool {
    env::var_os("PATH")
        .is_some_and(|paths| env::split_paths(&paths).any(|path| path.join(command).exists()))
}

#[cfg(test)]
mod tests {
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
}

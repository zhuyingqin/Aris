//! What a package's MCP servers say they need (`somniq.capabilities`), checked
//! at preview and handed to the process the host starts.
//!
//! A declaration grants nothing by itself: a server gets what it declared, the
//! user approved and this computer can do. Each item says how far the host
//! enforces it here ([`capability_enforcement`]), and the approval card shows
//! that label, so "declared" is never read as "isolated".
//!
//! Design: `docs/development-logic/plugin-capabilities.md`.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use super::{Diagnostic, PluginCapabilities, PluginMcp};

/// The `capabilities.schemaVersion` this host reads.
pub const CAPABILITIES_SCHEMA_VERSION: u32 = 1;
/// Variables a server may take from this computer's environment.
pub const MAX_PASSTHROUGH_ENV: usize = 32;
/// Hosts a server may list.
pub const MAX_NETWORK_HOSTS: usize = 32;
/// Workspace files a server may be handed, and their total size.
pub const MAX_WORKSPACE_FILES: usize = 16;
pub const MAX_WORKSPACE_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Launchers that download the code they run when they start. A package may
/// use them only with an exact version, and the card says the approval does
/// not cover what they download.
pub const RUNTIME_FETCH_LAUNCHERS: &[&str] = &["npx", "bunx", "uvx", "pnpm dlx", "yarn dlx", "pipx run", "deno run"];

/// One MCP server's declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCapability {
    /// Variables taken from this computer's environment, by name. Their
    /// values never appear on a card.
    #[serde(default)]
    pub env: Vec<String>,
    pub network: NetworkCapability,
    pub workspace: WorkspaceAccess,
    /// Project files the server needs, handed over as the copies approved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkCapability {
    pub access: NetworkAccess,
    /// The addresses it means to reach; absent means any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkAccess {
    None,
    Required,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceAccess {
    None,
    Read,
    Write,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilitiesDocument {
    schema_version: u32,
    #[serde(default)]
    mcp: BTreeMap<String, serde_json::Value>,
}

/// How far the host enforces one kind of limit on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Enforcement {
    /// The host set the process up this way (its environment, its job). Code
    /// running as the same user may still get more by other means.
    Enforced,
    /// The host did it, but there is a known way around it.
    BestEffort,
    /// The host cannot do it here; the plugin is trusted to keep to it.
    Declared,
}

/// Every limit, with how far this computer enforces it. One function decides
/// both what the card says and how the process is started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEnforcement {
    /// Only the platform, host, passed-through and package variables.
    pub environment: Enforcement,
    /// Working directory, process tree and framing cannot be set by the package.
    pub host_controls: Enforcement,
    /// The working directory is the plugin's data directory, never the project.
    pub working_directory: Enforcement,
    /// Its processes end with SomniQ.
    pub process_tree: Enforcement,
    /// The workspace files it gets are the copies approved.
    pub workspace_files: Enforcement,
    /// No network when it declares none.
    pub network_none: Enforcement,
    /// Only the listed hosts.
    pub network_hosts: Enforcement,
    /// The declared level of project access, and no reading of originals.
    pub workspace_access: Enforcement,
}

/// What this computer enforces. Network and file-system limits need
/// system-level isolation the host does not set up yet on any platform.
#[must_use]
pub fn capability_enforcement() -> CapabilityEnforcement {
    CapabilityEnforcement {
        environment: Enforcement::Enforced,
        host_controls: Enforcement::Enforced,
        working_directory: Enforcement::Enforced,
        // A Job Object on Windows; elsewhere a process group, which a child
        // can leave with setsid.
        process_tree: if cfg!(windows) { Enforcement::Enforced } else { Enforcement::BestEffort },
        workspace_files: Enforcement::Enforced,
        network_none: Enforcement::Declared,
        network_hosts: Enforcement::Declared,
        workspace_access: Enforcement::Declared,
    }
}

/// The meaning of each label, as the card writes it.
pub const ENFORCEMENT_MEANINGS: &[(&str, &str)] = &[
    ("enforced", "The host set the plugin's process up this way, e.g. its environment and the job it belongs to. Code running as the same user may still get more by other means."),
    ("best-effort", "The host did it, but there is a known way around it."),
    ("declared", "The host cannot do it on this computer; the plugin is trusted to keep to it."),
];

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// A host name as a declaration may list it: a name or an address, no scheme,
/// port or path; `*.` may lead to mean every subdomain.
fn valid_host(host: &str) -> bool {
    let bare = host.strip_prefix("*.").unwrap_or(host);
    !bare.is_empty()
        && bare.len() <= 253
        && bare
            .split('.')
            .all(|label| !label.is_empty() && label.len() <= 63 && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
}

/// A workspace file as a declaration may name it: project-relative, forward
/// slashes or not, nothing that climbs out, nothing under `.somniq/`.
pub(super) fn workspace_file_path(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    let candidate = Path::new(&normalized);
    // `Path` parses for the platform it runs on: on Linux `C:/x.py` is a
    // relative path, but the same declaration names a drive on Windows. A
    // colon is never part of a portable file name (on NTFS it also selects an
    // alternate data stream), so it is refused everywhere.
    if normalized.trim().is_empty()
        || normalized.contains(':')
        || candidate.is_absolute()
        || normalized.starts_with('/')
        || candidate.components().any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("{path} must be a project-relative file path without .. or a drive"));
    }
    if normalized == ".somniq" || normalized.starts_with(".somniq/") {
        return Err(format!("{path} is under .somniq/, which belongs to SomniQ"));
    }
    Ok(normalized)
}

/// Check `somniq.capabilities` against the package's MCP servers and attach
/// each declaration to its server. Every server needs one: a server that does
/// not say what it needs cannot be enabled.
pub(super) fn inspect_capabilities(
    manifest: &serde_json::Value,
    capabilities: &mut PluginCapabilities,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let declared = manifest.get("somniq").and_then(|somniq| somniq.get("capabilities"));
    let error = |code: &str, message: String, path: String| {
        Diagnostic::error(code, message).in_file("package.json").at(path)
    };
    let mut entries: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    if let Some(value) = declared {
        match serde_json::from_value::<CapabilitiesDocument>(value.clone()) {
            Ok(document) if document.schema_version != CAPABILITIES_SCHEMA_VERSION => diagnostics.push(error(
                "capabilities-field",
                format!("somniq.capabilities.schemaVersion must be {CAPABILITIES_SCHEMA_VERSION}"),
                "/somniq/capabilities/schemaVersion".into(),
            )),
            Ok(document) => entries = document.mcp,
            Err(problem) => diagnostics.push(error(
                "capabilities-field",
                format!("somniq.capabilities: {problem}"),
                "/somniq/capabilities".into(),
            )),
        }
    }
    let servers: BTreeSet<String> = capabilities.mcp_servers.iter().map(|server| server.name.clone()).collect();
    for name in entries.keys().filter(|name| !servers.contains(*name)) {
        diagnostics.push(error(
            "capabilities-server",
            format!("somniq.capabilities.mcp names {name}, but the package has no MCP server of that serverName"),
            format!("/somniq/capabilities/mcp/{name}"),
        ));
    }
    for server in &mut capabilities.mcp_servers {
        let path = format!("/somniq/capabilities/mcp/{}", server.name);
        let Some(value) = entries.get(&server.name) else {
            diagnostics.push(error(
                "capabilities-missing",
                format!(
                    "The MCP server {} does not declare what it needs: add somniq.capabilities.mcp.{} with network, workspace and env",
                    server.name, server.name
                ),
                path,
            ));
            continue;
        };
        let capability: McpCapability = match serde_json::from_value(value.clone()) {
            Ok(capability) => capability,
            Err(problem) => {
                diagnostics.push(error("capabilities-field", format!("{}: {problem}", server.name), path));
                continue;
            }
        };
        let before = diagnostics.len();
        check_capability(server, &capability, &path, diagnostics);
        if diagnostics.len() == before {
            server.capability = Some(capability);
        }
    }
}

fn check_capability(server: &PluginMcp, capability: &McpCapability, path: &str, diagnostics: &mut Vec<Diagnostic>) {
    let error = |code: &str, message: String, at: String| {
        Diagnostic::error(code, message).in_file("package.json").at(at)
    };
    if capability.env.len() > MAX_PASSTHROUGH_ENV {
        diagnostics.push(error("capabilities-field", format!("env lists at most {MAX_PASSTHROUGH_ENV} variables"), format!("{path}/env")));
    }
    let own: BTreeSet<String> = server.env.keys().map(|key| key.to_ascii_uppercase()).collect();
    let mut seen = BTreeSet::new();
    for (index, name) in capability.env.iter().enumerate() {
        let at = format!("{path}/env/{index}");
        if !valid_env_name(name) {
            diagnostics.push(error("env-key", format!("{name} is not a variable name: use [A-Za-z_][A-Za-z0-9_]*"), at));
        } else if super::dsh::reserved_env_key(name) {
            diagnostics.push(error("env-reserved", format!("{name} is reserved: the host sets it, or it changes how an interpreter loads code"), at));
        } else if own.contains(&name.to_ascii_uppercase()) {
            diagnostics.push(error("env-overlap", format!("{name} is also set in the server's own env; keep one of the two"), at));
        } else if !seen.insert(name.to_ascii_uppercase()) {
            diagnostics.push(error("env-key", format!("{name} is listed twice"), at));
        }
    }
    match (&capability.network.access, &capability.network.hosts) {
        (NetworkAccess::None, Some(_)) => diagnostics.push(error(
            "capabilities-field",
            "network.hosts lists addresses for a server that declares network.access none".into(),
            format!("{path}/network/hosts"),
        )),
        (NetworkAccess::Required, Some(hosts)) => {
            if hosts.len() > MAX_NETWORK_HOSTS {
                diagnostics.push(error("capabilities-field", format!("network.hosts lists at most {MAX_NETWORK_HOSTS} hosts"), format!("{path}/network/hosts")));
            }
            for (index, host) in hosts.iter().enumerate() {
                if !valid_host(host) {
                    diagnostics.push(error(
                        "capabilities-field",
                        format!("{host} is not a host name: write api.example.org or *.example.org, without a scheme, port or path"),
                        format!("{path}/network/hosts/{index}"),
                    ));
                }
            }
        }
        _ => {}
    }
    if capability.workspace_files.len() > MAX_WORKSPACE_FILES {
        diagnostics.push(error("workspace-file", format!("workspaceFiles lists at most {MAX_WORKSPACE_FILES} files"), format!("{path}/workspaceFiles")));
    }
    let mut files = BTreeSet::new();
    for (index, file) in capability.workspace_files.iter().enumerate() {
        match workspace_file_path(file) {
            Ok(normalized) if !files.insert(normalized.clone()) => {
                diagnostics.push(error("workspace-file", format!("{file} is listed twice"), format!("{path}/workspaceFiles/{index}")));
            }
            Ok(_) => {}
            Err(problem) => diagnostics.push(error("workspace-file", problem, format!("{path}/workspaceFiles/{index}"))),
        }
    }
}

/// Every workspace file the package's servers declare, normalized and sorted.
#[must_use]
pub fn declared_workspace_files(capabilities: &PluginCapabilities) -> Vec<String> {
    let files: BTreeSet<String> = capabilities
        .mcp_servers
        .iter()
        .filter_map(|server| server.capability.as_ref())
        .flat_map(|capability| capability.workspace_files.iter())
        .filter_map(|file| workspace_file_path(file).ok())
        .collect();
    files.into_iter().collect()
}

/// The declared workspace files as they are in `project` now: each must be a
/// regular file (no link), and together they must fit the limit. Checked when
/// a draft is previewed, installed or upgraded, and again at approval.
pub(super) fn check_workspace_files(project: &Path, files: &[String]) -> Vec<Diagnostic> {
    let mut problems = vec![];
    let mut total = 0u64;
    for file in files {
        let path = project.join(file);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => problems.push(Diagnostic::error("workspace-file", format!("{file} is a link; name the file itself"))),
            Ok(meta) if !meta.is_file() => problems.push(Diagnostic::error("workspace-file", format!("{file} is not a regular file (directories are not handed over yet)"))),
            Ok(meta) => total += meta.len(),
            Err(_) => problems.push(Diagnostic::error("workspace-file", format!("{file} does not exist in the project"))),
        }
    }
    if total > MAX_WORKSPACE_FILE_BYTES {
        problems.push(Diagnostic::error("workspace-file", format!("The workspace files add up to {total} bytes; at most {MAX_WORKSPACE_FILE_BYTES} are handed over")));
    }
    problems
}

/// How a server's command line gets the code it runs, beyond the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum LaunchNote {
    /// A launcher downloads `spec` when the server starts; the approval does
    /// not cover what it downloads.
    RuntimeFetch { launcher: String, spec: String },
    /// The command runs a program outside the snapshot, by absolute path.
    OutsideSnapshot { program: String },
}

/// The basename of a command, without a Windows launcher extension.
fn program_name(command: &str) -> String {
    let name = Path::new(command)
        .file_name()
        .map_or_else(|| command.to_string(), |name| name.to_string_lossy().into_owned())
        .to_ascii_lowercase();
    for extension in [".cmd", ".exe", ".bat", ".ps1"] {
        if let Some(stripped) = name.strip_suffix(extension) {
            return stripped.to_string();
        }
    }
    name
}

/// An exact version in a package spec: `name@1.2.3`, `@scope/name@1.2.3`,
/// `name==1.2.3`, or a URL with `@1.2.3` in it.
fn pinned(spec: &str) -> bool {
    let version = if let Some((_, version)) = spec.rsplit_once("==") {
        version
    } else if let Some(at) = spec.rfind('@').filter(|at| *at > 0) {
        let rest = &spec[at + 1..];
        // A URL keeps going after the version: take the version part only.
        rest.split(['/', '?', '#']).next().unwrap_or(rest)
    } else {
        return false;
    };
    let core = version.split(['-', '+']).next().unwrap_or(version);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
}

/// What a server's command line fetches or runs from outside the snapshot.
/// `Err` for what a package may not do: fetch without an exact version, or
/// run a program out of the project directory (that is what workspaceFiles
/// is for).
pub fn launch_notes(server: &PluginMcp, snapshot: &Path, project: &Path) -> Result<Vec<LaunchNote>, Diagnostic> {
    // `cmd /c npx …` on Windows: look past the shell.
    let mut words: Vec<&str> = std::iter::once(server.command.as_str()).chain(server.args.iter().map(String::as_str)).collect();
    if matches!(program_name(words[0]).as_str(), "cmd") && words.get(1).is_some_and(|flag| flag.eq_ignore_ascii_case("/c")) {
        words.drain(..2);
    }
    let Some(first) = words.first() else { return Ok(vec![]) };
    let program = program_name(first);
    let rest = &words[1..];
    let launcher = match (program.as_str(), rest.first().copied()) {
        ("npx" | "bunx" | "uvx", _) => Some((program.clone(), rest)),
        ("pnpm" | "yarn", Some("dlx")) => Some((format!("{program} dlx"), &rest[1..])),
        ("pipx", Some("run")) => Some(("pipx run".to_string(), &rest[1..])),
        ("deno", Some("run")) => Some(("deno run".to_string(), &rest[1..])),
        _ => None,
    };
    if let Some((launcher, args)) = launcher {
        // The spec: an explicit --from / --spec / --package value, else the
        // first argument that is not a flag.
        let mut spec = None;
        let mut index = 0;
        while index < args.len() {
            let arg = args[index];
            if matches!(arg, "--from" | "--spec" | "--package" | "-p") {
                spec = args.get(index + 1).copied();
                break;
            }
            if let Some(value) = arg.strip_prefix("--from=").or_else(|| arg.strip_prefix("--spec=")).or_else(|| arg.strip_prefix("--package=")) {
                spec = Some(value);
                break;
            }
            if !arg.starts_with('-') {
                spec = Some(arg);
                break;
            }
            index += 1;
        }
        let spec = spec.unwrap_or_default().to_string();
        if launcher == "deno run" && !(spec.contains("://") || spec.starts_with("jsr:") || spec.starts_with("npm:")) {
            // `deno run ./server.ts` runs a file of the package.
            return Ok(vec![]);
        }
        if !pinned(&spec) {
            return Err(Diagnostic::error(
                "runtime-fetch",
                format!("{launcher} downloads {spec} when the server starts; write an exact version such as name@1.2.3 (or name==1.2.3), so what runs does not change after approval"),
            ));
        }
        return Ok(vec![LaunchNote::RuntimeFetch { launcher, spec }]);
    }
    let path = Path::new(first);
    if path.is_absolute() && !path.starts_with(snapshot) {
        let canonical_project = crate::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let canonical = crate::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if canonical.starts_with(&canonical_project) || path.starts_with(project) {
            return Err(Diagnostic::error(
                "workspace-file",
                format!("{first} is a program in the project; copy it into the package, or declare it in workspaceFiles and run it from SOMNIQ_PLUGIN_FILES"),
            ));
        }
        return Ok(vec![LaunchNote::OutsideSnapshot { program: first.to_string() }]);
    }
    Ok(vec![])
}

/// One way a server's declaration differs between two versions. `expands`
/// marks what gives it more than before: the card highlights those.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityChange {
    /// `declaration`, `env`, `network`, `hosts`, `workspace` or `workspaceFiles`.
    pub item: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub expands: bool,
}

fn level(access: WorkspaceAccess) -> &'static str {
    match access {
        WorkspaceAccess::None => "none",
        WorkspaceAccess::Read => "read",
        WorkspaceAccess::Write => "write",
    }
}

/// What changed in one server's declaration from `before` to `after`.
#[must_use]
pub fn capability_changes(before: Option<&McpCapability>, after: Option<&McpCapability>) -> Vec<CapabilityChange> {
    let change = |item: &'static str| CapabilityChange { item, added: vec![], removed: vec![], from: None, to: None, expands: false };
    let (before, after) = match (before, after) {
        (None, None) => return vec![],
        (Some(_), None) | (None, Some(_)) => {
            return vec![CapabilityChange { from: Some(before.is_some().to_string()), to: Some(after.is_some().to_string()), ..change("declaration") }]
        }
        (Some(before), Some(after)) => (before, after),
    };
    let mut changes = vec![];
    let set = |list: &[String]| list.iter().cloned().collect::<BTreeSet<_>>();
    let diff = |old: &BTreeSet<String>, new: &BTreeSet<String>| (new.difference(old).cloned().collect::<Vec<_>>(), old.difference(new).cloned().collect::<Vec<_>>());
    let (added, removed) = diff(&set(&before.env), &set(&after.env));
    if !added.is_empty() || !removed.is_empty() {
        changes.push(CapabilityChange { expands: !added.is_empty(), added, removed, ..change("env") });
    }
    if before.network.access != after.network.access {
        let name = |access: NetworkAccess| if access == NetworkAccess::Required { "required" } else { "none" };
        changes.push(CapabilityChange {
            from: Some(name(before.network.access).into()),
            to: Some(name(after.network.access).into()),
            expands: after.network.access == NetworkAccess::Required,
            ..change("network")
        });
    }
    if before.network.access == NetworkAccess::Required && after.network.access == NetworkAccess::Required {
        match (&before.network.hosts, &after.network.hosts) {
            (Some(old), Some(new)) => {
                let (added, removed) = diff(&set(old), &set(new));
                if !added.is_empty() || !removed.is_empty() {
                    changes.push(CapabilityChange { expands: !added.is_empty(), added, removed, ..change("hosts") });
                }
            }
            // From a list to "anywhere" gives more, it does not take any away.
            (Some(old), None) => changes.push(CapabilityChange { from: Some(old.join(", ")), to: Some("*".into()), expands: true, ..change("hosts") }),
            (None, Some(new)) => changes.push(CapabilityChange { from: Some("*".into()), to: Some(new.join(", ")), expands: false, ..change("hosts") }),
            (None, None) => {}
        }
    }
    if before.workspace != after.workspace {
        changes.push(CapabilityChange {
            from: Some(level(before.workspace).into()),
            to: Some(level(after.workspace).into()),
            expands: after.workspace > before.workspace,
            ..change("workspace")
        });
    }
    let (added, removed) = diff(&set(&before.workspace_files), &set(&after.workspace_files));
    if !added.is_empty() || !removed.is_empty() {
        changes.push(CapabilityChange { expands: !added.is_empty(), added, removed, ..change("workspaceFiles") });
    }
    changes
}

/// Scripts shipped inside the package's Skill directories. The Agent may run
/// them with Bash, where they get its full environment: the card lists them.
#[must_use]
pub(super) fn skill_scripts(files: &super::PackageFiles, capabilities: &PluginCapabilities) -> Vec<String> {
    let roots: Vec<String> = capabilities
        .skill_roots
        .iter()
        .map(|root| root.to_string_lossy().replace('\\', "/").trim_start_matches("./").trim_end_matches('/').to_string())
        .collect();
    files
        .keys()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .filter(|path| roots.iter().any(|root| path.starts_with(&format!("{root}/"))))
        .filter(|path| {
            let lower = path.to_ascii_lowercase();
            [".py", ".sh", ".ps1", ".js", ".mjs", ".ts", ".rb", ".pl", ".bat", ".cmd"].iter().any(|ext| lower.ends_with(ext))
        })
        .collect()
}

//! Configuration-only adapter for DeepSeek Harness bundles.
//!
//! `apply_patches` is adapted from DeepSeek Harness vendor/include/src/patch.ts
//! (fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159), MIT, Shigma / DeepSeek.
//! See third_party/deepseek-harness/NOTICE.md. Config overrides deliberately
//! replace whole fields, matching Cordis; they are not recursive JSON merges.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{Diagnostic, PackageFiles, PluginCapabilities, PluginMcp};

/// The only DSH plugin rows SomniQ translates; any other row needs the host.
pub(super) const SKILL_FILESYSTEM: &str = "@deepseek-ai/dsh-skill-filesystem";
pub(super) const MCP_CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
pub(super) const SKILL_CONFIG_KEYS: &[&str] = &["customSkillDirs", "includeDefaultRoots"];
pub(super) const MCP_CONFIG_KEYS: &[&str] = &[
    "transport",
    "serverName",
    "command",
    "args",
    "env",
    "toolCallTimeoutMs",
];
pub(super) const MCP_TRANSPORTS: &[&str] = &["stdio"];
pub(super) const MAX_MCP_SERVER_NAME: usize = 32;
pub(super) const MAX_TOOL_CALL_TIMEOUT_MS: u64 = 1_800_000;
/// Fields a patch row may carry; loader lifecycle and isolation options need
/// the DeepSeek host.
pub(super) const ROW_KEYS: &[&str] = &["id", "name", "config", "group", "disabled"];
pub(super) const NODE_PLATFORMS: &[&str] = &[
    "aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin",
    "netbsd",
];

pub(super) fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || value.contains(':')
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Expected a package-relative path: {value}"));
    }
    Ok(path
        .components()
        .filter(|part| *part != Component::CurDir)
        .collect())
}

fn yaml_json(bytes: &[u8]) -> Result<Value, String> {
    // serde_yaml discards unknown tags under YAML's standard `!!` namespace.
    // This static adapter accepts untagged YAML only; reject these spellings
    // conservatively before parsing, including in quoted scalars.
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    if text.contains("!!")
        || text.contains("!<")
        || text
            .lines()
            .any(|line| line.trim_start().starts_with("%TAG"))
    {
        return Err("YAML tags and tag directives require the DeepSeek host".into());
    }
    let yaml: serde_yaml::Value = serde_yaml::from_slice(bytes).map_err(|e| e.to_string())?;
    fn check(value: &serde_yaml::Value) -> Result<(), String> {
        match value {
            serde_yaml::Value::Tagged(_) => {
                Err("Executable/custom YAML tags require the DeepSeek host".into())
            }
            serde_yaml::Value::Sequence(values) => values.iter().try_for_each(check),
            serde_yaml::Value::Mapping(values) => values.iter().try_for_each(|(key, value)| {
                if !key.is_string() {
                    return Err("YAML keys must be strings".into());
                }
                check(value)
            }),
            _ => Ok(()),
        }
    }
    check(&yaml)?;
    serde_json::to_value(yaml).map_err(|e| e.to_string())
}

fn find_entry<'a>(rows: &'a mut [Value], id: &str) -> Option<&'a mut Value> {
    // Cordis's id map selects the last depth-first entry for duplicate ids.
    fn location(rows: &[Value], id: &str) -> Option<Vec<usize>> {
        for (index, row) in rows.iter().enumerate().rev() {
            if row["group"] == true {
                if let Some(children) = row.get("config").and_then(Value::as_array) {
                    if let Some(mut found) = location(children, id) {
                        found.insert(0, index);
                        return Some(found);
                    }
                }
            }
            if row["id"].as_str() == Some(id) {
                return Some(vec![index]);
            }
        }
        None
    }
    let location = location(rows, id)?;
    let mut entry = rows.get_mut(location[0])?;
    for index in &location[1..] {
        entry = entry.get_mut("config")?.get_mut(*index)?;
    }
    Some(entry)
}

fn apply_patches(rows: &mut Vec<Value>, patches: &[Value], diagnostics: &mut Vec<Diagnostic>) {
    for patch in patches {
        let Some(fields) = patch.as_object() else {
            diagnostics.push(Diagnostic::error("patch", "A patch must be an object"));
            continue;
        };
        let id = patch["id"].as_str();
        if let Some(insert) = fields.get("insert") {
            let Some(insert) = insert.as_array() else {
                diagnostics.push(Diagnostic::error("patch", "insert must be an array"));
                continue;
            };
            if let Some(id) = id {
                match find_entry(rows, id) {
                    Some(target) if target["group"] == true => {
                        if !target["config"].is_array() {
                            target["config"] = Value::Array(vec![]);
                        }
                        target["config"]
                            .as_array_mut()
                            .unwrap()
                            .extend(insert.clone());
                    }
                    _ => diagnostics.push(
                        Diagnostic::error(
                            "patch-target",
                            format!("Insert target {id} is absent or is not a group"),
                        )
                        .at(id),
                    ),
                }
            } else {
                rows.extend(insert.clone());
            }
            continue;
        }
        let Some(target) = id.and_then(|id| find_entry(rows, id)) else {
            let mut diagnostic = Diagnostic::error(
                "patch-target",
                format!("Patch target {} is absent", id.unwrap_or("<missing>")),
            );
            diagnostic.path = id.map(str::to_string);
            diagnostics.push(diagnostic);
            continue;
        };
        if patch["name"]
            .as_str()
            .is_some_and(|name| Some(name) != target["name"].as_str())
        {
            diagnostics.push(
                Diagnostic::error("patch-name", "Name-qualified patch does not match its target")
                    .at(id.unwrap_or_default()),
            );
            continue;
        }
        if fields.contains_key("group")
            || (target["group"] == true && fields.contains_key("config"))
        {
            diagnostics.push(
                Diagnostic::error("group-replacement", "Changing a group's structure through overrides requires the DeepSeek host; use group insert patches")
                    .at(id.unwrap_or_default()),
            );
            continue;
        }
        if let Some(target) = target.as_object_mut() {
            for (key, value) in fields {
                if !matches!(key.as_str(), "id" | "insert" | "name") {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
    }
}

pub(super) fn capabilities(
    files: &PackageFiles,
    manifest: &Value,
    root: &Path,
    diagnostics: &mut Vec<Diagnostic>,
) -> PluginCapabilities {
    let mut capabilities = PluginCapabilities::default();
    if manifest["dsh"].get("client").is_some() {
        diagnostics.push(
            Diagnostic::error(
                "client",
                "DSH client extensions require the DeepSeek frontend host",
            )
            .in_file("package.json")
            .at("/dsh/client"),
        );
    }
    if manifest["dsh"]
        .get("manifestVersion")
        .is_some_and(|v| v != 1)
    {
        diagnostics.push(
            Diagnostic::error("manifest-version", "Only DSH manifestVersion 1 is supported")
                .in_file("package.json")
                .at("/dsh/manifestVersion"),
        );
    }
    let bundle = &manifest["dsh"]["bundle"];
    if let Some(declared) = bundle.get("platforms") {
        let platforms = declared.as_array();
        if platforms.is_none_or(|platforms| {
            platforms.is_empty()
                || platforms
                    .iter()
                    .any(|v| v.as_str().is_none_or(|v| !NODE_PLATFORMS.contains(&v)))
        }) {
            diagnostics.push(
                Diagnostic::error(
                    "platform",
                    "dsh.bundle.platforms must be a nonempty list of Node platform names",
                )
                .in_file("package.json")
                .at("/dsh/bundle/platforms"),
            );
        }
        let current = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        if platforms.is_some_and(|platforms| !platforms.iter().any(|v| v.as_str() == Some(current)))
        {
            diagnostics.push(
                Diagnostic::error("platform", format!("Bundle does not support {current}"))
                    .in_file("package.json")
                    .at("/dsh/bundle/platforms"),
            );
        }
    }
    let patches = match &bundle["patch"] {
        Value::String(path) => vec![path.as_str()],
        Value::Array(paths) if paths.iter().all(Value::is_string) => {
            paths.iter().filter_map(Value::as_str).collect()
        }
        _ => {
            diagnostics.push(
                Diagnostic::error(
                    "manifest",
                    "package.json must declare dsh.bundle.patch as a path or an ordered array of paths",
                )
                .in_file("package.json")
                .at("/dsh/bundle/patch"),
            );
            return capabilities;
        }
    };
    let mut rows = vec![];
    for filename in patches {
        let parsed = relative_path(filename).and_then(|path| {
            files
                .get(&path)
                .ok_or_else(|| format!("Missing patch: {filename}"))
                .and_then(|file| yaml_json(&file.bytes))
        });
        let start = diagnostics.len();
        match parsed {
            Ok(Value::Array(patches)) => apply_patches(&mut rows, &patches, diagnostics),
            Ok(_) => diagnostics.push(Diagnostic::error(
                "patch",
                format!("{filename} must contain a YAML sequence"),
            )),
            Err(error) => diagnostics.push(Diagnostic::error("patch", error)),
        }
        // Everything the patch file itself caused points at that file; row
        // translation below runs on the merged rows, so it names the row.
        let file = filename.trim_start_matches("./").to_string();
        for diagnostic in &mut diagnostics[start..] {
            diagnostic.file = Some(file.clone());
        }
    }
    translate_rows(&rows, files, root, &mut capabilities, diagnostics);
    capabilities
}

fn translate_rows(
    rows: &[Value],
    files: &PackageFiles,
    root: &Path,
    result: &mut PluginCapabilities,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for row in rows {
        let label = row["id"]
            .as_str()
            .or(row["name"].as_str())
            .unwrap_or("<entry>");
        if !row.is_object()
            || row
                .get("disabled")
                .is_some_and(|v| !v.is_boolean() && !v.is_null())
            || row
                .get("group")
                .is_some_and(|v| !v.is_boolean() && !v.is_null())
        {
            diagnostics.push(
                Diagnostic::error("entry", format!("{label}: invalid entry or disabled value"))
                    .at(label),
            );
            continue;
        }
        if row["disabled"] == true {
            continue;
        }
        if row
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !ROW_KEYS.contains(&k.as_str()))
        {
            diagnostics.push(
                Diagnostic::error("host-options", format!("{label}: loader lifecycle, injection or isolation options require the DeepSeek host"))
                    .at(label),
            );
            continue;
        }
        if row["group"] == true {
            if let Some(children) = row["config"].as_array() {
                translate_rows(children, files, root, result, diagnostics);
            } else {
                diagnostics.push(
                    Diagnostic::error("group", format!("{label}: group config must be an array"))
                        .at(label),
                );
            }
            continue;
        }
        let config = row
            .get("config")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let translated = match row["name"].as_str() {
            Some(SKILL_FILESYSTEM) => translate_skills(&config, files, result),
            Some(MCP_CLIENT) => translate_mcp(&config, root, result),
            Some(name) => Err(format!("{name} requires the DeepSeek/Cordis host")),
            None => Err("Entry requires a plugin name".into()),
        };
        if let Err(error) = translated {
            diagnostics.push(Diagnostic::error("capability", format!("{label}: {error}")).at(label));
        }
    }
}

fn allowed_keys(config: &Value, allowed: &[&str]) -> Result<(), String> {
    let Some(object) = config.as_object() else {
        return Err("config must be an object".into());
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!(
            "Configuration field {key} requires the DeepSeek host"
        ));
    }
    Ok(())
}

fn translate_skills(
    config: &Value,
    files: &PackageFiles,
    result: &mut PluginCapabilities,
) -> Result<(), String> {
    allowed_keys(config, SKILL_CONFIG_KEYS)?;
    if config["includeDefaultRoots"] != false {
        return Err(
            "Set includeDefaultRoots: false; SomniQ supplies its own project and user skill roots"
                .into(),
        );
    }
    let roots = config["customSkillDirs"]
        .as_array()
        .ok_or("customSkillDirs must be an array of package-relative directories")?;
    for path in roots {
        let path = relative_path(path.as_str().ok_or("Skill roots must be strings")?)?;
        let mut names = vec![];
        for file in files
            .keys()
            .filter_map(|file| file.strip_prefix(&path).ok())
        {
            let parts = file.components().collect::<Vec<_>>();
            if parts.len() == 2 && parts[1].as_os_str() == "SKILL.md" {
                let name = parts[0]
                    .as_os_str()
                    .to_str()
                    .ok_or("Skill name must be UTF-8")?;
                if !super::valid_skill_name(name) {
                    return Err(format!("Invalid skill directory: {name}"));
                }
                let body = std::str::from_utf8(&files[&path.join(file)].bytes)
                    .map_err(|e| e.to_string())?;
                if let Some(frontmatter) = body
                    .strip_prefix("---")
                    .and_then(|v| v.split_once("---").map(|(head, _)| head))
                {
                    let metadata = yaml_json(frontmatter.as_bytes())?;
                    if metadata.get("disable-model-invocation").is_some()
                        || metadata.get("user-invocable").is_some()
                    {
                        return Err(format!("{name}: DSH invocation flags are not supported by the SomniQ skill runtime"));
                    }
                    if metadata["name"].as_str().is_some_and(|value| value != name) {
                        return Err(format!("{name}: frontmatter name must match its directory"));
                    }
                }
                names.push(name.to_string());
            }
        }
        if names.is_empty() {
            return Err(format!(
                "{} contains no <name>/SKILL.md bundles",
                path.display()
            ));
        }
        result.skill_roots.push(path);
        result.skills.extend(names);
    }
    Ok(())
}

fn translate_mcp(
    config: &Value,
    root: &Path,
    result: &mut PluginCapabilities,
) -> Result<(), String> {
    allowed_keys(config, MCP_CONFIG_KEYS)?;
    if !config["transport"]
        .as_str()
        .is_some_and(|transport| MCP_TRANSPORTS.contains(&transport))
    {
        return Err("Only stdio MCP is supported by the SomniQ runtime".into());
    }
    let name = config["serverName"]
        .as_str()
        .ok_or("MCP serverName is required")?;
    if name.is_empty()
        || name.len() > MAX_MCP_SERVER_NAME
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("MCP serverName must match [A-Za-z0-9_-]{1,32}".into());
    }
    let command = config["command"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or("MCP command is required")?;
    let resolve = |value: &str| -> Result<String, String> {
        if value.contains("${") {
            return Err("Runtime template expansion requires the DeepSeek host".into());
        }
        if value.starts_with("./") {
            return Ok(root
                .join(relative_path(value)?)
                .to_string_lossy()
                .into_owned());
        }
        Ok(value.to_string())
    };
    let args: Vec<String> = serde_json::from_value(
        config
            .get("args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|e| e.to_string())?;
    let env: std::collections::BTreeMap<String, String> = serde_json::from_value(
        config
            .get("env")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .map_err(|e| e.to_string())?;
    if env.values().any(|v| v.contains("${")) {
        return Err("Credential templates require the DeepSeek host".into());
    }
    let timeout = match config.get("toolCallTimeoutMs") {
        Some(value) => Some(
            value
                .as_u64()
                .filter(|v| *v > 0 && *v <= MAX_TOOL_CALL_TIMEOUT_MS)
                .ok_or("toolCallTimeoutMs must be 1..1800000")?
                .div_ceil(1000),
        ),
        None => None,
    };
    result.mcp_servers.push(PluginMcp {
        name: name.into(),
        command: resolve(command)?,
        args: args.iter().map(|v| resolve(v)).collect::<Result<_, _>>()?,
        env,
        request_timeout_secs: timeout,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cordis_layers_replace_config_and_append_into_groups() {
        let mut rows = vec![];
        let mut diagnostics = vec![];
        apply_patches(&mut rows, serde_json::json!([
            {"insert":[{"id":"g","group":true,"config":[{"id":"a","name":"alpha","config":{"old":1}}]}]},
            {"id":"g","insert":[{"id":"b","name":"beta"}]},
            {"id":"a","name":"alpha","config":{"new":2}},
            {"id":"b","name":"wrong","disabled":true}
        ]).as_array().unwrap(), &mut diagnostics);
        assert_eq!(rows[0]["config"][0]["config"], serde_json::json!({"new":2}));
        assert_eq!(rows[0]["config"][1]["name"], "beta");
        assert!(rows[0]["config"][1].get("disabled").is_none());
        assert_eq!(diagnostics[0].code, "patch-name");
    }

    #[test]
    fn executable_yaml_is_rejected_instead_of_evaluated() {
        assert!(yaml_json(b"- id: test\n  disabled: !!js process.exit()\n").is_err());
        for path in ["../secrets", "C:/secret", "/etc", "..\\secret", ""] {
            assert!(relative_path(path).is_err());
        }
    }
}

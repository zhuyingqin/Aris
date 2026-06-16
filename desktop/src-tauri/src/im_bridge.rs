use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::projects::{current_project_path, ProjectState};

const CONFIG_NAME: &str = "config.env";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBridgeView {
    config_path: String,
    skill_dir: Option<String>,
    daemon_path: Option<String>,
    configured: bool,
    running: bool,
    pid: Option<u32>,
    channels: Vec<String>,
    runtime: String,
    enabled: bool,
    default_workdir: String,
    aris_path: String,
    qq_app_id: String,
    has_qq_app_secret: bool,
    qq_app_secret_masked: Option<String>,
    qq_allowed_users: String,
    qq_image_enabled: bool,
    qq_max_image_size: u32,
    auto_approve: bool,
    status_message: String,
    recent_log: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImBridgePatch {
    enabled: Option<bool>,
    runtime: Option<String>,
    default_workdir: Option<String>,
    aris_path: Option<String>,
    qq_app_id: Option<String>,
    qq_app_secret: Option<String>,
    qq_allowed_users: Option<String>,
    qq_image_enabled: Option<bool>,
    qq_max_image_size: Option<u32>,
    auto_approve: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBridgeTestResult {
    ok: bool,
    token_ok: bool,
    gateway_ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBridgeActionResult {
    ok: bool,
    message: String,
    output: String,
    view: ImBridgeView,
}

fn cti_home() -> PathBuf {
    PathBuf::from(runtime::home_dir()).join(".claude-to-im")
}

fn config_path() -> PathBuf {
    cti_home().join(CONFIG_NAME)
}

fn status_path() -> PathBuf {
    cti_home().join("runtime").join("status.json")
}

fn log_path() -> PathBuf {
    cti_home().join("logs").join("bridge.log")
}

fn skill_dir_candidates() -> Vec<PathBuf> {
    let home = PathBuf::from(runtime::home_dir());
    vec![
        home.join(".codex").join("skills").join("claude-to-im"),
        home.join(".codex").join("skills").join("Claude-to-IM-skill"),
        home.join(".claude").join("skills").join("claude-to-im"),
        home.join(".claude").join("skills").join("Claude-to-IM-skill"),
    ]
}

fn find_skill_dir() -> Option<PathBuf> {
    skill_dir_candidates()
        .into_iter()
        .find(|path| path.join("SKILL.md").exists())
}

fn daemon_path_for(skill_dir: &Path) -> PathBuf {
    let script = if cfg!(windows) {
        "daemon.ps1"
    } else {
        "daemon.sh"
    };
    skill_dir.join("scripts").join(script)
}

fn find_daemon_path() -> Option<PathBuf> {
    find_skill_dir()
        .map(|dir| daemon_path_for(&dir))
        .filter(|path| path.exists())
}

fn aris_executable_name() -> &'static str {
    if cfg!(windows) {
        "aris.exe"
    } else {
        "aris"
    }
}

fn push_aris_candidates(root: &Path, out: &mut Vec<PathBuf>) {
    out.push(root.join("target").join("release").join(aris_executable_name()));
    out.push(root.join("target").join("debug").join(aris_executable_name()));
}

fn aris_path_candidates(workdir: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut roots = Vec::new();
    let mut push_ancestors = |path: PathBuf| {
        for ancestor in path.ancestors() {
            roots.push(ancestor.to_path_buf());
        }
    };

    if !workdir.trim().is_empty() {
        push_ancestors(PathBuf::from(workdir));
    }
    if let Ok(current) = std::env::current_dir() {
        push_ancestors(current);
    }

    let mut seen = Vec::<PathBuf>::new();
    for root in roots {
        if seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        push_aris_candidates(&root, &mut out);
    }
    out
}

fn find_default_aris_path(workdir: &str) -> Option<String> {
    aris_path_candidates(workdir)
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.display().to_string().replace('\\', "/"))
}

fn parse_env(content: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(index) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..index].trim();
        if key.is_empty() {
            continue;
        }
        let value = trimmed[index + 1..]
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        map.insert(key.to_string(), value);
    }
    map
}

fn read_env_map() -> BTreeMap<String, String> {
    std::fs::read_to_string(config_path())
        .map(|content| parse_env(&content))
        .unwrap_or_default()
}

fn split_csv(value: Option<&String>) -> Vec<String> {
    value
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn set_csv_channel(map: &mut BTreeMap<String, String>, channel: &str, enabled: bool) {
    let mut channels = split_csv(map.get("CTI_ENABLED_CHANNELS"));
    if enabled {
        if !channels.iter().any(|item| item == channel) {
            channels.push(channel.to_string());
        }
    } else {
        channels.retain(|item| item != channel);
    }
    map.insert("CTI_ENABLED_CHANNELS".to_string(), channels.join(","));
}

fn bool_value(map: &BTreeMap<String, String>, key: &str, default_value: bool) -> bool {
    map.get(key)
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(default_value)
}

fn u32_value(map: &BTreeMap<String, String>, key: &str, default_value: u32) -> u32 {
    map.get(key)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default_value)
}

fn mask_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.chars().count() <= 4 {
        "***".to_string()
    } else {
        let tail: String = trimmed
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("***{tail}")
    }
}

fn redact(text: &str, map: &BTreeMap<String, String>) -> String {
    let mut out = text.to_string();
    for (key, value) in map {
        if value.len() > 3 && (key.contains("SECRET") || key.contains("TOKEN") || key.contains("KEY")) {
            out = out.replace(value, &mask_secret(value));
        }
    }
    out
}

fn tail_log(map: &BTreeMap<String, String>, lines: usize) -> Option<String> {
    let content = std::fs::read_to_string(log_path()).ok()?;
    let mut selected = content
        .lines()
        .rev()
        .take(lines)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    selected.reverse();
    Some(redact(&selected.join("\n"), map))
}

fn write_env_map(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let ordered_keys = [
        "CTI_RUNTIME",
        "CTI_ENABLED_CHANNELS",
        "CTI_DEFAULT_WORKDIR",
        "CTI_DEFAULT_MODE",
        "CTI_ARIS_PATH",
        "CTI_QQ_APP_ID",
        "CTI_QQ_APP_SECRET",
        "CTI_QQ_ALLOWED_USERS",
        "CTI_QQ_IMAGE_ENABLED",
        "CTI_QQ_MAX_IMAGE_SIZE",
        "CTI_AUTO_APPROVE",
    ];

    let mut out = String::new();
    for key in ordered_keys {
        if let Some(value) = map.get(key) {
            out.push_str(key);
            out.push('=');
            out.push_str(value);
            out.push('\n');
        }
    }
    for (key, value) in map {
        if ordered_keys.contains(&key.as_str()) {
            continue;
        }
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }

    let tmp = path.with_extension("env.tmp");
    std::fs::write(&tmp, out).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|error| error.to_string())
}

fn apply_patch_to_map(
    map: &mut BTreeMap<String, String>,
    patch: ImBridgePatch,
    fallback_workdir: &str,
) {
    map.insert("CTI_RUNTIME".to_string(), "aris".to_string());
    map.entry("CTI_DEFAULT_MODE".to_string())
        .or_insert_with(|| "code".to_string());
    map.entry("CTI_DEFAULT_WORKDIR".to_string())
        .or_insert_with(|| fallback_workdir.to_string());
    if !map.contains_key("CTI_ARIS_PATH") {
        if let Some(path) = find_default_aris_path(fallback_workdir) {
            map.insert("CTI_ARIS_PATH".to_string(), path);
        }
    }

    if let Some(enabled) = patch.enabled {
        set_csv_channel(map, "qq", enabled);
    } else if !map.contains_key("CTI_ENABLED_CHANNELS") {
        set_csv_channel(map, "qq", true);
    }
    let _ = patch.runtime;
    if let Some(workdir) = patch.default_workdir.map(|value| value.trim().to_string()) {
        if !workdir.is_empty() {
            if !map.contains_key("CTI_ARIS_PATH") {
                if let Some(path) = find_default_aris_path(&workdir) {
                    map.insert("CTI_ARIS_PATH".to_string(), path);
                }
            }
            map.insert("CTI_DEFAULT_WORKDIR".to_string(), workdir);
        }
    }
    if let Some(aris_path) = patch.aris_path.map(|value| value.trim().replace('\\', "/")) {
        if aris_path.is_empty() {
            map.remove("CTI_ARIS_PATH");
        } else {
            map.insert("CTI_ARIS_PATH".to_string(), aris_path);
        }
    }
    if let Some(app_id) = patch.qq_app_id.map(|value| value.trim().to_string()) {
        map.insert("CTI_QQ_APP_ID".to_string(), app_id);
    }
    if let Some(secret) = patch.qq_app_secret.map(|value| value.trim().to_string()) {
        if !secret.is_empty() {
            map.insert("CTI_QQ_APP_SECRET".to_string(), secret);
        }
    }
    if let Some(users) = patch.qq_allowed_users.map(|value| value.trim().to_string()) {
        map.insert("CTI_QQ_ALLOWED_USERS".to_string(), users);
    }
    if let Some(enabled) = patch.qq_image_enabled {
        map.insert("CTI_QQ_IMAGE_ENABLED".to_string(), enabled.to_string());
    }
    if let Some(size) = patch.qq_max_image_size {
        map.insert("CTI_QQ_MAX_IMAGE_SIZE".to_string(), size.max(1).to_string());
    }
    if let Some(auto_approve) = patch.auto_approve {
        map.insert("CTI_AUTO_APPROVE".to_string(), auto_approve.to_string());
    }
}

fn current_workdir(projects: &ProjectState) -> String {
    current_project_path(projects)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_status() -> (bool, Option<u32>, Vec<String>) {
    let Ok(content) = std::fs::read_to_string(status_path()) else {
        return (false, None, Vec::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return (false, None, Vec::new());
    };
    let running = value
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok());
    let channels = value
        .get("channels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    (running, pid, channels)
}

fn build_view(projects: &ProjectState) -> ImBridgeView {
    let configured = config_path().exists();
    let map = read_env_map();
    let fallback_workdir = current_workdir(projects);
    let channels = split_csv(map.get("CTI_ENABLED_CHANNELS"));
    let enabled = channels.iter().any(|item| item == "qq");
    let (running, pid, status_channels) = read_status();
    let skill_dir = find_skill_dir();
    let daemon_path = skill_dir.as_deref().map(daemon_path_for);
    let has_secret = map
        .get("CTI_QQ_APP_SECRET")
        .is_some_and(|value| !value.trim().is_empty());
    let status_message = if running {
        "Aris QQ bridge is running".to_string()
    } else if !configured {
        "No bridge config yet".to_string()
    } else if !enabled {
        "QQ Bot is disabled".to_string()
    } else if daemon_path.as_ref().is_none_or(|path| !path.exists()) {
        "Aris QQ bridge daemon script was not found".to_string()
    } else {
        "Aris QQ bridge is stopped".to_string()
    };
    let aris_path = map
        .get("CTI_ARIS_PATH")
        .cloned()
        .or_else(|| find_default_aris_path(&fallback_workdir))
        .unwrap_or_default();

    ImBridgeView {
        config_path: config_path().display().to_string(),
        skill_dir: skill_dir.map(|path| path.display().to_string()),
        daemon_path: daemon_path.map(|path| path.display().to_string()),
        configured,
        running,
        pid,
        channels: if status_channels.is_empty() {
            channels.clone()
        } else {
            status_channels
        },
        runtime: map
            .get("CTI_RUNTIME")
            .cloned()
            .unwrap_or_else(|| "aris".to_string()),
        enabled,
        default_workdir: map
            .get("CTI_DEFAULT_WORKDIR")
            .cloned()
            .unwrap_or(fallback_workdir),
        aris_path,
        qq_app_id: map.get("CTI_QQ_APP_ID").cloned().unwrap_or_default(),
        has_qq_app_secret: has_secret,
        qq_app_secret_masked: map
            .get("CTI_QQ_APP_SECRET")
            .filter(|value| !value.trim().is_empty())
            .map(|value| mask_secret(value)),
        qq_allowed_users: map
            .get("CTI_QQ_ALLOWED_USERS")
            .cloned()
            .unwrap_or_default(),
        qq_image_enabled: bool_value(&map, "CTI_QQ_IMAGE_ENABLED", true),
        qq_max_image_size: u32_value(&map, "CTI_QQ_MAX_IMAGE_SIZE", 20),
        auto_approve: bool_value(&map, "CTI_AUTO_APPROVE", false),
        status_message,
        recent_log: tail_log(&map, 18),
    }
}

fn run_daemon(command_name: &str, log_lines: Option<u32>) -> Result<String, String> {
    let script = find_daemon_path()
        .ok_or_else(|| "Aris QQ bridge daemon script was not found".to_string())?;
    let output = if cfg!(windows) {
        let mut command = Command::new("powershell");
        command
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .arg(command_name);
        if let Some(lines) = log_lines {
            command.arg(lines.to_string());
        }
        command.output()
    } else {
        let mut command = Command::new("bash");
        command.arg(&script).arg(command_name);
        if let Some(lines) = log_lines {
            command.arg(lines.to_string());
        }
        command.output()
    }
    .map_err(|error| error.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    };
    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("daemon command `{command_name}` failed"))
    } else {
        Err(combined)
    }
}

pub(crate) fn stop_on_app_exit() {
    if find_daemon_path().is_none() {
        return;
    }

    if let Err(error) = run_daemon("stop", None) {
        eprintln!("failed to stop Aris QQ bridge on exit: {error}");
    }
}

#[tauri::command]
pub fn im_bridge_get(projects: State<ProjectState>) -> ImBridgeView {
    build_view(&projects)
}

#[tauri::command]
pub fn im_bridge_set(
    projects: State<ProjectState>,
    patch: ImBridgePatch,
) -> Result<ImBridgeView, String> {
    let fallback_workdir = current_workdir(&projects);
    let mut map = read_env_map();
    apply_patch_to_map(&mut map, patch, &fallback_workdir);
    write_env_map(&map)?;
    Ok(build_view(&projects))
}

#[tauri::command]
pub async fn im_bridge_test_qq(
    projects: State<'_, ProjectState>,
    patch: ImBridgePatch,
) -> Result<ImBridgeTestResult, String> {
    let fallback_workdir = current_workdir(&projects);
    let mut map = read_env_map();
    apply_patch_to_map(&mut map, patch, &fallback_workdir);

    let app_id = map
        .get("CTI_QQ_APP_ID")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    let secret = map
        .get("CTI_QQ_APP_SECRET")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if app_id.is_empty() || secret.is_empty() {
        return Ok(ImBridgeTestResult {
            ok: false,
            token_ok: false,
            gateway_ok: false,
            message: "QQ App ID and App Secret are required.".to_string(),
        });
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let token_response = client
        .post("https://bots.qq.com/app/getAppAccessToken")
        .json(&serde_json::json!({
            "appId": app_id,
            "clientSecret": secret,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = token_response.status();
    if !status.is_success() {
        return Ok(ImBridgeTestResult {
            ok: false,
            token_ok: false,
            gateway_ok: false,
            message: format!("QQ token request failed ({status})."),
        });
    }
    let token_json = token_response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let Some(access_token) = token_json.get("access_token").and_then(Value::as_str) else {
        return Ok(ImBridgeTestResult {
            ok: false,
            token_ok: false,
            gateway_ok: false,
            message: "QQ token response did not include access_token.".to_string(),
        });
    };
    let gateway_response = client
        .get("https://api.sgroup.qq.com/gateway")
        .header("Authorization", format!("QQBot {access_token}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let gateway_status = gateway_response.status();
    if !gateway_status.is_success() {
        return Ok(ImBridgeTestResult {
            ok: false,
            token_ok: true,
            gateway_ok: false,
            message: format!("QQ gateway request failed ({gateway_status})."),
        });
    }
    let gateway_json = gateway_response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let gateway_ok = gateway_json.get("url").and_then(Value::as_str).is_some();
    Ok(ImBridgeTestResult {
        ok: gateway_ok,
        token_ok: true,
        gateway_ok,
        message: if gateway_ok {
            "QQ credentials and gateway are reachable.".to_string()
        } else {
            "QQ gateway response did not include a URL.".to_string()
        },
    })
}

#[tauri::command]
pub fn im_bridge_start(projects: State<ProjectState>) -> Result<ImBridgeActionResult, String> {
    if !config_path().exists() {
        return Err("Save QQ Bot settings before starting the bridge.".to_string());
    }
    let fallback_workdir = current_workdir(&projects);
    let mut map = read_env_map();
    apply_patch_to_map(&mut map, ImBridgePatch::default(), &fallback_workdir);
    write_env_map(&map)?;
    let output = run_daemon("start", None)?;
    Ok(ImBridgeActionResult {
        ok: true,
        message: "Bridge start command completed.".to_string(),
        output,
        view: build_view(&projects),
    })
}

#[tauri::command]
pub fn im_bridge_stop(projects: State<ProjectState>) -> Result<ImBridgeActionResult, String> {
    let output = run_daemon("stop", None)?;
    Ok(ImBridgeActionResult {
        ok: true,
        message: "Bridge stop command completed.".to_string(),
        output,
        view: build_view(&projects),
    })
}

#[tauri::command]
pub fn im_bridge_logs(projects: State<ProjectState>) -> Result<ImBridgeActionResult, String> {
    let map = read_env_map();
    let output = redact(&run_daemon("logs", Some(80))?, &map);
    Ok(ImBridgeActionResult {
        ok: true,
        message: "Bridge logs loaded.".to_string(),
        output,
        view: build_view(&projects),
    })
}

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state;

const STORE_VERSION: u32 = 1;
const CHATGPT_URL: &str = "https://chatgpt.com/";
const ORACLE_NPM_VERSION: &str = "0.18.0";
const NODE_RELEASE_BASE_URL: &str = "https://nodejs.org/dist/latest-v24.x";
const MAX_NODE_ARCHIVE_BYTES: u64 = 120 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GENERATED_IMAGES_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const CHAT_CONTINUATION_VERSION: u32 = 1;
const MAX_BROWSER_FOLLOW_UPS: usize = 6;
const MAX_BROWSER_FOLLOW_UP_CHARS: usize = 20_000;

static ACCOUNT_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static ORACLE_JOB_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static RUNTIME_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleBrowserView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleRuntimeView {
    pub status: String,
    pub source: String,
    pub version: Option<String>,
    pub command_path: Option<String>,
    pub node_path: Option<String>,
    pub install_supported: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebAccountView {
    pub id: String,
    pub display_name: String,
    pub browser_name: String,
    pub browser_kind: String,
    pub browser_path: String,
    pub profile_path: String,
    pub created_at: u64,
    pub last_login_launched_at: Option<u64>,
    pub login_confirmed_at: Option<u64>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebStatusView {
    pub runtime: OracleRuntimeView,
    pub browsers: Vec<OracleBrowserView>,
    pub accounts: Vec<OracleWebAccountView>,
    pub consult_account_id: Option<String>,
    pub reviewer_account_id: Option<String>,
    pub image_account_id: Option<String>,
    pub data_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebAccountCreateInput {
    pub display_name: String,
    pub browser_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebRoleSetInput {
    pub role: String,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebAccountModelSetInput {
    pub account_id: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebLoginLaunchView {
    pub account: OracleWebAccountView,
    pub pid: u32,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebConsultInput {
    pub account_id: String,
    pub prompt: String,
    #[serde(default)]
    pub files: Vec<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub follow_ups: Vec<String>,
    #[serde(default = "default_continue_conversation")]
    pub continue_conversation: bool,
    #[serde(skip)]
    pub chat_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebConsultView {
    pub account_id: String,
    pub session_id: Option<String>,
    pub status: String,
    pub output: String,
    pub continued: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebImageInput {
    pub account_id: String,
    pub prompt: String,
    #[serde(default)]
    pub files: Vec<String>,
    pub aspect_ratio: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebImageArtifactView {
    pub path: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleWebImageView {
    pub account_id: String,
    pub session_id: Option<String>,
    pub status: String,
    pub output: String,
    pub images: Vec<OracleWebImageArtifactView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountStore {
    version: u32,
    accounts: Vec<StoredAccount>,
    #[serde(default)]
    consult_account_id: Option<String>,
    #[serde(default)]
    reviewer_account_id: Option<String>,
    #[serde(default)]
    image_account_id: Option<String>,
}

impl Default for AccountStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            accounts: Vec::new(),
            consult_account_id: None,
            reviewer_account_id: None,
            image_account_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    id: String,
    display_name: String,
    browser_name: String,
    browser_kind: String,
    browser_path: String,
    created_at: u64,
    #[serde(default)]
    last_login_launched_at: Option<u64>,
    #[serde(default)]
    login_confirmed_at: Option<u64>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatContinuationStore {
    version: u32,
    sessions: BTreeMap<String, ChatContinuation>,
}

impl Default for ChatContinuationStore {
    fn default() -> Self {
        Self {
            version: CHAT_CONTINUATION_VERSION,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatContinuation {
    oracle_session_id: String,
    updated_at: u64,
}

#[derive(Debug, Clone)]
struct BrowserDefinition {
    name: &'static str,
    kind: &'static str,
    paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
enum OracleCommand {
    System(PathBuf),
    Managed { node: PathBuf, entrypoint: PathBuf },
}

#[tauri::command]
pub fn oracle_web_status() -> Result<OracleWebStatusView, String> {
    status_for_root(&oracle_root())
}

#[tauri::command]
pub async fn oracle_web_runtime_install() -> Result<OracleWebStatusView, String> {
    // Runtime replacement and webpage tasks share the same exclusive boundary.
    // This keeps a managed update from moving the active Node/Oracle files while
    // an MCP worker is still using them.
    let _job_guard = oracle_job_lock().lock().await;
    tokio::task::spawn_blocking(|| {
        let root = oracle_root();
        install_oracle_runtime(&root)?;
        status_for_root(&root)
    })
    .await
    .map_err(|error| format!("Oracle runtime installer task failed: {error}"))?
}

#[tauri::command]
pub fn oracle_web_account_create(
    input: OracleWebAccountCreateInput,
) -> Result<OracleWebStatusView, String> {
    let root = oracle_root();
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("Account name cannot be empty.".to_string());
    }
    if display_name.chars().count() > 80 {
        return Err("Account name cannot be longer than 80 characters.".to_string());
    }

    let browsers = discover_browsers();
    let requested = canonical_existing_file(Path::new(&input.browser_path))
        .ok_or_else(|| "The selected browser executable no longer exists.".to_string())?;
    let browser = browsers
        .iter()
        .find(|candidate| paths_equal(Path::new(&candidate.path), &requested))
        .ok_or_else(|| {
            "The selected executable is not one of the supported Chromium browsers detected by SomniQ."
                .to_string()
        })?;
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(&root)?;
    if store
        .accounts
        .iter()
        .any(|account| account.display_name.eq_ignore_ascii_case(display_name))
    {
        return Err("An Oracle Web account with that name already exists.".to_string());
    }

    let id = new_account_id();
    fs::create_dir_all(account_oracle_home_dir(&root, &id)?)
        .map_err(|error| format!("Could not create the Oracle account directory: {error}"))?;
    let profile_dir = account_profile_dir(&root, &id)?;
    fs::create_dir_all(&profile_dir).map_err(|error| {
        format!(
            "Could not create the isolated browser profile at {}: {error}",
            profile_dir.display()
        )
    })?;

    let account = StoredAccount {
        id,
        display_name: display_name.to_string(),
        browser_name: browser.name.clone(),
        browser_kind: browser.kind.clone(),
        browser_path: requested.to_string_lossy().into_owned(),
        created_at: unix_timestamp(),
        last_login_launched_at: None,
        login_confirmed_at: None,
        model: None,
    };
    write_account_browser_config(&root, &account, None)?;
    store.accounts.push(account);
    save_store(&root, &store)?;
    drop(_guard);
    status_for_root(&root)
}

#[tauri::command]
pub fn oracle_web_account_login(account_id: String) -> Result<OracleWebLoginLaunchView, String> {
    let root = oracle_root();
    validate_account_id(&account_id)?;
    let _job_guard = oracle_job_lock().try_lock().map_err(|_| {
        "Cannot open an Oracle Web login window while a webpage task is running. Stop or wait for the task, then try again."
            .to_string()
    })?;

    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(&root)?;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "Oracle Web account was not found.".to_string())?;

    let browser_path =
        canonical_existing_file(Path::new(&account.browser_path)).ok_or_else(|| {
            "The browser assigned to this account is no longer installed.".to_string()
        })?;
    let still_supported = discover_browsers()
        .iter()
        .any(|candidate| paths_equal(Path::new(&candidate.path), &browser_path));
    if !still_supported {
        return Err(
            "The account browser is no longer a supported detected executable.".to_string(),
        );
    }

    let profile_dir = account_profile_dir(&root, &account.id)?;
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Could not prepare the account browser profile: {error}"))?;
    if chromium_profile_lock_is_held(&profile_dir)? {
        return Err(
            "This account's browser user is already open. Finish sign-in there, then close it before starting an Oracle task."
                .to_string(),
        );
    }
    let mut command = login_browser_command(&browser_path, &profile_dir);
    let message = "A dedicated browser user is open without automation control. Sign in to the intended ChatGPT account once, then close this window. SomniQ preserves this browser user for later Chat calls and never stores your password."
        .to_string();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not open the account browser: {error}"))?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    account.last_login_launched_at = Some(unix_timestamp());
    let view = account_view(&root, account)?;
    save_store(&root, &store)?;

    Ok(OracleWebLoginLaunchView {
        account: view,
        pid,
        message,
    })
}

#[tauri::command]
pub fn oracle_web_account_model_set(
    input: OracleWebAccountModelSetInput,
) -> Result<OracleWebAccountView, String> {
    let root = oracle_root();
    validate_account_id(&input.account_id)?;
    let model = validate_optional_model(input.model)?;
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(&root)?;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id == input.account_id)
        .ok_or_else(|| "Oracle Web account was not found.".to_string())?;
    account.model = model;
    write_account_browser_config(&root, account, None)?;
    let view = account_view(&root, account)?;
    save_store(&root, &store)?;
    Ok(view)
}

fn login_browser_command(browser_path: &Path, profile_dir: &Path) -> Command {
    let mut command = Command::new(browser_path);
    command
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--new-window")
        .arg(CHATGPT_URL);
    command
}

#[tauri::command]
pub fn oracle_web_role_set(input: OracleWebRoleSetInput) -> Result<OracleWebStatusView, String> {
    let root = oracle_root();
    let role = input.role.trim().to_ascii_lowercase();
    if !matches!(role.as_str(), "consult" | "reviewer" | "image") {
        return Err("Oracle Web role must be `consult`, `reviewer`, or `image`.".to_string());
    }
    if let Some(account_id) = input.account_id.as_deref() {
        validate_account_id(account_id)?;
    }
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(&root)?;
    if let Some(account_id) = input.account_id.as_deref() {
        if !store
            .accounts
            .iter()
            .any(|account| account.id == account_id)
        {
            return Err("Oracle Web account was not found.".to_string());
        }
    }
    match role.as_str() {
        "consult" => store.consult_account_id = input.account_id,
        "reviewer" => store.reviewer_account_id = input.account_id,
        "image" => store.image_account_id = input.account_id,
        _ => unreachable!("role was validated above"),
    }
    save_store(&root, &store)?;
    drop(_guard);
    status_for_root(&root)
}

#[tauri::command]
pub fn oracle_web_account_remove(account_id: String) -> Result<OracleWebStatusView, String> {
    let root = oracle_root();
    remove_account_at(&root, &account_id)
}

fn remove_account_at(root: &Path, account_id: &str) -> Result<OracleWebStatusView, String> {
    validate_account_id(account_id)?;
    let _job_guard = oracle_job_lock().try_lock().map_err(|_| {
        "Cannot remove an Oracle Web account while a webpage task is running. Stop or wait for the task, then try again."
            .to_string()
    })?;
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(root)?;
    let index = store
        .accounts
        .iter()
        .position(|account| account.id == account_id)
        .ok_or_else(|| "Oracle Web account was not found.".to_string())?;

    // Preserve the account directory instead of permanently deleting an
    // isolated profile or the managed attach policy. This keeps account
    // removal recoverable while still removing every active role binding.
    let account_dir = account_root_dir(root, account_id)?;
    let archive_dir = root
        .join("archive")
        .join(format!("{}-{}", account_id, new_account_id()));
    let moved = if account_dir.exists() {
        let archive_parent = archive_dir
            .parent()
            .ok_or_else(|| "Could not resolve the Oracle Web archive directory.".to_string())?;
        fs::create_dir_all(archive_parent)
            .map_err(|error| format!("Could not create the Oracle Web archive: {error}"))?;
        fs::rename(&account_dir, &archive_dir).map_err(|error| {
            format!(
                "Could not archive the Oracle Web account directory at {}: {error}",
                archive_dir.display()
            )
        })?;
        true
    } else {
        false
    };

    store.accounts.remove(index);
    if store.consult_account_id.as_deref() == Some(account_id) {
        store.consult_account_id = None;
    }
    if store.reviewer_account_id.as_deref() == Some(account_id) {
        store.reviewer_account_id = None;
    }
    if store.image_account_id.as_deref() == Some(account_id) {
        store.image_account_id = None;
    }
    if let Err(error) = save_store(root, &store) {
        if moved {
            let _ = fs::rename(&archive_dir, &account_dir);
        }
        return Err(error);
    }
    drop(_guard);
    status_for_root(root)
}

#[tauri::command]
pub async fn oracle_web_consult(
    input: OracleWebConsultInput,
) -> Result<OracleWebConsultView, String> {
    run_consult(input, None).await
}

async fn run_consult(
    input: OracleWebConsultInput,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<OracleWebConsultView, String> {
    let root = oracle_root();
    let prompt = validate_prompt(&input.prompt)?;
    let _job = acquire_oracle_job(cancelled.clone()).await?;
    let account = stored_account(&root, &input.account_id)?;
    ensure_account_browser_ready(&root, &account)?;
    let files = resolve_workspace_files(&input.files)?;
    let has_files = !files.is_empty();
    let follow_ups = validate_browser_follow_ups(input.follow_ups)?;
    let model =
        validate_optional_model(input.model)?.or(validate_optional_model(account.model.clone())?);
    let continuation = match input.chat_session_id.as_deref() {
        Some(chat_session_id) if input.continue_conversation => {
            resolve_chat_continuation(&root, &account, chat_session_id)?
        }
        _ => None,
    };

    let mut arguments = serde_json::json!({
        "prompt": prompt,
        "files": files,
        "engine": "browser",
        "browserModelStrategy": browser_model_strategy(model.as_deref()),
        "browserAttachments": if has_files { "always" } else { "auto" },
        "browserKeepBrowser": false,
        "browserArchive": "auto"
    });
    if let Some(model) = model {
        arguments["model"] = serde_json::Value::String(model);
    }
    if !follow_ups.is_empty() {
        arguments["browserFollowUps"] = serde_json::to_value(follow_ups)
            .map_err(|error| format!("Could not encode Oracle browser follow-ups: {error}"))?;
    }
    let result = call_oracle_mcp_tool(
        &root,
        &account,
        "consult",
        arguments,
        continuation.as_deref(),
        cancelled,
    )
    .await?;
    mark_account_login_verified(&root, &account.id)?;
    let structured = result
        .structured_content
        .clone()
        .ok_or_else(|| "Oracle consult returned no structured result.".to_string())?;
    let session_id = json_string(&structured, "sessionId");
    if let (Some(chat_session_id), Some(oracle_session_id)) =
        (input.chat_session_id.as_deref(), session_id.as_deref())
    {
        save_chat_continuation(&root, &account, chat_session_id, oracle_session_id)?;
    }
    Ok(OracleWebConsultView {
        account_id: account.id,
        session_id,
        status: json_string(&structured, "status").unwrap_or_else(|| "unknown".to_string()),
        output: json_string(&structured, "output")
            .filter(|output| !output.trim().is_empty())
            .unwrap_or_else(|| mcp_text_content(&result.content)),
        continued: continuation.is_some(),
    })
}

#[tauri::command]
pub async fn oracle_web_generate_image(
    input: OracleWebImageInput,
) -> Result<OracleWebImageView, String> {
    run_generate_image(input, None).await
}

async fn run_generate_image(
    input: OracleWebImageInput,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<OracleWebImageView, String> {
    let root = oracle_root();
    let prompt = validate_prompt(&input.prompt)?;
    let _job = acquire_oracle_job(cancelled.clone()).await?;
    let account = stored_account(&root, &input.account_id)?;
    ensure_account_browser_ready(&root, &account)?;
    let files = resolve_workspace_files(&input.files)?;
    let has_files = !files.is_empty();
    let model =
        validate_optional_model(input.model)?.or(validate_optional_model(account.model.clone())?);
    let aspect_ratio = validate_aspect_ratio(input.aspect_ratio)?;

    let mut arguments = serde_json::json!({
        "prompt": prompt,
        "files": files,
        "browserModelStrategy": browser_model_strategy(model.as_deref()),
        "browserAttachments": if has_files { "always" } else { "auto" },
        "browserKeepBrowser": false,
        "browserArchive": "auto"
    });
    if let Some(model) = model {
        arguments["model"] = serde_json::Value::String(model);
    }
    if let Some(aspect_ratio) = aspect_ratio {
        arguments["aspectRatio"] = serde_json::Value::String(aspect_ratio);
    }
    let result =
        call_oracle_mcp_tool(&root, &account, "chatgpt_image", arguments, None, cancelled).await?;
    mark_account_login_verified(&root, &account.id)?;
    let structured = result
        .structured_content
        .clone()
        .ok_or_else(|| "Oracle image generation returned no structured result.".to_string())?;
    let images = import_generated_images(&root, &account, &structured)?;
    if images.is_empty() {
        return Err("Oracle completed without returning a generated image.".to_string());
    }
    Ok(OracleWebImageView {
        account_id: account.id,
        session_id: json_string(&structured, "sessionId"),
        status: json_string(&structured, "status").unwrap_or_else(|| "unknown".to_string()),
        output: json_string(&structured, "output")
            .filter(|output| !output.trim().is_empty())
            .unwrap_or_else(|| mcp_text_content(&result.content)),
        images,
    })
}

fn oracle_job_lock() -> &'static tokio::sync::Mutex<()> {
    ORACLE_JOB_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn acquire_oracle_job(
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    if cancelled.is_none() {
        return Ok(oracle_job_lock().lock().await);
    }
    tokio::select! {
        guard = oracle_job_lock().lock() => Ok(guard),
        () = wait_for_cancel(cancelled) => Err("Oracle Web task was interrupted by the user.".to_string()),
    }
}

fn validate_prompt(prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Oracle Web prompt cannot be empty.".to_string());
    }
    if prompt.chars().count() > 120_000 {
        return Err("Oracle Web prompt is too large (maximum 120,000 characters).".to_string());
    }
    Ok(prompt.to_string())
}

fn default_continue_conversation() -> bool {
    true
}

fn validate_browser_follow_ups(follow_ups: Vec<String>) -> Result<Vec<String>, String> {
    if follow_ups.len() > MAX_BROWSER_FOLLOW_UPS {
        return Err(format!(
            "Oracle Web accepts at most {MAX_BROWSER_FOLLOW_UPS} browser follow-up prompts per task."
        ));
    }
    follow_ups
        .into_iter()
        .map(|follow_up| {
            let follow_up = follow_up.trim();
            if follow_up.is_empty() {
                return Err("Oracle Web browser follow-up prompts cannot be empty.".to_string());
            }
            if follow_up.chars().count() > MAX_BROWSER_FOLLOW_UP_CHARS {
                return Err(format!(
                    "Oracle Web browser follow-up prompts are limited to {MAX_BROWSER_FOLLOW_UP_CHARS} characters."
                ));
            }
            Ok(follow_up.to_string())
        })
        .collect()
}

fn validate_optional_model(model: Option<String>) -> Result<Option<String>, String> {
    let Some(model) = model else {
        return Ok(None);
    };
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.chars().count() > 100
        || !model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_. ".contains(character))
    {
        return Err("Oracle Web model label contains unsupported characters.".to_string());
    }
    Ok(Some(model.to_string()))
}

fn browser_model_strategy(model: Option<&str>) -> &'static str {
    // Oracle defaults to a concrete GPT model even when SomniQ did not request
    // one. In that case, avoid depending on ChatGPT's frequently changing model
    // picker and keep the account's current model. An explicit user model still
    // requires selection so SomniQ never silently ignores that choice.
    if model.is_some() {
        "select"
    } else {
        "current"
    }
}

fn validate_aspect_ratio(aspect_ratio: Option<String>) -> Result<Option<String>, String> {
    let Some(aspect_ratio) = aspect_ratio else {
        return Ok(None);
    };
    let aspect_ratio = aspect_ratio.trim();
    if aspect_ratio.is_empty() {
        return Ok(None);
    }
    let Some((width, height)) = aspect_ratio.split_once(':') else {
        return Err("Image aspect ratio must look like 1:1, 9:16, or 16:9.".to_string());
    };
    let width = width.parse::<u16>().ok();
    let height = height.parse::<u16>().ok();
    if !matches!((width, height), (Some(1..=100), Some(1..=100))) {
        return Err("Image aspect ratio values must be between 1 and 100.".to_string());
    }
    Ok(Some(aspect_ratio.to_string()))
}

fn stored_account(root: &Path, account_id: &str) -> Result<StoredAccount, String> {
    validate_account_id(account_id)?;
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    load_store(root)?
        .accounts
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "Oracle Web account was not found.".to_string())
}

fn ensure_account_browser_ready(root: &Path, account: &StoredAccount) -> Result<(), String> {
    let browser = canonical_existing_file(Path::new(&account.browser_path)).ok_or_else(|| {
        "The browser assigned to this account is no longer installed.".to_string()
    })?;
    if !discover_browsers()
        .iter()
        .any(|candidate| paths_equal(Path::new(&candidate.path), &browser))
    {
        return Err(
            "The account browser is no longer a supported detected executable.".to_string(),
        );
    }
    let profile = account_profile_dir(root, &account.id)?;
    if !chromium_profile_is_initialized(&profile) {
        return Err(
            "This account's dedicated browser user has not been initialized. Open Settings > ChatGPT Web, sign in to ChatGPT in that browser window, then close it and retry. SomniQ verifies the sign-in automatically after the first successful webpage task."
                .to_string(),
        );
    }
    if chromium_profile_lock_is_held(&profile)? {
        return Err(
            "This account browser is still open. Close its isolated window before starting an Oracle task."
                .to_string(),
        );
    }
    let active_port_file = profile.join("DevToolsActivePort");
    if let Ok(contents) = fs::read_to_string(active_port_file) {
        if let Some(port) = contents
            .lines()
            .next()
            .and_then(|line| line.parse::<u16>().ok())
        {
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(250))
                .is_ok()
            {
                return Err(
                    "This account browser is still open. Close its isolated window before starting an Oracle task."
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

/// A successful Oracle webpage task is the only reliable sign-in signal that
/// does not require reading Chromium cookies, password stores, or account
/// identity. Keep the first verified time as audit metadata; do not update it
/// on every task.
fn mark_account_login_verified(root: &Path, account_id: &str) -> Result<(), String> {
    validate_account_id(account_id)?;
    let _guard = account_store_lock()
        .lock()
        .map_err(|_| "Oracle Web account store lock is poisoned.".to_string())?;
    let mut store = load_store(root)?;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "Oracle Web account was not found.".to_string())?;
    if account.login_confirmed_at.is_none() {
        account.login_confirmed_at = Some(unix_timestamp());
        save_store(root, &store)?;
    }
    Ok(())
}

fn chromium_profile_is_initialized(profile: &Path) -> bool {
    profile.join("Local State").is_file()
        || profile.join("Default").is_dir()
        || fs::read_dir(profile)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("Profile "))
                    && entry.path().is_dir()
            })
}

#[cfg(target_os = "windows")]
fn chromium_profile_lock_is_held(profile: &Path) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
        GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, OPEN_EXISTING,
    };

    // Chromium's Windows ProcessSingleton keeps `<user-data-dir>/lockfile`
    // open for writing with FILE_SHARE_READ and FILE_FLAG_DELETE_ON_CLOSE.
    // Opening that same file for writing with only FILE_SHARE_READ is a
    // read-only occupancy probe: it succeeds for a stale lockfile and fails
    // with ERROR_SHARING_VIOLATION while a browser owns the profile.
    let lock_path = profile.join("lockfile");
    let lock_path_wide = lock_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            lock_path_wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE {
        unsafe {
            CloseHandle(handle);
        }
        return Ok(false);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_SHARING_VIOLATION) => Ok(true),
        Some(ERROR_FILE_NOT_FOUND) | Some(ERROR_PATH_NOT_FOUND) => Ok(false),
        _ => Err(format!(
            "Could not inspect the Oracle account browser profile lock {}: {error}",
            lock_path.display()
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn chromium_profile_lock_is_held(_profile: &Path) -> Result<bool, String> {
    Ok(false)
}

fn resolve_workspace_files(files: &[String]) -> Result<Vec<String>, String> {
    if files.len() > 20 {
        return Err("Oracle Web accepts at most 20 project files per task.".to_string());
    }
    let workspace = state::workspace_dir();
    let workspace = workspace.canonicalize().map_err(|error| {
        format!(
            "Could not resolve the active project workspace {}: {error}",
            workspace.display()
        )
    })?;
    files
        .iter()
        .map(|raw| {
            let requested = PathBuf::from(raw);
            let candidate = if requested.is_absolute() {
                requested
            } else {
                workspace.join(requested)
            };
            let canonical = candidate.canonicalize().map_err(|error| {
                format!(
                    "Could not resolve project file {}: {error}",
                    candidate.display()
                )
            })?;
            if !canonical.starts_with(&workspace) || !canonical.is_file() {
                return Err(format!(
                    "Oracle Web can attach only files inside the active project: {}",
                    candidate.display()
                ));
            }
            Ok(canonical.to_string_lossy().into_owned())
        })
        .collect()
}

async fn call_oracle_mcp_tool(
    root: &Path,
    account: &StoredAccount,
    raw_tool_name: &str,
    arguments: serde_json::Value,
    resume_conversation_url: Option<&str>,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<runtime::McpToolCallResult, String> {
    let runtime = discover_oracle_runtime(root);
    let runtime_description = runtime
        .version
        .as_deref()
        .map(|version| format!("{version} ({})", runtime.source))
        .unwrap_or_else(|| runtime.source.clone());
    let servers = oracle_mcp_servers(root, account, resume_conversation_url)?;
    let mut manager = runtime::McpServerManager::from_servers(&servers);
    enum DiscoveryOutcome<T> {
        Finished(T),
        Cancelled,
    }
    let discovery = tokio::select! {
        result = manager.discover_tools() => DiscoveryOutcome::Finished(result),
        () = wait_for_cancel(cancelled.clone()), if cancelled.is_some() => DiscoveryOutcome::Cancelled,
    };
    let tools = match discovery {
        DiscoveryOutcome::Finished(result) => {
            result.map_err(|error| {
                format!(
                    "Could not start Oracle MCP {runtime_description}: {error}. Reopen Settings > ChatGPT Web and verify that the isolated managed runtime is ready."
                )
            })?
        }
        DiscoveryOutcome::Cancelled => {
            let _ = manager.shutdown().await;
            return Err("Oracle Web task was interrupted by the user.".to_string());
        }
    };
    let qualified_name = tools
        .iter()
        .find(|tool| tool.raw_name == raw_tool_name)
        .map(|tool| tool.qualified_name.clone())
        .ok_or_else(|| format!("Installed Oracle does not provide the `{raw_tool_name}` tool."))?;
    enum CallOutcome<T> {
        Finished(T),
        Cancelled,
    }
    let response = tokio::select! {
        response = manager.call_tool(&qualified_name, Some(arguments)) => {
            CallOutcome::Finished(response.map_err(|error| format!("Oracle MCP `{raw_tool_name}` failed: {error}")))
        }
        () = wait_for_cancel(cancelled.clone()), if cancelled.is_some() => CallOutcome::Cancelled,
    };
    if matches!(response, CallOutcome::Cancelled) {
        let _ = manager.shutdown().await;
        return Err("Oracle Web task was interrupted by the user.".to_string());
    }
    let _ = manager.shutdown().await;
    let CallOutcome::Finished(response) = response else {
        unreachable!("cancelled Oracle calls return before response handling")
    };
    let response = response?;
    if let Some(error) = response.error {
        return Err(format!(
            "Oracle MCP error {}: {}",
            error.code, error.message
        ));
    }
    let result = response
        .result
        .ok_or_else(|| "Oracle MCP returned no result.".to_string())?;
    if result.is_error == Some(true) {
        let detail = mcp_text_content(&result.content);
        return Err(if detail.trim().is_empty() {
            format!("Oracle MCP `{raw_tool_name}` reported an error.")
        } else {
            detail
        });
    }
    Ok(result)
}

async fn wait_for_cancel(cancelled: Option<Arc<AtomicBool>>) {
    let Some(cancelled) = cancelled else {
        std::future::pending::<()>().await;
        return;
    };
    while !cancelled.load(Ordering::SeqCst) && !runtime::is_interrupted() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

fn oracle_mcp_servers(
    root: &Path,
    account: &StoredAccount,
    resume_conversation_url: Option<&str>,
) -> Result<BTreeMap<String, runtime::ScopedMcpServerConfig>, String> {
    let runtime = discover_oracle_runtime(root);
    if runtime.status != "ready" {
        return Err(runtime.message);
    }
    let launch = oracle_mcp_launch(root).ok_or_else(|| {
        format!(
            "No compatible Oracle MCP runtime is available. SomniQ requires Oracle {ORACLE_NPM_VERSION}."
        )
    })?;
    let profile_dir = account_profile_dir(root, &account.id)?;
    if chromium_profile_lock_is_held(&profile_dir)? {
        return Err(
            "The selected browser user is still open. Close its sign-in window before starting the Oracle task."
                .to_string(),
        );
    }
    write_account_browser_config(root, account, resume_conversation_url)?;
    let (command, args) = mcp_command_parts(launch);
    let mut env = BTreeMap::new();
    env.insert("ORACLE_ENGINE".to_string(), "browser".to_string());
    let oracle_home = account_oracle_home_dir(root, &account.id)?;
    env.insert(
        "ORACLE_HOME_DIR".to_string(),
        oracle_home.to_string_lossy().into_owned(),
    );
    // The Oracle worker must not discover a project-controlled `.oracle/config.json`.
    // Files are passed to the MCP tool as canonical absolute paths, so the
    // account-local working directory does not reduce attachment functionality.
    env.insert(
        "SOMNIQ_MCP_WORKING_DIRECTORY".to_string(),
        oracle_home.to_string_lossy().into_owned(),
    );
    env.insert(
        "ORACLE_BROWSER_PROFILE_DIR".to_string(),
        profile_dir.to_string_lossy().into_owned(),
    );
    env.insert("CHROME_PATH".to_string(), account.browser_path.clone());
    for key in [
        "ORACLE_BROWSER_COOKIES_JSON",
        "ORACLE_BROWSER_COOKIES_FILE",
        "ORACLE_REMOTE_HOST",
        "ORACLE_REMOTE_TOKEN",
    ] {
        env.insert(key.to_string(), String::new());
    }
    env.insert(
        "ORACLE_BROWSER_MAX_CONCURRENT_TABS".to_string(),
        "1".to_string(),
    );
    env.insert("NO_COLOR".to_string(), "1".to_string());
    let config = runtime::McpStdioServerConfig {
        command,
        args,
        env,
        request_timeout_secs: Some(1_800),
    };
    Ok(BTreeMap::from([(
        "oracle_web".to_string(),
        runtime::ScopedMcpServerConfig {
            scope: runtime::ConfigSource::User,
            config: runtime::McpServerConfig::Stdio(config),
        },
    )]))
}

fn mcp_command_parts(command: OracleCommand) -> (String, Vec<String>) {
    match command {
        OracleCommand::Managed { node, entrypoint } => (
            external_command_path(&node),
            vec![external_command_path(&entrypoint)],
        ),
        OracleCommand::System(path) => {
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default();
            if cfg!(target_os = "windows")
                && (extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat"))
            {
                (
                    "cmd.exe".to_string(),
                    vec![
                        "/D".to_string(),
                        "/S".to_string(),
                        "/C".to_string(),
                        external_command_path(&path),
                    ],
                )
            } else {
                (external_command_path(&path), Vec::new())
            }
        }
    }
}

fn external_command_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(target_os = "windows") {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_string();
        }
    }
    value.into_owned()
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn mcp_text_content(content: &[runtime::McpToolCallContent]) -> String {
    content
        .iter()
        .filter(|item| item.kind == "text")
        .filter_map(|item| item.data.get("text").and_then(|text| text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn import_generated_images(
    root: &Path,
    account: &StoredAccount,
    structured: &serde_json::Value,
) -> Result<Vec<OracleWebImageArtifactView>, String> {
    let Some(images) = structured
        .get("images")
        .and_then(|images| images.as_array())
    else {
        return Ok(Vec::new());
    };
    let generated_root = account_oracle_home_dir(root, &account.id)?.join("generated");
    let generated_root = generated_root.canonicalize().map_err(|error| {
        format!(
            "Could not resolve Oracle's generated image directory {}: {error}",
            generated_root.display()
        )
    })?;
    let workspace = state::workspace_dir();
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("Could not prepare the active workspace: {error}"))?;
    let artifact_dir = workspace
        .join(".somniq")
        .join("artifacts")
        .join("oracle-images")
        .join(new_account_id());
    fs::create_dir_all(&artifact_dir)
        .map_err(|error| format!("Could not create the image artifact directory: {error}"))?;

    let mut imported = Vec::new();
    let mut imported_bytes = 0_u64;
    for (index, image) in images.iter().take(10).enumerate() {
        let Some(raw_path) = image.get("path").and_then(|path| path.as_str()) else {
            continue;
        };
        let source = PathBuf::from(raw_path)
            .canonicalize()
            .map_err(|error| format!("Could not resolve Oracle image {raw_path}: {error}"))?;
        if !source.starts_with(&generated_root) || !source.is_file() {
            return Err(
                "Oracle returned an image outside its generated-output directory.".to_string(),
            );
        }
        let source_bytes = fs::metadata(&source)
            .map_err(|error| format!("Could not inspect Oracle image {raw_path}: {error}"))?
            .len();
        if source_bytes > MAX_GENERATED_IMAGE_BYTES
            || imported_bytes.saturating_add(source_bytes) > MAX_GENERATED_IMAGES_TOTAL_BYTES
        {
            return Err(format!(
                "Oracle image output exceeded SomniQ's local import limit ({} MB per image, {} MB total).",
                MAX_GENERATED_IMAGE_BYTES / 1024 / 1024,
                MAX_GENERATED_IMAGES_TOTAL_BYTES / 1024 / 1024
            ));
        }
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .filter(|extension| {
                matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif")
            })
            .unwrap_or_else(|| "png".to_string());
        let destination = artifact_dir.join(format!("image-{}.{}", index + 1, extension));
        fs::copy(&source, &destination).map_err(|error| {
            format!(
                "Could not import Oracle image into {}: {error}",
                destination.display()
            )
        })?;
        let size_bytes = fs::metadata(&destination)
            .map_err(|error| format!("Could not inspect imported image: {error}"))?
            .len();
        imported_bytes = imported_bytes.saturating_add(size_bytes);
        let mime_type = image
            .get("mimeType")
            .and_then(|mime| mime.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| match extension.as_str() {
                "jpg" | "jpeg" => "image/jpeg".to_string(),
                "webp" => "image/webp".to_string(),
                "gif" => "image/gif".to_string(),
                _ => "image/png".to_string(),
            });
        imported.push(OracleWebImageArtifactView {
            path: destination.to_string_lossy().into_owned(),
            mime_type,
            size_bytes,
            width: image.get("width").and_then(|width| width.as_u64()),
            height: image.get("height").and_then(|height| height.as_u64()),
        });
    }
    Ok(imported)
}

fn status_for_root(root: &Path) -> Result<OracleWebStatusView, String> {
    let browsers = discover_browsers();
    let store = load_store(root)?;
    let accounts = store
        .accounts
        .iter()
        .map(|account| account_view(root, account))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(OracleWebStatusView {
        runtime: discover_oracle_runtime(root),
        browsers,
        accounts,
        consult_account_id: store.consult_account_id,
        reviewer_account_id: store.reviewer_account_id,
        image_account_id: store.image_account_id,
        data_dir: root.to_string_lossy().into_owned(),
    })
}

pub(crate) fn configured_reviewer_identity() -> Option<(String, String)> {
    let root = oracle_root();
    let store = load_store(&root).ok()?;
    let account_id = store.reviewer_account_id?;
    let account = store
        .accounts
        .iter()
        .find(|account| account.id == account_id)?;
    Some(("oracle-web".to_string(), format!("account:{}", account.id)))
}

pub(crate) fn image_tool_available() -> bool {
    let root = oracle_root();
    let Ok(store) = load_store(&root) else {
        return false;
    };
    store.image_account_id.is_some() && discover_oracle_runtime(&root).status == "ready"
}

pub(crate) fn consult_tool_available() -> bool {
    let root = oracle_root();
    let Ok(store) = load_store(&root) else {
        return false;
    };
    store.consult_account_id.is_some() && discover_oracle_runtime(&root).status == "ready"
}

pub(crate) fn run_bound_reviewer(
    mut prompt: String,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let root = oracle_root();
    let store = load_store(&root)?;
    let account_id = store.reviewer_account_id.ok_or_else(|| {
        "No Oracle Web account is assigned to the independent Reviewer.".to_string()
    })?;
    prompt.push_str(
        "\n\nOracle transport requirement: keep the complete JSON response under 3,200 characters. Be concise, retain only material findings, and still return valid JSON with every required field.",
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not start the Oracle Web task runtime: {error}"))?;
    let result = runtime.block_on(run_consult(
        OracleWebConsultInput {
            account_id,
            prompt,
            files: Vec::new(),
            model: None,
            follow_ups: Vec::new(),
            continue_conversation: false,
            chat_session_id: None,
        },
        Some(cancelled),
    ))?;
    if result.output.trim().is_empty() {
        Err("Oracle Web Reviewer returned an empty response.".to_string())
    } else {
        Ok(result.output)
    }
}

pub(crate) fn execute_bound_image_tool(
    input: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BoundImageInput {
        prompt: String,
        #[serde(default)]
        files: Vec<String>,
        aspect_ratio: Option<String>,
        model: Option<String>,
    }

    let input: BoundImageInput = serde_json::from_str(input)
        .map_err(|error| format!("Invalid ChatGptWebImage input: {error}"))?;
    let root = oracle_root();
    let store = load_store(&root)?;
    let account_id = store.image_account_id.ok_or_else(|| {
        "No Oracle Web account is assigned to image generation. Configure one in Settings > ChatGPT Web."
            .to_string()
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not start the Oracle Web task runtime: {error}"))?;
    let result = runtime.block_on(run_generate_image(
        OracleWebImageInput {
            account_id,
            prompt: input.prompt,
            files: input.files,
            aspect_ratio: input.aspect_ratio,
            model: input.model,
        },
        Some(cancelled),
    ))?;
    serde_json::to_string_pretty(&result)
        .map_err(|error| format!("Could not encode Oracle Web image result: {error}"))
}

pub(crate) fn execute_bound_consult_tool(
    input: &str,
    chat_session_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BoundConsultInput {
        prompt: String,
        #[serde(default)]
        files: Vec<String>,
        model: Option<String>,
        #[serde(default)]
        follow_ups: Vec<String>,
        #[serde(default = "default_continue_conversation")]
        continue_conversation: bool,
    }

    let input: BoundConsultInput = serde_json::from_str(input)
        .map_err(|error| format!("Invalid ChatGptWebConsult input: {error}"))?;
    let root = oracle_root();
    let store = load_store(&root)?;
    let account_id = store.consult_account_id.ok_or_else(|| {
        "No Oracle Web account is assigned to Chat consultation. Configure one in Settings > ChatGPT Web."
            .to_string()
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not start the Oracle Web task runtime: {error}"))?;
    let result = runtime.block_on(run_consult(
        OracleWebConsultInput {
            account_id,
            prompt: input.prompt,
            files: input.files,
            model: input.model,
            follow_ups: input.follow_ups,
            continue_conversation: input.continue_conversation,
            chat_session_id: Some(chat_session_id.to_string()),
        },
        Some(cancelled),
    ))?;
    serde_json::to_string_pretty(&result)
        .map_err(|error| format!("Could not encode Oracle Web consult result: {error}"))
}

fn oracle_root() -> PathBuf {
    state::config_dir().join("oracle-web")
}

fn runtime_install_lock() -> &'static Mutex<()> {
    RUNTIME_INSTALL_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(target_os = "windows")]
fn install_oracle_runtime(root: &Path) -> Result<(), String> {
    let _guard = runtime_install_lock()
        .lock()
        .map_err(|_| "Oracle runtime installer lock is poisoned.".to_string())?;
    if managed_oracle_mcp_command(root)
        .as_ref()
        .is_some_and(oracle_command_is_compatible)
    {
        return Ok(());
    }

    let runtime_root = root.join("runtime");
    fs::create_dir_all(&runtime_root).map_err(|error| {
        format!(
            "Could not create Oracle runtime directory {}: {error}",
            runtime_root.display()
        )
    })?;
    let staging = runtime_root.join(format!("installing-{}", new_account_id()));
    fs::create_dir_all(&staging).map_err(|error| {
        format!(
            "Could not create Oracle staging directory {}: {error}",
            staging.display()
        )
    })?;
    let mut staging_guard = InstallStagingGuard::new(runtime_root.clone(), staging.clone());

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .user_agent(format!("SomniQ-Studio/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not initialize the Oracle runtime downloader: {error}"))?;
    let shasums_url = format!("{NODE_RELEASE_BASE_URL}/SHASUMS256.txt");
    let shasums = client
        .get(&shasums_url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download Node.js checksums: {error}"))?
        .text()
        .map_err(|error| format!("Could not read Node.js checksums: {error}"))?;
    let archive_suffix = match std::env::consts::ARCH {
        "aarch64" => "-win-arm64.zip",
        "x86" => "-win-x86.zip",
        _ => "-win-x64.zip",
    };
    let (expected_sha256, archive_name) = shasums
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.to_string(), fields.next()?.to_string()))
        })
        .find(|(_, name)| name.starts_with("node-v24.") && name.ends_with(archive_suffix))
        .ok_or_else(|| {
            format!(
                "The official Node.js checksum list did not contain a {archive_suffix} archive."
            )
        })?;
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The official Node.js checksum entry was malformed.".to_string());
    }

    let archive_path = staging.join(&archive_name);
    download_verified_file(
        &client,
        &format!("{NODE_RELEASE_BASE_URL}/{archive_name}"),
        &archive_path,
        &expected_sha256,
        MAX_NODE_ARCHIVE_BYTES,
    )?;
    let node_dir = staging.join("node");
    extract_node_zip(&archive_path, &node_dir)?;
    fs::remove_file(&archive_path)
        .map_err(|error| format!("Could not remove downloaded Node.js archive: {error}"))?;

    let npm = node_dir.join("npm.cmd");
    if !npm.is_file() {
        return Err("The verified Node.js archive did not contain npm.cmd.".to_string());
    }
    let npm_cache = staging.join(".npm-cache");
    let output = crate::process::hidden_command(&npm)
        .args([
            "install",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            &format!("@steipete/oracle@{ORACLE_NPM_VERSION}"),
        ])
        .arg("--prefix")
        .arg(&staging)
        .env("npm_config_cache", &npm_cache)
        .env("npm_config_update_notifier", "false")
        .current_dir(&staging)
        .output()
        .map_err(|error| format!("Could not run npm for the Oracle runtime: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Oracle npm installation failed ({}): {}",
            output.status,
            tail_text(&format!("{stdout}\n{stderr}"), 4_000)
        ));
    }

    let entrypoint = staging
        .join("node_modules")
        .join("@steipete")
        .join("oracle")
        .join("dist")
        .join("bin")
        .join("oracle-mcp.js");
    if !entrypoint.is_file() {
        return Err("The installed Oracle package does not contain oracle-mcp.js.".to_string());
    }
    if npm_cache.exists() {
        fs::remove_dir_all(&npm_cache)
            .map_err(|error| format!("Could not remove temporary npm cache: {error}"))?;
    }
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "oracleVersion": ORACLE_NPM_VERSION,
        "nodeArchive": archive_name,
        "nodeSha256": expected_sha256,
        "installedAt": unix_timestamp(),
        "source": {
            "node": NODE_RELEASE_BASE_URL,
            "oracle": "https://www.npmjs.com/package/@steipete/oracle"
        }
    });
    fs::write(
        staging.join("somniq-runtime.json"),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Could not encode Oracle runtime manifest: {error}"))?,
    )
    .map_err(|error| format!("Could not write Oracle runtime manifest: {error}"))?;

    let current = runtime_root.join("current");
    if current.exists() {
        let invalid = runtime_root.join(format!("invalid-{}", new_account_id()));
        fs::rename(&current, &invalid).map_err(|error| {
            format!(
                "Could not preserve the previous incomplete Oracle runtime at {}: {error}",
                invalid.display()
            )
        })?;
    }
    fs::rename(&staging, &current).map_err(|error| {
        format!(
            "Could not activate the Oracle runtime at {}: {error}",
            current.display()
        )
    })?;
    staging_guard.keep();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_oracle_runtime(_root: &Path) -> Result<(), String> {
    Err("Automatic Oracle runtime installation is currently available on Windows only. Install @steipete/oracle with Node.js 24 to use the system runtime on this platform."
        .to_string())
}

struct InstallStagingGuard {
    runtime_root: PathBuf,
    path: PathBuf,
    keep: bool,
}

impl InstallStagingGuard {
    fn new(runtime_root: PathBuf, path: PathBuf) -> Self {
        Self {
            runtime_root,
            path,
            keep: false,
        }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for InstallStagingGuard {
    fn drop(&mut self) {
        if self.keep
            || self.path.parent() != Some(self.runtime_root.as_path())
            || !self
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("installing-"))
        {
            return;
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(target_os = "windows")]
fn download_verified_file(
    client: &reqwest::blocking::Client,
    url: &str,
    destination: &Path,
    expected_sha256: &str,
    max_bytes: u64,
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download {url}: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!(
            "Download from {url} exceeded the {max_bytes}-byte safety limit."
        ));
    }
    let mut file = fs::File::create(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Could not read download from {url}: {error}"))?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max_bytes {
            return Err(format!(
                "Download from {url} exceeded the {max_bytes}-byte safety limit."
            ));
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
    }
    file.flush()
        .map_err(|error| format!("Could not flush {}: {error}", destination.display()))?;
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "Node.js archive checksum mismatch: expected {expected_sha256}, received {actual_sha256}."
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_node_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Could not create Node.js directory {}: {error}",
            destination.display()
        )
    })?;
    let file = fs::File::open(archive_path)
        .map_err(|error| format!("Could not open {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Could not read verified Node.js archive: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not read Node.js archive entry: {error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("Node.js archive contained an unsafe path.".to_string());
        };
        let mut components = enclosed.components();
        let _top_level = components.next();
        let relative = components.as_path();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Could not create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        let mut target = fs::File::create(&output)
            .map_err(|error| format!("Could not create {}: {error}", output.display()))?;
        std::io::copy(&mut entry, &mut target)
            .map_err(|error| format!("Could not extract {}: {error}", output.display()))?;
    }
    Ok(())
}

fn tail_text(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.trim().to_string();
    }
    text.chars()
        .skip(total - max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn account_store_lock() -> &'static Mutex<()> {
    ACCOUNT_STORE_LOCK.get_or_init(|| Mutex::new(()))
}

fn store_path(root: &Path) -> PathBuf {
    root.join("accounts.json")
}

fn store_backup_path(root: &Path) -> PathBuf {
    root.join("accounts.backup.json")
}

fn load_store(root: &Path) -> Result<AccountStore, String> {
    let primary = store_path(root);
    let path = if primary.exists() {
        primary
    } else {
        store_backup_path(root)
    };
    if !path.exists() {
        return Ok(AccountStore::default());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let store: AccountStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    if store.version != STORE_VERSION {
        return Err(format!(
            "Unsupported Oracle Web account store version {}.",
            store.version
        ));
    }
    for account in &store.accounts {
        validate_account_id(&account.id)?;
        validate_optional_model(account.model.clone())?;
    }
    for (role, account_id) in [
        ("consult", store.consult_account_id.as_deref()),
        ("reviewer", store.reviewer_account_id.as_deref()),
        ("image", store.image_account_id.as_deref()),
    ] {
        if let Some(account_id) = account_id {
            validate_account_id(account_id)?;
            if !store
                .accounts
                .iter()
                .any(|account| account.id == account_id)
            {
                return Err(format!(
                    "Oracle Web {role} role references an account that no longer exists."
                ));
            }
        }
    }
    Ok(store)
}

fn save_store(root: &Path, store: &AccountStore) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;
    let destination = store_path(root);
    let temporary = root.join(format!(".accounts-{}.tmp", new_account_id()));
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("Could not serialize Oracle Web accounts: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    let backup = store_backup_path(root);
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                format!("Could not clear stale account-store backup: {error}")
            })?;
        }
        fs::rename(&destination, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "Could not preserve {} before update: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not move account store into place: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn account_view(root: &Path, account: &StoredAccount) -> Result<OracleWebAccountView, String> {
    Ok(OracleWebAccountView {
        id: account.id.clone(),
        display_name: account.display_name.clone(),
        browser_name: account.browser_name.clone(),
        browser_kind: account.browser_kind.clone(),
        browser_path: account.browser_path.clone(),
        profile_path: account_profile_dir(root, &account.id)?
            .to_string_lossy()
            .into_owned(),
        created_at: account.created_at,
        last_login_launched_at: account.last_login_launched_at,
        login_confirmed_at: account.login_confirmed_at,
        model: account.model.clone(),
    })
}

fn account_browser_config(
    account: &StoredAccount,
    resume_conversation_url: Option<&str>,
) -> serde_json::Value {
    let mut browser = serde_json::json!({
        "attachRunning": false,
        "manualLogin": true,
        "manualLoginCookieSync": false,
        "cookieSync": false,
        "maxConcurrentTabs": 1
    });
    if let Some(model) = account.model.as_deref() {
        browser["desiredModel"] = serde_json::Value::String(model.to_string());
        browser["modelStrategy"] = serde_json::Value::String("select".to_string());
    }
    if let Some(url) = resume_conversation_url {
        browser["resumeConversationUrl"] = serde_json::Value::String(url.to_string());
        browser["archiveConversations"] = serde_json::Value::String("never".to_string());
    }
    serde_json::json!({
        "engine": "browser",
        "browser": browser
    })
}

fn write_account_browser_config(
    root: &Path,
    account: &StoredAccount,
    resume_conversation_url: Option<&str>,
) -> Result<(), String> {
    let oracle_home = account_oracle_home_dir(root, &account.id)?;
    fs::create_dir_all(&oracle_home)
        .map_err(|error| format!("Could not create the Oracle account directory: {error}"))?;
    let destination = oracle_home.join("config.json");
    let bytes =
        serde_json::to_vec_pretty(&account_browser_config(account, resume_conversation_url))
            .map_err(|error| format!("Could not serialize the Oracle browser policy: {error}"))?;
    if fs::read(&destination).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    let temporary = oracle_home.join(format!(".config-{}.tmp", new_account_id()));
    let backup = oracle_home.join("config.backup.json");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write the Oracle browser policy: {error}"))?;
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                format!("Could not clear the stale Oracle browser-policy backup: {error}")
            })?;
        }
        fs::rename(&destination, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Could not preserve the Oracle browser policy before update: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not activate the Oracle browser policy: {error}"
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn account_profile_dir(root: &Path, account_id: &str) -> Result<PathBuf, String> {
    validate_account_id(account_id)?;
    Ok(account_root_dir(root, account_id)?.join("browser-profile"))
}

fn account_oracle_home_dir(root: &Path, account_id: &str) -> Result<PathBuf, String> {
    validate_account_id(account_id)?;
    Ok(account_root_dir(root, account_id)?.join("oracle-home"))
}

fn account_root_dir(root: &Path, account_id: &str) -> Result<PathBuf, String> {
    validate_account_id(account_id)?;
    Ok(root.join("accounts").join(account_id))
}

fn chat_continuation_store_path(root: &Path, account_id: &str) -> Result<PathBuf, String> {
    Ok(account_root_dir(root, account_id)?.join("chat-continuations.json"))
}

fn validate_chat_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 160
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
    if valid {
        Ok(())
    } else {
        Err(
            "The Chat session identifier is invalid for Oracle conversation continuity."
                .to_string(),
        )
    }
}

fn validate_oracle_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 120
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
    if valid {
        Ok(())
    } else {
        Err("The saved Oracle browser session identifier is invalid.".to_string())
    }
}

fn load_chat_continuations(
    root: &Path,
    account: &StoredAccount,
) -> Result<ChatContinuationStore, String> {
    let path = chat_continuation_store_path(root, &account.id)?;
    if !path.exists() {
        return Ok(ChatContinuationStore::default());
    }
    let store: ChatContinuationStore = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("Could not parse {}: {error}", path.display()))?;
    if store.version != CHAT_CONTINUATION_VERSION {
        return Err(
            "The saved Oracle conversation-continuity data has an unsupported version.".to_string(),
        );
    }
    for (chat_session_id, continuation) in &store.sessions {
        validate_chat_session_id(chat_session_id)?;
        validate_oracle_session_id(&continuation.oracle_session_id)?;
    }
    Ok(store)
}

fn save_chat_continuation(
    root: &Path,
    account: &StoredAccount,
    chat_session_id: &str,
    oracle_session_id: &str,
) -> Result<(), String> {
    validate_chat_session_id(chat_session_id)?;
    validate_oracle_session_id(oracle_session_id)?;
    let mut store = load_chat_continuations(root, account)?;
    store.sessions.insert(
        chat_session_id.to_string(),
        ChatContinuation {
            oracle_session_id: oracle_session_id.to_string(),
            updated_at: unix_timestamp(),
        },
    );
    while store.sessions.len() > 100 {
        let oldest = store
            .sessions
            .iter()
            .min_by_key(|(_, continuation)| continuation.updated_at)
            .map(|(session_id, _)| session_id.clone())
            .expect("non-empty continuation store");
        store.sessions.remove(&oldest);
    }
    let destination = chat_continuation_store_path(root, &account.id)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Oracle continuation store has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the Oracle account directory: {error}"))?;
    let temporary = parent.join(format!(".chat-continuations-{}.tmp", new_account_id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&store)
            .map_err(|error| format!("Could not encode Oracle conversation continuity: {error}"))?,
    )
    .map_err(|error| format!("Could not write Oracle conversation continuity: {error}"))?;
    // Windows does not allow `rename` to replace an existing file. Preserve the
    // prior mapping until the new file has taken its place so a failed update
    // cannot discard a user's conversation continuity.
    let backup = parent.join("chat-continuations.backup.json");
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                format!("Could not prepare Oracle conversation continuity backup: {error}")
            })?;
        }
        fs::rename(&destination, &backup).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Could not back up Oracle conversation continuity: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not save Oracle conversation continuity: {error}"
        ));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn resolve_chat_continuation(
    root: &Path,
    account: &StoredAccount,
    chat_session_id: &str,
) -> Result<Option<String>, String> {
    validate_chat_session_id(chat_session_id)?;
    let store = load_chat_continuations(root, account)?;
    let Some(continuation) = store.sessions.get(chat_session_id) else {
        return Ok(None);
    };
    oracle_session_conversation_url(root, account, &continuation.oracle_session_id).map(Some)
}

fn oracle_session_conversation_url(
    root: &Path,
    account: &StoredAccount,
    oracle_session_id: &str,
) -> Result<String, String> {
    validate_oracle_session_id(oracle_session_id)?;
    let path = account_oracle_home_dir(root, &account.id)?
        .join("sessions")
        .join(oracle_session_id)
        .join("meta.json");
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).map_err(|error| {
            format!(
                "The prior Oracle browser conversation is unavailable at {}: {error}",
                path.display()
            )
        })?)
        .map_err(|error| {
            format!("Could not parse the prior Oracle browser conversation: {error}")
        })?;
    let conversation_id = metadata
        .pointer("/browser/runtime/conversationId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            metadata
                .pointer("/browser/runtime/tabUrl")
                .and_then(serde_json::Value::as_str)
                .and_then(chatgpt_conversation_id_from_url)
        })
        .ok_or_else(|| {
            "The prior Oracle browser session has no reusable ChatGPT conversation.".to_string()
        })?;
    if !is_chatgpt_conversation_id(conversation_id) {
        return Err(
            "The prior Oracle browser session contains an invalid ChatGPT conversation identifier."
                .to_string(),
        );
    }
    Ok(format!("https://chatgpt.com/c/{conversation_id}"))
}

fn chatgpt_conversation_id_from_url(url: &str) -> Option<&str> {
    url.strip_prefix("https://chatgpt.com/c/")
        .filter(|id| !id.contains(['/', '?', '#']))
}

fn is_chatgpt_conversation_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            matches!(index, 8 | 13 | 18 | 23) && character == '-' || character.is_ascii_hexdigit()
        })
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    let valid = account_id.len() == 32
        && account_id
            .chars()
            .all(|character| character.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err("Invalid Oracle Web account identifier.".to_string())
    }
}

fn new_account_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn discover_browsers() -> Vec<OracleBrowserView> {
    discover_browser_definitions(browser_definitions())
}

fn discover_browser_definitions(definitions: Vec<BrowserDefinition>) -> Vec<OracleBrowserView> {
    let mut seen = HashSet::new();
    let mut browsers = Vec::new();
    for definition in definitions {
        for path in definition.paths {
            let Some(path) = canonical_existing_file(&path) else {
                continue;
            };
            let key = normalized_path_key(&path);
            if !seen.insert(key) {
                continue;
            }
            let id = format!("{}-{}", definition.kind, browsers.len() + 1);
            browsers.push(OracleBrowserView {
                id,
                name: definition.name.to_string(),
                kind: definition.kind.to_string(),
                path: path.to_string_lossy().into_owned(),
                recommended: browsers.is_empty(),
            });
        }
    }
    browsers
}

#[cfg(target_os = "windows")]
fn browser_definitions() -> Vec<BrowserDefinition> {
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    vec![
        BrowserDefinition {
            name: "Microsoft Edge",
            kind: "edge",
            paths: candidate_paths(
                &[
                    (&program_files_x86, "Microsoft/Edge/Application/msedge.exe"),
                    (&program_files, "Microsoft/Edge/Application/msedge.exe"),
                    (&local_app_data, "Microsoft/Edge/Application/msedge.exe"),
                ],
                &["msedge.exe"],
            ),
        },
        BrowserDefinition {
            name: "Google Chrome",
            kind: "chrome",
            paths: candidate_paths(
                &[
                    (&program_files, "Google/Chrome/Application/chrome.exe"),
                    (&program_files_x86, "Google/Chrome/Application/chrome.exe"),
                    (&local_app_data, "Google/Chrome/Application/chrome.exe"),
                ],
                &["chrome.exe"],
            ),
        },
        BrowserDefinition {
            name: "Brave",
            kind: "brave",
            paths: candidate_paths(
                &[
                    (
                        &program_files,
                        "BraveSoftware/Brave-Browser/Application/brave.exe",
                    ),
                    (
                        &program_files_x86,
                        "BraveSoftware/Brave-Browser/Application/brave.exe",
                    ),
                    (
                        &local_app_data,
                        "BraveSoftware/Brave-Browser/Application/brave.exe",
                    ),
                ],
                &["brave.exe"],
            ),
        },
        BrowserDefinition {
            name: "Chromium",
            kind: "chromium",
            paths: candidate_paths(
                &[
                    (&local_app_data, "Chromium/Application/chrome.exe"),
                    (&program_files, "Chromium/Application/chrome.exe"),
                ],
                &["chromium.exe"],
            ),
        },
        BrowserDefinition {
            name: "Vivaldi",
            kind: "vivaldi",
            paths: candidate_paths(
                &[
                    (&local_app_data, "Vivaldi/Application/vivaldi.exe"),
                    (&program_files, "Vivaldi/Application/vivaldi.exe"),
                ],
                &["vivaldi.exe"],
            ),
        },
    ]
}

#[cfg(target_os = "macos")]
fn browser_definitions() -> Vec<BrowserDefinition> {
    vec![
        BrowserDefinition {
            name: "Google Chrome",
            kind: "chrome",
            paths: vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )],
        },
        BrowserDefinition {
            name: "Microsoft Edge",
            kind: "edge",
            paths: vec![PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            )],
        },
        BrowserDefinition {
            name: "Brave",
            kind: "brave",
            paths: vec![PathBuf::from(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            )],
        },
        BrowserDefinition {
            name: "Chromium",
            kind: "chromium",
            paths: vec![PathBuf::from(
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            )],
        },
        BrowserDefinition {
            name: "Vivaldi",
            kind: "vivaldi",
            paths: vec![PathBuf::from(
                "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
            )],
        },
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_definitions() -> Vec<BrowserDefinition> {
    vec![
        BrowserDefinition {
            name: "Google Chrome",
            kind: "chrome",
            paths: path_candidates(&["google-chrome", "google-chrome-stable"]),
        },
        BrowserDefinition {
            name: "Microsoft Edge",
            kind: "edge",
            paths: path_candidates(&["microsoft-edge", "microsoft-edge-stable"]),
        },
        BrowserDefinition {
            name: "Brave",
            kind: "brave",
            paths: path_candidates(&["brave-browser", "brave"]),
        },
        BrowserDefinition {
            name: "Chromium",
            kind: "chromium",
            paths: path_candidates(&["chromium", "chromium-browser"]),
        },
        BrowserDefinition {
            name: "Vivaldi",
            kind: "vivaldi",
            paths: path_candidates(&["vivaldi", "vivaldi-stable"]),
        },
    ]
}

#[cfg(target_os = "windows")]
fn candidate_paths(installed: &[(&Option<PathBuf>, &str)], commands: &[&str]) -> Vec<PathBuf> {
    let mut paths = installed
        .iter()
        .filter_map(|(root, suffix)| root.as_ref().map(|root| root.join(suffix)))
        .collect::<Vec<_>>();
    paths.extend(path_candidates(commands));
    paths
}

fn path_candidates(commands: &[&str]) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let directories = std::env::split_paths(&path).collect::<Vec<_>>();
    directories
        .into_iter()
        .flat_map(|directory| commands.iter().map(move |command| directory.join(command)))
        .collect()
}

fn canonical_existing_file(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.to_path_buf()))
}

fn normalized_path_key(path: &Path) -> String {
    let key = path.to_string_lossy().replace('\\', "/");
    if cfg!(target_os = "windows") {
        key.to_ascii_lowercase()
    } else {
        key
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    normalized_path_key(left) == normalized_path_key(right)
}

fn discover_oracle_runtime(root: &Path) -> OracleRuntimeView {
    if let Some((command, source)) = preferred_oracle_mcp_command(root) {
        return runtime_view(command, source);
    }
    OracleRuntimeView {
        status: "missing".to_string(),
        source: "none".to_string(),
        version: None,
        command_path: None,
        node_path: None,
        install_supported: cfg!(target_os = "windows"),
        message: "Oracle is not installed. Browser accounts can be prepared now; webpage tasks remain disabled until the optional Oracle runtime is installed."
            .to_string(),
    }
}

fn oracle_mcp_launch(root: &Path) -> Option<OracleCommand> {
    preferred_oracle_mcp_command(root)
        .map(|(command, _)| command)
        .filter(oracle_command_is_compatible)
}

fn preferred_oracle_mcp_command(root: &Path) -> Option<(OracleCommand, &'static str)> {
    if let Some(command) = explicit_oracle_mcp_command() {
        return Some((command, "environment"));
    }
    if let Some(command) = managed_oracle_mcp_command(root) {
        return Some((command, "managed"));
    }
    find_system_command(if cfg!(target_os = "windows") {
        &["oracle-mcp.cmd", "oracle-mcp.exe", "oracle-mcp"]
    } else {
        &["oracle-mcp"]
    })
    .map(|path| (OracleCommand::System(path), "system"))
}

fn explicit_oracle_mcp_command() -> Option<OracleCommand> {
    if let Some(path) = std::env::var_os("SOMNIQ_ORACLE_MCP")
        .map(PathBuf::from)
        .and_then(|path| canonical_existing_file(&path))
    {
        return Some(OracleCommand::System(path));
    }
    let node = std::env::var_os("SOMNIQ_ORACLE_NODE")
        .map(PathBuf::from)
        .and_then(|path| canonical_existing_file(&path));
    let entrypoint = std::env::var_os("SOMNIQ_ORACLE_MCP_ENTRYPOINT")
        .map(PathBuf::from)
        .and_then(|path| canonical_existing_file(&path))
        .or_else(|| {
            std::env::var_os("SOMNIQ_ORACLE_ENTRYPOINT")
                .map(PathBuf::from)
                .and_then(|path| path.parent().map(|parent| parent.join("oracle-mcp.js")))
                .and_then(|path| canonical_existing_file(&path))
        });
    match (node, entrypoint) {
        (Some(node), Some(entrypoint)) => Some(OracleCommand::Managed { node, entrypoint }),
        _ => None,
    }
}

fn managed_oracle_mcp_command(root: &Path) -> Option<OracleCommand> {
    let current = root.join("runtime").join("current");
    let node_candidates = if cfg!(target_os = "windows") {
        vec![
            current.join("node").join("node.exe"),
            current.join("node.exe"),
        ]
    } else {
        vec![
            current.join("node").join("bin").join("node"),
            current.join("node"),
        ]
    };
    let node = node_candidates
        .iter()
        .find_map(|path| canonical_existing_file(path))?;
    let entrypoint = canonical_existing_file(
        &current
            .join("node_modules")
            .join("@steipete")
            .join("oracle")
            .join("dist")
            .join("bin")
            .join("oracle-mcp.js"),
    )?;
    Some(OracleCommand::Managed { node, entrypoint })
}

fn runtime_view(command: OracleCommand, source: &str) -> OracleRuntimeView {
    let version = oracle_command_version(&command);
    let compatible = version.as_deref() == Some(ORACLE_NPM_VERSION);
    let (command_path, node_path) = match &command {
        OracleCommand::System(path) => (Some(path.to_string_lossy().into_owned()), None),
        OracleCommand::Managed { node, entrypoint } => (
            Some(entrypoint.to_string_lossy().into_owned()),
            Some(node.to_string_lossy().into_owned()),
        ),
    };
    let message = if compatible {
        if source == "managed" {
            format!("The isolated SomniQ-managed Oracle {ORACLE_NPM_VERSION} runtime is ready.")
        } else {
            format!(
                "Oracle MCP {ORACLE_NPM_VERSION} is compatible with ChatGPT webpage and image tasks."
            )
        }
    } else if let Some(detected) = version.as_deref() {
        format!(
            "Detected Oracle MCP {detected}, but this SomniQ build requires {ORACLE_NPM_VERSION} with ChatGPT image support. Install the isolated SomniQ-managed runtime; your system Node and Oracle installations will not be changed."
        )
    } else {
        format!(
            "Detected Oracle MCP, but its package version could not be verified. SomniQ requires exactly {ORACLE_NPM_VERSION}. Install the isolated SomniQ-managed runtime; your system installation will not be changed."
        )
    };
    OracleRuntimeView {
        status: if compatible { "ready" } else { "incompatible" }.to_string(),
        source: source.to_string(),
        version,
        command_path,
        node_path,
        install_supported: cfg!(target_os = "windows"),
        message,
    }
}

fn oracle_command_is_compatible(command: &OracleCommand) -> bool {
    oracle_command_version(command).as_deref() == Some(ORACLE_NPM_VERSION)
}

fn oracle_command_version(command: &OracleCommand) -> Option<String> {
    match command {
        OracleCommand::Managed { entrypoint, .. } => oracle_version_from_entrypoint(entrypoint),
        OracleCommand::System(path) => system_oracle_version(path),
    }
}

fn system_oracle_version(command: &Path) -> Option<String> {
    let npm_package = command
        .parent()?
        .join("node_modules")
        .join("@steipete")
        .join("oracle")
        .join("package.json");
    read_oracle_package_version(&npm_package).or_else(|| oracle_version_from_entrypoint(command))
}

fn oracle_version_from_entrypoint(entrypoint: &Path) -> Option<String> {
    let package_path = entrypoint
        .parent()?
        .parent()?
        .parent()?
        .join("package.json");
    read_oracle_package_version(&package_path)
}

fn read_oracle_package_version(package_path: &Path) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(&fs::read(package_path).ok()?).ok()?;
    if value.get("name").and_then(|name| name.as_str()) != Some("@steipete/oracle") {
        return None;
    }
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(str::to_string)
}

fn find_system_command(commands: &[&str]) -> Option<PathBuf> {
    path_candidates(commands)
        .iter()
        .find_map(|path| canonical_existing_file(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn extracts_official_style_deflated_node_archive() {
        use zip::write::SimpleFileOptions;

        let temporary = tempfile::tempdir().expect("temp directory");
        let archive_path = temporary.path().join("node.zip");
        let archive_file = fs::File::create(&archive_path).expect("archive fixture");
        let mut writer = zip::ZipWriter::new(archive_file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("node-v24.0.0-win-x64/npm.cmd", options)
            .expect("start deflated entry");
        writer.write_all(b"@echo off\r\n").expect("write entry");
        writer.finish().expect("finish archive");

        let destination = temporary.path().join("node");
        extract_node_zip(&archive_path, &destination).expect("extract deflated archive");
        assert_eq!(
            fs::read(destination.join("npm.cmd")).expect("read extracted npm"),
            b"@echo off\r\n"
        );
    }

    #[test]
    fn browser_discovery_deduplicates_and_preserves_priority() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let browser = temporary.path().join("browser.exe");
        fs::write(&browser, b"browser").expect("browser fixture");
        let discovered = discover_browser_definitions(vec![
            BrowserDefinition {
                name: "Microsoft Edge",
                kind: "edge",
                paths: vec![browser.clone()],
            },
            BrowserDefinition {
                name: "Duplicate",
                kind: "duplicate",
                paths: vec![browser],
            },
        ]);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].kind, "edge");
        assert!(discovered[0].recommended);
    }

    #[test]
    fn manual_login_browser_has_no_automation_or_remote_debugging_flags() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let browser = temporary.path().join("browser.exe");
        let profile = temporary.path().join("browser-profile");
        let command = login_browser_command(&browser, &profile);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args
            .iter()
            .any(|arg| arg == &format!("--user-data-dir={}", profile.display())));
        assert!(args.iter().any(|arg| arg == "--new-window"));
        assert!(args.iter().any(|arg| arg == CHATGPT_URL));
        assert!(!args.iter().any(|arg| {
            arg.starts_with("--remote-debugging")
                || arg == "--enable-automation"
                || arg.starts_with("--headless")
        }));
    }

    #[test]
    fn every_account_uses_an_isolated_persistent_browser_user_without_cookie_sync() {
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Dedicated browser user".to_string(),
            browser_name: "Google Chrome".to_string(),
            browser_kind: "chrome".to_string(),
            browser_path: "C:/chrome.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: None,
            model: None,
        };
        let policy = account_browser_config(&account, None);
        assert_eq!(policy["browser"]["attachRunning"], false);
        assert_eq!(policy["browser"]["manualLogin"], true);
        assert_eq!(policy["browser"]["cookieSync"], false);
        let serialized = serde_json::to_string(&policy).expect("serialized policy");
        assert!(!serialized.contains("cookiePath"));
        assert!(!serialized.contains("profileDir"));
        assert!(!serialized.contains("remoteHost"));
        assert!(!serialized.contains("remoteChrome"));
    }

    #[test]
    fn account_browser_config_persists_an_explicit_default_model() {
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Configured model".to_string(),
            browser_name: "Google Chrome".to_string(),
            browser_kind: "chrome".to_string(),
            browser_path: "C:/chrome.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: Some(43),
            model: Some("gpt-5.6".to_string()),
        };
        let policy = account_browser_config(&account, None);
        assert_eq!(policy["browser"]["desiredModel"], "gpt-5.6");
        assert_eq!(policy["browser"]["modelStrategy"], "select");
    }

    #[test]
    fn chat_continuation_reopens_only_a_saved_local_chatgpt_conversation() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Continued account".to_string(),
            browser_name: "Google Chrome".to_string(),
            browser_kind: "chrome".to_string(),
            browser_path: "C:/chrome.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: Some(43),
            model: None,
        };
        let oracle_session_id = "prior-browser-consult";
        let metadata_path = account_oracle_home_dir(temporary.path(), &account.id)
            .expect("account oracle home")
            .join("sessions")
            .join(oracle_session_id)
            .join("meta.json");
        fs::create_dir_all(metadata_path.parent().expect("session parent"))
            .expect("session parent");
        fs::write(
            &metadata_path,
            br#"{"browser":{"runtime":{"conversationId":"6a81fd2a-7634-83e8-a1a0-89115d218de9"}}}"#,
        )
        .expect("session metadata");
        save_chat_continuation(temporary.path(), &account, "chat-123", oracle_session_id)
            .expect("save continuation");
        assert_eq!(
            resolve_chat_continuation(temporary.path(), &account, "chat-123")
                .expect("resolve continuation"),
            Some("https://chatgpt.com/c/6a81fd2a-7634-83e8-a1a0-89115d218de9".to_string())
        );
        let config = account_browser_config(
            &account,
            Some("https://chatgpt.com/c/6a81fd2a-7634-83e8-a1a0-89115d218de9"),
        );
        assert_eq!(config["browser"]["archiveConversations"], "never");
    }

    #[test]
    fn chat_continuation_updates_an_existing_store() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Continued account".to_string(),
            browser_name: "Google Chrome".to_string(),
            browser_kind: "chrome".to_string(),
            browser_path: "C:/chrome.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: Some(43),
            model: None,
        };
        save_chat_continuation(temporary.path(), &account, "chat-123", "first-session")
            .expect("save initial continuation");
        save_chat_continuation(temporary.path(), &account, "chat-123", "second-session")
            .expect("replace continuation");

        let store = load_chat_continuations(temporary.path(), &account).expect("load continuation");
        assert_eq!(
            store.sessions["chat-123"].oracle_session_id,
            "second-session"
        );
        assert!(!chat_continuation_store_path(temporary.path(), &account.id)
            .expect("continuation path")
            .with_file_name("chat-continuations.backup.json")
            .exists());
    }

    #[test]
    fn browser_follow_ups_are_bounded_and_non_empty() {
        assert_eq!(
            validate_browser_follow_ups(vec!["  ask again  ".to_string()]).expect("follow-up"),
            vec!["ask again".to_string()]
        );
        assert!(validate_browser_follow_ups(vec![String::new()]).is_err());
        assert!(
            validate_browser_follow_ups(vec!["next".to_string(); MAX_BROWSER_FOLLOW_UPS + 1])
                .is_err()
        );
    }

    #[test]
    fn profile_initialization_requires_chromium_profile_state() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let profile = temporary.path().join("browser-profile");
        fs::create_dir_all(&profile).expect("profile fixture");
        assert!(!chromium_profile_is_initialized(&profile));
        fs::write(profile.join("Local State"), b"{}").expect("chrome state fixture");
        assert!(chromium_profile_is_initialized(&profile));
    }

    #[test]
    fn successful_webpage_task_marks_account_login_as_verified() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Verification account".to_string(),
            browser_name: "Microsoft Edge".to_string(),
            browser_kind: "edge".to_string(),
            browser_path: "C:/browser.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: None,
            model: None,
        };
        save_store(
            temporary.path(),
            &AccountStore {
                version: STORE_VERSION,
                accounts: vec![account.clone()],
                consult_account_id: None,
                reviewer_account_id: None,
                image_account_id: None,
            },
        )
        .expect("save account store");

        mark_account_login_verified(temporary.path(), &account.id).expect("mark verified");
        let saved = load_store(temporary.path()).expect("load account store");
        assert!(saved.accounts[0].login_confirmed_at.is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn detects_chromium_profile_lock_without_treating_stale_files_as_busy() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_DELETE_ON_CLOSE,
            FILE_SHARE_READ,
        };

        let temporary = tempfile::tempdir().expect("temp directory");
        let profile = temporary.path().join("browser-profile");
        fs::create_dir_all(&profile).expect("profile fixture");
        assert!(!chromium_profile_lock_is_held(&profile).expect("missing lockfile"));

        let lock_path = profile.join("lockfile");
        fs::write(&lock_path, b"stale").expect("stale lockfile fixture");
        assert!(!chromium_profile_lock_is_held(&profile).expect("stale lockfile"));

        let lock_path_wide = lock_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let owner = unsafe {
            CreateFileW(
                lock_path_wide.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ,
                std::ptr::null(),
                CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(owner, INVALID_HANDLE_VALUE, "lock owner fixture");
        assert!(chromium_profile_lock_is_held(&profile).expect("held lockfile"));
        unsafe {
            CloseHandle(owner);
        }
        assert!(!chromium_profile_lock_is_held(&profile).expect("released lockfile"));
    }

    #[test]
    fn account_store_round_trips_without_credentials() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let account = StoredAccount {
            id: "00112233445566778899aabbccddeeff".to_string(),
            display_name: "Review account".to_string(),
            browser_name: "Microsoft Edge".to_string(),
            browser_kind: "edge".to_string(),
            browser_path: "C:/browser.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: None,
            model: None,
        };
        let store = AccountStore {
            version: STORE_VERSION,
            accounts: vec![account.clone()],
            consult_account_id: Some(account.id.clone()),
            reviewer_account_id: Some(account.id.clone()),
            image_account_id: None,
        };
        save_store(temporary.path(), &store).expect("save store");
        let loaded = load_store(temporary.path()).expect("load store");
        assert_eq!(loaded.accounts[0].display_name, account.display_name);
        assert_eq!(
            loaded.consult_account_id.as_deref(),
            Some(account.id.as_str())
        );
        assert_eq!(
            loaded.reviewer_account_id.as_deref(),
            Some(account.id.as_str())
        );
        let raw = fs::read_to_string(store_path(temporary.path())).expect("raw store");
        assert!(!raw.contains("password"));
        assert!(!raw.contains("cookie"));
    }

    #[test]
    fn legacy_existing_chrome_accounts_are_migrated_to_a_dedicated_browser_user() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let raw = serde_json::json!({
            "version": STORE_VERSION,
            "accounts": [{
                "id": "00112233445566778899aabbccddeeff",
                "displayName": "Legacy account",
                "browserName": "Google Chrome",
                "browserKind": "chrome",
                "browserPath": "C:/chrome.exe",
                "accessMode": "existingChrome",
                "debugPort": 9222,
                "createdAt": 42,
                "lastLoginLaunchedAt": null
            }],
            "consultAccountId": null,
            "reviewerAccountId": null,
            "imageAccountId": null
        });
        fs::write(
            store_path(temporary.path()),
            serde_json::to_vec_pretty(&raw).expect("store fixture"),
        )
        .expect("write store fixture");

        let store = load_store(temporary.path()).expect("load legacy store");
        assert_eq!(store.accounts[0].display_name, "Legacy account");
        let persisted = serde_json::to_value(&store).expect("serialize migrated account");
        assert!(persisted["accounts"][0].get("accessMode").is_none());
        assert!(persisted["accounts"][0].get("debugPort").is_none());
    }

    #[test]
    fn removing_an_account_archives_its_profile_and_clears_every_role() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let id = "00112233445566778899aabbccddeeff";
        let account = StoredAccount {
            id: id.to_string(),
            display_name: "Shared web account".to_string(),
            browser_name: "Microsoft Edge".to_string(),
            browser_kind: "edge".to_string(),
            browser_path: "C:/browser.exe".to_string(),
            created_at: 42,
            last_login_launched_at: None,
            login_confirmed_at: None,
            model: None,
        };
        let store = AccountStore {
            version: STORE_VERSION,
            accounts: vec![account],
            consult_account_id: Some(id.to_string()),
            reviewer_account_id: Some(id.to_string()),
            image_account_id: Some(id.to_string()),
        };
        save_store(temporary.path(), &store).expect("save store");
        let account_dir = account_root_dir(temporary.path(), id).expect("account dir");
        fs::create_dir_all(&account_dir).expect("account fixture");
        fs::write(account_dir.join("cookie-fixture"), b"local data").expect("profile fixture");

        let active_job = oracle_job_lock().try_lock().expect("active job fixture");
        let busy_error = remove_account_at(temporary.path(), id).expect_err("busy account removal");
        assert!(busy_error.contains("webpage task is running"));
        drop(active_job);

        let status = remove_account_at(temporary.path(), id).expect("remove account");

        assert!(status.accounts.is_empty());
        assert!(status.consult_account_id.is_none());
        assert!(status.reviewer_account_id.is_none());
        assert!(status.image_account_id.is_none());
        assert!(!account_dir.exists());
        let archived = fs::read_dir(temporary.path().join("archive"))
            .expect("archive directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("archive entries");
        assert_eq!(archived.len(), 1);
        assert!(archived[0].path().join("cookie-fixture").is_file());
    }

    #[test]
    fn account_paths_reject_traversal() {
        let temporary = tempfile::tempdir().expect("temp directory");
        assert!(account_profile_dir(temporary.path(), "../escape").is_err());
        let id = "00112233445566778899aabbccddeeff";
        let profile = account_profile_dir(temporary.path(), id).expect("profile path");
        assert!(profile.starts_with(temporary.path()));
    }

    #[test]
    fn managed_runtime_requires_node_and_oracle_mcp_entrypoint() {
        let temporary = tempfile::tempdir().expect("temp directory");
        assert!(managed_oracle_mcp_command(temporary.path()).is_none());
        let current = temporary.path().join("runtime").join("current");
        let node = if cfg!(target_os = "windows") {
            current.join("node").join("node.exe")
        } else {
            current.join("node").join("bin").join("node")
        };
        let entrypoint = current
            .join("node_modules")
            .join("@steipete")
            .join("oracle")
            .join("dist")
            .join("bin")
            .join("oracle-mcp.js");
        fs::create_dir_all(node.parent().expect("node parent")).expect("node parent");
        fs::create_dir_all(entrypoint.parent().expect("entrypoint parent"))
            .expect("entrypoint parent");
        fs::write(&node, b"node").expect("node fixture");
        fs::write(&entrypoint, b"oracle").expect("oracle fixture");
        assert!(managed_oracle_mcp_command(temporary.path()).is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn managed_node_arguments_remove_windows_verbatim_path_prefixes() {
        let (command, args) = mcp_command_parts(OracleCommand::Managed {
            node: PathBuf::from(r"\\?\C:\SomniQ\node.exe"),
            entrypoint: PathBuf::from(r"\\?\C:\SomniQ\oracle-mcp.js"),
        });
        assert_eq!(command, r"C:\SomniQ\node.exe");
        assert_eq!(args, vec![r"C:\SomniQ\oracle-mcp.js"]);
        assert_eq!(
            external_command_path(Path::new(r"\\?\UNC\server\share\oracle-mcp.js")),
            r"\\server\share\oracle-mcp.js"
        );
    }

    #[test]
    fn runtime_rejects_an_incompatible_system_oracle_package() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let npm_root = temporary.path().join("npm");
        let shim = npm_root.join(if cfg!(target_os = "windows") {
            "oracle-mcp.cmd"
        } else {
            "oracle-mcp"
        });
        let package_path = npm_root
            .join("node_modules")
            .join("@steipete")
            .join("oracle")
            .join("package.json");
        fs::create_dir_all(package_path.parent().expect("package parent")).expect("package parent");
        fs::write(&shim, b"oracle shim").expect("oracle shim");
        fs::write(
            &package_path,
            br#"{"name":"@steipete/oracle","version":"0.9.0"}"#,
        )
        .expect("old package fixture");

        let incompatible = runtime_view(OracleCommand::System(shim.clone()), "system");
        assert_eq!(incompatible.status, "incompatible");
        assert_eq!(incompatible.version.as_deref(), Some("0.9.0"));
        assert!(incompatible.message.contains(ORACLE_NPM_VERSION));
        assert!(!oracle_command_is_compatible(&OracleCommand::System(
            shim.clone()
        )));

        fs::write(
            package_path,
            format!(r#"{{"name":"@steipete/oracle","version":"{ORACLE_NPM_VERSION}"}}"#),
        )
        .expect("supported package fixture");
        let ready = runtime_view(OracleCommand::System(shim.clone()), "system");
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.version.as_deref(), Some(ORACLE_NPM_VERSION));
        assert!(oracle_command_is_compatible(&OracleCommand::System(shim)));
    }

    #[test]
    fn runtime_does_not_trust_an_unverifiable_oracle_executable() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let executable = temporary.path().join("oracle-mcp.exe");
        fs::write(&executable, b"unknown oracle").expect("oracle fixture");

        let view = runtime_view(OracleCommand::System(executable.clone()), "system");
        assert_eq!(view.status, "incompatible");
        assert!(view.version.is_none());
        assert!(!oracle_command_is_compatible(&OracleCommand::System(
            executable
        )));
    }

    #[test]
    fn image_aspect_ratio_validation_is_bounded() {
        assert_eq!(
            validate_aspect_ratio(Some("16:9".to_string())).expect("valid ratio"),
            Some("16:9".to_string())
        );
        assert!(validate_aspect_ratio(Some("wide".to_string())).is_err());
        assert!(validate_aspect_ratio(Some("0:9".to_string())).is_err());
        assert!(validate_aspect_ratio(Some("101:1".to_string())).is_err());
    }

    #[test]
    fn browser_model_picker_is_skipped_only_when_no_model_was_requested() {
        assert_eq!(browser_model_strategy(None), "current");
        assert_eq!(browser_model_strategy(Some("gpt-5.5-pro")), "select");
    }

    #[test]
    fn dangling_role_binding_fails_closed() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let raw = serde_json::json!({
            "version": STORE_VERSION,
            "accounts": [],
            "reviewerAccountId": "00112233445566778899aabbccddeeff",
            "imageAccountId": null
        });
        fs::write(
            store_path(temporary.path()),
            serde_json::to_vec_pretty(&raw).expect("store fixture"),
        )
        .expect("write store fixture");
        assert!(load_store(temporary.path()).is_err());
    }

    #[test]
    fn account_store_recovers_the_atomic_backup_after_an_interrupted_replace() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let store = AccountStore::default();
        save_store(temporary.path(), &store).expect("save store");
        fs::rename(
            store_path(temporary.path()),
            store_backup_path(temporary.path()),
        )
        .expect("simulate interrupted replace");
        let recovered = load_store(temporary.path()).expect("recover backup");
        assert_eq!(recovered.version, STORE_VERSION);
    }

    #[test]
    fn install_staging_guard_removes_only_its_generated_directory() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let runtime_root = temporary.path().join("runtime");
        let staging = runtime_root.join("installing-00112233445566778899aabbccddeeff");
        fs::create_dir_all(&staging).expect("staging fixture");
        fs::write(staging.join("partial"), b"partial").expect("partial fixture");
        {
            let _guard = InstallStagingGuard::new(runtime_root, staging.clone());
        }
        assert!(!staging.exists());
        assert!(temporary.path().exists());
    }
}

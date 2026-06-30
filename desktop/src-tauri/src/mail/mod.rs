//! Mail integration — connect personal Gmail and Outlook.com mailboxes over
//! OAuth2 and operate on them live (read / modify / send), so ARIS stays in
//! lock-step with the provider web UIs.
//!
//! Layering mirrors the rest of the desktop crate:
//!   - `model`    — provider-neutral, `camelCase` view/patch types.
//!   - `store`    — `~/.aris/mail/accounts.json` persistence (tokens + config).
//!   - `oauth`    — PKCE loopback consent + token refresh.
//!   - `provider` — token resolution + dispatch to a provider client.
//!   - `gmail` / `graph` — the two concrete API clients.
//!
//! All network-touching commands are `async` and offload to a blocking thread
//! (the clients use `reqwest::blocking`), matching `literature.rs`.

mod agent_tools;
mod atomic_file;
mod auto_literature;
mod autoconfig;
mod cache;
mod draft_attachment;
mod events;
mod gmail;
mod graph;
mod imap;
mod model;
mod oauth;
mod provider;
mod store;

use model::{
    GenericMailAccountInput, GenericMailTestResult, MailAccount, MailAutoconfigResult, MailDraft,
    MailFolder, MailMessageFull, MailMessageList, MailModifyPatch, MailOauthConfigPatch,
    MailOauthConfigView, Provider,
};

pub fn is_mail_tool(name: &str) -> bool {
    agent_tools::is_mail_tool(name)
}

pub fn mail_tool_specs() -> Vec<tools::ToolSpec> {
    agent_tools::tool_specs()
}

pub fn execute_mail_tool(name: &str, input: &serde_json::Value) -> Result<String, String> {
    agent_tools::execute_tool(name, input)
}

pub fn spawn_event_watchers(app: tauri::AppHandle) {
    events::start_connected_account_watchers(app)
}

async fn offload<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn mail_accounts_get() -> Vec<MailAccount> {
    store::list_accounts()
}

pub fn connected_account_labels(provider: &str) -> Vec<String> {
    store::list_accounts()
        .into_iter()
        .filter(|account| account.provider.as_str() == provider && account.connected)
        .map(|account| {
            if account.display_name.is_empty() || account.display_name == account.email {
                account.email
            } else {
                format!("{} <{}>", account.display_name, account.email)
            }
        })
        .collect()
}

#[tauri::command]
pub fn mail_oauth_config_get() -> MailOauthConfigView {
    store::oauth_config_view()
}

#[tauri::command]
pub fn mail_oauth_config_set(patch: MailOauthConfigPatch) -> Result<MailOauthConfigView, String> {
    store::set_oauth_config(patch)
}

#[tauri::command]
pub async fn mail_connect(provider: String) -> Result<MailAccount, String> {
    let provider =
        Provider::parse(&provider).ok_or_else(|| format!("Unknown mail provider: {provider}"))?;
    if provider == Provider::Imap {
        return Err(
            "Generic IMAP accounts use mail_generic_connect, not mail_connect.".to_string(),
        );
    }
    offload(move || oauth::connect(provider).map(|account| account.view())).await
}

#[tauri::command]
pub async fn mail_generic_test(
    input: GenericMailAccountInput,
) -> Result<GenericMailTestResult, String> {
    offload(move || imap::test_input(&input)).await
}

#[tauri::command]
pub async fn mail_autoconfig(email: String) -> Result<MailAutoconfigResult, String> {
    offload(move || autoconfig::discover(&email)).await
}

#[tauri::command]
pub async fn mail_generic_connect(
    app: tauri::AppHandle,
    input: GenericMailAccountInput,
) -> Result<MailAccount, String> {
    let account = offload(move || {
        let test = imap::test_input(&input)?;
        if !test.ok {
            return Err(test.message);
        }
        store::upsert_generic_account(input)
    })
    .await?;
    events::start_for_account(app, &account);
    Ok(account)
}

#[tauri::command]
pub fn mail_disconnect(account_id: String) -> Result<Vec<MailAccount>, String> {
    events::stop_for_account(&account_id);
    store::remove_account(&account_id)?;
    cache::clear_account(&account_id);
    Ok(store::list_accounts())
}

#[tauri::command]
pub async fn mail_folders(account_id: String) -> Result<Vec<MailFolder>, String> {
    offload(move || provider::folders(&account_id)).await
}

#[tauri::command]
pub async fn mail_list(
    account_id: String,
    folder: String,
    query: String,
    page_token: Option<String>,
) -> Result<MailMessageList, String> {
    offload(move || provider::list(&account_id, &folder, &query, page_token.as_deref())).await
}

#[tauri::command]
pub async fn mail_read(account_id: String, message_id: String) -> Result<MailMessageFull, String> {
    offload(move || provider::read(&account_id, &message_id)).await
}

#[tauri::command]
pub async fn mail_modify(
    account_id: String,
    message_id: String,
    patch: MailModifyPatch,
) -> Result<(), String> {
    offload(move || provider::modify(&account_id, &message_id, &patch)).await
}

#[tauri::command]
pub async fn mail_send(account_id: String, draft: MailDraft) -> Result<(), String> {
    offload(move || provider::send(&account_id, &draft)).await
}

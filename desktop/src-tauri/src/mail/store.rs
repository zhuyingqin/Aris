//! Local persistence for mail accounts, OAuth client credentials, and refresh
//! tokens. Everything lives in `~/.config/SomniQ/mail/accounts.json`. Tokens are
//! secrets: they are written to disk but never serialized into the
//! frontend-facing view types in `model.rs`.
//!
//! Uses a process-wide lock to serialize read-modify-write cycles so concurrent
//! token refreshes can't clobber each other. Writes use a same-dir temp file
//! plus OS-level replace so Windows never deletes the live config before the
//! new file is committed.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::model::{
    GenericMailAccountInput, IncomingServerConfig, MailAccount, MailIdentityConfig,
    OutgoingServerConfig, Provider,
};

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthConfig {
    #[serde(default)]
    pub gmail_client_id: String,
    #[serde(default)]
    pub gmail_client_secret: String,
    #[serde(default)]
    pub outlook_client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub provider: Provider,
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub incoming_server_id: String,
    #[serde(default)]
    pub identity_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix epoch seconds at which `access_token` expires.
    #[serde(default)]
    pub expires_at: i64,
}

impl StoredAccount {
    pub fn id(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.email)
    }

    pub fn view(&self) -> MailAccount {
        let connected = match self.provider {
            Provider::Imap => !self.incoming_server_id.is_empty(),
            Provider::Gmail | Provider::Outlook => !self.refresh_token.is_empty(),
        };
        MailAccount {
            id: self.id(),
            provider: self.provider,
            email: self.email.clone(),
            display_name: if self.display_name.is_empty() {
                self.email.clone()
            } else {
                self.display_name.clone()
            },
            connected,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreFile {
    #[serde(default)]
    pub oauth: OauthConfig,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
    #[serde(default)]
    pub incoming_servers: Vec<IncomingServerConfig>,
    #[serde(default)]
    pub outgoing_servers: Vec<OutgoingServerConfig>,
    #[serde(default)]
    pub identities: Vec<MailIdentityConfig>,
}

fn store_path() -> PathBuf {
    crate::state::mail_dir().join("accounts.json")
}

pub fn load() -> StoreFile {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(store: &StoreFile) -> Result<(), String> {
    let path = store_path();
    let body = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    super::atomic_file::write_replace(&path, body).map_err(|e| e.to_string())
}

/// Run `f` against the on-disk store under the global lock, persisting the
/// result. Returns whatever `f` produces.
fn with_store<T>(f: impl FnOnce(&mut StoreFile) -> Result<T, String>) -> Result<T, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "mail store lock poisoned".to_string())?;
    let mut store = load();
    let out = f(&mut store)?;
    save(&store)?;
    Ok(out)
}

pub fn oauth_config() -> OauthConfig {
    load().oauth
}

pub fn bundled_outlook_client_id() -> Option<&'static str> {
    option_env!("ARIS_OUTLOOK_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn effective_outlook_client_id(cfg: &OauthConfig) -> Option<String> {
    bundled_outlook_client_id().map(str::to_string).or_else(|| {
        let saved = cfg.outlook_client_id.trim();
        if saved.is_empty() {
            None
        } else {
            Some(saved.to_string())
        }
    })
}

pub fn list_accounts() -> Vec<MailAccount> {
    load().accounts.iter().map(StoredAccount::view).collect()
}

pub fn get_account(id: &str) -> Option<StoredAccount> {
    load().accounts.into_iter().find(|a| a.id() == id)
}

pub fn get_incoming_server(id: &str) -> Option<IncomingServerConfig> {
    load().incoming_servers.into_iter().find(|s| s.id == id)
}

pub fn get_outgoing_server(id: &str) -> Option<OutgoingServerConfig> {
    load().outgoing_servers.into_iter().find(|s| s.id == id)
}

pub fn get_identity(id: &str) -> Option<MailIdentityConfig> {
    load().identities.into_iter().find(|s| s.id == id)
}

pub fn upsert_account(account: StoredAccount) -> Result<MailAccount, String> {
    let view = account.view();
    with_store(|store| {
        let id = account.id();
        if let Some(existing) = store.accounts.iter_mut().find(|a| a.id() == id) {
            *existing = account;
        } else {
            store.accounts.push(account);
        }
        Ok(())
    })?;
    Ok(view)
}

fn stable_id(prefix: &str, email: &str) -> String {
    let normalized = email
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{prefix}_{normalized}")
}

pub fn upsert_generic_account(input: GenericMailAccountInput) -> Result<MailAccount, String> {
    let email = input.email.trim().to_string();
    if email.is_empty() {
        return Err("email is required".to_string());
    }
    let display_name = if input.display_name.trim().is_empty() {
        email.clone()
    } else {
        input.display_name.trim().to_string()
    };
    let incoming_id = stable_id("imap", &email);
    let outgoing_id = stable_id("smtp", &email);
    let identity_id = stable_id("identity", &email);

    let incoming = IncomingServerConfig {
        id: incoming_id.clone(),
        kind: "imap".to_string(),
        host: input.imap_host.trim().to_string(),
        port: input.imap_port,
        security: input.imap_security,
        username: input.imap_username.trim().to_string(),
        password: input.imap_password,
    };
    let outgoing = OutgoingServerConfig {
        id: outgoing_id.clone(),
        kind: "smtp".to_string(),
        host: input.smtp_host.trim().to_string(),
        port: input.smtp_port,
        security: input.smtp_security,
        username: input.smtp_username.trim().to_string(),
        password: input.smtp_password,
        enabled: input.smtp_enabled,
    };
    let identity = MailIdentityConfig {
        id: identity_id.clone(),
        email: email.clone(),
        display_name: display_name.clone(),
        outgoing_server_id: outgoing_id.clone(),
    };
    let account = StoredAccount {
        provider: Provider::Imap,
        email,
        display_name,
        incoming_server_id: incoming_id,
        identity_id,
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: 0,
    };
    let view = account.view();

    with_store(|store| {
        upsert_by_id(&mut store.incoming_servers, incoming, |item| &item.id);
        upsert_by_id(&mut store.outgoing_servers, outgoing, |item| &item.id);
        upsert_by_id(&mut store.identities, identity, |item| &item.id);
        let id = account.id();
        if let Some(existing) = store.accounts.iter_mut().find(|a| a.id() == id) {
            *existing = account;
        } else {
            store.accounts.push(account);
        }
        Ok(())
    })?;
    Ok(view)
}

fn upsert_by_id<T>(items: &mut Vec<T>, value: T, id: impl Fn(&T) -> &str) {
    let value_id = id(&value).to_string();
    if let Some(existing) = items.iter_mut().find(|item| id(item) == value_id) {
        *existing = value;
    } else {
        items.push(value);
    }
}

pub fn remove_account(id: &str) -> Result<(), String> {
    with_store(|store| {
        if let Some(account) = store.accounts.iter().find(|a| a.id() == id).cloned() {
            let outgoing_server_id = store
                .identities
                .iter()
                .find(|identity| identity.id == account.identity_id)
                .map(|identity| identity.outgoing_server_id.clone())
                .unwrap_or_else(|| stable_id("smtp", &account.email));
            store
                .incoming_servers
                .retain(|server| server.id != account.incoming_server_id);
            store
                .identities
                .retain(|identity| identity.id != account.identity_id);
            store
                .outgoing_servers
                .retain(|server| server.id != outgoing_server_id);
        }
        store.accounts.retain(|a| a.id() != id);
        Ok(())
    })
}

/// Persist refreshed tokens for an account without touching other fields.
pub fn update_tokens(
    id: &str,
    access_token: &str,
    expires_at: i64,
    refresh_token: Option<&str>,
) -> Result<(), String> {
    with_store(|store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|a| a.id() == id)
            .ok_or_else(|| format!("mail account not found: {id}"))?;
        account.access_token = access_token.to_string();
        account.expires_at = expires_at;
        if let Some(refresh) = refresh_token {
            if !refresh.is_empty() {
                account.refresh_token = refresh.to_string();
            }
        }
        Ok(())
    })
}

//! Provider-neutral dispatch. Each public function resolves a valid access
//! token (refreshing if needed) and routes to a protocol/backend adapter.
//!
//! This is the first cut of a Thunderbird-style split: the UI and Tauri command
//! layer talk to a generic message service, while provider/protocol details stay
//! behind backend adapters. Adding IMAP, SMTP, JMAP, or hosted connectors should
//! mean registering another backend, not rewriting the mailbox UI.

use super::cache;
use super::gmail;
use super::graph;
use super::imap;
use super::model::{
    MailDraft, MailFolder, MailMessageFull, MailMessageList, MailModifyPatch, Provider,
};
use super::oauth;
use super::store;

struct AccountSession {
    provider: Provider,
    tool_token: String,
}

impl AccountSession {
    fn tool_token(&self) -> &str {
        &self.tool_token
    }
}

trait MailBackend: Sync {
    fn identity(&self, access_token: &str) -> Result<(String, String), String>;
    fn folders(&self, access_token: &str) -> Result<Vec<MailFolder>, String>;
    fn list(
        &self,
        access_token: &str,
        folder: &str,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<MailMessageList, String>;
    fn read(&self, access_token: &str, message_id: &str) -> Result<MailMessageFull, String>;
    fn modify(
        &self,
        access_token: &str,
        message_id: &str,
        patch: &MailModifyPatch,
    ) -> Result<(), String>;
    fn send(&self, access_token: &str, draft: &MailDraft) -> Result<(), String>;
}

struct GmailBackend;

impl MailBackend for GmailBackend {
    fn identity(&self, access_token: &str) -> Result<(String, String), String> {
        gmail::identity(access_token)
    }

    fn folders(&self, access_token: &str) -> Result<Vec<MailFolder>, String> {
        gmail::folders(access_token)
    }

    fn list(
        &self,
        access_token: &str,
        folder: &str,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<MailMessageList, String> {
        gmail::list(access_token, folder, query, page_token)
    }

    fn read(&self, access_token: &str, message_id: &str) -> Result<MailMessageFull, String> {
        gmail::read(access_token, message_id)
    }

    fn modify(
        &self,
        access_token: &str,
        message_id: &str,
        patch: &MailModifyPatch,
    ) -> Result<(), String> {
        gmail::modify(access_token, message_id, patch)
    }

    fn send(&self, access_token: &str, draft: &MailDraft) -> Result<(), String> {
        gmail::send(access_token, draft)
    }
}

struct GraphBackend;

impl MailBackend for GraphBackend {
    fn identity(&self, access_token: &str) -> Result<(String, String), String> {
        graph::identity(access_token)
    }

    fn folders(&self, access_token: &str) -> Result<Vec<MailFolder>, String> {
        graph::folders(access_token)
    }

    fn list(
        &self,
        access_token: &str,
        folder: &str,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<MailMessageList, String> {
        graph::list(access_token, folder, query, page_token)
    }

    fn read(&self, access_token: &str, message_id: &str) -> Result<MailMessageFull, String> {
        graph::read(access_token, message_id)
    }

    fn modify(
        &self,
        access_token: &str,
        message_id: &str,
        patch: &MailModifyPatch,
    ) -> Result<(), String> {
        graph::modify(access_token, message_id, patch)
    }

    fn send(&self, access_token: &str, draft: &MailDraft) -> Result<(), String> {
        graph::send(access_token, draft)
    }
}

struct ImapBackend;

impl MailBackend for ImapBackend {
    fn identity(&self, _access_token: &str) -> Result<(String, String), String> {
        Err("IMAP identity is resolved from the account store".to_string())
    }

    fn folders(&self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        imap::folders(account_id)
    }

    fn list(
        &self,
        account_id: &str,
        folder: &str,
        query: &str,
        page_token: Option<&str>,
    ) -> Result<MailMessageList, String> {
        imap::list(account_id, folder, query, page_token)
    }

    fn read(&self, account_id: &str, message_id: &str) -> Result<MailMessageFull, String> {
        imap::read(account_id, message_id)
    }

    fn modify(
        &self,
        account_id: &str,
        message_id: &str,
        patch: &MailModifyPatch,
    ) -> Result<(), String> {
        imap::modify(account_id, message_id, patch)
    }

    fn send(&self, account_id: &str, draft: &MailDraft) -> Result<(), String> {
        imap::send(account_id, draft)
    }
}

static GMAIL_BACKEND: GmailBackend = GmailBackend;
static GRAPH_BACKEND: GraphBackend = GraphBackend;
static IMAP_BACKEND: ImapBackend = ImapBackend;

fn backend(provider: Provider) -> &'static dyn MailBackend {
    match provider {
        Provider::Gmail => &GMAIL_BACKEND,
        Provider::Outlook => &GRAPH_BACKEND,
        Provider::Imap => &IMAP_BACKEND,
    }
}

fn resolve(account_id: &str) -> Result<AccountSession, String> {
    let account = store::get_account(account_id)
        .ok_or_else(|| format!("mail account not found: {account_id}"))?;
    let tool_token = match account.provider {
        Provider::Gmail | Provider::Outlook => oauth::ensure_access_token(account_id)?,
        Provider::Imap => account_id.to_string(),
    };
    Ok(AccountSession {
        provider: account.provider,
        tool_token,
    })
}

/// Fetch the signed-in user's email + display name right after token exchange,
/// so we can key the account. Called by `oauth::connect`.
pub fn fetch_identity(provider: Provider, access_token: &str) -> Result<(String, String), String> {
    backend(provider).identity(access_token)
}

pub fn folders(account_id: &str) -> Result<Vec<MailFolder>, String> {
    let session = resolve(account_id)?;
    backend(session.provider).folders(session.tool_token())
}

pub fn list(
    account_id: &str,
    folder: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MailMessageList, String> {
    let session = resolve(account_id)?;
    let result =
        backend(session.provider).list(session.tool_token(), folder, query, page_token)?;
    // Background-prefetch bodies for the visible page so the next click is
    // instant. Search results are skipped — they shift on every refresh and
    // prefetching them would mostly waste quota on results the user won't
    // re-open.
    if query.trim().is_empty() {
        let ids: Vec<String> = result.messages.iter().map(|m| m.id.clone()).collect();
        prefetch_bodies(account_id.to_string(), ids);
    }
    Ok(result)
}

/// Fire-and-forget warm-up of the per-message body cache for `message_ids`.
/// Runs on a dedicated OS thread so `list` returns without waiting on IMAP
/// fetches. Each id is checked against the cache first, so repeated calls
/// (folder switches, paging) do no duplicate work.
fn prefetch_bodies(account_id: String, message_ids: Vec<String>) {
    std::thread::spawn(move || {
        for message_id in message_ids {
            if cache::load_message(&account_id, &message_id).is_some() {
                continue;
            }
            let Ok(session) = resolve(&account_id) else {
                continue;
            };
            let backend = backend(session.provider);
            let Ok(message) = backend.read(session.tool_token(), &message_id) else {
                continue;
            };
            let _ = cache::save_message(&account_id, &message_id, &message);
        }
    });
}

pub fn read(account_id: &str, message_id: &str) -> Result<MailMessageFull, String> {
    if let Some(message) = cache::load_message(account_id, message_id) {
        return Ok(message);
    }
    let session = resolve(account_id)?;
    let message = backend(session.provider).read(session.tool_token(), message_id)?;
    let _ = cache::save_message(account_id, message_id, &message);
    Ok(message)
}

pub fn modify(account_id: &str, message_id: &str, patch: &MailModifyPatch) -> Result<(), String> {
    let session = resolve(account_id)?;
    backend(session.provider).modify(session.tool_token(), message_id, patch)?;
    if let Some(mut message) = cache::load_message(account_id, message_id) {
        if let Some(unread) = patch.unread {
            message.unread = unread;
        }
        if let Some(starred) = patch.starred {
            message.starred = starred;
        }
        let _ = cache::save_message(account_id, message_id, &message);
    }
    Ok(())
}

pub fn send(account_id: &str, draft: &MailDraft) -> Result<(), String> {
    let session = resolve(account_id)?;
    backend(session.provider).send(session.tool_token(), draft)
}

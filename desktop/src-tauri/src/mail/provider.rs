//! Provider-neutral dispatch. Each public function resolves a valid access
//! token (refreshing if needed) and routes to a protocol/backend adapter.
//!
//! This is the first cut of a Thunderbird-style split: the UI and Tauri command
//! layer talk to a generic message service, while provider/protocol details stay
//! behind backend adapters. Adding IMAP, SMTP, JMAP, or hosted connectors should
//! mean registering another backend, not rewriting the mailbox UI.

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
    backend(session.provider).list(session.tool_token(), folder, query, page_token)
}

pub fn read(account_id: &str, message_id: &str) -> Result<MailMessageFull, String> {
    let session = resolve(account_id)?;
    backend(session.provider).read(session.tool_token(), message_id)
}

pub fn modify(account_id: &str, message_id: &str, patch: &MailModifyPatch) -> Result<(), String> {
    let session = resolve(account_id)?;
    backend(session.provider).modify(session.tool_token(), message_id, patch)
}

pub fn send(account_id: &str, draft: &MailDraft) -> Result<(), String> {
    let session = resolve(account_id)?;
    backend(session.provider).send(session.tool_token(), draft)
}

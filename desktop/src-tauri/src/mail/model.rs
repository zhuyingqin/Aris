//! Shared data model for the mail integration. All types serialize as
//! `camelCase` so the React layer (`desktop/src/mail`) can consume them
//! directly. Provider-specific clients (`gmail.rs`, `graph.rs`) translate
//! their native payloads into these provider-neutral shapes.

use serde::{Deserialize, Serialize};

/// Which upstream mail provider an account is backed by. Drives OAuth config,
/// API base URLs, and label/folder semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gmail,
    Outlook,
    Imap,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Gmail => "gmail",
            Provider::Outlook => "outlook",
            Provider::Imap => "imap",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "gmail" => Some(Provider::Gmail),
            "outlook" => Some(Provider::Outlook),
            "imap" => Some(Provider::Imap),
            _ => None,
        }
    }
}

/// A connected mailbox as surfaced to the UI. Never carries tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    /// Stable id: `"{provider}:{email}"`.
    pub id: String,
    pub provider: Provider,
    pub email: String,
    pub display_name: String,
    pub connected: bool,
}

/// Common TLS modes for IMAP/SMTP account setup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailSocketSecurity {
    Tls,
    Starttls,
    None,
}

impl Default for MailSocketSecurity {
    fn default() -> Self {
        Self::Tls
    }
}

/// Thunderbird-style incoming server record. The first implementation uses IMAP
/// but the shape intentionally leaves room for JMAP/Exchange/connector backends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingServerConfig {
    pub id: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub security: MailSocketSecurity,
    pub username: String,
    #[serde(default)]
    pub password: String,
}

/// Thunderbird-style outgoing server record. SMTP is the generic fallback; API
/// send backends can be represented by a different `kind` later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingServerConfig {
    pub id: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub security: MailSocketSecurity,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailIdentityConfig {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub outgoing_server_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericMailAccountInput {
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    #[serde(default)]
    pub imap_security: MailSocketSecurity,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default)]
    pub smtp_enabled: bool,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default)]
    pub smtp_port: u16,
    #[serde(default)]
    pub smtp_security: MailSocketSecurity,
    #[serde(default)]
    pub smtp_username: String,
    #[serde(default)]
    pub smtp_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericMailTestResult {
    pub ok: bool,
    pub imap_ok: bool,
    pub smtp_ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAutoconfigResult {
    pub source: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: MailSocketSecurity,
    pub imap_username: String,
    pub smtp_enabled: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: MailSocketSecurity,
    pub smtp_username: String,
    pub notes: Vec<String>,
}

/// A logical mail container. For Gmail this maps to a label; for Outlook to a
/// mail folder. `kind` normalizes the well-known ones so the UI can render
/// stable icons/order regardless of provider naming.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    pub id: String,
    pub name: String,
    /// One of: inbox, sent, drafts, trash, spam, archive, starred, important,
    /// promotions, social, updates, forums, custom.
    pub kind: String,
    pub unread_count: u32,
}

/// One message as shown in a list view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageSummary {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: String,
    pub to: String,
    pub subject: String,
    pub snippet: String,
    /// RFC3339 timestamp when available, else the raw provider value.
    pub date: String,
    pub unread: bool,
    pub starred: bool,
    pub has_attachments: bool,
    pub labels: Vec<String>,
}

/// A page of message summaries plus the opaque cursor for the next page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageList {
    pub messages: Vec<MailMessageSummary>,
    pub next_page_token: Option<String>,
}

/// Full message content for the reading pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessageFull {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: String,
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub date: String,
    pub unread: bool,
    pub starred: bool,
    pub labels: Vec<String>,
    /// Sanitized HTML body when present, else `null` (UI falls back to text).
    pub body_html: Option<String>,
    pub body_text: String,
    pub attachments: Vec<MailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
}

/// Mutations requested against a message (P2 write operations). Every field is
/// optional; `None` means "leave unchanged". Provider clients translate these
/// into label edits (Gmail) or PATCH/move calls (Graph).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailModifyPatch {
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    /// Move to archive (remove from inbox).
    pub archive: Option<bool>,
    /// Move to trash.
    pub trash: Option<bool>,
    /// Target folder/label id to move the message into.
    pub move_to: Option<String>,
}

/// An outgoing message (P2 send).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDraft {
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
    pub subject: String,
    pub body: String,
}

/// OAuth client credentials the user supplies in Settings. Secrets are masked
/// when read back; `*_has_secret` flags tell the UI whether one is stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOauthConfigView {
    pub gmail_client_id: String,
    pub gmail_has_secret: bool,
    pub outlook_configured: bool,
    pub outlook_uses_bundled_client: bool,
    pub outlook_client_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailOauthConfigPatch {
    pub gmail_client_id: Option<String>,
    pub gmail_client_secret: Option<String>,
    pub outlook_client_id: Option<String>,
}

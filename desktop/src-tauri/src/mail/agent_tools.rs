use serde::Deserialize;
use serde_json::{json, Value};

use runtime::PermissionMode;

use super::model::{MailDraft, MailModifyPatch};
use super::{provider, store};

const MAIL_TOOL_NAMES: &[&str] = &[
    "mail_accounts",
    "mail_folders",
    "mail_search",
    "mail_read",
    "mail_send",
    "mail_mark",
    "mail_move",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailSearchInput {
    account_id: Option<String>,
    folder: Option<String>,
    query: Option<String>,
    page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailFoldersInput {
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailReadInput {
    account_id: Option<String>,
    message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailSendInput {
    account_id: Option<String>,
    to: String,
    #[serde(default)]
    cc: String,
    #[serde(default)]
    bcc: String,
    subject: String,
    body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailMarkInput {
    account_id: Option<String>,
    message_id: String,
    unread: Option<bool>,
    starred: Option<bool>,
    archive: Option<bool>,
    trash: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailMoveInput {
    account_id: Option<String>,
    message_id: String,
    folder: String,
}

pub fn is_mail_tool(name: &str) -> bool {
    MAIL_TOOL_NAMES.contains(&name)
}

pub fn tool_specs() -> Vec<tools::ToolSpec> {
    vec![
        tools::ToolSpec {
            name: "mail_accounts",
            description: "List connected ARIS mail accounts available to the agent.",
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        tools::ToolSpec {
            name: "mail_folders",
            description: "List folders or labels for a connected mail account.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" }
                },
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        tools::ToolSpec {
            name: "mail_search",
            description: "Search or list mailbox messages. Defaults to the first connected account and inbox.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" },
                    "folder": { "type": "string", "description": "Provider folder/label id, e.g. INBOX or inbox." },
                    "query": { "type": "string", "description": "Provider-supported search text." },
                    "pageToken": { "type": "string" }
                },
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        tools::ToolSpec {
            name: "mail_read",
            description: "Read one email message body and metadata.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" },
                    "messageId": { "type": "string" }
                },
                "required": ["messageId"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        tools::ToolSpec {
            name: "mail_send",
            description: "Send an email from a connected account. Requires user approval in prompt mode.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" },
                    "to": { "type": "string" },
                    "cc": { "type": "string" },
                    "bcc": { "type": "string" },
                    "subject": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["to", "subject", "body"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        tools::ToolSpec {
            name: "mail_mark",
            description: "Mark, archive, star, unstar, or trash one email message.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" },
                    "messageId": { "type": "string" },
                    "unread": { "type": "boolean" },
                    "starred": { "type": "boolean" },
                    "archive": { "type": "boolean" },
                    "trash": { "type": "boolean" }
                },
                "required": ["messageId"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
        tools::ToolSpec {
            name: "mail_move",
            description: "Move one email message to a provider folder or label.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "accountId": { "type": "string" },
                    "messageId": { "type": "string" },
                    "folder": { "type": "string" }
                },
                "required": ["messageId", "folder"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
    ]
}

pub fn execute_tool(name: &str, input: &Value) -> Result<String, String> {
    let output = match name {
        "mail_accounts" => json!(store::list_accounts()),
        "mail_folders" => {
            let input = serde_json::from_value::<MailFoldersInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let result = provider::folders(&account_id)?;
            json!({ "accountId": account_id, "folders": result })
        }
        "mail_search" => {
            let input = serde_json::from_value::<MailSearchInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let folder = input.folder.unwrap_or_default();
            let query = input.query.unwrap_or_default();
            let result = provider::list(&account_id, &folder, &query, input.page_token.as_deref())?;
            json!({
                "accountId": account_id,
                "folder": folder,
                "query": query,
                "result": result,
            })
        }
        "mail_read" => {
            let input = serde_json::from_value::<MailReadInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let result = provider::read(&account_id, &input.message_id)?;
            json!({ "accountId": account_id, "message": result })
        }
        "mail_send" => {
            let input = serde_json::from_value::<MailSendInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let draft = MailDraft {
                to: input.to,
                cc: input.cc,
                bcc: input.bcc,
                subject: input.subject,
                body: input.body,
            };
            provider::send(&account_id, &draft)?;
            json!({ "ok": true, "accountId": account_id })
        }
        "mail_mark" => {
            let input = serde_json::from_value::<MailMarkInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let patch = MailModifyPatch {
                unread: input.unread,
                starred: input.starred,
                archive: input.archive,
                trash: input.trash,
                move_to: None,
            };
            provider::modify(&account_id, &input.message_id, &patch)?;
            json!({ "ok": true, "accountId": account_id })
        }
        "mail_move" => {
            let input = serde_json::from_value::<MailMoveInput>(input.clone())
                .map_err(|error| error.to_string())?;
            let account_id = resolve_account_id(input.account_id)?;
            let patch = MailModifyPatch {
                move_to: Some(input.folder),
                ..MailModifyPatch::default()
            };
            provider::modify(&account_id, &input.message_id, &patch)?;
            json!({ "ok": true, "accountId": account_id })
        }
        _ => return Err(format!("unknown mail tool: {name}")),
    };
    serde_json::to_string_pretty(&output).map_err(|error| error.to_string())
}

fn resolve_account_id(requested: Option<String>) -> Result<String, String> {
    if let Some(account_id) = requested.filter(|value| !value.trim().is_empty()) {
        return Ok(account_id);
    }
    store::list_accounts()
        .into_iter()
        .find(|account| account.connected)
        .map(|account| account.id)
        .ok_or_else(|| "no connected mail account; add one in Settings > Mail".to_string())
}

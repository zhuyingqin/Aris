//! Microsoft Graph client (https://graph.microsoft.com/v1.0/me) for
//! Outlook.com / Microsoft 365 personal accounts. Maps Graph's folder + message
//! resources into the provider-neutral shapes in `model.rs`. All operations run
//! live, so changes appear in the Outlook web UI immediately.

use base64::Engine;
use serde_json::{json, Value};

use super::draft_attachment;
use super::model::{
    MailAttachment, MailDraft, MailFolder, MailMessageFull, MailMessageList, MailMessageSummary,
    MailModifyPatch,
};

const BASE: &str = "https://graph.microsoft.com/v1.0/me";
const PAGE_SIZE: u32 = 25;

/// (well-known folder name, normalized kind, display fallback).
const WELL_KNOWN: &[(&str, &str, &str)] = &[
    ("inbox", "inbox", "Inbox"),
    ("archive", "archive", "Archive"),
    ("sentitems", "sent", "Sent"),
    ("drafts", "drafts", "Drafts"),
    ("junkemail", "spam", "Junk"),
    ("deleteditems", "trash", "Deleted"),
];

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}

fn get(token: &str, url: &str) -> Result<Value, String> {
    let resp = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;
    json_or_error(resp)
}

fn json_or_error(resp: reqwest::blocking::Response) -> Result<Value, String> {
    let status = resp.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let value: Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Microsoft Graph error");
        return Err(format!("Graph API {status}: {msg}"));
    }
    Ok(value)
}

pub fn identity(token: &str) -> Result<(String, String), String> {
    let me = get(
        token,
        &format!("{BASE}?$select=mail,userPrincipalName,displayName"),
    )?;
    let email = me
        .get("mail")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| me.get("userPrincipalName").and_then(Value::as_str))
        .ok_or_else(|| "Graph profile missing mail/userPrincipalName".to_string())?
        .to_string();
    let display = me
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&email)
        .to_string();
    Ok((email, display))
}

pub fn folders(token: &str) -> Result<Vec<MailFolder>, String> {
    let mut folders = Vec::new();
    for (name, kind, fallback) in WELL_KNOWN {
        let Ok(folder) = get(
            token,
            &format!("{BASE}/mailFolders/{name}?$select=displayName,unreadItemCount"),
        ) else {
            continue;
        };
        folders.push(MailFolder {
            id: (*name).to_string(),
            name: folder
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_string(),
            kind: (*kind).to_string(),
            unread_count: folder
                .get("unreadItemCount")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32,
        });
    }
    Ok(folders)
}

const SELECT: &str = "id,conversationId,subject,bodyPreview,from,toRecipients,\
                      receivedDateTime,isRead,flag,hasAttachments";

pub fn list(
    token: &str,
    folder: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MailMessageList, String> {
    // Graph hands back a full `@odata.nextLink` URL; reuse it verbatim.
    let url = if let Some(next) = page_token.filter(|t| t.starts_with("http")) {
        next.to_string()
    } else if !query.is_empty() {
        format!(
            "{BASE}/messages?$search=\"{}\"&$top={PAGE_SIZE}&$select={SELECT}",
            urlencoding::encode(query)
        )
    } else {
        let folder = if folder.is_empty() { "inbox" } else { folder };
        format!(
            "{BASE}/mailFolders/{folder}/messages?$top={PAGE_SIZE}\
             &$orderby=receivedDateTime%20desc&$select={SELECT}"
        )
    };

    let list = get(token, &url)?;
    let next_page_token = list
        .get("@odata.nextLink")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let empty = Vec::new();
    let items = list
        .get("value")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let messages = items.iter().map(summary_from).collect();
    Ok(MailMessageList {
        messages,
        next_page_token,
    })
}

fn from_pair(message: &Value) -> (String, String) {
    let addr = message.get("from").and_then(|f| f.get("emailAddress"));
    let name = addr
        .and_then(|a| a.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let address = addr
        .and_then(|a| a.get("address"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = if name.is_empty() {
        address.clone()
    } else {
        name
    };
    (name, address)
}

fn recipients_string(message: &Value, field: &str) -> String {
    message
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|r| {
                    r.get("emailAddress")
                        .and_then(|a| a.get("address"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn is_starred(message: &Value) -> bool {
    message
        .get("flag")
        .and_then(|f| f.get("flagStatus"))
        .and_then(Value::as_str)
        .is_some_and(|s| s == "flagged")
}

fn summary_from(message: &Value) -> MailMessageSummary {
    let (from_name, from) = from_pair(message);
    let unread = !message
        .get("isRead")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    MailMessageSummary {
        id: message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thread_id: message
            .get("conversationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        from,
        from_name,
        to: recipients_string(message, "toRecipients"),
        subject: message
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        snippet: message
            .get("bodyPreview")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        date: message
            .get("receivedDateTime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        unread,
        starred: is_starred(message),
        has_attachments: message
            .get("hasAttachments")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        labels: Vec::new(),
    }
}

pub fn read(token: &str, message_id: &str) -> Result<MailMessageFull, String> {
    let url = format!("{BASE}/messages/{message_id}?$select={SELECT},ccRecipients,body");
    let message = get(token, &url)?;
    let (from_name, from) = from_pair(&message);
    let unread = !message
        .get("isRead")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let body = message.get("body");
    let content = body
        .and_then(|b| b.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let is_html = body
        .and_then(|b| b.get("contentType"))
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("html"));

    let attachments = if message
        .get("hasAttachments")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        fetch_attachments(token, message_id).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(MailMessageFull {
        id: message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thread_id: message
            .get("conversationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        from,
        from_name,
        to: recipients_string(&message, "toRecipients"),
        cc: recipients_string(&message, "ccRecipients"),
        subject: message
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        date: message
            .get("receivedDateTime")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        unread,
        starred: is_starred(&message),
        labels: Vec::new(),
        body_html: if is_html { Some(content.clone()) } else { None },
        body_text: if is_html { String::new() } else { content },
        attachments,
    })
}

fn fetch_attachments(token: &str, message_id: &str) -> Result<Vec<MailAttachment>, String> {
    let list = get(
        token,
        &format!("{BASE}/messages/{message_id}/attachments?$select=id,name,contentType,size"),
    )?;
    let empty = Vec::new();
    let items = list
        .get("value")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|a| MailAttachment {
            id: a
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            filename: a
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            mime_type: a
                .get("contentType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
        })
        .collect())
}

pub fn modify(token: &str, message_id: &str, patch: &MailModifyPatch) -> Result<(), String> {
    // Property changes (read state, flag) via PATCH.
    let mut body = serde_json::Map::new();
    if let Some(unread) = patch.unread {
        body.insert("isRead".into(), json!(!unread));
    }
    if let Some(starred) = patch.starred {
        body.insert(
            "flag".into(),
            json!({ "flagStatus": if starred { "flagged" } else { "notFlagged" } }),
        );
    }
    if !body.is_empty() {
        let resp = client()
            .patch(format!("{BASE}/messages/{message_id}"))
            .bearer_auth(token)
            .json(&Value::Object(body))
            .send()
            .map_err(|e| e.to_string())?;
        json_or_error(resp)?;
    }

    // Folder moves via the move action.
    let destination = if patch.trash == Some(true) {
        Some("deleteditems".to_string())
    } else if patch.archive == Some(true) {
        Some("archive".to_string())
    } else {
        patch.move_to.clone().filter(|t| !t.is_empty())
    };
    if let Some(destination) = destination {
        let resp = client()
            .post(format!("{BASE}/messages/{message_id}/move"))
            .bearer_auth(token)
            .json(&json!({ "destinationId": destination }))
            .send()
            .map_err(|e| e.to_string())?;
        json_or_error(resp)?;
    }
    Ok(())
}

fn recipients_json(raw: &str) -> Vec<Value> {
    raw.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|addr| json!({ "emailAddress": { "address": addr } }))
        .collect()
}

pub fn send(token: &str, draft: &MailDraft) -> Result<(), String> {
    let mut message = serde_json::Map::new();
    message.insert("subject".into(), json!(draft.subject));
    message.insert(
        "body".into(),
        json!({ "contentType": "Text", "content": draft.body }),
    );
    message.insert("toRecipients".into(), json!(recipients_json(&draft.to)));
    if !draft.cc.is_empty() {
        message.insert("ccRecipients".into(), json!(recipients_json(&draft.cc)));
    }
    if !draft.bcc.is_empty() {
        message.insert("bccRecipients".into(), json!(recipients_json(&draft.bcc)));
    }
    let attachments = draft_attachment::resolve_all(draft)?;
    if !attachments.is_empty() {
        message.insert(
            "attachments".into(),
            json!(
                attachments
                    .iter()
                    .map(|attachment| json!({
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        "name": attachment.filename,
                        "contentType": attachment.mime_type,
                        "contentBytes": base64::engine::general_purpose::STANDARD.encode(&attachment.bytes),
                    }))
                    .collect::<Vec<_>>()
            ),
        );
    }

    let resp = client()
        .post(format!("{BASE}/sendMail"))
        .bearer_auth(token)
        .json(&json!({ "message": Value::Object(message), "saveToSentItems": true }))
        .send()
        .map_err(|e| e.to_string())?;
    json_or_error(resp)?;
    Ok(())
}

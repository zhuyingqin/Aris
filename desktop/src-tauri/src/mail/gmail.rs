//! Gmail API client (https://gmail.googleapis.com/gmail/v1). Translates Gmail's
//! label-centric model into the provider-neutral shapes in `model.rs`.
//! Read/modify/send all run live against the account, so any change is
//! immediately reflected in the Gmail web UI (the "1:1 with the web" goal),
//! except for web-only features Gmail does not expose over its API (e.g.
//! Snooze).

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};

use super::draft_attachment::{self, ResolvedDraftAttachment};
use super::model::{
    MailAttachment, MailDraft, MailFolder, MailMessageFull, MailMessageList, MailMessageSummary,
    MailModifyPatch,
};

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE: u32 = 25;

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
    let value: Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Gmail API error");
        return Err(format!("Gmail API {status}: {msg}"));
    }
    Ok(value)
}

/// Decode a Gmail base64url body part (padding optional).
fn decode_body(data: &str) -> String {
    let trimmed = data.trim_end_matches('=');
    URL_SAFE_NO_PAD
        .decode(trimmed)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn header<'a>(headers: &'a Value, name: &str) -> &'a str {
    headers
        .as_array()
        .and_then(|items| {
            items.iter().find(|h| {
                h.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
            })
        })
        .and_then(|h| h.get("value"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// Split `"Display Name <addr@host>"` into (display, address).
fn parse_address(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if let (Some(start), Some(end)) = (raw.rfind('<'), raw.rfind('>')) {
        if start < end {
            let addr = raw[start + 1..end].trim().to_string();
            let name = raw[..start].trim().trim_matches('"').trim().to_string();
            let name = if name.is_empty() { addr.clone() } else { name };
            return (name, addr);
        }
    }
    (raw.to_string(), raw.to_string())
}

pub fn identity(token: &str) -> Result<(String, String), String> {
    let profile = get(token, &format!("{BASE}/profile"))?;
    let email = profile
        .get("emailAddress")
        .and_then(Value::as_str)
        .ok_or_else(|| "Gmail profile missing emailAddress".to_string())?
        .to_string();
    Ok((email.clone(), email))
}

/// Well-known Gmail system labels surfaced as folders, with normalized kinds.
fn system_label_kind(id: &str) -> Option<&'static str> {
    Some(match id {
        "INBOX" => "inbox",
        "STARRED" => "starred",
        "SENT" => "sent",
        "DRAFT" => "drafts",
        "TRASH" => "trash",
        "SPAM" => "spam",
        "IMPORTANT" => "important",
        "CATEGORY_PROMOTIONS" => "promotions",
        "CATEGORY_SOCIAL" => "social",
        "CATEGORY_UPDATES" => "updates",
        "CATEGORY_FORUMS" => "forums",
        _ => return None,
    })
}

pub fn folders(token: &str) -> Result<Vec<MailFolder>, String> {
    let list = get(token, &format!("{BASE}/labels"))?;
    let empty = Vec::new();
    let labels = list
        .get("labels")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut folders = Vec::new();
    for label in labels {
        let id = label.get("id").and_then(Value::as_str).unwrap_or_default();
        let label_type = label.get("type").and_then(Value::as_str).unwrap_or("user");
        let kind = system_label_kind(id);
        // Skip noisy system labels we don't surface (UNREAD, CHAT, etc.).
        if label_type == "system" && kind.is_none() {
            continue;
        }
        // labels.list omits counts; fetch detail for an accurate unread badge.
        let detail = get(token, &format!("{BASE}/labels/{id}")).unwrap_or_else(|_| label.clone());
        let unread = detail
            .get("messagesUnread")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let name = detail
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        folders.push(MailFolder {
            id: id.to_string(),
            name,
            kind: kind.unwrap_or("custom").to_string(),
            unread_count: unread,
        });
    }
    Ok(folders)
}

pub fn list(
    token: &str,
    folder: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MailMessageList, String> {
    let mut url = format!("{BASE}/messages?maxResults={PAGE_SIZE}");
    if !folder.is_empty() {
        url.push_str(&format!("&labelIds={}", urlencoding::encode(folder)));
    }
    if !query.is_empty() {
        url.push_str(&format!("&q={}", urlencoding::encode(query)));
    }
    if let Some(token_value) = page_token {
        url.push_str(&format!("&pageToken={}", urlencoding::encode(token_value)));
    }
    let list = get(token, &url)?;
    let next_page_token = list
        .get("nextPageToken")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let empty = Vec::new();
    let refs = list
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut messages = Vec::new();
    for reference in refs {
        let Some(id) = reference.get("id").and_then(Value::as_str) else {
            continue;
        };
        let url = format!(
            "{BASE}/messages/{id}?format=metadata\
             &metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date"
        );
        let Ok(message) = get(token, &url) else {
            continue;
        };
        messages.push(summary_from(&message));
    }
    Ok(MailMessageList {
        messages,
        next_page_token,
    })
}

fn label_ids(message: &Value) -> Vec<String> {
    message
        .get("labelIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn summary_from(message: &Value) -> MailMessageSummary {
    let headers = message
        .get("payload")
        .and_then(|p| p.get("headers"))
        .cloned()
        .unwrap_or(Value::Null);
    let (from_name, from) = parse_address(header(&headers, "From"));
    let labels = label_ids(message);
    MailMessageSummary {
        id: message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thread_id: message
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        from,
        from_name,
        to: header(&headers, "To").to_string(),
        subject: header(&headers, "Subject").to_string(),
        snippet: message
            .get("snippet")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        date: header(&headers, "Date").to_string(),
        unread: labels.iter().any(|l| l == "UNREAD"),
        starred: labels.iter().any(|l| l == "STARRED"),
        has_attachments: message_has_attachments(message),
        labels,
    }
}

fn message_has_attachments(message: &Value) -> bool {
    fn walk(part: &Value) -> bool {
        let filename = part.get("filename").and_then(Value::as_str).unwrap_or("");
        if !filename.is_empty() {
            return true;
        }
        part.get("parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(walk))
    }
    message.get("payload").map(walk).unwrap_or(false)
}

pub fn read(token: &str, message_id: &str) -> Result<MailMessageFull, String> {
    let message = get(token, &format!("{BASE}/messages/{message_id}?format=full"))?;
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    let headers = payload.get("headers").cloned().unwrap_or(Value::Null);
    let (from_name, from) = parse_address(header(&headers, "From"));
    let labels = label_ids(&message);

    let mut body_html = None;
    let mut body_text = String::new();
    let mut attachments = Vec::new();
    collect_parts(&payload, &mut body_html, &mut body_text, &mut attachments);

    Ok(MailMessageFull {
        id: message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thread_id: message
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        from,
        from_name,
        to: header(&headers, "To").to_string(),
        cc: header(&headers, "Cc").to_string(),
        subject: header(&headers, "Subject").to_string(),
        date: header(&headers, "Date").to_string(),
        unread: labels.iter().any(|l| l == "UNREAD"),
        starred: labels.iter().any(|l| l == "STARRED"),
        labels,
        body_html,
        body_text,
        attachments,
    })
}

fn collect_parts(
    part: &Value,
    html: &mut Option<String>,
    text: &mut String,
    attachments: &mut Vec<MailAttachment>,
) {
    let mime = part.get("mimeType").and_then(Value::as_str).unwrap_or("");
    let filename = part.get("filename").and_then(Value::as_str).unwrap_or("");
    let body = part.get("body");

    if !filename.is_empty() {
        attachments.push(MailAttachment {
            id: body
                .and_then(|b| b.get("attachmentId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            filename: filename.to_string(),
            mime_type: mime.to_string(),
            size: body
                .and_then(|b| b.get("size"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        });
    } else if let Some(data) = body.and_then(|b| b.get("data")).and_then(Value::as_str) {
        let decoded = decode_body(data);
        if mime == "text/html" && html.is_none() {
            *html = Some(decoded);
        } else if mime == "text/plain" && text.is_empty() {
            *text = decoded;
        }
    }

    if let Some(parts) = part.get("parts").and_then(Value::as_array) {
        for child in parts {
            collect_parts(child, html, text, attachments);
        }
    }
}

pub fn modify(token: &str, message_id: &str, patch: &MailModifyPatch) -> Result<(), String> {
    // Trash is a dedicated endpoint.
    if patch.trash == Some(true) {
        let resp = client()
            .post(format!("{BASE}/messages/{message_id}/trash"))
            .bearer_auth(token)
            .send()
            .map_err(|e| e.to_string())?;
        json_or_error(resp)?;
        return Ok(());
    }

    let mut add: Vec<String> = Vec::new();
    let mut remove: Vec<String> = Vec::new();
    match patch.unread {
        Some(true) => add.push("UNREAD".into()),
        Some(false) => remove.push("UNREAD".into()),
        None => {}
    }
    match patch.starred {
        Some(true) => add.push("STARRED".into()),
        Some(false) => remove.push("STARRED".into()),
        None => {}
    }
    if patch.archive == Some(true) {
        remove.push("INBOX".into());
    }
    if let Some(target) = &patch.move_to {
        if !target.is_empty() {
            add.push(target.clone());
            remove.push("INBOX".into());
        }
    }
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }

    let resp = client()
        .post(format!("{BASE}/messages/{message_id}/modify"))
        .bearer_auth(token)
        .json(&json!({ "addLabelIds": add, "removeLabelIds": remove }))
        .send()
        .map_err(|e| e.to_string())?;
    json_or_error(resp)?;
    Ok(())
}

pub fn send(token: &str, draft: &MailDraft) -> Result<(), String> {
    let raw = build_rfc822(draft)?;
    let encoded = URL_SAFE_NO_PAD.encode(raw.as_bytes());
    let resp = client()
        .post(format!("{BASE}/messages/send"))
        .bearer_auth(token)
        .json(&json!({ "raw": encoded }))
        .send()
        .map_err(|e| e.to_string())?;
    json_or_error(resp)?;
    Ok(())
}

/// Build a minimal RFC822 message. Subject is RFC2047-encoded so non-ASCII
/// survives; the body is sent as UTF-8 base64 to avoid line-length issues.
fn build_rfc822(draft: &MailDraft) -> Result<String, String> {
    let attachments = draft_attachment::resolve_all(draft)?;
    let mut headers = format!("To: {}\r\n", draft.to);
    if !draft.cc.is_empty() {
        headers.push_str(&format!("Cc: {}\r\n", draft.cc));
    }
    if !draft.bcc.is_empty() {
        headers.push_str(&format!("Bcc: {}\r\n", draft.bcc));
    }
    headers.push_str(&format!(
        "Subject: =?UTF-8?B?{}?=\r\n",
        STANDARD.encode(draft.subject.as_bytes())
    ));
    headers.push_str("MIME-Version: 1.0\r\n");
    if attachments.is_empty() {
        headers.push_str("Content-Type: text/plain; charset=UTF-8\r\n");
        headers.push_str("Content-Transfer-Encoding: base64\r\n");
        headers.push_str("\r\n");
        let body = STANDARD.encode(draft.body.as_bytes());
        return Ok(format!("{headers}{body}"));
    }

    let boundary = "aris-mail-boundary-7b3c9a31";
    headers.push_str(&format!(
        "Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n"
    ));
    headers.push_str(&format!("--{boundary}\r\n"));
    headers.push_str("Content-Type: text/plain; charset=UTF-8\r\n");
    headers.push_str("Content-Transfer-Encoding: base64\r\n");
    headers.push_str("\r\n");
    headers.push_str(&wrap_base64(&STANDARD.encode(draft.body.as_bytes())));
    headers.push_str("\r\n");
    for attachment in attachments {
        append_attachment_part(&mut headers, boundary, &attachment);
    }
    headers.push_str(&format!("--{boundary}--\r\n"));
    Ok(headers)
}

fn append_attachment_part(
    message: &mut String,
    boundary: &str,
    attachment: &ResolvedDraftAttachment,
) {
    message.push_str(&format!("--{boundary}\r\n"));
    message.push_str(&format!(
        "Content-Type: {}; name=\"{}\"\r\n",
        attachment.mime_type,
        encoded_word(&attachment.filename)
    ));
    message.push_str("Content-Transfer-Encoding: base64\r\n");
    message.push_str(&format!(
        "Content-Disposition: attachment; filename=\"{}\"\r\n\r\n",
        encoded_word(&attachment.filename)
    ));
    message.push_str(&wrap_base64(&STANDARD.encode(&attachment.bytes)));
    message.push_str("\r\n");
}

fn encoded_word(value: &str) -> String {
    format!("=?UTF-8?B?{}?=", STANDARD.encode(value.as_bytes()))
}

fn wrap_base64(value: &str) -> String {
    value
        .as_bytes()
        .chunks(76)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("\r\n")
}

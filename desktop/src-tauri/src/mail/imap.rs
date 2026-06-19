//! Generic IMAP/SMTP backend implemented in Rust.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use native_tls::TlsConnector;
use serde_json::json;

use super::cache;
use super::model::{
    GenericMailAccountInput, GenericMailTestResult, IncomingServerConfig, MailAttachment,
    MailDraft, MailFolder, MailIdentityConfig, MailMessageFull, MailMessageList,
    MailMessageSummary, MailModifyPatch, MailSocketSecurity, OutgoingServerConfig, Provider,
};
use super::store;

trait MailIo: Read + Write {}
impl<T: Read + Write> MailIo for T {}

type BoxedStream = Box<dyn MailIo + Send>;

struct HelperConfig {
    incoming: IncomingServerConfig,
    outgoing: OutgoingServerConfig,
    identity: MailIdentityConfig,
}

struct ImapClient {
    reader: BufReader<BoxedStream>,
    next_tag: u32,
}

struct SmtpClient {
    reader: BufReader<BoxedStream>,
}

#[derive(Default)]
struct ParsedMessage {
    headers: HashMap<String, String>,
    body_html: Option<String>,
    body_text: String,
    attachments: Vec<MailAttachment>,
}

fn helper_config(account_id: &str) -> Result<HelperConfig, String> {
    let account = store::get_account(account_id)
        .ok_or_else(|| format!("mail account not found: {account_id}"))?;
    if account.provider != Provider::Imap {
        return Err(format!(
            "account `{account_id}` is not a generic IMAP account"
        ));
    }
    let incoming = store::get_incoming_server(&account.incoming_server_id)
        .ok_or_else(|| format!("incoming server not found: {}", account.incoming_server_id))?;
    let identity = store::get_identity(&account.identity_id)
        .ok_or_else(|| format!("mail identity not found: {}", account.identity_id))?;
    let outgoing = store::get_outgoing_server(&identity.outgoing_server_id).unwrap_or_else(|| {
        OutgoingServerConfig {
            id: identity.outgoing_server_id.clone(),
            kind: "smtp".to_string(),
            host: String::new(),
            port: 0,
            security: MailSocketSecurity::Tls,
            username: String::new(),
            password: String::new(),
            enabled: false,
        }
    });
    Ok(HelperConfig {
        incoming,
        outgoing,
        identity,
    })
}

fn helper_config_from_input(input: &GenericMailAccountInput) -> HelperConfig {
    let email = input.email.trim().to_string();
    let display_name = if input.display_name.trim().is_empty() {
        email.clone()
    } else {
        input.display_name.trim().to_string()
    };
    let incoming = IncomingServerConfig {
        id: "test_imap".to_string(),
        kind: "imap".to_string(),
        host: input.imap_host.trim().to_string(),
        port: input.imap_port,
        security: input.imap_security.clone(),
        username: input.imap_username.trim().to_string(),
        password: input.imap_password.clone(),
    };
    let outgoing = OutgoingServerConfig {
        id: "test_smtp".to_string(),
        kind: "smtp".to_string(),
        host: input.smtp_host.trim().to_string(),
        port: input.smtp_port,
        security: input.smtp_security.clone(),
        username: input.smtp_username.trim().to_string(),
        password: input.smtp_password.clone(),
        enabled: input.smtp_enabled,
    };
    let identity = MailIdentityConfig {
        id: "test_identity".to_string(),
        email,
        display_name,
        outgoing_server_id: outgoing.id.clone(),
    };
    HelperConfig {
        incoming,
        outgoing,
        identity,
    }
}

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let stream = TcpStream::connect((host, port))
        .map_err(|error| format!("could not connect to {host}:{port}: {error}"))?;
    let timeout = Some(Duration::from_secs(30));
    stream
        .set_read_timeout(timeout)
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(timeout)
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

fn tls_connector() -> Result<TlsConnector, String> {
    TlsConnector::new().map_err(|error| error.to_string())
}

fn tls_wrap(host: &str, stream: TcpStream) -> Result<BoxedStream, String> {
    let tls = tls_connector()?
        .connect(host, stream)
        .map_err(|error| format!("TLS handshake with {host} failed: {error}"))?;
    Ok(Box::new(tls))
}

fn read_line_from<R: Read + Write>(reader: &mut BufReader<R>) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    let count = reader
        .read_until(b'\n', &mut line)
        .map_err(|error| error.to_string())?;
    if count == 0 {
        return Err("connection closed by mail server".to_string());
    }
    Ok(line)
}

fn read_smtp_response_from<R: Read + Write>(
    reader: &mut BufReader<R>,
) -> Result<(u16, String), String> {
    let mut text = String::new();
    loop {
        let line = read_line_from(reader)?;
        let line_text = String::from_utf8_lossy(&line);
        text.push_str(&line_text);
        let bytes = line_text.as_bytes();
        if bytes.len() >= 4 && bytes[3] == b' ' {
            let code = line_text[..3]
                .parse::<u16>()
                .map_err(|error| error.to_string())?;
            return Ok((code, text));
        }
    }
}

fn smtp_send_raw<R: Read + Write>(
    reader: &mut BufReader<R>,
    command: &str,
) -> Result<(u16, String), String> {
    reader
        .get_mut()
        .write_all(command.as_bytes())
        .map_err(|error| error.to_string())?;
    reader
        .get_mut()
        .write_all(b"\r\n")
        .map_err(|error| error.to_string())?;
    reader
        .get_mut()
        .flush()
        .map_err(|error| error.to_string())?;
    read_smtp_response_from(reader)
}

fn smtp_expect_raw<R: Read + Write>(
    reader: &mut BufReader<R>,
    command: &str,
    ok: &[u16],
) -> Result<String, String> {
    let (code, response) = smtp_send_raw(reader, command)?;
    if ok.contains(&code) {
        Ok(response)
    } else {
        Err(format!("SMTP command failed ({code}): {}", response.trim()))
    }
}

fn literal_len(line: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(line);
    let end = text.trim_end().strip_suffix('}')?;
    let start = end.rfind('{')?;
    end[start + 1..].parse::<usize>().ok()
}

fn read_imap_response_from<R: Read + Write>(
    reader: &mut BufReader<R>,
    tag: &str,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line = read_line_from(reader)?;
        let line_text = String::from_utf8_lossy(&line).to_string();
        out.extend_from_slice(&line);
        if let Some(size) = literal_len(&line) {
            let mut literal = vec![0; size];
            reader
                .read_exact(&mut literal)
                .map_err(|error| error.to_string())?;
            out.extend_from_slice(&literal);
        }
        if line_text.starts_with(tag) {
            if tagged_ok(&line_text) {
                return Ok(out);
            }
            return Err(imap_error(&out));
        }
    }
}

fn tagged_ok(line: &str) -> bool {
    line.split_whitespace().nth(1) == Some("OK")
}

fn imap_error(response: &[u8]) -> String {
    let text = String::from_utf8_lossy(response);
    let final_line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text.trim());
    let lower = final_line.to_ascii_lowercase();
    if lower.contains("unsafe login") || lower.contains("kefu@188.com") {
        format!(
            "网易邮箱拒绝了本次 IMAP 访问：{final_line}. 请在 126/163/yeah/188 邮箱网页版设置中开启 IMAP/SMTP 服务，并使用“客户端授权码/应用专用密码”作为这里的密码，不要使用网页登录密码。如果已经使用授权码仍然失败，说明网易风控认为当前客户端或登录环境不安全，需要先完成网页端安全验证，或按服务器提示联系 kefu@188.com。"
        )
    } else if lower.contains("authenticate failed")
        || lower.contains("authenticationfailed")
        || lower.contains("login failed")
    {
        format!(
            "IMAP authentication failed: {final_line}. Gmail does not accept a normal Google password here; use Continue with Gmail or a Google app password with IMAP enabled. Outlook.com and Microsoft 365 require Modern Authentication/OAuth2, so use Continue with Outlook instead of this IMAP password path."
        )
    } else {
        format!("IMAP command failed: {final_line}")
    }
}

impl ImapClient {
    fn from_stream(stream: BoxedStream) -> Self {
        Self {
            reader: BufReader::new(stream),
            next_tag: 1,
        }
    }

    fn read_greeting(&mut self) -> Result<(), String> {
        let line = read_line_from(&mut self.reader)?;
        let text = String::from_utf8_lossy(&line);
        if text.starts_with("* OK") || text.starts_with("* PREAUTH") {
            Ok(())
        } else {
            Err(format!("unexpected IMAP greeting: {}", text.trim()))
        }
    }

    fn command(&mut self, command: &str) -> Result<Vec<u8>, String> {
        let tag = format!("A{:04}", self.next_tag);
        self.next_tag += 1;
        let wire = format!("{tag} {command}\r\n");
        self.reader
            .get_mut()
            .write_all(wire.as_bytes())
            .map_err(|error| error.to_string())?;
        self.reader
            .get_mut()
            .flush()
            .map_err(|error| error.to_string())?;
        read_imap_response_from(&mut self.reader, &tag)
    }

    fn login(&mut self, username: &str, password: &str) -> Result<(), String> {
        self.command(&format!(
            "LOGIN {} {}",
            imap_quote(username),
            imap_quote(password)
        ))?;
        Ok(())
    }

    fn identify(&mut self, address: &str) -> Result<(), String> {
        self.command(&imap_id_command(address))?;
        Ok(())
    }

    fn select(&mut self, folder: &str, readonly: bool) -> Result<(), String> {
        let command = if readonly { "EXAMINE" } else { "SELECT" };
        self.command(&format!("{command} {}", imap_quote(folder)))?;
        Ok(())
    }

    fn logout(&mut self) {
        let _ = self.command("LOGOUT");
    }
}

fn connect_imap(
    config: &HelperConfig,
    folder: Option<&str>,
    readonly: bool,
) -> Result<ImapClient, String> {
    let incoming = &config.incoming;
    let host = incoming.host.trim();
    let port = incoming.port;
    if host.is_empty() || port == 0 {
        return Err("IMAP host and port are required".to_string());
    }

    let mut client = match incoming.security {
        MailSocketSecurity::Tls => {
            let stream = tcp_connect(host, port)?;
            let mut client = ImapClient::from_stream(tls_wrap(host, stream)?);
            client.read_greeting()?;
            client
        }
        MailSocketSecurity::None => {
            let stream = tcp_connect(host, port)?;
            let mut client = ImapClient::from_stream(Box::new(stream));
            client.read_greeting()?;
            client
        }
        MailSocketSecurity::Starttls => {
            let stream = tcp_connect(host, port)?;
            let mut plain = BufReader::new(stream);
            let greeting = read_line_from(&mut plain)?;
            let greeting_text = String::from_utf8_lossy(&greeting);
            if !greeting_text.starts_with("* OK") && !greeting_text.starts_with("* PREAUTH") {
                return Err(format!(
                    "unexpected IMAP greeting: {}",
                    greeting_text.trim()
                ));
            }
            plain
                .get_mut()
                .write_all(b"A0001 STARTTLS\r\n")
                .map_err(|error| error.to_string())?;
            plain.get_mut().flush().map_err(|error| error.to_string())?;
            read_imap_response_from(&mut plain, "A0001")?;
            let stream = plain.into_inner();
            let mut client = ImapClient::from_stream(tls_wrap(host, stream)?);
            client.next_tag = 2;
            client
        }
    };
    if let Err(error) = client.identify(&config.identity.email) {
        eprintln!("mail imap: ID command failed ({error}); continuing without IMAP ID");
    }
    client.login(&incoming.username, &incoming.password)?;
    if let Some(folder) = folder {
        client.select(folder, readonly)?;
    }
    Ok(client)
}

fn imap_id_command(address: &str) -> String {
    let address = address.trim();
    let address = if address.is_empty() { "unknown" } else { address };
    format!(
        "ID (\"name\" {} \"version\" {} \"vendor\" {} \"address\" {})",
        imap_quote("ARIS Mail"),
        imap_quote(env!("CARGO_PKG_VERSION")),
        imap_quote("ARIS"),
        imap_quote(address),
    )
}

fn imap_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn mailbox_id(folder: &str, uid: &str) -> String {
    let raw = json!({ "folder": folder, "uid": uid }).to_string();
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

fn parse_message_id(message_id: &str) -> Result<(String, String), String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(message_id.as_bytes())
        .map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_slice(&decoded).map_err(|error| error.to_string())?;
    let folder = value
        .get("folder")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "message id is missing folder".to_string())?
        .to_string();
    let uid = value
        .get("uid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "message id is missing uid".to_string())?
        .to_string();
    Ok((folder, uid))
}

fn parse_list_name(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut end = None;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        if bytes[index] == b'"' && (index == 0 || bytes[index - 1] != b'\\') {
            end = Some(index);
            break;
        }
    }
    if let Some(end) = end {
        let mut start = end;
        while start > 0 {
            start -= 1;
            if bytes[start] == b'"' && (start == 0 || bytes[start - 1] != b'\\') {
                return Some(
                    line[start + 1..end]
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\"),
                );
            }
        }
    }
    line.split_whitespace()
        .last()
        .map(|value| value.trim_matches('"').to_string())
}

/// Decode an IMAP "modified UTF-7" mailbox name (RFC 3501 §5.1.3) into UTF-8.
/// Gmail encodes non-ASCII label names this way (e.g. `&XfJT0ZCuTvY-` →
/// Chinese). `&` opens a shifted run of modified BASE64 (`,` substitutes for
/// `/`), terminated by `-`; `&-` is a literal `&`. Only the *display* name is
/// decoded — the raw form stays the folder id so SELECT/STATUS keep working.
fn decode_imap_utf7(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != b'-' {
                end += 1;
            }
            if end == start {
                // "&-" => literal '&'
                out.push('&');
            } else {
                let normalized: String = input[start..end]
                    .chars()
                    .map(|ch| if ch == ',' { '/' } else { ch })
                    .collect();
                match STANDARD_NO_PAD.decode(normalized.as_bytes()) {
                    Ok(decoded) => {
                        let units: Vec<u16> = decoded
                            .chunks(2)
                            .filter(|chunk| chunk.len() == 2)
                            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                            .collect();
                        out.push_str(&String::from_utf16_lossy(&units));
                    }
                    Err(_) => {
                        // Leave undecodable runs verbatim rather than dropping them.
                        out.push('&');
                        out.push_str(&input[start..end]);
                    }
                }
            }
            i = if end < bytes.len() { end + 1 } else { end };
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn folder_kind(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower == "inbox" {
        "inbox"
    } else if lower.contains("sent") || lower.contains("已发送") {
        "sent"
    } else if lower.contains("draft") || lower.contains("草稿") {
        "drafts"
    } else if lower.contains("trash") || lower.contains("deleted") || lower.contains("已删除") {
        "trash"
    } else if lower.contains("spam") || lower.contains("junk") || lower.contains("垃圾") {
        "spam"
    } else if lower.contains("archive") || lower.contains("归档") {
        "archive"
    } else {
        "custom"
    }
    .to_string()
}

fn parse_unseen(response: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(response);
    text.split("UNSEEN")
        .nth(1)
        .and_then(|tail| {
            tail.split(|ch: char| !ch.is_ascii_digit())
                .find(|part| !part.is_empty())
        })
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn parse_search_uids(response: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(response);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("* SEARCH") {
            return rest
                .split_whitespace()
                .filter(|part| part.chars().all(|ch| ch.is_ascii_digit()))
                .map(str::to_string)
                .collect();
        }
    }
    Vec::new()
}

fn extract_flags(response: &[u8]) -> HashSet<String> {
    let text = String::from_utf8_lossy(response);
    let Some(start) = text.find("FLAGS (") else {
        return HashSet::new();
    };
    let rest = &text[start + "FLAGS (".len()..];
    let Some(end) = rest.find(')') else {
        return HashSet::new();
    };
    rest[..end].split_whitespace().map(str::to_string).collect()
}

fn extract_first_literal(response: &[u8]) -> Option<Vec<u8>> {
    let mut index = 0;
    while index < response.len() {
        let line_end = response[index..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|position| index + position + 2)?;
        let line = &response[index..line_end];
        if let Some(size) = literal_len(line) {
            let start = line_end;
            let end = start.checked_add(size)?;
            if end <= response.len() {
                return Some(response[start..end].to_vec());
            }
            return None;
        }
        index = line_end;
    }
    None
}

fn fetch_message(
    client: &mut ImapClient,
    uid: &str,
    peek: bool,
) -> Result<(HashSet<String>, Vec<u8>), String> {
    let item = if peek { "BODY.PEEK[]" } else { "RFC822" };
    let response = client.command(&format!("UID FETCH {uid} (FLAGS {item})"))?;
    let flags = extract_flags(&response);
    let raw = extract_first_literal(&response)
        .ok_or_else(|| format!("could not fetch message uid {uid}"))?;
    Ok((flags, raw))
}

fn parse_headers(raw: &[u8]) -> (HashMap<String, String>, Vec<u8>) {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (position, 4))
        .or_else(|| {
            raw.windows(2)
                .position(|window| window == b"\n\n")
                .map(|position| (position, 2))
        });
    let (head, body) = if let Some((position, sep_len)) = split {
        (&raw[..position], &raw[position + sep_len..])
    } else {
        (raw, &[][..])
    };
    let text = String::from_utf8_lossy(head);
    let mut unfolded: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = unfolded.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
        } else {
            unfolded.push(line.trim_end().to_string());
        }
    }
    let mut headers = HashMap::new();
    for line in unfolded {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(
                key.trim().to_ascii_lowercase(),
                decode_header_value(value.trim()),
            );
        }
    }
    (headers, body.to_vec())
}

fn decode_header_value(value: &str) -> String {
    // Minimal RFC 2047 support for common UTF-8/base64 encoded subjects.
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(charset_end) = after.find('?') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let charset = &after[..charset_end];
        let after_charset = &after[charset_end + 1..];
        let Some(encoding_end) = after_charset.find('?') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let encoding = &after_charset[..encoding_end];
        let after_encoding = &after_charset[encoding_end + 1..];
        let Some(encoded_end) = after_encoding.find("?=") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let encoded = &after_encoding[..encoded_end];
        let decoded = if encoding.eq_ignore_ascii_case("B") {
            STANDARD
                .decode(encoded.as_bytes())
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        } else if encoding.eq_ignore_ascii_case("Q") {
            Some(decode_rfc2047_q(encoded))
        } else {
            None
        };
        if charset.eq_ignore_ascii_case("utf-8") || charset.eq_ignore_ascii_case("us-ascii") {
            out.push_str(decoded.as_deref().unwrap_or(encoded));
        } else {
            out.push_str(decoded.as_deref().unwrap_or(encoded));
        }
        rest = &after_encoding[encoded_end + 2..];
    }
    out.push_str(rest);
    out
}

fn decode_rfc2047_q(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'_' {
            out.push(b' ');
            index += 1;
        } else if bytes[index] == b'=' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(hex);
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header_params(value: &str) -> (String, HashMap<String, String>) {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_quote => {
                escaped = true;
                current.push(ch);
            }
            '"' => {
                in_quote = !in_quote;
                current.push(ch);
            }
            ';' if !in_quote => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    let media_type = parts
        .first()
        .map(|part| part.to_ascii_lowercase())
        .unwrap_or_else(|| "text/plain".to_string());
    let mut params = HashMap::new();
    for part in parts.into_iter().skip(1) {
        if let Some((key, value)) = part.split_once('=') {
            params.insert(
                key.trim().to_ascii_lowercase(),
                value.trim().trim_matches('"').replace("\\\"", "\""),
            );
        }
    }
    (media_type, params)
}

fn decode_quoted_printable(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'=' {
            out.push(input[index]);
            index += 1;
            continue;
        }
        if index + 1 < input.len() && input[index + 1] == b'\n' {
            index += 2;
        } else if index + 2 < input.len() && input[index + 1] == b'\r' && input[index + 2] == b'\n'
        {
            index += 3;
        } else if index + 2 < input.len() {
            let hex = &input[index + 1..index + 3];
            let hex_text = String::from_utf8_lossy(hex);
            if let Ok(byte) = u8::from_str_radix(&hex_text, 16) {
                out.push(byte);
                index += 3;
            } else {
                out.push(input[index]);
                index += 1;
            }
        } else {
            out.push(input[index]);
            index += 1;
        }
    }
    out
}

fn decode_transfer_body(headers: &HashMap<String, String>, body: &[u8]) -> Vec<u8> {
    let encoding = headers
        .get("content-transfer-encoding")
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if encoding == "base64" {
        let mut compact: Vec<u8> = body
            .iter()
            .copied()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect();
        while compact.len() % 4 != 0 {
            compact.push(b'=');
        }
        STANDARD.decode(&compact).unwrap_or_else(|_| body.to_vec())
    } else if encoding == "quoted-printable" {
        decode_quoted_printable(body)
    } else {
        body.to_vec()
    }
}

fn decode_text_body(headers: &HashMap<String, String>, body: &[u8]) -> String {
    let decoded = decode_transfer_body(headers, body);
    String::from_utf8_lossy(&decoded).into_owned()
}

fn multipart_sections(body: &[u8], boundary: &str) -> Vec<Vec<u8>> {
    let text = String::from_utf8_lossy(body);
    let marker = format!("--{boundary}");
    let close_marker = format!("--{boundary}--");
    let mut sections = Vec::new();
    let mut current = Vec::new();
    let mut in_part = false;

    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == marker || trimmed == close_marker {
            if in_part && !current.is_empty() {
                sections.push(std::mem::take(&mut current));
            }
            if trimmed == close_marker {
                break;
            }
            in_part = true;
        } else if in_part {
            current.extend_from_slice(line.as_bytes());
        }
    }
    if in_part && !current.is_empty() {
        sections.push(current);
    }
    sections
}

fn collect_mime_bodies(
    headers: &HashMap<String, String>,
    body: &[u8],
    html: &mut Option<String>,
    text: &mut Option<String>,
) {
    let content_type = headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("text/plain");
    let (media_type, params) = header_params(content_type);

    if media_type.starts_with("multipart/") {
        if let Some(boundary) = params.get("boundary") {
            for section in multipart_sections(body, boundary) {
                let (child_headers, child_body) = parse_headers(&section);
                collect_mime_bodies(&child_headers, &child_body, html, text);
            }
        }
        return;
    }

    if media_type == "text/html" {
        if html.is_none() {
            *html = Some(decode_text_body(headers, body));
        }
    } else if (media_type == "text/plain" || media_type.is_empty()) && text.is_none() {
        *text = Some(decode_text_body(headers, body));
    }
}

fn parse_message(raw: &[u8]) -> ParsedMessage {
    let (headers, body) = parse_headers(raw);
    let raw_text = String::from_utf8_lossy(raw).to_ascii_lowercase();
    let attachments =
        if raw_text.contains("content-disposition: attachment") || raw_text.contains("filename=") {
            vec![MailAttachment {
                id: "attachment".to_string(),
                filename: "attachment".to_string(),
                mime_type: "application/octet-stream".to_string(),
                size: 0,
            }]
        } else {
            Vec::new()
        };
    let mut body_html = None;
    let mut body_text = None;
    collect_mime_bodies(&headers, &body, &mut body_html, &mut body_text);
    let body_text = body_text
        .or_else(|| body_html.as_deref().map(strip_html))
        .unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned());
    ParsedMessage {
        headers,
        body_html,
        body_text,
        attachments,
    }
}

fn header<'a>(message: &'a ParsedMessage, name: &str) -> &'a str {
    message
        .headers
        .get(&name.to_ascii_lowercase())
        .map(String::as_str)
        .unwrap_or("")
}

fn address_parts(raw: &str) -> (String, String) {
    if let Some(start) = raw.rfind('<') {
        if let Some(end) = raw[start..].find('>') {
            let name = raw[..start].trim().trim_matches('"').to_string();
            let addr = raw[start + 1..start + end].trim().to_string();
            return (name, addr);
        }
    }
    (String::new(), raw.trim().to_string())
}

fn strip_html(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn snippet(value: &str) -> String {
    strip_html(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn summary_from(
    folder: &str,
    uid: &str,
    flags: &HashSet<String>,
    raw: &[u8],
) -> MailMessageSummary {
    let parsed = parse_message(raw);
    let from_raw = header(&parsed, "from");
    let (from_name, from_addr) = address_parts(from_raw);
    MailMessageSummary {
        id: mailbox_id(folder, uid),
        thread_id: header(&parsed, "message-id").to_string(),
        from: from_addr,
        from_name,
        to: header(&parsed, "to").to_string(),
        subject: header(&parsed, "subject").to_string(),
        snippet: snippet(&parsed.body_text),
        date: header(&parsed, "date").to_string(),
        unread: !flags.contains("\\Seen"),
        starred: flags.contains("\\Flagged"),
        has_attachments: !parsed.attachments.is_empty(),
        labels: flags.iter().cloned().collect(),
    }
}

fn full_from(folder: &str, uid: &str, flags: &HashSet<String>, raw: &[u8]) -> MailMessageFull {
    let parsed = parse_message(raw);
    let summary = summary_from(folder, uid, flags, raw);
    MailMessageFull {
        id: summary.id,
        thread_id: summary.thread_id,
        from: summary.from,
        from_name: summary.from_name,
        to: summary.to,
        cc: header(&parsed, "cc").to_string(),
        subject: summary.subject,
        date: summary.date,
        unread: summary.unread,
        starred: summary.starred,
        labels: summary.labels,
        body_html: parsed.body_html,
        body_text: parsed.body_text,
        attachments: parsed.attachments,
    }
}

fn find_folder(config: &HelperConfig, wanted: &str) -> Option<String> {
    folders_from_config(config)
        .ok()?
        .into_iter()
        .find(|folder| folder.kind == wanted || folder.name.to_ascii_lowercase().contains(wanted))
        .map(|folder| folder.id)
}

fn folders_from_config(config: &HelperConfig) -> Result<Vec<MailFolder>, String> {
    let mut client = connect_imap(config, None, true)?;
    let response = client.command("LIST \"\" \"*\"")?;
    let text = String::from_utf8_lossy(&response);
    let mut folders = Vec::new();
    for line in text.lines().filter(|line| line.starts_with("* LIST")) {
        // `\Noselect` containers (e.g. Gmail's `[Gmail]` parent) can't be opened;
        // listing them lets the UI SELECT a folder the server will reject.
        if line.to_ascii_lowercase().contains("\\noselect") {
            continue;
        }
        if let Some(name) = parse_list_name(line) {
            // `name` is the raw wire form (modified UTF-7), needed for IMAP
            // commands; `display` is the decoded human label for the UI.
            let display = decode_imap_utf7(&name);
            let lower = display.to_ascii_lowercase();
            // STATUS UNSEEN on Gmail's "All Mail" scans the whole account and is
            // very slow; skip the badge there — it isn't meaningful anyway.
            let unread_count = if lower.contains("all mail") || lower.contains("所有邮件") {
                0
            } else {
                let status = client
                    .command(&format!("STATUS {} (UNSEEN)", imap_quote(&name)))
                    .unwrap_or_default();
                parse_unseen(&status)
            };
            folders.push(MailFolder {
                id: name,
                name: display.clone(),
                kind: folder_kind(&display),
                unread_count,
            });
        }
    }
    client.logout();
    folders.sort_by_key(|folder| {
        (
            if folder.kind == "inbox" { 0 } else { 1 },
            folder.name.to_ascii_lowercase(),
        )
    });
    Ok(folders)
}

impl SmtpClient {
    fn from_stream(stream: BoxedStream) -> Self {
        Self {
            reader: BufReader::new(stream),
        }
    }

    fn read_response(&mut self) -> Result<(u16, String), String> {
        read_smtp_response_from(&mut self.reader)
    }

    fn send(&mut self, command: &str) -> Result<(u16, String), String> {
        smtp_send_raw(&mut self.reader, command)
    }

    fn expect(&mut self, command: &str, ok: &[u16]) -> Result<String, String> {
        let (code, response) = self.send(command)?;
        if ok.contains(&code) {
            Ok(response)
        } else {
            Err(format!("SMTP command failed ({code}): {}", response.trim()))
        }
    }

    fn auth(&mut self, username: &str, password: &str) -> Result<(), String> {
        let auth = STANDARD.encode(format!("\0{username}\0{password}").as_bytes());
        let (code, response) = self.send(&format!("AUTH PLAIN {auth}"))?;
        if code == 235 {
            return Ok(());
        }
        if should_try_smtp_login(code, &response) {
            return self.auth_login(username, password);
        }
        Err(smtp_auth_error("SMTP authentication failed", &response))
    }

    fn auth_login(&mut self, username: &str, password: &str) -> Result<(), String> {
        let (code, response) = self.send("AUTH LOGIN")?;
        if code != 334 {
            return Err(smtp_auth_error(
                "SMTP AUTH LOGIN was not accepted",
                &response,
            ));
        }
        let (code, response) = self.send(&STANDARD.encode(username.as_bytes()))?;
        if code != 334 {
            return Err(smtp_auth_error("SMTP username was not accepted", &response));
        }
        let (code, response) = self.send(&STANDARD.encode(password.as_bytes()))?;
        if code == 235 {
            return Ok(());
        }
        Err(smtp_auth_error("SMTP authentication failed", &response))
    }

    fn quit(&mut self) {
        let _ = self.send("QUIT");
    }
}

fn should_try_smtp_login(code: u16, response: &str) -> bool {
    let lower = response.to_ascii_lowercase();
    code == 504
        || lower.contains("unrecognized authentication type")
        || lower.contains("auth plain")
        || lower.contains("not supported")
}

fn smtp_auth_error(prefix: &str, response: &str) -> String {
    let trimmed = response.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("basic authentication is disabled") || lower.contains("5.7.139") {
        return format!(
            "{prefix}: {trimmed}. Gmail needs a Google app password when using SMTP password auth. Outlook.com/Microsoft 365 requires OAuth2/Modern Auth; use Continue with Outlook instead."
        );
    }
    if lower.contains("authentication") || lower.contains("5.7.") {
        return format!(
            "{prefix}: {trimmed}. Gmail needs a Google app password when using SMTP password auth. Outlook.com/Microsoft 365 requires Modern Authentication/OAuth2 for SMTP access."
        );
    }
    format!("{prefix}: {trimmed}")
}

fn connect_smtp(config: &HelperConfig) -> Result<SmtpClient, String> {
    let outgoing = &config.outgoing;
    if !outgoing.enabled {
        return Err("SMTP is not enabled for this account".to_string());
    }
    let host = outgoing.host.trim();
    let port = outgoing.port;
    if host.is_empty() || port == 0 {
        return Err("SMTP host and port are required".to_string());
    }
    let mut client = match outgoing.security {
        MailSocketSecurity::Tls => {
            let stream = tcp_connect(host, port)?;
            let mut client = SmtpClient::from_stream(tls_wrap(host, stream)?);
            let (code, response) = client.read_response()?;
            if code != 220 {
                return Err(format!(
                    "unexpected SMTP greeting ({code}): {}",
                    response.trim()
                ));
            }
            client
        }
        MailSocketSecurity::None => {
            let stream = tcp_connect(host, port)?;
            let mut client = SmtpClient::from_stream(Box::new(stream));
            let (code, response) = client.read_response()?;
            if code != 220 {
                return Err(format!(
                    "unexpected SMTP greeting ({code}): {}",
                    response.trim()
                ));
            }
            client
        }
        MailSocketSecurity::Starttls => {
            let stream = tcp_connect(host, port)?;
            let mut plain = BufReader::new(stream);
            let (code, response) = read_smtp_response_from(&mut plain)?;
            if code != 220 {
                return Err(format!(
                    "unexpected SMTP greeting ({code}): {}",
                    response.trim()
                ));
            }
            smtp_expect_raw(&mut plain, "EHLO aris.local", &[250])?;
            smtp_expect_raw(&mut plain, "STARTTLS", &[220])?;
            let stream = plain.into_inner();
            let mut client = SmtpClient::from_stream(tls_wrap(host, stream)?);
            client.expect("EHLO aris.local", &[250])?;
            client
        }
    };
    if outgoing.security != MailSocketSecurity::Starttls {
        client.expect("EHLO aris.local", &[250])?;
    }
    let username = if outgoing.username.trim().is_empty() {
        config.incoming.username.trim()
    } else {
        outgoing.username.trim()
    };
    let password = if outgoing.password.is_empty() {
        config.incoming.password.as_str()
    } else {
        outgoing.password.as_str()
    };
    if !username.is_empty() {
        client.auth(username, password)?;
    }
    Ok(client)
}

pub fn test_input(input: &GenericMailAccountInput) -> Result<GenericMailTestResult, String> {
    if let Some(message) = unsupported_password_auth_message(input) {
        return Ok(GenericMailTestResult {
            ok: false,
            imap_ok: false,
            smtp_ok: false,
            message,
        });
    }
    let config = helper_config_from_input(input);
    let mut imap_ok = false;
    let mut smtp_ok = false;
    let mut messages = Vec::new();

    match connect_imap(&config, None, true) {
        Ok(mut client) => {
            client.logout();
            imap_ok = true;
            messages.push("IMAP OK".to_string());
        }
        Err(error) => messages.push(format!("IMAP failed: {error}")),
    }

    if config.outgoing.enabled {
        match connect_smtp(&config) {
            Ok(mut client) => {
                client.quit();
                smtp_ok = true;
                messages.push("SMTP OK".to_string());
            }
            Err(error) => messages.push(format!("SMTP failed: {error}")),
        }
    } else {
        messages.push("SMTP disabled".to_string());
    }

    Ok(GenericMailTestResult {
        ok: imap_ok && (smtp_ok || !config.outgoing.enabled),
        imap_ok,
        smtp_ok,
        message: messages.join("; "),
    })
}

fn unsupported_password_auth_message(input: &GenericMailAccountInput) -> Option<String> {
    if uses_microsoft_password_endpoint(input) {
        return Some(
            "Outlook.com/Microsoft 365 accounts cannot use this generic IMAP/SMTP password path. Microsoft requires Modern Authentication/OAuth2 for IMAP/SMTP/Graph access; use Continue with Outlook in Mail settings."
                .to_string(),
        );
    }
    None
}

fn uses_microsoft_password_endpoint(input: &GenericMailAccountInput) -> bool {
    let domain = input
        .email
        .trim()
        .rsplit_once('@')
        .map(|(_, domain)| domain.trim().to_ascii_lowercase());
    let microsoft_domain = domain.as_deref().is_some_and(|domain| {
        matches!(
            domain,
            "outlook.com" | "hotmail.com" | "live.com" | "msn.com"
        ) || domain.ends_with(".onmicrosoft.com")
    });
    microsoft_domain
        || host_is_microsoft_mail(&input.imap_host)
        || (input.smtp_enabled && host_is_microsoft_mail(&input.smtp_host))
}

fn host_is_microsoft_mail(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    matches!(
        host.as_str(),
        "outlook.office365.com"
            | "smtp.office365.com"
            | "imap-mail.outlook.com"
            | "smtp-mail.outlook.com"
            | "imap.outlook.com"
            | "smtp.outlook.com"
    )
}

pub fn folders(account_id: &str) -> Result<Vec<MailFolder>, String> {
    let config = helper_config(account_id)?;
    folders_from_config(&config)
}

const PAGE_LIMIT: usize = 25;
fn parse_uidvalidity(response: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(response);
    text.split("UIDVALIDITY")
        .nth(1)
        .and_then(|tail| {
            tail.split(|ch: char| !ch.is_ascii_digit())
                .find(|part| !part.is_empty())
        })
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn search_uids_u32(response: &[u8]) -> Vec<u32> {
    parse_search_uids(response)
        .iter()
        .filter_map(|uid| uid.parse::<u32>().ok())
        .collect()
}

fn extract_uid(line: &str) -> Option<u32> {
    let idx = line.find("UID ")?;
    line[idx + 4..]
        .split(|ch: char| !ch.is_ascii_digit())
        .find(|part| !part.is_empty())
        .and_then(|value| value.parse::<u32>().ok())
}

fn next_crlf(buf: &[u8], from: usize) -> Option<usize> {
    buf[from..]
        .windows(2)
        .position(|window| window == b"\r\n")
        .map(|pos| from + pos + 2)
}

/// Split a batched `UID FETCH` response into one `(uid, flags, raw)` tuple per
/// message. A single FETCH record may carry *several* literals (e.g. a
/// `HEADER.FIELDS` section plus a `TEXT` slice); all of a record's literals are
/// concatenated into `raw` so header parsing + snippet both work. `raw` is empty
/// for flags-only fetches.
fn parse_fetch_batch(response: &[u8]) -> Vec<(u32, HashSet<String>, Vec<u8>)> {
    let mut records: Vec<(Option<u32>, HashSet<String>, Vec<u8>)> = Vec::new();
    let mut index = 0;
    while index < response.len() {
        let Some(line_end) = next_crlf(response, index) else {
            break;
        };
        let line = &response[index..line_end];
        let line_text = String::from_utf8_lossy(line);
        if line_text.starts_with("* ") && line_text.contains(" FETCH ") {
            records.push((extract_uid(&line_text), extract_flags(line), Vec::new()));
        }
        index = line_end;
        // A literal announced on this line belongs to the current record; its
        // bytes are content, not response grammar, so skip past them.
        if let Some(size) = literal_len(line) {
            let end = (index + size).min(response.len());
            if let Some(record) = records.last_mut() {
                record.2.extend_from_slice(&response[index..end]);
            }
            index = end;
        }
    }
    records
        .into_iter()
        .filter_map(|(uid, flags, raw)| uid.map(|uid| (uid, flags, raw)))
        .collect()
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Fetch list-row summaries for the given UIDs in a single round trip.
fn fetch_summaries_batch(
    client: &mut ImapClient,
    folder: &str,
    uids: &[u32],
) -> Result<Vec<(u32, MailMessageSummary)>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    // Fetch only the headers we render. Pulling a BODY[TEXT] slice here is
    // tempting for snippets, but IMAP servers are free to return FETCH sections
    // in an order that does not match the request; concatenating header and body
    // literals can make body/MIME fragments look like subjects in the list.
    let response = client.command(&format!(
        "UID FETCH {} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE CONTENT-TYPE)])",
        uid_set(uids)
    ))?;
    Ok(parse_fetch_batch(&response)
        .into_iter()
        .map(|(uid, flags, raw)| (uid, summary_from(folder, &uid.to_string(), &flags, &raw)))
        .collect())
}

/// Fetch just FLAGS for the given UIDs (one round trip) so unread/star state on
/// cached rows reflects the server.
fn fetch_flags_batch(
    client: &mut ImapClient,
    uids: &[u32],
) -> Result<HashMap<u32, (bool, bool)>, String> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    let response = client.command(&format!("UID FETCH {} (FLAGS)", uid_set(uids)))?;
    Ok(parse_fetch_batch(&response)
        .into_iter()
        .map(|(uid, flags, _)| {
            (
                uid,
                (!flags.contains("\\Seen"), flags.contains("\\Flagged")),
            )
        })
        .collect())
}

/// Direct (uncached) listing — used for search queries and as a fallback when
/// the incremental cache path fails. Batched, light fetch.
fn list_uncached(
    config: &HelperConfig,
    folder: &str,
    query: &str,
    offset: usize,
    limit: usize,
) -> Result<MailMessageList, String> {
    let mut client = connect_imap(config, Some(folder), true)?;
    let search = if query.trim().is_empty() {
        "UID SEARCH ALL".to_string()
    } else {
        format!("UID SEARCH TEXT {}", imap_quote(query.trim()))
    };
    let response = client.command(&search)?;
    let mut uids = search_uids_u32(&response);
    uids.sort_unstable();
    let total = uids.len();
    let page: Vec<u32> = uids
        .iter()
        .rev()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();
    let fetched: HashMap<u32, MailMessageSummary> =
        fetch_summaries_batch(&mut client, folder, &page)?
            .into_iter()
            .collect();
    client.logout();
    let messages = page
        .iter()
        .filter_map(|uid| fetched.get(uid).cloned())
        .collect();
    let next_offset = offset + page.len();
    Ok(MailMessageList {
        messages,
        next_page_token: if next_offset < total {
            Some(next_offset.to_string())
        } else {
            None
        },
    })
}

/// Incremental, cache-backed listing for a normal (non-search) folder view.
/// Reads the on-disk sparse cache, fetches only the page UIDs it is missing,
/// refreshes flags for the visible page, then persists. A warm reopen therefore
/// does no body fetches — only EXAMINE + UID SEARCH + a flags refresh.
fn list_cached(
    account_id: &str,
    config: &HelperConfig,
    folder: &str,
    offset: usize,
    limit: usize,
) -> Result<MailMessageList, String> {
    let mut client = connect_imap(config, None, true)?;
    let examine = client.command(&format!("EXAMINE {}", imap_quote(folder)))?;
    let uid_validity = parse_uidvalidity(&examine);

    let mut cache = cache::load(account_id, folder).unwrap_or_default();
    if cache.uid_validity != uid_validity {
        cache.uid_validity = uid_validity;
        cache.messages.clear();
    }
    let mut by_uid: HashMap<u32, MailMessageSummary> = cache
        .messages
        .iter()
        .map(|entry| (entry.uid, entry.summary.clone()))
        .collect();

    let response = client.command("UID SEARCH ALL")?;
    let mut uids = search_uids_u32(&response);
    uids.sort_unstable();
    let total = uids.len();
    let page: Vec<u32> = uids
        .iter()
        .rev()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();

    let missing: Vec<u32> = page
        .iter()
        .filter(|uid| !by_uid.contains_key(uid))
        .cloned()
        .collect();
    for (uid, summary) in fetch_summaries_batch(&mut client, folder, &missing)? {
        by_uid.insert(uid, summary);
    }
    for (uid, (unread, starred)) in fetch_flags_batch(&mut client, &page)? {
        if let Some(summary) = by_uid.get_mut(&uid) {
            summary.unread = unread;
            summary.starred = starred;
        }
    }
    client.logout();

    // Persist the sparse cache, pruning UIDs the server no longer reports.
    let present: HashSet<u32> = uids.iter().cloned().collect();
    cache.messages = by_uid
        .iter()
        .filter(|(uid, _)| present.contains(uid))
        .map(|(uid, summary)| cache::CachedMessage {
            uid: *uid,
            summary: summary.clone(),
        })
        .collect();
    let _ = cache::save(account_id, folder, &cache);

    let messages = page
        .iter()
        .filter_map(|uid| by_uid.get(uid).cloned())
        .collect();
    let next_offset = offset + page.len();
    Ok(MailMessageList {
        messages,
        next_page_token: if next_offset < total {
            Some(next_offset.to_string())
        } else {
            None
        },
    })
}

pub fn list(
    account_id: &str,
    folder: &str,
    query: &str,
    page_token: Option<&str>,
) -> Result<MailMessageList, String> {
    let config = helper_config(account_id)?;
    let offset = page_token
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    // The chat `mail_search` tool may omit the folder; default to the inbox so
    // an empty selector doesn't turn into `EXAMINE ""`.
    let folder = if folder.trim().is_empty() {
        "INBOX"
    } else {
        folder
    };

    // Search results are dynamic; don't cache them.
    if !query.trim().is_empty() {
        return list_uncached(&config, folder, query, offset, PAGE_LIMIT);
    }

    match list_cached(account_id, &config, folder, offset, PAGE_LIMIT) {
        Ok(list) => Ok(list),
        Err(error) => {
            eprintln!("mail imap: cached list failed ({error}); falling back to direct fetch");
            list_uncached(&config, folder, "", offset, PAGE_LIMIT)
        }
    }
}

pub fn read(account_id: &str, message_id: &str) -> Result<MailMessageFull, String> {
    let config = helper_config(account_id)?;
    let (folder, uid) = parse_message_id(message_id)?;
    let mut client = connect_imap(&config, Some(&folder), true)?;
    let (flags, raw) = fetch_message(&mut client, &uid, false)?;
    client.logout();
    Ok(full_from(&folder, &uid, &flags, &raw))
}

pub fn modify(account_id: &str, message_id: &str, patch: &MailModifyPatch) -> Result<(), String> {
    let config = helper_config(account_id)?;
    let (folder, uid) = parse_message_id(message_id)?;
    let mut client = connect_imap(&config, Some(&folder), false)?;
    if let Some(unread) = patch.unread {
        client.command(&format!(
            "UID STORE {uid} {}FLAGS (\\Seen)",
            if unread { "-" } else { "+" }
        ))?;
    }
    if let Some(starred) = patch.starred {
        client.command(&format!(
            "UID STORE {uid} {}FLAGS (\\Flagged)",
            if starred { "+" } else { "-" }
        ))?;
    }
    let destination = if patch.trash == Some(true) {
        find_folder(&config, "trash")
    } else if patch.archive == Some(true) {
        find_folder(&config, "archive")
    } else {
        patch.move_to.clone()
    };
    if let Some(destination) = destination {
        client.command(&format!("UID COPY {uid} {}", imap_quote(&destination)))?;
        client.command(&format!("UID STORE {uid} +FLAGS (\\Deleted)"))?;
        let _ = client.command("EXPUNGE");
    }
    client.logout();
    Ok(())
}

pub fn send(account_id: &str, draft: &MailDraft) -> Result<(), String> {
    let config = helper_config(account_id)?;
    let mut client = connect_smtp(&config)?;
    let from = config.identity.email.as_str();
    client.expect(&format!("MAIL FROM:<{from}>"), &[250])?;
    for recipient in recipients(draft) {
        client.expect(&format!("RCPT TO:<{recipient}>"), &[250, 251])?;
    }
    client.expect("DATA", &[354])?;
    let body = build_message(&config.identity, draft);
    client
        .reader
        .get_mut()
        .write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    client
        .reader
        .get_mut()
        .write_all(b"\r\n.\r\n")
        .map_err(|error| error.to_string())?;
    client
        .reader
        .get_mut()
        .flush()
        .map_err(|error| error.to_string())?;
    let (code, response) = client.read_response()?;
    if code != 250 {
        return Err(format!("SMTP send failed ({code}): {}", response.trim()));
    }
    client.quit();
    Ok(())
}

fn recipients(draft: &MailDraft) -> Vec<String> {
    [&draft.to, &draft.cc, &draft.bcc]
        .into_iter()
        .flat_map(|field| field.split(','))
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else if let Some(start) = value.rfind('<') {
                value[start + 1..]
                    .find('>')
                    .map(|end| value[start + 1..start + 1 + end].trim().to_string())
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

fn build_message(identity: &MailIdentityConfig, draft: &MailDraft) -> String {
    let mut message = String::new();
    message.push_str(&format!(
        "From: {} <{}>\r\n",
        identity.display_name, identity.email
    ));
    message.push_str(&format!("To: {}\r\n", draft.to));
    if !draft.cc.trim().is_empty() {
        message.push_str(&format!("Cc: {}\r\n", draft.cc));
    }
    message.push_str(&format!(
        "Subject: {}\r\n",
        draft.subject.replace('\r', "").replace('\n', " ")
    ));
    message.push_str("MIME-Version: 1.0\r\n");
    message.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    message.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
    message.push_str(&draft.body.replace("\r\n", "\n").replace('\n', "\r\n"));
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imap_error_explains_netease_unsafe_login() {
        let message = imap_error(
            b"* BYE\r\nA0002 NO EXAMINE Unsafe Login. Please contact kefu@188.com for help\r\n",
        );

        assert!(message.contains("网易邮箱拒绝"));
        assert!(message.contains("IMAP/SMTP"));
        assert!(message.contains("授权码"));
        assert!(message.contains("kefu@188.com"));
    }

    #[test]
    fn imap_id_command_includes_client_identity() {
        let command = imap_id_command("owner@example.com");

        assert!(command.contains("\"name\" \"ARIS Mail\""));
        assert!(command.contains(&format!("\"version\" \"{}\"", env!("CARGO_PKG_VERSION"))));
        assert!(command.contains("\"vendor\" \"ARIS\""));
        assert!(command.contains("\"address\" \"owner@example.com\""));
    }

    #[test]
    fn imap_id_command_quotes_contact_address() {
        let command = imap_id_command("owner\"ops@example.com");

        assert!(command.contains("\"address\" \"owner\\\"ops@example.com\""));
    }

    #[test]
    fn parse_uidvalidity_reads_bracketed_value() {
        let resp = b"* OK [UIDVALIDITY 642] UIDs valid\r\nA0001 OK EXAMINE completed\r\n";
        assert_eq!(parse_uidvalidity(resp), 642);
    }

    #[test]
    fn extract_uid_pulls_first_number() {
        assert_eq!(extract_uid("* 5 FETCH (UID 100 FLAGS (\\Seen))"), Some(100));
        assert_eq!(extract_uid("* 5 FETCH (FLAGS (\\Seen))"), None);
    }

    #[test]
    fn parse_fetch_batch_splits_messages_with_literals() {
        // Two FETCH records, each with a small BODY literal, then the tagged OK.
        let resp = b"* 1 FETCH (UID 100 FLAGS (\\Seen) BODY[]<0> {5}\r\nHELLO)\r\n\
* 2 FETCH (UID 101 FLAGS (\\Flagged) BODY[]<0> {3}\r\nHEY)\r\n\
A0003 OK FETCH completed\r\n";
        let parsed = parse_fetch_batch(resp);
        assert_eq!(parsed.len(), 2);

        let (uid0, flags0, raw0) = &parsed[0];
        assert_eq!(*uid0, 100);
        assert!(flags0.contains("\\Seen"));
        assert_eq!(raw0, b"HELLO");

        let (uid1, flags1, raw1) = &parsed[1];
        assert_eq!(*uid1, 101);
        assert!(flags1.contains("\\Flagged"));
        assert_eq!(raw1, b"HEY");
    }

    #[test]
    fn parse_fetch_batch_concatenates_multiple_literals() {
        // One record carrying a HEADER.FIELDS literal AND a TEXT literal — both
        // must be concatenated so headers parse and a snippet survives.
        let resp = b"* 1 FETCH (UID 100 FLAGS (\\Seen) BODY[HEADER.FIELDS (SUBJECT)] {15}\r\nSubject: Hi\r\n\r\nBODY[TEXT]<0> {3}\r\nYo!)\r\nA1 OK FETCH completed\r\n";
        let parsed = parse_fetch_batch(resp);
        assert_eq!(parsed.len(), 1);
        let (uid, flags, raw) = &parsed[0];
        assert_eq!(*uid, 100);
        assert!(flags.contains("\\Seen"));
        assert_eq!(raw, b"Subject: Hi\r\n\r\nYo!");
    }

    #[test]
    fn parse_fetch_batch_handles_flags_only_records() {
        let resp = b"* 1 FETCH (UID 100 FLAGS (\\Seen \\Flagged))\r\n\
* 2 FETCH (UID 101 FLAGS ())\r\nA0004 OK FETCH completed\r\n";
        let parsed = parse_fetch_batch(resp);
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].1.contains("\\Seen"));
        assert!(parsed[0].2.is_empty());
        assert!(parsed[1].1.is_empty());
    }

    #[test]
    fn search_uids_u32_parses_search_line() {
        let resp = b"* SEARCH 1 2 3 42\r\nA0002 OK SEARCH completed\r\n";
        assert_eq!(search_uids_u32(resp), vec![1, 2, 3, 42]);
    }

    #[test]
    fn parse_message_decodes_multipart_transfer_encodings() {
        let raw = b"Subject: MIME sample\r\n\
Content-Type: multipart/alternative; boundary=\"mail-boundary\"\r\n\r\n\
--mail-boundary\r\n\
Content-Type: text/plain; charset=\"UTF-8\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\n\
5bey5Yib5bu65rWL6K+V\r\n\
--mail-boundary\r\n\
Content-Type: text/html; charset=\"UTF-8\"\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\r\n\
<html><body><p>=E5=B7=B2=E5=88=9B=E5=BB=BA=E6=B5=8B=E8=AF=95</p></body></html>\r\n\
--mail-boundary--\r\n";

        let parsed = parse_message(raw);

        assert_eq!(
            parsed.body_text.trim(),
            "\u{5df2}\u{521b}\u{5efa}\u{6d4b}\u{8bd5}"
        );
        assert!(parsed
            .body_html
            .as_deref()
            .is_some_and(|html| html.contains("\u{5df2}\u{521b}\u{5efa}\u{6d4b}\u{8bd5}")));
    }

    #[test]
    fn microsoft_password_endpoints_are_rejected_before_network_login() {
        let input = GenericMailAccountInput {
            email: "person@outlook.com".to_string(),
            display_name: String::new(),
            imap_host: "outlook.office365.com".to_string(),
            imap_port: 993,
            imap_security: MailSocketSecurity::Tls,
            imap_username: "person@outlook.com".to_string(),
            imap_password: "password".to_string(),
            smtp_enabled: true,
            smtp_host: "smtp-mail.outlook.com".to_string(),
            smtp_port: 587,
            smtp_security: MailSocketSecurity::Starttls,
            smtp_username: "person@outlook.com".to_string(),
            smtp_password: "password".to_string(),
        };

        let result = test_input(&input).expect("test result");

        assert!(!result.ok);
        assert!(!result.imap_ok);
        assert!(result.message.contains("Modern Authentication/OAuth2"));
    }

    #[test]
    fn decode_imap_utf7_handles_chinese_and_literals() {
        // ASCII passes through untouched.
        assert_eq!(decode_imap_utf7("INBOX"), "INBOX");
        assert_eq!(decode_imap_utf7("[Gmail]/Sent Mail"), "[Gmail]/Sent Mail");
        // "&-" is a literal ampersand.
        assert_eq!(decode_imap_utf7("Tom &- Jerry"), "Tom & Jerry");
        // Modified-BASE64 run decodes to UTF-16BE characters.
        assert_eq!(decode_imap_utf7("&Ti1lhw-"), "中文");
        // Decoded segment surrounded by ASCII prefix/suffix.
        assert_eq!(decode_imap_utf7("[Gmail]/&Ti1lhw-x"), "[Gmail]/中文x");
    }
}

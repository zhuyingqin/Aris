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

    assert!(command.contains("\"name\" \"SomniQ Mail\""));
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
#[ignore = "sends real email; set ARIS_TEST_MAIL_TO and optionally ARIS_TEST_MAIL_ACCOUNT_ID"]
fn sends_attachment_smoke_to_configured_recipient() {
    let to = std::env::var("ARIS_TEST_MAIL_TO").expect("ARIS_TEST_MAIL_TO is required");
    let account_id = std::env::var("ARIS_TEST_MAIL_ACCOUNT_ID").unwrap_or_else(|_| {
        super::super::store::list_accounts()
            .into_iter()
            .find(|account| account.provider == Provider::Imap && account.connected)
            .expect("connected IMAP account is required")
            .id
    });
    let path = std::env::temp_dir().join(format!(
        "somniq-mail-attachment-smoke-{}.txt",
        std::process::id()
    ));
    std::fs::write(
        &path,
        "ARIS attachment smoke test.\nThis file verifies SMTP attachments.\n",
    )
    .expect("write attachment");
    let result = send(
        &account_id,
        &MailDraft {
            to,
            cc: String::new(),
            bcc: String::new(),
            subject: "ARIS mail attachment smoke test".to_string(),
            body: "This is an ARIS test message with a small attachment.".to_string(),
            attachments: vec![super::super::model::MailDraftAttachment {
                path: path.to_string_lossy().into_owned(),
                filename: "somniq-mail-attachment-smoke.txt".to_string(),
                mime_type: "text/plain".to_string(),
            }],
        },
    );
    let _ = std::fs::remove_file(path);
    result.expect("send smoke email");
}

#[test]
#[ignore = "searches/downloads a real paper and sends real email; set ARIS_TEST_MAIL_TO and optionally ARIS_TEST_MAIL_ACCOUNT_ID"]
fn literature_download_pdf_attachment_smoke_to_configured_recipient() {
    let to = std::env::var("ARIS_TEST_MAIL_TO").expect("ARIS_TEST_MAIL_TO is required");
    let account_id = std::env::var("ARIS_TEST_MAIL_ACCOUNT_ID").unwrap_or_else(|_| {
        super::super::store::list_accounts()
            .into_iter()
            .find(|account| account.provider == Provider::Imap && account.connected)
            .expect("connected IMAP account is required")
            .id
    });
    let query = std::env::var("ARIS_TEST_LITERATURE_QUERY")
        .unwrap_or_else(|_| "attention is all you need".to_string());
    let sources = vec!["arxiv".to_string()];
    let outcome = tools::literature::search_remote(&query, &sources, 3).expect("search literature");
    let paper = outcome
        .papers
        .iter()
        .find(|paper| paper.pdf_url.is_some())
        .expect("search result with direct PDF");
    let pdf_url = paper.pdf_url.as_deref().expect("PDF URL");
    let base = std::env::temp_dir().join(format!(
        "somniq-literature-mail-smoke-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("create smoke directory");
    let file_name = paper
        .arxiv_id
        .as_deref()
        .unwrap_or(&paper.id)
        .replace(['/', ':'], "-");
    let download = tools::literature::download_pdf_at(&base, pdf_url, &file_name, Some(&paper.id))
        .expect("download PDF");
    let path = download
        .get("path")
        .and_then(serde_json::Value::as_str)
        .expect("download path")
        .to_string();
    let size = std::fs::metadata(&path).expect("download metadata").len();
    assert!(size > 1024, "downloaded PDF is unexpectedly small");
    let subject = format!(
        "ARIS literature PDF smoke test {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs()
    );
    println!("smoke subject: {subject}");

    let result = send(
            &account_id,
            &MailDraft {
                to,
                cc: String::new(),
                bcc: String::new(),
                subject: subject.clone(),
                body: format!(
                    "ARIS searched for:\n\n{query}\n\nDownloaded and attached:\n{}\n\nSource: {pdf_url}",
                    paper.title
                ),
                attachments: vec![super::super::model::MailDraftAttachment {
                    path: path.clone(),
                    filename: std::path::Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("paper.pdf")
                        .to_string(),
                    mime_type: "application/pdf".to_string(),
                }],
            },
        );
    result.expect("send literature PDF smoke email");
    if std::env::var("ARIS_TEST_VERIFY_SENT_COPY").as_deref() != Ok("0") {
        assert!(
            sent_folder_contains_subject(&account_id, &subject),
            "sent folder did not contain smoke email subject"
        );
    }
    let _ = std::fs::remove_dir_all(base);
}

fn sent_folder_contains_subject(account_id: &str, subject: &str) -> bool {
    let mut last_error = None;
    for attempt in 0..3 {
        let result = (|| -> Result<bool, String> {
            let config = helper_config(account_id)?;
            let sent = find_folder(&config, "sent").ok_or_else(|| "sent folder".to_string())?;
            let sent_messages = list(account_id, &sent, subject, None)?;
            Ok(sent_messages
                .messages
                .iter()
                .any(|message| message.subject.contains(subject)))
        })();
        match result {
            Ok(true) => return true,
            Ok(false) => last_error = Some("subject was not found".to_string()),
            Err(error) => last_error = Some(error),
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_secs(4));
        }
    }
    if let Some(error) = last_error {
        eprintln!("sent folder verification failed: {error}");
    }
    false
}

#[test]
fn idle_new_mail_line_accepts_exists_and_recent() {
    assert!(is_idle_new_mail_line("* 42 EXISTS\r\n"));
    assert!(is_idle_new_mail_line("* 1 RECENT\r\n"));
    assert!(!is_idle_new_mail_line("* 2 FETCH (FLAGS (\\Seen))\r\n"));
    assert!(!is_idle_new_mail_line("A0001 OK IDLE completed\r\n"));
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

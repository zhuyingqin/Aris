//! Event-driven literature-help responder.
//!
//! This path is deliberately deterministic: rules decide whether a message is a
//! literature request, then the existing literature search/download tools fetch
//! public PDFs. It does not call an LLM or run on a timer.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::events::MailNewMessageEvent;
use super::model::{MailDraft, MailDraftAttachment, MailMessageFull, MailMessageSummary, Provider};
use super::provider;
use super::store;
use crate::state;

const DEFAULT_MAX_RESULTS: usize = 5;
const DEFAULT_MAX_DOWNLOADS: usize = 2;
const MAX_RUN_LOG: usize = 100;
static RUN_LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone)]
struct LiteratureRequest {
    query: String,
    doi: Option<String>,
    title: Option<String>,
    exact: bool,
}

fn default_sources() -> Vec<String> {
    vec!["scopus".to_string(), "openalex".to_string()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailLiteratureAutomationRun {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: String,
    pub subject: String,
    pub query: String,
    pub status: String,
    pub paper_count: usize,
    pub attachment_count: usize,
    pub attachment_names: Vec<String>,
    pub auto_send: bool,
    pub sent_at: Option<i64>,
    pub handled_at: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailLiteratureAutomationConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub auto_send: bool,
    #[serde(default)]
    pub allow_recipients: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default)]
    pub max_downloads: Option<usize>,
    #[serde(default)]
    pub trigger_keywords: Vec<String>,
}

impl Default for MailLiteratureAutomationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_send: false,
            allow_recipients: Vec::new(),
            sources: default_sources(),
            max_results: Some(DEFAULT_MAX_RESULTS),
            max_downloads: Some(DEFAULT_MAX_DOWNLOADS),
            trigger_keywords: Vec::new(),
        }
    }
}

fn default_enabled() -> bool {
    true
}

/// Emit-free catch-up used by the agent tool (which has no `AppHandle`). The
/// literature responder is now driven entirely by the `mail_literature_catch_up`
/// agent tool / scheduled tasks, not by any mailbox-side command.
pub fn catch_up_recent_quiet(
    account_id: Option<String>,
    limit: Option<usize>,
    retry_sent_without_attachments: bool,
) -> Result<Vec<MailLiteratureAutomationRun>, String> {
    run_catch_up(account_id, limit, retry_sent_without_attachments, |_| {})
}

/// A previously handled run we should not re-process on the next sweep. Without
/// this, `prepared`/`blocked` runs were re-searched and the PDFs re-downloaded
/// on every catch-up (and every scheduled tick).
fn already_handled(
    run: &MailLiteratureAutomationRun,
    retry_sent_without_attachments: bool,
) -> bool {
    if run.status.eq_ignore_ascii_case("sent") {
        return run.attachment_count > 0 || !retry_sent_without_attachments;
    }
    run.status.eq_ignore_ascii_case("prepared") || run.status.eq_ignore_ascii_case("blocked")
}

fn run_catch_up(
    account_id: Option<String>,
    limit: Option<usize>,
    retry_sent_without_attachments: bool,
    mut on_run: impl FnMut(&MailLiteratureAutomationRun),
) -> Result<Vec<MailLiteratureAutomationRun>, String> {
    let config = load_config();
    if !config.enabled {
        return Ok(Vec::new());
    }

    let wanted_account = account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let already_completed: HashSet<String> = read_runs()
        .into_iter()
        .filter(|run| already_handled(run, retry_sent_without_attachments))
        .map(|run| run.id)
        .collect();
    let max_messages = limit.unwrap_or(12).clamp(1, 25);
    let accounts: Vec<_> = store::list_accounts()
        .into_iter()
        .filter(|account| account.connected)
        .filter(|account| wanted_account.is_none_or(|wanted| wanted == account.id))
        .collect();

    let mut runs = Vec::new();
    let mut errors = Vec::new();
    for account in accounts {
        let folder = match account.provider {
            Provider::Outlook => "inbox",
            Provider::Gmail | Provider::Imap => "INBOX",
        };
        let page = match provider::list(&account.id, folder, "", None) {
            Ok(page) => page,
            Err(error) => {
                errors.push(format!("{}: {error}", account.email));
                continue;
            }
        };
        for message in page.messages.into_iter().take(max_messages) {
            let event = MailNewMessageEvent {
                account_id: account.id.clone(),
                provider: account.provider,
                folder: folder.to_string(),
                message,
                detected_at: now_millis(),
            };
            if already_completed.contains(&run_id(&event))
                || !looks_like_literature_help_with_config(&event.message, &config)
            {
                continue;
            }
            let run = run_literature_help_flow(&event, &config);
            if let Err(error) = append_run(&run) {
                errors.push(format!(
                    "{}: could not append automation run: {error}",
                    account.email
                ));
            }
            on_run(&run);
            runs.push(run);
        }
    }

    if runs.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(runs)
}

fn config_path() -> PathBuf {
    state::config_dir().join("mail-literature-automation.json")
}

fn load_config() -> MailLiteratureAutomationConfig {
    let path = config_path();
    let mut config = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<MailLiteratureAutomationConfig>(&text).ok())
        .unwrap_or_default();

    if env_flag("ARIS_MAIL_AUTO_LITERATURE") == Some(false) {
        config.enabled = false;
    }
    if env_flag("ARIS_MAIL_AUTO_LITERATURE_SEND") == Some(true) {
        config.auto_send = true;
    }
    if let Ok(raw) = std::env::var("ARIS_MAIL_AUTO_LITERATURE_ALLOWLIST") {
        config.allow_recipients.extend(
            raw.split([',', ';'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
        );
    }
    normalize_config(config)
}

fn normalize_config(mut config: MailLiteratureAutomationConfig) -> MailLiteratureAutomationConfig {
    config.allow_recipients = clean_list(config.allow_recipients);
    config.sources = {
        let cleaned = clean_list(config.sources);
        if cleaned.is_empty() {
            default_sources()
        } else {
            cleaned
        }
    };
    config.trigger_keywords = clean_list(config.trigger_keywords);
    config.max_results = Some(
        config
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, 20),
    );
    config.max_downloads = Some(
        config
            .max_downloads
            .unwrap_or(DEFAULT_MAX_DOWNLOADS)
            .clamp(0, 5),
    );
    config
}

fn clean_list(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let value = item.trim();
        if !value.is_empty() && !out.iter().any(|existing: &String| existing == value) {
            out.push(value.to_string());
        }
    }
    out
}

fn env_flag(name: &str) -> Option<bool> {
    let value = std::env::var(name).ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn run_log_path() -> PathBuf {
    state::config_dir().join("mail-literature-automation-runs.json")
}

fn read_runs() -> Vec<MailLiteratureAutomationRun> {
    std::fs::read_to_string(run_log_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<MailLiteratureAutomationRun>>(&text).ok())
        .unwrap_or_default()
}

fn append_run(run: &MailLiteratureAutomationRun) -> Result<(), String> {
    let _guard = RUN_LOG_LOCK
        .lock()
        .map_err(|_| "mail literature run log lock poisoned".to_string())?;
    let mut runs = read_runs();
    runs.retain(|existing| existing.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_RUN_LOG);
    let body = serde_json::to_string_pretty(&runs).map_err(|error| error.to_string())?;
    super::atomic_file::write_replace(&run_log_path(), body).map_err(|error| error.to_string())
}

fn run_id(event: &MailNewMessageEvent) -> String {
    format!("{}:{}", event.account_id, event.message.id)
}

fn base_run(
    event: &MailNewMessageEvent,
    config: &MailLiteratureAutomationConfig,
) -> MailLiteratureAutomationRun {
    MailLiteratureAutomationRun {
        id: run_id(event),
        account_id: event.account_id.clone(),
        message_id: event.message.id.clone(),
        thread_id: event.message.thread_id.clone(),
        from: event.message.from.clone(),
        from_name: event.message.from_name.clone(),
        subject: event.message.subject.clone(),
        query: String::new(),
        status: "processing".to_string(),
        paper_count: 0,
        attachment_count: 0,
        attachment_names: Vec::new(),
        auto_send: config.auto_send,
        sent_at: None,
        handled_at: now_millis(),
        error: None,
    }
}

fn run_literature_help_flow(
    event: &MailNewMessageEvent,
    config: &MailLiteratureAutomationConfig,
) -> MailLiteratureAutomationRun {
    let mut run = base_run(event, config);
    let result = (|| -> Result<(), String> {
        let full = provider::read(&event.account_id, &event.message.id)?;
        run.from = full.from.clone();
        run.from_name = full.from_name.clone();
        run.subject = full.subject.clone();
        let request = extract_literature_request(&full);
        if request.query.is_empty() {
            return Err("could not extract a literature search query from the email".to_string());
        }
        run.query = request.query.clone();

        let limit = config
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, 20);
        // Mail automation is an explicitly enabled surface, but it still uses
        // the one canonical literature write path. Its automatic ad-hoc
        // protocol/run makes the external request auditable instead of adding
        // another direct `library.json` writer.
        let base = state::workspace_dir();
        let search = tools::literature::literature_search_ad_hoc_at(
            &base,
            tools::literature::LiteratureSearchInput {
                query: request.query.clone(),
                sources: config.sources.clone(),
                max_results: Some(limit),
            },
        )?;
        let mut papers: Vec<tools::literature::RemotePaper> =
            serde_json::from_value(search["papers"].clone()).map_err(|error| {
                format!("mail literature search returned invalid papers: {error}")
            })?;
        if request.exact {
            papers = filter_exact_request_matches(papers, &request);
        }
        run.paper_count = papers.len();
        // Use the canonical desktop workspace, not the process cwd. The cwd can
        // drift (project switches call `set_current_dir`) or point at a
        // read-only install dir, scattering canonical records or downloaded
        // PDFs. `literature_search_ad_hoc_at` already projected the durable
        // SearchRun and canonical records to the compatibility library.

        let mut max_downloads = config
            .max_downloads
            .unwrap_or(DEFAULT_MAX_DOWNLOADS)
            .clamp(0, 5);
        if request.exact {
            max_downloads = max_downloads.min(1);
        }
        let mut attachments = Vec::new();
        let mut lines = Vec::new();
        for paper in papers.iter().take(limit) {
            lines.push(format!(
                "- {}{}",
                paper.title,
                paper
                    .url
                    .as_deref()
                    .map(|url| format!(" ({url})"))
                    .unwrap_or_default()
            ));
            if attachments.len() >= max_downloads {
                continue;
            }
            match tools::literature::download_best_pdf_for_paper_at(&base, paper) {
                Ok(download) => add_download_attachment(&mut run, &mut attachments, &download),
                Err(error) => {
                    let browser_download =
                        tools::literature::browser_download_task_for_paper(paper)
                            .and_then(|task| {
                                task.ok_or_else(|| {
                                    "no browser-download task route found".to_string()
                                })
                            })
                            .and_then(|task| {
                                let browser_file_name =
                                    paper.arxiv_id.as_deref().unwrap_or(&paper.id);
                                crate::playwright_pdf::download_pdf_at(
                                    &base,
                                    task,
                                    browser_file_name,
                                    Some(&paper.id),
                                )
                            });
                    match browser_download {
                        Ok(download) => {
                            add_download_attachment(&mut run, &mut attachments, &download);
                        }
                        Err(browser_error) => {
                            lines.push(format!(
                                "  PDF download skipped: {error}; browser route: {browser_error}"
                            ));
                        }
                    }
                }
            }
        }
        if request.exact && papers.is_empty() {
            lines.push(format!(
                "- No exact DOI/title match was found for {}.",
                request
                    .title
                    .as_deref()
                    .or(request.doi.as_deref())
                    .unwrap_or(&request.query)
            ));
        }
        run.attachment_count = attachments.len();

        if !config.auto_send {
            run.status = "prepared".to_string();
            return Ok(());
        }
        if !recipient_allowed(&full.from, &config.allow_recipients) {
            run.status = "blocked".to_string();
            return Ok(());
        }
        if full.from.trim().is_empty() {
            return Err("cannot auto-reply: sender address is empty".to_string());
        }
        let body = reply_body(&request.query, &lines, attachments.len());
        // No self-BCC: the provider already files a copy in the Sent folder and
        // the run log records what went out, so BCC-ing the account back to its
        // own inbox only made auto-replies look like clutter in INBOX.
        provider::send(
            &event.account_id,
            &MailDraft {
                to: full.from,
                cc: String::new(),
                bcc: String::new(),
                subject: reply_subject(&full.subject),
                body,
                attachments,
            },
        )?;
        run.status = "sent".to_string();
        run.sent_at = Some(now_millis());
        Ok(())
    })();
    if let Err(error) = result {
        run.status = "error".to_string();
        run.error = Some(error);
    }
    run.handled_at = now_millis();
    run
}

fn add_download_attachment(
    run: &mut MailLiteratureAutomationRun,
    attachments: &mut Vec<MailDraftAttachment>,
    download: &Value,
) {
    if let Some(path) = download.get("path").and_then(Value::as_str) {
        let filename = PathBuf::from(path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("paper.pdf")
            .to_string();
        run.attachment_names.push(filename.clone());
        attachments.push(MailDraftAttachment {
            path: path.to_string(),
            filename,
            mime_type: "application/pdf".to_string(),
        });
    }
}

fn recipient_allowed(address: &str, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return false;
    }
    let address = address.trim().to_ascii_lowercase();
    allowlist
        .iter()
        .map(|item| item.trim().to_ascii_lowercase())
        .any(|item| item == "*" || item == address)
}

fn reply_subject(subject: &str) -> String {
    let subject = subject.trim();
    if subject.to_ascii_lowercase().starts_with("re:") {
        subject.to_string()
    } else if subject.is_empty() {
        "Re: literature request".to_string()
    } else {
        format!("Re: {subject}")
    }
}

fn reply_body(query: &str, lines: &[String], attachment_count: usize) -> String {
    let mut body = format!(
        "I searched for literature related to:\n\n{query}\n\nTop matches:\n{}\n",
        if lines.is_empty() {
            "- No matching public records found.".to_string()
        } else {
            lines.join("\n")
        }
    );
    if attachment_count > 0 {
        body.push_str(&format!(
            "\nAttached: {attachment_count} publicly downloadable PDF file(s).\n"
        ));
    } else {
        body.push_str("\nNo direct public PDF attachment was available from the search results.\n");
    }
    body.push_str("\nThis message was generated by ARIS Mail automation.\n");
    body
}

#[cfg(test)]
fn looks_like_literature_help(message: &MailMessageSummary) -> bool {
    looks_like_literature_help_with_config(message, &MailLiteratureAutomationConfig::default())
}

fn looks_like_literature_help_with_config(
    message: &MailMessageSummary,
    config: &MailLiteratureAutomationConfig,
) -> bool {
    let text = format!(
        "{} {} {}",
        message.subject, message.snippet, message.from_name
    )
    .to_ascii_lowercase();
    let strong_literature_request = [
        "文献求助",
        "论文求助",
        "literature request",
        "paper request",
        "paper pdf",
    ]
    .iter()
    .any(|term| text.contains(term))
        || ((text.contains("doi") || text.contains("title:") || text.contains("title："))
            && (text.contains("pdf")
                || text.contains("paper")
                || text.contains("论文")
                || text.contains("文献")));
    if strong_literature_request {
        return true;
    }
    if !config.trigger_keywords.is_empty()
        && config
            .trigger_keywords
            .iter()
            .map(|term| term.trim().to_ascii_lowercase())
            .any(|term| !term.is_empty() && text.contains(&term))
    {
        return true;
    }
    let literature = [
        "literature",
        "paper",
        "papers",
        "article",
        "pdf",
        "reference",
        "references",
        "arxiv",
        "doi",
        "文献",
        "论文",
        "文章",
        "综述",
        "参考文献",
    ]
    .iter()
    .any(|term| text.contains(term));
    let request = [
        "help", "find", "search", "download", "send", "need", "request", "求助", "帮", "找",
        "检索", "下载", "发送", "需要",
    ]
    .iter()
    .any(|term| text.contains(term));
    literature && request
}

#[cfg(test)]
fn extract_literature_query(message: &MailMessageFull) -> String {
    extract_literature_request(message).query
}

fn extract_literature_request(message: &MailMessageFull) -> LiteratureRequest {
    let doi = extract_doi(&message.body_text).or_else(|| extract_doi(&message.subject));
    let title = extract_labeled_title(&message.body_text)
        .or_else(|| extract_labeled_title(&message.subject));
    if let Some(doi) = doi {
        return LiteratureRequest {
            query: doi.clone(),
            doi: Some(doi),
            title,
            exact: true,
        };
    }
    if let Some(title) = title {
        return LiteratureRequest {
            query: trim_query(&title),
            doi: None,
            title: Some(title),
            exact: true,
        };
    }
    let subject = clean_query_text(&message.subject);
    if is_specific_query(&subject) {
        let query = trim_query(&subject);
        return LiteratureRequest {
            query,
            doi: None,
            title: None,
            exact: false,
        };
    }
    let body = clean_query_text(&message.body_text);
    LiteratureRequest {
        query: trim_query(&body),
        doi: None,
        title: None,
        exact: false,
    }
}

fn filter_exact_request_matches(
    papers: Vec<tools::literature::RemotePaper>,
    request: &LiteratureRequest,
) -> Vec<tools::literature::RemotePaper> {
    let doi = request.doi.as_deref().map(normalize_doi);
    let title = request.title.as_deref().unwrap_or(&request.query);
    let mut matched: Vec<_> = papers
        .into_iter()
        .filter_map(|paper| {
            if let Some(doi) = doi.as_deref() {
                let paper_doi = paper.doi.as_deref().map(normalize_doi);
                if paper_doi.as_deref() == Some(doi) || paper.id.to_ascii_lowercase().contains(doi)
                {
                    return Some((1.0_f32, paper));
                }
                return None;
            }
            let score = title_similarity(title, &paper.title);
            (score >= 0.82).then_some((score, paper))
        })
        .collect();
    matched.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    matched.into_iter().map(|(_, paper)| paper).collect()
}

fn normalize_doi(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("doi:")
        .trim()
        .trim_matches(['.', ',', ';', ':', ')', ']', '}', '）'])
        .to_ascii_lowercase()
}

fn title_similarity(left: &str, right: &str) -> f32 {
    let left_key = title_key(left);
    let right_key = title_key(right);
    if left_key.is_empty() || right_key.is_empty() {
        return 0.0;
    }
    if left_key == right_key {
        return 1.0;
    }
    let shorter = left_key.len().min(right_key.len());
    if shorter >= 32 && (left_key.contains(&right_key) || right_key.contains(&left_key)) {
        return 0.95;
    }
    let left_tokens = title_tokens(left);
    let right_tokens = title_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }
    let intersection = left_tokens
        .iter()
        .filter(|token| right_tokens.contains(token))
        .count();
    let union = left_tokens.len() + right_tokens.len() - intersection;
    let jaccard = intersection as f32 / union as f32;
    let containment = intersection as f32 / left_tokens.len().min(right_tokens.len()) as f32;
    jaccard.max(containment * 0.9)
}

fn title_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn title_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in value
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| token.len() > 2)
    {
        if !tokens.iter().any(|existing| existing == &token) {
            tokens.push(token);
        }
    }
    tokens
}

fn extract_labeled_title(value: &str) -> Option<String> {
    let flattened = value.replace(['\r', '\n', '\t'], " ");
    if let Some(title) = extract_labeled_value(&flattened) {
        return Some(title);
    }
    for line in value.lines() {
        if let Some(title) = extract_labeled_value(line) {
            return Some(title);
        }
    }
    None
}

fn extract_labeled_value(value: &str) -> Option<String> {
    let labels = [
        "paper title",
        "article title",
        "title",
        "论文标题",
        "论文题目",
        "标题",
        "题目",
    ];
    let lower = value.to_ascii_lowercase();
    for label in labels {
        let Some(position) = (if label.is_ascii() {
            lower.find(label)
        } else {
            value.find(label)
        }) else {
            continue;
        };
        let after_label = &value[position + label.len()..];
        let after_separator = after_label
            .trim_start()
            .trim_start_matches([':', '：', '=', '-', '–', '—'])
            .trim_start();
        if after_separator.is_empty() || after_separator.len() == after_label.trim_start().len() {
            continue;
        }
        let cleaned = clean_labeled_field_value(after_separator);
        if is_specific_query(&cleaned) {
            return Some(cleaned);
        }
    }
    None
}

fn clean_labeled_field_value(value: &str) -> String {
    let mut end = value.len();
    let lower = value.to_ascii_lowercase();
    let ascii_markers = [
        " doi:",
        " doi：",
        " publisher:",
        " publisher：",
        " authors:",
        " authors：",
        " author:",
        " author：",
        " year:",
        " year：",
        " source:",
        " source：",
        " if possible",
        " if you can",
        " please attach",
        " please include",
        " thank",
    ];
    for marker in ascii_markers {
        if let Some(pos) = lower.find(marker) {
            end = end.min(pos);
        }
    }
    for marker in ["如果可以", "如果能", "也请", "请附上", "谢谢", "来源链接"] {
        if let Some(pos) = value.find(marker) {
            end = end.min(pos);
        }
    }
    value[..end]
        .trim()
        .trim_matches([
            '"', '\'', '`', '“', '”', '‘', '’', '.', ',', ';', '，', '。', '；',
        ])
        .trim()
        .to_string()
}

fn extract_doi(value: &str) -> Option<String> {
    for (start, _) in value.match_indices("10.") {
        let candidate = value[start..]
            .chars()
            .take_while(|ch| {
                !ch.is_whitespace()
                    && !matches!(
                        ch,
                        '<' | '>' | '"' | '\'' | '，' | '。' | '；' | '、' | '：'
                    )
            })
            .collect::<String>();
        let doi = candidate
            .trim_matches(['.', ',', ';', ':', ')', ']', '}', '）'])
            .to_ascii_lowercase();
        if is_valid_doi(&doi) {
            return Some(doi);
        }
    }
    None
}

fn is_valid_doi(value: &str) -> bool {
    let Some(after_prefix) = value.strip_prefix("10.") else {
        return false;
    };
    let Some((registrant, suffix)) = after_prefix.split_once('/') else {
        return false;
    };
    (4..=9).contains(&registrant.len())
        && registrant.chars().all(|ch| ch.is_ascii_digit())
        && suffix.len() >= 3
}

fn is_specific_query(value: &str) -> bool {
    let value = value.trim();
    if value.chars().count() < 8 {
        return false;
    }
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .take(8)
        .count()
        >= 8
}

fn clean_query_text(value: &str) -> String {
    let mut text = value.replace(['\r', '\n', '\t'], " ");
    for token in [
        "re:",
        "fw:",
        "fwd:",
        "please",
        "help me",
        "can you",
        "could you",
        "find",
        "search",
        "download",
        "send",
        "paper",
        "papers",
        "literature",
        "pdf",
        "文献求助",
        "帮我",
        "查找",
        "检索",
        "下载",
        "发送",
        "文献",
        "论文",
    ] {
        text = text.replace(token, " ");
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_query(value: &str) -> String {
    value
        .chars()
        .take(180)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
#[path = "../tests/mail/auto_literature.rs"]
mod tests;

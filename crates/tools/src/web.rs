use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::collapse_whitespace;

const WEB_SEARCH_SCHEMA_VERSION: u32 = 2;
const DEFAULT_WEB_SEARCH_MAX_RESULTS: usize = 12;
const MAX_WEB_SEARCH_RESULTS: usize = 50;
const SEARCH_SNIPPET_MAX_CHARS: usize = 360;
const WEB_SEARCH_CACHE_TTL: Duration = Duration::from_secs(300);
const WEB_SEARCH_CACHE_CAPACITY: usize = 64;
const WEB_SEARCH_MAX_RESPONSE_BYTES: usize = 2_000_000;
const WEB_FETCH_MAX_RESPONSE_BYTES: usize = 5_000_000;
const WEB_FETCH_DEFAULT_MAX_CHARS: usize = 6_000;
const WEB_FETCH_MAX_CHARS: usize = 20_000;
const WEB_REQUEST_ATTEMPTS: usize = 3;
const EXHAUSTED_CURSOR: &str = "__exhausted__";
const UNRESUMABLE_CURSOR: &str = "__unresumable__";

#[derive(Debug, Deserialize)]
pub(crate) struct WebFetchInput {
    pub(crate) url: String,
    pub(crate) prompt: String,
    #[serde(
        default,
        rename = "maxChars",
        alias = "max_chars",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_chars: Option<usize>,
    #[serde(
        default,
        rename = "allowPrivateNetwork",
        alias = "allow_private_network"
    )]
    pub(crate) allow_private_network: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WebSearchInput {
    pub(crate) query: String,
    pub(crate) allowed_domains: Option<Vec<String>>,
    pub(crate) blocked_domains: Option<Vec<String>>,
    #[serde(default, rename = "maxResults", alias = "max_results")]
    pub(crate) max_results: Option<usize>,
    pub(crate) cursor: Option<String>,
    pub(crate) providers: Option<Vec<String>>,
    pub(crate) language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebFetchOutput {
    pub(crate) bytes: usize,
    pub(crate) code: u16,
    pub(crate) code_text: String,
    pub(crate) result: String,
    pub(crate) duration_ms: u128,
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    pub(crate) content_type: String,
    pub(crate) extraction: String,
    pub(crate) content_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSearchOutput {
    pub(crate) schema_version: u32,
    pub(crate) query: String,
    pub(crate) max_results: usize,
    pub(crate) status: String,
    pub(crate) provider: String,
    pub(crate) query_variants: Vec<runtime::SearchQueryVariant>,
    pub(crate) coverage: runtime::SearchCoverage,
    pub(crate) source_attempts: Vec<WebSourceAttempt>,
    pub(crate) results: Vec<WebSearchResultItem>,
    pub(crate) duration_seconds: f64,
    pub(crate) cached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSourceAttempt {
    pub(crate) provider: String,
    pub(crate) status: String,
    pub(crate) query_variant_count: usize,
    pub(crate) coverage: runtime::SearchCoverage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum WebSearchResultItem {
    SearchResult {
        tool_use_id: String,
        content: Vec<SearchHit>,
    },
    Commentary(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    pub(crate) title: String,
    pub(crate) url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) snippet: String,
    pub(crate) provider: String,
    pub(crate) rank: usize,
    pub(crate) source_ranks: BTreeMap<String, usize>,
    pub(crate) fused_score_micros: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) published_date: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RawSearchHit {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
    pub(crate) provider: String,
    pub(crate) source_rank: usize,
    pub(crate) stream: String,
    pub(crate) published_date: Option<String>,
}

#[derive(Debug)]
struct SearchPage {
    hits: Vec<RawSearchHit>,
    fetched: usize,
    total_hits: Option<u64>,
    exhausted: bool,
    next_cursor: Option<String>,
    truncated_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchCursor {
    schema_version: u32,
    query_key: String,
    providers: Vec<String>,
    streams: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlPageCursor {
    url: String,
    skip: usize,
    #[serde(default)]
    seen_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WebSearchCacheKey {
    query_key: String,
    cursor: String,
}

#[derive(Debug, Clone)]
struct WebSearchCacheEntry {
    key: WebSearchCacheKey,
    inserted_at: Instant,
    output: WebSearchOutput,
}

static WEB_SEARCH_CACHE: OnceLock<Mutex<VecDeque<WebSearchCacheEntry>>> = OnceLock::new();

#[derive(Debug, Clone)]
enum WebProvider {
    Custom { base: Url, allow_private: bool },
    Brave { api_key: String },
    Exa { api_key: String },
    DuckDuckGo,
}

impl WebProvider {
    fn name(&self) -> &'static str {
        match self {
            Self::Custom { .. } => "custom",
            Self::Brave { .. } => "brave",
            Self::Exa { .. } => "exa",
            Self::DuckDuckGo => "duckduckgo",
        }
    }
}

#[derive(Debug)]
struct ProviderRun {
    hits: Vec<RawSearchHit>,
    attempt: WebSourceAttempt,
    stream_cursors: BTreeMap<String, String>,
}

#[derive(Debug)]
struct HttpBody {
    status: StatusCode,
    final_url: Url,
    content_type: String,
    bytes: Vec<u8>,
}

pub(crate) fn run_web_fetch(
    input: WebFetchInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<String, String> {
    serde_json::to_string_pretty(&execute_web_fetch(&input, should_cancel)?)
        .map_err(|error| error.to_string())
}

pub(crate) fn run_web_search(
    input: WebSearchInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<String, String> {
    serde_json::to_string_pretty(&execute_web_search(&input, should_cancel)?)
        .map_err(|error| error.to_string())
}

/// Probe a configured API provider without mutating process-wide environment
/// variables or entering the normal search cache. Desktop uses this for testing
/// an unsaved draft key while other searches may be running concurrently.
pub fn probe_web_search_provider(
    provider: &str,
    api_key: &str,
    query: &str,
) -> Result<Value, String> {
    let provider = match provider.trim().to_ascii_lowercase().as_str() {
        "brave" => WebProvider::Brave {
            api_key: api_key.trim().to_string(),
        },
        "exa" => WebProvider::Exa {
            api_key: api_key.trim().to_string(),
        },
        other => return Err(format!("unsupported web search provider: {other}")),
    };
    if api_key.trim().is_empty() {
        return Err("web search provider API key is empty".to_string());
    }
    let query = collapse_whitespace(query);
    if query.chars().count() < 2 {
        return Err("web search provider probe query is too short".to_string());
    }
    let input = WebSearchInput {
        query: query.clone(),
        allowed_domains: None,
        blocked_domains: None,
        max_results: Some(1),
        cursor: None,
        providers: Some(vec![provider.name().to_string()]),
        language: Some("en".to_string()),
    };
    let variants = vec![runtime::SearchQueryVariant {
        kind: "connectivity_probe".to_string(),
        query,
        rationale: "Verify provider credentials and request compatibility.".to_string(),
    }];
    let run = run_provider(
        &provider,
        &variants,
        &[1],
        &input,
        &BTreeMap::new(),
        &|| false,
    );
    serde_json::to_value(run.attempt).map_err(|error| error.to_string())
}

pub(crate) fn execute_web_fetch(
    input: &WebFetchInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<WebFetchOutput, String> {
    let started = Instant::now();
    let request_url =
        normalize_fetch_url(&input.url, input.allow_private_network.unwrap_or(false))?;
    let response = send_web_request(
        Method::GET,
        request_url,
        HeaderMap::new(),
        None,
        input.allow_private_network.unwrap_or(false),
        WEB_FETCH_MAX_RESPONSE_BYTES,
        should_cancel,
    )
    .map_err(|error| format!("web_fetch_error:{error}"))?;

    if !response.status.is_success() {
        return Err(format!(
            "web_fetch_error:http_error requested page returned HTTP {} {}",
            response.status.as_u16(),
            response.status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let content_type = response.content_type.to_ascii_lowercase();
    if content_type.contains("application/pdf") {
        return Err(
            "web_fetch_error:unsupported_content PDF content requires the literature/PDF reader"
                .to_string(),
        );
    }
    if !content_type.is_empty()
        && !content_type.starts_with("text/")
        && !content_type.contains("html")
        && !content_type.contains("xml")
        && !content_type.contains("json")
        && !content_type.contains("javascript")
    {
        return Err(format!(
            "web_fetch_error:unsupported_content unsupported content type {content_type:?}"
        ));
    }

    let body = String::from_utf8_lossy(&response.bytes).into_owned();
    let normalized = normalize_fetched_content(&body, &content_type);
    let max_chars = input
        .max_chars
        .unwrap_or(WEB_FETCH_DEFAULT_MAX_CHARS)
        .clamp(200, WEB_FETCH_MAX_CHARS);
    let title = extract_title(&normalized, &body, &content_type);
    let (result, extraction, content_truncated) = summarize_web_fetch(
        response.final_url.as_str(),
        &input.prompt,
        &normalized,
        title.as_deref(),
        max_chars,
    );

    Ok(WebFetchOutput {
        bytes: response.bytes.len(),
        code: response.status.as_u16(),
        code_text: response
            .status
            .canonical_reason()
            .unwrap_or("Unknown")
            .to_string(),
        result,
        duration_ms: started.elapsed().as_millis(),
        url: response.final_url.to_string(),
        title,
        content_type,
        extraction,
        content_truncated,
    })
}

pub(crate) fn execute_web_search(
    input: &WebSearchInput,
    should_cancel: &dyn Fn() -> bool,
) -> Result<WebSearchOutput, String> {
    let started = Instant::now();
    let query = collapse_whitespace(&input.query);
    if query.chars().count() < 2 {
        return Err(
            "web_search_error:invalid_query query must contain at least 2 characters".into(),
        );
    }
    if query.chars().count() > 400 {
        return Err("web_search_error:invalid_query query exceeds 400 characters".into());
    }
    validate_domain_filters(input.allowed_domains.as_deref())?;
    validate_domain_filters(input.blocked_domains.as_deref())?;

    let max_results = input.max_results.unwrap_or(DEFAULT_WEB_SEARCH_MAX_RESULTS);
    if !(1..=MAX_WEB_SEARCH_RESULTS).contains(&max_results) {
        return Err(format!(
            "web_search_error:invalid_bound maxResults must be between 1 and {MAX_WEB_SEARCH_RESULTS}"
        ));
    }
    let mut variants = plan_web_query_variants(&query, input.language.as_deref());
    let requested = normalize_provider_request(input.providers.as_deref())?;
    let explicit_all = requested.iter().any(|name| name == "all");
    let candidates = resolve_provider_candidates(&requested)?;
    let supplied_cursor = parse_search_cursor(input.cursor.as_deref())?;
    let cursor_provider_names = supplied_cursor
        .as_ref()
        .map(|cursor| cursor.providers.clone());

    let selected_candidates = if let Some(names) = cursor_provider_names.as_ref() {
        resolve_named_providers(names)?
    } else {
        candidates
    };
    let provider_names = selected_candidates
        .iter()
        .map(|provider| provider.name().to_string())
        .collect::<Vec<_>>();
    let concurrent_provider_count = if explicit_all
        || cursor_provider_names
            .as_ref()
            .is_some_and(|names| names.len() > 1)
        || requested.len() > 1
    {
        selected_candidates.len()
    } else {
        1
    }
    .max(1);
    if concurrent_provider_count > max_results {
        return Err(format!(
            "web_search_error:invalid_bound maxResults={max_results} is smaller than the {concurrent_provider_count} concurrently requested providers"
        ));
    }
    let max_variants_per_provider = (max_results / concurrent_provider_count).max(1);
    variants.truncate(max_variants_per_provider);
    let query_key = web_search_query_key(input, max_results, &provider_names, &variants);
    if let Some(cursor) = supplied_cursor.as_ref() {
        if cursor.schema_version != WEB_SEARCH_SCHEMA_VERSION {
            return Err(format!(
                "web_search_error:invalid_cursor cursor schema {} does not match {}",
                cursor.schema_version, WEB_SEARCH_SCHEMA_VERSION
            ));
        }
        if cursor.query_key != query_key {
            return Err(
                "web_search_error:invalid_cursor cursor does not match the query, filters, providers, language, or maxResults"
                    .to_string(),
            );
        }
    }

    let cache_key = WebSearchCacheKey {
        query_key: query_key.clone(),
        cursor: input.cursor.clone().unwrap_or_default(),
    };
    if let Some(mut cached) = web_search_cache_get(&cache_key) {
        cached.cached = true;
        cached.duration_seconds = started.elapsed().as_secs_f64();
        return Ok(cached);
    }

    let mut raw_hits = Vec::new();
    let mut attempts = unavailable_provider_attempts(&requested);
    let mut next_streams = BTreeMap::new();
    let mut successful_provider_names = Vec::new();
    let initial_streams = supplied_cursor
        .as_ref()
        .map(|cursor| cursor.streams.clone())
        .unwrap_or_default();

    if selected_candidates.is_empty() {
        return Err(
            "web_search_error:unavailable no requested web search provider is configured"
                .to_string(),
        );
    }

    if explicit_all || cursor_provider_names.is_some() || requested.len() > 1 {
        let active_streams = selected_candidates
            .len()
            .saturating_mul(variants.len())
            .max(1);
        let budgets = distribute_budget(max_results, active_streams);
        let mut budget_index = 0;
        for provider in &selected_candidates {
            let provider_budgets = budgets[budget_index..budget_index + variants.len()].to_vec();
            budget_index += variants.len();
            let run = run_provider(
                provider,
                &variants,
                &provider_budgets,
                input,
                &initial_streams,
                should_cancel,
            );
            if run.attempt.status != "failed" && run.attempt.status != "skipped" {
                successful_provider_names.push(provider.name().to_string());
            }
            raw_hits.extend(run.hits);
            next_streams.extend(run.stream_cursors);
            attempts.push(run.attempt);
        }
    } else {
        // `auto` is a fallback chain: use the first configured provider that
        // returns usable hits, while retaining every failed/empty attempt in the
        // audit output. This avoids silently turning an upstream outage into
        // "no results".
        let budgets = distribute_budget(max_results, variants.len().max(1));
        for provider in &selected_candidates {
            let run = run_provider(
                provider,
                &variants,
                &budgets,
                input,
                &initial_streams,
                should_cancel,
            );
            let usable = !run.hits.is_empty();
            let valid_empty = run.attempt.status == "completed" && run.attempt.coverage.exhausted;
            attempts.push(run.attempt);
            if usable {
                successful_provider_names.push(provider.name().to_string());
                raw_hits.extend(run.hits);
                next_streams.extend(run.stream_cursors);
                break;
            }
            if valid_empty {
                // A second independent source is still useful for distinguishing
                // a genuine empty result set from one provider's sparse index.
                continue;
            }
        }
    }

    if successful_provider_names.is_empty() && raw_hits.is_empty() {
        let all_completed_empty = attempts
            .iter()
            .any(|attempt| attempt.status == "completed" && attempt.coverage.exhausted);
        if !all_completed_empty {
            let detail = attempts
                .iter()
                .map(|attempt| {
                    format!(
                        "{}: {}",
                        attempt.provider,
                        attempt.error.as_deref().unwrap_or(&attempt.status)
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!("web_search_error:all_providers_failed {detail}"));
        }
    }

    let hits = fuse_search_hits(raw_hits, max_results);
    let failed_or_partial = attempts.iter().any(|attempt| attempt.status != "completed");
    let all_exhausted = !attempts.is_empty()
        && attempts
            .iter()
            .filter(|attempt| attempt.status != "skipped")
            .all(|attempt| attempt.coverage.exhausted)
        && !failed_or_partial;
    // A provider count belongs to one exact query stream. Query variants and
    // providers overlap, so adding those counts would invent a false union
    // cardinality. Expose totalHits only when exactly one stream was queried.
    let active_attempts = attempts
        .iter()
        .filter(|attempt| attempt.status != "skipped")
        .collect::<Vec<_>>();
    let total_hits = if active_attempts.len() == 1 && active_attempts[0].query_variant_count == 1 {
        active_attempts[0].coverage.total_hits
    } else {
        None
    };
    let fetched = attempts
        .iter()
        .map(|attempt| attempt.coverage.fetched)
        .sum();

    let cursor_providers = if explicit_all || requested.len() > 1 {
        provider_names
    } else if successful_provider_names.is_empty() {
        provider_names
    } else {
        successful_provider_names
    };
    let has_resumable_stream = next_streams
        .values()
        .any(|cursor| cursor != EXHAUSTED_CURSOR && cursor != UNRESUMABLE_CURSOR);
    let next_cursor = if all_exhausted || !has_resumable_stream {
        None
    } else {
        Some(
            serde_json::to_string(&WebSearchCursor {
                schema_version: WEB_SEARCH_SCHEMA_VERSION,
                query_key: web_search_query_key(input, max_results, &cursor_providers, &variants),
                providers: cursor_providers.clone(),
                streams: next_streams,
            })
            .map_err(|error| error.to_string())?,
        )
    };
    for attempt in &mut attempts {
        if attempt.status != "skipped" && !attempt.coverage.exhausted {
            attempt.coverage.next_cursor = next_cursor.clone();
        }
    }
    let truncated_reason = aggregate_truncated_reason(
        &attempts,
        hits.len(),
        max_results,
        all_exhausted,
        next_cursor.is_some(),
    );
    let coverage = runtime::SearchCoverage {
        total_hits,
        fetched,
        unique: hits.len() as u64,
        exhausted: all_exhausted,
        next_cursor,
        truncated_reason,
    };
    let status = if coverage.exhausted {
        "completed"
    } else {
        "partial"
    }
    .to_string();
    let provider = cursor_providers.join(",");
    let summary = if hits.is_empty() {
        if coverage.exhausted {
            format!(
                "Completed web search for {query:?}: no matching results were found by the exhausted providers."
            )
        } else {
            format!(
                "Partial web search for {query:?}: no usable hits were returned, but coverage is incomplete. Do not report this as a definitive no-result finding."
            )
        }
    } else {
        format!(
            "{} fused web result(s) for {query:?}; status={status}, fetched={}, exhausted={}. Cite the result URLs and disclose partial coverage when exhausted=false.",
            hits.len(),
            coverage.fetched,
            coverage.exhausted
        )
    };
    let output = WebSearchOutput {
        schema_version: WEB_SEARCH_SCHEMA_VERSION,
        query,
        max_results,
        status,
        provider,
        query_variants: variants,
        coverage,
        source_attempts: attempts,
        results: vec![
            WebSearchResultItem::Commentary(summary),
            WebSearchResultItem::SearchResult {
                tool_use_id: "web_search_results".to_string(),
                content: hits,
            },
        ],
        duration_seconds: started.elapsed().as_secs_f64(),
        cached: false,
    };
    if output.coverage.unique > 0 {
        web_search_cache_put(cache_key, output.clone());
    }
    Ok(output)
}

fn run_provider(
    provider: &WebProvider,
    variants: &[runtime::SearchQueryVariant],
    budgets: &[usize],
    input: &WebSearchInput,
    initial_streams: &BTreeMap<String, String>,
    should_cancel: &dyn Fn() -> bool,
) -> ProviderRun {
    let mut hits = Vec::new();
    let mut fetched = 0;
    let mut total_hits = Some(0_u64);
    let mut unique_urls = BTreeSet::new();
    let mut stream_cursors = BTreeMap::new();
    let mut errors = Vec::new();
    let mut successful_streams = 0;
    let mut exhausted_streams = 0;
    let mut truncation_reasons = BTreeSet::new();

    for (variant, budget) in variants.iter().zip(budgets.iter().copied()) {
        if budget == 0 {
            continue;
        }
        let stream = stream_key(provider.name(), variant);
        let cursor = initial_streams.get(&stream).map(String::as_str);
        if cursor == Some(EXHAUSTED_CURSOR) {
            exhausted_streams += 1;
            successful_streams += 1;
            continue;
        }
        if cursor == Some(UNRESUMABLE_CURSOR) {
            successful_streams += 1;
            truncation_reasons.insert("provider_result_window".to_string());
            stream_cursors.insert(stream, UNRESUMABLE_CURSOR.to_string());
            continue;
        }
        match fetch_provider_page(
            provider,
            variant,
            input,
            cursor,
            budget,
            &stream,
            should_cancel,
        ) {
            Ok(page) => {
                successful_streams += 1;
                fetched += page.fetched;
                if let Some(total) = page.total_hits {
                    total_hits = total_hits.map(|current| current.saturating_add(total));
                } else {
                    total_hits = None;
                }
                if page.exhausted {
                    exhausted_streams += 1;
                    stream_cursors.insert(stream.clone(), EXHAUSTED_CURSOR.to_string());
                } else if let Some(next) = page.next_cursor {
                    stream_cursors.insert(stream.clone(), next);
                } else {
                    // No resumable cursor means the provider's result window was
                    // reached. Preserve an explicit partial state instead of
                    // claiming completion.
                    stream_cursors.insert(stream.clone(), UNRESUMABLE_CURSOR.to_string());
                }
                if let Some(reason) = page.truncated_reason {
                    truncation_reasons.insert(reason);
                }
                for hit in page.hits {
                    unique_urls.insert(canonical_url_key(&hit.url));
                    hits.push(hit);
                }
            }
            Err(error) => {
                errors.push(format!("{}: {error}", variant.kind));
                stream_cursors.insert(stream, cursor.unwrap_or_default().to_string());
                truncation_reasons.insert("provider_error".to_string());
            }
        }
    }

    let attempted_streams = budgets.iter().filter(|budget| **budget > 0).count();
    if attempted_streams != 1 {
        total_hits = None;
    }
    let exhausted = attempted_streams > 0
        && successful_streams == attempted_streams
        && exhausted_streams == attempted_streams
        && errors.is_empty();
    let status = if errors.is_empty() && exhausted {
        "completed"
    } else if successful_streams > 0 {
        "partial"
    } else {
        "failed"
    }
    .to_string();
    let error = (!errors.is_empty()).then(|| errors.join("; "));
    let truncated_reason = if truncation_reasons.is_empty() {
        (!exhausted).then(|| "max_results".to_string())
    } else {
        Some(truncation_reasons.into_iter().collect::<Vec<_>>().join(","))
    };

    ProviderRun {
        hits,
        attempt: WebSourceAttempt {
            provider: provider.name().to_string(),
            status,
            query_variant_count: attempted_streams,
            coverage: runtime::SearchCoverage {
                total_hits,
                fetched: fetched as u64,
                unique: unique_urls.len() as u64,
                exhausted,
                next_cursor: None,
                truncated_reason,
            },
            error,
        },
        stream_cursors,
    }
}

fn fetch_provider_page(
    provider: &WebProvider,
    variant: &runtime::SearchQueryVariant,
    input: &WebSearchInput,
    cursor: Option<&str>,
    limit: usize,
    stream: &str,
    should_cancel: &dyn Fn() -> bool,
) -> Result<SearchPage, String> {
    match provider {
        WebProvider::Custom {
            base,
            allow_private,
        } => fetch_html_search_page(
            provider.name(),
            base,
            &variant.query,
            input,
            cursor,
            limit,
            stream,
            *allow_private,
            should_cancel,
        ),
        WebProvider::DuckDuckGo => {
            let base = Url::parse("https://html.duckduckgo.com/html/")
                .map_err(|error| error.to_string())?;
            fetch_html_search_page(
                provider.name(),
                &base,
                &variant.query,
                input,
                cursor,
                limit,
                stream,
                false,
                should_cancel,
            )
        }
        WebProvider::Brave { api_key } => fetch_brave_page(
            api_key,
            variant,
            input,
            cursor,
            limit,
            stream,
            should_cancel,
        ),
        WebProvider::Exa { api_key } => fetch_exa_page(
            api_key,
            variant,
            input,
            cursor,
            limit,
            stream,
            should_cancel,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn fetch_html_search_page(
    provider: &str,
    base: &Url,
    query: &str,
    input: &WebSearchInput,
    cursor: Option<&str>,
    limit: usize,
    stream: &str,
    allow_private: bool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<SearchPage, String> {
    let page_cursor = cursor
        .filter(|value| !value.is_empty())
        .map(|value| {
            serde_json::from_str::<HtmlPageCursor>(value)
                .map_err(|error| format!("invalid provider cursor: {error}"))
        })
        .transpose()?;
    let mut seen_keys = page_cursor
        .as_ref()
        .map(|cursor| cursor.seen_keys.clone())
        .unwrap_or_default();
    let mut seen_set = seen_keys.iter().cloned().collect::<BTreeSet<_>>();
    let (url, skip) = if let Some(cursor) = page_cursor {
        let cursor_url = Url::parse(&cursor.url)
            .map_err(|error| format!("invalid provider cursor URL: {error}"))?;
        validate_pagination_origin(&cursor_url, base)?;
        (cursor_url, cursor.skip)
    } else {
        let mut url = base.clone();
        url.query_pairs_mut()
            .append_pair("q", &query_with_domain_filters(query, input));
        (url, 0)
    };
    let response = send_web_request(
        Method::GET,
        url.clone(),
        HeaderMap::new(),
        None,
        allow_private,
        WEB_SEARCH_MAX_RESPONSE_BYTES,
        should_cancel,
    )?;
    validate_pagination_origin(&response.final_url, base)?;
    if !response.status.is_success() {
        return Err(web_search_status_error(
            response.status,
            &String::from_utf8_lossy(&response.bytes),
        ));
    }
    let body = String::from_utf8_lossy(&response.bytes).into_owned();
    if let Some(marker) = detect_search_challenge(&body) {
        return Err(format!(
            "web_search_error:blocked provider returned a bot challenge ({marker})"
        ));
    }

    let is_json = response.content_type.to_ascii_lowercase().contains("json")
        || body.trim_start().starts_with('{');
    let (mut parsed, total_hits, generic_next) = if is_json {
        extract_generic_json_hits(&body, provider, stream)?
    } else {
        let mut hits = extract_search_hits(&body, provider, stream);
        if hits.is_empty() {
            hits = extract_search_hits_from_generic_links(&body, provider, stream);
        }
        let no_results = search_page_declares_no_results(&body);
        if hits.is_empty() && !no_results {
            return Err(
                "web_search_error:parse_error provider returned HTML but no result or explicit no-result marker could be recognized"
                    .to_string(),
            );
        }
        (
            hits,
            None,
            extract_next_search_url(&body, &response.final_url).map(|url| url.to_string()),
        )
    };

    let raw_fetched = parsed.len();
    parsed.retain(|hit| !is_provider_navigation_hit(hit));
    apply_domain_filters(&mut parsed, input);
    dedupe_raw_hits(&mut parsed);
    let rank_offset = response
        .final_url
        .query_pairs()
        .find_map(|(key, value)| (key == "s").then(|| value.parse::<usize>().ok()).flatten())
        .unwrap_or(0);
    for hit in &mut parsed {
        hit.source_rank = hit.source_rank.saturating_add(rank_offset);
    }
    let mut hits = Vec::new();
    let mut consumed = skip.min(parsed.len());
    for hit in parsed.iter().skip(skip) {
        consumed = consumed.saturating_add(1);
        let key = web_cursor_url_key(&hit.url);
        if !seen_set.insert(key.clone()) {
            continue;
        }
        seen_keys.push(key);
        hits.push(hit.clone());
        if hits.len() == limit {
            break;
        }
    }
    const MAX_CURSOR_SEEN_KEYS: usize = 256;
    if seen_keys.len() > MAX_CURSOR_SEEN_KEYS {
        seen_keys.drain(..seen_keys.len() - MAX_CURSOR_SEEN_KEYS);
    }
    let normalized_next = generic_next
        .map(|next| {
            response
                .final_url
                .join(&next)
                .map_err(|error| format!("invalid provider next-page URL: {error}"))
        })
        .transpose()?;
    if let Some(next) = normalized_next.as_ref() {
        validate_pagination_origin(next, base)?;
    }
    let next_cursor = if consumed < parsed.len() {
        Some(
            serde_json::to_string(&HtmlPageCursor {
                url: response.final_url.to_string(),
                skip: consumed,
                seen_keys: seen_keys.clone(),
            })
            .map_err(|error| error.to_string())?,
        )
    } else if let Some(next_url) = normalized_next {
        Some(
            serde_json::to_string(&HtmlPageCursor {
                url: next_url.to_string(),
                skip: 0,
                seen_keys,
            })
            .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let exhausted = next_cursor.is_none();
    Ok(SearchPage {
        hits,
        fetched: raw_fetched,
        total_hits,
        exhausted,
        next_cursor,
        truncated_reason: (!exhausted).then(|| "max_results".to_string()),
    })
}

fn fetch_brave_page(
    api_key: &str,
    variant: &runtime::SearchQueryVariant,
    input: &WebSearchInput,
    cursor: Option<&str>,
    limit: usize,
    stream: &str,
    should_cancel: &dyn Fn() -> bool,
) -> Result<SearchPage, String> {
    let offset = cursor
        .filter(|value| !value.is_empty())
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|error| format!("invalid Brave cursor: {error}"))?;
    if offset > 9 {
        return Ok(SearchPage {
            hits: Vec::new(),
            fetched: 0,
            total_hits: None,
            exhausted: false,
            next_cursor: None,
            truncated_reason: Some("provider_result_window".to_string()),
        });
    }
    let count = limit.clamp(1, 20);
    let mut url = Url::parse("https://api.search.brave.com/res/v1/web/search")
        .map_err(|error| error.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("q", &query_with_domain_filters(&variant.query, input))
            .append_pair("count", &count.to_string())
            .append_pair("offset", &offset.to_string())
            .append_pair("result_filter", "web")
            .append_pair("extra_snippets", "true")
            .append_pair("text_decorations", "false");
        if let Some(language) = input
            .language
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            pairs.append_pair("search_lang", language.trim());
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-subscription-token"),
        HeaderValue::from_str(api_key).map_err(|error| error.to_string())?,
    );
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );
    let response = send_web_request(
        Method::GET,
        url,
        headers,
        None,
        false,
        WEB_SEARCH_MAX_RESPONSE_BYTES,
        should_cancel,
    )?;
    if !response.status.is_success() {
        return Err(web_search_status_error(
            response.status,
            &String::from_utf8_lossy(&response.bytes),
        ));
    }
    let value: Value = serde_json::from_slice(&response.bytes)
        .map_err(|error| format!("web_search_error:decode invalid Brave JSON: {error}"))?;
    let items = value["web"]["results"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut hits = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(url) = item["url"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let mut snippet = item["description"].as_str().unwrap_or("").to_string();
        if let Some(extra) = item["extra_snippets"].as_array() {
            for text in extra.iter().filter_map(Value::as_str).take(2) {
                if !snippet.is_empty() {
                    snippet.push(' ');
                }
                snippet.push_str(text);
            }
        }
        hits.push(RawSearchHit {
            title: item["title"].as_str().unwrap_or(url).to_string(),
            url: url.to_string(),
            snippet: preview_text(&html_to_text(&snippet), SEARCH_SNIPPET_MAX_CHARS),
            provider: "brave".to_string(),
            source_rank: offset.saturating_mul(count).saturating_add(index + 1),
            stream: stream.to_string(),
            published_date: item["age"]
                .as_str()
                .or_else(|| item["page_age"].as_str())
                .map(str::to_string),
        });
    }
    apply_domain_filters(&mut hits, input);
    dedupe_raw_hits(&mut hits);
    let more = value["query"]["more_results_available"]
        .as_bool()
        .unwrap_or(false);
    let window_exhausted = offset >= 9 && more;
    let next_cursor = (more && offset < 9).then(|| (offset + 1).to_string());
    Ok(SearchPage {
        fetched: items.len(),
        hits,
        total_hits: None,
        exhausted: !more,
        next_cursor,
        truncated_reason: window_exhausted
            .then(|| "provider_result_window".to_string())
            .or_else(|| more.then(|| "max_results".to_string())),
    })
}

fn fetch_exa_page(
    api_key: &str,
    variant: &runtime::SearchQueryVariant,
    input: &WebSearchInput,
    cursor: Option<&str>,
    limit: usize,
    stream: &str,
    should_cancel: &dyn Fn() -> bool,
) -> Result<SearchPage, String> {
    if cursor.is_some_and(|value| !value.is_empty()) {
        return Ok(SearchPage {
            hits: Vec::new(),
            fetched: 0,
            total_hits: None,
            exhausted: false,
            next_cursor: None,
            truncated_reason: Some("provider_result_window".to_string()),
        });
    }
    let count = limit.clamp(1, 100);
    let mut payload = json!({
        "query": variant.query,
        "numResults": count,
        "type": "auto",
        "moderation": true,
        "contents": {
            "highlights": { "maxCharacters": SEARCH_SNIPPET_MAX_CHARS }
        }
    });
    if let Some(domains) = clean_domain_filters(input.allowed_domains.as_deref()) {
        payload["includeDomains"] = json!(domains);
    }
    if let Some(domains) = clean_domain_filters(input.blocked_domains.as_deref()) {
        payload["excludeDomains"] = json!(domains);
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| error.to_string())?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );
    let response = send_web_request(
        Method::POST,
        Url::parse("https://api.exa.ai/search").map_err(|error| error.to_string())?,
        headers,
        Some(serde_json::to_vec(&payload).map_err(|error| error.to_string())?),
        false,
        WEB_SEARCH_MAX_RESPONSE_BYTES,
        should_cancel,
    )?;
    if !response.status.is_success() {
        return Err(web_search_status_error(
            response.status,
            &String::from_utf8_lossy(&response.bytes),
        ));
    }
    let value: Value = serde_json::from_slice(&response.bytes)
        .map_err(|error| format!("web_search_error:decode invalid Exa JSON: {error}"))?;
    let items = value["results"].as_array().cloned().unwrap_or_default();
    let mut hits = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(url) = item["url"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let snippet = item["highlights"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .or_else(|| item["summary"].as_str().map(str::to_string))
            .or_else(|| item["text"].as_str().map(str::to_string))
            .unwrap_or_default();
        hits.push(RawSearchHit {
            title: item["title"].as_str().unwrap_or(url).to_string(),
            url: url.to_string(),
            snippet: preview_text(&collapse_whitespace(&snippet), SEARCH_SNIPPET_MAX_CHARS),
            provider: "exa".to_string(),
            source_rank: index + 1,
            stream: stream.to_string(),
            published_date: item["publishedDate"].as_str().map(str::to_string),
        });
    }
    apply_domain_filters(&mut hits, input);
    dedupe_raw_hits(&mut hits);
    let reached_window = items.len() >= count;
    Ok(SearchPage {
        fetched: items.len(),
        hits,
        total_hits: None,
        exhausted: !reached_window,
        next_cursor: None,
        truncated_reason: reached_window.then(|| "provider_result_window".to_string()),
    })
}

fn build_http_client(url: &Url, allow_private: bool) -> Result<Client, String> {
    let addresses = validated_network_addresses(url, allow_private)?;
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("SomniQ-Studio/0.4 web-research");
    if let Some(host) = url
        .host_str()
        .filter(|host| host.parse::<IpAddr>().is_err())
    {
        // Pin the exact addresses that passed the public-network validation.
        // Without this override reqwest would perform a second DNS lookup,
        // leaving a DNS-rebinding window between validation and connection.
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder.build().map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn send_web_request(
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
    allow_private: bool,
    max_bytes: usize,
    should_cancel: &dyn Fn() -> bool,
) -> Result<HttpBody, String> {
    let mut last_error = None;
    for attempt in 0..WEB_REQUEST_ATTEMPTS {
        if should_cancel() {
            return Err("interrupted web request".to_string());
        }
        let mut current_url = url.clone();
        let mut current_method = method.clone();
        let mut redirect_count = 0;
        loop {
            let client = build_http_client(&current_url, allow_private)?;
            let mut request = client
                .request(current_method.clone(), current_url.clone())
                .headers(headers.clone());
            if let Some(body) = body.as_ref().filter(|_| current_method != Method::GET) {
                request = request.body(body.clone());
            }
            let mut response = match request.send() {
                Ok(response) => response,
                Err(error) => {
                    let classified = classify_web_error(&error);
                    last_error = Some(classified.clone());
                    if attempt + 1 < WEB_REQUEST_ATTEMPTS {
                        cooperative_sleep(
                            Duration::from_millis(250_u64 << attempt),
                            should_cancel,
                        )?;
                        break;
                    }
                    return Err(classified);
                }
            };
            if response.status().is_redirection() {
                if redirect_count >= 10 {
                    return Err("redirect_limit too many redirects".to_string());
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        "redirect_error redirect response omitted Location".to_string()
                    })?;
                let next = current_url
                    .join(location)
                    .map_err(|error| format!("redirect_error invalid Location: {error}"))?;
                if matches!(
                    response.status(),
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER
                ) {
                    current_method = Method::GET;
                }
                current_url = next;
                redirect_count += 1;
                continue;
            }

            let status = response.status();
            if is_retryable_status(status) && attempt + 1 < WEB_REQUEST_ATTEMPTS {
                let delay = retry_after_delay(response.headers())
                    .unwrap_or_else(|| Duration::from_millis(250_u64 << attempt));
                last_error = Some(web_search_status_error(status, ""));
                cooperative_sleep(delay.min(Duration::from_secs(4)), should_cancel)?;
                break;
            }

            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<usize>().ok())
                .is_some_and(|length| length > max_bytes)
            {
                return Err(format!(
                    "response_too_large Content-Length exceeds {max_bytes} bytes"
                ));
            }
            let final_url = response.url().clone();
            let bytes = read_response_limited(&mut response, max_bytes, should_cancel)?;
            return Ok(HttpBody {
                status,
                final_url,
                content_type,
                bytes,
            });
        }
    }
    Err(last_error.unwrap_or_else(|| "request failed".to_string()))
}

fn read_response_limited(
    response: &mut Response,
    max_bytes: usize,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        if should_cancel() {
            return Err("interrupted web response".to_string());
        }
        let read = response
            .read(&mut chunk)
            .map_err(|error| format!("response_read {error}"))?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > max_bytes {
            return Err(format!(
                "response_too_large response exceeds {max_bytes} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(bytes)
}

fn retry_after_delay(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn cooperative_sleep(duration: Duration, should_cancel: &dyn Fn() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if should_cancel() {
            return Err("interrupted web retry backoff".to_string());
        }
        thread::sleep((deadline - Instant::now()).min(Duration::from_millis(100)));
    }
    Ok(())
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS
        || matches!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR
                | StatusCode::BAD_GATEWAY
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT
        )
}

fn normalize_fetch_url(url: &str, allow_private: bool) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    validate_network_url(&parsed, allow_private)?;
    Ok(parsed)
}

fn validate_network_url(url: &Url, allow_private: bool) -> Result<(), String> {
    validated_network_addresses(url, allow_private).map(|_| ())
}

fn validated_network_addresses(url: &Url, allow_private: bool) -> Result<Vec<SocketAddr>, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "invalid_url only http and https URLs are supported, got {:?}",
            url.scheme()
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "invalid_url URL has no host".to_string())?;
    let lower = host.to_ascii_lowercase();
    if !allow_private
        && (lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local"))
    {
        return Err("private_network local hostnames are blocked".to_string());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "invalid_url URL has no usable port".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !allow_private && !ip_is_public(ip) {
            return Err(format!("private_network address {ip} is blocked"));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let resolved = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("dns_error failed to resolve {host}: {error}"))?
        .collect::<Vec<_>>();
    if resolved.is_empty() {
        return Err(format!("dns_error {host} resolved to no addresses"));
    }
    if !allow_private && resolved.iter().any(|address| !ip_is_public(address.ip())) {
        return Err(format!(
            "private_network {host} resolved to a blocked private or reserved address"
        ));
    }
    Ok(resolved)
}

fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ipv4_is_public(ip),
        IpAddr::V6(ip) => ipv6_is_public(ip),
    }
}

fn ipv4_is_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && matches!(b, 18 | 19)))
}

fn ipv6_is_public(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return ipv4_is_public(mapped);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn normalize_provider_request(providers: Option<&[String]>) -> Result<Vec<String>, String> {
    let mut values = providers.map_or_else(
        || vec!["auto".to_string()],
        |items| {
            items
                .iter()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        },
    );
    if values.is_empty() {
        values.push("auto".to_string());
    }
    values.sort();
    values.dedup();
    for value in &values {
        if !matches!(
            value.as_str(),
            "auto" | "all" | "custom" | "brave" | "exa" | "duckduckgo" | "ddg"
        ) {
            return Err(format!(
                "web_search_error:invalid_provider unsupported provider {value:?}"
            ));
        }
    }
    if values.len() > 1
        && values
            .iter()
            .any(|value| matches!(value.as_str(), "auto" | "all"))
    {
        return Err(
            "web_search_error:invalid_provider auto and all cannot be combined with another provider"
                .to_string(),
        );
    }
    Ok(values)
}

fn resolve_provider_candidates(requested: &[String]) -> Result<Vec<WebProvider>, String> {
    if requested.iter().any(|name| name == "auto") {
        let mut providers = Vec::new();
        if let Some(provider) = configured_custom_provider()? {
            providers.push(provider);
        }
        if let Ok(key) = std::env::var("BRAVE_SEARCH_API_KEY") {
            if !key.trim().is_empty() {
                providers.push(WebProvider::Brave {
                    api_key: key.trim().to_string(),
                });
            }
        }
        if let Ok(key) = std::env::var("EXA_API_KEY") {
            if !key.trim().is_empty() {
                providers.push(WebProvider::Exa {
                    api_key: key.trim().to_string(),
                });
            }
        }
        providers.push(WebProvider::DuckDuckGo);
        return Ok(providers);
    }
    if requested.iter().any(|name| name == "all") {
        let mut names = vec!["custom", "brave", "exa", "duckduckgo"];
        return resolve_named_providers(&names.drain(..).map(str::to_string).collect::<Vec<_>>());
    }
    resolve_named_providers(requested)
}

fn resolve_named_providers(names: &[String]) -> Result<Vec<WebProvider>, String> {
    let mut providers = Vec::new();
    for name in names {
        match name.as_str() {
            "custom" => {
                if let Some(provider) = configured_custom_provider()? {
                    providers.push(provider);
                }
            }
            "brave" => {
                if let Ok(key) = std::env::var("BRAVE_SEARCH_API_KEY") {
                    if !key.trim().is_empty() {
                        providers.push(WebProvider::Brave {
                            api_key: key.trim().to_string(),
                        });
                    }
                }
            }
            "exa" => {
                if let Ok(key) = std::env::var("EXA_API_KEY") {
                    if !key.trim().is_empty() {
                        providers.push(WebProvider::Exa {
                            api_key: key.trim().to_string(),
                        });
                    }
                }
            }
            "duckduckgo" | "ddg" => providers.push(WebProvider::DuckDuckGo),
            "auto" | "all" => {}
            _ => {}
        }
    }
    Ok(providers)
}

fn unavailable_provider_attempts(requested: &[String]) -> Vec<WebSourceAttempt> {
    if requested.iter().any(|name| name == "auto") {
        return Vec::new();
    }
    let checks = [
        (
            "custom",
            std::env::var("ARIS_WEB_SEARCH_BASE_URL")
                .or_else(|_| std::env::var("CLAWD_WEB_SEARCH_BASE_URL"))
                .is_ok(),
            "ARIS_WEB_SEARCH_BASE_URL is not configured",
        ),
        (
            "brave",
            std::env::var("BRAVE_SEARCH_API_KEY").is_ok_and(|value| !value.trim().is_empty()),
            "BRAVE_SEARCH_API_KEY is not configured",
        ),
        (
            "exa",
            std::env::var("EXA_API_KEY").is_ok_and(|value| !value.trim().is_empty()),
            "EXA_API_KEY is not configured",
        ),
    ];
    checks
        .into_iter()
        .filter(|(name, available, _)| {
            !*available
                && (requested.iter().any(|requested| requested == *name)
                    || requested.iter().any(|requested| requested == "all"))
        })
        .map(|(name, _, reason)| WebSourceAttempt {
            provider: name.to_string(),
            status: "skipped".to_string(),
            query_variant_count: 0,
            coverage: runtime::SearchCoverage {
                total_hits: None,
                fetched: 0,
                unique: 0,
                exhausted: false,
                next_cursor: None,
                truncated_reason: Some("missing_credentials".to_string()),
            },
            error: Some(reason.to_string()),
        })
        .collect()
}

fn configured_custom_provider() -> Result<Option<WebProvider>, String> {
    let base = std::env::var("ARIS_WEB_SEARCH_BASE_URL")
        .or_else(|_| std::env::var("CLAWD_WEB_SEARCH_BASE_URL"))
        .ok();
    base.map(|value| {
        let base = Url::parse(&value)
            .map_err(|error| format!("web_search_error:invalid_backend {error}"))?;
        let allow_private = validated_network_addresses(&base, true)?
            .iter()
            .any(|address| !ip_is_public(address.ip()));
        Ok(WebProvider::Custom {
            base,
            allow_private,
        })
    })
    .transpose()
}

fn validate_pagination_origin(url: &Url, base: &Url) -> Result<(), String> {
    let same_origin = url.scheme() == base.scheme()
        && url.host_str().map(str::to_ascii_lowercase)
            == base.host_str().map(str::to_ascii_lowercase)
        && url.port_or_known_default() == base.port_or_known_default();
    if same_origin {
        Ok(())
    } else {
        Err(format!(
            "web_search_error:invalid_cursor pagination URL escaped the configured provider origin {}",
            base.origin().ascii_serialization()
        ))
    }
}

fn plan_web_query_variants(
    query: &str,
    language: Option<&str>,
) -> Vec<runtime::SearchQueryVariant> {
    let mut variants = Vec::new();
    let mut seen = BTreeSet::new();
    push_query_variant(
        &mut variants,
        &mut seen,
        "original",
        query,
        "Caller-supplied query, preserved verbatim after whitespace normalization.",
    );

    let broad = broad_web_query(query);
    if broad != query {
        push_query_variant(
            &mut variants,
            &mut seen,
            "broad_keywords",
            &broad,
            "Question framing and low-information terms removed for broader recall.",
        );
    }
    let expanded = expand_common_research_aliases(&broad);
    if expanded != broad {
        push_query_variant(
            &mut variants,
            &mut seen,
            "synonym_expansion",
            &expanded,
            "Common research abbreviations and aliases expanded.",
        );
    }
    let word_count = broad.split_whitespace().count();
    if (2..=10).contains(&word_count) && !broad.contains('"') {
        push_query_variant(
            &mut variants,
            &mut seen,
            "exact_phrase",
            &format!("\"{broad}\""),
            "Exact phrase supplement; never used as the only query.",
        );
    }
    if language.is_some_and(|value| value.eq_ignore_ascii_case("zh")) || query.chars().any(is_cjk) {
        let bilingual = bilingual_research_aliases(&broad);
        if bilingual != broad {
            push_query_variant(
                &mut variants,
                &mut seen,
                "language_aliases",
                &bilingual,
                "Common Chinese/English research terminology expanded across languages.",
            );
        }
    }
    variants.truncate(4);
    variants
}

fn push_query_variant(
    variants: &mut Vec<runtime::SearchQueryVariant>,
    seen: &mut BTreeSet<String>,
    kind: &str,
    query: &str,
    rationale: &str,
) {
    let query = collapse_whitespace(query);
    let key = query.to_lowercase();
    if query.chars().count() >= 2 && seen.insert(key) {
        variants.push(runtime::SearchQueryVariant {
            kind: kind.to_string(),
            query,
            rationale: rationale.to_string(),
        });
    }
}

fn broad_web_query(query: &str) -> String {
    const STOPWORDS: &[&str] = &[
        "what",
        "which",
        "who",
        "when",
        "where",
        "why",
        "how",
        "is",
        "are",
        "was",
        "were",
        "the",
        "a",
        "an",
        "of",
        "for",
        "to",
        "please",
        "find",
        "search",
        "show",
        "tell",
        "me",
        "about",
        "latest",
        "current",
        "information",
        "什么",
        "哪些",
        "如何",
        "为什么",
        "请",
        "帮我",
        "搜索",
        "查找",
        "看看",
        "关于",
        "目前",
        "现在",
    ];
    let cleaned = query
        .replace(['?', '？', '!', '！', ',', '，', ';', '；', ':', '：'], " ")
        .split_whitespace()
        .filter(|token| {
            let lower = token
                .trim_matches(['"', '\'', '(', ')', '[', ']', '{', '}'])
                .to_lowercase();
            !STOPWORDS.contains(&lower.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = collapse_whitespace(&cleaned);
    if cleaned.chars().count() >= 2 {
        cleaned
    } else {
        query.to_string()
    }
}

fn expand_common_research_aliases(query: &str) -> String {
    let mut expanded = query.to_string();
    const ALIASES: &[(&str, &str)] = &[
        (" LLM ", " (LLM OR \"large language model\") "),
        (" RAG ", " (RAG OR \"retrieval augmented generation\") "),
        (" AI ", " (AI OR \"artificial intelligence\") "),
        (" ML ", " (ML OR \"machine learning\") "),
        (" NLP ", " (NLP OR \"natural language processing\") "),
        (" CV ", " (CV OR \"computer vision\") "),
    ];
    let padded = format!(" {expanded} ");
    let mut next = padded;
    for (needle, replacement) in ALIASES {
        next = replace_ascii_case_insensitive(&next, needle, replacement);
    }
    expanded = collapse_whitespace(&next);
    expanded
}

fn bilingual_research_aliases(query: &str) -> String {
    let mut expanded = query.to_string();
    const TERMS: &[(&str, &str)] = &[
        ("大语言模型", "\"large language model\""),
        ("大模型", "\"large language model\""),
        ("人工智能", "\"artificial intelligence\""),
        ("机器学习", "\"machine learning\""),
        ("深度学习", "\"deep learning\""),
        ("检索增强生成", "\"retrieval augmented generation\""),
        ("知识图谱", "\"knowledge graph\""),
        ("计算机视觉", "\"computer vision\""),
        ("自然语言处理", "\"natural language processing\""),
    ];
    for (source, target) in TERMS {
        if expanded.contains(source) && !expanded.contains(target) {
            expanded.push_str(" OR ");
            expanded.push_str(target);
        }
    }
    collapse_whitespace(&expanded)
}

fn replace_ascii_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower = haystack.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let mut output = String::new();
    let mut start = 0;
    while let Some(relative) = lower[start..].find(&needle_lower) {
        let index = start + relative;
        output.push_str(&haystack[start..index]);
        output.push_str(replacement);
        start = index + needle.len();
    }
    output.push_str(&haystack[start..]);
    output
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
    )
}

fn query_with_domain_filters(query: &str, input: &WebSearchInput) -> String {
    let mut result = query.to_string();
    if let Some(domains) = clean_domain_filters(input.allowed_domains.as_deref()) {
        let site_clause = domains
            .into_iter()
            .map(|domain| format!("site:{domain}"))
            .collect::<Vec<_>>()
            .join(" OR ");
        if !site_clause.is_empty() {
            result = format!("({result}) ({site_clause})");
        }
    }
    if let Some(domains) = clean_domain_filters(input.blocked_domains.as_deref()) {
        for domain in domains {
            result.push_str(&format!(" -site:{domain}"));
        }
    }
    result
}

fn validate_domain_filters(domains: Option<&[String]>) -> Result<(), String> {
    if let Some(domains) = domains {
        if domains.len() > 100 {
            return Err(
                "web_search_error:invalid_domains at most 100 domains are supported".into(),
            );
        }
        for domain in domains {
            let normalized = normalize_domain_filter(domain);
            if normalized.is_empty()
                || normalized.contains([' ', '/', '?', '#'])
                || !normalized.contains('.')
            {
                return Err(format!(
                    "web_search_error:invalid_domains invalid domain filter {domain:?}"
                ));
            }
        }
    }
    Ok(())
}

fn clean_domain_filters(domains: Option<&[String]>) -> Option<Vec<String>> {
    let mut values = domains?
        .iter()
        .map(|domain| normalize_domain_filter(domain))
        .filter(|domain| !domain.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    (!values.is_empty()).then_some(values)
}

fn apply_domain_filters(hits: &mut Vec<RawSearchHit>, input: &WebSearchInput) {
    if let Some(allowed) = input
        .allowed_domains
        .as_deref()
        .and_then(|domains| (!domains.is_empty()).then_some(domains))
    {
        hits.retain(|hit| host_matches_list(&hit.url, allowed));
    }
    if let Some(blocked) = input
        .blocked_domains
        .as_deref()
        .and_then(|domains| (!domains.is_empty()).then_some(domains))
    {
        hits.retain(|hit| !host_matches_list(&hit.url, blocked));
    }
}

fn stream_key(provider: &str, variant: &runtime::SearchQueryVariant) -> String {
    format!("{provider}:{}:{}", variant.kind, variant.query)
}

fn web_search_query_key(
    input: &WebSearchInput,
    max_results: usize,
    providers: &[String],
    variants: &[runtime::SearchQueryVariant],
) -> String {
    let custom_base = std::env::var("ARIS_WEB_SEARCH_BASE_URL")
        .or_else(|_| std::env::var("CLAWD_WEB_SEARCH_BASE_URL"))
        .unwrap_or_default();
    serde_json::to_string(&json!({
        "schemaVersion": WEB_SEARCH_SCHEMA_VERSION,
        "query": collapse_whitespace(&input.query).to_lowercase(),
        "allowedDomains": normalized_domain_key(input.allowed_domains.as_deref()),
        "blockedDomains": normalized_domain_key(input.blocked_domains.as_deref()),
        "maxResults": max_results,
        "providers": providers,
        "customBase": custom_base,
        "language": input.language.as_deref().unwrap_or_default().trim().to_lowercase(),
        "variants": variants
            .iter()
            .map(|variant| (
                variant.kind.to_lowercase(),
                collapse_whitespace(&variant.query).to_lowercase()
            ))
            .collect::<Vec<_>>()
    }))
    .unwrap_or_default()
}

fn parse_search_cursor(cursor: Option<&str>) -> Result<Option<WebSearchCursor>, String> {
    cursor
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            serde_json::from_str(value)
                .map_err(|error| format!("web_search_error:invalid_cursor {error}"))
        })
        .transpose()
}

fn distribute_budget(total: usize, streams: usize) -> Vec<usize> {
    if streams == 0 {
        return Vec::new();
    }
    let base = total / streams;
    let remainder = total % streams;
    (0..streams)
        .map(|index| base + usize::from(index < remainder))
        .collect()
}

fn fuse_search_hits(raw_hits: Vec<RawSearchHit>, max_results: usize) -> Vec<SearchHit> {
    #[derive(Debug)]
    struct Fused {
        hit: SearchHit,
        first_seen: usize,
        best_rank: usize,
    }
    let mut index_by_url = BTreeMap::<String, usize>::new();
    let mut fused = Vec::<Fused>::new();
    for (first_seen, raw) in raw_hits.into_iter().enumerate() {
        let key = canonical_url_key(&raw.url);
        if key.is_empty() {
            continue;
        }
        let contribution = rrf_score_micros(raw.source_rank);
        if let Some(index) = index_by_url.get(&key).copied() {
            let item = &mut fused[index];
            item.hit
                .source_ranks
                .entry(raw.stream)
                .and_modify(|rank| *rank = (*rank).min(raw.source_rank))
                .or_insert(raw.source_rank);
            item.hit.fused_score_micros = item.hit.fused_score_micros.saturating_add(contribution);
            item.best_rank = item.best_rank.min(raw.source_rank);
            if item.hit.snippet.is_empty() && !raw.snippet.is_empty() {
                item.hit.snippet = raw.snippet;
            }
            if item.hit.published_date.is_none() {
                item.hit.published_date = raw.published_date;
            }
            if !item
                .hit
                .provider
                .split(',')
                .any(|name| name == raw.provider)
            {
                item.hit.provider.push(',');
                item.hit.provider.push_str(&raw.provider);
            }
        } else {
            let mut source_ranks = BTreeMap::new();
            source_ranks.insert(raw.stream, raw.source_rank);
            let index = fused.len();
            index_by_url.insert(key, index);
            fused.push(Fused {
                hit: SearchHit {
                    title: raw.title,
                    url: raw.url,
                    snippet: raw.snippet,
                    provider: raw.provider,
                    rank: 0,
                    source_ranks,
                    fused_score_micros: contribution,
                    published_date: raw.published_date,
                },
                first_seen,
                best_rank: raw.source_rank,
            });
        }
    }
    fused.sort_by(|left, right| {
        right
            .hit
            .fused_score_micros
            .cmp(&left.hit.fused_score_micros)
            .then_with(|| left.best_rank.cmp(&right.best_rank))
            .then_with(|| left.first_seen.cmp(&right.first_seen))
    });
    fused
        .into_iter()
        .take(max_results)
        .enumerate()
        .map(|(index, mut item)| {
            item.hit.rank = index + 1;
            item.hit
        })
        .collect()
}

fn rrf_score_micros(rank: usize) -> u64 {
    (1_000_000_f64 / (60 + rank.max(1)) as f64).round() as u64
}

fn canonical_url_key(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.trim().to_lowercase();
    };
    parsed.set_fragment(None);
    if parsed.scheme() == "http" {
        let _ = parsed.set_scheme("https");
    }
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let _ = parsed.set_host(Some(&host));
    if (parsed.scheme() == "https" && parsed.port() == Some(443))
        || (parsed.scheme() == "http" && parsed.port() == Some(80))
    {
        let _ = parsed.set_port(None);
    }
    let mut pairs = parsed
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !key.starts_with("utm_")
                && !matches!(
                    key.as_str(),
                    "gclid" | "fbclid" | "msclkid" | "mc_cid" | "mc_eid"
                )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.sort();
    parsed.set_query(None);
    if !pairs.is_empty() {
        parsed.query_pairs_mut().extend_pairs(pairs);
    }
    if parsed.path().len() > 1 && parsed.path().ends_with('/') {
        let trimmed = parsed.path().trim_end_matches('/').to_string();
        parsed.set_path(&trimmed);
    }
    parsed.to_string()
}

fn aggregate_truncated_reason(
    attempts: &[WebSourceAttempt],
    unique: usize,
    max_results: usize,
    exhausted: bool,
    has_cursor: bool,
) -> Option<String> {
    if exhausted {
        return None;
    }
    let mut reasons = attempts
        .iter()
        .filter_map(|attempt| attempt.coverage.truncated_reason.as_deref())
        .flat_map(|reason| reason.split(','))
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    if unique >= max_results || has_cursor {
        reasons.insert("max_results".to_string());
    }
    if reasons.is_empty() {
        reasons.insert("incomplete_coverage".to_string());
    }
    Some(reasons.into_iter().collect::<Vec<_>>().join(","))
}

fn web_search_cache_get(key: &WebSearchCacheKey) -> Option<WebSearchOutput> {
    let now = Instant::now();
    let mut cache = WEB_SEARCH_CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|entry| now.duration_since(entry.inserted_at) < WEB_SEARCH_CACHE_TTL);
    let index = cache.iter().position(|entry| entry.key == *key)?;
    let entry = cache.remove(index)?;
    let output = entry.output.clone();
    cache.push_back(entry);
    Some(output)
}

fn web_search_cache_put(key: WebSearchCacheKey, output: WebSearchOutput) {
    let mut cache = WEB_SEARCH_CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(index) = cache.iter().position(|entry| entry.key == key) {
        cache.remove(index);
    }
    while cache.len() >= WEB_SEARCH_CACHE_CAPACITY {
        cache.pop_front();
    }
    cache.push_back(WebSearchCacheEntry {
        key,
        inserted_at: Instant::now(),
        output,
    });
}

fn extract_generic_json_hits(
    body: &str,
    provider: &str,
    stream: &str,
) -> Result<(Vec<RawSearchHit>, Option<u64>, Option<String>), String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| format!("web_search_error:decode invalid search JSON: {error}"))?;
    let items = value["results"]
        .as_array()
        .or_else(|| value["items"].as_array())
        .or_else(|| value["web"]["results"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut hits = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(url) = item["url"]
            .as_str()
            .or_else(|| item["link"].as_str())
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        hits.push(RawSearchHit {
            title: item["title"].as_str().unwrap_or(url).to_string(),
            url: url.to_string(),
            snippet: preview_text(
                &collapse_whitespace(
                    item["snippet"]
                        .as_str()
                        .or_else(|| item["description"].as_str())
                        .unwrap_or(""),
                ),
                SEARCH_SNIPPET_MAX_CHARS,
            ),
            provider: provider.to_string(),
            source_rank: index + 1,
            stream: stream.to_string(),
            published_date: item["publishedDate"]
                .as_str()
                .or_else(|| item["published_date"].as_str())
                .map(str::to_string),
        });
    }
    let total = value["total"]
        .as_u64()
        .or_else(|| value["totalHits"].as_u64())
        .or_else(|| value["total_hits"].as_u64());
    let next = value["nextCursor"]
        .as_str()
        .or_else(|| value["next_cursor"].as_str())
        .or_else(|| value["next"].as_str())
        .map(str::to_string);
    Ok((hits, total, next))
}

pub(crate) fn extract_search_hits(html: &str, provider: &str, stream: &str) -> Vec<RawSearchHit> {
    let mut hits = Vec::new();
    let mut remaining = html;

    while let Some(anchor_start) = remaining.find("result__a") {
        let after_class = &remaining[anchor_start..];
        let Some(href_idx) = after_class.find("href=") else {
            remaining = &after_class[1..];
            continue;
        };
        let href_slice = &after_class[href_idx + 5..];
        let Some((url, rest)) = extract_quoted_value(href_slice) else {
            remaining = &after_class[1..];
            continue;
        };
        let Some(close_tag_idx) = rest.find('>') else {
            remaining = &after_class[1..];
            continue;
        };
        let after_tag = &rest[close_tag_idx + 1..];
        let Some(end_anchor_idx) = after_tag.find("</a>") else {
            break;
        };
        let title = html_to_text(&after_tag[..end_anchor_idx]);
        let tail = &after_tag[end_anchor_idx + 4..];
        let block_end = tail.find("result__a").unwrap_or(tail.len());
        let snippet = extract_class_text(&tail[..block_end], "result__snippet").unwrap_or_default();
        if let Some(decoded_url) = decode_duckduckgo_redirect(&url) {
            hits.push(RawSearchHit {
                title: title.trim().to_string(),
                url: decoded_url,
                snippet,
                provider: provider.to_string(),
                source_rank: hits.len() + 1,
                stream: stream.to_string(),
                published_date: None,
            });
        }
        remaining = tail;
    }
    hits
}

fn extract_search_hits_from_generic_links(
    html: &str,
    provider: &str,
    stream: &str,
) -> Vec<RawSearchHit> {
    let mut hits = Vec::new();
    let mut remaining = html;
    while let Some(anchor_start) = find_ascii_case_insensitive(remaining, "<a") {
        let after_anchor = &remaining[anchor_start..];
        let Some(href_idx) = find_ascii_case_insensitive(after_anchor, "href=") else {
            remaining = &after_anchor[2..];
            continue;
        };
        let href_slice = &after_anchor[href_idx + 5..];
        let Some((url, rest)) = extract_quoted_value(href_slice) else {
            remaining = &after_anchor[2..];
            continue;
        };
        let Some(close_tag_idx) = rest.find('>') else {
            remaining = &after_anchor[2..];
            continue;
        };
        let after_tag = &rest[close_tag_idx + 1..];
        let Some(end_anchor_idx) = find_ascii_case_insensitive(after_tag, "</a>") else {
            break;
        };
        let title = html_to_text(&after_tag[..end_anchor_idx]);
        let tail = &after_tag[end_anchor_idx + 4..];
        if title.trim().is_empty() {
            remaining = tail;
            continue;
        }
        let decoded_url = decode_duckduckgo_redirect(&url).unwrap_or(url);
        if decoded_url.starts_with("http://") || decoded_url.starts_with("https://") {
            let block_end = find_ascii_case_insensitive(tail, "<a").unwrap_or(tail.len());
            let snippet = collapse_whitespace(&html_to_text(&tail[..block_end]));
            hits.push(RawSearchHit {
                title: title.trim().to_string(),
                url: decoded_url,
                snippet: preview_text(&snippet, SEARCH_SNIPPET_MAX_CHARS),
                provider: provider.to_string(),
                source_rank: hits.len() + 1,
                stream: stream.to_string(),
                published_date: None,
            });
        }
        remaining = tail;
    }
    hits
}

fn extract_class_text(region: &str, class_marker: &str) -> Option<String> {
    let marker_idx = region.find(class_marker)?;
    let open_idx = region[..marker_idx].rfind('<')?;
    let after_open = &region[open_idx..];
    let tag = after_open[1..]
        .split(|ch: char| ch.is_whitespace() || ch == '>')
        .next()?;
    if tag.is_empty() {
        return None;
    }
    let content_start = after_open.find('>')? + 1;
    let content = &after_open[content_start..];
    let end = find_ascii_case_insensitive(content, &format!("</{tag}"))?;
    let text = collapse_whitespace(&html_to_text(&content[..end]));
    (!text.is_empty()).then(|| preview_text(&text, SEARCH_SNIPPET_MAX_CHARS))
}

fn extract_next_search_url(html: &str, current_url: &Url) -> Option<Url> {
    let next_marker = ["value=\"Next\"", "value='Next'", "result--more__btn"]
        .iter()
        .filter_map(|marker| find_ascii_case_insensitive(html, marker))
        .min()?;
    let form_start = html[..next_marker].to_ascii_lowercase().rfind("<form")?;
    let form_end = find_ascii_case_insensitive(&html[next_marker..], "</form>")
        .map(|relative| next_marker + relative + "</form>".len())?;
    let form = &html[form_start..form_end];
    let open_end = form.find('>')?;
    let action = extract_html_attribute(&form[..=open_end], "action").unwrap_or_default();
    let mut next = if action.is_empty() {
        current_url.clone()
    } else {
        current_url.join(&decode_html_entities(&action)).ok()?
    };
    next.set_query(None);
    let mut inputs = form;
    while let Some(index) = find_ascii_case_insensitive(inputs, "<input") {
        let after = &inputs[index..];
        let Some(end) = after.find('>') else {
            break;
        };
        let tag = &after[..=end];
        if let (Some(name), Some(value)) = (
            extract_html_attribute(tag, "name"),
            extract_html_attribute(tag, "value"),
        ) {
            if !name.eq_ignore_ascii_case("submit") {
                next.query_pairs_mut()
                    .append_pair(&decode_html_entities(&name), &decode_html_entities(&value));
            }
        }
        inputs = &after[end + 1..];
    }
    Some(next)
}

fn extract_html_attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative) = lower[search_from..].find(name) {
        let index = search_from + relative;
        let before_ok = index == 0
            || lower[..index]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_whitespace() || ch == '<');
        let after_name = index + name.len();
        let after = &tag[after_name..];
        let trimmed = after.trim_start();
        if before_ok && trimmed.starts_with('=') {
            return extract_quoted_value(trimmed[1..].trim_start()).map(|(value, _)| value);
        }
        search_from = after_name;
    }
    None
}

fn extract_quoted_value(input: &str) -> Option<(String, &str)> {
    let quote = input.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &input[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some((rest[..end].to_string(), &rest[end + quote.len_utf8()..]))
}

fn decode_duckduckgo_redirect(url: &str) -> Option<String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Some(decode_html_entities(url));
    }
    let (joined, was_site_relative) = if url.starts_with("//") {
        (format!("https:{url}"), false)
    } else if url.starts_with('/') {
        (format!("https://duckduckgo.com{url}"), true)
    } else {
        return None;
    };
    let parsed = Url::parse(&joined).ok()?;
    if parsed.path() == "/l/" || parsed.path() == "/l" {
        for (key, value) in parsed.query_pairs() {
            if key == "uddg" {
                return Some(decode_html_entities(value.as_ref()));
            }
        }
    }
    if was_site_relative {
        return None;
    }
    Some(joined)
}

fn detect_search_challenge(html: &str) -> Option<&'static str> {
    const MARKERS: &[&str] = &[
        "anomaly-modal",
        "challenge-form",
        "cf-browser-verification",
        "challenge-running",
        "captcha",
        "unfortunately, bots use duckduckgo too",
    ];
    let lower = html.to_ascii_lowercase();
    MARKERS
        .iter()
        .copied()
        .find(|marker| lower.contains(marker))
}

fn search_page_declares_no_results(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    [
        "result--no-result",
        "no results found",
        "no results.",
        "did not match any documents",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn web_search_status_error(status: StatusCode, html: &str) -> String {
    let kind = if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limited"
    } else if status.is_server_error() {
        "upstream_unavailable"
    } else if detect_search_challenge(html).is_some() {
        "blocked"
    } else if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        "unauthorized"
    } else {
        "http_error"
    };
    format!("web_search_error:{kind} search backend returned HTTP {status}")
}

fn classify_web_error(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "network"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
    };
    format!("{kind} {error}")
}

fn host_matches_list(url: &str, domains: &[String]) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    domains.iter().any(|domain| {
        let normalized = normalize_domain_filter(domain);
        !normalized.is_empty() && (host == normalized || host.ends_with(&format!(".{normalized}")))
    })
}

fn normalize_domain_filter(domain: &str) -> String {
    let trimmed = domain.trim();
    let candidate = Url::parse(trimmed)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| trimmed.to_string());
    candidate
        .trim()
        .trim_start_matches("*.")
        .trim_start_matches('.')
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn normalized_domain_key(domains: Option<&[String]>) -> Vec<String> {
    let mut list = domains.map_or_else(Vec::new, |items| {
        items
            .iter()
            .map(|domain| normalize_domain_filter(domain))
            .collect::<Vec<_>>()
    });
    list.sort();
    list.dedup();
    list
}

fn dedupe_raw_hits(hits: &mut Vec<RawSearchHit>) {
    let mut seen = BTreeSet::new();
    hits.retain(|hit| seen.insert(canonical_url_key(&hit.url)));
}

fn web_cursor_url_key(url: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in canonical_url_key(url).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub(crate) fn is_provider_navigation_hit(hit: &RawSearchHit) -> bool {
    if hit.provider != "duckduckgo" {
        return false;
    }
    let Ok(url) = Url::parse(&hit.url) else {
        return false;
    };
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    if host != "duckduckgo.com" && host != "www.duckduckgo.com" && host != "html.duckduckgo.com" {
        return false;
    }
    matches!(
        url.path()
            .trim_end_matches('/')
            .to_ascii_lowercase()
            .as_str(),
        "/feedback" | "/feedback.html" | "/settings" | "/about" | "/privacy" | "/terms" | "/spread"
    )
}

fn normalize_fetched_content(body: &str, content_type: &str) -> String {
    if content_type.contains("html") || body.trim_start().starts_with("<!DOCTYPE html") {
        let readable = extract_readable_region(body).unwrap_or(body);
        html_to_text(readable)
    } else if content_type.contains("json") {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| serde_json::to_string_pretty(&value).ok())
            .unwrap_or_else(|| body.trim().to_string())
    } else if content_type.contains("xml") {
        html_to_text(body)
    } else {
        body.trim().to_string()
    }
}

fn extract_readable_region(html: &str) -> Option<&str> {
    for tag in ["article", "main", "body"] {
        if let Some(region) = extract_first_element(html, tag) {
            if region.chars().count() >= 120 {
                return Some(region);
            }
        }
    }
    None
}

fn extract_first_element<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    let open = find_ascii_case_insensitive(html, &format!("<{tag}"))?;
    let content_start = html[open..].find('>')? + open + 1;
    let close_relative = find_ascii_case_insensitive(&html[content_start..], &format!("</{tag}>"))?;
    Some(&html[content_start..content_start + close_relative])
}

pub(crate) fn html_to_text(html: &str) -> String {
    const SKIP_TAGS: &[&str] = &[
        "script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form",
        "template",
    ];
    const BLOCK_TAGS: &[&str] = &[
        "p",
        "div",
        "section",
        "article",
        "main",
        "li",
        "ul",
        "ol",
        "table",
        "tr",
        "td",
        "th",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "br",
        "blockquote",
        "pre",
        "hr",
    ];
    let mut output = String::with_capacity(html.len().min(64 * 1024));
    let mut position = 0;
    let mut skipped: Option<String> = None;
    while position < html.len() {
        let Some(relative_open) = html[position..].find('<') else {
            if skipped.is_none() {
                output.push_str(&html[position..]);
            }
            break;
        };
        let open = position + relative_open;
        if skipped.is_none() {
            output.push_str(&html[position..open]);
        }
        if html[open..].starts_with("<!--") {
            if let Some(relative_end) = html[open + 4..].find("-->") {
                position = open + 4 + relative_end + 3;
                continue;
            }
            break;
        }
        let Some(relative_close) = html[open..].find('>') else {
            break;
        };
        let close = open + relative_close;
        let raw_tag = html[open + 1..close].trim();
        let closing = raw_tag.starts_with('/');
        let tag = raw_tag
            .trim_start_matches('/')
            .split(|ch: char| ch.is_whitespace() || matches!(ch, '/' | '>'))
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if let Some(skipped_tag) = skipped.as_deref() {
            if closing && tag == skipped_tag {
                skipped = None;
                output.push('\n');
            }
        } else if !closing && SKIP_TAGS.contains(&tag.as_str()) {
            skipped = Some(tag);
        } else if BLOCK_TAGS.contains(&tag.as_str()) {
            output.push('\n');
        }
        position = close + 1;
    }
    decode_html_entities(&output)
        .lines()
        .map(collapse_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn decode_html_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(index) = remaining.find('&') {
        output.push_str(&remaining[..index]);
        let after = &remaining[index + 1..];
        let Some(end) = after.find(';').filter(|end| *end <= 12) else {
            output.push('&');
            remaining = after;
            continue;
        };
        let entity = &after[..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "ndash" => Some('–'),
            "mdash" => Some('—'),
            "hellip" => Some('…'),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(ch) = decoded {
            output.push(ch);
        } else {
            output.push('&');
            output.push_str(entity);
            output.push(';');
        }
        remaining = &after[end + 1..];
    }
    output.push_str(remaining);
    output
}

fn extract_title(content: &str, raw_body: &str, content_type: &str) -> Option<String> {
    if content_type.contains("html") || raw_body.trim_start().starts_with('<') {
        for marker in ["property=\"og:title\"", "name=\"twitter:title\""] {
            if let Some(index) = find_ascii_case_insensitive(raw_body, marker) {
                let open = raw_body[..index].rfind('<')?;
                let close = raw_body[index..].find('>')? + index;
                if let Some(value) = extract_html_attribute(&raw_body[open..=close], "content") {
                    let title = collapse_whitespace(&decode_html_entities(&value));
                    if !title.is_empty() {
                        return Some(title);
                    }
                }
            }
        }
        if let Some(start) = find_ascii_case_insensitive(raw_body, "<title>") {
            let after = start + "<title>".len();
            if let Some(end_relative) = find_ascii_case_insensitive(&raw_body[after..], "</title>")
            {
                let title = collapse_whitespace(&decode_html_entities(
                    &raw_body[after..after + end_relative],
                ));
                if !title.is_empty() {
                    return Some(title);
                }
            }
        }
    }
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn summarize_web_fetch(
    url: &str,
    prompt: &str,
    content: &str,
    title: Option<&str>,
    max_chars: usize,
) -> (String, String, bool) {
    let prompt_lower = prompt.to_lowercase();
    let asks_title = ["title", "page name", "标题", "题目", "网页名称"]
        .iter()
        .any(|marker| prompt_lower.contains(marker));
    if asks_title {
        let value = title.unwrap_or_else(|| content.lines().next().unwrap_or("Unknown"));
        return (
            format!("Fetched {url}\nTitle: {value}"),
            "title".to_string(),
            false,
        );
    }

    let terms = relevance_terms(prompt);
    let mut candidates = content
        .split('\n')
        .map(str::trim)
        .filter(|paragraph| paragraph.chars().count() >= 8)
        .enumerate()
        .map(|(index, paragraph)| {
            let lower = paragraph.to_lowercase();
            let score = terms
                .iter()
                .map(|term| usize::from(lower.contains(term)) * term.chars().count().max(1))
                .sum::<usize>();
            (score, index, paragraph)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let has_relevant = candidates.first().is_some_and(|candidate| candidate.0 > 0);
    if has_relevant {
        candidates.truncate(8);
        candidates.sort_by_key(|candidate| candidate.1);
    } else {
        candidates.truncate(6);
    }
    let selected = candidates
        .into_iter()
        .map(|(_, _, paragraph)| paragraph)
        .collect::<Vec<_>>()
        .join("\n\n");
    let fallback = if selected.is_empty() {
        content
    } else {
        selected.as_str()
    };
    let excerpt = preview_text(fallback, max_chars);
    let truncated = fallback.chars().count() > max_chars || content.chars().count() > max_chars;
    let mut result = format!("Fetched {url}\n");
    if let Some(title) = title {
        result.push_str(&format!("Title: {title}\n"));
    }
    result.push_str(if has_relevant {
        "Relevant passages:\n"
    } else {
        "Readable content preview:\n"
    });
    result.push_str(&excerpt);
    (
        result,
        if has_relevant {
            "prompt_relevant_passages"
        } else {
            "readable_text"
        }
        .to_string(),
        truncated,
    )
}

fn relevance_terms(text: &str) -> BTreeSet<String> {
    let lower = text.to_lowercase();
    let mut terms = lower
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2)
        .filter(|term| {
            !matches!(
                *term,
                "what"
                    | "which"
                    | "where"
                    | "when"
                    | "why"
                    | "how"
                    | "please"
                    | "summarize"
                    | "summary"
                    | "find"
                    | "show"
                    | "page"
                    | "content"
            )
        })
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let cjk = lower.chars().filter(|ch| is_cjk(*ch)).collect::<Vec<_>>();
    for window in cjk.windows(2) {
        terms.insert(window.iter().collect());
    }
    terms
}

fn preview_text(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let shortened = input.chars().take(max_chars).collect::<String>();
    format!("{}…", shortened.trim_end())
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(test)]
pub(crate) fn clear_web_search_cache_for_tests() {
    if let Some(cache) = WEB_SEARCH_CACHE.get() {
        cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

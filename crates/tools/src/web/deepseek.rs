//! Account-billed search through New API. One batch is one POST: neither query
//! expansion nor transport retries may create additional paid requests.

use super::*;
use crate::research_account::{self, ResearchApiCredential};

const SEARCH_URL: &str = "https://somni.ensuanx.com/v1/tools/search";
const SEARCH_SUMMARY_MAX_CHARS: usize = 1_200;

#[derive(Debug, Clone)]
pub(crate) struct DeepSeekProvider {
    credential: ResearchApiCredential,
    endpoint: Url,
    allow_private: bool,
}

#[derive(Deserialize)]
struct SearchResponse {
    // Required: an unexpected JSON shape must not become a successful empty search.
    results: Vec<SearchResult>,
}

#[derive(Deserialize)]
struct SearchResult {
    title: String,
    url: String,
    snippet: Option<String>,
    summary: Option<String>,
    date: Option<String>,
}

impl DeepSeekProvider {
    pub(super) fn from_account() -> Result<Self, String> {
        let account = research_account::current_provider().ok_or_else(|| {
            "web_search_error:unauthorized Sign in to SomniQ to use DeepSeek search.".to_string()
        })?;
        Self::from_provider(account.as_ref())
    }

    fn from_provider(
        account: &dyn research_account::ResearchAccountProvider,
    ) -> Result<Self, String> {
        let credential = account.api_credential()?.ok_or_else(|| {
            "web_search_error:unauthorized SomniQ API token is unavailable. Sign in again."
                .to_string()
        })?;
        if credential.api_key.trim().is_empty()
            || !research_account::same_origin(&credential.issuer, SEARCH_URL)
        {
            return Err(
                "web_search_error:invalid_credentials DeepSeek search requires an API token issued by the SomniQ search gateway."
                    .to_string(),
            );
        }
        Ok(Self {
            credential,
            endpoint: Url::parse(SEARCH_URL).map_err(|error| error.to_string())?,
            allow_private: false,
        })
    }

    pub(super) fn cache_scope(&self) -> String {
        // Cache entries cannot cross account/token changes; the key itself is
        // never serialized into an output, cursor, audit record, or Debug log.
        format!(
            "{}:{:x}",
            self.endpoint.origin().ascii_serialization(),
            Sha256::digest(self.credential.api_key.as_bytes())
        )
    }

    /// Model discovery checks entitlement without performing a paid search.
    pub(super) fn probe_access(&self, should_cancel: &dyn Fn() -> bool) -> Result<String, String> {
        let url = self
            .endpoint
            .join("/v1/models")
            .map_err(|error| error.to_string())?;
        let value = self.request(Method::GET, url, None, should_cancel)?;
        let models = value.get("data").and_then(Value::as_array).ok_or_else(|| {
            "web_search_error:parse DeepSeek access check returned an invalid model list."
                .to_string()
        })?;
        if !models.iter().any(|model| {
            model.as_str() == Some("deepseek-search")
                || model.get("id").and_then(Value::as_str) == Some("deepseek-search")
        }) {
            return Err(
                "web_search_error:forbidden DeepSeek search requires Go, Plus, Pro or 千研 and API token access to deepseek-search."
                    .to_string(),
            );
        }
        Ok("DeepSeek search access verified; no paid search was performed".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn search_page(
        &self,
        variant: &runtime::SearchQueryVariant,
        input: &WebSearchInput,
        cursor: Option<&str>,
        limit: usize,
        stream: &str,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<SearchPage, String> {
        if cursor.is_some_and(|cursor| !cursor.is_empty()) {
            return Err(
                "web_search_error:invalid_cursor DeepSeek has no pagination cursor.".into(),
            );
        }
        let query = query_with_domain_filters(&variant.query, input);
        if query.chars().count() > 128 {
            return Err(
                "web_search_error:invalid_query DeepSeek query including domain filters must contain at most 128 Unicode characters. Shorten the query or filters."
                    .into(),
            );
        }
        let value = self.request(
            Method::POST,
            self.endpoint.clone(),
            Some(json!({
                "query": query,
                "count": limit,
                "need_content": false,
            })),
            should_cancel,
        )?;
        let response: SearchResponse = serde_json::from_value(value).map_err(|_| {
            "web_search_error:parse DeepSeek returned an invalid search response.".to_string()
        })?;
        let fetched = response.results.len();
        let mut hits = response
            .results
            .into_iter()
            .enumerate()
            .filter_map(|(index, result)| {
                let url = Url::parse(result.url.trim()).ok()?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return None;
                }
                let title = collapse_whitespace(&html_to_text(&result.title));
                if title.is_empty() {
                    return None;
                }
                // DeepSeek recommends its longer, query-specific summary for
                // model reading; the short snippet is intended for display.
                let snippet = result
                    .summary
                    .filter(|text| !text.trim().is_empty())
                    .or(result.snippet)
                    .unwrap_or_default();
                Some(RawSearchHit {
                    title,
                    url: url.to_string(),
                    snippet: preview_text(&html_to_text(&snippet), SEARCH_SUMMARY_MAX_CHARS),
                    provider: "deepseek".to_string(),
                    source_rank: index + 1,
                    stream: stream.to_string(),
                    published_date: result.date.filter(|date| !date.trim().is_empty()),
                    source_metadata: None,
                })
            })
            .collect::<Vec<_>>();
        if fetched > 0 && hits.is_empty() {
            return Err(
                "web_search_error:parse DeepSeek returned no valid result URLs or titles.".into(),
            );
        }
        apply_domain_filters(&mut hits, input);
        hits.truncate(limit);
        Ok(SearchPage {
            hits,
            fetched,
            total_hits: None,
            // The API reports a ranked result window, without a total or a
            // continuation token. Never describe that window as exhaustive.
            exhausted: false,
            next_cursor: None,
            truncated_reason: Some("provider_result_window".to_string()),
        })
    }

    fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<Value, String> {
        if !research_account::same_origin(&self.credential.issuer, url.as_str()) {
            return Err(
                "web_search_error:invalid_credentials Search token origin mismatch.".into(),
            );
        }
        if should_cancel() {
            return Err("interrupted web request".into());
        }
        let client = build_http_client(&url, self.allow_private)?;
        let mut request = client
            .request(method, url)
            .bearer_auth(self.credential.api_key.trim())
            // The gateway allows up to 60 seconds for its upstream response.
            .timeout(Duration::from_secs(65));
        if let Some(body) = body {
            request = request.json(&body);
        }
        // This client disables redirects; send exactly once, including for
        // 429/5xx/connection failures whose billing outcome may be uncertain.
        let mut response = request.send().map_err(|error| {
            format!(
                "web_search_error:{}; DeepSeek request was not retried.",
                classify_web_error(&error)
            )
        })?;
        if response.status().is_redirection() {
            return Err(
                "web_search_error:redirect_blocked DeepSeek gateway redirects are not followed."
                    .into(),
            );
        }
        let status = response.status();
        let bytes =
            read_response_limited(&mut response, WEB_SEARCH_MAX_RESPONSE_BYTES, should_cancel)?;
        let value = serde_json::from_slice::<Value>(&bytes);
        if !status.is_success()
            || value.as_ref().is_ok_and(|value| {
                value.get("error").is_some()
                    || value.get("success").and_then(Value::as_bool) == Some(false)
            })
        {
            return Err(search_error(status, value.as_ref().ok()));
        }
        value.map_err(|_| "web_search_error:parse DeepSeek returned invalid JSON.".to_string())
    }
}

fn search_error(status: StatusCode, body: Option<&Value>) -> String {
    // Inspect provider details for classification, but never echo an upstream
    // body: it may contain credentials or other account data.
    let detail = body
        .map(Value::to_string)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (kind, message) = if status == StatusCode::UNAUTHORIZED {
        (
            "unauthorized",
            "SomniQ API token was rejected. Sign in again.",
        )
    } else if status == StatusCode::PAYMENT_REQUIRED
        || [
            "insufficient_quota",
            "insufficient_user_quota",
            "quota_exceeded",
            "额度不足",
            "余额不足",
        ]
        .iter()
        .any(|marker| detail.contains(marker))
    {
        (
            "quota_exceeded",
            "SomniQ search allowance or balance is insufficient.",
        )
    } else if status == StatusCode::FORBIDDEN {
        ("forbidden", "DeepSeek search requires Go, Plus, Pro or 千研 and API token access to deepseek-search.")
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        (
            "rate_limited",
            "DeepSeek search is rate limited. Try again later.",
        )
    } else if status.is_server_error() {
        (
            "upstream_unavailable",
            "DeepSeek search is temporarily unavailable.",
        )
    } else {
        ("http_error", "DeepSeek search request was rejected.")
    };
    format!("web_search_error:{kind} {message} HTTP {status}")
}

#[cfg(test)]
#[path = "deepseek_tests.rs"]
mod tests;

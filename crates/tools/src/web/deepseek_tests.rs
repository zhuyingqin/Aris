use super::*;
use std::net::TcpListener;
use std::sync::{atomic::AtomicBool, Arc};

const API_KEY: &str = "sk-api-token-sentinel";
const RESULTS: &str = r#"{"results":[{"title":"DeepSeek &amp; Research","url":"https://example.com/paper","snippet":"A research result","summary":"Long summary","date":"2026-10-19","authority":3,"rerank_score":2.1}]}"#;

struct Fixture {
    provider: DeepSeekProvider,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new(status: u16, headers: &str, body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
            body.len()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (recorded, stopping) = (requests.clone(), stop.clone());
        let handle = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut raw = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0, "request ended early");
                    raw.extend_from_slice(&buffer[..count]);
                    if let Some(end) = raw.windows(4).position(|part| part == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..end]);
                        let length = head
                            .lines()
                            .filter_map(|line| line.split_once(':'))
                            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if raw.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(raw).unwrap());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            provider: DeepSeekProvider {
                endpoint: Url::parse(&format!("{issuer}/v1/tools/search")).unwrap(),
                credential: ResearchApiCredential {
                    issuer,
                    api_key: API_KEY.to_string(),
                },
                allow_private: true,
            },
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn search(&self, input: &WebSearchInput) -> Result<WebSearchOutput, String> {
        execute_web_search_with_candidates(
            input,
            &|| false,
            Some(vec![WebProvider::DeepSeek(self.provider.clone())]),
        )
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap();
    }
}

fn input() -> WebSearchInput {
    serde_json::from_value(json!({
        "query": "How do research agents evaluate evidence?",
        "maxResults": 12,
        "providers": ["deepseek"],
    }))
    .unwrap()
}

#[test]
fn a_batch_posts_once_with_the_api_token_and_reuses_its_cache() {
    let fixture = Fixture::new(200, "", RESULTS);
    let mut input = input();
    input.allowed_domains = Some(vec!["example.com".to_string()]);
    let first = fixture.search(&input).unwrap();
    assert!(!first.cached);
    assert_eq!(first.provider, "deepseek");
    assert_eq!(first.query_variants.len(), 1);
    assert_eq!(first.coverage.unique, 1);
    assert!(!first.coverage.exhausted);
    assert!(first.coverage.next_cursor.is_none());
    assert!(first
        .retrieval_control
        .recommended_action
        .contains("bounded result window"));
    assert!(first
        .coverage
        .truncated_reason
        .as_deref()
        .unwrap()
        .contains("provider_result_window"));
    let output = serde_json::to_value(&first).unwrap();
    let hit = &output["results"][1]["content"][0];
    assert_eq!(hit["title"], "DeepSeek & Research");
    assert_eq!(hit["publishedDate"], "2026-10-19");
    assert_eq!(hit["snippet"], "Long summary");
    assert_eq!(hit["provider"], "deepseek");
    assert!(!output.to_string().contains(API_KEY));
    let request = fixture.requests.lock().unwrap()[0].clone();
    assert!(request.starts_with("POST /v1/tools/search HTTP/1.1"));
    assert!(request
        .to_ascii_lowercase()
        .contains(&format!("authorization: bearer {API_KEY}")));
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["count"], 12);
    assert_eq!(body["need_content"], false);
    assert!(body["query"].as_str().unwrap().contains("site:example.com"));
    assert!(body.get("model").is_none());
    assert!(fixture.search(&input).unwrap().cached);
    assert_eq!(fixture.count(), 1);
}

#[test]
fn cache_entries_are_scoped_to_the_api_token() {
    let mut fixture = Fixture::new(200, "", RESULTS);
    fixture.search(&input()).unwrap();
    fixture.provider.credential.api_key = "sk-another-account".to_string();
    assert!(!fixture.search(&input()).unwrap().cached);
    assert_eq!(fixture.count(), 2);
}

#[test]
fn empty_results_are_partial_and_not_cached() {
    let fixture = Fixture::new(200, "", r#"{"results":[]}"#);
    let first = fixture.search(&input()).unwrap();
    assert_eq!(first.coverage.unique, 0);
    assert!(!first.coverage.exhausted);
    assert!(first.coverage.next_cursor.is_none());
    assert!(!fixture.search(&input()).unwrap().cached);
    assert_eq!(fixture.count(), 2);
}

#[test]
fn access_and_upstream_failures_do_not_retry_or_echo_private_details() {
    for (status, kind) in [
        (401, "unauthorized"),
        (403, "forbidden"),
        (402, "quota_exceeded"),
        (429, "rate_limited"),
        (503, "upstream_unavailable"),
    ] {
        let fixture = Fixture::new(
            status,
            "",
            &format!(r#"{{"error":{{"message":"{API_KEY}"}}}}"#),
        );
        let error = fixture.search(&input()).unwrap_err();
        assert!(error.contains(kind), "{error}");
        assert!(!error.contains(API_KEY));
        assert_eq!(fixture.count(), 1, "HTTP {status} was retried");
    }
    let fixture = Fixture::new(403, "", r#"{"error":{"code":"insufficient_user_quota"}}"#);
    assert!(fixture
        .search(&input())
        .unwrap_err()
        .contains("quota_exceeded"));
    assert_eq!(fixture.count(), 1);
}

#[test]
fn redirects_never_forward_the_api_token() {
    let destination = Fixture::new(200, "", RESULTS);
    let fixture = Fixture::new(
        307,
        &format!("Location: {}\r\n", destination.provider.endpoint),
        "{}",
    );
    assert!(fixture
        .search(&input())
        .unwrap_err()
        .contains("redirect_blocked"));
    assert_eq!(fixture.count(), 1);
    assert_eq!(destination.count(), 0);
}

#[test]
fn malformed_responses_do_not_become_empty_searches() {
    for body in [
        "not JSON",
        "{}",
        r#"{"results":[{"title":"Bad","url":"file:///private"}]}"#,
    ] {
        let fixture = Fixture::new(200, "", body);
        assert!(fixture.search(&input()).unwrap_err().contains("parse"));
        assert_eq!(fixture.count(), 1);
    }
}

#[test]
fn availability_uses_model_discovery_without_a_paid_post() {
    let fixture = Fixture::new(200, "", r#"{"data":[{"id":"deepseek-search"}]}"#);
    assert!(fixture
        .provider
        .probe_access(&|| false)
        .unwrap()
        .contains("no paid search"));
    assert!(fixture.requests.lock().unwrap()[0].starts_with("GET /v1/models HTTP/1.1"));
    let denied = Fixture::new(200, "", r#"{"data":[{"id":"deepseek-v4.1-flash"}]}"#);
    assert!(denied
        .provider
        .probe_access(&|| false)
        .unwrap_err()
        .contains("forbidden"));
}

struct Account {
    issuer: &'static str,
    key: Option<&'static str>,
}

impl research_account::ResearchAccountProvider for Account {
    fn session_issuer(&self) -> Option<String> {
        Some(self.issuer.to_string())
    }
    fn credential(&self) -> Result<Option<research_account::ResearchAccountCredential>, String> {
        panic!("paid tools must never request the dashboard JWT");
    }
    fn api_credential(&self) -> Result<Option<ResearchApiCredential>, String> {
        Ok(self.key.map(|key| ResearchApiCredential {
            issuer: self.issuer.to_string(),
            api_key: key.to_string(),
        }))
    }
}

#[test]
fn account_search_requires_a_gateway_issued_api_token() {
    for issuer in [
        "https://other.example",
        "http://somni.ensuanx.com",
        "https://somni.ensuanx.com:8443",
    ] {
        let account = Account {
            issuer,
            key: Some(API_KEY),
        };
        assert!(DeepSeekProvider::from_provider(&account)
            .unwrap_err()
            .contains("invalid_credentials"));
    }
    let account = Account {
        issuer: "https://somni.ensuanx.com",
        key: None,
    };
    assert!(DeepSeekProvider::from_provider(&account)
        .unwrap_err()
        .contains("unauthorized"));
    let account = Account {
        issuer: "https://somni.ensuanx.com",
        key: Some(API_KEY),
    };
    let provider = DeepSeekProvider::from_provider(&account).unwrap();
    assert_eq!(provider.endpoint.as_str(), SEARCH_URL);
    assert!(!format!("{provider:?}").contains(API_KEY));
}

#[test]
fn cancelled_search_does_not_send_a_request() {
    let fixture = Fixture::new(200, "", RESULTS);
    let error = fixture.provider.probe_access(&|| true).unwrap_err();
    assert!(error.contains("interrupted"));
    assert_eq!(fixture.count(), 0);
}

#[test]
fn query_length_includes_domain_operators_and_is_checked_before_a_paid_request() {
    let fixture = Fixture::new(200, "", RESULTS);
    let mut input = input();
    input.query = "查".repeat(129);
    assert!(fixture.search(&input).unwrap_err().contains("128 Unicode"));
    input.query = "查".repeat(128);
    input.allowed_domains = Some(vec!["example.com".to_string()]);
    assert!(fixture.search(&input).unwrap_err().contains("128 Unicode"));
    assert_eq!(fixture.count(), 0);
    input.allowed_domains = None;
    assert_eq!(fixture.search(&input).unwrap().coverage.unique, 1);
    assert_eq!(fixture.count(), 1);
}

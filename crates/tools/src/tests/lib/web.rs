use super::*;

#[test]
fn web_fetch_returns_prompt_aware_summary() {
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.starts_with("GET /page "));
        HttpResponse::html(
                200,
                "OK",
                "<html><head><title>Ignored</title></head><body><h1>Test Page</h1><p>Hello <b>world</b> from local server.</p></body></html>",
            )
    }));

    let result = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/page", server.addr()),
            "prompt": "Summarize this page"
        }),
    )
    .expect("WebFetch should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["code"], 200);
    let summary = output["result"].as_str().expect("result string");
    assert!(summary.contains("Fetched"));
    assert!(summary.contains("Test Page"));
    assert!(summary.contains("Hello world from local server"));

    let titled = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/page", server.addr()),
            "prompt": "What is the page title?"
        }),
    )
    .expect("WebFetch title query should succeed");
    let titled_output: serde_json::Value = serde_json::from_str(&titled).expect("valid json");
    let titled_summary = titled_output["result"].as_str().expect("result string");
    assert!(titled_summary.contains("Title: Ignored"));
}

#[test]
fn web_fetch_supports_plain_text_and_rejects_invalid_url() {
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.starts_with("GET /plain "));
        HttpResponse::text(200, "OK", "plain text response")
    }));

    let result = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/plain", server.addr()),
            "prompt": "Show me the content"
        }),
    )
    .expect("WebFetch should succeed for text content");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["url"], format!("http://{}/plain", server.addr()));
    assert!(output["result"]
        .as_str()
        .expect("result")
        .contains("plain text response"));

    let error = execute_tool(
        "WebFetch",
        &json!({
            "url": "not a url",
            "prompt": "Summarize"
        }),
    )
    .expect_err("invalid URL should fail");
    assert!(error.contains("relative URL without a base") || error.contains("invalid"));
}

#[test]
fn web_search_extracts_and_filters_results() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /search?q=rust+web+search "));
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <a class="result__a" href="https://docs.rs/reqwest">Reqwest docs</a>
                  <a class="result__a" href="https://example.com/blocked">Blocked result</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/search", server.addr()),
    );
    let result = execute_tool(
        "WebSearch",
        &json!({
            "query": "rust web search",
            "allowed_domains": ["https://DOCS.rs/"],
            "blocked_domains": ["HTTPS://EXAMPLE.COM"]
        }),
    )
    .expect("WebSearch should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["query"], "rust web search");
    let results = output["results"].as_array().expect("results array");
    let search_result = results
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present");
    let content = search_result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["title"], "Reqwest docs");
    assert_eq!(content[0]["url"], "https://docs.rs/reqwest");
}

#[test]
fn web_search_handles_generic_links_and_invalid_base_url() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /fallback?q=generic+links "));
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <a href="https://example.com/one">Example One</a>
                  <a href="https://example.com/one">Duplicate Example One</a>
                  <a href="https://docs.rs/tokio">Tokio Docs</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/fallback", server.addr()),
    );
    let result = execute_tool(
        "WebSearch",
        &json!({
            "query": "generic links"
        }),
    )
    .expect("WebSearch fallback parsing should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let results = output["results"].as_array().expect("results array");
    let search_result = results
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present");
    let content = search_result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["url"], "https://example.com/one");
    assert_eq!(content[1]["url"], "https://docs.rs/tokio");

    std::env::set_var("CLAWD_WEB_SEARCH_BASE_URL", "://bad-base-url");
    let error = execute_tool("WebSearch", &json!({ "query": "generic links" }))
        .expect_err("invalid base URL should fail");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    assert!(error.contains("relative URL without a base") || error.contains("empty host"));
}

#[test]
fn web_search_drops_engine_navigation_links() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <a href="/settings">Settings</a>
                  <a href="/about">Privacy Policy</a>
                  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal">Real Result</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/nav", server.addr()),
    );
    let result = execute_tool("WebSearch", &json!({ "query": "engine navigation" }))
        .expect("WebSearch should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let search_result = output["results"]
        .as_array()
        .expect("results array")
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present");
    let content = search_result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1, "engine nav links must not become hits");
    assert_eq!(content[0]["url"], "https://example.com/real");
}

#[test]
fn web_search_reports_bot_challenge() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <div class="anomaly-modal__mask"></div>
                  <a href="/settings">Settings</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/blocked", server.addr()),
    );
    let error = execute_tool("WebSearch", &json!({ "query": "anything" }))
        .expect_err("a challenge page must not be reported as an empty result set");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    assert!(
        error.contains("web_search_error:blocked"),
        "unexpected error: {error}"
    );
}

#[test]
fn web_search_reports_rate_limit() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(429, "Too Many Requests", "<html><body>slow down</body></html>")
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/limited", server.addr()),
    );
    let error = execute_tool("WebSearch", &json!({ "query": "anything" }))
        .expect_err("HTTP 429 must surface as an error");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    assert!(
        error.contains("web_search_error:rate_limited"),
        "unexpected error: {error}"
    );
}

#[test]
fn search_hit_scan_survives_unclosed_anchor() {
    // Slicing one byte into a multi-byte title used to panic here.
    let hits = extract_search_hits(r#"<a class="result__a" href="https://example.com/one">中文标题"#);
    assert!(hits.is_empty());

    let hits = extract_search_hits(concat!(
        r#"<a class="result__a" href="https://example.com/one">First</a>"#,
        r#"<a class="result__a" href="https://example.com/two">未闭合标题"#,
    ));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].url, "https://example.com/one");
}

struct TestServer {
    addr: SocketAddr,
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    fn spawn(handler: Arc<dyn Fn(&str) -> HttpResponse + Send + Sync + 'static>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = std::sync::mpsc::channel::<()>();

        let handle = thread::spawn(move || loop {
            if rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0_u8; 4096];
                    let size = stream.read(&mut buffer).expect("read request");
                    let request = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let request_line = request.lines().next().unwrap_or_default().to_string();
                    let response = handler(&request_line);
                    stream
                        .write_all(response.to_bytes().as_slice())
                        .expect("write response");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("server accept failed: {error}"),
            }
        });

        Self {
            addr,
            shutdown: Some(tx),
            handle: Some(handle),
        }
    }

    fn addr(&self) -> SocketAddr {
        self.addr
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            handle.join().expect("join test server");
        }
    }
}

struct HttpResponse {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: String,
}

impl HttpResponse {
    fn html(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/html; charset=utf-8",
            body: body.to_string(),
        }
    }

    fn text(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/plain; charset=utf-8",
            body: body.to_string(),
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                self.status,
                self.reason,
                self.content_type,
                self.body.len(),
                self.body
            )
            .into_bytes()
    }
}

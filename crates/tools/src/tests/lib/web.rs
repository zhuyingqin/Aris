use super::*;
use crate::web::{
    clear_web_search_cache_for_tests, extract_search_hits, is_provider_navigation_hit,
    probe_web_search_provider, RawSearchHit,
};

struct WebFetchTestWorkspace {
    root: PathBuf,
    _workspace: EnvGuard,
}

impl WebFetchTestWorkspace {
    fn new(name: &str) -> Self {
        let root = temp_path(name);
        fs::create_dir_all(&root).expect("create web-fetch test workspace");
        let workspace = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &root);
        Self {
            root,
            _workspace: workspace,
        }
    }
}

impl Drop for WebFetchTestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn web_provider_probe_rejects_invalid_provider_or_empty_key_before_network_access() {
    assert!(probe_web_search_provider("unknown", "secret", "connectivity").is_err());
    assert!(probe_web_search_provider("brave", " ", "connectivity")
        .expect_err("empty provider key")
        .contains("API key is empty"));
}

#[test]
fn web_search_schema_requires_the_llm_to_choose_a_batch_budget() {
    let spec = mvp_tool_specs()
        .into_iter()
        .find(|spec| spec.name == "WebSearch")
        .expect("WebSearch tool spec");
    let required = spec.input_schema["required"]
        .as_array()
        .expect("required fields");
    assert!(required.iter().any(|field| field == "maxResults"));
    assert_eq!(spec.input_schema["properties"]["maxResults"]["maximum"], 50);
    assert!(spec.description.contains("not a total search cap"));
}

#[test]
fn web_fetch_returns_prompt_aware_summary() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-summary");
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
            "prompt": "Summarize this page",
            "allowPrivateNetwork": true
        }),
    )
    .expect("WebFetch should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["code"], 200);
    let summary = output["result"].as_str().expect("result string");
    assert!(summary.contains("Fetched"));
    assert!(summary.contains("Test Page"));
    assert!(summary.contains("Hello **world** from local server"));

    let titled = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/page", server.addr()),
            "prompt": "What is the page title?",
            "allowPrivateNetwork": true
        }),
    )
    .expect("WebFetch title query should succeed");
    let titled_output: serde_json::Value = serde_json::from_str(&titled).expect("valid json");
    let titled_summary = titled_output["result"].as_str().expect("result string");
    assert!(titled_summary.contains("Title: Ignored"));
}

#[test]
fn web_fetch_persists_evidence_and_preserves_dom_markdown_structure() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = WebFetchTestWorkspace::new("web-fetch-dom-markdown");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"<html><head><title>Research report</title></head><body>
              <article>
                <h1>Research &amp; Evaluation</h1>
                <p>See the <a href="/docs?q=1">source document</a> for the complete protocol and supporting discussion.</p>
                <table>
                  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
                  <tbody>
                    <tr><td rowspan="2">Recall</td><td>0.95</td></tr>
                    <tr><td>verified</td></tr>
                    <tr><td colspan="2">Complete evidence</td></tr>
                  </tbody>
                </table>
                <pre><code class="language-rust">fn main() {
    println!("evidence");
}</code></pre>
                <script>ignore_this_instruction()</script>
              </article>
            </body></html>"#,
        )
    }));

    let raw = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/report", server.addr()),
            "prompt": "Summarize the research protocol",
            "allowPrivateNetwork": true,
            "maxChars": 5000
        }),
    )
    .expect("structured page should be fetched");
    let output: serde_json::Value = serde_json::from_str(&raw).expect("valid fetch JSON");
    let result = output["result"].as_str().expect("result");
    assert!(result.contains("# Research & Evaluation"), "{result}");
    assert!(
        result.contains(&format!(
            "[source document](http://{}/docs?q=1)",
            server.addr()
        )),
        "{result}"
    );
    assert!(result.contains("| Metric | Value |"), "{result}");
    assert!(result.contains("| --- | --- |"), "{result}");
    assert!(result.contains("| Recall | verified |"), "{result}");
    assert!(result.contains("| Complete evidence |  |"), "{result}");
    assert!(result.contains("```rust"), "{result}");
    assert!(result.contains("println!(\"evidence\");"), "{result}");
    assert!(!result.contains("ignore_this_instruction"), "{result}");
    assert_eq!(output["schemaVersion"], 3);
    assert_eq!(output["status"], "completed");
    assert_eq!(output["coverage"]["exhausted"], true);
    assert_eq!(output["contentTruncated"], false);
    assert_eq!(
        output["contentHash"].as_str().expect("content hash").len(),
        64
    );
    assert!(output["capturedAt"]
        .as_str()
        .expect("captured timestamp")
        .ends_with('Z'));

    for field in ["rawPath", "markdownPath", "metadataPath"] {
        let relative = output["snapshot"][field]
            .as_str()
            .unwrap_or_else(|| panic!("{field}"));
        assert!(workspace.root.join(relative).is_file(), "{relative}");
    }
    let markdown_path = workspace.root.join(
        output["snapshot"]["markdownPath"]
            .as_str()
            .expect("markdown path"),
    );
    let snapshot = fs::read_to_string(markdown_path).expect("read Markdown snapshot");
    assert!(snapshot.contains("| Metric | Value |"));
    assert!(snapshot.contains("```rust"));
}

#[test]
fn web_fetch_uses_a_large_default_window_but_honors_the_model_token_budget() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-adaptive-budget");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            &format!(
                "<html><body><article><h1>Long evidence</h1><p>{}</p></article></body></html>",
                "measured result with supporting context. ".repeat(320)
            ),
        )
    }));
    let url = format!("http://{}/budget", server.addr());

    let default: serde_json::Value = serde_json::from_str(
        &execute_tool(
            "WebFetch",
            &json!({
                "url": url,
                "prompt": "Return the measured result and supporting context",
                "allowPrivateNetwork": true
            }),
        )
        .expect("default WebFetch"),
    )
    .expect("default output JSON");
    assert_eq!(default["contentWindow"]["charLimit"], 50_000);
    assert_eq!(default["contentWindow"]["tokenLimit"], 10_000);
    assert_eq!(default["coverage"]["exhausted"], true);
    assert!(
        default["result"].as_str().expect("result").chars().count() > 6_000,
        "the new default should not retain the old 6,000-character ceiling"
    );

    let bounded: serde_json::Value = serde_json::from_str(
        &execute_tool_with_context(
            "WebFetch",
            &json!({
                "url": url,
                "prompt": "Return the measured result and supporting context",
                "allowPrivateNetwork": true,
                "maxChars": 50_000,
                "maxTokens": 25_000
            }),
            ToolRunContext {
                tool_use_id: None,
                session_id: None,
                turn_id: None,
                max_output_tokens: Some(512),
            },
        )
        .expect("model-bounded WebFetch"),
    )
    .expect("bounded output JSON");
    assert_eq!(bounded["contentWindow"]["tokenLimit"], 512);
    assert!(
        bounded["contentWindow"]["estimatedTokens"]
            .as_u64()
            .expect("estimated tokens")
            <= 512
    );
    assert_eq!(bounded["status"], "partial");
    assert_eq!(bounded["coverage"]["truncatedReason"], "context_window");
}

#[test]
fn web_fetch_keeps_each_capture_immutable_when_content_is_reused() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = WebFetchTestWorkspace::new("web-fetch-immutable-captures");
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests_for_server = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |request_line: &str| {
        requests_for_server.fetch_add(1, Ordering::SeqCst);
        let body = "immutable evidence passage ".repeat(100).into_bytes();
        let content_type = if request_line.starts_with("GET /as-html ") {
            "text/html; charset=utf-8"
        } else {
            "text/plain; charset=utf-8"
        };
        HttpResponse::bytes(200, "OK", content_type, body)
    }));
    let text_url = format!("http://{}/as-text", server.addr());
    let html_url = format!("http://{}/as-html", server.addr());
    let input = json!({
        "url": text_url,
        "prompt": "Read immutable evidence",
        "allowPrivateNetwork": true,
        "maxChars": 220
    });
    let first: serde_json::Value =
        serde_json::from_str(&execute_tool("WebFetch", &input).expect("first capture"))
            .expect("first JSON");
    let mut second_input = input.clone();
    second_input["url"] = json!(html_url);
    let second: serde_json::Value =
        serde_json::from_str(&execute_tool("WebFetch", &second_input).expect("second capture"))
            .expect("second JSON");
    assert_eq!(
        first["snapshot"]["artifactId"], second["snapshot"]["artifactId"],
        "identical bytes/Markdown should reuse one object even when MIME metadata differs"
    );
    assert_ne!(
        first["snapshot"]["captureId"], second["snapshot"]["captureId"],
        "each HTTP observation must retain independent capture metadata"
    );
    for output in [&first, &second] {
        let path = workspace.root.join(
            output["snapshot"]["metadataPath"]
                .as_str()
                .expect("metadata path"),
        );
        assert!(path.is_file(), "capture metadata was overwritten: {path:?}");
    }

    let cursor = first["coverage"]["nextCursor"]
        .as_str()
        .expect("first continuation");
    let mut continuation_input = input;
    continuation_input["cursor"] = json!(cursor);
    let continued: serde_json::Value = serde_json::from_str(
        &execute_tool("WebFetch", &continuation_input).expect("continue first capture"),
    )
    .expect("continuation JSON");
    assert_eq!(continued["cached"], true);
    assert_eq!(
        continued["snapshot"]["captureId"],
        first["snapshot"]["captureId"]
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[test]
fn web_fetch_decodes_declared_legacy_charset_and_sanitizes_links() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-encoding-links");
    let html = r#"<html><body><article>
        <h1>中文证据</h1>
        <p>编码恢复成功。</p>
        <a href="javascript:alert(1)">unsafe script</a>
        <a href="file:///etc/passwd">unsafe file</a>
        <a href="https://example.com/report?token=secret-value&amp;page=2">safe report</a>
      </article></body></html>"#;
    let (encoded, _, had_errors) = encoding_rs::GBK.encode(html);
    assert!(!had_errors);
    let encoded = encoded.into_owned();
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        HttpResponse::bytes(200, "OK", "text/html; charset=gbk", encoded.clone())
    }));
    let output: serde_json::Value = serde_json::from_str(
        &execute_tool(
            "WebFetch",
            &json!({
                "url": format!("http://{}/gbk", server.addr()),
                "prompt": "读取中文证据",
                "allowPrivateNetwork": true
            }),
        )
        .expect("GBK page"),
    )
    .expect("GBK output JSON");
    let result = output["result"].as_str().expect("result");
    assert!(result.contains("中文证据"), "{result}");
    assert!(result.contains("编码恢复成功"), "{result}");
    assert!(!result.contains("javascript:"), "{result}");
    assert!(!result.contains("file:///"), "{result}");
    assert!(!result.contains("secret-value"), "{result}");
    assert!(result.contains("safe report"), "{result}");
    assert_eq!(output["encoding"], "gbk");
}

#[test]
fn web_fetch_reports_static_dynamic_shells_as_incomplete() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-dynamic-shell");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            &format!(
                r#"<html><body><div id="root">Loading research application…</div>
                <script>window.a="{}"</script><script>window.b=2</script><script>window.c=3</script>
                </body></html>"#,
                "bundle".repeat(400)
            ),
        )
    }));
    let output: serde_json::Value = serde_json::from_str(
        &execute_tool(
            "WebFetch",
            &json!({
                "url": format!("http://{}/app", server.addr()),
                "prompt": "Read the research application",
                "allowPrivateNetwork": true
            }),
        )
        .expect("dynamic shell capture"),
    )
    .expect("dynamic output JSON");
    assert_eq!(output["status"], "incomplete");
    assert_eq!(output["contentTruncated"], true);
    assert_eq!(output["coverage"]["exhausted"], false);
    assert!(output["coverage"]["nextCursor"].is_null());
    assert_eq!(
        output["coverage"]["truncatedReason"],
        "dynamic_render_required"
    );
    assert!(output["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .any(|warning| warning
            .as_str()
            .is_some_and(|text| text.contains("JavaScript"))));
}

#[test]
fn web_fetch_continuation_preserves_table_headers_and_balanced_code_fences() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-structural-chunks");
    let table_rows = (0..40)
        .map(|index| format!("<tr><td>row-{index}</td><td>value-{index}</td></tr>"))
        .collect::<String>();
    let code_lines = (0..80)
        .map(|index| format!("let value_{index} = {index};\n"))
        .collect::<String>();
    let body = format!(
        r#"<html><body><article><h1>Structured appendix</h1>
        <table><thead><tr><th>Row</th><th>Value</th></tr></thead>
        <tbody>{table_rows}</tbody></table>
        <pre><code class="language-rust">{code_lines}</code></pre>
        </article></body></html>"#
    );
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        HttpResponse::html(200, "OK", &body)
    }));
    let url = format!("http://{}/structure", server.addr());
    let prompt = "Read every table row and Rust declaration";
    let mut input = json!({
        "url": url,
        "prompt": prompt,
        "allowPrivateNetwork": true,
        "maxChars": 300,
        "maxTokens": 256
    });
    let mut output: serde_json::Value =
        serde_json::from_str(&execute_tool("WebFetch", &input).expect("initial structured fetch"))
            .expect("structured output JSON");
    let mut table_chunks = 0;
    let mut code_chunks = 0;
    for _ in 0..100 {
        assert!(
            output["contentWindow"]["estimatedTokens"]
                .as_u64()
                .expect("estimated token count")
                <= 256,
            "{output}"
        );
        let result = output["result"].as_str().expect("result");
        if result.contains("| row-") {
            table_chunks += 1;
            assert!(result.contains("| Row | Value |"), "{result}");
            assert!(result.contains("| --- | --- |"), "{result}");
        }
        if result.contains("```rust") {
            code_chunks += 1;
            assert_eq!(
                result.matches("```").count() % 2,
                0,
                "split code chunks must remain independently parseable: {result}"
            );
        }
        if output["coverage"]["exhausted"] == true {
            break;
        }
        input["cursor"] = output["coverage"]["nextCursor"].clone();
        output = serde_json::from_str(
            &execute_tool("WebFetch", &input).expect("structured continuation"),
        )
        .expect("continuation JSON");
    }
    assert_eq!(output["coverage"]["exhausted"], true, "{output}");
    assert!(table_chunks > 1, "table was not exercised across chunks");
    assert!(
        code_chunks > 1,
        "code block was not exercised across chunks"
    );

    let invalid = execute_tool(
        "WebFetch",
        &json!({
            "url": url,
            "prompt": prompt,
            "allowPrivateNetwork": true,
            "maxChars": 50_001
        }),
    )
    .expect_err("out-of-protocol maxChars must not be silently clamped");
    assert!(invalid.contains("invalid_limit"), "{invalid}");
}

#[test]
fn web_fetch_cursor_reads_ranked_snapshot_without_refetching_or_repeating_chunks() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = WebFetchTestWorkspace::new("web-fetch-cursor");
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests_for_server = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        requests_for_server.fetch_add(1, Ordering::SeqCst);
        let alpha = "alpha background context ".repeat(20);
        let needle = "needle decisive evidence ".repeat(20);
        let omega = "omega appendix material ".repeat(20);
        HttpResponse::html(
            200,
            "OK",
            &format!(
                "<html><body><article><h1>Long report</h1><p>{alpha}</p><p>{needle}</p><p>{omega}</p></article></body></html>"
            ),
        )
    }));
    let url = format!("http://{}/long", server.addr());
    let prompt = "Find the needle decisive evidence";
    let mut output: serde_json::Value = serde_json::from_str(
        &execute_tool(
            "WebFetch",
            &json!({
                "url": url,
                "prompt": prompt,
                "allowPrivateNetwork": true,
                "maxChars": 220
            }),
        )
        .expect("first fetch"),
    )
    .expect("valid first output");
    assert_eq!(output["status"], "partial");
    assert_eq!(output["extraction"], "dom_markdown_prompt_ranked");
    assert!(output["result"]
        .as_str()
        .expect("first result")
        .contains("needle decisive evidence"));
    let total = output["coverage"]["totalHits"]
        .as_u64()
        .expect("total chunks");
    assert!(total >= 3, "{output}");
    let first_cursor = output["coverage"]["nextCursor"]
        .as_str()
        .expect("first cursor")
        .to_string();
    let mut forged_cursor: serde_json::Value =
        serde_json::from_str(&first_cursor).expect("cursor JSON");
    forged_cursor["sequence"] =
        json!(forged_cursor["sequence"].as_u64().expect("cursor sequence") + 1);
    let forged = execute_tool(
        "WebFetch",
        &json!({
            "url": url,
            "prompt": prompt,
            "allowPrivateNetwork": true,
            "maxChars": 220,
            "cursor": serde_json::to_string(&forged_cursor).expect("encode forged cursor")
        }),
    )
    .expect_err("modified cursor must fail authentication");
    assert!(forged.contains("signature"), "{forged}");
    let markdown_path = workspace.root.join(
        output["snapshot"]["markdownPath"]
            .as_str()
            .expect("markdown path"),
    );
    let mismatch = execute_tool(
        "WebFetch",
        &json!({
            "url": url,
            "prompt": "A different reading request",
            "allowPrivateNetwork": true,
            "maxChars": 220,
            "cursor": first_cursor
        }),
    )
    .expect_err("cursor must stay bound to the original prompt");
    assert!(mismatch.contains("invalid_cursor"), "{mismatch}");
    let mut seen = BTreeSet::new();
    loop {
        let source = output["contentWindow"]["sourceChunk"]
            .as_u64()
            .expect("source chunk");
        assert!(seen.insert(source), "source chunk repeated: {source}");
        if output["coverage"]["exhausted"] == true {
            break;
        }
        let cursor = output["coverage"]["nextCursor"]
            .as_str()
            .expect("next cursor")
            .to_string();
        output = serde_json::from_str(
            &execute_tool(
                "WebFetch",
                &json!({
                    "url": url,
                    "prompt": prompt,
                    "allowPrivateNetwork": true,
                    "maxChars": 220,
                    "cursor": cursor
                }),
            )
            .expect("continue from snapshot"),
        )
        .expect("valid continuation output");
        assert_eq!(output["cached"], true);
    }
    assert_eq!(seen.len() as u64, total);
    assert_eq!(output["status"], "completed");
    assert_eq!(output["coverage"]["fetched"], total);
    assert_eq!(requests.load(Ordering::SeqCst), 1);

    fs::write(&markdown_path, "tampered Markdown").expect("tamper captured Markdown");
    let tampered = execute_tool(
        "WebFetch",
        &json!({
            "url": url,
            "prompt": prompt,
            "allowPrivateNetwork": true,
            "maxChars": 220,
            "cursor": first_cursor
        }),
    )
    .expect_err("tampered Markdown must not be continued");
    assert!(tampered.contains("integrity validation"), "{tampered}");
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[test]
fn web_fetch_supports_plain_text_and_rejects_invalid_url() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-plain");
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.starts_with("GET /plain "));
        HttpResponse::text(200, "OK", "plain text response")
    }));

    let result = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/plain", server.addr()),
            "prompt": "Show me the content",
            "allowPrivateNetwork": true
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
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /search?q="));
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
            "maxResults": 7,
            "allowed_domains": ["https://DOCS.rs/"],
            "blocked_domains": ["HTTPS://EXAMPLE.COM"]
        }),
    )
    .expect("WebSearch should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["schemaVersion"], 3);
    assert_eq!(output["query"], "rust web search");
    assert_eq!(output["maxResults"], 7);
    assert_eq!(output["status"], "partial");
    assert_eq!(output["coverage"]["exhausted"], false);
    assert!(output["coverage"]["truncatedReason"]
        .as_str()
        .expect("truncated reason")
        .contains("llm_sufficiency_checkpoint"));
    assert_eq!(output["retrievalControl"]["decisionOwner"], "llm");
    assert_eq!(output["retrievalControl"]["batchLimit"], 7);
    assert_eq!(output["retrievalControl"]["hardBatchCeiling"], 50);
    assert!(output["retrievalControl"]["totalResultLimit"].is_null());
    assert!(output["retrievalControl"]["availableUnsearchedProviders"]
        .as_array()
        .expect("unsearched providers")
        .iter()
        .any(|provider| provider == "duckduckgo"));
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
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /fallback?q="));
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
fn web_search_extracts_snippets() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <div class="result">
                    <a class="result__a" href="https://docs.rs/reqwest">Reqwest docs</a>
                    <a class="result__snippet" href="https://docs.rs/reqwest">An ergonomic <b>HTTP</b> client for Rust.</a>
                  </div>
                  <div class="result">
                    <a class="result__a" href="https://example.com/bare">Bare result</a>
                  </div>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/snippets", server.addr()),
    );
    let result = execute_tool("WebSearch", &json!({ "query": "reqwest docs" }))
        .expect("WebSearch should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let content = output["results"]
        .as_array()
        .expect("results array")
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present")["content"]
        .as_array()
        .expect("content array")
        .clone();

    assert_eq!(content.len(), 2);
    assert_eq!(
        content[0]["snippet"], "An ergonomic HTTP client for Rust.",
        "inline markup inside the snippet must be flattened, not truncated"
    );
    assert!(
        content[1].get("snippet").is_none(),
        "a snippet-less result must not borrow the previous block's snippet, \
         and must not spend tokens on an empty field"
    );

    let commentary = output["results"]
        .as_array()
        .expect("results array")
        .iter()
        .find_map(serde_json::Value::as_str)
        .expect("commentary present");
    assert!(
        !commentary.contains("https://docs.rs/reqwest"),
        "hits must be serialized once, not duplicated into the commentary: {commentary}"
    );
}

#[test]
fn web_search_reuses_cached_results_for_repeated_queries() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        counter.fetch_add(1, Ordering::SeqCst);
        HttpResponse::html(
            200,
            "OK",
            r#"<html><body><a class="result__a" href="https://example.com/cached">Cached</a></body></html>"#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/cache", server.addr()),
    );
    let first = execute_tool("WebSearch", &json!({ "query": "Cache  Me" }))
        .expect("first WebSearch should succeed");
    // Differs only by case and whitespace, which the cache key folds away.
    let second = execute_tool("WebSearch", &json!({ "query": "cache me" }))
        .expect("second WebSearch should be served from cache");
    let other = execute_tool("WebSearch", &json!({ "query": "different query" }))
        .expect("a distinct query must still hit the network");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    // The echoed `query` stays verbatim per caller; it is the hit payload that
    // must come back identical from the cache.
    let hits = |raw: &str| {
        let value: serde_json::Value = serde_json::from_str(raw).expect("valid json");
        value["results"]
            .as_array()
            .expect("results array")
            .iter()
            .find(|item| item.get("content").is_some())
            .expect("search result block present")["content"]
            .clone()
    };
    assert_eq!(hits(&first), hits(&second));
    assert_eq!(
        requests.load(Ordering::SeqCst),
        4,
        "each uncached query executes original plus exact-phrase variants; the repeated query must not re-hit the backend"
    );
    assert!(other.contains("different query"));
}

#[test]
fn web_search_drops_engine_navigation_links() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
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
fn web_search_drops_live_duckduckgo_feedback_result() {
    assert!(is_provider_navigation_hit(&RawSearchHit {
        title: "Feedback".to_string(),
        url: "https://duckduckgo.com/feedback.html".to_string(),
        snippet: String::new(),
        provider: "duckduckgo".to_string(),
        source_rank: 1,
        stream: "test".to_string(),
        published_date: None,
    }));
    assert!(!is_provider_navigation_hit(&RawSearchHit {
        title: "DuckDuckGo browser research".to_string(),
        url: "https://example.com/duckduckgo-research".to_string(),
        snippet: String::new(),
        provider: "duckduckgo".to_string(),
        source_rank: 2,
        stream: "test".to_string(),
        published_date: None,
    }));
}

#[test]
fn web_search_reports_bot_challenge() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
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
    let error = execute_tool(
        "WebSearch",
        &json!({ "query": "anything", "providers": ["custom"] }),
    )
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
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            429,
            "Too Many Requests",
            "<html><body>slow down</body></html>",
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/limited", server.addr()),
    );
    let error = execute_tool(
        "WebSearch",
        &json!({ "query": "anything", "providers": ["custom"] }),
    )
    .expect_err("HTTP 429 must surface as an error");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    assert!(
        error.contains("web_search_error:rate_limited"),
        "unexpected error: {error}"
    );
}

#[test]
fn web_search_retries_a_transient_rate_limit_then_records_success() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        let call = counter.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            HttpResponse::html(429, "Too Many Requests", "<html><body>retry</body></html>")
        } else {
            HttpResponse::html(
                200,
                "OK",
                r#"<a class="result__a" href="https://example.com/recovered">Recovered</a>"#,
            )
        }
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/retry", server.addr()),
    );
    let raw = execute_tool(
        "WebSearch",
        &json!({ "query": "retryable", "providers": ["custom"] }),
    )
    .expect("transient 429 should recover");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    let output: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(output["status"], "completed");
    assert_eq!(output["coverage"]["unique"], 1);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[test]
fn web_search_reports_requested_providers_skipped_for_missing_credentials() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let previous_brave = std::env::var_os("BRAVE_SEARCH_API_KEY");
    std::env::remove_var("BRAVE_SEARCH_API_KEY");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"<a class="result__a" href="https://example.com/custom">Custom result</a>"#,
        )
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/search", server.addr()),
    );
    let raw = execute_tool(
        "WebSearch",
        &json!({
            "query": "provideraudit",
            "providers": ["custom", "brave"]
        }),
    )
    .expect("available custom provider should still return a partial result");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    if let Some(value) = previous_brave {
        std::env::set_var("BRAVE_SEARCH_API_KEY", value);
    }
    let output: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(output["status"], "partial");
    assert_eq!(output["coverage"]["exhausted"], false);
    let attempts = output["sourceAttempts"].as_array().expect("attempts");
    assert!(attempts.iter().any(|attempt| {
        attempt["provider"] == "brave"
            && attempt["status"] == "skipped"
            && attempt["coverage"]["truncatedReason"] == "missing_credentials"
    }));
    assert!(attempts
        .iter()
        .any(|attempt| { attempt["provider"] == "custom" && attempt["status"] == "completed" }));
}

#[test]
fn web_search_rejects_out_of_protocol_bounds_and_ambiguous_provider_modes() {
    let too_many = execute_tool(
        "WebSearch",
        &json!({ "query": "bounded search", "maxResults": 51 }),
    )
    .expect_err("maxResults above the protocol limit must not be silently clamped");
    assert!(too_many.contains("invalid_bound"), "{too_many}");

    let mixed_mode = execute_tool(
        "WebSearch",
        &json!({
            "query": "provider selection",
            "providers": ["auto", "duckduckgo"]
        }),
    )
    .expect_err("auto must not be combined with explicit providers");
    assert!(mixed_mode.contains("invalid_provider"), "{mixed_mode}");
}

#[test]
fn web_search_rejects_cross_origin_provider_pagination() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|_request_line: &str| HttpResponse {
        status: 200,
        reason: "OK",
        content_type: "application/json",
        body: r#"{
            "results": [{"title": "One", "url": "https://example.com/one"}],
            "next": "http://127.0.0.1:9/private"
        }"#
        .as_bytes()
        .to_vec(),
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/search", server.addr()),
    );
    let error = execute_tool(
        "WebSearch",
        &json!({ "query": "pagination origin", "providers": ["custom"] }),
    )
    .expect_err("provider pagination must remain on its configured origin");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    assert!(error.contains("pagination URL escaped"), "{error}");
}

#[test]
fn web_search_paginates_without_dropping_the_remainder_of_a_page() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        if request_line.contains("s=2") {
            HttpResponse::html(
                200,
                "OK",
                r#"<html><body>
                    <a class="result__a" href="https://example.com/three">Three</a>
                </body></html>"#,
            )
        } else {
            HttpResponse::html(
                200,
                "OK",
                r#"<html><body>
                    <a class="result__a" href="https://example.com/one">One</a>
                    <a class="result__a" href="https://example.com/two">Two</a>
                    <form action="/search" method="get">
                      <input type="submit" value="Next" />
                      <input type="hidden" name="q" value="paging" />
                      <input type="hidden" name="s" value="2" />
                    </form>
                </body></html>"#,
            )
        }
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/search", server.addr()),
    );

    let run = |cursor: Option<&str>, max_results: usize| {
        let mut input = json!({
            "query": "paging",
            "maxResults": max_results,
            "providers": ["custom"]
        });
        if let Some(cursor) = cursor {
            input["cursor"] = json!(cursor);
        }
        let raw = execute_tool("WebSearch", &input).expect("paged WebSearch should succeed");
        serde_json::from_str::<serde_json::Value>(&raw).expect("valid search JSON")
    };
    let hit_url = |value: &serde_json::Value| {
        value["results"]
            .as_array()
            .expect("results")
            .iter()
            .find_map(|item| item["content"].as_array())
            .and_then(|content| content.first())
            .and_then(|hit| hit["url"].as_str())
            .expect("one hit")
            .to_string()
    };

    let first = run(None, 1);
    assert_eq!(hit_url(&first), "https://example.com/one");
    assert_eq!(first["status"], "partial");
    assert_eq!(first["coverage"]["exhausted"], false);
    let first_cursor = first["coverage"]["nextCursor"]
        .as_str()
        .expect("same-page remainder cursor");

    let second = run(Some(first_cursor), 1);
    assert_eq!(hit_url(&second), "https://example.com/two");
    let second_cursor = second["coverage"]["nextCursor"]
        .as_str()
        .expect("next-page cursor");

    let third = run(Some(second_cursor), 1);
    assert_eq!(hit_url(&third), "https://example.com/three");
    assert_eq!(third["status"], "completed");
    assert_eq!(third["coverage"]["exhausted"], true);
    assert!(third["coverage"]["nextCursor"].is_null());

    let mismatch = execute_tool(
        "WebSearch",
        &json!({
            "query": "paging",
            "maxResults": 2,
            "providers": ["custom"],
            "cursor": first_cursor
        }),
    )
    .expect_err("cursor must bind maxResults");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    assert!(mismatch.contains("invalid_cursor"), "{mismatch}");
}

#[test]
fn web_search_cursor_suppresses_results_repeated_after_live_page_reordering() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        let request = counter.fetch_add(1, Ordering::SeqCst);
        let body = if request == 0 {
            r#"
                <a class="result__a" href="https://example.com/a">A</a>
                <a class="result__a" href="https://example.com/b">B</a>
                <a class="result__a" href="https://example.com/c">C</a>
            "#
        } else {
            r#"
                <a class="result__a" href="https://example.com/new">New</a>
                <a class="result__a" href="https://example.com/a">A repeated</a>
                <a class="result__a" href="https://example.com/b">B</a>
                <a class="result__a" href="https://example.com/c">C</a>
            "#
        };
        HttpResponse::html(200, "OK", body)
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/unstable", server.addr()),
    );
    let run = |cursor: Option<&str>| {
        let mut input = json!({
            "query": "unstable paging",
            "maxResults": 1,
            "providers": ["custom"]
        });
        if let Some(cursor) = cursor {
            input["cursor"] = json!(cursor);
        }
        let raw = execute_tool("WebSearch", &input).expect("paged WebSearch");
        serde_json::from_str::<serde_json::Value>(&raw).expect("valid search JSON")
    };
    let first = run(None);
    let first_cursor = first["coverage"]["nextCursor"]
        .as_str()
        .expect("continuation cursor");
    let second = run(Some(first_cursor));
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    let second_url = second["results"]
        .as_array()
        .expect("results")
        .iter()
        .find_map(|item| item["content"].as_array())
        .and_then(|content| content.first())
        .and_then(|hit| hit["url"].as_str())
        .expect("second hit");
    assert_eq!(
        first["results"][1]["content"][0]["url"],
        "https://example.com/a"
    );
    assert_eq!(second_url, "https://example.com/b");
}

#[test]
fn web_search_does_not_cache_or_complete_an_unrecognized_empty_page() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clear_web_search_cache_for_tests();
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let server = TestServer::spawn(Arc::new(move |_request_line: &str| {
        counter.fetch_add(1, Ordering::SeqCst);
        HttpResponse::html(
            200,
            "OK",
            "<html><body><div>layout changed</div></body></html>",
        )
    }));
    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/changed", server.addr()),
    );
    for _ in 0..2 {
        let error = execute_tool(
            "WebSearch",
            &json!({ "query": "parserdrift", "providers": ["custom"] }),
        )
        .expect_err("unknown empty markup must be a parse failure");
        assert!(error.contains("parse_error"), "{error}");
    }
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    assert_eq!(
        requests.load(Ordering::SeqCst),
        2,
        "parse failures execute once per call and are never cached as successful empty results"
    );
}

#[test]
fn web_fetch_blocks_private_targets_by_default_and_fails_http_errors() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-errors");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(404, "Not Found", "<html><body>missing</body></html>")
    }));
    let blocked = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/missing", server.addr()),
            "prompt": "read it"
        }),
    )
    .expect_err("private targets require explicit opt-in");
    assert!(blocked.contains("private_network"), "{blocked}");

    let missing = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/missing", server.addr()),
            "prompt": "read it",
            "allowPrivateNetwork": true
        }),
    )
    .expect_err("HTTP 404 must be a failed tool result");
    assert!(missing.contains("http_error"), "{missing}");
}

#[test]
fn web_fetch_removes_script_noise_and_selects_relevant_late_passages() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _workspace = WebFetchTestWorkspace::new("web-fetch-relevance");
    let server = TestServer::spawn(Arc::new(|_request_line: &str| {
        HttpResponse::html(
            200,
            "OK",
            r#"<html><head><title>Battery report</title></head><body>
                <script>SECRET_SCRIPT quantum efficiency 0</script>
                <p>This introductory paragraph discusses unrelated company history and office locations.</p>
                <p>The measured quantum battery efficiency reached 95 percent in the final evaluation.</p>
              </body></html>"#,
        )
    }));
    let raw = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/report", server.addr()),
            "prompt": "What was the quantum battery efficiency?",
            "allowPrivateNetwork": true,
            "maxChars": 1200
        }),
    )
    .expect("relevant page should be fetched");
    let output: serde_json::Value = serde_json::from_str(&raw).expect("valid fetch JSON");
    let result = output["result"].as_str().expect("result");
    assert!(result.contains("95 percent"), "{result}");
    assert!(!result.contains("SECRET_SCRIPT"), "{result}");
    assert_eq!(output["extraction"], "dom_markdown");
}

#[test]
fn search_hit_scan_survives_unclosed_anchor() {
    // Slicing one byte into a multi-byte title used to panic here.
    let hits = extract_search_hits(
        r#"<a class="result__a" href="https://example.com/one">中文标题"#,
        "test",
        "test:original",
    );
    assert!(hits.is_empty());

    let hits = extract_search_hits(
        concat!(
            r#"<a class="result__a" href="https://example.com/one">First</a>"#,
            r#"<a class="result__a" href="https://example.com/two">未闭合标题"#,
        ),
        "test",
        "test:original",
    );
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
    body: Vec<u8>,
}

impl HttpResponse {
    fn html(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/html; charset=utf-8",
            body: body.as_bytes().to_vec(),
        }
    }

    fn text(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/plain; charset=utf-8",
            body: body.as_bytes().to_vec(),
        }
    }

    fn bytes(status: u16, reason: &'static str, content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status,
            reason,
            content_type,
            body,
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.status,
            self.reason,
            self.content_type,
            self.body.len(),
        )
        .into_bytes();
        response.extend_from_slice(&self.body);
        response
    }
}

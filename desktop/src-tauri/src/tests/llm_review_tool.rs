use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

/// A local Reviewer endpoint that requires a real tool result before reporting.
struct ReviewerGateway {
    url: String,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ReviewerGateway {
    fn new(fail: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let worker_stop = Arc::clone(&stop);
        let captured = Arc::clone(&requests);
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let header_end = loop {
                    let count = socket.read(&mut buffer).unwrap_or(0);
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().ok())
                            .flatten()
                    })
                    .unwrap();
                while bytes.len() < header_end + length {
                    let count = socket.read(&mut buffer).unwrap_or(0);
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let request: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                captured.lock().unwrap().push(request.clone());
                if fail {
                    let body = r#"{"error":{"message":"reviewer account unauthorized"}}"#;
                    let _ = write!(socket, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    continue;
                }
                let has_tools = request["tools"]
                    .as_array()
                    .is_some_and(|tools| !tools.is_empty());
                let tool_done = request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| message["role"] == "tool");
                let (delta, finish) = if has_tools && !tool_done {
                    (
                        json!({"tool_calls":[{"index":0,"id":"review-file","type":"function",
                        "function":{"name":"read_file","arguments":"{\"path\":\"notes.md\"}"}}]}),
                        "tool_calls",
                    )
                } else {
                    (
                        json!({"content": if has_tools {"Evidence checked: notes.md:2."} else {"Single request review."}}),
                        "stop",
                    )
                };
                let data = format!(
                    "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"review-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                    json!({"id":"review-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":30,"completion_tokens":20}})
                );
                let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len());
            }
        });
        Self {
            url,
            stop,
            requests,
            worker: Some(worker),
        }
    }
}

impl Drop for ReviewerGateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn configure_reviewer(fixture: &mut MultiWorkspaceFixture, gateway: &ReviewerGateway, mode: &str) {
    fixture.previous_env.extend(
        [
            "ARIS_REVIEWER_PROVIDER",
            "ARIS_REVIEWER_MODEL",
            "ARIS_REVIEWER_BASE_URL",
            "ARIS_REVIEWER_AUTH_TOKEN",
            "ARIS_REVIEWER_ROUTING_SESSION_BASE_URL",
        ]
        .into_iter()
        .map(|key| (key, std::env::var_os(key))),
    );
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "custom");
    std::env::set_var("ARIS_REVIEWER_MODEL", "independent-reviewer-fixture");
    std::env::set_var("ARIS_REVIEWER_BASE_URL", &gateway.url);
    std::env::set_var("ARIS_REVIEWER_AUTH_TOKEN", "local-mock-only");
    std::env::remove_var("ARIS_REVIEWER_ROUTING_SESSION_BASE_URL");
    fs::write(
        crate::state::config_path(),
        json!({
            "review_mode": mode,
            "reviewer_provider": "custom", "reviewer_model": "independent-reviewer-fixture",
            "reviewer_base_url": gateway.url,
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn kernel_llm_review_uses_the_configured_child_and_explicit_compatibility_routes() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    for (mode, bound, expected_requests) in [
        ("thread", true, 2),
        ("oneshot", true, 1),
        ("thread", false, 1),
    ] {
        let mut fixture = MultiWorkspaceFixture::new();
        let gateway = ReviewerGateway::new(false);
        configure_reviewer(&mut fixture, &gateway, mode);
        let chat = crate::review_thread::tests::chat(&format!("kernel-llm-{mode}-{bound}"));
        let mut executor = KernelToolExecutor {
            session_id: chat.agent.session_id().into(),
            turn_id: chat.agent.turn_id().into(),
            turn_agent: bound.then(|| chat.agent.clone()),
            extra_blocked_tools: &[],
            cancelled: Some(Arc::new(AtomicBool::new(false))),
            progress_sink: None,
            max_output_tokens: None,
            project_execution_context: runtime::ProjectExecutionContext::new(&chat.workspace),
        };
        let report = executor
            .execute_with_id(
                "skill-review-call",
                "LlmReview",
                r#"{"prompt":"Check notes.md and cite evidence."}"#,
            )
            .unwrap();
        let requests = gateway.requests.lock().unwrap();
        assert_eq!(requests.len(), expected_requests, "{mode}, bound={bound}");
        assert!(requests
            .iter()
            .all(|request| request["model"] == "independent-reviewer-fixture"));
        if expected_requests == 2 {
            assert_eq!(report, "Evidence checked: notes.md:2.");
            assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 3);
            assert!(requests[1]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["role"] == "tool"
                        && message["content"]
                            .as_str()
                            .unwrap()
                            .contains("     2| second line")
                }));
        } else {
            assert_eq!(report, "Single request review.");
            assert!(requests[0]["tools"]
                .as_array()
                .is_none_or(|tools| tools.is_empty()));
        }
        assert_eq!(
            chat.agent
                .control()
                .list_all(chat.agent.session_id())
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn kernel_llm_review_reports_failure_without_a_second_paid_route() {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut fixture = MultiWorkspaceFixture::new();
    let gateway = ReviewerGateway::new(true);
    configure_reviewer(&mut fixture, &gateway, "thread");
    let chat = crate::review_thread::tests::chat("kernel-llm-failure");
    let error = run_llm_review_tool(
        Some(&chat.agent),
        chat.agent.session_id(),
        "review-call",
        &chat.workspace,
        Arc::new(AtomicBool::new(false)),
        &json!({"prompt":"Check notes.md"}),
    )
    .unwrap_err();
    assert!(error.contains("LlmReview sub-agent failed"), "{error}");
    assert_eq!(gateway.requests.lock().unwrap().len(), 1);
    assert_eq!(
        chat.agent
            .control()
            .list_all(chat.agent.session_id())
            .unwrap()
            .len(),
        1
    );
}

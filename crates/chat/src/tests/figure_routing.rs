use super::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).unwrap();
        assert_ne!(count, 0, "request ended before its body arrived");
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(bytes).unwrap()
}

fn routing_case(
    responses: bool,
    opencode_proxy: bool,
    explicit_connection: bool,
    managed_gateway: bool,
    svg_limit: Option<u32>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            requests.push(read_request(&mut stream));
            let has_session = requests
                .last()
                .unwrap()
                .to_ascii_lowercase()
                .contains("\nx-opencode-session:");
            if opencode_proxy && !has_session && index < 2 {
                let body = r#"{"error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session"}}"#;
                write!(stream, "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
                continue;
            }
            let body = if responses && requests.last().unwrap().starts_with("POST /v1/responses ") {
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
            } else {
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            };
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    let (executor_model, reviewer_model) = if responses {
        ("gpt-5.5", "gpt-5.5-mini")
    } else {
        ("figure-test-executor", "figure-test-reviewer")
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    // Recreate both connections; the same gateway/model can select an ordinary
    // upstream after an OpenCode error. Error evidence must not classify it.
    for iteration in 0..2 {
        let mut settings = json!({
            "executor_provider": if explicit_connection { "opencode" } else { "openai" }, "executor_api_key": "test-key",
            "executor_model": executor_model, "executor_base_url": base_url,
            "executor_transport": if responses { "responses" } else { "chat_completions" },
        });
        if managed_gateway {
            settings["newapi_executor_base_url"] = json!(base_url);
        }
        let (_, provider, config) =
            crate::resolve_settings_executor_config(settings.as_object().unwrap()).unwrap();
        assert_eq!(
            provider,
            if explicit_connection {
                "opencode"
            } else {
                "openai"
            }
        );
        let executor = FigureExecutor::new(executor_model.into(), provider, config);
        let reviewer = tools::PreparedLlmReview::openai_compatible(
            "test-key".into(),
            base_url.clone(),
            reviewer_model.into(),
        )
        .with_routing_session_header(explicit_connection || managed_gateway)
        .freeze_for_figures();
        let reply = executor
            .run_with_limit(
                "figure-task-executor",
                request(
                    RECONSTRUCTION_SYSTEM,
                    "reconstruct".into(),
                    vec![("image/png".into(), "aW1hZ2U=".into())],
                ),
                svg_limit,
                cancelled.clone(),
            )
            .unwrap();
        if opencode_proxy && !explicit_connection && !managed_gateway && iteration == 0 {
            assert!(reply.error.as_deref().unwrap().contains("HTTP 400"));
        } else {
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert_eq!(reply.text, "ok");
        }
        let reply = reviewer
            .run_figure_request(
                "figure-task-reviewer",
                request(
                    REVIEW_SYSTEM,
                    "review".into(),
                    vec![("image/png".into(), "aW1hZ2U=".into())],
                ),
                8192,
                cancelled.clone(),
            )
            .unwrap();
        if opencode_proxy && !explicit_connection && !managed_gateway && iteration == 0 {
            assert!(reply.error.as_deref().unwrap().contains("HTTP 400"));
        } else {
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert_eq!(reply.text, "ok");
        }
    }
    for (index, wire) in server.join().unwrap().iter().enumerate() {
        let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
        let executor = index % 2 == 0;
        let session = if executor {
            "figure-task-executor"
        } else {
            "figure-task-reviewer"
        };
        let header = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case(api::OPENCODE_SESSION_HEADER)
                .then(|| value.trim())
        });
        assert_eq!(
            header,
            (explicit_connection || managed_gateway).then_some(session)
        );
        let uses_responses = responses && executor;
        assert!(headers.starts_with(if uses_responses {
            "POST /v1/responses "
        } else {
            "POST /v1/chat/completions "
        }));
        let body: Value = serde_json::from_str(body).unwrap();
        if executor && svg_limit.is_none() {
            for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
                assert!(
                    body.get(field).is_none(),
                    "uncapped figure must match Chat: {body}"
                );
            }
        } else {
            assert_eq!(
                body[if uses_responses {
                    "max_output_tokens"
                } else if responses {
                    "max_completion_tokens"
                } else {
                    "max_tokens"
                }],
                if executor { svg_limit.unwrap() } else { 8192 }
            );
        }
        assert_eq!(
            body["model"],
            if executor {
                executor_model
            } else {
                reviewer_model
            }
        );
        assert!(body.to_string().contains("data:image/png;base64,aW1hZ2U="));
        assert!(body.to_string().contains(if executor {
            RECONSTRUCTION_SYSTEM
        } else {
            "independent scientific figure Reviewer"
        }));
        if !executor {
            assert!(!body.to_string().contains(RECONSTRUCTION_SYSTEM));
        }
    }
}

#[test]
fn unknown_opencode_figure_errors_do_not_classify_later_calls() {
    routing_case(false, true, false, false, Some(1024));
}

#[test]
fn explicit_opencode_figures_keep_routing_with_responses_transport() {
    routing_case(true, true, true, false, Some(1024));
}

#[test]
fn explicit_opencode_figures_keep_separate_stable_sessions() {
    routing_case(false, true, true, false, Some(1024));
}

#[test]
fn ordinary_custom_figure_endpoints_do_not_receive_opencode_headers() {
    routing_case(false, false, false, false, Some(1024));
}

#[test]
fn managed_figure_connections_send_sessions_on_the_first_request_for_both_roles() {
    routing_case(false, true, false, true, Some(1024));
    routing_case(true, true, false, true, Some(1024));
}

#[test]
fn uncapped_figure_requests_match_chat_on_both_openai_transports() {
    routing_case(false, false, false, true, None);
    routing_case(true, false, false, true, None);
}

#[test]
fn anthropic_svg_requests_send_the_cap_resolved_by_chat() {
    for model in ["claude-sonnet-4-6", "gpt-5.5", "unknown-model"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let body = r#"{"error":{"type":"invalid_request_error","message":"mock rejection"}}"#;
            write!(stream, "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            request
        });
        let executor = FigureExecutor::new(
            model.into(),
            "anthropic".into(),
            ChatExecutorConfig::Anthropic {
                auth: api::AuthSource::ApiKey("own-key".into()),
                base_url,
                send_betas: false,
            },
        );
        let limit = executor.chat_output_limit();
        assert_eq!(limit, Some(crate::max_tokens_for_model(model)));
        let reply = executor
            .run_with_limit(
                "figure-test-executor",
                request(RECONSTRUCTION_SYSTEM, "draw".into(), Vec::new()),
                limit,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        assert!(reply.error.is_some());
        let wire = server.join().unwrap();
        let body: Value = serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["max_tokens"], limit.unwrap());
    }
}

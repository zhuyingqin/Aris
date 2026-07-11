use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use super::{fetch_openai_models, model_select_items, normalize_openai_base_url};

#[test]
fn normalize_openai_base_url_strips_known_suffixes() {
    assert_eq!(
        normalize_openai_base_url("https://example.com/v1/chat/completions"),
        "https://example.com/v1"
    );
    assert_eq!(
        normalize_openai_base_url("https://example.com/v1/models"),
        "https://example.com/v1"
    );
    assert_eq!(
        normalize_openai_base_url("https://example.com/v1/"),
        "https://example.com/v1"
    );
}

#[test]
fn fetch_openai_models_uses_models_endpoint_and_deduplicates_ids() {
    let request_capture = Arc::new(Mutex::new(String::new()));
    let request_capture_for_thread = Arc::clone(&request_capture);
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
    let addr = listener.local_addr().expect("listener addr");

    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept connection");
        let mut buffer = [0_u8; 4096];
        let bytes = stream.read(&mut buffer).expect("read request");
        *request_capture_for_thread.lock().expect("lock capture") =
            String::from_utf8_lossy(&buffer[..bytes]).into_owned();

        let body = serde_json::json!({
            "data": [
                {"id": "alpha", "owned_by": "vendor-a"},
                {"id": "alpha", "owned_by": "vendor-a"},
                {"id": "beta"}
            ]
        })
        .to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write response");
    });

    let models =
        fetch_openai_models(&format!("http://{addr}/v1"), "test-key").expect("fetch models");
    handle.join().expect("server thread");

    let request = request_capture.lock().expect("lock capture").clone();
    assert!(request.starts_with("GET /v1/models HTTP/1.1"));
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer test-key"));
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "alpha");
    assert_eq!(models[0].owned_by.as_deref(), Some("vendor-a"));
    assert_eq!(models[1].id, "beta");
    assert_eq!(models[1].owned_by, None);
}

#[test]
fn model_select_items_marks_current_model() {
    let items = model_select_items(
        &[
            super::OpenAIModelInfo {
                id: "alpha".to_string(),
                owned_by: Some("vendor-a".to_string()),
            },
            super::OpenAIModelInfo {
                id: "beta".to_string(),
                owned_by: None,
            },
        ],
        "beta",
    );
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].description, "vendor-a");
    assert!(!items[0].is_current);
    assert!(items[1].is_current);
}

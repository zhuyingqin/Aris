use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};

fn png() -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    ::image::DynamicImage::new_rgb8(2, 3)
        .write_to(&mut cursor, ::image::ImageFormat::Png)
        .unwrap();
    cursor.into_inner()
}

fn response() -> String {
    serde_json::json!({"data": [{"b64_json": STANDARD.encode(png())}], "usage": {"total_tokens": 4}}).to_string()
}

fn server(body: String, status: &str) -> (String, thread::JoinHandle<(String, usize)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let status = status.to_string();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|length| length.parse().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        drop(stream);
        listener.set_nonblocking(true).unwrap();
        thread::sleep(Duration::from_millis(200));
        let extra = usize::from(listener.accept().is_ok());
        (String::from_utf8_lossy(&request).into_owned(), 1 + extra)
    });
    (base, handle)
}

fn request() -> ImageGenerationRequest {
    ImageGenerationRequest {
        model: "gpt-image-2".into(),
        prompt: "A simple blue circle".into(),
        size: "1024x1024".into(),
        quality: Some("low".into()),
        n: 1,
    }
}

#[tokio::test]
async fn generation_uses_account_auth_and_returns_validated_pixels() {
    let (base, server) = server(response(), "200 OK");
    let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
    let result = client.generate(&request(), vec![]).await.unwrap();
    assert_eq!(result.images[0].bytes, png());
    assert_eq!((result.images[0].width, result.images[0].height), (2, 3));
    assert_eq!(result.usage.unwrap()["total_tokens"], 4);
    let (sent, count) = server.join().unwrap();
    assert!(sent.starts_with("POST /v1/images/generations "));
    assert!(sent
        .to_ascii_lowercase()
        .contains("authorization: bearer fixture-key"));
    let body: Value = serde_json::from_str(sent.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["prompt"], request().prompt);
    assert_eq!(body["n"], 1);
    assert_eq!(count, 1);
}

#[tokio::test]
async fn reference_images_use_the_edits_multipart_endpoint() {
    let (base, server) = server(response(), "200 OK");
    let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
    client
        .generate(
            &request(),
            vec![ImageReference {
                name: "reference.png".into(),
                image: validate_image_bytes(png()).unwrap(),
            }],
        )
        .await
        .unwrap();
    let (sent, _) = server.join().unwrap();
    assert!(sent.starts_with("POST /v1/images/edits "));
    assert!(sent.contains("name=\"image[]\"; filename=\"reference.png\""));
    assert!(sent.contains("Content-Type: image/png"));
}

#[tokio::test]
async fn failed_paid_submissions_are_not_retried_and_credentials_are_redacted() {
    let (base, server) = server(
        r#"{"error":{"message":"fixture-key quota exceeded"}}"#.into(),
        "429 Too Many Requests",
    );
    let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
    let error = client.generate(&request(), vec![]).await.err().unwrap();
    assert!(error.contains("quota exceeded"));
    assert!(!error.contains("fixture-key"));
    assert_eq!(server.join().unwrap().1, 1);
}

#[tokio::test]
async fn invalid_results_do_not_become_artifacts() {
    for body in [r#"{"data":[]}"#.to_string(), r#"{"data":[{"b64_json":"%%%"}]}"#.to_string(),
        r#"{"data":[{"url":"https://127.0.0.1/private.png"}]}"#.to_string(),
        serde_json::json!({"data": [{"b64_json": STANDARD.encode(png())}, {"b64_json": STANDARD.encode(png())}]}).to_string()]
    {
        let (base, server) = server(body, "200 OK");
        let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
        assert!(client.generate(&request(), vec![]).await.is_err());
        assert_eq!(server.join().unwrap().1, 1);
    }
}

#[tokio::test]
async fn unpublished_gateway_routes_have_an_actionable_error() {
    let (base, server) = server(
        "<html><body>404 Not Found</body></html>".into(),
        "404 Not Found",
    );
    let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
    let error = client.generate(&request(), vec![]).await.err().unwrap();
    assert!(error.contains("HTTP 404"));
    assert!(error.contains("网关是否开放图片生成和编辑接口"));
    assert_eq!(server.join().unwrap().1, 1);
}

#[test]
fn validates_models_payloads_and_real_image_content() {
    assert!(is_image_generation_model("gpt-image-2.5-flare"));
    assert!(!is_image_generation_model("gpt-6.1-sol"));
    let mut input = request();
    input.n = 5;
    assert!(input.validate().is_err());
    input.n = 1;
    input.prompt.clear();
    assert!(input.validate().is_err());
    assert!(validate_image_bytes(b"not an image".to_vec()).is_err());
    assert!(validate_image_bytes(vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    let mut corrupt = png();
    corrupt.truncate(40);
    assert!(validate_image_bytes(corrupt).is_err());
}

#[test]
fn public_downloads_reject_internal_ip_ranges() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.1.1",
        "100.64.1.1",
        "192.168.0.1",
        "::1",
        "fc00::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "{ip}");
    }
    assert!(public_ip("1.1.1.1".parse().unwrap()));
    assert!(ImageApiClient::new("https://user:password@example.com/v1", "key".into()).is_err());
    assert!(ImageApiClient::new("http://example.com/v1", "key".into()).is_err());
}

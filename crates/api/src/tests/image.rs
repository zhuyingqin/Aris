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

#[test]
fn dimension_rounding_is_distinct_from_an_actual_canvas_change() {
    for (base, returned) in [((2171, 724), (2170, 725)), ((2048, 1024), (2046, 1026)), ((400, 400), (402, 400)), ((1, 1), (1, 1))] {
        assert!(image_dimensions_match_with_rounding(base, returned));
        assert!(image_dimensions_match_with_rounding(returned, base));
    }
    for (base, returned) in [((100, 100), (101, 100)), ((4, 3), (6, 2)), ((1024, 1024), (2048, 2048)), ((2048, 1024), (2045, 1024)), ((0, 100), (1, 100)), ((u32::MAX, 100), (u32::MAX, 100))] {
        assert!(!image_dimensions_match_with_rounding(base, returned));
    }
}

#[test]
fn vision_selection_map_is_opaque_white_for_editable_pixels_only() {
    let reference = validate_image_bytes(png()).unwrap();
    for whole in [false, true] {
        let pixels = ::image::RgbaImage::from_fn(2, 3, |x, _| ::image::Rgba([27, 91, 180, if whole || x == 0 { 0 } else { 255 }]));
        let mut output = Cursor::new(Vec::new());
        ::image::DynamicImage::ImageRgba8(pixels).write_to(&mut output, ::image::ImageFormat::Png).unwrap();
        let mask = validate_edit_mask(output.into_inner(), &reference).unwrap();
        let preview = mask.selection_preview().unwrap();
        assert_eq!((preview.width, preview.height), (2, 3));
        let pixels = ::image::load_from_memory(&preview.bytes).unwrap().to_rgba8();
        for (x, _, pixel) in pixels.enumerate_pixels() {
            let color = if whole || x == 0 { 255 } else { 0 };
            assert_eq!(pixel.0, [color, color, color, 255]);
        }
    }
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

fn mask_png(width: u32, height: u32, selected: bool) -> Vec<u8> {
    let mut pixels =
        ::image::RgbaImage::from_pixel(width, height, ::image::Rgba([255, 255, 255, 255]));
    if selected {
        pixels.put_pixel(0, 1, ::image::Rgba([0, 0, 0, 0]));
    }
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, ::image::ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

#[tokio::test]
async fn region_edits_send_a_real_png_mask_once_and_never_fall_back_to_generation() {
    let reference = validate_image_bytes(png()).unwrap();
    let mask = validate_edit_mask(mask_png(2, 3, true), &reference).unwrap();
    let (base, server) = server(
        r#"{"error":{"message":"mask unsupported"}}"#.into(),
        "400 Bad Request",
    );
    let client = ImageApiClient::new(&base, "fixture-key".into()).unwrap();
    let error = client
        .edit(
            &request(),
            ImageReference {
                name: "original.png".into(),
                image: reference,
            },
            &mask,
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("mask unsupported"));
    let (sent, count) = server.join().unwrap();
    assert_eq!(count, 1);
    assert!(sent.starts_with("POST /v1/images/edits "));
    assert!(sent.contains("name=\"image[]\"; filename=\"original.png\""));
    assert!(sent.contains("name=\"mask\"; filename=\"selection.png\""));
}

#[test]
fn edit_mask_validation_and_compositing_protect_every_unselected_pixel() {
    let original = validate_image_bytes(png()).unwrap();
    assert!(validate_edit_mask(mask_png(3, 3, true), &original).is_err());
    assert!(validate_edit_mask(mask_png(2, 3, false), &original).is_err());
    assert!(validate_edit_mask(png(), &original).is_err()); // RGB has no transparent region.
    let mask = validate_edit_mask(mask_png(2, 3, true), &original).unwrap();
    let pixels = ::image::RgbaImage::from_pixel(2, 3, ::image::Rgba([200, 80, 30, 255]));
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, ::image::ImageFormat::Png)
        .unwrap();
    let edited = validate_image_bytes(output.into_inner()).unwrap();
    let result = composite_masked_edit(&original, &edited, &mask).unwrap();
    let result = ::image::load_from_memory(&result.bytes).unwrap().to_rgba8();
    let base = ::image::load_from_memory(&original.bytes)
        .unwrap()
        .to_rgba8();
    for (x, y, pixel) in result.enumerate_pixels() {
        assert_eq!(
            *pixel,
            if (x, y) == (0, 1) {
                ::image::Rgba([200, 80, 30, 255])
            } else {
                *base.get_pixel(x, y)
            }
        );
    }
    let wrong_size = validate_image_bytes(mask_png(3, 3, true)).unwrap();
    assert!(composite_masked_edit(&original, &wrong_size, &mask).is_err());
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

#[test]
fn explicit_resize_then_selection_preserves_protected_pixels() {
    let original = validate_image_bytes(png()).unwrap();
    let mask = validate_edit_mask(mask_png(2, 3, true), &original).unwrap();
    let pixels = ::image::RgbaImage::from_pixel(5, 2, ::image::Rgba([200, 80, 30, 255]));
    let mut output = Cursor::new(Vec::new());
    pixels.write_to(&mut output, ::image::ImageFormat::Png).unwrap();
    let returned = validate_image_bytes(output.into_inner()).unwrap();
    let resized = resize_image_exact(&returned, original.width, original.height).unwrap();
    assert_eq!((returned.width, returned.height), (5, 2));
    let result = composite_masked_edit(&original, &resized, &mask).unwrap();
    let result = ::image::load_from_memory(&result.bytes).unwrap().to_rgba8();
    let base = ::image::load_from_memory(&original.bytes).unwrap().to_rgba8();
    for (x, y, pixel) in result.enumerate_pixels() {
        assert_eq!(*pixel, if (x, y) == (0, 1) { ::image::Rgba([200, 80, 30, 255]) } else { *base.get_pixel(x, y) });
    }
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

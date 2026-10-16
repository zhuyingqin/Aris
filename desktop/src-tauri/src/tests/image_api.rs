use super::*;

#[test]
fn drawing_preferences_are_separate_from_chat_and_reviewer_models() {
    let mut obj = json!({"managed_models": ["gpt-6.1-sol", "gpt-image-2.5-flare", "gpt-image-2"],
        "newapi_executor_base_url": "https://somni.ensuanx.com/v1", "newapi_executor_api_key": "fixture-key",
        "executor_model": "gpt-6.1-sol", "reviewer_model": "gpt-6-astra"}).as_object().unwrap().clone();
    let settings = settings_from_object(&obj);
    assert_eq!(settings.models, ["gpt-image-2", "gpt-image-2.5-flare"]);
    assert_eq!(settings.model.as_deref(), Some("gpt-image-2"));
    assert!(settings.available);
    obj.insert("somni_image_enabled".into(), json!(false));
    assert!(!settings_from_object(&obj).available);
    obj.insert("somni_image_enabled".into(), json!(true));
    obj.insert("somni_image_model".into(), json!("removed-model"));
    assert!(!settings_from_object(&obj).available);
    assert_eq!(obj["executor_model"], "gpt-6.1-sol");
    assert_eq!(obj["reviewer_model"], "gpt-6-astra");
}

#[test]
fn credentials_never_follow_an_unapproved_gateway() {
    let obj = json!({"newapi_executor_base_url": "https://other.example/v1", "newapi_executor_api_key": "fixture-key"});
    assert!(managed_credentials(obj.as_object().unwrap()).is_err());
}

#[test]
fn references_cannot_escape_the_project_or_send_non_images() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("project");
    fs::create_dir(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();
    fs::write(directory.path().join("outside.png"), b"outside").unwrap();
    assert!(reference_images(&workspace, &["../outside.png".into()])
        .err()
        .unwrap()
        .contains("当前项目"));
    fs::write(workspace.join("notes.txt"), b"private notes").unwrap();
    assert!(reference_images(&workspace, &["notes.txt".into()]).is_err());
}

#[test]
fn saves_images_and_auditable_prompt_model_hash_without_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().canonicalize().unwrap();
    let request = ImageGenerationRequest {
        model: "gpt-image-2".into(),
        prompt: "A blue research diagram".into(),
        size: "1024x1024".into(),
        quality: None,
        n: 1,
    };
    let result = api::ImageGenerationResult {
        images: vec![api::GeneratedImage {
            bytes: vec![1, 2, 3],
            mime_type: "image/png",
            extension: "png",
            width: 2,
            height: 3,
            revised_prompt: None,
        }],
        usage: Some(json!({"total_tokens": 5})),
    };
    let output = save_result(&workspace, "fixture-run", &request, &[], result).unwrap();
    assert_eq!(
        output["images"][0]["path"],
        ".somniq/artifacts/somni-images/fixture-run/image-1.png"
    );
    assert_eq!(output["model"], request.model);
    assert_eq!(output["prompt"], request.prompt);
    assert_eq!(output["images"][0]["sha256"].as_str().unwrap().len(), 64);
    let manifest = fs::read_to_string(
        workspace.join(".somniq/artifacts/somni-images/fixture-run/generation.json"),
    )
    .unwrap();
    assert!(!manifest.contains("api_key"));
    assert!(manifest.contains(&request.prompt));
}

#[tokio::test]
async fn running_image_requests_can_be_cancelled_after_the_server_accepts_them() {
    use std::{io::Read, net::TcpListener, thread};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = ImageApiClient::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        "fixture-key".into(),
    )
    .unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let server_flag = Arc::clone(&flag);
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = [0_u8; 1024];
        assert!(socket.read(&mut request).unwrap() > 0);
        server_flag.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(250));
    });
    let request = ImageGenerationRequest {
        model: "gpt-image-2".into(),
        prompt: "fixture".into(),
        size: "1024x1024".into(),
        quality: None,
        n: 1,
    };
    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        generate_with_cancel(&client, &request, vec![], &flag),
    )
    .await
    .unwrap();
    assert!(outcome.err().unwrap().contains("取消"));
    server.join().unwrap();
}

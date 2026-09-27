use super::*;

pub(super) fn fixture() -> (tempfile::TempDir, PaperReadingRun) {
    let directory = tempfile::tempdir().unwrap();
    let run = PaperReadingRun::new(
        "paper".into(),
        "A paper".into(),
        "papers/test.pdf".into(),
        content_sha256(b"PDF"),
        1,
        "vision-model".into(),
        content_sha256(b"model connection"),
        "zh".into(),
    )
    .unwrap();
    let run = open_literature_store_at(directory.path())
        .unwrap()
        .save_paper_reading_run(&run)
        .unwrap();
    fs::create_dir_all(artifact_dir(directory.path(), &run.id).unwrap()).unwrap();
    (directory, run)
}

pub(super) fn input(run: &PaperReadingRun, marker: u8) -> PageSourceInput {
    PageSourceInput {
        project_id: "project".into(),
        run_id: run.id.clone(),
        page_index: 0,
        document_revision: run.document_revision.clone(),
        image_base64: base64::engine::general_purpose::STANDARD
            .encode([0xff, 0xd8, 0xff, marker, 0xff, 0xd9]),
        embedded_text: "Actual original PDF text".into(),
        text_truncated: false,
    }
}

#[test]
fn raw_evidence_reaches_the_chat_message_and_cannot_be_replaced_by_a_draft() {
    let (directory, run) = fixture();
    assert!(original_page_message(directory.path(), &run, 0).is_err());
    let saved = save_page_source(directory.path(), input(&run, 1)).unwrap();
    let message = original_page_message(directory.path(), &saved, 0).unwrap();
    assert!(message.blocks.iter().any(|block| matches!(block, ContentBlock::Text { text } if text.contains("Actual original PDF text"))));
    assert!(message.blocks.iter().any(|block| matches!(block, ContentBlock::Image { media_type, data } if media_type == "image/jpeg" && !data.is_empty())));
    let path = artifact_dir(directory.path(), &run.id)
        .unwrap()
        .join("page-0.jpg");
    fs::write(&path, b"a perception draft is not original evidence").unwrap();
    assert!(original_page_message(directory.path(), &saved, 0).is_err());
    fs::remove_file(&path).unwrap();
    assert!(original_page_message(directory.path(), &saved, 0).is_err());
}

#[test]
fn concurrent_source_preparation_preserves_the_winning_image_and_metadata() {
    let (directory, run) = fixture();
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| save_page_source(directory.path(), input(&run, 1)));
        let second = scope.spawn(|| save_page_source(directory.path(), input(&run, 2)));
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_ne!(first.is_ok(), second.is_ok());
    let saved = load_run(directory.path(), &run.id).unwrap();
    let image = fs::read(
        artifact_dir(directory.path(), &run.id)
            .unwrap()
            .join("page-0.jpg"),
    )
    .unwrap();
    assert_eq!(
        saved.pages[0].source.as_ref().unwrap().image_sha256,
        content_sha256(&image)
    );
    assert!(original_page_message(directory.path(), &saved, 0).is_ok());
}

#[test]
fn invalid_source_identity_cannot_create_artifacts() {
    let (directory, run) = fixture();
    let mut wrong = input(&run, 1);
    wrong.document_revision = content_sha256(b"another PDF");
    assert!(save_page_source(directory.path(), wrong).is_err());
    let mut wrong = input(&run, 1);
    wrong.page_index = 99;
    assert!(save_page_source(directory.path(), wrong).is_err());
    assert!(!artifact_dir(directory.path(), &run.id)
        .unwrap()
        .join("page-99.jpg")
        .exists());
    assert!(artifact_dir(directory.path(), "../escape").is_err());
    assert!(load_run(directory.path(), &run.id).unwrap().pages[0]
        .source
        .is_none());
}

#[test]
fn cancellation_is_durable_and_idempotent() {
    let (directory, run) = fixture();
    let mut saved = save_page_source(directory.path(), input(&run, 1)).unwrap();
    saved.start().unwrap();
    saved.begin_page(0, "session".into()).unwrap();
    open_literature_store_at(directory.path())
        .unwrap()
        .save_paper_reading_run(&saved)
        .unwrap();
    let cancelled = cancel_saved_run(directory.path(), &run.id).unwrap();
    assert_eq!(cancelled.status, PaperReadingStatus::Cancelled);
    assert_eq!(cancelled.pages[0].attempts[0].status, "cancelled");
    assert_eq!(
        cancel_saved_run(directory.path(), &run.id)
            .unwrap()
            .revision,
        cancelled.revision
    );
}

#[test]
fn prepare_accepts_an_explicit_model_and_legacy_requests() {
    let mut request = serde_json::json!({"projectId":"p","paperId":"paper","relativePath":"paper.pdf","documentRevision":"hash","language":"zh"});
    let legacy: PreparePaperInput = serde_json::from_value(request.clone()).unwrap();
    assert!(legacy.model.is_none());
    assert!(!legacy.regenerate);
    assert!(legacy.run_id.is_none());
    request["model"] = serde_json::json!("vision-b");
    let selected: PreparePaperInput = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(selected.model.as_deref(), Some("vision-b"));
    request["regenerate"] = serde_json::json!(true);
    request["runId"] = serde_json::json!("a".repeat(64));
    let regenerate: PreparePaperInput = serde_json::from_value(request).unwrap();
    assert!(regenerate.regenerate);
    assert_eq!(regenerate.run_id.as_deref(), Some("a".repeat(64).as_str()));
}

#[test]
fn different_generation_models_keep_independent_saved_results() {
    let (directory, first) = fixture();
    let second = PaperReadingRun::new(
        first.paper_id.clone(),
        first.title.clone(),
        first.relative_path.clone(),
        first.document_revision.clone(),
        first.total_pages,
        "vision-b".into(),
        first.executor_signature.clone(),
        first.language.clone(),
    )
    .unwrap();
    assert_ne!(first.id, second.id);
    let store = open_literature_store_at(directory.path()).unwrap();
    store.save_paper_reading_run(&second).unwrap();
    assert_eq!(
        store.paper_reading_run(&first.id).unwrap().unwrap().model,
        "vision-model"
    );
    assert_eq!(
        store.paper_reading_run(&second.id).unwrap().unwrap().model,
        "vision-b"
    );
    assert_ne!(
        artifact_dir(directory.path(), &first.id).unwrap(),
        artifact_dir(directory.path(), &second.id).unwrap()
    );
}

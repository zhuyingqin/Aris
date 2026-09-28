use super::*;
use crate::literature::open_literature_store_at;

fn run(pages: usize) -> PaperReadingRun {
    PaperReadingRun::new(
        "paper-1".into(),
        "A paper".into(),
        "papers/paper.pdf".into(),
        content_sha256(b"original PDF"),
        pages,
        "vision-model".into(),
        content_sha256(b"model connection"),
        "zh".into(),
    )
    .unwrap()
}

fn attach(run: &mut PaperReadingRun, page_index: usize) {
    run.attach_source(OriginalPageEvidence {
        document_revision: run.document_revision.clone(),
        page_index,
        image_sha256: content_sha256(b"original page image"),
        image_file: format!("page-{page_index}.jpg"),
        mime_type: "image/jpeg".into(),
        embedded_text: "Original text, not a perception draft".into(),
        text_truncated: false,
    })
    .unwrap();
}

fn output(page_index: usize) -> String {
    serde_json::json!({
        "pageIndex": page_index,
        "items": [{"kind":"formula","content":"x = 1","uncertainties":[]}],
        "warnings": []
    })
    .to_string()
}

#[test]
fn completed_pages_do_not_claim_recognition_completeness_or_review() {
    let mut run = run(2);
    attach(&mut run, 0);
    attach(&mut run, 1);
    run.start().unwrap();
    for page_index in 0..2 {
        let session = format!("session-{page_index}");
        run.begin_page(page_index, session.clone()).unwrap();
        run.finish_page(page_index, &session, Ok(&output(page_index)))
            .unwrap();
    }
    run.finish();
    let coverage = run.coverage();
    assert_eq!(run.status, PaperReadingStatus::PageProcessingComplete);
    assert_eq!(coverage.page_processing_coverage.completed, 2);
    assert_eq!(
        coverage.identified_content_coverage.candidates_by_kind[&ContentKind::Formula],
        2
    );
    assert_eq!(coverage.identified_content_coverage.teaching, "not_started");
    assert_eq!(coverage.recognition_completeness.status, "not_checked");
    assert_eq!(coverage.recognition_completeness.expected_items, None);
    assert_eq!(coverage.review_status, "not_reviewed");
}

#[test]
fn wrong_page_or_model_authored_review_status_cannot_be_promoted() {
    assert!(parse_page_perception(&output(1), 0).is_err());
    let forged = r#"{"pageIndex":0,"items":[],"warnings":["blank"],"reviewStatus":"pass"}"#;
    assert!(parse_page_perception(forged, 0).is_err());
    assert!(parse_page_perception(r#"{"pageIndex":0,"items":[],"warnings":[]}"#, 0).is_err());
    let mut run = run(1);
    attach(&mut run, 0);
    run.start().unwrap();
    run.begin_page(0, "a".into()).unwrap();
    run.finish_page(0, "a", Ok(&output(4))).unwrap();
    run.finish();
    assert_eq!(run.status, PaperReadingStatus::Partial);
    assert_eq!(run.coverage().page_processing_coverage.completed, 0);
}

#[test]
fn original_evidence_is_required_and_bound_to_document_version() {
    let mut run = run(1);
    assert!(page_perception_prompt(&run, 0).is_err());
    assert!(run.start().is_err());
    attach(&mut run, 0);
    assert!(page_perception_prompt(&run, 0)
        .unwrap()
        .contains("Original text"));
    run.pages[0].source.as_mut().unwrap().document_revision = content_sha256(b"different PDF");
    assert!(page_perception_prompt(&run, 0).is_err());
}

#[test]
fn old_protocol_results_remain_stored_but_cannot_mask_or_resume_current_tasks() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let current = run(1);
    let mut old = current.clone();
    old.id = content_sha256(b"older task protocol");
    old.protocol_version = "paper-perception-v1".into();
    attach(&mut old, 0);
    store.save_paper_reading_run(&current).unwrap();
    store.save_paper_reading_run(&old).unwrap();
    assert!(old.start().is_err());
    assert!(store.paper_reading_run(&old.id).unwrap().is_some());
    assert_eq!(
        store
            .latest_paper_reading_run(&current.paper_id, &current.document_revision)
            .unwrap()
            .unwrap()
            .id,
        current.id,
    );
    // With no current task, an older guide stays readable instead of
    // disappearing after an upgrade, but it cannot be resumed.
    let legacy_only = open_literature_store_at(&temp.path().join("legacy-only")).unwrap();
    legacy_only.save_paper_reading_run(&old).unwrap();
    let readable = legacy_only
        .latest_paper_reading_run(&old.paper_id, &old.document_revision)
        .unwrap()
        .unwrap();
    assert_eq!(readable.id, old.id);
    assert!(!readable.resumable());
    let mut old_policy = current.clone();
    old_policy.policy_version = "paper-source-only-v1".into();
    assert!(!old_policy.resumable());
    let mut old_guide = current.clone();
    old_guide.guide = Some(crate::paper_guide::PaperGuide {
        protocol_version: "paper-guide-v1".into(),
        ..crate::paper_guide::PaperGuide::default()
    });
    assert!(!old_guide.resumable());
    assert!(current.resumable());
}

#[test]
fn pages_with_a_text_layer_are_read_directly_and_transcription_is_optional() {
    let mut run = run(3);
    let text_layer = "A full paragraph of original text from the PDF text layer. ".repeat(10);
    for page_index in 0..3 {
        run.attach_source(OriginalPageEvidence {
            document_revision: run.document_revision.clone(),
            page_index,
            image_sha256: content_sha256(b"original page image"),
            image_file: format!("page-{page_index}.jpg"),
            mime_type: "image/jpeg".into(),
            embedded_text: if page_index == 1 { String::new() } else { text_layer.clone() },
            text_truncated: false,
        })
        .unwrap();
    }
    assert_eq!(run.pages[0].status, PageStatus::NotRequired);
    assert_eq!(run.pages[1].status, PageStatus::Pending, "a scanned page needs transcription");
    run.start().unwrap();
    assert_eq!(run.next_page(), Some(1));
    run.begin_page(1, "scan".into()).unwrap();
    assert!(run.pages[1].attempts[0].text_sha256.is_none());
    run.finish_page(1, "scan", Ok(&output(1))).unwrap();
    assert_eq!(run.next_page(), None);
    run.finish();
    assert_eq!(run.status, PaperReadingStatus::PageProcessingComplete);
    let coverage = run.coverage();
    assert_eq!(coverage.page_processing_coverage.not_required, 2);
    assert_eq!(coverage.page_processing_coverage.completed, 1);
    assert_eq!(coverage.identified_content_coverage.inventory_version, 1);

    assert_eq!(run.request_transcription().unwrap(), 2);
    run.start().unwrap();
    assert!(run.request_transcription().is_err(), "scope is fixed while running");
    run.begin_page(0, "full".into()).unwrap();
    assert_eq!(
        run.pages[0].attempts[0].text_sha256.as_deref(),
        Some(content_sha256(text_layer.as_bytes()).as_str())
    );
}

#[test]
fn versions_can_be_listed_and_deleted_with_their_reader_questions() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let first = store.save_paper_reading_run(&run(1)).unwrap();
    let mut second = run(1);
    second.id = content_sha256(b"regenerated version");
    let second = store.save_paper_reading_run(&second).unwrap();
    let mut other = run(1);
    other.id = content_sha256(b"another paper");
    other.paper_id = "paper-2".into();
    store.save_paper_reading_run(&other).unwrap();
    let listed = store.paper_reading_runs_for_paper("paper-1").unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|item| item.id == first.id));
    let question = crate::paper_guide::PaperFollowUp {
        id: "question-1".into(),
        run_id: second.id.clone(),
        target: "lesson:0".into(),
        focus: Some("Step 2".into()),
        mode: crate::paper_guide::FollowUpMode::Simpler,
        question: "Explain again".into(),
        answer: "A simpler answer.".into(),
        model: "vision-model".into(),
        session_id: "paper-ask".into(),
        created_at: crate::now_iso8601(),
        evidence: vec![],
    };
    store.save_paper_follow_up(&question).unwrap();
    assert_eq!(store.paper_follow_ups(&second.id).unwrap()[0].answer, "A simpler answer.");
    let deleted = store.delete_paper_reading_run(&second.id).unwrap().unwrap();
    assert_eq!(deleted.id, second.id);
    assert!(store.paper_reading_run(&second.id).unwrap().is_none());
    assert!(store.paper_follow_ups(&second.id).unwrap().is_empty());
    assert!(store.delete_paper_reading_run(&second.id).unwrap().is_none());
    assert_eq!(store.paper_reading_runs_for_paper("paper-1").unwrap().len(), 1);
}

#[test]
fn cancellation_rejects_in_flight_result_and_stale_database_write() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let mut run = run(1);
    attach(&mut run, 0);
    run.start().unwrap();
    run.begin_page(0, "attempt".into()).unwrap();
    let mut old = store.save_paper_reading_run(&run).unwrap();
    let mut cancelled = old.clone();
    cancelled.cancel();
    let cancelled = store.save_paper_reading_run(&cancelled).unwrap();
    old.finish_page(0, "attempt", Ok(&output(0))).unwrap();
    assert!(store.save_paper_reading_run(&old).is_err());
    let loaded = store.paper_reading_run(&cancelled.id).unwrap().unwrap();
    assert_eq!(loaded.status, PaperReadingStatus::Cancelled);
    assert!(loaded.pages[0].result.is_none());
    let mut loaded = loaded;
    assert!(loaded.finish_page(0, "attempt", Ok(&output(0))).is_err());
}

#[test]
fn resume_reuses_successful_pages_and_preserves_attempt_history() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let mut run = run(2);
    attach(&mut run, 0);
    attach(&mut run, 1);
    run.start().unwrap();
    run.begin_page(0, "first".into()).unwrap();
    run.finish_page(0, "first", Ok(&output(0))).unwrap();
    run.begin_page(1, "second".into()).unwrap();
    run.finish_page(1, "second", Err("provider failed"))
        .unwrap();
    run.finish();
    let run = store.save_paper_reading_run(&run).unwrap();
    drop(store);
    let reopened = open_literature_store_at(temp.path()).unwrap();
    let mut loaded = reopened.paper_reading_run(&run.id).unwrap().unwrap();
    loaded.start().unwrap();
    assert_eq!(loaded.next_page(), Some(1));
    assert_eq!(loaded.pages[0].attempts.len(), 1);
    assert_eq!(
        loaded.pages[1].attempts[0].error.as_deref(),
        Some("provider failed")
    );
}

#[test]
fn retries_are_bounded_and_empty_inventory_is_not_complete_knowledge() {
    let mut run = run(1);
    attach(&mut run, 0);
    for attempt in 0..MAX_PAGE_ATTEMPTS {
        run.start().unwrap();
        let session = format!("attempt-{attempt}");
        run.begin_page(0, session.clone()).unwrap();
        run.finish_page(0, &session, Err("unreadable response"))
            .unwrap();
        run.finish();
    }
    run.start().unwrap();
    assert_eq!(run.next_page(), None);
    run.finish();
    assert_eq!(run.status, PaperReadingStatus::Partial);
    assert_eq!(
        run.coverage().recognition_completeness.status,
        "not_checked"
    );
    assert_eq!(
        run.coverage().identified_content_coverage.understanding,
        "not_started"
    );
}

#[test]
fn duplicate_creation_and_document_replacement_do_not_reuse_wrong_results() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let run = run(1);
    store.save_paper_reading_run(&run).unwrap();
    assert!(store.save_paper_reading_run(&run).is_err());
    assert!(store
        .latest_paper_reading_run(&run.paper_id, &content_sha256(b"replacement"))
        .unwrap()
        .is_none());
}

#[test]
fn host_failures_close_attempts_and_survive_reload() {
    let temp = tempfile::tempdir().unwrap();
    let store = open_literature_store_at(temp.path()).unwrap();
    let mut run = run(1);
    attach(&mut run, 0);
    run.start().unwrap();
    run.begin_page(0, "attempt".into()).unwrap();
    run.fail("source unavailable");
    let saved = store.save_paper_reading_run(&run).unwrap();
    let loaded = store.paper_reading_run(&saved.id).unwrap().unwrap();
    assert_eq!(loaded.status, PaperReadingStatus::Partial);
    assert_eq!(loaded.last_error.as_deref(), Some("source unavailable"));
    assert_eq!(loaded.pages[0].attempts[0].status, "failed");
    assert!(loaded.pages[0].attempts[0].finished_at.is_some());
}

#[test]
fn a_changed_model_connection_gets_a_different_task_identity() {
    let first = run(1);
    let second = PaperReadingRun::new(
        first.paper_id.clone(),
        first.title.clone(),
        first.relative_path.clone(),
        first.document_revision.clone(),
        1,
        first.model.clone(),
        content_sha256(b"another connection"),
        first.language.clone(),
    )
    .unwrap();
    assert_ne!(first.id, second.id);
}

#[test]
fn in_flight_work_is_serial_and_cancel_does_not_erase_completion() {
    let mut run = run(2);
    attach(&mut run, 0);
    attach(&mut run, 1);
    run.start().unwrap();
    run.begin_page(0, "first".into()).unwrap();
    assert!(run.begin_page(1, "second".into()).is_err());
    run.finish_page(0, "first", Ok(&output(0))).unwrap();
    run.begin_page(1, "second".into()).unwrap();
    run.finish_page(1, "second", Ok(&output(1))).unwrap();
    run.finish();
    run.cancel();
    assert_eq!(run.status, PaperReadingStatus::PageProcessingComplete);
}

#[test]
fn automatic_page_retry_recovers_without_reprocessing_completed_pages() {
    let mut run = run(2);
    attach(&mut run, 0);
    attach(&mut run, 1);
    run.start().unwrap();
    run.begin_page(0, "good".into()).unwrap();
    run.finish_page(0, "good", Ok(&output(0))).unwrap();
    run.begin_page(1, "bad".into()).unwrap();
    run.finish_page(1, "bad", Ok("invalid JSON")).unwrap();
    run.retry_invalid_page_output(1, false);
    assert_eq!(run.next_page(), None);
    run.retry_invalid_page_output(1, true);
    assert_eq!(run.next_page(), Some(1));
    assert!(run.pages[1].error.is_some());
    run.begin_page(1, "retry".into()).unwrap();
    run.finish_page(1, "retry", Ok(&output(1))).unwrap();
    run.retry_invalid_page_output(1, true);
    assert_eq!(run.next_page(), None);
    assert_eq!(run.pages[0].attempts.len(), 1);
    assert_eq!(run.pages[1].attempts.len(), 2);
}

#[test]
fn automatic_page_retry_is_bounded_and_respects_cancellation() {
    let mut run = run(1);
    attach(&mut run, 0);
    run.start().unwrap();
    for index in 0..MAX_PAGE_ATTEMPTS {
        let id = format!("bad-{index}");
        run.begin_page(0, id.clone()).unwrap();
        run.finish_page(0, &id, Ok("bad JSON")).unwrap();
        run.retry_invalid_page_output(0, true);
    }
    assert_eq!(run.next_page(), None);
    assert_eq!(run.pages[0].status, PageStatus::Failed);
    run.cancel();
    run.retry_invalid_page_output(0, true);
    assert_eq!(run.status, PaperReadingStatus::Cancelled);
}

#[test]
fn manual_retry_reopens_only_unfinished_pages_with_a_durable_budget() {
    let mut run = run(2);
    attach(&mut run, 0);
    attach(&mut run, 1);
    run.start().unwrap();
    run.begin_page(0, "done".into()).unwrap();
    run.finish_page(0, "done", Ok(&output(0))).unwrap();
    for index in 0..3 {
        let id = format!("failed-{index}");
        run.begin_page(1, id.clone()).unwrap();
        run.finish_page(1, &id, Ok("bad JSON")).unwrap();
        run.retry_invalid_page_output(1, true);
    }
    assert!(run.reopen_exhausted_attempts().is_err());
    run.finish();
    run.reopen_exhausted_attempts().unwrap();
    let mut restored: PaperReadingRun =
        serde_json::from_str(&serde_json::to_string(&run).unwrap()).unwrap();
    restored.start().unwrap();
    assert_eq!(restored.next_page(), Some(1));
    assert_eq!(restored.pages[1].attempt_limit, 6);
    assert_eq!(restored.pages[1].attempts.len(), 3);
    assert_eq!(restored.pages[0].attempts.len(), 1);
    restored.begin_page(1, "recovered".into()).unwrap();
    restored
        .finish_page(1, "recovered", Ok(&output(1)))
        .unwrap();
    restored.finish();
    assert_eq!(restored.status, PaperReadingStatus::PageProcessingComplete);
}

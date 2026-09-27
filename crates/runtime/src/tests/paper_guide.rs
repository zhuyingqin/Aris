use super::*;
use crate::paper_reading::{
    content_sha256, OriginalPageEvidence, PaperReadingRun, PaperReadingStatus,
};

fn evidence() -> Vec<GuideEvidence> {
    vec![GuideEvidence {
        page: 1,
        image_sha256: Some(content_sha256(b"original image")),
        text_sha256: None,
        text_truncated: false,
    }]
}

fn outline() -> GuideOutline {
    parse_outline(&serde_json::json!({
        "overview": [
            {"kind":"problem","content":"An original problem","sourcePages":[1]},
            {"kind":"method","content":"An original method","sourcePages":[1]},
            {"kind":"evidence","content":"An original experiment","sourcePages":[1]}
        ],
        "topics":[{"kind":"formula","title":"Why scale?","learningGoal":"Understand the assumption","sourcePages":[1]}],
        "cautions":[]
    }).to_string(), 2, &[1]).unwrap()
}

fn lesson() -> GuideLesson {
    parse_lesson(&serde_json::json!({
        "intuition":"Keep the score scale stable under the stated assumptions.",
        "notation":"d is the dimension.","assumptions":"Independent components with unit variance.",
        "steps":[{"title":"Reason","explanation":"The variances add under the assumptions.","origin":"teaching"}],
        "example":"An illustrative example, not a paper experiment.","evidence":"The footnote states the assumptions.",
        "checkQuestion":"What assumption is required?","checkAnswer":"Independence and unit variance.",
        "sourcePages":[1],"cautions":[]
    }).to_string(), &[1]).unwrap()
}

#[test]
fn new_lessons_require_a_worked_example_but_saved_lessons_remain_readable() {
    let mut raw = serde_json::to_value(lesson()).unwrap();
    for example in [
        serde_json::Value::Null,
        serde_json::json!("   "),
        serde_json::json!("x".repeat(8001)),
    ] {
        raw["example"] = example;
        assert!(parse_lesson(&raw.to_string(), &[1])
            .unwrap_err()
            .starts_with("example:"));
    }
    raw.as_object_mut().unwrap().remove("example");
    assert!(parse_lesson(&raw.to_string(), &[1]).is_err());
    assert!(serde_json::from_value::<GuideLesson>(raw.clone()).is_ok());
    raw["example"] = serde_json::json!("### Givens and question\nTeaching values: score 6, dimension 4. Find the scaled score.\n### Step-by-step solution\nSquare root of 4 is 2. Divide 6 by 2.\n### Answer\n3.\n### Connection to the paper\nThis illustrates the scaling operation, not a claim about accuracy or a distribution of scores.");
    assert!(parse_lesson(&raw.to_string(), &[1]).is_ok());
}

#[test]
fn outlines_and_lessons_cannot_invent_sources_or_review_verdicts() {
    let mut raw = serde_json::to_value(outline()).unwrap();
    raw["overview"][0]["sourcePages"] = serde_json::json!([2]);
    assert!(parse_outline(&raw.to_string(), 2, &[1]).is_err());
    let mut raw = serde_json::to_value(lesson()).unwrap();
    raw["sourcePages"] = serde_json::json!([2]);
    assert!(parse_lesson(&raw.to_string(), &[1]).is_err());
    raw["sourcePages"] = serde_json::json!([1]);
    raw["reviewStatus"] = "pass".into();
    assert!(parse_lesson(&raw.to_string(), &[1]).is_err());
}

#[test]
fn cancelled_attempt_cannot_commit_and_resume_keeps_completed_work() {
    let mut guide = PaperGuide::default();
    guide.outline.begin("outline".into(), evidence()).unwrap();
    guide.finish_outline("outline", Ok(outline())).unwrap();
    guide.lessons[0]
        .task
        .begin("cancelled".into(), evidence())
        .unwrap();
    guide.cancel();
    assert!(guide.lessons[0]
        .task
        .finish("cancelled", Ok(lesson()))
        .is_err());
    guide.resume().unwrap();
    assert_eq!(guide.outline.status, GuideTaskStatus::Completed);
    assert_eq!(guide.outline.attempts.len(), 1);
    guide.lessons[0]
        .task
        .begin("retry".into(), evidence())
        .unwrap();
    guide.lessons[0].task.finish("retry", Ok(lesson())).unwrap();
    assert!(guide.complete());
    guide.resume().unwrap();
    assert_eq!(guide.lessons[0].task.status, GuideTaskStatus::Completed);
    assert_eq!(guide.lessons[0].task.attempts[0].status, "cancelled");
}

#[test]
fn teaching_needs_images_and_retries_are_bounded() {
    let mut task = GuideTask::<GuideLesson>::default();
    assert!(task
        .begin(
            "text-only".into(),
            vec![GuideEvidence {
                page: 1,
                image_sha256: None,
                text_sha256: Some(content_sha256(b"text")),
                text_truncated: false
            }]
        )
        .is_err());
    for index in 0..MAX_GUIDE_ATTEMPTS {
        let id = index.to_string();
        task.begin(id.clone(), evidence()).unwrap();
        task.finish(&id, Err("Model unavailable".into())).unwrap();
        task.resume();
    }
    assert_eq!(task.status, GuideTaskStatus::Failed);
    assert!(task.begin("again".into(), evidence()).is_err());
}

#[test]
fn a_finished_guide_is_still_an_unreviewed_draft_with_unknown_recognition_completeness() {
    let mut run = PaperReadingRun::new(
        "paper".into(),
        "Paper".into(),
        "paper.pdf".into(),
        content_sha256(b"PDF"),
        1,
        "vision".into(),
        content_sha256(b"connection"),
        "zh".into(),
    )
    .unwrap();
    run.attach_source(OriginalPageEvidence {
        document_revision: run.document_revision.clone(),
        page_index: 0,
        image_sha256: content_sha256(b"image"),
        image_file: "page-0.jpg".into(),
        mime_type: "image/jpeg".into(),
        embedded_text: "Source".into(),
        text_truncated: false,
    })
    .unwrap();
    run.guide = Some(PaperGuide::default());
    run.start().unwrap();
    run.begin_page(0, "page".into()).unwrap();
    run.finish_page(0, "page", Ok(r#"{"pageIndex":0,"items":[{"kind":"text","content":"Source","uncertainties":[]}],"warnings":[]}"#)).unwrap();
    run.finish();
    assert_eq!(run.status, PaperReadingStatus::Partial);
    let guide = run.guide.as_mut().unwrap();
    guide.outline.begin("outline".into(), evidence()).unwrap();
    guide.finish_outline("outline", Ok(outline())).unwrap();
    guide.lessons[0]
        .task
        .begin("lesson".into(), evidence())
        .unwrap();
    guide.lessons[0]
        .task
        .finish("lesson", Ok(lesson()))
        .unwrap();
    run.finish();
    assert_eq!(run.status, PaperReadingStatus::GuideReady);
    assert_eq!(
        run.coverage().identified_content_coverage.teaching,
        "drafts_ready"
    );
    assert_eq!(run.coverage().review_status, "not_reviewed");
    assert_eq!(
        run.coverage().recognition_completeness.status,
        "not_checked"
    );
}

#[test]
fn guide_state_survives_restart_and_old_perception_records_still_load() {
    let mut run = PaperReadingRun::new(
        "paper".into(),
        "Paper".into(),
        "paper.pdf".into(),
        content_sha256(b"PDF"),
        1,
        "vision".into(),
        content_sha256(b"connection"),
        "zh".into(),
    )
    .unwrap();
    let mut legacy = serde_json::to_value(&run).unwrap();
    legacy.as_object_mut().unwrap().remove("guide");
    assert!(serde_json::from_value::<PaperReadingRun>(legacy)
        .unwrap()
        .guide
        .is_none());
    let temp = tempfile::tempdir().unwrap();
    let store = crate::literature::open_literature_store_at(temp.path()).unwrap();
    run.guide = Some(PaperGuide::default());
    let guide = run.guide.as_mut().unwrap();
    guide.outline.begin("outline".into(), evidence()).unwrap();
    guide.finish_outline("outline", Ok(outline())).unwrap();
    guide.lessons[0]
        .task
        .begin("interrupted".into(), evidence())
        .unwrap();
    store.save_paper_reading_run(&run).unwrap();
    drop(store);
    let store = crate::literature::open_literature_store_at(temp.path()).unwrap();
    let mut restored = store.paper_reading_run(&run.id).unwrap().unwrap();
    let guide = restored.guide.as_mut().unwrap();
    guide.resume().unwrap();
    assert_eq!(guide.outline.status, GuideTaskStatus::Completed);
    assert_eq!(guide.lessons[0].task.attempts[0].status, "interrupted");
    assert_eq!(guide.lessons[0].task.status, GuideTaskStatus::Pending);
}

#[test]
fn overview_accepts_nine_supplied_pages_but_not_missing_evidence() {
    let mut value = outline();
    value.overview[2].source_pages = vec![9, 10, 11, 13, 16, 20, 21, 22, 23];
    let text = serde_json::to_string(&value).unwrap();
    assert!(parse_outline(&text, 32, &(1..=32).collect::<Vec<_>>()).is_ok());
    assert!(parse_outline(&text, 32, &(1..=22).collect::<Vec<_>>()).is_err());
}

#[test]
fn automatic_output_retry_preserves_attempts_and_stops_at_budget() {
    let mut task = GuideTask::<GuideLesson>::default();
    for index in 0..MAX_GUIDE_ATTEMPTS {
        let id = format!("attempt-{index}");
        task.begin(id.clone(), evidence()).unwrap();
        task.finish(&id, Err("Invalid JSON".into())).unwrap();
        task.retry_invalid_output(false);
        assert_eq!(task.status, GuideTaskStatus::Failed);
        task.retry_invalid_output(true);
        assert_eq!(task.attempts.len(), index + 1);
        assert_eq!(task.error.as_deref(), Some("Invalid JSON"));
    }
    assert_eq!(task.status, GuideTaskStatus::Failed);
    assert!(task.begin("exhausted".into(), evidence()).is_err());
}

#[test]
fn outline_retry_can_recover_and_create_teaching_tasks() {
    let mut guide = PaperGuide::default();
    guide.outline.begin("bad".into(), evidence()).unwrap();
    guide
        .finish_outline("bad", parse_outline("invalid JSON", 2, &[1]))
        .unwrap();
    guide.outline.retry_invalid_output(true);
    assert!(guide.lessons.is_empty());
    guide.outline.begin("retry".into(), evidence()).unwrap();
    guide.finish_outline("retry", Ok(outline())).unwrap();
    guide.outline.retry_invalid_output(true);
    assert_eq!(guide.outline.status, GuideTaskStatus::Completed);
    assert_eq!(guide.outline.attempts.len(), 2);
    assert_eq!(guide.lessons.len(), 1);
    assert_eq!(guide.lessons[0].task.status, GuideTaskStatus::Pending);
}

#[test]
fn cited_cautions_preserve_text_and_validate_original_sources() {
    let mut value = serde_json::to_value(outline()).unwrap();
    value["cautions"] = serde_json::json!(["A plain caution", {"content":"Dataset windows differ.", "sourcePages":[1,2]}]);
    let parsed = parse_outline(&value.to_string(), 32, &[1, 2]).unwrap();
    assert_eq!(parsed.cautions[0], "A plain caution");
    assert_eq!(parsed.cautions[1], "Dataset windows differ.\n\n(PDF: 1, 2)");
    assert!(parse_outline(&value.to_string(), 32, &[1])
        .unwrap_err()
        .contains("cautions[1]"));
    value["cautions"][1]["reviewed"] = serde_json::json!(true);
    assert!(parse_outline(&value.to_string(), 32, &[1, 2]).is_err());
    value["cautions"] = serde_json::json!([{"content": "A", "sourcePages":[1,1]}]);
    assert!(parse_outline(&value.to_string(), 32, &[1, 2]).is_err());
}

#[test]
fn teaching_cautions_accept_the_same_evidence_bound_shape() {
    let mut value = serde_json::to_value(lesson()).unwrap();
    value["cautions"] = serde_json::json!([{"content":"This is an assumption.","sourcePages":[1]}]);
    assert!(parse_lesson(&value.to_string(), &[1]).unwrap().cautions[0].contains("PDF: 1"));
    value["notation"] = serde_json::json!({"invented":"not an accepted shape"});
    assert!(parse_lesson(&value.to_string(), &[1]).is_err());
}

#[test]
fn explicit_retry_grants_one_bounded_batch_without_erasing_history() {
    let mut task = GuideTask::<GuideLesson>::default();
    for index in 0..3 {
        let id = format!("old-{index}");
        task.begin(id.clone(), evidence()).unwrap();
        task.finish(&id, Err("bad JSON".into())).unwrap();
        task.retry_invalid_output(true);
    }
    let mut saved = serde_json::to_value(&task).unwrap();
    saved.as_object_mut().unwrap().remove("attemptLimit");
    let mut restored: GuideTask<GuideLesson> = serde_json::from_value(saved).unwrap();
    restored.resume();
    assert_eq!(restored.status, GuideTaskStatus::Failed);
    restored.reopen_exhausted_attempts();
    restored.resume();
    assert_eq!(restored.attempt_limit, 6);
    assert_eq!(restored.attempts.len(), 3);
    for index in 3..6 {
        let id = format!("new-{index}");
        restored.begin(id.clone(), evidence()).unwrap();
        restored.finish(&id, Err("bad JSON".into())).unwrap();
        restored.retry_invalid_output(true);
    }
    assert_eq!(restored.status, GuideTaskStatus::Failed);
    assert_eq!(restored.attempts.len(), 6);
    assert!(restored
        .attempts
        .iter()
        .all(|attempt| attempt.error.is_some()));
}

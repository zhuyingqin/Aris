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
        derived_text_sha256: None,
    }]
}

fn outline() -> GuideOutline {
    parse_outline(&outline_json().to_string(), 2, &[1], false).unwrap()
}

fn outline_json() -> serde_json::Value {
    serde_json::json!({
        "oneSentence": "The paper compares scores more fairly by rescaling them.",
        "overview": [
            {"kind":"problem","content":"An original problem","sourcePages":[1]},
            {"kind":"method","content":"An original method","sourcePages":[1]},
            {"kind":"evidence","content":"An original experiment","sourcePages":[1]}
        ],
        "glossary": [{"term":"Dot product","plain":"Multiply matching numbers and add them up.","sourcePages":[1]}],
        "topics":[{"kind":"formula","level":"core","title":"Why scale?","learningGoal":"Understand the assumption","prerequisites":["Dot product"],"sourcePages":[1]}],
        "cautions":[],
        "relevance": ""
    })
}

fn lesson() -> GuideLesson {
    parse_lesson(&lesson_json().to_string(), &[1]).unwrap()
}

fn lesson_json() -> serde_json::Value {
    serde_json::json!({
        "plainSummary":"Large sums of many small numbers grow, so the paper shrinks them back to a comparable size.",
        "analogy":"Like averaging votes instead of counting them. Where the analogy breaks: the paper divides by a square root, not by the count.",
        "prerequisites":[{"concept":"Variance","explanation":"How spread out values are; for 1, 3 it is 1."}],
        "misconceptions":[{"misconception":"Scaling guarantees stable training.","correction":"It keeps the variance at one only under the stated independence assumptions."}],
        "intuition":"Keep the score scale stable under the stated assumptions.",
        "notation":"d is the dimension.","assumptions":"Independent components with unit variance.",
        "steps":[{"title":"Reason","explanation":"The variances add under the assumptions.","origin":"teaching"}],
        "example":"An illustrative example, not a paper experiment.","evidence":"The footnote states the assumptions.",
        "checkQuestion":"What assumption is required?","checkAnswer":"Independence and unit variance.",
        "sourcePages":[1],"cautions":[]
    })
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
    assert!(parse_outline(&raw.to_string(), 2, &[1], false).is_err());
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
                text_truncated: false,
                derived_text_sha256: None,
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
    assert!(parse_outline(&text, 32, &(1..=32).collect::<Vec<_>>(), false).is_ok());
    assert!(parse_outline(&text, 32, &(1..=22).collect::<Vec<_>>(), false).is_err());
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
        .finish_outline("bad", parse_outline("invalid JSON", 2, &[1], false))
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
    let parsed = parse_outline(&value.to_string(), 32, &[1, 2], false).unwrap();
    assert_eq!(parsed.cautions[0], "A plain caution");
    assert_eq!(parsed.cautions[1], "Dataset windows differ.\n\n(PDF: 1, 2)");
    assert!(parse_outline(&value.to_string(), 32, &[1], false)
        .unwrap_err()
        .contains("cautions[1]"));
    value["cautions"][1]["reviewed"] = serde_json::json!(true);
    assert!(parse_outline(&value.to_string(), 32, &[1, 2], false).is_err());
    value["cautions"] = serde_json::json!([{"content": "A", "sourcePages":[1,1]}]);
    assert!(parse_outline(&value.to_string(), 32, &[1, 2], false).is_err());
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

fn review(round: usize, verdict: ReviewVerdict) -> LessonReview {
    LessonReview {
        round,
        verdict,
        summary: "Checked against the original text.".into(),
        issues: if verdict == ReviewVerdict::NeedsRevision {
            vec![ReviewIssue {
                severity: IssueSeverity::Major,
                location: "misconceptions".into(),
                problem: "Calls the layer permutation invariant.".into(),
                suggestion: "Say permutation equivariant.".into(),
            }]
        } else {
            vec![]
        },
        reviewer: Some("openai / reviewer-model".into()),
        session_id: format!("review-{round}"),
        reviewed_at: crate::now_iso8601(),
        evidence: evidence(),
    }
}

fn generated_guide() -> PaperGuide {
    let mut guide = PaperGuide::reviewed();
    guide.outline.begin("outline".into(), evidence()).unwrap();
    guide.finish_outline("outline", Ok(outline())).unwrap();
    guide.lessons[0].task.begin("lesson".into(), evidence()).unwrap();
    guide.lessons[0].task.finish("lesson", Ok(lesson())).unwrap();
    guide
}

#[test]
fn lessons_are_layered_from_a_plain_summary_to_details() {
    let parsed = lesson();
    assert!(parsed.plain_summary.starts_with("Large sums"));
    assert!(parsed.analogy.contains("Where the analogy breaks"));
    assert_eq!(parsed.prerequisites[0].concept, "Variance");
    assert_eq!(parsed.misconceptions.len(), 1);
    let mut raw = lesson_json();
    raw["plainSummary"] = serde_json::json!("  ");
    assert!(parse_lesson(&raw.to_string(), &[1])
        .unwrap_err()
        .starts_with("plainSummary"));
    raw["plainSummary"] = serde_json::json!("A plain summary.");
    raw["analogy"] = serde_json::json!("");
    raw["prerequisites"] = serde_json::json!([]);
    raw["misconceptions"] = serde_json::json!([]);
    assert!(parse_lesson(&raw.to_string(), &[1]).is_ok(), "no forced analogy");
    raw["misconceptions"] = serde_json::json!(["not an object"]);
    assert!(parse_lesson(&raw.to_string(), &[1]).is_err());
    // A v1 lesson saved before the layered protocol still loads for reading.
    let mut legacy = serde_json::to_value(lesson()).unwrap();
    for field in ["plainSummary", "analogy", "prerequisites", "misconceptions"] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    assert!(serde_json::from_value::<GuideLesson>(legacy).is_ok());
}

#[test]
fn outline_is_a_reading_path_from_foundations_to_depth() {
    let mut raw = outline_json();
    raw["topics"] = serde_json::json!([
        {"kind":"experiment","level":"advanced","title":"Read Table 2","learningGoal":"Compare BLEU","sourcePages":[2]},
        {"kind":"formula","level":"core","title":"Why scale?","learningGoal":"Scaling","sourcePages":[1]},
        {"kind":"concept","level":"foundation","title":"What is attention?","learningGoal":"Weights","sourcePages":[1]},
        {"kind":"figure","level":"core","title":"The architecture","learningGoal":"Flow","sourcePages":[1]}
    ]);
    raw["relevance"] = serde_json::json!("Useful for the reader's retrieval project.");
    let parsed = parse_outline(&raw.to_string(), 2, &[1], true).unwrap();
    let titles = parsed.topics.iter().map(|topic| topic.title.as_str()).collect::<Vec<_>>();
    assert_eq!(
        titles,
        ["What is attention?", "Why scale?", "The architecture", "Read Table 2"]
    );
    assert!(!parsed.relevance.is_empty());
    // Without a supplied goal, any stated connection would be invented.
    assert!(parse_outline(&raw.to_string(), 2, &[1], false)
        .unwrap()
        .relevance
        .is_empty());
    raw["oneSentence"] = serde_json::json!("");
    assert!(parse_outline(&raw.to_string(), 2, &[1], true)
        .unwrap_err()
        .starts_with("oneSentence"));
    raw["oneSentence"] = serde_json::json!("One sentence.");
    raw["glossary"][0]["sourcePages"] = serde_json::json!([2]);
    assert!(parse_outline(&raw.to_string(), 2, &[1], true)
        .unwrap_err()
        .starts_with("glossary"));
}

#[test]
fn independent_review_gates_completion_and_triggers_one_revision() {
    let mut guide = generated_guide();
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Review { round: 0 });
    assert!(!guide.complete(), "an unreviewed draft is not a finished guide");
    assert_eq!(guide.review_status(), "not_reviewed");

    guide.lessons[0].record_review(review(0, ReviewVerdict::NeedsRevision));
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Revise);
    let revision = guide.lessons[0].revision_task();
    assert_eq!(revision.attempt_limit, MAX_REVISION_ATTEMPTS);
    revision.begin("revision".into(), evidence()).unwrap();
    let mut revised = lesson();
    revised.plain_summary = "Revised plain summary.".into();
    guide.lessons[0].revision_task().finish("revision", Ok(revised)).unwrap();
    assert_eq!(guide.lessons[0].current().unwrap().plain_summary, "Revised plain summary.");
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Review { round: 1 });
    assert_eq!(
        guide.lessons[0].final_review().map(|review| review.round),
        None,
        "the first review does not certify the revision"
    );

    guide.lessons[0].record_review(review(1, ReviewVerdict::Pass));
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Done);
    assert!(guide.complete());
    assert_eq!(guide.review_status(), "all_passed");
    assert_eq!(guide.review_counts().passed, 1);
    assert!(guide.session_ids().contains(&"review-1".to_string()));
}

#[test]
fn a_failed_revision_keeps_the_first_draft_and_its_findings_visible() {
    let mut guide = generated_guide();
    guide.lessons[0].record_review(review(0, ReviewVerdict::NeedsRevision));
    for index in 0..MAX_REVISION_ATTEMPTS {
        let id = format!("revision-{index}");
        let task = guide.lessons[0].revision_task();
        task.begin(id.clone(), evidence()).unwrap();
        task.finish(&id, Err("Invalid explanation JSON".into())).unwrap();
        task.retry_invalid_output(true);
    }
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Done);
    assert!(guide.complete());
    assert_eq!(guide.lessons[0].current().unwrap().plain_summary, lesson().plain_summary);
    assert_eq!(
        guide.lessons[0].final_review().unwrap().verdict,
        ReviewVerdict::NeedsRevision
    );
    assert_eq!(guide.review_status(), "reviewed_with_findings");
}

#[test]
fn an_unavailable_reviewer_leaves_lessons_unreviewed_until_an_explicit_continue() {
    let mut guide = generated_guide();
    guide.lessons[0].record_review(review(0, ReviewVerdict::Unavailable));
    assert!(guide.complete(), "a missing Reviewer does not block reading");
    assert_eq!(guide.review_status(), "not_reviewed");
    assert_eq!(guide.review_counts().unavailable, 1);
    guide.reopen_for_continuation();
    assert_eq!(guide.lessons[0].stage(true), LessonStage::Review { round: 0 });
    // Legacy guides were never meant to be reviewed.
    let mut legacy = generated_guide();
    legacy.review_required = false;
    assert!(legacy.complete());
    assert_eq!(legacy.review_state(), "not_requested");
}

#[test]
fn reviewer_output_is_strict_and_cannot_pass_blocking_issues() {
    let (verdict, _, issues) = parse_review(
        r#"{"verdict":"pass","summary":"Mostly right.","issues":[{"severity":"critical","location":"step 2","problem":"Wrong term.","suggestion":"Fix it."}]}"#,
    )
    .unwrap();
    assert_eq!(verdict, ReviewVerdict::NeedsRevision);
    assert_eq!(issues.len(), 1);
    let (verdict, _, _) = parse_review(
        "```json\n{\"verdict\":\"pass\",\"summary\":\"Faithful.\",\"issues\":[{\"severity\":\"minor\",\"location\":\"analogy\",\"problem\":\"Could be shorter.\",\"suggestion\":\"\"}]}\n```",
    )
    .unwrap();
    assert_eq!(verdict, ReviewVerdict::Pass);
    assert!(parse_review(r#"{"verdict":"unavailable","summary":"x","issues":[]}"#).is_err());
    assert!(parse_review(r#"{"verdict":"needs_revision","summary":"x","issues":[]}"#).is_err());
    assert!(parse_review(r#"{"verdict":"pass","summary":"x","issues":[],"approved":true}"#).is_err());
}

#[test]
fn prompts_teach_from_simple_to_deep_and_keep_evidence_boundaries() {
    let outline = outline();
    let preamble = teaching_preamble("zh", Some(&outline));
    let task = lesson_task("zh", &outline.topics[0], &["What is attention?"]);
    let prompt = format!("{preamble}\n{task}");
    for required in ["plainSummary", "analogy", "prerequisites", "misconceptions", "Simplified Chinese", "Dot product", "What is attention?", "NOT evidence"] {
        assert!(prompt.contains(required), "lesson prompt misses {required}");
    }
    assert!(!outline_prompt("en", 12, None).contains("READER RESEARCH GOAL"));
    assert!(outline_prompt("en", 12, Some("Retrieval for chemistry")).contains("Retrieval for chemistry"));
    let review = review_prompt(
        "zh",
        &outline.topics[0],
        &lesson(),
        &[ReviewSource { page: 1, text: Some("Original footnote text") }, ReviewSource { page: 2, text: None }],
    );
    assert!(review.contains("Original footnote text"));
    assert!(review.contains("page 2: no text layer"));
    assert!(review.contains("INDEPENDENT Reviewer"));
    let revision = revision_instructions(&lesson(), &super::tests::review(0, ReviewVerdict::NeedsRevision));
    assert!(revision.contains("permutation invariant") && revision.contains("NOT evidence"));
    let ask = follow_up_task("zh", FollowUpMode::Simpler, "我没懂", Some("Step 2"), "{}", &[]);
    assert!(ask.contains("MORE SIMPLY") && ask.contains("Step 2") && ask.contains("NOT evidence"));
    assert!(parse_follow_up_answer("  ").is_err());
    assert_eq!(parse_follow_up_answer(" An answer. ").unwrap(), "An answer.");
}

/// Providers with prefix caching (DeepSeek, MiniMax, OpenAI) only reuse the
/// longest identical prefix, so everything specific to one request must come
/// after the parts that repeat across a guide.
#[test]
fn request_specific_text_stays_out_of_the_shared_prefixes() {
    let outline = outline();
    let preamble = teaching_preamble("zh", Some(&outline));
    assert_eq!(preamble, teaching_preamble("zh", Some(&outline)));
    for topic in &outline.topics {
        assert!(!preamble.contains(&topic.title), "the preamble names topic {}", topic.title);
        assert!(lesson_task("zh", topic, &[]).contains(&topic.title));
    }
    assert!(!outline_prompt("zh", 12, None).contains("rejected"));

    let draft = review_prompt("zh", &outline.topics[0], &lesson(), &[ReviewSource { page: 1, text: Some("Original text") }]);
    let mut revised = lesson();
    revised.plain_summary = "A different, revised summary.".into();
    let recheck = review_prompt("zh", &outline.topics[0], &revised, &[ReviewSource { page: 1, text: Some("Original text") }]);
    let shared = |text: &str| text[..text.find("TOPIC:").unwrap()].to_owned();
    assert!(shared(&draft).contains("Original text"));
    assert_eq!(shared(&draft), shared(&recheck), "a re-review reuses instructions and originals");

    let first = follow_up_task("zh", FollowUpMode::Question, "Why softmax?", None, "{notes}", &[]);
    let second = follow_up_task("zh", FollowUpMode::Example, "Another one", Some("Step 2"), "{notes}", &[]);
    let stable = |text: &str| text[..text.find("Earlier questions").unwrap()].to_owned();
    assert!(stable(&first).contains("{notes}"));
    assert_eq!(stable(&first), stable(&second), "questions about one part share rules and notes");
    assert!(!stable(&first).contains("Why softmax?"));
}

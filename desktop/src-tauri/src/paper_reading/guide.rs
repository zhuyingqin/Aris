use super::*;
use runtime::paper_evidence::{self, AllocatedText, PageRole, PageText};
use runtime::paper_guide::{
    self, GuideEvidence, GuideTask, GuideTaskStatus, LessonReview, LessonStage, PaperGuide,
    ReviewSource, ReviewVerdict,
};
use runtime::paper_reading::{ContentKind, PerceptionPage};

const MAX_GUIDE_TEXT_CHARS: usize = 120_000;
const MAX_GUIDE_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTLINE_IMAGES: usize = 8;
const MAX_REVIEW_PAGE_CHARS: usize = 30_000;

pub(super) struct EvidenceMessage {
    pub(super) message: ConversationMessage,
    pub(super) evidence: Vec<GuideEvidence>,
}

/// A labelled model transcription of a page that has no text layer.
fn derived_transcription(page: &PerceptionPage) -> Option<String> {
    let result = page.result.as_ref()?;
    let text = result
        .items
        .iter()
        .map(|item| format!("[{:?}] {}", item.kind, item.content))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn original_texts(run: &PaperReadingRun) -> Vec<&str> {
    run.pages
        .iter()
        .map(|page| {
            page.source
                .as_ref()
                .map_or("", |source| source.embedded_text.as_str())
        })
        .collect()
}

/// Build one Chat message from original page evidence. Text for pages with a
/// text layer is original; text for pages without one is a derived
/// transcription and is labelled and receipted as such.
///
/// Layout for prompt caching: the reusable `preamble` first, then the
/// evidence, the page index and the receipts, and the request-specific `task`
/// (topic, question, revision or retry feedback) as the only block that
/// changes between attempts. Providers with prefix caching then reuse the
/// preamble across a guide and the evidence across attempts at one topic.
#[allow(clippy::too_many_arguments)]
fn build_message(
    workspace: &Path,
    run: &PaperReadingRun,
    preamble: String,
    texts: &[AllocatedText],
    image_pages: &[usize],
    index: Option<String>,
    task: String,
    strict_images: bool,
) -> Result<EvidenceMessage, String> {
    let mut blocks = vec![ContentBlock::Text {
        text: format!("{preamble}\nPDF SHA-256: {}", run.document_revision),
    }];
    let mut evidence = Vec::new();
    let mut image_bytes = 0;
    for number in 1..=run.total_pages {
        let text = texts.iter().find(|item| item.page == number);
        if text.is_none() && !image_pages.contains(&number) {
            continue;
        }
        let source = run.pages[number - 1]
            .source
            .as_ref()
            .ok_or("Original evidence is missing")?;
        source.validate_for(run, number - 1)?;
        let mut receipt = GuideEvidence {
            page: number,
            image_sha256: None,
            text_sha256: None,
            text_truncated: source.text_truncated,
            derived_text_sha256: None,
        };
        if let Some(text) = text {
            receipt.text_truncated |= text.truncated;
            let hash = Some(content_sha256(text.text.as_bytes()));
            let label = if text.derived {
                receipt.derived_text_sha256 = hash;
                format!(
                    "DERIVED TRANSCRIPTION (model-generated from the image of page {number}, which has no text layer; may contain errors; NOT original evidence):"
                )
            } else {
                receipt.text_sha256 = hash;
                format!(
                    "ORIGINAL PDF TEXT, page {number}, truncated={}:",
                    receipt.text_truncated
                )
            };
            blocks.push(ContentBlock::Text {
                text: format!("{label}\n{}", text.text),
            });
        }
        if image_pages.contains(&number) {
            let image = read_original_page_image(workspace, run, number - 1)?;
            if image_bytes + image.len() <= MAX_GUIDE_IMAGE_BYTES {
                image_bytes += image.len();
                receipt.image_sha256 = Some(source.image_sha256.clone());
                blocks.push(ContentBlock::Text {
                    text: format!(
                        "ORIGINAL PAGE IMAGE: page {number}; SHA-256 {}",
                        source.image_sha256
                    ),
                });
                blocks.push(ContentBlock::Image {
                    media_type: source.mime_type.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(image),
                });
            } else if strict_images {
                return Err("Original topic images exceed the explanation input budget".into());
            }
        }
        evidence.push(receipt);
    }
    if !evidence.iter().any(|source| source.image_sha256.is_some()) {
        return Err("No original images fit the explanation input budget".into());
    }
    if let Some(index) = index {
        blocks.push(ContentBlock::Text { text: index });
    }
    blocks.push(ContentBlock::Text {
        text: format!(
            "Actual evidence supplied (other pages have NOT been read in this turn): {}",
            serde_json::to_string(&evidence).map_err(|error| error.to_string())?
        ),
    });
    blocks.push(ContentBlock::Text { text: task });
    Ok(EvidenceMessage {
        message: ConversationMessage::user_blocks(blocks),
        evidence,
    })
}

/// Outline input: body text is budgeted with water-filling (reference lists
/// excluded, page ends kept), and images are chosen from caption, table and
/// equation signals found in the PDF's own text layer.
pub(super) fn outline_message(
    workspace: &Path,
    run: &PaperReadingRun,
    preamble: String,
    task: String,
) -> Result<EvidenceMessage, String> {
    let originals = original_texts(run);
    let signals = paper_evidence::analyze_pages(&originals);
    let derived = run
        .pages
        .iter()
        .map(derived_transcription)
        .collect::<Vec<_>>();
    let inputs = signals
        .iter()
        .filter_map(|signal| {
            let index = signal.page - 1;
            if signal.has_text_layer {
                Some(PageText {
                    page: signal.page,
                    text: originals[index],
                    derived: false,
                    role: signal.role,
                    body_end: signal.body_end,
                })
            } else {
                derived[index].as_deref().map(|text| PageText {
                    page: signal.page,
                    text,
                    derived: true,
                    role: signal.role,
                    body_end: None,
                })
            }
        })
        .collect::<Vec<_>>();
    let texts = paper_evidence::allocate_text(&inputs, MAX_GUIDE_TEXT_CHARS);
    let perceived = run
        .pages
        .iter()
        .map(|page| {
            page.result.as_ref().map(|result| {
                result
                    .items
                    .iter()
                    .map(|item| item.kind)
                    .collect::<std::collections::BTreeSet<ContentKind>>()
            })
        })
        .collect::<Vec<_>>();
    let images = paper_evidence::select_outline_images(&signals, &perceived, MAX_OUTLINE_IMAGES);
    let pages_with = |role: PageRole| {
        signals
            .iter()
            .filter(|signal| signal.role == role)
            .map(|signal| signal.page)
            .collect::<Vec<_>>()
    };
    let entries = signals
        .iter()
        .filter(|signal| {
            !signal.has_text_layer
                || signal.figure_captions + signal.table_captions + signal.equation_numbers > 0
        })
        .map(|signal| {
            serde_json::json!({
                "page": signal.page,
                "role": signal.role,
                "textLayer": signal.has_text_layer,
                "figureCaptions": signal.figure_captions,
                "tableCaptions": signal.table_captions,
                "numberedEquations": signal.equation_numbers,
                "captions": signal.captions,
                "transcribedKinds": perceived[signal.page - 1],
            })
        })
        .collect::<Vec<_>>();
    let index = format!(
        "PAGE INDEX (derived from the PDF text layer; for choosing topic pages only, not evidence): document pages {}; reference-list pages {:?}; appendix pages {:?}; pages with figures, tables, numbered equations or no text layer: {}",
        run.total_pages,
        pages_with(PageRole::References),
        pages_with(PageRole::Appendix),
        serde_json::to_string(&entries).map_err(|error| error.to_string())?
    );
    build_message(workspace, run, preamble, &texts, &images, Some(index), task, false)
}

/// Topic input: the full original text and image of 1–4 pages. Pages without
/// a text layer contribute their image plus a labelled derived transcription.
pub(super) fn topic_message(
    workspace: &Path,
    run: &PaperReadingRun,
    preamble: String,
    task: String,
    pages: &[usize],
) -> Result<EvidenceMessage, String> {
    let per_page = (MAX_GUIDE_TEXT_CHARS / pages.len().max(1)).min(30_000);
    let mut texts = Vec::new();
    for &number in pages {
        let page = run
            .pages
            .get(number.wrapping_sub(1))
            .ok_or("Topic cites a page outside this document")?;
        let original = page
            .source
            .as_ref()
            .map_or("", |source| source.embedded_text.as_str());
        let (text, derived) = if !original.trim().is_empty() {
            (Some(original.to_owned()), false)
        } else {
            (derived_transcription(page), true)
        };
        if let Some(text) = text {
            let (text, truncated) = paper_evidence::truncate_middle(&text, per_page);
            texts.push(AllocatedText {
                page: number,
                text,
                truncated,
                derived,
            });
        }
    }
    build_message(workspace, run, preamble, &texts, pages, None, task, true)
}

pub(super) async fn execute(
    app: &AppHandle,
    project_id: &str,
    run: &PaperReadingRun,
    session_id: &str,
    stage: &'static str,
    bundle: EvidenceMessage,
    cancellation: Arc<AtomicBool>,
) -> Result<String, String> {
    crate::engine::run_paper_reading_turn(
        app.clone(),
        session_id.into(),
        project_id.into(),
        crate::engine::PaperReadingRuntimeContext {
            run_id: run.id.clone(),
            paper_id: run.paper_id.clone(),
            document_revision: run.document_revision.clone(),
            page_index: bundle.evidence.first().map_or(0, |source| source.page - 1),
            stage,
            executor_signature: run.executor_signature.clone(),
        },
        bundle.message,
        run.model.clone(),
        cancellation,
    )
    .await
}

fn original_pages(bundle: &EvidenceMessage) -> Vec<usize> {
    bundle
        .evidence
        .iter()
        .filter(|source| source.is_original())
        .map(|source| source.page)
        .collect()
}

fn save_and_emit(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    run: &PaperReadingRun,
) -> Result<PaperReadingRun, String> {
    let saved = open_literature_store_at(workspace)?.save_paper_reading_run(run)?;
    emit(app, project_id, saved.clone());
    Ok(saved)
}

fn guide_mut(run: &mut PaperReadingRun) -> Result<&mut PaperGuide, String> {
    run.guide.as_mut().ok_or_else(|| "Missing explanation state".into())
}

fn lesson_task(
    run: &mut PaperReadingRun,
    index: usize,
    revision: bool,
) -> Result<&mut GuideTask<paper_guide::GuideLesson>, String> {
    let lesson = guide_mut(run)?
        .lessons
        .get_mut(index)
        .ok_or("Missing explanation topic")?;
    Ok(if revision {
        lesson.revision_task()
    } else {
        &mut lesson.task
    })
}

pub(super) async fn drive(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    mut run: PaperReadingRun,
    cancellation: Arc<AtomicBool>,
    breaker: &mut FailureBreaker,
) -> Result<PaperReadingRun, String> {
    if cancellation.load(Ordering::SeqCst) {
        return Ok(run);
    }
    while run
        .guide
        .as_ref()
        .is_some_and(|guide| guide.outline.status == GuideTaskStatus::Pending)
    {
        if cancellation.load(Ordering::SeqCst) {
            return Ok(run);
        }
        let guide = run.guide.as_ref().ok_or("Missing explanation state")?;
        let reader_goal = guide.reader_goal.clone();
        let preamble =
            paper_guide::outline_prompt(&run.language, run.total_pages, reader_goal.as_deref());
        let mut task = paper_guide::OUTLINE_TASK.to_owned();
        if let Some(error) = &guide.outline.error {
            task.push_str(&format!("\nPrevious output was rejected: {error}. Regenerate from the originals above. Return valid JSON with exact field types and escaped quotes and backslashes."));
        }
        let bundle = match outline_message(workspace, &run, preamble, task) {
            Ok(bundle) => bundle,
            Err(error) => {
                guide_mut(&mut run)?.outline.reject(&error);
                return save_and_emit(app, project_id, workspace, &run);
            }
        };
        let supplied = original_pages(&bundle);
        let session_id = format!(
            "paper-{}-outline-{:016x}",
            &run.id[..16],
            rand::random::<u64>()
        );
        guide_mut(&mut run)?
            .outline
            .begin(session_id.clone(), bundle.evidence.clone())?;
        run = save_and_emit(app, project_id, workspace, &run)?;
        let output = execute(
            app,
            project_id,
            &run,
            &session_id,
            "understanding_outline",
            bundle,
            cancellation.clone(),
        )
        .await;
        if cancellation.load(Ordering::SeqCst) {
            return Ok(run);
        }
        let failure = output.as_ref().err().cloned();
        let parsed = output.and_then(|text| {
            paper_guide::parse_outline(&text, run.total_pages, &supplied, reader_goal.is_some())
        });
        let guide = guide_mut(&mut run)?;
        guide.finish_outline(&session_id, parsed)?;
        guide.outline.retry_invalid_output(failure.is_none());
        run = save_and_emit(app, project_id, workspace, &run)?;
        breaker.record(failure.as_deref())?;
    }
    let count = run.guide.as_ref().map_or(0, |guide| guide.lessons.len());
    for index in 0..count {
        loop {
            if cancellation.load(Ordering::SeqCst) {
                return Ok(run);
            }
            let guide = run.guide.as_ref().ok_or("Missing explanation state")?;
            run = match guide.lessons[index].stage(guide.review_required) {
                LessonStage::Generate => {
                    generate_lesson(app, project_id, workspace, run, index, false, &cancellation, breaker).await?
                }
                LessonStage::Revise => {
                    generate_lesson(app, project_id, workspace, run, index, true, &cancellation, breaker).await?
                }
                LessonStage::Review { round } => {
                    review_lesson(app, project_id, workspace, run, index, round, &cancellation).await?
                }
                LessonStage::Done | LessonStage::Blocked => break,
            };
        }
    }
    Ok(run)
}

#[allow(clippy::too_many_arguments)]
async fn generate_lesson(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    mut run: PaperReadingRun,
    index: usize,
    revision: bool,
    cancellation: &Arc<AtomicBool>,
    breaker: &mut FailureBreaker,
) -> Result<PaperReadingRun, String> {
    let guide = run.guide.as_ref().ok_or("Missing explanation state")?;
    let lesson = &guide.lessons[index];
    let topic = lesson.topic.clone();
    let earlier = guide.lessons[..index]
        .iter()
        .map(|item| item.topic.title.as_str())
        .collect::<Vec<_>>();
    let preamble = paper_guide::teaching_preamble(&run.language, guide.outline.result.as_ref());
    let mut task = paper_guide::lesson_task(&run.language, &topic, &earlier);
    if revision {
        let draft = lesson
            .task
            .result
            .as_ref()
            .ok_or("A revision needs the first draft")?;
        let review = lesson
            .reviews
            .iter()
            .rev()
            .find(|review| review.round == 0)
            .ok_or("A revision needs the Reviewer findings")?;
        task.push_str(&paper_guide::revision_instructions(draft, review));
    }
    let previous_error = if revision {
        lesson.revision.as_ref().and_then(|task| task.error.clone())
    } else {
        lesson.task.error.clone()
    };
    if let Some(error) = previous_error {
        task.push_str(&format!(
            "\nThe previous attempt could not be accepted: {error}. Produce a fresh explanation from the originals above, observing the exact JSON field types."
        ));
    }
    let bundle = match topic_message(workspace, &run, preamble, task, &topic.source_pages) {
        Ok(bundle) => bundle,
        Err(error) => {
            // Only this topic is affected; the rest of the guide continues.
            lesson_task(&mut run, index, revision)?.reject(&error);
            return save_and_emit(app, project_id, workspace, &run);
        }
    };
    let supplied = original_pages(&bundle);
    let session_id = format!(
        "paper-{}-{}-{index}-{:016x}",
        &run.id[..16],
        if revision { "revision" } else { "lesson" },
        rand::random::<u64>()
    );
    lesson_task(&mut run, index, revision)?.begin(session_id.clone(), bundle.evidence.clone())?;
    run = save_and_emit(app, project_id, workspace, &run)?;
    let output = execute(
        app,
        project_id,
        &run,
        &session_id,
        if revision { "explanation_revision" } else { "multimodal_explanation" },
        bundle,
        cancellation.clone(),
    )
    .await;
    if cancellation.load(Ordering::SeqCst) {
        return Ok(run);
    }
    let failure = output.as_ref().err().cloned();
    let parsed = output.and_then(|text| paper_guide::parse_lesson(&text, &supplied));
    let task = lesson_task(&mut run, index, revision)?;
    task.finish(&session_id, parsed)?;
    task.retry_invalid_output(failure.is_none());
    let run = save_and_emit(app, project_id, workspace, &run)?;
    breaker.record(failure.as_deref())?;
    Ok(run)
}

/// The Reviewer only receives original text; it cannot see page images, so
/// figure-only claims are reported as not verifiable rather than guessed.
fn review_sources(run: &PaperReadingRun, pages: &[usize]) -> (Vec<(usize, Option<String>)>, Vec<GuideEvidence>) {
    let mut sources = Vec::new();
    let mut evidence = Vec::new();
    for &number in pages {
        let Some(source) = run
            .pages
            .get(number.wrapping_sub(1))
            .and_then(|page| page.source.as_ref())
        else {
            continue;
        };
        let text = (!source.embedded_text.trim().is_empty()).then(|| {
            paper_evidence::truncate_middle(&source.embedded_text, MAX_REVIEW_PAGE_CHARS)
        });
        evidence.push(GuideEvidence {
            page: number,
            image_sha256: None,
            text_sha256: text
                .as_ref()
                .map(|(text, _)| content_sha256(text.as_bytes())),
            text_truncated: source.text_truncated
                || text.as_ref().is_some_and(|(_, truncated)| *truncated),
            derived_text_sha256: None,
        });
        sources.push((number, text.map(|(text, _)| text)));
    }
    (sources, evidence)
}

async fn review_lesson(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    mut run: PaperReadingRun,
    index: usize,
    round: usize,
    cancellation: &Arc<AtomicBool>,
) -> Result<PaperReadingRun, String> {
    let guide = run.guide.as_ref().ok_or("Missing explanation state")?;
    let entry = &guide.lessons[index];
    let lesson = if round == 0 {
        entry.task.result.clone()
    } else {
        entry
            .revision
            .as_ref()
            .and_then(|revision| revision.result.clone())
    }
    .ok_or("No lesson draft to review")?;
    let topic = entry.topic.clone();
    let (sources, evidence) = review_sources(&run, &topic.source_pages);
    let review_sources = sources
        .iter()
        .map(|(page, text)| ReviewSource {
            page: *page,
            text: text.as_deref(),
        })
        .collect::<Vec<_>>();
    let base_prompt = paper_guide::review_prompt(&run.language, &topic, &lesson, &review_sources);
    let session_id = format!(
        "paper-{}-review-{index}-{round}-{:016x}",
        &run.id[..16],
        rand::random::<u64>()
    );
    let mut outcome = Err(String::new());
    let mut reviewer = None;
    for attempt in 0..2 {
        let prompt = match &outcome {
            Err(error) if attempt > 0 && !error.is_empty() => format!(
                "{base_prompt}\n\nYour previous response could not be read ({error}). Return only the JSON object."
            ),
            _ => base_prompt.clone(),
        };
        let session = session_id.clone();
        let cancel = cancellation.clone();
        let executor_model = run.model.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::engine::run_paper_lesson_review(&session, prompt, cancel, &executor_model)
        })
        .await
        .map_err(|error| error.to_string())?;
        if cancellation.load(Ordering::SeqCst) {
            return Ok(run);
        }
        match result {
            Err(unavailable) => {
                outcome = Err(unavailable);
                reviewer = None;
                break;
            }
            Ok(output) => {
                reviewer = Some(output.reviewer);
                outcome = paper_guide::parse_review(&output.text).map_err(|error| {
                    format!("The Reviewer's response could not be read ({error})")
                });
                if outcome.is_ok() {
                    break;
                }
            }
        }
    }
    let (verdict, summary, issues) = match outcome {
        Ok(parsed) => parsed,
        Err(reason) => (ReviewVerdict::Unavailable, reason, Vec::new()),
    };
    guide_mut(&mut run)?.lessons[index].record_review(LessonReview {
        round,
        verdict,
        summary,
        issues,
        reviewer,
        session_id,
        reviewed_at: runtime::now_iso8601(),
        evidence,
    });
    save_and_emit(app, project_id, workspace, &run)
}

/// Teaching notes and original pages for a reader's follow-up question.
pub(super) fn follow_up_material(
    run: &PaperReadingRun,
    target: &str,
) -> Result<(String, Vec<usize>), String> {
    let guide = run.guide.as_ref().ok_or("This version has no guide yet")?;
    if target == "overview" {
        let outline = guide
            .outline
            .result
            .as_ref()
            .ok_or("The paper overview has not been generated yet")?;
        let mut pages = vec![1];
        for section in &outline.overview {
            for &page in &section.source_pages {
                if !pages.contains(&page) && pages.len() < 4 {
                    pages.push(page);
                }
            }
        }
        let notes = serde_json::json!({
            "oneSentence": outline.one_sentence,
            "overview": outline.overview,
            "glossary": outline.glossary,
        });
        return Ok((notes.to_string(), pages));
    }
    let index = target
        .strip_prefix("lesson:")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or("Unknown guide section")?;
    let lesson = guide.lessons.get(index).ok_or("Unknown guide topic")?;
    let current = lesson
        .current()
        .ok_or("This topic has not been explained yet")?;
    let notes = serde_json::json!({ "topic": lesson.topic, "lesson": current });
    Ok((notes.to_string(), lesson.topic.source_pages.clone()))
}

/// New guides are reviewed lesson by lesson and remember the active project
/// goal (reader context for `relevance`, never evidence about the paper).
pub(super) fn ensure_guide(run: &mut PaperReadingRun, workspace: &Path) {
    run.guide.get_or_insert_with(|| {
        let mut guide = PaperGuide::reviewed();
        guide.reader_goal = runtime::load_project_goal(workspace)
            .ok()
            .flatten()
            .filter(|goal| goal.status.as_str() == "active")
            .map(|goal| goal.objective.chars().take(800).collect())
            .filter(|goal: &String| !goal.trim().is_empty());
        guide
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teaching_reads_original_images_even_when_a_transcription_claims_something_else() {
        let (directory, run) = super::super::tests::fixture();
        let mut run =
            save_page_source(directory.path(), super::super::tests::input(&run, 1)).unwrap();
        run.pages[0].result = Some(runtime::paper_reading::PagePerception {
            page_index: 0,
            items: vec![runtime::paper_reading::PerceivedItem {
                kind: runtime::paper_reading::ContentKind::Formula,
                content: "WRONG DERIVED FORMULA".into(),
                uncertainties: vec![],
            }],
            warnings: vec![],
        });
        let bundle =
            topic_message(directory.path(), &run, "Teach".into(), "Explain".into(), &[1]).unwrap();
        let texts = bundle
            .message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(texts.contains("Actual original PDF text"));
        assert!(texts.contains("ORIGINAL PDF TEXT, page 1"));
        assert!(!texts.contains("WRONG DERIVED FORMULA"));
        assert_eq!(
            bundle.evidence[0].image_sha256,
            run.pages[0]
                .source
                .as_ref()
                .map(|source| source.image_sha256.clone())
        );
        assert!(bundle
            .message
            .blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. })));
        fs::write(
            artifact_dir(directory.path(), &run.id)
                .unwrap()
                .join("page-0.jpg"),
            b"replaced",
        )
        .unwrap();
        assert!(
            topic_message(directory.path(), &run, "Teach".into(), "Explain".into(), &[1]).is_err()
        );
    }

    #[test]
    fn scanned_pages_reach_the_outline_as_labelled_derived_text_not_evidence() {
        let (directory, run) = super::super::tests::fixture();
        let mut input = super::super::tests::input(&run, 1);
        input.embedded_text = String::new();
        let mut run = save_page_source(directory.path(), input).unwrap();
        run.pages[0].result = Some(runtime::paper_reading::PagePerception {
            page_index: 0,
            items: vec![runtime::paper_reading::PerceivedItem {
                kind: runtime::paper_reading::ContentKind::Text,
                content: "Transcribed abstract of a scanned page".into(),
                uncertainties: vec![],
            }],
            warnings: vec![],
        });
        let bundle =
            outline_message(directory.path(), &run, "Outline".into(), "Now".into()).unwrap();
        let texts = bundle
            .message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(texts.contains("DERIVED TRANSCRIPTION"));
        assert!(texts.contains("Transcribed abstract of a scanned page"));
        assert!(texts.contains("PAGE INDEX"));
        let receipt = &bundle.evidence[0];
        assert!(receipt.text_sha256.is_none(), "a transcription is not original text");
        assert!(receipt.derived_text_sha256.is_some());
        assert!(receipt.image_sha256.is_some(), "the original image is still attached");
    }

    /// Prefix caching (DeepSeek, MiniMax, OpenAI automatic; Anthropic-style
    /// breakpoints on all but the last block) only helps when attempts differ
    /// in the final block alone.
    #[test]
    fn attempts_and_questions_about_one_topic_differ_only_in_the_final_block() {
        let (directory, run) = super::super::tests::fixture();
        let run = save_page_source(directory.path(), super::super::tests::input(&run, 1)).unwrap();
        let preamble = paper_guide::teaching_preamble(&run.language, None);
        let draft = topic_message(directory.path(), &run, preamble.clone(), "Lesson".into(), &[1]).unwrap();
        let retry = topic_message(
            directory.path(),
            &run,
            preamble.clone(),
            "Lesson\nThe previous attempt could not be accepted".into(),
            &[1],
        )
        .unwrap();
        let question = topic_message(directory.path(), &run, preamble, "Why?".into(), &[1]).unwrap();
        let blocks = |bundle: &EvidenceMessage| bundle.message.blocks.clone();
        let (draft, retry, question) = (blocks(&draft), blocks(&retry), blocks(&question));
        let shared = draft.len() - 1;
        assert!(shared >= 3, "preamble, original evidence and receipts precede the task");
        assert_eq!(draft[..shared], retry[..shared]);
        assert_eq!(draft[..shared], question[..shared]);
        assert_ne!(draft[shared], retry[shared]);
        assert!(matches!(&draft[shared], ContentBlock::Text { text } if text == "Lesson"));
        assert!(draft[..shared]
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. })));
    }

    #[test]
    fn reviewer_sees_original_text_and_marks_pages_without_text() {
        let (directory, run) = super::super::tests::fixture();
        let run = save_page_source(directory.path(), super::super::tests::input(&run, 1)).unwrap();
        let (sources, evidence) = review_sources(&run, &[1]);
        assert_eq!(sources[0].1.as_deref(), Some("Actual original PDF text"));
        assert!(evidence[0].text_sha256.is_some());
        assert!(evidence[0].image_sha256.is_none(), "the Reviewer channel is text-only");
    }

    #[test]
    fn consecutive_request_failures_pause_the_task() {
        let mut breaker = FailureBreaker::default();
        assert!(breaker.record(Some("401")).is_ok());
        assert!(breaker.record(None).is_ok(), "a success resets the count");
        assert!(breaker.record(Some("401")).is_ok());
        assert!(breaker.record(Some("401")).is_ok());
        let error = breaker.record(Some("401 Unauthorized")).unwrap_err();
        assert!(error.contains("3 consecutive") && error.contains("401 Unauthorized"));
    }
}

use super::*;
use runtime::paper_guide::{self, GuideEvidence, GuideTaskStatus, PaperGuide};

const MAX_GUIDE_TEXT_CHARS: usize = 120_000;
const MAX_GUIDE_IMAGE_BYTES: usize = 32 * 1024 * 1024;

struct EvidenceMessage {
    message: ConversationMessage,
    evidence: Vec<GuideEvidence>,
}

fn outline_image_pages(run: &PaperReadingRun) -> Vec<usize> {
    let mut scores = run
        .pages
        .iter()
        .map(|page| {
            let blank = page
                .source
                .as_ref()
                .is_some_and(|source| source.embedded_text.trim().is_empty());
            let score = usize::from(blank) * 100
                + page.result.as_ref().map_or(0, |result| {
                    result
                        .items
                        .iter()
                        .map(|item| match item.kind {
                            runtime::paper_reading::ContentKind::Figure
                            | runtime::paper_reading::ContentKind::Table => 8,
                            runtime::paper_reading::ContentKind::Formula => 5,
                            _ => 0,
                        })
                        .sum::<usize>()
                });
            (page.page_index + 1, score)
        })
        .collect::<Vec<_>>();
    scores.sort_by_key(|&(page, score)| (std::cmp::Reverse(score), page));
    let mut pages = scores
        .into_iter()
        .take(8)
        .map(|(page, _)| page)
        .collect::<Vec<_>>();
    pages.sort_unstable();
    pages
}

/// The inventory only helps find relevant originals; each generation turn
/// receives verified original images and raw PDF text, never a draft alone.
fn evidence_message(
    workspace: &Path,
    run: &PaperReadingRun,
    prompt: String,
    image_pages: &[usize],
    text_pages: &[usize],
    planning: bool,
) -> Result<EvidenceMessage, String> {
    let mut blocks = vec![ContentBlock::Text {
        text: format!("{prompt}\nPDF SHA-256: {}", run.document_revision),
    }];
    let mut evidence = Vec::new();
    let per_page = (MAX_GUIDE_TEXT_CHARS / text_pages.len().max(1)).min(30_000);
    let mut image_bytes = 0;
    for number in 1..=run.total_pages {
        if !image_pages.contains(&number) && !text_pages.contains(&number) {
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
        };
        if text_pages.contains(&number) && !source.embedded_text.trim().is_empty() {
            let text: String = source.embedded_text.chars().take(per_page).collect();
            receipt.text_truncated |= source.embedded_text.chars().count() > per_page;
            receipt.text_sha256 = Some(content_sha256(text.as_bytes()));
            blocks.push(ContentBlock::Text {
                text: format!(
                    "ORIGINAL PDF TEXT, page {number}, truncated={}:\n{text}",
                    receipt.text_truncated
                ),
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
            } else if !planning {
                return Err("Original topic images exceed the explanation input budget".into());
            }
        }
        if receipt.image_sha256.is_some() || receipt.text_sha256.is_some() {
            evidence.push(receipt);
        }
    }
    if !evidence.iter().any(|source| source.image_sha256.is_some()) {
        return Err("No original images fit the explanation input budget".into());
    }
    if planning {
        let index = run
            .pages
            .iter()
            .map(|page| {
                let kinds = page
                    .result
                    .as_ref()
                    .map(|result| {
                        result
                            .items
                            .iter()
                            .map(|item| item.kind)
                            .collect::<std::collections::BTreeSet<_>>()
                    })
                    .unwrap_or_default();
                serde_json::json!({ "page": page.page_index + 1, "candidateKinds": kinds })
            })
            .collect::<Vec<_>>();
        blocks.push(ContentBlock::Text {
            text: format!(
                "DERIVED RETRIEVAL INDEX ONLY (not source evidence): {}",
                serde_json::to_string(&index).map_err(|error| error.to_string())?
            ),
        });
    }
    blocks.push(ContentBlock::Text {
        text: format!(
            "Actual original evidence supplied (other pages have NOT been read in this turn): {}",
            serde_json::to_string(&evidence).map_err(|error| error.to_string())?
        ),
    });
    Ok(EvidenceMessage {
        message: ConversationMessage::user_blocks(blocks),
        evidence,
    })
}

async fn execute(
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

pub(super) async fn drive(
    app: &AppHandle,
    project_id: &str,
    workspace: &Path,
    mut run: PaperReadingRun,
    cancellation: Arc<AtomicBool>,
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
        let mut prompt = paper_guide::outline_prompt(&run.language, run.total_pages);
        if let Some(error) = run
            .guide
            .as_ref()
            .and_then(|guide| guide.outline.error.as_ref())
        {
            prompt.push_str(&format!("\nPrevious output was rejected: {error}. Regenerate from the originals below. Return valid JSON with exact field types and escaped quotes and backslashes."));
        }
        let bundle = evidence_message(
            workspace,
            &run,
            prompt,
            &outline_image_pages(&run),
            &(1..=run.total_pages).collect::<Vec<_>>(),
            true,
        )?;
        let supplied = bundle
            .evidence
            .iter()
            .map(|source| source.page)
            .collect::<Vec<_>>();
        let session_id = format!(
            "paper-{}-outline-{:016x}",
            &run.id[..16],
            rand::random::<u64>()
        );
        run.guide
            .as_mut()
            .ok_or("Missing explanation state")?
            .outline
            .begin(session_id.clone(), bundle.evidence.clone())?;
        run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
        emit(app, project_id, run.clone());
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
        let received_output = output.is_ok();
        let parsed =
            output.and_then(|text| paper_guide::parse_outline(&text, run.total_pages, &supplied));
        run.guide
            .as_mut()
            .ok_or("Missing explanation state")?
            .finish_outline(&session_id, parsed)?;
        run.guide
            .as_mut()
            .unwrap()
            .outline
            .retry_invalid_output(received_output);
        run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
        emit(app, project_id, run.clone());
    }
    let count = run.guide.as_ref().map_or(0, |guide| guide.lessons.len());
    for index in 0..count {
        loop {
            if cancellation.load(Ordering::SeqCst) {
                return Ok(run);
            }
            let lesson = &run
                .guide
                .as_ref()
                .ok_or("Missing explanation state")?
                .lessons[index];
            if lesson.task.status != GuideTaskStatus::Pending {
                break;
            }
            let topic = lesson.topic.clone();
            let mut prompt = paper_guide::lesson_prompt(&run.language, &topic);
            if let Some(error) = &lesson.task.error {
                prompt.push_str(&format!(
                "\nThe previous attempt could not be accepted: {error}. Produce a fresh explanation from the originals below, observing the exact JSON field types."
            ));
            }
            let bundle = evidence_message(
                workspace,
                &run,
                prompt,
                &topic.source_pages,
                &topic.source_pages,
                false,
            )?;
            let supplied = bundle
                .evidence
                .iter()
                .map(|source| source.page)
                .collect::<Vec<_>>();
            let session_id = format!(
                "paper-{}-lesson-{index}-{:016x}",
                &run.id[..16],
                rand::random::<u64>()
            );
            run.guide
                .as_mut()
                .ok_or("Missing explanation state")?
                .lessons[index]
                .task
                .begin(session_id.clone(), bundle.evidence.clone())?;
            run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
            emit(app, project_id, run.clone());
            let output = execute(
                app,
                project_id,
                &run,
                &session_id,
                "multimodal_explanation",
                bundle,
                cancellation.clone(),
            )
            .await;
            if cancellation.load(Ordering::SeqCst) {
                return Ok(run);
            }
            let received_output = output.is_ok();
            let parsed = output.and_then(|text| paper_guide::parse_lesson(&text, &supplied));
            run.guide
                .as_mut()
                .ok_or("Missing explanation state")?
                .lessons[index]
                .task
                .finish(&session_id, parsed)?;
            run.guide.as_mut().unwrap().lessons[index]
                .task
                .retry_invalid_output(received_output);
            run = open_literature_store_at(workspace)?.save_paper_reading_run(&run)?;
            emit(app, project_id, run.clone());
        }
    }
    Ok(run)
}

pub(super) fn ensure_guide(run: &mut PaperReadingRun) {
    run.guide.get_or_insert_with(PaperGuide::default);
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
            evidence_message(directory.path(), &run, "Explain".into(), &[1], &[1], false).unwrap();
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
            evidence_message(directory.path(), &run, "Explain".into(), &[1], &[1], false).is_err()
        );
    }
}

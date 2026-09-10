#[cfg(windows)]
use super::{extract_pdf_text_by_page, literature_image_ocr, windows_ocr};
use super::{
    extraction_from_rag_pages, import_attachment_at, import_pdf_at, resolve_pdf_path_at,
    validate_vision_model, vision_message, LiteratureRagPdfPage, LiteratureVisionImage,
};
use runtime::ContentBlock;
#[cfg(windows)]
use std::process::Stdio;

fn temp_base(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "somniq-desktop-literature-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join(".somniq/papers")).expect("create papers");
    base
}

#[test]
fn pdf_paths_are_limited_to_library_and_latex_results() {
    let base = temp_base("paths");
    std::fs::write(base.join(".somniq/papers/paper.pdf"), b"%PDF-1.4").expect("write pdf");
    std::fs::write(base.join(".somniq/papers/notes.txt"), b"notes").expect("write text");
    std::fs::write(base.join("outside.pdf"), b"%PDF-1.4").expect("write outside pdf");

    assert!(resolve_pdf_path_at(&base, ".somniq/papers/paper.pdf").is_ok());
    std::fs::create_dir_all(base.join(".somniq/slides")).expect("slides dir");
    std::fs::write(base.join(".somniq/slides/main.pdf"), b"%PDF-1.7").expect("slides pdf");
    assert!(resolve_pdf_path_at(&base, ".somniq/slides/main.pdf").is_ok());
    std::fs::create_dir_all(base.join(".somniq/poster")).expect("poster dir");
    std::fs::write(base.join(".somniq/poster/main.pdf"), b"%PDF-1.7").expect("poster pdf");
    assert!(resolve_pdf_path_at(&base, ".somniq/poster/main.pdf").is_ok());
    std::fs::create_dir_all(base.join("papers")).expect("legacy papers dir");
    std::fs::write(base.join("papers/legacy.pdf"), b"%PDF-1.7").expect("legacy pdf");
    assert!(resolve_pdf_path_at(&base, "papers/legacy.pdf").is_ok());
    assert!(resolve_pdf_path_at(&base, ".somniq/papers/notes.txt").is_err());
    assert!(resolve_pdf_path_at(&base, "outside.pdf").is_err());
    assert!(resolve_pdf_path_at(&base, "../outside.pdf").is_err());
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn imports_only_valid_pdf_files_into_papers() {
    let base = temp_base("import");
    let source = base.join("source.pdf");
    let invalid = base.join("invalid.pdf");
    std::fs::write(&source, b"%PDF-1.4 imported").expect("write source");
    std::fs::write(&invalid, b"not a pdf").expect("write invalid");

    let imported = import_pdf_at(&base, &source, "My Paper.pdf").expect("import pdf");
    assert_eq!(imported.relative_path, ".somniq/papers/My-Paper.pdf");
    assert!(base.join(".somniq/papers/My-Paper.pdf").exists());
    let replacement = base.join("replacement.pdf");
    std::fs::write(&replacement, b"%PDF-1.4 replacement").expect("write replacement");
    assert!(import_pdf_at(&base, &replacement, "My Paper.pdf").is_err());
    assert!(import_pdf_at(&base, &invalid, "invalid.pdf").is_err());
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn imports_non_pdf_attachments_into_a_project_local_folder() {
    let base = temp_base("attachment-import");
    let source = base.join("supplement.csv");
    std::fs::write(&source, b"sample,value\nA,1\n").expect("write attachment");

    let imported = import_attachment_at(&base, &source).expect("import attachment");
    assert_eq!(imported.file_name, "supplement.csv");
    assert_eq!(imported.mime_type, Some("text/csv"));
    assert!(imported
        .relative_path
        .starts_with(".somniq/papers/attachments/"));
    assert_eq!(
        std::fs::read(base.join(&imported.relative_path)).expect("read copied attachment"),
        b"sample,value\nA,1\n"
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn vision_message_labels_each_page_image() {
    let message = vision_message(
        "Read these pages.".to_string(),
        vec![
            LiteratureVisionImage {
                page: 2,
                mime_type: "image/jpeg".to_string(),
                data: "ZmFrZQ==".to_string(),
                fingerprint: "sha256:page-two".to_string(),
            },
            LiteratureVisionImage {
                page: 3,
                mime_type: "image/png".to_string(),
                data: "ZmFrZTI=".to_string(),
                fingerprint: "sha256:page-three".to_string(),
            },
        ],
    )
    .expect("vision message");
    assert_eq!(message.blocks.len(), 5);
    assert!(matches!(
        &message.blocks[1],
        ContentBlock::Text { text } if text.contains("[[PAGE IMAGE 2]]")
    ));
    assert!(matches!(
        &message.blocks[2],
        ContentBlock::Image { media_type, .. } if media_type == "image/jpeg"
    ));
    assert!(matches!(
        &message.blocks[3],
        ContentBlock::Text { text } if text.contains("[[PAGE IMAGE 3]]")
    ));
}

#[test]
fn minimax_m3_is_the_only_minimax_vision_model() {
    assert!(validate_vision_model("MiniMax-M3").is_ok());
    assert!(validate_vision_model("minimax-m3").is_ok());
    assert!(validate_vision_model("MiniMax-M2.7").is_err());
    assert!(validate_vision_model("MiniMax-M2.7-highspeed").is_err());
    assert!(validate_vision_model("gpt-5.4").is_ok());
}

#[test]
fn accepts_pdfjs_pages_for_indexing_without_external_pdf_commands() {
    let extraction = extraction_from_rag_pages(&[
        LiteratureRagPdfPage {
            page: 1,
            text: "Bundled reader first page text".to_string(),
            source: "embedded".to_string(),
        },
        LiteratureRagPdfPage {
            page: 2,
            text: "Recovered OCR second page text".to_string(),
            source: "ocr".to_string(),
        },
    ])
    .expect("accept PDF.js page payload");
    assert_eq!(extraction.pages.len(), 2);
    assert!(extraction.ocr_used);
    assert!(extraction.text.contains("[[PAGE 2]]"));
    assert!(extraction.text.contains("Recovered OCR second page text"));

    let duplicate_page = extraction_from_rag_pages(&[
        LiteratureRagPdfPage {
            page: 1,
            text: "first".to_string(),
            source: "embedded".to_string(),
        },
        LiteratureRagPdfPage {
            page: 1,
            text: "duplicate".to_string(),
            source: "embedded".to_string(),
        },
    ]);
    assert!(duplicate_page.is_err());
}

/// The whole OCR path, end to end: a rendered page, Windows OCR over it, and
/// the scanned PDF that carries no text layer.
///
/// `#[ignore]` rather than a silent early return when the tools are missing:
/// self-skipping made this report green on every machine without poppler, so a
/// broken OCR path would have looked tested. Matches how MATLAB, live LLM and
/// live-provider tests are gated in this repo.
#[cfg(windows)]
#[test]
#[ignore = "requires poppler (pdftoppm), pdflatex and Windows OCR"]
fn extracts_a_scanned_pdf_with_windows_ocr() {
    let base = temp_base("ocr");
    std::fs::create_dir_all(&base).expect("create OCR test directory");
    let source = crate::process::hidden_command("pdflatex")
        .current_dir(&base)
        .args([
            "-interaction=batchmode",
            "-halt-on-error",
            "-jobname=source",
            r"\documentclass{article}\begin{document}\Huge Scanned OCR test 12345\end{document}",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    assert!(
        source.is_ok_and(|status| status.success()),
        "pdflatex must be available to run this test"
    );
    let embedded =
        extract_pdf_text_by_page(&base.join("source.pdf")).expect("extract embedded PDF text");
    assert!(embedded.text.contains("Scanned OCR test 12345"));
    let rendered = crate::process::hidden_command("pdftoppm")
        .current_dir(&base)
        .args([
            "-f",
            "1",
            "-l",
            "1",
            "-singlefile",
            "-r",
            "180",
            "-png",
            "source.pdf",
            "scan",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("render source PDF");
    assert!(
        rendered.success(),
        "pdftoppm must be available to run this test"
    );
    windows_ocr(&base.join("scan.png")).expect("Windows OCR must be available to run this test");
    let direct_ocr =
        literature_image_ocr(std::fs::read(base.join("scan.png")).expect("read scan image"))
            .expect("OCR rendered page bytes");
    assert!(direct_ocr.contains("Scanned OCR test 12345"));
    let scanned = crate::process::hidden_command("pdflatex")
        .current_dir(&base)
        .args([
            "-interaction=batchmode",
            "-halt-on-error",
            "-jobname=scanned",
            r"\documentclass{article}\usepackage{graphicx}\pagestyle{empty}\begin{document}\includegraphics[width=\textwidth]{scan.png}\end{document}",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("build scanned PDF");
    assert!(scanned.success());

    let extraction =
        extract_pdf_text_by_page(&base.join("scanned.pdf")).expect("extract scanned PDF");
    assert!(extraction.ocr_used);
    assert!(extraction.missing_pages.is_empty());
    assert!(extraction.text.contains("Scanned OCR test 12345"));
    let _ = std::fs::remove_dir_all(base);
}

// ── `_core` split: tests that could not exist before ─────────────────────────
//
// Each rule below lived inside a `#[tauri::command]` body, so exercising it
// meant launching the desktop app and driving the Literature tab. The command
// shells now resolve the project path and hand off to a `*_core`/`*_at`
// function taking a plain `&Path`, which is what makes these runnable.

use super::{
    literature_attachment_status_at, literature_import_pdf_as_record_core,
    literature_rag_index_library_core, resolve_attachment_path_at,
};

/// Smallest byte sequence `import_pdf_at` accepts as a PDF. Text extraction
/// fails on it, which is deliberate here: it drives the "nothing could be
/// inferred" branch of the title precedence.
const STUB_PDF: &[u8] = b"%PDF-1.4\n";

fn stub_pdf_at(directory: &std::path::Path, name: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(directory).expect("create source dir");
    let path = directory.join(name);
    std::fs::write(&path, STUB_PDF).expect("write stub pdf");
    path
}

/// With nothing inferable from the file's contents, the record is named after
/// the file stem — and `titleInferred` must say so, because the UI shows a
/// badge that invites the user to correct an inferred name.
#[test]
fn an_unreadable_pdf_falls_back_to_the_file_stem_and_claims_no_inference() {
    let base = temp_base("import-fallback");
    let source = stub_pdf_at(&base.join("incoming"), "Attention Is All You Need.pdf");

    let report = literature_import_pdf_as_record_core(&base, &source, None).expect("import");

    assert_eq!(report["metadata"]["titleInferred"], false);
    assert_eq!(report["metadata"]["doi"], serde_json::Value::Null);
}

/// A supplied title wins over everything, and `titleInferred` stays false even
/// though inference also ran.
#[test]
fn a_supplied_title_wins_and_is_never_reported_as_inferred() {
    let base = temp_base("import-supplied");
    let source = stub_pdf_at(&base.join("incoming"), "raw-download-slug.pdf");

    let report = literature_import_pdf_as_record_core(&base, &source, Some("A Chosen Title"))
        .expect("import");

    assert_eq!(report["metadata"]["titleInferred"], false);
    assert!(report["record"].is_object());
}

/// The import report carries only ids, so titles are read back from the
/// library projection — which is also what the UI renders.
fn library_titles(base: &std::path::Path) -> Vec<String> {
    tools::literature::library_load_at(base)
        .expect("library projection")["papers"]
        .as_array()
        .expect("papers")
        .iter()
        .filter_map(|paper| paper["title"].as_str().map(str::to_string))
        .collect()
}

/// The dialog hands back `Some("")` when the user clears the title field. That
/// must fall through to inference / the file stem rather than name the record
/// after an empty string.
#[test]
fn a_blank_supplied_title_falls_through_instead_of_naming_the_record_empty() {
    let base = temp_base("import-blank");
    let source = stub_pdf_at(&base.join("incoming"), "meaningful-stem.pdf");

    literature_import_pdf_as_record_core(&base, &source, Some("   ")).expect("import");

    let titles = library_titles(&base);
    assert_eq!(titles, vec!["meaningful-stem".to_string()]);
    let _ = std::fs::remove_dir_all(&base);
}

/// The precedence itself, end to end: a supplied title reaches the library,
/// a blank one does not.
#[test]
fn a_supplied_title_reaches_the_library_verbatim() {
    let base = temp_base("import-title-precedence");
    let source = stub_pdf_at(&base.join("incoming"), "raw-download-slug.pdf");

    literature_import_pdf_as_record_core(&base, &source, Some("A Chosen Title")).expect("import");

    assert_eq!(library_titles(&base), vec!["A Chosen Title".to_string()]);
    let _ = std::fs::remove_dir_all(&base);
}

/// The attachment boundary. Every one of these must be refused before it ever
/// reaches the filesystem, or "open this attachment" becomes "open any file".
#[test]
fn attachment_paths_cannot_escape_the_literature_library() {
    let base = temp_base("attachment-escape");
    for hostile in [
        "../../../../Windows/System32/drivers/etc/hosts",
        "..",
        "papers/../../secrets.txt",
    ] {
        assert!(
            resolve_attachment_path_at(&base, hostile).is_err(),
            "escaping path was accepted: {hostile}"
        );
    }
    // An absolute path is rejected by the same lexical gate.
    let absolute = base.join(".somniq/papers/paper.pdf");
    assert!(resolve_attachment_path_at(&base, &absolute.to_string_lossy()).is_err());
}

/// A status probe is total: nothing it can be handed produces an error, only
/// "not there". A row the user merely scrolled past must not raise a toast.
#[test]
fn attachment_status_reports_absence_rather_than_failing() {
    let base = temp_base("attachment-status");
    for input in ["", "   ", "../escape.pdf", ".somniq/papers/missing.pdf"] {
        let status = literature_attachment_status_at(&base, input);
        assert!(!status.exists, "unexpectedly reported present: {input:?}");
        assert!(status.bytes.is_none());
    }

    let present = base.join(".somniq/papers/present.pdf");
    std::fs::write(&present, STUB_PDF).expect("write pdf");
    let status = literature_attachment_status_at(&base, ".somniq/papers/present.pdf");
    assert!(status.exists);
    assert_eq!(status.bytes, Some(STUB_PDF.len() as u64));
}

/// A directory is not an attachment, even though it exists.
#[test]
fn attachment_status_does_not_mistake_a_directory_for_a_file() {
    let base = temp_base("attachment-directory");
    std::fs::create_dir_all(base.join(".somniq/papers/folder")).expect("create dir");
    let status = literature_attachment_status_at(&base, ".somniq/papers/folder");
    assert!(!status.exists);
}

/// The library indexer's contract: one document that cannot be prepared is
/// recorded and the batch continues. Here *every* record fails (no LiteParse
/// bridge is supplied, and the stub PDFs carry no extractable text), which is
/// the strongest form of the check — the run must still complete and account
/// for all of them instead of aborting on the first.
#[test]
fn a_failing_document_is_recorded_without_aborting_the_library_run() {
    let base = temp_base("rag-index-isolation");
    for name in ["first.pdf", "second.pdf", "third.pdf"] {
        let source = stub_pdf_at(&base.join("incoming"), name);
        literature_import_pdf_as_record_core(&base, &source, None).expect("seed record");
    }

    let summary = tauri::async_runtime::block_on(literature_rag_index_library_core(
        base.clone(),
        None,
        false,
    ))
    .expect("library run completes despite per-document failures");

    let total = summary["total"].as_u64().expect("total");
    assert_eq!(total, 3, "all seeded records should be visited");
    let failed = summary["failed"].as_u64().expect("failed");
    let indexed = summary["indexed"].as_u64().expect("indexed");
    let skipped = summary["skipped"].as_u64().expect("skipped");
    // Whatever the outcome per document, the accounting must be complete —
    // a silently dropped record would show up here as a gap.
    assert_eq!(indexed + skipped + failed, total);
    assert_eq!(
        summary["failures"].as_array().expect("failures").len() as u64,
        failed
    );
    assert_eq!(
        summary["results"].as_array().expect("results").len() as u64,
        indexed + skipped
    );
    let _ = std::fs::remove_dir_all(&base);
}

/// A run that ends without a terminal phase leaves the UI's progress panel
/// waiting on a request that already finished — the same silent-hang shape as
/// a stream that never reports its own failure. Both outcomes must produce
/// exactly one.
#[test]
fn every_run_outcome_produces_a_terminal_phase() {
    let (phase, text, model) =
        super::terminal_progress(&Ok(("answer".to_string(), "gpt-5.6".to_string())));
    assert_eq!(phase, "completed");
    assert!(text.is_none());
    assert_eq!(model.as_deref(), Some("gpt-5.6"));

    let (phase, text, model) = super::terminal_progress(&Err("gateway refused".to_string()));
    assert_eq!(phase, "failed");
    // The failure must carry its reason: a bare "failed" phase tells the user
    // nothing and is what a raw stream error used to degrade into.
    assert_eq!(text.as_deref(), Some("gateway refused"));
    assert!(model.is_none());
}

/// The recording sink is the seam a non-Tauri host would slot into. Asserting
/// on it here also pins the event's wire fields, which the UI reads by name.
#[test]
fn progress_events_carry_their_request_id_phase_and_payload() {
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = super::ProgressSink::Recording(events.clone());

    sink_emit(&sink, "req-1", "started", Some("preparing"), Some("gpt-5.6"));
    sink_emit(&sink, "req-1", "text", Some("hello"), None);
    sink_emit(&sink, "req-1", "completed", None, Some("gpt-5.6"));

    let recorded = events.lock().expect("events");
    let phases = recorded
        .iter()
        .map(|event| event.phase.as_str())
        .collect::<Vec<_>>();
    assert_eq!(phases, ["started", "text", "completed"]);
    assert!(recorded.iter().all(|event| event.request_id == "req-1"));
    assert_eq!(recorded[1].text.as_deref(), Some("hello"));
    assert_eq!(recorded[2].model.as_deref(), Some("gpt-5.6"));
}

fn sink_emit(
    sink: &super::ProgressSink,
    request_id: &str,
    phase: &str,
    text: Option<&str>,
    model: Option<&str>,
) {
    super::emit_llm_progress(
        sink,
        request_id,
        phase,
        text.map(str::to_string),
        model.map(str::to_string),
    );
}

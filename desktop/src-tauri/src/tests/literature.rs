#[cfg(windows)]
use super::{extract_pdf_text_by_page, literature_image_ocr, windows_ocr};
use super::{
    import_attachment_at, import_pdf_at, resolve_pdf_path_at, validate_vision_model, vision_message,
    LiteratureVisionImage,
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
    std::fs::create_dir_all(base.join("papers")).expect("create papers");
    base
}

#[test]
fn pdf_paths_are_limited_to_library_and_studio_results() {
    let base = temp_base("paths");
    std::fs::write(base.join("papers/paper.pdf"), b"%PDF-1.4").expect("write pdf");
    std::fs::write(base.join("papers/notes.txt"), b"notes").expect("write text");
    std::fs::write(base.join("outside.pdf"), b"%PDF-1.4").expect("write outside pdf");

    assert!(resolve_pdf_path_at(&base, "papers/paper.pdf").is_ok());
    std::fs::create_dir_all(base.join("slides")).expect("slides dir");
    std::fs::write(base.join("slides/main.pdf"), b"%PDF-1.7").expect("slides pdf");
    assert!(resolve_pdf_path_at(&base, "slides/main.pdf").is_ok());
    std::fs::create_dir_all(base.join("studio")).expect("studio dir");
    std::fs::write(base.join("studio/slides.pdf"), b"%PDF-1.7").expect("studio pdf");
    assert!(resolve_pdf_path_at(&base, "studio/slides.pdf").is_ok());
    assert!(resolve_pdf_path_at(&base, "papers/notes.txt").is_err());
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
    assert_eq!(imported.relative_path, "papers/My-Paper.pdf");
    assert!(base.join("papers/My-Paper.pdf").exists());
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
    assert!(imported.relative_path.starts_with("papers/attachments/"));
    assert_eq!(std::fs::read(base.join(&imported.relative_path)).expect("read copied attachment"), b"sample,value\nA,1\n");

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

#[cfg(windows)]
#[test]
fn extracts_a_scanned_pdf_with_windows_ocr_when_poppler_is_available() {
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
    if !source.is_ok_and(|status| status.success()) {
        let _ = std::fs::remove_dir_all(base);
        return;
    }
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
    if !rendered.success() || windows_ocr(&base.join("scan.png")).is_err() {
        let _ = std::fs::remove_dir_all(base);
        return;
    }
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

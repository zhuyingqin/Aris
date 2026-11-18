use super::*;

#[test]
fn page_specs_accept_lists_ranges_and_full_width_separators() {
    assert_eq!(parse_page_spec("3").unwrap(), vec![3]);
    assert_eq!(parse_page_spec("1-4").unwrap(), vec![1, 2, 3, 4]);
    assert_eq!(parse_page_spec("7-8, 2，5").unwrap(), vec![2, 5, 7, 8]);
    assert_eq!(parse_page_spec("2,2,1").unwrap(), vec![1, 2]);
    assert!(parse_page_spec("0").is_err());
    assert!(parse_page_spec("5-3").is_err());
    assert!(parse_page_spec("abc").is_err());
    assert!(parse_page_spec(" , ").is_err());
}

#[test]
fn page_lists_compress_to_ranges() {
    assert_eq!(format_page_list(&[1, 2, 3, 5, 7, 8]), "1-3,5,7-8");
    assert_eq!(format_page_list(&[4]), "4");
}

#[test]
fn ocr_spaces_between_cjk_characters_are_removed_but_latin_spacing_kept() {
    assert_eq!(
        collapse_cjk_spaces("大 语 言 模 型 （ LLM ） 能 否 理 解 time series ？"),
        "大语言模型（ LLM ）能否理解 time series ？"
    );
    assert_eq!(collapse_cjk_spaces("plain English text"), "plain English text");
}

fn sample_output() -> PdfPagesOutput {
    PdfPagesOutput {
        kind: OUTPUT_KIND.to_string(),
        file_path: "C:/papers/review.pdf".to_string(),
        page_count: Some(9),
        renderer: "the Windows PDF renderer".to_string(),
        dpi: 130,
        pages: vec![
            RenderedPdfPage {
                page: 1,
                media_type: "image/png".to_string(),
                bytes: 3,
                base64: "AAAA".to_string(),
                ocr_text: Some("审稿意见一".to_string()),
            },
            RenderedPdfPage {
                page: 2,
                media_type: "image/png".to_string(),
                bytes: 3,
                base64: "BBBB".to_string(),
                ocr_text: None,
            },
        ],
        ocr_engine: Some("Windows OCR".to_string()),
        warnings: vec!["example warning".to_string()],
        remaining_pages: Some("5-9".to_string()),
    }
}

#[test]
fn lift_moves_page_images_into_media_and_keeps_ocr_as_text() {
    let raw = serde_json::to_string(&sample_output()).unwrap();
    let lifted = lift_pdf_page_media(READ_PDF_PAGES_TOOL, ToolOutput::text(raw));
    assert_eq!(
        lifted.media,
        vec![
            ToolMedia::Image { media_type: "image/png".into(), data: "AAAA".into() },
            ToolMedia::Image { media_type: "image/png".into(), data: "BBBB".into() },
        ]
    );
    assert!(!lifted.text.contains("AAAA"), "base64 must not stay in the text channel");
    assert!(lifted.text.contains("Rendered page(s) 1-2"));
    assert!(lifted.text.contains("(9 pages)"));
    assert!(lifted.text.contains("5-9"));
    assert!(lifted.text.contains("--- Page 1 OCR ---\n审稿意见一"));
    assert!(lifted.text.contains("Warning: example warning"));
    assert_eq!(lifted.evidence_text.as_deref(), Some(lifted.text.as_str()));

    // Lifting twice (desktop executor, then conversation runtime) is a no-op.
    let again = lift_pdf_page_media(READ_PDF_PAGES_TOOL, lifted.clone());
    assert_eq!(again, lifted);
}

#[test]
fn lift_ignores_other_tools_and_unrelated_json() {
    let raw = serde_json::to_string(&sample_output()).unwrap();
    let other = lift_pdf_page_media("read_file", ToolOutput::text(raw.clone()));
    assert_eq!(other.text, raw);
    assert!(other.media.is_empty());
    let unrelated = ToolOutput::text(r#"{"base64":"x"}"#);
    assert_eq!(lift_pdf_page_media(READ_PDF_PAGES_TOOL, unrelated.clone()), unrelated);
}

/// A two-page PDF with a line of Helvetica text on each page.
fn two_page_pdf() -> Vec<u8> {
    let page = |text: &str| format!("BT /F1 36 Tf 72 700 Td ({text}) Tj ET").into_bytes();
    let streams = [page("SomniQ page one"), page("SomniQ page two")];
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>".to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
    ];
    for content in streams {
        let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        stream.extend_from_slice(&content);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
    }
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend_from_slice(object);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes());
    for offset in &offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1).as_bytes(),
    );
    pdf
}

/// Exercises the real built-in Windows renderer and OCR engine end to end.
#[cfg(windows)]
#[test]
fn windows_renders_requested_pages_to_png_with_ocr_text() {
    let dir = std::env::temp_dir().join(format!("somniq-pdf-render-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("两页 sample.pdf");
    std::fs::write(&path, two_page_pdf()).unwrap();

    let output = read_pdf_pages(
        &ReadPdfPagesInput {
            path: path.to_string_lossy().into_owned(),
            pages: Some("2-3".to_string()),
            dpi: Some(96),
            ocr: true,
        },
        &|| false,
    )
    .expect("render");
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(output.page_count, Some(2));
    assert_eq!(output.pages.len(), 1, "page 3 does not exist: {:?}", output.warnings);
    let page = &output.pages[0];
    assert_eq!(page.page, 2);
    let png = BASE64_STANDARD.decode(&page.base64).unwrap();
    assert!(png.starts_with(b"\x89PNG"), "not a PNG");
    assert!(output.warnings.iter().any(|warning| warning.contains("has 2 pages")));
    // OCR needs a language pack; when present it must read the page's text.
    if let Some(text) = &page.ocr_text {
        assert!(text.to_lowercase().contains("page two"), "{text}");
    }
}

#[test]
fn non_pdf_files_are_rejected_before_any_renderer_runs() {
    let dir = std::env::temp_dir().join(format!("somniq-pdf-render-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notes.pdf");
    std::fs::write(&path, b"just text").unwrap();
    let error = ensure_pdf(&path).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    std::fs::write(&path, b"%PDF-1.7\n").unwrap();
    assert!(ensure_pdf(&path).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

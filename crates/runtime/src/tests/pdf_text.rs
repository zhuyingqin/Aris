use super::*;
use lopdf::dictionary;

fn encoded_pdf(content: &[u8], encoding: &str) -> Vec<u8> {
    let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
    stream.extend_from_slice(content);
    stream.extend_from_slice(b"\nendstream");
    let objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_vec(),
        format!("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding {encoding} >>").into_bytes(),
        stream,
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend_from_slice(object);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in &offsets[1..] {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    pdf
}

#[test]
fn embedded_type1_encoding_preserves_numbers_instead_of_reading_raw_codes() {
    // The scanner reads raw glyph codes as `123`. The font says they mean `789`.
    let pdf = encoded_pdf(
        b"BT /F1 12 Tf 72 720 Td (Journal 123) Tj ET",
        "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [49 /seven /eight /nine] >>",
    );
    let legacy = crate::file_ops::extract_pdf_text_legacy(&pdf).expect("legacy text");
    assert!(legacy.contains("Journal 123"));
    let extracted = extract_pdf_text_with_quality(&pdf).expect("PDF");
    assert!(extracted.text.contains("Journal 789"), "{extracted:?}");
    assert!(!extracted.text.contains("Journal 123"));
    assert_eq!(extracted.metadata.quality, PdfTextQuality::Readable);
    assert_eq!(extracted.metadata.method, "pdf_extract");
    assert!(!extracted.metadata.exact_content_verified);
}

#[test]
fn malformed_pdf_keeps_useful_text_but_cannot_claim_confirmed_extraction() {
    let pdf = b"%PDF-1.4\n1 0 obj\n<< /Length 42 >>\nstream\nBT (Fallback text) Tj ET\nendstream\nendobj\n%%EOF";
    let extracted = extract_pdf_text_with_quality(pdf).expect("PDF fallback");
    assert_eq!(extracted.text, "Fallback text");
    assert_eq!(extracted.metadata.quality, PdfTextQuality::Unconfirmed);
    assert_eq!(extracted.metadata.method, "legacy_fallback");
    assert!(extracted
        .text_for_reading()
        .contains("PDF text quality: unconfirmed"));
    assert!(extract_pdf_text_from_bytes(pdf)
        .expect("compatibility text")
        .contains("unconfirmed"));
}

#[test]
fn scanned_or_empty_pdf_directs_the_reader_to_page_view_or_ocr() {
    let pdf = encoded_pdf(b"", "/WinAnsiEncoding");
    let extracted = extract_pdf_text_with_quality(&pdf).expect("PDF");
    assert_eq!(extracted.metadata.quality, PdfTextQuality::NoText);
    assert!(extracted.text_for_reading().contains("local OCR"));
    assert_eq!(extract_pdf_text_with_quality(b"not a PDF"), None);
}

#[test]
fn a_text_page_does_not_hide_a_second_page_without_a_text_layer() {
    let mut document = lopdf::Document::load_mem(&encoded_pdf(
        b"BT /F1 12 Tf 72 720 Td (Readable first page) Tj ET",
        "/WinAnsiEncoding",
    ))
    .expect("fixture PDF");
    let stream = document.add_object(lopdf::Stream::new(lopdf::Dictionary::new(), Vec::new()));
    let page = document.add_object(lopdf::dictionary! {
        "Type" => "Page",
        "Parent" => (2, 0),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => lopdf::Dictionary::new(),
        "Contents" => stream,
    });
    let pages = document
        .get_object_mut((2, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap();
    pages.set("Count", 2);
    pages
        .get_mut(b"Kids")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(page.into());
    let mut pdf = Vec::new();
    document.save_to(&mut pdf).expect("serialize mixed PDF");
    let extracted = extract_pdf_text_with_quality(&pdf).expect("PDF");
    assert!(extracted.text.contains("Readable first page"));
    assert_eq!(extracted.metadata.page_count, Some(2));
    assert_eq!(extracted.metadata.pages_without_text, vec![2]);
    assert_eq!(extracted.metadata.quality, PdfTextQuality::Unconfirmed);
    assert!(extracted.text_for_reading().contains("complete coverage"));
}

#[test]
fn quality_check_accepts_multilingual_math_and_flags_damaged_mapping() {
    assert!(!has_suspicious_text(
        "持续学习：α ∈ ℝ，‖C‖₂ < 1. θ = 0.5; ∇f(x)."
    ));
    assert!(!has_suspicious_text(
        "This is readable English, 日本語 and العربية."
    ));
    assert!(has_suspicious_text("A \u{fffd}B\u{fffd}C\u{fffd} title"));
    assert!(has_suspicious_text("A \u{e001}\u{e002}\u{e003} equation"));
}

#[test]
fn file_read_windows_always_carry_pdf_quality_metadata() {
    let _lock = crate::test_env_lock();
    let root = tempfile::tempdir().expect("temp PDF");
    struct RestoreWorkspace(Option<std::ffi::OsString>);
    impl Drop for RestoreWorkspace {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("ARIS_WORKSPACE_ROOT", value),
                None => std::env::remove_var("ARIS_WORKSPACE_ROOT"),
            }
        }
    }
    let _env = RestoreWorkspace(std::env::var_os("ARIS_WORKSPACE_ROOT"));
    std::env::set_var("ARIS_WORKSPACE_ROOT", root.path());
    let path = root.path().join("paper.pdf");
    std::fs::write(
        &path,
        encoded_pdf(
            b"BT /F1 12 Tf 72 720 Td (First line) Tj T* (Second line) Tj ET",
            "/WinAnsiEncoding",
        ),
    )
    .expect("write PDF");
    let output =
        crate::read_file(path.to_str().expect("path"), Some(1), Some(1)).expect("read PDF window");
    let metadata = output
        .pdf_extraction
        .expect("quality accompanies every window");
    assert_eq!(metadata.method, "pdf_extract");
    assert!(!metadata.exact_content_verified);
    assert!(metadata.verification_hint.contains("rendered PDF page"));
}

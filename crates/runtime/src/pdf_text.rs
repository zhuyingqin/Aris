//! Shared PDF text extraction for local file tools and downloaded documents.
//! Readable text is not a visual verification of equations or exact quotes.

use serde::{Deserialize, Serialize};

const MAX_TEXT_PAGES: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfTextQuality {
    Readable,
    Unconfirmed,
    NoText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtractionMetadata {
    pub method: String,
    pub quality: PdfTextQuality,
    pub warnings: Vec<String>,
    pub page_count: Option<usize>,
    pub pages_without_text: Vec<u32>,
    /// A text layer cannot certify layout, formula structure, or glyph identity.
    pub exact_content_verified: bool,
    pub verification_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfTextExtraction {
    pub text: String,
    pub metadata: PdfExtractionMetadata,
}

impl PdfTextExtraction {
    /// Keep a quality warning inside the model-visible content too: callers
    /// that retain only the text must not turn a fallback into trusted evidence.
    #[must_use]
    pub fn text_for_reading(&self) -> String {
        match self.metadata.quality {
            PdfTextQuality::Readable => self.text.clone(),
            PdfTextQuality::NoText => "[PDF text extraction found no readable text. Use a rendered page view or local OCR; do not infer the document's contents from this result.]".to_string(),
            PdfTextQuality::Unconfirmed => format!(
                "[PDF text quality: unconfirmed. {} Verify the rendered pages or use another extractor before quoting formulas, numbers, or exact wording.]\n\n{}",
                self.metadata.warnings.join(" "),
                self.text
            ),
        }
    }
}

/// The same bundled extractor used by the desktop literature library, including
/// Type 1 encodings, per-page font resources, object streams and compressed xrefs.
/// The old stream scanner remains a best-effort fallback for damaged documents;
/// its results are always explicitly unconfirmed.
#[must_use]
pub fn extract_pdf_text_with_quality(bytes: &[u8]) -> Option<PdfTextExtraction> {
    if !bytes.starts_with(b"%PDF") {
        return None;
    }
    // Unsupported fonts/content can panic in the upstream extractor. Preserve
    // the conversation and disclose the fallback rather than losing the turn.
    let extracted = std::panic::catch_unwind(|| extract_by_page(bytes));
    let (text, method, mut warnings, page_count, pages_without_text) = match extracted {
        Ok(Ok(extraction)) => (extraction.text, "pdf_extract", extraction.warnings, Some(extraction.page_count), extraction.pages_without_text),
        Ok(Err(_)) | Err(_) => (
            crate::file_ops::extract_pdf_text_legacy(bytes).unwrap_or_default(),
            "legacy_fallback",
            vec!["The bundled PDF extractor could not decode this document; the simplified fallback may misread font encodings or omit content.".to_string()],
            None,
            Vec::new(),
        ),
    };
    let text = text.replace('\0', "").trim().to_string();
    if has_suspicious_text(&text) {
        warnings
            .push("The extracted text contains signs of damaged character mapping.".to_string());
    }
    let quality = if text.is_empty() {
        PdfTextQuality::NoText
    } else if warnings.is_empty() {
        PdfTextQuality::Readable
    } else {
        PdfTextQuality::Unconfirmed
    };
    Some(PdfTextExtraction {
        text,
        metadata: PdfExtractionMetadata {
            method: method.to_string(),
            quality,
            warnings,
            page_count,
            pages_without_text,
            exact_content_verified: false,
            verification_hint: "Text-layer extraction only. Check the rendered PDF page before claiming exact verification of formulas, numeric values, or quotations.".to_string(),
        },
    })
}

struct PageExtraction {
    text: String,
    page_count: usize,
    pages_without_text: Vec<u32>,
    warnings: Vec<String>,
}

fn extract_by_page(bytes: &[u8]) -> Result<PageExtraction, String> {
    let mut document = lopdf::Document::load_mem(bytes).map_err(|error| error.to_string())?;
    if document.is_encrypted() {
        document.decrypt("").map_err(|error| error.to_string())?;
    }
    let pages = document.get_pages();
    if pages.is_empty() {
        return Err("PDF contains no readable page tree".to_string());
    }
    let mut result = PageExtraction {
        text: String::new(),
        page_count: pages.len(),
        pages_without_text: Vec::new(),
        warnings: Vec::new(),
    };
    if pages.len() > MAX_TEXT_PAGES {
        result.warnings.push(format!(
            "Only the first {MAX_TEXT_PAGES} of {} pages were extracted.",
            pages.len()
        ));
    }
    for page in pages.keys().take(MAX_TEXT_PAGES) {
        // This closure only reads the already-decrypted document. A fresh
        // processor/output is created per page, so no partial output escapes.
        let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut text = String::new();
            let mut output = pdf_extract::PlainTextOutput::new(&mut text);
            pdf_extract::output_doc_page(&document, &mut output, *page)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(text.replace('\0', "").trim().to_string())
        }));
        match extracted {
            Ok(Ok(text)) if !text.is_empty() => {
                if !result.text.is_empty() {
                    result.text.push_str("\n\n");
                }
                result.text.push_str(&text);
            }
            Ok(Ok(_)) => result.pages_without_text.push(*page),
            Ok(Err(_)) | Err(_) => {
                result.pages_without_text.push(*page);
                result.warnings.push(format!(
                    "Page {page} could not be decoded by the bundled extractor."
                ));
            }
        }
    }
    if !result.pages_without_text.is_empty() {
        result.warnings.push(format!("Pages {:?} have no readable text; they may be blank, scanned, or unsupported. Check their rendered pages before claiming complete coverage.", result.pages_without_text));
    }
    if result.text.is_empty()
        && result
            .warnings
            .iter()
            .any(|warning| warning.contains("could not be decoded"))
    {
        return Err("All text pages failed to decode".to_string());
    }
    Ok(result)
}

/// Compatibility entry point. Its string also preserves fallback warnings.
#[must_use]
pub fn extract_pdf_text_from_bytes(bytes: &[u8]) -> Option<String> {
    extract_pdf_text_with_quality(bytes).map(|extraction| extraction.text_for_reading())
}

fn has_suspicious_text(text: &str) -> bool {
    let mut characters = 0usize;
    let mut damaged = 0usize;
    for character in text.chars() {
        if character.is_whitespace() {
            continue;
        }
        characters += 1;
        if character == '\u{fffd}'
            || character.is_control()
            || matches!(character, '\u{e000}'..='\u{f8ff}' | '\u{f0000}'..='\u{ffffd}' | '\u{100000}'..='\u{10fffd}')
        {
            damaged += 1;
        }
    }
    // Ordinary mathematical symbols and multilingual prose are not corruption.
    damaged >= 3 && damaged.saturating_mul(100) >= characters
}

#[cfg(test)]
#[path = "tests/pdf_text.rs"]
mod tests;

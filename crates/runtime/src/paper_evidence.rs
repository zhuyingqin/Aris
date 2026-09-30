//! Deterministic evidence planning for paper guides.
//!
//! The PDF's own text layer already tells us where figures, tables, numbered
//! equations and the reference list are. Using it keeps page selection free
//! of model calls and lets the outline budget favour the paper body instead of
//! truncating every page (and the reference list) to the same length.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::paper_reading::{has_text_layer, ContentKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PageRole {
    Body,
    References,
    Appendix,
}

impl PageRole {
    fn text_weight(self) -> f64 {
        match self {
            Self::Body => 1.0,
            Self::Appendix => 0.4,
            Self::References => 0.0,
        }
    }

    fn image_weight(self) -> f64 {
        match self {
            Self::Body => 1.0,
            Self::Appendix => 0.3,
            Self::References => 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSignals {
    /// One-based page number, as displayed in the reader.
    pub page: usize,
    pub role: PageRole,
    pub has_text_layer: bool,
    pub figure_captions: usize,
    pub table_captions: usize,
    pub equation_numbers: usize,
    /// Up to three original caption lines, to help choose topic pages.
    pub captions: Vec<String>,
    /// Character offset where the reference list starts on this page.
    #[serde(skip)]
    pub body_end: Option<usize>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static paper evidence pattern"))
}

fn references_heading(line: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:References|REFERENCES|Reference|Bibliography|BIBLIOGRAPHY|Literature Cited|参考文献)\s*[:：]?\s*$",
    )
    .is_match(line)
}

fn appendix_heading(line: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    let trimmed = line.trim();
    trimmed.chars().count() <= 60
        && !trimmed.ends_with('.')
        && regex(
            &CELL,
            r"^(?:[A-Z]\.?\s+)?(?:Appendix|APPENDIX|Appendices|APPENDICES|Supplementary Materials?|SUPPLEMENTARY MATERIALS?|附录)(?:\s|$|[:：.A-Z0-9])",
        )
        .is_match(trimmed)
}

fn figure_caption(line: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"^\s*(?:(?:Figure|FIGURE|Fig\.|FIG\.)\s*\d+[a-z]?\s*[:.：|]|图\s*\d+(?:[\s:：.]|$))",
    )
    .is_match(line)
}

fn table_caption(line: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(
        &CELL,
        r"^\s*(?:(?:Table|TABLE)\s*(?:\d+[a-z]?|[IVX]+)\s*[:.：|]|(?:Table|TABLE)\s+[IVX]+\s*$|表\s*\d+(?:[\s:：.]|$))",
    )
    .is_match(line)
}

fn equation_number(line: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    let trimmed = line.trim();
    let length = trimmed.chars().count();
    if length > 160 || !regex(&CELL, r"\(\s*\d{1,3}[a-z]?\s*\)$").is_match(trimmed) {
        return false;
    }
    length <= 8 || trimmed.chars().any(|c| "=≈≤≥<>∑∏∫√∈→∀∃∝∇∂·×".contains(c))
}

/// Analyse the original embedded text of every page, in page order.
#[must_use]
pub fn analyze_pages(texts: &[&str]) -> Vec<PageSignals> {
    let mut state = PageRole::Body;
    texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let mut signals = PageSignals {
                page: index + 1,
                role: state,
                has_text_layer: has_text_layer(text),
                figure_captions: 0,
                table_captions: 0,
                equation_numbers: 0,
                captions: Vec::new(),
                body_end: None,
            };
            let mut offset = 0;
            for line in text.split('\n') {
                let line_chars = line.chars().count();
                if state == PageRole::Body && references_heading(line) {
                    signals.body_end = Some(offset);
                    state = PageRole::References;
                } else if state != PageRole::Appendix && appendix_heading(line) {
                    state = PageRole::Appendix;
                    if signals.role == PageRole::References {
                        signals.role = PageRole::Appendix;
                    }
                } else if figure_caption(line) || table_caption(line) {
                    if figure_caption(line) {
                        signals.figure_captions += 1;
                    } else {
                        signals.table_captions += 1;
                    }
                    if signals.captions.len() < 3 {
                        signals
                            .captions
                            .push(line.trim().chars().take(160).collect());
                    }
                } else if equation_number(line) {
                    signals.equation_numbers += 1;
                }
                offset += line_chars + 1;
            }
            // A reference list rarely has captions or numbered equations; an
            // unlabeled appendix after the references usually does.
            if signals.role == PageRole::References
                && signals.figure_captions + signals.table_captions + signals.equation_numbers >= 2
            {
                signals.role = PageRole::Appendix;
                state = PageRole::Appendix;
            }
            signals
        })
        .collect()
}

pub struct PageText<'a> {
    /// One-based page number.
    pub page: usize,
    pub text: &'a str,
    /// A model transcription of a page without a text layer. It can help the
    /// outline find content but is labelled as derived, never as original.
    pub derived: bool,
    pub role: PageRole,
    pub body_end: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedText {
    pub page: usize,
    pub text: String,
    pub truncated: bool,
    pub derived: bool,
}

/// Keep the start and the end of a page; the middle is summarised by a marker
/// so a reader of the prompt knows content was omitted.
#[must_use]
pub fn truncate_middle(text: &str, limit: usize) -> (String, bool) {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= limit {
        return (text.to_owned(), false);
    }
    if limit == 0 {
        return (String::new(), true);
    }
    let head = limit * 2 / 3;
    let tail = limit - head;
    let omitted = chars.len() - head - tail;
    let mut result = chars[..head].iter().collect::<String>();
    result.push_str(&format!(
        "\n[… {omitted} characters omitted from the middle of this page …]\n"
    ));
    result.extend(chars[chars.len() - tail..].iter());
    (result, true)
}

/// Water-filling allocation: short pages keep all their text and the unused
/// share flows to long pages, weighted so the paper body gets more room than
/// the appendix. Reference lists are excluded.
#[must_use]
pub fn allocate_text(pages: &[PageText<'_>], budget: usize) -> Vec<AllocatedText> {
    let mut candidates = pages
        .iter()
        .filter_map(|page| {
            let body = page.body_end.map_or(page.text.to_owned(), |end| {
                page.text.chars().take(end).collect::<String>()
            });
            let demand = body.chars().count();
            let weight = page.role.text_weight();
            (weight > 0.0 && !body.trim().is_empty()).then_some((page, body, demand, weight))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        (a.2 as f64 / a.3)
            .partial_cmp(&(b.2 as f64 / b.3))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut remaining_budget = budget as f64;
    let mut remaining_weight = candidates.iter().map(|item| item.3).sum::<f64>();
    let mut allocated = Vec::with_capacity(candidates.len());
    for (page, body, demand, weight) in candidates {
        let share = if remaining_weight > 0.0 {
            remaining_budget * weight / remaining_weight
        } else {
            0.0
        };
        let limit = (demand as f64).min(share.max(0.0)).floor() as usize;
        remaining_budget -= limit as f64;
        remaining_weight -= weight;
        let (text, truncated) = truncate_middle(&body, limit);
        if !text.trim().is_empty() {
            allocated.push(AllocatedText {
                page: page.page,
                text,
                truncated,
                derived: page.derived,
            });
        }
    }
    allocated.sort_by_key(|item| item.page);
    allocated
}

/// Choose original page images for the outline: method figures, result tables
/// and derivation pages in the body first, then the title page.
#[must_use]
pub fn select_outline_images(
    signals: &[PageSignals],
    perceived: &[Option<BTreeSet<ContentKind>>],
    max: usize,
) -> Vec<usize> {
    let mut scored = signals
        .iter()
        .map(|page| {
            let mut score = if page.has_text_layer {
                (page.figure_captions * 8
                    + page.table_captions * 7
                    + page.equation_numbers.min(6) * 2) as f64
            } else {
                perceived
                    .get(page.page - 1)
                    .and_then(Option::as_ref)
                    .map_or(6.0, |kinds| {
                        kinds
                            .iter()
                            .map(|kind| match kind {
                                ContentKind::Figure | ContentKind::Table => 8.0,
                                ContentKind::Formula => 3.0,
                                ContentKind::Text => 0.5,
                            })
                            .sum()
                    })
            };
            if page.page == 1 {
                score += 5.0;
            }
            (page.page, score * page.role.image_weight())
        })
        .filter(|(_, score)| *score > 0.0)
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut pages = scored
        .into_iter()
        .take(max)
        .map(|(page, _)| page)
        .collect::<Vec<_>>();
    if pages.is_empty() && !signals.is_empty() {
        pages.push(1);
    }
    pages.sort_unstable();
    pages
}

#[cfg(test)]
#[path = "tests/paper_evidence.rs"]
mod tests;

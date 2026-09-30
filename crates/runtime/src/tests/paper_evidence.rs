use super::*;

fn body(extra: &str, length: usize) -> String {
    let mut text = format!("{extra}\n");
    while text.chars().count() < length {
        text.push_str("The method maps each token to a query, key and value vector. ");
    }
    text
}

#[test]
fn captions_equations_and_reference_lists_are_detected_from_original_text() {
    let method = body(
        "Figure 1: The Transformer - model architecture.\nAttention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V (1)",
        900,
    );
    let results = body(
        "Table 2: BLEU scores on newstest2014.\nTable 3: Variations.",
        900,
    );
    let conclusion = format!(
        "{}\nReferences\n[1] A. Author. A cited paper. 2017.",
        body("7 Conclusion", 600)
    );
    let references = body("[2] B. Author. Another paper. 2016.", 900);
    let appendix = body(
        "Appendix A\nFigure 5: Attention visualisation.\nx = y + z (7)",
        900,
    );
    let texts = [
        method.as_str(),
        results.as_str(),
        conclusion.as_str(),
        references.as_str(),
        appendix.as_str(),
    ];
    let signals = analyze_pages(&texts);
    assert_eq!(signals[0].figure_captions, 1);
    assert_eq!(signals[0].equation_numbers, 1);
    assert_eq!(signals[1].table_captions, 2);
    assert_eq!(signals[2].role, PageRole::Body);
    assert!(signals[2].body_end.is_some());
    assert_eq!(signals[3].role, PageRole::References);
    assert_eq!(signals[4].role, PageRole::Appendix);
    assert_eq!(signals[4].figure_captions, 1);
    assert!(signals[0].captions[0].starts_with("Figure 1"));
}

#[test]
fn outline_text_budget_favours_the_body_and_excludes_references() {
    let long = body("Method", 8_000);
    let short = body("Short page", 400);
    let references = body("[1] Reference entry", 8_000);
    let conclusion = format!(
        "{}\nReferences\n{}",
        body("Conclusion", 600),
        body("[3] Ref", 3_000)
    );
    let pages = [
        PageText {
            page: 1,
            text: &short,
            derived: false,
            role: PageRole::Body,
            body_end: None,
        },
        PageText {
            page: 2,
            text: &long,
            derived: false,
            role: PageRole::Body,
            body_end: None,
        },
        PageText {
            page: 3,
            text: &long,
            derived: false,
            role: PageRole::Appendix,
            body_end: None,
        },
        PageText {
            page: 4,
            text: &conclusion,
            derived: false,
            role: PageRole::Body,
            body_end: conclusion
                .find("References")
                .map(|byte| conclusion[..byte].chars().count()),
        },
        PageText {
            page: 5,
            text: &references,
            derived: false,
            role: PageRole::References,
            body_end: None,
        },
    ];
    let allocated = allocate_text(&pages, 6_000);
    let visible = |text: &str| match text.split_once("\n[… ") {
        Some((head, rest)) => {
            head.chars().count()
                + rest
                    .split_once("…]\n")
                    .map_or(0, |(_, tail)| tail.chars().count())
        }
        None => text.chars().count(),
    };
    let total = allocated
        .iter()
        .map(|item| visible(&item.text))
        .sum::<usize>();
    assert!(total <= 6_000, "allocated {total} characters");
    assert!(allocated.iter().all(|item| item.page != 5));
    let page = |number| allocated.iter().find(|item| item.page == number).unwrap();
    // Short pages keep all their text; the unused share flows to long pages.
    assert!(!page(1).truncated);
    assert!(!page(4).text.contains("[3] Ref"));
    assert!(page(2).truncated && page(3).truncated);
    assert!(page(2).text.chars().count() > page(3).text.chars().count());
    // Truncation keeps the end of the page, not only its opening lines.
    assert!(page(2).text.contains("characters omitted"));
    assert!(page(2).text.trim_end().ends_with("vector."));
}

#[test]
fn outline_images_prefer_body_figures_tables_and_textless_pages() {
    let texts = [
        body("Title and abstract", 900),
        body("Related work", 900),
        body("Figure 1: Architecture.", 900),
        String::new(),
        body("Table 1: Results.\nTable 2: Ablations.", 900),
        body("References", 900),
        body("[9] Entry", 900),
    ];
    let texts = texts.iter().map(String::as_str).collect::<Vec<_>>();
    let signals = analyze_pages(&texts);
    let perceived = vec![
        None,
        None,
        None,
        Some(BTreeSet::from([ContentKind::Figure])),
        None,
        None,
        None,
    ];
    let selected = select_outline_images(&signals, &perceived, 3);
    assert_eq!(selected, vec![3, 4, 5]);
    let wider = select_outline_images(&signals, &perceived, 8);
    assert!(wider.contains(&1));
    assert!(
        !wider.contains(&2),
        "text-only pages are not sent as images"
    );
    assert!(!wider.contains(&7), "reference pages are never selected");
}

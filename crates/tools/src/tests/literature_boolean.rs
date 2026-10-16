use super::{compile_for_source, matches_text, parse, BoolExpr};

const SYSTEMATIC: &str = "([continual learning] OR [lifelong learning] OR [catastrophic forgetting]) AND ([time series] OR [time-series]) AND [anomaly detection] AND NOT [survey]";

fn queries(source: &str, input: &str) -> Vec<String> {
    compile_for_source(&parse(input).expect("valid expression"), source)
        .into_iter()
        .map(|stream| stream.query)
        .collect()
}

#[test]
fn bare_words_form_one_term_and_groups_flatten() {
    assert_eq!(
        parse("time series AND (drift OR [concept shift])").expect("parse"),
        BoolExpr::And(vec![
            BoolExpr::Term("time series".to_string()),
            BoolExpr::Or(vec![
                BoolExpr::Term("drift".to_string()),
                BoolExpr::Term("concept shift".to_string()),
            ]),
        ])
    );
    assert_eq!(
        parse("[a] AND ([b] AND [c])").expect("parse"),
        BoolExpr::And(vec![
            BoolExpr::Term("a".to_string()),
            BoolExpr::Term("b".to_string()),
            BoolExpr::Term("c".to_string()),
        ])
    );
}

#[test]
fn lower_case_operators_are_content_words() {
    // `or` inside a phrase must not split it.
    assert_eq!(
        parse("[signal or noise]").expect("parse"),
        BoolExpr::Term("signal or noise".to_string())
    );
}

#[test]
fn malformed_expressions_are_rejected_before_any_request() {
    for (input, fragment) in [
        ("", "empty"),
        ("[a] AND", "term was expected"),
        ("([a] OR [b]", "unbalanced"),
        ("[a] OR [b])", "without its `(`"),
        ("NOT [a]", "NOT must follow AND"),
        ("[a] OR NOT [b]", "NOT must follow AND"),
        ("[a] [b]", "no AND/OR"),
        ("[a", "unclosed"),
        ("[]", "empty term"),
        ("[持续学习] AND [anomaly]", "not in English"),
    ] {
        let error = parse(input).expect_err(input);
        assert!(error.contains(fragment), "{input:?}: {error}");
    }
}

#[test]
fn boolean_sources_receive_one_stream_in_their_own_dialect() {
    assert_eq!(
        queries("scopus", SYSTEMATIC),
        vec![
            r#"TITLE-ABS-KEY(("continual learning" OR "lifelong learning" OR "catastrophic forgetting") AND ("time series" OR "time-series") AND "anomaly detection" AND NOT survey)"#
        ]
    );
    assert_eq!(
        queries("openalex", SYSTEMATIC),
        vec![
            r#"("continual learning" OR "lifelong learning" OR "catastrophic forgetting") AND ("time series" OR "time-series") AND "anomaly detection" NOT survey"#
        ]
    );
    assert_eq!(
        queries("arxiv", SYSTEMATIC),
        vec![
            r#"(all:"continual learning" OR all:"lifelong learning" OR all:"catastrophic forgetting") AND (all:"time series" OR all:"time-series") AND all:"anomaly detection" ANDNOT all:survey"#
        ]
    );
}

#[test]
fn bag_of_words_sources_rotate_synonyms_across_bounded_streams() {
    let streams = compile_for_source(&parse(SYSTEMATIC).expect("parse"), "crossref");
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.query.as_str())
            .collect::<Vec<_>>(),
        vec![
            "continual learning time series anomaly detection",
            "lifelong learning time-series anomaly detection",
            "catastrophic forgetting time series anomaly detection",
        ]
    );
    assert_eq!(streams[0].kind, "boolean");
    assert_eq!(streams[1].kind, "boolean_synonyms_1");
    // The dropped NOT is named rather than silently lost.
    assert!(streams[0]
        .rationale
        .contains("NOT clauses cannot be expressed"));

    let semantic = queries("semantic-scholar", SYSTEMATIC);
    assert_eq!(
        semantic[1],
        "lifelong learning time series anomaly detection"
    );
}

#[test]
fn bag_streams_are_capped_however_long_the_synonym_list() {
    let input = "[a] OR [b] OR [c] OR [d] OR [e] OR [f]";
    assert_eq!(queries("crossref", input).len(), 4);
}

#[test]
fn a_quote_inside_a_term_cannot_end_the_compiled_phrase() {
    assert_eq!(
        queries("scopus", r#"[deep "learning] AND [x]"#),
        vec![r#"TITLE-ABS-KEY("deep learning" AND x)"#]
    );
}

#[test]
fn unknown_sources_compile_to_nothing() {
    assert!(queries("pubmed", "[a] AND [b]").is_empty());
}

#[test]
fn local_matching_respects_blocks_word_boundaries_and_negation() {
    let expr = parse(SYSTEMATIC).expect("parse");
    assert!(matches_text(
        &expr,
        "Lifelong learning for anomaly detection in multivariate time-series"
    ));
    // `detection` alone is not the `anomaly detection` block.
    assert!(!matches_text(
        &expr,
        "Laparoscopic detection and resection of insulinomas"
    ));
    // Every AND block is required.
    assert!(!matches_text(
        &expr,
        "Continual learning for anomaly detection in images"
    ));
    // A negated term excludes the record.
    assert!(!matches_text(
        &expr,
        "A survey of continual learning for time series anomaly detection"
    ));
    // Terms match whole words only.
    assert!(!matches_text(
        &parse("[drift]").expect("parse"),
        "Driftwood decay"
    ));
}

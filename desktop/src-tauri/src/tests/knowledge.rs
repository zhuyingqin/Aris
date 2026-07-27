use super::{
    extract_json_array, parse_candidates, parse_points, project_evidence_search_output,
    project_evidence_search_tool_at, project_rag_answer_prompt, ProjectRagSearchResponse,
};

#[test]
fn extracts_json_array_from_fenced_reply() {
    let raw = "Here you go:\n```json\n[{\"question\":\"q\",\"answer\":\"a\",\
               \"statement\":\"s\",\"evidence\":[{\"paperId\":\"arxiv:1\",\"page\":2,\
               \"quote\":\"hello\"}]}]\n```\nDone.";
    let array = extract_json_array(raw).expect("array");
    assert!(array.is_array());
    assert_eq!(array.as_array().unwrap().len(), 1);
}

#[test]
fn drops_candidates_without_anchors_and_defaults_paper_id() {
    let raw = "[\
        {\"question\":\"q1\",\"answer\":\"a1\",\"statement\":\"s1\",\
         \"evidence\":[{\"paperId\":\"\",\"page\":3,\"quote\":\"grounded\"}]},\
        {\"question\":\"q2\",\"answer\":\"a2\",\"statement\":\"s2\",\"evidence\":[]}\
    ]";
    let (points, dropped) = parse_candidates(raw, "arxiv:42").expect("parse");
    assert_eq!(points.len(), 1);
    assert_eq!(
        dropped, 1,
        "the anchorless candidate should be counted as dropped"
    );
    assert_eq!(points[0].statement, "s1");
    assert_eq!(points[0].evidence[0].paper_id, "arxiv:42");
    assert_eq!(points[0].source_paper_id.as_deref(), Some("arxiv:42"));
}

#[test]
fn upsert_points_are_forced_to_draft_status() {
    // A caller must not be able to smuggle a `confirmed` status through the
    // drafts-only upsert path (promotion is `knowledge_confirm` only).
    let serde_json::Value::Array(items) = serde_json::json!([
        {"question": "q", "answer": "a", "statement": "s", "status": "confirmed", "evidence": []}
    ]) else {
        unreachable!("literal is an array")
    };
    let parsed = parse_points(items).expect("parse");
    assert_eq!(parsed.len(), 1);
    assert!(parsed[0].status.is_none());
}

#[test]
fn chat_evidence_search_rejects_missing_or_blank_queries_before_retrieval() {
    let base = std::env::temp_dir();
    let missing =
        project_evidence_search_tool_at(&base, r#"{}"#).expect_err("missing query should fail");
    assert!(missing.contains("missing field `query`"));

    let blank = project_evidence_search_tool_at(&base, r#"{"query":"   "}"#)
        .expect_err("blank query should fail");
    assert!(blank.contains("query is empty"));
}

fn literature_only_rag_result() -> ProjectRagSearchResponse {
    let plan = tools::pdf_rag::RetrievalQueryPlan::from_query("What are the limitations?");
    ProjectRagSearchResponse {
        query: "What are the limitations?".to_string(),
        query_plan: plan.clone(),
        knowledge: tools::knowledge::KnowledgeRagSearchResult {
            query: "What are the limitations?".to_string(),
            retrieval: "SQLite FTS".to_string(),
            results: Vec::new(),
            note: String::new(),
        },
        literature: tools::pdf_rag::LiteratureRagSearchResult {
            retrieval: "SQLite FTS".to_string(),
            query_plan: plan,
            results: vec![tools::pdf_rag::LiteratureRagHit {
                chunk: tools::pdf_rag::LiteraturePdfChunk {
                    chunk_id: "chunk-internal-2".to_string(),
                    paper_id: "paper-1".to_string(),
                    relative_path: "papers/secret/internal.pdf".to_string(),
                    page_start: 2,
                    page_end: 2,
                    page_source: "ocr".to_string(),
                    ordinal_on_page: 0,
                    text: "Only 20 samples were used in the evaluation.".to_string(),
                    content_hash: "content-hash".to_string(),
                    chunker_version: "pdf-page-test".to_string(),
                },
                retrieval_score: 0.016,
                source_rank: None,
                card_rank: Some(1),
                asset_rank: None,
                citation_rank: None,
                metadata_rank: None,
                matched_queries: vec!["small sample".to_string()],
            }],
        },
        planner_warning: Some("planner fallback".to_string()),
        rerank: Vec::new(),
    }
}

#[test]
fn chat_evidence_output_keeps_sources_but_hides_routing_internals() {
    let pdf_paths = std::collections::BTreeMap::from([(
        "paper-1".to_string(),
        ".somniq/papers/paper-1.pdf".to_string(),
    )]);
    let output = project_evidence_search_output(&literature_only_rag_result(), &pdf_paths);
    assert_eq!(output["status"], "ready");
    assert_eq!(output["summary"]["pdfExcerpts"], 1);
    assert_eq!(output["pdfEvidence"][0]["citation"], "[paper-1 p.2]");
    assert_eq!(
        output["pdfEvidence"][0]["pdfPath"],
        ".somniq/papers/paper-1.pdf"
    );
    assert_eq!(
        output["pdfEvidence"][0]["excerpt"],
        "Only 20 samples were used in the evaluation."
    );
    assert_eq!(
        output["pdfEvidence"][0]["highlightQuote"],
        "Only 20 samples were used in the evaluation."
    );

    let encoded = output.to_string();
    for internal_field in [
        "queryPlan",
        "rerank",
        "relativePath",
        "contentHash",
        "chunkId",
        "cardRank",
        "matchedQueries",
    ] {
        assert!(
            !encoded.contains(internal_field),
            "chat output leaked internal field {internal_field}"
        );
    }
}

#[test]
fn rag_answer_prompt_uses_canonical_citations_without_temporary_p_labels() {
    let prompt = project_rag_answer_prompt(&literature_only_rag_result());
    assert!(prompt.contains("Citation: [paper-1 p.2]"));
    assert!(prompt.contains("Only 20 samples were used in the evaluation."));
    assert!(!prompt.contains("[P1"));
    assert!(!prompt.contains("[P2"));
    assert!(!prompt.contains("raw-pdf-"));
}

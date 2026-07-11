use super::{extract_json_array, parse_candidates, parse_points};

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

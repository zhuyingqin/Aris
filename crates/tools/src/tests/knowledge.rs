use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_base(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let base = std::env::temp_dir().join(format!("somniq-knowledge-{name}-{unique}"));
    std::fs::create_dir_all(&base).expect("create temp base");
    base
}

fn point(question: &str, answer: &str, statement: &str) -> KnowledgePointInput {
    KnowledgePointInput {
        id: None,
        question: question.to_string(),
        answer: answer.to_string(),
        statement: statement.to_string(),
        kind: Some("finding".to_string()),
        status: None,
        source_paper_id: Some("arxiv:2602.01491".to_string()),
        project_focus_snapshot: None,
        evidence: vec![EvidenceInput {
            paper_id: "arxiv:2602.01491".to_string(),
            page: Some(4),
            quote: "Throughput improved by 32% under congestion.".to_string(),
            role: Some("answer-support".to_string()),
            annotation_id: Some("ann-1".to_string()),
            evidence_id: Some("ev-1".to_string()),
            content_hash: None,
        }],
        relations: Vec::new(),
    }
}

#[test]
fn upsert_confirm_and_search_round_trip() {
    let base = temp_base("round-trip");
    let mut input = point(
        "How much does the scheme improve throughput?",
        "It improves throughput by 32% under congestion.",
        "The scheme improves throughput by 32% under congestion.",
    );
    let stats = knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("upsert draft");
    assert_eq!(stats.added, 1);
    let id = derive_point_id(&input);

    // Draft is not retrievable yet.
    let before = knowledge_search_at(&base, "throughput congestion", 5).expect("search");
    assert!(before.results.is_empty());

    knowledge_confirm_at(&base, &id).expect("confirm");
    let after = knowledge_search_at(&base, "throughput congestion", 5).expect("search");
    assert_eq!(after.results.len(), 1);
    let hit = &after.results[0];
    assert_eq!(hit.id, id);
    assert_eq!(hit.evidence.len(), 1);
    assert_eq!(hit.evidence[0].page, Some(4));
    assert_eq!(hit.evidence[0].annotation_id.as_deref(), Some("ann-1"));

    // Idempotent rebuild keeps it searchable.
    input.statement = input.statement.clone();
    let rebuilt = rebuild_chunks_at(&base).expect("rebuild");
    assert_eq!(rebuilt, 1);
    let again = knowledge_search_at(&base, "throughput", 5).expect("search again");
    assert_eq!(again.results.len(), 1);

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn chinese_query_recall_via_trigram_or_like() {
    let base = temp_base("cjk");
    let input = KnowledgePointInput {
        id: Some("kp-cjk".to_string()),
        question: "拥塞控制方案的吞吐量提升多少？".to_string(),
        answer: "在拥塞条件下吞吐量提升了百分之三十二。".to_string(),
        statement: "该方案在拥塞条件下将吞吐量提升约百分之三十二。".to_string(),
        kind: None,
        status: None,
        source_paper_id: Some("arxiv:1".to_string()),
        project_focus_snapshot: None,
        evidence: vec![EvidenceInput {
            paper_id: "arxiv:1".to_string(),
            page: Some(2),
            quote: "吞吐量在拥塞条件下提升。".to_string(),
            role: None,
            annotation_id: None,
            evidence_id: None,
            content_hash: None,
        }],
        relations: Vec::new(),
    };
    knowledge_upsert_at(&base, &[input], false).expect("upsert");
    knowledge_confirm_at(&base, "kp-cjk").expect("confirm");
    let result = knowledge_search_at(&base, "拥塞条件下吞吐量", 5).expect("cjk search");
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].id, "kp-cjk");
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn version_bumps_only_when_content_changes() {
    let base = temp_base("version");
    let mut input = point("Q?", "A.", "Statement one.");
    input.id = Some("kp-v".to_string());
    knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("v1");

    // Same content → no bump.
    knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("v1 again");
    assert_eq!(point_version(&base, "kp-v"), 1);

    // Changed statement → bump + history row.
    input.statement = "Statement two.".to_string();
    knowledge_upsert_at(&base, &[input], false).expect("v2");
    assert_eq!(point_version(&base, "kp-v"), 2);
    assert_eq!(version_count(&base, "kp-v"), 2);
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn upsert_cannot_confirm_without_authority() {
    let base = temp_base("authority");
    let mut input = point("Q?", "A.", "A confirmed-looking statement.");
    input.id = Some("kp-auth".to_string());
    input.status = Some("confirmed".to_string());

    // LLM path (allow_confirm=false) must downgrade to draft.
    knowledge_upsert_at(&base, &[input.clone_for_test()], false).expect("llm upsert");
    assert_eq!(point_status(&base, "kp-auth"), "draft");
    assert!(knowledge_search_at(&base, "confirmed-looking", 5)
        .expect("search")
        .results
        .is_empty());

    // The user-action path confirms.
    knowledge_confirm_at(&base, "kp-auth").expect("confirm");
    assert_eq!(point_status(&base, "kp-auth"), "confirmed");

    // A later LLM edit that changes content downgrades it for re-review.
    input.statement = "An edited statement.".to_string();
    knowledge_upsert_at(&base, &[input], false).expect("llm edit");
    assert_eq!(point_status(&base, "kp-auth"), "draft");
    let _ = std::fs::remove_dir_all(base);
}

// ── test helpers ──
impl KnowledgePointInput {
    fn clone_for_test(&self) -> KnowledgePointInput {
        KnowledgePointInput {
            id: self.id.clone(),
            question: self.question.clone(),
            answer: self.answer.clone(),
            statement: self.statement.clone(),
            kind: self.kind.clone(),
            status: self.status.clone(),
            source_paper_id: self.source_paper_id.clone(),
            project_focus_snapshot: self.project_focus_snapshot.clone(),
            evidence: self
                .evidence
                .iter()
                .map(|item| EvidenceInput {
                    paper_id: item.paper_id.clone(),
                    page: item.page,
                    quote: item.quote.clone(),
                    role: item.role.clone(),
                    annotation_id: item.annotation_id.clone(),
                    evidence_id: item.evidence_id.clone(),
                    content_hash: item.content_hash.clone(),
                })
                .collect(),
            relations: self
                .relations
                .iter()
                .map(|item| RelationInput {
                    dst_id: item.dst_id.clone(),
                    kind: item.kind.clone(),
                })
                .collect(),
        }
    }
}

fn point_status(base: &Path, id: &str) -> String {
    let connection = open_db(base).expect("open");
    connection
        .query_row(
            "SELECT status FROM knowledge_points WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .expect("status")
}

fn point_version(base: &Path, id: &str) -> i64 {
    let connection = open_db(base).expect("open");
    connection
        .query_row(
            "SELECT version FROM knowledge_points WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .expect("version")
}

fn version_count(base: &Path, id: &str) -> i64 {
    let connection = open_db(base).expect("open");
    connection
        .query_row(
            "SELECT COUNT(*) FROM kp_versions WHERE kp_id=?1",
            [id],
            |row| row.get(0),
        )
        .expect("count")
}

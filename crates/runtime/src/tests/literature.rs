use std::collections::BTreeMap;
use std::fs;

use serde_json::json;

use super::{
    open_literature_store_at, CanonicalRecord, CitationLocator, DecisionActor, EvidenceCard,
    EvidenceStrength, RecordIdentifiers, RecordProvenance, ScreenDecision, ScreeningOutcome,
    SearchProtocolDraft, SearchRunStatus, SourceAttempt, SourceAttemptStatus,
    LITERATURE_SCHEMA_VERSION,
};

fn draft() -> SearchProtocolDraft {
    SearchProtocolDraft {
        question: "Which local-first research workflows support reproducible literature review?"
            .to_string(),
        scope: "Desktop research workspaces".to_string(),
        time_window: "2022-2026".to_string(),
        databases: vec!["crossref".to_string(), "arxiv".to_string()],
        queries: BTreeMap::from([
            (
                "crossref".to_string(),
                "local-first reproducible literature review".to_string(),
            ),
            (
                "arxiv".to_string(),
                "all:local-first AND all:literature".to_string(),
            ),
        ]),
        inclusion_criteria: vec!["Research workflow papers".to_string()],
        exclusion_criteria: vec!["Marketing pages".to_string()],
        known_key_papers: vec!["10.0000/example".to_string()],
    }
}

fn test_record(
    id: &str,
    title: &str,
    doi: Option<&str>,
    arxiv_id: Option<&str>,
    scopus_id: Option<&str>,
) -> CanonicalRecord {
    let now = crate::now_iso8601();
    CanonicalRecord {
        schema_version: LITERATURE_SCHEMA_VERSION,
        id: id.to_string(),
        revision: 1,
        title: title.to_string(),
        normalized_title: crate::normalized_record_title(title),
        authors: vec!["Test Author".to_string()],
        year: Some(2025),
        venue: "Test Venue".to_string(),
        abstract_text: "Test abstract.".to_string(),
        url: Some(format!("https://example.test/{id}")),
        pdf_url: None,
        identifiers: RecordIdentifiers {
            doi: doi.map(str::to_string),
            arxiv_id: arxiv_id.map(str::to_string),
            scopus_id: scopus_id.map(str::to_string),
            source_ids: BTreeMap::new(),
        },
        provenance: vec![RecordProvenance {
            source: "test".to_string(),
            external_id: Some(id.to_string()),
            search_run_id: Some("test-run".to_string()),
            artifact_id: Some("test-artifact".to_string()),
            observed_at: now.clone(),
        }],
        observations: Vec::new(),
        field_conflicts: Vec::new(),
        metadata: json!({}),
        created_at: now.clone(),
        updated_at: now,
    }
}

#[test]
fn persists_a_protocol_run_and_immutable_artifact() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let protocol = store.create_protocol(draft()).expect("protocol");
    assert_eq!(
        store
            .load_protocol(&protocol.id)
            .expect("load protocol")
            .expect("stored protocol"),
        protocol
    );

    let mut run = store.start_run(&protocol).expect("start run");
    let artifact = store
        .write_run_artifact(
            &run.id,
            "crossref",
            "normalised-results",
            "json",
            "application/json",
            br#"[{\"title\":\"Example\"}]"#,
        )
        .expect("artifact");
    assert!(store.root().join(&artifact.relative_path).is_file());

    run.status = SearchRunStatus::Completed;
    run.completed_at = Some(crate::now_iso8601());
    run.artifact_ids.push(artifact.id.clone());
    run.source_attempts.push(SourceAttempt {
        source: "crossref".to_string(),
        request: json!({ "query": "local-first reproducible literature review" }),
        started_at: run.started_at.clone(),
        completed_at: run.completed_at.clone(),
        status: SourceAttemptStatus::Completed,
        hit_count: Some(1),
        returned_count: 1,
        quota: json!({}),
        failure_code: None,
        failure_message: None,
        coverage_note: None,
        artifact_ids: vec![artifact.id],
    });
    store.finish_run(&mut run).expect("finish run");
    assert!(store.finish_run(&mut run).is_err());
}

#[test]
fn checkpoints_and_resumes_only_the_original_running_protocol_revision() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let protocol = store.create_protocol(draft()).expect("protocol");
    let mut run = store.start_run(&protocol).expect("start run");
    run.source_attempts.push(SourceAttempt {
        source: "crossref".to_string(),
        request: json!({ "query": "checkpoint query" }),
        started_at: run.started_at.clone(),
        completed_at: None,
        status: SourceAttemptStatus::Running,
        hit_count: None,
        returned_count: 0,
        quota: json!({}),
        failure_code: None,
        failure_message: None,
        coverage_note: None,
        artifact_ids: Vec::new(),
    });
    store.checkpoint_run(&mut run).expect("checkpoint");

    let resumed = store.resume_run(&run.id, &protocol).expect("resume");
    assert_eq!(resumed.source_attempts, run.source_attempts);

    let different = store
        .create_protocol(SearchProtocolDraft {
            question: "different protocol".to_string(),
            ..draft()
        })
        .expect("different protocol");
    assert!(store.resume_run(&run.id, &different).is_err());
}

#[test]
fn imports_the_legacy_library_once_without_inventing_screening() {
    let workspace = tempfile::tempdir().expect("workspace");
    let papers = workspace.path().join("papers");
    fs::create_dir_all(&papers).expect("papers directory");
    let library_path = papers.join("library.json");
    fs::write(
        &library_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "papers": [{
                "id": "doi:10.1000/example",
                "title": "A  Legacy   Literature Record",
                "authors": ["Researcher One"],
                "year": 2025,
                "venue": "Journal of Examples",
                "doi": "10.1000/example",
                "abstract": "Existing metadata only.",
                "stage": "shortlist",
                "evidence": ["Must remain legacy metadata until reviewed."],
                "addedAt": "2026-01-01T00:00:00Z"
            }]
        }))
        .expect("legacy json"),
    )
    .expect("write legacy library");

    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let original_library = fs::read(&library_path).expect("original library");
    let first = store
        .import_legacy_library(&library_path)
        .expect("first import");
    assert!(!first.already_imported);
    assert_eq!(first.imported_records, 1);
    let record = store
        .load_canonical_record("doi:10.1000/example")
        .expect("load record")
        .expect("imported record");
    assert_eq!(record.normalized_title, "a legacy literature record");
    assert_eq!(record.metadata["stage"], "shortlist");
    assert!(record.provenance[0].search_run_id.is_some());
    let artifacts: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM raw_artifacts", [], |row| row.get(0))
        .expect("legacy artifact row");
    assert_eq!(artifacts, 1);

    let second = store
        .import_legacy_library(&library_path)
        .expect("second import");
    assert!(second.already_imported);
    assert_eq!(second.search_run_id, first.search_run_id);
    assert_eq!(
        fs::read(&library_path).expect("legacy library after import"),
        original_library
    );
}

#[test]
fn later_discovery_adds_provenance_without_overwriting_a_canonical_record() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let protocol = store.create_protocol(draft()).expect("protocol");
    let now = crate::now_iso8601();
    let first = CanonicalRecord {
        schema_version: LITERATURE_SCHEMA_VERSION,
        id: "doi:10.1000/example".to_string(),
        revision: 1,
        title: "Canonical Title".to_string(),
        normalized_title: "canonical title".to_string(),
        authors: vec!["Author One".to_string()],
        year: Some(2024),
        venue: "Venue".to_string(),
        abstract_text: String::new(),
        url: None,
        pdf_url: None,
        identifiers: RecordIdentifiers {
            doi: Some("10.1000/example".to_string()),
            ..RecordIdentifiers::default()
        },
        provenance: vec![RecordProvenance {
            source: "Crossref".to_string(),
            external_id: Some("doi:10.1000/example".to_string()),
            search_run_id: Some("run-one".to_string()),
            artifact_id: Some("artifact-one".to_string()),
            observed_at: now.clone(),
        }],
        observations: Vec::new(),
        field_conflicts: Vec::new(),
        metadata: json!({ "userResolved": true }),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    assert!(store.insert_canonical_record(&first).expect("insert first"));
    let second = CanonicalRecord {
        abstract_text: "A newly observed abstract.".to_string(),
        provenance: vec![RecordProvenance {
            source: "arXiv".to_string(),
            external_id: Some("arxiv:2401.00001".to_string()),
            search_run_id: Some("run-two".to_string()),
            artifact_id: Some("artifact-two".to_string()),
            observed_at: now.clone(),
        }],
        identifiers: RecordIdentifiers {
            doi: Some("10.1000/example".to_string()),
            arxiv_id: Some("2401.00001".to_string()),
            ..RecordIdentifiers::default()
        },
        metadata: json!({ "mustNotReplace": true }),
        ..first.clone()
    };
    assert!(!store
        .insert_canonical_record(&second)
        .expect("merge observation"));
    let merged = store
        .load_canonical_record("doi:10.1000/example")
        .expect("load")
        .expect("record");
    assert_eq!(merged.metadata, json!({ "userResolved": true }));
    assert_eq!(merged.abstract_text, "A newly observed abstract.");
    assert_eq!(merged.identifiers.arxiv_id.as_deref(), Some("2401.00001"));
    assert_eq!(merged.provenance.len(), 2);

    store
        .append_screen_decision(&ScreenDecision {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: "decision-one".to_string(),
            record_id: merged.id.clone(),
            protocol_id: protocol.id,
            stage: "title_abstract".to_string(),
            outcome: ScreeningOutcome::Include,
            reason_code: Some("direct_relevance".to_string()),
            reason: "The record directly addresses the protocol question.".to_string(),
            executor: DecisionActor {
                id: "executor-one".to_string(),
                role: "executor".to_string(),
                model: Some("test-model".to_string()),
            },
            reviewer: Some(DecisionActor {
                id: "reviewer-one".to_string(),
                role: "reviewer".to_string(),
                model: Some("independent-test-model".to_string()),
            }),
            reviewer_outcome: Some(ScreeningOutcome::Include),
            reviewer_reason: Some("Independent review agrees.".to_string()),
            created_at: now.clone(),
            reviewed_at: Some(now.clone()),
        })
        .expect("append decision");
    store
        .append_evidence_card(&EvidenceCard {
            schema_version: LITERATURE_SCHEMA_VERSION,
            id: "evidence-one".to_string(),
            record_id: merged.id,
            claim: "The record supports the test protocol question.".to_string(),
            limitations: vec!["Synthetic test record".to_string()],
            strength: EvidenceStrength::Moderate,
            locator: CitationLocator {
                page: Some(3),
                section: Some("Results".to_string()),
                quote: Some("A precise supporting passage.".to_string()),
            },
            usable_in: vec!["related_work".to_string()],
            created_by: DecisionActor {
                id: "executor-one".to_string(),
                role: "executor".to_string(),
                model: Some("test-model".to_string()),
            },
            created_at: now,
            verified_at: None,
        })
        .expect("append evidence");
    let decisions: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM screen_decisions", [], |row| {
            row.get(0)
        })
        .expect("decision row");
    let cards: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM evidence_cards", [], |row| row.get(0))
        .expect("evidence row");
    assert_eq!(decisions, 1);
    assert_eq!(cards, 1);
}

#[test]
fn resolves_cross_source_identity_and_retains_field_conflicts() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let now = crate::now_iso8601();
    let published = CanonicalRecord {
        schema_version: LITERATURE_SCHEMA_VERSION,
        id: "doi:10.1000/published".to_string(),
        revision: 1,
        title: "A Reproducible Literature Kernel".to_string(),
        normalized_title: "a reproducible literature kernel".to_string(),
        authors: vec!["Author One".to_string()],
        year: Some(2025),
        venue: "Journal of Examples".to_string(),
        abstract_text: "Published abstract.".to_string(),
        url: Some("https://doi.org/10.1000/published".to_string()),
        pdf_url: None,
        identifiers: RecordIdentifiers {
            doi: Some("10.1000/published".to_string()),
            ..RecordIdentifiers::default()
        },
        provenance: vec![RecordProvenance {
            source: "Crossref".to_string(),
            external_id: Some("doi:10.1000/published".to_string()),
            search_run_id: Some("run-crossref".to_string()),
            artifact_id: Some("artifact-crossref".to_string()),
            observed_at: now.clone(),
        }],
        observations: Vec::new(),
        field_conflicts: Vec::new(),
        metadata: json!({}),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    assert!(
        store
            .upsert_canonical_record(&published)
            .expect("insert published")
            .inserted
    );

    let preprint = CanonicalRecord {
        id: "arxiv:2601.00001".to_string(),
        revision: 1,
        year: Some(2024),
        venue: "arXiv".to_string(),
        identifiers: RecordIdentifiers {
            arxiv_id: Some("2601.00001".to_string()),
            ..RecordIdentifiers::default()
        },
        provenance: vec![RecordProvenance {
            source: "arXiv".to_string(),
            external_id: Some("arxiv:2601.00001".to_string()),
            search_run_id: Some("run-arxiv".to_string()),
            artifact_id: Some("artifact-arxiv".to_string()),
            observed_at: now.clone(),
        }],
        ..published.clone()
    };
    let merged = store
        .upsert_canonical_record(&preprint)
        .expect("merge preprint");
    assert!(!merged.inserted);
    assert_eq!(merged.record.id, "doi:10.1000/published");
    assert_eq!(
        merged.record.identifiers.arxiv_id.as_deref(),
        Some("2601.00001")
    );
    assert!(merged
        .record
        .field_conflicts
        .iter()
        .any(|conflict| conflict.field == "year"));
    assert!(merged
        .record
        .field_conflicts
        .iter()
        .any(|conflict| conflict.field == "venue"));
    assert_eq!(store.list_canonical_records().expect("records").len(), 1);
}

#[test]
fn same_title_with_conflicting_strong_identifiers_never_merges_or_claims_a_title_alias() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");

    let pairs = [
        (
            test_record(
                "doi:10.1000/alpha",
                "Guest Editorial",
                Some("10.1000/alpha"),
                None,
                None,
            ),
            test_record(
                "doi:10.2000/beta",
                "Guest Editorial",
                Some("10.2000/beta"),
                None,
                None,
            ),
        ),
        (
            test_record(
                "arxiv:2401.00001",
                "Introduction to the Special Issue",
                None,
                Some("2401.00001"),
                None,
            ),
            test_record(
                "arxiv:2402.00002",
                "Introduction to the Special Issue",
                None,
                Some("2402.00002"),
                None,
            ),
        ),
        (
            test_record("scopus:alpha", "Preface", None, None, Some("alpha")),
            test_record("scopus:beta", "Preface", None, None, Some("beta")),
        ),
    ];

    for (first, second) in pairs {
        assert!(
            store
                .upsert_canonical_record(&first)
                .expect("insert first")
                .inserted
        );
        assert!(
            store
                .upsert_canonical_record(&second)
                .expect("insert title collision")
                .inserted,
            "different strong identifiers must veto a title-only merge"
        );
        assert!(store
            .load_canonical_record(&first.id)
            .expect("load first")
            .is_some());
        assert!(store
            .load_canonical_record(&second.id)
            .expect("load second")
            .is_some());
        let title_aliases: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM canonical_record_aliases WHERE alias = ?1",
                [format!("title:{}", first.normalized_title)],
                |row| row.get(0),
            )
            .expect("title alias count");
        assert_eq!(title_aliases, 0, "ambiguous titles have no alias owner");
    }
    assert_eq!(store.list_canonical_records().expect("records").len(), 6);
}

#[test]
fn identifierless_title_observation_cannot_merge_existing_strong_id_collision() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let alpha = test_record(
        "doi:10.1000/alpha",
        "Guest Editorial",
        Some("10.1000/alpha"),
        None,
        None,
    );
    let beta = test_record(
        "doi:10.2000/beta",
        "Guest Editorial",
        Some("10.2000/beta"),
        None,
        None,
    );
    assert!(
        store
            .upsert_canonical_record(&alpha)
            .expect("insert alpha")
            .inserted
    );
    assert!(
        store
            .upsert_canonical_record(&beta)
            .expect("insert beta")
            .inserted
    );

    let weak_observation = test_record(
        "title:guest-editorial-observation",
        "Guest Editorial",
        None,
        None,
        None,
    );
    let observed = store
        .upsert_canonical_record(&weak_observation)
        .expect("merge weak observation");
    assert!(!observed.inserted);
    assert!(store
        .load_canonical_record(&alpha.id)
        .expect("load alpha")
        .is_some());
    assert!(store
        .load_canonical_record(&beta.id)
        .expect("load beta")
        .is_some());
    assert!(
        observed.merged_record_ids.is_empty(),
        "the weak title must not erase the other strongly identified record"
    );
    assert_eq!(store.list_canonical_records().expect("records").len(), 2);
}

#[test]
fn strong_identifier_conflicts_are_retained_and_incoming_aliases_target_the_live_record() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let canonical = test_record(
        "doi:10.1000/alpha",
        "Shared Research Object",
        Some("10.1000/alpha"),
        Some("2401.00001"),
        Some("scopus-alpha"),
    );
    assert!(
        store
            .upsert_canonical_record(&canonical)
            .expect("insert canonical")
            .inserted
    );

    // Shared arXiv id is sufficient to merge this observation, but its DOI
    // and Scopus id must remain visible as conflicts rather than disappearing.
    let via_arxiv = test_record(
        "doi:10.2000/beta",
        "Shared Research Object",
        Some("10.2000/beta"),
        Some("2401.00001"),
        Some("scopus-beta"),
    );
    assert!(
        !store
            .upsert_canonical_record(&via_arxiv)
            .expect("merge via arXiv")
            .inserted
    );

    // Shared DOI is likewise sufficient, while a conflicting arXiv id must
    // be retained as an observation-level conflict.
    let via_doi = test_record(
        "arxiv:2402.00002",
        "Shared Research Object",
        Some("10.1000/alpha"),
        Some("2402.00002"),
        Some("scopus-gamma"),
    );
    let merged = store
        .upsert_canonical_record(&via_doi)
        .expect("merge via DOI");
    assert!(!merged.inserted);
    assert_eq!(merged.record.id, canonical.id);
    for field in [
        "identifiers.doi",
        "identifiers.arxivId",
        "identifiers.scopusId",
    ] {
        assert!(
            merged
                .record
                .field_conflicts
                .iter()
                .any(|conflict| conflict.field == field),
            "missing {field} conflict"
        );
    }

    let beta_alias_target: String = store
        .connection
        .query_row(
            "SELECT record_id FROM canonical_record_aliases WHERE alias = ?1",
            ["doi:10.2000/beta"],
            |row| row.get(0),
        )
        .expect("incoming DOI alias");
    assert_eq!(beta_alias_target, canonical.id);
    assert!(store
        .load_canonical_record(&beta_alias_target)
        .expect("load alias target")
        .is_some());
    assert_eq!(store.list_canonical_records().expect("records").len(), 1);
}

#[test]
fn separate_store_connections_cannot_finish_or_checkpoint_a_stale_run() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut first = open_literature_store_at(workspace.path()).expect("first store");
    let protocol = first.create_protocol(draft()).expect("protocol");
    let run = first.start_run(&protocol).expect("run");
    let mut second = open_literature_store_at(workspace.path()).expect("second store");
    let stale = second
        .load_run(&run.id)
        .expect("load stale")
        .expect("stale run");

    let mut checkpointed = run.clone();
    checkpointed.source_attempts.push(SourceAttempt {
        source: "crossref".to_string(),
        request: json!({ "query": "kernel" }),
        started_at: checkpointed.started_at.clone(),
        completed_at: None,
        status: SourceAttemptStatus::Running,
        hit_count: None,
        returned_count: 0,
        quota: json!({}),
        failure_code: None,
        failure_message: None,
        coverage_note: None,
        artifact_ids: Vec::new(),
    });
    first
        .checkpoint_run(&mut checkpointed)
        .expect("first checkpoint");
    let mut stale_checkpoint = stale.clone();
    stale_checkpoint.notes.push("other process".to_string());
    assert!(second.checkpoint_run(&mut stale_checkpoint).is_err());

    checkpointed.status = SearchRunStatus::Completed;
    checkpointed.completed_at = Some(crate::now_iso8601());
    first.finish_run(&mut checkpointed).expect("first finish");
    let mut stale_finish = stale;
    stale_finish.status = SearchRunStatus::Completed;
    stale_finish.completed_at = Some(crate::now_iso8601());
    assert!(second.finish_run(&mut stale_finish).is_err());
}

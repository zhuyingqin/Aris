use std::collections::BTreeMap;
use std::fs;

use rusqlite::{params, Connection};
use serde_json::json;

use super::{
    literature_root_for, open_literature_store_at, CanonicalRecord, CitationLocator,
    DecisionActor, EvidenceCard, EvidenceStrength, RecordIdentifiers, RecordProvenance,
    ScreenDecision, ScreeningOutcome, SearchCoverage, SearchProtocolDraft, SearchRunStatus,
    SourceAttempt, SourceAttemptStatus, LITERATURE_SCHEMA_VERSION,
};

fn draft() -> SearchProtocolDraft {
    SearchProtocolDraft {
        question: "Which local-first research workflows support reproducible literature review?"
            .to_string(),
        scope: "Desktop research workspaces".to_string(),
        time_window: "2022-2026".to_string(),
        sort_order: "relevance".to_string(),
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
        query_variants: BTreeMap::new(),
        max_results: Some(50),
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
        coverage: SearchCoverage {
            total_hits: Some(1),
            fetched: 1,
            unique: 1,
            exhausted: true,
            next_cursor: None,
            truncated_reason: None,
        },
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
fn rejects_chinese_scopus_queries_and_variants_at_protocol_creation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");

    let mut query_draft = draft();
    query_draft.databases = vec!["scopus".to_string()];
    query_draft.queries =
        BTreeMap::from([("scopus".to_string(), "TITLE-ABS-KEY(研究)".to_string())]);
    let error = store
        .create_protocol(query_draft)
        .expect_err("Chinese Scopus query must be rejected");
    assert!(error.contains("Scopus"));
    assert!(error.contains("Chinese/CJK"));

    let mut variant_draft = draft();
    variant_draft.databases = vec!["scopus".to_string()];
    variant_draft.queries =
        BTreeMap::from([("scopus".to_string(), "TITLE-ABS-KEY(model)".to_string())]);
    variant_draft.query_variants = BTreeMap::from([(
        "scopus".to_string(),
        vec![super::SearchQueryVariant {
            kind: "language_variant".to_string(),
            query: "TITLE-ABS-KEY(模型)".to_string(),
            rationale: "invalid language variant".to_string(),
            max_results: None,
        }],
    )]);
    let error = store
        .create_protocol(variant_draft)
        .expect_err("Chinese Scopus variant must be rejected");
    assert!(error.contains("query variants"));
    assert!(error.contains("Chinese/CJK"));
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
        coverage: SearchCoverage::default(),
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
            "collections": [{
                "id": "collection:legacy",
                "label": "Legacy imports"
            }],
            "papers": [{
                "id": "doi:10.1000/example",
                "title": "A  Legacy   Literature Record",
                "authors": ["Researcher One"],
                "year": 2025,
                "venue": "Journal of Examples",
                "doi": "10.1000/example",
                "abstract": "Existing metadata only.",
                "stage": "shortlist",
                "tags": ["legacy", "migration"],
                "collectionIds": ["collection:legacy"],
                "attachments": [{
                    "id": "attachment:legacy-pdf",
                    "label": "Legacy PDF",
                    "kind": "pdf",
                    "path": "papers/legacy.pdf"
                }],
                "pdf": {
                    "status": "downloaded",
                    "path": "papers/legacy.pdf"
                },
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
    let relations = store
        .library_relation_snapshot()
        .expect("legacy relationships");
    let item = relations
        .items
        .get("doi:10.1000/example")
        .expect("legacy item relationships");
    assert_eq!(item.tags, vec!["legacy", "migration"]);
    assert_eq!(item.collection_ids, vec!["collection:legacy"]);
    assert_eq!(item.attachments.len(), 1);
    assert_eq!(relations.collections.len(), 1);
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
fn normalizes_zotero_relationships_and_round_trips_them() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let record = test_record("doi:10.1000/relations", "A Relational Library", None, None, None);
    store
        .upsert_canonical_record(&record)
        .expect("insert record");
    store
        .set_legacy_library_projection_meta(&json!({
            "collections": [
                { "id": "collection:review", "label": "Review queue" },
                { "id": "collection:read", "label": "Read", "parentId": "collection:review" }
            ]
        }))
        .expect("collections");

    let paper = json!({
        "id": record.id,
        "tags": ["Evidence", "evidence", "methods"],
        "collectionIds": ["collection:review", "collection:read"],
        "attachments": [{
            "id": "attachment:pdf",
            "label": "Paper PDF",
            "kind": "pdf",
            "path": "papers/relations.pdf",
            "mimeType": "application/pdf",
            "bytes": 42,
            "addedAt": "2026-01-01T00:00:00Z"
        }],
        "pdf": { "status": "downloaded", "path": "papers/relations.pdf", "bytes": 42 },
        "pdfAnnotations": [{
            "id": "annotation:one",
            "page": 4,
            "quote": "A durable quote.",
            "note": "Keep this passage.",
            "kind": "evidence",
            "attachmentId": "attachment:pdf",
            "createdAt": "2026-01-01T00:00:00Z"
        }],
        "notes": [{
            "id": "note:one",
            "title": "Reading note",
            "content": "This note remains attached to the annotation.",
            "annotationId": "annotation:one",
            "attachmentId": "attachment:pdf",
            "source": "annotation",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]
    });
    store
        .update_legacy_library_paper(&record.id, &paper)
        .expect("sync relationships");

    let snapshot = store.library_relation_snapshot().expect("snapshot");
    let item = snapshot.items.get(&record.id).expect("item relations");
    assert_eq!(item.collection_ids, vec!["collection:review", "collection:read"]);
    assert_eq!(item.tags, vec!["Evidence", "methods"]);
    assert_eq!(item.attachments.len(), 1);
    assert_eq!(item.annotations[0].attachment_id.as_deref(), Some("attachment:pdf"));
    assert_eq!(item.notes[0].annotation_id.as_deref(), Some("annotation:one"));
    assert_eq!(snapshot.collections.len(), 2);

    let relation_rows: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM library_collection_items WHERE item_id = ?1",
            [&record.id],
            |row| row.get(0),
        )
        .expect("collection rows");
    let tag_rows: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM library_item_tags WHERE item_id = ?1",
            [&record.id],
            |row| row.get(0),
        )
        .expect("tag rows");
    assert_eq!(relation_rows, 2);
    assert_eq!(tag_rows, 2);

    let updated = store
        .update_library_relations(&record.id, &json!({ "tags": ["updated-tag"] }))
        .expect("update normalized relationships");
    assert_eq!(updated.tags, vec!["updated-tag"]);
    assert_eq!(
        store
            .load_canonical_record(&record.id)
            .expect("load updated record")
            .expect("updated record")
            .metadata["legacyLibrary"]["tags"],
        json!(["updated-tag"])
    );
    assert_eq!(
        store
            .full_text_search("updated-tag", 10)
            .expect("search updated tag")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(record.id.as_str())
    );

    let collections = store
        .update_library_collections(&json!([{
            "id": "collection:review",
            "label": "Review queue"
        }]))
        .expect("update collection tree");
    assert_eq!(collections.len(), 1);
    assert_eq!(
        store
            .library_relation_snapshot()
            .expect("snapshot after collection update")
            .items
            .get(&record.id)
            .expect("item after collection update")
            .collection_ids,
        vec!["collection:review"]
    );

    let cycle_error = store
        .update_library_collections(&json!([
            {
                "id": "collection:one",
                "label": "One",
                "parentId": "collection:two"
            },
            {
                "id": "collection:two",
                "label": "Two",
                "parentId": "collection:one"
            }
        ]))
        .expect_err("collection cycles must be rejected");
    assert!(cycle_error.contains("cycle"));
}

#[test]
fn complete_library_snapshot_preserves_creator_roles_and_clears_removed_fields() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let record = test_record(
        "doi:10.1000/metadata-fidelity",
        "Original title",
        Some("10.1000/metadata-fidelity"),
        None,
        None,
    );
    store
        .upsert_canonical_record(&record)
        .expect("insert record");

    store
        .update_legacy_library_paper_snapshot(
            &record.id,
            &json!({
                "id": record.id,
                "title": "Edited title",
                "itemType": "bookSection",
                "authors": ["Ada Lovelace"],
                "creators": [
                    {
                        "creatorType": "author",
                        "firstName": "Ada",
                        "lastName": "Lovelace",
                        "fieldMode": "twoField"
                    },
                    {
                        "creatorType": "editor",
                        "name": "Applied Mathematics Institute",
                        "fieldMode": "oneField"
                    }
                ],
                "venue": "",
                "abstract": "",
                "doi": null,
                "metadataFields": {
                    "archiveLocation": "Box 7",
                    "customNumeric": 42
                },
                "tags": [],
                "collectionIds": [],
                "attachments": [],
                "notes": [],
                "pdfAnnotations": [],
                "relations": [],
                "stage": "inbox",
                "starred": false,
                "unread": true,
                "source": "local-edit",
                "addedAt": "2026-01-01T00:00:00Z",
                "pdf": { "status": "none" }
            }),
        )
        .expect("write complete snapshot");

    let model = store.library_model_snapshot().expect("model snapshot");
    let item = model
        .items
        .iter()
        .find(|item| item.item.id == record.id)
        .expect("normalized item");
    assert_eq!(item.item.item_type, "bookSection");
    assert_eq!(item.fields.get("title").map(String::as_str), Some("Edited title"));
    assert_eq!(item.fields.get("archiveLocation").map(String::as_str), Some("Box 7"));
    assert_eq!(item.fields.get("customNumeric").map(String::as_str), Some("42"));
    assert!(!item.fields.contains_key("abstractNote"));
    assert!(!item.fields.contains_key("publicationTitle"));
    assert!(!item.fields.contains_key("DOI"));
    assert_eq!(item.creators.len(), 2);
    assert_eq!(item.creators[0].creator_type, "author");
    assert_eq!(item.creators[0].field_mode, "twoField");
    assert_eq!(item.creators[1].creator_type, "editor");
    assert_eq!(item.creators[1].name.as_deref(), Some("Applied Mathematics Institute"));

    let canonical = store
        .load_canonical_record(&record.id)
        .expect("load canonical")
        .expect("canonical record");
    assert_eq!(canonical.title, "Edited title");
    assert!(canonical.abstract_text.is_empty());
    assert!(canonical.venue.is_empty());
    assert!(canonical.identifiers.doi.is_none());
    assert_eq!(canonical.authors, vec!["Ada Lovelace"]);
    assert_eq!(canonical.metadata["legacyLibrary"]["creators"][1]["creatorType"], "editor");

    let mut edited_fields = item.fields.clone();
    edited_fields.remove("archiveLocation");
    edited_fields.remove("customNumeric");
    store
        .update_library_item(
            &record.id,
            &json!({
                "expectedVersion": item.item.version,
                "fields": edited_fields
            }),
        )
        .expect("clear normalized custom fields");
    let cleared = store
        .load_canonical_record(&record.id)
        .expect("load cleared canonical")
        .expect("cleared canonical record");
    assert!(cleared.metadata["legacyLibrary"].get("archiveLocation").is_none());
    assert!(cleared.metadata["legacyLibrary"].get("customNumeric").is_none());
    assert!(cleared.metadata["legacyLibrary"].get("metadataFields").is_none());
}

#[test]
fn scopes_synthetic_primary_pdf_attachments_per_record() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let first = test_record(
        "doi:10.1000/primary-one",
        "Primary PDF one",
        Some("10.1000/primary-one"),
        None,
        None,
    );
    let second = test_record(
        "doi:10.1000/primary-two",
        "Primary PDF two",
        Some("10.1000/primary-two"),
        None,
        None,
    );
    store.upsert_canonical_record(&first).expect("insert first");
    store.upsert_canonical_record(&second).expect("insert second");

    for (record, path) in [(&first, "papers/primary-one.pdf"), (&second, "papers/primary-two.pdf")] {
        store
            .update_legacy_library_paper(
                &record.id,
                &json!({
                    "pdf": { "status": "downloaded", "path": path },
                    "attachments": [],
                    "pdfAnnotations": [],
                    "notes": []
                }),
            )
            .expect("materialize primary PDF");
    }

    for (record, path) in [(&first, "papers/primary-one.pdf"), (&second, "papers/primary-two.pdf")] {
        let (attachment_id, stored_path): (String, String) = store
            .connection
            .query_row(
                "SELECT id, path FROM library_attachments WHERE item_id = ?1",
                [&record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read primary PDF attachment");
        assert_eq!(attachment_id, format!("attachment-primary-pdf:{}", record.id));
        assert_eq!(stored_path, path);
    }
    let attachment_count: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM library_attachments", [], |row| row.get(0))
        .expect("count primary PDF attachments");
    assert_eq!(attachment_count, 2);
}

#[test]
fn upgrades_legacy_global_primary_pdf_ids_without_cross_record_overwrite() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let first = test_record(
        "doi:10.1000/legacy-primary-one",
        "Legacy primary PDF one",
        Some("10.1000/legacy-primary-one"),
        None,
        None,
    );
    let second = test_record(
        "doi:10.1000/legacy-primary-two",
        "Legacy primary PDF two",
        Some("10.1000/legacy-primary-two"),
        None,
        None,
    );
    store.upsert_canonical_record(&first).expect("insert first");
    store.upsert_canonical_record(&second).expect("insert second");
    let legacy_id = "attachment-primary-pdf";
    let first_paper = json!({
        "pdf": { "status": "downloaded", "path": "papers/legacy-primary-one.pdf" },
        "attachments": [],
        "pdfAnnotations": [],
        "notes": []
    });
    let second_paper = json!({
        "pdf": { "status": "downloaded", "path": "papers/legacy-primary-two.pdf" },
        "attachments": [{
            "id": legacy_id,
            "label": "Primary PDF",
            "kind": "pdf",
            "path": "papers/legacy-primary-two.pdf"
        }],
        "pdfAnnotations": [{
            "id": "annotation:legacy-primary",
            "attachmentId": legacy_id,
            "page": 3,
            "quote": "A legacy quote.",
            "note": "Keep this link.",
            "kind": "highlight"
        }],
        "notes": [{
            "id": "note:legacy-primary",
            "attachmentId": legacy_id,
            "content": "A legacy note."
        }]
    });
    for (record, paper) in [(&first, first_paper), (&second, second_paper)] {
        let mut legacy_record = record.clone();
        legacy_record.metadata = json!({ "legacyLibrary": paper });
        store
            .connection
            .execute(
                "UPDATE canonical_records SET payload = ?1 WHERE id = ?2",
                params![super::encode_payload(&legacy_record).expect("encode legacy record"), record.id],
            )
            .expect("write legacy payload");
    }
    store
        .connection
        .execute(
            "INSERT INTO library_attachments(id, item_id, label, kind, path, added_at)
             VALUES (?1, ?2, 'Primary PDF', 'pdf', ?3, '2026-01-01T00:00:00Z')",
            params![legacy_id, second.id, "papers/legacy-primary-two.pdf"],
        )
        .expect("write legacy attachment row");
    store
        .connection
        .execute(
            "UPDATE metadata SET value = '6' WHERE key = 'schema_version'",
            [],
        )
        .expect("mark old schema");
    store
        .connection
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('library_relations_backfill_v1', '2')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .expect("mark old relation backfill");
    store
        .connection
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('library_item_model_backfill_v1', '2')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .expect("mark old model backfill");
    drop(store);

    let reopened = open_literature_store_at(workspace.path()).expect("reopen upgraded store");
    for (record, path) in [
        (&first, "papers/legacy-primary-one.pdf"),
        (&second, "papers/legacy-primary-two.pdf"),
    ] {
        let (attachment_id, stored_path): (String, String) = reopened
            .connection
            .query_row(
                "SELECT id, path FROM library_attachments WHERE item_id = ?1",
                [&record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read upgraded primary PDF");
        assert_eq!(attachment_id, format!("attachment-primary-pdf:{}", record.id));
        assert_eq!(stored_path, path);
    }
    let relations = reopened.library_relation_snapshot().expect("upgraded relations");
    let second_relations = relations.items.get(&second.id).expect("second relations");
    assert_eq!(
        second_relations.annotations[0].attachment_id.as_deref(),
        Some("attachment-primary-pdf:doi:10.1000/legacy-primary-two")
    );
    assert_eq!(
        second_relations.notes[0].attachment_id.as_deref(),
        Some("attachment-primary-pdf:doi:10.1000/legacy-primary-two")
    );
    let migrated = reopened
        .load_canonical_record(&second.id)
        .expect("load migrated record")
        .expect("migrated record");
    assert_eq!(
        migrated.metadata["legacyLibrary"]["attachments"][0]["id"],
        "attachment-primary-pdf:doi:10.1000/legacy-primary-two"
    );
}

#[test]
fn materializes_the_local_zotero_item_model_and_recoverable_trash() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let record = test_record("doi:10.1000/model", "A Unified Library Item", Some("10.1000/model"), None, None);
    store
        .upsert_canonical_record(&record)
        .expect("insert record");
    store
        .update_legacy_library_paper(
            &record.id,
            &json!({
                "itemType": "article",
                "key": "MODEL01",
                "tags": [{ "tag": "automatic", "type": 1, "color": "#3B82F6" }],
                "collectionIds": ["collection:reading"],
                "attachments": [{
                    "id": "attachment:model-pdf",
                    "label": "Model PDF",
                    "kind": "pdf",
                    "path": "papers/model.pdf",
                    "linkMode": "imported_file",
                    "filename": "model.pdf",
                    "sourcePayload": {
                        "key": "ATTACH01",
                        "itemType": "attachment",
                        "parentItem": "MODEL01",
                        "path": "storage:model.pdf",
                        "contentType": "application/pdf"
                    }
                }],
                "notes": [{
                    "id": "note:model",
                    "title": "Model note",
                    "content": "Keep the model normalized.",
                    "attachmentId": "attachment:model-pdf",
                    "sourcePayload": {
                        "key": "NOTE01",
                        "itemType": "note",
                        "parentItem": "ATTACH01",
                        "note": "Keep the model normalized."
                    }
                }],
                "pdfAnnotations": [{
                    "id": "annotation:model",
                    "attachmentId": "attachment:model-pdf",
                    "page": 7,
                    "pageLabel": "7",
                    "quote": "A durable quote.",
                    "note": "Use this in the method section.",
                    "kind": "highlight",
                    "annotationType": "highlight",
                    "position": { "rects": [{ "x": 1 }] },
                    "sortIndex": 2,
                    "author": "Test Author",
                    "sourcePayload": {
                        "key": "ANN01",
                        "itemType": "annotation",
                        "parentItem": "ATTACH01",
                        "annotationText": "A durable quote.",
                        "annotationPageLabel": "7"
                    }
                }],
                "relations": [{
                    "predicate": "related",
                    "targetItemId": "doi:10.1000/other",
                    "targetKind": "item"
                }]
            }),
        )
        .expect("sync item model");
    store
        .set_record_pdf_text(&record.id, "indexed model text")
        .expect("index attachment text");
    store
        .set_record_attachment_text(
            &record.id,
            "attachment:model-pdf",
            "supplementary html needle",
        )
        .expect("index generic attachment text");
    assert_eq!(
        store
            .full_text_search("supplementary html", 10)
            .expect("search generic attachment text")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(record.id.as_str())
    );
    store
        .set_record_attachment_text(&record.id, "attachment:model-pdf", "")
        .expect("clear generic attachment text");
    assert!(store
        .full_text_search("supplementary html", 10)
        .expect("search after clearing generic attachment text")
        .is_empty());
    store
        .update_library_saved_searches(&json!([{
            "id": "saved-search:reading",
            "name": "Reading",
            "query": "tag:automatic",
            "sources": ["local"],
            "dynamic": true,
            "conditions": [{
                "field": "tag",
                "operator": "contains",
                "value": "automatic",
                "joiner": "AND"
            }]
        }]))
        .expect("save search");

    let model = store.library_model_snapshot().expect("model snapshot");
    let parent = model
        .items
        .iter()
        .find(|snapshot| snapshot.item.id == record.id)
        .expect("parent item");
    assert_eq!(parent.item.key, "MODEL01");
    assert_eq!(parent.item.item_type, "journalArticle");
    assert_eq!(parent.fields["title"], "A Unified Library Item");
    assert_eq!(parent.fields["DOI"], "10.1000/model");
    assert_eq!(parent.tags[0].tag_type, 1);
    assert_eq!(parent.tags[0].color.as_deref(), Some("#3B82F6"));
    assert_eq!(parent.relations[0].target, "doi:10.1000/other");
    assert_eq!(parent.creators[0].field_mode, "oneField");
    assert_eq!(
        model
            .items
            .iter()
            .filter(|snapshot| snapshot.item.parent_item_id.as_deref() == Some(record.id.as_str()))
            .count(),
        1
    );
    assert_eq!(
        model
            .items
            .iter()
            .filter(|snapshot| snapshot.item.parent_item_id.as_deref() == Some("attachment:model-pdf"))
            .count(),
        2
    );
    let annotation = model
        .items
        .iter()
        .find(|snapshot| snapshot.item.id == "annotation:model")
        .expect("annotation item");
    assert_eq!(
        annotation.source_payload.as_ref().and_then(|payload| payload["key"].as_str()),
        Some("ANN01")
    );
    assert!(annotation.full_text.is_none());
    assert!(model
        .saved_searches
        .iter()
        .any(|search| search.id == "saved-search:reading" && search.conditions.len() == 1));
    assert_eq!(
        model
            .special_collections
            .iter()
            .find(|collection| collection.kind == "all")
            .map(|collection| collection.count),
        Some(1)
    );
    assert_eq!(
        model
            .special_collections
            .iter()
            .find(|collection| collection.kind == "trash")
            .map(|collection| collection.count),
        Some(0)
    );

    let cycle_error = store
        .update_library_item(
            &record.id,
            &json!({ "parentItemId": "attachment:model-pdf" }),
        )
        .expect_err("an item cannot be moved below its descendant");
    assert!(cycle_error.contains("descendants"));
    assert!(store
        .library_item(&record.id)
        .expect("read parent after rejected move")
        .expect("parent still exists")
        .parent_item_id
        .is_none());

    store
        .trash_library_items(&[record.id.clone()])
        .expect("move parent to trash");
    let trashed = store
        .library_item(&record.id)
        .expect("read trashed parent")
        .expect("trashed parent exists");
    assert!(trashed.trashed);
    let child_trashed: i64 = store
        .connection
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
               SELECT id FROM library_items WHERE parent_item_id = ?1
               UNION ALL
               SELECT child.id FROM library_items AS child
               JOIN descendants ON child.parent_item_id = descendants.id
             )
             SELECT COUNT(*) FROM library_items
             WHERE id IN (SELECT id FROM descendants) AND trashed = 1",
            [&record.id],
            |row| row.get(0),
        )
        .expect("count trashed children");
    assert_eq!(child_trashed, 3);
    store
        .restore_library_items(&[record.id.clone()])
        .expect("restore parent");
    assert!(!store
        .library_item("doi:10.1000/model")
        .expect("read restored parent")
        .expect("restored parent exists")
        .trashed);

    store
        .set_record_attachment_text(
            &record.id,
            "attachment:model-pdf",
            "zetaattachmentlifecycle",
        )
        .expect("re-index attachment text before removal");
    store
        .update_library_relations(
            &record.id,
            &json!({
                "attachments": [],
                "notes": [],
                "pdfAnnotations": []
            }),
        )
        .expect("remove attachment relationship");
    assert!(store
        .library_item("attachment:model-pdf")
        .expect("read removed attachment child")
        .is_none());
    assert!(store
        .full_text_search("zetaattachmentlifecycle", 10)
        .expect("search after removing attachment")
        .is_empty());
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM library_attachment_full_text WHERE item_id = ?1",
                ["attachment:model-pdf"],
                |row| row.get::<_, i64>(0),
            )
            .expect("count removed attachment full text"),
        0
    );
}

#[test]
fn deduplicates_creator_relations_during_record_import_and_library_edit() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let mut record = test_record(
        "doi:10.1000/duplicate-creators",
        "Duplicate creator fixture",
        Some("10.1000/duplicate-creators"),
        None,
        None,
    );
    record.authors = vec![
        "Ada Lovelace".to_string(),
        "Ada Lovelace".to_string(),
        "Grace Hopper".to_string(),
    ];

    store
        .upsert_canonical_record(&record)
        .expect("duplicate fallback authors must not abort import");
    let model = store.library_model_snapshot().expect("model snapshot");
    let parent = model
        .items
        .iter()
        .find(|snapshot| snapshot.item.id == record.id)
        .expect("parent item");
    assert_eq!(parent.creators.len(), 2);
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM library_item_creators WHERE item_id = ?1",
                [&record.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("creator relation count"),
        2
    );

    store
        .update_legacy_library_paper(
            &record.id,
            &json!({
                "creators": [
                    { "firstName": "Ada", "lastName": "Lovelace", "creatorType": "author" },
                    { "firstName": "Ada", "lastName": "Lovelace", "creatorType": "author" },
                    { "firstName": "Grace", "lastName": "Hopper", "creatorType": "editor" },
                    { "firstName": "Grace", "lastName": "Hopper", "creatorType": "editor" }
                ]
            }),
        )
        .expect("duplicate rich creators must not abort a library edit");
    let updated = store.library_model_snapshot().expect("updated model snapshot");
    let parent = updated
        .items
        .iter()
        .find(|snapshot| snapshot.item.id == record.id)
        .expect("updated parent item");
    assert_eq!(parent.creators.len(), 2);
    assert_eq!(
        parent
            .creators
            .iter()
            .map(|creator| creator.creator_type.as_str())
            .collect::<Vec<_>>(),
        vec!["author", "editor"]
    );
}

#[test]
fn upgrades_a_legacy_creator_relation_table_before_writing_new_items() {
    let workspace = tempfile::tempdir().expect("workspace");
    let root = literature_root_for(workspace.path());
    std::fs::create_dir_all(&root).expect("create literature root");
    let database_path = root.join("literature.sqlite3");
    let connection = Connection::open(&database_path).expect("open legacy database");
    connection
        .execute_batch(
            "CREATE TABLE library_item_creators(
               item_id TEXT NOT NULL,
               creator_id TEXT NOT NULL,
               creator_type TEXT NOT NULL,
               order_index INTEGER NOT NULL
             );
             INSERT INTO library_item_creators(item_id, creator_id, creator_type, order_index)
             VALUES
               ('legacy:item', 'creator:ada', 'author', 0),
               ('legacy:item', 'creator:ada', 'author', 1);",
        )
        .expect("create legacy creator relation table");
    drop(connection);

    let mut store = open_literature_store_at(workspace.path()).expect("upgrade legacy store");
    let relation_count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM library_item_creators
             WHERE item_id = 'legacy:item'
               AND creator_id = 'creator:ada'
               AND creator_type = 'author'",
            [],
            |row| row.get(0),
        )
        .expect("count repaired relations");
    assert_eq!(relation_count, 1);

    let mut record = test_record(
        "legacy:item",
        "Legacy Creator Table Fixture",
        Some("10.1000/legacy-creator-table"),
        None,
        None,
    );
    record.authors = vec!["Ada Lovelace".to_string(), "Ada Lovelace".to_string()];
    store
        .upsert_canonical_record(&record)
        .expect("write through legacy relation table");
    let new_relation_count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM library_item_creators WHERE item_id = ?1",
            [&record.id],
            |row| row.get(0),
        )
        .expect("count new relations");
    assert_eq!(new_relation_count, 1);
}

#[test]
fn upgrades_a_pre_item_model_library_that_already_holds_child_relationships() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let record = test_record(
        "doi:10.1000/pre-item-model",
        "A Library Written Before The Item Model",
        None,
        None,
        None,
    );
    store
        .upsert_canonical_record(&record)
        .expect("insert record");
    store
        .update_legacy_library_paper(
            &record.id,
            &json!({
                "id": record.id,
                "attachments": [{
                    "id": "attachment:pdf",
                    "label": "Paper PDF",
                    "kind": "pdf",
                    "path": "papers/pre-item-model.pdf",
                    "mimeType": "application/pdf",
                    "addedAt": "2026-01-01T00:00:00Z"
                }],
                "notes": [{
                    "id": "note:one",
                    "title": "Reading note",
                    "content": "Written before the normalized item model existed.",
                    "attachmentId": "attachment:pdf",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }]
            }),
        )
        .expect("sync relationships");
    drop(store);

    // Rewind to what an older build left on disk: canonical records and their
    // legacy relationship payloads, but no normalized item model and neither
    // backfill marker. Both backfills therefore run on the next open, and the
    // relation backfill materializes child items whose `parent_item_id`
    // foreign key only resolves once the item-model backfill has written the
    // top-level rows.
    let database_path = literature_root_for(workspace.path()).join("literature.sqlite3");
    let connection = Connection::open(&database_path).expect("open database");
    connection
        .execute_batch(
            "DELETE FROM library_items;
             DELETE FROM metadata
               WHERE key IN ('library_relations_backfill_v1', 'library_item_model_backfill_v1');
             UPDATE metadata SET value = '2' WHERE key = 'schema_version';",
        )
        .expect("rewind to a pre-item-model database");
    drop(connection);

    let store = open_literature_store_at(workspace.path()).expect("upgrade pre-item-model store");
    let markers: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM metadata
             WHERE key IN ('library_relations_backfill_v1', 'library_item_model_backfill_v1')",
            [],
            |row| row.get(0),
        )
        .expect("count backfill markers");
    assert_eq!(markers, 2, "both backfills must record completion");
    let parent_of_attachment: Option<String> = store
        .connection
        .query_row(
            "SELECT parent_item_id FROM library_items WHERE id = 'attachment:pdf'",
            [],
            |row| row.get(0),
        )
        .expect("read attachment item");
    assert_eq!(parent_of_attachment.as_deref(), Some(record.id.as_str()));
    let violations = store
        .connection
        .prepare("PRAGMA foreign_key_check")
        .expect("prepare foreign key check")
        .query_map([], |_| Ok(()))
        .expect("run foreign key check")
        .count();
    assert_eq!(violations, 0);
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
        coverage: SearchCoverage::default(),
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

#[test]
fn full_text_search_tracks_metadata_updates_and_user_merges() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let mut primary = test_record(
        "doi:10.1000/primary",
        "A Local Research Index",
        Some("10.1000/primary"),
        None,
        None,
    );
    primary.abstract_text = "Searchable full text abstraction.".to_string();
    let duplicate = test_record(
        "doi:10.1000/duplicate",
        "A Local Research Index",
        Some("10.1000/duplicate"),
        None,
        None,
    );
    assert!(
        store
            .upsert_canonical_record(&primary)
            .expect("insert primary")
            .inserted
    );
    assert!(
        store
            .upsert_canonical_record(&duplicate)
            .expect("insert duplicate")
            .inserted
    );

    assert_eq!(
        store
            .full_text_search("abstraction", 10)
            .expect("search abstract")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(primary.id.as_str())
    );
    store
        .update_legacy_library_paper(
            &primary.id,
            &json!({ "id": primary.id, "tags": ["human-note-needle"] }),
        )
        .expect("update local metadata");
    assert_eq!(
        store
            .full_text_search("human-note-needle", 10)
            .expect("search metadata")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(primary.id.as_str())
    );
    store
        .set_record_pdf_text(&primary.id, "A searchable PDF full-text needle.")
        .expect("index pdf text");
    assert_eq!(
        store
            .full_text_search("full-text", 10)
            .expect("search PDF text")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(primary.id.as_str())
    );

    let candidates = store.duplicate_candidates().expect("duplicate candidates");
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        [
            candidates[0].primary_record_id.as_str(),
            candidates[0].duplicate_record_id.as_str(),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>(),
        [primary.id.as_str(), duplicate.id.as_str()]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
    );
    let merged = store
        .merge_canonical_records(&primary.id, &duplicate.id)
        .expect("merge duplicate");
    assert_eq!(merged.id, primary.id);
    assert_eq!(store.list_canonical_records().expect("records").len(), 1);
    assert!(store.duplicate_candidates().expect("duplicates").is_empty());
    assert_eq!(
        store
            .full_text_search("abstraction", 10)
            .expect("search after merge")
            .first()
            .map(|hit| hit.record_id.as_str()),
        Some(primary.id.as_str())
    );
}

#[test]
fn ranks_duplicate_candidates_by_identifier_strength() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    // Import keeps these apart: the titles differ, so nothing merges on the
    // way in. The ids run counter to identifier strength, so a candidate list
    // that fell back to id order would name the wrong primary.
    for (id, title, doi, arxiv, scopus) in [
        ("record:a-scopus", "Indexed Only By Scopus", None, None, Some("2-s2.0-strength")),
        ("record:b-doi", "Published With A DOI", Some("10.1000/strength"), None, None),
        ("record:c-arxiv", "Posted To arXiv", None, Some("2501.00001"), None),
    ] {
        store
            .upsert_canonical_record(&test_record(id, title, doi, arxiv, scopus))
            .expect("insert record");
    }
    store
        .upsert_canonical_record(&test_record(
            "record:d-unique",
            "A Title Nothing Else Shares",
            Some("10.1000/unique"),
            None,
            None,
        ))
        .expect("insert unique record");
    assert_eq!(store.canonical_record_count().expect("record count"), 4);
    assert_eq!(store.search_run_count().expect("run count"), 0);
    assert!(store.duplicate_candidates().expect("no duplicates yet").is_empty());

    // They only collide once a local edit gives them one title — which is how
    // records carrying different kinds of strong identifier end up as
    // duplicates at all, since import merges anything a title match cannot
    // tell apart.
    for id in ["record:a-scopus", "record:c-arxiv"] {
        // `fields` is a full replacement, and the identifier columns are
        // derived from it, so carry the existing map across and change only
        // the title.
        let mut fields = store
            .library_model_snapshot()
            .expect("model snapshot")
            .items
            .into_iter()
            .find(|item| item.item.id == id)
            .expect("normalized item")
            .fields;
        fields.insert("title".to_string(), "Published With A DOI".to_string());
        store
            .update_library_item(id, &json!({ "fields": fields }))
            .expect("retitle onto the DOI record's title");
    }

    let candidates = store.duplicate_candidates().expect("duplicate candidates");
    assert_eq!(candidates.len(), 2, "one primary and two duplicates");
    assert!(
        candidates
            .iter()
            .all(|candidate| candidate.primary_record_id == "record:b-doi"),
        "the DOI-bearing record outranks arXiv and Scopus: {candidates:?}"
    );
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.duplicate_record_id.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        ["record:a-scopus", "record:c-arxiv"]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
    );
}

#[test]
fn full_text_search_pages_broad_results_and_recovers_one_character_typos() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    for (id, title) in [
        ("doi:10.1000/a", "Research abstraction systems"),
        ("doi:10.1000/b", "Research evaluation methods"),
        ("doi:10.1000/c", "Research workflow evidence"),
    ] {
        let mut record = test_record(id, title, id.strip_prefix("doi:"), None, None);
        record.abstract_text = title.to_string();
        store
            .upsert_canonical_record(&record)
            .expect("insert searchable record");
    }

    let first = store
        .full_text_search_page("research", 2, 0)
        .expect("first page");
    assert_eq!(first.total, 3);
    assert_eq!(first.hits.len(), 2);
    assert!(!first.exhausted);
    assert_eq!(first.next_offset, Some(2));
    let second = store
        .full_text_search_page("research", 2, 2)
        .expect("second page");
    assert_eq!(second.total, 3);
    assert_eq!(second.hits.len(), 1);
    assert!(second.exhausted);

    let fuzzy = store
        .full_text_search_page("abstrction", 10, 0)
        .expect("fuzzy page");
    assert_eq!(fuzzy.hits.len(), 1);
    assert!(fuzzy
        .strategies
        .iter()
        .any(|strategy| strategy == "fuzzy_fallback"));
}

/// The same preprint reached through Crossref (arXiv's DataCite DOI, no id) and
/// through arXiv (id, no DOI) is one record. Without the DOI-to-id alias, only
/// an exact title match could join them.
#[test]
fn an_arxiv_doi_resolves_to_the_arxiv_identity_alias() {
    let from_crossref = test_record(
        "doi:10.48550/arxiv.2301.12345",
        "A Preprint",
        Some("10.48550/arXiv.2301.12345"),
        None,
        None,
    );
    let aliases = super::record_identity_aliases(&from_crossref);
    assert!(
        aliases.contains("arxiv:2301.12345"),
        "expected the arXiv alias, got {aliases:?}"
    );
    assert!(aliases.contains("doi:10.48550/arxiv.2301.12345"));

    // A revised submission is the same preprint, so the version suffix cannot
    // create a second identity.
    let versioned = test_record("arxiv:2301.12345v3", "A Preprint", None, Some("2301.12345v3"), None);
    assert!(super::record_identity_aliases(&versioned).contains("arxiv:2301.12345"));
}

#[test]
fn renders_zotero_style_attachment_names_and_survives_missing_fields() {
    let template = crate::literature::DEFAULT_ATTACHMENT_NAME_TEMPLATE;

    let mut record = test_record("arxiv:1", "Reinforcement Learning: An Introduction", None, None, None);
    record.authors = vec!["Richard S. Sutton".to_string(), "Andrew G. Barto".to_string()];
    record.year = Some(1998);
    assert_eq!(
        crate::render_attachment_stem(&record, template),
        "Sutton - 1998 - Reinforcement Learning An Introduction",
        "the colon is illegal in a Windows path component and must not survive",
    );

    // `Family, Given` is just as common across our source adapters.
    record.authors = vec!["Sutton, Richard S.".to_string()];
    assert_eq!(
        crate::render_attachment_stem(&record, template),
        "Sutton - 1998 - Reinforcement Learning An Introduction",
    );

    // An empty placeholder takes its separator with it rather than leaving
    // `Sutton -  - Title` behind.
    record.year = None;
    assert_eq!(
        crate::render_attachment_stem(&record, template),
        "Sutton - Reinforcement Learning An Introduction",
    );
    record.authors = Vec::new();
    assert_eq!(
        crate::render_attachment_stem(&record, template),
        "Reinforcement Learning An Introduction",
    );

    // CJK titles are truncated by character, never mid-codepoint.
    let long_title = "深度强化学习".repeat(40);
    let mut cjk = test_record("cjk:1", &long_title, None, None, None);
    cjk.authors = vec!["张三".to_string()];
    cjk.year = Some(2026);
    let stem = crate::render_attachment_stem(&cjk, template);
    assert!(stem.starts_with("张三 - 2026 - 深度强化学习"));
    assert!(stem.chars().count() <= 120, "stem was {} chars", stem.chars().count());

    // A template that resolves to nothing still yields a usable, safe name.
    let mut bare = test_record("doi:10.1/x", "", None, None, None);
    bare.authors = Vec::new();
    bare.year = None;
    assert_eq!(crate::render_attachment_stem(&bare, template), "doi 10.1 x");

    // A template cannot smuggle in a path separator: the literal is dropped
    // because nothing had been rendered before it, and any separator that did
    // survive would have been sanitized away.
    for template in ["../{title}", "{creator}/../{title}", "{creator}\\{title}"] {
        let stem = crate::render_attachment_stem(&record, template);
        assert!(
            !stem.contains('/') && !stem.contains('\\') && !stem.contains(".."),
            "{template:?} produced a traversable stem: {stem:?}",
        );
    }
}

#[test]
fn library_preferences_default_and_round_trip() {
    let workspace = tempfile::tempdir().expect("workspace");
    let mut store = open_literature_store_at(workspace.path()).expect("open store");
    let defaults = store.library_preferences().expect("defaults");
    assert_eq!(
        defaults.attachment_name_template,
        crate::literature::DEFAULT_ATTACHMENT_NAME_TEMPLATE,
    );
    assert!(!defaults.rename_attachments_on_import);

    let saved = store
        .set_library_preferences(&crate::LibraryPreferences {
            attachment_name_template: "  {citationKey}  ".to_string(),
            rename_attachments_on_import: true,
        })
        .expect("save preferences");
    assert_eq!(saved.attachment_name_template, "{citationKey}");
    assert_eq!(store.library_preferences().expect("reload"), saved);

    // An empty template falls back rather than producing nameless files.
    let reset = store
        .set_library_preferences(&crate::LibraryPreferences {
            attachment_name_template: "   ".to_string(),
            rename_attachments_on_import: false,
        })
        .expect("reset preferences");
    assert_eq!(
        reset.attachment_name_template,
        crate::literature::DEFAULT_ATTACHMENT_NAME_TEMPLATE,
    );
}

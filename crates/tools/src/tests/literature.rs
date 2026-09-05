use super::*;

fn temp_base(name: &str) -> PathBuf {
    let unique = epoch_millis();
    let base = std::env::temp_dir().join(format!("somniq-lit-{name}-{unique}"));
    std::fs::create_dir_all(&base).expect("create temp base");
    base
}

fn record(id: &str, title: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "authors": [],
        "year": 2026,
        "venue": "arXiv",
        "doi": null,
        "arxivId": id.strip_prefix("arxiv:"),
        "abstract": "An abstract.",
        "url": "https://arxiv.org/abs/x",
        "pdfUrl": "https://arxiv.org/pdf/x.pdf",
        "source": "arXiv",
        "citedBy": null,
    })
}

const ARXIV_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2602.01491v2</id>
    <title>Agentic Literature  Review:
      Planning and Synthesis</title>
    <summary>  A system design for
      grounded review work.  </summary>
    <published>2026-02-03T18:00:00Z</published>
    <author><name>Maya Rivera</name></author>
    <author><name>Li Chen</name></author>
    <arxiv:doi>10.48550/arXiv.2602.01491</arxiv:doi>
    <link href="http://arxiv.org/abs/2602.01491v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2602.01491v2" rel="related" type="application/pdf"/>
  </entry>
</feed>"#;

#[test]
fn arxiv_rate_limit_backoff_uses_server_delay_or_3_6_12_seconds() {
    assert_eq!(ARXIV_MIN_REQUEST_INTERVAL, Duration::from_secs(2));
    assert_eq!(arxiv_fallback_backoff(0, 0), Duration::from_secs(3));
    assert_eq!(arxiv_fallback_backoff(1, 0), Duration::from_secs(6));
    assert_eq!(arxiv_fallback_backoff(2, 0), Duration::from_secs(12));
    assert_eq!(
        arxiv_fallback_backoff(1, ARXIV_BACKOFF_JITTER_MAX_MILLIS),
        Duration::from_millis(6_000 + ARXIV_BACKOFF_JITTER_MAX_MILLIS)
    );

    assert_eq!(
        retry_after_delay_header("47", SystemTime::now()),
        Some(Duration::from_secs(47))
    );
    assert_eq!(
        arxiv_rate_limit_backoff(Some(Duration::from_secs(47)), 0),
        Duration::from_secs(47),
        "Retry-After must never be clipped to a local maximum"
    );

    let now = SystemTime::now();
    let date = httpdate::fmt_http_date(now + Duration::from_secs(120));
    let delay = retry_after_delay_header(&date, now).expect("HTTP-date Retry-After");
    assert!(delay <= Duration::from_secs(120));
    assert!(delay >= Duration::from_secs(118));
}

#[test]
fn arxiv_request_gate_serializes_starts_and_opens_a_shared_circuit() {
    let gate = std::sync::Arc::new(ArxivRequestGate::new(Duration::from_millis(25)));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut workers = Vec::new();
    for _ in 0..3 {
        let gate = std::sync::Arc::clone(&gate);
        let barrier = std::sync::Arc::clone(&barrier);
        let sender = sender.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            sender
                .send(gate.wait_for_request_start())
                .expect("record request start");
        }));
    }
    drop(sender);
    for worker in workers {
        worker.join().expect("gate worker");
    }
    let mut starts = receiver.iter().collect::<Vec<_>>();
    starts.sort_unstable();
    assert!(
        starts.windows(2).all(|window| window[1]
            .checked_duration_since(window[0])
            .is_some_and(|interval| interval >= Duration::from_millis(20))),
        "the global queue must keep request starts apart"
    );

    let circuit_gate = ArxivRequestGate::new(Duration::ZERO);
    circuit_gate.wait_for_request_start();
    circuit_gate.open_circuit(Duration::from_millis(35));
    let wait_started = Instant::now();
    circuit_gate.wait_for_request_start();
    assert!(
        wait_started.elapsed() >= Duration::from_millis(28),
        "an open 429 circuit must delay the next queued request"
    );
}

#[test]
fn arxiv_discovery_gate_fast_fails_queued_requests_while_circuit_is_open() {
    let gate = ArxivRequestGate::new(Duration::ZERO);
    gate.wait_for_request_start();
    gate.open_circuit(Duration::from_secs(30));
    let started = Instant::now();
    let remaining = gate
        .wait_for_request_start_or_open_circuit()
        .expect_err("open discovery circuit must fast-fail");
    assert!(started.elapsed() < Duration::from_millis(50));
    assert!(remaining > Duration::from_secs(29));

    let response = arxiv_open_circuit_response(remaining);
    assert_eq!(response.status, 429);
    assert!(String::from_utf8_lossy(&response.body).contains("circuit is open"));
}

#[test]
fn reports_the_sqlite_store_as_canonical_and_json_as_a_projection() {
    let base = temp_base("storage-status");
    let status = library_storage_status_at(&base).expect("storage status");

    assert_eq!(status.schema_version, runtime::LITERATURE_SCHEMA_VERSION);
    assert!(status.database_path.ends_with("literature.sqlite3"));
    assert!(std::path::Path::new(&status.database_path).is_file());
    assert!(status.database_bytes > 0);
    assert_eq!(status.canonical_record_count, 0);
    assert_eq!(status.search_run_count, 0);
    let health = status.health.as_ref().expect("health requested");
    assert!(health.healthy);
    assert_eq!(health.integrity_check, "ok");
    assert_eq!(health.journal_mode.to_ascii_lowercase(), "wal");
    assert!(status.latest_backup.is_none());
    assert!(std::path::Path::new(&status.projection_path)
        .ends_with(std::path::Path::new("papers").join("library.json")));
    assert!(!status.projection_exists);

    // The integrity check reads every page of the database. The cheap variant
    // reports the same counts and paths without it, which is what the ambient
    // Literature footer asks for.
    let cheap = library_storage_status_with(&base, false).expect("cheap storage status");
    assert!(cheap.health.is_none());
    assert_eq!(cheap.canonical_record_count, status.canonical_record_count);
    assert_eq!(cheap.search_run_count, status.search_run_count);
    assert_eq!(cheap.database_path, status.database_path);
    assert_eq!(cheap.projection_path, status.projection_path);

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn creates_manual_items_and_persists_tag_colors_and_related_links() {
    let base = temp_base("manual-item");
    let created = library_create_item_at(
        &base,
        &json!({
            "itemType": "book",
            "title": "A manually added local reference",
            "creators": [{
                "firstName": "Ada",
                "lastName": "Lovelace",
                "creatorType": "author"
            }]
        }),
    )
    .expect("create manual item");
    let record_id = created["recordId"].as_str().expect("record id").to_string();
    assert_eq!(created["inserted"], true);

    let updated = library_update_relations_at(
        &base,
        &record_id,
        &json!({
            "tags": [{ "tag": "important", "color": "#ef4444" }],
            "relations": [{
                "predicate": "related",
                "target": "https://example.test/reference",
                "targetKind": "uri"
            }]
        }),
    )
    .expect("update item relations");
    assert_eq!(
        updated["relations"]["relations"][0]["target"],
        "https://example.test/reference"
    );

    let model = library_model_at(&base).expect("read library model");
    let tag = model
        .tags
        .iter()
        .find(|tag| tag.name == "important")
        .expect("colored tag");
    assert_eq!(tag.color.as_deref(), Some("#ef4444"));
    let item = model
        .items
        .iter()
        .find(|item| item.item.id == record_id)
        .expect("manual item in model");
    assert_eq!(item.item.item_type, "book");
    assert_eq!(item.relations.len(), 1);

    let duplicate = library_create_item_at(
        &base,
        &json!({ "title": "A manually added local reference" }),
    )
    .expect_err("duplicate manual item should be rejected");
    assert!(duplicate.contains("same title"));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn creates_a_consistent_sqlite_backup_and_reports_it() {
    let base = temp_base("storage-backup");
    let backup = library_create_backup_at(&base).expect("create SQLite backup");

    assert!(std::path::Path::new(&backup.path).is_file());
    assert!(backup.bytes > 0);
    assert!(!backup.created_at.is_empty());

    let status = library_storage_status_at(&base).expect("storage status");
    assert_eq!(
        status.latest_backup.as_ref().map(|value| &value.path),
        Some(&backup.path)
    );
    assert!(status.health.expect("health requested").healthy);

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn applies_a_desktop_delta_without_rewriting_the_library_snapshot() {
    let base = temp_base("storage-delta");
    let original = json!({
        "version": 1,
        "papers": [record("arxiv:delta", "Delta record")],
        "searches": [],
        "collections": [],
        "reviewTasks": [],
        "screenRuns": []
    });
    library_save_at(&base, &original).expect("seed canonical record");

    let changed = json!({
        "id": "arxiv:delta",
        "title": "Delta record",
        "authors": [],
        "venue": "arXiv",
        "abstract": "An abstract.",
        "tags": ["changed-only-this-record"],
        "collectionIds": [],
        "searchIds": [],
        "stage": "read",
        "starred": false,
        "unread": false,
        "source": "arXiv",
        "addedAt": "2026-01-01T00:00:00Z",
        "pdf": { "status": "none" },
        "evidence": [],
        "answerChains": [],
        "pdfAnnotations": []
    });
    let projection = library_apply_delta_at(
        &base,
        &LiteratureLibraryDelta {
            upsert_papers: vec![changed],
            hide_paper_ids: Vec::new(),
            projection_metadata: None,
        },
    )
    .expect("apply targeted change");

    assert_eq!(projection["papers"].as_array().map(Vec::len), Some(1));
    assert_eq!(projection["papers"][0]["stage"], "read");
    assert_eq!(
        projection["papers"][0]["tags"],
        json!(["changed-only-this-record"])
    );
    assert_eq!(
        library_storage_status_at(&base)
            .unwrap()
            .canonical_record_count,
        1
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn imports_zotero_json_into_canonical_records_with_standard_fields() {
    let base = temp_base("zotero-json");
    let export = base.join("zotero.json");
    std::fs::write(
        &export,
        serde_json::to_vec(&json!([{
            "itemType": "book",
            "title": "Local-first Research",
            "creators": [{ "firstName": "Ada", "lastName": "Lovelace", "creatorType": "author" }],
            "date": "2025-03-12",
            "ISBN": "978-1-23456-789-0",
            "citationKey": "lovelace2025local",
            "url": "https://example.test/local-first",
            "tags": [{ "tag": "research" }]
        }]))
        .unwrap(),
    )
    .unwrap();

    let report = library_import_bibliography_at(
        &base,
        &LiteratureBibliographyImportInput {
            source_path: export.to_string_lossy().into_owned(),
            format: Some("zotero-json".to_string()),
        },
    )
    .expect("import Zotero export");
    assert_eq!(report.imported, 1);
    let library = library_load_at(&base).expect("canonical projection");
    assert_eq!(library["papers"][0]["itemType"], "book");
    assert_eq!(library["papers"][0]["isbn"], "978-1-23456-789-0");
    assert_eq!(library["papers"][0]["citationKey"], "lovelace2025local");

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn loads_a_legacy_library_with_duplicate_authors_without_failing() {
    let base = temp_base("duplicate-authors");
    let papers_dir = base.join("papers");
    std::fs::create_dir_all(&papers_dir).expect("create papers directory");
    std::fs::write(
        papers_dir.join("library.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "papers": [{
                "id": "legacy:duplicate-authors",
                "title": "A Legacy Record With Repeated Authors",
                "authors": ["Ada Lovelace", "Ada Lovelace"],
                "year": 2026,
                "venue": "Journal of Regression Tests",
                "abstract": "The duplicate-author fixture must still load.",
                "stage": "inbox",
                "tags": [],
                "collectionIds": [],
                "searchIds": [],
                "pdf": { "status": "none" },
                "evidence": [],
                "answerChains": [],
                "pdfAnnotations": [],
                "notes": []
            }],
            "searches": [],
            "collections": [],
            "reviewTasks": [],
            "screenRuns": []
        }))
        .expect("encode legacy library"),
    )
    .expect("write legacy library");

    let library = library_load_at(&base).expect("legacy library must load");
    assert_eq!(library["papers"].as_array().map(Vec::len), Some(1));
    let record_id = library["papers"][0]["id"]
        .as_str()
        .expect("canonical record id");

    let model = library_model_at(&base).expect("normalized library model");
    let parent = model
        .items
        .iter()
        .find(|snapshot| snapshot.item.id == record_id)
        .expect("normalized parent item");
    assert_eq!(parent.creators.len(), 1);
    assert_eq!(parent.creators[0].name.as_deref(), Some("Ada Lovelace"));

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn imports_ris_and_bibtex_through_the_same_canonical_pipeline() {
    let base = temp_base("standard-text-imports");
    let ris = base.join("library.ris");
    std::fs::write(&ris, "TY  - CONF\nTI  - Reproducible Literature Systems\nAU  - Chen, Li\nPY  - 2026\nT2  - Research Systems Conference\nDO  - 10.1000/ris-example\nKW  - reproducibility\nER  - \n").unwrap();
    let ris_report = library_import_bibliography_at(
        &base,
        &LiteratureBibliographyImportInput {
            source_path: ris.to_string_lossy().into_owned(),
            format: None,
        },
    )
    .expect("import RIS");
    assert_eq!(ris_report.format, "ris");
    assert_eq!(ris_report.imported, 1);

    let bib = base.join("library.bib");
    std::fs::write(&bib, "@phdthesis{lovelace2026, title={Auditable Research Workspaces}, author={Ada Lovelace and Li Chen}, year={2026}, school={Somniq University}, isbn={978-1-23456-789-0}, keywords={auditability, local-first}}\n").unwrap();
    let bib_report = library_import_bibliography_at(
        &base,
        &LiteratureBibliographyImportInput {
            source_path: bib.to_string_lossy().into_owned(),
            format: None,
        },
    )
    .expect("import BibTeX");
    assert_eq!(bib_report.format, "bibtex");
    assert_eq!(bib_report.imported, 1);

    let library = library_load_at(&base).expect("canonical projection");
    assert_eq!(library["papers"].as_array().map(Vec::len), Some(2));
    let papers = library["papers"].as_array().unwrap();
    assert!(papers
        .iter()
        .any(|paper| paper["itemType"] == "conferencePaper"));
    assert!(papers
        .iter()
        .any(|paper| paper["itemType"] == "thesis" && paper["isbn"] == "978-1-23456-789-0"));
    assert_eq!(
        papers
            .iter()
            .find(|paper| paper["title"] == "Auditable Research Workspaces")
            .unwrap()["citationKey"],
        "lovelace2026"
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn imports_zotero_children_collections_and_common_publication_fields() {
    let base = temp_base("zotero-children");
    let export = base.join("zotero.json");
    std::fs::write(&export, serde_json::to_vec(&json!({
      "collections": [
        { "key": "ROOT", "name": "Literature", "parentCollection": false },
        { "key": "READING", "name": "Reading queue", "parentCollection": "ROOT" }
      ],
      "items": [
        {
            "key": "PARENT", "itemType": "article", "title": "Linked Zotero Record",
            "creators": [{ "firstName": "Grace", "lastName": "Hopper", "creatorType": "author" }],
            "date": "2024-05-16", "publicationTitle": "Journal of Durable Research",
            "volume": "8", "issue": "2", "pages": "10-29", "publisher": "Research Press",
            "place": "London", "edition": "2", "series": "Systems", "language": "en",
            "accessDate": "2026-07-20", "collections": ["READING"]
        },
        { "key": "ATTACH", "itemType": "attachment", "parentItem": "PARENT", "title": "Linked PDF", "path": "storage:linked.pdf", "contentType": "application/pdf" },
        { "key": "NOTE", "itemType": "note", "parentItem": "ATTACH", "note": "<p>Keep this Zotero note.</p>" },
        { "key": "MARK", "itemType": "annotation", "parentItem": "ATTACH", "annotationText": "Durable highlight", "annotationComment": "Keep this comment", "annotationType": "strikethrough", "annotationPosition": "{\"pageIndex\":3,\"rects\":[[10,20,30,40]]}", "annotationPageLabel": "4", "annotationSortIndex": 7, "annotationAuthor": "Ada", "isExternal": true, "annotationColor": "#2EA8E5" }
      ]
    })).unwrap()).unwrap();

    let report = library_import_bibliography_at(
        &base,
        &LiteratureBibliographyImportInput {
            source_path: export.to_string_lossy().into_owned(),
            format: Some("zotero-json".to_string()),
        },
    )
    .expect("import Zotero graph");
    assert_eq!(
        (
            report.imported,
            report.attachments,
            report.notes,
            report.annotations,
            report.collections
        ),
        (1, 1, 1, 1, 2)
    );

    let library = library_load_at(&base).expect("canonical projection");
    let paper = &library["papers"][0];
    assert_eq!(paper["volume"], "8");
    assert_eq!(paper["pages"], "10-29");
    assert_eq!(paper["collectionIds"], json!(["zotero:READING"]));
    assert_eq!(
        paper["attachments"][0]["externalPath"],
        "storage:linked.pdf"
    );
    assert_eq!(
        paper["notes"][0]["content"],
        "<p>Keep this Zotero note.</p>"
    );
    assert_eq!(paper["pdfAnnotations"][0]["page"], 4);
    assert_eq!(paper["pdfAnnotations"][0]["style"], "strikethrough");
    assert_eq!(paper["pdfAnnotations"][0]["annotationType"], "strikethrough");
    assert_eq!(paper["pdfAnnotations"][0]["position"]["pageIndex"], 3);
    assert_eq!(paper["pdfAnnotations"][0]["sortIndex"], 7);
    assert_eq!(paper["pdfAnnotations"][0]["author"], "Ada");
    assert_eq!(paper["pdfAnnotations"][0]["isExternal"], true);
    assert!(library["collections"]
        .as_array()
        .is_some_and(|collections| collections
            .iter()
            .any(|collection| collection["id"] == "zotero:READING"
                && collection["label"] == "Reading queue"
                && collection["parentId"] == "zotero:ROOT")));
    assert!(library["collections"]
        .as_array()
        .is_some_and(|collections| collections
            .iter()
            .any(|collection| collection["id"] == "zotero:ROOT"
                && collection["label"] == "Literature")));

    let zotero = library_export_bibliography_at(
        &base,
        &LiteratureBibliographyExportInput {
            format: "zotero-json".to_string(),
            record_ids: vec![paper["id"].as_str().unwrap().to_string()],
        },
    )
    .expect("export nested Zotero graph");
    let root: Value = serde_json::from_str(&zotero.content).expect("valid nested Zotero JSON");
    let items = root["items"].as_array().expect("Zotero items");
    assert_eq!(items.len(), 4);
    assert_eq!(
        items
            .iter()
            .find(|item| item["key"] == "NOTE")
            .and_then(|item| item["parentItem"].as_str()),
        Some("ATTACH")
    );
    assert_eq!(
        items
            .iter()
            .find(|item| item["key"] == "MARK")
            .and_then(|item| item["parentItem"].as_str()),
        Some("ATTACH")
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn zotero_relations_round_trip_through_the_normalized_item_graph() {
    let base = temp_base("zotero-relations");
    let export = base.join("zotero.json");
    std::fs::write(
        &export,
        serde_json::to_vec(&json!({
            "items": [
                {
                    "key": "RELATEA",
                    "itemType": "article",
                    "title": "Relation source",
                    "relations": {
                        "dc:relation": [
                            "http://zotero.org/users/local/items/RELATEB"
                        ]
                    }
                },
                {
                    "key": "RELATEB",
                    "itemType": "article",
                    "title": "Relation target"
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let report = library_import_bibliography_at(
        &base,
        &LiteratureBibliographyImportInput {
            source_path: export.to_string_lossy().into_owned(),
            format: Some("zotero-json".to_string()),
        },
    )
    .expect("import Zotero relations");
    assert_eq!(report.imported, 2);
    let library = library_load_at(&base).expect("load normalized projection");
    let source = library["papers"]
        .as_array()
        .and_then(|papers| papers.iter().find(|paper| paper["title"] == "Relation source"))
        .expect("source paper");
    assert_eq!(source["relations"][0]["predicate"], "dc:relation");
    let target_id = library["papers"]
        .as_array()
        .and_then(|papers| papers.iter().find(|paper| paper["title"] == "Relation target"))
        .and_then(|paper| paper["id"].as_str())
        .expect("target id");
    assert_eq!(source["relations"][0]["target"], target_id);

    let zotero = library_export_bibliography_at(
        &base,
        &LiteratureBibliographyExportInput {
            format: "zotero-json".to_string(),
            record_ids: vec![source["id"].as_str().unwrap().to_string()],
        },
    )
    .expect("export Zotero relations");
    let root: Value = serde_json::from_str(&zotero.content).expect("valid Zotero relation export");
    assert_eq!(
        root["items"][0]["relations"]["dc:relation"][0],
        "http://zotero.org/users/local/items/RELATEB"
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn exports_canonical_records_as_bibtex_biblatex_ris_and_csl_json() {
    let base = temp_base("bibliography-export");
    let library = json!({
        "version": 1,
        "papers": [{
            "id": "doi:10.1000/export",
            "title": "Exporting Local-First Literature",
            "itemType": "article",
            "authors": ["Ada Lovelace", "Chen, Li"],
            "creators": [
                { "firstName": "Ada", "lastName": "Lovelace", "creatorType": "author" },
                { "name": "Chen, Li", "creatorType": "author" },
                { "firstName": "Grace", "lastName": "Hopper", "creatorType": "editor" },
                { "name": "Research Methods Institute", "creatorType": "institution" }
            ],
            "year": 2026,
            "venue": "Journal of Research Tools",
            "doi": "10.1000/export",
            "isbn": "978-1-23456-789-0",
            "citationKey": "lovelace2026export",
            "volume": "12", "issue": "3", "pages": "44-57", "publisher": "Research Press",
            "place": "Berlin", "edition": "2", "series": "Local Systems", "language": "en",
            "url": "https://example.test/export",
            "abstract": "A portable local-first bibliography.",
            "tags": ["local-first"],
            "collectionIds": [], "searchIds": [], "stage": "read", "starred": false,
            "unread": false, "source": "test", "addedAt": "2026-01-01T00:00:00Z",
            "pdf": { "status": "none" }, "evidence": [], "answerChains": [], "pdfAnnotations": []
        }],
        "searches": [], "collections": [], "reviewTasks": [], "screenRuns": []
    });
    library_save_at(&base, &library).expect("seed canonical record");

    let export = |format: &str| {
        library_export_bibliography_at(
            &base,
            &LiteratureBibliographyExportInput {
                format: format.to_string(),
                record_ids: vec!["doi:10.1000/export".to_string()],
            },
        )
        .expect("export bibliography")
    };
    let bibtex = export("bibtex");
    assert_eq!(bibtex.exported, 1);
    assert!(bibtex.content.contains("@article{lovelace2026export"));
    assert!(bibtex.content.contains("doi = {10.1000/export}"));
    assert!(bibtex
        .content
        .contains("author = {Ada Lovelace and Chen, Li}"));
    assert!(bibtex.content.contains("editor = {Grace Hopper}"));
    assert!(bibtex
        .content
        .contains("x-creator-institution = {Research Methods Institute}"));
    assert!(bibtex.content.contains("pages = {44-57}"));
    assert!(bibtex.content.contains("publisher = {Research Press}"));

    let biblatex = export("biblatex");
    assert!(biblatex.content.contains("date = {2026}"));
    assert!(biblatex
        .content
        .contains("journaltitle = {Journal of Research Tools}"));
    assert!(biblatex.content.contains("location = {Berlin}"));

    let ris = export("ris");
    assert!(ris.content.contains("TY  - JOUR"));
    assert!(ris.content.contains("ID  - lovelace2026export"));
    assert!(ris.content.contains("A2  - Grace Hopper"));
    assert!(ris.content.contains("A4  - Research Methods Institute"));

    let csl = export("csl-json");
    let items: Value = serde_json::from_str(&csl.content).expect("valid CSL JSON");
    assert_eq!(items[0]["id"], "lovelace2026export");
    assert_eq!(items[0]["type"], "article-journal");
    assert_eq!(items[0]["DOI"], "10.1000/export");
    assert_eq!(items[0]["editor"][0]["family"], "Hopper");
    assert_eq!(
        items[0]["x-creator-roles"][3]["role"],
        "institution"
    );

    let zotero = export("zotero-json");
    let zotero_root: Value = serde_json::from_str(&zotero.content).expect("valid Zotero JSON");
    assert_eq!(zotero_root["items"][0]["itemType"], "journalArticle");
    assert_eq!(
        zotero_root["items"][0]["title"],
        "Exporting Local-First Literature"
    );
    assert_eq!(zotero_root["items"][0]["DOI"], "10.1000/export");
    assert_eq!(zotero_root["items"][0]["tags"][0]["tag"], "local-first");
    assert!(zotero_root["items"][0]["key"].as_str().is_some());

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn creates_a_canonical_record_for_an_imported_local_pdf() {
    let base = temp_base("pdf-record");
    let report = library_create_pdf_record_at(
        &base,
        "A locally imported PDF",
        "papers/local.pdf",
        42,
        None,
    )
    .expect("create PDF record");
    assert!(report.inserted);
    let library = library_load_at(&base).expect("canonical projection");
    assert_eq!(library["papers"][0]["title"], "A locally imported PDF");
    assert_eq!(library["papers"][0]["pdf"]["path"], "papers/local.pdf");
    assert_eq!(library["papers"][0]["pdf"]["status"], "downloaded");
    library_index_pdf_text_for_record_at(
        &base,
        &report.record_id,
        "Freshly attached PDF text is searchable before a delayed UI projection save.",
    )
    .expect("index PDF text by selected canonical id");
    let search = library_full_text_search_at(&base, "delayed projection", Some(10))
        .expect("search directly indexed PDF text");
    assert_eq!(search["hits"][0]["recordId"], report.record_id);

    let _ = std::fs::remove_dir_all(base);
}

/// A search page is projected from the ranked hits alone, not from a full
/// library projection. It still has to hide trashed records, keep the ranked
/// order, and expose the same ids through the payload-free `paperIds`.
#[test]
fn search_page_projects_only_its_hits_and_hides_trashed_records() {
    let base = temp_base("fts-page-scope");
    let library = json!({
        "version": 1,
        "papers": [
            record("arxiv:page-1", "Beamforming for wideband spectrum"),
            record("arxiv:page-2", "Beamforming under quantized feedback"),
            record("arxiv:page-3", "Unrelated title about gardening"),
        ],
        "searches": [], "collections": [], "reviewTasks": [], "screenRuns": []
    });
    library_save_at(&base, &library).expect("seed canonical records");

    let page = library_full_text_search_page_at(&base, "beamforming", Some(10), Some(0))
        .expect("search page");
    let ids = page["paperIds"]
        .as_array()
        .expect("paperIds")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&"arxiv:page-1"));
    assert!(ids.contains(&"arxiv:page-2"));
    // The projected records must line up with the ids one for one.
    let projected = page["papers"]
        .as_array()
        .expect("papers")
        .iter()
        .filter_map(|paper| paper["id"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(projected, ids);
    assert!(page["papers"][0]["title"].as_str().is_some());

    library_trash_items_at(&base, &["arxiv:page-1".to_string()]).expect("trash one hit");
    let after = library_full_text_search_page_at(&base, "beamforming", Some(10), Some(0))
        .expect("search page after trash");
    let after_ids = after["paperIds"]
        .as_array()
        .expect("paperIds")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert_eq!(after_ids, vec!["arxiv:page-2"]);

    let _ = std::fs::remove_dir_all(base);
}

/// Desktop only needs the ranked ids, so it asks for the page without records.
#[test]
fn search_page_can_omit_record_payloads() {
    let base = temp_base("fts-page-ids-only");
    let library = json!({
        "version": 1,
        "papers": [record("arxiv:ids-1", "Beamforming for wideband spectrum")],
        "searches": [], "collections": [], "reviewTasks": [], "screenRuns": []
    });
    library_save_at(&base, &library).expect("seed canonical records");

    let page = library_full_text_search_page_with(&base, "beamforming", Some(10), Some(0), false)
        .expect("id-only search page");
    assert_eq!(page["paperIds"][0], "arxiv:ids-1");
    assert_eq!(page["total"], 1);
    assert!(page["papers"].as_array().expect("papers").is_empty());

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn parses_arxiv_atom_entries() {
    let papers = parse_arxiv_feed(ARXIV_FIXTURE).expect("fixture should parse");
    assert_eq!(papers.len(), 1);
    let paper = &papers[0];
    assert_eq!(paper.id, "arxiv:2602.01491");
    assert_eq!(paper.arxiv_id.as_deref(), Some("2602.01491"));
    assert_eq!(
        paper.title,
        "Agentic Literature Review: Planning and Synthesis"
    );
    assert_eq!(paper.summary, "A system design for grounded review work.");
    assert_eq!(paper.authors, vec!["Maya Rivera", "Li Chen"]);
    assert_eq!(paper.year, Some(2026));
    assert_eq!(paper.published.as_deref(), Some("2026-02-03"));
    assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
    assert_eq!(
        paper.pdf_url.as_deref(),
        Some("http://arxiv.org/pdf/2602.01491v2")
    );
    assert_eq!(paper.venue, "arXiv");
}

/// arXiv answers a rejected query with HTTP 200 and a single error `<entry>`.
/// Parsing it as an ordinary empty page reported a clean, exhausted, zero
/// result search instead of a source failure.
#[test]
fn arxiv_api_error_entries_are_reported_instead_of_read_as_an_empty_page() {
    const ERROR_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_all</id>
    <title>Error</title>
    <summary>incorrect id format for all</summary>
  </entry>
</feed>"#;

    let page = parse_arxiv_feed_with_count(ERROR_FEED).expect("error feed still parses as XML");
    assert!(page.papers.is_empty());
    assert_eq!(page.entry_count, 1);
    assert_eq!(
        page.api_error.as_deref(),
        Some("incorrect id format for all")
    );

    let clean = parse_arxiv_feed_with_count(ARXIV_FIXTURE).expect("fixture should parse");
    assert!(clean.api_error.is_none());
    assert_eq!(clean.entry_count, 1);
    assert_eq!(clean.papers.len(), 1);
}

/// The `start` offset must track the rows arXiv returned, not the rows that
/// parsed, or a single dropped entry shifts every later page back over rows the
/// current page already consumed.
#[test]
fn arxiv_entry_count_tracks_provider_rows_not_parsed_rows() {
    const MIXED_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>40</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Usable Entry</title>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00002v1</id>
    <title></title>
  </entry>
  <entry>
    <id>urn:something-without-an-abs-path</id>
    <title>No Identifier</title>
  </entry>
</feed>"#;

    let page = parse_arxiv_feed_with_count(MIXED_FEED).expect("feed should parse");
    assert_eq!(page.papers.len(), 1, "two entries are unusable");
    assert_eq!(page.entry_count, 3, "all three rows were consumed");
    assert_eq!(page.total_results, Some(40));
    assert!(page.api_error.is_none());
}

#[test]
fn maps_crossref_items_and_strips_jats_abstract() {
    let item = json!({
        "DOI": "10.1145/Example.1024",
        "title": ["Grounded PDF  Summarization"],
        "author": [
            { "given": "Sana", "family": "Iyer" },
            { "family": "Almeida" }
        ],
        "issued": { "date-parts": [[2025, 4]] },
        "container-title": ["CHI Late Breaking Work"],
        "abstract": "<jats:p>An interface &amp; annotation study.</jats:p>",
        "URL": "https://doi.org/10.1145/example.1024",
        "is-referenced-by-count": 12,
        "link": [
            { "URL": "https://dl.acm.org/example.pdf", "content-type": "application/pdf" }
        ]
    });
    let paper = crossref_item_to_paper(&item).expect("item should map");
    assert_eq!(paper.id, "doi:10.1145/example.1024");
    assert_eq!(paper.title, "Grounded PDF Summarization");
    assert_eq!(paper.authors, vec!["Sana Iyer", "Almeida"]);
    assert_eq!(paper.year, Some(2025));
    assert_eq!(paper.venue, "CHI Late Breaking Work");
    assert_eq!(paper.summary, "An interface & annotation study.");
    assert_eq!(
        paper.pdf_url.as_deref(),
        Some("https://dl.acm.org/example.pdf")
    );
    assert_eq!(paper.cited_by, Some(12));
}

#[test]
fn maps_openalex_works_and_rebuilds_inverted_abstract() {
    let work = json!({
        "id": "https://openalex.org/W4399100000",
        "doi": "https://doi.org/10.48550/arXiv.2602.01491",
        "title": "Agentic Literature  Review: Planning and Synthesis",
        "publication_year": 2026,
        "publication_date": "2026-02-03",
        "authorships": [
            { "author": { "display_name": "Maya Rivera" } },
            { "author": { "display_name": "Li Chen" } }
        ],
        "primary_location": {
            "source": { "display_name": "arXiv" },
            "landing_page_url": "https://arxiv.org/abs/2602.01491v2",
            "pdf_url": null
        },
        "best_oa_location": { "pdf_url": "https://arxiv.org/pdf/2602.01491" },
        "open_access": { "oa_url": "https://arxiv.org/abs/2602.01491" },
        "cited_by_count": 31,
        "abstract_inverted_index": {
            "grounded": [4],
            "A": [0],
            "system": [1],
            "for": [3],
            "design": [2],
            "review.": [5]
        }
    });
    let paper = openalex_work_to_paper(&work).expect("work should map");
    assert_eq!(paper.id, "openalex:W4399100000");
    assert_eq!(
        paper.title,
        "Agentic Literature Review: Planning and Synthesis"
    );
    assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
    assert_eq!(paper.arxiv_id.as_deref(), Some("2602.01491"));
    assert_eq!(paper.authors, vec!["Maya Rivera", "Li Chen"]);
    assert_eq!(paper.year, Some(2026));
    assert_eq!(paper.venue, "arXiv");
    assert_eq!(paper.summary, "A system design for grounded review.");
    assert_eq!(
        paper.url.as_deref(),
        Some("https://doi.org/10.48550/arXiv.2602.01491")
    );
    assert_eq!(
        paper.pdf_url.as_deref(),
        Some("https://arxiv.org/pdf/2602.01491")
    );
    assert_eq!(paper.cited_by, Some(31));
    assert_eq!(paper.source, "OpenAlex");
}

#[test]
fn openalex_falls_back_to_landing_page_arxiv_id() {
    let work = json!({
        "id": "https://openalex.org/W123",
        "title": "Paper",
        "primary_location": {
            "landing_page_url": "https://arxiv.org/abs/2409.01010v3"
        }
    });
    let paper = openalex_work_to_paper(&work).expect("work should map");
    assert_eq!(paper.arxiv_id.as_deref(), Some("2409.01010"));
    assert!(paper.doi.is_none());
}

#[test]
fn maps_scopus_entries() {
    let entry = json!({
        "dc:identifier": "SCOPUS_ID:85190000001",
        "eid": "2-s2.0-85190000001",
        "dc:title": "Congestion Control  for Satellite Networks",
        "dc:creator": "Iyer S.",
        "author": [
            { "authname": "Iyer S." },
            { "authname": "Almeida P." }
        ],
        "prism:publicationName": "IEEE Transactions on Networking",
        "prism:coverDate": "2025-04-01",
        "prism:doi": "10.1109/Example.2025.42",
        "dc:description": "We study congestion control &amp; queueing.",
        "citedby-count": "17",
        "link": [
            { "@ref": "self", "@href": "https://api.elsevier.com/content/abstract/scopus_id/85190000001" },
            { "@ref": "scopus", "@href": "https://www.scopus.com/inward/record.uri?eid=2-s2.0-85190000001" }
        ]
    });
    let paper = scopus_entry_to_paper(&entry).expect("entry should map");
    assert_eq!(paper.id, "scopus:85190000001");
    assert_eq!(paper.title, "Congestion Control for Satellite Networks");
    assert_eq!(paper.authors, vec!["Iyer S.", "Almeida P."]);
    assert_eq!(paper.year, Some(2025));
    assert_eq!(paper.venue, "IEEE Transactions on Networking");
    assert_eq!(paper.doi.as_deref(), Some("10.1109/example.2025.42"));
    assert_eq!(paper.summary, "We study congestion control & queueing.");
    assert_eq!(paper.cited_by, Some(17));
    assert_eq!(
        paper.url.as_deref(),
        Some("https://www.scopus.com/inward/record.uri?eid=2-s2.0-85190000001")
    );
    assert_eq!(paper.pdf_url, None);
    assert_eq!(paper.source, "Scopus");
}

#[test]
fn scopus_empty_result_entry_is_dropped() {
    let entry = json!({ "error": "Result set was empty" });
    assert!(scopus_entry_to_paper(&entry).is_none());
}

#[test]
fn wraps_bare_scopus_queries_without_forcing_long_exact_phrases() {
    assert_eq!(
        scopus_query("satellite  congestion control"),
        "TITLE-ABS-KEY(satellite congestion control)"
    );
    assert_eq!(
        scopus_query("10.1109/TKDE.2020.2981314"),
        "DOI(10.1109/tkde.2020.2981314)"
    );
    assert_eq!(
            scopus_query(
                "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
            ),
            "TITLE-ABS-KEY(Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting)"
        );
    assert_eq!(
        scopus_query("TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"),
        "TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"
    );
    assert_eq!(
        scopus_query("AUTH(rivera) AND KEY(agents)"),
        "AUTH(rivera) AND KEY(agents)"
    );

    let planned = plan_source_query_variants(
        "How does reinforcement learning improve semantic communication systems?",
        "scopus",
    );
    let precision = planned
        .iter()
        .find(|variant| variant.kind == "precision_terms")
        .expect("Scopus precision supplement");
    assert!(precision.query.contains(" AND "));
    assert!(!precision.query.contains("TITLE-ABS-KEY(\""));
    assert!(!planned.iter().any(|variant| variant.kind == "exact_phrase"));
    assert!(!planned
        .iter()
        .any(|variant| variant.kind == "language_variant"));
}

/// A Chinese question reached the providers as one unsegmented token that
/// matched nothing, so it is segmented and translated before it is sent — and
/// Scopus, which refuses CJK outright, gets the English form like every other
/// source.
#[test]
fn chinese_questions_are_segmented_and_translated_into_the_index_language() {
    let draft = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "大语言模型的检索增强生成".to_string(),
        sources: vec!["scopus".to_string()],
        max_results: Some(5),
        time_window: None,
        sort_order: None,
    })
    .expect("a translatable Chinese question compiles");
    let query = &draft.queries["scopus"];
    assert!(
        query.contains("large") && query.contains("language") && query.contains("retrieval"),
        "expected the translated terms, got {query}"
    );
    assert!(
        !contains_cjk(query),
        "Scopus must never receive CJK characters: {query}"
    );
}

/// Scopus joins the default source set whether or not its key is configured, so
/// failing the whole call for its CJK restriction threw away the four sources
/// that could have answered.
#[test]
fn a_chinese_question_still_searches_the_other_default_sources() {
    let draft = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "机器人 导航 的 强化学习".to_string(),
        sources: Vec::new(),
        max_results: Some(5),
        time_window: None,
        sort_order: None,
    })
    .expect("a Chinese question must not fail the whole default-source search");
    for source in ["openalex", "crossref", "arxiv"] {
        assert!(
            !draft.query_variants[source].is_empty(),
            "{source} lost its query"
        );
    }
}

/// A question no source can express is still an error — but it names every
/// source it tried, instead of blaming Scopus alone.
#[test]
fn an_untranslatable_question_reports_every_source_it_could_not_express() {
    let error = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "甲乙丙丁戊己".to_string(),
        sources: vec!["scopus".to_string()],
        max_results: Some(5),
        time_window: None,
        sort_order: None,
    })
    .expect_err("an untranslatable question cannot be searched");
    assert!(error.contains("scopus"), "{error}");
    assert!(error.contains("English"), "{error}");
}

/// The glossary covers research vocabulary, not the language. What it missed
/// has to be named, or a half-translated search looks complete.
#[test]
fn untranslated_question_terms_are_reported_rather_than_dropped_silently() {
    let variants = plan_source_query_variants("量子 甲乙丙丁 的 优化", "openalex");
    let broad = variants
        .iter()
        .find(|variant| variant.kind == "broad_keywords")
        .expect("broad variant");
    assert!(broad.query.contains("quantum") && broad.query.contains("optimization"));
    assert!(
        broad.rationale.contains("甲乙丙丁"),
        "the untranslated term must be named: {}",
        broad.rationale
    );
}

#[test]
fn scopus_probe_rejects_chinese_before_reading_credentials() {
    let error = scopus_probe("TITLE-ABS-KEY(研究 AND model)", 5)
        .expect_err("Chinese Scopus queries must not reach the provider");
    assert!(error.contains("Chinese/CJK"));
}

#[test]
fn parses_ieee_stamp_pdf_routes() {
    assert_eq!(
        parse_ieee_arnumber("https://ieeexplore.ieee.org/document/9039685/").as_deref(),
        Some("9039685")
    );
    assert_eq!(
        parse_ieee_arnumber(
            "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9039685&ref="
        )
        .as_deref(),
        Some("9039685")
    );
}

#[test]
fn extracts_sciencedirect_pdfft_links() {
    let html = r#"
          <a aria-label="View PDF" href="/science/article/pii/S0010482520301621/pdfft?md5=abc&amp;pid=main.pdf">ViewPDF</a>
        "#;
    let href = find_sciencedirect_pdf_href(html).expect("href");
    assert_eq!(
            absolutize_sciencedirect_url(&href),
            "https://www.sciencedirect.com/science/article/pii/S0010482520301621/pdfft?md5=abc&pid=main.pdf"
        );
}

#[test]
fn maps_elsevier_linkinghub_pii_to_sciencedirect_page() {
    assert_eq!(
        sciencedirect_article_page_url(
            "https://linkinghub.elsevier.com/retrieve/pii/S0020025526001908"
        )
        .as_deref(),
        Some("https://www.sciencedirect.com/science/article/pii/S0020025526001908")
    );
}

#[test]
fn builds_ieee_browser_download_task() {
    let paper = RemotePaper {
        id: "doi:10.1109/tkde.2020.2981314".into(),
        title: "A Survey on Deep Learning for Named Entity Recognition".into(),
        authors: Vec::new(),
        year: Some(2022),
        venue: "IEEE Transactions on Knowledge and Data Engineering".into(),
        doi: Some("10.1109/tkde.2020.2981314".into()),
        arxiv_id: None,
        summary: String::new(),
        url: Some("https://ieeexplore.ieee.org/document/9039685/".into()),
        pdf_url: None,
        source: "IEEE".into(),
        published: None,
        cited_by: None,
    };
    let task = browser_download_task_for_paper(&paper)
        .expect("task")
        .expect("publisher task");
    assert_eq!(task["publisher"], "IEEE");
    assert_eq!(
        task["pdf_url"],
        "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9039685&ref="
    );
}

#[test]
fn builds_sciencedirect_browser_download_task() {
    let paper = RemotePaper {
        id: "doi:10.1016/j.compbiomed.2020.103792".into(),
        title: "COVID-19 diagnosis using artificial intelligence".into(),
        authors: Vec::new(),
        year: Some(2020),
        venue: "Computers in Biology and Medicine".into(),
        doi: Some("10.1016/j.compbiomed.2020.103792".into()),
        arxiv_id: None,
        summary: String::new(),
        url: Some("https://www.sciencedirect.com/science/article/pii/S0010482520301621".into()),
        pdf_url: None,
        source: "ScienceDirect".into(),
        published: None,
        cited_by: None,
    };
    let task = browser_download_task_for_paper(&paper)
        .expect("task")
        .expect("publisher task");
    assert_eq!(task["publisher"], "Elsevier/ScienceDirect");
    assert_eq!(task["extractor"], "sciencedirect_viewpdf");
    assert_eq!(
        task["page_url"],
        "https://www.sciencedirect.com/science/article/pii/S0010482520301621"
    );
}

#[test]
fn builds_sciencedirect_browser_task_from_elsevier_linkinghub() {
    let paper = RemotePaper {
            id: "doi:10.1016/j.ins.2026.123259".into(),
            title: "Reinforcement learning-guided angle PSO for optimizing echo state networks in wind power forecasting".into(),
            authors: Vec::new(),
            year: Some(2026),
            venue: "Information Sciences".into(),
            doi: Some("10.1016/j.ins.2026.123259".into()),
            arxiv_id: None,
            summary: String::new(),
            url: Some("https://linkinghub.elsevier.com/retrieve/pii/S0020025526001908".into()),
            pdf_url: None,
            source: "Scopus".into(),
            published: None,
            cited_by: None,
        };
    let task = browser_download_task_for_paper(&paper)
        .expect("task")
        .expect("publisher task");
    assert_eq!(task["publisher"], "Elsevier/ScienceDirect");
    assert_eq!(task["extractor"], "sciencedirect_viewpdf");
    assert_eq!(
        task["page_url"],
        "https://www.sciencedirect.com/science/article/pii/S0020025526001908"
    );
}

#[test]
fn normalizes_mdpi_pdf_urls_to_an_article_session_route() {
    assert_eq!(
        mdpi_article_page_url("https://www.mdpi.com/2071-1050/15/1/123/pdf?version=1670000000")
            .as_deref(),
        Some("https://www.mdpi.com/2071-1050/15/1/123")
    );
    assert!(mdpi_article_page_url("https://example.com/article/pdf").is_none());
}

#[test]
fn builds_mdpi_browser_download_task() {
    let paper = RemotePaper {
        id: "doi:10.3390/su15010123".into(),
        title: "An Open Access MDPI Paper".into(),
        authors: Vec::new(),
        year: Some(2023),
        venue: "Sustainability".into(),
        doi: None,
        arxiv_id: None,
        summary: String::new(),
        url: Some("https://www.mdpi.com/2071-1050/15/1/123".into()),
        pdf_url: None,
        source: "MDPI".into(),
        published: None,
        cited_by: None,
    };
    let task = browser_download_task_for_paper(&paper)
        .expect("task")
        .expect("MDPI browser task");
    assert_eq!(task["publisher"], "MDPI");
    assert_eq!(task["page_url"], "https://www.mdpi.com/2071-1050/15/1/123");
    assert_eq!(
        task["pdf_url"],
        "https://www.mdpi.com/2071-1050/15/1/123/pdf"
    );
}

#[test]
fn browser_download_task_for_url_covers_every_supported_publisher() {
    let mdpi = browser_download_task_for_url(
        "https://www.mdpi.com/1424-8220/23/7/3762/pdf?version=1680753458",
        "s23073762.pdf",
    )
    .expect("MDPI browser task");
    assert_eq!(mdpi["publisher"], "MDPI");
    assert_eq!(mdpi["page_url"], "https://www.mdpi.com/1424-8220/23/7/3762");

    let ieee =
        browser_download_task_for_url("https://ieeexplore.ieee.org/document/9039685/", "ieee.pdf")
            .expect("IEEE browser task");
    assert_eq!(ieee["publisher"], "IEEE");
    assert_eq!(
        ieee["pdf_url"],
        "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9039685&ref="
    );

    let elsevier = browser_download_task_for_url(
        "https://www.sciencedirect.com/science/article/pii/S0010482520301621",
        "elsevier.pdf",
    )
    .expect("ScienceDirect browser task");
    assert_eq!(elsevier["publisher"], "Elsevier/ScienceDirect");
    assert_eq!(elsevier["extractor"], "sciencedirect_viewpdf");
}

#[test]
fn browser_download_task_for_url_does_not_invent_a_publisher_route() {
    // A trailing digits-then-`.pdf` shape is what `parse_ieee_arnumber` keys on,
    // so an unhosted match here would send every arXiv PDF through IEEE.
    assert!(browser_download_task_for_url("https://arxiv.org/pdf/2301.12345.pdf", "x.pdf").is_none());
    assert!(browser_download_task_for_url("https://example.com/paper/pdf", "x.pdf").is_none());
}

#[test]
fn publisher_refusals_are_reported_as_access_barriers_not_retries() {
    let blocked = publisher_access_error(403, "https://www.mdpi.com/1424-8220/23/7/3762/pdf");
    assert!(blocked.contains("access barrier"));
    assert!(blocked.contains("cannot succeed"));

    let rate_limited = publisher_access_error(429, "https://example.com/a.pdf");
    assert!(!rate_limited.contains("access barrier"));
    assert!(rate_limited.contains("rate-limited"));
}

#[test]
fn open_access_fallback_compares_urls_without_version_stamps() {
    // MDPI's open-access record points back at the link that was just refused;
    // the fallback must recognize that instead of spending a second request.
    assert_eq!(
        download_url_key("https://www.mdpi.com/1424-8220/23/7/3762/pdf?version=1680753458"),
        download_url_key("https://www.mdpi.com/1424-8220/23/7/3762/pdf")
    );
    assert_ne!(
        download_url_key("https://www.mdpi.com/1424-8220/23/7/3762/pdf"),
        download_url_key("https://europepmc.org/articles/PMC10094836?pdf=render")
    );
}

#[test]
fn doi_hints_accept_every_form_a_paper_id_carries() {
    assert_eq!(
        normalized_doi("doi:10.3390/s23073762").as_deref(),
        Some("10.3390/s23073762")
    );
    assert_eq!(
        normalized_doi("https://doi.org/10.3390/s23073762").as_deref(),
        Some("10.3390/s23073762")
    );
    assert_eq!(normalized_doi("arxiv:2301.12345"), None);
}

#[test]
fn browser_download_task_input_needs_only_url_fields() {
    let input: LiteratureBrowserDownloadTaskInput = serde_json::from_value(serde_json::json!({
        "url": "https://www.mdpi.com/2071-1050/15/1/123/pdf?version=1670000000",
        "title": "An Open Access MDPI Paper",
        "doi": "10.3390/su15010123"
    }))
    .expect("minimal browser task input");

    let task: serde_json::Value =
        serde_json::from_str(&run_literature_browser_download_task(input).expect("browser task"))
            .expect("browser task JSON");
    assert_eq!(task["publisher"], "MDPI");
    assert_eq!(task["page_url"], "https://www.mdpi.com/2071-1050/15/1/123");
    assert_eq!(task["doi"], "10.3390/su15010123");
}

#[test]
fn dedupe_merges_arxiv_and_crossref_records() {
    let arxiv = RemotePaper {
        id: "arxiv:2602.01491".into(),
        title: "Agentic Literature Review: Planning and Synthesis".into(),
        authors: vec!["Maya Rivera".into()],
        year: Some(2026),
        venue: "arXiv".into(),
        doi: None,
        arxiv_id: Some("2602.01491".into()),
        summary: "A system design.".into(),
        url: Some("https://arxiv.org/abs/2602.01491".into()),
        pdf_url: Some("https://arxiv.org/pdf/2602.01491.pdf".into()),
        source: "arXiv".into(),
        published: Some("2026-02-03".into()),
        cited_by: None,
    };
    let crossref = RemotePaper {
        id: "doi:10.48550/arxiv.2602.01491".into(),
        title: "Agentic literature review: planning and synthesis".into(),
        authors: vec!["Maya Rivera".into()],
        year: Some(2026),
        venue: "TMLR".into(),
        doi: Some("10.48550/arxiv.2602.01491".into()),
        arxiv_id: None,
        summary: String::new(),
        url: Some("https://doi.org/10.48550/arxiv.2602.01491".into()),
        pdf_url: None,
        source: "Crossref".into(),
        published: None,
        cited_by: Some(31),
    };
    let merged = dedupe(vec![arxiv, crossref]);
    assert_eq!(merged.len(), 1);
    let paper = &merged[0];
    assert_eq!(paper.doi.as_deref(), Some("10.48550/arxiv.2602.01491"));
    assert_eq!(paper.venue, "TMLR");
    assert_eq!(paper.cited_by, Some(31));
    assert_eq!(paper.source, "arXiv + Crossref");
    assert_eq!(
        paper.pdf_url.as_deref(),
        Some("https://arxiv.org/pdf/2602.01491.pdf")
    );
}

#[test]
fn upsert_rejects_untracked_records_instead_of_creating_a_second_write_path() {
    let base = temp_base("upsert-reject");
    let error = library_upsert_at(
        &base,
        &[record("arxiv:1111.00001", "Paper One")],
        Some(&UpsertSearch {
            query: "paper one".into(),
            sources: vec!["arxiv".into()],
        }),
    )
    .expect_err("untracked records must be rejected");
    assert!(error.contains("cannot ingest untracked records"));
    assert_eq!(
        library_load_at(&base).expect("library loads")["papers"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn canonical_records_project_into_library_and_legacy_edits_write_back_to_canonical() {
    let base = temp_base("canonical-library-projection");
    let source_record = record("arxiv:2601.00001", "Protocol Result");
    let canonical = canonical_record_from_remote(&source_record, "run-protocol", "artifact-result");
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let persisted = store
        .upsert_canonical_record(&canonical)
        .expect("persist protocol record")
        .record;
    let protocol = store
        .create_protocol(runtime::SearchProtocolDraft {
            question: "Which protocol result should be screened?".to_string(),
            scope: "projection test".to_string(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec!["arxiv".to_string()],
            queries: BTreeMap::from([("arxiv".to_string(), "local-first review".to_string())]),
            query_variants: BTreeMap::new(),
            max_results: Some(50),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        })
        .expect("create protocol");
    let mut run = store.start_run(&protocol).expect("start run");
    run.record_ids.push(persisted.id.clone());
    run.status = runtime::SearchRunStatus::Completed;
    store.finish_run(&mut run).expect("finish run");

    let mut library = library_load_at(&base).expect("canonical projection");
    assert_eq!(library["papers"].as_array().map(Vec::len), Some(1));
    assert_eq!(library["papers"][0]["id"], persisted.id);
    assert_eq!(
        library["papers"][0]["searchIds"],
        json!([format!("search-run:{}", run.id)])
    );
    assert_eq!(
        library["searches"][0]["id"],
        format!("search-run:{}", run.id)
    );
    assert_eq!(library["searches"][0]["query"], "local-first review");
    library["papers"][0]["stage"] = Value::String("shortlist".to_string());
    library_save_at(&base, &library).expect("legacy write bridge");

    let canonical_after = store
        .load_canonical_record(&persisted.id)
        .expect("load canonical")
        .expect("canonical record");
    assert_eq!(
        canonical_after.metadata["legacyLibrary"]["stage"],
        "shortlist"
    );
    assert_eq!(
        library_load_at(&base).expect("reproject")["papers"][0]["stage"],
        "shortlist"
    );
    let _ = std::fs::remove_dir_all(base);
}
#[test]
fn saved_search_labels_use_the_nested_source_query_not_the_run_id() {
    let mut run = rank_run();
    let started_at = run.started_at.clone();
    run.source_attempts.push(runtime::SourceAttempt {
        source: "arxiv".to_string(),
        request: json!({
            "provider": "arxiv",
            "requests": [{
                "kind": "primary",
                "query": "long-horizon time-series forecasting",
            }],
        }),
        started_at,
        completed_at: Some(runtime::now_iso8601()),
        status: runtime::SourceAttemptStatus::Completed,
        hit_count: Some(1),
        returned_count: 1,
        coverage: runtime::SearchCoverage {
            exhausted: true,
            ..runtime::SearchCoverage::default()
        },
        quota: Value::Null,
        failure_code: None,
        failure_message: None,
        coverage_note: None,
        artifact_ids: Vec::new(),
    });

    assert_eq!(
        projected_search_query(&run, None),
        "long-horizon time-series forecasting"
    );
}

#[test]
fn hides_deleted_search_runs_without_destroying_the_canonical_audit_record() {
    let base = temp_base("hide-search-run");
    let canonical = canonical_record_from_remote(
        &record("arxiv:2601.09999", "Search history record"),
        "run-hidden",
        "artifact-hidden",
    );
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let saved = store
        .upsert_canonical_record(&canonical)
        .expect("persist canonical record")
        .record;
    let protocol = store
        .create_protocol(runtime::SearchProtocolDraft {
            question: "Can saved search history be hidden?".to_string(),
            scope: String::new(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec!["arxiv".to_string()],
            queries: BTreeMap::new(),
            query_variants: BTreeMap::new(),
            max_results: Some(50),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        })
        .expect("create protocol");
    let mut run = store.start_run(&protocol).expect("start run");
    run.record_ids.push(saved.id);
    run.status = runtime::SearchRunStatus::Completed;
    store.finish_run(&mut run).expect("finish run");
    drop(store);

    let _ = library_load_at(&base).expect("initial projection");
    let projection = library_apply_delta_at(
        &base,
        &LiteratureLibraryDelta {
            upsert_papers: Vec::new(),
            hide_paper_ids: Vec::new(),
            projection_metadata: Some(json!({
                "searches": [],
                "hiddenSearchRunIds": [run.id],
            })),
        },
    )
    .expect("hide search run");

    assert!(projection["searches"].as_array().is_some_and(Vec::is_empty));
    assert_eq!(
        library_storage_status_at(&base)
            .expect("storage status")
            .search_run_count,
        1,
    );
    // Deleting has to survive reopening the library, which is the only way a
    // user ever sees the result: the run itself is still in the canonical
    // store, so a lost tombstone silently re-creates the saved search.
    assert!(library_load_at(&base).expect("reload")["searches"]
        .as_array()
        .is_some_and(Vec::is_empty));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn deleting_a_search_run_hides_the_run_and_trashes_its_exclusive_papers() {
    let base = temp_base("delete-search-with-papers");
    let canonical = canonical_record_from_remote(
        &record("arxiv:2601.09998", "Exclusive search result"),
        "run-delete",
        "artifact-delete",
    );
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let saved = store
        .upsert_canonical_record(&canonical)
        .expect("persist canonical record")
        .record;
    let protocol = store
        .create_protocol(runtime::SearchProtocolDraft {
            question: "Does deleting a search remove its exclusive papers?".to_string(),
            scope: String::new(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec!["arxiv".to_string()],
            queries: BTreeMap::new(),
            query_variants: BTreeMap::new(),
            max_results: Some(50),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        })
        .expect("create protocol");
    let mut run = store.start_run(&protocol).expect("start run");
    run.record_ids.push(saved.id.clone());
    run.status = runtime::SearchRunStatus::Completed;
    store.finish_run(&mut run).expect("finish run");
    drop(store);

    let initial = library_load_at(&base).expect("initial projection");
    assert_eq!(initial["papers"].as_array().map(Vec::len), Some(1));
    assert_eq!(initial["searches"].as_array().map(Vec::len), Some(1));

    // Exactly what the Desktop sends when the user deletes a saved search
    // whose results are not shared with any other search.
    let projection = library_apply_delta_at(
        &base,
        &LiteratureLibraryDelta {
            upsert_papers: Vec::new(),
            hide_paper_ids: vec![saved.id.clone()],
            projection_metadata: Some(json!({
                "searches": [],
                "hiddenSearchRunIds": [run.id],
            })),
        },
    )
    .expect("delete search run with its exclusive paper");

    assert!(projection["papers"].as_array().is_some_and(Vec::is_empty));
    assert_eq!(projection["trash"].as_array().map(Vec::len), Some(1));
    assert!(projection["searches"].as_array().is_some_and(Vec::is_empty));

    // The only thing the user ever sees is the reopened library.
    let reloaded = library_load_at(&base).expect("reload");
    assert!(reloaded["papers"].as_array().is_some_and(Vec::is_empty));
    assert_eq!(reloaded["trash"].as_array().map(Vec::len), Some(1));
    assert!(reloaded["searches"].as_array().is_some_and(Vec::is_empty));
    let _ = std::fs::remove_dir_all(base);
}

/// Build a store that already holds one completed SearchRun, and return its
/// run id. Several saved-search projection tests need the same fixture.
fn base_with_one_completed_run(name: &str, record_id: &str) -> (PathBuf, String) {
    let base = temp_base(name);
    let canonical = canonical_record_from_remote(
        &record(record_id, "Run-derived saved search result"),
        "run-derived",
        "artifact-derived",
    );
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let saved = store
        .upsert_canonical_record(&canonical)
        .expect("persist canonical record")
        .record;
    let protocol = store
        .create_protocol(runtime::SearchProtocolDraft {
            question: "Does a deleted saved search stay deleted?".to_string(),
            scope: String::new(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec!["arxiv".to_string()],
            queries: BTreeMap::new(),
            query_variants: BTreeMap::new(),
            max_results: Some(50),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        })
        .expect("create protocol");
    let mut run = store.start_run(&protocol).expect("start run");
    run.record_ids.push(saved.id);
    run.status = runtime::SearchRunStatus::Completed;
    store.finish_run(&mut run).expect("finish run");
    drop(store);
    (base, run.id)
}

/// Write the `search-run:<id>` saved-search row an older build stored, which
/// current code refuses to create. `deleted` reproduces a user who already
/// pressed delete before the fix landed.
fn seed_run_mirrored_saved_search(base: &Path, run_id: &str, deleted: bool) {
    let database_path = runtime::literature_root_for(base).join("literature.sqlite3");
    let connection = rusqlite::Connection::open(&database_path).expect("open database");
    connection
        .execute(
            "INSERT INTO library_saved_searches(
               id, library_id, name, query, sources, dynamic, version,
               deleted, created_at, updated_at
             ) VALUES (?1, 'local', ?2, ?2, '[\"arxiv\"]', 0, 1, ?3, ?4, ?4)",
            rusqlite::params![
                format!("search-run:{run_id}"),
                format!("SearchRun {run_id}"),
                i64::from(deleted),
                "2026-08-28T20:22:57Z",
            ],
        )
        .expect("seed a run-mirrored saved search row");
}

/// A run-derived saved search must never be duplicated by the normalized
/// saved-search table.  Older projections wrote `search-run:<id>` rows into
/// `library_saved_searches` without the `searchRunId` field, after which the
/// projection could not tell that the run already had an entry and appended a
/// second row with the same id.
#[test]
fn a_run_mirrored_saved_search_row_is_not_duplicated_by_its_own_search_run() {
    let (base, run_id) = base_with_one_completed_run("dup-saved-search", "arxiv:2601.09997");
    let _ = library_load_at(&base).expect("initial projection");
    seed_run_mirrored_saved_search(&base, &run_id, false);

    let projection = library_load_at(&base).expect("reload");
    let searches = projection["searches"].as_array().expect("searches");
    assert_eq!(
        searches.len(),
        1,
        "one run must project one saved search, got {searches:#?}"
    );
    assert_eq!(searches[0]["searchRunId"].as_str(), Some(run_id.as_str()));
    let _ = std::fs::remove_dir_all(base);
}

/// Deleting such a saved search has to survive a reload. The Desktop deletes
/// it by omitting it from the projection metadata; if the projection then
/// re-materialises it from the surviving SearchRun, the delete button does
/// nothing at all from the user's point of view.
#[test]
fn deleting_a_run_mirrored_saved_search_is_not_resurrected_by_its_search_run() {
    let (base, run_id) = base_with_one_completed_run("resurrect-saved-search", "arxiv:2601.09996");
    let _ = library_load_at(&base).expect("initial projection");
    seed_run_mirrored_saved_search(&base, &run_id, false);

    // Exactly the delta the Desktop sends: the row leaves the saved search
    // list and the run it mirrors is tombstoned. The Desktop can only send
    // that tombstone because the projection tells it which run the entry
    // stands for, which is what a stored `search-run:` row used to hide.
    let projection = library_apply_delta_at(
        &base,
        &LiteratureLibraryDelta {
            upsert_papers: Vec::new(),
            hide_paper_ids: Vec::new(),
            projection_metadata: Some(json!({
                "searches": [],
                "hiddenSearchRunIds": [run_id],
            })),
        },
    )
    .expect("delete the saved search");
    assert!(
        projection["searches"].as_array().is_some_and(Vec::is_empty),
        "delete must clear the saved search, got {:#?}",
        projection["searches"],
    );

    let reloaded = library_load_at(&base).expect("reload");
    assert!(
        reloaded["searches"].as_array().is_some_and(Vec::is_empty),
        "a deleted saved search must not come back from its SearchRun, got {:#?}",
        reloaded["searches"],
    );
    let _ = std::fs::remove_dir_all(base);
}

/// Libraries written before the fix already hold the duplicated rows, and the
/// only record that the user deleted one of them is its `deleted` flag. That
/// intent has to survive the cleanup, or reopening the library restores every
/// saved search the user removed.
#[test]
fn cleaning_up_run_mirrored_rows_keeps_deletions_the_user_already_made() {
    let (base, run_id) = base_with_one_completed_run("cleanup-saved-search", "arxiv:2601.09995");
    let _ = library_load_at(&base).expect("initial projection");
    // Deleting it before the fix only tombstoned the mirrored row, which the
    // projection then ignored.
    seed_run_mirrored_saved_search(&base, &run_id, true);

    // Rewind to what an older build left on disk: the mirrored row is still
    // there and the one-shot cleanup has not run yet.
    let database_path = runtime::literature_root_for(&base).join("literature.sqlite3");
    let connection = rusqlite::Connection::open(&database_path).expect("open database");
    connection
        .execute(
            "DELETE FROM metadata WHERE key = 'saved_search_run_mirror_cleanup_v1'",
            [],
        )
        .expect("rewind the cleanup marker");
    drop(connection);

    let reloaded = library_load_at(&base).expect("reload after cleanup");
    assert!(
        reloaded["searches"].as_array().is_some_and(Vec::is_empty),
        "the cleanup must carry the deletion over to the run tombstone, got {:#?}",
        reloaded["searches"],
    );
    assert_eq!(
        reloaded["hiddenSearchRunIds"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        Some(vec![run_id.as_str()]),
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn library_save_keeps_a_json_backup_while_canonical_store_recovers_the_current_projection() {
    let base = temp_base("save-backup");
    let mut first = empty_library();
    first["projectFocus"] = json!({ "question": "first" });
    library_save_at(&base, &first).expect("save first version");

    let mut second = empty_library();
    second["projectFocus"] = json!({ "question": "second" });
    library_save_at(&base, &second).expect("save second version");

    let backup_path = library_path_at(&base).with_extension("json.bak");
    let backup: Value =
        serde_json::from_str(&std::fs::read_to_string(backup_path).expect("backup should exist"))
            .expect("backup should be valid JSON");
    assert_eq!(backup["projectFocus"]["question"], "first");
    assert_eq!(
        library_load_at(&base).expect("current library")["projectFocus"]["question"],
        "second"
    );
    std::fs::write(library_path_at(&base), "{broken").expect("corrupt current library");
    assert_eq!(
        library_load_at(&base).expect("recover backup")["projectFocus"]["question"],
        "second"
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn upsert_only_refreshes_projection_for_existing_canonical_records() {
    let base = temp_base("upsert-projection");
    let source_record = record("arxiv:1111.00001", "Paper One");
    let canonical = canonical_record_from_remote(&source_record, "run-protocol", "artifact-result");
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let persisted = store
        .upsert_canonical_record(&canonical)
        .expect("persist canonical record")
        .record;
    drop(store);

    let mut library = library_load_at(&base).expect("initial projection");
    library["papers"][0]["stage"] = Value::String("shortlist".to_string());
    library["papers"][0]["starred"] = Value::Bool(true);
    library["papers"][0]["tags"] = json!(["keeper"]);
    library_save_at(&base, &library).expect("save canonical bridge");

    let stats = library_upsert_at(&base, &[json!({ "id": persisted.id })], None)
        .expect("projection refresh should work");
    assert_eq!(stats.added, 0);
    assert_eq!(stats.merged, 1);
    assert_eq!(stats.total, 1);

    let saved = library_load_at(&base).expect("library loads");
    let paper = &saved["papers"][0];
    assert_eq!(paper["stage"], "shortlist");
    assert_eq!(paper["starred"], true);
    assert_eq!(paper["tags"], json!(["keeper"]));
    assert_eq!(paper["title"], "Paper One");
    assert_eq!(paper["abstract"], "An abstract.");
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn sanitizes_pdf_file_names() {
    assert_eq!(sanitize_file_name("2602.01491").unwrap(), "2602.01491.pdf");
    assert_eq!(
        sanitize_file_name("cs/9901002v1 draft").unwrap(),
        "cs-9901002v1-draft.pdf"
    );
    assert_eq!(
        sanitize_file_name("../../etc/passwd").unwrap(),
        "etc-passwd.pdf"
    );
    assert!(sanitize_file_name("  ").is_err());
    assert_eq!(sanitize_file_name("Paper.PDF").unwrap(), "Paper.PDF");
}

#[test]
fn refuses_to_overwrite_an_existing_pdf_before_opening_the_network() {
    let base = temp_base("pdf-no-overwrite");
    let papers = base.join(".somniq/papers");
    std::fs::create_dir_all(&papers).expect("papers directory");
    let existing = papers.join("existing.pdf");
    std::fs::write(&existing, b"%PDF-1.4 original").expect("seed PDF");

    let error = download_pdf_at(
        &base,
        "https://example.invalid/paper.pdf",
        "existing.pdf",
        None,
    )
    .expect_err("existing PDF must not be replaced");
    assert!(error.contains("refusing to overwrite existing PDF"));
    assert_eq!(
        std::fs::read(&existing).expect("existing bytes"),
        b"%PDF-1.4 original"
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn cancelled_pdf_download_returns_before_opening_the_network() {
    let base = temp_base("pdf-cancel");
    let error = download_pdf_at_with_cancel(
        &base,
        "https://example.invalid/paper.pdf",
        "cancelled.pdf",
        None,
        &|| true,
    )
    .expect_err("cancelled download must not open the network");

    assert_eq!(error, "interrupted by user");
    assert!(!base.join(".somniq/papers/cancelled.pdf").exists());
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn strips_arxiv_version_suffixes() {
    assert_eq!(strip_version("2602.01491v2"), "2602.01491");
    assert_eq!(strip_version("2602.01491"), "2602.01491");
    assert_eq!(strip_version("cs/9901002v11"), "cs/9901002");
    assert_eq!(strip_version("cs/9901002"), "cs/9901002");
}

#[test]
fn default_engines_run_published_venues_before_arxiv() {
    // Empty sources = the full core (Scopus, OpenAlex, Semantic Scholar,
    // Crossref) ahead of the arXiv supplement, in priority order. Scopus is
    // planned regardless of key availability so a missing key is recorded as
    // an unauthorised source attempt instead of a silently narrowed search.
    assert_eq!(
        planned_engines(&[]),
        vec![
            Engine::Scopus,
            Engine::OpenAlex,
            Engine::SemanticScholar,
            Engine::Crossref,
            Engine::Arxiv,
        ],
    );
}

#[test]
fn explicit_scopus_runs_even_without_key() {
    // The key error is surfaced as a warning downstream, not by skipping.
    assert_eq!(
        planned_engines(&["scopus".to_string()]),
        vec![Engine::Scopus],
    );
}

#[test]
fn explicit_sources_follow_priority_not_request_order() {
    // arXiv is listed first but still runs last as the supplement.
    assert_eq!(
        planned_engines(&["arxiv".to_string(), "scopus".to_string()]),
        vec![Engine::Scopus, Engine::Arxiv],
    );
}

#[test]
fn scopus_total_results_parses_string_and_number() {
    assert_eq!(
        scopus_total_results(&json!({ "opensearch:totalResults": "137" })),
        137,
    );
    assert_eq!(
        scopus_total_results(&json!({ "opensearch:totalResults": 42 })),
        42,
    );
    assert_eq!(scopus_total_results(&json!({})), 0);
}

#[test]
fn protocol_preview_uses_explicit_sources_and_source_queries() {
    let protocol = runtime::SearchProtocol {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        id: "protocol-test".to_string(),
        revision: 1,
        draft: runtime::SearchProtocolDraft {
            question: "default question".to_string(),
            scope: String::new(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec![
                "arxiv".to_string(),
                "ARXIV".to_string(),
                "crossref".to_string(),
            ],
            queries: std::collections::BTreeMap::from([
                ("arxiv".to_string(), "cat:cs.AI".to_string()),
                ("default".to_string(), "fallback query".to_string()),
            ]),
            query_variants: std::collections::BTreeMap::new(),
            max_results: Some(75),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        },
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };
    assert_eq!(
        effective_protocol_sources(&protocol),
        vec!["arxiv".to_string(), "crossref".to_string()]
    );
    assert_eq!(protocol_query_for(&protocol, "arxiv"), "cat:cs.AI");
    assert_eq!(protocol_query_for(&protocol, "crossref"), "fallback query");
}

#[test]
fn casual_search_creates_source_specific_query_variants_and_bound() {
    let draft = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "retrieval augmented generation evaluation".to_string(),
        sources: vec!["arxiv".to_string(), "semantic_scholar".to_string()],
        max_results: Some(12),
        time_window: None,
        sort_order: None,
    })
    .expect("casual query should create a draft");

    assert_eq!(
        draft.databases,
        vec!["semantic-scholar".to_string(), "arxiv".to_string()]
    );
    assert_eq!(
        draft.queries["semantic-scholar"],
        "retrieval augmented generation evaluation"
    );
    assert_eq!(
        draft.queries["arxiv"],
        "all:(retrieval AND augmented AND generation)"
    );
    assert_eq!(draft.max_results, Some(12));
    // Semantic Scholar's relevance endpoint matches words, not phrases, and
    // does not parse boolean operators, so it gets exactly one stream instead of
    // three near-copies of the same query splitting its budget.
    assert_eq!(
        draft.query_variants["semantic-scholar"]
            .iter()
            .map(|variant| variant.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["broad_keywords"]
    );
    assert!(draft.scope.contains("Automatically created"));
}

#[test]
fn arxiv_initial_query_splits_body_only_clues_into_independent_anchors() {
    let variants = plan_source_query_variants(
        "\"frame rate\" \"recording sessions\" \"excluded\" sign language translation",
        "arxiv",
    );
    assert_eq!(
        variants
            .iter()
            .map(|variant| variant.query.as_str())
            .collect::<Vec<_>>(),
        vec![
            "all:\"frame rate\"",
            "all:\"recording sessions\"",
            "all:(sign AND language AND translation)",
        ],
        "citation/appendix-style clues must not turn discovery into an all-term AND query"
    );
    assert!(variants
        .iter()
        .all(|variant| !variant.query.contains("excluded")));
}

/// Regression for the Deep-02 identification failure: the compiler kept the
/// three terms the caller wrote first, so the words the clue was built from
/// never reached arXiv. The queries below are verbatim from that session.
#[test]
fn arxiv_topic_terms_keep_discriminative_words_over_first_written_words() {
    let queries = |question: &str| {
        plan_source_query_variants(question, "arxiv")
            .into_iter()
            .map(|variant| variant.query)
            .collect::<Vec<_>>()
    };

    let disagreement =
        queries("random network ensemble disagreement imitation learning demonstrations bounded");
    // Was `all:(random AND network AND ensemble)`: `network` and `learning` are
    // in nearly every ML abstract, while `disagreement` is the whole clue.
    assert!(
        disagreement
            .iter()
            .any(|query| query.contains("disagreement")),
        "{disagreement:?}"
    );
    assert!(
        disagreement
            .iter()
            .all(|query| !query.contains("network") && !query.contains("learning")),
        "generic terms must not take a slot from a discriminative one: {disagreement:?}"
    );

    let driving = queries("imitation learning TORCS driving random features frozen models");
    // The named anchor keeps its own query, and `frozen` — dropped entirely
    // before — now reaches the provider on the alternate conjunction.
    assert!(
        driving.contains(&"all:\"TORCS\"".to_string()),
        "{driving:?}"
    );
    assert!(
        driving.iter().any(|query| query.contains("frozen")),
        "{driving:?}"
    );

    // Two conjunctions per call, sharing the strongest anchor but exploring
    // different companions, so one call is no longer one provider query.
    let terms = queries("off-policy attracted suboptimal regions wrong policy converge navigation");
    assert!(terms.len() >= 2, "{terms:?}");
    assert!(
        terms.iter().all(|query| query.contains("off-policy")),
        "the hyphenated technical token ranks first in every conjunction: {terms:?}"
    );
}

/// Equally common terms must keep the caller's order. Ranking by word length
/// would reshuffle them on every query for no gain in selectivity.
#[test]
fn arxiv_topic_terms_do_not_reshuffle_equally_common_words() {
    let variants = plan_source_query_variants("retrieval augmented generation evaluation", "arxiv");
    assert_eq!(
        variants[0].query,
        "all:(retrieval AND augmented AND generation)"
    );
}

#[test]
fn arxiv_initial_query_keeps_named_hypotheses_separate() {
    let variants = plan_source_query_variants(
        "sign language translation BSL-1K How2Sign MuST-C punctuation preprocessing",
        "arxiv",
    );
    assert_eq!(
        variants
            .iter()
            .map(|variant| variant.query.as_str())
            .collect::<Vec<_>>(),
        vec![
            "all:\"BSL-1K\"",
            "all:\"How2Sign\"",
            "all:\"MuST-C\"",
            // Each named hypothesis still gets its own anchor; the topic
            // conjunction rides alongside them rather than absorbing them, so a
            // call with several named entities is no longer spent entirely on
            // those entities.
            "all:(sign AND language AND translation)",
        ],
    );
    assert!(variants
        .iter()
        .all(|variant| !variant.query.contains("punctuation")
            && !variant.query.contains("preprocessing")));
}

#[test]
fn arxiv_explicit_field_syntax_is_not_rewritten_as_casual_keywords() {
    let query = "abs:\"How2Sign\" AND abs:\"frame rate\"";
    let variants = plan_source_query_variants(query, "arxiv");
    assert_eq!(variants.len(), 1);
    assert_eq!(variants[0].kind, "explicit_arxiv");
    assert_eq!(variants[0].query, query);
}

#[test]
fn execution_requires_an_explicit_confirmation_value() {
    let error = run_literature_search_execute(LiteratureSearchExecuteInput {
        protocol_id: "protocol-test".to_string(),
        confirmation: "yes".to_string(),
        max_results: None,
        resume_run_id: None,
        continue_run_id: None,
        variant_budgets: None,
    })
    .expect_err("unconfirmed execution must not open or write a project store");
    assert!(error.contains("confirmation"));
}

#[test]
fn source_failures_are_classified_for_auditable_coverage_gaps() {
    assert_eq!(
        source_failure_status("HTTP status client error (401 Unauthorized)"),
        runtime::SourceAttemptStatus::Unauthorised
    );
    assert_eq!(
        source_failure_status("HTTP status client error (429 Too Many Requests)"),
        runtime::SourceAttemptStatus::RateLimited
    );
    assert_eq!(
        source_failure_status("network connection timed out"),
        runtime::SourceAttemptStatus::Failed
    );
}

#[test]
fn source_adapter_preview_is_sanitized_and_exposes_scopus_downgrade_policy() {
    let request = adapter_request_preview("scopus", "semantic communication", 50);
    assert_eq!(request["authentication"], "SCOPUS_API_KEY (redacted)");
    assert_eq!(request["query"]["view"], "COMPLETE");
    assert_eq!(
        request["fallback"],
        "STANDARD on 401/403 entitlement response"
    );
    assert!(!request.to_string().contains("SCOPUS_API_KEY="));

    // Semantic Scholar's anonymous pool answers 429 rather than results, so
    // without a key the run records the coverage gap instead of spending three
    // retries per query variant proving it again.
    let key = std::env::var("SEMANTIC_SCHOLAR_API_KEY").ok();
    let expected = if key.as_deref().is_some_and(|key| !key.trim().is_empty()) {
        ("available", "confirmed_network_search")
    } else {
        ("missing_credentials", "not_available")
    };
    let semantic = adapter_availability("semantic-scholar");
    assert_eq!((semantic.status, semantic.execution_mode), expected);
}

#[test]
fn interrupted_attempts_are_marked_before_a_resume_retries_them() {
    let mut run = runtime::SearchRun {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        id: "run-test".to_string(),
        revision: 1,
        protocol_id: "protocol-test".to_string(),
        protocol_revision: 1,
        status: runtime::SearchRunStatus::Running,
        started_at: "2026-01-01T00:00:00Z".to_string(),
        completed_at: None,
        source_attempts: vec![runtime::SourceAttempt {
            source: "crossref".to_string(),
            request: json!({}),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: None,
            status: runtime::SourceAttemptStatus::Running,
            hit_count: None,
            returned_count: 0,
            coverage: runtime::SearchCoverage::default(),
            quota: Value::Null,
            failure_code: None,
            failure_message: None,
            coverage_note: None,
            artifact_ids: Vec::new(),
        }],
        record_ids: Vec::new(),
        ranked_records: Vec::new(),
        artifact_ids: Vec::new(),
        notes: Vec::new(),
    };
    assert!(mark_interrupted_attempts(&mut run, "crossref"));
    let attempt = &run.source_attempts[0];
    assert_eq!(attempt.status, runtime::SourceAttemptStatus::Failed);
    assert_eq!(attempt.failure_code.as_deref(), Some("interrupted"));
    assert!(!source_has_completed_attempt(&run, "crossref"));
}

#[test]
fn reciprocal_rank_fusion_preserves_source_ranks_and_orders_cross_source_hits() {
    let mut run = runtime::SearchRun {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        id: "run-rank".to_string(),
        revision: 1,
        protocol_id: "protocol-rank".to_string(),
        protocol_revision: 1,
        status: runtime::SearchRunStatus::Running,
        started_at: "2026-01-01T00:00:00Z".to_string(),
        completed_at: None,
        source_attempts: Vec::new(),
        record_ids: Vec::new(),
        ranked_records: Vec::new(),
        artifact_ids: Vec::new(),
        notes: Vec::new(),
    };
    let ids = BTreeSet::from([
        "doi:cross-source".to_string(),
        "doi:single-source".to_string(),
    ]);
    let ranks = BTreeMap::from([
        (
            "doi:cross-source".to_string(),
            BTreeMap::from([("openalex".to_string(), 4), ("crossref".to_string(), 5)]),
        ),
        (
            "doi:single-source".to_string(),
            BTreeMap::from([("openalex".to_string(), 1)]),
        ),
    ]);
    apply_fused_ranking(
        &mut run,
        &ids,
        &ranks,
        &BTreeMap::new(),
        &RankingTerms::default(),
        &BTreeMap::new(),
        2026,
    );
    assert_eq!(run.record_ids[0], "doi:cross-source");
    assert_eq!(run.ranked_records[0].source_ranks["openalex"], 4);
    assert_eq!(run.ranked_records[0].source_ranks["crossref"], 5);
    assert!(run.ranked_records[0].fused_score_micros > run.ranked_records[1].fused_score_micros);
}

#[test]
fn time_windows_are_validated_and_translated_for_each_provider() {
    let window = parse_time_window("2020-03-15..2024-09-30")
        .expect("valid range")
        .expect("window");
    assert_eq!(window.from_date.as_deref(), Some("2020-03-15"));
    assert_eq!(window.until_date.as_deref(), Some("2024-09-30"));
    assert_eq!(
        crossref_filter(Some(&window)).as_deref(),
        Some("type:journal-article,type:proceedings-article,type:posted-content,type:book-chapter,from-pub-date:2020-03-15,until-pub-date:2024-09-30")
    );
    assert_eq!(
        openalex_filter(Some(&window)).as_deref(),
        Some("type:!paratext,from_publication_date:2020-03-15,to_publication_date:2024-09-30")
    );
    assert_eq!(
        semantic_scholar_year_filter(Some(&window)).as_deref(),
        Some("2020-2024")
    );
    // Content-type filtering is not conditional on a date bound: an unbounded
    // Crossref search is exactly the one that fills up with book front matter.
    assert_eq!(
        crossref_filter(None).as_deref(),
        Some("type:journal-article,type:proceedings-article,type:posted-content,type:book-chapter")
    );
    assert_eq!(openalex_filter(None).as_deref(), Some("type:!paratext"));
    assert!(
        scopus_query_with_time_window("TITLE-ABS-KEY(robot)", Some(&window))
            .contains("PUBYEAR > 2019")
    );
    assert!(arxiv_query_with_time_window("all:(robot)", Some(&window))
        .contains("submittedDate:[202003150000 TO 202409302359]"));

    assert!(parse_time_window("2025-2020").is_err());
    assert!(parse_time_window("last decade").is_err());
}

#[test]
fn continuation_cursors_preserve_exhausted_and_retryable_query_streams() {
    let variants = vec![
        runtime::SearchQueryVariant {
            kind: "broad".to_string(),
            query: "robot learning".to_string(),
            rationale: String::new(),
            max_results: None,
        },
        runtime::SearchQueryVariant {
            kind: "exact".to_string(),
            query: "\"robot learning\"".to_string(),
            rationale: String::new(),
            max_results: None,
        },
    ];
    let decoded = decode_variant_cursors(
        Some(r#"{"broad":"next-123","exact":"__exhausted__"}"#),
        &variants,
    );
    assert_eq!(decoded.get("broad").map(String::as_str), Some("next-123"));
    assert_eq!(
        decoded.get("exact").map(String::as_str),
        Some(EXHAUSTED_VARIANT_CURSOR)
    );

    let legacy = decode_variant_cursors(Some("offset-50"), &variants[..1]);
    assert_eq!(legacy.get("broad").map(String::as_str), Some("offset-50"));
}

/// An even split gave a zero-hit phrase query and a whole-index disjunction the
/// same share as the query that carried the topic. Budget now follows weight,
/// but every stream that fits still gets at least one row.
#[test]
fn protocol_result_bound_is_distributed_across_query_variants_by_weight() {
    let weights = [4, 2, 2, 1];
    assert_eq!(distribute_variant_budget(10, &weights), vec![4, 2, 2, 2]);
    assert_eq!(distribute_variant_budget(9, &weights).iter().sum::<usize>(), 9);
    assert!(distribute_variant_budget(9, &weights)[0] > distribute_variant_budget(9, &weights)[3]);
    assert_eq!(distribute_variant_budget(4, &weights), vec![1, 1, 1, 1]);
    assert_eq!(distribute_variant_budget(3, &weights), vec![1, 1, 1]);
    assert_eq!(distribute_variant_budget(1, &weights), vec![1]);
    assert_eq!(distribute_variant_budget(0, &weights), Vec::<usize>::new());
}

/// The broad stream must outrank a supplement at the same provider rank, or
/// fusion re-promotes exactly the noise the budget split was fixed to avoid.
#[test]
fn broad_stream_budget_and_weight_move_together() {
    let variants = plan_source_query_variants(
        "How does retrieval augmented generation improve factuality of large language models?",
        "openalex",
    );
    let budgets = variant_budgets(50, &variants).expect("budgets");
    let broad = variants
        .iter()
        .position(|variant| variant.kind == "broad_keywords")
        .expect("broad variant");
    assert_eq!(budgets.iter().sum::<usize>(), 50);
    for (index, budget) in budgets.iter().enumerate() {
        if index != broad {
            assert!(
                budgets[broad] > *budget,
                "broad must outspend {}",
                variants[index].kind
            );
            assert!(
                variant_weight(&variants[broad].kind) > variant_weight(&variants[index].kind),
                "broad must outweigh {}",
                variants[index].kind
            );
        }
    }
}

/// Quoting a whole interrogative sentence returned zero works on OpenAlex while
/// still taking a third of the source budget.
#[test]
fn a_question_gets_no_exact_phrase_stream_but_a_title_does() {
    let question = plan_source_query_variants(
        "How does retrieval augmented generation improve factuality?",
        "openalex",
    );
    assert!(!question.iter().any(|variant| variant.kind == "exact_phrase"));

    let title = plan_source_query_variants("Attention Is All You Need", "openalex");
    let phrase = title
        .iter()
        .find(|variant| variant.kind == "exact_phrase")
        .expect("a title is worth an exact-phrase stream");
    assert_eq!(phrase.query, "\"Attention Is All You Need\"");
}

/// The alias expansion used to disjoin every term in the question, which
/// matched 82,736,946 OpenAlex works — effectively the whole index.
#[test]
fn synonym_expansion_widens_one_term_instead_of_disjoining_all_of_them() {
    let variants = plan_source_query_variants("retrieval augmented generation", "openalex");
    let synonym = variants
        .iter()
        .find(|variant| variant.kind == "synonym_expansion")
        .expect("retrieval has an alias");
    assert!(
        synonym.query.contains("(retrieval OR search)"),
        "{}",
        synonym.query
    );
    assert!(synonym.query.contains(" AND "), "{}", synonym.query);
    assert_eq!(synonym.query.matches(" OR ").count(), 1, "{}", synonym.query);
}

/// Crossref and Semantic Scholar parse neither phrases nor boolean operators,
/// so extra streams there are the same loose query written three times.
#[test]
fn word_matching_providers_get_one_stream_not_three() {
    for source in ["crossref", "semantic-scholar"] {
        let kinds = plan_source_query_variants(
            "How does retrieval augmented generation improve factuality of large language models?",
            source,
        )
        .into_iter()
        .map(|variant| variant.kind)
        .collect::<Vec<_>>();
        assert_eq!(kinds, vec!["broad_keywords".to_string()], "{source}");
    }
}

/// Scopus reads adjacent words inside `TITLE-ABS-KEY(...)` as a phrase, so a
/// space-joined term list silently became an eight-word phrase.
#[test]
fn scopus_term_streams_are_always_conjunctive() {
    for variant in plan_source_query_variants(
        "How does retrieval augmented generation improve factuality of large language models?",
        "scopus",
    ) {
        assert!(
            variant.query.starts_with("TITLE-ABS-KEY("),
            "{}",
            variant.query
        );
        assert!(
            variant.query.contains(" AND ") || variant.query.contains(" OR "),
            "{} would reach Scopus as a phrase",
            variant.query
        );
    }
}

#[test]
fn protocol_preview_exposes_the_same_per_variant_budget_used_by_execution() {
    let base = temp_base("variant-budget-preview");
    let created = literature_search_protocol_create_at(
        &base,
        LiteratureSearchProtocolCreateInput {
            protocol: runtime::SearchProtocolDraft {
                question: "retrieval augmented generation evaluation".to_string(),
                scope: "budget preview".to_string(),
                time_window: String::new(),
                sort_order: "relevance".to_string(),
                databases: vec!["arxiv".to_string()],
                queries: BTreeMap::new(),
                query_variants: BTreeMap::new(),
                max_results: Some(10),
                inclusion_criteria: Vec::new(),
                exclusion_criteria: Vec::new(),
                known_key_papers: Vec::new(),
            },
        },
    )
    .expect("create protocol");
    let protocol_id = created["protocol"]["id"]
        .as_str()
        .expect("protocol id")
        .to_string();
    let preview = literature_search_preview_at(&base, LiteratureSearchPreviewInput { protocol_id })
        .expect("preview protocol");
    let variant_plan = preview["plan"][0]["queryVariantPlan"]
        .as_array()
        .expect("variant plan");
    assert_eq!(
        variant_plan
            .iter()
            .filter_map(|variant| variant["maxResults"].as_u64())
            .sum::<u64>(),
        10
    );
    assert!(variant_plan
        .iter()
        .all(|variant| variant["willExecute"] == true));
    let _ = std::fs::remove_dir_all(base);
}

/// A stop must leave a run that is finished, honest about its coverage, and
/// continuable — not a `running` row nobody can resume and not a `failed` one
/// that reads like a broken provider. Cancelling up front also proves the check
/// runs before any provider request, so this test needs no network.
#[test]
fn a_stopped_run_finishes_partial_and_stays_continuable() {
    let base = temp_base("cancelled-search-run");
    let created = literature_search_protocol_create_at(
        &base,
        LiteratureSearchProtocolCreateInput {
            protocol: runtime::SearchProtocolDraft {
                question: "spiking neural network hardware".to_string(),
                scope: "cancellation".to_string(),
                time_window: String::new(),
                sort_order: "relevance".to_string(),
                databases: vec!["openalex".to_string(), "arxiv".to_string()],
                queries: BTreeMap::new(),
                query_variants: BTreeMap::new(),
                max_results: Some(10),
                inclusion_criteria: Vec::new(),
                exclusion_criteria: Vec::new(),
                known_key_papers: Vec::new(),
            },
        },
    )
    .expect("create protocol");
    let protocol_id = created["protocol"]["id"]
        .as_str()
        .expect("protocol id")
        .to_string();

    let mut phases = Vec::new();
    let execution = literature_search_execute_at_with_cancel(
        &base,
        LiteratureSearchExecuteInput {
            protocol_id,
            confirmation: "execute".to_string(),
            max_results: None,
            resume_run_id: None,
            continue_run_id: None,
            variant_budgets: None,
        },
        |progress| {
            phases.push((
                progress["source"].as_str().unwrap_or_default().to_string(),
                progress["phase"].as_str().unwrap_or_default().to_string(),
            ));
        },
        &|| true,
    )
    .expect("a stopped run still returns its record");

    assert_eq!(execution["cancelled"], true);
    // Both sources were reported as stopped, and neither opened a request.
    assert_eq!(
        phases,
        vec![
            ("openalex".to_string(), "cancelled".to_string()),
            ("arxiv".to_string(), "cancelled".to_string()),
        ]
    );
    let run: runtime::SearchRun =
        serde_json::from_value(execution["searchRun"].clone()).expect("search run");
    assert!(
        run.source_attempts.is_empty(),
        "a stop before the first source must not fabricate attempts"
    );
    // `partial` is the only terminal status `continueRunId` accepts, so this is
    // what keeps the protocol resumable instead of stranding the user.
    assert_eq!(run.status, runtime::SearchRunStatus::Partial);
    assert!(run.completed_at.is_some(), "the run must be finished");
    assert!(
        run.notes
            .iter()
            .any(|note| note.contains("stopped by the user")),
        "notes should record why coverage is incomplete: {:?}",
        run.notes
    );

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn protocol_preview_preserves_explicit_path_budgets() {
    let base = temp_base("explicit-path-budget-preview");
    let created = literature_search_protocol_create_at(
        &base,
        LiteratureSearchProtocolCreateInput {
            protocol: runtime::SearchProtocolDraft {
                question: "matrix coverage".to_string(),
                scope: "explicit path budgets".to_string(),
                time_window: String::new(),
                sort_order: "relevance".to_string(),
                databases: vec!["arxiv".to_string()],
                queries: BTreeMap::from([("arxiv".to_string(), "matrix coverage".to_string())]),
                query_variants: BTreeMap::from([(
                    "arxiv".to_string(),
                    vec![
                        runtime::SearchQueryVariant {
                            kind: "abc".to_string(),
                            query: "core evidence".to_string(),
                            rationale: String::new(),
                            max_results: Some(2),
                        },
                        runtime::SearchQueryVariant {
                            kind: "ab".to_string(),
                            query: "domain evidence".to_string(),
                            rationale: String::new(),
                            max_results: Some(5),
                        },
                        runtime::SearchQueryVariant {
                            kind: "bc".to_string(),
                            query: "method evidence".to_string(),
                            rationale: String::new(),
                            max_results: Some(2),
                        },
                        runtime::SearchQueryVariant {
                            kind: "ac".to_string(),
                            query: "baseline evidence".to_string(),
                            rationale: String::new(),
                            max_results: Some(1),
                        },
                    ],
                )]),
                max_results: Some(10),
                inclusion_criteria: Vec::new(),
                exclusion_criteria: Vec::new(),
                known_key_papers: Vec::new(),
            },
        },
    )
    .expect("create protocol");
    let protocol_id = created["protocol"]["id"]
        .as_str()
        .expect("protocol id")
        .to_string();
    let preview = literature_search_preview_at(&base, LiteratureSearchPreviewInput { protocol_id })
        .expect("preview protocol");
    let planned = preview["plan"][0]["queryVariantPlan"]
        .as_array()
        .expect("variant plan");
    assert_eq!(
        planned
            .iter()
            .filter_map(|variant| variant["maxResults"].as_u64())
            .collect::<Vec<_>>(),
        vec![2, 5, 2, 1]
    );
    assert!(planned.iter().all(|variant| variant["willExecute"] == true));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn scopus_publication_date_sort_translates_to_provider_syntax() {
    assert_eq!(
        scopus_sort_parameter("publication_date_desc"),
        Some("-coverDate")
    );
    assert_eq!(scopus_sort_parameter("relevance"), None);
}

#[test]
fn continuation_runs_preserve_cumulative_records_ranks_and_coverage() {
    let base = temp_base("continuation-cumulative");
    let mut store = runtime::open_literature_store_at(&base).expect("store");
    let protocol = store
        .create_protocol(runtime::SearchProtocolDraft {
            question: "cumulative search coverage".to_string(),
            scope: "continuation test".to_string(),
            time_window: String::new(),
            sort_order: "relevance".to_string(),
            databases: vec!["crossref".to_string()],
            queries: BTreeMap::from([(
                "crossref".to_string(),
                "cumulative search coverage".to_string(),
            )]),
            query_variants: BTreeMap::new(),
            max_results: Some(25),
            inclusion_criteria: Vec::new(),
            exclusion_criteria: Vec::new(),
            known_key_papers: Vec::new(),
        })
        .expect("protocol");
    let mut previous = store.start_run(&protocol).expect("previous run");
    previous.record_ids = vec!["doi:10.1000/prior".to_string()];
    previous.ranked_records = vec![runtime::SearchRecordRank {
        record_id: "doi:10.1000/prior".to_string(),
        source_ranks: BTreeMap::from([("crossref".to_string(), 7)]),
        variant_ranks: BTreeMap::new(),
        fused_score_micros: 123,
        ranking_score_micros: 123,
        ranking_signals: runtime::RankingSignals::default(),
    }];
    previous.source_attempts.push(runtime::SourceAttempt {
        source: "crossref".to_string(),
        request: json!({ "query": "cumulative search coverage" }),
        started_at: previous.started_at.clone(),
        completed_at: Some(runtime::now_iso8601()),
        status: runtime::SourceAttemptStatus::Partial,
        hit_count: Some(9),
        returned_count: 1,
        coverage: runtime::SearchCoverage {
            total_hits: Some(9),
            fetched: 9,
            unique: 7,
            exhausted: true,
            next_cursor: None,
            truncated_reason: None,
        },
        quota: Value::Null,
        failure_code: None,
        failure_message: None,
        coverage_note: Some("Provider warning made the prior run partial.".to_string()),
        artifact_ids: Vec::new(),
    });
    previous.status = runtime::SearchRunStatus::Partial;
    previous.completed_at = Some(runtime::now_iso8601());
    store.finish_run(&mut previous).expect("finish previous");
    let previous_id = previous.id.clone();
    drop(store);

    let output = literature_search_execute_at(
        &base,
        LiteratureSearchExecuteInput {
            protocol_id: protocol.id,
            confirmation: "execute".to_string(),
            max_results: None,
            resume_run_id: None,
            continue_run_id: Some(previous_id.clone()),
            variant_budgets: None,
        },
        |_| {},
    )
    .expect("continue exhausted prior source without a network request");
    let run: runtime::SearchRun =
        serde_json::from_value(output["searchRun"].clone()).expect("search run");
    assert_ne!(run.id, previous_id);
    assert_eq!(run.status, runtime::SearchRunStatus::Completed);
    assert_eq!(run.record_ids, vec!["doi:10.1000/prior"]);
    assert_eq!(run.ranked_records[0].source_ranks["crossref"], 7);
    assert_eq!(run.source_attempts[0].coverage.fetched, 9);
    assert_eq!(run.source_attempts[0].coverage.unique, 7);
    assert!(run.source_attempts[0].coverage.exhausted);

    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn scopus_probe_refuses_an_empty_query_without_a_request() {
    let error = scopus_probe("   ", 5).expect_err("an empty probe must not reach the provider");
    assert_eq!(error, "probe query cannot be empty");
}

#[test]
fn explicit_query_variant_budgets_are_preserved_within_the_source_limit() {
    let variants = vec![
        runtime::SearchQueryVariant {
            kind: "core".to_string(),
            query: "core evidence".to_string(),
            rationale: String::new(),
            max_results: Some(2),
        },
        runtime::SearchQueryVariant {
            kind: "domain".to_string(),
            query: "domain evidence".to_string(),
            rationale: String::new(),
            max_results: Some(5),
        },
        runtime::SearchQueryVariant {
            kind: "supplement".to_string(),
            query: "supplement evidence".to_string(),
            rationale: String::new(),
            max_results: None,
        },
    ];
    assert_eq!(
        variant_budgets(10, &variants).expect("budget"),
        vec![2, 5, 3]
    );
    assert!(variant_budgets(6, &variants).is_err());
}

#[test]
fn variant_budget_overrides_only_narrow_and_can_retire_a_stream() {
    let variants = vec![
        runtime::SearchQueryVariant {
            kind: "abc".to_string(),
            query: "core evidence".to_string(),
            rationale: String::new(),
            max_results: Some(50),
        },
        runtime::SearchQueryVariant {
            kind: "ab".to_string(),
            query: "domain evidence".to_string(),
            rationale: String::new(),
            max_results: Some(50),
        },
    ];
    let base = variant_budgets(100, &variants).expect("base budget");
    assert_eq!(base, vec![50, 50]);
    // A caller that already filled one quota retires that stream while the
    // other keeps its protocol ceiling.
    assert_eq!(
        apply_variant_budget_overrides(
            base.clone(),
            &variants,
            Some(&BTreeMap::from([("abc".to_string(), 0)]))
        ),
        vec![0, 50],
    );
    // A remaining-quota override may only take capacity away, never grant more
    // than the approved protocol ceiling.
    assert_eq!(
        apply_variant_budget_overrides(
            base.clone(),
            &variants,
            Some(&BTreeMap::from([("ab".to_string(), 30)]))
        ),
        vec![50, 30],
    );
    assert_eq!(
        apply_variant_budget_overrides(
            base,
            &variants,
            Some(&BTreeMap::from([("ab".to_string(), 999)]))
        ),
        vec![50, 50],
    );
}

#[test]
fn scopus_probe_sample_is_bounded() {
    // A probe answers "does this hit anything"; it is not a retrieval path, so
    // its sample cannot be widened into one by a large `sampleSize`.
    assert_eq!(SCOPUS_PROBE_MAX, 10);
    assert_eq!(usize::MAX.clamp(1, SCOPUS_PROBE_MAX), SCOPUS_PROBE_MAX);
    assert_eq!(0usize.clamp(1, SCOPUS_PROBE_MAX), 1);
}

/// Scopus binds a bare proximity operator across neighbouring `OR` terms. The
/// group below returned 5 records unparenthesised and over a million once each
/// `W/n` expression was closed — an automated review workflow read the
/// difference as "this topic has no literature" for several rounds.
#[test]
fn proximity_chains_are_parenthesised_before_they_reach_scopus() {
    let collapsed = "TITLE-ABS-KEY( time W/3 series OR timeseries OR temporal W/3 forecast* )";
    let (fixed, changed) = balance_scopus_proximity(collapsed);
    assert!(changed);
    assert_eq!(
        fixed,
        "TITLE-ABS-KEY( (time W/3 series) OR timeseries OR (temporal W/3 forecast*) )",
    );

    // A chain of several operators is one expression, not two.
    let (chained, _) = balance_scopus_proximity("large W/3 language W/3 model*");
    assert_eq!(chained, "(large W/3 language W/3 model*)");

    // PRE/n binds the same way.
    let (pre, _) = balance_scopus_proximity("(deep PRE/2 learning OR svm)");
    assert_eq!(pre, "((deep PRE/2 learning) OR svm)");
}

#[test]
fn already_correct_queries_are_left_byte_identical() {
    for query in [
        "TITLE-ABS-KEY((time W/3 series) OR timeseries)",
        "TITLE-ABS-KEY(llm AND \"time series\")",
        "TITLE-ABS-KEY(a OR b OR c)",
        // A quoted phrase that merely looks like an operator is one operand.
        "TITLE-ABS-KEY(\"w/3 pump\" OR valve)",
    ] {
        let (fixed, changed) = balance_scopus_proximity(query);
        assert!(!changed, "rewrote an already-correct query: {query}");
        assert_eq!(fixed, query);
    }
}

#[test]
fn every_scopus_query_is_normalised_on_the_way_out() {
    // The repair belongs to the one choke point all Scopus queries pass, so a
    // pilot search is fixed by the same code path as a probe.
    assert_eq!(
        scopus_query("machine W/3 learning OR svm"),
        "TITLE-ABS-KEY((machine W/3 learning) OR svm)",
    );
}

/// The fingerprint is what retrieval de-duplication charges against the
/// discovery budget, so it must equate exactly the calls that would issue the
/// same provider requests — and only those.
#[test]
fn provider_fingerprint_equates_searches_that_compile_to_the_same_requests() {
    let fingerprint = |query: &str| {
        literature_search_provider_fingerprint(
            &json!({ "query": query, "sources": ["arxiv"] }).to_string(),
        )
        .expect("fingerprint")
    };

    // Different prose, identical provider requests: one request, not two.
    // Scaffolding words, casing and repetition are all stripped by the
    // compiler, so they cannot buy a second slot against the budget.
    assert_eq!(
        fingerprint("inverse reinforcement learning for navigation"),
        fingerprint("the Inverse Reinforcement Learning navigation"),
    );
    assert_eq!(
        fingerprint("imitation imitation learning driving"),
        fingerprint("imitation learning driving"),
    );
    // Materially different terms must stay distinct.
    assert_ne!(
        fingerprint("random network ensemble disagreement demonstrations"),
        fingerprint("suboptimal goal regions off-policy navigation"),
    );
    // Partial overlap is not a duplicate: each call still brings a conjunction
    // the other does not, so neither may be refused.
    assert_ne!(
        fingerprint("inverse reinforcement learning navigation suboptimal goal regions off-policy"),
        fingerprint("inverse reinforcement learning navigation goals off-policy failure attract"),
    );

    // Asking the same question for more rows is a continuation, not a new
    // request, so the row count is not part of the identity.
    let ten = literature_search_provider_fingerprint(
        &json!({ "query": "robot locomotion transfer", "sources": ["arxiv"], "maxResults": 10 })
            .to_string(),
    );
    let fifty = literature_search_provider_fingerprint(
        &json!({ "query": "robot locomotion transfer", "sources": ["arxiv"], "maxResults": 50 })
            .to_string(),
    );
    assert_eq!(ten, fifty);
    assert!(ten.is_some());

    // A different source set is a different set of provider requests.
    let arxiv_only = literature_search_provider_fingerprint(
        &json!({ "query": "robot locomotion transfer", "sources": ["arxiv"] }).to_string(),
    );
    let with_openalex = literature_search_provider_fingerprint(
        &json!({ "query": "robot locomotion transfer", "sources": ["arxiv", "openalex"] })
            .to_string(),
    );
    assert_ne!(arxiv_only, with_openalex);

    assert!(literature_search_provider_fingerprint(r#"{"query":"   "}"#).is_none());
    assert!(literature_search_provider_fingerprint("not json").is_none());
}

/// The two citation providers disagree about identifiers, and arXiv has no
/// citation index at all, so the anchor must be resolved once per provider
/// rather than guessed at inside the traversal.
#[test]
fn citation_anchors_resolve_to_each_provider_addressing_scheme() {
    let arxiv = normalize_citation_anchor("arxiv:1905.06750").expect("arxiv anchor");
    assert_eq!(arxiv.label, "arxiv:1905.06750");
    assert_eq!(arxiv.semantic_scholar_id, "arXiv:1905.06750");
    // OpenAlex only knows the registered DOI form.
    assert_eq!(
        arxiv.openalex_id.as_deref(),
        Some("doi:10.48550/arXiv.1905.06750")
    );

    // A bare id, a versioned id, and the registered DOI are the same paper.
    for raw in [
        "1905.06750",
        "arXiv:1905.06750v3",
        "10.48550/arXiv.1905.06750",
    ] {
        assert_eq!(
            normalize_citation_anchor(raw).expect(raw).label,
            arxiv.label,
            "{raw}"
        );
    }

    let doi = normalize_citation_anchor("10.1145/3292500.3330701").expect("doi anchor");
    assert_eq!(doi.semantic_scholar_id, "DOI:10.1145/3292500.3330701");
    assert_eq!(
        doi.openalex_id.as_deref(),
        Some("doi:10.1145/3292500.3330701")
    );

    // An opaque provider id stays usable where it is understood, and is
    // recorded as unresolvable elsewhere rather than being invented.
    let opaque = normalize_citation_anchor("649def34f8be52c8b66281af98ae884c09aef38b")
        .expect("opaque anchor");
    assert_eq!(
        opaque.semantic_scholar_id,
        "649def34f8be52c8b66281af98ae884c09aef38b"
    );
    assert!(opaque.openalex_id.is_none());

    assert!(normalize_citation_anchor("   ").is_err());
}

#[test]
fn citation_direction_defaults_to_the_incoming_edge() {
    // The incoming edge is the one that answers "which paper cites X", which is
    // the question metadata search cannot express at all.
    assert_eq!(
        CitationDirection::parse(None).expect("default"),
        CitationDirection::Citing
    );
    for alias in ["citing", "CITATIONS", " cited_by "] {
        assert_eq!(
            CitationDirection::parse(Some(alias)).expect(alias),
            CitationDirection::Citing,
            "{alias}"
        );
    }
    for alias in ["references", "cites"] {
        assert_eq!(
            CitationDirection::parse(Some(alias)).expect(alias),
            CitationDirection::References,
            "{alias}"
        );
    }
    assert_eq!(
        CitationDirection::Citing.semantic_scholar_field(),
        "citingPaper"
    );
    assert_eq!(
        CitationDirection::References.semantic_scholar_field(),
        "citedPaper"
    );
    assert!(CitationDirection::parse(Some("sideways")).is_err());
}

/// End-to-end traversal against the live providers. Ignored by default like the
/// other network smoke tests; run explicitly with
/// `cargo test -p tools -- --ignored literature_citations_traverses`.
#[test]
#[ignore = "performs live Semantic Scholar / OpenAlex requests"]
fn literature_citations_traverses_the_incoming_edge_and_persists_a_run() {
    let base = temp_base("citations-live");
    let result = literature_citations_at(
        &base,
        LiteratureCitationsInput {
            paper_id: "arxiv:1905.06750".to_string(),
            direction: None,
            max_results: Some(5),
            cursor: None,
        },
        &|| false,
    )
    .expect("traversal should succeed");

    assert_eq!(result["anchor"], "arxiv:1905.06750");
    assert_eq!(result["direction"], "citing");
    let papers = result["papers"].as_array().expect("papers");
    assert!(!papers.is_empty(), "the anchor is a well-cited paper");
    assert!(papers.len() <= 5, "maxResults must bound the traversal");
    assert!(papers.iter().all(|paper| !paper["title"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .is_empty()));

    // The traversal is as durable and auditable as a metadata search.
    let run: runtime::SearchRun =
        serde_json::from_value(result["searchRun"].clone()).expect("search run");
    assert!(!run.record_ids.is_empty());
    assert!(!run.artifact_ids.is_empty(), "provider bodies are retained");
    assert_eq!(run.source_attempts.len(), 1);

    let store = runtime::open_literature_store_at(&base).expect("store");
    let first = store
        .load_canonical_record(&run.record_ids[0])
        .expect("load")
        .expect("record persisted under its canonical id");
    assert!(!first.title.trim().is_empty());

    let _ = std::fs::remove_dir_all(base);
}

fn remote(id: &str, title: &str, doi: Option<&str>, arxiv_id: Option<&str>, source: &str) -> RemotePaper {
    RemotePaper {
        id: id.to_string(),
        title: title.to_string(),
        authors: Vec::new(),
        year: Some(2023),
        venue: source.to_string(),
        doi: doi.map(str::to_string),
        arxiv_id: arxiv_id.map(str::to_string),
        summary: String::new(),
        url: None,
        pdf_url: None,
        source: source.to_string(),
        published: None,
        cited_by: None,
    }
}

/// arXiv registers its DataCite DOI as `10.48550/arXiv.<id>`, and DOIs are
/// case-insensitive. Matching only the all-lower and all-upper spellings missed
/// the canonical one, so the same preprint reached through Crossref and through
/// arXiv was filed twice.
#[test]
fn an_arxiv_doi_matches_the_arxiv_record_whatever_its_capitalisation() {
    for doi in [
        "10.48550/arXiv.2301.12345",
        "10.48550/arxiv.2301.12345",
        "10.48550/ARXIV.2301.12345",
    ] {
        let from_index = remote("doi:x", "A Paper", Some(doi), None, "Crossref");
        assert_eq!(
            remote_paper_identity_key(&from_index),
            "arxiv:2301.12345",
            "{doi}"
        );
        let merged = dedupe(vec![
            from_index,
            remote("arxiv:2301.12345", "A Paper", None, Some("2301.12345"), "arXiv"),
        ]);
        assert_eq!(merged.len(), 1, "{doi} must merge into one record");
        assert!(merged[0].source.contains("Crossref") && merged[0].source.contains("arXiv"));
    }
}

/// Every adapter already implements a publication-date filter; without a field
/// for it, a one-shot search could not express "papers since 2023" at all.
#[test]
fn a_casual_search_can_bound_its_time_window_and_sort_order() {
    let draft = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "retrieval augmented generation".to_string(),
        sources: vec!["openalex".to_string()],
        max_results: Some(5),
        time_window: Some("2023..2025".to_string()),
        sort_order: Some("date".to_string()),
    })
    .expect("draft");
    assert_eq!(draft.time_window, "2023..2025");
    assert_eq!(draft.sort_order, "date");

    let rejected = casual_search_protocol_draft(&LiteratureSearchInput {
        query: "retrieval augmented generation".to_string(),
        sources: vec!["openalex".to_string()],
        max_results: Some(5),
        time_window: Some("last tuesday".to_string()),
        sort_order: None,
    });
    assert!(
        rejected.is_err(),
        "a malformed bound must be refused before any network call"
    );
}

/// The same question under a different date bound is a different set of
/// provider requests, so it must not be suppressed as a repeat call.
#[test]
fn the_provider_fingerprint_separates_different_time_windows() {
    let unbounded = literature_search_provider_fingerprint(
        r#"{"query":"retrieval augmented generation","sources":["openalex"]}"#,
    )
    .expect("fingerprint");
    let bounded = literature_search_provider_fingerprint(
        r#"{"query":"retrieval augmented generation","sources":["openalex"],"timeWindow":"2023..2025"}"#,
    )
    .expect("fingerprint");
    assert_ne!(unbounded, bounded);
}

/// A dead provider used to be able to hold a chat turn for a quarter of an hour
/// — three 25-second attempts per query variant, across five sources — with
/// nothing to show for it.
#[test]
fn a_search_pass_has_an_overridable_wall_clock_budget() {
    let restore = std::env::var(SEARCH_TIME_BUDGET_ENV).ok();
    std::env::remove_var(SEARCH_TIME_BUDGET_ENV);
    assert_eq!(search_time_budget(), DEFAULT_SEARCH_TIME_BUDGET);

    std::env::set_var(SEARCH_TIME_BUDGET_ENV, "900");
    assert_eq!(search_time_budget(), Duration::from_secs(900));

    // A budget shorter than one provider round trip would make every run
    // partial before it started, so the floor holds.
    std::env::set_var(SEARCH_TIME_BUDGET_ENV, "1");
    assert_eq!(search_time_budget(), MIN_SEARCH_TIME_BUDGET);

    std::env::set_var(SEARCH_TIME_BUDGET_ENV, "not a number");
    assert_eq!(search_time_budget(), DEFAULT_SEARCH_TIME_BUDGET);

    match restore {
        Some(value) => std::env::set_var(SEARCH_TIME_BUDGET_ENV, value),
        None => std::env::remove_var(SEARCH_TIME_BUDGET_ENV),
    }
}

fn rank_run() -> runtime::SearchRun {
    runtime::SearchRun {
        schema_version: runtime::LITERATURE_SCHEMA_VERSION,
        id: "run-rerank".to_string(),
        revision: 1,
        protocol_id: "protocol-rerank".to_string(),
        protocol_revision: 1,
        status: runtime::SearchRunStatus::Running,
        started_at: "2026-01-01T00:00:00Z".to_string(),
        completed_at: None,
        source_attempts: Vec::new(),
        record_ids: Vec::new(),
        ranked_records: Vec::new(),
        artifact_ids: Vec::new(),
        notes: Vec::new(),
    }
}

fn feature(title: &str, year: Option<u32>, cited_by: Option<u64>) -> RankingFeatures {
    RankingFeatures {
        title: title.to_string(),
        year,
        cited_by,
    }
}

/// Verbatim from the measured failure: Crossref listed a Wiley volume's front
/// matter first and OpenAlex listed the field's most-cited survey first, so
/// reciprocal-rank fusion scored them identically and the front matter won the
/// tie-break. Both were rank 1 for their own source.
#[test]
fn re_ranking_lifts_the_on_topic_paper_over_a_round_robin_tie() {
    let mut run = rank_run();
    let ids = BTreeSet::from([
        "doi:10.1002/9781394374717.fmatter".to_string(),
        "doi:10.48550/arxiv.2312.10997".to_string(),
    ]);
    let ranks = BTreeMap::from([
        (
            "doi:10.1002/9781394374717.fmatter".to_string(),
            BTreeMap::from([("crossref".to_string(), 1)]),
        ),
        (
            "doi:10.48550/arxiv.2312.10997".to_string(),
            BTreeMap::from([("openalex".to_string(), 1)]),
        ),
    ]);
    let features = BTreeMap::from([
        (
            "doi:10.1002/9781394374717.fmatter".to_string(),
            feature("Advanced Retrieval-Augmented Generation", Some(2026), Some(0)),
        ),
        (
            "doi:10.48550/arxiv.2312.10997".to_string(),
            feature(
                "Retrieval-Augmented Generation for Large Language Models: A Survey",
                Some(2023),
                Some(704),
            ),
        ),
    ]);
    let terms = RankingTerms::from_question("retrieval augmented generation for large language models");
    apply_fused_ranking(&mut run, &ids, &ranks, &BTreeMap::new(), &terms, &features, 2026);

    assert_eq!(run.record_ids[0], "doi:10.48550/arxiv.2312.10997");
    // Fusion still says they are equal; re-ranking is what separates them.
    assert_eq!(
        run.ranked_records[0].fused_score_micros,
        run.ranked_records[1].fused_score_micros
    );
    assert!(
        run.ranked_records[0].ranking_score_micros > run.ranked_records[1].ranking_score_micros
    );
    assert_eq!(run.ranked_records[0].ranking_signals.title_coverage_millis, 1_000);
    assert!(run.ranked_records[0].ranking_signals.impact_millis.unwrap_or(0) > 0);
    assert_eq!(run.ranked_records[1].ranking_signals.impact_millis, Some(0));
}

/// arXiv publishes no citation count, so counting absence as zero would demote
/// every preprint the moment citation weight was introduced.
#[test]
fn an_unreported_citation_count_is_unknown_rather_than_zero() {
    let mut run = rank_run();
    let ids = BTreeSet::from(["arxiv:2312.10997".to_string(), "doi:stub".to_string()]);
    let ranks = BTreeMap::from([
        (
            "arxiv:2312.10997".to_string(),
            BTreeMap::from([("arxiv".to_string(), 1)]),
        ),
        (
            "doi:stub".to_string(),
            BTreeMap::from([("crossref".to_string(), 1)]),
        ),
    ]);
    let features = BTreeMap::from([
        (
            "arxiv:2312.10997".to_string(),
            feature("Retrieval-Augmented Generation for Large Language Models", Some(2023), None),
        ),
        ("doi:stub".to_string(), feature("Large Language Models", Some(2026), Some(0))),
    ]);
    let terms = RankingTerms::from_question("retrieval augmented generation for large language models");
    apply_fused_ranking(&mut run, &ids, &ranks, &BTreeMap::new(), &terms, &features, 2026);

    assert_eq!(run.record_ids[0], "arxiv:2312.10997");
    assert_eq!(run.ranked_records[0].ranking_signals.impact_millis, None);
}

/// The `original_language` stream exists to find records an index carries in
/// the caller's own language. Scoring those titles only against the translated
/// terms would re-rank them straight back out.
#[test]
fn a_translated_question_still_scores_titles_in_its_original_language() {
    let terms = RankingTerms::from_question("大语言模型的检索增强生成");
    assert!(!terms.index_language.is_empty() && !terms.original_language.is_empty());
    assert!(
        title_coverage_millis("国产大语言模型检索增强生成技术在海关领域的应用研究", &terms) > 0,
        "a Chinese title must score against the caller's own terms"
    );
    assert_eq!(
        title_coverage_millis(
            "Retrieval-Augmented Generation for Large Language Models",
            &terms
        ),
        1_000
    );
}

/// Re-ranking must not overrule agreement between providers: two sources
/// returning the same record is still the stronger signal when the question
/// cannot separate them.
#[test]
fn provider_agreement_still_decides_between_equally_relevant_records() {
    let mut run = rank_run();
    let ids = BTreeSet::from(["doi:both".to_string(), "doi:one".to_string()]);
    let ranks = BTreeMap::from([
        (
            "doi:both".to_string(),
            BTreeMap::from([("openalex".to_string(), 2), ("crossref".to_string(), 2)]),
        ),
        (
            "doi:one".to_string(),
            BTreeMap::from([("openalex".to_string(), 1)]),
        ),
    ]);
    let title = "Retrieval Augmented Generation";
    let features = BTreeMap::from([
        ("doi:both".to_string(), feature(title, Some(2024), Some(10))),
        ("doi:one".to_string(), feature(title, Some(2024), Some(10))),
    ]);
    let terms = RankingTerms::from_question("retrieval augmented generation");
    apply_fused_ranking(&mut run, &ids, &ranks, &BTreeMap::new(), &terms, &features, 2026);
    assert_eq!(run.record_ids[0], "doi:both");
}

/// Register one record with a real file on disk under `papers/`, wired up the
/// way a downloaded PDF actually is: a normalized `library_attachments` row
/// *and* the `legacyLibrary.pdf` compatibility snapshot the reader still uses.
fn seed_record_with_local_pdf(
    base: &Path,
    title: &str,
    authors: &[&str],
    year: u32,
    file_names: &[&str],
) -> String {
    let created = library_create_item_at(
        base,
        &json!({
            "itemType": "journalArticle",
            "title": title,
            "date": year.to_string(),
            "creators": authors
                .iter()
                .map(|name| json!({ "name": name, "creatorType": "author", "fieldMode": "oneField" }))
                .collect::<Vec<_>>(),
        }),
    )
    .expect("create item");
    let record_id = created["recordId"].as_str().expect("record id").to_string();

    let papers = crate::layout::papers_dir_at(base);
    std::fs::create_dir_all(&papers).expect("papers dir");
    let papers_prefix = papers
        .strip_prefix(base)
        .expect("papers under base")
        .to_string_lossy()
        .replace('\\', "/");
    let mut attachments = Vec::new();
    for (index, file_name) in file_names.iter().enumerate() {
        std::fs::write(papers.join(file_name), b"%PDF-1.7\n").expect("write pdf");
        attachments.push(json!({
            "id": format!("attachment:{record_id}:{index}"),
            "label": file_name,
            "kind": "pdf",
            "path": format!("{papers_prefix}/{file_name}"),
            "filename": file_name,
        }));
    }
    let primary_path = attachments[0]["path"].as_str().expect("path").to_string();
    // The delta path is a *complete* snapshot: fields it omits are cleared, so
    // the identity fields have to be repeated here or the record loses its
    // authors and year — which is exactly what the file name is built from.
    library_apply_delta_at(
        base,
        &LiteratureLibraryDelta {
            upsert_papers: vec![json!({
                "id": record_id,
                "title": title,
                "authors": authors,
                "year": year,
                "pdf": { "status": "downloaded", "path": primary_path },
            })],
            hide_paper_ids: Vec::new(),
            projection_metadata: None,
        },
    )
    .expect("record the compatibility pdf path");
    library_update_relations_at(base, &record_id, &json!({ "attachments": attachments }))
        .expect("attach pdfs");
    record_id
}

fn projected_paper(base: &Path, record_id: &str) -> Value {
    library_load_at(base).expect("reload")["papers"]
        .as_array()
        .expect("papers")
        .iter()
        .find(|paper| paper["id"] == record_id)
        .cloned()
        .expect("paper in projection")
}

#[test]
fn renaming_attachments_previews_before_it_moves_anything() {
    let base = temp_base("rename-dry-run");
    let record_id = seed_record_with_local_pdf(
        &base,
        "Reinforcement Learning: An Introduction",
        &["Richard S. Sutton"],
        1998,
        &["2103.03453.pdf"],
    );
    let papers = crate::layout::papers_dir_at(&base);
    let expected = "Sutton - 1998 - Reinforcement Learning An Introduction.pdf";

    let plan = library_rename_attachments_at(&base, &[], true).expect("dry run");
    assert!(plan.dry_run);
    assert_eq!(plan.renamed.len(), 1);
    assert!(
        plan.renamed[0].to.ends_with(expected),
        "unexpected plan target {:?}",
        plan.renamed[0].to,
    );
    // A dry run must not touch disk or database.
    assert!(papers.join("2103.03453.pdf").is_file());
    assert!(!papers.join(expected).exists());
    assert_eq!(
        projected_paper(&base, &record_id)["pdf"]["path"],
        plan.renamed[0].from.as_str(),
    );

    let applied = library_rename_attachments_at(&base, &[], false).expect("rename");
    assert_eq!(applied.renamed.len(), 1);
    assert!(papers.join(expected).is_file(), "renamed file missing");
    assert!(!papers.join("2103.03453.pdf").exists());

    // Both homes of the path have to follow, or the reader reports a missing
    // PDF for a file that is sitting right there.
    let paper = projected_paper(&base, &record_id);
    assert_eq!(paper["pdf"]["path"], applied.renamed[0].to.as_str());
    assert_eq!(paper["attachments"][0]["path"], applied.renamed[0].to.as_str());

    // Running it again is a no-op rather than producing " (2)" copies.
    let again = library_rename_attachments_at(&base, &[], false).expect("second run");
    assert!(again.renamed.is_empty(), "second run renamed {:?}", again.renamed);
    assert!(again
        .skipped
        .iter()
        .any(|skip| skip.reason == "already named by the template"));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn renaming_attachments_leaves_foreign_files_and_resolves_collisions() {
    let base = temp_base("rename-collisions");
    // One record, two attachments: both render to the same stem, which is the
    // ordinary case for a paper with supplementary material.
    let record_id = seed_record_with_local_pdf(
        &base,
        "Shared Title",
        &["Ada Lovelace"],
        2020,
        &["a.pdf", "b.pdf"],
    );

    // A researcher-owned file that is not a registered attachment.
    let papers = crate::layout::papers_dir_at(&base);
    std::fs::write(papers.join("reviewer-report.txt"), b"mine").expect("write foreign file");

    let applied = library_rename_attachments_at(&base, &[], false).expect("rename");
    assert_eq!(applied.renamed.len(), 2);
    let names = applied
        .renamed
        .iter()
        .map(|entry| entry.to.rsplit('/').next().unwrap_or_default().to_string())
        .collect::<BTreeSet<_>>();
    assert!(
        names.contains("Lovelace - 2020 - Shared Title.pdf")
            && names.contains("Lovelace - 2020 - Shared Title (2).pdf"),
        "collision must get a suffix, got {names:?}",
    );
    assert!(
        papers.join("reviewer-report.txt").is_file(),
        "files we never registered must not be touched",
    );
    let paper = projected_paper(&base, &record_id);
    let projected = paper["attachments"]
        .as_array()
        .expect("attachments")
        .iter()
        .map(|attachment| attachment["path"].as_str().unwrap_or_default().to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        projected.len(),
        2,
        "both attachments must keep distinct paths, got {projected:?}",
    );
    for path in &projected {
        assert!(base.join(path).is_file(), "{path} is not on disk");
    }
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn renaming_attachments_never_moves_files_we_do_not_own() {
    let base = temp_base("rename-external");
    let created = library_create_item_at(
        &base,
        &json!({ "itemType": "journalArticle", "title": "Linked elsewhere" }),
    )
    .expect("create item");
    let record_id = created["recordId"].as_str().expect("record id").to_string();
    let outside = base.join("outside.pdf");
    std::fs::write(&outside, b"%PDF-1.7\n").expect("write outside file");

    library_update_relations_at(
        &base,
        &record_id,
        &json!({
            "attachments": [
                {
                    "id": "attachment:linked",
                    "label": "Linked file",
                    "kind": "pdf",
                    "path": "outside.pdf",
                    "externalPath": outside.to_string_lossy(),
                },
                {
                    "id": "attachment:link",
                    "label": "External link",
                    "kind": "externalLink",
                    "url": "https://example.test/paper",
                },
            ],
        }),
    )
    .expect("attach external references");

    let applied = library_rename_attachments_at(&base, &[], false).expect("rename");
    assert!(applied.renamed.is_empty(), "renamed {:?}", applied.renamed);
    assert!(outside.is_file(), "a linked external file must never move");
    let reasons = applied
        .skipped
        .iter()
        .map(|skip| skip.reason.clone())
        .collect::<BTreeSet<_>>();
    assert!(reasons.contains("linked external file is not ours to move"));
    assert!(reasons.contains("attachment has no local file"));
    let _ = std::fs::remove_dir_all(base);
}

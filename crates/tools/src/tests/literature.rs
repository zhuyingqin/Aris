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
fn wraps_bare_scopus_queries_in_title_abs_key() {
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
            "TITLE-ABS-KEY(\"Reinforcement learning-guided angle PSO for optimizing echo state networks in wind power forecasting\")"
        );
    assert_eq!(
        scopus_query("TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"),
        "TITLE-ABS-KEY(\"semantic communication\") AND PUBYEAR > 2020"
    );
    assert_eq!(
        scopus_query("AUTH(rivera) AND KEY(agents)"),
        "AUTH(rivera) AND KEY(agents)"
    );
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
fn upsert_adds_new_papers_into_the_inbox() {
    let base = temp_base("upsert-add");
    let stats = library_upsert_at(
        &base,
        &[record("arxiv:1111.00001", "Paper One")],
        Some(&UpsertSearch {
            query: "paper one".into(),
            sources: vec!["arxiv".into()],
        }),
    )
    .expect("upsert should work");
    assert_eq!(stats.added, 1);
    assert_eq!(stats.merged, 0);
    assert_eq!(stats.total, 1);
    let library = library_load_at(&base).expect("library loads");
    let paper = &library["papers"][0];
    assert_eq!(paper["stage"], "inbox");
    assert_eq!(paper["unread"], true);
    assert_eq!(paper["pdf"]["status"], "none");
    assert_eq!(library["searches"][0]["query"], "paper one");
    assert_eq!(library["searches"][0]["newCount"], 1);
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn library_save_keeps_the_previous_version_as_a_backup() {
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
        "first"
    );
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn upsert_enriches_existing_papers_without_touching_user_state() {
    let base = temp_base("upsert-merge");
    let mut library = empty_library();
    library["papers"] = json!([{
        "id": "arxiv:1111.00001",
        "title": "Paper One",
        "authors": ["A. One"],
        "venue": "",
        "abstract": "",
        "tags": ["keeper"],
        "collectionIds": [],
        "searchIds": [],
        "stage": "shortlist",
        "starred": true,
        "unread": false,
        "source": "arXiv",
        "addedAt": "2026-06-01T00:00:00.000Z",
        "pdf": { "status": "none" },
        "evidence": [],
    }]);
    library_save_at(&base, &library).expect("seed library");

    let mut incoming = record("arxiv:1111.00001", "Paper One");
    incoming["authors"] = json!(["A. One"]);
    incoming["doi"] = Value::from("10.1234/abc");
    incoming["citedBy"] = Value::from(7);
    incoming["source"] = Value::from("OpenAlex");
    let stats = library_upsert_at(&base, &[incoming], None).expect("upsert should work");
    assert_eq!(stats.added, 0);
    assert_eq!(stats.merged, 1);
    assert_eq!(stats.total, 1);

    let saved = library_load_at(&base).expect("library loads");
    let paper = &saved["papers"][0];
    assert_eq!(paper["stage"], "shortlist");
    assert_eq!(paper["starred"], true);
    assert_eq!(paper["tags"], json!(["keeper"]));
    assert_eq!(paper["authors"], json!(["A. One"]));
    assert_eq!(paper["source"], "arXiv + OpenAlex");
    assert_eq!(paper["doi"], "10.1234/abc");
    assert_eq!(paper["citedBy"], 7);
    assert_eq!(paper["abstract"], "An abstract.");
    assert_eq!(paper["pdf"]["url"], "https://arxiv.org/pdf/x.pdf");
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
fn strips_arxiv_version_suffixes() {
    assert_eq!(strip_version("2602.01491v2"), "2602.01491");
    assert_eq!(strip_version("2602.01491"), "2602.01491");
    assert_eq!(strip_version("cs/9901002v11"), "cs/9901002");
    assert_eq!(strip_version("cs/9901002"), "cs/9901002");
}

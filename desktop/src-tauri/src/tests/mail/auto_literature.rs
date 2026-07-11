use super::*;

fn summary(subject: &str, snippet: &str) -> MailMessageSummary {
    MailMessageSummary {
        id: "m1".to_string(),
        thread_id: "t1".to_string(),
        from: "client@example.com".to_string(),
        from_name: "Client".to_string(),
        to: "me@example.com".to_string(),
        subject: subject.to_string(),
        snippet: snippet.to_string(),
        date: String::new(),
        unread: true,
        starred: false,
        has_attachments: false,
        labels: Vec::new(),
    }
}

fn full_message(subject: &str, body: &str) -> MailMessageFull {
    MailMessageFull {
        id: "m1".to_string(),
        thread_id: "t1".to_string(),
        from: "client@example.com".to_string(),
        from_name: "Client".to_string(),
        to: "me@example.com".to_string(),
        cc: String::new(),
        subject: subject.to_string(),
        date: String::new(),
        unread: true,
        starred: false,
        labels: Vec::new(),
        body_html: None,
        body_text: body.to_string(),
        attachments: Vec::new(),
    }
}

fn paper(title: &str, doi: Option<&str>) -> tools::literature::RemotePaper {
    tools::literature::RemotePaper {
        id: doi
            .map(|doi| format!("doi:{doi}"))
            .unwrap_or_else(|| format!("title:{}", title_key(title))),
        title: title.to_string(),
        authors: Vec::new(),
        year: None,
        venue: String::new(),
        doi: doi.map(ToString::to_string),
        arxiv_id: None,
        summary: String::new(),
        url: doi.map(|doi| format!("https://doi.org/{doi}")),
        pdf_url: None,
        source: "test".to_string(),
        published: None,
        cited_by: None,
    }
}

#[test]
fn detects_literature_help_requests() {
    assert!(looks_like_literature_help(&summary(
        "文献求助",
        "帮我找 semantic communication 的论文 PDF"
    )));
    assert!(looks_like_literature_help(&summary(
        "Need papers",
        "Please find references about satellite congestion control"
    )));
    assert!(!looks_like_literature_help(&summary(
        "Meeting moved",
        "Let's meet tomorrow"
    )));
}

#[test]
fn configured_trigger_keywords_start_literature_flow() {
    let config = MailLiteratureAutomationConfig {
        trigger_keywords: vec!["客户文献单".to_string()],
        ..MailLiteratureAutomationConfig::default()
    };
    assert!(looks_like_literature_help_with_config(
        &summary("客户文献单", "semantic communication survey"),
        &config
    ));
    assert!(!looks_like_literature_help_with_config(
        &summary("Meeting moved", "Let's meet tomorrow"),
        &config
    ));
}

#[test]
fn strong_literature_subject_triggers_with_empty_snippet() {
    assert!(looks_like_literature_help(&summary(
        "文献求助：请帮我下载论文 PDF",
        ""
    )));
}

#[test]
fn allowlist_requires_exact_match_or_wildcard() {
    assert!(recipient_allowed(
        "A@Example.com",
        &["a@example.com".to_string()]
    ));
    assert!(recipient_allowed("a@example.com", &["*".to_string()]));
    assert!(!recipient_allowed(
        "b@example.com",
        &["a@example.com".to_string()]
    ));
    assert!(!recipient_allowed("b@example.com", &[]));
}

#[test]
fn extracts_labeled_title_from_request_body() {
    let message = full_message(
        "文献求助",
        "你好 Aris，请帮我下载下面这篇的 PDF，并作为附件回复给我： Title: Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting 如果可以，也请附上检索到的信息。",
    );
    assert_eq!(
        extract_literature_query(&message),
        "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
    );
}

#[test]
fn extracts_folded_labeled_title_from_request_body() {
    let message = full_message(
        "文献求助",
        "请下载这篇论文：\nTitle: Reinforcement learning–guided angle PSO for optimizing echo state\nnetworks in wind power forecasting\n如果可以，也请附上检索信息。",
    );
    assert_eq!(
        extract_literature_query(&message),
        "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
    );
}

#[test]
fn exact_title_request_filters_unrelated_search_results() {
    let request = LiteratureRequest {
        query:
            "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
                .to_string(),
        doi: None,
        title: Some(
            "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting"
                .to_string(),
        ),
        exact: true,
    };
    let matches = filter_exact_request_matches(
        vec![
            paper(
                "Reinforcement learning–guided angle PSO for optimizing echo state networks in wind power forecasting",
                Some("10.1016/j.ins.2026.123259"),
            ),
            paper("Applications of Machine Learning to Wind Engineering", Some("10.3389/fbuil.2022.811460")),
            paper(
                "A Survey on Energy Optimization Techniques in UAV-Based Cellular Networks: From Conventional to Machine Learning Approaches",
                Some("10.3390/drones7030214"),
            ),
        ],
        &request,
    );
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].doi.as_deref(), Some("10.1016/j.ins.2026.123259"));
}

#[test]
fn exact_doi_request_filters_by_doi() {
    let request = LiteratureRequest {
        query: "10.1016/j.ins.2026.123259".to_string(),
        doi: Some("10.1016/j.ins.2026.123259".to_string()),
        title: None,
        exact: true,
    };
    let matches = filter_exact_request_matches(
        vec![
            paper("Correct paper", Some("10.1016/J.INS.2026.123259")),
            paper("Wrong paper", Some("10.1109/access.2019.2909490")),
        ],
        &request,
    );
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].title, "Correct paper");
}

#[test]
fn extracts_doi_before_title() {
    let message = full_message(
        "文献求助",
        "Title: A Survey on Deep Learning for Named Entity Recognition\nDOI: 10.1109/TKDE.2020.2981314\nPublisher: IEEE",
    );
    assert_eq!(
        extract_literature_query(&message),
        "10.1109/tkde.2020.2981314"
    );
}

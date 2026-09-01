use serde_json::{json, Value};

use super::*;

const TEST_CLUES: [&str; 4] = [
    "cited dataset provenance",
    "weak labeling construction",
    "text punctuation preprocessing",
    "half nominal frame rate exclusion",
];

fn test_quote_for_clue_id(clue_id: &str) -> &'static str {
    TEST_CLUES
        .iter()
        .copied()
        .find(|clue| {
            format!(
                "clue:{}",
                &sha256_hex(normalize_clue(clue).as_bytes())[..12]
            ) == clue_id
        })
        .expect("known test clue ID")
}

fn web_fetch_output(url: &str, content_hash: &str, window_hash: &str, chunk: usize) -> String {
    serde_json::to_string(&json!({
        "status": "partial",
        "url": url,
        "contentHash": content_hash,
        "windowHash": window_hash,
        "result": format!("window {chunk}: {}", TEST_CLUES.join("; ")),
        "contentWindow": {
            "sourceChunk": chunk,
            "startChar": chunk * 100,
            "endChar": chunk * 100 + 50
        },
        "snapshot": {
            "markdownPath": format!(".somniq/web-fetch/objects/{content_hash}/content.md")
        }
    }))
    .expect("serialize fetch")
}

fn execute_input(action: RetrievalPreflight) -> String {
    match action {
        RetrievalPreflight::Execute { input } => input,
        RetrievalPreflight::Block { output } => panic!("unexpected block: {output}"),
    }
}

fn blocked_value(action: RetrievalPreflight) -> Value {
    let RetrievalPreflight::Block { output } = action else {
        panic!("expected retrieval call to be blocked")
    };
    serde_json::from_str(&output).expect("blocked output JSON")
}

/// The answer as the user receives it: the model's own text with the runtime's
/// coverage header prepended.
fn replaced_answer(gate: RetrievalAnswerGate) -> String {
    let RetrievalAnswerGate::Replace { answer } = gate else {
        panic!("a candidate-workflow answer is always labelled")
    };
    answer
}

fn lock_test_clues(guard: &mut RetrievalGuard) -> Vec<String> {
    let input = json!({
        "clues": [
            {"clue": TEST_CLUES[0], "required": true},
            {"clue": TEST_CLUES[1], "required": true},
            {"clue": TEST_CLUES[2], "required": true},
            {"clue": TEST_CLUES[3], "required": true}
        ]
    })
    .to_string();
    let input = execute_input(guard.before_tool("RetrievalPlan", &input));
    let output = guard.observe_tool("RetrievalPlan", &input, "{}".to_string(), false);
    let output: Value = serde_json::from_str(&output).expect("plan output JSON");
    // Most guard tests below intentionally exercise later retrieval behavior
    // with WebSearch as their synthetic discovery source. Treat their setup as
    // having already attempted scholarly metadata; the dedicated routing tests
    // reset this field to cover the required first call.
    guard.literature_search_calls = 1;
    output["candidateEvidence"]["clues"]
        .as_array()
        .expect("locked clues")
        .iter()
        .filter_map(|clue| clue["clueId"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn paper_discovery_requires_literature_before_web_unless_explicitly_requested() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper described by these clues");
    lock_test_clues(&mut guard);
    guard.literature_search_calls = 0;

    let first_web = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"candidate terms","maxResults":10}"#,
    ));
    assert_eq!(first_web["code"], "academic_metadata_first");
    assert!(first_web["message"]
        .as_str()
        .is_some_and(|message| message.contains("LiteratureSearch")));

    let retry_web = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"candidate terms","maxResults":10}"#,
    ));
    assert_eq!(retry_web["code"], "academic_metadata_first");

    let literature = execute_input(guard.before_tool(
        "LiteratureSearch",
        r#"{"query":"candidate terms","sources":["arxiv"]}"#,
    ));
    guard.observe_tool(
        "LiteratureSearch",
        &literature,
        r#"{"papers":[]}"#.to_string(),
        false,
    );
    execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"candidate terms","maxResults":10}"#,
    ));

    let mut explicit_web = RetrievalGuard::default();
    explicit_web.start_turn("请用网页搜索找出这篇论文");
    lock_test_clues(&mut explicit_web);
    explicit_web.literature_search_calls = 0;
    execute_input(explicit_web.before_tool(
        "WebSearch",
        r#"{"query":"candidate terms","maxResults":10}"#,
    ));
}

#[test]
fn non_paper_search_can_use_web_without_a_literature_attempt() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("recommend an ergonomic keyboard using current product information");

    execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"ergonomic keyboard current recommendations","maxResults":10}"#,
    ));
}

#[test]
fn failed_literature_attempt_unlocks_web_fallback() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper from these clues");
    lock_test_clues(&mut guard);
    let literature = execute_input(guard.before_tool(
        "LiteratureSearch",
        r#"{"query":"candidate terms","sources":["arxiv"]}"#,
    ));
    guard.observe_tool(
        "LiteratureSearch",
        &literature,
        "provider unavailable".to_string(),
        true,
    );
    execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"candidate terms","maxResults":10}"#,
    ));
}

fn discover_and_seal_candidate(guard: &mut RetrievalGuard, url: &str) {
    for (index, query) in ["broad title and method terms", "distinct clue combination"]
        .into_iter()
        .enumerate()
    {
        let input = execute_input(guard.before_tool(
            "WebSearch",
            &json!({"query":query,"maxResults":20}).to_string(),
        ));
        guard.observe_tool(
            "WebSearch",
            &input,
            json!({"results":[{"title":format!("Candidate {index}"),"url":url}]}).to_string(),
            false,
        );
    }
    let seal = json!({
        "coverageNote":"Covered broad title/method terms and a distinct clue combination across the allowed search scope."
    })
    .to_string();
    let seal = execute_input(guard.before_tool("RetrievalCorpusSeal", &seal));
    guard.observe_tool("RetrievalCorpusSeal", &seal, "{}".to_string(), false);
}

#[test]
fn explicit_arxiv_scope_rewrites_searches_and_blocks_other_hosts() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("请找出这篇论文。只搜索arxiv");
    lock_test_clues(&mut guard);

    let literature = execute_input(guard.before_tool(
        "LiteratureSearch",
        r#"{"query":"sign language","sources":["openalex"]}"#,
    ));
    let literature: Value = serde_json::from_str(&literature).expect("literature input");
    assert_eq!(literature["sources"], json!(["arxiv"]));
    guard.observe_tool(
        "LiteratureSearch",
        &literature.to_string(),
        json!({"papers":[{"arxivId":"2405.02984","url":"https://arxiv.org/abs/2405.02984"}]})
            .to_string(),
        false,
    );

    let web = execute_input(
        guard.before_tool("WebSearch", r#"{"query":"sign language","maxResults":10}"#),
    );
    let web: Value = serde_json::from_str(&web).expect("web input");
    assert_eq!(web["allowed_domains"], json!(["arxiv.org"]));
    guard.observe_tool(
        "WebSearch",
        &web.to_string(),
        json!({"results":[{"url":"https://arxiv.org/abs/2405.02984"}]}).to_string(),
        false,
    );
    let seal = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Covered metadata and web discovery within the requested arXiv-only scope."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &seal, "{}".to_string(), false);

    execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"frame rate"}"#,
    ));
    execute_input(guard.before_tool(
        "WebFetch",
        r#"{"cursor":"{\"requestUrl\":\"https://arxiv.org/html/2405.02984\"}"}"#,
    ));
    let cursor_blocked = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"cursor":"{\"requestUrl\":\"https://example.com/paper\"}"}"#,
    ));
    assert_eq!(cursor_blocked["code"], "source_scope_violation");
    let repl_blocked = blocked_value(guard.before_tool(
        "REPL",
        r#"{"language":"python","code":"requests.get('https://example.com/paper')"}"#,
    ));
    assert_eq!(repl_blocked["code"], "source_scope_violation");
    let blocked = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://ar5iv.labs.arxiv.org/html/2405.02984","prompt":"frame rate"}"#,
    ));
    assert_eq!(blocked["code"], "source_scope_violation");
}

#[test]
fn retrieval_plan_rejects_named_entities_not_present_in_the_user_question() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find a sign language translation paper from the given dataset clues");
    let plan = json!({
        "clues": [
            {"clue": "target is a sign language translation paper", "required": true},
            {"clue": "the paper cites earlier weak-label dataset construction", "required": true},
            {"clue": "text preprocessing is described for another corpus", "required": true},
            {"clue": "MuST-C punctuation preprocessing is reused", "required": false}
        ]
    })
    .to_string();
    let blocked = blocked_value(guard.before_tool("RetrievalPlan", &plan));
    assert_eq!(blocked["code"], "invalid_retrieval_plan");
    assert!(blocked["message"].as_str().is_some_and(|message| {
        message.contains("MuST-C") && message.contains("ungrounded named entities")
    }));
}

#[test]
fn direct_arxiv_atom_fetch_is_blocked_in_favor_of_governed_literature_search() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find a sign language translation paper; only search arxiv");
    lock_test_clues(&mut guard);
    let blocked = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://export.arxiv.org/api/query?search_query=all%3Asign","prompt":"list papers"}"#,
    ));
    assert_eq!(blocked["code"], "arxiv_api_bypass");
    assert!(blocked["message"]
        .as_str()
        .is_some_and(|message| message.contains("LiteratureSearch")));
}

#[test]
fn corpus_must_be_broadly_discovered_then_sealed_before_screening() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    lock_test_clues(&mut guard);

    let early_fetch = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"verify"}"#,
    ));
    assert_eq!(early_fetch["code"], "corpus_not_sealed");

    let first = execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"broad candidate terms","maxResults":20}"#,
    ));
    guard.observe_tool(
        "WebSearch",
        &first,
        r#"{"results":[{"url":"https://arxiv.org/abs/2405.02984"}]}"#.to_string(),
        false,
    );
    let premature = blocked_value(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Only one search was run so far."}"#,
    ));
    assert_eq!(premature["code"], "invalid_corpus_seal");

    let second = execute_input(guard.before_tool(
        "LiteratureSearch",
        r#"{"query":"distinct method and clue formulation","sources":["arxiv"]}"#,
    ));
    guard.observe_tool(
        "LiteratureSearch",
        &second,
        r#"{"papers":[{"arxivId":"2405.02984","url":"https://arxiv.org/abs/2405.02984"}]}"#
            .to_string(),
        false,
    );
    let seal = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Covered broad terms and a distinct method/clue formulation across the allowed sources."}"#,
    ));
    let sealed = guard.observe_tool("RetrievalCorpusSeal", &seal, "{}".to_string(), false);
    let sealed: Value = serde_json::from_str(&sealed).expect("sealed corpus JSON");
    assert_eq!(sealed["status"], "sealed");

    let supplemental = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"supplemental search","maxResults":20}"#,
    ));
    assert_eq!(supplemental["code"], "discovery_closed");
    let unknown = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/9999.99999","prompt":"new candidate"}"#,
    ));
    assert_eq!(unknown["code"], "candidate_not_in_frozen_corpus");
    execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"screen frozen candidate"}"#,
    ));
}

#[test]
fn interrupted_result_summary_can_read_ledger_but_cannot_continue_work() {
    let mut original = RetrievalGuard::default();
    original.start_turn("identify the paper");
    lock_test_clues(&mut original);
    discover_and_seal_candidate(&mut original, "https://arxiv.org/abs/2405.02984");
    let checkpoint = original.checkpoint().expect("interrupted checkpoint");

    let mut summary = RetrievalGuard::default();
    summary.resume_from_checkpoint(&checkpoint);
    summary.prepare_summary();
    let ledger = execute_input(summary.before_tool("RetrievalLedger", "{}"));
    let ledger = summary.observe_tool("RetrievalLedger", &ledger, "{}".to_string(), false);
    let ledger: Value = serde_json::from_str(&ledger).expect("summary ledger");
    assert_eq!(ledger["candidateEvidence"]["summary"]["candidatesTotal"], 1);

    for (tool, input) in [
        ("WebSearch", r#"{"query":"supplemental","maxResults":20}"#),
        (
            "WebFetch",
            r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"continue"}"#,
        ),
        ("bash", r#"{"command":"echo continue"}"#),
        (
            "RetrievalEvidence",
            r#"{"candidateId":"x","clueId":"x","verdict":"supports","evidenceId":"x","note":"x"}"#,
        ),
    ] {
        let blocked = blocked_value(summary.before_tool(tool, input));
        assert_eq!(blocked["code"], "retrieval_summary_read_only", "{tool}");
    }
    assert_eq!(
        summary.gate_final_answer("目前找到一个候选，但尚未完成核验。"),
        RetrievalAnswerGate::Allow
    );

    let durable = summary.checkpoint().expect("summary checkpoint");
    let mut continued = RetrievalGuard::default();
    continued.resume_from_checkpoint(&durable);
    execute_input(continued.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"explicit continuation"}"#,
    ));
}

#[test]
fn exact_fetch_windows_are_compacted_and_third_fresh_fetch_is_blocked() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let first_input = r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"frame rate"}"#;
    let second_input = r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"dataset details"}"#;

    let first = execute_input(guard.before_tool("WebFetch", first_input));
    let first_output = guard.observe_tool(
        "WebFetch",
        &first,
        web_fetch_output("https://arxiv.org/html/2405.02984", "page", "window-7", 7),
        false,
    );
    assert_eq!(
        serde_json::from_str::<Value>(&first_output).expect("first output")["status"],
        "partial"
    );

    let second = execute_input(guard.before_tool("WebFetch", second_input));
    let duplicate = guard.observe_tool(
        "WebFetch",
        &second,
        web_fetch_output("https://arxiv.org/html/2405.02984", "page", "window-7", 7),
        false,
    );
    let duplicate: Value = serde_json::from_str(&duplicate).expect("duplicate output");
    assert_eq!(duplicate["status"], "duplicate_window");
    assert_eq!(duplicate["firstSeenCall"], 5);
    assert!(
        duplicate.get("result").is_none(),
        "duplicate body was retained"
    );

    let third = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"appendix"}"#,
    ));
    assert_eq!(third["code"], "fresh_fetch_limit");
    assert!(third["message"]
        .as_str()
        .expect("message")
        .contains("grep_search/read_file"));
}

#[test]
fn exact_request_is_blocked_before_execution_but_failed_request_can_retry() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);
    let input = r#"{"query":"  Sign   Language  ","maxResults":10}"#;
    let normalized = execute_input(guard.before_tool("WebSearch", input));

    let duplicate = blocked_value(
        guard.before_tool("WebSearch", r#"{"maxResults":10,"query":"sign language"}"#),
    );
    assert_eq!(duplicate["code"], "duplicate_request");

    guard.observe_tool(
        "WebSearch",
        &normalized,
        "temporary failure".to_string(),
        true,
    );
    execute_input(guard.before_tool("WebSearch", r#"{"maxResults":10,"query":"sign language"}"#));
}

#[test]
fn failed_fetches_are_bounded_and_do_not_spin_on_the_same_url() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    for prompt in ["first", "second"] {
        let input = format!(r#"{{"url":"https://arxiv.org/html/2405.02984","prompt":"{prompt}"}}"#);
        let input = execute_input(guard.before_tool("WebFetch", &input));
        guard.observe_tool("WebFetch", &input, "network error".to_string(), true);
    }
    let blocked = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"third"}"#,
    ));
    assert_eq!(blocked["code"], "fresh_fetch_limit");
}

#[test]
fn candidate_clue_table_requires_anchored_executor_assessments() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    let clue_ids = lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"dataset frame rate"}"#,
    ));
    let fetch_output = guard.observe_tool(
        "WebFetch",
        &fetch_input,
        web_fetch_output(
            "https://arxiv.org/html/2405.02984",
            "page-hash",
            "window-hash",
            7,
        ),
        false,
    );
    let fetch: Value = serde_json::from_str(&fetch_output).expect("fetch ledger JSON");
    assert_eq!(
        fetch["candidateEvidence"]["updates"]["candidates"][0]["candidateId"],
        "arxiv:2405.02984"
    );
    assert_eq!(
        fetch["candidateEvidence"]["updates"]["candidates"][0]["status"],
        "checking"
    );
    let evidence_id = fetch["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("latest evidence")
        .to_string();

    let forged = blocked_value(
        guard.before_tool(
            "RetrievalEvidence",
            &json!({
                "candidateId": "arxiv:2405.02984",
                "clueId": clue_ids[0],
                "verdict": "excludes",
                "directness": "explicit",
                "evidenceId": "evidence:missing",
                "quote": TEST_CLUES[0],
                "note": "not found"
            })
            .to_string(),
        ),
    );
    assert_eq!(forged["code"], "invalid_evidence_update");

    let update = json!({
        "candidateId": "arxiv:2405.02984",
        "clueId": clue_ids[0],
        "verdict": "excludes",
        "directness": "explicit",
        "evidenceId": evidence_id,
        "quote": test_quote_for_clue_id(&clue_ids[0]),
        "note": "The cited window reports an incompatible frame rate."
    })
    .to_string();
    let update = execute_input(guard.before_tool("RetrievalEvidence", &update));
    let recorded = guard.observe_tool("RetrievalEvidence", &update, update.clone(), false);
    let recorded: Value = serde_json::from_str(&recorded).expect("recorded ledger JSON");
    assert_eq!(recorded["status"], "recorded");
    assert_eq!(
        recorded["candidateEvidence"]["updates"]["candidates"][0]["status"],
        "excluded"
    );
    assert_eq!(recorded["candidateEvidence"]["reviewed"], false);
}

#[test]
fn decisive_evidence_requires_a_present_direct_quote_not_contextual_similarity() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    let clue_ids = lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"verify evidence"}"#,
    ));
    let fetch_output = guard.observe_tool(
        "WebFetch",
        &fetch_input,
        web_fetch_output(
            "https://arxiv.org/html/2405.02984",
            "quote-page",
            "quote-window",
            1,
        ),
        false,
    );
    let fetch: Value = serde_json::from_str(&fetch_output).expect("fetch JSON");
    let evidence_id = fetch["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence ID");

    let invented = blocked_value(
        guard.before_tool(
            "RetrievalEvidence",
            &json!({
                "candidateId":"arxiv:2405.02984",
                "clueId":clue_ids[0],
                "verdict":"supports",
                "directness":"explicit",
                "evidenceId":evidence_id,
                "quote":"This sentence was never present in the candidate source.",
                "note":"Plausible but invented."
            })
            .to_string(),
        ),
    );
    assert_eq!(invented["code"], "invalid_evidence_update");
    assert!(invented["message"]
        .as_str()
        .is_some_and(|message| message.contains("does not occur")));

    let contextual = blocked_value(
        guard.before_tool(
            "RetrievalEvidence",
            &json!({
                "candidateId":"arxiv:2405.02984",
                "clueId":clue_ids[0],
                "verdict":"supports",
                "directness":"contextual",
                "evidenceId":evidence_id,
                "quote":test_quote_for_clue_id(&clue_ids[0]),
                "note":"The topic resembles the clue."
            })
            .to_string(),
        ),
    );
    assert_eq!(contextual["code"], "invalid_evidence_update");
    assert!(contextual["message"]
        .as_str()
        .is_some_and(|message| message.contains("must remain inconclusive")));
}

#[test]
fn dynamic_comparison_frontier_downgrades_a_single_candidate_confirmation_to_high() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    let clue_ids = lock_test_clues(&mut guard);
    for query in ["broad candidate search", "independent clue search"] {
        let input = execute_input(guard.before_tool(
            "WebSearch",
            &json!({"query":query,"maxResults":20}).to_string(),
        ));
        guard.observe_tool(
            "WebSearch",
            &input,
            json!({"results":[
                {"title":"Leading candidate","url":"https://arxiv.org/abs/2405.00001"},
                {"title":"Close challenger","url":"https://arxiv.org/abs/2405.00002"}
            ]})
            .to_string(),
            false,
        );
    }
    let seal = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Covered broad candidate terms and an independent high-information clue formulation."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &seal, "{}".to_string(), false);

    let leader_fetch = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.00001","prompt":"verify all clues"}"#,
    ));
    let leader_output = guard.observe_tool(
        "WebFetch",
        &leader_fetch,
        web_fetch_output(
            "https://arxiv.org/html/2405.00001",
            "leader-page",
            "leader-window",
            1,
        ),
        false,
    );
    let leader: Value = serde_json::from_str(&leader_output).expect("leader fetch");
    let leader_evidence = leader["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("leader evidence")
        .to_string();
    let cross_candidate = blocked_value(
        guard.before_tool(
            "RetrievalEvidence",
            &json!({
                "candidateId":"arxiv:2405.00002",
                "clueId":clue_ids[0],
                "verdict":"supports",
                "directness":"explicit",
                "evidenceId":leader_evidence,
                "quote":test_quote_for_clue_id(&clue_ids[0]),
                "note":"This must not be attachable to a different paper."
            })
            .to_string(),
        ),
    );
    assert_eq!(cross_candidate["code"], "invalid_evidence_update");
    assert!(cross_candidate["message"]
        .as_str()
        .is_some_and(|message| message.contains("belongs to arxiv:2405.00001")));

    for clue_id in &clue_ids {
        let update = execute_input(
            guard.before_tool(
                "RetrievalEvidence",
                &json!({
                    "candidateId":"arxiv:2405.00001",
                    "clueId":clue_id,
                    "verdict":"supports",
                    "directness":"explicit",
                    "evidenceId":leader_evidence,
                    "quote":test_quote_for_clue_id(clue_id),
                    "note":"The source explicitly states this clue."
                })
                .to_string(),
            ),
        );
        guard.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    }

    // A complete leader with an untouched challenger is a well-supported best
    // answer, not a reason to withhold one: the runtime says so in the header
    // instead of sending the draft back for another verification round.
    let labelled = replaced_answer(guard.gate_final_answer("arxiv:2405.00001 is the target."));
    assert!(labelled.starts_with("状态：高置信"), "{labelled}");
    assert!(labelled.contains("arxiv:2405.00001"), "{labelled}");
    assert!(
        labelled.contains("arxiv:2405.00001 is the target."),
        "the model's own answer must survive: {labelled}"
    );

    let challenger_fetch = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.00002","prompt":"check the highest-information clue first"}"#,
    ));
    let challenger_output = guard.observe_tool(
        "WebFetch",
        &challenger_fetch,
        web_fetch_output(
            "https://arxiv.org/html/2405.00002",
            "challenger-page",
            "challenger-window",
            1,
        ),
        false,
    );
    let challenger: Value = serde_json::from_str(&challenger_output).expect("challenger fetch");
    let challenger_evidence = challenger["candidateEvidence"]["updates"]["latestEvidence"]
        ["evidenceId"]
        .as_str()
        .expect("challenger evidence");
    let discriminative_clue_id = clue_ids
        .iter()
        .find(|clue_id| test_quote_for_clue_id(clue_id) == TEST_CLUES[3])
        .expect("highest-weight test clue");
    let inconclusive = execute_input(guard.before_tool(
        "RetrievalEvidence",
        &json!({
            "candidateId":"arxiv:2405.00002",
            "clueId":discriminative_clue_id,
            "verdict":"inconclusive",
            "directness":"partial",
            "evidenceId":challenger_evidence,
            "note":"The inspected candidate window does not explicitly establish this required clue."
        })
        .to_string(),
    ));
    guard.observe_tool("RetrievalEvidence", &inconclusive, "{}".to_string(), false);

    // Knocking the challenger down is what upgrades the label — the same work
    // as before, but now it buys a stronger claim rather than the right to
    // speak at all.
    let confirmed = replaced_answer(guard.gate_final_answer("arxiv:2405.00001 is the target."));
    assert!(confirmed.starts_with("状态：已确认"), "{confirmed}");
}

#[test]
fn evidence_weight_prioritizes_relational_numeric_clues_without_hardcoding_topics() {
    assert!(
        clue_evidence_weight("Table reports F1 improves by 2.4% over the baseline")
            > clue_evidence_weight("paper is about lane detection")
    );
    let anchors = hard_clue_anchors("SCNN has F1 0.29% in Table 4");
    assert!(anchors.contains("scnn"));
    assert!(anchors.contains("f1"));
    assert!(anchors.contains("0 29"));
}

#[test]
fn checkpoint_restores_locked_clues_candidates_and_evidence_after_interrupt() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    let clue_ids = lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"verify frame rate"}"#,
    ));
    let fetch_output = guard.observe_tool(
        "WebFetch",
        &fetch_input,
        web_fetch_output(
            "https://arxiv.org/html/2405.02984",
            "page-hash",
            "window-hash",
            3,
        ),
        false,
    );
    let output: Value = serde_json::from_str(&fetch_output).expect("fetch ledger JSON");
    let evidence_id = output["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence ID")
        .to_string();
    let checkpoint = guard.checkpoint().expect("locked research checkpoint");

    let mut resumed = RetrievalGuard::default();
    resumed.resume_from_checkpoint(&checkpoint);
    let update = json!({
        "candidateId": "arxiv:2405.02984",
        "clueId": clue_ids[0],
        "verdict": "supports",
        "directness": "explicit",
        "evidenceId": evidence_id,
        "quote": test_quote_for_clue_id(&clue_ids[0]),
        "note": "The preserved fetch window supports this clue."
    })
    .to_string();
    let update = execute_input(resumed.before_tool("RetrievalEvidence", &update));
    let recorded = resumed.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    let recorded: Value = serde_json::from_str(&recorded).expect("recorded ledger JSON");
    assert_eq!(recorded["status"], "recorded");
}

#[test]
fn snapshot_grep_becomes_evidence_for_the_existing_candidate() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"dataset details"}"#,
    ));
    guard.observe_tool(
        "WebFetch",
        &fetch_input,
        web_fetch_output(
            "https://arxiv.org/html/2405.02984",
            "page-hash",
            "window-hash",
            1,
        ),
        false,
    );
    let path = ".somniq/web-fetch/objects/page-hash/content.md";
    let grep_input = json!({
        "pattern": "punctuation",
        "path": path,
        "output_mode": "content"
    })
    .to_string();
    let grep_output = json!({
        "mode": "content",
        "numFiles": 1,
        "filenames": [path],
        "content": "12: punctuation is not used",
        "numLines": 1
    })
    .to_string();
    let observed = guard.observe_tool("grep_search", &grep_input, grep_output, false);
    let observed: Value = serde_json::from_str(&observed).expect("grep ledger JSON");
    assert!(
        observed["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
            .as_str()
            .expect("grep evidence")
            .starts_with("evidence:")
    );
    assert_eq!(
        observed["candidateEvidence"]["updates"]["candidates"][0]["verificationWindows"],
        2
    );
}

#[test]
fn search_candidates_are_rank_ordered_bounded_and_arxiv_urls_merge() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    lock_test_clues(&mut guard);
    let input = execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"candidate papers","maxResults":20}"#,
    ));
    let mut hits = (0..15)
        .map(|index| {
            json!({
                "title": format!("Candidate {index}"),
                "url": format!("https://example.com/paper/{index}")
            })
        })
        .collect::<Vec<_>>();
    hits.insert(
        0,
        json!({
            "title": "E-TSL",
            "url": "https://arxiv.org/abs/2405.02984"
        }),
    );
    hits.insert(
        1,
        json!({
            "title": "E-TSL PDF",
            "url": "https://arxiv.org/pdf/2405.02984v2"
        }),
    );
    let output = json!({
        "results": [{"content": hits}]
    })
    .to_string();
    let observed = guard.observe_tool("WebSearch", &input, output, false);
    let observed: Value = serde_json::from_str(&observed).expect("candidate table JSON");
    assert_eq!(
        observed["candidateEvidence"]["summary"]["candidatesTotal"],
        16
    );
    assert_eq!(
        observed["candidateEvidence"]["updates"]["candidates"]
            .as_array()
            .map(Vec::len),
        Some(MAX_DELTA_CANDIDATES)
    );
    assert!(observed["candidateEvidence"].get("rows").is_none());

    let ledger_input = execute_input(guard.before_tool("RetrievalLedger", "{}"));
    let ledger = guard.observe_tool("RetrievalLedger", &ledger_input, "{}".to_string(), false);
    let ledger: Value = serde_json::from_str(&ledger).expect("full ledger JSON");
    assert_eq!(
        ledger["candidateEvidence"]["rows"].as_array().map(Vec::len),
        Some(16)
    );
    assert_eq!(
        ledger["candidateEvidence"]["rows"][0]["candidateId"],
        "arxiv:2405.02984"
    );
}

#[test]
fn long_discovery_turn_switches_to_verification_then_finalization() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify a paper");
    lock_test_clues(&mut guard);

    for index in 1..=EXPLORE_RETRIEVAL_CALL_LIMIT {
        let input = format!(r#"{{"query":"query {index}","maxResults":1}}"#);
        let input = execute_input(guard.before_tool("WebSearch", &input));
        let output = json!({
            "results": [{"url": format!("https://arxiv.org/abs/24{index:02}.00001")}]
        })
        .to_string();
        guard.observe_tool("WebSearch", &input, output, false);
    }
    assert_eq!(guard.phase, RetrievalPhase::Verify);
    let blocked = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"one more broad query","maxResults":10}"#,
    ));
    assert_eq!(blocked["code"], "discovery_closed");

    for offset in 0..(TOTAL_RETRIEVAL_CALL_LIMIT - EXPLORE_RETRIEVAL_CALL_LIMIT) {
        let candidate = (offset % EXPLORE_RETRIEVAL_CALL_LIMIT) + 1;
        let input = format!(
            r#"{{"url":"https://arxiv.org/html/24{candidate:02}.00001","prompt":"verify candidate window {offset}"}}"#
        );
        let input = execute_input(guard.before_tool("WebFetch", &input));
        guard.observe_tool(
            "WebFetch",
            &input,
            web_fetch_output(
                &format!("https://arxiv.org/html/24{candidate:02}.00001"),
                &format!("page-{candidate}"),
                &format!("window-{offset}"),
                offset,
            ),
            false,
        );
    }
    assert_eq!(guard.phase, RetrievalPhase::Finalize);
    let finalized = blocked_value(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/final","prompt":"keep searching"}"#,
    ));
    assert_eq!(finalized["code"], "retrieval_finalized");
}

#[test]
fn phase_threshold_uses_external_retrieval_not_local_ledger_bookkeeping() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify a paper");
    lock_test_clues(&mut guard);
    let search =
        execute_input(guard.before_tool("WebSearch", r#"{"query":"candidate","maxResults":1}"#));
    guard.observe_tool(
        "WebSearch",
        &search,
        r#"{"results":[{"url":"https://arxiv.org/abs/2401.00001"}]}"#.to_string(),
        false,
    );
    for _ in 2..=EXPLORE_RETRIEVAL_CALL_LIMIT {
        guard.observe_tool(
            "grep_search",
            r#"{"query":"clue"}"#,
            "{}".to_string(),
            false,
        );
    }
    assert_eq!(guard.phase, RetrievalPhase::Explore);
    for index in 2..=EXPLORE_RETRIEVAL_CALL_LIMIT {
        let input = execute_input(guard.before_tool(
            "WebSearch",
            &format!(r#"{{"query":"candidate variant {index}","maxResults":1}}"#),
        ));
        guard.observe_tool(
            "WebSearch",
            &input,
            json!({"results":[{"url":format!("https://arxiv.org/abs/2405.{index:05}")}]})
                .to_string(),
            false,
        );
    }
    assert_eq!(guard.phase, RetrievalPhase::Verify);
    let blocked = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"another candidate","maxResults":1}"#,
    ));
    assert_eq!(blocked["code"], "discovery_closed");
}

#[test]
fn candidate_retrieval_requires_one_locked_plan_and_fetch_prompts_do_not_add_clues() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");

    let blocked =
        blocked_value(guard.before_tool("WebSearch", r#"{"query":"candidate","maxResults":5}"#));
    assert_eq!(blocked["code"], "retrieval_plan_required");
    assert_eq!(blocked["candidateEvidence"]["mode"], "delta");
    assert!(blocked["candidateEvidence"].get("rows").is_none());

    let clue_ids = lock_test_clues(&mut guard);
    assert_eq!(clue_ids.len(), 4);
    let second_plan = blocked_value(
        guard.before_tool(
            "RetrievalPlan",
            &json!({
                "clues": [
                    {"clue": "replacement clue one", "required": true},
                    {"clue": "replacement clue two", "required": true},
                    {"clue": "replacement clue three", "required": true},
                    {"clue": "replacement clue four", "required": true}
                ]
            })
            .to_string(),
        ),
    );
    assert_eq!(second_plan["code"], "invalid_retrieval_plan");

    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");

    for (prompt, window) in [
        ("first ad-hoc wording", "window-a"),
        ("different wording", "window-b"),
    ] {
        let input = json!({
            "url": "https://arxiv.org/html/2405.02984",
            "prompt": prompt
        })
        .to_string();
        let input = execute_input(guard.before_tool("WebFetch", &input));
        let output = guard.observe_tool(
            "WebFetch",
            &input,
            web_fetch_output("https://arxiv.org/html/2405.02984", "page", window, 1),
            false,
        );
        let output: Value = serde_json::from_str(&output).expect("fetch delta");
        assert_eq!(output["candidateEvidence"]["summary"]["cluesTotal"], 4);
        assert!(output["candidateEvidence"].get("clues").is_none());
        assert!(output["candidateEvidence"].get("rows").is_none());
    }
}

#[test]
fn todo_and_final_answer_require_complete_evidence_bindings() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    let clue_ids = lock_test_clues(&mut guard);
    discover_and_seal_candidate(&mut guard, "https://arxiv.org/abs/2405.02984");
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/html/2405.02984","prompt":"verify all clues"}"#,
    ));
    let fetch_output = guard.observe_tool(
        "WebFetch",
        &fetch_input,
        web_fetch_output(
            "https://arxiv.org/html/2405.02984",
            "page-hash",
            "window-hash",
            2,
        ),
        false,
    );
    let fetch_output: Value = serde_json::from_str(&fetch_output).expect("fetch delta");
    let evidence_id = fetch_output["candidateEvidence"]["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence ID")
        .to_string();

    let todo = json!({
        "todos": [{
            "content": "verify candidate evidence",
            "activeForm": "verifying candidate evidence",
            "status": "completed"
        }]
    })
    .to_string();
    let blocked = blocked_value(guard.before_tool("TodoWrite", &todo));
    assert_eq!(blocked["code"], "evidence_assessment_required");

    for clue_id in &clue_ids {
        let update = json!({
            "candidateId": "arxiv:2405.02984",
            "clueId": clue_id,
            "verdict": "supports",
            "directness": "explicit",
            "evidenceId": evidence_id,
            "quote": test_quote_for_clue_id(clue_id),
            "note": "The anchored window supports this stable clue."
        })
        .to_string();
        let update = execute_input(guard.before_tool("RetrievalEvidence", &update));
        guard.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    }

    // The sole candidate is complete and has no challenger to lead, so the
    // header reports a fully verified identification.
    let labelled =
        replaced_answer(guard.gate_final_answer("arxiv:2405.02984 satisfies every required clue."));
    assert!(labelled.starts_with("状态：已确认"), "{labelled}");
    assert!(
        !labelled.contains("未核实"),
        "nothing is outstanding: {labelled}"
    );
    execute_input(guard.before_tool("TodoWrite", &todo));
}

#[test]
fn explicit_unconfirmed_answer_is_allowed_without_assessments() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    assert_eq!(
        guard.gate_final_answer("状态：未确认\n\n现有证据不足。"),
        RetrievalAnswerGate::Allow
    );
}

#[test]
fn literature_metadata_title_overrides_fetch_extraction_title() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify the paper");
    lock_test_clues(&mut guard);
    let search_input = execute_input(guard.before_tool(
        "LiteratureSearch",
        r#"{"query":"How2 multimodal dataset","sources":["arxiv"]}"#,
    ));
    guard.observe_tool(
        "LiteratureSearch",
        &search_input,
        json!({
            "papers": [{
                "arxivId": "1811.00347",
                "title": "How2: A Large-scale Dataset for Multimodal Language Understanding",
                "url": "https://arxiv.org/abs/1811.00347"
            }]
        })
        .to_string(),
        false,
    );
    let second_search = execute_input(guard.before_tool(
        "WebSearch",
        r#"{"query":"large scale multimodal language dataset","maxResults":10}"#,
    ));
    guard.observe_tool(
        "WebSearch",
        &second_search,
        json!({"results":[{"url":"https://arxiv.org/abs/1811.00347"}]}).to_string(),
        false,
    );
    let seal = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Covered the named dataset query and a broader multimodal-language formulation."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &seal, "{}".to_string(), false);
    let fetch_input = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/pdf/1811.00347","prompt":"verify"}"#,
    ));
    let mut fetch: Value = serde_json::from_str(&web_fetch_output(
        "https://arxiv.org/pdf/1811.00347",
        "page",
        "window",
        1,
    ))
    .expect("fetch JSON");
    fetch["title"] = json!("I'm very close to the green");
    guard.observe_tool("WebFetch", &fetch_input, fetch.to_string(), false);
    let ledger_input = execute_input(
        guard.before_tool("RetrievalLedger", r#"{"candidateId":"arxiv:1811.00347"}"#),
    );
    let ledger = guard.observe_tool("RetrievalLedger", &ledger_input, "{}".to_string(), false);
    let ledger: Value = serde_json::from_str(&ledger).expect("ledger JSON");
    assert_eq!(
        ledger["candidateEvidence"]["rows"][0]["title"],
        "How2: A Large-scale Dataset for Multimodal Language Understanding"
    );
    assert_eq!(
        ledger["candidateEvidence"]["rows"][0]["titleSource"],
        "LiteratureSearch"
    );
}

/// The corpus seal is the backstop of the candidate-identification protocol,
/// not a global search budget. An ordinary retrieval turn cannot call
/// `RetrievalCorpusSeal` at all (`validate_corpus_seal` requires the candidate
/// workflow), so auto-sealing it froze a protocol the model was never in and
/// could not participate in: the discovery cap read as an unexplained hard
/// limit on searching. Such a turn stays in Explore and keeps searching until
/// the cost budget says otherwise.
#[test]
fn ordinary_retrieval_turns_are_not_corpus_sealed_by_the_discovery_cap() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("summarise recent work on satellite congestion control");
    assert!(
        !guard.candidate_workflow,
        "this turn must not be treated as candidate identification"
    );

    for index in 1..=(EXPLORE_RETRIEVAL_CALL_LIMIT + 4) {
        let input = format!(r#"{{"query":"survey angle {index}","maxResults":1}}"#);
        let input = execute_input(guard.before_tool("WebSearch", &input));
        let output = json!({
            "results": [{"url": format!("https://example.org/paper-{index}")}]
        })
        .to_string();
        guard.observe_tool("WebSearch", &input, output, false);
    }

    assert_eq!(guard.discovery_calls, EXPLORE_RETRIEVAL_CALL_LIMIT + 4);
    assert_eq!(guard.phase, RetrievalPhase::Explore);
    // Still searchable, not blocked with `discovery_closed`.
    let next = guard.before_tool("WebSearch", r#"{"query":"one more angle","maxResults":1}"#);
    assert!(
        matches!(next, RetrievalPreflight::Execute { .. }),
        "discovery must stay open on a non-candidate turn"
    );
}

/// The same call count on a candidate-identification turn still seals, because
/// that is where freezing the corpus carries its epistemic weight.
#[test]
fn candidate_identification_turns_still_seal_at_the_discovery_cap() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper that introduced this dataset");
    lock_test_clues(&mut guard);
    assert!(guard.candidate_workflow);

    for index in 1..=EXPLORE_RETRIEVAL_CALL_LIMIT {
        let input = format!(r#"{{"query":"candidate angle {index}","maxResults":1}}"#);
        let input = execute_input(guard.before_tool("WebSearch", &input));
        let output = json!({
            "results": [{"url": format!("https://arxiv.org/abs/24{index:02}.00001")}]
        })
        .to_string();
        guard.observe_tool("WebSearch", &input, output, false);
    }

    assert_eq!(guard.phase, RetrievalPhase::Verify);
    let blocked = blocked_value(guard.before_tool(
        "WebSearch",
        r#"{"query":"another broad sweep","maxResults":1}"#,
    ));
    assert_eq!(blocked["code"], "discovery_closed");
}

/// Refusing a search must not revoke the right to verify. Repeated blocked
/// discovery used to escalate to Finalize after three attempts, so a model that
/// had simply not read the seal note lost `WebFetch` — and any chance of
/// finishing from the corpus it had already collected. Only the total-call
/// budget closes external retrieval now.
#[test]
fn blocked_discovery_never_escalates_into_closing_verification() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify a paper");
    lock_test_clues(&mut guard);

    for index in 1..=EXPLORE_RETRIEVAL_CALL_LIMIT {
        let input = format!(r#"{{"query":"candidate {index}","maxResults":1}}"#);
        let input = execute_input(guard.before_tool("WebSearch", &input));
        let output = json!({
            "results": [{"url": format!("https://arxiv.org/abs/24{index:02}.00001")}]
        })
        .to_string();
        guard.observe_tool("WebSearch", &input, output, false);
    }
    assert_eq!(guard.phase, RetrievalPhase::Verify);

    // Far more blocked attempts than the retired three-strike threshold.
    for index in 0..8 {
        let blocked = blocked_value(guard.before_tool(
            "WebSearch",
            &format!(r#"{{"query":"ignored sweep {index}","maxResults":1}}"#),
        ));
        assert_eq!(blocked["code"], "discovery_closed", "attempt {index}");
        assert_eq!(guard.phase, RetrievalPhase::Verify, "attempt {index}");
    }

    // Verification of an already-discovered candidate is still permitted.
    let fetch = guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/abs/2401.00001","prompt":"verify the candidate"}"#,
    );
    assert!(
        matches!(fetch, RetrievalPreflight::Execute { .. }),
        "blocked discovery must not close verification"
    );
}

/// A search's cost is the set of provider requests it issues, not the sentence
/// the caller typed. In the Deep-02 session two differently worded questions
/// both compiled to `all:(inverse AND reinforcement AND learning)` and both
/// were billed against the discovery budget.
#[test]
fn duplicate_provider_requests_are_refused_even_when_the_prose_differs() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("identify a paper");
    lock_test_clues(&mut guard);

    let first = r#"{"query":"inverse reinforcement learning navigation suboptimal goal regions","sources":["arxiv"]}"#;
    let second = r#"{"query":"inverse reinforcement learning navigation goals off-policy failure","sources":["arxiv"]}"#;
    // What both compile to; the executor supplies this, the guard only keys on it.
    let compiled = "arxiv\u{1f}all:(inverse AND reinforcement AND learning)";

    let input = execute_input(guard.before_tool_with_fingerprint(
        "LiteratureSearch",
        first,
        Some(compiled),
    ));
    guard.observe_tool_with_fingerprint(
        "LiteratureSearch",
        &input,
        r#"{"papers":[]}"#.to_string(),
        false,
        Some(compiled),
    );

    let blocked = blocked_value(guard.before_tool_with_fingerprint(
        "LiteratureSearch",
        second,
        Some(compiled),
    ));
    assert_eq!(blocked["code"], "duplicate_request");
    // The discovery budget was charged once, not twice.
    assert_eq!(guard.discovery_calls, 1);

    // A genuinely different compiled request still runs.
    let third = guard.before_tool_with_fingerprint(
        "LiteratureSearch",
        second,
        Some("arxiv\u{1f}all:(suboptimal AND regions AND attracted)"),
    );
    assert!(matches!(third, RetrievalPreflight::Execute { .. }));
}

/// Without a fingerprint the key must stay on the normalized input, or every
/// tool that does not compile its request would collapse into one entry.
#[test]
fn requests_without_a_compiled_identity_still_key_on_their_input() {
    let with_fingerprint =
        deterministic_request_key("LiteratureSearch", r#"{"query":"a"}"#, Some("compiled"));
    let same_fingerprint_other_prose =
        deterministic_request_key("LiteratureSearch", r#"{"query":"b"}"#, Some("compiled"));
    assert_eq!(with_fingerprint, same_fingerprint_other_prose);

    let plain_a = deterministic_request_key("LiteratureSearch", r#"{"query":"a"}"#, None);
    let plain_b = deterministic_request_key("LiteratureSearch", r#"{"query":"b"}"#, None);
    assert!(plain_a.is_some());
    assert_ne!(plain_a, plain_b);
    assert_ne!(plain_a, with_fingerprint);

    // An empty fingerprint is not an identity; fall back rather than collapse.
    assert_eq!(
        deterministic_request_key("LiteratureSearch", r#"{"query":"a"}"#, Some("   ")),
        plain_a
    );
}

/// The Deep-X02 shape: the target is correctly identified and partially
/// verified, but one required clue describes a *different* paper and can never
/// carry a candidate-bound quote. Completeness is therefore unreachable, and
/// withholding the answer on it produced 27 messages of verification that ended
/// in "unconfirmed". The answer must now come out, labelled with what was
/// actually established.
#[test]
fn a_partially_verified_leader_is_answered_as_high_confidence_not_withheld() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper that introduced this attention method");
    let clue_ids = lock_test_clues(&mut guard);

    for (query, papers) in [
        (
            r#"{"query":"io aware exact attention"}"#,
            json!({"papers":[
                {"arxivId":"2205.14135","title":"FlashAttention","url":"https://arxiv.org/abs/2205.14135"}
            ]}),
        ),
        (
            r#"{"query":"tiling softmax on-chip memory"}"#,
            json!({"papers":[
                {"arxivId":"1906.07124","title":"An Unrelated Paper","url":"https://arxiv.org/abs/1906.07124"}
            ]}),
        ),
    ] {
        let search = execute_input(guard.before_tool("LiteratureSearch", query));
        guard.observe_tool("LiteratureSearch", &search, papers.to_string(), false);
    }
    let sealed = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Searched arXiv metadata across several formulations."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &sealed, "{}".to_string(), false);

    let fetch = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/abs/2205.14135","prompt":"check the clues"}"#,
    ));
    let fetched = guard.observe_tool(
        "WebFetch",
        &fetch,
        web_fetch_output("https://arxiv.org/abs/2205.14135", "page", "window", 0),
        false,
    );
    let evidence_id = serde_json::from_str::<Value>(&fetched).expect("delta")["candidateEvidence"]
        ["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence id")
        .to_string();

    // Only some of the required clues can be quoted from the candidate itself.
    for clue_id in clue_ids.iter().take(2) {
        let update = execute_input(
            guard.before_tool(
                "RetrievalEvidence",
                &json!({
                    "candidateId":"arxiv:2205.14135",
                    "clueId":clue_id,
                    "verdict":"supports",
                    "directness":"explicit",
                    "evidenceId":evidence_id,
                    "quote":test_quote_for_clue_id(clue_id),
                    "note":"The candidate window states this clue directly."
                })
                .to_string(),
            ),
        );
        guard.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    }

    let answer = replaced_answer(
        guard.gate_final_answer("The target is FlashAttention (arxiv:2205.14135)."),
    );
    assert!(answer.starts_with("状态：高置信"), "{answer}");
    // The header must state the coverage, not just a grade.
    assert!(answer.contains("中 2 条已直接取证"), "{answer}");
    assert!(answer.contains("未核实"), "{answer}");
    // And the model's own answer is preserved rather than discarded.
    assert!(
        answer.contains("FlashAttention (arxiv:2205.14135)"),
        "{answer}"
    );
}

/// The confidence is computed from the ledger, so dropping the gate does not
/// let an unverified guess present itself as an identification.
#[test]
fn an_unverified_guess_cannot_label_itself_confirmed() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);

    let search = execute_input(guard.before_tool("LiteratureSearch", r#"{"query":"attention"}"#));
    guard.observe_tool(
        "LiteratureSearch",
        &search,
        json!({"papers":[
            {"arxivId":"2205.14135","title":"FlashAttention","url":"https://arxiv.org/abs/2205.14135"}
        ]})
        .to_string(),
        false,
    );

    // No evidence recorded, and the prose asserts a confirmed result anyway.
    let answer = replaced_answer(
        guard.gate_final_answer("状态：已确认 — the target is definitely arxiv:2205.14135."),
    );
    assert!(answer.starts_with("状态：未确认"), "{answer}");
    assert!(answer.contains("中 0 条已直接取证"), "{answer}");

    // Naming nothing from the corpus is likewise unconfirmed, and says so.
    let unnamed = replaced_answer(guard.gate_final_answer("It is some other paper entirely."));
    assert!(unnamed.starts_with("状态：未确认"), "{unnamed}");
    assert!(unnamed.contains("未对任何候选建立直接取证"), "{unnamed}");
}

/// A self-abstaining answer is never relabelled: under-claiming is the safe
/// direction and the model is allowed to take it.
#[test]
fn a_self_declared_unconfirmed_answer_passes_through_untouched() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);
    assert_eq!(
        guard.gate_final_answer("状态：未确认\n\n证据不足以区分两个候选。"),
        RetrievalAnswerGate::Allow
    );
}

/// A correct answer routinely cites a sibling paper alongside the target — a
/// clue about "the follow-up work" can only be established that way. Requiring
/// the prose to name exactly one candidate turned those answers into
/// "no candidate was evidenced", contradicting a ledger that held a fully
/// evidence-complete candidate.
#[test]
fn an_answer_citing_a_sibling_paper_is_still_about_its_best_evidenced_candidate() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper that introduced this attention method");
    let clue_ids = lock_test_clues(&mut guard);

    for (query, papers) in [
        (
            r#"{"query":"io aware exact attention"}"#,
            json!({"papers":[
                {"arxivId":"2205.14135","title":"FlashAttention","url":"https://arxiv.org/abs/2205.14135"}
            ]}),
        ),
        (
            r#"{"query":"warp block work partitioning attention"}"#,
            json!({"papers":[
                {"arxivId":"2307.08691","title":"FlashAttention-2","url":"https://arxiv.org/abs/2307.08691"}
            ]}),
        ),
    ] {
        let search = execute_input(guard.before_tool("LiteratureSearch", query));
        guard.observe_tool("LiteratureSearch", &search, papers.to_string(), false);
    }
    let sealed = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Searched arXiv metadata for the method and its follow-up."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &sealed, "{}".to_string(), false);

    let fetch = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/abs/2205.14135","prompt":"check the clues"}"#,
    ));
    let fetched = guard.observe_tool(
        "WebFetch",
        &fetch,
        web_fetch_output("https://arxiv.org/abs/2205.14135", "page", "window", 0),
        false,
    );
    let evidence_id = serde_json::from_str::<Value>(&fetched).expect("delta")["candidateEvidence"]
        ["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence id")
        .to_string();
    for clue_id in &clue_ids {
        let update = execute_input(
            guard.before_tool(
                "RetrievalEvidence",
                &json!({
                    "candidateId":"arxiv:2205.14135",
                    "clueId":clue_id,
                    "verdict":"supports",
                    "directness":"explicit",
                    "evidenceId":evidence_id,
                    "quote":test_quote_for_clue_id(clue_id),
                    "note":"The candidate window states this clue directly."
                })
                .to_string(),
            ),
        );
        guard.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    }

    // The answer names the target and the sibling it had to cite to establish
    // the follow-up clue. The sibling carries no evidence of its own.
    let answer = replaced_answer(guard.gate_final_answer(
        "The target is FlashAttention (arxiv:2205.14135); the follow-up that \
         optimizes warp/block work distribution is arxiv:2307.08691.",
    ));
    assert!(
        !answer.contains("未对任何候选建立直接取证"),
        "the ledger holds direct evidence; the header must not deny it: {answer}"
    );
    assert!(answer.contains("arxiv:2205.14135"), "{answer}");
    assert!(
        !answer.starts_with("状态：未确认"),
        "a fully evidenced candidate must not be labelled unconfirmed: {answer}"
    );
    assert!(answer.contains("中 4 条已直接取证"), "{answer}");
}

/// Crossref registers a paper's tables and figures under their own DOIs, and a
/// metadata search returns them beside real work. One such row —
/// "Table 5: Comparison of computational complexity, GPU memory usage, …" —
/// reached a comparison frontier as a rival to the paper it was printed in.
#[test]
fn paper_components_are_not_registered_as_candidates() {
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper");
    lock_test_clues(&mut guard);

    let search = execute_input(guard.before_tool("LiteratureSearch", r#"{"query":"attention"}"#));
    guard.observe_tool(
        "LiteratureSearch",
        &search,
        json!({"papers":[
            {"doi":"10.7717/peerj-cs.3751","title":"A Survey of Efficient Attention","url":"https://doi.org/10.7717/peerj-cs.3751"},
            {"doi":"10.7717/peerj-cs.3751/table-5","title":"Table 5: Comparison of computational complexity, GPU memory usage, and throughput","url":"https://doi.org/10.7717/peerj-cs.3751/table-5"},
            {"doi":"10.1000/example/fig-2","title":"Figure 2","url":"https://doi.org/10.1000/example/fig-2"},
            // A real paper whose title merely starts with the same word.
            {"doi":"10.1000/tabletennis","title":"Table Tennis Robot Control","url":"https://doi.org/10.1000/tabletennis"}
        ]})
        .to_string(),
        false,
    );

    let registered = guard.candidates.keys().cloned().collect::<Vec<_>>();
    assert!(
        registered.contains(&"doi:10.7717/peerj-cs.3751".to_string()),
        "{registered:?}"
    );
    assert!(
        registered.contains(&"doi:10.1000/tabletennis".to_string()),
        "a real title starting with 'Table' must survive: {registered:?}"
    );
    assert!(
        !registered
            .iter()
            .any(|id| id.contains("table-5") || id.contains("fig-2")),
        "components must not become candidates: {registered:?}"
    );
}

/// The same paper indexed in two registries arrives as two rows with no shared
/// identifier. Treated as rivals, the unverified duplicate holds full optimistic
/// weight against the very evidence gathered for the paper — so the paper blocks
/// its own confirmation. Observed as `arxiv:2205.14135` versus
/// `doi:10.52202/068431-1189`, both titled "FlashAttention: Fast and
/// Memory-Efficient Exact Attention with IO-Awareness".
#[test]
fn a_duplicate_record_of_the_same_paper_is_not_its_own_challenger() {
    const TITLE: &str =
        "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness";
    let mut guard = RetrievalGuard::default();
    guard.start_turn("find the paper that introduced this attention method");
    let clue_ids = lock_test_clues(&mut guard);

    for (query, papers) in [
        (
            r#"{"query":"io aware exact attention"}"#,
            json!({"papers":[{"arxivId":"2205.14135","title":TITLE,"url":"https://arxiv.org/abs/2205.14135"}]}),
        ),
        (
            // The proceedings re-registration: same paper, different DOI, no
            // arXiv id, so nothing merges the two rows.
            r#"{"query":"tiling softmax on-chip memory"}"#,
            json!({"papers":[{"doi":"10.52202/068431-1189","title":TITLE,"url":"https://doi.org/10.52202/068431-1189"}]}),
        ),
    ] {
        let search = execute_input(guard.before_tool("LiteratureSearch", query));
        guard.observe_tool("LiteratureSearch", &search, papers.to_string(), false);
    }
    let sealed = execute_input(guard.before_tool(
        "RetrievalCorpusSeal",
        r#"{"coverageNote":"Searched arXiv and DOI metadata for the method."}"#,
    ));
    guard.observe_tool("RetrievalCorpusSeal", &sealed, "{}".to_string(), false);

    let fetch = execute_input(guard.before_tool(
        "WebFetch",
        r#"{"url":"https://arxiv.org/abs/2205.14135","prompt":"check the clues"}"#,
    ));
    let fetched = guard.observe_tool(
        "WebFetch",
        &fetch,
        web_fetch_output("https://arxiv.org/abs/2205.14135", "page", "window", 0),
        false,
    );
    let evidence_id = serde_json::from_str::<Value>(&fetched).expect("delta")["candidateEvidence"]
        ["updates"]["latestEvidence"]["evidenceId"]
        .as_str()
        .expect("evidence id")
        .to_string();
    for clue_id in &clue_ids {
        let update = execute_input(
            guard.before_tool(
                "RetrievalEvidence",
                &json!({
                    "candidateId":"arxiv:2205.14135",
                    "clueId":clue_id,
                    "verdict":"supports",
                    "directness":"explicit",
                    "evidenceId":evidence_id,
                    "quote":test_quote_for_clue_id(clue_id),
                    "note":"The candidate window states this clue directly."
                })
                .to_string(),
            ),
        );
        guard.observe_tool("RetrievalEvidence", &update, "{}".to_string(), false);
    }

    // Both rows are on the frontier, and the duplicate carries no evidence —
    // but it is the same paper, so it cannot hold up the decision.
    let frontier = guard.comparison_frontier_ids();
    assert!(
        frontier.contains("doi:10.52202/068431-1189"),
        "{frontier:?}"
    );
    let answer = replaced_answer(
        guard.gate_final_answer("The target is FlashAttention (arxiv:2205.14135)."),
    );
    assert!(
        answer.starts_with("状态：已确认"),
        "a paper must not block its own confirmation: {answer}"
    );

    // The exemption is title identity, not leniency: a differently titled paper
    // discovered the same way still withholds confirmation.
    assert!(!guard.is_same_paper(
        &CandidateState {
            title: Some(TITLE.to_string()),
            ..CandidateState::default()
        },
        &CandidateState {
            title: Some("FlashAttention-2: Faster Attention with Better Parallelism".to_string()),
            ..CandidateState::default()
        },
    ));
    // And a short shared title is not enough to claim two rows are one paper.
    assert!(!guard.is_same_paper(
        &CandidateState {
            title: Some("Attention".to_string()),
            ..CandidateState::default()
        },
        &CandidateState {
            title: Some("Attention".to_string()),
            ..CandidateState::default()
        },
    ));
}

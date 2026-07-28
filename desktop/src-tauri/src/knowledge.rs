//! Desktop commands for the project knowledge base — thin wrappers over the
//! shared kernel implementation in `tools::knowledge`, so the desktop UI, CLI
//! agents, and Chat all operate on the same `.somniq/papers/knowledge.db` contract.
//!
//! Confirmation authority lives here: `knowledge_upsert` only ever writes
//! drafts (`allow_confirm = false`), and `knowledge_confirm` — driven solely by
//! the user's review UI — is the one path that promotes a draft to `confirmed`.
//! `knowledge_generate` asks the configured chat model (via the shared
//! `run_oneshot`) to propose candidate points from a paper's reading record,
//! then persists them as drafts for the human to filter.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use runtime::ConversationMessage;

use crate::literature::{run_oneshot, run_review_oneshot};
use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
}

#[tauri::command]
pub fn knowledge_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::knowledge::knowledge_load_at(&project_base(&projects_state)?)
}

#[tauri::command]
pub fn knowledge_search(
    projects_state: State<ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let limit = limit.unwrap_or(8).clamp(1, 50);
    let result = tools::knowledge::knowledge_search_at(&base, &query, limit)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

const QUERY_PLANNER_SYSTEM: &str = r#"You plan fast evidence retrieval without embeddings.
Do not answer the question. Return one JSON object only with camelCase fields:
originalQuery, exactTerms, aliases, subqueries, entities, answerType.
Use at most 4 values per array. Add bilingual Chinese/English terminology when useful.
Prefer concrete methods, datasets, metrics, limitations, and likely source wording."#;

const RERANK_SYSTEM: &str = r#"You rerank bounded literature candidates.
Return one JSON array only. Each item must contain id, relevance (0-3), and reason.
Use only candidate ids present in the prompt. Score 3 for direct answer evidence, 2 for
necessary context, 1 for topical but insufficient, and 0 for unrelated. Do not answer."#;

const ANSWER_REVIEW_SYSTEM: &str = r#"Independently verify a literature answer against
the supplied source excerpts. Return one JSON object only with verdict (pass,
insufficient, or fail), findings (array), and gapQueries (array, maximum 3).
Every material claim needs direct page-grounded support. Retrieval cards and ranks are
not evidence."#;

const RETRIEVAL_CARD_SYSTEM: &str = r#"Create compact retrieval cards for PDF source chunks.
Return one JSON array only, with exactly one item per supplied chunk. Each item must use
the supplied chunkId and contain arrays named questions, concepts, sectionHeadings, aliases, methods,
datasets, metrics, limitations, and languageTerms. Include abbreviations, expanded forms,
Chinese/English equivalents, likely literature-search wording, and questions this exact
source could answer. Do not add facts that are absent from the source. Keep each array to
at most 8 short strings. A retrieval card helps recall; it is never answer evidence."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RerankItem {
    id: String,
    relevance: u8,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerReview {
    verdict: String,
    #[serde(default)]
    findings: Vec<String>,
    #[serde(default)]
    gap_queries: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedRetrievalCard {
    chunk_id: String,
    #[serde(default)]
    questions: Vec<String>,
    #[serde(default)]
    concepts: Vec<String>,
    #[serde(default)]
    section_headings: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    methods: Vec<String>,
    #[serde(default)]
    datasets: Vec<String>,
    #[serde(default)]
    metrics: Vec<String>,
    #[serde(default)]
    limitations: Vec<String>,
    #[serde(default)]
    language_terms: Vec<String>,
}

fn parse_llm_json<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let trimmed = text.trim();
    let unwrapped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    serde_json::from_str(unwrapped).or_else(|first| {
        let object = unwrapped
            .find('{')
            .zip(unwrapped.rfind('}'))
            .filter(|(start, end)| start < end)
            .map(|(start, end)| &unwrapped[start..=end]);
        let array = unwrapped
            .find('[')
            .zip(unwrapped.rfind(']'))
            .filter(|(start, end)| start < end)
            .map(|(start, end)| &unwrapped[start..=end]);
        object
            .and_then(|candidate| serde_json::from_str(candidate).ok())
            .or_else(|| array.and_then(|candidate| serde_json::from_str(candidate).ok()))
            .ok_or_else(|| format!("LLM returned invalid JSON: {first}"))
    })
}

fn plan_query(query: &str) -> (tools::pdf_rag::RetrievalQueryPlan, Option<String>) {
    let prompt = format!("User question:\n{query}");
    match run_oneshot(QUERY_PLANNER_SYSTEM, ConversationMessage::user_text(prompt))
        .and_then(|text| parse_llm_json::<tools::pdf_rag::RetrievalQueryPlan>(&text))
    {
        Ok(mut plan) => {
            plan.original_query = query.to_string();
            (plan, None)
        }
        Err(error) => (
            tools::pdf_rag::RetrievalQueryPlan::from_query(query),
            Some(format!(
                "query planning unavailable; used exact query only: {error}"
            )),
        ),
    }
}

/// Generate offline lexical bridges for newly indexed PDF chunks. The cards are
/// derived from source text and tied to its content hash, so re-indexing changed
/// pages automatically makes stale cards ineligible for retrieval.
#[tauri::command]
pub async fn knowledge_retrieval_cards_build(
    projects_state: State<'_, ProjectState>,
    paper_id: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let paper_id = paper_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let requested = limit.unwrap_or(24).clamp(1, 100);
    tauri::async_runtime::spawn_blocking(move || {
        let requested_model = crate::config::retrieval_card_model();
        let chunks = tools::pdf_rag::pending_retrieval_card_chunks_at(
            &base,
            paper_id.as_deref(),
            requested,
        )?;
        let attempted = chunks.len();
        let mut cards = Vec::new();
        let mut warnings = Vec::new();

        for batch in chunks.chunks(6) {
            let sources = batch
                .iter()
                .map(|chunk| {
                    json!({
                        "chunkId": chunk.chunk_id,
                        "paperId": chunk.paper_id,
                        "page": chunk.page_start,
                        "pageSource": chunk.page_source,
                        "text": truncate_prompt_text(&chunk.text, 5_000),
                    })
                })
                .collect::<Vec<_>>();
            let prompt = serde_json::to_string(&sources).map_err(|error| error.to_string())?;
            let generated = crate::literature::run_oneshot_with_model(
                RETRIEVAL_CARD_SYSTEM,
                ConversationMessage::user_text(format!("Source chunks:\n{prompt}")),
                requested_model.as_deref(),
            )
            .and_then(|(text, model)| {
                parse_llm_json::<Vec<GeneratedRetrievalCard>>(&text)
                    .map(|generated| (generated, model))
            });
            let (generated, generated_by) = match generated {
                Ok(generated) => generated,
                Err(error) => {
                    warnings.push(format!("retrieval-card batch failed: {error}"));
                    continue;
                }
            };
            let mut by_chunk = generated
                .into_iter()
                .map(|card| (card.chunk_id.clone(), card))
                .collect::<std::collections::BTreeMap<_, _>>();
            for chunk in batch {
                let Some(card) = by_chunk.remove(&chunk.chunk_id) else {
                    warnings.push(format!("model omitted chunk `{}`", chunk.chunk_id));
                    continue;
                };
                cards.push(to_retrieval_card_input(chunk, card, &generated_by));
            }
        }

        if attempted > 0 && cards.is_empty() {
            return Err(warnings.into_iter().next().unwrap_or_else(|| {
                "retrieval-card generation returned no usable cards".to_string()
            }));
        }
        let stats = tools::pdf_rag::upsert_retrieval_cards_at(&base, &cards)?;
        let has_more =
            !tools::pdf_rag::pending_retrieval_card_chunks_at(&base, paper_id.as_deref(), 1)?
                .is_empty();
        Ok(json!({
            "attempted": attempted,
            "generated": cards.len(),
            "hasMore": has_more,
            "warnings": warnings,
            "stats": stats,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn to_retrieval_card_input(
    chunk: &tools::pdf_rag::LiteraturePdfChunk,
    card: GeneratedRetrievalCard,
    generated_by: &str,
) -> tools::pdf_rag::RetrievalCardInput {
    tools::pdf_rag::RetrievalCardInput {
        chunk_id: chunk.chunk_id.clone(),
        source_content_hash: chunk.content_hash.clone(),
        questions: card.questions,
        concepts: card.concepts,
        section_headings: card.section_headings,
        aliases: card.aliases,
        methods: card.methods,
        datasets: card.datasets,
        metrics: card.metrics,
        limitations: card.limitations,
        language_terms: card.language_terms,
        generated_by: generated_by.to_string(),
        prompt_version: 1,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRagSearchResponse {
    query: String,
    query_plan: tools::pdf_rag::RetrievalQueryPlan,
    knowledge: tools::knowledge::KnowledgeRagSearchResult,
    literature: tools::pdf_rag::LiteratureRagSearchResult,
    planner_warning: Option<String>,
    rerank: Vec<RerankItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEvidenceSearchInput {
    query: String,
    limit: Option<usize>,
}

fn project_rag_retrieve_at(
    base: std::path::PathBuf,
    query: String,
    plan: tools::pdf_rag::RetrievalQueryPlan,
    planner_warning: Option<String>,
    limit: usize,
) -> Result<ProjectRagSearchResponse, String> {
    let expanded = plan.queries().into_iter().skip(1).collect::<Vec<_>>();
    let knowledge = tools::knowledge::knowledge_rag_search_at(
        &base,
        &query,
        &expanded,
        limit.clamp(1, 50).saturating_mul(3).min(50),
    )?;
    let literature = tools::pdf_rag::search_literature_with_plan_at(
        &base,
        &plan,
        limit.clamp(1, 50).saturating_mul(3).min(50),
    )?;
    let mut result = ProjectRagSearchResponse {
        query,
        query_plan: plan,
        knowledge,
        literature,
        planner_warning,
        rerank: Vec::new(),
    };
    rerank_project_results(&mut result, limit)?;
    Ok(result)
}

/// Retrieve across confirmed knowledge points and page-grounded literature PDF
/// chunks. The two result sets remain labeled rather than being silently
/// flattened, preserving their different citation and review semantics.
#[tauri::command]
pub async fn project_rag_search(
    projects_state: State<'_, ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("project RAG search query is empty".to_string());
    }
    let bounded_limit = limit.unwrap_or(8).clamp(1, 50);
    let query_for_task = query.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (plan, planner_warning) = plan_query(&query_for_task);
        project_rag_retrieve_at(base, query_for_task, plan, planner_warning, bounded_limit)
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// Synchronous, desktop-Chat-facing entry point for the local no-embedding
/// retrieval pipeline. Chat remains the answering model; this tool only plans,
/// retrieves, and reranks evidence so the final answer is not generated twice.
pub(crate) fn project_evidence_search_tool_at(
    base: &std::path::Path,
    input: &str,
) -> Result<String, String> {
    let input: ProjectEvidenceSearchInput = serde_json::from_str(input)
        .map_err(|error| format!("ProjectEvidenceSearch input must be valid JSON: {error}"))?;
    let query = input.query.trim().to_string();
    if query.is_empty() {
        return Err("ProjectEvidenceSearch query is empty".to_string());
    }

    let limit = input.limit.unwrap_or(8).clamp(1, 20);
    let (plan, planner_warning) = plan_query(&query);
    let result = project_rag_retrieve_at(base.to_path_buf(), query, plan, planner_warning, limit)?;
    let pdf_paths = tools::literature::library_pdf_records_at(base)
        .map_err(|error| {
            format!("could not load the literature library while resolving evidence PDFs: {error}")
        })?
        .into_iter()
        .map(|record| (record.paper_id, record.relative_path))
        .collect::<std::collections::BTreeMap<_, _>>();
    let value = project_evidence_search_output(&result, &pdf_paths);
    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())
}

/// Project RAG has a rich diagnostic response for its dedicated Literature UI,
/// but Chat only needs the authoritative statements, excerpts, and stable
/// citations required to answer. Keeping routing plans, ranks, hashes, paths,
/// and retrieval-card payloads out of the tool result makes the conversation
/// readable and avoids repeatedly feeding internal diagnostics back to the
/// model.
fn project_evidence_search_output(
    result: &ProjectRagSearchResponse,
    pdf_paths: &std::collections::BTreeMap<String, String>,
) -> Value {
    let confirmed_knowledge = result
        .knowledge
        .results
        .iter()
        .map(|hit| {
            let statement = if hit.knowledge.statement.trim().is_empty() {
                &hit.knowledge.answer
            } else {
                &hit.knowledge.statement
            };
            let evidence = hit
                .knowledge
                .evidence
                .iter()
                .map(|item| {
                    json!({
                        "citation": canonical_citation(&item.paper_id, item.page),
                        "paperId": item.paper_id,
                        "page": item.page,
                        "pdfPath": pdf_paths.get(&item.paper_id),
                        "quote": item.quote,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "sourceType": "confirmedKnowledge",
                "statement": statement,
                "evidence": evidence,
            })
        })
        .collect::<Vec<_>>();
    let pdf_evidence = result
        .literature
        .results
        .iter()
        .map(|hit| {
            let pdf_path = pdf_paths
                .get(&hit.chunk.paper_id)
                .map(String::as_str)
                .unwrap_or(&hit.chunk.relative_path);
            json!({
                "sourceType": "originalPdfText",
                "citation": canonical_citation(&hit.chunk.paper_id, Some(hit.chunk.page_start)),
                "paperId": hit.chunk.paper_id,
                "pageStart": hit.chunk.page_start,
                "pageEnd": hit.chunk.page_end,
                "pdfPath": pdf_path,
                "excerpt": hit.chunk.text.trim(),
                "highlightQuote": evidence_highlight_quote(&hit.chunk.text, &result.query),
            })
        })
        .collect::<Vec<_>>();
    let has_evidence = !confirmed_knowledge.is_empty() || !pdf_evidence.is_empty();
    let mut output = json!({
        "status": if has_evidence { "ready" } else { "empty" },
        "query": result.query,
        "summary": {
            "confirmedKnowledge": confirmed_knowledge.len(),
            "pdfExcerpts": pdf_evidence.len(),
        },
        "citationFormat": "[paperId p.PAGE]",
        "confirmedKnowledge": confirmed_knowledge,
        "pdfEvidence": pdf_evidence,
    });
    if let Some(object) = output.as_object_mut() {
        if let Some(warning) = result
            .planner_warning
            .as_deref()
            .map(str::trim)
            .filter(|warning| !warning.is_empty())
        {
            object.insert(
                "retrievalNotice".to_string(),
                Value::String(warning.to_string()),
            );
        }
        if !has_evidence {
            object.insert(
                "nextAction".to_string(),
                Value::String(
                    "No indexed local evidence matched. Ask the user to run Literature > Full RAG > Incremental update, then generate retrieval cards; do not silently replace local retrieval with an external literature search."
                        .to_string(),
                ),
            );
        }
    }
    output
}

fn canonical_citation(paper_id: &str, page: Option<i64>) -> String {
    match page {
        Some(page) => format!("[{paper_id} p.{page}]"),
        None => format!("[{paper_id}]"),
    }
}

/// Select a bounded verbatim sentence for the PDF overlay. The complete chunk
/// remains available to the answering model, while the side viewer gets a
/// focused quote that can be matched against the PDF text layer without
/// painting an entire page.
fn evidence_highlight_quote(text: &str, query: &str) -> String {
    const MAX_CHARS: usize = 520;
    let normalized_query = query.to_lowercase();
    let terms = normalized_query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 3)
        .collect::<std::collections::BTreeSet<_>>();
    let mut candidates = text
        .split_inclusive(['.', '!', '?', '。', '！', '？', '\n'])
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(|candidate| {
            let lowercase = candidate.to_lowercase();
            let score = terms
                .iter()
                .filter(|term| lowercase.contains(**term))
                .count();
            (score, candidate)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(score, candidate)| {
        (
            std::cmp::Reverse(*score),
            std::cmp::Reverse(candidate.chars().count().min(MAX_CHARS)),
        )
    });
    let selected = candidates
        .first()
        .map(|(_, candidate)| *candidate)
        .unwrap_or_else(|| text.trim());
    selected.chars().take(MAX_CHARS).collect()
}

fn rerank_project_results(
    result: &mut ProjectRagSearchResponse,
    limit: usize,
) -> Result<(), String> {
    const MAX_CANDIDATES: usize = 30;
    const MAX_SNIPPET_CHARS: usize = 700;
    let mut candidates = Vec::new();
    for hit in result.knowledge.results.iter().take(MAX_CANDIDATES / 2) {
        let evidence = hit
            .knowledge
            .evidence
            .iter()
            .take(2)
            .map(|item| item.quote.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let text = format!(
            "statement={} evidence={}",
            hit.knowledge.statement, evidence
        );
        candidates.push(format!(
            "id=K:{}\n{}",
            hit.knowledge.id,
            truncate_prompt_text(&text, MAX_SNIPPET_CHARS)
        ));
    }
    for hit in result
        .literature
        .results
        .iter()
        .take(MAX_CANDIDATES.saturating_sub(candidates.len()))
    {
        candidates.push(format!(
            "id=P:{} paper={} page={}\n{}",
            hit.chunk.chunk_id,
            hit.chunk.paper_id,
            hit.chunk.page_start,
            truncate_prompt_text(&hit.chunk.text, MAX_SNIPPET_CHARS)
        ));
    }
    if candidates.is_empty() {
        return Ok(());
    }
    let prompt = format!(
        "Question:\n{}\n\nCandidates:\n\n{}",
        result.query,
        candidates.join("\n\n")
    );
    let reranked = run_oneshot(RERANK_SYSTEM, ConversationMessage::user_text(prompt))
        .and_then(|text| parse_llm_json::<Vec<RerankItem>>(&text));
    let Ok(mut reranked) = reranked else {
        return Ok(());
    };
    reranked.retain(|item| item.relevance <= 3);
    let order = reranked
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.clone(), (u8::MAX - item.relevance, index)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let fallback = order.len() + MAX_CANDIDATES;
    result.knowledge.results.sort_by_key(|hit| {
        order
            .get(&format!("K:{}", hit.knowledge.id))
            .copied()
            .unwrap_or((u8::MAX, fallback + hit.rank))
    });
    for (index, hit) in result.knowledge.results.iter_mut().enumerate() {
        hit.rank = index + 1;
    }
    result.literature.results.sort_by_key(|hit| {
        order
            .get(&format!("P:{}", hit.chunk.chunk_id))
            .copied()
            .unwrap_or((u8::MAX, fallback))
    });
    result.knowledge.results.truncate(limit.clamp(1, 50));
    result.literature.results.truncate(limit.clamp(1, 50));
    result.rerank = reranked;
    Ok(())
}

fn truncate_prompt_text(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(limit).collect::<String>())
}

const PROJECT_RAG_ANSWER_SYSTEM: &str = r#"You are SomniQ's evidence-grounded research assistant.
Answer the user's question only from the supplied retrieved evidence. Treat confirmed knowledge
and original PDF page excerpts as different evidence classes. Cite every material claim inline
with the exact canonical [paperId p.PAGE] citation supplied for its source. Never expose or invent
temporary source numbers such as P1, P2, K1, or K2, extraction labels, citations, pages, results,
or methods. If the evidence is incomplete or conflicting, say so explicitly. Retrieval rank is
not confidence. Reply in the user's language. Start with a short direct answer, then use concise
evidence bullets when multiple sources are needed, followed by limitations. Unless the user asks
for depth, keep the answer under eight sentences."#;

fn project_rag_answer_prompt(result: &ProjectRagSearchResponse) -> String {
    let mut context = String::new();
    for hit in &result.knowledge.results {
        context.push_str(&format!(
            "\nConfirmed knowledge:\nStatement: {}\n",
            if hit.knowledge.statement.trim().is_empty() {
                &hit.knowledge.answer
            } else {
                &hit.knowledge.statement
            }
        ));
        for evidence in &hit.knowledge.evidence {
            context.push_str(&format!(
                "Citation: {}\nSupporting quote: {}\n",
                canonical_citation(&evidence.paper_id, evidence.page),
                evidence.quote
            ));
        }
    }
    for hit in &result.literature.results {
        context.push_str(&format!(
            "\nOriginal PDF evidence:\nCitation: {}\nExtraction: {}\nExcerpt:\n{}\n",
            canonical_citation(&hit.chunk.paper_id, Some(hit.chunk.page_start)),
            hit.chunk.page_source,
            hit.chunk.text
        ));
    }
    format!(
        "Question:\n{}\n\nRetrieved evidence (cite only each canonical Citation value):\n{}",
        result.query, context
    )
}

/// Retrieve locally first, then ask the already configured SomniQ executor to
/// synthesize a citation-constrained answer. No embedding service is required.
#[tauri::command]
pub async fn project_rag_answer(
    projects_state: State<'_, ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("project RAG answer query is empty".to_string());
    }
    let bounded_limit = limit.unwrap_or(8).clamp(1, 50);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (plan, planner_warning) = plan_query(&query);
        let mut result = project_rag_retrieve_at(
            base.clone(),
            query.clone(),
            plan,
            planner_warning,
            bounded_limit,
        )?;
        let mut answer = answer_from_retrieval(&result)?;
        let mut review = review_answer(&result, &answer);
        if review.verdict != "pass" && !review.gap_queries.is_empty() {
            let mut retry_plan = result.query_plan.clone();
            let mut retry_subqueries = review
                .gap_queries
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>();
            retry_subqueries.extend(retry_plan.subqueries);
            retry_plan.subqueries = retry_subqueries;
            result = project_rag_retrieve_at(
                base,
                query,
                retry_plan,
                result.planner_warning.clone(),
                bounded_limit,
            )?;
            answer = answer_from_retrieval(&result)?;
            review = review_answer(&result, &answer);
        }
        Ok::<_, String>((result, answer, review))
    })
    .await
    .map_err(|error| error.to_string())??;
    let (result, answer, review) = result;
    let mut value = serde_json::to_value(result).map_err(|error| error.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert("answer".to_string(), Value::String(answer));
        object.insert(
            "review".to_string(),
            serde_json::to_value(review).map_err(|error| error.to_string())?,
        );
    }
    Ok(value)
}

fn answer_from_retrieval(result: &ProjectRagSearchResponse) -> Result<String, String> {
    let has_evidence =
        !result.knowledge.results.is_empty() || !result.literature.results.is_empty();
    if !has_evidence {
        return Ok(
            "当前本地检索索引未找到足够证据；请先解析相关 PDF 或换用更具体的问题。".to_string(),
        );
    }
    run_oneshot(
        PROJECT_RAG_ANSWER_SYSTEM,
        ConversationMessage::user_text(project_rag_answer_prompt(result)),
    )
}

fn review_answer(result: &ProjectRagSearchResponse, answer: &str) -> AnswerReview {
    let prompt = format!(
        "{}\n\nProposed answer:\n{}",
        project_rag_answer_prompt(result),
        answer
    );
    run_review_oneshot(ANSWER_REVIEW_SYSTEM, &prompt)
        .and_then(|text| parse_llm_json::<AnswerReview>(&text))
        .unwrap_or_else(|error| AnswerReview {
            verdict: "unavailable".to_string(),
            findings: vec![format!("independent review unavailable: {error}")],
            gap_queries: Vec::new(),
        })
}

/// Record proposed points as DRAFTS (never confirms — confirmation is a
/// separate user action via `knowledge_confirm`).
#[tauri::command]
pub fn knowledge_upsert(
    projects_state: State<ProjectState>,
    points: Vec<Value>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let parsed = parse_points(points)?;
    let stats = tools::knowledge::knowledge_upsert_at(&base, &parsed, false)?;
    serde_json::to_value(stats).map_err(|e| e.to_string())
}

/// The ONLY path that confirms a knowledge point. Invoked by the review UI.
#[tauri::command]
pub fn knowledge_confirm(projects_state: State<ProjectState>, kp_id: String) -> Result<(), String> {
    tools::knowledge::knowledge_confirm_at(&project_base(&projects_state)?, &kp_id)
}

#[tauri::command]
pub fn knowledge_reject(
    projects_state: State<ProjectState>,
    kp_id: String,
) -> Result<bool, String> {
    tools::knowledge::knowledge_delete_at(&project_base(&projects_state)?, &kp_id)
}

/// Ask the configured chat model to propose candidate knowledge points from a
/// paper's reading record (brief + evidence + answer chains), persist them as
/// drafts, and return the candidates (with evidence) for the review UI.
#[tauri::command]
pub async fn knowledge_generate(
    projects_state: State<'_, ProjectState>,
    paper_id: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || generate_candidates(&base, &paper_id))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_points(points: Vec<Value>) -> Result<Vec<tools::knowledge::KnowledgePointInput>, String> {
    points
        .into_iter()
        .map(|point| {
            let mut parsed: tools::knowledge::KnowledgePointInput =
                serde_json::from_value(point).map_err(|e| e.to_string())?;
            // `knowledge_upsert` only ever writes drafts; never let a caller
            // smuggle in a `confirmed` status (promotion is `knowledge_confirm`
            // only). The id is kept so an existing draft can still be updated.
            parsed.status = None;
            Ok(parsed)
        })
        .collect()
}

fn generate_candidates(base: &std::path::Path, paper_id: &str) -> Result<Value, String> {
    let library = tools::literature::library_load_at(base)?;
    let paper = library["papers"]
        .as_array()
        .and_then(|papers| {
            papers.iter().find(|paper| {
                paper["id"]
                    .as_str()
                    .is_some_and(|id| id.eq_ignore_ascii_case(paper_id))
            })
        })
        .ok_or_else(|| format!("paper `{paper_id}` not found in the library"))?;

    // Anchor evidence/source ids to the library's canonical id (case as stored)
    // so they stay consistent even when the caller's id differs only by case.
    let canonical_id = paper["id"].as_str().unwrap_or(paper_id).to_string();
    let project_focus = library["projectFocus"].clone();
    let prompt = build_generation_prompt(paper, &project_focus);
    let raw = run_oneshot(GENERATION_SYSTEM, ConversationMessage::user_text(prompt))?;
    let (candidates, dropped) = parse_candidates(&raw, &canonical_id)?;
    if candidates.is_empty() {
        return Ok(json!({
            "candidates": [],
            "warning": "The model returned no anchored knowledge points for this paper.",
        }));
    }

    let stats = tools::knowledge::knowledge_upsert_at(base, &candidates, false)?;
    // Pair each stored id back with the candidate so the UI can render cards.
    let cards: Vec<Value> = candidates
        .iter()
        .zip(stats.ids.iter())
        .map(|(point, id)| {
            json!({
                "id": id,
                "question": point.question,
                "answer": point.answer,
                "statement": point.statement,
                "kind": point.kind,
                "status": "draft",
                "sourcePaperId": point.source_paper_id,
                "evidence": point.evidence.iter().map(evidence_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    let mut result = json!({ "candidates": cards });
    if dropped > 0 {
        result["warning"] = json!(format!(
            "{dropped} model candidate(s) were dropped (unparseable or missing an evidence anchor)."
        ));
    }
    Ok(result)
}

fn evidence_json(item: &tools::knowledge::EvidenceInput) -> Value {
    json!({
        "paperId": item.paper_id,
        "page": item.page,
        "quote": item.quote,
        "role": item.role,
        "annotationId": item.annotation_id,
        "evidenceId": item.evidence_id,
    })
}

const GENERATION_SYSTEM: &str = "You distill a researcher's reading of one paper into reusable \
knowledge points. Each point pairs the original question, the answer the reader reached, and a \
condensed one-sentence statement, and MUST be grounded in evidence drawn ONLY from the material \
provided (page + verbatim quote). Never invent pages, quotes, or claims that the provided text does \
not support. Respond with a single JSON array and nothing else.";

fn build_generation_prompt(paper: &Value, project_focus: &Value) -> String {
    let title = paper["title"].as_str().unwrap_or("(untitled)");
    let paper_id = paper["id"].as_str().unwrap_or("");
    let mut sections = vec![format!("PAPER\nid: {paper_id}\ntitle: {title}")];

    if let Some(abstract_text) = paper["abstract"].as_str().filter(|t| !t.trim().is_empty()) {
        sections.push(format!("ABSTRACT\n{abstract_text}"));
    }
    if project_focus.is_object() {
        sections.push(format!(
            "PROJECT FOCUS (the reader's frame — favour points relevant to this)\n{}",
            serde_json::to_string_pretty(project_focus).unwrap_or_default()
        ));
    }
    if let Some(brief) = paper.get("brief").filter(|b| b.is_object()) {
        sections.push(format!(
            "BRIEF\n{}",
            serde_json::to_string_pretty(brief).unwrap_or_default()
        ));
    }
    if let Some(evidence) = paper["evidence"].as_array().filter(|e| !e.is_empty()) {
        sections.push(format!(
            "EVIDENCE NOTES (page-anchored excerpts the reader saved)\n{}",
            serde_json::to_string_pretty(evidence).unwrap_or_default()
        ));
    }
    if let Some(chains) = paper["answerChains"].as_array().filter(|c| !c.is_empty()) {
        sections.push(format!(
            "ANSWER CHAINS (question -> answer -> supporting annotations)\n{}",
            serde_json::to_string_pretty(chains).unwrap_or_default()
        ));
    }
    if let Some(annotations) = paper["pdfAnnotations"].as_array().filter(|a| !a.is_empty()) {
        sections.push(format!(
            "PDF ANNOTATIONS (id, page, quote — use ids as annotationId anchors)\n{}",
            serde_json::to_string_pretty(annotations).unwrap_or_default()
        ));
    }

    sections.push(format!(
        "TASK\nPropose up to 6 knowledge points the reader would want to reuse in future research. \
         Return ONLY a JSON array; each element:\n\
         {{\n  \"question\": string,           // the question this answers\n\
         \"answer\": string,             // the reader's answer, 1-3 sentences\n\
         \"statement\": string,          // one-sentence condensed conclusion for retrieval\n\
         \"kind\": string,               // finding | method | definition | relation\n\
         \"evidence\": [ {{ \"paperId\": \"{paper_id}\", \"page\": number, \"quote\": string, \
         \"annotationId\": string (optional), \"evidenceId\": string (optional) }} ]\n}}\n\
         Every point MUST include at least one evidence item with a verbatim quote taken from the \
         material above. Drop any point you cannot anchor."
    ));
    sections.join("\n\n")
}

fn parse_candidates(
    raw: &str,
    paper_id: &str,
) -> Result<(Vec<tools::knowledge::KnowledgePointInput>, usize), String> {
    let array = extract_json_array(raw)
        .ok_or_else(|| "the model did not return a JSON array of knowledge points".to_string())?;
    let Value::Array(items) = array else {
        return Ok((Vec::new(), 0));
    };
    let total = items.len();
    let mut points = Vec::new();
    for item in items {
        let Ok(mut point) =
            serde_json::from_value::<tools::knowledge::KnowledgePointInput>(item.clone())
        else {
            continue;
        };
        // Enforce the iron rule: keep only anchored points, default the paperId
        // to this paper, and clear any model-supplied id/status (drafts only).
        point.evidence.retain(|e| {
            !e.quote.trim().is_empty() || e.annotation_id.is_some() || e.evidence_id.is_some()
        });
        for evidence in &mut point.evidence {
            if evidence.paper_id.trim().is_empty() {
                evidence.paper_id = paper_id.to_string();
            }
        }
        if point.evidence.is_empty() || point.statement.trim().is_empty() {
            continue;
        }
        point.id = None;
        point.status = None;
        point.source_paper_id = Some(paper_id.to_string());
        points.push(point);
    }
    let dropped = total - points.len();
    Ok((points, dropped))
}

/// Pull the first balanced JSON array out of an LLM reply (handles ```json
/// fences and surrounding prose).
fn extract_json_array(raw: &str) -> Option<Value> {
    if let Ok(value @ Value::Array(_)) = serde_json::from_str::<Value>(raw.trim()) {
        return Some(value);
    }
    let start = raw.find('[')?;
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in raw[start..].char_indices() {
        match ch {
            '"' if !escaped => in_string = !in_string,
            '\\' if in_string => {
                escaped = !escaped;
                continue;
            }
            '[' if !in_string => depth += 1,
            ']' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + 1;
                    return serde_json::from_str::<Value>(&raw[start..end]).ok();
                }
            }
            _ => {}
        }
        escaped = false;
    }
    None
}

#[cfg(test)]
#[path = "tests/knowledge.rs"]
mod tests;

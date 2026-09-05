//! Per-turn retrieval convergence and source-scope guard.
//!
//! This layer deliberately uses deterministic signals only. It blocks exact
//! duplicate WebFetch windows, prevents repeated fresh downloads of a snapshot
//! that is already searchable with the ordinary file tools, and turns a long
//! discovery tail into candidate verification before the global turn budget is
//! anywhere close to firing.
//!
//! Two kinds of bound live here and should not be confused. The corpus seal is
//! epistemic and applies only to candidate-identification turns: it freezes the
//! first-pass candidate set so screening cannot keep reopening discovery. The
//! total-call budget is a cost bound and applies to every turn. Ordinary
//! retrieval work is limited by the second, never by the first.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Broad discovery is intentionally front-loaded and bounded **for candidate
/// identification**. Once this many metadata searches have run on such a turn,
/// the candidate corpus is sealed automatically; screening is not allowed to
/// grow it again, which is what stops screening from reopening discovery until
/// it finds the answer it already prefers.
///
/// This is not a general cap on how much a turn may search. An ordinary
/// retrieval turn — a survey, a related-work sweep — has no corpus to freeze
/// and cannot call `RetrievalCorpusSeal` at all, so it is bounded only by
/// `TOTAL_RETRIEVAL_CALL_LIMIT` and the duplicate/failed-request guards. See
/// `RetrievalGuard::should_auto_seal_corpus`.
///
/// One discovery call is one tool call, not one provider query: a single
/// `LiteratureSearch` fans out across every configured source and query
/// variant.
const EXPLORE_RETRIEVAL_CALL_LIMIT: usize = 12;
/// A corpus cannot be sealed after a single narrow query. Two materially
/// distinct attempts is the smallest useful first-pass coverage signal; the
/// model-facing seal note must still account for sources and limitations.
const MIN_DISCOVERY_CALLS_BEFORE_SEAL: usize = 2;
/// External retrieval calls allowed before the runtime asks for a bounded
/// conclusion. This is a cost/convergence signal, not an instruction to throw
/// away a complete evidence table.
const TOTAL_RETRIEVAL_CALL_LIMIT: usize = 32;
const MAX_FRESH_FETCHES_PER_URL: usize = 2;
/// A transient failure may be retried once. Further identical attempts add
/// cost without producing independent evidence, so surface the recorded
/// failure instead of spinning on the same target.
const MAX_RETRIES_PER_FAILED_REQUEST: usize = 1;
const MIN_STABLE_CLUES: usize = 4;
const MAX_STABLE_CLUES: usize = 6;
const MAX_DELTA_CANDIDATES: usize = 8;
const MAX_CELL_EVIDENCE: usize = 3;
const DISCOVERY_RRF_OFFSET: usize = 10;
const DISCOVERY_FRONTIER_RATIO_NUMERATOR: u64 = 1;
const DISCOVERY_FRONTIER_RATIO_DENOMINATOR: u64 = 2;
const RETRIEVAL_PLAN_TOOL: &str = "RetrievalPlan";
const RETRIEVAL_CORPUS_SEAL_TOOL: &str = "RetrievalCorpusSeal";
const RETRIEVAL_EVIDENCE_TOOL: &str = "RetrievalEvidence";
const RETRIEVAL_LEDGER_TOOL: &str = "RetrievalLedger";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum RetrievalPhase {
    #[default]
    Explore,
    Verify,
    Finalize,
}

impl RetrievalPhase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Verify => "verify",
            Self::Finalize => "finalize",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RetrievalPreflight {
    Execute { input: String },
    Block { output: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RetrievalAnswerGate {
    Allow,
    Replace { answer: String },
}

/// Appended whenever the header says 未确认.
///
/// Labelling instead of withholding means a confidently worded draft now
/// reaches the reader with its prose intact. The header contradicts it, but the
/// contradiction has to be stated outright rather than left for the reader to
/// infer from a status word.
const UNSUPPORTED_CLAIM_NOTICE: &str =
    "以下内容未经检索证据支持，其中的确定性表述不代表已核实结论。";

/// What the evidence table establishes about the candidate an answer names.
///
/// This is a label, not a permission. Withholding the answer until one
/// candidate was fully verified and led the whole comparison frontier made the
/// conjunction unsatisfiable in practice — a clue about a *different* document
/// can never be quoted from the candidate, so completeness never arrived and
/// the turn ground on. The confidence is still runtime-owned and computed only
/// from recorded evidence, so a model cannot claim a level it did not earn; it
/// simply no longer blocks it from saying what it found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnswerConfidence {
    /// Every required clue supported by a candidate-bound quote, and ahead of
    /// every challenger on the comparison frontier.
    Confirmed,
    /// The best-supported candidate, with at least one required clue directly
    /// quoted, but coverage or the frontier gap is incomplete.
    High,
    /// No candidate has established direct support.
    Unconfirmed,
}

impl AnswerConfidence {
    const fn label(self) -> &'static str {
        match self {
            Self::Confirmed => "状态：已确认",
            Self::High => "状态：高置信",
            Self::Unconfirmed => "状态：未确认",
        }
    }
}

#[derive(Debug, Default, Clone)]
struct FetchState {
    fresh_attempts: usize,
    markdown_path: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct CandidateState {
    id: String,
    title: Option<String>,
    title_priority: u8,
    title_source: Option<String>,
    urls: BTreeSet<String>,
    sources: BTreeSet<String>,
    discovery_order: usize,
    discovered_at: usize,
    last_updated_at: usize,
    verification_windows: usize,
    discovery_mentions: usize,
    discovery_score_micros: u64,
    best_discovery_rank: Option<usize>,
    last_discovery_call: Option<usize>,
    cells: BTreeMap<String, EvidenceCell>,
}

/// A retrieval tool the guard refused, kept until that tool runs again.
///
/// The guard's refusals are recoverable by design — they name a precondition
/// and expect the model to satisfy it and come back. Nothing checked whether it
/// ever did, so a turn could lose seven PDF downloads to one unmet precondition
/// and still finish claiming the work was done. This is the bookkeeping that
/// makes an abandoned refusal visible in the answer itself.
#[derive(Debug, Default, Clone)]
struct RefusedToolState {
    refusals: usize,
    last_code: String,
    last_tool_call: usize,
}

#[derive(Debug, Default, Clone)]
struct ClueState {
    id: String,
    label: String,
    required: bool,
    weight: u8,
    first_seen_at: usize,
}

#[derive(Debug, Default, Clone)]
struct EvidenceCell {
    verdict: String,
    directness: String,
    note: Option<String>,
    evidence_ids: Vec<String>,
    quotes: BTreeMap<String, String>,
    updated_at: usize,
}

#[derive(Debug, Clone)]
struct EvidenceRef {
    id: String,
    candidate_id: String,
    clue_id: Option<String>,
    kind: String,
    tool_call: usize,
    content_hash: Option<String>,
    window_hash: Option<String>,
    path: Option<String>,
    locator: Option<String>,
    /// Kept in-process only so a later RetrievalEvidence call can prove that
    /// its quoted span was actually present in the observed candidate window.
    /// The full text is deliberately not echoed into the compact ledger.
    source_text: String,
}

#[derive(Debug, Default, Clone)]
struct CandidateSeed {
    url: Option<String>,
    title: Option<String>,
    arxiv_id: Option<String>,
    doi: Option<String>,
}

/// Opaque, in-process state for resuming an interrupted research task. The
/// desktop keeps it session-scoped and replaces it whenever a substantive new
/// research task starts, so it cannot leak into a different question.
#[derive(Debug, Clone)]
pub struct RetrievalGuardCheckpoint(RetrievalGuard);

#[derive(Debug, Default, Clone)]
pub(crate) struct RetrievalGuard {
    phase: RetrievalPhase,
    only_arxiv: bool,
    candidate_workflow: bool,
    /// A status/result question after Stop may inspect the frozen ledger but
    /// must not execute or mutate the interrupted research task.
    report_only: bool,
    source_question: String,
    clues_locked: bool,
    tool_calls: usize,
    retrieval_calls: usize,
    discovery_calls: usize,
    literature_search_calls: usize,
    fetches: HashMap<String, FetchState>,
    seen_requests: HashMap<String, usize>,
    failed_requests: HashMap<String, usize>,
    seen_windows: HashMap<String, usize>,
    seen_search_batches: HashMap<String, usize>,
    candidates: BTreeMap<String, CandidateState>,
    clues: BTreeMap<String, ClueState>,
    evidence: HashMap<String, EvidenceRef>,
    snapshot_candidates: HashMap<String, String>,
    latest_evidence_id: Option<String>,
    candidate_updates: Vec<String>,
    candidate_sequence: usize,
    /// Retrieval tools refused and not since re-run. Keyed by tool name rather
    /// than by request: the model is expected to satisfy the precondition and
    /// retry the *work*, not replay a byte-identical request, and a refusal
    /// followed by a successful call of the same tool is the signal that it
    /// did. See [`Self::abandoned_refusals`].
    refused_tools: BTreeMap<String, RefusedToolState>,
}

impl RetrievalGuard {
    pub(crate) fn start_turn(&mut self, user_text: &str) {
        *self = Self::default();
        self.only_arxiv = explicitly_requests_only_arxiv(user_text);
        self.candidate_workflow = requests_candidate_research(user_text);
        self.source_question = user_text.to_ascii_lowercase();
    }

    pub(crate) fn checkpoint(&self) -> Option<RetrievalGuardCheckpoint> {
        (self.candidate_workflow && self.clues_locked).then(|| {
            let mut durable = self.clone();
            durable.report_only = false;
            RetrievalGuardCheckpoint(durable)
        })
    }

    pub(crate) fn resume_from_checkpoint(&mut self, checkpoint: &RetrievalGuardCheckpoint) {
        *self = checkpoint.0.clone();
        self.report_only = false;
    }

    pub(crate) fn prepare_summary(&mut self) {
        self.report_only = true;
    }

    /// A single assistant message must not launch multiple arXiv searches at
    /// once. `LiteratureSearch` defaults include arXiv, while an explicit
    /// source list that excludes it can still use the normal read-only batch.
    pub(crate) fn requires_serial_tool_execution(&self, tool_name: &str, input: &str) -> bool {
        if tool_name != "LiteratureSearch" {
            return false;
        }
        if self.only_arxiv {
            return true;
        }
        let Ok(value) = serde_json::from_str::<Value>(input) else {
            // Malformed input will be reported by the tool; keep it serial so
            // an unparseable source scope cannot bypass the arXiv safeguard.
            return true;
        };
        let Some(sources) = value.get("sources") else {
            return true;
        };
        let Some(sources) = sources.as_array() else {
            return true;
        };
        sources.is_empty()
            || sources.iter().any(|source| {
                source
                    .as_str()
                    .is_some_and(|source| source.eq_ignore_ascii_case("arxiv"))
            })
    }

    /// Preflight a call whose outward request is its input verbatim.
    #[cfg(test)]
    pub(crate) fn before_tool(&mut self, tool_name: &str, input: &str) -> RetrievalPreflight {
        self.before_tool_with_fingerprint(tool_name, input, None)
    }

    /// `provider_fingerprint` is the executor's identity for the request this
    /// call will actually send outward, when the tool compiles its input into
    /// something else. It is what de-duplication keys on; see
    /// `ToolExecutor::provider_request_fingerprint`.
    pub(crate) fn before_tool_with_fingerprint(
        &mut self,
        tool_name: &str,
        input: &str,
        provider_fingerprint: Option<&str>,
    ) -> RetrievalPreflight {
        if self.report_only && tool_name != RETRIEVAL_LEDGER_TOOL {
            return self.blocked_preflight(
                "retrieval_summary_read_only",
                "This is a result-summary turn. Only RetrievalLedger may be read; do not continue searching, fetch candidates, run shell/code tools, or modify evidence.",
            );
        }
        if tool_name == RETRIEVAL_PLAN_TOOL {
            return match self.validate_retrieval_plan(input) {
                Ok(()) => RetrievalPreflight::Execute {
                    input: input.to_string(),
                },
                Err(reason) => self.blocked_preflight("invalid_retrieval_plan", &reason),
            };
        }
        if tool_name == RETRIEVAL_LEDGER_TOOL {
            return match self.validate_ledger_read(input) {
                Ok(()) => RetrievalPreflight::Execute {
                    input: input.to_string(),
                },
                Err(reason) => self.blocked_preflight("invalid_ledger_read", &reason),
            };
        }
        if tool_name == RETRIEVAL_CORPUS_SEAL_TOOL {
            return match self.validate_corpus_seal(input) {
                Ok(()) => RetrievalPreflight::Execute {
                    input: input.to_string(),
                },
                Err(reason) => self.blocked_preflight("invalid_corpus_seal", &reason),
            };
        }
        if tool_name == RETRIEVAL_EVIDENCE_TOOL {
            return match self.validate_evidence_update(input) {
                Ok(()) => RetrievalPreflight::Execute {
                    input: input.to_string(),
                },
                Err(reason) => self.blocked_preflight("invalid_evidence_update", &reason),
            };
        }
        if tool_name == "TodoWrite" {
            if let Some((code, reason)) = self.todo_completion_block(input) {
                return self.blocked_preflight(code, &reason);
            }
        }
        let Some(kind) = retrieval_kind(tool_name, input) else {
            return RetrievalPreflight::Execute {
                input: input.to_string(),
            };
        };

        if self.candidate_workflow && !self.clues_locked {
            return self.refused_retrieval(
                tool_name,
                "retrieval_plan_required",
                "Before searching for a paper/candidate, call RetrievalPlan exactly once with 4-6 stable clues extracted from the user's question. Fetch prompts are queries and never create clues. Reissue this refused call once the plan is locked; the runtime reports retrieval you abandoned here as work that did not happen.",
            );
        }

        // General web search is a fallback for paper identification, rather
        // than a retry escape hatch. Some providers repeatedly select the
        // familiar WebSearch tool after a soft nudge, and never establish
        // canonical scholarly identities before sealing the candidate corpus.
        // An attempted LiteratureSearch (including one that fails) unlocks the
        // fallback; an explicit web or site search retains the user's route.
        if self.candidate_workflow
            && self.phase == RetrievalPhase::Explore
            && tool_name == "WebSearch"
            && self.literature_search_calls == 0
            && !explicitly_requests_web_search(&self.source_question)
        {
            return self.refused_retrieval(
                tool_name,
                "academic_metadata_first",
                "For academic paper discovery, call LiteratureSearch before WebSearch so candidates come from structured scholarly metadata with canonical identities. WebSearch becomes available after that attempt, including if the scholarly provider is unavailable, and remains the fallback for missing coverage or full-text entry points.",
            );
        }

        self.advance_phase_for_elapsed_calls();

        if tool_name == "WebFetch" && is_direct_arxiv_api_fetch(input) {
            return self.refused_retrieval(
                tool_name,
                "arxiv_api_bypass",
                "Do not call export.arxiv.org/api/query through WebFetch. Use LiteratureSearch for candidate discovery so its anchor-query compiler and shared arXiv queue apply. WebFetch is reserved for an already-selected arxiv.org /abs, /html, or /pdf candidate page.",
            );
        }

        let rewritten = match self.apply_source_policy(tool_name, input) {
            Ok(rewritten) => rewritten,
            Err(reason) => {
                return self.refused_retrieval(tool_name, "source_scope_violation", &reason);
            }
        };

        if self.candidate_workflow
            && self.phase == RetrievalPhase::Explore
            && kind == RetrievalKind::Verification
        {
            return self.refused_retrieval(
                tool_name,
                "corpus_not_sealed",
                "Finish the broad first-pass metadata search, then call RetrievalCorpusSeal before fetching or screening any individual candidate. Reissue this refused call after sealing; the runtime reports retrieval you abandoned here as work that did not happen.",
            );
        }

        // The refusals below deliberately do *not* record an abandoned call.
        // Two of them close retrieval on purpose and already announce it
        // through `retrievalControl`, so reporting them again at the end would
        // describe a designed budget as an oversight; the other two refuse a
        // call whose result the model already holds — a duplicate request, or a
        // URL whose snapshot is on disk — where nothing was lost to report.
        if self.phase == RetrievalPhase::Finalize {
            return self.blocked_preflight(
                "retrieval_finalized",
                "External retrieval is closed for this turn. Answer from the evidence already collected, or report what remains uncertain.",
            );
        }
        if self.phase == RetrievalPhase::Verify && kind == RetrievalKind::Discovery {
            // Refusing a search does not revoke the right to verify. Repeated
            // attempts used to escalate straight to Finalize, so a model that
            // simply had not read the seal note lost WebFetch — and with it any
            // chance of finishing from the corpus it had already collected —
            // three calls after the seal. Only the total-call budget closes
            // external retrieval now; this stays a bounded, recoverable refusal.
            return self.blocked_preflight(
                "discovery_closed",
                "Broad discovery is closed. Verify an existing candidate with WebFetch, or use grep_search/read_file on an existing snapshot and then finalize.",
            );
        }

        if self.candidate_workflow
            && self.phase == RetrievalPhase::Verify
            && kind == RetrievalKind::Verification
            && !self.verification_target_is_frozen(tool_name, &rewritten)
        {
            return self.refused_retrieval(
                tool_name,
                "candidate_not_in_frozen_corpus",
                "Screening may only verify candidates discovered before RetrievalCorpusSeal. Do not add a new URL now; finish from the frozen candidate set or report uncertainty.",
            );
        }

        if tool_name == "WebFetch" && is_direct_arxiv_api_fetch(&rewritten) {
            return self.refused_retrieval(
                tool_name,
                "arxiv_api_bypass",
                "Do not call export.arxiv.org/api/query through WebFetch. Use LiteratureSearch for candidate discovery so its anchor-query compiler and shared arXiv queue apply. WebFetch is reserved for an already-selected arxiv.org /abs, /html, or /pdf candidate page.",
            );
        }

        let request_key = deterministic_request_key(tool_name, &rewritten, provider_fingerprint);
        if let Some(request_key) = request_key.as_ref() {
            if let Some(first_seen_call) = self.seen_requests.get(request_key).copied() {
                return self.blocked_preflight(
                    "duplicate_request",
                    &format!(
                        "This normalized retrieval request is identical to tool call {first_seen_call}. Reuse that result, continue with its nextCursor, or materially change the verification target."
                    ),
                );
            }
            if self
                .failed_requests
                .get(request_key)
                .is_some_and(|failures| *failures > MAX_RETRIES_PER_FAILED_REQUEST)
            {
                return self.refused_retrieval(
                    tool_name,
                    "failed_request_limit",
                    "This exact retrieval request already failed twice. Do not repeat it again; use the recorded failure, another source, or report the remaining uncertainty.",
                );
            }
        }

        if tool_name == "WebFetch" {
            if let Some(key) = fresh_web_fetch_key(&rewritten) {
                let state = self.fetches.entry(key.clone()).or_default();
                if state.fresh_attempts >= MAX_FRESH_FETCHES_PER_URL {
                    let path = state
                        .markdown_path
                        .as_deref()
                        .unwrap_or(".somniq/web-fetch/objects/<artifact-id>/content.md")
                        .to_string();
                    return self.blocked_preflight(
                        "fresh_fetch_limit",
                        &format!(
                            "This URL has already been fetched twice in this turn. Search the persisted snapshot with grep_search/read_file instead of downloading it again: {path}"
                        ),
                    );
                }
                state.fresh_attempts += 1;
            }
        }

        if let Some(request_key) = request_key {
            self.seen_requests.insert(request_key, self.tool_calls + 1);
        }

        RetrievalPreflight::Execute { input: rewritten }
    }

    /// Account for a call the preflight refused.
    ///
    /// A refused call never reaches [`Self::observe_tool_with_fingerprint`], so
    /// without this the guard's own call counter stood still while the model
    /// burned model iterations on the same refusal — the ledger's "tool call N"
    /// referred to a number of calls that had not happened. It deliberately
    /// does not advance `retrieval_calls`: a refusal performed no retrieval and
    /// spent no provider quota, and pushing the turn toward `Finalize` for
    /// being refused is what an earlier revision removed on purpose.
    pub(crate) fn observe_blocked_tool(&mut self) {
        self.tool_calls += 1;
    }

    #[cfg(test)]
    pub(crate) fn observe_tool(
        &mut self,
        tool_name: &str,
        input: &str,
        output: String,
        is_error: bool,
    ) -> String {
        self.observe_tool_with_fingerprint(tool_name, input, output, is_error, None)
    }

    pub(crate) fn observe_tool_with_fingerprint(
        &mut self,
        tool_name: &str,
        input: &str,
        output: String,
        is_error: bool,
        provider_fingerprint: Option<&str>,
    ) -> String {
        self.tool_calls += 1;
        self.latest_evidence_id = None;
        self.candidate_updates.clear();
        if !is_error {
            // The tool the guard refused has now run. Whatever precondition it
            // named was satisfied and the work happened, so it is no longer an
            // abandoned refusal.
            self.refused_tools.remove(tool_name);
        }
        let kind = retrieval_kind(tool_name, input);
        if kind.is_some() {
            self.retrieval_calls += 1;
        }
        if kind == Some(RetrievalKind::Discovery) {
            self.discovery_calls += 1;
        }
        if matches!(
            tool_name,
            "LiteratureSearch" | "LiteratureCitations" | "LiteratureSearchExecute"
        ) {
            // Count attempts, not just successes: a provider outage must not
            // trap the agent away from the general-web fallback. Executing a
            // saved protocol is such an attempt — reaching the scholarly
            // sources through a plan rather than ad hoc does not make the
            // general web any less of a legitimate next step.
            self.literature_search_calls += 1;
        }
        let call_number = self.tool_calls;
        let mut control_notes = Vec::new();

        if is_error {
            if let Some(request_key) =
                deterministic_request_key(tool_name, input, provider_fingerprint)
            {
                self.seen_requests.remove(&request_key);
                *self.failed_requests.entry(request_key).or_default() += 1;
            }
        }

        let include_clues_in_delta = tool_name == RETRIEVAL_PLAN_TOOL;
        let mut attach_ledger = kind.is_some()
            || matches!(
                tool_name,
                RETRIEVAL_PLAN_TOOL | RETRIEVAL_CORPUS_SEAL_TOOL | RETRIEVAL_EVIDENCE_TOOL
            );
        let mut output = if tool_name == RETRIEVAL_PLAN_TOOL && !is_error {
            self.apply_retrieval_plan(input, call_number)
                .unwrap_or(output)
        } else if tool_name == RETRIEVAL_LEDGER_TOOL && !is_error {
            attach_ledger = false;
            self.apply_ledger_read(input).unwrap_or(output)
        } else if tool_name == RETRIEVAL_CORPUS_SEAL_TOOL && !is_error {
            self.apply_corpus_seal(input).unwrap_or(output)
        } else if tool_name == RETRIEVAL_EVIDENCE_TOOL && !is_error {
            self.apply_evidence_update(input, call_number)
                .unwrap_or(output)
        } else if tool_name == "WebFetch" && !is_error {
            self.observe_web_fetch(input, output, call_number, &mut control_notes)
        } else if tool_name == "WebSearch" && !is_error {
            self.observe_web_search(input, output, call_number, &mut control_notes)
        } else if matches!(tool_name, "LiteratureSearch" | "LiteratureCitations") && !is_error {
            self.observe_literature_search(output, call_number)
        } else {
            output
        };

        if !is_error && matches!(tool_name, "grep_search" | "read_file") {
            attach_ledger =
                self.observe_snapshot_file_evidence(tool_name, input, &output, call_number)
                    || attach_ledger;
        }

        if self.should_auto_seal_corpus() {
            self.phase = RetrievalPhase::Verify;
            control_notes.push(
                "The broad first-pass candidate corpus is now sealed at its discovery-call limit. Screen only candidates already collected; supplemental discovery is disabled."
                    .to_string(),
            );
        }
        if self.retrieval_calls > 0 && self.retrieval_calls >= TOTAL_RETRIEVAL_CALL_LIMIT {
            self.phase = RetrievalPhase::Finalize;
            control_notes.push(
                "External retrieval is now closed at the total call limit. Produce the best-supported answer now, including searched scope, rejected candidates, and remaining uncertainty. The frozen evidence table remains valid."
                    .to_string(),
            );
        }

        if !control_notes.is_empty() {
            output = attach_retrieval_control(
                output,
                self.phase,
                call_number,
                self.retrieval_calls,
                control_notes,
            );
        }
        if attach_ledger {
            output = attach_candidate_evidence(
                output,
                self.candidate_evidence_delta(include_clues_in_delta, true),
            );
        }
        output
    }

    /// Whether the runtime should freeze the candidate corpus on its own.
    ///
    /// This is the backstop for a candidate-identification turn whose model
    /// never called `RetrievalCorpusSeal`, so it is scoped to exactly the turns
    /// that run that protocol. Every other part of the protocol —
    /// `RetrievalPlan`, `RetrievalCorpusSeal`, the frozen-corpus verification
    /// check — is already gated the same way. Applying the backstop to an
    /// ordinary retrieval turn sealed a workflow the model was never in and
    /// could not have participated in: it is not allowed to call
    /// `RetrievalCorpusSeal` there, so the discovery cap read as an unexplained
    /// hard limit on searching. Ordinary turns are still bounded by
    /// `TOTAL_RETRIEVAL_CALL_LIMIT` and the duplicate/failed-request guards.
    fn should_auto_seal_corpus(&self) -> bool {
        self.candidate_workflow
            && self.phase == RetrievalPhase::Explore
            && self.discovery_calls >= EXPLORE_RETRIEVAL_CALL_LIMIT
    }

    fn advance_phase_for_elapsed_calls(&mut self) {
        if self.retrieval_calls == 0 {
            return;
        }
        if self.retrieval_calls >= TOTAL_RETRIEVAL_CALL_LIMIT {
            self.phase = RetrievalPhase::Finalize;
        } else if self.should_auto_seal_corpus() {
            self.phase = RetrievalPhase::Verify;
        }
    }

    fn blocked_preflight(&self, code: &str, message: &str) -> RetrievalPreflight {
        RetrievalPreflight::Block {
            output: attach_candidate_evidence(
                blocked_output(self.phase, code, message),
                self.candidate_evidence_delta(false, false),
            ),
        }
    }

    /// Refuse a call that would have performed retrieval, and remember it.
    ///
    /// Only the retrieval tools are tracked. A rejected `RetrievalPlan` or a
    /// malformed `RetrievalEvidence` is a call the model should correct and
    /// reissue immediately, and it costs the turn no evidence if it does not;
    /// a refused search or download is work the user asked for that silently
    /// did not happen, which is the thing worth reporting at the end.
    fn refused_retrieval(
        &mut self,
        tool_name: &str,
        code: &str,
        message: &str,
    ) -> RetrievalPreflight {
        let anticipated_call = self.tool_calls + 1;
        let state = self.refused_tools.entry(tool_name.to_string()).or_default();
        state.refusals += 1;
        state.last_code = code.to_string();
        state.last_tool_call = anticipated_call;
        self.blocked_preflight(code, message)
    }

    /// Every refused retrieval tool that has not run successfully since.
    ///
    /// Ordered most-refused first so the header leads with the largest gap.
    fn abandoned_refusals(&self) -> Vec<(&str, &RefusedToolState)> {
        let mut refusals = self
            .refused_tools
            .iter()
            .map(|(tool_name, state)| (tool_name.as_str(), state))
            .collect::<Vec<_>>();
        refusals.sort_by_key(|(tool_name, state)| {
            (std::cmp::Reverse(state.refusals), *tool_name)
        });
        refusals
    }

    /// One line naming the work a refusal removed from this turn, or nothing
    /// when every refused tool was eventually re-run.
    fn abandoned_refusal_note(&self) -> Option<String> {
        let refusals = self.abandoned_refusals();
        if refusals.is_empty() {
            return None;
        }
        let detail = refusals
            .iter()
            .map(|(tool_name, state)| {
                format!("{tool_name} × {}（{}）", state.refusals, state.last_code)
            })
            .collect::<Vec<_>>()
            .join("，");
        Some(format!(
            "未完成：本回合有工具调用被门禁拒绝后未重试——{detail}。这些检索没有发生，其结果不在下文依据之内。"
        ))
    }

    fn validate_retrieval_plan(&self, input: &str) -> Result<(), String> {
        if !self.candidate_workflow {
            return Err(
                "RetrievalPlan is only available for a paper/candidate identification turn"
                    .to_string(),
            );
        }
        if self.clues_locked {
            return Err(
                "the stable clue plan is already locked for this turn and cannot be replaced"
                    .to_string(),
            );
        }
        if self.retrieval_calls > 0 {
            return Err(
                "the clue plan must be locked before external retrieval begins".to_string(),
            );
        }
        let value = serde_json::from_str::<Value>(input)
            .map_err(|error| format!("RetrievalPlan input must be JSON: {error}"))?;
        let clues = value
            .get("clues")
            .and_then(Value::as_array)
            .ok_or_else(|| "clues must be an array".to_string())?;
        if !(MIN_STABLE_CLUES..=MAX_STABLE_CLUES).contains(&clues.len()) {
            return Err(format!(
                "clues must contain {MIN_STABLE_CLUES}-{MAX_STABLE_CLUES} stable items"
            ));
        }
        let mut normalized = BTreeSet::new();
        let mut required = 0usize;
        for item in clues {
            let label = required_string(item, "clue")?;
            let length = label.chars().count();
            if !(4..=200).contains(&length) {
                return Err("each clue must contain 4-200 characters".to_string());
            }
            if !normalized.insert(normalize_clue(label)) {
                return Err("clues must be unique after whitespace/case normalization".to_string());
            }
            let introduced = introduced_named_identifiers(label, &self.source_question);
            if !introduced.is_empty() {
                return Err(format!(
                    "stable clues may not introduce ungrounded named entities ({}) that are absent from the user's question. Keep the corpus/dataset unnamed until retrieval evidence identifies it; hypotheses belong in a search query, not the locked clue plan.",
                    introduced.join(", ")
                ));
            }
            let is_required = item
                .get("required")
                .and_then(Value::as_bool)
                .ok_or_else(|| "each clue requires a boolean required field".to_string())?;
            required += usize::from(is_required);
        }
        if required == 0 {
            return Err("at least one clue must be required".to_string());
        }
        Ok(())
    }

    fn apply_retrieval_plan(&mut self, input: &str, call_number: usize) -> Result<String, String> {
        self.validate_retrieval_plan(input)?;
        let value = serde_json::from_str::<Value>(input).map_err(|error| error.to_string())?;
        for item in value["clues"].as_array().into_iter().flatten() {
            let label = required_string(item, "clue")?;
            let required = item
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let normalized = normalize_clue(label);
            let id = format!("clue:{}", &sha256_hex(normalized.as_bytes())[..12]);
            self.clues.insert(
                id.clone(),
                ClueState {
                    id,
                    label: truncate_chars(label.trim(), 200),
                    required,
                    weight: clue_evidence_weight(label),
                    first_seen_at: call_number,
                },
            );
        }
        self.clues_locked = true;
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "status": "locked",
            "message": "The 4-6 clue plan is locked for this turn. Fetch/search prompts cannot add or replace clues."
        }))
        .map_err(|error| error.to_string())
    }

    fn validate_corpus_seal(&self, input: &str) -> Result<(), String> {
        if !self.candidate_workflow || !self.clues_locked {
            return Err("lock RetrievalPlan before sealing a candidate corpus".to_string());
        }
        if self.phase != RetrievalPhase::Explore {
            return Err("the first-pass candidate corpus is already sealed".to_string());
        }
        if self.discovery_calls < MIN_DISCOVERY_CALLS_BEFORE_SEAL {
            return Err(format!(
                "run at least {MIN_DISCOVERY_CALLS_BEFORE_SEAL} materially different metadata discovery searches before sealing; current discoveryCalls={}",
                self.discovery_calls
            ));
        }
        let value = serde_json::from_str::<Value>(input)
            .map_err(|error| format!("RetrievalCorpusSeal input must be JSON: {error}"))?;
        let coverage = required_string(&value, "coverageNote")?;
        if !(10..=1000).contains(&coverage.chars().count()) {
            return Err("coverageNote must contain 10-1000 characters".to_string());
        }
        Ok(())
    }

    fn apply_corpus_seal(&mut self, input: &str) -> Result<String, String> {
        self.validate_corpus_seal(input)?;
        let value = serde_json::from_str::<Value>(input).map_err(|error| error.to_string())?;
        self.phase = RetrievalPhase::Verify;
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "status": "sealed",
            "candidateCount": self.candidates.len(),
            "discoveryCalls": self.discovery_calls,
            "coverageNote": required_string(&value, "coverageNote")?,
            "message": "The first-pass candidate corpus is frozen. Screen only these candidates against the locked clues; supplemental discovery is disabled."
        }))
        .map_err(|error| error.to_string())
    }

    fn validate_ledger_read(&self, input: &str) -> Result<(), String> {
        let value = serde_json::from_str::<Value>(input)
            .map_err(|error| format!("RetrievalLedger input must be JSON: {error}"))?;
        if let Some(candidate_id) = value.get("candidateId").and_then(Value::as_str) {
            if !self.candidates.contains_key(candidate_id) {
                return Err(format!("unknown candidateId {candidate_id:?}"));
            }
        }
        Ok(())
    }

    fn apply_ledger_read(&self, input: &str) -> Result<String, String> {
        self.validate_ledger_read(input)?;
        let value = serde_json::from_str::<Value>(input).map_err(|error| error.to_string())?;
        let candidate_id = value.get("candidateId").and_then(Value::as_str);
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "status": "ok",
            "candidateEvidence": self.candidate_evidence_table(candidate_id),
        }))
        .map_err(|error| error.to_string())
    }

    fn validate_evidence_update(&self, input: &str) -> Result<(), String> {
        if self.phase == RetrievalPhase::Explore {
            return Err(
                "call RetrievalCorpusSeal before recording target-screening evidence".to_string(),
            );
        }
        let value = serde_json::from_str::<Value>(input)
            .map_err(|error| format!("RetrievalEvidence input must be JSON: {error}"))?;
        let candidate_id = required_string(&value, "candidateId")?;
        let clue_id = required_string(&value, "clueId")?;
        let verdict = required_string(&value, "verdict")?;
        let evidence_id = required_string(&value, "evidenceId")?;
        let note = required_string(&value, "note")?;
        let directness = required_string(&value, "directness")?;
        let quote = value
            .get("quote")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|quote| !quote.is_empty());
        if note.chars().count() > 500 {
            return Err("note must be at most 500 characters".to_string());
        }
        if !matches!(
            verdict,
            "supports" | "contradicts" | "inconclusive" | "excludes"
        ) {
            return Err(
                "verdict must be supports, contradicts, inconclusive, or excludes".to_string(),
            );
        }
        if !matches!(directness, "explicit" | "partial" | "contextual") {
            return Err("directness must be explicit, partial, or contextual".to_string());
        }
        if verdict == "supports" && directness != "explicit" {
            return Err(
                "a supports verdict requires directness=explicit; partial or contextual similarity must remain inconclusive"
                    .to_string(),
            );
        }
        if matches!(verdict, "supports" | "contradicts" | "excludes") && quote.is_none() {
            return Err(
                "supports, contradicts, and excludes verdicts require an exact quote from the cited evidence window"
                    .to_string(),
            );
        }
        if !self.candidates.contains_key(candidate_id) {
            return Err(format!(
                "unknown candidateId {candidate_id:?}; use an ID shown in candidateEvidence.updates.candidates or RetrievalLedger rows"
            ));
        }
        if !self.clues_locked || !self.clues.contains_key(clue_id) {
            return Err(format!(
                "unknown clueId {clue_id:?}; use one of the stable IDs locked by RetrievalPlan"
            ));
        }
        let evidence = self.evidence.get(evidence_id).ok_or_else(|| {
            format!(
                "unknown evidenceId {evidence_id:?}; cite candidateEvidence.updates.latestEvidence or an evidence entry returned by RetrievalLedger"
            )
        })?;
        if evidence.candidate_id != candidate_id {
            return Err(format!(
                "evidence {evidence_id} belongs to {}, not {candidate_id}",
                evidence.candidate_id
            ));
        }
        if let Some(quote) = quote {
            let normalized_quote = normalize_evidence_text(quote);
            if normalized_quote.chars().count() < 8 {
                return Err("quote must contain at least 8 normalized characters".to_string());
            }
            if quote.chars().count() > 1200 {
                return Err("quote must be at most 1200 characters".to_string());
            }
            let normalized_source = normalize_evidence_text(&evidence.source_text);
            if normalized_source.is_empty() || !normalized_source.contains(&normalized_quote) {
                return Err(format!(
                    "the quoted span does not occur in {evidence_id}; copy a short verbatim span from that observed candidate window"
                ));
            }
            if verdict == "supports" {
                let clue = &self
                    .clues
                    .get(clue_id)
                    .expect("validated clue exists")
                    .label;
                let anchors = hard_clue_anchors(clue);
                let overlap = anchors
                    .iter()
                    .filter(|anchor| normalized_quote.contains(anchor.as_str()))
                    .count();
                if !anchors.is_empty() && overlap == 0 {
                    return Err(format!(
                        "the quote is present but omits every explicit numeric/acronym anchor from this clue; record inconclusive unless a passage containing one of those high-information anchors is available"
                    ));
                }
            }
        }
        Ok(())
    }

    fn apply_evidence_update(&mut self, input: &str, call_number: usize) -> Result<String, String> {
        self.validate_evidence_update(input)?;
        let value = serde_json::from_str::<Value>(input).map_err(|error| error.to_string())?;
        let candidate_id = required_string(&value, "candidateId")?.to_string();
        let clue_id = required_string(&value, "clueId")?.to_string();
        let verdict = required_string(&value, "verdict")?.to_string();
        let evidence_id = required_string(&value, "evidenceId")?.to_string();
        let note = required_string(&value, "note")?.to_string();
        let directness = required_string(&value, "directness")?.to_string();
        let quote = value
            .get("quote")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|quote| !quote.is_empty())
            .map(str::to_string);
        let candidate = self
            .candidates
            .get_mut(&candidate_id)
            .expect("validated candidate exists");
        let cell = candidate.cells.entry(clue_id.clone()).or_default();
        cell.verdict.clone_from(&verdict);
        cell.directness.clone_from(&directness);
        cell.note = Some(note.clone());
        cell.updated_at = call_number;
        push_bounded_unique(&mut cell.evidence_ids, evidence_id.clone());
        if let Some(quote) = quote.as_ref() {
            cell.quotes.insert(evidence_id.clone(), quote.clone());
        }
        candidate.last_updated_at = call_number;
        if !self.candidate_updates.contains(&candidate_id) {
            self.candidate_updates.push(candidate_id.clone());
        }
        self.latest_evidence_id = Some(evidence_id.clone());
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "status": "recorded",
            "candidateId": candidate_id,
            "clueId": clue_id,
            "verdict": verdict,
            "directness": directness,
            "evidenceId": evidence_id,
            "quote": quote,
            "note": note,
            "message": "Executor assessment recorded against a candidate-bound source quote. Contextual similarity cannot count as support; this is still not an independent-review verdict."
        }))
        .map_err(|error| error.to_string())
    }

    fn register_candidate(
        &mut self,
        seed: CandidateSeed,
        source: &str,
        call_number: usize,
        discovery_rank: Option<usize>,
    ) -> Option<String> {
        if !is_paper_like_candidate(&seed) {
            return None;
        }
        let id = candidate_identity(&seed)?;
        if !self.candidates.contains_key(&id) {
            self.candidate_sequence += 1;
            self.candidates.insert(
                id.clone(),
                CandidateState {
                    id: id.clone(),
                    discovery_order: self.candidate_sequence,
                    discovered_at: call_number,
                    last_updated_at: call_number,
                    ..CandidateState::default()
                },
            );
        }
        let candidate = self
            .candidates
            .get_mut(&id)
            .expect("candidate was inserted above");
        let title_priority = candidate_title_priority(source);
        if let Some(title) = seed.title.filter(|title| !title.trim().is_empty()) {
            if candidate.title.as_deref().is_none_or(str::is_empty)
                || title_priority > candidate.title_priority
            {
                candidate.title = Some(title);
                candidate.title_priority = title_priority;
                candidate.title_source = Some(source.to_string());
            }
        }
        if let Some(url) = seed.url.as_deref().and_then(canonical_url) {
            candidate.urls.insert(url);
        }
        candidate.sources.insert(source.to_string());
        if let Some(rank) = discovery_rank {
            if candidate.last_discovery_call != Some(call_number) {
                candidate.discovery_mentions += 1;
                candidate.discovery_score_micros = candidate
                    .discovery_score_micros
                    .saturating_add(1_000_000 / (DISCOVERY_RRF_OFFSET + rank) as u64);
                candidate.best_discovery_rank = Some(
                    candidate
                        .best_discovery_rank
                        .map_or(rank, |existing| existing.min(rank)),
                );
                candidate.last_discovery_call = Some(call_number);
            }
        }
        if !self.candidate_updates.contains(&id) {
            self.candidate_updates.push(id.clone());
        }
        Some(id)
    }

    fn register_candidates_from_value(&mut self, value: &Value, source: &str, call_number: usize) {
        let mut seeds = Vec::new();
        collect_candidate_seeds(value, &mut seeds);
        let mut seen = BTreeSet::new();
        for (index, seed) in seeds.into_iter().enumerate() {
            let Some(candidate_id) = candidate_identity(&seed) else {
                continue;
            };
            if !seen.insert(candidate_id) {
                continue;
            }
            self.register_candidate(seed, source, call_number, Some(index + 1));
        }
    }

    fn observe_literature_search(&mut self, output: String, call_number: usize) -> String {
        if let Ok(value) = serde_json::from_str::<Value>(&output) {
            if let Some(papers) = value.get("papers") {
                self.register_candidates_from_value(papers, "LiteratureSearch", call_number);
            }
        }
        output
    }

    fn observe_snapshot_file_evidence(
        &mut self,
        tool_name: &str,
        input: &str,
        output: &str,
        call_number: usize,
    ) -> bool {
        let Some((candidate_id, path)) = self.candidate_for_local_snapshot(input, output) else {
            return false;
        };
        let input_value = serde_json::from_str::<Value>(input).unwrap_or(Value::Null);
        let locator_label = if tool_name == "grep_search" {
            format!(
                "snapshot grep: {}",
                input_value
                    .get("pattern")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified pattern")
            )
        } else {
            let start = input_value
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let limit = input_value.get("limit").and_then(Value::as_u64);
            match limit {
                Some(limit) => format!("snapshot read: lines {start}-{}", start + limit),
                None => "snapshot read: document window".to_string(),
            }
        };
        let evidence_id = format!(
            "evidence:{}",
            &sha256_hex(format!("{tool_name}\0{input}\0{output}").as_bytes())[..16]
        );
        let locator = if tool_name == "grep_search" {
            input_value
                .get("pattern")
                .and_then(Value::as_str)
                .map(|pattern| format!("pattern {pattern:?}"))
        } else {
            Some(locator_label.clone())
        };
        let is_new = !self.evidence.contains_key(&evidence_id);
        self.evidence
            .entry(evidence_id.clone())
            .or_insert_with(|| EvidenceRef {
                id: evidence_id.clone(),
                candidate_id: candidate_id.clone(),
                clue_id: None,
                kind: format!("snapshot_{tool_name}"),
                tool_call: call_number,
                content_hash: None,
                window_hash: Some(sha256_hex(output.as_bytes())),
                path: Some(path),
                locator,
                source_text: output.to_string(),
            });
        if let Some(candidate) = self.candidates.get_mut(&candidate_id) {
            candidate.last_updated_at = call_number;
            if is_new {
                candidate.verification_windows += 1;
            }
        }
        if !self.candidate_updates.contains(&candidate_id) {
            self.candidate_updates.push(candidate_id.clone());
        }
        self.latest_evidence_id = Some(evidence_id);
        true
    }

    fn candidate_for_local_snapshot(&self, input: &str, output: &str) -> Option<(String, String)> {
        let input_value = serde_json::from_str::<Value>(input).ok()?;
        let output_value = serde_json::from_str::<Value>(output).unwrap_or(Value::Null);
        let mut paths = Vec::new();
        if let Some(path) = input_value.get("path").and_then(Value::as_str) {
            paths.push(path.to_string());
        }
        if let Some(path) = output_value
            .pointer("/file/filePath")
            .and_then(Value::as_str)
        {
            paths.push(path.to_string());
        }
        if let Some(filenames) = output_value.get("filenames").and_then(Value::as_array) {
            paths.extend(
                filenames
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
        }
        let mut matches = BTreeMap::new();
        for path in paths {
            let normalized = normalize_snapshot_path(&path);
            for (snapshot_path, candidate_id) in &self.snapshot_candidates {
                if normalized == *snapshot_path || normalized.ends_with(snapshot_path) {
                    matches.insert(candidate_id.clone(), snapshot_path.clone());
                }
            }
        }
        (matches.len() == 1)
            .then(|| matches.into_iter().next())
            .flatten()
    }

    fn required_clue_ids(&self) -> Vec<String> {
        let mut clues = self
            .clues
            .values()
            .filter(|clue| clue.required)
            .collect::<Vec<_>>();
        clues.sort_by_key(|clue| clue.first_seen_at);
        clues.into_iter().map(|clue| clue.id.clone()).collect()
    }

    fn assessed_cells(&self) -> usize {
        self.candidates
            .values()
            .map(|candidate| candidate.cells.len())
            .sum()
    }

    fn candidate_is_complete(&self, candidate: &CandidateState) -> bool {
        let required = self.required_clue_ids();
        !required.is_empty()
            && required.iter().all(|clue_id| {
                candidate.cells.get(clue_id).is_some_and(|cell| {
                    cell.verdict == "supports"
                        && cell.directness == "explicit"
                        && !cell.evidence_ids.is_empty()
                        && !cell.quotes.is_empty()
                })
            })
    }

    fn total_required_weight(&self) -> u64 {
        self.clues
            .values()
            .filter(|clue| clue.required)
            .map(|clue| u64::from(clue.weight))
            .sum()
    }

    fn candidate_confirmed_weight(&self, candidate: &CandidateState) -> u64 {
        self.clues
            .values()
            .filter(|clue| clue.required)
            .filter(|clue| {
                candidate.cells.get(&clue.id).is_some_and(|cell| {
                    cell.verdict == "supports"
                        && cell.directness == "explicit"
                        && !cell.quotes.is_empty()
                })
            })
            .map(|clue| u64::from(clue.weight))
            .sum()
    }

    fn candidate_optimistic_weight(&self, candidate: &CandidateState) -> u64 {
        if self
            .clues
            .values()
            .filter(|clue| clue.required)
            .any(|clue| {
                candidate
                    .cells
                    .get(&clue.id)
                    .is_some_and(|cell| matches!(cell.verdict.as_str(), "contradicts" | "excludes"))
            })
        {
            return 0;
        }
        self.clues
            .values()
            .filter(|clue| clue.required)
            .map(|clue| {
                let weight = u64::from(clue.weight);
                match candidate
                    .cells
                    .get(&clue.id)
                    .map(|cell| cell.verdict.as_str())
                {
                    Some("supports") => weight,
                    // An inconclusive check narrows the optimistic bound, but
                    // a low-information clue (weight 1) cannot by itself
                    // create a decision gap. This rewards checking the most
                    // discriminative clue first without hard-coding a topic.
                    Some("inconclusive") => weight.div_ceil(2),
                    Some("contradicts" | "excludes") => 0,
                    _ => weight,
                }
            })
            .sum()
    }

    /// Ranking forms a verification frontier, never an answer. The frontier
    /// size follows the observed score distribution: every candidate within a
    /// relative RRF band of the strongest discovery signal is included, along
    /// with every candidate the Executor has begun to inspect.
    fn comparison_frontier_ids(&self) -> BTreeSet<String> {
        let top_score = self
            .candidates
            .values()
            .map(|candidate| candidate.discovery_score_micros)
            .max()
            .unwrap_or(0);
        let threshold = top_score.saturating_mul(DISCOVERY_FRONTIER_RATIO_NUMERATOR)
            / DISCOVERY_FRONTIER_RATIO_DENOMINATOR;
        self.candidates
            .values()
            .filter(|candidate| {
                candidate.discovery_score_micros > 0
                    && candidate.discovery_score_micros >= threshold
                    || candidate.verification_windows > 0
                    || !candidate.cells.is_empty()
            })
            .map(|candidate| candidate.id.clone())
            .collect()
    }

    /// Whether two candidate rows describe the same paper.
    ///
    /// A paper indexed in several registries arrives as several rows — an arXiv
    /// id from one search, a proceedings DOI with no arXiv id from another —
    /// and nothing merges them, because they share no identifier. Left as
    /// rivals, the second row makes the paper block its own confirmation: the
    /// duplicate is unverified, so it holds full optimistic weight against the
    /// very evidence gathered for it.
    #[allow(clippy::unused_self)] // method form keeps it next to the frontier rules it serves
    fn is_same_paper(&self, left: &CandidateState, right: &CandidateState) -> bool {
        let (Some(left_title), Some(right_title)) = (left.title.as_deref(), right.title.as_deref())
        else {
            return false;
        };
        let left_key = normalize_candidate_title(left_title);
        // Short keys collide too easily to stand in for identity.
        left_key.len() >= 12 && left_key == normalize_candidate_title(right_title)
    }

    fn candidate_is_decision_ready(&self, candidate: &CandidateState) -> bool {
        if !self.candidate_is_complete(candidate) {
            return false;
        }
        let confirmed = self.candidate_confirmed_weight(candidate);
        self.comparison_frontier_ids()
            .into_iter()
            .all(|candidate_id| {
                candidate_id == candidate.id
                    || self
                        .candidates
                        .get(&candidate_id)
                        .is_some_and(|challenger| {
                            self.is_same_paper(candidate, challenger)
                                || self.candidate_optimistic_weight(challenger) < confirmed
                        })
            })
    }

    fn candidate_status(&self, candidate: &CandidateState) -> &'static str {
        if candidate
            .cells
            .values()
            .any(|cell| cell.verdict == "excludes")
        {
            "excluded"
        } else if self.candidate_is_decision_ready(candidate) {
            "answer_ready"
        } else if self.candidate_is_complete(candidate) {
            "evidence_complete"
        } else if candidate
            .cells
            .values()
            .any(|cell| cell.verdict == "contradicts")
        {
            "conflicting"
        } else if candidate
            .cells
            .values()
            .any(|cell| cell.verdict == "supports")
        {
            "partially_supported"
        } else if !candidate.cells.is_empty() || candidate.verification_windows > 0 {
            "checking"
        } else {
            "unverified"
        }
    }

    fn candidate_status_priority(&self, candidate: &CandidateState) -> u8 {
        match self.candidate_status(candidate) {
            "answer_ready" => 0,
            "evidence_complete" => 1,
            "partially_supported" => 2,
            "conflicting" => 3,
            "checking" => 4,
            "unverified" => 5,
            "excluded" => 6,
            _ => 7,
        }
    }

    fn candidate_evidence_summary(&self) -> Value {
        let mut counts = BTreeMap::<String, usize>::new();
        for candidate in self.candidates.values() {
            *counts
                .entry(self.candidate_status(candidate).to_string())
                .or_default() += 1;
        }
        let excluded = *counts.get("excluded").unwrap_or(&0);
        json!({
            "candidatesTotal": self.candidates.len(),
            "activeCandidates": self.candidates.len().saturating_sub(excluded),
            "cluesTotal": self.clues.len(),
            "requiredClues": self.clues.values().filter(|clue| clue.required).count(),
            "cluesLocked": self.clues_locked,
            "phase": self.phase.as_str(),
            "corpusSealed": self.phase != RetrievalPhase::Explore,
            "discoveryCalls": self.discovery_calls,
            "assessedCells": self.assessed_cells(),
            "evidenceCompleteCandidates": self.candidates.values().filter(|candidate| self.candidate_is_complete(candidate)).count(),
            "readyCandidates": self.candidates.values().filter(|candidate| self.candidate_is_decision_ready(candidate)).count(),
            "answerReady": self.candidates.values().any(|candidate| self.candidate_is_decision_ready(candidate)),
            "comparisonReady": self.candidates.values().any(|candidate| self.candidate_is_decision_ready(candidate)),
            "comparisonFrontierCandidateIds": self.comparison_frontier_ids(),
            "statusCounts": counts,
        })
    }

    fn clue_values(&self) -> Vec<Value> {
        let mut clues = self.clues.values().collect::<Vec<_>>();
        clues.sort_by_key(|clue| clue.first_seen_at);
        clues
            .into_iter()
            .map(|clue| {
                json!({
                    "clueId": clue.id,
                    "clue": clue.label,
                    "required": clue.required,
                    "evidenceWeight": clue.weight,
                })
            })
            .collect()
    }

    fn candidate_summary_value(&self, candidate: &CandidateState) -> Value {
        let required = self.required_clue_ids();
        let supported = required
            .iter()
            .filter(|clue_id| {
                candidate.cells.get(*clue_id).is_some_and(|cell| {
                    cell.verdict == "supports"
                        && cell.directness == "explicit"
                        && !cell.quotes.is_empty()
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let missing = required
            .into_iter()
            .filter(|clue_id| {
                candidate.cells.get(clue_id).is_none_or(|cell| {
                    cell.verdict != "supports"
                        || cell.directness != "explicit"
                        || cell.quotes.is_empty()
                })
            })
            .collect::<Vec<_>>();
        json!({
            "candidateId": candidate.id,
            "title": candidate.title,
            "titleSource": candidate.title_source,
            "status": self.candidate_status(candidate),
            "verificationWindows": candidate.verification_windows,
            "discoveryMentions": candidate.discovery_mentions,
            "bestDiscoveryRank": candidate.best_discovery_rank,
            "discoveryScoreMicros": candidate.discovery_score_micros,
            "comparisonFrontier": self.comparison_frontier_ids().contains(&candidate.id),
            "confirmedRequiredWeight": self.candidate_confirmed_weight(candidate),
            "optimisticRequiredWeight": self.candidate_optimistic_weight(candidate),
            "totalRequiredWeight": self.total_required_weight(),
            "supportedRequiredClueIds": supported,
            "missingRequiredClueIds": missing,
        })
    }

    fn candidate_evidence_delta(&self, include_clues: bool, include_updates: bool) -> Value {
        let candidate_updates = include_updates
            .then(|| {
                self.candidate_updates
                    .iter()
                    .take(MAX_DELTA_CANDIDATES)
                    .filter_map(|candidate_id| self.candidates.get(candidate_id))
                    .map(|candidate| self.candidate_summary_value(candidate))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let latest_evidence = include_updates
            .then(|| {
                self.latest_evidence_id
                    .as_deref()
                    .and_then(|evidence_id| self.evidence.get(evidence_id))
                    .map(evidence_ref_value)
            })
            .flatten();
        let mut value = json!({
            "schemaVersion": 2,
            "mode": "delta",
            "assessmentOwner": "executor",
            "reviewed": false,
            "summary": self.candidate_evidence_summary(),
            "updates": {
                "candidates": candidate_updates,
                "candidatesOmitted": if include_updates { self.candidate_updates.len().saturating_sub(MAX_DELTA_CANDIDATES) } else { 0 },
                "latestEvidence": latest_evidence,
            },
            "instructions": "Ranking only prioritizes verification. Start with the highest-weight clues and actively seek contradiction. RetrievalEvidence supports requires an exact candidate-bound quote and directness=explicit; partial/contextual similarity must remain inconclusive. Name your best-supported candidate whenever you have one: the runtime labels the answer with the coverage you actually established (已确认 / 高置信 / 未确认) rather than withholding it. What separates 高置信 from 已确认 is summary.comparisonFrontierCandidateIds: each entry other than your candidate still outranks it because nothing has been recorded against it. Ruling one out costs a single RetrievalEvidence with verdict inconclusive or excludes, so check that list before deciding you are done — and stop once it is cleared or the remaining entries are ones you are content to report as unresolved."
        });
        if include_clues {
            value["clues"] = Value::Array(self.clue_values());
        }
        value
    }

    fn candidate_evidence_table(&self, candidate_filter: Option<&str>) -> Value {
        let mut candidates = self
            .candidates
            .values()
            .filter(|candidate| candidate_filter.is_none_or(|id| candidate.id == id))
            .collect::<Vec<_>>();
        candidates.sort_by_key(|candidate| {
            (
                self.candidate_status_priority(candidate),
                std::cmp::Reverse(candidate.last_updated_at),
                candidate.discovery_order,
            )
        });
        let rows = candidates
            .into_iter()
            .map(|candidate| {
                let cells = candidate
                    .cells
                    .iter()
                    .map(|(clue_id, cell)| {
                        let evidence = cell
                            .evidence_ids
                            .iter()
                            .rev()
                            .take(MAX_CELL_EVIDENCE)
                            .filter_map(|evidence_id| self.evidence.get(evidence_id))
                            .map(evidence_ref_value)
                            .collect::<Vec<_>>();
                        (
                            clue_id.clone(),
                            json!({
                                "verdict": cell.verdict,
                                "directness": cell.directness,
                                "note": cell.note,
                                "updatedAtToolCall": cell.updated_at,
                                "evidenceCount": cell.evidence_ids.len(),
                                "quotes": cell.quotes,
                                "evidence": evidence,
                            }),
                        )
                    })
                    .collect::<Map<_, _>>();
                let mut row = self.candidate_summary_value(candidate);
                if let Some(object) = row.as_object_mut() {
                    object.insert(
                        "urls".to_string(),
                        json!(candidate.urls.iter().take(4).collect::<Vec<_>>()),
                    );
                    object.insert("sources".to_string(), json!(candidate.sources));
                    object.insert(
                        "discoveredAtToolCall".to_string(),
                        json!(candidate.discovered_at),
                    );
                    object.insert("cells".to_string(), Value::Object(cells));
                }
                row
            })
            .collect::<Vec<_>>();
        json!({
            "schemaVersion": 2,
            "mode": "full",
            "assessmentOwner": "executor",
            "reviewed": false,
            "summary": self.candidate_evidence_summary(),
            "clues": self.clue_values(),
            "rows": rows,
        })
    }

    fn todo_completion_block(&self, input: &str) -> Option<(&'static str, String)> {
        if !self.candidate_workflow || self.retrieval_calls == 0 {
            return None;
        }
        let value = serde_json::from_str::<Value>(input).ok()?;
        let todos = value.get("todos")?.as_array()?;
        let completed = todos
            .iter()
            .filter(|todo| todo.get("status").and_then(Value::as_str) == Some("completed"))
            .collect::<Vec<_>>();
        let all_done = !todos.is_empty() && completed.len() == todos.len();
        let completed_verification = completed.iter().any(|todo| {
            let text = format!(
                "{} {}",
                todo.get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                todo.get("activeForm")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
            .to_ascii_lowercase();
            [
                "verify",
                "verification",
                "evidence",
                "candidate",
                "paper",
                "验证",
                "核实",
                "证据",
                "候选",
                "论文",
            ]
            .iter()
            .any(|marker| text.contains(marker))
        });
        if self.assessed_cells() == 0 && (completed_verification || all_done) {
            return Some((
                "evidence_assessment_required",
                "Verification cannot be completed while assessedCells=0. Record RetrievalEvidence judgments against the locked clueIds first."
                    .to_string(),
            ));
        }
        if all_done
            && !self
                .candidates
                .values()
                .any(|candidate| self.candidate_is_decision_ready(candidate))
        {
            return Some((
                "candidate_evidence_incomplete",
                "No candidate yet supports every required clue with direct source quotes while leading the comparison frontier, so this cannot be reported as a fully verified identification. You may still answer: name the best-supported candidate and the runtime will label the coverage. Mark the todo complete once you have done that."
                    .to_string(),
            ));
        }
        None
    }

    /// The candidate an answer is *about*, matched by canonical id or title.
    ///
    /// A correct answer routinely names more than one paper: a clue may be
    /// about a sibling work, so establishing it means citing that sibling
    /// alongside the target. Requiring exactly one name therefore mislabelled
    /// correct, fully evidenced answers as unsupported — both an answer naming
    /// FlashAttention and its follow-up read as naming no candidate at all.
    ///
    /// The subject is the best-evidenced candidate among those named, since
    /// that is the one the answer establishes rather than merely cites.
    fn candidate_named_by(&self, answer: &str) -> Option<&CandidateState> {
        let lower = answer.to_ascii_lowercase();
        self.candidates
            .values()
            .filter(|candidate| {
                lower.contains(&candidate.id.to_ascii_lowercase())
                    || candidate
                        .id
                        .strip_prefix("arxiv:")
                        .is_some_and(|id| lower.contains(id))
                    || candidate.title.as_deref().is_some_and(|title| {
                        !title.trim().is_empty()
                            && lower.contains(&title.trim().to_ascii_lowercase())
                    })
            })
            .max_by_key(|candidate| {
                (
                    self.candidate_confirmed_weight(candidate),
                    candidate.cells.len(),
                    candidate.discovery_score_micros,
                )
            })
    }

    fn answer_confidence(&self, answer: &str) -> (AnswerConfidence, Option<&CandidateState>) {
        if !self.clues_locked {
            return (AnswerConfidence::Unconfirmed, None);
        }
        let Some(candidate) = self.candidate_named_by(answer) else {
            return (AnswerConfidence::Unconfirmed, None);
        };
        if self.candidate_is_decision_ready(candidate) {
            return (AnswerConfidence::Confirmed, Some(candidate));
        }
        let confirmed = self.candidate_confirmed_weight(candidate);
        // "High" means this candidate leads on evidence actually recorded, not
        // that it survived every challenger. A named candidate that another
        // candidate outweighs is not a high-confidence answer.
        let leads = confirmed > 0
            && self
                .candidates
                .values()
                .filter(|other| other.id != candidate.id)
                .all(|other| self.candidate_confirmed_weight(other) < confirmed);
        let contradicted = candidate
            .cells
            .values()
            .any(|cell| matches!(cell.verdict.as_str(), "contradicts" | "excludes"));
        if leads && !contradicted {
            (AnswerConfidence::High, Some(candidate))
        } else {
            (AnswerConfidence::Unconfirmed, Some(candidate))
        }
    }

    /// The status header prepended to every candidate-workflow answer.
    ///
    /// It names the coverage the run actually established, so a reader can tell
    /// a fully verified identification from a well-supported best guess without
    /// reading the ledger.
    fn answer_status_header(
        &self,
        confidence: AnswerConfidence,
        candidate: Option<&CandidateState>,
    ) -> String {
        use std::fmt::Write as _;
        let mut header = confidence.label().to_string();
        let Some(candidate) = candidate else {
            let _ = write!(
                header,
                "\n证据：本回合未对任何候选建立直接取证（已评估单元格 {}）。{UNSUPPORTED_CLAIM_NOTICE}",
                self.assessed_cells()
            );
            return header;
        };
        let required = self
            .clues
            .values()
            .filter(|clue| clue.required)
            .collect::<Vec<_>>();
        let supported = required
            .iter()
            .filter(|clue| {
                candidate.cells.get(&clue.id).is_some_and(|cell| {
                    cell.verdict == "supports"
                        && cell.directness == "explicit"
                        && !cell.quotes.is_empty()
                })
            })
            .count();
        let missing = required
            .iter()
            .filter(|clue| {
                !candidate.cells.get(&clue.id).is_some_and(|cell| {
                    cell.verdict == "supports"
                        && cell.directness == "explicit"
                        && !cell.quotes.is_empty()
                })
            })
            .map(|clue| clue.label.clone())
            .collect::<Vec<_>>();
        let _ = write!(
            header,
            "\n候选：{}（{}）\n取证：{} 条必需线索中 {supported} 条已直接取证",
            candidate.title.as_deref().unwrap_or("未命名"),
            candidate.id,
            required.len(),
        );
        if !missing.is_empty() {
            let _ = write!(header, "\n未核实：{}", missing.join("；"));
        }
        if confidence == AnswerConfidence::Unconfirmed {
            header.push('\n');
            header.push_str(UNSUPPORTED_CLAIM_NOTICE);
        }
        header
    }

    /// Labels a candidate-workflow answer instead of withholding it.
    ///
    /// The model may name its best candidate at any point. What the runtime
    /// still owns is the confidence claim: the header is computed from recorded
    /// evidence only, so an unverified guess cannot present itself as a
    /// confirmed identification.
    pub(crate) fn gate_final_answer(&mut self, answer: &str) -> RetrievalAnswerGate {
        if self.report_only {
            return RetrievalAnswerGate::Allow;
        }
        // Abandoned refusals are reported on *every* turn, not only a candidate
        // workflow. Most retrieval turns are not candidate identification, and
        // the refusals that survive there — a scope violation, a request that
        // failed its retry budget — remove exactly as much requested work. An
        // answer that already opens with 未确认 still gets the line: conceding
        // low confidence is not the same as disclosing which searches never ran.
        let refusals = self.abandoned_refusal_note();
        if self.candidate_workflow && !explicit_unconfirmed_answer(answer) {
            // One status block, not two competing ones: coverage and the gap in
            // it belong to the same statement about what this turn established.
            let (confidence, candidate) = self.answer_confidence(answer);
            let mut header = self.answer_status_header(confidence, candidate);
            if let Some(note) = refusals {
                header.push('\n');
                header.push_str(&note);
            }
            return RetrievalAnswerGate::Replace {
                answer: format!("{header}\n\n{}", answer.trim_start()),
            };
        }
        let Some(note) = refusals else {
            return RetrievalAnswerGate::Allow;
        };
        RetrievalAnswerGate::Replace {
            answer: format!("{note}\n\n{}", answer.trim_start()),
        }
    }

    fn apply_source_policy(&self, tool_name: &str, input: &str) -> Result<String, String> {
        if !self.only_arxiv {
            return Ok(input.to_string());
        }
        let mut value = serde_json::from_str::<Value>(input).map_err(|error| {
            format!("invalid tool input while enforcing arXiv-only scope: {error}")
        })?;
        match tool_name {
            "LiteratureSearch" => {
                object_mut(&mut value)?.insert("sources".to_string(), json!(["arxiv"]));
            }
            "WebSearch" => {
                object_mut(&mut value)?.insert("allowed_domains".to_string(), json!(["arxiv.org"]));
            }
            "WebFetch" => {
                let url = value
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        value
                            .get("cursor")
                            .and_then(Value::as_str)
                            .and_then(cursor_request_url)
                    })
                    .ok_or_else(|| {
                        "arXiv-only WebFetch requires an arxiv.org URL or a signed cursor carrying one"
                            .to_string()
                    })?;
                if !is_official_arxiv_url(&url) {
                    return Err(format!(
                        "Only official arXiv sources are allowed for this turn; blocked {url}"
                    ));
                }
            }
            "LiteraturePdfDownload" => {
                let url = value.get("url").and_then(Value::as_str).ok_or_else(|| {
                    "arXiv-only PDF download requires an arxiv.org URL".to_string()
                })?;
                if !is_official_arxiv_url(url) {
                    return Err(format!(
                        "Only official arXiv sources are allowed for this turn; blocked {url}"
                    ));
                }
            }
            "bash" | "PowerShell" | "REPL" | "NotebookExecute"
                if is_network_tool_call(tool_name, input) =>
            {
                let command = value
                    .get(if matches!(tool_name, "REPL" | "NotebookExecute") {
                        "code"
                    } else {
                        "command"
                    })
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let urls = urls_in_text(command);
                if urls.is_empty() || urls.iter().any(|url| !is_official_arxiv_url(url)) {
                    return Err(
                        "Network-capable code may not bypass the explicit arXiv-only source scope. Use LiteratureSearch/WebFetch with official arxiv.org URLs."
                            .to_string(),
                    );
                }
            }
            _ => {}
        }
        serde_json::to_string(&value).map_err(|error| error.to_string())
    }

    fn verification_target_is_frozen(&self, tool_name: &str, input: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(input) else {
            return false;
        };
        if tool_name == "LiteraturePdfDownload" {
            if let Some(paper_id) = value.get("paperId").and_then(Value::as_str) {
                if self.candidates.contains_key(paper_id) {
                    return true;
                }
            }
        }
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                value
                    .get("cursor")
                    .and_then(Value::as_str)
                    .and_then(cursor_request_url)
            });
        let Some(url) = url else {
            return false;
        };
        let seed = CandidateSeed {
            url: Some(url.clone()),
            ..CandidateSeed::default()
        };
        if candidate_identity(&seed).is_some_and(|id| self.candidates.contains_key(&id)) {
            return true;
        }
        canonical_url(&url).is_some_and(|url| {
            self.candidates
                .values()
                .any(|candidate| candidate.urls.contains(&url))
        })
    }

    fn observe_web_fetch(
        &mut self,
        input: &str,
        output: String,
        call_number: usize,
        notes: &mut Vec<String>,
    ) -> String {
        let Ok(value) = serde_json::from_str::<Value>(&output) else {
            return output;
        };
        let content_hash = value
            .get("contentHash")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let window_hash = value
            .get("windowHash")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(|result| sha256_hex(result.as_bytes()))
            })
            .unwrap_or_default();
        let window_key = format!("{content_hash}:{window_hash}");
        let markdown_path = value
            .pointer("/snapshot/markdownPath")
            .and_then(Value::as_str)
            .map(str::to_string);
        let candidate_id = self.register_candidate(
            CandidateSeed {
                url: value.get("url").and_then(Value::as_str).map(str::to_string),
                title: value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                arxiv_id: None,
                doi: None,
            },
            "WebFetch",
            call_number,
            None,
        );
        if let Some(candidate_id) = candidate_id.as_deref() {
            if let Some(path) = markdown_path.as_deref() {
                self.snapshot_candidates
                    .insert(normalize_snapshot_path(path), candidate_id.to_string());
            }
            if window_key != ":" {
                let evidence_id = format!(
                    "evidence:{}",
                    &sha256_hex(format!("{content_hash}\0{window_hash}").as_bytes())[..16]
                );
                let is_new = !self.evidence.contains_key(&evidence_id);
                self.evidence
                    .entry(evidence_id.clone())
                    .or_insert_with(|| EvidenceRef {
                        id: evidence_id.clone(),
                        candidate_id: candidate_id.to_string(),
                        clue_id: None,
                        kind: "web_window".to_string(),
                        tool_call: call_number,
                        content_hash: Some(content_hash.to_string()),
                        window_hash: Some(window_hash.clone()),
                        path: markdown_path.clone(),
                        locator: web_fetch_locator(&value),
                        source_text: value
                            .get("result")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                if let Some(candidate) = self.candidates.get_mut(candidate_id) {
                    candidate.last_updated_at = call_number;
                    if is_new {
                        candidate.verification_windows += 1;
                    }
                }
                self.latest_evidence_id = Some(evidence_id);
            }
        }
        if let Some(key) = fresh_web_fetch_key(input) {
            let state = self.fetches.entry(key).or_default();
            if markdown_path.is_some() {
                state.markdown_path.clone_from(&markdown_path);
            }
            if state.fresh_attempts == MAX_FRESH_FETCHES_PER_URL {
                if let Some(path) = state.markdown_path.as_deref() {
                    notes.push(format!(
                        "This is the second fresh fetch for the same URL. Further fresh fetches are blocked; search the persisted snapshot with grep_search/read_file at {path}."
                    ));
                }
            }
        }
        if window_key != ":" {
            if let Some(first_seen_call) = self.seen_windows.get(&window_key).copied() {
                return serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "status": "duplicate_window",
                    "duplicate": true,
                    "firstSeenCall": first_seen_call,
                    "currentCall": call_number,
                    "contentHash": content_hash,
                    "windowHash": window_hash,
                    "contentWindow": value.get("contentWindow").cloned().unwrap_or(Value::Null),
                    "snapshot": value.get("snapshot").cloned().unwrap_or(Value::Null),
                    "recommendedAction": "Reuse the existing evidence. Search snapshot.markdownPath with grep_search/read_file if another passage is needed; do not fetch this URL again."
                }))
                .unwrap_or(output);
            }
            self.seen_windows.insert(window_key, call_number);
        }
        output
    }

    fn observe_web_search(
        &mut self,
        input: &str,
        output: String,
        call_number: usize,
        notes: &mut Vec<String>,
    ) -> String {
        let Ok(input_value) = serde_json::from_str::<Value>(input) else {
            return output;
        };
        let Ok(output_value) = serde_json::from_str::<Value>(&output) else {
            return output;
        };
        self.register_candidates_from_value(&output_value, "WebSearch", call_number);
        let query = input_value
            .get("query")
            .and_then(Value::as_str)
            .map(normalize_query)
            .unwrap_or_default();
        let mut urls = Vec::new();
        collect_urls(&output_value, &mut urls);
        urls.sort_unstable();
        urls.dedup();
        if query.is_empty() || urls.is_empty() {
            return output;
        }
        let result_hash = sha256_hex(urls.join("\n").as_bytes());
        let key = format!("{query}:{result_hash}");
        if let Some(first_seen_call) = self.seen_search_batches.get(&key).copied() {
            notes.push(format!(
                "This search repeated the same normalized query and canonical result set first seen at tool call {first_seen_call}. Reformulate materially or verify an existing candidate."
            ));
        } else {
            self.seen_search_batches.insert(key, call_number);
        }
        output
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{key} is required and must be a non-empty string"))
}

fn collect_candidate_seeds(value: &Value, seeds: &mut Vec<CandidateSeed>) {
    match value {
        Value::Object(object) => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .or_else(|| object.get("pdfUrl").and_then(Value::as_str));
            let arxiv_id = object.get("arxivId").and_then(Value::as_str);
            let doi = object.get("doi").and_then(Value::as_str);
            if url.is_some() || arxiv_id.is_some() || doi.is_some() {
                seeds.push(CandidateSeed {
                    url: url.map(str::to_string),
                    title: object
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    arxiv_id: arxiv_id.map(str::to_string),
                    doi: doi.map(str::to_string),
                });
            }
            for child in object.values() {
                collect_candidate_seeds(child, seeds);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_candidate_seeds(child, seeds);
            }
        }
        _ => {}
    }
}

fn candidate_identity(seed: &CandidateSeed) -> Option<String> {
    seed.arxiv_id
        .as_deref()
        .and_then(normalize_arxiv_id)
        .or_else(|| {
            seed.url
                .as_deref()
                .and_then(arxiv_id_from_url)
                .map(|id| format!("arxiv:{id}"))
        })
        .or_else(|| {
            seed.doi
                .as_deref()
                .map(str::trim)
                .filter(|doi| !doi.is_empty())
                .map(|doi| format!("doi:{}", doi.to_ascii_lowercase()))
        })
        .or_else(|| {
            seed.url
                .as_deref()
                .and_then(canonical_url)
                .map(|url| format!("url:{}", &sha256_hex(url.as_bytes())[..12]))
        })
}

fn normalize_arxiv_id(raw: &str) -> Option<String> {
    static ARXIV_ID: OnceLock<Regex> = OnceLock::new();
    ARXIV_ID
        .get_or_init(|| {
            Regex::new(r"(?i)(?:arxiv\s*:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?")
                .expect("valid arXiv id regex")
        })
        .captures(raw.trim())
        .and_then(|captures| captures.get(1))
        .map(|id| format!("arxiv:{}", id.as_str().to_ascii_lowercase()))
}

fn arxiv_id_from_url(raw: &str) -> Option<String> {
    let canonical = canonical_url(raw)?;
    let rest = canonical.split_once("://")?.1;
    let authority = rest.split('/').next().unwrap_or_default();
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or(authority);
    if !matches!(
        host,
        "arxiv.org" | "export.arxiv.org" | "ar5iv.labs.arxiv.org"
    ) {
        return None;
    }
    normalize_arxiv_id(rest).and_then(|id| id.strip_prefix("arxiv:").map(str::to_string))
}

fn normalize_clue(clue: &str) -> String {
    clue.to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Title key used to recognise two records of the same paper.
///
/// Deliberately aggressive — punctuation, spacing and case all vary between the
/// registries a single paper is indexed in, and two records that agree on every
/// letter and digit of a long title are not two papers.
fn normalize_candidate_title(title: &str) -> String {
    title
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether a discovered record describes a paper at all.
///
/// Crossref registers components of a paper — tables, figures, supplements —
/// under their own DOIs, and a metadata search returns them alongside real
/// work. One such row ("Table 5: Comparison of computational complexity, GPU
/// memory usage, …") reached a comparison frontier as a rival to the paper it
/// was printed in, where it could only ever hold up a decision.
fn is_paper_like_candidate(seed: &CandidateSeed) -> bool {
    if let Some(doi) = seed.doi.as_deref().map(str::trim) {
        // A component DOI is the parent DOI plus a typed suffix.
        if let Some((_, tail)) = doi.to_ascii_lowercase().rsplit_once('/') {
            let component = tail
                .split_once(['-', '_'])
                .filter(|(_, index)| {
                    !index.is_empty() && index.chars().all(|c| c.is_ascii_alphanumeric())
                })
                .map(|(kind, _)| kind);
            if component.is_some_and(|kind| {
                matches!(
                    kind,
                    "table"
                        | "tab"
                        | "fig"
                        | "figure"
                        | "supp"
                        | "suppl"
                        | "app"
                        | "appendix"
                        | "scheme"
                        | "chart"
                        | "eq"
                        | "equation"
                )
            }) {
                return false;
            }
        }
    }
    // Component titles are formulaic: a type word followed by its number. The
    // trailing digit requirement keeps real titles ("Table Tennis Robot …").
    let title = seed.title.as_deref().unwrap_or_default().trim();
    let mut words = title.split_whitespace();
    let (Some(first), Some(second)) = (words.next(), words.next()) else {
        return true;
    };
    let kind = first.trim_end_matches('.').to_ascii_lowercase();
    let numbered = second
        .trim_end_matches(|character: char| !character.is_alphanumeric())
        .chars()
        .all(|character| character.is_ascii_digit())
        && second.chars().any(|character| character.is_ascii_digit());
    !(numbered
        && matches!(
            kind.as_str(),
            "table" | "fig" | "figure" | "scheme" | "chart" | "appendix" | "equation" | "eq"
        ))
}

fn normalize_evidence_text(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut pending_space = false;
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.push(character);
            pending_space = false;
        } else {
            pending_space = true;
        }
    }
    normalized
}

fn meaningful_clue_anchors(clue: &str) -> BTreeSet<String> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    const STOPWORDS: &[&str] = &[
        "about",
        "after",
        "another",
        "based",
        "before",
        "between",
        "candidate",
        "does",
        "from",
        "into",
        "method",
        "paper",
        "shows",
        "target",
        "that",
        "the",
        "their",
        "this",
        "through",
        "using",
        "with",
        "without",
    ];
    TOKEN
        .get_or_init(|| Regex::new(r"(?i)[a-z][a-z0-9_-]+|\d+(?:\.\d+)?%?").expect("token regex"))
        .find_iter(clue)
        .map(|matched| matched.as_str().to_ascii_lowercase())
        .filter(|token| token.len() >= 2 && !STOPWORDS.contains(&token.as_str()))
        .collect()
}

fn hard_clue_anchors(clue: &str) -> BTreeSet<String> {
    static HARD_ANCHOR: OnceLock<Regex> = OnceLock::new();
    HARD_ANCHOR
        .get_or_init(|| {
            Regex::new(r"(?:\d+(?:\.\d+)?%?)|(?:\b[A-Z][A-Z0-9-]{1,11}\b)")
                .expect("hard anchor regex")
        })
        .find_iter(clue)
        .map(|matched| normalize_evidence_text(matched.as_str()))
        .filter(|anchor| !anchor.is_empty())
        .collect()
}

/// Higher weights only influence verification order and the confidence-gap
/// calculation. They never make a candidate true by themselves.
fn clue_evidence_weight(clue: &str) -> u8 {
    let lower = clue.to_ascii_lowercase();
    let has_number = lower.chars().any(|character| character.is_ascii_digit())
        || lower.contains('%')
        || lower.contains('≈')
        || lower.contains("百分点");
    let has_relational_anchor = [
        "cite",
        "citation",
        "reference",
        "table",
        "baseline",
        "zero-shot",
        "cross-dataset",
        "引用",
        "表格",
        "基线",
        "提升",
        "下降",
        "跌到",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    match (has_number, has_relational_anchor) {
        (true, true) => 4,
        (true, false) | (false, true) => 3,
        (false, false) if meaningful_clue_anchors(clue).len() >= 4 => 2,
        (false, false) => 1,
    }
}

fn normalize_snapshot_path(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn web_fetch_locator(value: &Value) -> Option<String> {
    let chunk = value
        .pointer("/contentWindow/sourceChunk")
        .and_then(Value::as_u64)?;
    let start = value
        .pointer("/contentWindow/startChar")
        .and_then(Value::as_u64)?;
    let end = value
        .pointer("/contentWindow/endChar")
        .and_then(Value::as_u64)?;
    Some(format!("source chunk {chunk}, chars {start}-{end}"))
}

fn push_bounded_unique(values: &mut Vec<String>, value: String) {
    values.retain(|existing| existing != &value);
    values.push(value);
    if values.len() > MAX_CELL_EVIDENCE {
        values.remove(0);
    }
}

fn candidate_title_priority(source: &str) -> u8 {
    match source {
        "LiteratureSearch" => 3,
        "WebSearch" => 2,
        "WebFetch" => 1,
        _ => 0,
    }
}

fn evidence_ref_value(evidence: &EvidenceRef) -> Value {
    json!({
        "evidenceId": evidence.id,
        "candidateId": evidence.candidate_id,
        "kind": evidence.kind,
        "toolCall": evidence.tool_call,
        "clueId": evidence.clue_id,
        "contentHash": evidence.content_hash,
        "windowHash": evidence.window_hash,
        "path": evidence.path,
        "locator": evidence.locator,
    })
}

fn attach_candidate_evidence(output: String, table: Value) -> String {
    if let Ok(mut value) = serde_json::from_str::<Value>(&output) {
        if let Some(object) = value.as_object_mut() {
            object.insert("candidateEvidence".to_string(), table);
            return serde_json::to_string_pretty(&value).unwrap_or(output);
        }
    }
    format!(
        "{output}\n\nCandidate evidence ledger:\n{}",
        serde_json::to_string_pretty(&table).unwrap_or_default()
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetrievalKind {
    Discovery,
    Verification,
}

/// The retrieval role a tool plays, decided by name alone.
///
/// **A tool that reaches an external source for content must be listed here.**
/// Everything the guard does — discovery accounting, the corpus seal, duplicate
/// suppression, the total-call budget — is keyed off this function, so a
/// retrieval tool missing from it is invisible to all of them at once.
/// `LiteratureSearchExecute` was exactly that: the protocol route ran fourteen
/// searches while the guard counted two, which left the seal unreachable
/// (`validate_corpus_seal` wants two discovery calls) at the same time as
/// `LiteraturePdfDownload` — which *is* listed — was refused for not sealing.
///
/// Membership is about performing retrieval, not about being related to it.
/// `LiteratureSearchProtocolCreate` and `LiteratureSearchPreview` only write
/// and read a plan, and `LiteratureBrowserDownloadTask` returns a task
/// descriptor for the desktop to run; none of them opens a connection, so none
/// of them should consume a retrieval budget or be deduplicated.
fn retrieval_role(tool_name: &str) -> Option<RetrievalRole> {
    Some(match tool_name {
        "WebSearch" | "LiteratureSearch" | "LiteratureCitations"
        | "LiteratureSearchExecute" => RetrievalRole::Discovery,
        "WebFetch" | "LiteraturePdfDownload" => RetrievalRole::Verification,
        "bash" | "PowerShell" | "REPL" | "NotebookExecute" => RetrievalRole::NetworkDependent,
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetrievalRole {
    Discovery,
    Verification,
    /// Retrieval only when this particular call reaches the network.
    NetworkDependent,
}

/// Whether a tool can perform external retrieval at all.
///
/// Exposed so the tool inventory can assert in a test that every tool has been
/// triaged, mirroring [`crate::tool_outcome::classifies_failures`]. A
/// hand-kept list nobody is forced to update is one a new tool falls out of.
#[must_use]
pub fn performs_retrieval(tool_name: &str) -> bool {
    retrieval_role(tool_name).is_some()
}

fn retrieval_kind(tool_name: &str, input: &str) -> Option<RetrievalKind> {
    match retrieval_role(tool_name)? {
        RetrievalRole::Discovery => Some(RetrievalKind::Discovery),
        RetrievalRole::Verification => Some(RetrievalKind::Verification),
        RetrievalRole::NetworkDependent => {
            is_network_tool_call(tool_name, input).then_some(RetrievalKind::Discovery)
        }
    }
}

fn fresh_web_fetch_key(input: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(input).ok()?;
    if value.get("cursor").and_then(Value::as_str).is_some() {
        return None;
    }
    canonical_url(value.get("url")?.as_str()?)
}

fn deterministic_request_key(
    tool_name: &str,
    input: &str,
    provider_fingerprint: Option<&str>,
) -> Option<String> {
    retrieval_kind(tool_name, input)?;
    // The compiled provider request is the unit that costs a quota slot. Two
    // differently worded searches that compile to the same provider query are
    // one request, and were previously billed as two.
    if let Some(fingerprint) = provider_fingerprint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(sha256_hex(
            format!("{tool_name} provider {fingerprint}").as_bytes(),
        ));
    }
    let mut value = serde_json::from_str::<Value>(input).ok()?;
    if let Some(object) = value.as_object_mut() {
        if let Some(query) = object.get_mut("query") {
            if let Some(text) = query.as_str() {
                *query = Value::String(normalize_query(text));
            }
        }
        if let Some(url) = object.get_mut("url") {
            if let Some(canonical) = url.as_str().and_then(canonical_url) {
                *url = Value::String(canonical);
            }
        }
    }
    Some(sha256_hex(
        format!("{tool_name}\0{}", canonical_json(&value)).as_bytes(),
    ))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn object_mut(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| "tool input must be a JSON object".to_string())
}

fn blocked_output(phase: RetrievalPhase, code: &str, message: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "schemaVersion": 1,
        "status": "blocked",
        "code": code,
        "phase": phase.as_str(),
        "message": message
    }))
    .unwrap_or_else(|_| message.to_string())
}

fn attach_retrieval_control(
    output: String,
    phase: RetrievalPhase,
    tool_call_number: usize,
    retrieval_call_number: usize,
    notes: Vec<String>,
) -> String {
    if let Ok(mut value) = serde_json::from_str::<Value>(&output) {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "retrievalControl".to_string(),
                json!({
                    "phase": phase.as_str(),
                    "toolCall": tool_call_number,
                    "retrievalCall": retrieval_call_number,
                    "notes": notes,
                }),
            );
            return serde_json::to_string_pretty(&value).unwrap_or(output);
        }
    }
    format!(
        "{output}\n\nRetrieval control (phase {}, tool call {tool_call_number}, retrieval call {retrieval_call_number}): {}",
        phase.as_str(),
        notes.join(" ")
    )
}

fn explicitly_requests_only_arxiv(text: &str) -> bool {
    let compact = text
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    compact.contains("只搜索arxiv")
        || compact.contains("仅搜索arxiv")
        || compact.contains("只查arxiv")
        || compact.contains("仅查arxiv")
        || compact.contains("onlysearcharxiv")
        || compact.contains("searchonlyarxiv")
        || compact.contains("arxivonly")
}

fn explicitly_requests_web_search(text: &str) -> bool {
    let compact = text
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    [
        "websearch",
        "searchtheweb",
        "网页搜索",
        "网络搜索",
        "用网页",
        "搜索网页",
        "google",
        "bing",
        "duckduckgo",
        "brave",
        "exa",
    ]
    .iter()
    .any(|marker| compact.contains(marker))
}

fn introduced_named_identifiers(label: &str, source_question: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    label
        .split(|character: char| !(character.is_alphanumeric() || character == '-'))
        .map(str::trim)
        .filter(|token| looks_like_named_identifier(token))
        .filter(|token| !source_question.contains(&token.to_ascii_lowercase()))
        .filter(|token| seen.insert(token.to_ascii_lowercase()))
        .map(str::to_string)
        .collect()
}

fn looks_like_named_identifier(token: &str) -> bool {
    let letters = token
        .chars()
        .filter(|character| character.is_ascii_alphabetic())
        .collect::<Vec<_>>();
    if letters.len() < 2 {
        return false;
    }
    let has_upper = letters
        .iter()
        .any(|character| character.is_ascii_uppercase());
    let all_upper = letters
        .iter()
        .all(|character| character.is_ascii_uppercase());
    let has_digit = token.chars().any(|character| character.is_ascii_digit());
    let has_hyphen = token.contains('-');
    let has_internal_upper = token
        .chars()
        .skip(1)
        .any(|character| character.is_ascii_uppercase());
    (all_upper && token.len() >= 2)
        || (has_upper && (has_digit || has_hyphen || has_internal_upper))
}

fn is_direct_arxiv_api_fetch(input: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(input) else {
        return false;
    };
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .get("cursor")
                .and_then(Value::as_str)
                .and_then(cursor_request_url)
        });
    let Some(url) = url else {
        return false;
    };
    let lower = url.to_ascii_lowercase();
    let is_arxiv_host = lower.starts_with("https://export.arxiv.org/")
        || lower.starts_with("http://export.arxiv.org/")
        || lower.starts_with("https://arxiv.org/")
        || lower.starts_with("http://arxiv.org/")
        || lower.starts_with("https://www.arxiv.org/")
        || lower.starts_with("http://www.arxiv.org/");
    is_arxiv_host && lower.contains("/api/query")
}

/// Whether the user is asking the runtime to identify **one particular paper**
/// they can describe but cannot name.
///
/// This gates a protocol built for exactly that task — 4-6 stable clues locked
/// up front, a frozen first-pass corpus, per-clue quoted evidence — and it is
/// the wrong shape for anything else. It used to fire on any subject word
/// ("论文", "paper") together with any intent word ("检索", "搜索", "find",
/// "search"), which matches an ordinary literature review word for word. A
/// survey request then had to produce stable clues for a paper that does not
/// exist before it was allowed to search at all, and every download it tried
/// first was refused for a plan it had no way to write.
///
/// So identification now has to be stated, not inferred from the presence of
/// searching: a phrase that points at a single unnamed document. Aggregate work
/// disqualifies outright, because "先做综述再确定哪篇最早" is a survey with an
/// identification aside, not an identification task. Both directions fail open
/// — an unrecognized request is an ordinary retrieval turn, still bounded by
/// [`TOTAL_RETRIEVAL_CALL_LIMIT`] and the duplicate/failed-request guards, and
/// merely without the clue ledger. That is a far cheaper mistake than refusing
/// a survey's every call.
fn requests_candidate_research(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let candidate_subject = ["paper", "article", "arxiv", "论文", "文章"]
        .iter()
        .any(|marker| lower.contains(marker));
    if !candidate_subject {
        return false;
    }
    // Aggregate retrieval, whatever else the request also says.
    let aggregate_work = [
        "综述",
        "文献调研",
        "调研一下",
        "相关工作",
        "研究现状",
        "多篇",
        "若干篇",
        "几篇",
        "一批",
        "survey",
        "related work",
        "literature review",
        "systematic review",
        "review of",
        "papers about",
        "papers on",
        "papers related",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    if aggregate_work {
        return false;
    }
    // Verbs that name a target, not verbs that fetch a set. "检索" / "搜索" /
    // "search" used to sit in this list, which is what made every survey a
    // candidate identification: retrieving is what *all* retrieval requests
    // ask for, so it cannot be the thing that distinguishes one of them.
    [
        "find",
        "identify",
        "locate",
        "determine",
        "which paper",
        "what paper",
        "which article",
        "what article",
        "寻找",
        "找出",
        "确定",
        "哪篇",
        "哪一篇",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn explicit_unconfirmed_answer(answer: &str) -> bool {
    let trimmed = answer
        .trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, '#' | '*' | '_' | '-' | '>')
        })
        .to_ascii_lowercase();
    trimmed.starts_with("状态：未确认")
        || trimmed.starts_with("状态:未确认")
        || trimmed.starts_with("status: unconfirmed")
        || trimmed.starts_with("status:unconfirmed")
}

fn cursor_request_url(raw_cursor: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw_cursor)
        .ok()?
        .get("requestUrl")?
        .as_str()
        .map(str::to_string)
}

fn canonical_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..authority_end)?.to_ascii_lowercase();
    let suffix = rest.get(authority_end..).unwrap_or_default();
    let suffix = suffix
        .split('#')
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    Some(format!(
        "{}://{authority}{suffix}",
        scheme.to_ascii_lowercase()
    ))
}

fn is_official_arxiv_url(raw: &str) -> bool {
    canonical_url(raw).is_some_and(|url| {
        let rest = url
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or_default();
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = authority.rsplit('@').next().unwrap_or(authority);
        let host = host.split(':').next().unwrap_or(host);
        host == "arxiv.org" || host == "export.arxiv.org"
    })
}

fn is_network_tool_call(tool_name: &str, input: &str) -> bool {
    if !matches!(
        tool_name,
        "bash" | "PowerShell" | "REPL" | "NotebookExecute"
    ) {
        return false;
    }
    let source_key = if matches!(tool_name, "REPL" | "NotebookExecute") {
        "code"
    } else {
        "command"
    };
    let command = serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|value| {
            value
                .get(source_key)
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "http://",
        "https://",
        "curl ",
        "wget ",
        "invoke-webrequest",
        "invoke-restmethod",
        "requests.get",
        "urllib.request",
        "urlopen(",
        "httpx.",
        "fetch(",
    ]
    .iter()
    .any(|marker| command.contains(marker))
}

fn urls_in_text(text: &str) -> Vec<&str> {
    static URLS: OnceLock<Regex> = OnceLock::new();
    URLS.get_or_init(|| Regex::new(r#"https?://[^\s\"'<>|;]+"#).expect("valid URL regex"))
        .find_iter(text)
        .map(|matched| matched.as_str())
        .collect()
}

fn normalize_query(query: &str) -> String {
    query
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn collect_urls(value: &Value, urls: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key.eq_ignore_ascii_case("url") {
                    if let Some(url) = value.as_str().and_then(canonical_url) {
                        urls.push(url);
                    }
                } else {
                    collect_urls(value, urls);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_urls(item, urls);
            }
        }
        _ => {}
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "tests/retrieval_guard.rs"]
mod tests;

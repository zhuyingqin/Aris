import { create } from "zustand";
import {
  isTauri,
  literatureDownloadPdf,
  literatureImportPdf,
  literatureLibraryUpsert,
  literatureLlm,
  literatureReviewLlm,
  literatureLlmVision,
  literatureLoad,
  literaturePdfOpen,
  literatureSave,
  literatureSearch,
  onChatDone,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import {
  emptyLibrary,
  type ActivityEntry,
  type ActivityLevel,
  type AnchorKind,
  type BriefSection,
  type CriterionKind,
  type CriteriaSuggestion,
  type LiteratureLibrary,
  type LiteraturePaper,
  type LiteratureReviewTask,
  type LiteratureSearchResult,
  type LiteratureUpsertResult,
  type PdfAnnotation,
  type PaperBrief,
  type PaperFit,
  type PaperScreening,
  type PaperStage,
  type PdfDownloadResult,
  type ProjectFocus,
  type ReadingAnswerChain,
  type ScreeningCriterion,
  type ScreeningDecision,
  type ScreeningReason,
} from "./literatureTypes";
import {
  extractPdfPageImages,
  extractPdfTextByPage,
  type PdfExtraction,
  type PdfPageImage,
} from "./pdfExtraction";

const MAX_ACTIVITY_ENTRIES = 200;

const PERSIST_DELAY_MS = 600;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const isoNow = () => new Date().toISOString();

const PAPER_STAGES = new Set<PaperStage>([
  "inbox",
  "screened",
  "shortlist",
  "downloaded",
  "read",
  "excluded",
]);

const PDF_STATUSES = new Set(["none", "queued", "downloading", "downloaded", "failed"]);

const normalizePaper = (paper: Partial<LiteraturePaper>, index: number): LiteraturePaper => {
  const pdf = paper.pdf && typeof paper.pdf === "object" ? paper.pdf : { status: "none" as const };
  return {
    ...paper,
    id: typeof paper.id === "string" && paper.id.trim() ? paper.id : `paper:${index}`,
    title: typeof paper.title === "string" && paper.title.trim() ? paper.title : "Untitled paper",
    authors: Array.isArray(paper.authors) ? paper.authors.filter((value) => typeof value === "string") : [],
    venue: typeof paper.venue === "string" ? paper.venue : "",
    abstract: typeof paper.abstract === "string" ? paper.abstract : "",
    tags: Array.isArray(paper.tags) ? paper.tags.filter((value) => typeof value === "string") : [],
    collectionIds: Array.isArray(paper.collectionIds)
      ? paper.collectionIds.filter((value) => typeof value === "string")
      : [],
    searchIds: Array.isArray(paper.searchIds)
      ? paper.searchIds.filter((value) => typeof value === "string")
      : [],
    stage: PAPER_STAGES.has(paper.stage as PaperStage) ? paper.stage as PaperStage : "inbox",
    starred: paper.starred === true,
    unread: paper.unread !== false,
    source: typeof paper.source === "string" ? paper.source : "",
    addedAt: typeof paper.addedAt === "string" ? paper.addedAt : isoNow(),
    pdf: {
      ...pdf,
      status: PDF_STATUSES.has(pdf.status) ? pdf.status : "none",
    },
    evidence: Array.isArray(paper.evidence) ? paper.evidence : [],
    answerChains: Array.isArray(paper.answerChains)
      ? paper.answerChains.map((chain) => ({
          ...chain,
          reviewStatus:
            chain.reviewStatus === "accepted" || chain.reviewStatus === "rejected"
              ? chain.reviewStatus
              : "unreviewed",
        }))
      : [],
    pdfAnnotations: Array.isArray(paper.pdfAnnotations) ? paper.pdfAnnotations : [],
  };
};

const normalizeLibrary = (raw: Partial<LiteratureLibrary>): LiteratureLibrary => ({
  version: 1,
  papers: Array.isArray(raw.papers) ? raw.papers.map(normalizePaper) : [],
  searches: Array.isArray(raw.searches) ? raw.searches : [],
  collections: Array.isArray(raw.collections) ? raw.collections : [],
  reviewTasks: Array.isArray(raw.reviewTasks)
    ? raw.reviewTasks.map((task) => ({
        ...task,
        criteria: Array.isArray(task.criteria) ? task.criteria : [],
        searchIds: Array.isArray(task.searchIds) ? task.searchIds : [],
        suggestions: Array.isArray(task.suggestions) ? task.suggestions : [],
      }))
    : [],
  projectFocus: raw.projectFocus,
});

const normalizedTitle = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]/g, "");

const pdfFileName = (paper: LiteraturePaper) => {
  if (paper.arxivId) return `${paper.arxivId.replace(/\//g, "-")}.pdf`;
  if (paper.doi) return `${paper.doi.replace(/[/\\:]/g, "-")}.pdf`;
  return `${normalizedTitle(paper.title).slice(0, 60) || "paper"}.pdf`;
};

const STOP_WORDS = new Set([
  "about",
  "addresses",
  "and",
  "are",
  "based",
  "clear",
  "connection",
  "directly",
  "discuss",
  "exclude",
  "for",
  "from",
  "into",
  "must",
  "only",
  "paper",
  "papers",
  "question",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const unique = <T,>(values: T[]) => Array.from(new Set(values));

const tokensFrom = (text: string) =>
  unique(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );

const draftCriteriaForQuery = (query: string): ScreeningCriterion[] => {
  const now = isoNow();
  const trimmed = query.trim();
  return [
    {
      id: makeId("crit"),
      kind: "include",
      text: trimmed ? `Must directly discuss ${trimmed}` : "Must directly address the question",
      createdAt: now,
    },
    {
      id: makeId("crit"),
      kind: "exclude",
      text: "Exclude papers with no clear connection to the question",
      createdAt: now,
    },
  ];
};

const reviewTaskFromQuery = (question: string, searchIds: string[]): LiteratureReviewTask => ({
  id: makeId("task"),
  question: question.trim() || "Untitled literature question",
  criteria: draftCriteriaForQuery(question),
  searchIds,
  createdAt: isoNow(),
  updatedAt: isoNow(),
  suggestions: [],
});

const scoreToFit = (score: number): PaperFit => {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
};

const stageForDecision = (decision: ScreeningDecision): PaperStage => {
  if (decision === "include") return "shortlist";
  if (decision === "exclude") return "excluded";
  return "screened";
};

const paperSearchText = (paper: LiteraturePaper) =>
  `${paper.title}\n${paper.abstract}\n${paper.venue}`.toLowerCase();

const firstUsefulQuote = (paper: LiteraturePaper) => {
  const abstract = paper.abstract.trim();
  if (!abstract) return paper.title;
  const sentence = abstract.match(/[^.!?]+[.!?]?/)?.[0]?.trim();
  return (sentence || abstract).slice(0, 260);
};

const quoteForKeywords = (paper: LiteraturePaper, keywords: string[]) => {
  const haystack = paper.abstract.trim() || paper.title;
  const lower = haystack.toLowerCase();
  const hit = keywords.find((keyword) => lower.includes(keyword));
  if (!hit) return firstUsefulQuote(paper);
  const index = lower.indexOf(hit);
  const start = Math.max(0, index - 90);
  const end = Math.min(haystack.length, index + hit.length + 140);
  return haystack.slice(start, end).trim();
};

const makeReason = (
  criterion: ScreeningCriterion,
  paper: LiteraturePaper,
  note: string,
  keywords: string[],
): ScreeningReason => ({
  id: makeId("reason"),
  criteriaId: criterion.id,
  criteriaText: criterion.text,
  note,
  anchor: {
    kind: paper.abstract.trim() ? "abstract" : "metadata",
    quote: quoteForKeywords(paper, keywords),
  },
});

const screenPaperForTask = (
  paper: LiteraturePaper,
  task: LiteratureReviewTask,
): PaperScreening => {
  const text = paperSearchText(paper);
  const titleText = paper.title.toLowerCase();
  let score = 38;
  const reasons: ScreeningReason[] = [];
  const includeCriteria = task.criteria.filter((criterion) => criterion.kind === "include");

  for (const criterion of task.criteria) {
    const keywords = tokensFrom(criterion.text);
    const matches = keywords.filter((keyword) => text.includes(keyword));
    if (criterion.kind === "include") {
      score += matches.length * 11;
      score += matches.filter((keyword) => titleText.includes(keyword)).length * 5;
      if (matches.length > 0) {
        reasons.push(
          makeReason(
            criterion,
            paper,
            `Matched include criterion through ${matches.slice(0, 3).join(", ")}.`,
            matches,
          ),
        );
      }
    } else if (matches.length > 0) {
      score -= matches.length * 13;
      reasons.push(
        makeReason(
          criterion,
          paper,
          `Hit exclude criterion through ${matches.slice(0, 3).join(", ")}.`,
          matches,
        ),
      );
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const decision: ScreeningDecision =
    score >= 70 ? "include" : score <= 42 ? "exclude" : "maybe";
  const boundary = decision === "include" ? 70 : decision === "exclude" ? 42 : 56;
  const confidence =
    decision === "maybe"
      ? Math.max(20, Math.round(58 - Math.abs(score - boundary)))
      : Math.min(95, Math.round(45 + Math.abs(score - boundary) * 1.6));

  if (reasons.length === 0) {
    const fallback = includeCriteria[0] ?? task.criteria[0];
    reasons.push(
      makeReason(
        fallback ?? {
          id: makeId("crit"),
          kind: "include",
          text: task.question,
          createdAt: isoNow(),
        },
        paper,
        "No strong abstract evidence matched the current include criteria.",
        tokensFrom(task.question),
      ),
    );
  }

  return {
    taskId: task.id,
    decision,
    score,
    confidence,
    reasons: reasons.slice(0, 3),
    decidedAt: isoNow(),
  };
};

const screeningToVerdict = (screening: PaperScreening) => ({
  fit: scoreToFit(screening.score),
  score: screening.score,
  rationale: screening.reasons[0]?.note ?? "Screened against the active criteria.",
  decidedAt: screening.decidedAt,
});

const topTermsFromPapers = (papers: LiteraturePaper[]) => {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    for (const token of tokensFrom(`${paper.title} ${paper.abstract}`).slice(0, 30)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= Math.min(2, papers.length))
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 4);
};

const maybeSuggestCriteria = (
  library: LiteratureLibrary,
  task: LiteratureReviewTask,
): LiteratureReviewTask => {
  const flippedIncluded = library.papers.filter((paper) => {
    const screening = paper.screenings?.[task.id];
    return screening?.flippedFrom && screening.decision === "include";
  });
  if (flippedIncluded.length < 2) return task;
  const terms = topTermsFromPapers(flippedIncluded);
  if (terms.length === 0) return task;
  const text = `Include papers that discuss ${terms.join(", ")}`;
  const seen = [
    ...task.criteria.map((criterion) => criterion.text.toLowerCase()),
    ...task.suggestions.map((suggestion) => suggestion.text.toLowerCase()),
  ];
  if (seen.some((entry) => entry === text.toLowerCase())) return task;
  const suggestion: CriteriaSuggestion = {
    id: makeId("sugg"),
    text,
    basisPaperIds: flippedIncluded.map((paper) => paper.id),
    createdAt: isoNow(),
  };
  return {
    ...task,
    suggestions: [...task.suggestions, suggestion],
    updatedAt: isoNow(),
  };
};

// ── Legacy abstract Brief helper ─────────────────────────────────────────────
// Retained only for compatibility tests and old records. Production Brief
// generation below requires a complete, non-truncated PDF extraction.

const emptyFocus = (): ProjectFocus => ({
  question: "",
  motivation: "",
  scope: "",
  currentAssumptions: "",
});

const splitSentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const BRIEF_CUES = {
  problem: ["problem", "challeng", "difficult", "lack", "gap", "unclear", "bottleneck", "address", "tackle", "struggl"],
  method: ["propose", "present", "introduc", "method", "approach", "model", "framework", "algorithm", "architecture", "design", "develop", "leverage"],
  results: ["result", "achiev", "outperform", "improv", "accuracy", "state-of-the-art", "sota", "demonstrat", "show that", "reduc", "gain", "boost", "speedup", "faster"],
  limits: ["limitation", "future work", "however", "only", "does not", "do not", "fail", "remain", "open problem", "yet to", "not address"],
};

const abstractSection = (text: string): BriefSection => ({ text, source: "abstract" });

const pickSentence = (
  sentences: string[],
  cues: string[],
  options?: { preferNumbers?: boolean },
) => {
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    let score = cues.reduce((total, cue) => (lower.includes(cue) ? total + 1 : total), 0);
    if (options?.preferNumbers && /\d/.test(sentence)) score += 1;
    return { sentence, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)[0]?.sentence;
};

const forYouSection = (paper: LiteraturePaper, focus?: ProjectFocus): BriefSection => {
  const question = focus?.question.trim();
  if (!question) {
    return abstractSection(
      "Set a research focus (Edit focus above) to get a read tailored to your question.",
    );
  }
  const focusTerms = tokensFrom(`${question} ${focus?.scope ?? ""}`);
  const paperTerms = new Set(tokensFrom(`${paper.title} ${paper.abstract}`));
  const shared = focusTerms.filter((term) => paperTerms.has(term));
  if (shared.length === 0) {
    return abstractSection(
      `Tangential to your focus on “${question}” — no direct term overlap with the abstract. Surfaced for breadth.`,
    );
  }
  return abstractSection(
    `Overlaps your focus on ${shared.slice(0, 4).join(", ")}. Read against your question “${question}”.`,
  );
};

const briefFromPaper = (paper: LiteraturePaper, focus?: ProjectFocus): PaperBrief => {
  const sentences = splitSentences(paper.abstract);
  const fallback = () =>
    abstractSection(
      sentences.length === 0
        ? "暂无摘要，需查阅全文。"
        : "摘要中未明确说明，请查阅全文确认。",
    );
  const problem = pickSentence(sentences, BRIEF_CUES.problem) ?? sentences[0];
  const method = pickSentence(sentences, BRIEF_CUES.method);
  const results = pickSentence(sentences, BRIEF_CUES.results, { preferNumbers: true });
  const limits = pickSentence(sentences, BRIEF_CUES.limits);
  return {
    problem: problem ? abstractSection(problem) : fallback(),
    method: method ? abstractSection(method) : fallback(),
    results: results ? abstractSection(results) : fallback(),
    limits: limits ? abstractSection(limits) : fallback(),
    forYou: forYouSection(paper, focus),
    basis: "abstract",
    generatedAt: isoNow(),
  };
};

// ── Real LLM screening + Brief ──────────────────────────────────────────────
// One-shot calls on the user's configured executor (literature_llm). Any
// Screening may degrade to its keyword heuristic. Brief generation does not:
// incomplete extraction or model failure is surfaced to the user.

const clampScore = (value: unknown) =>
  Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const normalizeDecision = (value: unknown): ScreeningDecision => {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("include")) return "include";
  if (text.includes("exclude")) return "exclude";
  return "maybe";
};

/** Recover the complete top-level objects from a JSON array body that failed
 * to parse whole — typically because the model truncated mid-array or appended
 * stray prose. Scans for brace-balanced `{...}` spans (respecting strings and
 * escapes) and keeps the ones that parse, so a partial answer-chain still
 * yields its finished items instead of throwing the whole call away. */
const salvageJsonObjects = (body: string): unknown[] => {
  const objects: unknown[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) startIndex = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          try {
            objects.push(JSON.parse(body.slice(startIndex, i + 1)));
          } catch {
            // skip a malformed span and keep scanning for intact ones
          }
          startIndex = -1;
        }
      }
    }
  }
  return objects;
};

/** Pull a JSON value out of an LLM response that may wrap it in prose or a
 * ```json fence. Falls back to a bracket scan, then to object-level salvage
 * for truncated arrays before giving up. */
const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // fall through to bracket scan
  }
  const start = body.search(/[[{]/);
  if (start >= 0) {
    const close = body[start] === "[" ? "]" : "}";
    const end = body.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // fall through to salvage
      }
    }
    // Truncated or prose-littered array: recover the intact objects.
    if (body[start] === "[") {
      const salvaged = salvageJsonObjects(body.slice(start));
      if (salvaged.length > 0) return salvaged;
    }
  }
  throw new Error("model did not return JSON");
};

/** Run a literature LLM call and parse its JSON. If the first reply can't be
 * parsed (prose preamble, thinking leak, truncation), retry exactly once with
 * an explicit "raw JSON only" instruction before surfacing the error. The
 * retry only costs a call when the request would have failed anyway. */
const literatureLlmJson = async (system: string, prompt: string): Promise<unknown> => {
  const text = await literatureLlm(system, prompt);
  try {
    return extractJson(text);
  } catch {
    const repaired = await literatureLlm(
      system,
      `${prompt}

Your previous reply could not be parsed. Return ONLY the raw JSON value — no prose, no explanation, no markdown fences, no thinking. Your reply must start with "[" or "{" and contain nothing else.`,
    );
    return extractJson(repaired);
  }
};

const literatureReviewLlmJson = async (system: string, prompt: string): Promise<unknown> => {
  const text = await literatureReviewLlm(system, prompt);
  try {
    return extractJson(text);
  } catch {
    const repaired = await literatureReviewLlm(
      system,
      `${prompt}

Your previous reply could not be parsed. Return ONLY the raw JSON value. Do not include prose, markdown fences, or reasoning.`,
    );
    return extractJson(repaired);
  }
};

const SCREEN_SYSTEM =
  "You are a careful literature screening assistant. For each paper decide whether it belongs in a researcher's review given their question and criteria, and quote the abstract as evidence. Respond with a single JSON array and nothing else.";

const buildScreenPrompt = (papers: LiteraturePaper[], task: LiteratureReviewTask) => {
  const include = task.criteria.filter((c) => c.kind === "include").map((c) => c.text);
  const exclude = task.criteria.filter((c) => c.kind === "exclude").map((c) => c.text);
  const list = papers
    .map(
      (paper, index) =>
        `#${index}\nTitle: ${paper.title}\nAbstract: ${paper.abstract || "(no abstract provided)"}`,
    )
    .join("\n\n");
  return `Research question: ${task.question}
Include criteria: ${include.join(" | ") || "(none)"}
Exclude criteria: ${exclude.join(" | ") || "(none)"}

Papers:
${list}

Return a JSON array. One object per paper:
{"index": <number>, "decision": "include" | "exclude" | "maybe", "score": <0-100 topical fit>, "confidence": <0-100>, "rationale": "<one sentence naming the criterion it meets or violates>", "quote": "<verbatim snippet copied from THIS paper's abstract, <=200 chars>"}`;
};

const llmScreen = async (papers: LiteraturePaper[], task: LiteratureReviewTask) => {
  const parsed = await literatureReviewLlmJson(SCREEN_SYSTEM, buildScreenPrompt(papers, task));
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of screenings");
  const result = new Map<string, PaperScreening>();
  for (const row of parsed as Array<Record<string, unknown>>) {
    const paper = papers[Number(row.index)];
    if (!paper) continue;
    const quote = String(row.quote ?? "").trim() || firstUsefulQuote(paper);
    result.set(paper.id, {
      taskId: task.id,
      decision: normalizeDecision(row.decision),
      score: clampScore(row.score ?? 50),
      confidence: clampScore(row.confidence ?? 60),
      reasons: [
        {
          id: makeId("reason"),
          criteriaText: "Review LLM judgment",
          note: String(row.rationale ?? "").trim() || "Screened against the active criteria.",
          anchor: { kind: paper.abstract.trim() ? "abstract" : "metadata", quote },
        },
      ],
      decidedAt: isoNow(),
    });
  }
  if (result.size === 0) throw new Error("no usable screening rows");
  return result;
};

const BRIEF_SYSTEM =
  "You are a precise research reading assistant. Produce a structured brief based only on the complete extracted full text supplied by the user. Every claim must cite the page that supports it. Be concrete and include numbers from the paper in Results. Write all section values in Chinese. Respond with a single JSON object and nothing else.";

const normalizeAnchorText = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();

const readablePageMap = (extraction: PdfExtraction) =>
  new Map(
    extraction.pages
      .filter((page) => page.text.trim().length > 0)
      .map((page) => [page.page, normalizeAnchorText(page.text)]),
  );

const buildBriefPrompt = (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  fullText: string,
) => {
  const focusLine = focus?.question?.trim()
    ? `Researcher focus: ${focus.question}${focus.scope ? ` (scope: ${focus.scope})` : ""}`
    : "Researcher focus: (not provided)";
  return `${focusLine}

Title: ${paper.title}
Complete extracted full text:
${fullText}

Return a JSON object: {"problem": {"text": "...", "page": 1, "quote": "verbatim supporting sentence"}, "method": {"text": "...", "page": 2, "quote": "verbatim supporting sentence"}, "results": {"text": "...", "page": 3, "quote": "verbatim supporting sentence"}, "limits": {"text": "...", "page": 4, "quote": "verbatim supporting sentence"}, "forYou": {"text": "...", "page": 5, "quote": "verbatim supporting sentence"}}.
Each field is at most two sentences and MUST cite one valid page number and one verbatim supporting sentence copied from that same [[PAGE N]] page. "results" MUST include concrete numbers if the paper reports any. "limits" states the paper's own limitations or "Not stated". "forYou" relates the paper to the researcher focus, or says it is tangential.
All values must be written in Chinese.`;
};

const llmBrief = async (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  extraction: PdfExtraction,
): Promise<PaperBrief> => {
  const parsed = await literatureLlmJson(
    BRIEF_SYSTEM,
    buildBriefPrompt(paper, focus, extraction.text),
  ) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") throw new Error("expected a JSON object");
  const source: AnchorKind = "pdf";
  const pageText = readablePageMap(extraction);
  // The four factual sections (problem/method/results/limits) describe the
  // paper itself, so the iron rule applies: page + verbatim quote, no
  // exceptions. `forYou` is different — it relates the paper to the
  // researcher's *project focus*, a synthesis judgment that often has no
  // verbatim sentence in the paper. For it we keep the anchor best-effort:
  // attach page+quote when they genuinely verify, otherwise pass the text
  // through unanchored instead of failing the whole brief.
  const section = (
    field: string,
    value: unknown,
    relational = false,
  ): BriefSection => {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const sectionText = String(record?.text ?? "").trim();
    const rawPage = Number(record?.page);
    const quote = String(record?.quote ?? "").trim();
    const normalizedQuote = normalizeAnchorText(quote);
    if (!sectionText) throw new Error(`brief section "${field}" is missing text`);
    const pageValid = Number.isInteger(rawPage) && pageText.has(rawPage);
    const quoteValid =
      pageValid
      && normalizedQuote.length >= 8
      && !!pageText.get(rawPage)?.includes(normalizedQuote);
    if (relational) {
      // Keep the anchor only when it fully verifies; never reject.
      return quoteValid
        ? { text: sectionText, source, page: rawPage, quote }
        : { text: sectionText, source: "metadata" };
    }
    if (!pageValid) {
      throw new Error(`brief section "${field}" has no valid PDF page anchor`);
    }
    if (!quoteValid) {
      throw new Error(`brief section "${field}" has no verifiable PDF quote`);
    }
    return {
      text: sectionText,
      source,
      page: rawPage,
      quote,
    };
  };
  return {
    problem: section("problem", parsed.problem),
    method: section("method", parsed.method),
    results: section("results", parsed.results),
    limits: section("limits", parsed.limits),
    forYou: section("forYou", parsed.forYou, true),
    basis: "fulltext",
    generatedAt: isoNow(),
  };
};

const VISUAL_EVIDENCE_SYSTEM =
  "You are a rigorous visual paper reader. Read every supplied PDF page image directly, including figures, tables, formulas, captions, and body text. Extract only evidence visibly supported by those images. Write every evidence explanation in Chinese while preserving quotes as faithful visible transcriptions in their source language. Return a JSON array and nothing else.";

const ANSWER_CHAIN_SYSTEM =
  "You build question-to-final-answer chains only from visual evidence previously read directly from PDF page images. Write every question and final answer in Chinese. Return a JSON array and nothing else.";

const EVIDENCE_ROLE_LABELS: Record<string, string> = {
  premise: "前提",
  method: "方法",
  result: "结果",
  limitation: "局限",
  support: "支撑",
  evidence: "证据",
};

const evidenceRoleLabel = (role: string) => EVIDENCE_ROLE_LABELS[role] ?? role;

const literatureVisionLlmJson = async (
  system: string,
  prompt: string,
  images: PdfPageImage[],
): Promise<unknown> => {
  const text = await literatureLlmVision(system, prompt, images);
  try {
    return extractJson(text);
  } catch {
    const repaired = await literatureLlmVision(
      system,
      `${prompt}

Your previous reply could not be parsed. Return ONLY the raw JSON array with no prose, markdown fences, or thinking.`,
      images,
    );
    return extractJson(repaired);
  }
};

type VisualEvidence = LiteraturePaper["evidence"][number] & { source: "vision"; imageFingerprint: string };

const imageBatches = (pages: PdfPageImage[], size = 4) => {
  const batches: PdfPageImage[][] = [];
  for (let offset = 0; offset < pages.length; offset += size) {
    batches.push(pages.slice(offset, offset + size));
  }
  return batches;
};

const spreadLimit = <T,>(values: T[], limit: number) => {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) =>
    values[Math.floor(index * values.length / limit)],
  );
};

const llmVisualEvidence = async (
  paper: LiteraturePaper,
  question: string,
  pages: PdfPageImage[],
): Promise<VisualEvidence[]> => {
  const evidence: VisualEvidence[] = [];
  for (const batch of imageBatches(pages)) {
    const allowed = new Map(batch.map((page) => [page.page, page]));
    const parsed = await literatureVisionLlmJson(
      VISUAL_EVIDENCE_SYSTEM,
      `Paper: ${paper.title}
Research question: ${question || "(identify the paper's most important claims and findings)"}
Pages in this batch: ${batch.map((page) => page.page).join(", ")}

Read every attached page image. Return up to 6 high-value evidence items from this batch:
[{"page": 1, "quote": "short faithful transcription or exact visible figure/table value", "note": "why this visually observed evidence matters", "role": "premise|method|result|limitation"}]
The page must be one of the supplied page images. Do not infer content that is not visible.
Write every note in Chinese. Preserve each quote as a faithful transcription in the source language visible on the page. Transcribe mathematical expressions as LaTeX wrapped in $...$ or $$...$$ instead of flattening them into plain Unicode text. Keep role as one of premise|method|result|limitation.`,
      batch,
    );
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of visual evidence");
    for (const item of parsed as Array<Record<string, unknown>>) {
      const page = Number(item.page);
      const quote = String(item.quote ?? "").trim();
      const note = String(item.note ?? "").trim();
      const role = String(item.role ?? "evidence").trim() || "evidence";
      const pageImage = allowed.get(page);
      if (!Number.isInteger(page) || !pageImage || quote.length < 8 || !note) continue;
      evidence.push({
        id: makeId("evidence"),
        page,
        quote: quote.slice(0, 360),
        note: `${evidenceRoleLabel(role)}：${note}`,
        source: "vision",
        imageFingerprint: pageImage.fingerprint,
      });
    }
  }
  const deduped = evidence.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.page === item.page
          && normalizeAnchorText(candidate.quote) === normalizeAnchorText(item.quote),
      ) === index,
  );
  if (deduped.length === 0) throw new Error("model returned no visual evidence");
  return spreadLimit(deduped, 24);
};

const llmAnswerChainsFromVisualEvidence = async (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  evidence: VisualEvidence[],
): Promise<{ chains: ReadingAnswerChain[]; annotations: PdfAnnotation[] }> => {
  const evidencePayload = evidence.map((item) => ({
    id: item.id,
    page: item.page,
    quote: item.quote,
    note: item.note,
    imageFingerprint: item.imageFingerprint,
  }));
  const parsed = await literatureLlmJson(
    ANSWER_CHAIN_SYSTEM,
    `Paper: ${paper.title}
Research focus: ${focus?.question?.trim() || "(generate the most important paper-reading questions)"}

Visual evidence read from all PDF page-image batches:
${JSON.stringify(evidencePayload)}

Generate 3-4 critical questions and final answers. Use only the supplied visual evidence.
Return ONLY:
[{"question": "...", "answer": "...", "supports": [{"evidenceId": "evidence-id", "role": "premise|method|result|limitation"}]}]
Each answer requires at least one support and may use at most 3 supports.
All question and answer values must be written in Chinese. Keep support role as one of premise|method|result|limitation.`,
  );
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of answer chains");
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const chains: ReadingAnswerChain[] = [];
  const annotations: PdfAnnotation[] = [];

  for (const row of parsed as Array<Record<string, unknown>>) {
    const question = String(row.question ?? "").trim();
    const answer = String(row.answer ?? "").trim();
    if (!question || !answer || !Array.isArray(row.supports)) continue;
    const chainId = makeId("chain");
    const supports = row.supports
      .map((support) => support as Record<string, unknown>)
      .map((support) => {
        const evidenceId = String(support.evidenceId ?? "").trim();
        const role = String(support.role ?? "support").trim() || "support";
        const visual = evidenceById.get(evidenceId);
        if (!visual) return null;
        const annotation: PdfAnnotation = {
          id: makeId("annotation"),
          page: visual.page,
          quote: visual.quote,
          note: `${evidenceRoleLabel(role)}：${answer}`,
          kind: "answer-support",
          source: "vision",
          imageFingerprint: visual.imageFingerprint,
          sourceId: chainId,
          evidenceId: visual.id,
          createdAt: isoNow(),
        };
        annotations.push(annotation);
        return { annotationId: annotation.id, role };
      })
      .filter((support): support is NonNullable<typeof support> => support !== null);
    if (supports.length === 0) continue;
    chains.push({
      id: chainId,
      question,
      answer,
      supports,
      basis: "vision",
      reviewStatus: "unreviewed",
      createdAt: isoNow(),
    });
  }
  if (chains.length === 0) throw new Error("model returned no verifiable answer chains");
  return { chains, annotations };
};

const briefAnnotations = (brief: PaperBrief): PdfAnnotation[] =>
  (["problem", "method", "results", "limits", "forYou"] as const)
    .map((field) => {
      const section = brief[field];
      if (!section.page || !section.quote) return null;
      return {
        id: makeId("annotation"),
        page: section.page,
        quote: section.quote,
        note: `${field}: ${section.text}`,
        kind: "core" as const,
        sourceId: `brief:${field}`,
        createdAt: isoNow(),
      };
    })
    .filter((annotation): annotation is NonNullable<typeof annotation> => annotation !== null);

const evidenceAnnotations = (evidence: LiteraturePaper["evidence"]): PdfAnnotation[] =>
  evidence.map((item) => ({
    id: makeId("annotation"),
    page: item.page,
    quote: item.quote,
    note: item.note,
    kind: "evidence",
    source: item.source,
    imageFingerprint: item.imageFingerprint,
    sourceId: item.id,
    createdAt: isoNow(),
  }));

const PREVIEW_LIBRARY: LiteratureLibrary = {
  version: 1,
  papers: [
    {
      id: "arxiv:2602.01491",
      title: "Agentic Literature Review: Planning, Retrieval, and Grounded Synthesis",
      authors: ["M. Rivera", "L. Chen", "A. Novak"],
      year: 2026,
      venue: "arXiv",
      doi: "10.48550/arxiv.2602.01491",
      arxivId: "2602.01491",
      url: "https://arxiv.org/abs/2602.01491",
      abstract:
        "Literature review is bottlenecked by entangled screening and reading. We propose a four-stage agentic pipeline that decomposes the work into retrieval, metadata screening, full-text reading, and evidence-grounded writing. On a 2,100-paper benchmark the system reaches 0.94 screening recall at 8x less reading time. A limitation is that evaluation covers CS corpora only.",
      tags: ["agent", "review"],
      collectionIds: [],
      searchIds: ["search-preview"],
      stage: "downloaded",
      starred: true,
      unread: false,
      source: "arXiv",
      addedAt: "2026-06-09T08:00:00.000Z",
      pdf: {
        status: "downloaded",
        url: "https://arxiv.org/pdf/2602.01491.pdf",
        path: "papers/2602.01491.pdf",
      },
      verdict: {
        fit: "high",
        score: 92,
        rationale:
          "Separates metadata triage from full-text reading and keeps every summary anchored to cited evidence spans.",
        decidedAt: "2026-06-09T08:10:00.000Z",
      },
      evidence: [
        {
          id: "ev-1",
          page: 3,
          quote: "Screening decisions are recorded before full-text extraction.",
          note: "方法：该证据说明系统先记录筛选决策，再进入全文提取；状态变换满足 X̂_T(t)=M_T Z_T(t)。",
        },
      ],
      answerChains: [
        {
          id: "chain-preview",
          question: "论文如何保证文献综合过程有证据支撑？",
          answer: "论文将筛选与全文阅读分离，并在综合前记录可核验的证据。",
          supports: [{ annotationId: "annotation-answer-preview", role: "method" }],
          reviewStatus: "unreviewed",
          createdAt: "2026-06-09T08:15:00.000Z",
        },
      ],
      pdfAnnotations: [
        {
          id: "annotation-evidence-preview",
          page: 3,
          quote: "Screening decisions are recorded before full-text extraction.",
          note: "方法：该证据说明系统先记录筛选决策，再进入全文提取；状态变换满足 X̂_T(t)=M_T Z_T(t)。",
          kind: "evidence",
          sourceId: "ev-1",
          createdAt: "2026-06-09T08:15:00.000Z",
        },
        {
          id: "annotation-answer-preview",
          page: 3,
          quote: "Screening decisions are recorded before full-text extraction.",
          note: "方法：论文在全文提取前记录筛选决策。",
          kind: "answer-support",
          sourceId: "chain-preview",
          evidenceId: "ev-1",
          createdAt: "2026-06-09T08:15:00.000Z",
        },
      ],
    },
    {
      id: "doi:10.1145/example.1024",
      title: "Grounded PDF Summarization with Human-in-the-loop Annotation",
      authors: ["S. Iyer", "P. Almeida"],
      year: 2025,
      venue: "CHI Late Breaking Work",
      doi: "10.1145/example.1024",
      url: "https://doi.org/10.1145/example.1024",
      abstract:
        "An interface study on combining automatic PDF summarization with reader annotations and editable evidence snippets.",
      tags: ["pdf", "ux"],
      collectionIds: [],
      searchIds: ["search-preview"],
      stage: "screened",
      starred: false,
      unread: true,
      source: "Crossref",
      citedBy: 12,
      addedAt: "2026-06-08T15:00:00.000Z",
      pdf: { status: "none" },
      verdict: {
        fit: "medium",
        score: 74,
        rationale: "Strong on annotation UX, but does not cover autonomous screening.",
        decidedAt: "2026-06-08T15:20:00.000Z",
      },
      evidence: [],
      answerChains: [],
      pdfAnnotations: [],
    },
    {
      id: "arxiv:2409.01010",
      title: "General Web Agents for Form Filling",
      authors: ["D. Lewis", "H. Kim"],
      year: 2024,
      venue: "arXiv",
      arxivId: "2409.01010",
      url: "https://arxiv.org/abs/2409.01010",
      abstract: "A broad web automation benchmark focused on browser control and form completion.",
      tags: ["web"],
      collectionIds: [],
      searchIds: ["search-preview"],
      stage: "inbox",
      starred: false,
      unread: true,
      source: "arXiv",
      addedAt: "2026-06-07T11:00:00.000Z",
      pdf: { status: "none", url: "https://arxiv.org/pdf/2409.01010.pdf" },
      evidence: [],
      answerChains: [],
      pdfAnnotations: [],
    },
  ],
  searches: [
    {
      id: "search-preview",
      query: "agentic literature review",
      sources: ["arxiv", "crossref"],
      ranAt: "2026-06-09T08:00:00.000Z",
      resultCount: 18,
      newCount: 3,
    },
  ],
  collections: [{ id: "col-core", label: "Core review" }],
  projectFocus: {
    question: "How should an agent screen and read literature for a researcher?",
    motivation: "Building a literature workspace where the agent drafts and the human verifies.",
    scope: "agent screening, grounded reading, evidence anchoring",
    currentAssumptions: "Metadata-first triage beats read-everything.",
  },
  reviewTasks: [
    {
      id: "task-preview",
      question: "agentic literature review",
      criteria: [
        {
          id: "crit-preview-include",
          kind: "include",
          text: "Must directly discuss agentic literature review",
          createdAt: "2026-06-09T08:00:00.000Z",
        },
        {
          id: "crit-preview-exclude",
          kind: "exclude",
          text: "Exclude papers with no clear connection to the question",
          createdAt: "2026-06-09T08:00:00.000Z",
        },
      ],
      searchIds: ["search-preview"],
      createdAt: "2026-06-09T08:00:00.000Z",
      updatedAt: "2026-06-09T08:00:00.000Z",
      suggestions: [],
    },
  ],
};

interface LiteratureState {
  library: LiteratureLibrary;
  loaded: boolean;
  loadedProjectId: string | null;
  error: string | null;
  /** True while the agent is screening abstracts for the active task. */
  screening: boolean;
  searching: boolean;
  generatingAnswerChains: string | null;
  /** Paper id currently being briefed by the agent, if any. */
  briefing: string | null;
  /** Terminal-style log narrating every library write and agent action. */
  activity: ActivityEntry[];
  activityOpen: boolean;
  activeReviewTaskId: string | null;

  setActivityOpen: (open: boolean) => void;
  logActivity: (level: ActivityLevel, text: string) => void;
  clearActivity: () => void;
  setActiveReviewTask: (id: string | null) => void;
  runRemoteSearch: (query: string, sources: string[], maxResults?: number) => Promise<void>;
  load: (projectId: string, options?: { quiet?: boolean }) => Promise<void>;
  /** Reload the library when a chat turn ends — literature skills may have
   * upserted papers through the kernel tools. Returns a teardown fn. */
  watchAgentActivity: () => () => void;
  createReviewTask: (question: string, searchIds?: string[]) => Promise<string>;
  updateReviewQuestion: (taskId: string, question: string) => void;
  updateCriterion: (taskId: string, criterionId: string, text: string) => void;
  addCriterion: (taskId: string, kind: CriterionKind) => void;
  removeCriterion: (taskId: string, criterionId: string) => void;
  screenPapersForTask: (taskId: string, paperIds?: string[]) => void;
  confirmScreening: (paperId: string, taskId: string) => void;
  flipScreening: (paperId: string, taskId: string) => void;
  /** Set an explicit decision (include/exclude/maybe) and confirm it. */
  decideScreening: (paperId: string, taskId: string, decision: ScreeningDecision) => void;
  acceptCriteriaSuggestion: (taskId: string, suggestionId: string) => void;
  dismissCriteriaSuggestion: (taskId: string, suggestionId: string) => void;
  setStage: (ids: string[], stage: PaperStage) => void;
  deletePapers: (ids: string[]) => void;
  toggleStar: (id: string) => void;
  markRead: (id: string) => void;
  addTags: (ids: string[], tags: string[]) => void;
  addCollection: (label: string) => void;
  removeCollection: (id: string) => void;
  assignCollection: (ids: string[], collectionId: string) => void;
  toggleCollection: (paperId: string, collectionId: string) => void;
  setProjectFocus: (patch: Partial<ProjectFocus>) => void;
  generateBrief: (paperId: string) => Promise<void>;
  generateAnswerChains: (paperId: string) => Promise<void>;
  deleteEvidence: (paperId: string, evidenceId: string) => void;
  updateAnswerChain: (
    paperId: string,
    chainId: string,
    patch: Partial<Pick<ReadingAnswerChain, "question" | "answer" | "reviewStatus">>,
  ) => void;
  addPdfAnnotation: (paperId: string, annotation: Omit<PdfAnnotation, "id" | "createdAt">) => void;
  updatePdfAnnotation: (
    paperId: string,
    annotationId: string,
    patch: Partial<Pick<PdfAnnotation, "quote" | "note" | "kind" | "color">>,
  ) => void;
  deletePdfAnnotation: (paperId: string, annotationId: string) => void;
  downloadPdf: (id: string) => Promise<void>;
  uploadPdf: (id: string, sourcePath: string) => Promise<void>;
  openPdf: (id: string) => Promise<void>;
  setError: (message: string | null) => void;
}

export const useLiteratureStore = create<LiteratureState>((set, get) => {
  const log = (level: ActivityLevel, text: string, options?: { open?: boolean }) => {
    const entry: ActivityEntry = {
      id: makeId("act"),
      at: isoNow(),
      level,
      text,
    };
    set((state) => ({
      activity: [...state.activity, entry].slice(-MAX_ACTIVITY_ENTRIES),
      activityOpen: options?.open ? true : state.activityOpen,
    }));
  };

  const persist = () => {
    if (!isTauri()) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      literatureSave(get().library).catch((error) =>
        set({ error: `failed to save library: ${String(error)}` }),
      );
    }, PERSIST_DELAY_MS);
  };

  const mutate = (update: (library: LiteratureLibrary) => LiteratureLibrary) => {
    set({ library: update(get().library) });
    persist();
  };

  const patchPapers = (ids: string[], patch: (paper: LiteraturePaper) => LiteraturePaper) =>
    mutate((library) => ({
      ...library,
      papers: library.papers.map((paper) =>
        ids.includes(paper.id) ? patch(paper) : paper,
      ),
    }));

  return {
    library: emptyLibrary(),
    loaded: false,
    loadedProjectId: null,
    error: null,
    screening: false,
    searching: false,
    generatingAnswerChains: null,
    briefing: null,
    activity: [],
    activityOpen: false,
    activeReviewTaskId: null,

    setActivityOpen: (open) => set({ activityOpen: open }),
    logActivity: (level, text) => log(level, text, { open: true }),
    clearActivity: () => set({ activity: [] }),

    setActiveReviewTask: (id) => set({ activeReviewTaskId: id }),

    runRemoteSearch: async (query, sources, maxResults = 20) => {
      const trimmed = query.trim();
      if (!trimmed) {
        set({ error: "请输入检索问题或关键词。" });
        return;
      }
      if (!isTauri()) {
        set({ error: "远程文献检索需要桌面后端。" });
        return;
      }
      set({ searching: true, error: null });
      log("info", `正在检索：${trimmed}`, { open: true });
      try {
        const result = await literatureSearch<LiteratureSearchResult>(
          trimmed,
          sources,
          maxResults,
        );
        const stats = await literatureLibraryUpsert<LiteratureUpsertResult>(
          result.papers,
          trimmed,
          sources,
        );
        await get().load(get().loadedProjectId ?? "default", { quiet: true });
        log(
          "ok",
          `检索完成：${result.papers.length} 条结果，新增 ${stats.added}，合并 ${stats.merged}`,
        );
        for (const warning of result.warnings) log("warn", warning);
      } catch (error) {
        const message = `远程检索失败：${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
      } finally {
        set({ searching: false });
      }
    },

    load: async (projectId, options) => {
      // Drop any pending save: the backend already points at the new project,
      // so flushing now would write the old project's library into it.
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (!isTauri()) {
        set({
          library: PREVIEW_LIBRARY,
          loaded: true,
          loadedProjectId: projectId,
          activeReviewTaskId: PREVIEW_LIBRARY.reviewTasks[0]?.id ?? null,
        });
        return;
      }
      try {
        const raw = normalizeLibrary(await literatureLoad<Partial<LiteratureLibrary>>());
        const reviewTasks = raw.reviewTasks;
        const currentTaskId = get().activeReviewTaskId;
        set({
          library: raw,
          loaded: true,
          loadedProjectId: projectId,
          activeReviewTaskId:
            reviewTasks.some((task) => task.id === currentTaskId)
              ? currentTaskId
              : reviewTasks[0]?.id ?? null,
        });
        if (!options?.quiet) {
          log("info", `Loaded ${raw.papers?.length ?? 0} papers from papers/library.json`);
        }
      } catch (error) {
        set({ error: `failed to load library: ${String(error)}` });
        log("error", `✗ Failed to load library: ${String(error)}`, { open: true });
      }
    },

    watchAgentActivity: () => {
      if (!isTauri()) return () => {};
      let disposed = false;
      const teardowns: Array<() => void> = [];
      // Set when a Literature* tool ran during the current chat turn, so the
      // chat-done reload can say why the library changed.
      let agentTouchedLibrary = false;

      const register = (subscription: Promise<() => void>) => {
        void subscription.then((teardown) => {
          if (disposed) teardown();
          else teardowns.push(teardown);
        });
      };

      register(
        onChatTool((tool) => {
          if (disposed || !tool.name.startsWith("Literature")) return;
          agentTouchedLibrary = true;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tool.input) as Record<string, unknown>;
          } catch {
            // tool input is informational only
          }
          if (tool.name === "LiteratureSearch") {
            log("info", `→ Agent (Chat): searching "${String(input.query ?? "…")}"`, {
              open: true,
            });
          } else if (tool.name === "LiteratureLibraryUpsert") {
            const count = Array.isArray(input.papers) ? input.papers.length : "?";
            log("info", `→ Agent (Chat): saving ${count} records to the library…`, {
              open: true,
            });
          } else if (tool.name === "LiteraturePdfDownload") {
            log("info", `→ Agent (Chat): downloading PDF ${String(input.fileName ?? "")}`, {
              open: true,
            });
          }
        }),
      );

      register(
        onChatToolResult((result) => {
          if (disposed || !result.name.startsWith("Literature")) return;
          if (result.isError) {
            log("warn", `! Agent ${result.name} failed: ${result.output.slice(0, 160)}`);
            return;
          }
          let output: Record<string, unknown> = {};
          try {
            output = JSON.parse(result.output) as Record<string, unknown>;
          } catch {
            return;
          }
          if (result.name === "LiteratureLibraryUpsert") {
            log(
              "ok",
              `✓ Agent saved ${Number(output.added ?? 0)} new / ${Number(output.merged ?? 0)} merged → papers/library.json`,
            );
          } else if (result.name === "LiteraturePdfDownload") {
            log("ok", `✓ Agent downloaded ${String(output.relativePath ?? "PDF")}`);
          }
        }),
      );

      register(
        onChatDone(() => {
          if (disposed) return;
          const touched = agentTouchedLibrary;
          agentTouchedLibrary = false;
          // A pending UI save means fresh local edits; let them win this round.
          if (persistTimer) return;
          const projectId = get().loadedProjectId;
          if (!projectId) return;
          const before = get().library.papers.length;
          set({ loaded: false });
          void get()
            .load(projectId, { quiet: true })
            .then(() => {
              if (!touched) return;
              const state = get();
              const activeTask = state.library.reviewTasks.find(
                (task) => task.id === state.activeReviewTaskId,
              );
              const matchingSearch =
                activeTask && activeTask.searchIds.length === 0
                  ? state.library.searches.find(
                      (search) =>
                        search.query.trim().toLowerCase() ===
                        activeTask.question.trim().toLowerCase(),
                    )
                  : undefined;
              if (activeTask && matchingSearch) {
                mutate((library) => ({
                  ...library,
                  reviewTasks: library.reviewTasks.map((task) =>
                    task.id === activeTask.id
                      ? { ...task, searchIds: [matchingSearch.id], updatedAt: isoNow() }
                      : task,
                  ),
                }));
                log("info", `Linked review task to saved search: "${matchingSearch.query}"`);
              }
              const delta = get().library.papers.length - before;
              log(
                delta > 0 ? "ok" : "info",
                delta > 0
                  ? `✓ Library reloaded after chat turn: +${delta} ${delta === 1 ? "paper" : "papers"}`
                  : "Library reloaded after chat turn (no new papers)",
              );
            });
        }),
      );

      return () => {
        disposed = true;
        for (const teardown of teardowns) teardown();
      };
    },

    createReviewTask: async (question, searchIds = []) => {
      const reviewTask = reviewTaskFromQuery(question, searchIds);
      mutate((library) => ({
        ...library,
        reviewTasks: [reviewTask, ...library.reviewTasks],
      }));
      set({ activeReviewTaskId: reviewTask.id });
      log("info", `Review task created: "${reviewTask.question}"`);
      if (isTauri()) {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        try {
          await literatureSave(get().library);
        } catch (error) {
          set({ error: `failed to save review task: ${String(error)}` });
          log("error", `Failed to save review task: ${String(error)}`, { open: true });
        }
      }
      return reviewTask.id;
    },

    updateReviewQuestion: (taskId, question) => {
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) =>
          task.id === taskId ? { ...task, question, updatedAt: isoNow() } : task,
        ),
      }));
    },

    updateCriterion: (taskId, criterionId, text) => {
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                criteria: task.criteria.map((criterion) =>
                  criterion.id === criterionId ? { ...criterion, text } : criterion,
                ),
                updatedAt: isoNow(),
              }
            : task,
        ),
      }));
    },

    addCriterion: (taskId, kind) => {
      const criterion: ScreeningCriterion = {
        id: makeId("crit"),
        kind,
        text: kind === "include" ? "Include papers that..." : "Exclude papers that...",
        createdAt: isoNow(),
      };
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                criteria: [...task.criteria, criterion],
                updatedAt: isoNow(),
              }
            : task,
        ),
      }));
    },

    removeCriterion: (taskId, criterionId) => {
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                criteria: task.criteria.filter((criterion) => criterion.id !== criterionId),
                updatedAt: isoNow(),
              }
            : task,
        ),
      }));
    },

    screenPapersForTask: async (taskId, paperIds) => {
      const task = get().library.reviewTasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const belongs = (paper: LiteraturePaper) =>
        paperIds !== undefined
          ? paperIds.includes(paper.id)
          : task.searchIds.length === 0 ||
            task.searchIds.some((searchId) => paper.searchIds.includes(searchId));
      const candidates = get().library.papers.filter(
        (paper) => belongs(paper) && !paper.screenings?.[taskId]?.userConfirmed,
      );
      if (candidates.length === 0) return;

      set({ screening: true });
      let llmResults: Map<string, PaperScreening> | null = null;
      if (isTauri()) {
        log("info", `Review LLM is screening ${candidates.length} abstracts with ARIS research-review standards`, { open: true });
        try {
          llmResults = await llmScreen(candidates, task);
        } catch (error) {
          log("warn", `Review LLM unavailable (${String(error)}); using keyword heuristic`);
        }
      }
      try {
        mutate((library) => ({
          ...library,
          papers: library.papers.map((paper) => {
            if (!belongs(paper) || paper.screenings?.[taskId]?.userConfirmed) return paper;
            const screening = llmResults?.get(paper.id) ?? screenPaperForTask(paper, task);
            return {
              ...paper,
              stage: paper.stage === "inbox" ? "screened" : paper.stage,
              verdict: screeningToVerdict(screening),
              screenings: {
                ...(paper.screenings ?? {}),
                [taskId]: screening,
              },
            };
          }),
        }));
        log(
          "ok",
          `Screened ${candidates.length} abstracts against "${task.question}" (${llmResults ? "Review LLM" : "heuristic"})`,
        );
      } finally {
        set({ screening: false });
      }
    },

    confirmScreening: (paperId, taskId) => {
      patchPapers([paperId], (paper) => {
        const screening = paper.screenings?.[taskId];
        if (!screening) return paper;
        const confirmed = {
          ...screening,
          userConfirmed: true,
          decidedAt: isoNow(),
        };
        return {
          ...paper,
          stage: stageForDecision(confirmed.decision),
          verdict: screeningToVerdict(confirmed),
          screenings: {
            ...(paper.screenings ?? {}),
            [taskId]: confirmed,
          },
        };
      });
    },

    flipScreening: (paperId, taskId) => {
      mutate((library) => {
        const task = library.reviewTasks.find((entry) => entry.id === taskId);
        if (!task) return library;
        const papers = library.papers.map((paper) => {
          if (paper.id !== paperId) return paper;
          const current = paper.screenings?.[taskId] ?? screenPaperForTask(paper, task);
          const decision: ScreeningDecision =
            current.decision === "include" ? "exclude" : "include";
          const flipped: PaperScreening = {
            ...current,
            decision,
            userConfirmed: true,
            flippedFrom: current.decision,
            decidedAt: isoNow(),
            reasons: [
              {
                id: makeId("reason"),
                criteriaText: "Human review",
                note: `Reviewer flipped the agent proposal from ${current.decision} to ${decision}.`,
                anchor: current.reasons[0]?.anchor ?? {
                  kind: paper.abstract.trim() ? "abstract" : "metadata",
                  quote: firstUsefulQuote(paper),
                },
              },
              ...current.reasons,
            ].slice(0, 4),
          };
          return {
            ...paper,
            stage: stageForDecision(decision),
            verdict: screeningToVerdict(flipped),
            screenings: {
              ...(paper.screenings ?? {}),
              [taskId]: flipped,
            },
          };
        });
        const nextLibrary = { ...library, papers };
        return {
          ...nextLibrary,
          reviewTasks: nextLibrary.reviewTasks.map((entry) =>
            entry.id === taskId ? maybeSuggestCriteria(nextLibrary, entry) : entry,
          ),
        };
      });
    },

    decideScreening: (paperId, taskId, decision) => {
      mutate((library) => {
        const task = library.reviewTasks.find((entry) => entry.id === taskId);
        if (!task) return library;
        const papers = library.papers.map((paper) => {
          if (paper.id !== paperId) return paper;
          const current = paper.screenings?.[taskId] ?? screenPaperForTask(paper, task);
          // Agent's original proposal, regardless of prior user edits.
          const agentOriginal = current.flippedFrom ?? current.decision;
          const userChanged = decision !== agentOriginal;
          const decided: PaperScreening = {
            ...current,
            decision,
            userConfirmed: true,
            flippedFrom: userChanged ? agentOriginal : undefined,
            decidedAt: isoNow(),
            reasons: userChanged
              ? [
                  {
                    id: makeId("reason"),
                    criteriaText: "Human review",
                    note: `Reviewer set this to ${decision} (agent proposed ${agentOriginal}).`,
                    anchor: current.reasons[0]?.anchor ?? {
                      kind: paper.abstract.trim() ? "abstract" : "metadata",
                      quote: firstUsefulQuote(paper),
                    },
                  },
                  ...current.reasons,
                ].slice(0, 4)
              : current.reasons,
          };
          return {
            ...paper,
            stage: stageForDecision(decision),
            verdict: screeningToVerdict(decided),
            screenings: {
              ...(paper.screenings ?? {}),
              [taskId]: decided,
            },
          };
        });
        const nextLibrary = { ...library, papers };
        return {
          ...nextLibrary,
          reviewTasks: nextLibrary.reviewTasks.map((entry) =>
            entry.id === taskId ? maybeSuggestCriteria(nextLibrary, entry) : entry,
          ),
        };
      });
    },

    acceptCriteriaSuggestion: (taskId, suggestionId) => {
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) => {
          if (task.id !== taskId) return task;
          const suggestion = task.suggestions.find((entry) => entry.id === suggestionId);
          if (!suggestion) return task;
          const criterion: ScreeningCriterion = {
            id: makeId("crit"),
            kind: "include",
            text: suggestion.text,
            createdAt: isoNow(),
          };
          return {
            ...task,
            criteria: [...task.criteria, criterion],
            suggestions: task.suggestions.map((entry) =>
              entry.id === suggestionId ? { ...entry, accepted: true } : entry,
            ),
            updatedAt: isoNow(),
          };
        }),
      }));
    },

    dismissCriteriaSuggestion: (taskId, suggestionId) => {
      mutate((library) => ({
        ...library,
        reviewTasks: library.reviewTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                suggestions: task.suggestions.map((suggestion) =>
                  suggestion.id === suggestionId
                    ? { ...suggestion, dismissed: true }
                    : suggestion,
                ),
                updatedAt: isoNow(),
              }
            : task,
        ),
      }));
    },

    setStage: (ids, stage) => patchPapers(ids, (paper) => ({ ...paper, stage })),

    deletePapers: (ids) => {
      const targets = new Set(ids);
      if (targets.size === 0) return;
      mutate((library) => ({
        ...library,
        papers: library.papers.filter((paper) => !targets.has(paper.id)),
        reviewTasks: library.reviewTasks.map((task) => ({
          ...task,
          suggestions: task.suggestions
            .map((suggestion) => ({
              ...suggestion,
              basisPaperIds: suggestion.basisPaperIds.filter((id) => !targets.has(id)),
            }))
            .filter((suggestion) => suggestion.basisPaperIds.length > 0),
        })),
      }));
      log("warn", `Deleted ${targets.size} ${targets.size === 1 ? "paper" : "papers"} from the library`, {
        open: true,
      });
    },

    toggleStar: (id) =>
      patchPapers([id], (paper) => ({ ...paper, starred: !paper.starred })),

    markRead: (id) =>
      patchPapers([id], (paper) => (paper.unread ? { ...paper, unread: false } : paper)),

    addTags: (ids, tags) =>
      patchPapers(ids, (paper) => ({
        ...paper,
        tags: Array.from(new Set([...paper.tags, ...tags])).sort(),
      })),

    addCollection: (label) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      mutate((library) => ({
        ...library,
        collections: [...library.collections, { id: makeId("col"), label: trimmed }],
      }));
    },

    removeCollection: (id) => {
      mutate((library) => ({
        ...library,
        collections: library.collections.filter((c) => c.id !== id),
        papers: library.papers.map((p) => ({
          ...p,
          collectionIds: p.collectionIds.filter((cid) => cid !== id),
        })),
      }));
    },

    assignCollection: (ids, collectionId) =>
      patchPapers(ids, (paper) => ({
        ...paper,
        collectionIds: paper.collectionIds.includes(collectionId)
          ? paper.collectionIds
          : [...paper.collectionIds, collectionId],
      })),

    toggleCollection: (paperId, collectionId) =>
      patchPapers([paperId], (paper) => ({
        ...paper,
        collectionIds: paper.collectionIds.includes(collectionId)
          ? paper.collectionIds.filter((id) => id !== collectionId)
          : [...paper.collectionIds, collectionId],
      })),

    setProjectFocus: (patch) => {
      mutate((library) => ({
        ...library,
        projectFocus: { ...emptyFocus(), ...(library.projectFocus ?? {}), ...patch },
      }));
    },

    generateBrief: async (paperId) => {
      const focus = get().library.projectFocus;
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper) return;
      if (paper.pdf.status !== "downloaded" || !paper.pdf.path) {
        const message = "请先下载 PDF；全文简报不会从摘要生成。";
        set({ error: message });
        log("warn", message, { open: true });
        return;
      }
      if (!isTauri()) {
        set({ error: "全文简报需要桌面后端读取 PDF。" });
        return;
      }
      set({ briefing: paperId });
      try {
        log("info", `正在提取完整 PDF 文本：${paper.title}`, { open: true });
        const extraction = await extractPdfTextByPage(paper.pdf.path);
        if (extraction.truncated) {
          const missingPages = extraction.missingPages ?? [];
          throw new Error(
            `PDF 全文不完整${missingPages.length > 0 ? `（无法读取第 ${missingPages.join("、")} 页）` : ""}，已停止生成以避免不完整简报。`,
          );
        }
        log("info", `已读取完整全文（${extraction.totalCharacters} 字符），正在生成简报…`);
        const brief = await llmBrief(paper, focus, extraction);
        const annotations = briefAnnotations(brief);
        patchPapers([paperId], (entry) => ({
          ...entry,
          brief,
          unread: false,
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "core"),
            ...annotations,
          ],
        }));
        log("ok", `全文简报已生成：${paper.title}`);
      } catch (error) {
        const message = `全文简报生成失败：${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
      } finally {
        set({ briefing: null });
      }
    },

    generateAnswerChains: async (paperId) => {
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper?.pdf.path || paper.pdf.status !== "downloaded") {
        set({ error: "请先下载 PDF，再生成问题-答案-证据链。" });
        return;
      }
      if (!isTauri()) {
        set({ error: "问题-答案-证据链需要桌面后端读取 PDF。" });
        return;
      }
      set({ generatingAnswerChains: paperId, error: null });
      try {
        log("info", `正在逐页读取 PDF 图片并构建统一证据链：${paper.title}`, {
          open: true,
        });
        const extraction = await extractPdfPageImages(paper.pdf.path);
        const evidence = await llmVisualEvidence(
          paper,
          get().library.projectFocus?.question ?? "",
          extraction.pages,
        );
        const evidenceMarks = evidenceAnnotations(evidence);
        patchPapers([paperId], (entry) => ({
          ...entry,
          evidence,
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "evidence"),
            ...evidenceMarks,
          ],
        }));
        const result = await llmAnswerChainsFromVisualEvidence(
          paper,
          get().library.projectFocus,
          evidence,
        );
        patchPapers([paperId], (entry) => ({
          ...entry,
          answerChains: result.chains,
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "answer-support"),
            ...result.annotations,
          ],
        }));
        log(
          "ok",
          `已读取全部 ${extraction.totalPages} 页，生成 ${evidence.length} 条视觉证据和 ${result.chains.length} 条问答证据链`,
        );
      } catch (error) {
        const message = `问题-答案-证据链生成失败：${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
      } finally {
        set({ generatingAnswerChains: null });
      }
    },

    addPdfAnnotation: (paperId, annotation) =>
      patchPapers([paperId], (paper) => ({
        ...paper,
        pdfAnnotations: [
          ...paper.pdfAnnotations,
          { ...annotation, id: makeId("annotation"), createdAt: isoNow() },
        ],
      })),

    updatePdfAnnotation: (paperId, annotationId, patch) =>
      patchPapers([paperId], (paper) => ({
        ...paper,
        pdfAnnotations: paper.pdfAnnotations.map((annotation) =>
          annotation.id === annotationId ? { ...annotation, ...patch } : annotation,
        ),
      })),

    deletePdfAnnotation: (paperId, annotationId) =>
      patchPapers([paperId], (paper) => ({
        ...paper,
        pdfAnnotations: paper.pdfAnnotations.filter((a) => a.id !== annotationId),
      })),

    deleteEvidence: (paperId, evidenceId) => {
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      const evidence = paper?.evidence.find((entry) => entry.id === evidenceId);
      if (!evidence) return;

      patchPapers([paperId], (entry) => {
        const fallbackMatchesEvidence = (annotation: PdfAnnotation) =>
          !annotation.evidenceId
          && annotation.page === evidence.page
          && normalizeAnchorText(annotation.quote) === normalizeAnchorText(evidence.quote)
          && (!evidence.imageFingerprint
            || annotation.imageFingerprint === evidence.imageFingerprint);
        const removedSupportIds = new Set(
          entry.pdfAnnotations
            .filter(
              (annotation) =>
                annotation.kind === "answer-support"
                && (annotation.evidenceId === evidenceId || fallbackMatchesEvidence(annotation)),
            )
            .map((annotation) => annotation.id),
        );
        const answerChains = entry.answerChains
          .map((chain) => ({
            ...chain,
            supports: chain.supports.filter(
              (support) => !removedSupportIds.has(support.annotationId),
            ),
          }))
          .filter((chain) => chain.supports.length > 0);

        return {
          ...entry,
          evidence: entry.evidence.filter((item) => item.id !== evidenceId),
          answerChains,
          pdfAnnotations: entry.pdfAnnotations.filter(
            (annotation) =>
              !(annotation.kind === "evidence" && annotation.sourceId === evidenceId)
              && !removedSupportIds.has(annotation.id),
          ),
        };
      });
      log("info", `已删除第 ${evidence.page} 页证据，并清理关联问答链支撑。`);
    },

    updateAnswerChain: (paperId, chainId, patch) =>
      patchPapers([paperId], (paper) => {
        const chain = paper.answerChains.find((entry) => entry.id === chainId);
        const roles = new Map(
          chain?.supports.map((support) => [support.annotationId, support.role]) ?? [],
        );
        return {
          ...paper,
          answerChains: paper.answerChains.map((entry) =>
            entry.id === chainId ? { ...entry, ...patch } : entry,
          ),
          pdfAnnotations: patch.answer
            ? paper.pdfAnnotations.map((annotation) =>
                annotation.sourceId === chainId
                  ? {
                      ...annotation,
                      note: `${roles.get(annotation.id) ?? "support"}: ${patch.answer}`,
                    }
                  : annotation,
              )
            : paper.pdfAnnotations,
        };
      }),

    downloadPdf: async (id) => {
      const paper = get().library.papers.find((entry) => entry.id === id);
      const url = paper?.pdf.url;
      if (!paper || !url) {
        set({ error: "no direct PDF link is known for this paper" });
        return;
      }
      if (!isTauri()) {
        set({
          error:
            "PDF download needs the desktop backend — run `npm run tauri dev` (browser preview shows sample data only)",
        });
        return;
      }
      if (paper.pdf.status === "downloading") return;
      patchPapers([id], (entry) => ({
        ...entry,
        pdf: { ...entry.pdf, status: "downloading", error: undefined },
      }));
      log("info", `→ Downloading PDF: ${pdfFileName(paper)}`, { open: true });
      try {
        const saved = await literatureDownloadPdf<PdfDownloadResult>(url, pdfFileName(paper));
        patchPapers([id], (entry) => ({
          ...entry,
          stage:
            entry.stage === "inbox" || entry.stage === "screened" || entry.stage === "shortlist"
              ? "downloaded"
              : entry.stage,
          pdf: {
            ...entry.pdf,
            status: "downloaded",
            path: saved.relativePath,
            bytes: saved.bytes,
          },
        }));
        log("ok", `✓ PDF saved → ${saved.relativePath} (${Math.max(1, Math.round(saved.bytes / 1024))} KB)`);
      } catch (error) {
        patchPapers([id], (entry) => ({
          ...entry,
          pdf: { ...entry.pdf, status: "failed", error: String(error) },
        }));
        set({ error: `PDF download failed: ${String(error)}` });
        log("error", `✗ PDF download failed: ${String(error)}`, { open: true });
      }
    },

    uploadPdf: async (id, sourcePath) => {
      const paper = get().library.papers.find((entry) => entry.id === id);
      if (!paper || !sourcePath.trim()) return;
      if (!isTauri()) {
        set({ error: "上传 PDF 需要桌面后端。" });
        return;
      }
      try {
        const saved = await literatureImportPdf<PdfDownloadResult>(sourcePath, pdfFileName(paper));
        patchPapers([id], (entry) => ({
          ...entry,
          stage:
            entry.stage === "inbox" || entry.stage === "screened" || entry.stage === "shortlist"
              ? "downloaded"
              : entry.stage,
          pdf: {
            ...entry.pdf,
            status: "downloaded",
            path: saved.relativePath,
            bytes: saved.bytes,
            error: undefined,
          },
        }));
        log("ok", `已导入用户 PDF：${saved.relativePath}`);
      } catch (error) {
        const message = `PDF 导入失败：${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    openPdf: async (id) => {
      const paper = get().library.papers.find((entry) => entry.id === id);
      if (!paper?.pdf.path || paper.pdf.status !== "downloaded") {
        set({ error: "这篇论文还没有可打开的本地 PDF。" });
        return;
      }
      if (!isTauri()) {
        set({ error: "打开 PDF 需要桌面后端。" });
        return;
      }
      try {
        await literaturePdfOpen(paper.pdf.path);
        log("ok", `已打开 PDF：${paper.pdf.path}`);
      } catch (error) {
        const message = `打开 PDF 失败：${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    setError: (message) => set({ error: message }),
  };
});

/** Test helper: build a Brief without going through the store. */
export const briefForTest = briefFromPaper;

/** Test helper: reset the singleton store between cases. */
export const resetLiteratureStore = () =>
  useLiteratureStore.setState({
    library: emptyLibrary(),
    loaded: false,
    loadedProjectId: null,
    error: null,
    screening: false,
    searching: false,
    generatingAnswerChains: null,
    briefing: null,
    activity: [],
    activityOpen: false,
    activeReviewTaskId: null,
  });

import { create } from "zustand";
import {
  isTauri,
  literatureDownloadPdf,
  literatureLlm,
  literatureLoad,
  literaturePdfText,
  literatureSave,
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
  type PaperBrief,
  type PaperFit,
  type PaperScreening,
  type PaperStage,
  type PdfDownloadResult,
  type ProjectFocus,
  type ScreeningCriterion,
  type ScreeningDecision,
  type ScreeningReason,
} from "./literatureTypes";

const MAX_ACTIVITY_ENTRIES = 200;

const PERSIST_DELAY_MS = 600;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const isoNow = () => new Date().toISOString();

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

// ── Abstract Brief (M2.b) ───────────────────────────────────────────────────
// Heuristic, deterministic, offline — the same "agent drafts, human verifies"
// stance as the screener. A real LLM read is a clean later swap behind
// `generateBrief`. Every section is tagged with its source so the
// no-anchor-no-claim rule holds.

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
// failure (no key, bad JSON, offline preview) degrades to the heuristic — the
// queue/Brief UX absorbs imperfection either way.

const clampScore = (value: unknown) =>
  Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const normalizeDecision = (value: unknown): ScreeningDecision => {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("include")) return "include";
  if (text.includes("exclude")) return "exclude";
  return "maybe";
};

/** Pull a JSON value out of an LLM response that may wrap it in prose or a
 * ```json fence. */
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
        // fall through to throw
      }
    }
  }
  throw new Error("model did not return JSON");
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
  const text = await literatureLlm(SCREEN_SYSTEM, buildScreenPrompt(papers, task));
  const parsed = extractJson(text);
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
          criteriaText: "Agent judgment",
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
  "You are a precise research reading assistant. Produce a structured brief of a paper tailored to a specific researcher. Be concrete and include numbers from the paper in Results. Write all section values in Chinese. Respond with a single JSON object and nothing else.";

const buildBriefPrompt = (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  fullText: string | undefined,
) => {
  const focusLine = focus?.question?.trim()
    ? `Researcher focus: ${focus.question}${focus.scope ? ` (scope: ${focus.scope})` : ""}`
    : "Researcher focus: (not provided)";
  const body = fullText
    ? `Full text (may be truncated):\n${fullText}`
    : `Abstract:\n${paper.abstract || "(no abstract provided)"}`;
  return `${focusLine}

Title: ${paper.title}
${body}

Return a JSON object: {"problem": "...", "method": "...", "results": "...", "limits": "...", "forYou": "..."}.
Each field is at most two sentences. "results" MUST include concrete numbers if the paper reports any. "limits" states the paper's own limitations or "Not stated". "forYou" relates the paper to the researcher focus, or says it is tangential.
All values must be written in Chinese.`;
};

const llmBrief = async (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  fullText: string | undefined,
): Promise<PaperBrief> => {
  const text = await literatureLlm(BRIEF_SYSTEM, buildBriefPrompt(paper, focus, fullText));
  const parsed = extractJson(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") throw new Error("expected a JSON object");
  const source: AnchorKind = fullText ? "pdf" : "abstract";
  const section = (value: unknown, fallback: string): BriefSection => ({
    text: String(value ?? "").trim() || fallback,
    source,
  });
  return {
    problem: section(parsed.problem, "现有文本中未提及。"),
    method: section(parsed.method, "现有文本中未提及。"),
    results: section(parsed.results, "现有文本中未提及。"),
    limits: section(parsed.limits, "未说明。"),
    forYou: section(parsed.forYou, "与研究方向的关联尚不明确。"),
    basis: fullText ? "fulltext" : "abstract",
    generatedAt: isoNow(),
  };
};

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
          note: "Supports the staged UI: metadata first, PDF later.",
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
  setProjectFocus: (patch: Partial<ProjectFocus>) => void;
  generateBrief: (paperId: string) => void;
  downloadPdf: (id: string) => Promise<void>;
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
    briefing: null,
    activity: [],
    activityOpen: false,
    activeReviewTaskId: null,

    setActivityOpen: (open) => set({ activityOpen: open }),
    logActivity: (level, text) => log(level, text, { open: true }),
    clearActivity: () => set({ activity: [] }),

    setActiveReviewTask: (id) => set({ activeReviewTaskId: id }),

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
        const raw = await literatureLoad<Partial<LiteratureLibrary>>();
        const reviewTasks = raw.reviewTasks ?? [];
        set({
          library: {
            version: 1,
            papers: raw.papers ?? [],
            searches: raw.searches ?? [],
            collections: raw.collections ?? [],
            reviewTasks,
            projectFocus: raw.projectFocus,
          },
          loaded: true,
          loadedProjectId: projectId,
          activeReviewTaskId: get().activeReviewTaskId ?? reviewTasks[0]?.id ?? null,
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
        log("info", `→ Screening ${candidates.length} abstracts with the agent…`, { open: true });
        try {
          llmResults = await llmScreen(candidates, task);
        } catch (error) {
          log("warn", `! Agent screening unavailable (${String(error)}) — using keyword heuristic`);
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
          `Screened ${candidates.length} abstracts against "${task.question}" (${llmResults ? "agent" : "heuristic"})`,
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
      set({ briefing: paperId });
      try {
        let brief: PaperBrief | null = null;
        if (isTauri()) {
          let fullText: string | undefined;
          if (paper.pdf.status === "downloaded" && paper.pdf.path) {
            try {
              fullText = await literaturePdfText(paper.pdf.path);
            } catch {
              // no readable PDF text — brief from the abstract
            }
          }
          log("info", `→ Reading ${fullText ? "the full text" : "the abstract"} for a brief…`, {
            open: true,
          });
          try {
            brief = await llmBrief(paper, focus, fullText);
            log("ok", `Brief written by the agent from ${fullText ? "the full text" : "the abstract"}: ${paper.title}`);
          } catch (error) {
            log("warn", `! Agent brief unavailable (${String(error)}) — keyword summary`);
          }
        }
        if (!brief) {
          brief = briefFromPaper(paper, focus);
          log("ok", `Brief generated from the abstract (heuristic): ${paper.title}`);
        }
        patchPapers([paperId], (entry) => ({ ...entry, brief, unread: false }));
      } finally {
        set({ briefing: null });
      }
    },

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
    briefing: null,
    activity: [],
    activityOpen: false,
    activeReviewTaskId: null,
  });

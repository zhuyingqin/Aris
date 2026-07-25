import { create } from "zustand";
import {
  isTauri,
  knowledgeConfirm,
  knowledgeGenerate,
  knowledgeLoad,
  knowledgeReject,
  knowledgeSearch,
  knowledgeUpsert,
  literatureLoad,
} from "../api/tauri";
import { useStore } from "../store";
import { KNOWLEDGE_COPY } from "./i18n";
import {
  type KnowledgeFragment,
  type KnowledgePoint,
  type KnowledgeSearchHit,
  type KnowledgeSourcePaper,
} from "./knowledgeTypes";

interface LibraryEvidenceLite {
  id?: string;
  page?: number;
  quote?: string;
  note?: string;
  source?: string;
}

interface LibraryAnswerChainLite {
  id?: string;
  question?: string;
  answer?: string;
  supports?: Array<{ annotationId?: string; role?: string }>;
  reviewStatus?: string;
}

interface LibraryAnnotationLite {
  id?: string;
  page?: number;
  quote?: string;
  note?: string;
  source?: string;
  sourceId?: string;
  evidenceId?: string;
}

interface LibraryPaperLite {
  id: string;
  title?: string;
  stage?: string;
  brief?: unknown;
  evidence?: LibraryEvidenceLite[];
  answerChains?: LibraryAnswerChainLite[];
  pdfAnnotations?: LibraryAnnotationLite[];
}

/** A paper can seed knowledge once it has been read into some structured form. */
const hasReadingMaterial = (paper: LibraryPaperLite): boolean =>
  Boolean(paper.brief) ||
  (Array.isArray(paper.evidence) && paper.evidence.length > 0) ||
  (Array.isArray(paper.answerChains) && paper.answerChains.length > 0);

const toSourcePaper = (paper: LibraryPaperLite): KnowledgeSourcePaper => ({
  id: paper.id,
  title: paper.title?.trim() || paper.id,
  stage: paper.stage || "inbox",
  hasReading: hasReadingMaterial(paper),
});

const clean = (value: unknown): string => String(value ?? "").trim();

const toKnowledgeFragments = (paper: LibraryPaperLite): KnowledgeFragment[] => {
  const title = paper.title?.trim() || paper.id;
  const evidence = Array.isArray(paper.evidence) ? paper.evidence : [];
  const annotations = Array.isArray(paper.pdfAnnotations) ? paper.pdfAnnotations : [];
  const annotationById = new Map(
    annotations
      .filter((annotation) => annotation.id)
      .map((annotation) => [annotation.id as string, annotation]),
  );

  const fragments: KnowledgeFragment[] = evidence
    .filter((item) => clean(item.quote) || clean(item.note))
    .map((item, index) => ({
      id: `${paper.id}:evidence:${item.id ?? index}`,
      kind: "evidence",
      paperId: paper.id,
      paperTitle: title,
      page: typeof item.page === "number" ? item.page : null,
      title: clean(item.note) || KNOWLEDGE_COPY[useStore.getState().language].pageEvidenceFallback(item.page ?? "?"),
      text: clean(item.note) || clean(item.quote),
      quote: clean(item.quote) || null,
      source: item.source ?? null,
      evidenceIds: item.id ? [item.id] : [],
    }));

  const chains = Array.isArray(paper.answerChains) ? paper.answerChains : [];
  for (const chain of chains) {
    const question = clean(chain.question);
    const answer = clean(chain.answer);
    if (!question && !answer) continue;
    const supportAnnotations = (chain.supports ?? [])
      .map((support) => support.annotationId ? annotationById.get(support.annotationId) : undefined)
      .filter((annotation): annotation is LibraryAnnotationLite => Boolean(annotation));
    const firstSupport = supportAnnotations[0];
    fragments.push({
      id: `${paper.id}:answer:${chain.id ?? fragments.length}`,
      kind: "answer-chain",
      paperId: paper.id,
      paperTitle: title,
      page: typeof firstSupport?.page === "number" ? firstSupport.page : null,
      title: question || KNOWLEDGE_COPY[useStore.getState().language].answerChainFallbackTitle,
      text: answer || question,
      quote: clean(firstSupport?.quote) || null,
      role: chain.supports?.[0]?.role ?? null,
      source: firstSupport?.source ?? null,
      status: chain.reviewStatus ?? null,
      evidenceIds: supportAnnotations
        .map((annotation) => annotation.evidenceId)
        .filter((id): id is string => Boolean(id)),
    });
  }

  return fragments;
};

const normalizePoint = (point: Partial<KnowledgePoint>): KnowledgePoint => ({
  id: point.id ?? "",
  question: point.question ?? "",
  answer: point.answer ?? "",
  statement: point.statement ?? "",
  kind: point.kind ?? null,
  status:
    point.status === "confirmed" || point.status === "archived"
      ? point.status
      : "draft",
  sourcePaperId: point.sourcePaperId ?? null,
  evidence: Array.isArray(point.evidence) ? point.evidence : [],
  relations: Array.isArray(point.relations) ? point.relations : [],
  createdAt: point.createdAt ?? null,
  confirmedAt: point.confirmedAt ?? null,
  version: point.version ?? 1,
});

/** The kernel upsert input shape (camelCase) for persisting a refined draft. */
const toUpsertInput = (point: KnowledgePoint) => ({
  id: point.id,
  question: point.question,
  answer: point.answer,
  statement: point.statement,
  kind: point.kind ?? undefined,
  sourcePaperId: point.sourcePaperId ?? undefined,
  evidence: point.evidence.map((item) => ({
    paperId: item.paperId,
    page: item.page ?? undefined,
    quote: item.quote,
    role: item.role ?? undefined,
    annotationId: item.annotationId ?? undefined,
    evidenceId: item.evidenceId ?? undefined,
  })),
});

/** Browser-preview fixture (no Tauri backend) so the Duolingo review flow and
 * the confirmed-knowledge list are demoable and visually reviewable. */
const PREVIEW_POINTS: KnowledgePoint[] = [
  {
    id: "kp-demo-draft-1",
    question: "How much does the agentic review pipeline cut screening time?",
    answer:
      "The pipeline reduces full-text screening time by about 60% versus manual triage, by drafting verdicts the human only has to confirm.",
    statement:
      "Agentic screening cuts full-text triage time by ~60% under a draft-then-confirm loop.",
    kind: "finding",
    status: "draft",
    sourcePaperId: "arxiv:2602.01491",
    evidence: [
      {
        paperId: "arxiv:2602.01491",
        page: 6,
        quote:
          "Reviewers spent 61% less time per paper when the agent supplied a verdict with a cited rationale.",
        role: "answer-support",
        annotationId: "ann-demo-1",
        evidenceId: null,
      },
    ],
    relations: [],
    version: 1,
  },
  {
    id: "kp-demo-draft-2",
    question: "What grounding rule keeps the agent's claims trustworthy?",
    answer:
      "Every agent claim must carry a clickable citation (page + quote); a claim without an anchor degrades trust on the second use.",
    statement: "No anchor, no claim: each agent claim cites a page-anchored quote.",
    kind: "method",
    status: "draft",
    sourcePaperId: "arxiv:2602.01491",
    evidence: [
      {
        paperId: "arxiv:2602.01491",
        page: 3,
        quote: "We require every generated assertion to resolve to a verbatim span in the source.",
        role: "answer-support",
        annotationId: "ann-demo-2",
        evidenceId: null,
      },
    ],
    relations: [],
    version: 1,
  },
  {
    id: "kp-demo-confirmed-1",
    question: "Why separate the authoritative store from the retrieval index?",
    answer:
      "Keeping a SQLite source of truth distinct from a derived retrieval layer lets you swap the embedding model or vector backend without migrating the real knowledge data.",
    statement:
      "Separating authoritative store from retrieval index makes embedding/vector swaps non-destructive.",
    kind: "finding",
    status: "confirmed",
    sourcePaperId: "arxiv:2602.01491",
    evidence: [
      {
        paperId: "arxiv:2602.01491",
        page: 8,
        quote: "Authoritative data and retrieval indices are kept separate and re-derivable.",
        role: "answer-support",
        annotationId: null,
        evidenceId: "ev-demo-1",
      },
    ],
    relations: [],
    confirmedAt: "2026-06-14T10:00:00.000Z",
    version: 1,
  },
];

const PREVIEW_SOURCE_PAPERS: KnowledgeSourcePaper[] = [
  {
    id: "arxiv:2602.01491",
    title: "Agentic Literature Review: Planning and Synthesis",
    stage: "read",
    hasReading: true,
  },
];

const previewFragments = (): KnowledgeFragment[] => {
  const copy = KNOWLEDGE_COPY[useStore.getState().language];
  return [
    {
      id: "arxiv:2602.01491:evidence:ev-1",
      kind: "evidence",
      paperId: "arxiv:2602.01491",
      paperTitle: "Agentic Literature Review: Planning and Synthesis",
      page: 6,
      title: copy.previewFragmentEvidenceTitle,
      text: copy.previewFragmentEvidenceText,
      quote:
        "Reviewers spent 61% less time per paper when the agent supplied a verdict with a cited rationale.",
      source: "vision",
      evidenceIds: ["ev-1"],
    },
    {
      id: "arxiv:2602.01491:answer:chain-1",
      kind: "answer-chain",
      paperId: "arxiv:2602.01491",
      paperTitle: "Agentic Literature Review: Planning and Synthesis",
      page: 3,
      title: copy.previewFragmentAnswerTitle,
      text: copy.previewFragmentAnswerText,
      quote: "We require every generated assertion to resolve to a verbatim span in the source.",
      status: "accepted",
      evidenceIds: ["ev-2"],
    },
  ];
};

interface KnowledgeState {
  points: KnowledgePoint[];
  fragments: KnowledgeFragment[];
  sourcePapers: KnowledgeSourcePaper[];
  loaded: boolean;
  loadedProjectId: string | null;
  generatingPaperId: string | null;
  error: string | null;
  searchQuery: string;
  searchHits: KnowledgeSearchHit[];

  load: (projectId: string) => Promise<void>;
  generate: (paperId: string) => Promise<number>;
  confirm: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  refine: (id: string, patch: Partial<Pick<KnowledgePoint, "question" | "answer" | "statement">>) => Promise<void>;
  search: (query: string) => Promise<void>;
  setError: (error: string | null) => void;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  points: [],
  fragments: [],
  sourcePapers: [],
  loaded: false,
  loadedProjectId: null,
  generatingPaperId: null,
  error: null,
  searchQuery: "",
  searchHits: [],

  load: async (projectId) => {
    if (!isTauri()) {
      set({
        points: PREVIEW_POINTS,
        fragments: previewFragments(),
        sourcePapers: PREVIEW_SOURCE_PAPERS,
        loaded: true,
        loadedProjectId: projectId,
      });
      return;
    }
    set({ error: null });
    try {
      const [pointsResult, libraryResult] = await Promise.all([
        knowledgeLoad<{ points?: Partial<KnowledgePoint>[] }>(),
        literatureLoad<{ papers?: LibraryPaperLite[] }>().catch(() => ({ papers: [] })),
      ]);
      const points = (pointsResult.points ?? []).map(normalizePoint);
      const papers = libraryResult.papers ?? [];
      const sourcePapers = papers
        .filter(hasReadingMaterial)
        .map(toSourcePaper);
      const fragments = papers.flatMap(toKnowledgeFragments);
      set({ points, fragments, sourcePapers, loaded: true, loadedProjectId: projectId });
    } catch (error) {
      set({ error: `failed to load knowledge base: ${String(error)}` });
    }
  },

  generate: async (paperId) => {
    if (!isTauri()) return 0;
    set({ generatingPaperId: paperId, error: null });
    try {
      const result = await knowledgeGenerate<{ candidates?: Partial<KnowledgePoint>[]; warning?: string }>(
        paperId,
      );
      const candidates = (result.candidates ?? []).map(normalizePoint);
      set((state) => {
        const byId = new Map(state.points.map((point) => [point.id, point]));
        for (const candidate of candidates) byId.set(candidate.id, candidate);
        return {
          points: Array.from(byId.values()),
          generatingPaperId: null,
          error: result.warning ?? null,
        };
      });
      return candidates.length;
    } catch (error) {
      set({ generatingPaperId: null, error: `failed to generate knowledge: ${String(error)}` });
      return 0;
    }
  },

  confirm: async (id) => {
    const stamp = () =>
      set((state) => ({
        points: state.points.map((point) =>
          point.id === id
            ? { ...point, status: "confirmed", confirmedAt: new Date().toISOString() }
            : point,
        ),
      }));
    if (!isTauri()) {
      stamp();
      return;
    }
    try {
      await knowledgeConfirm(id);
      stamp();
    } catch (error) {
      set({ error: `failed to confirm knowledge point: ${String(error)}` });
    }
  },

  reject: async (id) => {
    const drop = () =>
      set((state) => ({ points: state.points.filter((point) => point.id !== id) }));
    if (!isTauri()) {
      drop();
      return;
    }
    try {
      await knowledgeReject(id);
      drop();
    } catch (error) {
      set({ error: `failed to reject knowledge point: ${String(error)}` });
    }
  },

  refine: async (id, patch) => {
    const current = get().points.find((point) => point.id === id);
    if (!current) return;
    const next: KnowledgePoint = { ...current, ...patch, status: "draft" };
    set((state) => ({
      points: state.points.map((point) => (point.id === id ? next : point)),
    }));
    if (!isTauri()) return;
    try {
      await knowledgeUpsert([toUpsertInput(next)]);
    } catch (error) {
      set({ error: `failed to save refined knowledge point: ${String(error)}` });
    }
  },

  search: async (query) => {
    const trimmed = query.trim();
    set({ searchQuery: query });
    if (!trimmed) {
      set({ searchHits: [] });
      return;
    }
    if (!isTauri()) {
      const lowered = trimmed.toLowerCase();
      const hits = get()
        .points.filter(
          (point) =>
            point.status === "confirmed" &&
            `${point.question} ${point.answer} ${point.statement}`
              .toLowerCase()
              .includes(lowered),
        )
        .map((point) => ({ ...point, snippet: point.statement, relations: point.relations ?? [] }));
      set({ searchHits: hits });
      return;
    }
    try {
      const result = await knowledgeSearch<{ results?: KnowledgeSearchHit[] }>(trimmed);
      set({ searchHits: result.results ?? [] });
    } catch (error) {
      set({ error: `failed to search knowledge base: ${String(error)}` });
    }
  },

  setError: (error) => set({ error }),
}));

export const resetKnowledgeStore = () => {
  useKnowledgeStore.setState({
    points: [],
    fragments: [],
    sourcePapers: [],
    loaded: false,
    loadedProjectId: null,
    generatingPaperId: null,
    error: null,
    searchQuery: "",
    searchHits: [],
  });
};

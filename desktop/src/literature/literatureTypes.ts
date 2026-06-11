// Shared shapes for the literature library. The on-disk form of
// `LiteratureLibrary` is `papers/library.json` inside the active project —
// the same folder the `/arxiv` skill writes PDFs into.

export type PaperStage =
  | "inbox"
  | "screened"
  | "shortlist"
  | "downloaded"
  | "read"
  | "excluded";

export type PaperFit = "high" | "medium" | "low";

export type PdfStatus = "none" | "queued" | "downloading" | "downloaded" | "failed";

export type DetailTab = "overview" | "notes" | "evidence" | "files";

export type ScreeningDecision = "include" | "exclude" | "maybe";

export type CriterionKind = "include" | "exclude";

export type AnchorKind = "abstract" | "metadata" | "pdf";

/** Project-level reference frame for the Agent's "for you" judgment — what
 * makes a Brief tailored rather than a generic summary. Stored at the top of
 * library.json. */
export interface ProjectFocus {
  question: string;
  motivation: string;
  scope: string;
  currentAssumptions: string;
}

export type BriefField = "problem" | "method" | "results" | "limits" | "forYou";

/** One Brief section. `source` records where the claim came from so the
 * "no anchor, no claim" rule holds — `abstract` at M2.b, page-anchored `pdf`
 * at M3.b. */
export interface BriefSection {
  text: string;
  source: AnchorKind;
}

/** A 5-section structured read of a paper — a 5-minute replacement for a
 * 30-minute skim. M2.b generates these from the abstract. */
export interface PaperBrief {
  problem: BriefSection;
  method: BriefSection;
  results: BriefSection;
  limits: BriefSection;
  forYou: BriefSection;
  basis: "abstract" | "fulltext";
  generatedAt: string;
}

export interface PaperPdf {
  status: PdfStatus;
  /** Direct download URL when the source exposes one. */
  url?: string;
  /** Path relative to the project root, e.g. `papers/2602.01491.pdf`. */
  path?: string;
  bytes?: number;
  error?: string;
}

/** Agent screening outcome (M3 fills this in; imports may carry it too). */
export interface AgentVerdict {
  fit: PaperFit;
  score: number;
  rationale: string;
  decidedAt: string;
}

export interface ScreeningCriterion {
  id: string;
  kind: CriterionKind;
  text: string;
  createdAt: string;
}

export interface CriteriaSuggestion {
  id: string;
  text: string;
  basisPaperIds: string[];
  createdAt: string;
  accepted?: boolean;
  dismissed?: boolean;
}

export interface LiteratureReviewTask {
  id: string;
  question: string;
  criteria: ScreeningCriterion[];
  searchIds: string[];
  createdAt: string;
  updatedAt: string;
  suggestions: CriteriaSuggestion[];
}

export interface EvidenceAnchor {
  kind: AnchorKind;
  quote: string;
  page?: number;
}

export interface ScreeningReason {
  id: string;
  criteriaId?: string;
  criteriaText: string;
  note: string;
  anchor: EvidenceAnchor;
}

export interface PaperScreening {
  taskId: string;
  decision: ScreeningDecision;
  score: number;
  confidence: number;
  reasons: ScreeningReason[];
  decidedAt: string;
  userConfirmed?: boolean;
  flippedFrom?: ScreeningDecision;
}

export interface EvidenceNote {
  id: string;
  page: number;
  quote: string;
  note: string;
}

export interface LiteraturePaper {
  /** Stable id: `arxiv:<id>`, `doi:<doi>` or `title:<normalized>`. */
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  abstract: string;
  tags: string[];
  collectionIds: string[];
  /** Saved searches that surfaced this paper. */
  searchIds: string[];
  stage: PaperStage;
  starred: boolean;
  unread: boolean;
  source: string;
  citedBy?: number;
  addedAt: string;
  pdf: PaperPdf;
  verdict?: AgentVerdict;
  screenings?: Record<string, PaperScreening>;
  brief?: PaperBrief;
  agentSummary?: string;
  evidence: EvidenceNote[];
}

export interface LiteratureSearch {
  id: string;
  query: string;
  sources: string[];
  ranAt: string;
  resultCount: number;
  newCount: number;
}

export interface LiteratureCollection {
  id: string;
  label: string;
}

export interface LiteratureLibrary {
  version: 1;
  papers: LiteraturePaper[];
  searches: LiteratureSearch[];
  collections: LiteratureCollection[];
  reviewTasks: LiteratureReviewTask[];
  projectFocus?: ProjectFocus;
}

export type ActivityLevel = "info" | "ok" | "warn" | "error";

/** One line in the Literature activity log (the page's "terminal"). */
export interface ActivityEntry {
  id: string;
  at: string;
  level: ActivityLevel;
  text: string;
}

export interface PdfDownloadResult {
  path: string;
  relativePath: string;
  bytes: number;
}

export const emptyLibrary = (): LiteratureLibrary => ({
  version: 1,
  papers: [],
  searches: [],
  collections: [],
  reviewTasks: [],
});

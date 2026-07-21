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

export type LiteratureItemType =
  | "article"
  | "book"
  | "bookSection"
  | "conferencePaper"
  | "thesis"
  | "report"
  | "webpage"
  | "dataset"
  | "preprint"
  | "other";

export type PaperFit = "high" | "medium" | "low";

export type PdfStatus = "none" | "queued" | "downloading" | "downloaded" | "failed";

export type DetailTab = "info" | "overview" | "reader" | "notes" | "evidence" | "files";

export type ScreeningDecision = "include" | "exclude" | "maybe";

export type CriterionKind = "include" | "exclude";

export type AnchorKind = "abstract" | "metadata" | "pdf";
export type EvidenceSource = "text" | "vision";

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

/** One Brief section. New Briefs require extracted PDF full text; `abstract`
 * remains for legacy records and abstract-only screening evidence. */
export interface BriefSection {
  text: string;
  source: AnchorKind;
  page?: number;
  /** Verbatim supporting sentence used for PDF highlighting. */
  quote?: string;
}

/** A 5-section structured read generated from extracted full text. The
 * `abstract` basis is retained only so older saved records stay readable. */
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
  /** How this individual decision was produced. Older records omit it. */
  method?: "review-llm" | "heuristic";
  /** Durable batch checkpoint that produced this decision. */
  screenRunId?: string;
  chunkId?: string;
  userConfirmed?: boolean;
  flippedFrom?: ScreeningDecision;
}

export type LiteratureScreenRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "partial"
  | "fallback"
  | "failed";

export interface LiteratureScreenChunk {
  id: string;
  index: number;
  paperIds: string[];
  status: LiteratureScreenRunStatus;
  expectedCount: number;
  reviewerCount: number;
  fallbackCount: number;
  /** Local zero-based indices omitted or duplicated by the Reviewer reply. */
  missingIndices: number[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/** Append-only screening batch manifest used for resume/audit in the Desktop. */
export interface LiteratureScreenRun {
  id: string;
  taskId: string;
  status: LiteratureScreenRunStatus;
  chunkSize: number;
  totalPapers: number;
  reviewerCount: number;
  fallbackCount: number;
  criteriaUpdatedAt: string;
  startedAt: string;
  completedAt?: string;
  chunks: LiteratureScreenChunk[];
}

export interface EvidenceNote {
  id: string;
  page: number;
  quote: string;
  note: string;
  /** `vision` means the LLM read the rendered PDF page image directly. */
  source?: EvidenceSource;
  /** Fingerprint of the exact rendered page image used by the visual reader. */
  imageFingerprint?: string;
}

export type PdfAnnotationKind = "core" | "evidence" | "answer-support" | "note";
export type PdfAnnotationColor = "yellow" | "green" | "blue" | "red" | "purple";
/** Visual treatment of a mark. Absent = "highlight" (back-compat with older records). */
export type PdfAnnotationStyle = "highlight" | "underline" | "strikethrough";

export interface PdfAnnotationRect {
  /** Normalized coordinates relative to the rendered PDF page. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  page: number;
  quote: string;
  note: string;
  kind: PdfAnnotationKind;
  color?: PdfAnnotationColor;
  style?: PdfAnnotationStyle;
  rects?: PdfAnnotationRect[];
  source?: EvidenceSource;
  imageFingerprint?: string;
  /** Id of the Brief section, evidence item, or answer chain that created it. */
  sourceId?: string;
  /** Evidence item that directly grounds an answer-support annotation. */
  evidenceId?: string;
  createdAt: string;
}

/**
 * A project-local file or an external resource associated with a paper.
 * `pdf` remains the compatibility pointer for the PDF reader; attachments are
 * the canonical UI model so a work can carry its manuscript, supplements,
 * snapshots, and links together.
 */
export type LiteratureAttachmentKind = "pdf" | "supplement" | "webSnapshot" | "externalLink";

export interface LiteratureAttachment {
  id: string;
  label: string;
  kind: LiteratureAttachmentKind;
  /** Path relative to the active local project. */
  path?: string;
  /** A deliberately external resource; it is never copied without user action. */
  url?: string;
  mimeType?: string;
  bytes?: number;
  addedAt: string;
}

/** A durable human note, optionally linked back to a highlight or evidence item. */
export interface LiteratureNote {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  annotationId?: string;
  attachmentId?: string;
  evidenceId?: string;
  source?: "manual" | "annotation" | "imported";
}

export interface AnswerChainSupport {
  annotationId: string;
  role: string;
}

export interface ReadingAnswerChain {
  id: string;
  question: string;
  answer: string;
  supports: AnswerChainSupport[];
  basis?: EvidenceSource;
  reviewStatus: "unreviewed" | "accepted" | "rejected";
  createdAt: string;
}

export interface LiteraturePaper {
  /** Stable id: `arxiv:<id>`, `doi:<doi>` or `title:<normalized>`. */
  id: string;
  title: string;
  /** Zotero/CSL-compatible item type, with unknown values retained as `other`. */
  itemType?: LiteratureItemType | string;
  authors: string[];
  year?: number;
  venue: string;
  doi?: string;
  isbn?: string;
  citationKey?: string;
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
  /** Multiple local and external resources. Optional for legacy projections. */
  attachments?: LiteratureAttachment[];
  verdict?: AgentVerdict;
  screenings?: Record<string, PaperScreening>;
  brief?: PaperBrief;
  agentSummary?: string;
  evidence: EvidenceNote[];
  /** Generated question -> final answer -> verified PDF support chains. */
  answerChains: ReadingAnswerChain[];
  /** Persistent highlights and notes rendered inside the embedded PDF reader. */
  pdfAnnotations: PdfAnnotation[];
  /** Free-form notes and notes created from reader annotations. */
  notes?: LiteratureNote[];
}

export interface LiteratureSearch {
  id: string;
  query: string;
  sources: string[];
  ranAt: string;
  resultCount: number;
  newCount: number;
  searchRunId?: string;
  protocolId?: string;
  status?: string;
  /** A local query view that re-evaluates as the library changes. */
  dynamic?: boolean;
}

export interface LiteratureCollection {
  id: string;
  label: string;
  parentId?: string;
}

export interface LiteratureDuplicateCandidate {
  primaryRecordId: string;
  duplicateRecordId: string;
  normalizedTitle: string;
  reason: string;
}

export interface LiteratureLibrary {
  version: 1;
  papers: LiteraturePaper[];
  searches: LiteratureSearch[];
  collections: LiteratureCollection[];
  reviewTasks: LiteratureReviewTask[];
  screenRuns: LiteratureScreenRun[];
  projectFocus?: ProjectFocus;
}

/** Read-only health/status surface for the project-local canonical store. */
export interface LiteratureStorageStatus {
  schemaVersion: number;
  databasePath: string;
  databaseBytes: number;
  canonicalRecordCount: number;
  searchRunCount: number;
  health: {
    healthy: boolean;
    integrityCheck: string;
    foreignKeyViolations: number;
    journalMode: string;
  };
  latestBackup?: {
    path: string;
    bytes: number;
    /** Unix time in milliseconds, represented as a string by the Rust layer. */
    createdAt: string;
  } | null;
  projectionPath: string;
  projectionExists: boolean;
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

export interface RemoteLiteraturePaper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue: string;
  doi?: string;
  arxivId?: string;
  abstract: string;
  url?: string;
  pdfUrl?: string;
  source: string;
  published?: string;
  citedBy?: number;
}

export interface LiteratureSearchResult {
  papers: RemoteLiteraturePaper[];
  warnings: string[];
  sourceCounts: Array<{ source: string; count: number }>;
}

export interface LiteratureUpsertResult {
  searchId?: string;
  added: number;
  merged: number;
  total: number;
  libraryPath: string;
}

export const emptyLibrary = (): LiteratureLibrary => ({
  version: 1,
  papers: [],
  searches: [],
  collections: [],
  reviewTasks: [],
  screenRuns: [],
});

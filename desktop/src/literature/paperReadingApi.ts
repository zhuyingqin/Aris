import { invoke, listen } from "../api/transport";

export type PaperContentKind = "text" | "formula" | "figure" | "table";
export interface GuideEvidence {
  page: number;
  imageSha256: string | null;
  textSha256: string | null;
  textTruncated: boolean;
  derivedTextSha256?: string | null;
}
export interface GuideTask<T> {
  status: "pending" | "running" | "completed" | "failed";
  result: T | null;
  error: string | null;
  attemptLimit?: number;
  attempts: { sessionId: string; status: string; evidence: GuideEvidence[]; error: string | null }[];
}
export type TopicLevel = "foundation" | "core" | "advanced";
export interface GuideTopic {
  kind: "figure" | "formula" | "experiment" | "concept";
  /** Absent in guides saved before the layered protocol. */
  level?: TopicLevel;
  title: string;
  learningGoal: string;
  prerequisites?: string[];
  sourcePages: number[];
}
export interface GlossaryTerm { term: string; plain: string; sourcePages: number[] }
export interface GuideOutline {
  oneSentence?: string;
  overview: { kind: "problem" | "method" | "evidence" | "limitations"; content: string; sourcePages: number[] }[];
  glossary?: GlossaryTerm[];
  topics: GuideTopic[];
  cautions: string[];
  relevance?: string;
}
export interface GuideLesson {
  /** Layered fields; absent in guides saved before the layered protocol. */
  plainSummary?: string;
  analogy?: string;
  prerequisites?: { concept: string; explanation: string }[];
  misconceptions?: { misconception: string; correction: string }[];
  intuition: string;
  notation: string;
  assumptions: string;
  steps: { title: string; explanation: string; origin: "paper" | "teaching" }[];
  example: string | null;
  evidence: string;
  checkQuestion: string;
  checkAnswer: string;
  sourcePages: number[];
  cautions: string[];
}
export type ReviewVerdict = "pass" | "needs_revision" | "insufficient_evidence" | "unavailable";
export interface LessonReview {
  round: number;
  verdict: ReviewVerdict;
  summary: string;
  issues: { severity: "critical" | "major" | "minor"; location: string; problem: string; suggestion: string }[];
  reviewer: string | null;
  sessionId: string;
  reviewedAt: string;
}
export interface GuideLessonEntry {
  topic: GuideTopic;
  task: GuideTask<GuideLesson>;
  reviews?: LessonReview[];
  revision?: GuideTask<GuideLesson> | null;
}
export interface PaperGuide {
  protocolVersion: string;
  outline: GuideTask<GuideOutline>;
  lessons: GuideLessonEntry[];
  reviewRequired?: boolean;
  readerGoal?: string | null;
}

export type FollowUpMode = "simpler" | "example" | "why" | "question";
export interface PaperFollowUp {
  id: string;
  runId: string;
  /** "overview" or "lesson:<index>". */
  target: string;
  focus: string | null;
  mode: FollowUpMode;
  question: string;
  answer: string;
  model: string;
  sessionId: string;
  createdAt: string;
}
export interface PaperReadingVersion {
  id: string;
  model: string;
  language: string;
  status: PaperReadingView["run"]["status"];
  documentRevision: string;
  createdAt: string;
  updatedAt: string;
  resumable: boolean;
  active: boolean;
  lessonsTotal: number;
  lessonsReady: number;
  reviewStatus: string;
}
export interface PaperPerceptionItem {
  kind: PaperContentKind;
  content: string;
  uncertainties: string[];
}
export interface PaperPerceptionPage {
  pageIndex: number;
  status: "awaiting_source" | "not_required" | "pending" | "running" | "completed" | "failed";
  source: { documentRevision: string; pageIndex: number; imageSha256: string } | null;
  result: { pageIndex: number; items: PaperPerceptionItem[]; warnings: string[] } | null;
  attemptLimit?: number;
  attempts: { sessionId: string; status: string; error: string | null }[];
  error: string | null;
}
export interface PaperReadingView {
  projectId: string;
  active: boolean;
  /** False for versions saved by an earlier release: readable, not resumable. */
  resumable?: boolean;
  run: {
    id: string;
    revision: number;
    paperId: string;
    title: string;
    relativePath: string;
    documentRevision: string;
    totalPages: number;
    model: string;
    executorSignature: string;
    lastError: string | null;
    language: string;
    status: "preparing" | "running" | "partial" | "cancelled" | "page_processing_complete" | "guide_ready";
    pages: PaperPerceptionPage[];
    guide?: PaperGuide | null;
  };
  coverage: {
    pageProcessingCoverage: { completed: number; failed: number; total: number; notRequired?: number };
    identifiedContentCoverage: {
      inventoryVersion: number;
      candidatesByKind: Record<PaperContentKind, number>;
      understanding: "not_started" | "pending" | "draft_available";
      teaching: "not_started" | "pending" | "partial_drafts" | "drafts_ready";
      review: "not_requested" | "pending" | "partial" | "complete";
    };
    recognitionCompleteness: {
      status: "not_checked";
      checkedPages: number[];
      expectedItems: number | null;
      matchedItems: number | null;
    };
    reviewStatus: "not_reviewed" | "partially_reviewed" | "reviewed_with_findings" | "all_passed";
    reviewCounts?: { passed: number; needsRevision: number; insufficientEvidence: number; unavailable: number; pending: number };
  };
}

export const paperReadingGet = (projectId: string, paperId: string, relativePath: string) =>
  invoke<PaperReadingView | null>("paper_reading_get", { projectId, paperId, relativePath });

export const paperReadingPrepare = (input: {
  projectId: string; paperId: string; relativePath: string; documentRevision: string; language: string; model?: string; regenerate?: boolean; runId?: string;
}) => invoke<PaperReadingView>("paper_reading_prepare", { input });

export const paperReadingSource = (input: {
  projectId: string; runId: string; pageIndex: number; documentRevision: string;
  imageBase64: string; embeddedText: string; textTruncated: boolean;
}) => invoke<PaperReadingView>("paper_reading_source", { input });

export const paperReadingStart = (projectId: string, runId: string, transcribeAll?: boolean) =>
  invoke<PaperReadingView>(
    "paper_reading_start",
    transcribeAll ? { projectId, runId, transcribeAll } : { projectId, runId },
  );
export const paperReadingLoad = (projectId: string, runId: string) =>
  invoke<PaperReadingView>("paper_reading_load", { projectId, runId });
export const paperReadingList = (projectId: string, paperId: string) =>
  invoke<PaperReadingVersion[]>("paper_reading_list", { projectId, paperId });
export const paperReadingDelete = (projectId: string, runId: string) =>
  invoke<boolean>("paper_reading_delete", { projectId, runId });
export const paperReadingFollowUps = (projectId: string, runId: string) =>
  invoke<PaperFollowUp[]>("paper_reading_follow_ups", { projectId, runId });
export const paperReadingAsk = (input: {
  projectId: string; runId: string; target: string; mode: FollowUpMode; question?: string; focus?: string;
}) => invoke<PaperFollowUp>("paper_reading_ask", { input });
export const paperReadingCancel = (projectId: string, runId: string) =>
  invoke<PaperReadingView>("paper_reading_cancel", { projectId, runId });

export const onPaperReadingUpdated = (handler: (view: PaperReadingView) => void) =>
  listen<PaperReadingView>("paper-reading-updated", event => handler(event.payload));
export const onPaperReadingError = (
  handler: (event: { projectId: string; runId: string; message: string }) => void,
) => listen<{ projectId: string; runId: string; message: string }>(
  "paper-reading-error", event => handler(event.payload),
);

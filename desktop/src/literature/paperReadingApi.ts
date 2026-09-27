import { invoke, listen } from "../api/transport";

export type PaperContentKind = "text" | "formula" | "figure" | "table";
export interface GuideEvidence {
  page: number;
  imageSha256: string | null;
  textSha256: string | null;
  textTruncated: boolean;
}
export interface GuideTask<T> {
  status: "pending" | "running" | "completed" | "failed";
  result: T | null;
  error: string | null;
  attemptLimit?: number;
  attempts: { sessionId: string; status: string; evidence: GuideEvidence[]; error: string | null }[];
}
export interface GuideTopic {
  kind: "figure" | "formula" | "experiment" | "concept";
  title: string;
  learningGoal: string;
  sourcePages: number[];
}
export interface GuideOutline {
  overview: { kind: "problem" | "method" | "evidence" | "limitations"; content: string; sourcePages: number[] }[];
  topics: GuideTopic[];
  cautions: string[];
}
export interface GuideLesson {
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
export interface PaperGuide {
  protocolVersion: string;
  outline: GuideTask<GuideOutline>;
  lessons: { topic: GuideTopic; task: GuideTask<GuideLesson> }[];
}
export interface PaperPerceptionItem {
  kind: PaperContentKind;
  content: string;
  uncertainties: string[];
}
export interface PaperPerceptionPage {
  pageIndex: number;
  status: "awaiting_source" | "pending" | "running" | "completed" | "failed";
  source: { documentRevision: string; pageIndex: number; imageSha256: string } | null;
  result: { pageIndex: number; items: PaperPerceptionItem[]; warnings: string[] } | null;
  attemptLimit?: number;
  attempts: { sessionId: string; status: string; error: string | null }[];
  error: string | null;
}
export interface PaperReadingView {
  projectId: string;
  active: boolean;
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
    pageProcessingCoverage: { completed: number; failed: number; total: number };
    identifiedContentCoverage: {
      inventoryVersion: number;
      candidatesByKind: Record<PaperContentKind, number>;
      understanding: "not_started" | "pending" | "draft_available";
      teaching: "not_started" | "pending" | "partial_drafts" | "drafts_ready";
      review: "not_requested";
    };
    recognitionCompleteness: {
      status: "not_checked";
      checkedPages: number[];
      expectedItems: number | null;
      matchedItems: number | null;
    };
    reviewStatus: "not_reviewed";
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

export const paperReadingStart = (projectId: string, runId: string) =>
  invoke<PaperReadingView>("paper_reading_start", { projectId, runId });
export const paperReadingCancel = (projectId: string, runId: string) =>
  invoke<PaperReadingView>("paper_reading_cancel", { projectId, runId });

export const onPaperReadingUpdated = (handler: (view: PaperReadingView) => void) =>
  listen<PaperReadingView>("paper-reading-updated", event => handler(event.payload));
export const onPaperReadingError = (
  handler: (event: { projectId: string; runId: string; message: string }) => void,
) => listen<{ projectId: string; runId: string; message: string }>(
  "paper-reading-error", event => handler(event.payload),
);

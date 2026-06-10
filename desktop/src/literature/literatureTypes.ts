export type PaperFit = "high" | "medium" | "low";

export type PaperStage =
  | "candidate"
  | "screened"
  | "important"
  | "downloaded"
  | "reading"
  | "rejected";

export type PdfStatus = "none" | "queued" | "downloaded";

export type DetailTab = "metadata" | "reader" | "agent" | "evidence";

export interface LiteratureSearch {
  id: string;
  label: string;
  query: string;
  source: string;
  count: number;
}

export interface LiteratureCollection {
  id: string;
  label: string;
  kind: "library" | "collection" | "search" | "smart";
  count: number;
}

export interface EvidenceNote {
  id: string;
  page: number;
  quote: string;
  note: string;
}

export interface LiteraturePaper {
  id: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  doi: string;
  abstract: string;
  collectionIds: string[];
  tags: string[];
  fit: PaperFit;
  score: number;
  stage: PaperStage;
  pdfStatus: PdfStatus;
  source: string;
  addedAt: string;
  agentSummary: string;
  agentDecision: string;
  evidence: EvidenceNote[];
}

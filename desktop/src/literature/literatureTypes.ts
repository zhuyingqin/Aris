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

export type DetailTab = "metadata" | "agent" | "evidence";

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
}

/** One row returned by the `literature_search` Tauri command. */
export interface RemotePaper {
  id: string;
  title: string;
  authors: string[];
  year?: number | null;
  venue: string;
  doi?: string | null;
  arxivId?: string | null;
  abstract: string;
  url?: string | null;
  pdfUrl?: string | null;
  source: string;
  published?: string | null;
  citedBy?: number | null;
}

export interface LiteratureSearchResult {
  papers: RemotePaper[];
  warnings: string[];
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
});

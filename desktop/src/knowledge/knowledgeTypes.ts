// Shared shapes for the project knowledge base. The on-disk form is
// `papers/knowledge.db` (SQLite) inside the active project — split-ownership
// companion to `papers/library.json`: the library owns papers and raw reading,
// the knowledge base owns the confirmed knowledge graph.

export type KnowledgeStatus = "draft" | "confirmed" | "archived";

export interface KnowledgeEvidence {
  paperId: string;
  page?: number | null;
  quote: string;
  role?: string | null;
  annotationId?: string | null;
  evidenceId?: string | null;
}

export interface KnowledgeRelation {
  dstId: string;
  kind?: string | null;
  statement?: string | null;
}

/** A knowledge point keeps the original question and answer plus a condensed
 * statement (the statement is only for retrieval/display — it never replaces
 * the Q/A). Drafts are AI-proposed; only user-confirmed points are retrievable. */
export interface KnowledgePoint {
  id: string;
  question: string;
  answer: string;
  statement: string;
  kind?: string | null;
  status: KnowledgeStatus;
  sourcePaperId?: string | null;
  evidence: KnowledgeEvidence[];
  relations?: KnowledgeRelation[];
  createdAt?: string | null;
  confirmedAt?: string | null;
  version?: number;
}

export interface KnowledgeSearchHit extends KnowledgePoint {
  snippet: string;
  relations: KnowledgeRelation[];
}

export type KnowledgeFragmentKind = "evidence" | "answer-chain";

/** A raw knowledge fragment derived directly from the literature library.
 * Evidence snippets and evidence-backed reading answers remain owned by
 * `papers/library.json`; the knowledge UI only gathers them for review and
 * graph display. */
export interface KnowledgeFragment {
  id: string;
  kind: KnowledgeFragmentKind;
  paperId: string;
  paperTitle: string;
  page?: number | null;
  title: string;
  text: string;
  quote?: string | null;
  role?: string | null;
  source?: string | null;
  status?: string | null;
  evidenceIds?: string[];
}

/** A paper eligible for knowledge generation — drawn from library.json. */
export interface KnowledgeSourcePaper {
  id: string;
  title: string;
  stage: string;
  hasReading: boolean;
}

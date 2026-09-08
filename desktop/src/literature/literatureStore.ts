import { create } from "zustand";
import {
  isTauri,
  literatureApplyDelta,
  literatureDownloadPdf,
  literatureImportAttachment,
  literatureImportPdf,
  literatureLlm,
  literatureReviewLlm,
  literatureLlmVision,
  literatureLoad,
  literatureCreateItem,
  literatureLibraryModel,
  literaturePermanentlyDeleteItems,
  literaturePreferences,
  literatureRenameAttachments,
  literatureRestoreItems,
  literatureUpdateCollections,
  literatureUpdateItem,
  literatureUpdateRelations,
  literaturePdfOpen,
  onChatDone,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import { useStore, type Language } from "../store";
import { LITERATURE_COPY } from "./i18n";
import {
  emptyLibrary,
  type ActivityEntry,
  type ActivityLevel,
  type AnchorKind,
  type BriefSection,
  type EvidenceSource,
  type LiteratureLibrary,
  type LiteratureLibraryModelSnapshot,
  type LiteratureCollection,
  type LiteratureAttachment,
  type LiteraturePaper,
  type LiteratureLibraryCreator,
  type LiteratureNote,
  type LiteratureWorkflowGrade,
  type LiteratureReviewTask,
  type LiteratureLibraryItemRelation,
  type LiteratureMetadataPatch,
  type LiteratureCreatorInput,
  type LiteratureSearch,
  type LiteratureSearchCondition,
  type LiteratureScreenChunk,
  type LiteratureScreenRun,
  type PdfAnnotation,
  type PdfAnnotationRect,
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
  type PdfPageExtraction,
  type PdfPageImage,
} from "./pdfExtraction";
import { describeSearchConditions, normalizeSearchConditions } from "./advancedSearch";

const MAX_ACTIVITY_ENTRIES = 200;

const PERSIST_DELAY_MS = 600;
/** Mirrors paper-batch-grading's recommended 30-50 paper batches. */
export const SCREEN_CHUNK_SIZE = 40;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimerProjectId: string | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let persistedLibrary: LiteratureLibrary | null = null;
let persistedLibraryProjectId: string | null = null;
let loadGeneration = 0;
let relationPersistQueue: Promise<void> = Promise.resolve();

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
const WORKFLOW_GRADE_LEVELS = new Set(["A", "B", "C", "D"]);
const LEGACY_PRIMARY_PDF_ATTACHMENT_ID = "attachment-primary-pdf";

const scopedPrimaryPdfAttachmentId = (paperId: string) =>
  `${LEGACY_PRIMARY_PDF_ATTACHMENT_ID}:${paperId}`;

const normalizeWorkflowGrades = (value: unknown): LiteratureWorkflowGrade[] => (
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const grade = candidate as Partial<LiteratureWorkflowGrade>;
        if (
          typeof grade.workflowRunId !== "string"
          || !grade.workflowRunId.trim()
          || !WORKFLOW_GRADE_LEVELS.has(grade.grade ?? "")
        ) return [];
        return [{
          workflowRunId: grade.workflowRunId,
          workflowTitle: typeof grade.workflowTitle === "string" && grade.workflowTitle.trim()
            ? grade.workflowTitle
            : grade.workflowRunId,
          grade: grade.grade as LiteratureWorkflowGrade["grade"],
          originalIndex: Number.isFinite(grade.originalIndex) ? Number(grade.originalIndex) : 0,
          keyFinding: typeof grade.keyFinding === "string" ? grade.keyFinding : "",
          rationale: typeof grade.rationale === "string" ? grade.rationale : "",
          method: typeof grade.method === "string" ? grade.method : "",
          gradedAt: typeof grade.gradedAt === "string" ? grade.gradedAt : "",
        }];
      })
    : []
);

const normalizeCreators = (value: unknown): LiteratureLibraryCreator[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index): LiteratureLibraryCreator[] => {
    if (typeof raw === "string") {
      const name = raw.trim();
      return name
        ? [{
            id: `creator:legacy:${index}`,
            creatorType: "author",
            name,
            fieldMode: "oneField",
            orderIndex: index,
          }]
        : [];
    }
    if (!raw || typeof raw !== "object") return [];
    const creator = raw as Partial<LiteratureLibraryCreator>;
    const firstName = typeof creator.firstName === "string" && creator.firstName.trim()
      ? creator.firstName.trim()
      : undefined;
    const lastName = typeof creator.lastName === "string" && creator.lastName.trim()
      ? creator.lastName.trim()
      : undefined;
    const name = typeof creator.name === "string" && creator.name.trim()
      ? creator.name.trim()
      : undefined;
    if (!firstName && !lastName && !name) return [];
    const fieldMode = creator.fieldMode === "twoField" || firstName || lastName
      ? "twoField"
      : "oneField";
    return [{
      id: typeof creator.id === "string" && creator.id.trim()
        ? creator.id
        : `creator:legacy:${index}`,
      creatorType: typeof creator.creatorType === "string" && creator.creatorType.trim()
        ? creator.creatorType.trim()
        : "author",
      firstName,
      lastName,
      name,
      fieldMode,
      orderIndex: Number.isFinite(creator.orderIndex) ? Number(creator.orderIndex) : index,
    }];
  });
};

const normalizeMetadataFields = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "string") {
      if (rawValue.trim()) fields[key] = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      fields[key] = String(rawValue);
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
};

/** Imported rectangle coordinates are only renderable when they are already
 * normalized to the page. Keep the original Zotero position object separately
 * so provider-specific coordinates remain lossless without allowing malformed
 * values to create an off-page overlay. */
const normalizeAnnotationRects = (value: unknown): PdfAnnotationRect[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const rects = value.flatMap((raw): PdfAnnotationRect[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = raw as Record<string, unknown>;
    const number = (key: string) => {
      const value = candidate[key];
      return typeof value === "number" ? value : Number(value);
    };
    const left = number("left");
    const top = number("top");
    const width = number("width");
    const height = number("height");
    if (![left, top, width, height].every(Number.isFinite)) return [];
    if (left < 0 || top < 0 || left >= 1 || top >= 1 || width <= 0 || height <= 0) return [];
    return [{
      left,
      top,
      width: Math.min(width, 1 - left),
      height: Math.min(height, 1 - top),
    }];
  });
  return rects.length > 0 ? rects : undefined;
};

const remapLegacyAttachmentReference = <T extends object>(
  entry: T,
  primaryAttachmentId: string,
): T => {
  const attachmentId = (entry as { attachmentId?: unknown }).attachmentId;
  return attachmentId === LEGACY_PRIMARY_PDF_ATTACHMENT_ID
    ? { ...entry, attachmentId: primaryAttachmentId } as T
    : entry;
};

const normalizePaper = (paper: Partial<LiteraturePaper>, index: number): LiteraturePaper => {
  const paperId = typeof paper.id === "string" && paper.id.trim() ? paper.id.trim() : `paper:${index}`;
  const primaryAttachmentId = scopedPrimaryPdfAttachmentId(paperId);
  const pdf = paper.pdf && typeof paper.pdf === "object" ? paper.pdf : { status: "none" as const };
  const normalizedPdf = remapLegacyAttachmentReference(pdf, primaryAttachmentId);
  const creators = Array.isArray(paper.creators) ? normalizeCreators(paper.creators) : undefined;
  const metadataFields = normalizeMetadataFields(paper.metadataFields);
  const attachmentCandidates = Array.isArray(paper.attachments)
    ? paper.attachments.filter(
        (attachment): attachment is LiteratureAttachment =>
          Boolean(attachment)
          && typeof attachment.id === "string"
          && typeof attachment.label === "string"
          && ["pdf", "supplement", "webSnapshot", "externalLink"].includes(attachment.kind),
      )
    : [];
  const normalizedAttachmentCandidates = attachmentCandidates.map((attachment) => attachment.id === LEGACY_PRIMARY_PDF_ATTACHMENT_ID
    ? { ...attachment, id: primaryAttachmentId }
    : attachment);
  const hasPrimaryPdf = normalizedAttachmentCandidates.some(
    (attachment) => attachment.kind === "pdf" && attachment.path === normalizedPdf.path,
  );
  const attachments = !hasPrimaryPdf && typeof normalizedPdf.path === "string" && normalizedPdf.path
    ? [
        {
          id: primaryAttachmentId,
          label: "Primary PDF",
          kind: "pdf" as const,
          path: normalizedPdf.path,
          bytes: normalizedPdf.bytes,
          addedAt: typeof paper.addedAt === "string" ? paper.addedAt : isoNow(),
        },
        ...normalizedAttachmentCandidates,
      ]
    : normalizedAttachmentCandidates;
  return {
    ...paper,
    id: paperId,
    title: typeof paper.title === "string" && paper.title.trim() ? paper.title : "Untitled paper",
    authors: Array.isArray(paper.authors) ? paper.authors.filter((value) => typeof value === "string") : [],
    creators,
    metadataFields,
    venue: typeof paper.venue === "string" ? paper.venue : "",
    date: typeof paper.date === "string" ? paper.date : undefined,
    rating: Number.isFinite(paper.rating)
      ? Math.min(5, Math.max(1, Math.round(Number(paper.rating))))
      : undefined,
    readAt: typeof paper.readAt === "string" ? paper.readAt : undefined,
    volume: typeof paper.volume === "string" ? paper.volume : undefined,
    issue: typeof paper.issue === "string" ? paper.issue : undefined,
    pages: typeof paper.pages === "string" ? paper.pages : undefined,
    publisher: typeof paper.publisher === "string" ? paper.publisher : undefined,
    place: typeof paper.place === "string" ? paper.place : undefined,
    edition: typeof paper.edition === "string" ? paper.edition : undefined,
    series: typeof paper.series === "string" ? paper.series : undefined,
    language: typeof paper.language === "string" ? paper.language : undefined,
    accessed: typeof paper.accessed === "string" ? paper.accessed : undefined,
    abstract: typeof paper.abstract === "string" ? paper.abstract : "",
    tags: Array.isArray(paper.tags) ? paper.tags.filter((value) => typeof value === "string") : [],
    collectionIds: Array.isArray(paper.collectionIds)
      ? paper.collectionIds.filter((value) => typeof value === "string")
      : [],
    relations: Array.isArray(paper.relations)
      ? paper.relations.filter(
          (relation): relation is LiteratureLibraryItemRelation =>
            Boolean(relation)
            && typeof relation.id === "string"
            && typeof relation.sourceItemId === "string"
            && typeof relation.predicate === "string"
            && typeof relation.target === "string"
            && typeof relation.targetKind === "string",
        )
      : [],
    searchIds: Array.isArray(paper.searchIds)
      ? paper.searchIds.filter((value) => typeof value === "string")
      : [],
    workflowGrades: normalizeWorkflowGrades(paper.workflowGrades),
    stage: PAPER_STAGES.has(paper.stage as PaperStage) ? paper.stage as PaperStage : "inbox",
    starred: paper.starred === true,
    unread: paper.unread !== false,
    source: typeof paper.source === "string" ? paper.source : "",
    addedAt: typeof paper.addedAt === "string" ? paper.addedAt : isoNow(),
    pdf: {
      ...normalizedPdf,
      status: PDF_STATUSES.has(normalizedPdf.status) ? normalizedPdf.status : "none",
    },
    attachments,
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
    pdfAnnotations: Array.isArray(paper.pdfAnnotations)
      ? paper.pdfAnnotations.map((annotation) => remapLegacyAttachmentReference(annotation, primaryAttachmentId))
      : [],
    notes: Array.isArray(paper.notes)
      ? paper.notes.filter(
          (note): note is LiteratureNote =>
            Boolean(note)
            && typeof note.id === "string"
            && typeof note.content === "string",
        ).map((note) => remapLegacyAttachmentReference(note, primaryAttachmentId))
      : [],
  };
};

const normalizeLibrary = (raw: Partial<LiteratureLibrary>): LiteratureLibrary => ({
  version: 1,
  papers: Array.isArray(raw.papers) ? raw.papers.map(normalizePaper) : [],
  trash: Array.isArray(raw.trash) ? raw.trash.map(normalizePaper) : [],
  searches: Array.isArray(raw.searches)
    ? raw.searches.map((search) => ({
        ...search,
        query: String(search.query || search.id || "Saved search"),
        sources: Array.isArray(search.sources) ? search.sources : [],
        resultCount: Number(search.resultCount) || 0,
        newCount: Number(search.newCount) || 0,
        conditions: Array.isArray(search.conditions) ? search.conditions : [],
      }))
    : [],
  hiddenSearchRunIds: Array.isArray(raw.hiddenSearchRunIds)
    ? raw.hiddenSearchRunIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [],
  collections: Array.isArray(raw.collections) ? raw.collections : [],
  reviewTasks: Array.isArray(raw.reviewTasks)
    ? raw.reviewTasks.map((task) => ({
        ...task,
        criteria: Array.isArray(task.criteria) ? task.criteria : [],
        searchIds: Array.isArray(task.searchIds) ? task.searchIds : [],
        suggestions: Array.isArray(task.suggestions) ? task.suggestions : [],
      }))
    : [],
  screenRuns: Array.isArray(raw.screenRuns)
    ? raw.screenRuns.map((run) => ({
        ...run,
        chunks: Array.isArray(run.chunks) ? run.chunks : [],
        reviewerCount: Number(run.reviewerCount) || 0,
        fallbackCount: Number(run.fallbackCount) || 0,
      }))
    : [],
  projectFocus: raw.projectFocus,
});

/**
 * The normalized SQLite model is deliberately kept as a separate read model
 * from the legacy paper projection.  Keeping a tolerant normalizer here lets
 * older projects (and the browser preview) continue to render while the
 * Zotero-shaped item tree is hydrated when the Desktop command is available.
 */
const normalizeLibraryModel = (
  raw: Partial<LiteratureLibraryModelSnapshot> | null | undefined,
): LiteratureLibraryModelSnapshot | null => {
  if (!raw || typeof raw !== "object") return null;
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    collections: Array.isArray(raw.collections) ? raw.collections : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    savedSearches: Array.isArray(raw.savedSearches) ? raw.savedSearches : [],
    specialCollections: Array.isArray(raw.specialCollections) ? raw.specialCollections : [],
  };
};

const sameJson = (left: unknown, right: unknown) => (
  left === right || JSON.stringify(left) === JSON.stringify(right)
);

const SEARCH_RUN_SAVED_SEARCH_PREFIX = "search-run:";

/** The SearchRun a saved search stands for. `hiddenSearchRunIds` is the only
 * tombstone the projection honours for run-derived searches, so a saved search
 * that mirrors a run must always resolve to one — including older projections
 * that identified the run through the entry id alone. Without this, deleting
 * such a search wrote no tombstone and the surviving run re-created it on the
 * next load, so the delete button did nothing. */
export const savedSearchRunId = (search: LiteratureSearch): string | null => {
  const explicit = search.searchRunId?.trim();
  if (explicit) return explicit;
  const id = search.id.trim();
  const derived = id.startsWith(SEARCH_RUN_SAVED_SEARCH_PREFIX)
    ? id.slice(SEARCH_RUN_SAVED_SEARCH_PREFIX.length).trim()
    : "";
  return derived || null;
};

const userOwnedSearches = (library: LiteratureLibrary) =>
  library.searches.filter((search) => savedSearchRunId(search) === null);

const projectionMetadata = (library: LiteratureLibrary) => {
  const {
    papers: _papers,
    trash: _trash,
    searches: _searches,
    version: _version,
    ...metadata
  } = library;
  return {
    ...metadata,
    // Search runs are regenerated from the canonical store. Only user-owned
    // saved searches belong in mutable projection metadata.
    searches: userOwnedSearches(library),
  };
};

const sameProjectionMetadata = (before: LiteratureLibrary, after: LiteratureLibrary) => {
  const ignored = new Set(["papers", "trash", "searches", "version"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (!sameJson(before[key as keyof LiteratureLibrary], after[key as keyof LiteratureLibrary])) {
      return false;
    }
  }
  const beforeSearches = userOwnedSearches(before);
  const afterSearches = userOwnedSearches(after);
  return beforeSearches.length === afterSearches.length
    && beforeSearches.every((search, index) => sameJson(search, afterSearches[index]));
};

/** Return a collection and every nested child.  This keeps deletion and
 * filtering correct for arbitrarily deep Zotero-style collection trees. */
const descendantCollectionIds = (collections: LiteratureCollection[], rootId: string) => {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections) {
      if (collection.parentId && ids.has(collection.parentId) && !ids.has(collection.id)) {
        ids.add(collection.id);
        changed = true;
      }
    }
  }
  return ids;
};

const libraryDelta = (before: LiteratureLibrary, after: LiteratureLibrary) => {
  const beforePapers = new Map(before.papers.map((paper) => [paper.id, paper]));
  const afterIds = new Set(after.papers.map((paper) => paper.id));
  const upsertPapers = after.papers.filter((paper) => !sameJson(beforePapers.get(paper.id), paper));
  const hidePaperIds = before.papers
    .filter((paper) => !afterIds.has(paper.id))
    .map((paper) => paper.id);
  return {
    upsertPapers,
    hidePaperIds,
    ...(!sameProjectionMetadata(before, after)
      ? { projectionMetadata: projectionMetadata(after) }
      : {}),
  };
};

/** Keep unchanged paper object identities when rebasing after a full backend
 * projection. This makes the next delta compare O(changed papers) instead of
 * serializing every paper again after each successful save. */
const rebasePersistedProjection = (
  projection: Partial<LiteratureLibrary>,
  changedPaperIds: readonly string[] = [],
) => {
  const normalized = normalizeLibrary(projection);
  if (!persistedLibrary) return normalized;
  const changed = new Set(changedPaperIds);
  const previousById = new Map(persistedLibrary.papers.map((paper) => [paper.id, paper]));
  return {
    ...normalized,
    papers: normalized.papers.map((paper) => (
      changed.has(paper.id) ? paper : previousById.get(paper.id) ?? paper
    )),
  };
};

const isEmptyDelta = (delta: ReturnType<typeof libraryDelta>) =>
  delta.upsertPapers.length === 0 &&
  delta.hidePaperIds.length === 0 &&
  !("projectionMetadata" in delta);

export interface SavedSearchRemovalImpact {
  linkedPaperIds: string[];
  removablePaperIds: string[];
  sharedPaperIds: string[];
}


/** Papers reached only through the search being removed can leave the visible
 * library with it. Papers that also belong to another visible search stay in
 * place, so deleting one SearchRun never damages another result set. */
export function savedSearchRemovalImpact(
  library: LiteratureLibrary,
  searchId: string,
): SavedSearchRemovalImpact {
  const id = searchId.trim();
  if (!id || !library.searches.some((search) => search.id === id)) {
    return { linkedPaperIds: [], removablePaperIds: [], sharedPaperIds: [] };
  }
  const otherSearchIds = new Set(
    library.searches.filter((search) => search.id !== id).map((search) => search.id),
  );
  const linked = library.papers.filter((paper) => paper.searchIds.includes(id));
  const shared = linked.filter((paper) => paper.searchIds.some((candidate) => otherSearchIds.has(candidate)));
  const sharedIds = new Set(shared.map((paper) => paper.id));
  return {
    linkedPaperIds: linked.map((paper) => paper.id),
    removablePaperIds: linked.filter((paper) => !sharedIds.has(paper.id)).map((paper) => paper.id),
    sharedPaperIds: shared.map((paper) => paper.id),
  };
}

const normalizedTitle = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]/g, "");

const validCitationKey = (value: string | undefined): string | null => {
  const key = value?.trim() ?? "";
  return /^[A-Za-z][A-Za-z0-9:_.-]*$/.test(key) ? key : null;
};

/** Validate user-entered keys at edit time instead of silently repairing them
 * only when a Typeset citation is inserted. `language` defaults to the store's
 * current UI language so call sites without a React hook at hand (Zustand
 * actions) don't need to thread it through explicitly. */
export const citationKeyValidationError = (
  value: string | undefined,
  paperId: string,
  papers: LiteraturePaper[],
  language: Language = useStore.getState().language,
): string | null => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const copy = LITERATURE_COPY[language].store;
  if (!validCitationKey(trimmed)) {
    return copy.citationKeyInvalid;
  }
  const duplicate = papers.find(
    (paper) => paper.id !== paperId && validCitationKey(paper.citationKey)?.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  return duplicate ? copy.citationKeyDuplicate(duplicate.title) : null;
};

const citationKeyPart = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** A deterministic fallback used only when a record has no user-supplied key. */
export const suggestedCitationKey = (paper: LiteraturePaper): string => {
  const firstAuthor = paper.authors[0] ?? "reference";
  const family = firstAuthor.includes(",")
    ? firstAuthor.split(",", 1)[0]
    : firstAuthor.split(/\s+/).filter(Boolean).at(-1) ?? "reference";
  const titleWord = paper.title
    .split(/\s+/)
    .map(citationKeyPart)
    .find((word) => word.length > 2) ?? "work";
  return `${citationKeyPart(family) || "ref"}${paper.year ?? "nd"}${titleWord}`;
};

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

const scoreToFit = (score: number): PaperFit => {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
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
  checkpoint?: Pick<PaperScreening, "screenRunId" | "chunkId">,
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
    method: "heuristic",
    ...checkpoint,
  };
};

const screeningToVerdict = (screening: PaperScreening) => ({
  fit: scoreToFit(screening.score),
  score: screening.score,
  rationale: screening.reasons[0]?.note ?? "Screened against the active criteria.",
  decidedAt: screening.decidedAt,
});

// ── Legacy abstract Brief helper ─────────────────────────────────────────────
// Retained only for compatibility tests and old records. Production Brief
// generation below requires a complete, non-truncated PDF extraction.

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

interface LlmScreenBatchResult {
  screenings: Map<string, PaperScreening>;
  missingIndices: number[];
}

const verifiedScreenQuote = (paper: LiteraturePaper, value: unknown) => {
  const quote = String(value ?? "").trim();
  if (!quote) return firstUsefulQuote(paper);
  const normalizedQuote = quote.normalize("NFKC").replace(/\s+/g, " ").trim();
  const normalizedAbstract = paper.abstract.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalizedQuote.length >= 8 && normalizedAbstract.includes(normalizedQuote)
    ? quote
    : firstUsefulQuote(paper);
};

const llmScreen = async (
  papers: LiteraturePaper[],
  task: LiteratureReviewTask,
  checkpoint: Pick<PaperScreening, "screenRunId" | "chunkId">,
): Promise<LlmScreenBatchResult> => {
  const parsed = await literatureReviewLlmJson(SCREEN_SYSTEM, buildScreenPrompt(papers, task));
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of screenings");
  const result = new Map<string, PaperScreening>();
  const seenIndices = new Set<number>();
  const issueIndices = new Set<number>();
  for (const row of parsed as Array<Record<string, unknown>>) {
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0 || index >= papers.length) {
      if (Number.isFinite(index)) issueIndices.add(index);
      continue;
    }
    if (seenIndices.has(index)) {
      issueIndices.add(index);
      continue;
    }
    seenIndices.add(index);
    const paper = papers[index];
    const quote = verifiedScreenQuote(paper, row.quote);
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
      method: "review-llm",
      ...checkpoint,
    });
  }
  papers.forEach((_, index) => {
    if (!seenIndices.has(index)) issueIndices.add(index);
  });
  return {
    screenings: result,
    missingIndices: Array.from(issueIndices).sort((left, right) => left - right),
  };
};

/** AI-generated note/summary language follows the UI language toggle — a
 * confirmed product decision, not something to second-guess. Every prompt
 * below that instructs the model to write in a specific language reads this
 * instead of hardcoding Chinese. */
const outputLanguageName = (language: Language) => (language === "cn" ? "Chinese" : "English");

const BRIEF_SYSTEM = (language: Language) =>
  `You are a precise research reading assistant. Produce a structured brief based only on the complete extracted full text supplied by the user. Every claim must cite the page that supports it. Be concrete and include numbers from the paper in Results. Write all section values in ${outputLanguageName(language)}. Respond with a single JSON object and nothing else.`;

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
  language: Language,
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
All values must be written in ${outputLanguageName(language)}.`;
};

const llmBrief = async (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  extraction: PdfExtraction,
  language: Language,
): Promise<PaperBrief> => {
  const parsed = await literatureLlmJson(
    BRIEF_SYSTEM(language),
    buildBriefPrompt(paper, focus, extraction.text, language),
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

const VISUAL_EVIDENCE_SYSTEM = (language: Language) =>
  `You are a rigorous visual paper reader. Read every supplied PDF page image directly, including figures, tables, formulas, captions, and body text. Extract only evidence visibly supported by those images. Write every evidence explanation in ${outputLanguageName(language)} while preserving quotes as faithful visible transcriptions in their source language. Return a JSON array and nothing else.`;

const TEXT_EVIDENCE_SYSTEM = (language: Language) =>
  `You are a rigorous paper reader. Read the supplied extracted PDF page text directly. Extract only evidence explicitly present in that text. Write every evidence explanation in ${outputLanguageName(language)} while preserving quotes as faithful verbatim excerpts in their source language. Return a JSON array and nothing else.`;

const ANSWER_CHAIN_SYSTEM = (language: Language) =>
  `You build question-to-final-answer chains only from evidence previously read directly from the PDF (extracted page text and/or rendered page images). Write every question and final answer in ${outputLanguageName(language)}. Return a JSON array and nothing else.`;

/** Role label + note, in the language the AI output is being written in
 * (follows the UI language toggle, not hardcoded). */
const roleNote = (role: string, note: string, language: Language) => {
  const labels = LITERATURE_COPY[language].evidenceRole as Record<string, string>;
  const label = labels[role] ?? role;
  return language === "cn" ? `${label}：${note}` : `${label}: ${note}`;
};

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

/** One evidence item read either from extracted page text (cheap) or a
 * rendered page image (vision model, reserved for pages a text pass can't
 * cover — figures, tables, dense math, or scanned/OCR pages). */
type PageEvidence = LiteraturePaper["evidence"][number] & {
  source: EvidenceSource;
  imageFingerprint?: string;
};

const imageBatches = (pages: PdfPageImage[], size = 4) => {
  const batches: PdfPageImage[][] = [];
  for (let offset = 0; offset < pages.length; offset += size) {
    batches.push(pages.slice(offset, offset + size));
  }
  return batches;
};

// Text is far cheaper than page images, so batches are sized by a character
// budget instead of a fixed page count: a run of sparse pages fills one
// call, a run of dense pages splits into more.
const TEXT_EVIDENCE_BATCH_CHARS = 12_000;

const textPageBatches = (pages: PdfPageExtraction[], maxChars = TEXT_EVIDENCE_BATCH_CHARS) => {
  const batches: PdfPageExtraction[][] = [];
  let current: PdfPageExtraction[] = [];
  let currentChars = 0;
  for (const page of pages) {
    if (current.length > 0 && currentChars + page.text.length > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(page);
    currentChars += page.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

// A page is worth reading as text only when extraction actually found a real
// paragraph on it. Below the absolute floor, or well below the paper's own
// median page (a run of dense pages makes a sparse one stand out as
// caption-only), the page likely carries its content visually — a figure,
// table, or formula block — so it goes to the vision model instead, along
// with anything OCR/embedded extraction failed on outright.
const TEXT_EVIDENCE_MIN_CHARS = 200;
const TEXT_EVIDENCE_RELATIVE_RATIO = 0.35;

const classifyEvidencePages = (
  pages: PdfPageExtraction[],
): { textPages: PdfPageExtraction[]; visualPageNumbers: number[] } => {
  const embeddedLengths = pages
    .filter((page) => page.source === "embedded")
    .map((page) => page.text.length)
    .sort((a, b) => a - b);
  const median = embeddedLengths.length > 0
    ? embeddedLengths[Math.floor(embeddedLengths.length / 2)]
    : 0;
  const relativeFloor = median * TEXT_EVIDENCE_RELATIVE_RATIO;
  const textPages: PdfPageExtraction[] = [];
  const visualPageNumbers: number[] = [];
  for (const page of pages) {
    const isTextPage =
      page.source === "embedded"
      && page.text.length >= TEXT_EVIDENCE_MIN_CHARS
      && page.text.length >= relativeFloor;
    if (isTextPage) textPages.push(page);
    else visualPageNumbers.push(page.page);
  }
  return { textPages, visualPageNumbers };
};

const spreadLimit = <T,>(values: T[], limit: number) => {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) =>
    values[Math.floor(index * values.length / limit)],
  );
};

// Applied once on the combined text+vision evidence list, not per-source —
// otherwise two 24-item caps could double the evidence handed to the answer
// chain synthesis step below.
const dedupeAndLimit = (evidence: PageEvidence[], limit: number): PageEvidence[] => {
  const deduped = evidence.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.page === item.page
          && normalizeAnchorText(candidate.quote) === normalizeAnchorText(item.quote),
      ) === index,
  );
  return spreadLimit(deduped, limit);
};

const llmTextEvidence = async (
  paper: LiteraturePaper,
  question: string,
  pages: PdfPageExtraction[],
  language: Language,
): Promise<PageEvidence[]> => {
  const evidence: PageEvidence[] = [];
  for (const batch of textPageBatches(pages)) {
    const allowed = new Map(batch.map((page) => [page.page, normalizeAnchorText(page.text)]));
    const parsed = await literatureLlmJson(
      TEXT_EVIDENCE_SYSTEM(language),
      `Paper: ${paper.title}
Research question: ${question || "(identify the paper's most important claims and findings)"}

${batch.map((page) => `[[PAGE ${page.page}]]\n${page.text}`).join("\n\n")}

Read the page text above. Return up to 6 high-value evidence items from these pages:
[{"page": 1, "quote": "short faithful verbatim excerpt copied from that page", "note": "why this evidence matters", "role": "premise|method|result|limitation"}]
The page must be one of the pages shown above, and the quote must be copied verbatim from that page's text. Do not infer content that is not present in the text.
Write every note in ${outputLanguageName(language)}. Preserve each quote as a faithful verbatim excerpt in the source language. Keep role as one of premise|method|result|limitation.`,
    ) as unknown;
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of text evidence");
    for (const item of parsed as Array<Record<string, unknown>>) {
      const page = Number(item.page);
      const quote = String(item.quote ?? "").trim();
      const note = String(item.note ?? "").trim();
      const role = String(item.role ?? "evidence").trim() || "evidence";
      const pageText = allowed.get(page);
      const normalizedQuote = normalizeAnchorText(quote);
      if (!Number.isInteger(page) || !pageText || normalizedQuote.length < 8 || !note) continue;
      if (!pageText.includes(normalizedQuote)) continue;
      evidence.push({
        id: makeId("evidence"),
        page,
        quote: quote.slice(0, 360),
        note: roleNote(role, note, language),
        source: "text",
      });
    }
  }
  return evidence;
};

const llmVisualEvidence = async (
  paper: LiteraturePaper,
  question: string,
  pages: PdfPageImage[],
  language: Language,
): Promise<PageEvidence[]> => {
  const evidence: PageEvidence[] = [];
  for (const batch of imageBatches(pages)) {
    const allowed = new Map(batch.map((page) => [page.page, page]));
    const parsed = await literatureVisionLlmJson(
      VISUAL_EVIDENCE_SYSTEM(language),
      `Paper: ${paper.title}
Research question: ${question || "(identify the paper's most important claims and findings)"}
Pages in this batch: ${batch.map((page) => page.page).join(", ")}

Read every attached page image. Return up to 6 high-value evidence items from this batch:
[{"page": 1, "quote": "short faithful transcription or exact visible figure/table value", "note": "why this visually observed evidence matters", "role": "premise|method|result|limitation"}]
The page must be one of the supplied page images. Do not infer content that is not visible.
Write every note in ${outputLanguageName(language)}. Preserve each quote as a faithful transcription in the source language visible on the page. Transcribe mathematical expressions as LaTeX wrapped in $...$ or $$...$$ instead of flattening them into plain Unicode text. Keep role as one of premise|method|result|limitation.`,
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
        note: roleNote(role, note, language),
        source: "vision",
        imageFingerprint: pageImage.fingerprint,
      });
    }
  }
  return evidence;
};

const llmAnswerChainsFromEvidence = async (
  paper: LiteraturePaper,
  focus: ProjectFocus | undefined,
  evidence: PageEvidence[],
  language: Language,
): Promise<{ chains: ReadingAnswerChain[]; annotations: PdfAnnotation[] }> => {
  const evidencePayload = evidence.map((item) => ({
    id: item.id,
    page: item.page,
    quote: item.quote,
    note: item.note,
    imageFingerprint: item.imageFingerprint,
  }));
  const parsed = await literatureLlmJson(
    ANSWER_CHAIN_SYSTEM(language),
    `Paper: ${paper.title}
Research focus: ${focus?.question?.trim() || "(generate the most important paper-reading questions)"}

Evidence read from the PDF (text extraction and/or page images):
${JSON.stringify(evidencePayload)}

Generate 3-4 critical questions and final answers. Use only the supplied evidence.
Return ONLY:
[{"question": "...", "answer": "...", "supports": [{"evidenceId": "evidence-id", "role": "premise|method|result|limitation"}]}]
Each answer requires at least one support and may use at most 3 supports.
All question and answer values must be written in ${outputLanguageName(language)}. Keep support role as one of premise|method|result|limitation.`,
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
    let sawVisionSupport = false;
    const supports = row.supports
      .map((support) => support as Record<string, unknown>)
      .map((support) => {
        const evidenceId = String(support.evidenceId ?? "").trim();
        const role = String(support.role ?? "support").trim() || "support";
        const source = evidenceById.get(evidenceId);
        if (!source) return null;
        if (source.source === "vision") sawVisionSupport = true;
        const annotation: PdfAnnotation = {
          id: makeId("annotation"),
          page: source.page,
          quote: source.quote,
          note: roleNote(role, answer, language),
          kind: "answer-support",
          source: source.source,
          imageFingerprint: source.imageFingerprint,
          sourceId: chainId,
          evidenceId: source.id,
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
      basis: sawVisionSupport ? "vision" : "text",
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

/** Static fixture for the plain-browser preview (no Tauri backend). The two
 * demo answer-chain/evidence strings follow the current UI language rather
 * than being hardcoded. */
const previewLiteratureLibrary = (): LiteratureLibrary => {
  const demo = LITERATURE_COPY[useStore.getState().language].preview;
  return {
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
          note: demo.evidenceNote,
        },
      ],
      answerChains: [
        {
          id: "chain-preview",
          question: demo.chainQuestion,
          answer: demo.chainAnswer,
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
          note: demo.evidenceNote,
          kind: "evidence",
          sourceId: "ev-1",
          createdAt: "2026-06-09T08:15:00.000Z",
        },
        {
          id: "annotation-answer-preview",
          page: 3,
          quote: "Screening decisions are recorded before full-text extraction.",
          note: demo.answerSupportNote,
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
  screenRuns: [],
  };
};

interface LiteratureState {
  library: LiteratureLibrary;
  /** Canonical Zotero-shaped item graph used by the Desktop hierarchy UI. */
  libraryModel: LiteratureLibraryModelSnapshot | null;
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
  screenPapersForTask: (taskId: string, paperIds?: string[]) => Promise<void>;
  setStage: (ids: string[], stage: PaperStage) => void;
  deletePapers: (ids: string[]) => void;
  restorePapers: (ids: string[]) => Promise<void>;
  permanentlyDeletePapers: (ids: string[]) => Promise<void>;
  toggleStar: (id: string) => void;
  markRead: (id: string) => void;
  toggleRead: (id: string) => void;
  setRating: (id: string, rating: number) => void;
  addTags: (ids: string[], tags: string[]) => Promise<void>;
  setTagColor: (id: string, tag: string, color: string) => Promise<void>;
  updatePaperRelations: (id: string, relations: LiteratureLibraryItemRelation[]) => void;
  createManualItem: (input: {
    title: string;
    itemType?: string;
    authors?: string[];
  }) => Promise<string | null>;
  updatePaperMetadata: (
    id: string,
    patch: LiteratureMetadataPatch,
  ) => void;
  /** Assign valid, collision-free keys and wait until SQLite has the change. */
  ensureCitationKeys: (ids: string[]) => Promise<Record<string, string>>;
  saveDynamicSearch: (
    query: string,
    conditions?: LiteratureSearchCondition[],
    name?: string,
    existingId?: string,
  ) => string | null;
  removeSavedSearch: (id: string, options?: { deleteRelatedPapers?: boolean }) => void;
  addCollection: (label: string, parentId?: string) => void;
  renameCollection: (id: string, label: string) => void;
  removeCollection: (id: string) => void;
  assignToCollection: (
    paperIds: string[],
    collectionId: string,
    options?: { move?: boolean; sourceCollectionId?: string },
  ) => Promise<void>;
  removeFromCollection: (paperIds: string[], collectionId: string) => Promise<void>;
  toggleCollection: (paperId: string, collectionId: string) => Promise<void>;
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
    patch: Partial<Pick<PdfAnnotation, "quote" | "note" | "kind" | "color" | "style">>,
  ) => void;
  deletePdfAnnotation: (paperId: string, annotationId: string) => void;
  addAttachment: (
    paperId: string,
    attachment: Omit<LiteratureAttachment, "id" | "addedAt"> & Partial<Pick<LiteratureAttachment, "id" | "addedAt">>,
  ) => string | null;
  removeAttachment: (paperId: string, attachmentId: string) => void;
  setPrimaryPdfAttachment: (paperId: string, attachmentId: string) => void;
  importAttachment: (
    paperId: string,
    sourcePath: string,
    kind: Exclude<LiteratureAttachment["kind"], "externalLink">,
  ) => Promise<void>;
  relinkAttachment: (paperId: string, attachmentId: string, sourcePath: string) => Promise<void>;
  addNote: (
    paperId: string,
    note: Omit<LiteratureNote, "id" | "createdAt" | "updatedAt"> & Partial<Pick<LiteratureNote, "id" | "createdAt" | "updatedAt">>,
  ) => string | null;
  updateNote: (paperId: string, noteId: string, patch: Partial<Pick<LiteratureNote, "title" | "content">>) => void;
  deleteNote: (paperId: string, noteId: string) => void;
  createNoteFromAnnotation: (paperId: string, annotationId: string) => string | null;
  importAnnotations: (paperId: string, payload: unknown) => { annotations: number; notes: number };
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

  /** Refresh only the canonical item graph after a normalized write.  The
   * compatibility projection remains useful for workflow fields, but the
   * hierarchy, tag definitions and item versions must come from SQLite. */
  const refreshLibraryModel = async (
    expectedProjectId?: string,
  ): Promise<LiteratureLibraryModelSnapshot | null> => {
    try {
      // Keep the normalized endpoint optional for older test doubles and
      // preview runtimes.  Some module shims throw while resolving a missing
      // named export, so the capability check must live inside the guard.
      if (!isTauri() || typeof literatureLibraryModel !== "function") return null;
      const model = normalizeLibraryModel(
        await literatureLibraryModel<Partial<LiteratureLibraryModelSnapshot>>(),
      );
      if (model && (expectedProjectId === undefined || get().loadedProjectId === expectedProjectId)) {
        set({ libraryModel: model });
      }
      return model;
    } catch (error) {
      log("warn", `failed to refresh normalized literature model: ${String(error)}`);
      return null;
    }
  };

  /** Serialize compatibility-projection writes. Each command captures the
   * project that was loaded when it was queued, so a late response from the
   * previous project can never rebase the newly loaded project. */
  const persistSnapshot = async (_label: string, projectId: string | null) => {
    if (!isTauri() || (projectId && get().loadedProjectId !== projectId)) return;
    const target = get().library;
    const baseline = persistedLibraryProjectId === projectId
      ? persistedLibrary ?? emptyLibrary()
      : emptyLibrary();
    const delta = libraryDelta(baseline, target);
    if (isEmptyDelta(delta)) return;
    const projection = await literatureApplyDelta<Partial<LiteratureLibrary>>(delta);
    if (
      projectId
      && (get().loadedProjectId !== projectId || persistedLibraryProjectId !== projectId)
    ) return;
    persistedLibrary = rebasePersistedProjection(projection, [
      ...delta.upsertPapers.map((paper) => paper.id),
      ...delta.hidePaperIds,
    ]);
    persistedLibraryProjectId = projectId;
  };

  const enqueuePersist = (label: string, projectId: string | null) => {
    if (!isTauri()) return Promise.resolve();
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persistSnapshot(label, projectId));
    return persistQueue;
  };

  const persist = () => {
    if (!isTauri()) return;
    const projectId = get().loadedProjectId;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimerProjectId = projectId;
    persistTimer = setTimeout(() => {
      const scheduledProjectId = persistTimerProjectId;
      persistTimer = null;
      persistTimerProjectId = null;
      void enqueuePersist("library changes", scheduledProjectId).catch((error) => {
        if (get().loadedProjectId === scheduledProjectId) {
          set({ error: "failed to save library changes: " + String(error) });
        }
      });
    }, PERSIST_DELAY_MS);
  };

  const persistNow = async (label: string) => {
    if (!isTauri()) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      persistTimerProjectId = null;
    }
    const projectId = get().loadedProjectId;
    try {
      await enqueuePersist(label, projectId);
    } catch (error) {
      const message = "failed to save " + label + ": " + String(error);
      if (get().loadedProjectId === projectId) {
        set({ error: message });
        log("error", message, { open: true });
      }
      throw error;
    }
  };

  const mutate = (update: (library: LiteratureLibrary) => LiteratureLibrary) => {
    set({ library: update(get().library) });
    persist();
  };

  /** Apply the project's naming template to one record's attachments right
   * after an import, when the researcher has opted in. Failures here are
   * reported but never fail the import itself: the file is already saved, and
   * losing the download because a rename could not proceed would be worse. */
  const renameAttachmentsIfPreferred = async (recordId: string) => {
    if (!isTauri()) return;
    const projectId = get().loadedProjectId;
    try {
      const preferences = await literaturePreferences<{ renameAttachmentsOnImport?: boolean }>();
      if (!preferences?.renameAttachmentsOnImport) return;
      // The rename reads the attachment rows, so any pending projection write
      // has to land first.
      await persistNow("pending library changes");
      const report = await literatureRenameAttachments<{ renamed: unknown[] }>([recordId], false);
      if (!report?.renamed.length || get().loadedProjectId !== projectId || !projectId) return;
      await get().load(projectId, { quiet: true });
    } catch (error) {
      log("warn", `could not rename the imported attachment: ${String(error)}`);
    }
  };

  const patchPapers = (ids: string[], patch: (paper: LiteraturePaper) => LiteraturePaper) => {
    const targetIds = new Set(ids);
    mutate((library) => ({
      ...library,
      papers: library.papers.map((paper) => (
        targetIds.has(paper.id) ? patch(paper) : paper
      )),
    }));
  };

  const setPapersLocal = (ids: string[], patch: (paper: LiteraturePaper) => LiteraturePaper) => {
    const targetIds = new Set(ids);
    set((state) => ({
      library: {
        ...state.library,
        papers: state.library.papers.map((paper) => (
          targetIds.has(paper.id) ? patch(paper) : paper
        )),
      },
    }));
  };

  const relationPayload = (paper: LiteraturePaper) => ({
    tags: paper.tags,
    collectionIds: paper.collectionIds,
    attachments: paper.attachments ?? [],
    notes: paper.notes ?? [],
    pdfAnnotations: paper.pdfAnnotations ?? [],
    pdf: paper.pdf,
    ...(paper.relations ? { relations: paper.relations } : {}),
  });

  const canonicalFieldsForPatch = (
    base: Record<string, string>,
    patch: LiteratureMetadataPatch,
  ) => {
    const fields = { ...base };
    const put = (key: string, value: string | number | null | undefined) => {
      if (value === undefined || String(value).trim() === "") delete fields[key];
      else fields[key] = String(value).trim();
    };
    if (Object.prototype.hasOwnProperty.call(patch, "title")) put("title", patch.title);
    if (Object.prototype.hasOwnProperty.call(patch, "venue")) put("publicationTitle", patch.venue);
    if (Object.prototype.hasOwnProperty.call(patch, "abstract")) put("abstractNote", patch.abstract);
    if (Object.prototype.hasOwnProperty.call(patch, "doi")) put("DOI", patch.doi);
    if (Object.prototype.hasOwnProperty.call(patch, "isbn")) put("ISBN", patch.isbn);
    if (Object.prototype.hasOwnProperty.call(patch, "url")) put("url", patch.url);
    if (Object.prototype.hasOwnProperty.call(patch, "volume")) put("volume", patch.volume);
    if (Object.prototype.hasOwnProperty.call(patch, "issue")) put("issue", patch.issue);
    if (Object.prototype.hasOwnProperty.call(patch, "pages")) put("pages", patch.pages);
    if (Object.prototype.hasOwnProperty.call(patch, "publisher")) put("publisher", patch.publisher);
    if (Object.prototype.hasOwnProperty.call(patch, "place")) put("place", patch.place);
    if (Object.prototype.hasOwnProperty.call(patch, "edition")) put("edition", patch.edition);
    if (Object.prototype.hasOwnProperty.call(patch, "series")) put("series", patch.series);
    if (Object.prototype.hasOwnProperty.call(patch, "language")) put("language", patch.language);
    if (Object.prototype.hasOwnProperty.call(patch, "citationKey")) put("citationKey", patch.citationKey);
    if (Object.prototype.hasOwnProperty.call(patch, "rating")) put("rating", patch.rating);
    if (Object.prototype.hasOwnProperty.call(patch, "accessed")) put("accessDate", patch.accessed);
    if (Object.prototype.hasOwnProperty.call(patch, "date") || Object.prototype.hasOwnProperty.call(patch, "year")) {
      put("date", patch.date ?? (patch.year === undefined ? undefined : patch.year));
    }
    // Keep provider-specific Zotero fields in the normalized data plane. The
    // compatibility projection only promotes a small subset of these fields,
    // but editing one field must never erase the others.
    for (const source of [patch.metadataFields, patch.fields]) {
      if (!source) continue;
      for (const [field, value] of Object.entries(source)) {
        if (field.trim()) put(field.trim(), value);
      }
    }
    return fields;
  };

  const canonicalCreatorsForAuthors = (authors: string[]): LiteratureCreatorInput[] => authors.map((name, orderIndex) => ({
    creatorType: "author",
    name,
    fieldMode: "oneField",
    orderIndex,
  }));

  const canonicalCreatorsForItem = (
    creators: LiteratureCreatorInput[] | undefined,
    fallback: LiteratureLibraryModelSnapshot["items"][number]["creators"],
  ): LiteratureCreatorInput[] => {
    if (creators) {
      return creators.map((creator, orderIndex) => ({
        creatorType: creator.creatorType?.trim() || "author",
        firstName: creator.firstName?.trim() || undefined,
        lastName: creator.lastName?.trim() || undefined,
        name: creator.name?.trim() || undefined,
        fieldMode: creator.fieldMode || (
          creator.firstName?.trim() || creator.lastName?.trim() ? "twoField" : "oneField"
        ),
        orderIndex,
      }));
    }
    return fallback.map((creator, orderIndex) => ({
      creatorType: creator.creatorType,
      firstName: creator.firstName,
      lastName: creator.lastName,
      name: creator.name,
      fieldMode: creator.fieldMode,
      orderIndex,
    }));
  };

  const reloadAfterOptimisticFailure = async (projectId: string | null) => {
    if (!projectId || get().loadedProjectId !== projectId) return;
    try {
      await get().load(projectId, { quiet: true });
    } catch {
      // The original write error is already visible in the activity surface;
      // a failed recovery must not mask it or create a reload loop.
    }
  };

  /** Persist relationship edits through the normalized Library API. Calls are
   * serialized because each response also refreshes the compatibility
   * projection used by older consumers. */
  const persistCollections = (collections: LiteratureCollection[], label: string): Promise<void> => {
    if (!isTauri()) return Promise.resolve();
    relationPersistQueue = relationPersistQueue.then(async () => {
      const projectId = get().loadedProjectId;
      try {
        await persistNow("pending " + label);
      } catch {
        await reloadAfterOptimisticFailure(projectId);
        return;
      }
      try {
        const response = await literatureUpdateCollections<{
          projection?: Partial<LiteratureLibrary>;
        }>(collections);
        if (response?.projection && get().loadedProjectId === projectId) {
          persistedLibrary = rebasePersistedProjection(response.projection);
          persistedLibraryProjectId = projectId;
        }
        if (projectId && get().loadedProjectId === projectId) await refreshLibraryModel(projectId);
      } catch (error) {
        if (get().loadedProjectId !== projectId) return;
        const message = `failed to save ${label}: ${String(error)}`;
        set({ error: message });
        log("error", message, { open: true });
        await reloadAfterOptimisticFailure(projectId);
      }
    });
    return relationPersistQueue;
  };

  const persistRelationPapers = (ids: string[], label: string): Promise<void> => {
    if (!isTauri()) return Promise.resolve();
    relationPersistQueue = relationPersistQueue.then(async () => {
      const projectId = get().loadedProjectId;
      try {
        await persistNow("pending " + label);
      } catch {
        await reloadAfterOptimisticFailure(projectId);
        return;
      }
      for (const id of Array.from(new Set(ids))) {
        if (get().loadedProjectId !== projectId) return;
        const paper = get().library.papers.find((entry) => entry.id === id);
        if (!paper) continue;
        try {
          const response = await literatureUpdateRelations<{
            projection?: Partial<LiteratureLibrary>;
          }>(id, relationPayload(paper));
          if (response?.projection && get().loadedProjectId === projectId) {
            persistedLibrary = rebasePersistedProjection(response.projection, [id]);
            persistedLibraryProjectId = projectId;
          }
          if (projectId && get().loadedProjectId === projectId) await refreshLibraryModel(projectId);
        } catch (error) {
          if (get().loadedProjectId !== projectId) return;
          const message = `failed to save ${label}: ${String(error)}`;
          set({ error: message });
          log("error", message, { open: true });
          await reloadAfterOptimisticFailure(projectId);
        }
      }
    });
    return relationPersistQueue;
  };

  const patchRelationPapers = (
    ids: string[],
    patch: (paper: LiteraturePaper) => LiteraturePaper,
    label = "library relationship changes",
  ) => {
    setPapersLocal(ids, patch);
    void persistRelationPapers(ids, label);
  };

  return {
    library: emptyLibrary(),
    libraryModel: null,
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

    runRemoteSearch: async (query, _sources, _maxResults = 20) => {
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const trimmed = query.trim();
      if (!trimmed) {
        set({ error: copy.remoteSearchNeedsQuery });
        return;
      }
      if (!isTauri()) {
        set({ error: copy.remoteSearchNeedsDesktop });
        return;
      }
      const message = copy.reproducibleSearchOnly;
      set({ searching: false, error: message });
      log("warn", message, { open: true });
    },

    load: async (projectId, options) => {
      const generation = ++loadGeneration;
      // A pending save belongs to the project it was made in.
      //
      // Switching projects must drop it — the backend already points at the new
      // project, so flushing would write the old library into it. But `load` is
      // also the Literature UI's ordinary refresh, called after a dozen
      // different actions, and dropping the write there rolled back whatever
      // was still inside the 600 ms debounce. Deleting a saved search was the
      // visible case: the row vanished, the tombstone never reached disk, and
      // the reload projected the search straight back from its surviving
      // SearchRun — indistinguishable from a delete button that does nothing.
      if (persistTimer) {
        const pendingProjectId = get().loadedProjectId;
        if (pendingProjectId !== null && pendingProjectId === projectId) {
          try {
            await persistNow("pending library changes");
            if (generation !== loadGeneration) return;
          } catch {
            // `persistNow` already surfaced the failure. Reloading over an edit
            // that could not be saved would discard it without saying so.
            return;
          }
        } else {
          clearTimeout(persistTimer);
          persistTimer = null;
          persistTimerProjectId = null;
        }
      }
      if (!isTauri()) {
        const previewLibrary = previewLiteratureLibrary();
        set({
          library: previewLibrary,
          libraryModel: null,
          loaded: true,
          loadedProjectId: projectId,
          activeReviewTaskId: previewLibrary.reviewTasks[0]?.id ?? null,
        });
        return;
      }
      try {
        const raw = normalizeLibrary(await literatureLoad<Partial<LiteratureLibrary>>());
        if (generation !== loadGeneration) return;
        persistedLibrary = raw;
        persistedLibraryProjectId = projectId;
        const reviewTasks = raw.reviewTasks;
        const currentTaskId = get().activeReviewTaskId;
        set({
          library: raw,
          libraryModel: null,
          loaded: true,
          loadedProjectId: projectId,
          error: null,
          activeReviewTaskId:
            reviewTasks.some((task) => task.id === currentTaskId)
              ? currentTaskId
              : reviewTasks[0]?.id ?? null,
        });
        // The paper projection is enough to paint the first screen. Hydrate
        // the normalized item graph after that paint so large child graphs do
        // not block the library shell or the first interaction.
        void refreshLibraryModel(projectId);
        if (!options?.quiet) {
          const copy = LITERATURE_COPY[useStore.getState().language].store;
          log("info", copy.libraryLoaded(raw.papers?.length ?? 0));
        }
      } catch (error) {
        if (generation !== loadGeneration) return;
        const copy = LITERATURE_COPY[useStore.getState().language].store;
        const message = copy.libraryLoadFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
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
            log("info", `Agent (Chat): searching "${String(input.query ?? "...")}"`, {
              open: true,
            });
          } else if (tool.name === "LiteratureLibraryUpsert") {
            const count = Array.isArray(input.papers) ? input.papers.length : "?";
            log("info", `Agent (Chat): refreshing the projection for ${count} canonical records...`, {
              open: true,
            });
          } else if (tool.name === "LiteraturePdfDownload") {
            log("info", `Agent (Chat): downloading PDF ${String(input.fileName ?? "")}`, {
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
          if (result.name === "LiteratureSearch") {
            const runId = String((output.searchRun as Record<string, unknown> | undefined)?.id ?? "");
            const count = Array.isArray(output.papers) ? output.papers.length : 0;
            log(
              "ok",
              `Agent recorded ${count} canonical results${runId ? ` in SearchRun ${runId}` : ""}.`,
            );
          } else if (result.name === "LiteratureLibraryUpsert") {
            log(
              "ok",
              `Agent refreshed the local literature database for ${Number(output.merged ?? 0)} canonical records.`,
            );
          } else if (result.name === "LiteraturePdfDownload") {
            log("ok", `Agent downloaded ${String(output.relativePath ?? "PDF")}`);
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
                  ? `Library reloaded after chat turn: ${delta} new ${delta === 1 ? "paper" : "papers"}`
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
      if (candidates.length === 0) {
        log("info", `No unconfirmed papers match the scope for "${task.question}".`);
        return;
      }

      const candidateChunks = Array.from(
        { length: Math.ceil(candidates.length / SCREEN_CHUNK_SIZE) },
        (_, index) => candidates.slice(index * SCREEN_CHUNK_SIZE, (index + 1) * SCREEN_CHUNK_SIZE),
      );
      const screenRunId = makeId("screen-run");
      const chunks: LiteratureScreenChunk[] = candidateChunks.map((papers, index) => ({
        id: `${screenRunId}-chunk-${String(index + 1).padStart(3, "0")}`,
        index: index + 1,
        paperIds: papers.map((paper) => paper.id),
        status: "planned",
        expectedCount: papers.length,
        reviewerCount: 0,
        fallbackCount: 0,
        missingIndices: [],
      }));
      const screenRun: LiteratureScreenRun = {
        id: screenRunId,
        taskId,
        status: "planned",
        chunkSize: SCREEN_CHUNK_SIZE,
        totalPapers: candidates.length,
        reviewerCount: 0,
        fallbackCount: 0,
        criteriaUpdatedAt: task.updatedAt,
        startedAt: isoNow(),
        chunks,
      };

      mutate((library) => ({
        ...library,
        screenRuns: [screenRun, ...(library.screenRuns ?? [])],
      }));
      set({ screening: true });
      let reviewerTotal = 0;
      let fallbackTotal = 0;
      try {
        await persistNow("screening manifest");
        log(
          "info",
          `ScreenRun ${screenRunId} prepared ${candidateChunks.length} chunk(s) of at most ${SCREEN_CHUNK_SIZE} papers.`,
          { open: true },
        );

        for (let chunkIndex = 0; chunkIndex < candidateChunks.length; chunkIndex += 1) {
          const chunkPapers = candidateChunks[chunkIndex];
          const chunk = chunks[chunkIndex];
          const checkpoint = { screenRunId, chunkId: chunk.id };
          const startedAt = isoNow();
          mutate((library) => ({
            ...library,
            screenRuns: (library.screenRuns ?? []).map((run) =>
              run.id === screenRunId
                ? {
                    ...run,
                    status: "running",
                    chunks: run.chunks.map((item) =>
                      item.id === chunk.id ? { ...item, status: "running", startedAt } : item,
                    ),
                  }
                : run,
            ),
          }));
          await persistNow(`screening checkpoint ${chunk.index}`);

          let reviewerBatch: LlmScreenBatchResult | null = null;
          let reviewerError: string | undefined;
          if (isTauri()) {
            try {
              reviewerBatch = await llmScreen(chunkPapers, task, checkpoint);
            } catch (error) {
              reviewerError = String(error);
            }
          } else {
            reviewerError = "Review LLM is unavailable outside the Desktop runtime";
          }

          const screeningByPaper = new Map<string, PaperScreening>();
          for (const paper of chunkPapers) {
            screeningByPaper.set(
              paper.id,
              reviewerBatch?.screenings.get(paper.id)
                ?? screenPaperForTask(paper, task, checkpoint),
            );
          }
          const reviewerCount = reviewerBatch?.screenings.size ?? 0;
          const fallbackCount = chunkPapers.length - reviewerCount;
          const missingIndices = reviewerBatch?.missingIndices
            ?? chunkPapers.map((_, index) => index);
          reviewerTotal += reviewerCount;
          fallbackTotal += fallbackCount;
          const chunkStatus: LiteratureScreenChunk["status"] =
            reviewerCount === chunkPapers.length && missingIndices.length === 0
              ? "completed"
              : reviewerCount === 0
                ? "fallback"
                : "partial";
          const completedAt = isoNow();

          mutate((library) => ({
            ...library,
            papers: library.papers.map((paper) => {
              const screening = screeningByPaper.get(paper.id);
              if (!screening || paper.screenings?.[taskId]?.userConfirmed) return paper;
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
            screenRuns: (library.screenRuns ?? []).map((run) =>
              run.id === screenRunId
                ? {
                    ...run,
                    reviewerCount: reviewerTotal,
                    fallbackCount: fallbackTotal,
                    chunks: run.chunks.map((item) =>
                      item.id === chunk.id
                        ? {
                            ...item,
                            status: chunkStatus,
                            reviewerCount,
                            fallbackCount,
                            missingIndices,
                            completedAt,
                            error: reviewerError
                              ?? (missingIndices.length > 0
                                ? `Reviewer reply omitted or duplicated indices: ${missingIndices.join(", ")}`
                                : undefined),
                          }
                        : item,
                    ),
                  }
                : run,
            ),
          }));
          await persistNow(`screening checkpoint ${chunk.index} result`);
          log(
            chunkStatus === "completed" ? "ok" : "warn",
            `ScreenRun ${screenRunId} chunk ${chunk.index}/${chunks.length}: ${reviewerCount}/${chunkPapers.length} Reviewer, ${fallbackCount} heuristic.`,
          );
        }

        const finalStatus: LiteratureScreenRun["status"] =
          fallbackTotal === 0 ? "completed" : reviewerTotal === 0 ? "fallback" : "partial";
        const completedAt = isoNow();
        mutate((library) => ({
          ...library,
          screenRuns: (library.screenRuns ?? []).map((run) =>
            run.id === screenRunId ? { ...run, status: finalStatus, completedAt } : run,
          ),
        }));
        await persistNow("completed screening run");
        log(
          finalStatus === "completed" ? "ok" : "warn",
          `ScreenRun ${screenRunId} finished: ${reviewerTotal}/${candidates.length} Reviewer decisions, ${fallbackTotal} explicit heuristic fallback.`,
          { open: true },
        );
      } catch (error) {
        mutate((library) => ({
          ...library,
          screenRuns: (library.screenRuns ?? []).map((run) =>
            run.id === screenRunId
              ? { ...run, status: "failed", completedAt: isoNow() }
              : run,
          ),
        }));
        log("error", `ScreenRun ${screenRunId} failed: ${String(error)}`, { open: true });
      } finally {
        set({ screening: false });
      }
    },

    setStage: (ids, stage) => patchPapers(ids, (paper) => ({ ...paper, stage })),

    deletePapers: (ids) => {
      const targets = new Set(ids);
      if (targets.size === 0) return;
      mutate((library) => ({
        ...library,
        papers: library.papers.filter((paper) => !targets.has(paper.id)),
        trash: [
          ...(library.trash ?? []).filter((paper) => !targets.has(paper.id)),
          ...library.papers.filter((paper) => targets.has(paper.id)),
        ],
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
      log("warn", LITERATURE_COPY[useStore.getState().language].store.papersDeleted(targets.size), {
        open: true,
      });
    },

    restorePapers: async (ids) => {
      const targets = new Set(ids.map((id) => id.trim()).filter(Boolean));
      if (targets.size === 0) return;
      if (!isTauri()) {
        mutate((library) => {
          const restored = (library.trash ?? []).filter((paper) => targets.has(paper.id));
          if (restored.length === 0) return library;
          return {
            ...library,
            papers: [...library.papers, ...restored],
            trash: (library.trash ?? []).filter((paper) => !targets.has(paper.id)),
          };
        });
        log("info", LITERATURE_COPY[useStore.getState().language].store.papersRestored(targets.size), {
          open: true,
        });
        return;
      }
      try {
        const projectId = get().loadedProjectId;
        if (!projectId) return;
        await persistNow("pending library changes");
        const response = await literatureRestoreItems<{
          projection?: Partial<LiteratureLibrary>;
        }>(Array.from(targets));
        if (get().loadedProjectId !== projectId) return;
        if (response?.projection) {
          const next = rebasePersistedProjection(response.projection, [...targets]);
          persistedLibrary = next;
          persistedLibraryProjectId = projectId;
          set({ library: next, error: null });
        } else {
          await get().load(projectId, { quiet: true });
        }
        log("info", LITERATURE_COPY[useStore.getState().language].store.papersRestored(targets.size), {
          open: true,
        });
      } catch (error) {
        const message = "failed to restore papers: " + String(error);
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    permanentlyDeletePapers: async (ids) => {
      const targets = new Set(ids.map((id) => id.trim()).filter(Boolean));
      if (targets.size === 0) return;
      if (!isTauri()) {
        mutate((library) => ({
          ...library,
          papers: library.papers.filter((paper) => !targets.has(paper.id)),
          trash: (library.trash ?? []).filter((paper) => !targets.has(paper.id)),
        }));
        log("warn", "permanently deleted " + targets.size + " paper(s)", { open: true });
        return;
      }
      try {
        const projectId = get().loadedProjectId;
        if (!projectId) return;
        await persistNow("pending library changes");
        const response = await literaturePermanentlyDeleteItems<{
          deletedIds?: string[];
          projection?: Partial<LiteratureLibrary>;
        }>(Array.from(targets));
        if (get().loadedProjectId !== projectId) return;
        if (response?.projection) {
          const next = rebasePersistedProjection(response.projection);
          persistedLibrary = next;
          persistedLibraryProjectId = projectId;
          set({ library: next, error: null });
        } else {
          await get().load(projectId, { quiet: true });
        }
        log("warn", "permanently deleted " + (response?.deletedIds?.length ?? targets.size) + " paper(s)", { open: true });
      } catch (error) {
        const message = "failed to permanently delete papers: " + String(error);
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    toggleStar: (id) =>
      patchPapers([id], (paper) => ({ ...paper, starred: !paper.starred })),

    markRead: (id) =>
      patchPapers([id], (paper) => (
        paper.unread
          ? { ...paper, unread: false, readAt: isoNow() }
          : paper
      )),

    toggleRead: (id) =>
      patchPapers([id], (paper) => (
        paper.unread
          ? { ...paper, unread: false, readAt: isoNow() }
          : { ...paper, unread: true }
      )),

    setRating: (id, rating) => {
      if (!Number.isFinite(rating) || rating <= 0) {
        get().updatePaperMetadata(id, { rating: undefined });
        return;
      }
      get().updatePaperMetadata(id, { rating: Math.min(5, Math.max(1, Math.round(rating))) });
    },

    addTags: async (ids, tags) => {
      const cleaned = tags.map((tag) => tag.trim()).filter(Boolean);
      if (cleaned.length === 0) return;
      setPapersLocal(ids, (paper) => ({
        ...paper,
        tags: Array.from(new Set([...paper.tags, ...cleaned])).sort(),
      }));
      await persistRelationPapers(ids, "tag changes");
    },

    setTagColor: async (id, tag, color) => {
      const tagName = tag.trim();
      const normalizedColor = color.trim();
      if (!tagName || !normalizedColor) return;
      // Keep the browser preview and test fixture interactive as well. The
      // normalized tag snapshot is the UI source of truth for colors; the
      // desktop path below additionally persists the same edit to SQLite.
      set((state) => state.libraryModel ? {
        libraryModel: {
          ...state.libraryModel,
          tags: state.libraryModel.tags.map((entry) => (
            entry.name.toLocaleLowerCase() === tagName.toLocaleLowerCase()
              ? { ...entry, color: normalizedColor }
              : entry
          )),
        },
      } : state);
      if (!isTauri()) return;
      relationPersistQueue = relationPersistQueue.then(async () => {
        const projectId = get().loadedProjectId;
        try {
          await persistNow("pending tag changes");
          const paper = get().library.papers.find((entry) => entry.id === id);
          if (!paper || !paper.tags.some((entry) => entry.toLocaleLowerCase() === tagName.toLocaleLowerCase())) return;
          const response = await literatureUpdateRelations<{
            projection?: Partial<LiteratureLibrary>;
          }>(id, {
            ...relationPayload(paper),
            tags: paper.tags.map((entry) => (
              entry.toLocaleLowerCase() === tagName.toLocaleLowerCase()
                ? { tag: entry, color: normalizedColor }
                : entry
            )),
          });
          if (response?.projection && get().loadedProjectId === projectId) {
            persistedLibrary = rebasePersistedProjection(response.projection);
            persistedLibraryProjectId = projectId;
          }
          if (projectId && get().loadedProjectId === projectId) await refreshLibraryModel(projectId);
        } catch (error) {
          if (get().loadedProjectId !== projectId) return;
          const message = "failed to save tag color: " + String(error);
          set({ error: message });
          log("error", message, { open: true });
          await reloadAfterOptimisticFailure(projectId);
        }
      });
      await relationPersistQueue;
    },

    updatePaperRelations: (id, relations) =>
      patchRelationPapers(
        [id],
        (paper) => ({
          ...paper,
          relations: relations.filter((relation) => (
            relation.sourceItemId === id
            && relation.target.trim()
            && relation.target.toLocaleLowerCase() !== id.toLocaleLowerCase()
          )),
        }),
        "related item changes",
      ),

    createManualItem: async (input) => {
      const title = input.title.trim();
      if (!title) return null;
      const authors = (input.authors ?? []).map((author) => author.trim()).filter(Boolean);
      const itemType = input.itemType?.trim() || "article";
      if (!isTauri()) {
        const id = makeId("manual");
        const now = isoNow();
        mutate((library) => ({
          ...library,
          papers: [{
            id,
            title,
            itemType,
            authors,
            venue: "",
            abstract: "",
            tags: [],
            collectionIds: [],
            searchIds: [],
            stage: "inbox",
            starred: false,
            unread: true,
            source: "manual",
            addedAt: now,
            pdf: { status: "none" },
            evidence: [],
            answerChains: [],
            pdfAnnotations: [],
            notes: [],
          }, ...library.papers],
        }));
        return id;
      }
      const projectId = get().loadedProjectId;
      if (!projectId) return null;
      try {
        await persistNow("pending library changes");
        if (get().loadedProjectId !== projectId) return null;
        const response = await literatureCreateItem<{
          recordId: string;
          projection?: Partial<LiteratureLibrary>;
        }>({
          itemType,
          title,
          creators: authors.map((name) => ({ name })),
          tags: [],
        });
        if (response.projection && get().loadedProjectId === projectId) {
          const next = rebasePersistedProjection(response.projection, [response.recordId]);
          persistedLibrary = next;
          persistedLibraryProjectId = projectId;
          set({ library: next, error: null });
        }
        if (get().loadedProjectId !== projectId) return null;
        await refreshLibraryModel(projectId);
        log("info", "created manual literature item: " + title);
        return response.recordId;
      } catch (error) {
        if (get().loadedProjectId !== projectId) return null;
        const message = "failed to create literature item: " + String(error);
        set({ error: message });
        log("error", message, { open: true });
        return null;
      }
    },

    updatePaperMetadata: (id, patch) => {
      if (Object.prototype.hasOwnProperty.call(patch, "citationKey")) {
        const message = citationKeyValidationError(patch.citationKey, id, get().library.papers);
        if (message) {
          set({ error: message });
          return;
        }
      }
      const paper = get().library.papers.find((entry) => entry.id === id);
      if (!paper) return;
      const normalizedItem = get().libraryModel?.items.find((entry) => entry.item.id === id);
      if (!isTauri() || !normalizedItem) {
        const { fields: _fields, creators: creatorInputs, ...paperPatch } = patch;
        patchPapers([id], (entry) => ({
          ...entry,
          ...paperPatch,
          ...(creatorInputs
            ? {
                creators: creatorInputs.map((creator, orderIndex): LiteratureLibraryCreator => ({
                  id: id + ":creator:" + orderIndex,
                  creatorType: creator.creatorType?.trim() || "author",
                  firstName: creator.firstName?.trim() || undefined,
                  lastName: creator.lastName?.trim() || undefined,
                  name: creator.name?.trim() || undefined,
                  fieldMode: creator.fieldMode || "oneField",
                  orderIndex,
                })),
              }
            : {}),
        }));
        return;
      }

      // Update the visible projection immediately, then serialize the same
      // edit through the canonical object-level API.  The expected version is
      // read inside the queue so two quick edits cannot accidentally reuse an
      // old optimistic-concurrency token.
      const { fields: _fields, creators: _creatorInputs, ...visiblePatch } = patch;
      setPapersLocal([id], (entry) => ({ ...entry, ...visiblePatch }));
      relationPersistQueue = relationPersistQueue.then(async () => {
        const projectId = get().loadedProjectId;
        try {
          await persistNow("pending library changes");
          const currentPaper = get().library.papers.find((entry) => entry.id === id);
          const currentItem = get().libraryModel?.items.find((entry) => entry.item.id === id);
          if (!currentPaper || !currentItem) {
            persist();
            return;
          }
          const creators = Object.prototype.hasOwnProperty.call(patch, "creators")
            ? canonicalCreatorsForItem(patch.creators, currentItem.creators)
            : Object.prototype.hasOwnProperty.call(patch, "authors")
              ? canonicalCreatorsForAuthors(patch.authors ?? [])
              : canonicalCreatorsForItem(undefined, currentItem.creators);
          const response = await literatureUpdateItem<{
            item?: unknown;
            projection?: Partial<LiteratureLibrary>;
          }>(id, {
            expectedVersion: currentItem.item.version,
            itemType: currentPaper.itemType ?? currentItem.item.itemType,
            fields: canonicalFieldsForPatch(currentItem.fields, patch),
            creators,
          });
          if (response?.projection && get().loadedProjectId === projectId) {
            const next = rebasePersistedProjection(response.projection, [id]);
            persistedLibrary = next;
            persistedLibraryProjectId = projectId;
            set({ library: next });
          }
          if (projectId && get().loadedProjectId === projectId) await refreshLibraryModel(projectId);
        } catch (error) {
          if (get().loadedProjectId !== projectId) return;
          const message = `failed to save metadata: ${String(error)}`;
          set({ error: message });
          log("error", message, { open: true });
          await reloadAfterOptimisticFailure(projectId);
        }
      });
      void relationPersistQueue;
    },

    ensureCitationKeys: async (ids) => {
      const selectedIds = new Set(ids.map((id) => id.trim()).filter(Boolean));
      const papers = get().library.papers;
      const selected = papers.filter((paper) => selectedIds.has(paper.id));
      const used = new Set(
        papers
          .filter((paper) => !selectedIds.has(paper.id))
          .map((paper) => validCitationKey(paper.citationKey)?.toLocaleLowerCase())
          .filter((key): key is string => Boolean(key)),
      );
      const assigned: Record<string, string> = {};
      const updates = new Map<string, string>();
      for (const paper of selected) {
        const existing = validCitationKey(paper.citationKey);
        let key = existing && !used.has(existing.toLocaleLowerCase()) ? existing : suggestedCitationKey(paper);
        let suffix = 2;
        while (used.has(key.toLocaleLowerCase())) {
          key = `${suggestedCitationKey(paper)}${suffix}`;
          suffix += 1;
        }
        used.add(key.toLocaleLowerCase());
        assigned[paper.id] = key;
        if (paper.citationKey !== key) updates.set(paper.id, key);
      }
      if (updates.size > 0) {
        patchPapers([...updates.keys()], (paper) => ({
          ...paper,
          citationKey: updates.get(paper.id) ?? paper.citationKey,
        }));
        await persistNow("citation keys");
      }
      return assigned;
    },

    saveDynamicSearch: (query, conditions = [], name, existingId) => {
      const normalizedConditions = normalizeSearchConditions(conditions);
      const trimmed = query.trim() || describeSearchConditions(normalizedConditions, useStore.getState().language);
      if (!trimmed) return null;
      const target = existingId
        ? get().library.searches.find((search) => search.id === existingId && search.dynamic)
        : undefined;
      if (target) {
        mutate((library) => ({
          ...library,
          searches: library.searches.map((search) => search.id === target.id
            ? {
                ...search,
                name: name?.trim() || trimmed,
                query: trimmed,
                ranAt: isoNow(),
                conditions: normalizedConditions.length > 0 ? normalizedConditions : undefined,
              }
            : search),
        }));
        return target.id;
      }
      const existing = get().library.searches.find(
        (search) => search.dynamic
          && search.query.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
          && JSON.stringify(search.conditions ?? []) === JSON.stringify(normalizedConditions),
      );
      if (existing) return existing.id;
      const id = makeId("dynamic-search");
      mutate((library) => ({
        ...library,
        searches: [
          ...library.searches,
          {
            id,
            name: name?.trim() || trimmed,
            query: trimmed,
            sources: ["local-fts5"],
            ranAt: isoNow(),
            resultCount: 0,
            newCount: 0,
            dynamic: true,
            ...(normalizedConditions.length > 0 ? { conditions: normalizedConditions } : {}),
          },
        ],
      }));
      return id;
    },

    removeSavedSearch: (id, options) => {
      const searchId = id.trim();
      if (!searchId) return;
      const current = get().library;
      const search = current.searches.find((item) => item.id === searchId);
      if (!search) return;
      const impact = savedSearchRemovalImpact(current, searchId);
      const paperIdsToDelete = new Set(
        options?.deleteRelatedPapers ? impact.removablePaperIds : [],
      );
      const searchRunId = savedSearchRunId(search);
      mutate((library) => {
        const hiddenSearchRunIds = searchRunId
          ? [...new Set([...(library.hiddenSearchRunIds ?? []), searchRunId])]
          : library.hiddenSearchRunIds ?? [];
        return {
          ...library,
          searches: library.searches.filter((item) => item.id !== searchId),
          hiddenSearchRunIds,
          papers: library.papers.filter((paper) => !paperIdsToDelete.has(paper.id)),
          // The delta trashes these papers rather than erasing them, so they
          // have to reach the local Trash view too. Dropping them outright
          // left the user with no way back until the next full reload.
          trash: [
            ...(library.trash ?? []).filter((paper) => !paperIdsToDelete.has(paper.id)),
            ...library.papers.filter((paper) => paperIdsToDelete.has(paper.id)),
          ],
          reviewTasks: library.reviewTasks.map((task) => ({
            ...task,
            searchIds: task.searchIds.filter((item) => item !== searchId),
            suggestions: task.suggestions
              .map((suggestion) => ({
                ...suggestion,
                basisPaperIds: suggestion.basisPaperIds.filter((paperId) => !paperIdsToDelete.has(paperId)),
              }))
              .filter((suggestion) => suggestion.basisPaperIds.length > 0),
          })),
        };
      });
      log("warn", LITERATURE_COPY[useStore.getState().language].store.savedSearchDeleted(
        search.query,
        paperIdsToDelete.size,
        impact.sharedPaperIds.length,
      ), { open: true });
    },

    addCollection: (label, parentId) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      const collection: LiteratureCollection = {
        id: makeId("col"),
        label: trimmed,
        ...(parentId ? { parentId } : {}),
        orderIndex: get().library.collections.filter((entry) => (entry.parentId ?? "") === (parentId ?? "")).length,
      };
      set((state) => ({
        library: {
          ...state.library,
          collections: [...state.library.collections, collection],
        },
      }));
      void persistCollections([...get().library.collections], "collection changes");
    },

    renameCollection: (id, label) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      const current = get().library;
      if (!current.collections.some((collection) => collection.id === id)) return;
      const collections = current.collections.map((collection) => (
        collection.id === id ? { ...collection, label: trimmed } : collection
      ));
      set({ library: { ...current, collections } });
      void persistCollections(collections, "collection rename");
    },

    removeCollection: (id) => {
      const library = get().library;
      if (!library.collections.some((collection) => collection.id === id)) return;
      const toRemove = descendantCollectionIds(library.collections, id);
      const collections = library.collections.filter((c) => !toRemove.has(c.id));
      set({
        library: {
          ...library,
          collections,
          papers: library.papers.map((paper) => ({
            ...paper,
            collectionIds: paper.collectionIds.filter((collectionId) => !toRemove.has(collectionId)),
          })),
          trash: (library.trash ?? []).map((paper) => ({
            ...paper,
            collectionIds: paper.collectionIds.filter((collectionId) => !toRemove.has(collectionId)),
          })),
        },
      });
      void persistCollections(collections, "collection changes");
    },

    assignToCollection: async (paperIds, collectionId, options) => {
      const cleanedIds = [...new Set(paperIds.map((id) => id.trim()).filter(Boolean))];
      const collection = collectionId.trim();
      if (!cleanedIds.length || !collection) return;
      if (!get().library.collections.some((entry) => entry.id === collection)) return;
      const sourceCollectionId = options?.sourceCollectionId?.trim();
      const targets = cleanedIds.filter((id) => {
        const paper = get().library.papers.find((entry) => entry.id === id);
        if (!paper) return false;
        if (options?.move && sourceCollectionId && paper.collectionIds.includes(sourceCollectionId)) return true;
        return !paper.collectionIds.includes(collection);
      });
      if (!targets.length) return;
      setPapersLocal(targets, (paper) => ({
        ...paper,
        collectionIds: options?.move
          ? [
              ...paper.collectionIds.filter((id) => id !== sourceCollectionId),
              collection,
            ]
          : [...new Set([...paper.collectionIds, collection])],
      }));
      await persistRelationPapers(targets, options?.move ? "collection move" : "collection drop");
    },

    removeFromCollection: async (paperIds, collectionId) => {
      const cleanedIds = [...new Set(paperIds.map((id) => id.trim()).filter(Boolean))];
      const collection = collectionId.trim();
      if (!cleanedIds.length || !collection) return;
      const targets = cleanedIds.filter((id) => {
        const paper = get().library.papers.find((entry) => entry.id === id);
        return paper?.collectionIds.includes(collection) ?? false;
      });
      if (!targets.length) return;
      setPapersLocal(targets, (paper) => ({
        ...paper,
        collectionIds: paper.collectionIds.filter((id) => id !== collection),
      }));
      await persistRelationPapers(targets, "remove from collection");
    },

    toggleCollection: async (paperId, collectionId) => {
      const collection = collectionId.trim();
      if (!collection || !get().library.collections.some((entry) => entry.id === collection)) return;
      if (!get().library.papers.some((paper) => paper.id === paperId)) return;
      setPapersLocal([paperId], (paper) => ({
        ...paper,
        collectionIds: paper.collectionIds.includes(collection)
          ? paper.collectionIds.filter((id) => id !== collection)
          : [...paper.collectionIds, collection],
      }));
      await persistRelationPapers([paperId], "collection changes");
    },

    generateBrief: async (paperId) => {
      const language = useStore.getState().language;
      const copy = LITERATURE_COPY[language].store;
      const focus = get().library.projectFocus;
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper) return;
      if (paper.pdf.status !== "downloaded" || !paper.pdf.path) {
        const message = copy.needPdfForBrief;
        set({ error: message });
        log("warn", message, { open: true });
        return;
      }
      if (!isTauri()) {
        set({ error: copy.briefNeedsDesktop });
        return;
      }
      set({ briefing: paperId });
      try {
        log("info", copy.extractingFullText(paper.title), { open: true });
        const extraction = await extractPdfTextByPage(paper.pdf.path);
        if (extraction.truncated) {
          const missingPages = extraction.missingPages ?? [];
          throw new Error(
            copy.fullTextIncomplete(missingPages.length > 0 ? copy.fullTextMissingPages(missingPages.join("、")) : ""),
          );
        }
        log("info", copy.fullTextRead(extraction.totalCharacters));
        const brief = await llmBrief(paper, focus, extraction, language);
        const annotations = briefAnnotations(brief);
        patchPapers([paperId], (entry) => ({
          ...entry,
          brief,
          unread: false,
          readAt: entry.readAt ?? isoNow(),
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "core"),
            ...annotations,
          ],
        }));
        log("ok", copy.briefGenerated(paper.title));
      } catch (error) {
        const message = copy.briefGenerationFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      } finally {
        set({ briefing: null });
      }
    },

    generateAnswerChains: async (paperId) => {
      const language = useStore.getState().language;
      const copy = LITERATURE_COPY[language].store;
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper?.pdf.path || paper.pdf.status !== "downloaded") {
        set({ error: copy.needPdfForChains });
        return;
      }
      if (!isTauri()) {
        set({ error: copy.chainsNeedDesktop });
        return;
      }
      set({ generatingAnswerChains: paperId, error: null });
      try {
        log("info", copy.planningEvidence(paper.title), { open: true });
        const question = get().library.projectFocus?.question ?? "";

        // Text extraction is cheap and covers most pages of a typical paper;
        // only pages it can't (figures/tables/dense math/scanned pages) fall
        // back to rendering + a vision model. If text extraction fails
        // outright (e.g. a scanned PDF with no usable OCR), fall back to
        // reading every page visually — the pre-split behavior.
        let textPages: PdfPageExtraction[] = [];
        let visualPageNumbers: number[] | undefined;
        try {
          const textExtraction = await extractPdfTextByPage(paper.pdf.path);
          const classified = classifyEvidencePages(textExtraction.pages);
          textPages = classified.textPages;
          visualPageNumbers = classified.visualPageNumbers;
        } catch {
          visualPageNumbers = undefined;
        }

        const evidence: PageEvidence[] = [];
        if (textPages.length > 0) {
          log("info", copy.textEvidenceCount(textPages.length));
          evidence.push(...await llmTextEvidence(paper, question, textPages, language));
        }
        if (visualPageNumbers === undefined || visualPageNumbers.length > 0) {
          const imageExtraction = await extractPdfPageImages(paper.pdf.path, visualPageNumbers);
          log("info", copy.visualEvidenceCount(imageExtraction.pages.length));
          evidence.push(...await llmVisualEvidence(paper, question, imageExtraction.pages, language));
        }
        const deduped = dedupeAndLimit(evidence, 24);
        if (deduped.length === 0) throw new Error("model returned no evidence");

        const evidenceMarks = evidenceAnnotations(deduped);
        patchPapers([paperId], (entry) => ({
          ...entry,
          evidence: deduped,
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "evidence"),
            ...evidenceMarks,
          ],
        }));
        const result = await llmAnswerChainsFromEvidence(paper, get().library.projectFocus, deduped, language);
        patchPapers([paperId], (entry) => ({
          ...entry,
          answerChains: result.chains,
          pdfAnnotations: [
            ...entry.pdfAnnotations.filter((annotation) => annotation.kind !== "answer-support"),
            ...result.annotations,
          ],
        }));
        const visualPageCount = visualPageNumbers === undefined
          ? deduped.filter((item) => item.source === "vision").length
          : visualPageNumbers.length;
        log(
          "ok",
          copy.chainsGenerated(textPages.length, visualPageCount, deduped.length, result.chains.length),
        );
      } catch (error) {
        const message = copy.chainsGenerationFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      } finally {
        set({ generatingAnswerChains: null });
      }
    },

    addPdfAnnotation: (paperId, annotation) =>
      patchRelationPapers(
        [paperId],
        (paper) => ({
          ...paper,
          pdfAnnotations: [
            ...paper.pdfAnnotations,
            { ...annotation, id: makeId("annotation"), createdAt: isoNow() },
          ],
        }),
        "annotation changes",
      ),

    updatePdfAnnotation: (paperId, annotationId, patch) =>
      patchRelationPapers(
        [paperId],
        (paper) => ({
          ...paper,
          pdfAnnotations: paper.pdfAnnotations.map((annotation) =>
            annotation.id === annotationId ? { ...annotation, ...patch } : annotation,
          ),
        }),
        "annotation changes",
      ),

    deletePdfAnnotation: (paperId, annotationId) =>
      patchRelationPapers(
        [paperId],
        (paper) => ({
          ...paper,
          pdfAnnotations: paper.pdfAnnotations.filter((a) => a.id !== annotationId),
          // Keep a note when its source highlight is removed: its text remains a
          // durable research observation, but it no longer points at a stale id.
          notes: (paper.notes ?? []).map((note) =>
            note.annotationId === annotationId
              ? { ...note, annotationId: undefined, updatedAt: isoNow() }
              : note,
          ),
        }),
        "annotation changes",
      ),

    addAttachment: (paperId, attachment) => {
      let attachmentId: string | null = null;
      patchRelationPapers([paperId], (paper) => {
        attachmentId = attachment.id?.trim() || makeId("attachment");
        const next: LiteratureAttachment = {
          ...attachment,
          id: attachmentId,
          addedAt: attachment.addedAt ?? isoNow(),
        };
        return {
          ...paper,
          attachments: [...(paper.attachments ?? []).filter((item) => item.id !== next.id), next],
        };
      }, "attachment changes");
      return attachmentId;
    },

    removeAttachment: (paperId, attachmentId) =>
      patchRelationPapers([paperId], (paper) => {
        const removed = (paper.attachments ?? []).find((attachment) => attachment.id === attachmentId);
        const attachments = (paper.attachments ?? []).filter((attachment) => attachment.id !== attachmentId);
        const replacement = removed?.path && paper.pdf.path === removed.path
          ? attachments.find((attachment) => attachment.kind === "pdf" && attachment.path)
          : undefined;
        return {
          ...paper,
          attachments,
          pdf: replacement?.path
            ? {
                ...paper.pdf,
                status: "downloaded",
                path: replacement.path,
                bytes: replacement.bytes,
                error: undefined,
              }
            : removed?.path && paper.pdf.path === removed.path
              ? { status: "none" }
              : paper.pdf,
          notes: (paper.notes ?? []).map((note) =>
            note.attachmentId === attachmentId
              ? { ...note, attachmentId: undefined, updatedAt: isoNow() }
              : note,
          ),
          pdfAnnotations: paper.pdfAnnotations.map((annotation) =>
            annotation.attachmentId === attachmentId
              ? { ...annotation, attachmentId: undefined }
              : annotation,
          ),
        };
      }, "attachment changes"),

    setPrimaryPdfAttachment: (paperId, attachmentId) =>
      patchPapers([paperId], (paper) => {
        const attachment = (paper.attachments ?? []).find(
          (candidate) => candidate.id === attachmentId && candidate.kind === "pdf" && candidate.path,
        );
        if (!attachment?.path) return paper;
        return {
          ...paper,
          stage: paper.stage === "inbox" || paper.stage === "screened" || paper.stage === "shortlist"
            ? "downloaded"
            : paper.stage,
          pdf: {
            ...paper.pdf,
            status: "downloaded",
            path: attachment.path,
            bytes: attachment.bytes,
            error: undefined,
          },
        };
      }),

    importAttachment: async (paperId, sourcePath, kind) => {
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper || !sourcePath.trim()) return;
      if (!isTauri()) {
        set({ error: copy.importAttachmentNeedsDesktop });
        return;
      }
      try {
        const saved = await literatureImportAttachment<{
          relativePath: string;
          bytes: number;
          fileName: string;
          mimeType?: string;
        }>(sourcePath);
        const attachment: LiteratureAttachment = {
          id: makeId("attachment"),
          label: saved.fileName || sourcePath.split(/[\\/]/).pop() || "Attachment",
          kind,
          path: saved.relativePath,
          mimeType: saved.mimeType,
          bytes: saved.bytes,
          filename: saved.fileName,
          linkMode: "imported_file",
          addedAt: isoNow(),
        };
        setPapersLocal([paperId], (entry) => ({
          ...entry,
          attachments: [...(entry.attachments ?? []), attachment],
        }));
        await persistRelationPapers([paperId], "attachment changes");
        log("ok", copy.attachmentImported(saved.relativePath));
      } catch (error) {
        const message = copy.attachmentImportFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    relinkAttachment: async (paperId, attachmentId, sourcePath) => {
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      const current = paper?.attachments?.find((attachment) => attachment.id === attachmentId);
      if (!paper || !current || !sourcePath.trim() || !isTauri()) return;
      try {
        const saved = await literatureImportAttachment<{
          relativePath: string;
          bytes: number;
          fileName: string;
          mimeType?: string;
        }>(sourcePath);
        setPapersLocal([paperId], (entry) => ({
          ...entry,
          pdf: current.kind === "pdf" && current.path && entry.pdf.path === current.path
            ? {
                ...entry.pdf,
                status: "downloaded",
                path: saved.relativePath,
                bytes: saved.bytes,
                error: undefined,
              }
            : entry.pdf,
          attachments: (entry.attachments ?? []).map((attachment) => (
            attachment.id === attachmentId
              ? {
                  ...attachment,
                  path: saved.relativePath,
                  url: undefined,
                  externalPath: undefined,
                  filename: saved.fileName,
                  mimeType: saved.mimeType,
                  bytes: saved.bytes,
                  linkMode: "imported_file",
                }
              : attachment
          )),
        }));
        await persistRelationPapers([paperId], "attachment relink");
        log("ok", copy.attachmentImported(saved.relativePath));
      } catch (error) {
        const message = copy.attachmentImportFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    addNote: (paperId, note) => {
      let noteId: string | null = null;
      patchRelationPapers([paperId], (paper) => {
        noteId = note.id?.trim() || makeId("note");
        const now = isoNow();
        const next: LiteratureNote = {
          ...note,
          id: noteId,
          content: note.content.trim(),
          createdAt: note.createdAt ?? now,
          updatedAt: note.updatedAt ?? now,
          source: note.source ?? "manual",
        };
        if (!next.content) return paper;
        return { ...paper, notes: [...(paper.notes ?? []).filter((item) => item.id !== next.id), next] };
      }, "note changes");
      return noteId;
    },

    updateNote: (paperId, noteId, patch) =>
      patchRelationPapers(
        [paperId],
        (paper) => ({
          ...paper,
          notes: (paper.notes ?? []).map((note) =>
            note.id === noteId
              ? { ...note, ...patch, content: patch.content?.trim() ?? note.content, updatedAt: isoNow() }
              : note,
          ),
        }),
        "note changes",
      ),

    deleteNote: (paperId, noteId) =>
      patchRelationPapers(
        [paperId],
        (paper) => ({
          ...paper,
          notes: (paper.notes ?? []).filter((note) => note.id !== noteId),
        }),
        "note changes",
      ),

    createNoteFromAnnotation: (paperId, annotationId) => {
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      const annotation = paper?.pdfAnnotations.find((entry) => entry.id === annotationId);
      if (!paper || !annotation) return null;
      const linkedAttachmentId = annotation.attachmentId
        && (paper.attachments ?? []).some(
          (attachment) => attachment.id === annotation.attachmentId && attachment.kind === "pdf",
        )
        ? annotation.attachmentId
        : (paper.attachments ?? []).find(
          (attachment) => attachment.kind === "pdf" && attachment.path === paper.pdf.path,
        )?.id;
      return get().addNote(paperId, {
        title: LITERATURE_COPY[useStore.getState().language].store.annotationPageTitle(annotation.page),
        content: [annotation.quote, annotation.note].filter(Boolean).join("\n\n"),
        annotationId,
        attachmentId: linkedAttachmentId,
        evidenceId: annotation.evidenceId,
        source: "annotation",
      });
    },

    importAnnotations: (paperId, payload) => {
      const source = payload && typeof payload === "object" ? payload as {
        annotations?: unknown;
        notes?: unknown;
      } : {};
      const paper = get().library.papers.find((entry) => entry.id === paperId);
      if (!paper) return { annotations: 0, notes: 0 };
      const currentAnnotationIds = new Set(paper.pdfAnnotations.map((annotation) => annotation.id));
      const currentNoteIds = new Set((paper.notes ?? []).map((note) => note.id));
      const importedAnnotationIds = new Map<string, string>();
      const attachmentIds = new Set((paper.attachments ?? []).map((attachment) => attachment.id));
      const evidenceIds = new Set(paper.evidence.map((evidence) => evidence.id));
      const annotations = Array.isArray(source.annotations)
        ? source.annotations.flatMap((raw): PdfAnnotation[] => {
            if (!raw || typeof raw !== "object") return [];
            const entry = raw as Partial<PdfAnnotation>;
            if (!Number.isInteger(entry.page) || (entry.page ?? 0) < 1 || typeof entry.quote !== "string") return [];
            const importedId = typeof entry.id === "string" && entry.id.trim() ? entry.id : undefined;
            let id = importedId ?? makeId("annotation");
            while (currentAnnotationIds.has(id)) id = makeId("annotation");
            currentAnnotationIds.add(id);
            if (importedId) importedAnnotationIds.set(importedId, id);
            const style = entry.style === "underline" || entry.style === "strikethrough" || entry.style === "highlight"
              ? entry.style
              : undefined;
            return [{
              id,
              page: entry.page!,
              pageLabel: typeof entry.pageLabel === "string" ? entry.pageLabel : undefined,
              quote: entry.quote,
              note: typeof entry.note === "string" ? entry.note : "",
              kind: entry.kind === "core" || entry.kind === "evidence" || entry.kind === "answer-support" ? entry.kind : "note",
              color: entry.color,
              style,
              rects: normalizeAnnotationRects(entry.rects),
              position: entry.position,
              annotationType: typeof entry.annotationType === "string" ? entry.annotationType : undefined,
              sortIndex: Number.isFinite(entry.sortIndex) ? Number(entry.sortIndex) : undefined,
              author: typeof entry.author === "string" ? entry.author : undefined,
              isExternal: typeof entry.isExternal === "boolean" ? entry.isExternal : undefined,
              attachmentId: typeof entry.attachmentId === "string" && attachmentIds.has(entry.attachmentId)
                ? entry.attachmentId
                : undefined,
              source: entry.source,
              imageFingerprint: entry.imageFingerprint,
              sourceId: entry.sourceId,
              evidenceId: entry.evidenceId,
              sourcePayload: entry.sourcePayload,
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : isoNow(),
            }];
          })
        : [];
      const notes = Array.isArray(source.notes)
        ? source.notes.flatMap((raw): LiteratureNote[] => {
            if (!raw || typeof raw !== "object") return [];
            const entry = raw as Partial<LiteratureNote>;
            if (typeof entry.content !== "string" || !entry.content.trim()) return [];
            let id = typeof entry.id === "string" && entry.id.trim() ? entry.id : makeId("note");
            while (currentNoteIds.has(id)) id = makeId("note");
            currentNoteIds.add(id);
            return [{
              id,
              title: typeof entry.title === "string" ? entry.title : undefined,
              content: entry.content.trim(),
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : isoNow(),
              updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : isoNow(),
              annotationId: typeof entry.annotationId === "string"
                ? importedAnnotationIds.get(entry.annotationId)
                : undefined,
              attachmentId: typeof entry.attachmentId === "string" && attachmentIds.has(entry.attachmentId)
                ? entry.attachmentId
                : undefined,
              evidenceId: typeof entry.evidenceId === "string" && evidenceIds.has(entry.evidenceId)
                ? entry.evidenceId
                : undefined,
              source: "imported",
            }];
          })
        : [];
      if (annotations.length || notes.length) {
        setPapersLocal([paperId], (entry) => ({
          ...entry,
          pdfAnnotations: [...entry.pdfAnnotations, ...annotations],
          notes: [...(entry.notes ?? []), ...notes],
        }));
        void persistRelationPapers([paperId], "annotation import");
      }
      return { annotations: annotations.length, notes: notes.length };
    },

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
          notes: (entry.notes ?? []).map((note) =>
            note.evidenceId === evidenceId
              ? { ...note, evidenceId: undefined, updatedAt: isoNow() }
              : note,
          ),
          pdfAnnotations: entry.pdfAnnotations.filter(
            (annotation) =>
              !(annotation.kind === "evidence" && annotation.sourceId === evidenceId)
              && !removedSupportIds.has(annotation.id),
          ),
        };
      });
      log("info", LITERATURE_COPY[useStore.getState().language].store.evidenceDeleted(evidence.page));
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
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const paper = get().library.papers.find((entry) => entry.id === id);
      const url = paper?.pdf.url;
      if (!paper || !url) {
        set({ error: copy.noDirectPdfLink });
        return;
      }
      if (!isTauri()) {
        set({ error: copy.pdfDownloadNeedsDesktop });
        return;
      }
      if (paper.pdf.status === "downloading") return;
      patchPapers([id], (entry) => ({
        ...entry,
        pdf: { ...entry.pdf, status: "downloading", error: undefined },
      }));
      log("info", copy.downloadingPdf(pdfFileName(paper)), { open: true });
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
        log("ok", copy.pdfSaved(saved.relativePath, Math.max(1, Math.round(saved.bytes / 1024))));
        await renameAttachmentsIfPreferred(id);
      } catch (error) {
        patchPapers([id], (entry) => ({
          ...entry,
          pdf: { ...entry.pdf, status: "failed", error: String(error) },
        }));
        const message = copy.pdfDownloadFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    uploadPdf: async (id, sourcePath) => {
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const paper = get().library.papers.find((entry) => entry.id === id);
      if (!paper || !sourcePath.trim()) return;
      if (!isTauri()) {
        set({ error: copy.uploadNeedsDesktop });
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
          attachments: [
            ...(entry.attachments ?? []).filter((attachment) => attachment.path !== saved.relativePath),
            {
              id: makeId("attachment"),
              label: "Primary PDF",
              kind: "pdf" as const,
              path: saved.relativePath,
              mimeType: "application/pdf",
              bytes: saved.bytes,
              addedAt: isoNow(),
            },
          ],
        }));
        log("ok", copy.userPdfImported(saved.relativePath));
      } catch (error) {
        const message = copy.pdfImportFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    openPdf: async (id) => {
      const copy = LITERATURE_COPY[useStore.getState().language].store;
      const paper = get().library.papers.find((entry) => entry.id === id);
      if (!paper?.pdf.path || paper.pdf.status !== "downloaded") {
        set({ error: copy.noLocalPdfToOpen });
        return;
      }
      if (!isTauri()) {
        set({ error: copy.openPdfNeedsDesktop });
        return;
      }
      try {
        await literaturePdfOpen(paper.pdf.path);
        log("ok", copy.pdfOpened(paper.pdf.path));
      } catch (error) {
        const message = copy.openPdfFailed(String(error));
        set({ error: message });
        log("error", message, { open: true });
      }
    },

    setError: (message) => set({ error: message }),
  };
});


/** Test helper: reset the singleton store between cases. */
export const resetLiteratureStore = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerProjectId = null;
  }
  persistedLibrary = null;
  persistedLibraryProjectId = null;
  persistQueue = Promise.resolve();
  loadGeneration += 1;
  relationPersistQueue = Promise.resolve();
  useLiteratureStore.setState({
    library: emptyLibrary(),
    libraryModel: null,
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
};

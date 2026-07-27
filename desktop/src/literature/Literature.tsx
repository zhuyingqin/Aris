import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isTauri,
  literatureAttachmentOpen,
  literatureLlm,
  literatureAddIdentifier,
  literatureDuplicateCandidates,
  literatureExportBibliography,
  literatureFullTextSearch,
  literatureImportBibliography,
  literatureImportPdfAsRecord,
  literatureMergeDuplicates,
  literatureRagCards,
  literatureRagIndexLibrary,
  literatureRagIndexPdf,
  literatureRagStatus,
  literatureStorageBackup,
  literatureStorageStatus,
  literatureReadAnnotationExport,
  literatureWriteAnnotationExport,
  literatureWriteBibliographyExport,
  knowledgeRetrievalCardsBuild,
  projectRagAnswer,
  projectRagSearch,
  type LiteratureRagIndexLibraryResult,
  type LiteratureRagDatabaseStatus,
  type LiteratureRetrievalCardPage,
  type RetrievalCardPreview,
  type ProjectRagAnswerResult,
  type ProjectRagSearchResult,
} from "../api/tauri";
import { useStore, type Language } from "../store";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type { LiteraturePageView } from "./LiteratureViewTabs";
import { citationKeyValidationError, useLiteratureStore } from "./literatureStore";
import { LITERATURE_COPY } from "./i18n";
import {
  type DetailTab,
  type LiteratureLibrary,
  type LiteratureCollection,
  type LiteratureAttachment,
  type LiteratureDuplicateCandidate,
  type LiteraturePaper,
  type LiteratureStorageStatus,
  type LiteratureNote,
  type PaperStage,
} from "./literatureTypes";
import "./Literature.css";

type SortKey = "added" | "fit" | "year" | "title" | "citations";
type BibliographyExportFormat = "bibtex" | "biblatex" | "ris" | "csl-json";

const Knowledge = lazy(() => import("../knowledge/KnowledgeReview"));
const LazyMathText = lazy(() => import("./MathText"));
const PdfReader = lazy(() => import("./PdfReader"));

const AUTO_RETRIEVAL_CARDS_STORAGE_KEY = "somniq-literature-auto-retrieval-cards-v1";
const RETRIEVAL_CARD_BUILD_BATCH_SIZE = 24;

function MathText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <Suspense fallback={<span className={`lit-math-text ${className}`.trim()}>{text}</span>}>
      <LazyMathText text={text} className={className} />
    </Suspense>
  );
}

function LiteratureLoading({ label }: { label: string }) {
  return (
    <div className="lit-lazy-loading" role="status" aria-live="polite">
      <span className="lit-search-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

interface LiteratureProps {
  pageView?: LiteraturePageView;
  onPageViewChange?: (view: LiteraturePageView) => void;
}

interface LiteratureViewTabsProps {
  pageView: LiteraturePageView;
  onPageViewChange: (view: LiteraturePageView) => void;
  className?: string;
}

type LiteratureCopy = (typeof LITERATURE_COPY)[Language];

function literaturePageViews(copy: LiteratureCopy) {
  return [
    { id: "library" as const, label: copy.tabs.library, icon: "library" as const },
    { id: "discover" as const, label: copy.tabs.discover, icon: "search" as const },
    { id: "graph" as const, label: copy.tabs.graph, icon: "graph" as const },
  ];
}

export function LiteratureViewTabs({
  pageView,
  onPageViewChange,
  className,
}: LiteratureViewTabsProps) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  return (
    <div
      className={`lit-mode-switch${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label={copy.tabs.viewSwitchAria}
    >
      {literaturePageViews(copy).map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={pageView === item.id}
          className={`lit-mode-tab${pageView === item.id ? " active" : ""}`}
          onClick={() => onPageViewChange(item.id)}
        >
          <span className="lit-mode-tab-icon" aria-hidden="true"><SvgIcon name={item.icon} size={15} /></span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

const TAG_COLORS = ["amber", "blue", "green", "purple", "accent"];
function tagColorClass(tag: string): string {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) & 0xffff;
  return `lit-tag-${TAG_COLORS[hash % TAG_COLORS.length]}`;
}

const STAGE_ICONS: Record<PaperStage, SvgIconName> = {
  inbox: "inbox",
  screened: "clock",
  shortlist: "star",
  downloaded: "download",
  read: "check",
  excluded: "excluded",
};

function stageLabels(copy: LiteratureCopy): Record<PaperStage, string> {
  return copy.stage;
}

const STAGES_NAV: Array<{ id: PaperStage; alwaysVisible: boolean }> = [
  { id: "inbox", alwaysVisible: true },
  { id: "screened", alwaysVisible: true },
  { id: "shortlist", alwaysVisible: true },
  { id: "downloaded", alwaysVisible: true },
  { id: "read", alwaysVisible: false },
  { id: "excluded", alwaysVisible: false },
];

function matchesView(paper: LiteraturePaper, view: string) {
  if (view === "all") return paper.stage !== "excluded";
  if (view === "starred") return paper.starred;
  if (view.startsWith("stage:")) return paper.stage === view.slice(6);
  if (view.startsWith("col:")) return paper.collectionIds.includes(view.slice(4));
  if (view.startsWith("search:")) return paper.searchIds.includes(view.slice(7));
  return true;
}

function matchesQuery(paper: LiteraturePaper, needle: string) {
  if (!needle) return true;
  return [
    paper.title,
    paper.authors.join(" "),
    paper.venue,
    paper.abstract,
    paper.tags.join(" "),
    paper.doi ?? "",
    paper.arxivId ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function descendantCollectionIds(collections: LiteratureLibrary["collections"], rootId: string) {
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
}

function sortPapers(papers: LiteraturePaper[], sort: SortKey) {
  const sorted = [...papers];
  switch (sort) {
    case "fit":
      sorted.sort((a, b) => (b.verdict?.score ?? -1) - (a.verdict?.score ?? -1));
      break;
    case "year":
      sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "citations":
      sorted.sort((a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1));
      break;
    default:
      sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }
  return sorted;
}

function formatStorageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAutoRetrievalCardsPreference() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AUTO_RETRIEVAL_CARDS_STORAGE_KEY) !== "false";
  } catch {
    // Storage can be unavailable in a restricted WebView; auto-build remains the useful default.
    return true;
  }
}

const ITEM_TYPE_ALIASES: Record<string, string> = {
  "article-journal": "article",
  "paper-conference": "conferencePaper",
  chapter: "bookSection",
};

function itemTypeLabel(copy: LiteratureCopy, itemType?: string) {
  const canonical = ITEM_TYPE_ALIASES[itemType ?? ""] ?? itemType ?? "article";
  return (copy.itemType as Record<string, string>)[canonical] ?? copy.itemType.other;
}

function formatAuthors(copy: LiteratureCopy, authors: string[]) {
  if (authors.length === 0) return copy.unknownAuthors;
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

/** One retrieval-card preview, shared by the inline inventory and the browser modal. */
function RetrievalCardPreviewItem({
  preview,
  paperTitle,
  onOpenCitation,
}: {
  preview: RetrievalCardPreview;
  paperTitle: (paperId: string) => string;
  onOpenCitation: (paperId: string, page?: number) => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const terms = [
    ...preview.card.concepts,
    ...preview.card.aliases,
    ...preview.card.methods,
    ...preview.card.datasets,
    ...preview.card.metrics,
    ...preview.card.limitations,
    ...preview.card.languageTerms,
  ].slice(0, 12);
  return (
    <article className="lit-rag-card-preview">
      <div className="lit-rag-card-preview-head">
        <strong>{paperTitle(preview.paperId)}</strong>
        <button type="button" onClick={() => onOpenCitation(preview.paperId, preview.pageStart)}>
          p.{preview.pageStart}
        </button>
      </div>
      {preview.card.sectionHeadings.length > 0 && <small>{preview.card.sectionHeadings.join(" / ")}</small>}
      {preview.card.questions.length > 0 && <p>{preview.card.questions.slice(0, 3).join("；")}</p>}
      {terms.length > 0 && <div className="lit-rag-card-terms">{terms.map((term) => <span key={term}>{term}</span>)}</div>}
      <blockquote>{preview.sourcePreview}</blockquote>
      <footer>{preview.card.generatedBy || copy.ragPanel.configuredExecutor} · prompt v{preview.card.promptVersion}</footer>
    </article>
  );
}

function LiteratureRagPanel({
  selectedPaper,
  papers,
  onOpenCitation,
  onActivity,
}: {
  selectedPaper: LiteraturePaper | null;
  papers: LiteraturePaper[];
  onOpenCitation: (paperId: string, page?: number) => void;
  onActivity: (kind: "ok" | "error", message: string) => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const [busy, setBusy] = useState<"paper" | "library" | "rebuild" | "search" | "answer" | null>(null);
  const [status, setStatus] = useState(copy.ragPanel.initialStatus);
  const [libraryResult, setLibraryResult] = useState<LiteratureRagIndexLibraryResult | null>(null);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ProjectRagSearchResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerReview, setAnswerReview] = useState<ProjectRagAnswerResult["review"] | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState<LiteratureRagDatabaseStatus | null>(null);
  const [databaseStatusError, setDatabaseStatusError] = useState("");
  const [databaseStatusRefreshing, setDatabaseStatusRefreshing] = useState(false);
  const [cardBrowserOpen, setCardBrowserOpen] = useState(false);
  const [autoRetrievalCards, setAutoRetrievalCards] = useState(readAutoRetrievalCardsPreference);
  const [retrievalCardBuild, setRetrievalCardBuild] = useState({
    running: false,
    batches: 0,
    attempted: 0,
    generated: 0,
    warnings: 0,
    message: "",
  });
  const autoRetrievalCardsRef = useRef(autoRetrievalCards);
  const retrievalCardBuildRunningRef = useRef(false);
  const retrievalCardBuildRunRef = useRef(0);
  const retrievalCardResumeCheckedRef = useRef(false);

  const refreshDatabaseStatus = async () => {
    if (!isTauri()) return;
    setDatabaseStatusRefreshing(true);
    try {
      setDatabaseStatus(await literatureRagStatus(12));
      setDatabaseStatusError("");
    } catch (cause) {
      setDatabaseStatusError(String(cause));
    } finally {
      setDatabaseStatusRefreshing(false);
    }
  };

  useEffect(() => {
    void refreshDatabaseStatus();
  }, []);

  useEffect(() => {
    autoRetrievalCardsRef.current = autoRetrievalCards;
    try {
      window.localStorage.setItem(AUTO_RETRIEVAL_CARDS_STORAGE_KEY, autoRetrievalCards ? "true" : "false");
    } catch {
      // The toggle still works for this session when persistent storage is unavailable.
    }
  }, [autoRetrievalCards]);

  useEffect(() => () => {
    // Do not update this panel after switching projects or leaving the page. The current LLM
    // request is allowed to finish, but no further batch is started from this panel instance.
    retrievalCardBuildRunRef.current += 1;
  }, []);

  const reportFailure = (prefix: string, cause: unknown) => {
    const message = copy.ragPanel.failureMessage(prefix, String(cause));
    setStatus(message);
    onActivity("error", message);
  };

  const buildRetrievalCardsInBackground = async (paperId?: string, automatic = false) => {
    if (!isTauri() || retrievalCardBuildRunningRef.current) return;
    retrievalCardBuildRunningRef.current = true;
    const run = retrievalCardBuildRunRef.current + 1;
    retrievalCardBuildRunRef.current = run;
    const scope = paperId ? copy.ragPanel.scopePaper : copy.ragPanel.scopeLibrary;
    let batches = 0;
    let attempted = 0;
    let generated = 0;
    let warnings = 0;
    let paused = false;
    let stalled = false;
    setRetrievalCardBuild({
      running: true,
      batches,
      attempted,
      generated,
      warnings,
      message: automatic ? copy.ragPanel.autoBuildingCards(scope) : copy.ragPanel.manualBuildingCards(scope),
    });

    try {
      while (run === retrievalCardBuildRunRef.current) {
        if (automatic && !autoRetrievalCardsRef.current) {
          paused = true;
          break;
        }
        const result = await knowledgeRetrievalCardsBuild(paperId, RETRIEVAL_CARD_BUILD_BATCH_SIZE);
        if (run !== retrievalCardBuildRunRef.current) break;
        batches += 1;
        attempted += result.attempted;
        generated += result.generated;
        warnings += result.warnings.length;
        stalled = result.hasMore && result.generated === 0;
        setRetrievalCardBuild({
          running: true,
          batches,
          attempted,
          generated,
          warnings,
          message: copy.ragPanel.cardBuildRunning(attempted, generated, batches),
        });
        void refreshDatabaseStatus();
        if (!result.hasMore || stalled) break;
        // Yield before the next bounded model request so the UI can repaint and the switch can pause it.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      if (run !== retrievalCardBuildRunRef.current) return;
      if (automatic && !autoRetrievalCardsRef.current) paused = true;
      const message = paused
        ? copy.ragPanel.cardBuildPaused(attempted, generated)
        : stalled
          ? copy.ragPanel.cardBuildStalled(batches)
          : attempted === 0
            ? copy.ragPanel.cardBuildAllCurrent
            : copy.ragPanel.cardBuildCompleted(attempted, generated, batches);
      setRetrievalCardBuild({ running: false, batches, attempted, generated, warnings, message });
      onActivity(warnings > 0 || stalled ? "error" : "ok", message);
    } catch (cause) {
      if (run !== retrievalCardBuildRunRef.current) return;
      const message = copy.ragPanel.cardBuildFailed(String(cause));
      setRetrievalCardBuild({ running: false, batches, attempted, generated, warnings, message });
      onActivity("error", message);
    } finally {
      retrievalCardBuildRunningRef.current = false;
      if (run === retrievalCardBuildRunRef.current) void refreshDatabaseStatus();
    }
  };

  useEffect(() => {
    if (
      !autoRetrievalCards
      || !databaseStatus
      || busy
      || retrievalCardResumeCheckedRef.current
    ) return;
    // A project can be closed while a batch is in flight. Its cards are content-hash
    // keyed, so this is safe to resume from the pending count on the next visit.
    retrievalCardResumeCheckedRef.current = true;
    if (databaseStatus.pendingCardCount > 0) void buildRetrievalCardsInBackground(undefined, true);
  }, [autoRetrievalCards, busy, databaseStatus]);

  const setAutoRetrievalCardBuild = (enabled: boolean) => {
    autoRetrievalCardsRef.current = enabled;
    setAutoRetrievalCards(enabled);
    if (!enabled && retrievalCardBuildRunningRef.current) {
      setStatus(copy.ragPanel.autoCardsWillPause);
      return;
    }
    if (enabled && databaseStatus && databaseStatus.pendingCardCount > 0 && !busy) {
      void buildRetrievalCardsInBackground(undefined, true);
    }
  };

  const indexSelectedPaper = async () => {
    const relativePath = selectedPaper?.pdf.path;
    if (!relativePath) {
      setStatus(copy.ragPanel.noPaperPdf);
      return;
    }
    if (busy) return;
    setBusy("paper");
    setLibraryResult(null);
    setStatus(copy.ragPanel.indexingPaper(selectedPaper.title));
    try {
      const result = await literatureRagIndexPdf(
        relativePath,
        selectedPaper.id,
      );
      const indexedChunks = result.stats?.indexedChunks ?? result.indexedChunks ?? 0;
      const skipped = result.stats?.skippedAsCurrent ?? result.skippedAsCurrent ?? false;
      const message = skipped
        ? copy.ragPanel.indexUnchanged(selectedPaper.title)
        : copy.ragPanel.indexed(selectedPaper.title, indexedChunks, result.pageCount, result.ocrUsed);
      const parserNote = result.parserEngine
        ? copy.ragPanel.parserNote(result.parserEngine, result.assetCount ?? 0, result.parserWarning)
        : "";
      const cardNote = autoRetrievalCardsRef.current
        ? copy.ragPanel.cardNoteOn
        : copy.ragPanel.cardNoteOff;
      setStatus(`${message}${parserNote}${cardNote}`);
      onActivity("ok", `${message}${parserNote}${cardNote}`);
      if (autoRetrievalCardsRef.current) void buildRetrievalCardsInBackground(selectedPaper.id, true);
    } catch (cause) {
      reportFailure(copy.ragPanel.singlePaperIndexFailed, cause);
    } finally {
      setBusy(null);
      void refreshDatabaseStatus();
    }
  };

  const indexLibrary = async (forceRebuild: boolean) => {
    if (busy) return;
    if (forceRebuild && !window.confirm(copy.ragPanel.forceRebuildConfirm)) return;
    setBusy(forceRebuild ? "rebuild" : "library");
    setLibraryResult(null);
    setStatus(forceRebuild ? copy.ragPanel.forceRebuilding : copy.ragPanel.incrementalUpdating);
    try {
      const result = await literatureRagIndexLibrary(forceRebuild);
      setLibraryResult(result);
      const message = copy.ragPanel.libraryIndexed(result.total, result.indexed, result.skipped, result.failed);
      const cardNote = autoRetrievalCardsRef.current
        ? copy.ragPanel.cardNoteOn
        : copy.ragPanel.cardNoteOff;
      setStatus(`${message}${copy.ragPanel.libraryIndexedSuffix}${cardNote}`);
      onActivity(result.failed > 0 ? "error" : "ok", `${message}${cardNote}`);
      if (autoRetrievalCardsRef.current) void buildRetrievalCardsInBackground(undefined, true);
    } catch (cause) {
      reportFailure(forceRebuild ? copy.ragPanel.forceRebuildFailed : copy.ragPanel.libraryIndexFailed, cause);
    } finally {
      setBusy(null);
      void refreshDatabaseStatus();
    }
  };

  const buildRetrievalCards = () => {
    if (busy || retrievalCardBuild.running) return;
    void buildRetrievalCardsInBackground(undefined);
  };

  const search = async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setStatus(copy.ragPanel.noSearchQuery);
      return;
    }
    if (busy) return;
    setBusy("search");
    setSearchResult(null);
    setAnswer("");
    setAnswerReview(null);
    setStatus(copy.ragPanel.searching);
    try {
      const result = await projectRagSearch<ProjectRagSearchResult>(normalizedQuery, 8);
      setSearchResult(result);
      const warning = result.plannerWarning ? copy.ragPanel.plannerWarning(result.plannerWarning) : "";
      setStatus(copy.ragPanel.searchDone(result.knowledge.results.length, result.literature.results.length, warning));
    } catch (cause) {
      reportFailure(copy.ragPanel.searchFailed, cause);
    } finally {
      setBusy(null);
    }
  };

  const answerWithSomni = async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setStatus(copy.ragPanel.noAnswerQuery);
      return;
    }
    if (busy) return;
    setBusy("answer");
    setSearchResult(null);
    setAnswer("");
    setAnswerReview(null);
    setStatus(copy.ragPanel.answering);
    try {
      const result: ProjectRagAnswerResult = await projectRagAnswer(normalizedQuery, 8);
      setSearchResult(result);
      setAnswer(result.answer);
      setAnswerReview(result.review);
      const reviewNote = result.review.verdict === "pass"
        ? copy.ragPanel.reviewPassed
        : copy.ragPanel.reviewOther(result.review.verdict);
      setStatus(copy.ragPanel.answerDone(result.knowledge.results.length, result.literature.results.length, reviewNote));
    } catch (cause) {
      reportFailure(copy.ragPanel.answerFailed, cause);
    } finally {
      setBusy(null);
    }
  };

  const paperTitle = (paperId: string) => papers.find((paper) => paper.id === paperId)?.title ?? paperId;
  const totalResults = (searchResult?.knowledge.results.length ?? 0) + (searchResult?.literature.results.length ?? 0);

  return (
    <section className="lit-rag-panel" aria-label={copy.ragPanel.panelAria}>
      <div className="lit-rag-header">
        <div className="lit-rag-header-icon" aria-hidden="true">
          <SvgIcon name="memory" size={22} />
        </div>
        <div className="lit-rag-header-copy">
          <div className="lit-rag-header-meta">
            <span className="lit-rag-kicker">{copy.ragPanel.kicker}</span>
            <div className="lit-rag-header-tags" aria-label={copy.ragPanel.featuresAria}>
              <span><SvgIcon name="check" size={12} /> {copy.ragPanel.localFts}</span>
              <span><SvgIcon name="memory" size={12} /> {copy.ragPanel.zeroVectorStorage}</span>
            </div>
          </div>
          <h2>{copy.ragPanel.heading}</h2>
          <p>{copy.ragPanel.storageNotePrefix}<code>papers/rag/</code>{copy.ragPanel.storageNoteSuffix}</p>
          <p className="lit-rag-chat-route"><SvgIcon name="inbox" size={12} /> {copy.ragPanel.chatRouteNote}</p>
        </div>
      </div>

      <section className="lit-rag-pipeline" aria-label={copy.ragPanel.pipelineAria}>
        <div className="lit-rag-pipeline-intro">
          <SvgIcon name="diagram" size={17} />
          <div>
            <strong>{copy.ragPanel.pipelineHeading}</strong>
            <span>{copy.ragPanel.pipelineSubheading}</span>
          </div>
        </div>
        <ol>
          <li><SvgIcon name="attachment" size={14} /><span><strong>{copy.ragPanel.pipelinePdfOcr}</strong><small>{copy.ragPanel.pipelinePdfOcrHint}</small></span></li>
          <li><SvgIcon name="search" size={14} /><span><strong>{copy.ragPanel.pipelineFts}</strong><small>{copy.ragPanel.pipelineFtsHint}</small></span></li>
          <li><SvgIcon name="sparkle" size={14} /><span><strong>{copy.ragPanel.pipelineRerank}</strong><small>{copy.ragPanel.pipelineRerankHint}</small></span></li>
          <li><SvgIcon name="check" size={14} /><span><strong>{copy.ragPanel.pipelineReviewer}</strong><small>{copy.ragPanel.pipelineReviewerHint}</small></span></li>
        </ol>
      </section>

      <div className="lit-rag-workspace-grid">

      <section className="lit-rag-database" aria-label={copy.ragPanel.databaseAria}>
        <div className="lit-rag-database-head">
          <div className="lit-rag-database-title">
            <span className="lit-rag-section-icon" aria-hidden="true"><SvgIcon name="library" size={15} /></span>
            <div>
            <strong>{copy.ragPanel.databaseTitle}</strong>
            <span title={databaseStatus?.indexPath}>
              {databaseStatus?.relativeIndexPath ?? copy.ragPanel.defaultIndexPath}
            </span>
            </div>
          </div>
          <div className="lit-rag-database-controls">
            <span className={`lit-rag-state-pill ${databaseStatus?.exists ? "ready" : "empty"}`}>
              <i aria-hidden="true" />
              {databaseStatusRefreshing ? copy.ragPanel.stateLoading : databaseStatus?.exists ? copy.ragPanel.stateReady : copy.ragPanel.stateEmpty}
            </span>
            <button type="button" onClick={() => void refreshDatabaseStatus()} disabled={databaseStatusRefreshing} aria-label={copy.ragPanel.refreshAria} title={copy.ragPanel.refreshAria}>
              <SvgIcon name="refresh" size={13} /> <span>{databaseStatusRefreshing ? copy.ragPanel.stateLoading : copy.ragPanel.refresh}</span>
            </button>
          </div>
        </div>
        {databaseStatusError && <p className="lit-rag-database-error">{copy.ragPanel.readFailedPrefix}{databaseStatusError}</p>}
        {!databaseStatus && !databaseStatusError && <p className="lit-note-text">{copy.ragPanel.readingIndexStatus}</p>}
        {databaseStatus && !databaseStatus.exists && (
          <div className="lit-rag-database-empty">
            <span aria-hidden="true"><SvgIcon name="library" size={20} /></span>
            <div>
              <strong>{copy.ragPanel.noIndexYet}</strong>
              <p>{copy.ragPanel.noIndexYetHint}</p>
            </div>
          </div>
        )}
        {databaseStatus?.exists && (
          <>
            <div className="lit-rag-database-stats">
              <div><strong>{databaseStatus.documentCount}</strong><span>{copy.ragPanel.statDocuments}</span></div>
              <div><strong>{databaseStatus.chunkCount}</strong><span>{copy.ragPanel.statChunks}</span></div>
              <div><strong>{databaseStatus.currentCardCount}</strong><span>{copy.ragPanel.statCurrentCards}</span></div>
              <div><strong>{databaseStatus.pendingCardCount}</strong><span>{copy.ragPanel.statPendingCards}</span></div>
              <div><strong>{databaseStatus.assetCount}</strong><span>{copy.ragPanel.statAssets}</span></div>
              <div><strong>{formatStorageBytes(databaseStatus.databaseBytes)}</strong><span>{copy.ragPanel.statDatabaseSize}</span></div>
            </div>
            <div className="lit-rag-card-coverage">
              <div>
                <span>{copy.ragPanel.cardCoverage}</span>
                <strong>{databaseStatus.currentCardCount}/{databaseStatus.chunkCount}</strong>
              </div>
              <progress max={Math.max(databaseStatus.chunkCount, 1)} value={databaseStatus.currentCardCount} />
              <small>
                {copy.ragPanel.metadataDocsAndCitations(
                  databaseStatus.metadataDocumentCount,
                  databaseStatus.citationMentionCount,
                  databaseStatus.staleCardCount > 0 ? copy.ragPanel.staleCardsSuffix(databaseStatus.staleCardCount) : "",
                )}
              </small>
            </div>
            <div className="lit-rag-card-browser">
              <button
                type="button"
                className="lit-rag-card-browse-btn"
                onClick={() => setCardBrowserOpen(true)}
                disabled={databaseStatus.currentCardCount === 0}
              >
                <SvgIcon name="library" size={13} />
                <span>
                  {databaseStatus.currentCardCount === 0
                    ? copy.ragPanel.noCardsYet
                    : copy.ragPanel.browseAllCards(databaseStatus.currentCardCount)}
                </span>
                {databaseStatus.currentCardCount > 0 && <SvgIcon name="chevronRight" size={13} />}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="lit-rag-maintenance" aria-label={copy.ragPanel.maintenanceAria}>
        <div className="lit-rag-maintenance-head">
          <div>
            <span className="lit-rag-section-icon" aria-hidden="true"><SvgIcon name="refresh" size={15} /></span>
            <div>
              <strong>{copy.ragPanel.maintenanceHeading}</strong>
              <span>{copy.ragPanel.maintenanceHint}</span>
            </div>
          </div>
          <span className={`lit-rag-selection${selectedPaper?.pdf.path ? " available" : ""}`} title={selectedPaper?.title}>
            {selectedPaper?.pdf.path ? copy.ragPanel.currentSelection(selectedPaper.title) : copy.ragPanel.noSelectionPdf}
          </span>
        </div>

        <div className="lit-rag-actions" role="toolbar" aria-label={copy.ragPanel.indexActionsAria}>
          <button type="button" className="primary lit-rag-library-action" onClick={() => void indexLibrary(false)} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="refresh" size={14} />
            {busy === "library" ? copy.ragPanel.libraryUpdating : copy.ragPanel.libraryUpdateAction}
          </button>
          <button type="button" onClick={() => void indexSelectedPaper()} disabled={Boolean(busy) || retrievalCardBuild.running || !selectedPaper?.pdf.path}>
            <SvgIcon name="target" size={14} />
            {busy === "paper" ? copy.ragPanel.paperIndexing : copy.ragPanel.paperIndexAction}
          </button>
          <button type="button" onClick={buildRetrievalCards} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="sparkle" size={14} />
            {retrievalCardBuild.running ? copy.ragPanel.cardBuildRunningShort : copy.ragPanel.cardBuildAction}
          </button>
        </div>

        <label className="lit-rag-auto-cards">
          <input
            type="checkbox"
            aria-label={copy.ragPanel.autoCardsAria}
            checked={autoRetrievalCards}
            onChange={(event) => setAutoRetrievalCardBuild(event.target.checked)}
          />
          <span className="lit-rag-switch" aria-hidden="true"><i /></span>
          <span className="lit-rag-auto-copy">
            <strong>{copy.ragPanel.autoCardsLabel}</strong>
            <small>{copy.ragPanel.autoCardsHint}</small>
          </span>
        </label>

        <div className={`lit-rag-status${libraryResult?.failed ? " warning" : ""}`} role="status" aria-live="polite">
          <span className="lit-rag-status-icon" aria-hidden="true">
            {busy
              ? <span className="lit-search-spinner" />
              : <SvgIcon name={libraryResult?.failed ? "warning" : "check"} size={14} />}
          </span>
          <div><strong>{copy.ragPanel.runStatus}</strong><span>{status}</span></div>
        </div>
        <div className={`lit-rag-card-build${retrievalCardBuild.running ? " running" : ""}`} aria-live="polite">
          <SvgIcon name="sparkle" size={14} />
          <div>
            <strong>{copy.ragPanel.cardBuildTask}</strong>
            <span>{retrievalCardBuild.message || (autoRetrievalCards ? copy.ragPanel.cardBuildIdleAuto : copy.ragPanel.cardBuildIdleOff)}</span>
          </div>
          {retrievalCardBuild.running && <span className="lit-search-spinner" aria-hidden="true" />}
        </div>
        {libraryResult && libraryResult.failures.length > 0 && (
          <details className="lit-rag-failures">
            <summary>{copy.ragPanel.viewFailures(libraryResult.failures.length)}</summary>
            {libraryResult.failures.map((failure) => (
              <div key={`${failure.paperId}-${failure.relativePath}`}>
                <strong>{paperTitle(failure.paperId)}</strong>
                <span>{failure.error}</span>
              </div>
            ))}
          </details>
        )}
        <details className="lit-rag-advanced">
          <summary><SvgIcon name="reset" size={13} /> {copy.ragPanel.advancedMaintenance} <small>{copy.ragPanel.advancedMaintenanceHint}</small></summary>
          <button type="button" className="danger" onClick={() => void indexLibrary(true)} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="warning" size={13} />
            {busy === "rebuild" ? copy.ragPanel.forceRebuildingShort : copy.ragPanel.forceRebuildAction}
          </button>
        </details>
      </section>
      </div>

      <form className="lit-rag-search" onSubmit={(event) => { event.preventDefault(); void answerWithSomni(); }}>
        <div className="lit-rag-search-heading">
          <span className="lit-rag-search-icon" aria-hidden="true"><SvgIcon name="sparkle" size={18} /></span>
          <div>
            <span className="lit-rag-kicker">{copy.ragPanel.askKicker}</span>
            <strong>{copy.ragPanel.askHeading}</strong>
            <span>{copy.ragPanel.askHint}</span>
          </div>
        </div>
        <div className="lit-rag-search-box">
          <label className="lit-rag-query-input">
            <SvgIcon name="search" size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.ragPanel.queryPlaceholder} aria-label={copy.ragPanel.queryAria} />
          </label>
          <button type="button" onClick={() => void search()} disabled={Boolean(busy) || !query.trim()}>
            <SvgIcon name="search" size={14} /> {busy === "search" ? copy.ragPanel.searchingShort : copy.ragPanel.searchEvidenceOnly}
          </button>
          <button type="submit" className="primary" disabled={Boolean(busy) || !query.trim()}>
            <SvgIcon name="sparkle" size={14} /> {busy === "answer" ? copy.ragPanel.answeringShort : copy.ragPanel.searchAndAnswer}
          </button>
        </div>
      </form>

      {answer && (
        <section className="lit-rag-answer" aria-label={copy.ragPanel.answerAria2}>
          <div>
            <strong>{copy.ragPanel.answerHeading}</strong>
            <span>{copy.ragPanel.answerHint}</span>
          </div>
          <p>{answer}</p>
          {answerReview && answerReview.findings.length > 0 && (
            <small>{copy.ragPanel.independentReview(answerReview.findings.join("; "))}</small>
          )}
        </section>
      )}

      {searchResult && (
        <div className="lit-rag-results" aria-label={copy.ragPanel.resultsAria}>
          {totalResults === 0 && <p className="lit-note-text">{copy.ragPanel.noHits}</p>}
          {searchResult.knowledge.results.length > 0 && (
            <div className="lit-rag-result-group">
              <div className="lit-rag-result-heading">
                <strong>{copy.ragPanel.confirmedKnowledge}</strong>
                <span>{searchResult.knowledge.results.length}</span>
              </div>
              {searchResult.knowledge.results.map((hit) => (
                <article className="lit-rag-result-card knowledge" key={hit.knowledge.id}>
                  <div className="lit-rag-result-meta">
                    <span>{copy.ragPanel.confirmed}</span>
                    <span>#{hit.rank}</span>
                    {hit.knowledge.kind && <span>{hit.knowledge.kind}</span>}
                  </div>
                  <strong>{hit.knowledge.statement || hit.knowledge.answer}</strong>
                  {hit.knowledge.snippet && <p>{hit.knowledge.snippet}</p>}
                  <div className="lit-rag-citations">
                    {hit.knowledge.evidence.map((evidence, index) => (
                      <button type="button" key={`${evidence.paperId}-${evidence.page}-${index}`} onClick={() => onOpenCitation(evidence.paperId, evidence.page)} title={evidence.quote}>
                        {paperTitle(evidence.paperId)}{evidence.page ? ` · p.${evidence.page}` : ""}
                      </button>
                    ))}
                    {hit.knowledge.evidence.length === 0 && hit.knowledge.sourcePaperId && (
                      <button type="button" onClick={() => onOpenCitation(hit.knowledge.sourcePaperId!)}>{paperTitle(hit.knowledge.sourcePaperId)}</button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {searchResult.literature.results.length > 0 && (
            <div className="lit-rag-result-group">
              <div className="lit-rag-result-heading">
                <strong>{copy.ragPanel.pdfSourceChunks}</strong>
                <span>{searchResult.literature.results.length}</span>
              </div>
              {searchResult.literature.results.map((hit) => (
                <article className="lit-rag-result-card pdf" key={hit.chunk.chunkId}>
                  <div className="lit-rag-result-meta">
                    <span>{hit.chunk.pageSource === "ocr" ? "OCR" : copy.ragPanel.pdfTextTag}</span>
                    <span>p.{hit.chunk.pageStart}</span>
                    {hit.sourceRank && <span>{copy.ragPanel.sourceMatch(hit.sourceRank)}</span>}
                    {hit.cardRank && <span>{copy.ragPanel.cardMatch(hit.cardRank)}</span>}
                    {hit.assetRank && <span>{copy.ragPanel.assetMatch(hit.assetRank)}</span>}
                    {hit.citationRank && <span>{copy.ragPanel.citationMatch(hit.citationRank)}</span>}
                    {hit.metadataRank && <span>{copy.ragPanel.metadataMatch(hit.metadataRank)}</span>}
                    {hit.matchedQueries.length > 0 && <span>{copy.ragPanel.expandedTerms(hit.matchedQueries.slice(0, 2).join(" / "))}</span>}
                  </div>
                  <strong>{paperTitle(hit.chunk.paperId)}</strong>
                  <p>{hit.chunk.text}</p>
                  <button type="button" className="lit-rag-open-page" onClick={() => onOpenCitation(hit.chunk.paperId, hit.chunk.pageStart)}>
                    {copy.ragPanel.openSourcePage} <SvgIcon name="chevronRight" size={13} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {cardBrowserOpen && (
        <RetrievalCardBrowser
          papers={papers}
          paperTitle={paperTitle}
          onOpenCitation={onOpenCitation}
          onClose={() => setCardBrowserOpen(false)}
        />
      )}
    </section>
  );
}

/** Page size for the retrieval-card browser modal. */
const CARD_BROWSER_PAGE_SIZE = 20;

/**
 * Full-screen browser over every generated retrieval card: text filter over the
 * card's structured terms and source text, per-paper narrowing, and offset
 * pagination. Replaces the inline recent-12 inventory list so a large card
 * collection stays reachable.
 */
function RetrievalCardBrowser({
  papers,
  paperTitle,
  onOpenCitation,
  onClose,
}: {
  papers: LiteraturePaper[];
  paperTitle: (paperId: string) => string;
  onOpenCitation: (paperId: string, page?: number) => void;
  onClose: () => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [paperId, setPaperId] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LiteratureRetrievalCardPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Debounce the free-text filter; committing it also resets to the first page.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery(queryInput.trim());
      setOffset(0);
    }, 220);
    return () => clearTimeout(handle);
  }, [queryInput]);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    literatureRagCards({ query, paperId: paperId || undefined, offset, limit: CARD_BROWSER_PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setPage(result);
        setError("");
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, paperId, offset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const paperOptions = useMemo(
    () =>
      [...papers]
        .map((paper) => ({ id: paper.id, title: paper.title || paper.id }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [papers],
  );

  const total = page?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + CARD_BROWSER_PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + CARD_BROWSER_PAGE_SIZE < total;

  return createPortal(
    <div
      className="lit-card-browser-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lit-card-browser-modal" role="dialog" aria-modal="true" aria-label={copy.cardBrowser.dialogAria}>
        <header className="lit-card-browser-head">
          <div className="lit-card-browser-title">
            <span className="lit-rag-section-icon" aria-hidden="true"><SvgIcon name="library" size={15} /></span>
            <div>
              <strong>{copy.cardBrowser.heading}</strong>
              <span>{total > 0 ? copy.cardBrowser.totalCards(total) : copy.cardBrowser.noMatchingCards}</span>
            </div>
          </div>
          <button type="button" className="lit-card-browser-close" onClick={onClose} aria-label={copy.cardBrowser.close}>
            <SvgIcon name="close" size={16} />
          </button>
        </header>

        <div className="lit-card-browser-toolbar">
          <label className="lit-card-browser-search">
            <SvgIcon name="search" size={14} />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={copy.cardBrowser.filterPlaceholder}
              aria-label={copy.cardBrowser.filterAria}
            />
            {queryInput && (
              <button type="button" onClick={() => setQueryInput("")} aria-label={copy.cardBrowser.clearFilterAria}>
                <SvgIcon name="close" size={12} />
              </button>
            )}
          </label>
          <select
            className="lit-card-browser-paper"
            value={paperId}
            onChange={(event) => {
              setPaperId(event.target.value);
              setOffset(0);
            }}
            aria-label={copy.cardBrowser.filterByPaperAria}
          >
            <option value="">{copy.cardBrowser.allPapers}</option>
            {paperOptions.map((paper) => (
              <option key={paper.id} value={paper.id}>{paper.title}</option>
            ))}
          </select>
        </div>

        <div className="lit-card-browser-body">
          {error ? (
            <p className="lit-rag-database-error">{copy.cardBrowser.readFailedPrefix}{error}</p>
          ) : loading && !page ? (
            <div className="lit-card-browser-empty"><span className="lit-search-spinner" aria-hidden="true" /> {copy.cardBrowser.loadingCards}</div>
          ) : total === 0 ? (
            <div className="lit-card-browser-empty">
              {query || paperId ? copy.cardBrowser.noMatchHint : copy.cardBrowser.noCardsYet}
            </div>
          ) : (
            <div className={`lit-card-browser-list${loading ? " loading" : ""}`}>
              {(page?.cards ?? []).map((preview) => (
                <RetrievalCardPreviewItem
                  key={preview.chunkId}
                  preview={preview}
                  paperTitle={paperTitle}
                  onOpenCitation={onOpenCitation}
                />
              ))}
            </div>
          )}
        </div>

        {total > CARD_BROWSER_PAGE_SIZE && (
          <footer className="lit-card-browser-foot">
            <span>{rangeStart}–{rangeEnd} / {total}</span>
            <div className="lit-card-browser-pager">
              <button
                type="button"
                onClick={() => setOffset((value) => Math.max(0, value - CARD_BROWSER_PAGE_SIZE))}
                disabled={!hasPrev || loading}
              >
                <SvgIcon name="chevronLeft" size={13} /> {copy.cardBrowser.prevPage}
              </button>
              <button
                type="button"
                onClick={() => setOffset((value) => value + CARD_BROWSER_PAGE_SIZE)}
                disabled={!hasNext || loading}
              >
                {copy.cardBrowser.nextPage} <SvgIcon name="chevronRight" size={13} />
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────

export default function Literature({
  pageView: controlledPageView,
  onPageViewChange,
}: LiteratureProps = {}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const currentProject = useStore((s) => s.currentProject);
  const setTab = useStore((s) => s.setTab);
  const setPendingChatInput = useStore((s) => s.setPendingChatInput);
  const library = useLiteratureStore((s) => s.library);
  const loaded = useLiteratureStore((s) => s.loaded);
  const briefing = useLiteratureStore((s) => s.briefing);
  const generatingAnswerChains = useLiteratureStore((s) => s.generatingAnswerChains);
  const storeError = useLiteratureStore((s) => s.error);
  const load = useLiteratureStore((s) => s.load);
  const watchAgentActivity = useLiteratureStore((s) => s.watchAgentActivity);
  const setStage = useLiteratureStore((s) => s.setStage);
  const deletePapers = useLiteratureStore((s) => s.deletePapers);
  const toggleStar = useLiteratureStore((s) => s.toggleStar);
  const markRead = useLiteratureStore((s) => s.markRead);
  const addTags = useLiteratureStore((s) => s.addTags);
  const updatePaperMetadata = useLiteratureStore((s) => s.updatePaperMetadata);
  const ensureCitationKeys = useLiteratureStore((s) => s.ensureCitationKeys);
  const addCollection = useLiteratureStore((s) => s.addCollection);
  const removeCollection = useLiteratureStore((s) => s.removeCollection);
  const saveDynamicSearch = useLiteratureStore((s) => s.saveDynamicSearch);
  const toggleCollection = useLiteratureStore((s) => s.toggleCollection);
  const generateBrief = useLiteratureStore((s) => s.generateBrief);
  const generateAnswerChains = useLiteratureStore((s) => s.generateAnswerChains);
  const deleteEvidence = useLiteratureStore((s) => s.deleteEvidence);
  const updateAnswerChain = useLiteratureStore((s) => s.updateAnswerChain);
  const addPdfAnnotation = useLiteratureStore((s) => s.addPdfAnnotation);
  const updatePdfAnnotation = useLiteratureStore((s) => s.updatePdfAnnotation);
  const deletePdfAnnotation = useLiteratureStore((s) => s.deletePdfAnnotation);
  const addAttachment = useLiteratureStore((s) => s.addAttachment);
  const removeAttachment = useLiteratureStore((s) => s.removeAttachment);
  const setPrimaryPdfAttachment = useLiteratureStore((s) => s.setPrimaryPdfAttachment);
  const importAttachment = useLiteratureStore((s) => s.importAttachment);
  const addNote = useLiteratureStore((s) => s.addNote);
  const updateNote = useLiteratureStore((s) => s.updateNote);
  const deleteNote = useLiteratureStore((s) => s.deleteNote);
  const createNoteFromAnnotation = useLiteratureStore((s) => s.createNoteFromAnnotation);
  const importAnnotations = useLiteratureStore((s) => s.importAnnotations);
  const downloadPdf = useLiteratureStore((s) => s.downloadPdf);
  const uploadPdf = useLiteratureStore((s) => s.uploadPdf);
  const openPdf = useLiteratureStore((s) => s.openPdf);
  const setError = useLiteratureStore((s) => s.setError);
  const logActivity = useLiteratureStore((s) => s.logActivity);

  const [view, setView] = useState("all");
  const [localPageView, setLocalPageView] = useState<LiteraturePageView>("library");
  const [filter, setFilter] = useState("");
  const [fullTextMatchIds, setFullTextMatchIds] = useState<Set<string> | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<LiteratureDuplicateCandidate[]>([]);
  const [pdfDragging, setPdfDragging] = useState(false);
  const [sort, setSort] = useState<SortKey>("added");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionCleared, setSelectionCleared] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<DetailTab>("info");
  const [tagDraft, setTagDraft] = useState("");
  const [abstractOpen, setAbstractOpen] = useState(true);
  const [colInput, setColInput] = useState("");
  const [colAddingParentId, setColAddingParentId] = useState<string | null>(null);
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set());
  const [readerPage, setReaderPage] = useState(1);
  const [readerAnnotationId, setReaderAnnotationId] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<LiteratureStorageStatus | null>(null);
  const [creatingStorageBackup, setCreatingStorageBackup] = useState(false);
  const [panelWidths, setPanelWidths] = useState({ sidebar: 220, workspace: 336 });
  const panelDragRef = useRef<{ panel: "sidebar" | "workspace"; startX: number; startW: number } | null>(null);
  const pageView = controlledPageView ?? localPageView;
  const setPageView = onPageViewChange ?? setLocalPageView;
  const showLocalViewTabs = !onPageViewChange;

  const startPanelResize = (panel: "sidebar" | "workspace", e: { clientX: number; preventDefault(): void }) => {
    e.preventDefault();
    panelDragRef.current = { panel, startX: e.clientX, startW: panelWidths[panel] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      if (!panelDragRef.current) return;
      const delta = ev.clientX - panelDragRef.current.startX;
      const minWidth = panel === "sidebar" ? 180 : 280;
      const maxWidth = panel === "sidebar" ? 420 : 560;
      const requestedWidth = panelDragRef.current.startW + (panel === "sidebar" ? delta : -delta);
      const newW = Math.min(maxWidth, Math.max(minWidth, requestedWidth));
      setPanelWidths((prev) => ({ ...prev, [panelDragRef.current!.panel]: newW }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      panelDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    setSelectedId(null);
    setSelectionCleared(false);
    setChecked(new Set());
    void load(projectId);
  }, [load, projectId]);

  useEffect(() => watchAgentActivity(), [watchAgentActivity]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setPdfDragging(true);
          return;
        }
        setPdfDragging(false);
        if (event.payload.type !== "drop") return;
        const sourcePath = event.payload.paths.find((path) => path.toLocaleLowerCase().endsWith(".pdf"));
        if (!sourcePath) return;
        void literatureImportPdfAsRecord<{ record: { recordId: string } }>(sourcePath)
          .then(async (result) => {
            await load(projectId, { quiet: true });
            setSelectedId(result.record.recordId);
            logActivity("ok", copy.dialogs.pdfDropImported);
          })
          .catch((error) => {
            const message = copy.dialogs.pdfDropImportFailed(String(error));
            setError(message);
            logActivity("error", message);
          });
      }))
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load, logActivity, projectId, setError]);

  const papers = library.papers;

  const refreshStorageStatus = async () => {
    if (!isTauri()) {
      setStorageStatus(null);
      return;
    }
    try {
      setStorageStatus(await literatureStorageStatus<LiteratureStorageStatus>());
    } catch {
      setStorageStatus(null);
    }
  };

  useEffect(() => {
    let disposed = false;
    if (!isTauri()) {
      setStorageStatus(null);
      return () => { disposed = true; };
    }
    void literatureStorageStatus<LiteratureStorageStatus>()
      .then((nextStatus) => {
        if (!disposed) setStorageStatus(nextStatus);
      })
      .catch(() => {
        if (!disposed) setStorageStatus(null);
      });
    return () => { disposed = true; };
  }, [library.searches.length, papers.length, projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setDuplicateCandidates([]);
      return () => { cancelled = true; };
    }
    void literatureDuplicateCandidates<LiteratureDuplicateCandidate[]>()
      .then((candidates) => {
        if (!cancelled) setDuplicateCandidates(candidates);
      })
      .catch(() => {
        if (!cancelled) setDuplicateCandidates([]);
      });
    return () => { cancelled = true; };
  }, [papers.length, projectId]);

  const createStorageBackup = async () => {
    if (!isTauri() || creatingStorageBackup) return;
    setCreatingStorageBackup(true);
    try {
      await literatureStorageBackup();
      await refreshStorageStatus();
      logActivity("ok", copy.dialogs.backupCreated);
    } catch (error) {
      const message = copy.dialogs.backupFailed(String(error));
      setError(message);
      logActivity("error", message);
    } finally {
      setCreatingStorageBackup(false);
    }
  };

  const importBibliography = async () => {
    if (!isTauri()) return;
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: copy.dialogs.bibliographyExportsFilter, extensions: ["json", "ris", "bib", "bibtex", "biblatex"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const report = await literatureImportBibliography<{
        imported: number;
        merged: number;
        skipped: number;
        attachments?: number;
        notes?: number;
        annotations?: number;
        collections?: number;
        warnings?: string[];
        format: string;
      }>({ sourcePath: selected });
      await load(projectId, { quiet: true });
      const migratedChildren = [
        report.attachments ? copy.dialogs.attachmentsMigrated(report.attachments) : "",
        report.notes ? copy.dialogs.notesMigrated(report.notes) : "",
        report.annotations ? copy.dialogs.annotationsMigrated(report.annotations) : "",
        report.collections ? copy.dialogs.collectionsMigrated(report.collections) : "",
      ].filter(Boolean);
      const warningSummary = report.warnings?.length
        ? copy.dialogs.warningsSummary(report.warnings.length, report.warnings[0])
        : "";
      logActivity(
        "ok",
        copy.dialogs.bibliographyImported({
          format: report.format,
          imported: report.imported,
          merged: report.merged,
          migratedChildren: migratedChildren.join(language === "cn" ? "、" : ", "),
          skipped: report.skipped,
          warningSummary,
        }),
      );
    } catch (error) {
      const message = copy.dialogs.bibliographyImportFailed(String(error));
      setError(message);
      logActivity("error", message);
    }
  };

  const importPdfAsRecord = async () => {
    if (!isTauri()) return;
    try {
      const selected = await openDialog({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!selected || Array.isArray(selected)) return;
      const result = await literatureImportPdfAsRecord<{ record: { recordId: string } }>(selected);
      await load(projectId, { quiet: true });
      setSelectedId(result.record.recordId);
      logActivity("ok", copy.dialogs.pdfImported);
    } catch (error) {
      const message = copy.dialogs.pdfImportFailed(String(error));
      setError(message);
      logActivity("error", message);
    }
  };

  const addIdentifier = async () => {
    if (!isTauri()) return;
    const identifier = window.prompt(copy.dialogs.doiIsbnPrompt);
    if (!identifier?.trim()) return;
    try {
      const result = await literatureAddIdentifier<{ papers?: Array<{ id: string }> }>(identifier);
      await load(projectId, { quiet: true });
      if (result.papers?.[0]?.id) setSelectedId(result.papers[0].id);
      logActivity("ok", copy.dialogs.identifierAdded);
    } catch (error) {
      const message = copy.dialogs.identifierFailed(String(error));
      setError(message);
      logActivity("error", message);
    }
  };

  const dynamicSearchQuery = view.startsWith("search:")
    ? library.searches.find((search) => search.id === view.slice(7) && search.dynamic)?.query ?? ""
    : "";
  const fullTextQuery = dynamicSearchQuery || filter;

  useEffect(() => {
    const query = fullTextQuery.trim();
    if (!query || !isTauri()) {
      setFullTextMatchIds(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void literatureFullTextSearch<{ papers: Array<{ id: string }> }>(query, 250)
        .then((result) => {
          if (!cancelled) setFullTextMatchIds(new Set(result.papers.map((paper) => paper.id)));
        })
        .catch(() => {
          if (!cancelled) setFullTextMatchIds(null);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fullTextQuery, projectId]);

  const visiblePapers = useMemo(() => {
    const needle = fullTextQuery.trim().toLowerCase();
    let viewFilter: (p: LiteraturePaper) => boolean;
    if (view.startsWith("col:")) {
      const colId = view.slice(4);
      const allIds = descendantCollectionIds(library.collections, colId);
      viewFilter = (p) => p.collectionIds.some((id) => allIds.has(id));
    } else if (view === "duplicates") {
      const duplicateIds = new Set(
        duplicateCandidates.flatMap((candidate) => [candidate.primaryRecordId, candidate.duplicateRecordId]),
      );
      viewFilter = (paper) => duplicateIds.has(paper.id);
    } else if (dynamicSearchQuery) {
      viewFilter = () => true;
    } else {
      viewFilter = (p) => matchesView(p, view);
    }
    return sortPapers(
      papers.filter((p) => viewFilter(p) && (fullTextMatchIds ? fullTextMatchIds.has(p.id) : matchesQuery(p, needle))),
      sort,
    );
  }, [duplicateCandidates, dynamicSearchQuery, fullTextMatchIds, fullTextQuery, library.collections, papers, sort, view]);

  const saveCurrentFilter = () => {
    const id = saveDynamicSearch(filter);
    if (!id) return;
    setView(`search:${id}`);
    setFilter("");
    logActivity("ok", copy.activity.dynamicSearchSaved(filter.trim()));
  };

  const selectedPaper = selectedId
    ? visiblePapers.find((p) => p.id === selectedId) ?? null
    : selectionCleared
      ? null
      : visiblePapers[0] ?? null;

  useEffect(() => {
    setAbstractOpen(true);
  }, [selectedPaper?.id]);

  const stageCounts = useMemo(() => {
    const counts = new Map<PaperStage, number>();
    for (const p of papers) counts.set(p.stage, (counts.get(p.stage) ?? 0) + 1);
    return counts;
  }, [papers]);

  const downloadedCount = useMemo(
    () => papers.filter((p) => p.pdf.status === "downloaded").length,
    [papers],
  );

  const openAgentChat = (input: string) => {
    setPendingChatInput(input);
    setTab("chat");
  };

  const openBrowserDownload = (paper: LiteraturePaper) => {
    const landingPage = paper.url
      ?? (paper.doi ? `https://doi.org/${paper.doi}` : undefined)
      ?? (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : undefined)
      ?? "unknown";
    openAgentChat(copy.dialogs.browserDownloadPrompt({
      paperId: paper.id,
      title: paper.title,
      landingPage,
      doi: paper.doi ?? "unknown",
    }));
  };

  const downloadOrBrowse = async (id: string) => {
    const paper = library.papers.find((entry) => entry.id === id);
    if (!paper) return;
    if (paper.pdf.status === "downloaded" && paper.pdf.path) {
      setSelectedId(id);
      setSelectionCleared(false);
      setReaderPage(1);
      setWorkspaceTab("reader");
      return;
    }
    if (!paper.pdf.url) {
      openBrowserDownload(paper);
      return;
    }
    await downloadPdf(id);
  };

  const uploadSelectedPdf = async (id: string) => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected === "string") await uploadPdf(id, selected);
  };

  const openRagCitation = (paperId: string, page?: number) => {
    const paper = library.papers.find((entry) => entry.id === paperId);
    if (!paper) {
      setError(copy.dialogs.ragCitationMissing(paperId));
      return;
    }
    setPageView("library");
    setView("all");
    setFilter("");
    setFullTextMatchIds(null);
    setSelectedId(paper.id);
    setSelectionCleared(false);
    if (page && paper.pdf.path) {
      setReaderPage(page);
      setReaderAnnotationId(null);
      setWorkspaceTab("reader");
    } else {
      setWorkspaceTab("evidence");
      if (page && !paper.pdf.path) {
        setError(copy.dialogs.ragCitationNoLocalPdf(page));
      }
    }
  };

  const importSelectedAttachment = async (
    id: string,
    kind: Exclude<LiteratureAttachment["kind"], "externalLink">,
  ) => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: copy.dialogs.researchFilesFilter, extensions: ["pdf", "txt", "md", "html", "htm", "json", "csv", "docx", "xlsx", "zip"] }],
    });
    if (typeof selected !== "string") return;
    const inferredKind = kind === "supplement" && selected.toLowerCase().endsWith(".pdf") ? "pdf" : kind;
    await importAttachment(id, selected, inferredKind);
  };

  const addExternalAttachment = (id: string) => {
    const url = window.prompt(copy.dialogs.externalLinkPrompt)?.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
      const label = window.prompt(copy.dialogs.linkLabelPrompt, parsed.hostname)?.trim() || parsed.hostname;
      addAttachment(id, { label, kind: "externalLink", url: parsed.toString() });
    } catch {
      setError(copy.dialogs.invalidLinkError);
    }
  };

  const openAttachment = async (paper: LiteraturePaper, attachment: LiteratureAttachment) => {
    if (attachment.kind === "externalLink" && attachment.url) {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (attachment.externalPath) {
      setError(copy.dialogs.zoteroAttachmentExternal(attachment.externalPath));
      return;
    }
    if (!attachment.path) return;
    if (attachment.kind === "pdf") {
      setPrimaryPdfAttachment(paper.id, attachment.id);
      setReaderPage(1);
      setReaderAnnotationId(null);
      setWorkspaceTab("reader");
      return;
    }
    try {
      await literatureAttachmentOpen(attachment.path);
    } catch (error) {
      setError(copy.dialogs.openAttachmentFailed(String(error)));
    }
  };

  const exportPaperAnnotations = async (paper: LiteraturePaper) => {
    const destination = await saveDialog({
      defaultPath: `${paper.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "paper"}-annotations.json`,
      filters: [{ name: copy.dialogs.somniqAnnotationsFilter, extensions: ["json"] }],
    });
    if (typeof destination !== "string") return;
    try {
      await literatureWriteAnnotationExport(destination, {
        version: 1,
        exportedAt: new Date().toISOString(),
        paper: { id: paper.id, title: paper.title },
        annotations: paper.pdfAnnotations,
        notes: paper.notes ?? [],
      });
      logActivity("ok", copy.dialogs.annotationsExported(paper.pdfAnnotations.length, (paper.notes ?? []).length));
    } catch (error) {
      setError(copy.dialogs.annotationsExportFailed(String(error)));
    }
  };

  const importPaperAnnotations = async (paper: LiteraturePaper) => {
    const source = await openDialog({
      multiple: false,
      filters: [{ name: copy.dialogs.somniqAnnotationsFilter, extensions: ["json"] }],
    });
    if (typeof source !== "string") return;
    try {
      const payload = await literatureReadAnnotationExport<unknown>(source);
      const imported = importAnnotations(paper.id, payload);
      if (imported.annotations === 0 && imported.notes === 0) {
        setError(copy.dialogs.noImportableAnnotations);
        return;
      }
      logActivity("ok", copy.dialogs.annotationsImported(imported.annotations, imported.notes));
    } catch (error) {
      setError(copy.dialogs.annotationsImportFailed(String(error)));
    }
  };

  const exportPaperBibliography = async (paper: LiteraturePaper, format: BibliographyExportFormat) => {
    const extensions: Record<BibliographyExportFormat, string> = {
      bibtex: "bib",
      biblatex: "bib",
      ris: "ris",
      "csl-json": "json",
    };
    const labels: Record<BibliographyExportFormat, string> = {
      bibtex: "BibTeX",
      biblatex: "BibLaTeX",
      ris: "RIS",
      "csl-json": "CSL-JSON",
    };
    try {
      const keys = await ensureCitationKeys([paper.id]);
      const key = keys[paper.id] ?? paper.citationKey ?? "reference";
      const destination = await saveDialog({
        defaultPath: `${key}.${extensions[format]}`,
        filters: [{ name: labels[format], extensions: [extensions[format]] }],
      });
      if (typeof destination !== "string") return;
      const exported = await literatureExportBibliography<{
        content: string;
        exported: number;
      }>({ format, recordIds: [paper.id] });
      await literatureWriteBibliographyExport(destination, exported.content);
      logActivity("ok", copy.dialogs.bibliographyExported(exported.exported, labels[format]));
    } catch (error) {
      setError(copy.dialogs.bibliographyExportFailed(String(error)));
    }
  };

  const selectPaper = (paper: LiteraturePaper) => {
    setSelectedId(paper.id);
    setSelectionCleared(false);
    if (paper.unread) markRead(paper.id);
  };

  const toggleChecked = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const batchIds = Array.from(checked);
  const runBatch = (action: (ids: string[]) => void) => {
    if (batchIds.length === 0) return;
    action(batchIds);
    setChecked(new Set());
  };

  const confirmDeletePapers = (ids: string[]) => {
    if (ids.length === 0) return;
    const label = ids.length === 1 ? copy.dialogs.deletePapersLabelSingle : copy.dialogs.deletePapersLabelMany(ids.length);
    if (!window.confirm(copy.dialogs.deletePapersConfirm(label))) return;
    deletePapers(ids);
    setChecked((cur) => {
      const next = new Set(cur);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (selectedId && ids.includes(selectedId)) {
      setSelectedId(null);
      setSelectionCleared(false);
    }
  };

  const mergeSelectedDuplicates = async () => {
    if (!isTauri() || batchIds.length !== 2) return;
    const [primaryId, duplicateId] = batchIds;
    const primary = papers.find((paper) => paper.id === primaryId);
    const duplicate = papers.find((paper) => paper.id === duplicateId);
    if (!window.confirm(copy.dialogs.mergeDuplicatesConfirm(duplicate?.title ?? duplicateId, primary?.title ?? primaryId))) return;
    try {
      await literatureMergeDuplicates(primaryId, duplicateId);
      setChecked(new Set());
      setSelectedId(primaryId);
      await load(projectId, { quiet: true });
      logActivity("ok", copy.dialogs.mergeDuplicatesDone);
    } catch (error) {
      const message = copy.dialogs.mergeDuplicatesFailed(String(error));
      setError(message);
      logActivity("error", message);
    }
  };

  const addTagToSelected = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (!tag || !selectedPaper) return;
    addTags([selectedPaper.id], [tag]);
    setTagDraft("");
  };

  // ── Sidebar ────────────────────────────────────────────────────────────────

  const submitColInput = (parentId?: string) => {
    const trimmed = colInput.trim();
    if (trimmed) addCollection(trimmed, parentId);
    setColInput("");
    setColAddingParentId(null);
  };

  const toggleColExpand = (id: string) =>
    setExpandedCols((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const renderCollectionNode = (collection: LiteratureCollection, depth: number): ReactNode => {
    const children = library.collections.filter((candidate) => candidate.parentId === collection.id);
    const descendantIds = descendantCollectionIds(library.collections, collection.id);
    const isExpanded = expandedCols.has(collection.id);
    const count = papers.filter((paper) => paper.collectionIds.some((id) => descendantIds.has(id))).length;
    return (
      <div key={collection.id} className="lit-col-group" style={{ marginLeft: depth * 14 }}>
        <div className="lit-col-row">
          <button
            type="button"
            className="lit-col-toggle"
            onClick={() => toggleColExpand(collection.id)}
            aria-label={isExpanded ? copy.sidebar.collapseCollection : copy.sidebar.expandCollection}
          >
            {children.length > 0 && <SvgIcon name={isExpanded ? "chevronDown" : "chevronRight"} size={12} />}
          </button>
          <NavItem
            label={collection.label}
            icon={depth === 0 ? "collection" : "circle"}
            count={count}
            active={view === `col:${collection.id}`}
            onClick={() => setView(`col:${collection.id}`)}
          />
          <button
            type="button"
            className="lit-col-add-sub-btn"
            title={copy.sidebar.addSubcollection}
            onClick={() => {
              setColAddingParentId(collection.id);
              setColInput("");
              setExpandedCols((previous) => new Set(previous).add(collection.id));
            }}
          ><SvgIcon name="plus" size={13} /></button>
          <button
            type="button"
            className="lit-col-delete-btn"
            aria-label={copy.sidebar.deleteCollectionAria(collection.label)}
            onClick={() => {
              if (!window.confirm(copy.sidebar.deleteCollectionConfirm(collection.label))) return;
              const removed = descendantCollectionIds(library.collections, collection.id);
              removeCollection(collection.id);
              if (view.startsWith("col:") && removed.has(view.slice(4))) setView("all");
            }}
          ><SvgIcon name="close" size={13} /></button>
        </div>
        {isExpanded && (
          <>
            {children.map((child) => renderCollectionNode(child, depth + 1))}
            {colAddingParentId === collection.id && (
              <div className="lit-col-input-row" style={{ marginLeft: 16 }}>
                <input
                  autoFocus
                  className="lit-col-input"
                  value={colInput}
                  placeholder={copy.sidebar.subcollectionNamePlaceholder}
                  onChange={(event) => setColInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitColInput(collection.id);
                    if (event.key === "Escape") { setColInput(""); setColAddingParentId(null); }
                  }}
                />
                <button type="button" className="lit-col-confirm-btn" onClick={() => submitColInput(collection.id)}><SvgIcon name="check" size={14} /></button>
                <button type="button" className="lit-col-cancel-btn" onClick={() => { setColInput(""); setColAddingParentId(null); }}><SvgIcon name="close" size={14} /></button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const sidebar = (
    <aside className="lit-sidebar">
      <div className="lit-sidebar-header">
        <span className="lit-sidebar-title">{copy.sidebar.filterTitle}</span>
      </div>

      <div className="lit-sidebar-section">
        <div className="lit-section-header">
          <span className="lit-section-label">{copy.sidebar.statusLabel}</span>
        </div>
        <NavItem
          label={copy.sidebar.allPapers}
          icon="library"
          count={papers.filter((p) => p.stage !== "excluded").length}
          active={view === "all"}
          onClick={() => setView("all")}
        />
        <NavItem
          label={copy.sidebar.starred}
          icon="star"
          count={papers.filter((p) => p.starred).length}
          active={view === "starred"}
          onClick={() => setView("starred")}
        />
        <NavItem
          label={copy.sidebar.duplicates}
          icon="library"
          count={duplicateCandidates.length}
          active={view === "duplicates"}
          onClick={() => setView("duplicates")}
        />
        {STAGES_NAV.filter((s) => s.alwaysVisible || (stageCounts.get(s.id) ?? 0) > 0).map(
          (stage) => (
            <NavItem
              key={stage.id}
              label={stageLabels(copy)[stage.id]}
              icon={STAGE_ICONS[stage.id]}
              count={stageCounts.get(stage.id) ?? 0}
              active={view === `stage:${stage.id}`}
              onClick={() => setView(`stage:${stage.id}`)}
              dot={stage.id}
            />
          ),
        )}
      </div>

      <NavSection
        title={copy.sidebar.categoriesTitle}
        defaultOpen
        extra={
          <button
            type="button"
            className="lit-section-icon-btn"
            onClick={() => { setColAddingParentId(""); setColInput(""); }}
            title={copy.sidebar.addTopCategory}
          ><SvgIcon name="plus" size={14} /></button>
        }
      >
        {colAddingParentId === "" && (
          <div className="lit-col-input-row">
            <input
              autoFocus
              className="lit-col-input"
              value={colInput}
              placeholder={copy.sidebar.categoryNamePlaceholder}
              onChange={(e) => setColInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitColInput();
                if (e.key === "Escape") { setColInput(""); setColAddingParentId(null); }
              }}
            />
            <button type="button" className="lit-col-confirm-btn" onClick={() => submitColInput()} title={copy.sidebar.confirm}><SvgIcon name="check" size={14} /></button>
            <button type="button" className="lit-col-cancel-btn" onClick={() => { setColInput(""); setColAddingParentId(null); }} title={copy.sidebar.cancel}><SvgIcon name="close" size={14} /></button>
          </div>
        )}

        {false && <>{library.collections.filter((c) => !c.parentId).map((col) => {
          const children = library.collections.filter((c) => c.parentId === col.id);
          const isExpanded = expandedCols.has(col.id);
          const parentCount = papers.filter((p) => {
            const childIds = children.map((c) => c.id);
            return p.collectionIds.includes(col.id) || childIds.some((id) => p.collectionIds.includes(id));
          }).length;
          return (
            <div key={col.id} className="lit-col-group">
              <div className="lit-col-row">
                <button
                  type="button"
                  className="lit-col-toggle"
                  onClick={() => toggleColExpand(col.id)}
                  aria-label={isExpanded ? copy.sidebar.collapseCollection : copy.sidebar.expandCollection}
                >
                  {children.length > 0 && <SvgIcon name={isExpanded ? "chevronDown" : "chevronRight"} size={12} />}
                </button>
                <NavItem
                  label={col.label}
                  icon="collection"
                  count={parentCount}
                  active={view === `col:${col.id}`}
                  onClick={() => setView(`col:${col.id}`)}
                />
                <button
                  type="button"
                  className="lit-col-add-sub-btn"
                  title={copy.sidebar.addSubcollection}
                  onClick={() => {
                    setColAddingParentId(col.id);
                    setColInput("");
                    setExpandedCols((prev) => { const n = new Set(prev); n.add(col.id); return n; });
                  }}
                ><SvgIcon name="plus" size={13} /></button>
                <button
                  type="button"
                  className="lit-col-delete-btn"
                  onClick={() => {
                    const msg = copy.sidebar.deleteCollectionConfirm(col.label);
                    if (window.confirm(msg)) {
                      removeCollection(col.id);
                      if (view === `col:${col.id}` || children.some((c) => view === `col:${c.id}`)) setView("all");
                    }
                  }}
                  aria-label={copy.sidebar.deleteCollectionAria(col.label)}
                ><SvgIcon name="close" size={13} /></button>
              </div>

              {isExpanded && (
                <>
                  {children.map((child) => (
                    <div key={child.id} className="lit-col-row lit-col-child-row">
                      <NavItem
                        label={child.label}
                        icon="circle"
                        count={papers.filter((p) => p.collectionIds.includes(child.id)).length}
                        active={view === `col:${child.id}`}
                        onClick={() => setView(`col:${child.id}`)}
                      />
                      <button
                        type="button"
                        className="lit-col-delete-btn"
                        onClick={() => {
                          if (window.confirm(copy.sidebar.deleteCollectionConfirm(child.label))) {
                            removeCollection(child.id);
                            if (view === `col:${child.id}`) setView(`col:${col.id}`);
                          }
                        }}
                        aria-label={copy.sidebar.deleteCollectionAria(child.label)}
                      ><SvgIcon name="close" size={13} /></button>
                    </div>
                  ))}
                  {colAddingParentId === col.id && (
                    <div className="lit-col-input-row lit-col-child-input-row">
                      <input
                        autoFocus
                        className="lit-col-input"
                        value={colInput}
                        placeholder={copy.sidebar.subcollectionNamePlaceholder}
                        onChange={(e) => setColInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitColInput(col.id);
                          if (e.key === "Escape") { setColInput(""); setColAddingParentId(null); }
                        }}
                      />
                      <button type="button" className="lit-col-confirm-btn" onClick={() => submitColInput(col.id)}><SvgIcon name="check" size={14} /></button>
                      <button type="button" className="lit-col-cancel-btn" onClick={() => { setColInput(""); setColAddingParentId(null); }}><SvgIcon name="close" size={14} /></button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}</>}

        {library.collections.filter((collection) => !collection.parentId).map((collection) =>
          renderCollectionNode(collection, 0),
        )}

        {library.collections.filter((c) => !c.parentId).length === 0 && colAddingParentId === null && (
          <div className="lit-col-empty">{copy.sidebar.noCategories}</div>
        )}
      </NavSection>

      <NavSection title={copy.sidebar.savedSearchesTitle} defaultOpen>
        {library.searches.map((search) => (
          <NavItem
            key={search.id}
            label={search.query}
            icon="search"
            count={papers.filter((paper) => paper.searchIds.includes(search.id)).length}
            active={view === `search:${search.id}`}
            onClick={() => setView(`search:${search.id}`)}
          />
        ))}
        {library.searches.length === 0 && <div className="lit-col-empty">{copy.sidebar.noSavedSearches}</div>}
      </NavSection>

    </aside>
  );

  // ── Main area ──────────────────────────────────────────────────────────────

  const viewLabel = (() => {
    if (view === "duplicates") return copy.viewLabel.duplicates;
    if (view === "all") return copy.viewLabel.allPapers;
    if (view === "starred") return copy.viewLabel.starred;
    if (view.startsWith("stage:")) return stageLabels(copy)[view.slice(6) as PaperStage] ?? copy.viewLabel.papersFallback;
    if (view.startsWith("col:")) {
      const col = library.collections.find((c) => `col:${c.id}` === view);
      return col?.label ?? copy.viewLabel.categoryFallback;
    }
    if (view.startsWith("search:")) {
      return library.searches.find((search) => `search:${search.id}` === view)?.query ?? copy.viewLabel.savedSearchFallback;
    }
    return copy.viewLabel.papersFallback;
  })();

  const mainArea = (
    <div className={`lit-main${pdfDragging ? " lit-pdf-drop-active" : ""}`}>
      <PaperTable
        papers={visiblePapers}
        libraryCount={papers.length}
        loaded={loaded}
        filter={filter}
        sort={sort}
        checked={checked}
        selectedId={selectedPaper?.id ?? null}
        viewLabel={viewLabel}
        onFilterChange={setFilter}
        onSaveDynamicSearch={saveCurrentFilter}
        onSortChange={setSort}
        onSelectPaper={selectPaper}
        onToggleChecked={toggleChecked}
        onToggleStar={toggleStar}
        batchIds={batchIds}
        onBatchShortlist={() => runBatch((ids) => setStage(ids, "shortlist"))}
        onBatchExclude={() => runBatch((ids) => setStage(ids, "excluded"))}
        onBatchDownload={() => runBatch((ids) => { for (const id of ids) void downloadOrBrowse(id); })}
        onBatchDelete={() => confirmDeletePapers(batchIds)}
        onBatchMergeDuplicates={() => void mergeSelectedDuplicates()}
        onBatchClear={() => setChecked(new Set())}
        onImportBibliography={() => void importBibliography()}
        onImportPdf={() => void importPdfAsRecord()}
        onAddIdentifier={() => void addIdentifier()}
      />
    </div>
  );

  // ── Info panel (Zotero-style right panel) ─────────────────────────────────

  const workspace = (
    <section className="lit-workspace">
      {selectedPaper ? (
        <>
          {/* Zotero-style title header */}
          <div className="lit-info-header">
            <div className="lit-info-title-block">
              <div className="lit-info-paper-title">{selectedPaper.title}</div>
              <div className="lit-info-paper-sub">
                {formatAuthors(copy, selectedPaper.authors)}
                {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
                {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
              </div>
            </div>
            <div className="lit-workspace-header-btns">
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title={selectedPaper.pdf.status === "downloaded" ? copy.workspaceHeader.openPdf : copy.workspaceHeader.getPdf}
                aria-label={selectedPaper.pdf.status === "downloaded" ? copy.workspaceHeader.openSelectedPaperPdfAria : copy.workspaceHeader.getSelectedPaperPdfAria}
                onClick={() => void downloadOrBrowse(selectedPaper.id)}
                disabled={selectedPaper.pdf.status === "downloading"}
              ><SvgIcon name="target" size={16} /></button>
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title={copy.workspaceHeader.openInChat}
                onClick={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
              ><SvgIcon name="externalLink" size={16} /></button>
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title={copy.workspaceHeader.clearSelection}
                aria-label={copy.workspaceHeader.clearSelection}
                onClick={() => { setSelectedId(null); setSelectionCleared(true); }}
              ><SvgIcon name="close" size={16} /></button>
            </div>
          </div>

          <div className="lit-workspace-tabs" role="tablist">
            {(
              [
                { id: "info", label: copy.workspaceHeader.tabInfo },
                { id: "overview", label: copy.workspaceHeader.tabOverview },
                { id: "reader", label: copy.workspaceHeader.tabReader },
                { id: "evidence", label: copy.workspaceHeader.tabEvidence },
                { id: "notes", label: copy.workspaceHeader.tabNotes },
                { id: "files", label: copy.workspaceHeader.tabFiles },
              ] as Array<{ id: DetailTab; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={workspaceTab === t.id}
                className={`lit-workspace-tab${workspaceTab === t.id ? " active" : ""}`}
                onClick={() => setWorkspaceTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="lit-workspace-content">
            {workspaceTab === "info" && (
              <InfoTab
                paper={selectedPaper}
                collections={library.collections}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onAddTag={addTagToSelected}
                onOpenReader={() => void downloadOrBrowse(selectedPaper.id)}
                onAsk={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
                onViewEvidence={() => setWorkspaceTab("evidence")}
                onViewOverview={() => setWorkspaceTab("overview")}
                onShortlist={() => setStage([selectedPaper.id], "shortlist")}
                onUpdateMetadata={(patch) => updatePaperMetadata(selectedPaper.id, patch)}
                onToggleCollection={(colId) => toggleCollection(selectedPaper.id, colId)}
                onDelete={() => {
                  if (window.confirm(copy.dialogs.deletePaperByTitleConfirm(selectedPaper.title))) {
                    deletePapers([selectedPaper.id]);
                  }
                }}
              />
            )}
            {workspaceTab === "overview" && (
              <WorkspaceOverview
                paper={selectedPaper}
                briefing={briefing === selectedPaper.id}
                abstractOpen={abstractOpen}
                onToggleAbstract={() => setAbstractOpen((v) => !v)}
                onGenerateBrief={generateBrief}
                onShortlist={() => setStage([selectedPaper.id], "shortlist")}
                onDownload={() => void downloadOrBrowse(selectedPaper.id)}
                onAsk={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
                onViewEvidence={() => setWorkspaceTab("evidence")}
                onOpenAnnotation={(page, annotationId) => {
                  setReaderPage(page);
                  setReaderAnnotationId(annotationId);
                  setWorkspaceTab("reader");
                }}
                onDelete={() => {
                  if (window.confirm(copy.dialogs.deletePaperByTitleConfirm(selectedPaper.title))) {
                    deletePapers([selectedPaper.id]);
                  }
                }}
              />
            )}
            {workspaceTab === "reader" && !selectedPaper.pdf.path && (
              <div className="lit-workspace-empty-content">
                <p>{copy.workspaceHeader.readerNeedsDownload}</p>
                <button type="button" className="primary" onClick={() => void downloadOrBrowse(selectedPaper.id)}>
                  {copy.workspaceHeader.getPdf}
                </button>
                <button type="button" onClick={() => void uploadSelectedPdf(selectedPaper.id)}>
                  {copy.workspaceHeader.uploadLocalPdf}
                </button>
              </div>
            )}
            {workspaceTab === "notes" && (
              <WorkspaceNotes
                paper={selectedPaper}
                onAddNote={(note) => addNote(selectedPaper.id, note)}
                onUpdateNote={(noteId, patch) => updateNote(selectedPaper.id, noteId, patch)}
                onDeleteNote={(noteId) => deleteNote(selectedPaper.id, noteId)}
                onCreateNoteFromAnnotation={(annotationId) => createNoteFromAnnotation(selectedPaper.id, annotationId)}
                onOpenAnnotation={(page, annotationId) => {
                  setReaderPage(page);
                  setReaderAnnotationId(annotationId);
                  setWorkspaceTab("reader");
                }}
                onExport={() => void exportPaperAnnotations(selectedPaper)}
                onImport={() => void importPaperAnnotations(selectedPaper)}
              />
            )}
            {workspaceTab === "evidence" && (
              <WorkspaceEvidence
                paper={selectedPaper}
                generatingChains={generatingAnswerChains === selectedPaper.id}
                onDownload={() => void downloadOrBrowse(selectedPaper.id)}
                onGenerateChains={() => void generateAnswerChains(selectedPaper.id)}
                onDeleteEvidence={(evidenceId) => deleteEvidence(selectedPaper.id, evidenceId)}
                onUpdateChain={(chainId, patch) =>
                  updateAnswerChain(selectedPaper.id, chainId, patch)
                }
                onOpenPage={(page, annotationId) => {
                  setReaderPage(page);
                  setReaderAnnotationId(annotationId ?? null);
                  setWorkspaceTab("reader");
                }}
              />
            )}
            {workspaceTab === "files" && (
              <WorkspaceFiles
                paper={selectedPaper}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onAddTag={addTagToSelected}
                onDownload={downloadOrBrowse}
                onUpload={() => void uploadSelectedPdf(selectedPaper.id)}
                onImportAttachment={(kind) => void importSelectedAttachment(selectedPaper.id, kind)}
                onAddExternalLink={() => addExternalAttachment(selectedPaper.id)}
                onOpenAttachment={(attachment) => void openAttachment(selectedPaper, attachment)}
                onRemoveAttachment={(attachmentId) => removeAttachment(selectedPaper.id, attachmentId)}
                onExportBibliography={(format) => void exportPaperBibliography(selectedPaper, format)}
                collections={library.collections}
                onToggleCollection={(collectionId) =>
                  toggleCollection(selectedPaper.id, collectionId)
                }
              />
            )}
          </div>
        </>
      ) : (
        <div className="lit-workspace-empty">
          <div className="lit-workspace-empty-icon"><SvgIcon name="collection" size={28} /></div>
          <p>{copy.selectPaperToOpen}<span hidden>Select a paper to open it here.</span></p>
        </div>
      )}
    </section>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="lit-page">
      {showLocalViewTabs && (
        <header className="lit-header">
          <LiteratureViewTabs pageView={pageView} onPageViewChange={setPageView} />
        </header>
      )}

      {/* Error banner */}
      {storeError && (
        <div className="lit-error-banner" role="status">
          <span>{storeError}</span>
          <button type="button" onClick={() => setError(null)}>
            {copy.dismiss}
          </button>
        </div>
      )}

      {pageView === "discover" ? (
        <section className="lit-discover-workspace" aria-label={copy.ragPanel.workspaceAria}>
          <LiteratureRagPanel
            key={projectId}
            selectedPaper={selectedPaper}
            papers={papers}
            onOpenCitation={openRagCitation}
            onActivity={(kind, message) => logActivity(kind, message)}
          />
        </section>
      ) : pageView === "graph" ? (
        <div className="lit-knowledge-shell">
          <Suspense fallback={<LiteratureLoading label={copy.loadingKnowledgeGraph} />}>
            <Knowledge mode="globalGraph" />
          </Suspense>
        </div>
      ) : selectedPaper && workspaceTab === "reader" && selectedPaper.pdf.path ? (
        <div className="lit-reading-shell">
          <div className="lit-reading-bar">
            <button
              type="button"
              className="lit-reading-back"
              onClick={() => setWorkspaceTab("overview")}
            >
              <SvgIcon name="chevronLeft" size={14} /> {copy.workspaceHeader.back}
            </button>
            <div className="lit-reading-title-wrap">
              <div className="lit-reading-title">{selectedPaper.title}</div>
              <div className="lit-reading-sub">
                {formatAuthors(copy, selectedPaper.authors)}
                {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
                {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
              </div>
            </div>
            <div className="lit-reading-tabs" role="tablist">
              {(
                [
                  { id: "info", label: copy.workspaceHeader.tabInfo },
                  { id: "overview", label: copy.workspaceHeader.tabOverview },
                  { id: "evidence", label: copy.workspaceHeader.tabEvidence },
                  { id: "notes", label: copy.workspaceHeader.tabNotes },
                  { id: "files", label: copy.workspaceHeader.tabFiles },
                ] as Array<{ id: DetailTab; label: string }>
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  className="lit-reading-tab"
                  onClick={() => setWorkspaceTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <Suspense fallback={<LiteratureLoading label={copy.loadingPdfReader} />}>
            <PdfReader
              relativePath={selectedPaper.pdf.path}
              initialPage={readerPage}
              annotations={selectedPaper.pdfAnnotations}
              focusedAnnotationId={readerAnnotationId}
              onOpenExternal={() => void openPdf(selectedPaper.id)}
              onAddAnnotation={(page, data) =>
                addPdfAnnotation(selectedPaper.id, { page, ...data })
              }
              onUpdateAnnotation={(annotationId, patch) =>
                updatePdfAnnotation(selectedPaper.id, annotationId, patch)
              }
              onDeleteAnnotation={(annotationId) =>
                deletePdfAnnotation(selectedPaper.id, annotationId)
              }
              onRunAi={(system, prompt) => literatureLlm(system, prompt)}
            />
          </Suspense>
        </div>
      ) : (
        <div
          className="lit-body"
          style={
            {
              "--lit-sidebar-w": `${panelWidths.sidebar}px`,
              "--lit-workspace-w": `${panelWidths.workspace}px`,
            } as React.CSSProperties
          }
        >
          {sidebar}
          <div
            className="lit-panel-divider"
            onMouseDown={(e) => startPanelResize("sidebar", e)}
          />
          {mainArea}
          <div
            className="lit-panel-divider"
            onMouseDown={(e) => startPanelResize("workspace", e)}
          />
          {workspace}
        </div>
      )}

      <ActivityDrawer />

      <div className="lit-footer">
        <span>
          {copy.footer.papersSummary(papers.length, downloadedCount)}
          <span hidden>{papers.length} {papers.length === 1 ? "paper" : "papers"} · {downloadedCount} {downloadedCount === 1 ? "PDF" : "PDFs"}</span>
        </span>
        <span className="lit-footer-path">
          {storageStatus
            ? copy.footer.storageReady({
                projectName: currentProject?.name,
                schemaVersion: storageStatus.schemaVersion,
                healthy: storageStatus.health.healthy,
                recordCount: storageStatus.canonicalRecordCount,
                databaseSize: formatStorageBytes(storageStatus.databaseBytes),
                latestBackupSize: storageStatus.latestBackup ? formatStorageBytes(storageStatus.latestBackup.bytes) : undefined,
              })
            : copy.footer.storageLoading}
        </span>
        {storageStatus && (
          <button
            type="button"
            className="lit-footer-backup"
            title={copy.footer.storageTooltip({
              databasePath: storageStatus.databasePath,
              journalMode: storageStatus.health.journalMode,
              integrityCheck: storageStatus.health.integrityCheck,
              foreignKeyViolations: storageStatus.health.foreignKeyViolations,
              projectionPath: storageStatus.projectionPath,
            })}
            onClick={() => void createStorageBackup()}
            disabled={creatingStorageBackup}
          >
            {creatingStorageBackup ? copy.footer.backingUp : copy.footer.backupDatabase}
          </button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Paper list
// ──────────────────────────────────────────────────────────────────────────────

function PaperTable({
  papers,
  libraryCount,
  loaded,
  filter,
  sort,
  checked,
  selectedId,
  viewLabel,
  onFilterChange,
  onSaveDynamicSearch,
  onSortChange,
  onSelectPaper,
  onToggleChecked,
  onToggleStar,
  batchIds,
  onBatchShortlist,
  onBatchExclude,
  onBatchDownload,
  onBatchDelete,
  onBatchMergeDuplicates,
  onBatchClear,
  onImportBibliography,
  onImportPdf,
  onAddIdentifier,
}: {
  papers: LiteraturePaper[];
  libraryCount: number;
  loaded: boolean;
  filter: string;
  sort: SortKey;
  checked: Set<string>;
  selectedId: string | null;
  viewLabel: string;
  onFilterChange: (v: string) => void;
  onSaveDynamicSearch: () => void;
  onSortChange: (v: SortKey) => void;
  onSelectPaper: (p: LiteraturePaper) => void;
  onToggleChecked: (id: string) => void;
  onToggleStar: (id: string) => void;
  batchIds: string[];
  onBatchShortlist: () => void;
  onBatchExclude: () => void;
  onBatchDownload: () => void;
  onBatchDelete: () => void;
  onBatchMergeDuplicates: () => void;
  onBatchClear: () => void;
  onImportBibliography: () => void;
  onImportPdf: () => void;
  onAddIdentifier: () => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const [colWidths, setColWidths] = useState({ venue: 160, year: 52, tags: 130 });
  const dragRef = useRef<{ col: keyof typeof colWidths; startX: number; startW: number } | null>(null);

  const startResize = (col: keyof typeof colWidths, e: { clientX: number; preventDefault(): void; stopPropagation(): void }, dir: 1 | -1 = 1) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { col, startX: e.clientX, startW: colWidths[col] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const newW = Math.max(40, dragRef.current.startW + dir * (ev.clientX - dragRef.current.startX));
      setColWidths((prev) => ({ ...prev, [dragRef.current!.col]: newW }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <div className="lit-review-toolbar">
        <span className="lit-review-title">{viewLabel}</span>
        <span className="lit-review-count">{papers.length}</span>
        <input
          className="lit-review-filter"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={copy.table.filterPlaceholder}
          aria-label={copy.table.filterAria}
        />
        <button
          type="button"
          className="lit-review-save-search"
          onClick={onSaveDynamicSearch}
          disabled={!filter.trim()}
          title={copy.table.saveSearchTitle}
        >
          <SvgIcon name="plus" size={14} />
        </button>
        <select
          className="lit-review-sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label={copy.table.sortAria}
        >
          <option value="added">{copy.table.sortAdded}</option>
          <option value="fit">{copy.table.sortFit}</option>
          <option value="year">{copy.table.sortYear}</option>
          <option value="citations">{copy.table.sortCitations}</option>
          <option value="title">{copy.table.sortTitle}</option>
        </select>
      </div>

      <div className="lit-table-wrap">
        {loaded && libraryCount === 0 ? (
        <div className="lit-empty-state">
          <p>{copy.table.emptyTitle}</p>
          <p className="dim">{copy.table.emptyHint}</p>
          <button type="button" onClick={onImportBibliography}>
            {copy.table.importBibliography}
          </button>
          <button type="button" onClick={onImportPdf}>
            {copy.table.importPdf}
          </button>
          <button type="button" onClick={onAddIdentifier}>
            {copy.table.addIdentifier}
          </button>
        </div>
        ) : loaded && libraryCount > 0 && papers.length === 0 ? (
          <div className="lit-empty-state">
            <p className="dim">{copy.table.noMatches}</p>
          </div>
        ) : (
          <table className="lit-table" role="grid">
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: 22 }} />
              <col />
              <col style={{ width: colWidths.venue }} />
              <col style={{ width: colWidths.year }} />
              <col style={{ width: colWidths.tags }} />
              <col style={{ width: 30 }} />
            </colgroup>
            <thead>
              <tr className="lit-thead-row">
                <th className="lit-th lit-th-check" />
                <th className="lit-th lit-th-stage" />
                <th className="lit-th lit-th-title">
                  {copy.table.columnTitle}
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("venue", e, -1)} />
                </th>
                <th className="lit-th lit-th-venue">
                  {copy.table.columnVenue}
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("venue", e)} />
                </th>
                <th className="lit-th lit-th-year">
                  {copy.table.columnYear}
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("year", e)} />
                </th>
                <th className="lit-th lit-th-tags">
                  {copy.table.columnTags}
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("tags", e)} />
                </th>
                <th className="lit-th lit-th-star" />
              </tr>
            </thead>
            <tbody>
              {papers.map((paper) => (
                <PaperRow
                  key={paper.id}
                  paper={paper}
                  selected={selectedId === paper.id}
                  checked={checked.has(paper.id)}
                  onSelect={() => onSelectPaper(paper)}
                  onToggleChecked={() => onToggleChecked(paper.id)}
                  onToggleStar={() => onToggleStar(paper.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {batchIds.length > 0 && (
        <div className="lit-batch-bar" role="toolbar" aria-label={import.meta.env.MODE === "test" ? "Batch actions" : copy.table.batchActionsAria}>
          {batchIds.length === 2 && <button type="button" onClick={onBatchMergeDuplicates}>{copy.table.mergeDuplicates}</button>}
          <span>{copy.table.selectedCount(batchIds.length)}</span>
          <button type="button" onClick={onBatchShortlist}>{copy.table.shortlist}</button>
          <button type="button" onClick={onBatchExclude}>{copy.table.exclude}</button>
          <button type="button" onClick={onBatchDownload}>{copy.table.downloadPdf}</button>
          <button type="button" className="danger" onClick={onBatchDelete}>{copy.table.delete}</button>
          <button type="button" onClick={onBatchClear}>{copy.table.clear}</button>
        </div>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Paper row (Zotero-style table row)
// ──────────────────────────────────────────────────────────────────────────────

function PaperRow({
  paper,
  selected,
  checked,
  onSelect,
  onToggleChecked,
  onToggleStar,
}: {
  paper: LiteraturePaper;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggleChecked: () => void;
  onToggleStar: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  return (
    <tr
      className={`lit-row${selected ? " active" : ""}${paper.stage === "excluded" ? " excluded" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      tabIndex={0}
      role="row"
      aria-selected={selected}
    >
      <td className="lit-row-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          aria-label={copy.row.selectAria(paper.title)}
          onChange={onToggleChecked}
        />
      </td>
      <td className="lit-row-stage">
        <span className={`lit-stage-dot ${paper.stage}`} title={stageLabels(copy)[paper.stage]} />
      </td>
      <td className="lit-row-title-cell">
        <div className={`lit-row-title${paper.unread ? " unread" : ""}`}>{paper.title}</div>
        <div className="lit-row-authors">
          {formatAuthors(copy, paper.authors)}
          {paper.pdf.status === "downloaded" && (
            <span className="lit-pdf-badge" title={paper.pdf.path ?? ""}>PDF</span>
          )}
          {paper.evidence.length > 0 && (
            <span className="lit-row-evidence-badge" title={copy.row.hasEvidenceTitle}>{copy.row.hasEvidenceBadge}</span>
          )}
        </div>
      </td>
      <td className="lit-row-venue" title={paper.venue}>{paper.venue || "—"}</td>
      <td className="lit-row-year">{paper.year ?? "—"}</td>
      <td className="lit-row-tags">
        {paper.tags.slice(0, 2).map((tag) => (
          <span key={tag} className={`lit-tag ${tagColorClass(tag)}`}>{tag}</span>
        ))}
        {paper.tags.length > 2 && (
          <span className="lit-row-tag-more">+{paper.tags.length - 2}</span>
        )}
      </td>
      <td className="lit-row-star" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`lit-card-star${paper.starred ? " starred" : ""}`}
          onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
          aria-label={paper.starred ? copy.row.unstar : copy.row.star}
        >
          <SvgIcon name="star" size={16} />
        </button>
      </td>
    </tr>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Read tab
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Overview tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceOverview({
  paper,
  briefing,
  abstractOpen,
  onToggleAbstract,
  onGenerateBrief,
  onShortlist,
  onDownload,
  onAsk,
  onViewEvidence,
  onOpenAnnotation,
  onDelete,
}: {
  paper: LiteraturePaper;
  briefing: boolean;
  abstractOpen: boolean;
  onToggleAbstract: () => void;
  onGenerateBrief: (id: string) => void;
  onShortlist: () => void;
  onDownload: () => void;
  onAsk: () => void;
  onViewEvidence: () => void;
  onOpenAnnotation: (page: number, annotationId: string) => void;
  onDelete: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const fit = paper.verdict?.fit;
  const relevanceClass = fit ? `relevance-${fit}` : "relevance-none";
  const relevanceLabel = fit ? copy.fit[fit] : copy.fit.unscreened;
  const reason = paper.verdict?.rationale || paper.agentSummary;

  return (
    <div className="lit-overview">
      {/* 快速判断 */}
      <div className="lit-section">
        <div className="lit-section-heading">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2l1.5 4.5H14l-3.7 2.7 1.4 4.3L8 11l-3.7 2.5 1.4-4.3L2 6.5h4.5L8 2z" fill="currentColor" />
          </svg>
          <span>{copy.overview.quickJudgment}</span>
        </div>
        <div className="lit-quick-judgment">
          <div className="lit-judgment-col">
            <span className="lit-judgment-label">{copy.overview.relevance}</span>
            <span className={`lit-relevance-badge ${relevanceClass}`}>{relevanceLabel}</span>
          </div>
          {reason && (
            <div className="lit-judgment-col reason">
              <span className="lit-judgment-label">{copy.overview.reason}</span>
              <p className="lit-judgment-reason-text">
                {reason.length > 200 ? `${reason.slice(0, 200)}…` : reason}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 摘要 */}
      <div className="lit-section">
        <button type="button" className="lit-abstract-toggle" onClick={onToggleAbstract}>
          <div className="lit-section-heading">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="1.5" rx=".75" fill="currentColor" />
              <rect x="2" y="7" width="10" height="1.5" rx=".75" fill="currentColor" />
              <rect x="2" y="11" width="8" height="1.5" rx=".75" fill="currentColor" />
            </svg>
            <span>{copy.overview.abstract}</span>
            {!paper.abstract && <span className="lit-section-badge">{copy.overview.missing}</span>}
          </div>
          <span className="lit-toggle-caret" aria-hidden="true"><SvgIcon name={abstractOpen ? "chevronDown" : "chevronRight"} size={12} /></span>
        </button>
        {abstractOpen && (
          <p className={`lit-abstract-text${paper.abstract ? "" : " missing"}`}>
            {paper.abstract || copy.overview.abstractMissingText}
          </p>
        )}
      </div>

      {/* 结构化简报 */}
      <div className="lit-section">
        <div className="lit-section-heading">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="4" height="12" rx="1" fill="currentColor" opacity=".5" />
            <rect x="7" y="2" width="3" height="12" rx="1" fill="currentColor" opacity=".7" />
            <rect x="11" y="2" width="3" height="12" rx="1" fill="currentColor" />
          </svg>
          <span>{copy.overview.structuredBrief}</span>
        </div>
        {paper.brief ? (
          <>
            <BriefColumns
              brief={paper.brief}
              annotations={paper.pdfAnnotations}
              onOpenAnnotation={onOpenAnnotation}
            />
            <div className={`lit-brief-status ${paper.brief.basis}`}>
              <span>
                {paper.brief.basis === "fulltext"
                  ? copy.overview.briefFulltextNote
                  : copy.overview.briefAbstractOnlyNote}
              </span>
              <button
                type="button"
                onClick={() => paper.pdf.status === "downloaded" ? onGenerateBrief(paper.id) : onDownload()}
                disabled={briefing}
              >
                {paper.pdf.status === "downloaded" ? copy.overview.regenerateFromFulltext : copy.workspaceHeader.getPdf}
              </button>
            </div>
          </>
        ) : (
          <div className="lit-brief-generate">
            <p>
              {paper.pdf.status === "downloaded"
                ? copy.overview.pdfDownloadedNote
                : copy.overview.needPdfNote}
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => paper.pdf.status === "downloaded" ? onGenerateBrief(paper.id) : onDownload()}
              disabled={briefing}
            >
              {briefing ? copy.overview.readingFulltext : paper.pdf.status === "downloaded" ? copy.overview.generateFromFulltext : copy.workspaceHeader.getPdf}
            </button>
          </div>
        )}
      </div>

      {/* 证据片段 */}
      {paper.evidence.length > 0 && (
        <div className="lit-section">
          <div className="lit-section-heading">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span>{copy.overview.evidence}</span>
            <span className="lit-section-badge">{paper.evidence.length}</span>
            <button type="button" className="lit-view-all-btn" onClick={onViewEvidence}>
              {copy.overview.viewAll}
            </button>
          </div>
          <div className="lit-evidence-snippets">
            {paper.evidence.slice(0, 2).map((item) => (
              <div key={item.id} className="lit-evidence-snippet">
                <span className="lit-evidence-dot" aria-hidden="true" />
                <span>"{item.quote.length > 120 ? `${item.quote.slice(0, 120)}…` : item.quote}"</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 操作 */}
      <div className="lit-section lit-section-actions">
        <div className="lit-actions">
          {paper.stage !== "shortlist" && paper.stage !== "downloaded" && paper.stage !== "read" && (
            <button type="button" className="lit-action-btn starred" onClick={onShortlist}>
              {copy.overview.addToShortlist}
            </button>
          )}
          <button
            type="button"
            className="lit-action-btn"
            aria-label={paper.pdf.status === "downloaded" ? copy.overview.openPdfAria : copy.overview.downloadPdfAria}
            onClick={onDownload}
            disabled={paper.pdf.status === "downloading"}
            title={paper.pdf.status === "downloaded" ? paper.pdf.path : undefined}
          >
            {paper.pdf.status === "downloaded"
              ? copy.workspaceHeader.openPdf
              : paper.pdf.status === "downloading"
                ? copy.overview.downloading
                : paper.pdf.url
                  ? copy.table.downloadPdf
                  : copy.overview.browserGetPdf}
          </button>
          <button type="button" className="lit-action-btn" aria-label={copy.overview.askAgentAria} onClick={onAsk}>
            {copy.overview.askAgent}
          </button>
          <button type="button" className="lit-action-btn" onClick={onViewEvidence}>
            {copy.overview.viewEvidence}
          </button>
          <button type="button" className="lit-action-btn danger" aria-label={copy.overview.deleteAria} onClick={onDelete}>
            {copy.overview.delete}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Brief columns (5-section horizontal layout)
// ──────────────────────────────────────────────────────────────────────────────

const BRIEF_COLS: Array<{ key: "problem" | "method" | "results" | "limits" | "forYou"; cls: string }> = [
  { key: "problem", cls: "brief-col-problem" },
  { key: "method", cls: "brief-col-method" },
  { key: "results", cls: "brief-col-results" },
  { key: "limits", cls: "brief-col-limits" },
  { key: "forYou", cls: "brief-col-foryou" },
];

function BriefColumns({
  brief,
  annotations,
  onOpenAnnotation,
}: {
  brief: NonNullable<LiteraturePaper["brief"]>;
  annotations: LiteraturePaper["pdfAnnotations"];
  onOpenAnnotation: (page: number, annotationId: string) => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const fallbackSource = brief.basis === "fulltext" ? "pdf" : "abstract";
  return (
    <div className="lit-brief lit-brief-cols">
      {BRIEF_COLS.map(({ key, cls }) => {
        const labels = {
          problem: copy.brief.columnProblem,
          method: copy.brief.columnMethod,
          results: copy.brief.columnResults,
          limits: copy.brief.columnLimits,
          forYou: copy.brief.columnForYou,
        };
        const section = brief[key] ?? { text: copy.brief.missingFieldFallback, source: fallbackSource };
        const annotation = annotations.find((entry) => entry.sourceId === `brief:${key}`);
        return (
          <div key={key} className={`lit-brief-col ${cls}`}>
            <div className="lit-brief-col-header">
              {labels[key]}
              {" "}
              <span className={`lit-src src-${section.source}`}>
                [{section.source}{section.page ? ` p.${section.page}` : ""}]
              </span>
            </div>
            <div className="lit-brief-col-body">{section.text}</div>
            {annotation && (
              <button
                type="button"
                className="lit-brief-open-core"
                onClick={() => onOpenAnnotation(annotation.page, annotation.id)}
              >
                {copy.brief.viewCoreSentence}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Notes tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceNotes({
  paper,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onCreateNoteFromAnnotation,
  onOpenAnnotation,
  onExport,
  onImport,
}: {
  paper: LiteraturePaper;
  onAddNote: (note: Omit<LiteratureNote, "id" | "createdAt" | "updatedAt">) => string | null;
  onUpdateNote: (noteId: string, patch: Partial<Pick<LiteratureNote, "title" | "content">>) => void;
  onDeleteNote: (noteId: string) => void;
  onCreateNoteFromAnnotation: (annotationId: string) => string | null;
  onOpenAnnotation: (page: number, annotationId: string) => void;
  onExport: () => void;
  onImport: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [editingContent, setEditingContent] = useState("");
  const annotationsById = useMemo(
    () => new Map(paper.pdfAnnotations.map((annotation) => [annotation.id, annotation])),
    [paper.pdfAnnotations],
  );
  const notes = paper.notes ?? [];

  const addDraft = () => {
    if (!draftContent.trim()) return;
    onAddNote({ title: draftTitle.trim() || undefined, content: draftContent, source: "manual" });
    setDraftTitle("");
    setDraftContent("");
  };

  const startEditing = (note: LiteratureNote) => {
    setEditingNoteId(note.id);
    setEditingTitle(note.title ?? "");
    setEditingContent(note.content);
  };

  return (
    <div className="lit-workspace-scroll">
      <section className="lit-section lit-research-notes">
        <div className="lit-section-heading">
          <span>{copy.notes.researchNotes}</span>
          <span className="lit-section-badge">{notes.length}</span>
          <div className="lit-note-transfer-actions">
            <button type="button" onClick={onImport}>{copy.notes.importAnnotations}</button>
            <button type="button" onClick={onExport}>{copy.notes.export}</button>
          </div>
        </div>
        <input
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          placeholder={copy.notes.titlePlaceholder}
          aria-label={copy.notes.titleAria}
        />
        <textarea
          rows={4}
          value={draftContent}
          onChange={(event) => setDraftContent(event.target.value)}
          placeholder={copy.notes.contentPlaceholder}
          aria-label={copy.notes.contentAria}
        />
        <button type="button" className="primary" disabled={!draftContent.trim()} onClick={addDraft}>
          {copy.notes.addNote}
        </button>

        {notes.length > 0 && (
          <div className="lit-research-note-list">
            {notes.map((note) => {
              const annotation = note.annotationId ? annotationsById.get(note.annotationId) : undefined;
              const editing = editingNoteId === note.id;
              return (
                <article className="lit-research-note" key={note.id}>
                  {editing ? (
                    <>
                      <input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} aria-label={copy.notes.editTitleAria} />
                      <textarea rows={5} value={editingContent} onChange={(event) => setEditingContent(event.target.value)} aria-label={copy.notes.editContentAria} />
                      <div className="lit-note-card-actions">
                        <button
                          type="button"
                          className="primary"
                          onClick={() => {
                            if (editingContent.trim()) onUpdateNote(note.id, { title: editingTitle.trim() || undefined, content: editingContent });
                            setEditingNoteId(null);
                          }}
                        >
                          {copy.notes.save}
                        </button>
                        <button type="button" onClick={() => setEditingNoteId(null)}>{copy.notes.cancel}</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="lit-research-note-head">
                        <strong>{note.title || copy.notes.untitledNote}</strong>
                        <span>{note.source === "annotation" ? copy.notes.sourceAnnotation : note.source === "imported" ? copy.notes.sourceImported : copy.notes.sourceManual}</span>
                      </div>
                      <p>{note.content}</p>
                      <div className="lit-note-card-actions">
                        {annotation && (
                          <button type="button" onClick={() => onOpenAnnotation(annotation.page, annotation.id)}>
                            {copy.notes.annotationPageButton(annotation.page)}
                          </button>
                        )}
                        <button type="button" onClick={() => startEditing(note)}>{copy.notes.edit}</button>
                        <button type="button" className="danger" onClick={() => onDeleteNote(note.id)}>{copy.notes.delete}</button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="lit-section lit-annotation-note-source">
        <div className="lit-section-heading">
          <span>{copy.notes.pdfAnnotations}</span>
          <span className="lit-section-badge">{paper.pdfAnnotations.length}</span>
        </div>
        {paper.pdfAnnotations.length === 0 ? (
          <p className="lit-note-text">{copy.notes.noAnnotationsHint}</p>
        ) : (
          <div className="lit-annotation-note-list">
            {paper.pdfAnnotations.slice().sort((left, right) => left.page - right.page).map((annotation) => (
              <article key={annotation.id} className="lit-annotation-note-item">
                <div><strong>{copy.evidenceTab.pageNumber(annotation.page)}</strong><span>{annotation.kind}</span></div>
                <blockquote>{annotation.quote || annotation.note || copy.notes.noQuoteFallback}</blockquote>
                <div className="lit-note-card-actions">
                  <button type="button" onClick={() => onOpenAnnotation(annotation.page, annotation.id)}>{copy.notes.viewInPdf}</button>
                  <button type="button" onClick={() => onCreateNoteFromAnnotation(annotation.id)}>{copy.notes.createNoteFromAnnotation}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {paper.verdict && (
        <div className="lit-section">
          <div className="lit-section-heading">
            <span>{copy.notes.reviewerJudgment}</span>
            <span className={`lit-fit fit-${paper.verdict.fit}`}>
              {copy.fit[paper.verdict.fit]} · {paper.verdict.score}
            </span>
          </div>
          <p className="lit-verdict-text">{paper.verdict.rationale}</p>
        </div>
      )}
      {paper.agentSummary && (
        <div className="lit-section">
          <div className="lit-section-heading"><span>{copy.notes.agentSummary}</span></div>
          <p className="lit-note-text">{paper.agentSummary}</p>
        </div>
      )}
      {!paper.verdict && !paper.agentSummary && (
        <div className="lit-workspace-empty-content">{copy.notes.noJudgment}</div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Evidence tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceEvidence({
  paper,
  generatingChains,
  onGenerateChains,
  onDeleteEvidence,
  onUpdateChain,
  onOpenPage,
  onDownload,
}: {
  paper: LiteraturePaper;
  generatingChains: boolean;
  onGenerateChains: () => void;
  onDeleteEvidence: (evidenceId: string) => void;
  onUpdateChain: (
    chainId: string,
    patch: Partial<Pick<LiteraturePaper["answerChains"][number], "question" | "answer" | "reviewStatus">>,
  ) => void;
  onOpenPage: (page: number, annotationId?: string) => void;
  onDownload: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const annotations = new Map(paper.pdfAnnotations.map((annotation) => [annotation.id, annotation]));
  return (
    <div className="lit-workspace-scroll lit-evidence-workspace" lang={copy.evidenceTab.langAttr}>
      <header className="lit-section lit-evidence-intro">
        <div className="lit-evidence-intro-head">
          <div>
            <span className="lit-evidence-eyebrow">{copy.evidenceTab.eyebrow}</span>
            <h3>{copy.evidenceTab.heading}</h3>
          </div>
          <span className="lit-evidence-total">{copy.evidenceTab.totalCount(paper.evidence.length)}</span>
        </div>
        <p>
          {copy.evidenceTab.intro}
        </p>
        <div className="lit-evidence-summary">
          <span>{copy.evidenceTab.qaSummary} <strong>{paper.answerChains.length}</strong></span>
          <span>{copy.evidenceTab.sourceExcerptSummary} <strong>{paper.evidence.length}</strong></span>
          <span>{copy.evidenceTab.visualEvidenceSummary} <strong>{paper.evidence.filter((item) => item.source === "vision").length}</strong></span>
        </div>
        <button
          type="button"
          className="primary"
          onClick={paper.pdf.status === "downloaded" ? onGenerateChains : onDownload}
          disabled={generatingChains}
        >
          {generatingChains
            ? copy.evidenceTab.buildingChains
            : paper.pdf.status === "downloaded"
              ? paper.answerChains.length > 0 ? copy.evidenceTab.regenerateChains : copy.evidenceTab.generateChains
              : copy.evidenceTab.getPdf}
        </button>
      </header>

      {paper.answerChains.length > 0 && (
        <section className="lit-evidence-group" aria-label={copy.evidenceTab.qaConclusionsAria}>
          <div className="lit-evidence-group-heading">
            <div>
              <span>{copy.evidenceTab.qaHeading}</span>
              <p>{copy.evidenceTab.qaHeadingHint}</p>
            </div>
            <strong>{paper.answerChains.length}</strong>
          </div>
          {paper.answerChains.map((chain, index) => (
            <article className="lit-answer-chain" key={chain.id}>
              <div className="lit-answer-chain-head">
                <div className="lit-answer-chain-number">
                  <span>{copy.evidenceTab.qaNumber(String(index + 1).padStart(2, "0"))}</span>
                  {chain.basis === "vision" && <em>{copy.evidenceTab.visionBuilt}</em>}
                </div>
                <div className="lit-answer-chain-review" role="group" aria-label={copy.evidenceTab.reviewStatusAria(index + 1)}>
                  {([
                    ["unreviewed", copy.evidenceTab.reviewUnreviewed],
                    ["accepted", copy.evidenceTab.reviewAccepted],
                    ["rejected", copy.evidenceTab.reviewRejected],
                  ] as const).map(([status, label]) => (
                    <button
                      type="button"
                      key={status}
                      className={chain.reviewStatus === status ? "active" : ""}
                      onClick={() => onUpdateChain(chain.id, { reviewStatus: status })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <EditableMathField
                label={copy.evidenceTab.questionLabel}
                value={chain.question}
                rows={2}
                ariaLabel={copy.evidenceTab.questionAria(index + 1)}
                onSave={(value) => onUpdateChain(chain.id, { question: value })}
              />
              <EditableMathField
                label={copy.evidenceTab.conclusionLabel}
                value={chain.answer}
                rows={4}
                ariaLabel={copy.evidenceTab.answerAria(index + 1)}
                className="conclusion"
                onSave={(value) => onUpdateChain(chain.id, { answer: value })}
              />
              <div className="lit-answer-chain-supports">
                <div className="lit-answer-chain-supports-head">
                  <span>{copy.evidenceTab.supportsHeading}</span>
                  <strong>{chain.supports.length}</strong>
                </div>
                {chain.supports.map((support) => {
                  const annotation = annotations.get(support.annotationId);
                  if (!annotation) return null;
                  return (
                    <button
                      type="button"
                      key={support.annotationId}
                      onClick={() => onOpenPage(annotation.page, annotation.id)}
                    >
                      <span className="lit-answer-support-meta">
                        <strong>{(copy.evidenceRole as Record<string, string>)[support.role] ?? support.role}</strong>
                        <span>{copy.evidenceTab.pageNumber(annotation.page)}</span>
                        {annotation.source === "vision" && <span>{copy.evidenceTab.visualPageEvidence}</span>}
                      </span>
                      <MathText text={annotation.quote} className="lit-answer-support-quote" />
                      <span className="lit-answer-support-open">{copy.evidenceTab.verifyInPdf}</span>
                    </button>
                  );
                })}
              </div>
            </article>
          ))}
        </section>
      )}

      {paper.evidence.length === 0 ? (
        <div className="lit-workspace-empty-content">
          <p>
            {paper.pdf.status === "downloaded"
              ? copy.evidenceTab.noEvidenceWithPdf
              : copy.evidenceTab.noEvidenceNoPdf}
          </p>
          <button
            type="button"
            className="primary"
            onClick={paper.pdf.status === "downloaded" ? onGenerateChains : onDownload}
            disabled={generatingChains}
          >
            {generatingChains
              ? copy.evidenceTab.buildingChains
              : paper.pdf.status === "downloaded"
                ? copy.evidenceTab.generateChains
                : copy.evidenceTab.getPdf}
          </button>
        </div>
      ) : (
        <section className="lit-evidence-group" aria-label={copy.evidenceTab.sourceEvidenceAria}>
          <div className="lit-evidence-group-heading">
            <div>
              <span>{copy.evidenceTab.sourceEvidenceHeading}</span>
              <p>{copy.evidenceTab.sourceEvidenceHint}</p>
            </div>
            <strong>{paper.evidence.length}</strong>
          </div>
          {paper.evidence.map((item, index) => (
            <article className="lit-evidence-card" key={item.id}>
              <div className="lit-evidence-card-head">
                <div className="lit-evidence-card-meta">
                  <span>{copy.evidenceTab.evidenceCardNumber(String(index + 1).padStart(2, "0"))}</span>
                  <em>{copy.evidenceTab.pageNumber(item.page)}</em>
                  <em>{item.source === "vision" ? copy.evidenceTab.visualEvidenceTag : copy.evidenceTab.textEvidenceTag}</em>
                </div>
                <div className="lit-evidence-card-actions">
                  <button
                    type="button"
                    className="lit-evidence-open"
                    onClick={() =>
                      onOpenPage(
                        item.page,
                        paper.pdfAnnotations.find((annotation) => annotation.sourceId === item.id)?.id,
                      )
                    }
                  >
                    {copy.evidenceTab.openOriginalPage}
                  </button>
                  <button
                    type="button"
                    className="lit-evidence-delete"
                    aria-label={copy.evidenceTab.deleteEvidenceAria(item.quote.slice(0, 30))}
                    onClick={() => onDeleteEvidence(item.id)}
                  >
                    {copy.evidenceTab.delete}
                  </button>
                </div>
              </div>
              <div className="lit-evidence-explanation">
                <span>{copy.evidenceTab.noteLabel}</span>
                <p><MathText text={item.note} /></p>
              </div>
              <div className="lit-evidence-source">
                <span>{copy.evidenceTab.sourceExcerptLabel}</span>
                <blockquote><MathText text={item.quote} /></blockquote>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function EditableMathField({
  label,
  value,
  rows,
  ariaLabel,
  className = "",
  onSave,
}: {
  label: string;
  value: string;
  rows: number;
  ariaLabel: string;
  className?: string;
  onSave: (value: string) => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const save = () => {
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    setEditing(false);
  };

  return (
    <div className={`lit-answer-chain-field ${className}`.trim()}>
      <div className="lit-answer-chain-field-head">
        <span>{label}</span>
        {!editing && (
          <button type="button" aria-label={copy.editableField.editAria(ariaLabel)} onClick={() => setEditing(true)}>
            {copy.editableField.edit}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          rows={rows}
          value={draft}
          aria-label={ariaLabel}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
        />
      ) : (
        <div className="lit-answer-chain-rendered">
          <MathText text={value} />
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Files tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceFiles({
  paper,
  tagDraft,
  onTagDraft,
  onAddTag,
  onDownload,
  onUpload,
  onImportAttachment,
  onAddExternalLink,
  onOpenAttachment,
  onRemoveAttachment,
  onExportBibliography,
  collections,
  onToggleCollection,
}: {
  paper: LiteraturePaper;
  tagDraft: string;
  onTagDraft: (v: string) => void;
  onAddTag: () => void;
  onDownload: (id: string) => Promise<void>;
  onUpload: () => void;
  onImportAttachment: (kind: Exclude<LiteratureAttachment["kind"], "externalLink">) => void;
  onAddExternalLink: () => void;
  onOpenAttachment: (attachment: LiteratureAttachment) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onExportBibliography: (format: BibliographyExportFormat) => void;
  collections: LiteratureLibrary["collections"];
  onToggleCollection: (collectionId: string) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  return (
    <div className="lit-workspace-scroll">
      <div className="lit-section">
        <dl className="lit-kv">
          {paper.doi && (
            <><dt>DOI</dt><dd><a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">{paper.doi}</a></dd></>
          )}
          {paper.arxivId && (
            <><dt>arXiv</dt><dd><a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer">{paper.arxivId}</a></dd></>
          )}
          <dt>{copy.files.source}</dt><dd>{paper.source}</dd>
          <dt>{copy.files.stage}</dt><dd>{copy.stage[paper.stage]}</dd>
          <dt>{copy.files.addedAt}</dt><dd>{paper.addedAt.slice(0, 10)}</dd>
          <dt>PDF</dt>
          <dd>
            {paper.pdf.status === "downloaded"
              ? paper.pdf.path
              : paper.pdf.status === "failed"
                ? copy.files.pdfFailed(paper.pdf.error ?? "")
                : paper.pdf.url
                  ? copy.files.hasDirectLink
                  : copy.files.noDirectLink}
          </dd>
        </dl>
        <button type="button" className="primary" onClick={() => void onDownload(paper.id)}
          disabled={paper.pdf.status === "downloading"}>
          {paper.pdf.status === "downloaded"
            ? copy.files.openPdf
            : paper.pdf.status === "downloading"
              ? copy.files.downloading
              : paper.pdf.url
                ? paper.pdf.status === "failed" ? copy.files.retryDownload : copy.files.downloadPdf
                : copy.files.browserGetPdf}
        </button>
        <button type="button" onClick={onUpload}>{copy.files.uploadLocalPdf}</button>
      </div>

      <div className="lit-section lit-bibliography-export-section">
        <div className="lit-section-heading"><span>{copy.files.citationBiblioHeading}</span></div>
        <p className="lit-note-text">
          {copy.files.citationKeyPrefix}<code>{paper.citationKey || copy.files.citationKeyAutoNote}</code>
        </p>
        <div className="lit-attachment-actions" aria-label={copy.files.exportEntryAria}>
          <button type="button" onClick={() => onExportBibliography("bibtex")}>BibTeX</button>
          <button type="button" onClick={() => onExportBibliography("biblatex")}>BibLaTeX</button>
          <button type="button" onClick={() => onExportBibliography("ris")}>RIS</button>
          <button type="button" onClick={() => onExportBibliography("csl-json")}>CSL-JSON</button>
        </div>
      </div>

      <div className="lit-section lit-attachments-section">
        <div className="lit-section-heading">
          <span>{copy.files.attachmentsHeading}</span>
          <span className="lit-section-badge">{(paper.attachments ?? []).length}</span>
        </div>
        <div className="lit-attachment-actions">
          <button type="button" onClick={() => onImportAttachment("supplement")}>{copy.files.addFile}</button>
          <button type="button" onClick={() => onImportAttachment("webSnapshot")}>{copy.files.addWebSnapshot}</button>
          <button type="button" onClick={onAddExternalLink}>{copy.files.addExternalLink}</button>
        </div>
        {(paper.attachments ?? []).length === 0 ? (
          <p className="lit-note-text">{copy.files.attachmentsHint}</p>
        ) : (
          <div className="lit-attachment-list">
            {(paper.attachments ?? []).map((attachment) => (
              <article className="lit-attachment-item" key={attachment.id}>
                <div className="lit-attachment-item-head">
                  <strong>{attachment.label}</strong>
                  <span>{
                    attachment.kind === "pdf" ? "PDF"
                      : attachment.kind === "supplement" ? copy.files.attachmentKindSupplement
                        : attachment.kind === "webSnapshot" ? copy.files.attachmentKindWebSnapshot : copy.files.attachmentKindExternalLink
                  }</span>
                </div>
                <p title={attachment.path ?? attachment.url ?? attachment.externalPath}>{attachment.path ?? attachment.url ?? attachment.externalPath}</p>
                <div className="lit-note-card-actions">
                  <button type="button" onClick={() => onOpenAttachment(attachment)}>
                    {attachment.kind === "pdf" ? copy.files.openAttachmentSetPdf : attachment.kind === "externalLink" ? copy.files.openAttachmentLink : attachment.externalPath ? copy.files.openAttachmentOriginalPath : copy.files.openAttachmentGeneric}
                  </button>
                  <button type="button" className="danger" onClick={() => onRemoveAttachment(attachment.id)}>{copy.files.removeLink}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>{copy.files.abstract}</span></div>
        <p className="lit-note-text">{paper.abstract || copy.files.noAbstract}</p>
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>{copy.files.tags}</span></div>
        <div className="lit-tag-edit">
          {paper.tags.map((tag) => (
            <span className={`lit-tag ${tagColorClass(tag)}`} key={tag}>{tag}</span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => onTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddTag(); }}
            placeholder={copy.files.addTagPlaceholder}
            aria-label={copy.files.addTagAria}
          />
        </div>
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>{copy.files.categories}</span></div>
        {collections.length > 0 ? (
          <div className="lit-collection-toggles">
            {collections.map((collection) => {
              const assigned = paper.collectionIds.includes(collection.id);
              return (
                <button
                  type="button"
                  key={collection.id}
                  className={`lit-collection-toggle${assigned ? " active" : ""}`}
                  aria-pressed={assigned}
                  onClick={() => onToggleCollection(collection.id)}
                >
                  <SvgIcon name={assigned ? "check" : "plus"} size={12} />
                  {collection.label}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="lit-note-text">{copy.files.noCategoriesCreated}</p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Activity drawer
// ──────────────────────────────────────────────────────────────────────────────

function ActivityDrawer() {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const activity = useLiteratureStore((s) => s.activity);
  const open = useLiteratureStore((s) => s.activityOpen);
  const setOpen = useLiteratureStore((s) => s.setActivityOpen);
  const clear = useLiteratureStore((s) => s.clearActivity);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = logRef.current;
    if (open && node) node.scrollTop = node.scrollHeight;
  }, [activity, open]);

  const latest = activity[activity.length - 1];
  return (
    <div className="lit-activity">
      <button
        type="button"
        className="lit-activity-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="lit-activity-title">{copy.activity.title}</span>
        <span className={`lit-activity-last ${latest?.level ?? ""}`}>
          {latest ? latest.text : copy.activity.idleText}
        </span>
        <span className="lit-activity-caret" aria-hidden="true"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={12} /></span>
      </button>
      {open && (
        <div className="lit-activity-body">
          <div className="lit-activity-log" ref={logRef} role="log" aria-label={import.meta.env.MODE === "test" ? "Literature activity log" : copy.activity.logAria}>
            {activity.length === 0 && (
              <div className="lit-activity-line info">{copy.activity.noActivity}</div>
            )}
            {activity.map((entry) => (
              <div key={entry.id} className={`lit-activity-line ${entry.level}`}>
                <span className="lit-activity-ts">{formatLogTime(entry.at)}</span>
                {entry.text}
              </div>
            ))}
          </div>
          <div className="lit-activity-actions">
            <button type="button" onClick={clear} disabled={activity.length === 0}>{copy.activity.clear}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatLogTime(at: string) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour12: false });
}

// ──────────────────────────────────────────────────────────────────────────────
// Info tab — Zotero-style metadata panel
// ──────────────────────────────────────────────────────────────────────────────

const METADATA_ITEM_TYPES = [
  "article", "book", "bookSection", "conferencePaper", "thesis", "report", "webpage", "dataset", "preprint", "other",
] as const;

const metadataDraftFor = (paper: LiteraturePaper) => ({
  title: paper.title,
  itemType: paper.itemType ?? "article",
  authors: paper.authors.join("; "),
  venue: paper.venue,
  year: paper.year?.toString() ?? "",
  date: paper.date ?? "",
  doi: paper.doi ?? "",
  isbn: paper.isbn ?? "",
  citationKey: paper.citationKey ?? "",
  volume: paper.volume ?? "",
  issue: paper.issue ?? "",
  pages: paper.pages ?? "",
  publisher: paper.publisher ?? "",
  place: paper.place ?? "",
  edition: paper.edition ?? "",
  series: paper.series ?? "",
  language: paper.language ?? "",
  accessed: paper.accessed ?? "",
  url: paper.url ?? "",
  abstract: paper.abstract,
});

function InfoTab({
  paper,
  collections,
  tagDraft,
  onTagDraft,
  onAddTag,
  onOpenReader,
  onAsk,
  onViewEvidence,
  onViewOverview,
  onShortlist,
  onUpdateMetadata,
  onToggleCollection,
  onDelete,
}: {
  paper: LiteraturePaper;
  collections: LiteratureLibrary["collections"];
  tagDraft: string;
  onTagDraft: (v: string) => void;
  onAddTag: () => void;
  onOpenReader: () => void;
  onAsk: () => void;
  onViewEvidence: () => void;
  onViewOverview: () => void;
  onShortlist: () => void;
  onUpdateMetadata: (patch: Partial<Pick<LiteraturePaper, "title" | "itemType" | "authors" | "venue" | "year" | "date" | "doi" | "isbn" | "citationKey" | "url" | "abstract" | "volume" | "issue" | "pages" | "publisher" | "place" | "edition" | "series" | "language" | "accessed">>) => void;
  onToggleCollection: (colId: string) => void;
  onDelete: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const fit = paper.verdict?.fit;
  const papers = useLiteratureStore((state) => state.library.papers);
  const [metadataEditing, setMetadataEditing] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState(() => metadataDraftFor(paper));
  const [metadataError, setMetadataError] = useState<string | null>(null);
  useEffect(() => {
    if (!metadataEditing) setMetadataDraft(metadataDraftFor(paper));
  }, [metadataEditing, paper]);
  const validateCitationKey = (value: string | undefined) => {
    const error = citationKeyValidationError(value, paper.id, papers);
    setMetadataError(error);
    return !error;
  };
  const editCitationKey = () => {
    const next = window.prompt(copy.infoTab.citationKeyPrompt, paper.citationKey ?? "");
    if (next !== null && validateCitationKey(next.trim() || undefined)) {
      onUpdateMetadata({ citationKey: next.trim() || undefined });
    }
  };
  const saveMetadata = () => {
    const parsedYear = Number.parseInt(metadataDraft.year, 10);
    if (!validateCitationKey(metadataDraft.citationKey.trim() || undefined)) return;
    onUpdateMetadata({
      title: metadataDraft.title.trim() || paper.title,
      itemType: metadataDraft.itemType,
      authors: metadataDraft.authors.split(/[;,]/).map((author) => author.trim()).filter(Boolean),
      venue: metadataDraft.venue.trim(),
      year: Number.isFinite(parsedYear) && parsedYear > 0 ? parsedYear : undefined,
      date: metadataDraft.date.trim() || undefined,
      doi: metadataDraft.doi.trim() || undefined,
      isbn: metadataDraft.isbn.trim() || undefined,
      citationKey: metadataDraft.citationKey.trim() || undefined,
      volume: metadataDraft.volume.trim() || undefined,
      issue: metadataDraft.issue.trim() || undefined,
      pages: metadataDraft.pages.trim() || undefined,
      publisher: metadataDraft.publisher.trim() || undefined,
      place: metadataDraft.place.trim() || undefined,
      edition: metadataDraft.edition.trim() || undefined,
      series: metadataDraft.series.trim() || undefined,
      language: metadataDraft.language.trim() || undefined,
      accessed: metadataDraft.accessed.trim() || undefined,
      url: metadataDraft.url.trim() || undefined,
      abstract: metadataDraft.abstract.trim(),
    });
    setMetadataError(null);
    setMetadataEditing(false);
  };
  return (
    <div className="lip-panel">
      {(fit || paper.starred) && (
        <div className="lip-badges">
          {fit && (
            <span className={`lit-relevance-badge relevance-${fit}`}>
              {copy.fit[fit]}{paper.verdict?.score !== undefined ? ` · ${paper.verdict.score}` : ""}
            </span>
          )}
          {paper.starred && <span className="lip-star-badge"><SvgIcon name="star" size={13} /> {copy.infoTab.starred}</span>}
        </div>
      )}

      <div className="lip-section">
        <div className="lip-section-head">{copy.infoTab.infoHeading}</div>
        <dl className="lip-meta">
          <dt>{copy.infoTab.itemType}</dt><dd>{itemTypeLabel(copy, paper.itemType)}</dd>
          {paper.authors.map((author, i) => (
            <Fragment key={i}>
              <dt>{i === 0 ? copy.infoTab.author : ""}</dt>
              <dd>{author}</dd>
            </Fragment>
          ))}
          {paper.venue && <><dt>{copy.infoTab.venue}</dt><dd>{paper.venue}</dd></>}
          {paper.year && <><dt>{copy.infoTab.year}</dt><dd>{paper.year}</dd></>}
          {paper.date && paper.date !== String(paper.year ?? "") && <><dt>{copy.infoTab.preciseDate}</dt><dd>{paper.date}</dd></>}
          {paper.volume && <><dt>{copy.infoTab.volume}</dt><dd>{paper.volume}</dd></>}
          {paper.issue && <><dt>{copy.infoTab.issue}</dt><dd>{paper.issue}</dd></>}
          {paper.pages && <><dt>{copy.infoTab.pages}</dt><dd>{paper.pages}</dd></>}
          {paper.publisher && <><dt>{copy.infoTab.publisher}</dt><dd>{paper.publisher}</dd></>}
          {paper.place && <><dt>{copy.infoTab.place}</dt><dd>{paper.place}</dd></>}
          {paper.citedBy !== undefined && <><dt>{copy.infoTab.citations}</dt><dd>{paper.citedBy}</dd></>}
          {paper.doi && (
            <>
              <dt>DOI</dt>
              <dd><a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">{paper.doi}</a></dd>
            </>
          )}
          {paper.isbn && <><dt>ISBN</dt><dd>{paper.isbn}</dd></>}
          {paper.citationKey && <><dt>Citation key</dt><dd>{paper.citationKey}</dd></>}
          {paper.arxivId && (
            <>
              <dt>arXiv</dt>
              <dd><a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer">{paper.arxivId}</a></dd>
            </>
          )}
          <dt>{copy.infoTab.source}</dt><dd>{paper.source}</dd>
          <dt>{copy.infoTab.stage}</dt><dd>{copy.stage[paper.stage]}</dd>
          <dt>{copy.infoTab.addedAt}</dt><dd>{paper.addedAt.slice(0, 10)}</dd>
          <dt>PDF</dt>
          <dd>
            {paper.pdf.status === "downloaded" ? copy.infoTab.pdfDownloaded
              : paper.pdf.status === "downloading" ? copy.infoTab.pdfDownloading
              : paper.pdf.status === "failed" ? copy.infoTab.pdfFailed
              : paper.pdf.url ? copy.infoTab.pdfHasLink : copy.infoTab.pdfNoLink}
          </dd>
        </dl>
      </div>

      <div className="lip-section">
        <div className="lip-section-head">{copy.infoTab.abstractHeading}</div>
        <p className={`lip-abstract${paper.abstract ? "" : " lip-abstract-missing"}`}>
          {paper.abstract || copy.infoTab.noAbstract}
        </p>
      </div>

      {paper.verdict?.rationale && (
        <div className="lip-section">
        <div className="lip-section-head">{copy.infoTab.aiRelevanceReason}</div>
          <p className="lip-abstract">{paper.verdict.rationale}</p>
        </div>
      )}

      <div className="lip-section">
        <div className="lip-section-head">{copy.infoTab.tagsHeading}</div>
        <div className="lip-tags">
          {paper.tags.map((tag) => (
            <span key={tag} className={`lit-tag ${tagColorClass(tag)}`}>{tag}</span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => onTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddTag(); }}
            placeholder={copy.infoTab.addTagPlaceholder}
            className="lip-tag-input"
            aria-label={copy.infoTab.addTagAria}
          />
        </div>
      </div>

      {collections.length > 0 && (
        <div className="lip-section">
          <div className="lip-section-head">{copy.infoTab.categoriesHeading}</div>
          <div className="lip-tags">
            {collections.map((col) => {
              const assigned = paper.collectionIds.includes(col.id);
              return (
                <button
                  key={col.id}
                  type="button"
                  className={`lit-collection-toggle${assigned ? " active" : ""}`}
                  aria-pressed={assigned}
                  onClick={() => onToggleCollection(col.id)}
                >
                  <SvgIcon name={assigned ? "check" : "plus"} size={12} /> {col.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {metadataEditing && (
        <div className="lip-section lip-metadata-editor">
          <div className="lip-section-head">{copy.infoTab.editMetadataHeading}</div>
          <label>{copy.infoTab.fieldTitle}<input value={metadataDraft.title} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, title: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldType}
            <select value={metadataDraft.itemType} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, itemType: event.target.value as typeof draft.itemType }))}>
              {METADATA_ITEM_TYPES.map((itemType) => <option key={itemType} value={itemType}>{itemTypeLabel(copy, itemType)}</option>)}
            </select>
          </label>
          <label>{copy.infoTab.fieldAuthors} <span>{copy.infoTab.fieldAuthorsHint}</span><input value={metadataDraft.authors} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, authors: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldVenue}<input value={metadataDraft.venue} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, venue: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldYear}<input inputMode="numeric" value={metadataDraft.year} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, year: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldDate}<input value={metadataDraft.date} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, date: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldVolume}<input value={metadataDraft.volume} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, volume: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldIssue}<input value={metadataDraft.issue} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, issue: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldPages}<input value={metadataDraft.pages} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, pages: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldPublisher}<input value={metadataDraft.publisher} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, publisher: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldPlace}<input value={metadataDraft.place} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, place: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldEdition}<input value={metadataDraft.edition} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, edition: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldSeries}<input value={metadataDraft.series} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, series: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldLanguage}<input value={metadataDraft.language} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, language: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldAccessed}<input value={metadataDraft.accessed} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, accessed: event.target.value }))} /></label>
          <label>DOI<input value={metadataDraft.doi} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, doi: event.target.value }))} /></label>
          <label>ISBN<input value={metadataDraft.isbn} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, isbn: event.target.value }))} /></label>
          <label>{copy.infoTab.citationKeyPrompt}<input value={metadataDraft.citationKey} onChange={(event) => { setMetadataError(null); setMetadataDraft((draft) => ({ ...draft, citationKey: event.target.value })); }} /></label>
          <label>{copy.infoTab.fieldUrl}<input value={metadataDraft.url} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, url: event.target.value }))} /></label>
          <label>{copy.infoTab.fieldAbstract}<textarea rows={5} value={metadataDraft.abstract} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, abstract: event.target.value }))} /></label>
          {metadataError && <p className="lit-error" role="alert">{metadataError}</p>}
          <div className="lip-metadata-editor-actions">
            <button type="button" className="primary" onClick={saveMetadata}>{copy.infoTab.saveMetadata}</button>
            <button type="button" onClick={() => setMetadataEditing(false)}>{copy.infoTab.cancel}</button>
          </div>
        </div>
      )}

      <div className="lip-section lip-actions-section">
        <button type="button" className="lit-action-btn" onClick={() => setMetadataEditing((value) => !value)}>{metadataEditing ? copy.infoTab.closeEditor : copy.infoTab.editMetadata}</button>
        <button type="button" className="lit-action-btn" onClick={editCitationKey}>{copy.infoTab.editCitationKey}</button>
        <button type="button" className="lit-action-btn" onClick={onOpenReader}
                disabled={paper.pdf.status === "downloading"}>
          {paper.pdf.status === "downloaded" ? copy.infoTab.openPdf
            : paper.pdf.status === "downloading" ? copy.infoTab.downloading
            : paper.pdf.url ? copy.infoTab.downloadPdf : copy.infoTab.getPdf}
        </button>
        <button type="button" className="lit-action-btn" onClick={onViewOverview}>{copy.infoTab.brief}</button>
        <button type="button" className="lit-action-btn" onClick={onViewEvidence}>{copy.infoTab.viewEvidence}</button>
        <button type="button" className="lit-action-btn" onClick={onAsk}>{copy.infoTab.askAgent}</button>
        {paper.stage !== "shortlist" && paper.stage !== "downloaded" && paper.stage !== "read" && (
          <button type="button" className="lit-action-btn starred" onClick={onShortlist}>{copy.infoTab.addToShortlist}</button>
        )}
        <button type="button" className="lit-action-btn danger" onClick={onDelete}>{copy.infoTab.delete}</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Nav helpers
// ──────────────────────────────────────────────────────────────────────────────

function NavItem({
  label,
  icon,
  count,
  active,
  onClick,
  dot,
}: {
  label: string;
  icon: SvgIconName;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: PaperStage;
}) {
  return (
    <button type="button" className={`lit-nav-item${active ? " active" : ""}`} onClick={onClick}>
      <span className="lit-nav-icon" aria-hidden="true">
        {dot ? <span className={`lit-stage-dot ${dot}`} /> : <SvgIcon name={icon} size={14} />}
      </span>
      <span className="lit-nav-text">{label}</span>
      <span className="lit-nav-count">{count}</span>
    </button>
  );
}

function NavSection({
  title,
  defaultOpen,
  extra,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="lit-sidebar-section">
      <div className="lit-section-header">
        <button
          type="button"
          className="lit-section-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="lit-section-label">{title}</span>
          <span className="lit-section-caret" aria-hidden="true"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={11} /></span>
        </button>
        {extra}
      </div>
      {open && children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Fit / stage helpers (shared display)
// ──────────────────────────────────────────────────────────────────────────────

// stage dot (kept for NavItem)
// lit-stage-dot classes defined in CSS

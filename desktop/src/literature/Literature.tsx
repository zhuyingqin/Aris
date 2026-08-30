import { Fragment, lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isTauri,
  literatureAttachmentOpen,
  literatureAttachmentOpenExternal,
  literatureAttachmentStatus,
  literatureLlm,
  literatureAddIdentifier,
  literatureDuplicateCandidates,
  literatureExportBibliography,
  literatureFullTextSearch,
  literatureImportBibliography,
  literatureImportPdfAsRecord,
  literatureMergeDuplicates,
  literatureSearchCancel,
  literatureSearchProtocolCreate,
  literatureSearchProtocolExecute,
  literatureSearchProtocolPreview,
  listenLiteratureSearchProgress,
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
import LiteratureViewTabs, { type LiteraturePageView } from "./LiteratureViewTabs";
import AdvancedSearchBuilder from "./AdvancedSearchBuilder";
import CitationStyleManager from "./CitationStyleManager";
import LiteratureResourceReader from "./LiteratureResourceReader";
import {
  matchesSearchConditions,
  normalizeSearchConditions,
} from "./advancedSearch";
import {
  attachQuickCopyToDrag,
  buildQuickCopy,
  writeQuickCopy,
  type QuickCopyItem,
  type QuickCopyKind,
} from "./quickCopy";
import { buildLiteratureReport } from "./report";
import {
  citationKeyValidationError,
  savedSearchRemovalImpact,
  useLiteratureStore,
} from "./literatureStore";
import { LITERATURE_COPY } from "./i18n";
import {
  type DetailTab,
  type ActivityLevel,
  type LiteratureLibrary,
  type LiteratureLibraryItemSnapshot,
  type LiteratureLibraryModelSnapshot,
  type LiteratureCollection,
  type LiteratureAttachment,
  type LiteratureDuplicateCandidate,
  type LiteratureLibraryItemRelation,
  type LiteraturePaper,
  type LiteratureStorageStatus,
  type LiteratureProtocolExecution,
  type LiteratureProtocolPreview,
  type LiteratureSearchProtocolDraft,
  type LiteratureSearchCondition,
  type LiteratureMetadataPatch,
  type LiteratureCreatorInput,
  type LiteratureNote,
  type LiteratureWorkflowGradeLevel,
  type PaperStage,
} from "./literatureTypes";
import "./Literature.css";

type SortKey = "added" | "fit" | "year" | "title" | "citations";
type BibliographyExportFormat = "bibtex" | "biblatex" | "ris" | "csl-json" | "zotero-json";

const Knowledge = lazy(() => import("../knowledge/KnowledgeReview"));
const LazyMathText = lazy(() => import("./MathText"));
const PdfReader = lazy(() => import("./PdfReader"));

const AUTO_RETRIEVAL_CARDS_STORAGE_KEY = "somniq-literature-auto-retrieval-cards-v1";
const RETRIEVAL_CARD_BUILD_BATCH_SIZE = 24;
const MANUAL_ITEM_TYPES = [
  "journalArticle", "artwork", "audioRecording", "bill", "book", "bookSection",
  "case", "computerProgram", "conferencePaper", "dictionaryEntry", "document",
  "forumPost", "hearing", "instantMessage",
  "encyclopediaArticle", "magazineArticle", "newspaperArticle", "blogPost",
  "manuscript", "map", "patent", "presentation", "standard", "software",
  "thesis", "report", "webpage", "dataset", "preprint", "other",
  "email", "letter", "statute", "film", "interview", "podcast",
  "radioBroadcast", "tvBroadcast", "videoRecording",
] as const;
const DETAIL_TAB_ICONS: Record<DetailTab, SvgIconName> = {
  info: "info",
  overview: "sparkle",
  reader: "document",
  evidence: "shieldCheck",
  notes: "notebook",
  files: "folder",
  related: "graph",
};

function DetailTabRail({
  tabs,
  activeTab,
  label,
  className,
  onSelect,
}: {
  tabs: Array<{ id: DetailTab; label: string }>;
  activeTab: DetailTab;
  label: string;
  className: string;
  onSelect: (tab: DetailTab) => void;
}) {
  return (
    <nav className={className} role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-label={tab.label}
          aria-selected={activeTab === tab.id}
          className={`lit-workspace-tab${activeTab === tab.id ? " active" : ""}`}
          title={tab.label}
          onClick={() => onSelect(tab.id)}
        >
          <SvgIcon name={DETAIL_TAB_ICONS[tab.id]} size={16} className="lit-workspace-tab-icon" />
        </button>
      ))}
    </nav>
  );
}

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

const SEARCH_SOURCES = [
  "scopus",
  "openalex",
  "semantic-scholar",
  "crossref",
  "arxiv",
] as const;

function ReproducibleSearchPanel({
  language,
  onCompleted,
  onActivity,
}: {
  language: Language;
  onCompleted: () => Promise<void>;
  onActivity: (level: ActivityLevel, message: string) => void;
}) {
  const cn = language === "cn";
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState<string[]>([...SEARCH_SOURCES]);
  const [maxResults, setMaxResults] = useState(50);
  const [timeWindow, setTimeWindow] = useState("");
  const [preview, setPreview] = useState<LiteratureProtocolPreview | null>(null);
  const [execution, setExecution] = useState<LiteratureProtocolExecution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Array<{
    source: string;
    phase: string;
    message?: string;
  }>>([]);
  /** Id of the run currently in flight, so the Stop button can address it.
   * Held in a ref because the stop handler must read the live value, not the
   * one captured when the button rendered. */
  const searchRequestId = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenLiteratureSearchProgress((event) => {
      if (disposed) return;
      setProgress((current) => [
        ...current.filter((item) => item.source !== event.source),
        { source: event.source, phase: event.phase, message: event.message },
      ]);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const toggleSource = (source: string) => {
    setPreview(null);
    setExecution(null);
    setConfirmed(false);
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  };

  const createPreview = async () => {
    const normalized = question.trim();
    if (!normalized || sources.length === 0 || busy) return;
    setBusy("preview");
    setError("");
    setExecution(null);
    setConfirmed(false);
    try {
      const draft: LiteratureSearchProtocolDraft = {
        question: normalized,
        scope: cn
          ? "由桌面端创建的可复现发现检索。"
          : "Reproducible discovery search created in Desktop.",
        timeWindow: timeWindow.trim(),
        databases: sources,
        queries: {},
        queryVariants: {},
        maxResults: Math.max(1, maxResults),
        inclusionCriteria: [],
        exclusionCriteria: [],
        knownKeyPapers: [],
      };
      const created = await literatureSearchProtocolCreate<{
        protocol: { id: string };
      }>(draft);
      const next = await literatureSearchProtocolPreview<LiteratureProtocolPreview>(
        created.protocol.id,
      );
      setPreview(next);
      onActivity(
        "info",
        cn
          ? `已创建并预览检索协议 ${created.protocol.id}`
          : `Created and previewed search protocol ${created.protocol.id}`,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** Runs one bounded pass and reports it. `continueRunId` picks up the cursors
   * of a previous partial run — including one the user stopped. */
  const runSearch = async (continueRunId?: string) => {
    if (!preview || busy) return;
    const requestId = `literature-search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    searchRequestId.current = requestId;
    setBusy("execute");
    setStopping(false);
    setError("");
    setProgress([]);
    try {
      const result = await literatureSearchProtocolExecute<LiteratureProtocolExecution>(
        preview.protocol.id,
        "execute",
        continueRunId,
        undefined,
        requestId,
      );
      setExecution(result);
      await onCompleted();
      const label = continueRunId
        ? (cn ? "续搜运行" : "Continuation run")
        : (cn ? "检索运行" : "Search run");
      if (result.cancelled) {
        onActivity(
          "warn",
          cn
            ? `${label} ${result.searchRun.id}：已停止，保留 ${result.searchRun.recordIds.length} 条记录，可继续检索`
            : `${label} ${result.searchRun.id}: stopped; ${result.searchRun.recordIds.length} records kept and the run can be continued`,
        );
      } else {
        onActivity(
          result.searchRun.status === "completed" ? "ok" : "warn",
          cn
            ? `${label} ${result.searchRun.id}：${result.searchRun.status}，保留 ${result.searchRun.recordIds.length} 条记录`
            : `${label} ${result.searchRun.id}: ${result.searchRun.status}; retained ${result.searchRun.recordIds.length} records`,
        );
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      searchRequestId.current = null;
      setStopping(false);
      setBusy(null);
    }
  };

  const execute = async () => {
    if (!confirmed) return;
    await runSearch();
  };

  const continueSearch = async () => {
    if (!execution) return;
    await runSearch(execution.searchRun.id);
  };

  /** Asks the kernel to stop at the next source, variant, or page boundary. The
   * run still resolves normally and keeps everything already retrieved, so this
   * never leaves the panel waiting on a promise that no longer settles. */
  const stopSearch = async () => {
    const requestId = searchRequestId.current;
    if (!requestId || stopping) return;
    setStopping(true);
    try {
      await literatureSearchCancel(requestId);
      onActivity(
        "info",
        cn
          ? "已请求停止检索，将在当前请求结束后停下。"
          : "Stop requested; the run ends after the request already in flight.",
      );
    } catch (cause) {
      setStopping(false);
      setError(String(cause));
    }
  };

  // A stopped run also leaves sources that were never attempted at all, and
  // those produce no attempt row to detect — so the stop itself is the signal.
  const canContinue = execution?.cancelled === true
    || (execution?.searchRun.sourceAttempts.some((attempt) =>
      (!attempt.coverage.exhausted && Boolean(attempt.coverage.nextCursor))
        || ["failed", "rate_limited", "unauthorised", "unavailable"].includes(attempt.status),
    ) ?? false);

  return (
    <section className="lit-protocol-search" aria-label={cn ? "可复现外部文献检索" : "Reproducible external literature search"}>
      <div className="lit-protocol-search-head">
        <div>
          <span>{cn ? "外部发现" : "External discovery"}</span>
          <h2>{cn ? "可复现检索协议" : "Reproducible search protocol"}</h2>
          <p>{cn ? "先检查数据源、查询变体与上限，再明确确认网络检索。" : "Review sources, query variants, and bounds before explicitly confirming network retrieval."}</p>
        </div>
      </div>
      <div className="lit-protocol-search-form">
        <textarea
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            setPreview(null);
            setExecution(null);
          }}
          placeholder={cn ? "研究问题、主题或关键词" : "Research question, topic, or keywords"}
          rows={3}
        />
        <div className="lit-protocol-source-row">
          {SEARCH_SOURCES.map((source) => (
            <label key={source}>
              <input
                type="checkbox"
                checked={sources.includes(source)}
                onChange={() => toggleSource(source)}
              />
              {source}
            </label>
          ))}
          <label className="lit-protocol-limit">
            {cn ? "每源上限" : "Per-source limit"}
            <input
              type="number"
              min={1}
              max={5000}
              value={maxResults}
              onChange={(event) => {
                setMaxResults(Math.max(1, Number(event.target.value) || 1));
                setPreview(null);
                setExecution(null);
              }}
            />
          </label>
          <label className="lit-protocol-limit">
            {cn ? "时间窗" : "Time window"}
            <input
              type="text"
              value={timeWindow}
              placeholder={cn ? "如 2020-2025" : "e.g. 2020-2025"}
              onChange={(event) => {
                setTimeWindow(event.target.value);
                setPreview(null);
                setExecution(null);
              }}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={!question.trim() || sources.length === 0 || busy != null}
            onClick={() => void createPreview()}
          >
            {busy === "preview" ? (cn ? "正在预览…" : "Previewing…") : (cn ? "创建并预览" : "Create & preview")}
          </button>
        </div>
      </div>

      {preview && (
        <div className="lit-protocol-preview">
          <div className="lit-protocol-preview-title">
            <strong>{cn ? "执行预览" : "Execution preview"}</strong>
            <span>{cn ? `每个数据源最多保留 ${preview.maxResults} 条唯一记录` : `Up to ${preview.maxResults} unique records retained per source`}</span>
          </div>
          <div className="lit-protocol-plan-grid">
            {preview.plan.map((item) => (
              <article key={item.source}>
                <header>
                  <strong>{item.source}</strong>
                  <span className={item.adapterStatus === "available" ? "ready" : "unavailable"}>
                    {item.adapterStatus}
                  </span>
                </header>
                {(item.queryVariantPlan ?? item.queryVariants.map((variant) => ({
                  ...variant,
                  maxResults: item.maxResults,
                  willExecute: true,
                }))).map((variant) => (
                  <div key={`${item.source}-${variant.kind}`} className="lit-protocol-query">
                    <span>
                      {variant.kind} · {variant.willExecute
                        ? `max ${variant.maxResults}`
                        : "not scheduled"}
                    </span>
                    <code>{variant.query}</code>
                  </div>
                ))}
              </article>
            ))}
          </div>
          <div className="lit-protocol-confirm">
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {cn ? "我已检查查询与范围，确认执行外部网络检索。" : "I reviewed the queries and scope and confirm external network retrieval."}
            </label>
            <button
              type="button"
              className="primary"
              disabled={!confirmed || busy != null}
              onClick={() => void execute()}
            >
              {busy === "execute" ? (cn ? "正在检索…" : "Searching…") : (cn ? "确认并执行" : "Confirm & execute")}
            </button>
            {busy === "execute" && (
              <button
                type="button"
                disabled={stopping}
                onClick={() => void stopSearch()}
                title={cn
                  ? "在当前数据源请求结束后停止；已检索到的记录会保留，可继续检索。"
                  : "Stops after the request already in flight; retrieved records are kept and the run can be continued."}
              >
                {stopping ? (cn ? "正在停止…" : "Stopping…") : (cn ? "停止检索" : "Stop")}
              </button>
            )}
          </div>
        </div>
      )}

      {execution && (
        <div className="lit-protocol-coverage">
          <div>
            <strong>{cn ? "覆盖状态" : "Coverage"}</strong>
            <span>{execution.searchRun.status} · {execution.searchRun.recordIds.length} {cn ? "条唯一记录" : "unique records"}</span>
          </div>
          <div className="lit-protocol-coverage-grid">
            {execution.searchRun.sourceAttempts.map((attempt, index) => (
              <article key={`${attempt.source}-${attempt.status}-${index}`}>
                <header><strong>{attempt.source}</strong><span>{attempt.status}</span></header>
                <dl>
                  <div><dt>total</dt><dd>{attempt.coverage.totalHits ?? "?"}</dd></div>
                  <div><dt>fetched</dt><dd>{attempt.coverage.fetched}</dd></div>
                  <div><dt>unique</dt><dd>{attempt.coverage.unique}</dd></div>
                  <div>
                    <dt>{cn ? "覆盖率" : "coverage"}</dt>
                    <dd>
                      {attempt.coverage.totalHits && attempt.coverage.totalHits > 0
                        ? `${Math.min(100, Math.round((attempt.coverage.fetched / attempt.coverage.totalHits) * 100))}%`
                        : "n/a"}
                    </dd>
                  </div>
                </dl>
                <p className={attempt.coverage.exhausted ? "complete" : "truncated"}>
                  {attempt.coverage.exhausted
                    ? (cn ? "已遍历完" : "exhausted")
                    : `${cn ? "未遍历完" : "not exhausted"} · ${attempt.coverage.truncatedReason ?? "unknown"}`}
                </p>
                {attempt.failureMessage && <small>{attempt.failureMessage}</small>}
              </article>
            ))}
          </div>
          {canContinue && (
            <button
              type="button"
              className="primary"
              disabled={busy != null}
              onClick={() => void continueSearch()}
            >
              {busy === "execute"
                ? (cn ? "正在继续…" : "Continuing…")
                : (cn ? "继续未完成的数据源" : "Continue incomplete sources")}
            </button>
          )}
        </div>
      )}
      {progress.length > 0 && busy === "execute" && (
        <div className="lit-protocol-progress" aria-live="polite">
          {progress.map((item) => (
            <span key={item.source}>
              <strong>{item.source}</strong> · {item.phase}
              {item.message ? ` · ${item.message}` : ""}
            </span>
          ))}
        </div>
      )}
      {error && <p className="lit-rag-database-error">{error}</p>}
    </section>
  );
}

const ANSWER_CITATION_RE =
  /\[(?:[PK]\d+\s+)?([^\]\r\n]+?)\s+p\.(\d+)(?:\s+raw-pdf-[^\]\r\n]+)?\]/g;

/**
 * Keep model-facing citations stable while presenting them as a paper/page
 * link. The optional P1/P2/K1 prefix and extraction suffix support answers
 * generated by older app versions without exposing those internal labels.
 */
function LiteratureAnswerText({
  answer,
  paperTitle,
  onOpenCitation,
}: {
  answer: string;
  paperTitle: (paperId: string) => string;
  onOpenCitation: (paperId: string, page?: number) => void;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  ANSWER_CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSWER_CITATION_RE.exec(answer)) !== null) {
    if (match.index > cursor) parts.push(answer.slice(cursor, match.index));
    const paperId = match[1].trim();
    const page = Number.parseInt(match[2], 10);
    parts.push(
      <button
        type="button"
        className="lit-rag-answer-citation"
        key={`${match.index}-${paperId}-${page}`}
        title={match[0]}
        onClick={() => onOpenCitation(paperId, page)}
      >
        {paperTitle(paperId)} · p.{page}
      </button>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < answer.length) parts.push(answer.slice(cursor));
  return <p>{parts}</p>;
}

interface LiteratureProps {
  pageView?: LiteraturePageView;
  onPageViewChange?: (view: LiteraturePageView) => void;
}

type LiteratureCopy = (typeof LITERATURE_COPY)[Language];

const TAG_COLORS = ["amber", "blue", "green", "purple", "accent"];
const TAG_COLOR_OPTIONS = [
  { value: "#f59e0b", label: "amber" },
  { value: "#3b82f6", label: "blue" },
  { value: "#22c55e", label: "green" },
  { value: "#a855f7", label: "purple" },
  { value: "#ef4444", label: "red" },
  { value: "#06b6d4", label: "cyan" },
];

function tagColorClass(tag: string, color?: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color?.trim() ?? "")) return "lit-tag-colored";
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) & 0xffff;
  return `lit-tag-${TAG_COLORS[hash % TAG_COLORS.length]}`;
}

function tagColorStyle(color?: string): CSSProperties | undefined {
  const value = color?.trim();
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return { "--lit-tag-color": value } as CSSProperties;
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

const WORKFLOW_GRADE_LEVELS: LiteratureWorkflowGradeLevel[] = ["A", "B", "C", "D"];

function workflowGradeViewId(workflowRunId: string, grade: LiteratureWorkflowGradeLevel) {
  return `grade:${encodeURIComponent(workflowRunId)}:${grade}`;
}

function parseWorkflowGradeView(view: string): {
  workflowRunId: string;
  grade: LiteratureWorkflowGradeLevel;
} | null {
  if (!view.startsWith("grade:")) return null;
  const encoded = view.slice(6, -2);
  const grade = view.at(-1);
  if (!encoded || !WORKFLOW_GRADE_LEVELS.includes(grade as LiteratureWorkflowGradeLevel)) return null;
  try {
    return {
      workflowRunId: decodeURIComponent(encoded),
      grade: grade as LiteratureWorkflowGradeLevel,
    };
  } catch {
    return null;
  }
}

/** Local full-text page. `paperIds` carries the same visible set as `papers`
 * without the record payload; `papers` stays for older backends. */
interface LiteratureFullTextPage {
  paperIds?: string[];
  papers?: Array<{ id: string }>;
  total: number;
  exhausted: boolean;
  nextOffset?: number;
}

function fullTextPageIds(page: LiteratureFullTextPage): string[] {
  if (Array.isArray(page.paperIds)) return page.paperIds;
  return (page.papers ?? []).map((paper) => paper.id);
}

function matchesView(paper: LiteraturePaper, view: string) {
  if (view === "all") return paper.stage !== "excluded";
  if (view === "unfiled") return paper.stage !== "excluded" && paper.collectionIds.length === 0;
  if (view === "trash") return true;
  if (view === "starred") return paper.starred;
  if (view.startsWith("stage:")) return paper.stage === view.slice(6);
  if (view.startsWith("col:")) return paper.collectionIds.includes(view.slice(4));
  if (view.startsWith("search:")) return paper.searchIds.includes(view.slice(7));
  const workflowGradeView = parseWorkflowGradeView(view);
  if (workflowGradeView) {
    return paper.workflowGrades?.some((entry) => (
      entry.workflowRunId === workflowGradeView.workflowRunId
      && entry.grade === workflowGradeView.grade
    )) ?? false;
  }
  return true;
}

function matchesQuery(paper: LiteraturePaper, needle: string) {
  if (!needle) return true;
  const cached = paperSearchTextCache.get(paper);
  const creators = (paper.creators ?? []).flatMap((creator) => [
    creator.name ?? "",
    creator.firstName ?? "",
    creator.lastName ?? "",
    creator.creatorType ?? "",
  ]);
  const attachments = (paper.attachments ?? []).flatMap((attachment) => [
    attachment.label,
    attachment.path,
    attachment.url,
    attachment.externalPath,
    attachment.filename,
    attachment.mimeType,
    attachment.hash,
  ]);
  const notes = (paper.notes ?? []).flatMap((note) => [
    note.title ?? "",
    note.content,
    note.source ?? "",
  ]);
  const extra = Object.entries(paper.metadataFields ?? {}).flatMap(([key, value]) => [key, value]);
  const searchText = cached ?? [
    paper.title,
    paper.authors.join(" "),
    ...creators,
    paper.venue,
    paper.abstract,
    paper.tags.join(" "),
    paper.doi ?? "",
    paper.arxivId ?? "",
    paper.itemType ?? "",
    paper.date ?? "",
    paper.citationKey ?? "",
    ...extra,
    ...attachments,
    ...notes,
  ]
    .join(" ")
    .toLowerCase();
  if (!cached) paperSearchTextCache.set(paper, searchText);
  return searchText.includes(needle);
}

const paperSearchTextCache = new WeakMap<LiteraturePaper, string>();

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

type LiteratureChildKind = "attachment" | "note" | "annotation";

interface LiteratureTreeChild {
  id: string;
  parentId: string;
  kind: LiteratureChildKind;
  depth: number;
  label: string;
  detail: string;
  page?: number;
  attachmentId?: string;
  snapshot?: LiteratureLibraryItemSnapshot;
}

type LiteratureTreeChildrenIndex = ReadonlyMap<string, LiteratureTreeChild[]>;

function buildLiteratureTreeChildrenIndex(
  model: LiteratureLibraryModelSnapshot | null,
): LiteratureTreeChildrenIndex | null {
  if (!model || model.items.length === 0) return null;
  const byParent = new Map<string, LiteratureTreeChild[]>();
  for (const snapshot of model.items) {
    const kind = childKindForItem(snapshot.item.itemType);
    const parentId = snapshot.item.parentItemId;
    if (!kind || !parentId || snapshot.item.deleted || snapshot.item.trashed) continue;
    const display = childDisplayForSnapshot(snapshot);
    const children = byParent.get(parentId) ?? [];
    children.push({
      id: snapshot.item.id,
      parentId,
      kind,
      depth: 1,
      ...display,
      snapshot,
    });
    byParent.set(parentId, children);
  }
  for (const children of byParent.values()) {
    children.sort((left, right) => {
      const leftDate = left.snapshot?.item.dateAdded ?? "";
      const rightDate = right.snapshot?.item.dateAdded ?? "";
      return leftDate.localeCompare(rightDate) || left.id.localeCompare(right.id);
    });
  }
  return byParent;
}

const childKindForItem = (itemType: string): LiteratureChildKind | null => {
  if (itemType === "attachment") return "attachment";
  if (itemType === "note") return "note";
  if (itemType === "annotation") return "annotation";
  return null;
};

const childDisplayForSnapshot = (snapshot: LiteratureLibraryItemSnapshot): Pick<LiteratureTreeChild, "label" | "detail" | "page" | "attachmentId"> => {
  const kind = childKindForItem(snapshot.item.itemType);
  const fields = snapshot.fields ?? {};
  if (kind === "attachment") {
    return {
      label: fields.title || fields.filename || "Attachment",
      detail: fields.path || fields.url || fields.externalPath || fields.contentType || "",
    };
  }
  if (kind === "note") {
    return {
      label: fields.title || "Note",
      detail: fields.note || "",
      attachmentId: snapshot.item.parentItemId,
    };
  }
  const pageValue = Number.parseInt(fields.annotationPageLabel ?? "", 10);
  return {
    label: pageValue > 0 ? `Annotation · p.${pageValue}` : "Annotation",
    detail: fields.annotationText || fields.annotationComment || "",
    page: pageValue > 0 ? pageValue : undefined,
    attachmentId: snapshot.item.parentItemId,
  };
};

/** Flatten only the expanded descendants of a bibliographic item.  The
 * normalized model is preferred; legacy arrays are a deliberate fallback for
 * old preview data and projects that have not yet been hydrated. */
function literatureTreeChildren(
  paper: LiteraturePaper,
  modelChildrenByParent: LiteratureTreeChildrenIndex | null,
): LiteratureTreeChild[] {
  const result: LiteratureTreeChild[] = [];
  if (modelChildrenByParent) {
    const visit = (parentId: string, depth: number, ancestry: Set<string>) => {
      for (const child of modelChildrenByParent.get(parentId) ?? []) {
        if (ancestry.has(child.id)) continue;
        result.push({
          ...child,
          parentId,
          depth,
        });
        visit(child.id, depth + 1, new Set([...ancestry, child.id]));
      }
    };
    visit(paper.id, 1, new Set([paper.id]));
    if (result.length > 0) return result;
  }

  const children: Array<LiteratureTreeChild & { order: number }> = [];
  const attachments = paper.attachments ?? [];
  for (const [order, attachment] of attachments.entries()) {
    children.push({
      id: attachment.id,
      parentId: paper.id,
      kind: "attachment",
      depth: 1,
      label: attachment.label,
      detail: attachment.path ?? attachment.url ?? attachment.externalPath ?? attachment.mimeType ?? "",
      order,
    });
  }
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
  for (const [order, note] of (paper.notes ?? []).entries()) {
    const parentId = note.attachmentId && attachmentIds.has(note.attachmentId) ? note.attachmentId : paper.id;
    children.push({
      id: note.id,
      parentId,
      kind: "note",
      depth: parentId === paper.id ? 1 : 2,
      label: note.title || "Note",
      detail: note.content,
      attachmentId: note.attachmentId,
      order: attachments.length + order,
    });
  }
  for (const [order, annotation] of paper.pdfAnnotations.entries()) {
    const parentId = annotation.attachmentId && attachmentIds.has(annotation.attachmentId)
      ? annotation.attachmentId
      : paper.id;
    children.push({
      id: annotation.id,
      parentId,
      kind: "annotation",
      depth: parentId === paper.id ? 1 : 2,
      label: `Annotation · p.${annotation.page}`,
      detail: annotation.quote || annotation.note,
      page: annotation.page,
      attachmentId: annotation.attachmentId,
      order: attachments.length + (paper.notes ?? []).length + order,
    });
  }
  const byParent = new Map<string, Array<LiteratureTreeChild & { order: number }>>();
  for (const child of children) {
    const siblings = byParent.get(child.parentId) ?? [];
    siblings.push(child);
    byParent.set(child.parentId, siblings);
  }
  const visitLegacy = (parentId: string, ancestry: Set<string>) => {
    for (const child of (byParent.get(parentId) ?? []).sort((a, b) => a.order - b.order)) {
      if (ancestry.has(child.id)) continue;
      const { order: _order, ...entry } = child;
      result.push(entry);
      visitLegacy(child.id, new Set([...ancestry, child.id]));
    }
  };
  visitLegacy(paper.id, new Set([paper.id]));
  return result;
}

function hasLegacyLiteratureTreeChildren(paper: LiteraturePaper) {
  return (paper.attachments?.length ?? 0) > 0
    || (paper.notes?.length ?? 0) > 0
    || paper.pdfAnnotations.length > 0;
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
          <LiteratureAnswerText
            answer={answer}
            paperTitle={paperTitle}
            onOpenCitation={onOpenCitation}
          />
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
  const literatureLibraryScope = useStore((s) => s.literatureLibraryScope);
  const setLiteratureLibraryScope = useStore((s) => s.setLiteratureLibraryScope);
  const library = useLiteratureStore((s) => s.library);
  const libraryModel = useLiteratureStore((s) => s.libraryModel);
  const restorePapers = useLiteratureStore((s) => s.restorePapers);
  const permanentlyDeletePapers = useLiteratureStore((s) => s.permanentlyDeletePapers);
  const createManualItemInStore = useLiteratureStore((s) => s.createManualItem);
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
  const toggleRead = useLiteratureStore((s) => s.toggleRead);
  const setRating = useLiteratureStore((s) => s.setRating);
  const addTags = useLiteratureStore((s) => s.addTags);
  const setTagColor = useLiteratureStore((s) => s.setTagColor);
  const updatePaperRelations = useLiteratureStore((s) => s.updatePaperRelations);
  const updatePaperMetadata = useLiteratureStore((s) => s.updatePaperMetadata);
  const ensureCitationKeys = useLiteratureStore((s) => s.ensureCitationKeys);
  const addCollection = useLiteratureStore((s) => s.addCollection);
  const renameCollection = useLiteratureStore((s) => s.renameCollection);
  const removeCollection = useLiteratureStore((s) => s.removeCollection);
  const assignToCollection = useLiteratureStore((s) => s.assignToCollection);
  const removeFromCollection = useLiteratureStore((s) => s.removeFromCollection);
  const saveDynamicSearch = useLiteratureStore((s) => s.saveDynamicSearch);
  const removeSavedSearch = useLiteratureStore((s) => s.removeSavedSearch);
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
  const relinkAttachment = useLiteratureStore((s) => s.relinkAttachment);
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
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [advancedConditions, setAdvancedConditions] = useState<LiteratureSearchCondition[]>([]);
  const [fullTextMatchIds, setFullTextMatchIds] = useState<Set<string> | null>(null);
  const [fullTextPage, setFullTextPage] = useState<{
    total: number;
    exhausted: boolean;
    nextOffset?: number;
    loading: boolean;
  }>({ total: 0, exhausted: true, loading: false });
  const [duplicateCandidates, setDuplicateCandidates] = useState<LiteratureDuplicateCandidate[]>([]);
  const [pdfDragging, setPdfDragging] = useState(false);
  const [sort, setSort] = useState<SortKey>("added");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectionCleared, setSelectionCleared] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<DetailTab>("info");
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemSaving, setNewItemSaving] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [abstractOpen, setAbstractOpen] = useState(true);
  const [colInput, setColInput] = useState("");
  const [colAddingParentId, setColAddingParentId] = useState<string | null>(null);
  const [colRenamingId, setColRenamingId] = useState<string | null>(null);
  const [colRenameDraft, setColRenameDraft] = useState("");
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set());
  const [dragOverCollectionId, setDragOverCollectionId] = useState<string | null>(null);
  const [readerPage, setReaderPage] = useState(1);
  const [readerAnnotationId, setReaderAnnotationId] = useState<string | null>(null);
  const [readerAttachment, setReaderAttachment] = useState<LiteratureAttachment | null>(null);
  const [readerPaperIds, setReaderPaperIds] = useState<string[]>([]);
  const [attachmentHealth, setAttachmentHealth] = useState<Record<string, { exists: boolean; bytes?: number }>>({});
  const [storageStatus, setStorageStatus] = useState<LiteratureStorageStatus | null>(null);
  const [storageHealth, setStorageHealth] = useState<LiteratureStorageStatus["health"] | null>(null);
  const [creatingStorageBackup, setCreatingStorageBackup] = useState(false);
  const [panelWidths, setPanelWidths] = useState({ sidebar: 220, workspace: 336 });
  const panelDragRef = useRef<{ panel: "sidebar" | "workspace"; startX: number; startW: number } | null>(null);
  // Context menu shown when right-clicking a saved-search row. `null` keeps
  // the menu closed; otherwise the state is enough to anchor, label and act
  // on the row the user opened.
  const [savedSearchMenu, setSavedSearchMenu] = useState<{
    searchId: string;
    query: string;
    x: number;
    y: number;
  } | null>(null);
  // Same idea for the collection tree. `collectionId: null` anchors the menu
  // on the library root, where Zotero also offers "New Collection" — the row
  // buttons alone were too easy to miss for people looking for that.
  const [collectionMenu, setCollectionMenu] = useState<{
    collectionId: string | null;
    label: string;
    x: number;
    y: number;
  } | null>(null);
  const closeSavedSearchMenu = () => setSavedSearchMenu(null);
  const openSavedSearchMenu = useCallback(
    ({
      searchId,
      query,
      clientX,
      clientY,
    }: {
      searchId: string;
      query: string;
      clientX: number;
      clientY: number;
    }) => {
      // Clamp into the viewport so the menu never opens half off-screen,
      // which would make the delete option invisible on long-query rows.
      const menuWidth = 220;
      const menuHeight = 96;
      const maxX = Math.max(0, window.innerWidth - menuWidth);
      const maxY = Math.max(0, window.innerHeight - menuHeight);
      setSavedSearchMenu({
        searchId,
        query,
        x: Math.min(Math.max(0, clientX), maxX),
        y: Math.min(Math.max(0, clientY), maxY),
      });
    },
    [],
  );

  const openCollectionMenu = useCallback(
    ({
      collectionId,
      label,
      clientX,
      clientY,
    }: {
      collectionId: string | null;
      label: string;
      clientX: number;
      clientY: number;
    }) => {
      const menuWidth = 220;
      const menuHeight = 132;
      const maxX = Math.max(0, window.innerWidth - menuWidth);
      const maxY = Math.max(0, window.innerHeight - menuHeight);
      setCollectionMenu({
        collectionId,
        label,
        x: Math.min(Math.max(0, clientX), maxX),
        y: Math.min(Math.max(0, clientY), maxY),
      });
    },
    [],
  );

  useEffect(() => {
    if (!savedSearchMenu && !collectionMenu) return;
    const dismiss = () => {
      setSavedSearchMenu(null);
      setCollectionMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    // Pointerdown captures outside-clicks before the menu's own onClick runs.
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [savedSearchMenu, collectionMenu]);

  const confirmAndDeleteSavedSearch = useCallback(
    (searchId: string) => {
      // A context menu can stay open while a background refresh completes.
      // Read the latest snapshot at click time instead of using a stale render.
      const current = useLiteratureStore.getState().library;
      const target = current.searches.find((entry) => entry.id === searchId);
      if (!target) {
        logActivity("warn", copy.sidebar.savedSearchNotFound);
        return;
      }
      const impact = savedSearchRemovalImpact(current, searchId);
      if (
        !window.confirm(
          copy.sidebar.deleteSavedSearchConfirm(
            target.query,
            impact.removablePaperIds.length,
            impact.sharedPaperIds.length,
          ),
        )
      ) {
        return;
      }
      const deletingActiveSearch = view === "search:" + searchId;
      removeSavedSearch(searchId, { deleteRelatedPapers: true });
      if (deletingActiveSearch) {
        setView("all");
        setFilter("");
        setFullTextMatchIds(null);
        setAdvancedConditions([]);
        setAdvancedSearchOpen(false);
      }
      // The row disappearing is the confirmation, and `removeSavedSearch`
      // already writes the outcome to the activity log. A sidebar banner on
      // top of that was a third copy of the same news.
      if (impact.removablePaperIds.length > 0) {
        const removed = new Set(impact.removablePaperIds);
        setChecked((current) => new Set([...current].filter((paperId) => !removed.has(paperId))));
        if (selectedId && removed.has(selectedId)) {
          setSelectedId(null);
          setSelectedChildId(null);
          setSelectionCleared(false);
        }
      }
    },
    [copy, logActivity, removeSavedSearch, selectedId, view],
  );
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
  const activeLibraryScope = literatureLibraryScope?.projectId === projectId
    ? literatureLibraryScope
    : null;
  const scopedRecordIds = useMemo(
    () => activeLibraryScope ? new Set(activeLibraryScope.recordIds) : null,
    [activeLibraryScope],
  );
  useEffect(() => {
    setSelectedId(null);
    setSelectedChildId(null);
    setExpandedItems(new Set());
    setReaderAttachment(null);
    setReaderPaperIds([]);
    setReaderPage(1);
    setReaderAnnotationId(null);
    setTagFilter("");
    setSelectedTags(new Set());
    setSelectionCleared(false);
    setChecked(new Set());
    void load(projectId);
  }, [load, projectId]);

  useEffect(() => {
    if (!activeLibraryScope) return;
    setPageView("library");
    setView("all");
    setFilter("");
    setChecked(new Set());
    setSelectedId(null);
    setSelectedChildId(null);
    setExpandedItems(new Set());
    setReaderAttachment(null);
    setReaderPaperIds([]);
    setReaderPage(1);
    setReaderAnnotationId(null);
    setTagFilter("");
    setSelectedTags(new Set());
    setSelectionCleared(false);
    setWorkspaceTab("info");
  }, [activeLibraryScope, setPageView]);

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

  const libraryPapers = library.papers;
  const isTrashView = view === "trash";
  const papers = isTrashView ? (library.trash ?? []) : libraryPapers;
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

  // This reruns whenever the paper or saved-search count changes, so it asks
  // for the cheap status: counts, sizes and paths come from metadata, while
  // the integrity report below reads every page of the database.
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

  // One integrity check per project, kept out of the poll above and deferred
  // until the library itself has loaded: it reads every page of the database,
  // so running it alongside the load would only make the load wait on the
  // same disk. Until it lands the footer reports the health line as unchecked.
  useEffect(() => {
    let disposed = false;
    setStorageHealth(null);
    if (!isTauri() || !loaded) return () => { disposed = true; };
    void literatureStorageStatus<LiteratureStorageStatus>(true)
      .then((checked) => {
        if (!disposed) setStorageHealth(checked.health ?? null);
      })
      .catch(() => {
        if (!disposed) setStorageHealth(null);
      });
    return () => { disposed = true; };
  }, [loaded, projectId]);

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
  }, [papers.length, papers, projectId]);

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

  const createManualItem = async (input: { title: string; itemType: string; authors: string[] }) => {
    const title = input.title.trim();
    if (!title || newItemSaving) return;
    setNewItemSaving(true);
    const id = await createManualItemInStore({
      title,
      itemType: input.itemType.trim() || "article",
      authors: input.authors.map((author) => author.trim()).filter(Boolean),
    });
    setNewItemSaving(false);
    if (!id) return;
    setNewItemOpen(false);
    setView("all");
    setFilter("");
    setSelectedId(id);
    setSelectedChildId(null);
    setSelectionCleared(false);
    logActivity("ok", copy.table.newItem + ": " + title);
  };

  const activeSavedSearch = useMemo(
    () => view.startsWith("search:")
      ? library.searches.find((search) => search.id === view.slice(7) && search.dynamic)
      : undefined,
    [library.searches, view],
  );
  const activeSavedSearchConditions = useMemo(
    () => normalizeSearchConditions(activeSavedSearch?.conditions ?? []),
    [activeSavedSearch?.conditions],
  );
  const normalizedItemsById = useMemo(
    () => new Map((libraryModel?.items ?? []).map((snapshot) => [snapshot.item.id, snapshot])),
    [libraryModel?.items],
  );
  useEffect(() => {
    if (activeSavedSearchConditions.length > 0) {
      setAdvancedConditions(activeSavedSearchConditions);
    }
  }, [activeSavedSearch?.id, activeSavedSearchConditions]);
  const dynamicSearchQuery = activeSavedSearchConditions.length > 0
    ? ""
    : activeSavedSearch?.query ?? "";
  // Keep the text field responsive while the result projection filters and
  // sorts a potentially very large local library at lower priority.
  const deferredFilter = useDeferredValue(filter);
  // A saved search constrains the view; it must not swallow the quick filter
  // typed after the saved search is opened. Both terms are sent to FTS, then
  // checked independently below so fallback matching remains deterministic.
  const fullTextQuery = [dynamicSearchQuery, deferredFilter]
    .map((query) => query.trim())
    .filter(Boolean)
    .join(" ");
  const normalizedSelectedTags = useMemo(
    () => [...selectedTags].map((tag) => tag.toLocaleLowerCase()),
    [selectedTags],
  );

  const recentAddedPapers = useMemo(
    () => sortPapers(
      libraryPapers.filter((paper) => paper.stage !== "excluded"),
      "added",
    ).slice(0, 50),
    [libraryPapers],
  );
  const recentReadPapers = useMemo(
    () => [...libraryPapers]
      .filter((paper) => (
        paper.stage !== "excluded"
        && (Boolean(paper.readAt) || paper.stage === "read" || !paper.unread)
      ))
      .sort((left, right) => (
        (right.readAt ?? right.addedAt).localeCompare(left.readAt ?? left.addedAt)
      ))
      .slice(0, 50),
    [libraryPapers],
  );

  useEffect(() => {
    const query = fullTextQuery.trim();
    if (!query || !isTauri()) {
      setFullTextMatchIds(null);
      setFullTextPage({ total: 0, exhausted: true, loading: false });
      return;
    }
    let cancelled = false;
    setFullTextMatchIds(new Set());
    setFullTextPage({ total: 0, exhausted: false, nextOffset: 0, loading: true });
    const timer = window.setTimeout(() => {
      void literatureFullTextSearch<LiteratureFullTextPage>(query, 100, 0).then((result) => {
        if (cancelled) return;
        setFullTextMatchIds(new Set(fullTextPageIds(result)));
        setFullTextPage({
          total: result.total,
          exhausted: result.exhausted,
          nextOffset: result.nextOffset,
          loading: false,
        });
      }).catch((error) => {
        if (!cancelled) {
          setFullTextMatchIds(null);
          setFullTextPage({ total: 0, exhausted: true, loading: false });
          const message = language === "cn"
            ? `本地全文检索失败，已回退到基础匹配：${String(error)}`
            : `Local full-text search failed; using basic matching: ${String(error)}`;
          setError(message);
          logActivity("warn", message);
        }
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fullTextQuery, language, logActivity, projectId, setError]);

  const loadMoreFullTextMatches = async () => {
    const query = fullTextQuery.trim();
    const offset = fullTextPage.nextOffset;
    if (!query || offset == null || fullTextPage.loading || fullTextPage.exhausted) return;
    setFullTextPage((current) => ({ ...current, loading: true }));
    try {
      const result = await literatureFullTextSearch<LiteratureFullTextPage>(query, 100, offset);
      if (fullTextQuery.trim() !== query) return;
      setFullTextMatchIds((current) => {
        const merged = new Set(current ?? []);
        for (const id of fullTextPageIds(result)) merged.add(id);
        return merged;
      });
      setFullTextPage({
        total: result.total,
        exhausted: result.exhausted,
        nextOffset: result.nextOffset,
        loading: false,
      });
    } catch (error) {
      setFullTextPage((current) => ({ ...current, loading: false }));
      const message = language === "cn"
        ? `加载更多本地检索结果失败：${String(error)}`
        : `Failed to load more local search results: ${String(error)}`;
      setError(message);
      logActivity("warn", message);
    }
  };

  const visiblePapers = useMemo(() => {
    const savedSearchNeedle = dynamicSearchQuery.trim();
    const quickFilterNeedle = deferredFilter.trim();
    let viewFilter: (p: LiteraturePaper) => boolean;
    if (view.startsWith("col:")) {
      const colId = view.slice(4);
      // Match Zotero's default collection view: selecting a collection shows
      // its direct members. Subcollection inclusion should be an explicit
      // preference rather than an implicit filter change.
      const allIds = new Set([colId]);
      viewFilter = (p) => p.collectionIds.some((id) => allIds.has(id));
    } else if (view === "recent:added") {
      const recentIds = new Set(recentAddedPapers.map((paper) => paper.id));
      viewFilter = (paper) => recentIds.has(paper.id);
    } else if (view === "recent:read") {
      const recentIds = new Set(recentReadPapers.map((paper) => paper.id));
      viewFilter = (paper) => recentIds.has(paper.id);
    } else if (view === "duplicates") {
      const duplicateIds = new Set(
        duplicateCandidates.flatMap((candidate) => [candidate.primaryRecordId, candidate.duplicateRecordId]),
      );
      viewFilter = (paper) => duplicateIds.has(paper.id);
    } else if (activeSavedSearchConditions.length > 0) {
      viewFilter = (paper) => {
        const snapshot = normalizedItemsById.get(paper.id);
        const searchablePaper = snapshot
          ? {
              ...paper,
              creators: paper.creators ?? snapshot.creators,
              metadataFields: paper.metadataFields ?? snapshot.fields,
            }
          : paper;
        return matchesSearchConditions(searchablePaper, activeSavedSearchConditions, library.collections);
      };
    } else if (dynamicSearchQuery) {
      viewFilter = () => true;
    } else {
      viewFilter = (p) => matchesView(p, view);
    }
    return sortPapers(
      papers.filter((p) =>
        (!scopedRecordIds || scopedRecordIds.has(p.id))
        && viewFilter(p)
        && normalizedSelectedTags.every((tag) => p.tags.some((candidate) => candidate.toLocaleLowerCase() === tag))
        && (!fullTextMatchIds || fullTextMatchIds.has(p.id))
        && (!savedSearchNeedle || matchesQuery(
          normalizedItemsById.has(p.id)
            ? {
                ...p,
                creators: p.creators ?? normalizedItemsById.get(p.id)?.creators,
                metadataFields: p.metadataFields ?? normalizedItemsById.get(p.id)?.fields,
              }
            : p,
          savedSearchNeedle,
        ))
        && (!quickFilterNeedle || matchesQuery(
          normalizedItemsById.has(p.id)
            ? {
                ...p,
                creators: p.creators ?? normalizedItemsById.get(p.id)?.creators,
                metadataFields: p.metadataFields ?? normalizedItemsById.get(p.id)?.fields,
              }
            : p,
          quickFilterNeedle,
        )),
      ),
      sort,
    );
  }, [activeSavedSearchConditions, deferredFilter, duplicateCandidates, dynamicSearchQuery, fullTextMatchIds, fullTextQuery, library.collections, normalizedItemsById, normalizedSelectedTags, papers, recentAddedPapers, recentReadPapers, scopedRecordIds, sort, view]);

  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of visiblePapers) {
      for (const tag of paper.tags) {
        const normalized = tag.trim();
        if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
    const modelTags = new Map(
      (libraryModel?.tags ?? []).map((tag) => [tag.name.trim().toLocaleLowerCase(), tag]),
    );
    return [...counts.entries()]
      .map(([name, count]) => ({
        name,
        count,
        kind: modelTags.get(name.toLocaleLowerCase())?.kind ?? "user",
        color: modelTags.get(name.toLocaleLowerCase())?.color,
      }))
      .filter((tag) => tag.name.toLocaleLowerCase().includes(tagFilter.trim().toLocaleLowerCase()))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [libraryModel?.tags, tagFilter, visiblePapers]);

  const scopedLoadedCount = useMemo(
    () => scopedRecordIds ? papers.filter((paper) => scopedRecordIds.has(paper.id)).length : papers.length,
    [papers, scopedRecordIds],
  );

  const saveCurrentFilter = () => {
    const id = saveDynamicSearch(filter);
    if (!id) return;
    setView(`search:${id}`);
    setFilter("");
    logActivity("ok", copy.activity.dynamicSearchSaved(filter.trim()));
  };

  const saveAdvancedSearch = (conditions: LiteratureSearchCondition[], name: string) => {
    const normalized = normalizeSearchConditions(conditions);
    if (normalized.length === 0) return;
    const id = saveDynamicSearch("", normalized, name, activeSavedSearch?.id);
    if (!id) return;
    setView("search:" + id);
    setFilter("");
    setAdvancedConditions(normalized);
    setAdvancedSearchOpen(false);
    logActivity("ok", copy.activity.dynamicSearchSaved(name.trim() || copy.advancedSearch.title));
  };

  const openAdvancedSearch = () => {
    if (activeSavedSearchConditions.length > 0) {
      setAdvancedConditions(activeSavedSearchConditions);
    } else if (advancedConditions.length === 0) {
      setAdvancedConditions([{
        id: "condition-" + Date.now().toString(36),
        conditionIndex: 0,
        field: "any",
        operator: "contains",
        value: "",
      }]);
    }
    setAdvancedSearchOpen(true);
  };

  const selectedPaper = selectedId
    ? visiblePapers.find((p) => p.id === selectedId) ?? null
    : selectionCleared
      ? null
      : visiblePapers[0] ?? null;

  useEffect(() => {
    setAbstractOpen(true);
  }, [selectedPaper?.id]);

  useEffect(() => {
    if (!readerAttachment) return;
    const current = selectedPaper?.attachments?.find((attachment) => attachment.id === readerAttachment.id);
    if (!current) {
      setReaderAttachment(null);
      setReaderPage(1);
      setReaderAnnotationId(null);
      return;
    }
    if (current !== readerAttachment) setReaderAttachment(current);
  }, [readerAttachment, selectedPaper?.attachments, selectedPaper?.id]);
  useEffect(() => {
    if (workspaceTab !== "reader" || readerAttachment || !selectedPaper?.pdf.path) return;
    setReaderPaperIds((openIds) => (
      openIds.includes(selectedPaper.id) ? openIds : [...openIds, selectedPaper.id]
    ));
  }, [readerAttachment, selectedPaper?.id, selectedPaper?.pdf.path, workspaceTab]);


  useEffect(() => {
    let cancelled = false;
    const attachments = (selectedPaper?.attachments ?? []).filter((attachment) => (
      Boolean(attachment.path || attachment.externalPath)
    ));
    if (!isTauri() || typeof literatureAttachmentStatus !== "function" || attachments.length === 0) {
      return () => { cancelled = true; };
    }
    void Promise.all(attachments.map(async (attachment) => {
      const source = attachment.externalPath ?? attachment.path;
      if (!source) return null;
      try {
        const status = await literatureAttachmentStatus(source);
        return [attachment.id, { exists: status.exists, bytes: status.bytes }] as const;
      } catch {
        return [attachment.id, { exists: false }] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setAttachmentHealth((current) => ({
        ...current,
        ...Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))),
      }));
    });
    return () => { cancelled = true; };
  }, [selectedPaper?.attachments, selectedPaper?.id]);

  const collectionChildrenByParent = useMemo(() => {
    const children = new Map<string, LiteratureCollection[]>();
    for (const collection of library.collections) {
      const parentId = collection.parentId || "";
      const siblings = children.get(parentId) ?? [];
      siblings.push(collection);
      children.set(parentId, siblings);
    }
    return children;
  }, [library.collections]);
  const rootCollections = collectionChildrenByParent.get("") ?? [];
  const paperCounts = useMemo(() => {
    const stageCounts = new Map<PaperStage, number>();
    const collectionDirectCounts = new Map<string, number>();
    const collectionCounts = new Map<string, number>();
    const searchCounts = new Map<string, number>();
    let allCount = 0;
    let unfiledCount = 0;
    let starredCount = 0;
    for (const paper of libraryPapers) {
      stageCounts.set(paper.stage, (stageCounts.get(paper.stage) ?? 0) + 1);
      if (paper.stage !== "excluded") {
        allCount += 1;
        if (paper.collectionIds.length === 0) unfiledCount += 1;
      }
      if (paper.starred) starredCount += 1;
      for (const collectionId of new Set(paper.collectionIds)) {
        collectionDirectCounts.set(
          collectionId,
          (collectionDirectCounts.get(collectionId) ?? 0) + 1,
        );
      }
      for (const searchId of new Set(paper.searchIds)) {
        searchCounts.set(searchId, (searchCounts.get(searchId) ?? 0) + 1);
      }
    }
    // The displayed count follows the selected collection's direct members,
    // matching the direct-member view above. Nested collections remain
    // independently countable and selectable.
    for (const collection of library.collections) {
      collectionCounts.set(collection.id, collectionDirectCounts.get(collection.id) ?? 0);
    }
    return {
      allCount,
      unfiledCount,
      starredCount,
      stageCounts,
      collectionCounts,
    searchCounts,
    };
  }, [collectionChildrenByParent, library.collections, libraryPapers]);
  const workflowGradeGroups = useMemo(() => {
    const groups = new Map<string, {
      workflowRunId: string;
      workflowTitle: string;
      gradedAt: string;
      counts: Record<LiteratureWorkflowGradeLevel, number>;
    }>();
    const sourcePapers = scopedRecordIds
      ? libraryPapers.filter((paper) => scopedRecordIds.has(paper.id))
      : libraryPapers;
    for (const paper of sourcePapers) {
      for (const entry of paper.workflowGrades ?? []) {
        const current = groups.get(entry.workflowRunId) ?? {
          workflowRunId: entry.workflowRunId,
          workflowTitle: entry.workflowTitle,
          gradedAt: entry.gradedAt,
          counts: { A: 0, B: 0, C: 0, D: 0 },
        };
        current.workflowTitle = entry.workflowTitle || current.workflowTitle;
        if (entry.gradedAt > current.gradedAt) current.gradedAt = entry.gradedAt;
        current.counts[entry.grade] += 1;
        groups.set(entry.workflowRunId, current);
      }
    }
    return [...groups.values()].sort((left, right) => {
      const activeRunId = activeLibraryScope?.workflowRunId;
      if (left.workflowRunId === activeRunId) return -1;
      if (right.workflowRunId === activeRunId) return 1;
      return right.gradedAt.localeCompare(left.gradedAt);
    });
  }, [activeLibraryScope?.workflowRunId, libraryPapers, scopedRecordIds]);

  const downloadedCount = useMemo(
    () => libraryPapers.filter((p) => p.pdf.status === "downloaded").length,
    [libraryPapers],
  );

  const readerPapers = useMemo(
    () => readerPaperIds
      .map((id) => library.papers.find((paper) => paper.id === id))
      .filter((paper): paper is LiteraturePaper => Boolean(paper?.pdf.path)),
    [library.papers, readerPaperIds],
  );

  const openAgentChat = (input: string) => {
    setPendingChatInput(input);
    setTab("chat");
  };

  const openPaperInReader = (
    paper: LiteraturePaper,
    page = 1,
    annotationId: string | null = null,
  ) => {
    if (!paper.pdf.path) return;
    setReaderPaperIds((openIds) => (
      openIds.includes(paper.id) ? openIds : [...openIds, paper.id]
    ));
    setSelectedId(paper.id);
    setSelectedChildId(null);
    setSelectionCleared(false);
    setReaderAttachment(null);
    setReaderPage(page);
    setReaderAnnotationId(annotationId);
    setWorkspaceTab("reader");
  };

  const closeReaderTab = (paperId: string) => {
    const index = readerPaperIds.indexOf(paperId);
    if (index < 0) return;
    const nextIds = readerPaperIds.filter((id) => id !== paperId);
    setReaderPaperIds(nextIds);
    if (selectedId !== paperId || workspaceTab !== "reader") return;

    const nextId = nextIds[index] ?? nextIds[index - 1];
    if (!nextId) {
      setWorkspaceTab("info");
      return;
    }
    const nextPaper = library.papers.find((paper) => paper.id === nextId);
    if (nextPaper) openPaperInReader(nextPaper);
  };
  const downloadOrBrowse = async (id: string) => {
    const paper = library.papers.find((entry) => entry.id === id);
    if (!paper) return;
    if (paper.pdf.status === "downloaded" && paper.pdf.path) {
      openPaperInReader(paper);
      return;
    }
    if (!paper.pdf.url) {
      // Keep the user in the library. A missing direct link is reported by
      // the store like every other acquisition failure; opening the agent chat
      // is a deliberate action, not an implicit side effect of this button.
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
      setReaderAttachment(null);
      setReaderPage(page);
      setReaderAnnotationId(null);
      setWorkspaceTab("reader");
    } else {
      setWorkspaceTab("info");
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

  const addLinkedAttachment = async (id: string) => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: copy.dialogs.researchFilesFilter, extensions: ["pdf", "txt", "md", "html", "htm", "epub", "json", "csv", "docx", "xlsx", "zip"] }],
    });
    if (typeof selected !== "string") return;
    const fileName = selected.split(/[\\/]/).pop() || "Attachment";
    const extension = fileName.split(".").pop()?.toLocaleLowerCase();
    const kind: LiteratureAttachment["kind"] = extension === "pdf"
      ? "pdf"
      : extension === "html" || extension === "htm" || extension === "epub"
        ? "webSnapshot"
        : "supplement";
    const attachmentId = addAttachment(id, {
      label: fileName,
      kind,
      externalPath: selected,
      filename: fileName,
      linkMode: "linked_file",
    });
    if (attachmentId) {
      try {
        const status = await literatureAttachmentStatus(selected);
        setAttachmentHealth((current) => ({
          ...current,
          [attachmentId]: { exists: status.exists, bytes: status.bytes },
        }));
      } catch {
        // A missing linked file is rendered as unknown until the user checks
        // it again; creating the relation itself remains successful.
      }
    }
  };

  const relinkSelectedAttachment = async (paperId: string, attachmentId: string) => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: copy.dialogs.researchFilesFilter, extensions: ["pdf", "txt", "md", "html", "htm", "epub", "json", "csv", "docx", "xlsx", "zip"] }],
    });
    if (typeof selected !== "string") return;
    await relinkAttachment(paperId, attachmentId, selected);
  };

  const checkAttachment = async (attachment: LiteratureAttachment) => {
    if (!isTauri()) return;
    const source = attachment.externalPath ?? attachment.path;
    if (!source) return;
    try {
      const status = await literatureAttachmentStatus(source);
      setAttachmentHealth((current) => ({
        ...current,
        [attachment.id]: { exists: status.exists, bytes: status.bytes },
      }));
    } catch (error) {
      setError(copy.dialogs.openAttachmentFailed(String(error)));
    }
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

  const openAttachment = async (
    paper: LiteraturePaper,
    attachment: LiteratureAttachment,
    page = 1,
    annotationId: string | null = null,
  ) => {
    if (attachment.kind === "externalLink" && attachment.url) {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
      return;
    }
    const attachmentSource = attachment.path ?? attachment.externalPath ?? "";
    if (!attachmentSource) return;
    if (attachment.kind === "pdf") {
      if (attachment.externalPath) {
        try {
          await literatureAttachmentOpenExternal(attachment.externalPath);
        } catch (error) {
          setError(copy.dialogs.openAttachmentFailed(String(error)));
        }
        return;
      }
      setPrimaryPdfAttachment(paper.id, attachment.id);
      setReaderAttachment(null);
      setReaderPage(page);
      setReaderAnnotationId(annotationId);
      setWorkspaceTab("reader");
      return;
    }
    if (/\.(html?|xhtml|epub|txt|md|markdown|json|csv)$/i.test(attachmentSource)) {
      setReaderAttachment(attachment);
      setReaderPage(page);
      setReaderAnnotationId(annotationId);
      setWorkspaceTab("reader");
      return;
    }
    try {
      if (attachment.externalPath) {
        await literatureAttachmentOpenExternal(attachment.externalPath);
      } else {
        await literatureAttachmentOpen(attachmentSource);
      }
    } catch (error) {
      setError(copy.dialogs.openAttachmentFailed(String(error)));
    }
  };

  const openAnnotationInReader = (paper: LiteraturePaper, page: number, annotationId: string) => {
    const annotation = paper.pdfAnnotations.find((entry) => entry.id === annotationId);
    const attachment = annotation?.attachmentId
      ? paper.attachments?.find((candidate) => candidate.id === annotation.attachmentId)
      : undefined;
    const pdfAttachment = (attachment?.kind === "pdf" ? attachment : undefined)
      ?? paper.attachments?.find(
        (candidate) => candidate.kind === "pdf" && candidate.path && candidate.path === paper.pdf.path,
      )
      ?? paper.attachments?.find((candidate) => candidate.kind === "pdf" && candidate.path);

    if (pdfAttachment) {
      void openAttachment(paper, pdfAttachment, page, annotationId);
      return;
    }
    if (paper.pdf.path) {
      setReaderAttachment(null);
      setReaderPage(page);
      setReaderAnnotationId(annotationId);
      setWorkspaceTab("reader");
      return;
    }
    setWorkspaceTab("notes");
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
      "zotero-json": "json",
    };
    const labels: Record<BibliographyExportFormat, string> = {
      bibtex: "BibTeX",
      biblatex: "BibLaTeX",
      ris: "RIS",
      "csl-json": "CSL-JSON",
      "zotero-json": "Zotero JSON",
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

  /** Zotero's Report: a printable page for the current selection, with the
   * notes, tags and highlights attached to each item. */
  const exportReport = async () => {
    const items = quickCopyItems();
    if (items.length === 0) return;
    try {
      const destination = await saveDialog({
        defaultPath: `${copy.report.fileName}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (typeof destination !== "string") return;
      const html = buildLiteratureReport(items, {
        title: copy.report.title,
        labels: copy.report.labels,
      });
      await literatureWriteBibliographyExport(destination, html);
      logActivity("ok", copy.report.exported(items.length));
    } catch (error) {
      setError(copy.report.failed(String(error)));
    }
  };

  const selectPaper = (paper: LiteraturePaper) => {
    setSelectedId(paper.id);
    setSelectedChildId(null);
    setSelectionCleared(false);
    setReaderAttachment(null);
    setReaderPage(1);
    setReaderAnnotationId(null);
    if (paper.unread && view !== "trash") markRead(paper.id);
  };

  const toggleItemExpanded = (itemId: string) => {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const selectLibraryChild = (paper: LiteraturePaper, child: LiteratureTreeChild) => {
    setSelectedId(paper.id);
    setSelectedChildId(child.id);
    setSelectionCleared(false);
    if (child.kind === "note") {
      setWorkspaceTab("notes");
      return;
    }
    if (child.kind === "annotation") {
      if (child.page) openAnnotationInReader(paper, child.page, child.id);
      else setWorkspaceTab("notes");
      return;
    }
    const childAttachment = paper.attachments?.find((attachment) => attachment.id === child.id);
    if (childAttachment) {
      void openAttachment(paper, childAttachment);
      return;
    }
    if (child.detail.toLocaleLowerCase().includes(".pdf") || child.snapshot?.fields.contentType === "application/pdf") {
      setReaderPage(1);
      setReaderAnnotationId(null);
      setWorkspaceTab("reader");
    } else {
      setWorkspaceTab("files");
    }
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

  /** Ticked rows if there are any, otherwise the row the user is looking at.
   * Quick Copy has to work without ticking anything first, which is the whole
   * reason it is faster than opening the item pane. */
  const quickCopyItems = useCallback((): QuickCopyItem[] => {
    const ids = batchIds.length > 0 ? batchIds : selectedId ? [selectedId] : [];
    const byId = new Map(papers.map((paper) => [paper.id, paper]));
    return ids.flatMap((id) => {
      const paper = byId.get(id);
      if (!paper) return [];
      return [{
        paper,
        creators: libraryModel?.items.find((entry) => entry.item.id === id)?.creators,
      }];
    });
  }, [batchIds, libraryModel, papers, selectedId]);

  const runQuickCopy = useCallback(
    async (kind: QuickCopyKind) => {
      const items = quickCopyItems();
      if (items.length === 0) return;
      const copied = await writeQuickCopy(buildQuickCopy(items, kind));
      logActivity(
        copied ? "ok" : "warn",
        copied ? copy.activity.quickCopied(items.length) : copy.activity.quickCopyFailed,
      );
    },
    [copy, logActivity, quickCopyItems],
  );

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

  const confirmRestorePapers = (ids: string[]) => {
    if (ids.length === 0) return;
    const label = ids.length === 1 ? copy.dialogs.deletePapersLabelSingle : copy.dialogs.deletePapersLabelMany(ids.length);
    if (!window.confirm(copy.dialogs.restorePapersConfirm(label))) return;
    void restorePapers(ids);
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

  const confirmPermanentDeletePapers = (ids: string[]) => {
    const cleaned = [...new Set(ids.filter(Boolean))];
    if (cleaned.length === 0) return;
    const label = cleaned.length === 1
      ? copy.dialogs.deletePapersLabelSingle
      : copy.dialogs.deletePapersLabelMany(cleaned.length);
    if (!window.confirm(copy.dialogs.permanentlyDeletePapersConfirm(label))) return;
    void permanentlyDeletePapers(cleaned);
    setChecked((current) => {
      const next = new Set(current);
      for (const id of cleaned) next.delete(id);
      return next;
    });
    if (selectedId && cleaned.includes(selectedId)) {
      setSelectedId(null);
      setSelectedChildId(null);
      setSelectionCleared(false);
    }
  };

  const emptyTrash = () => {
    const ids = (library.trash ?? []).map((paper) => paper.id);
    if (ids.length === 0) return;
    if (!window.confirm(copy.dialogs.emptyTrashConfirm(ids.length))) return;
    void permanentlyDeletePapers(ids);
    setChecked(new Set());
    setSelectedId(null);
    setSelectedChildId(null);
    setSelectionCleared(false);
  };

  const toggleAllVisible = () => {
    const visibleIds = visiblePapers.map((paper) => paper.id);
    if (visibleIds.length === 0) return;
    setChecked((current) => {
      const allSelected = visibleIds.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const allVisibleSelected = visiblePapers.length > 0
    && visiblePapers.every((paper) => checked.has(paper.id));
  const someVisibleSelected = visiblePapers.some((paper) => checked.has(paper.id));

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

  // Quick Copy. Ctrl/Cmd+Shift+C is Zotero's binding for the bibliography
  // entry and +A for the in-text citation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "a") return;
      // Never steal the shortcut from a field the user is typing in.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      void runQuickCopy(key === "c" ? "bibliography" : "citation");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runQuickCopy]);

  // ── Sidebar ────────────────────────────────────────────────────────────────

  const submitColInput = (parentId?: string) => {
    const trimmed = colInput.trim();
    if (trimmed) addCollection(trimmed, parentId);
    setColInput("");
    setColAddingParentId(null);
  };

  /** Open the inline name field for a new collection. `parentId` of `""`
   * creates a top-level one, matching `colAddingParentId`'s convention. */
  const startAddCollection = (parentId: string) => {
    setColRenamingId(null);
    setColInput("");
    setColAddingParentId(parentId);
    if (parentId) setExpandedCols((previous) => new Set(previous).add(parentId));
  };

  const startRenameCollection = (collection: LiteratureCollection) => {
    setColAddingParentId(null);
    setColRenamingId(collection.id);
    setColRenameDraft(collection.label);
  };

  const submitColRename = () => {
    const trimmed = colRenameDraft.trim();
    if (colRenamingId && trimmed) renameCollection(colRenamingId, trimmed);
    setColRenamingId(null);
    setColRenameDraft("");
  };

  const confirmDeleteCollection = (collection: LiteratureCollection) => {
    if (!window.confirm(copy.sidebar.deleteCollectionConfirm(collection.label))) return;
    const removed = descendantCollectionIds(library.collections, collection.id);
    removeCollection(collection.id);
    if (view.startsWith("col:") && removed.has(view.slice(4))) setView("all");
  };

  const toggleColExpand = (id: string) =>
    setExpandedCols((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const startPaperDrag = (event: DragEvent<HTMLTableRowElement>, paperId: string) => {
    const ids = checked.has(paperId) ? batchIds : [paperId];
    event.dataTransfer.setData("application/x-somniq-paper-ids", JSON.stringify({
      ids,
      sourceCollectionId: currentCollectionId,
    }));
    // Dropping onto a collection reads the internal payload above; dropping
    // into any editor gets a formatted citation instead. Both flavours ride
    // along on the same drag.
    const byId = new Map(papers.map((paper) => [paper.id, paper]));
    attachQuickCopyToDrag(
      event.dataTransfer,
      buildQuickCopy(
        ids.flatMap((id) => {
          const paper = byId.get(id);
          if (!paper) return [];
          return [{
            paper,
            creators: libraryModel?.items.find((entry) => entry.item.id === id)?.creators,
          }];
        }),
      ),
    );
    event.dataTransfer.effectAllowed = "copyMove";
  };

  const handleCollectionDrop = (event: DragEvent<HTMLDivElement>, collectionId: string) => {
    event.preventDefault();
    setDragOverCollectionId(null);
    const raw = event.dataTransfer.getData("application/x-somniq-paper-ids");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as unknown;
      const ids = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { ids?: unknown }).ids)
          ? (payload as { ids: unknown[] }).ids
          : [];
      const sourceCollectionId = payload && typeof payload === "object"
        ? (payload as { sourceCollectionId?: unknown }).sourceCollectionId
        : undefined;
      void assignToCollection(
        ids.filter((id): id is string => typeof id === "string"),
        collectionId,
        {
          move: event.shiftKey,
          ...(typeof sourceCollectionId === "string" && sourceCollectionId
            ? { sourceCollectionId }
            : {}),
        },
      );
    } catch {
      // Ignore unrelated browser drops.
    }
  };

  const renderCollectionNode = (collection: LiteratureCollection, depth: number): ReactNode => {
    const children = collectionChildrenByParent.get(collection.id) ?? [];
    const isExpanded = expandedCols.has(collection.id);
    const count = paperCounts.collectionCounts.get(collection.id) ?? 0;
    return (
      <div key={collection.id} className="lit-col-group" style={{ marginLeft: depth * 14 }}>
        <div
          className={`lit-col-row${dragOverCollectionId === collection.id ? " drop-target" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.shiftKey ? "move" : "copy";
            setDragOverCollectionId(collection.id);
          }}
          onDragLeave={() => setDragOverCollectionId((current) => current === collection.id ? null : current)}
          onDrop={(event) => handleCollectionDrop(event, collection.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            openCollectionMenu({
              collectionId: collection.id,
              label: collection.label,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }}
        >
          <button
            type="button"
            className="lit-col-toggle"
            onClick={() => toggleColExpand(collection.id)}
            aria-label={isExpanded ? copy.sidebar.collapseCollection : copy.sidebar.expandCollection}
          >
            {children.length > 0 && <SvgIcon name={isExpanded ? "chevronDown" : "chevronRight"} size={12} />}
          </button>
          {colRenamingId === collection.id ? (
            <input
              autoFocus
              className="lit-col-input"
              value={colRenameDraft}
              aria-label={copy.sidebar.renameCollectionAria(collection.label)}
              onChange={(event) => setColRenameDraft(event.target.value)}
              onBlur={submitColRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitColRename();
                if (event.key === "Escape") { setColRenamingId(null); setColRenameDraft(""); }
              }}
            />
          ) : (
            <NavItem
              label={collection.label}
              icon={depth === 0 ? "collection" : "circle"}
              count={count}
              active={view === `col:${collection.id}`}
              onClick={() => setView(`col:${collection.id}`)}
            />
          )}
          <button
            type="button"
            className="lit-col-add-sub-btn"
            title={copy.sidebar.addSubcollection}
            aria-label={copy.sidebar.addSubcollectionAria(collection.label)}
            onClick={() => startAddCollection(collection.id)}
          ><SvgIcon name="plus" size={13} /></button>
          <button
            type="button"
            className="lit-col-edit-btn"
            aria-label={copy.sidebar.renameCollectionAria(collection.label)}
            title={copy.sidebar.renameCollectionAria(collection.label)}
            onClick={() => startRenameCollection(collection)}
          ><SvgIcon name="edit" size={13} /></button>
          <button
            type="button"
            className="lit-col-delete-btn"
            aria-label={copy.sidebar.deleteCollectionAria(collection.label)}
            onClick={() => confirmDeleteCollection(collection)}
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
        <button
          type="button"
          className={`lit-library-root${view === "all" ? " active" : ""}`}
          onClick={() => setView("all")}
          // Zotero puts "New Collection…" on the library root's context menu,
          // which is where people go looking for it first.
          onContextMenu={(event) => {
            event.preventDefault();
            openCollectionMenu({
              collectionId: null,
              label: copy.sidebar.libraryRoot,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }}
        >
          <span className="lit-library-root-icon" aria-hidden="true"><SvgIcon name="library" size={15} /></span>
          <span className="lit-nav-text">{copy.sidebar.libraryRoot}</span>
          <span className="lit-nav-count">{paperCounts.allCount}</span>
        </button>
      </div>

      <div className="lit-sidebar-section lit-sidebar-specials">
        <NavItem
          label={copy.sidebar.recentAdded}
          icon="clock"
          count={recentAddedPapers.length}
          active={view === "recent:added"}
          onClick={() => setView("recent:added")}
        />
        <NavItem
          label={copy.sidebar.recentRead}
          icon="check"
          count={recentReadPapers.length}
          active={view === "recent:read"}
          onClick={() => setView("recent:read")}
        />
      </div>

      <NavSection title={copy.sidebar.statusLabel} defaultOpen={false}>
        <NavItem
          label={copy.sidebar.unfiled}
          icon="inbox"
          count={paperCounts.unfiledCount}
          active={view === "unfiled"}
          onClick={() => setView("unfiled")}
        />
        <NavItem
          label={copy.sidebar.starred}
          icon="star"
          count={paperCounts.starredCount}
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
        <NavItem
          label={copy.sidebar.trash}
          icon="trash"
          count={library.trash?.length ?? 0}
          active={view === "trash"}
          onClick={() => {
            setView("trash");
            setChecked(new Set());
            setSelectedId(null);
            setSelectionCleared(false);
          }}
        />
        {STAGES_NAV.filter((s) => s.alwaysVisible || (paperCounts.stageCounts.get(s.id) ?? 0) > 0).map(
          (stage) => (
            <NavItem
              key={stage.id}
              label={stageLabels(copy)[stage.id]}
              icon={STAGE_ICONS[stage.id]}
              count={paperCounts.stageCounts.get(stage.id) ?? 0}
              active={view === `stage:${stage.id}`}
              onClick={() => setView(`stage:${stage.id}`)}
              dot={stage.id}
            />
          ),
        )}
      </NavSection>

      {workflowGradeGroups.length > 0 && (
        <NavSection title={copy.sidebar.workflowGradesTitle} defaultOpen>
          {workflowGradeGroups.map((group) => (
            <div className="lit-workflow-grade-group" key={group.workflowRunId}>
              <div className="lit-workflow-grade-title" title={group.workflowTitle}>
                {group.workflowTitle}
              </div>
              {WORKFLOW_GRADE_LEVELS.map((grade) => {
                const gradeView = workflowGradeViewId(group.workflowRunId, grade);
                return (
                  <NavItem
                    key={grade}
                    label={copy.sidebar.workflowGradeLabels[grade]}
                    icon="circle"
                    count={group.counts[grade]}
                    active={view === gradeView}
                    onClick={() => setView(gradeView)}
                  />
                );
              })}
            </div>
          ))}
        </NavSection>
      )}

      <NavSection
        title={copy.sidebar.categoriesTitle}
        defaultOpen
        extra={
          <button
            type="button"
            className="lit-section-icon-btn"
            onClick={() => startAddCollection("")}
            title={copy.sidebar.addTopCategory}
            aria-label={copy.sidebar.addTopCategory}
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

        {rootCollections.map((collection) =>
          renderCollectionNode(collection, 0),
        )}

        {rootCollections.length === 0 && colAddingParentId === null && (
          // An empty tree used to be a dead end: the only way in was a dim
          // icon in the section header, so people did not find it at all.
          <div className="lit-col-empty">
            <span>{copy.sidebar.noCategories}</span>
            <button
              type="button"
              className="lit-col-empty-action"
              onClick={() => startAddCollection("")}
            ><SvgIcon name="plus" size={12} /> {copy.sidebar.createFirstCategory}</button>
          </div>
        )}
      </NavSection>

      <NavSection title={copy.sidebar.savedSearchesTitle} defaultOpen>
        {library.searches.map((search) => (
          <div
            className="lit-search-row"
            key={search.id}
            onContextMenu={(event) => {
              // A long query clips the row, which used to hide the
              // hover-revealed × button. Right-clicking opens a context menu
              // anchored to the cursor instead.
              event.preventDefault();
              openSavedSearchMenu({
                searchId: search.id,
                query: search.name || search.query,
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }}
          >
            <NavItem
              label={search.name || search.query}
              icon="search"
              count={paperCounts.searchCounts.get(search.id) ?? 0}
              active={view === `search:${search.id}`}
              onClick={() => setView(`search:${search.id}`)}
            />
            <button
              type="button"
              className="lit-search-delete"
              aria-label={copy.sidebar.deleteSavedSearchAria(search.name || search.query)}
              title={copy.sidebar.deleteSavedSearchMenuItem}
              onClick={(event) => {
                event.stopPropagation();
                confirmAndDeleteSavedSearch(search.id);
              }}
            ><SvgIcon name="close" size={13} /></button>
          </div>
        ))}
        {library.searches.length === 0 && <div className="lit-col-empty">{copy.sidebar.noSavedSearches}</div>}
      </NavSection>

      <NavSection title={copy.sidebar.tagsTitle} defaultOpen>
        <div className="lit-tag-selector">
          <input
            className="lit-tag-selector-filter"
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            placeholder={copy.sidebar.tagSelectorPlaceholder}
            aria-label={copy.sidebar.tagSelectorPlaceholder}
          />
          {selectedTags.size > 0 && (
            <button
              type="button"
              className="lit-tag-selector-clear"
              onClick={() => setSelectedTags(new Set())}
            >
              {copy.sidebar.clearTagFilters}
            </button>
          )}
          <div className="lit-tag-selector-list">
            {availableTags.map((tag) => {
              const active = [...selectedTags].some((selected) => selected.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
              return (
                <button
                  type="button"
                  key={tag.name}
                  className={`lit-tag-selector-item${active ? " active" : ""}`}
                  aria-pressed={active}
                  onClick={() => setSelectedTags((current) => {
                    const next = new Set(current);
                    const existing = [...next].find((selected) => selected.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
                    if (existing) next.delete(existing);
                    else next.add(tag.name);
                    return next;
                  })}
                  title={tag.kind === "automatic" ? `${tag.name} · automatic` : tag.name}
                >
                  <span
                    className={"lit-tag " + tagColorClass(tag.name, tag.color)}
                    style={tagColorStyle(tag.color)}
                  >{tag.name}</span>
                  <span className="lit-tag-selector-count">{tag.count}</span>
                </button>
              );
            })}
            {availableTags.length === 0 && <div className="lit-col-empty">{copy.sidebar.noTags}</div>}
          </div>
        </div>
      </NavSection>

    </aside>
  );

  // ── Main area ──────────────────────────────────────────────────────────────

  const viewLabel = (() => {
    const workflowGradeView = parseWorkflowGradeView(view);
    if (workflowGradeView) {
      const group = workflowGradeGroups.find((entry) => entry.workflowRunId === workflowGradeView.workflowRunId);
      return copy.viewLabel.workflowGrade(
        group?.workflowTitle ?? workflowGradeView.workflowRunId,
        workflowGradeView.grade,
      );
    }
    if (activeLibraryScope) return activeLibraryScope.title;
    if (view === "duplicates") return copy.viewLabel.duplicates;
    if (view === "trash") return copy.viewLabel.trash;
    if (view === "all") return copy.viewLabel.allPapers;
    if (view === "recent:added") return copy.viewLabel.recentAdded;
    if (view === "recent:read") return copy.viewLabel.recentRead;
    if (view === "unfiled") return copy.viewLabel.unfiled;
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

  const selectedWorkflowGradeView = parseWorkflowGradeView(view);
  const displayedWorkflowGradeRunId = selectedWorkflowGradeView?.workflowRunId
    ?? activeLibraryScope?.workflowRunId
    ?? (workflowGradeGroups.length === 1 ? workflowGradeGroups[0].workflowRunId : undefined);
  const currentCollectionId = view.startsWith("col:") ? view.slice(4) : undefined;

  const mainArea = (
    <div className={`lit-main${pdfDragging ? " lit-pdf-drop-active" : ""}`}>
      <PaperTable
        papers={visiblePapers}
        searchTotal={fullTextMatchIds ? fullTextPage.total : undefined}
        searchExhausted={fullTextPage.exhausted}
        searchLoading={fullTextPage.loading}
        libraryCount={scopedLoadedCount}
        loaded={loaded}
        filter={filter}
        sort={sort}
        checked={checked}
        allVisibleSelected={allVisibleSelected}
        someVisibleSelected={someVisibleSelected}
        selectedId={selectedPaper?.id ?? null}
        selectedChildId={selectedChildId}
        libraryModel={libraryModel}
        expandedItems={expandedItems}
        viewLabel={viewLabel}
        isTrashView={isTrashView}
        workflowGradeRunId={displayedWorkflowGradeRunId}
        advancedSearchOpen={advancedSearchOpen}
        advancedConditions={advancedConditions}
        activeSavedSearchName={activeSavedSearch?.name}
        currentCollectionId={currentCollectionId}
        onFilterChange={setFilter}
        onSaveDynamicSearch={saveCurrentFilter}
        onOpenAdvancedSearch={openAdvancedSearch}
        onChangeAdvancedSearch={setAdvancedConditions}
        onSaveAdvancedSearch={saveAdvancedSearch}
        onCloseAdvancedSearch={() => setAdvancedSearchOpen(false)}
        onCreateItem={() => setNewItemOpen(true)}
        onImportBibliography={() => void importBibliography()}
        onImportPdf={() => void importPdfAsRecord()}
        onAddIdentifier={() => void addIdentifier()}
        onToggleAll={toggleAllVisible}
        onSortChange={setSort}
        onSelectPaper={selectPaper}
        onOpenPaperReader={openPaperInReader}
        onSelectChild={selectLibraryChild}
        onToggleItem={toggleItemExpanded}
        onPaperDragStart={startPaperDrag}
        onToggleChecked={toggleChecked}
        onToggleRead={toggleRead}
        onToggleStar={toggleStar}
        batchIds={batchIds}
        onBatchShortlist={() => runBatch((ids) => setStage(ids, "shortlist"))}
        onBatchExclude={() => runBatch((ids) => setStage(ids, "excluded"))}
        onBatchDownload={() => runBatch((ids) => { for (const id of ids) void downloadOrBrowse(id); })}
        onBatchDelete={() => confirmDeletePapers(batchIds)}
        onBatchRestore={() => confirmRestorePapers(batchIds)}
        onBatchPermanentDelete={() => confirmPermanentDeletePapers(batchIds)}
        onEmptyTrash={emptyTrash}
        onBatchMergeDuplicates={() => void mergeSelectedDuplicates()}
        onBatchRemoveFromCollection={() => {
          if (!currentCollectionId) return;
          void removeFromCollection(batchIds, currentCollectionId);
          setChecked(new Set());
        }}
        onBatchQuickCopy={() => void runQuickCopy("bibliography")}
        onBatchReport={() => void exportReport()}
        onBatchClear={() => setChecked(new Set())}
        onLoadMoreSearch={() => void loadMoreFullTextMatches()}
      />
    </div>
  );

  // ── Info panel (Zotero-style right panel) ─────────────────────────────────

  const detailTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "info", label: copy.workspaceHeader.tabInfo },
    { id: "overview", label: copy.workspaceHeader.tabOverview },
    { id: "reader", label: copy.workspaceHeader.tabReader },
    { id: "evidence", label: copy.workspaceHeader.tabEvidence },
    { id: "notes", label: copy.workspaceHeader.tabNotes },
    { id: "files", label: copy.workspaceHeader.tabFiles },
    { id: "related", label: copy.workspaceHeader.tabRelated },
  ];
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
              {isTrashView && (
                <button
                  type="button"
                  className="lit-workspace-icon-btn"
                  title={copy.table.restore}
                  aria-label={copy.table.restore}
                  onClick={() => confirmRestorePapers([selectedPaper.id])}
                ><SvgIcon name="refresh" size={16} /></button>
              )}
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


          <div className="lit-workspace-main">
            <div className="lit-workspace-content">
            {workspaceTab === "info" && (
              <InfoTab
                paper={selectedPaper}
                collections={library.collections}
                libraryModel={libraryModel}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onAddTag={addTagToSelected}
                onOpenReader={() => void downloadOrBrowse(selectedPaper.id)}
                onAsk={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
                onShortlist={() => setStage([selectedPaper.id], "shortlist")}
                onUpdateMetadata={(patch) => updatePaperMetadata(selectedPaper.id, patch)}
                onSetRating={(rating) => setRating(selectedPaper.id, rating)}
                onSetTagColor={(tag, color) => void setTagColor(selectedPaper.id, tag, color)}
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
                onOpenAnnotation={(page, annotationId) => openAnnotationInReader(selectedPaper, page, annotationId)}
                onDelete={() => {
                  if (window.confirm(copy.dialogs.deletePaperByTitleConfirm(selectedPaper.title))) {
                    deletePapers([selectedPaper.id]);
                  }
                }}
              />
            )}
            {workspaceTab === "reader" && !selectedPaper.pdf.path && !readerAttachment && (
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
                onOpenAnnotation={(page, annotationId) => openAnnotationInReader(selectedPaper, page, annotationId)}
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
                  if (annotationId) openAnnotationInReader(selectedPaper, page, annotationId);
                  else {
                    setReaderPage(page);
                    setReaderAnnotationId(null);
                    setWorkspaceTab("reader");
                  }
                }}
              />
            )}
            {workspaceTab === "files" && (
              <WorkspaceFiles
                paper={selectedPaper}
                creators={libraryModel?.items.find((entry) => entry.item.id === selectedPaper.id)?.creators}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onAddTag={addTagToSelected}
                onDownload={downloadOrBrowse}
                onUpload={() => void uploadSelectedPdf(selectedPaper.id)}
                onImportAttachment={(kind) => void importSelectedAttachment(selectedPaper.id, kind)}
                onLinkLocalFile={() => void addLinkedAttachment(selectedPaper.id)}
                onRelinkAttachment={(attachmentId) => void relinkSelectedAttachment(selectedPaper.id, attachmentId)}
                onCheckAttachment={(attachment) => void checkAttachment(attachment)}
                attachmentHealth={attachmentHealth}
                onAddExternalLink={() => addExternalAttachment(selectedPaper.id)}
                onOpenAttachment={(attachment) => void openAttachment(selectedPaper, attachment)}
                onRemoveAttachment={(attachmentId) => {
                  const removed = selectedPaper.attachments?.find((attachment) => attachment.id === attachmentId);
                  const readingRemovedAttachment = readerAttachment?.id === attachmentId;
                  const readingRemovedPrimary = Boolean(
                    removed?.path && selectedPaper.pdf.path && removed.path === selectedPaper.pdf.path,
                  );
                  removeAttachment(selectedPaper.id, attachmentId);
                  if (selectedChildId === attachmentId) setSelectedChildId(null);
                  if (readingRemovedAttachment || readingRemovedPrimary) {
                    setReaderAttachment(null);
                    setReaderPage(1);
                    setReaderAnnotationId(null);
                    if (readingRemovedAttachment) setWorkspaceTab("files");
                  }
                }}
                onExportBibliography={(format) => void exportPaperBibliography(selectedPaper, format)}
                collections={library.collections}
                onToggleCollection={(collectionId) =>
                  toggleCollection(selectedPaper.id, collectionId)
                }
              />
            )}
            {workspaceTab === "related" && (
              <WorkspaceRelated
                paper={selectedPaper}
                papers={libraryPapers}
                onUpdateRelations={(relations) => updatePaperRelations(selectedPaper.id, relations)}
              />
            )}
            </div>
            <DetailTabRail
              tabs={detailTabs}
              activeTab={workspaceTab}
              label={copy.workspaceHeader.tabRailAria}
              className="lit-workspace-rail"
              onSelect={setWorkspaceTab}
            />
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
      {newItemOpen && (
        <NewItemDialog
          busy={newItemSaving}
          onClose={() => { if (!newItemSaving) setNewItemOpen(false); }}
          onSubmit={(input) => void createManualItem(input)}
        />
      )}
      {savedSearchMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="lit-context-menu"
            role="menu"
            data-saved-search-menu="true"
            style={{
              position: "fixed",
              top: savedSearchMenu.y,
              left: savedSearchMenu.x,
              zIndex: 1000,
            }}
            // The window-level pointerdown listener closes the menu. Stop the
            // opening click from also reaching that listener on the same tick.
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="lit-context-menu-item lit-context-menu-item-danger"
              onClick={() => {
                const id = savedSearchMenu.searchId;
                closeSavedSearchMenu();
                confirmAndDeleteSavedSearch(id);
              }}
            >
              {copy.sidebar.deleteSavedSearchMenuItem}
            </button>
          </div>,
          document.body,
        )}
      {collectionMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="lit-context-menu"
            role="menu"
            data-collection-menu="true"
            style={{
              position: "fixed",
              top: collectionMenu.y,
              left: collectionMenu.x,
              zIndex: 1000,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="lit-context-menu-item"
              onClick={() => {
                const parentId = collectionMenu.collectionId;
                setCollectionMenu(null);
                startAddCollection(parentId ?? "");
              }}
            >
              {collectionMenu.collectionId
                ? copy.sidebar.addSubcollection
                : copy.sidebar.addTopCategory}
            </button>
            {collectionMenu.collectionId && (() => {
              const target = library.collections.find(
                (entry) => entry.id === collectionMenu.collectionId,
              );
              if (!target) return null;
              return (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="lit-context-menu-item"
                    onClick={() => {
                      setCollectionMenu(null);
                      startRenameCollection(target);
                    }}
                  >
                    {copy.sidebar.renameCollectionMenuItem}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="lit-context-menu-item lit-context-menu-item-danger"
                    onClick={() => {
                      setCollectionMenu(null);
                      confirmDeleteCollection(target);
                    }}
                  >
                    {copy.sidebar.deleteCollectionMenuItem}
                  </button>
                </>
              );
            })()}
          </div>,
          document.body,
        )}
      {showLocalViewTabs && (
        <header className="lit-header">
          <LiteratureViewTabs pageView={pageView} onPageViewChange={setPageView} />
        </header>
      )}

      {/* Error banner */}
      {storeError && (
        <div className="lit-error-banner" role="status">
          <span>{storeError}</span>
          <div className="lit-error-actions">
            {!loaded && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void load(projectId);
                }}
              >
                {copy.retryLoad}
              </button>
            )}
            <button type="button" onClick={() => setError(null)}>
              {copy.dismiss}
            </button>
          </div>
        </div>
      )}

      {activeLibraryScope && (
        <div className="lit-library-scope-banner" role="status">
          <div className="lit-library-scope-copy">
            <span>工作流原始文献库</span>
            <strong>{activeLibraryScope.title}</strong>
            <small>
              已显示 {scopedLoadedCount}/{activeLibraryScope.recordIds.length} 篇收纳记录；这里只限制当前视图，不会复制或删除文献。
            </small>
          </div>
          <div className="lit-library-scope-actions">
            {activeLibraryScope.workflowRunId && (
              <button type="button" onClick={() => setTab("workflows")}>返回工作流</button>
            )}
            <button type="button" onClick={() => setLiteratureLibraryScope(null)}>退出筛选</button>
          </div>
        </div>
      )}

      {pageView === "discover" ? (
        <section className="lit-discover-workspace" aria-label={copy.ragPanel.workspaceAria}>
          <ReproducibleSearchPanel
            language={language}
            onCompleted={() => load(projectId, { quiet: true })}
            onActivity={(level, message) => logActivity(level, message)}
          />
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
      ) : selectedPaper && workspaceTab === "reader" && selectedPaper.pdf.path && !readerAttachment ? (
        <div className="lit-reading-shell">
          <div className="lit-reading-main">
            <div className="lit-document-tabs" role="tablist" aria-label={copy.reader.openDocuments}>
            {readerPapers.map((paper) => {
              const active = paper.id === selectedPaper.id;
              return (
                <div key={paper.id} className={`lit-document-tab${active ? " active" : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="lit-document-tab-select"
                    title={paper.title}
                    onClick={() => openPaperInReader(paper)}
                  >
                    <SvgIcon name="document" size={13} />
                    <span>{paper.title}</span>
                  </button>
                  <button
                    type="button"
                    className="lit-document-tab-close"
                    aria-label={copy.reader.closeDocument(paper.title)}
                    title={copy.reader.closeDocument(paper.title)}
                    onClick={() => closeReaderTab(paper.id)}
                  >
                    <SvgIcon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="lit-reading-bar">
            <button
              type="button"
              className="lit-reading-back"
              onClick={() => setWorkspaceTab("info")}
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
          <DetailTabRail
            tabs={detailTabs}
            activeTab={workspaceTab}
            label={copy.workspaceHeader.tabRailAria}
            className="lit-reader-detail-rail"
            onSelect={setWorkspaceTab}
          />
        </div>
      ) : selectedPaper && workspaceTab === "reader" && (readerAttachment?.path || readerAttachment?.externalPath) ? (
        <div className="lit-reading-shell">
          <div className="lit-reading-main">
            <div className="lit-reading-bar">
            <button
              type="button"
              className="lit-reading-back"
              onClick={() => setWorkspaceTab("files")}
            >
              <SvgIcon name="chevronLeft" size={14} /> {copy.workspaceHeader.back}
            </button>
            <div className="lit-reading-title-wrap">
              <div className="lit-reading-title">{readerAttachment.label}</div>
              <div className="lit-reading-sub">{selectedPaper.title}</div>
            </div>
            <button
              type="button"
              className="lit-reading-back"
              onClick={() => {
                if (readerAttachment.externalPath) {
                  void literatureAttachmentOpenExternal(readerAttachment.externalPath).catch(() => undefined);
                } else {
                  void literatureAttachmentOpen(readerAttachment.path ?? "").catch(() => undefined);
                }
              }}
            >
              <SvgIcon name="externalLink" size={14} /> {copy.reader.openExternal}
            </button>
          </div>
          <LiteratureResourceReader
            relativePath={readerAttachment.path}
            externalPath={readerAttachment.externalPath}
            recordId={selectedPaper.id}
            attachmentId={readerAttachment.id}
            label={readerAttachment.label}
          />
          </div>
          <DetailTabRail
            tabs={detailTabs}
            activeTab={workspaceTab}
            label={copy.workspaceHeader.tabRailAria}
            className="lit-reader-detail-rail"
            onSelect={setWorkspaceTab}
          />
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
                healthy: (storageStatus.health ?? storageHealth)?.healthy ?? null,
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
              health: storageStatus.health ?? storageHealth,
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

function NewItemDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { title: string; itemType: string; authors: string[] }) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const [title, setTitle] = useState("");
  const [itemType, setItemType] = useState("article");
  const [authors, setAuthors] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError(copy.newItemDialog.requiredTitle);
      return;
    }
    onSubmit({
      title: nextTitle,
      itemType,
      authors: authors.split(/[;,]/).map((author) => author.trim()).filter(Boolean),
    });
  };

  return createPortal(
    <div
      className="lit-new-item-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form className="lit-new-item-modal" role="dialog" aria-modal="true" aria-labelledby="lit-new-item-heading" onSubmit={submit}>
        <header className="lit-new-item-head">
          <div>
            <h2 id="lit-new-item-heading">{copy.newItemDialog.heading}</h2>
            <p>{copy.newItemDialog.hint}</p>
          </div>
          <button type="button" className="lit-card-browser-close" onClick={onClose} disabled={busy} aria-label={copy.dismiss}>
            <SvgIcon name="close" size={16} />
          </button>
        </header>
        <div className="lit-new-item-fields">
          <label>
            <span>{copy.newItemDialog.titleLabel}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => { setTitle(event.target.value); setError(null); }}
              placeholder={copy.newItemDialog.titlePlaceholder}
              aria-label={copy.newItemDialog.titleLabel}
            />
          </label>
          <label>
            <span>{copy.newItemDialog.typeLabel}</span>
            <select value={itemType} onChange={(event) => setItemType(event.target.value)} aria-label={copy.newItemDialog.typeLabel}>
              {MANUAL_ITEM_TYPES.map((value) => (
                <option key={value} value={value}>{itemTypeLabel(copy, value)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.newItemDialog.authorsLabel} <small>{copy.newItemDialog.authorsHint}</small></span>
            <input
              value={authors}
              onChange={(event) => setAuthors(event.target.value)}
              placeholder={copy.newItemDialog.authorsPlaceholder}
              aria-label={copy.newItemDialog.authorsLabel}
            />
          </label>
          {error && <p className="lit-new-item-error" role="alert">{error}</p>}
        </div>
        <footer className="lit-new-item-actions">
          <button type="button" onClick={onClose} disabled={busy}>{copy.newItemDialog.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? copy.newItemDialog.creating : copy.newItemDialog.create}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Paper list
// ──────────────────────────────────────────────────────────────────────────────

function PaperTable({
  papers,
  searchTotal,
  searchExhausted,
  searchLoading,
  libraryCount,
  loaded,
  filter,
  sort,
  checked,
  allVisibleSelected,
  someVisibleSelected,
  selectedId,
  selectedChildId,
  libraryModel,
  expandedItems,
  viewLabel,
  isTrashView,
  workflowGradeRunId,
  advancedSearchOpen,
  advancedConditions,
  activeSavedSearchName,
  currentCollectionId,
  onFilterChange,
  onSaveDynamicSearch,
  onOpenAdvancedSearch,
  onChangeAdvancedSearch,
  onSaveAdvancedSearch,
  onCloseAdvancedSearch,
  onBatchRemoveFromCollection,
  onBatchQuickCopy,
  onBatchReport,
  onCreateItem,
  onImportBibliography,
  onImportPdf,
  onAddIdentifier,
  onToggleAll,
  onSortChange,
  onSelectPaper,
  onOpenPaperReader,
  onSelectChild,
  onToggleItem,
  onPaperDragStart,
  onToggleChecked,
  onToggleRead,
  onToggleStar,
  batchIds,
  onBatchShortlist,
  onBatchExclude,
  onBatchDownload,
  onBatchDelete,
  onBatchRestore,
  onBatchPermanentDelete,
  onEmptyTrash,
  onBatchMergeDuplicates,
  onBatchClear,
  onLoadMoreSearch,
}: {
  papers: LiteraturePaper[];
  searchTotal?: number;
  searchExhausted: boolean;
  searchLoading: boolean;
  libraryCount: number;
  loaded: boolean;
  filter: string;
  sort: SortKey;
  checked: Set<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  selectedId: string | null;
  selectedChildId: string | null;
  libraryModel: LiteratureLibraryModelSnapshot | null;
  expandedItems: Set<string>;
  viewLabel: string;
  isTrashView: boolean;
  workflowGradeRunId?: string;
  advancedSearchOpen: boolean;
  advancedConditions: LiteratureSearchCondition[];
  activeSavedSearchName?: string;
  currentCollectionId?: string;
  onFilterChange: (v: string) => void;
  onSaveDynamicSearch: () => void;
  onOpenAdvancedSearch: () => void;
  onChangeAdvancedSearch: (conditions: LiteratureSearchCondition[]) => void;
  onSaveAdvancedSearch: (conditions: LiteratureSearchCondition[], name: string) => void;
  onCloseAdvancedSearch: () => void;
  onBatchRemoveFromCollection: () => void;
  onBatchQuickCopy: () => void;
  onBatchReport: () => void;
  onCreateItem: () => void;
  onImportBibliography: () => void;
  onImportPdf: () => void;
  onAddIdentifier: () => void;
  onToggleAll: () => void;
  onSortChange: (v: SortKey) => void;
  onSelectPaper: (p: LiteraturePaper) => void;
  onOpenPaperReader: (p: LiteraturePaper) => void;
  onSelectChild: (paper: LiteraturePaper, child: LiteratureTreeChild) => void;
  onToggleItem: (itemId: string) => void;
  onPaperDragStart: (event: DragEvent<HTMLTableRowElement>, paperId: string) => void;
  onToggleChecked: (id: string) => void;
  onToggleRead: (id: string) => void;
  onToggleStar: (id: string) => void;
  batchIds: string[];
  onBatchShortlist: () => void;
  onBatchExclude: () => void;
  onBatchDownload: () => void;
  onBatchDelete: () => void;
  onBatchRestore: () => void;
  onBatchPermanentDelete: () => void;
  onEmptyTrash: () => void;
  onBatchMergeDuplicates: () => void;
  onBatchClear: () => void;
  onLoadMoreSearch: () => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const [colWidths, setColWidths] = useState({ venue: 160, year: 52, tags: 130 });
  const dragRef = useRef<{ col: keyof typeof colWidths; startX: number; startW: number } | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const modelChildrenByParent = useMemo(
    () => buildLiteratureTreeChildrenIndex(libraryModel),
    [libraryModel],
  );
  const tagDefinitions = useMemo(
    () => new Map(
      (libraryModel?.tags ?? []).map((tag) => [tag.name.toLocaleLowerCase(), tag]),
    ),
    [libraryModel?.tags],
  );

  const treeRows = useMemo(
    () => papers.flatMap((paper) => {
      const hasChildren = Boolean(modelChildrenByParent?.has(paper.id))
        || hasLegacyLiteratureTreeChildren(paper);
      const children = expandedItems.has(paper.id)
        ? literatureTreeChildren(paper, modelChildrenByParent)
        : [];
      const visibleChildren: LiteratureTreeChild[] = [];
      const expandedParents = new Set(expandedItems.has(paper.id) ? [paper.id] : []);
      for (const child of children) {
        if (!expandedParents.has(child.parentId)) continue;
        visibleChildren.push(child);
        if (expandedItems.has(child.id)) expandedParents.add(child.id);
      }
      const childParentIds = new Set(children.map((child) => child.parentId));
      return [
        { kind: "paper" as const, paper, hasChildren },
        ...visibleChildren.map((child) => ({
          kind: "child" as const,
          paper,
          child,
          hasChildren: childParentIds.has(child.id),
        })),
      ];
    }),
    [expandedItems, modelChildrenByParent, papers],
  );
  const rowVirtualizer = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: (index) => treeRows[index]?.kind === "child" ? 46 : 54,
    overscan: 10,
    getItemKey: (index) => {
      const row = treeRows[index];
      if (!row) return index;
      return row.kind === "paper" ? row.paper.id : `${row.paper.id}:${row.child.id}`;
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const isVirtualized = treeRows.length > 80;
  const renderedRows = isVirtualized
    ? (virtualRows.length > 0
      ? virtualRows.map((virtualRow) => ({ index: virtualRow.index, start: virtualRow.start }))
      : treeRows.slice(0, 20).map((_, index) => ({ index, start: index * 54 })))
    : treeRows.map((_, index) => ({ index, start: 0 }));
  const tableColumns = `${32}px 22px minmax(0, 1fr) ${colWidths.venue}px ${colWidths.year}px ${colWidths.tags}px 30px`;

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
        <div className="lit-review-quick-actions" role="toolbar" aria-label={copy.table.newItem}>
          <button
            type="button"
            className="lit-review-quick-btn primary"
            onClick={onCreateItem}
            title={copy.table.newItem}
          >
            <SvgIcon name="plus" size={13} /> <span>{copy.table.newItem}</span>
          </button>
        </div>
        <span className="lit-review-title">{viewLabel}</span>
        <span className="lit-review-count">
          {searchTotal === undefined ? papers.length : `${papers.length}/${searchTotal}`}
        </span>
        {isTrashView && papers.length > 0 && (
          <button
            type="button"
            className="lit-review-trash-action"
            onClick={onEmptyTrash}
            title={copy.table.emptyTrash}
          >
            {copy.table.emptyTrash}
          </button>
        )}
        <input
          className="lit-review-filter"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={copy.table.filterPlaceholder}
          aria-label={copy.table.filterAria}
        />
        {filter && (
          <button
            type="button"
            className="lit-review-clear-filter"
            onClick={() => onFilterChange("")}
            aria-label={copy.table.clearFilterAria}
            title={copy.table.clearFilterAria}
          >
            <SvgIcon name="close" size={13} />
          </button>
        )}
        <button
          type="button"
          className="lit-review-save-search"
          onClick={onSaveDynamicSearch}
          disabled={!filter.trim()}
          title={copy.table.saveSearchTitle}
        >
          <SvgIcon name="plus" size={14} />
        </button>
        <button
          type="button"
          className={"lit-review-advanced-search" + (advancedSearchOpen ? " active" : "")}
          onClick={onOpenAdvancedSearch}
          aria-pressed={advancedSearchOpen}
          title={copy.table.advancedSearch}
        >
          <SvgIcon name="search" size={14} /><span>{copy.table.advancedSearch}</span>
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

      {advancedSearchOpen && (
        <AdvancedSearchBuilder
          conditions={advancedConditions}
          onChange={onChangeAdvancedSearch}
          onSave={onSaveAdvancedSearch}
          onClose={onCloseAdvancedSearch}
          initialName={activeSavedSearchName ?? ""}
        />
      )}

      <div className="lit-table-wrap" ref={tableScrollRef}>
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
           <table
             className="lit-table"
             role="grid"
             style={{ "--lit-table-columns": tableColumns } as CSSProperties}
           >
            <thead>
              <tr className="lit-thead-row">
                <th className="lit-th lit-th-check">
                  <input
                    type="checkbox"
                    ref={(element) => {
                      if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    checked={allVisibleSelected}
                    onChange={onToggleAll}
                    aria-label={copy.table.selectAllAria}
                  />
                </th>
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
             <tbody
               className={isVirtualized ? "lit-virtualized-body" : undefined}
               style={{ height: isVirtualized ? rowVirtualizer.getTotalSize() : undefined }}
             >
              {renderedRows.map(({ index, start }) => {
                const row = treeRows[index];
                if (!row) return null;
                const rowStyle = isVirtualized ? { transform: `translateY(${start}px)` } : undefined;
                return row.kind === "paper" ? (
                <PaperRow
                  key={row.paper.id}
                  rowIndex={isVirtualized ? index : undefined}
                  rowRef={isVirtualized ? rowVirtualizer.measureElement : undefined}
                  rowStyle={rowStyle}
                  paper={row.paper}
                  selected={selectedId === row.paper.id && selectedChildId === null}
                  checked={checked.has(row.paper.id)}
                  isTrashView={isTrashView}
                  workflowGradeRunId={workflowGradeRunId}
                  tagDefinitions={tagDefinitions}
                  hasChildren={row.hasChildren}
                  expanded={expandedItems.has(row.paper.id)}
                  onSelect={() => onSelectPaper(row.paper)}
                  onOpenReader={() => onOpenPaperReader(row.paper)}
                  onDragStart={(event) => onPaperDragStart(event, row.paper.id)}
                  onToggleExpand={() => onToggleItem(row.paper.id)}
                  onToggleChecked={() => onToggleChecked(row.paper.id)}
                  onToggleRead={() => onToggleRead(row.paper.id)}
                  onToggleStar={() => onToggleStar(row.paper.id)}
                />
                ) : (
                  <LiteratureChildRow
                    key={`${row.paper.id}:${row.child.id}`}
                    rowIndex={isVirtualized ? index : undefined}
                    rowRef={isVirtualized ? rowVirtualizer.measureElement : undefined}
                    rowStyle={rowStyle}
                    paper={row.paper}
                  child={row.child}
                  selected={selectedChildId === row.child.id}
                  expanded={expandedItems.has(row.child.id)}
                  hasChildren={row.hasChildren}
                  onSelect={() => onSelectChild(row.paper, row.child)}
                    onToggleExpand={() => onToggleItem(row.child.id)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {searchTotal !== undefined && !searchExhausted && (
        <div className="lit-search-pagination" role="status">
          <span>
            {copy.table.loadedSearchResults(papers.length, searchTotal)}
          </span>
          <button type="button" onClick={onLoadMoreSearch} disabled={searchLoading}>
            {searchLoading
              ? copy.table.loadingMoreSearch
              : copy.table.loadMoreSearch}
          </button>
        </div>
      )}

      {batchIds.length > 0 && (
        <div className="lit-batch-bar" role="toolbar" aria-label={import.meta.env.MODE === "test" ? "Batch actions" : copy.table.batchActionsAria}>
          {!isTrashView && batchIds.length === 2 && <button type="button" onClick={onBatchMergeDuplicates}>{copy.table.mergeDuplicates}</button>}
          <span>{copy.table.selectedCount(batchIds.length)}</span>
          {isTrashView ? (
            <>
              <button type="button" onClick={onBatchRestore}>{copy.table.restore}</button>
              <button type="button" className="danger" onClick={onBatchPermanentDelete}>{copy.table.permanentlyDelete}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onBatchShortlist}>{copy.table.shortlist}</button>
              <button type="button" onClick={onBatchExclude}>{copy.table.exclude}</button>
              <button type="button" onClick={onBatchDownload}>{copy.table.downloadPdf}</button>
              <button type="button" onClick={onBatchQuickCopy}>{copy.table.quickCopy}</button>
              <button type="button" onClick={onBatchReport}>{copy.table.report}</button>
              {currentCollectionId && (
                <button type="button" onClick={onBatchRemoveFromCollection}>{copy.table.removeFromCollection}</button>
              )}
              <button type="button" className="danger" onClick={onBatchDelete}>{copy.table.delete}</button>
            </>
          )}
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
  isTrashView,
  workflowGradeRunId,
  tagDefinitions,
  hasChildren,
  expanded,
  onSelect,
  onOpenReader,
  onDragStart,
  onToggleExpand,
  onToggleChecked,
  onToggleRead,
  onToggleStar,
  rowIndex,
  rowRef,
  rowStyle,
}: {
  paper: LiteraturePaper;
  selected: boolean;
  checked: boolean;
  isTrashView: boolean;
  workflowGradeRunId?: string;
  tagDefinitions: ReadonlyMap<string, LiteratureLibraryModelSnapshot["tags"][number]>;
  hasChildren: boolean;
  expanded: boolean;
  onSelect: () => void;
  onOpenReader: () => void;
  onDragStart: (event: DragEvent<HTMLTableRowElement>) => void;
  onToggleExpand: () => void;
  onToggleChecked: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  rowIndex?: number;
  rowRef?: (node: HTMLTableRowElement | null) => void;
  rowStyle?: CSSProperties;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const workflowGrade = workflowGradeRunId
    ? paper.workflowGrades?.find((entry) => entry.workflowRunId === workflowGradeRunId)
    : undefined;
  return (
    <tr
      ref={rowRef}
      data-index={rowIndex}
      className={`lit-row${selected ? " active" : ""}${paper.stage === "excluded" ? " excluded" : ""}`}
      style={rowStyle}
      onClick={onSelect}
      onDoubleClick={() => {
        if (paper.pdf.path) onOpenReader();
      }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      tabIndex={0}
      role="row"
      aria-selected={selected}
      draggable
      onDragStart={onDragStart}
    >
      <td className="lit-row-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          aria-label={copy.row.selectAria(paper.title)}
          onChange={onToggleChecked}
        />
      </td>
      <td className="lit-row-stage" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`lit-read-toggle${paper.unread ? " unread" : " read"}`}
          aria-label={paper.unread ? copy.row.markRead : copy.row.markUnread}
          aria-pressed={!paper.unread}
          title={`${paper.unread ? copy.row.markRead : copy.row.markUnread} · ${stageLabels(copy)[paper.stage]}`}
          disabled={isTrashView}
          onClick={(event) => {
            event.stopPropagation();
            onToggleRead();
          }}
        >
          <span className={`lit-stage-dot ${paper.stage}`} aria-hidden="true" />
        </button>
      </td>
      <td className="lit-row-title-cell">
        <div className="lit-row-title-wrap">
          <button
            type="button"
            className={`lit-item-disclosure${hasChildren ? " has-children" : ""}`}
            aria-label={expanded ? "Collapse item" : "Expand item"}
            aria-expanded={hasChildren ? expanded : undefined}
            disabled={!hasChildren}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand();
            }}
          >
            {hasChildren && <SvgIcon name={expanded ? "chevronDown" : "chevronRight"} size={12} />}
          </button>
          <span className="lit-item-kind-icon" title={itemTypeLabel(copy, paper.itemType)} aria-hidden="true">
            <SvgIcon name="document" size={13} />
          </span>
          <div className={`lit-row-title${paper.unread ? " unread" : ""}`}>{paper.title}</div>
        </div>
        <div className="lit-row-authors">
          {formatAuthors(copy, paper.authors)}
          {paper.pdf.status === "downloaded" && (
            <span className="lit-pdf-badge" title={paper.pdf.path ?? ""}>PDF</span>
          )}
          {paper.evidence.length > 0 && (
            <span className="lit-row-evidence-badge" title={copy.row.hasEvidenceTitle}>{copy.row.hasEvidenceBadge}</span>
          )}
          {workflowGrade && (
            <span
              className={`lit-row-workflow-grade grade-${workflowGrade.grade.toLowerCase()}`}
              title={`${copy.row.workflowGrade}: ${workflowGrade.grade} · ${workflowGrade.rationale}`}
            >{workflowGrade.grade}</span>
          )}
        </div>
      </td>
      <td className="lit-row-venue" title={paper.venue}>{paper.venue || "—"}</td>
      <td className="lit-row-year">{paper.year ?? "—"}</td>
      <td className="lit-row-tags">
        {paper.tags.slice(0, 2).map((tag) => {
          const definition = tagDefinitions.get(tag.toLocaleLowerCase());
          return (
            <span
              key={tag}
              className={"lit-tag " + tagColorClass(tag, definition?.color)}
              style={tagColorStyle(definition?.color)}
            >{tag}</span>
          );
        })}
        {paper.tags.length > 2 && (
          <span className="lit-row-tag-more">+{paper.tags.length - 2}</span>
        )}
      </td>
      <td className="lit-row-star" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`lit-card-star${paper.starred ? " starred" : ""}`}
          onClick={(e) => { e.stopPropagation(); if (!isTrashView) onToggleStar(); }}
          disabled={isTrashView}
          aria-label={paper.starred ? copy.row.unstar : copy.row.star}
        >
          <SvgIcon name="star" size={16} />
        </button>
      </td>
    </tr>
  );
}

function LiteratureChildRow({
  paper,
  child,
  selected,
  expanded,
  hasChildren,
  onSelect,
  onToggleExpand,
  rowIndex,
  rowRef,
  rowStyle,
}: {
  paper: LiteraturePaper;
  child: LiteratureTreeChild;
  selected: boolean;
  expanded: boolean;
  hasChildren: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  rowIndex?: number;
  rowRef?: (node: HTMLTableRowElement | null) => void;
  rowStyle?: CSSProperties;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const icon: SvgIconName = child.kind === "attachment"
    ? "attachment"
    : child.kind === "note"
      ? "notebook"
      : "document";
  const kindLabel = child.kind === "attachment"
    ? copy.files.attachmentsHeading
    : child.kind === "note"
      ? copy.notes.researchNotes
      : copy.notes.pdfAnnotations;
  return (
    <tr
      ref={rowRef}
      data-index={rowIndex}
      className={`lit-child-row kind-${child.kind}${selected ? " active" : ""}`}
      style={rowStyle}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      role="row"
      aria-selected={selected}
      data-parent-id={paper.id}
      title={child.detail || child.label}
    >
      <td className="lit-row-check" />
      <td className="lit-row-stage"><span className="lit-child-kind-dot" aria-hidden="true" /></td>
      <td className="lit-row-title-cell">
        <div className="lit-child-title-wrap" style={{ paddingLeft: child.depth * 16 }}>
          <button
            type="button"
            className={`lit-item-disclosure${hasChildren ? " has-children" : ""}`}
            aria-label={expanded ? "Collapse item" : "Expand item"}
            aria-expanded={hasChildren ? expanded : undefined}
            disabled={!hasChildren}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand();
            }}
          >
            {hasChildren && <SvgIcon name={expanded ? "chevronDown" : "chevronRight"} size={11} />}
          </button>
          <span className={`lit-child-icon kind-${child.kind}`} aria-hidden="true"><SvgIcon name={icon} size={13} /></span>
          <div className="lit-child-title-block">
            <div className="lit-child-title">{child.label}</div>
            {child.detail && <div className="lit-child-detail">{child.detail}</div>}
          </div>
        </div>
      </td>
      <td className="lit-row-venue" title={child.detail}>{kindLabel}</td>
      <td className="lit-row-year">{child.page ?? "—"}</td>
      <td className="lit-row-tags">
        {child.snapshot?.tags.slice(0, 2).map((tag) => (
          <span
            key={tag.id}
            className={"lit-tag " + tagColorClass(tag.name, tag.color)}
            style={tagColorStyle(tag.color)}
          >{tag.name}</span>
        ))}
      </td>
      <td className="lit-row-star" />
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

  const insertTemplate = (template: string) => {
    setDraftContent((current) => current.trim() ? current.trimEnd() + "\n\n" + template : template);
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
        <div className="lit-note-toolbar" role="toolbar" aria-label={copy.notes.templateToolbar}>
          <span>{copy.notes.insertTemplate}</span>
          <button type="button" onClick={() => insertTemplate(copy.notes.templateSummary)}>{copy.notes.templateSummaryLabel}</button>
          <button type="button" onClick={() => insertTemplate(copy.notes.templateMethod)}>{copy.notes.templateMethodLabel}</button>
          <button type="button" onClick={() => insertTemplate(copy.notes.templateEvidence)}>{copy.notes.templateEvidenceLabel}</button>
          <button type="button" onClick={() => insertTemplate(copy.notes.templateLimitations)}>{copy.notes.templateLimitationsLabel}</button>
        </div>
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
  creators,
  attachmentHealth,
  tagDraft,
  onTagDraft,
  onAddTag,
  onDownload,
  onUpload,
  onImportAttachment,
  onLinkLocalFile,
  onRelinkAttachment,
  onCheckAttachment,
  onAddExternalLink,
  onOpenAttachment,
  onRemoveAttachment,
  onExportBibliography,
  collections,
  onToggleCollection,
}: {
  paper: LiteraturePaper;
  creators?: LiteratureLibraryItemSnapshot["creators"];
  attachmentHealth: Record<string, { exists: boolean; bytes?: number }>;
  tagDraft: string;
  onTagDraft: (v: string) => void;
  onAddTag: () => void;
  onDownload: (id: string) => Promise<void>;
  onUpload: () => void;
  onImportAttachment: (kind: Exclude<LiteratureAttachment["kind"], "externalLink">) => void;
  onLinkLocalFile: () => void;
  onRelinkAttachment: (attachmentId: string) => void;
  onCheckAttachment: (attachment: LiteratureAttachment) => void;
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
          <button type="button" onClick={() => onExportBibliography("zotero-json")}>Zotero JSON</button>
        </div>
        <CitationStyleManager paper={paper} creators={creators} />
      </div>

      <div className="lit-section lit-attachments-section">
        <div className="lit-section-heading">
          <span>{copy.files.attachmentsHeading}</span>
          <span className="lit-section-badge">{(paper.attachments ?? []).length}</span>
        </div>
        <div className="lit-attachment-actions">
          <button type="button" onClick={() => onImportAttachment("supplement")}>{copy.files.addFile}</button>
          <button type="button" onClick={() => onImportAttachment("webSnapshot")}>{copy.files.addWebSnapshot}</button>
          <button type="button" onClick={onLinkLocalFile}>{copy.files.linkLocalFile}</button>
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
                {attachmentHealth[attachment.id] && (
                  <span className={"lit-attachment-health " + (attachmentHealth[attachment.id].exists ? "available" : "missing")}>
                    {attachmentHealth[attachment.id].exists ? copy.files.attachmentAvailable : copy.files.attachmentMissing}
                    {attachmentHealth[attachment.id].bytes ? " · " + formatStorageBytes(attachmentHealth[attachment.id].bytes ?? 0) : ""}
                  </span>
                )}
                <p title={attachment.path ?? attachment.url ?? attachment.externalPath}>{attachment.path ?? attachment.url ?? attachment.externalPath}</p>
                <div className="lit-note-card-actions">
                  <button type="button" onClick={() => onOpenAttachment(attachment)}>
                    {attachment.kind === "pdf" ? copy.files.openAttachmentSetPdf : attachment.kind === "externalLink" ? copy.files.openAttachmentLink : attachment.externalPath ? copy.files.openAttachmentOriginalPath : copy.files.openAttachmentGeneric}
                  </button>
                  {(attachment.path || attachment.externalPath) && (
                    <button type="button" onClick={() => onCheckAttachment(attachment)}>
                      {copy.files.checkAttachment}
                    </button>
                  )}
                  {attachment.kind !== "externalLink" && (
                    <button type="button" onClick={() => onRelinkAttachment(attachment.id)}>
                      {copy.files.relinkAttachment}
                    </button>
                  )}
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
  "article", "journalArticle", "artwork", "audioRecording", "bill", "book",
  "bookSection", "case", "computerProgram", "conferencePaper", "dictionaryEntry",
  "document", "encyclopediaArticle", "forumPost", "hearing", "instantMessage",
  "magazineArticle", "newspaperArticle",
  "blogPost", "email", "letter", "manuscript", "map", "patent", "presentation",
  "standard", "statute", "software", "film", "interview", "podcast",
  "radioBroadcast", "tvBroadcast", "videoRecording", "thesis", "report",
  "webpage", "dataset", "preprint", "other",
] as const;

const CREATOR_ROLE_OPTIONS = [
  "author",
  "bookAuthor",
  "bookEditor",
  "seriesAuthor",
  "seriesEditor",
  "cartographer",
  "editor",
  "translator",
  "container-author",
  "reviewedAuthor",
  "commenter",
  "contributor",
  "composer",
  "artist",
  "performer",
  "castMember",
  "director",
  "producer",
  "scriptwriter",
  "programmer",
  "inventor",
  "interviewer",
  "interviewee",
  "recipient",
  "presenter",
  "podcaster",
  "guest",
] as const;

const creatorRoleOptionsFor = (role: string) => Array.from(new Set([
  ...CREATOR_ROLE_OPTIONS,
  ...(role.trim() ? [role.trim()] : []),
]));

const CURATED_METADATA_FIELDS = new Set([
  "title", "publicationTitle", "abstractNote", "date", "DOI", "ISBN", "url",
  "volume", "issue", "pages", "publisher", "place", "edition", "series",
  "language", "accessDate", "citationKey", "rating",
]);

const creatorDisplayName = (creator: LiteratureCreatorInput | LiteratureLibraryItemSnapshot["creators"][number]) => (
  creator.fieldMode === "oneField"
    ? creator.name?.trim() || ""
    : [creator.firstName?.trim(), creator.lastName?.trim()].filter(Boolean).join(" ").trim()
      || creator.name?.trim() || ""
);

const creatorRoleLabel = (copy: LiteratureCopy, role: string) => {
  const labels: Record<string, string> = {
    author: copy.infoTab.creatorRoleAuthor,
    editor: copy.infoTab.creatorRoleEditor,
    translator: copy.infoTab.creatorRoleTranslator,
    "container-author": copy.infoTab.creatorRoleContainerAuthor,
    director: copy.infoTab.creatorRoleDirector,
    interviewer: copy.infoTab.creatorRoleInterviewer,
    recipient: copy.infoTab.creatorRoleRecipient,
    seriesEditor: copy.infoTab.creatorRoleSeriesEditor,
    contributor: copy.infoTab.creatorRoleContributor,
  };
  return labels[role] ?? role;
};

const creatorDraftFor = (
  paper: LiteraturePaper,
  snapshot?: LiteratureLibraryItemSnapshot,
): LiteratureCreatorInput[] => {
  const normalized = snapshot?.creators?.length
    ? snapshot.creators
    : paper.creators?.length
      ? paper.creators
      : paper.authors.map((name) => ({
          creatorType: "author",
          firstName: undefined,
          lastName: undefined,
          name,
          fieldMode: "oneField" as const,
          orderIndex: 0,
        }));
  return normalized.map((creator, orderIndex) => ({
    creatorType: creator.creatorType || "author",
    firstName: creator.firstName,
    lastName: creator.lastName,
    name: creator.name,
    fieldMode: creator.fieldMode || "oneField",
    orderIndex,
  }));
};

const extraMetadataFieldsFor = (
  fields: Record<string, string> | undefined,
): Record<string, string> => Object.fromEntries(
  Object.entries(fields ?? {}).filter(([key, value]) => (
    !CURATED_METADATA_FIELDS.has(key) && String(value).trim() !== ""
  )),
);

const metadataDraftFor = (
  paper: LiteraturePaper,
  snapshot?: LiteratureLibraryItemSnapshot,
) => {
  const fields = snapshot?.fields ?? paper.metadataFields ?? {};
  const value = (key: string, fallback = "") => fields[key] ?? fallback;
  const date = value("date", paper.date ?? "");
  const year = paper.year?.toString()
    ?? (date.match(/\d{4}/)?.[0] ?? "");
  return {
    title: value("title", paper.title),
    itemType: snapshot?.item.itemType ?? paper.itemType ?? "article",
    venue: value("publicationTitle", paper.venue),
    year,
    date,
    doi: value("DOI", paper.doi ?? ""),
    isbn: value("ISBN", paper.isbn ?? ""),
    citationKey: value("citationKey", paper.citationKey ?? ""),
    volume: value("volume", paper.volume ?? ""),
    issue: value("issue", paper.issue ?? ""),
    pages: value("pages", paper.pages ?? ""),
    publisher: value("publisher", paper.publisher ?? ""),
    place: value("place", paper.place ?? ""),
    edition: value("edition", paper.edition ?? ""),
    series: value("series", paper.series ?? ""),
    language: value("language", paper.language ?? ""),
    accessed: value("accessDate", paper.accessed ?? ""),
    url: value("url", paper.url ?? ""),
    abstract: value("abstractNote", paper.abstract),
    fields: extraMetadataFieldsFor(fields),
  };
};

function RatingStars({
  value,
  onChange,
  ariaLabel,
  clearLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: (value: number) => string;
  clearLabel: string;
}) {
  return (
    <span className="lit-rating-stars" role="group">
      {[1, 2, 3, 4, 5].map((rating) => (
        <button
          key={rating}
          type="button"
          className={`lit-rating-star${value >= rating ? " active" : ""}`}
          aria-label={ariaLabel(rating)}
          title={ariaLabel(rating)}
          onClick={() => onChange(rating)}
        >
          <SvgIcon name="star" size={15} />
        </button>
      ))}
      {value > 0 && (
        <button
          type="button"
          className="lit-rating-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => onChange(0)}
        >
          ×
        </button>
      )}
    </span>
  );
}

function InfoTab({
  paper,
  collections,
  libraryModel,
  tagDraft,
  onTagDraft,
  onAddTag,
  onOpenReader,
  onAsk,
  onShortlist,
  onUpdateMetadata,
  onSetRating,
  onSetTagColor,
  onToggleCollection,
  onDelete,
}: {
  paper: LiteraturePaper;
  collections: LiteratureLibrary["collections"];
  libraryModel: LiteratureLibraryModelSnapshot | null;
  tagDraft: string;
  onTagDraft: (v: string) => void;
  onAddTag: () => void;
  onOpenReader: () => void;
  onAsk: () => void;
  onShortlist: () => void;
  onUpdateMetadata: (patch: LiteratureMetadataPatch) => void;
  onSetRating: (rating: number) => void;
  onSetTagColor: (tag: string, color: string) => void;
  onToggleCollection: (colId: string) => void;
  onDelete: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const fit = paper.verdict?.fit;
  const papers = useLiteratureStore((state) => state.library.papers);
  const normalizedItem = libraryModel?.items.find((entry) => entry.item.id === paper.id);
  const displayCreators = creatorDraftFor(paper, normalizedItem);
  const displayFields = extraMetadataFieldsFor(normalizedItem?.fields ?? paper.metadataFields);
  const tagDefinitions = new Map(
    (libraryModel?.tags ?? []).map((tag) => [tag.name.toLocaleLowerCase(), tag]),
  );
  const [metadataEditing, setMetadataEditing] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState(() => metadataDraftFor(paper, normalizedItem));
  const [creatorDraft, setCreatorDraft] = useState<LiteratureCreatorInput[]>(() => creatorDraftFor(paper, normalizedItem));
  const [extendedFields, setExtendedFields] = useState<Array<{ id: string; key: string; value: string }>>(
    () => Object.entries(metadataDraftFor(paper, normalizedItem).fields).map(([key, value], index) => ({
      id: "field-" + index + "-" + key,
      key,
      value,
    })),
  );
  const [metadataError, setMetadataError] = useState<string | null>(null);
  useEffect(() => {
    if (!metadataEditing) {
      const next = metadataDraftFor(paper, normalizedItem);
      setMetadataDraft(next);
      setCreatorDraft(creatorDraftFor(paper, normalizedItem));
      setExtendedFields(Object.entries(next.fields).map(([key, value], index) => ({
        id: "field-" + index + "-" + key,
        key,
        value,
      })));
    }
  }, [metadataEditing, normalizedItem, paper]);
  const validateCitationKey = (value: string | undefined) => {
    const error = citationKeyValidationError(value, paper.id, papers);
    setMetadataError(error);
    return !error;
  };
  const saveMetadata = () => {
    const parsedYear = Number.parseInt(metadataDraft.year, 10);
    if (!validateCitationKey(metadataDraft.citationKey.trim() || undefined)) return;
    const nextFields: Record<string, string> = {};
    const fieldPatch: Record<string, string | null> = {};
    for (const field of extendedFields) {
      const key = field.key.trim();
      const value = field.value.trim();
      if (!key) continue;
      if (value) {
        nextFields[key] = value;
        fieldPatch[key] = value;
      } else {
        fieldPatch[key] = null;
      }
    }
    for (const key of Object.keys(metadataDraft.fields)) {
      if (!(key in nextFields) && !(key in fieldPatch)) fieldPatch[key] = null;
    }
    const cleanedCreators = creatorDraft
      .map((creator, orderIndex) => ({
        creatorType: creator.creatorType?.trim() || "author",
        firstName: creator.firstName?.trim() || undefined,
        lastName: creator.lastName?.trim() || undefined,
        name: creator.name?.trim() || undefined,
        fieldMode: creator.fieldMode || "oneField",
        orderIndex,
      }))
      .filter((creator) => Boolean(creatorDisplayName(creator)));
    const authorNames = cleanedCreators
      .filter((creator) => creator.creatorType === "author")
      .map(creatorDisplayName)
      .filter(Boolean);
    onUpdateMetadata({
      title: metadataDraft.title.trim() || paper.title,
      itemType: metadataDraft.itemType,
      authors: authorNames,
      creators: cleanedCreators,
      metadataFields: nextFields,
      fields: fieldPatch,
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

      <div
        className="lip-section lip-editable-info"
        title={copy.infoTab.doubleClickToEditMetadata}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("a, button, input, select, textarea")) return;
          setMetadataError(null);
          setMetadataEditing(true);
        }}
      >
        <div className="lip-section-head">{copy.infoTab.infoHeading}</div>
        <dl className="lip-meta">
          <dt>{copy.infoTab.itemType}</dt><dd>{itemTypeLabel(copy, normalizedItem?.item.itemType ?? paper.itemType)}</dd>
          {displayCreators.map((creator, i) => (
            <Fragment key={i}>
              <dt>{i === 0 ? copy.infoTab.author : creatorRoleLabel(copy, creator.creatorType ?? "author")}</dt>
              <dd>
                {creatorDisplayName(creator)}
                {creator.creatorType !== "author" && (
                  <span className="lit-creator-role"> · {creatorRoleLabel(copy, creator.creatorType ?? "author")}</span>
                )}
              </dd>
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
          {Object.entries(displayFields).map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt><dd>{value}</dd>
            </Fragment>
          ))}
          {paper.arxivId && (
            <>
              <dt>arXiv</dt>
              <dd><a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer">{paper.arxivId}</a></dd>
            </>
          )}
          <dt>{copy.infoTab.source}</dt><dd>{paper.source}</dd>
          <dt>{copy.infoTab.stage}</dt><dd>{copy.stage[paper.stage]}</dd>
          <dt>{copy.infoTab.rating}</dt>
          <dd>
            <RatingStars
              value={paper.rating ?? 0}
              onChange={onSetRating}
              ariaLabel={copy.infoTab.setRatingAria}
              clearLabel={copy.infoTab.clearRatingAria}
            />
          </dd>
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
          {paper.tags.map((tag) => {
            const definition = tagDefinitions.get(tag.toLocaleLowerCase());
            return (
              <span className="lip-tag-chip" key={tag}>
                <span
                  className={"lit-tag " + tagColorClass(tag, definition?.color)}
                  style={tagColorStyle(definition?.color)}
                >{tag}</span>
                {definition && (
                  <select
                    className="lip-tag-color-select"
                    value={definition.color ?? ""}
                    aria-label={copy.infoTab.tagColorAria(tag)}
                    onChange={(event) => onSetTagColor(tag, event.target.value)}
                  >
                    <option value="" disabled>auto</option>
                    {TAG_COLOR_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
              </span>
            );
          })}
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
          <div className="lip-creator-editor">
            <div className="lip-editor-subhead">
              <span>{copy.infoTab.creatorsHeading}</span>
              <button
                type="button"
                onClick={() => setCreatorDraft((current) => [...current, {
                  creatorType: "author",
                  fieldMode: "twoField",
                  orderIndex: current.length,
                }])}
              ><SvgIcon name="plus" size={12} />{copy.infoTab.addCreator}</button>
            </div>
            {creatorDraft.length === 0 && <p className="lit-note-text">{copy.unknownAuthors}</p>}
            {creatorDraft.map((creator, index) => {
              const oneField = creator.fieldMode === "oneField";
              return (
                <div className={"lip-creator-row " + (oneField ? "one-field" : "two-field")} key={(creator.orderIndex ?? index) + "-" + index}>
                  <select
                    value={creator.creatorType ?? "author"}
                    aria-label={copy.infoTab.creatorRole}
                    onChange={(event) => setCreatorDraft((current) => current.map((entry, rowIndex) => (
                      rowIndex === index ? { ...entry, creatorType: event.target.value } : entry
                    )))}
                  >
                    {creatorRoleOptionsFor(creator.creatorType ?? "author").map((role) => (
                      <option value={role} key={role}>{creatorRoleLabel(copy, role)}</option>
                    ))}
                  </select>
                  <select
                    value={oneField ? "oneField" : "twoField"}
                    aria-label={copy.infoTab.creatorLiteralName}
                    onChange={(event) => setCreatorDraft((current) => current.map((entry, rowIndex) => (
                      rowIndex === index
                        ? { ...entry, fieldMode: event.target.value, firstName: undefined, lastName: undefined }
                        : entry
                    )))}
                  >
                    <option value="twoField">{copy.infoTab.creatorFirstName} / {copy.infoTab.creatorLastName}</option>
                    <option value="oneField">{copy.infoTab.creatorLiteralName}</option>
                  </select>
                  {oneField ? (
                    <input
                      value={creator.name ?? ""}
                      placeholder={copy.infoTab.creatorLiteralName}
                      aria-label={copy.infoTab.creatorLiteralName}
                      onChange={(event) => setCreatorDraft((current) => current.map((entry, rowIndex) => (
                        rowIndex === index ? { ...entry, name: event.target.value } : entry
                      )))}
                    />
                  ) : (
                    <>
                      <input
                        value={creator.firstName ?? ""}
                        placeholder={copy.infoTab.creatorFirstName}
                        aria-label={copy.infoTab.creatorFirstName}
                        onChange={(event) => setCreatorDraft((current) => current.map((entry, rowIndex) => (
                          rowIndex === index ? { ...entry, firstName: event.target.value } : entry
                        )))}
                      />
                      <input
                        value={creator.lastName ?? ""}
                        placeholder={copy.infoTab.creatorLastName}
                        aria-label={copy.infoTab.creatorLastName}
                        onChange={(event) => setCreatorDraft((current) => current.map((entry, rowIndex) => (
                          rowIndex === index ? { ...entry, lastName: event.target.value } : entry
                        )))}
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="lit-icon-button"
                    aria-label={copy.infoTab.removeCreator}
                    title={copy.infoTab.removeCreator}
                    onClick={() => setCreatorDraft((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                  ><SvgIcon name="close" size={13} /></button>
                </div>
              );
            })}
          </div>
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
          <div className="lip-extended-fields">
            <div className="lip-editor-subhead">
              <span>{copy.infoTab.extendedFieldsHeading}</span>
              <button
                type="button"
                onClick={() => setExtendedFields((current) => [...current, {
                  id: "field-" + Date.now().toString(36),
                  key: "",
                  value: "",
                }])}
              ><SvgIcon name="plus" size={12} />{copy.infoTab.addExtendedField}</button>
            </div>
            {extendedFields.map((field, index) => (
              <div className="lip-extended-field-row" key={field.id}>
                <input
                  value={field.key}
                  placeholder={copy.infoTab.extendedFieldName}
                  aria-label={copy.infoTab.extendedFieldName}
                  onChange={(event) => setExtendedFields((current) => current.map((entry, rowIndex) => (
                    rowIndex === index ? { ...entry, key: event.target.value } : entry
                  )))}
                />
                <input
                  value={field.value}
                  placeholder={copy.infoTab.extendedFieldValue}
                  aria-label={copy.infoTab.extendedFieldValue}
                  onChange={(event) => setExtendedFields((current) => current.map((entry, rowIndex) => (
                    rowIndex === index ? { ...entry, value: event.target.value } : entry
                  )))}
                />
                <button
                  type="button"
                  className="lit-icon-button"
                  aria-label={copy.infoTab.removeCreator}
                  onClick={() => setExtendedFields((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                ><SvgIcon name="close" size={13} /></button>
              </div>
            ))}
          </div>
          {metadataError && <p className="lit-error" role="alert">{metadataError}</p>}
          <div className="lip-metadata-editor-actions">
            <button type="button" className="primary" onClick={saveMetadata}>{copy.infoTab.saveMetadata}</button>
            <button type="button" onClick={() => setMetadataEditing(false)}>{copy.infoTab.cancel}</button>
          </div>
        </div>
      )}

      <div className="lip-section lip-actions-section">
        <button type="button" className="lit-action-btn" onClick={onOpenReader}
                disabled={paper.pdf.status === "downloading"}>
          {paper.pdf.status === "downloaded" ? copy.infoTab.openPdf
            : paper.pdf.status === "downloading" ? copy.infoTab.downloading
            : paper.pdf.url ? copy.infoTab.downloadPdf : copy.infoTab.getPdf}
        </button>
        <button type="button" className="lit-action-btn" onClick={onAsk}>{copy.infoTab.askAgent}</button>
        {paper.stage !== "shortlist" && paper.stage !== "downloaded" && paper.stage !== "read" && (
          <button type="button" className="lit-action-btn starred" onClick={onShortlist}>{copy.infoTab.addToShortlist}</button>
        )}
        <button type="button" className="lit-action-btn danger" onClick={onDelete}>{copy.infoTab.delete}</button>
      </div>
    </div>
  );
}

function WorkspaceRelated({
  paper,
  papers,
  onUpdateRelations,
}: {
  paper: LiteraturePaper;
  papers: LiteraturePaper[];
  onUpdateRelations: (relations: LiteratureLibraryItemRelation[]) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const [target, setTarget] = useState("");
  const [predicate, setPredicate] = useState("related");
  const [error, setError] = useState<string | null>(null);
  const relations = paper.relations ?? [];
  const targetListId = `lit-related-targets-${paper.id.replace(/[^a-z0-9_-]/gi, "-")}`;
  const titleForTarget = (value: string) =>
    papers.find((candidate) => candidate.id.toLocaleLowerCase() === value.toLocaleLowerCase())?.title ?? value;
  const predicateLabel = (value: string) => value === "derived"
    ? copy.relatedTab.predicateDerived
    : value === "reviews"
      ? copy.relatedTab.predicateReviews
      : copy.relatedTab.predicateRelated;

  useEffect(() => {
    setTarget("");
    setError(null);
  }, [paper.id]);

  const addRelation = () => {
    const input = target.trim();
    if (!input) {
      setError(copy.relatedTab.targetMissing);
      return;
    }
    const match = papers.find((candidate) => (
      candidate.id.toLocaleLowerCase() === input.toLocaleLowerCase()
      || candidate.title.toLocaleLowerCase() === input.toLocaleLowerCase()
    ));
    const relationTarget = match?.id ?? input;
    if (relationTarget.toLocaleLowerCase() === paper.id.toLocaleLowerCase()) {
      setError(copy.relatedTab.selfReference);
      return;
    }
    if (relations.some((relation) => (
      relation.predicate === predicate
      && relation.target.toLocaleLowerCase() === relationTarget.toLocaleLowerCase()
    ))) {
      setError(copy.relatedTab.duplicate);
      return;
    }
    const targetKind = match
      ? "item"
      : /^[a-z][a-z0-9+.-]*:/i.test(relationTarget) ? "uri" : "item";
    onUpdateRelations([
      ...relations,
      {
        id: "relation-ui-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
        sourceItemId: paper.id,
        predicate,
        target: relationTarget,
        targetKind,
        createdAt: new Date().toISOString(),
      },
    ]);
    setTarget("");
    setError(null);
  };

  return (
    <div className="lit-related-panel">
      <div className="lit-related-heading">
        <div>
          <div className="lit-section-heading">{copy.relatedTab.heading}</div>
          <p>{copy.relatedTab.hint}</p>
        </div>
      </div>
      <div className="lit-related-editor">
        <select
          value={predicate}
          aria-label={copy.relatedTab.predicatePlaceholder}
          onChange={(event) => setPredicate(event.target.value)}
        >
          <option value="related">{copy.relatedTab.predicateRelated}</option>
          <option value="derived">{copy.relatedTab.predicateDerived}</option>
          <option value="reviews">{copy.relatedTab.predicateReviews}</option>
        </select>
        <input
          value={target}
          placeholder={copy.relatedTab.targetPlaceholder}
          list={targetListId}
          onChange={(event) => { setTarget(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") addRelation(); }}
        />
        <datalist id={targetListId}>
          {papers.filter((candidate) => candidate.id !== paper.id).map((candidate) => (
            <option key={candidate.id} value={candidate.title}>{candidate.id}</option>
          ))}
        </datalist>
        <button type="button" className="primary" onClick={addRelation}>
          <SvgIcon name="plus" size={13} /> {copy.relatedTab.add}
        </button>
      </div>
      {error && <p className="lit-related-error" role="alert">{error}</p>}
      <div className="lit-related-list">
        {relations.map((relation) => (
          <div className="lit-related-row" key={relation.id}>
            <span className="lit-related-predicate">{predicateLabel(relation.predicate)}</span>
            <div className="lit-related-target">
              <strong>{titleForTarget(relation.target)}</strong>
              {titleForTarget(relation.target) !== relation.target && <small>{relation.target}</small>}
            </div>
            <button
              type="button"
              className="lit-related-remove"
              onClick={() => onUpdateRelations(relations.filter((entry) => entry.id !== relation.id))}
            >
              {copy.relatedTab.remove}
            </button>
          </div>
        ))}
        {relations.length === 0 && <p className="lit-related-empty">{copy.relatedTab.noRelations}</p>}
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
    <button type="button" className={`lit-nav-item${active ? " active" : ""}`} onClick={onClick} title={label}>
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

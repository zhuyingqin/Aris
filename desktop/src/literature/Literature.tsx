import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  type ProjectRagAnswerResult,
  type ProjectRagSearchResult,
} from "../api/tauri";
import { useStore } from "../store";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type { LiteraturePageView } from "./LiteratureViewTabs";
import { citationKeyValidationError, useLiteratureStore } from "./literatureStore";
import {
  type DetailTab,
  type LiteratureLibrary,
  type LiteratureCollection,
  type LiteratureAttachment,
  type LiteratureDuplicateCandidate,
  type LiteraturePaper,
  type LiteratureStorageStatus,
  type LiteratureNote,
  type PaperFit,
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

const LITERATURE_PAGE_VIEWS = [
  { id: "library", label: "文献库", icon: "library" },
  { id: "discover", label: "检索", icon: "search" },
  { id: "graph", label: "知识图谱", icon: "graph" },
] as const;

export function LiteratureViewTabs({
  pageView,
  onPageViewChange,
  className,
}: LiteratureViewTabsProps) {
  return (
    <div
      className={`lit-mode-switch${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label="文献视图切换"
    >
      {LITERATURE_PAGE_VIEWS.map((item) => (
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

const STAGE_LABELS: Record<PaperStage, string> = {
  inbox: "收件箱",
  screened: "待审阅",
  shortlist: "候选",
  downloaded: "已下载",
  read: "已阅读",
  excluded: "已排除",
};

const STAGES_NAV: Array<{ id: PaperStage; alwaysVisible: boolean }> = [
  { id: "inbox", alwaysVisible: true },
  { id: "screened", alwaysVisible: true },
  { id: "shortlist", alwaysVisible: true },
  { id: "downloaded", alwaysVisible: true },
  { id: "read", alwaysVisible: false },
  { id: "excluded", alwaysVisible: false },
];

const FIT_LABELS: Record<PaperFit, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const EVIDENCE_ROLE_LABELS: Record<string, string> = {
  premise: "前提",
  method: "方法",
  result: "结果",
  limitation: "局限",
  support: "支撑",
  evidence: "证据",
};

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

function itemTypeLabel(itemType?: string) {
  const labels: Record<string, string> = {
    article: "期刊文章", book: "图书", bookSection: "图书章节", conferencePaper: "会议论文",
    thesis: "学位论文", report: "报告", webpage: "网页", dataset: "数据集", preprint: "预印本", other: "其他",
    "article-journal": "期刊文章", "paper-conference": "会议论文", "chapter": "图书章节",
  };
  return labels[itemType ?? "article"] ?? itemType ?? "其他";
}

function formatAuthors(authors: string[]) {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
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
  const [busy, setBusy] = useState<"paper" | "library" | "rebuild" | "search" | "answer" | null>(null);
  const [status, setStatus] = useState("先建立稳定页码的 PDF 原文索引，再由现有 LLM 生成检索卡；查询全程使用本地 SQLite FTS5，不需要 Embedding。");
  const [libraryResult, setLibraryResult] = useState<LiteratureRagIndexLibraryResult | null>(null);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ProjectRagSearchResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerReview, setAnswerReview] = useState<ProjectRagAnswerResult["review"] | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState<LiteratureRagDatabaseStatus | null>(null);
  const [databaseStatusError, setDatabaseStatusError] = useState("");
  const [databaseStatusRefreshing, setDatabaseStatusRefreshing] = useState(false);
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
    const message = `${prefix}：${String(cause)}`;
    setStatus(message);
    onActivity("error", message);
  };

  const buildRetrievalCardsInBackground = async (paperId?: string, automatic = false) => {
    if (!isTauri() || retrievalCardBuildRunningRef.current) return;
    retrievalCardBuildRunningRef.current = true;
    const run = retrievalCardBuildRunRef.current + 1;
    retrievalCardBuildRunRef.current = run;
    const scope = paperId ? "当前 PDF" : "全文献库";
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
      message: automatic ? `${scope}的检索卡正在后台自动构建…` : `${scope}的检索卡正在后台补建…`,
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
          message: `检索卡后台构建中：已处理 ${attempted} 个页块，生成 ${generated} 张卡（${batches} 批）。`,
        });
        void refreshDatabaseStatus();
        if (!result.hasMore || stalled) break;
        // Yield before the next bounded model request so the UI can repaint and the switch can pause it.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      if (run !== retrievalCardBuildRunRef.current) return;
      if (automatic && !autoRetrievalCardsRef.current) paused = true;
      const message = paused
        ? `自动生成已暂停；本次已处理 ${attempted} 个页块，生成 ${generated} 张检索卡。`
        : stalled
          ? `检索卡构建在 ${batches} 批后暂停：本批没有生成新卡，请检查检索卡模型配置。`
          : attempted === 0
            ? "所有已索引页块的检索卡均为最新状态。"
            : `检索卡后台构建完成：已处理 ${attempted} 个页块，生成 ${generated} 张卡（${batches} 批）。`;
      setRetrievalCardBuild({ running: false, batches, attempted, generated, warnings, message });
      onActivity(warnings > 0 || stalled ? "error" : "ok", message);
    } catch (cause) {
      if (run !== retrievalCardBuildRunRef.current) return;
      const message = `检索卡后台构建失败：${String(cause)}`;
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
      setStatus("自动检索卡生成将在当前小批处理结束后暂停。");
      return;
    }
    if (enabled && databaseStatus && databaseStatus.pendingCardCount > 0 && !busy) {
      void buildRetrievalCardsInBackground(undefined, true);
    }
  };

  const indexSelectedPaper = async () => {
    const relativePath = selectedPaper?.pdf.path;
    if (!relativePath) {
      setStatus("当前论文没有已关联的本地 PDF。请先下载或上传 PDF。");
      return;
    }
    if (busy) return;
    setBusy("paper");
    setLibraryResult(null);
    setStatus(`正在通过内置 PDF 阅读器逐页提取《${selectedPaper.title}》并建立本地全文索引…`);
    try {
      const result = await literatureRagIndexPdf(
        relativePath,
        selectedPaper.id,
      );
      const indexedChunks = result.stats?.indexedChunks ?? result.indexedChunks ?? 0;
      const skipped = result.stats?.skippedAsCurrent ?? result.skippedAsCurrent ?? false;
      const message = skipped
        ? `《${selectedPaper.title}》内容未变化，已保留现有全文索引。`
        : `《${selectedPaper.title}》已建立 ${indexedChunks} 个本地可引用页块；共 ${result.pageCount} 页${result.ocrUsed ? "，包含 OCR 页" : ""}。`;
      const parserNote = result.parserEngine
        ? ` 解析器：${result.parserEngine}；图像资产 ${result.assetCount ?? 0} 个。${result.parserWarning ? ` ${result.parserWarning}` : ""}`
        : "";
      const cardNote = autoRetrievalCardsRef.current
        ? " 检索卡将转入后台自动构建。"
        : " 自动检索卡生成已关闭；可在需要时手动补建。";
      setStatus(`${message}${parserNote}${cardNote}`);
      onActivity("ok", `${message}${parserNote}${cardNote}`);
      if (autoRetrievalCardsRef.current) void buildRetrievalCardsInBackground(selectedPaper.id, true);
    } catch (cause) {
      reportFailure("单篇 PDF 索引失败", cause);
    } finally {
      setBusy(null);
      void refreshDatabaseStatus();
    }
  };

  const indexLibrary = async (forceRebuild: boolean) => {
    if (busy) return;
    if (forceRebuild && !window.confirm("强制重建会清除并重建可再生的 PDF 全文索引与检索卡；原始 PDF 和文献数据不会被修改。继续吗？")) return;
    setBusy(forceRebuild ? "rebuild" : "library");
    setLibraryResult(null);
    setStatus(forceRebuild ? "正在强制重建全部 PDF 全文索引…" : "正在增量更新全文献库 PDF 全文索引…");
    try {
      const result = await literatureRagIndexLibrary(forceRebuild);
      setLibraryResult(result);
      const message = `PDF 索引完成：共 ${result.total} 篇，更新 ${result.indexed} 篇，跳过 ${result.skipped} 篇，失败 ${result.failed} 篇。`;
      const cardNote = autoRetrievalCardsRef.current
        ? " 检索卡将转入后台自动构建。"
        : " 自动检索卡生成已关闭；可在需要时手动补建。";
      setStatus(`${message} 原文索引使用本地 SQLite FTS5。${cardNote}`);
      onActivity(result.failed > 0 ? "error" : "ok", `${message}${cardNote}`);
      if (autoRetrievalCardsRef.current) void buildRetrievalCardsInBackground(undefined, true);
    } catch (cause) {
      reportFailure(forceRebuild ? "强制重建 PDF 索引失败" : "批量建立 PDF 索引失败", cause);
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
      setStatus("请输入要在已确认知识和 PDF 原文中检索的问题。");
      return;
    }
    if (busy) return;
    setBusy("search");
    setSearchResult(null);
    setAnswer("");
    setAnswerReview(null);
    setStatus("正在由 LLM 生成少量扩展检索式，并行检索原文、检索卡和已确认知识…");
    try {
      const result = await projectRagSearch<ProjectRagSearchResult>(normalizedQuery, 8);
      setSearchResult(result);
      const warning = result.plannerWarning ? ` 查询扩展不可用，已回退到原问题：${result.plannerWarning}` : "";
      setStatus(`检索完成：${result.knowledge.results.length} 条已确认知识，${result.literature.results.length} 个 PDF 原文页块。${warning}`);
    } catch (cause) {
      reportFailure("本地检索失败", cause);
    } finally {
      setBusy(null);
    }
  };

  const answerWithSomni = async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setStatus("请输入要根据已确认知识和 PDF 原文回答的问题。");
      return;
    }
    if (busy) return;
    setBusy("answer");
    setSearchResult(null);
    setAnswer("");
    setAnswerReview(null);
    setStatus("正在扩展问题、检索与重排证据，并由独立 Reviewer 核验页码引用…");
    try {
      const result: ProjectRagAnswerResult = await projectRagAnswer(normalizedQuery, 8);
      setSearchResult(result);
      setAnswer(result.answer);
      setAnswerReview(result.review);
      const reviewNote = result.review.verdict === "pass"
        ? "独立证据审校通过。"
        : `独立证据审校：${result.review.verdict}。`;
      setStatus(`回答完成：引用 ${result.knowledge.results.length} 条已确认知识和 ${result.literature.results.length} 个 PDF 页块。${reviewNote}`);
    } catch (cause) {
      reportFailure("检索回答失败", cause);
    } finally {
      setBusy(null);
    }
  };

  const paperTitle = (paperId: string) => papers.find((paper) => paper.id === paperId)?.title ?? paperId;
  const totalResults = (searchResult?.knowledge.results.length ?? 0) + (searchResult?.literature.results.length ?? 0);

  return (
    <section className="lit-rag-panel" aria-label="本地文献检索">
      <div className="lit-rag-header">
        <div className="lit-rag-header-icon" aria-hidden="true">
          <SvgIcon name="memory" size={22} />
        </div>
        <div className="lit-rag-header-copy">
          <div className="lit-rag-header-meta">
            <span className="lit-rag-kicker">Local search</span>
            <div className="lit-rag-header-tags" aria-label="检索特性">
              <span><SvgIcon name="check" size={12} /> 本地 FTS5</span>
              <span><SvgIcon name="memory" size={12} /> 零向量存储</span>
            </div>
          </div>
          <h2>本地 PDF 与知识检索</h2>
          <p>PDF 分页、OCR、页块和 SQLite FTS 索引均保存在项目 <code>papers/rag/</code>；仅在生成检索卡或回答时，才向已配置的模型传入所需页块。</p>
          <p className="lit-rag-chat-route"><SvgIcon name="inbox" size={12} /> 搜索并保存新文献请直接在 Chat 中提出；此处专注检索本地 PDF 与已确认知识。</p>
        </div>
      </div>

      <section className="lit-rag-pipeline" aria-label="无向量检索链路">
        <div className="lit-rag-pipeline-intro">
          <SvgIcon name="diagram" size={17} />
          <div>
            <strong>证据链路</strong>
            <span>原始页码始终可追溯</span>
          </div>
        </div>
        <ol>
          <li><SvgIcon name="attachment" size={14} /><span><strong>PDF / OCR</strong><small>分页与图注</small></span></li>
          <li><SvgIcon name="search" size={14} /><span><strong>FTS5 召回</strong><small>本地全文检索</small></span></li>
          <li><SvgIcon name="sparkle" size={14} /><span><strong>LLM 重排</strong><small>受限候选页块</small></span></li>
          <li><SvgIcon name="check" size={14} /><span><strong>Reviewer</strong><small>独立核验引用</small></span></li>
        </ol>
      </section>

      <div className="lit-rag-workspace-grid">

      <section className="lit-rag-database" aria-label="本地检索库状态">
        <div className="lit-rag-database-head">
          <div className="lit-rag-database-title">
            <span className="lit-rag-section-icon" aria-hidden="true"><SvgIcon name="library" size={15} /></span>
            <div>
            <strong>本地检索库</strong>
            <span title={databaseStatus?.indexPath}>
              {databaseStatus?.relativeIndexPath ?? "papers/rag/literature-retrieval.sqlite"}
            </span>
            </div>
          </div>
          <div className="lit-rag-database-controls">
            <span className={`lit-rag-state-pill ${databaseStatus?.exists ? "ready" : "empty"}`}>
              <i aria-hidden="true" />
              {databaseStatusRefreshing ? "读取中" : databaseStatus?.exists ? "索引就绪" : "待初始化"}
            </span>
            <button type="button" onClick={() => void refreshDatabaseStatus()} disabled={databaseStatusRefreshing} aria-label="刷新检索库状态" title="刷新检索库状态">
              <SvgIcon name="refresh" size={13} /> <span>{databaseStatusRefreshing ? "读取中" : "刷新"}</span>
            </button>
          </div>
        </div>
        {databaseStatusError && <p className="lit-rag-database-error">读取失败：{databaseStatusError}</p>}
        {!databaseStatus && !databaseStatusError && <p className="lit-note-text">正在读取本地索引状态…</p>}
        {databaseStatus && !databaseStatus.exists && (
          <div className="lit-rag-database-empty">
            <span aria-hidden="true"><SvgIcon name="library" size={20} /></span>
            <div>
              <strong>还没有全文索引</strong>
              <p>从右侧更新文献库，系统会在项目内创建可追溯的本地检索库。</p>
            </div>
          </div>
        )}
        {databaseStatus?.exists && (
          <>
            <div className="lit-rag-database-stats">
              <div><strong>{databaseStatus.documentCount}</strong><span>已索引论文</span></div>
              <div><strong>{databaseStatus.chunkCount}</strong><span>原文页块</span></div>
              <div><strong>{databaseStatus.currentCardCount}</strong><span>有效检索卡</span></div>
              <div><strong>{databaseStatus.pendingCardCount}</strong><span>待生成卡</span></div>
              <div><strong>{databaseStatus.assetCount}</strong><span>图表资产</span></div>
              <div><strong>{formatStorageBytes(databaseStatus.databaseBytes)}</strong><span>数据库大小</span></div>
            </div>
            <div className="lit-rag-card-coverage">
              <div>
                <span>检索卡覆盖</span>
                <strong>{databaseStatus.currentCardCount}/{databaseStatus.chunkCount}</strong>
              </div>
              <progress max={Math.max(databaseStatus.chunkCount, 1)} value={databaseStatus.currentCardCount} />
              <small>
                元数据 {databaseStatus.metadataDocumentCount} 篇 · 引用关系 {databaseStatus.citationMentionCount} 条
                {databaseStatus.staleCardCount > 0 ? ` · 失效卡 ${databaseStatus.staleCardCount} 张` : ""}
              </small>
            </div>
            <details className="lit-rag-card-browser">
              <summary>查看检索卡内容（最近 {databaseStatus.cardPreviews.length} 张）</summary>
              {databaseStatus.cardPreviews.length === 0 ? (
                <p className="lit-note-text">当前还没有检索卡。</p>
              ) : databaseStatus.cardPreviews.map((preview) => {
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
                  <article key={preview.chunkId} className="lit-rag-card-preview">
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
                    <footer>{preview.card.generatedBy || "configured executor"} · prompt v{preview.card.promptVersion}</footer>
                  </article>
                );
              })}
            </details>
          </>
        )}
      </section>

      <section className="lit-rag-maintenance" aria-label="索引维护">
        <div className="lit-rag-maintenance-head">
          <div>
            <span className="lit-rag-section-icon" aria-hidden="true"><SvgIcon name="refresh" size={15} /></span>
            <div>
              <strong>索引维护</strong>
              <span>同步 PDF 页块与检索卡</span>
            </div>
          </div>
          <span className={`lit-rag-selection${selectedPaper?.pdf.path ? " available" : ""}`} title={selectedPaper?.title}>
            {selectedPaper?.pdf.path ? `当前：${selectedPaper.title}` : "当前论文无本地 PDF"}
          </span>
        </div>

        <div className="lit-rag-actions" role="toolbar" aria-label="检索索引操作">
          <button type="button" className="primary lit-rag-library-action" onClick={() => void indexLibrary(false)} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="refresh" size={14} />
            {busy === "library" ? "正在批量更新…" : "增量更新全文献库全文"}
          </button>
          <button type="button" onClick={() => void indexSelectedPaper()} disabled={Boolean(busy) || retrievalCardBuild.running || !selectedPaper?.pdf.path}>
            <SvgIcon name="target" size={14} />
            {busy === "paper" ? "正在索引当前 PDF…" : "建立当前 PDF 全文索引"}
          </button>
          <button type="button" onClick={buildRetrievalCards} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="sparkle" size={14} />
            {retrievalCardBuild.running ? "检索卡后台构建中…" : "立即补建检索卡"}
          </button>
        </div>

        <label className="lit-rag-auto-cards">
          <input
            type="checkbox"
            aria-label="自动生成检索卡"
            checked={autoRetrievalCards}
            onChange={(event) => setAutoRetrievalCardBuild(event.target.checked)}
          />
          <span className="lit-rag-switch" aria-hidden="true"><i /></span>
          <span className="lit-rag-auto-copy">
            <strong>自动生成检索卡</strong>
            <small>新索引完成后在后台分批处理</small>
          </span>
        </label>

        <div className={`lit-rag-status${libraryResult?.failed ? " warning" : ""}`} role="status" aria-live="polite">
          <span className="lit-rag-status-icon" aria-hidden="true">
            {busy
              ? <span className="lit-search-spinner" />
              : <SvgIcon name={libraryResult?.failed ? "warning" : "check"} size={14} />}
          </span>
          <div><strong>运行状态</strong><span>{status}</span></div>
        </div>
        <div className={`lit-rag-card-build${retrievalCardBuild.running ? " running" : ""}`} aria-live="polite">
          <SvgIcon name="sparkle" size={14} />
          <div>
            <strong>检索卡后台任务</strong>
            <span>{retrievalCardBuild.message || (autoRetrievalCards ? "新建全文索引后会自动开始。" : "自动生成已关闭。")}</span>
          </div>
          {retrievalCardBuild.running && <span className="lit-search-spinner" aria-hidden="true" />}
        </div>
        {libraryResult && libraryResult.failures.length > 0 && (
          <details className="lit-rag-failures">
            <summary>查看 {libraryResult.failures.length} 项失败</summary>
            {libraryResult.failures.map((failure) => (
              <div key={`${failure.paperId}-${failure.relativePath}`}>
                <strong>{paperTitle(failure.paperId)}</strong>
                <span>{failure.error}</span>
              </div>
            ))}
          </details>
        )}
        <details className="lit-rag-advanced">
          <summary><SvgIcon name="reset" size={13} /> 高级维护 <small>索引异常时使用</small></summary>
          <button type="button" className="danger" onClick={() => void indexLibrary(true)} disabled={Boolean(busy) || retrievalCardBuild.running}>
            <SvgIcon name="warning" size={13} />
            {busy === "rebuild" ? "正在强制重建…" : "强制重建 PDF 全文索引"}
          </button>
        </details>
      </section>
      </div>

      <form className="lit-rag-search" onSubmit={(event) => { event.preventDefault(); void answerWithSomni(); }}>
        <div className="lit-rag-search-heading">
          <span className="lit-rag-search-icon" aria-hidden="true"><SvgIcon name="sparkle" size={18} /></span>
          <div>
            <span className="lit-rag-kicker">Ask SomniQ</span>
            <strong>基于本地证据提问</strong>
            <span>FTS5 召回原文与已确认知识，LLM 仅重排少量候选；回答由独立 Reviewer 核验页码引用。</span>
          </div>
        </div>
        <div className="lit-rag-search-box">
          <label className="lit-rag-query-input">
            <SvgIcon name="search" size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：该方法在哪些数据集上验证，主要局限是什么？" aria-label="检索问题" />
          </label>
          <button type="button" onClick={() => void search()} disabled={Boolean(busy) || !query.trim()}>
            <SvgIcon name="search" size={14} /> {busy === "search" ? "检索中…" : "仅检索证据"}
          </button>
          <button type="submit" className="primary" disabled={Boolean(busy) || !query.trim()}>
            <SvgIcon name="sparkle" size={14} /> {busy === "answer" ? "回答中…" : "检索并回答"}
          </button>
        </div>
      </form>

      {answer && (
        <section className="lit-rag-answer" aria-label="SomniQ 检索回答">
          <div>
            <strong>SomniQ 基于本地证据的回答</strong>
            <span>回答由当前已配置的 LLM 生成；请通过下方来源卡片复核引用。</span>
          </div>
          <p>{answer}</p>
          {answerReview && answerReview.findings.length > 0 && (
            <small>独立审校：{answerReview.findings.join("；")}</small>
          )}
        </section>
      )}

      {searchResult && (
        <div className="lit-rag-results" aria-label="检索结果">
          {totalResults === 0 && <p className="lit-note-text">当前全文索引没有命中。可先为 PDF 建立全文索引，或换用更具体的关键词。</p>}
          {searchResult.knowledge.results.length > 0 && (
            <div className="lit-rag-result-group">
              <div className="lit-rag-result-heading">
                <strong>已确认知识</strong>
                <span>{searchResult.knowledge.results.length}</span>
              </div>
              {searchResult.knowledge.results.map((hit) => (
                <article className="lit-rag-result-card knowledge" key={hit.knowledge.id}>
                  <div className="lit-rag-result-meta">
                    <span>已确认</span>
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
                <strong>PDF 原文页块</strong>
                <span>{searchResult.literature.results.length}</span>
              </div>
              {searchResult.literature.results.map((hit) => (
                <article className="lit-rag-result-card pdf" key={hit.chunk.chunkId}>
                  <div className="lit-rag-result-meta">
                    <span>{hit.chunk.pageSource === "ocr" ? "OCR" : "PDF 文本"}</span>
                    <span>p.{hit.chunk.pageStart}</span>
                    {hit.sourceRank && <span>原文匹配 #{hit.sourceRank}</span>}
                    {hit.cardRank && <span>检索卡匹配 #{hit.cardRank}</span>}
                    {hit.assetRank && <span>图表匹配 #{hit.assetRank}</span>}
                    {hit.citationRank && <span>引用匹配 #{hit.citationRank}</span>}
                    {hit.metadataRank && <span>元数据匹配 #{hit.metadataRank}</span>}
                    {hit.matchedQueries.length > 0 && <span>扩展词：{hit.matchedQueries.slice(0, 2).join(" / ")}</span>}
                  </div>
                  <strong>{paperTitle(hit.chunk.paperId)}</strong>
                  <p>{hit.chunk.text}</p>
                  <button type="button" className="lit-rag-open-page" onClick={() => onOpenCitation(hit.chunk.paperId, hit.chunk.pageStart)}>
                    打开原文页 <SvgIcon name="chevronRight" size={13} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────

export default function Literature({
  pageView: controlledPageView,
  onPageViewChange,
}: LiteratureProps = {}) {
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
            logActivity("ok", "Imported dropped PDF as a local literature record.");
          })
          .catch((error) => {
            const message = `Could not import dropped PDF: ${String(error)}`;
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
      logActivity("ok", "已创建本地文献数据库备份");
    } catch (error) {
      const message = `创建文献数据库备份失败：${String(error)}`;
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
        filters: [{ name: "Bibliography exports", extensions: ["json", "ris", "bib", "bibtex", "biblatex"] }],
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
        report.attachments ? `${report.attachments} 个附件` : "",
        report.notes ? `${report.notes} 条笔记` : "",
        report.annotations ? `${report.annotations} 条标注` : "",
        report.collections ? `${report.collections} 个分类` : "",
      ].filter(Boolean);
      const warningSummary = report.warnings?.length
        ? `；${report.warnings.length} 项需手动处理：${report.warnings[0]}`
        : "";
      logActivity(
        "ok",
        `已从 ${report.format} 导入 ${report.imported} 条、合并 ${report.merged} 条文献${migratedChildren.length ? `；同时迁移 ${migratedChildren.join("、")}` : ""}${report.skipped ? `；跳过 ${report.skipped} 条不支持项` : ""}${warningSummary}`,
      );
    } catch (error) {
      const message = `导入文献库失败：${String(error)}`;
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
      logActivity("ok", "已导入 PDF 并创建本地文献条目");
    } catch (error) {
      const message = `导入 PDF 失败：${String(error)}`;
      setError(message);
      logActivity("error", message);
    }
  };

  const addIdentifier = async () => {
    if (!isTauri()) return;
    const identifier = window.prompt("输入 DOI 或 ISBN");
    if (!identifier?.trim()) return;
    try {
      const result = await literatureAddIdentifier<{ papers?: Array<{ id: string }> }>(identifier);
      await load(projectId, { quiet: true });
      if (result.papers?.[0]?.id) setSelectedId(result.papers[0].id);
      logActivity("ok", "已通过 DOI/ISBN 查询写入可审计的本地文献记录");
    } catch (error) {
      const message = `添加 DOI/ISBN 失败：${String(error)}`;
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
    logActivity("ok", `Saved dynamic local search: ${filter.trim()}`);
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
    openAgentChat([
      "Use the configured Playwright MCP browser tools to obtain the legitimate PDF for this library paper.",
      `Paper id: ${paper.id}`,
      `Title: ${paper.title}`,
      `Landing page: ${landingPage}`,
      `DOI: ${paper.doi ?? "unknown"}`,
      "Reuse the browser tab/session I approve. Do not bypass paywalls or security interstitials.",
      "If login, CAPTCHA, or user approval is needed, pause and ask me.",
      "Download into papers/.browser-inbox, verify that the file is a PDF, then move it into papers/ with a stable filename and update only this record in the local literature database.",
    ].join("\n"));
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
      setError(`检索结果关联的文献 ${paperId} 已不在当前文献库中。请重建派生索引。`);
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
        setError(`已定位到第 ${page} 页，但当前文献记录没有可打开的本地 PDF。`);
      }
    }
  };

  const importSelectedAttachment = async (
    id: string,
    kind: Exclude<LiteratureAttachment["kind"], "externalLink">,
  ) => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Research files", extensions: ["pdf", "txt", "md", "html", "htm", "json", "csv", "docx", "xlsx", "zip"] }],
    });
    if (typeof selected !== "string") return;
    const inferredKind = kind === "supplement" && selected.toLowerCase().endsWith(".pdf") ? "pdf" : kind;
    await importAttachment(id, selected, inferredKind);
  };

  const addExternalAttachment = (id: string) => {
    const url = window.prompt("添加外部链接（例如网页快照的原始 URL）：")?.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
      const label = window.prompt("链接名称：", parsed.hostname)?.trim() || parsed.hostname;
      addAttachment(id, { label, kind: "externalLink", url: parsed.toString() });
    } catch {
      setError("请输入有效的 http(s) 链接。");
    }
  };

  const openAttachment = async (paper: LiteraturePaper, attachment: LiteratureAttachment) => {
    if (attachment.kind === "externalLink" && attachment.url) {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (attachment.externalPath) {
      setError(`该 Zotero 附件仍位于原位置：${attachment.externalPath}。请使用“导入附件”将其复制到当前项目后再打开。`);
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
      setError(`打开附件失败：${String(error)}`);
    }
  };

  const exportPaperAnnotations = async (paper: LiteraturePaper) => {
    const destination = await saveDialog({
      defaultPath: `${paper.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "paper"}-annotations.json`,
      filters: [{ name: "SomniQ annotations", extensions: ["json"] }],
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
      logActivity("ok", `已导出 ${paper.pdfAnnotations.length} 条标注和 ${(paper.notes ?? []).length} 条笔记。`);
    } catch (error) {
      setError(`标注导出失败：${String(error)}`);
    }
  };

  const importPaperAnnotations = async (paper: LiteraturePaper) => {
    const source = await openDialog({
      multiple: false,
      filters: [{ name: "SomniQ annotations", extensions: ["json"] }],
    });
    if (typeof source !== "string") return;
    try {
      const payload = await literatureReadAnnotationExport<unknown>(source);
      const imported = importAnnotations(paper.id, payload);
      if (imported.annotations === 0 && imported.notes === 0) {
        setError("该文件没有可导入的标注或笔记。");
        return;
      }
      logActivity("ok", `已导入 ${imported.annotations} 条标注和 ${imported.notes} 条笔记。`);
    } catch (error) {
      setError(`标注导入失败：${String(error)}`);
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
      logActivity("ok", `已导出 ${exported.exported} 条文献为 ${labels[format]}。`);
    } catch (error) {
      setError(`书目导出失败：${String(error)}`);
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
    const label = ids.length === 1 ? "this paper" : `${ids.length} papers`;
    if (!window.confirm(`Delete ${label} from this library?`)) return;
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
    if (!window.confirm(`Merge \"${duplicate?.title ?? duplicateId}\" into \"${primary?.title ?? primaryId}\"? This keeps all linked local material.`)) return;
    try {
      await literatureMergeDuplicates(primaryId, duplicateId);
      setChecked(new Set());
      setSelectedId(primaryId);
      await load(projectId, { quiet: true });
      logActivity("ok", "Merged duplicate literature records and preserved linked material.");
    } catch (error) {
      const message = `Could not merge duplicate records: ${String(error)}`;
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
            aria-label={isExpanded ? "Collapse collection" : "Expand collection"}
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
            title="Add subcollection"
            onClick={() => {
              setColAddingParentId(collection.id);
              setColInput("");
              setExpandedCols((previous) => new Set(previous).add(collection.id));
            }}
          ><SvgIcon name="plus" size={13} /></button>
          <button
            type="button"
            className="lit-col-delete-btn"
            aria-label={`Delete ${collection.label}`}
            onClick={() => {
              if (!window.confirm(`Delete collection \"${collection.label}\" and its subcollections? Papers are preserved.`)) return;
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
                  placeholder="Subcollection name"
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
        <span className="lit-sidebar-title">筛选</span>
      </div>

      <div className="lit-sidebar-section">
        <div className="lit-section-header">
          <span className="lit-section-label">状态</span>
        </div>
        <NavItem
          label="全部论文"
          icon="library"
          count={papers.filter((p) => p.stage !== "excluded").length}
          active={view === "all"}
          onClick={() => setView("all")}
        />
        <NavItem
          label="已收藏"
          icon="star"
          count={papers.filter((p) => p.starred).length}
          active={view === "starred"}
          onClick={() => setView("starred")}
        />
        <NavItem
          label="重复条目"
          icon="library"
          count={duplicateCandidates.length}
          active={view === "duplicates"}
          onClick={() => setView("duplicates")}
        />
        {STAGES_NAV.filter((s) => s.alwaysVisible || (stageCounts.get(s.id) ?? 0) > 0).map(
          (stage) => (
            <NavItem
              key={stage.id}
              label={STAGE_LABELS[stage.id]}
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
        title="分类"
        defaultOpen
        extra={
          <button
            type="button"
            className="lit-section-icon-btn"
            onClick={() => { setColAddingParentId(""); setColInput(""); }}
            title="新建一级分类"
          ><SvgIcon name="plus" size={14} /></button>
        }
      >
        {colAddingParentId === "" && (
          <div className="lit-col-input-row">
            <input
              autoFocus
              className="lit-col-input"
              value={colInput}
              placeholder="分类名称…"
              onChange={(e) => setColInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitColInput();
                if (e.key === "Escape") { setColInput(""); setColAddingParentId(null); }
              }}
            />
            <button type="button" className="lit-col-confirm-btn" onClick={() => submitColInput()} title="确认"><SvgIcon name="check" size={14} /></button>
            <button type="button" className="lit-col-cancel-btn" onClick={() => { setColInput(""); setColAddingParentId(null); }} title="取消"><SvgIcon name="close" size={14} /></button>
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
                  aria-label={isExpanded ? "折叠" : "展开"}
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
                  title="添加子分类"
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
                    const msg = children.length > 0
                      ? `删除分类"${col.label}"及其 ${children.length} 个子分类？（论文不会被删除）`
                      : `删除分类"${col.label}"？（论文不会被删除）`;
                    if (window.confirm(msg)) {
                      removeCollection(col.id);
                      if (view === `col:${col.id}` || children.some((c) => view === `col:${c.id}`)) setView("all");
                    }
                  }}
                  aria-label={`删除 ${col.label}`}
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
                          if (window.confirm(`删除子分类"${child.label}"？（论文不会被删除）`)) {
                            removeCollection(child.id);
                            if (view === `col:${child.id}`) setView(`col:${col.id}`);
                          }
                        }}
                        aria-label={`删除 ${child.label}`}
                      ><SvgIcon name="close" size={13} /></button>
                    </div>
                  ))}
                  {colAddingParentId === col.id && (
                    <div className="lit-col-input-row lit-col-child-input-row">
                      <input
                        autoFocus
                        className="lit-col-input"
                        value={colInput}
                        placeholder="子分类名称…"
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
          <div className="lit-col-empty">暂无分类</div>
        )}
      </NavSection>

      <NavSection title="保存的搜索" defaultOpen>
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
        {library.searches.length === 0 && <div className="lit-col-empty">暂无保存搜索</div>}
      </NavSection>

    </aside>
  );

  // ── Main area ──────────────────────────────────────────────────────────────

  const viewLabel = (() => {
    if (view === "duplicates") return "重复条目";
    if (view === "all") return "全部论文";
    if (view === "starred") return "已收藏";
    if (view.startsWith("stage:")) return STAGE_LABELS[view.slice(6) as PaperStage] ?? "论文";
    if (view.startsWith("col:")) {
      const col = library.collections.find((c) => `col:${c.id}` === view);
      return col?.label ?? "分类";
    }
    if (view.startsWith("search:")) {
      return library.searches.find((search) => `search:${search.id}` === view)?.query ?? "保存的搜索";
    }
    return "论文";
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
                {formatAuthors(selectedPaper.authors)}
                {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
                {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
              </div>
            </div>
            <div className="lit-workspace-header-btns">
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title={selectedPaper.pdf.status === "downloaded" ? "打开 PDF" : "获取 PDF"}
                aria-label={selectedPaper.pdf.status === "downloaded" ? "打开所选论文 PDF" : "获取所选论文 PDF"}
                onClick={() => void downloadOrBrowse(selectedPaper.id)}
                disabled={selectedPaper.pdf.status === "downloading"}
              ><SvgIcon name="target" size={16} /></button>
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title="Open in chat"
                onClick={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
              ><SvgIcon name="externalLink" size={16} /></button>
              <button
                type="button"
                className="lit-workspace-icon-btn"
                title="Clear selection"
                aria-label="清除选择"
                onClick={() => { setSelectedId(null); setSelectionCleared(true); }}
              ><SvgIcon name="close" size={16} /></button>
            </div>
          </div>

          <div className="lit-workspace-tabs" role="tablist">
            {(
              [
                { id: "info", label: "信息" },
                { id: "overview", label: "简报" },
                { id: "reader", label: "PDF" },
                { id: "evidence", label: "证据" },
                { id: "notes", label: "Review" },
                { id: "files", label: "文件" },
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
                  if (window.confirm(`Delete "${selectedPaper.title}" from your library?`)) {
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
                  if (window.confirm(`Delete "${selectedPaper.title}" from your library?`)) {
                    deletePapers([selectedPaper.id]);
                  }
                }}
              />
            )}
            {workspaceTab === "reader" && !selectedPaper.pdf.path && (
              <div className="lit-workspace-empty-content">
                <p>请先下载 PDF，再在应用内阅读。</p>
                <button type="button" className="primary" onClick={() => void downloadOrBrowse(selectedPaper.id)}>
                  获取 PDF
                </button>
                <button type="button" onClick={() => void uploadSelectedPdf(selectedPaper.id)}>
                  上传本地 PDF
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
          <p>Select a paper to open it here.</p>
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
            dismiss
          </button>
        </div>
      )}

      {pageView === "discover" ? (
        <section className="lit-discover-workspace" aria-label="文献检索工作区">
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
          <Suspense fallback={<LiteratureLoading label="Loading knowledge graph..." />}>
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
              <SvgIcon name="chevronLeft" size={14} /> 返回
            </button>
            <div className="lit-reading-title-wrap">
              <div className="lit-reading-title">{selectedPaper.title}</div>
              <div className="lit-reading-sub">
                {formatAuthors(selectedPaper.authors)}
                {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
                {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
              </div>
            </div>
            <div className="lit-reading-tabs" role="tablist">
              {(
                [
                  { id: "info", label: "信息" },
                  { id: "overview", label: "简报" },
                  { id: "evidence", label: "证据" },
                  { id: "notes", label: "Review" },
                  { id: "files", label: "文件" },
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
          <Suspense fallback={<LiteratureLoading label="Loading PDF reader..." />}>
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
          {papers.length} {papers.length === 1 ? "paper" : "papers"} · {downloadedCount}{" "}
          {downloadedCount === 1 ? "PDF" : "PDFs"}
        </span>
        <span className="lit-footer-path">
          {storageStatus
            ? `${currentProject ? `${currentProject.name} · ` : ""}本地 SQLite · 模式 v${storageStatus.schemaVersion} · ${storageStatus.health.healthy ? "健康" : "需检查"} · ${storageStatus.canonicalRecordCount} 条规范记录 · ${formatStorageBytes(storageStatus.databaseBytes)} · ${storageStatus.latestBackup ? `最近备份 ${formatStorageBytes(storageStatus.latestBackup.bytes)}` : "尚未备份"}`
            : "正在读取本地文献数据库…"}
        </span>
        {storageStatus && (
          <button
            type="button"
            className="lit-footer-backup"
            title={`数据库：${storageStatus.databasePath}\n日志模式：${storageStatus.health.journalMode}\n完整性：${storageStatus.health.integrityCheck}\n外键问题：${storageStatus.health.foreignKeyViolations}\n兼容投影：${storageStatus.projectionPath}`}
            onClick={() => void createStorageBackup()}
            disabled={creatingStorageBackup}
          >
            {creatingStorageBackup ? "正在备份…" : "备份数据库"}
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
          placeholder="搜索标题、作者、关键词…"
          aria-label="Filter papers"
        />
        <button
          type="button"
          className="lit-review-save-search"
          onClick={onSaveDynamicSearch}
          disabled={!filter.trim()}
          title="Save as dynamic local search"
        >
          <SvgIcon name="plus" size={14} />
        </button>
        <select
          className="lit-review-sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label="Sort papers"
        >
          <option value="added">最新添加</option>
          <option value="fit">相关度</option>
          <option value="year">年份</option>
          <option value="citations">引用数</option>
          <option value="title">标题</option>
        </select>
      </div>

      <div className="lit-table-wrap">
        {loaded && libraryCount === 0 ? (
        <div className="lit-empty-state">
          <p>论文库为空。</p>
          <p className="dim">通过 Chat 中的 Agent 检索，或导入 Zotero/CSL-JSON、RIS、BibTeX 文献库。</p>
          <button type="button" onClick={onImportBibliography}>
            导入文献库
          </button>
          <button type="button" onClick={onImportPdf}>
            导入 PDF
          </button>
          <button type="button" onClick={onAddIdentifier}>
            添加 DOI / ISBN
          </button>
        </div>
        ) : loaded && libraryCount > 0 && papers.length === 0 ? (
          <div className="lit-empty-state">
            <p className="dim">没有符合当前筛选条件的论文。</p>
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
                  标题
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("venue", e, -1)} />
                </th>
                <th className="lit-th lit-th-venue">
                  出版物
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("venue", e)} />
                </th>
                <th className="lit-th lit-th-year">
                  年份
                  <div className="lit-col-resize" onMouseDown={(e) => startResize("year", e)} />
                </th>
                <th className="lit-th lit-th-tags">
                  #标签
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
        <div className="lit-batch-bar" role="toolbar" aria-label="Batch actions">
          {batchIds.length === 2 && <button type="button" onClick={onBatchMergeDuplicates}>Merge duplicates</button>}
          <span>已选 {batchIds.length} 篇</span>
          <button type="button" onClick={onBatchShortlist}>候选</button>
          <button type="button" onClick={onBatchExclude}>排除</button>
          <button type="button" onClick={onBatchDownload}>下载 PDF</button>
          <button type="button" className="danger" onClick={onBatchDelete}>删除</button>
          <button type="button" onClick={onBatchClear}>清除</button>
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
          aria-label={`Select ${paper.title}`}
          onChange={onToggleChecked}
        />
      </td>
      <td className="lit-row-stage">
        <span className={`lit-stage-dot ${paper.stage}`} title={STAGE_LABELS[paper.stage]} />
      </td>
      <td className="lit-row-title-cell">
        <div className={`lit-row-title${paper.unread ? " unread" : ""}`}>{paper.title}</div>
        <div className="lit-row-authors">
          {formatAuthors(paper.authors)}
          {paper.pdf.status === "downloaded" && (
            <span className="lit-pdf-badge" title={paper.pdf.path ?? ""}>PDF</span>
          )}
          {paper.evidence.length > 0 && (
            <span className="lit-row-evidence-badge" title="有提取证据">证</span>
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
          aria-label={paper.starred ? "Unstar" : "Star"}
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
  const fit = paper.verdict?.fit;
  const relevanceClass = fit ? `relevance-${fit}` : "relevance-none";
  const relevanceLabel = fit ? FIT_LABELS[fit] : "未筛选";
  const reason = paper.verdict?.rationale || paper.agentSummary;

  return (
    <div className="lit-overview">
      {/* 快速判断 */}
      <div className="lit-section">
        <div className="lit-section-heading">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2l1.5 4.5H14l-3.7 2.7 1.4 4.3L8 11l-3.7 2.5 1.4-4.3L2 6.5h4.5L8 2z" fill="currentColor" />
          </svg>
          <span>快速判断</span>
        </div>
        <div className="lit-quick-judgment">
          <div className="lit-judgment-col">
            <span className="lit-judgment-label">相关性</span>
            <span className={`lit-relevance-badge ${relevanceClass}`}>{relevanceLabel}</span>
          </div>
          {reason && (
            <div className="lit-judgment-col reason">
              <span className="lit-judgment-label">理由</span>
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
            <span>摘要</span>
            {!paper.abstract && <span className="lit-section-badge">缺失</span>}
          </div>
          <span className="lit-toggle-caret" aria-hidden="true"><SvgIcon name={abstractOpen ? "chevronDown" : "chevronRight"} size={12} /></span>
        </button>
        {abstractOpen && (
          <p className={`lit-abstract-text${paper.abstract ? "" : " missing"}`}>
            {paper.abstract || "当前元数据源未提供摘要。可尝试重新检索或从论文页面补充元数据。"}
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
          <span>结构化简报</span>
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
                  ? "该简报基于完整提取的 PDF 全文。"
                  : "该旧简报仅基于摘要，不应视为全文结论。"}
              </span>
              <button
                type="button"
                onClick={() => paper.pdf.status === "downloaded" ? onGenerateBrief(paper.id) : onDownload()}
                disabled={briefing}
              >
                {paper.pdf.status === "downloaded" ? "重新从完整全文生成" : "获取 PDF"}
              </button>
            </div>
          </>
        ) : (
          <div className="lit-brief-generate">
            <p>
              {paper.pdf.status === "downloaded"
                ? "PDF 已下载。简报将严格基于完整提取的全文生成。"
                : "请先获取 PDF；系统不会用摘要冒充全文简报。"}
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => paper.pdf.status === "downloaded" ? onGenerateBrief(paper.id) : onDownload()}
              disabled={briefing}
            >
              {briefing ? "读取完整全文中…" : paper.pdf.status === "downloaded" ? "从完整全文生成简报" : "获取 PDF"}
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
            <span>证据</span>
            <span className="lit-section-badge">{paper.evidence.length}</span>
            <button type="button" className="lit-view-all-btn" onClick={onViewEvidence}>
              查看全部
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
              加入候选
            </button>
          )}
          <button
            type="button"
            className="lit-action-btn"
            aria-label={paper.pdf.status === "downloaded" ? "打开 PDF" : "下载 PDF"}
            onClick={onDownload}
            disabled={paper.pdf.status === "downloading"}
            title={paper.pdf.status === "downloaded" ? paper.pdf.path : undefined}
          >
            {paper.pdf.status === "downloaded"
              ? "打开 PDF"
              : paper.pdf.status === "downloading"
                ? "下载中…"
                : paper.pdf.url
                  ? "下载 PDF"
                  : "Playwright MCP 获取 PDF"}
          </button>
          <button type="button" className="lit-action-btn" aria-label="问 Agent" onClick={onAsk}>
            问 Agent
          </button>
          <button type="button" className="lit-action-btn" onClick={onViewEvidence}>
            查看证据
          </button>
          <button type="button" className="lit-action-btn danger" aria-label="删除" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Brief columns (5-section horizontal layout)
// ──────────────────────────────────────────────────────────────────────────────

const BRIEF_COLS: Array<{ key: "problem" | "method" | "results" | "limits" | "forYou"; label: string; cls: string }> = [
  { key: "problem", label: "问题", cls: "brief-col-problem" },
  { key: "method", label: "方法", cls: "brief-col-method" },
  { key: "results", label: "结果", cls: "brief-col-results" },
  { key: "limits", label: "局限性", cls: "brief-col-limits" },
  { key: "forYou", label: "与你的研究", cls: "brief-col-foryou" },
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
  const fallbackSource = brief.basis === "fulltext" ? "pdf" : "abstract";
  return (
    <div className="lit-brief lit-brief-cols">
      {BRIEF_COLS.map(({ key, label, cls }) => {
        const section = brief[key] ?? { text: "该字段在旧简报中缺失，请重新生成。", source: fallbackSource };
        const annotation = annotations.find((entry) => entry.sourceId === `brief:${key}`);
        return (
          <div key={key} className={`lit-brief-col ${cls}`}>
            <div className="lit-brief-col-header">
              {label}
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
                在 PDF 中查看核心句
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
  task,
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
          <span>研究笔记</span>
          <span className="lit-section-badge">{notes.length}</span>
          <div className="lit-note-transfer-actions">
            <button type="button" onClick={onImport}>导入标注</button>
            <button type="button" onClick={onExport}>导出</button>
          </div>
        </div>
        <input
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          placeholder="笔记标题（可选）"
          aria-label="笔记标题"
        />
        <textarea
          rows={4}
          value={draftContent}
          onChange={(event) => setDraftContent(event.target.value)}
          placeholder="记录你的判断、方法或后续问题…"
          aria-label="新建研究笔记"
        />
        <button type="button" className="primary" disabled={!draftContent.trim()} onClick={addDraft}>
          添加笔记
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
                      <input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} aria-label="编辑笔记标题" />
                      <textarea rows={5} value={editingContent} onChange={(event) => setEditingContent(event.target.value)} aria-label="编辑笔记内容" />
                      <div className="lit-note-card-actions">
                        <button
                          type="button"
                          className="primary"
                          onClick={() => {
                            if (editingContent.trim()) onUpdateNote(note.id, { title: editingTitle.trim() || undefined, content: editingContent });
                            setEditingNoteId(null);
                          }}
                        >
                          保存
                        </button>
                        <button type="button" onClick={() => setEditingNoteId(null)}>取消</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="lit-research-note-head">
                        <strong>{note.title || "未命名笔记"}</strong>
                        <span>{note.source === "annotation" ? "标注生成" : note.source === "imported" ? "已导入" : "手动"}</span>
                      </div>
                      <p>{note.content}</p>
                      <div className="lit-note-card-actions">
                        {annotation && (
                          <button type="button" onClick={() => onOpenAnnotation(annotation.page, annotation.id)}>
                            第 {annotation.page} 页标注
                          </button>
                        )}
                        <button type="button" onClick={() => startEditing(note)}>编辑</button>
                        <button type="button" className="danger" onClick={() => onDeleteNote(note.id)}>删除</button>
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
          <span>PDF 标注</span>
          <span className="lit-section-badge">{paper.pdfAnnotations.length}</span>
        </div>
        {paper.pdfAnnotations.length === 0 ? (
          <p className="lit-note-text">在阅读器中创建高亮后，可在这里一键生成可编辑笔记。</p>
        ) : (
          <div className="lit-annotation-note-list">
            {paper.pdfAnnotations.slice().sort((left, right) => left.page - right.page).map((annotation) => (
              <article key={annotation.id} className="lit-annotation-note-item">
                <div><strong>第 {annotation.page} 页</strong><span>{annotation.kind}</span></div>
                <blockquote>{annotation.quote || annotation.note || "无文字摘录"}</blockquote>
                <div className="lit-note-card-actions">
                  <button type="button" onClick={() => onOpenAnnotation(annotation.page, annotation.id)}>在 PDF 中查看</button>
                  <button type="button" onClick={() => onCreateNoteFromAnnotation(annotation.id)}>由标注创建笔记</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {paper.verdict && (
        <div className="lit-section">
          <div className="lit-section-heading">
            <span>Reviewer 判断</span>
            <span className={`lit-fit fit-${paper.verdict.fit}`}>
              {FIT_LABELS[paper.verdict.fit]} · {paper.verdict.score}
            </span>
          </div>
          <p className="lit-verdict-text">{paper.verdict.rationale}</p>
        </div>
      )}
      {paper.agentSummary && (
        <div className="lit-section">
          <div className="lit-section-heading"><span>Agent 摘要</span></div>
          <p className="lit-note-text">{paper.agentSummary}</p>
        </div>
      )}
      {!paper.verdict && !paper.agentSummary && (
        <div className="lit-workspace-empty-content">暂无筛选判断。</div>
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
  const annotations = new Map(paper.pdfAnnotations.map((annotation) => [annotation.id, annotation]));
  return (
    <div className="lit-workspace-scroll lit-evidence-workspace" lang="zh-CN">
      <header className="lit-section lit-evidence-intro">
        <div className="lit-evidence-intro-head">
          <div>
            <span className="lit-evidence-eyebrow">证据阅读</span>
            <h3>从中文结论回到 PDF 原始证据</h3>
          </div>
          <span className="lit-evidence-total">{paper.evidence.length} 条证据</span>
        </div>
        <p>
          先阅读中文问题与结论，再通过支撑卡片或原文摘录回到 PDF 核验。
        </p>
        <div className="lit-evidence-summary">
          <span>问答结论 <strong>{paper.answerChains.length}</strong></span>
          <span>原文摘录 <strong>{paper.evidence.length}</strong></span>
          <span>视觉证据 <strong>{paper.evidence.filter((item) => item.source === "vision").length}</strong></span>
        </div>
        <button
          type="button"
          className="primary"
          onClick={paper.pdf.status === "downloaded" ? onGenerateChains : onDownload}
          disabled={generatingChains}
        >
          {generatingChains
            ? "正在读取 PDF 并构建证据链…"
            : paper.pdf.status === "downloaded"
              ? paper.answerChains.length > 0 ? "重新生成证据链" : "生成证据链"
              : "获取 PDF"}
        </button>
      </header>

      {paper.answerChains.length > 0 && (
        <section className="lit-evidence-group" aria-label="问答结论">
          <div className="lit-evidence-group-heading">
            <div>
              <span>问答结论</span>
              <p>每条结论均可回溯到下方 PDF 支撑。</p>
            </div>
            <strong>{paper.answerChains.length}</strong>
          </div>
          {paper.answerChains.map((chain, index) => (
            <article className="lit-answer-chain" key={chain.id}>
              <div className="lit-answer-chain-head">
                <div className="lit-answer-chain-number">
                  <span>问答 {String(index + 1).padStart(2, "0")}</span>
                  {chain.basis === "vision" && <em>视觉构建</em>}
                </div>
                <div className="lit-answer-chain-review" role="group" aria-label={`复核状态 ${index + 1}`}>
                  {([
                    ["unreviewed", "待复核"],
                    ["accepted", "已确认"],
                    ["rejected", "已驳回"],
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
                label="研究问题"
                value={chain.question}
                rows={2}
                ariaLabel={`问题 ${index + 1}`}
                onSave={(value) => onUpdateChain(chain.id, { question: value })}
              />
              <EditableMathField
                label="中文结论"
                value={chain.answer}
                rows={4}
                ariaLabel={`最终答案 ${index + 1}`}
                className="conclusion"
                onSave={(value) => onUpdateChain(chain.id, { answer: value })}
              />
              <div className="lit-answer-chain-supports">
                <div className="lit-answer-chain-supports-head">
                  <span>证据支撑</span>
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
                        <strong>{EVIDENCE_ROLE_LABELS[support.role] ?? support.role}</strong>
                        <span>第 {annotation.page} 页</span>
                        {annotation.source === "vision" && <span>视觉页证据</span>}
                      </span>
                      <MathText text={annotation.quote} className="lit-answer-support-quote" />
                      <span className="lit-answer-support-open">在 PDF 中核验</span>
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
              ? "暂无提取的证据。可让模型逐页读取 PDF 正文，仅对图表等页面回退到截图读取，并提取带页码证据。"
              : "暂无提取的证据。请先获取 PDF，避免仅凭摘要生成证据。"}
          </p>
          <button
            type="button"
            className="primary"
            onClick={paper.pdf.status === "downloaded" ? onGenerateChains : onDownload}
            disabled={generatingChains}
          >
            {generatingChains
              ? "正在读取 PDF 并构建证据链…"
              : paper.pdf.status === "downloaded"
                ? "生成证据链"
                : "获取 PDF"}
          </button>
        </div>
      ) : (
        <section className="lit-evidence-group" aria-label="原文证据">
          <div className="lit-evidence-group-heading">
            <div>
              <span>原文证据</span>
              <p>中文说明用于快速阅读，原文摘录用于核验。</p>
            </div>
            <strong>{paper.evidence.length}</strong>
          </div>
          {paper.evidence.map((item, index) => (
            <article className="lit-evidence-card" key={item.id}>
              <div className="lit-evidence-card-head">
                <div className="lit-evidence-card-meta">
                  <span>证据 {String(index + 1).padStart(2, "0")}</span>
                  <em>第 {item.page} 页</em>
                  <em>{item.source === "vision" ? "视觉页证据" : "文本证据"}</em>
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
                    打开原页
                  </button>
                  <button
                    type="button"
                    className="lit-evidence-delete"
                    aria-label={`删除证据：${item.quote.slice(0, 30)}`}
                    onClick={() => onDeleteEvidence(item.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="lit-evidence-explanation">
                <span>中文说明</span>
                <p><MathText text={item.note} /></p>
              </div>
              <div className="lit-evidence-source">
                <span>原文摘录</span>
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
          <button type="button" aria-label={`编辑${ariaLabel}`} onClick={() => setEditing(true)}>
            编辑
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
          <dt>来源</dt><dd>{paper.source}</dd>
          <dt>阶段</dt><dd>{STAGE_LABELS[paper.stage]}</dd>
          <dt>添加时间</dt><dd>{paper.addedAt.slice(0, 10)}</dd>
          <dt>PDF</dt>
          <dd>
            {paper.pdf.status === "downloaded"
              ? paper.pdf.path
              : paper.pdf.status === "failed"
                ? `失败 — ${paper.pdf.error ?? "未知错误"}`
                : paper.pdf.url
                  ? "有直链"
                  : "无直链"}
          </dd>
        </dl>
        <button type="button" className="primary" onClick={() => void onDownload(paper.id)}
          disabled={paper.pdf.status === "downloading"}>
          {paper.pdf.status === "downloaded"
            ? "打开 PDF"
            : paper.pdf.status === "downloading"
              ? "下载中…"
              : paper.pdf.url
                ? paper.pdf.status === "failed" ? "重试下载" : "下载 PDF"
                : "Playwright MCP 获取 PDF"}
        </button>
        <button type="button" onClick={onUpload}>上传本地 PDF</button>
      </div>

      <div className="lit-section lit-bibliography-export-section">
        <div className="lit-section-heading"><span>引用与书目导出</span></div>
        <p className="lit-note-text">
          Citation key：<code>{paper.citationKey || "首次导出或引用时自动生成"}</code>
        </p>
        <div className="lit-attachment-actions" aria-label="导出此条目">
          <button type="button" onClick={() => onExportBibliography("bibtex")}>BibTeX</button>
          <button type="button" onClick={() => onExportBibliography("biblatex")}>BibLaTeX</button>
          <button type="button" onClick={() => onExportBibliography("ris")}>RIS</button>
          <button type="button" onClick={() => onExportBibliography("csl-json")}>CSL-JSON</button>
        </div>
      </div>

      <div className="lit-section lit-attachments-section">
        <div className="lit-section-heading">
          <span>附件与外部资源</span>
          <span className="lit-section-badge">{(paper.attachments ?? []).length}</span>
        </div>
        <div className="lit-attachment-actions">
          <button type="button" onClick={() => onImportAttachment("supplement")}>添加文件</button>
          <button type="button" onClick={() => onImportAttachment("webSnapshot")}>添加网页快照</button>
          <button type="button" onClick={onAddExternalLink}>添加外部链接</button>
        </div>
        {(paper.attachments ?? []).length === 0 ? (
          <p className="lit-note-text">除主 PDF 外，可关联补充材料、网页快照和外部链接。</p>
        ) : (
          <div className="lit-attachment-list">
            {(paper.attachments ?? []).map((attachment) => (
              <article className="lit-attachment-item" key={attachment.id}>
                <div className="lit-attachment-item-head">
                  <strong>{attachment.label}</strong>
                  <span>{
                    attachment.kind === "pdf" ? "PDF"
                      : attachment.kind === "supplement" ? "补充材料"
                        : attachment.kind === "webSnapshot" ? "网页快照" : "外部链接"
                  }</span>
                </div>
                <p title={attachment.path ?? attachment.url ?? attachment.externalPath}>{attachment.path ?? attachment.url ?? attachment.externalPath}</p>
                <div className="lit-note-card-actions">
                  <button type="button" onClick={() => onOpenAttachment(attachment)}>
                    {attachment.kind === "pdf" ? "设为阅读 PDF" : attachment.kind === "externalLink" ? "打开链接" : attachment.externalPath ? "查看原路径" : "打开"}
                  </button>
                  <button type="button" className="danger" onClick={() => onRemoveAttachment(attachment.id)}>移除关联</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>摘要</span></div>
        <p className="lit-note-text">{paper.abstract || "暂无摘要。"}</p>
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>标签</span></div>
        <div className="lit-tag-edit">
          {paper.tags.map((tag) => (
            <span className={`lit-tag ${tagColorClass(tag)}`} key={tag}>{tag}</span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => onTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddTag(); }}
            placeholder="添加标签"
            aria-label="添加标签"
          />
        </div>
      </div>

      <div className="lit-section">
        <div className="lit-section-heading"><span>分类</span></div>
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
          <p className="lit-note-text">尚未创建分类。</p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Activity drawer
// ──────────────────────────────────────────────────────────────────────────────

function ActivityDrawer() {
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
        <span className="lit-activity-title">Activity</span>
        <span className={`lit-activity-last ${latest?.level ?? ""}`}>
          {latest ? latest.text : "idle — searches, downloads, and agent actions are logged here"}
        </span>
        <span className="lit-activity-caret" aria-hidden="true"><SvgIcon name={open ? "chevronDown" : "chevronRight"} size={12} /></span>
      </button>
      {open && (
        <div className="lit-activity-body">
          <div className="lit-activity-log" ref={logRef} role="log" aria-label="Literature activity log">
            {activity.length === 0 && (
              <div className="lit-activity-line info">No activity yet this session.</div>
            )}
            {activity.map((entry) => (
              <div key={entry.id} className={`lit-activity-line ${entry.level}`}>
                <span className="lit-activity-ts">{formatLogTime(entry.at)}</span>
                {entry.text}
              </div>
            ))}
          </div>
          <div className="lit-activity-actions">
            <button type="button" onClick={clear} disabled={activity.length === 0}>Clear</button>
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
    const next = window.prompt("Citation key", paper.citationKey ?? "");
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
              {FIT_LABELS[fit]}{paper.verdict?.score !== undefined ? ` · ${paper.verdict.score}` : ""}
            </span>
          )}
          {paper.starred && <span className="lip-star-badge"><SvgIcon name="star" size={13} /> 已收藏</span>}
        </div>
      )}

      <div className="lip-section">
        <div className="lip-section-head">信息</div>
        <dl className="lip-meta">
          <dt>条目类型</dt><dd>{itemTypeLabel(paper.itemType)}</dd>
          {paper.authors.map((author, i) => (
            <Fragment key={i}>
              <dt>{i === 0 ? "作者" : ""}</dt>
              <dd>{author}</dd>
            </Fragment>
          ))}
          {paper.venue && <><dt>出版物</dt><dd>{paper.venue}</dd></>}
          {paper.year && <><dt>日期</dt><dd>{paper.year}</dd></>}
          {paper.date && paper.date !== String(paper.year ?? "") && <><dt>Date</dt><dd>{paper.date}</dd></>}
          {paper.volume && <><dt>Volume</dt><dd>{paper.volume}</dd></>}
          {paper.issue && <><dt>Issue</dt><dd>{paper.issue}</dd></>}
          {paper.pages && <><dt>Pages</dt><dd>{paper.pages}</dd></>}
          {paper.publisher && <><dt>Publisher</dt><dd>{paper.publisher}</dd></>}
          {paper.place && <><dt>Place</dt><dd>{paper.place}</dd></>}
          {paper.citedBy !== undefined && <><dt>引用数</dt><dd>{paper.citedBy}</dd></>}
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
          <dt>来源</dt><dd>{paper.source}</dd>
          <dt>阶段</dt><dd>{STAGE_LABELS[paper.stage]}</dd>
          <dt>添加时间</dt><dd>{paper.addedAt.slice(0, 10)}</dd>
          <dt>PDF</dt>
          <dd>
            {paper.pdf.status === "downloaded" ? "已下载"
              : paper.pdf.status === "downloading" ? "下载中…"
              : paper.pdf.status === "failed" ? "失败"
              : paper.pdf.url ? "有直链" : "无直链"}
          </dd>
        </dl>
      </div>

      <div className="lip-section">
        <div className="lip-section-head">摘要</div>
        <p className={`lip-abstract${paper.abstract ? "" : " lip-abstract-missing"}`}>
          {paper.abstract || "暂无摘要。"}
        </p>
      </div>

      {paper.verdict?.rationale && (
        <div className="lip-section">
          <div className="lip-section-head">AI 相关性理由</div>
          <p className="lip-abstract">{paper.verdict.rationale}</p>
        </div>
      )}

      <div className="lip-section">
        <div className="lip-section-head">标签</div>
        <div className="lip-tags">
          {paper.tags.map((tag) => (
            <span key={tag} className={`lit-tag ${tagColorClass(tag)}`}>{tag}</span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => onTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddTag(); }}
            placeholder="添加标签…"
            className="lip-tag-input"
            aria-label="添加标签"
          />
        </div>
      </div>

      {collections.length > 0 && (
        <div className="lip-section">
          <div className="lip-section-head">分类</div>
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
          <div className="lip-section-head">Edit metadata</div>
          <label>Title<input value={metadataDraft.title} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, title: event.target.value }))} /></label>
          <label>Type
            <select value={metadataDraft.itemType} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, itemType: event.target.value as typeof draft.itemType }))}>
              {METADATA_ITEM_TYPES.map((itemType) => <option key={itemType} value={itemType}>{itemTypeLabel(itemType)}</option>)}
            </select>
          </label>
          <label>Authors <span>(separate with ;)</span><input value={metadataDraft.authors} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, authors: event.target.value }))} /></label>
          <label>Venue<input value={metadataDraft.venue} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, venue: event.target.value }))} /></label>
          <label>Year<input inputMode="numeric" value={metadataDraft.year} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, year: event.target.value }))} /></label>
          <label>Date<input value={metadataDraft.date} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, date: event.target.value }))} /></label>
          <label>Volume<input value={metadataDraft.volume} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, volume: event.target.value }))} /></label>
          <label>Issue<input value={metadataDraft.issue} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, issue: event.target.value }))} /></label>
          <label>Pages<input value={metadataDraft.pages} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, pages: event.target.value }))} /></label>
          <label>Publisher<input value={metadataDraft.publisher} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, publisher: event.target.value }))} /></label>
          <label>Place<input value={metadataDraft.place} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, place: event.target.value }))} /></label>
          <label>Edition<input value={metadataDraft.edition} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, edition: event.target.value }))} /></label>
          <label>Series<input value={metadataDraft.series} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, series: event.target.value }))} /></label>
          <label>Language<input value={metadataDraft.language} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, language: event.target.value }))} /></label>
          <label>Accessed<input value={metadataDraft.accessed} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, accessed: event.target.value }))} /></label>
          <label>DOI<input value={metadataDraft.doi} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, doi: event.target.value }))} /></label>
          <label>ISBN<input value={metadataDraft.isbn} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, isbn: event.target.value }))} /></label>
          <label>Citation key<input value={metadataDraft.citationKey} onChange={(event) => { setMetadataError(null); setMetadataDraft((draft) => ({ ...draft, citationKey: event.target.value })); }} /></label>
          <label>URL<input value={metadataDraft.url} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, url: event.target.value }))} /></label>
          <label>Abstract<textarea rows={5} value={metadataDraft.abstract} onChange={(event) => setMetadataDraft((draft) => ({ ...draft, abstract: event.target.value }))} /></label>
          {metadataError && <p className="lit-error" role="alert">{metadataError}</p>}
          <div className="lip-metadata-editor-actions">
            <button type="button" className="primary" onClick={saveMetadata}>Save metadata</button>
            <button type="button" onClick={() => setMetadataEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="lip-section lip-actions-section">
        <button type="button" className="lit-action-btn" onClick={() => setMetadataEditing((value) => !value)}>{metadataEditing ? "Close editor" : "Edit metadata"}</button>
        <button type="button" className="lit-action-btn" onClick={editCitationKey}>编辑 Citation key</button>
        <button type="button" className="lit-action-btn" onClick={onOpenReader}
                disabled={paper.pdf.status === "downloading"}>
          {paper.pdf.status === "downloaded" ? "打开 PDF"
            : paper.pdf.status === "downloading" ? "下载中…"
            : paper.pdf.url ? "下载 PDF" : "获取 PDF"}
        </button>
        <button type="button" className="lit-action-btn" onClick={onViewOverview}>简报</button>
        <button type="button" className="lit-action-btn" onClick={onViewEvidence}>查看证据</button>
        <button type="button" className="lit-action-btn" onClick={onAsk}>问 Agent</button>
        {paper.stage !== "shortlist" && paper.stage !== "downloaded" && paper.stage !== "read" && (
          <button type="button" className="lit-action-btn starred" onClick={onShortlist}>加入候选</button>
        )}
        <button type="button" className="lit-action-btn danger" onClick={onDelete}>删除</button>
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

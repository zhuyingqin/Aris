import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { useLiteratureStore } from "./literatureStore";
import {
  type DetailTab,
  type LiteraturePaper,
  type PaperFit,
  type PaperStage,
} from "./literatureTypes";
import "./Literature.css";

type SortKey = "added" | "fit" | "year" | "title" | "citations";

const TAG_COLORS = ["amber", "blue", "green", "purple", "accent"];
function tagColorClass(tag: string): string {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) & 0xffff;
  return `lit-tag-${TAG_COLORS[hash % TAG_COLORS.length]}`;
}

const STAGE_ICONS: Record<PaperStage, string> = {
  inbox: "✉",
  screened: "⏱",
  shortlist: "★",
  downloaded: "↓",
  read: "✓",
  excluded: "⊘",
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

function formatAuthors(authors: string[]) {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────

export default function Literature() {
  const currentProject = useStore((s) => s.currentProject);
  const setTab = useStore((s) => s.setTab);
  const setPendingChatInput = useStore((s) => s.setPendingChatInput);
  const library = useLiteratureStore((s) => s.library);
  const loaded = useLiteratureStore((s) => s.loaded);
  const briefing = useLiteratureStore((s) => s.briefing);
  const storeError = useLiteratureStore((s) => s.error);
  const load = useLiteratureStore((s) => s.load);
  const watchAgentActivity = useLiteratureStore((s) => s.watchAgentActivity);
  const setStage = useLiteratureStore((s) => s.setStage);
  const deletePapers = useLiteratureStore((s) => s.deletePapers);
  const toggleStar = useLiteratureStore((s) => s.toggleStar);
  const markRead = useLiteratureStore((s) => s.markRead);
  const addTags = useLiteratureStore((s) => s.addTags);
  const addCollection = useLiteratureStore((s) => s.addCollection);
  const removeCollection = useLiteratureStore((s) => s.removeCollection);
  const generateBrief = useLiteratureStore((s) => s.generateBrief);
  const downloadPdf = useLiteratureStore((s) => s.downloadPdf);
  const setError = useLiteratureStore((s) => s.setError);

  const [view, setView] = useState("all");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("added");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<DetailTab>("overview");
  const [tagDraft, setTagDraft] = useState("");
  const [abstractOpen, setAbstractOpen] = useState(false);
  const [colInput, setColInput] = useState("");
  const [colAdding, setColAdding] = useState(false);

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  useEffect(() => watchAgentActivity(), [watchAgentActivity]);

  const papers = library.papers;

  const visiblePapers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return sortPapers(
      papers.filter((p) => matchesView(p, view) && matchesQuery(p, needle)),
      sort,
    );
  }, [filter, papers, sort, view]);

  const selectedPaper =
    visiblePapers.find((p) => p.id === selectedId) ?? visiblePapers[0] ?? null;

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

  const selectPaper = (paper: LiteraturePaper) => {
    setSelectedId(paper.id);
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
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
  };

  const addTagToSelected = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (!tag || !selectedPaper) return;
    addTags([selectedPaper.id], [tag]);
    setTagDraft("");
  };

  // ── Sidebar ────────────────────────────────────────────────────────────────

  const submitColInput = () => {
    const trimmed = colInput.trim();
    if (trimmed) addCollection(trimmed);
    setColInput("");
    setColAdding(false);
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
          icon="☰"
          count={papers.filter((p) => p.stage !== "excluded").length}
          active={view === "all"}
          onClick={() => setView("all")}
        />
        <NavItem
          label="已收藏"
          icon="☆"
          count={papers.filter((p) => p.starred).length}
          active={view === "starred"}
          onClick={() => setView("starred")}
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
            onClick={() => setColAdding(true)}
            title="新建分类"
          >+</button>
        }
      >
        {colAdding && (
          <div className="lit-col-input-row">
            <input
              autoFocus
              className="lit-col-input"
              value={colInput}
              placeholder="分类名称…"
              onChange={(e) => setColInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitColInput();
                if (e.key === "Escape") { setColInput(""); setColAdding(false); }
              }}
            />
            <button type="button" className="lit-col-confirm-btn" onClick={submitColInput} title="确认">✓</button>
            <button type="button" className="lit-col-cancel-btn" onClick={() => { setColInput(""); setColAdding(false); }} title="取消">✕</button>
          </div>
        )}
        {library.collections.map((col) => (
          <div key={col.id} className="lit-col-row">
            <NavItem
              label={col.label}
              icon="▤"
              count={papers.filter((p) => p.collectionIds.includes(col.id)).length}
              active={view === `col:${col.id}`}
              onClick={() => setView(`col:${col.id}`)}
            />
            <button
              type="button"
              className="lit-col-delete-btn"
              onClick={() => {
                if (window.confirm(`删除分类"${col.label}"？（论文不会被删除）`)) {
                  removeCollection(col.id);
                  if (view === `col:${col.id}`) setView("all");
                }
              }}
              aria-label={`删除 ${col.label}`}
            >×</button>
          </div>
        ))}
        {library.collections.length === 0 && !colAdding && (
          <div className="lit-col-empty">暂无分类</div>
        )}
      </NavSection>

    </aside>
  );

  // ── Main area ──────────────────────────────────────────────────────────────

  const viewLabel = (() => {
    if (view === "all") return "全部论文";
    if (view === "starred") return "已收藏";
    if (view.startsWith("stage:")) return STAGE_LABELS[view.slice(6) as PaperStage] ?? "论文";
    if (view.startsWith("col:")) {
      const col = library.collections.find((c) => `col:${c.id}` === view);
      return col?.label ?? "分类";
    }
    return "论文";
  })();

  const mainArea = (
    <div className="lit-main">
      <PaperList
        papers={visiblePapers}
        libraryCount={papers.length}
        loaded={loaded}
        filter={filter}
        sort={sort}
        checked={checked}
        selectedId={selectedPaper?.id ?? null}
        viewLabel={viewLabel}
        onFilterChange={setFilter}
        onSortChange={setSort}
        onSelectPaper={selectPaper}
        onToggleChecked={toggleChecked}
        onToggleStar={toggleStar}
        onBrief={(p) => { selectPaper(p); setWorkspaceTab("overview"); }}
        onPdf={downloadPdf}
        onAsk={(p) => openAgentChat(`/research-lit "${p.title}"`)}
        onShortlist={(p) => setStage([p.id], "shortlist")}
        onExclude={(p) => setStage([p.id], "excluded")}
        batchIds={batchIds}
        onBatchShortlist={() => runBatch((ids) => setStage(ids, "shortlist"))}
        onBatchExclude={() => runBatch((ids) => setStage(ids, "excluded"))}
        onBatchDownload={() => runBatch((ids) => { for (const id of ids) void downloadPdf(id); })}
        onBatchDelete={() => confirmDeletePapers(batchIds)}
        onBatchClear={() => setChecked(new Set())}
      />
    </div>
  );

  // ── Workspace ──────────────────────────────────────────────────────────────

  const workspace = (
    <section className="lit-workspace">
      <div className="lit-workspace-header">
        <span className="lit-workspace-title">Paper Workspace</span>
        <div className="lit-workspace-header-btns">
          <button
            type="button"
            className="lit-workspace-icon-btn"
            title="Open in chat"
            onClick={() => selectedPaper && openAgentChat(`/research-lit "${selectedPaper.title}"`)}
            disabled={!selectedPaper}
          >
            ↗
          </button>
          <button
            type="button"
            className="lit-workspace-icon-btn"
            title="Clear selection"
            onClick={() => setSelectedId(null)}
            disabled={!selectedPaper}
          >
            ✕
          </button>
        </div>
      </div>

      {selectedPaper ? (
        <>
          <div className="lit-workspace-meta">
            <div className="lit-workspace-paper-title">{selectedPaper.title}</div>
            <div className="lit-workspace-paper-sub">
              {formatAuthors(selectedPaper.authors)}
              {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
              {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
            </div>
          </div>

          <div className="lit-workspace-tabs" role="tablist">
            {(
              [
                { id: "overview", label: "概览" },
                { id: "notes", label: "笔记" },
                { id: "evidence", label: "证据" },
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
            {workspaceTab === "overview" && (
              <WorkspaceOverview
                paper={selectedPaper}
                briefing={briefing === selectedPaper.id}
                abstractOpen={abstractOpen}
                onToggleAbstract={() => setAbstractOpen((v) => !v)}
                onGenerateBrief={generateBrief}
                onShortlist={() => setStage([selectedPaper.id], "shortlist")}
                onDownload={() => void downloadPdf(selectedPaper.id)}
                onAsk={() => openAgentChat(`/research-lit "${selectedPaper.title}"`)}
                onViewEvidence={() => setWorkspaceTab("evidence")}
                onDelete={() => {
                  if (window.confirm(`Delete "${selectedPaper.title}" from your library?`)) {
                    deletePapers([selectedPaper.id]);
                  }
                }}
              />
            )}
            {workspaceTab === "notes" && (
              <WorkspaceNotes paper={selectedPaper} />
            )}
            {workspaceTab === "evidence" && (
              <WorkspaceEvidence paper={selectedPaper} />
            )}
            {workspaceTab === "files" && (
              <WorkspaceFiles
                paper={selectedPaper}
                tagDraft={tagDraft}
                onTagDraft={setTagDraft}
                onAddTag={addTagToSelected}
                onDownload={downloadPdf}
              />
            )}
          </div>
        </>
      ) : (
        <div className="lit-workspace-empty">
          <div className="lit-workspace-empty-icon">◫</div>
          <p>Select a paper to open it here.</p>
        </div>
      )}
    </section>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="lit-page">
      {/* Header */}
      <header className="lit-header">
        <div className="lit-header-title">
          <div className="lit-header-name">Literature Workflow</div>
          <div className="lit-header-sub">Screen, understand, and convert papers into evidence.</div>
        </div>

        <div className="lit-workspace-label">
          {currentProject ? currentProject.name : "ARIS Desktop Workspace"}
          <span className="lit-workspace-caret">▾</span>
        </div>
      </header>

      {/* Error banner */}
      {storeError && (
        <div className="lit-error-banner" role="status">
          <span>{storeError}</span>
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="lit-body">
        {sidebar}
        {mainArea}
        {workspace}
      </div>

      <ActivityDrawer />

      <div className="lit-footer">
        <span>
          {papers.length} {papers.length === 1 ? "paper" : "papers"} · {downloadedCount}{" "}
          {downloadedCount === 1 ? "PDF" : "PDFs"}
        </span>
        <span className="lit-footer-path">
          {currentProject ? `${currentProject.name} · papers/library.json` : "papers/library.json"}
        </span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Paper list
// ──────────────────────────────────────────────────────────────────────────────

function PaperList({
  papers,
  libraryCount,
  loaded,
  filter,
  sort,
  checked,
  selectedId,
  viewLabel,
  onFilterChange,
  onSortChange,
  onSelectPaper,
  onToggleChecked,
  onToggleStar,
  onBrief,
  onPdf,
  onAsk,
  onShortlist,
  onExclude,
  batchIds,
  onBatchShortlist,
  onBatchExclude,
  onBatchDownload,
  onBatchDelete,
  onBatchClear,
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
  onSortChange: (v: SortKey) => void;
  onSelectPaper: (p: LiteraturePaper) => void;
  onToggleChecked: (id: string) => void;
  onToggleStar: (id: string) => void;
  onBrief: (p: LiteraturePaper) => void;
  onPdf: (id: string) => Promise<void>;
  onAsk: (p: LiteraturePaper) => void;
  onShortlist: (p: LiteraturePaper) => void;
  onExclude: (p: LiteraturePaper) => void;
  batchIds: string[];
  onBatchShortlist: () => void;
  onBatchExclude: () => void;
  onBatchDownload: () => void;
  onBatchDelete: () => void;
  onBatchClear: () => void;
}) {
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

      <div className="lit-card-list">
        {loaded && libraryCount === 0 && (
          <div className="lit-empty-state">
            <p>论文库为空。</p>
            <p className="dim">通过 Chat 中的 Agent 导入论文。</p>
          </div>
        )}
        {loaded && libraryCount > 0 && papers.length === 0 && (
          <div className="lit-empty-state">
            <p className="dim">没有符合当前筛选条件的论文。</p>
          </div>
        )}
        {papers.map((paper) => (
          <PaperCard
            key={paper.id}
            paper={paper}
            selected={selectedId === paper.id}
            checked={checked.has(paper.id)}
            onSelect={() => onSelectPaper(paper)}
            onToggleChecked={() => onToggleChecked(paper.id)}
            onToggleStar={() => onToggleStar(paper.id)}
            onBrief={() => onBrief(paper)}
            onPdf={() => void onPdf(paper.id)}
            onAsk={() => onAsk(paper)}
            onShortlist={() => onShortlist(paper)}
            onExclude={() => onExclude(paper)}
          />
        ))}
      </div>

      {batchIds.length > 0 && (
        <div className="lit-batch-bar" role="toolbar" aria-label="Batch actions">
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
// Paper card
// ──────────────────────────────────────────────────────────────────────────────

function PaperCard({
  paper,
  selected,
  checked,
  onSelect,
  onToggleChecked,
  onToggleStar,
  onBrief,
  onPdf,
  onAsk,
  onShortlist,
  onExclude,
}: {
  paper: LiteraturePaper;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onToggleChecked: () => void;
  onToggleStar: () => void;
  onBrief: () => void;
  onPdf: () => void;
  onAsk: () => void;
  onShortlist: () => void;
  onExclude: () => void;
}) {
  const whyRelevant = paper.verdict?.rationale || paper.agentSummary;

  return (
    <div
      className={`lit-card${selected ? " active" : ""}${paper.stage === "excluded" ? " excluded" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      role="button"
      tabIndex={0}
    >
      <input
        type="checkbox"
        className="lit-card-check"
        checked={checked}
        aria-label={`Select ${paper.title}`}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleChecked}
      />

      <div className="lit-card-body">
        <div className="lit-card-title-row">
          <div className={`lit-card-title${paper.unread ? " unread" : ""}`}>
            {paper.title}
          </div>
          <button
            type="button"
            className={`lit-card-star${paper.starred ? " starred" : ""}`}
            onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
            aria-label={paper.starred ? "Unstar" : "Star"}
          >
            {paper.starred ? "★" : "☆"}
          </button>
        </div>

        <div className="lit-card-meta">
          {formatAuthors(paper.authors)}
          {paper.year ? ` · ${paper.year}` : ""}
          {paper.venue ? ` · ${paper.venue}` : ""}
          {paper.pdf.status === "downloaded" && (
            <span className="lit-pdf-badge" title={paper.pdf.path}>PDF</span>
          )}
        </div>

        {whyRelevant && (
          <div className="lit-card-why">
            <span className="lit-card-why-label">Why relevant: </span>
            {whyRelevant.length > 150 ? `${whyRelevant.slice(0, 150)}…` : whyRelevant}
          </div>
        )}

        {paper.tags.length > 0 && (
          <div className="lit-card-tags">
            {paper.tags.slice(0, 5).map((tag) => (
              <span key={tag} className={`lit-tag ${tagColorClass(tag)}`}>
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="lit-card-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="lit-card-btn" onClick={onBrief}>
            ◫ Brief
          </button>
          <button
            type="button"
            className="lit-card-btn"
            onClick={onPdf}
            disabled={paper.pdf.status === "downloading"}
          >
            ⬇ PDF
          </button>
          <button type="button" className="lit-card-btn" onClick={onAsk}>
            ✦ Ask
          </button>
          {paper.stage !== "shortlist" && paper.stage !== "downloaded" && paper.stage !== "read" && (
            <button type="button" className="lit-card-btn" onClick={onShortlist}>
              ☆ Shortlist
            </button>
          )}
          {paper.stage !== "excluded" && (
            <button type="button" className="lit-card-btn danger" onClick={onExclude}>
              ⊘ Exclude
            </button>
          )}
        </div>
      </div>
    </div>
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
      {paper.abstract && (
        <div className="lit-section">
          <button type="button" className="lit-abstract-toggle" onClick={onToggleAbstract}>
            <div className="lit-section-heading">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="3" width="12" height="1.5" rx=".75" fill="currentColor" />
                <rect x="2" y="7" width="10" height="1.5" rx=".75" fill="currentColor" />
                <rect x="2" y="11" width="8" height="1.5" rx=".75" fill="currentColor" />
              </svg>
              <span>摘要</span>
            </div>
            <span className="lit-toggle-caret" aria-hidden="true">{abstractOpen ? "▾" : "▸"}</span>
          </button>
          {abstractOpen && (
            <p className="lit-abstract-text">{paper.abstract}</p>
          )}
        </div>
      )}

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
          <BriefColumns brief={paper.brief} />
        ) : (
          <div className="lit-brief-generate">
            <p>暂无简报 — {paper.pdf.status === "downloaded" ? "PDF 已下载" : "仅有摘要"}。</p>
            <button
              type="button"
              className="primary"
              onClick={() => onGenerateBrief(paper.id)}
              disabled={briefing}
            >
              {briefing ? "读取中…" : paper.pdf.status === "downloaded" ? "从全文生成简报" : "从摘要生成简报"}
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
            aria-label="下载 PDF"
            onClick={onDownload}
            disabled={paper.pdf.status === "downloaded" || paper.pdf.status === "downloading" || !paper.pdf.url}
            title={paper.pdf.status === "downloaded" ? paper.pdf.path : undefined}
          >
            {paper.pdf.status === "downloaded" ? "PDF 已保存" : paper.pdf.status === "downloading" ? "下载中…" : "下载 PDF"}
          </button>
          <button type="button" className="lit-action-btn" aria-label="问 Agent" onClick={onAsk}>
            问 Agent
          </button>
          <button type="button" className="lit-action-btn" onClick={onViewEvidence}>
            提取证据
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

const BRIEF_COLS: Array<{ key: "problem" | "method" | "results" | "limits"; label: string; cls: string }> = [
  { key: "problem", label: "问题", cls: "brief-col-problem" },
  { key: "method", label: "方法", cls: "brief-col-method" },
  { key: "results", label: "结果", cls: "brief-col-results" },
  { key: "limits", label: "局限性", cls: "brief-col-limits" },
];

function BriefColumns({ brief }: { brief: NonNullable<LiteraturePaper["brief"]> }) {
  return (
    <div className="lit-brief lit-brief-cols">
      {BRIEF_COLS.map(({ key, label, cls }) => {
        const section = brief[key];
        return (
          <div key={key} className={`lit-brief-col ${cls}`}>
            <div className="lit-brief-col-header">
              {label}
              {" "}
              <span className={`lit-src src-${section.source}`}>[{section.source}]</span>
            </div>
            <div className="lit-brief-col-body">{section.text}</div>
          </div>
        );
      })}
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Notes tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceNotes({ paper }: { paper: LiteraturePaper }) {
  return (
    <div className="lit-workspace-scroll">
      {paper.verdict && (
        <div className="lit-section">
          <div className="lit-section-heading">
            <span>Agent 判断</span>
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
        <div className="lit-workspace-empty-content">暂无笔记。</div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Workspace — Evidence tab
// ──────────────────────────────────────────────────────────────────────────────

function WorkspaceEvidence({ paper }: { paper: LiteraturePaper }) {
  return (
    <div className="lit-workspace-scroll">
      {paper.evidence.length === 0 ? (
        <div className="lit-workspace-empty-content">
          暂无提取的证据。Agent 读取 PDF 后，引文将以页码锚点显示在此。
        </div>
      ) : (
        paper.evidence.map((item) => (
          <div className="lit-section lit-evidence-item" key={item.id}>
            <div className="lit-evidence-page-label">第 {item.page} 页</div>
            <blockquote className="lit-evidence-quote">"{item.quote}"</blockquote>
            <p className="lit-evidence-note">{item.note}</p>
          </div>
        ))
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
}: {
  paper: LiteraturePaper;
  tagDraft: string;
  onTagDraft: (v: string) => void;
  onAddTag: () => void;
  onDownload: (id: string) => Promise<void>;
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
        {paper.pdf.status !== "downloaded" && paper.pdf.url && (
          <button type="button" className="primary" onClick={() => void onDownload(paper.id)}
            disabled={paper.pdf.status === "downloading"}>
            {paper.pdf.status === "downloading" ? "下载中…" : paper.pdf.status === "failed" ? "重试下载" : "下载 PDF"}
          </button>
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
        <span className="lit-activity-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
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
  icon: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: PaperStage;
}) {
  return (
    <button type="button" className={`lit-nav-item${active ? " active" : ""}`} onClick={onClick}>
      <span className="lit-nav-icon" aria-hidden="true">
        {dot ? <span className={`lit-stage-dot ${dot}`} /> : icon}
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
          <span className="lit-section-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { useLiteratureStore } from "./literatureStore";
import type {
  DetailTab,
  LiteraturePaper,
  LiteratureReviewTask,
  PaperFit,
  PaperScreening,
  PaperStage,
  ScreeningCriterion,
  ScreeningDecision,
} from "./literatureTypes";
import "./Literature.css";

/** Optional Chat handoff. Literature owns search/save; Chat owns deeper reading. */
const AGENT_SKILLS: Array<{ id: string; label: string; command: (query: string) => string }> = [
  {
    id: "arxiv",
    label: "/arxiv search",
    command: (query) => `/arxiv "${query}" - max: 20`,
  },
  {
    id: "research-lit",
    label: "/research-lit review",
    command: (query) => `/research-lit "${query}"`,
  },
];

const QUICK_SOURCES = ["arxiv", "crossref"];

/** Stages in the left nav. Later stages only appear once they have papers,
 * so the nav stays short while the workflow is young. */
const STAGES: Array<{ id: PaperStage; label: string; alwaysVisible: boolean }> = [
  { id: "inbox", label: "Inbox", alwaysVisible: true },
  { id: "screened", label: "Screened", alwaysVisible: false },
  { id: "shortlist", label: "Shortlist", alwaysVisible: true },
  { id: "downloaded", label: "Downloaded", alwaysVisible: true },
  { id: "read", label: "Agent read", alwaysVisible: false },
  { id: "excluded", label: "Excluded", alwaysVisible: false },
];

const STAGE_LABELS: Record<PaperStage, string> = Object.fromEntries(
  STAGES.map((stage) => [stage.id, stage.label]),
) as Record<PaperStage, string>;

const FIT_LABELS: Record<PaperFit, string> = {
  high: "High fit",
  medium: "Medium fit",
  low: "Low fit",
};

const DECISION_LABELS: Record<ScreeningDecision, string> = {
  include: "Include",
  exclude: "Exclude",
  maybe: "Maybe",
};

type SortKey = "added" | "fit" | "year" | "title" | "citations";

const EXAMPLE_QUERIES = [
  "agentic literature review",
  "retrieval augmented generation survey",
  "LLM PDF reading evidence",
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

function paperBelongsToTask(paper: LiteraturePaper, task: LiteratureReviewTask) {
  return (
    task.searchIds.length === 0 ||
    task.searchIds.some((searchId) => paper.searchIds.includes(searchId)) ||
    Boolean(paper.screenings?.[task.id])
  );
}

/** Least-confident, unreviewed papers first — that is where human attention
 * is worth the most. Confirmed papers drop to the end. */
function sortQueuePapers(papers: LiteraturePaper[], taskId: string) {
  return [...papers].sort((a, b) => {
    const aScreening = a.screenings?.[taskId];
    const bScreening = b.screenings?.[taskId];
    const aConfirmed = aScreening?.userConfirmed ? 1 : 0;
    const bConfirmed = bScreening?.userConfirmed ? 1 : 0;
    if (aConfirmed !== bConfirmed) return aConfirmed - bConfirmed;
    return (aScreening?.confidence ?? 0) - (bScreening?.confidence ?? 0);
  });
}

function scoreFit(score: number): PaperFit {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function isTypingTarget(target: EventTarget | null) {
  const tag = target instanceof HTMLElement ? target.tagName : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function criterionKind(task: LiteratureReviewTask, criteriaId?: string) {
  return task.criteria.find((criterion) => criterion.id === criteriaId)?.kind;
}

export default function Literature() {
  const currentProject = useStore((s) => s.currentProject);
  const setTab = useStore((s) => s.setTab);
  const setPendingChatInput = useStore((s) => s.setPendingChatInput);
  const library = useLiteratureStore((s) => s.library);
  const loaded = useLiteratureStore((s) => s.loaded);
  const searching = useLiteratureStore((s) => s.searching);
  const lastSearch = useLiteratureStore((s) => s.lastSearch);
  const storeError = useLiteratureStore((s) => s.error);
  const activeReviewTaskId = useLiteratureStore((s) => s.activeReviewTaskId);
  const load = useLiteratureStore((s) => s.load);
  const watchAgentActivity = useLiteratureStore((s) => s.watchAgentActivity);
  const runSearch = useLiteratureStore((s) => s.runSearch);
  const setActiveReviewTask = useLiteratureStore((s) => s.setActiveReviewTask);
  const updateReviewQuestion = useLiteratureStore((s) => s.updateReviewQuestion);
  const updateCriterion = useLiteratureStore((s) => s.updateCriterion);
  const addCriterion = useLiteratureStore((s) => s.addCriterion);
  const removeCriterion = useLiteratureStore((s) => s.removeCriterion);
  const screenPapersForTask = useLiteratureStore((s) => s.screenPapersForTask);
  const confirmScreening = useLiteratureStore((s) => s.confirmScreening);
  const flipScreening = useLiteratureStore((s) => s.flipScreening);
  const decideScreening = useLiteratureStore((s) => s.decideScreening);
  const acceptCriteriaSuggestion = useLiteratureStore((s) => s.acceptCriteriaSuggestion);
  const dismissCriteriaSuggestion = useLiteratureStore((s) => s.dismissCriteriaSuggestion);
  const setStage = useLiteratureStore((s) => s.setStage);
  const toggleStar = useLiteratureStore((s) => s.toggleStar);
  const markRead = useLiteratureStore((s) => s.markRead);
  const addTags = useLiteratureStore((s) => s.addTags);
  const downloadPdf = useLiteratureStore((s) => s.downloadPdf);
  const setError = useLiteratureStore((s) => s.setError);

  const [draftQuery, setDraftQuery] = useState("");
  const [agentSkill, setAgentSkill] = useState(AGENT_SKILLS[0].id);
  const [view, setView] = useState("all");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("added");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("metadata");
  const [tagDraft, setTagDraft] = useState("");
  const [queueMode, setQueueMode] = useState(false);
  const [queueIndex, setQueueIndex] = useState(0);
  const [showFullAbstract, setShowFullAbstract] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  // Pick up library changes written by literature skills running in Chat.
  useEffect(() => watchAgentActivity(), [watchAgentActivity]);

  // Jump to the freshly created saved search after a remote search lands.
  const lastSearchId = lastSearch?.searchId ?? null;
  useEffect(() => {
    if (lastSearchId) setView(`search:${lastSearchId}`);
  }, [lastSearchId]);

  const papers = library.papers;
  const activeReviewTask =
    library.reviewTasks.find((task) => task.id === activeReviewTaskId) ??
    library.reviewTasks[0] ??
    null;

  const taskPapers = useMemo(
    () =>
      activeReviewTask
        ? papers.filter((paper) => paperBelongsToTask(paper, activeReviewTask))
        : [],
    [activeReviewTask, papers],
  );

  const queuePapers = useMemo(
    () =>
      activeReviewTask
        ? sortQueuePapers(
            taskPapers.filter(
              (paper) => !paper.screenings?.[activeReviewTask.id]?.userConfirmed,
            ),
            activeReviewTask.id,
          )
        : [],
    [activeReviewTask, taskPapers],
  );

  const taskId = activeReviewTask?.id;
  const reviewedTaskCount = activeReviewTask
    ? taskPapers.filter((paper) => paper.screenings?.[activeReviewTask.id]?.userConfirmed)
        .length
    : 0;
  const flippedTaskCount = activeReviewTask
    ? taskPapers.filter((paper) => paper.screenings?.[activeReviewTask.id]?.flippedFrom).length
    : 0;
  const decisionCounts = useMemo(() => {
    const counts = { include: 0, exclude: 0, maybe: 0 };
    if (!taskId) return counts;
    for (const paper of taskPapers) {
      const screening = paper.screenings?.[taskId];
      if (screening?.userConfirmed) counts[screening.decision] += 1;
    }
    return counts;
  }, [taskId, taskPapers]);

  const safeQueueIndex = queuePapers.length
    ? Math.min(queueIndex, queuePapers.length - 1)
    : 0;
  const queuePaper = queueMode ? queuePapers[safeQueueIndex] ?? null : null;

  const visiblePapers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return sortPapers(
      papers.filter((paper) => matchesView(paper, view) && matchesQuery(paper, needle)),
      sort,
    );
  }, [filter, papers, sort, view]);

  const selectedPaper =
    visiblePapers.find((paper) => paper.id === selectedId) ?? visiblePapers[0] ?? null;
  const selectedScreening =
    selectedPaper && activeReviewTask
      ? selectedPaper.screenings?.[activeReviewTask.id]
      : undefined;

  const stageCounts = useMemo(() => {
    const counts = new Map<PaperStage, number>();
    for (const paper of papers) {
      counts.set(paper.stage, (counts.get(paper.stage) ?? 0) + 1);
    }
    return counts;
  }, [papers]);

  const allTags = useMemo(
    () => Array.from(new Set(papers.flatMap((paper) => paper.tags))).sort(),
    [papers],
  );

  const downloadedCount = useMemo(
    () => papers.filter((paper) => paper.pdf.status === "downloaded").length,
    [papers],
  );

  const pendingScreenCount = activeReviewTask
    ? taskPapers.filter((paper) => !paper.screenings?.[activeReviewTask.id]).length
    : 0;

  const openAgentChat = (input: string) => {
    setPendingChatInput(input);
    setTab("chat");
  };

  const submitAgentSearch = () => {
    const trimmed = draftQuery.trim();
    if (!trimmed) return;
    const skill = AGENT_SKILLS.find((entry) => entry.id === agentSkill) ?? AGENT_SKILLS[0];
    openAgentChat(skill.command(trimmed));
  };

  const submitQuickSearch = () => {
    if (!draftQuery.trim() || searching) return;
    void runSearch(draftQuery, QUICK_SOURCES);
  };

  const askAgentAboutPaper = (paper: LiteraturePaper) => {
    openAgentChat(`/research-lit "${paper.title}"`);
  };

  const selectPaper = (paper: LiteraturePaper) => {
    setSelectedId(paper.id);
    if (paper.unread) markRead(paper.id);
  };

  const toggleChecked = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
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

  const addTagToSelected = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (!tag || !selectedPaper) return;
    addTags([selectedPaper.id], [tag]);
    setTagDraft("");
  };

  const enterReview = () => {
    if (!activeReviewTask || taskPapers.length === 0) return;
    if (pendingScreenCount > 0) {
      screenPapersForTask(
        activeReviewTask.id,
        taskPapers.map((paper) => paper.id),
      );
    }
    setQueueIndex(0);
    setCriteriaOpen(false);
    setQueueMode(true);
  };

  const reScreen = () => {
    if (!activeReviewTask) return;
    screenPapersForTask(
      activeReviewTask.id,
      taskPapers.map((paper) => paper.id),
    );
    setQueueIndex(0);
  };

  const acceptQueuePaper = () => {
    if (!taskId || !queuePaper?.screenings?.[taskId]) return;
    confirmScreening(queuePaper.id, taskId);
  };
  const flipQueuePaper = () => {
    if (!taskId || !queuePaper) return;
    flipScreening(queuePaper.id, taskId);
  };
  const decideQueuePaper = (decision: ScreeningDecision) => {
    if (!taskId || !queuePaper) return;
    decideScreening(queuePaper.id, taskId, decision);
  };
  const starQueuePaper = () => {
    if (!queuePaper) return;
    toggleStar(queuePaper.id);
  };
  const downloadIncluded = () => {
    if (!taskId) return;
    for (const paper of taskPapers) {
      const screening = paper.screenings?.[taskId];
      if (
        screening?.decision === "include" &&
        paper.pdf.url &&
        paper.pdf.status !== "downloaded" &&
        paper.pdf.status !== "downloading"
      ) {
        void downloadPdf(paper.id);
      }
    }
  };

  useEffect(() => {
    setShowFullAbstract(false);
  }, [queuePaper?.id]);

  // Keyboard-driven triage — the speed multiplier for the review queue.
  useEffect(() => {
    if (!queueMode || !taskId) return undefined;
    const paper = queuePaper;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        event.preventDefault();
        setQueueMode(false);
        return;
      }
      if (!paper) return;
      switch (key) {
        case "a":
          event.preventDefault();
          if (paper.screenings?.[taskId]) confirmScreening(paper.id, taskId);
          break;
        case "f":
          event.preventDefault();
          flipScreening(paper.id, taskId);
          break;
        case "i":
          event.preventDefault();
          decideScreening(paper.id, taskId, "include");
          break;
        case "x":
          event.preventDefault();
          decideScreening(paper.id, taskId, "exclude");
          break;
        case "m":
          event.preventDefault();
          decideScreening(paper.id, taskId, "maybe");
          break;
        case "s":
          event.preventDefault();
          toggleStar(paper.id);
          break;
        case " ":
          event.preventDefault();
          setShowFullAbstract((value) => !value);
          break;
        case "j":
          event.preventDefault();
          setQueueIndex((index) => Math.min(index + 1, queuePapers.length - 1));
          break;
        case "k":
          event.preventDefault();
          setQueueIndex((index) => Math.max(index - 1, 0));
          break;
        default:
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setQueueIndex((index) => Math.min(index + 1, queuePapers.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setQueueIndex((index) => Math.max(index - 1, 0));
          }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    queueMode,
    taskId,
    queuePaper,
    queuePapers.length,
    confirmScreening,
    flipScreening,
    decideScreening,
    toggleStar,
  ]);

  const navAside = (
    <aside className="lit-nav">
      <div className="lit-nav-section">
        <div className="panel-title">Library</div>
        <NavItem
          label="All papers"
          count={papers.filter((paper) => paper.stage !== "excluded").length}
          active={view === "all"}
          onClick={() => setView("all")}
        />
        <NavItem
          label="Starred"
          count={papers.filter((paper) => paper.starred).length}
          active={view === "starred"}
          onClick={() => setView("starred")}
        />
        {STAGES.filter(
          (stage) => stage.alwaysVisible || (stageCounts.get(stage.id) ?? 0) > 0,
        ).map((stage) => (
          <NavItem
            key={stage.id}
            label={stage.label}
            dot={stage.id}
            count={stageCounts.get(stage.id) ?? 0}
            active={view === `stage:${stage.id}`}
            onClick={() => setView(`stage:${stage.id}`)}
          />
        ))}
      </div>

      {library.searches.length > 0 && (
        <NavSection title="Saved searches" defaultOpen>
          {library.searches.slice(0, 5).map((search) => (
            <div className="lit-search-row" key={search.id}>
              <NavItem
                label={search.query}
                count={papers.filter((paper) => paper.searchIds.includes(search.id)).length}
                active={view === `search:${search.id}`}
                onClick={() => setView(`search:${search.id}`)}
              />
              <button
                type="button"
                className="lit-rerun"
                title={`Re-run "${search.query}"`}
                aria-label={`Re-run search ${search.query}`}
                onClick={() => void runSearch(search.query, search.sources)}
              >
                ↻
              </button>
            </div>
          ))}
        </NavSection>
      )}

      {library.collections.length > 0 && (
        <NavSection title="Collections" defaultOpen>
          {library.collections.map((collection) => (
            <NavItem
              key={collection.id}
              label={collection.label}
              count={papers.filter((paper) => paper.collectionIds.includes(collection.id)).length}
              active={view === `col:${collection.id}`}
              onClick={() => setView(`col:${collection.id}`)}
            />
          ))}
        </NavSection>
      )}

      {allTags.length > 0 && (
        <NavSection title="Tags" defaultOpen={false}>
          <div className="lit-tags">
            {allTags.map((tag) => (
              <button
                type="button"
                key={tag}
                className="lit-chip"
                onClick={() => setFilter(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </NavSection>
      )}
    </aside>
  );

  return (
    <div className="lit-page">
      <div className="lit-omnibar">
        <input
          className="lit-omnibar-input"
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (event.ctrlKey || event.metaKey) submitAgentSearch();
            else submitQuickSearch();
          }}
          placeholder="Search the literature..."
          aria-label="Remote search query"
        />
        <button
          type="button"
          className="primary"
          onClick={submitQuickSearch}
          disabled={searching || !draftQuery.trim()}
          title="Search arXiv + Crossref and save results to this library"
        >
          {searching ? "Searching..." : "Search & save"}
        </button>
        <select
          className="lit-skill-select"
          value={agentSkill}
          onChange={(event) => setAgentSkill(event.target.value)}
          aria-label="Literature skill"
        >
          {AGENT_SKILLS.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={submitAgentSearch}
          disabled={!draftQuery.trim()}
          title="Open Chat with the selected literature skill"
        >
          Open in Chat
        </button>
      </div>

      {(lastSearch || storeError) && (
        <div className={`lit-status${storeError ? " error" : ""}`} role="status">
          {storeError ? (
            <>
              <span>{storeError}</span>
              <button type="button" onClick={() => setError(null)}>
                dismiss
              </button>
            </>
          ) : (
            lastSearch && (
              <span>
                {lastSearch.resultCount} results / {lastSearch.newCount} saved to Inbox
                {lastSearch.warnings.length > 0 && ` / ${lastSearch.warnings.join(" / ")}`}
              </span>
            )
          )}
        </div>
      )}

      {!queueMode && activeReviewTask && taskPapers.length > 0 && (
        <ReviewCta
          tasks={library.reviewTasks}
          activeTask={activeReviewTask}
          pendingReview={queuePapers.length}
          reviewedCount={reviewedTaskCount}
          totalCount={taskPapers.length}
          onSelectTask={setActiveReviewTask}
          onStart={enterReview}
        />
      )}

      {queueMode && activeReviewTask ? (
        <div className="lit-body review">
          {navAside}
          <ReviewMode
            task={activeReviewTask}
            paper={queuePaper}
            index={safeQueueIndex}
            pendingCount={queuePapers.length}
            totalCount={taskPapers.length}
            reviewedCount={reviewedTaskCount}
            flippedCount={flippedTaskCount}
            decisionCounts={decisionCounts}
            pendingScreenCount={pendingScreenCount}
            criteriaOpen={criteriaOpen}
            showFullAbstract={showFullAbstract}
            onToggleCriteria={() => setCriteriaOpen((value) => !value)}
            onQuestionChange={updateReviewQuestion}
            onCriterionChange={updateCriterion}
            onAddCriterion={addCriterion}
            onRemoveCriterion={removeCriterion}
            onReScreen={reScreen}
            onToggleAbstract={() => setShowFullAbstract((value) => !value)}
            onAccept={acceptQueuePaper}
            onFlip={flipQueuePaper}
            onDecide={decideQueuePaper}
            onStar={starQueuePaper}
            onPrev={() => setQueueIndex((value) => Math.max(value - 1, 0))}
            onNext={() =>
              setQueueIndex((value) => Math.min(value + 1, queuePapers.length - 1))
            }
            onExit={() => setQueueMode(false)}
            onDownloadIncluded={downloadIncluded}
            onAcceptSuggestion={acceptCriteriaSuggestion}
            onDismissSuggestion={dismissCriteriaSuggestion}
          />
        </div>
      ) : (
        <div className="lit-body">
          {navAside}

          <section className="lit-results">
            <div className="lit-toolbar">
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter library"
                aria-label="Filter library"
              />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                aria-label="Sort papers"
              >
                <option value="added">Newest</option>
                <option value="fit">Fit score</option>
                <option value="year">Year</option>
                <option value="citations">Citations</option>
                <option value="title">Title</option>
              </select>
            </div>

            <div className="lit-list-head">
              <span>
                {visiblePapers.length} {visiblePapers.length === 1 ? "paper" : "papers"}
              </span>
            </div>

            <div className="lit-paper-list">
              {loaded && papers.length === 0 && (
                <div className="lit-empty-library">
                  <p>Your library is empty.</p>
                  <p className="dim">
                    "Search & save" queries arXiv + Crossref and saves every result straight to
                    the Inbox (duplicates are merged, never re-added). "Open in Chat" runs a
                    literature skill that records its findings into the same library — watch both
                    in the Activity log below.
                  </p>
                  <div className="lit-example-queries">
                    {EXAMPLE_QUERIES.map((example) => (
                      <button
                        type="button"
                        key={example}
                        className="lit-chip"
                        onClick={() => setDraftQuery(example)}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {papers.length > 0 && visiblePapers.length === 0 && (
                <div className="empty">No papers match this view.</div>
              )}
              {visiblePapers.map((paper) => (
                <div
                  key={paper.id}
                  className={`lit-paper-row${selectedPaper?.id === paper.id ? " active" : ""}${paper.stage === "excluded" ? " excluded" : ""}`}
                  onClick={() => selectPaper(paper)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectPaper(paper);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <input
                    type="checkbox"
                    className="lit-row-check"
                    checked={checked.has(paper.id)}
                    aria-label={`Select ${paper.title}`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleChecked(paper.id)}
                  />
                  <div className="lit-paper-main">
                    <div className={`lit-paper-title${paper.unread ? " unread" : ""}`}>
                      {paper.starred && <span className="lit-star-mark">★</span>}
                      {paper.title}
                    </div>
                    <div className="lit-paper-meta">
                      <span
                        className={`lit-stage-dot ${paper.stage}`}
                        title={STAGE_LABELS[paper.stage]}
                      />
                      {formatAuthors(paper.authors)}
                      {paper.year ? ` · ${paper.year}` : ""}
                      {paper.venue ? ` · ${paper.venue}` : ""}
                      {paper.pdf.status === "downloaded" && (
                        <span className="lit-pdf-mark" title={paper.pdf.path}>
                          PDF
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="lit-paper-signal">
                    {paper.verdict ? (
                      <span
                        className={`lit-fit fit-${paper.verdict.fit}`}
                        title={FIT_LABELS[paper.verdict.fit]}
                      >
                        {paper.verdict.score}
                      </span>
                    ) : (
                      <span className="lit-fit fit-none" title="Not screened yet">
                        —
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {batchIds.length > 0 && (
              <div className="lit-batch-bar" role="toolbar" aria-label="Batch actions">
                <span>{batchIds.length} selected</span>
                <button type="button" onClick={() => runBatch((ids) => setStage(ids, "shortlist"))}>
                  Shortlist
                </button>
                <button type="button" onClick={() => runBatch((ids) => setStage(ids, "excluded"))}>
                  Exclude
                </button>
                <button
                  type="button"
                  onClick={() =>
                    runBatch((ids) => {
                      for (const id of ids) void downloadPdf(id);
                    })
                  }
                >
                  Download PDFs
                </button>
                <button type="button" onClick={() => setChecked(new Set())}>
                  Clear
                </button>
              </div>
            )}
          </section>

          <section className="lit-detail">
            {selectedPaper ? (
              <>
                <div className="lit-detail-head">
                  <div className="lit-detail-heading">
                    <div className="lit-detail-title">{selectedPaper.title}</div>
                    <div className="lit-detail-sub">
                      {formatAuthors(selectedPaper.authors)}
                      {selectedPaper.year ? ` · ${selectedPaper.year}` : ""}
                      {selectedPaper.venue ? ` · ${selectedPaper.venue}` : ""}
                      {typeof selectedPaper.citedBy === "number"
                        ? ` · ${selectedPaper.citedBy} citations`
                        : ""}
                    </div>
                  </div>
                  <div className="lit-detail-actions">
                    <button
                      type="button"
                      className={selectedPaper.starred ? "lit-starred" : ""}
                      onClick={() => toggleStar(selectedPaper.id)}
                    >
                      {selectedPaper.starred ? "★ Starred" : "☆ Star"}
                    </button>
                    {selectedPaper.stage !== "excluded" &&
                      selectedPaper.stage !== "shortlist" &&
                      selectedPaper.stage !== "downloaded" &&
                      selectedPaper.stage !== "read" && (
                        <button
                          type="button"
                          onClick={() => setStage([selectedPaper.id], "shortlist")}
                        >
                          Shortlist
                        </button>
                      )}
                    <PdfAction paper={selectedPaper} onDownload={downloadPdf} />
                    <button
                      type="button"
                      onClick={() => askAgentAboutPaper(selectedPaper)}
                      title="Open Chat for deeper reading"
                    >
                      Ask Agent
                    </button>
                    {selectedPaper.stage === "excluded" ? (
                      <button type="button" onClick={() => setStage([selectedPaper.id], "inbox")}>
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setStage([selectedPaper.id], "excluded")}
                      >
                        Exclude
                      </button>
                    )}
                  </div>
                </div>

                <div className="lit-tabbar" role="tablist" aria-label="Paper detail">
                  {(
                    [
                      { id: "metadata", label: "Metadata" },
                      { id: "agent", label: "Agent notes" },
                      { id: "evidence", label: "Evidence" },
                    ] as Array<{ id: DetailTab; label: string }>
                  ).map((tab) => (
                    <button
                      type="button"
                      key={tab.id}
                      role="tab"
                      aria-selected={detailTab === tab.id}
                      className={detailTab === tab.id ? "active" : ""}
                      onClick={() => setDetailTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <PaperDetail
                  tab={detailTab}
                  paper={selectedPaper}
                  activeTask={activeReviewTask}
                  screening={selectedScreening}
                  tagDraft={tagDraft}
                  onTagDraft={setTagDraft}
                  onAddTag={addTagToSelected}
                />
              </>
            ) : (
              <div className="empty">Select a paper.</div>
            )}
          </section>
        </div>
      )}

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

/** Slim library-mode banner that turns a search into a review run. */
function ReviewCta({
  tasks,
  activeTask,
  pendingReview,
  reviewedCount,
  totalCount,
  onSelectTask,
  onStart,
}: {
  tasks: LiteratureReviewTask[];
  activeTask: LiteratureReviewTask;
  pendingReview: number;
  reviewedCount: number;
  totalCount: number;
  onSelectTask: (id: string | null) => void;
  onStart: () => void;
}) {
  return (
    <div className="lit-review-cta">
      <span className="lit-review-cta-label">Review</span>
      {tasks.length > 1 ? (
        <select
          className="lit-review-cta-task"
          value={activeTask.id}
          onChange={(event) => onSelectTask(event.target.value || null)}
          aria-label="Review task"
        >
          {tasks.map((task) => (
            <option value={task.id} key={task.id}>
              {task.question}
            </option>
          ))}
        </select>
      ) : (
        <span className="lit-review-cta-task single">{activeTask.question}</span>
      )}
      <span className="lit-review-cta-stats">
        {reviewedCount} of {totalCount} reviewed
      </span>
      <button type="button" className="primary" aria-label="Start review" onClick={onStart}>
        {pendingReview > 0 ? `Review ${pendingReview} →` : "Open queue →"}
      </button>
    </div>
  );
}

interface ReviewModeProps {
  task: LiteratureReviewTask;
  paper: LiteraturePaper | null;
  index: number;
  pendingCount: number;
  totalCount: number;
  reviewedCount: number;
  flippedCount: number;
  decisionCounts: { include: number; exclude: number; maybe: number };
  pendingScreenCount: number;
  criteriaOpen: boolean;
  showFullAbstract: boolean;
  onToggleCriteria: () => void;
  onQuestionChange: (taskId: string, question: string) => void;
  onCriterionChange: (taskId: string, criterionId: string, text: string) => void;
  onAddCriterion: (taskId: string, kind: "include" | "exclude") => void;
  onRemoveCriterion: (taskId: string, criterionId: string) => void;
  onReScreen: () => void;
  onToggleAbstract: () => void;
  onAccept: () => void;
  onFlip: () => void;
  onDecide: (decision: ScreeningDecision) => void;
  onStar: () => void;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
  onDownloadIncluded: () => void;
  onAcceptSuggestion: (taskId: string, suggestionId: string) => void;
  onDismissSuggestion: (taskId: string, suggestionId: string) => void;
}

function ReviewMode({
  task,
  paper,
  index,
  pendingCount,
  totalCount,
  reviewedCount,
  flippedCount,
  decisionCounts,
  pendingScreenCount,
  criteriaOpen,
  showFullAbstract,
  onToggleCriteria,
  onQuestionChange,
  onCriterionChange,
  onAddCriterion,
  onRemoveCriterion,
  onReScreen,
  onToggleAbstract,
  onAccept,
  onFlip,
  onDecide,
  onStar,
  onPrev,
  onNext,
  onExit,
  onDownloadIncluded,
  onAcceptSuggestion,
  onDismissSuggestion,
}: ReviewModeProps) {
  const screening = paper?.screenings?.[task.id];
  const primaryQuote = screening?.reasons[0]?.anchor.quote;
  const abstract = paper?.abstract ?? "";
  const abstractText =
    showFullAbstract || abstract.length <= 460 ? abstract : `${abstract.slice(0, 460)}…`;
  const includeCriteria = task.criteria.filter((criterion) => criterion.kind === "include");
  const excludeCriteria = task.criteria.filter((criterion) => criterion.kind === "exclude");
  const suggestions = task.suggestions.filter(
    (suggestion) => !suggestion.accepted && !suggestion.dismissed,
  );

  return (
    <section className="lit-review-mode">
      <header className="lit-review-bar">
        <div className="lit-review-bar-main">
          <strong>Review queue</strong>
          <span className="lit-review-progress">
            {pendingCount} pending / {totalCount} total
          </span>
        </div>
        <div className="lit-review-bar-counts">
          {reviewedCount} reviewed · {flippedCount} flipped
        </div>
        <button type="button" onClick={onExit} title="Back to library (Esc)">
          ← Library
        </button>
      </header>

      <div className={`lit-criteria-bar${criteriaOpen ? " open" : ""}`}>
        <div className="lit-criteria-summary">
          <span className="lit-criteria-tag">Criteria</span>
          <span className="lit-criteria-text">
            <strong>Include:</strong>{" "}
            {includeCriteria.map((criterion) => criterion.text).join("; ") || "—"}
            {excludeCriteria.length > 0 && (
              <>
                {"  "}
                <strong>Exclude:</strong>{" "}
                {excludeCriteria.map((criterion) => criterion.text).join("; ")}
              </>
            )}
          </span>
          <button type="button" onClick={onToggleCriteria}>
            {criteriaOpen ? "Done" : "Edit criteria"}
          </button>
        </div>
        {criteriaOpen && (
          <div className="lit-criteria-editor">
            <input
              className="lit-question-input"
              value={task.question}
              onChange={(event) => onQuestionChange(task.id, event.target.value)}
              aria-label="Review question"
            />
            <div className="lit-criteria-grid">
              <CriterionColumn
                title="Include"
                criteria={includeCriteria}
                onChange={(criterionId, text) => onCriterionChange(task.id, criterionId, text)}
                onAdd={() => onAddCriterion(task.id, "include")}
                onRemove={(criterionId) => onRemoveCriterion(task.id, criterionId)}
              />
              <CriterionColumn
                title="Exclude"
                criteria={excludeCriteria}
                onChange={(criterionId, text) => onCriterionChange(task.id, criterionId, text)}
                onAdd={() => onAddCriterion(task.id, "exclude")}
                onRemove={(criterionId) => onRemoveCriterion(task.id, criterionId)}
              />
            </div>
            <div className="lit-criteria-editor-actions">
              <button type="button" className="primary" onClick={onReScreen}>
                Re-screen {totalCount}
              </button>
              <span className="dim">
                Re-screening keeps confirmed decisions; only unreviewed papers are re-scored.
              </span>
            </div>
          </div>
        )}
      </div>

      {paper ? (
        <article className="lit-queue-card">
          <div className="lit-queue-card-head">
            <div className="lit-queue-card-id">
              <span className="lit-queue-counter">
                {Math.min(index + 1, Math.max(pendingCount, 1))} / {pendingCount}
              </span>
              <div>
                <div className="lit-queue-title">{paper.title}</div>
                <div className="lit-detail-sub">
                  {formatAuthors(paper.authors)}
                  {paper.year ? ` · ${paper.year}` : ""}
                  {paper.venue ? ` · ${paper.venue}` : ""}
                  {typeof paper.citedBy === "number" ? ` · ${paper.citedBy} citations` : ""}
                </div>
              </div>
            </div>
            <div className="lit-queue-verdict">
              <span className={`lit-decision decision-${screening?.decision ?? "none"}`}>
                {screening ? DECISION_LABELS[screening.decision] : "Unscreened"}
              </span>
              {screening && (
                <span className="lit-queue-score-line">
                  <span className={`lit-fit fit-${scoreFit(screening.score)}`}>
                    {screening.score}
                  </span>
                  {screening.confidence}% confidence
                </span>
              )}
            </div>
          </div>

          {screening && screening.reasons.length > 0 && (
            <div
              className={`lit-queue-rationale rationale-${screening.decision}`}
              role="note"
            >
              <div className="lit-queue-rationale-note">{screening.reasons[0].note}</div>
              {screening.reasons[0].criteriaId && (
                <div className="lit-queue-rationale-crit">
                  matches your {criterionKind(task, screening.reasons[0].criteriaId) ?? "review"}{" "}
                  criterion: “{screening.reasons[0].criteriaText}”
                </div>
              )}
              <blockquote>“{screening.reasons[0].anchor.quote}”</blockquote>
            </div>
          )}

          <section className="lit-queue-abstract">
            <div className="lit-note-label">Abstract</div>
            <p>
              <HighlightedText
                text={abstractText || "No abstract available."}
                quote={primaryQuote}
              />
            </p>
            {abstract.length > 460 && (
              <button type="button" className="lit-linkish" onClick={onToggleAbstract}>
                {showFullAbstract ? "Show less" : "Show full abstract"}
              </button>
            )}
          </section>

          <div className="lit-kbd-row">
            <button type="button" aria-label="Accept" onClick={onAccept} disabled={!screening}>
              <kbd>A</kbd> Accept
            </button>
            <button type="button" aria-label="Flip" onClick={onFlip}>
              <kbd>F</kbd> Flip
            </button>
            <button type="button" aria-label="Include" onClick={() => onDecide("include")}>
              <kbd>I</kbd> Include
            </button>
            <button type="button" aria-label="Exclude" onClick={() => onDecide("exclude")}>
              <kbd>X</kbd> Exclude
            </button>
            <button type="button" aria-label="Maybe" onClick={() => onDecide("maybe")}>
              <kbd>M</kbd> Maybe
            </button>
            <button
              type="button"
              aria-label="Star"
              className={paper.starred ? "lit-starred" : ""}
              onClick={onStar}
            >
              <kbd>S</kbd> {paper.starred ? "Starred" : "Star"}
            </button>
            <span className="lit-kbd-hint">
              <kbd>J</kbd>/<kbd>K</kbd> navigate · <kbd>Space</kbd> abstract · <kbd>Esc</kbd> exit
            </span>
          </div>

          <div className="lit-queue-nav">
            <button type="button" onClick={onPrev} disabled={index <= 0}>
              ← Prev
            </button>
            <button type="button" onClick={onNext} disabled={index >= pendingCount - 1}>
              Skip →
            </button>
          </div>
        </article>
      ) : (
        <div className="lit-queue-done">
          <div className="lit-queue-done-title">
            {pendingScreenCount > 0 ? "Nothing screened yet" : "Queue cleared"}
          </div>
          <p className="dim">
            {reviewedCount} reviewed — {decisionCounts.include} included,{" "}
            {decisionCounts.exclude} excluded, {decisionCounts.maybe} maybe.
          </p>
          <div className="lit-queue-done-actions">
            <button
              type="button"
              className="primary"
              onClick={onDownloadIncluded}
              disabled={decisionCounts.include === 0}
            >
              Download {decisionCounts.include} included PDFs
            </button>
            <button type="button" onClick={onExit}>
              Back to library
            </button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="lit-suggestion-bar">
          {suggestions.map((suggestion) => (
            <div className="lit-suggestion" key={suggestion.id}>
              <span>
                You rescued {suggestion.basisPaperIds.length} papers the agent excluded — add
                include criterion “{suggestion.text}”?
              </span>
              <button type="button" onClick={() => onAcceptSuggestion(task.id, suggestion.id)}>
                Apply
              </button>
              <button type="button" onClick={() => onDismissSuggestion(task.id, suggestion.id)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CriterionColumn({
  title,
  criteria,
  onChange,
  onAdd,
  onRemove,
}: {
  title: string;
  criteria: ScreeningCriterion[];
  onChange: (criterionId: string, text: string) => void;
  onAdd: () => void;
  onRemove: (criterionId: string) => void;
}) {
  return (
    <div className="lit-criteria-column">
      <div className="lit-criteria-head">
        <span>{title}</span>
        <button type="button" onClick={onAdd}>
          Add
        </button>
      </div>
      {criteria.map((criterion) => (
        <div className="lit-criterion-row" key={criterion.id}>
          <input
            value={criterion.text}
            onChange={(event) => onChange(criterion.id, event.target.value)}
            aria-label={`${title} criterion`}
          />
          <button
            type="button"
            onClick={() => onRemove(criterion.id)}
            aria-label={`Remove ${criterion.text}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function HighlightedText({ text, quote }: { text: string; quote?: string }) {
  if (!quote) return <>{text}</>;
  const normalized = quote.trim().replace(/[“”]/g, "");
  if (!normalized) return <>{text}</>;
  const index = text.toLowerCase().indexOf(normalized.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalized.length)}</mark>
      {text.slice(index + normalized.length)}
    </>
  );
}

/** Terminal-style log: what ran, what came back, and when papers entered the
 * library — covering both direct searches and skills running in Chat. */
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
          {latest
            ? latest.text
            : "idle — searches, downloads, and agent actions are logged here"}
        </span>
        <span className="lit-activity-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="lit-activity-body">
          <div
            className="lit-activity-log"
            ref={logRef}
            role="log"
            aria-label="Literature activity log"
          >
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
            <button type="button" onClick={clear} disabled={activity.length === 0}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatLogTime(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour12: false });
}

/** Collapsible left-nav group, used by the secondary sections so the nav
 * stays short by default. */
function NavSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="lit-nav-section">
      <button
        type="button"
        className="lit-section-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="lit-section-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && children}
    </div>
  );
}

function NavItem({
  label,
  count,
  active,
  onClick,
  dot,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dot?: PaperStage;
}) {
  return (
    <button type="button" className={`lit-nav-item${active ? " active" : ""}`} onClick={onClick}>
      <span className="lit-nav-label">
        {dot && <span className={`lit-stage-dot ${dot}`} />}
        <span className="lit-nav-text">{label}</span>
      </span>
      <span className="lit-count">{count}</span>
    </button>
  );
}

function PdfAction({
  paper,
  onDownload,
}: {
  paper: LiteraturePaper;
  onDownload: (id: string) => Promise<void>;
}) {
  if (paper.pdf.status === "downloaded") {
    return (
      <span className="lit-pdf-saved" title={paper.pdf.path}>
        PDF saved
      </span>
    );
  }
  if (paper.pdf.status === "downloading") {
    return (
      <button type="button" className="primary" disabled>
        Downloading…
      </button>
    );
  }
  if (!paper.pdf.url) {
    return (
      <button type="button" disabled title="No direct PDF link is known for this paper">
        No PDF link
      </button>
    );
  }
  return (
    <button type="button" className="primary" onClick={() => void onDownload(paper.id)}>
      {paper.pdf.status === "failed" ? "Retry download" : "Download PDF"}
    </button>
  );
}

function PaperDetail({
  tab,
  paper,
  activeTask,
  screening,
  tagDraft,
  onTagDraft,
  onAddTag,
}: {
  tab: DetailTab;
  paper: LiteraturePaper;
  activeTask: LiteratureReviewTask | null;
  screening?: PaperScreening;
  tagDraft: string;
  onTagDraft: (value: string) => void;
  onAddTag: () => void;
}) {
  if (tab === "agent") {
    return (
      <div className="lit-detail-scroll">
        {screening && (
          <section className="lit-verdict">
            <div className="lit-verdict-head">
              <span className="lit-note-label">{activeTask ? activeTask.question : "Review task"}</span>
              <span className={`lit-fit fit-${scoreFit(screening.score)}`}>
                {DECISION_LABELS[screening.decision]} · {screening.score}
              </span>
            </div>
            {screening.reasons.map((reason) => (
              <div className="lit-reason compact" key={reason.id}>
                <div>{reason.note}</div>
                <blockquote>{reason.anchor.quote}</blockquote>
                <span>{reason.criteriaText}</span>
              </div>
            ))}
          </section>
        )}
        {!screening && paper.verdict ? (
          <section className="lit-verdict">
            <div className="lit-verdict-head">
              <span className="lit-note-label">Agent verdict</span>
              <span className={`lit-fit fit-${paper.verdict.fit}`}>
                {FIT_LABELS[paper.verdict.fit]} · {paper.verdict.score}
              </span>
            </div>
            <p>{paper.verdict.rationale}</p>
          </section>
        ) : !screening ? (
          <div className="empty">Not screened yet.</div>
        ) : null}
        {paper.agentSummary && (
          <section className="lit-note">
            <div className="lit-note-label">Agent summary</div>
            <p>{paper.agentSummary}</p>
          </section>
        )}
      </div>
    );
  }

  if (tab === "evidence") {
    return (
      <div className="lit-detail-scroll">
        {paper.evidence.length === 0 && (
          <div className="empty">
            No extracted evidence yet. Once the agent reads the PDF, quotes land here with page
            anchors.
          </div>
        )}
        {paper.evidence.map((item) => (
          <section className="lit-evidence" key={item.id}>
            <div className="lit-evidence-page">Page {item.page}</div>
            <blockquote>{item.quote}</blockquote>
            <p>{item.note}</p>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="lit-detail-scroll">
      <dl className="lit-kv">
        {paper.doi && (
          <>
            <dt>DOI</dt>
            <dd>
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                {paper.doi}
              </a>
            </dd>
          </>
        )}
        {paper.arxivId && (
          <>
            <dt>arXiv</dt>
            <dd>
              <a href={`https://arxiv.org/abs/${paper.arxivId}`} target="_blank" rel="noreferrer">
                {paper.arxivId}
              </a>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>{paper.source}</dd>
        <dt>Stage</dt>
        <dd>{STAGE_LABELS[paper.stage]}</dd>
        <dt>Added</dt>
        <dd>{paper.addedAt.slice(0, 10)}</dd>
        <dt>PDF</dt>
        <dd>
          {paper.pdf.status === "downloaded"
            ? paper.pdf.path
            : paper.pdf.status === "failed"
              ? `download failed — ${paper.pdf.error ?? "unknown error"}`
              : paper.pdf.url
                ? "direct link available"
                : "no direct link"}
        </dd>
      </dl>

      <section className="lit-note">
        <div className="lit-note-label">Abstract</div>
        <p>{paper.abstract || "No abstract available."}</p>
      </section>

      <section className="lit-note">
        <div className="lit-note-label">Tags</div>
        <div className="lit-tag-edit">
          {paper.tags.map((tag) => (
            <span className="lit-chip static" key={tag}>
              {tag}
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(event) => onTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onAddTag();
            }}
            placeholder="Add tag"
            aria-label="Add tag"
          />
        </div>
      </section>
    </div>
  );
}

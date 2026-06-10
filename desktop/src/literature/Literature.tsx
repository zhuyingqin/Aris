import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useLiteratureStore } from "./literatureStore";
import type {
  DetailTab,
  LiteraturePaper,
  PaperFit,
  PaperStage,
} from "./literatureTypes";
import "./Literature.css";

const SOURCES: Array<{ id: string; label: string }> = [
  { id: "arxiv", label: "arXiv" },
  { id: "crossref", label: "Crossref" },
];

const STAGES: Array<{ id: PaperStage; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "screened", label: "Screened" },
  { id: "shortlist", label: "Shortlist" },
  { id: "downloaded", label: "Downloaded" },
  { id: "read", label: "Agent read" },
  { id: "excluded", label: "Excluded" },
];

const STAGE_LABELS: Record<PaperStage, string> = Object.fromEntries(
  STAGES.map((stage) => [stage.id, stage.label]),
) as Record<PaperStage, string>;

const FIT_LABELS: Record<PaperFit, string> = {
  high: "High fit",
  medium: "Medium fit",
  low: "Low fit",
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
      sorted.sort(
        (a, b) => (b.verdict?.score ?? -1) - (a.verdict?.score ?? -1),
      );
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

export default function Literature() {
  const currentProject = useStore((s) => s.currentProject);
  const library = useLiteratureStore((s) => s.library);
  const loaded = useLiteratureStore((s) => s.loaded);
  const searching = useLiteratureStore((s) => s.searching);
  const lastSearch = useLiteratureStore((s) => s.lastSearch);
  const storeError = useLiteratureStore((s) => s.error);
  const load = useLiteratureStore((s) => s.load);
  const runSearch = useLiteratureStore((s) => s.runSearch);
  const setStage = useLiteratureStore((s) => s.setStage);
  const toggleStar = useLiteratureStore((s) => s.toggleStar);
  const markRead = useLiteratureStore((s) => s.markRead);
  const addTags = useLiteratureStore((s) => s.addTags);
  const downloadPdf = useLiteratureStore((s) => s.downloadPdf);
  const setError = useLiteratureStore((s) => s.setError);

  const [draftQuery, setDraftQuery] = useState("");
  const [sources, setSources] = useState<string[]>(["arxiv", "crossref"]);
  const [view, setView] = useState("all");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("added");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("metadata");
  const [tagDraft, setTagDraft] = useState("");

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  // Jump to the freshly created saved search after a remote search lands.
  const lastSearchId = lastSearch?.searchId ?? null;
  useEffect(() => {
    if (lastSearchId) setView(`search:${lastSearchId}`);
  }, [lastSearchId]);

  const papers = library.papers;

  const visiblePapers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return sortPapers(
      papers.filter((paper) => matchesView(paper, view) && matchesQuery(paper, needle)),
      sort,
    );
  }, [filter, papers, sort, view]);

  const selectedPaper =
    visiblePapers.find((paper) => paper.id === selectedId) ?? visiblePapers[0] ?? null;

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

  const toggleSource = (id: string) =>
    setSources((current) =>
      current.includes(id)
        ? current.filter((source) => source !== id)
        : [...current, id],
    );

  const submitSearch = () => {
    if (!draftQuery.trim() || sources.length === 0 || searching) return;
    void runSearch(draftQuery, sources);
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

  return (
    <div className="lit-page">
      <div className="lit-omnibar">
        <input
          className="lit-omnibar-input"
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSearch();
          }}
          placeholder="Search arXiv and Crossref…"
          aria-label="Remote search query"
        />
        <div className="lit-source-chips" role="group" aria-label="Search sources">
          {SOURCES.map((source) => (
            <button
              type="button"
              key={source.id}
              className={`lit-chip${sources.includes(source.id) ? " active" : ""}`}
              aria-pressed={sources.includes(source.id)}
              onClick={() => toggleSource(source.id)}
            >
              {source.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="primary"
          onClick={submitSearch}
          disabled={searching || !draftQuery.trim() || sources.length === 0}
        >
          {searching ? "Searching…" : "Search"}
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
                {lastSearch.resultCount} results · {lastSearch.newCount} new in Inbox
                {lastSearch.warnings.length > 0 &&
                  ` · ${lastSearch.warnings.join(" · ")}`}
              </span>
            )
          )}
        </div>
      )}

      <div className="lit-body">
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
          </div>

          <div className="lit-nav-section">
            <div className="panel-title">Pipeline</div>
            {STAGES.map((stage) => (
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

          {library.collections.length > 0 && (
            <div className="lit-nav-section">
              <div className="panel-title">Collections</div>
              {library.collections.map((collection) => (
                <NavItem
                  key={collection.id}
                  label={collection.label}
                  count={
                    papers.filter((paper) => paper.collectionIds.includes(collection.id))
                      .length
                  }
                  active={view === `col:${collection.id}`}
                  onClick={() => setView(`col:${collection.id}`)}
                />
              ))}
            </div>
          )}

          {library.searches.length > 0 && (
            <div className="lit-nav-section">
              <div className="panel-title">Saved searches</div>
              {library.searches.slice(0, 8).map((search) => (
                <div className="lit-search-row" key={search.id}>
                  <NavItem
                    label={search.query}
                    count={
                      papers.filter((paper) => paper.searchIds.includes(search.id)).length
                    }
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
            </div>
          )}

          {allTags.length > 0 && (
            <div className="lit-nav-section">
              <div className="panel-title">Tags</div>
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
            </div>
          )}
        </aside>

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
                  Search arXiv or Crossref above — results are saved to{" "}
                  <code>papers/library.json</code> in this project.
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
                  {selectedPaper.stage === "excluded" ? (
                    <button
                      type="button"
                      onClick={() => setStage([selectedPaper.id], "inbox")}
                    >
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
    <button
      type="button"
      className={`lit-nav-item${active ? " active" : ""}`}
      onClick={onClick}
    >
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
  tagDraft,
  onTagDraft,
  onAddTag,
}: {
  tab: DetailTab;
  paper: LiteraturePaper;
  tagDraft: string;
  onTagDraft: (value: string) => void;
  onAddTag: () => void;
}) {
  if (tab === "agent") {
    return (
      <div className="lit-detail-scroll">
        {paper.verdict ? (
          <section className="lit-verdict">
            <div className="lit-verdict-head">
              <span className="lit-note-label">Agent verdict</span>
              <span className={`lit-fit fit-${paper.verdict.fit}`}>
                {FIT_LABELS[paper.verdict.fit]} · {paper.verdict.score}
              </span>
            </div>
            <p>{paper.verdict.rationale}</p>
          </section>
        ) : (
          <div className="empty">
            Not screened yet. Agent abstract screening lands in the next milestone — verdicts
            will appear here with a rationale and evidence links.
          </div>
        )}
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
            No extracted evidence yet. Once the agent reads the PDF, quotes land here with
            page anchors.
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
              <a
                href={`https://arxiv.org/abs/${paper.arxivId}`}
                target="_blank"
                rel="noreferrer"
              >
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

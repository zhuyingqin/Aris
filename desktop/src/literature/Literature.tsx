import { useMemo, useState } from "react";
import type {
  DetailTab,
  LiteratureCollection,
  LiteraturePaper,
  LiteratureSearch,
  PaperFit,
  PaperStage,
  PdfStatus,
} from "./literatureTypes";
import "./Literature.css";

const INITIAL_SEARCHES: LiteratureSearch[] = [
  {
    id: "search-agentic-review",
    label: "Agentic literature review",
    query: "agentic literature review autonomous paper screening",
    source: "arXiv + Crossref",
    count: 18,
  },
  {
    id: "search-pdf-reading",
    label: "PDF reading agents",
    query: "LLM PDF reading citation grounded summarization",
    source: "Semantic Scholar",
    count: 12,
  },
];

const INITIAL_PAPERS: LiteraturePaper[] = [
  {
    id: "paper-1",
    title: "Agentic Literature Review: Planning, Retrieval, and Grounded Synthesis",
    authors: "M. Rivera, L. Chen, A. Novak",
    year: 2026,
    venue: "arXiv",
    doi: "10.48550/arXiv.2602.01491",
    abstract:
      "A system design for decomposing literature review work into retrieval, screening, reading, and evidence-grounded writing steps.",
    collectionIds: ["col-core", "search-agentic-review"],
    tags: ["agent", "review", "retrieval"],
    fit: "high",
    score: 92,
    stage: "downloaded",
    pdfStatus: "downloaded",
    source: "arXiv",
    addedAt: "2026-06-09",
    agentSummary:
      "Strong fit. The paper separates metadata triage from full PDF reading and keeps every summary anchored to cited evidence spans.",
    agentDecision: "Keep for close reading and use as the interaction baseline.",
    evidence: [
      {
        id: "ev-1",
        page: 3,
        quote: "Screening decisions are recorded before full-text extraction.",
        note: "Useful for our staged UI: metadata first, PDF later.",
      },
      {
        id: "ev-2",
        page: 7,
        quote: "Readers can inspect the source passage behind each generated claim.",
        note: "Maps directly to an Evidence tab with page jumps.",
      },
    ],
  },
  {
    id: "paper-2",
    title: "Grounded PDF Summarization with Human-in-the-loop Annotation",
    authors: "S. Iyer, P. Almeida",
    year: 2025,
    venue: "CHI Late Breaking Work",
    doi: "10.1145/example.1024",
    abstract:
      "An interface study on combining automatic PDF summarization with reader annotations and editable evidence snippets.",
    collectionIds: ["col-reading", "search-pdf-reading"],
    tags: ["pdf", "annotation", "ux"],
    fit: "high",
    score: 88,
    stage: "reading",
    pdfStatus: "downloaded",
    source: "ACM DL",
    addedAt: "2026-06-09",
    agentSummary:
      "High interaction value. It treats annotation, summary, and PDF position as one linked object rather than separate notes.",
    agentDecision: "Use for the PDF reader and annotation design.",
    evidence: [
      {
        id: "ev-3",
        page: 5,
        quote: "Summaries were trusted when users could quickly inspect the cited region.",
        note: "Evidence preview should sit beside the Agent Notes tab.",
      },
    ],
  },
  {
    id: "paper-3",
    title: "Citation-aware Retrieval for Scientific Assistants",
    authors: "J. Park, E. Stone, N. Webb",
    year: 2024,
    venue: "EMNLP",
    doi: "10.18653/v1/example",
    abstract:
      "A retrieval method that ranks scientific passages using citation intent, section position, and local context.",
    collectionIds: ["col-core", "search-agentic-review"],
    tags: ["citation", "retrieval", "ranking"],
    fit: "medium",
    score: 74,
    stage: "screened",
    pdfStatus: "queued",
    source: "ACL Anthology",
    addedAt: "2026-06-08",
    agentSummary:
      "Relevant for ranking evidence after download. Less useful for the first UI pass because it focuses on retrieval internals.",
    agentDecision: "Keep as a secondary technical reference.",
    evidence: [
      {
        id: "ev-4",
        page: 4,
        quote: "Passage rank changes substantially when citation intent is available.",
        note: "Can inform later evidence ranking.",
      },
    ],
  },
  {
    id: "paper-4",
    title: "Bibliographic Managers in Research Teams: A Field Study",
    authors: "R. Novak, Y. Singh",
    year: 2023,
    venue: "CSCW",
    doi: "10.1145/example.2048",
    abstract:
      "A qualitative study of folders, tags, saved searches, and shared reading practices in academic research groups.",
    collectionIds: ["col-reading"],
    tags: ["zotero", "library", "collaboration"],
    fit: "medium",
    score: 69,
    stage: "candidate",
    pdfStatus: "none",
    source: "ACM DL",
    addedAt: "2026-06-07",
    agentSummary:
      "Good product reference for library organization. It does not discuss autonomous screening or PDF extraction.",
    agentDecision: "Skim for library navigation patterns.",
    evidence: [
      {
        id: "ev-5",
        page: 8,
        quote: "Researchers alternated between project collections and topical tags.",
        note: "Supports keeping both Collections and Tags in the left column.",
      },
    ],
  },
  {
    id: "paper-5",
    title: "General Web Agents for Form Filling",
    authors: "D. Lewis, H. Kim",
    year: 2024,
    venue: "arXiv",
    doi: "10.48550/arXiv.2409.01010",
    abstract:
      "A broad web automation benchmark focused on browser control and form completion.",
    collectionIds: ["search-agentic-review"],
    tags: ["web", "automation"],
    fit: "low",
    score: 31,
    stage: "rejected",
    pdfStatus: "none",
    source: "arXiv",
    addedAt: "2026-06-07",
    agentSummary:
      "Low fit. The paper is about browser automation rather than scholarly retrieval or reading.",
    agentDecision: "Reject for this library unless the scope expands.",
    evidence: [
      {
        id: "ev-6",
        page: 2,
        quote: "The benchmark centers on web form interaction tasks.",
        note: "Out of scope for the literature library UI.",
      },
    ],
  },
];

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All papers" },
  { id: "important", label: "Important" },
  { id: "downloaded", label: "Downloaded" },
  { id: "to-read", label: "To read" },
  { id: "no-pdf", label: "No PDF" },
];

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "metadata", label: "Metadata" },
  { id: "reader", label: "PDF" },
  { id: "agent", label: "Agent Notes" },
  { id: "evidence", label: "Evidence" },
];

const FIT_LABELS: Record<PaperFit, string> = {
  high: "High fit",
  medium: "Medium fit",
  low: "Low fit",
};

const STAGE_LABELS: Record<PaperStage, string> = {
  candidate: "Candidate",
  screened: "Screened",
  important: "Important",
  downloaded: "Downloaded",
  reading: "Reading",
  rejected: "Rejected",
};

const PDF_LABELS: Record<PdfStatus, string> = {
  none: "No PDF",
  queued: "Queued",
  downloaded: "PDF saved",
};

export default function Literature() {
  const [papers, setPapers] = useState(INITIAL_PAPERS);
  const [searches, setSearches] = useState(INITIAL_SEARCHES);
  const [selectedCollection, setSelectedCollection] = useState("all");
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(
    INITIAL_PAPERS[0]?.id ?? null,
  );
  const [query, setQuery] = useState("");
  const [fitFilter, setFitFilter] = useState<"all" | PaperFit>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("metadata");
  const [draftQuery, setDraftQuery] = useState("agentic literature review");
  const [draftSource, setDraftSource] = useState("arXiv + Crossref");

  const collections = useMemo(
    () => buildCollections(papers, searches),
    [papers, searches],
  );

  const visiblePapers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return papers.filter((paper) => {
      if (!matchesCollection(paper, selectedCollection)) return false;
      if (fitFilter !== "all" && paper.fit !== fitFilter) return false;
      if (!needle) return true;
      return [
        paper.title,
        paper.authors,
        paper.venue,
        paper.abstract,
        paper.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [fitFilter, papers, query, selectedCollection]);

  const selectedPaper =
    visiblePapers.find((paper) => paper.id === selectedPaperId) ?? visiblePapers[0] ?? null;

  const runSearch = () => {
    const trimmed = draftQuery.trim();
    if (!trimmed) return;
    const id = `search-${Date.now()}`;
    const title = titleFromQuery(trimmed);
    const newPaper: LiteraturePaper = {
      id: `paper-${Date.now()}`,
      title: `${title}: New Candidate from ${draftSource}`,
      authors: "Pending import",
      year: 2026,
      venue: draftSource,
      doi: "pending",
      abstract:
        "Metadata has been saved locally. The Agent has queued this paper for abstract screening before PDF download.",
      collectionIds: [id],
      tags: ["new", "screening"],
      fit: "medium",
      score: 62,
      stage: "candidate",
      pdfStatus: "none",
      source: draftSource,
      addedAt: "2026-06-09",
      agentSummary:
        "Queued for metadata screening. Full-text reading will start after the user marks it as important or downloads the PDF.",
      agentDecision: "Review abstract and decide whether to download.",
      evidence: [],
    };
    setSearches((current) => [
      {
        id,
        label: title,
        query: trimmed,
        source: draftSource,
        count: 1,
      },
      ...current,
    ]);
    setPapers((current) => [newPaper, ...current]);
    setSelectedCollection(id);
    setSelectedPaperId(newPaper.id);
    setDetailTab("metadata");
  };

  const markImportant = (id: string) => {
    setPapers((current) =>
      current.map((paper) =>
        paper.id === id
          ? {
              ...paper,
              stage: "important",
              fit: paper.fit === "low" ? "medium" : paper.fit,
              score: Math.max(paper.score, 80),
            }
          : paper,
      ),
    );
  };

  const queueDownload = (id: string) => {
    setPapers((current) =>
      current.map((paper) =>
        paper.id === id
          ? {
              ...paper,
              stage: "downloaded",
              pdfStatus: "downloaded",
            }
          : paper,
      ),
    );
    setDetailTab("reader");
  };

  return (
    <div className="lit-page">
      <aside className="lit-nav">
        <div className="lit-search-box">
          <div className="panel-title">New Search</div>
          <div className="lit-search-form">
            <textarea
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              rows={3}
              aria-label="Search query"
            />
            <select
              value={draftSource}
              onChange={(event) => setDraftSource(event.target.value)}
              aria-label="Search source"
            >
              <option>arXiv + Crossref</option>
              <option>Semantic Scholar</option>
              <option>PubMed</option>
              <option>Local Zotero Export</option>
            </select>
            <button className="primary" type="button" onClick={runSearch}>
              Run search
            </button>
          </div>
        </div>

        <div className="lit-nav-section">
          <div className="panel-title">Library</div>
          {collections.map((collection) => (
            <button
              type="button"
              key={collection.id}
              className={`lit-nav-item${selectedCollection === collection.id ? " active" : ""}`}
              onClick={() => {
                setSelectedCollection(collection.id);
                setSelectedPaperId(null);
              }}
            >
              <span>{collection.label}</span>
              <span className="lit-count">{collection.count}</span>
            </button>
          ))}
        </div>

        <div className="lit-nav-section">
          <div className="panel-title">Tags</div>
          <div className="lit-tags">
            {uniqueTags(papers).map((tag) => (
              <button
                type="button"
                key={tag}
                className="lit-tag-button"
                onClick={() => setQuery(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className="lit-results">
        <div className="lit-toolbar">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter papers"
            aria-label="Filter papers"
          />
          <select
            value={fitFilter}
            onChange={(event) => setFitFilter(event.target.value as "all" | PaperFit)}
            aria-label="Agent fit filter"
          >
            <option value="all">All fit scores</option>
            <option value="high">High fit</option>
            <option value="medium">Medium fit</option>
            <option value="low">Low fit</option>
          </select>
        </div>

        <div className="lit-list-head">
          <span>{visiblePapers.length} papers</span>
          <button
            type="button"
            onClick={() => {
              visiblePapers
                .filter((paper) => paper.fit === "high")
                .forEach((paper) => queueDownload(paper.id));
            }}
            disabled={visiblePapers.every((paper) => paper.fit !== "high")}
          >
            Download high fit
          </button>
        </div>

        <div className="lit-paper-list">
          {visiblePapers.length === 0 && (
            <div className="empty">No papers match this view.</div>
          )}
          {visiblePapers.map((paper) => (
            <button
              type="button"
              key={paper.id}
              className={`lit-paper-row${selectedPaper?.id === paper.id ? " active" : ""}`}
              onClick={() => setSelectedPaperId(paper.id)}
            >
              <div className="lit-paper-main">
                <div className="lit-paper-title">{paper.title}</div>
                <div className="lit-paper-meta">
                  {paper.authors} / {paper.year} / {paper.venue}
                </div>
              </div>
              <div className="lit-paper-signals">
                <span className={`lit-fit fit-${paper.fit}`}>{FIT_LABELS[paper.fit]}</span>
                <span className="lit-score">{paper.score}</span>
                <span className={`lit-stage stage-${paper.stage}`}>
                  {STAGE_LABELS[paper.stage]}
                </span>
              </div>
              <div className="lit-paper-tags">
                {paper.tags.slice(0, 4).map((tag) => (
                  <span className="tag" key={tag}>{tag}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="lit-detail">
        {selectedPaper ? (
          <>
            <div className="lit-detail-head">
              <div>
                <div className="lit-detail-title">{selectedPaper.title}</div>
                <div className="lit-detail-sub">
                  {selectedPaper.authors} / {selectedPaper.year} / {selectedPaper.source}
                </div>
              </div>
              <div className="lit-detail-actions">
                <button type="button" onClick={() => markImportant(selectedPaper.id)}>
                  Important
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => queueDownload(selectedPaper.id)}
                >
                  Save PDF
                </button>
              </div>
            </div>

            <div className="lit-tabbar" role="tablist" aria-label="Paper detail">
              {DETAIL_TABS.map((tab) => (
                <button
                  type="button"
                  key={tab.id}
                  className={detailTab === tab.id ? "active" : ""}
                  onClick={() => setDetailTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <PaperDetail tab={detailTab} paper={selectedPaper} />
          </>
        ) : (
          <div className="empty">Select a paper.</div>
        )}
      </section>
    </div>
  );
}

function PaperDetail({ tab, paper }: { tab: DetailTab; paper: LiteraturePaper }) {
  if (tab === "reader") {
    return (
      <div className="lit-reader">
        <div className="lit-reader-toolbar">
          <span>{PDF_LABELS[paper.pdfStatus]}</span>
          <span>{paper.doi}</span>
        </div>
        <div className="lit-pdf-frame">
          {paper.pdfStatus === "downloaded" ? (
            <>
              <div className="lit-pdf-page">
                <div className="lit-pdf-title">{paper.title}</div>
                <div className="lit-pdf-lines">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="lit-pdf-side">
                {paper.evidence.map((item) => (
                  <a href={`#${item.id}`} key={item.id}>
                    p. {item.page}
                  </a>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">PDF is not saved locally yet.</div>
          )}
        </div>
      </div>
    );
  }

  if (tab === "agent") {
    return (
      <div className="lit-detail-scroll">
        <section className="lit-note">
          <div className="lit-note-label">Agent Summary</div>
          <p>{paper.agentSummary}</p>
        </section>
        <section className="lit-note">
          <div className="lit-note-label">Decision</div>
          <p>{paper.agentDecision}</p>
        </section>
        <section className="lit-score-grid">
          <div>
            <span>Fit</span>
            <strong>{FIT_LABELS[paper.fit]}</strong>
          </div>
          <div>
            <span>Score</span>
            <strong>{paper.score}</strong>
          </div>
          <div>
            <span>Stage</span>
            <strong>{STAGE_LABELS[paper.stage]}</strong>
          </div>
        </section>
      </div>
    );
  }

  if (tab === "evidence") {
    return (
      <div className="lit-detail-scroll">
        {paper.evidence.length === 0 && (
          <div className="empty">No extracted evidence yet.</div>
        )}
        {paper.evidence.map((item) => (
          <section className="lit-evidence" id={item.id} key={item.id}>
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
      <section className="lit-meta-grid">
        <div>
          <span>Venue</span>
          <strong>{paper.venue}</strong>
        </div>
        <div>
          <span>Year</span>
          <strong>{paper.year}</strong>
        </div>
        <div>
          <span>DOI</span>
          <strong>{paper.doi}</strong>
        </div>
        <div>
          <span>Added</span>
          <strong>{paper.addedAt}</strong>
        </div>
      </section>
      <section className="lit-note">
        <div className="lit-note-label">Abstract</div>
        <p>{paper.abstract}</p>
      </section>
      <section className="lit-note">
        <div className="lit-note-label">Tags</div>
        <div>
          {paper.tags.map((tag) => (
            <span className="tag" key={tag}>{tag}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function buildCollections(
  papers: LiteraturePaper[],
  searches: LiteratureSearch[],
): LiteratureCollection[] {
  const smartCollections: LiteratureCollection[] = FILTERS.map((filter) => ({
    id: filter.id,
    label: filter.label,
    kind: "smart",
    count: papers.filter((paper) => matchesCollection(paper, filter.id)).length,
  }));
  const fixedCollections: LiteratureCollection[] = [
    {
      id: "col-core",
      label: "Core review",
      kind: "collection",
      count: papers.filter((paper) => paper.collectionIds.includes("col-core")).length,
    },
    {
      id: "col-reading",
      label: "Reader design",
      kind: "collection",
      count: papers.filter((paper) => paper.collectionIds.includes("col-reading")).length,
    },
  ];
  const savedSearches = searches.map((search) => ({
    id: search.id,
    label: search.label,
    kind: "search" as const,
    count: papers.filter((paper) => paper.collectionIds.includes(search.id)).length || search.count,
  }));
  return [...smartCollections, ...fixedCollections, ...savedSearches];
}

function matchesCollection(paper: LiteraturePaper, collectionId: string) {
  if (collectionId === "all") return true;
  if (collectionId === "important") {
    return paper.stage === "important" || paper.fit === "high";
  }
  if (collectionId === "downloaded") return paper.pdfStatus === "downloaded";
  if (collectionId === "to-read") {
    return paper.stage === "important" || paper.stage === "downloaded" || paper.stage === "reading";
  }
  if (collectionId === "no-pdf") return paper.pdfStatus === "none";
  return paper.collectionIds.includes(collectionId);
}

function uniqueTags(papers: LiteraturePaper[]) {
  return Array.from(new Set(papers.flatMap((paper) => paper.tags))).sort();
}

function titleFromQuery(query: string) {
  return query
    .split(/\s+/)
    .slice(0, 5)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

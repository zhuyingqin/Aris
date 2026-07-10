import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { fileRead, isTauri, studioHtml } from "../api/tauri";
import Presentation from "./Presentation";
import { useStore } from "../store";
import { useStudioStore } from "./studioStore";
import {
  type StudioArtifact,
  type StudioArtifactKind,
  type StudioPageReview,
} from "./studioTypes";
import "./Studio.css";

const PdfReader = lazy(() => import("../literature/PdfReader"));

type StudioView = "review" | "overview" | "speaker";
type ArtifactFilter = "all" | StudioArtifactKind | "feedback";

const FILTER_LABELS: Record<ArtifactFilter, string> = {
  all: "All",
  slides: "Slides",
  poster: "Poster",
  web: "Web",
  feedback: "Feedback",
};

const VIEW_LABELS: Record<StudioView, string> = {
  review: "Review",
  overview: "Overview",
  speaker: "Speaker",
};

const EMPTY_ANNOTATIONS: [] = [];
const NOOP = () => undefined;
const NOOP_AI = async () => "";

function WebPreview({
  relativePath,
  onOpenExternal,
}: {
  relativePath: string;
  onOpenExternal: () => void;
}) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setHtml("");
    setError(null);
    if (!isTauri()) {
      setError("Interactive HTML previews require the desktop backend.");
      return () => {
        disposed = true;
      };
    }
    void studioHtml(relativePath)
      .then((content) => {
        if (!disposed) setHtml(content);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [relativePath, reloadKey]);

  return (
    <div className="studio-web-preview">
      <div className="studio-web-toolbar">
        <span title={relativePath}>{relativePath.split("/").pop() || relativePath}</span>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>Reload</button>
        <button type="button" onClick={onOpenExternal}>Open HTML</button>
      </div>
      {error ? (
        <div className="studio-welcome">
          <strong>HTML preview unavailable.</strong>
          <p>{error}</p>
        </div>
      ) : html ? (
        <iframe
          key={`${relativePath}:${reloadKey}`}
          title={`Web preview: ${relativePath}`}
          srcDoc={html}
          sandbox="allow-forms allow-scripts"
        />
      ) : (
        <div className="studio-welcome"><p>Loading interactive HTML...</p></div>
      )}
    </div>
  );
}

const sortArtifacts = (artifacts: StudioArtifact[]) =>
  [...artifacts].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.generatedAt.localeCompare(left.generatedAt);
  });

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const openReviewCount = (artifact: StudioArtifact) =>
  artifact.pageReviews.filter((review) => review.status === "open").length;

const activeReviewCount = (artifact: StudioArtifact) =>
  artifact.pageReviews.filter((review) => review.status !== "resolved").length;

const countLabel = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Open and submitted feedback should surface above resolved items, which are
 * kept (dimmed) for reference at the bottom. */
const REVIEW_STATUS_RANK: Record<StudioPageReview["status"], number> = {
  open: 0,
  submitted: 1,
  resolved: 2,
};

function ReviewCard({
  review,
  onJump,
  onResolve,
  onReopen,
  onDelete,
}: {
  review: StudioPageReview;
  onJump?: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={`studio-review-card ${review.status}`}>
      <div className="studio-review-card-head">
        <button type="button" className="studio-page-link" onClick={onJump} disabled={!onJump}>
          Page {review.page}
        </button>
        <span className={`studio-review-status ${review.status}`}>{review.status}</span>
      </div>
      <p>{review.body}</p>
      <div className="studio-review-card-actions">
        {review.status === "resolved" ? (
          <button type="button" onClick={onReopen}>Reopen</button>
        ) : (
          <button type="button" onClick={onResolve}>Resolve</button>
        )}
        <button type="button" className="danger" onClick={onDelete}>Delete</button>
      </div>
    </article>
  );
}

export default function Studio() {
  const currentProject = useStore((state) => state.currentProject);
  const pendingStudioArtifactId = useStore((state) => state.pendingStudioArtifactId);
  const setPendingStudioArtifactId = useStore((state) => state.setPendingStudioArtifactId);
  const library = useStudioStore((state) => state.library);
  const loaded = useStudioStore((state) => state.loaded);
  const error = useStudioStore((state) => state.error);
  const load = useStudioStore((state) => state.load);
  const updateArtifact = useStudioStore((state) => state.updateArtifact);
  const addPageReview = useStudioStore((state) => state.addPageReview);
  const updatePageReview = useStudioStore((state) => state.updatePageReview);
  const deletePageReview = useStudioStore((state) => state.deletePageReview);
  const requestRevision = useStudioStore((state) => state.requestRevision);
  const openPath = useStudioStore((state) => state.openPath);
  const setError = useStudioStore((state) => state.setError);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [view, setView] = useState<StudioView>("review");
  const [readerPage, setReaderPage] = useState(1);
  const [requestedPage, setRequestedPage] = useState(1);
  const [pageRequestKey, setPageRequestKey] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [reviewDraft, setReviewDraft] = useState("");
  const [speakerNotes, setSpeakerNotes] = useState("");
  const [speakerNotesError, setSpeakerNotesError] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);

  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    setSelectedId(null);
    void load(projectId);
  }, [load, projectId]);

  const visibleArtifacts = useMemo(() => {
    return sortArtifacts(
      library.artifacts.filter((artifact) => {
        if (filter === "feedback" && activeReviewCount(artifact) === 0) return false;
        if (filter !== "all" && filter !== "feedback" && artifact.kind !== filter) return false;
        return true;
      }),
    );
  }, [filter, library.artifacts]);

  const filterCounts = useMemo<Record<ArtifactFilter, number>>(() => ({
    all: library.artifacts.length,
    slides: library.artifacts.filter((artifact) => artifact.kind === "slides").length,
    poster: library.artifacts.filter((artifact) => artifact.kind === "poster").length,
    web: library.artifacts.filter((artifact) => artifact.kind === "web").length,
    feedback: library.artifacts.filter((artifact) => activeReviewCount(artifact) > 0).length,
  }), [library.artifacts]);

  const selected =
    visibleArtifacts.find((artifact) => artifact.id === selectedId)
    ?? visibleArtifacts[0]
    ?? null;

  useEffect(() => {
    if (!loaded || !pendingStudioArtifactId) return;
    if (library.artifacts.some((artifact) => artifact.id === pendingStudioArtifactId)) {
      setFilter("all");
      setSelectedId(pendingStudioArtifactId);
    }
    setPendingStudioArtifactId(null);
  }, [
    library.artifacts,
    loaded,
    pendingStudioArtifactId,
    setPendingStudioArtifactId,
  ]);

  useEffect(() => {
    setReaderPage(1);
    setRequestedPage(1);
    setPageRequestKey((current) => current + 1);
    setPageCount(0);
    setReviewDraft("");
    setView("review");
    setPresenting(false);
  }, [selected?.id]);

  const closePresentation = useCallback(() => setPresenting(false), []);

  useEffect(() => {
    if (view !== "speaker" || !selected?.speakerNotesPath) {
      setSpeakerNotes("");
      setSpeakerNotesError(null);
      return;
    }
    let disposed = false;
    setSpeakerNotes("");
    setSpeakerNotesError(null);
    void fileRead(selected.speakerNotesPath, 5000)
      .then((text) => {
        if (!disposed) setSpeakerNotes(text);
      })
      .catch((reason) => {
        if (!disposed) setSpeakerNotesError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [selected?.speakerNotesPath, view]);

  const handlePageChange = useCallback((page: number) => setReaderPage(page), []);
  const handleDocumentLoaded = useCallback((pages: number) => setPageCount(pages), []);

  const currentPageReviews = selected?.pageReviews
    .filter((review) => review.page === readerPage)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)) ?? [];
  const allReviews = selected
    ? [...selected.pageReviews].sort(
        (left, right) =>
          REVIEW_STATUS_RANK[left.status] - REVIEW_STATUS_RANK[right.status] ||
          left.page - right.page ||
          left.createdAt.localeCompare(right.createdAt),
      )
    : [];
  const otherPageReviews = allReviews.filter((review) => review.page !== readerPage);
  const openCount = selected ? openReviewCount(selected) : 0;

  const addCurrentPageReview = () => {
    if (!selected || !reviewDraft.trim()) return;
    addPageReview(selected.id, readerPage, reviewDraft);
    setReviewDraft("");
  };

  const setReviewStatus = (
    reviewId: string,
    status: StudioPageReview["status"],
  ) => {
    if (selected) updatePageReview(selected.id, reviewId, { status });
  };

  const renderReviewCard = (review: StudioPageReview, allowJump = false) => (
    <ReviewCard
      key={review.id}
      review={review}
      onJump={allowJump ? () => {
        setReaderPage(review.page);
        setRequestedPage(review.page);
        setPageRequestKey((current) => current + 1);
      } : undefined}
      onResolve={() => setReviewStatus(review.id, "resolved")}
      onReopen={() => setReviewStatus(review.id, "open")}
      onDelete={() => selected && deletePageReview(selected.id, review.id)}
    />
  );

  return (
    <div className="studio-page">
      {error && (
        <div className="studio-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="studio-body">
        <aside className="studio-library">
          <div className="studio-library-head">
            <strong>Results</strong>
            <div>
              <span>{library.artifacts.length}</span>
              <button type="button" onClick={() => void load(projectId)} aria-label="Refresh results">
                Refresh
              </button>
            </div>
          </div>
          <div className="studio-filters">
            {(["all", "slides", "poster", "web", "feedback"] as ArtifactFilter[]).map((entry) => (
              <button
                key={entry}
                type="button"
                className={filter === entry ? "active" : ""}
                onClick={() => setFilter(entry)}
              >
                {FILTER_LABELS[entry]}
                {filterCounts[entry] > 0 && (
                  <span className="studio-filter-count">{filterCounts[entry]}</span>
                )}
              </button>
            ))}
          </div>
          <div className="studio-artifacts">
            {!loaded && <div className="studio-empty">Loading Studio results...</div>}
            {loaded && visibleArtifacts.length === 0 && (
              <div className="studio-empty">
                No generated results are indexed yet. Studio auto-discovers outputs in{" "}
                <code>slides/</code>, <code>poster/</code>, and <code>web/</code>; refresh after a
                workflow writes a PDF, PPTX, SVG, or HTML result there.
              </div>
            )}
            {visibleArtifacts.map((artifact) => {
              const reviewCount = activeReviewCount(artifact);
              return (
                <button
                  key={artifact.id}
                  type="button"
                  className={`studio-artifact${selected?.id === artifact.id ? " active" : ""}`}
                  onClick={() => setSelectedId(artifact.id)}
                >
                  <span className={`studio-kind ${artifact.kind}`}>{artifact.kind}</span>
                  <span className="studio-artifact-copy">
                    <strong>{artifact.title}</strong>
                    <small>{artifact.venue || artifact.htmlPath || artifact.pdfPath || artifact.pptxPath || "Result"}</small>
                  </span>
                  {reviewCount > 0 && (
                    <span className="studio-review-count">{reviewCount}</span>
                  )}
                  {artifact.pinned && (
                    <span className="studio-pin" title="Pinned" aria-label="Pinned">📌</span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="studio-workspace">
          {!selected ? (
            <div className="studio-welcome">
              <strong>Review the result, not the build process.</strong>
              <p>
                Studio collects generated decks and posters in one library. Open a result,
                inspect each page, and leave concrete feedback for the next revision.
              </p>
            </div>
          ) : (
            <>
              <div className="studio-artifact-head">
                <input
                  className="studio-artifact-title"
                  value={selected.title}
                  onChange={(event) => updateArtifact(selected.id, { title: event.target.value })}
                  aria-label="Artifact title"
                />
                <span className={`studio-kind ${selected.kind}`}>{selected.kind}</span>
                <div className="studio-artifact-actions">
                  {selected.pdfPath && (
                    <button
                      type="button"
                      className="studio-present"
                      onClick={() => setPresenting(true)}
                    >
                      Present
                    </button>
                  )}
                  <div className="studio-file-actions">
                    {selected.pdfPath && (
                      <button type="button" onClick={() => void openPath(selected.pdfPath!)}>
                        Open PDF
                      </button>
                    )}
                    {selected.pptxPath && (
                      <button type="button" onClick={() => void openPath(selected.pptxPath!)}>
                        Open PPTX
                      </button>
                    )}
                    {selected.htmlPath && (
                      <button type="button" onClick={() => void openPath(selected.htmlPath!)}>
                        Open HTML
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`studio-pin-toggle${selected.pinned ? " active" : ""}`}
                    onClick={() => updateArtifact(selected.id, { pinned: !selected.pinned })}
                  >
                    {selected.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    className="primary studio-revise"
                    disabled={openCount === 0}
                    onClick={() => void requestRevision(selected.id)}
                  >
                    {`Send to Chat${openCount > 0 ? ` (${openCount})` : ""}`}
                  </button>
                </div>
              </div>

              <div className="studio-view-tabs">
                {(["review", "overview", "speaker"] as StudioView[]).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={view === entry ? "active" : ""}
                    onClick={() => setView(entry)}
                  >
                    {VIEW_LABELS[entry]}
                    {entry === "review" && activeReviewCount(selected) > 0
                      ? ` (${activeReviewCount(selected)})`
                      : ""}
                  </button>
                ))}
                <span>Updated {dateLabel(selected.generatedAt)}</span>
              </div>

              {view === "review" && (
                <div className="studio-review-workspace">
                  <div className="studio-preview">
                    {selected.htmlPath ? (
                      <WebPreview
                        relativePath={selected.htmlPath}
                        onOpenExternal={() => void openPath(selected.htmlPath!)}
                      />
                    ) : selected.pdfPath ? (
                      <Suspense fallback={<div className="studio-loading">Loading PDF preview...</div>}>
                        <PdfReader
                          relativePath={selected.pdfPath}
                          initialPage={requestedPage}
                          pageRequestKey={pageRequestKey}
                          annotations={EMPTY_ANNOTATIONS}
                          onOpenExternal={() => void openPath(selected.pdfPath!)}
                          onAddAnnotation={NOOP}
                          onUpdateAnnotation={NOOP}
                          onDeleteAnnotation={NOOP}
                          onRunAi={NOOP_AI}
                          onPageChange={handlePageChange}
                          onDocumentLoaded={handleDocumentLoaded}
                          readOnly
                        />
                      </Suspense>
                    ) : (
                      <div className="studio-welcome">
                        <strong>No viewable result indexed.</strong>
                        <p>
                          Add a PDF result under <code>slides/</code> or an HTML result under{" "}
                          <code>web/</code>, then refresh Studio.
                        </p>
                      </div>
                    )}
                  </div>

                  <aside className="studio-review-panel">
                    <div className="studio-review-panel-head">
                      <div>
                        <strong>Page {readerPage}</strong>
                        <span>{pageCount > 0 ? `of ${pageCount}` : "current page"}</span>
                      </div>
                      <span>{countLabel(currentPageReviews.length, "comment")}</span>
                    </div>
                    <textarea
                      value={reviewDraft}
                      onChange={(event) => setReviewDraft(event.target.value)}
                      placeholder={`What should change on page ${readerPage}?`}
                      aria-label={`Feedback for page ${readerPage}`}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                          event.preventDefault();
                          addCurrentPageReview();
                        }
                      }}
                    />
                    <div className="studio-feedback-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={!reviewDraft.trim()}
                        onClick={addCurrentPageReview}
                      >
                        Add page feedback
                      </button>
                      <span className="studio-kbd-hint">⌘ / Ctrl + ↵</span>
                    </div>

                    <div className="studio-current-reviews">
                      {currentPageReviews.length === 0 ? (
                        <p>No feedback on this page yet.</p>
                      ) : (
                        currentPageReviews.map((review) => renderReviewCard(review))
                      )}
                    </div>

                    <div className="studio-all-reviews-head">
                      <strong>Other page feedback</strong>
                      <span>{otherPageReviews.length}</span>
                    </div>
                    <div className="studio-all-reviews">
                      {otherPageReviews.length === 0 ? (
                        <p>Comments on other pages will appear here.</p>
                      ) : (
                        otherPageReviews.map((review) => renderReviewCard(review, true))
                      )}
                    </div>
                  </aside>
                </div>
              )}

              {view === "overview" && (
                <div className="studio-overview">
                  <section>
                    <label htmlFor="studio-user-notes">Result notes</label>
                    <textarea
                      id="studio-user-notes"
                      value={selected.notes}
                      onChange={(event) => updateArtifact(selected.id, { notes: event.target.value })}
                      placeholder="Persistent notes about this result."
                    />
                  </section>
                  <section>
                    <strong>Files</strong>
                    <div className="studio-files">
                      {[
                        selected.pdfPath,
                        selected.pptxPath,
                        selected.svgPath,
                        selected.htmlPath,
                        selected.texPath,
                        selected.speakerNotesPath,
                      ]
                        .filter((path): path is string => Boolean(path))
                        .map((path) => (
                          <button key={path} type="button" onClick={() => void openPath(path)}>
                            {path}
                          </button>
                        ))}
                    </div>
                  </section>
                  <section className="studio-metadata">
                    <strong>Result metadata</strong>
                    <dl>
                      <dt>Kind</dt><dd>{selected.kind}</dd>
                      <dt>Status</dt><dd>{selected.status}</dd>
                      <dt>Venue</dt><dd>{selected.venue || "Not indexed"}</dd>
                      <dt>Generated</dt><dd>{dateLabel(selected.generatedAt)}</dd>
                    </dl>
                  </section>
                </div>
              )}

              {view === "speaker" && (
                <div className="studio-speaker">
                  <div className="studio-speaker-head">
                    <strong>Speaker Notes</strong>
                    {selected.speakerNotesPath && (
                      <button
                        type="button"
                        onClick={() => void openPath(selected.speakerNotesPath!)}
                      >
                        Open notes file
                      </button>
                    )}
                  </div>
                  {!selected.speakerNotesPath && (
                    <div className="studio-welcome">
                      <strong>No speaker notes indexed.</strong>
                      <p>Speaker notes appear here when the external workflow registers them.</p>
                    </div>
                  )}
                  {speakerNotesError && <div className="studio-review-error">{speakerNotesError}</div>}
                  {selected.speakerNotesPath && !speakerNotesError && (
                    <pre>{speakerNotes || "Loading speaker notes..."}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {presenting && selected?.pdfPath && (
        <Presentation
          relativePath={selected.pdfPath}
          initialPage={readerPage}
          onClose={closePresentation}
        />
      )}
    </div>
  );
}

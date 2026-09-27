import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useKnowledgeStore } from "./knowledgeStore";
import { KNOWLEDGE_COPY } from "./i18n";
import {
  type KnowledgeEvidence,
  type KnowledgeFragment,
  type KnowledgePoint,
  type KnowledgeSearchHit,
} from "./knowledgeTypes";
import "./Knowledge.css";

type KnowledgeView = "fragments" | "review" | "confirmed";

const PAPER_VIEW_IDS: KnowledgeView[] = ["fragments", "review", "confirmed"];

const citation = (item: KnowledgeEvidence): string =>
  item.page ? `${item.paperId} p.${item.page}` : item.paperId;

const pointBelongsToPaper = (point: KnowledgePoint | KnowledgeSearchHit, paperId: string): boolean =>
  point.sourcePaperId === paperId || point.evidence.some((item) => item.paperId === paperId);

function EvidenceList({ evidence }: { evidence: KnowledgeEvidence[] }) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  if (evidence.length === 0) {
    return <p className="kb-evidence-empty">{copy.noLocatableEvidence}</p>;
  }
  return (
    <ul className="kb-evidence">
      {evidence.map((item, index) => (
        <li key={`${item.annotationId ?? item.evidenceId ?? index}`}>
          <span className="kb-cite">[{citation(item)}]</span>
          {item.quote && <span className="kb-quote">"{item.quote}"</span>}
        </li>
      ))}
    </ul>
  );
}

function FragmentCard({ fragment }: { fragment: KnowledgeFragment }) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  return (
    <article className={`kb-fragment-card ${fragment.kind}`}>
      <div className="kb-fragment-head">
        <span className="kb-kind">{copy.fragmentKindLabels[fragment.kind]}</span>
        <span className="kb-cite">
          [{fragment.paperTitle}{fragment.page ? ` p.${fragment.page}` : ""}]
        </span>
      </div>
      <p className="kb-statement">{fragment.title}</p>
      {fragment.text !== fragment.title && <p className="kb-fragment-text">{fragment.text}</p>}
      {fragment.quote && <p className="kb-fragment-quote">"{fragment.quote}"</p>}
      <div className="kb-fragment-meta">
        {fragment.status && <span>{fragment.status}</span>}
        {fragment.source && <span>{fragment.source}</span>}
        {fragment.evidenceIds && fragment.evidenceIds.length > 0 && (
          <span>{copy.evidenceAnchorsCount(fragment.evidenceIds.length)}</span>
        )}
      </div>
    </article>
  );
}

function FragmentList({ fragments }: { fragments: KnowledgeFragment[] }) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  if (fragments.length === 0) {
    return (
      <p className="kb-empty">
        {copy.fragmentListEmpty}
      </p>
    );
  }
  return (
    <section className="kb-fragments" aria-label={copy.fragmentsSectionAriaLabel}>
      <div className="kb-fragment-summary">
        {copy.fragmentSummaryBefore} <strong>{fragments.length}</strong> {copy.fragmentSummaryAfter}
      </div>
      <div className="kb-fragment-list">
        {fragments.map((fragment) => (
          <FragmentCard key={fragment.id} fragment={fragment} />
        ))}
      </div>
    </section>
  );
}

function ReviewCard({
  point,
  index,
  total,
  onConfirm,
  onReject,
  onRefine,
}: {
  point: KnowledgePoint;
  index: number;
  total: number;
  onConfirm: () => void;
  onReject: () => void;
  onRefine: (patch: Partial<Pick<KnowledgePoint, "question" | "answer" | "statement">>) => void;
}) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(point.statement);
  const [answer, setAnswer] = useState(point.answer);

  // Reset the inline editor whenever a different card surfaces.
  useEffect(() => {
    setEditing(false);
    setStatement(point.statement);
    setAnswer(point.answer);
  }, [point.id, point.statement, point.answer]);

  const save = () => {
    onRefine({ statement: statement.trim() || point.statement, answer: answer.trim() || point.answer });
    setEditing(false);
  };

  return (
    <article className="kb-card">
      <div className="kb-card-head">
        {point.kind && <span className="kb-kind">{point.kind}</span>}
        <span className="kb-progress">{copy.progressLabel(index + 1, total)}</span>
      </div>

      {editing ? (
        <div className="kb-edit">
          <label>
            {copy.pointLabel}
            <textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={2} />
          </label>
          <label>
            {copy.answerLabel}
            <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} />
          </label>
          <div className="kb-edit-actions">
            <button type="button" className="kb-primary" onClick={save}>{copy.saveDraft}</button>
            <button type="button" onClick={() => setEditing(false)}>{copy.cancel}</button>
          </div>
        </div>
      ) : (
        <>
          <p className="kb-statement">{point.statement}</p>
          <p className="kb-question"><span>Q</span>{point.question}</p>
          <p className="kb-answer"><span>A</span>{point.answer}</p>
          <EvidenceList evidence={point.evidence} />
        </>
      )}

      {!editing && (
        <div className="kb-card-actions">
          <button type="button" className="kb-confirm" onClick={onConfirm}>
            {copy.confirmAction} <kbd>A</kbd>
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            {copy.editAction} <kbd>E</kbd>
          </button>
          <button type="button" className="kb-reject" onClick={onReject}>
            {copy.rejectAction} <kbd>X</kbd>
          </button>
        </div>
      )}
    </article>
  );
}

function ConfirmedCard({ point }: { point: KnowledgePoint | KnowledgeSearchHit }) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  const relations = point.relations ?? [];
  return (
    <article className="kb-confirmed-card">
      <p className="kb-statement">{point.statement}</p>
      <p className="kb-question"><span>Q</span>{point.question}</p>
      <p className="kb-answer"><span>A</span>{point.answer}</p>
      <EvidenceList evidence={point.evidence} />
      {relations.length > 0 && (
        <ul className="kb-relations">
          {relations.map((relation, index) => (
            <li key={`${relation.dstId}-${index}`}>
              <span className="kb-relation-kind">{relation.kind ?? copy.relatedFallback}</span>
              {relation.statement ?? relation.dstId}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

interface KnowledgeProps {
  initialPaperId?: string;
  initialView?: KnowledgeView;
}

export default function Knowledge({
  initialPaperId,
  initialView = "fragments",
}: KnowledgeProps = {}) {
  const language = useStore((state) => state.language);
  const copy = KNOWLEDGE_COPY[language];
  const currentProject = useStore((state) => state.currentProject);
  const points = useKnowledgeStore((state) => state.points);
  const fragments = useKnowledgeStore((state) => state.fragments);
  const sourcePapers = useKnowledgeStore((state) => state.sourcePapers);
  const loaded = useKnowledgeStore((state) => state.loaded);
  const error = useKnowledgeStore((state) => state.error);
  const generatingPaperId = useKnowledgeStore((state) => state.generatingPaperId);
  const searchQuery = useKnowledgeStore((state) => state.searchQuery);
  const searchHits = useKnowledgeStore((state) => state.searchHits);
  const load = useKnowledgeStore((state) => state.load);
  const generate = useKnowledgeStore((state) => state.generate);
  const confirm = useKnowledgeStore((state) => state.confirm);
  const reject = useKnowledgeStore((state) => state.reject);
  const refine = useKnowledgeStore((state) => state.refine);
  const search = useKnowledgeStore((state) => state.search);

  const [view, setView] = useState<KnowledgeView>(initialView);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [selectedPaper, setSelectedPaper] = useState(initialPaperId ?? "");
  const projectId = currentProject?.id ?? "default";
  useEffect(() => {
    setReviewIndex(0);
    void load(projectId);
  }, [load, projectId]);

  useEffect(() => {
    if (initialPaperId) setSelectedPaper(initialPaperId);
  }, [initialPaperId]);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const scopedPaperId = initialPaperId ?? "";
  const visibleFragments = useMemo(
    () => scopedPaperId ? fragments.filter((fragment) => fragment.paperId === scopedPaperId) : fragments,
    [fragments, scopedPaperId],
  );
  const visiblePoints = useMemo(
    () => scopedPaperId ? points.filter((point) => pointBelongsToPaper(point, scopedPaperId)) : points,
    [points, scopedPaperId],
  );
  const drafts = useMemo(() => visiblePoints.filter((point) => point.status === "draft"), [visiblePoints]);
  const confirmed = useMemo(
    () => visiblePoints.filter((point) => point.status === "confirmed"),
    [visiblePoints],
  );
  const safeIndex = Math.min(reviewIndex, Math.max(0, drafts.length - 1));
  const current = drafts[safeIndex];

  const handleConfirm = useCallback(() => {
    if (current) void confirm(current.id);
  }, [current, confirm]);
  const handleReject = useCallback(() => {
    if (current) void reject(current.id);
  }, [current, reject]);

  // Duolingo-style keyboard triage, only while a card is showing.
  useEffect(() => {
    if (view !== "review" || !current) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (event.key === "a" || event.key === "A" || event.key === "Enter") {
        event.preventDefault();
        handleConfirm();
      } else if (event.key === "x" || event.key === "X") {
        event.preventDefault();
        handleReject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, current, handleConfirm, handleReject]);

  const eligible = sourcePapers.filter((paper) =>
    paper.hasReading && (!initialPaperId || paper.id === initialPaperId),
  );
  const generating = generatingPaperId !== null;
  const selectedPaperValue = eligible.some((paper) => paper.id === selectedPaper)
    ? selectedPaper
    : "";

  const onGenerate = async () => {
    const paperId = selectedPaperValue || eligible[0]?.id;
    if (!paperId) return;
    await generate(paperId);
    setView("review");
    setReviewIndex(0);
  };

  const confirmedList: (KnowledgePoint | KnowledgeSearchHit)[] = searchQuery.trim()
    ? scopedPaperId
      ? searchHits.filter((point) => pointBelongsToPaper(point, scopedPaperId))
      : searchHits
    : confirmed;

  const viewCount = (id: KnowledgeView): number => {
    if (id === "fragments") return visibleFragments.length;
    return id === "review" ? drafts.length : confirmed.length;
  };

  return (
    <div className="kb kb-paper-knowledge">
      <header className="kb-header">
        <div className="kb-title">
          <h1>{copy.paperKnowledgeTitle}</h1>
          <p>{copy.paperKnowledgeDescription}</p>
        </div>
        <div className="kb-views">
          {PAPER_VIEW_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`kb-view-tab${view === id ? " active" : ""}`}
              onClick={() => setView(id)}
            >
              {copy.viewLabels[id]}
              <span className="kb-count">{viewCount(id)}</span>
            </button>
          ))}
        </div>
      </header>

      {error && <div className="kb-banner">{error}</div>}

      <div className="kb-generator">
        <select
          value={selectedPaperValue}
          onChange={(event) => setSelectedPaper(event.target.value)}
          disabled={eligible.length === 0 || generating}
        >
          {eligible.length === 0 ? (
            <option value="">{copy.noEligiblePapers}</option>
          ) : (
            <>
              <option value="">{copy.selectPaperPlaceholder}</option>
              {eligible.map((paper) => (
                <option key={paper.id} value={paper.id}>{paper.title}</option>
              ))}
            </>
          )}
        </select>
        <button
          type="button"
          className="kb-primary"
          onClick={() => void onGenerate()}
          disabled={eligible.length === 0 || generating}
        >
          {generating ? copy.generatingLabel : copy.generateAction}
        </button>
      </div>

      {view === "fragments" && <FragmentList fragments={visibleFragments} />}

      {view === "review" && (
        <section className="kb-review">
          {!loaded ? (
            <p className="kb-empty">{copy.loadingLabel}</p>
          ) : drafts.length === 0 ? (
            <p className="kb-empty">
              {copy.noDraftsEmptyState}
            </p>
          ) : current ? (
            <ReviewCard
              key={current.id}
              point={current}
              index={safeIndex}
              total={drafts.length}
              onConfirm={handleConfirm}
              onReject={handleReject}
              onRefine={(patch) => void refine(current.id, patch)}
            />
          ) : null}
        </section>
      )}

      {view === "confirmed" && (
        <section className="kb-confirmed">
          <input
            type="search"
            className="kb-search"
            placeholder={copy.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => void search(event.target.value)}
          />
          {confirmedList.length === 0 ? (
            <p className="kb-empty">
              {searchQuery.trim()
                ? copy.noSearchMatches
                : copy.noConfirmedYet}
            </p>
          ) : (
            <div className="kb-confirmed-list">
              {confirmedList.map((point) => (
                <ConfirmedCard key={point.id} point={point} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

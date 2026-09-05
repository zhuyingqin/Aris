import { useMemo, useState } from "react";
import type { TypesetProposalDecision } from "../api/tauri";
import { externalTextDiff, type ExternalDiffChange } from "./externalChangeDiff";

export type ExternalWholeFileDecision = "incoming" | "local";

export interface ExternalChangeReviewCopy {
  title: (name: string) => string;
  description: string;
  localDraftWarning: string;
  additions: (count: number) => string;
  deletions: (count: number) => string;
  showChanges: string;
  hideChanges: string;
  accept: string;
  reject: string;
  /** Same answer, already recorded — the label the button wears once staged. */
  answeredAccept: string;
  answeredReject: string;
  /**
   * Neither button carries the recorded answer: the file was answered change by
   * change. Without a word for that state the bar wore the unanswered face.
   */
  answeredPartial: string;
  accepting: string;
  rejecting: string;
  apply: string;
  applying: string;
  acceptOne: string;
  rejectOne: string;
  acceptedOne: string;
  rejectedOne: string;
  undoOne: string;
  pending: string;
  oldLine: string;
  newLine: string;
  reviewInEditor: string;
  viewDraft: string;
  previousChange: string;
  nextChange: string;
  changePosition: (current: number, total: number) => string;
  /** "— / 3": the caret is not inside any of them. */
  changePositionUnknown: (total: number) => string;
  /**
   * How many changes carry an answer.
   *
   * Deliberately not a bare "n / m": that pair sits beside the previous/next
   * arrows and between the numbered hunks, where it reads as "which one am I
   * on" — a position that never moved no matter how far the reviewer paged.
   */
  answeredCount: (answered: number, total: number) => string;
  reviewed: (remaining: number) => string;
  reviewNext: string;
  edited: string;
  discardEdits: string;
  tooLargeTitle: string;
  tooLargeDetail: (added: number, removed: number, approximate?: boolean) => string;
  takeIncoming: string;
  keepLocal: string;
  compare: string;
  closeCompare: string;
  localVersion: string;
  incomingVersion: string;
  compareTruncated: string;
}

export interface ExternalChangeReviewProps {
  name: string;
  current: string;
  incoming: string;
  dirty: boolean;
  busy: "accept" | "reject" | "apply" | null;
  decisions: TypesetProposalDecision[];
  /** The answer for this file is already recorded in the project change set. */
  staged: boolean;
  /** Files in the same change set that are still unanswered. */
  remaining: number;
  actor: string;
  origin: string;
  /**
   * Repeat the provenance here. The project banner above already names it for
   * the whole change set, and showing it twice invited the two rows to
   * disagree — "Changed by Chat" over "Changed by an external program" for one
   * and the same write.
   */
  showActor: boolean;
  copy: ExternalChangeReviewCopy;
  onAccept: () => void;
  onReject: () => void;
  onApply: () => void;
  onNext: (() => void) | null;
  /** The reviewer typed into the proposed text instead of only answering it. */
  edited?: boolean;
  onDiscardEdits?: () => void;
  /** Move the editor caret through the changes this banner is counting. */
  onPreviousChange?: (() => void) | null;
  onNextChange?: (() => void) | null;
  /**
   * 1-based index of the change the caret is sitting in, or null when it is
   * between them. This is what the arrows move, so it is shown between them.
   */
  currentChange?: number | null;
  /** Whether the per-change controls are visible in the editor. */
  changesExpanded?: boolean;
  onToggleChanges?: () => void;
  /**
   * The concrete groups represented by the compact editor markers.  They are
   * also rendered in the review bar after "Show changes" is pressed: Visual
   * mode can replace a source line with a heading, formula, or other atomic
   * widget, which makes an editor-anchored control easy to paint but not
   * reliably actionable.
   */
  reviewChanges?: readonly ExternalDiffChange[];
  onDecideChange?: (index: number, decision: TypesetProposalDecision) => void;
  /** No reviewable hunks exist; offer the whole-file choice instead. */
  tooLargeToChunk?: boolean;
  /** The selected complete-file answer, if one has already been staged. */
  wholeFileDecision?: ExternalWholeFileDecision | null;
  /**
   * The answer this file already carries in the change set.
   *
   * Without it an answered file offered the same two buttons in the same state
   * as an unanswered one, and pressing the one that was already recorded
   * re-staged identical bytes: a click with no effect anywhere on screen, which
   * reads as a broken button rather than as "you already said that".
   */
  stagedDecision?: "accept" | "reject" | "partial" | null;
  onTakeIncoming?: () => void;
  onKeepLocal?: () => void;
  added?: number;
  removed?: number;
  approximateStats?: boolean;
  dockedWithChangeSet?: boolean;
}

const COMPARE_HEAD_CHARS = 120_000;
const COMPARE_TAIL_CHARS = 40_000;

function boundedComparison(value: string, omittedLabel: string): { text: string; truncated: boolean } {
  if (value.length <= COMPARE_HEAD_CHARS + COMPARE_TAIL_CHARS) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, COMPARE_HEAD_CHARS)}\n\n… ${omittedLabel} …\n\n${value.slice(-COMPARE_TAIL_CHARS)}`,
    truncated: true,
  };
}

export default function TypesetExternalChangeReview({
  name,
  current,
  incoming,
  dirty,
  busy,
  decisions,
  staged,
  remaining,
  actor,
  origin,
  showActor,
  copy,
  onAccept,
  onReject,
  onApply,
  onNext,
  edited = false,
  onDiscardEdits,
  onPreviousChange = null,
  onNextChange = null,
  currentChange = null,
  changesExpanded = false,
  onToggleChanges,
  reviewChanges = [],
  onDecideChange,
  tooLargeToChunk = false,
  wholeFileDecision = null,
  stagedDecision = null,
  onTakeIncoming,
  onKeepLocal,
  added,
  removed,
  approximateStats = false,
  dockedWithChangeSet = false,
}: ExternalChangeReviewProps) {
  const [compareOpen, setCompareOpen] = useState(false);
  const fallbackDiff = useMemo(() => (
    added === undefined || removed === undefined ? externalTextDiff(current, incoming) : null
  ), [added, current, incoming, removed]);
  const addedCount = added ?? fallbackDiff?.added ?? 0;
  const removedCount = removed ?? fallbackDiff?.removed ?? 0;
  const localComparison = useMemo(
    () => compareOpen
      ? boundedComparison(current, copy.compareTruncated)
      : { text: "", truncated: false },
    [compareOpen, copy.compareTruncated, current],
  );
  const incomingComparison = useMemo(
    () => compareOpen
      ? boundedComparison(incoming, copy.compareTruncated)
      : { text: "", truncated: false },
    [compareOpen, copy.compareTruncated, incoming],
  );
  // A large proposal intentionally has no hunk decisions. Its unresolved state
  // is the complete-file choice, not the empty hunk list.
  const unresolved = tooLargeToChunk
    ? !staged && wholeFileDecision === null
    : decisions.length === 0 || decisions.some((decision) => decision === "pending");
  // Apply is for an answered file whose answer has not reached the change set
  // yet (a proposal restored from disk, or a project with no change set at
  // all). Once the answer is staged the button resolves to the same bytes the
  // transaction already holds, so offering it again only reads as a dead click
  // — unless the reviewer has since edited the text, which is new content the
  // staged answer does not carry.
  const canApply = !unresolved && (!staged || edited);
  const canNavigate = !tooLargeToChunk && decisions.length > 1;

  return (
    <section
      className={`typeset-external-review${staged ? " reviewed" : ""}${edited ? " edited" : ""}${dockedWithChangeSet ? " docked" : ""}`}
      aria-label={copy.title(name)}
    >
      <div className="typeset-external-review-head">
        <div className="typeset-external-review-summary">
          <strong className="typeset-external-review-name">{name}</strong>
          {showActor && (
            <span className="typeset-external-review-audit" title={`${actor} · ${origin}`}>{actor}</span>
          )}
          {dirty && <span className="typeset-external-review-warning" title={copy.localDraftWarning}>●</span>}
          {/* The recorded answer, in words. `accept` and `reject` also travel on
              the button that carries them, but a file answered change by change
              — or one the backend could only call `partial` — has no button to
              light up, and without this chip its bar was indistinguishable from
              an unanswered one. */}
          {staged && stagedDecision && (
            <span className={`typeset-external-review-answer ${stagedDecision}`}>
              {stagedDecision === "accept"
                ? copy.answeredAccept
                : stagedDecision === "reject"
                  ? copy.answeredReject
                  : copy.answeredPartial}
            </span>
          )}
          <span className="typeset-external-review-guidance">{staged
            ? copy.reviewed(remaining)
            // "0 / 0" would read as "nothing changed" on the one review where
            // the most has changed.
            : tooLargeToChunk
              ? copy.tooLargeTitle
              : copy.answeredCount(
                decisions.filter((decision) => decision !== "pending").length,
                decisions.length,
              )}</span>
          {edited && (
            <span className="typeset-external-review-edited">
              {copy.edited}
              {onDiscardEdits && (
                <button type="button" disabled={busy !== null} onClick={onDiscardEdits}>
                  {copy.discardEdits}
                </button>
              )}
            </span>
          )}
        </div>
        <div className="typeset-external-review-actions">
          <span className="typeset-external-review-stat added">+{copy.additions(addedCount)}</span>
          <span className="typeset-external-review-stat removed">−{copy.deletions(removedCount)}</span>
          {canNavigate && (
            <span className="typeset-external-review-nav">
              <button
                type="button"
                aria-label={copy.previousChange}
                title={copy.previousChange}
                disabled={!onPreviousChange}
                onClick={() => onPreviousChange?.()}
              >
                ↑
              </button>
              {/* Where the arrows have got to. It belongs between them: the same
                  "n / m" on the summary side counted answers, so paging through
                  the file left it sitting still and reading as broken. */}
              <span className="typeset-external-review-nav-position">
                {currentChange === null
                  ? copy.changePositionUnknown(decisions.length)
                  : copy.changePosition(currentChange, decisions.length)}
              </span>
              <button
                type="button"
                aria-label={copy.nextChange}
                title={copy.nextChange}
                disabled={!onNextChange}
                onClick={() => onNextChange?.()}
              >
                ↓
              </button>
            </span>
          )}
          {!tooLargeToChunk && decisions.length > 0 && onToggleChanges && (
            <button
              className="review-surface"
              type="button"
              aria-expanded={changesExpanded}
              onClick={onToggleChanges}
            >
              {changesExpanded ? copy.hideChanges : copy.showChanges}
            </button>
          )}
          {tooLargeToChunk ? (
            <>
              {!staged && (
                <>
                  <button
                    className={`reject${wholeFileDecision === "local" ? " selected" : ""}`}
                    type="button"
                    aria-pressed={wholeFileDecision === "local"}
                    disabled={busy !== null || !onKeepLocal}
                    onClick={() => onKeepLocal?.()}
                  >
                    {busy === "reject" ? `${copy.keepLocal}…` : copy.keepLocal}
                  </button>
                  <button
                    className={`accept${wholeFileDecision === "incoming" ? " selected" : ""}`}
                    type="button"
                    aria-pressed={wholeFileDecision === "incoming"}
                    disabled={busy !== null || !onTakeIncoming}
                    onClick={() => onTakeIncoming?.()}
                  >
                    {busy === "accept" ? `${copy.takeIncoming}…` : copy.takeIncoming}
                  </button>
                </>
              )}
              <button className="review-surface" type="button" onClick={() => setCompareOpen(true)}>
                {copy.compare}
              </button>
            </>
          ) : (
            <>
              {/* An answered file marks the answer it carries. The pair stays
                  live — changing your mind is the only way back — but pressing
                  the one already recorded no longer looks like a dead click. */}
              <button
                className={`reject${stagedDecision === "reject" ? " selected" : ""}`}
                type="button"
                aria-pressed={staged ? stagedDecision === "reject" : undefined}
                title={stagedDecision === "reject" ? copy.answeredReject : copy.reject}
                disabled={busy !== null}
                onClick={onReject}
              >
                {busy === "reject" ? copy.rejecting : stagedDecision === "reject" ? copy.answeredReject : copy.reject}
              </button>
              <button
                className={`accept${stagedDecision === "accept" ? " selected" : ""}`}
                type="button"
                aria-pressed={staged ? stagedDecision === "accept" : undefined}
                title={stagedDecision === "accept" ? copy.answeredAccept : copy.accept}
                disabled={busy !== null}
                onClick={onAccept}
              >
                {busy === "accept" ? copy.accepting : stagedDecision === "accept" ? copy.answeredAccept : copy.accept}
              </button>
            </>
          )}
          {!tooLargeToChunk && canApply && (
            <button className="apply" type="button" disabled={busy !== null} onClick={onApply}>
              {busy === "apply" ? copy.applying : copy.apply}
            </button>
          )}
          {staged && onNext && (
            <button className="apply" type="button" disabled={busy !== null} onClick={onNext}>
              {copy.reviewNext}
            </button>
          )}
        </div>
      </div>
      {tooLargeToChunk && !staged && (
        <p className="typeset-external-review-toolarge">
          {copy.tooLargeDetail(addedCount, removedCount, approximateStats || Boolean(fallbackDiff?.countsApproximate))}
        </p>
      )}
      {changesExpanded && !tooLargeToChunk && reviewChanges.length > 0 && (
        <section className="typeset-external-review-drawer" aria-label={`${name} changes`}>
          <ol className="typeset-external-review-hunks">
            {reviewChanges.map((change, index) => {
              const decision = decisions[index] ?? "pending";
              const position = copy.changePosition(index + 1, reviewChanges.length);
              const answered = decision !== "pending";
              return (
                <li key={change.id} className={`typeset-external-review-hunk decision-${decision}`}>
                  <div className="typeset-external-review-hunk-head">
                    <span>{position}</span>
                    {answered && (
                      <span className="typeset-external-review-hunk-state">
                        {decision === "accept" ? copy.acceptedOne : copy.rejectedOne}
                      </span>
                    )}
                    <div className="typeset-external-review-hunk-actions">
                      {answered ? (
                        <button
                          type="button"
                          disabled={busy !== null || !onDecideChange}
                          onClick={() => onDecideChange?.(index, "pending")}
                        >
                          {copy.undoOne}
                        </button>
                      ) : (
                        <>
                          <button
                            className="reject"
                            type="button"
                            disabled={busy !== null || !onDecideChange}
                            onClick={() => onDecideChange?.(index, "reject")}
                          >
                            {copy.rejectOne}
                          </button>
                          <button
                            className="accept"
                            type="button"
                            disabled={busy !== null || !onDecideChange}
                            onClick={() => onDecideChange?.(index, "accept")}
                          >
                            {copy.acceptOne}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <pre className="typeset-external-review-hunk-diff" aria-label={`${position} diff`}>
                    {change.lines.map((line, lineIndex) => (
                      <code key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${lineIndex}`} className={line.kind}>
                        <i>{line.oldLine ?? ""}</i>
                        <i>{line.newLine ?? ""}</i>
                        <span>{line.kind === "added" ? "+" : "−"} {line.text || " "}</span>
                      </code>
                    ))}
                  </pre>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {compareOpen && tooLargeToChunk && (
        <div className="typeset-external-review-compare" role="dialog" aria-modal="true" aria-label={copy.compare}>
          <div className="typeset-external-review-compare-head">
            <strong>{copy.compare}</strong>
            <button
              type="button"
              aria-label={copy.closeCompare}
              onClick={() => setCompareOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="typeset-external-review-compare-columns">
            <section aria-label={copy.localVersion}>
              <h3>{copy.localVersion}</h3>
              <pre>{localComparison.text}</pre>
            </section>
            <section aria-label={copy.incomingVersion}>
              <h3>{copy.incomingVersion}</h3>
              <pre>{incomingComparison.text}</pre>
            </section>
          </div>
          {(localComparison.truncated || incomingComparison.truncated) && (
            <p className="typeset-external-review-compare-note">{copy.compareTruncated}</p>
          )}
        </div>
      )}
    </section>
  );
}

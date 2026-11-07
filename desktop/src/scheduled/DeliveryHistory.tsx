import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ScheduledDeliveryHistory, ScheduledDeliveryView } from "../types";
import type { SCHEDULED_TASKS_COPY } from "./i18n";
import { formatInZone } from "./scheduleFormat";

type ScheduledTasksCopy = (typeof SCHEDULED_TASKS_COPY)["cn"];

/** The conversation a delivery's run used, once a card exists for it. */
function deliverySession(delivery: ScheduledDeliveryView): string | null {
  if (!delivery.outcome || delivery.outcome.status === "missing") return null;
  return delivery.outcome.sessionId ?? delivery.targetSessionId ?? null;
}

/**
 * One row per occurrence, with the delivery and the outcome side by side and
 * never merged: "queued" is all a receipt can prove, and only the work task
 * can say whether the run finished and what the independent Reviewer made of
 * it.
 */
export function DeliveryHistory({
  history,
  loading,
  timeZone,
  language,
  copy,
  onOpenSession,
}: {
  history: ScheduledDeliveryHistory | null;
  loading: boolean;
  timeZone: string;
  language: Language;
  copy: ScheduledTasksCopy;
  onOpenSession: (sessionId: string) => void;
}) {
  const deliveries = history?.deliveries ?? [];
  return (
    <div className="sched-history">
      <p className="sched-note">{copy.historyNote}</p>
      {loading && !history ? (
        <p className="sched-history-empty">{copy.historyLoading}</p>
      ) : deliveries.length === 0 ? (
        <p className="sched-history-empty">{copy.historyEmpty}</p>
      ) : (
        <ol className="sched-history-list" aria-label={copy.historySection}>
          {deliveries.map((delivery) => {
            const session = deliverySession(delivery);
            const outcome = delivery.outcome;
            return (
              <li className={`sched-history-item status-${delivery.status}`} key={delivery.key}>
                <div className="sched-history-when">
                  <span className="sched-history-time">
                    {formatInZone(delivery.occurrenceAt, timeZone, language, { withYear: true })}
                  </span>
                  <span className="sched-history-trigger">
                    {copy.triggers[delivery.trigger] ?? delivery.trigger}
                  </span>
                </div>
                <div className="sched-history-cols">
                  <div className="sched-history-col" data-testid="delivery">
                    <span className="sched-history-label">{copy.historyDeliveryLabel}</span>
                    <span className={`sched-history-pill delivery-${delivery.status}`}>
                      {copy.deliveryStatus[delivery.status] ?? delivery.status}
                    </span>
                    {delivery.coalesced > 0 && (
                      <span className="sched-history-meta">{copy.historyCoalesced(delivery.coalesced)}</span>
                    )}
                    {delivery.recovered && <span className="sched-history-meta">{copy.historyRecovered}</span>}
                    {delivery.error && delivery.status !== "queued" && (
                      <span className="sched-history-error" title={delivery.error}>{delivery.error}</span>
                    )}
                  </div>
                  <div className="sched-history-col" data-testid="outcome">
                    <span className="sched-history-label">{copy.historyOutcomeLabel}</span>
                    {outcome ? (
                      <>
                        <span className={`sched-history-pill outcome-${outcome.status}`}>
                          {copy.outcomeStatus[outcome.status] ?? outcome.status}
                        </span>
                        {outcome.reviewVerdict && (
                          <span className={`sched-history-pill verdict-${outcome.reviewVerdict}`}>
                            {copy.verdicts[outcome.reviewVerdict] ?? outcome.reviewVerdict}
                            {outcome.reviewExhausted ? ` · ${copy.reviewExhausted}` : ""}
                          </span>
                        )}
                        {outcome.error && (
                          <span className="sched-history-error" title={outcome.error}>{outcome.error}</span>
                        )}
                      </>
                    ) : (
                      <span className="sched-history-meta">{copy.noOutcome}</span>
                    )}
                  </div>
                </div>
                {session && (
                  <button className="sched-history-open" onClick={() => onOpenSession(session)} type="button">
                    <SvgIcon name="externalLink" size={12} />
                    <span>{copy.historyOpenSession}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {history?.earlierPruned && <p className="sched-history-meta">{copy.historyPruned}</p>}
    </div>
  );
}

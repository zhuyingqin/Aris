import { useEffect, useState } from "react";
import type { ChatTurn } from "../types";
import { useStore } from "../store";
import { CHAT_COPY } from "./i18n";
import {
  compactionElapsedMs,
  formatWaitClock,
  MODEL_WAIT_HINT_AFTER_MS,
  MODEL_WAIT_STALLED_AFTER_MS,
  modelWaitElapsedMs,
} from "./modelWait";
import "./ModelWaitIndicator.css";

/** "Waiting for the model · 2:31" under a streaming turn that has gone quiet.
 * Long reasoning behind a relay gateway can be silent for minutes; without a
 * moving clock that is indistinguishable from a hang. While the backend is
 * compacting history first, it says that instead, since no model is being
 * waited on yet. */
export default function ModelWaitIndicator({ turn }: { turn: ChatTurn }) {
  const language = useStore((state) => state.language);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const copy = CHAT_COPY[language];
  const compacting = compactionElapsedMs(turn, now);
  if (compacting != null) {
    return (
      <WaitStatus label={copy.compactingContext} elapsed={compacting} hint={copy.compactionHint} />
    );
  }
  const elapsed = modelWaitElapsedMs(turn, now);
  if (elapsed == null) return null;
  const hint = elapsed >= MODEL_WAIT_STALLED_AFTER_MS
    ? copy.modelWaitStalledHint
    : elapsed >= MODEL_WAIT_HINT_AFTER_MS
      ? copy.modelWaitHint
      : null;
  return <WaitStatus label={copy.waitingForModel} elapsed={elapsed} hint={hint} />;
}

function WaitStatus({ label, elapsed, hint }: { label: string; elapsed: number; hint: string | null }) {
  return (
    // No live region: a per-second announcement would drown a screen reader.
    <div className="chat-model-wait">
      <div className="chat-model-wait-line">
        <span className="chat-model-wait-pulse" aria-hidden="true" />
        <span>{label}</span>
        <span className="chat-model-wait-clock">{formatWaitClock(elapsed)}</span>
      </div>
      {hint && <div className="chat-model-wait-hint">{hint}</div>}
    </div>
  );
}

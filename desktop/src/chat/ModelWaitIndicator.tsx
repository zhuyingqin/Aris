import { useEffect, useState } from "react";
import type { ChatTurn } from "../types";
import { useStore } from "../store";
import { CHAT_COPY } from "./i18n";
import { formatWaitClock, MODEL_WAIT_HINT_AFTER_MS, modelWaitElapsedMs } from "./modelWait";
import "./ModelWaitIndicator.css";

/** "Waiting for the model · 2:31" under a streaming turn that has gone quiet.
 * Long reasoning behind a relay gateway can be silent for minutes; without a
 * moving clock that is indistinguishable from a hang. */
export default function ModelWaitIndicator({ turn }: { turn: ChatTurn }) {
  const language = useStore((state) => state.language);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = modelWaitElapsedMs(turn, now);
  if (elapsed == null) return null;
  const copy = CHAT_COPY[language];
  return (
    // No live region: a per-second announcement would drown a screen reader.
    <div className="chat-model-wait">
      <div className="chat-model-wait-line">
        <span className="chat-model-wait-pulse" aria-hidden="true" />
        <span>{copy.waitingForModel}</span>
        <span className="chat-model-wait-clock">{formatWaitClock(elapsed)}</span>
      </div>
      {elapsed >= MODEL_WAIT_HINT_AFTER_MS && (
        <div className="chat-model-wait-hint">{copy.modelWaitHint}</div>
      )}
    </div>
  );
}

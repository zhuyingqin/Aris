import type { ChatBlock, ChatTurn } from "../types";

/** A streaming turn silent for this long starts showing how long it has been
 * waiting. Shorter gaps are ordinary token pacing and would only flicker. */
export const MODEL_WAIT_VISIBLE_AFTER_MS = 3_000;

/** Past this, explain that the wait is expected rather than a hang: behind a
 * relay gateway an xhigh/max reasoning model can stay silent for minutes. */
export const MODEL_WAIT_HINT_AFTER_MS = 60_000;

// Turn blocks are replaced, never mutated, on every streamed change, so the
// first time an array is seen is the turn's latest visible activity. Weak keys
// make finished turns free; living outside component state keeps the clock
// right across virtualized unmounts and session switches.
const activitySince = new WeakMap<ChatBlock[], number>();

/** Record `blocks` as the turn's newest visible state (first sighting wins). */
export function noteTurnActivity(blocks: ChatBlock[], at = Date.now()): void {
  if (!activitySince.has(blocks)) activitySince.set(blocks, at);
}

function turnActivitySince(blocks: ChatBlock[], now: number): number {
  noteTurnActivity(blocks, now);
  return activitySince.get(blocks) ?? now;
}

/** The turn is visibly waiting on something other than the model: a running
 * tool, a question or permission prompt, the Reviewer, or a retry backoff.
 * Each of those already shows its own live status. */
export function turnAwaitsNonModelWork(blocks: ChatBlock[], now: number): boolean {
  for (const block of blocks) {
    if (block.kind === "tool" && block.output === undefined) return true;
    if (block.kind === "permission" && (block.status ?? "pending") === "pending") return true;
  }
  const last = blocks[blocks.length - 1];
  if (last?.kind === "review") return last.phase === "reviewing" || last.phase === "revising";
  if (last?.kind === "notice" && last.retry?.resumeAt != null) return last.retry.resumeAt > now;
  return false;
}

/** How long the turn has been waiting on the model, or `null` when nothing
 * should be shown. */
export function modelWaitElapsedMs(turn: ChatTurn, now: number): number | null {
  if (turn.role !== "assistant" || !turn.streaming) return null;
  if (turnAwaitsNonModelWork(turn.blocks, now)) return null;
  const elapsed = now - turnActivitySince(turn.blocks, now);
  return elapsed >= MODEL_WAIT_VISIBLE_AFTER_MS ? elapsed : null;
}

/** Stopwatch format: `0:07`, `2:31`, `1:04:09`. */
export function formatWaitClock(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

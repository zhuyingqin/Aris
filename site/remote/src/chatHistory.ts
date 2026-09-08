import type { RemoteTranscriptMessage } from "./chatBlocks";

function transcriptMessageKey(message: RemoteTranscriptMessage): string {
  return JSON.stringify([message.role, message.text, message.blocks]);
}

/**
 * Finds the older prefix in a larger newest-first transcript window.
 *
 * A live desktop turn may have appeared after the first window was rendered,
 * so the current window is matched as a contiguous range rather than assumed
 * to be the absolute suffix. Searching backwards selects the newest matching
 * range when a conversation contains identical repeated messages.
 */
export function olderTranscriptPrefix(
  expanded: readonly RemoteTranscriptMessage[],
  current: readonly RemoteTranscriptMessage[],
): RemoteTranscriptMessage[] | null {
  if (current.length === 0) return [...expanded];
  if (expanded.length < current.length) return null;

  const expandedKeys = expanded.map(transcriptMessageKey);
  const currentKeys = current.map(transcriptMessageKey);
  for (let start = expandedKeys.length - currentKeys.length; start >= 0; start -= 1) {
    if (currentKeys.every((key, offset) => expandedKeys[start + offset] === key)) {
      return expanded.slice(0, start);
    }
  }
  return null;
}

/** Keeps the same visible content anchored after older nodes are prepended. */
export function anchoredScrollTop(
  currentScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  return Math.max(0, currentScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight));
}

/**
 * How near the bottom still counts as watching the stream. A reader who
 * scrolled up to re-read something is deliberately behind and must be left
 * alone; this band absorbs the sub-pixel and rounding drift that a phone's
 * momentum scrolling leaves behind when they really are at the bottom.
 */
export const CHAT_LOG_FOLLOW_THRESHOLD_PX = 96;

/**
 * Whether a growing transcript should keep scrolling itself to the bottom.
 *
 * Must be sampled *before* the new content is rendered: once the turn has
 * grown, the distance reflects that growth rather than where the reader chose
 * to be, and every stream would look like it had been abandoned.
 */
export function shouldFollowChatLogBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = CHAT_LOG_FOLLOW_THRESHOLD_PX,
): boolean {
  // A transcript shorter than its viewport has no scroll position to defend.
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

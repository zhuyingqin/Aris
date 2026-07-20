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

import type { VirtualItem } from "@tanstack/react-virtual";
import type { ChatTurn } from "../types";

/**
 * Height bookkeeping for the virtualized transcript.
 *
 * Every row the virtualizer has not measured yet contributes its *estimate* to
 * the total height. A flat estimate therefore makes the scrollbar a work of
 * fiction on a long conversation and rewrites it continuously as rows are
 * measured, which is what a reader sees as a jumping scrollbar. The numbers
 * below are the rendered chrome of each block kind, so an unmeasured row starts
 * within a line or two of its real height instead of an order of magnitude off.
 */
const TURN_CHROME = 48;
const COLLAPSED_TOOL_ROW = 34;
const RUNNING_TOOL_ROW = 120;
const TOOL_IMAGE_BLOCK = 240;
const ATTACHMENT_ROW = 30;
const NOTICE_ROW = 34;
const REVIEW_ROW = 52;
const PERMISSION_CARD = 96;
const COLLAPSED_THINKING_ROW = 32;
const LINE_HEIGHT = 23;
/** Columns in the 820px message body at the transcript's own font size. */
const TEXT_COLUMNS = 92;
const MIN_TURN_SIZE = 56;
/** Beyond this the estimate stops helping; the real measurement lands anyway. */
const MAX_TURN_SIZE = 4_000;
/** Only used when a turn is missing entirely (a torn render). */
export const FALLBACK_TURN_SIZE = 180;

// CJK glyphs occupy two columns each, so counting raw `String.length` would
// under-estimate a Chinese paragraph by half and leave every Chinese turn's
// first paint short - the exact class of bug that "characters as a threshold"
// keeps producing in this codebase. Written as escapes so the ranges stay
// readable and survive any editor's encoding.
const WIDE_GLYPH_RE = new RegExp(
  "["
  + "\\u1100-\\u115f" // Hangul Jamo
  + "\\u2e80-\\u303e" // CJK radicals, Kangxi, CJK symbols and punctuation
  + "\\u3041-\\u33ff" // Kana, Bopomofo, Hangul compatibility, CJK compat
  + "\\u3400-\\u4dbf" // CJK Unified Ideographs Extension A
  + "\\u4e00-\\u9fff" // CJK Unified Ideographs
  + "\\ua000-\\ua4cf" // Yi
  + "\\uac00-\\ud7a3" // Hangul syllables
  + "\\uf900-\\ufaff" // CJK compatibility ideographs
  + "\\ufe30-\\ufe4f" // CJK compatibility forms
  + "\\uff00-\\uff60" // Fullwidth ASCII variants
  + "\\uffe0-\\uffe6" // Fullwidth symbols
  + "]",
  "g",
);

export function displayColumns(line: string): number {
  const wide = line.match(WIDE_GLYPH_RE)?.length ?? 0;
  return line.length + wide;
}

export function wrappedTextHeight(text: string, columns = TEXT_COLUMNS): number {
  if (!text) return 0;
  let lines = 0;
  // Hard breaks open a new line box however short the line is, so they are
  // counted per line rather than by dividing the whole length by the column.
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil(displayColumns(line) / columns));
  }
  return lines * LINE_HEIGHT;
}

/** Cheap "did this tool render an image" test. Bounded because a tool output
 *  can be hundreds of KB and this runs for every unmeasured row. */
function looksLikeImageTool(output: string | undefined): boolean {
  if (!output) return false;
  return /\.(?:png|jpe?g|gif|webp|bmp)\b/i.test(output.slice(0, 2_000));
}

export function estimateTurnSize(turn: ChatTurn | undefined): number {
  if (!turn) return FALLBACK_TURN_SIZE;
  let height = TURN_CHROME;
  height += (turn.attachments?.length ?? 0) * ATTACHMENT_ROW;
  for (const block of turn.blocks) {
    switch (block.kind) {
      case "text":
        height += wrappedTextHeight(block.text);
        break;
      case "thinking":
        // Collapsed once the turn settles; while streaming it is revealed but
        // its body is a bounded scroller, so the row height stays bounded.
        height += COLLAPSED_THINKING_ROW;
        break;
      case "notice":
        height += NOTICE_ROW + wrappedTextHeight(block.message);
        break;
      case "review":
        height += REVIEW_ROW;
        break;
      case "permission":
        height += PERMISSION_CARD;
        break;
      case "tool":
        // Tool cards render collapsed, so their output size does not drive the
        // row height - only a live progress view or an attached image does.
        height += block.output === undefined ? RUNNING_TOOL_ROW : COLLAPSED_TOOL_ROW;
        if (looksLikeImageTool(block.output)) height += TOOL_IMAGE_BLOCK;
        break;
    }
  }
  return Math.min(MAX_TURN_SIZE, Math.max(MIN_TURN_SIZE, Math.round(height)));
}

/**
 * The virtualizer's measurement cache is keyed by item key, so the key has to
 * survive everything that can happen to a row in place.
 *
 * A large saved turn arrives as a placeholder whose id is synthetic
 * (`<session>-large-turn-<n>`, see `large_turn_placeholder` in sessions.rs) and
 * is replaced by the real turn, which carries its own id. Keying on `turn.id`
 * orphaned the measured height at the exact moment the row grew from a one-line
 * notice into a multi-thousand-pixel turn, so the row fell back to its estimate
 * and shifted everything below it. The omitted slot keeps its absolute turn
 * index instead, which is stable across hydration *and* across prepends.
 */
export function turnVirtualKey(turn: ChatTurn | undefined, index: number): string | number {
  if (!turn) return index;
  if (turn.omittedTurnIndex != null) return `omitted:${turn.omittedTurnIndex}`;
  return turn.id;
}

/**
 * Measured row heights, kept per session so reopening a conversation does not
 * re-estimate a transcript this process already measured. `ChatThread` is
 * remounted per session (`key={currentId}`), so the cache has to outlive the
 * component; it is deliberately in-memory only - a stale height from a previous
 * app run would be worse than an estimate.
 */
const SESSION_LIMIT = 12;
const snapshots = new Map<string, VirtualItem[]>();

export function readTurnMeasurements(sessionId: string): VirtualItem[] {
  const stored = snapshots.get(sessionId);
  // A copy: the virtualizer adopts this array as its own measurement cache.
  return stored ? stored.map((item) => ({ ...item })) : [];
}

export function writeTurnMeasurements(sessionId: string, items: VirtualItem[]): void {
  if (items.length === 0) return;
  snapshots.delete(sessionId);
  snapshots.set(sessionId, items);
  while (snapshots.size > SESSION_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function clearTurnMeasurements(sessionId?: string): void {
  if (sessionId === undefined) snapshots.clear();
  else snapshots.delete(sessionId);
}

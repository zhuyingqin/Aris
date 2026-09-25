import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { ChatTurn } from "../types";
import ErrorBoundary from "../ErrorBoundary";
import { SvgIcon } from "../SvgIcon";
import ChatMessage from "./ChatMessage";
import arisIcon from "../assets/app-logo.png";
import { textFromTurn } from "./model";
import {
  currentMessageColumns,
  estimateTurnSize,
  readTurnMeasurements,
  setMessageColumns,
  textColumnsForWidth,
  turnVirtualKey,
  writeTurnMeasurements,
} from "./transcriptMetrics";
import type { Language } from "../store";

/** One definition of "parked at the bottom", shared by the return-to-bottom
 *  control and the virtualizer's own bottom anchoring (`scrollEndThreshold`).
 *  When these two disagreed, the transcript could be sticky without the button
 *  hiding, or drift while the button claimed the reader was following. */
export const NEAR_BOTTOM_THRESHOLD = 140;

/** Air above the first turn and below the last, owned by the virtualizer rather
 *  than by the scroll container's CSS padding. Keeping it inside the virtual
 *  coordinate space is what makes `item.start` a real scroll offset, so
 *  `scrollToIndex` lands where it says and the first-visible-turn lookup needs
 *  no fudge factor. The bottom inset also has to clear the floating composer. */
export const TRANSCRIPT_TOP_INSET = 26;
export const TRANSCRIPT_BOTTOM_GAP = 24;

/** How long a real input event (wheel, key, touch, scrollbar drag) keeps
 *  counting as reader intent. */
const READER_INTENT_WINDOW_MS = 1_200;

export function isNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = NEAR_BOTTOM_THRESHOLD,
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function shouldLoadEarlierTurnsAtTop(
  element: Pick<HTMLElement, "scrollTop">,
  threshold = 96,
) {
  return element.scrollTop <= threshold;
}

export function shouldIgnoreProgrammaticScroll(programmaticUntil: number, now: number) {
  return now <= programmaticUntil;
}

/**
 * Whether a raw key event is the reader asking to move up through history.
 * Intent has to come from input events: the virtualizer corrects `scrollTop`
 * itself whenever a measured row changes size, and reading those corrections as
 * "the reader scrolled up" used to unlock the omitted-turn reveal and fire a
 * history fetch, whose unmeasured rows produced more corrections — a loop that
 * walked the viewport on its own.
 */
export function isUpwardNavigationKey(key: string): boolean {
  return key === "ArrowUp" || key === "PageUp" || key === "Home";
}

/** Keys that actually move a scroll container. Typing into a question card or a
 *  code block inside a message is not a request to walk back through history. */
export function isScrollNavigationKey(key: string): boolean {
  return isUpwardNavigationKey(key)
    || key === "ArrowDown"
    || key === "PageDown"
    || key === "End"
    || key === " ";
}

/**
 * Which rows have to be re-estimated after the transcript's column width changed.
 *
 * A measured height is only true at the width it was measured at, and only rows
 * that are still mounted get a ResizeObserver callback for the new width. Every
 * other row keeps a height from the old layout until the reader scrolls it into
 * view, where it lands as a jump — so those rows are handed a fresh estimate
 * instead. Going through `resizeItem` (rather than dropping the cache) is what
 * keeps the reader still: the virtualizer compensates each above-viewport change.
 */
export function rowsNeedingReestimate(count: number, mountedIndexes: Iterable<number>): number[] {
  const mounted = new Set(mountedIndexes);
  const rows: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!mounted.has(index)) rows.push(index);
  }
  return rows;
}

/** Only the growth direction needs compensating when the composer resizes.
 *  Growing it hides the newest line behind the composer unless the viewport
 *  follows; shrinking it is already handled by the browser clamping `scrollTop`,
 *  and compensating again would drag the transcript down for no reason. */
export function composerGrowthAdjustment(previousInset: number, nextInset: number): number {
  const delta = nextInset - previousInset;
  return delta > 0 ? delta : 0;
}

export function scrollBottomLabel(language: Language) {
  return language === "cn" ? "回到底部" : "Back to bottom";
}

/**
 * Whether a row that just changed size should move the viewport with it.
 *
 * virtual-core reads this off the instance rather than from the options. Its
 * default additionally requires `scrollDirection !== "backward"`, which is right
 * for a feed of uniform cards and wrong for a transcript: a chat row is routinely
 * many times its estimate, so scrolling up measured row after row, and each of
 * those measurements shifted the content under the reader with nothing left to
 * anchor it (`.chat-scroll` sets `overflow-anchor: none`, so the browser will not
 * compensate either).
 */
export function compensateAboveViewportResize(
  item: Pick<VirtualItem, "start">,
  instance: {
    scrollElement: { scrollTop: number } | null;
    scrollOffset: number | null;
  },
): boolean {
  // The live `scrollTop` rather than the virtualizer's last *observed* offset:
  // corrections are applied by writing `scrollTop`, so within a burst of resizes
  // in one frame the DOM is the only value already carrying the earlier ones.
  const offset = instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0;
  return item.start < offset;
}

interface QuestionMarker {
  id: string;
  turnIndex: number;
  number: number;
  preview: string;
}

interface VirtualTurnPosition {
  index: number;
  start: number;
  size: number;
}

export function questionPreviewFromTurn(turn: ChatTurn): string {
  const attachments = turn.attachments ?? [];
  const attachmentPreview = attachments.length > 0
    ? `附件：${attachments[0].name}${attachments.length > 1 ? ` + ${attachments.length - 1} 个文件` : ""}`
    : "";
  const text = textFromTurn(turn)
    .replace(/\s+/g, " ")
    .trim();
  const previewText = text === "Attached context" && attachmentPreview ? "" : text;
  if (previewText) {
    const chars = [...previewText];
    return chars.length > 48 ? `${chars.slice(0, 48).join("")}...` : previewText;
  }
  if (attachmentPreview) return attachmentPreview;
  return "未命名提问";
}

export function questionMarkersFromTurns(turns: ChatTurn[]): QuestionMarker[] {
  const markers: QuestionMarker[] = [];
  turns.forEach((turn, turnIndex) => {
    if (turn.role !== "user") return;
    markers.push({
      id: turn.id,
      turnIndex,
      number: markers.length + 1,
      preview: questionPreviewFromTurn(turn),
    });
  });
  return markers;
}

export function activeQuestionNumber(markers: QuestionMarker[], firstVisibleTurnIndex: number): number | null {
  if (markers.length === 0) return null;
  let active = markers[0];
  for (const marker of markers) {
    if (marker.turnIndex > firstVisibleTurnIndex) break;
    active = marker;
  }
  return active.number;
}

export function chatThreadClassName(hasEarlierTurns: boolean, questionCount: number): string {
  return [
    "chat-thread",
    hasEarlierTurns ? "has-earlier-turns" : "",
    questionCount >= 2 ? "has-question-timeline" : "",
  ].filter(Boolean).join(" ");
}

export function firstVisibleTurnIndexFromVirtualItems(
  items: readonly VirtualTurnPosition[],
  scrollTop: number,
  topInset = 0,
): number {
  if (items.length === 0) return 0;
  const viewportTop = Math.max(0, scrollTop + topInset);
  const visible = items.find((item) => item.start + item.size > viewportTop);
  return visible?.index ?? items[items.length - 1].index;
}

/**
 * Which omitted row to hydrate next. The reveal used to fire for every omitted
 * row in the virtual window at once, and each of those is a *large* saved turn
 * by definition — a one-line notice growing into thousands of pixels. One row
 * per commit keeps each height change small enough for the virtualizer's anchor
 * to absorb, and the row nearest the viewport is the one the reader is about to
 * read.
 */
export function nextOmittedTurnToReveal(
  rows: readonly { index: number; omittedTurnIndex: number | null; loading: boolean }[],
  firstVisibleIndex: number,
): number | null {
  let best: { omittedTurnIndex: number; distance: number } | null = null;
  for (const row of rows) {
    if (row.omittedTurnIndex == null || row.loading) continue;
    const distance = Math.abs(row.index - firstVisibleIndex);
    if (!best || distance < best.distance) {
      best = { omittedTurnIndex: row.omittedTurnIndex, distance };
    }
  }
  return best?.omittedTurnIndex ?? null;
}

export interface ChatStarter {
  /** Also selects the starter glyph; unknown ids fall back to the writing glyph. */
  id: string;
  label: string;
  hint: string;
  badge?: string;
  prompt: string;
}

function StarterIcon({ id }: { id: ChatStarter["id"] }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (id === "literature" || id === "locate") {
    return <svg {...common}><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg>;
  }
  if (id === "research" || id === "explain") {
    return <svg {...common}><path d="M4 6.5h16M4 12h16M4 17.5h10" /><path d="M18 15.5v5M15.5 18h5" /></svg>;
  }
  if (id === "review" || id === "check") {
    return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.3 2.3 4.8-5" /></svg>;
  }
  return <svg {...common}><path d="m14.5 5.5 4 4M5 19l2.6-.6L18.8 7.2a1.4 1.4 0 0 0-2-2L5.6 16.4 5 19Z" /><path d="M13 7 17 11" /></svg>;
}

interface Props {
  sessionId: string;
  language: Language;
  turns: ChatTurn[];
  loading?: boolean;
  composerHeight: number;
  starters: ChatStarter[];
  welcomeTitle: ReactNode;
  welcomeDescription: string;
  onStarter: (prompt: string) => void;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
  onLoadOmittedTurn?: (turnIndex: number) => void;
  isOmittedTurnLoading?: (turnIndex: number) => boolean;
  hasEarlierTurns?: boolean;
  loadingEarlierTurns?: boolean;
  onLoadEarlierTurns?: () => void | Promise<void>;
  onPermissionRespond: (promptId: string, allow: boolean) => void;
  onQuestionRespond: (toolUseId: string, answer: string) => Promise<void>;
  onOpenIndependentReview?: () => void;
}

function ChatMessageFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <article className="chat-turn chat-assistant chat-turn-error">
      <div className="chat-error-card">
        <strong>Message failed to render</strong>
        <span>{error.message || "This message hit a UI rendering error."}</span>
        <button type="button" onClick={reset}>Retry</button>
      </div>
    </article>
  );
}

function QuestionTimeline({
  markers,
  activeNumber,
  onJump,
  language = "cn",
}: {
  markers: QuestionMarker[];
  activeNumber: number | null;
  onJump: (turnIndex: number) => void;
  language?: Language;
}) {
  const [open, setOpen] = useState(false);
  if (markers.length < 2) return null;
  const active = activeNumber ?? markers[markers.length - 1]?.number ?? null;
  const activeLabel = active ?? markers.length;
  const title = language === "cn"
    ? `本轮对话提问目录 (${activeLabel}/${markers.length})`
    : `Question directory (${activeLabel}/${markers.length})`;
  return (
    <div
      className={`chat-question-timeline${open ? " open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="chat-question-timeline-rail"
        aria-label={title}
        title={title}
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        <span className="chat-question-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
          </svg>
        </span>
        <span className="chat-question-count">{activeLabel}</span>
        <span className="chat-question-ticks" aria-hidden="true">
          {markers.map((marker) => (
            <span
              key={marker.id}
              className={`chat-question-tick${marker.number === active ? " active" : ""}`}
            />
          ))}
        </span>
      </button>
      <div className="chat-question-popover" role="list" aria-label={language === "cn" ? "本轮对话提问" : "Questions in thread"}>
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            className={marker.number === active ? "active" : ""}
            role="listitem"
            onClick={() => {
              onJump(marker.turnIndex);
              setOpen(false);
            }}
          >
            <span className="chat-question-item-number">{marker.number}</span>
            <span className="chat-question-item-text">{marker.preview}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// A changed turn must remount its error boundary after a retry or an arriving
// stream update. This is deliberately independent from scrolling policy.
function turnRenderKey(turn: ChatTurn): string {
  const blockSignature = turn.blocks.map((block) => {
    if (block.kind === "text") return `t:${block.text.length}`;
    if (block.kind === "thinking") return `r:${block.thinking.length}`;
    if (block.kind === "notice") return `n:${block.message.length}:${block.retry?.count ?? 0}`;
    if (block.kind === "review") return `v:${block.phase}:${block.attempt}:${block.verdict ?? "pending"}:${block.reviewerModel ?? ""}`;
    if (block.kind === "permission") return `p:${block.id}:${block.status ?? "pending"}:${block.input.length}`;
    return `c:${block.id ?? ""}:${block.name}:${block.input.length}:${block.output?.length ?? -1}`;
  }).join("|");
  return `${turn.id}:${turn.streaming ? "streaming" : "done"}:${blockSignature}`;
}

export default function ChatThread({
  sessionId,
  language,
  turns,
  loading = false,
  composerHeight,
  starters,
  welcomeTitle,
  welcomeDescription,
  onStarter,
  onEdit,
  onRetry,
  onContinue,
  onLoadOmittedTurn,
  isOmittedTurnLoading = () => false,
  hasEarlierTurns = false,
  loadingEarlierTurns = false,
  onLoadEarlierTurns,
  onPermissionRespond,
  onQuestionRespond,
  onOpenIndependentReview,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The message column, which is what row heights actually depend on: the
  // scroller's own width also counts its (reserved) scrollbar gutters.
  const listRef = useRef<HTMLDivElement>(null);
  // The transcript is reader-controlled. New messages and layout changes must
  // never move its viewport; only explicit user navigation may do that.
  const [following, setFollowing] = useState(false);
  const [firstVisibleTurnIndex, setFirstVisibleTurnIndex] = useState(0);
  const [historyRevealEnabled, setHistoryRevealEnabled] = useState(false);
  const programmaticScrollUntilRef = useRef(0);
  const navigationScrollUntilRef = useRef(0);
  const readerIntentUntilRef = useRef(0);
  const previousScrollTopRef = useRef<number | null>(null);
  const historyRevealEnabledRef = useRef(false);
  const landedSessionRef = useRef<string | null>(null);
  const earlierLoadInFlightRef = useRef(false);
  const followingRef = useRef(false);
  const bottomInsetRef = useRef<number | null>(null);
  // Row lookups the virtualizer performs must not re-enter through a prop that
  // changes identity every render: `getItemKey` and `estimateSize` are memo
  // dependencies inside virtual-core, so a fresh closure per render invalidated
  // the whole measurement pass on every streaming token.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const bottomInset = composerHeight + TRANSCRIPT_BOTTOM_GAP;
  const hasTurns = turns.length > 0;
  const getItemKey = useCallback(
    (index: number) => turnVirtualKey(turnsRef.current[index], index),
    [],
  );
  const estimateSize = useCallback(
    (index: number) => estimateTurnSize(turnsRef.current[index]),
    [],
  );
  const initialMeasurementsCache = useMemo(
    () => readTurnMeasurements(sessionId),
    [sessionId],
  );
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 5,
    getItemKey,
    initialMeasurementsCache,
    // The transcript's vertical air belongs to the virtual coordinate space, so
    // `getTotalSize()` equals the scroller's real `scrollHeight` and every
    // offset the virtualizer computes is a true `scrollTop`.
    paddingStart: TRANSCRIPT_TOP_INSET,
    paddingEnd: bottomInset,
    // `end` anchoring is what a transcript actually wants, and it replaces two
    // hand-rolled mechanisms: it captures an anchor whenever the row set's edge
    // keys change (so prepending earlier history no longer needs a scrollTop
    // snapshot to restore), and it keeps a reader who is parked at the bottom
    // there as the streaming turn grows.
    anchorTo: "end",
    scrollEndThreshold: NEAR_BOTTOM_THRESHOLD,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    compensateAboveViewportResize(item, instance)
  );
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const virtualWindowKey = `${firstVirtualItem?.index ?? -1}:${firstVirtualItem?.start ?? 0}:${firstVirtualItem?.size ?? 0}:${lastVirtualItem?.index ?? -1}:${lastVirtualItem?.start ?? 0}:${lastVirtualItem?.size ?? 0}`;
  const questionMarkers = useMemo(() => questionMarkersFromTurns(turns), [turns]);
  const activeQuestion = useMemo(
    () => activeQuestionNumber(questionMarkers, firstVisibleTurnIndex),
    [firstVisibleTurnIndex, questionMarkers],
  );

  const setFollowingValue = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const markHistoryRevealEnabled = useCallback(() => {
    if (historyRevealEnabledRef.current) return;
    historyRevealEnabledRef.current = true;
    setHistoryRevealEnabled(true);
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = window.performance.now() + 180;
  }, []);

  /** A real input event on the transcript. Everything that reveals history or
   *  fetches more of it hangs off this rather than off a `scrollTop` delta. */
  const noteReaderIntent = useCallback((upward: boolean) => {
    readerIntentUntilRef.current = window.performance.now() + READER_INTENT_WINDOW_MS;
    if (upward) markHistoryRevealEnabled();
  }, [markHistoryRevealEnabled]);

  const scrollToBottom = useCallback((smooth = false) => {
    if (turns.length === 0) return;
    markProgrammaticScroll();
    // Always through the virtualizer: it special-cases the last row's `end`
    // alignment to the live maximum scroll offset and then keeps re-targeting
    // until the height stops moving, which a one-shot `scrollTop = scrollHeight`
    // cannot do while rows are still being measured.
    virtualizer.scrollToIndex(turns.length - 1, {
      align: "end",
      behavior: smooth ? "smooth" : "auto",
    });
    setFollowingValue(true);
  }, [markProgrammaticScroll, setFollowingValue, turns.length, virtualizer]);

  const scrollToTurn = useCallback((turnIndex: number) => {
    markProgrammaticScroll();
    navigationScrollUntilRef.current = window.performance.now() + 1_000;
    virtualizer.scrollToIndex(turnIndex, { align: "start", behavior: "smooth" });
    setFollowingValue(false);
  }, [markProgrammaticScroll, setFollowingValue, virtualizer]);

  const syncFirstVisibleTurnIndex = useCallback((scrollTop = scrollRef.current?.scrollTop ?? 0) => {
    const next = firstVisibleTurnIndexFromVirtualItems(virtualizer.getVirtualItems(), scrollTop);
    setFirstVisibleTurnIndex((current) => current === next ? current : next);
  }, [virtualizer]);

  // The prepended rows are anchored by the virtualizer (`anchorTo: "end"` takes
  // an anchor whenever the edge keys change and restores it after the commit), so
  // this only has to decide *when* to ask for more history — and that decision
  // must come from a real input event, never from an inferred scroll delta.
  const loadEarlierAtTop = useCallback(() => {
    const element = scrollRef.current;
    const now = window.performance.now();
    if (
      !element
      || !hasEarlierTurns
      || loadingEarlierTurns
      || earlierLoadInFlightRef.current
      || !onLoadEarlierTurns
      || now <= navigationScrollUntilRef.current
      || now > readerIntentUntilRef.current
      || !shouldLoadEarlierTurnsAtTop(element)
    ) return;
    earlierLoadInFlightRef.current = true;
    Promise.resolve(onLoadEarlierTurns()).finally(() => {
      earlierLoadInFlightRef.current = false;
    });
  }, [hasEarlierTurns, loadingEarlierTurns, onLoadEarlierTurns]);

  // Omitted preview rows hydrate as they enter the virtual window. The full
  // saved turn remains local; the reader should not need a second click to see
  // it after scrolling to that point in history. One row per commit: each of
  // these is a large saved turn, and revealing a windowful at once produced a
  // burst of multi-thousand-pixel height changes.
  useEffect(() => {
    if (!historyRevealEnabled || !onLoadOmittedTurn) return;
    const rows = virtualizer.getVirtualItems().map((item) => {
      const omittedTurnIndex = turns[item.index]?.omittedTurnIndex ?? null;
      return {
        index: item.index,
        omittedTurnIndex: turns[item.index]?.omittedHydrated ? null : omittedTurnIndex,
        loading: omittedTurnIndex != null && isOmittedTurnLoading(omittedTurnIndex),
      };
    });
    const next = nextOmittedTurnToReveal(rows, firstVisibleTurnIndex);
    if (next != null) onLoadOmittedTurn(next);
  }, [
    firstVisibleTurnIndex,
    historyRevealEnabled,
    isOmittedTurnLoading,
    onLoadOmittedTurn,
    turns,
    virtualWindowKey,
    virtualizer,
  ]);

  useEffect(() => {
    syncFirstVisibleTurnIndex();
  }, [syncFirstVisibleTurnIndex, virtualWindowKey]);

  // Growing the composer reserves more space at the end of the transcript, which
  // slides the newest line behind it unless the viewport follows. Shrinking it is
  // already handled by the browser clamping `scrollTop`, and only matters for a
  // reader who is parked at the bottom — mid-transcript the right answer is to
  // leave the viewport exactly where it is.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = bottomInsetRef.current;
    bottomInsetRef.current = bottomInset;
    if (!element || previous == null || !followingRef.current) return;
    const adjustment = composerGrowthAdjustment(previous, bottomInset);
    if (adjustment === 0) return;
    markProgrammaticScroll();
    element.scrollTop += adjustment;
  }, [bottomInset, markProgrammaticScroll]);

  // The transcript's column width changes whenever the side panel opens, its
  // divider is dragged, the project brief lane appears, or the window is
  // resized. Every row's height changes with it, but only the rows still mounted
  // are observed, so the rest keep heights from the old layout and surface them
  // as a jump the next time the reader scrolls them into view.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    // The list when there is one; otherwise the scroller minus the gutters it
    // reserves, which its own `clientWidth` still counts.
    const contentWidth = () => {
      const list = listRef.current;
      if (list) return list.clientWidth;
      const style = window.getComputedStyle(element);
      const gutters = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      return element.clientWidth - gutters;
    };
    const applyWidth = () => {
      frame = null;
      const columns = textColumnsForWidth(contentWidth());
      if (columns === currentMessageColumns()) return;
      setMessageColumns(columns);
      const mounted = virtualizer.getVirtualItems().map((item) => item.index);
      const stale = rowsNeedingReestimate(turnsRef.current.length, mounted);
      if (stale.length === 0) return;
      // The compensation these produce is the virtualizer's, not the reader's.
      markProgrammaticScroll();
      for (const index of stale) {
        virtualizer.resizeItem(index, estimateTurnSize(turnsRef.current[index], columns));
      }
    };
    applyWidth();
    // Coalesced: dragging the side panel divider crosses a column boundary every
    // few pixels, and each pass walks every turn in the conversation.
    const observer = new ResizeObserver(() => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(applyWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame != null) window.cancelAnimationFrame(frame);
    };
    // `hasTurns` re-runs this the moment the list mounts, so the first
    // transcript of a session is measured against the list rather than the
    // welcome screen's box.
  }, [hasTurns, markProgrammaticScroll, virtualizer]);

  // Hand the measured heights to the next mount of this conversation so
  // reopening it does not start from estimates again.
  useEffect(() => () => {
    writeTurnMeasurements(sessionId, virtualizer.takeSnapshot());
  }, [sessionId, virtualizer]);

  // Reset transient history state between conversations. Opening a session is
  // the one moment the transcript may be repositioned (see the landing effect
  // below); once the reader is in a conversation, new messages and layout
  // measurements must never pull the viewport.
  useEffect(() => {
    historyRevealEnabledRef.current = false;
    setHistoryRevealEnabled(false);
    previousScrollTopRef.current = null;
    navigationScrollUntilRef.current = 0;
    readerIntentUntilRef.current = 0;
    landedSessionRef.current = null;
    setFollowingValue(false);
  }, [sessionId, setFollowingValue]);

  // Land on the newest turn once per conversation, as soon as its first turns
  // render. `scrollToIndex` on the last row resolves to the live maximum scroll
  // offset and virtual-core then re-targets it every frame until the height holds
  // still, so measured rows arriving after the estimate no longer leave the
  // reader partway up. Once it settles, `anchorTo: "end"` keeps the bottom pinned
  // for as long as the reader stays there — there is no fixed budget to run out.
  useEffect(() => {
    if (turns.length === 0 || landedSessionRef.current === sessionId) return;
    if (!scrollRef.current) return;
    landedSessionRef.current = sessionId;
    markProgrammaticScroll();
    // Suppresses the top-edge history fetch while the height is still moving.
    navigationScrollUntilRef.current = window.performance.now() + 240;
    setFollowingValue(true);
    virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
  }, [markProgrammaticScroll, sessionId, setFollowingValue, turns.length, virtualizer]);

  return (
    <div className={chatThreadClassName(hasEarlierTurns, questionMarkers.length)}>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onWheel={(event) => noteReaderIntent(event.deltaY < 0)}
        onTouchStart={() => noteReaderIntent(false)}
        onPointerDown={(event) => {
          // Only the scroller itself, which is what a scrollbar press targets.
          // Counting clicks on messages would make expanding a tool card look
          // like a request to load more history.
          if (event.target === event.currentTarget) noteReaderIntent(false);
        }}
        onKeyDown={(event) => {
          if (!isScrollNavigationKey(event.key)) return;
          noteReaderIntent(isUpwardNavigationKey(event.key));
        }}
        onScroll={(event) => {
          const now = window.performance.now();
          const scrollTop = event.currentTarget.scrollTop;
          const previousScrollTop = previousScrollTopRef.current;
          previousScrollTopRef.current = scrollTop;
          if (
            previousScrollTop != null
            && scrollTop < previousScrollTop - 1
            && now <= readerIntentUntilRef.current
            && now > navigationScrollUntilRef.current
          ) {
            // Secondary signal for touch drags and scrollbar drags, where the
            // input event cannot tell us the direction. Gated on a recent input
            // so a virtualizer height correction never reaches it.
            markHistoryRevealEnabled();
          }
          if (shouldIgnoreProgrammaticScroll(programmaticScrollUntilRef.current, now)) {
            return;
          }
          syncFirstVisibleTurnIndex(scrollTop);
          setFollowingValue(isNearBottom(event.currentTarget));
          loadEarlierAtTop();
        }}
      >
        {turns.length === 0 && loading ? (
          <div className="chat-thread-loading" aria-live="polite" aria-busy="true">
            <span className="chat-thread-spinner" aria-hidden="true" />
          </div>
        ) : turns.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-welcome-inner">
              <div className="chat-welcome-mark">
                <span className="chat-welcome-glow" aria-hidden="true" />
                <img src={arisIcon} alt="" decoding="async" />
              </div>
              <h1>{welcomeTitle}</h1>
              <p>{welcomeDescription}</p>
              {starters.length > 0 && (
                <div className="chat-starters">
                  {starters.map((starter) => (
                    <button
                      key={starter.id}
                      className={`chat-starter chat-starter-${starter.id}`}
                      type="button"
                      // Without this the computed name runs the three spans
                      // together with no separator ("文献检索深度检索搜索近年论文…").
                      aria-label={[starter.label, starter.badge, starter.hint]
                        .filter(Boolean)
                        .join(language === "cn" ? "，" : ", ")}
                      onClick={() => onStarter(starter.prompt)}
                    >
                      <span className="chat-starter-icon" aria-hidden="true"><StarterIcon id={starter.id} /></span>
                      <span className="chat-starter-content">
                        <span className="chat-starter-label-row">
                          <span className="chat-starter-label">{starter.label}</span>
                          {starter.badge && <span className="chat-starter-badge">{starter.badge}</span>}
                        </span>
                        <span className="chat-starter-hint">{starter.hint}</span>
                      </span>
                      <svg className="chat-starter-arrow" width="14" height="14" viewBox="0 0 16 16"
                        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                        strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 3.5 9.5 8 5 12.5" />
                      </svg>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            className="chat-virtual-list"
            ref={listRef}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const turn = turns[item.index];
              if (!turn) return null;
              return (
                <div
                  key={turn.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="chat-virtual-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <ErrorBoundary
                    resetKey={turnRenderKey(turn)}
                    fallback={(error, reset) => <ChatMessageFallback error={error} reset={reset} />}
                  >
                    <ChatMessage
                      turn={turn}
                      canRetry={!turn.readOnly && turn.role === "assistant" && item.index > 0}
                      onEdit={onEdit}
                      onRetry={onRetry}
                      onContinue={onContinue}
                      onPermissionRespond={onPermissionRespond}
                      onQuestionRespond={onQuestionRespond}
                      onOpenIndependentReview={onOpenIndependentReview}
                    />
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!following && turns.length > 0 && (
        <button
          type="button"
          className="chat-scroll-bottom"
          style={{ "--chat-scroll-bottom-offset": `${composerHeight + 12}px` } as CSSProperties}
          onClick={() => scrollToBottom(true)}
          aria-label={scrollBottomLabel(language)}
          title={scrollBottomLabel(language)}
        >
          <SvgIcon name="download" size={14} />
          <span>{scrollBottomLabel(language)}</span>
        </button>
      )}
      <QuestionTimeline
        markers={questionMarkers}
        activeNumber={activeQuestion}
        onJump={scrollToTurn}
        language={language}
      />
    </div>
  );
}

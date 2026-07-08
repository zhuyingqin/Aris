import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatTurn } from "../types";
import ErrorBoundary from "../ErrorBoundary";
import ChatMessage from "./ChatMessage";
import arisIcon from "../assets/app-logo.png";
import { textFromTurn } from "./model";

export function isNearBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = 140) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function shouldPauseAutoFollowForWheel(deltaY: number) {
  return deltaY < 0;
}

export function isScrollbarPointer(element: HTMLElement, clientX: number, gutter = 18) {
  const rect = element.getBoundingClientRect();
  return clientX >= rect.right - gutter;
}

export function shouldIgnoreProgrammaticFollowScroll(programmaticUntil: number, now: number, following: boolean) {
  return following && now <= programmaticUntil;
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

export function firstVisibleTurnIndexFromVirtualItems(
  items: readonly VirtualTurnPosition[],
  scrollTop: number,
  topInset = 8,
): number {
  if (items.length === 0) return 0;
  const viewportTop = Math.max(0, scrollTop + topInset);
  const visible = items.find((item) => item.start + item.size > viewportTop);
  return visible?.index ?? items[items.length - 1].index;
}

interface Props {
  sessionId: string;
  turns: ChatTurn[];
  loading?: boolean;
  composerHeight: number;
  starters: string[];
  onStarter: (prompt: string) => void;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
  onLoadOmittedTurn?: (turnIndex: number) => void;
  isOmittedTurnLoading?: (turnIndex: number) => boolean;
  onPermissionRespond: (promptId: string, allow: boolean) => void;
  onQuestionRespond: (toolUseId: string, answer: string) => void;
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
}: {
  markers: QuestionMarker[];
  activeNumber: number | null;
  onJump: (turnIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (markers.length < 2) return null;
  const active = activeNumber ?? markers[markers.length - 1]?.number ?? null;
  const activeLabel = active ?? markers.length;
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
        aria-label={`第 ${activeLabel} / ${markers.length} 次提问`}
        onClick={() => {
          const target = active != null ? markers[active - 1] : markers[markers.length - 1];
          if (target) onJump(target.turnIndex);
        }}
      >
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
      {open && (
        <div className="chat-question-popover" role="list" aria-label="本轮对话提问">
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className={marker.number === active ? "active" : ""}
              role="listitem"
              onClick={() => onJump(marker.turnIndex)}
            >
              <span className="chat-question-item-number">{marker.number}</span>
              <span className="chat-question-item-text">{marker.preview}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function turnRenderKey(turn: ChatTurn): string {
  const blockSignature = turn.blocks.map((block) => {
    if (block.kind === "text") return `t:${block.text.length}`;
    if (block.kind === "thinking") return `r:${block.thinking.length}`;
    if (block.kind === "notice") return `n:${block.message.length}`;
    if (block.kind === "permission") return `p:${block.id}:${block.status ?? "pending"}:${block.input.length}`;
    return `c:${block.id ?? ""}:${block.name}:${block.input.length}:${block.output?.length ?? -1}`;
  }).join("|");
  return `${turn.id}:${turn.streaming ? "streaming" : "done"}:${blockSignature}`;
}

export default function ChatThread({
  sessionId,
  turns,
  loading = false,
  composerHeight,
  starters,
  onStarter,
  onEdit,
  onRetry,
  onContinue,
  onLoadOmittedTurn,
  isOmittedTurnLoading = () => false,
  onPermissionRespond,
  onQuestionRespond,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [firstVisibleTurnIndex, setFirstVisibleTurnIndex] = useState(0);
  const followingRef = useRef(true);
  const programmaticScrollUntilRef = useRef(0);
  // True while the initial scroll for a session is still settling. Dynamic row
  // measurement means the first scroll lands on *estimated* offsets, then rows
  // measure and the total size shifts; during that window we ignore the
  // reflow-driven onScroll events that would otherwise flip `following` off and
  // leave the scrollbar stranded mid-thread.
  const settlingRef = useRef(false);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 5,
    getItemKey: (index) => turns[index]?.id ?? index,
  });
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

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = window.performance.now() + 180;
  }, []);

  const pauseAutoFollow = useCallback(() => {
    settlingRef.current = false;
    programmaticScrollUntilRef.current = 0;
    setFollowingValue(false);
  }, [setFollowingValue]);

  const scrollToBottom = useCallback((smooth = false, strategy?: "direct" | "virtual") => {
    if (turns.length === 0) return;
    const mode = strategy ?? (smooth ? "virtual" : "direct");
    markProgrammaticScroll();
    if (mode === "direct" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    } else {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end", behavior: smooth ? "smooth" : "auto" });
    }
    setFollowingValue(true);
  }, [markProgrammaticScroll, setFollowingValue, turns.length, virtualizer]);

  const scrollToTurn = useCallback((turnIndex: number) => {
    markProgrammaticScroll();
    virtualizer.scrollToIndex(turnIndex, { align: "start", behavior: "smooth" });
    setFollowingValue(false);
  }, [markProgrammaticScroll, setFollowingValue, virtualizer]);

  const syncFirstVisibleTurnIndex = useCallback((scrollTop = scrollRef.current?.scrollTop ?? 0) => {
    const next = firstVisibleTurnIndexFromVirtualItems(virtualizer.getVirtualItems(), scrollTop);
    setFirstVisibleTurnIndex((current) => current === next ? current : next);
  }, [virtualizer]);

  useEffect(() => {
    syncFirstVisibleTurnIndex();
  }, [syncFirstVisibleTurnIndex, virtualWindowKey]);

  // Land at the latest message when a conversation opens, re-pinning across a few
  // frames so the scrollbar converges as rows measure instead of jumping around.
  useEffect(() => {
    setFollowingValue(true);
    settlingRef.current = true;
    let frame = 0;
    let raf = window.requestAnimationFrame(function settle() {
      scrollToBottom(false, "virtual");
      frame += 1;
      if (frame < 5) {
        raf = window.requestAnimationFrame(settle);
      } else {
        settlingRef.current = false;
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
      settlingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useLayoutEffect(() => {
    if (!followingRef.current) return;
    // Re-check inside the frame: the user may have scrolled up (pausing follow)
    // between this effect scheduling the frame and the frame running. Without
    // this guard the stale frame yanks them back to the bottom and re-enables
    // follow, making it impossible to scroll up while messages stream in.
    scrollToBottom(false, "direct");
    let raf = window.requestAnimationFrame(() => {
      if (!followingRef.current) return;
      scrollToBottom(false, "direct");
      raf = window.requestAnimationFrame(() => {
        if (followingRef.current) scrollToBottom(false, "direct");
      });
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, composerHeight]);

  return (
    <div className="chat-thread">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onWheel={(event) => {
          if (shouldPauseAutoFollowForWheel(event.deltaY)) pauseAutoFollow();
        }}
        onTouchStart={pauseAutoFollow}
        onPointerDown={(event) => {
          if (isScrollbarPointer(event.currentTarget, event.clientX)) pauseAutoFollow();
        }}
        onScroll={(event) => {
          if (settlingRef.current) return;
          const now = window.performance.now();
          if (shouldIgnoreProgrammaticFollowScroll(programmaticScrollUntilRef.current, now, followingRef.current)) {
            return;
          }
          syncFirstVisibleTurnIndex(event.currentTarget.scrollTop);
          setFollowingValue(isNearBottom(event.currentTarget));
        }}
        style={{ paddingBottom: composerHeight + 24 }}
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
              <h1>What are we working on?</h1>
              <p>Start from the current project context, or attach files and ask anything.</p>
              {starters.length > 0 && (
                <div className="chat-starters">
                  {starters.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => onStarter(prompt)}>
                      <span className="chat-starter-label">{prompt}</span>
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
          <div className="chat-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
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
                      canRetry={turn.role === "assistant" && item.index > 0}
                      onEdit={onEdit}
                      onRetry={onRetry}
                      onContinue={onContinue}
                      onLoadOmittedTurn={onLoadOmittedTurn}
                      omittedTurnLoading={turn.omittedTurnIndex != null && isOmittedTurnLoading(turn.omittedTurnIndex)}
                      onPermissionRespond={onPermissionRespond}
                      onQuestionRespond={onQuestionRespond}
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
          className="chat-scroll-bottom"
          style={{ bottom: composerHeight + 12 }}
          onClick={() => scrollToBottom(true)}
        >
          ↓ Back to bottom
        </button>
      )}
      <QuestionTimeline
        markers={questionMarkers}
        activeNumber={activeQuestion}
        onJump={scrollToTurn}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatTurn } from "../types";
import ChatMessage from "./ChatMessage";

export function isNearBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = 140) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

interface Props {
  sessionId: string;
  turns: ChatTurn[];
  composerHeight: number;
  starters: string[];
  onStarter: (prompt: string) => void;
  onEdit: (turn: ChatTurn) => void;
  onRetry: (turn: ChatTurn) => void;
  onContinue: () => void;
}

export default function ChatThread({
  sessionId,
  turns,
  composerHeight,
  starters,
  onStarter,
  onEdit,
  onRetry,
  onContinue,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 5,
    getItemKey: (index) => turns[index]?.id ?? index,
  });

  const scrollToBottom = (smooth = false) => {
    if (turns.length === 0) return;
    virtualizer.scrollToIndex(turns.length - 1, { align: "end", behavior: smooth ? "smooth" : "auto" });
    setFollowing(true);
  };

  useEffect(() => {
    setFollowing(true);
    window.requestAnimationFrame(() => scrollToBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!following) return;
    window.requestAnimationFrame(() => scrollToBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, composerHeight, following]);

  return (
    <div className="chat-thread">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(event) => setFollowing(isNearBottom(event.currentTarget))}
        style={{ paddingBottom: composerHeight + 24 }}
      >
        {turns.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-welcome-inner">
              <div className="chat-welcome-mark">A</div>
              <h1>What are we working on?</h1>
              <p>Start with the current project context or attach files below.</p>
              <div className="chat-starters">
                {starters.map((prompt) => (
                  <button key={prompt} onClick={() => onStarter(prompt)}>{prompt}</button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="chat-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const turn = turns[item.index];
              return (
                <div
                  key={turn.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="chat-virtual-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <ChatMessage
                    turn={turn}
                    canRetry={turn.role === "assistant" && item.index > 0}
                    onEdit={onEdit}
                    onRetry={onRetry}
                    onContinue={onContinue}
                  />
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
    </div>
  );
}

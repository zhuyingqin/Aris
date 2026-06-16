import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatCancel,
  chatSend,
  isTauri,
  onChatDelta,
  onChatDone,
  onChatThinkingDelta,
  onChatPermissionRequest,
  onChatPermissionResolved,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import type { ChatSendRequest } from "../api/tauri";
import type { ChatBlock, ChatTurn } from "../types";
import { appendTextDelta, appendThinkingDelta } from "./model";

interface StreamHandlers {
  patchAssistant: (sessionId: string, fn: (turn: ChatTurn) => ChatTurn) => void;
  onComplete: (sessionId: string, reply: string) => void;
  onError: (sessionId: string, error: string, stopped: boolean) => void;
}

export function useChatStream({ patchAssistant, onComplete, onError }: StreamHandlers) {
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const runningSessions = useRef(new Set<string>());
  const stopRequested = useRef(new Set<string>());
  const queues = useRef(new Map<string, Array<{ kind: "text" | "thinking"; delta: string }>>());
  const flushTimers = useRef(new Map<string, number>());

  const flush = useCallback((sessionId: string) => {
    const timer = flushTimers.current.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    flushTimers.current.delete(sessionId);
    const pending = queues.current.get(sessionId) ?? [];
    queues.current.delete(sessionId);
    if (pending.length === 0) return;
    patchAssistant(sessionId, (turn) => {
      let blocks = turn.blocks;
      for (const event of pending) {
        blocks = event.kind === "text"
          ? appendTextDelta(blocks, event.delta)
          : appendThinkingDelta(blocks, event.delta);
      }
      return { ...turn, blocks };
    });
  }, [patchAssistant]);

  const scheduleFlush = useCallback((sessionId: string) => {
    if (flushTimers.current.has(sessionId)) return;
    flushTimers.current.set(sessionId, window.setTimeout(() => flush(sessionId), 70));
  }, [flush]);

  const enqueue = useCallback((
    sessionId: string,
    event: { kind: "text" | "thinking"; delta: string },
  ) => {
    const queue = queues.current.get(sessionId) ?? [];
    const last = queue[queue.length - 1];
    if (last?.kind === event.kind) last.delta += event.delta;
    else queue.push(event);
    queues.current.set(sessionId, queue);
    scheduleFlush(sessionId);
  }, [scheduleFlush]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners = [
      onChatDelta(({ sessionId, text }) => {
        enqueue(sessionId, { kind: "text", delta: text });
      }),
      onChatThinkingDelta(({ sessionId, thinking }) => {
        enqueue(sessionId, { kind: "thinking", delta: thinking });
      }),
      onChatTool((tool) => {
        flush(tool.sessionId);
        patchAssistant(tool.sessionId, (turn) => ({
          ...turn,
          blocks: [...turn.blocks, { kind: "tool", id: tool.id, name: tool.name, input: tool.input }],
        }));
      }),
      onChatToolResult((result) => {
        patchAssistant(result.sessionId, (turn) => {
          const blocks = appendToolOutput(
            turn.blocks,
            result.id,
            result.name,
            result.output,
            result.isError,
          );
          return { ...turn, blocks };
        });
      }),
      onChatPermissionRequest((request) => {
        flush(request.sessionId);
        patchAssistant(request.sessionId, (turn) => {
          if (turn.blocks.some((block) => block.kind === "permission" && block.id === request.promptId)) {
            return turn;
          }
          return {
            ...turn,
            blocks: [
              ...turn.blocks,
              {
                kind: "permission",
                id: request.promptId,
                toolName: request.toolName,
                input: request.input,
                currentMode: request.currentMode,
                requiredMode: request.requiredMode,
                status: "pending",
              },
            ],
          };
        });
      }),
      onChatPermissionResolved((event) => {
        patchAssistant(event.sessionId, (turn) => ({
          ...turn,
          blocks: turn.blocks.map((block) => (
            block.kind === "permission" && block.id === event.promptId
              ? { ...block, status: event.decision === "allow" ? "allowed" : "skipped" }
              : block
          )),
        }));
      }),
      onChatDone(({ sessionId }) => flush(sessionId)),
    ];
    return () => {
      unlisteners.forEach((promise) => promise.then((unlisten) => unlisten()).catch(() => undefined));
      flushTimers.current.forEach((timer) => window.clearTimeout(timer));
      flushTimers.current.clear();
      queues.current.clear();
    };
  }, [enqueue, flush, patchAssistant]);

  const run = useCallback(async (sessionId: string, message: string | ChatSendRequest) => {
    if (runningSessions.current.has(sessionId)) return false;
    runningSessions.current.add(sessionId);
    setRunningSessionIds(new Set(runningSessions.current));
    stopRequested.current.delete(sessionId);
    try {
      const reply = await chatSend(sessionId, message);
      flush(sessionId);
      onComplete(sessionId, reply);
      return true;
    } catch (error) {
      flush(sessionId);
      onError(sessionId, String(error), stopRequested.current.has(sessionId));
      return false;
    } finally {
      runningSessions.current.delete(sessionId);
      stopRequested.current.delete(sessionId);
      setRunningSessionIds(new Set(runningSessions.current));
    }
  }, [flush, onComplete, onError]);

  const stop = useCallback(async (sessionId: string) => {
    if (stopRequested.current.has(sessionId)) return;
    stopRequested.current.add(sessionId);
    try {
      await chatCancel(sessionId);
    } catch (error) {
      stopRequested.current.delete(sessionId);
      throw error;
    }
  }, []);

  return {
    busy: runningSessionIds.size > 0,
    runningSessionIds,
    isRunning: (sessionId: string) => runningSessionIds.has(sessionId),
    run,
    stop,
  };
}

export function appendToolOutput(
  blocks: ChatBlock[],
  id: string | undefined,
  name: string,
  output: string,
  isError: boolean,
): ChatBlock[] {
  const copy = blocks.slice();
  const findPendingTool = (matchId: boolean) => {
    for (let candidate = copy.length - 1; candidate >= 0; candidate -= 1) {
      const block = copy[candidate];
      if (
        block.kind === "tool"
        && block.name === name
        && block.output === undefined
        && (!matchId || block.id === id)
      ) {
        return candidate;
      }
    }
    return -1;
  };
  let index = id ? findPendingTool(true) : -1;
  if (index < 0) index = findPendingTool(false);
  if (index >= 0) {
    const block = copy[index];
    if (block.kind === "tool") copy[index] = { ...block, output, isError };
  }
  return copy;
}

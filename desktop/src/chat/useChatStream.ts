import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatCancel,
  chatSend,
  isTauri,
  onChatDelta,
  onChatDone,
  onChatThinkingDelta,
  onChatTool,
  onChatToolResult,
} from "../api/tauri";
import type { ChatBlock, ChatTurn } from "../types";
import { appendTextDelta, appendThinkingDelta } from "./model";

interface StreamHandlers {
  patchAssistant: (sessionId: string, fn: (turn: ChatTurn) => ChatTurn) => void;
  onComplete: (sessionId: string, reply: string) => void;
  onError: (sessionId: string, error: string, stopped: boolean) => void;
}

export function useChatStream({ patchAssistant, onComplete, onError }: StreamHandlers) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const runningSession = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const queue = useRef<{ kind: "text" | "thinking"; delta: string }[]>([]);
  const flushTimer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    flushTimer.current = null;
    const sessionId = runningSession.current;
    if (!sessionId) return;
    const pending = queue.current;
    queue.current = [];
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

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(flush, 70);
  }, [flush]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners = [
      onChatDelta((text) => {
        queue.current.push({ kind: "text", delta: text });
        scheduleFlush();
      }),
      onChatThinkingDelta((thinking) => {
        queue.current.push({ kind: "thinking", delta: thinking });
        scheduleFlush();
      }),
      onChatTool((tool) => {
        flush();
        const sessionId = runningSession.current;
        if (!sessionId) return;
        patchAssistant(sessionId, (turn) => ({
          ...turn,
          blocks: [...turn.blocks, { kind: "tool", id: tool.id, name: tool.name, input: tool.input }],
        }));
      }),
      onChatToolResult((result) => {
        const sessionId = runningSession.current;
        if (!sessionId) return;
        patchAssistant(sessionId, (turn) => {
          const blocks = turn.blocks.slice();
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            const idMatches = result.id ? block.kind === "tool" && block.id === result.id : true;
            if (block.kind === "tool" && idMatches && block.name === result.name && block.output === undefined) {
              blocks[index] = { ...block, output: result.output, isError: result.isError };
              break;
            }
          }
          return { ...turn, blocks };
        });
      }),
      onChatDone(() => flush()),
    ];
    return () => {
      unlisteners.forEach((promise) => promise.then((unlisten) => unlisten()).catch(() => undefined));
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    };
  }, [flush, patchAssistant, scheduleFlush]);

  const run = useCallback(async (sessionId: string, message: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    runningSession.current = sessionId;
    stopRequested.current = false;
    setBusy(true);
    try {
      const reply = await chatSend(sessionId, message);
      flush();
      onComplete(sessionId, reply);
      return true;
    } catch (error) {
      flush();
      onError(sessionId, String(error), stopRequested.current);
      return false;
    } finally {
      runningSession.current = null;
      stopRequested.current = false;
      busyRef.current = false;
      setBusy(false);
    }
  }, [flush, onComplete, onError]);

  const stop = useCallback(async () => {
    if (stopRequested.current) return;
    stopRequested.current = true;
    try {
      await chatCancel();
    } catch (error) {
      stopRequested.current = false;
      throw error;
    }
  }, []);

  return { busy, run, stop, runningSessionId: runningSession.current };
}

export function appendToolOutput(
  blocks: ChatBlock[],
  id: string | undefined,
  name: string,
  output: string,
  isError: boolean,
): ChatBlock[] {
  const copy = blocks.slice();
  let index = -1;
  for (let candidate = copy.length - 1; candidate >= 0; candidate -= 1) {
    const block = copy[candidate];
    const idMatches = id ? block.kind === "tool" && block.id === id : true;
    if (block.kind === "tool" && idMatches && block.name === name && block.output === undefined) {
      index = candidate;
      break;
    }
  }
  if (index >= 0) {
    const block = copy[index];
    if (block.kind === "tool") copy[index] = { ...block, output, isError };
  }
  return copy;
}

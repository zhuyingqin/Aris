import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatCancel,
  chatSend,
  isTauri,
  onChatDelta,
  onChatDone,
  onChatError,
  onChatContextCompacted,
  onChatContextWarning,
  onChatThinkingDelta,
  onChatPermissionRequest,
  onChatPermissionResolved,
  onChatReview,
  onChatTool,
  onChatToolProgress,
  onChatToolResult,
} from "../api/tauri";
import type { ChatSendRequest, IndependentReviewEvent } from "../api/tauri";
import type { ChatBlock, ChatTurn } from "../types";
import { appendTextDelta, appendThinkingDelta } from "./model";
import { isExpectedStopError } from "./chatRunHelpers";
import { formatUserFacingError, type ErrorMessageLanguage } from "../errorMessage";

const MAX_RUNNING_CHAT_SESSIONS = 5;

interface RevisionStreamBuffer {
  attempt: number;
  blocks: ChatBlock[];
}

/** Compact a token count for display: 320, 1.2k, 45.0k. */
function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Build the auto-compaction notice. When both the pre- and post-compaction
 * token counts are known (and the context actually shrank), annotate it with
 * how much was freed: " - 45.0k -> 12.0k tokens (-73%)". Falls back to the
 * bare message otherwise so callers without token data get a stable string. */
function compactionNoticeMessage(
  removedMessageCount: number,
  before: number | null,
  after: number | null,
): string {
  const base = removedMessageCount > 0
    ? `Context compacted automatically; ${removedMessageCount} earlier messages were summarized.`
    : "Context compacted automatically; large consumed tool payloads were shortened.";
  if (before != null && after != null && before > after) {
    const pct = Math.round((1 - after / before) * 100);
    return `${base} - ${formatTokenCount(before)} -> ${formatTokenCount(after)} tokens (-${pct}%)`;
  }
  return base;
}

function reviewBlockFromEvent(event: IndependentReviewEvent): Extract<ChatBlock, { kind: "review" }> {
  return {
    kind: "review",
    phase: event.phase === "cleared" ? "complete" : event.phase,
    attempt: event.attempt,
    revision: event.revision,
    maxRevisions: event.maxRevisions,
    reviewerProvider: event.reviewerProvider ?? event.result?.reviewerProvider ?? undefined,
    reviewerModel: event.reviewerModel ?? event.result?.reviewerModel ?? undefined,
    verdict: event.result?.verdict,
  };
}

interface StreamHandlers {
  language?: ErrorMessageLanguage;
  patchAssistant: (sessionId: string, fn: (turn: ChatTurn) => ChatTurn) => void;
  onComplete: (sessionId: string, reply: string) => void;
  onError: (
    sessionId: string,
    error: string,
    stopped: boolean,
    sessionPreserved?: boolean,
  ) => void;
  /** Mid-turn auto-compaction reported the real post-compaction token count.
   * Lets the host pin the ContextRing to it (same as the manual `/compact`
   * path). Only called when the backend supplies a token count. */
  onContextCompacted?: (sessionId: string, tokensAfter: number) => void;
  /** A turn finished and the backend reported its session-history token
   * estimate, in the same unit as the auto-compaction budget. */
  onContextTokens?: (sessionId: string, tokens: number) => void;
  onContextWarning?: (event: {
    sessionId: string;
    usedTokens: number;
    contextWindow?: number | null;
    compactionBudget?: number | null;
  }) => void;
  /** Current authoritative context-token count for a session, used only to
   * annotate the compaction notice with how much was freed. */
  getContextTokens?: (sessionId: string) => number | null;
}

export function useChatStream({
  language = "en",
  patchAssistant,
  onComplete,
  onError,
  onContextCompacted,
  onContextTokens,
  onContextWarning,
  getContextTokens,
}: StreamHandlers) {
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const runningSessions = useRef(new Set<string>());
  const stopRequested = useRef(new Set<string>());
  const runTransports = useRef(new Map<string, {
    send: (sessionId: string, message: string | ChatSendRequest) => Promise<string>;
    cancel: (sessionId: string) => Promise<void>;
  }>());
  const queues = useRef(new Map<string, Array<{ kind: "text" | "thinking"; delta: string }>>());
  // A Reviewer-requested rewrite is a second full Executor response. Streaming
  // it into the same visible turn used to remove the accepted draft first and
  // then replay the whole answer from an empty card. Keep that rewrite offscreen
  // until its generation finishes, then swap the narrative once at the next
  // review boundary. Tool activity remains visible while the revision runs.
  const revisionStreams = useRef(new Map<string, RevisionStreamBuffer>());
  const flushTimers = useRef(new Map<string, number>());
  const listenerGeneration = useRef(0);
  const handlersRef = useRef<StreamHandlers>({
    language,
    patchAssistant,
    onComplete,
    onError,
    onContextCompacted,
    onContextTokens,
    onContextWarning,
    getContextTokens,
  });
  handlersRef.current = {
    language,
    patchAssistant,
    onComplete,
    onError,
    onContextCompacted,
    onContextTokens,
    onContextWarning,
    getContextTokens,
  };

  const flush = useCallback((sessionId: string) => {
    const timer = flushTimers.current.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    flushTimers.current.delete(sessionId);
    const pending = queues.current.get(sessionId) ?? [];
    queues.current.delete(sessionId);
    if (pending.length === 0) return;
    handlersRef.current.patchAssistant(sessionId, (turn) => {
      let blocks = turn.blocks;
      for (const event of pending) {
        blocks = event.kind === "text"
          ? appendTextDelta(blocks, event.delta)
          : appendThinkingDelta(blocks, event.delta);
      }
      return { ...turn, blocks };
    });
  }, []);

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
    const generation = listenerGeneration.current + 1;
    listenerGeneration.current = generation;
    const isCurrentListener = () => listenerGeneration.current === generation;
    const unlisteners = [
      onChatDelta(({ sessionId, text }) => {
        if (!isCurrentListener()) return;
        const revision = revisionStreams.current.get(sessionId);
        if (revision) {
          revision.blocks = appendTextDelta(revision.blocks, text);
          return;
        }
        enqueue(sessionId, { kind: "text", delta: text });
      }),
      onChatThinkingDelta(({ sessionId, thinking }) => {
        if (!isCurrentListener()) return;
        const revision = revisionStreams.current.get(sessionId);
        if (revision) {
          revision.blocks = appendThinkingDelta(revision.blocks, thinking);
          return;
        }
        enqueue(sessionId, { kind: "thinking", delta: thinking });
      }),
      onChatTool((tool) => {
        if (!isCurrentListener()) return;
        flush(tool.sessionId);
        handlersRef.current.patchAssistant(tool.sessionId, (turn) => ({
          ...turn,
          blocks: upsertToolCall(turn.blocks, tool),
        }));
      }),
      onChatToolProgress((progress) => {
        if (!isCurrentListener()) return;
        handlersRef.current.patchAssistant(progress.sessionId, (turn) => ({
          ...turn,
          blocks: updateToolProgress(turn.blocks, progress),
        }));
      }),
      onChatToolResult((result) => {
        if (!isCurrentListener()) return;
        flush(result.sessionId);
        handlersRef.current.patchAssistant(result.sessionId, (turn) => {
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
        if (!isCurrentListener()) return;
        flush(request.sessionId);
        handlersRef.current.patchAssistant(request.sessionId, (turn) => {
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
        if (!isCurrentListener()) return;
        handlersRef.current.patchAssistant(event.sessionId, (turn) => ({
          ...turn,
          blocks: turn.blocks.map((block) => (
            block.kind === "permission" && block.id === event.promptId
              ? { ...block, status: event.decision === "allow" ? "allowed" : "skipped" }
              : block
          )),
        }));
      }),
      onChatDone(({ sessionId, contextTokens, providerUsage }) => {
        if (!isCurrentListener()) return;
        flush(sessionId);
        // `contextTokens` is the post-turn session-history estimate in the
        // same unit as the compaction budget. In particular, after automatic
        // compaction it reflects the newly condensed session. Provider prompt
        // usage describes the request that just completed, which may have
        // consumed the pre-compaction context and would make the ring stay at
        // 100%. Only use it as a fallback for older backends without the
        // session-history value.
        const realTokens = contextTokens ?? providerUsage?.promptTokens;
        if (realTokens != null) handlersRef.current.onContextTokens?.(sessionId, realTokens);
      }),
      onChatReview((event) => {
        if (!isCurrentListener()) return;
        flush(event.sessionId);
        if (event.phase === "cleared") {
          revisionStreams.current.delete(event.sessionId);
          handlersRef.current.patchAssistant(event.sessionId, (turn) => ({
            ...turn,
            blocks: turn.blocks.filter((block) => block.kind !== "review"),
          }));
          return;
        }
        const completedRevision = event.phase === "revising"
          ? undefined
          : revisionStreams.current.get(event.sessionId);
        if (completedRevision) revisionStreams.current.delete(event.sessionId);
        if (event.phase === "revising") {
          revisionStreams.current.set(event.sessionId, { attempt: event.attempt, blocks: [] });
        }
        handlersRef.current.patchAssistant(event.sessionId, (turn) => {
          const hasRevisedNarrative = completedRevision?.blocks.some((block) => (
            (block.kind === "text" && Boolean(block.text.trim()))
            || (block.kind === "thinking" && Boolean(block.thinking.trim()))
          ));
          const retained = turn.blocks.filter((block) => (
            block.kind !== "review"
            && (!hasRevisedNarrative || (block.kind !== "text" && block.kind !== "thinking"))
          ));
          if (hasRevisedNarrative && completedRevision) retained.push(...completedRevision.blocks);
          return {
            ...turn,
            blocks: [...retained, reviewBlockFromEvent(event)],
          };
        });
      }),
      // Authoritative failure signal from the backend. The `chatSend` promise
      // also rejects, and `onError` is idempotent (it sets the same turn
      // error), so surfacing here is safe and guarantees the failure renders
      // even if the rejection path is delayed or the listener set was swapped
      // mid-turn. `stopped: false` means a real backend error is never an expected
      // user stop; `visibleTurnError` only hides cancellations when stopped.
      onChatError(({ sessionId, message, sessionPreserved }) => {
        if (!isCurrentListener()) return;
        flush(sessionId);
        revisionStreams.current.delete(sessionId);
        // The backend's explicit error event is authoritative. Only the
        // canonical interruption message from an active user stop is expected;
        // a provider/tool failure that races with Stop must remain visible.
        const expectedStop = stopRequested.current.has(sessionId) && isExpectedStopError(message);
        handlersRef.current.onError(
          sessionId,
          formatUserFacingError(message, handlersRef.current.language ?? "en"),
          expectedStop,
          sessionPreserved,
        );
      }),
      onChatContextCompacted(({ sessionId, removedMessageCount, tokensAfter }) => {
        if (!isCurrentListener()) return;
        flush(sessionId);
        const before = handlersRef.current.getContextTokens?.(sessionId) ?? null;
        const message = compactionNoticeMessage(removedMessageCount, before, tokensAfter ?? null);
        handlersRef.current.patchAssistant(sessionId, (turn) => ({
          ...turn,
          blocks: [...turn.blocks, { kind: "notice", message }],
        }));
        if (tokensAfter != null) handlersRef.current.onContextCompacted?.(sessionId, tokensAfter);
      }),
      onChatContextWarning(({ sessionId, usedTokens, contextWindow, compactionBudget }) => {
        if (!isCurrentListener()) return;
        handlersRef.current.onContextWarning?.({ sessionId, usedTokens, contextWindow, compactionBudget });
      }),
    ];
    return () => {
      if (listenerGeneration.current === generation) listenerGeneration.current += 1;
      unlisteners.forEach((promise) => promise.then((unlisten) => unlisten()).catch(() => undefined));
      flushTimers.current.forEach((timer) => window.clearTimeout(timer));
      flushTimers.current.clear();
      queues.current.clear();
      revisionStreams.current.clear();
    };
  }, [enqueue, flush]);

  const run = useCallback(async (
    sessionId: string,
    message: string | ChatSendRequest,
    transport?: {
      send: (sessionId: string, message: string | ChatSendRequest) => Promise<string>;
      cancel: (sessionId: string) => Promise<void>;
    },
  ) => {
    if (runningSessions.current.has(sessionId)) return false;
    if (runningSessions.current.size >= MAX_RUNNING_CHAT_SESSIONS) {
      handlersRef.current.onError(
        sessionId,
        `at most ${MAX_RUNNING_CHAT_SESSIONS} chat turns can run at once`,
        false,
      );
      return false;
    }
    runningSessions.current.add(sessionId);
    setRunningSessionIds(new Set(runningSessions.current));
    stopRequested.current.delete(sessionId);
    if (transport) runTransports.current.set(sessionId, transport);
    try {
      const reply = await (transport?.send ?? chatSend)(sessionId, message);
      flush(sessionId);
      if (stopRequested.current.has(sessionId)) {
        handlersRef.current.onError(sessionId, "", true);
        return false;
      }
      handlersRef.current.onComplete(sessionId, reply);
      return true;
    } catch (error) {
      flush(sessionId);
      revisionStreams.current.delete(sessionId);
      const failure = String(error);
      const expectedStop = stopRequested.current.has(sessionId) && isExpectedStopError(failure);
      handlersRef.current.onError(
        sessionId,
        formatUserFacingError(failure, handlersRef.current.language ?? "en"),
        expectedStop,
      );
      return false;
    } finally {
      runningSessions.current.delete(sessionId);
      stopRequested.current.delete(sessionId);
      runTransports.current.delete(sessionId);
      setRunningSessionIds(new Set(runningSessions.current));
    }
  }, [flush]);

  const stop = useCallback(async (sessionId: string) => {
    if (stopRequested.current.has(sessionId)) return;
    stopRequested.current.add(sessionId);
    flush(sessionId);
    revisionStreams.current.delete(sessionId);
    runningSessions.current.delete(sessionId);
    setRunningSessionIds(new Set(runningSessions.current));
    handlersRef.current.onError(sessionId, "", true);
    try {
      await (runTransports.current.get(sessionId)?.cancel ?? chatCancel)(sessionId);
    } catch (error) {
      stopRequested.current.delete(sessionId);
      throw error;
    }
  }, [flush]);

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
    return copy;
  }
  if (id && copy.some((block) => (
    block.kind === "tool"
    && block.id === id
    && block.name === name
    && block.output !== undefined
  ))) {
    return copy;
  }
  return [...copy, { kind: "tool", id, name, input: "{}", output, isError }];
}

export function upsertToolCall(
  blocks: ChatBlock[],
  tool: { id?: string; name: string; input: string },
): ChatBlock[] {
  if (!tool.id) return [...blocks, { kind: "tool", id: tool.id, name: tool.name, input: tool.input }];
  const index = blocks.findIndex((block) => (
    block.kind === "tool"
    && block.id === tool.id
    && block.name === tool.name
  ));
  if (index < 0) return [...blocks, { kind: "tool", id: tool.id, name: tool.name, input: tool.input }];
  const copy = blocks.slice();
  const existing = copy[index];
  if (existing.kind === "tool") {
    copy[index] = { ...existing, input: tool.input };
  }
  return copy;
}

export function updateToolProgress(
  blocks: ChatBlock[],
  progress: {
    id?: string;
    name: string;
    elapsedMs: number;
    timeoutMs?: number | null;
    pid?: number | null;
    stdoutTail?: string | null;
    stderrTail?: string | null;
    nearTimeout?: boolean;
    message?: string;
  },
): ChatBlock[] {
  const copy = blocks.slice();
  const matches = (block: ChatBlock) => (
    block.kind === "tool"
    && block.name === progress.name
    && block.output === undefined
    && (!progress.id || block.id === progress.id)
  );
  let index = -1;
  for (let candidate = copy.length - 1; candidate >= 0; candidate -= 1) {
    if (matches(copy[candidate])) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return blocks;
  const block = copy[index];
  if (block.kind !== "tool") return blocks;
  copy[index] = {
    ...block,
    progress: {
      elapsedMs: progress.elapsedMs,
      timeoutMs: progress.timeoutMs ?? null,
      pid: progress.pid ?? null,
      stdoutTail: progress.stdoutTail ?? null,
      stderrTail: progress.stderrTail ?? null,
      nearTimeout: progress.nearTimeout ?? false,
      message: progress.message,
    },
  };
  return copy;
}

// Messages the user sends while a chat is still answering. Each chat keeps its
// own queue; the next item starts as soon as that chat is idle again, so the
// user can line up follow-ups instead of waiting for every turn to finish.
//
// A turn the user stopped, or one that failed, pauses the queue: the user is
// usually about to correct course, and firing the next prepared message into
// a broken or abandoned turn would waste a run. The queue resumes on request.
//
// The queue lives in memory only. After a restart nothing is running, so a
// persisted queue would either fire unprompted or sit there unexplained.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatTurn } from "../types";
import type { ChatSession } from "./types";

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
}

/** Shared empty value so a memoised composer is not re-rendered for nothing. */
export const NO_QUEUED_MESSAGES: readonly QueuedMessage[] = [];

interface UseMessageQueueArgs {
  allSessionsRef: React.MutableRefObject<ChatSession[]>;
  runningSessionIds: ReadonlySet<string>;
  runningSessionIdsRef: React.MutableRefObject<ReadonlySet<string>>;
  sendLocks: React.MutableRefObject<Set<string>>;
  acquireSendLock: (sessionId: string) => number | null;
  releaseSendLock: (sessionId: string, generation: number) => void;
  /** Whether the chat can run a turn right now (model configured etc). */
  canRun: (session: ChatSession, item: QueuedMessage) => boolean;
  /** Run one queued message as an ordinary user turn. */
  dispatch: (session: ChatSession, item: QueuedMessage) => Promise<void>;
}

/** A finished run releases its send lock just after it leaves the running
 * set; retry briefly instead of missing the hand-over. 100 ms apart. */
const DRAIN_ATTEMPTS = 50;

let queuedSequence = 0;

/** True when the chat's latest answer was stopped or failed. */
export function queuePausedByTurns(turns: ChatTurn[]): boolean {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "assistant") continue;
    return Boolean(turn.stopped || turn.error);
  }
  return false;
}

export function useMessageQueue({
  allSessionsRef,
  runningSessionIds,
  runningSessionIdsRef,
  sendLocks,
  acquireSendLock,
  releaseSendLock,
  canRun,
  dispatch,
}: UseMessageQueueArgs) {
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  // A resume request overrides the pause for exactly one dispatch.
  const resumeRequests = useRef(new Set<string>());
  const draining = useRef(new Set<string>());
  const latest = useRef({ canRun, dispatch });
  latest.current = { canRun, dispatch };

  const setQueue = useCallback((sessionId: string, fn: (items: QueuedMessage[]) => QueuedMessage[]) => {
    setQueues((current) => {
      const next = fn(current[sessionId] ?? []);
      const copy = { ...current };
      if (next.length > 0) copy[sessionId] = next;
      else delete copy[sessionId];
      queuesRef.current = copy;
      return copy;
    });
  }, []);

  const enqueue = useCallback((sessionId: string, text: string, attachments: ChatAttachment[]) => {
    queuedSequence += 1;
    const item: QueuedMessage = { id: `queued-${Date.now()}-${queuedSequence}`, text, attachments };
    setQueue(sessionId, (items) => [...items, item]);
    return item;
  }, [setQueue]);

  const remove = useCallback((sessionId: string, id: string) => {
    setQueue(sessionId, (items) => items.filter((item) => item.id !== id));
  }, [setQueue]);

  const take = useCallback((sessionId: string, id: string) => {
    const item = queuesRef.current[sessionId]?.find((candidate) => candidate.id === id) ?? null;
    if (item) remove(sessionId, id);
    return item;
  }, [remove]);

  const drain = useCallback((sessionId: string, attempt = 0) => {
    if (draining.current.has(sessionId)) return;
    const first = queuesRef.current[sessionId]?.[0];
    if (!first) {
      resumeRequests.current.delete(sessionId);
      return;
    }
    if (runningSessionIdsRef.current.has(sessionId) || sendLocks.current.has(sessionId)) {
      if (attempt < DRAIN_ATTEMPTS) window.setTimeout(() => drain(sessionId, attempt + 1), 100);
      return;
    }
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return;
    const resumed = resumeRequests.current.has(sessionId);
    if (!resumed && queuePausedByTurns(session.turns)) return;
    if (!latest.current.canRun(session, first)) return;
    const lock = acquireSendLock(sessionId);
    if (lock == null) return;
    resumeRequests.current.delete(sessionId);
    draining.current.add(sessionId);
    setQueue(sessionId, (items) => items.filter((item) => item.id !== first.id));
    void latest.current.dispatch(session, first).finally(() => {
      releaseSendLock(sessionId, lock);
      draining.current.delete(sessionId);
    });
  }, [acquireSendLock, allSessionsRef, releaseSendLock, runningSessionIdsRef, sendLocks, setQueue]);

  /** Send the next queued message even though the last turn was stopped. */
  const resume = useCallback((sessionId: string) => {
    resumeRequests.current.add(sessionId);
    drain(sessionId);
  }, [drain]);

  // A chat leaving the running set is the moment its next message may go.
  useEffect(() => {
    for (const sessionId of Object.keys(queuesRef.current)) {
      if (!runningSessionIds.has(sessionId)) window.setTimeout(() => drain(sessionId), 0);
    }
  }, [drain, runningSessionIds]);

  return { queues, enqueue, remove, take, resume, drain };
}

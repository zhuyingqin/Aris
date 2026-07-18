import { useEffect, useMemo, useRef, useState } from "react";
import {
  chatEventsRead,
  isTauri,
  onChatReview,
  type IndependentReviewEvent,
  type IndependentReviewResult,
} from "../api/tauri";

export interface IndependentReviewState {
  sessionId: string;
  phase: IndependentReviewEvent["phase"];
  attempt: number;
  revision: number;
  maxRevisions: number;
  reviewerProvider?: string;
  reviewerModel?: string;
  rounds: Array<{ attempt: number; result: IndependentReviewResult }>;
  updatedAt: number;
}

function applyReviewEvent(
  current: IndependentReviewState | undefined,
  event: IndependentReviewEvent,
): IndependentReviewState {
  const base: IndependentReviewState = !current
    ? {
      sessionId: event.sessionId,
      phase: event.phase,
      attempt: event.attempt,
      revision: event.revision ?? 0,
      maxRevisions: event.maxRevisions,
      reviewerProvider: event.reviewerProvider ?? event.result?.reviewerProvider ?? undefined,
      reviewerModel: event.reviewerModel ?? event.result?.reviewerModel ?? undefined,
      rounds: [],
      updatedAt: Date.now(),
    }
    : current;
  let rounds = base.rounds;
  if (event.result) {
    const nextRound = { attempt: event.attempt, result: event.result };
    const existing = rounds.findIndex((round) => round.attempt === event.attempt);
    rounds = existing >= 0
      ? rounds.map((round, index) => index === existing ? nextRound : round)
      : [...rounds, nextRound];
  }
  return {
    ...base,
    phase: event.phase,
    attempt: event.attempt,
    revision: event.revision ?? base.revision,
    maxRevisions: event.maxRevisions,
    reviewerProvider: event.reviewerProvider
      ?? event.result?.reviewerProvider
      ?? base.reviewerProvider,
    reviewerModel: event.reviewerModel
      ?? event.result?.reviewerModel
      ?? base.reviewerModel,
    rounds,
    updatedAt: Date.now(),
  };
}

function isReviewEvent(value: unknown): value is IndependentReviewEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<IndependentReviewEvent>;
  return typeof item.sessionId === "string"
    && typeof item.phase === "string"
    && typeof item.attempt === "number"
    && typeof item.maxRevisions === "number";
}

function mergeReviewStates(
  restored: IndependentReviewState,
  live: IndependentReviewState,
): IndependentReviewState {
  const rounds = new Map(restored.rounds.map((round) => [round.attempt, round]));
  live.rounds.forEach((round) => rounds.set(round.attempt, round));
  return {
    ...restored,
    ...live,
    rounds: [...rounds.values()].sort((left, right) => left.attempt - right.attempt),
    updatedAt: Math.max(restored.updatedAt, live.updatedAt),
  };
}

export function useIndependentReview(sessionId: string) {
  const [states, setStates] = useState<Map<string, IndependentReviewState>>(() => new Map());
  const loadedSessions = useRef(new Set<string>());

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let dispose: (() => void) | null = null;
    void onChatReview((event) => {
      if (!active) return;
      setStates((current) => {
        const next = new Map(current);
        if (event.phase === "cleared") {
          next.delete(event.sessionId);
          return next;
        }
        next.set(event.sessionId, applyReviewEvent(next.get(event.sessionId), event));
        return next;
      });
    }).then((unlisten) => {
      if (!active) unlisten();
      else dispose = unlisten;
    }).catch(() => undefined);
    return () => {
      active = false;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !sessionId || loadedSessions.current.has(sessionId)) return;
    loadedSessions.current.add(sessionId);
    let active = true;
    void chatEventsRead(sessionId).then((events) => {
      if (!active) return;
      let restored: IndependentReviewState | undefined;
      let lastLogicalAttempt = 0;
      let activeLogicalAttempt: number | undefined;
      for (const entry of events) {
        if (entry.kind !== "independent_review" || !isReviewEvent(entry.payload)) continue;
        if (entry.payload.phase === "cleared") {
          restored = undefined;
          lastLogicalAttempt = 0;
          activeLogicalAttempt = undefined;
          continue;
        }
        const rawAttempt = entry.payload.attempt;
        if (entry.payload.phase === "reviewing") {
          activeLogicalAttempt = rawAttempt > lastLogicalAttempt
            ? rawAttempt
            : lastLogicalAttempt + 1;
        }
        const logicalAttempt = activeLogicalAttempt
          ?? (rawAttempt > lastLogicalAttempt ? rawAttempt : lastLogicalAttempt + 1);
        if (entry.payload.phase === "result" && activeLogicalAttempt === undefined) {
          activeLogicalAttempt = logicalAttempt;
        }
        lastLogicalAttempt = Math.max(lastLogicalAttempt, logicalAttempt);
        restored = applyReviewEvent(restored, {
          ...entry.payload,
          attempt: logicalAttempt,
        });
        if (entry.payload.phase === "complete") activeLogicalAttempt = undefined;
      }
      if (!restored) return;
      setStates((current) => {
        const live = current.get(sessionId);
        const merged = live ? mergeReviewStates(restored!, live) : restored!;
        return new Map(current).set(sessionId, merged);
      });
    }).catch(() => {
      loadedSessions.current.delete(sessionId);
    });
    return () => { active = false; };
  }, [sessionId]);

  return useMemo(() => states.get(sessionId) ?? null, [sessionId, states]);
}

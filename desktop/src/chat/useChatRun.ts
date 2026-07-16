// Run controller of the Chat controller stack. Owns turn execution and
// everything the backend session needs to run one: the streaming wiring
// (`useChatStream`), assistant-turn patching, backend-context sync/reset
// bookkeeping, context-window token accounting + notices, and the execution
// configuration surfaced in the header (status, model, permission). The
// cancellation-sensitive logic here is moved verbatim from the old Chat
// component — behaviour is unchanged, only its home is.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatModelOptions,
  chatModelSet,
  chatPermissionGet,
  chatPermissionRespond,
  chatPermissionSet,
  chatQuestionRespond,
  chatReasoningEffortGet,
  chatReasoningEffortSet,
  chatRewindToUserMessage,
  chatSetContext,
  chatStatus,
  chatSuggestTitle,
  isTauri,
  projectGoalProgress,
  projectIntentObserve,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type {
  ChatAttachment, ChatModelOption, ChatReasoningEffortView, ChatStatus, ChatTurn, PermissionModeView,
} from "../types";
import { CHAT_COPY } from "./i18n";
import { cleanChatTitle, patchLastAssistantTurn, textFromTurn, titleFromTurns } from "./model";
import type { ChatSession } from "./types";
import { useChatStream } from "./useChatStream";
import { onChatModelsUpdated } from "../modelEvents";
import { notifyProjectBriefUpdated } from "./ProjectBriefCard";
import {
  assistantTurn,
  completedAssistantBlocks,
  continueStoppedPrompt,
  contextForRetry,
  deferHeavyUiWork,
  EMPTY_ASSISTANT_RESPONSE,
  estimateTokens,
  formatCompactTokens,
  needsBackendContextReset,
  outgoingMessage,
  ringTokens,
  userTurn,
  visibleTurnError,
  type ContextNotice,
  type ContextOverride,
} from "./chatRunHelpers";

interface UseChatRunArgs {
  currentId: string;
  currentSession: ChatSession | null;
  currentSessionRef: React.MutableRefObject<ChatSession | null>;
  allSessionsRef: React.MutableRefObject<ChatSession[]>;
  patchTurns: (id: string, fn: (turns: ChatTurn[]) => ChatTurn[]) => void;
  updateSession: (id: string, fn: (session: ChatSession) => ChatSession) => void;
  setEditingTurnId: (id: string | null) => void;
}

export function useChatRun({
  currentId,
  currentSession,
  currentSessionRef,
  allSessionsRef,
  patchTurns,
  updateSession,
  setEditingTurnId,
}: UseChatRunArgs) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const setError = useStore((state) => state.setError);
  const currentProject = useStore((state) => state.currentProject);

  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [reasoning, setReasoning] = useState<ChatReasoningEffortView>({ supported: false, effort: "high" });
  const [reasoningBusy, setReasoningBusy] = useState(false);
  // After `/compact` the backend session shrinks but the visible transcript is
  // kept intact, so the transcript-derived token estimate (and thus the
  // ContextRing) would never move. Pin the ring to the real post-compaction
  // token count reported by the command, plus an anchor (turn count at compact
  // time) so later turns still accrue on top. Keyed per session; invalidated
  // automatically once the transcript is truncated below the anchor.
  const [contextOverrides, setContextOverrides] = useState<Map<string, ContextOverride>>(() => new Map());
  const [contextNotice, setContextNotice] = useState<ContextNotice | null>(null);
  const [estimatedContext, setEstimatedContext] = useState<{ sessionId: string; tokens: number }>({
    sessionId: "",
    tokens: 0,
  });

  const titleRequests = useRef(new Set<string>());
  const intentRequests = useRef(new Set<string>());
  const sendLocks = useRef(new Set<string>());
  const syncedTurnIds = useRef(new Map<string, Set<string>>());
  const backendContextNeedsReset = useRef(new Set<string>());
  const unsavedBackendTurns = useRef(new Map<string, ChatTurn[]>());
  const contextOverridesRef = useRef(contextOverrides);
  contextOverridesRef.current = contextOverrides;

  useEffect(() => {
    setContextNotice((notice) => notice && notice.sessionId === currentId ? notice : null);
  }, [currentId]);

  const markBackendContextSynced = useCallback((sessionId: string, turnsToMark: ChatTurn[]) => {
    const known = syncedTurnIds.current.get(sessionId) ?? new Set<string>();
    for (const turn of turnsToMark) known.add(turn.id);
    syncedTurnIds.current.set(sessionId, known);
  }, []);

  const patchAssistant = useCallback((
    sessionId: string,
    fn: (turn: ChatTurn) => ChatTurn,
    afterPatch?: (turns: ChatTurn[]) => void,
  ) => {
    patchTurns(sessionId, (turns) => {
      const copy = patchLastAssistantTurn(turns, fn);
      if (afterPatch) afterPatch(copy);
      return copy;
    });
  }, [patchTurns]);

  const suggestTitle = useCallback((sessionId: string, nextTurns: ChatTurn[]) => {
    if (!isTauri() || titleRequests.current.has(sessionId)) return;
    const userTurns = nextTurns.filter((turn) => turn.role === "user");
    const assistantTurns = nextTurns.filter((turn) => turn.role === "assistant");
    if (userTurns.length !== 1 || assistantTurns.length !== 1) return;
    const userText = textFromTurn(userTurns[0]).trim();
    const assistantText = textFromTurn(assistantTurns[0]).trim();
    if (!userText || !assistantText) return;
    titleRequests.current.add(sessionId);
    void chatSuggestTitle(userText, assistantText)
      .then((title) => {
        const trimmed = cleanChatTitle(title);
        if (!trimmed) return;
        updateSession(sessionId, (session) => {
          const fallback = titleFromTurns(session.turns);
          const current = cleanChatTitle(session.title);
          if (current && session.title !== "New chat" && session.title !== fallback) return session;
          return { ...session, title: trimmed };
        });
      })
      .catch(() => undefined);
  }, [updateSession]);

  const syncProjectContinuity = useCallback((sessionId: string, nextTurns: ChatTurn[]) => {
    if (!isTauri() || !currentProject?.id) return;
    const userTurns = nextTurns.filter((turn) => turn.role === "user");
    const assistantTurns = nextTurns.filter((turn) => turn.role === "assistant");
    const latestAssistant = assistantTurns[assistantTurns.length - 1];
    const assistantText = latestAssistant ? textFromTurn(latestAssistant).trim() : "";
    if (!assistantText) return;

    const observations = userTurns
      .map((turn) => ({ id: turn.id, text: textFromTurn(turn).trim() }))
      .filter((observation) => observation.text.length > 0);
    const newestObservation = observations[observations.length - 1];
    if (newestObservation) {
      const requestKey = `${sessionId}:${newestObservation.id}`;
      if (!intentRequests.current.has(requestKey)) {
        intentRequests.current.add(requestKey);
        void projectIntentObserve(currentProject.id, sessionId, observations)
        .then(notifyProjectBriefUpdated)
        .catch(() => {
          intentRequests.current.delete(requestKey);
        });
      }
    }

    const recentStatus = assistantText
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 260);
    if (!recentStatus) return;
    void projectGoalProgress(currentProject.id, recentStatus)
      .then(notifyProjectBriefUpdated)
      .catch(() => undefined);
  }, [currentProject?.id]);

  const onComplete = useCallback((sessionId: string, reply: string) => {
    patchAssistant(
      sessionId,
      (turn) => {
        const hasAssistantContent = turn.blocks.some((block) => (
          (block.kind === "text" && block.text.trim())
          || (block.kind === "thinking" && block.thinking.trim())
        ));
        // A successful invoke with neither final text nor streamed thinking is
        // an abnormal/empty termination, not a successful empty answer.
        if (!reply.trim() && !hasAssistantContent) {
          return {
            ...turn,
            streaming: false,
            error: EMPTY_ASSISTANT_RESPONSE,
            stopped: false,
          };
        }
        return {
          ...turn,
          blocks: completedAssistantBlocks(turn, reply),
          streaming: false,
          error: undefined,
          stopped: false,
        };
      },
      (nextTurns) => {
        markBackendContextSynced(sessionId, nextTurns);
        suggestTitle(sessionId, nextTurns);
        syncProjectContinuity(sessionId, nextTurns);
      },
    );
  }, [markBackendContextSynced, patchAssistant, suggestTitle, syncProjectContinuity]);

  const onError = useCallback((
    sessionId: string,
    error: string,
    stopped: boolean,
    sessionPreserved?: boolean,
  ) => {
    // A build/panic/pre-worker failure has no authoritative backend copy of
    // the UI's just-added user turn. Reconcile it before the next send so it
    // cannot disappear from model context.
    const needsBackendRepair = sessionPreserved === false;
    if (needsBackendRepair) backendContextNeedsReset.current.add(sessionId);
    const visibleError = visibleTurnError(error, stopped);
    patchAssistant(
      sessionId,
      (turn) => {
        // A late rejected invoke can arrive after the backend's authoritative
        // chat-error event. Do not let the subsequent expected cancellation
        // overwrite that real error with an empty stopped state.
        const nextError = visibleError ?? (stopped ? turn.error : undefined);
        return {
          ...turn,
          streaming: false,
          error: nextError,
          stopped: stopped && !nextError,
        };
      },
      needsBackendRepair
        ? (turns) => {
          const assistantIndex = turns.length - 1;
          const user = turns[assistantIndex - 1];
          const assistant = turns[assistantIndex];
          if (user?.role === "user" && assistant?.role === "assistant") {
            unsavedBackendTurns.current.set(sessionId, [user, assistant]);
          }
        }
        : undefined,
    );
  }, [patchAssistant]);

  // Pin the ContextRing to an authoritative backend token count — reported
  // after every turn (real usage) and after compaction — anchored at the
  // current turn count so later turns still accrue on top. Same override the
  // `/compact` path uses; the anchor guard in `ringTokens` self-heals if the
  // transcript is later truncated.
  const applyContextTokens = useCallback((sessionId: string, tokens: number) => {
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    const anchor = session ? session.turns.length : 0;
    setContextOverrides((prev) => new Map(prev).set(sessionId, { tokens, anchor }));
  }, [allSessionsRef]);

  const handleContextCompacted = useCallback((sessionId: string, tokensAfter: number) => {
    applyContextTokens(sessionId, tokensAfter);
    setContextNotice({
      kind: "compacted",
      sessionId,
      message: "Context was compacted automatically.",
      detail: `Earlier messages were summarized; backend context is now ${formatCompactTokens(tokensAfter)} tokens.`,
      createdAt: Date.now(),
    });
  }, [applyContextTokens]);

  const handleContextWarning = useCallback((event: {
    sessionId: string;
    usedTokens: number;
    contextWindow?: number | null;
    compactionBudget?: number | null;
  }) => {
    const budget = event.compactionBudget ?? event.contextWindow ?? status?.compactionBudget ?? status?.contextWindow ?? null;
    const pct = budget && budget > 0 ? Math.round((event.usedTokens / budget) * 100) : null;
    setContextNotice({
      kind: "warning",
      sessionId: event.sessionId,
      message: "Context is close to the auto-compact budget.",
      detail: budget
        ? `${formatCompactTokens(event.usedTokens)} / ${formatCompactTokens(budget)} tokens${pct != null ? ` (${pct}%)` : ""}.`
        : `${formatCompactTokens(event.usedTokens)} tokens in context.`,
      createdAt: Date.now(),
    });
  }, [status?.compactionBudget, status?.contextWindow]);

  // Current ring value for a session, so the compaction notice can report how
  // much context was freed (before → after).
  const readContextTokens = useCallback((sessionId: string): number | null => {
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return null;
    return ringTokens(session.turns, contextOverridesRef.current.get(sessionId));
  }, [allSessionsRef]);

  const { run, stop, runningSessionIds } = useChatStream({
    patchAssistant,
    onComplete,
    onError,
    onContextCompacted: handleContextCompacted,
    onContextTokens: applyContextTokens,
    onContextWarning: handleContextWarning,
    getContextTokens: readContextTokens,
  });
  const runningSessionIdsRef = useRef(runningSessionIds);
  runningSessionIdsRef.current = runningSessionIds;

  const currentChatBusy = runningSessionIds.has(currentId);
  const turns = currentSession?.turns ?? [];
  const currentContextOverride = contextOverrides.get(currentId);
  const estimatedTokens = currentContextOverride?.tokens
    ?? (estimatedContext.sessionId === currentId ? estimatedContext.tokens : 0);
  const contextMax = status?.ready
    ? (status.contextWindow ?? status.compactionBudget ?? null)
    : null;
  const currentContextNotice = contextNotice?.sessionId === currentId ? contextNotice : null;

  useEffect(() => {
    if (currentContextOverride) {
      setEstimatedContext({ sessionId: currentId, tokens: currentContextOverride.tokens });
      return;
    }
    setEstimatedContext((current) => current.sessionId === currentId
      ? current
      : { sessionId: currentId, tokens: 0 });
    return deferHeavyUiWork(() => {
      setEstimatedContext({ sessionId: currentId, tokens: estimateTokens(turns) });
    });
  }, [currentContextOverride, currentId, turns]);

  const refreshStatus = useCallback((model?: string | null) => {
    if (!isTauri()) {
      setStatus({ ready: true, model: copy.previewModel, provider: copy.browserProvider });
      return;
    }
    const request = model ? chatModelSet(model, false) : chatStatus();
    request.then(setStatus).catch((error) => setStatus({ ready: false, message: String(error) }));
  }, [copy.browserProvider, copy.previewModel]);

  const refreshModelOptions = useCallback(() => {
    if (!isTauri()) {
      setModelOptions([]);
      return;
    }
    chatModelOptions().then((opts) => setModelOptions(opts.options)).catch(() => setModelOptions([]));
  }, []);

  const refreshReasoning = useCallback((model?: string | null) => {
    if (!isTauri() || !model) {
      setReasoning({ supported: false, effort: "high" });
      return;
    }
    chatReasoningEffortGet(model).then(setReasoning).catch(() => {
      setReasoning({ supported: false, effort: "high" });
    });
  }, []);

  useEffect(() => {
    refreshStatus(currentSession?.model ?? null);
    if (!isTauri()) {
      setPermission({
        mode: "danger-full-access",
        label: copy.permissionLabels["danger-full-access"],
        description: copy.previewPermissionDescription,
      });
      return;
    }
    chatPermissionGet(currentId).then(setPermission).catch(() => setPermission(null));
    refreshModelOptions();
    refreshReasoning(currentSession?.model);
  }, [copy.permissionLabels, copy.previewPermissionDescription, currentId, currentSession?.model, refreshModelOptions, refreshReasoning, refreshStatus]);

  useEffect(() => onChatModelsUpdated(() => {
    refreshModelOptions();
    refreshStatus(currentSessionRef.current?.model ?? null);
  }), [refreshModelOptions, refreshStatus, currentSessionRef]);

  const activeModel = currentSession?.model || status?.model || null;

  // Options for the header model dropdown — the verified models from Settings,
  // plus the active model so the select never renders blank (e.g. a custom id,
  // an unverified running model, or the browser preview).
  const modelSelectOptions = useMemo(() => {
    const items = modelOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description ?? null,
    }));
    const current = activeModel;
    if (current && !items.some((item) => item.value === current)) {
      items.unshift({ value: current, label: current, description: null });
    }
    return items;
  }, [activeModel, modelOptions]);

  // Only meaningful to switch when there is more than the running model on offer.
  const canSwitchModel = modelSelectOptions.length > 1;

  const changeModel = useCallback(async (model: string) => {
    if (!model || model === activeModel || !currentSession) return;
    if (!isTauri()) {
      updateSession(currentSession.id, (session) => ({ ...session, model, updatedAt: Date.now() }));
      setStatus({ ready: true, model, provider: "Browser" });
      return;
    }
    setModelBusy(true);
    try {
      const nextStatus = await chatModelSet(model, false);
      setStatus(nextStatus);
      refreshReasoning(nextStatus.model ?? model);
      updateSession(currentSession.id, (session) => ({
        ...session,
        model: nextStatus.model ?? model,
        updatedAt: Date.now(),
      }));
    } catch (error) {
      setError(String(error));
    } finally {
      setModelBusy(false);
    }
  }, [activeModel, currentSession, refreshReasoning, setError, updateSession]);

  const changeReasoningEffort = useCallback(async (effort: string) => {
    if (!reasoning.supported || effort === reasoning.effort || !isTauri()) return;
    setReasoningBusy(true);
    try {
      const next = await chatReasoningEffortSet(effort);
      setReasoning({ ...next, supported: reasoning.supported });
    } catch (error) {
      setError(String(error));
    } finally {
      setReasoningBusy(false);
    }
  }, [reasoning.effort, reasoning.supported, setError]);

  const changePermission = useCallback(async (mode: string) => {
    if (!isTauri()) {
      const label = copy.permissionLabels[mode] ?? mode;
      setPermission({ mode, label, description: "" });
      return;
    }
    setPermissionBusy(true);
    try {
      setPermission(await chatPermissionSet(currentId, mode));
    } catch (error) {
      setError(String(error));
    } finally {
      setPermissionBusy(false);
    }
  }, [copy.permissionLabels, currentId, setError]);

  const respondPermission = useCallback(async (promptId: string, allow: boolean) => {
    if (!isTauri()) return;
    try {
      await chatPermissionRespond(promptId, allow);
    } catch (error) {
      setError(String(error));
    }
  }, [setError]);

  const respondQuestion = useCallback(async (toolUseId: string, answer: string) => {
    if (!isTauri()) return;
    try {
      await chatQuestionRespond(toolUseId, answer);
    } catch (error) {
      setError(String(error));
    }
  }, [setError]);

  const beginRun = useCallback(async (
    session: ChatSession,
    prefix: ChatTurn[],
    text: string,
    attached: ChatAttachment[],
    resetContext = false,
    promptOverride?: string | ChatSendRequest,
    rewindFromUser?: ChatTurn,
  ) => {
    // Render the submitted turn before *any* asynchronous preparation. Reading
    // a path attachment and rebuilding an edited/retried backend context can
    // both take noticeable time; holding this patch until they finish makes a
    // send look like it was ignored. The streaming assistant placeholder also
    // makes the composer enter its busy/Stop state immediately.
    patchTurns(session.id, () => [...prefix, userTurn(text, attached), assistantTurn()]);
    updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
    setEditingTurnId(null);

    if (!isTauri()) {
      patchAssistant(session.id, (turn) => ({
        ...turn,
        blocks: [{ kind: "text", text: copy.previewResponse }],
        streaming: false,
      }));
      return;
    }
    const shouldResetContext = backendContextNeedsReset.current.has(session.id)
      || needsBackendContextReset(session.turns, prefix, resetContext);
    try {
      const prompt = typeof promptOverride === "string"
        ? { text: promptOverride }
        : promptOverride ?? (await outgoingMessage(text, attached));
      const selectedModel = session.model || status?.model || undefined;
      const request: ChatSendRequest = {
        ...prompt,
        projectId: session.projectId,
        ...(selectedModel ? { model: selectedModel } : {}),
      };
      if (shouldResetContext) {
        // Retry/edit normally truncate history before an earlier user turn. Ask
        // the backend to rewind its authoritative session first; this retains
        // compaction summaries and untruncated tool content. Old or ambiguous
        // sessions safely fall back to the existing UI reconstruction.
        const recoveryTurns = unsavedBackendTurns.current.get(session.id);
        let tokens = recoveryTurns
          ? await chatSetContext(session.id, await contextForRetry(recoveryTurns), "append").catch(() => null)
          : null;
        const rewindMessage = rewindFromUser
          ? await outgoingMessage(textFromTurn(rewindFromUser), rewindFromUser.attachments ?? [])
          : undefined;
        if (rewindMessage) {
          const rewindTokens = await chatRewindToUserMessage(session.id, rewindMessage).catch(() => null);
          // Rewind must succeed for an edit/retry; a repaired append alone would
          // leave the rejected user turn at the end of the session.
          tokens = rewindTokens;
        }
        if (tokens == null) {
          tokens = await chatSetContext(session.id, await contextForRetry(prefix), "replace");
        }
        setContextOverrides((prev) => new Map(prev).set(session.id, { tokens, anchor: prefix.length }));
        markBackendContextSynced(session.id, prefix);
        backendContextNeedsReset.current.delete(session.id);
        unsavedBackendTurns.current.delete(session.id);
      } else {
        markBackendContextSynced(session.id, prefix);
      }
      await run(session.id, request);
    } catch (error) {
      // Context rebuilding is local preparation, not a stream error, so the
      // stream hook cannot surface this rejection for us. The optimistic pair
      // is already visible; finish its placeholder through the normal error
      // path and mark the backend for repair on the next send.
      const detail = String(error);
      onError(
        session.id,
        shouldResetContext ? `Unable to reset chat context: ${detail}` : detail,
        false,
        false,
      );
    }
  }, [copy.previewResponse, markBackendContextSynced, onError, patchAssistant, patchTurns, run, status?.model, updateSession, setEditingTurnId]);

  const retry = useCallback(async (assistant: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id) || sendLocks.current.has(session.id)) return;
    const assistantIndex = session.turns.findIndex((turn) => turn.id === assistant.id);
    const userIndex = assistantIndex - 1;
    const previousUser = session.turns[userIndex];
    if (userIndex < 0 || previousUser?.role !== "user") return;
    sendLocks.current.add(session.id);
    try {
      await beginRun(
        session,
        session.turns.slice(0, userIndex),
        textFromTurn(previousUser),
        previousUser.attachments ?? [],
        true,
        undefined,
        previousUser,
      );
    } finally {
      sendLocks.current.delete(session.id);
    }
  }, [beginRun, currentSessionRef]);

  const continueStopped = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id) || sendLocks.current.has(session.id)) return;
    sendLocks.current.add(session.id);
    try {
      await beginRun(
        session,
        session.turns,
        "Continue from where you stopped.",
        [],
        false,
        continueStoppedPrompt(),
      );
    } finally {
      sendLocks.current.delete(session.id);
    }
  }, [beginRun, currentSessionRef]);

  return {
    // stream
    run,
    stop,
    runningSessionIds,
    runningSessionIdsRef,
    currentChatBusy,
    sendLocks,
    // execution config (status / model / permission)
    status,
    setStatus,
    permission,
    setPermission,
    permissionBusy,
    changePermission,
    respondPermission,
    respondQuestion,
    modelBusy,
    reasoning,
    reasoningBusy,
    activeModel,
    modelSelectOptions,
    canSwitchModel,
    changeModel,
    changeReasoningEffort,
    refreshStatus,
    refreshModelOptions,
    // context accounting
    contextOverrides,
    setContextOverrides,
    estimatedTokens,
    contextMax,
    currentContextNotice,
    // turn execution
    beginRun,
    retry,
    continueStopped,
  };
}

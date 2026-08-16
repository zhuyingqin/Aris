// Run controller of the Chat controller stack. Owns turn execution and
// everything the backend session needs to run one: the streaming wiring
// (`useChatStream`), assistant-turn patching, backend-context sync/reset
// bookkeeping, context-window token accounting + notices, and the execution
// configuration surfaced in the header (status, model, permission). The
// cancellation-sensitive logic here is moved verbatim from the old Chat
// component — behaviour is unchanged, only its home is.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatCancel,
  chatContextTokens,
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
  onChatUiSessionUpdated,
  projectBriefReview,
  projectIntentObserve,
  remoteAgentChatCancel,
  remoteAgentChatSend,
  remoteAgentModelOptions,
  remoteAgentModelSet,
  reviewWorkflowDiscuss,
  type ChatSendRequest,
  type ChatTitleRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type {
  ChatAttachment, ChatModelOption, ChatReasoningEffortView, ChatStatus, ChatTurn, PermissionModeView,
} from "../types";
import { CHAT_COPY } from "./i18n";
import {
  cleanChatTitle,
  patchLastAssistantTurn,
  shouldRequestChatTitle,
  textFromTurn,
} from "./model";
import type { ChatSession } from "./types";
import { useChatStream } from "./useChatStream";
import { formatUserFacingError } from "../errorMessage";
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

const MAX_TITLE_ATTEMPTS = 4;
const MAX_TITLE_REQUEST_TEXT = 4000;
const MAX_TITLE_ANSWER_TEXT = 1500;
const MAX_TITLE_FOLLOW_UPS = 4;

/** Assemble the evidence the backend titles a conversation from: the anchor
 * request with its attachments, the answer to it, and the later questions that
 * show where a long conversation actually went. */
function titleRequestFromTurns(turns: ChatTurn[]): ChatTitleRequest | null {
  const userTurns = turns.filter((turn) => turn.role === "user");
  const first = userTurns[0];
  if (!first) return null;
  const user = textFromTurn(first).trim().slice(0, MAX_TITLE_REQUEST_TEXT);
  const attachments = (first.attachments ?? [])
    .map((attachment) => attachment.path || attachment.name)
    .filter((label): label is string => Boolean(label));
  if (!user && attachments.length === 0) return null;
  const answer = turns.find((turn) => (
    turn.role === "assistant" && !turn.error && !turn.stopped && textFromTurn(turn).trim()
  ));
  const followUps = userTurns
    .slice(1)
    .map((turn) => textFromTurn(turn).trim())
    .filter(Boolean)
    .slice(-MAX_TITLE_FOLLOW_UPS)
    .map((text) => text.slice(0, MAX_TITLE_REQUEST_TEXT));
  return {
    user,
    assistant: answer ? textFromTurn(answer).trim().slice(0, MAX_TITLE_ANSWER_TEXT) : "",
    attachments: attachments.slice(0, 6),
    followUps,
  };
}

function workflowRunIdForSession(session: ChatSession) {
  if (session.workflowRunId?.trim()) return session.workflowRunId;
  const key = session.workflowContextKey ?? "";
  return key.startsWith("review-workflow:")
    ? key.slice("review-workflow:".length)
    : null;
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

  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [reasoning, setReasoning] = useState<ChatReasoningEffortView>({
    supported: false,
    applied: false,
    effort: "high",
    transport: "unsupported",
  });
  const [reasoningBusy, setReasoningBusy] = useState(false);
  // Visible history survives compaction. Keep a live pin here and persist the
  // same backend value on the ChatSession for reloads and app restarts.
  const [contextOverrides, setContextOverrides] = useState<Map<string, ContextOverride>>(() => new Map());
  const [contextNotice, setContextNotice] = useState<ContextNotice | null>(null);
  const [estimatedContext, setEstimatedContext] = useState<{ sessionId: string; tokens: number }>({
    sessionId: "",
    tokens: 0,
  });

  const titleRequests = useRef(new Set<string>());
  const titleAttempts = useRef(new Map<string, number>());
  const intentRequests = useRef(new Set<string>());
  const pendingActivityReviews = useRef(new Map<string, {
    projectId: string;
    userTurnId: string;
    compactionBudget: number;
  }>());
  const activityReviewRequests = useRef(new Set<string>());
  const compactedActivitySessions = useRef(new Set<string>());
  const sendLocks = useRef(new Set<string>());
  // Context repair can await while the user presses Stop. A monotonically
  // increasing token lets Stop release the composer without an old send's
  // finally block deleting a newer send's lock later.
  const sendLockGenerations = useRef(new Map<string, number>());
  const syncedTurnIds = useRef(new Map<string, Set<string>>());
  const backendContextNeedsReset = useRef(new Set<string>());
  const unsavedBackendTurns = useRef(new Map<string, ChatTurn[]>());
  const contextHydrationRequests = useRef(new Set<string>());
  const contextOverridesRef = useRef(contextOverrides);
  contextOverridesRef.current = contextOverrides;

  const acquireSendLock = useCallback((sessionId: string): number | null => {
    if (sendLocks.current.has(sessionId)) return null;
    const generation = (sendLockGenerations.current.get(sessionId) ?? 0) + 1;
    sendLockGenerations.current.set(sessionId, generation);
    sendLocks.current.add(sessionId);
    return generation;
  }, []);

  const releaseSendLock = useCallback((sessionId: string, generation: number) => {
    if (sendLockGenerations.current.get(sessionId) !== generation) return;
    sendLocks.current.delete(sessionId);
  }, []);

  const cancelSendLock = useCallback((sessionId: string) => {
    sendLockGenerations.current.set(
      sessionId,
      (sendLockGenerations.current.get(sessionId) ?? 0) + 1,
    );
    sendLocks.current.delete(sessionId);
  }, []);

  useEffect(() => {
    setContextNotice((notice) => notice && notice.sessionId === currentId ? notice : null);
  }, [currentId]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void onChatUiSessionUpdated((event) => {
      if (
        event.operation !== "saved"
        || event.assistantComplete !== true
        || !event.latestUserTurnId
      ) return;
      const pending = pendingActivityReviews.current.get(event.sessionId);
      if (!pending || pending.userTurnId !== event.latestUserTurnId) return;
      if (event.contextTokens == null) return;
      if (event.contextTokensUserTurnId !== pending.userTurnId) return;
      pendingActivityReviews.current.delete(event.sessionId);
      const requestKey = `${pending.projectId}:${pending.userTurnId}`;
      if (activityReviewRequests.current.has(requestKey)) return;
      activityReviewRequests.current.add(requestKey);
      const compacted = compactedActivitySessions.current.delete(event.sessionId);
      void projectBriefReview(pending.projectId, {
        sessionId: event.sessionId,
        contextTokens: event.contextTokens,
        compactionBudget: pending.compactionBudget,
        compacted,
      })
        .then(notifyProjectBriefUpdated)
        .catch(() => undefined)
        .finally(() => activityReviewRequests.current.delete(requestKey));
    }).then((next) => {
      if (active) unlisten = next;
      else next();
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

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
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    if (!session) return;
    // A long conversation loads only its recent turns, so the visible user
    // turns undercount the questions asked. The refresh gate needs the real one.
    const questionCount = (session.questionCountBeforeLoadedTurns ?? 0)
      + nextTurns.filter((turn) => turn.role === "user").length;
    if (!shouldRequestChatTitle(session, questionCount)) return;
    // Generation can fail for reasons that outlive one turn (provider outage,
    // an interrupted background turn). Retrying every turn forever would just
    // repeat the failure, so cap the attempts for this app run.
    const attempts = titleAttempts.current.get(sessionId) ?? 0;
    if (attempts >= MAX_TITLE_ATTEMPTS) return;
    const request = titleRequestFromTurns(nextTurns);
    if (!request) return;
    titleRequests.current.add(sessionId);
    titleAttempts.current.set(sessionId, attempts + 1);
    void chatSuggestTitle(request)
      .then((title) => {
        const trimmed = cleanChatTitle(title);
        if (!trimmed) return;
        updateSession(sessionId, (current) => (
          // Re-check against the live session: a rename typed while the request
          // was in flight owns the title.
          shouldRequestChatTitle(current, questionCount)
            ? { ...current, title: trimmed, titleSource: "auto", titleQuestionCount: questionCount }
            : current
        ));
      })
      .catch(() => undefined)
      .finally(() => {
        titleRequests.current.delete(sessionId);
      });
  }, [allSessionsRef, updateSession]);

  const syncProjectContinuity = useCallback((sessionId: string, nextTurns: ChatTurn[]) => {
    if (!isTauri()) return;
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    const projectId = session?.projectId;
    if (!projectId || session.remoteAgent) return;
    const userTurns = nextTurns.filter((turn) => turn.role === "user");
    const latestUser = userTurns[userTurns.length - 1];
    const newestObservation = latestUser
      ? { id: latestUser.id, text: textFromTurn(latestUser).trim() }
      : null;
    if (newestObservation) {
      const requestKey = `${sessionId}:${newestObservation.id}`;
      if (!intentRequests.current.has(requestKey)) {
        intentRequests.current.add(requestKey);
        pendingActivityReviews.current.set(sessionId, {
          projectId,
          userTurnId: newestObservation.id,
          compactionBudget: status?.compactionBudget ?? status?.contextWindow ?? 0,
        });
        void projectIntentObserve(projectId, sessionId, [newestObservation])
          .then(() => {
            notifyProjectBriefUpdated();
          })
          .catch(() => {
            intentRequests.current.delete(requestKey);
          });
      }
    }
  }, [allSessionsRef, status?.compactionBudget, status?.contextWindow]);

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
    updateSession(sessionId, (item) => {
      const contextTokensUserTurnId = [...item.turns]
        .reverse()
        .find((turn) => turn.role === "user")?.id;
      return item.contextTokens === tokens
        && item.contextTokensUserTurnId === contextTokensUserTurnId
        ? item
        : { ...item, contextTokens: tokens, contextTokensUserTurnId };
    });
  }, [allSessionsRef, updateSession]);

  const handleContextCompacted = useCallback((sessionId: string, tokensAfter: number) => {
    compactedActivitySessions.current.add(sessionId);
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
    return contextOverridesRef.current.get(sessionId)?.tokens
      ?? session.contextTokens
      ?? ringTokens(session.turns, undefined);
  }, [allSessionsRef]);

  const { run, stop, runningSessionIds } = useChatStream({
    language,
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
  const authoritativeContextTokens = currentContextOverride?.tokens ?? currentSession?.contextTokens;
  const estimatedTokens = authoritativeContextTokens
    ?? (estimatedContext.sessionId === currentId ? estimatedContext.tokens : 0);
  const contextMax = status?.ready
    ? (status.contextWindow ?? status.compactionBudget ?? null)
    : null;
  const currentContextNotice = contextNotice?.sessionId === currentId ? contextNotice : null;
  const dismissContextNotice = useCallback(() => {
    setContextNotice((notice) => notice?.sessionId === currentId ? null : notice);
  }, [currentId]);

  useEffect(() => {
    if (authoritativeContextTokens != null) {
      setEstimatedContext({ sessionId: currentId, tokens: authoritativeContextTokens });
      return;
    }
    setEstimatedContext((current) => current.sessionId === currentId
      ? current
      : { sessionId: currentId, tokens: 0 });
    return deferHeavyUiWork(() => {
      setEstimatedContext({ sessionId: currentId, tokens: estimateTokens(turns) });
    });
  }, [authoritativeContextTokens, currentId, turns]);

  // Hydrate chats saved before `contextTokens` was part of the UI projection.
  // Without this, a reload falls back to the complete visible transcript even
  // if the backend had already compacted its separate execution session.
  useEffect(() => {
    if (
      !isTauri()
      || !currentSession
      || Boolean(currentSession.remoteAgent)
      || Boolean(workflowRunIdForSession(currentSession))
      || currentSession.contextTokens != null
      || currentChatBusy
      || contextHydrationRequests.current.has(currentSession.id)
    ) return;
    contextHydrationRequests.current.add(currentSession.id);
    let disposed = false;
    void chatContextTokens(currentSession.id)
      .then((tokens) => {
        if (!disposed && tokens != null) applyContextTokens(currentSession.id, tokens);
      })
      .catch(() => {
        contextHydrationRequests.current.delete(currentSession.id);
      });
    return () => {
      disposed = true;
    };
  }, [applyContextTokens, currentChatBusy, currentSession, currentSession?.contextTokens]);

  const refreshStatus = useCallback((model?: string | null) => {
    if (!isTauri()) {
      setStatus({ ready: true, model: copy.previewModel, provider: copy.browserProvider });
      return;
    }
    const request = model ? chatModelSet(model, false) : chatStatus();
    request.then(setStatus).catch((error) => setStatus({ ready: false, message: formatUserFacingError(error, language) }));
  }, [copy.browserProvider, copy.previewModel, language]);

  const refreshModelOptions = useCallback(() => {
    if (!isTauri()) {
      setModelOptions([]);
      return;
    }
    chatModelOptions().then((opts) => setModelOptions(opts.options)).catch(() => setModelOptions([]));
  }, []);

  const refreshReasoning = useCallback((model?: string | null) => {
    if (!isTauri() || !model) {
      setReasoning({ supported: false, applied: false, effort: "high", transport: "unsupported" });
      return;
    }
    chatReasoningEffortGet(model).then(setReasoning).catch(() => {
      setReasoning({ supported: false, applied: false, effort: "high", transport: "unsupported" });
    });
  }, []);

  useEffect(() => {
    if (currentSession?.remoteAgent) {
      let disposed = false;
      const binding = currentSession.remoteAgent;
      setStatus({
        ready: true,
        model: currentSession.model ?? `${binding.nodeName} Agent`,
        provider: "Remote computer",
      });
      setPermission(null);
      setModelOptions([]);
      setReasoning({ supported: false, applied: false, effort: "high", transport: "unsupported" });
      if (!isTauri()) return () => { disposed = true; };
      setModelBusy(true);
      void remoteAgentModelOptions(binding.nodeId, binding.projectId, binding.sessionId)
        .then((selection) => {
          if (disposed) return;
          setModelOptions(selection.options);
          setStatus({
            ready: true,
            model: selection.model ?? `${binding.nodeName} Agent`,
            provider: "Remote computer",
          });
          const selectedModel = selection.model ?? null;
          if (selectedModel !== (currentSession.model ?? null)) {
            updateSession(currentSession.id, (session) => ({
              ...session,
              model: selectedModel,
            }));
          }
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        })
        .finally(() => {
          if (!disposed) setModelBusy(false);
        });
      return () => {
        disposed = true;
      };
    }
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
  }, [
    copy.permissionLabels,
    copy.previewPermissionDescription,
    currentId,
    currentSession?.id,
    currentSession?.model,
    currentSession?.remoteAgent,
    refreshModelOptions,
    refreshReasoning,
    refreshStatus,
    setError,
    updateSession,
  ]);

  useEffect(() => onChatModelsUpdated(() => {
    if (currentSessionRef.current?.remoteAgent) return;
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
    if (currentSession.remoteAgent) {
      setModelBusy(true);
      try {
        const binding = currentSession.remoteAgent;
        const selection = await remoteAgentModelSet(
          binding.nodeId,
          binding.projectId,
          binding.sessionId,
          model,
        );
        setModelOptions(selection.options);
        setStatus({
          ready: true,
          model: selection.model ?? model,
          provider: "Remote computer",
        });
        updateSession(currentSession.id, (session) => ({
          ...session,
          model: selection.model ?? model,
          updatedAt: Date.now(),
        }));
      } catch (error) {
        setError(String(error));
      } finally {
        setModelBusy(false);
      }
      return;
    }
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
      throw error;
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
      if (session.remoteAgent) {
        if (attached.length > 0) {
          throw new Error("Remote Agent chat does not support attachments yet.");
        }
        const prompt = typeof promptOverride === "string"
          ? promptOverride
          : promptOverride?.text ?? text;
        const binding = session.remoteAgent;
        await run(session.id, prompt, {
          send: (_sessionId, message) => remoteAgentChatSend({
            nodeId: binding.nodeId,
            localSessionId: session.id,
            projectId: binding.projectId,
            remoteSessionId: binding.sessionId,
            message: typeof message === "string" ? message : message.text,
          }),
          cancel: (localSessionId) => remoteAgentChatCancel(localSessionId),
        });
        return;
      }
      const basePrompt = typeof promptOverride === "string"
        ? { text: promptOverride }
        : promptOverride ?? (await outgoingMessage(text, attached));
      const selectedModel = session.model || status?.model || undefined;
      const workflowRunId = workflowRunIdForSession(session);
      if (workflowRunId) {
        if (attached.length > 0 || basePrompt.images?.length) {
          throw new Error("Workflow discussion does not accept attachments yet.");
        }
        if (shouldResetContext) {
          throw new Error("Workflow conversations are append-only; retry from the current stage instead.");
        }
        await run(session.id, basePrompt.text, {
          send: async (_sessionId, message) => {
            const userText = typeof message === "string" ? message : message.text;
            const reply = await reviewWorkflowDiscuss({
              runId: workflowRunId,
              text: userText,
            });
            return reply.text;
          },
          cancel: (sessionId) => chatCancel(sessionId),
        });
        return;
      }
      const prompt = basePrompt;
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
        applyContextTokens(session.id, tokens);
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
      const detail = formatUserFacingError(error, language);
      onError(
        session.id,
        shouldResetContext ? `Unable to reset chat context: ${detail}` : detail,
        false,
        false,
      );
    }
  }, [applyContextTokens, copy.previewResponse, language, markBackendContextSynced, onError, patchAssistant, patchTurns, run, status?.model, updateSession, setEditingTurnId]);

  // Resume a stopped OR failed turn without discarding its work: append a
  // continuation on top of the current transcript and let the backend reuse its
  // preserved session (an unpreserved failure is instead reconstructed by
  // `beginRun`'s repair path). Shared by the stopped-turn "Continue" action and
  // the failed-turn "Retry" action.
  const resumeSession = useCallback(async (session: ChatSession) => {
    if (runningSessionIdsRef.current.has(session.id) || sendLocks.current.has(session.id)) return;
    const sendLock = acquireSendLock(session.id);
    if (sendLock == null) return;
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
      releaseSendLock(session.id, sendLock);
    }
  }, [acquireSendLock, beginRun, releaseSendLock]);

  const retry = useCallback(async (assistant: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id) || sendLocks.current.has(session.id)) return;
    // A failed turn keeps every tool call/edit it finished before the error —
    // the backend persists them (session_preserved). Recover by resuming on top
    // of that work instead of rewinding to the user message and re-running,
    // which would overwrite everything the turn already did. The destructive
    // rewind stays only for a deliberate regenerate of a turn that did NOT fail.
    if (assistant.error) {
      await resumeSession(session);
      return;
    }
    const assistantIndex = session.turns.findIndex((turn) => turn.id === assistant.id);
    const userIndex = assistantIndex - 1;
    const previousUser = session.turns[userIndex];
    if (userIndex < 0 || previousUser?.role !== "user") return;
    const sendLock = acquireSendLock(session.id);
    if (sendLock == null) return;
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
      releaseSendLock(session.id, sendLock);
    }
  }, [acquireSendLock, beginRun, resumeSession, currentSessionRef, releaseSendLock]);

  const continueStopped = useCallback(async () => {
    const session = currentSessionRef.current;
    if (session) await resumeSession(session);
  }, [resumeSession, currentSessionRef]);

  return {
    // stream
    run,
    stop,
    runningSessionIds,
    runningSessionIdsRef,
    currentChatBusy,
    sendLocks,
    acquireSendLock,
    releaseSendLock,
    cancelSendLock,
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
    applyContextTokens,
    estimatedTokens,
    contextMax,
    currentContextNotice,
    dismissContextNotice,
    // turn execution
    beginRun,
    retry,
    continueStopped,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  chatPermissionGet,
  chatPermissionRespond,
  chatPermissionSet,
  chatQuestionRespond,
  chatSetContext,
  chatStatus,
  fileRead,
  isTauri,
  type ChatContextMessage,
  type ChatSendRequest,
} from "../api/tauri";
import ChatMessage from "../chat/ChatMessage";
import { continueStoppedPrompt, visibleTurnError } from "../chat/chatRunHelpers";
import { makeId, patchLastAssistantTurn, textFromTurn, transcriptFromTurn } from "../chat/model";
import { useChatStream } from "../chat/useChatStream";
import { formatUserFacingError } from "../errorMessage";
import { useStore } from "../store";
import type { ChatAttachment, ChatBlock, ChatStatus, ChatTurn, PermissionModeView } from "../types";
import { LAB_COPY } from "./i18n";
import { useLabStore } from "./labStore";
import type { NotebookCell } from "./labTypes";

const LAB_ASSISTANT_SESSIONS_KEY = "somniq-lab-assistant-sessions-v1";
const LAB_ASSISTANT_LEGACY_SESSIONS_KEY = "aris-lab-assistant-sessions-v1";
const MAX_LAB_ASSISTANT_SESSIONS = 30;

const PERMISSION_ORDER: Array<"read-only" | "workspace-write" | "prompt" | "danger-full-access"> = [
  "read-only",
  "workspace-write",
  "prompt",
  "danger-full-access",
];

type LabAssistantIconName = "file" | "more" | "new" | "send" | "shield" | "stop";

function LabAssistantIcon({ name }: { name: LabAssistantIconName }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      {name === "file" && (
        <path d="M4 2.7h5l3 3v7.6H4zM9 2.9v3h3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "more" && (
        <path d="M4 8h.1M8 8h.1M12 8h.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      )}
      {name === "new" && (
        <path d="M8 2.8v10.4M2.8 8h10.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      )}
      {name === "send" && (
        <path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "shield" && (
        <path d="M8 2.5 12.2 4v3.2c0 2.6-1.6 4.8-4.2 6.3-2.6-1.5-4.2-3.7-4.2-6.3V4z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "stop" && (
        <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.1" fill="currentColor" />
      )}
    </svg>
  );
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

function notebookSummary(cells: NotebookCell[]): string {
  if (cells.length === 0) return "Notebook has no cells.";
  const lines = cells.slice(0, 10).map((cell, index) => {
    const kind = cell.cell_type === "markdown" ? "markdown" : "code";
    const source = compactLine(cellSource(cell));
    const outputCount = cell.outputs?.length ?? 0;
    return `${index + 1}. ${kind}${outputCount ? `, ${outputCount} outputs` : ""}: ${source || "(empty)"}`;
  });
  if (cells.length > 10) lines.push(`... ${cells.length - 10} more cells`);
  return lines.join("\n");
}

type ActiveKind = "notebook" | "file" | null;

interface LabAssistantSession {
  id: string;
  projectId: string;
  title: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

function labContext(projectPath: string | null, activePath: string | null, activeKind: ActiveKind, cells: NotebookCell[]): string {
  return [
    "You are the Lab side assistant inside SomniQ.",
    "Help the user inspect files, edit workspace code when requested, and reason about the current Lab item.",
    projectPath ? `Project path: ${projectPath}` : null,
    activeKind === "file" && activePath ? `Current file: ${activePath}` : null,
    activeKind === "notebook" && activePath ? `Current notebook: ${activePath}` : null,
    !activeKind ? "No Lab item is selected." : null,
    activeKind === "notebook" ? "Notebook snapshot:" : null,
    activeKind === "notebook" ? notebookSummary(cells) : null,
  ].filter(Boolean).join("\n");
}

async function attachmentContent(attachment: ChatAttachment): Promise<string> {
  if (!attachment.path) return attachment.content ?? "";
  try {
    return await fileRead(attachment.path, 500);
  } catch {
    return attachment.content ?? "(Unable to read attached file.)";
  }
}

async function requestFromInput(
  text: string,
  attachments: ChatAttachment[],
  context: string,
): Promise<ChatSendRequest> {
  const sections = [context ? `[Lab context]\n${context}` : "", text.trim()];
  for (const attachment of attachments) {
    const content = await attachmentContent(attachment);
    sections.push(`[Attached file: ${attachment.path ?? attachment.name}]\n\`\`\`\n${content}\n\`\`\``);
  }
  return { text: sections.filter(Boolean).join("\n\n") };
}

async function contextFromTurns(turns: ChatTurn[], context: string): Promise<ChatContextMessage[]> {
  const messages: ChatContextMessage[] = [{ role: "user", text: `[Lab context]\n${context}` }];
  for (const turn of turns) {
    // Keep stopped AND failed turns — their partial output and tool activity is
    // real, backend-preserved context needed to resume coherently. Only an
    // actually in-flight turn is unsafe to serialize. Dropping failed turns here
    // is what made a Lab "retry"/"continue" silently wipe everything the failed
    // turn had already done.
    if (turn.streaming) continue;
    if (turn.role === "user") {
      const text = textFromTurn(turn).trim();
      if (!text) continue;
      const request = await requestFromInput(text, turn.attachments ?? [], "");
      messages.push({ role: "user", text: request.text.trim() });
    } else {
      // Serialize the full transcript (tool calls + results, interrupted ones
      // flagged) for every completed, stopped, and failed turn. This context
      // replaces the backend session wholesale, so text-only reconstruction
      // would drop each turn's tool activity — making an edit/retry from an
      // earlier turn forget everything the model learned by acting.
      const text = transcriptFromTurn(turn).trim();
      if (!text) continue;
      messages.push({ role: "assistant", text });
    }
  }
  return messages;
}

function userTurn(text: string, attachments: ChatAttachment[]): ChatTurn {
  return {
    id: makeId("turn"),
    role: "user",
    blocks: [{ kind: "text", text: text.trim() || "Attached context" }],
    attachments,
  };
}

function assistantTurn(): ChatTurn {
  return { id: makeId("turn"), role: "assistant", blocks: [], streaming: true };
}

function assistantTextTurn(text: string): ChatTurn {
  return { id: makeId("turn"), role: "assistant", blocks: [{ kind: "text", text }] };
}

function textBlocksHaveContent(blocks: ChatBlock[]): boolean {
  return blocks.some((block) => block.kind === "text" && block.text.trim());
}

function thinkingFallbackText(blocks: ChatBlock[]): string {
  return blocks
    .filter((block): block is Extract<ChatBlock, { kind: "thinking" }> => block.kind === "thinking")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
}

function hasRenderableBlock(turn: ChatTurn): boolean {
  return turn.blocks.some((block) => {
    if (block.kind === "text") return Boolean(block.text.trim());
    if (block.kind === "thinking") return Boolean(block.thinking.trim());
    return true;
  });
}

function completedAssistantBlocks(turn: ChatTurn, reply: string, emptyResponseText: string): ChatBlock[] {
  if (textBlocksHaveContent(turn.blocks)) return turn.blocks;
  if (reply.trim()) return [...turn.blocks, { kind: "text", text: reply }];
  const fallback = thinkingFallbackText(turn.blocks);
  if (fallback) return [{ kind: "text", text: fallback }];
  if (hasRenderableBlock(turn)) return turn.blocks;
  return [{ kind: "text", text: emptyResponseText }];
}

function firstUserText(turns: ChatTurn[]): string {
  const first = turns.find((turn) => turn.role === "user");
  const text = first ? textFromTurn(first).trim() : "";
  return text.replace(/\s+/g, " ").slice(0, 64) || "Lab chat";
}

function normalizeSession(raw: Partial<LabAssistantSession>, fallbackProjectId: string): LabAssistantSession | null {
  if (!raw || typeof raw !== "object") return null;
  const turns = Array.isArray(raw.turns) ? raw.turns.filter((turn): turn is ChatTurn => Boolean(turn)) : [];
  if (turns.length === 0) return null;
  const now = Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : makeId("lab-chat"),
    projectId: typeof raw.projectId === "string" && raw.projectId ? raw.projectId : fallbackProjectId,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : firstUserText(turns),
    turns,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
  };
}

function loadLabAssistantSessions(fallbackProjectId: string): LabAssistantSession[] {
  try {
    const raw = localStorage.getItem(LAB_ASSISTANT_SESSIONS_KEY) ?? localStorage.getItem(LAB_ASSISTANT_LEGACY_SESSIONS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Partial<LabAssistantSession>[])
      .map((session) => normalizeSession(session, fallbackProjectId))
      .filter((session): session is LabAssistantSession => Boolean(session));
  } catch {
    return [];
  }
}

function saveLabAssistantSessions(sessions: LabAssistantSession[]) {
  try {
    localStorage.setItem(LAB_ASSISTANT_SESSIONS_KEY, JSON.stringify(sessions.slice(0, MAX_LAB_ASSISTANT_SESSIONS)));
    localStorage.removeItem(LAB_ASSISTANT_LEGACY_SESSIONS_KEY);
  } catch {
    // Ignore storage failures; the active Lab chat remains in memory.
  }
}

function makeLabAssistantSession(projectId: string, turns: ChatTurn[], id = makeId("lab-chat")): LabAssistantSession {
  const now = Date.now();
  return {
    id,
    projectId,
    title: firstUserText(turns),
    turns,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertLabAssistantSession(
  sessions: LabAssistantSession[],
  projectId: string,
  id: string,
  turns: ChatTurn[],
): LabAssistantSession[] {
  if (turns.length === 0) return sessions;
  const existing = sessions.find((session) => session.id === id);
  const next: LabAssistantSession = {
    ...(existing ?? makeLabAssistantSession(projectId, turns, id)),
    projectId,
    title: firstUserText(turns),
    turns,
    updatedAt: Date.now(),
  };
  return [
    next,
    ...sessions.filter((session) => session.id !== id),
  ].slice(0, MAX_LAB_ASSISTANT_SESSIONS);
}

function initialLabAssistantState(projectId: string) {
  const sessions = loadLabAssistantSessions(projectId);
  return {
    sessions,
  };
}

interface Props {
  projectId: string | null;
  projectPath: string | null;
  activePath: string | null;
  activeKind: ActiveKind;
  cells: NotebookCell[];
  attachments: ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
}

export default function LabAssistant({
  projectId,
  projectPath,
  activePath,
  activeKind,
  cells,
  attachments,
  onAttachmentsChange,
}: Props) {
  const language = useStore((s) => s.language);
  const copy = LAB_COPY[language];
  const labProjectId = projectId ?? "default";
  const initialState = useRef<ReturnType<typeof initialLabAssistantState> | null>(null);
  if (initialState.current === null) {
    initialState.current = initialLabAssistantState(labProjectId);
  }
  const [savedSessions, setSavedSessions] = useState<LabAssistantSession[]>(() => initialState.current!.sessions);
  const [sessionId, setSessionId] = useState(() => makeId("lab-chat"));
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const lastSavedSignature = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const context = useMemo(() => labContext(projectPath, activePath, activeKind, cells), [activeKind, activePath, cells, projectPath]);
  const projectSessions = useMemo(
    () => savedSessions.filter((session) => session.projectId === labProjectId),
    [labProjectId, savedSessions],
  );

  useEffect(() => {
    const sessions = loadLabAssistantSessions(labProjectId);
    setSavedSessions(sessions);
    setSessionId(makeId("lab-chat"));
    setTurns([]);
    setInput("");
    setEditingTurnId(null);
    setHistoryOpen(false);
    lastSavedSignature.current = "";
    onAttachmentsChange([]);
  }, [labProjectId, onAttachmentsChange]);

  useEffect(() => {
    if (turns.length === 0) return;
    const signature = `${sessionId}:${turns.length}:${textFromTurn(turns[turns.length - 1])}:${turns[turns.length - 1]?.streaming ? "streaming" : "done"}`;
    if (signature === lastSavedSignature.current) return;
    lastSavedSignature.current = signature;
    setSavedSessions((previous) => {
      const next = upsertLabAssistantSession(previous, labProjectId, sessionId, turns);
      saveLabAssistantSessions(next);
      return next;
    });
  }, [labProjectId, sessionId, turns]);

  const patchAssistant = useCallback((eventSessionId: string, fn: (turn: ChatTurn) => ChatTurn) => {
    if (eventSessionId !== sessionId) return;
    setTurns((previous) => patchLastAssistantTurn(previous, fn));
  }, [sessionId]);

  const onComplete = useCallback((eventSessionId: string, reply: string) => {
    patchAssistant(eventSessionId, (turn) => ({
      ...turn,
      blocks: completedAssistantBlocks(turn, reply, copy.emptyAssistantResponse),
      streaming: false,
      error: undefined,
      stopped: false,
    }));
  }, [copy.emptyAssistantResponse, patchAssistant]);

  const onError = useCallback((eventSessionId: string, error: string, stopped: boolean) => {
    const visible = visibleTurnError(error, stopped);
    patchAssistant(eventSessionId, (turn) => ({
      ...turn,
      streaming: false,
      error: visible,
      stopped,
    }));
  }, [patchAssistant]);

  const respondQuestion = useCallback(async (toolUseId: string, answer: string) => {
    if (!isTauri()) return;
    try {
      await chatQuestionRespond(toolUseId, answer);
    } catch (error) {
      onError(sessionId, formatUserFacingError(error, language), false);
    }
  }, [language, onError, sessionId]);

  const { run, stop, runningSessionIds } = useChatStream({ patchAssistant, onComplete, onError });
  const busy = runningSessionIds.has(sessionId);

  // Tell the Lab to pause its notebook external-edit poll while a conversation
  // runs: the assistant is the editor, so reviewing should happen once it settles
  // — not by reloading the view every couple of seconds mid-stream.
  const setAssistantBusy = useLabStore((state) => state.setAssistantBusy);
  useEffect(() => {
    setAssistantBusy(busy);
    return () => setAssistantBusy(false);
  }, [busy, setAssistantBusy]);

  useEffect(() => {
    if (!isTauri()) {
      setStatus({ ready: true, model: copy.previewStatusModelLabel, provider: copy.browserProviderLabel });
      setPermission({ mode: "workspace-write", label: copy.permissionOptionLabels["workspace-write"], description: "" });
      return;
    }
    chatStatus().then(setStatus).catch((error) => setStatus({ ready: false, message: formatUserFacingError(error, language) }));
    chatPermissionGet(sessionId).then(setPermission).catch(() => setPermission(null));
  }, [copy.browserProviderLabel, copy.permissionOptionLabels, copy.previewStatusModelLabel, language, sessionId]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".lab-assistant-history") || target?.closest(".lab-assistant-history-toggle")) return;
      setHistoryOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [historyOpen]);

  const beginRun = useCallback(async (
    prefix: ChatTurn[],
    text: string,
    attached: ChatAttachment[],
    resetContext = false,
    promptOverride?: ChatSendRequest,
  ) => {
    const prompt = promptOverride ?? (await requestFromInput(text, attached, context));
    if (!isTauri()) {
      setTurns([...prefix, userTurn(text, attached), assistantTextTurn(copy.labPreviewResponse)]);
      setInput("");
      onAttachmentsChange([]);
      setEditingTurnId(null);
      return;
    }

    if (resetContext) {
      await chatSetContext(sessionId, await contextFromTurns(prefix, context));
    }
    setTurns([...prefix, userTurn(text, attached), assistantTurn()]);
    setInput("");
    onAttachmentsChange([]);
    setEditingTurnId(null);
    await run(sessionId, prompt);
  }, [context, copy.labPreviewResponse, onAttachmentsChange, run, sessionId]);

  const send = useCallback(async () => {
    if (sendLock.current || busy || (!input.trim() && attachments.length === 0)) return;
    if (!status?.ready && isTauri()) return;
    sendLock.current = true;
    try {
      const prefix = editingTurnId
        ? turns.slice(0, Math.max(0, turns.findIndex((turn) => turn.id === editingTurnId)))
        : turns;
      await beginRun(prefix, input, attachments, Boolean(editingTurnId));
    } finally {
      sendLock.current = false;
    }
  }, [attachments, beginRun, busy, editingTurnId, input, status?.ready, turns]);

  // Non-destructive recovery shared by the stopped-turn "Continue" and the
  // failed-turn "Retry": rebuild the backend context from the full transcript —
  // now including the failed turn's preserved work (see `contextFromTurns`) —
  // then continue on top of it instead of re-running from scratch.
  const resume = useCallback(async () => {
    if (busy || sendLock.current) return;
    sendLock.current = true;
    try {
      await beginRun(turns, copy.continueFromStoppedLabel, [], true, { text: continueStoppedPrompt() });
    } finally {
      sendLock.current = false;
    }
  }, [beginRun, busy, copy.continueFromStoppedLabel, turns]);

  const retry = useCallback(async (assistant: ChatTurn) => {
    if (busy || sendLock.current) return;
    // A failed turn's completed tool calls/edits are preserved context; resume
    // from them rather than truncating + re-running, which would discard the
    // work the failed turn already did.
    if (assistant.error) {
      await resume();
      return;
    }
    const assistantIndex = turns.findIndex((turn) => turn.id === assistant.id);
    const userIndex = assistantIndex - 1;
    const previousUser = turns[userIndex];
    if (userIndex < 0 || previousUser?.role !== "user") return;
    sendLock.current = true;
    try {
      await beginRun(turns.slice(0, userIndex), textFromTurn(previousUser), previousUser.attachments ?? [], true);
    } finally {
      sendLock.current = false;
    }
  }, [beginRun, busy, resume, turns]);

  const edit = useCallback((turn: ChatTurn) => {
    if (busy) return;
    setInput(textFromTurn(turn));
    onAttachmentsChange(turn.attachments ?? []);
    setEditingTurnId(turn.id);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [busy, onAttachmentsChange]);

  const continueStopped = useCallback(async () => {
    await resume();
  }, [resume]);

  const changePermission = async (mode: string) => {
    if (!isTauri()) {
      const label = copy.permissionOptionLabels[mode as keyof typeof copy.permissionOptionLabels] ?? mode;
      setPermission({ mode, label, description: "" });
      return;
    }
    setPermissionBusy(true);
    try {
      setPermission(await chatPermissionSet(sessionId, mode));
    } finally {
      setPermissionBusy(false);
    }
  };

  const removeAttachment = (id: string) => {
    onAttachmentsChange(attachments.filter((attachment) => attachment.id !== id));
  };

  const setStarter = (text: string) => {
    setInput(text);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const ready = Boolean(status?.ready);
  const canSubmit = !busy && (ready || !isTauri()) && (input.trim().length > 0 || attachments.length > 0);
  const modelLabel = status?.ready
    ? `${status.provider ?? copy.modelFallbackLabel}${status.model ? ` / ${status.model}` : ""}`
    : status?.message ?? copy.checkingModelLabel;
  const activeLabel = activePath ? basename(activePath) : copy.noItemLabel;
  const openSavedSession = (session: LabAssistantSession) => {
    if (busy) return;
    setSessionId(session.id);
    setTurns(session.turns);
    setInput("");
    setEditingTurnId(null);
    setHistoryOpen(false);
    onAttachmentsChange([]);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const resetAssistant = () => {
    if (busy) return;
    const nextId = makeId("lab-chat");
    setSessionId(nextId);
    setTurns([]);
    setInput("");
    setEditingTurnId(null);
    setHistoryOpen(false);
    lastSavedSignature.current = "";
    onAttachmentsChange([]);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="lab-assistant">
      <div className="lab-assistant-head">
        <div className="lab-assistant-tabs" aria-label={copy.labAssistantTabsAria}>
          <button className="lab-assistant-tab active" type="button">{copy.chatTabLabel}</button>
          <button
            className="lab-assistant-icon-btn lab-assistant-history-toggle"
            type="button"
            title={copy.historyToggleTitle}
            aria-label={copy.historyToggleTitle}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <LabAssistantIcon name="more" />
          </button>
        </div>
        <div className="lab-assistant-head-actions">
          <button
            className="lab-assistant-icon-btn"
            type="button"
            onClick={resetAssistant}
            disabled={busy}
            title={copy.newChatTitle}
            aria-label={copy.newChatTitle}
          >
            <LabAssistantIcon name="new" />
          </button>
        </div>
        {historyOpen && (
          <div className="lab-assistant-history" role="menu" aria-label={copy.historyToggleTitle}>
            <div className="lab-assistant-history-title">{copy.historyTitle}</div>
            {projectSessions.length === 0 ? (
              <div className="lab-assistant-history-empty">{copy.historyEmpty}</div>
            ) : (
              projectSessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === sessionId ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={() => openSavedSession(session)}
                >
                  <span className="lab-assistant-history-name">{session.title}</span>
                  <span className="lab-assistant-history-meta">
                    {copy.historyMeta(new Date(session.updatedAt).toLocaleString(), session.turns.length)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="lab-assistant-context-bar">
        <span className={`lab-assistant-model${ready ? " ready" : " error"}`} title={modelLabel}>
          <span className="lab-assistant-model-dot" aria-hidden="true" />
          {modelLabel}
        </span>
      </div>

      <div className="lab-assistant-turns" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="lab-assistant-empty">
            <strong>{copy.askAboutNotebookHint}</strong>
            <button onClick={() => setStarter(copy.explainNotebookPrompt)}>
              {copy.explainNotebookStarter}
            </button>
            <button onClick={() => setStarter(copy.inspectProjectFilesPrompt)}>
              {copy.inspectProjectFilesStarter}
            </button>
            <button onClick={() => setStarter(copy.modifyCodePrompt)}>
              {copy.modifyCodeStarter}
            </button>
          </div>
        ) : (
          turns.map((turn, index) => (
            <ChatMessage
              key={turn.id}
              turn={turn}
              canRetry={turn.role === "assistant" && index > 0}
              onEdit={edit}
              onRetry={retry}
              onContinue={continueStopped}
              onPermissionRespond={(promptId, allow) => void chatPermissionRespond(promptId, allow)}
              onQuestionRespond={(toolUseId, answer) => void respondQuestion(toolUseId, answer)}
            />
          ))
        )}
      </div>

      <div className="lab-assistant-composer">
        {attachments.length > 0 && (
          <div className="lab-assistant-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id}>
                {attachment.name}
                <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={copy.removeAttachmentAria(attachment.name)}>
                  x
                </button>
              </span>
            ))}
          </div>
        )}
        {editingTurnId && (
          <div className="lab-assistant-editing">
            {copy.editingEarlierMessage}
            <button type="button" onClick={() => setEditingTurnId(null)}>{copy.cancelLabel}</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          disabled={busy}
          placeholder={ready ? copy.askSomniqPlaceholder : copy.configureModelFirstPlaceholder}
          rows={4}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) void send();
            }
          }}
        />
        <div className="lab-assistant-actions">
          <span className="lab-assistant-footer-item" title={activePath ?? undefined}>
            <LabAssistantIcon name="file" />
            <span className="lab-assistant-footer-text">{activeLabel}</span>
          </span>
          <label className="lab-assistant-permission" title={copy.toolPermissionModeTitle}>
            <LabAssistantIcon name="shield" />
            <select
              className="lab-mini-select"
              value={permission?.mode ?? ""}
              disabled={permissionBusy || busy}
              onChange={(event) => void changePermission(event.target.value)}
              aria-label={copy.toolPermissionModeTitle}
            >
              {!permission && <option value="">{copy.permissionFallbackOption}</option>}
              {PERMISSION_ORDER.map((value) => (
                <option key={value} value={value}>{copy.permissionOptionLabels[value]}</option>
              ))}
            </select>
          </label>
          {busy ? (
            <button className="lab-assistant-send is-stop" onClick={() => void stop(sessionId)} aria-label={copy.stopResponseTitle} title={copy.stopResponseTitle}>
              <LabAssistantIcon name="stop" />
            </button>
          ) : (
            <button className="lab-assistant-send" disabled={!canSubmit} onClick={() => void send()} aria-label={copy.sendMessageTitle} title={copy.sendMessageTitle}>
              <LabAssistantIcon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

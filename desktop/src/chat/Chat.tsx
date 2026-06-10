import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatDelete,
  chatCommandSpecs,
  chatRunCommand,
  chatSetContext,
  chatStatus,
  fileRead,
  isTauri,
  projectChatStarters,
  skillsList,
  type ChatContextMessage,
  type ChatImageInput,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatCommandSelection, ChatStatus, DesktopCommandSpec, ChatTurn, SkillMeta } from "../types";
import ChatComposer from "./ChatComposer";
import CommandSelection from "./CommandSelection";
import ChatSidebar from "./ChatSidebar";
import ChatThread from "./ChatThread";
import { makeId, textFromTurn, transcriptFromTurn } from "./model";
import type { ChatSession } from "./types";
import { useChatSessions } from "./useChatSessions";
import { useChatStream } from "./useChatStream";

const EMPTY_ASSISTANT_RESPONSE = "Model returned an empty response.";
const IMAGE_UNSUPPORTED_MESSAGE = "(Image preview only. Vision input is not supported in desktop Chat yet.)";

function hasRenderableBlock(turn: ChatTurn) {
  return turn.blocks.some((block) => {
    if (block.kind === "text") return Boolean(block.text.trim());
    if (block.kind === "thinking") return Boolean(block.thinking.trim());
    return true;
  });
}

function mimeTypeFromDataUrl(value: string): string | null {
  const match = /^data:([^;,]+);base64,/.exec(value);
  return match?.[1] ?? null;
}

function imageInputFromAttachment(attachment: ChatAttachment): ChatImageInput | null {
  if (attachment.kind !== "image" || !attachment.preview) return null;
  return {
    name: attachment.name,
    mimeType: attachment.mimeType || mimeTypeFromDataUrl(attachment.preview) || "image/png",
    data: attachment.preview,
  };
}

async function outgoingMessage(text: string, attachments: ChatAttachment[]): Promise<ChatSendRequest> {
  const sections = [text.trim()];
  const images: ChatImageInput[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      sections.push(`[Attached image: ${attachment.name}]`);
      const image = imageInputFromAttachment(attachment);
      if (image) images.push(image);
      else sections.push(attachment.content ?? IMAGE_UNSUPPORTED_MESSAGE);
      continue;
    }
    let content = attachment.content;
    if (!content && attachment.path) {
      try {
        content = await fileRead(attachment.path, 500);
      } catch {
        content = "(Unable to read attached file)";
      }
    }
    sections.push(
      `[Attached file: ${attachment.path ?? attachment.name}]\n\`\`\`\n${content ?? ""}\n\`\`\``,
    );
  }
  return {
    text: sections.filter(Boolean).join("\n\n"),
    images,
  };
}

async function contextForRetry(turns: ChatTurn[]) {
  const messages: ChatContextMessage[] = [];
  for (const turn of turns) {
    if (turn.streaming || turn.error) continue;
    if (turn.role === "user") {
      const message = await outgoingMessage(textFromTurn(turn), turn.attachments ?? []);
      if (message.text.trim() || (message.images?.length ?? 0) > 0) {
        messages.push({ role: "user", text: message.text, images: message.images });
      }
    } else {
      const text = transcriptFromTurn(turn);
      if (text.trim()) messages.push({ role: "assistant", text });
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

const FALLBACK_SLASH_COMMANDS: DesktopCommandSpec[] = [
  { name: "help", description: "Show available slash commands" },
  { name: "model", description: "Show or switch the executor model", argumentHint: "[model]" },
  { name: "permissions", description: "Show or switch the active permission mode", argumentHint: "[mode]" },
];
const HIDDEN_SLASH_COMMANDS = new Set(["team", "teams", "workflow", "workflows"]);

function visibleDesktopCommands(commands: DesktopCommandSpec[]) {
  return commands.filter((command) => !HIDDEN_SLASH_COMMANDS.has(command.name.toLowerCase()));
}

interface PendingCommandSelection {
  sessionId: string;
  selection: ChatCommandSelection;
}

export default function Chat() {
  const setTab = useStore((state) => state.setTab);
  const setError = useStore((state) => state.setError);
  const projects = useStore((state) => state.projects);
  const currentProject = useStore((state) => state.currentProject);
  const projectBusy = useStore((state) => state.projectBusy);
  const switchProject = useStore((state) => state.switchProject);
  const reorderProjects = useStore((state) => state.reorderProjects);
  const {
    allSessions,
    currentId,
    currentSession,
    setCurrentId,
    updateSession,
    patchTurns,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    restoreSession,
  } = useChatSessions(currentProject?.id ?? "default");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [desktopCommands, setDesktopCommands] = useState<DesktopCommandSpec[]>(FALLBACK_SLASH_COMMANDS);
  const [starters, setStarters] = useState([
    "Explain this project's architecture and key modules.",
    "Check the uncommitted changes and identify risks.",
    "Run the relevant tests and fix any failures.",
  ]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(120);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<ChatSession | null>(null);
  const [pendingCommandSelection, setPendingCommandSelection] = useState<PendingCommandSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [exporting, setExporting] = useState(false);
  const deleteTimers = useRef(new Map<string, { timer: number; projectId: string }>());
  const sendLock = useRef(false);
  const commandSelectionLock = useRef(false);
  const currentSessionRef = useRef(currentSession);
  currentSessionRef.current = currentSession;
  const focusComposer = useCallback(() => setFocusRequest((value) => value + 1), []);

  const syncBackendContext = useCallback((sessionId: string, nextTurns: ChatTurn[]) => {
    if (!isTauri()) return;
    void contextForRetry(nextTurns)
      .then((messages) => chatSetContext(sessionId, messages))
      .catch((error) => setError(String(error)));
  }, [setError]);

  const patchAssistant = useCallback((
    sessionId: string,
    fn: (turn: ChatTurn) => ChatTurn,
    afterPatch?: (turns: ChatTurn[]) => void,
  ) => {
    patchTurns(sessionId, (turns) => {
      const copy = turns.slice();
      let index = -1;
      for (let candidate = copy.length - 1; candidate >= 0; candidate -= 1) {
        if (copy[candidate].role === "assistant") {
          index = candidate;
          break;
        }
      }
      if (index >= 0) copy[index] = fn(copy[index]);
      if (afterPatch) afterPatch(copy);
      return copy;
    });
  }, [patchTurns]);

  const onComplete = useCallback((sessionId: string, reply: string) => {
    patchAssistant(sessionId, (turn) => {
      const hasText = turn.blocks.some((block) => block.kind === "text" && block.text.trim());
      const nextBlocks = hasText
        ? turn.blocks
        : reply.trim()
          ? [...turn.blocks, { kind: "text" as const, text: reply }]
          : hasRenderableBlock(turn)
            ? turn.blocks
            : [{ kind: "text" as const, text: EMPTY_ASSISTANT_RESPONSE }];
      return {
        ...turn,
        blocks: nextBlocks,
        streaming: false,
        error: undefined,
        stopped: false,
      };
    });
  }, [patchAssistant]);

  const onError = useCallback((sessionId: string, error: string, stopped: boolean) => {
    patchAssistant(
      sessionId,
      (turn) => ({
        ...turn,
        streaming: false,
        error: stopped ? undefined : error,
        stopped,
      }),
      stopped ? (nextTurns) => syncBackendContext(sessionId, nextTurns) : undefined,
    );
  }, [patchAssistant, syncBackendContext]);

  const { busy, run, stop, runningSessionId } = useChatStream({ patchAssistant, onComplete, onError });
  const currentChatBusy = busy && runningSessionId === currentId;
  const otherChatBusy = busy && runningSessionId !== null && runningSessionId !== currentId;
  const turns = currentSession?.turns ?? [];
  const input = currentSession?.draft ?? "";
  const attachments = currentSession?.draftAttachments ?? [];
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refreshStatus = useCallback(() => {
    if (!isTauri()) {
      setStatus({ ready: true, model: "Preview", provider: "Browser" });
      return;
    }
    chatStatus().then(setStatus).catch((error) => setStatus({ ready: false, message: String(error) }));
  }, []);

  useEffect(() => {
    refreshStatus();
    if (!isTauri()) return;
    chatCommandSpecs()
      .then((commands) => setDesktopCommands(visibleDesktopCommands(commands)))
      .catch(() => setDesktopCommands(FALLBACK_SLASH_COMMANDS));
    skillsList().then(setSkills).catch(() => undefined);
    projectChatStarters().then(setStarters).catch(() => undefined);
  }, [currentProject?.id, refreshStatus]);

  useEffect(() => () => {
    deleteTimers.current.forEach(({ timer, projectId }, sessionId) => {
      window.clearTimeout(timer);
      if (isTauri()) void chatDelete(sessionId, projectId);
    });
    deleteTimers.current.clear();
  }, []);

  useEffect(() => {
    setPendingCommandSelection(null);
  }, [currentId]);

  // One-shot composer prefill from other views (e.g. Literature → /arxiv).
  const pendingChatInput = useStore((state) => state.pendingChatInput);
  const setPendingChatInput = useStore((state) => state.setPendingChatInput);
  useEffect(() => {
    const session = currentSessionRef.current;
    if (!pendingChatInput || !session) return;
    setDraft(session.id, pendingChatInput);
    setPendingChatInput(null);
    focusComposer();
  }, [pendingChatInput, setDraft, setPendingChatInput, focusComposer]);

  const setAttachments = (next: ChatAttachment[]) => {
    if (!currentSession) return;
    updateSession(currentSession.id, (session) => ({ ...session, draftAttachments: next }));
  };

  const beginRun = useCallback(async (
    session: ChatSession,
    prefix: ChatTurn[],
    text: string,
    attached: ChatAttachment[],
    resetContext = false,
    promptOverride?: string | ChatSendRequest,
  ) => {
    const prompt = typeof promptOverride === "string"
      ? { text: promptOverride }
      : promptOverride ?? (await outgoingMessage(text, attached));
    if (!isTauri()) {
      patchTurns(session.id, () => [
        ...prefix,
        userTurn(text, attached),
        {
          id: makeId("turn"),
          role: "assistant",
          blocks: [{ kind: "text", text: "Browser preview response. Run the Tauri app for live Chat." }],
        },
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return;
    }
    if (resetContext) await chatSetContext(session.id, await contextForRetry(prefix));
    patchTurns(session.id, () => [...prefix, userTurn(text, attached), assistantTurn()]);
    updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
    setEditingTurnId(null);
    await run(session.id, prompt);
  }, [patchTurns, run, updateSession]);

  const runSlashCommand = useCallback(async (
    session: ChatSession,
    text: string,
    attached: ChatAttachment[],
  ) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;
    const commandName = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
    if (HIDDEN_SLASH_COMMANDS.has(commandName)) {
      patchTurns(session.id, (turns) => [
        ...turns,
        userTurn(text, []),
        assistantTextTurn("This desktop command is no longer available."),
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }
    const isKnownSkill = skills.some((skill) => skill.name.toLowerCase() === commandName);
    if (attached.length > 0 && !isKnownSkill) return false;

    if (!isTauri()) {
      const command = commandName || "help";
      const reply = command === "help"
        ? FALLBACK_SLASH_COMMANDS
          .map((item) => `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} - ${item.description}`)
          .join("\n")
        : "Desktop slash commands run inside the Tauri app.";
      patchTurns(session.id, (turns) => [...turns, userTurn(text, []), assistantTextTurn(reply)]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }

    try {
      const result = await chatRunCommand(session.id, text);
      if (!result.handled) return false;
      if (result.openSettings) setTab("settings");
      if (result.refreshStatus) refreshStatus();
      if (result.selection) {
        setPendingCommandSelection({ sessionId: session.id, selection: result.selection });
        setEditingTurnId(null);
        return true;
      }
      if (result.prompt) {
        const prompt = attached.length > 0
          ? await outgoingMessage(result.prompt, attached)
          : { text: result.prompt };
        await beginRun(
          session,
          result.replaceTurns ? [] : session.turns,
          text,
          attached,
          false,
          prompt,
        );
        return true;
      }
      patchTurns(session.id, (turns) => [
        ...(result.replaceTurns ? [] : turns),
        userTurn(text, []),
        assistantTextTurn(result.message ?? ""),
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    } catch (error) {
      const message = String(error);
      setError(message);
      patchTurns(session.id, (turns) => [
        ...turns,
        userTurn(text, []),
        assistantTextTurn(`Command failed: ${message}`),
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }
  }, [beginRun, patchTurns, refreshStatus, setError, setTab, skills, updateSession]);

  const selectCommandOption = useCallback(async (value: string) => {
    const pending = pendingCommandSelection;
    const session = currentSessionRef.current;
    if (!pending || !session || session.id !== pending.sessionId || busyRef.current || commandSelectionLock.current) return;
    commandSelectionLock.current = true;
    setPendingCommandSelection(null);
    focusComposer();
    try {
      await runSlashCommand(session, `/${pending.selection.command} ${value}`, []);
    } finally {
      commandSelectionLock.current = false;
    }
  }, [focusComposer, pendingCommandSelection, runSlashCommand]);

  const send = async () => {
    if (sendLock.current || !currentSession || busy || (!input.trim() && attachments.length === 0)) return;
    sendLock.current = true;
    try {
      if (!status?.ready && (!input.trim().startsWith("/") || attachments.length > 0)) return;
      if (await runSlashCommand(currentSession, input, attachments)) return;
      if (editingTurnId) {
        const index = currentSession.turns.findIndex((turn) => turn.id === editingTurnId);
        const prefix = index >= 0 ? currentSession.turns.slice(0, index) : currentSession.turns;
        await beginRun(currentSession, prefix, input, attachments, true);
        return;
      }
      await beginRun(currentSession, currentSession.turns, input, attachments);
    } finally {
      sendLock.current = false;
    }
  };

  const retry = useCallback(async (assistant: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current || sendLock.current) return;
    const assistantIndex = session.turns.findIndex((turn) => turn.id === assistant.id);
    const userIndex = assistantIndex - 1;
    const previousUser = session.turns[userIndex];
    if (userIndex < 0 || previousUser?.role !== "user") return;
    sendLock.current = true;
    try {
      await beginRun(
        session,
        session.turns.slice(0, userIndex),
        textFromTurn(previousUser),
        previousUser.attachments ?? [],
        true,
      );
    } finally {
      sendLock.current = false;
    }
  }, [beginRun]);

  const edit = useCallback((turn: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current) return;
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    setEditingTurnId(turn.id);
    focusComposer();
  }, [focusComposer, setDraft, updateSession]);

  const continueStopped = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current || sendLock.current) return;
    sendLock.current = true;
    try {
      await beginRun(session, session.turns, "Continue from where you stopped.", [], true);
    } finally {
      sendLock.current = false;
    }
  }, [beginRun]);

  const exportCurrentChat = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current || exporting || session.turns.length === 0) return;
    setExporting(true);
    try {
      if (!isTauri()) {
        patchTurns(session.id, (turns) => [
          ...turns,
          assistantTextTurn("Export is available in the Tauri app."),
        ]);
        return;
      }
      const result = await chatRunCommand(session.id, "/export");
      if (!result.handled) return;
      if (result.openSettings) setTab("settings");
      if (result.refreshStatus) refreshStatus();
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(result.message ?? "Export complete."),
      ]);
    } catch (error) {
      const message = String(error);
      setError(message);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(`Export failed: ${message}`),
      ]);
    } finally {
      setExporting(false);
    }
  }, [exporting, patchTurns, refreshStatus, setError, setTab]);

  const deleteSession = (id: string) => {
    const removed = removeSession(id);
    if (!removed) return;
    setDeleted(removed);
    const timer = window.setTimeout(() => {
      if (isTauri()) void chatDelete(removed.id, removed.projectId);
      deleteTimers.current.delete(removed.id);
      setDeleted((current) => current?.id === removed.id ? null : current);
    }, 6000);
    deleteTimers.current.set(removed.id, { timer, projectId: removed.projectId });
  };

  const undoDelete = () => {
    if (!deleted) return;
    const pending = deleteTimers.current.get(deleted.id);
    if (pending) window.clearTimeout(pending.timer);
    deleteTimers.current.delete(deleted.id);
    restoreSession(deleted);
    setDeleted(null);
  };

  return (
    <div className="chat-root">
      <ChatSidebar
        sessions={allSessions}
        projects={projects}
        currentId={currentId}
        open={sidebarOpen}
        busy={projectBusy}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          setEditingTurnId(null);
          setCurrentId(newSession());
          setSidebarOpen(false);
        }}
        onOpen={async (id) => {
          const target = allSessions.find((session) => session.id === id);
          if (target && target.projectId !== currentProject?.id) {
            try {
              await switchProject(target.projectId);
            } catch {
              return;
            }
          }
          setEditingTurnId(null);
          setCurrentId(id);
        }}
        onRename={renameSession}
        onTogglePinned={togglePinned}
        onDelete={deleteSession}
        onReorderProjects={reorderProjects}
      />
      <main className={`chat${turns.length === 0 ? " chat-empty" : ""}`}>
        <header className="chat-head">
          <button className="chat-sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle chat sidebar">☰</button>
          <div className="chat-thread-heading">
            <span className="chat-thread-title">{currentSession?.title ?? "New chat"}</span>
            {status?.ready
              ? <span className="chat-model">{status.model} · {status.provider}</span>
              : <span className="chat-model chat-model-error">{status?.message ?? "Checking..."}</span>}
          </div>
          <div className="chat-head-actions">
            <button
              className="chat-export-btn"
              onClick={() => void exportCurrentChat()}
              disabled={busy || exporting || turns.length === 0}
              title="Export current chat"
              aria-label="Export current chat"
            >
              {exporting ? "Exporting" : "Export"}
            </button>
            {!status?.ready && <button onClick={() => setTab("settings")}>Settings</button>}
          </div>
        </header>
        <ChatThread
          sessionId={currentId}
          turns={turns}
          composerHeight={composerHeight}
          starters={starters}
          onStarter={(prompt) => {
            if (!currentSession) return;
            setDraft(currentSession.id, prompt);
            focusComposer();
          }}
          onEdit={edit}
          onRetry={retry}
          onContinue={continueStopped}
        />
        {pendingCommandSelection && pendingCommandSelection.sessionId === currentId && (
          <CommandSelection
            selection={pendingCommandSelection.selection}
            bottomOffset={composerHeight + 12}
            onSelect={(value) => void selectCommandOption(value)}
            onCancel={() => {
              setPendingCommandSelection(null);
              focusComposer();
            }}
          />
        )}
        <ChatComposer
          input={input}
          commands={desktopCommands}
          skills={skills}
          attachments={attachments}
          busy={currentChatBusy}
          sendBlocked={otherChatBusy}
          ready={Boolean(status?.ready)}
          editing={Boolean(editingTurnId)}
          focusRequest={focusRequest}
          onInputChange={(value) => {
            if (pendingCommandSelection) setPendingCommandSelection(null);
            if (currentSession) setDraft(currentSession.id, value);
          }}
          onAttachmentsChange={setAttachments}
          onSubmit={() => void send()}
          onStop={() => void stop()}
          onCancelEdit={() => setEditingTurnId(null)}
          onHeightChange={setComposerHeight}
        />
      </main>
      {deleted && (
        <div className="chat-undo">
          Deleted “{deleted.title}”
          <button onClick={undoDelete}>Undo</button>
        </div>
      )}
    </div>
  );
}

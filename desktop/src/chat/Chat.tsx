import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatDelete,
  chatSetContext,
  chatStatus,
  fileRead,
  isTauri,
  projectChatStarters,
  skillsList,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatStatus, ChatTurn, SkillMeta } from "../types";
import ChatComposer from "./ChatComposer";
import ChatSidebar from "./ChatSidebar";
import ChatThread from "./ChatThread";
import { makeId, textFromTurn } from "./model";
import type { ChatSession } from "./types";
import { useChatSessions } from "./useChatSessions";
import { useChatStream } from "./useChatStream";

async function outgoingMessage(text: string, attachments: ChatAttachment[]) {
  const sections = [text.trim()];
  for (const attachment of attachments) {
    let content = attachment.content;
    if (!content && attachment.path) {
      try {
        content = await fileRead(attachment.path, 500);
      } catch {
        content = "(Unable to read attached file)";
      }
    }
    sections.push(
      attachment.kind === "image"
        ? `[Attached image: ${attachment.name}]\n${content ?? ""}`
        : `[Attached file: ${attachment.path ?? attachment.name}]\n\`\`\`\n${content ?? ""}\n\`\`\``,
    );
  }
  return sections.filter(Boolean).join("\n\n");
}

async function contextForRetry(turns: ChatTurn[]) {
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const turn of turns) {
    if (turn.streaming || turn.error) continue;
    const text = turn.role === "user"
      ? await outgoingMessage(textFromTurn(turn), turn.attachments ?? [])
      : textFromTurn(turn);
    if (text.trim()) messages.push({ role: turn.role, text });
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

export default function Chat() {
  const setTab = useStore((state) => state.setTab);
  const {
    sessions,
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
  } = useChatSessions();
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [starters, setStarters] = useState([
    "Explain this project's architecture and key modules.",
    "Check the uncommitted changes and identify risks.",
    "Run the relevant tests and fix any failures.",
  ]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(120);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<ChatSession | null>(null);
  const deleteTimer = useRef<number | null>(null);

  const patchAssistant = useCallback((sessionId: string, fn: (turn: ChatTurn) => ChatTurn) => {
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
      return copy;
    });
  }, [patchTurns]);

  const onComplete = useCallback((sessionId: string, reply: string) => {
    patchAssistant(sessionId, (turn) => {
      const hasText = turn.blocks.some((block) => block.kind === "text" && block.text.trim());
      return {
        ...turn,
        blocks: hasText || !reply ? turn.blocks : [...turn.blocks, { kind: "text", text: reply }],
        streaming: false,
        error: undefined,
        stopped: false,
      };
    });
  }, [patchAssistant]);

  const onError = useCallback((sessionId: string, error: string, stopped: boolean) => {
    patchAssistant(sessionId, (turn) => ({
      ...turn,
      streaming: false,
      error: stopped ? undefined : error,
      stopped,
    }));
  }, [patchAssistant]);

  const { busy, run, stop } = useChatStream({ patchAssistant, onComplete, onError });
  const turns = currentSession?.turns ?? [];
  const input = currentSession?.draft ?? "";
  const attachments = currentSession?.draftAttachments ?? [];
  const currentSessionRef = useRef(currentSession);
  const busyRef = useRef(busy);
  currentSessionRef.current = currentSession;
  busyRef.current = busy;

  useEffect(() => {
    if (!isTauri()) {
      setStatus({ ready: true, model: "Preview", provider: "Browser" });
      return;
    }
    chatStatus().then(setStatus).catch((error) => setStatus({ ready: false, message: String(error) }));
    skillsList().then(setSkills).catch(() => undefined);
    projectChatStarters().then(setStarters).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
  }, []);

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
  ) => {
    const prompt = await outgoingMessage(text, attached);
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

  const send = async () => {
    if (!currentSession || busy || (!input.trim() && attachments.length === 0)) return;
    if (editingTurnId) {
      const index = currentSession.turns.findIndex((turn) => turn.id === editingTurnId);
      const prefix = index >= 0 ? currentSession.turns.slice(0, index) : currentSession.turns;
      await beginRun(currentSession, prefix, input, attachments, true);
      return;
    }
    await beginRun(currentSession, currentSession.turns, input, attachments);
  };

  const retry = useCallback(async (assistant: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current) return;
    const assistantIndex = session.turns.findIndex((turn) => turn.id === assistant.id);
    const userIndex = assistantIndex - 1;
    const previousUser = session.turns[userIndex];
    if (userIndex < 0 || previousUser?.role !== "user") return;
    await beginRun(
      session,
      session.turns.slice(0, userIndex),
      textFromTurn(previousUser),
      previousUser.attachments ?? [],
      true,
    );
  }, [beginRun]);

  const edit = useCallback((turn: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current) return;
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    setEditingTurnId(turn.id);
  }, [setDraft, updateSession]);

  const continueStopped = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || busyRef.current) return;
    await beginRun(session, session.turns, "Continue from where you stopped.", [], true);
  }, [beginRun]);

  const deleteSession = (id: string) => {
    const removed = removeSession(id);
    if (!removed) return;
    setDeleted(removed);
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    deleteTimer.current = window.setTimeout(() => {
      if (isTauri()) void chatDelete(removed.id);
      setDeleted(null);
    }, 6000);
  };

  const undoDelete = () => {
    if (!deleted) return;
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    restoreSession(deleted);
    setDeleted(null);
  };

  return (
    <div className="chat-root">
      <ChatSidebar
        sessions={sessions}
        currentId={currentId}
        open={sidebarOpen}
        busy={busy}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          setEditingTurnId(null);
          setCurrentId(newSession());
          setSidebarOpen(false);
        }}
        onOpen={(id) => {
          setEditingTurnId(null);
          setCurrentId(id);
        }}
        onRename={renameSession}
        onTogglePinned={togglePinned}
        onDelete={deleteSession}
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
          {!status?.ready && <button onClick={() => setTab("settings")}>Settings</button>}
        </header>
        <ChatThread
          sessionId={currentId}
          turns={turns}
          composerHeight={composerHeight}
          starters={starters}
          onStarter={(prompt) => currentSession && setDraft(currentSession.id, prompt)}
          onEdit={edit}
          onRetry={retry}
          onContinue={continueStopped}
        />
        <ChatComposer
          input={input}
          skills={skills}
          attachments={attachments}
          busy={busy}
          ready={Boolean(status?.ready)}
          editing={Boolean(editingTurnId)}
          onInputChange={(value) => currentSession && setDraft(currentSession.id, value)}
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

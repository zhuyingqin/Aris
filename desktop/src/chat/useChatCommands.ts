// Command controller of the Chat controller stack. Owns slash-command
// execution: the available command/skill lists, the pending command-selection
// prompt, the `/export` action, and the one-shot "run this input as a command"
// hand-off from other views. It orchestrates the run controller's `beginRun`
// for commands that expand into a model prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatCommandSpecs,
  chatRunCommand,
  isTauri,
  skillsList,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatTurn, DesktopCommandSpec, SkillMeta } from "../types";
import { CHAT_COPY } from "./i18n";
import type { ChatSession } from "./types";
import {
  assistantTextTurn,
  DISABLED_DESKTOP_COMMANDS,
  FALLBACK_SLASH_COMMANDS,
  outgoingMessage,
  userTurn,
  visibleDesktopCommands,
  type ContextOverride,
  type PendingCommandSelection,
} from "./chatRunHelpers";

type BeginRun = (
  session: ChatSession,
  prefix: ChatTurn[],
  text: string,
  attached: ChatAttachment[],
  resetContext?: boolean,
  promptOverride?: string | ChatSendRequest,
) => Promise<void>;

interface UseChatCommandsArgs {
  currentId: string;
  currentSessionRef: React.MutableRefObject<ChatSession | null>;
  runningSessionIdsRef: React.MutableRefObject<Set<string>>;
  currentChatBusy: boolean;
  patchTurns: (id: string, fn: (turns: ChatTurn[]) => ChatTurn[]) => void;
  updateSession: (id: string, fn: (session: ChatSession) => ChatSession) => void;
  createSession: () => ChatSession;
  setEditingTurnId: (id: string | null) => void;
  focusComposer: () => void;
  beginRun: BeginRun;
  refreshStatus: (model?: string | null) => void;
  setContextOverrides: React.Dispatch<React.SetStateAction<Map<string, ContextOverride>>>;
}

export function useChatCommands({
  currentId,
  currentSessionRef,
  runningSessionIdsRef,
  currentChatBusy,
  patchTurns,
  updateSession,
  createSession,
  setEditingTurnId,
  focusComposer,
  beginRun,
  refreshStatus,
  setContextOverrides,
}: UseChatCommandsArgs) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const setError = useStore((state) => state.setError);
  const setTab = useStore((state) => state.setTab);
  const currentProject = useStore((state) => state.currentProject);

  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [desktopCommands, setDesktopCommands] = useState<DesktopCommandSpec[]>(FALLBACK_SLASH_COMMANDS);
  const [pendingCommandSelection, setPendingCommandSelection] = useState<PendingCommandSelection | null>(null);
  const [exporting, setExporting] = useState(false);
  const commandSelectionLock = useRef(false);

  useEffect(() => {
    setPendingCommandSelection(null);
  }, [currentId]);

  useEffect(() => {
    if (!isTauri()) return;
    chatCommandSpecs()
      .then((commands) => setDesktopCommands(visibleDesktopCommands(commands)))
      .catch(() => setDesktopCommands(FALLBACK_SLASH_COMMANDS));
    skillsList().then(setSkills).catch(() => undefined);
  }, [currentId, currentProject?.id]);

  const runSlashCommand = useCallback(async (
    session: ChatSession,
    text: string,
    attached: ChatAttachment[],
  ) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;
    const commandName = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
    if (DISABLED_DESKTOP_COMMANDS.has(commandName)) {
      patchTurns(session.id, (turns) => [
        ...turns,
        userTurn(text, []),
        assistantTextTurn(copy.disabledCommand),
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
        : copy.previewCommandReply;
      patchTurns(session.id, (turns) => [...turns, userTurn(text, []), assistantTextTurn(reply)]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }

    try {
      const result = await chatRunCommand(session.id, text);
      if (!result.handled) return false;
      if (result.openSettings) setTab("settings");
      if (result.refreshStatus) refreshStatus(session.model ?? null);
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
      if (result.contextTokens != null) {
        // Anchor past the two turns just appended (command echo + report) so
        // the ring reads the real compacted size now and grows with later turns.
        const anchor = (result.replaceTurns ? 0 : session.turns.length) + 2;
        const tokens = result.contextTokens;
        setContextOverrides((prev) => new Map(prev).set(session.id, { tokens, anchor }));
      }
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
  }, [beginRun, copy.disabledCommand, copy.previewCommandReply, patchTurns, refreshStatus, setContextOverrides, setError, setTab, setEditingTurnId, skills, updateSession]);

  const selectCommandOption = useCallback(async (value: string) => {
    const pending = pendingCommandSelection;
    const session = currentSessionRef.current;
    if (!pending || !session || session.id !== pending.sessionId || runningSessionIdsRef.current.has(session.id) || commandSelectionLock.current) return;
    commandSelectionLock.current = true;
    setPendingCommandSelection(null);
    focusComposer();
    try {
      await runSlashCommand(session, `/${pending.selection.command} ${value}`, []);
    } finally {
      commandSelectionLock.current = false;
    }
  }, [focusComposer, pendingCommandSelection, runSlashCommand, currentSessionRef, runningSessionIdsRef]);

  const exportCurrentChat = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id) || exporting || session.turns.length === 0) return;
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
      if (result.refreshStatus) refreshStatus(session.model ?? null);
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
  }, [exporting, patchTurns, refreshStatus, setError, setTab, currentSessionRef, runningSessionIdsRef]);

  // One-shot "run this input" hand-off from other views (e.g. Literature).
  const pendingChatRunInput = useStore((state) => state.pendingChatRunInput);
  const setPendingChatRunInput = useStore((state) => state.setPendingChatRunInput);
  useEffect(() => {
    const text = pendingChatRunInput?.trim();
    if (!text || currentChatBusy) return;
    setPendingChatRunInput(null);
    const session = createSession();
    void (async () => {
      if (!await runSlashCommand(session, text, [])) {
        await beginRun(session, session.turns, text, []);
      }
    })();
  }, [beginRun, createSession, currentChatBusy, pendingChatRunInput, runSlashCommand, setPendingChatRunInput]);

  return {
    skills,
    desktopCommands,
    pendingCommandSelection,
    setPendingCommandSelection,
    runSlashCommand,
    selectCommandOption,
    exporting,
    exportCurrentChat,
  };
}

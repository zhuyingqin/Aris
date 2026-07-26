// Command controller of the Chat controller stack. Owns slash-command
// execution: the available command/skill lists, the pending command-selection
// prompt, the `/export` action, and the one-shot "run this input as a command"
// hand-off from other views. It orchestrates the run controller's `beginRun`
// for commands that expand into a model prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatCommandSpecs,
  chatDebugZipExport,
  chatRunCommand,
  isTauri,
  skillsList,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatTurn, DesktopCommandSpec, SkillMeta } from "../types";
import { CHAT_COPY } from "./i18n";
import type { ChatSession } from "./types";
import { notifyProjectBriefUpdated } from "./ProjectBriefCard";
import {
  assistantTextTurn,
  FALLBACK_SLASH_COMMANDS,
  outgoingMessage,
  userTurn,
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

function debugExportResult(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = separator > 0 ? path.slice(0, separator) : path;
  const folderHref = folder
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `Debug Export\n  Result           wrote bug-report bundle\n  File             \`${path}\`\n  Folder           [Open export folder](${folderHref})\n  Use              attach this zip when reporting stuck, empty, truncated, or mis-restored sessions\n  Includes         transcript, events, wire trace, runtime session, usage log, diagnostics, tool-output artifacts`;
}

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
  applyContextTokens: (sessionId: string, tokens: number) => void;
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
  applyContextTokens,
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
  const [debugExporting, setDebugExporting] = useState(false);
  const commandSelectionLock = useRef(false);

  useEffect(() => {
    setPendingCommandSelection(null);
  }, [currentId]);

  useEffect(() => {
    if (!isTauri()) return;
    chatCommandSpecs()
      .then(setDesktopCommands)
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
      if (result.refreshProjectBrief) notifyProjectBriefUpdated();
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
        applyContextTokens(session.id, result.contextTokens);
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
  }, [applyContextTokens, beginRun, copy.previewCommandReply, patchTurns, refreshStatus, setError, setTab, setEditingTurnId, skills, updateSession]);

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

  const exportDebugZip = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || exporting || debugExporting || session.turns.length === 0) return;
    setDebugExporting(true);
    try {
      if (!isTauri()) {
        patchTurns(session.id, (turns) => [
          ...turns,
          assistantTextTurn("Debug export is available in the Tauri app."),
        ]);
        return;
      }
      const path = await chatDebugZipExport(session.id);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(debugExportResult(path)),
      ]);
    } catch (error) {
      const message = String(error);
      setError(message);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(`Debug export failed: ${message}`),
      ]);
    } finally {
      setDebugExporting(false);
    }
  }, [debugExporting, exporting, patchTurns, setError, currentSessionRef]);

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
    debugExporting,
    exportCurrentChat,
    exportDebugZip,
  };
}

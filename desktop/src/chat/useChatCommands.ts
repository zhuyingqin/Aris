// Command controller of the Chat controller stack. Owns slash-command
// execution: the available command/skill lists, the pending command-selection
// prompt, the `/export` action, and the one-shot "run this input as a command"
// hand-off from other views. It orchestrates the run controller's `beginRun`
// for commands that expand into a model prompt.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatCommandSpecs,
  chatDebugZipExport,
  chatRunCommand,
  isTauri,
  skillsList,
  type ChatSendRequest,
} from "../api/tauri";
import { tr, useStore, type Language } from "../store";
import type { ChatAttachment, ChatTurn, DesktopCommandSpec, SkillMeta } from "../types";
import { CHAT_COPY } from "./i18n";
import type { ChatSession } from "./types";
import { notifyProjectBriefUpdated } from "./ProjectBriefCard";
import {
  assistantTextTurn,
  fallbackSlashCommands,
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

function debugExportResult(path: string, language: Language): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = separator > 0 ? path.slice(0, separator) : path;
  const folderHref = folder
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return tr(
    language,
    `调试导出\n  结果             已写入问题报告包\n  文件             \`${path}\`\n  文件夹           [打开导出文件夹](${folderHref})\n  用途             反馈会话卡住、空回复、截断或恢复错乱时请附上此 zip\n  包含             对话记录、事件、通信跟踪、运行时会话、本会话用量日志、诊断信息、工具输出产物`,
    `Debug Export\n  Result           wrote bug-report bundle\n  File             \`${path}\`\n  Folder           [Open export folder](${folderHref})\n  Use              attach this zip when reporting stuck, empty, truncated, or mis-restored sessions\n  Includes         transcript, events, wire trace, runtime session, session-scoped usage log, diagnostics, tool-output artifacts`,
    `Exportación de depuración\n  Resultado        paquete de informe de errores creado\n  Archivo          \`${path}\`\n  Carpeta          [Abrir carpeta de exportación](${folderHref})\n  Uso              adjunta este zip cuando informes de sesiones atascadas, vacías, truncadas o mal restauradas\n  Incluye          transcripción, eventos, traza de comunicación, sesión de ejecución, registro de uso de la sesión, diagnósticos, artefactos de salida de herramientas`,
  );
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
  // `null` = use the built-in fallback list, which follows the UI language.
  const [loadedCommands, setDesktopCommands] = useState<DesktopCommandSpec[] | null>(null);
  const fallbackCommands = useMemo(() => fallbackSlashCommands(language), [language]);
  const desktopCommands = loadedCommands ?? fallbackCommands;
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
      .catch(() => setDesktopCommands(null));
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
        ? fallbackCommands
          .map((item) => `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} - ${item.description}`)
          .join("\n")
        : copy.previewCommandReply;
      patchTurns(session.id, (turns) => [...turns, userTurn(text, []), assistantTextTurn(reply)]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }

    try {
      const result = await chatRunCommand(session.id, text, session.projectId);
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
        assistantTextTurn(tr(language, `命令执行失败：${message}`, `Command failed: ${message}`, `Error al ejecutar el comando: ${message}`)),
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return true;
    }
  }, [applyContextTokens, beginRun, copy.previewCommandReply, fallbackCommands, language, patchTurns, refreshStatus, setError, setTab, setEditingTurnId, skills, updateSession]);

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
          assistantTextTurn(tr(
            language,
            "导出功能仅在 Tauri 应用中可用。",
            "Export is available in the Tauri app.",
            "La exportación solo está disponible en la app de Tauri.",
          )),
        ]);
        return;
      }
      const result = await chatRunCommand(session.id, "/export", session.projectId);
      if (!result.handled) return;
      if (result.openSettings) setTab("settings");
      if (result.refreshStatus) refreshStatus(session.model ?? null);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(result.message ?? tr(language, "导出完成。", "Export complete.", "Exportación completada.")),
      ]);
    } catch (error) {
      const message = String(error);
      setError(message);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(tr(language, `导出失败：${message}`, `Export failed: ${message}`, `Error al exportar: ${message}`)),
      ]);
    } finally {
      setExporting(false);
    }
  }, [exporting, language, patchTurns, refreshStatus, setError, setTab, currentSessionRef, runningSessionIdsRef]);

  const exportDebugZip = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || exporting || debugExporting || session.turns.length === 0) return;
    setDebugExporting(true);
    try {
      if (!isTauri()) {
        patchTurns(session.id, (turns) => [
          ...turns,
          assistantTextTurn(tr(
            language,
            "调试导出仅在 Tauri 应用中可用。",
            "Debug export is available in the Tauri app.",
            "La exportación de depuración solo está disponible en la app de Tauri.",
          )),
        ]);
        return;
      }
      const path = await chatDebugZipExport(session.id, undefined, session.projectId);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(debugExportResult(path, language)),
      ]);
    } catch (error) {
      const message = String(error);
      setError(message);
      patchTurns(session.id, (turns) => [
        ...turns,
        assistantTextTurn(tr(
          language,
          `调试导出失败：${message}`,
          `Debug export failed: ${message}`,
          `Error en la exportación de depuración: ${message}`,
        )),
      ]);
    } finally {
      setDebugExporting(false);
    }
  }, [debugExporting, exporting, language, patchTurns, setError, currentSessionRef]);

  // One-shot "start a new chat with this draft" hand-off (e.g. Plugins). The
  // draft is only placed in the composer; the user decides to send it.
  const pendingNewChatDraft = useStore((state) => state.pendingNewChatDraft);
  const setPendingNewChatDraft = useStore((state) => state.setPendingNewChatDraft);
  useEffect(() => {
    const text = pendingNewChatDraft?.trim();
    if (!text) return;
    setPendingNewChatDraft(null);
    const session = createSession();
    updateSession(session.id, (item) => ({ ...item, draft: text }));
    focusComposer();
  }, [createSession, focusComposer, pendingNewChatDraft, setPendingNewChatDraft, updateSession]);

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

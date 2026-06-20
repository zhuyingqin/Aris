import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  chatDelete,
  chatCommandSpecs,
  chatModelOptions,
  chatModelSet,
  chatPermissionGet,
  chatPermissionRespond,
  chatPermissionSet,
  chatRunCommand,
  chatSetContext,
  chatStatus,
  chatSuggestTitle,
  fileOpen,
  fileRead,
  isTauri,
  projectChatStarters,
  skillsList,
  type ChatContextMessage,
  type ChatImageInput,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatBlock, ChatCommandSelection, ChatModelOption, ChatStatus, DesktopCommandSpec, ChatTurn, PermissionModeView, SkillMeta } from "../types";
import ChatComposer, { attachmentFromFile } from "./ChatComposer";
import CommandSelection from "./CommandSelection";
import ChatSidebar from "./ChatSidebar";
import ChatThread from "./ChatThread";
import FilePathMenu from "./FilePathMenu";
import { cleanChatTitle, latestFileChangesFromTurns, latestTodosFromTurns, makeId, textFromTurn, titleFromTurns } from "./model";
import WorkflowFlow from "./WorkflowFlow";
import type { ChatSession } from "./types";
import { useChatSessions } from "./useChatSessions";
import { useChatStream } from "./useChatStream";

const EMPTY_ASSISTANT_RESPONSE = "Model returned an empty response.";
const IMAGE_UNSUPPORTED_MESSAGE = "(Image preview only. Vision input is not supported in desktop Chat yet.)";

// Matches relative file paths like `desktop/src/chat/Chat.tsx` or `./src/lib.rs:42`
const FILE_PATH_RE = /^(\.\.?\/)?([a-zA-Z0-9_\-.]+\/)+[a-zA-Z0-9_\-.]+(:\d+)?$/;

function detectFilePath(element: HTMLElement): string | null {
  // Local markdown link — use the href (already decoded by MarkdownLink)
  if (element.tagName === "A") {
    const href = element.getAttribute("href");
    if (href && !/^(https?:|#|mailto:)/i.test(href)) {
      const decoded = (() => { try { return decodeURIComponent(href); } catch { return href; } })();
      if (FILE_PATH_RE.test(decoded)) return decoded;
    }
  }
  // Inline code or any element whose entire text looks like a path
  const text = element.textContent?.trim() ?? "";
  if (text && text.length < 260 && !text.includes("\n") && FILE_PATH_RE.test(text)) return text;
  return null;
}

function estimateTokens(turns: ChatTurn[]): number {
  let chars = 0;
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.kind === "text") chars += block.text.length;
      else if (block.kind === "tool") chars += block.input.length + (block.output?.length ?? 0);
    }
  }
  return Math.round(chars / 3.5);
}

function MemoryBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mem-badge" title={`${count} active memory item${count !== 1 ? "s" : ""} loaded`}>
      <span className="mem-badge-icon">◆</span>
      <span className="mem-badge-count">{count}</span>
    </div>
  );
}

function hasRenderableBlock(turn: ChatTurn) {
  return turn.blocks.some((block) => {
    if (block.kind === "text") return Boolean(block.text.trim());
    if (block.kind === "thinking") return Boolean(block.thinking.trim());
    return true;
  });
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

export function completedAssistantBlocks(turn: ChatTurn, reply: string): ChatBlock[] {
  if (textBlocksHaveContent(turn.blocks)) return turn.blocks;
  if (reply.trim()) return [...turn.blocks, { kind: "text", text: reply }];

  const fallback = thinkingFallbackText(turn.blocks);
  if (fallback) {
    const nonThinkingBlocks = turn.blocks.filter((block) => block.kind !== "thinking");
    return [...nonThinkingBlocks, { kind: "text", text: fallback }];
  }

  if (hasRenderableBlock(turn)) return turn.blocks;
  return [{ kind: "text", text: EMPTY_ASSISTANT_RESPONSE }];
}

function isExpectedStopError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "interrupted by user",
    "mcp request interrupted by user",
    "operation canceled",
    "operation cancelled",
    "canceled by user",
    "cancelled by user",
    "aborterror",
  ].some((needle) => normalized.includes(needle));
}

export function visibleTurnError(error: string, stopped: boolean): string | undefined {
  const message = error.trim();
  if (!message) return undefined;
  if (stopped && isExpectedStopError(message)) return undefined;
  return message;
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

export async function contextForRetry(turns: ChatTurn[]) {
  const messages: ChatContextMessage[] = [];
  for (const turn of turns) {
    if (turn.streaming || turn.error) continue;
    if (turn.role === "user") {
      const message = await outgoingMessage(textFromTurn(turn), turn.attachments ?? []);
      if (message.text.trim() || (message.images?.length ?? 0) > 0) {
        messages.push({ role: "user", text: message.text, images: message.images });
      }
    } else {
      const text = textFromTurn(turn);
      if (text.trim()) messages.push({ role: "assistant", text });
    }
  }
  return messages;
}

export function needsBackendContextReset(
  currentTurns: ChatTurn[],
  prefixTurns: ChatTurn[],
  explicitReset = false,
): boolean {
  if (explicitReset) return true;
  if (currentTurns.length !== prefixTurns.length) return true;
  return prefixTurns.some((turn, index) => currentTurns[index]?.id !== turn.id);
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
const DISABLED_DESKTOP_COMMANDS = new Set(["team", "teams", "workflow", "workflows"]);

function visibleDesktopCommands(commands: DesktopCommandSpec[]) {
  return commands.filter((command) => !DISABLED_DESKTOP_COMMANDS.has(command.name.toLowerCase()));
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
    materializeCurrentSession,
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
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [desktopCommands, setDesktopCommands] = useState<DesktopCommandSpec[]>(FALLBACK_SLASH_COMMANDS);
  const [starters, setStarters] = useState([
    "Explain this project's architecture and key modules.",
    "Check the uncommitted changes and identify risks.",
    "Run the relevant tests and fix any failures.",
  ]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("aris-chat-sidebar-w"));
    return v >= 150 && v <= 400 ? v : 218;
  });
  const [chatSidebarCollapsed, setChatSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("aris-chat-sidebar-collapsed") === "true",
  );
  const chatSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState(120);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<ChatSession | null>(null);
  const [pendingCommandSelection, setPendingCommandSelection] = useState<PendingCommandSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [chatDragging, setChatDragging] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const deleteTimers = useRef(new Map<string, { timer: number; projectId: string }>());
  const titleRequests = useRef(new Set<string>());
  const sendLocks = useRef(new Set<string>());
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

  const onComplete = useCallback((sessionId: string, reply: string) => {
    patchAssistant(
      sessionId,
      (turn) => {
        return {
          ...turn,
          blocks: completedAssistantBlocks(turn, reply),
          streaming: false,
          error: undefined,
          stopped: false,
        };
      },
      (nextTurns) => suggestTitle(sessionId, nextTurns),
    );
  }, [patchAssistant, suggestTitle]);

  const onError = useCallback((sessionId: string, error: string, stopped: boolean) => {
    const visibleError = visibleTurnError(error, stopped);
    patchAssistant(
      sessionId,
      (turn) => ({
        ...turn,
        streaming: false,
        error: visibleError,
        stopped,
      }),
      stopped && !visibleError ? (nextTurns) => syncBackendContext(sessionId, nextTurns) : undefined,
    );
  }, [patchAssistant, syncBackendContext]);

  const { run, stop, runningSessionIds } = useChatStream({ patchAssistant, onComplete, onError });
  const currentChatBusy = runningSessionIds.has(currentId);
  const turns = currentSession?.turns ?? [];
  const estimatedTokens = estimateTokens(turns);
  const workflowTodos = useMemo(() => latestTodosFromTurns(turns), [turns]);
  const workflowFileChanges = useMemo(
    () => latestFileChangesFromTurns(turns, currentProject?.path),
    [currentProject?.path, turns],
  );
  const input = currentSession?.draft ?? "";
  const attachments = currentSession?.draftAttachments ?? [];
  const runningSessionIdsRef = useRef(runningSessionIds);
  runningSessionIdsRef.current = runningSessionIds;

  const refreshStatus = useCallback((model?: string | null) => {
    if (!isTauri()) {
      setStatus({ ready: true, model: "Preview", provider: "Browser" });
      return;
    }
    const request = model ? chatModelSet(model, false) : chatStatus();
    request.then(setStatus).catch((error) => setStatus({ ready: false, message: String(error) }));
  }, []);

  useEffect(() => {
    refreshStatus(currentSession?.model ?? null);
    if (!isTauri()) {
      setPermission({ mode: "danger-full-access", label: "Auto-approve", description: "Auto-approve tool calls; no OS administrator elevation" });
      return;
    }
    chatPermissionGet(currentId).then(setPermission).catch(() => setPermission(null));
    chatModelOptions().then((opts) => setModelOptions(opts.options)).catch(() => setModelOptions([]));
    chatCommandSpecs()
      .then((commands) => setDesktopCommands(visibleDesktopCommands(commands)))
      .catch(() => setDesktopCommands(FALLBACK_SLASH_COMMANDS));
    skillsList().then(setSkills).catch(() => undefined);
    projectChatStarters().then(setStarters).catch(() => undefined);
  }, [currentId, currentProject?.id, currentSession?.model, refreshStatus]);

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

  const changeModel = async (model: string) => {
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
  };

  const changePermission = async (mode: string) => {
    if (!isTauri()) {
      const label = mode === "read-only" ? "Plan" : mode === "danger-full-access" ? "Auto-approve" : mode === "prompt" ? "Ask" : "Accept edits";
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
  };

  const respondPermission = useCallback(async (promptId: string, allow: boolean) => {
    if (!isTauri()) return;
    try {
      await chatPermissionRespond(promptId, allow);
    } catch (error) {
      setError(String(error));
    }
  }, [setError]);

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
  const pendingChatRunInput = useStore((state) => state.pendingChatRunInput);
  const setPendingChatRunInput = useStore((state) => state.setPendingChatRunInput);
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

  const addFilesToChat = useCallback(async (files: File[]) => {
    if (!currentSession || files.length === 0) return;
    const sessionId = currentSession.id;
    const next = await Promise.all(
      files.slice(0, 20).map(async (file) => {
        try { return await attachmentFromFile(file); }
        catch { return { id: makeId("att"), kind: "file" as const, name: file.name, mimeType: file.type || "application/octet-stream", content: "(File content could not be read.)" }; }
      }),
    );
    updateSession(sessionId, (s) => ({ ...s, draftAttachments: [...(s.draftAttachments ?? []), ...next] }));
    focusComposer();
  }, [currentSession, focusComposer, updateSession]);

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
    const selectedModel = session.model || status?.model || undefined;
    const request = selectedModel ? { ...prompt, model: selectedModel } : prompt;
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
    const shouldResetContext = needsBackendContextReset(session.turns, prefix, resetContext);
    if (shouldResetContext) await chatSetContext(session.id, await contextForRetry(prefix));
    patchTurns(session.id, () => [...prefix, userTurn(text, attached), assistantTurn()]);
    updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
    setEditingTurnId(null);
    await run(session.id, request);
  }, [patchTurns, run, status?.model, updateSession]);

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
        assistantTextTurn("This desktop command is disabled in this build."),
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

  useEffect(() => {
    const text = pendingChatRunInput?.trim();
    if (!text || !currentSession || currentChatBusy) return;
    setPendingChatRunInput(null);
    const session = materializeCurrentSession();
    if (!session) return;
    void (async () => {
      if (!await runSlashCommand(session, text, [])) {
        await beginRun(session, session.turns, text, []);
      }
    })();
  }, [beginRun, currentChatBusy, currentSession, materializeCurrentSession, pendingChatRunInput, runSlashCommand, setPendingChatRunInput]);

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
  }, [focusComposer, pendingCommandSelection, runSlashCommand]);

  const send = async () => {
    if (!currentSession || sendLocks.current.has(currentSession.id) || currentChatBusy || (!input.trim() && attachments.length === 0)) return;
    const sessionId = currentSession.id;
    sendLocks.current.add(sessionId);
    try {
      if (!status?.ready && (!input.trim().startsWith("/") || attachments.length > 0)) return;
      const session = materializeCurrentSession();
      if (!session) return;
      if (await runSlashCommand(session, input, attachments)) return;
      if (editingTurnId) {
        const index = session.turns.findIndex((turn) => turn.id === editingTurnId);
        const prefix = index >= 0 ? session.turns.slice(0, index) : session.turns;
        await beginRun(session, prefix, input, attachments, true);
        return;
      }
      await beginRun(session, session.turns, input, attachments);
    } finally {
      sendLocks.current.delete(sessionId);
    }
  };

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
      );
    } finally {
      sendLocks.current.delete(session.id);
    }
  }, [beginRun]);

  const edit = useCallback((turn: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id)) return;
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    setEditingTurnId(turn.id);
    focusComposer();
  }, [focusComposer, setDraft, updateSession]);

  const continueStopped = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || runningSessionIdsRef.current.has(session.id) || sendLocks.current.has(session.id)) return;
    sendLocks.current.add(session.id);
    try {
      await beginRun(session, session.turns, "Continue from where you stopped.", [], true);
    } finally {
      sendLocks.current.delete(session.id);
    }
  }, [beginRun]);

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
  }, [exporting, patchTurns, refreshStatus, setError, setTab]);

  const handleChatContextMenu = useCallback((e: React.MouseEvent<HTMLElement>) => {
    let node = e.target as HTMLElement | null;
    for (let depth = 0; depth < 5 && node; depth++) {
      const found = detectFilePath(node);
      if (found) {
        e.preventDefault();
        setFileMenu({ x: e.clientX, y: e.clientY, path: found });
        return;
      }
      if (node.classList.contains("chat-turn") || node.classList.contains("chat-head")) break;
      node = node.parentElement;
    }
  }, []);

  const openWorkflowFile = useCallback((path: string) => {
    if (!isTauri()) return;
    void fileOpen(path).catch((error) => setError(String(error)));
  }, [setError]);

  const attachFileFromMenu = useCallback(async (path: string, content: string) => {
    const session = currentSessionRef.current;
    if (!session) return;
    const attachment: ChatAttachment = {
      id: makeId("att"),
      kind: "file",
      name: path.split(/[\\/]/).pop() ?? path,
      path,
      content: content || undefined,
    };
    updateSession(session.id, (s) => ({
      ...s,
      draftAttachments: [...(s.draftAttachments ?? []), attachment],
    }));
    focusComposer();
  }, [focusComposer, updateSession]);

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

  const onChatSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || chatSidebarCollapsed) return;
    chatSidebarResizeRef.current = { startX: e.clientX, startWidth: chatSidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onChatSidebarResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chatSidebarResizeRef.current) return;
    const w = Math.max(150, Math.min(400, chatSidebarResizeRef.current.startWidth + (e.clientX - chatSidebarResizeRef.current.startX)));
    setChatSidebarWidth(w);
  };
  const onChatSidebarResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chatSidebarResizeRef.current) return;
    const w = Math.max(150, Math.min(400, chatSidebarResizeRef.current.startWidth + (e.clientX - chatSidebarResizeRef.current.startX)));
    chatSidebarResizeRef.current = null;
    setChatSidebarWidth(w);
    localStorage.setItem("aris-chat-sidebar-w", String(w));
  };
  const toggleChatSidebar = () => {
    const next = !chatSidebarCollapsed;
    setChatSidebarCollapsed(next);
    localStorage.setItem("aris-chat-sidebar-collapsed", String(next));
  };

  return (
    <div
      className={`chat-root${chatSidebarCollapsed ? " chat-sidebar-collapsed" : ""}`}
      style={{ "--chat-sidebar-w": chatSidebarCollapsed ? "0px" : `${chatSidebarWidth}px` } as CSSProperties}
    >
      <ChatSidebar
        sessions={allSessions}
        projects={projects}
        currentId={currentId}
        open={sidebarOpen}
        busy={projectBusy}
        onClose={() => setSidebarOpen(false)}
        onDesktopCollapse={toggleChatSidebar}
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
      <div
        className="chat-sidebar-resize-handle"
        onPointerDown={onChatSidebarResizeStart}
        onPointerMove={onChatSidebarResizeMove}
        onPointerUp={onChatSidebarResizeEnd}
        onPointerCancel={onChatSidebarResizeEnd}
      />
      <main
        className={`chat${turns.length === 0 ? " chat-empty" : ""}`}
        onContextMenu={handleChatContextMenu}
        onDragEnter={(e) => { e.preventDefault(); setChatDragging(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setChatDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setChatDragging(false); void addFilesToChat(Array.from(e.dataTransfer.files)); }}
      >
        {chatDragging && (
          <div
            className="chat-drop-full"
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              if (!(e.currentTarget.parentElement?.contains(e.relatedTarget as Node) ?? false)) {
                setChatDragging(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setChatDragging(false);
              void addFilesToChat(Array.from(e.dataTransfer.files));
            }}
          >
            <span className="chat-drop-full-icon">📎</span>
            <span>拖放文件以附加</span>
          </div>
        )}
        <header className="chat-head">
          <button
            className="chat-sidebar-toggle"
            onClick={() => {
              if (chatSidebarCollapsed) toggleChatSidebar();
              else setSidebarOpen((open) => !open);
            }}
            aria-label="Toggle chat sidebar"
          >
            ☰
          </button>
          <div className="chat-thread-heading">
            <span className="chat-thread-title">{currentSession?.title ?? "New chat"}</span>
            {status?.ready
              ? <span className="chat-model">{status.provider}</span>
              : <span className="chat-model chat-model-error">{status?.message ?? "Checking..."}</span>}
          </div>
          <div className="chat-head-actions">
            {status?.memoryFiles != null && status.memoryFiles > 0 && (
              <MemoryBadge count={status.memoryFiles} />
            )}
            <button
              className="chat-export-btn"
              onClick={() => void exportCurrentChat()}
              disabled={currentChatBusy || exporting || turns.length === 0}
              title="Export current chat"
              aria-label="Export current chat"
            >
              {exporting ? "Exporting" : "Export"}
            </button>
            {!status?.ready && <button onClick={() => setTab("settings")}>Settings</button>}
          </div>
        </header>
        <ChatThread
          key={currentId}
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
          onPermissionRespond={(promptId, allow) => void respondPermission(promptId, allow)}
        />
        {(workflowTodos.length > 0 || workflowFileChanges.length > 0) && !pendingCommandSelection && (
          <WorkflowFlow
            todos={workflowTodos}
            fileChanges={workflowFileChanges}
            bottomOffset={composerHeight + 14}
            active={currentChatBusy}
            onOpenFile={openWorkflowFile}
          />
        )}
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
          ready={Boolean(status?.ready)}
          editing={Boolean(editingTurnId)}
          focusRequest={focusRequest}
          permission={permission}
          permissionBusy={permissionBusy}
          onPermissionChange={(mode) => void changePermission(mode)}
          modelName={status?.ready ? activeModel : null}
          modelOptions={modelSelectOptions}
          modelBusy={modelBusy}
          canSwitchModel={canSwitchModel}
          onModelChange={(model) => void changeModel(model)}
          contextUsed={estimatedTokens}
          contextMax={status?.ready && status.contextWindow != null ? status.contextWindow : null}
          onInputChange={(value) => {
            if (pendingCommandSelection) setPendingCommandSelection(null);
            if (currentSession) setDraft(currentSession.id, value);
          }}
          onAttachmentsChange={setAttachments}
          onSubmit={() => void send()}
          onStop={() => void stop(currentId)}
          onCancelEdit={() => setEditingTurnId(null)}
          onHeightChange={setComposerHeight}
        />
      </main>
      {deleted && (
        <div className="chat-undo">
          {`Deleted "${deleted.title}"`}
          <button onClick={undoDelete}>Undo</button>
        </div>
      )}
      {fileMenu && (
        <FilePathMenu
          x={fileMenu.x}
          y={fileMenu.y}
          path={fileMenu.path}
          projectRoot={currentProject?.path}
          onClose={() => setFileMenu(null)}
          onAttach={(path, content) => void attachFileFromMenu(path, content)}
        />
      )}
    </div>
  );
}

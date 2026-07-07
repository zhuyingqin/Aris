import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  chatDelete,
  chatCommandSpecs,
  chatModelOptions,
  chatModelSet,
  chatPermissionGet,
  chatPermissionRespond,
  chatPermissionSet,
  chatQuestionRespond,
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
import { CHAT_COPY } from "./i18n";
import { cleanChatTitle, latestFileChangesFromTurns, latestTodosFromTurns, makeId, patchLastAssistantTurn, textFromTurn, titleFromTurns } from "./model";
import WorkflowFlow from "./WorkflowFlow";
import type { ChatSession } from "./types";
import { useChatSessions } from "./useChatSessions";
import { useChatStream } from "./useChatStream";
import { onChatModelsUpdated } from "../modelEvents";

const EMPTY_ASSISTANT_RESPONSE = "Model returned an empty response.";
const IMAGE_UNSUPPORTED_MESSAGE = "(Image preview only. Vision input is not supported in desktop Chat yet.)";
const CHAT_SIDEBAR_WIDTH_KEY = "somniq-chat-sidebar-w";
const CHAT_SIDEBAR_WIDTH_LEGACY_KEY = "aris-chat-sidebar-w";

// Matches relative file paths like `desktop/src/chat/Chat.tsx` or `./src/lib.rs:42`
const FILE_PATH_RE = /^(\.\.?\/)?([a-zA-Z0-9_\-.]+\/)+[a-zA-Z0-9_\-.]+(:\d+)?$/;

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

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

// Rough token estimate. Latin/code text is ~3.5 chars/token, but CJK characters
// are far denser (~1 token per character), so the old flat `chars / 3.5`
// under-counted CJK-heavy text by roughly 3x — the ContextRing read low and
// users hit the real window without warning. Weight CJK separately. Still a
// heuristic; replace with a real tokenizer when one is wired up (#34 P0-3.1).
function isCjkCharCode(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // CJK symbols/punct, ideographs, Hangul/Kana
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // full-width / half-width forms
  );
}

function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjkCharCode(code)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.round(other / 3.5) + 1;
}

function estimateTokens(turns: ChatTurn[]): number {
  let tokens = 0;
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.kind === "text") tokens += estimateTextTokens(block.text);
      else if (block.kind === "notice") tokens += estimateTextTokens(block.message);
      else if (block.kind === "tool")
        tokens += estimateTextTokens(block.input) + (block.output ? estimateTextTokens(block.output) : 0);
    }
  }
  return tokens;
}

type ContextOverride = { tokens: number; anchor: number };
type ContextNotice = {
  kind: "warning" | "compacted";
  sessionId: string;
  message: string;
  detail?: string;
  createdAt: number;
};

// The ContextRing's "used" value. When an authoritative backend count is pinned
// (after each turn via the chat-done event with real API prompt_tokens), use it
// directly — no local estimate stacking, which diverges from the backend's
// compact_context_history truncation. Falls back to a transcript estimate only
// before the first turn completes.
function ringTokens(turns: ChatTurn[], override: ContextOverride | undefined): number {
  return override ? override.tokens : estimateTokens(turns);
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

function formatCompactTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
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
  const pushAssistantText = (text: string) => {
    if (text.trim()) messages.push({ role: "assistant", text });
  };
  const pushAssistantTool = (
    turn: ChatTurn,
    block: Extract<ChatBlock, { kind: "tool" }>,
    index: number,
    text: string,
  ) => {
    const id = block.id || `ui-tool-${turn.id}-${index}`;
    messages.push({
      role: "assistant",
      text: text.trim() ? text : undefined,
      toolCalls: [{ id, name: block.name, input: block.input || "{}" }],
    });
    messages.push({
      role: "tool",
      toolResults: [{
        toolUseId: id,
        toolName: block.name,
        output: block.output ?? `${block.name} was interrupted before producing output.`,
        isError: block.isError ?? block.output === undefined,
      }],
    });
  };
  for (const turn of turns) {
    // Stopped (cleanly cancelled) turns are kept: their partial text and tool
    // activity is real conversation the model needs to continue coherently.
    // Only in-flight (streaming) and genuinely failed (error) turns are dropped.
    if (turn.streaming || turn.error) continue;
    if (turn.role === "user") {
      const message = await outgoingMessage(textFromTurn(turn), turn.attachments ?? []);
      if (message.text.trim() || (message.images?.length ?? 0) > 0) {
        messages.push({ role: "user", text: message.text, images: message.images });
      }
    } else {
      // Serialize the full transcript — tool calls and results included,
      // marking any interrupted before output — not text alone. This context
      // is fed to `chatSetContext(..., "replace")`, which discards the backend
      // session and rebuilds it from these messages. Text-only reconstruction
      // would drop every completed turn's tool activity (file reads, searches,
      // command outputs), so an edit/retry from an earlier turn would make the
      // model forget everything it learned by acting. Stopped turns need the
      // transcript for the same reason plus their partial never reached the
      // backend session at all.
      let pendingText = "";
      turn.blocks.forEach((block, index) => {
        if (block.kind === "text") {
          pendingText = pendingText ? `${pendingText}\n${block.text}` : block.text;
          return;
        }
        if (block.kind === "tool") {
          pushAssistantTool(turn, block, index, pendingText);
          pendingText = "";
        }
      });
      pushAssistantText(pendingText);
    }
  }
  return messages;
}

// The stopped turn's partial response (and any tool calls/results) is now
// rebuilt into the backend context by `contextForRetry`, so the continue prompt
// no longer needs to embed — and truncate — the partial itself. It just points
// the model at the conversation above, avoiding the old 12k cutoff that dropped
// everything past the seam on long generations.
export function continueStoppedPrompt(): string {
  return [
    "Continue from where you stopped.",
    "Your partial response from the interrupted turn — including any tool calls and their results — is already in the conversation above.",
    "Do not repeat the completed portion unless a short overlap is needed for continuity.",
  ].join("\n");
}

export function needsBackendContextReset(
  currentTurns: ChatTurn[],
  prefixTurns: ChatTurn[],
  explicitReset = false,
): boolean {
  if (explicitReset) return true;
  if (prefixTurns.some((turn) => turn.stopped)) return true;
  if (prefixTurns.some((turn) => turn.error)) return true;
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
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
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
    createSession,
    createSessionInProject,
    updateSession,
    patchTurns,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    restoreSession,
  } = useChatSessions(currentProject?.id);
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
    const v = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY) ?? localStorage.getItem(CHAT_SIDEBAR_WIDTH_LEGACY_KEY));
    return v >= 150 && v <= 400 ? v : 218;
  });
  const chatSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState(120);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  // After `/compact` the backend session shrinks but the visible transcript is
  // kept intact, so the transcript-derived token estimate (and thus the
  // ContextRing) would never move. Pin the ring to the real post-compaction
  // token count reported by the command, plus an anchor (turn count at compact
  // time) so later turns still accrue on top. Keyed per session; invalidated
  // automatically once the transcript is truncated below the anchor.
  const [contextOverrides, setContextOverrides] = useState<Map<string, { tokens: number; anchor: number }>>(() => new Map());
  const [deleted, setDeleted] = useState<ChatSession | null>(null);
  const [pendingCommandSelection, setPendingCommandSelection] = useState<PendingCommandSelection | null>(null);
  const [contextNotice, setContextNotice] = useState<ContextNotice | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [chatDragging, setChatDragging] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const deleteTimers = useRef(new Map<string, { timer: number; projectId: string }>());
  const titleRequests = useRef(new Set<string>());
  const sendLocks = useRef(new Set<string>());
  const commandSelectionLock = useRef(false);
  const syncedTurnIds = useRef(new Map<string, Set<string>>());
  const dirtyBackendContext = useRef(new Set<string>());
  const currentSessionRef = useRef(currentSession);
  currentSessionRef.current = currentSession;
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;
  const contextOverridesRef = useRef(contextOverrides);
  contextOverridesRef.current = contextOverrides;
  const focusComposer = useCallback(() => setFocusRequest((value) => value + 1), []);

  useEffect(() => {
    setContextNotice((notice) => notice && notice.sessionId === currentId ? notice : null);
  }, [currentId]);

  const markBackendContextSynced = useCallback((sessionId: string, turnsToMark: ChatTurn[]) => {
    const known = syncedTurnIds.current.get(sessionId) ?? new Set<string>();
    for (const turn of turnsToMark) known.add(turn.id);
    syncedTurnIds.current.set(sessionId, known);
  }, []);

  const markBackendContextDirty = useCallback((sessionId: string) => {
    dirtyBackendContext.current.add(sessionId);
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
      (nextTurns) => {
        markBackendContextSynced(sessionId, nextTurns);
        suggestTitle(sessionId, nextTurns);
      },
    );
  }, [markBackendContextSynced, patchAssistant, suggestTitle]);

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
      stopped && !visibleError
        ? () => markBackendContextDirty(sessionId)
        : undefined,
    );
  }, [markBackendContextDirty, patchAssistant]);

  // Pin the ContextRing to an authoritative backend token count — reported
  // after every turn (real usage) and after compaction — anchored at the
  // current turn count so later turns still accrue on top. Same override the
  // `/compact` path uses; the anchor guard in `ringTokens` self-heals if the
  // transcript is later truncated.
  const applyContextTokens = useCallback((sessionId: string, tokens: number) => {
    const session = allSessionsRef.current.find((item) => item.id === sessionId);
    const anchor = session ? session.turns.length : 0;
    setContextOverrides((prev) => new Map(prev).set(sessionId, { tokens, anchor }));
  }, []);

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
  }, []);

  const { run, stop, runningSessionIds } = useChatStream({
    patchAssistant,
    onComplete,
    onError,
    onContextCompacted: handleContextCompacted,
    onContextTokens: applyContextTokens,
    onContextWarning: handleContextWarning,
    getContextTokens: readContextTokens,
  });
  const currentChatBusy = runningSessionIds.has(currentId);
  const turns = currentSession?.turns ?? [];
  const estimatedTokens = ringTokens(turns, contextOverrides.get(currentId));
  const contextMax = status?.ready
    ? (status.contextWindow ?? status.compactionBudget ?? null)
    : null;
  const currentContextNotice = contextNotice?.sessionId === currentId ? contextNotice : null;
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
    chatCommandSpecs()
      .then((commands) => setDesktopCommands(visibleDesktopCommands(commands)))
      .catch(() => setDesktopCommands(FALLBACK_SLASH_COMMANDS));
    skillsList().then(setSkills).catch(() => undefined);
    projectChatStarters().then(setStarters).catch(() => undefined);
  }, [copy.permissionLabels, copy.previewPermissionDescription, currentId, currentProject?.id, currentSession?.model, refreshModelOptions, refreshStatus]);

  useEffect(() => onChatModelsUpdated(() => {
    refreshModelOptions();
    refreshStatus(currentSessionRef.current?.model ?? null);
  }), [refreshModelOptions, refreshStatus]);

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
  };

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

  const addPathsToChat = useCallback((paths: string[]) => {
    if (!currentSession || paths.length === 0) return;
    const next = paths
      .map((path) => path.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((path): ChatAttachment => ({
        id: makeId("att"),
        kind: "file",
        name: basename(path),
        path,
      }));
    if (next.length === 0) return;
    updateSession(currentSession.id, (session) => ({
      ...session,
      draftAttachments: [...(session.draftAttachments ?? []), ...next],
    }));
    focusComposer();
  }, [currentSession, focusComposer, updateSession]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setChatDragging(true);
          return;
        }
        setChatDragging(false);
        if (event.payload.type === "drop") {
          addPathsToChat(event.payload.paths);
        }
      }))
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPathsToChat]);

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
          blocks: [{ kind: "text", text: copy.previewResponse }],
        },
      ]);
      updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
      setEditingTurnId(null);
      return;
    }
    const shouldResetContext = dirtyBackendContext.current.has(session.id)
      || needsBackendContextReset(session.turns, prefix, resetContext);
    if (shouldResetContext) {
      const tokens = await chatSetContext(session.id, await contextForRetry(prefix), "replace");
      setContextOverrides((prev) => new Map(prev).set(session.id, { tokens, anchor: prefix.length }));
      markBackendContextSynced(session.id, prefix);
      dirtyBackendContext.current.delete(session.id);
    } else {
      markBackendContextSynced(session.id, prefix);
    }
    patchTurns(session.id, () => [...prefix, userTurn(text, attached), assistantTurn()]);
    updateSession(session.id, (item) => ({ ...item, draft: "", draftAttachments: [] }));
    setEditingTurnId(null);
    await run(session.id, request);
  }, [copy.previewResponse, markBackendContextSynced, patchTurns, run, status?.model, updateSession]);

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
  }, [beginRun, copy.disabledCommand, copy.previewCommandReply, patchTurns, refreshStatus, setError, setTab, skills, updateSession]);

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
      await beginRun(
        session,
        session.turns,
        "Continue from where you stopped.",
        [],
        true,
        continueStoppedPrompt(),
      );
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
    if (e.button !== 0) return;
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
    localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(w));
    localStorage.removeItem(CHAT_SIDEBAR_WIDTH_LEGACY_KEY);
  };
  useEffect(() => {
    document.body.style.setProperty("--chat-sidebar-w", `${chatSidebarWidth}px`);
    return () => { document.body.style.removeProperty("--chat-sidebar-w"); };
  }, [chatSidebarWidth]);


  return (
    <div
      className="chat-root"
      style={{ "--chat-sidebar-w": `${chatSidebarWidth}px` } as CSSProperties}
    >
      <ChatSidebar
        sessions={allSessions}
        projects={projects}
        currentId={currentId}
        open={sidebarOpen}
        busy={projectBusy}
        onClose={() => setSidebarOpen(false)}
        onNew={async (projectId) => {
          setEditingTurnId(null);
          if (!projectId || projectId === currentProject?.id) {
            setCurrentId(newSession());
          } else {
            try {
              await switchProject(projectId);
              const fresh = createSessionInProject(projectId);
              setCurrentId(fresh.id);
            } catch {
              return;
            }
          }
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

        {document.getElementById("app-chat-actions-portal") && createPortal(
          <div className="chat-head-actions" data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {status?.memoryFiles != null && status.memoryFiles > 0 && (
              <MemoryBadge count={status.memoryFiles} />
            )}
            <div className="chat-head-model-badge" style={{
              background: "var(--bg-2)",
              color: "var(--text-dim)",
              padding: "2px 6px",
              borderRadius: "4px",
              fontSize: "12px",
              fontWeight: 500
            }}>
              {status?.ready ? status.provider : (status?.message ?? copy.checking)}
            </div>
            <button
              className="chat-export-btn"
              onClick={() => void exportCurrentChat()}
              disabled={currentChatBusy || exporting || turns.length === 0}
              title={copy.exportChat}
              aria-label={copy.exportChat}
              style={{ background: "transparent", border: "none", color: "var(--text-dim)", padding: "4px", cursor: "pointer", display: "flex", alignItems: "center" }}
            >
              {exporting ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="spinner">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="31.4 31.4" strokeLinecap="round" opacity="0.5"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 15V3M12 15L8 11M12 15L16 11M21 21H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            {!status?.ready && <button onClick={() => setTab("settings")}>{copy.settings}</button>}
          </div>,
          document.getElementById("app-chat-actions-portal")!
        )}
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
          onQuestionRespond={(toolUseId, answer) => void respondQuestion(toolUseId, answer)}
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
          contextMax={contextMax}
          contextStatus={currentContextNotice}
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
          {copy.deleted(deleted.title)}
          <button onClick={undoDelete}>{copy.undo}</button>
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

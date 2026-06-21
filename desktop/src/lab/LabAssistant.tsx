import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  chatPermissionGet,
  chatPermissionRespond,
  chatPermissionSet,
  chatSetContext,
  chatStatus,
  fileRead,
  isTauri,
  type ChatContextMessage,
  type ChatSendRequest,
} from "../api/tauri";
import ChatMessage from "../chat/ChatMessage";
import { makeId, textFromTurn } from "../chat/model";
import { useChatStream } from "../chat/useChatStream";
import type { ChatAttachment, ChatBlock, ChatStatus, ChatTurn, PermissionModeView } from "../types";
import type { NotebookCell } from "./labTypes";

const EMPTY_ASSISTANT_RESPONSE = "Model returned an empty response.";

const PERMISSION_OPTIONS = [
  { value: "read-only", label: "Plan" },
  { value: "workspace-write", label: "Accept edits" },
  { value: "prompt", label: "Ask" },
  { value: "danger-full-access", label: "Auto-approve" },
];

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

function labContext(projectPath: string | null, activePath: string | null, activeKind: ActiveKind, cells: NotebookCell[]): string {
  return [
    "You are the Lab side assistant inside ARIS.",
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
    if (turn.streaming || turn.error) continue;
    const text = textFromTurn(turn).trim();
    if (!text) continue;
    if (turn.role === "user") {
      const request = await requestFromInput(text, turn.attachments ?? [], "");
      messages.push({ role: "user", text: request.text.trim() });
    } else {
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

function completedAssistantBlocks(turn: ChatTurn, reply: string): ChatBlock[] {
  if (textBlocksHaveContent(turn.blocks)) return turn.blocks;
  if (reply.trim()) return [...turn.blocks, { kind: "text", text: reply }];
  const fallback = thinkingFallbackText(turn.blocks);
  if (fallback) return [{ kind: "text", text: fallback }];
  if (hasRenderableBlock(turn)) return turn.blocks;
  return [{ kind: "text", text: EMPTY_ASSISTANT_RESPONSE }];
}

function isExpectedStopError(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "interrupted by user",
    "operation canceled",
    "operation cancelled",
    "canceled by user",
    "cancelled by user",
    "aborterror",
  ].some((needle) => lower.includes(needle));
}

function visibleTurnError(error: string, stopped: boolean): string | undefined {
  const message = error.trim();
  if (!message) return undefined;
  if (stopped && isExpectedStopError(message)) return undefined;
  return message;
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
  const [sessionId, setSessionId] = useState(() => makeId("lab-chat"));
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const context = useMemo(() => labContext(projectPath, activePath, activeKind, cells), [activeKind, activePath, cells, projectPath]);

  useEffect(() => {
    setSessionId(makeId("lab-chat"));
    setTurns([]);
    setInput("");
    setEditingTurnId(null);
    onAttachmentsChange([]);
  }, [onAttachmentsChange, projectId]);

  const patchAssistant = useCallback((eventSessionId: string, fn: (turn: ChatTurn) => ChatTurn) => {
    if (eventSessionId !== sessionId) return;
    setTurns((previous) => {
      const next = previous.slice();
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role === "assistant") {
          next[index] = fn(next[index]);
          return next;
        }
      }
      return previous;
    });
  }, [sessionId]);

  const onComplete = useCallback((eventSessionId: string, reply: string) => {
    patchAssistant(eventSessionId, (turn) => ({
      ...turn,
      blocks: completedAssistantBlocks(turn, reply),
      streaming: false,
      error: undefined,
      stopped: false,
    }));
  }, [patchAssistant]);

  const onError = useCallback((eventSessionId: string, error: string, stopped: boolean) => {
    const visible = visibleTurnError(error, stopped);
    patchAssistant(eventSessionId, (turn) => ({
      ...turn,
      streaming: false,
      error: visible,
      stopped,
    }));
  }, [patchAssistant]);

  const { run, stop, runningSessionIds } = useChatStream({ patchAssistant, onComplete, onError });
  const busy = runningSessionIds.has(sessionId);

  useEffect(() => {
    if (!isTauri()) {
      setStatus({ ready: true, model: "Preview", provider: "Browser" });
      setPermission({ mode: "workspace-write", label: "Accept edits", description: "" });
      return;
    }
    chatStatus().then(setStatus).catch((error) => setStatus({ ready: false, message: String(error) }));
    chatPermissionGet(sessionId).then(setPermission).catch(() => setPermission(null));
  }, [sessionId]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [turns]);

  const beginRun = useCallback(async (
    prefix: ChatTurn[],
    text: string,
    attached: ChatAttachment[],
    resetContext = false,
  ) => {
    const prompt = await requestFromInput(text, attached, context);
    if (!isTauri()) {
      setTurns([...prefix, userTurn(text, attached), assistantTextTurn("Browser preview response. Run the Tauri app for live Lab Assistant.")]);
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
  }, [context, onAttachmentsChange, run, sessionId]);

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

  const retry = useCallback(async (assistant: ChatTurn) => {
    if (busy || sendLock.current) return;
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
  }, [beginRun, busy, turns]);

  const edit = useCallback((turn: ChatTurn) => {
    if (busy) return;
    setInput(textFromTurn(turn));
    onAttachmentsChange(turn.attachments ?? []);
    setEditingTurnId(turn.id);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [busy, onAttachmentsChange]);

  const continueStopped = useCallback(async () => {
    if (busy || sendLock.current) return;
    sendLock.current = true;
    try {
      await beginRun(turns, "Continue from where you stopped.", [], true);
    } finally {
      sendLock.current = false;
    }
  }, [beginRun, busy, turns]);

  const changePermission = async (mode: string) => {
    if (!isTauri()) {
      const opt = PERMISSION_OPTIONS.find((item) => item.value === mode);
      setPermission({ mode, label: opt?.label ?? mode, description: "" });
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

  return (
    <div className="lab-assistant">
      <div className="lab-assistant-head">
        <div>
          <h3>AI Assistant</h3>
          <span>{status?.ready ? `${status.provider ?? "Model"}${status.model ? ` / ${status.model}` : ""}` : status?.message ?? "Checking model..."}</span>
        </div>
        <select
          className="lab-mini-select"
          value={permission?.mode ?? ""}
          disabled={permissionBusy || busy}
          onChange={(event) => void changePermission(event.target.value)}
          title="Tool permission mode"
        >
          {!permission && <option value="">Permission</option>}
          {PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="lab-assistant-turns" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="lab-assistant-empty">
            <strong>Ask about the current notebook or workspace.</strong>
            <button onClick={() => setStarter("Explain the current notebook and identify the next useful experiment.")}>
              Explain this notebook
            </button>
            <button onClick={() => setStarter("Inspect the current project files and suggest where to implement the next code change.")}>
              Inspect project files
            </button>
            <button onClick={() => setStarter("Modify the code needed for this Lab workflow, then summarize the changed files.")}>
              Modify code
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
                <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                  x
                </button>
              </span>
            ))}
          </div>
        )}
        {editingTurnId && (
          <div className="lab-assistant-editing">
            Editing earlier message
            <button type="button" onClick={() => setEditingTurnId(null)}>Cancel</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          disabled={busy}
          placeholder={ready ? "Ask ARIS to explain, inspect, or change code..." : "Configure a model in Settings first"}
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
          <span title={activePath ?? undefined}>{activePath ? basename(activePath) : "No item"}</span>
          {busy ? (
            <button className="lab-btn warn" onClick={() => void stop(sessionId)}>Stop</button>
          ) : (
            <button className="lab-btn primary" disabled={!canSubmit} onClick={() => void send()}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}

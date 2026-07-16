import type { ChatMessageEvent, ChatToolProgress } from "./control";

export type RemoteChatBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | {
      kind: "tool";
      toolUseId: string | null;
      name: string;
      input: string;
      output: string | null;
      isError: boolean | null;
      progress: ChatToolProgress | null;
    };

export interface RemoteTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  blocks: RemoteChatBlock[];
}

/** The newest thinking phase stays visible while the assistant is still
 * producing later text or tool events in the same browser paint frame. */
export function latestThinkingBlockIndex(blocks: readonly RemoteChatBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "thinking") return index;
  }
  return -1;
}

/** Applies one ordered desktop render event without flattening block order. */
export function applyChatMessageEvent(
  blocks: readonly RemoteChatBlock[],
  event: ChatMessageEvent,
): RemoteChatBlock[] {
  const next = blocks.map((block) => ({ ...block }));
  if (event.kind === "text_delta") {
    const last = next[next.length - 1];
    if (last?.kind === "text") last.text += event.delta;
    else next.push({ kind: "text", text: event.delta });
    return next;
  }
  if (event.kind === "thinking_delta") {
    const last = next[next.length - 1];
    if (last?.kind === "thinking") last.thinking += event.delta;
    else next.push({ kind: "thinking", thinking: event.delta });
    return next;
  }

  const index = findToolBlock(next, event.toolUseId, event.name);
  if (event.kind === "tool_call") {
    const block: RemoteChatBlock = {
      kind: "tool",
      toolUseId: event.toolUseId,
      name: event.name,
      input: event.input,
      output: null,
      isError: null,
      progress: null,
    };
    if (index >= 0) next[index] = { ...next[index], ...block };
    else next.push(block);
    return next;
  }

  const existing = index >= 0 && next[index].kind === "tool"
    ? next[index] as Extract<RemoteChatBlock, { kind: "tool" }>
    : null;
  const block: Extract<RemoteChatBlock, { kind: "tool" }> = existing ?? {
    kind: "tool",
    toolUseId: event.toolUseId,
    name: event.name,
    input: "",
    output: null,
    isError: null,
    progress: null,
  };
  if (event.kind === "tool_progress") block.progress = event.progress;
  else {
    block.output = event.output;
    block.isError = event.isError;
  }
  if (index >= 0) next[index] = block;
  else next.push(block);
  return next;
}

export function remoteTranscriptMessageFromWire(value: unknown): RemoteTranscriptMessage | null {
  if (
    !isRecord(value)
    || (value.role !== "user" && value.role !== "assistant")
    || typeof value.text !== "string"
  ) return null;

  if (value.blocks === undefined) {
    return {
      role: value.role,
      text: value.text,
      blocks: value.text ? [{ kind: "text", text: value.text }] : [],
    };
  }
  if (!Array.isArray(value.blocks)) return null;
  const blocks: RemoteChatBlock[] = [];
  for (const blockValue of value.blocks) {
    const block = remoteChatBlockFromWire(blockValue, value.role);
    if (!block) return null;
    blocks.push(block);
  }
  return { role: value.role, text: value.text, blocks };
}

function remoteChatBlockFromWire(
  value: unknown,
  role: "user" | "assistant",
): RemoteChatBlock | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "text" && typeof value.text === "string") {
    return { kind: "text", text: value.text };
  }
  if (role !== "assistant") return null;
  if (value.kind === "thinking" && typeof value.thinking === "string") {
    return { kind: "thinking", thinking: value.thinking };
  }
  if (value.kind !== "tool" || typeof value.name !== "string" || typeof value.input !== "string") {
    return null;
  }
  const toolUseId = optionalString(value.tool_use_id);
  const output = optionalString(value.output);
  const isError = value.is_error === null || value.is_error === undefined
    ? null
    : value.is_error;
  if (toolUseId === undefined || output === undefined || (isError !== null && typeof isError !== "boolean")) {
    return null;
  }
  const progress = value.progress === null || value.progress === undefined
    ? null
    : chatToolProgressFromWire(value.progress);
  if (progress === undefined) return null;
  return {
    kind: "tool",
    toolUseId,
    name: value.name,
    input: value.input,
    output,
    isError,
    progress,
  };
}

function chatToolProgressFromWire(value: unknown): ChatToolProgress | undefined {
  if (!isRecord(value)) return undefined;
  const timeoutMs = optionalSafeInteger(value.timeout_ms);
  const pid = optionalSafeInteger(value.pid);
  const stdoutTail = optionalString(value.stdout_tail);
  const stderrTail = optionalString(value.stderr_tail);
  if (
    typeof value.elapsed_ms !== "number"
    || !Number.isSafeInteger(value.elapsed_ms)
    || value.elapsed_ms < 0
    || timeoutMs === undefined
    || pid === undefined
    || stdoutTail === undefined
    || stderrTail === undefined
    || typeof value.near_timeout !== "boolean"
    || typeof value.message !== "string"
  ) return undefined;
  return {
    elapsedMs: value.elapsed_ms,
    timeoutMs,
    pid,
    stdoutTail,
    stderrTail,
    nearTimeout: value.near_timeout,
    message: value.message,
  };
}

function findToolBlock(
  blocks: readonly RemoteChatBlock[],
  toolUseId: string | null,
  name: string,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== "tool") continue;
    if (toolUseId !== null ? block.toolUseId === toolUseId : block.toolUseId === null && block.name === name) {
      return index;
    }
  }
  return -1;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalSafeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

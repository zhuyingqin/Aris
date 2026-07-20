// Pure, stateless helpers shared by the Chat controller hooks (session / run /
// command / composer). Kept free of React so they can be unit-tested directly
// and reused without pulling in component state. The run controller
// (`useChatRun`), command controller (`useChatCommands`), and composer state
// (`useChatComposer`) all build on these.

import {
  fileRead,
  type ChatContextMessage,
  type ChatImageInput,
  type ChatSendRequest,
} from "../api/tauri";
import type {
  ChatAttachment,
  ChatBlock,
  ChatCommandSelection,
  ChatTurn,
  DesktopCommandSpec,
} from "../types";
import { makeId, textFromTurn } from "./model";

export const EMPTY_ASSISTANT_RESPONSE = "Model returned an empty response.";
export const UNEXPECTED_RESPONSE_STOP = "Response stopped unexpectedly before completion.";
export const IMAGE_UNSUPPORTED_MESSAGE =
  "(Image preview only. Vision input is not supported in desktop Chat yet.)";

// Rough token estimate. Latin/code text is ~3.5 chars/token, but CJK characters
// are far denser (~1 token per character), so the old flat `chars / 3.5`
// under-counted CJK-heavy text by roughly 3x — the ContextRing read low and
// users hit the real window without warning. Weight CJK separately. Still a
// heuristic; replace with a real tokenizer when one is wired up (#34 P0-3.1).
const EXACT_TOKEN_ESTIMATE_CHAR_LIMIT = 80_000;
const TOKEN_ESTIMATE_SAMPLE_CHARS = 24_000;

function isCjkCharCode(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // CJK symbols/punct, ideographs, Hangul/Kana
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // full-width / half-width forms
  );
}

function estimateTextTokenBody(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjkCharCode(code)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.round(other / 3.5);
}

function estimateTextTokens(text: string): number {
  if (text.length <= EXACT_TOKEN_ESTIMATE_CHAR_LIMIT) {
    return estimateTextTokenBody(text) + 1;
  }
  const head = text.slice(0, TOKEN_ESTIMATE_SAMPLE_CHARS);
  const tail = text.slice(-TOKEN_ESTIMATE_SAMPLE_CHARS);
  const sampleLength = head.length + tail.length;
  const sampleTokens = estimateTextTokenBody(head) + estimateTextTokenBody(tail);
  return Math.max(1, Math.round((sampleTokens / sampleLength) * text.length) + 1);
}

export function estimateTokens(turns: ChatTurn[]): number {
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

export function deferHeavyUiWork(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => callback(), { timeout: 700 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 100);
  return () => window.clearTimeout(handle);
}

export type ContextOverride = { tokens: number; anchor: number };
export type ContextNotice = {
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
export function ringTokens(turns: ChatTurn[], override: ContextOverride | undefined): number {
  return override ? override.tokens : estimateTokens(turns);
}

export function formatCompactTokens(tokens: number): string {
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

export function isExpectedStopError(message: string): boolean {
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
  // An abnormal stop can arrive without an error body (for example, when a
  // provider closes the stream before sending a terminal event). Keep the
  // turn visibly failed instead of silently turning it into a stopped card.
  if (!message) return stopped ? undefined : UNEXPECTED_RESPONSE_STOP;
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

export async function outgoingMessage(text: string, attachments: ChatAttachment[]): Promise<ChatSendRequest> {
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
    // Failed/cancelled turns are persisted by the backend too, so their
    // streamed partial text and completed tool exchange are real context.
    // Only an actually in-flight turn is unsafe to serialize.
    if (turn.streaming) continue;
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

// The stopped/failed turn's partial response (and any tool calls/results) is now
// rebuilt into the backend context by `contextForRetry`, so the continue prompt
// no longer needs to embed — and truncate — the partial itself. It just points
// the model at the conversation above, avoiding the old 12k cutoff that dropped
// everything past the seam on long generations. Wording is neutral so it reads
// correctly whether the turn was stopped by the user or failed mid-run.
export function continueStoppedPrompt(): string {
  return [
    "Continue from where the previous turn left off.",
    "Your partial response — including any tool calls and their results — is already in the conversation above.",
    "Do not repeat the completed portion unless a short overlap is needed for continuity.",
  ].join("\n");
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

export function userTurn(text: string, attachments: ChatAttachment[]): ChatTurn {
  return {
    id: makeId("turn"),
    role: "user",
    blocks: [{ kind: "text", text: text.trim() || "Attached context" }],
    attachments,
  };
}

export function assistantTurn(): ChatTurn {
  return { id: makeId("turn"), role: "assistant", blocks: [], streaming: true };
}

export function assistantTextTurn(text: string): ChatTurn {
  return { id: makeId("turn"), role: "assistant", blocks: [{ kind: "text", text }] };
}

export const FALLBACK_SLASH_COMMANDS: DesktopCommandSpec[] = [
  { name: "help", description: "Show available slash commands" },
  { name: "model", description: "Show or switch the executor model", argumentHint: "[model]" },
  { name: "permissions", description: "Show or switch the active permission mode", argumentHint: "[mode]" },
];
export const DISABLED_DESKTOP_COMMANDS = new Set(["team", "teams", "workflow", "workflows"]);

export function visibleDesktopCommands(commands: DesktopCommandSpec[]) {
  return commands.filter((command) => !DISABLED_DESKTOP_COMMANDS.has(command.name.toLowerCase()));
}

export interface PendingCommandSelection {
  sessionId: string;
  selection: ChatCommandSelection;
}

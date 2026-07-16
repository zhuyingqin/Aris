import type { DeviceScope } from "./types";

export interface ControlRequest {
  protocol_version: 1;
  request_id: string;
  issued_at_unix_ms: number;
  command: ControlCommand;
}

export type ControlCommand =
  | { type: "get_workspace_overview" }
  | { type: "set_active_project"; project_id: string }
  | { type: "get_project_summary"; project_id: string }
  | { type: "get_task_timeline"; project_id: string; after_event_id: string | null; limit: number }
  | { type: "list_chat_sessions"; project_id: string; limit: number }
  | { type: "create_chat_session"; project_id: string }
  | { type: "get_chat_transcript"; project_id: string; session_id: string; limit: number }
  | {
      type: "get_chat_events";
      project_id: string;
      session_id: string;
      after_seq: number | null;
      limit: number;
      wait_ms: number;
    }
  | { type: "get_chat_model_options"; project_id: string; session_id: string }
  | { type: "set_chat_session_model"; project_id: string; session_id: string; model: string }
  | {
      type: "send_chat_message";
      project_id: string;
      session_id: string;
      message: string;
      idempotency_key: string;
      stream: true;
      rich_stream: boolean;
    }
  | {
      type: "stop_chat_message";
      project_id: string;
      session_id: string;
      message_id: string;
    }
  | { type: "get_review_conclusion"; project_id: string; review_id: string | null };

export interface ControlResponse {
  protocol_version: 1;
  request_id: string;
  responded_at_unix_ms: number;
  outcome:
    | { status: "success"; result: unknown }
    | { status: "error"; error: unknown };
}

/** The mobile pairing request includes the reviewed read surface and chat. */
export const MOBILE_P1_REQUESTABLE_SCOPES: readonly DeviceScope[] = [
  "read_project_state",
  "read_task_timeline",
  "send_chat_messages",
  "read_review_conclusions",
];

export function newWorkspaceOverviewRequest(nowUnixMs = Date.now()): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: { type: "get_workspace_overview" },
  };
}

/**
 * Changes the desktop's active project. This remains under the existing chat
 * capability: the phone can only select a desktop-owned workspace and cannot
 * create, delete, or inspect arbitrary local paths.
 */
export function newSetActiveProjectRequest(
  projectId: string,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: { type: "set_active_project", project_id: projectId },
  };
}

export function newChatMessageRequest(
  projectId: string,
  sessionId: string,
  message: string,
  idempotencyKey = freshUuid(),
  nowUnixMs = Date.now(),
  richStream = false,
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "send_chat_message",
      project_id: projectId,
      session_id: sessionId,
      message,
      idempotency_key: idempotencyKey,
      stream: true,
      rich_stream: richStream,
    },
  };
}

/** Interrupts only the opaque turn that this phone previously started. */
export function newStopChatMessageRequest(
  projectId: string,
  sessionId: string,
  messageId: string,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "stop_chat_message",
      project_id: projectId,
      session_id: sessionId,
      message_id: messageId,
    },
  };
}

export function newListChatSessionsRequest(
  projectId: string,
  limit = 200,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: { type: "list_chat_sessions", project_id: projectId, limit },
  };
}

export function newCreateChatSessionRequest(
  projectId: string,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: { type: "create_chat_session", project_id: projectId },
  };
}

export interface CreatedChatSession {
  projectId: string;
  sessionId: string;
  title: string;
  updatedAtUnixMs: number;
  model: string | null;
}

export function chatSessionCreatedFromResponse(
  response: ControlResponse,
  projectId: string,
): CreatedChatSession | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const result = response.outcome.result;
  if (
    result.type !== "chat_session_created"
    || result.project_id !== projectId
    || !isRecord(result.session)
    || typeof result.session.session_id !== "string"
    || result.session.session_id.length === 0
    || typeof result.session.title !== "string"
    || typeof result.session.updated_at_unix_ms !== "number"
    || !Number.isSafeInteger(result.session.updated_at_unix_ms)
    || (result.session.model !== undefined
      && result.session.model !== null
      && typeof result.session.model !== "string")
  ) {
    return null;
  }
  return {
    projectId,
    sessionId: result.session.session_id,
    title: result.session.title || "New chat",
    updatedAtUnixMs: result.session.updated_at_unix_ms,
    model: typeof result.session.model === "string" && result.session.model.trim()
      ? result.session.model.trim()
      : null,
  };
}

export function newChatTranscriptRequest(
  projectId: string,
  sessionId: string,
  limit = 100,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "get_chat_transcript",
      project_id: projectId,
      session_id: sessionId,
      limit,
    },
  };
}

export function newChatEventsRequest(
  projectId: string,
  sessionId: string,
  afterSeq: number | null,
  limit = 200,
  waitMs = 20_000,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "get_chat_events",
      project_id: projectId,
      session_id: sessionId,
      after_seq: afterSeq,
      limit,
      wait_ms: waitMs,
    },
  };
}

export function newChatModelOptionsRequest(
  projectId: string,
  sessionId: string,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "get_chat_model_options",
      project_id: projectId,
      session_id: sessionId,
    },
  };
}

/**
 * Selects a verified desktop model for the current desktop-owned chat only.
 * The paired device never receives provider credentials or settings.
 */
export function newSetChatSessionModelRequest(
  projectId: string,
  sessionId: string,
  model: string,
  nowUnixMs = Date.now(),
): ControlRequest {
  return {
    protocol_version: 1,
    request_id: freshUuid(),
    issued_at_unix_ms: nowUnixMs,
    command: {
      type: "set_chat_session_model",
      project_id: projectId,
      session_id: sessionId,
      model,
    },
  };
}

export function parseControlResponse(frame: Uint8Array): ControlResponse {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw new Error("The desktop returned malformed encrypted control data.");
  }
  if (!isRecord(value) || value.protocol_version !== 1 || typeof value.request_id !== "string" || !Number.isSafeInteger(value.responded_at_unix_ms) || !isRecord(value.outcome)) {
    throw new Error("The desktop returned an invalid encrypted control response.");
  }
  if (
    (value.outcome.status !== "success" && value.outcome.status !== "error") ||
    (value.outcome.status === "success" && !("result" in value.outcome)) ||
    (value.outcome.status === "error" && !("error" in value.outcome))
  ) {
    throw new Error("The desktop returned an invalid encrypted control response.");
  }
  return value as unknown as ControlResponse;
}

export type ChatMessageActivity = "preparing" | "compacting" | "thinking" | "tool";

export interface ChatToolProgress {
  elapsedMs: number;
  timeoutMs: number | null;
  pid: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  nearTimeout: boolean;
  message: string;
}

export type ChatMessageEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_call"; toolUseId: string | null; name: string; input: string }
  | {
      kind: "tool_progress";
      toolUseId: string | null;
      name: string;
      progress: ChatToolProgress;
    }
  | {
      kind: "tool_result";
      toolUseId: string | null;
      name: string;
      output: string;
      isError: boolean;
    };

export type ChatSessionEvent =
  | { kind: "user_message"; seq: number; text: string }
  | { kind: "assistant"; seq: number; event: ChatMessageEvent }
  | { kind: "done"; seq: number; text: string }
  | { kind: "error"; seq: number; message: string }
  | { kind: "reset"; seq: number };

export interface ChatSessionEvents {
  projectId: string;
  sessionId: string;
  events: ChatSessionEvent[];
  nextSeq: number;
}

export function chatSessionEventsFromResponse(response: ControlResponse): ChatSessionEvents | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) return null;
  const result = response.outcome.result;
  if (
    result.type !== "chat_events"
    || typeof result.project_id !== "string"
    || typeof result.session_id !== "string"
    || !Array.isArray(result.events)
    || !isSafeSequence(result.next_seq)
  ) return null;
  const events: ChatSessionEvent[] = [];
  for (const value of result.events) {
    const event = parseChatSessionEvent(value);
    if (!event) return null;
    events.push(event);
  }
  return {
    projectId: result.project_id,
    sessionId: result.session_id,
    events,
    nextSeq: result.next_seq,
  };
}

function parseChatSessionEvent(value: unknown): ChatSessionEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !isSafeSequence(value.seq)) return null;
  if (value.kind === "user_message" && typeof value.text === "string") {
    return { kind: "user_message", seq: value.seq, text: value.text };
  }
  if (value.kind === "assistant") {
    const event = parseChatMessageEvent(value.event);
    return event ? { kind: "assistant", seq: value.seq, event } : null;
  }
  if (value.kind === "done" && typeof value.text === "string") {
    return { kind: "done", seq: value.seq, text: value.text };
  }
  if (value.kind === "reset") return { kind: "reset", seq: value.seq };
  if (value.kind === "error" && typeof value.message === "string") {
    return { kind: "error", seq: value.seq, message: value.message };
  }
  return null;
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type ChatMessageProgress =
  | { kind: "accepted"; projectId: string; messageId: string }
  | {
      kind: "activity";
      projectId: string;
      sessionId: string;
      messageId: string;
      activity: ChatMessageActivity;
    }
  | {
      kind: "delta";
      projectId: string;
      sessionId: string;
      messageId: string;
      delta: string;
    }
  | {
      kind: "event";
      projectId: string;
      sessionId: string;
      messageId: string;
      event: ChatMessageEvent;
    };

/** Returns only non-terminal chat responses. Callers must keep the correlated
 * request pending until `chat_message_completed` (or an error) arrives. */
export function chatMessageProgress(response: ControlResponse): ChatMessageProgress | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const result = response.outcome.result;
  if (
    result.type === "chat_message_accepted"
    && typeof result.project_id === "string"
    && typeof result.message_id === "string"
  ) {
    return {
      kind: "accepted",
      projectId: result.project_id,
      messageId: result.message_id,
    };
  }
  if (
    result.type === "chat_message_activity"
    && typeof result.project_id === "string"
    && typeof result.session_id === "string"
    && typeof result.message_id === "string"
    && (
      result.activity === "preparing"
      || result.activity === "compacting"
      || result.activity === "thinking"
      || result.activity === "tool"
    )
  ) {
    return {
      kind: "activity",
      projectId: result.project_id,
      sessionId: result.session_id,
      messageId: result.message_id,
      activity: result.activity,
    };
  }
  if (
    result.type === "chat_message_event"
    && typeof result.project_id === "string"
    && typeof result.session_id === "string"
    && typeof result.message_id === "string"
  ) {
    const event = parseChatMessageEvent(result.event);
    if (!event) return null;
    return {
      kind: "event",
      projectId: result.project_id,
      sessionId: result.session_id,
      messageId: result.message_id,
      event,
    };
  }
  if (
    result.type === "chat_message_delta"
    && typeof result.project_id === "string"
    && typeof result.session_id === "string"
    && typeof result.message_id === "string"
    && typeof result.delta === "string"
  ) {
    return {
      kind: "delta",
      projectId: result.project_id,
      sessionId: result.session_id,
      messageId: result.message_id,
      delta: result.delta,
    };
  }
  return null;
}

function parseChatMessageEvent(value: unknown): ChatMessageEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (
    (value.kind === "text_delta" || value.kind === "thinking_delta")
    && typeof value.delta === "string"
  ) {
    return { kind: value.kind, delta: value.delta };
  }
  const toolUseId = value.tool_use_id === null || value.tool_use_id === undefined
    ? null
    : value.tool_use_id;
  if (toolUseId !== null && typeof toolUseId !== "string") return null;
  if (typeof value.name !== "string") return null;
  if (value.kind === "tool_call" && typeof value.input === "string") {
    return { kind: "tool_call", toolUseId, name: value.name, input: value.input };
  }
  if (value.kind === "tool_result" && typeof value.output === "string" && typeof value.is_error === "boolean") {
    return {
      kind: "tool_result",
      toolUseId,
      name: value.name,
      output: value.output,
      isError: value.is_error,
    };
  }
  if (value.kind !== "tool_progress") return null;
  const progress = parseChatToolProgress(value.progress);
  return progress ? { kind: "tool_progress", toolUseId, name: value.name, progress } : null;
}

function parseChatToolProgress(value: unknown): ChatToolProgress | null {
  if (
    !isRecord(value)
    || typeof value.elapsed_ms !== "number"
    || !Number.isSafeInteger(value.elapsed_ms)
    || value.elapsed_ms < 0
    || (value.timeout_ms !== null && typeof value.timeout_ms !== "number")
    || (typeof value.timeout_ms === "number" && (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 0))
    || (value.pid !== null && typeof value.pid !== "number")
    || (typeof value.pid === "number" && (!Number.isSafeInteger(value.pid) || value.pid < 0))
    || (value.stdout_tail !== null && typeof value.stdout_tail !== "string")
    || (value.stderr_tail !== null && typeof value.stderr_tail !== "string")
    || typeof value.near_timeout !== "boolean"
    || typeof value.message !== "string"
  ) return null;
  return {
    elapsedMs: value.elapsed_ms,
    timeoutMs: value.timeout_ms,
    pid: value.pid,
    stdoutTail: value.stdout_tail,
    stderrTail: value.stderr_tail,
    nearTimeout: value.near_timeout,
    message: value.message,
  };
}

export type ChatMessageTerminal =
  | {
      kind: "completed";
      projectId: string;
      sessionId: string;
      messageId: string;
      text: string;
    }
  | {
      kind: "cancelled";
      projectId: string;
      sessionId: string;
      messageId: string;
    };

/** Parses the authoritative final response for one streaming chat request. */
export function chatMessageTerminal(response: ControlResponse): ChatMessageTerminal | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const result = response.outcome.result;
  if (
    result.type === "chat_message_completed"
    && typeof result.project_id === "string"
    && typeof result.session_id === "string"
    && typeof result.message_id === "string"
    && typeof result.text === "string"
  ) {
    return {
      kind: "completed",
      projectId: result.project_id,
      sessionId: result.session_id,
      messageId: result.message_id,
      text: result.text,
    };
  }
  if (
    result.type === "chat_message_cancelled"
    && typeof result.project_id === "string"
    && typeof result.session_id === "string"
    && typeof result.message_id === "string"
  ) {
    return {
      kind: "cancelled",
      projectId: result.project_id,
      sessionId: result.session_id,
      messageId: result.message_id,
    };
  }
  return null;
}

/** Returns true only when the desktop accepted this exact stop request. */
export function chatMessageStopRequested(
  response: ControlResponse,
  projectId: string,
  sessionId: string,
  messageId: string,
): boolean {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return false;
  }
  const result = response.outcome.result;
  return result.type === "chat_message_stop_requested"
    && result.project_id === projectId
    && result.session_id === sessionId
    && result.message_id === messageId;
}

export function encodeControlRequest(request: ControlRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function freshUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This mobile platform cannot generate a control request ID.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

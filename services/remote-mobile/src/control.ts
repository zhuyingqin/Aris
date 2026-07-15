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
  | { type: "get_chat_transcript"; project_id: string; session_id: string; limit: number }
  | { type: "get_chat_model_options"; project_id: string; session_id: string }
  | { type: "set_chat_session_model"; project_id: string; session_id: string; model: string }
  | {
      type: "send_chat_message";
      project_id: string;
      session_id: string;
      message: string;
      idempotency_key: string;
      stream: true;
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

export type ChatMessageProgress =
  | { kind: "accepted"; projectId: string; messageId: string }
  | {
      kind: "delta";
      projectId: string;
      sessionId: string;
      messageId: string;
      delta: string;
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

import { describe, expect, it } from "vitest";

import {
  chatMessageProgress,
  MOBILE_P1_REQUESTABLE_SCOPES,
  newChatModelOptionsRequest,
  newChatTranscriptRequest,
  newChatMessageRequest,
  newListChatSessionsRequest,
  newSetActiveProjectRequest,
  newSetChatSessionModelRequest,
  parseControlResponse,
} from "./control";

describe("mobile control requests", () => {
  it("requests explicit chat scope and builds a bounded chat command", () => {
    expect(MOBILE_P1_REQUESTABLE_SCOPES).toContain("send_chat_messages");

    const request = newChatMessageRequest(
      "project-alpha",
      "session-alpha",
      "Summarize the current evidence.",
      "chat-turn-1",
      1_234,
    );

    expect(request).toMatchObject({
      protocol_version: 1,
      issued_at_unix_ms: 1_234,
      command: {
        type: "send_chat_message",
        project_id: "project-alpha",
        session_id: "session-alpha",
        message: "Summarize the current evidence.",
        idempotency_key: "chat-turn-1",
        stream: true,
      },
    });
    expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses bounded session list and transcript commands", () => {
    expect(newListChatSessionsRequest("project-alpha", 200, 1_234).command).toEqual({
      type: "list_chat_sessions",
      project_id: "project-alpha",
      limit: 200,
    });
    expect(newChatTranscriptRequest("project-alpha", "session-alpha", 100, 1_234).command).toEqual({
      type: "get_chat_transcript",
      project_id: "project-alpha",
      session_id: "session-alpha",
      limit: 100,
    });
  });

  it("uses the existing paired-chat capability for project and model selection", () => {
    expect(MOBILE_P1_REQUESTABLE_SCOPES).toContain("send_chat_messages");
    expect(newSetActiveProjectRequest("project-beta", 1_234).command).toEqual({
      type: "set_active_project",
      project_id: "project-beta",
    });
    expect(newChatModelOptionsRequest("project-beta", "session-beta", 1_234).command).toEqual({
      type: "get_chat_model_options",
      project_id: "project-beta",
      session_id: "session-beta",
    });
    expect(newSetChatSessionModelRequest("project-beta", "session-beta", "gpt-5.6", 1_234).command).toEqual({
      type: "set_chat_session_model",
      project_id: "project-beta",
      session_id: "session-beta",
      model: "gpt-5.6",
    });
  });

  it("keeps the completed chat result associated with its request id", () => {
    const response = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-42",
      responded_at_unix_ms: 1_234,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_completed",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-42",
          text: "The evidence is ready for review.",
        },
      },
    })));

    expect(response.request_id).toBe("request-42");
    expect(response.outcome).toMatchObject({
      status: "success",
      result: { type: "chat_message_completed", message_id: "message-42" },
    });
  });

  it("classifies accepted and delta chat responses as non-terminal progress", () => {
    const accepted = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-live",
      responded_at_unix_ms: 1_234,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_accepted",
          project_id: "project-alpha",
          message_id: "message-live",
        },
      },
    })));
    const delta = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-live",
      responded_at_unix_ms: 1_235,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_delta",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-live",
          delta: "partial answer",
        },
      },
    })));

    expect(chatMessageProgress(accepted)).toEqual({
      kind: "accepted",
      projectId: "project-alpha",
      messageId: "message-live",
    });
    expect(chatMessageProgress(delta)).toEqual({
      kind: "delta",
      projectId: "project-alpha",
      sessionId: "session-alpha",
      messageId: "message-live",
      delta: "partial answer",
    });
  });
});

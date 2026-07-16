import { describe, expect, it } from "vitest";

import {
  chatMessageProgress,
  chatMessageStopRequested,
  chatMessageTerminal,
  chatSessionEventsFromResponse,
  chatSessionCreatedFromResponse,
  MOBILE_P1_REQUESTABLE_SCOPES,
  newChatModelOptionsRequest,
  newChatEventsRequest,
  newCreateChatSessionRequest,
  newChatTranscriptRequest,
  newChatMessageRequest,
  newListChatSessionsRequest,
  newSetActiveProjectRequest,
  newSetChatSessionModelRequest,
  newStopChatMessageRequest,
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
        rich_stream: false,
      },
    });
    expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("opts into ordered desktop-visible chat events only when negotiated", () => {
    expect(newChatMessageRequest(
      "project-alpha",
      "session-alpha",
      "Check the route.",
      "chat-turn-rich",
      1_234,
      true,
    ).command).toMatchObject({
      type: "send_chat_message",
      rich_stream: true,
    });
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

  it("builds a cursor-based desktop chat event long poll", () => {
    expect(newChatEventsRequest("project-alpha", "session-alpha", 42, 200, 20_000, 1_234).command).toEqual({
      type: "get_chat_events",
      project_id: "project-alpha",
      session_id: "session-alpha",
      after_seq: 42,
      limit: 200,
      wait_ms: 20_000,
    });
  });

  it("creates a desktop-owned chat and validates its returned summary", () => {
    expect(newCreateChatSessionRequest("project-alpha", 1_234).command).toEqual({
      type: "create_chat_session",
      project_id: "project-alpha",
    });
    const response: import("./control").ControlResponse = {
      protocol_version: 1,
      request_id: "request-create",
      responded_at_unix_ms: 1_235,
      outcome: {
        status: "success",
        result: {
          type: "chat_session_created",
          project_id: "project-alpha",
          session: {
            session_id: "chat-new",
            title: "New chat",
            updated_at_unix_ms: 1_235,
            model: null,
          },
        },
      },
    };
    expect(chatSessionCreatedFromResponse(response, "project-alpha")).toEqual({
      projectId: "project-alpha",
      sessionId: "chat-new",
      title: "New chat",
      updatedAtUnixMs: 1_235,
      model: null,
    });
    expect(chatSessionCreatedFromResponse(response, "project-beta")).toBeNull();
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

  it("builds a stop request scoped to the accepted desktop message", () => {
    expect(newStopChatMessageRequest("project-alpha", "session-alpha", "message-42", 1_234).command).toEqual({
      type: "stop_chat_message",
      project_id: "project-alpha",
      session_id: "session-alpha",
      message_id: "message-42",
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

  it("classifies accepted, safe activity, and delta responses as non-terminal progress", () => {
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
    const activity = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-live",
      responded_at_unix_ms: 1_235,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_activity",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-live",
          activity: "tool",
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
    expect(chatMessageProgress(activity)).toEqual({
      kind: "activity",
      projectId: "project-alpha",
      sessionId: "session-alpha",
      messageId: "message-live",
      activity: "tool",
    });
  });

  it("parses ordered thinking and UI-sanitized tool events", () => {
    const response = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-rich",
      responded_at_unix_ms: 1_240,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_event",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-rich",
          event: {
            kind: "tool_progress",
            tool_use_id: "tool-1",
            name: "shell_command",
            progress: {
              elapsed_ms: 250,
              timeout_ms: 30_000,
              pid: 42,
              stdout_tail: "checking",
              stderr_tail: null,
              near_timeout: false,
              message: "running",
            },
          },
        },
      },
    })));

    expect(chatMessageProgress(response)).toEqual({
      kind: "event",
      projectId: "project-alpha",
      sessionId: "session-alpha",
      messageId: "message-rich",
      event: {
        kind: "tool_progress",
        toolUseId: "tool-1",
        name: "shell_command",
        progress: {
          elapsedMs: 250,
          timeoutMs: 30_000,
          pid: 42,
          stdoutTail: "checking",
          stderrTail: null,
          nearTimeout: false,
          message: "running",
        },
      },
    });
  });

  it("parses desktop-originated user and assistant event batches", () => {
    const response = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-sync",
      responded_at_unix_ms: 1_240,
      outcome: {
        status: "success",
        result: {
          type: "chat_events",
          project_id: "project-alpha",
          session_id: "session-alpha",
          next_seq: 45,
          events: [
            { kind: "user_message", seq: 43, text: "desktop question" },
            { kind: "assistant", seq: 44, event: { kind: "thinking_delta", delta: "checking" } },
            { kind: "done", seq: 45, text: "desktop answer" },
          ],
        },
      },
    })));
    expect(chatSessionEventsFromResponse(response)).toEqual({
      projectId: "project-alpha",
      sessionId: "session-alpha",
      nextSeq: 45,
      events: [
        { kind: "user_message", seq: 43, text: "desktop question" },
        { kind: "assistant", seq: 44, event: { kind: "thinking_delta", delta: "checking" } },
        { kind: "done", seq: 45, text: "desktop answer" },
      ],
    });
  });

  it("accepts only safe chat activity values and parses terminal stop outcomes", () => {
    const malformedActivity = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-live",
      responded_at_unix_ms: 1_236,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_activity",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-live",
          activity: "raw_reasoning",
        },
      },
    })));
    expect(chatMessageProgress(malformedActivity)).toBeNull();

    const cancelled = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-live",
      responded_at_unix_ms: 1_237,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_cancelled",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-live",
        },
      },
    })));
    expect(chatMessageTerminal(cancelled)).toEqual({
      kind: "cancelled",
      projectId: "project-alpha",
      sessionId: "session-alpha",
      messageId: "message-live",
    });

    const stopAccepted = parseControlResponse(new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      request_id: "request-stop",
      responded_at_unix_ms: 1_238,
      outcome: {
        status: "success",
        result: {
          type: "chat_message_stop_requested",
          project_id: "project-alpha",
          session_id: "session-alpha",
          message_id: "message-live",
        },
      },
    })));
    expect(chatMessageStopRequested(stopAccepted, "project-alpha", "session-alpha", "message-live")).toBe(true);
    expect(chatMessageStopRequested(stopAccepted, "project-alpha", "session-alpha", "other-message")).toBe(false);
  });

  it.each(["preparing", "compacting"] as const)(
    "parses the %s pre-execution activity without calling it thinking",
    (activity) => {
      const response = parseControlResponse(new TextEncoder().encode(JSON.stringify({
        protocol_version: 1,
        request_id: "request-preflight",
        responded_at_unix_ms: 1_238,
        outcome: {
          status: "success",
          result: {
            type: "chat_message_activity",
            project_id: "project-alpha",
            session_id: "session-alpha",
            message_id: "message-live",
            activity,
          },
        },
      })));

      expect(chatMessageProgress(response)).toMatchObject({ kind: "activity", activity });
    },
  );
});

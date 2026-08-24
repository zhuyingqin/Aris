import { describe, expect, it } from "vitest";

import type { ControlResponse } from "./control";
import { chatModelStateFromResponse } from "./chatModelNavigation";

function modelResponse(result: unknown): ControlResponse {
  return {
    protocol_version: 1,
    request_id: "request-1",
    responded_at_unix_ms: 1,
    outcome: { status: "success", result },
  };
}

describe("chatModelStateFromResponse", () => {
  it("keeps the selected model and credential-free option labels", () => {
    expect(chatModelStateFromResponse(modelResponse({
      type: "chat_model_options",
      project_id: "project-alpha",
      session_id: "session-alpha",
      model: "gpt-5.6",
      options: [
        { value: "gpt-5.6", label: "GPT-5.6", description: "Managed account" },
        { value: "claude-4", label: "Claude 4", description: null },
      ],
    }), "project-alpha", "session-alpha")).toEqual({
      model: "gpt-5.6",
      options: [
        { value: "gpt-5.6", label: "GPT-5.6", description: "Managed account" },
        { value: "claude-4", label: "Claude 4", description: null },
      ],
    });
  });

  it("rejects a response for a different conversation", () => {
    const wrongSession = modelResponse({
      type: "chat_model_options",
      project_id: "project-alpha",
      session_id: "session-beta",
      model: null,
      options: [],
    });
    expect(chatModelStateFromResponse(wrongSession, "project-alpha", "session-alpha")).toBeNull();

  });

  it("keeps an existing session model visible while its registry refreshes", () => {
    const unlisted = modelResponse({
      type: "chat_session_model_updated",
      project_id: "project-alpha",
      session_id: "session-alpha",
      model: "not-configured",
      options: [{ value: "gpt-5.6", label: "GPT-5.6", description: null }],
    });
    expect(chatModelStateFromResponse(unlisted, "project-alpha", "session-alpha")).toEqual({
      model: "not-configured",
      options: [
        { value: "not-configured", label: "not-configured", description: "当前对话模型" },
        { value: "gpt-5.6", label: "GPT-5.6", description: null },
      ],
    });
  });
});

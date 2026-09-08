import { describe, expect, it } from "vitest";

import type { ControlResponse } from "./control";
import { workspaceOverviewFromResponse, workspaceProjectsFromResponse } from "./workspaceNavigation";

function workspaceResponse(projects: unknown[]): ControlResponse {
  return {
    protocol_version: 1,
    request_id: "request-1",
    responded_at_unix_ms: 1,
    outcome: {
      status: "success",
      result: { type: "workspace_overview", projects },
    },
  };
}

describe("workspace navigation", () => {
  it("treats a legacy overview without capabilities as chat-only compatible", () => {
    const legacy = workspaceOverviewFromResponse(workspaceResponse([{
      project_id: "project-alpha",
      title: "Alpha research",
      phase: "active",
      updated_at_unix_ms: 1_000,
      active_run_id: null,
    }]));

    expect(legacy).toMatchObject({
      projects: [{ projectId: "project-alpha", isActive: false }],
      capabilities: [],
      capabilitiesAdvertised: false,
    });
  });

  it("accepts known optional capabilities once and ignores future ones", () => {
    const response: ControlResponse = {
      ...workspaceResponse([]),
      outcome: {
        status: "success",
        result: {
          type: "workspace_overview",
          projects: [],
          capabilities: [
            "set_active_project",
            "create_chat_session",
            "get_chat_model_options",
            "stop_chat_message",
            "rich_chat_progress",
            "chat_event_sync",
            "set_active_project",
            "future_desktop_capability",
          ],
        },
      },
    };

    expect(workspaceOverviewFromResponse(response)?.capabilities).toEqual([
      "set_active_project",
      "create_chat_session",
      "get_chat_model_options",
      "stop_chat_message",
      "rich_chat_progress",
      "chat_event_sync",
    ]);
    expect(workspaceOverviewFromResponse(response)?.capabilitiesAdvertised).toBe(true);
  });

  it("distinguishes an explicitly empty capability list from a legacy omitted list", () => {
    const response: ControlResponse = {
      ...workspaceResponse([]),
      outcome: {
        status: "success",
        result: { type: "workspace_overview", projects: [], capabilities: [] },
      },
    };

    expect(workspaceOverviewFromResponse(response)).toMatchObject({
      capabilities: [],
      capabilitiesAdvertised: true,
    });
  });

  it("keeps each safe project field needed by the workspace drawer", () => {
    expect(workspaceProjectsFromResponse(workspaceResponse([
      {
        project_id: "project-alpha",
        title: "Alpha research",
        phase: "active",
        updated_at_unix_ms: 1_000,
        active_run_id: null,
        is_active: true,
      },
    ]))).toEqual([
      {
        projectId: "project-alpha",
        title: "Alpha research",
        phase: "active",
        updatedAtUnixMs: 1_000,
        activeRunId: null,
        isActive: true,
      },
    ]);
  });

  it("uses concise fallbacks for blank desktop labels", () => {
    expect(workspaceProjectsFromResponse(workspaceResponse([
      {
        project_id: "project-alpha",
        title: "   ",
        phase: "   ",
        updated_at_unix_ms: 1_000,
        active_run_id: "run-1",
        is_active: false,
      },
    ]))).toMatchObject([{ title: "SomniQ 项目", phase: "active", activeRunId: "run-1", isActive: false }]);
  });

  it("accepts a legacy project summary that omits an active run", () => {
    expect(workspaceProjectsFromResponse(workspaceResponse([
      {
        project_id: "project-alpha",
        title: "Alpha",
        phase: "active",
        updated_at_unix_ms: 1_000,
      },
    ]))).toMatchObject([{ projectId: "project-alpha", activeRunId: null }]);
  });

  it("rejects duplicate or malformed project summaries", () => {
    const duplicate = {
      project_id: "project-alpha",
      title: "Alpha",
      phase: "active",
      updated_at_unix_ms: 1_000,
      active_run_id: null,
      is_active: true,
    };
    expect(workspaceProjectsFromResponse(workspaceResponse([duplicate, duplicate]))).toBeNull();
    expect(workspaceProjectsFromResponse(workspaceResponse([{
      ...duplicate,
      active_run_id: 42,
    }]))).toBeNull();
    expect(workspaceProjectsFromResponse(workspaceResponse([
      duplicate,
      { ...duplicate, project_id: "project-beta" },
    ]))).toBeNull();
  });
});

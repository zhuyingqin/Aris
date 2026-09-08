// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatPermissionSet: vi.fn(() => Promise.resolve({ mode: "read-only", label: "Plan", description: "Inspect and search only" })),
  chatPermissionRespond: vi.fn(() => Promise.resolve()),
  chatQuestionRespond: vi.fn(() => Promise.resolve()),
  chatDelete: vi.fn(() => Promise.resolve()),
}));

const streamMocks = vi.hoisted(() => ({
  requests: [] as Array<{ sessionId: string; request: Record<string, unknown> }>,
}));

vi.mock("../../api/tauri", () => apiMocks);
vi.mock("../useChatStream", () => ({
  useChatStream: (handlers: {
    onComplete: (sessionId: string, reply: string) => void;
  }) => ({
    runningSessionIds: new Set<string>(),
    run: vi.fn(async (sessionId: string, request: Record<string, unknown>) => {
      streamMocks.requests.push({ sessionId, request });
      handlers.onComplete(sessionId, "旁路分析结果");
      return true;
    }),
    stop: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("../ChatThread", () => ({
  default: ({ turns }: { turns: ChatTurn[] }) => (
    <div data-testid="side-thread">
      {turns.flatMap((turn) => turn.blocks).map((block, index) => (
        block.kind === "text" ? <span key={index}>{block.text}</span> : null
      ))}
    </div>
  ),
}));

vi.mock("../ChatComposer", () => ({
  default: ({
    input,
    onInputChange,
    onSubmit,
  }: {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: () => void;
  }) => (
    <div>
      <textarea aria-label="Side question" value={input} onChange={(event) => onInputChange(event.currentTarget.value)} />
      <button type="button" onClick={onSubmit}>Send</button>
    </div>
  ),
}));

import { useStore } from "../../store";
import SideTaskPanel from "../SideTaskPanel";

describe("SideTaskPanel", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    streamMocks.requests.length = 0;
    useStore.setState({ language: "cn" });
  });

  afterEach(() => cleanup());

  it("runs in an isolated ephemeral read-only session and hands the result to the main draft", async () => {
    const onMetadataChange = vi.fn();
    render(
      <SideTaskPanel
        taskId="side-task-tab-a"
        initialTitle="侧边任务 1"
        projectId="project-a"
        model="model-a"
        ready
        onMetadataChange={onMetadataChange}
      />,
    );

    await waitFor(() => expect(apiMocks.chatPermissionSet).toHaveBeenCalledWith(expect.stringMatching(/^side-task-/), "read-only"));
    await userEvent.type(screen.getByRole("textbox", { name: "Side question" }), "检查当前实验状态");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(streamMocks.requests).toHaveLength(1));
    expect(streamMocks.requests[0].request).toMatchObject({
      projectId: "project-a",
      model: "model-a",
      ephemeral: true,
    });
    expect(String(streamMocks.requests[0].request.text)).toContain("temporary SomniQ side task");
    expect(String(streamMocks.requests[0].request.text)).toContain("检查当前实验状态");

    await waitFor(() => expect(onMetadataChange).toHaveBeenLastCalledWith(
      "side-task-tab-a",
      expect.objectContaining({
        title: "检查当前实验状态",
        handoff: expect.stringContaining("[侧边任务回流"),
      }),
    ));
    const latestCall = onMetadataChange.mock.calls[onMetadataChange.mock.calls.length - 1];
    const latestMetadata = latestCall?.[1] as { handoff: string };
    expect(latestMetadata.handoff).toContain("旁路分析结果");
    expect(latestMetadata.handoff).toContain("来源：临时侧边任务");
  });

  it("restores its local conversation while keeping each backend run ephemeral", async () => {
    const props = {
      taskId: "side-task-tab-restored",
      initialTitle: "侧边任务 1",
      projectId: "project-a",
      model: "model-a",
      ready: true,
      onMetadataChange: vi.fn(),
    };
    const firstView = render(<SideTaskPanel {...props} />);

    await waitFor(() => expect(apiMocks.chatPermissionSet).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByRole("textbox", { name: "Side question" }), "先核对实验配置");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("旁路分析结果")).toBeTruthy());

    firstView.unmount();
    render(<SideTaskPanel {...props} />);

    expect(await screen.findByText("先核对实验配置")).toBeTruthy();
    expect(screen.getByText("旁路分析结果")).toBeTruthy();
    await waitFor(() => expect(apiMocks.chatPermissionSet).toHaveBeenCalledTimes(2));

    await userEvent.type(screen.getByRole("textbox", { name: "Side question" }), "再检查结果文件");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(streamMocks.requests).toHaveLength(2));
    expect(streamMocks.requests[1].request).toMatchObject({
      projectId: "project-a",
      model: "model-a",
      ephemeral: true,
    });
    const restoredPrompt = String(streamMocks.requests[1].request.text);
    expect(restoredPrompt).toContain("Restored side-task conversation");
    expect(restoredPrompt).toContain("先核对实验配置");
    expect(restoredPrompt).toContain("旁路分析结果");
    expect(restoredPrompt).toContain("再检查结果文件");
  });
});

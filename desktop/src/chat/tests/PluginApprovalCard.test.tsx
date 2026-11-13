// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalCard } from "../../api/plugins";
import type { ChatBlock, ChatTurn } from "../../types";
import { useStore } from "../../store";
import ChatMessage from "../ChatMessage";
import { upsertToolCall } from "../useChatStream";

const pluginMocks = vi.hoisted(() => ({ chatPluginApprovalRespond: vi.fn() }));

vi.mock("../../api/tauri", () => ({
  chatChangeRevert: vi.fn(),
  codeBridgeOpenFile: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("../../api/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/plugins")>()),
  chatPluginApprovalRespond: pluginMocks.chatPluginApprovalRespond,
}));

const enableCard = (overrides: Partial<PluginApprovalCard> = {}): PluginApprovalCard => ({
  kind: "enable",
  name: "@local/research-tools",
  version: "0.1.0",
  description: "Research tools",
  digest: "sha256:0123456789abcdef0123456789abcdef",
  source: "D:/work/.somniq/plugin-drafts/research-tools",
  capabilities: {
    skills: [],
    uiPanels: [],
    mcpServers: [{ name: "example", command: "python", args: ["./server.py"], envKeys: ["SERVICE_TOKEN"] }],
  },
  approveOn: "desktop",
  ...overrides,
});

const approvalBlock = (card: PluginApprovalCard, extra: Partial<Extract<ChatBlock, { kind: "tool" }>> = {}) => ({
  kind: "tool" as const,
  id: "plugin-1",
  name: "PluginManager",
  input: JSON.stringify({ action: "request_enable", name: card.name }),
  ready: true,
  pluginApproval: card,
  ...extra,
});

const renderTurn = (blocks: ChatBlock[], streaming = true) => {
  const turn: ChatTurn = { id: "assistant-plugin", role: "assistant", streaming, blocks };
  return render(
    <ChatMessage
      turn={turn}
      canRetry={false}
      onEdit={() => undefined}
      onRetry={() => undefined}
      onContinue={() => undefined}
    />,
  );
};

beforeEach(() => {
  useStore.setState({ language: "en" });
  pluginMocks.chatPluginApprovalRespond.mockReset();
  pluginMocks.chatPluginApprovalRespond.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("PluginManager approval card", () => {
  it("shows what would run and answers with the card's own digest", async () => {
    const user = userEvent.setup();
    renderTurn([approvalBlock(enableCard())]);

    expect(screen.getByText("Waiting for your decision")).toBeTruthy();
    expect(screen.getByText("python ./server.py")).toBeTruthy();
    expect(screen.getByText("SERVICE_TOKEN")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve and enable" }));
    expect(pluginMocks.chatPluginApprovalRespond).toHaveBeenCalledWith(
      "plugin-1",
      "sha256:0123456789abcdef0123456789abcdef",
      true,
    );
    // One click is one answer.
    await user.click(screen.getByRole("button", { name: "Sending…" }));
    expect(pluginMocks.chatPluginApprovalRespond).toHaveBeenCalledTimes(1);
  });

  it("declines, and keeps the card open when the backend refuses the answer", async () => {
    const user = userEvent.setup();
    pluginMocks.chatPluginApprovalRespond.mockRejectedValueOnce("This card no longer matches the package it asks about.");
    renderTurn([approvalBlock(enableCard({ kind: "remove" }))]);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("This card no longer matches the package it asks about.")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(pluginMocks.chatPluginApprovalRespond).toHaveBeenLastCalledWith("plugin-1", expect.any(String), false);
  });

  it("offers no buttons before the backend is waiting or after the turn ended", () => {
    const { unmount } = renderTurn([approvalBlock(enableCard(), { ready: false })]);
    expect(screen.queryByRole("button", { name: "Approve and enable" })).toBeNull();
    expect(screen.getAllByText("Preparing").length).toBeGreaterThan(0);
    unmount();

    renderTurn([approvalBlock(enableCard())], false);
    expect(screen.queryByRole("button", { name: "Approve and enable" })).toBeNull();
    expect(screen.getByText("This request is no longer waiting for your decision.")).toBeTruthy();
  });

  it("reports the decision from the tool result", () => {
    const { unmount } = renderTurn([
      approvalBlock(enableCard(), { output: JSON.stringify({ application: "next-turn" }) }),
    ], false);
    expect(screen.getByText("Approved; available from the next turn")).toBeTruthy();
    unmount();

    renderTurn([
      approvalBlock(enableCard({ kind: "upgrade", currentVersion: "0.1.0" }), { output: JSON.stringify({ application: "rejected" }) }),
    ], false);
    expect(screen.getByText("You declined; the current version keeps running")).toBeTruthy();
  });

  it("collapses an upgrade without execution changes to one line", () => {
    renderTurn([
      approvalBlock(enableCard({
        kind: "upgrade",
        version: "0.2.0",
        currentVersion: "0.1.0",
        executionUnchanged: true,
        diff: {
          skills: { added: [], removed: [] },
          uiPanels: { added: [], removed: [] },
          mcpServers: [],
          commands: { added: [], removed: [] },
          envKeys: { added: [], removed: [] },
          changed: false,
        },
      })),
    ]);
    expect(screen.getByText("No command or environment variable changes")).toBeTruthy();
    expect(screen.queryByText("python ./server.py")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve upgrade" })).toBeTruthy();
  });

  it("never folds the card into a run of PluginManager calls", () => {
    renderTurn([
      { kind: "tool", id: "p0", name: "PluginManager", input: "{\"action\":\"preview\"}", output: "{}" },
      { kind: "tool", id: "p1", name: "PluginManager", input: "{\"action\":\"install\"}", output: "{}" },
      approvalBlock(enableCard(), { id: "p2" }),
    ]);
    expect(screen.getByRole("button", { name: "Approve and enable" })).toBeTruthy();
  });

  it("keeps the card when a later streamed copy of the call arrives without it", () => {
    const card = enableCard();
    let blocks = upsertToolCall([], { id: "plugin-1", name: "PluginManager", input: "{}", ready: true, pluginApproval: card });
    blocks = upsertToolCall(blocks, { id: "plugin-1", name: "PluginManager", input: "{\"action\":\"request_enable\"}" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ ready: true, pluginApproval: card, input: "{\"action\":\"request_enable\"}" });
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApprovalCard } from "../../api/plugins";
import { useStore } from "../../store";
import type { ChatBlock, ChatTurn } from "../../types";
import ChatMessage from "../ChatMessage";
import { questionMarkersFromTurns } from "../ChatThread";
import { userTurn } from "../chatRunHelpers";
import { migrateTurn } from "../model";
import {
  isUserQuestion,
  needsPluginContinuation,
  PLUGIN_CONTINUATION_ORIGIN,
  pluginContinuationLabel,
  pluginContinuationPrompt,
} from "../pluginContinuation";

vi.mock("../../api/tauri", () => ({
  chatChangeRevert: vi.fn(),
  codeBridgeOpenFile: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const card = (kind: PluginApprovalCard["kind"] = "enable"): PluginApprovalCard => ({
  kind,
  name: "@local/notes",
  version: "0.1.0",
  description: "",
  digest: "sha256:a",
  source: "x",
  capabilities: { skills: [], uiPanels: [], mcpServers: [] },
  approveOn: "desktop",
});

const managerCall = (application: string, extra: Partial<Extract<ChatBlock, { kind: "tool" }>> = {}): ChatBlock => ({
  kind: "tool",
  id: "pm",
  name: "PluginManager",
  input: "{}",
  output: JSON.stringify({ action: "request_enable", application }),
  pluginApproval: card(),
  ...extra,
});

const exchange = (blocks: ChatBlock[], assistant: Partial<ChatTurn> = {}, user: Partial<ChatTurn> = {}): ChatTurn[] => [
  { id: "u", role: "user", blocks: [{ kind: "text", text: "Make a panel" }], ...user },
  { id: "a", role: "assistant", blocks, ...assistant },
];

beforeEach(() => useStore.setState({ language: "en" }));
afterEach(cleanup);

describe("plugin follow-up turn", () => {
  it("follows a normally finished turn whose enable or upgrade card was approved", () => {
    expect(needsPluginContinuation(exchange([managerCall("next-turn")]))).toBe(true);
    expect(needsPluginContinuation(exchange([
      managerCall("next-turn", { pluginApproval: card("upgrade") }),
    ]))).toBe(true);
  });

  it("does not follow declined, failed, removed, card-less, stopped or chained turns", () => {
    const cases: ChatTurn[][] = [
      exchange([managerCall("rejected")]),
      exchange([managerCall("next-turn", { isError: true })]),
      exchange([managerCall("next-turn", { pluginApproval: card("remove") })]),
      // `disable` also reports next-turn, but nothing was approved on a card.
      exchange([managerCall("next-turn", { pluginApproval: undefined })]),
      exchange([managerCall("next-turn", { output: undefined })]),
      exchange([managerCall("next-turn")], { stopped: true }),
      exchange([managerCall("next-turn")], { error: "provider failed" }),
      exchange([managerCall("next-turn")], { streaming: true }),
      exchange([managerCall("next-turn")], {}, { origin: PLUGIN_CONTINUATION_ORIGIN }),
      exchange([{ kind: "tool", id: "x", name: "write_file", input: "{}", output: "{\"application\":\"next-turn\"}" }]),
    ];
    for (const turns of cases) expect(needsPluginContinuation(turns)).toBe(false);
  });

  it("marks the app's turn read-only and keeps it through storage", () => {
    const turn = userTurn(pluginContinuationLabel("cn"), [], PLUGIN_CONTINUATION_ORIGIN);
    expect(turn).toMatchObject({ origin: PLUGIN_CONTINUATION_ORIGIN, readOnly: true });
    expect(turn.blocks).toEqual([{ kind: "text", text: "插件已启用，继续验证" }]);
    const stored = migrateTurn(JSON.parse(JSON.stringify(turn)));
    expect(stored.origin).toBe(PLUGIN_CONTINUATION_ORIGIN);
    expect(migrateTurn({ id: "x", role: "user", blocks: [], origin: "elsewhere" } as never).origin).toBeUndefined();
    expect(userTurn("hello", [])).not.toHaveProperty("origin");
  });

  it("is not counted as one of the user's questions", () => {
    const turns: ChatTurn[] = [
      ...exchange([managerCall("next-turn")]),
      userTurn(pluginContinuationLabel("en"), [], PLUGIN_CONTINUATION_ORIGIN),
      { id: "a2", role: "assistant", blocks: [{ kind: "text", text: "Verified." }] },
    ];
    expect(turns.filter(isUserQuestion)).toHaveLength(1);
    expect(questionMarkersFromTurns(turns).map((marker) => marker.id)).toEqual(["u"]);
  });

  it("tells the model what to verify", () => {
    const prompt = pluginContinuationPrompt();
    expect(prompt).toContain("PluginManager list");
    expect(prompt).toContain("mcp__");
    // Verification goes through the tool, not through SomniQ's own files.
    expect(prompt).toContain("do not read SomniQ's configuration, plugin store or session files");
  });

  it("renders the app's turn as a marker without user actions", () => {
    const marker = userTurn(pluginContinuationLabel("en"), [], PLUGIN_CONTINUATION_ORIGIN);
    const { container } = render(
      <ChatMessage turn={marker} canRetry={false} onEdit={() => undefined} onRetry={() => undefined} onContinue={() => undefined} />,
    );
    expect(screen.getByRole("note").textContent).toContain("Plugin enabled");
    expect(container.querySelector(".chat-system-marker")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

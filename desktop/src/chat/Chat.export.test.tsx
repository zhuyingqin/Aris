// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn, DesktopProject } from "../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatStatus: vi.fn(() => Promise.resolve({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat" })),
  chatCommandSpecs: vi.fn(() => Promise.resolve([])),
  skillsList: vi.fn(() => Promise.resolve([])),
  projectChatStarters: vi.fn(() => Promise.resolve([])),
  chatRunCommand: vi.fn(),
  chatSetContext: vi.fn(() => Promise.resolve()),
  chatDelete: vi.fn(() => Promise.resolve()),
  chatUiSessionsLoad: vi.fn(() => Promise.resolve([])),
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
  fileRead: vi.fn(() => Promise.resolve("")),
  fileSearch: vi.fn(() => Promise.resolve([])),
  chatSend: vi.fn(() => Promise.resolve("")),
  chatCancel: vi.fn(() => Promise.resolve()),
  onChatDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatThinkingDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatTool: vi.fn(() => Promise.resolve(() => undefined)),
  onChatToolResult: vi.fn(() => Promise.resolve(() => undefined)),
  onChatDone: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("../api/tauri", () => apiMocks);

vi.mock("./ChatThread", () => ({
  default: ({ turns }: { turns: ChatTurn[] }) => (
    <div data-testid="chat-thread">
      {turns.map((turn) => (
        <article key={turn.id} data-role={turn.role}>
          {turn.blocks.map((block, index) => (
            block.kind === "text" ? <div key={index}>{block.text}</div> : null
          ))}
        </article>
      ))}
    </div>
  ),
}));

vi.mock("./ChatComposer", () => ({
  default: () => <div data-testid="chat-composer" />,
}));

vi.mock("./ChatSidebar", () => ({
  default: () => <aside data-testid="chat-sidebar" />,
}));

import Chat from "./Chat";
import { CURRENT_KEY, SESSIONS_KEY, makeSession } from "./model";
import { useStore } from "../store";

const defaultProject: DesktopProject = {
  id: "default",
  name: "Default",
  path: "F:\\Agent\\Aris",
  addedAt: 0,
  lastOpenedAt: 0,
};

function seedChatWithTurns() {
  const session = makeSession("default");
  session.id = "session-export";
  session.title = "Export test";
  session.turns = [
    { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "hello" }] },
  ];
  localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
  localStorage.setItem(CURRENT_KEY, session.id);
  return session;
}

describe("Chat export action", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.chatStatus.mockResolvedValue({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat" });
    apiMocks.chatCommandSpecs.mockResolvedValue([]);
    apiMocks.skillsList.mockResolvedValue([]);
    apiMocks.projectChatStarters.mockResolvedValue([]);
    apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    useStore.setState({
      tab: "chat",
      error: null,
      projects: [defaultProject],
      currentProject: defaultProject,
      projectBusy: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("runs /export for the current chat and appends the exported path", async () => {
    const session = seedChatWithTurns();
    apiMocks.chatRunCommand.mockResolvedValue({
      handled: true,
      message: "Exported conversation to C:\\Users\\wt\\chat.md",
      prompt: null,
      selection: null,
      replaceTurns: false,
      openSettings: false,
      refreshStatus: false,
    });

    render(<Chat />);

    const exportButton = await screen.findByRole("button", { name: "Export current chat" });
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(exportButton);

    await waitFor(() => expect(apiMocks.chatRunCommand).toHaveBeenCalledWith(session.id, "/export"));
    expect(await screen.findByText("Exported conversation to C:\\Users\\wt\\chat.md")).toBeTruthy();
  });
});

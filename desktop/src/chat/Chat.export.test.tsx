// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn, DesktopProject } from "../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatStatus: vi.fn(() => Promise.resolve({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat" })),
  chatPermissionGet: vi.fn(() => Promise.resolve({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" })),
  chatPermissionSet: vi.fn((_sessionId: string, mode: string) => Promise.resolve({ mode, label: mode, description: "" })),
  chatCommandSpecs: vi.fn(() => Promise.resolve([])),
  skillsList: vi.fn(() => Promise.resolve([])),
  projectChatStarters: vi.fn(() => Promise.resolve([])),
  chatRunCommand: vi.fn(),
  chatSuggestTitle: vi.fn(() => Promise.resolve("Concise title")),
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
  default: ({
    input,
    onInputChange,
    onSubmit,
  }: {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: () => void;
  }) => (
    <div data-testid="chat-composer">
      <textarea
        aria-label="Message ARIS"
        value={input}
        onChange={(event) => onInputChange(event.currentTarget.value)}
      />
      <button onClick={onSubmit}>Send message</button>
    </div>
  ),
}));

vi.mock("./ChatSidebar", () => ({
  default: ({
    sessions,
    onOpen,
  }: {
    sessions: { id: string; title: string }[];
    onOpen: (id: string) => void | Promise<void>;
  }) => (
    <aside data-testid="chat-sidebar">
      {sessions.map((session) => (
        <button key={session.id} onClick={() => void onOpen(session.id)}>
          {session.title}
        </button>
      ))}
    </aside>
  ),
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
    apiMocks.chatPermissionGet.mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" });
    apiMocks.chatCommandSpecs.mockResolvedValue([]);
    apiMocks.skillsList.mockResolvedValue([]);
    apiMocks.projectChatStarters.mockResolvedValue([]);
    apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    useStore.setState({
      tab: "chat",
      pendingChatInput: null,
      pendingChatRunInput: null,
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

    await userEvent.click(await screen.findByRole("button", { name: "Export test" }));
    const exportButton = await screen.findByRole("button", { name: "Export current chat" });
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(exportButton);

    await waitFor(() => expect(apiMocks.chatRunCommand).toHaveBeenCalledWith(session.id, "/export"));
    expect(await screen.findByText("Exported conversation to C:\\Users\\wt\\chat.md")).toBeTruthy();
  });

  it("runs pending slash-command handoffs from other views", async () => {
    const session = seedChatWithTurns();
    apiMocks.chatRunCommand.mockResolvedValue({
      handled: true,
      message: "Agent search started",
      prompt: null,
      selection: null,
      replaceTurns: false,
      openSettings: false,
      refreshStatus: false,
    });
    useStore.setState({ pendingChatRunInput: '/research-lit "retrieval agents"' });

    render(<Chat />);

    await waitFor(() =>
      expect(apiMocks.chatRunCommand).toHaveBeenCalledWith(
        expect.any(String),
        '/research-lit "retrieval agents"',
      ),
    );
    expect(apiMocks.chatRunCommand.mock.calls[0][0]).not.toBe(session.id);
    expect(useStore.getState().pendingChatRunInput).toBeNull();
    expect(await screen.findByText("Agent search started")).toBeTruthy();
  });

  it("uses the configured LLM to create a concise title after the first reply", async () => {
    apiMocks.chatSend.mockResolvedValue("我会帮你组织成摘要、方法和实验三个部分。");
    apiMocks.chatSuggestTitle.mockResolvedValue("贝叶斯写作计划");

    render(<Chat />);

    await userEvent.type(screen.getByRole("textbox", { name: "Message ARIS" }), "帮我写贝叶斯估计论文");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(apiMocks.chatSuggestTitle).toHaveBeenCalledWith(
        "帮我写贝叶斯估计论文",
        expect.stringContaining("摘要"),
      ),
    );
    expect(await screen.findAllByText("贝叶斯写作计划")).toHaveLength(2);
  });
});

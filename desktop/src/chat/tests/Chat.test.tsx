// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn, DesktopProject } from "../../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatStatus: vi.fn(() => Promise.resolve({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat" })),
  chatPermissionGet: vi.fn(() => Promise.resolve({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" })),
  chatPermissionSet: vi.fn((_sessionId: string, mode: string) => Promise.resolve({ mode, label: mode, description: "" })),
  chatPermissionRespond: vi.fn(() => Promise.resolve()),
  chatQuestionRespond: vi.fn(() => Promise.resolve()),
  chatCommandSpecs: vi.fn(() => Promise.resolve([])),
  skillsList: vi.fn(() => Promise.resolve([])),
  chatRunCommand: vi.fn(),
  chatSuggestTitle: vi.fn(() => Promise.resolve("Concise title")),
  projectBriefGet: vi.fn(() => Promise.resolve({ mission: "Test project mission", goal: null })),
  projectIntentObserve: vi.fn(() => Promise.resolve({ mission: "Test project mission", intent: null, goal: null })),
  projectGoalProgress: vi.fn(() => Promise.resolve({ mission: "Test project mission", goal: null })),
  chatRewindToUserMessage: vi.fn(() => Promise.resolve<number | null>(null)),
  chatSetContext: vi.fn((_sessionId: string, _messages: unknown[], _mode?: string) => Promise.resolve(0)),
  chatDelete: vi.fn(() => Promise.resolve()),
  chatEventsReplay: vi.fn(() => Promise.resolve({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] })),
  chatUiSessionsList: vi.fn(() => Promise.resolve([])),
  chatUiSessionLoad: vi.fn(() => Promise.resolve(null)),
  chatUiTurnLoad: vi.fn(() => Promise.resolve(null)),
  chatUiSessionSave: vi.fn(() => Promise.resolve()),
  chatUiSessionDelete: vi.fn(() => Promise.resolve()),
  chatUiSessionsLoad: vi.fn(() => Promise.resolve([])),
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
  fileRead: vi.fn(() => Promise.resolve("")),
  fileSearch: vi.fn(() => Promise.resolve([])),
  chatSend: vi.fn((_sessionId: string, _message: unknown) => Promise.resolve("")),
  chatModelOptions: vi.fn(() => Promise.resolve({ provider: "anthropic-compat", current: "MiniMax-M3", options: [{ value: "MiniMax-M3", label: "MiniMax-M3", description: null }] })),
  chatModelSet: vi.fn((model: string) => Promise.resolve({ ready: true, model, provider: "anthropic-compat" })),
  chatCancel: vi.fn(() => Promise.resolve()),
  onChatDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatThinkingDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatTool: vi.fn(() => Promise.resolve(() => undefined)),
  onChatToolProgress: vi.fn(() => Promise.resolve(() => undefined)),
  onChatToolResult: vi.fn(() => Promise.resolve(() => undefined)),
  onChatPermissionRequest: vi.fn(() => Promise.resolve(() => undefined)),
  onChatPermissionResolved: vi.fn(() => Promise.resolve(() => undefined)),
  onChatDone: vi.fn(() => Promise.resolve(() => undefined)),
  onChatError: vi.fn<(
    handler: (event: { sessionId: string; message: string; sessionPreserved?: boolean }) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => undefined)),
  onChatContextCompacted: vi.fn(() => Promise.resolve(() => undefined)),
  onChatContextWarning: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("../../api/tauri", () => apiMocks);

vi.mock("../ChatThread", () => ({
  default: ({
    turns,
    onContinue,
    onRetry,
  }: {
    turns: ChatTurn[];
    onContinue: () => void;
    onRetry: (turn: ChatTurn) => void;
  }) => (
    <div data-testid="chat-thread">
      {turns.map((turn) => (
        <article key={turn.id} data-role={turn.role}>
          {turn.blocks.map((block, index) => (
            block.kind === "text" ? <div key={index}>{block.text}</div> : null
          ))}
          {turn.stopped && <button onClick={onContinue}>Continue</button>}
          {turn.role === "assistant" && turn.error && <button onClick={() => onRetry(turn)}>Retry</button>}
        </article>
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
    <div data-testid="chat-composer">
      <textarea
        aria-label="Message SomniQ"
        value={input}
        onChange={(event) => onInputChange(event.currentTarget.value)}
      />
      <button onClick={onSubmit}>Send message</button>
    </div>
  ),
}));

vi.mock("../ChatSidebar", () => ({
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

import Chat from "../Chat";
import { CURRENT_KEY, SESSIONS_KEY, makeSession } from "../model";
import { useStore } from "../../store";

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
    const portal = document.createElement("div");
    portal.id = "app-chat-actions-portal";
    document.body.appendChild(portal);
    vi.clearAllMocks();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.chatStatus.mockResolvedValue({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat" });
    apiMocks.chatPermissionGet.mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" });
    apiMocks.chatCommandSpecs.mockResolvedValue([]);
    apiMocks.skillsList.mockResolvedValue([]);
    apiMocks.chatUiSessionsList.mockResolvedValue([]);
    apiMocks.chatEventsReplay.mockResolvedValue({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] });
    apiMocks.chatUiSessionLoad.mockResolvedValue(null);
    apiMocks.chatUiSessionSave.mockResolvedValue(undefined);
    apiMocks.chatUiSessionDelete.mockResolvedValue(undefined);
    apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    useStore.setState({
      tab: "chat",
      language: "en",
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
    document.getElementById("app-chat-actions-portal")?.remove();
  });

  it("reserves a right-side lane for the summary and exposes the side-panel toggle", async () => {
    render(<Chat />);

    await waitFor(() => {
      expect(document.querySelector(".chat-project-brief-sidebar .project-brief-card")).toBeTruthy();
    });
    expect(document.querySelector(".chat-root")?.classList.contains("chat-project-brief-open")).toBe(true);
    expect(document.getElementById("project-brief-popover")).toBeTruthy();
    expect(document.querySelector(".chat > .project-brief-card")).toBeNull();
    expect(document.querySelector(".chat-head-actions .chat-project-brief-toggle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show or hide side task panel" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Side task navigation" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Collapse project summary" }));
    await waitFor(() => expect(document.getElementById("project-brief-popover")).toBeNull());
    expect(document.querySelector(".chat-root")?.classList.contains("chat-project-brief-open")).toBe(false);
  });

  it("keeps the main task visible beside a hideable, extensible side-task panel", async () => {
    render(<Chat />);

    await waitFor(() => expect(document.getElementById("project-brief-popover")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Show or hide side task panel" }));

    await waitFor(() => expect(document.querySelector(".side-task-panel")).toBeTruthy());
    expect(document.getElementById("project-brief-popover")).toBeNull();
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(document.querySelector(".chat-root")?.classList.contains("chat-project-brief-open")).toBe(false);
    expect(document.querySelector('.chat > [data-testid="chat-thread"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Side task 1" }).getAttribute("aria-selected")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Add side task tab" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Side task 2" }).getAttribute("aria-selected")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Hide side task panel" }));
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(false);
    expect(document.getElementById("side-task-panel")?.hidden).toBe(true);
    expect(document.querySelectorAll(".side-task-panel")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Show or hide side task panel" }));
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(screen.getByRole("tab", { name: "Side task 2" }).getAttribute("aria-selected")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Close side task tab: Side task 2" }));
    expect(screen.queryByRole("tab", { name: "Side task 2" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Side task 1" }).getAttribute("aria-selected")).toBe("true");
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
    const exportButton = await screen.findByRole("button", { name: /Export current chat|导出当前对话/ });
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

  it("continues a stopped assistant turn from the preserved backend session", async () => {
    const session = makeSession("default");
    session.id = "session-stopped";
    session.title = "Stopped task";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Draft the implementation plan" }] },
      {
        id: "turn-assistant",
        role: "assistant",
        stopped: true,
        blocks: [{ kind: "text", text: "Partial answer: first finish the context reset path" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatSend.mockResolvedValue("Continued answer");

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Stopped task" }));
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // A cancelled turn's full session is already durable in the backend.
    // Continue must not replace it with the UI's shortened transcript.
    expect(apiMocks.chatSetContext).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalled());
    const request = apiMocks.chatSend.mock.calls[0][1] as { text: string };
    // The continue prompt no longer embeds (or truncates) the partial — it
    // points at the rebuilt conversation instead.
    expect(request.text).not.toContain("Partial stopped response:");
    expect(request.text).toContain("already in the conversation above");
    expect(request.text).toContain("Do not repeat the completed portion");
  });

  it("retries from the backend's authoritative context before the failed user turn", async () => {
    const session = makeSession("default");
    session.id = "session-retry";
    session.title = "Retry task";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Inspect the implementation" }] },
      {
        id: "turn-assistant",
        role: "assistant",
        error: "provider failed",
        blocks: [{ kind: "text", text: "Partial diagnostic" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatRewindToUserMessage.mockResolvedValue(321);
    apiMocks.chatSend.mockResolvedValue("Retried answer");

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry task" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(apiMocks.chatRewindToUserMessage).toHaveBeenCalledWith(
      session.id,
      { text: "Inspect the implementation", images: [] },
    ));
    expect(apiMocks.chatSetContext).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ text: "Inspect the implementation", model: "MiniMax-M3" }),
    ));
  });

  it("appends only an unpreserved failed turn instead of replacing backend history", async () => {
    let errorHandler:
      | ((event: { sessionId: string; message: string; sessionPreserved?: boolean }) => void)
      | undefined;
    apiMocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const session = makeSession("default");
    session.id = "session-unsaved";
    session.title = "Unsaved failure";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Keep this user request" }] },
      {
        id: "turn-assistant",
        role: "assistant",
        error: "invalid API key",
        blocks: [{ kind: "text", text: "Partial answer" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatSetContext.mockResolvedValue(99);
    apiMocks.chatSend.mockResolvedValue("Follow-up answer");

    render(<Chat />);
    await waitFor(() => expect(apiMocks.onChatError).toHaveBeenCalled());
    errorHandler?.({
      sessionId: session.id,
      message: "invalid API key",
      sessionPreserved: false,
    });

    await userEvent.click(await screen.findByRole("button", { name: "Unsaved failure" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Message SomniQ" }), "What next?");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(apiMocks.chatSetContext).toHaveBeenCalledWith(
      session.id,
      [
        { role: "user", text: "Keep this user request", images: [] },
        { role: "assistant", text: "Partial answer" },
      ],
      "append",
    ));
  });

  it("keeps a stopped turn's backend transcript for a normal follow-up", async () => {
    const session = makeSession("default");
    session.id = "session-stopped-follow-up";
    session.title = "Stopped follow-up";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Inspect the repo" }] },
      {
        id: "turn-assistant",
        role: "assistant",
        stopped: true,
        blocks: [{ kind: "text", text: "I found the chat context reset path." }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatSend.mockResolvedValue("Follow-up answer");

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Stopped follow-up" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Message SomniQ" }), "What should I change?");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(apiMocks.chatSetContext).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ text: "What should I change?", model: "MiniMax-M3" }),
    ));
  });

  it("uses the configured LLM to create a concise title after the first reply", async () => {
    apiMocks.chatSend.mockResolvedValue("我会帮你组织成摘要、方法和实验三个部分。");
    apiMocks.chatSuggestTitle.mockResolvedValue("贝叶斯写作计划");

    render(<Chat />);

    await userEvent.type(screen.getByRole("textbox", { name: "Message SomniQ" }), "帮我写贝叶斯估计论文");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(apiMocks.chatSuggestTitle).toHaveBeenCalledWith(
        "帮我写贝叶斯估计论文",
        expect.stringContaining("摘要"),
      ),
    );
    expect((await screen.findAllByText("贝叶斯写作计划")).length).toBeGreaterThanOrEqual(1);
  });

  it("opens and closes the conversation list from the compact-layout control", async () => {
    render(<Chat />);

    const openButton = screen.getByRole("button", { name: "Open chat list" });
    expect(openButton.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(openButton);
    expect(openButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.classList.contains("somniq-chat-sidebar-open")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Close chat sidebar" }));
    expect(openButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.classList.contains("somniq-chat-sidebar-open")).toBe(false);
  });
});

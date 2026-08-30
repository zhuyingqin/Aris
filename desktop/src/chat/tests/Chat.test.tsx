// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatUiSessionUpdatedEvent,
  ProjectBriefView,
  ProjectIntentObservation,
} from "../../api/tauri";
import type {
  ChatReasoningEffortView,
  ChatTodoItem,
  ChatTurn,
  ComputePeer,
  DesktopProject,
} from "../../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatStatus: vi.fn(() => Promise.resolve({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat", contextWindow: 120_000, compactionBudget: 100_000 })),
  chatPermissionGet: vi.fn(() => Promise.resolve({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" })),
  chatPermissionSet: vi.fn((_sessionId: string, mode: string) => Promise.resolve({ mode, label: mode, description: "" })),
  chatPermissionRespond: vi.fn(() => Promise.resolve()),
  chatQuestionRespond: vi.fn(() => Promise.resolve()),
  chatCommandSpecs: vi.fn(() => Promise.resolve([])),
  skillsList: vi.fn(() => Promise.resolve([])),
  chatRunCommand: vi.fn(),
  chatSuggestTitle: vi.fn(() => Promise.resolve("Concise title")),
  configGet: vi.fn(() => Promise.resolve({ reviewEnabled: true })),
  configSet: vi.fn((patch: { reviewEnabled?: boolean }) => Promise.resolve({ reviewEnabled: patch.reviewEnabled ?? true })),
  gitStatus: vi.fn(() => Promise.resolve({ isRepository: false })),
  projectBriefGet: vi.fn(() => Promise.resolve({ mission: "Test project mission", goal: null })),
  backgroundProcessesList: vi.fn(() => Promise.resolve([])),
  projectBriefReview: vi.fn(() => Promise.resolve({ mission: "Test project mission", activity: null, goal: null })),
  projectIntentObserve: vi.fn<(
    projectId: string,
    sessionId: string,
    observations: ProjectIntentObservation[],
  ) => Promise<ProjectBriefView>>(() => Promise.resolve({ mission: "Test project mission", intent: null, goal: null })),
  chatRewindToUserMessage: vi.fn(() => Promise.resolve<number | null>(null)),
  chatSetContext: vi.fn((_sessionId: string, _messages: unknown[], _mode?: string) => Promise.resolve(0)),
  chatContextTokens: vi.fn(() => Promise.resolve<number | null>(null)),
  chatTasksGet: vi.fn<(_sessionId: string) => Promise<ChatTodoItem[]>>(() => Promise.resolve([])),
  chatDelete: vi.fn(() => Promise.resolve()),
  chatEventsReplay: vi.fn(() => Promise.resolve({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] })),
  chatEventsRead: vi.fn((_sessionId: string) => Promise.resolve([] as Array<{ kind: string; payload: unknown }>)),
  reviewWorkflowsList: vi.fn(() => Promise.resolve([])),
  reviewWorkflowTranscript: vi.fn<() => Promise<{
    sessionId: string;
    eventCount: number;
    lastSeq: number;
    turns: ChatTurn[];
  }>>(() => Promise.resolve({ sessionId: "wf", eventCount: 0, lastSeq: 0, turns: [] })),
  reviewWorkflowDiscuss: vi.fn(() => Promise.resolve({ text: "Workflow discussion reply", model: "MiniMax-M3", sessionId: "wf" })),
  chatUiSessionsList: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
  chatUiSessionLoad: vi.fn<(_sessionId: string) => Promise<unknown | null>>(() => Promise.resolve(null)),
  chatUiTurnLoad: vi.fn<(_sessionId: string, _turnIndex: number) => Promise<unknown | null>>(
    () => Promise.resolve(null),
  ),
  chatUiSessionSave: vi.fn(() => Promise.resolve()),
  chatUiSessionDelete: vi.fn(() => Promise.resolve()),
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
  fileRead: vi.fn(() => Promise.resolve("")),
  fileReadText: vi.fn(() => Promise.resolve({ path: "notes.md", content: "# Notes", bytes: 7, version: "v1" })),
  fileReadBytes: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
  fileOpen: vi.fn(() => Promise.resolve()),
  fileReveal: vi.fn(() => Promise.resolve()),
  fileSearch: vi.fn(() => Promise.resolve([])),
  chatSend: vi.fn((_sessionId: string, _message: unknown) => Promise.resolve("")),
  chatModelOptions: vi.fn(() => Promise.resolve({ provider: "anthropic-compat", current: "MiniMax-M3", options: [{ value: "MiniMax-M3", label: "MiniMax-M3", description: null }] })),
  chatModelSet: vi.fn((model: string) => Promise.resolve({ ready: true, model, provider: "anthropic-compat" })),
  chatReasoningEffortGet: vi.fn<(model?: string | null) => Promise<ChatReasoningEffortView>>(),
  chatReasoningEffortSet: vi.fn<(
    effort: string,
    model?: string | null,
  ) => Promise<ChatReasoningEffortView>>(),
  chatCancel: vi.fn(() => Promise.resolve()),
  chatReviewClear: vi.fn(() => Promise.resolve()),
  computePeersList: vi.fn<() => Promise<ComputePeer[]>>(() => Promise.resolve([])),
  onComputePeerEvent: vi.fn(() => Promise.resolve(() => undefined)),
  remoteAgentWorkspace: vi.fn(),
  remoteAgentSessions: vi.fn(),
  remoteAgentSessionOpen: vi.fn(),
  remoteAgentSessionCreate: vi.fn(),
  remoteAgentModelOptions: vi.fn(() => Promise.resolve({
    nodeId: "node-a",
    projectId: "project-a",
    sessionId: "remote-session-a",
    model: "Remote-M3",
    options: [{ value: "Remote-M3", label: "Remote-M3", description: null }],
  })),
  remoteAgentModelSet: vi.fn(),
  remoteAgentChatSend: vi.fn(),
  remoteAgentChatCancel: vi.fn(() => Promise.resolve()),
  onChatDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatThinkingDelta: vi.fn(() => Promise.resolve(() => undefined)),
  onChatTool: vi.fn(() => Promise.resolve(() => undefined)),
  onChatToolProgress: vi.fn(() => Promise.resolve(() => undefined)),
  onChatToolResult: vi.fn(() => Promise.resolve(() => undefined)),
  onChatModelRetry: vi.fn(() => Promise.resolve(() => undefined)),
  onChatPermissionRequest: vi.fn(() => Promise.resolve(() => undefined)),
  onChatPermissionResolved: vi.fn(() => Promise.resolve(() => undefined)),
  onChatReview: vi.fn(() => Promise.resolve(() => undefined)),
  onChatDone: vi.fn(() => Promise.resolve(() => undefined)),
  onChatError: vi.fn<(
    handler: (event: { sessionId: string; message: string; sessionPreserved?: boolean }) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => undefined)),
  onChatContextCompacted: vi.fn(() => Promise.resolve(() => undefined)),
  onChatContextWarning: vi.fn(() => Promise.resolve(() => undefined)),
  onRemoteChatSessionUpdated: vi.fn(() => Promise.resolve(() => undefined)),
  onChatUiSessionUpdated: vi.fn<(
    handler: (event: ChatUiSessionUpdatedEvent) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => undefined)),
  listenReviewWorkflowSessionUpdated: vi.fn(() => Promise.resolve(() => undefined)),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(() => Promise.resolve<string | null>("F:/project/docs/plan.md")),
}));

vi.mock("../../api/tauri", () => apiMocks);
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);
vi.mock("../../git/GitWorkspace", () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="code-review-workspace" data-embedded={String(Boolean(embedded))}>Code review changes</div>
  ),
}));

vi.mock("../ChatThread", () => ({
  default: ({
    turns,
    onContinue,
    onRetry,
    onOpenIndependentReview,
    hasEarlierTurns,
    loadingEarlierTurns,
    onLoadEarlierTurns,
  }: {
    turns: ChatTurn[];
    onContinue: () => void;
    onRetry: (turn: ChatTurn) => void;
    onOpenIndependentReview?: () => void;
    hasEarlierTurns?: boolean;
    loadingEarlierTurns?: boolean;
    onLoadEarlierTurns?: () => void | Promise<void>;
  }) => (
    <div data-testid="chat-thread">
      <div
        data-testid="chat-history-scroll"
        onScroll={(event) => {
          if (hasEarlierTurns && !loadingEarlierTurns && event.currentTarget.scrollTop <= 96) {
            void onLoadEarlierTurns?.();
          }
        }}
      />
      {turns.map((turn) => (
        <article key={turn.id} data-role={turn.role}>
          {turn.blocks.map((block, index) => (
            block.kind === "text"
              ? <div key={index}>{block.text}</div>
              : block.kind === "review"
                ? <button key={index} aria-label="Open Reviewer status" onClick={onOpenIndependentReview}>Reviewer Agent</button>
                : null
          ))}
          {turn.stopped && <button onClick={onContinue}>Continue</button>}
          {turn.role === "assistant" && turn.error && <div role="alert">{turn.error}</div>}
          {turn.role === "assistant" && turn.error && <button onClick={() => onRetry(turn)}>Retry</button>}
        </article>
      ))}
    </div>
  ),
}));

vi.mock("../ChatComposer", () => ({
  default: ({
    input,
    busy,
    ready,
    modelName,
    modelOptions,
    onModelChange,
    onInputChange,
    onSubmit,
    reasoningSupported,
    reasoningApplied,
    reasoningEffort,
    onReasoningEffortChange,
  }: {
    input: string;
    busy: boolean;
    ready?: boolean;
    modelName?: string | null;
    modelOptions?: Array<{ value: string; label: string }>;
    onModelChange?: (value: string) => void;
    onInputChange: (value: string) => void;
    onSubmit: () => void;
    reasoningSupported?: boolean;
    reasoningApplied?: boolean;
    reasoningEffort?: string;
    onReasoningEffortChange?: (value: string) => void;
  }) => (
    <div data-testid="chat-composer" data-busy={String(busy)} data-ready={String(ready)}>
      {modelName && <div>Model: {modelName}</div>}
      {modelOptions?.map((option) => (
        <button key={option.value} onClick={() => onModelChange?.(option.value)}>
          Model option: {option.label}
        </button>
      ))}
      {reasoningSupported && (
        // Mirrors the real pill, which falls back to the provider-default label
        // whenever the backend reports the effort as not applied.
        <div data-testid="reasoning-pill">
          Reasoning: {reasoningApplied ? reasoningEffort : "provider default"}
          <button onClick={() => onReasoningEffortChange?.("medium")}>Reasoning option: Medium</button>
        </div>
      )}
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
    remotePeers = [],
    remoteWorkspaces = {},
    remoteSessionLists = {},
    selectedWorkspaceNodeId,
    onLoadRemoteTargets,
    onWorkspaceSelect,
    onRemoteProjectSelect,
    onOpenRemote,
  }: {
    sessions: { id: string; title: string }[];
    onOpen: (id: string) => void | Promise<void>;
    remotePeers?: Array<{ nodeId: string; displayName: string }>;
    remoteWorkspaces?: Record<string, {
      projects: Array<{ projectId: string; title: string }>;
    }>;
    remoteSessionLists?: Record<string, {
      nodeId: string;
      projectId: string;
      sessions: Array<{ sessionId: string; title: string }>;
    }>;
    selectedWorkspaceNodeId?: string | null;
    onLoadRemoteTargets?: () => void;
    onWorkspaceSelect?: (nodeId: string | null) => void;
    onRemoteProjectSelect?: (nodeId: string, projectId: string) => void | Promise<void>;
    onOpenRemote?: (nodeId: string, projectId: string, sessionId: string) => void | Promise<void>;
  }) => (
    <aside data-testid="chat-sidebar">
      <button onClick={onLoadRemoteTargets}>Switch local or remote computer</button>
      {remotePeers.map((peer) => (
        <button key={peer.nodeId} onClick={() => onWorkspaceSelect?.(peer.nodeId)}>
          Remote computer: {peer.displayName}
        </button>
      ))}
      {selectedWorkspaceNodeId && remoteWorkspaces[selectedWorkspaceNodeId]?.projects.map((project) => (
        <button
          key={project.projectId}
          onClick={() => void onRemoteProjectSelect?.(selectedWorkspaceNodeId, project.projectId)}
        >
          Remote project: {project.title}
        </button>
      ))}
      {selectedWorkspaceNodeId && Object.values(remoteSessionLists)
        .filter((history) => history.nodeId === selectedWorkspaceNodeId)
        .flatMap((history) => history.sessions.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => void onOpenRemote?.(history.nodeId, history.projectId, session.sessionId)}
          >
            {session.title}
          </button>
        )))}
      {sessions.map((session) => (
        <button key={session.id} onClick={() => void onOpen(session.id)}>
          {session.title}
        </button>
      ))}
    </aside>
  ),
}));

import Chat, { clampSidePanelWidth } from "../Chat";
import { CURRENT_KEY, SESSIONS_KEY, makeSession } from "../model";
import { useStore } from "../../store";

const defaultProject: DesktopProject = {
  id: "default",
  name: "Default",
  path: "F:\\Agent\\Aris",
  addedAt: 0,
  lastOpenedAt: 0,
};

// What Settings last saved. The composer switches models per session without
// persisting them, so this stays put while the session runs something else.
const CONFIGURED_EXECUTOR_MODEL = "MiniMax-M3";

// Mirrors `chat_reasoning_effort_get`/`_set`: the capability describes the model
// the caller names, and only a caller that names none gets answered from the
// configured executor.
function reasoningViewFor(model: string | null | undefined, effort: string): ChatReasoningEffortView {
  const target = model?.trim() || CONFIGURED_EXECUTOR_MODEL;
  const supported = /gpt-5|claude/i.test(target);
  return {
    supported,
    applied: supported,
    effort,
    transport: supported ? "provider_native" : "unsupported",
    message: supported ? undefined : "The active model does not expose a configurable reasoning effort.",
  };
}

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
    apiMocks.chatStatus.mockResolvedValue({ ready: true, model: "MiniMax-M3", provider: "anthropic-compat", contextWindow: 120_000, compactionBudget: 100_000 });
    apiMocks.chatPermissionGet.mockResolvedValue({ mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" });
    apiMocks.chatCommandSpecs.mockResolvedValue([]);
    apiMocks.skillsList.mockResolvedValue([]);
    apiMocks.chatUiSessionsList.mockResolvedValue([]);
    apiMocks.chatEventsReplay.mockResolvedValue({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] });
    apiMocks.chatEventsRead.mockResolvedValue([]);
    apiMocks.reviewWorkflowsList.mockResolvedValue([]);
    apiMocks.reviewWorkflowTranscript.mockResolvedValue({ sessionId: "wf", eventCount: 0, lastSeq: 0, turns: [] });
    apiMocks.reviewWorkflowDiscuss.mockResolvedValue({ text: "Workflow discussion reply", model: "MiniMax-M3", sessionId: "wf" });
    apiMocks.chatContextTokens.mockResolvedValue(null);
    let storedEffort = "high";
    apiMocks.chatReasoningEffortGet.mockImplementation((model) =>
      Promise.resolve(reasoningViewFor(model, storedEffort)));
    apiMocks.chatReasoningEffortSet.mockImplementation((effort, model) => {
      storedEffort = effort;
      return Promise.resolve(reasoningViewFor(model, storedEffort));
    });
    apiMocks.chatTasksGet.mockResolvedValue([]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(null);
    apiMocks.chatUiSessionSave.mockResolvedValue(undefined);
    apiMocks.chatUiSessionDelete.mockResolvedValue(undefined);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    apiMocks.onChatUiSessionUpdated.mockImplementation(() => Promise.resolve(() => undefined));
    useStore.setState({
      tab: "chat",
      language: "en",
      pendingChatInput: null,
      pendingChatHandoff: null,
      pendingChatRunInput: null,
      pendingSidePanelFilePath: null,
      pendingSidePanelEvidence: null,
      // Sidebar visibility is store-owned (the titlebar toggles it), so it
      // outlives an unmount and has to be reset between cases.
      chatSidebarOpen: false,
      chatSidebarCollapsed: false,
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

  it("clamps a remembered side-panel width so the main task remains visible", () => {
    expect(clampSidePanelWidth(1_400, 1_150)).toBe(730);
    expect(clampSidePanelWidth(200, 1_150)).toBe(320);
    expect(clampSidePanelWidth(900, 600)).toBe(320);
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
    expect(screen.getByRole("button", { name: "Show or hide side panel" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Side panel navigation" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Collapse project summary" }));
    await waitFor(() => expect(document.getElementById("project-brief-popover")).toBeNull());
    expect(document.querySelector(".chat-root")?.classList.contains("chat-project-brief-open")).toBe(false);
  });

  it("restores the current session task plan when loaded turns contain no TodoWrite block", async () => {
    const session = makeSession("default");
    session.id = "session-persisted-tasks";
    session.title = "Persisted task recovery";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Continue the repair" }] },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatTasksGet.mockImplementation((sessionId: string) => Promise.resolve(
      sessionId === session.id
        ? [{
            content: "Repair task persistence",
            activeForm: "Repairing task persistence",
            status: "in_progress" as const,
          }]
        : [],
    ));

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: session.title }));
    await waitFor(() => expect(apiMocks.chatTasksGet).toHaveBeenCalledWith(session.id));
    const workflow = await screen.findByTitle("Repairing task persistence");
    await userEvent.click(workflow);
    expect(screen.getByText("Repairing task persistence")).toBeTruthy();
  });

  it("asks the backend to review project activity after a completed user question", async () => {
    const sessionUpdateHandlers: Array<(event: ChatUiSessionUpdatedEvent) => void> = [];
    apiMocks.onChatUiSessionUpdated.mockImplementation((handler) => {
      sessionUpdateHandlers.push(handler);
      return Promise.resolve(() => undefined);
    });
    const session = makeSession("default");
    session.id = "session-project-review";
    session.title = "Project review cadence";
    session.turns = [
      { id: "prior-user", role: "user", blocks: [{ kind: "text", text: "Earlier question" }] },
      { id: "prior-assistant", role: "assistant", blocks: [{ kind: "text", text: "Earlier answer" }] },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatSend.mockResolvedValue("Completed answer");

    render(<Chat />);
    await userEvent.click(await screen.findByRole("button", { name: "Project review cadence" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Message SomniQ" }), "What is our core focus now?");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(apiMocks.projectIntentObserve).toHaveBeenCalledWith(
      "default",
      session.id,
      [expect.objectContaining({ text: "What is our core focus now?" })],
    ));
    expect(apiMocks.projectBriefReview).not.toHaveBeenCalled();
    const observation = apiMocks.projectIntentObserve.mock.calls.at(0)?.[2]?.[0];
    if (!observation) throw new Error("Expected a project-intent observation");
    for (const handler of sessionUpdateHandlers) {
      handler({
        sessionId: session.id,
        operation: "saved",
        latestUserTurnId: observation.id,
        assistantComplete: true,
        contextTokens: 80_000,
        contextTokensUserTurnId: "prior-user",
      });
    }
    expect(apiMocks.projectBriefReview).not.toHaveBeenCalled();
    for (const handler of sessionUpdateHandlers) {
      handler({
        sessionId: session.id,
        operation: "saved",
        latestUserTurnId: observation.id,
        assistantComplete: true,
        contextTokens: 90_000,
        contextTokensUserTurnId: observation.id,
      });
    }
    await waitFor(() => expect(apiMocks.projectBriefReview).toHaveBeenCalledWith("default", {
      sessionId: session.id,
      contextTokens: 90_000,
      compactionBudget: 100_000,
      compacted: false,
    }));
  });

  it("reuses the Chat session owned by the same workflow handoff", async () => {
    useStore.setState({
      pendingChatHandoff: {
        projectId: defaultProject.id,
        conversationKey: "review-workflow:wf-1",
        sessionId: "wf-wf-1",
        title: "Workflow · Evidence review",
        input: "First workflow snapshot",
        projectedTurns: [{
          id: "workflow-stage:wf-1:scope",
          role: "assistant",
          readOnly: true,
          blocks: [{ kind: "text", text: "Scope stage is ready" }],
        }],
        projectedTurnIds: ["workflow-stage:wf-1:scope"],
        draft: "Review the current stage",
        activate: true,
      },
    });
    render(<Chat />);

    const composer = await screen.findByRole("textbox", { name: "Message SomniQ" }) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe("Review the current stage"));
    expect(screen.queryByText("Scope stage is ready")).toBeNull();
    await waitFor(() => expect(apiMocks.reviewWorkflowTranscript).toHaveBeenCalledWith("wf-1"));
    await waitFor(() => expect(apiMocks.chatUiSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "wf-wf-1",
        workflowContextKey: "review-workflow:wf-1",
      }),
    ));
    const savedSessions = apiMocks.chatUiSessionSave.mock.calls as unknown as Array<[
      { id: string; workflowContextKey?: string },
    ]>;
    const firstSession = savedSessions
      .map(([session]) => session as { id: string; workflowContextKey?: string })
      .find((session) => session.workflowContextKey === "review-workflow:wf-1");
    expect(firstSession).toBeTruthy();

    fireEvent.change(composer, { target: { value: "My unsent workflow question" } });

    act(() => {
      useStore.getState().setPendingChatHandoff({
        projectId: defaultProject.id,
        conversationKey: "review-workflow:wf-1",
        sessionId: "wf-wf-1",
        title: "Workflow · Evidence review",
        input: "Updated workflow snapshot",
        projectedTurns: [{
          id: "workflow-stage:wf-1:scope",
          role: "assistant",
          readOnly: true,
          blocks: [{ kind: "text", text: "Scope stage passed" }],
        }],
        projectedTurnIds: ["workflow-stage:wf-1:scope"],
        draft: "Review the current stage",
        activate: true,
      });
    });

    await waitFor(() => {
      expect(composer.value).toBe("My unsent workflow question");
      expect(screen.queryByText("Scope stage passed")).toBeNull();
    });
    await waitFor(() => {
      const matchingIds = new Set(
        (apiMocks.chatUiSessionSave.mock.calls as unknown as Array<[
          { id: string; workflowContextKey?: string },
        ]>)
          .map(([session]) => session as { id: string; workflowContextKey?: string })
          .filter((session) => session.workflowContextKey === "review-workflow:wf-1")
          .map((session) => session.id),
      );
      expect(matchingIds).toEqual(new Set([firstSession!.id]));
    });

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(apiMocks.reviewWorkflowDiscuss).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "wf-1",
        text: "My unsent workflow question",
      }),
    ));
    expect(apiMocks.chatSend).not.toHaveBeenCalled();
  });

  it("replays a project-scoped workflow transcript instead of a cached projection", async () => {
    const stored = makeSession(defaultProject.id);
    stored.id = "wf-lazy-review";
    stored.title = "Workflow · Stored review";
    stored.workflowContextKey = "review-workflow:lazy-review";
    stored.workflowProjectionTurnIds = ["workflow-stage:lazy-review:scope"];
    stored.turns = [{
      id: "workflow-stage:lazy-review:scope",
      role: "assistant",
      readOnly: true,
      blocks: [{ kind: "text", text: "Old scope projection" }],
    }];
    stored.turnCount = stored.turns.length;
    apiMocks.chatUiSessionsList.mockResolvedValue([{ ...stored, turns: [], turnsLoaded: false }]);
    apiMocks.reviewWorkflowTranscript.mockResolvedValue({
      sessionId: "wf-lazy-review",
      eventCount: 4,
      lastSeq: 4,
      turns: [
        { id: "event-1-user", role: "user", blocks: [{ kind: "text", text: "Real executor request" }] },
        { id: "event-2-assistant", role: "assistant", blocks: [{ kind: "text", text: "Real executor response" }] },
      ],
    });
    useStore.setState({
      pendingChatHandoff: {
        projectId: defaultProject.id,
        conversationKey: "review-workflow:lazy-review",
        sessionId: "wf-lazy-review",
        workflowRunId: "lazy-review",
        title: "Workflow · Updated review",
        input: "",
        activate: true,
      },
    });

    render(<Chat />);

    expect(await screen.findByText("Real executor response")).toBeTruthy();
    expect(screen.queryByText("Old scope projection")).toBeNull();
    expect(apiMocks.reviewWorkflowTranscript).toHaveBeenCalledWith("lazy-review");
    expect(apiMocks.chatUiSessionLoad).not.toHaveBeenCalledWith("wf-lazy-review");
  });

  it("hydrates and persists backend context tokens for a legacy compacted chat", async () => {
    const session = seedChatWithTurns();
    apiMocks.chatContextTokens.mockResolvedValue(32_768);

    render(<Chat />);
    await userEvent.click(await screen.findByRole("button", { name: "Export test" }));

    await waitFor(() => expect(apiMocks.chatContextTokens).toHaveBeenCalledWith(session.id));
    await waitFor(() => expect(apiMocks.chatUiSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id, contextTokens: 32_768 }),
    ));
  });

  it("loads earlier restart-preview turns from upward scrolling in bounded batches", async () => {
    const allTurns = Array.from({ length: 30 }, (_, index): ChatTurn => ({
      id: `saved-turn-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      blocks: [{ kind: "text", text: `saved message ${index}` }],
    }));
    const partial = {
      ...makeSession("default"),
      id: "partial-chat",
      title: "Long saved chat",
      turns: allTurns.slice(18),
      turnsLoaded: true,
      turnsPartial: true,
      turnCount: allTurns.length,
      loadedTurnStartIndex: 18,
      questionCountBeforeLoadedTurns: 9,
      partialBaseTurnIds: allTurns.slice(18).map((turn) => turn.id),
    };
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...partial,
      turns: [],
      turnsLoaded: false,
    }]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(partial);
    apiMocks.chatUiTurnLoad.mockImplementation((_sessionId: string, turnIndex: number) => (
      Promise.resolve(allTurns[turnIndex])
    ));
    localStorage.setItem(CURRENT_KEY, partial.id);

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Long saved chat" }));
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
    const history = screen.getByTestId("chat-history-scroll");
    Object.defineProperty(history, "scrollTop", { configurable: true, value: 0 });
    fireEvent.scroll(history);
    await waitFor(() => expect(apiMocks.chatUiTurnLoad).toHaveBeenCalledTimes(12));
    expect(apiMocks.chatUiTurnLoad.mock.calls.map((call) => call[1])).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 6),
    );
    expect(await screen.findByText("saved message 6")).toBeTruthy();

    fireEvent.scroll(history);
    await waitFor(() => expect(apiMocks.chatUiTurnLoad).toHaveBeenCalledTimes(18));
    expect(apiMocks.chatUiTurnLoad.mock.calls.slice(12).map((call) => call[1])).toEqual(
      Array.from({ length: 6 }, (_, index) => index),
    );
    expect(await screen.findByText("saved message 0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("persists the automatic review toggle from the project summary", async () => {
    render(<Chat />);

    const toggle = await screen.findByRole("switch", { name: "Toggle automatic review" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(toggle);

    await waitFor(() => expect(apiMocks.configSet).toHaveBeenCalledWith({ reviewEnabled: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Future chat turns will skip the automatic Reviewer")).toBeTruthy();
  });

  it("keeps the main task visible beside a hideable, extensible side panel", async () => {
    render(<Chat />);

    expect(document.getElementById("side-task-panel")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Image workflow" })).toBeNull();
    expect(document.querySelector(".image-workflow-panel")).toBeNull();

    await waitFor(() => expect(document.getElementById("project-brief-popover")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Show or hide side panel" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Side task 1" })).toBeTruthy());
    expect(document.getElementById("project-brief-popover")).toBeNull();
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(document.querySelector(".chat-root")?.classList.contains("chat-project-brief-open")).toBe(false);
    expect(document.querySelector('.chat > [data-testid="chat-thread"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Side task 1" }).getAttribute("aria-selected")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Add side panel tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Review changes/ }));
    expect(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("code-review-workspace")).toBeTruthy();
    expect(screen.getByTestId("code-review-workspace").getAttribute("data-embedded")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Add side panel tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open image workflow/ }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Image workflow" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".image-workflow-panel")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Add side panel tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /New side task/ }));
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Side task 2" }).getAttribute("aria-selected")).toBe("true");

    // The side-panel toggle has a single home in the app toolbar, so the
    // tab strip remains compact and every toolbar icon shares one alignment.
    expect(screen.queryByRole("button", { name: "Hide side panel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show or hide side panel" }));
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(false);
    expect(document.getElementById("side-task-panel")?.hidden).toBe(true);
    expect(document.querySelectorAll(".side-task-panel")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Show or hide side panel" }));
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(screen.getByRole("tab", { name: "Side task 2" }).getAttribute("aria-selected")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Close side panel tab: Side task 2" }));
    expect(screen.queryByRole("tab", { name: "Side task 2" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Image workflow" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens a picked file as a reading tab in the side panel", async () => {
    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Show or hide side panel" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Side task 1" })).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "Add side panel tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open file/ }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "plan.md" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "plan.md" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(apiMocks.fileReadText).toHaveBeenCalledWith("F:/project/docs/plan.md"));
    // A reading tab always offers its path back to the main task.
    expect(await screen.findByRole("button", { name: "Send to main task" })).toBeTruthy();
  });

  it("restores side task tabs and the active workspace for the same main task", async () => {
    const session = makeSession("default");
    session.id = "session-side-panel-state";
    session.title = "Side panel state";
    session.turns = [
      { id: "side-panel-state-user", role: "user", blocks: [{ kind: "text", text: "Keep this task" }] },
    ];
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...session,
      turns: [],
      turnsLoaded: false,
    }]);
    apiMocks.chatUiSessionLoad.mockResolvedValue({
      ...session,
      turnsLoaded: true,
    });
    const firstView = render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: session.title }));
    await userEvent.click(screen.getByRole("button", { name: "Show or hide side panel" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Side task 1" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Add side panel tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Review changes/ }));
    expect(await screen.findByTestId("code-review-workspace")).toBeTruthy();

    await waitFor(() => {
      const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .find((candidate) => (
          candidate?.startsWith("somniq-side-panel-state-v1:")
          && candidate.endsWith(":" + encodeURIComponent(session.id))
        ));
      expect(key).toBeTruthy();
      const stored = JSON.parse(localStorage.getItem(key!) ?? "{}") as {
        tabs?: Array<{ kind: string }>;
        activeId?: string | null;
        open?: boolean;
      };
      expect(stored.tabs?.map((tab) => tab.kind)).toEqual(["task", "review"]);
      expect(stored.activeId).toBeTruthy();
      expect(stored.open).toBe(true);
    });

    firstView.unmount();
    localStorage.setItem(CURRENT_KEY, session.id);
    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: session.title }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Review" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Side task 1" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(await screen.findByTestId("code-review-workspace")).toBeTruthy();
  });

  it("consumes a reading request raised from inside the thread", async () => {
    render(<Chat />);
    await waitFor(() => expect(document.querySelector(".chat-root")).toBeTruthy());

    // File links in tool cards and markdown ask through the store; PDFs route
    // here instead of taking over the LaTeX workspace.
    useStore.setState({ pendingSidePanelFilePath: "F:/project/docs/report.md" });

    await waitFor(() => expect(screen.getByRole("tab", { name: "report.md" })).toBeTruthy());
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(useStore.getState().pendingSidePanelFilePath).toBeNull();
  });

  it("opens a cited PDF evidence request in the existing side-panel workspace", async () => {
    render(<Chat />);
    await waitFor(() => expect(document.querySelector(".chat-root")).toBeTruthy());

    useStore.setState({
      pendingSidePanelEvidence: {
        path: "F:/project/papers/paper-1.pdf",
        paperId: "paper-1",
        page: 7,
        citation: "[paper-1 p.7]",
        quotes: ["Only 20 samples were used in the evaluation."],
        requestKey: "evidence-request-1",
      },
    });

    await waitFor(() => expect(screen.getByRole("tab", { name: "paper-1.pdf" })).toBeTruthy());
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true);
    expect(useStore.getState().pendingSidePanelEvidence).toBeNull();
  });

  it("keeps Reviewer details closed until the in-chat Agent badge is clicked", async () => {
    const session = makeSession("default");
    session.id = "session-independent-review";
    session.title = "Reviewed task";
    session.turns = [
      { id: "review-user", role: "user", blocks: [{ kind: "text", text: "Implement and verify this change" }] },
      {
        id: "review-assistant",
        role: "assistant",
        streaming: true,
        blocks: [{
          kind: "review",
          phase: "reviewing",
          attempt: 1,
          maxRevisions: 2,
          reviewerProvider: "openai",
          reviewerModel: "gpt-5-reviewer",
        }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatEventsRead.mockResolvedValue([{
      kind: "independent_review",
      payload: {
        sessionId: session.id,
        phase: "reviewing",
        attempt: 1,
        maxRevisions: 2,
        reviewerProvider: "openai",
        reviewerModel: "gpt-5-reviewer",
      },
    }]);

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Reviewed task" }));
    expect(screen.queryByRole("tab", { name: "Review", hidden: true })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Independent Reviewer", hidden: true })).toBeNull();
    expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(false);
    expect(document.getElementById("side-task-panel")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open Reviewer status" }));

    await waitFor(() => expect(document.querySelector(".chat-root")?.classList.contains("side-task-open")).toBe(true));
    expect(screen.getByRole("tab", { name: "Independent Reviewer" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
    expect(document.getElementById("side-task-panel")?.hidden).toBe(false);
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

  it("resumes a failed turn from the preserved backend session instead of discarding its work", async () => {
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
    apiMocks.chatSend.mockResolvedValue("Resumed answer");

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry task" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    // Retry on a failed turn must NOT rewind or replace history: the backend
    // already preserved the turn's work (session_preserved), so recovery resumes
    // on top of it. The failed turn's partial output stays visible.
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalled());
    expect(apiMocks.chatRewindToUserMessage).not.toHaveBeenCalled();
    expect(apiMocks.chatSetContext).not.toHaveBeenCalled();
    expect(screen.getByText("Partial diagnostic")).toBeTruthy();
    const request = apiMocks.chatSend.mock.calls[0][1] as { text: string };
    expect(request.text).toContain("already in the conversation above");
    expect(request.text).toContain("Do not repeat the completed portion");
  });

  it("renders an attached message and clears its draft before file preparation finishes", async () => {
    const session = makeSession("default");
    session.id = "session-slow-attachment";
    session.title = "Slow attachment";
    session.turns = [{
      id: "prior-turn",
      role: "assistant",
      blocks: [{ kind: "text", text: "Prior response" }],
    }];
    session.draft = "Summarize the attached notes";
    session.draftAttachments = [{
      id: "attachment-notes",
      kind: "file",
      name: "notes.md",
      path: "F:\\Agent\\Aris\\notes.md",
    }];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);

    let resolveFileRead: ((value: string) => void) | undefined;
    apiMocks.fileRead.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveFileRead = resolve;
    }));
    apiMocks.chatRewindToUserMessage.mockResolvedValue(null);
    apiMocks.chatSend.mockResolvedValue("Attachment summary");

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Slow attachment" }));
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByText("Summarize the attached notes")).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "Message SomniQ" }) as HTMLTextAreaElement).value).toBe("");
    expect(apiMocks.chatSend).not.toHaveBeenCalled();

    resolveFileRead?.("# Notes");
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ text: expect.stringContaining("# Notes") }),
    ));
  });

  it("resumes an unpreserved failed turn by appending its work, never replacing history", async () => {
    let errorHandler:
      | ((event: { sessionId: string; message: string; sessionPreserved?: boolean }) => void)
      | undefined;
    apiMocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const session = makeSession("default");
    session.id = "session-reset-failure";
    session.title = "Reset failure";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Retry this request" }] },
      {
        id: "turn-assistant",
        role: "assistant",
        error: "provider failed",
        blocks: [{ kind: "text", text: "Partial answer" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatSetContext.mockResolvedValue(77);
    apiMocks.chatSend.mockResolvedValue("Resumed answer");

    render(<Chat />);
    await waitFor(() => expect(apiMocks.onChatError).toHaveBeenCalled());
    // The backend could not persist this failed turn, so recovery must rebuild
    // its work by APPENDING the preserved pair — never replacing history and
    // never losing what the turn already produced.
    errorHandler?.({ sessionId: session.id, message: "provider failed", sessionPreserved: false });

    await userEvent.click(await screen.findByRole("button", { name: "Reset failure" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(apiMocks.chatSetContext).toHaveBeenCalledWith(
      session.id,
      [
        { role: "user", text: "Retry this request", images: [] },
        { role: "assistant", text: "Partial answer" },
      ],
      "append",
    ));
    await waitFor(() => expect(apiMocks.chatSend).toHaveBeenCalled());
    expect(screen.getByText("Partial answer")).toBeTruthy();
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

  it("does not leave the composer busy because an older assistant turn has a stale streaming flag", async () => {
    const session = makeSession("default");
    session.id = "session-stale-streaming";
    session.title = "Stale streaming state";
    session.turns = [
      { id: "turn-user-old", role: "user", blocks: [{ kind: "text", text: "Old request" }] },
      {
        id: "turn-assistant-old",
        role: "assistant",
        streaming: true,
        blocks: [{ kind: "text", text: "Old partial answer" }],
      },
      { id: "turn-user-current", role: "user", blocks: [{ kind: "text", text: "Current request" }] },
      {
        id: "turn-assistant-current",
        role: "assistant",
        streaming: false,
        stopped: true,
        blocks: [{ kind: "text", text: "Current stopped answer" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Stale streaming state" }));
    await waitFor(() => expect(screen.getByTestId("chat-composer").getAttribute("data-busy")).toBe("false"));
  });

  it("does not treat a persisted local streaming flag as an active remote turn", async () => {
    const session = makeSession("default");
    session.id = "session-last-stale-streaming";
    session.title = "Last stale streaming state";
    session.turns = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "Interrupted request" }] },
      {
        id: "turn-assistant-local",
        role: "assistant",
        streaming: true,
        blocks: [{ kind: "text", text: "Persisted partial answer" }],
      },
    ];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(CURRENT_KEY, session.id);

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Last stale streaming state" }));
    await waitFor(() => expect(screen.getByTestId("chat-composer").getAttribute("data-busy")).toBe("false"));
  });

  it("uses the configured LLM to create a concise title after the first reply", async () => {
    apiMocks.chatSend.mockResolvedValue("我会帮你组织成摘要、方法和实验三个部分。");
    apiMocks.chatSuggestTitle.mockResolvedValue("贝叶斯写作计划");

    render(<Chat />);

    await userEvent.type(screen.getByRole("textbox", { name: "Message SomniQ" }), "帮我写贝叶斯估计论文");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(apiMocks.chatSuggestTitle).toHaveBeenCalledWith({
        user: "帮我写贝叶斯估计论文",
        assistant: expect.stringContaining("摘要"),
        attachments: [],
        followUps: [],
      }),
    );
    expect((await screen.findAllByText("贝叶斯写作计划")).length).toBeGreaterThanOrEqual(1);
  });

  it("retries title generation on a later turn after the first attempt fails", async () => {
    apiMocks.chatSend.mockResolvedValue("好的。");
    apiMocks.chatSuggestTitle.mockRejectedValueOnce(new Error("provider offline"));

    render(<Chat />);

    const composer = screen.getByRole("textbox", { name: "Message SomniQ" });
    await userEvent.type(composer, "看看这个视觉比例是不是很奇怪");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(apiMocks.chatSuggestTitle).toHaveBeenCalledTimes(1));

    apiMocks.chatSuggestTitle.mockResolvedValue("视觉比例排查");
    await userEvent.type(composer, "顺便看看边栏");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(apiMocks.chatSuggestTitle).toHaveBeenCalledTimes(2));
    expect(apiMocks.chatSuggestTitle).toHaveBeenLastCalledWith(expect.objectContaining({
      user: "看看这个视觉比例是不是很奇怪",
      followUps: ["顺便看看边栏"],
    }));
    expect((await screen.findAllByText("视觉比例排查")).length).toBeGreaterThanOrEqual(1);
  });

  it("checks paired-computer availability when the computer switcher is clicked", async () => {
    apiMocks.computePeersList.mockResolvedValue([]);
    render(<Chat />);

    expect(apiMocks.computePeersList).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", {
      name: "Switch local or remote computer",
    }));

    await waitFor(() => expect(apiMocks.computePeersList).toHaveBeenCalledTimes(1));
  });

  it("opens a remote history session and switches its remote model", async () => {
    apiMocks.computePeersList.mockResolvedValue([{
      endpointId: "endpoint-a",
      nodeId: "node-a",
      displayName: "Lab computer",
      gatewayUrl: "https://gateway.example",
      connected: true,
      transport: "p2p",
      pairedAtUnixMs: 1,
      lastSeenAtUnixMs: 2,
      direction: "invited",
      agentChatAuthorized: true,
    }]);
    apiMocks.remoteAgentWorkspace.mockResolvedValue({
      nodeId: "node-a",
      nodeName: "Lab computer",
      projects: [{
        projectId: "project-a",
        title: "Remote Project",
        phase: "research",
        isActive: true,
      }],
    });
    apiMocks.remoteAgentSessions.mockResolvedValue({
      nodeId: "node-a",
      nodeName: "Lab computer",
      projectId: "project-a",
      projectName: "Remote Project",
      sessions: [{
        nodeId: "node-a",
        nodeName: "Lab computer",
        projectId: "project-a",
        projectName: "Remote Project",
        sessionId: "remote-session-a",
        title: "Earlier research",
        model: "Remote-M3",
        updatedAtUnixMs: 42,
      }],
      hasMore: false,
    });
    apiMocks.remoteAgentSessionOpen.mockResolvedValue({
      nodeId: "node-a",
      nodeName: "Lab computer",
      projectId: "project-a",
      projectName: "Remote Project",
      sessionId: "remote-session-a",
      title: "Earlier research",
      updatedAtUnixMs: 42,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "Remote earlier question" }] },
        { role: "assistant", blocks: [{ kind: "text", text: "Remote earlier answer" }] },
      ],
      hasMore: false,
      model: "Remote-M3",
      modelOptions: [
        { value: "Remote-M3", label: "Remote-M3", description: null },
        { value: "Remote-GPT", label: "Remote-GPT", description: null },
      ],
    });
    apiMocks.remoteAgentModelOptions.mockResolvedValue({
      nodeId: "node-a",
      projectId: "project-a",
      sessionId: "remote-session-a",
      model: "Remote-M3",
      options: [
        { value: "Remote-M3", label: "Remote-M3", description: null },
        { value: "Remote-GPT", label: "Remote-GPT", description: null },
      ],
    });
    apiMocks.remoteAgentModelSet.mockImplementation(async () => {
      const selection = {
        nodeId: "node-a",
        projectId: "project-a",
        sessionId: "remote-session-a",
        model: "Remote-GPT",
        options: [
          { value: "Remote-M3", label: "Remote-M3", description: null },
          { value: "Remote-GPT", label: "Remote-GPT", description: null },
        ],
      };
      apiMocks.remoteAgentModelOptions.mockResolvedValue(selection);
      return selection;
    });

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: "Switch local or remote computer" }));
    await waitFor(() => expect(apiMocks.remoteAgentWorkspace).toHaveBeenCalledWith("node-a"));
    await userEvent.click(await screen.findByRole("button", { name: "Remote computer: Lab computer" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remote project: Remote Project" }));
    await waitFor(() => expect(apiMocks.remoteAgentSessions).toHaveBeenCalledWith(
      "node-a",
      "project-a",
      "Remote Project",
    ));
    await userEvent.click(await screen.findByRole("button", { name: /Earlier research/ }));

    expect(await screen.findByText("Remote earlier question")).toBeTruthy();
    expect(await screen.findByText("Remote earlier answer")).toBeTruthy();
    await waitFor(() => expect(apiMocks.remoteAgentModelOptions).toHaveBeenCalledWith(
      "node-a",
      "project-a",
      "remote-session-a",
    ));

    await userEvent.click(await screen.findByRole("button", { name: "Model option: Remote-GPT" }));
    await waitFor(() => expect(apiMocks.remoteAgentModelSet).toHaveBeenCalledWith(
      "node-a",
      "project-a",
      "remote-session-a",
      "Remote-GPT",
    ));
    expect(await screen.findByText("Model: Remote-GPT")).toBeTruthy();
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

  it("switches thinking depth on the session's own model instead of the configured executor", async () => {
    apiMocks.chatModelOptions.mockResolvedValue({
      provider: "anthropic-compat",
      current: CONFIGURED_EXECUTOR_MODEL,
      options: [
        { value: CONFIGURED_EXECUTOR_MODEL, label: CONFIGURED_EXECUTOR_MODEL, description: null },
        { value: "gpt-5.6", label: "gpt-5.6", description: null },
      ],
    });

    render(<Chat />);

    // The configured executor exposes no reasoning tier, so no pill yet.
    await waitFor(() => expect(apiMocks.chatReasoningEffortGet)
      .toHaveBeenCalledWith(CONFIGURED_EXECUTOR_MODEL));
    expect(screen.queryByTestId("reasoning-pill")).toBeNull();

    // Picking a model in the composer does not persist it (`persist: false`).
    await userEvent.click(await screen.findByRole("button", { name: "Model option: gpt-5.6" }));
    expect(await screen.findByText(/Reasoning: high/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reasoning option: Medium" }));

    // Answering from the configured executor instead reported gpt-5.6 as
    // unsupported, and the pill fell back to the provider default.
    await waitFor(() => expect(apiMocks.chatReasoningEffortSet)
      .toHaveBeenCalledWith("medium", "gpt-5.6"));
    expect(await screen.findByText(/Reasoning: medium/)).toBeTruthy();
    expect(screen.queryByText(/provider default/)).toBeNull();
  });

  it("keeps model choices visible when a saved session model cannot restore", async () => {
    const session = makeSession("default");
    session.id = "session-retired-model";
    session.title = "Retired model session";
    session.model = "retired-model";
    localStorage.setItem(CURRENT_KEY, session.id);
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...session,
      turns: [],
      turnsLoaded: false,
    }]);
    apiMocks.chatUiSessionLoad.mockResolvedValue({
      ...session,
      turnsLoaded: true,
    });
    apiMocks.chatModelOptions.mockResolvedValue({
      provider: "anthropic-compat",
      current: CONFIGURED_EXECUTOR_MODEL,
      options: [
        { value: CONFIGURED_EXECUTOR_MODEL, label: CONFIGURED_EXECUTOR_MODEL, description: null },
        { value: "gpt-5.6", label: "gpt-5.6", description: null },
      ],
    });
    apiMocks.chatModelSet.mockRejectedValueOnce(new Error("Saved model is no longer available"));

    render(<Chat />);

    await userEvent.click(await screen.findByRole("button", { name: session.title }));
    await waitFor(() => expect(apiMocks.chatModelSet).toHaveBeenCalledWith("retired-model", false));
    await waitFor(() => expect(screen.getByTestId("chat-composer").getAttribute("data-ready")).toBe("false"));
    expect(screen.getByText("Model: retired-model")).toBeTruthy();
    expect(screen.getByRole("button", { name: `Model option: ${CONFIGURED_EXECUTOR_MODEL}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model option: gpt-5.6" })).toBeTruthy();
  });

  it("keeps the last usable model catalog when a refresh fails", async () => {
    apiMocks.chatModelOptions.mockResolvedValue({
      provider: "anthropic-compat",
      current: CONFIGURED_EXECUTOR_MODEL,
      options: [
        { value: CONFIGURED_EXECUTOR_MODEL, label: CONFIGURED_EXECUTOR_MODEL, description: null },
        { value: "gpt-5.6", label: "gpt-5.6", description: null },
      ],
    });

    render(<Chat />);

    expect(await screen.findByRole("button", { name: "Model option: gpt-5.6" })).toBeTruthy();
    const callsBeforeRefresh = apiMocks.chatModelOptions.mock.calls.length;
    apiMocks.chatModelOptions.mockRejectedValueOnce(new Error("Temporary model catalog failure"));

    window.dispatchEvent(new Event("somniq-chat-models-updated"));

    await waitFor(() => expect(apiMocks.chatModelOptions.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    expect(screen.getByRole("button", { name: `Model option: ${CONFIGURED_EXECUTOR_MODEL}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model option: gpt-5.6" })).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../types";
import { useStore } from "../../store";
import ChatSidebar from "../ChatSidebar";
import { makeSession } from "../model";

beforeEach(() => {
  // Keep this suite deterministic when Vitest reuses a jsdom environment after
  // another UI suite has left a mounted portal/root behind.
  cleanup();
  localStorage.clear();
  useStore.setState({ language: "en" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatSidebar session menu", () => {
  const projects: DesktopProject[] = [
    { id: "project-a", name: "Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 2 },
  ];

  function renderSidebar() {
    const session = { ...makeSession("project-a"), id: "chat-a", title: "Alpha chat" };
    return render(
      <ChatSidebar
        sessions={[session]}
        projects={projects}
        currentId="chat-a"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={async () => undefined}
      />,
    );
  }

  it("does not render a duplicate Chat title inside the chat sidebar", () => {
    const { container } = renderSidebar();

    expect(container.querySelector(".chat-sidebar-title")).toBeNull();
  });

  it("keeps the session menu inside the viewport when the anchor is near the bottom", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 600);
    const rect = (top: number, right: number, bottom: number, left: number) => ({
      top,
      right,
      bottom,
      left,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => undefined,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const element = this;
      if (element.classList.contains("chat-session-menu-btn")) {
        return rect(560, 280, 584, 256) as DOMRect;
      }
      if (element.classList.contains("chat-session-menu")) {
        return rect(0, 180, 170, 0) as DOMRect;
      }
      return rect(0, 0, 0, 0) as DOMRect;
    });

    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Session options" }));

    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.style.visibility).toBe("visible"));

    expect(menu.parentElement).toBe(document.body);
    expect(Number(menu.style.top.replace("px", ""))).toBeLessThan(560);
    expect(Number(menu.style.left.replace("px", ""))).toBeGreaterThanOrEqual(8);
  });

  it("shows only the five most recent chats until a project group is expanded", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      ...makeSession("project-a"),
      id: `chat-${index + 1}`,
      title: `Topic ${index + 1}`,
      updatedAt: 100 - index,
    }));

    render(
      <ChatSidebar
        sessions={sessions}
        projects={projects}
        currentId="chat-1"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={async () => undefined}
      />,
    );

    expect(screen.getByText("Topic 1")).toBeTruthy();
    expect(screen.getByText("Topic 5")).toBeTruthy();
    expect(screen.queryByText("Topic 6")).toBeNull();

    const showMore = screen.getByRole("button", { name: "Show more (1)" });
    expect(showMore.getAttribute("aria-expanded")).toBe("false");
    await user.click(showMore);

    expect(screen.getByText("Topic 6")).toBeTruthy();
    const showLess = screen.getByRole("button", { name: "Show less" });
    expect(showLess.getAttribute("aria-expanded")).toBe("true");
    await user.click(showLess);
    expect(screen.queryByText("Topic 6")).toBeNull();
  });

  it("keeps the active chat visible when it is older than the collapsed window", () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      ...makeSession("project-a"),
      id: `chat-${index + 1}`,
      title: `Topic ${index + 1}`,
      updatedAt: 100 - index,
    }));

    render(
      <ChatSidebar
        sessions={sessions}
        projects={projects}
        currentId="chat-7"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={async () => undefined}
      />,
    );

    expect(screen.getByText("Topic 7")).toBeTruthy();
    expect(screen.queryByText("Topic 5")).toBeNull();
    expect(screen.getByRole("button", { name: "Show more (2)" })).toBeTruthy();
  });
});

describe("ChatSidebar execution workspace", () => {
  const projects: DesktopProject[] = [
    { id: "project-a", name: "Local Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 2 },
  ];
  const remotePeer = {
    endpointId: "endpoint-a",
    nodeId: "node-a",
    displayName: "Lab computer",
    gatewayUrl: "https://gateway.example",
    connected: true,
    transport: "p2p",
    pairedAtUnixMs: 1,
    lastSeenAtUnixMs: 2,
    direction: "invited" as const,
    agentChatAuthorized: true,
  };

  const baseProps = {
    projects,
    currentId: "chat-local",
    open: true,
    busy: false,
    onClose: () => undefined,
    onNew: () => undefined,
    onOpen: () => undefined,
    onRename: () => undefined,
    onTogglePinned: () => undefined,
    onDelete: () => undefined,
    onReorderProjects: async () => undefined,
  };

  it("switches computers from the top of the left sidebar", async () => {
    const user = userEvent.setup();
    const onWorkspaceSelect = vi.fn();
    const onLoadRemoteTargets = vi.fn();
    render(
      <ChatSidebar
        {...baseProps}
        sessions={[{ ...makeSession("project-a"), id: "chat-local", title: "Local chat" }]}
        remotePeers={[remotePeer]}
        onLoadRemoteTargets={onLoadRemoteTargets}
        onWorkspaceSelect={onWorkspaceSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch local or remote computer" }));
    expect(onLoadRemoteTargets).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("menuitem", { name: /Lab computer/ }));

    expect(onWorkspaceSelect).toHaveBeenCalledWith("node-a");
  });

  it("lets users enter an authorized offline computer while automatic reconnection continues", async () => {
    const user = userEvent.setup();
    const onWorkspaceSelect = vi.fn();
    render(
      <ChatSidebar
        {...baseProps}
        sessions={[{ ...makeSession("project-a"), id: "chat-local", title: "Local chat" }]}
        remotePeers={[{ ...remotePeer, connected: false, transport: null }]}
        onWorkspaceSelect={onWorkspaceSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Switch local or remote computer" }));
    const offlineComputer = screen.getByRole("menuitem", { name: /Lab computer/ });
    expect((offlineComputer as HTMLButtonElement).disabled).toBe(false);
    expect(offlineComputer.textContent).toContain("Reconnecting automatically");
    await user.click(offlineComputer);

    expect(onWorkspaceSelect).toHaveBeenCalledWith("node-a");
  });

  it("shows remote projects and their authoritative history instead of local mirror sessions", async () => {
    const user = userEvent.setup();
    const onRemoteProjectSelect = vi.fn();
    const onOpenRemote = vi.fn();
    const local = { ...makeSession("project-a"), id: "chat-local", title: "Local chat" };
    const remoteMirror = {
      ...makeSession("project-a"),
      id: "chat-mirror",
      title: "Stale local mirror",
      remoteAgent: {
        nodeId: "node-a",
        nodeName: "Lab computer",
        projectId: "remote-project",
        projectName: "Remote Project",
        sessionId: "remote-session",
      },
    };
    render(
      <ChatSidebar
        {...baseProps}
        sessions={[local, remoteMirror]}
        remotePeers={[remotePeer]}
        selectedWorkspaceNodeId="node-a"
        remoteWorkspaces={{
          "node-a": {
            nodeId: "node-a",
            nodeName: "Lab computer",
            projects: [{
              projectId: "remote-project",
              title: "Remote Project",
              phase: "research",
              isActive: true,
            }],
          },
        }}
        remoteSessionLists={{
          remote: {
            nodeId: "node-a",
            nodeName: "Lab computer",
            projectId: "remote-project",
            projectName: "Remote Project",
            sessions: [{
              nodeId: "node-a",
              nodeName: "Lab computer",
              projectId: "remote-project",
              projectName: "Remote Project",
              sessionId: "remote-session",
              title: "Authoritative remote chat",
              model: "Remote-M3",
              updatedAtUnixMs: 10,
            }],
            hasMore: false,
          },
        }}
        onRemoteProjectSelect={onRemoteProjectSelect}
        onOpenRemote={onOpenRemote}
      />,
    );

    expect(screen.getByText("Remote projects")).toBeTruthy();
    expect(screen.queryByText("Local chat")).toBeNull();
    expect(screen.queryByText("Stale local mirror")).toBeNull();
    await user.click(await screen.findByRole("button", { name: /^Remote Project$/ }));
    expect(onRemoteProjectSelect).toHaveBeenCalledWith("node-a", "remote-project");
    await user.click(await screen.findByRole("button", { name: /Authoritative remote chat/ }));
    expect(onOpenRemote).toHaveBeenCalledWith("node-a", "remote-project", "remote-session");
  });
});

describe("ChatSidebar project drag", () => {
  const projects: DesktopProject[] = [
    { id: "project-a", name: "Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 3 },
    { id: "project-b", name: "Beta", path: "C:/Beta", addedAt: 1, lastOpenedAt: 2 },
    { id: "project-c", name: "Gamma", path: "C:/Gamma", addedAt: 1, lastOpenedAt: 1 },
  ];
  const sessions = projects.map((project, index) => ({
    ...makeSession(project.id),
    id: `chat-${index}`,
    title: `${project.name} chat`,
  }));

  function renderProjectDragSidebar() {
    return render(
      <ChatSidebar
        sessions={sessions}
        projects={projects}
        currentId="chat-0"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={async () => undefined}
      />,
    );
  }

  function rect(top: number, height: number) {
    return {
      top,
      right: 220,
      bottom: top + height,
      left: 0,
      width: 220,
      height,
      x: 0,
      y: top,
      toJSON: () => undefined,
    } as DOMRect;
  }

  function fireProjectPointer(
    target: Window | Document | Node | Element,
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    init: { clientX: number; clientY: number; pointerId: number; button?: number; buttons?: number },
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clientX", { value: init.clientX });
    Object.defineProperty(event, "clientY", { value: init.clientY });
    Object.defineProperty(event, "pointerId", { value: init.pointerId });
    Object.defineProperty(event, "button", { value: init.button ?? 0 });
    Object.defineProperty(event, "buttons", { value: init.buttons ?? 1 });
    fireEvent(target, event);
  }

  it("does not compound drag offset when a transformed group rect is measured without its transform", async () => {
    if (!HTMLElement.prototype.setPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
        configurable: true,
        value: vi.fn(),
      });
    }
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const group = this.matches("[data-chat-project-id]")
        ? this
        : this.closest<HTMLElement>("[data-chat-project-id]");
      if (group) {
        const groups = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-project-id]"));
        const index = Math.max(0, groups.indexOf(group));
        const top = 100 + index * 64;
        return rect(top, this.matches("[data-chat-project-label-id]") ? 28 : 56);
      }
      return rect(0, 0);
    });

    renderProjectDragSidebar();
    const alphaLabel = screen.getByRole("heading", { name: "Alpha, 1 chats" })
      .closest<HTMLElement>("[data-chat-project-label-id]")!;
    const alphaGroup = document.querySelector<HTMLElement>("[data-chat-project-id='project-a']")!;

    act(() => {
      fireProjectPointer(alphaLabel, "pointerdown", { button: 0, buttons: 1, clientX: 12, clientY: 110, pointerId: 9 });
    });
    act(() => {
      fireProjectPointer(document, "pointermove", { buttons: 1, clientX: 12, clientY: 140, pointerId: 9 });
    });

    await waitFor(() => expect(alphaGroup.style.transform).toBe("translateY(30px)"));

    act(() => {
      fireProjectPointer(document, "pointermove", { buttons: 1, clientX: 12, clientY: 150, pointerId: 9 });
    });

    await waitFor(() => expect(alphaGroup.style.transform).toBe("translateY(40px)"));
  });

  it("moves a project to the top when one of its conversations becomes the latest", async () => {
    const onReorderProjects = vi.fn(async () => undefined);
    const initialSessions = projects.map((project, index) => ({
      ...makeSession(project.id),
      id: "activity-chat-" + index,
      title: project.name + " activity",
      updatedAt: 100 - index,
    }));
    const { rerender } = render(
      <ChatSidebar
        sessions={initialSessions}
        projects={projects}
        currentId="activity-chat-0"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    expect(onReorderProjects).not.toHaveBeenCalled();

    rerender(
      <ChatSidebar
        sessions={initialSessions.map((session) => (
          session.projectId === "project-c" ? { ...session, updatedAt: 200 } : session
        ))}
        projects={projects}
        currentId="activity-chat-0"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    await waitFor(() => expect(onReorderProjects).toHaveBeenCalledWith([
      "project-c",
      "project-a",
      "project-b",
    ]));
  });

  it("uses initial session hydration as a baseline instead of overriding manual order", async () => {
    const onReorderProjects = vi.fn(async () => undefined);
    const hydratedSessions = projects.map((project, index) => ({
      ...makeSession(project.id),
      id: "hydrated-chat-" + index,
      title: project.name + " hydrated",
      updatedAt: 300 - index,
    }));
    const { rerender } = render(
      <ChatSidebar
        sessions={[]}
        projects={[projects[2], projects[0], projects[1]]}
        currentId=""
        open
        busy={false}
        sessionsHydrated={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    rerender(
      <ChatSidebar
        sessions={hydratedSessions}
        projects={[projects[2], projects[0], projects[1]]}
        currentId="hydrated-chat-0"
        open
        busy={false}
        sessionsHydrated
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    await act(async () => undefined);
    expect(onReorderProjects).not.toHaveBeenCalled();
  });

  it("keeps a manually supplied project order until conversation activity changes", async () => {
    const onReorderProjects = vi.fn(async () => undefined);
    const manualProjects = [projects[2], projects[0], projects[1]];
    const manualSessions = projects.map((project, index) => ({
      ...makeSession(project.id),
      id: "manual-chat-" + index,
      title: project.name + " manual",
      updatedAt: 300 - index,
    }));

    const { container, rerender } = render(
      <ChatSidebar
        sessions={manualSessions}
        projects={manualProjects}
        currentId="manual-chat-0"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    const renderedProjectIds = () => Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-project-id]"),
      (element) => element.dataset.chatProjectId,
    );
    expect(renderedProjectIds()).toEqual(["project-c", "project-a", "project-b"]);
    expect(onReorderProjects).not.toHaveBeenCalled();

    rerender(
      <ChatSidebar
        sessions={manualSessions}
        projects={[projects[1], projects[2], projects[0]]}
        currentId="manual-chat-0"
        open
        busy={false}
        onClose={() => undefined}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onTogglePinned={() => undefined}
        onDelete={() => undefined}
        onReorderProjects={onReorderProjects}
      />,
    );

    expect(renderedProjectIds()).toEqual(["project-b", "project-c", "project-a"]);
    await act(async () => undefined);
    expect(onReorderProjects).not.toHaveBeenCalled();
  });
});

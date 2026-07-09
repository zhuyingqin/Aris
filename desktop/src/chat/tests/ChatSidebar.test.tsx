// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../types";
import { useStore } from "../../store";
import ChatSidebar from "../ChatSidebar";
import { makeSession } from "../model";

beforeEach(() => {
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

  it("shows the first five chats and collapses the rest in large project groups", async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      ...makeSession("project-a"),
      id: `chat-${index + 1}`,
      title: `Topic ${index + 1}`,
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
    const toggle = screen.getByRole("button", { name: "Alpha, 6 chats, collapsed" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);

    expect(screen.getByText("Topic 6")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alpha, 6 chats, expanded" }).getAttribute("aria-expanded")).toBe("true");
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
    const alphaToggle = screen.getByRole("button", { name: "Alpha, 1 chats, expanded" });
    const alphaLabel = alphaToggle.closest<HTMLElement>("[data-chat-project-label-id]")!;
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
});

// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatCommandSelection, ChatTurn, DesktopCommandSpec, SkillMeta } from "../types";
import ChatComposer, { attachmentFromFile, resizeComposerTextarea } from "./ChatComposer";
import { diffFromTool } from "./ChatMessage";
import CommandSelection from "./CommandSelection";
import { isNearBottom } from "./ChatThread";
import { makeId } from "./model";
import { appendToolOutput } from "./useChatStream";
import { useChatSessions } from "./useChatSessions";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Chat interaction helpers", () => {
  it("caps composer auto-growth and enables textarea scrolling", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 240 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ maxHeight: "100px" } as CSSStyleDeclaration);

    resizeComposerTextarea(textarea);

    expect(textarea.style.height).toBe("100px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("only follows streaming output while the reader is near the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 })).toBe(false);
  });

  it("creates a readable diff for file edit tools", () => {
    const change = diffFromTool({
      kind: "tool",
      name: "edit_file",
      input: JSON.stringify({ path: "src/a.ts", old_string: "old", new_string: "new" }),
      output: "ok",
    });
    expect(change?.diff).toContain("-old");
    expect(change?.diff).toContain("+new");
  });

  it("omits dropped binary bodies without reading them into the renderer", async () => {
    const file = new File(["binary"], "archive.zip", { type: "application/zip" });
    const text = vi.fn();
    Object.defineProperty(file, "text", { configurable: true, value: text });

    const attachment = await attachmentFromFile(file);

    expect(text).not.toHaveBeenCalled();
    expect(attachment.content).toContain("Binary file content omitted");
  });

  it("matches tool results by call id before tool name", () => {
    const blocks = [
      { kind: "tool" as const, id: "first", name: "read_file", input: "{}" },
      { kind: "tool" as const, id: "second", name: "read_file", input: "{}" },
    ];

    const next = appendToolOutput(blocks, "first", "read_file", "first output", false);

    expect(next[0]).toMatchObject({ id: "first", output: "first output" });
    expect(next[1]).not.toHaveProperty("output");
  });
});

describe("useChatSessions", () => {
  it("retains a draft per session", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    const first = result.current.currentId;
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "hello" }] };

    act(() => {
      result.current.setDraft(first, "first draft");
      result.current.patchTurns(first, () => [turn]);
    });
    let second = "";
    act(() => {
      second = result.current.newSession();
      result.current.setCurrentId(second);
    });
    act(() => result.current.setDraft(second, "second draft"));
    act(() => result.current.setCurrentId(first));

    expect(result.current.currentSession?.draft).toBe("first draft");
    act(() => result.current.setCurrentId(second));
    expect(result.current.currentSession?.draft).toBe("second draft");
  });

  it("does not create duplicate blank sessions", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    const count = result.current.sessions.length;
    const existing = result.current.currentId;
    let created = "";

    act(() => {
      created = result.current.newSession();
    });

    expect(created).toBe(existing);
    expect(result.current.sessions).toHaveLength(count);
  });

  it("preserves an unsent draft when New chat opens another session", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    const first = result.current.currentId;
    let second = "";

    act(() => result.current.setDraft(first, "keep this draft"));
    act(() => {
      second = result.current.newSession();
      result.current.setCurrentId(second);
    });

    expect(second).not.toBe(first);
    expect(result.current.sessions.find((session) => session.id === first)?.draft).toBe("keep this draft");
  });

  it("restores a removed session for delete undo", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    const id = result.current.currentId;
    let removed = result.current.currentSession;

    act(() => {
      removed = result.current.removeSession(id);
    });
    expect(result.current.sessions.some((session) => session.id === id)).toBe(false);
    act(() => {
      if (removed) result.current.restoreSession(removed);
    });
    expect(result.current.sessions.some((session) => session.id === id)).toBe(true);
  });
});

const SKILLS: SkillMeta[] = [
  { name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" },
  { name: "review", description: "Review code", path: "review/SKILL.md" },
];

function ComposerHarness({
  commands = [],
  skills = SKILLS,
  onSubmit = () => undefined,
}: {
  commands?: DesktopCommandSpec[];
  skills?: SkillMeta[];
  onSubmit?: () => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  return (
    <ChatComposer
      input={input}
      commands={commands}
      skills={skills}
      attachments={attachments}
      busy={false}
      ready
      editing={false}
      onInputChange={setInput}
      onAttachmentsChange={setAttachments}
      onSubmit={onSubmit}
      onStop={() => undefined}
      onCancelEdit={() => undefined}
      onHeightChange={() => undefined}
    />
  );
}

describe("ChatComposer picker keyboard operation", () => {
  it("selects a fuzzy-matched slash skill with Enter", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/ppln");
    await user.keyboard("{Enter}");

    expect((textbox as HTMLTextAreaElement).value).toBe("/paper-plan ");
  });

  it("submits an exact built-in slash command with Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ComposerHarness
        onSubmit={onSubmit}
        commands={[
          {
            name: "model",
            description: "Show or switch model",
          },
        ]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/model");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledOnce();
    expect((textbox as HTMLTextAreaElement).value).toBe("/model");
  });

  it("submits an unmatched slash command instead of trapping Enter in the picker", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} commands={[]} skills={[]} />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/some-custom-command");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("groups desktop commands separately from skills", async () => {
    const user = userEvent.setup();
    render(
      <ComposerHarness
        commands={[
          {
            name: "help",
            description: "Show commands",
          },
        ]}
        skills={[{ name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" }]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/");

    const picker = screen.getByRole("listbox");
    expect(within(picker).getByText("Slash menu")).toBeTruthy();
    expect(within(picker).getByText("System commands")).toBeTruthy();
    expect(within(picker).getByText("All skills")).toBeTruthy();
  });

  it("scrolls the active picker item into view when arrowing", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <ComposerHarness
        commands={[
          { name: "help", description: "Show commands" },
          { name: "model", description: "Switch model" },
        ]}
        skills={[{ name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" }]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/");
    scrollIntoView.mockClear();
    await user.keyboard("{ArrowDown}");

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("attaches a recent @ file with Enter instead of inserting its body", async () => {
    localStorage.setItem("aris-chat-recent-files", JSON.stringify(["src/chat/Chat.tsx"]));
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "@Chat");
    await user.keyboard("{Enter}");

    expect((textbox as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Chat.tsx")).toBeTruthy();
  });
});

describe("CommandSelection", () => {
  const selection: ChatCommandSelection = {
    command: "model",
    title: "Select executor model",
    subtitle: "Provider: anthropic",
    current: "claude-opus-4-7",
    items: [
      {
        value: "claude-opus-4-7",
        label: "claude-opus-4-7",
        description: "Current model",
        isCurrent: true,
      },
      {
        value: "claude-sonnet-4-6",
        label: "claude-sonnet-4-6",
        description: "Everyday model",
        isCurrent: false,
      },
    ],
  };

  it("selects an option with keyboard navigation and keeps the active item in view", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <CommandSelection
        selection={selection}
        bottomOffset={120}
        onSelect={onSelect}
        onCancel={() => undefined}
      />,
    );

    const listbox = screen.getByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(document.activeElement).toBe(listbox);
    expect(listbox.getAttribute("aria-activedescendant")).toContain("option-1");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("claude-sonnet-4-6");
  });
});

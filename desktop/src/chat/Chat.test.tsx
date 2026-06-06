// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatTurn, SkillMeta } from "../types";
import ChatComposer, { resizeComposerTextarea } from "./ChatComposer";
import { diffFromTool } from "./ChatMessage";
import { isNearBottom } from "./ChatThread";
import { makeId } from "./model";
import { useChatSessions } from "./useChatSessions";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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

function ComposerHarness() {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  return (
    <ChatComposer
      input={input}
      skills={SKILLS}
      attachments={attachments}
      busy={false}
      ready
      editing={false}
      onInputChange={setInput}
      onAttachmentsChange={setAttachments}
      onSubmit={() => undefined}
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

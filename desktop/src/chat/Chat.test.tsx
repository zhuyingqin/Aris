// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatCommandSelection, ChatTurn, DesktopCommandSpec, DesktopProject, SkillMeta } from "../types";
import ChatComposer, { attachmentFromFile, resizeComposerTextarea } from "./ChatComposer";
import ChatMessage, { diffFromTool } from "./ChatMessage";
import CommandSelection from "./CommandSelection";
import { isNearBottom } from "./ChatThread";
import {
  CURRENT_KEY,
  SESSIONS_KEY,
  fuzzyScore,
  groupSessionsByProject,
  makeId,
  makeSession,
  migrateSession,
  transcriptFromTurn,
} from "./model";
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

  it("keeps a dragged Tauri PDF as a readable path attachment", async () => {
    const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "path", { configurable: true, value: "C:\\Project\\paper.pdf" });

    const attachment = await attachmentFromFile(file);

    expect(attachment.path).toBe("C:\\Project\\paper.pdf");
    expect(attachment.content).toBeUndefined();
    expect(attachment.name).toBe("paper.pdf");
  });

  it("keeps image previews out of the prompt body", async () => {
    const file = new File(["fake-png"], "shot.png", { type: "image/png" });

    const attachment = await attachmentFromFile(file);

    expect(attachment.kind).toBe("image");
    expect(attachment.preview).toMatch(/^data:image\/png;base64,/);
    expect(attachment.content).toContain("Vision input is not supported");
    expect(attachment.content).not.toMatch(/^data:/);
  });

  it("scores direct slash-style abbreviations above weak subsequence matches", () => {
    const literature = fuzzyScore("lit", "research-lit literature paper search");
    const weak = fuzzyScore("lit", "utility cleanup");

    expect(literature).not.toBeNull();
    expect(weak).not.toBeNull();
    expect(literature ?? 999).toBeLessThan(weak ?? 999);
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

  it("falls back to the latest matching tool name when a result id is stale", () => {
    const blocks = [
      { kind: "tool" as const, id: "first", name: "read_file", input: "{}" },
      { kind: "tool" as const, id: "second", name: "read_file", input: "{}" },
    ];

    const next = appendToolOutput(blocks, "missing", "read_file", "latest output", false);

    expect(next[0]).not.toHaveProperty("output");
    expect(next[1]).toMatchObject({ id: "second", output: "latest output" });
  });

  it("serializes assistant tool blocks for retry context", () => {
    const turn: ChatTurn = {
      id: "assistant-1",
      role: "assistant",
      blocks: [
        { kind: "text", text: "I checked the file." },
        { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
      ],
    };

    const transcript = transcriptFromTurn(turn);

    expect(transcript).toContain("I checked the file.");
    expect(transcript).toContain("[Tool call: read_file (tool-1)]");
    expect(transcript).toContain("README body");
  });

  it("renders an empty assistant response instead of a blank bubble", () => {
    render(
      <ChatMessage
        turn={{ id: "assistant-empty", role: "assistant", blocks: [] }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("Model returned an empty response.")).toBeTruthy();
  });
});

describe("useChatSessions", () => {
  it("opens a blank new-chat home instead of restoring saved history on startup", async () => {
    const old = makeSession("default");
    old.id = "old-chat";
    old.title = "Old chat";
    old.createdAt = 1;
    old.updatedAt = 1;
    old.turns = [{ id: "old-turn", role: "user", blocks: [{ kind: "text", text: "old" }] }];
    const recent = makeSession("default");
    recent.id = "recent-chat";
    recent.title = "Recent chat";
    recent.createdAt = 2;
    recent.updatedAt = 2;
    recent.turns = [{ id: "recent-turn", role: "user", blocks: [{ kind: "text", text: "recent" }] }];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([old, recent]));
    localStorage.setItem(CURRENT_KEY, old.id);

    const { result } = renderHook(() => useChatSessions());

    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    expect(result.current.currentSession?.turns).toHaveLength(0);
    expect(result.current.currentSession?.title).toBe("New chat");
    expect(result.current.currentId).not.toBe(old.id);
    expect(result.current.currentId).not.toBe(recent.id);
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.some((session) => session.id === old.id)).toBe(true);
    expect(result.current.sessions.some((session) => session.id === recent.id)).toBe(true);
  });

  it("retains a draft per session", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    let first = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "hello" }] };

    act(() => {
      first = result.current.materializeCurrentSession()?.id ?? "";
    });
    await waitFor(() => expect(result.current.currentId).toBe(first));
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

  it("clears the transient home draft when New chat is pressed again", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());

    act(() => result.current.setDraft(result.current.currentId, "discard this draft"));
    expect(result.current.currentSession?.draft).toBe("discard this draft");
    act(() => {
      result.current.newSession();
    });

    expect(result.current.currentSession?.draft).toBe("");
    expect(result.current.sessions).toHaveLength(0);
  });

  it("restores a removed session for delete undo", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    let id = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "hello" }] };
    act(() => {
      id = result.current.materializeCurrentSession()?.id ?? "";
    });
    act(() => {
      result.current.patchTurns(id, () => [turn]);
    });
    await waitFor(() => expect(result.current.sessions.some((session) => session.id === id)).toBe(true));
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

  it("keeps chats isolated when switching projects", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useChatSessions(projectId),
      { initialProps: { projectId: "project-a" } },
    );
    await waitFor(() => expect(result.current.currentSession?.projectId).toBe("project-a"));
    let first = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "project a" }] };
    act(() => {
      first = result.current.materializeCurrentSession()?.id ?? "";
    });
    act(() => {
      result.current.patchTurns(first, () => [turn]);
    });

    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.currentSession?.projectId).toBe("project-b"));

    expect(result.current.currentId).not.toBe(first);
    expect(result.current.allSessions.some((session) => session.projectId === "project-a")).toBe(true);
  });
});

describe("project chat grouping", () => {
  const projects: DesktopProject[] = [
    { id: "project-a", name: "Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 2 },
    { id: "project-b", name: "Beta", path: "C:/Beta", addedAt: 1, lastOpenedAt: 1 },
  ];

  it("migrates legacy chats to the default project", () => {
    expect(migrateSession({ title: "Legacy" }).projectId).toBe("default");
  });

  it("groups chats by project instead of date", () => {
    const alpha = { ...makeSession("project-a"), title: "Alpha chat" };
    const beta = { ...makeSession("project-b"), title: "Beta chat" };

    const groups = groupSessionsByProject([beta, alpha], projects);

    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta"]);
    expect(groups[0].sessions[0].projectId).toBe("project-a");
  });
});

const SKILLS: SkillMeta[] = [
  { name: "paper-plan", description: "Plan a paper", path: "paper-plan/SKILL.md" },
  { name: "review", description: "Review code", path: "review/SKILL.md" },
];

function ComposerHarness({
  commands = [],
  skills = SKILLS,
  sendBlocked = false,
  onSubmit = () => undefined,
}: {
  commands?: DesktopCommandSpec[];
  skills?: SkillMeta[];
  sendBlocked?: boolean;
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
      sendBlocked={sendBlocked}
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
  it("keeps the draft editable while another chat is running", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness sendBlocked onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(textbox, "draft for later");

    expect(textbox.disabled).toBe(false);
    expect(textbox.value).toBe("draft for later");
    const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("selects a fuzzy-matched slash skill with Enter", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/ppln");
    await user.keyboard("{Enter}");

    expect((textbox as HTMLTextAreaElement).value).toBe("/paper-plan ");
  });

  it("surfaces literature skills for /lit", async () => {
    const user = userEvent.setup();
    render(
      <ComposerHarness
        skills={[
          { name: "utility-cleanup", description: "General maintenance helpers", path: "utility-cleanup/SKILL.md" },
          { name: "research-lit", description: "Search and analyze research papers", path: "research-lit/SKILL.md" },
          { name: "comm-lit-review", description: "Communications-domain literature review", path: "comm-lit-review/SKILL.md" },
        ]}
      />,
    );
    const textbox = screen.getByRole("textbox");

    await user.type(textbox, "/lit");

    const picker = screen.getByRole("listbox");
    const names = within(picker).getAllByText(/^\/.+/).map((item) => item.textContent);
    expect(names.slice(0, 2)).toEqual(["/comm-lit-review", "/research-lit"]);
    expect(within(picker).getByText("/research-lit")).toBeTruthy();
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

  it("attaches an uploaded image with a preview", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);

    const fileInput = screen.getByTestId("chat-file-input") as HTMLInputElement;
    const clickInput = vi.spyOn(fileInput, "click");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(clickInput).toHaveBeenCalledOnce();

    const file = new File(["fake-png"], "shot.png", { type: "image/png" });
    await user.upload(fileInput, file);

    expect(await screen.findByText("shot.png")).toBeTruthy();
    const preview = await screen.findByRole("img", { name: "shot.png" });
    expect((preview as HTMLImageElement).src).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
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

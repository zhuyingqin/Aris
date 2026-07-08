// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatCommandSelection, ChatTurn, DesktopCommandSpec, DesktopProject, SkillMeta } from "../types";
import ChatComposer, { attachmentFromFile, resizeComposerTextarea } from "./ChatComposer";
import ChatMessage, { diffFromTool } from "./ChatMessage";
import { completedAssistantBlocks, contextForRetry, continueStoppedPrompt, needsBackendContextReset, visibleTurnError } from "./Chat";
import ChatSidebar from "./ChatSidebar";
import CommandSelection from "./CommandSelection";
import {
  activeQuestionNumber,
  firstVisibleTurnIndexFromVirtualItems,
  isNearBottom,
  isScrollbarPointer,
  questionMarkersFromTurns,
  questionPreviewFromTurn,
  shouldIgnoreProgrammaticFollowScroll,
  shouldPauseAutoFollowForWheel,
} from "./ChatThread";
import {
  CURRENT_KEY,
  SESSIONS_KEY,
  cleanChatTitle,
  fuzzyScore,
  groupSessionsByProject,
  makeId,
  makeSession,
  migrateSession,
  patchLastAssistantTurn,
  titleFromTurns,
  transcriptFromTurn,
} from "./model";
import { appendToolOutput, upsertToolCall } from "./useChatStream";
import { useChatSessions } from "./useChatSessions";
import { useStore } from "../store";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ tab: "chat", pendingStudioArtifactId: null });
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

  it("pauses auto-follow as soon as the reader scrolls upward", () => {
    expect(shouldPauseAutoFollowForWheel(-1)).toBe(true);
    expect(shouldPauseAutoFollowForWheel(1)).toBe(false);
  });

  it("detects pointer starts in the scrollbar gutter", () => {
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      top: 0,
      right: 300,
      bottom: 400,
      left: 0,
      width: 300,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    } as DOMRect);

    expect(isScrollbarPointer(element, 288)).toBe(true);
    expect(isScrollbarPointer(element, 240)).toBe(false);
  });

  it("ignores scroll events caused by programmatic bottom-following", () => {
    expect(shouldIgnoreProgrammaticFollowScroll(180, 100, true)).toBe(true);
    expect(shouldIgnoreProgrammaticFollowScroll(180, 220, true)).toBe(false);
    expect(shouldIgnoreProgrammaticFollowScroll(180, 100, false)).toBe(false);
  });

  it("builds a compact timeline from user questions only", () => {
    const turns: ChatTurn[] = [
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "First question" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "Second question\nwith details" }] },
    ];

    expect(questionMarkersFromTurns(turns)).toEqual([
      { id: "u1", turnIndex: 0, number: 1, preview: "First question" },
      { id: "u2", turnIndex: 2, number: 2, preview: "Second question with details" },
    ]);
  });

  it("summarizes long or attachment-only questions for the hover list", () => {
    expect(questionPreviewFromTurn({
      id: "long",
      role: "user",
      blocks: [{ kind: "text", text: "a".repeat(52) }],
    })).toBe(`${"a".repeat(48)}...`);
    expect(questionPreviewFromTurn({
      id: "attachment",
      role: "user",
      blocks: [],
      attachments: [{ id: "att-1", kind: "file", name: "notes.md" }],
    })).toBe("附件：notes.md");
    expect(questionPreviewFromTurn({
      id: "attached-context",
      role: "user",
      blocks: [{ kind: "text", text: "Attached context" }],
      attachments: [{ id: "att-2", kind: "file", name: "brief.md" }],
    })).toBe("附件：brief.md");
  });

  it("keeps the active question aligned to the first visible turn", () => {
    const markers = questionMarkersFromTurns([
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "First" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "Second" }] },
      { id: "a2", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u3", role: "user", blocks: [{ kind: "text", text: "Third" }] },
    ]);

    expect(activeQuestionNumber(markers, 0)).toBe(1);
    expect(activeQuestionNumber(markers, 1)).toBe(1);
    expect(activeQuestionNumber(markers, 2)).toBe(2);
    expect(activeQuestionNumber(markers, 99)).toBe(3);
    expect(activeQuestionNumber([], 0)).toBeNull();
  });

  it("derives the visible turn from real scroll position instead of overscan", () => {
    const items = [
      { index: 0, start: 0, size: 120 },
      { index: 1, start: 120, size: 180 },
      { index: 2, start: 300, size: 160 },
      { index: 3, start: 460, size: 220 },
    ];

    expect(firstVisibleTurnIndexFromVirtualItems(items, 0)).toBe(0);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 126)).toBe(1);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 300)).toBe(2);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 900)).toBe(3);
    expect(firstVisibleTurnIndexFromVirtualItems([], 300)).toBe(0);
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

  it("creates a readable diff for append_file chunks", () => {
    const change = diffFromTool({
      kind: "tool",
      name: "append_file",
      input: JSON.stringify({ path: "slides/chapter3.tex", content: "\\begin{frame}\nbody\n\\end{frame}\n" }),
      output: JSON.stringify({ type: "append", filePath: "slides/chapter3.tex", created: false }),
    });
    expect(change?.path).toBe("slides/chapter3.tex");
    expect(change?.diff).toContain("+\\begin{frame}");
    expect(change?.diff).toContain("+\\end{frame}");
  });

  it("prefers Codex-style file changes from tool output", () => {
    const change = diffFromTool({
      kind: "tool",
      name: "edit_file",
      input: JSON.stringify({ path: "src/a.ts", old_string: "old", new_string: "new" }),
      output: JSON.stringify({
        changes: {
          "src/a.ts": {
            type: "update",
            unified_diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        },
      }),
    });
    expect(change).toEqual({
      path: "src/a.ts",
      diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    });
  });

  it("renders generated file paths as openable links", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-file",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "write_file",
            input: JSON.stringify({ path: "reports/result.md", content: "done" }),
            output: "ok",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "reports/result.md" })).toBeTruthy();
  });

  it("renders sent image attachments as image previews", () => {
    render(
      <ChatMessage
        turn={{
          id: "user-image",
          role: "user",
          blocks: [{ kind: "text", text: "see attached" }],
          attachments: [{
            id: "att-image",
            kind: "image",
            name: "shot.png",
            preview: "data:image/png;base64,ZmFrZQ==",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    const image = screen.getByRole("img", { name: "shot.png" }) as HTMLImageElement;
    expect(image.src).toContain("data:image/png;base64,ZmFrZQ==");
    expect(screen.queryByText(/shot\.png$/)).toBeNull();
  });

  it("renders image paths mentioned by tool output as previews", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-tool-image",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "run_experiment",
            input: "{}",
            output: "saved figure to https://example.com/results/plot.png",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    const image = screen.getByRole("img", { name: "https://example.com/results/plot.png" }) as HTMLImageElement;
    expect(image.src).toBe("https://example.com/results/plot.png");
  });

  it("renders assistant Markdown file references as local links", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-link",
          role: "assistant",
          blocks: [{ kind: "text", text: "Open [the report](reports/result.md)." }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByRole("link", { name: "the report" }).getAttribute("title")).toBe("Open local file");
  });

  it("renders a direct Studio entry after artifact registration", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessage
        turn={{
          id: "assistant-studio",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "StudioLibraryUpsert",
            input: "{}",
            output: JSON.stringify({
              studioLinks: [{
                id: "web:irl-demo",
                title: "IRL demo",
                href: "studio/artifact/web%3Airl-demo",
              }],
            }),
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open IRL demo in Studio" }));

    expect(useStore.getState().tab).toBe("studio");
    expect(useStore.getState().pendingStudioArtifactId).toBe("web:irl-demo");
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

  it("creates a fallback tool card when a result arrives without its call event", () => {
    const next = appendToolOutput([], "tool-1", "read_file", "late output", true);

    expect(next).toEqual([{
      kind: "tool",
      id: "tool-1",
      name: "read_file",
      input: "{}",
      output: "late output",
      isError: true,
    }]);
  });

  it("does not duplicate repeated tool results after output is attached", () => {
    const blocks = [
      { kind: "tool" as const, id: "tool-1", name: "read_file", input: "{}", output: "first output" },
    ];

    const next = appendToolOutput(blocks, "tool-1", "read_file", "first output", false);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "tool-1", output: "first output" });
  });

  it("updates an existing tool card when the same tool call is emitted again", () => {
    const blocks = [
      { kind: "tool" as const, id: "ask-1", name: "AskUserQuestion", input: "{\"question\":\"Old?\"}" },
    ];

    const next = upsertToolCall(blocks, {
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"Yes\"}]}",
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"Yes\"}]}",
    });
  });

  it("creates a streaming assistant turn when an event arrives before one exists", () => {
    const next = patchLastAssistantTurn(
      [{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "Pick one" }] }],
      (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: "tool",
            id: "ask-1",
            name: "AskUserQuestion",
            input: "{\"question\":\"Continue?\",\"options\":[{\"label\":\"Yes\"}]}",
          },
        ],
      }),
    );

    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "tool", id: "ask-1", name: "AskUserQuestion" }],
    });
  });

  it("serializes assistant tool blocks for exported transcripts", () => {
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

  it("rebuilds stopped assistant turns into backend context with tool activity", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Read README" }] },
      {
        id: "assistant-1",
        role: "assistant",
        stopped: true,
        blocks: [
          { kind: "text", text: "I checked the file." },
          { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", text: "Read README", images: [] },
      {
        role: "assistant",
        text: "I checked the file.",
        toolCalls: [{ id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "tool",
        toolResults: [{ toolUseId: "tool-1", toolName: "read_file", output: "README body", isError: false }],
      },
    ]);
  });

  it("rebuilds completed assistant turns with their tool activity, not text alone", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Read README" }] },
      {
        id: "assistant-1",
        role: "assistant",
        blocks: [
          { kind: "text", text: "I checked the file." },
          { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", text: "Read README", images: [] },
      {
        role: "assistant",
        text: "I checked the file.",
        toolCalls: [{ id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "tool",
        toolResults: [{ toolUseId: "tool-1", toolName: "read_file", output: "README body", isError: false }],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("[Tool call:");
  });

  it("still drops in-flight and failed turns from backend context", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Do it" }] },
      { id: "a-streaming", role: "assistant", streaming: true, blocks: [{ kind: "text", text: "partial" }] },
      {
        id: "a-error",
        role: "assistant",
        error: "boom",
        blocks: [
          { kind: "text", text: "failed partial answer" },
          {
            kind: "tool",
            id: "tool-failed",
            name: "read_file",
            input: "{\"path\":\"missing.md\"}",
            output: "read_file failed with stale context",
            isError: true,
          },
        ],
      },
    ]);

    expect(messages).toEqual([{ role: "user", text: "Do it", images: [] }]);
    expect(JSON.stringify(messages)).not.toContain("failed partial answer");
    expect(JSON.stringify(messages)).not.toContain("tool-failed");
    expect(JSON.stringify(messages)).not.toContain("stale context");
  });

  it("continue prompt points at the rebuilt context without embedding the partial", () => {
    const prompt = continueStoppedPrompt();

    expect(prompt).toContain("Continue from where you stopped.");
    expect(prompt).toContain("already in the conversation above");
    expect(prompt).toContain("Do not repeat");
    // No partial text is embedded (and therefore never truncated at 12k).
    expect(prompt).not.toContain("Partial stopped response:");
  });

  it("requires backend context reset when rerunning from an earlier turn", () => {
    const current: ChatTurn[] = [
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "first" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "answer one" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "second" }] },
      { id: "a2", role: "assistant", blocks: [{ kind: "text", text: "answer two" }] },
    ];

    expect(needsBackendContextReset(current, current)).toBe(false);
    expect(needsBackendContextReset(current, current.slice(0, 2))).toBe(true);
    expect(needsBackendContextReset(current, [
      current[0],
      { id: "different", role: "assistant", blocks: [{ kind: "text", text: "rewritten" }] },
      current[2],
      current[3],
    ])).toBe(true);
    expect(needsBackendContextReset(current, current, true)).toBe(true);
    expect(needsBackendContextReset(
      [
        current[0],
        { ...current[1], stopped: true },
      ],
      [
        current[0],
        { ...current[1], stopped: true },
      ],
    )).toBe(true);
    expect(needsBackendContextReset(
      [
        current[0],
        { ...current[1], error: "provider failed" },
      ],
      [
        current[0],
        { ...current[1], error: "provider failed" },
      ],
    )).toBe(true);
  });

  it("hides expected cancel errors but preserves real failures after stop", () => {
    expect(visibleTurnError("interrupted by user", true)).toBeUndefined();
    expect(visibleTurnError("MCP request interrupted by user", true)).toBeUndefined();
    expect(visibleTurnError("provider stream error after partial output", true))
      .toBe("provider stream error after partial output");
    expect(visibleTurnError("provider stream error", false)).toBe("provider stream error");
  });

  it("promotes thinking-only completed output to visible text", () => {
    const blocks = completedAssistantBlocks({
      id: "assistant-thinking-only",
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "thinking", thinking: "Final answer was streamed as reasoning_content." }],
    }, "");

    expect(blocks).toEqual([
      { kind: "text", text: "Final answer was streamed as reasoning_content." },
    ]);
  });

  it("keeps a real final reply visible after streamed thinking", () => {
    const blocks = completedAssistantBlocks({
      id: "assistant-thinking-reply",
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "thinking", thinking: "private reasoning" }],
    }, "Visible final answer.");

    expect(blocks).toEqual([
      { kind: "thinking", thinking: "private reasoning" },
      { kind: "text", text: "Visible final answer." },
    ]);
  });

  it("renders stopped turns as stopped instead of empty responses", () => {
    render(
      <ChatMessage
        turn={{ id: "assistant-stopped", role: "assistant", blocks: [], stopped: true }}
        canRetry
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("Response stopped")).toBeTruthy();
    expect(screen.queryByText("Model returned an empty response.")).toBeNull();
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

  it("offers to load omitted saved turns from the notice", async () => {
    const user = userEvent.setup();
    const onLoadOmittedTurn = vi.fn();
    render(
      <ChatMessage
        turn={{
          id: "chat-large-turn-1",
          role: "assistant",
          omittedTurnIndex: 1,
          omittedBytes: 596_000,
          blocks: [{
            kind: "notice",
            message: "A large saved turn was omitted from the quick preview.",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onLoadOmittedTurn={onLoadOmittedTurn}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load full turn" }));

    expect(onLoadOmittedTurn).toHaveBeenCalledWith(1);
  });

  it("keeps streamed thinking from splitting assistant Markdown text", () => {
    const { container } = render(
      <ChatMessage
        turn={{
          id: "assistant-mixed-thinking",
          role: "assistant",
          blocks: [
            { kind: "text", text: "## 直接验证\n\n" },
            { kind: "thinking", thinking: "这里是中途 reasoning，不应该插入正文。" },
            { kind: "text", text: "FINAL_JSON: | X | 最终会出现 |\n\n```text\n样本 | X | 是否能看到\n```" },
          ],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("这里是中途 reasoning，不应该插入正文。")).toBeTruthy();
    expect(container.querySelector(".md-think")).toBeTruthy();
    expect(container.querySelector("h2")?.textContent).toBe("直接验证");
    expect(container.querySelector(".md-code-block")?.textContent).toContain("样本 | X | 是否能看到");
  });
});

describe("AskUserQuestion card", () => {
  const questionBlock = (overrides: Record<string, unknown> = {}) => ({
    kind: "tool" as const,
    id: "ask-1",
    name: "AskUserQuestion",
    input: JSON.stringify({
      question: "Which database?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Relational" },
        { label: "SQLite", description: "Embedded" },
      ],
      ...overrides,
    }),
  });

  const questionTurn = (
    block: ReturnType<typeof questionBlock> & { output?: string },
    streaming = true,
  ): ChatTurn => ({ id: "assistant-q", role: "assistant", streaming, blocks: [block] });

  const renderQuestion = (
    turn: ChatTurn,
    onQuestionRespond: (toolUseId: string, answer: string) => void = () => undefined,
  ) =>
    render(
      <ChatMessage
        turn={turn}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onQuestionRespond={onQuestionRespond}
      />,
    );

  it("submits the chosen option label for a single-select question", async () => {
    const user = userEvent.setup();
    const onQuestionRespond = vi.fn();
    renderQuestion(questionTurn(questionBlock()), onQuestionRespond);

    expect(screen.getByText("Which database?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Postgres/ }));

    expect(onQuestionRespond).toHaveBeenCalledWith("ask-1", "Postgres");
  });

  it("joins selected labels for a multi-select question", async () => {
    const user = userEvent.setup();
    const onQuestionRespond = vi.fn();
    renderQuestion(questionTurn(questionBlock({ multiSelect: true })), onQuestionRespond);

    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    await user.click(screen.getByRole("button", { name: /SQLite/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onQuestionRespond).toHaveBeenCalledWith("ask-1", "Postgres, SQLite");
  });

  it("shows the recorded answer once the tool result arrives", () => {
    renderQuestion(questionTurn({ ...questionBlock(), output: "Postgres" }, false));

    expect(screen.getByText("You answered")).toBeTruthy();
    expect(screen.getByText("Postgres")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Postgres/ })).toBeNull();
  });

  it("locks the question when the turn is no longer streaming", () => {
    const onQuestionRespond = vi.fn();
    renderQuestion(questionTurn(questionBlock(), false), onQuestionRespond);

    expect(screen.getByText("This question is no longer awaiting an answer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Postgres/ })).toBeNull();
    expect(onQuestionRespond).not.toHaveBeenCalled();
  });
});

describe("useChatSessions", () => {
  it("restores the last active chat and keeps saved sessions in history", async () => {
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

    await waitFor(() => expect(result.current.currentId).toBe(old.id));
    expect(result.current.currentSession?.title).toBe("Old chat");
    expect(result.current.currentSession?.turns).toHaveLength(1);
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.some((session) => session.id === old.id)).toBe(true);
    expect(result.current.sessions.some((session) => session.id === recent.id)).toBe(true);
  });

  it("falls back to the most recently updated chat when no current id is saved", async () => {
    const old = makeSession("default");
    old.id = "old-chat";
    old.updatedAt = 1;
    old.turns = [{ id: "old-turn", role: "user", blocks: [{ kind: "text", text: "old" }] }];
    const recent = makeSession("default");
    recent.id = "recent-chat";
    recent.updatedAt = 2;
    recent.turns = [{ id: "recent-turn", role: "user", blocks: [{ kind: "text", text: "recent" }] }];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([old, recent]));

    const { result } = renderHook(() => useChatSessions());

    await waitFor(() => expect(result.current.currentId).toBe(recent.id));
    expect(result.current.currentSession?.turns[0]).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "recent" }],
    });
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

  it("cleans generated titles before showing them in the sidebar", () => {
    expect(cleanChatTitle(
      "<think>\nThe user asked me to pick a title.\n</think>\nTitle: Chemistry Slides",
    )).toBe("Chemistry Slides");
    expect(cleanChatTitle("<think>The user asked me to pick a title")).toBe("");
    expect(cleanChatTitle("The user asked for help")).toBe("");
    expect(cleanChatTitle("Untitled")).toBe("");
    expect(cleanChatTitle("无主题")).toBe("");
  });

  it("falls back to the first user request when a stored title is unusable", () => {
    const turns: ChatTurn[] = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "选择化学论文 slides 制作" }] },
      { id: "turn-assistant", role: "assistant", blocks: [{ kind: "text", text: "可以。" }] },
    ];

    expect(titleFromTurns(turns)).toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "<think>The user asked me", turns }).title)
      .toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "The user asked for help", turns }).title)
      .toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "无主题", turns }).title)
      .toBe("选择化学论文 slides 制作");
  });

  it("uses attached file context when the first user turn has no typed title", () => {
    const attachment: ChatAttachment = {
      id: "att-report",
      kind: "file",
      name: "analysis-report.md",
      path: "docs/analysis-report.md",
    };
    const turns: ChatTurn[] = [
      {
        id: "turn-user",
        role: "user",
        blocks: [{ kind: "text", text: "Attached context" }],
        attachments: [attachment],
      },
      { id: "turn-assistant", role: "assistant", blocks: [{ kind: "text", text: "收到。" }] },
    ];

    expect(titleFromTurns(turns)).toBe("docs/analysis-report.md");
    expect(migrateSession({ title: "Untitled", turns }).title).toBe("docs/analysis-report.md");
  });

  it("groups chats by project instead of date", () => {
    const alpha = { ...makeSession("project-a"), title: "Alpha chat" };
    const beta = { ...makeSession("project-b"), title: "Beta chat" };

    const groups = groupSessionsByProject([beta, alpha], projects);

    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta"]);
    expect(groups[0].sessions[0].projectId).toBe("project-a");
  });
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
  it("allows a second chat to submit while another chat is running", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(textbox, "draft for later");

    expect(textbox.disabled).toBe(false);
    expect(textbox.value).toBe("draft for later");
    const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
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
    localStorage.setItem("somniq-chat-recent-files", JSON.stringify(["src/chat/Chat.tsx"]));
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

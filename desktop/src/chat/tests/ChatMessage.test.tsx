// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";
import { useStore } from "../../store";
import ChatMessage, { diffFromTool, fileChangesFromTurn } from "../ChatMessage";

const apiMocks = vi.hoisted(() => ({
  chatChangeRevert: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("../../api/tauri", () => apiMocks);

beforeEach(() => {
  useStore.setState({ tab: "chat", language: "en", pendingStudioArtifactId: null });
  apiMocks.isTauri.mockReturnValue(false);
  apiMocks.fileOpen.mockResolvedValue(undefined);
  apiMocks.fileReadBytes.mockResolvedValue([]);
  apiMocks.chatChangeRevert.mockResolvedValue({
    changeId: "change-id",
    filePath: "src/a.ts",
    reverted: true,
    revertChangeId: "revert-id",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatMessage rendering", () => {
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

  const auditedFileTurn = (): ChatTurn => ({
    id: "assistant-audited-files",
    role: "assistant",
    blocks: [
      {
        kind: "tool",
        id: "tool-1",
        name: "edit_file",
        input: JSON.stringify({ path: "src/a.ts", old_string: "old", new_string: "new\nmore" }),
        output: JSON.stringify({
          filePath: "src/a.ts",
          changeId: "change-1",
          changes: {
            "src/a.ts": {
              type: "update",
              unified_diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more",
            },
          },
        }),
      },
      {
        kind: "tool",
        id: "tool-2",
        name: "write_file",
        input: JSON.stringify({ path: "src/b.ts", content: "one\ntwo" }),
        output: JSON.stringify({
          filePath: "src/b.ts",
          changeId: "change-2",
          changes: {
            "src/b.ts": {
              type: "add",
              content: "one\ntwo",
            },
          },
        }),
      },
    ],
  });

  it("summarizes audited file edits across a turn", () => {
    const summary = fileChangesFromTurn(auditedFileTurn());

    expect(summary?.fileCount).toBe(2);
    expect(summary?.addedLines).toBe(4);
    expect(summary?.removedLines).toBe(1);
    expect(summary?.changeIds).toEqual(["change-1", "change-2"]);
  });

  it("summarizes multiple audited files from one REPL output", () => {
    const summary = fileChangesFromTurn({
      id: "assistant-repl-files",
      role: "assistant",
      blocks: [{
        kind: "tool",
        id: "tool-repl",
        name: "REPL",
        input: JSON.stringify({ language: "python", code: "write files" }),
        output: JSON.stringify({
          stdout: "done",
          changes: {
            "src/a.ts": {
              type: "update",
              unified_diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new",
              changeId: "change-a",
            },
            "src/b.ts": {
              type: "add",
              content: "one\ntwo",
              changeId: "change-b",
            },
          },
        }),
      }],
    });

    expect(summary?.fileCount).toBe(2);
    expect(summary?.addedLines).toBe(3);
    expect(summary?.removedLines).toBe(1);
    expect(summary?.changeIds).toEqual(["change-a", "change-b"]);
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

    expect(screen.getAllByRole("button", { name: "reports/result.md" }).length).toBeGreaterThan(0);
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

  it("does not hide blocks in a single long turn", () => {
    render(
      <ChatMessage
        turn={{
          id: "user-long-turn",
          role: "user",
          blocks: Array.from({ length: 61 }, (_, index) => ({
            kind: "text" as const,
            text: `step ${index}`,
          })),
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("step 0")).toBeTruthy();
    expect(screen.getByText("step 60")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show .* earlier steps/ })).toBeNull();
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

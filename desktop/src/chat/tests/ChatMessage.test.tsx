// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";
import { useStore } from "../../store";
import ChatMessage, { EditedFilesSummary } from "../ChatMessage";
import { diffFromTool, fileChangesFromTurn } from "../toolSummaries";
import { useChatComposer } from "../useChatComposer";

const apiMocks = vi.hoisted(() => ({
  chatChangeRevert: vi.fn(),
  codeBridgeOpenFile: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("../../api/tauri", () => apiMocks);

beforeEach(() => {
  useStore.setState({
    tab: "chat",
    language: "en",
    pendingTypesetFilePath: null,
    pendingSidePanelEvidence: null,
  });
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
  it("keeps live LaTeX output in one stable viewport and follows it only from the end", () => {
    const message = (stdoutTail: string, stderrTail: string | null = null) => (
      <ChatMessage
        turn={{
          id: "assistant-latex-progress",
          role: "assistant",
          streaming: true,
          blocks: [{
            kind: "tool",
            id: "latex-compile",
            name: "LaTeXCompile",
            input: "{}",
            progress: {
              elapsedMs: 2_000,
              stdoutTail,
              stderrTail,
            },
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />
    );
    const view = render(message("first line"));
    const log = screen.getByLabelText("Live tool output");
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 360 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    view.rerender(message("first line\nsecond line", "warning"));

    expect(screen.getAllByLabelText("Live tool output")).toHaveLength(1);
    expect(log.textContent).toContain("stdout: first line\nsecond line");
    expect(log.textContent).toContain("stderr: warning");
    expect(log.scrollTop).toBe(240);

    log.scrollTop = 40;
    fireEvent.scroll(log);
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 420 });
    view.rerender(message("new tail after more compiler output", "warning"));

    expect(log.scrollTop).toBe(40);
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

  it("creates a diff card for NotebookEdit cells", () => {
    const change = diffFromTool({
      kind: "tool",
      name: "NotebookEdit",
      input: JSON.stringify({
        notebook_path: "notebooks/experiment.ipynb",
        cell_id: "cell-1",
        new_source: "print('updated')",
        edit_mode: "replace",
      }),
      output: JSON.stringify({
        notebook_path: "notebooks/experiment.ipynb",
        cell_id: "cell-1",
        edit_mode: "replace",
      }),
    });

    expect(change?.path).toBe("notebooks/experiment.ipynb");
    expect(change?.diff).toContain("cell cell-1");
    expect(change?.diff).toContain("+print('updated')");
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

  it("hides Windows extended path prefixes in file change labels and diffs", async () => {
    const user = userEvent.setup();
    const rawPath = String.raw`\\?\G:\research\papers\chapter.tex`;
    const displayPath = "G:/research/papers/chapter.tex";
    const { container } = render(
      <ChatMessage
        turn={{
          id: "assistant-extended-path",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "edit_file",
            input: "{}",
            output: JSON.stringify({
              changes: {
                [rawPath]: {
                  type: "update",
                  unified_diff: `--- ${rawPath}\n+++ ${rawPath}\n-old\n+new`,
                },
              },
            }),
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText(displayPath)).toBeTruthy();
    const header = container.querySelector(".chat-tool-header");
    expect(header).toBeTruthy();
    await user.click(header!);

    const diff = container.querySelector(".tool-diff");
    expect(diff?.textContent).toContain(`--- ${displayPath}`);
    expect(diff?.textContent).toContain(`+++ ${displayPath}`);
    expect(diff?.textContent).not.toContain("//?/");
  });

  it("renders project evidence searches as readable sources instead of raw diagnostics", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatMessage
        turn={{
          id: "assistant-evidence-search",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "ProjectEvidenceSearch",
            input: JSON.stringify({ query: "evaluation limitations", limit: 8 }),
            output: JSON.stringify({
              status: "ready",
              query: "evaluation limitations",
              queryPlan: { aliases: ["small sample"] },
              knowledge: {
                results: [{
                  knowledge: {
                    statement: "The evaluation dataset is small.",
                    evidence: [{ paperId: "paper-1", page: 2 }],
                  },
                }],
              },
              literature: {
                results: [{
                  chunk: {
                    chunkId: "chunk-internal-2",
                    paperId: "paper-1",
                    relativePath: ".somniq/papers/paper-1.pdf",
                    pageStart: 2,
                    text: "Only 20 samples were used in the evaluation.",
                    contentHash: "internal-hash",
                  },
                  cardRank: 1,
                }],
              },
              rerank: [{ id: "P:chunk-internal-2", relevance: 3 }],
            }),
          }, {
            kind: "text",
            text: "The evaluation uses a small sample [paper-1 p.2].",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("Found 2")).toBeTruthy();
    expect(screen.getByText("Local literature evidence · evaluation limitations")).toBeTruthy();
    await user.click(container.querySelector(".chat-tool-header")!);

    expect(screen.getByText("Confirmed knowledge")).toBeTruthy();
    expect(screen.getByText("Original PDF")).toBeTruthy();
    expect(screen.getAllByText("[paper-1 p.2]")).toHaveLength(2);
    expect(screen.getByText("Only 20 samples were used in the evaluation.")).toBeTruthy();
    expect(screen.queryByText(/chunk-internal-2|internal-hash|cardRank/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /paper-1.*p\.2/ }));
    expect(useStore.getState().pendingSidePanelEvidence).toMatchObject({
      path: ".somniq/papers/paper-1.pdf",
      page: 2,
      quotes: ["Only 20 samples were used in the evaluation."],
    });
  });

  it("renders web search coverage, provider failures, and cited links as a structured card", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatMessage
        turn={{
          id: "assistant-web-search",
          role: "assistant",
          blocks: [{
            kind: "tool",
            id: "web-1",
            name: "WebSearch",
            input: JSON.stringify({ query: "bounded web search", maxResults: 12 }),
            output: JSON.stringify({
              schemaVersion: 3,
              query: "bounded web search",
              maxResults: 12,
              status: "partial",
              provider: "duckduckgo",
              cached: false,
              queryVariants: [
                { kind: "original", query: "bounded web search" },
                { kind: "exact_phrase", query: "\"bounded web search\"" },
              ],
              coverage: {
                totalHits: null,
                fetched: 12,
                unique: 8,
                exhausted: false,
                nextCursor: "{\"schemaVersion\":3}",
                truncatedReason: "max_results",
              },
              retrievalControl: {
                decisionOwner: "llm",
                batchLimit: 12,
                hardBatchCeiling: 50,
                totalResultLimit: null,
                continuationAvailable: true,
                continuationRequiresSameBatchLimit: true,
                availableUnsearchedProviders: ["exa", "duckduckgo"],
                recommendedAction: "Assess sufficiency, continue for depth, or broaden providers.",
                sufficiencyChecks: ["relevance", "source diversity", "corroboration"],
              },
              sourceAttempts: [{
                provider: "brave",
                status: "failed",
                queryVariantCount: 2,
                coverage: {
                  totalHits: null,
                  fetched: 0,
                  unique: 0,
                  exhausted: false,
                  nextCursor: null,
                  truncatedReason: "provider_error",
                },
                error: "rate limited",
              }, {
                provider: "duckduckgo",
                status: "partial",
                queryVariantCount: 2,
                coverage: {
                  totalHits: null,
                  fetched: 12,
                  unique: 8,
                  exhausted: false,
                  nextCursor: "aggregate_cursor",
                  truncatedReason: "max_results",
                },
              }],
              results: [{
                tool_use_id: "web_search_results",
                content: [{
                  title: "Search protocol design",
                  url: "https://example.com/search-protocol",
                  snippet: "A bounded and auditable search protocol.",
                  provider: "zhihu",
                  rank: 1,
                  sourceMetadata: {
                    sourceKind: "community",
                    authorName: "研究者甲",
                  },
                }],
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

    expect(screen.getByText("Partial · 8")).toBeTruthy();
    expect(screen.getByText("Web search · bounded web search")).toBeTruthy();
    expect(container.querySelector(".chat-tool")?.classList.contains("tool-warning")).toBe(true);
    await user.click(container.querySelector(".chat-tool-header")!);

    expect(screen.getByText("Incomplete")).toBeTruthy();
    expect(screen.getByText(/Do not treat this as an exhaustive result set/)).toBeTruthy();
    expect(screen.getByText("LLM-adaptive retrieval")).toBeTruthy();
    expect(screen.getByText(/per-batch context guard/)).toBeTruthy();
    expect(screen.getByText(/Not searched yet: exa, duckduckgo/)).toBeTruthy();
    expect(screen.getByText("rate limited")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Search protocol design" });
    expect(link.getAttribute("href")).toBe("https://example.com/search-protocol");
    expect(screen.getByText(/zhihu · community view · 研究者甲/)).toBeTruthy();
    expect(screen.queryByText(/web_search_results/)).toBeNull();
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

  it("reports the completed portion when reverting a multi-change turn stops midway", async () => {
    const user = userEvent.setup();
    const summary = fileChangesFromTurn(auditedFileTurn());
    expect(summary).toBeTruthy();
    apiMocks.chatChangeRevert
      .mockResolvedValueOnce({ changeId: "change-2", reverted: true })
      .mockResolvedValueOnce({ changeId: "change-1", reverted: false, conflict: "src/a.ts changed on disk" });

    render(<EditedFilesSummary summary={summary!} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(screen.getByText("Reverted 1 change; src/a.ts changed on disk")).toBeTruthy());
    expect(apiMocks.chatChangeRevert).toHaveBeenNthCalledWith(1, "change-2");
    expect(apiMocks.chatChangeRevert).toHaveBeenNthCalledWith(2, "change-1");
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

  it("opens generated code and Markdown files in the Code page", async () => {
    const user = userEvent.setup();
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

    const fileLink = screen.getAllByRole("button", { name: "reports/result.md" })[0];
    expect(fileLink).toBeTruthy();
    await user.click(fileLink!);
    expect(useStore.getState().tab).toBe("lab");
    // The workbench owns its own tabs, so the open travels over the bridge
    // rather than through the store.
    expect(apiMocks.codeBridgeOpenFile).toHaveBeenCalledWith("reports/result.md");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  const fileToolTurn = (path: string) => ({
    id: `assistant-${path}`,
    role: "assistant" as const,
    blocks: [{
      kind: "tool" as const,
      name: "write_file",
      input: JSON.stringify({ path, content: "done" }),
      output: "ok",
    }],
  });

  it("opens a generated LaTeX source in the LaTeX workspace", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessage
        turn={fileToolTurn("papers/main.tex")}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "papers/main.tex" })[0]!);

    expect(useStore.getState().tab).toBe("typeset");
    expect(useStore.getState().pendingTypesetFilePath).toBe("papers/main.tex");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("reads a generated PDF in the chat side panel instead of the LaTeX workspace", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessage
        turn={fileToolTurn("papers/main.pdf")}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "papers/main.pdf" })[0]!);

    expect(useStore.getState().pendingSidePanelFilePath).toBe("papers/main.pdf");
    expect(useStore.getState().tab).toBe("chat");
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
  });

  it("opens a generated figure in the LaTeX image preview", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessage
        turn={fileToolTurn("papers/figures/result.png")}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "papers/figures/result.png" })[0]!);

    expect(useStore.getState().tab).toBe("typeset");
    expect(useStore.getState().pendingTypesetFilePath).toBe("papers/figures/result.png");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
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

  it("renders a readable ChatGPT Web consultation result instead of raw JSON", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessage
        turn={{
          id: "oracle-consult",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "ChatGptWebConsult",
            input: JSON.stringify({ prompt: "Review this" }),
            output: JSON.stringify({
              accountId: "account",
              sessionId: "session-1",
              status: "completed",
              output: "The draft needs a stronger evidence table.",
            }),
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("ChatGPT Web replied")).toBeTruthy();
    await user.click(screen.getByText("ChatGPT Web consultation"));
    expect(screen.getByText("The draft needs a stronger evidence table.")).toBeTruthy();
    expect(screen.queryByText(/\"accountId\"/)).toBeNull();
  });

  it("previews image artifacts returned by ChatGptWebImage", async () => {
    render(
      <ChatMessage
        turn={{
          id: "oracle-image",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "ChatGptWebImage",
            input: JSON.stringify({
              prompt: "Draw a diagram",
              files: [".somniq/figures/reference.png"],
            }),
            output: JSON.stringify({
              status: "completed",
              output: "Generated source C:/SomniQ/oracle-home/generated/diagram.png",
              images: [{ path: ".somniq/artifacts/oracle-images/run/diagram.png" }],
            }),
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("Generated 1 image(s)")).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.fileReadBytes).toHaveBeenCalledWith(
        ".somniq/artifacts/oracle-images/run/diagram.png",
      );
    });
    expect(apiMocks.fileReadBytes).toHaveBeenCalledTimes(1);
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalledWith(".somniq/figures/reference.png");
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalledWith("C:/SomniQ/oracle-home/generated/diagram.png");
  });

  it("does not duplicate generated images from incidental shell paths", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-shell-image-copy",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "bash",
            input: JSON.stringify({ command: "copy generated.png figures/final.png" }),
            output: JSON.stringify({ stdout: "copied figures/final.png", stderr: "" }),
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.queryByRole("img", { name: "figures/final.png" })).toBeNull();
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

  it("does not treat a bare domain image reference as a local file", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-bare-domain-image",
          role: "assistant",
          blocks: [{
            kind: "tool",
            name: "run_experiment",
            input: "{}",
            output: "saved figure to example.com/results/plot.png",
          }],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(apiMocks.fileReadBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "example.com/results/plot.png" })).toBeNull();
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

  it("leaves omitted saved turns as passive notices for scroll-driven hydration", () => {
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
      />,
    );

    expect(screen.getByText("A large saved turn was omitted from the quick preview.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load full turn" })).toBeNull();
  });

  it("ticks a retry countdown down instead of freezing on the wait it started with", () => {
    vi.useFakeTimers();
    try {
      const resumeAt = Date.now() + 4_000;
      render(
        <ChatMessage
          turn={{
            id: "assistant-retrying",
            role: "assistant",
            streaming: true,
            blocks: [{
              kind: "notice",
              message: "captured when the retry started",
              retry: { attempt: 3, maxAttempts: 4, resumeAt, count: 3 },
            }],
          }}
          canRetry={false}
          onEdit={() => undefined}
          onRetry={() => undefined}
          onContinue={() => undefined}
        />,
      );

      expect(screen.getByText(/retrying \(3\/4, continuing in about 4s\)/)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByText(/retrying \(3\/4, continuing in about 2s\)/)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(screen.getByText(/reconnecting \(3\/4\)/)).toBeTruthy();
      // The burst it stands for stays visible instead of one banner per attempt.
      expect(screen.getByText("×3")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a retry notice once the turn moves past it", () => {
    render(
      <ChatMessage
        turn={{
          id: "assistant-recovered",
          role: "assistant",
          streaming: true,
          blocks: [
            {
              kind: "notice",
              message: "captured when the retry started",
              retry: { attempt: 4, maxAttempts: 4, resumeAt: Date.now() + 4_000, count: 5 },
            },
            { kind: "text", text: "the answer" },
          ],
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByText("The model connection was unstable; retried 5 times this turn.")).toBeTruthy();
    expect(screen.queryByText(/continuing in about/)).toBeNull();
  });

  it("shows which Reviewer Agent is active and opens its details only when clicked", async () => {
    const user = userEvent.setup();
    const onOpenIndependentReview = vi.fn();
    render(
      <ChatMessage
        turn={{
          id: "assistant-under-review",
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
        }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onOpenIndependentReview={onOpenIndependentReview}
      />,
    );

    const badge = screen.getByRole("button", {
      name: /Open independent Reviewer details: gpt-5-reviewer is independently reviewing/,
    });
    expect(screen.getByText("Reviewer Agent · openai")).toBeTruthy();
    expect(onOpenIndependentReview).not.toHaveBeenCalled();

    await user.click(badge);

    expect(onOpenIndependentReview).toHaveBeenCalledTimes(1);
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

  it("reveals the newest thinking phase when answer text arrives in the same stream batch", async () => {
    const turn = (streaming: boolean): ChatTurn => ({
      id: "assistant-coalesced-thinking",
      role: "assistant",
      streaming,
      blocks: [
        { kind: "thinking", thinking: "首条思考应立即可见。" },
        { kind: "text", text: "正文已经紧跟到达。" },
      ],
    });
    const props = {
      canRetry: false,
      onEdit: () => undefined,
      onRetry: () => undefined,
      onContinue: () => undefined,
    };
    const { container, rerender } = render(<ChatMessage turn={turn(true)} {...props} />);

    expect(container.querySelector(".md-think-body")?.textContent).toContain("首条思考应立即可见");

    rerender(<ChatMessage turn={turn(false)} {...props} />);
    await waitFor(() => expect(container.querySelector(".md-think-body")).toBeNull());
  });
});

describe("AskUserQuestion card", () => {
  const questionBlock = (overrides: Record<string, unknown> = {}) => ({
    kind: "tool" as const,
    id: "ask-1",
    name: "AskUserQuestion",
    ready: true,
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
    onQuestionRespond: (toolUseId: string, answer: string) => Promise<void> = async () => undefined,
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

  it("submits a question only once when the option is double-clicked synchronously", () => {
    const onQuestionRespond = vi.fn();
    renderQuestion(questionTurn(questionBlock()), onQuestionRespond);

    const option = screen.getByRole("button", { name: /Postgres/ });
    fireEvent.click(option);
    fireEvent.click(option);

    expect(onQuestionRespond).toHaveBeenCalledTimes(1);
    expect(onQuestionRespond).toHaveBeenCalledWith("ask-1", "Postgres");
  });

  it("unlocks the question and allows retry when answer submission fails", async () => {
    const user = userEvent.setup();
    const onQuestionRespond = vi.fn()
      .mockRejectedValueOnce(new Error("question prompt is no longer active"))
      .mockResolvedValueOnce(undefined);
    renderQuestion(questionTurn(questionBlock()), onQuestionRespond);

    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    expect(await screen.findByText("The answer could not be submitted. Please try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Postgres/ }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    expect(onQuestionRespond).toHaveBeenCalledTimes(2);
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

  it("only makes the backend-ready question answerable and prepares the rest", async () => {
    const user = userEvent.setup();
    const onQuestionRespond = vi.fn();
    const first = { ...questionBlock({ question: "Which database?" }), id: "ask-1" };
    const second = {
      ...questionBlock({
        question: "Which cache?",
        options: [{ label: "Redis" }, { label: "Memcached" }],
      }),
      id: "ask-2",
      ready: false,
    };
    const turn: ChatTurn = { id: "assistant-q", role: "assistant", streaming: true, blocks: [first, second] };

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

    expect(screen.getByRole("button", { name: /Postgres/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Redis/ })).toBeNull();
    expect(screen.getByText("Preparing this question…")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Postgres/ }));
    expect(onQuestionRespond).toHaveBeenCalledWith("ask-1", "Postgres");
    expect(onQuestionRespond).not.toHaveBeenCalledWith("ask-2", expect.anything());
  });

  it("waits for the backend-ready handshake before enabling the second question", () => {
    const first = { ...questionBlock({ question: "Which database?" }), id: "ask-1", output: "Postgres" };
    const second = {
      ...questionBlock({
        question: "Which cache?",
        options: [{ label: "Redis" }, { label: "Memcached" }],
      }),
      id: "ask-2",
      ready: false,
    };
    const turn: ChatTurn = { id: "assistant-q", role: "assistant", streaming: true, blocks: [first, second] };

    const view = render(
      <ChatMessage
        turn={turn}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onQuestionRespond={async () => undefined}
      />,
    );

    expect(screen.getByText("You answered")).toBeTruthy();
    expect(screen.getByText("Preparing this question…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Redis/ })).toBeNull();

    view.rerender(
      <ChatMessage
        turn={{ ...turn, blocks: [first, { ...second, ready: true }] }}
        canRetry={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onContinue={() => undefined}
        onQuestionRespond={async () => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /Redis/ })).toBeTruthy();
    expect(screen.queryByText("Preparing this question…")).toBeNull();
  });
});

describe("chat file-path context menu", () => {
  it("finds an inline-code path regardless of Markdown wrapper depth", () => {
    const root = document.createElement("section");
    const code = document.createElement("code");
    let node: HTMLElement = code;
    for (let index = 0; index < 6; index += 1) {
      const wrapper = document.createElement("span");
      node.append(wrapper);
      node = wrapper;
    }
    node.textContent = "desktop/src/chat/Chat.tsx";
    root.append(code);
    const target = node;
    const currentSessionRef = { current: null };
    const { result } = renderHook(() => useChatComposer({
      currentSession: null,
      currentSessionRef,
      updateSession: () => undefined,
      setDraft: () => undefined,
    }));
    const preventDefault = vi.fn();

    act(() => result.current.handleChatContextMenu({
      target,
      currentTarget: root,
      clientX: 12,
      clientY: 34,
      preventDefault,
    } as never));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.fileMenu).toEqual({ x: 12, y: 34, path: "desktop/src/chat/Chat.tsx" });
  });
});

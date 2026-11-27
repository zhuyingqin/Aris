// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypesetComment } from "../../api/tauri";

const mocks = vi.hoisted(() => ({
  typesetCommentsList: vi.fn(),
  typesetCommentUpsert: vi.fn(),
  typesetCommentDelete: vi.fn(),
  literatureWriteBibliographyExport: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("../../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tauri")>()),
  typesetCommentsList: mocks.typesetCommentsList,
  typesetCommentUpsert: mocks.typesetCommentUpsert,
  typesetCommentDelete: mocks.typesetCommentDelete,
  literatureWriteBibliographyExport: mocks.literatureWriteBibliographyExport,
}));

import TypesetCommentsPanel, { commentsMarkdown } from "../TypesetCommentsPanel";
import { latexCommentHighlights, setCommentHighlights } from "../../editor/latexCommentHighlights";
import { useStore } from "../../store";

const SOURCE = "\\section{Intro}\nDeep nets work.\nMore text.\n";

const comment = (overrides: Partial<TypesetComment> = {}): TypesetComment => ({
  id: "c1",
  path: "main.tex",
  from: SOURCE.indexOf("Deep"),
  to: SOURCE.indexOf("Deep") + "Deep nets".length,
  selectedText: "Deep nets",
  body: "Cite this.",
  author: "Ann",
  origin: "user",
  resolved: false,
  createdAtMs: Date.UTC(2026, 10, 24, 9),
  updatedAtMs: Date.UTC(2026, 10, 24, 9),
  ...overrides,
});

describe("comment highlights in the editor", () => {
  it("marks open comments and keeps the mark on its text while typing before it", () => {
    const view = new EditorView({ state: EditorState.create({ doc: SOURCE, extensions: [latexCommentHighlights()] }) });
    view.dispatch({ effects: setCommentHighlights.of([{ id: "c1", from: comment().from, to: comment().to, author: "Ann", body: "Cite this.", replies: 0 }]) });
    expect(view.dom.querySelector(".cm-typeset-comment")?.textContent).toBe("Deep nets");

    view.dispatch({ changes: { from: 0, insert: "% header\n" } });
    expect(view.dom.querySelector(".cm-typeset-comment")?.textContent).toBe("Deep nets");

    view.dispatch({ effects: setCommentHighlights.of([]) });
    expect(view.dom.querySelector(".cm-typeset-comment")).toBeNull();
    view.destroy();
  });
});

describe("commentsMarkdown", () => {
  it("lists comments in source order with their line, quote, status and replies", () => {
    const markdown = commentsMarkdown("main.tex", SOURCE, [
      comment({ id: "c2", from: SOURCE.indexOf("More"), to: SOURCE.indexOf("More") + 4, selectedText: "More", body: "Cut?", resolved: true }),
      comment({ replies: [{ id: "r1", body: "Added [3].", author: "Ben", origin: "user", createdAtMs: Date.UTC(2026, 10, 24, 10) }] }),
    ], "en");
    expect(markdown).toMatch(/^# Comments: main\.tex\n/);
    expect(markdown).toContain("2 comments, 1 open");
    const first = markdown.indexOf("## 1. Line 2 · open");
    const second = markdown.indexOf("## 2. Line 3 · resolved");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(markdown).toContain("> Deep nets");
    expect(markdown).toContain("Cite this.");
    expect(markdown).toMatch(/- \*\*Ben\*\* · .+: Added \[3\]\./);
  });
});

describe("TypesetCommentsPanel replies and export", () => {
  beforeEach(() => {
    useStore.setState({ language: "en" });
    mocks.typesetCommentsList.mockReset().mockResolvedValue([comment()]);
    mocks.typesetCommentUpsert.mockReset().mockImplementation(async (_path: string, value: TypesetComment) => value);
    mocks.literatureWriteBibliographyExport.mockReset().mockResolvedValue(undefined);
    mocks.save.mockReset().mockResolvedValue("C:/Users/me/main-comments.md");
  });
  afterEach(cleanup);

  const renderPanel = (onCommentsChanged = vi.fn()) => render(
    <TypesetCommentsPanel
      path="main.tex"
      source={SOURCE}
      selection={{ from: 0, to: 0 }}
      focusCommentId="c1"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      onCommentsChanged={onCommentsChanged}
    />,
  );

  it("adds a reply to the comment and reports the reloaded list", async () => {
    const onCommentsChanged = vi.fn();
    renderPanel(onCommentsChanged);
    const article = (await screen.findByText("Cite this.")).closest("article")!;
    expect(article.classList.contains("focused")).toBe(true);
    await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledWith([comment()]));

    fireEvent.click(within(article).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(article).getByLabelText("Reply"), { target: { value: "Done, see [3]." } });
    mocks.typesetCommentsList.mockResolvedValue([comment({ replies: [{ id: "r1", body: "Done, see [3].", author: "You", origin: "user", createdAtMs: 2 }] })]);
    await act(async () => {
      fireEvent.click(within(article).getByRole("button", { name: "Send reply" }));
    });

    expect(mocks.typesetCommentUpsert).toHaveBeenCalledWith("main.tex", expect.objectContaining({
      id: "c1",
      replies: [expect.objectContaining({ id: "", body: "Done, see [3].", origin: "user" })],
    }));
    const replies = await screen.findByRole("list", { name: "Replies" });
    expect(replies.textContent).toContain("Done, see [3].");
  });

  it("exports the comments as Markdown to the chosen file", async () => {
    renderPanel();
    await screen.findByText("Cite this.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "main-comments.md" }));
    expect(mocks.literatureWriteBibliographyExport).toHaveBeenCalledWith(
      "C:/Users/me/main-comments.md",
      expect.stringContaining("## 1. Line 2 · open"),
    );
    expect(await screen.findByText("Exported to C:/Users/me/main-comments.md")).toBeTruthy();
  });
});

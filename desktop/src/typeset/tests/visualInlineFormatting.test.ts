// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { visualDecorationsExtension, VISUAL_REPARSE_IDLE_MS } from "../visualDecorations";

function editor(source: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: source, extensions: [visualDecorationsExtension] }),
  });
  return { view, content: view.contentDOM, destroy: () => { view.destroy(); parent.remove(); } };
}

describe("empty visual formatting", () => {
  it.each(["textbf", "textit", "emph", "underline", "texttt", "textsc", "textsubscript", "textsuperscript"])(
    "keeps an empty %s command visible and reachable outside the caret",
    (command) => {
      const source = `Before\n\\${command}{}\nAfter`;
      const harness = editor(source);
      try {
        expect(harness.content.textContent).toContain(`\\${command}{}`);
        harness.view.dispatch({ selection: EditorSelection.cursor(source.indexOf("{}") + 1) });
        harness.view.dispatch({ changes: { from: harness.view.state.selection.main.head, insert: "new text" } });
        expect(harness.view.state.doc.toString()).toContain(`\\${command}{new text}`);
      } finally {
        harness.destroy();
      }
    },
  );

  it.each([" ", "\n  \n", "% unfinished text\n"])("keeps visually empty arguments editable: %j", (argument) => {
    const harness = editor(`Before\n\\textbf{${argument}}\nAfter`);
    try {
      expect(harness.content.textContent).toContain("\\textbf{");
    } finally {
      harness.destroy();
    }
  });

  it("restores the command after its last character is deleted and renders it again after typing", () => {
    vi.useFakeTimers();
    const source = "Before\n\\textbf{B}\nAfter";
    const harness = editor(source);
    try {
      expect(harness.content.querySelector(".cm-vis-bold")?.textContent).toBe("B");
      const contentFrom = source.indexOf("{B}") + 1;
      harness.view.dispatch({ changes: { from: contentFrom, to: contentFrom + 1 } });
      vi.advanceTimersByTime(VISUAL_REPARSE_IDLE_MS + 1);
      expect(harness.content.textContent).toContain("\\textbf{}");
      harness.view.dispatch({ selection: EditorSelection.cursor(contentFrom) });
      harness.view.dispatch({ changes: { from: contentFrom, insert: "Bold" }, selection: EditorSelection.cursor(0) });
      vi.advanceTimersByTime(VISUAL_REPARSE_IDLE_MS + 1);
      expect(harness.content.querySelector(".cm-vis-bold")?.textContent).toBe("Bold");
      expect(harness.content.textContent).not.toContain("\\textbf");
    } finally {
      harness.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps an empty nested formatting command accessible", () => {
    const harness = editor("Before\n\\textbf{\\emph{}}\nAfter");
    try {
      expect(harness.content.textContent).toContain("\\emph{}");
    } finally {
      harness.destroy();
    }
  });
});

// @vitest-environment jsdom

import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { diffDecorationField, diffDecorations, dispatchDiffLines, type CodeDiffLine } from "../editorDecorations";
import { loadLanguageExtension } from "../editorLanguages";
import { createSharedEditorView } from "../editorView";

function mountHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("createSharedEditorView", () => {
  it("initializes the document and reflects it via the handle", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "hello", language: "text", surface: "code" });
    expect(handle.getText()).toBe("hello");
    handle.destroy();
  });

  it("distinguishes user transactions (undoable) from external setDocument (addToHistory:false)", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "hello", language: "text", surface: "code" });

    // User-like edit: a default transaction, tracked by history().
    handle.dispatch({ changes: { from: 5, to: 5, insert: " world" } });
    expect(handle.getText()).toBe("hello world");

    // External edit (disk/AI write): explicitly opts out of history.
    handle.setDocument("hello world!!!", { addToHistory: false });
    expect(handle.getText()).toBe("hello world!!!");

    undo(handle.view);
    // Only the user transaction is undone; the external "!!!" append survives.
    expect(handle.getText()).toBe("hello!!!");
    handle.destroy();
  });

  it("maps an unaffected selection position across an external doc update instead of resetting it", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, {
      doc: "line one\nline two\nline three",
      language: "text",
      surface: "code",
    });
    const cursorPos = handle.getText().indexOf("two");
    handle.dispatch({ selection: EditorSelection.cursor(cursorPos) });

    // Prepend an unrelated line via a whole-document external update — the
    // minimal-diff replacement should touch only the prefix, leaving the caret
    // correctly mapped onto the same "two" occurrence rather than jumping to 0.
    handle.setDocument("line zero\nline one\nline two\nline three", {
      addToHistory: false,
      preserveSelection: true,
    });
    const mappedPos = handle.getText().indexOf("two");
    expect(handle.getSelection().main.head).toBe(mappedPos);
    handle.destroy();
  });

  it("supports multiple selection ranges", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "abc def ghi", language: "text", surface: "code" });
    handle.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    });
    expect(handle.getSelection().ranges).toHaveLength(2);
    handle.destroy();
  });

  it("stamps data-editor onto CodeMirror's contentDOM so DOM-query focus keeps working", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "x", language: "text", surface: "code", dataEditor: "3" });
    const target = host.querySelector('[data-editor="3"]');
    expect(target).toBe(handle.view.contentDOM);
    handle.destroy();
  });

  it("registers the view in the DEV test registry keyed by dataEditor, and unregisters on destroy", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "x", language: "text", surface: "code", dataEditor: "cell-2" });
    expect(window.__somniqEditors?.get("cell-2")).toBe(handle.view);
    handle.destroy();
    expect(window.__somniqEditors?.get("cell-2")).toBeUndefined();
  });

  it("destroys cleanly, and a fresh mount afterwards creates an independent view", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, { doc: "first", language: "text", surface: "code" });
    handle.destroy();
    expect(host.childElementCount).toBe(0);

    const host2 = mountHost();
    const handle2 = createSharedEditorView(host2, { doc: "second", language: "text", surface: "code" });
    expect(handle2.getText()).toBe("second");
    handle2.destroy();
  });
});

describe("loadLanguageExtension", () => {
  it("resolves a language extension for a known language", async () => {
    const extensions = await loadLanguageExtension("python");
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("resolves legacy-mode languages (matlab/latex/bash/powershell/ini)", async () => {
    for (const language of ["matlab", "latex", "bash", "powershell", "ini"] as const) {
      const extensions = await loadLanguageExtension(language);
      expect(extensions.length).toBeGreaterThan(0);
    }
  });

  it("falls back to no extension (plain text) for 'text'", async () => {
    expect(await loadLanguageExtension("text")).toEqual([]);
  });
});

describe("diffDecorations", () => {
  function diffRanges(doc: string, lines: CodeDiffLine[]) {
    const state = EditorState.create({ doc, extensions: [diffDecorations(lines)] });
    const ranges: { from: number; className?: string }[] = [];
    state.field(diffDecorationField).between(0, doc.length, (from, _to, value) => {
      ranges.push({ from, className: value.spec.class });
    });
    return ranges;
  }

  it("marks added and removed lines with distinct classes", () => {
    const doc = "a\nb\nc";
    const ranges = diffRanges(doc, [
      { line: 2, type: "added" },
      { line: 3, type: "removed" },
    ]);
    expect(ranges).toEqual([
      { from: 2, className: "cm-diff-line cm-diff-added" },
      { from: 4, className: "cm-diff-line cm-diff-removed" },
    ]);
  });

  it("prefers 'added' when a line carries both marks", () => {
    const doc = "a\nb";
    const ranges = diffRanges(doc, [
      { line: 2, type: "removed" },
      { line: 2, type: "added" },
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].className).toBe("cm-diff-line cm-diff-added");
  });

  it("ignores out-of-range line numbers instead of throwing", () => {
    const doc = "a\nb";
    expect(() => diffRanges(doc, [{ line: 99, type: "added" }])).not.toThrow();
  });

  it("updates decorations when the diff-lines effect is dispatched", () => {
    const host = mountHost();
    const handle = createSharedEditorView(host, {
      doc: "a\nb\nc",
      language: "text",
      surface: "code",
      extensions: [diffDecorations()],
    });
    const countRanges = () => {
      let count = 0;
      handle.view.state.field(diffDecorationField).between(0, handle.view.state.doc.length, () => {
        count += 1;
      });
      return count;
    };
    expect(countRanges()).toBe(0);

    dispatchDiffLines(handle.view, [{ line: 2, type: "added" }]);
    expect(countRanges()).toBe(1);

    dispatchDiffLines(handle.view, []);
    expect(countRanges()).toBe(0);
    handle.destroy();
  });
});

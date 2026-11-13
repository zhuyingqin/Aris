// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import source from "./fixtures/forecasting-model-groups.tex?raw";
import { visualBlockClick, visualDecorations, visualPointerSelecting } from "../visualDecorations";
import { visualClickScrollEffect } from "../visualScrollAnchor";

const rect = (top: number, height: number) => ({ x: 0, y: top, left: 0, right: 700, top, bottom: top + height, width: 700, height, toJSON: () => ({}) });
function mount(anchor = 0) {
  const parent = document.createElement("div");
  parent.className = "typeset-visual-scroll";
  parent.getBoundingClientRect = () => rect(100, 600);
  document.body.append(parent);
  const doc = "Before.\n" + source + "\nAfter.";
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: EditorSelection.cursor(anchor), extensions: [visualDecorations, visualBlockClick] }) });
  return { view, doc, dispose() { view.destroy(); parent.remove(); } };
}
afterEach(() => vi.restoreAllMocks());

describe("Visual block scroll anchoring", () => {
  it("opens the table at its real start and retains the card's screen height after measurement", async () => {
    const h = mount();
    try {
      const tableFrom = h.doc.indexOf("\\begin{table}");
      const tableTo = h.doc.indexOf("\\end{table}") + "\\end{table}".length;
      const wrap = h.view.dom.querySelector<HTMLElement>(".cm-vis-table-wrap")!;
      wrap.getBoundingClientRect = () => rect(320, 240);
      const block = h.view.lineBlockAt(tableFrom);
      vi.spyOn(h.view, "lineBlockAtHeight").mockReturnValue(Object.assign(Object.create(Object.getPrototypeOf(block)), block, { from: tableFrom, length: tableTo - tableFrom }));
      const scroll = vi.spyOn(EditorView, "scrollIntoView");
      for (const type of ["mousedown", "mouseup"]) wrap.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 500 }));
      await Promise.resolve();
      expect(h.view.state.selection.main.head).toBe(tableFrom);
      expect(h.view.dom.textContent).toContain("\\begin{table}[!htb]");
      expect(h.view.dom.querySelector(".cm-vis-table-wrap")).toBeNull();
      expect(scroll).toHaveBeenLastCalledWith(tableFrom, { y: "start", yMargin: 220 });
      expect(h.view.state.doc.toString()).toBe(h.doc);
    } finally { h.dispose(); }
  });

  it("anchors later prose while the preceding raw table collapses", () => {
    const h = mount(("Before.\n" + source).indexOf("Main limitation"));
    try {
      expect(h.view.dom.querySelector(".cm-vis-table-wrap")).toBeNull();
      const after = h.doc.indexOf("After.");
      h.view.dispatch({ effects: visualPointerSelecting.of(true) });
      h.view.dispatch({ selection: EditorSelection.cursor(after) });
      vi.spyOn(h.view, "coordsAtPos").mockReturnValue(rect(430, 24));
      const scroll = vi.spyOn(EditorView, "scrollIntoView");
      const effect = visualClickScrollEffect(h.view);
      h.view.dispatch({ effects: [visualPointerSelecting.of(false), effect!] });
      expect(h.view.dom.querySelector(".cm-vis-table-wrap")).not.toBeNull();
      expect(h.view.state.selection.main.head).toBe(after);
      expect(scroll).toHaveBeenLastCalledWith(after, { y: "start", yMargin: 330 });
    } finally { h.dispose(); }
  });

  it("does not scroll a caret for a drag selection", () => {
    const h = mount();
    try {
      h.view.dispatch({ selection: EditorSelection.range(0, h.doc.length) });
      const scroll = vi.spyOn(EditorView, "scrollIntoView");
      expect(visualClickScrollEffect(h.view)).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });

  it("keeps a table starting above the viewport accessible when opened", () => {
    const h = mount();
    try {
      const scroll = vi.spyOn(EditorView, "scrollIntoView");
      visualClickScrollEffect(h.view, { pos: 8, top: -120 });
      expect(scroll).toHaveBeenLastCalledWith(8, { y: "start", yMargin: 0 });
    } finally { h.dispose(); }
  });

  it("leaves cell clicks with the grid instead of revealing the entire float", () => {
    const h = mount();
    try {
      const cell = h.view.dom.querySelector<HTMLElement>('[data-row="0"][data-column="1"]')!;
      for (const type of ["pointerdown", "mousedown", "mouseup"]) cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 500 }));
      expect(cell.textContent).toBe("\\textbf{Statistical}");
      expect(h.view.dom.querySelector(".cm-vis-table-wrap")).not.toBeNull();
      expect(h.view.state.selection.main.head).toBe(0);
    } finally { h.dispose(); }
  });
});

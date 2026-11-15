// @vitest-environment jsdom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";
import source from "./fixtures/forecasting-model-groups.tex?raw";
import { useStore } from "../../store";
import { visualBlockClick, visualDecorations } from "../visualDecorations";
import { reparseVisualLatex } from "../visualDecorationScheduler";

beforeEach(() => useStore.setState({ language: "en", languagePreferenceSet: true }));
function mount() {
  const parent = document.createElement("div");
  document.body.append(parent);
  const doc = "Before.\n" + source + "\nAfter.";
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [visualDecorations, visualBlockClick] }) });
  return { view, doc, dispose() { view.destroy(); parent.remove(); } };
}

describe("forecasting model table in Visual", () => {
  it("renders four wrapping columns, six rows and the caption above the grid", () => {
    const h = mount();
    try {
      const wrap = h.view.dom.querySelector<HTMLElement>(".cm-vis-table-wrap")!;
      expect(wrap).not.toBeNull();
      const table = wrap.querySelector<HTMLTableElement>("table")!;
      expect(table.rows).toHaveLength(6);
      expect([...table.rows].map((row) => row.cells.length)).toEqual([4, 4, 4, 4, 4, 4]);
      expect([...table.rows[0].cells].map((cell) => cell.textContent)).toEqual(["", "Statistical", "Non-neural ML", "Neural network"]);
      expect(wrap.firstElementChild?.className).toBe("cm-vis-caption");
      expect(wrap.firstElementChild?.textContent).toBe("The three groups of forecasting models.");
      expect(table.style.tableLayout).toBe("fixed");
      expect(table.style.width).toContain("calc(");
      expect(parseFloat(table.style.width.slice(5))).toBeCloseTo(12.45 * 96 / 2.54);
      const columns = [...table.querySelectorAll("col")];
      expect(columns).toHaveLength(4);
      expect(parseFloat(columns[0].style.width)).toBeCloseTo(2.7 / 12.45 * 100);
      expect(table.querySelectorAll(".cm-vis-table-spaced-row")).toHaveLength(4);
      expect(h.view.state.doc.toString()).toBe(h.doc);
    } finally { h.dispose(); }
  });

  it("writes back one cell without changing width definitions, the caption or rules", () => {
    const h = mount();
    try {
      const cell = h.view.dom.querySelector<HTMLElement>('[data-row="1"][data-column="3"]')!;
      cell.focus();
      cell.textContent = "Learned mapping";
      cell.blur();
      expect(h.view.state.doc.toString()).toBe(h.doc.replace("Learned network", "Learned mapping"));
    } finally { h.dispose(); }
  });

  it("keeps four columns and the outer float after inserting a row", () => {
    const h = mount();
    try {
      const cell = h.view.dom.querySelector<HTMLElement>('[data-row="2"][data-column="1"]')!;
      cell.focus();
      h.view.dom.querySelector<HTMLButtonElement>('[aria-label="Insert row below"]')!.click();
      h.view.dispatch({ effects: reparseVisualLatex.of(undefined) });
      const table = h.view.dom.querySelector<HTMLTableElement>("table")!;
      expect(table.rows).toHaveLength(7);
      expect([...table.rows].every((row) => row.cells.length === 4)).toBe(true);
      expect(h.view.state.doc.toString()).toContain("L{3.25cm}@{}}");
      expect(h.view.state.doc.toString()).toContain("\\caption[Three groups of forecasting models]");
      expect(h.view.state.doc.toString()).toContain("\\end{table}");
    } finally { h.dispose(); }
  });

  it("refreshes widths even when every rendered cell and source offset stays the same", () => {
    const h = mount();
    try {
      const before = h.view.dom.querySelector<HTMLTableElement>("table")!.style.width;
      const from = h.doc.indexOf("2.7cm");
      h.view.dispatch({ changes: { from, to: from + 3, insert: "3.7" } });
      h.view.dispatch({ effects: reparseVisualLatex.of(undefined) });
      expect(h.view.dom.querySelector<HTMLTableElement>("table")!.style.width).not.toBe(before);
    } finally { h.dispose(); }
  });
});

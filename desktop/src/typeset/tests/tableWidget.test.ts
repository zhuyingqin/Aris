// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";
import { visualBlockClick, visualDecorations } from "../visualDecorations";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "en", languagePreferenceSet: true });
});

const TABLE_DOC = [
  "\\begin{document}",
  "\\begin{tabular}{lc}",
  "\\toprule",
  "Model & \\textbf{MAE} \\\\",
  "\\midrule",
  "ESN & 0.151 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{document}",
].join("\n");

function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      // Park the caret away from the table: a selection touching it reveals the
      // raw source instead of the grid.
      selection: EditorSelection.cursor(0),
      extensions: [visualDecorations, visualBlockClick],
    }),
  });
  return {
    view,
    cells: () => [...view.dom.querySelectorAll<HTMLElement>(".cm-vis-table-cell")],
    tool: (label: string) => view.dom.querySelector<HTMLElement>(`.cm-vis-table-tool[aria-label="${label}"]`),
    dispose: () => {
      view.destroy();
      parent.remove();
    },
  };
}

describe("visual table grid", () => {
  it("renders every cell as an editable grid cell", () => {
    const harness = mount(TABLE_DOC);
    try {
      expect(harness.cells().map((cell) => cell.textContent)).toEqual(["Model", "MAE", "ESN", "0.151"]);
      // Markup is rendered away until the cell is focused.
      expect(harness.cells()[1].textContent).toBe("MAE");
      expect(harness.tool("Insert row below")).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("reveals a cell's source on focus and writes back only that cell", () => {
    const harness = mount(TABLE_DOC);
    try {
      const mae = harness.cells()[1];
      mae.focus();
      // Committing the rendered "MAE" over `\textbf{MAE}` would drop the bold,
      // so focus swaps in the source first.
      expect(mae.textContent).toBe("\\textbf{MAE}");

      mae.textContent = "\\textbf{RMSE}";
      mae.blur();

      const doc = harness.view.state.doc.toString();
      expect(doc).toContain("Model & \\textbf{RMSE}");
      // Everything else is byte-identical: rules, the other row, the spec.
      expect(doc).toContain("\\toprule");
      expect(doc).toContain("\\midrule");
      expect(doc).toContain("ESN & 0.151");
      expect(doc).toContain("\\begin{tabular}{lc}");
    } finally {
      harness.dispose();
    }
  });

  it("commits through pointer gestures alone, without any focus event", () => {
    // Chromium withholds focus events while its window is not the focused one,
    // so a cell edited in a background window has to commit on the pointer.
    const harness = mount(TABLE_DOC);
    try {
      const cell = harness.cells()[0];
      cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(cell.textContent).toBe("Model");

      cell.textContent = "Method";
      window.dispatchEvent(new Event("pointerdown", { bubbles: true }));

      expect(harness.view.state.doc.toString()).toContain("Method & \\textbf{MAE}");
    } finally {
      harness.dispose();
    }
  });

  it("leaves the document alone when a cell is focused and left unchanged", () => {
    const harness = mount(TABLE_DOC);
    try {
      const before = harness.view.state.doc.toString();
      const cell = harness.cells()[0];
      cell.focus();
      cell.blur();
      expect(harness.view.state.doc.toString()).toBe(before);
    } finally {
      harness.dispose();
    }
  });

  it("inserts a row below the cell that was last focused", () => {
    const harness = mount(TABLE_DOC);
    try {
      harness.cells()[3].focus();
      harness.tool("Insert row below")!.click();

      const doc = harness.view.state.doc.toString();
      // Three rows now, and the empty one sits after the ESN row.
      expect(doc.match(/\\\\/g)?.length).toBe(3);
      expect(/ESN & 0\.151 \\\\\s*\n\s*&/.test(doc)).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("deletes a column from the spec and from every row at once", () => {
    const harness = mount(TABLE_DOC);
    try {
      harness.cells()[1].focus();
      harness.tool("Delete column")!.click();

      const doc = harness.view.state.doc.toString();
      expect(doc).toContain("\\begin{tabular}{l}");
      expect(doc).not.toContain("\\textbf{MAE}");
      expect(doc).not.toContain("0.151");
      expect(doc).toContain("Model");
      expect(doc).toContain("ESN");
    } finally {
      harness.dispose();
    }
  });

  it("changes a column's alignment through the spec, not the cells", () => {
    const harness = mount(TABLE_DOC);
    try {
      harness.cells()[0].focus();
      harness.tool("Align centre")!.click();
      expect(harness.view.state.doc.toString()).toContain("\\begin{tabular}{cc}");
    } finally {
      harness.dispose();
    }
  });

  it("strips every rule and border when borders are toggled off", () => {
    const harness = mount(TABLE_DOC);
    try {
      harness.cells()[0].focus();
      harness.tool("Toggle borders")!.click();

      const doc = harness.view.state.doc.toString();
      expect(doc).not.toContain("\\toprule");
      expect(doc).not.toContain("\\midrule");
      expect(doc).not.toContain("\\bottomrule");
      expect(doc).toContain("Model & \\textbf{MAE}");
    } finally {
      harness.dispose();
    }
  });

  it("leaves a longtable read-only rather than re-serializing its repeating header", () => {
    const harness = mount([
      "\\begin{document}",
      "\\begin{longtable}{ll}",
      "A & B \\\\",
      "\\endfirsthead",
      "C & D \\\\",
      "\\end{longtable}",
      "\\end{document}",
    ].join("\n"));
    try {
      // The environment still renders as a table…
      expect(harness.view.dom.querySelector(".cm-vis-table")).not.toBeNull();
      // …but nothing about it is editable: rewriting one would destroy the
      // \endfirsthead machinery that is the point of the environment.
      expect(harness.cells()).toHaveLength(0);
      expect(harness.tool("Insert row below")).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

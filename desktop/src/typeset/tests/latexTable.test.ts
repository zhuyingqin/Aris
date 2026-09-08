import { describe, expect, it } from "vitest";
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  parseColumnSpec,
  parseTable,
  serializeColumnSpec,
  serializeTable,
  setTableBorders,
  setTableColumnAlign,
  tableCellEdit,
  tableColumnCount,
} from "../latexTable";

const BOOKTABS = [
  "\\begin{tabular}{lcr}",
  "\\toprule",
  "Model & MAE & Coverage \\\\",
  "\\midrule",
  "SVR & 0.184 & 71.2\\% \\\\",
  "ESN & 0.151 & 78.4\\% \\\\",
  "\\bottomrule",
  "\\end{tabular}",
].join("\n");

function model(source: string) {
  const parsed = parseTable(source, 0, source.length);
  expect(parsed).toBeTruthy();
  return parsed!;
}

describe("parseColumnSpec", () => {
  it("round-trips borders, widths and inline decorations", () => {
    for (const spec of ["lcr", "|l|c|r|", "p{3cm}ll", ">{\\bfseries}c@{}l", "l|p{2in}|", "XcS"]) {
      const parsed = parseColumnSpec(spec);
      expect(serializeColumnSpec(parsed.columns, parsed.rightBorder)).toBe(spec);
    }
  });

  it("reads alignment per column and keeps the rest verbatim", () => {
    const { columns, rightBorder } = parseColumnSpec("|l|>{\\bfseries}c|p{3cm}|");
    expect(columns.map((column) => column.align)).toEqual(["l", "c", "other"]);
    expect(columns.map((column) => column.leftBorder)).toEqual([true, true, true]);
    expect(columns[1].raw).toBe(">{\\bfseries}c");
    expect(rightBorder).toBe(true);
  });
});

describe("parseTable", () => {
  it("keeps every cell's source range so a cell edit touches only that cell", () => {
    const table = model(BOOKTABS);
    expect(tableColumnCount(table)).toBe(3);
    expect(table.rows).toHaveLength(3);
    expect(table.rows.map((row) => row.rulesBefore)).toEqual([["\\toprule"], ["\\midrule"], []]);
    expect(table.trailingRules).toEqual(["\\bottomrule"]);
    expect(table.booktabs).toBe(true);

    // Escapes and markup survive: the model is the source, not a rendering.
    const coverage = table.rows[1].cells[2];
    expect(coverage.text).toBe("71.2\\%");
    expect(BOOKTABS.slice(coverage.from, coverage.to)).toBe("71.2\\%");
  });

  it("does not mistake a `\\\\` inside a cell for a row break", () => {
    const source = "\\begin{tabular}{ll}\nA \\shortstack{one\\\\two} & B \\\\\nC & D \\\\\n\\end{tabular}";
    const table = model(source);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells[0].text).toBe("A \\shortstack{one\\\\two}");
  });

  it("does not mistake an escaped `\\&` for a column break", () => {
    const source = "\\begin{tabular}{ll}\nAT\\&T & Bell \\\\\n\\end{tabular}";
    const table = model(source);
    expect(table.rows[0].cells.map((cell) => cell.text)).toEqual(["AT\\&T", "Bell"]);
  });

  it("reads the optional position argument and an hline-style table", () => {
    const source = "\\begin{tabular}[t]{|l|l|}\n\\hline\nA & B \\\\ \\hline\nC & D \\\\ \\hline\n\\end{tabular}";
    const table = model(source);
    expect(table.booktabs).toBe(false);
    expect(table.columns.map((column) => column.leftBorder)).toEqual([true, true]);
    expect(table.rightBorder).toBe(true);
    expect(table.rows).toHaveLength(2);
  });

  it("returns null rather than guessing at something it cannot parse", () => {
    expect(parseTable("\\begin{tabular}\nA & B\n\\end{tabular}", 0, 40)).toBeNull();
    expect(parseTable("\\begin{itemize}\\item a\\end{itemize}", 0, 34)).toBeNull();
  });
});

describe("serializeTable", () => {
  it("reproduces a table it has not been asked to change", () => {
    const table = model(BOOKTABS);
    const output = serializeTable(table);
    // Whitespace is normalised, so compare the parse of the output instead.
    const reparsed = model(output);
    expect(reparsed.rows.map((row) => row.cells.map((cell) => cell.text)))
      .toEqual(table.rows.map((row) => row.cells.map((cell) => cell.text)));
    expect(reparsed.rows.map((row) => row.rulesBefore)).toEqual(table.rows.map((row) => row.rulesBefore));
    expect(reparsed.trailingRules).toEqual(table.trailingRules);
    expect(serializeColumnSpec(reparsed.columns, reparsed.rightBorder)).toBe("lcr");
  });
});

describe("structural edits", () => {
  it("inserts and deletes rows without losing the rules around them", () => {
    const table = model(BOOKTABS);
    const withRow = insertTableRow(table, 1);
    expect(withRow.rows).toHaveLength(4);
    expect(withRow.rows[1].cells.map((cell) => cell.text)).toEqual(["", "", ""]);
    // The new row goes *after* the header, so \midrule stays with the body.
    expect(withRow.rows[2].rulesBefore).toEqual(["\\midrule"]);

    // Deleting the row that carries \toprule hands the rule to its successor,
    // otherwise the table loses its top border.
    const withoutHeader = deleteTableRow(table, 0);
    expect(withoutHeader.rows).toHaveLength(2);
    expect(withoutHeader.rows[0].rulesBefore).toEqual(["\\toprule", "\\midrule"]);

    // A one-row table cannot be emptied out from the toolbar.
    const single = model("\\begin{tabular}{l}\nA \\\\\n\\end{tabular}");
    expect(deleteTableRow(single, 0)).toBe(single);
  });

  it("inserts and deletes columns across every row and the spec together", () => {
    const table = model(BOOKTABS);
    const wider = insertTableColumn(table, 1);
    expect(serializeColumnSpec(wider.columns, wider.rightBorder)).toBe("llcr");
    expect(wider.rows.every((row) => row.cells.length === 4)).toBe(true);
    expect(wider.rows[0].cells.map((cell) => cell.text)).toEqual(["Model", "", "MAE", "Coverage"]);

    const narrower = deleteTableColumn(table, 0);
    expect(serializeColumnSpec(narrower.columns, narrower.rightBorder)).toBe("cr");
    expect(narrower.rows[0].cells.map((cell) => cell.text)).toEqual(["MAE", "Coverage"]);
  });

  it("pads a ragged table before a structural edit so the grid stays rectangular", () => {
    const source = "\\begin{tabular}{lll}\nA & B & C \\\\\nD \\\\\n\\end{tabular}";
    const table = model(source);
    const wider = insertTableColumn(table, 3);
    expect(wider.rows.map((row) => row.cells.length)).toEqual([4, 4]);
    expect(serializeTable(wider)).toContain("D &  &  & ");
  });

  it("changes alignment without discarding a column's decoration", () => {
    const table = model("\\begin{tabular}{>{\\bfseries}l p{3cm}}\nA & B \\\\\n\\end{tabular}");
    const centered = setTableColumnAlign(table, 0, "c");
    expect(centered.columns[0].raw).toBe(">{\\bfseries}c");
    // A `p{…}` column has no alignment letter to swap, so it becomes a plain one.
    const right = setTableColumnAlign(table, 1, "r");
    expect(right.columns[1].raw).toBe("r");
  });

  it("turns every border on and off as one state", () => {
    const table = model(BOOKTABS);
    const bordered = setTableBorders(table, true);
    expect(serializeColumnSpec(bordered.columns, bordered.rightBorder)).toBe("|l|c|r|");
    expect(bordered.rows[0].rulesBefore).toEqual(["\\toprule"]);
    expect(bordered.trailingRules).toEqual(["\\bottomrule"]);

    const bare = setTableBorders(table, false);
    expect(serializeColumnSpec(bare.columns, bare.rightBorder)).toBe("lcr");
    expect(bare.rows.every((row) => row.rulesBefore.length === 0)).toBe(true);
    expect(bare.trailingRules).toEqual([]);
  });
});

describe("tableCellEdit", () => {
  it("rewrites one cell in place and reports no change when there is none", () => {
    const table = model(BOOKTABS);
    const cell = table.rows[0].cells[1];
    expect(tableCellEdit(cell, "RMSE")).toEqual({ from: cell.from, to: cell.to, insert: "RMSE" });
    expect(tableCellEdit(cell, cell.text)).toBeNull();
    // A pasted newline would end the row; it is flattened instead.
    expect(tableCellEdit(cell, "one\ntwo")?.insert).toBe("one two");
  });

  it("refuses to write a cell that has no source of its own", () => {
    expect(tableCellEdit({ from: -1, to: -1, text: "" }, "x")).toBeNull();
  });
});

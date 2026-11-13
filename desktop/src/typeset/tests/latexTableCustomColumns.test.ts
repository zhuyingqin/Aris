import { describe, expect, it } from "vitest";
import source from "./fixtures/forecasting-model-groups.tex?raw";
import { insertTableColumn, insertTableRow, parseColumnSpec, parseTable, serializeColumnSpec, serializeTable, tableColumnCount } from "../latexTable";

function table(text = source) {
  const from = text.indexOf("\\begin{tabular}");
  const to = text.indexOf("\\end{tabular}") + "\\end{tabular}".length;
  const model = parseTable(text, from, to);
  expect(model).not.toBeNull();
  return model!;
}

describe("custom paragraph columns", () => {
  it("reads the user's table as six rows and four columns with exact cell offsets", () => {
    const model = table();
    expect(tableColumnCount(model)).toBe(4);
    expect(model.rows).toHaveLength(6);
    expect(model.rows.every((row) => row.cells.length === 4)).toBe(true);
    expect(model.columns.map((column) => column.raw)).toEqual(["@{}L{2.7cm}", "L{3.25cm}", "L{3.25cm}", "L{3.25cm}"]);
    expect(model.specSuffix).toBe("@{}");
    for (const row of model.rows) for (const cell of row.cells) {
      expect(source.slice(cell.from, cell.to)).toBe(cell.text);
    }
    expect(model.rows[0].cells[0].text).toBe("");
    expect(model.rows[5].cells[3].text).toBe("LSTM, Transformer, ESN");
  });

  it("keeps edge spacing, custom widths and four cells when a row is inserted", () => {
    const model = table();
    const next = serializeTable(insertTableRow(model, 3));
    const reparsed = table(next);
    expect(next).toContain("{@{}L{2.7cm}L{3.25cm}L{3.25cm}L{3.25cm}@{}}");
    expect(reparsed.rows).toHaveLength(7);
    expect(reparsed.rows.every((row) => row.cells.length === 4)).toBe(true);
    expect(reparsed.rows[3].cells.map((cell) => cell.text)).toEqual(["", "", "", ""]);
    expect(reparsed.trailingRules).toEqual(["\\bottomrule"]);
  });

  it("adds one column without splitting or removing existing column parameters", () => {
    const output = serializeTable(insertTableColumn(table(), 2));
    expect(output).toContain("{@{}L{2.7cm}L{3.25cm}lL{3.25cm}L{3.25cm}@{}}");
    expect(table(output).rows.every((row) => row.cells.length === 5)).toBe(true);
  });

  it("round-trips nested parameters, suffixes and paragraph postprocessors", () => {
    for (const spec of ["@{}L{2.7cm}L{3.25cm}@{}", ">{\\raggedright\\arraybackslash}p{2cm}<{\\relax}c", "S[table-format={2.2}]L{\\dimexpr 2cm+{1pt}\\relax}"]) {
      const parsed = parseColumnSpec(spec);
      expect(parsed.columns).toHaveLength(2);
      expect(serializeColumnSpec(parsed.columns, parsed.rightBorder, parsed.suffix)).toBe(spec);
    }
  });

  it("preserves optional vertical alignment during structural edits", () => {
    const input = source.replace("\\begin{tabular}{", "\\begin{tabular}\n[t]{");
    const output = serializeTable(insertTableRow(table(input), 2));
    expect(output).toContain("\\begin{tabular}\n[t]{@{}L{2.7cm}");
  });
});

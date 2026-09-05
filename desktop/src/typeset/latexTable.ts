/**
 * A lossless, position-aware model of a `tabular`/`longtable` environment — the
 * thing the Visual editor's table needs in order to be *edited* rather than
 * only rendered.
 *
 * The renderer's existing `parseTabular` is deliberately lossy: it strips
 * `\toprule`, unwraps `\textbf{…}` and drops escapes so the table reads as a
 * table. Nothing can be written back through it. This module keeps every cell's
 * absolute source range instead, so typing in a cell becomes one precise
 * `{from, to, insert}` change, and only structural edits (insert row, delete
 * column, change alignment) re-serialize the environment.
 *
 * Pure functions only — no CodeMirror, no DOM.
 */

export type TableColumnAlign = "l" | "c" | "r" | "other";

export type TableColumn = {
  /** Alignment for the toolbar; `other` covers p/m/b/X and anything exotic. */
  align: TableColumnAlign;
  /** The column's own spec text, e.g. `l` or `p{3cm}` or `>{\bfseries}c`. */
  raw: string;
  /** A `|` immediately before this column. */
  leftBorder: boolean;
};

export type TableCell = {
  /** Absolute offsets of the cell's *content*, trimmed of padding whitespace. */
  from: number;
  to: number;
  text: string;
};

export type TableRow = {
  cells: TableCell[];
  /** Rule commands that precede this row, verbatim (`\toprule`, `\hline`, …). */
  rulesBefore: string[];
};

export type TableModel = {
  environment: "tabular" | "longtable";
  /** Whole environment, `\begin{tabular}` … `\end{tabular}`. */
  from: number;
  to: number;
  /** Inside the braces of the column spec. */
  specFrom: number;
  specTo: number;
  columns: TableColumn[];
  /** A trailing `|` after the last column. */
  rightBorder: boolean;
  rows: TableRow[];
  /** Rules after the final row (`\bottomrule`, a closing `\hline`, …). */
  trailingRules: string[];
  bodyFrom: number;
  bodyTo: number;
  /** The table uses booktabs rules, so generated rules should match. */
  booktabs: boolean;
  /** Newline + indent the source uses between rows, reused when adding one. */
  rowSeparator: string;
};

const RULE_COMMANDS = ["toprule", "midrule", "bottomrule", "hline", "cmidrule", "addlinespace", "specialrule"];

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** Reads a `{…}`/`[…]`/`(…)` group starting at `index`, or returns `index`. */
function skipGroup(text: string, index: number, open: string, close: string): number {
  if (text[index] !== open) return index;
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === open) depth += 1;
    else if (text[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return index;
}

/**
 * Splits a column spec into columns. Decorations that are not columns of their
 * own (`@{…}`, `!{…}`, `>{…}`, `<{…}`) are carried on the column they qualify,
 * so an exotic spec still round-trips character for character.
 */
export function parseColumnSpec(spec: string): { columns: TableColumn[]; rightBorder: boolean } {
  const columns: TableColumn[] = [];
  let pendingBorder = false;
  let pendingPrefix = "";
  let cursor = 0;
  while (cursor < spec.length) {
    const char = spec[cursor];
    if (/\s/.test(char)) {
      pendingPrefix += char;
      cursor += 1;
      continue;
    }
    if (char === "|") {
      // A `|` after at least one column and with nothing left is the table's
      // right edge; otherwise it is the next column's left border.
      pendingBorder = true;
      cursor += 1;
      continue;
    }
    if (char === "@" || char === "!" || char === ">" || char === "<") {
      const end = skipGroup(spec, cursor + 1, "{", "}");
      pendingPrefix += spec.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (char === "p" || char === "m" || char === "b") {
      const end = skipGroup(spec, cursor + 1, "{", "}");
      columns.push({ align: "other", raw: pendingPrefix + spec.slice(cursor, end), leftBorder: pendingBorder });
      pendingBorder = false;
      pendingPrefix = "";
      cursor = end;
      continue;
    }
    if (char === "l" || char === "c" || char === "r") {
      columns.push({ align: char, raw: pendingPrefix + char, leftBorder: pendingBorder });
      pendingBorder = false;
      pendingPrefix = "";
      cursor += 1;
      continue;
    }
    // Anything else (X, S, *, a package's own letter) is still a column.
    columns.push({ align: "other", raw: pendingPrefix + char, leftBorder: pendingBorder });
    pendingBorder = false;
    pendingPrefix = "";
    cursor += 1;
  }
  return { columns, rightBorder: pendingBorder };
}

export function serializeColumnSpec(columns: readonly TableColumn[], rightBorder: boolean): string {
  return columns.map((column) => `${column.leftBorder ? "|" : ""}${column.raw}`).join("") + (rightBorder ? "|" : "");
}

/** Leading rule commands in `segment`, and where the cells start after them. */
function readRules(segment: string): { rules: string[]; rest: number } {
  const rules: string[] = [];
  let cursor = 0;
  for (;;) {
    while (cursor < segment.length && /\s/.test(segment[cursor])) cursor += 1;
    if (segment[cursor] !== "\\") break;
    const match = /^\\([A-Za-z]+)/.exec(segment.slice(cursor));
    if (!match || !RULE_COMMANDS.includes(match[1])) break;
    let end = cursor + match[0].length;
    end = skipGroup(segment, end, "(", ")");
    end = skipGroup(segment, end, "[", "]");
    end = skipGroup(segment, end, "{", "}");
    end = skipGroup(segment, end, "{", "}");
    rules.push(segment.slice(cursor, end).trim());
    cursor = end;
  }
  return { rules, rest: cursor };
}

/** Splits on `&` at brace depth 0, skipping `\&`. */
function splitCells(segment: string, offset: number): TableCell[] {
  const cells: TableCell[] = [];
  let depth = 0;
  let start = 0;
  const push = (from: number, to: number) => {
    let left = from;
    let right = to;
    while (left < right && /\s/.test(segment[left])) left += 1;
    while (right > left && /\s/.test(segment[right - 1])) right -= 1;
    cells.push({ from: offset + left, to: offset + right, text: segment.slice(left, right) });
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "&" && depth === 0) {
      push(start, index);
      start = index + 1;
    }
  }
  push(start, segment.length);
  return cells;
}

/**
 * Row breaks: `\\`, `\\*`, `\\[2pt]` at brace depth 0. A `\\` inside a cell's
 * own group (`\shortstack{a\\b}`) belongs to that cell, not to the table.
 */
function splitRowSegments(body: string): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === "\\" && body[index + 1] === "\\" && depth === 0) {
      segments.push({ from: start, to: index });
      index += 2;
      if (body[index] === "*") index += 1;
      index = skipGroup(body, index, "[", "]");
      start = index;
      continue;
    }
    if (char === "\\") {
      // Any other control sequence: step over its name so `\\` inside it is
      // never mistaken for a row break.
      index += 1;
      const name = /^[A-Za-z]+/.exec(body.slice(index));
      index += name ? name[0].length : 1;
      continue;
    }
    index += 1;
  }
  segments.push({ from: start, to: body.length });
  return segments;
}

/**
 * Builds the model for the environment that starts at `from` in `source`.
 * Returns null when the environment has no parseable column spec or no rows —
 * the caller then leaves the source alone rather than rewriting something it
 * does not understand.
 */
export function parseTable(source: string, from: number, to: number): TableModel | null {
  const header = /^\\begin\{(tabular|longtable)\}/.exec(source.slice(from, to));
  if (!header) return null;
  let cursor = from + header[0].length;
  // `\begin{tabular}[t]{ll}` — the optional vertical-position argument.
  cursor = skipGroup(source, cursor, "[", "]");
  while (cursor < to && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== "{") return null;
  const specEnd = matchBrace(source, cursor);
  if (specEnd < 0 || specEnd > to) return null;
  const specFrom = cursor + 1;
  const specTo = specEnd - 1;
  const { columns, rightBorder } = parseColumnSpec(source.slice(specFrom, specTo));
  if (columns.length === 0) return null;

  const endMarker = source.lastIndexOf(`\\end{${header[1]}}`, to);
  if (endMarker < specEnd) return null;
  const bodyFrom = specEnd;
  const bodyTo = endMarker;
  const body = source.slice(bodyFrom, bodyTo);

  const rows: TableRow[] = [];
  let trailingRules: string[] = [];
  const segments = splitRowSegments(body);
  segments.forEach((segment, index) => {
    const text = body.slice(segment.from, segment.to);
    const { rules, rest } = readRules(text);
    const remainder = text.slice(rest);
    const isLast = index === segments.length - 1;
    // The tail after the final `\\` is usually just rules and whitespace; a row
    // is only real if something other than rules is left.
    if (isLast && remainder.trim() === "") {
      trailingRules = rules;
      return;
    }
    rows.push({ rulesBefore: rules, cells: splitCells(remainder, bodyFrom + segment.from + rest) });
  });
  if (rows.length === 0) return null;

  const separatorMatch = /\\\\(\s*\n[ \t]*)/.exec(body);
  return {
    environment: header[1] as TableModel["environment"],
    from,
    to,
    specFrom,
    specTo,
    columns,
    rightBorder,
    rows,
    trailingRules,
    bodyFrom,
    bodyTo,
    booktabs: /\\(top|mid|bottom)rule/.test(body),
    rowSeparator: separatorMatch?.[1] ?? "\n",
  };
}

/** The widest row decides the column count the grid renders. */
export function tableColumnCount(model: TableModel): number {
  return Math.max(model.columns.length, ...model.rows.map((row) => row.cells.length));
}

export function serializeTable(model: TableModel): string {
  const separator = model.rowSeparator;
  const lines = model.rows.map((row) => {
    const rules = row.rulesBefore.length > 0 ? `${row.rulesBefore.join(" ")}${separator}` : "";
    return `${rules}${row.cells.map((cell) => cell.text).join(" & ")}`;
  });
  const trailing = model.trailingRules.length > 0 ? `${separator}${model.trailingRules.join(" ")}` : "";
  const body = `${separator}${lines.join(` \\\\${separator}`)} \\\\${trailing}${separator}`;
  const spec = serializeColumnSpec(model.columns, model.rightBorder);
  return `\\begin{${model.environment}}{${spec}}${body}\\end{${model.environment}}`;
}

function emptyCell(): TableCell {
  return { from: -1, to: -1, text: "" };
}

/** Pads every row to `width` so the grid is rectangular before an edit. */
function normalizeWidths(model: TableModel, width: number): TableModel {
  return {
    ...model,
    rows: model.rows.map((row) => ({
      ...row,
      cells: row.cells.length >= width
        ? row.cells
        : [...row.cells, ...Array.from({ length: width - row.cells.length }, emptyCell)],
    })),
  };
}

export function insertTableRow(model: TableModel, at: number): TableModel {
  const width = tableColumnCount(model);
  const padded = normalizeWidths(model, width);
  const index = Math.max(0, Math.min(at, padded.rows.length));
  const row: TableRow = { rulesBefore: [], cells: Array.from({ length: width }, emptyCell) };
  return { ...padded, rows: [...padded.rows.slice(0, index), row, ...padded.rows.slice(index)] };
}

export function deleteTableRow(model: TableModel, at: number): TableModel {
  if (model.rows.length <= 1) return model;
  const index = Math.max(0, Math.min(at, model.rows.length - 1));
  const removed = model.rows[index];
  const rows = model.rows.filter((_, position) => position !== index);
  // A deleted first row must not take `\toprule` with it.
  if (removed.rulesBefore.length > 0 && rows.length > 0 && index < rows.length) {
    rows[index] = { ...rows[index], rulesBefore: [...removed.rulesBefore, ...rows[index].rulesBefore] };
  }
  return { ...model, rows };
}

export function insertTableColumn(model: TableModel, at: number): TableModel {
  const width = tableColumnCount(model);
  const padded = normalizeWidths(model, width);
  const index = Math.max(0, Math.min(at, width));
  const template = padded.columns[Math.min(index, padded.columns.length - 1)];
  const column: TableColumn = { align: "l", raw: "l", leftBorder: template?.leftBorder ?? false };
  return {
    ...padded,
    columns: [...padded.columns.slice(0, index), column, ...padded.columns.slice(index)],
    rows: padded.rows.map((row) => ({
      ...row,
      cells: [...row.cells.slice(0, index), emptyCell(), ...row.cells.slice(index)],
    })),
  };
}

export function deleteTableColumn(model: TableModel, at: number): TableModel {
  const width = tableColumnCount(model);
  if (width <= 1) return model;
  const padded = normalizeWidths(model, width);
  const index = Math.max(0, Math.min(at, width - 1));
  return {
    ...padded,
    columns: padded.columns.filter((_, position) => position !== index),
    rows: padded.rows.map((row) => ({ ...row, cells: row.cells.filter((_, position) => position !== index) })),
  };
}

export function setTableColumnAlign(model: TableModel, at: number, align: "l" | "c" | "r"): TableModel {
  if (at < 0 || at >= model.columns.length) return model;
  const column = model.columns[at];
  // Keep any `>{…}`/`@{…}` decoration, replacing only the alignment letter.
  const raw = column.align === "other"
    ? align
    : column.raw.replace(/[lcr](?![^{]*\})/, align);
  return {
    ...model,
    columns: model.columns.map((candidate, index) =>
      index === at ? { ...candidate, align, raw: raw || align } : candidate),
  };
}

/** All-borders on, or all off — the two states a toolbar toggle can mean. */
export function setTableBorders(model: TableModel, enabled: boolean): TableModel {
  const rule = model.booktabs ? "\\midrule" : "\\hline";
  return {
    ...model,
    columns: model.columns.map((column, index) => ({ ...column, leftBorder: enabled && index > 0 ? true : enabled })),
    rightBorder: enabled,
    rows: model.rows.map((row, index) => ({
      ...row,
      rulesBefore: enabled
        ? (row.rulesBefore.length > 0 ? row.rulesBefore : [index === 0 ? (model.booktabs ? "\\toprule" : "\\hline") : rule])
        : [],
    })),
    trailingRules: enabled ? [model.booktabs ? "\\bottomrule" : "\\hline"] : [],
  };
}

/** The change that rewrites one cell in place, leaving the rest untouched. */
export function tableCellEdit(cell: TableCell, text: string): { from: number; to: number; insert: string } | null {
  if (cell.from < 0) return null;
  const insert = text.replace(/[\r\n]+/g, " ").trim();
  if (insert === cell.text) return null;
  return { from: cell.from, to: cell.to, insert };
}

/** The change that replaces the whole environment after a structural edit. */
export function tableStructureEdit(
  original: TableModel,
  next: TableModel,
): { from: number; to: number; insert: string } {
  return { from: original.from, to: original.to, insert: serializeTable(next) };
}

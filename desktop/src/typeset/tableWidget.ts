/**
 * The editable grid behind the Visual editor's `tabular` widget — our answer to
 * Overleaf's `table-generator`.
 *
 * Two kinds of edit, deliberately handled differently:
 *
 *  - **Typing in a cell** rewrites exactly that cell's source range
 *    (`tableCellEdit`), so the rest of the environment — rules, alignment,
 *    spacing, other cells — is untouched and the undo history stays granular.
 *  - **Structure** (insert/delete a row or column, alignment, borders)
 *    re-serializes the whole environment, because those changes cross every row.
 *
 * A focused cell shows its *source* (`\textbf{A}`), an unfocused one shows the
 * rendered text (`A`) — the same "caret inside reveals the markup" rule the rest
 * of the Visual editor follows. Without it, committing a rendered cell would
 * silently drop its formatting.
 */
import { EditorView } from "@codemirror/view";
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  setTableBorders,
  setTableColumnAlign,
  tableCellEdit,
  tableColumnCount,
  tableStructureEdit,
  type TableModel,
} from "./latexTable";

export type TableToolbarCopy = {
  tableLabel: string;
  toolbarLabel: string;
  insertRowAbove: string;
  insertRowBelow: string;
  deleteRow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  deleteColumn: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  toggleBorders: string;
  cellLabel: (row: number, column: number) => string;
};

/** Marks the cell the toolbar acts on. Kept on the DOM so a rebuilt widget can
 * restore it rather than snapping back to the top-left cell. */
const ACTIVE_CELL_ATTR = "data-vis-table-active";

function button(label: string, onClick: () => void, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-vis-table-tool";
  element.title = label;
  element.setAttribute("aria-label", label);
  element.textContent = text;
  element.addEventListener("mousedown", (event) => {
    // Keep the focused cell focused: a toolbar press must not blur-commit and
    // then act on a stale model.
    event.preventDefault();
  });
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return element;
}

export type TableGridOptions = {
  view: EditorView;
  /** Null when the environment could not be parsed losslessly; the grid then
   * renders read-only, exactly as it did before this editor existed. */
  model: TableModel | null;
  /** Display text per cell, markup stripped. */
  rendered: string[][];
  hasHeader: boolean;
  blockTargetClass: string;
  copy: TableToolbarCopy;
};

export function buildTableGrid(options: TableGridOptions): HTMLElement {
  const { view, model, rendered, hasHeader, copy } = options;
  const table = document.createElement("table");
  table.className = "cm-vis-table";

  if (!model) {
    renderStaticRows(table, rendered, hasHeader);
    return table;
  }

  const width = tableColumnCount(model);
  let active = { row: 0, column: 0 };

  const commitStructure = (next: TableModel) => {
    const change = tableStructureEdit(model, next);
    view.dispatch({ changes: change });
    view.focus();
  };

  const container = document.createElement("div");
  container.className = "cm-vis-table-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "cm-vis-table-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", copy.toolbarLabel);
  const group = (children: HTMLElement[]) => {
    const wrap = document.createElement("div");
    wrap.className = "cm-vis-table-tool-group";
    wrap.append(...children);
    return wrap;
  };
  toolbar.append(
    group([
      button(copy.insertRowAbove, () => commitStructure(insertTableRow(model, active.row)), "⤒"),
      button(copy.insertRowBelow, () => commitStructure(insertTableRow(model, active.row + 1)), "⤓"),
      button(copy.deleteRow, () => commitStructure(deleteTableRow(model, active.row)), "⊟"),
    ]),
    group([
      button(copy.insertColumnLeft, () => commitStructure(insertTableColumn(model, active.column)), "⇤"),
      button(copy.insertColumnRight, () => commitStructure(insertTableColumn(model, active.column + 1)), "⇥"),
      button(copy.deleteColumn, () => commitStructure(deleteTableColumn(model, active.column)), "⊠"),
    ]),
    group([
      button(copy.alignLeft, () => commitStructure(setTableColumnAlign(model, active.column, "l")), "⯇"),
      button(copy.alignCenter, () => commitStructure(setTableColumnAlign(model, active.column, "c")), "≡"),
      button(copy.alignRight, () => commitStructure(setTableColumnAlign(model, active.column, "r")), "⯈"),
    ]),
    group([
      button(
        copy.toggleBorders,
        () => commitStructure(setTableBorders(model, !hasAnyBorder(model))),
        "▦",
      ),
    ]),
  );

  model.rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const header = hasHeader && rowIndex === 0;
    for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
      const cell = row.cells[columnIndex];
      const td = document.createElement(header ? "th" : "td");
      td.textContent = rendered[rowIndex]?.[columnIndex] ?? cell?.text ?? "";
      td.dataset.row = String(rowIndex);
      td.dataset.column = String(columnIndex);
      td.setAttribute("aria-label", copy.cellLabel(rowIndex + 1, columnIndex + 1));
      const align = model.columns[columnIndex]?.align;
      if (align === "c" || align === "r") td.style.textAlign = align === "c" ? "center" : "right";

      // A cell with no source of its own (a ragged row) cannot be written to
      // in place; it becomes editable after the next structural edit pads it.
      if (cell && cell.from >= 0) {
        td.contentEditable = "true";
        td.spellcheck = false;
        td.className = "cm-vis-table-cell";
        // `contenteditable` alone does not put the cell in the focus model
        // everywhere, and this editor commits on focus loss — without a
        // tabindex the commit would simply never fire.
        td.tabIndex = -1;
        attachCellBehaviour(td, view, cell, () => {
          active = { row: rowIndex, column: columnIndex };
          markActive(table, td);
        });
      }
      tr.append(td);
    }
    table.append(tr);
  });

  container.append(toolbar, table);
  return container;
}

function hasAnyBorder(model: TableModel): boolean {
  return model.rightBorder
    || model.columns.some((column) => column.leftBorder)
    || model.rows.some((row) => row.rulesBefore.length > 0)
    || model.trailingRules.length > 0;
}

function markActive(table: HTMLElement, cell: HTMLElement): void {
  for (const previous of table.querySelectorAll(`[${ACTIVE_CELL_ATTR}]`)) {
    previous.removeAttribute(ACTIVE_CELL_ATTR);
  }
  cell.setAttribute(ACTIVE_CELL_ATTR, "true");
}

function attachCellBehaviour(
  td: HTMLElement,
  view: EditorView,
  cell: { from: number; to: number; text: string },
  onActivate: () => void,
): void {
  const rendered = td.textContent ?? "";
  let editing = false;

  /**
   * Commit when the pointer goes down anywhere else. Focus events alone are not
   * enough: Chromium withholds them while its window is not the focused one, so
   * a cell edited in a background window would silently never be written back.
   */
  const commitOnOutsidePointer = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && td.contains(target)) return;
    commit();
  };

  const activate = () => {
    if (editing) return;
    editing = true;
    onActivate();
    // Reveal the source so formatting survives a round trip: committing the
    // rendered "A" over a `\textbf{A}` cell would throw the markup away.
    if (td.textContent !== cell.text) td.textContent = cell.text;
    window.addEventListener("pointerdown", commitOnOutsidePointer, true);
  };

  function commit(): void {
    if (!editing) return;
    editing = false;
    window.removeEventListener("pointerdown", commitOnOutsidePointer, true);
    const change = tableCellEdit(cell, td.textContent ?? "");
    if (!change) {
      td.textContent = rendered;
      return;
    }
    view.dispatch({ changes: change });
  }

  // `focusin`/`focusout` bubble, so focus moving through a node the browser
  // created mid-edit (a split text node, a pasted span) still reaches these.
  td.addEventListener("pointerdown", activate);
  td.addEventListener("focusin", activate);
  td.addEventListener("focusout", commit);
  td.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // A newline would end the LaTeX row; Enter means "done with this cell".
      event.preventDefault();
      td.blur();
      view.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      td.textContent = cell.text;
      td.blur();
      view.focus();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      commit();
      const cells = [...(td.closest("table")?.querySelectorAll<HTMLElement>(".cm-vis-table-cell") ?? [])];
      const index = cells.indexOf(td);
      const next = cells[index + (event.shiftKey ? -1 : 1)];
      // The commit above replaces this widget, so the focus has to be queued
      // for after the decoration rebuild.
      if (next) window.setTimeout(() => next.focus(), 0);
    }
  });
  // Paste arrives as HTML from browsers; a table cell only ever wants text.
  td.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    selection.deleteFromDocument();
    selection.getRangeAt(0).insertNode(document.createTextNode(text.replace(/[\r\n]+/g, " ")));
    selection.collapseToEnd();
  });
}

function renderStaticRows(table: HTMLElement, rows: string[][], hasHeader: boolean): void {
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const header = hasHeader && index === 0;
    for (const cell of row) {
      const td = document.createElement(header ? "th" : "td");
      td.textContent = cell;
      tr.append(td);
    }
    table.append(tr);
  });
}

/**
 * True when the event came from an editable cell or the table toolbar, where
 * CodeMirror must keep its hands off entirely.
 *
 * Deliberately narrower than "anywhere in the grid": clicking the table's
 * margins still falls through to the block-click handler, which selects the
 * whole environment as one atomic range.
 */
export function isTableGridEvent(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Node)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest(".cm-vis-table-cell, .cm-vis-table-toolbar"));
}

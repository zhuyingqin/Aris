import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  onOpenCodeRange as onOpenCodeRangeFacet,
  visualBlockClick,
  visualDecorations,
  visualSourcePath,
} from "./visualDecorations";
import type { VisualPdfCursor } from "./visualModel";

type LatexListEnterInsertion = {
  insert: string;
  selection: number;
};

type LatexListEnvironment = {
  bodyFrom: number;
  bodyTo: number;
  from: number;
  kind: "itemize" | "enumerate";
};

function activeLatexListEnvironment(source: string, cursor: number): LatexListEnvironment | null {
  const stack: LatexListEnvironment[] = [];
  const envRe = /\\(begin|end)\{(itemize|enumerate)\}(?:\s*\[[^\]]*\])?/g;
  let active: LatexListEnvironment | null = null;
  let match: RegExpExecArray | null;
  while ((match = envRe.exec(source))) {
    const action = match[1];
    const kind = match[2] as "itemize" | "enumerate";
    if (action === "begin") {
      stack.push({ bodyFrom: envRe.lastIndex, bodyTo: source.length, from: match.index, kind });
      continue;
    }
    const index = stack.map((item) => item.kind).lastIndexOf(kind);
    if (index < 0) continue;
    const opened = stack.splice(index, 1)[0];
    const environment = { ...opened, bodyTo: match.index };
    if (cursor >= environment.bodyFrom && cursor <= environment.bodyTo && (!active || environment.from > active.from)) {
      active = environment;
    }
  }
  for (const environment of stack) {
    if (cursor >= environment.bodyFrom && cursor <= environment.bodyTo && (!active || environment.from > active.from)) {
      active = environment;
    }
  }
  return active;
}

function activeLatexListItem(source: string, cursor: number, environment: LatexListEnvironment): { indent: string; to: number } | null {
  const itemRe = /\\item(?![A-Za-z])(?:\s*\[[^\]]*\])?/g;
  itemRe.lastIndex = environment.bodyFrom;
  let active: { indent: string; to: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(source)) && match.index < environment.bodyTo) {
    if (match.index > cursor) break;
    const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, match.index))?.[0] ?? "";
    active = { indent, to: match.index + match[0].length };
  }
  return active;
}

export function latexListEnterInsertion(source: string, cursor: number): LatexListEnterInsertion | null {
  const safeCursor = Math.max(0, Math.min(cursor, source.length));
  const environment = activeLatexListEnvironment(source, safeCursor);
  if (!environment) return null;
  const item = activeLatexListItem(source, safeCursor, environment);
  if (!item) return null;
  if (safeCursor < item.to) return null;

  const insert = `\n${item.indent}\\item `;
  return { insert, selection: safeCursor + insert.length };
}

function insertLatexListItemOnEnter(view: EditorView): boolean {
  if (view.state.selection.ranges.length !== 1) return false;
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const source = view.state.doc.toString();
  const insertion = latexListEnterInsertion(source, range.from);
  if (!insertion) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: insertion.insert },
    selection: { anchor: insertion.selection },
    scrollIntoView: true,
  });
  return true;
}

/**
 * Overleaf-style visual editor built on CodeMirror 6.
 *
 * Unlike the retired block editor, this keeps the `.tex` source as a single
 * continuous document — the user can click anywhere and type, split paragraphs
 * with Enter, and the caret is never trapped inside pre-parsed boxes. Rich
 * rendering (headings, emphasis, math, citations) is layered on top as
 * CodeMirror decorations in later phases; Phase 0 is the editable surface.
 */
export function TypesetVisualEditor({
  path,
  draft,
  pdfCursor,
  onChange,
  onVisibleLineChange,
  onOpenCodeRange,
  onViewReady,
}: {
  path: string | null;
  draft: string;
  pdfCursor: VisualPdfCursor | null;
  onChange: (value: string) => void;
  onOpenCodeAtLine: (line: number) => void;
  onOpenCodeRange: (start: number, end: number) => void;
  onVisibleLineChange?: (line: number) => void;
  // Hands the live CodeMirror view up to the host so the toolbar can read/apply
  // the current selection (mirrors `editorRef` for the plain Code-mode textarea).
  onViewReady?: (view: EditorView | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourcePathCompartmentRef = useRef(new Compartment());
  const onOpenCodeRangeCompartmentRef = useRef(new Compartment());
  // Keep the latest onChange without recreating the editor on every render.
  const onChangeRef = useRef(onChange);
  const onVisibleLineChangeRef = useRef(onVisibleLineChange);
  const onViewReadyRef = useRef(onViewReady);
  onChangeRef.current = onChange;
  onVisibleLineChangeRef.current = onVisibleLineChange;
  onViewReadyRef.current = onViewReady;

  const reportVisibleLine = () => {
    const view = viewRef.current;
    const scroll = hostRef.current?.closest<HTMLElement>(".typeset-visual-scroll");
    if (!view || !scroll) return;
    const scrollRect = scroll.getBoundingClientRect();
    const hostRect = hostRef.current?.getBoundingClientRect();
    let pos = view.visibleRanges[0]?.from ?? view.viewport.from;
    try {
      const measuredPos = view.posAtCoords({
        x: (hostRect?.left ?? scrollRect.left) + 84,
        y: scrollRect.top + 32,
      }, false);
      if (typeof measuredPos === "number") pos = measuredPos;
    } catch {
      // jsdom does not implement the text range geometry CodeMirror uses here.
      // Browser builds take the precise branch above; tests use visibleRanges.
    }
    const line = view.state.doc.lineAt(pos).number;
    onVisibleLineChangeRef.current?.(line);
  };

  // Create the editor once; the doc is reconciled from `draft` in a separate
  // effect so external edits (Code mode, undo/redo, compile) flow in without
  // tearing down the view or losing the caret.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: draft,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          lineNumbers(),
          EditorView.lineWrapping,
          sourcePathCompartmentRef.current.of(visualSourcePath.of(path)),
          onOpenCodeRangeCompartmentRef.current.of(onOpenCodeRangeFacet.of(onOpenCodeRange)),
          Prec.high(keymap.of([{ key: "Enter", run: insertLatexListItemOnEnter }])),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          visualDecorations,
          visualBlockClick,
          visualTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.viewportChanged || update.focusChanged) {
              window.requestAnimationFrame(reportVisibleLine);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (import.meta.env.DEV) {
      (window as unknown as { __typesetView?: EditorView }).__typesetView = view;
    }
    onViewReadyRef.current?.(view);
    return () => {
      onViewReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: sourcePathCompartmentRef.current.reconfigure(visualSourcePath.of(path)),
    });
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: onOpenCodeRangeCompartmentRef.current.reconfigure(onOpenCodeRangeFacet.of(onOpenCodeRange)),
    });
  }, [onOpenCodeRange]);

  useEffect(() => {
    const scroll = hostRef.current?.closest<HTMLElement>(".typeset-visual-scroll");
    if (!scroll) return;
    let frame = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(reportVisibleLine);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external `draft` changes into the document. When the change came
  // from the user typing, `draft` already equals the doc, so this is a no-op.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== draft) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: draft },
      });
    }
  }, [draft]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pdfCursor) return;
    const safeStart = Math.max(0, Math.min(pdfCursor.start, view.state.doc.length));
    const safeEnd = Math.max(safeStart, Math.min(pdfCursor.end, view.state.doc.length));
    view.focus();
    view.dispatch({
      selection: { anchor: safeStart, head: safeEnd },
      effects: EditorView.scrollIntoView(safeStart, { y: "center" }),
    });
  }, [pdfCursor]);

  return (
    <section className="typeset-visual-pane ide-redesign-editor-content" aria-label="Visual editor">
      <div className="typeset-visual-scroll">
        <div className="typeset-visual-page latex-paper typeset-visual-cm" ref={hostRef} />
      </div>
    </section>
  );
}

/**
 * Editor chrome that makes CodeMirror read as the printed "page" rather than a
 * code buffer: TeX-like body font, source line numbers, and transparent
 * background so the white page shows through.
 */
const visualTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#000",
    backgroundColor: "transparent",
    fontFamily: '"KaTeX_Main", "Latin Modern Roman", "CMU Serif", "Times New Roman", Times, serif',
    fontSize: "17.5px",
    textRendering: "optimizeLegibility",
    WebkitFontSmoothing: "antialiased",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.33",
    overflow: "visible",
  },
  ".cm-gutters": {
    paddingRight: "14px",
    minWidth: "42px",
    borderRight: "0",
    backgroundColor: "transparent",
    color: "#9aa0a6",
    fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace',
    fontSize: "12px",
    lineHeight: "inherit",
  },
  ".cm-gutterElement": {
    padding: "0 8px 0 0",
    minWidth: "32px",
    textAlign: "right",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "#000",
    letterSpacing: "0",
    fontKerning: "normal",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#000",
  },
  "&.cm-editor .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgba(47, 139, 58, 0.18)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(47, 139, 58, 0.24)",
  },

  // --- Rich-text decorations (visualDecorations) ---
  ".cm-vis-bold": { fontWeight: "700" },
  ".cm-vis-italic": { fontStyle: "italic" },
  ".cm-vis-underline": { textDecoration: "underline" },
  ".cm-vis-mono": {
    fontFamily: 'var(--mono, ui-monospace, "Cascadia Code", Consolas, monospace)',
    fontSize: "0.92em",
  },
  ".cm-vis-smallcaps": { fontVariant: "small-caps" },
  ".cm-vis-sub": { verticalAlign: "sub", fontSize: "0.75em" },
  ".cm-vis-sup": { verticalAlign: "super", fontSize: "0.75em" },
  ".cm-vis-comment": { color: "#9aa0a6", fontStyle: "italic" },

  // Alignment environments applied per line.
  ".cm-vis-center": { textAlign: "center" },
  ".cm-vis-flushleft": { textAlign: "left" },
  ".cm-vis-flushright": { textAlign: "right" },

  // KaTeX-rendered math. Inline sits on the text baseline; display centers on its
  // own line, matching Overleaf's visual editor.
  // NOTE: block widgets use `padding`, never `margin`, for outer spacing. CodeMirror
  // measures a block decoration's own rendered box to compute line positions for
  // clicks/scrolling; a margin sits outside that box and isn't reliably counted,
  // so every click below a margined block drifts by roughly the margin amount
  // ("click needs to land a bit higher/lower"). Padding is part of the measured
  // box, so it doesn't have this problem. Applies to every rule below.
  ".cm-vis-math": { cursor: "text" },
  ".cm-vis-math .katex": { fontSize: "1.02em" },
  ".cm-vis-math-display": {
    display: "block",
    textAlign: "center",
    padding: "0.6em 0",
  },
  ".cm-vis-math-display .katex-display": { margin: "0" },
  // Active math source ("reveal raw LaTeX while the caret is inside a formula").
  // The callout band below is the *only* background layer for display math: a
  // mark decoration spanning several lines renders as one `<span>` per line, so
  // giving the mark its own fill+radius drew a stack of disconnected rounded
  // rectangles (one per source line) — a "brick of green boxes". Here the line
  // band alone carries the tint/accent, its outer corners rounded only on the
  // first/last line, so a multi-line formula reads as one continuous panel.
  ".cm-line.cm-vis-active-math-line": {
    backgroundColor: "rgba(47, 139, 58, 0.06)",
    boxShadow: "inset 2px 0 0 rgba(47, 139, 58, 0.45)",
    paddingLeft: "10px",
  },
  ".cm-line.cm-vis-active-math-line-first": {
    borderTopLeftRadius: "5px",
    borderTopRightRadius: "5px",
    paddingTop: "3px",
  },
  ".cm-line.cm-vis-active-math-line-last": {
    borderBottomLeftRadius: "5px",
    borderBottomRightRadius: "5px",
    paddingBottom: "3px",
  },
  // Shared text treatment: monospace + a muted ink tone (not flat black) so
  // revealed source reads as "raw markup", distinct from the serif prose
  // around it, without needing a filled box.
  ".cm-vis-active-math-source": {
    fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace',
    fontSize: "0.88em",
    color: "rgba(26, 74, 40, 0.86)",
  },
  // Inline math ($…$) is always a single short run — no multi-line seam risk —
  // so it gets its own soft pill background for extra legibility inside prose.
  ".cm-vis-active-math-source-inline": {
    borderRadius: "4px",
    backgroundColor: "rgba(47, 139, 58, 0.09)",
    padding: "0.05em 0.25em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },

  // Citation / reference / label / toc chips.
  ".cm-vis-chip": {
    display: "inline-block",
    padding: "0 6px",
    borderRadius: "3px",
    fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
    fontSize: "0.82em",
    lineHeight: "1.5",
    verticalAlign: "baseline",
    cursor: "text",
    whiteSpace: "nowrap",
  },
  ".cm-vis-chip-cite": {
    padding: "0 3px",
    borderRadius: "2px",
    background: "transparent",
    boxShadow: "inset 0 -0.13em 0 rgba(26, 86, 196, 0.2)",
    color: "#1a56c4",
    fontFamily: "inherit",
    fontSize: "0.95em",
    fontWeight: "600",
    lineHeight: "1.25",
  },
  ".cm-vis-chip-cite:hover": {
    background: "rgba(26, 86, 196, 0.08)",
    boxShadow: "inset 0 -0.16em 0 rgba(26, 86, 196, 0.28)",
  },
  ".cm-vis-chip-ref": { background: "#e6f4ea", color: "#1e7e34" },
  ".cm-vis-chip-label": { background: "#f1f3f4", color: "#80868b", fontSize: "0.76em" },
  ".cm-vis-chip-toc": { background: "#f6f7f9", color: "#3c4043", borderLeft: "3px solid #1a73e8" },

  // Lists: hang the marker in the left margin of the indented line.
  ".cm-vis-list-line": { paddingLeft: "1.45em", textIndent: "-1.05em" },
  ".cm-vis-item-marker": {
    display: "inline-block",
    minWidth: "0.85em",
    marginRight: "0.18em",
    color: "#000",
    fontWeight: "600",
  },

  // Figure placeholder card. No outer margin (see block-widget note above) — the
  // 8px of outer breathing room folds into the card's own padding instead.
  ".cm-vis-figure": {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    minHeight: "120px",
    padding: "28px 20px",
    border: "1px dashed #c4c7ccff",
    borderRadius: "6px",
    background: "#fafbfc",
  },
  ".cm-vis-figure img, .cm-vis-figure canvas": {
    maxWidth: "100%",
    maxHeight: "300px",
    objectFit: "contain",
  },
  ".cm-vis-figure-icon": { fontSize: "28px", lineHeight: "1" },
  ".cm-vis-figure-name": {
    fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
    fontSize: "13px",
    color: "#5f6368",
  },

  // Rendered table. The table itself keeps `margin: 0 auto` for horizontal
  // centering only (tables shrink-wrap, so this is needed) — zero vertical
  // margin. Outer vertical spacing is padding on the wrapper CM measures.
  ".cm-vis-table-wrap": { display: "block", padding: "10px 0" },
  ".cm-vis-table": {
    borderCollapse: "collapse",
    margin: "0 auto",
    fontSize: "0.9em",
  },
  ".cm-vis-table th, .cm-vis-table td": {
    padding: "4px 14px",
    textAlign: "left",
  },
  ".cm-vis-table thead, .cm-vis-table tr:first-child th": { fontWeight: "700" },
  ".cm-vis-table th": { borderBottom: "1.5px solid #000", fontWeight: "700" },
  ".cm-vis-table tr:last-child td": { borderBottom: "1px solid #000" },
  ".cm-vis-table tr:first-child td, .cm-vis-table tr:first-child th": { borderTop: "1.5px solid #000" },

  // Caption line.
  ".cm-vis-caption-line": { textAlign: "center" },
  ".cm-vis-caption": { fontSize: "0.88em", color: "#3c4043" },

  // \maketitle title block.
  ".cm-vis-title": { textAlign: "center", padding: "8px 0 30px" },
  ".cm-vis-title-name": { fontSize: "24px", fontWeight: "700", lineHeight: "1.18" },
  // IEEE-style `\authorblockN{…}\authorblockA{…}` extraction is newline-joined
  // (one line per name/affiliation block) — `pre-line` renders those breaks
  // instead of collapsing them into one run-on line.
  ".cm-vis-title-author": { fontSize: "15px", marginTop: "10px", lineHeight: "1.5", whiteSpace: "pre-line" },
  ".cm-vis-title-date": { fontSize: "13.5px", color: "#5f6368", marginTop: "6px" },
  // `\title{}`/`\author{}`/`\date{}` live in the always-folded preamble, so a
  // click here jumps to Code mode with that source selected (see TitleWidget)
  // rather than revealing inline like math/abstract do. Underline-on-hover
  // signals "editable, but elsewhere" instead of implying an inline reveal.
  ".cm-vis-title-editable": { cursor: "pointer", borderRadius: "3px" },
  ".cm-vis-title-editable:hover": {
    boxShadow: "inset 0 -0.1em 0 rgba(47, 139, 58, 0.45)",
  },

  // \begin{abstract}: a bold label in place of the hidden \begin marker, then
  // an italicized, gently indented body so it reads as a distinct block quote
  // rather than a plain paragraph.
  ".cm-vis-section-label": { fontWeight: "700", fontSize: "0.95em", margin: "18px 0 4px" },
  ".cm-vis-abstract-line": {
    fontStyle: "italic",
    paddingLeft: "22px",
    paddingRight: "22px",
    color: "#3c3f42",
  },

  // Section headings: same serif family as body, bold, with TeX-like spacing. This is a LINE
  // decoration (applied to `.cm-line` itself), so the margin→padding rule above
  // applies doubly here — margin on a `.cm-line` is the single biggest source of
  // click-position drift, since every line below inherits the accumulated error.
  ".cm-vis-heading-line": {
    fontFamily: "inherit",
    fontWeight: "700",
    color: "#000",
    lineHeight: "1.18",
  },
  ".cm-vis-heading-1": { fontSize: "24.5px", paddingTop: "22px" },
  ".cm-vis-heading-2": { fontSize: "20px", paddingTop: "16px" },
  ".cm-vis-heading-3": { fontSize: "18px", paddingTop: "12px" },
  ".cm-vis-heading-4": { fontSize: "17.5px", paddingTop: "10px" },
  ".cm-vis-h1": { fontSize: "24.5px" },
  ".cm-vis-h2": { fontSize: "20px" },
  ".cm-vis-h3": { fontSize: "18px" },
  ".cm-vis-h4": { fontSize: "17.5px" },
  ".cm-vis-secnum": {
    marginRight: "0.5em",
    fontVariantNumeric: "tabular-nums",
    color: "#000",
  },

  // Folded preamble chip. It's the very first block in the document — a margin
  // here would throw off click-position math for EVERY line below it (the error
  // compounds down the whole page), so its 4px/20px outer spacing folds into
  // padding instead, same as every other block widget (see note above).
  ".cm-vis-preamble": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    paddingTop: "15px",
    paddingBottom: "31px",
    paddingLeft: "16px",
    paddingRight: "16px",
    borderLeft: "3px solid #1a73e8",
    borderRadius: "0 8px 8px 0",
    background: "#f6f7f9",
    color: "#3c4043",
    font: '14px/1.3 "Helvetica Neue", Arial, sans-serif',
    cursor: "default",
    userSelect: "none",
  },
  ".cm-vis-preamble strong": { color: "#80868b", fontSize: "12px", fontWeight: "600" },
});

import { useEffect, useRef } from "react";
import { Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { createSharedEditorView, reconfigureReadOnly } from "../editor/editorView";
import {
  editorKeybindingsFacet,
  visualTypographyFor,
  type EditorSettings,
} from "../editor/editorSettings";
import { useEditorSettings } from "../editor/useEditorSettings";
import { latexVscodeHighlighting } from "../editor/latexVscodeHighlighting";
import type { SharedEditorHandle } from "../editor/editorTypes";
import {
  diffDecorations,
  dispatchDiffLines,
  dispatchReviewHunks,
  reviewHunkDecorations,
  type CodeDiffLine,
  type CodeReviewConfig,
} from "../editor/editorDecorations";
import {
  onForwardSearch as onForwardSearchFacet,
  onOpenCodeRange as onOpenCodeRangeFacet,
  visualBlockClick,
  visualDecorationsExtension,
  visualForwardSearchClick,
  visualNumbering as visualNumberingFacet,
  visualSourcePath,
} from "./visualDecorations";
import type { SectionNumberingPrefix } from "./outlineModel";
import type { VisualPdfCursor } from "./visualModel";
import { scanLatexStructure } from "./latexStructure";
import { latexHtmlPaste, latexImagePaste } from "./latexHtmlPaste";

declare global {
  interface Window {
    /** DEV-only, test-only handle for the live Typeset visual editor. */
    __typesetView?: EditorView;
  }
}

type LatexListEnterInsertion = {
  insert: string;
  selection: number;
};

const LIST_ENVIRONMENTS = new Set(["itemize", "enumerate"]);

export function latexListEnterInsertion(source: string, cursor: number): LatexListEnterInsertion | null {
  const safeCursor = Math.max(0, Math.min(cursor, source.length));
  const structure = scanLatexStructure(source);
  if (structure.isIgnored(Math.max(0, safeCursor - 1)) || structure.isMath(Math.max(0, safeCursor - 1))) return null;
  const environment = structure.environmentAt(safeCursor, LIST_ENVIRONMENTS);
  if (!environment) return null;
  // A nested environment owns Enter while the caret is inside it. In
  // particular, never inject an item into equation/figure/quote/code bodies.
  if (structure.environmentAt(safeCursor) !== environment) return null;
  const item = structure.commands
    .filter((command) => command.name === "item"
      && command.from >= environment.bodyFrom
      && command.from < environment.bodyTo
      && command.from <= safeCursor
      && structure.environmentAt(command.from, LIST_ENVIRONMENTS) === environment)
    .at(-1);
  if (!item) return null;
  if (safeCursor < item.to) return null;

  const lineStart = source.lastIndexOf("\n", item.from - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, item.from))?.[0] ?? "";
  const insert = `\n${indent}\\item `;
  return { insert, selection: safeCursor + insert.length };
}

function insertLatexListItemOnEnter(view: EditorView): boolean {
  // A modal keymap owns Enter (open line below in Vim normal mode, and Emacs
  // binds it too). Continuing the list from underneath would fight it, so this
  // convenience stands down whenever the user has chosen one.
  if (view.state.facet(editorKeybindingsFacet) !== "default") return false;
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

/** CodeMirror leaves `spellcheck` to the browser default, so it has to be set
 * (and unset) explicitly for the toggle to mean anything. `autocorrect` and
 * capitalisation stay off — silently rewriting a command name would corrupt the
 * source.
 *
 * `lang` is what decides *which* dictionary the platform checker uses. Without
 * it the webview falls back to the OS UI language, which is why a Chinese
 * thesis written in English used to come back underlined end to end. */
function spellCheckAttributes(enabled: boolean, language: string | null): Extension {
  return EditorView.contentAttributes.of({
    spellcheck: enabled && language ? "true" : "false",
    ...(language ? { lang: language } : {}),
    autocorrect: "off",
    autocapitalize: "off",
  });
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
  numbering,
  pdfCursor,
  onChange,
  onVisibleLineChange,
  onOpenCodeRange,
  onForwardSearch,
  onViewReady,
  onPasteImage,
  onPasteError,
  spellCheck = false,
  spellCheckLanguage = null,
  readOnly = false,
  diffLines = [],
  reviewHunks = null,
}: {
  path: string | null;
  draft: string;
  /** Where this file sits in the document's heading numbering, so an `\input`
   * chapter shows the numbers its compiled PDF shows. Null while the project
   * graph is still loading, or for a file that has no headings of its own. */
  numbering: SectionNumberingPrefix | null;
  pdfCursor: VisualPdfCursor | null;
  onChange: (value: string) => void;
  onOpenCodeRange: (start: number, end: number) => void;
  onVisibleLineChange?: (line: number) => void;
  // Double-click forward-search: jump the compiled PDF preview to this
  // source line/column (see `visualForwardSearchClick` in visualDecorations).
  onForwardSearch?: (line: number, column: number) => void;
  // Hands the live CodeMirror view up to the host so the toolbar can read/apply
  // the current selection (mirrors `editorRef` for the plain Code-mode textarea).
  onViewReady?: (view: EditorView | null) => void;
  /** Persist a clipboard image and return the LaTeX inserted at the caret. */
  onPasteImage?: (file: File) => Promise<string | null>;
  onPasteError?: (error: unknown) => void;
  /** Native spell checking. Only ever enabled here: with commands and math
   * rendered away, what the browser sees is prose, unlike Code mode where
   * every macro would be underlined. */
  spellCheck?: boolean;
  /** BCP-47 tag for the platform dictionary; null turns checking off. */
  spellCheckLanguage?: string | null;
  /** Freezes the source (an in-flight save); reviews stay writable. */
  readOnly?: boolean;
  /** Review-mode change markers shared with the Code surface. */
  diffLines?: CodeDiffLine[];
  /** Accept/reject controls anchored to each changed block. */
  reviewHunks?: CodeReviewConfig | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SharedEditorHandle | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourcePathCompartmentRef = useRef(new Compartment());
  const numberingCompartmentRef = useRef(new Compartment());
  const onOpenCodeRangeCompartmentRef = useRef(new Compartment());
  const onForwardSearchCompartmentRef = useRef(new Compartment());
  const spellCheckCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  // The page scales with the shared font-size setting; everything else about
  // the Visual surface's typography stays its own.
  const editorSettings = useEditorSettings();
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;
  // Keep the latest onChange without recreating the editor on every render.
  const onChangeRef = useRef(onChange);
  const onVisibleLineChangeRef = useRef(onVisibleLineChange);
  const onViewReadyRef = useRef(onViewReady);
  const onPasteImageRef = useRef(onPasteImage);
  const onPasteErrorRef = useRef(onPasteError);
  const isBeamer = /\\documentclass(?:\[[^\]]*])?\{beamer\}/.test(draft);
  onChangeRef.current = onChange;
  onVisibleLineChangeRef.current = onVisibleLineChange;
  onViewReadyRef.current = onViewReady;
  onPasteImageRef.current = onPasteImage;
  onPasteErrorRef.current = onPasteError;

  const reportVisibleLine = () => {
    const view = viewRef.current;
    const editorBody = hostRef.current?.closest<HTMLElement>(".typeset-editor-body");
    if (editorBody?.getAttribute("aria-hidden") === "true") return;
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

  // Create the editor once, via the shared kernel factory (history, selection,
  // bracket/search/keymap base extensions — see desktop/src/editor/editorState.ts);
  // the doc is reconciled from `draft` in a separate effect so external edits
  // (Code mode, undo/redo, compile) flow in without tearing down the view or
  // losing the caret. Visual decorations continue to own rendered content, but
  // the underlying source now uses the same LaTeX parser and VS Code palette as
  // Code mode whenever markup is exposed for editing.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createSharedEditorView(host, {
      doc: draft,
      language: "latex",
      surface: "typeset",
      readOnly,
      extensions: [
        EditorView.lineWrapping,
        sourcePathCompartmentRef.current.of(visualSourcePath.of(path)),
        numberingCompartmentRef.current.of(visualNumberingFacet.of(numbering)),
        onOpenCodeRangeCompartmentRef.current.of(onOpenCodeRangeFacet.of(onOpenCodeRange)),
        onForwardSearchCompartmentRef.current.of(onForwardSearchFacet.of(onForwardSearch ?? null)),
        spellCheckCompartmentRef.current.of(spellCheckAttributes(spellCheck, spellCheckLanguage)),
        latexHtmlPaste,
        latexImagePaste(
          (file) => onPasteImageRef.current?.(file) ?? Promise.resolve(null),
          (error) => onPasteErrorRef.current?.(error),
        ),
        Prec.high(keymap.of([{ key: "Enter", run: insertLatexListItemOnEnter }])),
        latexVscodeHighlighting,
        // Visual mode already uses full-line diff backgrounds. Its structural
        // blocks also draw their own left edge, so a Code-style gutter marker
        // creates the doubled green rails reported in review mode.
        diffDecorations(diffLines, { gutter: false }),
        reviewHunkDecorations(reviewHunks),
        visualDecorationsExtension,
        visualBlockClick,
        visualForwardSearchClick,
        themeCompartmentRef.current.of(visualThemeFor(editorSettingsRef.current)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || (update.focusChanged && update.view.hasFocus)) {
            // Cursor navigation is the user's strongest location signal. Using
            // the viewport top here made a click on line 122 still report line
            // 93, leaving the toolbar at "No section" above a visible chapter.
            const line = update.state.doc.lineAt(update.state.selection.main.head).number;
            onVisibleLineChangeRef.current?.(line);
          } else if (update.viewportChanged || update.focusChanged) {
            window.requestAnimationFrame(reportVisibleLine);
          }
        }),
      ],
    });
    handleRef.current = handle;
    viewRef.current = handle.view;
    if (import.meta.env.DEV) {
      (window as unknown as { __typesetView?: EditorView }).__typesetView = handle.view;
    }
    onViewReadyRef.current?.(handle.view);
    return () => {
      onViewReadyRef.current?.(null);
      handle.destroy();
      handleRef.current = null;
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view) reconfigureReadOnly(view, readOnly);
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) dispatchDiffLines(view, diffLines);
  }, [diffLines]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) dispatchReviewHunks(view, reviewHunks);
  }, [reviewHunks]);

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
      effects: spellCheckCompartmentRef.current.reconfigure(spellCheckAttributes(spellCheck, spellCheckLanguage)),
    });
  }, [spellCheck, spellCheckLanguage]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeCompartmentRef.current.reconfigure(visualThemeFor(editorSettings)) });
  }, [editorSettings]);

  // The prefix moves when the project graph resolves, when another chapter
  // gains or loses a heading, or when the compile root changes — each of which
  // shifts every number in this file.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: numberingCompartmentRef.current.reconfigure(visualNumberingFacet.of(numbering)),
    });
  }, [numbering]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: onOpenCodeRangeCompartmentRef.current.reconfigure(onOpenCodeRangeFacet.of(onOpenCodeRange)),
    });
  }, [onOpenCodeRange]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: onForwardSearchCompartmentRef.current.reconfigure(onForwardSearchFacet.of(onForwardSearch ?? null)),
    });
  }, [onForwardSearch]);

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
  // `setDocument` diffs the common prefix/suffix so an external edit maps the
  // caret through the *changed* range instead of resetting it (see editorView.ts).
  useEffect(() => {
    handleRef.current?.setDocument(draft, { addToHistory: false, preserveSelection: true });
  }, [draft]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pdfCursor) return;
    const safeStart = Math.max(0, Math.min(pdfCursor.start, view.state.doc.length));
    const activeElement = document.activeElement;
    const editingFormField = activeElement instanceof HTMLInputElement
      || activeElement instanceof HTMLTextAreaElement
      || activeElement instanceof HTMLSelectElement
      || Boolean(activeElement && (activeElement as HTMLElement).isContentEditable);
    // A reverse-search click should focus the source, but an unrelated toolbar
    // form field must keep its focus while the PDF cursor changes in the background.
    if (!editingFormField) view.focus();
    view.dispatch({
      // Reverse search is navigation, not a text-selection command. A collapsed
      // cursor keeps the active source line visible without painting a large
      // selection when one PDF text item maps to a whole paragraph.
      selection: { anchor: safeStart },
      effects: EditorView.scrollIntoView(safeStart, { y: "center" }),
    });
  }, [pdfCursor]);

  return (
    <section className="typeset-visual-pane ide-redesign-editor-content" aria-label="Visual editor">
      <div className="typeset-visual-scroll">
        <div
          className={`typeset-visual-page typeset-visual-cm ${isBeamer ? "beamer-deck" : "latex-paper"}`}
          data-document-kind={isBeamer ? "slides" : "paper"}
          ref={hostRef}
        />
      </div>
    </section>
  );
}

/**
 * Editor chrome that makes CodeMirror read as a visual document while sharing
 * the same dark surfaces and semantic colors as Code mode.
 */
const VISUAL_EDITOR_LINE_HEIGHT = "23.275px";

export const visualThemeSpec: Parameters<typeof EditorView.theme>[0] = {
  "&": {
    height: "100%",
    color: "var(--visual-text)",
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
    lineHeight: VISUAL_EDITOR_LINE_HEIGHT,
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    overflow: "visible",
  },
  ".cm-gutters": {
    paddingRight: "1px",
    minWidth: "24px",
    borderRight: "0",
    backgroundColor: "transparent",
    color: "var(--visual-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    fontWeight: "500",
    // A unitless inherited line-height is recalculated against this smaller
    // font, pinning line numbers to the top of each visual source line.
    // Keep the gutter line box identical to the prose line box instead.
    lineHeight: VISUAL_EDITOR_LINE_HEIGHT,
  },
  ".cm-gutterElement": {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "0 1px 0 0",
    minWidth: "28px",
    textAlign: "right",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    // A visual line can be taller than its source text (heading spacing,
    // block widgets, etc.). Centre its source line number inside the real
    // CodeMirror line box instead of pinning it to the top padding.
    paddingTop: "0",
    fontVariantNumeric: "tabular-nums",
  },
  // These marker classes remain useful to decoration consumers, but all
  // headings use the same flex-centred gutter alignment above.
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-heading-1": {
    paddingTop: "0",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-heading-2": {
    paddingTop: "0",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-heading-3": {
    paddingTop: "0",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-heading-4": {
    paddingTop: "0",
  },
  // The preamble is a real block widget. Its line number is emitted through
  // lineNumberWidgetMarker and follows the widget's own 15px content inset.
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-preamble": {
    paddingTop: "15px",
    lineHeight: "18.2px",
  },
  ".cm-content": {
    // CodeMirror's base theme makes this a non-shrinking flex item. With an
    // outer (page-level) scroller, one wide widget would therefore enlarge the
    // entire document and center later blocks inside that invisible width.
    // Let the content consume only the space left after the gutter.
    flex: "1 1 0",
    width: "auto",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    padding: "0",
    caretColor: "var(--visual-accent-bright)",
    letterSpacing: "0",
    fontKerning: "normal",
  },
  ".cm-line": {
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    padding: "0",
  },
  ".cm-line.cm-vis-structural-only-line": {
    height: "0",
    minHeight: "0",
    lineHeight: "0",
    overflow: "hidden",
    padding: "0",
  },
  ".cm-lineNumbers .cm-gutterElement.cm-vis-gutter-structural-only": {
    display: "none",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--visual-accent-bright)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "rgba(47, 139, 58, 0.08)",
  },
  // During a drag the selection head crosses source lines continuously. The
  // normal active-line tint would chase it through the document and look like
  // the section is flashing, even though the decorations themselves are now
  // frozen. Restore the tint on mouseup, when there is one stable active line.
  "&.cm-vis-pointer-selecting .cm-activeLine, &.cm-vis-pointer-selecting .cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  "&.cm-editor > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--visual-selection-bg)",
    borderRadius: "1px",
    boxShadow: "inset 0 0 0 1px var(--visual-selection-border)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--visual-selection-bg-focused)",
    boxShadow: "inset 0 0 0 1px var(--visual-selection-border-focused)",
  },

  // --- Rich-text decorations (visualDecorations) ---
  ".cm-vis-bold": { fontWeight: "700" },
  ".cm-vis-italic": { fontStyle: "italic" },
  ".cm-vis-underline": { textDecoration: "underline" },
  ".cm-vis-mono": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
  },
  ".cm-vis-smallcaps": { fontVariant: "small-caps" },
  ".cm-vis-sub": { verticalAlign: "sub", fontSize: "0.75em" },
  ".cm-vis-sup": { verticalAlign: "super", fontSize: "0.75em" },
  ".cm-vis-comment": { color: "#6a9955", fontStyle: "italic" },
  // A footnote reads as the marker the PDF prints; its text is on hover, the
  // way it is on the page rather than in the middle of the sentence.
  ".cm-vis-footnote": {
    padding: "0 0.1em",
    color: "var(--visual-link)",
    cursor: "help",
    fontSize: "0.72em",
    fontWeight: "700",
    verticalAlign: "super",
  },
  // Rendered `~`, `---`, quotes and spacing macros. No styling of their own —
  // they are body text now — beyond a hint that the source differs.
  ".cm-vis-typographic": { cursor: "text" },

  // Beamer frames remain one continuous source document, but the line
  // decorations give every slide a stable visual boundary. Entering the frame
  // reveals its source in place, so editing never leaves the visual surface.
  ".cm-line.cm-vis-frame-line": {
    paddingLeft: "18px",
    paddingRight: "18px",
    backgroundColor: "var(--visual-slide-bg)",
    boxShadow: "inset 1px 0 var(--visual-border-strong), inset -1px 0 var(--visual-border-strong)",
  },
  ".cm-line.cm-vis-frame-first": {
    paddingTop: "24px",
    borderTopLeftRadius: "9px",
    borderTopRightRadius: "9px",
    boxShadow: "inset 0 1px var(--visual-border-strong), inset 1px 0 var(--visual-border-strong), inset -1px 0 var(--visual-border-strong)",
  },
  ".cm-line.cm-vis-frame-last": {
    paddingBottom: "15px",
    borderBottomLeftRadius: "9px",
    borderBottomRightRadius: "9px",
    boxShadow: "inset 0 -1px var(--visual-border-strong), inset 1px 0 var(--visual-border-strong), inset -1px 0 var(--visual-border-strong)",
  },
  ".cm-vis-frame-title": {
    minWidth: "0",
    color: "var(--visual-accent-bright)",
    fontFamily: "var(--font-sans)",
    fontSize: "1.18em",
    fontWeight: "700",
    lineHeight: "1.35",
    overflowWrap: "anywhere",
  },
  ".cm-vis-frame-kicker": {
    display: "inline-flex",
    marginRight: "8px",
    padding: "2px 6px",
    border: "1px solid var(--visual-border-strong)",
    borderRadius: "999px",
    color: "var(--visual-muted)",
    font: '600 10px/1.35 "Segoe UI", system-ui, sans-serif',
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    verticalAlign: "0.2em",
  },

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
  ".cm-vis-math": {
    cursor: "text",
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  ".cm-vis-math .katex, .cm-vis-math .katex .katex-html, .cm-vis-math .katex .katex-html *": {
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  ".cm-vis-math .katex": { fontSize: "1.02em" },
  ".cm-vis-math-display": {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    overflowX: "auto",
    overflowY: "hidden",
    textAlign: "center",
    padding: "0.6em 0",
    scrollbarWidth: "thin",
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
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
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
    display: "inline-flex",
    alignItems: "center",
    padding: "0 6px",
    borderRadius: "4px",
    fontFamily: "var(--font-sans)",
    fontSize: "0.82em",
    lineHeight: "1.45",
    verticalAlign: "0.06em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    transition: "all 0.15s ease",
  },
  ".cm-vis-chip-cite": {
    padding: "0 6px",
    borderRadius: "4px",
    background: "color-mix(in srgb, #6366f1 9%, transparent)",
    border: "1px solid color-mix(in srgb, #6366f1 26%, transparent)",
    color: "color-mix(in srgb, #4f46e5 92%, var(--visual-text))",
    fontFamily: "var(--font-sans)",
    fontSize: "0.82em",
    fontWeight: "500",
    lineHeight: "1.4",
  },
  ".cm-vis-chip-cite:hover": {
    background: "color-mix(in srgb, #6366f1 18%, transparent)",
    borderColor: "color-mix(in srgb, #6366f1 48%, transparent)",
    boxShadow: "0 1px 3px rgba(99, 102, 241, 0.18)",
  },
  ".cm-vis-chip-cite::before": {
    content: '""',
    display: "inline-block",
    width: "10px",
    height: "10px",
    marginRight: "3.5px",
    backgroundColor: "currentColor",
    mask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 14 14\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M2 3h4a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0-1.5-1.5H2V3zm10 0H8a2 2 0 0 0-2 2v6a1.5 1.5 0 0 1 1.5-1.5H12V3z\'/%3E%3C/svg%3E") no-repeat center / contain',
    WebkitMask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 14 14\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M2 3h4a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0-1.5-1.5H2V3zm10 0H8a2 2 0 0 0-2 2v6a1.5 1.5 0 0 1 1.5-1.5H12V3z\'/%3E%3C/svg%3E") no-repeat center / contain',
    opacity: "0.8",
    verticalAlign: "-0.05em",
    flexShrink: "0",
  },
  ".cm-vis-chip-ref": {
    padding: "0 6px",
    borderRadius: "4px",
    background: "color-mix(in srgb, var(--visual-link) 9%, transparent)",
    border: "1px solid color-mix(in srgb, var(--visual-link) 26%, transparent)",
    color: "var(--visual-link)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.82em",
    fontWeight: "500",
    lineHeight: "1.4",
  },
  ".cm-vis-chip-ref:hover": {
    background: "color-mix(in srgb, var(--visual-link) 18%, transparent)",
    borderColor: "color-mix(in srgb, var(--visual-link) 48%, transparent)",
    boxShadow: "0 1px 3px color-mix(in srgb, var(--visual-link) 20%, transparent)",
  },
  ".cm-vis-chip-ref::before": {
    content: '""',
    display: "inline-block",
    width: "9.5px",
    height: "9.5px",
    marginRight: "3px",
    backgroundColor: "currentColor",
    mask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.8\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M3.5 8.5l5-5M4 3.5h4.5v4.5\'/%3E%3C/svg%3E") no-repeat center / contain',
    WebkitMask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.8\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M3.5 8.5l5-5M4 3.5h4.5v4.5\'/%3E%3C/svg%3E") no-repeat center / contain',
    opacity: "0.8",
    verticalAlign: "-0.05em",
    flexShrink: "0",
  },
  ".cm-vis-link": {
    color: "var(--visual-link)",
    textDecoration: "underline",
    textDecorationThickness: "0.08em",
    textUnderlineOffset: "0.12em",
  },
  ".cm-vis-chip-label": {
    padding: "0 5px",
    borderRadius: "3px",
    background: "color-mix(in srgb, var(--visual-text) 5%, transparent)",
    border: "1px dashed color-mix(in srgb, var(--visual-text) 22%, transparent)",
    color: "var(--visual-muted)",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "0.76em",
    lineHeight: "1.35",
  },
  ".cm-vis-chip-label:hover": {
    background: "color-mix(in srgb, var(--visual-text) 10%, transparent)",
    borderColor: "color-mix(in srgb, var(--visual-text) 36%, transparent)",
    color: "var(--visual-text)",
  },
  ".cm-vis-chip-label::before": {
    content: '""',
    display: "inline-block",
    width: "8.5px",
    height: "8.5px",
    marginRight: "3px",
    backgroundColor: "currentColor",
    mask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M2 6.5V2.5h4l4.5 4.5-4 4L2 6.5z\'/%3E%3Ccircle cx=\'4.5\' cy=\'4.5\' r=\'.8\' fill=\'currentColor\'/%3E%3C/svg%3E") no-repeat center / contain',
    WebkitMask: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M2 6.5V2.5h4l4.5 4.5-4 4L2 6.5z\'/%3E%3Ccircle cx=\'4.5\' cy=\'4.5\' r=\'.8\' fill=\'currentColor\'/%3E%3C/svg%3E") no-repeat center / contain',
    opacity: "0.7",
    verticalAlign: "-0.05em",
    flexShrink: "0",
  },
  // `\setcounter{chapter}{1}` — structural, not prose, and the heading numbers
  // around it already show its effect, so it reads as a quiet aside.
  ".cm-vis-chip-counter": {
    background: "var(--visual-widget-bg)",
    color: "var(--visual-muted-2)",
    fontSize: "0.74em",
    letterSpacing: "0.02em",
    textTransform: "lowercase",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-vis-chip-toc": { background: "var(--visual-widget-bg)", color: "var(--visual-text)", borderLeft: "3px solid var(--visual-link)" },

  // Lists: hang the marker just inside the document column, never in the
  // CodeMirror line-number gutter. Wrapped text aligns with the item body.
  ".cm-vis-list-line": { paddingLeft: "2em", textIndent: "-1.15em" },
  ".cm-vis-item-marker": {
    display: "inline-flex",
    position: "relative",
    justifyContent: "flex-end",
    minWidth: "0.95em",
    marginRight: "0.32em",
    color: "var(--visual-text)",
    fontWeight: "600",
    lineHeight: "1",
    verticalAlign: "0.02em",
    whiteSpace: "nowrap",
  },
  ".cm-vis-item-marker-bullet": {
    color: "transparent",
  },
  ".cm-vis-item-marker-bullet::before": {
    content: '\"\"',
    position: "absolute",
    top: "50%",
    right: "0.13em",
    width: "0.34em",
    height: "0.34em",
    borderRadius: "50%",
    backgroundColor: "var(--visual-accent-bright)",
    transform: "translateY(-48%)",
  },
  ".cm-vis-theorem-label": {
    display: "inline-flex",
    marginRight: "0.55em",
    padding: "0.08em 0.45em",
    borderRadius: "3px",
    backgroundColor: "var(--visual-widget-bg)",
    color: "var(--visual-accent-bright)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.78em",
    fontWeight: "700",
    letterSpacing: "0.02em",
    verticalAlign: "0.08em",
  },
  ".cm-vis-theorem-editable": { cursor: "pointer" },
  ".cm-vis-theorem-editable:hover": {
    boxShadow: "inset 0 -0.12em 0 rgba(47, 139, 58, 0.45)",
  },

  // Figure card. No outer margin (see block-widget note above) — the 8px of
  // outer breathing room folds into the card's own padding instead.
  ".cm-vis-figure": {
    display: "flex",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    minHeight: "120px",
    padding: "28px 20px",
    border: "1px dashed var(--visual-border-strong)",
    borderRadius: "6px",
    background: "var(--visual-widget-bg)",
  },
  ".cm-vis-figure img, .cm-vis-figure canvas": {
    maxWidth: "100%",
    maxHeight: "300px",
    objectFit: "contain",
  },
  ".cm-vis-diagram-preview": {
    display: "block",
    width: "auto",
    maxWidth: "none",
    height: "auto",
    maxHeight: "320px",
  },
  // TikZ diagrams are drawings, not image placeholders: give them a compact
  // card, preserve the SVG's readable natural size, and scroll only its canvas
  // when it is wider than the prose column. Captions stay below the canvas.
  ".cm-vis-figure.cm-vis-diagram": {
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: "10px",
    minHeight: "0",
    padding: "14px 20px",
  },
  ".cm-vis-diagram-canvas": {
    width: "100%",
    minWidth: "0",
    overflowX: "auto",
    overflowY: "hidden",
    padding: "4px 0",
  },
  ".cm-vis-diagram-canvas .cm-vis-diagram-preview": {
    margin: "0 auto",
  },
  ".cm-vis-diagram .cm-vis-caption": {
    alignSelf: "center",
    maxWidth: "78ch",
    color: "var(--visual-caption)",
    fontWeight: "500",
    lineHeight: "1.55",
    textAlign: "center",
    boxShadow: "none",
  },
  ".cm-vis-diagram-preview .cm-vis-diagram-node-label, .cm-vis-diagram-preview .cm-vis-diagram-edge-label": {
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-vis-figure-icon": { fontSize: "28px", lineHeight: "1" },
  ".cm-vis-figure-name": {
    maxWidth: "100%",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--visual-muted)",
    overflowWrap: "anywhere",
    textAlign: "center",
  },
  // TikZ/PGF drawing fallback hint. Graph-shaped TikZ is rendered as an SVG
  // preview; this text only appears when no supported graph primitives exist.
  ".cm-vis-diagram-hint": {
    fontSize: "11.5px",
    color: "var(--visual-muted-2)",
  },

  // Rendered table. The table itself keeps `margin: 0 auto` for horizontal
  // centering only (tables shrink-wrap, so this is needed) — zero vertical
  // margin. Outer vertical spacing is padding on the wrapper CM measures.
  ".cm-vis-table-wrap": {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    overflowX: "auto",
    overflowY: "hidden",
    padding: "10px 0",
    borderRadius: "4px",
    cursor: "text",
    // CodeMirror mounts replacement widgets as non-editable DOM. WebView2 may
    // consequently inherit control-like selection behavior unless this is
    // explicit, even though the cell text is ordinary HTML.
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  ".cm-vis-table-wrap ::selection": {
    color: "inherit",
    backgroundColor: "var(--visual-selection-bg-focused)",
  },
  // The editable grid (see tableWidget.ts). Its toolbar stays out of the way
  // until the table is hovered or a cell has focus, so a page being read looks
  // exactly as it did before.
  ".cm-vis-table-editor": { position: "relative", display: "block" },
  ".cm-vis-table-toolbar": {
    position: "absolute",
    zIndex: "2",
    top: "-12px",
    left: "50%",
    display: "flex",
    gap: "8px",
    padding: "3px 5px",
    border: "1px solid var(--visual-border-strong)",
    borderRadius: "6px",
    background: "var(--visual-widget-bg)",
    opacity: "0",
    pointerEvents: "none",
    transform: "translateX(-50%)",
    transition: "opacity 90ms ease-out",
    userSelect: "none",
  },
  ".cm-vis-table-editor:hover .cm-vis-table-toolbar": { opacity: "1", pointerEvents: "auto" },
  ".cm-vis-table-editor:focus-within .cm-vis-table-toolbar": { opacity: "1", pointerEvents: "auto" },
  ".cm-vis-table-tool-group": {
    display: "flex",
    gap: "1px",
    paddingRight: "8px",
    borderRight: "1px solid var(--visual-border)",
  },
  ".cm-vis-table-tool-group:last-child": { paddingRight: "0", borderRight: "0" },
  ".cm-vis-table-tool": {
    display: "inline-flex",
    width: "20px",
    height: "20px",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    border: "0",
    borderRadius: "3px",
    background: "transparent",
    color: "var(--visual-muted)",
    cursor: "pointer",
    font: '13px/1 "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif',
  },
  ".cm-vis-table-tool:hover": { background: "var(--visual-border)", color: "var(--visual-text)" },
  ".cm-vis-table-cell": { outline: "none", cursor: "text" },
  ".cm-vis-table-cell:focus": {
    backgroundColor: "rgba(47, 139, 58, 0.09)",
    boxShadow: "inset 0 0 0 1px var(--visual-accent-bright)",
  },
  // Marks the cell the toolbar acts on, so "insert row below" is unambiguous.
  ".cm-vis-table-cell[data-vis-table-active]": { boxShadow: "inset 0 0 0 1px var(--visual-border-strong)" },
  ".cm-vis-table": {
    borderCollapse: "collapse",
    width: "max-content",
    maxWidth: "100%",
    margin: "0 auto",
    fontSize: "0.9em",
  },
  ".cm-vis-table th, .cm-vis-table td": {
    minWidth: "0",
    maxWidth: "32ch",
    padding: "4px clamp(6px, 1.5vw, 14px)",
    textAlign: "left",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
  },
  ".cm-vis-table thead, .cm-vis-table tr:first-child th": { fontWeight: "700" },
  ".cm-vis-table th": { borderBottom: "1.5px solid var(--visual-border-strong)", fontWeight: "700" },
  ".cm-vis-table tr:last-child td": { borderBottom: "1px solid var(--visual-border-strong)" },
  ".cm-vis-table tr:first-child td, .cm-vis-table tr:first-child th": { borderTop: "1.5px solid var(--visual-border-strong)" },

  // Caption line: a restrained warm tone keeps figures and tables easy to find
  // without competing with the hierarchy colors used by headings.
  ".cm-vis-caption-line": { textAlign: "center" },
  ".cm-vis-caption": {
    fontSize: "0.88em",
    color: "var(--visual-caption)",
    fontWeight: "600",
    boxShadow: "inset 0 -0.1em 0 color-mix(in srgb, var(--visual-caption) 22%, transparent)",
  },

  // \maketitle title block.
  ".cm-vis-title": {
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    textAlign: "center",
    padding: "8px 0 30px",
    overflowWrap: "anywhere",
  },
  ".cm-vis-title-name": { maxWidth: "100%", fontSize: "24px", fontWeight: "700", lineHeight: "1.18", overflowWrap: "anywhere" },
  // IEEE-style `\authorblockN{…}\authorblockA{…}` extraction is newline-joined
  // (one line per name/affiliation block) — `pre-line` renders those breaks
  // instead of collapsing them into one run-on line.
  ".cm-vis-title-author": { fontSize: "15px", marginTop: "10px", lineHeight: "1.5", whiteSpace: "pre-line" },
  ".cm-vis-title-date": { fontSize: "13.5px", color: "var(--visual-muted)", marginTop: "6px" },
  // `\title{}`/`\author{}`/`\date{}` live in the always-folded preamble, so a
  // deliberate double-click jumps to Code mode with that source selected
  // (see TitleWidget)
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
    color: "var(--visual-muted-2)",
  },

  // Section headings: same serif family as body, bold, with TeX-like spacing. This is a LINE
  // decoration (applied to `.cm-line` itself), so the margin→padding rule above
  // applies doubly here — margin on a `.cm-line` is the single biggest source of
  // click-position drift, since every line below inherits the accumulated error.
  ".cm-vis-heading-line": {
    maxWidth: "100%",
    minWidth: "0",
    fontFamily: "inherit",
    fontWeight: "700",
    color: "var(--visual-text)",
    lineHeight: "1.18",
    overflowWrap: "anywhere",
  },
  // Symmetric vertical padding keeps the title itself, its diff tint, and its
  // gutter line number centred as one visual row. The total breathing room is
  // unchanged from the old top-only spacing.
  ".cm-vis-heading-1": { fontSize: "24.5px", paddingTop: "11px", paddingBottom: "11px", color: "var(--visual-heading-1)" },
  ".cm-vis-heading-2": { fontSize: "20px", paddingTop: "8px", paddingBottom: "8px", color: "var(--visual-heading-2)" },
  ".cm-vis-heading-3": { fontSize: "18px", paddingTop: "6px", paddingBottom: "6px", color: "var(--visual-heading-3)" },
  ".cm-vis-heading-4": { fontSize: "17.5px", paddingTop: "5px", paddingBottom: "5px", color: "var(--visual-heading-4)" },
  ".cm-vis-h1": { fontSize: "24.5px", color: "var(--visual-heading-1)" },
  ".cm-vis-h2": { fontSize: "20px", color: "var(--visual-heading-2)" },
  ".cm-vis-h3": { fontSize: "18px", color: "var(--visual-heading-3)" },
  ".cm-vis-h4": { fontSize: "17.5px", color: "var(--visual-heading-4)" },
  // The heading number is generated from the document's counters, not typed —
  // so it never enters a selection, and it sits in its own fixed-width column
  // the way LaTeX sets one, keeping every title in a run of sections flush with
  // the next regardless of how many digits the number carries ("9.9" vs "10.10").
  // `min-width` rather than a fixed width so a deep "2.10.3.1" pushes out
  // instead of colliding with its title.
  ".cm-vis-secnum": {
    display: "inline-block",
    minWidth: "1.9em",
    paddingRight: "0.45em",
    // A shade of the heading's own colour rather than the full-strength ink:
    // the title is what the eye should land on first, and the compiled PDF's
    // number is likewise smaller than the words beside it.
    color: "color-mix(in srgb, currentColor 62%, transparent)",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum" 1',
    letterSpacing: "-0.01em",
    userSelect: "none",
    WebkitUserSelect: "none",
    cursor: "default",
  },
  // Deeper headings carry longer numbers in a smaller type size, so each level
  // reserves the width its own numbers actually need.
  ".cm-vis-secnum-1": { minWidth: "1.4em", paddingRight: "0.5em" },
  ".cm-vis-secnum-2": { minWidth: "1.9em" },
  ".cm-vis-secnum-3": { minWidth: "2.5em" },
  ".cm-vis-secnum-4": { minWidth: "3em" },
  ".cm-vis-page-break": {
    display: "flex",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    alignItems: "center",
    gap: "10px",
    padding: "18px 0 14px",
    color: "var(--visual-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    letterSpacing: "0.08em",
    lineHeight: "1",
    userSelect: "none",
  },
  ".cm-vis-page-break-line": {
    height: "1px",
    flex: "1 1 0",
    minWidth: "0",
    backgroundColor: "var(--visual-border)",
  },
  ".cm-vis-page-break-label": {
    flex: "0 0 auto",
    whiteSpace: "nowrap",
  },

  // Folded preamble chip. It's the very first block in the document — a margin
  // here would throw off click-position math for EVERY line below it (the error
  // compounds down the whole page), so its 4px/20px outer spacing folds into
  // padding instead, same as every other block widget (see note above).
  ".cm-vis-preamble": {
    display: "flex",
    width: "100%",
    maxWidth: "100%",
    minWidth: "0",
    boxSizing: "border-box",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    paddingTop: "15px",
    paddingBottom: "31px",
    paddingLeft: "16px",
    paddingRight: "16px",
    borderLeft: "0",
    borderRadius: "4px",
    background: "var(--visual-widget-bg)",
    color: "var(--visual-muted-2)",
    font: '14px/1.3 "Helvetica Neue", Arial, sans-serif',
    cursor: "default",
    userSelect: "none",
  },
  ".cm-vis-preamble strong": { color: "var(--visual-muted)", fontSize: "12px", fontWeight: "600" },
};

/**
 * The page theme at a given font-size setting. The typography is folded into
 * `visualThemeSpec` rather than layered over it as a second theme: two
 * equal-specificity rules would be decided by stylesheet insertion order, which
 * shifts on every reconfigure. `visualThemeSpec` itself carries the values for
 * the default setting, so the merge is a no-op until the user changes it.
 *
 * The gutter's line-height tracks the prose line-height exactly — line numbers
 * and text share one absolute line box, which is what keeps them aligned when a
 * unitless value would be recomputed against the gutter's smaller font.
 */
const visualThemeCache = new Map<number, Extension>();

export function visualThemeFor(settings: EditorSettings): Extension {
  const { fontSize, lineHeight } = visualTypographyFor(settings);
  // One `StyleModule` per distinct size: `EditorView.theme` injects a
  // stylesheet that is never removed, so a fresh call per editor would leak one
  // every time a file is opened.
  const cached = visualThemeCache.get(fontSize);
  if (cached) return cached;
  const theme = EditorView.theme({
    ...visualThemeSpec,
    "&": { ...(visualThemeSpec["&"] as object), fontSize: `${fontSize}px` },
    ".cm-scroller": { ...(visualThemeSpec[".cm-scroller"] as object), lineHeight: `${lineHeight}px` },
    ".cm-gutters": { ...(visualThemeSpec[".cm-gutters"] as object), lineHeight: `${lineHeight}px` },
  }, { dark: true });
  visualThemeCache.set(fontSize, theme);
  return theme;
}

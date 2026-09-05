// The editor's formatting toolbar: headings, marks, lists, figures, tables,
// citations and the search box, issued through `editorCommands`.
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { suggestedCitationKey } from "../literature/literatureStore";
import type { LiteraturePaper } from "../literature/literatureTypes";
import { useStore } from "../store";
import {
  activeEditorAdapter,
  applyHeadingLevel,
  applyListWrap,
  insertBlockAtCursor,
  insertLink,
  insertSnippetAtCursor,
  textSearchMatches,
  visualSectionLevels,
  wrapSelection,
  type EditorAdapter,
  type EditorMode,
} from "./editorCommands";
import { FileIcon } from "./FileIcon";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { basename, sameWorkspacePath } from "./latexText";
import type { BeamerSlide } from "./outlineModel";
import { ToolIcon } from "./ToolIcon";
import TypesetSymbolPalette from "./TypesetSymbolPalette";
import TypesetFigureDialog from "./TypesetFigureDialog";
import { figureIncludeCommand, figureSnippet, includeGraphicsAt, type FigureDraft } from "./latexFigure";
import { symbolInsertion, symbolSelectionRange, type LatexSymbolEntry } from "./symbolPalette";
import { scanLatexStructure } from "./latexStructure";

function VisualToolbarMenu({
  label,
  icon,
  wide,
  horizontal,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  wide?: boolean;
  horizontal?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="ol-cm-toolbar-menu-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className={`ol-cm-toolbar-button${wide ? " ol-cm-toolbar-button-wide" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </button>
      {open && (
        <div
          className={`ol-cm-toolbar-button-menu-popover${horizontal ? " horizontal" : ""}`}
          role="menu"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}
function VisualMenuItem({
  label,
  icon,
  active,
  onSelect,
}: {
  label?: string;
  icon?: React.ReactNode;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ol-cm-toolbar-menu-item${active ? " active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onSelect}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}
function TypesetCitationPicker({
  papers,
  onClose,
  onConfirm,
}: {
  papers: LiteraturePaper[];
  onClose: () => void;
  onConfirm: (ids: string[]) => Promise<void>;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].citationPicker;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return papers;
    return papers.filter((paper) => [paper.title, paper.authors.join(" "), paper.citationKey, paper.doi]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle));
  }, [papers, query]);
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const confirm = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm([...selected]);
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };
  return (
    <div className="typeset-citation-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="typeset-citation-picker" role="dialog" aria-modal="true" aria-label={copy.insertLibraryCitationLabel} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>{copy.somniqLiterature}</span><strong>{copy.insertCitation}</strong></div>
          <button type="button" aria-label={copy.closeCitationPicker} onClick={onClose}>×</button>
        </header>
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchLiteratureLabel}
        />
        <div className="typeset-citation-results" role="listbox" aria-label={copy.libraryPapersLabel}>
          {visible.map((paper) => {
            const checked = selected.has(paper.id);
            return (
              <button
                type="button"
                role="option"
                aria-selected={checked}
                className={checked ? "selected" : ""}
                key={paper.id}
                onClick={() => toggle(paper.id)}
              >
                <span className="typeset-citation-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                <span><strong>{paper.title}</strong><em>{paper.authors.join(", ") || copy.unknownAuthor}{paper.year ? ` · ${paper.year}` : ""}</em></span>
                <code>{paper.citationKey || suggestedCitationKey(paper)}</code>
              </button>
            );
          })}
          {visible.length === 0 && <p>{copy.noMatchingPapers}</p>}
        </div>
        {error && <p className="typeset-citation-error" role="status">{error}</p>}
        <footer>
          <span>{copy.selectedCount(selected.size)}</span>
          <div><button type="button" onClick={onClose} disabled={busy}>{copy.cancel}</button><button type="button" className="primary" onClick={() => void confirm()} disabled={busy || selected.size === 0}>{busy ? copy.preparing : copy.insertCiteCmd}</button></div>
        </footer>
      </section>
    </div>
  );
}
export default function TypesetEditorToolbar({
  spellCheck,
  onToggleSpellCheck,
  activeSlide,
  slides,
  draft,
  mode,
  canRedo,
  canUndo,
  dirty,
  compiling,
  editorRef,
  visualViewRef,
  onChange,
  onModeChange,
  onNavigateToLine,
  onEditSlideSource,
  onRedo,
  onSave,
  onHistory,
  historyLabel,
  onProjectSearch,
  projectSearchLabel,
  onComments,
  commentsLabel,
  onSearch,
  onUndo,
  path,
  tabs,
  dirtyTabs,
  reviewTabs = [],
  reviewLabel = "Review",
  onSelectTab,
  onCloseTab,
  citationPapers,
  projectImagePaths,
  onPrepareCitationKeys,
  onSynchronizeBibliography,
  saving,
}: {
  /** Spell checking is a Visual-surface feature: with commands hidden the
   * page reads as prose, whereas Code mode would squiggle every macro. */
  spellCheck: boolean;
  onToggleSpellCheck: () => void;
  activeSlide: BeamerSlide | null;
  slides: BeamerSlide[];
  draft: string;
  mode: EditorMode;
  canRedo: boolean;
  canUndo: boolean;
  dirty: boolean;
  compiling: boolean;
  editorRef: { current: SharedEditorHandle | null };
  visualViewRef: { current: EditorView | null };
  onChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onNavigateToLine: (line: number) => void;
  onEditSlideSource: (line: number) => void;
  onRedo: () => void;
  onSave: () => void;
  onHistory: () => void;
  historyLabel: string;
  onProjectSearch: () => void;
  projectSearchLabel: string;
  onComments: () => void;
  commentsLabel: string;
  onSearch: (start: number, end: number) => void;
  onUndo: () => void;
  path: string | null;
  /** Every open file, in the order they were opened; `path` is the active one. */
  tabs: string[];
  /** Open files holding unsaved edits while not in front. */
  dirtyTabs: string[];
  /** Open files changed outside the editor and awaiting a decision. */
  reviewTabs?: readonly string[];
  reviewLabel?: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  citationPapers: LiteraturePaper[];
  /** Project-relative image paths the figure dialog offers. */
  projectImagePaths: readonly string[];
  onPrepareCitationKeys: (ids: string[]) => Promise<string[]>;
  onSynchronizeBibliography: () => Promise<void>;
  saving: boolean;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].toolbar;
  const symbolCopy = TYPESET_EDITOR_COPY[language].symbolPalette;
  const sectionLevels = useMemo(() => visualSectionLevels(language), [language]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [citationPickerOpen, setCitationPickerOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [figureDialog, setFigureDialog] = useState<
    { initial: Partial<FigureDraft> | null; replace: { from: number; to: number } | null } | null
  >(null);
  // The toolbar row is `overflow: hidden`, so panels are portalled and
  // positioned from their trigger (see TypesetPopover).
  const symbolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const citationAdapterRef = useRef<EditorAdapter | null>(null);
  const searchMatches = useMemo(() => textSearchMatches(draft, searchQuery), [draft, searchQuery]);
  const activeSlideIndex = activeSlide ? slides.indexOf(activeSlide) : -1;
  const safeCompiledVisual = slides.length > 0 && mode === "visual";
  // Every command below reads/writes at the *live* selection of whichever
  // editor is active — see `activeEditorAdapter` for why Code mode (a plain
  // textarea) and Visual mode (CodeMirror) need different `replace` backends.
  const withSelection = (run: (adapter: EditorAdapter) => void) => {
    const adapter = activeEditorAdapter(mode, editorRef, visualViewRef, draft, onChange);
    if (!adapter) return;
    run(adapter);
  };
  const insertSection = (key: string, label: string) =>
    withSelection((adapter) => applyHeadingLevel(adapter, key, label));
  const insertBold = () => withSelection((adapter) => wrapSelection(adapter, "\\textbf{", "}", "bold text"));
  const insertItalic = () => withSelection((adapter) => wrapSelection(adapter, "\\emph{", "}", "emphasis"));
  const insertBulletList = () => withSelection((adapter) => applyListWrap(adapter, "itemize"));
  const insertNumberedList = () => withSelection((adapter) => applyListWrap(adapter, "enumerate"));
  const insertInlineMath = () => withSelection((adapter) => wrapSelection(adapter, "$", "$", "x"));
  const insertMath = () => withSelection((adapter) => wrapSelection(adapter, "\\[\n", "\n\\]", "x"));
  const insertHref = () => withSelection((adapter) => insertLink(adapter));
  const insertRef = () => withSelection((adapter) => insertSnippetAtCursor(adapter, "\\ref{", "sec:label", "}"));
  const insertCitation = () => {
    const adapter = activeEditorAdapter(mode, editorRef, visualViewRef, draft, onChange);
    if (!adapter) return;
    // Preserve the lightweight manual insertion behaviour for a brand-new
    // project; once there are library records, citations are always selected
    // from the local database so their keys and BibTeX stay in sync.
    if (citationPapers.length === 0) {
      insertSnippetAtCursor(adapter, "\\cite{", "reference", "}");
      return;
    }
    citationAdapterRef.current = adapter;
    setCitationPickerOpen(true);
  };
  const confirmCitation = async (ids: string[]) => {
    const adapter = citationAdapterRef.current;
    if (!adapter) throw new Error(TYPESET_EDITOR_COPY[language].citationPicker.editorSelectionUnavailable);
    const keys = await onPrepareCitationKeys(ids);
    if (keys.length === 0) throw new Error(TYPESET_EDITOR_COPY[language].citationPicker.noUsableCitationKeys);
    // Insert through the captured live editor first. The synchronization may
    // replace the document to add the bibliography declaration, so doing it
    // first would let this stale adapter overwrite that declaration.
    insertSnippetAtCursor(adapter, "\\cite{", keys.join(","), "}");
    await onSynchronizeBibliography();
    citationAdapterRef.current = null;
    setCitationPickerOpen(false);
  };
  const insertTable = () =>
    withSelection((adapter) => insertBlockAtCursor(adapter, "\\begin{tabular}{ll}\nA & B \\\\\n1 & 2\n\\end{tabular}"));
  /** Opens the figure dialog on the `\includegraphics` under the caret when
   * there is one, so one wizard both creates a figure and edits an existing
   * image — the way Overleaf's figure modal works. */
  const insertFigure = () =>
    withSelection((adapter) => {
      const existing = includeGraphicsAt(adapter.text, adapter.from);
      setFigureDialog(existing
        ? {
            initial: { path: existing.path, widthFraction: existing.widthFraction },
            replace: { from: existing.from, to: existing.to },
          }
        : { initial: null, replace: null });
    });
  const confirmFigure = (draft: FigureDraft) => {
    const request = figureDialog;
    setFigureDialog(null);
    withSelection((adapter) => {
      // Editing an existing image rewrites only its `\includegraphics`: the
      // caption and label around it are already where the author put them.
      if (request?.replace) {
        const command = figureIncludeCommand(draft);
        const caret = request.replace.from + command.length;
        adapter.replace(request.replace.from, request.replace.to, command, caret, caret);
        return;
      }
      insertBlockAtCursor(adapter, figureSnippet(draft));
    });
  };
  /** A symbol dropped into prose has to bring its own math delimiters; one
   * dropped inside `$…$` or an equation body must not, or it closes the
   * formula. The structure index already knows which is which. */
  const insertSymbol = (symbol: LatexSymbolEntry) =>
    withSelection((adapter) => {
      const insideMath = scanLatexStructure(adapter.text).isMath(Math.max(0, adapter.from - 1));
      const text = symbolInsertion(symbol, insideMath);
      const [selectFrom, selectTo] = symbolSelectionRange(text);
      adapter.replace(adapter.from, adapter.to, text, adapter.from + selectFrom, adapter.from + selectTo);
    });
  const runSearch = (direction = 0) => {
    if (!searchMatches.length) return;
    setSearchIndex((current) => {
      const base = ((current % searchMatches.length) + searchMatches.length) % searchMatches.length;
      const next = ((base + direction) % searchMatches.length + searchMatches.length) % searchMatches.length;
      const match = searchMatches[next];
      onSearch(match.start, match.end);
      return next;
    });
  };

  useEffect(() => {
    setSearchIndex(0);
  }, [draft, searchQuery]);

  useEffect(() => {
    if (!searchOpen) return;
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  return (
    <div className={`typeset-visual-toolbar ol-cm-toolbar-wrapper${safeCompiledVisual ? " safe-visual" : ""}`} aria-label={copy.editorToolsLabel}>
      <div className="typeset-visual-filebar editor-tabs-container" role="tablist" aria-label={copy.openFilesLabel}>
        {(tabs.length > 0 ? tabs : [path ?? ""]).map((tabPath) => {
          const active = sameWorkspacePath(tabPath, path);
          const tabDirty = active ? dirty : dirtyTabs.includes(tabPath);
          const tabNeedsReview = reviewTabs.some((reviewPath) => sameWorkspacePath(reviewPath, tabPath));
          return (
            <div
              key={tabPath || "untitled"}
              className={`typeset-visual-filetab editor-tab${active ? " active" : ""}${tabDirty ? " dirty" : ""}${tabNeedsReview ? " review-pending" : ""}`}
              role="tab"
              aria-selected={active}
            >
              <button
                type="button"
                className="typeset-visual-filetab-open"
                onClick={() => { if (!active && tabPath) onSelectTab(tabPath); }}
              >
                <FileIcon path={tabPath || "untitled.tex"} />
                {active
                  ? <strong>{tabPath ? basename(tabPath) : copy.untitled}</strong>
                  : <span>{basename(tabPath)}</span>}
                {tabDirty && <i className="typeset-visual-filetab-dot" aria-hidden="true" />}
                {tabNeedsReview && <i className="typeset-visual-filetab-review" title={reviewLabel}>{reviewLabel}</i>}
              </button>
              {tabs.length > 1 && tabPath && (
                <button
                  type="button"
                  className="typeset-visual-filetab-close"
                  title={copy.closeTab(basename(tabPath))}
                  aria-label={copy.closeTab(basename(tabPath))}
                  onClick={() => onCloseTab(tabPath)}
                >
                  <ToolIcon name="clear" />
                </button>
              )}
            </div>
          );
        })}
        {slides.length > 0 && (
          <nav className="typeset-slide-nav" aria-label={copy.slideNavigationLabel}>
            <button
              type="button"
              aria-label={copy.previousSlide}
              title={copy.previousSlide}
              disabled={activeSlideIndex <= 0}
              onClick={() => onNavigateToLine(slides[activeSlideIndex - 1]?.line ?? slides[0].line)}
            >
              <ToolIcon name="previous" />
            </button>
            <button
              type="button"
              className="typeset-slide-nav-label"
              title={activeSlide?.title ?? copy.openFirstSlide}
              onClick={() => onNavigateToLine((activeSlide ?? slides[0]).line)}
            >
              <span>{activeSlideIndex >= 0 ? copy.slideOfTotal(activeSlideIndex + 1, slides.length) : copy.slidesCountLabel(slides.length)}</span>
              <strong>{activeSlide?.title ?? slides[0].title}</strong>
            </button>
            <button
              type="button"
              aria-label={copy.nextSlide}
              title={copy.nextSlide}
              disabled={activeSlideIndex < 0 || activeSlideIndex >= slides.length - 1}
              onClick={() => onNavigateToLine(slides[activeSlideIndex + 1]?.line ?? slides[slides.length - 1].line)}
            >
              <ToolIcon name="next" />
            </button>
          </nav>
        )}
        <div className="typeset-visual-mode-switch editor-switch" role="tablist" aria-label={copy.editorModeLabel}>
          <button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "active" : ""} onClick={() => onModeChange("code")}>{copy.code}</button>
          <button type="button" role="tab" aria-selected={mode === "visual"} className={mode === "visual" ? "active" : ""} onClick={() => onModeChange("visual")}>{copy.visual}</button>
        </div>
      </div>
      <div className="typeset-visual-toolbar-row ol-cm-toolbar toolbar-editor" role="toolbar" aria-label={copy.editorToolbarLabel}>
        {safeCompiledVisual && (
          <div className="typeset-safe-visual-toolbar">
            <ToolIcon name="visual" />
            <strong>{copy.compiledSlidePreview}</strong>
            <span>{copy.clickToEditHint}</span>
            <button
              type="button"
              onClick={() => onEditSlideSource((activeSlide ?? slides[0]).line)}
            >
              {copy.editSlideSource}
            </button>
          </div>
        )}
        <div className="ol-cm-toolbar-button-group" aria-label={copy.undoRedoLabel}>
          <button type="button" className="ol-cm-toolbar-button" title={copy.undo} aria-label={copy.undo} disabled={!canUndo} onClick={onUndo}><ToolIcon name="undo" /></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.redo} aria-label={copy.redo} disabled={!canRedo} onClick={onRedo}><ToolIcon name="redo" /></button>
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={dirty ? (mode === "visual" ? copy.saveVisualTitle : copy.saveTitle) : copy.noUnsavedChanges}
            aria-label={copy.saveTitle}
            disabled={saving || compiling || !dirty}
            onClick={onSave}
          >
            <ToolIcon name="save" />
          </button>
          <button type="button" className="ol-cm-toolbar-button" title={historyLabel} aria-label={historyLabel} onClick={onHistory}>
            <ToolIcon name="history" />
          </button>
          <button type="button" className="ol-cm-toolbar-button" title={projectSearchLabel} aria-label={projectSearchLabel} onClick={onProjectSearch}>
            <ToolIcon name="search" />
          </button>
          <button type="button" className="ol-cm-toolbar-button" title={commentsLabel} aria-label={commentsLabel} onClick={onComments}>
            <ToolIcon name="comments" />
          </button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label={copy.textFormattingLabel}>
          <VisualToolbarMenu
            label={copy.sectionHeading}
            wide
            icon={<><span className="typeset-visual-text-icon">H</span><ToolIcon name="chevron" /></>}
          >
            {sectionLevels.map((level) => (
              <VisualMenuItem
                key={level.key}
                label={level.label}
                onSelect={() => insertSection(level.key, level.label)}
              />
            ))}
          </VisualToolbarMenu>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label={copy.textStyleLabel}>
          <button type="button" className="ol-cm-toolbar-button" title={copy.bold} aria-label={copy.bold} onClick={insertBold}><strong className="typeset-visual-text-icon">B</strong></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.italic} aria-label={copy.italic} onClick={insertItalic}><em className="typeset-visual-text-icon">I</em></button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label={copy.insertMathSymbolsLabel}>
          <VisualToolbarMenu label={copy.insertMath} icon={<span className="typeset-visual-text-icon">&Sigma;</span>}>
            <VisualMenuItem label={copy.inline} icon={<span className="typeset-visual-text-icon">$x$</span>} onSelect={insertInlineMath} />
            <VisualMenuItem label={copy.display} icon={<span className="typeset-visual-text-icon">[x]</span>} onSelect={insertMath} />
          </VisualToolbarMenu>
          <button
            ref={symbolsButtonRef}
            type="button"
            className="ol-cm-toolbar-button"
            title={symbolCopy.open}
            aria-label={symbolCopy.open}
            aria-expanded={symbolsOpen}
            onClick={() => setSymbolsOpen((value) => !value)}
          >
            <span className="typeset-visual-text-icon">&radic;x</span>
          </button>
          <TypesetSymbolPalette
            open={symbolsOpen}
            anchorRef={symbolsButtonRef}
            onClose={() => setSymbolsOpen(false)}
            onInsert={insertSymbol}
          />
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label={copy.insertMiscLabel}>
          <button type="button" className="ol-cm-toolbar-button" title={copy.insertLink} aria-label={copy.insertLink} onClick={insertHref}><ToolIcon name="link" /></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.insertCrossReference} aria-label={copy.insertCrossReference} onClick={insertRef}><ToolIcon name="ref" /></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.insertCitationTitle} aria-label={copy.insertCitationTitle} onClick={insertCitation}><ToolIcon name="citation" /></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.insertFigure} aria-label={copy.insertFigure} onClick={insertFigure}><ToolIcon name="figure" /></button>
          <button type="button" className="ol-cm-toolbar-button" title={copy.insertTable} aria-label={copy.insertTable} onClick={insertTable}><ToolIcon name="table" /></button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label={copy.listIndentationLabel}>
          <VisualToolbarMenu label={copy.insertList} horizontal icon={<ToolIcon name="list" />}>
            <VisualMenuItem label={copy.bulletedList} icon={<ToolIcon name="list" />} onSelect={insertBulletList} />
            <VisualMenuItem label={copy.numberedList} icon={<ToolIcon name="numberedList" />} onSelect={insertNumberedList} />
          </VisualToolbarMenu>
        </div>
        <div className="ol-cm-toolbar-button-group ol-cm-toolbar-stretch" />
        <div className="ol-cm-toolbar-button-group ol-cm-toolbar-end">
          {searchOpen && (
            <form
              className="typeset-toolbar-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                runSearch(0);
              }}
            >
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                aria-label={copy.searchSource}
                placeholder={copy.find}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
              <span className="typeset-toolbar-search-count" aria-live="polite">
                {searchMatches.length ? `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}` : "0"}
              </span>
              <button type="button" className="ol-cm-toolbar-button" title={copy.previousMatch} aria-label={copy.previousMatch} disabled={!searchMatches.length} onClick={() => runSearch(-1)}>
                <ToolIcon name="previous" />
              </button>
              <button type="button" className="ol-cm-toolbar-button" title={copy.nextMatch} aria-label={copy.nextMatch} disabled={!searchMatches.length} onClick={() => runSearch(1)}>
                <ToolIcon name="next" />
              </button>
            </form>
          )}
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={spellCheck ? copy.spellCheckOn : copy.spellCheckOff}
            aria-label={copy.spellCheck}
            aria-pressed={spellCheck}
            onClick={onToggleSpellCheck}
          >
            <ToolIcon name="review" />
          </button>
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={searchOpen ? copy.closeSearch : copy.search}
            aria-label={copy.search}
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <ToolIcon name="search" />
          </button>
        </div>
      </div>
      <TypesetFigureDialog
        open={figureDialog !== null}
        initial={figureDialog?.initial ?? null}
        imagePaths={projectImagePaths}
        onCancel={() => setFigureDialog(null)}
        onConfirm={confirmFigure}
      />
      {citationPickerOpen && (
        <TypesetCitationPicker
          papers={citationPapers}
          onClose={() => {
            citationAdapterRef.current = null;
            setCitationPickerOpen(false);
          }}
          onConfirm={confirmCitation}
        />
      )}
    </div>
  );
}

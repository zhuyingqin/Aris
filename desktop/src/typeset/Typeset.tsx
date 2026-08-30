import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import "katex/dist/katex.min.css";


import {
  fileCreateText,
  fileReadText,
  fileSearch,
  fileWriteText,
  isTauri,
  latexCompile,
  latexCompileCancel,
  latexDocumentContext,
  latexForwardSearch,
  latexInverseSearch,
  literatureExportBibliography,
  localEnvironmentCheck,
  onLatexCompileProgress,
  type FileText,
  type LatexDiagnostic,
  type TypesetDocument,
  type TypesetProject,
  typesetExportFile,
  typesetListDocuments,
} from "../api/tauri";
import { isTypesetPreviewMode } from "../api/browserPreview";
import {
  activeBeamerSlideForLine,
  activeOutlineItemForLine,
  beamerSlidesFor,
  documentSourceForPath,
  includeCandidateGroupsFor,
  includeTargetsFor,
  numberedOutlineFor,
  outlineFor,
  resolveTexPath,
  INCLUDE_MAX_FILES,
} from "./outlineModel";
import { ToolIcon } from "./ToolIcon";
import {
  TypesetOutlinePanel,
} from "./TypesetOutlinePanel";
import {
  basename,
  dirname,
  extension,
  lineNumberForOffset,
  normalizePath,
  sameWorkspacePath,
  wordCountFor,
} from "./latexText";
import CodeEditor from "../editor/CodeEditor";
import { TypesetVisualEditor } from "./TypesetVisualEditor";
import {
  type TypesetTemplate,
} from "./TypesetLibraryCopy";
import { TYPESET_EDITOR_COPY } from "./i18n";
import {
  refineSourceColumn,
  remapCompiledLine,
  wordRatioIn,
} from "./syncTexMapping";
import type { VisualPdfCursor } from "./visualModel";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { clearLatexProjectSymbols, setLatexProjectSymbols, type LatexSymbol } from "../editor/latexComplete";
import { bibEntryDetail, bibliographyTargets, parseBibEntries } from "../editor/latexBib";
import { setLatexCompileMarkers, type LatexCompileMarker } from "../editor/latexLint";
import { useStore } from "../store";
import { suggestedCitationKey, useLiteratureStore } from "../literature/literatureStore";
import {
  findLatexOffsetForPdfText,
  normalizePdfText,
  pdfTextCarriesEnoughSignal,
} from "./pdfTextMatch";
import CompileLog from "./CompileLog";
import {
  compileErrorHandlingStorageKey,
  loadCompileErrorHandling,
  loadCompileOnSave,
  loadLatexEngineChoice,
  loadMainDocument,
  loadPdfInverted,
  loadSpellCheckPreference,
  projectScopedKey,
  writeStoredValue,
  COMPILE_ON_SAVE_STORAGE_PREFIX,
  LATEX_ENGINE_STORAGE_PREFIX,
  MAIN_DOCUMENT_STORAGE_PREFIX,
  PDF_INVERT_STORAGE_KEY,
  SPELL_CHECK_STORAGE_KEY,
  type CompileErrorHandling,
} from "./typesetPreferences";
import { useTypesetPanels } from "./useTypesetPanels";
import TypesetEditorToolbar from "./TypesetEditorToolbar";
import {
  type EditorMode,
} from "./editorCommands";
import TypesetStartPage from "./TypesetStartPage";
import TypesetExplorer, { defaultSourceFor, type TypesetFileMutation } from "./TypesetExplorer";
import TypesetImagePreview from "./TypesetImagePreview";
import TypesetCompiledVisual from "./TypesetCompiledVisual";
import TypesetPdfPreview, { type PdfForwardTarget } from "./TypesetPdfPreview";
import {
  isTypesetImagePath,
  normalizeNewTypesetPath,
  outputPathFor,
  workDirForSource,
} from "./typesetPaths";
import { clampNumber } from "./pdfGeometry";
import { lineOffsetFor } from "./visualTextEdits";
import {
  type CompileLiveLog,
  type CompileResult,
  type CompileStatus,
  type LatexEngineChoice,
} from "./compileModel";
import "./Typeset.css";

// `nonce` forces PdfPage's highlight-flash animation to restart even when the
// user double-clicks the exact same source position twice in a row.
type PendingSourceNavigation = {
  path: string;
  line: number;
  column?: number;
  start?: number;
  end?: number;
  forceCode?: boolean;
  /** `line` came from SyncTeX, so it is numbered against the compiled snapshot
   * and needs remapping through any edits made since the build. */
  fromSyncTex?: boolean;
  /** The word under the pointer in the PDF, used to recover a source column. */
  word?: string;
  /** The full PDF run `word` was taken from, for disambiguating repeats. */
  pdfText?: string;
};
// What `\includegraphics{`, `\input{` and `\bibliography{` can point at. The
// backend glob caps each pattern at 50 hits, so they are split by extension
// rather than asking for everything at once.
const COMPLETABLE_FILE_PATTERNS = [
  "**/*.tex", "**/*.bib", "**/*.pdf", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.eps", "**/*.svg",
];

/**
 * Project-scoped preferences that Overleaf keeps in its project settings: which
 * engine to run, which file is the root document, and whether saving compiles.
 *
 * Compiling on *save* rather than on a typing pause is deliberate. Overleaf
 * rebuilds a few seconds after you stop typing, which is fine against a server
 * farm; locally it means a PDF that reflows under the reader every few seconds.
 * A save is an explicit "this is a state worth looking at".
 */
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 360;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;
const COMPILE_PROGRESS_UPDATE_MS = 100;
function preferredSource(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const sorted = [...paths].sort((left, right) => {
    const score = (path: string) => {
      const normalized = path.toLowerCase().replace(/\\/g, "/");
      if (normalized === ".somniq/papers/main.tex") return 0;
      if (normalized === "papers/main.tex") return 1;
      if (normalized === "main.tex") return 2;
      if (normalized.endsWith("/main.tex")) return 3;
      if (normalized.endsWith(".tex")) return 4;
      return 5;
    };
    return score(left) - score(right) || left.localeCompare(right);
  });
  return sorted[0] ?? null;
}

function sortedSources(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const preferred = preferredSource([left, right]);
    if (preferred === left && preferred !== right) return -1;
    if (preferred === right && preferred !== left) return 1;
    return left.localeCompare(right);
  });
}

/** Wraps the selection in `prefix`/`suffix`; an empty selection wraps `placeholder` instead, pre-selected. */
/**
 * Inserts a snippet at the selection anchor without consuming any selected
 * text (matches Overleaf's `insertCite`/`insertRef`, which insert at
 * `state.selection.main.anchor` — a citation/reference key isn't a sensible
 * substitute for whatever prose happened to be selected).
 */
/** Blank-line padding so a block insert (table/figure) doesn't run into surrounding text. */
/**
 * Simplified, line-based version of Overleaf's tree-based `setSectionHeadingLevel`
 * (`extensions/toolbar/sections.ts`): if the current line already is a section
 * command, swap just the command keyword (or strip it, for "text"); otherwise
 * wrap the selection or the current line's text in the chosen level.
 */
/**
 * Simplified version of Overleaf's `wrapRangeInList` (`extensions/toolbar/lists.ts`):
 * wraps the selected line range in `\begin{itemize}`/`\begin{enumerate}`, one
 * `\item` per line. No nested-list/indent-context awareness (needs the tree).
 */
function nextAnimationFrame(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}







/** PDF text inside a math run must stay LaTeX source, not be prose-escaped. */
/**
 * A click in the compiled PDF, in the terms SyncTeX's `edit` query wants:
 * `x`/`y` are big points from the page's top-left corner. `word` is the word
 * under the pointer when the click landed on text, used to refine the source
 * column SyncTeX itself never reports.
 */
/**
 * The clickable/hoverable boxes for one page's text.
 *
 * The vertical extent comes from the font's own ascent/descent (see
 * `pdfTextRunBox`) rather than from `item.height`, because these boxes have to
 * agree with the boxes SyncTeX recorded: a box sized off the em square sits
 * ~3bp too high, which puts its top edge inside the *previous* typeset line and
 * leaves every descender uncovered.
 */
/**
 * Safe Visual surface for Beamer: the compiled PDF page is the canvas.
 * Arbitrary TikZ/custom macros cannot be reproduced faithfully by a rich-text
 * source decorator, so the compiled output remains the visual truth. Text
 * clicks reveal the exact frame source without pretending to reproduce custom
 * macros in a lossy rich-text model.
 */
/** Resolve PDF.js named and explicit destinations to the one-based page index
 * used by the reader controls. */
/**
 * Figure preview for the right-hand panel. A `\includegraphics` target opened
 * from the file tree is an image, not a PDF, so it takes over the preview slot
 * with image-appropriate controls and a way back to the compiled document.
 */
const SOMNIQ_BIBLIOGRAPHY_STEM = "somniq-references";
const SOMNIQ_BIBLIOGRAPHY_FILE = `${SOMNIQ_BIBLIOGRAPHY_STEM}.bib`;
const SOMNIQ_BIBLIOGRAPHY_HEADER = "% SomniQ managed bibliography — do not edit this file directly.\n";

function bibliographyPathForSource(sourcePath: string): string {
  const segments = sourcePath.replace(/\\/g, "/").split("/");
  segments.pop();
  return [...segments, SOMNIQ_BIBLIOGRAPHY_FILE].filter(Boolean).join("/") || SOMNIQ_BIBLIOGRAPHY_FILE;
}

function sourceUsesSomniqBibliography(source: string): boolean {
  const bibliographyResources = [
    ...source.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g),
    ...source.matchAll(/\\bibliography\s*\{([^}]+)\}/g),
  ];
  return bibliographyResources.some((match) => (
    match[1].split(",").some((item) => (
      item.trim().replace(/\.bib$/i, "") === SOMNIQ_BIBLIOGRAPHY_STEM
    ))
  ));
}

function insertBeforeDocument(source: string, block: string): string {
  const beginDocument = source.search(/\\begin\s*\{document\}/);
  if (beginDocument >= 0) return `${source.slice(0, beginDocument).replace(/\s*$/, "")}\n${block}\n${source.slice(beginDocument)}`;
  return `${source.replace(/\s*$/, "")}\n${block}\n`;
}

function insertBeforeEndDocument(source: string, block: string): string {
  const endDocument = source.lastIndexOf("\\end{document}");
  if (endDocument >= 0) return `${source.slice(0, endDocument).replace(/\s*$/, "")}\n${block}\n${source.slice(endDocument)}`;
  return `${source.replace(/\s*$/, "")}\n${block}\n`;
}

/** Add a separate managed bibliography without ever rewriting user .bib files. */
function withSomniqBibliography(source: string): string {
  const biblatex = /\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  const bibtex = /\\bibliography\s*\{([^}]+)\}/;
  const hasManagedResource = (value: string) => value.split(",").some((item) => item.trim().replace(/\.bib$/i, "") === SOMNIQ_BIBLIOGRAPHY_STEM);
  const usesBiblatex = /\\usepackage(?:\s*\[[^\]]*\])?\s*\{biblatex\}/.test(source) || Array.from(source.matchAll(biblatex)).length > 0;
  if (usesBiblatex) {
    let next = source;
    if (!sourceUsesSomniqBibliography(next)) {
      // \addbibresource belongs in the preamble. Add one independent managed
      // resource instead of changing only the first user declaration (or
      // duplicating it after every declaration).
      next = insertBeforeDocument(next, `% SomniQ bibliography (managed)\n\\addbibresource{${SOMNIQ_BIBLIOGRAPHY_FILE}}`);
    }
    if (!/\\printbibliography\b/.test(next)) {
      next = insertBeforeEndDocument(next, "% SomniQ bibliography (managed)\n\\printbibliography");
    }
    return next;
  }
  if (bibtex.test(source)) {
    return source.replace(bibtex, (whole, resources: string) =>
      hasManagedResource(resources) ? whole : `\\bibliography{${resources.trim()},${SOMNIQ_BIBLIOGRAPHY_STEM}}`,
    );
  }
  return insertBeforeEndDocument(
    source,
    `% SomniQ bibliography (managed)\n\\bibliographystyle{plain}\n\\bibliography{${SOMNIQ_BIBLIOGRAPHY_STEM}}`,
  );
}

/** The text a file had when the PDF now on screen was built, if we have it. */
function compiledSourceFor(
  snapshot: Record<string, string>,
  path: string,
): string | undefined {
  const key = Object.keys(snapshot).find((candidate) => sameWorkspacePath(candidate, path));
  return key === undefined ? undefined : snapshot[key];
}

/** First fully-visible source line, from CodeMirror's own block layout — exact
 * even with wrapped lines, unlike the old textarea version's uniform-line-height
 * pixel math. */
function codeVisibleLineForView(view: EditorView): number {
  const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop));
  return view.state.doc.lineAt(block.from).number;
}

function scrollCodeEditorToLine(view: EditorView, line: number): void {
  const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
  const block = view.lineBlockAt(view.state.doc.line(clampedLine).from);
  view.scrollDOM.scrollTop = Math.max(0, block.top - view.scrollDOM.clientHeight * 0.28);
}

export default function Typeset() {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const currentProject = useStore((state) => state.currentProject);
  const setTypesetDirty = useStore((state) => state.setTypesetDirty);
  const pendingTypesetFilePath = useStore((state) => state.pendingTypesetFilePath);
  const setPendingTypesetFilePath = useStore((state) => state.setPendingTypesetFilePath);
  const literaturePapers = useLiteratureStore((state) => state.library.papers);
  const loadLiterature = useLiteratureStore((state) => state.load);
  const ensureCitationKeys = useLiteratureStore((state) => state.ensureCitationKeys);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [lastPdfPreviewPath, setLastPdfPreviewPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [activeCompileRunId, setActiveCompileRunId] = useState<string | null>(null);
  const [compileErrorHandling, setCompileErrorHandling] = useState<CompileErrorHandling>(() => loadCompileErrorHandling(currentProject?.id));
  const [latexEngine, setLatexEngine] = useState<LatexEngineChoice>(() => loadLatexEngineChoice(currentProject?.id));
  const [compileOnSave, setCompileOnSave] = useState(() => loadCompileOnSave(currentProject?.id));
  const [mainDocumentPath, setMainDocumentPath] = useState<string | null>(() => loadMainDocument(currentProject?.id));
  const [pdfInverted, setPdfInverted] = useState(() => loadPdfInverted());
  const [compileLiveLog, setCompileLiveLog] = useState<CompileLiveLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  /** The root and source graph of the current LaTeX document. They deliberately
   * outlive individual file switches so opening `chapters/intro.tex` keeps the
   * root outline, compiled PDF, and sibling navigation intact. */
  const [documentRootPath, setDocumentRootPath] = useState<string | null>(null);
  const [documentSources, setDocumentSources] = useState<Record<string, string>>({});
  const [documentGraphTruncated, setDocumentGraphTruncated] = useState(false);
  const [syncTexOutdated, setSyncTexOutdated] = useState(false);
  // The source of every file as it was when the PDF on screen was built. This
  // is what lets an inverse-search hit stay accurate while the buffer is dirty:
  // SyncTeX numbers its answer against this snapshot, and the difference
  // between it and the live draft is exactly the edit to remap through.
  const compiledSourcesRef = useRef<Record<string, string>>({});
  const [pendingSourceNavigation, setPendingSourceNavigation] = useState<PendingSourceNavigation | null>(null);
  const [startDocuments, setStartDocuments] = useState<TypesetDocument[]>([]);
  const [startProjects, setStartProjects] = useState<TypesetProject[]>([]);
  const [latexAvailable, setLatexAvailable] = useState<boolean | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [spellCheck, setSpellCheck] = useState(loadSpellCheckPreference);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [visualPdfCursor, setVisualPdfCursor] = useState<VisualPdfCursor | null>(null);
  const [pdfForwardTarget, setPdfForwardTarget] = useState<PdfForwardTarget | null>(null);
  const [forwardSearchNotice, setForwardSearchNotice] = useState<string | null>(null);
  const {
    projectPanelVisible, setProjectPanelVisible,
    pdfPanelVisible, setPdfPanelVisible,
    projectPanelWidth, pdfPanelWidth,
    outlinePanelHeight,
    outlineCollapsed, setOutlineCollapsed,
    beginPanelResizeFromPointer, beginOutlineResizeFromPointer,
    handlePanelResizeKey, handleOutlineResizeKey,
  } = useTypesetPanels();
  const [slideFocusMode, setSlideFocusMode] = useState(true);
  const [currentSourceLine, setCurrentSourceLine] = useState(1);
  // CodeMirror reports edits synchronously, while React may defer committing the
  // matching state update. Keep the authoritative latest source in a ref so a
  // Recompile click immediately after an edit cannot save the previous draft.
  const draftRef = useRef("");
  // PDF text layers may retain their click handler for longer than a render
  // cycle. Read the current mode from a ref so reverse search always targets
  // the visible Code surface when the user has selected Code mode.
  const editorModeRef = useRef<EditorMode>(editorMode);
  editorModeRef.current = editorMode;
  // Mirror the panel widths into refs so the drag callbacks can read the current
  // size without listing the widths as dependencies. Keeping the callbacks stable
  // stops the window/document listener effect from tearing down (and aborting the
  // active drag) every time a resize updates the width state.
  const editorRef = useRef<SharedEditorHandle | null>(null);
  // Live CodeMirror view for Visual mode, mirroring `editorRef` for Code mode —
  // lets the toolbar apply edits at whichever editor's real selection is
  // current, instead of always inserting near `\end{document}`.
  const visualViewRef = useRef<EditorView | null>(null);
  const onVisualViewReady = useCallback((view: EditorView | null) => {
    visualViewRef.current = view;
  }, []);
  const previewAutoOpenedRef = useRef(false);
  // Tracks the last source path we auto-compiled so opening a tex compiles it
  // once (matching Recompile), instead of leaving the PDF stale/empty until the
  // user manually recompiles.
  const compileRef = useRef<() => void>(() => {});
  /** Read from the Ctrl+S keymap, which CodeMirror captured at mount. */
  const compileOnSaveRef = useRef(true);
  /**
   * The open tabs, and the unsaved draft each *inactive* one is holding. The
   * active tab's draft lives in `draft`; a tab only enters this map when it
   * loses focus, and leaves it again when it regains it.
   */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openDraftsRef = useRef(new Map<string, { draft: string; loaded: FileText }>());
  const [inactiveDirtyPaths, setInactiveDirtyPaths] = useState<string[]>([]);
  const publishOpenDrafts = useCallback(() => {
    const dirtyPaths: string[] = [];
    for (const [path, entry] of openDraftsRef.current) {
      if (entry.draft !== entry.loaded.content) dirtyPaths.push(path);
    }
    setInactiveDirtyPaths((current) => (
      current.length === dirtyPaths.length && current.every((path, index) => path === dirtyPaths[index])
        ? current
        : dirtyPaths
    ));
  }, []);
  const compileSequenceRef = useRef(0);
  const documentEpochRef = useRef(0);
  const compileEpochRef = useRef(0);
  const forwardSearchEpochRef = useRef(0);
  const sourcePathRef = useRef<string | null>(sourcePath);
  const documentRootPathRef = useRef<string | null>(documentRootPath);
  const documentSourcesRef = useRef<Record<string, string>>(documentSources);
  const loadedRef = useRef<FileText | null>(loaded);
  const activeCompileRunIdRef = useRef<string | null>(activeCompileRunId);
  const saveInFlightRef = useRef<Promise<FileText | null> | null>(null);
  const compileProgressTimerRef = useRef<number | null>(null);
  const pendingCompileProgressRef = useRef<(CompileLiveLog & { runId: string }) | null>(null);
  sourcePathRef.current = sourcePath;
  documentRootPathRef.current = documentRootPath;
  documentSourcesRef.current = documentSources;
  loadedRef.current = loaded;
  activeCompileRunIdRef.current = activeCompileRunId;

  useEffect(() => () => {
    if (compileProgressTimerRef.current !== null) {
      window.clearTimeout(compileProgressTimerRef.current);
      compileProgressTimerRef.current = null;
    }
    pendingCompileProgressRef.current = null;
  }, []);

  useEffect(() => {
    setCompileErrorHandling(loadCompileErrorHandling(currentProject?.id));
  }, [currentProject?.id]);

  // Citation completion reads the shared literature store. Loading it
  // re-projects every canonical record, which is seconds of work and tens of
  // megabytes of JSON on a large library — far too much to repeat every time
  // this tab is opened. Load it only when this project's library is not
  // already in memory; the Library tab owns keeping it current after that.
  //
  // What this can go stale on is the citation picker's list, not the
  // bibliography: `synchronizeBibliography` exports from the backend, so the
  // generated `.bib` always reflects the current library either way.
  useEffect(() => {
    if (!currentProject?.id || !isTauri()) return;
    const { loaded, loadedProjectId } = useLiteratureStore.getState();
    if (loaded && loadedProjectId === currentProject.id) return;
    void loadLiterature(currentProject.id, { quiet: true });
  }, [currentProject?.id, loadLiterature]);

  useEffect(() => {
    let active = true;
    void localEnvironmentCheck("latex")
      .then((check) => {
        if (active) setLatexAvailable(check.available);
      })
      .catch(() => {
        if (active) setLatexAvailable(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // Only include directives, file switches, and tree mutations drive the graph
  // reads below. Ordinary typing updates the open file through the memoized
  // override used by the outline without re-reading the whole thesis.
  const includeSignature = useMemo(
    () => (sourcePath ? includeTargetsFor(draft, sourcePath, documentRootPath ?? sourcePath).join("\n") : ""),
    [documentRootPath, draft, sourcePath],
  );

  useEffect(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath || !sourcePath) {
      setDocumentSources((current) => (Object.keys(current).length === 0 ? current : {}));
      setDocumentGraphTruncated(false);
      return;
    }
    let active = true;
    void (async () => {
      const nextSources: Record<string, string> = {};
      const attempted = new Set<string>();
      const processed = new Set<string>();
      const queue: string[][] = [[rootPath]];
      while (queue.length > 0 && Object.keys(nextSources).length < INCLUDE_MAX_FILES) {
        const candidates = queue.shift();
        if (!candidates) continue;
        let loaded: { path: string; source: string } | null = null;
        for (const candidate of candidates) {
          loaded = documentSourceForPath(nextSources, candidate);
          if (loaded) break;
          if ([...attempted].some((path) => sameWorkspacePath(path, candidate))) continue;
          attempted.add(candidate);
          try {
            const content = sameWorkspacePath(candidate, sourcePath)
              ? draftRef.current
              : (await fileReadText(candidate)).content;
            if (!active) return;
            nextSources[candidate] = content;
            loaded = { path: candidate, source: content };
            break;
          } catch {
            // Try the next compiler-compatible candidate for this directive.
          }
        }
        if (!loaded || [...processed].some((path) => sameWorkspacePath(path, loaded.path))) continue;
        processed.add(loaded.path);
        queue.push(...includeCandidateGroupsFor(loaded.source, loaded.path, rootPath));
      }
      if (active) {
        setDocumentSources(nextSources);
        setDocumentGraphTruncated(queue.length > 0);
      }
    })();
    return () => {
      active = false;
    };
  }, [documentRootPath, includeSignature, sourcePath, treeRefreshKey]);

  const toggleSpellCheck = useCallback(() => {
    setSpellCheck((enabled) => {
      const next = !enabled;
      try {
        window.localStorage.setItem(SPELL_CHECK_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // The choice still applies for this session without local storage.
      }
      return next;
    });
  }, []);

  const setCompileErrorHandlingPreference = useCallback((value: CompileErrorHandling) => {
    setCompileErrorHandling(value);
    try {
      window.localStorage.setItem(compileErrorHandlingStorageKey(currentProject?.id), value);
    } catch {
      // The preference remains active for this session if local storage is unavailable.
    }
  }, [currentProject?.id]);

  const setLatexEnginePreference = useCallback((value: LatexEngineChoice) => {
    setLatexEngine(value);
    writeStoredValue(
      projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, currentProject?.id),
      value === "auto" ? null : value,
    );
  }, [currentProject?.id]);

  const setCompileOnSavePreference = useCallback((value: boolean) => {
    setCompileOnSave(value);
    writeStoredValue(
      projectScopedKey(COMPILE_ON_SAVE_STORAGE_PREFIX, currentProject?.id),
      value ? "on" : "off",
    );
  }, [currentProject?.id]);

  const setMainDocumentPreference = useCallback((value: string | null) => {
    setMainDocumentPath(value);
    writeStoredValue(projectScopedKey(MAIN_DOCUMENT_STORAGE_PREFIX, currentProject?.id), value);
  }, [currentProject?.id]);

  /** Save-as for the compiled PDF: the workspace copy stays where TeX put it. */
  const exportPreviewPdf = useCallback(async () => {
    if (!previewPath) return;
    const suggested = previewPath.split(/[\\/]/).pop() || "document.pdf";
    try {
      const destination = await saveDialog({
        defaultPath: suggested,
        filters: [{ name: copy.pdfFilter, extensions: ["pdf"] }],
      });
      if (typeof destination !== "string") return;
      await typesetExportFile(previewPath, destination);
      setForwardSearchNotice(copy.pdfSaved(destination));
    } catch (exportError) {
      setError(String(exportError));
    }
  }, [copy, previewPath]);

  const togglePdfInverted = useCallback(() => {
    setPdfInverted((inverted) => {
      const next = !inverted;
      writeStoredValue(PDF_INVERT_STORAGE_KEY, next ? "on" : "off");
      return next;
    });
  }, []);

  const dirty = Boolean(loaded && draft !== loaded.content);
  const syncTexMappingStale = syncTexOutdated || dirty || compileResult?.pdfState === "stale" || compileResult?.pdfState === "partial";
  useEffect(() => {
    // A background tab holding unsaved edits still counts: the close guard has
    // to warn about work the editor is not currently showing.
    setTypesetDirty(dirty || inactiveDirtyPaths.length > 0);
  }, [dirty, inactiveDirtyPaths.length, setTypesetDirty]);
  const outlineSources = useMemo(() => (
    sourcePath ? { ...documentSources, [sourcePath]: draft } : documentSources
  ), [documentSources, draft, sourcePath]);
  const outline = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return [];
    const rootSource = documentSourceForPath(outlineSources, rootPath)?.source
      ?? (sameWorkspacePath(rootPath, sourcePath) ? draft : "");
    return rootSource ? outlineFor(rootSource, rootPath, outlineSources) : [];
  }, [documentRootPath, draft, outlineSources, sourcePath]);
  const numberedOutline = useMemo(() => numberedOutlineFor(outline), [outline]);
  // Counted over the whole document graph, so a thesis root reports the thesis
  // rather than the handful of words in its shell.
  const documentWordCount = useMemo(
    () => Object.values(outlineSources).reduce((total, source) => total + wordCountFor(source), 0),
    [outlineSources],
  );

  // Autocomplete for \ref{ and \cite{ needs keys the open file alone can't
  // supply: a label defined in another chapter of the same thesis, and the
  // library entries the citation picker inserts.
  const projectLabels = useMemo(() => {
    const labels: LatexSymbol[] = [];
    const seen = new Set<string>();
    for (const [path, source] of Object.entries(outlineSources)) {
      const pattern = /\\label\s*\{([^{}]+)\}/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const name = match[1].trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        labels.push({ name, detail: basename(path) });
      }
    }
    return labels;
  }, [outlineSources]);
  // Most projects keep their references in a hand-maintained .bib rather than
  // the app library, so follow \bibliography{}/\addbibresource{} the same way
  // the outline follows \input and read the keys from there too.
  const bibliographySignature = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return "";
    const targets: string[] = [];
    for (const [path, source] of Object.entries(outlineSources)) {
      for (const target of bibliographyTargets(source)) {
        for (const base of [dirname(rootPath), dirname(path)]) {
          const resolved = resolveTexPath(target, base, ".bib");
          if (resolved && !targets.includes(resolved)) targets.push(resolved);
        }
      }
    }
    return targets.join("\n");
  }, [documentRootPath, outlineSources, sourcePath]);

  const [bibCitations, setBibCitations] = useState<LatexSymbol[]>([]);
  useEffect(() => {
    if (!bibliographySignature) {
      setBibCitations((current) => (current.length === 0 ? current : []));
      return;
    }
    let active = true;
    void (async () => {
      const citations: LatexSymbol[] = [];
      const seen = new Set<string>();
      for (const path of bibliographySignature.split("\n")) {
        try {
          const file = await fileReadText(path);
          if (!active) return;
          for (const entry of parseBibEntries(file.content)) {
            if (seen.has(entry.key)) continue;
            seen.add(entry.key);
            citations.push({ name: entry.key, detail: bibEntryDetail(entry) });
          }
        } catch {
          // A .bib named but not present yet simply contributes no keys.
        }
      }
      if (active) setBibCitations(citations);
    })();
    return () => {
      active = false;
    };
  }, [bibliographySignature, treeRefreshKey]);

  const projectCitations = useMemo(() => {
    const citations = literaturePapers.map((paper) => ({
      name: paper.citationKey || suggestedCitationKey(paper),
      detail: paper.title,
    }));
    const seen = new Set(citations.map((citation) => citation.name));
    return [...citations, ...bibCitations.filter((citation) => !seen.has(citation.name))];
  }, [bibCitations, literaturePapers]);

  // File paths for \includegraphics{} / \input{} / \bibliography{}, relative to
  // the compile root the way TeX itself resolves them.
  const [projectFiles, setProjectFiles] = useState<LatexSymbol[]>([]);
  useEffect(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return;
    let active = true;
    void (async () => {
      const rootDir = dirname(rootPath);
      const found: LatexSymbol[] = [];
      const seen = new Set<string>();
      for (const pattern of COMPLETABLE_FILE_PATTERNS) {
        let matches: string[] = [];
        try {
          // Completion only needs files belonging to the current document.
          // Passing the root directory avoids repeating a workspace-wide glob
          // for every extension when a project contains many unrelated files.
          const result = await fileSearch(pattern, rootDir);
          // `fileSearch` is mocked in some tests to return undefined; treat
          // anything non-array as "no matches for this pattern" instead of
          // letting the for-of throw and surface as an unhandled rejection.
          matches = Array.isArray(result) ? result : [];
        } catch {
          continue;
        }
        if (!active) return;
        for (const match of matches) {
          const path = normalizePath(match);
          const relative = rootDir && path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
          if (seen.has(relative)) continue;
          seen.add(relative);
          found.push({ name: relative, detail: dirname(relative) || undefined });
        }
      }
      if (active) setProjectFiles(found);
    })();
    return () => {
      active = false;
    };
  }, [documentRootPath, sourcePath, treeRefreshKey]);

  useEffect(() => {
    setLatexProjectSymbols({ labels: projectLabels, citations: projectCitations, files: projectFiles });
  }, [projectCitations, projectFiles, projectLabels]);
  useEffect(() => clearLatexProjectSymbols, []);

  // Compiler errors belong on the offending line, not only in the log panel.
  // A diagnostic without a file belongs to the root document TeX was given.
  const compileMarkers = useMemo<LatexCompileMarker[]>(() => {
    if (!sourcePath) return [];
    const rootPath = compileResult?.inputPath ?? documentRootPath ?? sourcePath;
    return (compileResult?.diagnostics ?? [])
      .filter((diagnostic) => (diagnostic.line ?? 0) > 0 && sameWorkspacePath(diagnostic.filePath || rootPath, sourcePath))
      .map((diagnostic) => ({
        line: diagnostic.line ?? 1,
        severity: diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "info",
        message: diagnostic.code ? `${diagnostic.message} (${diagnostic.code})` : diagnostic.message,
      }));
  }, [compileResult?.diagnostics, compileResult?.inputPath, documentRootPath, sourcePath]);

  useEffect(() => {
    for (const view of [editorRef.current?.view, visualViewRef.current]) {
      if (!view) continue;
      view.dispatch({ effects: setLatexCompileMarkers.of(compileMarkers) });
    }
  }, [compileMarkers, editorMode]);

  const beamerSlides = useMemo(() => beamerSlidesFor(draft), [draft]);
  const activeOutlineItem = useMemo(
    // Lines from an included chapter belong to another file, so only the open
    // file's own headings can track the cursor.
    () => activeOutlineItemForLine(numberedOutline.filter((item) => sameWorkspacePath(item.file, sourcePath)), currentSourceLine),
    [currentSourceLine, numberedOutline, sourcePath],
  );
  const activeBeamerSlide = useMemo(
    () => activeBeamerSlideForLine(beamerSlides, currentSourceLine),
    [beamerSlides, currentSourceLine],
  );
  const activeBeamerPage = Math.max(1, activeBeamerSlide ? beamerSlides.indexOf(activeBeamerSlide) + 1 : 1);
  const slideFocusActive = editorMode === "visual" && beamerSlides.length > 0 && slideFocusMode;
  const effectiveProjectPanelVisible = projectPanelVisible && !slideFocusActive;
  const effectivePdfPanelVisible = pdfPanelVisible && !slideFocusActive;
  const activeWorkDir = useMemo(
    () => workDirForSource(documentRootPath ?? compileResult?.inputPath ?? sourcePath ?? previewPath),
    [compileResult?.inputPath, documentRootPath, previewPath, sourcePath],
  );
  const browserPreviewMode = !isTauri();
  const diagnosticsCount = useMemo(() => {
    if (compileResult?.diagnostics?.length) return compileResult.diagnostics.length;
    const text = [error, compileResult?.stderr].filter(Boolean).join("\n").trim();
    if (!text) return 0;
    const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return Math.min(count, 9);
  }, [compileResult?.diagnostics, compileResult?.stderr, error]);
  const activeEditorView = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
  const canUndoDraft = Boolean(activeEditorView && undoDepth(activeEditorView.state) > 0);
  const canRedoDraft = Boolean(activeEditorView && redoDepth(activeEditorView.state) > 0);

  const resetDraft = useCallback((nextDraft: string) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const invalidateActiveCompile = useCallback(() => {
    compileEpochRef.current += 1;
    forwardSearchEpochRef.current += 1;
    const runId = activeCompileRunIdRef.current;
    activeCompileRunIdRef.current = null;
    setActiveCompileRunId(null);
    if (runId) {
      setCompileStatus("idle");
      setCompileLiveLog(null);
      void latexCompileCancel(runId).catch(() => {
        // A document transition must not be blocked by a best-effort cancel.
      });
    }
  }, []);

  useEffect(() => () => {
    documentEpochRef.current += 1;
    compileEpochRef.current += 1;
    const runId = activeCompileRunIdRef.current;
    activeCompileRunIdRef.current = null;
    if (runId) void latexCompileCancel(runId).catch(() => undefined);
  }, []);

  const changeDraft = useCallback((nextDraft: string) => {
    if (nextDraft !== draftRef.current) setSyncTexOutdated(true);
    draftRef.current = nextDraft;
    const codeView = editorRef.current?.view;
    const visualView = visualViewRef.current;
    // Both surfaces stay mounted. The editor that received the user edit has
    // already recorded it; its counterpart must receive an external change so
    // Ctrl+Z never traverses another editor's history.
    if (codeView && codeView.state.doc.toString() !== nextDraft) {
      editorRef.current?.setDocument(nextDraft, { addToHistory: false, preserveSelection: true });
    }
    if (visualView && visualView.state.doc.toString() !== nextDraft) {
      visualView.dispatch({
        changes: { from: 0, to: visualView.state.doc.length, insert: nextDraft },
        annotations: Transaction.addToHistory.of(false),
      });
    }
    setDraft(nextDraft);
  }, []);

  const prepareCitationKeys = useCallback(async (ids: string[]) => {
    const keysById = await ensureCitationKeys(ids);
    return ids.map((id) => keysById[id]).filter((key): key is string => Boolean(key));
  }, [ensureCitationKeys]);

  const synchronizeBibliography = useCallback(async (
    expectedSourcePath = sourcePathRef.current,
    expectedDraft = draftRef.current,
  ) => {
    const activeSourcePath = expectedSourcePath;
    if (!activeSourcePath) throw new Error(copy.openSourceBeforeCitation);
    // The export and file operations below are asynchronous. Capture both
    // identities at the call site so a delayed sync cannot modify a newly
    // opened document.
    const remainsCurrent = () => (
      sourcePathRef.current === activeSourcePath && draftRef.current === expectedDraft
    );
    const bibliography = await literatureExportBibliography<{ content: string }>({ format: "bibtex" });
    if (!remainsCurrent()) return;
    const bibliographyPath = bibliographyPathForSource(activeSourcePath);
    const managedContent = `${SOMNIQ_BIBLIOGRAPHY_HEADER}${bibliography.content}`;
    let existing: FileText | null = null;
    try {
      existing = await fileReadText(bibliographyPath);
    } catch {
      // A missing generated bibliography is created below. Other read failures
      // are caught by the subsequent write/create operation.
    }
    if (!remainsCurrent()) return;
    if (existing && !existing.content.startsWith(SOMNIQ_BIBLIOGRAPHY_HEADER)) {
      throw new Error(copy.bibAlreadyExists(SOMNIQ_BIBLIOGRAPHY_FILE));
    }
    if (existing) {
      await fileWriteText(bibliographyPath, managedContent);
    } else {
      try {
        await fileCreateText(bibliographyPath, managedContent);
      } catch (createError) {
        // Another writer may have created the file after the read above. Never
        // overwrite an unmanaged bibliography in that race; only refresh the
        // managed file we own.
        let racedFile: FileText;
        try {
          racedFile = await fileReadText(bibliographyPath);
        } catch {
          throw createError;
        }
        if (!remainsCurrent()) return;
        if (!racedFile.content.startsWith(SOMNIQ_BIBLIOGRAPHY_HEADER)) {
          throw new Error(copy.bibAlreadyExists(SOMNIQ_BIBLIOGRAPHY_FILE));
        }
        await fileWriteText(bibliographyPath, managedContent);
      }
    }
    if (!remainsCurrent()) return;
    const sourceWithBibliography = withSomniqBibliography(expectedDraft);
    if (sourceWithBibliography !== expectedDraft) changeDraft(sourceWithBibliography);
    setTreeRefreshKey((value) => value + 1);
  }, [changeDraft]);

  const citationLibraryFingerprint = useMemo(
    () => literaturePapers
      .map((paper) => [
        paper.id,
        paper.citationKey,
        paper.title,
        paper.authors.join("\u0001"),
        paper.year,
        paper.venue,
        paper.doi,
        paper.isbn,
        paper.url,
        paper.abstract,
        paper.tags.join("\u0001"),
      ].join("\u0002"))
      .sort()
      .join("\u0003"),
    [literaturePapers],
  );
  const sourceUsesManagedBibliography = sourceUsesSomniqBibliography(draft);

  useEffect(() => {
    if (!sourcePath || !sourceUsesManagedBibliography) return;
    let active = true;
    const expectedSourcePath = sourcePath;
    const expectedDraft = draft;
    const timer = window.setTimeout(() => {
      void synchronizeBibliography(expectedSourcePath, expectedDraft).catch((syncError) => {
        if (active) setError(copy.couldNotSyncBibliography(SOMNIQ_BIBLIOGRAPHY_FILE, String(syncError)));
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [citationLibraryFingerprint, draft, sourcePath, sourceUsesManagedBibliography, synchronizeBibliography]);

  const undoDraft = useCallback(() => {
    const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (view) undo(view);
  }, [editorMode]);

  const redoDraft = useCallback(() => {
    const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (view) redo(view);
  }, [editorMode]);

  const changeEditorMode = useCallback((nextMode: EditorMode) => {
    if (nextMode === editorMode) return;
    const sourceView = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    const selection = sourceView?.state.selection.main;
    const line = selection && sourceView
      ? sourceView.state.doc.lineAt(selection.head).number
      : currentSourceLine;
    setCurrentSourceLine(line);
    setEditorMode(nextMode);
    const targetView = nextMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (!targetView) return;
    const fallback = lineOffsetFor(draft, line);
    const anchor = clampNumber(selection?.anchor ?? fallback, 0, targetView.state.doc.length);
    const head = clampNumber(selection?.head ?? fallback, 0, targetView.state.doc.length);
    targetView.focus();
    targetView.dispatch({ selection: { anchor, head } });
    if (nextMode === "code") {
      scrollCodeEditorToLine(targetView, line);
    } else {
      targetView.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
    }
  }, [currentSourceLine, draft, editorMode]);

  const openSource = useCallback(async (
    path: string,
    initialLine = 1,
    preserveDocument = false,
  ): Promise<boolean> => {
    const currentPath = sourcePathRef.current;
    if (sameWorkspacePath(currentPath, path)) {
      setCurrentSourceLine(initialLine);
      setPendingSourceNavigation({ path, line: initialLine });
      return true;
    }
    // Switching files keeps the one being left open, unsaved edits and all —
    // that is what a tab *is*. The old prompt existed because the editor could
    // only hold one document at a time.
    const currentFile = loadedRef.current;
    if (currentPath && currentFile) {
      openDraftsRef.current.set(currentPath, { draft: draftRef.current, loaded: currentFile });
      publishOpenDrafts();
    }
    const documentEpoch = ++documentEpochRef.current;
    const currentRoot = documentRootPathRef.current;
    const belongsToCurrentDocument = preserveDocument
      || sameWorkspacePath(path, currentRoot)
      || Object.keys(documentSourcesRef.current).some((source) => sameWorkspacePath(source, path));
    invalidateActiveCompile();
    setLoading(true);
    setSaving(false);
    setError(null);
    try {
      const snapshot = openDraftsRef.current.get(path);
      const [file, contextResolution] = await Promise.all([
        // A tab that was opened before keeps the draft it had; only a file
        // being opened for the first time is read from disk.
        snapshot ? Promise.resolve(snapshot.loaded) : fileReadText(path),
        belongsToCurrentDocument
          ? Promise.resolve({ context: null, error: null })
          : latexDocumentContext(path)
              .then((context) => ({ context, error: null }))
              .catch((contextError) => ({ context: null, error: String(contextError) })),
      ]);
      if (documentEpochRef.current !== documentEpoch) return false;
      setSourcePath(file.path);
      setLoaded(file);
      resetDraft(snapshot ? snapshot.draft : file.content);
      openDraftsRef.current.delete(file.path);
      setOpenTabs((tabs) => (tabs.includes(file.path) ? tabs : [...tabs, file.path]));
      publishOpenDrafts();
      setDocumentSources((sources) => belongsToCurrentDocument
        ? { ...sources, [file.path]: file.content }
        : { [file.path]: file.content });
      if (!belongsToCurrentDocument) {
        const rootPath = contextResolution.context?.rootPath ?? file.path;
        const outputPath = contextResolution.context?.outputPath ?? outputPathFor(rootPath);
        setDocumentRootPath(rootPath);
        setPreviewPath(outputPath);
        setLastPdfPreviewPath(outputPath);
        setDocumentGraphTruncated(false);
        setSyncTexOutdated(false);
        if (contextResolution.error) setError(contextResolution.error);
      }
      setVisualPdfCursor(null);
      setCurrentSourceLine(initialLine);
      setPendingSourceNavigation({ path: file.path, line: initialLine });
      if (!belongsToCurrentDocument) {
        setCompileStatus("idle");
        setCompileResult(null);
        setCompileLiveLog(null);
      }
      return true;
    } catch (openError) {
      if (documentEpochRef.current === documentEpoch) setError(String(openError));
      return false;
    } finally {
      if (documentEpochRef.current === documentEpoch) setLoading(false);
    }
  }, [invalidateActiveCompile, resetDraft]);

  /**
   * Close a tab. An unsaved draft is only discarded on an explicit confirm —
   * closing is the one place a tab can lose work, since switching no longer can.
   */
  const closeTab = useCallback((path: string) => {
    const isActive = sameWorkspacePath(path, sourcePathRef.current);
    const snapshot = openDraftsRef.current.get(path);
    const unsaved = isActive
      ? Boolean(loadedRef.current && draftRef.current !== loadedRef.current.content)
      : Boolean(snapshot && snapshot.draft !== snapshot.loaded.content);
    if (unsaved && !window.confirm(copy.discardUnsavedChangesClose(basename(path)))) return;
    openDraftsRef.current.delete(path);
    publishOpenDrafts();
    setOpenTabs((tabs) => {
      const remaining = tabs.filter((tab) => !sameWorkspacePath(tab, path));
      if (isActive) {
        const index = tabs.findIndex((tab) => sameWorkspacePath(tab, path));
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) {
          // The draft of the tab being closed must not follow us into the next
          // one, so drop it before the load reads the snapshot map.
          // A neighboring tab may belong to a different LaTeX project. Let
          // openSource resolve that tab's document root instead of preserving
          // the project that is being closed.
          window.setTimeout(() => void openSource(next), 0);
        } else {
          setSourcePath(null);
          setLoaded(null);
          resetDraft("");
        }
      }
      return remaining;
    });
  }, [copy, openSource, publishOpenDrafts, resetDraft]);

  const openPath = useCallback((path: string) => {
    if (extension(path) === ".tex") {
      void openSource(path);
      return;
    }
    if (extension(path) === ".pdf") {
      forwardSearchEpochRef.current += 1;
      setPreviewPath(path);
      setLastPdfPreviewPath(path);
      setPdfPanelVisible(true);
      setSlideFocusMode(false);
      setRefreshKey((key) => key + 1);
      return;
    }
    if (isTypesetImagePath(path)) {
      forwardSearchEpochRef.current += 1;
      setPreviewPath(path);
      setPdfPanelVisible(true);
      setSlideFocusMode(false);
      setLogOpen(false);
      setRefreshKey((key) => key + 1);
    }
  }, [openSource]);

  const handleFileMutation = useCallback((mutation: TypesetFileMutation) => {
    const pathMatches = (path: string | null, target: string) => Boolean(path && (
      sameWorkspacePath(path, target)
      || (mutation.isDir && normalizePath(path).startsWith(`${normalizePath(target)}/`))
    ));
    if (mutation.type === "delete") {
      for (const path of [...openDraftsRef.current.keys()]) {
        if (pathMatches(path, mutation.path)) openDraftsRef.current.delete(path);
      }
      publishOpenDrafts();
      setOpenTabs((tabs) => tabs.filter((tab) => !pathMatches(tab, mutation.path)));
      setLastPdfPreviewPath((path) => pathMatches(path, mutation.path) ? null : path);
      if (pathMatches(sourcePath, mutation.path) || pathMatches(previewPath, mutation.path)) {
        documentEpochRef.current += 1;
        invalidateActiveCompile();
        setSourcePath(null);
        setPreviewPath(null);
        setLastPdfPreviewPath(null);
        setLoaded(null);
        resetDraft("");
        setDocumentRootPath(null);
        setDocumentSources({});
        setDocumentGraphTruncated(false);
        setSyncTexOutdated(false);
        setCompileStatus("idle");
        setCompileResult(null);
        setCompileLiveLog(null);
        setLogOpen(false);
      }
      setTreeRefreshKey((key) => key + 1);
      return;
    }

    const renamedPath = (path: string | null) => {
      if (!path) return null;
      if (sameWorkspacePath(path, mutation.path)) return mutation.newPath;
      const normalizedPath = normalizePath(path);
      const normalizedTarget = normalizePath(mutation.path);
      if (mutation.isDir && normalizedPath.startsWith(`${normalizedTarget}/`)) {
        return `${mutation.newPath}/${normalizedPath.slice(normalizedTarget.length + 1)}`;
      }
      return path;
    };
    const nextSourcePath = renamedPath(sourcePath);
    const nextDocumentRootPath = renamedPath(documentRootPath);
    if (nextSourcePath !== sourcePath) {
      documentEpochRef.current += 1;
      invalidateActiveCompile();
    }
    setSourcePath(nextSourcePath);
    setDocumentRootPath(nextDocumentRootPath);
    setPreviewPath(renamedPath(previewPath));
    setLastPdfPreviewPath((path) => renamedPath(path));
    setLoaded((file) => file && nextSourcePath ? { ...file, path: nextSourcePath } : file);
    setDocumentSources((sources) => Object.fromEntries(Object.entries(sources).map(([path, content]) => [renamedPath(path) ?? path, content])));
    setTreeRefreshKey((key) => key + 1);
  }, [documentRootPath, invalidateActiveCompile, previewPath, publishOpenDrafts, resetDraft, sourcePath]);

  const createSource = useCallback(async (path: string, template: TypesetTemplate = "article", title = "SomniQ LaTeX Draft") => {
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setError(null);
    try {
      const normalized = normalizeNewTypesetPath(path);
      const file = await fileCreateText(normalized, defaultSourceFor(normalized, template, title));
      if (documentEpochRef.current !== documentEpoch) return;
      // Templates always seed their own folder, so that folder is the project
      // the library groups this document under until the next scan.
      const createdProjectPath = dirname(file.path);
      setStartDocuments((documents) => [
        {
          path: file.path,
          projectPath: createdProjectPath,
          title,
          kind: template,
          modifiedEpochMs: Date.now(),
          compileState: "missing",
        },
        ...documents.filter((document) => document.path !== file.path),
      ]);
      setStartProjects((projects) => (
        projects.some((project) => project.path === createdProjectPath)
          ? projects
          : [
            {
              path: createdProjectPath,
              name: basename(createdProjectPath),
              texFileCount: 1,
              modifiedEpochMs: Date.now(),
            },
            ...projects,
          ]
      ));
      setTreeRefreshKey((key) => key + 1);
      setSourcePath(file.path);
      setDocumentRootPath(file.path);
      setDocumentSources({ [file.path]: file.content });
      setDocumentGraphTruncated(false);
      setSyncTexOutdated(false);
      const outputPath = outputPathFor(file.path);
      setPreviewPath(outputPath);
      setLastPdfPreviewPath(outputPath);
      setLoaded(file);
      resetDraft(file.content);
      setVisualPdfCursor(null);
      setCurrentSourceLine(1);
      setCompileStatus("idle");
      setCompileResult(null);
      setCompileLiveLog(null);
    } catch (createError) {
      if (documentEpochRef.current === documentEpoch) setError(String(createError));
    }
  }, [invalidateActiveCompile, resetDraft]);

  const scanProject = useCallback(async () => {
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setLoading(true);
    setSaving(false);
    setError(null);
    setLoaded(null);
    resetDraft("");
    setSourcePath(null);
    setDocumentRootPath(null);
    setDocumentSources({});
    setDocumentGraphTruncated(false);
    setSyncTexOutdated(false);
    setPreviewPath(null);
    setLastPdfPreviewPath(null);
    setCompileStatus("idle");
    setCompileResult(null);
    setCompileLiveLog(null);
    setLogOpen(false);
    setVisualPdfCursor(null);
    setCurrentSourceLine(1);
    try {
      const library = await typesetListDocuments();
      if (documentEpochRef.current !== documentEpoch) return;
      const documents = library.documents;
      const sortedMatches = sortedSources(documents.map((document) => document.path));
      setStartDocuments(documents);
      setStartProjects(library.projects);
      setTreeRefreshKey((key) => key + 1);
      if (isTypesetPreviewMode() && !previewAutoOpenedRef.current) {
        previewAutoOpenedRef.current = true;
        const previewSource = preferredSource(sortedMatches);
        if (previewSource) {
          const file = await fileReadText(previewSource);
          if (documentEpochRef.current !== documentEpoch) return;
          setSourcePath(file.path);
          setDocumentRootPath(file.path);
          setDocumentSources({ [file.path]: file.content });
          const outputPath = outputPathFor(file.path);
          setPreviewPath(outputPath);
          setLastPdfPreviewPath(outputPath);
          setLoaded(file);
          resetDraft(file.content);
          setVisualPdfCursor(null);
          setCurrentSourceLine(1);
          setSyncTexOutdated(false);
        }
      }
    } catch (scanError) {
      if (documentEpochRef.current === documentEpoch) {
        setStartDocuments([]);
        setStartProjects([]);
        setError(String(scanError));
      }
    } finally {
      if (documentEpochRef.current === documentEpoch) setLoading(false);
    }
  }, [invalidateActiveCompile, resetDraft]);

  useEffect(() => {
    void scanProject();
  }, [currentProject?.id, scanProject]);

  // Chat can request a TeX source or a standalone PDF before this lazy-loaded
  // workspace mounts. Consume that request once the project scan has started;
  // PDFs keep the source empty and render directly in the right-hand preview.
  useEffect(() => {
    if (!pendingTypesetFilePath) return;
    openPath(pendingTypesetFilePath);
    setPendingTypesetFilePath(null);
  }, [openPath, pendingTypesetFilePath, setPendingTypesetFilePath]);

  useEffect(() => {
    const lineCount = Math.max(1, draft.split("\n").length);
    setCurrentSourceLine((line) => clampNumber(line, 1, lineCount));
  }, [draft]);

  const performSave = useCallback(async (): Promise<FileText | null> => {
    const savePath = sourcePathRef.current;
    const baseFile = loadedRef.current;
    if (!savePath || !baseFile) return null;
    const documentEpoch = documentEpochRef.current;
    const latestDraft = draftRef.current;
    setSaving(true);
    setError(null);
    try {
      if (latestDraft === baseFile.content) {
        // Legacy/browser fixtures without a version cannot be validated. The
        // desktop backend always supplies a SHA-256 version.
        if (!baseFile.version) return baseFile;
        const diskFile = await fileReadText(savePath);
        if (documentEpochRef.current !== documentEpoch || sourcePathRef.current !== savePath) return diskFile;
        if (diskFile.version === baseFile.version && diskFile.content === baseFile.content) return baseFile;
        if (draftRef.current === baseFile.content) {
          loadedRef.current = diskFile;
          setLoaded(diskFile);
          resetDraft(diskFile.content);
          setSyncTexOutdated(true);
          setSourcePath(diskFile.path);
          setError(copy.fileChangedOutside(basename(savePath)));
          return diskFile;
        }
      }

      const contentToWrite = draftRef.current;
      const file = baseFile.version
        ? await fileWriteText(savePath, contentToWrite, baseFile.version)
        : await fileWriteText(savePath, contentToWrite);
      if (documentEpochRef.current !== documentEpoch || sourcePathRef.current !== savePath) return file;
      loadedRef.current = file;
      setLoaded(file);
      if (draftRef.current === contentToWrite) resetDraft(file.content);
      setSourcePath(file.path);
      return file;
    } catch (saveError) {
      if (documentEpochRef.current === documentEpoch && sourcePathRef.current === savePath) {
        setError(
          String(saveError).includes("FILE_CONFLICT")
            ? copy.fileSaveConflict(basename(savePath))
            : String(saveError),
        );
      }
      return null;
    } finally {
      if (documentEpochRef.current === documentEpoch) setSaving(false);
    }
  }, [resetDraft]);

  const save = useCallback(async function saveLatest(): Promise<FileText | null> {
    const pending = saveInFlightRef.current;
    if (pending) {
      await pending;
      const currentFile = loadedRef.current;
      if (currentFile && sourcePathRef.current && draftRef.current !== currentFile.content) {
        return saveLatest();
      }
      return currentFile;
    }
    const task = performSave();
    saveInFlightRef.current = task;
    try {
      return await task;
    } finally {
      if (saveInFlightRef.current === task) saveInFlightRef.current = null;
    }
  }, [performSave]);

  const compile = async (cleanCache = false) => {
    if (!sourcePath || saving || activeCompileRunIdRef.current) return;
    const openPath = sourcePath;
    const runId = `typeset-${Date.now()}-${++compileSequenceRef.current}`;
    const compileEpoch = ++compileEpochRef.current;
    if (compileProgressTimerRef.current !== null) window.clearTimeout(compileProgressTimerRef.current);
    compileProgressTimerRef.current = null;
    pendingCompileProgressRef.current = null;
    activeCompileRunIdRef.current = runId;
    const ownsCompile = () => (
      compileEpochRef.current === compileEpoch
      && activeCompileRunIdRef.current === runId
      && sourcePathRef.current === openPath
    );
    const flushCompileProgress = () => {
      if (compileProgressTimerRef.current !== null) {
        window.clearTimeout(compileProgressTimerRef.current);
        compileProgressTimerRef.current = null;
      }
      const progress = pendingCompileProgressRef.current;
      pendingCompileProgressRef.current = null;
      if (progress?.runId === runId && ownsCompile()) {
        setCompileLiveLog({ stdout: progress.stdout, stderr: progress.stderr, elapsedMs: progress.elapsedMs });
      }
    };
    const queueCompileProgress = (progress: CompileLiveLog & { runId: string }) => {
      pendingCompileProgressRef.current = progress;
      if (compileProgressTimerRef.current === null) {
        compileProgressTimerRef.current = window.setTimeout(flushCompileProgress, COMPILE_PROGRESS_UPDATE_MS);
      }
    };
    setCompileStatus("running");
    setSyncTexOutdated(true);
    setActiveCompileRunId(runId);
    setCompileResult(null);
    setCompileLiveLog({ stdout: "", stderr: "", elapsedMs: 0 });
    setError(null);
    // Don't jump to the log while compiling — the PDF toolbar already shows a
    // "Compiling" status. The log only opens itself when a build actually fails
    // (below); a user watching it can still open it manually.
    await nextAnimationFrame();
    if (!ownsCompile()) return;
    const saved = await save();
    if (!ownsCompile()) return;
    if (!saved) {
      setCompileStatus("idle");
      setCompileLiveLog(null);
      activeCompileRunIdRef.current = null;
      setActiveCompileRunId(null);
      return;
    }
    // A chosen main document wins over whatever file happens to be open: in a
    // thesis every chapter is a fragment, and TeX has to be pointed at the root.
    // Detection (`% !TeX root`, `\input` scanning) still covers projects that
    // never set one.
    const openedPath = saved.path || openPath;
    const compilePath = mainDocumentPath?.trim() ? mainDocumentPath : openedPath;
    // Freeze what TeX is about to read. `save()` has just flushed the open file,
    // and the rest of the graph is whatever was last loaded from disk — the same
    // bytes the compiler will see, and the baseline every later SyncTeX result
    // is numbered against. Only committed once the run actually yields a PDF:
    // after a failed build the PDF (and its SyncTeX data) still describe the
    // previous snapshot, so replacing it here would remap against the wrong file.
    const compiledSnapshot = { ...documentSourcesRef.current, [openedPath]: saved.content };
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onLatexCompileProgress((progress) => {
        if (progress.runId === runId && ownsCompile()) {
          queueCompileProgress({ runId, stdout: progress.stdout, stderr: progress.stderr, elapsedMs: progress.elapsedMs });
        }
      });
      if (!ownsCompile()) return;
      const outputPath = outputPathFor(compilePath);
      const result = await latexCompile(
        compilePath,
        outputPath,
        cleanCache,
        runId,
        compileErrorHandling === "continue",
        latexEngine === "auto" ? null : latexEngine,
      );
      if (!ownsCompile()) return;
      setCompileResult(result);
      setDocumentRootPath(result.inputPath || compilePath);
      const interrupted = result.interrupted;
      setCompileStatus(interrupted ? "idle" : result.success ? "success" : result.partialOutput ? "partial" : "error");
      // Reveal the log only when the build reported problems; a clean success
      // returns focus to the freshly rendered PDF.
      setLogOpen(!interrupted && !result.success);
      const pdfState = result.pdfState ?? (result.success ? "fresh" : result.partialOutput ? "partial" : "missing");
      setSyncTexOutdated(!(result.success && pdfState === "fresh"));
      // "stale" means the project changed under the compiler, so the SyncTeX
      // data does not describe this snapshot either.
      if (pdfState === "fresh" || pdfState === "partial") compiledSourcesRef.current = compiledSnapshot;
      if (pdfState === "fresh" || pdfState === "partial" || pdfState === "stale") {
        setPreviewPath(result.outputPath || outputPath);
        setLastPdfPreviewPath(result.outputPath || outputPath);
        setRefreshKey((key) => key + 1);
      }
      setTreeRefreshKey((key) => key + 1);
    } catch (compileError) {
      if (ownsCompile()) {
        setCompileStatus("error");
        setError(String(compileError));
        setLogOpen(true);
      }
    } finally {
      flushCompileProgress();
      unlisten?.();
      if (ownsCompile()) {
        activeCompileRunIdRef.current = null;
        setActiveCompileRunId(null);
      }
    }
  };

  const cancelCompile = useCallback(() => {
    const runId = activeCompileRunIdRef.current;
    if (!runId) return;
    void latexCompileCancel(runId).catch((cancelError) => {
      setError(String(cancelError));
    });
  }, []);
  compileRef.current = () => {
    void compile();
  };

  /**
   * Write, then rebuild. Compiling *through* the save rather than instead of it
   * keeps `save()`'s serialisation — a second Ctrl+S while the first write is
   * still in flight still queues the newer draft — and the compile's own
   * `save()` is a no-op by the time it runs.
   */
  const saveThenCompile = useCallback(async () => {
    const saved = await save();
    if (saved && compileOnSaveRef.current) compileRef.current();
  }, [save]);

  const saveCurrentEditor = useCallback(() => {
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    // The explicit Save action in the compiled Beamer canvas refreshes its PDF
    // preview.
    if (editorMode === "visual" && beamerSlides.length > 0) {
      if (saving) return;
      compileRef.current();
      return;
    }
    void saveThenCompile();
  }, [beamerSlides.length, editorMode, loaded, saveThenCompile, saving]);

  /**
   * Ctrl+S. Compiling here — rather than a few seconds after every keystroke,
   * the way Overleaf does against its own build farm — keeps the PDF from
   * reflowing under the reader while they type, and still means the preview is
   * never stale after a deliberate save.
   */
  const saveShortcut = useCallback(() => {
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    void saveThenCompile();
  }, [loaded, saveThenCompile]);

  // CodeEditor captures `extraKeymap` once at mount, so route through refs kept
  // fresh every render rather than closing over these (non-memoized, in `compile`'s
  // case) callbacks directly.
  const saveRef = useRef(saveShortcut);
  saveRef.current = saveShortcut;
  compileOnSaveRef.current = compileOnSave;
  const codeEditorKeymapRef = useRef<KeyBinding[]>([
    { key: "Mod-s", run: () => { void saveRef.current(); return true; } },
    // `compileRef` (defined above, near `compile`) is already a stable wrapper.
    { key: "Mod-Enter", run: () => { compileRef.current(); return true; } },
  ]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      const shortcut = event.ctrlKey || event.metaKey;
      if (!shortcut || event.key.toLowerCase() !== "s") return;
      if (!sourcePath || !loaded) return;
      event.preventDefault();
      saveShortcut();
    };
    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, [loaded, saveShortcut, sourcePath]);

  const openCodeAtLine = useCallback((line: number) => {
    const offset = lineOffsetFor(draft, line);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.setTimeout(() => {
      const editor = editorRef.current;
      editor?.focus();
      editor?.dispatch({ selection: { anchor: offset, head: offset } });
      if (editor) scrollCodeEditorToLine(editor.view, line);
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    }, 0);
  }, [draft]);

  const navigateToLine = useCallback((line: number, column = 0) => {
    const offset = lineOffsetFor(draft, line) + Math.max(0, column);
    setCurrentSourceLine(line);
    window.setTimeout(() => {
      const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
      if (!view) return;
      const safeOffset = clampNumber(offset, 0, view.state.doc.length);
      view.focus();
      view.dispatch({
        selection: { anchor: safeOffset, head: safeOffset },
        effects: EditorView.scrollIntoView(safeOffset, { y: "center" }),
      });
      if (editorMode === "code") scrollCodeEditorToLine(view, line);
    }, 0);
  }, [draft, editorMode]);

  const openDiagnostic = useCallback((diagnostic: LatexDiagnostic) => {
    const line = diagnostic.line ?? 1;
    const reportedPath = diagnostic.filePath?.trim();
    if (!reportedPath || !sourcePath) {
      navigateToLine(line);
      return;
    }
    const compileRootPath = compileResult?.inputPath || sourcePath;
    const normalizedReportedPath = normalizePath(reportedPath).replace(/^\.\//, "");
    const normalizedSourcePath = normalizePath(sourcePath);
    if (normalizedReportedPath === normalizedSourcePath) {
      navigateToLine(line);
      return;
    }
    const targetPath = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(reportedPath)
      ? reportedPath
      : `${dirname(compileRootPath)}/${normalizedReportedPath}`.replace(/\\/g, "/");
    if (normalizePath(targetPath) === normalizedSourcePath) {
      navigateToLine(line);
      return;
    }
    void openSource(targetPath, line, true);
  }, [compileResult?.inputPath, navigateToLine, openSource, sourcePath]);

  const openCodeRange = useCallback((start: number, end: number) => {
    const source = draftRef.current;
    const safeStart = clampNumber(start, 0, source.length);
    const safeEnd = clampNumber(end, safeStart, source.length);
    const line = lineNumberForOffset(source, safeStart);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const editorStart = clampNumber(safeStart, 0, editor.view.state.doc.length);
      const editorEnd = clampNumber(safeEnd, editorStart, editor.view.state.doc.length);
      editor.focus();
      editor.dispatch({
        selection: { anchor: editorStart, head: editorEnd },
        effects: EditorView.scrollIntoView(editorStart, { y: "center" }),
      });
      window.requestAnimationFrame(() => scrollCodeEditorToLine(editor.view, line));
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    });
  }, []);

  useEffect(() => {
    if (!pendingSourceNavigation || loading || !sameWorkspacePath(pendingSourceNavigation.path, sourcePath)) return;
    const navigation = pendingSourceNavigation;
    setPendingSourceNavigation(null);
    // A SyncTeX hit arrives numbered against the source that was compiled, and
    // with no column at all. Both are resolved here rather than at the call
    // site, because this is the first point at which `draft` is guaranteed to
    // be the target file — a hit in an \input'd chapter has to wait for that
    // file to load before its line numbers mean anything.
    const compiled = navigation.fromSyncTex
      ? compiledSourceFor(compiledSourcesRef.current, navigation.path)
      : undefined;
    const remapped = compiled !== undefined && compiled !== draft;
    const line = remapped ? remapCompiledLine(compiled, draft, navigation.line) : navigation.line;
    const lineStart = lineOffsetFor(draft, line);
    const lineBreak = draft.indexOf("\n", lineStart);
    const lineText = draft.slice(lineStart, lineBreak < 0 ? draft.length : lineBreak);
    const refined = navigation.word
      ? refineSourceColumn(lineText, navigation.word, wordRatioIn(navigation.pdfText ?? "", navigation.word))
      : null;
    if (navigation.fromSyncTex) setForwardSearchNotice(remapped ? copy.syncTexRemappedAfterEdit : null);

    const column = refined?.column ?? navigation.column;
    const start = navigation.start ?? lineStart + Math.max(0, column ?? 0);
    const end = navigation.end ?? (refined ? start + refined.length : start);
    const hasExactOffset = navigation.start != null || column != null;
    const cursor = {
      line,
      start: clampNumber(start, 0, draft.length),
      end: clampNumber(end, clampNumber(start, 0, draft.length), draft.length),
      text: draft.slice(start, end),
    };
    setVisualPdfCursor(cursor);
    if (navigation.forceCode || editorModeRef.current === "code") {
      if (end > start || hasExactOffset) openCodeRange(start, end);
      else openCodeAtLine(line);
    } else {
      navigateToLine(line, column ?? 0);
    }
  }, [draft, loading, navigateToLine, openCodeAtLine, openCodeRange, pendingSourceNavigation, sourcePath]);

  const navigateToPdfTextFallback = useCallback((text: string, context = text, forceCode = false): boolean => {
    // Guessing from text needs enough text to identify a place. A CJK PDF gives
    // one text item per glyph — each font subset holds a handful of characters —
    // so an unguarded search for a single character lands on its first
    // occurrence in the file, which is worse than not moving at all.
    if (!pdfTextCarriesEnoughSignal(text)) return false;
    const currentSource = editorModeRef.current === "code"
      ? editorRef.current?.view.state.doc.toString() || draftRef.current
      : draftRef.current;
    const candidates: Array<[string, string]> = sourcePathRef.current
      ? [[sourcePathRef.current, currentSource]]
      : [];
    for (const [path, source] of Object.entries(documentSourcesRef.current)) {
      if (!candidates.some(([candidate]) => sameWorkspacePath(candidate, path))) candidates.push([path, source]);
    }
    const located = candidates
      .map(([path, source]) => ({ path, source, match: findLatexOffsetForPdfText(source, text, context) }))
      .find((candidate) => candidate.match != null);
    if (!located?.match) return false;
    const { path, source, match } = located;
    const cursor = {
      line: lineNumberForOffset(source, match.start),
      start: match.start,
      end: match.end,
      text: normalizePdfText(text),
    };
    setVisualPdfCursor(cursor);
    setCurrentSourceLine(cursor.line);
    if (!sameWorkspacePath(path, sourcePathRef.current)) {
      void openSource(path, cursor.line, true).then((opened) => {
        if (opened) setPendingSourceNavigation({ path, line: cursor.line, start: match.start, end: match.end, forceCode });
      });
      return true;
    }
    if (editorModeRef.current === "visual" && !forceCode) {
      setEditorMode("visual");
      navigateToLine(cursor.line);
      return true;
    }
    openCodeRange(match.start, match.end);
    return true;
  }, [navigateToLine, openCodeRange, openSource]);

  const openSourceForPdfText = useCallback((text: string, context = text, forceCode = false) => {
    navigateToPdfTextFallback(text, context, forceCode);
  }, [navigateToPdfTextFallback]);

  // Forward search: double-click in Code or Visual jumps the PDF preview to
  // the exact compiled position, via the real SyncTeX data latexmk/xelatex
  // now emit (-synctex=1). Reports back through `forwardSearchNotice` instead
  // of failing silently — a stale (pre-synctex) PDF, a missing `synctex`
  // binary, or a line with no typeset material (blank lines, comments) are
  // all real, visible-to-the-user reasons the jump didn't happen.
  const jumpToPdfForSource = useCallback((targetSourcePath: string | null, line: number, column: number) => {
    if (!targetSourcePath || !previewPath || extension(previewPath) !== ".pdf") {
      setForwardSearchNotice(copy.compileBeforeJumping);
      return;
    }
    // The mirror of inverse search: here the *line* is current and the PDF is
    // old, so the line has to be translated back into the numbering the build
    // recorded before asking SyncTeX about it. Without a snapshot to translate
    // through there is nothing to correct with, so keep the old refusal rather
    // than jumping somewhere plausible-looking and wrong.
    const currentSource = sameWorkspacePath(targetSourcePath, sourcePathRef.current)
      ? draftRef.current
      : compiledSourceFor(documentSourcesRef.current, targetSourcePath);
    const compiled = compiledSourceFor(compiledSourcesRef.current, targetSourcePath);
    if (syncTexMappingStale && (compiled === undefined || currentSource === undefined)) {
      setForwardSearchNotice(copy.syncTexNeedsRecompile);
      return;
    }
    const remapped = compiled !== undefined && currentSource !== undefined && compiled !== currentSource;
    const compiledLine = remapped ? remapCompiledLine(currentSource, compiled, line) : line;
    const requestEpoch = ++forwardSearchEpochRef.current;
    void latexForwardSearch(targetSourcePath, previewPath, compiledLine, column)
      .then((result) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        const location = result.locations[0];
        if (location) {
          setPdfForwardTarget({ location, nonce: Date.now() });
          setForwardSearchNotice(remapped ? copy.syncTexRemappedAfterEdit : null);
        } else {
          setForwardSearchNotice(result.stderr.trim() || copy.noPdfMatchForLine);
        }
      })
      .catch((forwardError) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        setForwardSearchNotice(String(forwardError));
      });
  }, [previewPath, syncTexMappingStale]);

  const jumpToPdfForLine = useCallback((line: number, column: number) => {
    jumpToPdfForSource(sourcePath, line, column);
  }, [jumpToPdfForSource, sourcePath]);

  /**
   * Inverse search: a click in the compiled PDF opens the source behind it.
   *
   * Unlike forward search this does *not* refuse to run once the buffer is
   * dirty. SyncTeX still knows exactly which source line produced the point —
   * it just numbers it against the snapshot that was compiled — so the answer
   * is remapped through the edits made since (`remapCompiledLine`) instead of
   * being thrown away for a whole-file text search, which lands on whichever
   * paragraph happens to repeat the clicked word first.
   *
   * `word` then buys back the column: TeX records `Column:-1` for every result,
   * so an unrefined jump parks the cursor at the start of the line, which for a
   * paragraph written on one source line is nowhere near what was clicked.
   */
  const openSourceForPdfPosition = useCallback((
    page: number,
    x: number,
    y: number,
    text: string,
    context: string,
    word?: string,
  ) => {
    if (!previewPath || extension(previewPath) !== ".pdf") {
      navigateToPdfTextFallback(text, context);
      return;
    }
    const requestEpoch = ++forwardSearchEpochRef.current;
    void latexInverseSearch(previewPath, page, x, y)
      .then((result) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        const location = result.locations[0];
        if (!location) {
          // Falling back to a text search is a guess, so say so even when it
          // lands: an unannounced wrong jump is indistinguishable from a right
          // one, which is how "the jump is inaccurate" hides for weeks.
          const fallbackFound = navigateToPdfTextFallback(text, context);
          const diagnostic = result.stderr.trim();
          setForwardSearchNotice(
            diagnostic
            || (fallbackFound ? copy.pdfPointMatchedByTextOnly : copy.noSourceMatchForPdfPoint),
          );
          return;
        }
        const targetPath = location.sourcePath;
        const navigate = () => {
          setPendingSourceNavigation({
            path: targetPath,
            line: location.line,
            column: location.column ?? 0,
            fromSyncTex: true,
            word,
            pdfText: text,
          });
        };
        if (sameWorkspacePath(targetPath, sourcePathRef.current)) {
          navigate();
          return;
        }
        void openSource(targetPath, location.line, true).then((opened) => {
          if (opened) navigate();
        });
      })
      .catch((inverseError) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        navigateToPdfTextFallback(text, context);
        // A PDF built outside Typeset (by a skill, or a terminal `latexmk`
        // without -synctex=1) has no SyncTeX file at all, and `synctex` says so
        // in its own words. That is a one-recompile fix, not an error.
        const message = String(inverseError);
        setForwardSearchNotice(
          /no synctex available/i.test(message) ? copy.pdfHasNoSyncTexData : message,
        );
      });
  }, [navigateToPdfTextFallback, openSource, previewPath]);

  const jumpFromOutline = useCallback((line: number, file: string | null) => {
    // An outline item represents a source heading. Open the exact source line
    // and use SyncTeX to bring the compiled PDF to the corresponding output.
    setPdfPanelVisible(true);
    setLogOpen(false);
    // A heading that came in through \input lives in another file: open that
    // file at the heading instead of scrolling the current one to a line that
    // means nothing here.
    if (file && !sameWorkspacePath(file, sourcePathRef.current)) {
      void openSource(file, line, true).then((opened) => {
        if (opened) jumpToPdfForSource(file, line, 1);
      });
      return;
    }
    navigateToLine(line);
    jumpToPdfForLine(line, 1);
  }, [jumpToPdfForLine, jumpToPdfForSource, navigateToLine, openSource]);

  useEffect(() => {
    if (!pdfForwardTarget) return;
    const timeout = window.setTimeout(() => setPdfForwardTarget(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [pdfForwardTarget]);

  useEffect(() => {
    if (!forwardSearchNotice) return;
    const timeout = window.setTimeout(() => setForwardSearchNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [forwardSearchNotice]);

  const returnToStart = useCallback(() => {
    if (dirty && !window.confirm(copy.discardReturnToList)) {
      return;
    }
    void scanProject();
  }, [dirty, scanProject]);

  useEffect(() => {
    if (editorMode !== "code") return;
    const view = editorRef.current?.view;
    if (!view) return;
    const scrollTarget = view.scrollDOM;
    let frame = 0;
    const updateLine = (preferSelection = false) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (preferSelection && view.hasFocus) {
          setCurrentSourceLine(view.state.doc.lineAt(view.state.selection.main.head).number);
          return;
        }
        setCurrentSourceLine(codeVisibleLineForView(view));
      });
    };
    const updateFromScroll = () => updateLine(false);
    const updateFromSelection = () => updateLine(true);
    scrollTarget.addEventListener("scroll", updateFromScroll, { passive: true });
    view.contentDOM.addEventListener("click", updateFromSelection);
    view.contentDOM.addEventListener("keyup", updateFromSelection);
    document.addEventListener("selectionchange", updateFromSelection);
    updateLine(true);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", updateFromScroll);
      view.contentDOM.removeEventListener("click", updateFromSelection);
      view.contentDOM.removeEventListener("keyup", updateFromSelection);
      document.removeEventListener("selectionchange", updateFromSelection);
    };
  }, [draft, editorMode]);

  const hasWorkspaceDocument = Boolean(sourcePath || loaded || previewPath);
  const gridClassName = [
    "typeset-main-grid ide-redesign-body",
    !hasWorkspaceDocument ? "start-mode" : "",
    !effectiveProjectPanelVisible ? "project-hidden" : "",
    !effectivePdfPanelVisible ? "pdf-hidden" : "",
    slideFocusActive ? "slide-focus-mode" : "",
  ].filter(Boolean).join(" ");
  const gridStyle = {
    "--typeset-left-user-w": `${projectPanelWidth}px`,
    "--typeset-preview-user-w": `${pdfPanelWidth}px`,
  } as CSSProperties;

  return (
    <div className={`typeset-workbench ide-redesign-main${browserPreviewMode ? " browser-preview" : ""}`}>
      {browserPreviewMode && (
        <div className="typeset-runtime-banner" role="status">
          <strong>{copy.browserPreview}</strong>
          <span>{copy.sampleDataOnly}</span>
          <em>{copy.desktopModeHint}</em>
        </div>
      )}
      <div
        className={gridClassName}
        style={gridStyle}
      >
        {hasWorkspaceDocument && (
          <nav className="typeset-rail ide-rail" aria-label={copy.typesetSectionsLabel}>
            <div className="ide-rail-tabs-nav">
              <div className="ide-rail-tabs-wrapper">
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectiveProjectPanelVisible ? " open-rail active" : ""}`}
                  title={effectiveProjectPanelVisible ? copy.hideProjectFiles : copy.showProjectFiles}
                  aria-label={effectiveProjectPanelVisible ? copy.hideProjectFiles : copy.showProjectFiles}
                  aria-pressed={effectiveProjectPanelVisible}
                  onClick={() => {
                    if (slideFocusActive) {
                      setSlideFocusMode(false);
                      setProjectPanelVisible(true);
                    } else {
                      setProjectPanelVisible((visible) => !visible);
                    }
                  }}
                >
                  <ToolIcon name="files" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectivePdfPanelVisible ? " open-rail active" : ""}`}
                  title={effectivePdfPanelVisible ? copy.hidePdfPanel : copy.showPdfPanel}
                  aria-label={effectivePdfPanelVisible ? copy.hidePdfPanel : copy.showPdfPanel}
                  aria-pressed={effectivePdfPanelVisible}
                  onClick={() => {
                    if (slideFocusActive) {
                      setSlideFocusMode(false);
                      setPdfPanelVisible(true);
                    } else {
                      setPdfPanelVisible((visible) => !visible);
                    }
                  }}
                >
                  <ToolIcon name="visual" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className="ide-rail-tab-link"
                  disabled={saving || compileStatus === "running"}
                  title={copy.backToSourceList}
                  aria-label={copy.home}
                  onClick={returnToStart}
                >
                  <ToolIcon name="home" className="ide-rail-tab-link-icon" />
                </button>
              </div>
              <nav aria-label={copy.settingsLabel}>
                <button type="button" className="ide-rail-tab-link" title={copy.settingsLabel} aria-label={copy.settingsLabel}>
                  <ToolIcon name="settings" className="ide-rail-tab-link-icon" />
                </button>
              </nav>
            </div>
          </nav>
        )}
        {!hasWorkspaceDocument ? (
          <TypesetStartPage
            projectPath={currentProject?.path ?? null}
            documents={startDocuments}
            projects={startProjects}
            latexAvailable={latexAvailable}
            loading={loading}
            error={error}
            onOpenSource={openPath}
            onCreateSource={createSource}
            onRefresh={() => void scanProject()}
          />
        ) : (
          <>
            {effectiveProjectPanelVisible && (
              <>
                <div className="typeset-left-panel file-tree-outline-panel-group">
                  <TypesetExplorer
                    projectPath={currentProject?.path ?? null}
                    rootPath={activeWorkDir}
                    activeSourcePath={sourcePath}
                    activePreviewPath={previewPath}
                    mainDocumentPath={mainDocumentPath}
                    refreshKey={treeRefreshKey}
                    onOpenPath={openPath}
                    onFileMutation={handleFileMutation}
                    onSetMainDocument={(path) => {
                      setMainDocumentPreference(path);
                      setTreeRefreshKey((key) => key + 1);
                    }}
                  />
                  <TypesetOutlinePanel
                    activeLine={activeOutlineItem?.line ?? null}
                    collapsed={outlineCollapsed}
                    currentPath={sourcePath}
                    outline={numberedOutline}
                    height={outlinePanelHeight}
                    wordCount={documentWordCount}
                    onJumpToLine={jumpFromOutline}
                    onResizeKeyDown={handleOutlineResizeKey}
                    onResizePointerDown={beginOutlineResizeFromPointer}
                    onToggleCollapsed={() => setOutlineCollapsed((collapsed) => !collapsed)}
                  />
                </div>
                <div
                  className="typeset-resize-handle project"
                  data-resize-panel="project"
                  role="separator"
                  aria-label={copy.resizeProjectFiles}
                  aria-orientation="vertical"
                  aria-valuemin={PROJECT_PANEL_MIN_W}
                  aria-valuemax={PROJECT_PANEL_MAX_W}
                  aria-valuenow={projectPanelWidth}
                  title={copy.dragResizeProjectFiles}
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("project", event)}
                  onKeyDown={(event) => handlePanelResizeKey("project", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                </div>
              </>
            )}
            <section className={`typeset-editor-pane ide-redesign-editor-container ${editorMode === "visual" ? "visual-mode" : "code-mode"}`} aria-label={copy.sourceEditorLabel}>
              {loaded && (
                <TypesetEditorToolbar
                  activeOutlineItem={activeOutlineItem}
                  spellCheck={spellCheck}
                  onToggleSpellCheck={toggleSpellCheck}
                  activeSlide={activeBeamerSlide}
                  slides={beamerSlides}
                  path={sourcePath}
                  tabs={openTabs}
                  dirtyTabs={inactiveDirtyPaths}
                  // Tab switches can cross projects; resolve the selected
                  // source so the file-tree root and PDF follow the tab too.
                  onSelectTab={(path) => void openSource(path)}
                  onCloseTab={closeTab}
                  draft={draft}
                  mode={editorMode}
                  canRedo={canRedoDraft}
                  canUndo={canUndoDraft}
                  editorRef={editorRef}
                  visualViewRef={visualViewRef}
                  onChange={changeDraft}
                  onModeChange={changeEditorMode}
                  onNavigateToLine={navigateToLine}
                  onEditSlideSource={openCodeAtLine}
                  onRedo={redoDraft}
                  onSave={saveCurrentEditor}
                  onSearch={openCodeRange}
                  onUndo={undoDraft}
                  linkedPdfLine={visualPdfCursor?.line ?? null}
                  citationPapers={literaturePapers}
                  onPrepareCitationKeys={prepareCitationKeys}
                  onSynchronizeBibliography={synchronizeBibliography}
                  saving={saving}
                  compiling={compileStatus === "running"}
                  dirty={dirty}
                />
              )}
              {error && <div className="typeset-error-bar">{error}</div>}
              {documentGraphTruncated && (
                <div className="typeset-warning-bar" role="status">{copy.documentGraphTruncated(INCLUDE_MAX_FILES)}</div>
              )}
              {loading && !previewPath ? (
                <div className="typeset-empty">{copy.loadingSource}</div>
              ) : loaded ? (
                <>
                  <div
                    className="typeset-editor-body ide-redesign-editor-content"
                    hidden={editorMode !== "code"}
                    aria-hidden={editorMode !== "code"}
                  >
                    <CodeEditor
                      value={draft}
                      language="latex"
                      onChange={changeDraft}
                      extraKeymap={codeEditorKeymapRef.current}
                      onReady={(handle) => {
                        editorRef.current = handle;
                      }}
                      onDoubleClickPos={jumpToPdfForLine}
                      readOnly={saving}
                      wrap
                      dataEditor="typeset-code"
                      placeholder="\\section{Title}"
                      latexVscodeTheme
                    />
                  </div>
                  <div
                    className="typeset-editor-body typeset-visual-editor-host"
                    hidden={editorMode !== "visual"}
                    aria-hidden={editorMode !== "visual"}
                  >
                    {beamerSlides.length > 0 ? (
                      <TypesetCompiledVisual
                        path={previewPath}
                        refreshKey={refreshKey}
                        page={activeBeamerPage}
                        slide={activeBeamerSlide}
                        slides={beamerSlides}
                        source={draft}
                        dirty={dirty}
                        compiling={compileStatus === "running"}
                        onChangeSource={changeDraft}
                        onSave={saveCurrentEditor}
                        onNavigateToLine={navigateToLine}
                        onOpenCodeAtLine={openCodeAtLine}
                        onOpenCodeRange={openCodeRange}
                        onSourceTextClick={openSourceForPdfText}
                        focused={slideFocusActive}
                        onToggleFocus={() => setSlideFocusMode((focused) => !focused)}
                      />
                    ) : (
                      <TypesetVisualEditor
                        path={sourcePath}
                        draft={draft}
                        pdfCursor={visualPdfCursor}
                        onChange={changeDraft}
                        onVisibleLineChange={setCurrentSourceLine}
                        onOpenCodeRange={openCodeRange}
                        onForwardSearch={jumpToPdfForLine}
                        onViewReady={onVisualViewReady}
                        spellCheck={spellCheck}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="typeset-empty">
                  {previewPath ? copy.pdfOpenInSidePanel : copy.createOrOpenTex}
                </div>
              )}
            </section>
            {effectivePdfPanelVisible && (
              <>
                <div
                  className="typeset-resize-handle pdf"
                  data-resize-panel="pdf"
                  role="separator"
                  aria-label={copy.resizePdfPreview}
                  aria-orientation="vertical"
                  aria-valuemin={PDF_PANEL_MIN_W}
                  aria-valuemax={PDF_PANEL_MAX_W}
                  aria-valuenow={pdfPanelWidth}
                  title={copy.dragResizePdfPreview}
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("pdf", event)}
                  onKeyDown={(event) => handlePanelResizeKey("pdf", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                </div>
                <div className="typeset-preview-stack ide-redesign-pdf-container">
                  {isTypesetImagePath(previewPath) ? (
                    <TypesetImagePreview
                      path={previewPath}
                      refreshKey={refreshKey}
                      onBackToPdf={lastPdfPreviewPath ? () => setPreviewPath(lastPdfPreviewPath) : undefined}
                      onHide={() => setPdfPanelVisible(false)}
                    />
                  ) : (
                    <TypesetPdfPreview
                      path={previewPath}
                      sourcePath={sourcePath}
                      refreshKey={refreshKey}
                      status={compileStatus}
                      result={compileResult}
                      dirty={dirty}
                      disabled={!sourcePath || saving || loading}
                      logOpen={logOpen}
                      diagnosticsCount={diagnosticsCount}
                      continueOnError={compileErrorHandling === "continue"}
                      canCancel={Boolean(activeCompileRunId)}
                      onCompile={() => void compile()}
                      onCancelCompile={cancelCompile}
                      onClearCacheCompile={() => void compile(true)}
                      onSetContinueOnError={(value) => setCompileErrorHandlingPreference(value ? "continue" : "stop")}
                      engine={latexEngine}
                      compileOnSave={compileOnSave}
                      inverted={pdfInverted}
                      onSetEngine={setLatexEnginePreference}
                      onSetCompileOnSave={setCompileOnSavePreference}
                      onToggleInverted={togglePdfInverted}
                      onExportPdf={() => void exportPreviewPdf()}
                      onSyncToPdf={() => jumpToPdfForLine(currentSourceLine, 1)}
                      onToggleLog={() => setLogOpen((open) => !open)}
                      onSourceTextClick={(text, context, position) => {
                        if (position) {
                          openSourceForPdfPosition(position.page, position.x, position.y, text, context, position.word);
                        } else {
                          openSourceForPdfText(text, context);
                        }
                      }}
                      onHide={() => setPdfPanelVisible(false)}
                      forwardTarget={pdfForwardTarget}
                      forwardSearchNotice={forwardSearchNotice}
                    />
                  )}
                  {logOpen && !isTypesetImagePath(previewPath) && (
                    <CompileLog
                      result={compileResult}
                      status={compileStatus}
                      error={error}
                      liveLog={compileLiveLog}
                      disabled={!sourcePath || saving || loading}
                      onClearCacheCompile={() => void compile(true)}
                      onDiagnosticClick={openDiagnostic}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

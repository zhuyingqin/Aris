import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { memo } from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import "katex/dist/katex.min.css";


import {
  fileCreateText,
  fileDelete,
  fileDuplicate,
  fileListDir,
  fileOpen,
  fileReadBytes,
  fileReadText,
  fileRename,
  fileReveal,
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
  type FileTreeEntry,
  type LatexCompileResult,
  type LatexDiagnostic,
  type SyncTexLocation,
  type TypesetDocument,
  typesetListDocuments,
} from "../api/tauri";
import { isTypesetPreviewMode } from "../api/labPreview";
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
  balancedBraceArg,
  INCLUDE_MAX_FILES,
  type BeamerSlide,
  type NumberedOutlineItem,
} from "./outlineModel";
import { ToolIcon } from "./ToolIcon";
import {
  TypesetOutlinePanel,
  OUTLINE_PANEL_DEFAULT_H,
  OUTLINE_PANEL_MAX_H,
  OUTLINE_PANEL_MIN_H,
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
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { openPdfDocument } from "../pdf/runtime";
import CodeEditor from "../lab/CodeEditor";
import { handoffEnvironmentInstall } from "../environmentInstall";
import { TypesetVisualEditor } from "./TypesetVisualEditor";
import {
  documentCompileLabel,
  documentKindLabel,
  documentRelativeTime,
  TYPESET_LIBRARY_COPY,
  TYPESET_LIBRARY_TEMPLATES,
  type TypesetLibraryScope,
  type TypesetTemplate,
} from "./TypesetLibraryCopy";
import { TYPESET_EDITOR_COPY } from "./i18n";
import {
  pdfTextRunBox,
  refineSourceColumn,
  remapCompiledLine,
  runTextRatio,
  syncTexPointFromPageOffset,
  wordAtRatio,
  wordRatioIn,
  type PdfTextItemLike,
  type PdfTextStyleLike,
  type SyncTexViewportLike,
} from "./syncTexMapping";
import type { VisualPdfCursor } from "./visualModel";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { clearLatexProjectSymbols, setLatexProjectSymbols, type LatexSymbol } from "../editor/latexComplete";
import { bibEntryDetail, bibliographyTargets, parseBibEntries } from "../editor/latexBib";
import { setLatexCompileMarkers, type LatexCompileMarker } from "../editor/latexLint";
import { useStore, type Language } from "../store";
import { suggestedCitationKey, useLiteratureStore } from "../literature/literatureStore";
import type { LiteraturePaper } from "../literature/literatureTypes";
import { SvgIcon } from "../SvgIcon";
import "./Typeset.css";

const DEFAULT_SOURCE_PATH = ".somniq/papers/main.tex";
const DEFAULT_LATEX_DOCUMENT = `\\documentclass{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{SomniQ LaTeX Draft}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

This document is ready for TeX Live compilation inside SomniQ Studio.

\\section{Notes}

Edit the source and compile to refresh the PDF preview.

\\end{document}
`;

type CompileStatus = "idle" | "running" | "success" | "partial" | "error";
type CompileResult = LatexCompileResult;
type CompileLiveLog = { stdout: string; stderr: string; elapsedMs: number };
type CompileErrorHandling = "stop" | "continue";
type CompileLogFilter = "all" | "error" | "warning" | "info";
type CompileLogLevel = Exclude<CompileLogFilter, "all">;
type EditorMode = "code" | "visual";
// `nonce` forces PdfPage's highlight-flash animation to restart even when the
// user double-clicks the exact same source position twice in a row.
type PdfForwardTarget = { location: SyncTexLocation; nonce: number };
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
type TypesetResizePanel = "project" | "pdf";
type TypesetResizeAxis = "x" | "y";
type TypesetLibraryPreferences = Record<string, { favorite?: boolean; archived?: boolean }>;

const COMPILE_ERROR_HANDLING_STORAGE_PREFIX = "somniq-typeset-compile-error-handling:";
const TYPESET_IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
// What `\includegraphics{`, `\input{` and `\bibliography{` can point at. The
// backend glob caps each pattern at 50 hits, so they are split by extension
// rather than asking for everything at once.
const COMPLETABLE_FILE_PATTERNS = [
  "**/*.tex", "**/*.bib", "**/*.pdf", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.eps", "**/*.svg",
];

const SPELL_CHECK_STORAGE_KEY = "somniq-typeset-spellcheck";

function loadSpellCheckPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SPELL_CHECK_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function compileErrorHandlingStorageKey(projectId?: string): string {
  return `${COMPILE_ERROR_HANDLING_STORAGE_PREFIX}${projectId ?? "default"}`;
}

function loadCompileErrorHandling(projectId?: string): CompileErrorHandling {
  if (typeof window === "undefined") return "stop";
  try {
    return window.localStorage.getItem(compileErrorHandlingStorageKey(projectId)) === "continue"
      ? "continue"
      : "stop";
  } catch {
    return "stop";
  }
}

const PROJECT_PANEL_DEFAULT_W = 204;
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 360;
const PDF_PANEL_DEFAULT_W = 760;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;
const PDF_ZOOM_MIN = 0.25;
const PDF_ZOOM_MAX = 4;
const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;
const PDF_WHEEL_ZOOM_SETTLE_MS = 80;
const TYPESET_LIBRARY_PREFERENCES_STORAGE_PREFIX = "somniq-typeset-library:";

type PdfTextObjectGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
};

type PdfTextObjectChange = PdfTextObjectGeometry & {
  text: string;
  context: string;
};

type TextSearchMatch = {
  start: number;
  end: number;
};



function outputPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.tex$/i, ".pdf");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resizeAxisForTarget(target: HTMLElement): TypesetResizeAxis {
  const rect = target.getBoundingClientRect();
  return rect.width > rect.height ? "y" : "x";
}

function coordinateForAxis(axis: TypesetResizeAxis, event: { clientX: number; clientY: number }): number {
  return axis === "y" ? event.clientY : event.clientX;
}

function isTypesetImagePath(path: string | null | undefined): path is string {
  return Boolean(path && TYPESET_IMAGE_EXTENSIONS.has(extension(path)));
}

function normalizeNewTypesetPath(path: string): string {
  const trimmed = normalizePath(path.trim());
  if (!trimmed) return DEFAULT_SOURCE_PATH;
  return /\.tex$/i.test(trimmed) ? trimmed : `${trimmed}.tex`;
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(text: string): string {
  return normalizePdfText(text).toLowerCase();
}

function searchTerms(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const words = normalized.split(/[^\p{L}\p{N}\\]+/u).filter((part) => part.length >= 2);
  if (words.length > 0) return Array.from(new Set(words));
  const compact = normalized.replace(/\s+/g, "");
  if (compact.length <= 3) return compact ? [compact] : [];
  const terms: string[] = [];
  for (let index = 0; index <= compact.length - 3; index += 3) {
    terms.push(compact.slice(index, index + 3));
  }
  return Array.from(new Set(terms));
}

function latexLineToSearchableText(line: string): string {
  let text = latexLineWithoutComment(line);
  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(/\\[a-zA-Z*]+(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/\\[a-zA-Z*]+/g, " ")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[{}$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findLatexOffsetForPdfText(source: string, pdfText: string, contextText = ""): TextSearchMatch | null {
  const target = normalizePdfText(pdfText);
  if (!target) return null;

  const lowerTarget = target.toLowerCase();
  const lowerContext = normalizeSearchText(contextText);
  const targetInContext = lowerContext.indexOf(lowerTarget);
  const beforeTerms = searchTerms(targetInContext >= 0 ? lowerContext.slice(0, targetInContext) : contextText).filter((term) => term !== lowerTarget);
  const afterTerms = searchTerms(targetInContext >= 0 ? lowerContext.slice(targetInContext + lowerTarget.length) : "").filter((term) => term !== lowerTarget);
  const lines = source.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let best: (TextSearchMatch & { score: number }) | undefined;
  lines.forEach((line, lineIndex) => {
    const lineStart = lineStarts[lineIndex];
    const rawLine = normalizeSearchText(line);
    const plainLine = normalizeSearchText(latexLineToSearchableText(line));
    const lineMatchesTarget =
      rawLine.includes(lowerTarget) ||
      plainLine.includes(lowerTarget) ||
      (lowerTarget.length >= 4 && (lowerTarget.includes(plainLine) || plainLine.includes(lowerTarget.slice(0, Math.min(8, lowerTarget.length)))));
    if (!lineMatchesTarget) return;

    const beforeWindow = normalizeSearchText(lines.slice(Math.max(0, lineIndex - 2), lineIndex + 1).map(latexLineToSearchableText).join(" "));
    const afterWindow = normalizeSearchText(lines.slice(lineIndex, lineIndex + 3).map(latexLineToSearchableText).join(" "));
    const contextScore =
      beforeTerms.reduce((score, term) => score + (beforeWindow.includes(term) ? 20 : 0), 0) +
      afterTerms.reduce((score, term) => score + (afterWindow.includes(term) ? 20 : 0), 0);
    let score = contextScore + target.length;
    if (rawLine.includes(lowerTarget)) score += 40;
    if (plainLine.includes(lowerTarget)) score += 60;

    let start = line.toLowerCase().indexOf(lowerTarget);
    let length = target.length;
    if (start < 0) {
      const word = lowerTarget.split(/\W+/).find((part) => part.length >= 3);
      if (word) {
        start = line.toLowerCase().indexOf(word);
        length = word.length;
      }
    }
    if (start < 0) start = 0;
    const candidate = { start: lineStart + start, end: lineStart + start + length, score };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.start < best.start)) {
      best = candidate;
    }
  });

  if (!best) return null;
  return { start: best.start, end: best.end };
}

function workDirForSource(path: string | null | undefined): string {
  return path ? dirname(path) : "";
}

function latexEscapeTemplateText(value: string): string {
  return value.replace(/([#$%&_{}])/g, "\\$1");
}

function defaultSourceFor(_path: string, template: TypesetTemplate = "article", title = "SomniQ LaTeX Draft"): string {
  const escapedTitle = latexEscapeTemplateText(title.trim() || "Untitled document");
  if (template === "beamer") {
    return `\\documentclass[aspectratio=169]{beamer}
\\usetheme{metropolis}

\\title{${escapedTitle}}
\\author{}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Overview}
  \\begin{itemize}
    \\item Start with the problem and motivation.
    \\item Add one idea per slide.
  \\end{itemize}
\\end{frame}

\\end{document}
`;
  }
  if (template === "report") {
    return `\\documentclass[11pt]{report}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{${escapedTitle}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\chapter{Introduction}

Start writing your report here.

\\end{document}
`;
  }
  if (template === "poster") {
    return `\\documentclass{beamer}
\\usepackage[size=a1,scale=1.1]{beamerposter}

\\title{${escapedTitle}}
\\author{}
\\date{}

\\begin{document}
\\begin{frame}[t]
  \\begin{columns}[t]
    \\begin{column}{.48\\textwidth}
      \\begin{block}{Motivation}
        Summarize the research question and why it matters.
      \\end{block}
    \\end{column}
    \\begin{column}{.48\\textwidth}
      \\begin{block}{Results}
        Add the main evidence, figures, and conclusions.
      \\end{block}
    \\end{column}
  \\end{columns}
\\end{frame}
\\end{document}
`;
  }
  return DEFAULT_LATEX_DOCUMENT.replace("SomniQ LaTeX Draft", escapedTitle);
}

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

function compileStatusText(status: CompileStatus, result: CompileResult | null, language: Language): string {
  const copy = TYPESET_EDITOR_COPY[language].compileStatus;
  if (status === "running") return copy.compiling;
  if (status === "success") {
    if (!result) return copy.compiled;
    return copy.compiledDuration(result.engine, result.durationMs);
  }
  if (status === "partial") return copy.compiledWithErrors;
  if (status === "error") return copy.compileFailed;
  return "";
}

function latexLineWithoutComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "%" && line[index - 1] !== "\\") return line.slice(0, index);
  }
  return line;
}

type EditorAdapter = {
  from: number;
  to: number;
  text: string;
  replace: (from: number, to: number, insert: string, selStart: number, selEnd: number) => void;
};

function activeEditorAdapter(
  mode: EditorMode,
  editorRef: { current: SharedEditorHandle | null },
  visualViewRef: { current: EditorView | null },
  draft: string,
  onChange: (value: string) => void,
): EditorAdapter | null {
  if (mode === "code") {
    const editor = editorRef.current;
    if (!editor) return null;
    const { from, to } = editor.getSelection().main;
    return {
      from,
      to,
      text: draft,
      replace: (rFrom, rTo, insert, selStart, selEnd) => {
        onChange(draft.slice(0, rFrom) + insert + draft.slice(rTo));
        window.setTimeout(() => {
          editor.focus();
          editor.dispatch({ selection: { anchor: selStart, head: selEnd } });
        }, 0);
      },
    };
  }
  const view = visualViewRef.current;
  if (!view) return null;
  const range = view.state.selection.main;
  return {
    from: range.from,
    to: range.to,
    text: view.state.doc.toString(),
    replace: (rFrom, rTo, insert, selStart, selEnd) => {
      view.dispatch({
        changes: { from: rFrom, to: rTo, insert },
        selection: { anchor: selStart, head: selEnd },
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}

/** Wraps the selection in `prefix`/`suffix`; an empty selection wraps `placeholder` instead, pre-selected. */
function wrapSelection(adapter: EditorAdapter, prefix: string, suffix: string, placeholder: string) {
  const hasSelection = adapter.to > adapter.from;
  const content = hasSelection ? adapter.text.slice(adapter.from, adapter.to) : placeholder;
  const selStart = adapter.from + prefix.length;
  adapter.replace(adapter.from, adapter.to, `${prefix}${content}${suffix}`, selStart, selStart + content.length);
}

/**
 * Inserts a snippet at the selection anchor without consuming any selected
 * text (matches Overleaf's `insertCite`/`insertRef`, which insert at
 * `state.selection.main.anchor` — a citation/reference key isn't a sensible
 * substitute for whatever prose happened to be selected).
 */
function insertSnippetAtCursor(adapter: EditorAdapter, before: string, placeholder: string, after: string) {
  const pos = adapter.from;
  const selStart = pos + before.length;
  adapter.replace(pos, pos, `${before}${placeholder}${after}`, selStart, selStart + placeholder.length);
}

/** Blank-line padding so a block insert (table/figure) doesn't run into surrounding text. */
function ensureEmptyLine(text: string, pos: number): { prefix: string; suffix: string } {
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  return {
    prefix: /(^|\n)[ \t]*$/.test(before) ? "" : "\n\n",
    suffix: /^[ \t]*(\n|$)/.test(after) ? "" : "\n\n",
  };
}

function insertBlockAtCursor(adapter: EditorAdapter, template: string) {
  const { prefix, suffix } = ensureEmptyLine(adapter.text, adapter.from);
  const pos = adapter.from;
  adapter.replace(pos, pos, `${prefix}${template}${suffix}`, pos + prefix.length, pos + prefix.length + template.length);
}

const HEADING_LINE_RE = /^(\s*)\\(section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*\{/;

/**
 * Simplified, line-based version of Overleaf's tree-based `setSectionHeadingLevel`
 * (`extensions/toolbar/sections.ts`): if the current line already is a section
 * command, swap just the command keyword (or strip it, for "text"); otherwise
 * wrap the selection or the current line's text in the chosen level.
 */
function applyHeadingLevel(adapter: EditorAdapter, key: string, label: string) {
  const { text } = adapter;
  const lineStart = text.lastIndexOf("\n", adapter.from - 1) + 1;
  const lineEnd = text.indexOf("\n", adapter.from) === -1 ? text.length : text.indexOf("\n", adapter.from);
  const line = text.slice(lineStart, lineEnd);
  const match = HEADING_LINE_RE.exec(line);

  if (match) {
    const [, indent, , star = ""] = match;
    const openBrace = match[0].length - 1;
    const arg = balancedBraceArg(line, openBrace);
    const argEnd = arg == null ? -1 : openBrace + arg.length + 2;
    // Only rewrite a complete heading line. A balanced argument prevents
    // `\section{Deep \textbf{learning}}` from losing its final brace.
    if (arg == null || line.slice(argEnd).trim()) return;
    const replacement = key === "text" ? `${indent}${arg}` : `${indent}\\${key}${star}{${arg}}`;
    const selStart = key === "text" ? lineStart + indent.length : lineStart + indent.length + key.length + 2;
    adapter.replace(lineStart, lineEnd, replacement, selStart, selStart + arg.length);
    return;
  }
  if (key === "text") return; // already plain text

  const hasSelection = adapter.to > adapter.from;
  const content = hasSelection ? text.slice(adapter.from, adapter.to) : line.trim();
  if (content) {
    const from = hasSelection ? adapter.from : lineStart;
    const to = hasSelection ? adapter.to : lineEnd;
    const selStart = from + key.length + 2;
    adapter.replace(from, to, `\\${key}{${content}}`, selStart, selStart + content.length);
    return;
  }

  const placeholder = `New ${label.toLowerCase()}`;
  insertBlockAtCursor(adapter, `\\${key}{${placeholder}}`);
}

/**
 * Simplified version of Overleaf's `wrapRangeInList` (`extensions/toolbar/lists.ts`):
 * wraps the selected line range in `\begin{itemize}`/`\begin{enumerate}`, one
 * `\item` per line. No nested-list/indent-context awareness (needs the tree).
 */
function applyListWrap(adapter: EditorAdapter, environment: "itemize" | "enumerate") {
  const { text } = adapter;
  const hasSelection = adapter.to > adapter.from;
  const fromLine = text.lastIndexOf("\n", adapter.from - 1) + 1;
  const searchFrom = Math.max(adapter.to - 1, adapter.from);
  const toLineEnd = text.indexOf("\n", searchFrom) === -1 ? text.length : text.indexOf("\n", searchFrom);
  const block = text.slice(fromLine, toLineEnd);
  const lines = block.split("\n");
  const blockHasContent = lines.some((line) => line.trim().length > 0);

  if (!hasSelection && !blockHasContent) {
    const insert = `\\begin{${environment}}\n\\item \n\\end{${environment}}`;
    const itemPos = fromLine + `\\begin{${environment}}\n\\item `.length;
    adapter.replace(fromLine, toLineEnd, insert, itemPos, itemPos);
    return;
  }

  const insert = [`\\begin{${environment}}`, ...lines.map((line) => `\\item ${line.trim()}`), `\\end{${environment}}`].join("\n");
  adapter.replace(fromLine, toLineEnd, insert, fromLine, fromLine + insert.length);
}


function textSearchMatches(source: string, query: string): TextSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const haystack = source.toLocaleLowerCase();
  const needle = normalizedQuery.toLocaleLowerCase();
  const matches: TextSearchMatch[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    matches.push({ start: index, end: index + normalizedQuery.length });
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return matches;
}

function nextAnimationFrame(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}







function FileIcon({ path, dir }: { path: string; dir?: boolean }) {
  const ext = extension(path);
  return (
    <svg className={`typeset-file-icon ${dir ? "folder" : ext.slice(1) || "file"}`} viewBox="0 0 16 16" aria-hidden="true">
      {dir ? (
        <path d="M2 4.2h4l1.1 1.4H14v6.9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      ) : ext === ".pdf" ? (
        <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12M5.8 9.5h4.4M5.8 11.4h2.7" />
      ) : ext === ".tex" ? (
        <path d="M3.8 2.5h8.4v11H3.8zM5.8 5.7h4.4M8 5.7v5M6 10.7h4" />
      ) : TYPESET_IMAGE_EXTENSIONS.has(ext) ? (
        <path d="M2.8 3.1h10.4v9.8H2.8zM4.4 11l2.4-2.7 1.8 1.9 1.2-1.3 1.8 2.1M5.3 5.7h.1" />
      ) : (
        <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />
      )}
    </svg>
  );
}


interface ExplorerProps {
  projectPath: string | null;
  rootPath: string;
  activeSourcePath: string | null;
  activePreviewPath: string | null;
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onFileMutation: (mutation: TypesetFileMutation) => void;
}

const VISUAL_OBJECT_BEGIN = "% SOMNIQ-VISUAL-OBJECT";
const VISUAL_OBJECT_END = "% SOMNIQ-VISUAL-OBJECT-END";

function visualObjectId(text: string, offset: number): string {
  let hash = 2166136261;
  const value = `${offset}:${normalizePdfText(text)}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `text-${(hash >>> 0).toString(36)}`;
}

function visualObjectBlockAt(source: string, match: TextSearchMatch): TextSearchMatch | null {
  const start = source.lastIndexOf(VISUAL_OBJECT_BEGIN, match.start);
  if (start < 0) return null;
  const previousEnd = source.lastIndexOf(VISUAL_OBJECT_END, match.start);
  if (previousEnd > start) return null;
  const endMarker = source.indexOf(VISUAL_OBJECT_END, match.end);
  if (endMarker < 0) return null;
  const endLine = source.indexOf("\n", endMarker);
  return { start, end: endLine < 0 ? source.length : endLine + 1 };
}

function visualObjectLatex(id: string, content: string, geometry: PdfTextObjectGeometry): string {
  const left = Math.max(0, geometry.left).toFixed(2);
  const top = Math.max(0, geometry.top).toFixed(2);
  const fontSize = clampNumber(geometry.fontSize, 5, 72).toFixed(2);
  const leading = (clampNumber(geometry.fontSize, 5, 72) * 1.18).toFixed(2);
  const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(geometry.color);
  const colorName = `somniq${id.replace(/[^a-z0-9]/gi, "")}`;
  const colorLine = rgb
    ? `\\definecolor{${colorName}}{RGB}{${parseInt(rgb[1], 16)},${parseInt(rgb[2], 16)},${parseInt(rgb[3], 16)}}`
    : `\\definecolor{${colorName}}{RGB}{31,41,55}`;
  return [
    `${VISUAL_OBJECT_BEGIN} id=${id} x=${left}pt y=${top}pt`,
    colorLine,
    "\\begin{tikzpicture}[remember picture,overlay]",
    `  \\node[anchor=north west,inner sep=0pt,outer sep=0pt,text=${colorName},font={\\fontsize{${fontSize}pt}{${leading}pt}\\selectfont}]`,
    `    at ([xshift=${left}pt,yshift=-${top}pt]current page.north west) {${content}};`,
    "\\end{tikzpicture}",
    `${VISUAL_OBJECT_END} id=${id}`,
    "",
  ].join("\n");
}

function ensureTikzPackage(source: string): string {
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\btikz\b[^}]*\}/.test(source)) return source;
  const documentClass = source.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}[^\n]*(?:\n|$)/);
  if (documentClass?.index != null) {
    const offset = documentClass.index + documentClass[0].length;
    return `${source.slice(0, offset)}\\usepackage{tikz}\n${source.slice(offset)}`;
  }
  const beginDocument = source.indexOf("\\begin{document}");
  if (beginDocument >= 0) return `${source.slice(0, beginDocument)}\\usepackage{tikz}\n${source.slice(beginDocument)}`;
  return `\\usepackage{tikz}\n${source}`;
}

function editPdfTextInLatex(source: string, pdfText: string, context: string, nextText: string): string | null {
  const match = findLatexOffsetForPdfText(source, pdfText, context);
  if (!match) return null;
  const replacement = isLatexMathMatch(source, match) ? nextText : escapeDirectLatexText(nextText);
  return `${source.slice(0, match.start)}${replacement}${source.slice(match.end)}`;
}

function escapeDirectLatexText(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

/** PDF text inside a math run must stay LaTeX source, not be prose-escaped. */
function isLatexMathMatch(source: string, match: TextSearchMatch): boolean {
  const containsMatch = (from: number, to: number) => match.start >= from && match.end <= to;
  const patterns = [
    /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g,
    /(?<!\\)\\\[[\s\S]*?\\\]/g,
    /(?<!\\)\\\([\s\S]*?\\\)/g,
    /(?<!\\)\$\$[\s\S]*?\$\$/g,
    /(?<!\\)\$(?!\$)(?:\\.|[^$\\\n])+?\$/g,
  ];
  return patterns.some((pattern) => {
    let math: RegExpExecArray | null;
    while ((math = pattern.exec(source))) {
      if (containsMatch(math.index, math.index + math[0].length)) return true;
    }
    return false;
  });
}

function positionPdfTextInFrame(
  frameSource: string,
  pdfText: string,
  context: string,
  geometry: PdfTextObjectGeometry,
): string | null {
  const match = findLatexOffsetForPdfText(frameSource, pdfText, context);
  if (!match) return null;
  const existingBlock = visualObjectBlockAt(frameSource, match);
  const content = frameSource.slice(match.start, match.end);
  const idMatch = existingBlock
    ? frameSource.slice(existingBlock.start, existingBlock.end).match(/SOMNIQ-VISUAL-OBJECT\s+id=([^\s]+)/)
    : null;
  const id = idMatch?.[1] ?? visualObjectId(pdfText, match.start);
  const block = visualObjectLatex(id, content, geometry);
  if (existingBlock) {
    return `${frameSource.slice(0, existingBlock.start)}${block}${frameSource.slice(existingBlock.end)}`;
  }

  const placeholderWidth = Math.max(1, geometry.width).toFixed(2);
  const placeholderHeight = Math.max(1, geometry.height).toFixed(2);
  const placeholder = `\\rule{${placeholderWidth}pt}{0pt}\\rule{0pt}{${placeholderHeight}pt}`;
  const withoutOriginal = `${frameSource.slice(0, match.start)}${placeholder}${frameSource.slice(match.end)}`;
  const frameEnd = withoutOriginal.lastIndexOf("\\end{frame}");
  if (frameEnd < 0) return null;
  return `${withoutOriginal.slice(0, frameEnd)}${block}${withoutOriginal.slice(frameEnd)}`;
}

function insertVisualTextInFrame(
  frameSource: string,
  content: string,
  geometry: PdfTextObjectGeometry,
): string | null {
  const frameEnd = frameSource.lastIndexOf("\\end{frame}");
  if (frameEnd < 0) return null;
  const objectCount = (frameSource.match(/% SOMNIQ-VISUAL-OBJECT id=/g) ?? []).length;
  const id = visualObjectId(`${content}:${objectCount}`, frameEnd);
  const block = visualObjectLatex(id, content, geometry);
  return `${frameSource.slice(0, frameEnd)}${block}${frameSource.slice(frameEnd)}`;
}

type TypesetFileMutation =
  | { type: "delete"; path: string; isDir: boolean }
  | { type: "rename"; path: string; newPath: string; isDir: boolean };

function TypesetExplorer({
  projectPath,
  rootPath,
  activeSourcePath,
  activePreviewPath,
  refreshKey,
  onOpenPath,
  onFileMutation,
}: ExplorerProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].explorer;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["", "papers"]));
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; entry: FileTreeEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileTreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileTreeEntry | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const rootName = basename(rootPath) || basename(projectPath) || copy.rootFallback;

  const loadDir = useCallback(async (path: string) => {
    setLoading((items) => new Set(items).add(path));
    setError(null);
    try {
      const entries = await fileListDir(path || null);
      setChildren((current) => ({ ...current, [path]: entries }));
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading((items) => {
        const next = new Set(items);
        next.delete(path);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    const parentDir = workDirForSource(activeSourcePath);
    const dirs = parentDir && parentDir !== rootPath ? [rootPath, parentDir] : [rootPath];
    setExpanded(new Set(dirs));
    setChildren({});
    void loadDir(rootPath);
    if (parentDir) void loadDir(parentDir);
  }, [loadDir, projectPath, refreshKey, activeSourcePath, rootPath]);

  useEffect(() => {
    if (!rowMenu) return;
    const dismiss = () => setRowMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenu]);

  useEffect(() => {
    if (!renameTarget) return;
    const frame = window.requestAnimationFrame(() => renameInputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [renameTarget]);

  const toggleDir = (path: string) => {
    setExpanded((items) => {
      const next = new Set(items);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!children[path] && !loading.has(path)) void loadDir(path);
      }
      return next;
    });
  };

  const refreshAfterChange = useCallback(async (paths: string[]) => {
    await Promise.all(Array.from(new Set(paths)).map((path) => loadDir(path)));
  }, [loadDir]);

  const openRenameDialog = (entry: FileTreeEntry) => {
    setRenameValue(entry.name);
    setRenameTarget(entry);
    setRowMenu(null);
  };

  const renameEntry = async () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName || /[\\/]/.test(nextName)) {
      setError(copy.renameNameError);
      return;
    }
    if (nextName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const oldPath = renameTarget.path;
    const parent = dirname(oldPath);
    const newPath = parent ? `${parent}/${nextName}` : nextName;
    setOperationBusy(true);
    setError(null);
    try {
      const renamed = await fileRename(oldPath, newPath);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${oldPath}/`;
        for (const path of items) {
          if (path === oldPath) next.add(renamed.path);
          else if (renameTarget.isDir && path.startsWith(prefix)) next.add(`${renamed.path}/${path.slice(prefix.length)}`);
          else next.add(path);
        }
        return next;
      });
      await refreshAfterChange([dirname(oldPath), dirname(renamed.path)]);
      onFileMutation({ type: "rename", path: oldPath, newPath: renamed.path, isDir: renameTarget.isDir });
      setRenameTarget(null);
    } catch (renameError) {
      setError(String(renameError));
    } finally {
      setOperationBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (!deleteTarget) return;
    setOperationBusy(true);
    setError(null);
    try {
      await fileDelete(deleteTarget.path);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${deleteTarget.path}/`;
        for (const path of items) {
          if (path !== deleteTarget.path && !path.startsWith(prefix)) next.add(path);
        }
        return next;
      });
      await refreshAfterChange([dirname(deleteTarget.path)]);
      onFileMutation({ type: "delete", path: deleteTarget.path, isDir: deleteTarget.isDir });
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(String(deleteError));
    } finally {
      setOperationBusy(false);
    }
  };

  const duplicateEntry = async (entry: FileTreeEntry) => {
    setOperationBusy(true);
    setError(null);
    try {
      const duplicated = await fileDuplicate(entry.path);
      const parent = dirname(entry.path);
      setExpanded((items) => {
        const next = new Set(items);
        next.add(parent);
        if (duplicated.isDir) next.add(duplicated.path);
        return next;
      });
      await refreshAfterChange([parent]);
    } catch (duplicateError) {
      setError(String(duplicateError));
    } finally {
      setOperationBusy(false);
      setRowMenu(null);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
    } catch (copyError) {
      setError(copy.copyPathError(String(copyError)));
    } finally {
      setRowMenu(null);
    }
  };

  const renderEntry = (entry: FileTreeEntry, depth: number) => {
    const isExpanded = expanded.has(entry.path);
    const sourceActive = activeSourcePath === entry.path;
    const previewActive = !sourceActive && activePreviewPath === entry.path;
    const nested = children[entry.path] ?? [];
    const ext = extension(entry.path);
    const openable = entry.isDir || ext === ".tex" || ext === ".pdf" || TYPESET_IMAGE_EXTENSIONS.has(ext);
    return (
      <div key={entry.path}>
        <button
          type="button"
          className={`typeset-tree-row entity-name${entry.isDir ? " folder" : " file"}${sourceActive ? " active selected" : ""}${previewActive ? " preview-active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          title={openable ? entry.path : copy.rightClickHint(entry.path)}
          onClick={() => {
            if (!openable) return;
            if (entry.isDir) toggleDir(entry.path);
            else onOpenPath(entry.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setRowMenu({ x: event.clientX, y: event.clientY, entry });
          }}
        >
          <span className="typeset-tree-caret">{entry.isDir ? (isExpanded ? "v" : ">") : ""}</span>
          <FileIcon path={entry.path} dir={entry.isDir} />
          <span className="typeset-tree-name">{entry.name}</span>
        </button>
        {entry.isDir && isExpanded && (
          <div>
            {loading.has(entry.path) && (
              <div className="typeset-tree-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 34}px` }}>
                {copy.loading}
              </div>
            )}
            {!loading.has(entry.path) && nested.length === 0 && children[entry.path] && (
              <div className="typeset-tree-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 34}px` }}>
                {copy.empty}
              </div>
            )}
            {nested.map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootChildren = children[rootPath] ?? [];

  return (
    <aside className="typeset-sidebar file-tree ide-react-file-tree-panel editor-sidebar" aria-label={copy.fileTreeLabel}>
      <div className="file-tree-toolbar typeset-sidebar-head">
        <div className="file-tree-expand-collapse-button">
          <ToolIcon name="chevron" className="file-tree-expand-icon" />
          <h4>{copy.fileTreeHeading}</h4>
        </div>
        <span className="typeset-sidebar-subpath" title={rootPath || rootName}>{rootPath || rootName}</span>
      </div>
      {error && <div className="typeset-inline-error">{error}</div>}
      <div className="typeset-tree file-tree-inner">
        <button type="button" className="typeset-tree-root entity-name" onClick={() => toggleDir(rootPath)}>
          <span className="typeset-tree-caret">{expanded.has(rootPath) ? "v" : ">"}</span>
          <FileIcon path={rootName} dir />
          <span>{rootName}</span>
        </button>
        {expanded.has(rootPath) && (
          <div>
            {loading.has(rootPath) && <div className="typeset-tree-muted root">{copy.loading}</div>}
            {rootChildren.map((entry) => renderEntry(entry, 0))}
          </div>
        )}
      </div>
      {rowMenu && typeof document !== "undefined" && createPortal(
        <div
          className="typeset-tree-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          aria-label={copy.fileActionsLabel}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void copyPath(rowMenu.entry.path)}>
            {copy.copyPath}
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void duplicateEntry(rowMenu.entry)}>
            {copy.duplicate}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={operationBusy}
            onClick={() => {
              void fileReveal(rowMenu.entry.path).catch((revealError) => setError(String(revealError)));
              setRowMenu(null);
            }}
          >
            {copy.showInFolder}
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => openRenameDialog(rowMenu.entry)}>
            {copy.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={operationBusy}
            onClick={() => {
              setDeleteTarget(rowMenu.entry);
              setRowMenu(null);
            }}
          >
            {copy.delete}
          </button>
        </div>,
        document.body,
      )}
      {renameTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <form
            className="typeset-file-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="typeset-rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              void renameEntry();
            }}
          >
            <h3 id="typeset-rename-title">{copy.renameTitle(renameTarget.isDir)}</h3>
            <label>
              {copy.nameLabel}
              <input
                ref={renameInputRef}
                value={renameValue}
                disabled={operationBusy}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </label>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setRenameTarget(null)}>{copy.cancel}</button>
              <button type="submit" className="primary" disabled={operationBusy || !renameValue.trim()}>{copy.rename}</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {deleteTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <div className="typeset-file-dialog" role="alertdialog" aria-modal="true" aria-labelledby="typeset-delete-title">
            <h3 id="typeset-delete-title">{copy.deleteTitle(deleteTarget.isDir)}</h3>
            <p>{copy.deleteConfirmBody(deleteTarget.name)}</p>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setDeleteTarget(null)}>{copy.cancel}</button>
              <button type="button" className="danger" disabled={operationBusy} onClick={() => void deleteEntry()}>{copy.delete}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}

interface PdfPageHighlight {
  left: number;
  top: number;
  width: number;
  height: number;
  nonce: number;
}

/**
 * A click in the compiled PDF, in the terms SyncTeX's `edit` query wants:
 * `x`/`y` are big points from the page's top-left corner. `word` is the word
 * under the pointer when the click landed on text, used to refine the source
 * column SyncTeX itself never reports.
 */
interface PdfClickPosition {
  page: number;
  x: number;
  y: number;
  word?: string;
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  estimatedSize?: { width: number; height: number };
  onSourceTextClick: (text: string, context: string, position?: PdfClickPosition) => void;
  editable?: boolean;
  onTextObjectEdit?: (change: PdfTextObjectChange, nextText: string) => void;
  onTextObjectMove?: (change: PdfTextObjectChange) => void;
  onPageSize?: (width: number, height: number) => void;
  pageRef?: (page: number, el: HTMLDivElement | null) => void;
  highlight?: PdfPageHighlight | null;
}

type PdfTextRun = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  backgroundColor: string;
};

/**
 * The clickable/hoverable boxes for one page's text.
 *
 * The vertical extent comes from the font's own ascent/descent (see
 * `pdfTextRunBox`) rather than from `item.height`, because these boxes have to
 * agree with the boxes SyncTeX recorded: a box sized off the em square sits
 * ~3bp too high, which puts its top edge inside the *previous* typeset line and
 * leaves every descender uncovered.
 */
function textRunsFromPdfContent(textContent: unknown, viewport: { transform: number[] }, zoom: number): PdfTextRun[] {
  const content = textContent as { items?: unknown[]; styles?: Record<string, PdfTextStyleLike> };
  const items = Array.isArray(content.items) ? content.items : [];
  const styles = content.styles ?? {};
  return items.flatMap((item, index) => {
    const textItem = item as { str?: unknown; fontName?: unknown } & PdfTextItemLike;
    const text = normalizePdfText(typeof textItem.str === "string" ? textItem.str : "");
    if (!text) return [];
    const style = typeof textItem.fontName === "string" ? styles[textItem.fontName] : undefined;
    const box = pdfTextRunBox(textItem, style, viewport.transform, zoom, text.length);
    if (!box) return [];
    return [{
      id: `${index}:${text}`,
      text,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      fontSize: box.fontSize,
      color: "#1f2937",
      backgroundColor: "#ffffff",
    }];
  });
}

function samplePdfTextColors(
  canvas: HTMLCanvasElement,
  run: PdfTextRun,
  outputScale: number,
): Pick<PdfTextRun, "color" | "backgroundColor"> {
  const context = canvas.getContext("2d");
  if (!context) return { color: run.color, backgroundColor: run.backgroundColor };
  const x = clampNumber(Math.floor(run.left * outputScale), 0, Math.max(0, canvas.width - 1));
  const y = clampNumber(Math.floor(run.top * outputScale), 0, Math.max(0, canvas.height - 1));
  const width = clampNumber(Math.ceil(run.width * outputScale), 1, Math.max(1, canvas.width - x));
  const height = clampNumber(Math.ceil(run.height * outputScale), 1, Math.max(1, canvas.height - y));
  try {
    const pixels = context.getImageData(x, y, width, height).data;
    const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 100) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
      const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      bin.count += 1;
      bin.red += red;
      bin.green += green;
      bin.blue += blue;
      bins.set(key, bin);
    }
    const ranked = Array.from(bins.values()).sort((left, right) => right.count - left.count);
    const background = ranked[0];
    if (!background) return { color: run.color, backgroundColor: run.backgroundColor };
    const backgroundRgb = [background.red / background.count, background.green / background.count, background.blue / background.count];
    const foreground = ranked.slice(1).reduce<{ bin: typeof background; score: number } | null>((best, bin) => {
      const rgb = [bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count];
      const distance = Math.hypot(rgb[0] - backgroundRgb[0], rgb[1] - backgroundRgb[1], rgb[2] - backgroundRgb[2]);
      const score = distance * Math.sqrt(bin.count);
      return distance > 28 && (!best || score > best.score) ? { bin, score } : best;
    }, null)?.bin;
    const toHex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
    const backgroundColor = `#${toHex(backgroundRgb[0])}${toHex(backgroundRgb[1])}${toHex(backgroundRgb[2])}`;
    if (!foreground) return { color: run.color, backgroundColor };
    return {
      color: `#${toHex(foreground.red / foreground.count)}${toHex(foreground.green / foreground.count)}${toHex(foreground.blue / foreground.count)}`,
      backgroundColor,
    };
  } catch {
    return { color: run.color, backgroundColor: run.backgroundColor };
  }
}

const PdfPage = memo(function PdfPage({
  pdf,
  page,
  zoom,
  estimatedSize,
  onSourceTextClick,
  editable = false,
  onTextObjectEdit,
  onTextObjectMove,
  onPageSize,
  pageRef,
  highlight,
}: PdfPageProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfPage;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTask = useRef<RenderTask | null>(null);
  const renderedDocumentRef = useRef<{ pdf: PDFDocumentProxy; page: number } | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [textRuns, setTextRuns] = useState<PdfTextRun[]>([]);
  const [objectDrafts, setObjectDrafts] = useState<Record<string, PdfTextObjectGeometry & { text: string }>>({});
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    geometry: PdfTextObjectGeometry;
    text: string;
    context: string;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  // The rendered viewport and the page's own box are what turn a click into the
  // big-point coordinate SyncTeX queries take. Held in a ref because the click
  // handlers run long after the render that produced them.
  const pageGeometryRef = useRef<{ viewport: SyncTexViewportLike; box: number[] } | null>(null);
  const pageElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    const documentChanged = renderedDocumentRef.current?.pdf !== pdf || renderedDocumentRef.current?.page !== page;
    setError(null);
    if (documentChanged) {
      renderedDocumentRef.current = { pdf, page };
      setTextRuns([]);
      setPageSize(null);
      setObjectDrafts({});
      setSelectedObjectId(null);
      setEditingObjectId(null);
    }
    renderTask.current?.cancel();
    renderTask.current = null;
    void pdf
      .getPage(page)
      .then((pdfPage: PDFPageProxy) => {
        if (disposed || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const render = renderPdfPageToCanvas(pdfPage, canvas, zoom);
        pageGeometryRef.current = { viewport: render.viewport, box: pdfPage.view };
        setPageSize({ width: render.cssWidth, height: render.cssHeight });
        onPageSize?.(render.cssWidth / zoom, render.cssHeight / zoom);
        renderTask.current = render.task;
        return Promise.all([render.task.promise, pdfPage.getTextContent()]).then(([, textContent]) => {
          if (disposed) return;
          const runs = textRunsFromPdfContent(textContent, render.viewport, zoom);
          setTextRuns(runs.map((run) => ({ ...run, ...samplePdfTextColors(canvas, run, render.outputScale) })));
        });
      })
      .catch((renderError) => {
        if (!disposed && renderError?.name !== "RenderingCancelledException") {
          setError(String(renderError));
        }
      });
    return () => {
      disposed = true;
      renderTask.current?.cancel();
      renderTask.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [page, pdf, zoom]);

  useEffect(() => {
    if (!editable) return undefined;
    const geometryAt = (event: PointerEvent | MouseEvent, drag: NonNullable<typeof dragRef.current>) => {
      if (!pageSize) return null;
      const deltaX = (event.clientX - drag.startClientX) / zoom;
      const deltaY = (event.clientY - drag.startClientY) / zoom;
      const naturalPageWidth = pageSize.width / zoom;
      const naturalPageHeight = pageSize.height / zoom;
      return {
        ...drag.geometry,
        left: clampNumber(drag.geometry.left + deltaX, 0, Math.max(0, naturalPageWidth - drag.geometry.width)),
        top: clampNumber(drag.geometry.top + deltaY, 0, Math.max(0, naturalPageHeight - drag.geometry.height)),
        text: drag.text,
      };
    };
    const moveObject = (event: PointerEvent | MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaX = (event.clientX - drag.startClientX) / zoom;
      const deltaY = (event.clientY - drag.startClientY) / zoom;
      if (Math.hypot(deltaX, deltaY) > 1.5) drag.moved = true;
      if (!drag.moved) return;
      const nextDraft = geometryAt(event, drag);
      if (nextDraft) setObjectDrafts((items) => ({ ...items, [drag.id]: nextDraft }));
    };
    const finishObjectMove = (event: PointerEvent | MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      suppressClickRef.current = drag.moved;
      if (!drag.moved) return;
      const nextDraft = geometryAt(event, drag);
      if (!nextDraft) return;
      setObjectDrafts((items) => ({ ...items, [drag.id]: nextDraft }));
      onTextObjectMove?.({ ...nextDraft, context: drag.context });
    };
    window.addEventListener("pointermove", moveObject);
    window.addEventListener("pointerup", finishObjectMove);
    window.addEventListener("pointercancel", finishObjectMove);
    window.addEventListener("mousemove", moveObject);
    window.addEventListener("mouseup", finishObjectMove);
    return () => {
      window.removeEventListener("pointermove", moveObject);
      window.removeEventListener("pointerup", finishObjectMove);
      window.removeEventListener("pointercancel", finishObjectMove);
      window.removeEventListener("mousemove", moveObject);
      window.removeEventListener("mouseup", finishObjectMove);
    };
  }, [editable, onTextObjectMove, pageSize, zoom]);

  /**
   * Ask for the source behind a point on the page. Every viewer that gets
   * inverse search right (Skim, SumatraPDF, TeXShop) treats the *whole page* as
   * the query surface, because SyncTeX resolves a coordinate rather than a
   * glyph: white space between words, a display equation, a figure and a table
   * cell all have boxes it can answer for. Gating the query behind per-run hit
   * boxes both loses those and mis-answers near a box edge.
   */
  const requestSourceForPoint = useCallback((
    event: { clientX: number; clientY: number },
    run?: PdfTextRun,
    context = "",
  ) => {
    const geometry = pageGeometryRef.current;
    const element = pageElementRef.current;
    if (!geometry || !element) return;
    const bounds = element.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    const point = syncTexPointFromPageOffset(geometry.viewport, geometry.box, offsetX, offsetY);
    const word = run ? wordAtRatio(run.text, runTextRatio(run, offsetX)) : undefined;
    onSourceTextClick(run?.text ?? "", context || run?.text || "", { page, x: point.x, y: point.y, word });
  }, [onSourceTextClick, page]);

  // A click that ends somewhere other than where it started was a drag — the
  // user was scrolling or selecting, not asking to navigate.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const clickWasStationary = (event: { clientX: number; clientY: number }) => {
    const origin = pointerDownRef.current;
    pointerDownRef.current = null;
    return !origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= 4;
  };

  return (
    <div
      className="typeset-pdf-page"
      ref={(el) => {
        pageElementRef.current = el;
        pageRef?.(page, el);
      }}
      style={!pageSize && estimatedSize ? {
        width: `${estimatedSize.width * zoom}px`,
        height: `${estimatedSize.height * zoom}px`,
      } : undefined}
      onMouseDown={editable ? undefined : (event) => {
        pointerDownRef.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={editable ? undefined : (event) => {
        if (clickWasStationary(event)) requestSourceForPoint(event);
      }}
    >
      <canvas ref={canvasRef} aria-label={copy.pdfPageLabel(page)} />
      {pageSize && (
        <div
          className="typeset-pdf-text-layer"
          style={{ width: `${pageSize.width}px`, height: `${pageSize.height}px` }}
          aria-label={copy.pdfTextLayerLabel(page)}
        >
          {textRuns.map((run, index) => {
            const context = textRuns.slice(Math.max(0, index - 2), index + 3).map((item) => item.text).join(" ");
            const draft = objectDrafts[run.id];
            const displayed = draft
              ? {
                  text: draft.text,
                  left: draft.left * zoom,
                  top: draft.top * zoom,
                  width: draft.width * zoom,
                  height: draft.height * zoom,
                  fontSize: draft.fontSize * zoom,
                  color: draft.color,
                }
              : run;
            const selected = editable && selectedObjectId === run.id;
            const editing = editable && editingObjectId === run.id;
            const style = {
              left: `${displayed.left}px`,
              top: `${displayed.top}px`,
              width: `${displayed.width}px`,
              height: `${Math.max(displayed.height, displayed.fontSize * 1.15)}px`,
              fontSize: `${displayed.fontSize}px`,
              color: draft || editing ? displayed.color : undefined,
              ...(draft ? { "--typeset-object-background": run.backgroundColor } : {}),
            } as CSSProperties;
            const geometry = (): PdfTextObjectGeometry => ({
              left: displayed.left / zoom,
              top: displayed.top / zoom,
              width: displayed.width / zoom,
              height: displayed.height / zoom,
              fontSize: displayed.fontSize / zoom,
              color: displayed.color,
            });
            const commitEdit = () => {
              const nextText = editingText.trim();
              setEditingObjectId(null);
              if (!nextText || nextText === displayed.text) return;
              const nextDraft = { ...geometry(), text: nextText };
              setObjectDrafts((items) => ({ ...items, [run.id]: nextDraft }));
              onTextObjectEdit?.({ ...geometry(), text: displayed.text, context }, nextText);
            };
            if (editing) {
              return (
                <input
                  key={run.id}
                  className="typeset-slide-object-editor"
                  style={style}
                  value={editingText}
                  aria-label={copy.editSlideTextLabel(displayed.text)}
                  autoFocus
                  onChange={(event) => setEditingText(event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingObjectId(null);
                    }
                  }}
                />
              );
            }
            return (
              <Fragment key={run.id}>
                {draft && (
                  <span
                    className="typeset-slide-object-origin-mask"
                    aria-hidden="true"
                    style={{
                      left: `${Math.max(0, run.left - 1.5)}px`,
                      top: `${Math.max(0, run.top - 1.5)}px`,
                      width: `${run.width + 3}px`,
                      height: `${Math.max(run.height, run.fontSize * 1.15) + 3}px`,
                      backgroundColor: run.backgroundColor,
                    }}
                  />
                )}
                <button
                type="button"
                className={`typeset-pdf-text-run${editable ? " direct-object" : ""}${selected ? " selected" : ""}${draft ? " moved" : ""}`}
                style={style}
                title={editable ? copy.dragMoveTitle : copy.jumpToSourceTitle}
                aria-label={editable ? copy.slideTextObjectLabel(displayed.text) : copy.jumpToSourceTextLabel(displayed.text)}
                aria-pressed={editable ? selected : undefined}
                onPointerDown={(event) => {
                  if (!editable || event.button !== 0 || dragRef.current) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  dragRef.current = {
                    id: run.id,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    geometry: geometry(),
                    text: displayed.text,
                    context,
                    moved: false,
                  };
                }}
                onMouseDown={(event) => {
                  if (!editable || event.button !== 0 || dragRef.current) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  dragRef.current = {
                    id: run.id,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    geometry: geometry(),
                    text: displayed.text,
                    context,
                    moved: false,
                  };
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (editable) {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    setSelectedObjectId(run.id);
                    return;
                  }
                  // Same query as a click on bare page, plus the word under the
                  // pointer so the source column can be refined past the line
                  // start SyncTeX alone gives.
                  if (clickWasStationary(event)) requestSourceForPoint(event, run, context);
                }}
                onDoubleClick={(event) => {
                  if (!editable) return;
                  event.stopPropagation();
                  setSelectedObjectId(run.id);
                  setEditingText(displayed.text);
                  setEditingObjectId(run.id);
                }}
                onKeyDown={(event) => {
                  if (!editable) return;
                  if (event.key === "Enter" || event.key === "F2") {
                    event.preventDefault();
                    setEditingText(displayed.text);
                    setEditingObjectId(run.id);
                  } else if ((event.key === "Delete" || event.key === "Backspace") && selected) {
                    event.preventDefault();
                    onTextObjectEdit?.({ ...geometry(), text: displayed.text, context }, "");
                  }
                }}
                >
                  {displayed.text}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
      {highlight && (
        <div
          key={highlight.nonce}
          className="typeset-pdf-forward-highlight"
          style={{
            left: `${highlight.left}px`,
            top: `${highlight.top}px`,
            width: `${highlight.width}px`,
            height: `${highlight.height}px`,
          }}
          aria-hidden="true"
        />
      )}
      {error && <div className="typeset-pdf-page-error">{error}</div>}
    </div>
  );
});

interface PdfPreviewProps {
  path: string | null;
  sourcePath: string | null;
  refreshKey: number;
  status: CompileStatus;
  result: CompileResult | null;
  dirty: boolean;
  disabled: boolean;
  logOpen: boolean;
  diagnosticsCount: number;
  continueOnError: boolean;
  canCancel: boolean;
  onCompile: () => void;
  onCancelCompile: () => void;
  onClearCacheCompile: () => void;
  onSetContinueOnError: (value: boolean) => void;
  onToggleLog: () => void;
  /** `position` is the PDF point that was clicked, for SyncTeX inverse search;
   * callers fall back to text matching when it is absent. */
  onSourceTextClick: (text: string, context: string, position?: PdfClickPosition) => void;
  onHide?: () => void;
  forwardTarget?: PdfForwardTarget | null;
  forwardSearchNotice?: string | null;
}

interface CompiledVisualProps {
  path: string | null;
  refreshKey: number;
  page: number;
  slide: BeamerSlide | null;
  slides: BeamerSlide[];
  source: string;
  dirty: boolean;
  compiling: boolean;
  onChangeSource: (source: string) => void;
  onSave: () => void;
  onNavigateToLine: (line: number) => void;
  onOpenCodeAtLine: (line: number) => void;
  onOpenCodeRange: (start: number, end: number) => void;
  onSourceTextClick: (text: string, context: string) => void;
  focused: boolean;
  onToggleFocus: () => void;
}

/**
 * Safe Visual surface for Beamer: the compiled PDF page is the canvas.
 * Arbitrary TikZ/custom macros cannot be reproduced faithfully by a rich-text
 * source decorator, so the compiled output remains the visual truth. Text
 * clicks reveal the exact frame source without pretending to reproduce custom
 * macros in a lossy rich-text model.
 */
function TypesetCompiledVisual({
  path,
  refreshKey,
  page,
  slide,
  slides,
  source,
  dirty,
  compiling,
  onChangeSource,
  onSave,
  onNavigateToLine,
  onOpenCodeAtLine,
  onOpenCodeRange,
  onSourceTextClick,
  focused,
  onToggleFocus,
}: CompiledVisualProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].compiledVisual;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [deckOpen, setDeckOpen] = useState(true);
  const [pageNaturalSize, setPageNaturalSize] = useState({ width: 364, height: 273 });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedSourceRange, setSelectedSourceRange] = useState<{ start: number; end: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const frameRange = useMemo(() => {
    if (!slide) return { start: 0, end: source.length };
    const start = lineOffsetFor(source, slide.line);
    const end = Math.max(start, Math.min(source.length, lineOffsetFor(source, slide.endLine + 1)));
    return { start, end };
  }, [slide, source]);
  const frameSource = source.slice(frameRange.start, frameRange.end);
  const frameLineCount = Math.max(1, frameSource.replace(/\n$/, "").split("\n").length);

  useEffect(() => {
    let disposed = false;
    let loadedPdf: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(null);
    if (!path) return () => undefined;
    setLoading(true);
    void fileReadBytes(path)
      .then((bytes) => openPdfDocument(bytes))
      .then((document) => {
        loadedPdf = document;
        if (disposed) {
          void document.destroy();
          return;
        }
        setPdf(document);
      })
      .catch((loadError) => {
        if (!disposed) setError(String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      if (loadedPdf) void loadedPdf.destroy();
    };
  }, [path, refreshKey]);

  const fitSlide = useCallback(async () => {
    if (!pdf) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    try {
      const pdfPage = await pdf.getPage(clampNumber(page, 1, pdf.numPages));
      const viewport = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, scroll.clientWidth - 72);
      const availableHeight = Math.max(200, scroll.clientHeight - 72);
      setZoom(clampNumber(Math.min(availableWidth / viewport.width, availableHeight / viewport.height), 0.35, 2.4));
    } catch {
      setZoom(1);
    }
  }, [page, pdf]);

  useEffect(() => {
    if (!pdf || !fitMode) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const refit = () => {
      if (!disposed) void fitSlide();
    };
    refit();
    if (typeof ResizeObserver !== "undefined" && scrollRef.current) {
      resizeObserver = new ResizeObserver(refit);
      resizeObserver.observe(scrollRef.current);
    }
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
    };
  }, [fitMode, fitSlide, pdf]);

  useEffect(() => {
    if (!sourceOpen || !selectedSourceRange) return;
    const frame = window.requestAnimationFrame(() => {
      const editor = sourceEditorRef.current;
      if (!editor) return;
      const start = clampNumber(selectedSourceRange.start - frameRange.start, 0, editor.value.length);
      const end = clampNumber(selectedSourceRange.end - frameRange.start, start, editor.value.length);
      editor.focus();
      editor.setSelectionRange(start, end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [frameRange.start, selectedSourceRange, sourceOpen]);

  const safePage = pdf ? clampNumber(page, 1, pdf.numPages) : 1;
  const activeSlideIndex = slide ? slides.indexOf(slide) : Math.max(0, safePage - 1);

  const navigateSlide = (direction: -1 | 1) => {
    const nextIndex = clampNumber(activeSlideIndex + direction, 0, Math.max(0, slides.length - 1));
    const nextSlide = slides[nextIndex];
    if (nextSlide && nextIndex !== activeSlideIndex) onNavigateToLine(nextSlide.line);
  };

  const openSourceForText = (text: string, context: string) => {
    const localMatch = findLatexOffsetForPdfText(frameSource, text, context);
    const match = localMatch
      ? { start: localMatch.start + frameRange.start, end: localMatch.end + frameRange.start }
      : findLatexOffsetForPdfText(source, text, context);
    if (match) setSelectedSourceRange(match);
    setSourceOpen(true);
    onSourceTextClick(text, context);
  };

  const changeFrameSource = (nextFrameSource: string) => {
    setSelectedSourceRange(null);
    onChangeSource(`${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`);
  };

  const editTextObject = (change: PdfTextObjectChange, nextText: string) => {
    // Scope to the current frame first (mirrors moveTextObject/openSourceForText)
    // so editing or deleting a slide's text object can't match and mutate the
    // same wording on a different slide earlier in the document.
    const nextFrameSource = editPdfTextInLatex(frameSource, change.text, change.context, nextText);
    if (nextFrameSource != null) {
      onChangeSource(`${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`);
      return;
    }
    const nextSource = editPdfTextInLatex(source, change.text, change.context, nextText);
    if (nextSource == null) {
      openSourceForText(change.text, change.context);
      return;
    }
    onChangeSource(nextSource);
  };

  const moveTextObject = (change: PdfTextObjectChange) => {
    const nextFrameSource = positionPdfTextInFrame(frameSource, change.text, change.context, change);
    if (nextFrameSource == null) {
      openSourceForText(change.text, change.context);
      return;
    }
    const positioned = `${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`;
    onChangeSource(ensureTikzPackage(positioned));
  };

  const addTextObject = () => {
    const nextFrameSource = insertVisualTextInFrame(frameSource, "New text", {
      left: pageNaturalSize.width * 0.4,
      top: pageNaturalSize.height * 0.46,
      width: 96,
      height: 20,
      fontSize: 18,
      color: "#1f2937",
    });
    if (nextFrameSource == null) return;
    const nextSource = `${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`;
    onChangeSource(ensureTikzPackage(nextSource));
  };

  const changeZoom = (delta: number) => {
    setFitMode(false);
    setZoom((value) => clampNumber(value + delta, 0.35, 2.4));
  };

  return (
    <section className="typeset-compiled-visual typeset-visual-pane" aria-label={copy.editorLabel}>
      <div className="typeset-slide-canvas-toolbar">
        <div className="typeset-slide-canvas-identity">
          <span>{copy.slideOf(safePage, pdf ? pdf.numPages : null)}</span>
          <strong>{slide?.title || copy.compiledSlideFallback}</strong>
          <span className="typeset-slide-direct-mode">{copy.directEdit}</span>
          <em className={dirty ? "stale" : "current"} role="status">
            {dirty ? copy.draftStatus : copy.compiledPreview}
          </em>
        </div>
        <div className="typeset-slide-canvas-actions" aria-label={copy.canvasControlsLabel}>
          <button
            type="button"
            className="zoom-step"
            title={copy.zoomOut}
            aria-label={copy.zoomOutSlide}
            onClick={() => changeZoom(-0.1)}
          >
            <ToolIcon name="minus" />
          </button>
          <button
            type="button"
            className={fitMode ? "active fit" : "fit"}
            title={copy.fitToCanvas}
            aria-label={copy.fitToCanvas}
            aria-pressed={fitMode}
            onClick={() => {
              setFitMode(true);
              void fitSlide();
            }}
          >
            {copy.fit} <span>{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            className="zoom-step"
            title={copy.zoomIn}
            aria-label={copy.zoomInSlide}
            onClick={() => changeZoom(0.1)}
          >
            <ToolIcon name="plus" />
          </button>
          <span className="typeset-slide-canvas-divider" />
          <button
            type="button"
            className="add-text"
            title={copy.addTextObjectTitle}
            aria-label={copy.addTextObjectLabel}
            disabled={compiling}
            onClick={addTextObject}
          >
            <ToolIcon name="plus" />
            {copy.addText}
          </button>
          {focused && (
            <button
              type="button"
              className={deckOpen ? "active deck" : "deck"}
              title={deckOpen ? copy.hideSlideList : copy.showSlideList}
              aria-label={deckOpen ? copy.hideSlideList : copy.showSlideList}
              aria-pressed={deckOpen}
              onClick={() => setDeckOpen((open) => !open)}
            >
              <ToolIcon name="list" />
              {copy.slides}
            </button>
          )}
          <button
            type="button"
            className={focused ? "active focus" : "focus"}
            title={focused ? copy.restorePanelsTitle : copy.focusSlideTitle}
            aria-label={focused ? copy.exitSlideFocus : copy.focusSlideCanvas}
            aria-pressed={focused}
            onClick={onToggleFocus}
          >
            <ToolIcon name="visual" />
            {focused ? copy.exitFocus : copy.focus}
          </button>
          <button
            type="button"
            className={sourceOpen ? "active source" : "source"}
            aria-label={sourceOpen ? copy.closeSlideSource : copy.editSlideSourceLabel}
            aria-pressed={sourceOpen}
            onClick={() => setSourceOpen((open) => !open)}
          >
            <ToolIcon name="code" />
            {sourceOpen ? copy.closeSource : copy.editSource}
          </button>
        </div>
      </div>
      <div className={`typeset-slide-workspace${focused && deckOpen ? " deck-open" : ""}${sourceOpen ? " source-open" : ""}`}>
        {focused && deckOpen && (
          <nav className="typeset-slide-deck" aria-label={copy.slideDeckLabel}>
            <header>
              <div>
                <span>{copy.presentation}</span>
                <strong>{copy.slidesCount(slides.length)}</strong>
              </div>
              <span className={dirty ? "stale" : "current"}>{dirty ? copy.draft : copy.synced}</span>
            </header>
            <div className="typeset-slide-deck-list">
              {slides.map((item, index) => {
                const active = index === activeSlideIndex;
                return (
                  <button
                    type="button"
                    key={`${item.line}:${item.title}`}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                    aria-label={copy.openSlideLabel(index + 1, item.title)}
                    onClick={() => onNavigateToLine(item.line)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.title || copy.slideFallback(index + 1)}</strong>
                    {active && <i aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </nav>
        )}
        <div className="typeset-compiled-visual-scroll" ref={scrollRef}>
          {!path && <div className="typeset-empty">{copy.compileToOpenCanvas}</div>}
          {path && loading && <div className="typeset-empty">{copy.loadingCompiledSlide}</div>}
          {path && error && <PdfFallbackPage error={error} outputPath={path} sourcePath={null} />}
          {pdf && !error && (
            <div
              className="typeset-slide-stage"
              role="group"
              tabIndex={0}
              aria-label={copy.slideStageLabel(safePage)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  navigateSlide(-1);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  navigateSlide(1);
                }
              }}
            >
              <PdfPage
                key={`${path}:${refreshKey}:${safePage}`}
                pdf={pdf}
                page={safePage}
                zoom={zoom}
                onSourceTextClick={openSourceForText}
                editable
                onTextObjectEdit={editTextObject}
                onTextObjectMove={moveTextObject}
                onPageSize={(width, height) => setPageNaturalSize({ width, height })}
              />
              <span className="typeset-slide-click-hint">{copy.slideClickHint}</span>
            </div>
          )}
        </div>
        {sourceOpen && (
          <aside className="typeset-slide-source-drawer" aria-label={copy.currentSlideSourceLabel}>
            <header>
              <div>
                <span>{copy.currentFrame}</span>
                <strong>{slide?.title || copy.slideFallback(safePage)}</strong>
              </div>
              <button
                type="button"
                title={copy.openFullEditorTitle}
                onClick={() => selectedSourceRange
                  ? onOpenCodeRange(selectedSourceRange.start, selectedSourceRange.end)
                  : onOpenCodeAtLine(slide?.line ?? 1)}
              >
                {copy.fullEditor}
              </button>
            </header>
            <textarea
              ref={sourceEditorRef}
              value={frameSource}
              aria-label={copy.slideSourceAriaLabel}
                aria-keyshortcuts="Control+S Meta+S Escape"
              spellCheck={false}
              onChange={(event) => changeFrameSource(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSourceOpen(false);
                  return;
                }
              }}
            />
            <footer>
              <span>
                {copy.linesInfo(slide?.line ?? 1, slide?.endLine ?? 1, frameLineCount, frameSource.length)}
                <kbd>Ctrl S</kbd>
              </span>
              <button type="button" disabled={!dirty || compiling} onClick={onSave}>
                <ToolIcon name="save" />
                {compiling ? copy.compiling : dirty ? copy.saveUpdatePreview : copy.previewCurrent}
              </button>
            </footer>
          </aside>
        )}
      </div>
    </section>
  );
}

function PdfFallbackPage({ error, outputPath, sourcePath }: { error: string; outputPath: string | null; sourcePath: string | null }) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfFallback;
  return (
    <div className="typeset-pdf-unavailable" role="status" aria-label={copy.unavailableLabel}>
      <ToolIcon name="logs" />
      <strong>{copy.unavailableLabel}</strong>
      <span>{outputPath || outputPathFor(sourcePath || DEFAULT_SOURCE_PATH)}</span>
      <p>{copy.recompileHint}</p>
      <code>{error}</code>
    </div>
  );
}

function TypesetPdfPreview({
  path,
  sourcePath,
  refreshKey,
  status,
  result,
  dirty,
  disabled,
  logOpen,
  diagnosticsCount,
  continueOnError,
  canCancel,
  onCompile,
  onCancelCompile,
  onClearCacheCompile,
  onSetContinueOnError,
  onToggleLog,
  onSourceTextClick,
  onHide,
  forwardTarget,
  forwardSearchNotice,
}: PdfPreviewProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].pdfPreview;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoomDraft, setZoomDraft] = useState("100");
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [renderRange, setRenderRange] = useState({ start: 1, end: 3 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compileMenuOpen, setCompileMenuOpen] = useState(false);
  const [compileMenuPosition, setCompileMenuPosition] = useState({ top: 0, right: 8 });
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [zoomMenuPosition, setZoomMenuPosition] = useState({ top: 0, right: 8 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const compileMenuRef = useRef<HTMLDivElement | null>(null);
  const compileMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const zoomMenuRef = useRef<HTMLButtonElement | null>(null);
  const zoomMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const pageInputFocusedRef = useRef(false);
  const userZoomedRef = useRef(false);
  const currentPageRef = useRef(currentPage);
  const loadedPdfPathRef = useRef<string | null>(null);
  const lastPageByPathRef = useRef(new Map<string, number>());
  const zoomRef = useRef(zoom);
  const pendingWheelZoomRef = useRef<number | null>(null);
  const wheelZoomTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef(0);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const registerPageRef = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageElementsRef.current.set(page, el);
    else pageElementsRef.current.delete(page);
  }, []);
  const recordPageSize = useCallback((page: number, width: number, height: number) => {
    setPageSizes((sizes) => {
      const current = sizes[page];
      if (current && Math.abs(current.width - width) < 0.1 && Math.abs(current.height - height) < 0.1) {
        return sizes;
      }
      return { ...sizes, [page]: { width, height } };
    });
  }, []);
  const showPagesAround = useCallback((page: number) => {
    const radius = zoom >= 2 ? 0 : zoom >= 1.1 ? 1 : 2;
    setRenderRange((range) => {
      const next = {
        start: Math.max(1, page - radius),
        end: Math.min(Math.max(1, numPages), page + radius),
      };
      return range.start === next.start && range.end === next.end ? range : next;
    });
  }, [numPages, zoom]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    // A zoom change can make the existing render window unnecessarily large.
    // Do not subscribe to currentPage here: scroll updates calculate the full
    // visible range separately, and must not be overwritten with a smaller
    // current-page window after their render range commits.
    showPagesAround(currentPageRef.current);
  }, [showPagesAround]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => () => {
    if (wheelZoomTimerRef.current !== null) window.clearTimeout(wheelZoomTimerRef.current);
  }, []);

  useEffect(() => {
    if (!compileMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !compileMenuRef.current?.contains(target)
        && !compileMenuPopoverRef.current?.contains(target)
      ) {
        setCompileMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compileMenuOpen]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!zoomMenuRef.current?.contains(target) && !zoomMenuPopoverRef.current?.contains(target)) {
        setZoomMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    let disposed = false;
    let loadedPdf: PDFDocumentProxy | null = null;
    const previousPath = loadedPdfPathRef.current;
    if (previousPath) lastPageByPathRef.current.set(previousPath, currentPageRef.current);
    const samePdfPath = previousPath === path;
    const restoredPage = path ? lastPageByPathRef.current.get(path) ?? 1 : 1;
    loadedPdfPathRef.current = path;
    // A recompile keeps the same path. Preserve its reader position and any
    // explicit zoom choice; a different PDF starts with fit-to-width again.
    if (!samePdfPath) userZoomedRef.current = false;
    setPdf(null);
    setNumPages(0);
    setPageSizes({});
    setRenderRange({ start: Math.max(1, restoredPage - 2), end: restoredPage + 2 });
    setCurrentPage(restoredPage);
    setPageDraft(String(restoredPage));
    setError(null);
    if (!path) return () => undefined;
    setLoading(true);
    void fileReadBytes(path)
      .then((bytes) => openPdfDocument(bytes))
      .then((document) => {
        loadedPdf = document;
        if (disposed) {
          void document.destroy();
          return;
        }
        setPdf(document);
        setNumPages(document.numPages);
        const page = clampNumber(restoredPage, 1, Math.max(1, document.numPages));
        currentPageRef.current = page;
        lastPageByPathRef.current.set(path, page);
        setCurrentPage(page);
        setPageDraft(String(page));
        setRenderRange({ start: Math.max(1, page - 2), end: Math.min(document.numPages, page + 2) });
      })
      .catch((loadError) => {
        if (!disposed) setError(String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      if (loadedPdf) void loadedPdf.destroy();
    };
  }, [path, refreshKey]);

  useEffect(() => {
    if (!pdf || numPages < 1) return;
    let disposed = false;
    const missingPages: number[] = [];
    for (let page = renderRange.start; page <= renderRange.end; page += 1) {
      if (!pageSizes[page]) missingPages.push(page);
    }
    if (missingPages.length === 0) return () => { disposed = true; };
    void Promise.all(missingPages.map(async (page) => {
      const pdfPage = await pdf.getPage(page);
      const viewport = pdfPage.getViewport({ scale: 1 });
      return [page, { width: viewport.width, height: viewport.height }] as const;
    })).then((sizes) => {
      if (disposed) return;
      setPageSizes((current) => {
        const next = { ...current };
        for (const [page, size] of sizes) next[page] = size;
        return next;
      });
    }).catch(() => {
      // Mounted pages still report their own dimensions if metadata lookup fails.
    });
    return () => {
      disposed = true;
    };
  }, [numPages, pageSizes, pdf, renderRange.end, renderRange.start]);

  useEffect(() => {
    if (!pdf || typeof window === "undefined") return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    const fitToWidth = async () => {
      const scroll = scrollRef.current;
      if (!scroll || userZoomedRef.current) return;
      try {
        const firstPage = await pdf.getPage(1);
        if (disposed || userZoomedRef.current) return;
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const availableWidth = Math.max(180, scroll.clientWidth - 36);
        setZoom(clampNumber(availableWidth / baseViewport.width, 0.7, 2.2));
      } catch {
        if (!disposed && !userZoomedRef.current) setZoom(1);
      }
    };

    void fitToWidth();
    if (typeof ResizeObserver !== "undefined" && scrollRef.current) {
      resizeObserver = new ResizeObserver(() => {
        void fitToWidth();
      });
      resizeObserver.observe(scrollRef.current);
    }
    window.addEventListener("resize", fitToWidth);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fitToWidth);
    };
  }, [pdf]);

  const updateVisiblePages = useCallback(() => {
    const scroll = scrollRef.current;
    if (!pdf || !scroll || numPages < 1) return;
    // Track the page at the reading edge, rather than the viewport center.
    // A short landscape PDF can show two pages at once; center tracking would
    // report the following page immediately after jumping to the current one.
    const viewportAnchor = scroll.scrollTop + Math.min(48, scroll.clientHeight / 4);
    const viewportHeight = scroll.clientHeight;
    const overscan = viewportHeight * 0.75;
    const renderTop = Math.max(0, scroll.scrollTop - overscan);
    const renderBottom = scroll.scrollTop + viewportHeight + overscan;
    const pageAtOffset = (offset: number) => {
      let low = 1;
      let high = numPages;
      let match = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const element = pageElementsRef.current.get(middle);
        if (!element) break;
        const top = element.offsetTop;
        const bottom = top + element.offsetHeight;
        match = middle;
        if (offset < top) high = middle - 1;
        else if (offset > bottom) low = middle + 1;
        else return middle;
      }
      return clampNumber(match, 1, numPages);
    };
    const nextPage = pageAtOffset(viewportAnchor);
    const visibleStart = pageAtOffset(renderTop);
    const visibleEnd = pageAtOffset(renderBottom);
    setCurrentPage((page) => page === nextPage ? page : nextPage);
    if (viewportHeight > 0 && visibleEnd > 0) {
      const radius = zoom >= 2 ? 0 : zoom >= 1.1 ? 1 : 2;
      const nextRange = {
        // The viewport can show several short/landscape pages at once. Use
        // its full measured range as the source of truth, then preload the
        // immediate neighbors so a page never remains a white placeholder
        // until the preceding page has completely scrolled away.
        start: Math.max(1, visibleStart - radius),
        end: Math.min(numPages, visibleEnd + radius),
      };
      setRenderRange((range) => (
        range.start === nextRange.start && range.end === nextRange.end ? range : nextRange
      ));
    }
  }, [numPages, pdf, zoom]);

  const scheduleVisiblePagesUpdate = useCallback(() => {
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      updateVisiblePages();
    });
  }, [updateVisiblePages]);

  useEffect(() => {
    if (!pdf || numPages < 1) return;
    // Recalculate after document and zoom updates. User scrolling is handled
    // by the scroll surface itself so the first scroll event is never missed
    // while React is committing a preview update.
    if ((scrollRef.current?.clientHeight ?? 0) > 0) scheduleVisiblePagesUpdate();
    return () => {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = 0;
    };
  }, [numPages, pdf, scheduleVisiblePagesUpdate]);

  useEffect(() => {
    if (!pageInputFocusedRef.current) setPageDraft(String(currentPage));
  }, [currentPage]);

  // Forward search: scroll the compiled PDF to the page/point SyncTeX
  // resolved for the last double-click in the source editor. Runs after the
  // target page has had a chance to mount/register its ref (double rAF: one
  // for this render's DOM commit, one for the page's own render effect).
  useEffect(() => {
    if (!forwardTarget) return;
    showPagesAround(forwardTarget.location.page);
    let frame1 = 0;
    let frame2 = 0;
    frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        const pageEl = pageElementsRef.current.get(forwardTarget.location.page);
        const scroll = scrollRef.current;
        if (!pageEl || !scroll) return;
        const targetTop = pageEl.offsetTop + forwardTarget.location.pointY * zoom - scroll.clientHeight / 2;
        if (typeof scroll.scrollTo === "function") {
          scroll.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        } else {
          scroll.scrollTop = Math.max(0, targetTop);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [forwardTarget, showPagesAround, zoom]);

  const setZoomLevel = (value: number, closeMenu = true) => {
    const nextZoom = clampNumber(value, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    userZoomedRef.current = true;
    zoomRef.current = nextZoom;
    pendingWheelZoomRef.current = null;
    if (wheelZoomTimerRef.current !== null) {
      window.clearTimeout(wheelZoomTimerRef.current);
      wheelZoomTimerRef.current = null;
    }
    setZoom(nextZoom);
    if (closeMenu) setZoomMenuOpen(false);
  };
  const fitPdf = async (mode: "height" | "width") => {
    const scroll = scrollRef.current;
    if (!pdf || !scroll) return;
    try {
      const page = await pdf.getPage(clampNumber(currentPage, 1, Math.max(1, numPages)));
      const viewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(100, scroll.clientWidth - 32);
      const availableHeight = Math.max(100, scroll.clientHeight - 32);
      const nextZoom = mode === "width" ? availableWidth / viewport.width : availableHeight / viewport.height;
      setZoomLevel(nextZoom);
    } catch {
      setZoomMenuOpen(false);
    }
  };
  const applyZoomDraft = () => {
    const percentage = Number.parseFloat(zoomDraft.replace("%", ""));
    if (!Number.isFinite(percentage)) {
      setZoomDraft(String(Math.round(zoom * 100)));
      return;
    }
    setZoomLevel(percentage / 100);
  };
  const handlePdfWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const delta = clampNumber(-deltaY * 0.001, -0.14, 0.14);
    const currentTarget = pendingWheelZoomRef.current ?? zoomRef.current;
    pendingWheelZoomRef.current = clampNumber(currentTarget + delta, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    if (wheelZoomTimerRef.current !== null) window.clearTimeout(wheelZoomTimerRef.current);
    wheelZoomTimerRef.current = window.setTimeout(() => {
      wheelZoomTimerRef.current = null;
      const nextZoom = pendingWheelZoomRef.current;
      pendingWheelZoomRef.current = null;
      if (nextZoom !== null) setZoomLevel(nextZoom, false);
    }, PDF_WHEEL_ZOOM_SETTLE_MS);
  };
  const scrollToPage = useCallback((page: number, behavior: ScrollBehavior = "auto") => {
    const nextPage = clampNumber(Math.round(page), 1, Math.max(1, numPages));
    showPagesAround(nextPage);
    const pageEl = pageElementsRef.current.get(nextPage);
    const scroll = scrollRef.current;
    setCurrentPage(nextPage);
    setPageDraft(String(nextPage));
    if (!pageEl || !scroll) return;
    const top = Math.max(0, pageEl.offsetTop - 12);
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top, behavior });
    else scroll.scrollTop = top;
  }, [numPages, showPagesAround]);
  const commitPageDraft = () => {
    const requestedPage = Number.parseInt(pageDraft, 10);
    if (!Number.isFinite(requestedPage)) {
      setPageDraft(String(currentPage));
      return;
    }
    scrollToPage(requestedPage);
  };

  useEffect(() => {
    if (numPages < 2 || logOpen || compileMenuOpen || zoomMenuOpen) return;
    const onPageNavigationKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")
      ) {
        return;
      }
      event.preventDefault();
      scrollToPage(currentPage + (event.key === "ArrowRight" ? 1 : -1), "smooth");
    };
    window.addEventListener("keydown", onPageNavigationKey);
    return () => window.removeEventListener("keydown", onPageNavigationKey);
  }, [compileMenuOpen, currentPage, logOpen, numPages, scrollToPage, zoomMenuOpen]);

  const statusText = dirty ? copy.unsavedChanges : compileStatusText(status, result, language);

  return (
    <section
      className={`typeset-preview pdf${!path ? " pdf-empty" : ""}`}
      aria-label={copy.pdfPreviewLabel}
      aria-keyshortcuts="ArrowLeft ArrowRight"
    >
      <div className="typeset-preview-toolbar toolbar toolbar-pdf toolbar-pdf-hybrid">
        <div className="typeset-pdf-left toolbar-pdf-left">
          <span className="typeset-pdf-panel-label">{copy.compiledPdfLabel}</span>
          <div
            ref={compileMenuRef}
            className={`typeset-compile-button-group compile-button-group${dirty ? " has-changes" : ""}`}
          >
            <button
              type="button"
              className={`typeset-recompile-btn compile-button ${status}${dirty ? " btn-striped-animated" : ""}`}
              disabled={status === "running" ? !canCancel : disabled}
              onClick={status === "running" ? onCancelCompile : onCompile}
            >
              <ToolIcon name={status === "running" ? "clear" : "compile"} />
              <span className="typeset-recompile-label">
                {status === "running" ? copy.stopCompilation : copy.recompile}
              </span>
            </button>
            <button
              type="button"
              className="typeset-compile-options compile-dropdown-toggle"
              title={copy.compileOptions}
              aria-label={copy.compileOptions}
              aria-haspopup="menu"
              aria-expanded={compileMenuOpen}
              disabled={disabled}
              onClick={(event) => {
                if (compileMenuOpen) {
                  setCompileMenuOpen(false);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setCompileMenuPosition({
                  top: rect.bottom + 7,
                  right: Math.max(8, window.innerWidth - rect.right),
                });
                setCompileMenuOpen(true);
              }}
            >
              <ToolIcon name="chevron" className="typeset-compile-chevron" />
            </button>
            {compileMenuOpen && typeof document !== "undefined" && createPortal(
              <div
                ref={compileMenuPopoverRef}
                className="typeset-compile-menu"
                role="menu"
                aria-label={copy.compileOptionsMenu}
                style={compileMenuPosition}
              >
                <div className="typeset-compile-menu-section" role="presentation">
                  <span>{copy.compileErrorHandling}</span>
                </div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!continueOnError}
                  onClick={() => {
                    onSetContinueOnError(false);
                    setCompileMenuOpen(false);
                  }}
                >
                  <span>
                    <strong>{copy.stopOnFirstError}</strong>
                    <small>{copy.stopOnFirstErrorDesc}</small>
                  </span>
                  {!continueOnError && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={continueOnError}
                  onClick={() => {
                    onSetContinueOnError(true);
                    setCompileMenuOpen(false);
                  }}
                >
                  <span>
                    <strong>{copy.tryDespiteErrors}</strong>
                    <small>{copy.tryDespiteErrorsDesc}</small>
                  </span>
                  {continueOnError && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
                <div className="typeset-compile-menu-divider" role="presentation" />
                {status === "running" && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canCancel}
                    onClick={() => {
                      setCompileMenuOpen(false);
                      onCancelCompile();
                    }}
                  >
                    <ToolIcon name="clear" />
                    <span>
                      <strong>{copy.stopCompilation}</strong>
                      <small>{copy.stopCompilationDesc}</small>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={status === "running"}
                  onClick={() => {
                    setCompileMenuOpen(false);
                    onClearCacheCompile();
                  }}
                >
                  <ToolIcon name="clear" />
                  <span>
                    <strong>{copy.clearCacheRecompile}</strong>
                    <small>{copy.clearCacheRecompileDesc}</small>
                  </span>
                </button>
              </div>,
              document.body,
            )}
          </div>
          <button
            type="button"
            className={`typeset-log-toggle pdf-toolbar-btn log-btn${logOpen ? " active" : ""}`}
            title={copy.compileLog}
            aria-label={copy.compileLog}
            onClick={onToggleLog}
          >
            <ToolIcon name="logs" />
            {diagnosticsCount > 0 && <span>{diagnosticsCount}</span>}
          </button>
          {statusText && <span className={`typeset-pdf-status ${status}`}>{statusText}</span>}
          {result?.pdfState === "stale" && (
            <span className="typeset-pdf-status stale" role="status">{copy.showingLastVerified}</span>
          )}
          {result?.pdfState === "missing" && (
            <span className="typeset-pdf-status error" role="status">{copy.noPdfProduced}</span>
          )}
          {forwardSearchNotice && <span className="typeset-pdf-status error" role="status">{forwardSearchNotice}</span>}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : copy.preview}</span>
          <div className="typeset-pdf-page-control" aria-label={copy.pdfPageNavigationLabel}>
            <input
              type="text"
              inputMode="numeric"
              value={pageDraft}
              aria-label={copy.currentPdfPage}
              disabled={numPages < 1}
              onFocus={(event) => {
                pageInputFocusedRef.current = true;
                event.currentTarget.select();
              }}
              onChange={(event) => setPageDraft(event.currentTarget.value.replace(/[^0-9]/g, ""))}
              onBlur={() => {
                pageInputFocusedRef.current = false;
                commitPageDraft();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPageDraft();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setPageDraft(String(currentPage));
                  event.currentTarget.blur();
                }
              }}
            />
            <span aria-label={copy.pdfPagesLabel(numPages)}>/ {numPages || 0}</span>
          </div>
          <div className="toolbar-pdf-controls pdfjs-viewer-controls-small">
            <button
              ref={zoomMenuRef}
              type="button"
              className="typeset-zoom-label pdfjs-zoom-dropdown-button"
              title={copy.choosePdfZoom}
              aria-label={copy.pdfZoomLabel(Math.round(zoom * 100))}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              onClick={(event) => {
                if (zoomMenuOpen) {
                  setZoomMenuOpen(false);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setZoomDraft(String(Math.round(zoom * 100)));
                setZoomMenuPosition({
                  top: rect.bottom + 6,
                  right: Math.max(8, window.innerWidth - rect.right),
                });
                setZoomMenuOpen(true);
              }}
            >
              <span>{Math.round(zoom * 100)}%</span>
              <ToolIcon name="chevron" />
            </button>
          </div>
          {zoomMenuOpen && typeof document !== "undefined" && createPortal(
            <div
              ref={zoomMenuPopoverRef}
              className="typeset-zoom-menu"
              role="menu"
              aria-label={copy.pdfZoomMenu}
              style={zoomMenuPosition}
            >
              <form
                className="typeset-zoom-menu-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  applyZoomDraft();
                }}
              >
                <input
                  value={zoomDraft}
                  inputMode="decimal"
                  aria-label={copy.pdfZoomPercentage}
                  onChange={(event) => setZoomDraft(event.currentTarget.value.replace(/[^0-9.]/g, ""))}
                />
                <span>%</span>
              </form>
              <button type="button" role="menuitem" onClick={() => void fitPdf("width")}>{copy.fitToWidth}</button>
              <button type="button" role="menuitem" onClick={() => void fitPdf("height")}>{copy.fitToHeight}</button>
              <div className="typeset-zoom-menu-divider" role="presentation" />
              {PDF_ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  role="menuitemradio"
                  aria-checked={Math.round(zoom * 100) === Math.round(preset * 100)}
                  onClick={() => setZoomLevel(preset)}
                >
                  <span>{Math.round(preset * 100)}%</span>
                  {Math.round(zoom * 100) === Math.round(preset * 100) && <b aria-hidden="true"><SvgIcon name="check" size={14} /></b>}
                </button>
              ))}
            </div>,
            document.body,
          )}
          <button type="button" className="typeset-icon-btn pdf-open-external" title={copy.openPdfExternally} aria-label={copy.openPdfExternally} disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          {onHide && (
            <button type="button" className="typeset-icon-btn pdf-hide-preview" title={copy.hidePdfPreview} aria-label={copy.hidePdfPreview} onClick={onHide}>
              <ToolIcon name="next" />
            </button>
          )}
        </div>
      </div>
      <div
        className="typeset-pdf-scroll"
        ref={scrollRef}
        onScroll={scheduleVisiblePagesUpdate}
        onWheel={handlePdfWheel}
      >
        {!path && <div className="typeset-empty">{copy.noPdfSelected}</div>}
        {path && loading && <div className="typeset-empty">{copy.loadingPdf}</div>}
        {path && error ? (
          <PdfFallbackPage error={error} outputPath={path} sourcePath={sourcePath} />
        ) : (
          null
        )}
        {pdf && !error && Array.from({ length: numPages }, (_, index) => {
          const page = index + 1;
          const estimatedSize = pageSizes[page] ?? pageSizes[1] ?? { width: 612, height: 792 };
          if (page < renderRange.start || page > renderRange.end) {
            return (
              <div
                key={`${path}:${refreshKey}:${page}`}
                className="typeset-pdf-page typeset-pdf-page-placeholder"
                ref={(element) => registerPageRef(page, element)}
                style={{ width: `${estimatedSize.width * zoom}px`, height: `${estimatedSize.height * zoom}px` }}
                aria-label={copy.pdfPagePlaceholderLabel(page)}
              />
            );
          }
          const highlight = forwardTarget && forwardTarget.location.page === page
            ? {
                left: forwardTarget.location.boxLeft * zoom,
                top: forwardTarget.location.boxTop * zoom,
                width: forwardTarget.location.boxWidth * zoom,
                height: forwardTarget.location.boxHeight * zoom,
                nonce: forwardTarget.nonce,
              }
            : null;
          return (
            <PdfPage
              key={`${path}:${refreshKey}:${page}`}
              pdf={pdf}
              page={page}
              zoom={zoom}
              estimatedSize={estimatedSize}
              onSourceTextClick={onSourceTextClick}
              onPageSize={(width, height) => recordPageSize(page, width, height)}
              pageRef={registerPageRef}
              highlight={highlight}
            />
          );
        })}
      </div>
    </section>
  );
}

function CompileLog({
  result,
  status,
  error,
  liveLog,
  onDiagnosticClick,
  onClearCacheCompile,
  disabled = false,
}: {
  result: CompileResult | null;
  status: CompileStatus;
  error: string | null;
  liveLog: CompileLiveLog | null;
  onDiagnosticClick?: (diagnostic: LatexDiagnostic) => void;
  onClearCacheCompile?: () => void;
  disabled?: boolean;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].compileLog;
  const text = status === "running"
    ? [error, liveLog?.stderr, liveLog?.stdout].filter(Boolean).join("\n\n").trim()
    : [error, result?.stderr, result?.stdout].filter(Boolean).join("\n\n").trim();
  const pdfState = result?.pdfState ?? (result?.success ? "fresh" : result?.partialOutput ? "partial" : "missing");
  const sourceHash = result?.rootSourceHash ?? "";
  const buildTime = result?.compiledAtUnixMs ? new Date(result.compiledAtUnixMs).toLocaleTimeString() : copy.notRecorded;
  const diagnostics = useMemo(() => (result?.diagnostics ?? []).map((diagnostic, index) => {
    const level: CompileLogLevel = diagnostic.severity === "warning" && /(?:over|under)full\s+\\?hbox/i.test(diagnostic.message)
      ? "info"
      : diagnostic.severity === "error" || diagnostic.severity === "warning"
        ? diagnostic.severity
        : "info";
    return {
      diagnostic,
      id: `${diagnostic.code}-${diagnostic.filePath ?? "root"}-${diagnostic.line ?? index}-${index}`,
      level,
    };
  }), [result?.diagnostics]);
  const [filter, setFilter] = useState<CompileLogFilter>("all");
  const filteredDiagnostics = filter === "all"
    ? diagnostics
    : diagnostics.filter((entry) => entry.level === filter);
  const diagnosticSignature = diagnostics.map((entry) => entry.id).join("|");
  const [expandedDiagnosticId, setExpandedDiagnosticId] = useState<string | null>(null);

  useEffect(() => {
    setExpandedDiagnosticId(filteredDiagnostics[0]?.id ?? null);
  }, [filter, diagnosticSignature]);

  const counts = diagnostics.reduce<Record<CompileLogLevel, number>>(
    (current, entry) => ({ ...current, [entry.level]: current[entry.level] + 1 }),
    { error: 0, warning: 0, info: 0 },
  );
  const filters: Array<{ id: CompileLogFilter; label: string; count: number }> = [
    { id: "all", label: copy.allLogs, count: diagnostics.length },
    { id: "error", label: copy.errors, count: counts.error },
    { id: "warning", label: copy.warnings, count: counts.warning },
    { id: "info", label: copy.info, count: counts.info },
  ];

  const diagnosticLocation = (diagnostic: LatexDiagnostic) => diagnostic.filePath
    ? `${diagnostic.filePath}${diagnostic.line ? `, ${diagnostic.line}` : ""}`
    : diagnostic.line ? copy.lineLabel(diagnostic.line) : copy.noSourceLocation;
  const canOpenDiagnostic = (diagnostic: LatexDiagnostic) => Boolean(
    onDiagnosticClick && (diagnostic.filePath || diagnostic.line),
  );
  const diagnosticGuidance = (diagnostic: LatexDiagnostic) => {
    if (diagnostic.code === "table_alignment") {
      return copy.tableAlignmentGuidance;
    }
    if (/citation .*undefined/i.test(diagnostic.message)) {
      return copy.undefinedCitationGuidance;
    }
    return diagnostic.severity === "error"
      ? copy.errorGuidance
      : copy.warningGuidance;
  };
  const diagnosticExcerpt = (diagnostic: LatexDiagnostic) => {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return copy.noExcerptCaptured;
    const message = diagnostic.message.toLocaleLowerCase();
    const match = lines.findIndex((line) => line.toLocaleLowerCase().includes(message));
    const start = match < 0 ? 0 : Math.max(0, match - 1);
    return lines.slice(start, start + 9).join("\n");
  };

  return (
    <section className={`typeset-log new-logs-pane ${status === "error" ? "error" : ""}`} aria-label={copy.compileLogLabel}>
      <div className="typeset-log-tabs" role="tablist" aria-label={copy.compileLogFiltersLabel}>
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? "active" : ""}
            onClick={() => setFilter(item.id)}
          >
            <span>{item.label}</span>
            <b>{item.count}</b>
          </button>
        ))}
      </div>
      <div className="logs-pane-content">
        {filteredDiagnostics.length > 0 && (
          <div className="typeset-diagnostics typeset-diagnostics-accordion" aria-label={copy.latexDiagnosticsLabel}>
            {filteredDiagnostics.map(({ diagnostic, id, level }) => {
              const expanded = expandedDiagnosticId === id;
              const openable = canOpenDiagnostic(diagnostic);
              return (
                <article key={id} className={`typeset-diagnostic-card ${level} ${expanded ? "expanded" : ""}`}>
                  <div className="typeset-diagnostic-summary">
                    <button
                      type="button"
                      className="typeset-diagnostic-expand"
                      aria-label={copy.expandCollapseLabel(expanded, diagnostic.message)}
                      aria-expanded={expanded}
                      onClick={() => setExpandedDiagnosticId((current) => current === id ? null : id)}
                    >
                      <ToolIcon name="chevron" />
                    </button>
                    <div className="typeset-diagnostic-copy">
                      <button
                        type="button"
                        className="typeset-diagnostic-title"
                        disabled={!openable}
                        onClick={() => onDiagnosticClick?.(diagnostic)}
                      >
                        {diagnostic.message}
                      </button>
                      <button
                        type="button"
                        className="typeset-diagnostic-location"
                        disabled={!openable}
                        onClick={() => onDiagnosticClick?.(diagnostic)}
                      >
                        {diagnosticLocation(diagnostic)}
                      </button>
                    </div>
                    {openable && (
                      <button
                        type="button"
                        className="typeset-diagnostic-locate"
                        aria-label={copy.openLabel(diagnosticLocation(diagnostic))}
                        title={copy.openSourceLocation}
                        onClick={() => onDiagnosticClick?.(diagnostic)}
                      >
                        <ToolIcon name="ref" />
                      </button>
                    )}
                    {level === "error" && <span className="typeset-diagnostic-sparkle" aria-hidden="true"><SvgIcon name="sparkle" size={14} /></span>}
                  </div>
                  {expanded && (
                    <div className="typeset-diagnostic-details">
                      <p>{diagnosticGuidance(diagnostic)}</p>
                      <pre>{diagnosticExcerpt(diagnostic)}</pre>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {!filteredDiagnostics.length && (
          <div className="typeset-log-empty" role="status">
            {diagnostics.length ? copy.noLogsMatchFilter : status === "running" ? copy.waitingForOutput : copy.noDiagnostics}
          </div>
        )}
        <details className="typeset-raw-logs">
          <summary>
            <ToolIcon name="chevron" />
            <span>{copy.rawLogs}</span>
          </summary>
          <pre>{text || (status === "running" ? copy.waitingForOutput : copy.noOutputCaptured)}</pre>
        </details>
      </div>
      <footer className="typeset-log-footer">
        {onClearCacheCompile && (
          <button
            type="button"
            className="typeset-log-clear-cache"
            disabled={disabled || status === "running"}
            onClick={onClearCacheCompile}
          >
            <ToolIcon name="clear" />
            <span>{copy.clearCachedFiles}</span>
          </button>
        )}
        <details className="typeset-log-build-details">
          <summary>
            <span>{copy.otherLogsAndFiles}</span>
            <ToolIcon name="chevron" />
          </summary>
          <div className="typeset-build-provenance" aria-label={copy.pdfBuildProvenanceLabel}>
            <span>{copy.pdfState(pdfState)}</span>
            <span>{copy.built(buildTime)}</span>
            <code title={sourceHash}>{copy.inputsHash(sourceHash.slice(0, 12) || copy.unavailable)}</code>
          </div>
        </details>
      </footer>
    </section>
  );
}

/**
 * Figure preview for the right-hand panel. A `\includegraphics` target opened
 * from the file tree is an image, not a PDF, so it takes over the preview slot
 * with image-appropriate controls and a way back to the compiled document.
 */
function TypesetImagePreview({
  path,
  refreshKey,
  onBackToPdf,
  onHide,
}: {
  path: string | null;
  refreshKey: number;
  onBackToPdf?: () => void;
  onHide: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].imagePreview;
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      setSize(null);
      setError(null);
      return;
    }
    let disposed = false;
    let objectUrl: string | null = null;
    setError(null);
    setSrc(null);
    setSize(null);
    void fileReadBytes(path)
      .then((bytes) => {
        if (disposed) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: imageMimeFor(path) });
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((readError) => {
        if (!disposed) setError(String(readError));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, refreshKey]);

  // `null` zoom means fit-to-panel, which is what an unscaled figure wants.
  const scaled = size && zoom ? { width: size.width * zoom, height: size.height * zoom } : null;

  return (
    <section className="typeset-preview image" aria-label={copy.previewLabel}>
      <div className="typeset-preview-toolbar typeset-image-toolbar toolbar toolbar-pdf">
        <div className="typeset-preview-actions">
          <button type="button" className="typeset-image-zoom" title={copy.zoomOut} aria-label={copy.zoomOut} onClick={() => setZoom((value) => clampNumber((value ?? 1) - 0.25, PDF_ZOOM_MIN, PDF_ZOOM_MAX))}>
            <ToolIcon name="minus" />
          </button>
          <button type="button" className="typeset-image-zoom" title={copy.actualSize} onClick={() => setZoom(1)}>100%</button>
          <button type="button" className="typeset-image-zoom" title={copy.zoomIn} aria-label={copy.zoomIn} onClick={() => setZoom((value) => clampNumber((value ?? 1) + 0.25, PDF_ZOOM_MIN, PDF_ZOOM_MAX))}>
            <ToolIcon name="plus" />
          </button>
          <button
            type="button"
            className={`typeset-image-fit${zoom == null ? " active" : ""}`}
            title={copy.fitToWindow}
            onClick={() => setZoom(null)}
          >
            {copy.fit}
          </button>
          {size ? <span className="typeset-image-dimensions">{`${size.width} × ${size.height}`}</span> : null}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : copy.imageLabel}</span>
          {onBackToPdf ? (
            <button type="button" title={copy.backToPdf} aria-label={copy.backToPdf} onClick={onBackToPdf}>
              <ToolIcon name="previous" />
            </button>
          ) : null}
          <button type="button" title={copy.openExternally} aria-label={copy.openExternally} disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          <button type="button" title={copy.hidePreview} aria-label={copy.hidePreview} onClick={onHide}>
            <ToolIcon name="clear" />
          </button>
        </div>
      </div>
      <div className="typeset-image-scroll">
        <div className="typeset-image-stage">
          {src ? (
            <img
              src={src}
              alt={path ? basename(path) : copy.imageLabel}
              style={scaled
                ? { width: `${scaled.width}px`, height: `${scaled.height}px` }
                : { maxWidth: "100%", maxHeight: "100%" }}
              onLoad={(event) => setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              onError={() => setError(copy.decodeFailed)}
            />
          ) : (
            <span className="typeset-image-status">{error ? copy.unavailable : copy.loading}</span>
          )}
        </div>
      </div>
    </section>
  );
}

function imageMimeFor(path: string): string {
  switch (extension(path)) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".tif":
    case ".tiff": return "image/tiff";
    default: return "application/octet-stream";
  }
}


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

function visualSectionLevels(language: Language): Array<{ key: string; label: string }> {
  const copy = TYPESET_EDITOR_COPY[language].sectionLevels;
  return [
    { key: "text", label: copy.text },
    { key: "section", label: copy.section },
    { key: "subsection", label: copy.subsection },
    { key: "subsubsection", label: copy.subsubsection },
    { key: "paragraph", label: copy.paragraph },
    { key: "subparagraph", label: copy.subparagraph },
  ];
}

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

function TypesetEditorToolbar({
  activeOutlineItem,
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
  onSearch,
  onUndo,
  path,
  linkedPdfLine,
  citationPapers,
  onPrepareCitationKeys,
  onSynchronizeBibliography,
  saving,
}: {
  activeOutlineItem: NumberedOutlineItem | null;
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
  onSearch: (start: number, end: number) => void;
  onUndo: () => void;
  path: string | null;
  linkedPdfLine: number | null;
  citationPapers: LiteraturePaper[];
  onPrepareCitationKeys: (ids: string[]) => Promise<string[]>;
  onSynchronizeBibliography: () => Promise<void>;
  saving: boolean;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].toolbar;
  const sectionLevels = useMemo(() => visualSectionLevels(language), [language]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [citationPickerOpen, setCitationPickerOpen] = useState(false);
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
  const insertHref = () =>
    withSelection((adapter) => {
      const hasSelection = adapter.to > adapter.from;
      const linkText = hasSelection ? adapter.text.slice(adapter.from, adapter.to) : "link text";
      insertSnippetAtCursor(adapter, "\\href{", "https://example.com", `}{${linkText}}`);
    });
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
  const insertFigure = () =>
    withSelection((adapter) =>
      insertBlockAtCursor(
        adapter,
        "\\begin{figure}[h]\n\\centering\n\\includegraphics[width=.8\\linewidth]{figure.png}\n\\caption{Caption}\n\\end{figure}",
      ),
    );
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
      <div className="typeset-visual-filebar editor-tabs-container">
        <div className="typeset-visual-filetab editor-tab" role="tab" aria-selected="true">
          <FileIcon path={path || "untitled.tex"} />
          <strong>{path ? basename(path) : copy.untitled}</strong>
        </div>
        {slides.length > 0 ? (
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
        ) : (
          <div className="typeset-current-section" aria-live="polite" title={activeOutlineItem?.title ?? copy.noSectionSelected}>
            <ToolIcon name="list" />
            <span>{activeOutlineItem ? copy.sectionLabel(activeOutlineItem.number, activeOutlineItem.title) : copy.noSection}</span>
          </div>
        )}
        <div className="typeset-editor-context" aria-live="polite">
          {linkedPdfLine != null && <span className="typeset-sync-chip">{copy.pdfLineChip(linkedPdfLine)}</span>}
          {dirty && <span className="typeset-stale-chip">{copy.pdfNeedsRecompile}</span>}
          <span className="typeset-interaction-hint">
            {safeCompiledVisual
              ? copy.interactionHintSafeVisual
              : mode === "visual"
                ? copy.interactionHintVisual
                : copy.interactionHintCode}
          </span>
        </div>
        <div className="typeset-visual-mode-switch editor-switch" role="tablist" aria-label={copy.editorModeLabel}>
          <button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "active" : ""} onClick={() => onModeChange("code")}>{copy.code}</button>
          <button type="button" role="tab" aria-selected={mode === "visual"} className={mode === "visual" ? "active" : ""} onClick={() => onModeChange("visual")}>{copy.visual}</button>
        </div>
      </div>
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

function typesetLibraryPreferenceKey(projectPath: string | null): string {
  return `${TYPESET_LIBRARY_PREFERENCES_STORAGE_PREFIX}${projectPath || "default"}`;
}

function loadTypesetLibraryPreferences(projectPath: string | null): TypesetLibraryPreferences {
  if (typeof window === "undefined") return {};
  try {
    const value = window.localStorage.getItem(typesetLibraryPreferenceKey(projectPath));
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as TypesetLibraryPreferences : {};
  } catch {
    return {};
  }
}

function newTypesetDocumentPath(template: TypesetTemplate, title: string): string {
  const definition = TYPESET_LIBRARY_TEMPLATES.find((item) => item.kind === template) ?? TYPESET_LIBRARY_TEMPLATES[0];
  const safeName = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled-document";
  return `${definition.folder}/${safeName}/main.tex`;
}

function TypesetStartPage({
  projectPath,
  documents,
  latexAvailable,
  loading,
  error,
  onOpenSource,
  onCreateSource,
  onRefresh,
}: {
  projectPath: string | null;
  documents: TypesetDocument[];
  latexAvailable: boolean | null;
  loading: boolean;
  error: string | null;
  onOpenSource: (path: string) => void;
  onCreateSource: (path: string, template: TypesetTemplate, title: string) => void;
  onRefresh: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_LIBRARY_COPY[language];
  const [scope, setScope] = useState<TypesetLibraryScope>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"modified" | "title">("modified");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [preferences, setPreferences] = useState<TypesetLibraryPreferences>(() => loadTypesetLibraryPreferences(projectPath));
  const [createOpen, setCreateOpen] = useState(false);
  const [template, setTemplate] = useState<TypesetTemplate>("article");
  const [newTitle, setNewTitle] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setScope("all");
    setSearch("");
    setSelectedPaths(new Set());
    setPreferences(loadTypesetLibraryPreferences(projectPath));
  }, [projectPath]);

  const updatePreferences = useCallback((update: (current: TypesetLibraryPreferences) => TypesetLibraryPreferences) => {
    setPreferences((current) => {
      const next = update(current);
      try {
        window.localStorage.setItem(typesetLibraryPreferenceKey(projectPath), JSON.stringify(next));
      } catch {
        // Favorites and archive state remain available for this session when storage is unavailable.
      }
      return next;
    });
  }, [projectPath]);

  const activeDocuments = useMemo(
    () => documents.filter((document) => !preferences[document.path]?.archived),
    [documents, preferences],
  );
  const counts = useMemo(() => ({
    all: activeDocuments.length,
    recent: activeDocuments.length,
    favorites: activeDocuments.filter((document) => preferences[document.path]?.favorite).length,
    article: activeDocuments.filter((document) => document.kind === "article").length,
    beamer: activeDocuments.filter((document) => document.kind === "beamer").length,
    poster: activeDocuments.filter((document) => document.kind === "poster").length,
    report: activeDocuments.filter((document) => document.kind === "report").length,
    ready: activeDocuments.filter((document) => document.compileState === "fresh").length,
    "needs-compile": activeDocuments.filter((document) => document.compileState !== "fresh").length,
    archived: documents.filter((document) => preferences[document.path]?.archived).length,
  }), [activeDocuments, documents, preferences]);

  const visibleDocuments = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const matchesScope = (document: TypesetDocument) => {
      const preference = preferences[document.path];
      if (scope === "archived") return Boolean(preference?.archived);
      if (preference?.archived) return false;
      if (scope === "favorites") return Boolean(preference?.favorite);
      if (scope === "article" || scope === "beamer" || scope === "poster" || scope === "report") return document.kind === scope;
      if (scope === "ready") return document.compileState === "fresh";
      if (scope === "needs-compile") return document.compileState !== "fresh";
      return true;
    };
    return documents
      .filter(matchesScope)
      .filter((document) => !needle || `${document.title} ${document.path} ${document.kind}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => sort === "title"
        ? left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
        : right.modifiedEpochMs - left.modifiedEpochMs || left.title.localeCompare(right.title));
  }, [documents, preferences, scope, search, sort]);

  const visiblePathSet = useMemo(() => new Set(visibleDocuments.map((document) => document.path)), [visibleDocuments]);
  const allVisibleSelected = visibleDocuments.length > 0 && visibleDocuments.every((document) => selectedPaths.has(document.path));
  const title = copy.scopes[scope];

  const toggleSelection = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectVisible = () => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const path of visiblePathSet) next.delete(path);
      } else {
        for (const path of visiblePathSet) next.add(path);
      }
      return next;
    });
  };

  const toggleFavorite = (path: string) => {
    updatePreferences((current) => ({
      ...current,
      [path]: { ...current[path], favorite: !current[path]?.favorite },
    }));
  };

  const toggleArchived = (path: string) => {
    updatePreferences((current) => ({
      ...current,
      [path]: { ...current[path], archived: !current[path]?.archived },
    }));
    setSelectedPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  };

  const revealDocument = (path: string) => {
    setActionError(null);
    void fileReveal(path).catch((revealError) => setActionError(String(revealError)));
  };

  const createDocument = () => {
    const fallbackTitle = copy.templates[template].label;
    const titleValue = newTitle.trim() || fallbackTitle;
    onCreateSource(newTypesetDocumentPath(template, titleValue), template, titleValue);
    setCreateOpen(false);
    setNewTitle("");
  };

  const navigationGroups: Array<{ label: string; items: Array<{ scope: TypesetLibraryScope; label: string }> }> = [
    {
      label: copy.groups.library,
      items: [
        { scope: "all", label: copy.navigation.all },
        { scope: "recent", label: copy.navigation.recent },
        { scope: "favorites", label: copy.navigation.favorites },
      ],
    },
    {
      label: copy.groups.documentType,
      items: [
        { scope: "article", label: copy.navigation.article },
        { scope: "beamer", label: copy.navigation.beamer },
        { scope: "poster", label: copy.navigation.poster },
        { scope: "report", label: copy.navigation.report },
      ],
    },
    {
      label: copy.groups.buildStatus,
      items: [
        { scope: "ready", label: copy.navigation.ready },
        { scope: "needs-compile", label: copy.navigation["needs-compile"] },
        { scope: "archived", label: copy.navigation.archived },
      ],
    },
  ];

  return (
    <section className="typeset-start typeset-library" aria-label={copy.libraryLabel}>
      {error && <div className="typeset-error-bar">{error}</div>}
      <div className="typeset-library-shell">
        <aside className="typeset-library-sidebar" aria-label={copy.categoriesLabel}>
          <button type="button" className="typeset-library-new" onClick={() => setCreateOpen(true)}>
            <ToolIcon name="new" />
            {copy.newDocument}
          </button>
          {navigationGroups.map((group) => (
            <section key={group.label} className="typeset-library-nav-group" aria-label={group.label}>
              <strong>{group.label}</strong>
              {group.items.map((item) => (
                <button
                  key={item.scope}
                  type="button"
                  className={scope === item.scope ? "active" : ""}
                  aria-label={item.label}
                  aria-current={scope === item.scope ? "page" : undefined}
                  onClick={() => setScope(item.scope)}
                >
                  <span>{item.label}</span>
                  <em>{counts[item.scope]}</em>
                </button>
              ))}
            </section>
          ))}
          <div className="typeset-library-sidebar-foot">
            <ToolIcon name="files" />
            <span>{copy.rootDocumentsOnly}</span>
          </div>
        </aside>

        <section className="typeset-library-main" aria-label={title}>
          <header className="typeset-library-header">
            <div>
              <h1>{title}</h1>
              <p>{loading ? copy.scanning : copy.documentCount(visibleDocuments.length)}</p>
            </div>
            <button type="button" className="typeset-library-refresh" onClick={onRefresh} disabled={loading} aria-label={copy.refreshLibrary}>
              <ToolIcon name="refresh" />
              {copy.refresh}
            </button>
          </header>

          {latexAvailable === false && (
            <div className="typeset-library-runtime-notice" role="status">
              <span className="typeset-library-runtime-mark">TeX</span>
              <div>
                <strong>{copy.latexMissingTitle}</strong>
                <span>{copy.latexMissingBody}</span>
              </div>
              <button type="button" onClick={() => handoffEnvironmentInstall("latex", language)}>
                {copy.installInChat}
              </button>
            </div>
          )}

          <div className="typeset-library-controls">
            <label className="typeset-library-search">
              <ToolIcon name="search" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchPlaceholder} />
            </label>
            <label className="typeset-library-sort">
              <span>{copy.sort}</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as "modified" | "title")} aria-label={copy.sortDocuments}>
                <option value="modified">{copy.sortModified}</option>
                <option value="title">{copy.sortTitle}</option>
              </select>
            </label>
          </div>

          {actionError && <div className="typeset-error-bar typeset-library-action-error">{actionError}</div>}
          <div className="typeset-library-table-wrap">
            <table className="typeset-library-table">
              <thead>
                <tr>
                  <th className="typeset-library-select-col">
                    <input type="checkbox" aria-label={copy.selectVisible} checked={allVisibleSelected} onChange={toggleSelectVisible} />
                  </th>
                  <th>{copy.table.document}</th>
                  <th>{copy.table.type}</th>
                  <th>{copy.table.modified}</th>
                  <th>{copy.table.status}</th>
                  <th className="typeset-library-actions-col">{copy.table.actions}</th>
                </tr>
              </thead>
              <tbody>
                {visibleDocuments.map((document) => {
                  const archived = Boolean(preferences[document.path]?.archived);
                  const favorite = Boolean(preferences[document.path]?.favorite);
                  return (
                    <tr key={document.path} className={archived ? "archived" : ""} onDoubleClick={() => onOpenSource(document.path)}>
                      <td className="typeset-library-select-col">
                        <input
                          type="checkbox"
                          aria-label={copy.selectDocument(document.title)}
                          checked={selectedPaths.has(document.path)}
                          onChange={() => toggleSelection(document.path)}
                        />
                      </td>
                      <td>
                        <button type="button" className="typeset-library-document" onClick={() => onOpenSource(document.path)}>
                          <FileIcon path={document.path} />
                          <span>
                            <strong>{document.title}</strong>
                            <em title={document.path}>{dirname(document.path) || copy.projectRoot}</em>
                          </span>
                        </button>
                      </td>
                      <td><span className={`typeset-library-kind ${document.kind}`}>{documentKindLabel(document.kind, language)}</span></td>
                      <td><time dateTime={new Date(document.modifiedEpochMs).toISOString()}>{documentRelativeTime(document.modifiedEpochMs, language)}</time></td>
                      <td><span className={`typeset-library-status ${document.compileState}`}>{documentCompileLabel(document.compileState, language)}</span></td>
                      <td className="typeset-library-actions-col">
                        <div className="typeset-library-actions" aria-label={copy.actionsFor(document.title)}>
                          <button type="button" title={copy.open} aria-label={copy.openDocument(document.title)} onClick={() => onOpenSource(document.path)}><ToolIcon name="open" /></button>
                          <button type="button" title={copy.reveal} aria-label={copy.revealDocument(document.title)} onClick={() => revealDocument(document.path)}><ToolIcon name="files" /></button>
                          <button type="button" title={favorite ? copy.removeFavorite : copy.addFavorite} aria-label={copy.favoriteDocument(document.title, favorite)} onClick={() => toggleFavorite(document.path)} className={favorite ? "active" : ""}><SvgIcon name="star" size={16} /></button>
                          <button type="button" title={archived ? copy.restore : copy.archive} aria-label={copy.archiveDocument(document.title, archived)} onClick={() => toggleArchived(document.path)}><ToolIcon name={archived ? "undo" : "download"} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && visibleDocuments.length === 0 && (
              <div className="typeset-library-empty">
                <ToolIcon name="files" />
                <strong>{documents.length === 0 ? copy.emptyRootTitle : copy.emptyViewTitle}</strong>
                <span>{documents.length === 0 ? copy.emptyRootBody : copy.emptyViewBody}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {createOpen && (
        <div className="typeset-library-create-backdrop" role="presentation" onMouseDown={() => setCreateOpen(false)}>
          <section className="typeset-library-create-dialog" role="dialog" aria-modal="true" aria-label={copy.dialogLabel} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>{copy.dialogEyebrow}</span>
                <strong>{copy.dialogTitle}</strong>
              </div>
              <button type="button" aria-label={copy.closeDialog} onClick={() => setCreateOpen(false)}><ToolIcon name="clear" /></button>
            </header>
            <label className="typeset-library-title-input">
              <span>{copy.documentTitle}</span>
              <input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={copy.titlePlaceholder} />
            </label>
            <div className="typeset-library-template-grid" role="radiogroup" aria-label={copy.templateLabel}>
              {TYPESET_LIBRARY_TEMPLATES.map((item) => {
                const templateCopy = copy.templates[item.kind];
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="radio"
                    aria-checked={template === item.kind}
                    className={template === item.kind ? "active" : ""}
                    onClick={() => setTemplate(item.kind)}
                  >
                    <strong>{templateCopy.label}</strong>
                    <span>{templateCopy.description}</span>
                  </button>
                );
              })}
            </div>
            <footer>
              <button type="button" className="typeset-btn subtle" onClick={() => setCreateOpen(false)}>{copy.cancel}</button>
              <button type="button" className="typeset-recompile-btn" onClick={createDocument}><ToolIcon name="new" />{copy.create}</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function lineOffsetFor(source: string, line: number): number {
  const lines = source.split("\n");
  return lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0);
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
  const [latexAvailable, setLatexAvailable] = useState<boolean | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [spellCheck, setSpellCheck] = useState(loadSpellCheckPreference);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [visualPdfCursor, setVisualPdfCursor] = useState<VisualPdfCursor | null>(null);
  const [pdfForwardTarget, setPdfForwardTarget] = useState<PdfForwardTarget | null>(null);
  const [forwardSearchNotice, setForwardSearchNotice] = useState<string | null>(null);
  const [projectPanelVisible, setProjectPanelVisible] = useState(true);
  const [pdfPanelVisible, setPdfPanelVisible] = useState(true);
  const [slideFocusMode, setSlideFocusMode] = useState(true);
  const [projectPanelWidth, setProjectPanelWidth] = useState(PROJECT_PANEL_DEFAULT_W);
  const [pdfPanelWidth, setPdfPanelWidth] = useState(PDF_PANEL_DEFAULT_W);
  const [outlinePanelHeight, setOutlinePanelHeight] = useState<number | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
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
  const projectPanelWidthRef = useRef(projectPanelWidth);
  const pdfPanelWidthRef = useRef(pdfPanelWidth);
  const outlinePanelHeightRef = useRef<number | null>(outlinePanelHeight);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  projectPanelWidthRef.current = projectPanelWidth;
  pdfPanelWidthRef.current = pdfPanelWidth;
  outlinePanelHeightRef.current = outlinePanelHeight;
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
  const autoCompiledPathRef = useRef<string | null>(null);
  const compileRef = useRef<() => void>(() => {});
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
  sourcePathRef.current = sourcePath;
  documentRootPathRef.current = documentRootPath;
  documentSourcesRef.current = documentSources;
  loadedRef.current = loaded;
  activeCompileRunIdRef.current = activeCompileRunId;

  useEffect(() => {
    setCompileErrorHandling(loadCompileErrorHandling(currentProject?.id));
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject?.id || !isTauri()) return;
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

  const dirty = Boolean(loaded && draft !== loaded.content);
  const syncTexMappingStale = syncTexOutdated || dirty || compileResult?.pdfState === "stale" || compileResult?.pdfState === "partial";
  useEffect(() => {
    setTypesetDirty(dirty);
  }, [dirty, setTypesetDirty]);
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
          const result = await fileSearch(pattern);
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
    const currentFile = loadedRef.current;
    if (
      currentPath
      && currentFile
      && draftRef.current !== currentFile.content
      && !window.confirm(copy.discardUnsavedChangesOpen(basename(currentPath), basename(path)))
    ) {
      return false;
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
      const [file, contextResolution] = await Promise.all([
        fileReadText(path),
        belongsToCurrentDocument
          ? Promise.resolve({ context: null, error: null })
          : latexDocumentContext(path)
              .then((context) => ({ context, error: null }))
              .catch((contextError) => ({ context: null, error: String(contextError) })),
      ]);
      if (documentEpochRef.current !== documentEpoch) return false;
      setSourcePath(file.path);
      setLoaded(file);
      resetDraft(file.content);
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
  }, [documentRootPath, invalidateActiveCompile, previewPath, resetDraft, sourcePath]);

  const createSource = useCallback(async (path: string, template: TypesetTemplate = "article", title = "SomniQ LaTeX Draft") => {
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setError(null);
    try {
      const normalized = normalizeNewTypesetPath(path);
      const file = await fileCreateText(normalized, defaultSourceFor(normalized, template, title));
      if (documentEpochRef.current !== documentEpoch) return;
      setStartDocuments((documents) => [
        {
          path: file.path,
          title,
          kind: template,
          modifiedEpochMs: Date.now(),
          compileState: "missing",
        },
        ...documents.filter((document) => document.path !== file.path),
      ]);
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
    autoCompiledPathRef.current = null;
    try {
      const documents = await typesetListDocuments();
      if (documentEpochRef.current !== documentEpoch) return;
      const sortedMatches = sortedSources(documents.map((document) => document.path));
      setStartDocuments(documents);
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
    activeCompileRunIdRef.current = runId;
    const ownsCompile = () => (
      compileEpochRef.current === compileEpoch
      && activeCompileRunIdRef.current === runId
      && sourcePathRef.current === openPath
    );
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
    const compilePath = saved.path || openPath;
    // Freeze what TeX is about to read. `save()` has just flushed the open file,
    // and the rest of the graph is whatever was last loaded from disk — the same
    // bytes the compiler will see, and the baseline every later SyncTeX result
    // is numbered against. Only committed once the run actually yields a PDF:
    // after a failed build the PDF (and its SyncTeX data) still describe the
    // previous snapshot, so replacing it here would remap against the wrong file.
    const compiledSnapshot = { ...documentSourcesRef.current, [compilePath]: saved.content };
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onLatexCompileProgress((progress) => {
        if (progress.runId === runId && ownsCompile()) {
          setCompileLiveLog({ stdout: progress.stdout, stderr: progress.stderr, elapsedMs: progress.elapsedMs });
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

  const saveCurrentEditor = useCallback(() => {
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    // The explicit Save action in the compiled Beamer canvas refreshes its PDF
    // preview. Keyboard save is routed through `saveShortcut` below and only
    // writes the draft, so Ctrl+S never starts a hidden compile.
    if (editorMode === "visual" && beamerSlides.length > 0) {
      if (saving) return;
      compileRef.current();
      return;
    }
    void save();
  }, [beamerSlides.length, editorMode, loaded, save, saving]);

  const saveShortcut = useCallback(() => {
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    void save();
  }, [loaded, save]);

  // Auto-compile removed: shows last compiled PDF. Click Recompile when ready.
  useEffect(() => {
    if (!sourcePath || !loaded || loading || saving) return;
    if (autoCompiledPathRef.current === sourcePath) return;
    autoCompiledPathRef.current = sourcePath;
    // auto-compile removed, click Recompile when ready
  }, [sourcePath, loaded, loading, saving]);

  // CodeEditor captures `extraKeymap` once at mount, so route through refs kept
  // fresh every render rather than closing over these (non-memoized, in `compile`'s
  // case) callbacks directly.
  const saveRef = useRef(saveShortcut);
  saveRef.current = saveShortcut;
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
          const fallbackFound = navigateToPdfTextFallback(text, context);
          const diagnostic = result.stderr.trim();
          if (diagnostic || !fallbackFound) setForwardSearchNotice(diagnostic || copy.noSourceMatchForPdfPoint);
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
        setForwardSearchNotice(String(inverseError));
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

  const beginPanelResize = useCallback((
    panel: TypesetResizePanel,
    axis: TypesetResizeAxis,
    clientX: number,
    clientY: number,
  ) => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    resizeCleanupRef.current?.();

    const startCoord = coordinateForAxis(axis, { clientX, clientY });
    const startSize = panel === "project" ? projectPanelWidthRef.current : pdfPanelWidthRef.current;
    const root = document.documentElement;
    const body = document.body;
    const resizingClass = axis === "y" ? "typeset-resizing-y" : "typeset-resizing-x";
    const cursor = axis === "y" ? "row-resize" : "col-resize";
    const previousBodyCursor = body.style.cursor;
    const previousBodyUserSelect = body.style.userSelect;
    const captureOptions: AddEventListenerOptions = { capture: true };
    const pointerMoveOptions: AddEventListenerOptions = { capture: true, passive: false };
    let active = true;

    const applyMove = (moveClientX: number, moveClientY: number) => {
      const delta = coordinateForAxis(axis, { clientX: moveClientX, clientY: moveClientY }) - startCoord;
      if (panel === "project") {
        setProjectPanelWidth(clampNumber(startSize + delta, PROJECT_PANEL_MIN_W, PROJECT_PANEL_MAX_W));
        return;
      }
      setPdfPanelWidth(clampNumber(startSize - delta, PDF_PANEL_MIN_W, PDF_PANEL_MAX_W));
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", onPointerMove, pointerMoveOptions);
      window.removeEventListener("pointerup", cleanup, captureOptions);
      window.removeEventListener("pointercancel", cleanup, captureOptions);
      window.removeEventListener("mousemove", onMouseMove, captureOptions);
      window.removeEventListener("mouseup", cleanup, captureOptions);
      window.removeEventListener("blur", cleanup);
      document.removeEventListener("keydown", onEscape, captureOptions);
      root.classList.remove(resizingClass);
      body.style.cursor = previousBodyCursor;
      body.style.userSelect = previousBodyUserSelect;
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    const prevent = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };

    function onMouseMove(event: MouseEvent) {
      prevent(event);
      applyMove(event.clientX, event.clientY);
    }

    function onPointerMove(event: PointerEvent) {
      prevent(event);
      applyMove(event.clientX, event.clientY);
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cleanup();
      }
    }

    root.classList.add(resizingClass);
    body.style.cursor = cursor;
    body.style.userSelect = "none";
    resizeCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove, pointerMoveOptions);
    window.addEventListener("pointerup", cleanup, captureOptions);
    window.addEventListener("pointercancel", cleanup, captureOptions);
    window.addEventListener("mousemove", onMouseMove, captureOptions);
    window.addEventListener("mouseup", cleanup, captureOptions);
    window.addEventListener("blur", cleanup);
    document.addEventListener("keydown", onEscape, captureOptions);
  }, []);

  const beginPanelResizeFromPointer = useCallback((panel: TypesetResizePanel, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    beginPanelResize(panel, resizeAxisForTarget(event.currentTarget), event.clientX, event.clientY);
  }, [beginPanelResize]);

  const beginOutlineResizeFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const startY = event.clientY;
    const measuredHeight = event.currentTarget.nextElementSibling?.getBoundingClientRect().height ?? 0;
    const startHeight = outlinePanelHeightRef.current ?? (measuredHeight > 0 ? measuredHeight : OUTLINE_PANEL_DEFAULT_H);
    const root = document.documentElement;
    const body = document.body;
    const previousBodyCursor = body.style.cursor;
    const previousBodyUserSelect = body.style.userSelect;
    const captureOptions: AddEventListenerOptions = { capture: true };
    const pointerMoveOptions: AddEventListenerOptions = { capture: true, passive: false };
    let active = true;

    const applyMove = (clientY: number) => {
      const delta = clientY - startY;
      setOutlinePanelHeight(clampNumber(startHeight - delta, OUTLINE_PANEL_MIN_H, OUTLINE_PANEL_MAX_H));
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", onPointerMove, pointerMoveOptions);
      window.removeEventListener("pointerup", cleanup, captureOptions);
      window.removeEventListener("pointercancel", cleanup, captureOptions);
      window.removeEventListener("mousemove", onMouseMove, captureOptions);
      window.removeEventListener("mouseup", cleanup, captureOptions);
      window.removeEventListener("blur", cleanup);
      document.removeEventListener("keydown", onEscape, captureOptions);
      root.classList.remove("typeset-resizing-y");
      body.style.cursor = previousBodyCursor;
      body.style.userSelect = previousBodyUserSelect;
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };

    const prevent = (moveEvent: Event) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
    };

    function onMouseMove(moveEvent: MouseEvent) {
      prevent(moveEvent);
      applyMove(moveEvent.clientY);
    }

    function onPointerMove(moveEvent: PointerEvent) {
      prevent(moveEvent);
      applyMove(moveEvent.clientY);
    }

    function onEscape(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") cleanup();
    }

    root.classList.add("typeset-resizing-y");
    body.style.cursor = "row-resize";
    body.style.userSelect = "none";
    resizeCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove, pointerMoveOptions);
    window.addEventListener("pointerup", cleanup, captureOptions);
    window.addEventListener("pointercancel", cleanup, captureOptions);
    window.addEventListener("mousemove", onMouseMove, captureOptions);
    window.addEventListener("mouseup", cleanup, captureOptions);
    window.addEventListener("blur", cleanup);
    document.addEventListener("keydown", onEscape, captureOptions);
  }, []);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
  }, []);

  const handlePanelResizeKey = useCallback((panel: TypesetResizePanel, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    if (panel === "project") {
      setProjectPanelWidth((width) => clampNumber(width + direction * step, PROJECT_PANEL_MIN_W, PROJECT_PANEL_MAX_W));
      return;
    }
    setPdfPanelWidth((width) => clampNumber(width - direction * step, PDF_PANEL_MIN_W, PDF_PANEL_MAX_W));
  }, []);

  const handleOutlineResizeKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const measuredHeight = event.currentTarget.nextElementSibling?.getBoundingClientRect().height ?? 0;
    setOutlinePanelHeight((height) => clampNumber(
      (height ?? (measuredHeight > 0 ? measuredHeight : OUTLINE_PANEL_DEFAULT_H)) + direction * step,
      OUTLINE_PANEL_MIN_H,
      OUTLINE_PANEL_MAX_H,
    ));
  }, []);

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
                    refreshKey={treeRefreshKey}
                    onOpenPath={openPath}
                    onFileMutation={handleFileMutation}
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

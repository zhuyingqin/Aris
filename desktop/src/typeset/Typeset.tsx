import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { memo } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
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
  fileWriteText,
  isTauri,
  latexCompile,
  latexCompileCancel,
  latexForwardSearch,
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
import type { VisualPdfCursor } from "./visualModel";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { useStore } from "../store";
import { suggestedCitationKey, useLiteratureStore } from "../literature/literatureStore";
import type { LiteraturePaper } from "../literature/literatureTypes";
import { SvgIcon } from "../SvgIcon";
import "./Typeset.css";

const pdfWorkerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
const DEFAULT_SOURCE_PATH = "papers/main.tex";
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
type TypesetResizePanel = "project" | "pdf";
type TypesetResizeAxis = "x" | "y";
type TypesetLibraryPreferences = Record<string, { favorite?: boolean; archived?: boolean }>;

const COMPILE_ERROR_HANDLING_STORAGE_PREFIX = "somniq-typeset-compile-error-handling:";

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
type OutlineItem = { line: number; level: number; title: string };
type NumberedOutlineItem = OutlineItem & { number: string };
type BeamerSlide = { line: number; endLine: number; title: string };

const PROJECT_PANEL_DEFAULT_W = 204;
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 360;
const PDF_PANEL_DEFAULT_W = 760;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;
const OUTLINE_PANEL_DEFAULT_H = 184;
const OUTLINE_PANEL_MIN_H = 72;
const OUTLINE_PANEL_MAX_H = 720;
const PDF_ZOOM_MIN = 0.25;
const PDF_ZOOM_MAX = 4;
const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;
const PDF_WHEEL_ZOOM_SETTLE_MS = 80;
/** About 32 MiB of RGBA backing storage for one mounted PDF page. */
const PDF_CANVAS_MAX_PIXELS = 8_000_000;
const TYPESET_LIBRARY_PREFERENCES_STORAGE_PREFIX = "somniq-typeset-library:";

type VisualBlock =
  | { kind: "abstract"; line: number; endLine: number; text: string }
  | { kind: "citation"; line: number; endLine: number; keys: string[]; text: string }
  | { kind: "command"; line: number; endLine: number; text: string }
  | { kind: "environment"; line: number; endLine: number; name: string; text: string }
  | { kind: "figure"; line: number; endLine: number; caption: string; image: string; text: string }
  | { kind: "footnote"; line: number; endLine: number; text: string }
  | { kind: "frame"; line: number; endLine: number; options?: string; title: string; text: string }
  | { kind: "heading"; line: number; endLine: number; level: number; text: string }
  | { kind: "list"; line: number; endLine: number; items: string[]; ordered?: boolean; wrapped?: boolean }
  | { kind: "macro"; line: number; endLine: number; command: string; label: string; text: string; prefix?: string; badge?: string }
  | { kind: "math"; line: number; endLine: number; text: string; numbered?: boolean; eqNumber?: number; eqLabel?: string }
  | { kind: "paragraph"; line: number; endLine: number; text: string }
  | { kind: "preamble"; line: number; endLine: number; text: string }
  | { kind: "table"; line: number; endLine: number; headers: string[]; rows: string[][]; text: string }
  | { kind: "theorem"; line: number; endLine: number; envName: string; label: string; text: string; thmNumber?: number }
  | {
      kind: "title";
      line: number;
      endLine: number;
      title: string;
      author: string;
      date: string;
      titleLine?: number;
      titleEndLine?: number;
      authorLine?: number;
      authorEndLine?: number;
      dateLine?: number;
      dateEndLine?: number;
    };

type VisualDocument = {
  contentBlocks: VisualBlock[];
  preambleBlocks: VisualBlock[];
};

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

type VisualFormulaEdit = {
  line: number;
  source: string;
  value: string;
  anchor?: { left: number; top: number };
};

type VisualFrameNode =
  | { kind: "block"; title: string; tone: "alert" | "example" | "normal" | "note"; children: VisualFrameNode[] }
  | { kind: "columns"; columns: Array<{ width?: string; children: VisualFrameNode[] }> }
  | { kind: "list"; ordered?: boolean; items: string[] }
  | { kind: "math"; text: string }
  | { kind: "note"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "section"; text: string }
  | { kind: "table"; rows: string[][] };

type LatexMetadata = {
  author: string;
  authorLine?: number;
  authorEndLine?: number;
  date: string;
  dateLine?: number;
  dateEndLine?: number;
  title: string;
  titleLine?: number;
  titleEndLine?: number;
};

function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

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

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
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

function lineNumberForOffset(source: string, offset: number): number {
  const safeOffset = clampNumber(offset, 0, source.length);
  let line = 1;
  for (let index = 0; index < safeOffset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
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
      if (normalized === "papers/main.tex") return 0;
      if (normalized === "main.tex") return 1;
      if (normalized.endsWith("/main.tex")) return 2;
      if (normalized.endsWith(".tex")) return 3;
      return 4;
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

function compileStatusText(status: CompileStatus, result: CompileResult | null): string {
  if (status === "running") return "Compiling";
  if (status === "success") {
    if (!result) return "Compiled";
    return `${result.engine} in ${result.durationMs} ms`;
  }
  if (status === "partial") return "Compiled with errors";
  if (status === "error") return "Compile failed";
  return "";
}

function latexLineWithoutComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "%" && line[index - 1] !== "\\") return line.slice(0, index);
  }
  return line;
}

function latexCommandValueFromLines(lines: string[], startIndex: number, command: string): { value: string; endIndex: number } | null {
  const firstLine = latexLineWithoutComment(lines[startIndex]);
  const startMatch = new RegExp(`^\\s*\\\\${command}\\*?`).exec(firstLine);
  if (!startMatch) return null;
  let position = startMatch[0].length;
  while (position < firstLine.length && /\s/.test(firstLine[position])) position += 1;
  if (firstLine[position] === "[") {
    const optionEnd = firstLine.indexOf("]", position + 1);
    if (optionEnd < 0) return null;
    position = optionEnd + 1;
    while (position < firstLine.length && /\s/.test(firstLine[position])) position += 1;
  }
  if (firstLine[position] !== "{") return null;

  let depth = 1;
  let value = "";
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const clean = latexLineWithoutComment(lines[lineIndex]);
    let charIndex = lineIndex === startIndex ? position + 1 : 0;
    if (lineIndex > startIndex && value) value += "\n";
    for (; charIndex < clean.length; charIndex += 1) {
      const char = clean[charIndex];
      const escaped = charIndex > 0 && clean[charIndex - 1] === "\\";
      if (!escaped && char === "{") {
        depth += 1;
        value += char;
        continue;
      }
      if (!escaped && char === "}") {
        depth -= 1;
        if (depth === 0) return { value: value.trim(), endIndex: lineIndex };
        value += char;
        continue;
      }
      value += char;
    }
  }
  return null;
}

function latexEnvironmentEnd(lines: string[], startIndex: number, name: string, limit: number): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endPattern = new RegExp(`^\\\\end\\{${escaped}\\}`);
  for (let index = startIndex + 1; index < limit; index += 1) {
    if (endPattern.test(lines[index].trim())) return index;
  }
  return startIndex;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanLatexTableRow(row: string): string {
  return row
    .replace(/\\(hline|cline\{[^}]*\}|toprule|midrule|bottomrule)\b/g, "")
    .replace(/\\(centering|small|footnotesize|scriptsize)\b/g, "")
    .trim();
}

function parseLatexTabular(text: string): { headers: string[]; rows: string[][] } {
  const tabular = /\\begin\{tabular\}(?:\[[^\]]*\])?\{[^}]*\}([\s\S]*?)\\end\{tabular\}/.exec(text);
  const body = tabular?.[1] ?? text;
  const rowChunks = body.includes("\\\\") ? body.split(/\\\\/) : body.split(/\n/);
  const parsedRows = rowChunks
    .map((row) => cleanLatexTableRow(row.replace(/\r/g, "").replace(/\n+/g, " ")))
    .filter((row) => row && !/^\\(caption|label)\b/.test(row))
    .map((row) => row.split("&").map((cell) => cell.trim()));
  return {
    headers: parsedRows.length > 0 ? parsedRows[0] : [],
    rows: parsedRows.length > 1 ? parsedRows.slice(1) : [],
  };
}

function tableRowsToVisualValue(headers: string[], rows: string[][]): string {
  return [headers, ...rows]
    .filter((row) => row.length > 0)
    .map((row) => row.join("\t"))
    .join("\n");
}

function visualValueToTableRows(value: string): string[][] {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => row.split(/\t|&/).map((cell) => cell.trim()));
}

function latexColumnSpecFor(rows: string[][], original: string): string {
  const originalSpec = /\\begin\{tabular\}(?:\[[^\]]*\])?\{([^}]*)\}/.exec(original)?.[1]?.trim();
  if (originalSpec) return originalSpec;
  const columns = Math.max(1, ...rows.map((row) => row.length));
  return "l".repeat(columns);
}

function sourceForTableBlock(block: Extract<VisualBlock, { kind: "table" }>, value: string): string {
  const rows = visualValueToTableRows(value);
  const fallbackRows = [block.headers, ...block.rows].filter((row) => row.length > 0);
  const tableRows = rows.length > 0 ? rows : fallbackRows;
  const columnSpec = latexColumnSpecFor(tableRows, block.text);
  const latexRowBreak = " \\\\";
  const body = tableRows.map((row) => `${row.join(" & ")}${latexRowBreak}`).join("\n");
  const tabular = `\\begin{tabular}{${columnSpec}}\n${body}\n\\end{tabular}`;
  if (/\\begin\{tabular\}/.test(block.text)) {
    return block.text.replace(/\\begin\{tabular\}(?:\[[^\]]*\])?\{[^}]*\}[\s\S]*?\\end\{tabular\}/, tabular);
  }
  return tabular;
}

function splitCitationKeys(value: string): string[] {
  return value
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function latexSingleArgumentCommand(line: string): { command: string; value: string } | null {
  const match = /^\\([A-Za-z]+)\*?(?:\[[^\]]*])?\{([\s\S]*)\}\s*$/.exec(line);
  if (!match) return null;
  return { command: match[1], value: match[2].trim() };
}

type LatexMacroPresentation = {
  badge?: string;
  label: string;
  prefix?: string;
};

function labelFromEntryCommand(command: string): string | null {
  const labels: Record<string, string> = {
    entryabstract: "Abstract",
    entryaffiliations: "Affiliations",
    entryauthors: "Authors",
    entrykeywords: "Keywords",
    entrymeta: "Meta",
    entrytitle: "Title",
  };
  if (labels[command]) return labels[command];
  if (/^entry[A-Za-z]+$/.test(command)) {
    return command
      .replace(/^entry/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (letter) => letter.toUpperCase());
  }
  return null;
}

function visualPresentationForLatexCommand(command: string, value: string): LatexMacroPresentation | null {
  let label = labelFromEntryCommand(command);
  if (!label) return null;

  let prefix: string | undefined;
  let badge: string | undefined;

  const languagePrefix = /^\s*\[([A-Za-z]{2,8})\]\s*/.exec(value);
  if (/abstract/i.test(command) && languagePrefix) {
    prefix = languagePrefix[0];
    badge = languagePrefix[1].toUpperCase();
  }

  const namedPrefix = /^\s*(Authors?|Affiliations?|Keywords?|Abstract|Meta|Title)\s*:\s*/i.exec(value);
  if (!prefix && namedPrefix) {
    const normalized = namedPrefix[1].toLowerCase();
    const fieldLabels: Record<string, string> = {
      affiliation: "Affiliations",
      affiliations: "Affiliations",
      abstract: "Abstract",
      author: "Authors",
      authors: "Authors",
      keyword: "Keywords",
      keywords: "Keywords",
      meta: "Meta",
      title: "Title",
    };
    label = fieldLabels[normalized] ?? label;
    prefix = namedPrefix[0];
  }

  return { badge, label, prefix };
}

function extractLatexMetadata(lines: string[], startLine = 1): LatexMetadata {
  const metadata: LatexMetadata = { author: "", date: "", title: "" };
  lines.forEach((_, index) => {
    const lineNumber = startLine + index;
    const title = latexCommandValueFromLines(lines, index, "title");
    const author = latexCommandValueFromLines(lines, index, "author");
    const date = latexCommandValueFromLines(lines, index, "date");
    if (title !== null) {
      metadata.title = title.value;
      metadata.titleLine = lineNumber;
      metadata.titleEndLine = startLine + title.endIndex;
    }
    if (author !== null) {
      metadata.author = author.value;
      metadata.authorLine = lineNumber;
      metadata.authorEndLine = startLine + author.endIndex;
    }
    if (date !== null) {
      metadata.date = date.value;
      metadata.dateLine = lineNumber;
      metadata.dateEndLine = startLine + date.endIndex;
    }
  });
  return metadata;
}

function parseLatexVisualDocument(source: string): VisualDocument {
  const blocks: VisualBlock[] = [];
  const lines = source.split("\n");
  const beginIndex = lines.findIndex((line) => /^\\begin\{document\}/.test(line.trim()));
  const endIndex = lines.findIndex((line, index) => index > beginIndex && /^\\end\{document\}/.test(line.trim()));
  const bodyStart = beginIndex >= 0 ? beginIndex + 1 : 0;
  const bodyEnd = endIndex >= 0 ? endIndex : lines.length;
  const preambleText = beginIndex >= 0 ? lines.slice(0, bodyStart).join("\n").trim() : "";
  const metadata = extractLatexMetadata(lines.slice(0, bodyStart), 1);
  const preambleBlocks: VisualBlock[] = preambleText
    ? [{ kind: "preamble", line: 1, endLine: bodyStart, text: preambleText }]
    : [];
  let paragraph: string[] = [];
  let paragraphLine = bodyStart + 1;

  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ kind: "paragraph", line: paragraphLine, endLine: paragraphLine + paragraph.length - 1, text });
    paragraph = [];
  };

  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const line = latexLineWithoutComment(raw).trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    if (/^\\maketitle\b/.test(line)) {
      flushParagraph();
      blocks.push({
        kind: "title",
        line: lineNumber,
        endLine: lineNumber,
        title: metadata.title,
        author: metadata.author,
        date: metadata.date,
        titleLine: metadata.titleLine,
        titleEndLine: metadata.titleEndLine,
        authorLine: metadata.authorLine,
        authorEndLine: metadata.authorEndLine,
        dateLine: metadata.dateLine,
        dateEndLine: metadata.dateEndLine,
      });
      continue;
    }

    const frameStart = /^\\begin\{frame\}(\[[^\]]*])?(?:\{(.+?)\})?/.exec(line);
    if (frameStart) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, "frame", bodyEnd);
      const text = lines.slice(index + 1, end).map((item) => latexLineWithoutComment(item).trim()).filter(Boolean).join("\n");
      blocks.push({
        kind: "frame",
        line: lineNumber,
        endLine: end + 1,
        options: frameStart[1],
        title: frameStart[2]?.trim() || "Slide",
        text,
      });
      index = end;
      continue;
    }

    const abstractStart = /^\\begin\{abstract\}/.test(line);
    if (abstractStart) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, "abstract", bodyEnd);
      const text = lines
        .slice(index + 1, end)
        .map((item) => latexLineWithoutComment(item).trim())
        .filter(Boolean)
        .join(" ");
      blocks.push({ kind: "abstract", line: lineNumber, endLine: end + 1, text });
      index = end;
      continue;
    }

    const listStart = /^\\begin\{(itemize|enumerate)\}/.exec(line);
    if (listStart) {
      flushParagraph();
      const environment = listStart[1];
      const end = latexEnvironmentEnd(lines, index, environment, bodyEnd);
      const items: string[] = [];
      let currentItem = "";
      for (let itemIndex = index + 1; itemIndex < end; itemIndex += 1) {
        const itemLine = latexLineWithoutComment(lines[itemIndex]).trim();
        if (!itemLine) continue;
        const item = /^\\item(?:\[[^\]]*\])?\s*(.*)/.exec(itemLine);
        if (item) {
          if (currentItem) items.push(currentItem.trim());
          currentItem = item[1] ?? "";
        } else if (currentItem) {
          currentItem = `${currentItem} ${itemLine}`.trim();
        }
      }
      if (currentItem) items.push(currentItem.trim());
      blocks.push({ kind: "list", line: lineNumber, endLine: end + 1, items, ordered: environment === "enumerate", wrapped: true });
      index = end;
      continue;
    }

    const mathEnvironment = /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/.exec(line);
    if (mathEnvironment) {
      flushParagraph();
      const environment = mathEnvironment[1];
      const end = latexEnvironmentEnd(lines, index, environment, bodyEnd);
      const text = lines.slice(index + 1, end).join("\n").trim();
      // Non-starred equation environments are numbered (like Overleaf); capture the
      // first \label so \eqref/\ref can resolve to the running equation number.
      const numbered = !environment.endsWith("*");
      const eqLabel = /\\label\{([^}]+)\}/.exec(text)?.[1];
      blocks.push({ kind: "math", line: lineNumber, endLine: end + 1, text, numbered, eqLabel });
      index = end;
      continue;
    }

    if (/^\\\[\s*$/.test(line)) {
      flushParagraph();
      let end = index + 1;
      while (end < bodyEnd && !/^\\\]\s*$/.test(lines[end].trim())) end += 1;
      const text = lines.slice(index + 1, end).join("\n").trim();
      blocks.push({ kind: "math", line: lineNumber, endLine: Math.min(end + 1, bodyEnd), text });
      index = end;
      continue;
    }

    const inlineDisplayMath = /^\\\[(.*)\\\]$/.exec(line);
    if (inlineDisplayMath) {
      flushParagraph();
      blocks.push({ kind: "math", line: lineNumber, endLine: lineNumber, text: inlineDisplayMath[1].trim() });
      continue;
    }

    if (/^\\begin\{figure\}/.test(line)) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, "figure", bodyEnd);
      const text = lines.slice(index, end + 1).join("\n");
      const image = /\\includegraphics(?:\[[^\]]*\])?\{(.+?)\}/.exec(text)?.[1] ?? "";
      const caption = /\\caption\{(.+?)\}/.exec(text)?.[1] ?? "";
      blocks.push({ kind: "figure", line: lineNumber, endLine: end + 1, caption, image, text });
      index = end;
      continue;
    }

    if (/^\\begin\{table\}/.test(line)) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, "table", bodyEnd);
      const text = lines.slice(index, end + 1).join("\n");
      const { headers, rows } = parseLatexTabular(text);
      blocks.push({ kind: "table", line: lineNumber, endLine: end + 1, headers, rows, text });
      index = end;
      continue;
    }

    const heading = /^\\(chapter|section|subsection|subsubsection)\*?\{(.+?)\}/.exec(line);
    if (heading) {
      flushParagraph();
      const levelMap: Record<string, number> = { chapter: 1, section: 1, subsection: 2, subsubsection: 3 };
      blocks.push({ kind: "heading", line: lineNumber, endLine: lineNumber, level: levelMap[heading[1]] ?? 1, text: heading[2] });
      continue;
    }

    const inlineMath = /^\$([\s\S]+)\$$/.exec(line);
    if (inlineMath) {
      flushParagraph();
      blocks.push({ kind: "math", line: lineNumber, endLine: lineNumber, text: inlineMath[1].trim() });
      continue;
    }

    const tableStart = /^\\begin\{tabular\}\{([^}]*)\}/.exec(line);
    if (tableStart) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, "tabular", bodyEnd);
      const text = lines.slice(index, end + 1).join("\n");
      const { headers, rows } = parseLatexTabular(text);
      blocks.push({
        kind: "table",
        line: lineNumber,
        endLine: end + 1,
        headers,
        rows,
        text,
      });
      index = end;
      continue;
    }

    const theoremLike = /^\\begin\{(theorem|lemma|proposition|corollary|definition|remark|example|proof|claim|conjecture|notation)\}(?:\[([^\]]*)\])?/.exec(line);
    if (theoremLike) {
      flushParagraph();
      const envName = theoremLike[1];
      const label = theoremLike[2] ?? "";
      const end = latexEnvironmentEnd(lines, index, envName, bodyEnd);
      const text = lines.slice(index + 1, end).map((l) => latexLineWithoutComment(l).trim()).filter(Boolean).join(" ");
      blocks.push({ kind: "theorem", line: lineNumber, endLine: end + 1, envName, label, text });
      index = end;
      continue;
    }

    const standaloneFootnote = /^\\footnote\{([\s\S]*)\}$/.exec(line);
    if (standaloneFootnote) {
      flushParagraph();
      blocks.push({ kind: "footnote", line: lineNumber, endLine: lineNumber, text: standaloneFootnote[1].trim() });
      continue;
    }

    const citation = /^\\(?:cite|citet|citep|parencite|textcite)\{([^}]*)\}$/.exec(line);
    if (citation) {
      flushParagraph();
      const keys = splitCitationKeys(citation[1]);
      blocks.push({ kind: "citation", line: lineNumber, endLine: lineNumber, keys, text: line });
      continue;
    }

    const singleCommand = latexSingleArgumentCommand(line);
    const macroPresentation = singleCommand ? visualPresentationForLatexCommand(singleCommand.command, singleCommand.value) : null;
    if (singleCommand && macroPresentation) {
      const text = macroPresentation.prefix
        ? singleCommand.value.slice(macroPresentation.prefix.length).trimStart()
        : singleCommand.value;
      flushParagraph();
      blocks.push({
        kind: "macro",
        line: lineNumber,
        endLine: lineNumber,
        command: singleCommand.command,
        label: macroPresentation.label,
        text,
        prefix: macroPresentation.prefix,
        badge: macroPresentation.badge,
      });
      continue;
    }

    const unknownEnvironment = /^\\begin\{(.+?)\}/.exec(line);
    if (unknownEnvironment) {
      flushParagraph();
      const end = latexEnvironmentEnd(lines, index, unknownEnvironment[1], bodyEnd);
      blocks.push({
        kind: "environment",
        line: lineNumber,
        endLine: end + 1,
        name: unknownEnvironment[1],
        text: lines.slice(index, end + 1).join("\n"),
      });
      index = end;
      continue;
    }

    if (/^\\[A-Za-z]+/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "command", line: lineNumber, endLine: lineNumber, text: line });
      continue;
    }

    if (paragraph.length === 0) paragraphLine = lineNumber;
    paragraph.push(line);
  }

  flushParagraph();
  return { contentBlocks: blocks, preambleBlocks };
}

function latexDisplayText(text: string): string {
  return stripInlineMarkup(text)
    .replace(/\\secbar\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:gd|bd|bad|hl|hlbox|emphbox|strong)\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:textcolor|colorbox)\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\secbar(?:\{[^}]*\})?\{([^}]*)\}/g, "$1")
    .replace(/\\note\{([\s\S]*)\}/g, "$1")
    .replace(/\\(toprule|midrule|bottomrule|hline)\b/g, " ")
    .replace(/\\\\(?:\[[^\]]*])?/g, " ")
    .replace(/\\begin\{[^}]+\}(?:\[[^\]]*])?(?:\{[^}]*\})?/g, "")
    .replace(/\\end\{[^}]+\}/g, "")
    .replace(/\\column(?:\[[^\]]*])?\{[^}]*\}/g, "")
    .replace(/\\(?:centering|raggedright|raggedleft|pause)\b/g, " ")
    .replace(/\\(?:vspace|hspace)\*?\{[^}]*\}/g, " ")
    .replace(/\\setlength\{[^}]*\}\{[^}]*\}/g, " ")
    .replace(/\\item(?:\[[^\]]*])?\s*/g, "")
    .replace(/^\{([\s\S]*)\}$/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderLatexDisplayHtml(text: string): string {
  return renderInlineMarkup(latexDisplayText(text));
}

function stripBeamerTemplateNoise(text: string): string {
  return text
    .replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, "\n")
    .replace(/\\tikz(?:\[[^\]]*])?\{[\s\S]*?\};?/g, "\n")
    .replace(/\\(?:draw|node|path|fill|filldraw|coordinate|matrix)(?:\[[^\]]*])?[\s\S]*?;/g, "\n")
    .replace(/\\(?:onslide|only|uncover|visible|invisible|alt)<[^>]*>/g, "")
    .replace(/\\(?:onslide|only|uncover|visible|invisible)\{([^{}]*)\}/g, "$1");
}

function frameLineIsTemplateNoise(line: string): boolean {
  return (
    /^[{}[\](),;.\s]+$/.test(line) ||
    /^\\\\(?:\[[^\]]*])?$/.test(line) ||
    /^\\(?:pause|centering|raggedright|raggedleft)\b/.test(line) ||
    /^\\(?:titlepage|setlength|addtolength|vspace|hspace|vfill|hfill)\b/.test(line) ||
    /^\\(?:tikzset|pgfplotsset|definecolor|setbeamercolor|setbeamertemplate|usebeamercolor)\b/.test(line) ||
    /^\\(?:node|draw|path|fill|filldraw|coordinate|matrix)\b/.test(line) ||
    /^[\]},;.\s]*(?:line width|rounded corners|draw=|fill=|right=|left=|top=|bottom=|above=|below=|width=|height=|arc=|boxsep=|boxrule=|colback=|colframe=)/.test(line)
  );
}

function inlineLatexCommandContent(line: string): string | null {
  const command = /^\\(?:textbf|textit|emph|alert|structure|gd|bd|bad|hl|hlbox|emphbox|strong|colorbox|fcolorbox|only|uncover|visible|onslide|makebox|parbox|mbox)(?:<[^>]*>)?(?:\[[^\]]*])?(?:\{[^{}]*\})?\{([\s\S]*)\}\s*$/.exec(line);
  return command?.[1]?.trim() || null;
}

function tcolorboxTitle(line: string): string {
  const options = /^\\begin\{tcolorbox\}(?:\[([^\]]*)])?/.exec(line)?.[1] ?? "";
  return /(?:^|,)\s*title\s*=\s*\{?([^,}]+)\}?/.exec(options)?.[1]?.trim() ?? "";
}

function latexEnvironmentContentStart(lines: string[], beginIndex: number, endIndex: number): number {
  let contentStart = beginIndex + 1;
  const beginLine = latexLineWithoutComment(lines[beginIndex]).trim();
  let bracketDepth = (beginLine.match(/\[/g)?.length ?? 0) - (beginLine.match(/]/g)?.length ?? 0);
  while (bracketDepth > 0 && contentStart < endIndex) {
    const line = latexLineWithoutComment(lines[contentStart]).trim();
    bracketDepth += (line.match(/\[/g)?.length ?? 0) - (line.match(/]/g)?.length ?? 0);
    contentStart += 1;
  }
  return contentStart;
}

function parseFrameList(lines: string[], startIndex: number, endIndex: number): string[] {
  const items: string[] = [];
  let currentItem = "";
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = latexLineWithoutComment(lines[index]).trim();
    if (!line || /^\\setlength\b/.test(line)) continue;
    const item = /^\\item(?:\[[^\]]*])?\s*(.*)/.exec(line);
    if (item) {
      if (currentItem) items.push(currentItem.trim());
      currentItem = item[1] ?? "";
    } else if (currentItem) {
      currentItem = `${currentItem} ${line}`.trim();
    }
  }
  if (currentItem) items.push(currentItem.trim());
  return items;
}

function parseFrameTableRows(lines: string[], startIndex: number, endIndex: number): string[][] {
  const body = lines
    .slice(startIndex, endIndex)
    .map((line) => latexLineWithoutComment(line).trim())
    .filter((line) => line && !/^\\(?:toprule|midrule|bottomrule|hline|cline)\b/.test(line))
    .join("\n");
  return body
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) =>
      row
        .split("&")
        .map((cell) => latexDisplayText(cell).replace(/\s+/g, " ").trim())
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);
}

function parseBeamerFrameNodes(text: string): VisualFrameNode[] {
  const lines = stripBeamerTemplateNoise(text).replace(/\r/g, "").split("\n");

  const parseRange = (startIndex: number, endIndex: number): VisualFrameNode[] => {
    const nodes: VisualFrameNode[] = [];
    let paragraph: string[] = [];

    const flushParagraph = () => {
      const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
      if (latexDisplayText(text)) nodes.push({ kind: "paragraph", text });
      paragraph = [];
    };

    for (let index = startIndex; index < endIndex; index += 1) {
      const line = latexLineWithoutComment(lines[index]).trim();
      if (!line) {
        flushParagraph();
        continue;
      }
      if (frameLineIsTemplateNoise(line)) continue;

      const section = /^\\secbar(?:\{[^}]*\})*\{([^}]*)\}/.exec(line);
      if (section) {
        flushParagraph();
        nodes.push({ kind: "section", text: section[1].trim() });
        continue;
      }

      const note = /^\\note\{([\s\S]*)\}$/.exec(line);
      if (note) {
        flushParagraph();
        nodes.push({ kind: "note", text: note[1].trim() });
        continue;
      }
      if (/^\\note\{/.test(line)) {
        flushParagraph();
        const noteLines = [line.replace(/^\\note\{/, "")];
        let depth = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
        while (depth > 0 && index + 1 < endIndex) {
          index += 1;
          const noteLine = latexLineWithoutComment(lines[index]).trim();
          depth += (noteLine.match(/\{/g)?.length ?? 0) - (noteLine.match(/\}/g)?.length ?? 0);
          noteLines.push(noteLine);
        }
        nodes.push({ kind: "note", text: noteLines.join(" ").replace(/}\s*$/, "").trim() });
        continue;
      }

      const mathEnvironment = /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/.exec(line);
      if (mathEnvironment) {
        flushParagraph();
        const environment = mathEnvironment[1];
        const end = latexEnvironmentEnd(lines, index, environment, endIndex);
        nodes.push({ kind: "math", text: lines.slice(index + 1, end).join("\n").trim() });
        index = end;
        continue;
      }

      const listStart = /^\\begin\{(itemize|enumerate)\}/.exec(line);
      if (listStart) {
        flushParagraph();
        const environment = listStart[1];
        const end = latexEnvironmentEnd(lines, index, environment, endIndex);
        nodes.push({ kind: "list", ordered: environment === "enumerate", items: parseFrameList(lines, index + 1, end) });
        index = end;
        continue;
      }

      if (/^\\begin\{tabular\}/.test(line)) {
        flushParagraph();
        const end = latexEnvironmentEnd(lines, index, "tabular", endIndex);
        const rows = parseFrameTableRows(lines, latexEnvironmentContentStart(lines, index, end), end);
        if (rows.length > 0) nodes.push({ kind: "table", rows });
        index = end;
        continue;
      }

      const blockStart = /^\\begin\{(alertblock|exampleblock|block)\}\{([^}]*)\}/.exec(line);
      if (blockStart) {
        flushParagraph();
        const environment = blockStart[1];
        const end = latexEnvironmentEnd(lines, index, environment, endIndex);
        nodes.push({
          kind: "block",
          title: blockStart[2].trim(),
          tone: environment === "alertblock" ? "alert" : environment === "exampleblock" ? "example" : "normal",
          children: parseRange(latexEnvironmentContentStart(lines, index, end), end),
        });
        index = end;
        continue;
      }

      const titledBoxStart = /^\\begin\{(theorem|definition|example|proof|lemma|proposition|corollary|remark)\}(?:\[([^\]]*)\])?/.exec(line);
      if (titledBoxStart) {
        flushParagraph();
        const environment = titledBoxStart[1];
        const end = latexEnvironmentEnd(lines, index, environment, endIndex);
        nodes.push({
          kind: "block",
          title: titledBoxStart[2]?.trim() || environment.replace(/^./, (letter) => letter.toUpperCase()),
          tone: environment === "example" ? "example" : "normal",
          children: parseRange(latexEnvironmentContentStart(lines, index, end), end),
        });
        index = end;
        continue;
      }

      const columnsStart = /^\\begin\{columns\}/.test(line);
      if (columnsStart) {
        flushParagraph();
        const end = latexEnvironmentEnd(lines, index, "columns", endIndex);
        const columns: Array<{ width?: string; children: VisualFrameNode[] }> = [];
        let columnStart = index + 1;
        let columnWidth: string | undefined;

        for (let columnIndex = index + 1; columnIndex < end; columnIndex += 1) {
          const columnLine = latexLineWithoutComment(lines[columnIndex]).trim();
          const column = /^\\column(?:\[[^\]]*])?\{([^}]*)\}/.exec(columnLine);
          if (!column) continue;
          if (columnWidth !== undefined || columnIndex > columnStart) {
            const children = parseRange(columnStart, columnIndex);
            if (children.length > 0) columns.push({ width: columnWidth, children });
          }
          columnWidth = column[1].trim();
          columnStart = columnIndex + 1;
        }
        const children = parseRange(columnStart, end);
        if (children.length > 0) columns.push({ width: columnWidth, children });
        if (columns.length > 0) nodes.push({ kind: "columns", columns });
        index = end;
        continue;
      }

      const wrapperStart = /^\\begin\{(center|tcolorbox|beamercolorbox|minipage|overlayarea|onlyenv|altenv|uncoverenv|visibleenv|actionenv)\}(?:\[[^\]]*])?(?:\{[^}]*\})?/.exec(line);
      if (wrapperStart) {
        flushParagraph();
        const environment = wrapperStart[1];
        const end = latexEnvironmentEnd(lines, index, environment, endIndex);
        const children = parseRange(latexEnvironmentContentStart(lines, index, end), end);
        if (environment === "tcolorbox") nodes.push({ kind: "block", title: tcolorboxTitle(line), tone: "note", children });
        else nodes.push(...children);
        index = end;
        continue;
      }

      const inlineContent = inlineLatexCommandContent(line);
      if (inlineContent) {
        paragraph.push(inlineContent);
        continue;
      }

      if (/^\\end\{/.test(line) || /^\\column\b/.test(line)) continue;
      if (/^\\[A-Za-z]+(?:<[^>]*>)?(?:\[[^\]]*])?(?:\{[^}]*\})?\s*$/.test(line)) continue;

      paragraph.push(line);
    }

    flushParagraph();
    return nodes;
  };

  return parseRange(0, lines.length);
}

// Document-scoped reference tables so inline markup can resolve \cite/\eqref/\ref
// to numbers (like Overleaf) instead of showing raw keys. Set per parsed document
// and read synchronously during that document's block render (single editor).
type DocRefs = {
  cites: Map<string, number>;
  eqs: Map<string, number>;
  // Any labelled reference target (equation, figure, table) → its number, for \ref.
  refs: Map<string, number>;
};
let activeDocRefs: DocRefs = { cites: new Map(), eqs: new Map(), refs: new Map() };

/** Number \begin{figure}/\begin{table} floats in source order (each with its own
 *  counter) and map their \label to the running number, so \ref resolves them. */
function buildFloatNumbers(source: string, env: "figure" | "table"): Map<string, number> {
  const map = new Map<string, number>();
  const lines = source.split("\n");
  const beginRe = new RegExp(`^\\s*\\\\begin\\{${env}\\*?\\}`);
  const endRe = new RegExp(`\\\\end\\{${env}\\*?\\}`);
  let counter = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!beginRe.test(lines[i])) continue;
    counter += 1;
    for (let j = i; j < lines.length; j += 1) {
      const lbl = /\\label\{([^}]+)\}/.exec(lines[j]);
      if (lbl) map.set(lbl[1].trim(), counter);
      if (endRe.test(lines[j])) break;
    }
  }
  return map;
}

function buildCiteNumbers(source: string): Map<string, number> {
  const map = new Map<string, number>();
  const re = /\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const key = match[1].trim();
    if (!map.has(key)) map.set(key, map.size + 1);
  }
  return map;
}

/** Number every non-starred display equation in source order (including ones
 *  nested in theorem/proposition bodies) so numbers and \eqref match Overleaf.
 *  Returns lookup by the 1-based line of `\begin` and by any \label inside it. */
function buildEquationNumbers(source: string): { byLine: Map<number, number>; byLabel: Map<string, number> } {
  const byLine = new Map<number, number>();
  const byLabel = new Map<string, number>();
  const lines = source.split("\n");
  let counter = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const begin = /^\s*\\begin\{(equation|align|gather|multline)(\*?)\}/.exec(lines[i]);
    if (!begin || begin[2] === "*") continue;
    counter += 1;
    byLine.set(i + 1, counter);
    const env = begin[1];
    const endRe = new RegExp(`\\\\end\\{${env}\\*?\\}`);
    for (let j = i; j < lines.length; j += 1) {
      const lbl = /\\label\{([^}]+)\}/.exec(lines[j]);
      if (lbl) byLabel.set(lbl[1].trim(), counter);
      if (endRe.test(lines[j])) break;
    }
  }
  return { byLine, byLabel };
}

function visualDocumentFor(source: string, _path: string | null): VisualDocument {
  const doc = parseLatexVisualDocument(source);
  const { byLine, byLabel } = buildEquationNumbers(source);
  const thmCounters = new Map<string, number>();
  for (const block of doc.contentBlocks) {
    if (block.kind === "math" && block.numbered) {
      block.eqNumber = byLine.get(block.line);
    } else if (block.kind === "theorem") {
      const next = (thmCounters.get(block.envName) ?? 0) + 1;
      thmCounters.set(block.envName, next);
      block.thmNumber = next;
    }
  }
  const figs = buildFloatNumbers(source, "figure");
  const tables = buildFloatNumbers(source, "table");
  activeDocRefs = {
    cites: buildCiteNumbers(source),
    eqs: byLabel,
    refs: new Map([...byLabel, ...figs, ...tables]),
  };
  return doc;
}

/** Render a citation key list to bracketed numbers, e.g. `[1], [3]`. */
function renderCiteKeys(raw: string): string {
  const nums = raw
    .split(",")
    .map((key) => activeDocRefs.cites.get(key.trim()))
    .filter((n): n is number => typeof n === "number");
  if (!nums.length) return `[${escapeHtml(raw)}]`;
  return nums.map((n) => `[${n}]`).join(", ");
}

const LATEX_MATH_SEGMENT_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\))/g;

// Macros KaTeX lacks natively but that are common in papers (and supported by
// Overleaf's MathJax). Without these, e.g. every `\bm{...}` equation would fail
// and fall back to raw source, which is the main "math looks unlike Overleaf".
const KATEX_MACROS: Record<string, string> = {
  "\\bm": "\\boldsymbol{#1}",
  "\\argmin": "\\operatorname*{arg\\,min}",
  "\\argmax": "\\operatorname*{arg\\,max}",
  "\\Tr": "\\operatorname{Tr}",
  "\\diag": "\\operatorname{diag}",
};

/** Normalize a display-equation body so KaTeX renders it like Overleaf's MathJax:
 *  drop numbering-only commands and map amsmath multiline envs KaTeX doesn't know
 *  (`split`) onto the equivalent `aligned`; wrap bare aligned bodies. */
function displayEquationLatex(text: string): string {
  let s = text
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\\(?:notag|nonumber)\b/g, "")
    .replace(/\\begin\{split\}/g, "\\begin{aligned}")
    .replace(/\\end\{split\}/g, "\\end{aligned}")
    .replace(/\\begin\{(align|gather|multline)\*?\}/g, (_m, env) =>
      env === "gather" || env === "multline" ? "\\begin{gathered}" : "\\begin{aligned}")
    .replace(/\\end\{(align|gather|multline)\*?\}/g, (_m, env) =>
      env === "gather" || env === "multline" ? "\\end{gathered}" : "\\end{aligned}")
    .trim();
  const hasEnv = /\\begin\{(aligned|gathered|cases|array|[bBpvV]?matrix|split)\}/.test(s);
  if (!hasEnv && /(?:&|\\\\)/.test(s)) {
    s = `\\begin{aligned}${s}\\end{aligned}`;
  }
  return s;
}

function katexToString(source: string, display: boolean): string {
  return katex.renderToString(source, {
    displayMode: display,
    output: "htmlAndMathml",
    strict: "ignore",
    throwOnError: false,
    trust: false,
    macros: { ...KATEX_MACROS },
  });
}

function renderLatexFormulaHtml(source: string, display: boolean): string {
  const dataSource = escapeHtml(source);
  try {
    const html = katexToString(source.trim(), display);
    return `<span class="typeset-visual-formula${display ? " display" : ""}" data-latex-source="${dataSource}" data-latex-display="${display ? "true" : "false"}">${html}</span>`;
  } catch {
    return `<code class="typeset-visual-formula typeset-visual-math-fallback${display ? " display" : ""}" data-latex-source="${dataSource}" data-latex-display="${display ? "true" : "false"}">${escapeHtml(source)}</code>`;
  }
}

/** Render a display-equation block body as clean, centered typeset math
 *  (matching inline KaTeX and Overleaf) rather than a MathLive input box. */
function renderDisplayEquationHtml(text: string): string {
  try {
    return katexToString(displayEquationLatex(text), true);
  } catch {
    return `<code class="typeset-visual-math-fallback display">${escapeHtml(text)}</code>`;
  }
}

const THEOREM_ENV_RE = /\\begin\{(equation|align|gather|multline)\*?\}([\s\S]*?)\\end\{\1\*?\}|\\\[([\s\S]*?)\\\]/g;

/** Render a theorem/proposition body as typeset text with centered equations,
 *  matching Overleaf, instead of exposing raw LaTeX in a textarea. */
function renderTheoremBodyHtml(text: string): string {
  const body = text.replace(/^\s*\\label\{[^}]*\}\s*/, "").trim();
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  THEOREM_ENV_RE.lastIndex = 0;
  while ((match = THEOREM_ENV_RE.exec(body))) {
    if (match.index > last) {
      const seg = body.slice(last, match.index).trim();
      if (seg) parts.push(`<p class="typeset-visual-theorem-text">${renderInlineMarkup(seg)}</p>`);
    }
    const eq = (match[2] ?? match[3] ?? "").trim();
    parts.push(`<div class="typeset-visual-mathblock static">${renderDisplayEquationHtml(eq)}</div>`);
    last = match.index + match[0].length;
  }
  const tail = body.slice(last).trim();
  if (tail) parts.push(`<p class="typeset-visual-theorem-text">${renderInlineMarkup(tail)}</p>`);
  return parts.join("");
}

function latexMathSegmentSource(value: string): { source: string; display: boolean } {
  if (value.startsWith("$$")) return { source: value.slice(2, -2), display: true };
  if (value.startsWith("\\[")) return { source: value.slice(2, -2), display: true };
  if (value.startsWith("\\(")) return { source: value.slice(2, -2), display: false };
  return { source: value.slice(1, -1), display: false };
}

function renderTextMarkupSegment(text: string): string {
  return escapeHtml(text)
    .replace(/\\textbf\{([^}]+)\}/g, "<strong>$1</strong>")
    .replace(/\\textit\{([^}]+)\}/g, "<em>$1</em>")
    .replace(/\\emph\{([^}]+)\}/g, "<em>$1</em>")
    .replace(/\\underline\{([^}]+)\}/g, "<u>$1</u>")
    .replace(/\\texttt\{([^}]+)\}/g, "<code>$1</code>")
    .replace(/\\textsc\{([^}]+)\}/g, '<span style="font-variant:small-caps">$1</span>')
    .replace(/\\textcolor\{[^}]+\}\{([^}]+)\}/g, "<span>$1</span>")
    .replace(/\\cite\{([^}]+)\}/g, (_m, keys: string) => `<span class="typeset-visual-cite">${renderCiteKeys(keys)}</span>`)
    .replace(/\\footnote\{([^}]+)\}/g, '<span class="typeset-visual-footnote-inline"><sup>*</sup><span>$1</span></span>')
    .replace(/\\eqref\{([^}]+)\}/g, (_m, key: string) => {
      const n = activeDocRefs.eqs.get(key.trim());
      return `<span class="typeset-visual-ref">(${n ?? key})</span>`;
    })
    .replace(/\\ref\{([^}]+)\}/g, (_m, key: string) => {
      const n = activeDocRefs.refs.get(key.trim());
      return `<span class="typeset-visual-ref">${n ?? key}</span>`;
    })
    .replace(/\\(?:quad|qquad|hspace\{[^}]*\})/g, " ")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

function renderInlineMarkup(text: string): string {
  const html: string[] = [];
  let offset = 0;
  for (const match of text.matchAll(LATEX_MATH_SEGMENT_RE)) {
    const index = match.index ?? 0;
    if (index > offset) html.push(renderTextMarkupSegment(text.slice(offset, index)));
    const { source, display } = latexMathSegmentSource(match[0]);
    html.push(renderLatexFormulaHtml(source, display));
    offset = index + match[0].length;
  }
  if (offset < text.length) html.push(renderTextMarkupSegment(text.slice(offset)));
  return html.join("");
}

function replaceLatexFormulaSource(text: string, currentSource: string, nextSource: string): string {
  const current = currentSource.trim();
  for (const match of text.matchAll(LATEX_MATH_SEGMENT_RE)) {
    const { source } = latexMathSegmentSource(match[0]);
    if (source.trim() !== current) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    let replacement = `$${nextSource}$`;
    if (match[0].startsWith("$$")) replacement = `$$${nextSource}$$`;
    else if (match[0].startsWith("\\[")) replacement = `\\[${nextSource}\\]`;
    else if (match[0].startsWith("\\(")) replacement = `\\(${nextSource}\\)`;
    return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  }
  const exactIndex = text.indexOf(currentSource);
  if (exactIndex >= 0) {
    return `${text.slice(0, exactIndex)}${nextSource}${text.slice(exactIndex + currentSource.length)}`;
  }
  return text;
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/\$\^\{([^}]*)\}\$/g, (_, value: string) => `^${value.replace(/\*/g, "").replace(/,+/g, ",").replace(/,$/, "")}`)
    .replace(/\\(?:textbf|textit|emph|underline|texttt|textsc)\{([^}]+)\}/g, "$1")
    .replace(/\\textcolor\{[^}]+\}\{([^}]+)\}/g, "$1")
    .replace(/\\color\{[^}]+\}/g, " ")
    .replace(/\\(?:Huge|huge|LARGE|Large|large|normalsize|small|footnotesize|scriptsize|tiny|bfseries|itshape|slshape|scshape|mdseries|rmfamily|sffamily|ttfamily)\b/g, " ")
    .replace(/\\cite\{([^}]+)\}/g, "[$1]")
    .replace(/\\footnote\{([^}]+)\}/g, "[$1]")
    .replace(/\\ref\{([^}]+)\}/g, "sec. $1")
    .replace(/\\eqref\{([^}]+)\}/g, "($1)")
    .replace(/\\(?:quad|qquad|[hv]space\*?\{[^}]*\})/g, " ")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

function replaceSourceRange(source: string, startLine: number, endLine: number, replacement: string): string {
  const lines = source.split("\n");
  const before = lines.slice(0, Math.max(0, startLine - 1));
  const after = lines.slice(Math.max(startLine, endLine));
  const replacementLines = replacement.replace(/\r/g, "").split("\n");
  return [...before, ...replacementLines, ...after].join("\n");
}

/**
 * Applies toolbar commands at whichever editor's real cursor/selection is
 * current, instead of always inserting near `\end{document}` (the old
 * `insertSourceSnippet` behavior — selecting text and clicking Bold did
 * nothing to that text). `replace` is the only mode-specific part: Code mode
 * splices the whole `draft` string and re-focuses the textarea; Visual mode
 * dispatches an incremental CodeMirror change, mirroring Overleaf's
 * `wrapRanges` (`extensions/toolbar/commands.ts`) minus its Lezer-syntax-tree
 * "detect already-wrapped and unwrap" logic, which needs a real LaTeX grammar
 * we don't have.
 */
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

const HEADING_LINE_RE = /^(\s*)\\(section|subsection|subsubsection|paragraph|subparagraph)\*?\{([\s\S]*?)\}\s*$/;

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
    const [, indent, , arg] = match;
    const replacement = key === "text" ? `${indent}${arg}` : `${indent}\\${key}{${arg}}`;
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

function insertSourceSnippet(source: string, snippet: string, path: string | null): string {
  const cleanSnippet = snippet.replace(/\r/g, "");
  if (extension(path ?? "") !== ".tex") {
    const trimmed = source.endsWith("\n") || source.trim() === "" ? source : `${source}\n`;
    return `${trimmed}${cleanSnippet}`;
  }
  const lines = source.split("\n");
  const endIndex = lines.findIndex((line) => /^\\end\{document\}/.test(line.trim()));
  if (endIndex < 0) {
    const trimmed = source.endsWith("\n") || source.trim() === "" ? source : `${source}\n`;
    return `${trimmed}${cleanSnippet}`;
  }
  const before = lines.slice(0, endIndex);
  const after = lines.slice(endIndex);
  if (before.length > 0 && before[before.length - 1].trim()) before.push("");
  before.push(...cleanSnippet.replace(/\n+$/, "").split("\n"));
  before.push("");
  return [...before, ...after].join("\n");
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

function replaceLatexCommand(source: string, line: number | undefined, command: string, value: string, endLine = line): string {
  if (!line) return source;
  const replacement = `\\${command}{${value.trim()}}`;
  return replaceSourceRange(source, line, endLine ?? line, replacement);
}

function sourceForVisualBlock(block: VisualBlock, value: string, _path: string | null): string {
  const text = value.replace(/\r/g, "").trim();
  if (block.kind === "abstract") {
    return `\\begin{abstract}\n${text}\n\\end{abstract}`;
  }
  if (block.kind === "figure") {
    return `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=.8\\linewidth]{${block.image || "figure.png"}}\n\\caption{${text || "Caption"}}\n\\end{figure}`;
  }
  if (block.kind === "frame") {
    return `\\begin{frame}${block.options ?? ""}{${block.title || "Slide"}}\n${text}\n\\end{frame}`;
  }
  if (block.kind === "heading") {
    const command = block.level <= 1 ? "section" : block.level === 2 ? "subsection" : "subsubsection";
    return `\\${command}{${text || "Untitled"}}`;
  }
  if (block.kind === "list") {
    const items = text.split("\n").map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) return "\\begin{itemize}\n\\item \n\\end{itemize}";
    const environment = block.ordered ? "enumerate" : "itemize";
    const body = items.map((item) => `\\item ${item.replace(/^[-*]\s+/, "").replace(/^\\item\s+/, "")}`).join("\n");
    return block.wrapped ? `\\begin{${environment}}\n${body}\n\\end{${environment}}` : body;
  }
  if (block.kind === "macro") {
    return `\\${block.command}{${block.prefix ?? ""}${text}}`;
  }
  if (block.kind === "math") {
    return `\\[\n${text}\n\\]`;
  }
  if (block.kind === "table") {
    return sourceForTableBlock(block, value);
  }
  if (block.kind === "theorem") {
    const envName = block.envName;
    const label = block.label ? `[${block.label}]` : "";
    return `\\begin{${envName}}${label}\n${text}\n\\end{${envName}}`;
  }
  if (block.kind === "citation") {
    const keys = splitCitationKeys(text || block.keys.join(", "));
    return `\\cite{${keys.join(",")}}`;
  }
  if (block.kind === "footnote") {
    return `\\footnote{${text}}`;
  }
  if (block.kind === "command" || block.kind === "environment") {
    return text || block.text;
  }
  return text;
}

function visualTextareaRows(value: string, minRows = 2, charsPerRow = 48): number {
  const rows = value
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerRow)), 0);
  return Math.min(14, Math.max(minRows, rows));
}

function sameVisualEditValue(left: string, right: string): boolean {
  return left.replace(/\r/g, "").trim() === right.replace(/\r/g, "").trim();
}

function visualBlockText(block: VisualBlock): string {
  if (block.kind === "abstract") return stripInlineMarkup(block.text);
  if (block.kind === "figure") return stripInlineMarkup(block.caption);
  if (block.kind === "frame") return stripInlineMarkup(block.text);
  if (block.kind === "heading") return stripInlineMarkup(block.text);
  if (block.kind === "list") return block.items.map(stripInlineMarkup).join("\n");
  if (block.kind === "macro") return stripInlineMarkup(block.text);
  if (block.kind === "paragraph") return stripInlineMarkup(block.text);
  if (block.kind === "title") return block.title;
  if (block.kind === "table") return tableRowsToVisualValue(block.headers, block.rows);
  if (block.kind === "theorem") return stripInlineMarkup(block.text);
  if (block.kind === "citation") return block.keys.map((k) => `[${k}]`).join(", ");
  if (block.kind === "footnote") return stripInlineMarkup(block.text);
  return block.text;
}

function visualBlockHtml(block: VisualBlock): string | null {
  if (block.kind === "paragraph") return renderInlineMarkup(block.text);
  if (block.kind === "heading") return renderInlineMarkup(block.text);
  if (block.kind === "abstract") return renderInlineMarkup(block.text);
  if (block.kind === "list") return block.items.map((item) => renderInlineMarkup(item)).join("\n");
  if (block.kind === "macro") return renderInlineMarkup(block.text);
  if (block.kind === "figure") return renderInlineMarkup(block.caption);
  if (block.kind === "frame") return renderInlineMarkup(block.text);
  if (block.kind === "theorem") return renderInlineMarkup(block.text);
  if (block.kind === "footnote") return renderInlineMarkup(block.text);
  return null;
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
      ) : (
        <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />
      )}
    </svg>
  );
}

function ToolIcon({ name, className }: { name: "compile" | "save" | "refresh" | "new" | "open" | "minus" | "plus" | "code" | "visual" | "logs" | "files" | "search" | "history" | "settings" | "download" | "home" | "undo" | "redo" | "list" | "figure" | "table" | "citation" | "clear" | "review" | "previous" | "next" | "comments" | "link" | "ref" | "chevron" | "numberedList"; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none">
      {name === "compile" && <path d="M5.2 3.1 12 8l-6.8 4.9z" fill="currentColor" />}
      {name === "save" && (
        <path d="M3 3h8.5L13 4.5V13H3zM5 3v3.2h5.2V3M5.2 10.2h5.6" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      )}
      {name === "refresh" && (
        <path d="M12.6 5.5A5 5 0 1 0 13 8M12.6 2.8v2.7h-2.7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "new" && (
        <path d="M4 2.7h5.2L12 5.5v7.8H4zM9.2 2.7v2.8H12M8 7.3v4M6 9.3h4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "open" && (
        <path d="M5.5 3.2H3.4A1.4 1.4 0 0 0 2 4.6v8A1.4 1.4 0 0 0 3.4 14h8a1.4 1.4 0 0 0 1.4-1.4v-2.1M8.2 2H14v5.8M7.8 8.2 14 2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {name === "minus" && <path d="M4 8h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {name === "plus" && <path d="M8 3.8v8.4M3.8 8h8.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {name === "code" && <path d="m6.3 4-3.5 4 3.5 4M9.7 4l3.5 4-3.5 4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "visual" && <path d="M2.5 8s2-3.6 5.5-3.6S13.5 8 13.5 8s-2 3.6-5.5 3.6S2.5 8 2.5 8zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "logs" && <path d="M3.2 3.2h9.6v9.6H3.2zM5.2 5.6h5.6M5.2 8h5.6M5.2 10.4h3.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "files" && <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12M5.8 8h4.4M5.8 10.2h4.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "search" && <path d="M7.2 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2zM10.2 10.2 13 13" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "history" && <path d="M4.1 5.1A4.8 4.8 0 1 1 3.3 8M4.1 5.1H2.2V3.2M8 5.4v3l2 1.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "settings" && <path d="M8 5.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM8 2.6v1.2M8 12.2v1.2M3.3 4.6l.9.8M11.8 10.6l.9.8M2.6 8h1.2M12.2 8h1.2M3.3 11.4l.9-.8M11.8 5.4l.9-.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "download" && <path d="M8 2.8v6.4M5.4 6.8 8 9.4l2.6-2.6M3.2 12.8h9.6" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "home" && <path d="M2.7 7.3 8 3l5.3 4.3M4.2 6.4v6.1h7.6V6.4M6.7 12.5V9.2h2.6v3.3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "undo" && <path d="M6.8 4.1 3.4 7.5l3.4 3.4M3.8 7.5h5.5a3.4 3.4 0 0 1 0 6.8H7.4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "redo" && <path d="m9.2 4.1 3.4 3.4-3.4 3.4M12.2 7.5H6.7a3.4 3.4 0 0 0 0 6.8h1.9" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "list" && <path d="M5.7 4.5h7M5.7 8h7M5.7 11.5h7M3.2 4.5h.1M3.2 8h.1M3.2 11.5h.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "figure" && <path d="M2.8 3.2h10.4v9.6H2.8zM4.6 10.8l2.6-3 1.9 2.1 1.1-1.2 1.4 2.1M5.4 5.6h.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "table" && <path d="M2.8 3.2h10.4v9.6H2.8zM2.8 6.4h10.4M2.8 9.6h10.4M6.25 3.2v9.6M9.75 3.2v9.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "citation" && <path d="M5.2 5.2H3.5v5.6h3.1V7.9H5.1c0-1.5.7-2.7 2.1-3.6M11.1 5.2H9.4v5.6h3.1V7.9H11c0-1.5.7-2.7 2.1-3.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "clear" && <path d="M4.1 4.1 11.9 12M11.9 4.1 4.1 12" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />}
      {name === "review" && <path d="m3 8.3 3.1 3.1L13 4.6" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "previous" && <path d="M10 4 6 8l4 4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "next" && <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "comments" && <path d="M3 3.5h10v7H7.2L4.2 13v-2.5H3zM5.3 6.1h5.4M5.3 8h3.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "link" && <path d="M9 5.4 10 4.4a2.6 2.6 0 0 1 3.7 3.7l-1.6 1.6a2.6 2.6 0 0 1-3.7 0M7 10.6l-1 1a2.6 2.6 0 0 1-3.7-3.7l1.6-1.6a2.6 2.6 0 0 1 3.7 0M6.2 9.8l3.6-3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "ref" && <path d="M8.7 2.9H12.5a.7.7 0 0 1 .7.7v3.8L7.7 12.6a1 1 0 0 1-1.4 0L3.1 9.4a1 1 0 0 1 0-1.4L8.7 2.9zM10.7 5.3h.01" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "chevron" && <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {name === "numberedList" && <path d="M6.2 4.5h6.8M6.2 8h6.8M6.2 11.5h6.8M2.6 3.2h.8v2.4M2.4 5.6h1.6M2.5 7.6a.7.7 0 0 1 1.2.5c0 .6-1.2.9-1.2 1.6h1.4M2.5 10.2a.65.65 0 1 1 .9.6.65.65 0 0 1-.9.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
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
  return `${source.slice(0, match.start)}${nextText}${source.slice(match.end)}`;
}

function escapeDirectLatexText(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
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
  const rootName = basename(rootPath) || basename(projectPath) || "Project";

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
      setError("Enter a file or folder name without path separators.");
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
      setError(`Could not copy path: ${String(copyError)}`);
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
    const openable = entry.isDir || ext === ".tex" || ext === ".pdf";
    return (
      <div key={entry.path}>
        <button
          type="button"
          className={`typeset-tree-row entity-name${entry.isDir ? " folder" : " file"}${sourceActive ? " active selected" : ""}${previewActive ? " preview-active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          title={openable ? entry.path : `${entry.path}\nRight-click for file actions.`}
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
                Loading
              </div>
            )}
            {!loading.has(entry.path) && nested.length === 0 && children[entry.path] && (
              <div className="typeset-tree-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 34}px` }}>
                Empty
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
    <aside className="typeset-sidebar file-tree ide-react-file-tree-panel editor-sidebar" aria-label="Typesetting files">
      <div className="file-tree-toolbar typeset-sidebar-head">
        <div className="file-tree-expand-collapse-button">
          <ToolIcon name="chevron" className="file-tree-expand-icon" />
          <h4>File tree</h4>
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
            {loading.has(rootPath) && <div className="typeset-tree-muted root">Loading</div>}
            {rootChildren.map((entry) => renderEntry(entry, 0))}
          </div>
        )}
      </div>
      {rowMenu && typeof document !== "undefined" && createPortal(
        <div
          className="typeset-tree-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          aria-label="File actions"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void copyPath(rowMenu.entry.path)}>
            Copy path
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void duplicateEntry(rowMenu.entry)}>
            Duplicate
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
            Show in folder
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => openRenameDialog(rowMenu.entry)}>
            Rename
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
            Delete
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
            <h3 id="typeset-rename-title">Rename {renameTarget.isDir ? "folder" : "file"}</h3>
            <label>
              Name
              <input
                ref={renameInputRef}
                value={renameValue}
                disabled={operationBusy}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </label>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setRenameTarget(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={operationBusy || !renameValue.trim()}>Rename</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {deleteTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <div className="typeset-file-dialog" role="alertdialog" aria-modal="true" aria-labelledby="typeset-delete-title">
            <h3 id="typeset-delete-title">Delete {deleteTarget.isDir ? "folder" : "file"}?</h3>
            <p><strong>{deleteTarget.name}</strong> will be permanently deleted.</p>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="danger" disabled={operationBusy} onClick={() => void deleteEntry()}>Delete</button>
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

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  estimatedSize?: { width: number; height: number };
  onSourceTextClick: (text: string, context: string) => void;
  editable?: boolean;
  onTextObjectEdit?: (change: PdfTextObjectChange, nextText: string) => void;
  onTextObjectMove?: (change: PdfTextObjectChange) => void;
  onPageSize?: (width: number, height: number) => void;
  pageRef?: (page: number, el: HTMLDivElement | null) => void;
  highlight?: PdfPageHighlight | null;
}

function multiplyPdfTransform(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function textRunsFromPdfContent(textContent: unknown, viewport: { transform: number[] }, zoom: number): PdfTextRun[] {
  const items = Array.isArray((textContent as { items?: unknown[] }).items) ? (textContent as { items: unknown[] }).items : [];
  return items.flatMap((item, index) => {
    const textItem = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
    const text = normalizePdfText(typeof textItem.str === "string" ? textItem.str : "");
    const transform = Array.isArray(textItem.transform) ? textItem.transform : null;
    if (!text || !transform || transform.length < 6) return [];
    const matrix = multiplyPdfTransform(viewport.transform, transform as number[]);
    const fontSize = Math.max(6, Math.hypot(matrix[2], matrix[3]));
    const width = Math.max(8, (typeof textItem.width === "number" ? textItem.width : text.length * fontSize * 0.45) * zoom);
    const height = Math.max(8, (typeof textItem.height === "number" ? textItem.height * zoom : fontSize));
    return [{
      id: `${index}:${text}`,
      text,
      left: matrix[4],
      top: matrix[5] - height,
      width,
      height,
      fontSize,
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
        const viewport = pdfPage.getViewport({ scale: zoom });
        setPageSize({ width: viewport.width, height: viewport.height });
        onPageSize?.(viewport.width / zoom, viewport.height / zoom);
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable.");
        // Render the backing store at the device pixel ratio so the PDF stays
        // crisp and identical across a plain browser and the Tauri WebView2
        // window (which can run at a different Windows display scale / DPR).
        const requestedOutputScale = window.devicePixelRatio || 1;
        const pagePixels = Math.max(1, viewport.width * viewport.height);
        const pixelBudgetScale = Math.sqrt(PDF_CANVAS_MAX_PIXELS / pagePixels);
        const outputScale = Math.min(requestedOutputScale, Math.max(0.01, pixelBudgetScale));
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        const task = pdfPage.render({ canvas, canvasContext: context, viewport, transform });
        renderTask.current = task;
        return Promise.all([task.promise, pdfPage.getTextContent()]).then(([, textContent]) => {
          if (disposed) return;
          const runs = textRunsFromPdfContent(textContent, viewport, zoom);
          setTextRuns(runs.map((run) => ({ ...run, ...samplePdfTextColors(canvas, run, outputScale) })));
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

  return (
    <div
      className="typeset-pdf-page"
      ref={(el) => pageRef?.(page, el)}
      style={!pageSize && estimatedSize ? {
        width: `${estimatedSize.width * zoom}px`,
        height: `${estimatedSize.height * zoom}px`,
      } : undefined}
    >
      <canvas ref={canvasRef} aria-label={`PDF page ${page}`} />
      {pageSize && (
        <div
          className="typeset-pdf-text-layer"
          style={{ width: `${pageSize.width}px`, height: `${pageSize.height}px` }}
          aria-label={`PDF text layer page ${page}`}
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
                  aria-label={`Edit slide text: ${displayed.text}`}
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
                title={editable ? "Drag to move · double-click to edit" : "Jump to source"}
                aria-label={editable ? `Slide text object: ${displayed.text}` : `Jump to source text: ${displayed.text}`}
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
                  onSourceTextClick(run.text, context);
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
  onSourceTextClick: (text: string, context: string) => void;
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
    void Promise.all([fileReadBytes(path), import("pdfjs-dist")])
      .then(([bytes, pdfjs]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
        return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      })
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
    const escaped = escapeDirectLatexText(nextText);
    // Scope to the current frame first (mirrors moveTextObject/openSourceForText)
    // so editing or deleting a slide's text object can't match and mutate the
    // same wording on a different slide earlier in the document.
    const nextFrameSource = editPdfTextInLatex(frameSource, change.text, change.context, escaped);
    if (nextFrameSource != null) {
      onChangeSource(`${source.slice(0, frameRange.start)}${nextFrameSource}${source.slice(frameRange.end)}`);
      return;
    }
    const nextSource = editPdfTextInLatex(source, change.text, change.context, escaped);
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
    <section className="typeset-compiled-visual typeset-visual-pane" aria-label="Compiled slide visual editor">
      <div className="typeset-slide-canvas-toolbar">
        <div className="typeset-slide-canvas-identity">
          <span>Slide {safePage}{pdf ? ` / ${pdf.numPages}` : ""}</span>
          <strong>{slide?.title || "Compiled slide"}</strong>
          <span className="typeset-slide-direct-mode">Direct edit</span>
          <em className={dirty ? "stale" : "current"} role="status">
            {dirty ? "Draft · save to update preview" : "Compiled preview"}
          </em>
        </div>
        <div className="typeset-slide-canvas-actions" aria-label="Slide canvas controls">
          <button
            type="button"
            className="zoom-step"
            title="Zoom out"
            aria-label="Zoom out slide"
            onClick={() => changeZoom(-0.1)}
          >
            <ToolIcon name="minus" />
          </button>
          <button
            type="button"
            className={fitMode ? "active fit" : "fit"}
            title="Fit slide to canvas"
            aria-label="Fit slide to canvas"
            aria-pressed={fitMode}
            onClick={() => {
              setFitMode(true);
              void fitSlide();
            }}
          >
            Fit <span>{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            className="zoom-step"
            title="Zoom in"
            aria-label="Zoom in slide"
            onClick={() => changeZoom(0.1)}
          >
            <ToolIcon name="plus" />
          </button>
          <span className="typeset-slide-canvas-divider" />
          <button
            type="button"
            className="add-text"
            title="Add a draggable text object"
            aria-label="Add text object"
            disabled={compiling}
            onClick={addTextObject}
          >
            <ToolIcon name="plus" />
            Add text
          </button>
          {focused && (
            <button
              type="button"
              className={deckOpen ? "active deck" : "deck"}
              title={deckOpen ? "Hide slide list" : "Show slide list"}
              aria-label={deckOpen ? "Hide slide list" : "Show slide list"}
              aria-pressed={deckOpen}
              onClick={() => setDeckOpen((open) => !open)}
            >
              <ToolIcon name="list" />
              Slides
            </button>
          )}
          <button
            type="button"
            className={focused ? "active focus" : "focus"}
            title={focused ? "Restore project and PDF panels" : "Hide surrounding panels and focus the slide"}
            aria-label={focused ? "Exit slide focus" : "Focus slide canvas"}
            aria-pressed={focused}
            onClick={onToggleFocus}
          >
            <ToolIcon name="visual" />
            {focused ? "Exit focus" : "Focus"}
          </button>
          <button
            type="button"
            className={sourceOpen ? "active source" : "source"}
            aria-label={sourceOpen ? "Close slide source" : "Edit slide source"}
            aria-pressed={sourceOpen}
            onClick={() => setSourceOpen((open) => !open)}
          >
            <ToolIcon name="code" />
            {sourceOpen ? "Close source" : "Edit source"}
          </button>
        </div>
      </div>
      <div className={`typeset-slide-workspace${focused && deckOpen ? " deck-open" : ""}${sourceOpen ? " source-open" : ""}`}>
        {focused && deckOpen && (
          <nav className="typeset-slide-deck" aria-label="幻灯片大纲">
            <header>
              <div>
                <span>Presentation</span>
                <strong>{slides.length} slides</strong>
              </div>
              <span className={dirty ? "stale" : "current"}>{dirty ? "Draft" : "Synced"}</span>
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
                    aria-label={`Open slide ${index + 1}: ${item.title}`}
                    onClick={() => onNavigateToLine(item.line)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.title || `Slide ${index + 1}`}</strong>
                    {active && <i aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </nav>
        )}
        <div className="typeset-compiled-visual-scroll" ref={scrollRef}>
          {!path && <div className="typeset-empty">Compile the slide deck to open the Visual canvas.</div>}
          {path && loading && <div className="typeset-empty">Loading compiled slide...</div>}
          {path && error && <PdfFallbackPage error={error} outputPath={path} sourcePath={null} />}
          {pdf && !error && (
            <div
              className="typeset-slide-stage"
              role="group"
              tabIndex={0}
              aria-label={`Slide ${safePage} canvas. Use left and right arrow keys to change slides.`}
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
              <span className="typeset-slide-click-hint">Select · drag to move · double-click to edit · F2 to rename</span>
            </div>
          )}
        </div>
        {sourceOpen && (
          <aside className="typeset-slide-source-drawer" aria-label="Current slide source editor">
            <header>
              <div>
                <span>Current frame</span>
                <strong>{slide?.title || `Slide ${safePage}`}</strong>
              </div>
              <button
                type="button"
                title="Open full Code editor"
                onClick={() => selectedSourceRange
                  ? onOpenCodeRange(selectedSourceRange.start, selectedSourceRange.end)
                  : onOpenCodeAtLine(slide?.line ?? 1)}
              >
                Full editor
              </button>
            </header>
            <textarea
              ref={sourceEditorRef}
              value={frameSource}
              aria-label="LaTeX source for current slide"
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
                Lines {slide?.line ?? 1}–{slide?.endLine ?? 1} · {frameLineCount} lines · {frameSource.length} chars
                <kbd>Ctrl S</kbd>
              </span>
              <button type="button" disabled={!dirty || compiling} onClick={onSave}>
                <ToolIcon name="save" />
                {compiling ? "Compiling…" : dirty ? "Save & update preview" : "Preview is current"}
              </button>
            </footer>
          </aside>
        )}
      </div>
    </section>
  );
}

function PdfFallbackPage({ error, outputPath, sourcePath }: { error: string; outputPath: string | null; sourcePath: string | null }) {
  return (
    <div className="typeset-pdf-unavailable" role="status" aria-label="Compiled PDF unavailable">
      <ToolIcon name="logs" />
      <strong>Compiled PDF unavailable</strong>
      <span>{outputPath || outputPathFor(sourcePath || DEFAULT_SOURCE_PATH)}</span>
      <p>Recompile the LaTeX source to produce a PDF, then this panel will show the compiled output.</p>
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
  const zoomRef = useRef(zoom);
  const pendingWheelZoomRef = useRef<number | null>(null);
  const wheelZoomTimerRef = useRef<number | null>(null);
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
    showPagesAround(currentPage);
  }, [currentPage, showPagesAround]);

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
    userZoomedRef.current = false;
    setPdf(null);
    setNumPages(0);
    setPageSizes({});
    setRenderRange({ start: 1, end: 3 });
    setCurrentPage(1);
    setPageDraft("1");
    setError(null);
    if (!path) return () => undefined;
    setLoading(true);
    void Promise.all([fileReadBytes(path), import("pdfjs-dist")])
      .then(([bytes, pdfjs]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
        return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      })
      .then((document) => {
        loadedPdf = document;
        if (disposed) {
          void document.destroy();
          return;
        }
        setPdf(document);
        setNumPages(document.numPages);
        setRenderRange({ start: 1, end: Math.min(3, document.numPages) });
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

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!pdf || !scroll || numPages < 1) return;
    let frame = 0;
    const updateCurrentPage = () => {
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
          start: Math.max(visibleStart, nextPage - radius),
          end: Math.min(visibleEnd, nextPage + radius),
        };
        setRenderRange((range) => (
          range.start === nextRange.start && range.end === nextRange.end ? range : nextRange
        ));
      }
    };
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateCurrentPage);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [numPages, pdf, zoom]);

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

  const statusText = dirty ? "Unsaved changes" : compileStatusText(status, result);

  return (
    <section
      className={`typeset-preview pdf${!path ? " pdf-empty" : ""}`}
      aria-label="PDF preview"
      aria-keyshortcuts="ArrowLeft ArrowRight"
    >
      <div className="typeset-preview-toolbar toolbar toolbar-pdf toolbar-pdf-hybrid">
        <div className="typeset-pdf-left toolbar-pdf-left">
          <span className="typeset-pdf-panel-label">Compiled PDF</span>
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
                {status === "running" ? "Stop compilation" : "Recompile"}
              </span>
            </button>
            <button
              type="button"
              className="typeset-compile-options compile-dropdown-toggle"
              title="Compile options"
              aria-label="Compile options"
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
                aria-label="Compile options menu"
                style={compileMenuPosition}
              >
                <div className="typeset-compile-menu-section" role="presentation">
                  <span>Compile error handling</span>
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
                    <strong>Stop on first error</strong>
                    <small>Fail fast and preserve the last verified PDF.</small>
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
                    <strong>Try to compile despite errors</strong>
                    <small>Show a newly generated PDF when TeX can recover; it remains marked as having errors.</small>
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
                      <strong>Stop compilation</strong>
                      <small>Cancel the active TeX process and keep the last verified PDF.</small>
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
                    <strong>Clear cache &amp; recompile</strong>
                    <small>Remove LaTeX auxiliary files, then rebuild the PDF.</small>
                  </span>
                </button>
              </div>,
              document.body,
            )}
          </div>
          <button
            type="button"
            className={`typeset-log-toggle pdf-toolbar-btn log-btn${logOpen ? " active" : ""}`}
            title="Compile log"
            aria-label="Compile log"
            onClick={onToggleLog}
          >
            <ToolIcon name="logs" />
            {diagnosticsCount > 0 && <span>{diagnosticsCount}</span>}
          </button>
          {statusText && <span className={`typeset-pdf-status ${status}`}>{statusText}</span>}
          {result?.pdfState === "stale" && (
            <span className="typeset-pdf-status stale" role="status">Showing last verified PDF</span>
          )}
          {result?.pdfState === "missing" && (
            <span className="typeset-pdf-status error" role="status">No PDF was produced by this build</span>
          )}
          {forwardSearchNotice && <span className="typeset-pdf-status error" role="status">{forwardSearchNotice}</span>}
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : "Preview"}</span>
          <div className="typeset-pdf-page-control" aria-label="PDF page navigation">
            <input
              type="text"
              inputMode="numeric"
              value={pageDraft}
              aria-label="Current PDF page"
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
            <span aria-label={`${numPages} PDF pages`}>/ {numPages || 0}</span>
          </div>
          <div className="toolbar-pdf-controls pdfjs-viewer-controls-small">
            <button
              ref={zoomMenuRef}
              type="button"
              className="typeset-zoom-label pdfjs-zoom-dropdown-button"
              title="Choose PDF zoom"
              aria-label={`PDF zoom ${Math.round(zoom * 100)}%`}
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
              aria-label="PDF zoom menu"
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
                  aria-label="PDF zoom percentage"
                  onChange={(event) => setZoomDraft(event.currentTarget.value.replace(/[^0-9.]/g, ""))}
                />
                <span>%</span>
              </form>
              <button type="button" role="menuitem" onClick={() => void fitPdf("width")}>Fit to width</button>
              <button type="button" role="menuitem" onClick={() => void fitPdf("height")}>Fit to height</button>
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
          <button type="button" className="typeset-icon-btn pdf-open-external" title="Open PDF externally" aria-label="Open PDF externally" disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          {onHide && (
            <button type="button" className="typeset-icon-btn pdf-hide-preview" title="Hide PDF preview" aria-label="Hide PDF preview" onClick={onHide}>
              <ToolIcon name="next" />
            </button>
          )}
        </div>
      </div>
      <div
        className="typeset-pdf-scroll"
        ref={scrollRef}
        onWheel={handlePdfWheel}
      >
        {!path && <div className="typeset-empty">No PDF selected.</div>}
        {path && loading && <div className="typeset-empty">Loading PDF...</div>}
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
                aria-label={`PDF page ${page} placeholder`}
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
  const text = status === "running"
    ? [error, liveLog?.stderr, liveLog?.stdout].filter(Boolean).join("\n\n").trim()
    : [error, result?.stderr, result?.stdout].filter(Boolean).join("\n\n").trim();
  const pdfState = result?.pdfState ?? (result?.success ? "fresh" : result?.partialOutput ? "partial" : "missing");
  const sourceHash = result?.rootSourceHash ?? "";
  const buildTime = result?.compiledAtUnixMs ? new Date(result.compiledAtUnixMs).toLocaleTimeString() : "not recorded";
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
    { id: "all", label: "All logs", count: diagnostics.length },
    { id: "error", label: "Errors", count: counts.error },
    { id: "warning", label: "Warnings", count: counts.warning },
    { id: "info", label: "Info", count: counts.info },
  ];

  const diagnosticLocation = (diagnostic: LatexDiagnostic) => diagnostic.filePath
    ? `${diagnostic.filePath}${diagnostic.line ? `, ${diagnostic.line}` : ""}`
    : diagnostic.line ? `line ${diagnostic.line}` : "No source location";
  const canOpenDiagnostic = (diagnostic: LatexDiagnostic) => Boolean(
    onDiagnosticClick && (diagnostic.filePath || diagnostic.line),
  );
  const diagnosticGuidance = (diagnostic: LatexDiagnostic) => {
    if (diagnostic.code === "table_alignment") {
      return "An alignment character (&) was used outside a table or alignment environment. Escape it as \\& when it is ordinary text.";
    }
    if (/citation .*undefined/i.test(diagnostic.message)) {
      return "The citation key is not available in the active bibliography. Check the .bib entry and the bibliography declaration.";
    }
    return diagnostic.severity === "error"
      ? "Open the source location, make the smallest correction, then recompile."
      : "This does not necessarily stop the PDF build, but it is worth reviewing at the reported source location.";
  };
  const diagnosticExcerpt = (diagnostic: LatexDiagnostic) => {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return "No compiler output was captured for this diagnostic.";
    const message = diagnostic.message.toLocaleLowerCase();
    const match = lines.findIndex((line) => line.toLocaleLowerCase().includes(message));
    const start = match < 0 ? 0 : Math.max(0, match - 1);
    return lines.slice(start, start + 9).join("\n");
  };

  return (
    <section className={`typeset-log new-logs-pane ${status === "error" ? "error" : ""}`} aria-label="Compile log">
      <div className="typeset-log-tabs" role="tablist" aria-label="Compile log filters">
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
          <div className="typeset-diagnostics typeset-diagnostics-accordion" aria-label="LaTeX diagnostics">
            {filteredDiagnostics.map(({ diagnostic, id, level }) => {
              const expanded = expandedDiagnosticId === id;
              const openable = canOpenDiagnostic(diagnostic);
              return (
                <article key={id} className={`typeset-diagnostic-card ${level} ${expanded ? "expanded" : ""}`}>
                  <div className="typeset-diagnostic-summary">
                    <button
                      type="button"
                      className="typeset-diagnostic-expand"
                      aria-label={`${expanded ? "Collapse" : "Expand"} diagnostic: ${diagnostic.message}`}
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
                        aria-label={`Open ${diagnosticLocation(diagnostic)}`}
                        title="Open source location"
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
            {diagnostics.length ? "No logs match this filter." : status === "running" ? "Waiting for TeX Live output..." : "No diagnostics."}
          </div>
        )}
        <details className="typeset-raw-logs">
          <summary>
            <ToolIcon name="chevron" />
            <span>Raw logs</span>
          </summary>
          <pre>{text || (status === "running" ? "Waiting for TeX Live output..." : "No compiler output was captured.")}</pre>
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
            <span>Clear cached files</span>
          </button>
        )}
        <details className="typeset-log-build-details">
          <summary>
            <span>Other logs and files</span>
            <ToolIcon name="chevron" />
          </summary>
          <div className="typeset-build-provenance" aria-label="PDF build provenance">
            <span>PDF: {pdfState}</span>
            <span>Built {buildTime}</span>
            <code title={sourceHash}>inputs {sourceHash.slice(0, 12) || "unavailable"}</code>
          </div>
        </details>
      </footer>
    </section>
  );
}

function TypesetOutlinePanel({
  activeLine,
  collapsed,
  outline,
  height,
  onJumpToLine,
  onResizeKeyDown,
  onResizePointerDown,
  onToggleCollapsed,
}: {
  activeLine: number | null;
  collapsed: boolean;
  outline: NumberedOutlineItem[];
  height: number | null;
  onJumpToLine: (line: number) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleCollapsed: () => void;
}) {
  if (collapsed) {
    return (
      <section className="typeset-outline-collapsed" aria-label="文档大纲">
        <button type="button" onClick={onToggleCollapsed}>
          <ToolIcon name="list" />
          <span>大纲</span>
          <em>{outline.length}</em>
        </button>
      </section>
    );
  }

  const flexBasis = height == null ? "33.333%" : `${height}px`;
  const panelStyle = { flexBasis, flexShrink: height == null ? 1 : 0 };
  const resizeHandle = (
    <div
      className="typeset-outline-resize"
      role="separator"
      aria-label="调整大纲大小"
      aria-orientation="horizontal"
      aria-valuemin={OUTLINE_PANEL_MIN_H}
      aria-valuemax={OUTLINE_PANEL_MAX_H}
      aria-valuenow={height ?? undefined}
      aria-valuetext={height == null ? "侧边栏高度的三分之一" : `${height} 像素`}
      title="拖动调整大纲大小"
      tabIndex={0}
      onKeyDown={onResizeKeyDown}
      onPointerDown={onResizePointerDown}
    >
      <span aria-hidden="true" />
    </div>
  );

  if (outline.length === 0) {
    return (
      <>
        {resizeHandle}
        <section className="typeset-outline empty" aria-label="文档大纲" style={panelStyle}>
          <div className="typeset-outline-head">
            <strong>大纲</strong>
            <span>0</span>
            <button type="button" className="typeset-outline-toggle" title="隐藏大纲" aria-label="隐藏大纲" onClick={onToggleCollapsed}>
              <ToolIcon name="clear" />
            </button>
          </div>
          <span className="typeset-outline-empty">未找到章节。</span>
        </section>
      </>
    );
  }

  return (
    <>
      {resizeHandle}
      <section className="typeset-outline" aria-label="文档大纲" style={panelStyle}>
      <div className="typeset-outline-head">
        <strong>大纲</strong>
        <span>{outline.length}</span>
        <button type="button" className="typeset-outline-toggle" title="隐藏大纲" aria-label="隐藏大纲" onClick={onToggleCollapsed}>
          <ToolIcon name="clear" />
        </button>
      </div>
      <div className="typeset-outline-list">
        {outline.map((item) => (
          <button
            key={`${item.line}:${item.title}`}
            type="button"
            className={activeLine === item.line ? "active" : ""}
            aria-current={activeLine === item.line ? "location" : undefined}
            data-level={Math.min(item.level, 4)}
            style={{ paddingLeft: `${8 + (item.level - 1) * 14}px` }}
            onClick={() => onJumpToLine(item.line)}
          >
            <span><b>{item.number}</b>{item.title}</span>
            <em>{item.line}</em>
          </button>
        ))}
      </div>
    </section>
    </>
  );
}

function FigurePreview({ image }: { image: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!image) {
      setSrc(null);
      setError(false);
      return;
    }
    let disposed = false;
    setError(false);
    setSrc(null);
    fileReadBytes(image)
      .then((bytes) => {
        if (disposed) return;
        const ext = image.toLowerCase();
        const mime = ext.endsWith(".png") ? "image/png"
          : ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg"
          : ext.endsWith(".gif") ? "image/gif"
          : ext.endsWith(".svg") ? "image/svg+xml"
          : ext.endsWith(".webp") ? "image/webp"
          : "application/octet-stream";
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        setSrc(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => { disposed = true; };
  }, [image]);

  if (!image) {
    return (
      <div className="typeset-visual-figure-frame">
        <span>figure</span>
      </div>
    );
  }

  if (src) {
    return (
      <div className="typeset-visual-figure-frame has-image">
        <img src={src} alt={image} style={{ maxWidth: "100%", maxHeight: 260, objectFit: "contain" }} />
        <span className="typeset-visual-figure-name">{image}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="typeset-visual-figure-frame">
        <span>{image} (not found)</span>
      </div>
    );
  }

  return (
    <div className="typeset-visual-figure-frame">
      <span>Loading {image}...</span>
    </div>
  );
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

const VISUAL_SECTION_LEVELS: Array<{ key: string; label: string }> = [
  { key: "text", label: "Normal text" },
  { key: "section", label: "Section" },
  { key: "subsection", label: "Subsection" },
  { key: "subsubsection", label: "Subsubsection" },
  { key: "paragraph", label: "Paragraph" },
  { key: "subparagraph", label: "Subparagraph" },
];

const SOMNIQ_BIBLIOGRAPHY_STEM = "somniq-references";
const SOMNIQ_BIBLIOGRAPHY_FILE = `${SOMNIQ_BIBLIOGRAPHY_STEM}.bib`;
const SOMNIQ_BIBLIOGRAPHY_HEADER = "% SomniQ managed bibliography — do not edit this file directly.\n";

function bibliographyPathForSource(sourcePath: string): string {
  const segments = sourcePath.replace(/\\/g, "/").split("/");
  segments.pop();
  return [...segments, SOMNIQ_BIBLIOGRAPHY_FILE].filter(Boolean).join("/") || SOMNIQ_BIBLIOGRAPHY_FILE;
}

function sourceUsesSomniqBibliography(source: string): boolean {
  return source.includes(SOMNIQ_BIBLIOGRAPHY_STEM);
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
  const biblatex = /\\addbibresource\s*\{([^}]+)\}/;
  const bibtex = /\\bibliography\s*\{([^}]+)\}/;
  const hasManagedResource = (value: string) => value.split(",").some((item) => item.trim().replace(/\.bib$/i, "") === SOMNIQ_BIBLIOGRAPHY_STEM);
  const usesBiblatex = /\\usepackage(?:\s*\[[^\]]*\])?\s*\{biblatex\}/.test(source) || biblatex.test(source);
  if (usesBiblatex) {
    let next = source;
    if (!sourceUsesSomniqBibliography(next)) {
      // \addbibresource belongs in the preamble. Keep any user resources intact
      // and register SomniQ's separate generated file alongside them.
      next = biblatex.test(next)
        ? next.replace(biblatex, (whole, resource: string) =>
            hasManagedResource(resource) ? whole : `${whole}\n\\addbibresource{${SOMNIQ_BIBLIOGRAPHY_FILE}}`,
          )
        : insertBeforeDocument(next, `% SomniQ bibliography (managed)\n\\addbibresource{${SOMNIQ_BIBLIOGRAPHY_FILE}}`);
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
      <section className="typeset-citation-picker" role="dialog" aria-modal="true" aria-label="Insert library citation" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>SomniQ Literature</span><strong>Insert citation</strong></div>
          <button type="button" aria-label="Close citation picker" onClick={onClose}>×</button>
        </header>
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search title, author, DOI, or key"
          aria-label="Search literature for citation"
        />
        <div className="typeset-citation-results" role="listbox" aria-label="Library papers">
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
                <span><strong>{paper.title}</strong><em>{paper.authors.join(", ") || "Unknown author"}{paper.year ? ` · ${paper.year}` : ""}</em></span>
                <code>{paper.citationKey || suggestedCitationKey(paper)}</code>
              </button>
            );
          })}
          {visible.length === 0 && <p>No matching library papers.</p>}
        </div>
        {error && <p className="typeset-citation-error" role="status">{error}</p>}
        <footer>
          <span>{selected.size} selected</span>
          <div><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="primary" onClick={() => void confirm()} disabled={busy || selected.size === 0}>{busy ? "Preparing…" : "Insert \\cite{}"}</button></div>
        </footer>
      </section>
    </div>
  );
}

function TypesetEditorToolbar({
  activeOutlineItem,
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
    if (!adapter) throw new Error("The editor selection is no longer available.");
    const keys = await onPrepareCitationKeys(ids);
    if (keys.length === 0) throw new Error("The selected papers do not have usable citation keys.");
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
    <div className={`typeset-visual-toolbar ol-cm-toolbar-wrapper${safeCompiledVisual ? " safe-visual" : ""}`} aria-label="Editor tools">
      <div className="typeset-visual-toolbar-row ol-cm-toolbar toolbar-editor" role="toolbar" aria-label="Editor toolbar">
        {safeCompiledVisual && (
          <div className="typeset-safe-visual-toolbar">
            <ToolIcon name="visual" />
            <strong>Compiled slide preview</strong>
            <span>Click visible text to edit its exact LaTeX source.</span>
            <button
              type="button"
              onClick={() => onEditSlideSource((activeSlide ?? slides[0]).line)}
            >
              Edit slide source
            </button>
          </div>
        )}
        <div className="ol-cm-toolbar-button-group" aria-label="Undo Redo actions">
          <button type="button" className="ol-cm-toolbar-button" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><ToolIcon name="undo" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><ToolIcon name="redo" /></button>
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={dirty ? (mode === "visual" ? "Save and update preview" : "Save") : "No unsaved changes"}
            aria-label="Save"
            disabled={saving || compiling || !dirty}
            onClick={onSave}
          >
            <ToolIcon name="save" />
          </button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label="Text formatting">
          <VisualToolbarMenu
            label="Section heading"
            wide
            icon={<><span className="typeset-visual-text-icon">H</span><ToolIcon name="chevron" /></>}
          >
            {VISUAL_SECTION_LEVELS.map((level) => (
              <VisualMenuItem
                key={level.key}
                label={level.label}
                onSelect={() => insertSection(level.key, level.label)}
              />
            ))}
          </VisualToolbarMenu>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label="Text style">
          <button type="button" className="ol-cm-toolbar-button" title="Bold" aria-label="Bold" onClick={insertBold}><strong className="typeset-visual-text-icon">B</strong></button>
          <button type="button" className="ol-cm-toolbar-button" title="Italic" aria-label="Italic" onClick={insertItalic}><em className="typeset-visual-text-icon">I</em></button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label="Insert math and symbols">
          <VisualToolbarMenu label="Insert math" icon={<span className="typeset-visual-text-icon">&Sigma;</span>}>
            <VisualMenuItem label="Inline" icon={<span className="typeset-visual-text-icon">$x$</span>} onSelect={insertInlineMath} />
            <VisualMenuItem label="Display" icon={<span className="typeset-visual-text-icon">[x]</span>} onSelect={insertMath} />
          </VisualToolbarMenu>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label="Insert misc">
          <button type="button" className="ol-cm-toolbar-button" title="Insert link" aria-label="Insert link" onClick={insertHref}><ToolIcon name="link" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Insert cross-reference" aria-label="Insert cross-reference" onClick={insertRef}><ToolIcon name="ref" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Insert citation" aria-label="Insert citation" onClick={insertCitation}><ToolIcon name="citation" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Insert figure" aria-label="Insert figure" onClick={insertFigure}><ToolIcon name="figure" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Insert table" aria-label="Insert table" onClick={insertTable}><ToolIcon name="table" /></button>
        </div>
        <div className="ol-cm-toolbar-button-group" aria-label="List indentation">
          <VisualToolbarMenu label="Insert list" horizontal icon={<ToolIcon name="list" />}>
            <VisualMenuItem label="Bulleted list" icon={<ToolIcon name="list" />} onSelect={insertBulletList} />
            <VisualMenuItem label="Numbered list" icon={<ToolIcon name="numberedList" />} onSelect={insertNumberedList} />
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
                aria-label="Search source"
                placeholder="Find"
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
              <span className="typeset-toolbar-search-count" aria-live="polite">
                {searchMatches.length ? `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}` : "0"}
              </span>
              <button type="button" className="ol-cm-toolbar-button" title="Previous match" aria-label="Previous match" disabled={!searchMatches.length} onClick={() => runSearch(-1)}>
                <ToolIcon name="previous" />
              </button>
              <button type="button" className="ol-cm-toolbar-button" title="Next match" aria-label="Next match" disabled={!searchMatches.length} onClick={() => runSearch(1)}>
                <ToolIcon name="next" />
              </button>
            </form>
          )}
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={searchOpen ? "Close search" : "Search"}
            aria-label="Search"
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
          <strong>{path ? basename(path) : "Untitled"}</strong>
        </div>
        {slides.length > 0 ? (
          <nav className="typeset-slide-nav" aria-label="Slide navigation">
            <button
              type="button"
              aria-label="Previous slide"
              title="Previous slide"
              disabled={activeSlideIndex <= 0}
              onClick={() => onNavigateToLine(slides[activeSlideIndex - 1]?.line ?? slides[0].line)}
            >
              <ToolIcon name="previous" />
            </button>
            <button
              type="button"
              className="typeset-slide-nav-label"
              title={activeSlide?.title ?? "Open first slide"}
              onClick={() => onNavigateToLine((activeSlide ?? slides[0]).line)}
            >
              <span>{activeSlideIndex >= 0 ? `Slide ${activeSlideIndex + 1} / ${slides.length}` : `${slides.length} slides`}</span>
              <strong>{activeSlide?.title ?? slides[0].title}</strong>
            </button>
            <button
              type="button"
              aria-label="Next slide"
              title="Next slide"
              disabled={activeSlideIndex < 0 || activeSlideIndex >= slides.length - 1}
              onClick={() => onNavigateToLine(slides[activeSlideIndex + 1]?.line ?? slides[slides.length - 1].line)}
            >
              <ToolIcon name="next" />
            </button>
          </nav>
        ) : (
          <div className="typeset-current-section" aria-live="polite" title={activeOutlineItem?.title ?? "No section selected"}>
            <ToolIcon name="list" />
            <span>{activeOutlineItem ? `Section ${activeOutlineItem.number} ${activeOutlineItem.title}` : "No section"}</span>
          </div>
        )}
        <div className="typeset-editor-context" aria-live="polite">
          {linkedPdfLine != null && <span className="typeset-sync-chip">PDF line {linkedPdfLine}</span>}
          {dirty && <span className="typeset-stale-chip">PDF needs recompile</span>}
          <span className="typeset-interaction-hint">
            {safeCompiledVisual
              ? "Select objects · drag to move · double-click to edit"
              : mode === "visual"
                ? "Click to edit · double-click to locate in PDF"
                : "Double-click source to locate in PDF"}
          </span>
        </div>
        <div className="typeset-visual-mode-switch editor-switch" role="tablist" aria-label="Editor mode">
          <button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "active" : ""} onClick={() => onModeChange("code")}>Code</button>
          <button type="button" role="tab" aria-selected={mode === "visual"} className={mode === "visual" ? "active" : ""} onClick={() => onModeChange("visual")}>Visual</button>
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

// Legacy block-based visual editor. Superseded by the CodeMirror TypesetVisualEditor
// (./TypesetVisualEditor); kept referenced via `void` below until it is retired in the
// final cleanup phase, so its shared helpers stay live under noUnusedLocals.
function TypesetVisualBlockEditor({
  path,
  draft,
  pdfCursor,
  onChange,
  onOpenCodeAtLine,
}: {
  path: string | null;
  draft: string;
  pdfCursor: VisualPdfCursor | null;
  onChange: (value: string) => void;
  onOpenCodeAtLine: (line: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const formulaEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const [formulaEdit, setFormulaEdit] = useState<VisualFormulaEdit | null>(null);
  // Which display-equation / theorem block is currently open for source editing.
  const [mathEditLine, setMathEditLine] = useState<number | null>(null);
  const [thmEditLine, setThmEditLine] = useState<number | null>(null);
  const visualDocument = useMemo(() => visualDocumentFor(draft, path), [draft, path]);
  const { contentBlocks, preambleBlocks } = visualDocument;
  const setupLineCount = preambleBlocks.reduce((count, block) => count + Math.max(1, block.endLine - block.line + 1), 0);
  const isLatex = extension(path ?? "") === ".tex";
  const isBeamer = isLatex && /\\documentclass(?:\[[^\]]*])?\{beamer\}/.test(draft);
  const insert = (snippet: string) => onChange(insertSourceSnippet(draft, snippet, path));
  const insertHeading = () => insert("\\section{New section}\n\n");
  const commitBlock = (block: VisualBlock, value: string, force = false) => {
    if (!force && sameVisualEditValue(value, visualBlockText(block))) return;
    const replacement = sourceForVisualBlock(block, value, path);
    const nextDraft = replaceSourceRange(draft, block.line, block.endLine, replacement);
    if (nextDraft !== draft) onChange(nextDraft);
  };
  const commitTitleField = (block: Extract<VisualBlock, { kind: "title" }>, command: "author" | "date" | "title", value: string) => {
    const line = command === "title" ? block.titleLine : command === "author" ? block.authorLine : block.dateLine;
    const endLine = command === "title" ? block.titleEndLine : command === "author" ? block.authorEndLine : block.dateEndLine;
    const current = command === "title" ? block.title : command === "author" ? block.author : block.date;
    if (sameVisualEditValue(value, stripInlineMarkup(current))) return;
    const nextDraft = replaceLatexCommand(draft, line, command, value, endLine);
    if (nextDraft !== draft) onChange(nextDraft);
  };
  const tableRowsFor = (block: Extract<VisualBlock, { kind: "table" }>) => {
    const rows = [block.headers, ...block.rows].filter((row) => row.length > 0).map((row) => [...row]);
    return rows.length > 0 ? rows : [[""]];
  };
  const commitTableRows = (block: Extract<VisualBlock, { kind: "table" }>, rows: string[][]) => {
    commitBlock(block, rows.map((row) => row.join("\t")).join("\n"), true);
  };
  const commitFrameTitle = (block: Extract<VisualBlock, { kind: "frame" }>, value: string) => {
    const title = value.trim() || "Slide";
    if (sameVisualEditValue(title, stripInlineMarkup(block.title))) return;
    const nextDraft = replaceSourceRange(draft, block.line, block.endLine, `\\begin{frame}${block.options ?? ""}{${title}}\n${block.text}\n\\end{frame}`);
    if (nextDraft !== draft) onChange(nextDraft);
  };
  const startFormulaEdit = (
    block: Extract<VisualBlock, { kind: "frame" }>,
    source: string,
    formulaElement: HTMLElement,
    previewElement: HTMLElement,
  ) => {
    const formulaRect = formulaElement.getBoundingClientRect();
    const previewRect = previewElement.getBoundingClientRect();
    const left = Math.max(8, Math.min(formulaRect.left - previewRect.left, previewRect.width - 220));
    const top = Math.max(8, formulaRect.bottom - previewRect.top + 6);
    setFormulaEdit({ line: block.line, source, value: source, anchor: { left, top } });
  };
  const updateFormulaEdit = (block: Extract<VisualBlock, { kind: "frame" }>, nextValue: string) => {
    if (!formulaEdit || formulaEdit.line !== block.line) return;
    setFormulaEdit({ ...formulaEdit, source: nextValue, value: nextValue });
    if (!nextValue.trim() || sameVisualEditValue(nextValue, formulaEdit.source)) return;
    const nextText = replaceLatexFormulaSource(block.text, formulaEdit.source, nextValue);
    if (nextText !== block.text) commitBlock(block, nextText, true);
  };
  const closeFormulaEdit = (block: Extract<VisualBlock, { kind: "frame" }>) => {
    if (!formulaEdit || formulaEdit.line !== block.line) {
      setFormulaEdit(null);
      return;
    }
    setFormulaEdit(null);
  };
  const commitTableCell = (block: Extract<VisualBlock, { kind: "table" }>, rowIndex: number, cellIndex: number, value: string) => {
    const rows = tableRowsFor(block);
    if (sameVisualEditValue(value, stripInlineMarkup(rows[rowIndex]?.[cellIndex] ?? ""))) return;
    const columnCount = Math.max(cellIndex + 1, ...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
    normalized[rowIndex][cellIndex] = value;
    commitTableRows(block, normalized);
  };
  const addTableRow = (block: Extract<VisualBlock, { kind: "table" }>) => {
    const rows = tableRowsFor(block);
    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    commitTableRows(block, [...rows, Array.from({ length: columnCount }, () => "")]);
  };
  const addTableColumn = (block: Extract<VisualBlock, { kind: "table" }>) => {
    const rows = tableRowsFor(block);
    commitTableRows(block, rows.map((row) => [...row, ""]));
  };
  const activePdfBlock = useMemo(
    () => pdfCursor
      ? contentBlocks.find((block) => pdfCursor.line >= block.line && pdfCursor.line <= block.endLine) ?? null
      : null,
    [contentBlocks, pdfCursor],
  );
  useEffect(() => {
    if (!pdfCursor || !activePdfBlock) return;
    const root = scrollRef.current;
    const block = root?.querySelector<HTMLElement>(`[data-visual-line="${activePdfBlock.line}"]`);
    if (!block) return;
    block.scrollIntoView({ block: "center", inline: "nearest" });
    window.setTimeout(() => {
      const editable = block.querySelector<HTMLElement>("textarea, input, [contenteditable='true']");
      editable?.focus();
    }, 0);
  }, [activePdfBlock, pdfCursor]);
  useEffect(() => {
    if (!formulaEdit) return;
    formulaEditorRef.current?.focus();
    formulaEditorRef.current?.select();
  }, [formulaEdit]);
  const blockClassName = (block: VisualBlock, className: string) => (
    `${className}${activePdfBlock?.line === block.line ? " pdf-cursor" : ""}`
  );
  const blockData = (block: VisualBlock) => ({
    "data-visual-line": block.line,
    "data-visual-end-line": block.endLine,
  });
  const pdfCursorMarker = (block: VisualBlock) => activePdfBlock?.line === block.line ? (
    <span className="typeset-visual-pdf-cursor" title={pdfCursor?.text}>
      PDF cursor
    </span>
  ) : null;
  const renderFrameNodes = (nodes: VisualFrameNode[]) => {
    return nodes.map((node, nodeIndex) => {
      const key = `${node.kind}:${nodeIndex}`;
      if (node.kind === "section") {
        return <h4 key={key} className="typeset-visual-slide-section" dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(node.text) }} />;
      }
      if (node.kind === "paragraph") {
        return <p key={key} className="typeset-visual-slide-paragraph" dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(node.text) }} />;
      }
      if (node.kind === "note") {
        return <aside key={key} className="typeset-visual-slide-note" dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(node.text) }} />;
      }
      if (node.kind === "math") {
        return <div key={key} className="typeset-visual-slide-math" dangerouslySetInnerHTML={{ __html: renderLatexFormulaHtml(node.text, true) }} />;
      }
      if (node.kind === "list") {
        const ListTag = node.ordered ? "ol" : "ul";
        return (
          <ListTag key={key} className="typeset-visual-slide-list">
            {node.items.map((item, itemIndex) => (
              <li key={itemIndex} dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(item) }} />
            ))}
          </ListTag>
        );
      }
      if (node.kind === "table") {
        const [head, ...body] = node.rows;
        return (
          <table key={key} className="typeset-visual-slide-table">
            {head && (
              <thead>
                <tr>
                  {head.map((cell, cellIndex) => (
                    <th key={cellIndex} dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(cell) }} />
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(cell) }} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      if (node.kind === "block") {
        return (
          <section key={key} className={`typeset-visual-slide-card ${node.tone}`}>
            {node.title && <strong dangerouslySetInnerHTML={{ __html: renderLatexDisplayHtml(node.title) }} />}
            <div className="typeset-visual-slide-card-body">{renderFrameNodes(node.children)}</div>
          </section>
        );
      }
      return (
        <div key={key} className="typeset-visual-slide-columns" style={{ ["--typeset-slide-columns" as string]: node.columns.length }}>
          {node.columns.map((column, columnIndex) => (
            <div key={columnIndex} className="typeset-visual-slide-column">
              {renderFrameNodes(column.children)}
            </div>
          ))}
        </div>
      );
    });
  };
  const renderBlock = (block: VisualBlock, index: number) => {
    const key = `${block.line}:${index}:${block.kind}`;
    const lineButton = (
      <button type="button" className="typeset-visual-line-btn" title="Open source line" onClick={() => onOpenCodeAtLine(block.line)}>{block.line}</button>
    );
    if (block.kind === "title") {
      const titleText = stripInlineMarkup(block.title || "Untitled");
      const authorText = stripInlineMarkup(block.author);
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block title")} {...blockData(block)}>
          <textarea
            defaultValue={titleText}
            rows={visualTextareaRows(titleText, 2, 44)}
            spellCheck
            placeholder="Title"
            onChange={(event) => commitTitleField(block, "title", event.currentTarget.value)}
            onBlur={(event) => commitTitleField(block, "title", event.currentTarget.value)}
            aria-label="Edit document title"
          />
          {block.author && (
            <textarea
              defaultValue={authorText}
              rows={visualTextareaRows(authorText, 2, 68)}
              spellCheck
              placeholder="Author"
              onChange={(event) => commitTitleField(block, "author", event.currentTarget.value)}
              onBlur={(event) => commitTitleField(block, "author", event.currentTarget.value)}
              aria-label="Edit document author"
            />
          )}
          {block.date && (
            <input
              defaultValue={block.date}
              spellCheck
              placeholder="Date"
              onChange={(event) => commitTitleField(block, "date", event.currentTarget.value)}
              onBlur={(event) => commitTitleField(block, "date", event.currentTarget.value)}
              aria-label="Edit document date"
            />
          )}
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "heading") {
      const Tag = `h${Math.min(block.level + 1, 4)}` as "h2" | "h3" | "h4";
      return (
        <div key={key} className={blockClassName(block, `typeset-visual-block heading level-${block.level}`)} {...blockData(block)}>
          <Tag>
            <input
              defaultValue={visualBlockText(block)}
              spellCheck
              placeholder="Heading"
              onChange={(event) => commitBlock(block, event.currentTarget.value)}
              onBlur={(event) => commitBlock(block, event.currentTarget.value)}
              aria-label={`Edit heading at line ${block.line}`}
            />
          </Tag>
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "abstract") {
      const text = visualBlockText(block);
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block abstract")} {...blockData(block)}>
          <strong>Abstract</strong>
          <textarea
            defaultValue={text}
            rows={visualTextareaRows(text, 3, 58)}
            spellCheck
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit abstract at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "list") {
      const listText = visualBlockText(block);
      return (
        <div key={key} className={blockClassName(block, `typeset-visual-block list${block.ordered ? " ordered" : ""}`)} {...blockData(block)}>
          <textarea
            defaultValue={listText}
            rows={visualTextareaRows(listText, 3, 42)}
            spellCheck
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit list starting at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "macro") {
      const text = visualBlockText(block);
      const isAbstractLike = /abstract/i.test(block.command);
      const labelClass = block.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return (
        <div key={key} className={blockClassName(block, `typeset-visual-block macro macro-${labelClass}${isAbstractLike ? " abstract-like" : ""}`)} {...blockData(block)}>
          <div className="typeset-visual-macro-heading">
            <strong className="typeset-visual-macro-label">{block.label}</strong>
            {block.badge && <span className="typeset-visual-macro-badge">{block.badge}</span>}
          </div>
          <textarea
            defaultValue={text}
            rows={visualTextareaRows(text, isAbstractLike ? 5 : 2, isAbstractLike ? 64 : 58)}
            spellCheck
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit ${block.label} at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "math") {
      const editing = mathEditLine === block.line;
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block math")} {...blockData(block)}>
          {editing ? (
            <textarea
              className="typeset-visual-math-editor"
              defaultValue={block.text}
              autoFocus
              spellCheck={false}
              rows={Math.min(12, Math.max(2, block.text.split("\n").length + 1))}
              aria-label={`Edit equation at line ${block.line}`}
              onChange={(event) => commitBlock(block, event.currentTarget.value)}
              onBlur={() => setMathEditLine(null)}
            />
          ) : (
            <div className="typeset-visual-math-row">
              <div
                className="typeset-visual-mathblock"
                role="button"
                tabIndex={0}
                aria-label={`Equation at line ${block.line}. Activate to edit source.`}
                onClick={() => setMathEditLine(block.line)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setMathEditLine(block.line);
                  }
                }}
                dangerouslySetInnerHTML={{ __html: renderDisplayEquationHtml(block.text) }}
              />
              {block.numbered && block.eqNumber != null && (
                <span className="typeset-visual-eq-number" aria-hidden="true">({block.eqNumber})</span>
              )}
            </div>
          )}
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "frame") {
      const text = visualBlockText(block);
      const frameNodes = parseBeamerFrameNodes(block.text);
      const activeFormulaEdit = formulaEdit?.line === block.line ? formulaEdit : null;
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block frame")} {...blockData(block)}>
          <input
            defaultValue={stripInlineMarkup(block.title)}
            spellCheck
            placeholder="Slide title"
            onChange={(event) => commitFrameTitle(block, event.currentTarget.value)}
            onBlur={(event) => commitFrameTitle(block, event.currentTarget.value)}
            aria-label={`Edit slide title at line ${block.line}`}
          />
          {frameNodes.length > 0 && (
            <div
              className="typeset-visual-slide-preview"
              aria-label={`Slide structure preview at line ${block.line}`}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                const formula = target.closest<HTMLElement>(".typeset-visual-formula");
                const source = formula?.dataset.latexSource;
                if (!source) return;
                event.preventDefault();
                event.stopPropagation();
                startFormulaEdit(block, source, formula, event.currentTarget);
              }}
            >
              {renderFrameNodes(frameNodes)}
              {activeFormulaEdit && (
                <div
                  className="typeset-visual-formula-editor"
                  style={activeFormulaEdit.anchor ? {
                    left: `${activeFormulaEdit.anchor.left}px`,
                    top: `${activeFormulaEdit.anchor.top}px`,
                  } : undefined}
                >
                  <textarea
                    ref={formulaEditorRef}
                    value={activeFormulaEdit.value}
                    rows={Math.min(5, Math.max(1, activeFormulaEdit.value.split("\n").length))}
                    spellCheck={false}
                    aria-label={`Edit formula at line ${block.line}`}
                    onChange={(event) => updateFormulaEdit(block, event.currentTarget.value)}
                    onInput={(event) => updateFormulaEdit(block, event.currentTarget.value)}
                    onBlur={() => closeFormulaEdit(block)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setFormulaEdit(null);
                      }
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        closeFormulaEdit(block);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <details className="typeset-visual-frame-source">
            <summary>LaTeX source</summary>
            <textarea
              defaultValue={text}
              rows={visualTextareaRows(text, 4, 54)}
              spellCheck
              onChange={(event) => commitBlock(block, event.currentTarget.value)}
              onBlur={(event) => commitBlock(block, event.currentTarget.value)}
              aria-label={`Edit slide body at line ${block.line}`}
            />
          </details>
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "figure") {
      const caption = visualBlockText(block);
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block figure")} {...blockData(block)}>
          <FigurePreview image={block.image} />
          <textarea
            defaultValue={caption}
            rows={visualTextareaRows(caption, 2, 52)}
            spellCheck
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit figure caption at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "table") {
      const rows = tableRowsFor(block);
      const columnCount = Math.max(1, ...rows.map((row) => row.length));
      const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] ?? ""));
      const headerCells = normalizedRows[0] ?? [];
      const bodyRows = normalizedRows.slice(1);
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block table")} {...blockData(block)}>
          <table>
            {headerCells.length > 0 && (
              <thead>
                <tr>
                  {headerCells.map((cell, ci) => (
                    <th key={ci}>
                      <input
                        defaultValue={stripInlineMarkup(cell)}
                        spellCheck
                        onChange={(event) => commitTableCell(block, 0, ci, event.currentTarget.value)}
                        onBlur={(event) => commitTableCell(block, 0, ci, event.currentTarget.value)}
                        aria-label={`Edit table header ${ci + 1} at line ${block.line}`}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>
                      <input
                        defaultValue={stripInlineMarkup(cell)}
                        spellCheck
                        onChange={(event) => commitTableCell(block, ri + 1, ci, event.currentTarget.value)}
                        onBlur={(event) => commitTableCell(block, ri + 1, ci, event.currentTarget.value)}
                        aria-label={`Edit table cell ${ri + 1}, ${ci + 1} at line ${block.line}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="typeset-visual-table-tools">
            <button type="button" onClick={() => addTableRow(block)} aria-label={`Add table row at line ${block.line}`}>+ row</button>
            <button type="button" onClick={() => addTableColumn(block)} aria-label={`Add table column at line ${block.line}`}>+ col</button>
          </div>
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "theorem") {
      const editing = thmEditLine === block.line;
      const envTitle = block.envName.charAt(0).toUpperCase() + block.envName.slice(1);
      const heading = `${envTitle}${block.thmNumber != null ? ` ${block.thmNumber}` : ""}${block.label ? ` (${block.label})` : ""}`;
      return (
        <div key={key} className={blockClassName(block, `typeset-visual-block theorem ${block.envName}`)} {...blockData(block)}>
          <strong className="typeset-visual-theorem-label">{heading}</strong>
          {editing ? (
            <textarea
              className="typeset-visual-theorem-body"
              defaultValue={block.text}
              autoFocus
              rows={visualTextareaRows(block.text, 2, 58)}
              spellCheck
              onChange={(event) => commitBlock(block, event.currentTarget.value)}
              onBlur={() => setThmEditLine(null)}
              aria-label={`Edit ${block.envName} at line ${block.line}`}
            />
          ) : (
            <div
              className="typeset-visual-theorem-rendered"
              role="button"
              tabIndex={0}
              aria-label={`${block.envName} at line ${block.line}. Activate to edit source.`}
              onClick={() => setThmEditLine(block.line)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setThmEditLine(block.line);
                }
              }}
              dangerouslySetInnerHTML={{ __html: renderTheoremBodyHtml(block.text) }}
            />
          )}
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "citation") {
      const keys = block.keys.join(", ");
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block citation")} {...blockData(block)}>
          <span className="typeset-visual-cite">cite</span>
          <input
            defaultValue={keys}
            spellCheck={false}
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit citation keys at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "footnote") {
      const text = visualBlockText(block);
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block footnote")} {...blockData(block)}>
          <span className="typeset-visual-footnote-mark">*</span>
          <textarea
            className="typeset-visual-footnote-text"
            defaultValue={text}
            rows={visualTextareaRows(text, 1, 64)}
            spellCheck
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit footnote at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    if (block.kind === "command" || block.kind === "environment") {
      const sourceText = block.kind === "environment" ? block.text : block.text;
      return (
        <div key={key} className={blockClassName(block, "typeset-visual-block command")} {...blockData(block)}>
          <textarea
            defaultValue={sourceText}
            rows={visualTextareaRows(sourceText, 2, 52)}
            spellCheck={false}
            onChange={(event) => commitBlock(block, event.currentTarget.value)}
            onBlur={(event) => commitBlock(block, event.currentTarget.value)}
            aria-label={`Edit source command at line ${block.line}`}
          />
          {pdfCursorMarker(block)}
          {lineButton}
        </div>
      );
    }
    const paragraphText = visualBlockText(block);
    const paragraphHtml = visualBlockHtml(block);
    return (
      <div key={key} className={blockClassName(block, "typeset-visual-block paragraph")} {...blockData(block)}>
        <div
          className="typeset-visual-paragraph-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline="true"
          aria-label={`Edit paragraph at line ${block.line}`}
          onInput={(event) => commitBlock(block, event.currentTarget.innerText)}
          onBlur={(event) => commitBlock(block, event.currentTarget.innerText)}
          dangerouslySetInnerHTML={{ __html: paragraphHtml ?? escapeHtml(paragraphText) }}
        />
        {pdfCursorMarker(block)}
        {lineButton}
      </div>
    );
  };

  return (
    <section className="typeset-visual-pane ide-redesign-editor-content" aria-label="Visual editor">
      <div className="typeset-visual-scroll" ref={scrollRef}>
        <article className={`typeset-visual-page${isLatex ? (isBeamer ? " beamer-deck" : " latex-paper") : ""}`}>
          {pdfCursor && (
            <div className="typeset-visual-cursor-status" role="status" title={pdfCursor.text}>
              <span>PDF cursor</span>
              <strong>line {pdfCursor.line}</strong>
              <em>{pdfCursor.text || "matched compiled output"}</em>
            </div>
          )}
          {preambleBlocks.length > 0 && (
            <button
              type="button"
              className="typeset-visual-preamble"
              onClick={() => onOpenCodeAtLine(preambleBlocks[0].line)}
            >
              <span>Show document preamble</span>
              <strong>{setupLineCount} lines</strong>
            </button>
          )}
          {contentBlocks.length === 0 ? (
            <button type="button" className="typeset-visual-empty" onClick={insertHeading}>
              Start with a heading
            </button>
          ) : (
            contentBlocks.map(renderBlock)
          )}
        </article>
      </div>
    </section>
  );
}

// Keep the legacy block editor and its helper graph referenced until the final
// cleanup phase removes them; the CodeMirror TypesetVisualEditor is used instead.
void TypesetVisualBlockEditor;

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

// Absolute LaTeX sectioning depth (\part is shallowest). The outline stores
// these raw ranks so nesting is unambiguous, then normalizes them for display
// (see `normalizeOutlineLevels`) so the shallowest heading a document actually
// uses renders flush-left regardless of class — \section is top-level in an
// article, \chapter in a report/book.
const OUTLINE_HEADING_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
};

// A sectioning command at the start of a (trimmed) line, tolerating the starred
// form (\section*) and an optional short-title argument (\chapter[Short]{Full}).
// The previous regex required `{` immediately after the command, so every
// chapter/section written with a running-head `[...]` argument was silently
// dropped from the outline — the core "Chapter isn't recognized" bug.
const OUTLINE_HEADING_RE = /^\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{/;

/** Reads the brace-balanced argument beginning at `braceIndex` (a `{`), so a
 * title with nested groups like `\section{A \textbf{B}}` isn't truncated at the
 * first `}` the way a non-greedy `{(.+?)}` capture would be. */
function balancedBraceArg(text: string, braceIndex: number): string | null {
  if (text[braceIndex] !== "{") return null;
  let depth = 0;
  for (let index = braceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(braceIndex + 1, index);
    }
  }
  return null;
}

/** Shifts raw sectioning ranks so the shallowest heading present becomes level
 * 1, preserving relative depth (a lone \subsection under \section stays one step
 * in). Numbering is depth-relative already, so this only affects indentation. */
function normalizeOutlineLevels(items: OutlineItem[]): OutlineItem[] {
  if (items.length === 0) return items;
  const minLevel = Math.min(...items.map((item) => item.level));
  return items.map((item) => ({ ...item, level: item.level - minLevel + 1 }));
}

function outlineFor(source: string): OutlineItem[] {
  const sectionOutline: OutlineItem[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    const match = OUTLINE_HEADING_RE.exec(trimmed);
    if (!match) return;
    const title = balancedBraceArg(trimmed, match[0].length - 1)?.trim();
    if (!title) return;
    sectionOutline.push({
      line: index + 1,
      level: OUTLINE_HEADING_LEVELS[match[1]] ?? OUTLINE_HEADING_LEVELS.section,
      title,
    });
  });
  if (sectionOutline.length > 0) return normalizeOutlineLevels(sectionOutline);

  // Beamer decks often omit \section entirely. In that case an empty Outline
  // wastes a third of the project panel even though every frame has a useful
  // navigation title, so fall back to the frame list. Frames are siblings, so
  // they all sit flush-left at level 1.
  return beamerSlidesFor(source).map((slide) => ({
    line: slide.line,
    level: 1,
    title: slide.title,
  }));
}

function numberedOutlineFor(outline: OutlineItem[]): NumberedOutlineItem[] {
  const counters: number[] = [];
  return outline.map((item) => {
    const levelIndex = Math.max(0, item.level - 1);
    counters[levelIndex] = (counters[levelIndex] ?? 0) + 1;
    counters.length = levelIndex + 1;
    const number = counters.filter((value) => value > 0).join(".");
    return { ...item, number };
  });
}

function activeOutlineItemForLine(outline: NumberedOutlineItem[], line: number): NumberedOutlineItem | null {
  let active: NumberedOutlineItem | null = null;
  for (const item of outline) {
    if (item.line > line) break;
    active = item;
  }
  return active;
}

function beamerSlidesFor(source: string): BeamerSlide[] {
  const slides: BeamerSlide[] = [];
  const frameRe = /\\begin\{frame\}(?:\[[^\]]*\])?(?:\{([^{}\n]*)\})?([\s\S]*?)\\end\{frame\}/g;
  let match: RegExpExecArray | null;
  while ((match = frameRe.exec(source))) {
    const frameTitle = /\\frametitle\s*\{([^{}\n]*)\}/.exec(match[2] ?? "")?.[1];
    const fallbackTitle = /\\titlepage\b/.test(match[2] ?? "") ? "Title slide" : `Slide ${slides.length + 1}`;
    slides.push({
      line: lineNumberForOffset(source, match.index),
      endLine: lineNumberForOffset(source, match.index + match[0].length),
      title: stripInlineMarkup(match[1] || frameTitle || fallbackTitle),
    });
  }
  return slides;
}

function activeBeamerSlideForLine(slides: BeamerSlide[], line: number): BeamerSlide | null {
  return slides.find((slide) => line >= slide.line && line <= slide.endLine)
    ?? [...slides].reverse().find((slide) => slide.line <= line)
    ?? slides[0]
    ?? null;
}

function lineOffsetFor(source: string, line: number): number {
  const lines = source.split("\n");
  return lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0);
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
  const currentProject = useStore((state) => state.currentProject);
  const setTypesetDirty = useStore((state) => state.setTypesetDirty);
  const literaturePapers = useLiteratureStore((state) => state.library.papers);
  const loadLiterature = useLiteratureStore((state) => state.load);
  const ensureCitationKeys = useLiteratureStore((state) => state.ensureCitationKeys);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
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
  const [startDocuments, setStartDocuments] = useState<TypesetDocument[]>([]);
  const [latexAvailable, setLatexAvailable] = useState<boolean | null>(null);
  const [logOpen, setLogOpen] = useState(false);
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
  const sourcePathRef = useRef<string | null>(sourcePath);
  const loadedRef = useRef<FileText | null>(loaded);
  const activeCompileRunIdRef = useRef<string | null>(activeCompileRunId);
  const saveInFlightRef = useRef<Promise<FileText | null> | null>(null);
  sourcePathRef.current = sourcePath;
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

  const setCompileErrorHandlingPreference = useCallback((value: CompileErrorHandling) => {
    setCompileErrorHandling(value);
    try {
      window.localStorage.setItem(compileErrorHandlingStorageKey(currentProject?.id), value);
    } catch {
      // The preference remains active for this session if local storage is unavailable.
    }
  }, [currentProject?.id]);

  const dirty = Boolean(loaded && draft !== loaded.content);
  useEffect(() => {
    setTypesetDirty(dirty);
  }, [dirty, setTypesetDirty]);
  const outline = useMemo(() => outlineFor(draft), [draft]);
  const numberedOutline = useMemo(() => numberedOutlineFor(outline), [outline]);
  const beamerSlides = useMemo(() => beamerSlidesFor(draft), [draft]);
  const activeOutlineItem = useMemo(
    () => activeOutlineItemForLine(numberedOutline, currentSourceLine),
    [currentSourceLine, numberedOutline],
  );
  const activeBeamerSlide = useMemo(
    () => activeBeamerSlideForLine(beamerSlides, currentSourceLine),
    [beamerSlides, currentSourceLine],
  );
  const activeBeamerPage = Math.max(1, activeBeamerSlide ? beamerSlides.indexOf(activeBeamerSlide) + 1 : 1);
  const slideFocusActive = editorMode === "visual" && beamerSlides.length > 0 && slideFocusMode;
  const effectiveProjectPanelVisible = projectPanelVisible && !slideFocusActive;
  const effectivePdfPanelVisible = pdfPanelVisible && !slideFocusActive;
  const activeWorkDir = useMemo(() => workDirForSource(sourcePath), [sourcePath]);
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
    draftRef.current = nextDraft;
    const codeView = editorRef.current?.view;
    const visualView = visualViewRef.current;
    // Both surfaces stay mounted and mirror intentional edits into their own
    // CodeMirror history stacks. Switching Code/Visual therefore preserves the
    // same undo point without reintroducing a React-level DraftHistory.
    if (codeView && codeView.state.doc.toString() !== nextDraft) {
      editorRef.current?.setDocument(nextDraft, { addToHistory: true, preserveSelection: true });
    }
    if (visualView && visualView.state.doc.toString() !== nextDraft) {
      visualView.dispatch({
        changes: { from: 0, to: visualView.state.doc.length, insert: nextDraft },
      });
    }
    setDraft(nextDraft);
  }, []);

  const prepareCitationKeys = useCallback(async (ids: string[]) => {
    const keysById = await ensureCitationKeys(ids);
    return ids.map((id) => keysById[id]).filter((key): key is string => Boolean(key));
  }, [ensureCitationKeys]);

  const synchronizeBibliography = useCallback(async () => {
    const activeSourcePath = sourcePathRef.current;
    if (!activeSourcePath) throw new Error("Open a LaTeX source file before inserting a library citation.");
    const bibliography = await literatureExportBibliography<{ content: string }>({ format: "bibtex" });
    const bibliographyPath = bibliographyPathForSource(activeSourcePath);
    const managedContent = `${SOMNIQ_BIBLIOGRAPHY_HEADER}${bibliography.content}`;
    let existing: FileText | null = null;
    try {
      existing = await fileReadText(bibliographyPath);
    } catch {
      // A missing generated bibliography is created below. Other read failures
      // are caught by the subsequent write/create operation.
    }
    if (existing && !existing.content.startsWith(SOMNIQ_BIBLIOGRAPHY_HEADER)) {
      throw new Error(
        `${SOMNIQ_BIBLIOGRAPHY_FILE} already exists and is not SomniQ-managed; it was left unchanged to protect your bibliography.`,
      );
    }
    try {
      await fileWriteText(bibliographyPath, managedContent);
    } catch (writeError) {
      try {
        await fileCreateText(bibliographyPath, managedContent);
      } catch {
        throw writeError;
      }
    }
    const sourceWithBibliography = withSomniqBibliography(draftRef.current);
    if (sourceWithBibliography !== draftRef.current) changeDraft(sourceWithBibliography);
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
    const timer = window.setTimeout(() => {
      void synchronizeBibliography().catch((syncError) => {
        if (active) setError(`Could not synchronize ${SOMNIQ_BIBLIOGRAPHY_FILE}: ${String(syncError)}`);
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [citationLibraryFingerprint, sourcePath, sourceUsesManagedBibliography, synchronizeBibliography]);

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

  const openSource = useCallback(async (path: string, initialLine = 1): Promise<boolean> => {
    const currentPath = sourcePathRef.current;
    if (currentPath === path) {
      setCurrentSourceLine(initialLine);
      return true;
    }
    const currentFile = loadedRef.current;
    if (
      currentPath
      && currentFile
      && draftRef.current !== currentFile.content
      && !window.confirm(`Discard unsaved changes in ${basename(currentPath)} and open ${basename(path)}?`)
    ) {
      return false;
    }
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setLoading(true);
    setSaving(false);
    setError(null);
    try {
      const file = await fileReadText(path);
      if (documentEpochRef.current !== documentEpoch) return false;
      setSourcePath(file.path);
      setPreviewPath(outputPathFor(file.path));
      setLoaded(file);
      resetDraft(file.content);
      setVisualPdfCursor(null);
      setCurrentSourceLine(initialLine);
      setCompileStatus("idle");
      setCompileResult(null);
      setCompileLiveLog(null);
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
      setPreviewPath(path);
      setRefreshKey((key) => key + 1);
    }
  }, [openSource]);

  const handleFileMutation = useCallback((mutation: TypesetFileMutation) => {
    const pathMatches = (path: string | null, target: string) => Boolean(path && (path === target || path.startsWith(`${target}/`)));
    if (mutation.type === "delete") {
      if (pathMatches(sourcePath, mutation.path) || pathMatches(previewPath, mutation.path)) {
        documentEpochRef.current += 1;
        invalidateActiveCompile();
        setSourcePath(null);
        setPreviewPath(null);
        setLoaded(null);
        resetDraft("");
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
      if (path === mutation.path) return mutation.newPath;
      if (mutation.isDir && path.startsWith(`${mutation.path}/`)) {
        return `${mutation.newPath}/${path.slice(mutation.path.length + 1)}`;
      }
      return path;
    };
    const nextSourcePath = renamedPath(sourcePath);
    if (nextSourcePath !== sourcePath) {
      documentEpochRef.current += 1;
      invalidateActiveCompile();
    }
    setSourcePath(nextSourcePath);
    setPreviewPath(renamedPath(previewPath));
    setLoaded((file) => file && nextSourcePath ? { ...file, path: nextSourcePath } : file);
    setTreeRefreshKey((key) => key + 1);
  }, [invalidateActiveCompile, previewPath, resetDraft, sourcePath]);

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
      setPreviewPath(outputPathFor(file.path));
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
    setPreviewPath(null);
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
          setPreviewPath(outputPathFor(file.path));
          setLoaded(file);
          resetDraft(file.content);
          setVisualPdfCursor(null);
          setCurrentSourceLine(1);
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
          setSourcePath(diskFile.path);
          setError(`${basename(savePath)} changed outside SomniQ Studio, so the editor was refreshed before compiling.`);
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
        setError(String(saveError));
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
      setCompileStatus(result.success ? "success" : result.partialOutput ? "partial" : "error");
      // Reveal the log only when the build reported problems; a clean success
      // returns focus to the freshly rendered PDF.
      setLogOpen(!result.success);
      const pdfState = result.pdfState ?? (result.success ? "fresh" : result.partialOutput ? "partial" : "missing");
      if (pdfState === "fresh" || pdfState === "partial") {
        setPreviewPath(result.outputPath || outputPath);
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
      setError("The current compile is still reading the project. Wait for it to finish or cancel it before saving.");
      return;
    }
    // The Beamer compiled-visual editor renders the built PDF, so its Save has
    // to recompile to refresh the slides. Every other surface (Code editor and
    // the article WYSIWYG editor) only writes the file — compiling stays manual
    // via Recompile / Ctrl+Enter, so Ctrl+S no longer forces a full build.
    if (editorMode === "visual" && beamerSlides.length > 0) {
      compileRef.current();
      return;
    }
    void save();
  }, [beamerSlides.length, editorMode, loaded, save]);

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
  const saveRef = useRef(saveCurrentEditor);
  saveRef.current = saveCurrentEditor;
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
      saveCurrentEditor();
    };
    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, [loaded, saveCurrentEditor, sourcePath]);

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

  const navigateToLine = useCallback((line: number) => {
    const offset = lineOffsetFor(draft, line);
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
    void openSource(targetPath, line);
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

  const openSourceForPdfText = useCallback((text: string, context = text, forceCode = false) => {
    const source = editorModeRef.current === "code"
      ? editorRef.current?.view.state.doc.toString() || draftRef.current
      : draftRef.current;
    const match = findLatexOffsetForPdfText(source, text, context);
    if (!match) return;
    const cursor = {
      line: lineNumberForOffset(source, match.start),
      start: match.start,
      end: match.end,
      text: normalizePdfText(text),
    };
    setVisualPdfCursor(cursor);
    setCurrentSourceLine(cursor.line);
    if (editorModeRef.current === "visual" && !forceCode) {
      setEditorMode("visual");
      return;
    }
    openCodeRange(match.start, match.end);
  }, [openCodeRange]);

  // Forward search: double-click in Code or Visual jumps the PDF preview to
  // the exact compiled position, via the real SyncTeX data latexmk/xelatex
  // now emit (-synctex=1). Reports back through `forwardSearchNotice` instead
  // of failing silently — a stale (pre-synctex) PDF, a missing `synctex`
  // binary, or a line with no typeset material (blank lines, comments) are
  // all real, visible-to-the-user reasons the jump didn't happen.
  const jumpToPdfForLine = useCallback((line: number, column: number) => {
    if (!sourcePath || !previewPath) {
      setForwardSearchNotice("Compile the PDF before jumping to it.");
      return;
    }
    void latexForwardSearch(sourcePath, previewPath, line, column)
      .then((result) => {
        const location = result.locations[0];
        if (location) {
          setPdfForwardTarget({ location, nonce: Date.now() });
          setForwardSearchNotice(null);
        } else {
          setForwardSearchNotice("No PDF match for this line yet — recompile and try again.");
        }
      })
      .catch((forwardError) => {
        setForwardSearchNotice(String(forwardError));
      });
  }, [sourcePath, previewPath]);

  const jumpFromOutline = useCallback((line: number) => {
    // An outline item represents a source heading. Open the exact source line
    // and use SyncTeX to bring the compiled PDF to the corresponding output.
    setPdfPanelVisible(true);
    setLogOpen(false);
    navigateToLine(line);
    jumpToPdfForLine(line, 1);
  }, [jumpToPdfForLine, navigateToLine]);

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
    if (dirty && !window.confirm("Discard unsaved changes and return to the source list?")) {
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

  const gridClassName = [
    "typeset-main-grid ide-redesign-body",
    !sourcePath && !loaded ? "start-mode" : "",
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
          <strong>Browser preview</strong>
          <span>Sample data only</span>
          <em>Desktop mode uses local files and local compilation.</em>
        </div>
      )}
      <div
        className={gridClassName}
        style={gridStyle}
      >
        {(sourcePath || loaded) && (
          <nav className="typeset-rail ide-rail" aria-label="Typeset sections">
            <div className="ide-rail-tabs-nav">
              <div className="ide-rail-tabs-wrapper">
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectiveProjectPanelVisible ? " open-rail active" : ""}`}
                  title={effectiveProjectPanelVisible ? "Hide Project files" : "Show Project files"}
                  aria-label={effectiveProjectPanelVisible ? "Hide Project files" : "Show Project files"}
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
                  title={effectivePdfPanelVisible ? "Hide PDF panel" : "Show PDF panel"}
                  aria-label={effectivePdfPanelVisible ? "Hide PDF panel" : "Show PDF panel"}
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
                  title="Back to source list"
                  aria-label="Home"
                  onClick={returnToStart}
                >
                  <ToolIcon name="home" className="ide-rail-tab-link-icon" />
                </button>
              </div>
              <nav aria-label="Settings">
                <button type="button" className="ide-rail-tab-link" title="Settings" aria-label="Settings">
                  <ToolIcon name="settings" className="ide-rail-tab-link-icon" />
                </button>
              </nav>
            </div>
          </nav>
        )}
        {!sourcePath && !loaded ? (
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
                    outline={numberedOutline}
                    height={outlinePanelHeight}
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
                  aria-label="Resize Project files"
                  aria-orientation="vertical"
                  aria-valuemin={PROJECT_PANEL_MIN_W}
                  aria-valuemax={PROJECT_PANEL_MAX_W}
                  aria-valuenow={projectPanelWidth}
                  title="Drag to resize Project files"
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("project", event)}
                  onKeyDown={(event) => handlePanelResizeKey("project", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                </div>
              </>
            )}
            <section className={`typeset-editor-pane ide-redesign-editor-container ${editorMode === "visual" ? "visual-mode" : "code-mode"}`} aria-label="Source editor">
              {loaded && (
                <TypesetEditorToolbar
                  activeOutlineItem={activeOutlineItem}
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
              {loading ? (
                <div className="typeset-empty">Loading source...</div>
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
                        onOpenCodeAtLine={openCodeAtLine}
                        onOpenCodeRange={openCodeRange}
                        onForwardSearch={jumpToPdfForLine}
                        onViewReady={onVisualViewReady}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="typeset-empty">Create or open a .tex file.</div>
              )}
            </section>
            {effectivePdfPanelVisible && (
              <>
                <div
                  className="typeset-resize-handle pdf"
                  data-resize-panel="pdf"
                  role="separator"
                  aria-label="Resize PDF preview"
                  aria-orientation="vertical"
                  aria-valuemin={PDF_PANEL_MIN_W}
                  aria-valuemax={PDF_PANEL_MAX_W}
                  aria-valuenow={pdfPanelWidth}
                  title="Drag to resize PDF preview"
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("pdf", event)}
                  onKeyDown={(event) => handlePanelResizeKey("pdf", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                </div>
                <div className="typeset-preview-stack ide-redesign-pdf-container">
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
                    onSourceTextClick={openSourceForPdfText}
                    onHide={() => setPdfPanelVisible(false)}
                    forwardTarget={pdfForwardTarget}
                    forwardSearchNotice={forwardSearchNotice}
                  />
                  {logOpen && (
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

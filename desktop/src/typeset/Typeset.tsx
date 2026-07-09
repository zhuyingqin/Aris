import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { memo } from "react";
import katex from "katex";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { EditorView } from "@codemirror/view";
import "katex/dist/katex.min.css";


import {
  fileCreateText,
  fileListDir,
  fileOpen,
  fileReadBytes,
  fileReadText,
  fileSearch,
  fileWriteText,
  isTauri,
  latexCompile,
  type FileText,
  type FileTreeEntry,
  type LatexCompileResult,
} from "../api/tauri";
import { isTypesetPreviewMode } from "../api/labPreview";
import CodeEditor from "../lab/CodeEditor";
import { TypesetVisualEditor } from "./TypesetVisualEditor";
import type { VisualPdfCursor } from "./visualModel";
import { useStore } from "../store";
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

type CompileStatus = "idle" | "running" | "success" | "error";
type CompileResult = LatexCompileResult;
type EditorMode = "code" | "visual";
type TypesetResizePanel = "project" | "pdf";
type TypesetResizeAxis = "x" | "y";
type OutlineItem = { line: number; level: number; title: string };
type NumberedOutlineItem = OutlineItem & { number: string };

const PROJECT_PANEL_DEFAULT_W = 204;
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 360;
const PDF_PANEL_DEFAULT_W = 760;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;
const OUTLINE_PANEL_DEFAULT_H = 184;
const OUTLINE_PANEL_MIN_H = 72;
const OUTLINE_PANEL_MAX_H = 420;
const RESIZE_HOT_ZONE_PX = 32;
const SCROLLBAR_GUTTER_PX = 18;

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

type DraftHistory = {
  past: string[];
  future: string[];
};

type PdfTextRun = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
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

function resizeHitFromGridPoint(grid: HTMLElement, clientX: number, clientY: number): { panel: TypesetResizePanel; axis: TypesetResizeAxis } | null {
  const candidates = Array.from(grid.querySelectorAll<HTMLElement>("[data-resize-panel]"));
  let closest: { panel: TypesetResizePanel; axis: TypesetResizeAxis; distance: number } | null = null;
  for (const candidate of candidates) {
    const panel = candidate.dataset.resizePanel;
    if (panel !== "project" && panel !== "pdf") continue;
    const rect = candidate.getBoundingClientRect();
    const axis = resizeAxisForTarget(candidate);
    const onCrossAxis =
      axis === "x"
        ? clientY >= rect.top && clientY <= rect.bottom
        : clientX >= rect.left && clientX <= rect.right;
    if (!onCrossAxis) continue;
    const center = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const distance = Math.abs(coordinateForAxis(axis, { clientX, clientY }) - center);
    if (distance > RESIZE_HOT_ZONE_PX) continue;
    if (!closest || distance < closest.distance) {
      closest = { panel, axis, distance };
    }
  }
  return closest ? { panel: closest.panel, axis: closest.axis } : null;
}

function isEditorScrollbarGutterPointer(target: EventTarget | null, clientX: number, clientY: number): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const scrollTarget = target.closest<HTMLElement>(".typeset-visual-scroll, .typeset-editor-body .lab-editor");
  if (!scrollTarget) return false;
  const rect = scrollTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  if (!inside) return false;
  const verticalGutter = clientX >= rect.right - SCROLLBAR_GUTTER_PX;
  const horizontalGutter = clientY >= rect.bottom - SCROLLBAR_GUTTER_PX;
  return verticalGutter || horizontalGutter;
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

function defaultSourceFor(_path: string): string {
  return DEFAULT_LATEX_DOCUMENT;
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
  editorRef: { current: HTMLTextAreaElement | null },
  visualViewRef: { current: EditorView | null },
  draft: string,
  onChange: (value: string) => void,
): EditorAdapter | null {
  if (mode === "code") {
    const editor = editorRef.current;
    if (!editor) return null;
    const from = editor.selectionStart ?? draft.length;
    const to = editor.selectionEnd ?? from;
    return {
      from,
      to,
      text: draft,
      replace: (rFrom, rTo, insert, selStart, selEnd) => {
        onChange(draft.slice(0, rFrom) + insert + draft.slice(rTo));
        window.setTimeout(() => {
          editor.focus();
          editor.setSelectionRange(selStart, selEnd);
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
}

function TypesetExplorer({
  projectPath,
  rootPath,
  activeSourcePath,
  activePreviewPath,
  refreshKey,
  onOpenPath,
}: ExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["", "papers"]));
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
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
          title={entry.path}
          disabled={!openable}
          onClick={() => {
            if (entry.isDir) toggleDir(entry.path);
            else onOpenPath(entry.path);
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
    </aside>
  );
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  onSourceTextClick: (text: string, context: string) => void;
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
    }];
  });
}

const PdfPage = memo(function PdfPage({ pdf, page, zoom, onSourceTextClick }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTask = useRef<RenderTask | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [textRuns, setTextRuns] = useState<PdfTextRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setError(null);
    setTextRuns([]);
    setPageSize(null);
    renderTask.current?.cancel();
    renderTask.current = null;
    void pdf
      .getPage(page)
      .then((pdfPage: PDFPageProxy) => {
        if (disposed || !canvasRef.current) return;
        const viewport = pdfPage.getViewport({ scale: zoom });
        setPageSize({ width: viewport.width, height: viewport.height });
        void pdfPage.getTextContent().then((textContent) => {
          if (!disposed) setTextRuns(textRunsFromPdfContent(textContent, viewport, zoom));
        });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable.");
        // Render the backing store at the device pixel ratio so the PDF stays
        // crisp and identical across a plain browser and the Tauri WebView2
        // window (which can run at a different Windows display scale / DPR).
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        const task = pdfPage.render({ canvas, canvasContext: context, viewport, transform });
        renderTask.current = task;
        return task.promise;
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
    };
  }, [page, pdf, zoom]);

  return (
    <div className="typeset-pdf-page">
      <canvas ref={canvasRef} aria-label={`PDF page ${page}`} />
      {pageSize && (
        <div
          className="typeset-pdf-text-layer"
          style={{ width: `${pageSize.width}px`, height: `${pageSize.height}px` }}
          aria-label={`PDF text layer page ${page}`}
        >
          {textRuns.map((run, index) => (
            <button
              key={run.id}
              type="button"
              className="typeset-pdf-text-run"
              style={{
                left: `${run.left}px`,
                top: `${run.top}px`,
                width: `${run.width}px`,
                height: `${run.height}px`,
                fontSize: `${run.fontSize}px`,
              }}
              title="Jump to source"
              aria-label={`Jump to source text: ${run.text}`}
              onClick={(event) => {
                event.stopPropagation();
                const context = textRuns.slice(Math.max(0, index - 2), index + 3).map((item) => item.text).join(" ");
                onSourceTextClick(run.text, context);
              }}
            >
              {run.text}
            </button>
          ))}
        </div>
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
  onCompile: () => void;
  onToggleLog: () => void;
  onSourceTextClick: (text: string, context: string) => void;
  onHide?: () => void;
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
  onCompile,
  onToggleLog,
  onSourceTextClick,
  onHide,
}: PdfPreviewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userZoomedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let loadedPdf: PDFDocumentProxy | null = null;
    userZoomedRef.current = false;
    setPdf(null);
    setNumPages(0);
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

  const changeZoom = (delta: number) => {
    userZoomedRef.current = true;
    setZoom((value) => clampNumber(value + delta, 0.45, 2.2));
  };
  const statusText = dirty ? "Unsaved changes" : compileStatusText(status, result);

  return (
    <section className={`typeset-preview pdf${!path ? " pdf-empty" : ""}`} aria-label="PDF preview">
      <div className="typeset-preview-toolbar toolbar toolbar-pdf toolbar-pdf-hybrid">
        <div className="typeset-pdf-left toolbar-pdf-left">
          <span className="typeset-pdf-panel-label">Compiled PDF</span>
          <div className={`typeset-compile-button-group compile-button-group${dirty ? " has-changes" : ""}`}>
            <button
              type="button"
              className={`typeset-recompile-btn compile-button ${status}${dirty ? " btn-striped-animated" : ""}`}
              disabled={disabled}
              onClick={onCompile}
            >
              <ToolIcon name="compile" />
              {status === "running" ? "Compiling" : "Recompile"}
            </button>
            <button
              type="button"
              className="typeset-compile-options compile-dropdown-toggle"
              title="Compile options"
              aria-label="Compile options"
              disabled
            >
              <span aria-hidden="true">v</span>
            </button>
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
        </div>
        <div className="typeset-preview-actions toolbar-pdf-right">
          <span className="typeset-preview-file" title={path ?? ""}>{path ? basename(path) : "Preview"}</span>
          <div className="toolbar-pdf-controls pdfjs-viewer-controls-small">
            <button type="button" className="typeset-icon-btn pdf-toolbar-btn" title="Zoom out" aria-label="Zoom out" onClick={() => changeZoom(-0.1)}>
              <ToolIcon name="minus" />
            </button>
            <span className="typeset-zoom-label pdfjs-zoom-dropdown-button">{Math.round(zoom * 100)}%</span>
            <button type="button" className="typeset-icon-btn pdf-toolbar-btn" title="Zoom in" aria-label="Zoom in" onClick={() => changeZoom(0.1)}>
              <ToolIcon name="plus" />
            </button>
          </div>
          <button type="button" className="typeset-icon-btn" title="Open PDF externally" aria-label="Open PDF externally" disabled={!path} onClick={() => path && void fileOpen(path)}>
            <ToolIcon name="open" />
          </button>
          {onHide && (
            <button type="button" className="typeset-icon-btn" title="Hide PDF preview" aria-label="Hide PDF preview" onClick={onHide}>
              <ToolIcon name="next" />
            </button>
          )}
        </div>
      </div>
      <div className="typeset-pdf-scroll" ref={scrollRef}>
        {!path && <div className="typeset-empty">No PDF selected.</div>}
        {path && loading && <div className="typeset-empty">Loading PDF...</div>}
        {path && error ? (
          <PdfFallbackPage error={error} outputPath={path} sourcePath={sourcePath} />
        ) : (
          null
        )}
        {pdf && !error && Array.from({ length: numPages }, (_, index) => (
          <PdfPage
            key={`${path}:${refreshKey}:${index + 1}`}
            pdf={pdf}
            page={index + 1}
            zoom={zoom}
            onSourceTextClick={onSourceTextClick}
          />
        ))}
      </div>
    </section>
  );
}

function CompileLog({
  result,
  status,
  error,
  onClose,
}: {
  result: CompileResult | null;
  status: CompileStatus;
  error: string | null;
  onClose?: () => void;
}) {
  const text = [error, result?.stderr, result?.stdout].filter(Boolean).join("\n\n").trim();
  return (
    <section className={`typeset-log new-logs-pane ${status === "error" ? "error" : ""}`} aria-label="Compile log">
      <div className="typeset-log-head">
        <strong>Compile log</strong>
        <span>{compileStatusText(status, result)}</span>
        {onClose && (
          <button type="button" className="typeset-icon-btn" title="Close log" aria-label="Close log" onClick={onClose}>
            <ToolIcon name="clear" />
          </button>
        )}
      </div>
      <div className="logs-pane-content">
        <pre>{text || "No diagnostics."}</pre>
      </div>
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
  height: number;
  onJumpToLine: (line: number) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleCollapsed: () => void;
}) {
  if (outline.length === 0) {
    return (
      <section className="typeset-outline empty" aria-label="Document outline">
        <div className="typeset-outline-head">
          <strong>Outline</strong>
          <span>0</span>
        </div>
        <span className="typeset-outline-empty">No sections found.</span>
      </section>
    );
  }

  if (collapsed) {
    return (
      <section className="typeset-outline-collapsed" aria-label="Document outline">
        <button type="button" onClick={onToggleCollapsed}>
          <ToolIcon name="list" />
          <span>Outline</span>
          <em>{outline.length}</em>
        </button>
      </section>
    );
  }

  return (
    <>
      <div
        className="typeset-outline-resize"
        role="separator"
        aria-label="Resize Outline"
        aria-orientation="horizontal"
        aria-valuemin={OUTLINE_PANEL_MIN_H}
        aria-valuemax={OUTLINE_PANEL_MAX_H}
        aria-valuenow={height}
        title="Drag to resize Outline"
        tabIndex={0}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizePointerDown}
      >
        <span aria-hidden="true" />
      </div>
      <section className="typeset-outline" aria-label="Document outline" style={{ flexBasis: `${height}px` }}>
      <div className="typeset-outline-head">
        <strong>Outline</strong>
        <span>{outline.length}</span>
        <button type="button" className="typeset-outline-toggle" title="Hide Outline" aria-label="Hide Outline" onClick={onToggleCollapsed}>
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
            style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
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

function TypesetEditorToolbar({
  activeOutlineItem,
  draft,
  mode,
  canRedo,
  canUndo,
  dirty,
  editorRef,
  visualViewRef,
  onChange,
  onModeChange,
  onRedo,
  onSave,
  onSearch,
  onUndo,
  path,
  saving,
}: {
  activeOutlineItem: NumberedOutlineItem | null;
  draft: string;
  mode: EditorMode;
  canRedo: boolean;
  canUndo: boolean;
  dirty: boolean;
  editorRef: { current: HTMLTextAreaElement | null };
  visualViewRef: { current: EditorView | null };
  onChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onRedo: () => void;
  onSave: () => void;
  onSearch: (start: number, end: number) => void;
  onUndo: () => void;
  path: string | null;
  saving: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchMatches = useMemo(() => textSearchMatches(draft, searchQuery), [draft, searchQuery]);
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
  const insertCitation = () => withSelection((adapter) => insertSnippetAtCursor(adapter, "\\cite{", "reference", "}"));
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
    <div className="typeset-visual-toolbar ol-cm-toolbar-wrapper" aria-label="Editor tools">
      <div className="typeset-visual-toolbar-row ol-cm-toolbar toolbar-editor" role="toolbar" aria-label="Editor toolbar">
        <div className="ol-cm-toolbar-button-group" aria-label="Undo Redo actions">
          <button type="button" className="ol-cm-toolbar-button" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><ToolIcon name="undo" /></button>
          <button type="button" className="ol-cm-toolbar-button" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><ToolIcon name="redo" /></button>
          <button
            type="button"
            className="ol-cm-toolbar-button"
            title={dirty ? "Save" : "No unsaved changes"}
            aria-label="Save"
            disabled={saving || !dirty}
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
        <div className="typeset-current-section" aria-live="polite" title={activeOutlineItem?.title ?? "No section selected"}>
          <ToolIcon name="list" />
          <span>{activeOutlineItem ? `Section ${activeOutlineItem.number} ${activeOutlineItem.title}` : "No section"}</span>
        </div>
        <div className="typeset-visual-mode-switch editor-switch" role="tablist" aria-label="Editor mode">
          <button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "active" : ""} onClick={() => onModeChange("code")}>Code</button>
          <button type="button" role="tab" aria-selected={mode === "visual"} className={mode === "visual" ? "active" : ""} onClick={() => onModeChange("visual")}>Visual</button>
        </div>
      </div>
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

function TypesetStartPage({
  projectPath,
  sources,
  folders,
  loading,
  error,
  onOpenSource,
  onCreateSource,
}: {
  projectPath: string | null;
  sources: string[];
  folders: FileTreeEntry[];
  loading: boolean;
  error: string | null;
  onOpenSource: (path: string) => void;
  onCreateSource: (path: string) => void;
}) {
  const [currentFolder, setCurrentFolder] = useState("");
  const [entries, setEntries] = useState<FileTreeEntry[]>(folders);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const selectedPrefix = currentFolder ? `${currentFolder}/` : "";
  const latexPath = `${selectedPrefix}main.tex`;
  const scannedSources = useMemo(
    () =>
      sortedSources(sources).map((path) => ({
        name: basename(path),
        path,
        isDir: false,
      })),
    [sources],
  );
  const visibleSources = useMemo(
    () =>
      currentFolder
        ? entries
            .filter((entry) => !entry.isDir && extension(entry.path) === ".tex")
            .sort((left, right) => left.name.localeCompare(right.name))
        : scannedSources,
    [currentFolder, entries, scannedSources],
  );
  const visibleFolders = useMemo(
    () => entries.filter((entry) => entry.isDir).sort((left, right) => left.name.localeCompare(right.name)),
    [entries],
  );
  const sourceCountText = loading || (folderLoading && currentFolder)
    ? "Loading"
    : currentFolder
      ? `${visibleSources.length} here, ${sources.length} total`
      : `${sources.length} total`;

  useEffect(() => {
    let cancelled = false;
    setFolderLoading(true);
    setFolderError(null);
    void fileListDir(currentFolder || null)
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setEntries([]);
          setFolderError(String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) setFolderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentFolder]);

  useEffect(() => {
    if (!currentFolder) setEntries(folders);
  }, [currentFolder, folders]);

  useEffect(() => {
    setCurrentFolder("");
  }, [projectPath]);

  return (
    <section className="typeset-start" aria-label="Choose typesetting source">
      {error && <div className="typeset-error-bar">{error}</div>}
      <div className="typeset-start-grid">
        <section className="typeset-start-panel">
          <div className="typeset-start-panel-head">
            <strong>Folders</strong>
            <span>{folderLoading ? "Loading" : `${visibleFolders.length}`}</span>
          </div>
          <div className="typeset-folder-list">
            {currentFolder && (
              <button type="button" onClick={() => setCurrentFolder(dirname(currentFolder))}>
                <span className="typeset-folder-up">..</span>
                <span>Parent folder</span>
              </button>
            )}
            {visibleFolders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                onClick={() => setCurrentFolder(folder.path)}
              >
                <FileIcon path={folder.name} dir />
                <span>{folder.name}</span>
              </button>
            ))}
            {!folderLoading && visibleFolders.length === 0 && !currentFolder && (
              <div className="typeset-start-empty">No folders found.</div>
            )}
          </div>
          <div className="typeset-start-create">
            <button type="button" className="typeset-recompile-btn" onClick={() => onCreateSource(latexPath)}>
              <ToolIcon name="new" />
              New main.tex
            </button>
          </div>
        </section>
        <section className="typeset-start-panel">
          <div className="typeset-start-panel-head">
            <strong>Sources</strong>
            <span>{sourceCountText}</span>
          </div>
          <div className="typeset-start-list">
            {folderError && <div className="typeset-start-empty">{folderError}</div>}
            {!folderError && visibleSources.length === 0 ? (
              <div className="typeset-start-empty">No .tex files found.</div>
            ) : (
              visibleSources.map((entry) => (
                <button key={entry.path} type="button" className="typeset-source-choice" onClick={() => onOpenSource(entry.path)}>
                  <FileIcon path={entry.path} />
                  <span>
                    <strong>{entry.name}</strong>
                    <em>{dirname(entry.path) || "Project root"}</em>
                  </span>
                  <b>LaTeX</b>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function outlineFor(source: string): OutlineItem[] {
  const latexLevels: Record<string, number> = {
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };
  return source
    .split("\n")
    .map((line, index) => {
      const latexMatch = /^\\(chapter|section|subsection|subsubsection)\*?\{(.+?)\}/.exec(line.trim());
      if (latexMatch) {
        return { line: index + 1, level: latexLevels[latexMatch[1]] ?? 2, title: latexMatch[2] };
      }
      return null;
    })
    .filter((item): item is { line: number; level: number; title: string } => Boolean(item));
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

function lineOffsetFor(source: string, line: number): number {
  const lines = source.split("\n");
  return lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0);
}

function editorLineMetrics(textarea: HTMLTextAreaElement): { lineHeight: number; paddingTop: number } {
  const style = window.getComputedStyle(textarea);
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const rawLineHeight = style.lineHeight;
  const parsedLineHeight = Number.parseFloat(rawLineHeight);
  const lineHeight = rawLineHeight.endsWith("px")
    ? parsedLineHeight || fontSize * 1.58
    : parsedLineHeight > 0
      ? parsedLineHeight * fontSize
      : fontSize * 1.58;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  return { lineHeight, paddingTop };
}

function codeVisibleLineForScroll(scrollTarget: HTMLElement, textarea: HTMLTextAreaElement, source: string): number {
  const { lineHeight, paddingTop } = editorLineMetrics(textarea);
  const lineCount = Math.max(1, source.split("\n").length);
  return clampNumber(Math.floor((scrollTarget.scrollTop - paddingTop) / lineHeight) + 1, 1, lineCount);
}

function scrollCodeEditorToLine(textarea: HTMLTextAreaElement, line: number): void {
  const scrollTarget = textarea.closest<HTMLElement>(".lab-editor");
  if (!scrollTarget) return;
  const { lineHeight, paddingTop } = editorLineMetrics(textarea);
  const targetTop = paddingTop + Math.max(0, line - 1) * lineHeight;
  scrollTarget.scrollTop = Math.max(0, targetTop - scrollTarget.clientHeight * 0.28);
}

export default function Typeset() {
  const currentProject = useStore((state) => state.currentProject);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [draftHistory, setDraftHistory] = useState<DraftHistory>({ past: [], future: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [startSources, setStartSources] = useState<string[]>([]);
  const [startFolders, setStartFolders] = useState<FileTreeEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [visualPdfCursor, setVisualPdfCursor] = useState<VisualPdfCursor | null>(null);
  const [projectPanelVisible, setProjectPanelVisible] = useState(true);
  const [pdfPanelVisible, setPdfPanelVisible] = useState(true);
  const [projectPanelWidth, setProjectPanelWidth] = useState(PROJECT_PANEL_DEFAULT_W);
  const [pdfPanelWidth, setPdfPanelWidth] = useState(PDF_PANEL_DEFAULT_W);
  const [outlinePanelHeight, setOutlinePanelHeight] = useState(OUTLINE_PANEL_DEFAULT_H);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [currentSourceLine, setCurrentSourceLine] = useState(1);
  // Mirror the panel widths into refs so the drag callbacks can read the current
  // size without listing the widths as dependencies. Keeping the callbacks stable
  // stops the window/document listener effect from tearing down (and aborting the
  // active drag) every time a resize updates the width state.
  const projectPanelWidthRef = useRef(projectPanelWidth);
  const pdfPanelWidthRef = useRef(pdfPanelWidth);
  const outlinePanelHeightRef = useRef(outlinePanelHeight);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  projectPanelWidthRef.current = projectPanelWidth;
  pdfPanelWidthRef.current = pdfPanelWidth;
  outlinePanelHeightRef.current = outlinePanelHeight;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
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

  const dirty = Boolean(loaded && draft !== loaded.content);
  const outline = useMemo(() => outlineFor(draft), [draft]);
  const numberedOutline = useMemo(() => numberedOutlineFor(outline), [outline]);
  const activeOutlineItem = useMemo(
    () => activeOutlineItemForLine(numberedOutline, currentSourceLine),
    [currentSourceLine, numberedOutline],
  );
  const activeWorkDir = useMemo(() => workDirForSource(sourcePath), [sourcePath]);
  const browserPreviewMode = !isTauri();
  const diagnosticsCount = useMemo(() => {
    const text = [error, compileResult?.stderr].filter(Boolean).join("\n").trim();
    if (!text) return 0;
    const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return Math.min(count, 9);
  }, [compileResult?.stderr, error]);
  const canUndoDraft = draftHistory.past.length > 0;
  const canRedoDraft = draftHistory.future.length > 0;

  const resetDraft = useCallback((nextDraft: string) => {
    setDraft(nextDraft);
    setDraftHistory({ past: [], future: [] });
  }, []);

  const changeDraft = useCallback((nextDraft: string) => {
    setDraft((current) => {
      if (nextDraft === current) return current;
      setDraftHistory((history) => ({
        past: [...history.past, current].slice(-100),
        future: [],
      }));
      return nextDraft;
    });
  }, []);

  const undoDraft = useCallback(() => {
    setDraftHistory((history) => {
      if (!history.past.length) return history;
      const previous = history.past[history.past.length - 1];
      setDraft(previous);
      return {
        past: history.past.slice(0, -1),
        future: [draft, ...history.future].slice(0, 100),
      };
    });
  }, [draft]);

  const redoDraft = useCallback(() => {
    setDraftHistory((history) => {
      if (!history.future.length) return history;
      const next = history.future[0];
      setDraft(next);
      return {
        past: [...history.past, draft].slice(-100),
        future: history.future.slice(1),
      };
    });
  }, [draft]);

  const openSource = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const file = await fileReadText(path);
      setSourcePath(file.path);
      setPreviewPath(outputPathFor(file.path));
      setLoaded(file);
      resetDraft(file.content);
      setVisualPdfCursor(null);
      setCurrentSourceLine(1);
      setCompileStatus("idle");
      setCompileResult(null);
    } catch (openError) {
      setError(String(openError));
    } finally {
      setLoading(false);
    }
  }, [resetDraft]);

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

  const createSource = useCallback(async (path: string) => {
    setError(null);
    try {
      const normalized = normalizeNewTypesetPath(path);
      const file = await fileCreateText(normalized, defaultSourceFor(normalized));
      setTreeRefreshKey((key) => key + 1);
      setSourcePath(file.path);
      setPreviewPath(outputPathFor(file.path));
      setLoaded(file);
      resetDraft(file.content);
      setVisualPdfCursor(null);
      setCurrentSourceLine(1);
      setCompileStatus("idle");
      setCompileResult(null);
    } catch (createError) {
      setError(String(createError));
    }
  }, [resetDraft]);

  const scanProject = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoaded(null);
    resetDraft("");
    setSourcePath(null);
    setPreviewPath(null);
    setCompileStatus("idle");
    setCompileResult(null);
    setLogOpen(false);
    setVisualPdfCursor(null);
    setCurrentSourceLine(1);
    autoCompiledPathRef.current = null;
    try {
      const [latexMatches, rootEntries] = await Promise.all([
        fileSearch("**/*.tex").catch(() => []),
        fileListDir(null).catch(() => []),
      ]);
      const sortedMatches = sortedSources(latexMatches);
      setStartSources(sortedMatches);
      setStartFolders(rootEntries.filter((entry) => entry.isDir));
      setTreeRefreshKey((key) => key + 1);
      if (isTypesetPreviewMode() && !previewAutoOpenedRef.current) {
        previewAutoOpenedRef.current = true;
        const previewSource = preferredSource(sortedMatches);
        if (previewSource) {
          const file = await fileReadText(previewSource);
          setSourcePath(file.path);
          setPreviewPath(outputPathFor(file.path));
          setLoaded(file);
          resetDraft(file.content);
          setVisualPdfCursor(null);
          setCurrentSourceLine(1);
        }
      }
    } catch (scanError) {
      setStartSources([]);
      setStartFolders([]);
      setError(String(scanError));
    } finally {
      setLoading(false);
    }
  }, [resetDraft]);

  useEffect(() => {
    void scanProject();
  }, [currentProject?.id, scanProject]);

  useEffect(() => {
    const lineCount = Math.max(1, draft.split("\n").length);
    setCurrentSourceLine((line) => clampNumber(line, 1, lineCount));
  }, [draft]);

  const save = useCallback(async (): Promise<FileText | null> => {
    if (!sourcePath || !loaded) return null;
    if (!dirty) return loaded;
    setSaving(true);
    setError(null);
    try {
      const file = await fileWriteText(sourcePath, draft);
      setLoaded(file);
      setDraft(file.content);
      setSourcePath(file.path);
      return file;
    } catch (saveError) {
      setError(String(saveError));
      return null;
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, loaded, sourcePath]);

  const compile = async () => {
    if (!sourcePath || saving || compileStatus === "running") return;
    const openPath = sourcePath;
    setCompileStatus("running");
    setCompileResult(null);
    setError(null);
    await nextAnimationFrame();
    const saved = await save();
    if (!saved) {
      setCompileStatus("idle");
      return;
    }
    const compilePath = saved.path || openPath;
    try {
      const outputPath = outputPathFor(compilePath);
      const result = await latexCompile(compilePath, outputPath);
      setCompileResult(result);
      setCompileStatus(result.success ? "success" : "error");
      setLogOpen(!result.success);
      setPreviewPath(result.outputPath || outputPath);
      setRefreshKey((key) => key + 1);
      setTreeRefreshKey((key) => key + 1);
    } catch (compileError) {
      setCompileStatus("error");
      setError(String(compileError));
      setLogOpen(true);
    }
  };
  compileRef.current = () => {
    void compile();
  };

  // Auto-compile removed: shows last compiled PDF. Click Recompile when ready.
  useEffect(() => {
    if (!sourcePath || !loaded || loading || saving) return;
    if (autoCompiledPathRef.current === sourcePath) return;
    autoCompiledPathRef.current = sourcePath;
    // auto-compile removed, click Recompile when ready
  }, [sourcePath, loaded, loading, saving]);

  const handleEditorKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const shortcut = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (shortcut && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redoDraft();
      } else {
        undoDraft();
      }
      return;
    }
    if (shortcut && key === "y") {
      event.preventDefault();
      redoDraft();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      void save();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void compile();
    }
  };

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      const shortcut = event.ctrlKey || event.metaKey;
      if (!shortcut || event.key.toLowerCase() !== "s") return;
      if (!sourcePath || !loaded) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, [loaded, save, sourcePath]);

  const openCodeAtLine = useCallback((line: number) => {
    const offset = lineOffsetFor(draft, line);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.setTimeout(() => {
      const editor = editorRef.current;
      editor?.focus();
      editor?.setSelectionRange(offset, offset);
      if (editor) scrollCodeEditorToLine(editor, line);
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    }, 0);
  }, [draft]);

  const openCodeRange = useCallback((start: number, end: number) => {
    const safeStart = clampNumber(start, 0, draft.length);
    const safeEnd = clampNumber(end, safeStart, draft.length);
    const line = lineNumberForOffset(draft, safeStart);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.setTimeout(() => {
      const editor = editorRef.current;
      editor?.focus();
      editor?.setSelectionRange(safeStart, safeEnd);
      if (editor) scrollCodeEditorToLine(editor, line);
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    }, 0);
  }, [draft]);

  const openSourceForPdfText = useCallback((text: string, context = text) => {
    const match = findLatexOffsetForPdfText(draft, text, context);
    if (!match) return;
    const cursor = {
      line: lineNumberForOffset(draft, match.start),
      start: match.start,
      end: match.end,
      text: normalizePdfText(text),
    };
    setVisualPdfCursor(cursor);
    setCurrentSourceLine(cursor.line);
    if (editorMode === "visual") {
      setEditorMode("visual");
      return;
    }
    openCodeRange(match.start, match.end);
  }, [draft, editorMode, openCodeRange]);

  const returnToStart = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes and return to the source list?")) {
      return;
    }
    void scanProject();
  }, [dirty, scanProject]);

  useEffect(() => {
    if (editorMode !== "code") return;
    const editor = editorRef.current;
    const scrollTarget = editor?.closest<HTMLElement>(".lab-editor");
    if (!editor || !scrollTarget) return;
    let frame = 0;
    const updateLine = (preferSelection = false) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (preferSelection && document.activeElement === editor) {
          setCurrentSourceLine(lineNumberForOffset(draft, editor.selectionStart));
          return;
        }
        setCurrentSourceLine(codeVisibleLineForScroll(scrollTarget, editor, draft));
      });
    };
    const updateFromScroll = () => updateLine(false);
    const updateFromSelection = () => updateLine(true);
    scrollTarget.addEventListener("scroll", updateFromScroll, { passive: true });
    editor.addEventListener("click", updateFromSelection);
    editor.addEventListener("keyup", updateFromSelection);
    editor.addEventListener("select", updateFromSelection);
    updateLine(true);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", updateFromScroll);
      editor.removeEventListener("click", updateFromSelection);
      editor.removeEventListener("keyup", updateFromSelection);
      editor.removeEventListener("select", updateFromSelection);
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
    const startHeight = outlinePanelHeightRef.current;
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

  const beginGridResizeFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (isEditorScrollbarGutterPointer(event.target, event.clientX, event.clientY)) return;
    const hit = resizeHitFromGridPoint(event.currentTarget, event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    beginPanelResize(hit.panel, hit.axis, event.clientX, event.clientY);
  }, [beginPanelResize]);

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
    setOutlinePanelHeight((height) => clampNumber(height + direction * step, OUTLINE_PANEL_MIN_H, OUTLINE_PANEL_MAX_H));
  }, []);

  const gridClassName = [
    "typeset-main-grid ide-redesign-body",
    !sourcePath && !loaded ? "start-mode" : "",
    !projectPanelVisible ? "project-hidden" : "",
    !pdfPanelVisible ? "pdf-hidden" : "",
  ].filter(Boolean).join(" ");
  const gridStyle = {
    "--typeset-left-user-w": `${projectPanelWidth}px`,
    "--typeset-preview-user-w": `${pdfPanelWidth}px`,
  } as CSSProperties;

  return (
    <div className="typeset-workbench ide-redesign-main">
      {browserPreviewMode && (
        <div className="typeset-runtime-banner" role="status">
          Browser preview uses bundled sample data. Desktop/Tauri reads real project files and compiles through the local backend.
        </div>
      )}
      <div
        className={gridClassName}
        style={gridStyle}
        onPointerDownCapture={beginGridResizeFromPointer}
      >
        {(sourcePath || loaded) && (
          <nav className="typeset-rail ide-rail" aria-label="Typeset sections">
            <div className="ide-rail-tabs-nav">
              <div className="ide-rail-tabs-wrapper">
                <button
                  type="button"
                  className={`ide-rail-tab-link${projectPanelVisible ? " open-rail active" : ""}`}
                  title={projectPanelVisible ? "Hide Project files" : "Show Project files"}
                  aria-label={projectPanelVisible ? "Hide Project files" : "Show Project files"}
                  aria-pressed={projectPanelVisible}
                  onClick={() => setProjectPanelVisible((visible) => !visible)}
                >
                  <ToolIcon name="files" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className={`ide-rail-tab-link${pdfPanelVisible ? " open-rail active" : ""}`}
                  title={pdfPanelVisible ? "Hide PDF panel" : "Show PDF panel"}
                  aria-label={pdfPanelVisible ? "Hide PDF panel" : "Show PDF panel"}
                  aria-pressed={pdfPanelVisible}
                  onClick={() => setPdfPanelVisible((visible) => !visible)}
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
            sources={startSources}
            folders={startFolders}
            loading={loading}
            error={error}
            onOpenSource={openPath}
            onCreateSource={createSource}
          />
        ) : (
          <>
            {projectPanelVisible && (
              <>
                <div className="typeset-left-panel file-tree-outline-panel-group">
                  <TypesetExplorer
                    projectPath={currentProject?.path ?? null}
                    rootPath={activeWorkDir}
                    activeSourcePath={sourcePath}
                    activePreviewPath={previewPath}
                    refreshKey={treeRefreshKey}
                    onOpenPath={openPath}
                  />
                  <TypesetOutlinePanel
                    activeLine={activeOutlineItem?.line ?? null}
                    collapsed={outlineCollapsed}
                    outline={numberedOutline}
                    height={outlinePanelHeight}
                    onJumpToLine={openCodeAtLine}
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
                  path={sourcePath}
                  draft={draft}
                  mode={editorMode}
                  canRedo={canRedoDraft}
                  canUndo={canUndoDraft}
                  editorRef={editorRef}
                  visualViewRef={visualViewRef}
                  onChange={changeDraft}
                  onModeChange={setEditorMode}
                  onRedo={redoDraft}
                  onSave={() => void save()}
                  onSearch={openCodeRange}
                  onUndo={undoDraft}
                  saving={saving}
                  dirty={dirty}
                />
              )}
              {error && <div className="typeset-error-bar">{error}</div>}
              {loading ? (
                <div className="typeset-empty">Loading source...</div>
              ) : loaded ? (
                editorMode === "code" ? (
                  <div className="typeset-editor-body ide-redesign-editor-content">
                    <CodeEditor
                      value={draft}
                      language="latex"
                      onChange={changeDraft}
                      onKeyDown={handleEditorKey}
                      inputRef={(node) => {
                        editorRef.current = node;
                      }}
                      readOnly={saving}
                      placeholder="\\section{Title}"
                    />
                  </div>
                ) : (
                  <TypesetVisualEditor
                    path={sourcePath}
                    draft={draft}
                    pdfCursor={visualPdfCursor}
                    onChange={changeDraft}
                    onVisibleLineChange={setCurrentSourceLine}
                    onOpenCodeAtLine={openCodeAtLine}
                    onOpenCodeRange={openCodeRange}
                    onViewReady={onVisualViewReady}
                  />
                )
              ) : (
                <div className="typeset-empty">Create or open a .tex file.</div>
              )}
            </section>
            {pdfPanelVisible && (
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
                    disabled={!sourcePath || saving || loading || compileStatus === "running"}
                    logOpen={logOpen}
                    diagnosticsCount={diagnosticsCount}
                    onCompile={() => void compile()}
                    onToggleLog={() => setLogOpen((open) => !open)}
                    onSourceTextClick={openSourceForPdfText}
                    onHide={() => setPdfPanelVisible(false)}
                  />
                  {logOpen && <CompileLog result={compileResult} status={compileStatus} error={error} onClose={() => setLogOpen(false)} />}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// LaTeX source edits driven from the visual (click-to-edit) PDF surface:
// retyping a text object, dragging it to a new position, and the TikZ
// scaffolding a moved object needs.
import { clampNumber, type PdfTextObjectGeometry } from "./pdfGeometry";
import { findLatexOffsetForPdfText, normalizePdfText, type TextSearchMatch } from "./pdfTextMatch";

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
export function ensureTikzPackage(source: string): string {
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
export function editPdfTextInLatex(source: string, pdfText: string, context: string, nextText: string): string | null {
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
export function positionPdfTextInFrame(
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
export function insertVisualTextInFrame(
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
export function lineOffsetFor(source: string, line: number): number {
  const lines = source.split("\n");
  return lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0);
}

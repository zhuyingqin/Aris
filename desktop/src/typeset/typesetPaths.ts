// Path conventions for Typeset documents: where a new paper lands, which
// extensions count as figures, and how a .tex path maps to its .pdf.
import { dirname, extension, normalizePath } from "./latexText";

export const DEFAULT_SOURCE_PATH = ".somniq/papers/main.tex";
export const TYPESET_IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
export function outputPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.tex$/i, ".pdf");
}
export function isTypesetImagePath(path: string | null | undefined): path is string {
  return Boolean(path && TYPESET_IMAGE_EXTENSIONS.has(extension(path)));
}
export function normalizeNewTypesetPath(path: string): string {
  const trimmed = normalizePath(path.trim());
  if (!trimmed) return DEFAULT_SOURCE_PATH;
  return /\.tex$/i.test(trimmed) ? trimmed : `${trimmed}.tex`;
}
export function workDirForSource(path: string | null | undefined): string {
  return path ? dirname(path) : "";
}

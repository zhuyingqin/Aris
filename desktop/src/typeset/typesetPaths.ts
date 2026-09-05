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

const IS_WINDOWS_RUNTIME = typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);

/**
 * True when `dir` (a `workDirForSource` result) is `ancestor` itself or
 * nested inside it. `""` denotes the workspace root, the ancestor of every
 * directory.
 */
export function workDirContains(ancestor: string, dir: string): boolean {
  if (ancestor === "") return true;
  const left = IS_WINDOWS_RUNTIME ? ancestor.toLowerCase() : ancestor;
  const right = IS_WINDOWS_RUNTIME ? dir.toLowerCase() : dir;
  return right === left || right.startsWith(`${left}/`);
}

// Path conventions for Typeset documents: where a new paper lands, which
// extensions count as figures, and how a .tex path maps to its .pdf.
import { dirname, extension, normalizePath } from "./latexText";

export const DEFAULT_SOURCE_PATH = ".somniq/papers/main.tex";

/**
 * Image formats the preview panel can actually put in an `<img>`. `.pdf` and
 * `.eps` are figure formats too, but no browser renders them as images — the
 * PDF ones go to the PDF preview instead (see `openPath` in `Typeset.tsx`), so
 * this stays the browser-renderable set and `FIGURE_IMAGE_EXTENSIONS` in
 * `latexFigure.ts` extends it with what `\includegraphics` also accepts.
 */
export const TYPESET_IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);

/**
 * Build artifacts a LaTeX run leaves next to the source. Mirrors
 * `BUILD_ARTIFACT_SUFFIXES` in `src-tauri/src/typeset_state.rs`, which is the
 * authority — the ledger excludes exactly these from revisions, so the file
 * tree and the change-set filter have to agree with it or a `.bcf` shows up as
 * an ordinary file in one surface and as build output in the other.
 *
 * These are suffixes, not extensions: `.run.xml`, `.synctex.gz` and the fixed
 * name `epstopdf` writes are all multi-part.
 */
export const BUILD_ARTIFACT_SUFFIXES = [
  "-eps-converted-to.pdf",
  ".acn", ".acr", ".alg", ".aux", ".auxlock", ".bbl", ".bcf", ".blg", ".brf",
  ".dpth", ".dvi", ".fdb_latexmk", ".figlist", ".fls", ".glg", ".glo", ".gls",
  ".idx", ".ilg", ".ind", ".ist", ".loa", ".lof", ".log", ".lol", ".los",
  ".lot", ".makefile", ".md5", ".nav", ".out", ".run.xml", ".snm", ".synctex",
  ".synctex.gz", ".tdo", ".toc", ".upa", ".upb", ".vrb", ".xdv", ".xdy",
] as const;

export function isBuildArtifactPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return BUILD_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
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

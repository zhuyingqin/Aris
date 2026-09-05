/**
 * The figure the insert dialog builds, and the reverse reading of one that is
 * already in the source — Overleaf's `figure-modal` in model form.
 *
 * Pure string work: the dialog owns the UI, the toolbar owns the insertion.
 */

export const FIGURE_IMAGE_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".gif", ".tif", ".tiff", ".webp"];

/** Width as a fraction of `\linewidth`; 0 means "the image's own size". */
export const FIGURE_WIDTH_CHOICES = [0.25, 0.4, 0.5, 0.6, 0.75, 0.8, 1, 0] as const;

export type FigureDraft = {
  /** Project-relative path, as `\includegraphics` wants it. */
  path: string;
  widthFraction: number;
  caption: string;
  label: string;
  /** `htbp` and friends; empty means no optional argument. */
  placement: string;
  centered: boolean;
};

export const DEFAULT_FIGURE_DRAFT: FigureDraft = {
  path: "",
  widthFraction: 0.8,
  caption: "",
  label: "",
  placement: "htbp",
  centered: true,
};

export function isFigureImage(path: string): boolean {
  const lower = path.toLowerCase();
  return FIGURE_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** LaTeX resolves `\includegraphics{fig/a}` without an extension, and a path
 * with a dot in a directory name would otherwise confuse it. Keep the extension
 * except for the graphics formats TeX picks between itself. */
export function graphicsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A label the user did not type, derived from the file name — `fig:` prefixed
 * the way nearly every LaTeX document does it. */
export function suggestedFigureLabel(path: string): string {
  const base = graphicsPath(path).split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return stem ? `fig:${stem.toLowerCase()}` : "";
}

export function figureIncludeCommand(draft: Pick<FigureDraft, "path" | "widthFraction">): string {
  const path = graphicsPath(draft.path);
  if (!draft.widthFraction) return `\\includegraphics{${path}}`;
  // `\linewidth` rather than `\textwidth`: inside a two-column layout or a
  // minipage it is the one that means "as wide as the space I am in".
  const width = Number(draft.widthFraction.toFixed(2));
  return `\\includegraphics[width=${width}\\linewidth]{${path}}`;
}

/** The whole float, ready to drop at the caret. */
export function figureSnippet(draft: FigureDraft): string {
  const lines = [`\\begin{figure}${draft.placement.trim() ? `[${draft.placement.trim()}]` : ""}`];
  if (draft.centered) lines.push("\\centering");
  lines.push(figureIncludeCommand(draft));
  if (draft.caption.trim()) lines.push(`\\caption{${draft.caption.trim()}}`);
  // A label is only addressable once the caption has set the counter, so it
  // always follows the caption — a `\label` above it references the section.
  if (draft.label.trim()) lines.push(`\\label{${draft.label.trim()}}`);
  lines.push("\\end{figure}");
  return lines.join("\n");
}

export type ParsedIncludeGraphics = {
  from: number;
  to: number;
  path: string;
  widthFraction: number;
};

const INCLUDE_GRAPHICS_RE = /\\includegraphics\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g;

/** Reads the `\includegraphics` covering `position`, so the dialog can open on
 * an existing figure instead of only inserting new ones. */
export function includeGraphicsAt(source: string, position: number): ParsedIncludeGraphics | null {
  INCLUDE_GRAPHICS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INCLUDE_GRAPHICS_RE.exec(source))) {
    const from = match.index;
    const to = from + match[0].length;
    if (position < from || position > to) continue;
    return { from, to, path: match[2].trim(), widthFraction: widthFractionFrom(match[1] ?? "") };
  }
  return null;
}

/** `[width=0.8\linewidth]` → 0.8. Anything we do not understand (a fixed `3cm`,
 * a `scale=`) reads as "own size" so the dialog does not silently rewrite it
 * into a fraction the user never asked for. */
export function widthFractionFrom(options: string): number {
  const match = /width\s*=\s*([0-9.]+)\s*\\(?:line|text|column)width/.exec(options);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

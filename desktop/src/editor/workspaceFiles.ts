import type { EditorLanguage } from "./editorTypes";

const EXTENSION_LANGUAGES = new Map<string, EditorLanguage>([
  [".bash", "bash"],
  [".cjs", "javascript"],
  [".css", "css"],
  [".cts", "typescript"],
  [".env", "ini"],
  [".htm", "xml"],
  [".html", "xml"],
  [".ini", "ini"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsonl", "json"],
  [".jsx", "javascript"],
  [".m", "matlab"],
  [".markdown", "markdown"],
  [".md", "markdown"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".py", "python"],
  [".pyw", "python"],
  [".rs", "rust"],
  [".scss", "css"],
  [".sh", "bash"],
  [".sql", "sql"],
  [".svg", "xml"],
  [".tex", "latex"],
  [".toml", "ini"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".zsh", "bash"],
]);

// Files in this set are understood by the Code workbench (including the
// generic plain-text editor). Keep binary / document formats out so a click on
// a generated PDF, image, or Office document still uses its native viewer.
const CODE_PAGE_FILENAMES = new Set([
  "makefile",
  "dockerfile",
  "compose.yaml",
  "compose.yml",
  "readme",
  "license",
  "agents.md",
]);

export function basename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

export function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function languageForPath(path: string): EditorLanguage {
  return EXTENSION_LANGUAGES.get(extension(path)) ?? "text";
}

/** Whether a workspace file should open in SomniQ's Code page rather than in
 * the operating system's default application. */
function opensInCodePage(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.endsWith(".ipynb")
    || EXTENSION_LANGUAGES.has(extension(path))
    || CODE_PAGE_FILENAMES.has(name);
}

/** The appropriate in-app workspace surface for a file opened from Chat. */
export type WorkspaceFileOpenTarget = "code" | "latex" | "pdf" | "external";

const TYPESET_IMAGE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
]);

export function workspaceFileOpenTarget(path: string): WorkspaceFileOpenTarget {
  const ext = extension(path);
  // TeX is a CodeMirror language too, but Chat should take it to the dedicated
  // LaTeX workspace so it retains the document tools and PDF companion view.
  if (ext === ".tex" || TYPESET_IMAGE_EXTENSIONS.has(ext)) return "latex";
  if (ext === ".pdf") return "pdf";
  return opensInCodePage(path) ? "code" : "external";
}

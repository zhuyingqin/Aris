import type { EditorLanguage } from "./CodeEditor";
import type { SharedEditorHandle } from "../editor/editorTypes";
import type { KernelSpecInfo } from "./labTypes";

export interface TextSelection {
  start: number;
  end: number;
}

export interface RuntimeChoice {
  runtimeSpecs: KernelSpecInfo[];
  activeRuntime: string | null;
  activeSpec: KernelSpecInfo | null;
}

export interface ExternalFileChange {
  reviewBase: string;
  draft: string;
}

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
export function opensInCodePage(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.endsWith(".ipynb")
    || EXTENSION_LANGUAGES.has(extension(path))
    || CODE_PAGE_FILENAMES.has(name);
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function selectedTextOrCurrentLine(text: string, selection: TextSelection): string {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  if (end > start) return text.slice(start, end);
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = text.indexOf("\n", end);
  return text.slice(lineStart, lineEnd >= 0 ? lineEnd : text.length);
}

export function editorSelectionOrLine(text: string, editor: SharedEditorHandle | null): string {
  if (!editor) return text;
  const { from, to } = editor.getSelection().main;
  return selectedTextOrCurrentLine(text, { start: from, end: to });
}

export function runtimeChoiceForLanguage(
  kernelspecs: KernelSpecInfo[],
  selectedKernel: string | null,
  language: EditorLanguage,
): RuntimeChoice {
  const languageSpecs = language === "python"
    ? kernelspecs.filter((spec) => spec.language === "python" || spec.name.toLowerCase().includes("python"))
    : [];
  const runtimeSpecs = languageSpecs.length > 0 ? languageSpecs : kernelspecs;
  const activeRuntime =
    runtimeSpecs.find((spec) => spec.name === selectedKernel)?.name
    ?? runtimeSpecs[0]?.name
    ?? selectedKernel
    ?? null;
  const activeSpec = runtimeSpecs.find((spec) => spec.name === activeRuntime) ?? null;
  return { runtimeSpecs, activeRuntime, activeSpec };
}

export function detectExternalFileChange({
  currentLoadedContent,
  incomingContent,
  draft,
  reviewBase,
  saving,
}: {
  currentLoadedContent: string | null;
  incomingContent: string;
  draft: string;
  reviewBase: string | null;
  saving: boolean;
}): ExternalFileChange | null {
  if (saving || currentLoadedContent === null) return null;
  if (incomingContent === currentLoadedContent) return null;
  if (draft !== currentLoadedContent) return null;
  return {
    reviewBase: reviewBase ?? currentLoadedContent,
    draft: incomingContent,
  };
}

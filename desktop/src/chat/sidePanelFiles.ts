import { basename, extension } from "../editor/workspaceFiles";

/**
 * How the side panel should render a file. Everything that is not a known
 * binary document (PDF) or bitmap is treated as text: the backend's
 * `file_read_text` already rejects oversized and non-decodable files, so the
 * viewer can fall back to an error state instead of guessing extensions here.
 */
export type SideFileKind = "pdf" | "image" | "markdown" | "text";

/**
 * What a side panel tab reports back to the shell: the label the tab strip
 * shows, and the text (if any) its "send to main task" action hands over.
 */
export interface SidePanelMetadata {
  title: string;
  handoff: string | null;
}

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const IMAGE_MIME: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function sideFileKind(path: string): SideFileKind {
  const ext = extension(path);
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
}

export function imageMimeType(path: string): string {
  return IMAGE_MIME[extension(path)] ?? "application/octet-stream";
}

/** Tab label for a file: the file name, shortened so the tab strip stays readable. */
export function sideFileTitle(path: string, maxChars = 24): string {
  const name = basename(path);
  const chars = [...name];
  if (chars.length <= maxChars) return name;
  const extensionPart = extension(path);
  const head = chars.slice(0, Math.max(4, maxChars - extensionPart.length - 1)).join("");
  return `${head}…${extensionPart}`;
}

/**
 * Text handed to the main task when a reading tab is sent back. A selection is
 * quoted verbatim so the main chat can reason about the exact passage; without
 * one only the path is handed over, which is enough for the agent to re-read.
 */
export function fileHandoff(
  path: string,
  selection: string,
  language: "cn" | "en",
  page?: number | null,
): string {
  const quote = selection.replace(/\s+$/g, "").trim();
  const location = page && page > 0
    ? language === "cn" ? `${path} · 第 ${page} 页` : `${path} · page ${page}`
    : path;
  if (!quote) {
    return language === "cn"
      ? `[侧栏文件 · ${location}]\n\n请阅读这个文件后继续。`
      : `[Side panel file · ${location}]\n\nRead this file before continuing.`;
  }
  return language === "cn"
    ? `[侧栏摘录 · ${location}]\n\n"""\n${quote}\n"""`
    : `[Side panel excerpt · ${location}]\n\n"""\n${quote}\n"""`;
}

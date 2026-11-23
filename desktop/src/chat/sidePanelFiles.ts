import type { Language } from "../store";
import { basename, extension } from "../editor/workspaceFiles";
import { isImagePath } from "../imageFiles";
import { tr } from "../language";
export { imageMimeType } from "../imageFiles";

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

export function sideFileKind(path: string): SideFileKind {
  const ext = extension(path);
  if (ext === ".pdf") return "pdf";
  if (isImagePath(path)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
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
  language: Language,
  page?: number | null,
): string {
  const quote = selection.replace(/\s+$/g, "").trim();
  const location = page && page > 0
    ? tr(language, `${path} · 第 ${page} 页`, `${path} · page ${page}`, `${path} · página ${page}`)
    : path;
  if (!quote) {
    return tr(
      language,
      `[侧栏文件 · ${location}]\n\n请阅读这个文件后继续。`,
      `[Side panel file · ${location}]\n\nRead this file before continuing.`,
      `[Archivo del panel lateral · ${location}]\n\nLee este archivo antes de continuar.`,
    );
  }
  return tr(
    language,
    `[侧栏摘录 · ${location}]\n\n"""\n${quote}\n"""`,
    `[Side panel excerpt · ${location}]\n\n"""\n${quote}\n"""`,
    `[Extracto del panel lateral · ${location}]\n\n"""\n${quote}\n"""`,
  );
}

/**
 * The live handoff text of an open reading tab, keyed by tab id.
 *
 * The page a PDF reader is showing changes on every few hundred pixels of
 * scrolling. Folding it into the tab's stored `handoff` made each of those a
 * state change in `Chat`, so scrolling a PDF re-rendered the whole chat tree and
 * rewrote the side panel's localStorage entry at scroll frequency. The page is
 * only ever needed at the moment the reader presses "send to main task", so the
 * tab registers a getter here instead and `handoff` in state stays stable.
 */
const liveHandoffs = new Map<string, () => string>();

export function registerSidePanelHandoff(tabId: string, build: () => string): () => void {
  liveHandoffs.set(tabId, build);
  return () => {
    if (liveHandoffs.get(tabId) === build) liveHandoffs.delete(tabId);
  };
}

/** The live text if the tab is still mounted, else the value persisted with it. */
export function sidePanelHandoff(tabId: string, stored: string | null): string | null {
  return liveHandoffs.get(tabId)?.() ?? stored;
}

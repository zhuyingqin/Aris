// Per-project Typeset preferences kept in localStorage: which engine compiles,
// whether saving triggers a compile, which file is the main document, and the
// view toggles that should survive a restart.
import type { LatexEngineChoice } from "./compileModel";

export type CompileErrorHandling = "stop" | "continue";

export const COMPILE_ERROR_HANDLING_STORAGE_PREFIX = "somniq-typeset-compile-error-handling:";
export const SPELL_CHECK_STORAGE_KEY = "somniq-typeset-spellcheck";
export function loadSpellCheckPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SPELL_CHECK_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}
export function compileErrorHandlingStorageKey(projectId?: string): string {
  return `${COMPILE_ERROR_HANDLING_STORAGE_PREFIX}${projectId ?? "default"}`;
}
export const LATEX_ENGINE_STORAGE_PREFIX = "somniq-typeset-engine:";
export const COMPILE_ON_SAVE_STORAGE_PREFIX = "somniq-typeset-compile-on-save:";
export const MAIN_DOCUMENT_STORAGE_PREFIX = "somniq-typeset-main-document:";
export const PDF_INVERT_STORAGE_KEY = "somniq-typeset-pdf-invert";
export function projectScopedKey(prefix: string, projectId?: string): string {
  return `${prefix}${projectId ?? "default"}`;
}
export function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStoredValue(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A blocked localStorage costs the preference, never the editor.
  }
}
export function loadLatexEngineChoice(projectId?: string): LatexEngineChoice {
  const stored = readStoredValue(projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, projectId));
  return stored === "pdflatex" || stored === "xelatex" || stored === "lualatex" ? stored : "auto";
}
export function loadCompileOnSave(projectId?: string): boolean {
  // Default on: a save that leaves the PDF stale is the state people complain about.
  return readStoredValue(projectScopedKey(COMPILE_ON_SAVE_STORAGE_PREFIX, projectId)) !== "off";
}
export function loadMainDocument(projectId?: string): string | null {
  const stored = readStoredValue(projectScopedKey(MAIN_DOCUMENT_STORAGE_PREFIX, projectId));
  return stored && stored.trim() ? stored : null;
}
export function loadPdfInverted(): boolean {
  return readStoredValue(PDF_INVERT_STORAGE_KEY) === "on";
}
export function loadCompileErrorHandling(projectId?: string): CompileErrorHandling {
  if (typeof window === "undefined") return "stop";
  try {
    return window.localStorage.getItem(compileErrorHandlingStorageKey(projectId)) === "continue"
      ? "continue"
      : "stop";
  } catch {
    return "stop";
  }
}

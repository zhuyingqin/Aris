// Compile state shared by the Typeset shell, the PDF preview and the log panel.
import type { LatexCompileResult } from "../api/tauri";
import type { Language } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";

export type CompileStatus = "idle" | "running" | "success" | "partial" | "error";
export type CompileResult = LatexCompileResult;
export type CompileLiveLog = { stdout: string; stderr: string; elapsedMs: number };
export type CompileLogFilter = "all" | "error" | "warning" | "info";
export type CompileLogLevel = Exclude<CompileLogFilter, "all">;

export type LatexEngineChoice = "auto" | "pdflatex" | "xelatex" | "lualatex";
export const LATEX_ENGINE_CHOICES: readonly LatexEngineChoice[] = ["auto", "pdflatex", "xelatex", "lualatex"];

export function compileStatusText(status: CompileStatus, result: CompileResult | null, language: Language): string {
  const copy = TYPESET_EDITOR_COPY[language].compileStatus;
  if (status === "running") return copy.compiling;
  if (status === "success") {
    if (!result) return copy.compiled;
    return copy.compiledDuration(result.engine, result.durationMs);
  }
  if (status === "partial") return copy.compiledWithErrors;
  if (status === "error") return copy.compileFailed;
  return "";
}

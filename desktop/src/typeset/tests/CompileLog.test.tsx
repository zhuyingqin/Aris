// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatexCompileResult } from "../../api/tauri";
import { useStore } from "../../store";
import CompileLog from "../CompileLog";
import { TYPESET_EDITOR_COPY } from "../i18n";

beforeEach(() => useStore.setState({ language: "en" }));
afterEach(cleanup);

const failure = (code: string): LatexCompileResult => ({
  success: false, inputPath: "main.tex", outputPath: "main.pdf", engine: "latexmk",
  stdout: "No file main.toc.\nNo file main.bbl.", stderr: "Compile stopped",
  interrupted: false, timedOut: false, durationMs: 120_000,
  partialOutput: false, pdfState: "missing", rootSourceHash: "source", compiledAtUnixMs: 1,
  diagnostics: [{ severity: "error", code, message: "Compilation stopped" }],
});

describe("compile failure guidance", () => {
  it.each(["compile_timeout", "compile_failed"])("explains timeouts for %s, including older results", (code) => {
    const result = { ...failure(code), interrupted: true, timedOut: true, returnCodeInterpretation: "timeout" };
    render(<CompileLog result={result} status="error" error={null} liveLog={null} onDiagnosticClick={vi.fn()} />);
    expect(screen.getByText(TYPESET_EDITOR_COPY.en.compileLog.timeoutGuidance)).toBeTruthy();
    expect(screen.queryByText(TYPESET_EDITOR_COPY.en.compileLog.errorGuidance)).toBeNull();
    expect(screen.queryByRole("button", { name: /Open main.tex/ })).toBeNull();
  });

  it.each(["en", "cn"] as const)("does not invent a source location for unlocated failures in %s", (language) => {
    useStore.setState({ language });
    render(<CompileLog result={failure("compile_failed")} status="error" error={null} liveLog={null} />);
    expect(screen.getByText(TYPESET_EDITOR_COPY[language].compileLog.unlocatedErrorGuidance)).toBeTruthy();
  });

  it("keeps a real source error actionable even if the process later times out", () => {
    const result = failure("file_line_error");
    result.timedOut = true;
    result.diagnostics[0].filePath = "main.tex";
    result.diagnostics[0].line = 7;
    render(<CompileLog result={result} status="error" error={null} liveLog={null} onDiagnosticClick={vi.fn()} />);
    expect(screen.getByText(TYPESET_EDITOR_COPY.en.compileLog.errorGuidance)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open main.tex, 7" })).toBeTruthy();
  });
});

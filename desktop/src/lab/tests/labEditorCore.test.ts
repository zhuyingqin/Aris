import { describe, expect, it } from "vitest";

import {
  detectExternalFileChange,
  languageForPath,
  normalizePath,
  runtimeChoiceForLanguage,
  selectedTextOrCurrentLine,
} from "../labEditorCore";
import type { KernelSpecInfo } from "../labTypes";

const kernels: KernelSpecInfo[] = [
  { name: "python3", displayName: "Python 3", language: "python" },
  { name: "matlab", displayName: "MATLAB", language: "matlab" },
  { name: "julia-1.10", displayName: "Julia 1.10", language: "julia" },
];

describe("labEditorCore", () => {
  it("maps common source paths to editor languages", () => {
    expect(languageForPath("src/main.py")).toBe("python");
    expect(languageForPath("web/App.TSX")).toBe("typescript");
    expect(languageForPath("paper/main.tex")).toBe("latex");
    expect(languageForPath("notes/README.md")).toBe("markdown");
    expect(languageForPath("Makefile")).toBe("text");
  });

  it("normalizes paths for event matching", () => {
    expect(normalizePath("SRC\\main.py\\")).toBe("src/main.py");
  });

  it("uses selection when present and otherwise returns the current line", () => {
    const text = "alpha\nbeta = 2\ngamma";

    expect(selectedTextOrCurrentLine(text, { start: 6, end: 10 })).toBe("beta");
    expect(selectedTextOrCurrentLine(text, { start: 13, end: 13 })).toBe("beta = 2");
    expect(selectedTextOrCurrentLine(text, { start: text.length, end: text.length })).toBe("gamma");
  });

  it("chooses a language-appropriate runtime before falling back to the selected kernel", () => {
    expect(runtimeChoiceForLanguage(kernels, "matlab", "python")).toMatchObject({
      activeRuntime: "python3",
      activeSpec: kernels[0],
    });
    expect(runtimeChoiceForLanguage([], "custom-python", "python")).toMatchObject({
      activeRuntime: "custom-python",
      activeSpec: null,
    });
  });

  it("detects clean external edits without clobbering local drafts", () => {
    expect(detectExternalFileChange({
      currentLoadedContent: "x = 1",
      incomingContent: "x = 2",
      draft: "x = 1",
      reviewBase: null,
      saving: false,
    })).toEqual({ reviewBase: "x = 1", draft: "x = 2" });

    expect(detectExternalFileChange({
      currentLoadedContent: "x = 1",
      incomingContent: "x = 2",
      draft: "x = 99",
      reviewBase: null,
      saving: false,
    })).toBeNull();
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileErrorHandlingStorageKey,
  loadCompileErrorHandling,
  loadCompileOnSave,
  loadLatexEngineChoice,
  loadMainDocument,
  loadPdfInverted,
  loadSpellCheckPreference,
  projectScopedKey,
  readStoredValue,
  writeStoredValue,
  COMPILE_ON_SAVE_STORAGE_PREFIX,
  LATEX_ENGINE_STORAGE_PREFIX,
  MAIN_DOCUMENT_STORAGE_PREFIX,
  PDF_INVERT_STORAGE_KEY,
  SPELL_CHECK_STORAGE_KEY,
} from "../typesetPreferences";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("key scoping", () => {
  it("scopes a key to the project, falling back to a shared default", () => {
    expect(projectScopedKey("p:", "abc")).toBe("p:abc");
    expect(projectScopedKey("p:")).toBe("p:default");
    expect(compileErrorHandlingStorageKey("abc")).toBe("somniq-typeset-compile-error-handling:abc");
    expect(compileErrorHandlingStorageKey()).toBe("somniq-typeset-compile-error-handling:default");
  });

  it("keeps two projects' preferences apart", () => {
    writeStoredValue(projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, "one"), "xelatex");
    writeStoredValue(projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, "two"), "lualatex");
    expect(loadLatexEngineChoice("one")).toBe("xelatex");
    expect(loadLatexEngineChoice("two")).toBe("lualatex");
    expect(loadLatexEngineChoice("three")).toBe("auto");
  });
});

describe("writeStoredValue", () => {
  it("removes the entry when handed null", () => {
    writeStoredValue("k", "v");
    expect(readStoredValue("k")).toBe("v");
    writeStoredValue("k", null);
    expect(readStoredValue("k")).toBeNull();
  });

  it("swallows a blocked localStorage rather than breaking the editor", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeStoredValue("k", "v")).not.toThrow();
  });

  it("reads null instead of throwing when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredValue("k")).toBeNull();
    expect(loadCompileErrorHandling("p")).toBe("stop");
    expect(loadSpellCheckPreference()).toBe(false);
  });
});

describe("engine choice", () => {
  it("accepts only the three real engines", () => {
    for (const engine of ["pdflatex", "xelatex", "lualatex"]) {
      writeStoredValue(projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, "p"), engine);
      expect(loadLatexEngineChoice("p")).toBe(engine);
    }
  });

  it("falls back to auto for anything else", () => {
    writeStoredValue(projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, "p"), "latexmk");
    expect(loadLatexEngineChoice("p")).toBe("auto");
    window.localStorage.clear();
    expect(loadLatexEngineChoice("p")).toBe("auto");
  });
});

describe("compile-on-save", () => {
  it("defaults to on, because a save that leaves the PDF stale is the complaint", () => {
    expect(loadCompileOnSave("p")).toBe(true);
  });

  it("is off only for the exact string \"off\"", () => {
    writeStoredValue(projectScopedKey(COMPILE_ON_SAVE_STORAGE_PREFIX, "p"), "off");
    expect(loadCompileOnSave("p")).toBe(false);
    writeStoredValue(projectScopedKey(COMPILE_ON_SAVE_STORAGE_PREFIX, "p"), "false");
    expect(loadCompileOnSave("p")).toBe(true);
  });
});

describe("main document", () => {
  it("treats a blank stored path as unset", () => {
    writeStoredValue(projectScopedKey(MAIN_DOCUMENT_STORAGE_PREFIX, "p"), "   ");
    expect(loadMainDocument("p")).toBeNull();
    writeStoredValue(projectScopedKey(MAIN_DOCUMENT_STORAGE_PREFIX, "p"), "paper/main.tex");
    expect(loadMainDocument("p")).toBe("paper/main.tex");
  });
});

describe("boolean view toggles", () => {
  it("are opt-in on the exact string \"on\"", () => {
    expect(loadPdfInverted()).toBe(false);
    expect(loadSpellCheckPreference()).toBe(false);
    writeStoredValue(PDF_INVERT_STORAGE_KEY, "on");
    writeStoredValue(SPELL_CHECK_STORAGE_KEY, "on");
    expect(loadPdfInverted()).toBe(true);
    expect(loadSpellCheckPreference()).toBe(true);
    writeStoredValue(PDF_INVERT_STORAGE_KEY, "true");
    expect(loadPdfInverted()).toBe(false);
  });
});

describe("compile error handling", () => {
  it("continues only when explicitly stored, and is global-default stop", () => {
    expect(loadCompileErrorHandling("p")).toBe("stop");
    writeStoredValue(compileErrorHandlingStorageKey("p"), "continue");
    expect(loadCompileErrorHandling("p")).toBe("continue");
    writeStoredValue(compileErrorHandlingStorageKey("p"), "anything-else");
    expect(loadCompileErrorHandling("p")).toBe("stop");
  });
});

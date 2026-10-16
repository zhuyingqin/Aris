import { describe, expect, it } from "vitest";

import { basename, extension, languageForPath, resolveWorkspaceFilePath, workspaceFileOpenTarget } from "../workspaceFiles";

describe("workspaceFiles", () => {
  it.each([
    ["scripts\\train.py", "F:\\研究 项目\\", "F:/研究 项目/scripts/train.py"],
    ["main.m", "/home/research/work", "/home/research/work/main.m"],
    ["main.py", "/", "/main.py"],
    ["D:\\outside\\main.rs", "F:/work", "D:/outside/main.rs"],
    ["\\\\server\\share\\train.py", "F:/work", "//server/share/train.py"],
    ["main.py", null, "main.py"],
  ])("resolves %s against its originating project", (file, root, expected) => {
    expect(resolveWorkspaceFilePath(file, root)).toBe(expected);
  });

  it("maps common source paths to editor languages", () => {
    expect(languageForPath("src/main.py")).toBe("python");
    expect(languageForPath("web/App.TSX")).toBe("typescript");
    expect(languageForPath("paper/main.tex")).toBe("latex");
    expect(languageForPath("notes/README.md")).toBe("markdown");
    expect(languageForPath("Makefile")).toBe("text");
  });

  it("reads the last path segment regardless of separator", () => {
    expect(basename("C:\\Users\\wt\\project\\main.py")).toBe("main.py");
    expect(basename("src/nested/")).toBe("nested");
    expect(extension("archive/RESULT.CSV")).toBe(".csv");
    expect(extension("Makefile")).toBe("");
  });

  it("routes chat file opens to the appropriate workspace", () => {
    expect(workspaceFileOpenTarget("src/main.ts")).toBe("code");
    expect(workspaceFileOpenTarget("notebooks/train.ipynb")).toBe("code");
    expect(workspaceFileOpenTarget("Dockerfile")).toBe("code");
    expect(workspaceFileOpenTarget("paper/main.tex")).toBe("latex");
    expect(workspaceFileOpenTarget("paper/main.pdf")).toBe("pdf");
    expect(workspaceFileOpenTarget("paper/figures/result.png")).toBe("latex");
    expect(workspaceFileOpenTarget("paper/figures/diagram.svg")).toBe("latex");
    expect(workspaceFileOpenTarget("paper/data.csv")).toBe("external");
  });
});

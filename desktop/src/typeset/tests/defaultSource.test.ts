import { describe, expect, it } from "vitest";
import { defaultSourceFor } from "../TypesetExplorer";

describe("defaultSourceFor", () => {
  it("sets up ctex and XeLaTeX for a Chinese title", () => {
    for (const template of ["article", "report", "beamer", "poster"] as const) {
      const source = defaultSourceFor("paper.tex", template, "风电功率预测研究");
      expect(source.startsWith("% !TeX program = xelatex\n")).toBe(true);
      const lines = source.split("\n");
      const classLine = lines.findIndex((line) => line.startsWith("\\documentclass"));
      expect(lines[classLine + 1]).toBe("\\usepackage[UTF8]{ctex}");
      expect(source).toContain("风电功率预测研究");
    }
  });

  it("leaves an English document as it was", () => {
    const source = defaultSourceFor("paper.tex", "article", "Wind power forecasting");
    expect(source).not.toContain("ctex");
    expect(source).not.toContain("!TeX program");
  });
});

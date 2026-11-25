import { describe, expect, it } from "vitest";
import { isAuxiliaryFile } from "../TypesetExplorer";
import { diagnosticWorkspacePath, isBuildArtifactPath, isTypesetImagePath } from "../typesetPaths";

describe("isBuildArtifactPath", () => {
  it("matches the multi-part suffixes a LaTeX run writes", () => {
    expect(isBuildArtifactPath("paper.run.xml")).toBe(true);
    expect(isBuildArtifactPath("paper.synctex.gz")).toBe(true);
    expect(isBuildArtifactPath("figures/diagram-eps-converted-to.pdf")).toBe(true);
  });

  it("leaves authored sources and figures alone", () => {
    for (const path of ["main.tex", "refs.bib", "figures/diagram.pdf", "figures/plot.png"]) {
      expect(isBuildArtifactPath(path)).toBe(false);
    }
  });
});

describe("isAuxiliaryFile", () => {
  it("dims everything the ledger already excludes from revisions", () => {
    // The tree used to carry its own 14-entry list, so `.bcf`, `.idx` and
    // `.run.xml` were build output to the backend and ordinary files here.
    for (const path of ["paper.bcf", "paper.idx", "paper.run.xml", "paper.xdv", "paper.aux"]) {
      expect(isAuxiliaryFile(path)).toBe(true);
    }
    expect(isAuxiliaryFile("main.tex")).toBe(false);
  });
});

describe("isTypesetImagePath", () => {
  it("stays the set an <img> can decode", () => {
    expect(isTypesetImagePath("fig.png")).toBe(true);
    expect(isTypesetImagePath("fig.avif")).toBe(true);
    // Figure formats, but the preview panel routes .pdf to the PDF reader and
    // has nothing that can render .eps.
    expect(isTypesetImagePath("fig.pdf")).toBe(false);
    expect(isTypesetImagePath("fig.eps")).toBe(false);
  });
});

describe("diagnosticWorkspacePath", () => {
  it("resolves TeX's ./ paths against the compile root's folder", () => {
    expect(diagnosticWorkspacePath("./main.tex", ".somniq/papers/thesis/main.tex")).toBe(".somniq/papers/thesis/main.tex");
    expect(diagnosticWorkspacePath("./chapters/intro.tex", "thesis/main.tex")).toBe("thesis/chapters/intro.tex");
    expect(diagnosticWorkspacePath("./main.tex", "main.tex")).toBe("main.tex");
    expect(diagnosticWorkspacePath("chapters/intro.tex", "main.tex")).toBe("chapters/intro.tex");
    expect(diagnosticWorkspacePath("./../shared/macros.tex", "thesis/main.tex")).toBe("shared/macros.tex");
  });

  it("keeps absolute paths", () => {
    expect(diagnosticWorkspacePath("C:/texlive/texmf/tex/latex/foo.sty", "main.tex")).toBe("C:/texlive/texmf/tex/latex/foo.sty");
    expect(diagnosticWorkspacePath("/usr/share/texmf/foo.sty", "main.tex")).toBe("/usr/share/texmf/foo.sty");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { clearLatexStructureCache, latexEditsKeepStructure, scanLatexStructure, updateLatexStructure } from "../../editor/latex/latexStructure";
import { PendingLatexStructure } from "../../editor/latex/pendingStructure";
import { beamerSlidesForDocument, scanOutlineNodes } from "../outlineModel";

beforeEach(() => clearLatexStructureCache());

describe("scanLatexStructure", () => {
  it("does not treat comments or verbatim examples as document structure", () => {
    const source = [
      "% \\begin{document}",
      "\\begin{verbatim}",
      "\\section{Example only}",
      "\\end{document}",
      "\\end{verbatim}",
      "\\begin{document}",
      "\\section[Short]{Real heading}",
      "% \\end{document}",
      "Body.",
      "\\end{document}",
    ].join("\n");
    const structure = scanLatexStructure(source);

    expect(structure.headings.map((heading) => heading.title.value)).toEqual(["Real heading"]);
    expect(structure.headings[0]?.shortTitle?.value).toBe("Short");
    expect(structure.scanEnd).toBe(source.lastIndexOf("\\end{document}"));
    expect(structure.isRaw(source.indexOf("Example only"))).toBe(true);
  });

  it("pairs same-kind and mixed nested lists without flattening their ownership", () => {
    const source = [
      "\\begin{itemize}",
      "\\item Outer",
      "\\begin{enumerate}",
      "\\item Inner",
      "\\end{enumerate}",
      "\\item Outer two",
      "\\end{itemize}",
    ].join("\n");
    const structure = scanLatexStructure(source);
    const lists = new Set(["itemize", "enumerate"]);
    const innerItem = structure.commandsNamed("item")[1];

    expect(structure.environmentsNamed(lists)).toHaveLength(2);
    expect(structure.environmentAt(innerItem.from, lists)?.name).toBe("enumerate");
  });

  it("treats inline verbatim and its literal delimiters as raw text", () => {
    const source = [
      "\\verb|\\begin{fake}|",
      "\\verb*|\\end{fake}|",
      "\\verb%$ \\section{Example} \\begin{fake}% \\begin{equation}",
      "x = y",
      "\\end{equation}",
    ].join("\n");
    const structure = scanLatexStructure(source);

    expect(structure.environments.map((environment) => environment.name)).toEqual(["equation"]);
    expect(structure.headings).toEqual([]);
    expect(structure.isRaw(source.indexOf("\\begin{fake}"))).toBe(true);
    expect(structure.isRaw(source.indexOf("$"))).toBe(true);
    expect(structure.isMath(source.indexOf("x = y"))).toBe(true);
    expect(structure.comments).toEqual([]);
  });

  it("bounds an unfinished inline verbatim at the line end", () => {
    const source = "\\verb|\\begin{fake}\n\\begin{equation}\nx = y\n\\end{equation}";
    const structure = scanLatexStructure(source);
    expect(structure.environments.map((environment) => [environment.name, environment.closed]))
      .toEqual([["equation", true]]);
    expect(structure.isRaw(source.indexOf("\\begin{equation}"))).toBe(false);
  });

  it("rescans edits to arbitrary inline verbatim delimiters and line breaks", () => {
    const source = "\\verb|Example| \\begin{equation}\nx = y\n\\end{equation}";
    const previous = scanLatexStructure(source);
    const doc = Text.of(source.split("\n"));
    for (const edit of [
      { from: source.indexOf("Example") + 3, insert: "|" },
      { from: source.indexOf("| "), to: source.indexOf("| ") + 1 },
      { from: source.indexOf("Example") + 3, insert: "\n" },
    ]) {
      const changes = ChangeSet.of(edit, source.length);
      expect(updateLatexStructure(previous, changes.apply(doc).toString(), changes)).toBeNull();
    }
  });

  it("canonicalizes an escaped star in math environment names", () => {
    const source = [
      "\\begin{document}",
      "\\begin{align\\*}",
      "x & = y",
      "\\end{align\\*}",
      "\\end{document}",
    ].join("\n");
    const structure = scanLatexStructure(source);

    expect(structure.environmentsNamed(new Set(["align*"]))).toHaveLength(1);
    expect(structure.environmentsNamed(new Set(["align*"]))[0]?.closed).toBe(true);
  });

  it("indexes every argument of a table-of-contents registration command", () => {
    const source = "\\chapter*{Resumen}\n\\addcontentsline{toc}{chapter}{Resumen}";
    const command = scanLatexStructure(source).commandsNamed("addcontentsline")[0];

    expect(command.requiredArguments.map((argument) => argument.value)).toEqual(["toc", "chapter", "Resumen"]);
    expect(source.slice(command.from, command.to)).toBe("\\addcontentsline{toc}{chapter}{Resumen}");
  });

  it("reuses one immutable index and its named query results for a source version", () => {
    const source = "\\begin{document}\n\\section{One}\n\\section{Two}\n\\end{document}";
    const first = scanLatexStructure(source);
    const second = scanLatexStructure(source);

    expect(second).toBe(first);
    expect(second.commandsNamed("section")).toBe(first.commandsNamed("section"));
    expect(second.lineNumberAt(source.indexOf("Two"))).toBe(3);
    expect(second.lineStartAt(source.indexOf("Two"))).toBe(source.indexOf("\\section{Two}"));
  });

  it("builds outline nodes from the shared structure without accepting nested macro examples", () => {
    const source = [
      "\\newcommand{\\sample}{\\section{Not an outline heading}}",
      "  \\section[Short]{Real \\textbf{heading}}",
      "\\input{chapter}",
    ].join("\n");

    expect(scanOutlineNodes(source)).toEqual([
      { kind: "heading", line: 2, level: 3, title: "Real heading", numbered: true },
      { kind: "include", line: 3, command: "input", target: "chapter" },
    ]);
  });

  it("incrementally maps prose and argument edits, but defers TeX syntax edits", () => {
    const source = "\\begin{document}\n\\section{One}\nBody text\n\\end{document}";
    const previous = scanLatexStructure(source);
    const titleAt = source.indexOf("One") + "One".length;
    const proseChanges = ChangeSet.of({ from: titleAt, insert: " updated" }, source.length);
    const sourceDocument = Text.of(source.split("\n"));
    const nextSource = proseChanges.apply(sourceDocument).toString();
    const mapped = updateLatexStructure(previous, nextSource, proseChanges);

    expect(mapped).not.toBeNull();
    expect(mapped?.headings[0].title.value).toBe("One updated");
    expect(scanLatexStructure(nextSource)).toBe(mapped);

    const structuralChanges = ChangeSet.of({ from: titleAt, insert: "\\" }, source.length);
    expect(updateLatexStructure(previous, structuralChanges.apply(sourceDocument).toString(), structuralChanges)).toBeNull();
  });
});

describe("beamerSlidesForDocument", () => {
  it("expands included frame files in root-document order", () => {
    const sources = {
      "main.tex": "\\begin{document}\n\\input{slides/one}\n\\input{slides/two}\n\\end{document}",
      "slides/one.tex": "\\begin{frame}{One}\nFirst\\end{frame}",
      "slides/two.tex": "\\begin{frame}{Two}\nSecond\\end{frame}",
    };
    const slides = beamerSlidesForDocument(sources["main.tex"], "main.tex", sources);

    expect(slides.map((slide) => [slide.file, slide.title])).toEqual([
      ["slides/one.tex", "One"],
      ["slides/two.tex", "Two"],
    ]);
  });
});

describe("PendingLatexStructure and the prose check", () => {
  const source = String.raw`\begin{document}
\section{Intro}\label{sec:a}
Some prose here, \textbf{bold} too.
\end{document}`;

  it("composes prose edits and maps them once, to the same index a scan gives", () => {
    let doc = Text.of(source.split("\n"));
    let pending = PendingLatexStructure.resolved(scanLatexStructure(source), doc);
    for (const word of [" more", " words"]) {
      const at = doc.toString().indexOf("prose") + 5;
      const changes = ChangeSet.of({ from: at, insert: word }, doc.length);
      doc = changes.apply(doc);
      pending = pending.next(changes, doc);
      expect(pending.isResolved).toBe(false);
    }
    const mapped = pending.get();
    clearLatexStructureCache();
    const scanned = scanLatexStructure(doc.toString());
    expect(mapped.source).toBe(scanned.source);
    expect(mapped.commands.map((command) => [command.name, command.from, command.to]))
      .toEqual(scanned.commands.map((command) => [command.name, command.from, command.to]));
  });

  it("finds an edit to a control word, even behind queued prose edits", () => {
    const structure = scanLatexStructure(source);
    const bold = source.indexOf(String.raw`\textbf`) + 3;
    expect(latexEditsKeepStructure(structure, [{ fromA: bold, toA: bold, removed: "", inserted: "x" }])).toBe(false);
    const prose = source.indexOf("prose") + 2;
    expect(latexEditsKeepStructure(structure, [{ fromA: prose, toA: prose, removed: "", inserted: "x" }])).toBe(true);

    // Ten characters were typed before the command since the index was made:
    // a position in today's text maps back ten characters.
    const shifted = (position: number) => position - 10;
    expect(latexEditsKeepStructure(structure, [{ fromA: bold + 10, toA: bold + 10, removed: "", inserted: "x" }], shifted)).toBe(false);
    expect(latexEditsKeepStructure(structure, [{ fromA: bold + 10, toA: bold + 10, removed: "", inserted: "x" }])).toBe(true);
  });
});

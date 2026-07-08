import { describe, expect, it } from "vitest";
import { latexListEnterInsertion } from "./TypesetVisualEditor";

describe("latexListEnterInsertion", () => {
  it("continues an itemize list with the existing indentation", () => {
    const source = [
      "\\begin{itemize}",
      "  \\item First point",
      "\\end{itemize}",
    ].join("\n");
    const cursor = source.indexOf(" point") + " point".length;

    expect(latexListEnterInsertion(source, cursor)).toEqual({
      insert: "\n  \\item ",
      selection: cursor + "\n  \\item ".length,
    });
  });

  it("continues an enumerate list with another source item", () => {
    const source = [
      "\\begin{enumerate}",
      "\\item First point",
      "\\end{enumerate}",
    ].join("\n");
    const cursor = source.indexOf("point") + "point".length;

    expect(latexListEnterInsertion(source, cursor)?.insert).toBe("\n\\item ");
  });

  it("continues a list when the cursor is on a wrapped continuation line of an item", () => {
    const source = [
      "\\begin{itemize}",
      "  \\item First point starts here",
      "    and continues on the next source line",
      "\\end{itemize}",
    ].join("\n");
    const cursor = source.indexOf("source line") + "source line".length;

    expect(latexListEnterInsertion(source, cursor)).toEqual({
      insert: "\n  \\item ",
      selection: cursor + "\n  \\item ".length,
    });
  });

  it("does not hijack Enter outside list items", () => {
    expect(latexListEnterInsertion("Plain text", "Plain".length)).toBeNull();
    expect(latexListEnterInsertion("\\begin{itemize}\ntext\n\\end{itemize}", 23)).toBeNull();
  });
});

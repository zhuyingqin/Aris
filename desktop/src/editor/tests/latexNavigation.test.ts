import { describe, expect, it } from "vitest";
import {
  bibEntryOffset,
  invalidLabelName,
  labelSites,
  latexNavigationTargetAt,
  renameLabelInSource,
} from "../latexNavigation";

const at = (line: string, marker: string, lineFrom = 0) =>
  latexNavigationTargetAt(line, lineFrom, lineFrom + line.indexOf(marker) + 1);

describe("latexNavigationTargetAt", () => {
  it("names the label under the cursor in a reference list", () => {
    const line = String.raw`see \cref{fig:a, fig:b} and \eqref{eq:1}`;
    expect(at(line, "fig:b")).toEqual({ kind: "label-reference", name: "fig:b", from: line.indexOf("fig:b"), to: line.indexOf("fig:b") + 5 });
    expect(at(line, "eq:1", 100)).toMatchObject({ kind: "label-reference", name: "eq:1", from: 100 + line.indexOf("eq:1") });
  });

  it("recognises definitions, citations, files and hyperref targets", () => {
    expect(at(String.raw`\section{Intro}\label{sec:intro}`, "sec:intro")).toMatchObject({ kind: "label-definition", name: "sec:intro" });
    expect(at(String.raw`\begin{lstlisting}[language=C, label=lst:main]`, "lst:main")).toMatchObject({ kind: "label-definition", name: "lst:main" });
    expect(at(String.raw`\citep[p.~3]{lecun2015, vaswani2017}`, "vaswani")).toMatchObject({ kind: "citation", key: "vaswani2017" });
    expect(at(String.raw`\input{chapters/intro}`, "chapters")).toMatchObject({ kind: "file", command: "input", target: "chapters/intro" });
    expect(at(String.raw`\includegraphics[width=\linewidth]{figs/plot.pdf}`, "figs")).toMatchObject({ kind: "file", command: "includegraphics", target: "figs/plot.pdf" });
    expect(at(String.raw`\subimport{parts/}{one}`, "one")).toMatchObject({ kind: "file", target: "parts/one" });
    expect(at(String.raw`\hyperref[sec:intro]{the introduction}`, "sec:intro")).toMatchObject({ kind: "label-reference", name: "sec:intro" });
  });

  it("takes a click anywhere on the command when loose (a Visual-mode chip)", () => {
    const line = String.raw`see \ref{fig:a} here`;
    const onCommand = line.indexOf(String.raw`\ref`) + 1;
    expect(latexNavigationTargetAt(line, 0, onCommand)).toBeNull();
    expect(latexNavigationTargetAt(line, 0, onCommand, { loose: true })).toMatchObject({ kind: "label-reference", name: "fig:a" });
  });

  it("ignores commented-out commands and plain text", () => {
    expect(at(String.raw`% \ref{gone}`, "gone")).toBeNull();
    expect(at(String.raw`100\% sure \ref{kept}`, "kept")).toMatchObject({ name: "kept" });
    expect(at("plain words here", "words")).toBeNull();
  });
});

describe("label rename", () => {
  const source = [
    String.raw`\section{Method}\label{sec:method}`,
    String.raw`As \cref{sec:intro,sec:method} show, see \ref{ sec:method }.`,
    String.raw`% \ref{sec:method} stays commented`,
    String.raw`\hyperref[sec:method]{here} and \ref{sec:methods}`,
  ].join("\n");

  it("finds every definition and use, and only of that name", () => {
    const sites = labelSites(source, "sec:method");
    expect(sites.map((site) => site.kind)).toEqual(["definition", "reference", "reference", "reference"]);
    for (const site of sites) expect(source.slice(site.from, site.to)).toBe("sec:method");
  });

  it("rewrites them all and leaves similar names and comments alone", () => {
    const { text, count } = renameLabelInSource(source, "sec:method", "sec:approach");
    expect(count).toBe(4);
    expect(text).toContain(String.raw`\label{sec:approach}`);
    expect(text).toContain(String.raw`\cref{sec:intro,sec:approach}`);
    expect(text).toContain(String.raw`\ref{ sec:approach }`);
    expect(text).toContain(String.raw`\hyperref[sec:approach]`);
    expect(text).toContain(String.raw`% \ref{sec:method} stays commented`);
    expect(text).toContain(String.raw`\ref{sec:methods}`);
  });

  it("refuses names TeX would read differently", () => {
    expect(invalidLabelName("  ")).toBe("empty");
    expect(invalidLabelName("a b")).toBe("characters");
    expect(invalidLabelName("a,b")).toBe("characters");
    expect(invalidLabelName("fig:结果-1")).toBeNull();
  });
});

describe("bibEntryOffset", () => {
  it("finds the entry key, not a mention of it", () => {
    const bib = "% lecun2015 is cited a lot\n@article{ lecun2015 ,\n  title={Deep}\n}\n";
    expect(bib.slice(bibEntryOffset(bib, "lecun2015")).startsWith("lecun2015")).toBe(true);
    expect(bibEntryOffset(bib, "lecun2015")).toBeGreaterThan(bib.indexOf("@article"));
    expect(bibEntryOffset(bib, "missing")).toBe(-1);
  });
});

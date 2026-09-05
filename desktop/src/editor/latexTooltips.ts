/**
 * Hover tooltips for Code mode: a rendered preview of the formula under the
 * pointer, and the target of a cross-reference or link.
 *
 * Visual mode already renders maths and resolves references inline, so these
 * exist to give the source view the same answers without leaving it — the two
 * things Overleaf's `math-preview-tooltip` and `command-tooltip` extensions do.
 */
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import katex from "katex";
import { scanLatexStructure, type LatexStructureIndex } from "../typeset/latexStructure";

/** Environments whose whole body is maths. */
const MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*",
  "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
  "eqnarray", "eqnarray*", "displaymath", "split",
]);

const REFERENCE_COMMANDS = new Set(["ref", "eqref", "autoref", "cref", "Cref", "pageref"]);
const LINK_COMMANDS = new Set(["href", "url"]);

export type MathSpan = { from: number; to: number; source: string; display: boolean };

/**
 * The formula covering `position`, with its delimiters stripped so KaTeX gets
 * only the body. `\[…\]` and a `\begin{align}` are display maths; `$…$` is not.
 */
export function mathSpanAt(structure: LatexStructureIndex, position: number): MathSpan | null {
  const text = structure.source;
  for (const range of structure.mathRanges) {
    if (position < range.from || position > range.to) continue;
    const raw = text.slice(range.from, range.to);
    if (raw.startsWith("$$")) return { ...range, source: raw.slice(2, -2), display: true };
    if (raw.startsWith("\\[")) return { ...range, source: raw.slice(2, -2), display: true };
    if (raw.startsWith("\\(")) return { ...range, source: raw.slice(2, -2), display: false };
    if (raw.startsWith("$")) return { ...range, source: raw.slice(1, -1), display: false };
    return { ...range, source: raw, display: false };
  }
  for (const environment of structure.environments) {
    if (!environment.closed || !MATH_ENVIRONMENTS.has(environment.name)) continue;
    if (position < environment.from || position > environment.to) continue;
    return {
      from: environment.from,
      to: environment.to,
      source: text.slice(environment.bodyFrom, environment.bodyTo),
      display: true,
    };
  }
  return null;
}

/** The `\ref{…}`/`\href{…}{…}` covering `position`, if any. */
export function referenceAt(
  structure: LatexStructureIndex,
  position: number,
): { kind: "reference" | "link"; from: number; to: number; target: string } | null {
  for (const command of structure.commands) {
    if (position < command.from || position > command.to) continue;
    if (REFERENCE_COMMANDS.has(command.name)) {
      const target = command.requiredArguments[0]?.value.trim();
      if (target) return { kind: "reference", from: command.from, to: command.to, target };
    }
    if (LINK_COMMANDS.has(command.name)) {
      const target = command.requiredArguments[0]?.value.trim();
      if (target) return { kind: "link", from: command.from, to: command.to, target };
    }
  }
  return null;
}

/**
 * Where a label is defined and what heading it sits under, so `\ref{sec:esn}`
 * can say "3.2 Echo State Networks" instead of only echoing the key back.
 * Same-file only: the whole document graph lives in the Typeset workbench, not
 * in the editor kernel.
 */
export function labelTarget(structure: LatexStructureIndex, key: string): { line: number; heading: string } | null {
  const definition = structure.commands.find((command) =>
    command.name === "label" && command.requiredArguments[0]?.value.trim() === key);
  if (!definition) return null;
  const heading = [...structure.headings]
    .filter((candidate) => candidate.from <= definition.from)
    .at(-1);
  return { line: structure.lineNumberAt(definition.from), heading: heading?.title.value.trim() ?? "" };
}

function element(className: string, text?: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * KaTeX preview of the formula under the pointer. Rendering failures are shown
 * as the error text rather than swallowed: a formula that will not render here
 * is usually one that will not compile either.
 */
export const latexMathPreview = hoverTooltip((view, position): Tooltip | null => {
  const structure = scanLatexStructure(view.state.doc.toString());
  const span = mathSpanAt(structure, position);
  if (!span || !span.source.trim()) return null;
  return {
    pos: span.from,
    end: span.to,
    above: true,
    create: () => {
      const dom = element("cm-latex-tooltip cm-latex-math-preview");
      try {
        katex.render(span.source, dom, { throwOnError: true, displayMode: span.display, output: "html" });
      } catch (error) {
        dom.classList.add("cm-latex-tooltip-error");
        dom.textContent = error instanceof Error ? error.message : String(error);
      }
      return { dom };
    },
  };
}, { hideOnChange: true });

/** What a `\ref` points at, and where a `\href` goes. */
export function latexReferenceTooltip(copy: {
  undefinedLabel: string;
  definedOnLine: (line: number) => string;
}) {
  return hoverTooltip((view, position): Tooltip | null => {
    const state: EditorState = view.state;
    const structure = scanLatexStructure(state.doc.toString());
    const reference = referenceAt(structure, position);
    if (!reference) return null;
    return {
      pos: reference.from,
      end: reference.to,
      above: true,
      create: () => {
        const dom = element("cm-latex-tooltip cm-latex-reference-tooltip");
        if (reference.kind === "link") {
          dom.append(element("cm-latex-tooltip-target", reference.target));
          return { dom };
        }
        const target = labelTarget(structure, reference.target);
        if (!target) {
          dom.classList.add("cm-latex-tooltip-error");
          dom.textContent = copy.undefinedLabel;
          return { dom };
        }
        if (target.heading) dom.append(element("cm-latex-tooltip-target", target.heading));
        dom.append(element("cm-latex-tooltip-meta", copy.definedOnLine(target.line)));
        return { dom };
      },
    };
  }, { hideOnChange: true });
}

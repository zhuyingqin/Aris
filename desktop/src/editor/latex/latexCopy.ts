import type { Language } from "../../store";

/**
 * Text of the LaTeX language features every editor shows (the Code page's
 * editor and Typeset alike), so the editor does not depend on Typeset's copy.
 */
export const LATEX_REFERENCE_TOOLTIP_COPY: Record<Language, {
  undefinedLabel: string;
  definedOnLine: (line: number) => string;
}> = {
  en: {
    undefinedLabel: "No \label with this key in this file.",
    definedOnLine: (line: number): string => `Defined on line ${line}`,
  },
  cn: {
    undefinedLabel: "本文件中没有这个 \label。",
    definedOnLine: (line: number): string => `定义在第 ${line} 行`,
  },
};

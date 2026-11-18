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
    undefinedLabel: "No \\label with this key in this file.",
    definedOnLine: (line: number): string => `Defined on line ${line}`,
  },
  es: {
    undefinedLabel: "No hay ningún \\label con esta clave en este archivo.",
    definedOnLine: (line: number): string => `Definido en la línea ${line}`,
  },
  cn: {
    undefinedLabel: "本文件中没有这个 \\label。",
    definedOnLine: (line: number): string => `定义在第 ${line} 行`,
  },
};

/** The right-hand category hint of LaTeX command completions. */
export const LATEX_COMPLETION_CATEGORY_COPY: Record<Language, Record<string, string>> = {
  en: {},
  es: {
    class: "clase",
    preamble: "preámbulo",
    "front matter": "portada",
    sectioning: "secciones",
    include: "inclusión",
    "cross-reference": "referencia cruzada",
    note: "nota",
    citation: "cita",
    definition: "definición",
    environment: "entorno",
    list: "lista",
    float: "flotante",
    table: "tabla",
    "table (booktabs)": "tabla (booktabs)",
    layout: "maquetación",
    text: "texto",
    math: "matemáticas",
    greek: "griego",
  },
  cn: {
    class: "文档类",
    preamble: "导言区",
    "front matter": "前置信息",
    sectioning: "章节",
    include: "包含文件",
    "cross-reference": "交叉引用",
    note: "注释",
    citation: "引用",
    definition: "定义",
    environment: "环境",
    list: "列表",
    float: "浮动体",
    table: "表格",
    "table (booktabs)": "表格（booktabs）",
    layout: "版式",
    text: "文本",
    math: "数学",
    greek: "希腊字母",
  },
};

/** Messages of the compile-free LaTeX checks (duplicate labels, dangling references, …). */
export const LATEX_LINT_COPY: Record<Language, {
  duplicateLabel: (name: string) => string;
  undefinedReference: (name: string) => string;
  unknownCitation: (name: string) => string;
  unclosedEnvironment: (name: string) => string;
}> = {
  en: {
    duplicateLabel: (name) => `Label "${name}" is already defined in this file — LaTeX keeps the last one and every \\ref to it becomes ambiguous.`,
    undefinedReference: (name) => `No \\label{${name}} anywhere in this document — the reference will typeset as "??".`,
    unknownCitation: (name) => `Citation key "${name}" is not in the project bibliography.`,
    unclosedEnvironment: (name) => `Environment "${name}" has no matching \\end{${name}}.`,
  },
  es: {
    duplicateLabel: (name) => `La etiqueta "${name}" ya está definida en este archivo: LaTeX conserva la última y cada \\ref a ella se vuelve ambigua.`,
    undefinedReference: (name) => `No hay ningún \\label{${name}} en este documento: la referencia cruzada aparecerá como "??" al compilar.`,
    unknownCitation: (name) => `La clave de cita "${name}" no está en la bibliografía del proyecto.`,
    unclosedEnvironment: (name) => `El entorno "${name}" no tiene su \\end{${name}} correspondiente.`,
  },
  cn: {
    duplicateLabel: (name) => `标签“${name}”已在本文件中定义过——LaTeX 只保留最后一个，指向它的每个 \\ref 都会有歧义。`,
    undefinedReference: (name) => `本文档中没有 \\label{${name}}——编译后这个引用会显示为“??”。`,
    unknownCitation: (name) => `引用键“${name}”不在项目参考文献中。`,
    unclosedEnvironment: (name) => `环境“${name}”缺少对应的 \\end{${name}}。`,
  },
};

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import matlab from "highlight.js/lib/languages/matlab";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const REVIEW_LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  ini,
  javascript,
  json,
  latex,
  markdown,
  matlab,
  powershell,
  python,
  r,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(REVIEW_LANGUAGES)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
}

const EXTENSION_LANGUAGES: Record<string, keyof typeof REVIEW_LANGUAGES> = {
  bash: "bash",
  bib: "latex",
  c: "c",
  cc: "cpp",
  cls: "latex",
  cpp: "cpp",
  css: "css",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  m: "matlab",
  md: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  py: "python",
  r: "r",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  sty: "latex",
  tex: "latex",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function reviewLanguageForPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const fileName = normalized.split("/").pop() ?? normalized;
  if (fileName === "dockerfile" || fileName === "makefile") return "bash";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return EXTENSION_LANGUAGES[extension] ?? null;
}

export function highlightReviewLine(path: string, text: string, enabled = true): string {
  if (!text) return " ";
  const language = reviewLanguageForPath(path);
  if (!enabled || !language || text.length > 4_000) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

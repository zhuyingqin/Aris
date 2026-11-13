import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { EditorLanguage, EditorSurface } from "./editorTypes";

type LanguageLoader = (surface: EditorSurface) => Promise<Extension>;

const languageCache = new Map<string, Promise<Extension[]>>();

// The ported CodeMirror-5 `stex` mode only recognizes ASCII letters/digits/a
// fixed punctuation set inside math mode ($...$, \[...\]); anything else -
// every CJK character in a `\text{中文}` equation annotation, a stray full-width
// 。／， - is tokenized as "error" (rendered as invalid/red). That mode's *only
// other* source of an "error" token is a genuinely unmatched `}`/`]`, so forward
// just that case and treat the math-mode fallback as plain unstyled text.
function tameStexMathFalsePositives(mode: StreamParser<unknown>): StreamParser<unknown> {
  return {
    ...mode,
    token(stream, state) {
      const style = mode.token(stream, state);
      if (style === "error" && stream.current() !== "}" && stream.current() !== "]") return null;
      return style;
    },
  };
}

// Official @codemirror/lang-* packages where they exist; CodeMirror 5's ported
// "legacy modes" (StreamLanguage) for everything else. Each loader is a dynamic
// import so Vite code-splits per language and nothing is paid for up front.
const LOADERS: Partial<Record<EditorLanguage, LanguageLoader>> = {
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  xml: async () => (await import("@codemirror/lang-html")).html(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  matlab: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/octave")).octave),
  latex: async (surface) => [
    StreamLanguage.define(tameStexMathFalsePositives((await import("@codemirror/legacy-modes/mode/stex")).stex)),
    // Visual mode already replaces environment delimiters with rendered
    // widgets. Keep native code folds on the source surface only.
    surface === "code" ? (await import("./latexFolding")).latexEnvironmentFolding : [],
  ],
  bash: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  powershell: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  ini: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties),
};

/** Anything with no loader (currently just `text`) opens as plain text — never blocks editing. */
export async function loadLanguageExtension(
  language: EditorLanguage,
  surface: EditorSurface = "code",
): Promise<Extension[]> {
  const cacheKey = language === "latex" ? `${language}:${surface}` : language;
  const cached = languageCache.get(cacheKey);
  if (cached) return cached;
  const loader = LOADERS[language];
  if (!loader) return [];
  const pending = loader(surface)
    .then((extension) => [extension])
    .catch(() => [] as Extension[]);
  languageCache.set(cacheKey, pending);
  return pending;
}

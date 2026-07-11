import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { EditorLanguage } from "./editorTypes";

type LanguageLoader = () => Promise<Extension>;

const languageCache = new Map<EditorLanguage, Promise<Extension[]>>();

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
  latex: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/stex")).stex),
  bash: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  powershell: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  ini: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties),
};

/** Anything with no loader (currently just `text`) opens as plain text — never blocks editing. */
export async function loadLanguageExtension(language: EditorLanguage): Promise<Extension[]> {
  const cached = languageCache.get(language);
  if (cached) return cached;
  const loader = LOADERS[language];
  if (!loader) return [];
  const pending = loader()
    .then((extension) => [extension])
    .catch(() => [] as Extension[]);
  languageCache.set(language, pending);
  return pending;
}

/**
 * User-level editor settings, shared by every CodeMirror surface in the app.
 *
 * Overleaf keeps the equivalent knobs in its left menu (`editor-left-menu`);
 * ours were missing entirely, so the editor was whatever we hard-coded. Each
 * setting lives in a `Compartment` so changing it reconfigures the live view
 * instead of tearing the editor down and losing the caret and undo history.
 *
 * The store is deliberately module-level rather than part of the app's zustand
 * store: these values are read from inside CodeMirror extensions, which are not
 * React, and every surface has to see the same value at the same time.
 */

import { Compartment, Facet, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { vim } from "@replit/codemirror-vim";
import { emacs } from "@replit/codemirror-emacs";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { latexLint } from "./latexLint";
import type { EditorLanguage, EditorSurface } from "./editorTypes";

export type EditorKeybindings = "default" | "vim" | "emacs";
export type EditorFontFamily = "mono" | "sans" | "serif";
export type EditorLineHeight = "compact" | "normal" | "wide";

export type EditorSettings = {
  fontFamily: EditorFontFamily;
  /** Source-mode font size in px; the Visual surface scales its page from this. */
  fontSize: number;
  lineHeight: EditorLineHeight;
  keybindings: EditorKeybindings;
  autoComplete: boolean;
  autoCloseBrackets: boolean;
  /** The LaTeX reference/structure linter (`latexLint`). */
  codeCheck: boolean;
  indentMarkers: boolean;
  /**
   * BCP-47 tag handed to the browser's spell checker through the content
   * element's `lang`. Unlike Overleaf we have no server-side dictionary, so the
   * document language is what decides which words are flagged — without it a
   * Chinese-English thesis is underlined end to end.
   */
  spellCheckLanguage: string;
};

export const EDITOR_FONT_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16, 18, 20, 22];
export const EDITOR_KEYBINDINGS: readonly EditorKeybindings[] = ["default", "vim", "emacs"];
export const EDITOR_FONT_FAMILIES: readonly EditorFontFamily[] = ["mono", "sans", "serif"];
export const EDITOR_LINE_HEIGHTS: readonly EditorLineHeight[] = ["compact", "normal", "wide"];
/** Kept short on purpose: these are the languages this editor is actually used
 * in. "off" is a value, not an absence, so the setting round-trips. */
export const EDITOR_SPELL_LANGUAGES: readonly string[] = ["off", "en-US", "en-GB", "zh-CN", "de-DE", "es-ES", "fr-FR", "ja-JP"];

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "mono",
  fontSize: 13,
  lineHeight: "normal",
  keybindings: "default",
  autoComplete: true,
  autoCloseBrackets: true,
  codeCheck: true,
  indentMarkers: true,
  spellCheckLanguage: "en-US",
};

const STORAGE_KEY = "somniq-editor-settings-v1";

const LINE_HEIGHT_RATIO: Record<EditorLineHeight, number> = {
  compact: 1.33,
  normal: 1.6,
  wide: 1.9,
};

const FONT_STACK: Record<EditorFontFamily, string> = {
  mono: "var(--font-mono)",
  sans: 'var(--font-sans), "Segoe UI", system-ui, sans-serif',
  serif: '"Latin Modern Roman", "CMU Serif", Georgia, "Times New Roman", serif',
};

function coerce(raw: unknown): EditorSettings {
  const value = (raw ?? {}) as Partial<EditorSettings>;
  const pick = <T,>(candidate: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly unknown[]).includes(candidate) ? candidate as T : fallback;
  return {
    fontFamily: pick(value.fontFamily, EDITOR_FONT_FAMILIES, DEFAULT_EDITOR_SETTINGS.fontFamily),
    fontSize: pick(value.fontSize, EDITOR_FONT_SIZES, DEFAULT_EDITOR_SETTINGS.fontSize),
    lineHeight: pick(value.lineHeight, EDITOR_LINE_HEIGHTS, DEFAULT_EDITOR_SETTINGS.lineHeight),
    keybindings: pick(value.keybindings, EDITOR_KEYBINDINGS, DEFAULT_EDITOR_SETTINGS.keybindings),
    autoComplete: typeof value.autoComplete === "boolean" ? value.autoComplete : DEFAULT_EDITOR_SETTINGS.autoComplete,
    autoCloseBrackets: typeof value.autoCloseBrackets === "boolean" ? value.autoCloseBrackets : DEFAULT_EDITOR_SETTINGS.autoCloseBrackets,
    codeCheck: typeof value.codeCheck === "boolean" ? value.codeCheck : DEFAULT_EDITOR_SETTINGS.codeCheck,
    indentMarkers: typeof value.indentMarkers === "boolean" ? value.indentMarkers : DEFAULT_EDITOR_SETTINGS.indentMarkers,
    spellCheckLanguage: pick(value.spellCheckLanguage, EDITOR_SPELL_LANGUAGES, DEFAULT_EDITOR_SETTINGS.spellCheckLanguage),
  };
}

function readStored(): EditorSettings {
  if (typeof window === "undefined") return DEFAULT_EDITOR_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return coerce(raw ? JSON.parse(raw) : null);
  } catch {
    // Blocked or corrupt storage costs the preference, never the editor.
    return DEFAULT_EDITOR_SETTINGS;
  }
}

let current: EditorSettings = readStored();
const listeners = new Set<() => void>();

export function getEditorSettings(): EditorSettings {
  return current;
}

export function setEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  const next = coerce({ ...current, ...patch });
  // `useSyncExternalStore` compares snapshots by identity, so an unchanged
  // write must not produce a new object or every editor reconfigures on focus.
  if (EDITOR_SETTING_KEYS.every((key) => next[key] === current[key])) return current;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The choice still applies for this session.
  }
  for (const listener of listeners) listener();
  return next;
}

export const EDITOR_SETTING_KEYS = Object.keys(DEFAULT_EDITOR_SETTINGS) as (keyof EditorSettings)[];

export function subscribeEditorSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal Test seam: drops persisted state so a suite starts from defaults. */
export function resetEditorSettings(): void {
  current = DEFAULT_EDITOR_SETTINGS;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
  for (const listener of listeners) listener();
}

/** Lets an extension ask which keymap is active — the Visual surface uses it to
 * stand down its own Enter handling while a modal keymap owns the keyboard. */
export const editorKeybindingsFacet = Facet.define<EditorKeybindings, EditorKeybindings>({
  combine: (values) => values[values.length - 1] ?? "default",
});

export const editorSettingsCompartment = new Compartment();

/** The Visual surface's typographic base, kept in one place because its gutter
 * alignment depends on prose and line numbers sharing one absolute line box. */
export const VISUAL_BASE_FONT_SIZE = 17.5;
export const VISUAL_BASE_LINE_HEIGHT = 23.275;

/** Visual mode is a rendered page, not a source listing: it scales with the
 * font-size setting but keeps its own serif face and its line-box ratio, so the
 * gutter stays glued to the prose (see `visualThemeSpec`). */
export function visualTypographyFor(settings: EditorSettings): { fontSize: number; lineHeight: number } {
  const scale = settings.fontSize / DEFAULT_EDITOR_SETTINGS.fontSize;
  return {
    fontSize: Math.round(VISUAL_BASE_FONT_SIZE * scale * 100) / 100,
    lineHeight: Math.round(VISUAL_BASE_LINE_HEIGHT * scale * 1000) / 1000,
  };
}

/**
 * The settings-driven half of a surface's extensions. Held in one compartment
 * so a settings change is a single `reconfigure` rather than a rebuild.
 *
 * `vim()`/`emacs()` must precede the surface's other keymaps to win normal-mode
 * keys, which is why this compartment is placed above `sharedKeymap()` in
 * `baseExtensions`.
 */
export function editorSettingsExtensions(
  settings: EditorSettings,
  options: { surface: EditorSurface; language: EditorLanguage },
): Extension[] {
  const extensions: Extension[] = [editorKeybindingsFacet.of(settings.keybindings)];
  if (settings.keybindings === "vim") extensions.push(vim());
  else if (settings.keybindings === "emacs") extensions.push(emacs());
  if (settings.autoComplete) extensions.push(autocompletion());
  // `closeBracketsKeymap` stays in `sharedKeymap()`: its Backspace handler is a
  // no-op without the extension, so it costs nothing when this is off.
  if (settings.autoCloseBrackets) extensions.push(closeBrackets());
  if (options.language === "latex" && settings.codeCheck) {
    // The WYSIWYG surface renders a page, not a gutter column.
    extensions.push(latexLint({ gutter: options.surface !== "typeset" }));
  }
  // Indent guides are a source-listing affordance; on the rendered page they
  // would draw vertical rules through prose.
  if (settings.indentMarkers && options.surface !== "typeset") extensions.push(indentationMarkers());
  // The Visual surface owns its own theme end to end (`visualThemeFor` folds
  // these same values into `visualThemeSpec`). Emitting a second theme here
  // would leave two equal-specificity rules whose winner depends on stylesheet
  // insertion order — which changes on every reconfigure.
  if (options.surface !== "typeset") extensions.push(sourceTypographyTheme(settings));
  return extensions;
}

/**
 * `EditorView.theme` mints a `StyleModule` that is injected into the document
 * and never removed, so calling it per editor (or per reconfigure) leaks a
 * stylesheet every time. Identical settings must therefore share one theme.
 */
const sourceThemeCache = new Map<string, Extension>();

export function sourceTypographyTheme(settings: EditorSettings): Extension {
  const key = `${settings.fontFamily}|${settings.fontSize}|${settings.lineHeight}`;
  const cached = sourceThemeCache.get(key);
  if (cached) return cached;
  const theme = EditorView.theme({
    "&": { fontSize: `${settings.fontSize}px` },
    ".cm-scroller": {
      fontFamily: FONT_STACK[settings.fontFamily],
      lineHeight: String(LINE_HEIGHT_RATIO[settings.lineHeight]),
    },
  });
  sourceThemeCache.set(key, theme);
  return theme;
}

/** `settings.spellCheckLanguage` as an attribute value, or null when off. */
export function spellCheckLanguageAttribute(settings: EditorSettings): string | null {
  return settings.spellCheckLanguage === "off" ? null : settings.spellCheckLanguage;
}

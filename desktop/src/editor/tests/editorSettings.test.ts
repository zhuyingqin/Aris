// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_SETTINGS,
  editorKeybindingsFacet,
  editorSettingsExtensions,
  getEditorSettings,
  resetEditorSettings,
  setEditorSettings,
  sourceTypographyTheme,
  spellCheckLanguageAttribute,
  subscribeEditorSettings,
  visualTypographyFor,
} from "../editorSettings";
import { createSharedEditorView } from "../editorView";

beforeEach(() => resetEditorSettings());
afterEach(() => resetEditorSettings());

describe("editor settings store", () => {
  it("persists a change and rejects values outside the offered set", () => {
    setEditorSettings({ fontSize: 20, keybindings: "vim" });
    expect(getEditorSettings().fontSize).toBe(20);
    expect(getEditorSettings().keybindings).toBe("vim");

    // A stray value must not brick the editor: it falls back to the default.
    setEditorSettings({ fontSize: 999 as number, keybindings: "kakoune" as never });
    expect(getEditorSettings().fontSize).toBe(DEFAULT_EDITOR_SETTINGS.fontSize);
    expect(getEditorSettings().keybindings).toBe(DEFAULT_EDITOR_SETTINGS.keybindings);

    expect(JSON.parse(window.localStorage.getItem("somniq-editor-settings-v1") ?? "{}").fontSize)
      .toBe(DEFAULT_EDITOR_SETTINGS.fontSize);
  });

  it("does not notify or churn the snapshot when nothing actually changed", () => {
    let notified = 0;
    const unsubscribe = subscribeEditorSettings(() => { notified += 1; });
    const before = getEditorSettings();

    setEditorSettings({ fontSize: DEFAULT_EDITOR_SETTINGS.fontSize });
    // `useSyncExternalStore` compares snapshots by identity — a fresh object
    // here would re-render (and reconfigure) every editor on every keystroke.
    expect(getEditorSettings()).toBe(before);
    expect(notified).toBe(0);

    setEditorSettings({ fontSize: 16 });
    expect(notified).toBe(1);
    unsubscribe();
    setEditorSettings({ fontSize: 18 });
    expect(notified).toBe(1);
  });
});

describe("editorSettingsExtensions", () => {
  const options = { surface: "code", language: "latex" } as const;

  it("publishes the active keymap so other extensions can stand down", () => {
    const state = EditorState.create({
      extensions: editorSettingsExtensions({ ...DEFAULT_EDITOR_SETTINGS, keybindings: "vim" }, options),
    });
    expect(state.facet(editorKeybindingsFacet)).toBe("vim");
  });

  it("reuses one theme per distinct typography, because themes are never unloaded", () => {
    // `EditorView.theme` injects a stylesheet that StyleModule keeps forever, so
    // a fresh theme per editor leaks one every time a file is opened.
    const a = sourceTypographyTheme(DEFAULT_EDITOR_SETTINGS);
    const b = sourceTypographyTheme({ ...DEFAULT_EDITOR_SETTINGS });
    const c = sourceTypographyTheme({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 20 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("scales the Visual page from the source font size but keeps its line-box ratio", () => {
    const base = visualTypographyFor(DEFAULT_EDITOR_SETTINGS);
    expect(base).toEqual({ fontSize: 17.5, lineHeight: 23.275 });

    const bigger = visualTypographyFor({ ...DEFAULT_EDITOR_SETTINGS, fontSize: 26 });
    // Line numbers stay glued to the prose only while both scale together.
    expect(bigger.lineHeight / bigger.fontSize).toBeCloseTo(base.lineHeight / base.fontSize, 5);
  });

  it("turns spell checking off as a value, not an absence", () => {
    expect(spellCheckLanguageAttribute(DEFAULT_EDITOR_SETTINGS)).toBe("en-US");
    expect(spellCheckLanguageAttribute({ ...DEFAULT_EDITOR_SETTINGS, spellCheckLanguage: "off" })).toBeNull();
  });
});

describe("live reconfiguration", () => {
  it("applies a settings change to an already-open editor without rebuilding it", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = createSharedEditorView(host, { doc: "\\section{A}", language: "latex", surface: "code" });
    try {
      const before = handle.view.state.facet(editorKeybindingsFacet);
      expect(before).toBe("default");

      setEditorSettings({ keybindings: "emacs" });
      expect(handle.view.state.facet(editorKeybindingsFacet)).toBe("emacs");
      // Same view, same document: the caret and undo history survive.
      expect(handle.view.state.doc.toString()).toBe("\\section{A}");
    } finally {
      handle.destroy();
      host.remove();
    }
  });

  it("stops following the store once the view is destroyed", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = createSharedEditorView(host, { doc: "x", language: "latex", surface: "code" });
    const view: EditorView = handle.view;
    handle.destroy();
    host.remove();

    // A destroyed view still holding a subscription would throw on dispatch.
    expect(() => setEditorSettings({ fontSize: 22 })).not.toThrow();
    expect(view.state.doc.toString()).toBe("x");
  });
});

import { APPEARANCE_KEY, DEFAULT_APPEARANCE, normalizeAppearance, useAppearance, type Appearance } from "./appearance";
import { DEFAULT_EDITOR_SETTINGS, EDITOR_FONT_FAMILIES, EDITOR_FONT_SIZES, EDITOR_LINE_HEIGHTS, EDITOR_SETTINGS_STORAGE_KEY, getEditorSettings, syncEditorSettings } from "./editor/editorSettings";
import { useStore, type ThemeMode } from "./store";
import { UI_COLOR_PRESETS, UI_COLOR_STORAGE_KEY, type UiColor } from "./uiColors";
import { UI_TYPOGRAPHY_STORAGE_KEY, type UiTypographyPreference } from "./uiTypography";

export interface AppearancePreset {
  format: "somniq-appearance"; version: 1;
  appearance: Appearance; theme: ThemeMode; color: UiColor; typography: UiTypographyPreference;
  editor: Pick<ReturnType<typeof getEditorSettings>, "fontFamily" | "fontSize" | "lineHeight">;
}
/** Commit related preference keys before changing any visible state. */
export function persistBatch(values: Record<string, string>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, localStorage.getItem(key)]));
  try { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }
  catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* original error stays visible */ }
    }
    throw error;
  }
}
export function selectAccentPreset(color: UiColor) {
  const appearance = { ...useAppearance.getState().value, customAccent: "" };
  const raw = JSON.stringify(appearance);
  persistBatch({ [APPEARANCE_KEY]: raw, [UI_COLOR_STORAGE_KEY]: color });
  useStore.getState().syncUiColor(color); useAppearance.getState().sync(raw);
}
export function currentAppearancePreset(): AppearancePreset {
  const state = useStore.getState(); const editor = getEditorSettings();
  return { format: "somniq-appearance", version: 1,
    appearance: { ...useAppearance.getState().value }, theme: state.themeMode, color: state.uiColor,
    typography: { mode: state.uiFontMode, fontSize: state.uiFontSize },
    editor: { fontFamily: editor.fontFamily, fontSize: editor.fontSize, lineHeight: editor.lineHeight } };
}
export function exportAppearancePreset() {
  const preset = currentAppearancePreset();
  // Local image blobs are deliberately not embedded in shareable theme files.
  if (preset.appearance.wallpaper === "custom") preset.appearance.wallpaper = "none";
  preset.appearance.wallpaperName = ""; preset.appearance.wallpaperRevision = "";
  return JSON.stringify(preset, null, 2);
}
export function parseAppearancePreset(raw: string): AppearancePreset {
  if (raw.length > 100_000) throw new Error("Theme file is too large.");
  const preset = JSON.parse(raw) as AppearancePreset;
  if (!preset || preset.format !== "somniq-appearance" || preset.version !== 1 || !preset.appearance || typeof preset.appearance !== "object"
    || !["light", "dark", "system"].includes(preset.theme) || !UI_COLOR_PRESETS.includes(preset.color)
    || !preset.typography || !["auto", "manual"].includes(preset.typography.mode)
    || !Number.isInteger(preset.typography.fontSize) || preset.typography.fontSize < 12 || preset.typography.fontSize > 20
    || !preset.editor || !EDITOR_FONT_FAMILIES.includes(preset.editor.fontFamily)
    || !EDITOR_FONT_SIZES.includes(preset.editor.fontSize) || !EDITOR_LINE_HEIGHTS.includes(preset.editor.lineHeight)) {
    throw new Error("Invalid SomniQ appearance file.");
  }
  const appearance = normalizeAppearance(preset.appearance);
  if (appearance.wallpaper === "custom") appearance.wallpaper = "none";
  appearance.wallpaperName = ""; appearance.wallpaperRevision = "";
  return { format: "somniq-appearance", version: 1, appearance, theme: preset.theme, color: preset.color,
    typography: { mode: preset.typography.mode, fontSize: preset.typography.fontSize },
    editor: { fontFamily: preset.editor.fontFamily, fontSize: preset.editor.fontSize, lineHeight: preset.editor.lineHeight } };
}
export function applyAppearancePreset(preset: AppearancePreset) {
  const editor = { ...getEditorSettings(), ...preset.editor };
  const values = {
    [APPEARANCE_KEY]: JSON.stringify(preset.appearance), "somniq-theme": preset.theme,
    [UI_COLOR_STORAGE_KEY]: preset.color, [UI_TYPOGRAPHY_STORAGE_KEY]: JSON.stringify(preset.typography),
    [EDITOR_SETTINGS_STORAGE_KEY]: JSON.stringify(editor),
  };
  persistBatch(values);
  useAppearance.getState().sync(values[APPEARANCE_KEY]); useStore.getState().syncTheme(preset.theme);
  useStore.getState().syncUiColor(preset.color); useStore.getState().syncUiTypography(values[UI_TYPOGRAPHY_STORAGE_KEY]);
  syncEditorSettings(values[EDITOR_SETTINGS_STORAGE_KEY]);
}
export function resetAppearance() {
  applyAppearancePreset({ format: "somniq-appearance", version: 1, appearance: { ...DEFAULT_APPEARANCE },
    theme: "system", color: "default", typography: { mode: "auto", fontSize: 14 },
    editor: { fontFamily: DEFAULT_EDITOR_SETTINGS.fontFamily, fontSize: DEFAULT_EDITOR_SETTINGS.fontSize, lineHeight: DEFAULT_EDITOR_SETTINGS.lineHeight } });
}

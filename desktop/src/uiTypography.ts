export type UiFontMode = "auto" | "manual";

export interface UiTypographyPreference {
  mode: UiFontMode;
  fontSize: number;
}

export const UI_TYPOGRAPHY_STORAGE_KEY = "somniq-ui-typography-v1";
export const UI_FONT_MIN = 12;
export const UI_FONT_MAX = 20;
export const UI_FONT_BASE = 14;
const DEFAULT_PREFERENCE: UiTypographyPreference = { mode: "auto", fontSize: UI_FONT_BASE };

export function normalizeUiFontSize(value: number): number {
  return Number.isFinite(value) ? Math.max(UI_FONT_MIN, Math.min(UI_FONT_MAX, Math.round(value))) : UI_FONT_BASE;
}

export function parseUiTypographyPreference(raw: string | null): UiTypographyPreference {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === "object" && "mode" in value && "fontSize" in value) {
      const preference = value as Record<string, unknown>;
      if ((preference.mode === "auto" || preference.mode === "manual") && typeof preference.fontSize === "number") {
        return { mode: preference.mode, fontSize: normalizeUiFontSize(preference.fontSize) };
      }
    }
  } catch {
    // A damaged preference must not prevent the workspace from opening.
  }
  return { ...DEFAULT_PREFERENCE };
}

export function readUiTypographyPreference(): UiTypographyPreference {
  try {
    return parseUiTypographyPreference(localStorage.getItem(UI_TYPOGRAPHY_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFERENCE };
  }
}

export function saveUiTypographyPreference(preference: UiTypographyPreference) {
  try {
    localStorage.setItem(UI_TYPOGRAPHY_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Apply in memory even when the WebView denies local storage.
  }
}

/** Logical CSS pixels already include the operating system's display scaling.
 * Keep small windows legible; increase type only when both axes have room. */
export function recommendedUiFontSize(width: number, height: number): number {
  if (width >= 3200 && height >= 1600) return 18;
  if (width >= 2200 && height >= 1200) return 16;
  if (width >= 1600 && height >= 900) return 15;
  return UI_FONT_BASE;
}

export function currentRecommendedUiFontSize(): number {
  if (typeof window === "undefined") return UI_FONT_BASE;
  const width = window.innerWidth || 1440;
  const height = window.innerHeight || 900;
  return recommendedUiFontSize(
    Math.min(width, window.screen?.availWidth || width),
    Math.min(height, window.screen?.availHeight || height),
  );
}

export function resolvedUiFontSize(preference: UiTypographyPreference, recommended: number): number {
  return preference.mode === "auto" ? recommended : preference.fontSize;
}

export function applyUiTypography(preference: UiTypographyPreference, recommended: number) {
  if (typeof document === "undefined") return;
  const fontSize = resolvedUiFontSize(preference, recommended);
  const root = document.documentElement;
  // Authored UI pixel sizes are normalized to rem during CSS processing.
  // A 14px body baseline therefore keeps every existing type hierarchy intact.
  root.style.fontSize = `${Math.round(16 * fontSize / UI_FONT_BASE * 1000) / 1000}px`;
  root.style.setProperty("--ui-font-size", `${fontSize}px`);
  root.dataset.uiFontMode = preference.mode;
  root.dataset.uiFontSize = String(fontSize);
}

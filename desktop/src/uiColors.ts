export const UI_COLOR_STORAGE_KEY = "somniq-ui-color-v1";
export const UI_COLOR_PRESETS = ["default", "purple", "teal", "green", "orange", "pink"] as const;
export type UiColor = typeof UI_COLOR_PRESETS[number];

export function parseUiColor(value: string | null): UiColor {
  return UI_COLOR_PRESETS.find((preset) => preset === value) ?? "default";
}

export function readUiColor(): UiColor {
  try {
    return parseUiColor(localStorage.getItem(UI_COLOR_STORAGE_KEY));
  } catch {
    return "default";
  }
}

export function saveUiColor(value: UiColor, required = false) {
  try {
    localStorage.setItem(UI_COLOR_STORAGE_KEY, value);
  } catch (error) {
    if (required) throw error;
  }
}

export function applyUiColor(value: UiColor) {
  if (typeof document !== "undefined") document.documentElement.dataset.uiColor = value;
}

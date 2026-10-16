import { create } from "zustand";

export const APPEARANCE_KEY = "somniq-appearance-v1";
export const SURFACES = ["default", "warm", "cool", "neutral", "contrast"] as const;
export const UI_FONTS = ["default", "system", "serif"] as const;
export const WALLPAPERS = ["none", "mountains", "orbit", "grid", "custom"] as const;
export interface Appearance {
  surface: typeof SURFACES[number];
  font: typeof UI_FONTS[number];
  customAccent: string;
  bodySize: number;
  lineHeight: "compact" | "standard" | "relaxed";
  readingWidth: "narrow" | "standard" | "wide";
  density: "compact" | "standard" | "comfortable";
  corners: "default" | "square" | "round";
  shadows: "default" | "none" | "soft";
  reducedMotion: boolean;
  wallpaper: typeof WALLPAPERS[number];
  wallpaperOpacity: number;
  wallpaperFit: "cover" | "contain" | "tile";
  wallpaperName: string;
  wallpaperRevision: string;
}
export const DEFAULT_APPEARANCE: Appearance = {
  surface: "default", font: "default", customAccent: "", bodySize: 0,
  lineHeight: "standard", readingWidth: "standard", density: "standard",
  corners: "default", shadows: "default", reducedMotion: false,
  wallpaper: "none", wallpaperOpacity: 15, wallpaperFit: "cover", wallpaperName: "", wallpaperRevision: "",
};
const choices = {
  surface: SURFACES, font: UI_FONTS, wallpaper: WALLPAPERS,
  lineHeight: ["compact", "standard", "relaxed"], readingWidth: ["narrow", "standard", "wide"],
  density: ["compact", "standard", "comfortable"], corners: ["default", "square", "round"],
  shadows: ["default", "none", "soft"], wallpaperFit: ["cover", "contain", "tile"],
} as const;
export function normalizeAppearance(value: unknown): Appearance {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = { ...DEFAULT_APPEARANCE };
  for (const [key, allowed] of Object.entries(choices)) {
    if ((allowed as readonly unknown[]).includes(input[key])) Object.assign(next, { [key]: input[key] });
  }
  next.customAccent = typeof input.customAccent === "string" && /^#[\da-f]{6}$/i.test(input.customAccent) ? input.customAccent.toLowerCase() : "";
  if (typeof input.bodySize === "number" && Number.isFinite(input.bodySize)) next.bodySize = input.bodySize === 0 ? 0 : Math.max(12, Math.min(26, Math.round(input.bodySize)));
  if (typeof input.wallpaperOpacity === "number" && Number.isFinite(input.wallpaperOpacity)) next.wallpaperOpacity = Math.max(0, Math.min(40, Math.round(input.wallpaperOpacity)));
  next.reducedMotion = input.reducedMotion === true;
  next.wallpaperName = typeof input.wallpaperName === "string" ? input.wallpaperName.slice(0, 160) : "";
  next.wallpaperRevision = typeof input.wallpaperRevision === "string" ? input.wallpaperRevision.slice(0, 80) : "";
  return next;
}
export function parseAppearance(raw: string | null): Appearance {
  try { return normalizeAppearance(raw ? JSON.parse(raw) : null); } catch { return { ...DEFAULT_APPEARANCE }; }
}
function readAppearance() {
  try { return parseAppearance(localStorage.getItem(APPEARANCE_KEY)); } catch { return { ...DEFAULT_APPEARANCE }; }
}

/** Derive readable accent shades instead of allowing an unreadable selected color. */
export function accentShade(hex: string, dark: boolean): string {
  const base = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = (rgb: number[]) => rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const background = dark ? luminance([35, 35, 35]) : luminance([240, 240, 240]);
  let rgb = base;
  for (let step = 0; step <= 100; step++) {
    rgb = base.map((value) => Math.round(value + ((dark ? 255 : 0) - value) * step / 100));
    const light = luminance(rgb);
    if ((Math.max(light, background) + .05) / (Math.min(light, background) + .05) >= 4.5) break;
  }
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
export function applyAppearance(value: Appearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.surface = value.surface;
  root.dataset.uiFont = value.font;
  root.dataset.density = value.density;
  root.dataset.corners = value.corners;
  root.dataset.shadows = value.shadows;
  root.dataset.reducedMotion = String(value.reducedMotion);
  root.dataset.wallpaper = value.wallpaper;
  root.dataset.customAccent = String(Boolean(value.customAccent));
  if (value.customAccent) {
    root.style.setProperty("--ui-custom-light", accentShade(value.customAccent, false));
    root.style.setProperty("--ui-custom-dark", accentShade(value.customAccent, true));
  } else {
    root.style.removeProperty("--ui-custom-light"); root.style.removeProperty("--ui-custom-dark");
  }
  if (value.bodySize) root.style.setProperty("--reading-font-size", `${value.bodySize}px`);
  else root.style.removeProperty("--reading-font-size");
  root.style.setProperty("--reading-line-height", String({ compact: 1.5, standard: 1.7, relaxed: 1.95 }[value.lineHeight]));
  root.style.setProperty("--reading-width", `${{ narrow: 680, standard: 820, wide: 1080 }[value.readingWidth]}px`);
  root.style.setProperty("--wallpaper-opacity", String(value.wallpaperOpacity / 100));
  root.style.setProperty("--wallpaper-size", value.wallpaperFit === "tile" ? "360px auto" : value.wallpaperFit);
  root.style.setProperty("--wallpaper-repeat", value.wallpaperFit === "tile" ? "repeat" : "no-repeat");
  if (value.wallpaper !== "custom") root.style.setProperty("--chat-wallpaper", value.wallpaper === "none" ? "none" : `url("/chat-backgrounds/${value.wallpaper}.svg")`);
}

const initial = readAppearance();
applyAppearance(initial);
export const useAppearance = create<{
  value: Appearance; patch: (patch: Partial<Appearance>) => void; sync: (raw: string | null) => void;
  wallpaperError: string; setWallpaperError: (error: string) => void;
}>((set, get) => ({
  value: initial,
  wallpaperError: "",
  setWallpaperError: (error) => { if (get().wallpaperError !== error) set({ wallpaperError: error }); },
  patch: (patch) => {
    const value = normalizeAppearance({ ...get().value, ...patch });
    // Persist first: a denied write must leave the real UI and store unchanged.
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value));
    applyAppearance(value); set({ value });
  },
  sync: (raw) => { const value = parseAppearance(raw); applyAppearance(value); set({ value }); },
}));

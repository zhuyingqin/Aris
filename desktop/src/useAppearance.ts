import { useEffect } from "react";
import { APPEARANCE_KEY, useAppearance } from "./appearance";
import { readWallpaperAsset } from "./chatWallpaper";
import { useStore } from "./store";
import { EDITOR_SETTINGS_STORAGE_KEY, syncEditorSettings } from "./editor/editorSettings";

export function useAppearanceEffects() {
  const sync = useAppearance((s) => s.sync);
  const wallpaper = useAppearance((s) => s.value.wallpaper);
  const revision = useAppearance((s) => s.value.wallpaperRevision);
  const themeMode = useStore((s) => s.themeMode);
  const syncTheme = useStore((s) => s.syncTheme);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) sync(event.newValue);
      if (event.key === "somniq-theme" || event.key === null) syncTheme(event.newValue);
      if (event.key === EDITOR_SETTINGS_STORAGE_KEY || event.key === null) syncEditorSettings(event.newValue);
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [sync, syncTheme]);
  useEffect(() => {
    if (themeMode !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if (useStore.getState().themeMode === "system") syncTheme("system"); };
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [themeMode, syncTheme]);
  useEffect(() => {
    useAppearance.getState().setWallpaperError("");
    if (wallpaper !== "custom") return;
    let cancelled = false;
    let url: string | undefined;
    document.documentElement.style.setProperty("--chat-wallpaper", "none");
    void readWallpaperAsset().then((asset) => {
      if (cancelled) return;
      if (!asset) throw new Error("Local background image was not found.");
      url = URL.createObjectURL(asset.blob);
      document.documentElement.style.setProperty("--chat-wallpaper", `url("${url}")`);
    }).catch((error) => { if (!cancelled) useAppearance.getState().setWallpaperError(String(error)); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [wallpaper, revision]);
}

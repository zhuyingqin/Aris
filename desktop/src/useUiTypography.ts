import { useEffect } from "react";
import { useStore } from "./store";
import { UI_TYPOGRAPHY_STORAGE_KEY } from "./uiTypography";

/** Shared by the workspace, sign-in screen, and companion WebViews. */
export function useUiTypography() {
  const refresh = useStore((state) => state.refreshUiTypography);
  const sync = useStore((state) => state.syncUiTypography);

  useEffect(() => {
    refresh();
    let frame: number | null = null;
    const scheduleRefresh = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => { frame = null; refresh(); });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_TYPOGRAPHY_STORAGE_KEY || event.key === null) sync(event.newValue);
    };
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("storage", onStorage);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh, sync]);
}

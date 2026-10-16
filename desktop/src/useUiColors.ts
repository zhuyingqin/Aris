import { useEffect } from "react";
import { useStore } from "./store";
import { UI_COLOR_STORAGE_KEY } from "./uiColors";

/** Keep other workspace and companion windows in sync with this device's choice. */
export function useUiColors() {
  const sync = useStore((state) => state.syncUiColor);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_COLOR_STORAGE_KEY || event.key === null) sync(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [sync]);
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./api/tauri";

export type WindowAction = "minimize" | "maximize" | "close";

/** Dispatch a native-window action only when running inside the Tauri shell. */
export function requestWindowAction(action: WindowAction) {
  if (!isTauri()) return;

  const currentWindow = getCurrentWindow();
  if (action === "minimize") void currentWindow.minimize();
  else if (action === "maximize") void currentWindow.toggleMaximize();
  else void currentWindow.close();
}

/** Set or clear native/browser fullscreen. */
export async function setWindowFullscreen(fullscreen: boolean): Promise<void> {
  if (isTauri()) {
    try {
      await getCurrentWindow().setFullscreen(fullscreen);
      return;
    } catch {
      // Fall through to browser fullscreen API
    }
  }
  if (typeof document !== "undefined") {
    try {
      if (fullscreen) {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } else {
        if (document.fullscreenElement && document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch {
      // Fullscreen requests can be rejected if unpermitted; fail silently
    }
  }
}

/** Check if the native window or document is currently fullscreen. */
export async function isWindowFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await getCurrentWindow().isFullscreen();
    } catch {
      // Fall through to browser check
    }
  }
  return typeof document !== "undefined" && Boolean(document.fullscreenElement);
}

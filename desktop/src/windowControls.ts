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

import { isTauri } from "./api/tauri";
import { WindowControlButtons } from "./WindowControlButtons";

/**
 * Frameless-window controls (minimize / maximize / close) for the pre-workspace
 * screens — sign-in and the auth check. Mirrors the main app titlebar so the
 * top-right controls stay consistent before and after login. Renders only inside
 * the Tauri shell; a plain browser preview supplies its own window chrome.
 */
export default function DesktopWindowControls() {
  if (!isTauri()) return null;

  return (
    <>
      <div className="sq-window-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="sq-window-controls">
        <WindowControlButtons />
      </div>
    </>
  );
}

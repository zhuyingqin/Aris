import type { CSSProperties } from "react";
import { isTauri } from "./api/tauri";
import { requestWindowAction } from "./windowControls";

const dragRegion: CSSProperties = {
  position: "fixed",
  inset: "0 0 auto 0",
  height: 36,
  zIndex: 1,
};

const closeButton: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  zIndex: 2,
  width: 46,
  height: 36,
  border: 0,
  background: "transparent",
  color: "var(--text, #e6e7ea)",
  cursor: "pointer",
  fontSize: 22,
  lineHeight: 1,
};

/** Supplies a close affordance for pre-workspace screens in frameless windows. */
export default function DesktopWindowCloseControl() {
  if (!isTauri()) return null;

  return (
    <>
      <div style={dragRegion} data-tauri-drag-region aria-hidden="true" />
      <button
        type="button"
        style={closeButton}
        aria-label="关闭窗口"
        title="关闭窗口"
        onClick={() => requestWindowAction("close")}
        onMouseEnter={(event) => { event.currentTarget.style.background = "#c42b1c"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      >
        ×
      </button>
    </>
  );
}

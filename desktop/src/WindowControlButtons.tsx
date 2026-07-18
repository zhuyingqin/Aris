import { requestWindowAction } from "./windowControls";

// Windows-style minimize / maximize / close glyphs, a 10×10 viewBox centered in
// a 46×36 hit area. Shared by the app titlebar and the pre-auth window controls
// so both surfaces stay pixel-identical.
export const WinCtl = {
  minimize: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M1.5 5h7" />
    </svg>
  ),
  maximize: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" rx="0.75" />
    </svg>
  ),
  close: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <path d="M1.6 1.6 8.4 8.4M8.4 1.6 1.6 8.4" />
    </svg>
  ),
};

export type WindowControlLabels = {
  minimize: string;
  maximize: string;
  close: string;
};

export const DEFAULT_WINDOW_CONTROL_LABELS: WindowControlLabels = {
  minimize: "最小化窗口",
  maximize: "最大化窗口",
  close: "关闭窗口",
};

/**
 * The three frameless-window buttons (minimize / maximize / close), rendered as
 * a fragment so callers can drop them into their own controls container. The
 * close button keeps the `close` class so hover styling can turn it red.
 */
export function WindowControlButtons({
  labels = DEFAULT_WINDOW_CONTROL_LABELS,
}: {
  labels?: WindowControlLabels;
}) {
  return (
    <>
      <button type="button" aria-label={labels.minimize} onClick={() => requestWindowAction("minimize")}>
        {WinCtl.minimize}
      </button>
      <button type="button" aria-label={labels.maximize} onClick={() => requestWindowAction("maximize")}>
        {WinCtl.maximize}
      </button>
      <button type="button" className="close" aria-label={labels.close} onClick={() => requestWindowAction("close")}>
        {WinCtl.close}
      </button>
    </>
  );
}

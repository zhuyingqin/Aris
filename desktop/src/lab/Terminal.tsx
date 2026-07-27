import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import {
  onTerminalExit,
  onTerminalOutput,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
} from "../api/tauri";
import { useStore } from "../store";
import { LAB_COPY } from "./i18n";

/** Decode a base64 chunk (PTY output arrives base64-encoded) to raw bytes so
 *  xterm can decode UTF-8 itself and never splits a multi-byte sequence. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let terminalSeq = 0;

interface TerminalProps {
  /** Working directory for the shell (the current project root). */
  cwd: string | null;
  /** Bumped by the parent when the dock is shown or resized, to trigger a refit. */
  refitSignal: number;
}

export default function TerminalPane({ cwd, refitSignal }: TerminalProps) {
  const language = useStore((s) => s.language);
  const copy = LAB_COPY[language];
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const id = `term-${(terminalSeq += 1)}-${Date.now()}`;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      // xterm needs concrete colors (it can't read CSS vars); these track the
      // app's dark surface. See `.lab-terminal` in Lab.css for the surround.
      theme: { background: "#0f1012", foreground: "#e4e6eb", cursor: "#e4e6eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not measured yet; the ResizeObserver below refits once it is */
    }
    fitRef.current = fit;

    let disposed = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    void terminalOpen(id, cwd, term.cols || 80, term.rows || 24).catch((error) => {
      term.write(`\r\n\x1b[31m${copy.terminalFailedToOpen(String(error))}\x1b[0m\r\n`);
    });

    void onTerminalOutput((event) => {
      if (event.id === id) term.write(base64ToBytes(event.data));
    }).then((fn) => (disposed ? fn() : (unlistenOutput = fn)));

    void onTerminalExit((event) => {
      if (event.id === id) term.write(`\r\n\x1b[90m${copy.terminalProcessExited}\x1b[0m\r\n`);
    }).then((fn) => (disposed ? fn() : (unlistenExit = fn)));

    const dataSub = term.onData((data) => void terminalWrite(id, data));
    const resizeSub = term.onResize(({ cols, rows }) => void terminalResize(id, cols, rows));

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* zero-size while hidden; refit happens when shown again */
      }
    });
    observer.observe(host);
    term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      void terminalClose(id);
      term.dispose();
      fitRef.current = null;
    };
    // cwd is intentionally captured once at mount; the parent remounts (via key)
    // when the project changes so a new shell starts in the new root.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit when the dock is revealed or resized (display:none → measurable).
  useEffect(() => {
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      /* still hidden */
    }
  }, [refitSignal]);

  return <div className="lab-terminal" ref={hostRef} />;
}

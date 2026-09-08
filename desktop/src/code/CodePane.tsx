import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import {
  codeBridgeSetTheme,
  codeBridgeConnected,
  codeBridgeOpenDiff,
  codeServerEnsure,
  codeServerStatus,
  codeServerStop,
  isTauri,
  onCodeBridgeActiveEditor,
  onCodeBridgeAsk,
  onCodeBridgeConnection,
  onCodeServerStatus,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { useStore } from "../store";
import type { CodeActiveEditor, CodeBridgeAsk, CodeServerStatus } from "../types";
import { currentSomniqColors } from "./codeTheme";
import { CODE_COPY } from "./i18n";
import "./Code.css";

// Remote compute is the one Lab panel with no counterpart inside the
// workbench, and `compute_submit` has no other entry point in the app — so it
// is rehosted here rather than lost when the Code page switched engines.
// Lazy because it pulls the whole compute API surface.
const ComputePanel = lazy(() => import("./ComputePanel"));

/** Long enough to notice a crash, cheap enough to leave running. */
const LIVENESS_POLL_MS = 5000;

const TRUST_ACK_KEY = "somniq-code-trust-ack";

function readTrustAck(): boolean {
  try {
    return localStorage.getItem(TRUST_ACK_KEY) === "true";
  } catch {
    return false;
  }
}

function writeTrustAck() {
  try {
    localStorage.setItem(TRUST_ACK_KEY, "true");
  } catch {
    // Storage may be unavailable; the notice reappears next launch.
  }
}

export function downloadPercent(status: CodeServerStatus | null): number {
  if (!status || status.totalBytes <= 0) return 0;
  const ratio = status.downloadedBytes / status.totalBytes;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/**
 * The workbench reloads whenever this changes.
 *
 * VS Code takes its workspace from the `folder` query parameter at load time,
 * so following a project switch means remounting the iframe. Keying on the URL
 * alone is not enough: a restart after a crash produces a new port *and* a new
 * token, and both live in that URL.
 */
export function frameKey(status: CodeServerStatus | null): string | null {
  return status?.phase === "ready" && status.url ? status.url : null;
}

/**
 * Turn a selection from the workbench into a chat prompt.
 *
 * The file and line range go in as plain text rather than an attachment so the
 * user can see exactly what the assistant was handed, and edit it before
 * sending — the command seeds the composer, it does not send anything.
 */
export function askPromptFor(
  ask: CodeBridgeAsk,
  copy: { askPrompt: (file: string, lines: string) => string; askTruncated: string },
): string {
  const lines = ask.startLine === ask.endLine
    ? String(ask.startLine)
    : `${ask.startLine}-${ask.endLine}`;
  const head = copy.askPrompt(ask.path, lines);
  const note = ask.truncated ? `\n${copy.askTruncated}` : "";
  // A fence long enough to survive a selection that itself contains ``` .
  const fence = ask.text.includes("```") ? "````" : "```";
  return `${head}${note}\n\n${fence}${ask.languageId}\n${ask.text}\n${fence}\n`;
}

export default function CodePane() {
  const language = useStore((state) => state.language);
  const theme = useStore((state) => state.theme);
  const currentProject = useStore((state) => state.currentProject);
  const setPendingChatInput = useStore((state) => state.setPendingChatInput);
  const pendingCodeDiff = useStore((state) => state.pendingCodeDiff);
  const setPendingCodeDiff = useStore((state) => state.setPendingCodeDiff);
  const setTab = useStore((state) => state.setTab);
  const copy = CODE_COPY[language];

  const [status, setStatus] = useState<CodeServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(readTrustAck);
  const [bridged, setBridged] = useState(false);
  const [activeEditor, setActiveEditor] = useState<CodeActiveEditor | null>(null);
  const [computeOpen, setComputeOpen] = useState(false);
  const startedRef = useRef(false);
  const projectPath = currentProject?.path ?? null;

  // What the user has open inside the iframe, so the compute panel can offer
  // to submit it.
  useEffect(() => {
    let disposed = false;
    const pending = onCodeBridgeActiveEditor((editor) => {
      if (!disposed) setActiveEditor(editor);
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // "Ask Aris about this selection" seeds the chat composer and switches tabs.
  // Deliberately not sent: the user gets to add the actual question.
  useEffect(() => {
    let disposed = false;
    const pending = onCodeBridgeAsk((ask) => {
      if (disposed) return;
      setPendingChatInput(askPromptFor(ask, CODE_COPY[useStore.getState().language]));
      setTab("chat");
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten());
    };
  }, [setPendingChatInput, setTab]);

  useEffect(() => {
    let disposed = false;
    const pending = onCodeBridgeConnection((connected) => {
      if (!disposed) setBridged(connected);
    });
    void codeBridgeConnected().then((connected) => {
      if (!disposed) setBridged(connected);
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // Review can be opened before the Code workbench has ever been mounted.
  // Keep the request in the store until the bridge is authenticated and the
  // embedded runtime is ready, then let VSCodium own the native Diff view.
  useEffect(() => {
    if (!pendingCodeDiff || !bridged || status?.phase !== "ready") return;
    let disposed = false;
    void codeBridgeOpenDiff(pendingCodeDiff.path, pendingCodeDiff.staged)
      .then((delivered) => {
        if (disposed) return;
        if (delivered) {
          setPendingCodeDiff(null);
        } else {
          // The connection can disappear between the state check above and
          // the command. Keep the request queued and wait for the next bridge
          // connection event instead of silently losing the user's diff.
          setBridged(false);
        }
      })
      .catch((reason) => {
        if (disposed) return;
        setError(formatUserFacingError(reason));
        setPendingCodeDiff(null);
      });
    return () => {
      disposed = true;
    };
  }, [bridged, pendingCodeDiff, setPendingCodeDiff, status?.phase]);

  // The extension host is the only way into the workbench's configuration —
  // its settings live in browser storage, so nothing written to disk is read.
  // Pushed on connect as well as on change, because a workbench that starts
  // after the user picked a theme would otherwise never hear about it.
  //
  // The palette is read from the live stylesheet on each push rather than
  // duplicated for the workbench: `theme` has already been applied to
  // `:root` by the time this runs, so the values are the ones on screen.
  useEffect(() => {
    if (!bridged) return;
    void codeBridgeSetTheme(theme === "dark", currentSomniqColors());
  }, [bridged, theme]);

  // Progress arrives as events so a 100 MB download is not polled for.
  useEffect(() => {
    let disposed = false;
    const pending = onCodeServerStatus((next) => {
      if (!disposed) setStatus(next);
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void codeServerStatus().then((next) => {
      if (!cancelled && next) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (!projectPath) {
      setError(copy.noProject);
      return;
    }
    setError(null);
    try {
      setStatus(await codeServerEnsure(projectPath, language));
    } catch (err) {
      setError(formatUserFacingError(err));
    }
  }, [copy.noProject, language, projectPath]);

  // Auto-start only once the runtime is already installed and the trust notice
  // has been seen. First-run runtime preparation is never implicit.
  useEffect(() => {
    if (!trusted || startedRef.current) return;
    if (!status?.installed || status.phase !== "idle") return;
    startedRef.current = true;
    void start();
  }, [start, status?.installed, status?.phase, trusted]);

  // Retarget the workspace when the user switches project, and relaunch when
  // they switch SomniQ's language — the server samples its display language
  // from the environment once, at startup, so nothing else can move it.
  useEffect(() => {
    if (!projectPath || status?.phase !== "ready") return;
    void codeServerEnsure(projectPath, language).then(setStatus).catch(() => {
      // A retarget failure leaves the previous workspace up; the poll below
      // surfaces the problem if the server actually died.
    });
    // Intentionally keyed on the project and language only: re-running on every
    // status change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, language]);

  // Nothing pushes us a crash, so ask.
  useEffect(() => {
    if (status?.phase !== "ready") return undefined;
    const timer = window.setInterval(() => {
      void codeServerStatus().then((next) => {
        if (next) setStatus(next);
      });
    }, LIVENESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status?.phase]);

  const cancel = useCallback(async () => {
    startedRef.current = false;
    try {
      setStatus(await codeServerStop());
    } catch (err) {
      setError(formatUserFacingError(err));
    }
  }, []);

  const retry = useCallback(() => {
    startedRef.current = true;
    void start();
  }, [start]);

  if (!isTauri()) {
    return <div className="code-pane code-pane-empty">{copy.desktopOnly}</div>;
  }

  if (!trusted) {
    return (
      <div className="code-pane code-pane-empty">
        <div className="code-notice" role="dialog" aria-label={copy.trustTitle}>
          <h2 className="code-notice-title">{copy.trustTitle}</h2>
          <p className="code-notice-body">{copy.trustBody}</p>
          <button
            type="button"
            className="code-notice-action"
            onClick={() => {
              writeTrustAck();
              setTrusted(true);
            }}
          >
            {copy.trustAck}
          </button>
        </div>
      </div>
    );
  }

  const url = frameKey(status);
  if (url) {
    return (
      <div className="code-pane code-pane-split">
        <iframe
          key={url}
          className="code-frame"
          title={copy.frameTitle}
          src={url}
          // The workbench needs clipboard access for copy/paste to behave, and
          // its extension host runs in a nested worker frame.
          allow="clipboard-read; clipboard-write"
        />
        {computeOpen && (
          <aside className="code-side" aria-label={copy.computeTitle}>
            <div className="code-side-head">
              <span>{copy.computeTitle}</span>
              <button
                type="button"
                className="code-side-close"
                aria-label={copy.computeHide}
                onClick={() => setComputeOpen(false)}
              >
                ×
              </button>
            </div>
            <Suspense fallback={<div className="code-side-loading">{copy.computeTitle}</div>}>
              <ComputePanel
                language={language}
                projectId={currentProject?.id ?? null}
                projectPath={projectPath}
                activePath={activeEditor?.path ?? null}
                activeKind={
                  activeEditor?.path ? (activeEditor.isNotebook ? "notebook" : "file") : null
                }
              />
            </Suspense>
          </aside>
        )}
        {!computeOpen && (
          <button
            type="button"
            className="code-side-toggle"
            title={copy.computeShow}
            onClick={() => setComputeOpen(true)}
          >
            {copy.computeTitle}
          </button>
        )}
      </div>
    );
  }

  const phase = status?.phase ?? "idle";
  const busy =
    phase === "downloading" ||
    phase === "extracting" ||
    phase === "extensions" ||
    phase === "starting";
  const failed = phase === "failed" || error !== null;
  const message = error ?? status?.message ?? null;

  return (
    <div className="code-pane code-pane-empty">
      <div className="code-notice">
        {busy && (
          <>
            <h2 className="code-notice-title">
              {phase === "downloading"
                ? copy.downloading(downloadPercent(status))
                : phase === "extracting"
                  ? copy.extracting
                  : phase === "extensions"
                    ? copy.installingExtensions
                    : copy.starting}
            </h2>
            {phase === "downloading" && (
              <div
                className="code-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloadPercent(status)}
              >
                <div
                  className="code-progress-fill"
                  style={{ width: `${downloadPercent(status)}%` }}
                />
              </div>
            )}
            <button type="button" className="code-notice-secondary" onClick={() => void cancel()}>
              {copy.cancel}
            </button>
          </>
        )}

        {failed && (
          <>
            <h2 className="code-notice-title">
              {status?.installed ? copy.crashedTitle : copy.failedTitle}
            </h2>
            {message && <p className="code-notice-body code-notice-error">{message}</p>}
            <button type="button" className="code-notice-action" onClick={retry}>
              {copy.retry}
            </button>
          </>
        )}

        {!busy && !failed && (
          <>
            <h2 className="code-notice-title">{copy.installTitle}</h2>
            <p className="code-notice-body">{copy.installBody}</p>
            <button type="button" className="code-notice-action" onClick={retry}>
              {copy.installAction}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

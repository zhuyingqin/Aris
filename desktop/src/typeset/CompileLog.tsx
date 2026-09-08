import { useEffect, useMemo, useRef, useState } from "react";
import type { LatexDiagnostic } from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import type { CompileLiveLog, CompileLogFilter, CompileLogLevel, CompileResult, CompileStatus } from "./compileModel";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { ToolIcon } from "./ToolIcon";

/** Sentinel id for the raw-log copy button, which has no diagnostic of its own. */
const RAW_LOG_COPY_ID = "raw-logs";

export default function CompileLog({
  result,
  status,
  error,
  liveLog,
  onDiagnosticClick,
  onClearCacheCompile,
  disabled = false,
}: {
  result: CompileResult | null;
  status: CompileStatus;
  error: string | null;
  liveLog: CompileLiveLog | null;
  onDiagnosticClick?: (diagnostic: LatexDiagnostic) => void;
  onClearCacheCompile?: () => void;
  disabled?: boolean;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].compileLog;
  const text = status === "running"
    ? [error, liveLog?.stderr, liveLog?.stdout].filter(Boolean).join("\n\n").trim()
    : [error, result?.stderr, result?.stdout].filter(Boolean).join("\n\n").trim();
  const pdfState = result?.pdfState ?? (result?.success ? "fresh" : result?.partialOutput ? "partial" : "missing");
  const sourceHash = result?.rootSourceHash ?? "";
  const buildTime = result?.compiledAtUnixMs ? new Date(result.compiledAtUnixMs).toLocaleTimeString() : copy.notRecorded;
  const diagnostics = useMemo(() => (result?.diagnostics ?? []).map((diagnostic, index) => {
    const level: CompileLogLevel = diagnostic.severity === "warning" && /(?:over|under)full\s+\\?hbox/i.test(diagnostic.message)
      ? "info"
      : diagnostic.severity === "error" || diagnostic.severity === "warning"
        ? diagnostic.severity
        : "info";
    return {
      diagnostic,
      id: `${diagnostic.code}-${diagnostic.filePath ?? "root"}-${diagnostic.line ?? index}-${index}`,
      level,
    };
  }), [result?.diagnostics]);
  const [filter, setFilter] = useState<CompileLogFilter>("all");
  const filteredDiagnostics = filter === "all"
    ? diagnostics
    : diagnostics.filter((entry) => entry.level === filter);
  const diagnosticSignature = diagnostics.map((entry) => entry.id).join("|");
  const [expandedDiagnosticId, setExpandedDiagnosticId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    setExpandedDiagnosticId(filteredDiagnostics[0]?.id ?? null);
  }, [filter, diagnosticSignature]);

  useEffect(() => () => {
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
  }, []);

  const copyText = (id: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopiedId(id);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1400);
    }).catch(() => {
      // Clipboard unavailable (denied permission, no secure context): leave the
      // button unconfirmed rather than claiming a copy that did not happen.
    });
  };

  const counts = diagnostics.reduce<Record<CompileLogLevel, number>>(
    (current, entry) => ({ ...current, [entry.level]: current[entry.level] + 1 }),
    { error: 0, warning: 0, info: 0 },
  );
  const filters: Array<{ id: CompileLogFilter; label: string; count: number }> = [
    { id: "all", label: copy.allLogs, count: diagnostics.length },
    { id: "error", label: copy.errors, count: counts.error },
    { id: "warning", label: copy.warnings, count: counts.warning },
    { id: "info", label: copy.info, count: counts.info },
  ];

  const diagnosticLocation = (diagnostic: LatexDiagnostic) => diagnostic.filePath
    ? `${diagnostic.filePath}${diagnostic.line ? `, ${diagnostic.line}` : ""}`
    : diagnostic.line ? copy.lineLabel(diagnostic.line) : copy.noSourceLocation;
  const canOpenDiagnostic = (diagnostic: LatexDiagnostic) => Boolean(
    onDiagnosticClick && (diagnostic.filePath || diagnostic.line),
  );
  const diagnosticGuidance = (diagnostic: LatexDiagnostic) => {
    if (diagnostic.code === "table_alignment") {
      return copy.tableAlignmentGuidance;
    }
    if (/citation .*undefined/i.test(diagnostic.message)) {
      return copy.undefinedCitationGuidance;
    }
    return diagnostic.severity === "error"
      ? copy.errorGuidance
      : copy.warningGuidance;
  };
  const diagnosticExcerpt = (diagnostic: LatexDiagnostic) => {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return copy.noExcerptCaptured;
    const message = diagnostic.message.toLocaleLowerCase();
    const match = lines.findIndex((line) => line.toLocaleLowerCase().includes(message));
    const start = match < 0 ? 0 : Math.max(0, match - 1);
    return lines.slice(start, start + 9).join("\n");
  };
  /** Message, source location and the captured excerpt, ready to paste into a
   * search box or a bug report. */
  const diagnosticAsText = (diagnostic: LatexDiagnostic) => [
    diagnostic.message,
    diagnosticLocation(diagnostic),
    "",
    diagnosticExcerpt(diagnostic),
  ].join("\n");
  /* The message and location are plain selectable text rather than buttons —
   * button labels cannot be drag-selected — so a click that ends a selection
   * has to leave the caret alone instead of jumping to the source. */
  const openDiagnostic = (diagnostic: LatexDiagnostic) => {
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onDiagnosticClick?.(diagnostic);
  };
  const openDiagnosticOnKey = (event: React.KeyboardEvent, diagnostic: LatexDiagnostic) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onDiagnosticClick?.(diagnostic);
  };

  return (
    <section className={`typeset-log new-logs-pane ${status === "error" ? "error" : ""}`} aria-label={copy.compileLogLabel}>
      <div className="typeset-log-tabs" role="tablist" aria-label={copy.compileLogFiltersLabel}>
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? "active" : ""}
            onClick={() => setFilter(item.id)}
          >
            <span>{item.label}</span>
            <b>{item.count}</b>
          </button>
        ))}
      </div>
      <div className="logs-pane-content">
        {filteredDiagnostics.length > 0 && (
          <div className="typeset-diagnostics typeset-diagnostics-accordion" aria-label={copy.latexDiagnosticsLabel}>
            {filteredDiagnostics.map(({ diagnostic, id, level }) => {
              const expanded = expandedDiagnosticId === id;
              const openable = canOpenDiagnostic(diagnostic);
              return (
                <article key={id} className={`typeset-diagnostic-card ${level} ${expanded ? "expanded" : ""}`}>
                  <div className="typeset-diagnostic-summary">
                    <button
                      type="button"
                      className="typeset-diagnostic-expand"
                      aria-label={copy.expandCollapseLabel(expanded, diagnostic.message)}
                      aria-expanded={expanded}
                      onClick={() => setExpandedDiagnosticId((current) => current === id ? null : id)}
                    >
                      <ToolIcon name="chevron" />
                    </button>
                    <div className="typeset-diagnostic-copy">
                      <span
                        className="typeset-diagnostic-title"
                        role={openable ? "button" : undefined}
                        tabIndex={openable ? 0 : undefined}
                        onClick={openable ? () => openDiagnostic(diagnostic) : undefined}
                        onKeyDown={openable ? (event) => openDiagnosticOnKey(event, diagnostic) : undefined}
                      >
                        {diagnostic.message}
                      </span>
                      <span
                        className="typeset-diagnostic-location"
                        role={openable ? "button" : undefined}
                        tabIndex={openable ? 0 : undefined}
                        onClick={openable ? () => openDiagnostic(diagnostic) : undefined}
                        onKeyDown={openable ? (event) => openDiagnosticOnKey(event, diagnostic) : undefined}
                      >
                        {diagnosticLocation(diagnostic)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`typeset-diagnostic-copy-btn${copiedId === id ? " copied" : ""}`}
                      aria-label={copiedId === id ? copy.copied : copy.copyDiagnostic}
                      title={copiedId === id ? copy.copied : copy.copyDiagnostic}
                      onClick={() => copyText(id, diagnosticAsText(diagnostic))}
                    >
                      <ToolIcon name={copiedId === id ? "review" : "copy"} />
                    </button>
                    {openable && (
                      <button
                        type="button"
                        className="typeset-diagnostic-locate"
                        aria-label={copy.openLabel(diagnosticLocation(diagnostic))}
                        title={copy.openSourceLocation}
                        onClick={() => onDiagnosticClick?.(diagnostic)}
                      >
                        <ToolIcon name="ref" />
                      </button>
                    )}
                    {level === "error" && <span className="typeset-diagnostic-sparkle" aria-hidden="true"><SvgIcon name="sparkle" size={14} /></span>}
                  </div>
                  {expanded && (
                    <div className="typeset-diagnostic-details">
                      <p>{diagnosticGuidance(diagnostic)}</p>
                      <pre>{diagnosticExcerpt(diagnostic)}</pre>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {!filteredDiagnostics.length && (
          <div className="typeset-log-empty" role="status">
            {diagnostics.length ? copy.noLogsMatchFilter : status === "running" ? copy.waitingForOutput : copy.noDiagnostics}
          </div>
        )}
        <details className="typeset-raw-logs">
          <summary>
            <ToolIcon name="chevron" />
            <span>{copy.rawLogs}</span>
            {text && (
              <button
                type="button"
                className={`typeset-diagnostic-copy-btn${copiedId === RAW_LOG_COPY_ID ? " copied" : ""}`}
                aria-label={copiedId === RAW_LOG_COPY_ID ? copy.copied : copy.copyRawLogs}
                title={copiedId === RAW_LOG_COPY_ID ? copy.copied : copy.copyRawLogs}
                // Inside a <summary>, so the click must not also toggle the disclosure.
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  copyText(RAW_LOG_COPY_ID, text);
                }}
              >
                <ToolIcon name={copiedId === RAW_LOG_COPY_ID ? "review" : "copy"} />
              </button>
            )}
          </summary>
          <pre>{text || (status === "running" ? copy.waitingForOutput : copy.noOutputCaptured)}</pre>
        </details>
      </div>
      <footer className="typeset-log-footer">
        {onClearCacheCompile && (
          <button
            type="button"
            className="typeset-log-clear-cache"
            disabled={disabled || status === "running"}
            onClick={onClearCacheCompile}
          >
            <ToolIcon name="clear" />
            <span>{copy.clearCachedFiles}</span>
          </button>
        )}
        <details className="typeset-log-build-details">
          <summary>
            <span>{copy.otherLogsAndFiles}</span>
            <ToolIcon name="chevron" />
          </summary>
          <div className="typeset-build-provenance" aria-label={copy.pdfBuildProvenanceLabel}>
            <span>{copy.pdfState(pdfState)}</span>
            <span>{copy.built(buildTime)}</span>
            <code title={sourceHash}>{copy.inputsHash(sourceHash.slice(0, 12) || copy.unavailable)}</code>
          </div>
        </details>
      </footer>
    </section>
  );
}

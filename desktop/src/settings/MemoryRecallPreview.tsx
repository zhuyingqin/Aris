import { useEffect, useRef, useState } from "react";

import { isTauri, memoryRecallPreview } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type {
  MemoryRecallEntry,
  MemoryRecallLayerCode,
  MemoryRecallPreview as Preview,
  MemoryRecallSkip,
} from "../types";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";

interface Props {
  language: Language;
  projectId: string;
}

const LAYER_ORDER: MemoryRecallLayerCode[] = ["R3", "R1", "R2", "R0"];

const PREVIEW_RESULT: Preview = {
  projectId: "preview-project",
  query: "上次那个检索实验的 p95 是多少？",
  rendered: "# SomniQ recalled research memory\n…",
  empty: false,
  candidateAtoms: 2,
  candidateCards: 1,
  candidateSessions: 2,
  latencyMs: 41,
  report: {
    budgetChars: 6000,
    usedChars: 5182,
    layers: [
      { code: "R3", quotaChars: 300, usedChars: 194, admitted: 1, skipped: 2 },
      { code: "R1", quotaChars: 700, usedChars: 268, admitted: 1, skipped: 1 },
      { code: "R2", quotaChars: 500, usedChars: 0, admitted: 0, skipped: 1 },
      { code: "R0", quotaChars: null, usedChars: 4437, admitted: 9, skipped: 13 },
    ],
    entries: [
      { layer: "R3", label: "user_preference", text: "- [user_preference] 回答默认使用中文，先给结论。", chars: 24, anchor: false },
      {
        layer: "R1",
        label: "experiment_result",
        text: "分层召回改造后 p95 从 92 ms 降到 53 ms。",
        chars: 24,
        anchor: false,
        sourceSessionId: "chat-20260810-1",
      },
      {
        layer: "R0",
        label: "chat-20260810-1 #5",
        text: "改完之后重跑了一遍，R0 查询 p95 是 53 ms，合并查询 96 ms。",
        chars: 33,
        anchor: true,
        sourceSessionId: "chat-20260810-1",
      },
      {
        layer: "R0",
        label: "chat-20260810-1 #4",
        text: "帮我把分层召回的门禁加上，然后重测。",
        chars: 18,
        anchor: false,
        sourceSessionId: "chat-20260810-1",
      },
    ],
    skipped: [
      { layer: "R1", label: "experiment_result", reason: "duplicate", text: "改完之后重跑了一遍，R0 查询 p95 是 53 ms。" },
      { layer: "R2", label: "检索实验", reason: "duplicate", text: "- 改完之后重跑了一遍，R0 查询 p95 是 53 ms。" },
      { layer: "R3", label: "methodological_lesson", reason: "not_standing", text: "- [methodological_lesson] 下次先看预算分配再看排序。" },
      { layer: "R0", label: "chat-20260810-1 #0", reason: "budget", text: "我们先聊聊这个记忆分层的事情。" },
    ],
  },
};

function layerClass(code: string) {
  return `memory-recall-${code.toLowerCase()}`;
}

/**
 * Counts a number up when it changes. Motion is opt-in: without a `matchMedia`
 * answer confirming the user has not asked for reduced motion, the value snaps.
 */
function useCountUp(value: number, duration = 520) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    const media = typeof window === "undefined" ? null : window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media || media.matches || from === value) {
      setDisplay(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return display;
}

function CountUp({ value }: { value: number }) {
  return <>{useCountUp(value).toLocaleString()}</>;
}

export default function MemoryRecallPreview({ language, projectId }: Props) {
  const copy = SETTINGS_COPY[language].memoryRecallPreview;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Preview | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runId, setRunId] = useState(0);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResult(isTauri() ? await memoryRecallPreview(query.trim()) : { ...PREVIEW_RESULT, query: query.trim(), projectId });
      setRunId((value) => value + 1);
      setShowRaw(false);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy(false);
    }
  };

  const report = result?.report;
  const budget = report?.budgetChars ?? 6000;
  const free = Math.max(0, budget - (report?.usedChars ?? 0));
  const layerOf = (code: MemoryRecallLayerCode) => report?.layers.find((item) => item.code === code);

  const renderEntry = (entry: MemoryRecallEntry, index: number) => (
    <li
      className={`memory-recall-entry ${layerClass(entry.layer)}`}
      key={`${entry.layer}-${index}`}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="memory-recall-entry-head">
        <span className={`memory-recall-chip ${layerClass(entry.layer)}`}>{entry.layer}</span>
        <span className="memory-recall-entry-label">{entry.label}</span>
        {entry.anchor && <span className="memory-recall-anchor">{copy.matchLabel}</span>}
        <span className="memory-recall-entry-chars">{entry.chars}</span>
      </div>
      <p>{entry.text}</p>
    </li>
  );

  const renderSkip = (skip: MemoryRecallSkip, index: number) => (
    <li className="memory-recall-skip" key={`${skip.layer}-${index}`} style={{ "--i": index } as React.CSSProperties}>
      <span className={`memory-recall-chip ${layerClass(skip.layer)}`}>{skip.layer}</span>
      <span className="memory-recall-entry-label">{skip.label}</span>
      <span className={`memory-recall-reason memory-recall-reason-${skip.reason}`}>
        {copy.reasonLabel[skip.reason] ?? skip.reason}
      </span>
      <p>{skip.text}</p>
    </li>
  );

  return (
    <div className="sp-update-section memory-recall-section">
      <div className="sp-section-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{copy.title}</div>
          <div className="sp-section-sub">
            {copy.subtitle}
          </div>
        </div>
      </div>

      <div className="memory-library-toolbar">
        <div className={`memory-library-search${busy ? " memory-recall-searching" : ""}`}>
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void run(); }}
            placeholder={copy.queryPlaceholder}
            aria-label={copy.queryAriaLabel}
          />
        </div>
        <button className="sp-btn sp-btn-primary" type="button" disabled={busy || !query.trim()} onClick={() => void run()}>
          {busy ? copy.assembling : copy.previewRecall}
        </button>
      </div>

      {result && report && (
        <div className="memory-recall-result" key={runId}>
          <div className="memory-recall-meter-head">
            <strong><CountUp value={report.usedChars} /> / {budget.toLocaleString()} {copy.charsInjected}</strong>
            <span>{result.latencyMs} ms</span>
          </div>
          <div className="memory-recall-meter" role="img" aria-label={copy.budgetAllocationAriaLabel}>
            {LAYER_ORDER.map((code, index) => {
              const used = layerOf(code)?.usedChars ?? 0;
              if (!used) return null;
              return (
                <span
                  className={`memory-recall-meter-fill ${layerClass(code)}`}
                  key={code}
                  style={{ width: `${(used / budget) * 100}%`, "--i": index } as React.CSSProperties}
                  title={`${code} · ${used}`}
                />
              );
            })}
            {free > 0 && <span className="memory-recall-meter-free" style={{ width: `${(free / budget) * 100}%` }} />}
          </div>

          <div className="memory-recall-budget-summary">
            <div className="memory-recall-budget-summary-head">
              <strong>{copy.injectionLayersTitle}</strong>
              <span>{copy.injectionLayersSubtitle}</span>
            </div>
            <div className="memory-recall-layers">
              {LAYER_ORDER.map((code, index) => {
                const layer = layerOf(code);
                const quota = layer?.quotaChars ?? null;
                const used = layer?.usedChars ?? 0;
                const kept = layer?.admitted ?? 0;
                const candidates = kept + (layer?.skipped ?? 0);
                return (
                  <div
                    className={`memory-recall-layer-card ${layerClass(code)}`}
                    key={code}
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <div className="memory-recall-layer-head">
                      <span className={`memory-recall-chip ${layerClass(code)}`}>{code}</span>
                      <span className="memory-recall-layer-name">{copy.layerLabel[code]}</span>
                      <span className="memory-recall-layer-value">
                        <strong><CountUp value={used} /></strong>
                        <small>{quota === null ? copy.charsUnit : `/ ${quota} ${copy.charsUnit}`}</small>
                      </span>
                    </div>
                    <div className="memory-recall-layer-bar">
                      <span
                        className={layerClass(code)}
                        style={{ width: `${Math.min(100, quota === null ? (used / budget) * 100 : (used / Math.max(1, quota)) * 100)}%` }}
                      />
                    </div>
                    <div className="memory-recall-layer-meta">
                      <span>{copy.injectedCountLabel(kept, candidates)}</span>
                      {quota === null && <span>{copy.sharedRemainingBudget}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {result.empty ? (
            <div className="memory-empty-state">
              {copy.nothingRecalled}
            </div>
          ) : (
            <div className="memory-recall-columns">
              <section>
                <div className="memory-recall-column-title">
                  <strong>{copy.injected}</strong>
                  <span>{report.entries.length}</span>
                </div>
                <ul className="memory-recall-list">{report.entries.map(renderEntry)}</ul>
              </section>
              <section>
                <div className="memory-recall-column-title">
                  <strong>{copy.dropped}</strong>
                  <span>{report.skipped.length}</span>
                </div>
                {report.skipped.length ? (
                  <ul className="memory-recall-list">{report.skipped.map(renderSkip)}</ul>
                ) : (
                  <div className="memory-empty-state">{copy.nothingDropped}</div>
                )}
              </section>
            </div>
          )}

          {!result.empty && (
            <div className="memory-recall-raw">
              <button className="sp-btn sp-btn-secondary" type="button" onClick={() => setShowRaw((value) => !value)}>
                {showRaw ? copy.hide : copy.raw}
              </button>
              {showRaw && <pre className="sq-subpane-in">{result.rendered}</pre>}
            </div>
          )}
        </div>
      )}

      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}

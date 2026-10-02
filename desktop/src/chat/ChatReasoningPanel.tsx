import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SvgIcon } from "../SvgIcon";
import { DEFAULT_REASONING_EFFORT, reasoningLevelName } from "./reasoningLevels";
import "./ChatReasoningPanel.css";

interface Props {
  language: "cn" | "en";
  effort: string;
  /** Backend-supported levels, from weakest to strongest. */
  levels: readonly string[];
  modelName?: string | null;
  disabled?: boolean;
  embedded?: boolean;
  onChange: (effort: string) => void | Promise<void>;
  onOpenModel?: () => void;
}

export default function ChatReasoningPanel({ language, effort, levels, modelName, disabled = false, embedded = false, onChange, onOpenModel }: Props) {
  const [draft, setDraft] = useState(effort);
  const [committing, setCommitting] = useState(false);
  const commitPending = useRef(false);
  const cancelled = useRef(false);
  const appliedEffort = useRef(effort);
  appliedEffort.current = effort;
  const label = language === "cn" ? "思考强度" : "Reasoning effort";
  const index = levels.indexOf(draft);
  const progress = levels.length > 1 ? Math.max(0, index) / (levels.length - 1) : 0;
  const visualStyle = {
    "--reasoning-progress": progress,
    "--reasoning-hue": 228 + progress * 48,
    "--reasoning-spark-duration": `${2.8 - progress * 1.2}s`,
  } as CSSProperties;
  const locked = disabled || committing || !levels.includes(effort);

  useEffect(() => {
    setDraft(effort);
  }, [effort, levels]);

  const commit = async (level: string | undefined) => {
    if (locked || commitPending.current || !level || !levels.includes(level) || level === effort) return;
    commitPending.current = true;
    setCommitting(true);
    try {
      await onChange(level);
    } catch {
      // The parent reports save errors and retains the authoritative applied value.
    } finally {
      commitPending.current = false;
      setCommitting(false);
      setDraft(appliedEffort.current);
    }
  };

  return (
    <div className={`chat-reasoning-panel${embedded ? " chat-reasoning-panel-embedded" : ""}`} role={embedded ? "group" : "dialog"} aria-label={label} aria-busy={committing} style={visualStyle}>
      <div className="chat-reasoning-heading">
        <SvgIcon name="lightning" size={14} />
        <output className="chat-reasoning-value" aria-live="polite">
          <span key={draft} className="chat-reasoning-value-text">{reasoningLevelName(draft, language)}</span>
        </output>
        {levels.includes(DEFAULT_REASONING_EFFORT) ? (
          <button
            type="button"
            className="chat-reasoning-reset"
            aria-label={language === "cn" ? "恢复默认强度（高）" : "Reset to default (High)"}
            title={language === "cn" ? "恢复默认强度（高）" : "Reset to default (High)"}
            disabled={locked || (effort === DEFAULT_REASONING_EFFORT && draft === effort)}
            onClick={() => {
              setDraft(DEFAULT_REASONING_EFFORT);
              void commit(DEFAULT_REASONING_EFFORT);
            }}
          >
            <SvgIcon name="reset" size={16} />
          </button>
        ) : <span />}
      </div>
      {modelName && (onOpenModel ? (
        <button type="button" className="chat-reasoning-model" disabled={locked}
          aria-label={`${language === "cn" ? "切换模型：" : "Switch model: "}${modelName}`} onClick={onOpenModel}>
          <span>{modelName}</span><SvgIcon name="chevronRight" size={12} />
        </button>
      ) : <div className="chat-reasoning-model">{modelName}</div>)}
      <div className="chat-reasoning-track">
        <div className="chat-reasoning-fill" aria-hidden="true">
          {Array.from({ length: Math.round(progress * 10) }, (_, particle) => (
            <span key={particle} className="chat-reasoning-particle" style={{
              left: `${8 + particle * 8.7}%`,
              top: `${25 + (particle % 3) * 20}%`,
              animationDelay: `${particle * -0.27}s`,
            }} />
          ))}
        </div>
        <div className="chat-reasoning-ticks" aria-hidden="true">{levels.map((level) => <span key={level} />)}</div>
        <input
          type="range"
          min={0}
          max={Math.max(0, levels.length - 1)}
          step={1}
          value={Math.max(0, index)}
          aria-label={label}
          aria-valuetext={reasoningLevelName(draft, language)}
          disabled={locked || levels.length < 2}
          autoFocus={!embedded && !locked && levels.length > 1}
          onChange={(event) => {
            cancelled.current = false;
            const level = levels[Number(event.currentTarget.value)];
            if (level) setDraft(level);
          }}
          onPointerUp={(event) => void commit(levels[Number(event.currentTarget.value)])}
          onPointerCancel={() => { cancelled.current = true; setDraft(effort); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { cancelled.current = true; setDraft(effort); }
            if (event.key === "Enter") void commit(levels[Number(event.currentTarget.value)]);
          }}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
              void commit(levels[Number(event.currentTarget.value)]);
            }
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            const panel = event.currentTarget.closest(embedded ? ".chat-model-settings-panel" : ".chat-reasoning-panel");
            if (next instanceof Node && panel?.contains(next)) return;
            if (!cancelled.current) void commit(levels[Number(event.currentTarget.value)]);
          }}
        />
      </div>
      <div className="chat-reasoning-limits" aria-hidden="true">
        <span>{reasoningLevelName(levels[0] ?? effort, language)}</span>
        <span>{reasoningLevelName(levels[levels.length - 1] ?? effort, language)}</span>
      </div>
    </div>
  );
}

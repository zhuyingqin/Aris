import { useId, type ReactNode } from "react";
import type { Language } from "../store";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import type { PreferenceSave } from "./usePreferenceSave";

export function SettingsPage({ title, scope, children, kind, hidden = false }: {
  title: string; scope?: string; children: ReactNode; kind: string; hidden?: boolean;
}) {
  const id = useId();
  return <section className={`settings-page settings-page-${kind}`} data-settings-page={kind} hidden={hidden} aria-labelledby={id}>
    <header className="settings-page-heading"><h1 id={id}>{title}</h1>{scope && <span className="settings-scope">{scope}</span>}</header>
    {children}
  </section>;
}

export function SettingsSection({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return <section className="settings-preference-section" aria-labelledby={id}>
    <header className="settings-section-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="settings-section-actions">{actions}</div>}</header>
    <div className="settings-section-body">{children}</div>
  </section>;
}

export function SettingsAdvanced({ title, children }: { title: string; children: ReactNode }) {
  return <details className="settings-advanced settings-page-advanced"><summary>{title}<span aria-hidden="true">⌄</span></summary><div className="settings-advanced-body">{children}</div></details>;
}

export function SettingRow({ title, description, children, feedback }: { title: string; description?: string; children: ReactNode; feedback?: ReactNode }) {
  return <div className="settings-row-entry">
    <div className="settings-row">
      <div className="settings-row-copy"><div className="settings-row-title">{title}</div>{description && <p>{description}</p>}</div>
      <div className="settings-row-control">{children}</div>
    </div>
    {feedback}
  </div>;
}

export function PreferenceFeedback({ preferences, preference, language }: {
  preferences: PreferenceSave; preference: string; language: Language;
}) {
  const feedback = preferences.feedback[preference];
  if (!feedback) return null;
  const copy = GENERAL_PAGE_COPY[language];
  return <SettingsFeedback state={feedback.state}
    message={feedback.state === "error" ? `${copy.saveFailed} ${feedback.error}`
      : feedback.state === "saving" ? copy.preferenceSaving : copy.preferenceSaved}
    retryLabel={copy.retry} onRetry={() => preferences.retry(preference)} />;
}

export function SettingsFeedback({ state, message, retryLabel, onRetry }: {
  state: "idle" | "saving" | "saved" | "error"; message: string; retryLabel?: string; onRetry?: () => void;
}) {
  if (state === "idle") return null;
  return <div className={`settings-feedback is-${state}`} role={state === "error" ? "alert" : "status"}>
    <span>{message}</span>
    {state === "error" && onRetry && <button type="button" className="sp-btn sp-btn-secondary" onClick={onRetry}>{retryLabel}</button>}
  </div>;
}

export function SettingsChoice<T extends string>({ label, value, options, disabled, onChange, variant = "default" }: {
  label: string; value: T; options: readonly { value: T; label: string; icon?: ReactNode }[]; disabled?: boolean; onChange: (value: T) => void;
  variant?: "default" | "preview" | "swatch";
}) {
  return <div className={`settings-choice${variant !== "default" ? ` settings-choice-${variant}` : ""}`} role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value}
      tabIndex={value === option.value ? 0 : -1} disabled={disabled} title={variant === "swatch" ? option.label : undefined} onClick={() => onChange(option.value)}
      onKeyDown={(event) => {
        let next: number;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + options.length - 1) % options.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = options.length - 1;
        else return;
        event.preventDefault();
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
        onChange(options[next].value);
      }}>{option.icon}<span className="settings-choice-label">{option.label}</span></button>)}
  </div>;
}

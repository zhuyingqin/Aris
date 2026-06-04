import { useEffect, useState } from "react";
import { configGet, configSet, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ConfigPatch, ConfigView } from "../types";

const EXECUTOR_PROVIDERS = ["anthropic", "anthropic-compat", "openai", "custom"];
const REVIEWER_PROVIDERS = [
  "",
  "openai",
  "gemini",
  "glm",
  "minimax",
  "kimi",
  "anthropic-compat",
  "deepseek",
  "custom",
];

export default function Settings() {
  const setError = useStore((s) => s.setError);
  const [view, setView] = useState<ConfigView | null>(null);
  const [form, setForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [revKey, setRevKey] = useState("");
  const [info, setInfo] = useState<string | null>(null);

  const load = (v: ConfigView) => {
    setView(v);
    setForm({
      executorProvider: v.executorProvider ?? "anthropic",
      executorModel: v.executorModel ?? "",
      executorBaseUrl: v.executorBaseUrl ?? "",
      reviewerProvider: v.reviewerProvider ?? "",
      reviewerModel: v.reviewerModel ?? "",
      reviewerBaseUrl: v.reviewerBaseUrl ?? "",
      language: v.language ?? "cn",
    });
    setExecKey("");
    setRevKey("");
  };

  useEffect(() => {
    if (!isTauri()) return;
    configGet().then(load).catch((e) => setError(String(e)));
  }, [setError]);

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">
          Settings need the Tauri backend. Run <code>npm run tauri dev</code>.
        </div>
      </div>
    );
  }
  if (!view) return <div className="board"><div className="empty">Loading…</div></div>;

  const upd = (patch: Partial<ConfigPatch>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setInfo(null);
    const patch: ConfigPatch = { ...form };
    if (execKey.trim()) patch.executorApiKey = execKey.trim();
    if (revKey.trim()) patch.reviewerApiKey = revKey.trim();
    try {
      const next = await configSet(patch);
      load(next);
      setInfo("Saved. Restart aris / the app for changes to take effect.");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="board" style={{ maxWidth: 760 }}>
      <div className="run-row sub" style={{ paddingLeft: 0, border: "none" }}>
        {view.configPath}
      </div>

      <section className="settings-section">
        <div className="panel-title">Executor (main LLM)</div>
        <Field label="provider">
          <select
            value={form.executorProvider ?? "anthropic"}
            onChange={(e) => upd({ executorProvider: e.target.value })}
          >
            {EXECUTOR_PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="model">
          <input
            value={form.executorModel ?? ""}
            placeholder="claude-opus-4-7 / gpt-5.5 / …"
            onChange={(e) => upd({ executorModel: e.target.value })}
          />
        </Field>
        <Field label="base URL (blank = official / clear)">
          <input
            value={form.executorBaseUrl ?? ""}
            placeholder="(official default)"
            onChange={(e) => upd({ executorBaseUrl: e.target.value })}
          />
        </Field>
        <Field
          label={`API key ${view.hasExecutorKey ? `— current ${view.executorKeyMasked}` : "— not set"}`}
        >
          <input
            type="password"
            value={execKey}
            placeholder={view.hasExecutorKey ? "•••• (leave blank to keep)" : "paste key"}
            onChange={(e) => setExecKey(e.target.value)}
          />
        </Field>
      </section>

      <section className="settings-section">
        <div className="panel-title">Reviewer (for LlmReview)</div>
        <Field label="provider (empty = none)">
          <select
            value={form.reviewerProvider ?? ""}
            onChange={(e) => upd({ reviewerProvider: e.target.value })}
          >
            {REVIEWER_PROVIDERS.map((p) => (
              <option key={p} value={p}>{p === "" ? "(none)" : p}</option>
            ))}
          </select>
        </Field>
        <Field label="model">
          <input
            value={form.reviewerModel ?? ""}
            placeholder="gpt-5.5 / gemini-2.5-pro / …"
            onChange={(e) => upd({ reviewerModel: e.target.value })}
          />
        </Field>
        <Field label="base URL">
          <input
            value={form.reviewerBaseUrl ?? ""}
            placeholder="(official default)"
            onChange={(e) => upd({ reviewerBaseUrl: e.target.value })}
          />
        </Field>
        <Field
          label={`API key ${view.hasReviewerKey ? `— current ${view.reviewerKeyMasked}` : "— not set"}`}
        >
          <input
            type="password"
            value={revKey}
            placeholder={view.hasReviewerKey ? "•••• (leave blank to keep)" : "paste key"}
            onChange={(e) => setRevKey(e.target.value)}
          />
        </Field>
      </section>

      <section className="settings-section">
        <div className="panel-title">Language</div>
        <Field label="responses language">
          <select
            value={form.language ?? "cn"}
            onChange={(e) => upd({ language: e.target.value })}
          >
            <option value="cn">中文 (cn)</option>
            <option value="en">English (en)</option>
          </select>
        </Field>
      </section>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="primary" onClick={save}>Save settings</button>
        {info && <span className="hint">{info}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

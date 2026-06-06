import { useEffect, useState } from "react";
import { configGet, configSet, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ConfigPatch, ConfigView } from "../types";

// ── Provider metadata ─────────────────────────────────────────────────────────

interface ProviderMeta {
  label: string;
  hint: string;
  defaultModel: string;
  defaultBaseUrl?: string;
}

const EXECUTOR_PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: {
    label: "Anthropic",
    hint: "Claude models via official API",
    defaultModel: "claude-sonnet-4-6",
  },
  "anthropic-compat": {
    label: "Anthropic-compat",
    hint: "Claude via custom base URL / proxy",
    defaultModel: "claude-sonnet-4-6",
  },
  openai: {
    label: "OpenAI-compatible",
    hint: "OpenAI, MiniMax, DeepSeek, Kimi…",
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimax.chat/v1",
  },
  custom: {
    label: "Custom",
    hint: "Any other provider",
    defaultModel: "",
  },
};

const REVIEWER_PROVIDERS: Record<string, ProviderMeta> = {
  "": { label: "None", hint: "Disable reviewer", defaultModel: "" },
  openai: { label: "OpenAI-compatible", hint: "GPT, MiniMax, DeepSeek…", defaultModel: "" },
  minimax: { label: "MiniMax", hint: "MiniMax native API", defaultModel: "MiniMax-M2.7" },
  gemini: { label: "Gemini", hint: "Google Gemini", defaultModel: "gemini-2.5-pro" },
  glm: { label: "GLM", hint: "Zhipu GLM", defaultModel: "" },
  kimi: { label: "Kimi", hint: "Moonshot Kimi", defaultModel: "" },
  "anthropic-compat": { label: "Anthropic-compat", hint: "Claude via proxy", defaultModel: "" },
  deepseek: { label: "DeepSeek", hint: "DeepSeek models", defaultModel: "" },
  custom: { label: "Custom", hint: "Any provider", defaultModel: "" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row-label">
        <span className="st-label">{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

function KeyInput({
  value,
  placeholder,
  masked,
  onChange,
}: {
  value: string;
  placeholder: string;
  masked: string | null | undefined;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  const hasSavedSecret = Boolean(masked);
  return (
    <div className="st-key-wrap" data-has-saved-secret={hasSavedSecret}>
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="st-key-input"
        spellCheck={false}
      />
      <button
        className="st-key-eye"
        onClick={() => setShow((v) => !v)}
        title={show ? "Hide" : "Show"}
        type="button"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function SecretPanel({
  title,
  status,
  help,
  children,
}: {
  title: string;
  status: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="st-secret-panel">
      <div className="st-secret-copy">
        <div className="st-secret-title">{title}</div>
        <div className="st-secret-status">{status}</div>
      </div>
      <div className="st-secret-control">{children}</div>
      <div className="st-secret-help">{help}</div>
    </div>
  );
}

function ProviderSelect({
  value,
  providers,
  onChange,
}: {
  value: string;
  providers: Record<string, ProviderMeta>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="st-provider-grid">
      {Object.entries(providers).map(([key, meta]) => (
        <button
          key={key}
          type="button"
          className={`st-provider-card${value === key ? " active" : ""}`}
          onClick={() => onChange(key)}
        >
          <span className="st-provider-label">{meta.label}</span>
          <span className="st-provider-hint">{meta.hint}</span>
        </button>
      ))}
    </div>
  );
}

function LayerSection({
  index,
  tone,
  title,
  subtitle,
  children,
}: {
  index: string;
  tone: "executor" | "team" | "surface";
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`st-layer st-layer-${tone}`}>
      <div className="st-layer-head">
        <div className="st-layer-marker">{index}</div>
        <div className="st-layer-title-wrap">
          <div className="st-layer-title">{title}</div>
          <div className="st-layer-sub">{subtitle}</div>
        </div>
      </div>
      <div className="st-layer-body">{children}</div>
    </section>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

export default function Settings() {
  const setError = useStore((s) => s.setError);
  const [view, setView] = useState<ConfigView | null>(null);
  const [form, setForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [revKey, setRevKey] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");

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
        <div className="empty">Settings need the Tauri backend.</div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="board">
        <div className="empty">Loading…</div>
      </div>
    );
  }

  const upd = (patch: Partial<ConfigPatch>) => {
    setSaveState("idle");
    setForm((f) => ({ ...f, ...patch }));
  };

  const save = async () => {
    setSaveState("saving");
    const patch: ConfigPatch = { ...form };
    if (execKey.trim()) patch.executorApiKey = execKey.trim();
    if (revKey.trim()) patch.reviewerApiKey = revKey.trim();
    try {
      const next = await configSet(patch);
      load(next);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 3000);
    } catch (e) {
      setError(String(e));
      setSaveState("error");
    }
  };

  const execProvider = form.executorProvider ?? "anthropic";
  const revProvider = form.reviewerProvider ?? "";
  const execKeyStatus = view.hasExecutorKey
    ? `Saved key: ${view.executorKeyMasked ?? "configured"}`
    : "No key saved yet";
  const revKeyStatus = view.hasReviewerKey
    ? `Saved key: ${view.reviewerKeyMasked ?? "configured"}`
    : "No reviewer key saved yet";

  return (
    <div className="st-page">
      <div className="st-architecture">
        <div className="st-architecture-copy">
          <div className="st-eyebrow">Runtime settings</div>
          <div className="st-architecture-title">Three-layer configuration</div>
        </div>
        <div className="st-architecture-strip" aria-label="ARIS runtime layers">
          <span>Executor</span>
          <span>Team state machine</span>
          <span>UI / CLI</span>
        </div>
      </div>

      <div className="st-sections">
        <LayerSection
          index="01"
          tone="executor"
          title="Unified executor layer"
          subtitle="Provider, model and credentials shared by chat, workflow and CLI calls."
        >
            <div className="st-field-group">
              <div className="st-field-label">Provider</div>
              <ProviderSelect
                value={execProvider}
                providers={EXECUTOR_PROVIDERS}
                onChange={(v) => upd({ executorProvider: v })}
              />
            </div>

            <SecretPanel
              title="Executor API key / 密钥"
              status={execKeyStatus}
              help="Paste a new key here, then save. Leave it blank to keep the saved key."
            >
              <KeyInput
                value={execKey}
                placeholder={view.hasExecutorKey ? "leave blank to keep, paste a new key to replace" : "paste your API key"}
                masked={view.executorKeyMasked}
                onChange={setExecKey}
              />
            </SecretPanel>

            <Row label="Model" hint="Model ID sent in API requests">
              <input
                value={form.executorModel ?? ""}
                placeholder={EXECUTOR_PROVIDERS[execProvider]?.defaultModel || "e.g. claude-sonnet-4-6"}
                onChange={(e) => upd({ executorModel: e.target.value })}
              />
            </Row>

            <Row label="Base URL" hint="Leave blank for official endpoint">
              <input
                value={form.executorBaseUrl ?? ""}
                placeholder={
                  EXECUTOR_PROVIDERS[execProvider]?.defaultBaseUrl || "(official default)"
                }
                onChange={(e) => upd({ executorBaseUrl: e.target.value })}
              />
            </Row>
        </LayerSection>

        <LayerSection
          index="02"
          tone="team"
          title="Team state machine layer"
          subtitle="Reviewer configuration used by team verification gates."
        >
            <div className="st-field-group">
              <div className="st-field-label">Provider</div>
              <ProviderSelect
                value={revProvider}
                providers={REVIEWER_PROVIDERS}
                onChange={(v) => upd({ reviewerProvider: v })}
              />
            </div>

            {revProvider === "" ? (
              <div className="st-inline-state">
                <span className="st-inline-state-title">Reviewer disabled</span>
                <span className="st-inline-state-copy">Team verification will stay in manual judgment mode.</span>
              </div>
            ) : (
              <>
                <SecretPanel
                  title="Reviewer API key / 密钥"
                  status={revKeyStatus}
                  help="Used only for team verification reviews. Leave blank to keep the saved reviewer key."
                >
                  <KeyInput
                    value={revKey}
                    placeholder={view.hasReviewerKey ? "leave blank to keep, paste a new key to replace" : "paste reviewer API key"}
                    masked={view.reviewerKeyMasked}
                    onChange={setRevKey}
                  />
                </SecretPanel>

                <Row label="Model" hint="Model ID for reviewer">
                  <input
                    value={form.reviewerModel ?? ""}
                    placeholder={REVIEWER_PROVIDERS[revProvider]?.defaultModel || "model ID"}
                    onChange={(e) => upd({ reviewerModel: e.target.value })}
                  />
                </Row>

                <Row label="Base URL" hint="Leave blank for official endpoint">
                  <input
                    value={form.reviewerBaseUrl ?? ""}
                    placeholder="(official default)"
                    onChange={(e) => upd({ reviewerBaseUrl: e.target.value })}
                  />
                </Row>
              </>
            )}
        </LayerSection>

        <LayerSection
          index="03"
          tone="surface"
          title="UI / CLI calling layer"
          subtitle="Local presentation defaults and the persisted config location."
        >
            <div className="st-field-group">
              <div className="st-field-label">Language</div>
            <div className="st-lang-grid">
              {[
                { value: "cn", label: "中文", sub: "Chinese" },
                { value: "en", label: "English", sub: "English" },
              ].map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={`st-lang-card${form.language === l.value ? " active" : ""}`}
                  onClick={() => upd({ language: l.value })}
                >
                  <span className="st-lang-label">{l.label}</span>
                  <span className="st-lang-sub">{l.sub}</span>
                </button>
              ))}
            </div>
            </div>

            <Row label="Config file" hint="Shared by the desktop UI and CLI">
              <input className="st-readonly-input" value={view.configPath} readOnly />
            </Row>
        </LayerSection>
      </div>

      {/* ── Save bar ── */}
      <div className="st-save-bar">
        <button
          className={`st-save-btn${saveState === "saving" ? " saving" : ""}`}
          onClick={save}
          disabled={saveState === "saving"}
        >
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Save settings"}
        </button>
        {saveState === "saved" && (
          <span className="st-save-info">Restart the app for changes to take effect.</span>
        )}
      </div>
    </div>
  );
}

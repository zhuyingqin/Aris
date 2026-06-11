import { useEffect, useRef, useState } from "react";
import { configGet, configSet, configTest, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ConfigPatch, ConfigTestResult, ConfigView } from "../types";

// ── Provider metadata ─────────────────────────────────────────────────────────

interface ProviderMeta {
  label: string;
  hint: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  models?: PresetOption[];
  baseUrls?: PresetOption[];
}

interface PresetOption {
  label: string;
  value: string;
  hint?: string;
}

const EXECUTOR_MODELS: PresetOption[] = [
  { label: "Claude Opus 4.7", value: "claude-opus-4-7", hint: "Anthropic" },
  { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hint: "Anthropic" },
  { label: "GPT-5.5", value: "gpt-5.5", hint: "OpenAI-compatible" },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro", hint: "Google OpenAI-compatible" },
  { label: "GLM-5", value: "GLM-5", hint: "Zhipu" },
  { label: "MiniMax M3", value: "MiniMax-M3", hint: "MiniMax" },
  { label: "MiniMax M2.7", value: "MiniMax-M2.7", hint: "MiniMax" },
  { label: "Kimi K2.5", value: "kimi-k2.5", hint: "Moonshot" },
  { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro", hint: "DeepSeek" },
  { label: "Qwen 3.6 Plus", value: "qwen3.6-plus", hint: "DashScope" },
  { label: "Doubao Pro 4K", value: "doubao-pro-4k", hint: "Ark" },
  { label: "Mimo V2.5 Pro", value: "mimo-v2.5-pro", hint: "Xiaomi" },
];

const OPENAI_COMPAT_URLS: PresetOption[] = [
  { label: "OpenAI", value: "https://api.openai.com/v1", hint: "Official OpenAI-compatible" },
  { label: "MiniMax", value: "https://api.minimaxi.com/v1", hint: "Official MiniMax" },
  { label: "Gemini", value: "https://generativelanguage.googleapis.com/v1beta/openai", hint: "Google OpenAI-compatible" },
  { label: "GLM", value: "https://open.bigmodel.cn/api/paas/v4", hint: "Zhipu GLM" },
  { label: "Kimi", value: "https://api.moonshot.cn/v1", hint: "Moonshot" },
  { label: "DeepSeek", value: "https://api.deepseek.com/v1", hint: "OpenAI-compatible" },
  { label: "Qwen", value: "https://dashscope.aliyuncs.com/compatible-mode/v1", hint: "DashScope" },
  { label: "Qwen Coding", value: "https://coding.dashscope.aliyuncs.com/v1", hint: "DashScope Coding Plan" },
  { label: "Doubao", value: "https://ark.cn-beijing.volces.com/api/v3", hint: "Volcengine Ark" },
  { label: "OpenRouter", value: "https://openrouter.ai/api/v1", hint: "OpenRouter" },
];

const ANTHROPIC_URLS: PresetOption[] = [
  { label: "Official", value: "", hint: "Use Anthropic default" },
  { label: "Anthropic API", value: "https://api.anthropic.com", hint: "Explicit official endpoint" },
  { label: "NewCLI", value: "https://code.newcli.com/claude", hint: "Claude-Code-compatible proxy" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn", hint: "Anthropic-format proxy" },
];

const ANTHROPIC_COMPAT_URLS: PresetOption[] = [
  { label: "Official", value: "https://api.anthropic.com", hint: "Anthropic-compatible" },
  { label: "MiniMax", value: "https://api.minimaxi.com/anthropic", hint: "MiniMax Anthropic-compatible" },
  { label: "DeepSeek", value: "https://api.deepseek.com/anthropic", hint: "DeepSeek Anthropic-compatible" },
  { label: "NewCLI", value: "https://code.newcli.com/claude", hint: "Claude proxy" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn", hint: "Anthropic-format proxy" },
];

const EXECUTOR_PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: {
    label: "Anthropic",
    hint: "Claude models via official API",
    defaultModel: "claude-opus-4-7",
    models: EXECUTOR_MODELS.filter((m) => m.hint === "Anthropic"),
    baseUrls: ANTHROPIC_URLS,
  },
  "anthropic-compat": {
    label: "Anthropic-compat",
    hint: "Claude via custom base URL / proxy",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hint: "Claude proxy" },
      { label: "MiniMax M3", value: "MiniMax-M3", hint: "MiniMax Anthropic-compatible" },
      { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro", hint: "DeepSeek Anthropic-compatible" },
    ],
    baseUrls: ANTHROPIC_COMPAT_URLS,
  },
  openai: {
    label: "OpenAI-compatible",
    hint: "OpenAI, MiniMax, DeepSeek, Kimi…",
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    models: EXECUTOR_MODELS.filter((m) => m.hint !== "Anthropic"),
    baseUrls: OPENAI_COMPAT_URLS,
  },
  custom: {
    label: "Custom",
    hint: "Any other provider",
    defaultModel: "",
    models: EXECUTOR_MODELS,
    baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((item) => item.value)],
  },
};

function normalizeExecutorProvider(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  const current = provider || "anthropic";
  const lower = (baseUrl ?? "").trim().toLowerCase();
  if (
    current === "anthropic"
    && (
      lower.includes("minimaxi.com/anthropic")
      || lower.includes("deepseek.com/anthropic")
    )
  ) {
    return "anthropic-compat";
  }
  return current;
}

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

function PresetTextInput({
  value,
  placeholder,
  options,
  onChange,
}: {
  value: string;
  placeholder: string;
  options: PresetOption[];
  onChange: (v: string) => void;
}) {
  const currentPreset = options.find((option) => option.value === value)?.value ?? "__custom";
  return (
    <div className="st-preset-control">
      <select
        value={currentPreset}
        onChange={(event) => {
          if (event.target.value === "__custom") {
            onChange("");
            return;
          }
          onChange(event.target.value);
        }}
      >
        <option value="__custom">Custom / manual</option>
        {options.map((option) => (
          <option key={`${option.label}:${option.value || "blank"}`} value={option.value}>
            {option.label}
            {option.hint ? ` · ${option.hint}` : ""}
          </option>
        ))}
      </select>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
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
  tone: "executor" | "surface";
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

function TestDetail({ detail }: { detail: ConfigTestResult["executor"] }) {
  return (
    <div className={`st-test-detail${detail.ok ? " ok" : " failed"}`}>
      <div className="st-test-detail-head">
        <span className="st-test-dot" />
        <span className="st-test-label">{detail.label}</span>
        {detail.model && <span className="st-test-meta">{detail.model}</span>}
      </div>
      <div className="st-test-message">{detail.message}</div>
      {detail.baseUrl && <div className="st-test-url">{detail.baseUrl}</div>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "passed" | "failed";

export default function Settings() {
  const setError = useStore((s) => s.setError);
  const [view, setView] = useState<ConfigView | null>(null);
  const [form, setForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [scopusKey, setScopusKey] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const operationVersion = useRef(0);
  const activeOperation = useRef<{ kind: "save" | "test"; version: number } | null>(null);
  const savedTimer = useRef<number | null>(null);

  const load = (v: ConfigView) => {
    const executorProvider = normalizeExecutorProvider(v.executorProvider, v.executorBaseUrl);
    setView(v);
    setForm({
      executorProvider,
      executorModel: v.executorModel ?? "",
      executorBaseUrl: v.executorBaseUrl ?? "",
      language: v.language ?? "cn",
    });
    setExecKey("");
    setScopusKey("");
  };

  useEffect(() => {
    if (!isTauri()) return;
    configGet().then(load).catch((e) => setError(String(e)));
  }, [setError]);
  useEffect(() => () => {
    operationVersion.current += 1;
    activeOperation.current = null;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

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
    operationVersion.current += 1;
    activeOperation.current = null;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("idle");
    setTestState("idle");
    setTestResult(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const buildPatch = () => {
    const patch: ConfigPatch = { ...form };
    if (execKey.trim()) patch.executorApiKey = execKey.trim();
    if (scopusKey.trim()) patch.scopusApiKey = scopusKey.trim();
    return patch;
  };

  const save = async () => {
    if (activeOperation.current) return;
    const version = ++operationVersion.current;
    activeOperation.current = { kind: "save", version };
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("saving");
    setTestState("idle");
    setTestResult(null);
    const patch = buildPatch();
    try {
      const next = await configSet(patch);
      if (version !== operationVersion.current) return;
      load(next);
      setSaveState("saved");
      savedTimer.current = window.setTimeout(() => {
        if (version === operationVersion.current) setSaveState("idle");
      }, 3000);
    } catch (e) {
      if (version !== operationVersion.current) return;
      setError(String(e));
      setSaveState("error");
    } finally {
      if (activeOperation.current?.version === version) activeOperation.current = null;
    }
  };

  const test = async () => {
    if (activeOperation.current) return;
    const version = ++operationVersion.current;
    activeOperation.current = { kind: "test", version };
    setTestState("testing");
    setTestResult(null);
    try {
      const result = await configTest(buildPatch());
      if (version !== operationVersion.current) return;
      setTestResult(result);
      setTestState(result.ok ? "passed" : "failed");
    } catch (e) {
      if (version !== operationVersion.current) return;
      const message = String(e);
      setTestResult({
        ok: false,
        message,
        executor: {
          ok: false,
          label: "Settings",
          message,
        },
      });
      setTestState("failed");
    } finally {
      if (activeOperation.current?.version === version) activeOperation.current = null;
    }
  };

  const execProvider = form.executorProvider ?? "anthropic";
  const execMeta = EXECUTOR_PROVIDERS[execProvider] ?? EXECUTOR_PROVIDERS.custom;
  const execKeyStatus = view.hasExecutorKey
    ? `Saved key: ${view.executorKeyMasked ?? "configured"}`
    : "No key saved yet";

  const chooseExecutorProvider = (provider: string) => {
    const meta = EXECUTOR_PROVIDERS[provider] ?? EXECUTOR_PROVIDERS.custom;
    upd({
      executorProvider: provider,
      executorModel: provider === "custom" ? form.executorModel ?? "" : meta.defaultModel,
      executorBaseUrl: provider === "custom"
        ? form.executorBaseUrl ?? ""
        : meta.defaultBaseUrl ?? meta.baseUrls?.[0]?.value ?? "",
    });
  };

  const clearTestOnSecretChange = () => {
    operationVersion.current += 1;
    activeOperation.current = null;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("idle");
    setTestState("idle");
    setTestResult(null);
  };

  return (
    <div className="st-page">
      <div className="st-architecture">
        <div className="st-architecture-copy">
          <div className="st-eyebrow">Runtime settings</div>
          <div className="st-architecture-title">Desktop configuration</div>
        </div>
        <div className="st-architecture-strip" aria-label="ARIS runtime layers">
          <span>Executor</span>
          <span>UI / CLI</span>
        </div>
      </div>

      <div className="st-sections">
        <LayerSection
          index="01"
          tone="executor"
          title="Unified executor layer"
          subtitle="Provider, model and credentials shared by chat and CLI calls."
        >
            <div className="st-field-group">
              <div className="st-field-label">Provider</div>
              <ProviderSelect
                value={execProvider}
                providers={EXECUTOR_PROVIDERS}
                onChange={chooseExecutorProvider}
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
                onChange={(value) => {
                  clearTestOnSecretChange();
                  setExecKey(value);
                }}
              />
            </SecretPanel>

            <Row label="Model" hint="Model ID sent in API requests">
              <PresetTextInput
                value={form.executorModel ?? ""}
                placeholder={EXECUTOR_PROVIDERS[execProvider]?.defaultModel || "e.g. claude-sonnet-4-6"}
                options={execMeta.models ?? EXECUTOR_MODELS}
                onChange={(value) => upd({ executorModel: value })}
              />
            </Row>

            <Row label="Base URL" hint="Leave blank for official endpoint">
              <PresetTextInput
                value={form.executorBaseUrl ?? ""}
                placeholder={
                  EXECUTOR_PROVIDERS[execProvider]?.defaultBaseUrl || "(official default)"
                }
                options={execMeta.baseUrls ?? OPENAI_COMPAT_URLS}
                onChange={(value) => upd({ executorBaseUrl: value })}
              />
            </Row>
        </LayerSection>

        <LayerSection
          index="02"
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

            <SecretPanel
              title="Scopus API key / 文献检索密钥"
              status={view.hasScopusKey
                ? `Saved key: ${view.scopusKeyMasked ?? "configured"}`
                : "No key saved — Scopus search stays off until one is added"}
              help="Elsevier developer key (dev.elsevier.com). Enables the Scopus engine in Literature search; arXiv / Crossref / OpenAlex work without it."
            >
              <KeyInput
                value={scopusKey}
                placeholder={view.hasScopusKey ? "leave blank to keep, paste a new key to replace" : "paste your Elsevier API key"}
                masked={view.scopusKeyMasked}
                onChange={(value) => {
                  clearTestOnSecretChange();
                  setScopusKey(value);
                }}
              />
            </SecretPanel>

            <Row label="Config file" hint="Shared by the desktop UI and CLI">
              <input className="st-readonly-input" value={view.configPath} readOnly />
            </Row>
        </LayerSection>
      </div>

      {/* ── Save bar ── */}
      {testResult && (
        <div className={`st-test-panel${testResult.ok ? " ok" : " failed"}`}>
          <div className="st-test-summary">{testResult.message}</div>
          <div className="st-test-grid">
            <TestDetail detail={testResult.executor} />
            {testResult.reviewer && <TestDetail detail={testResult.reviewer} />}
          </div>
        </div>
      )}
      <div className="st-save-bar">
        <button
          className={`st-test-btn${testState === "testing" ? " testing" : ""}`}
          onClick={test}
          disabled={testState === "testing" || saveState === "saving"}
        >
          {testState === "testing" ? "Testing..." : "Test current settings"}
        </button>
        <button
          className={`st-save-btn${saveState === "saving" ? " saving" : ""}`}
          onClick={save}
          disabled={saveState === "saving" || testState === "testing"}
        >
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Save settings"}
        </button>
        {saveState === "saved" && (
          <span className="st-save-info">Saved. Chat will use this configuration on the next turn.</span>
        )}
        {testState === "passed" && saveState !== "saving" && saveState !== "saved" && (
          <span className="st-save-info">Current form passed. Click Save settings before using it in Chat.</span>
        )}
      </div>
    </div>
  );
}

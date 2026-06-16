import { useEffect, useRef, useState } from "react";
import {
  configGet,
  configSet,
  configTest,
  imBridgeGet,
  imBridgeLogs,
  imBridgeSet,
  imBridgeStart,
  imBridgeStop,
  imBridgeTestQq,
  isTauri,
} from "../api/tauri";
import { useStore } from "../store";
import { useProvidersStore, type ProviderEntry } from "./providersStore";
import type {
  ConfigPatch,
  ConfigTestResult,
  ConfigView,
  ImBridgePatch,
  ImBridgeTestResult,
  ImBridgeView,
} from "../types";

// ── Provider / model presets ──────────────────────────────────────────────────

interface ProviderMeta {
  label: string;
  hint: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  models?: PresetOption[];
  baseUrls?: PresetOption[];
}
interface PresetOption { label: string; value: string; hint?: string; }

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
const REVIEWER_MODELS: PresetOption[] = [
  { label: "GPT-5.5", value: "gpt-5.5", hint: "OpenAI" },
  { label: "GPT-5.4", value: "gpt-5.4", hint: "OpenAI" },
  { label: "GPT-4o", value: "gpt-4o", hint: "OpenAI" },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro", hint: "Google" },
  { label: "GLM-5", value: "GLM-5", hint: "Zhipu" },
  { label: "MiniMax M3", value: "MiniMax-M3", hint: "MiniMax" },
  { label: "MiniMax M2.7", value: "MiniMax-M2.7", hint: "MiniMax" },
  { label: "Kimi K2.5", value: "kimi-k2.5", hint: "Moonshot" },
  { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro", hint: "DeepSeek" },
  { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hint: "Anthropic-compatible" },
];
const OPENAI_COMPAT_URLS: PresetOption[] = [
  { label: "OpenAI", value: "https://api.openai.com/v1" },
  { label: "MiniMax", value: "https://api.minimaxi.com/v1" },
  { label: "Gemini", value: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { label: "GLM", value: "https://open.bigmodel.cn/api/paas/v4" },
  { label: "Kimi", value: "https://api.moonshot.cn/v1" },
  { label: "DeepSeek", value: "https://api.deepseek.com/v1" },
  { label: "Qwen", value: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { label: "Doubao", value: "https://ark.cn-beijing.volces.com/api/v3" },
  { label: "OpenRouter", value: "https://openrouter.ai/api/v1" },
];
const ANTHROPIC_URLS: PresetOption[] = [
  { label: "Official", value: "" },
  { label: "Anthropic API", value: "https://api.anthropic.com" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];
const ANTHROPIC_COMPAT_URLS: PresetOption[] = [
  { label: "Official", value: "https://api.anthropic.com" },
  { label: "MiniMax", value: "https://api.minimaxi.com/anthropic" },
  { label: "DeepSeek", value: "https://api.deepseek.com/anthropic" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];
const EXECUTOR_PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: { label: "Anthropic", hint: "Claude models via official API", defaultModel: "claude-opus-4-7", models: EXECUTOR_MODELS.filter((m) => m.hint === "Anthropic"), baseUrls: ANTHROPIC_URLS },
  "anthropic-compat": { label: "Anthropic-compat", hint: "Claude via custom base URL / proxy", defaultModel: "claude-sonnet-4-6", models: [{ label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" }, { label: "MiniMax M3", value: "MiniMax-M3" }, { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro" }], baseUrls: ANTHROPIC_COMPAT_URLS },
  openai: { label: "OpenAI-compatible", hint: "OpenAI, MiniMax, DeepSeek, Kimi…", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimaxi.com/v1", models: EXECUTOR_MODELS.filter((m) => m.hint !== "Anthropic"), baseUrls: OPENAI_COMPAT_URLS },
  custom: { label: "Custom", hint: "Any other provider", defaultModel: "", models: EXECUTOR_MODELS, baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((u) => u.value)] },
};
const REVIEWER_PROVIDERS: Record<string, ProviderMeta> = {
  "": { label: "Disabled", hint: "Use no separate review model", defaultModel: "" },
  openai: { label: "OpenAI-compatible", hint: "OpenAI or compatible reviewer API", defaultModel: "gpt-5.5", defaultBaseUrl: "https://api.openai.com/v1", models: REVIEWER_MODELS.filter((m) => ["OpenAI", "MiniMax", "Moonshot", "DeepSeek"].includes(m.hint ?? "")), baseUrls: OPENAI_COMPAT_URLS },
  gemini: { label: "Gemini", hint: "Google", defaultModel: "gemini-2.5-pro", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: REVIEWER_MODELS.filter((m) => m.hint === "Google"), baseUrls: OPENAI_COMPAT_URLS.filter((u) => u.label === "Gemini") },
  glm: { label: "GLM", hint: "Zhipu", defaultModel: "GLM-5", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", models: REVIEWER_MODELS.filter((m) => m.hint === "Zhipu"), baseUrls: OPENAI_COMPAT_URLS.filter((u) => u.label === "GLM") },
  minimax: { label: "MiniMax", hint: "MiniMax reviewer", defaultModel: "MiniMax-M2.7", defaultBaseUrl: "https://api.minimaxi.com/v1", models: REVIEWER_MODELS.filter((m) => m.hint === "MiniMax"), baseUrls: OPENAI_COMPAT_URLS.filter((u) => u.label === "MiniMax") },
  kimi: { label: "Kimi", hint: "Moonshot reviewer", defaultModel: "kimi-k2.5", defaultBaseUrl: "https://api.moonshot.cn/v1", models: REVIEWER_MODELS.filter((m) => m.hint === "Moonshot"), baseUrls: OPENAI_COMPAT_URLS.filter((u) => u.label === "Kimi") },
  deepseek: { label: "DeepSeek", hint: "DeepSeek Anthropic-compatible reviewer", defaultModel: "deepseek-v4-pro", defaultBaseUrl: "https://api.deepseek.com/anthropic", models: REVIEWER_MODELS.filter((m) => m.hint === "DeepSeek"), baseUrls: ANTHROPIC_COMPAT_URLS.filter((u) => u.label === "DeepSeek") },
  "anthropic-compat": { label: "Anthropic-compat", hint: "Claude-compatible reviewer/proxy", defaultModel: "claude-sonnet-4-6", defaultBaseUrl: "https://api.anthropic.com", models: REVIEWER_MODELS.filter((m) => ["Anthropic-compatible", "MiniMax", "DeepSeek"].includes(m.hint ?? "")), baseUrls: ANTHROPIC_COMPAT_URLS },
  custom: { label: "Custom", hint: "Manual provider and endpoint", defaultModel: "", models: REVIEWER_MODELS, baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((u) => u.value)] },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeExecutorProvider(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  const current = provider || "anthropic";
  const lower = (baseUrl ?? "").trim().toLowerCase();
  if (current === "anthropic" && (lower.includes("minimaxi.com/anthropic") || lower.includes("deepseek.com/anthropic"))) return "anthropic-compat";
  return current;
}
function normalizeReviewerProvider(provider: string | null | undefined, _baseUrl: string | null | undefined): string {
  const current = provider || "";
  if (current === "anthropic") return "anthropic-compat";
  return current in REVIEWER_PROVIDERS ? current : "custom";
}
function detectProtocol(url: string): string {
  if (!url.trim()) return "anthropic";
  const lower = url.toLowerCase();
  if (lower.includes("anthropic.com") || lower.includes("newcli.com") || lower.includes("modelscope.cn")) return "anthropic-compat";
  return "openai";
}
function extractModelFromToml(toml: string): string {
  return toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
}
function extractKeyFromAuthJson(authJson: string): string {
  try {
    const auth = JSON.parse(authJson) as Record<string, unknown>;
    const tokens = auth?.tokens as Record<string, unknown> | undefined;
    return (tokens?.access_token as string) ?? (auth?.OPENAI_API_KEY as string) ?? "";
  } catch { return ""; }
}

/** Human-readable provider name inferred from base URL */
function guessProviderName(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("minimaxi.com")) return "MiniMax";
  if (lower.includes("deepseek.com")) return "DeepSeek";
  if (lower.includes("openai.com")) return "OpenAI";
  if (lower.includes("bigmodel.cn")) return "GLM";
  if (lower.includes("moonshot.cn")) return "Kimi";
  if (lower.includes("anthropic.com")) return "Anthropic";
  if (lower.includes("dashscope.aliyuncs.com")) return "Qwen";
  if (lower.includes("volces.com")) return "Doubao";
  if (lower.includes("openrouter.ai")) return "OpenRouter";
  try { return new URL(url).hostname.split(".").slice(-2, -1)[0] ?? url; } catch { return url; }
}

/** Model suggestions based on provider URL, ordered by likelihood */
function suggestModels(url: string): string[] {
  const lower = url.toLowerCase();
  if (lower.includes("minimaxi.com")) return ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"];
  if (lower.includes("deepseek.com")) return ["deepseek-v4-pro"];
  if (lower.includes("openai.com")) return ["gpt-5.5", "gpt-5.4", "gpt-4o"];
  if (lower.includes("bigmodel.cn")) return ["GLM-5", "GLM-5-Turbo"];
  if (lower.includes("moonshot.cn")) return ["kimi-k2.5"];
  if (lower.includes("anthropic.com") || lower.includes("newcli.com") || lower.includes("modelscope.cn")) return ["claude-opus-4-7", "claude-sonnet-4-6"];
  if (lower.includes("dashscope.aliyuncs.com")) return ["qwen3.6-plus"];
  if (lower.includes("volces.com")) return ["doubao-pro-4k"];
  if (lower.includes("openrouter.ai")) return ["anthropic/claude-sonnet-4-6"];
  return [];
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KeyInput({ value, placeholder, masked, onChange }: { value: string; placeholder: string; masked: string | null | undefined; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="st-key-wrap" data-has-saved-secret={Boolean(masked)}>
      <input type={show ? "text" : "password"} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="st-key-input" spellCheck={false} />
      <button className="st-key-eye" onClick={() => setShow((v) => !v)} type="button">{show ? "Hide" : "Show"}</button>
    </div>
  );
}

function PresetTextInput({ value, placeholder, options, onChange }: { value: string; placeholder: string; options: PresetOption[]; onChange: (v: string) => void }) {
  const currentPreset = options.find((o) => o.value === value)?.value ?? "__custom";
  return (
    <div className="st-preset-control">
      <select value={currentPreset} onChange={(e) => { if (e.target.value === "__custom") { onChange(""); return; } onChange(e.target.value); }}>
        <option value="__custom">Custom / manual</option>
        {options.map((o) => <option key={`${o.label}:${o.value || "blank"}`} value={o.value}>{o.label}{o.hint ? ` · ${o.hint}` : ""}</option>)}
      </select>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

function TestDetail({ detail }: { detail: ConfigTestResult["executor"] }) {
  return (
    <div className={`st-test-detail${detail.ok ? " ok" : " failed"}`}>
      <div className="st-test-detail-head">
        <span className="st-test-dot" /><span className="st-test-label">{detail.label}</span>
        {detail.model && <span className="st-test-meta">{detail.model}</span>}
      </div>
      <div className="st-test-message">{detail.message}</div>
      {detail.baseUrl && <div className="st-test-url">{detail.baseUrl}</div>}
    </div>
  );
}

// ── Provider card with inline role assignment ─────────────────────────────────

function ProviderCard({
  provider, isExecutor, isReviewer, onEdit, onDelete,
  onApplyRole,
}: {
  provider: ProviderEntry;
  isExecutor: boolean;
  isReviewer: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onApplyRole: (role: "exec" | "review", model: string) => Promise<void>;
}) {
  const letter = provider.name.trim()[0]?.toUpperCase() ?? "?";
  const [expandedRole, setExpandedRole] = useState<"exec" | "review" | null>(null);
  const suggestions = suggestModels(provider.url);
  const defaultModel = extractModelFromToml(provider.configToml) || suggestions[0] || "";
  const [model, setModel] = useState(defaultModel);
  const [applying, setApplying] = useState(false);

  const toggleRole = (role: "exec" | "review", e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedRole((r) => {
      if (r === role) return null;
      // reset model suggestion when switching role
      setModel(defaultModel);
      return role;
    });
  };

  const handleApply = async () => {
    if (!model.trim()) return;
    setApplying(true);
    try {
      await onApplyRole(expandedRole!, model.trim());
      setExpandedRole(null);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="sp-card-wrap">
      <div className={`sp-card${expandedRole ? " sp-card-expanded" : ""}`}>
        <div className="sp-card-click-zone" role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => e.key === "Enter" && onEdit()}>
          <div className="sp-card-icon" aria-hidden="true">{letter}</div>
          <div className="sp-card-body">
            <div className="sp-card-name">
              {provider.name}
              {isExecutor && <span className="sp-role-badge sp-role-exec">执行器</span>}
              {isReviewer && <span className="sp-role-badge sp-role-review">审阅</span>}
            </div>
            {provider.url && <div className="sp-card-url">{provider.url}</div>}
            {provider.notes && <div className="sp-card-notes">{provider.notes}</div>}
          </div>
        </div>
        <div className="sp-card-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className={`sp-role-quick-btn${expandedRole === "exec" ? " active" : ""}`}
            title="设为执行器"
            type="button"
            onClick={(e) => toggleRole("exec", e)}
          >执</button>
          <button
            className={`sp-role-quick-btn${expandedRole === "review" ? " active" : ""}`}
            title="设为审阅"
            type="button"
            onClick={(e) => toggleRole("review", e)}
          >审</button>
          <button className="sp-card-btn" title="编辑" type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }}>✎</button>
          <button className="sp-card-btn sp-card-btn-danger" title="删除" type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }}>✕</button>
        </div>
      </div>

      {expandedRole !== null && (
        <div className="sp-inline-apply">
          <span className="sp-inline-apply-label">
            {expandedRole === "exec" ? "设为执行器" : "设为审阅"} · {provider.name}
          </span>
          <div className="sp-inline-apply-fields">
            {suggestions.length > 0 ? (
              <select
                className="sp-inline-select"
                value={suggestions.includes(model) ? model : "__custom"}
                onChange={(e) => { if (e.target.value !== "__custom") setModel(e.target.value); }}
              >
                {suggestions.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom">自定义…</option>
              </select>
            ) : null}
            <input
              className="sp-inline-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="模型 ID"
              spellCheck={false}
            />
            <button
              className="sp-inline-confirm"
              disabled={!model.trim() || applying}
              onClick={() => void handleApply()}
              type="button"
            >{applying ? "应用中…" : "确认"}</button>
            <button
              className="sp-inline-cancel"
              onClick={() => setExpandedRole(null)}
              type="button"
            >取消</button>
          </div>
          <div className="sp-inline-apply-hint">已保存的 API Key 自动沿用，无需重新输入。</div>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "passed" | "failed";
type BridgeBusy = "saving" | "testing" | "starting" | "stopping" | "logs" | null;
type BridgeNotice = { ok: boolean; message: string; output?: string | null };

export default function Settings() {
  const setError = useStore((s) => s.setError);
  const [configView, setConfigView] = useState<ConfigView | null>(null);
  const [advForm, setAdvForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [reviewerKey, setReviewerKey] = useState("");
  const [scopusKey, setScopusKey] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [bridgeView, setBridgeView] = useState<ImBridgeView | null>(null);
  const [bridgeForm, setBridgeForm] = useState<ImBridgePatch>({});
  const [bridgeSecret, setBridgeSecret] = useState("");
  const [bridgeBusy, setBridgeBusy] = useState<BridgeBusy>(null);
  const [bridgeNotice, setBridgeNotice] = useState<BridgeNotice | null>(null);
  const [showBridgeLog, setShowBridgeLog] = useState(false);
  const operationVersion = useRef(0);
  const activeOp = useRef<{ kind: "save" | "test"; version: number } | null>(null);
  const savedTimer = useRef<number | null>(null);
  const didAutoPopulate = useRef(false);

  const { providers, executorProviderId, reviewerProviderId, setExecutor, setReviewer, add, update, remove } = useProvidersStore();

  // Detail view: null = list, "new" = new provider, string = editing provider id
  const [detailId, setDetailId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Partial<ProviderEntry>>({});
  const [detailApiKey, setDetailApiKey] = useState("");
  const [showDetailKey, setShowDetailKey] = useState(false);
  const [detailApplying, setDetailApplying] = useState<"exec" | "review" | null>(null);
  const [formatError, setFormatError] = useState("");

  const loadConfig = (v: ConfigView) => {
    setConfigView(v);
    setAdvForm({
      executorProvider: normalizeExecutorProvider(v.executorProvider, v.executorBaseUrl),
      executorModel: v.executorModel ?? "",
      executorBaseUrl: v.executorBaseUrl ?? "",
      reviewerProvider: normalizeReviewerProvider(v.reviewerProvider, v.reviewerBaseUrl),
      reviewerModel: v.reviewerModel ?? "",
      reviewerBaseUrl: v.reviewerBaseUrl ?? "",
      language: v.language ?? "cn",
      memoryWriteApproval: v.memoryWriteApproval,
    });
    setExecKey(""); setReviewerKey(""); setScopusKey("");
  };

  const loadBridge = (v: ImBridgeView) => {
    setBridgeView(v);
    setBridgeForm({
      enabled: v.enabled,
      runtime: "aris",
      defaultWorkdir: v.defaultWorkdir,
      arisPath: v.arisPath,
      qqAppId: v.qqAppId,
      qqAllowedUsers: v.qqAllowedUsers,
      qqImageEnabled: v.qqImageEnabled,
      qqMaxImageSize: v.qqMaxImageSize,
      autoApprove: v.autoApprove,
    });
    setBridgeSecret("");
  };

  useEffect(() => {
    if (!isTauri()) return;
    configGet().then(loadConfig).catch((e) => setError(String(e)));
    imBridgeGet().then(loadBridge).catch((e) => setError(String(e)));
  }, [setError]);
  useEffect(() => () => {
    operationVersion.current += 1;
    activeOp.current = null;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  // Auto-populate provider list from backend config the first time Settings opens.
  // This means users who already have MiniMax / DeepSeek keys saved will immediately
  // see their providers in the list without needing to re-enter anything.
  useEffect(() => {
    if (!configView || didAutoPopulate.current) return;
    didAutoPopulate.current = true;
    if (providers.length > 0) return; // user already has a list — don't touch it

    const execUrl = configView.executorBaseUrl?.trim() ?? "";
    const reviewUrl = configView.reviewerBaseUrl?.trim() ?? "";
    if (!execUrl && !reviewUrl) return;

    let execId: string | null = null;
    let reviewId: string | null = null;

    if (configView.hasExecutorKey && execUrl) {
      const toml = configView.executorModel ? `model = "${configView.executorModel}"` : "";
      execId = add({ name: guessProviderName(execUrl), url: execUrl, notes: "", authJson: "", configToml: toml });
    }

    if (configView.hasReviewerKey && reviewUrl) {
      if (reviewUrl === execUrl && execId) {
        reviewId = execId;
      } else {
        const toml = configView.reviewerModel ? `model = "${configView.reviewerModel}"` : "";
        reviewId = add({ name: guessProviderName(reviewUrl), url: reviewUrl, notes: "", authJson: "", configToml: toml });
      }
    }

    if (execId) setExecutor(execId, configView.executorModel ?? "");
    if (reviewId) setReviewer(reviewId, configView.reviewerModel ?? "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configView]);

  const resetOpState = () => {
    operationVersion.current += 1; activeOp.current = null;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("idle"); setTestState("idle"); setTestResult(null);
  };

  const buildAdvPatch = () => {
    const patch: ConfigPatch = { ...advForm };
    if (execKey.trim()) patch.executorApiKey = execKey.trim();
    if (reviewerKey.trim()) patch.reviewerApiKey = reviewerKey.trim();
    if (scopusKey.trim()) patch.scopusApiKey = scopusKey.trim();
    return patch;
  };

  const updateBridgeForm = (patch: ImBridgePatch) => {
    setBridgeNotice(null);
    setBridgeForm((current) => ({ ...current, ...patch }));
  };

  const buildBridgePatch = () => {
    const patch: ImBridgePatch = { ...bridgeForm, runtime: "aris" };
    if (bridgeSecret.trim()) patch.qqAppSecret = bridgeSecret.trim();
    return patch;
  };

  const saveBridge = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("saving");
    setBridgeNotice(null);
    try {
      const next = await imBridgeSet(buildBridgePatch());
      loadBridge(next);
      setBridgeNotice({ ok: true, message: "Aris QQ Bot settings saved." });
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const testBridge = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("testing");
    setBridgeNotice(null);
    try {
      const result: ImBridgeTestResult = await imBridgeTestQq(buildBridgePatch());
      setBridgeNotice({ ok: result.ok, message: result.message });
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const startBridge = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("starting");
    setBridgeNotice(null);
    try {
      const saved = await imBridgeSet(buildBridgePatch());
      loadBridge(saved);
      const result = await imBridgeStart();
      loadBridge(result.view);
      setBridgeNotice({ ok: result.ok, message: result.message, output: result.output || result.view.statusMessage });
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const stopBridge = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("stopping");
    setBridgeNotice(null);
    try {
      const result = await imBridgeStop();
      loadBridge(result.view);
      setBridgeNotice({ ok: result.ok, message: result.message, output: result.output || result.view.statusMessage });
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const loadBridgeLogs = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("logs");
    setBridgeNotice(null);
    try {
      const result = await imBridgeLogs();
      loadBridge(result.view);
      setShowBridgeLog(true);
      setBridgeNotice({ ok: result.ok, message: result.message, output: result.output });
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const refreshBridge = async () => {
    if (bridgeBusy) return;
    setBridgeBusy("logs");
    setBridgeNotice(null);
    try {
      loadBridge(await imBridgeGet());
    } catch (e) {
      setError(String(e));
      setBridgeNotice({ ok: false, message: String(e) });
    } finally {
      setBridgeBusy(null);
    }
  };

  const save = async () => {
    if (activeOp.current) return;
    const version = ++operationVersion.current;
    activeOp.current = { kind: "save", version };
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("saving"); setTestState("idle"); setTestResult(null);
    try {
      const next = await configSet(buildAdvPatch());
      if (version !== operationVersion.current) return;
      loadConfig(next); setSaveState("saved");
      savedTimer.current = window.setTimeout(() => { if (version === operationVersion.current) setSaveState("idle"); }, 3000);
    } catch (e) {
      if (version !== operationVersion.current) return;
      setError(String(e)); setSaveState("error");
    } finally {
      if (activeOp.current?.version === version) activeOp.current = null;
    }
  };

  const test = async () => {
    if (activeOp.current) return;
    const version = ++operationVersion.current;
    activeOp.current = { kind: "test", version };
    setTestState("testing"); setTestResult(null);
    try {
      const result = await configTest(buildAdvPatch());
      if (version !== operationVersion.current) return;
      setTestResult(result); setTestState(result.ok ? "passed" : "failed");
    } catch (e) {
      if (version !== operationVersion.current) return;
      const message = String(e);
      setTestResult({ ok: false, message, executor: { ok: false, label: "Settings", message } });
      setTestState("failed");
    } finally {
      if (activeOp.current?.version === version) activeOp.current = null;
    }
  };

  // Apply from provider card — NO api key sent, backend keeps saved key
  const applyFromCard = async (provider: ProviderEntry, role: "exec" | "review", model: string) => {
    const url = provider.url.trim();
    const protocol = detectProtocol(url);
    const patch: ConfigPatch = role === "exec"
      ? { executorProvider: protocol, executorModel: model, executorBaseUrl: url }
      : { reviewerProvider: protocol, reviewerModel: model, reviewerBaseUrl: url };
    try {
      const next = await configSet(patch);
      loadConfig(next);
      if (role === "exec") setExecutor(provider.id, model);
      else setReviewer(provider.id, model);
    } catch (e) { setError(String(e)); }
  };

  // ── Detail view ─────────────────────────────────────────────────────────────

  const openDetail = (id: string | "new") => {
    if (id === "new") setForm({ name: "", url: "", notes: "", authJson: "", configToml: "" });
    else { const p = providers.find((pr) => pr.id === id); if (p) setForm({ ...p }); }
    setDetailId(id); setDetailApiKey(""); setShowDetailKey(false); setFormatError("");
  };
  const closeDetail = () => { setDetailId(null); setForm({}); };

  const saveDetail = () => {
    if (!form.name?.trim()) return;
    if (detailId === "new") add({ name: form.name.trim(), url: form.url?.trim() ?? "", notes: form.notes?.trim() ?? "", authJson: form.authJson ?? "", configToml: form.configToml ?? "" });
    else if (detailId) update(detailId, { name: form.name.trim(), url: form.url?.trim() ?? "", notes: form.notes?.trim() ?? "", authJson: form.authJson ?? "", configToml: form.configToml ?? "" });
    closeDetail();
  };

  const applyDetailRole = async (role: "exec" | "review") => {
    setDetailApplying(role);
    try {
      const url = form.url?.trim() ?? "";
      const protocol = detectProtocol(url);
      let key = detailApiKey.trim();
      if (!key && form.authJson?.trim()) key = extractKeyFromAuthJson(form.authJson);
      const model = extractModelFromToml(form.configToml ?? "") || (role === "exec" ? (configView?.executorModel ?? "") : (configView?.reviewerModel ?? ""));
      const patch: ConfigPatch = role === "exec"
        ? { executorProvider: protocol, executorModel: model, executorBaseUrl: url, ...(key ? { executorApiKey: key } : {}) }
        : { reviewerProvider: protocol, reviewerModel: model, reviewerBaseUrl: url, ...(key ? { reviewerApiKey: key } : {}) };
      const next = await configSet(patch);
      loadConfig(next);
      const pid = detailId !== "new" && detailId ? detailId : null;
      if (role === "exec") setExecutor(pid, model); else setReviewer(pid, model);
    } catch (e) { setError(String(e)); }
    finally { setDetailApplying(null); }
  };

  const formatJson = () => {
    setFormatError("");
    try { setForm((f) => ({ ...f, authJson: JSON.stringify(JSON.parse(f.authJson ?? "") as unknown, null, 2) })); }
    catch { setFormatError("无效 JSON，请检查格式"); }
  };

  // ── Non-Tauri placeholder ───────────────────────────────────────────────────
  if (!isTauri()) return <div className="board"><div className="empty">Settings need the Tauri backend.</div></div>;

  // ── Detail view ─────────────────────────────────────────────────────────────
  if (detailId !== null) {
    const isNew = detailId === "new";
    const isExec = !isNew && detailId === executorProviderId;
    const isReview = !isNew && detailId === reviewerProviderId;
    return (
      <div className="st-page sp-detail-page">
        <div className="sp-detail-head">
          <button className="sp-back-btn" onClick={closeDetail} type="button">← 返回</button>
          <div className="sp-detail-title">{isNew ? "添加供应商" : (form.name || "编辑供应商")}</div>
          <div className="sp-detail-badges">
            {isExec && <span className="sp-role-badge sp-role-exec">执行器</span>}
            {isReview && <span className="sp-role-badge sp-role-review">审阅</span>}
          </div>
        </div>
        <div className="sp-detail-form">
          <div className="sp-detail-row2">
            <div className="sp-field">
              <label className="sp-field-label">供应商名称 *</label>
              <input className="sp-input" value={form.name ?? ""} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="例如：DeepSeek" />
            </div>
            <div className="sp-field">
              <label className="sp-field-label">备注</label>
              <input className="sp-input" value={form.notes ?? ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="例如：公司账号" />
            </div>
          </div>
          <div className="sp-field">
            <label className="sp-field-label">官网链接 / Base URL</label>
            <input className="sp-input" value={form.url ?? ""} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
          </div>
          <div className="sp-field">
            <label className="sp-field-label">API Key（本次会话，不持久化）</label>
            <div className="sp-key-wrap">
              <input type={showDetailKey ? "text" : "password"} className="sp-input sp-key-input" value={detailApiKey} onChange={(e) => setDetailApiKey(e.target.value)} placeholder="首次配置时粘贴 Key；已有 Key 则留空直接应用" spellCheck={false} />
              <button className="sp-key-eye" type="button" onClick={() => setShowDetailKey((v) => !v)}>{showDetailKey ? "隐藏" : "显示"}</button>
            </div>
          </div>
          <div className="sp-field">
            <div className="sp-field-head">
              <label className="sp-field-label">auth.json（JSON）</label>
              <div className="sp-field-head-right">
                {formatError && <span className="sp-format-err">{formatError}</span>}
                <button className="sp-format-btn" type="button" onClick={formatJson}>格式化</button>
              </div>
            </div>
            <textarea className="sp-code-editor" value={form.authJson ?? ""} onChange={(e) => setForm((f) => ({ ...f, authJson: e.target.value }))} placeholder={'{\n  "OPENAI_API_KEY": null,\n  "auth_mode": "chatgpt",\n  "tokens": {}\n}'} spellCheck={false} rows={10} />
            <div className="sp-field-hint">Codex auth.json — access_token 可作为 API Key 自动提取</div>
          </div>
          <div className="sp-field">
            <label className="sp-field-label">config.toml（TOML）</label>
            <textarea className="sp-code-editor" value={form.configToml ?? ""} onChange={(e) => setForm((f) => ({ ...f, configToml: e.target.value }))} placeholder={'model = "deepseek-v4-pro"\nmodel_reasoning_effort = "xhigh"'} spellCheck={false} rows={6} />
            <div className="sp-field-hint">model 字段将在应用为执行器/审阅时自动读取</div>
          </div>
          <div className="sp-detail-actions">
            <button className="sp-btn sp-btn-primary" onClick={saveDetail} disabled={!form.name?.trim()} type="button">保存到列表</button>
            {!isNew && (
              <>
                <button className={`sp-btn sp-btn-exec${detailApplying === "exec" ? " loading" : ""}`} disabled={detailApplying !== null} onClick={() => void applyDetailRole("exec")} type="button">{detailApplying === "exec" ? "应用中…" : "设为执行器"}</button>
                <button className={`sp-btn sp-btn-review${detailApplying === "review" ? " loading" : ""}`} disabled={detailApplying !== null} onClick={() => void applyDetailRole("review")} type="button">{detailApplying === "review" ? "应用中…" : "设为审阅"}</button>
                <button className="sp-btn sp-btn-danger" onClick={() => { remove(detailId); closeDetail(); }} type="button">删除</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── List view ───────────────────────────────────────────────────────────────
  if (!configView) return <div className="board"><div className="empty">Loading…</div></div>;

  const advExecProvider = advForm.executorProvider ?? "anthropic";
  const advExecMeta = EXECUTOR_PROVIDERS[advExecProvider] ?? EXECUTOR_PROVIDERS.custom;
  const advReviewerProvider = advForm.reviewerProvider ?? "";
  const advReviewerMeta = REVIEWER_PROVIDERS[advReviewerProvider] ?? REVIEWER_PROVIDERS.custom;

  const chooseExecProvider = (prov: string) => {
    const meta = EXECUTOR_PROVIDERS[prov] ?? EXECUTOR_PROVIDERS.custom;
    resetOpState();
    setAdvForm((f) => ({ ...f, executorProvider: prov, executorModel: prov === "custom" ? (f.executorModel ?? "") : meta.defaultModel, executorBaseUrl: prov === "custom" ? (f.executorBaseUrl ?? "") : (meta.defaultBaseUrl ?? meta.baseUrls?.[0]?.value ?? "") }));
  };
  const chooseReviewerProvider = (prov: string) => {
    const meta = REVIEWER_PROVIDERS[prov] ?? REVIEWER_PROVIDERS.custom;
    resetOpState();
    if (!prov) { setAdvForm((f) => ({ ...f, reviewerProvider: "", reviewerModel: "", reviewerBaseUrl: "" })); return; }
    setAdvForm((f) => ({ ...f, reviewerProvider: prov, reviewerModel: prov === "custom" ? (f.reviewerModel ?? "") : meta.defaultModel, reviewerBaseUrl: prov === "custom" ? (f.reviewerBaseUrl ?? "") : (meta.defaultBaseUrl ?? meta.baseUrls?.[0]?.value ?? "") }));
  };
  const bridgeRunning = bridgeView?.running ?? false;
  const bridgeEnabled = bridgeForm.enabled ?? bridgeView?.enabled ?? true;
  const bridgeBusyLabel = bridgeBusy === "saving"
    ? "Saving..."
    : bridgeBusy === "testing"
      ? "Testing..."
      : bridgeBusy === "starting"
        ? "Starting..."
        : bridgeBusy === "stopping"
          ? "Stopping..."
          : bridgeBusy === "logs"
            ? "Loading..."
            : null;

  return (
    <div className="st-page sp-list-page">
      {/* Status bar */}
      <div className="sp-status-bar">
        <div className="sp-status-slot">
          <span className="sp-status-tag sp-status-tag-exec">执行器</span>
          {configView.executorModel
            ? <><span className="sp-status-model">{configView.executorModel}</span>{configView.executorBaseUrl && <span className="sp-status-url"> · {configView.executorBaseUrl}</span>}{configView.hasExecutorKey && <span className="sp-status-key"> ●</span>}</>
            : <span className="sp-status-empty">未配置</span>}
        </div>
        <div className="sp-status-sep" />
        <div className="sp-status-slot">
          <span className="sp-status-tag sp-status-tag-review">审阅</span>
          {configView.reviewerModel
            ? <><span className="sp-status-model">{configView.reviewerModel}</span>{configView.reviewerBaseUrl && <span className="sp-status-url"> · {configView.reviewerBaseUrl}</span>}{configView.hasReviewerKey && <span className="sp-status-key"> ●</span>}</>
            : <span className="sp-status-empty">未配置</span>}
        </div>
      </div>

      {/* Provider list */}
      <div className="sp-providers-section">
        <div className="sp-section-head">
          <div className="sp-section-title">供应商</div>
          <button className="sp-add-btn" onClick={() => openDetail("new")} type="button">+ 添加</button>
        </div>
        <div className="sp-card-list">
          {providers.length === 0
            ? <div className="sp-empty-list">暂无供应商。点击「+ 添加」新建，或展开下方「高级配置」手动填写。</div>
            : [...providers].sort((a, b) => a.order - b.order).map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  isExecutor={executorProviderId === p.id}
                  isReviewer={reviewerProviderId === p.id}
                  onEdit={() => openDetail(p.id)}
                  onDelete={() => remove(p.id)}
                  onApplyRole={(role, model) => applyFromCard(p, role, model)}
                />
              ))}
        </div>
      </div>

      {/* Aris QQ Bot bridge */}
      <div className="sp-bridge-section">
        <div className="sp-section-head">
          <div>
            <div className="sp-section-title">Aris QQ Bot</div>
            <div className="sp-section-sub">QQ private chat bridge that sends messages to Aris in this workspace.</div>
          </div>
          <div className={`sp-bridge-status${bridgeRunning ? " running" : ""}`}>
            <span className="sp-bridge-dot" />
            <span>{bridgeRunning ? `Running${bridgeView?.pid ? ` · ${bridgeView.pid}` : ""}` : (bridgeView?.statusMessage ?? "Not loaded")}</span>
          </div>
        </div>
        <div className="sp-bridge-body">
          <div className="sp-bridge-grid">
            <div className="st-row">
              <div className="st-row-label"><span className="st-label">Channel</span></div>
              <div className="st-row-control">
                <button
                  type="button"
                  className={`st-lang-card sp-bridge-toggle${bridgeEnabled ? " active" : ""}`}
                  onClick={() => updateBridgeForm({ enabled: !bridgeEnabled })}
                >
                  <span className="st-lang-label">{bridgeEnabled ? "QQ enabled" : "QQ disabled"}</span>
                  <span className="st-lang-sub">C2C private chat</span>
                </button>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label">
                <span className="st-label">Aris executable</span>
                <span className="st-hint">Auto-detected if left blank</span>
              </div>
              <div className="st-row-control">
                <input
                  value={bridgeForm.arisPath ?? ""}
                  onChange={(e) => updateBridgeForm({ arisPath: e.currentTarget.value, runtime: "aris" })}
                  placeholder="target/debug/aris.exe or aris in PATH"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label"><span className="st-label">Workdir</span></div>
              <div className="st-row-control">
                <input
                  value={bridgeForm.defaultWorkdir ?? ""}
                  onChange={(e) => updateBridgeForm({ defaultWorkdir: e.currentTarget.value })}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label"><span className="st-label">QQ App ID</span></div>
              <div className="st-row-control">
                <input
                  value={bridgeForm.qqAppId ?? ""}
                  onChange={(e) => updateBridgeForm({ qqAppId: e.currentTarget.value })}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label">
                <span className="st-label">QQ App Secret</span>
                <span className="st-hint">{bridgeView?.hasQqAppSecret ? `Saved: ${bridgeView.qqAppSecretMasked ?? "configured"}` : "No secret"}</span>
              </div>
              <div className="st-row-control">
                <KeyInput
                  value={bridgeSecret}
                  placeholder={bridgeView?.hasQqAppSecret ? "leave blank to keep" : "paste App Secret"}
                  masked={bridgeView?.qqAppSecretMasked}
                  onChange={(value) => { setBridgeNotice(null); setBridgeSecret(value); }}
                />
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label">
                <span className="st-label">Allowed OpenIDs</span>
                <span className="st-hint">Comma-separated user_openid values</span>
              </div>
              <div className="st-row-control">
                <input
                  value={bridgeForm.qqAllowedUsers ?? ""}
                  onChange={(e) => updateBridgeForm({ qqAllowedUsers: e.currentTarget.value })}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label"><span className="st-label">Images</span></div>
              <div className="st-row-control sp-bridge-inline">
                <button
                  type="button"
                  className={`st-lang-card sp-bridge-toggle${(bridgeForm.qqImageEnabled ?? true) ? " active" : ""}`}
                  onClick={() => updateBridgeForm({ qqImageEnabled: !(bridgeForm.qqImageEnabled ?? true) })}
                >
                  <span className="st-lang-label">{(bridgeForm.qqImageEnabled ?? true) ? "Enabled" : "Disabled"}</span>
                </button>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={bridgeForm.qqMaxImageSize ?? 20}
                  onChange={(e) => updateBridgeForm({ qqMaxImageSize: Math.max(1, Number(e.currentTarget.value) || 1) })}
                  aria-label="QQ max image size MB"
                />
                <span className="sp-bridge-unit">MB</span>
              </div>
            </div>
            <div className="st-row">
              <div className="st-row-label"><span className="st-label">Tool permission</span></div>
              <div className="st-row-control">
                <button
                  type="button"
                  className={`st-lang-card sp-bridge-toggle${bridgeForm.autoApprove ? " active danger" : ""}`}
                  onClick={() => updateBridgeForm({ autoApprove: !bridgeForm.autoApprove })}
                >
                  <span className="st-lang-label">{bridgeForm.autoApprove ? "Full access" : "Workspace write"}</span>
                  <span className="st-lang-sub">{bridgeForm.autoApprove ? "Trusted chats only" : "Read and edit project files"}</span>
                </button>
              </div>
            </div>
          </div>
          <div className="sp-bridge-paths">
            <label>
              <span>Config</span>
              <input className="st-readonly-input" value={bridgeView?.configPath ?? ""} readOnly />
            </label>
            <label>
              <span>Bridge</span>
              <input className="st-readonly-input" value={bridgeView?.skillDir ?? "Not found"} readOnly />
            </label>
          </div>
          {bridgeNotice && (
            <div className={`sp-bridge-notice${bridgeNotice.ok ? " ok" : " failed"}`}>
              <strong>{bridgeNotice.message}</strong>
              {bridgeNotice.output && <pre>{bridgeNotice.output}</pre>}
            </div>
          )}
          {!bridgeNotice && showBridgeLog && bridgeView?.recentLog && (
            <div className="sp-bridge-notice ok"><pre>{bridgeView.recentLog}</pre></div>
          )}
          <div className="sp-bridge-actions">
            <button className="st-test-btn" type="button" onClick={() => void testBridge()} disabled={Boolean(bridgeBusy)}>
              {bridgeBusy === "testing" ? "Testing..." : "Test QQ"}
            </button>
            <button className="st-save-btn" type="button" onClick={() => void saveBridge()} disabled={Boolean(bridgeBusy)}>
              {bridgeBusy === "saving" ? "Saving..." : "Save Aris QQ Bot"}
            </button>
            <button className="st-save-btn sp-bridge-start" type="button" onClick={() => void startBridge()} disabled={Boolean(bridgeBusy) || !bridgeEnabled}>
              {bridgeBusy === "starting" ? "Starting..." : "Start"}
            </button>
            <button className="st-test-btn" type="button" onClick={() => void stopBridge()} disabled={Boolean(bridgeBusy) || !bridgeRunning}>
              {bridgeBusy === "stopping" ? "Stopping..." : "Stop"}
            </button>
            <button className="st-test-btn" type="button" onClick={() => void loadBridgeLogs()} disabled={Boolean(bridgeBusy)}>
              {bridgeBusy === "logs" ? "Loading..." : "Logs"}
            </button>
            <button className="st-test-btn" type="button" onClick={() => void refreshBridge()} disabled={Boolean(bridgeBusy)}>
              {bridgeBusyLabel ?? "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Advanced (collapsible) */}
      <div className="sp-advanced-wrap">
        <button className="sp-advanced-toggle" type="button" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
          <span>{showAdvanced ? "▾" : "▸"} 高级配置</span>
          <span className="sp-advanced-toggle-hint">手动设置执行器 / 审阅 / Scopus / 语言 · 首次接入新供应商时在这里输入 API Key</span>
        </button>
        {showAdvanced && (
          <div className="sp-advanced-body">
            <div className="sp-adv-section">
              <div className="sp-adv-section-title">执行器（高级）</div>
              <div className="sp-field-group">
                <div className="st-field-label">Provider 类型</div>
                <div className="st-provider-grid">
                  {Object.entries(EXECUTOR_PROVIDERS).map(([key, meta]) => (
                    <button key={key} type="button" className={`st-provider-card${advExecProvider === key ? " active" : ""}`} onClick={() => chooseExecProvider(key)}>
                      <span className="st-provider-label">{meta.label}</span>
                      <span className="st-provider-hint">{meta.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="sp-adv-rows">
                <div className="st-row"><div className="st-row-label"><span className="st-label">Model</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorModel ?? ""} placeholder={EXECUTOR_PROVIDERS[advExecProvider]?.defaultModel || "e.g. claude-sonnet-4-6"} options={advExecMeta.models ?? EXECUTOR_MODELS} onChange={(v) => { resetOpState(); setAdvForm((f) => ({ ...f, executorModel: v })); }} /></div></div>
                <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorBaseUrl ?? ""} placeholder={EXECUTOR_PROVIDERS[advExecProvider]?.defaultBaseUrl || "(official default)"} options={advExecMeta.baseUrls ?? OPENAI_COMPAT_URLS} onChange={(v) => { resetOpState(); setAdvForm((f) => ({ ...f, executorBaseUrl: v })); }} /></div></div>
                <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasExecutorKey ? `Saved: ${configView.executorKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={execKey} placeholder={configView.hasExecutorKey ? "leave blank to keep" : "paste API key"} masked={configView.executorKeyMasked} onChange={(v) => { resetOpState(); setExecKey(v); }} /></div></div>
                <div className="st-row"><div className="st-row-label"><span className="st-label">Memory writes</span></div><div className="st-row-control"><button type="button" className={`st-lang-card${advForm.memoryWriteApproval ? " active" : ""}`} onClick={() => { resetOpState(); setAdvForm((f) => ({ ...f, memoryWriteApproval: !f.memoryWriteApproval })); }}><span className="st-lang-label">{advForm.memoryWriteApproval ? "Approval required" : "Automatic writes allowed"}</span></button></div></div>
              </div>
            </div>
            <div className="sp-adv-section">
              <div className="sp-adv-section-title">审阅（高级）</div>
              <div className="sp-field-group">
                <div className="st-field-label">Provider 类型</div>
                <div className="st-provider-grid">
                  {Object.entries(REVIEWER_PROVIDERS).map(([key, meta]) => (
                    <button key={key} type="button" className={`st-provider-card${advReviewerProvider === key ? " active" : ""}`} onClick={() => chooseReviewerProvider(key)}>
                      <span className="st-provider-label">{meta.label}</span>
                      <span className="st-provider-hint">{meta.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              {advReviewerProvider !== "" && (
                <div className="sp-adv-rows">
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Model</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerModel ?? ""} placeholder={advReviewerMeta.defaultModel || "e.g. gpt-5.5"} options={advReviewerMeta.models ?? REVIEWER_MODELS} onChange={(v) => { resetOpState(); setAdvForm((f) => ({ ...f, reviewerModel: v })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerBaseUrl ?? ""} placeholder={advReviewerMeta.defaultBaseUrl || "(provider default)"} options={advReviewerMeta.baseUrls ?? OPENAI_COMPAT_URLS} onChange={(v) => { resetOpState(); setAdvForm((f) => ({ ...f, reviewerBaseUrl: v })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasReviewerKey ? `Saved: ${configView.reviewerKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={reviewerKey} placeholder={configView.hasReviewerKey ? "leave blank to keep" : "paste reviewer key"} masked={configView.reviewerKeyMasked} onChange={(v) => { resetOpState(); setReviewerKey(v); }} /></div></div>
                </div>
              )}
            </div>
            <div className="sp-adv-section">
              <div className="sp-adv-section-title">其他</div>
              <div className="sp-adv-rows">
                <div className="st-row"><div className="st-row-label"><span className="st-label">语言</span></div><div className="st-row-control"><div className="st-lang-grid">{[{ value: "cn", label: "中文" }, { value: "en", label: "English" }].map((l) => <button key={l.value} type="button" className={`st-lang-card${advForm.language === l.value ? " active" : ""}`} onClick={() => { resetOpState(); setAdvForm((f) => ({ ...f, language: l.value })); }}><span className="st-lang-label">{l.label}</span></button>)}</div></div></div>
                <div className="st-row"><div className="st-row-label"><span className="st-label">Scopus Key</span><span className="st-hint">{configView.hasScopusKey ? `Saved: ${configView.scopusKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={scopusKey} placeholder={configView.hasScopusKey ? "leave blank to keep" : "paste Elsevier key"} masked={configView.scopusKeyMasked} onChange={(v) => { resetOpState(); setScopusKey(v); }} /></div></div>
                <div className="st-row"><div className="st-row-label"><span className="st-label">Config file</span></div><div className="st-row-control"><input className="st-readonly-input" value={configView.configPath} readOnly /></div></div>
              </div>
            </div>
          </div>
        )}
      </div>

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
        <button className={`st-test-btn${testState === "testing" ? " testing" : ""}`} onClick={test} disabled={testState === "testing" || saveState === "saving"} type="button">
          {testState === "testing" ? "Testing…" : "Test current settings"}
        </button>
        <button className={`st-save-btn${saveState === "saving" ? " saving" : ""}`} onClick={save} disabled={saveState === "saving" || testState === "testing"} type="button">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save settings"}
        </button>
        {saveState === "saved" && <span className="st-save-info">已保存。下一次对话时生效。</span>}
        {testState === "passed" && saveState !== "saving" && saveState !== "saved" && <span className="st-save-info">测试通过，请点击「Save settings」使配置生效。</span>}
      </div>
    </div>
  );
}

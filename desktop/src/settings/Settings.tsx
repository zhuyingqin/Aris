import { useEffect, useRef, useState } from "react";
import {
  appRelaunch,
  appUpdateCheck,
  appUpdateDownloadAndInstall,
  configGet,
  configSecretGet,
  configSet,
  configTest,
  isTauri,
  localEnvironmentChecks,
  newapiBootstrap,
  newapiModels,
  newapiUsageLogs,
  type NewApiAccount,
  type NewApiUsageLogPage,
} from "../api/tauri";
import arisIcon from "../assets/app-logo.png";
import { isManagedAuthInvalidError, useStore } from "../store";
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestResult,
  ConfigView,
  LocalEnvironmentCheck,
} from "../types";
import MailSettings, { MailSettingsDetail } from "./MailSettings";

interface PresetOption {
  label: string;
  value: string;
  hint?: string;
}

interface ProviderMeta {
  label: string;
  hint: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  models?: PresetOption[];
  baseUrls?: PresetOption[];
}

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "passed" | "failed";
type UpdateState = "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "error";
type SettingsTab = "general" | "auth" | "usage" | "about";

const MANAGED_NEW_API_MODE = true;
const ACCOUNT_CACHE_KEY = "somniq-account-v1";
const LEGACY_ACCOUNT_CACHE_KEY = "aris-account-v1";
const SETTINGS_TAB_REQUEST_KEY = "somniq-settings-tab-request";
const SETTINGS_TAB_REQUEST_EVENT = "somniq-settings-tab-request";
const USAGE_LOG_PAGE_SIZE = 12;
const PREVIEW_CONFIG_VIEW: ConfigView = {
  appVersion: "0.4.5",
  configPath: "browser preview - Tauri config is not loaded",
  executorProvider: "openai",
  executorModel: "MiniMax-M3",
  executorBaseUrl: "http://106.53.28.124:18080/v1",
  summarizerProvider: "",
  summarizerModel: "",
  summarizerBaseUrl: "",
  hasSummarizerKey: false,
  hasExecutorKey: true,
  executorKeyMasked: "sk-...preview",
  reviewerProvider: "openai",
  reviewerModel: "MiniMax-M3",
  reviewerBaseUrl: "http://106.53.28.124:18080/v1",
  hasReviewerKey: true,
  reviewerKeyMasked: "sk-...preview",
  hasScopusKey: false,
  language: "cn",
  memoryWriteApproval: true,
  managedModels: ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5", "GLM-5", "deepseek-v4-pro"],
  verifiedExecutors: [],
};
const PREVIEW_ACCOUNT: NewApiAccount = {
  username: "preview-user",
  displayName: "Preview User",
  role: 10,
  isAdmin: true,
  subscriptionName: "Team Plan",
  subscriptionDesc: "Browser preview data",
  subscriptionQuota: 1_850_000,
  subscriptionUsedQuota: 650_000,
  group: "default",
  groupDesc: "Standard group",
  groupRatio: "1",
  quota: 1_250_000,
  usedQuota: 750_000,
  models: ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5", "GLM-5", "deepseek-v4-pro"],
  model: "MiniMax-M3",
};
const PREVIEW_USAGE_LOGS: NewApiUsageLogPage = {
  page: 1,
  pageSize: USAGE_LOG_PAGE_SIZE,
  total: 3,
  items: [
    {
      id: "preview-1",
      createdAt: Math.floor(Date.now() / 1000) - 240,
      model: "MiniMax-M3",
      tokenName: "somniq-desktop",
      channel: "MiniMax",
      requestId: "req_preview_001928374",
      upstreamRequestId: "",
      promptTokens: 4180,
      completionTokens: 920,
      totalTokens: 5100,
      quota: 6200,
      status: "success",
      typeLabel: "Consume",
    },
    {
      id: "preview-2",
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      model: "gpt-5.5",
      tokenName: "somniq-desktop",
      channel: "OpenAI-compatible",
      requestId: "req_preview_001928375",
      upstreamRequestId: "",
      promptTokens: 2310,
      completionTokens: 780,
      totalTokens: 3090,
      quota: 4100,
      status: "success",
      typeLabel: "Consume",
    },
    {
      id: "preview-3",
      createdAt: Math.floor(Date.now() / 1000) - 7200,
      model: "deepseek-v4-pro",
      tokenName: "somniq-desktop",
      channel: "DeepSeek",
      requestId: "req_preview_001928376",
      upstreamRequestId: "",
      promptTokens: 1490,
      completionTokens: 530,
      totalTokens: 2020,
      quota: 2400,
      status: "success",
      typeLabel: "Consume",
    },
  ],
};
const ENVIRONMENT_CHECK_PLACEHOLDERS = [
  { id: "python", label: "Python", category: "运行环境" },
  { id: "jupyter", label: "Jupyter", category: "Notebook" },
  { id: "matlab", label: "MATLAB", category: "数值计算" },
  { id: "latex", label: "LaTeX", category: "论文排版" },
];

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "通用" },
  { id: "auth", label: "认证" },
  { id: "usage", label: "使用统计" },
  { id: "about", label: "关于" },
];

const SUMMARIZER_MODELS: PresetOption[] = [
  { label: "Auto", value: "", hint: "自动选择" },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", hint: "便宜快速" },
  { label: "关闭", value: "off", hint: "不用 LLM 摘要" },
];

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
  { label: "New API", value: "http://106.53.28.124:18080/v1" },
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
  anthropic: {
    label: "Anthropic",
    hint: "Claude official API",
    defaultModel: "claude-opus-4-7",
    models: EXECUTOR_MODELS.filter((model) => model.hint === "Anthropic"),
    baseUrls: ANTHROPIC_URLS,
  },
  "anthropic-compat": {
    label: "Anthropic-compat",
    hint: "Claude-compatible custom endpoint",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "MiniMax M3", value: "MiniMax-M3" },
      { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro" },
    ],
    baseUrls: ANTHROPIC_COMPAT_URLS,
  },
  openai: {
    label: "OpenAI-compatible",
    hint: "OpenAI, MiniMax, DeepSeek, Kimi...",
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    models: EXECUTOR_MODELS.filter((model) => model.hint !== "Anthropic"),
    baseUrls: OPENAI_COMPAT_URLS,
  },
  custom: {
    label: "Custom",
    hint: "Any other provider",
    defaultModel: "",
    models: EXECUTOR_MODELS,
    baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((url) => url.value)],
  },
};

const REVIEWER_PROVIDERS: Record<string, ProviderMeta> = {
  "": { label: "Disabled", hint: "Use no separate review model", defaultModel: "" },
  openai: {
    label: "OpenAI-compatible",
    hint: "OpenAI or compatible reviewer API",
    defaultModel: "gpt-5.5",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: REVIEWER_MODELS.filter((model) => ["OpenAI", "MiniMax", "Moonshot", "DeepSeek"].includes(model.hint ?? "")),
    baseUrls: OPENAI_COMPAT_URLS,
  },
  gemini: {
    label: "Gemini",
    hint: "Google",
    defaultModel: "gemini-2.5-pro",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: REVIEWER_MODELS.filter((model) => model.hint === "Google"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "Gemini"),
  },
  glm: {
    label: "GLM",
    hint: "Zhipu",
    defaultModel: "GLM-5",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: REVIEWER_MODELS.filter((model) => model.hint === "Zhipu"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "GLM"),
  },
  minimax: {
    label: "MiniMax",
    hint: "MiniMax reviewer",
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    models: REVIEWER_MODELS.filter((model) => model.hint === "MiniMax"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "MiniMax"),
  },
  kimi: {
    label: "Kimi",
    hint: "Moonshot reviewer",
    defaultModel: "kimi-k2.5",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    models: REVIEWER_MODELS.filter((model) => model.hint === "Moonshot"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "Kimi"),
  },
  deepseek: {
    label: "DeepSeek",
    hint: "DeepSeek Anthropic-compatible reviewer",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    models: REVIEWER_MODELS.filter((model) => model.hint === "DeepSeek"),
    baseUrls: ANTHROPIC_COMPAT_URLS.filter((url) => url.label === "DeepSeek"),
  },
  "anthropic-compat": {
    label: "Anthropic-compat",
    hint: "Claude-compatible reviewer/proxy",
    defaultModel: "claude-sonnet-4-6",
    defaultBaseUrl: "https://api.anthropic.com",
    models: REVIEWER_MODELS.filter((model) => ["Anthropic-compatible", "MiniMax", "DeepSeek"].includes(model.hint ?? "")),
    baseUrls: ANTHROPIC_COMPAT_URLS,
  },
  custom: {
    label: "Custom",
    hint: "Manual provider and endpoint",
    defaultModel: "",
    models: REVIEWER_MODELS,
    baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((url) => url.value)],
  },
};

function readCachedAccount(): NewApiAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_CACHE_KEY) ?? localStorage.getItem(LEGACY_ACCOUNT_CACHE_KEY);
    return raw ? (JSON.parse(raw) as NewApiAccount) : null;
  } catch {
    return null;
  }
}

function writeCachedAccount(account: NewApiAccount | null) {
  try {
    if (account) {
      localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(account));
      localStorage.removeItem(LEGACY_ACCOUNT_CACHE_KEY);
    } else {
      localStorage.removeItem(ACCOUNT_CACHE_KEY);
      localStorage.removeItem(LEGACY_ACCOUNT_CACHE_KEY);
    }
  } catch {
    // Local storage can be disabled; the in-memory state is still useful.
  }
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return value === "general" || value === "auth" || value === "usage" || value === "about";
}

function readRequestedSettingsTab(): SettingsTab | null {
  try {
    const value = sessionStorage.getItem(SETTINGS_TAB_REQUEST_KEY);
    if (isSettingsTab(value)) {
      sessionStorage.removeItem(SETTINGS_TAB_REQUEST_KEY);
      return value;
    }
  } catch {
    // Session storage can be disabled in embedded browser contexts.
  }
  return null;
}

function uniqueModelList(...groups: Array<Array<string | null | undefined> | null | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      const model = value?.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      items.push(model);
    }
  }
  return items;
}

function formatQuota(credits: number): string {
  return `$${(credits / 500000).toFixed(2)}`;
}

function quotaPercent(account: NewApiAccount): number {
  const total = account.quota + account.usedQuota;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((account.usedQuota / total) * 100));
}

function subscriptionQuotaPercent(account: NewApiAccount): number {
  const used = account.subscriptionUsedQuota ?? 0;
  const remaining = account.subscriptionQuota ?? 0;
  const total = used + remaining;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function isAdminAccount(account: NewApiAccount | null): boolean {
  if (!account) return false;
  if (account.isAdmin === true) return true;
  if (typeof account.role === "number" && account.role >= 10) return true;
  const markers = [account.group, account.groupDesc, account.subscriptionName, account.subscriptionDesc];
  return markers.some((value) => {
    const text = value?.trim();
    if (!text) return false;
    const lower = text.toLowerCase();
    return ["admin", "administrator", "root", "superuser", "super-admin", "owner"].includes(lower)
      || text.includes("管理员")
      || text.includes("管理員");
  });
}

function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUsageExact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Math.round(value).toLocaleString();
}

function formatUsageDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortUsageId(value: string): string {
  const text = value.trim();
  if (!text) return "-";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function usageLogMeta(status: string, typeLabel: string): string {
  return [typeLabel, status].map((value) => value.trim()).filter(Boolean).join(" · ");
}

function environmentMark(id: string): string {
  if (id === "python") return "Py";
  if (id === "jupyter") return "Jp";
  if (id === "matlab") return "M";
  if (id === "latex") return "TeX";
  return id.slice(0, 3).toUpperCase();
}

function environmentStatusLabel(item: LocalEnvironmentCheck): string {
  if (item.status === "ready") return "可用";
  if (item.status === "warning") return "需检查";
  return item.available ? "可用" : "未检测到";
}

function normalizeExecutorProvider(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  const current = provider || "anthropic";
  const lower = (baseUrl ?? "").trim().toLowerCase();
  if (current === "anthropic" && (lower.includes("minimaxi.com/anthropic") || lower.includes("deepseek.com/anthropic"))) {
    return "anthropic-compat";
  }
  return current in EXECUTOR_PROVIDERS ? current : "custom";
}

function normalizeReviewerProvider(provider: string | null | undefined): string {
  const current = provider || "";
  if (current === "anthropic") return "anthropic-compat";
  return current in REVIEWER_PROVIDERS ? current : "custom";
}

function detectProtocol(url: string): string {
  if (!url.trim()) return "anthropic";
  const lower = url.toLowerCase();
  if (lower.includes("anthropic.com") || lower.includes("newcli.com") || lower.includes("modelscope.cn") || lower.includes("/anthropic")) {
    return "anthropic-compat";
  }
  return "openai";
}

function suggestModels(url: string): string[] {
  const lower = url.toLowerCase();
  if (lower.includes("106.53.28.124:18080")) return ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5"];
  if (lower.includes("minimaxi.com")) return ["MiniMax-M3", "MiniMax-M2.7"];
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

function formatServerLabel(server: string, provider?: string): string {
  const source = server.trim() || provider?.trim() || "unknown";
  if (source === "OpenAI-compatible" || source === "Anthropic-compatible" || source === "unknown") return source;
  try {
    const url = new URL(source);
    return url.host || source;
  } catch {
    return source;
  }
}

function configuredServerLabel(config: ConfigView): string {
  const baseUrl = config.executorBaseUrl?.trim();
  if (baseUrl) return formatServerLabel(baseUrl, config.executorProvider ?? undefined);
  return config.executorProvider === "anthropic" ? "api.anthropic.com" : (config.executorProvider || "未配置");
}

function providerKey(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  return `${provider?.trim() || detectProtocol(baseUrl ?? "")}::${(baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase()}`;
}

function PresetTextInput({
  value,
  placeholder,
  options,
  onChange,
  disabled = false,
}: {
  value: string;
  placeholder: string;
  options: PresetOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const currentPreset = options.find((option) => option.value === value)?.value ?? "__custom";
  return (
    <div className="st-preset-control">
      <select
        value={currentPreset}
        disabled={disabled}
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
            {option.label}{option.hint ? ` - ${option.hint}` : ""}
          </option>
        ))}
      </select>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} spellCheck={false} disabled={disabled} />
    </div>
  );
}

function KeyInput({
  value,
  placeholder,
  masked,
  secretKind,
  onChange,
  disabled = false,
}: {
  value: string;
  placeholder: string;
  masked: string | null | undefined;
  secretKind: ConfigSecretKind;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [savedSecret, setSavedSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const displayValue = value || savedSecret;

  useEffect(() => {
    setVisible(false);
    setSavedSecret("");
    setError("");
  }, [secretKind, masked]);

  const toggleVisible = async () => {
    setError("");
    if (visible) {
      setVisible(false);
      return;
    }
    if (!value && masked && !savedSecret) {
      setLoading(true);
      try {
        const secret = await configSecretGet(secretKind);
        if (secret) setSavedSecret(secret);
        else setError("没有可显示的已保存密钥");
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
    setVisible(true);
  };

  return (
    <div className="st-key-wrap" data-has-saved-secret={Boolean(masked)}>
      <input
        type={visible ? "text" : "password"}
        value={displayValue}
        placeholder={placeholder}
        onChange={(event) => {
          if (savedSecret) setSavedSecret("");
          onChange(event.target.value);
        }}
        className="st-key-input"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="st-key-eye"
        onClick={() => void toggleVisible()}
        disabled={disabled || loading || (!value && !masked)}
        title={error || (visible ? "隐藏密钥" : "显示密钥")}
      >
        {loading ? "..." : visible ? "隐藏" : "显示"}
      </button>
      {error && <span className="st-key-error">{error}</span>}
    </div>
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

export default function Settings() {
  const setError = useStore((state) => state.setError);
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const logout = useStore((state) => state.logout);
  const [configView, setConfigView] = useState<ConfigView | null>(() => isTauri() ? null : PREVIEW_CONFIG_VIEW);
  const [advForm, setAdvForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [summaryKey, setSummaryKey] = useState("");
  const [reviewerKey, setReviewerKey] = useState("");
  const [scopusKey, setScopusKey] = useState("");
  const [summaryToolsOpen, setSummaryToolsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [environmentChecks, setEnvironmentChecks] = useState<LocalEnvironmentCheck[]>([]);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentError, setEnvironmentError] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageLogPage, setUsageLogPage] = useState(1);
  const [usageLogs, setUsageLogs] = useState<NewApiUsageLogPage | null>(() => isTauri() ? null : PREVIEW_USAGE_LOGS);
  const [usageLogError, setUsageLogError] = useState("");
  const [managedModels, setManagedModels] = useState<string[]>(() => isTauri() ? [] : PREVIEW_CONFIG_VIEW.managedModels ?? []);
  const [managedModelsLoading, setManagedModelsLoading] = useState(false);
  const [managedModelsError, setManagedModelsError] = useState("");
  const [account, setAccount] = useState<NewApiAccount | null>(() => isTauri() ? readCachedAccount() : PREVIEW_ACCOUNT);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(() => readRequestedSettingsTab() ?? "general");
  const [mailDetailOpen, setMailDetailOpen] = useState(false);
  const savedTimer = useRef<number | null>(null);

  const loadConfig = (view: ConfigView) => {
    setConfigView(view);
    setAdvForm({
      executorProvider: normalizeExecutorProvider(view.executorProvider, view.executorBaseUrl),
      executorModel: view.executorModel ?? "",
      executorBaseUrl: view.executorBaseUrl ?? "",
      summarizerProvider: view.summarizerProvider ?? "",
      summarizerModel: view.summarizerModel ?? "",
      summarizerBaseUrl: view.summarizerBaseUrl ?? "",
      reviewerProvider: normalizeReviewerProvider(view.reviewerProvider),
      reviewerModel: view.reviewerModel ?? "",
      reviewerBaseUrl: view.reviewerBaseUrl ?? "",
      language: view.language ?? "cn",
      memoryWriteApproval: view.memoryWriteApproval,
    });
    setExecKey("");
    setSummaryKey("");
    setReviewerKey("");
    setScopusKey("");
  };

  useEffect(() => {
    if (!isTauri()) return;
    configGet().then(loadConfig).catch((error) => setError(String(error)));
  }, [setError]);

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const loadUsageSummary = async (page = usageLogPage) => {
    if (!isTauri()) {
      setUsageLogs({ ...PREVIEW_USAGE_LOGS, page });
      return;
    }
    setUsageLoading(true);
    setUsageLogError("");
    try {
      await loadAccount();
      const nextLogs = await newapiUsageLogs(page, USAGE_LOG_PAGE_SIZE);
      setUsageLogs(nextLogs);
    } catch (error) {
      const message = String(error);
      setUsageLogError(message);
      setError(message);
    } finally {
      setUsageLoading(false);
    }
  };

  const refreshUsage = () => {
    const firstPage = 1;
    if (usageLogPage === firstPage) {
      void loadUsageSummary(firstPage);
    } else {
      setUsageLogPage(firstPage);
    }
  };

  const loadEnvironmentChecks = async () => {
    if (!isTauri()) return;
    setEnvironmentLoading(true);
    setEnvironmentError("");
    try {
      setEnvironmentChecks(await localEnvironmentChecks());
    } catch (error) {
      setEnvironmentError(String(error));
    } finally {
      setEnvironmentLoading(false);
    }
  };

  const loadManagedModels = async () => {
    if (!MANAGED_NEW_API_MODE) return;
    if (!isTauri()) {
      setManagedModels(PREVIEW_CONFIG_VIEW.managedModels ?? []);
      setConfigView(PREVIEW_CONFIG_VIEW);
      return;
    }
    setManagedModelsLoading(true);
    setManagedModelsError("");
    try {
      const models = await newapiModels();
      setManagedModels(models);
      setConfigView((current) => current ? { ...current, managedModels: models } : current);
    } catch (error) {
      setManagedModels([]);
      setManagedModelsError(String(error));
    } finally {
      setManagedModelsLoading(false);
    }
  };

  const loadAccount = async () => {
    if (!MANAGED_NEW_API_MODE) return;
    if (!isTauri()) {
      setAccount(PREVIEW_ACCOUNT);
      return;
    }
    setAccountLoading(true);
    setAccountError("");
    try {
      const next = await newapiBootstrap();
      setAccount(next);
      if (next.models.length > 0) {
        setManagedModels(next.models);
      }
      writeCachedAccount(next);
    } catch (error) {
      const message = String(error);
      setAccountError(message);
      if (isManagedAuthInvalidError(error)) {
        writeCachedAccount(null);
        logout();
      }
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    if (!isTauri()) return;
    void loadManagedModels();
    void loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openRequestedTab = (tab: SettingsTab) => {
      setActiveSettingsTab(tab);
      try {
        sessionStorage.removeItem(SETTINGS_TAB_REQUEST_KEY);
      } catch {
        // Session storage may be unavailable.
      }
    };
    const onSettingsTabRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isSettingsTab(detail)) {
        openRequestedTab(detail);
        return;
      }
      const requested = readRequestedSettingsTab();
      if (requested) openRequestedTab(requested);
    };
    const requested = readRequestedSettingsTab();
    if (requested) openRequestedTab(requested);
    window.addEventListener(SETTINGS_TAB_REQUEST_EVENT, onSettingsTabRequest);
    return () => {
      window.removeEventListener(SETTINGS_TAB_REQUEST_EVENT, onSettingsTabRequest);
    };
  }, []);

  useEffect(() => {
    if (activeSettingsTab === "about" && !environmentLoading) {
      void loadEnvironmentChecks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSettingsTab]);

  useEffect(() => {
    if (!isTauri() || activeSettingsTab !== "usage") return;
    void loadUsageSummary(usageLogPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSettingsTab, usageLogPage]);

  const buildPatch = (options: { includeExecutor?: boolean; includeReviewer?: boolean } = {}) => {
    const patch: ConfigPatch = { ...advForm };
    if (options.includeExecutor === false) {
      delete patch.executorProvider;
      delete patch.executorModel;
      delete patch.executorBaseUrl;
      delete patch.executorApiKey;
    } else if (execKey.trim()) {
      patch.executorApiKey = execKey.trim();
    }
    if (options.includeReviewer === false) {
      delete patch.reviewerProvider;
      delete patch.reviewerModel;
      delete patch.reviewerBaseUrl;
      delete patch.reviewerApiKey;
    } else if (reviewerKey.trim()) {
      patch.reviewerApiKey = reviewerKey.trim();
    }
    if (summaryKey.trim()) patch.summarizerApiKey = summaryKey.trim();
    if (scopusKey.trim()) patch.scopusApiKey = scopusKey.trim();
    return patch;
  };

  const resetOpState = () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSaveState("idle");
    setTestState("idle");
    setTestResult(null);
  };

  const save = async () => {
    setSaveState("saving");
    setTestState("idle");
    setTestResult(null);
    try {
      if (!isTauri()) {
        setConfigView((current) => current ? { ...current, ...buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewer }) } : current);
        setSaveState("saved");
        savedTimer.current = window.setTimeout(() => setSaveState("idle"), 3000);
        return;
      }
      const next = await configSet(buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewer }));
      loadConfig(next);
      setSaveState("saved");
      savedTimer.current = window.setTimeout(() => setSaveState("idle"), 3000);
    } catch (error) {
      setError(String(error));
      setSaveState("error");
    }
  };

  const test = async () => {
    setTestState("testing");
    setTestResult(null);
    try {
      if (!isTauri()) {
        const result: ConfigTestResult = {
          ok: true,
          message: "Browser preview: connection test is simulated.",
          executor: { ok: true, label: "Executor", model: advForm.executorModel, baseUrl: advForm.executorBaseUrl, message: "Preview mode" },
          reviewer: canConfigureReviewer ? { ok: true, label: "Reviewer", model: advForm.reviewerModel, baseUrl: advForm.reviewerBaseUrl, message: "Preview mode" } : null,
        };
        setTestResult(result);
        setTestState("passed");
        return;
      }
      const result = await configTest(buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewer }));
      setTestResult(result);
      setTestState(result.ok ? "passed" : "failed");
    } catch (error) {
      const message = String(error);
      setTestResult({ ok: false, message, executor: { ok: false, label: "Settings", message } });
      setTestState("failed");
    }
  };

  const applyManagedModel = async (model: string) => {
    if (!model || model === configView?.executorModel) return;
    if (!isTauri()) {
      setConfigView((current) => current ? { ...current, executorModel: model } : current);
      setAdvForm((current) => ({ ...current, executorModel: model }));
      setAccount((current) => (current ? { ...current, model } : current));
      return;
    }
    try {
      const next = await configSet({ executorModel: model });
      loadConfig(next);
      setAccount((current) => (current ? { ...current, model } : current));
    } catch (error) {
      setError(String(error));
    }
  };

  const applyManagedReviewerModel = async (model: string) => {
    if (!canConfigureReviewer) return;
    if (model === (configView?.reviewerModel ?? "")) return;
    if (!isTauri()) {
      setConfigView((current) => current ? { ...current, reviewerModel: model } : current);
      setAdvForm((current) => ({ ...current, reviewerModel: model }));
      return;
    }
    try {
      const patch: ConfigPatch = model
        ? {
          reviewerProvider: "custom",
          reviewerModel: model,
          reviewerBaseUrl: configView?.executorBaseUrl ?? "http://106.53.28.124:18080/v1",
        }
        : { reviewerProvider: "", reviewerModel: "", reviewerBaseUrl: "" };
      const next = await configSet(patch);
      loadConfig(next);
    } catch (error) {
      setError(String(error));
    }
  };

  const checkForUpdates = async () => {
    setUpdateState("checking");
    setUpdateProgress(null);
    setUpdateMessage("");
    try {
      const result = await appUpdateCheck();
      setUpdateInfo(result);
      if (result.available) {
        setUpdateState("available");
        setUpdateMessage(`发现新版本 v${result.version ?? ""}`.trim());
      } else {
        setUpdateState("current");
        setUpdateMessage("当前已是最新版本");
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(String(error));
    }
  };

  const installUpdate = async () => {
    setUpdateState("downloading");
    setUpdateProgress(null);
    setUpdateMessage("正在下载安装包");
    try {
      const result = await appUpdateDownloadAndInstall((progress) => {
        setUpdateProgress(progress);
        if (progress.stage === "finished") setUpdateMessage("更新已安装，重启后生效");
      });
      if (result.installed) {
        setUpdateState("ready");
        setUpdateInfo((current) => ({
          available: true,
          currentVersion: current?.currentVersion,
          version: result.version ?? current?.version,
          date: current?.date,
          body: current?.body,
        }));
        setUpdateMessage("更新已安装，重启后生效");
      } else {
        setUpdateState("current");
        setUpdateMessage("没有可安装的更新");
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(String(error));
    }
  };

  const restartForUpdate = async () => {
    try {
      await appRelaunch();
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(String(error));
    }
  };

  if (mailDetailOpen) {
    return (
      <div className="st-page sp-detail-page">
        <div className="sp-detail-head">
          <button className="sp-back-btn" onClick={() => setMailDetailOpen(false)} type="button">返回</button>
          <div className="sp-detail-title">邮箱</div>
          <div className="sp-detail-badges">
            <span className="sp-role-badge sp-role-mail">IMAP/SMTP</span>
          </div>
        </div>
        <MailSettingsDetail />
      </div>
    );
  }

  if (!configView) return <div className="board"><div className="empty">Loading...</div></div>;

  const advExecProvider = advForm.executorProvider ?? "anthropic";
  const advExecMeta = EXECUTOR_PROVIDERS[advExecProvider] ?? EXECUTOR_PROVIDERS.custom;
  const canConfigureExecutor = isAdminAccount(account);
  const canConfigureReviewer = canConfigureExecutor;
  const advReviewerProvider = advForm.reviewerProvider ?? "";
  const advReviewerMeta = REVIEWER_PROVIDERS[advReviewerProvider] ?? REVIEWER_PROVIDERS.custom;
  const summaryProviderOptions = (() => {
    const options: Array<{ key: string; label: string; provider: string; baseUrl: string; model: string }> = [];
    const addOption = (label: string, provider: string | null | undefined, baseUrl: string | null | undefined, model: string | null | undefined) => {
      const protocol = provider?.trim() || detectProtocol(baseUrl ?? "");
      const url = baseUrl?.trim() ?? "";
      const key = providerKey(protocol, url);
      if (!protocol || options.some((item) => item.key === key)) return;
      options.push({ key, label, provider: protocol, baseUrl: url, model: model?.trim() ?? "" });
    };
    addOption("Executor", configView.executorProvider, configView.executorBaseUrl, configView.executorModel);
    if (canConfigureReviewer) addOption("Reviewer", configView.reviewerProvider, configView.reviewerBaseUrl, configView.reviewerModel);
    for (const item of configView.verifiedExecutors ?? []) {
      addOption(`${formatServerLabel(item.baseUrl)} · ${item.model}`, item.provider, item.baseUrl, item.model);
    }
    return options;
  })();
  const summaryProviderKey = advForm.summarizerProvider ? providerKey(advForm.summarizerProvider, advForm.summarizerBaseUrl) : "";
  const selectedSummaryProvider = summaryProviderOptions.find((item) => item.key === summaryProviderKey);
  const isManualSummaryProvider = Boolean(advForm.summarizerProvider) && !selectedSummaryProvider;
  const summarySelectValue = isManualSummaryProvider ? "__manual" : summaryProviderKey;
  const summarySuggestionBaseUrl = selectedSummaryProvider?.baseUrl ?? advForm.summarizerBaseUrl ?? "";
  const summaryModelOptions = [
    ...SUMMARIZER_MODELS,
    ...Array.from(new Set([
      selectedSummaryProvider?.model,
      ...suggestModels(summarySuggestionBaseUrl),
      advForm.executorProvider === advForm.summarizerProvider ? advForm.executorModel : "",
      advForm.reviewerProvider === advForm.summarizerProvider ? advForm.reviewerModel : "",
    ].filter((model): model is string => Boolean(model?.trim())))).map((model) => ({
      label: model,
      value: model,
      hint: selectedSummaryProvider?.label,
    })),
  ];
  const chooseExecProvider = (provider: string) => {
    const meta = EXECUTOR_PROVIDERS[provider] ?? EXECUTOR_PROVIDERS.custom;
    resetOpState();
    setAdvForm((current) => ({
      ...current,
      executorProvider: provider,
      executorModel: provider === "custom" ? (current.executorModel ?? "") : meta.defaultModel,
      executorBaseUrl: provider === "custom" ? (current.executorBaseUrl ?? "") : (meta.defaultBaseUrl ?? meta.baseUrls?.[0]?.value ?? ""),
    }));
  };
  const chooseReviewerProvider = (provider: string) => {
    const meta = REVIEWER_PROVIDERS[provider] ?? REVIEWER_PROVIDERS.custom;
    resetOpState();
    if (!provider) {
      setAdvForm((current) => ({ ...current, reviewerProvider: "", reviewerModel: "", reviewerBaseUrl: "" }));
      return;
    }
    setAdvForm((current) => ({
      ...current,
      reviewerProvider: provider,
      reviewerModel: provider === "custom" ? (current.reviewerModel ?? "") : meta.defaultModel,
      reviewerBaseUrl: provider === "custom" ? (current.reviewerBaseUrl ?? "") : (meta.defaultBaseUrl ?? meta.baseUrls?.[0]?.value ?? ""),
    }));
  };
  const chooseSummaryProvider = (key: string) => {
    resetOpState();
    if (!key) {
      setAdvForm((current) => ({ ...current, summarizerProvider: "", summarizerBaseUrl: "" }));
      return;
    }
    if (key === "__manual") {
      setAdvForm((current) => ({
        ...current,
        summarizerProvider: current.summarizerProvider || "openai",
        summarizerBaseUrl: current.summarizerBaseUrl ?? "",
        summarizerModel: current.summarizerModel ?? "",
      }));
      return;
    }
    const option = summaryProviderOptions.find((item) => item.key === key);
    if (!option) return;
    setAdvForm((current) => ({
      ...current,
      summarizerProvider: option.provider,
      summarizerBaseUrl: option.baseUrl,
      summarizerModel: current.summarizerModel ?? "",
    }));
  };

  const updateBusy = updateState === "checking" || updateState === "downloading";
  const updateCanInstall = updateState === "available";
  const updateCanRestart = updateState === "ready";
  const updateProgressLabel = updateProgress
    ? updateProgress.contentLength
      ? `${formatUpdateBytes(updateProgress.downloadedBytes)} / ${formatUpdateBytes(updateProgress.contentLength)}${updateProgress.percent !== null && updateProgress.percent !== undefined ? ` - ${updateProgress.percent}%` : ""}`
      : `${formatUpdateBytes(updateProgress.downloadedBytes)} downloaded`
    : "";
  const environmentReadyCount = environmentChecks.filter((item) => item.available).length;
  const accountUsedQuota = account?.usedQuota ?? 0;
  const accountRemainingQuota = account?.quota ?? 0;
  const accountTotalQuota = accountUsedQuota + accountRemainingQuota;
  const accountUsagePercent = account ? quotaPercent(account) : 0;
  const subscriptionUsedQuota = account?.subscriptionUsedQuota ?? 0;
  const subscriptionRemainingQuota = account?.subscriptionQuota ?? 0;
  const subscriptionUsagePercent = account ? subscriptionQuotaPercent(account) : 0;
  const usageLogTotal = usageLogs?.total ?? 0;
  const usageLogItems = usageLogs?.items ?? [];
  const usageLogPageCount = Math.max(1, Math.ceil(usageLogTotal / USAGE_LOG_PAGE_SIZE));
  const usageLogStart = usageLogTotal > 0 ? (usageLogPage - 1) * USAGE_LOG_PAGE_SIZE + 1 : 0;
  const usageLogEnd = usageLogTotal > 0 ? Math.min(usageLogStart + usageLogItems.length - 1, usageLogTotal) : 0;
  const canGoPrevUsageLogPage = usageLogPage > 1 && !usageLoading;
  const canGoNextUsageLogPage = usageLogPage < usageLogPageCount && !usageLoading;
  const currentManagedModel = configView.executorModel?.trim() || "未选择";
  const availableManagedModels = uniqueModelList(
    managedModels,
    configView.managedModels,
    [configView.executorModel, canConfigureReviewer ? configView.reviewerModel : null],
    account?.models,
  );
  const managedModelPreview = availableManagedModels.slice(0, 12);
  const currentReviewerModel = canConfigureReviewer ? configView.reviewerModel?.trim() || "" : "";
  const currentServerLabel = configuredServerLabel(configView);

  return (
    <div className="st-page sp-list-page sp-settings-page">
      <div className="sp-settings-tabs" role="tablist" aria-label="设置分类">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={activeSettingsTab === item.id}
            className={`sp-settings-tab${activeSettingsTab === item.id ? " active" : ""}`}
            onClick={() => setActiveSettingsTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {activeSettingsTab === "general" && (
        <>
          <div className="sp-status-bar">
            <div className="sp-status-slot">
              <span className="sp-status-tag sp-status-tag-exec">模型服务</span>
              <span className="sp-status-model">{currentManagedModel}</span>
              {configView.hasExecutorKey && <span className="sp-status-key">●</span>}
              <span className="sp-status-url">{currentServerLabel}</span>
            </div>
            <div className="sp-status-sep" />
            <div className="sp-status-slot sp-status-version">
              <span className="sp-status-tag sp-status-tag-version">版本</span>
              <span className="sp-status-model">SomniQ Studio v{configView.appVersion}</span>
            </div>
          </div>

          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">界面语言</div>
                <div className="sp-section-sub">切换后作为助手回复偏好保存，下次对话生效。</div>
              </div>
              <div className="sp-update-actions">
                <div className="st-lang-grid sp-inline-lang-grid">
                  {[
                    { value: "cn", label: "简体中文" },
                    { value: "en", label: "English" },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`st-lang-card${advForm.language === item.value ? " active" : ""}`}
                      onClick={() => {
                        resetOpState();
                        setAdvForm((current) => ({ ...current, language: item.value }));
                      }}
                    >
                      <span className="st-lang-label">{item.label}</span>
                    </button>
                  ))}
                </div>
                <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving"} type="button">
                  {saveState === "saving" ? "保存中..." : saveState === "saved" ? "已保存" : "保存偏好"}
                </button>
              </div>
            </div>
          </div>

          <div className="sp-appearance-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">外观主题</div>
                <div className="sp-section-sub">选择应用的明暗主题，立即生效。</div>
              </div>
              <div className="sp-theme-toggle" role="radiogroup" aria-label="主题">
                {([
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.value}
                    className={`sp-theme-option${theme === option.value ? " active" : ""}`}
                    onClick={() => setTheme(option.value)}
                  >
                    <span className="sp-theme-swatch" data-theme-swatch={option.value} aria-hidden="true" />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">本地行为</div>
                <div className="sp-section-sub">记忆写入策略仅保存在这台设备。</div>
              </div>
              <div className="sp-update-actions">
                <button
                  type="button"
                  className={`st-lang-card${advForm.memoryWriteApproval ? " active" : ""}`}
                  onClick={() => {
                    resetOpState();
                    setAdvForm((current) => ({ ...current, memoryWriteApproval: !current.memoryWriteApproval }));
                  }}
                >
                  <span className="st-lang-label">{advForm.memoryWriteApproval ? "写入前确认" : "自动写入"}</span>
                </button>
                <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving"} type="button">
                  {saveState === "saving" ? "保存中..." : saveState === "saved" ? "已保存" : "保存行为"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {activeSettingsTab === "auth" && (
        <>
          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">账号服务</div>
                <div className="sp-section-sub">账号、订阅、分组与额度由服务器下发；本地只保留最近一次投影。</div>
              </div>
              <div className="sp-update-actions">
                <button className="sp-btn sp-btn-secondary" onClick={() => void loadAccount()} disabled={accountLoading} type="button">
                  {accountLoading ? "刷新中..." : "刷新"}
                </button>
                <button className="sp-btn sp-btn-secondary" onClick={() => logout()} type="button">退出登录</button>
              </div>
            </div>
            <div className={`sp-update-panel ${accountError && !account ? "sp-update-panel-error" : "sp-update-panel-current"}`}>
              <div className="sp-update-main">
                <span className={`sp-update-dot ${accountError && !account ? "sp-update-dot-error" : "sp-update-dot-current"}`} />
                <div className="sp-update-copy">
                  <div className="sp-update-title">
                    {account ? (account.displayName || account.username || "已登录") : "未登录"}
                    {account?.subscriptionName ? <span className="sp-status-tag sp-status-tag-version" style={{ marginLeft: 8 }}>{account.subscriptionName}</span> : null}
                    {account?.group ? <span className="sp-status-tag sp-status-tag-version sp-account-group-tag" style={{ marginLeft: 8 }}>分组 {account.group}</span> : null}
                  </div>
                  <div className="sp-update-meta">
                    {account
                      ? `余额 ${formatQuota(account.quota)} · 已用 ${formatQuota(account.usedQuota)}`
                      : (accountError || "登录后显示账号信息")}
                  </div>
                  {account && (
                    <div className="sp-account-summary" aria-label="订阅与余额">
                      <div className="sp-account-metric">
                        <span>订阅套餐</span>
                        <strong>{account.subscriptionName || "无有效订阅"}</strong>
                        <small>{account.subscriptionDesc || "来自 /api/subscription/self"}</small>
                      </div>
                      <div className="sp-account-metric subscription">
                        <span>订阅余额</span>
                        <strong>{formatQuota(account.subscriptionQuota ?? 0)}</strong>
                        <small>{subscriptionQuotaPercent(account)}% 已消耗</small>
                      </div>
                      <div className="sp-account-metric balance">
                        <span>账户余额</span>
                        <strong>{formatQuota(account.quota)}</strong>
                        <small>可继续用于模型调用</small>
                      </div>
                      <div className="sp-account-metric">
                        <span>已用额度</span>
                        <strong>{formatQuota(account.usedQuota)}</strong>
                        <small>{quotaPercent(account)}% 已消耗 · 倍率 {account.groupRatio || "-"}</small>
                      </div>
                    </div>
                  )}
                  {account && (account.groupRatio || account.groupDesc) && (
                    <div className="sp-update-message">
                      分组 {account.group || "-"}
                      {account.groupRatio ? ` · 倍率 ${account.groupRatio}` : ""}
                      {account.groupDesc ? ` · ${account.groupDesc}` : ""}
                    </div>
                  )}
                  {account && account.quota + account.usedQuota > 0 && (
                    <div className="sp-quota-bar">
                      <div style={{ width: `${quotaPercent(account)}%` }} />
                    </div>
                  )}
                  {account && accountError && <div className="sp-update-message">刷新失败，当前显示上次缓存 · {accountError}</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">模型服务</div>
                <div className="sp-section-sub">从账号已有模型中分别选择 Chat 执行模型和审核模型；Chat 里也可以临时切换任意已同步模型。</div>
              </div>
              <div className="sp-update-actions">
                <button className="sp-btn sp-btn-secondary" onClick={() => void loadManagedModels()} disabled={managedModelsLoading} type="button">
                  {managedModelsLoading ? "同步中..." : "同步模型"}
                </button>
              </div>
            </div>
            <div className="sp-model-pair">
              <label className="sp-model-select-row">
                <span>执行模型</span>
                {availableManagedModels.length > 0 ? (
                  <select
                    value={configView.executorModel ?? ""}
                    onChange={(event) => void applyManagedModel(event.target.value)}
                    className="sp-settings-select"
                  >
                    {availableManagedModels.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <span className="sp-model-select-empty">登录后同步模型</span>
                )}
              </label>
              {canConfigureReviewer && (
                <label className="sp-model-select-row">
                  <span>审核模型</span>
                  {availableManagedModels.length > 0 ? (
                    <select
                      value={currentReviewerModel}
                      onChange={(event) => void applyManagedReviewerModel(event.target.value)}
                      className="sp-settings-select"
                    >
                      <option value="">关闭审核模型</option>
                      {availableManagedModels.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="sp-model-select-empty">登录后同步模型</span>
                  )}
                </label>
              )}
            </div>
            <div className={`sp-update-panel ${managedModelsError ? "sp-update-panel-error" : "sp-update-panel-current"}`}>
              <div className="sp-update-main">
                <span className={`sp-update-dot ${managedModelsError ? "sp-update-dot-error" : "sp-update-dot-current"}`} />
                <div className="sp-update-copy">
                  <div className="sp-update-title">
                    当前执行：{currentManagedModel}
                    {canConfigureReviewer ? (currentReviewerModel ? ` · 审核：${currentReviewerModel}` : " · 审核：关闭") : ""}
                  </div>
                  <div className="sp-update-meta">
                    {managedModelsLoading
                      ? "正在同步模型"
                      : managedModelsError
                        ? managedModelsError
                        : availableManagedModels.length > 0
                          ? `已同步 ${availableManagedModels.length} 个模型`
                          : "登录后将自动同步模型"}
                  </div>
                  {managedModelPreview.length > 0 && (
                    <div className="sp-update-message">
                      {managedModelPreview.join(" · ")}
                      {availableManagedModels.length > managedModelPreview.length ? ` · +${availableManagedModels.length - managedModelPreview.length}` : ""}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="sp-providers-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">集成认证</div>
                <div className="sp-section-sub">邮箱连接，将 SomniQ 接入 Gmail / Outlook / IMAP。</div>
              </div>
            </div>
            <div className="sp-card-list">
              <MailSettings onOpen={() => setMailDetailOpen(true)} />
            </div>
          </div>
        </>
      )}

      {activeSettingsTab === "auth" && (
        <div className="sp-advanced-wrap sp-advanced-wrap-tab">
          <div className="sp-advanced-body">
            {canConfigureExecutor && (
              <div className="sp-adv-section">
                <div className="sp-adv-section-title">执行器</div>
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
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Model</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorModel ?? ""} placeholder={advExecMeta.defaultModel || "e.g. claude-sonnet-4-6"} options={advExecMeta.models ?? EXECUTOR_MODELS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, executorModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorBaseUrl ?? ""} placeholder={advExecMeta.defaultBaseUrl || "(official default)"} options={advExecMeta.baseUrls ?? OPENAI_COMPAT_URLS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, executorBaseUrl: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasExecutorKey ? `Saved: ${configView.executorKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={execKey} placeholder={configView.hasExecutorKey ? "leave blank to keep" : "paste API key"} masked={configView.executorKeyMasked} secretKind="executorApiKey" onChange={(value) => { resetOpState(); setExecKey(value); }} /></div></div>
                </div>
              </div>
            )}

            {canConfigureReviewer && (
              <div className="sp-adv-section">
                <div className="sp-adv-section-title">审阅</div>
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
                    <div className="st-row"><div className="st-row-label"><span className="st-label">Model</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerModel ?? ""} placeholder={advReviewerMeta.defaultModel || "e.g. gpt-5.5"} options={advReviewerMeta.models ?? REVIEWER_MODELS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, reviewerModel: value })); }} /></div></div>
                    <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerBaseUrl ?? ""} placeholder={advReviewerMeta.defaultBaseUrl || "(provider default)"} options={advReviewerMeta.baseUrls ?? OPENAI_COMPAT_URLS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, reviewerBaseUrl: value })); }} /></div></div>
                    <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasReviewerKey ? `Saved: ${configView.reviewerKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={reviewerKey} placeholder={configView.hasReviewerKey ? "leave blank to keep" : "paste reviewer key"} masked={configView.reviewerKeyMasked} secretKind="reviewerApiKey" onChange={(value) => { resetOpState(); setReviewerKey(value); }} /></div></div>
                  </div>
                )}
              </div>
            )}

            <div className={`sp-adv-section sp-adv-section-collapsible${summaryToolsOpen ? " open" : ""}`}>
              <button
                type="button"
                className="sp-adv-section-toggle"
                aria-expanded={summaryToolsOpen}
                onClick={() => setSummaryToolsOpen((open) => !open)}
              >
                <span className="sp-adv-section-toggle-main">
                  <span className="sp-adv-section-title">摘要与工具</span>
                  <span className="sp-adv-section-sub">摘要模型、Scopus Key 与配置文件路径</span>
                </span>
                <span className="sp-adv-section-toggle-state">{summaryToolsOpen ? "收起" : "展开"}</span>
              </button>
              {summaryToolsOpen && (
                <div className="sp-adv-rows">
                  <div className="st-row"><div className="st-row-label"><span className="st-label">摘要供应商</span><span className="st-hint">Auto 会使用这里选择的供应商和已保存 key</span></div><div className="st-row-control"><select value={summarySelectValue} onChange={(event) => chooseSummaryProvider(event.target.value)}><option value="">跟随执行器</option><option value="__manual">手动配置</option>{summaryProviderOptions.map((item) => <option key={item.key} value={item.key}>{item.label}{item.model ? ` · ${item.model}` : ""}</option>)}</select></div></div>
                  {isManualSummaryProvider && (
                    <>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">摘要协议</span></div><div className="st-row-control"><select value={advForm.summarizerProvider ?? "openai"} onChange={(event) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerProvider: event.target.value })); }}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="anthropic-compat">Anthropic-compatible</option></select></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">摘要 Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerBaseUrl ?? ""} placeholder="https://api.openai.com/v1" options={[...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS]} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerBaseUrl: value })); }} /></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">摘要 API Key</span><span className="st-hint">{configView.hasSummarizerKey ? `Saved: ${configView.summarizerKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={summaryKey} placeholder={configView.hasSummarizerKey ? "leave blank to keep" : "paste summary key"} masked={configView.summarizerKeyMasked} secretKind="summarizerApiKey" onChange={(value) => { resetOpState(); setSummaryKey(value); }} /></div></div>
                    </>
                  )}
                  <div className="st-row"><div className="st-row-label"><span className="st-label">摘要模型</span><span className="st-hint">压缩上下文时生成摘要所用的模型；留空 = 自动</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerModel ?? ""} placeholder="Auto" options={summaryModelOptions} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Scopus Key</span><span className="st-hint">{configView.hasScopusKey ? `Saved: ${configView.scopusKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={scopusKey} placeholder={configView.hasScopusKey ? "leave blank to keep" : "paste Elsevier key"} masked={configView.scopusKeyMasked} secretKind="scopusApiKey" onChange={(value) => { resetOpState(); setScopusKey(value); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Config file</span></div><div className="st-row-control"><input className="st-readonly-input" value={configView.configPath} readOnly /></div></div>
                </div>
              )}
            </div>

            {testResult && (
              <div className={`st-test-panel${testResult.ok ? " ok" : " failed"}`}>
                <div className="st-test-summary">{testResult.message}</div>
                <div className="st-test-grid">
                  {canConfigureExecutor && <TestDetail detail={testResult.executor} />}
                  {canConfigureReviewer && testResult.reviewer && <TestDetail detail={testResult.reviewer} />}
                </div>
              </div>
            )}
            <div className="sp-detail-actions sp-advanced-actions">
              <button className="sp-btn sp-btn-secondary" onClick={test} disabled={testState === "testing" || saveState === "saving"} type="button">
                {testState === "testing" ? "测试中..." : "测试连接配置"}
              </button>
              <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving" || testState === "testing"} type="button">
                {saveState === "saving" ? "保存中..." : saveState === "saved" ? "已保存" : "保存连接配置"}
              </button>
              {saveState === "saved" && <span className="st-save-info">已保存。下次对话时生效。</span>}
            </div>
          </div>
        </div>
      )}

      {activeSettingsTab === "usage" && (
        <div className="sp-usage-section">
          <div className="sp-usage-page-head">
            <div>
              <div className="sp-usage-page-title">使用统计</div>
              <div className="sp-usage-page-sub">显示当前登录账号在服务器侧的额度和使用量，不再读取本地项目 usage log。</div>
            </div>
            <div className="sp-usage-toolbar">
              <button className="sp-btn sp-btn-secondary" onClick={refreshUsage} disabled={usageLoading} type="button">
                {usageLoading ? "刷新中..." : "刷新"}
              </button>
            </div>
          </div>

          {account ? (
            <>
              <div className="sp-usage-hero">
                <div className="sp-usage-hero-top">
                  <div className="sp-usage-total">
                    <span className="sp-usage-total-icon">$</span>
                    <div>
                      <span>当前账号已用额度</span>
                      <strong>{formatQuota(accountUsedQuota)}</strong>
                      <small>{formatUsageExact(accountUsedQuota)} credits</small>
                    </div>
                  </div>
                  <div className="sp-usage-summary-pill">
                    <span>账户余额</span>
                    <strong>{formatQuota(accountRemainingQuota)}</strong>
                  </div>
                  <div className="sp-usage-summary-pill accent">
                    <span>账户总额度</span>
                    <strong>{formatQuota(accountTotalQuota)}</strong>
                  </div>
                </div>

                <div className="sp-usage-metrics">
                  <div className="sp-usage-metric sp-usage-hit-card">
                    <span>账户消耗比例</span>
                    <strong>{accountUsagePercent}%</strong>
                    <div className="sp-usage-progress"><div style={{ width: `${accountUsagePercent}%` }} /></div>
                  </div>
                  <div className="sp-usage-metric">
                    <span>已用额度</span>
                    <strong>{formatQuota(accountUsedQuota)}</strong>
                    <small>{formatUsageExact(accountUsedQuota)} credits</small>
                  </div>
                  <div className="sp-usage-metric balance">
                    <span>剩余额度</span>
                    <strong>{formatQuota(accountRemainingQuota)}</strong>
                    <small>{formatUsageExact(accountRemainingQuota)} credits</small>
                  </div>
                  <div className="sp-usage-metric subscription">
                    <span>订阅已用</span>
                    <strong>{formatQuota(subscriptionUsedQuota)}</strong>
                    <small>{formatUsageExact(subscriptionUsedQuota)} credits</small>
                  </div>
                  <div className="sp-usage-metric subscription">
                    <span>订阅余额</span>
                    <strong>{formatQuota(subscriptionRemainingQuota)}</strong>
                    <small>{formatUsageExact(subscriptionRemainingQuota)} credits</small>
                  </div>
                  <div className="sp-usage-metric sp-usage-hit-card">
                    <span>订阅消耗比例</span>
                    <strong>{subscriptionUsagePercent}%</strong>
                    <div className="sp-usage-progress"><div style={{ width: `${subscriptionUsagePercent}%` }} /></div>
                  </div>
                </div>
              </div>
              <div className="sp-usage-detail-panel">
                <div className="sp-usage-card-head">
                  <div className="sp-usage-card-title">调用明细</div>
                  <div className="sp-usage-card-range">
                    {usageLogTotal > 0 ? `第 ${usageLogStart}-${usageLogEnd} 条 / 共 ${usageLogTotal} 条` : "暂无记录"}
                  </div>
                </div>
                {usageLogError ? (
                  <div className="sp-usage-empty">{usageLogError}</div>
                ) : usageLoading && !usageLogs ? (
                  <div className="sp-usage-empty">加载中...</div>
                ) : usageLogItems.length > 0 ? (
                  <>
                    <div className="sp-usage-table">
                      <div className="sp-usage-row sp-usage-row-call sp-usage-row-head">
                        <span>时间</span>
                        <span>模型</span>
                        <span>令牌</span>
                        <span>Tokens</span>
                        <span>额度</span>
                        <span>请求</span>
                      </div>
                      {usageLogItems.map((entry) => {
                        const requestId = entry.requestId || entry.upstreamRequestId;
                        const meta = usageLogMeta(entry.status, entry.typeLabel);
                        const createdAt = entry.createdAt > 10_000_000_000 ? entry.createdAt : entry.createdAt * 1000;
                        return (
                          <div className="sp-usage-row sp-usage-row-call" key={entry.id}>
                            <span className="sp-usage-time" title={entry.createdAt ? new Date(createdAt).toLocaleString() : undefined}>
                              {formatUsageDate(entry.createdAt)}
                            </span>
                            <span className="sp-usage-model" title={entry.model || undefined}>{entry.model || "-"}</span>
                            <span title={entry.tokenName || undefined}>{entry.tokenName || "-"}</span>
                            <span title={`Prompt ${formatUsageExact(entry.promptTokens)} / Completion ${formatUsageExact(entry.completionTokens)}`}>
                              {formatUsageExact(entry.totalTokens)}
                            </span>
                            <span title={`${formatUsageExact(entry.quota)} credits${meta ? ` · ${meta}` : ""}`}>{formatQuota(entry.quota)}</span>
                            <span title={requestId || undefined}>{shortUsageId(requestId)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="sp-usage-pagination">
                      <div className="sp-usage-pagination-summary">
                        每页 {USAGE_LOG_PAGE_SIZE} 条，当前第 {usageLogPage} / {usageLogPageCount} 页
                      </div>
                      <div className="sp-usage-page-controls">
                        <button className="sp-usage-page-button" type="button" disabled={!canGoPrevUsageLogPage} onClick={() => setUsageLogPage((page) => Math.max(1, page - 1))}>
                          上一页
                        </button>
                        <span className="sp-usage-page-indicator">{usageLoading ? "..." : usageLogPage}</span>
                        <button className="sp-usage-page-button" type="button" disabled={!canGoNextUsageLogPage} onClick={() => setUsageLogPage((page) => page + 1)}>
                          下一页
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="sp-usage-empty">暂无调用记录。</div>
                )}
                {accountError && <div className="sp-usage-foot">账号额度刷新失败，当前显示上次缓存 · {accountError}</div>}
              </div>
            </>
          ) : (
            <div className="sp-usage-detail-panel">
              <div className="sp-usage-empty">{accountError || "未登录或账号信息未加载。登录后点击刷新获取当前用户使用量。"}</div>
            </div>
          )}
        </div>
      )}

      {activeSettingsTab === "about" && (
        <div className="sp-update-section">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">应用更新</div>
              <div className="sp-section-sub">通过 GitHub Release 检查、下载并安装 SomniQ Studio 更新。</div>
            </div>
            <div className="sp-update-actions">
              <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
                {updateState === "checking" ? "检查中..." : "检查更新"}
              </button>
              {updateCanInstall && <button className="sp-btn sp-btn-primary" onClick={() => void installUpdate()} disabled={updateBusy} type="button">下载并安装</button>}
              {updateCanRestart && <button className="sp-btn sp-btn-primary" onClick={() => void restartForUpdate()} type="button">重启应用</button>}
            </div>
          </div>
          <div className={`sp-update-panel sp-update-panel-${updateState}`}>
            <div className="sp-update-main">
              <span className={`sp-update-dot sp-update-dot-${updateState}`} />
              <div className="sp-update-copy">
                <div className="sp-update-title">
                  {updateState === "available"
                    ? `可更新到 v${updateInfo?.version ?? ""}`
                    : updateState === "ready"
                      ? `v${updateInfo?.version ?? ""} 已安装`
                      : updateState === "downloading"
                        ? "正在安装更新"
                        : "SomniQ Studio 已连接更新通道"}
                </div>
                <div className="sp-update-meta">
                  当前版本 v{configView.appVersion}
                  {updateInfo?.version && updateState !== "current" ? ` -> 远端版本 v${updateInfo.version}` : ""}
                  {updateInfo?.date ? ` · ${updateInfo.date}` : ""}
                </div>
                {(updateMessage || updateProgressLabel) && (
                  <div className="sp-update-message">
                    {updateMessage}
                    {updateProgressLabel ? ` · ${updateProgressLabel}` : ""}
                  </div>
                )}
                {updateInfo?.body && updateState === "available" && <div className="sp-update-notes">{updateInfo.body}</div>}
              </div>
            </div>
          </div>
          <div className="sp-env-section">
            <div className="sp-section-head sp-env-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">本地环境检查</div>
                <div className="sp-section-sub">
                  {environmentLoading
                    ? "正在检测本机运行环境..."
                    : environmentChecks.length > 0
                    ? `${environmentReadyCount}/${environmentChecks.length} 项可用`
                    : "查看 Python、MATLAB、LaTeX 等运行环境。"}
                </div>
              </div>
              <div className="sp-update-actions">
                <button
                  className="sp-btn sp-btn-secondary"
                  onClick={() => void loadEnvironmentChecks()}
                  disabled={environmentLoading}
                  type="button"
                >
                  {environmentLoading ? "检测中..." : "刷新"}
                </button>
              </div>
            </div>
            {environmentError && <div className="sp-env-error">{environmentError}</div>}
            <div className="sp-env-grid">
              {environmentLoading ? (
                ENVIRONMENT_CHECK_PLACEHOLDERS.map((item) => (
                  <div className="sp-env-card sp-env-card-loading" key={item.id}>
                    <div className="sp-env-card-top">
                      <span className="sp-env-mark">{environmentMark(item.id)}</span>
                      <div className="sp-env-title-block">
                        <div className="sp-env-title">{item.label}</div>
                        <div className="sp-env-category">{item.category}</div>
                      </div>
                      <span className="sp-env-badge sp-env-badge-loading">
                        <span className="sp-env-spinner" />
                        检测中
                      </span>
                    </div>
                    <div className="sp-env-loading-line" />
                    <div className="sp-env-loading-line short" />
                  </div>
                ))
              ) : environmentChecks.length === 0 ? (
                <div className="sp-env-empty">点击刷新后显示本机可用的科研与排版运行环境。</div>
              ) : (
                environmentChecks.map((item) => (
                  <div className={`sp-env-card sp-env-card-${item.status}`} key={item.id}>
                    <div className="sp-env-card-top">
                      <span className="sp-env-mark">{environmentMark(item.id)}</span>
                      <div className="sp-env-title-block">
                        <div className="sp-env-title">{item.label}</div>
                        <div className="sp-env-category">{item.category}</div>
                      </div>
                      <span className={`sp-env-badge sp-env-badge-${item.status}`}>{environmentStatusLabel(item)}</span>
                    </div>
                    <div className="sp-env-lines">
                      <div><span>版本</span><strong title={item.version ?? ""}>{item.version ?? "未获取"}</strong></div>
                      <div><span>路径</span><strong title={item.path ?? ""}>{item.path ?? "未加入 PATH"}</strong></div>
                    </div>
                    <div className="sp-env-message" title={item.detail ?? item.message}>{item.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="sp-brand-footer">
            <img className="sp-brand-logo" src={arisIcon} alt="ARIS" />
            <span className="sp-brand-copy">SomniQ Studio</span>
          </div>
        </div>
      )}
    </div>
  );
}

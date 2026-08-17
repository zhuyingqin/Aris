import type { Language } from "../store";
import type { ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";

export interface PresetOption {
  label: string;
  value: string;
  hint?: string;
  hintKey?: string;
  copyKey?: "official" | "managedModelServer";
}

/** Shape of the `EXECUTOR_PROVIDERS`/`REVIEWER_PROVIDERS` entries below; not part of this module's public surface. */
interface ProviderMeta {
  defaultModel: string;
  defaultBaseUrl?: string;
  models?: PresetOption[];
  baseUrls?: PresetOption[];
}

export const MANAGED_MODEL_SERVER_BASE_URL = "http://106.53.28.124:18080";

export const EXECUTOR_MODELS: PresetOption[] = [
  { label: "Claude Opus 4.7", value: "claude-opus-4-7", hintKey: "anthropic" },
  { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hintKey: "anthropic" },
  { label: "GPT-5.5", value: "gpt-5.5", hintKey: "openaiCompatible" },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro", hintKey: "googleOpenAiCompatible" },
  { label: "GLM-5", value: "GLM-5", hintKey: "zhipu" },
  { label: "MiniMax M3", value: "MiniMax-M3", hintKey: "minimax" },
  { label: "MiniMax M2.7", value: "MiniMax-M2.7", hintKey: "minimax" },
  { label: "Kimi K2.5", value: "kimi-k2.5", hintKey: "moonshot" },
  { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro", hintKey: "deepseek" },
  { label: "Qwen 3.6 Plus", value: "qwen3.6-plus", hintKey: "dashscope" },
  { label: "Doubao Pro 4K", value: "doubao-pro-4k", hintKey: "ark" },
];

export const REVIEWER_MODELS: PresetOption[] = [
  { label: "GPT-5.5", value: "gpt-5.5", hintKey: "openai" },
  { label: "GPT-5.4", value: "gpt-5.4", hintKey: "openai" },
  { label: "GPT-4o", value: "gpt-4o", hintKey: "openai" },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro", hintKey: "google" },
  { label: "GLM-5", value: "GLM-5", hintKey: "zhipu" },
  { label: "MiniMax M3", value: "MiniMax-M3", hintKey: "minimax" },
  { label: "MiniMax M2.7", value: "MiniMax-M2.7", hintKey: "minimax" },
  { label: "Kimi K2.5", value: "kimi-k2.5", hintKey: "moonshot" },
  { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro", hintKey: "deepseek" },
  { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hintKey: "anthropicCompatible" },
];

export const OPENAI_COMPAT_URLS: PresetOption[] = [
  // Label is a language-agnostic fallback; PresetTextInput swaps it for
  // `copy.managedModelServerLabel` when rendering (this URL always matches
  // `isManagedModelServerUrl`).
  { label: "", value: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`, copyKey: "managedModelServer" },
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

export const ANTHROPIC_URLS: PresetOption[] = [
  { label: "", value: "", copyKey: "official" },
  { label: "Anthropic API", value: "https://api.anthropic.com" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];

export const ANTHROPIC_COMPAT_URLS: PresetOption[] = [
  { label: "", value: "https://api.anthropic.com", copyKey: "official" },
  { label: "MiniMax", value: "https://api.minimaxi.com/anthropic" },
  { label: "DeepSeek", value: "https://api.deepseek.com/anthropic" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];

export const EXECUTOR_PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: {
    defaultModel: "claude-opus-4-7",
    models: EXECUTOR_MODELS.filter((model) => model.hintKey === "anthropic"),
    baseUrls: ANTHROPIC_URLS,
  },
  "anthropic-compat": {
    defaultModel: "claude-sonnet-4-6",
    models: [
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "MiniMax M3", value: "MiniMax-M3" },
      { label: "DeepSeek V4 Pro", value: "deepseek-v4-pro" },
    ],
    baseUrls: ANTHROPIC_COMPAT_URLS,
  },
  openai: {
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    models: EXECUTOR_MODELS.filter((model) => model.hintKey !== "anthropic"),
    baseUrls: OPENAI_COMPAT_URLS,
  },
  custom: {
    defaultModel: "",
    models: EXECUTOR_MODELS,
    baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((url) => url.value)],
  },
};

export const REVIEWER_PROVIDERS: Record<string, ProviderMeta> = {
  "": { defaultModel: "" },
  openai: {
    defaultModel: "gpt-5.5",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: REVIEWER_MODELS.filter((model) => ["openai", "minimax", "moonshot", "deepseek"].includes(model.hintKey ?? "")),
    baseUrls: OPENAI_COMPAT_URLS,
  },
  gemini: {
    defaultModel: "gemini-2.5-pro",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: REVIEWER_MODELS.filter((model) => model.hintKey === "google"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "Gemini"),
  },
  glm: {
    defaultModel: "GLM-5",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: REVIEWER_MODELS.filter((model) => model.hintKey === "zhipu"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "GLM"),
  },
  minimax: {
    defaultModel: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    models: REVIEWER_MODELS.filter((model) => model.hintKey === "minimax"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "MiniMax"),
  },
  kimi: {
    defaultModel: "kimi-k2.5",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    models: REVIEWER_MODELS.filter((model) => model.hintKey === "moonshot"),
    baseUrls: OPENAI_COMPAT_URLS.filter((url) => url.label === "Kimi"),
  },
  deepseek: {
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    models: REVIEWER_MODELS.filter((model) => model.hintKey === "deepseek"),
    baseUrls: ANTHROPIC_COMPAT_URLS.filter((url) => url.label === "DeepSeek"),
  },
  "anthropic-compat": {
    defaultModel: "claude-sonnet-4-6",
    defaultBaseUrl: "https://api.anthropic.com",
    models: REVIEWER_MODELS.filter((model) => ["anthropicCompatible", "minimax", "deepseek"].includes(model.hintKey ?? "")),
    baseUrls: ANTHROPIC_COMPAT_URLS,
  },
  custom: {
    defaultModel: "",
    models: REVIEWER_MODELS,
    baseUrls: [...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS.filter((url) => url.value)],
  },
};

export function uniqueModelList(...groups: Array<Array<string | null | undefined> | null | undefined>): string[] {
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

export function normalizeExecutorProvider(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  const current = provider || "anthropic";
  const lower = (baseUrl ?? "").trim().toLowerCase();
  if (current === "anthropic" && (lower.includes("minimaxi.com/anthropic") || lower.includes("deepseek.com/anthropic"))) {
    return "anthropic-compat";
  }
  return current in EXECUTOR_PROVIDERS ? current : "custom";
}

export function normalizeReviewerProvider(provider: string | null | undefined): string {
  const current = provider || "";
  if (current === "anthropic") return "anthropic-compat";
  return current in REVIEWER_PROVIDERS ? current : "custom";
}

export function detectProtocol(url: string): string {
  if (!url.trim()) return "anthropic";
  const lower = url.toLowerCase();
  if (lower.includes("anthropic.com") || lower.includes("newcli.com") || lower.includes("modelscope.cn") || lower.includes("/anthropic")) {
    return "anthropic-compat";
  }
  return "openai";
}

export function isManagedModelServerUrl(value: string | null | undefined): boolean {
  const normalized = (value ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^https?:\/\//i, "")
    .toLowerCase();
  return normalized === "106.53.28.124:18080"
    || normalized === "106.53.28.124:18080/v1";
}

export function displayServerValue(value: string, language: Language): string {
  return isManagedModelServerUrl(value) ? SETTINGS_COPY[language].providers.managedModelServerLabel : value;
}

export function hideManagedServerAddress(value: string, language: Language): string {
  return value.replace(/(?:https?:\/\/)?106\.53\.28\.124:18080(?:\/v1)?/gi, SETTINGS_COPY[language].providers.managedModelServerLabel);
}

export function suggestModels(url: string): string[] {
  const lower = url.toLowerCase();
  if (isManagedModelServerUrl(lower)) return ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5"];
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

export function formatServerLabel(server: string, language: Language, provider?: string): string {
  const copy = SETTINGS_COPY[language].providers;
  const source = server.trim() || provider?.trim() || "";
  if (!source || source === "unknown") return copy.unknownLabel;
  if (isManagedModelServerUrl(source)) return copy.managedModelServerLabel;
  if (source === "OpenAI-compatible") return copy.protocolOpenAiCompatible;
  if (source === "Anthropic-compatible") return copy.protocolAnthropicCompatible;
  try {
    const url = new URL(source);
    return url.host || source;
  } catch {
    return source;
  }
}

export function configuredServerLabel(config: ConfigView, language: Language): string {
  const baseUrl = config.executorBaseUrl?.trim();
  if (baseUrl) return formatServerLabel(baseUrl, language, config.executorProvider ?? undefined);
  return config.executorProvider === "anthropic" ? "api.anthropic.com" : (config.executorProvider || SETTINGS_COPY[language].providers.serverNotConfigured);
}

export function providerKey(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  return `${provider?.trim() || detectProtocol(baseUrl ?? "")}::${(baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase()}`;
}

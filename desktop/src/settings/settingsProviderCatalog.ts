import { MANAGED_NEWAPI_BASE_URL, isLegacyManagedNewApiUrl } from "../managedNewApi";

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

export const MANAGED_MODEL_SERVER_BASE_URL = MANAGED_NEWAPI_BASE_URL;

export const EXECUTOR_MODELS: PresetOption[] = [
  { label: "Claude Opus 4.7", value: "claude-opus-4-7", hintKey: "anthropic" },
  { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6", hintKey: "anthropic" },
  { label: "Claude Fable 5.1", value: "claude-fable-5.1", hintKey: "anthropic" },
  { label: "Claude Fable 5", value: "claude-fable-5", hintKey: "anthropic" },
  { label: "GPT-6 Astra", value: "gpt-6-astra", hintKey: "openaiCompatible" },
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
  { label: "GPT-6 Astra", value: "gpt-6-astra", hintKey: "openai" },
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
  { label: "Claude Opus 4.7", value: "claude-opus-4-7", hintKey: "anthropicCompatible" },
  { label: "Claude Fable 5.1", value: "claude-fable-5.1", hintKey: "anthropicCompatible" },
  { label: "Claude Fable 5", value: "claude-fable-5", hintKey: "anthropicCompatible" },
];

export const OPENAI_COMPAT_URLS: PresetOption[] = [
  // Label is a language-agnostic fallback; PresetTextInput swaps it for
  // `copy.managedModelServerLabel` when rendering (this URL always matches
  // `isManagedModelServerUrl`).
  ...(MANAGED_MODEL_SERVER_BASE_URL
    ? [{ label: "", value: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`, copyKey: "managedModelServer" as const }]
    : []),
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
  opencode: { defaultModel: "", models: EXECUTOR_MODELS },
  anthropic: {
    defaultModel: "claude-opus-4-7",
    models: EXECUTOR_MODELS.filter((model) => model.hintKey === "anthropic"),
    baseUrls: ANTHROPIC_URLS,
  },
  "anthropic-compat": {
    defaultModel: "claude-sonnet-4-6",
    models: [
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Fable 5.1", value: "claude-fable-5.1" },
      { label: "Claude Fable 5", value: "claude-fable-5" },
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
  opencode: { defaultModel: "", models: REVIEWER_MODELS },
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
  if (isLegacyManagedNewApiUrl(value)) return true;
  const normalized = (value ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const managed = MANAGED_MODEL_SERVER_BASE_URL.toLowerCase();
  return !!managed && (normalized === managed || normalized === `${managed}/v1`);
}

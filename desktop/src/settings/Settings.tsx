import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  appRelaunch,
  appUpdateCheck,
  appUpdateDownloadAndInstall,
  configGet,
  configSecretClear,
  configSecretGet,
  configSet,
  configTest,
  isTauri,
  localEnvironmentChecks,
  newapiBootstrap,
  newapiGroups,
  newapiModels,
  newapiUpdateGroup,
  newapiUsageLogs,
  systemPromptView,
  userPromptView,
  webSearchProviderTest,
  type NewApiAccount,
  type NewApiGroupOption,
  type NewApiUsageLogPage,
} from "../api/tauri";
import { isManagedAuthInvalidError, useStore, type Language } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import { handoffEnvironmentInstall, isInstallableEnvironment } from "../environmentInstall";
import { notifyChatModelsUpdated } from "../modelEvents";
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestDetail,
  ConfigTestResult,
  ConfigView,
  LocalEnvironmentCheck,
  SystemPromptView,
  UserPromptView,
} from "../types";
import { MailSettingsDetail } from "./MailSettings";
import MemorySettings from "./MemorySettings";
import RemoteControlPanel from "./RemoteControlPanel";
import Profile from "./Profile";
import Extensions from "../extensions/Extensions";
import {
  ADMIN_ACCOUNT_CONTAINS_MARKERS,
  ADMIN_ACCOUNT_EXACT_MARKERS,
  SETTINGS_COPY,
  type SettingsGeneralCopy,
} from "./i18n";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_GROUP_LABELS,
  SETTINGS_NAV_LABELS,
  SETTINGS_NAV_MISC,
  resolveLegacySettingsNav,
  type SettingsNavId,
} from "./settingsNav";

interface PresetOption {
  label: string;
  value: string;
  hint?: string;
  hintKey?: string;
  copyKey?: "official" | "managedModelServer";
}

interface ProviderMeta {
  defaultModel: string;
  defaultBaseUrl?: string;
  models?: PresetOption[];
  baseUrls?: PresetOption[];
}

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "passed" | "failed";
type UpdateState = "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "error";
type SettingsTab = SettingsNavId;

const MANAGED_NEW_API_MODE = true;
const MANAGED_MODEL_SERVER_BASE_URL = "http://106.53.28.124:18080";
const ACCOUNT_CACHE_KEY = "somniq-account-v1";
const LEGACY_ACCOUNT_CACHE_KEY = "aris-account-v1";
const SETTINGS_TAB_REQUEST_KEY = "somniq-settings-tab-request";
const SETTINGS_TAB_REQUEST_EVENT = "somniq-settings-tab-request";
const USAGE_LOG_PAGE_SIZE = 12;
interface PreviewSettingsData {
  configView: ConfigView;
  account: NewApiAccount;
  groupOptions: NewApiGroupOption[];
  usageLogs: NewApiUsageLogPage;
  systemPrompt: SystemPromptView;
  userPrompt: UserPromptView;
}

function buildPreviewSettingsData(language: Language, copy: SettingsGeneralCopy): PreviewSettingsData {
  const configView: ConfigView = {
    appVersion: "0.4.26",
    configPath: copy.previewConfigPath,
    executorProvider: "openai",
    executorModel: "MiniMax-M3",
    executorBaseUrl: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`,
    summarizerProvider: "",
    summarizerModel: "",
    retrievalCardModel: "",
    summarizerBaseUrl: "",
    hasSummarizerKey: false,
    hasExecutorKey: true,
    executorKeyMasked: "sk-...preview",
    reviewerProvider: "openai",
    reviewerModel: "MiniMax-M3",
    reviewerBaseUrl: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`,
    reviewEnabled: false,
    hasReviewerKey: true,
    reviewerKeyMasked: "sk-...preview",
    hasScopusKey: false,
    hasOpenalexKey: false,
    hasBraveSearchKey: false,
    hasExaKey: false,
    hasZhihuAccessSecret: false,
    language,
    memoryWriteApproval: true,
    managedModels: ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5", "GLM-5", "deepseek-v4-pro"],
  // Transports mirror what the gateway actually serves: OpenAI-family
  // reasoning models get `/v1/responses`, everything else chat/completions.
    verifiedExecutors: [
      {
        provider: "openai",
        model: "MiniMax-M3",
        baseUrl: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`,
        transport: "chat_completions",
      },
      {
        provider: "openai",
        model: "gpt-5.5",
        baseUrl: `${MANAGED_MODEL_SERVER_BASE_URL}/v1`,
        transport: "responses",
      },
    ],
  };
  const account: NewApiAccount = {
    username: "preview-user",
    displayName: copy.previewDisplayName,
    role: 10,
    isAdmin: true,
    subscriptionName: copy.previewSubscriptionName,
    subscriptionDesc: copy.previewSubscriptionDescription,
    subscriptionQuota: 1_850_000,
    subscriptionUsedQuota: 650_000,
    group: "default",
    groupDesc: copy.previewStandardGroupDescription,
    groupRatio: "1",
    quota: 1_250_000,
    usedQuota: 750_000,
    models: ["MiniMax-M3", "MiniMax-M2.7", "gpt-5.5", "GLM-5", "deepseek-v4-pro"],
    model: "MiniMax-M3",
  };
  const groupOptions: NewApiGroupOption[] = [
    { name: "default", desc: copy.previewStandardGroupDescription, ratio: "1" },
    { name: "research", desc: copy.previewResearchGroupDescription, ratio: "0.8" },
    { name: "premium", desc: copy.previewPremiumGroupDescription, ratio: "1.5" },
  ];
  const usageLogs: NewApiUsageLogPage = {
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
        typeLabel: copy.previewUsageType,
      },
      {
        id: "preview-2",
        createdAt: Math.floor(Date.now() / 1000) - 3600,
        model: "gpt-5.5",
        tokenName: "somniq-desktop",
        channel: SETTINGS_COPY[language].providers.protocolOpenAiCompatible,
        requestId: "req_preview_001928375",
        upstreamRequestId: "",
        promptTokens: 2310,
        completionTokens: 780,
        totalTokens: 3090,
        quota: 4100,
        status: "success",
        typeLabel: copy.previewUsageType,
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
        typeLabel: copy.previewUsageType,
      },
    ],
  };
  const systemPrompt: SystemPromptView = {
    model: configView.executorModel ?? "preview-model",
    fullToolRegistry: true,
    sections: 3,
    characters: copy.previewSystemPrompt.length,
    prompt: copy.previewSystemPrompt,
  };
  const userPrompt: UserPromptView = {
    sessionId: "preview-session",
    surface: copy.previewUserPromptSurface,
    capturedAt: Math.floor(Date.now() / 1000),
    blocks: 1,
    images: 0,
    characters: copy.previewUserPrompt.length,
    prompt: copy.previewUserPrompt,
  };
  return { configView, account, groupOptions, usageLogs, systemPrompt, userPrompt };
}

const PREVIEW_SETTINGS_DATA: Record<Language, PreviewSettingsData> = {
  cn: buildPreviewSettingsData("cn", SETTINGS_COPY.cn.general),
  en: buildPreviewSettingsData("en", SETTINGS_COPY.en.general),
};

let usageLogPageCache: Record<number, NewApiUsageLogPage> = {};
// Category labels for these ids are resolved via `environmentCategoryLabel`,
// which already has a localized cn/en map; `label` below is only the
// language-agnostic fallback if an id isn't found there.
const ENVIRONMENT_CHECK_PLACEHOLDERS = [
  { id: "python", label: "Python" },
  { id: "jupyter", label: "Jupyter" },
  { id: "matlab", label: "MATLAB" },
  { id: "latex", label: "LaTeX" },
];

function normalizeLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "cn";
}

const EXECUTOR_MODELS: PresetOption[] = [
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

const REVIEWER_MODELS: PresetOption[] = [
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

const OPENAI_COMPAT_URLS: PresetOption[] = [
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

const ANTHROPIC_URLS: PresetOption[] = [
  { label: "", value: "", copyKey: "official" },
  { label: "Anthropic API", value: "https://api.anthropic.com" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];

const ANTHROPIC_COMPAT_URLS: PresetOption[] = [
  { label: "", value: "https://api.anthropic.com", copyKey: "official" },
  { label: "MiniMax", value: "https://api.minimaxi.com/anthropic" },
  { label: "DeepSeek", value: "https://api.deepseek.com/anthropic" },
  { label: "NewCLI", value: "https://code.newcli.com/claude" },
  { label: "ModelScope", value: "https://api-inference.modelscope.cn" },
];

const EXECUTOR_PROVIDERS: Record<string, ProviderMeta> = {
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

const REVIEWER_PROVIDERS: Record<string, ProviderMeta> = {
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

function readRequestedSettingsTab(): SettingsTab | null {
  try {
    const value = sessionStorage.getItem(SETTINGS_TAB_REQUEST_KEY);
    const resolved = resolveLegacySettingsNav(value);
    if (resolved) {
      sessionStorage.removeItem(SETTINGS_TAB_REQUEST_KEY);
      return resolved;
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
    return ADMIN_ACCOUNT_EXACT_MARKERS.some((marker) => lower === marker)
      || ADMIN_ACCOUNT_CONTAINS_MARKERS.some((marker) => text.includes(marker));
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

function usageLogMeta(status: string, typeLabel: string, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  const normalizedStatus = status.trim().toLowerCase();
  const statusLabel = normalizedStatus === "success"
    ? copy.usageStatusSuccess
    : normalizedStatus === "failed" || normalizedStatus === "error"
      ? copy.usageStatusFailed
      : status.trim();
  const normalizedType = typeLabel.trim().toLowerCase();
  const type = normalizedType === "consume" ? copy.usageTypeConsume : typeLabel.trim();
  return [type, statusLabel].filter(Boolean).join(" · ");
}

function EnvironmentIcon({ id }: { id: string }) {
  const icon = id === "python"
    ? "code"
    : id === "jupyter"
      ? "notebook"
      : id === "matlab"
        ? "graph"
        : "document";
  return <SvgIcon name={icon} size={19} />;
}

function environmentStatusLabel(item: LocalEnvironmentCheck, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  if (item.status === "ready") return copy.envStatusReady;
  if (item.status === "warning") return copy.envStatusWarning;
  return item.available ? copy.envStatusReady : copy.envStatusMissing;
}

function environmentCategoryLabel(id: string, language: Language, fallback: string): string {
  const categories = SETTINGS_COPY[language].general.envCategories;
  return categories[id as keyof typeof categories] ?? fallback;
}

function environmentMessage(item: LocalEnvironmentCheck, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  if (item.available && item.status === "warning") return copy.envExecutableWarning;
  if (item.available) return copy.envAvailable;
  if (isInstallableEnvironment(item.id)) return copy.envMissingInstallable(item.label);
  return copy.envMissing(item.label);
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

function isManagedModelServerUrl(value: string | null | undefined): boolean {
  const normalized = (value ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^https?:\/\//i, "")
    .toLowerCase();
  return normalized === "106.53.28.124:18080"
    || normalized === "106.53.28.124:18080/v1";
}

function displayServerValue(value: string, language: Language): string {
  return isManagedModelServerUrl(value) ? SETTINGS_COPY[language].providers.managedModelServerLabel : value;
}

function hideManagedServerAddress(value: string, language: Language): string {
  return value.replace(/(?:https?:\/\/)?106\.53\.28\.124:18080(?:\/v1)?/gi, SETTINGS_COPY[language].providers.managedModelServerLabel);
}

function suggestModels(url: string): string[] {
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

function formatServerLabel(server: string, language: Language, provider?: string): string {
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

function configuredServerLabel(config: ConfigView, language: Language): string {
  const baseUrl = config.executorBaseUrl?.trim();
  if (baseUrl) return formatServerLabel(baseUrl, language, config.executorProvider ?? undefined);
  return config.executorProvider === "anthropic" ? "api.anthropic.com" : (config.executorProvider || SETTINGS_COPY[language].providers.serverNotConfigured);
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
  formatValue,
}: {
  value: string;
  placeholder: string;
  options: PresetOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  formatValue?: (value: string) => string;
}) {
  const language = useStore((state) => state.language);
  const copy = SETTINGS_COPY[language].providers;
  const currentPreset = options.find((option) => option.value === value)?.value ?? "__custom";
  const inputValue = formatValue ? formatValue(value) : value;
  const displayOnlyValue = inputValue !== value;
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
        <option value="__custom">{copy.presetCustom}</option>
        {options.map((option) => {
          const optionLabel = isManagedModelServerUrl(option.value)
            ? copy.managedModelServerLabel
            : option.copyKey === "official"
              ? copy.presetOfficial
              : option.label;
          const optionHint = option.hint ?? (option.hintKey ? copy.presetHints[option.hintKey] : "");
          return (
            <option key={`${option.label}:${option.value || "blank"}`} value={option.value}>
              {optionLabel}{optionHint ? ` - ${optionHint}` : ""}
            </option>
          );
        })}
      </select>
      <input
        value={inputValue}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        disabled={disabled}
        readOnly={displayOnlyValue}
      />
    </div>
  );
}

function KeyInput({
  value,
  placeholder,
  masked,
  secretKind,
  onChange,
  language,
  disabled = false,
}: {
  value: string;
  placeholder: string;
  masked: string | null | undefined;
  secretKind: ConfigSecretKind;
  onChange: (value: string) => void;
  language: Language;
  disabled?: boolean;
}) {
  const keyCopy = SETTINGS_COPY[language].providers;
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
        else setError(keyCopy.keyNoSavedSecret);
      } catch (err) {
        setError(formatUserFacingError(err, language));
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
        title={error || (visible ? keyCopy.keyHideSecret : keyCopy.keyShowSecret)}
      >
        {loading ? "..." : visible ? keyCopy.keyHide : keyCopy.keyShow}
      </button>
      {error && <span className="st-key-error">{error}</span>}
    </div>
  );
}

function TestDetail({ detail, language }: { detail: ConfigTestResult["executor"]; language: Language }) {
  return (
    <div className={`st-test-detail${detail.ok ? " ok" : " failed"}`}>
      <div className="st-test-detail-head">
        <span className="st-test-dot" />
        <span className="st-test-label">{detail.label}</span>
        {detail.model && <span className="st-test-meta">{detail.model}</span>}
      </div>
      <div className="st-test-message">{hideManagedServerAddress(detail.message, language)}</div>
      {detail.baseUrl && <div className="st-test-url">{formatServerLabel(detail.baseUrl, language)}</div>}
    </div>
  );
}

export default function Settings() {
  const setError = useStore((state) => state.setError);
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const language = useStore((state) => state.language);
  const setLanguage = useStore((state) => state.setLanguage);
  const logout = useStore((state) => state.logout);
  const setTab = useStore((state) => state.setTab);
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const previewData = PREVIEW_SETTINGS_DATA[language];
  const PREVIEW_CONFIG_VIEW = previewData.configView;
  const PREVIEW_ACCOUNT = previewData.account;
  const PREVIEW_GROUP_OPTIONS = previewData.groupOptions;
  const PREVIEW_USAGE_LOGS = previewData.usageLogs;
  const PREVIEW_SYSTEM_PROMPT = previewData.systemPrompt;
  const PREVIEW_USER_PROMPT = previewData.userPrompt;
  const SUMMARIZER_MODELS: PresetOption[] = [
    { label: copy.summaryAutoLabel, value: "", hint: copy.summaryAutoHint },
    { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", hint: copy.summaryFastHint },
    { label: copy.summaryOffLabel, value: "off", hint: copy.summaryOffHint },
  ];
  const [configView, setConfigView] = useState<ConfigView | null>(() => isTauri() ? null : PREVIEW_CONFIG_VIEW);
  const [advForm, setAdvForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [summaryKey, setSummaryKey] = useState("");
  const [reviewerKey, setReviewerKey] = useState("");
  const [scopusKey, setScopusKey] = useState("");
  const [openalexKey, setOpenalexKey] = useState("");
  const [braveSearchKey, setBraveSearchKey] = useState("");
  const [exaKey, setExaKey] = useState("");
  const [zhihuAccessSecret, setZhihuAccessSecret] = useState("");
  const [summaryToolsOpen, setSummaryToolsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [webProviderTestState, setWebProviderTestState] = useState<
    Partial<Record<"brave" | "exa" | "zhihu", ConfigTestDetail & { testing?: boolean }>>
  >({});
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [environmentChecks, setEnvironmentChecks] = useState<LocalEnvironmentCheck[]>([]);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentError, setEnvironmentError] = useState("");
  const [environmentCheckedAt, setEnvironmentCheckedAt] = useState<number | null>(null);
  const [pythonEnvironmentPath, setPythonEnvironmentPath] = useState("");
  const [pythonEnvironmentSaving, setPythonEnvironmentSaving] = useState(false);
  const [pythonEnvironmentSaved, setPythonEnvironmentSaved] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageLogPage, setUsageLogPage] = useState(1);
  const [usageLogPages, setUsageLogPages] = useState<Record<number, NewApiUsageLogPage>>(() =>
    isTauri() ? usageLogPageCache : { [PREVIEW_USAGE_LOGS.page]: PREVIEW_USAGE_LOGS },
  );
  const [usageLogs, setUsageLogs] = useState<NewApiUsageLogPage | null>(() =>
    isTauri() ? usageLogPageCache[1] ?? null : PREVIEW_USAGE_LOGS,
  );
  const [usageLogError, setUsageLogError] = useState("");
  const [managedModels, setManagedModels] = useState<string[]>(() => isTauri() ? [] : PREVIEW_CONFIG_VIEW.managedModels ?? []);
  const [managedModelsLoading, setManagedModelsLoading] = useState(false);
  const [managedModelsError, setManagedModelsError] = useState("");
  const [account, setAccount] = useState<NewApiAccount | null>(() => isTauri() ? readCachedAccount() : PREVIEW_ACCOUNT);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [groupOptions, setGroupOptions] = useState<NewApiGroupOption[]>(() => isTauri() ? [] : PREVIEW_GROUP_OPTIONS);
  const [groupDraft, setGroupDraft] = useState(() => isTauri() ? readCachedAccount()?.group ?? "" : PREVIEW_ACCOUNT.group);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupError, setGroupError] = useState("");
  const [systemPrompt, setSystemPrompt] = useState<SystemPromptView | null>(() => isTauri() ? null : PREVIEW_SYSTEM_PROMPT);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const [systemPromptError, setSystemPromptError] = useState("");
  const [userPrompt, setUserPrompt] = useState<UserPromptView | null>(() => isTauri() ? null : PREVIEW_USER_PROMPT);
  const [userPromptOpen, setUserPromptOpen] = useState(false);
  const [userPromptLoading, setUserPromptLoading] = useState(false);
  const [userPromptError, setUserPromptError] = useState("");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(() => readRequestedSettingsTab() ?? "general");
  const savedTimer = useRef<number | null>(null);
  const usageLogPagesRef = useRef(usageLogPages);
  const usageRefreshPendingRef = useRef(false);

  const loadConfig = (view: ConfigView) => {
    const nextLanguage = normalizeLanguage(view.language);
    setLanguage(nextLanguage);
    setConfigView(view);
    setPythonEnvironmentPath(view.pythonEnvironmentPath ?? "");
    setAdvForm({
      executorProvider: normalizeExecutorProvider(view.executorProvider, view.executorBaseUrl),
      executorModel: view.executorModel ?? "",
      executorBaseUrl: view.executorBaseUrl ?? "",
      summarizerProvider: view.summarizerProvider ?? "",
      summarizerModel: view.summarizerModel ?? "",
      retrievalCardModel: view.retrievalCardModel ?? "",
      summarizerBaseUrl: view.summarizerBaseUrl ?? "",
      reviewerProvider: normalizeReviewerProvider(view.reviewerProvider),
      reviewerModel: view.reviewerModel ?? "",
      reviewerBaseUrl: view.reviewerBaseUrl ?? "",
      language: nextLanguage,
      memoryWriteApproval: view.memoryWriteApproval,
    });
    setExecKey("");
    setSummaryKey("");
    setReviewerKey("");
    setScopusKey("");
    setBraveSearchKey("");
    setExaKey("");
    setZhihuAccessSecret("");
  };

  useEffect(() => {
    if (!isTauri()) return;
    configGet().then(loadConfig).catch((error) => setError(String(error)));
  }, [setError]);

  useEffect(() => {
    if (isTauri()) return;
    setConfigView(PREVIEW_CONFIG_VIEW);
    setManagedModels(PREVIEW_CONFIG_VIEW.managedModels ?? []);
    setAccount(PREVIEW_ACCOUNT);
    setGroupOptions(PREVIEW_GROUP_OPTIONS);
    setGroupDraft(PREVIEW_ACCOUNT.group);
    const previewPages = { [PREVIEW_USAGE_LOGS.page]: PREVIEW_USAGE_LOGS };
    setUsageLogPages(previewPages);
    usageLogPagesRef.current = previewPages;
    usageLogPageCache = previewPages;
    setUsageLogs(PREVIEW_USAGE_LOGS);
    setSystemPrompt(PREVIEW_SYSTEM_PROMPT);
    setUserPrompt(PREVIEW_USER_PROMPT);
  }, [language]);

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    usageLogPagesRef.current = usageLogPages;
  }, [usageLogPages]);

  const cacheUsageLogPage = (pageData: NewApiUsageLogPage, reset = false) => {
    setUsageLogPages((current) => {
      const next = reset ? {} : { ...current };
      next[pageData.page] = pageData;
      usageLogPagesRef.current = next;
      usageLogPageCache = next;
      return next;
    });
    setUsageLogs(pageData);
  };

  const loadUsageSummary = async (page = usageLogPage, options: { force?: boolean; refreshAccount?: boolean } = {}) => {
    const cachedLogs = usageLogPagesRef.current[page];
    if (!options.force && cachedLogs) {
      setUsageLogs(cachedLogs);
      setUsageLogError("");
      return;
    }
    if (!isTauri()) {
      cacheUsageLogPage({ ...PREVIEW_USAGE_LOGS, page });
      return;
    }
    setUsageLoading(true);
    setUsageLogError("");
    try {
      if (options.refreshAccount || !account) {
        await loadAccount();
      }
      const nextLogs = await newapiUsageLogs(page, USAGE_LOG_PAGE_SIZE);
      cacheUsageLogPage(nextLogs, options.force);
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setUsageLogError(message);
      if (cachedLogs) {
        setUsageLogs(cachedLogs);
      }
      setError(message);
    } finally {
      setUsageLoading(false);
    }
  };

  const refreshUsage = () => {
    const firstPage = 1;
    setUsageLogPages({});
    usageLogPagesRef.current = {};
    usageLogPageCache = {};
    setUsageLogs(null);
    usageRefreshPendingRef.current = true;
    if (usageLogPage === firstPage) {
      void loadUsageSummary(firstPage, { force: true, refreshAccount: true });
      usageRefreshPendingRef.current = false;
    } else {
      setUsageLogPage(firstPage);
    }
  };

  const goToUsageLogPage = (page: number) => {
    const nextPage = Math.max(1, page);
    setUsageLogs(usageLogPagesRef.current[nextPage] ?? null);
    setUsageLogError("");
    setUsageLogPage(nextPage);
  };

  const loadEnvironmentChecks = async () => {
    setEnvironmentLoading(true);
    setEnvironmentError("");
    try {
      setEnvironmentChecks(await localEnvironmentChecks());
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      setEnvironmentLoading(false);
    }
  };

  const choosePythonEnvironment = async () => {
    if (!isTauri()) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: copy.pythonEnvironmentBrowseTitle,
      });
      if (typeof selected === "string") {
        setPythonEnvironmentPath(selected);
        setPythonEnvironmentSaved(false);
      }
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    }
  };

  const savePythonEnvironment = async () => {
    setPythonEnvironmentSaving(true);
    setPythonEnvironmentSaved(false);
    setEnvironmentError("");
    try {
      if (!isTauri()) {
        setPythonEnvironmentSaved(true);
        return;
      }
      const next = await configSet({
        pythonEnvironmentPath: pythonEnvironmentPath.trim(),
      });
      loadConfig(next);
      setEnvironmentLoading(true);
      setEnvironmentChecks(await localEnvironmentChecks(true));
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
      setPythonEnvironmentSaved(true);
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      setEnvironmentLoading(false);
      setPythonEnvironmentSaving(false);
    }
  };

  const loadSystemPrompt = async () => {
    if (!isTauri()) {
      setSystemPrompt(PREVIEW_SYSTEM_PROMPT);
      return;
    }
    setSystemPromptLoading(true);
    setSystemPromptError("");
    try {
      setSystemPrompt(await systemPromptView());
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setSystemPromptError(message);
      setError(message);
    } finally {
      setSystemPromptLoading(false);
    }
  };

  const loadUserPrompt = async () => {
    if (!isTauri()) {
      setUserPrompt(PREVIEW_USER_PROMPT);
      return;
    }
    setUserPromptLoading(true);
    setUserPromptError("");
    try {
      setUserPrompt(await userPromptView());
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setUserPromptError(message);
      setError(message);
    } finally {
      setUserPromptLoading(false);
    }
  };

  const loadManagedModels = async () => {
    if (!MANAGED_NEW_API_MODE) return;
    if (!isTauri()) {
      setManagedModels(PREVIEW_CONFIG_VIEW.managedModels ?? []);
      setConfigView(PREVIEW_CONFIG_VIEW);
      notifyChatModelsUpdated();
      return;
    }
    setManagedModelsLoading(true);
    setManagedModelsError("");
    try {
      const models = await newapiModels();
      setManagedModels(models);
      setConfigView((current) => current ? { ...current, managedModels: models } : current);
      notifyChatModelsUpdated();
    } catch (error) {
      setManagedModels([]);
      setManagedModelsError(formatUserFacingError(error, language));
    } finally {
      setManagedModelsLoading(false);
    }
  };

  const loadGroupOptions = async () => {
    if (!MANAGED_NEW_API_MODE) return;
    if (!isTauri()) {
      setGroupOptions(PREVIEW_GROUP_OPTIONS);
      return;
    }
    setGroupLoading(true);
    setGroupError("");
    try {
      setGroupOptions(await newapiGroups());
    } catch (error) {
      setGroupError(formatUserFacingError(error, language));
    } finally {
      setGroupLoading(false);
    }
  };

  const loadAccount = async () => {
    if (!MANAGED_NEW_API_MODE) return;
    if (!isTauri()) {
      setAccount(PREVIEW_ACCOUNT);
      setGroupDraft(PREVIEW_ACCOUNT.group);
      return;
    }
    setAccountLoading(true);
    setAccountError("");
    try {
      const next = await newapiBootstrap();
      setAccount(next);
      setGroupDraft(next.group);
      if (next.models.length > 0) {
        setManagedModels(next.models);
        setConfigView((current) => current ? { ...current, managedModels: next.models } : current);
        notifyChatModelsUpdated();
      }
      writeCachedAccount(next);
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setAccountError(message);
      if (isManagedAuthInvalidError(error)) {
        writeCachedAccount(null);
        logout();
      }
    } finally {
      setAccountLoading(false);
    }
  };

  const saveAccountGroup = async () => {
    const nextGroup = groupDraft.trim();
    if (!nextGroup || !account || nextGroup === account.group) return;
    setGroupSaving(true);
    setGroupError("");
    try {
      const next = isTauri()
        ? await newapiUpdateGroup(nextGroup)
        : { ...PREVIEW_ACCOUNT, group: nextGroup };
      setAccount(next);
      setGroupDraft(next.group);
      if (next.models.length > 0) {
        setManagedModels(next.models);
        setConfigView((current) => current ? { ...current, managedModels: next.models } : current);
        notifyChatModelsUpdated();
      }
      writeCachedAccount(next);
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setGroupError(message);
      setError(message);
    } finally {
      setGroupSaving(false);
    }
  };

  useEffect(() => {
    if (!isTauri()) return;
    void loadManagedModels();
    void loadGroupOptions();
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
      const resolved = typeof detail === "string" ? resolveLegacySettingsNav(detail) : null;
      if (resolved) {
        openRequestedTab(resolved);
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
    if (activeSettingsTab === "environment" && environmentChecks.length === 0 && !environmentError && !environmentLoading) {
      void loadEnvironmentChecks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSettingsTab, environmentChecks.length, environmentError, environmentLoading]);

  useEffect(() => {
    if (activeSettingsTab === "general" && systemPromptOpen && !systemPrompt && !systemPromptLoading) {
      void loadSystemPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSettingsTab, systemPromptOpen]);

  useEffect(() => {
    if (activeSettingsTab === "general" && userPromptOpen && !userPrompt && !userPromptLoading) {
      void loadUserPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSettingsTab, userPromptOpen]);

  useEffect(() => {
    if (!isTauri() || activeSettingsTab !== "account") return;
    const refreshAccount = usageRefreshPendingRef.current;
    usageRefreshPendingRef.current = false;
    void loadUsageSummary(usageLogPage, refreshAccount ? { force: true, refreshAccount: true } : {});
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
    if (openalexKey.trim()) patch.openalexApiKey = openalexKey.trim();
    if (braveSearchKey.trim()) patch.braveSearchApiKey = braveSearchKey.trim();
    if (exaKey.trim()) patch.exaApiKey = exaKey.trim();
    if (zhihuAccessSecret.trim()) patch.zhihuAccessSecret = zhihuAccessSecret.trim();
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
        setConfigView((current) => current ? { ...current, ...buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewerApi }) } : current);
        setSaveState("saved");
        savedTimer.current = window.setTimeout(() => setSaveState("idle"), 3000);
        notifyChatModelsUpdated();
        return;
      }
      const next = await configSet(buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewerApi }));
      loadConfig(next);
      setSaveState("saved");
      savedTimer.current = window.setTimeout(() => setSaveState("idle"), 3000);
      notifyChatModelsUpdated();
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
          message: copy.previewConnectionTest,
          executor: { ok: true, label: copy.previewExecutorLabel, model: advForm.executorModel, baseUrl: advForm.executorBaseUrl, message: copy.previewMode },
          reviewer: canConfigureReviewerApi ? { ok: true, label: copy.previewReviewerLabel, model: advForm.reviewerModel, baseUrl: advForm.reviewerBaseUrl, message: copy.previewMode } : null,
        };
        setTestResult(result);
        setTestState("passed");
        return;
      }
      const result = await configTest(buildPatch({ includeExecutor: canConfigureExecutor, includeReviewer: canConfigureReviewerApi }));
      setTestResult(result);
      setTestState(result.ok ? "passed" : "failed");
      if (result.ok) notifyChatModelsUpdated();
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setTestResult({ ok: false, message, executor: { ok: false, label: copy.previewSettingsLabel, message } });
      setTestState("failed");
    }
  };

  const testWebProvider = async (provider: "brave" | "exa" | "zhihu") => {
    setWebProviderTestState((current) => ({
      ...current,
      [provider]: {
        ok: false,
        label: provider.toUpperCase(),
        message: language === "cn" ? "正在测试连接…" : "Testing connection…",
        testing: true,
      },
    }));
    try {
      const draftKey = provider === "brave"
        ? braveSearchKey
        : provider === "exa"
          ? exaKey
          : zhihuAccessSecret;
      const result = isTauri()
        ? await webSearchProviderTest(provider, draftKey)
        : {
          ok: true,
          label: provider === "zhihu" ? "Zhihu Search" : `${provider.toUpperCase()} Web Search`,
          provider,
          baseUrl: provider === "brave"
            ? "https://api.search.brave.com"
            : provider === "exa"
              ? "https://api.exa.ai"
              : "https://developer.zhihu.com/api/v1/content/zhihu_search",
          message: copy.previewMode,
        };
      setWebProviderTestState((current) => ({
        ...current,
        [provider]: result,
      }));
    } catch (error) {
      setWebProviderTestState((current) => ({
        ...current,
        [provider]: {
          ok: false,
          label: provider.toUpperCase(),
          provider,
          message: formatUserFacingError(error, language),
        },
      }));
    }
  };

  const clearWebProviderKey = async (
    provider: "brave" | "exa" | "zhihu",
    kind: "braveSearchApiKey" | "exaApiKey" | "zhihuAccessSecret",
  ) => {
    const confirmed = window.confirm(
      language === "cn"
        ? `确认清除已保存的 ${provider === "zhihu" ? "知乎 Access Secret" : `${provider.toUpperCase()} API Key`}？`
        : `Clear the saved ${provider === "zhihu" ? "Zhihu Access Secret" : `${provider.toUpperCase()} API key`}?`,
    );
    if (!confirmed) return;
    try {
      if (isTauri()) {
        loadConfig(await configSecretClear(kind));
      }
      if (provider === "brave") setBraveSearchKey("");
      else if (provider === "exa") setExaKey("");
      else setZhihuAccessSecret("");
      setWebProviderTestState((current) => {
        const next = { ...current };
        delete next[provider];
        return next;
      });
    } catch (error) {
      setError(formatUserFacingError(error, language));
    }
  };

  const applyManagedModel = async (model: string) => {
    if (!model || model === configView?.executorModel) return;
    if (!isTauri()) {
      setConfigView((current) => current ? { ...current, executorModel: model } : current);
      setAdvForm((current) => ({ ...current, executorModel: model }));
      setAccount((current) => (current ? { ...current, model } : current));
      notifyChatModelsUpdated();
      return;
    }
    try {
      const next = await configSet({ executorModel: model });
      loadConfig(next);
      setAccount((current) => (current ? { ...current, model } : current));
      notifyChatModelsUpdated();
    } catch (error) {
      setError(String(error));
    }
  };

  const applyManagedReviewerModel = async (model: string) => {
    if (model === (configView?.reviewerModel ?? "")) return;
    if (!isTauri()) {
      setConfigView((current) => current ? { ...current, reviewerModel: model } : current);
      setAdvForm((current) => ({ ...current, reviewerModel: model }));
      return;
    }
    try {
      const patch: ConfigPatch = model
        ? { reviewerModel: model }
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
        setUpdateMessage(copy.updateMsgNewVersion(result.version ?? ""));
      } else {
        setUpdateState("current");
        setUpdateMessage(copy.updateMsgUpToDate);
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const installUpdate = async () => {
    setUpdateState("downloading");
    setUpdateProgress(null);
    setUpdateMessage(copy.updateMsgDownloading);
    try {
      const result = await appUpdateDownloadAndInstall((progress) => {
        setUpdateProgress(progress);
        if (progress.stage === "finished") setUpdateMessage(copy.updateMsgInstalled);
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
        setUpdateMessage(copy.updateMsgInstalled);
      } else {
        setUpdateState("current");
        setUpdateMessage(copy.updateMsgNoUpdateToInstall);
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const restartForUpdate = async () => {
    try {
      await appRelaunch();
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  if (!configView) return <div className="board"><div className="empty">{copy.loading}</div></div>;

  const advExecProvider = advForm.executorProvider ?? "anthropic";
  const advExecMeta = EXECUTOR_PROVIDERS[advExecProvider] ?? EXECUTOR_PROVIDERS.custom;
  const canConfigureExecutor = isAdminAccount(account);
  const canConfigureReviewerApi = canConfigureExecutor;
  const canSelectManagedReviewer = MANAGED_NEW_API_MODE;
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
    addOption(copy.summaryProviderExecutor, configView.executorProvider, configView.executorBaseUrl, configView.executorModel);
    if (canConfigureReviewerApi) addOption(copy.summaryProviderReviewer, configView.reviewerProvider, configView.reviewerBaseUrl, configView.reviewerModel);
    for (const item of configView.verifiedExecutors ?? []) {
      addOption(`${formatServerLabel(item.baseUrl, language)} · ${item.model}`, item.provider, item.baseUrl, item.model);
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
      canConfigureReviewerApi && advForm.reviewerProvider === advForm.summarizerProvider ? advForm.reviewerModel : "",
    ].filter((model): model is string => Boolean(model?.trim())))).map((model) => ({
      label: model,
      value: model,
      hint: selectedSummaryProvider?.label,
    })),
  ];
  const retrievalCardModelOptions = uniqueModelList(
    [advForm.executorModel],
    configView.managedModels,
    (configView.verifiedExecutors ?? []).map((item) => item.model),
  ).map((model) => ({ label: model, value: model }));
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
      : copy.updateDownloaded(formatUpdateBytes(updateProgress.downloadedBytes))
    : "";
  const environmentReadyCount = environmentChecks.filter((item) => item.available).length;
  const accountUsedQuota = account?.usedQuota ?? 0;
  const accountRemainingQuota = account?.quota ?? 0;
  const accountTotalQuota = accountUsedQuota + accountRemainingQuota;
  const accountUsagePercent = account ? quotaPercent(account) : 0;
  const subscriptionUsedQuota = account?.subscriptionUsedQuota ?? 0;
  const subscriptionRemainingQuota = account?.subscriptionQuota ?? 0;
  const subscriptionTotalQuota = subscriptionUsedQuota + subscriptionRemainingQuota;
  const subscriptionUsagePercent = account ? subscriptionQuotaPercent(account) : 0;
  const accountPageRefreshing = accountLoading || usageLoading;
  const groupCopy = {
    label: copy.groupLabel,
    hint: copy.groupHint,
    save: copy.groupSave,
    saving: copy.groupSaving,
    loading: copy.groupLoading,
    empty: copy.groupEmpty,
  };
  const groupOptionsWithCurrent = account?.group && !groupOptions.some((option) => option.name === account.group)
    ? [{ name: account.group, desc: account.groupDesc, ratio: account.groupRatio }, ...groupOptions]
    : groupOptions;
  const usageLogTotal = usageLogs?.total ?? 0;
  const usageLogItems = usageLogs?.items ?? [];
  const usageLogPageCount = Math.max(1, Math.ceil(usageLogTotal / USAGE_LOG_PAGE_SIZE));
  const usageLogStart = usageLogTotal > 0 ? (usageLogPage - 1) * USAGE_LOG_PAGE_SIZE + 1 : 0;
  const usageLogEnd = usageLogTotal > 0 ? Math.min(usageLogStart + usageLogItems.length - 1, usageLogTotal) : 0;
  const canGoPrevUsageLogPage = usageLogPage > 1 && !usageLoading;
  const canGoNextUsageLogPage = usageLogPage < usageLogPageCount && !usageLoading;
  const currentManagedModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const availableManagedModels = uniqueModelList(
    managedModels,
    configView.managedModels,
    [configView.executorModel, configView.reviewerModel],
    account?.models,
  );
  const managedModelPreview = availableManagedModels.slice(0, 12);
  const currentReviewerModel = configView.reviewerModel?.trim() || "";
  const currentConfiguredModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const currentServerLabel = configuredServerLabel(configView, language);
  // Endpoint actually used for the selected executor model. Prefer the entry
  // probed for this exact model over the live slot, since a model switch
  // carries the per-model verdict. Empty (unprobed) renders no badge rather
  // than guessing.
  const executorTransport = (() => {
    const model = configView.executorModel?.trim();
    if (!model) return "";
    const probed = (configView.verifiedExecutors ?? []).find(
      (item) => item.model === model && item.provider === (configView.executorProvider ?? "openai"),
    )?.transport;
    return (probed || configView.executorTransport || "").trim();
  })();

  const navMisc = SETTINGS_NAV_MISC[language];
  const navLabels = SETTINGS_NAV_LABELS[language];
  const navGroupLabels = SETTINGS_NAV_GROUP_LABELS[language];

  return (
    <div className="st-page sp-settings-page sp-settings-shell">
      <aside className="sp-settings-nav" aria-label={copy.settingsCategories}>
        <div className="sp-settings-nav-head">
          <button type="button" className="sp-settings-back" onClick={() => setTab("chat")}>
            <SvgIcon name="chevronLeft" size={14} />
            <span>{navMisc.back}</span>
          </button>
        </div>
        <div className="sp-settings-nav-scroll" role="tablist">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div className="sp-settings-nav-group" key={group.id}>
              <div className="sp-settings-nav-group-title">{navGroupLabels[group.id]}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={activeSettingsTab === item.id}
                  className={`sp-nav-item${activeSettingsTab === item.id ? " active" : ""}`}
                  onClick={() => setActiveSettingsTab(item.id)}
                >
                  <span className="sp-nav-item-icon">{item.icon}</span>
                  <span className="sp-nav-item-label">{navLabels[item.id]}</span>
                  {item.external && (
                    <span className="sp-nav-item-ext"><SvgIcon name="externalLink" size={12} /></span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div
        className={`sp-settings-content${
          activeSettingsTab === "extensions"
            ? " sp-settings-content-flush"
            : activeSettingsTab === "remote"
              ? " sp-settings-content-remote"
              : ""
        }`}
      >

      {activeSettingsTab === "profile" && (
        <Profile account={account} language={language} />
      )}

      {activeSettingsTab === "general" && (
        <div className="sp-general-page">
          <div className="sp-status-bar">
            <div className="sp-status-slot">
              <span className="sp-status-tag sp-status-tag-exec">{copy.statusModelService}</span>
              <span className="sp-status-model">{currentConfiguredModel}</span>
              {configView.hasExecutorKey && <span className="sp-status-key"><SvgIcon name="circle" size={8} /></span>}
              <span className="sp-status-url">{currentServerLabel}</span>
            </div>
            <div className="sp-status-sep" />
            <div className="sp-status-slot sp-status-version">
              <span className="sp-status-tag sp-status-tag-version">{copy.statusVersion}</span>
              <span className="sp-status-model">SomniQ Studio v{configView.appVersion}</span>
            </div>
          </div>

          <div className="sp-update-section sp-general-preferences">
            <div className="sp-section-head sp-general-preference-row">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.appearanceTitle}</div>
                <div className="sp-section-sub">{copy.appearanceSub}</div>
              </div>
              <div className="sp-theme-toggle" role="radiogroup" aria-label={copy.themeLabel}>
                {([
                  { value: "light", label: copy.light },
                  { value: "dark", label: copy.dark },
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
            <div className="sp-general-preference-divider" />
            <div className="sp-section-head sp-general-preference-row">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.languageTitle}</div>
                <div className="sp-section-sub">{copy.languageSub}</div>
              </div>
              <div className="sp-update-actions">
                <div className="st-lang-grid sp-inline-lang-grid">
                  {[
                    { value: "cn", label: copy.languageSimplifiedChinese },
                    { value: "en", label: copy.languageEnglish },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`st-lang-card${advForm.language === item.value ? " active" : ""}`}
                      onClick={() => {
                        resetOpState();
                        const next = normalizeLanguage(item.value);
                        setLanguage(next);
                        setAdvForm((current) => ({ ...current, language: next }));
                      }}
                    >
                      <span className="st-lang-label">{item.label}</span>
                    </button>
                  ))}
                </div>
                <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving"} type="button">
                  {saveState === "saving" ? copy.saveSaving : saveState === "saved" ? copy.saveSaved : copy.savePrefs}
                </button>
              </div>
            </div>
          </div>

          <div className="sp-update-section sp-general-behavior">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.localBehaviorTitle}</div>
                <div className="sp-section-sub">{copy.localBehaviorSub}</div>
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
                  <span className="st-lang-label">{advForm.memoryWriteApproval ? copy.confirmBeforeWrite : copy.autoWrite}</span>
                </button>
                <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving"} type="button">
                  {saveState === "saving" ? copy.saveSaving : saveState === "saved" ? copy.saveSaved : copy.saveBehavior}
                </button>
              </div>
            </div>
          </div>

          <div className="sp-update-section sp-general-prompt-section">
            <button
              type="button"
              className="sp-system-prompt-toggle"
              onClick={() => {
                const nextOpen = !systemPromptOpen;
                setSystemPromptOpen(nextOpen);
                if (nextOpen && !systemPrompt) void loadSystemPrompt();
              }}
            >
              <span>
                <span className="sp-section-title">{copy.systemPromptTitle}</span>
                <span className="sp-section-sub">{copy.systemPromptSub}</span>
              </span>
              <span className="sp-system-prompt-toggle-state">{systemPromptOpen ? copy.promptHide : copy.promptView}</span>
            </button>
            {systemPromptOpen && (
              <div className="sp-system-prompt-panel">
                <div className="sp-system-prompt-toolbar">
                  <div className="sp-system-prompt-meta">
                    <span>{copy.promptModel}: {systemPrompt?.model ?? (advForm.executorModel || copy.promptUnknown)}</span>
                    <span>{copy.promptSections(systemPrompt?.sections ?? 0)}</span>
                    <span>{copy.promptChars(formatUsageExact(systemPrompt?.characters ?? 0))}</span>
                    <span>{systemPrompt?.fullToolRegistry ? copy.promptFullTools : copy.promptLimitedTools}</span>
                  </div>
                  <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void loadSystemPrompt()} disabled={systemPromptLoading}>
                    {systemPromptLoading ? copy.promptLoading : copy.promptRefresh}
                  </button>
                </div>
                {systemPromptError && <div className="sp-system-prompt-error">{systemPromptError}</div>}
                <textarea
                  className="sp-system-prompt-text"
                  value={systemPrompt?.prompt ?? (systemPromptLoading ? copy.systemPromptLoading : "")}
                  readOnly
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          <div className="sp-update-section sp-general-prompt-section">
            <button
              type="button"
              className="sp-system-prompt-toggle"
              onClick={() => {
                const nextOpen = !userPromptOpen;
                setUserPromptOpen(nextOpen);
                if (nextOpen && !userPrompt) void loadUserPrompt();
              }}
            >
              <span>
                <span className="sp-section-title">{copy.userPromptTitle}</span>
                <span className="sp-section-sub">{copy.userPromptSub}</span>
              </span>
              <span className="sp-system-prompt-toggle-state">{userPromptOpen ? copy.promptHide : copy.promptView}</span>
            </button>
            {userPromptOpen && (
              <div className="sp-system-prompt-panel">
                <div className="sp-system-prompt-toolbar">
                  <div className="sp-system-prompt-meta">
                    <span>{copy.userPromptSource}: {userPrompt?.surface ?? copy.userPromptNoSource}</span>
                    <span>{userPrompt ? formatUsageDate(userPrompt.capturedAt) : copy.userPromptNotCaptured}</span>
                    <span>{copy.userPromptBlocks(userPrompt?.blocks ?? 0)}</span>
                    <span>{copy.userPromptImages(userPrompt?.images ?? 0)}</span>
                    <span>{copy.promptChars(formatUsageExact(userPrompt?.characters ?? 0))}</span>
                  </div>
                  <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void loadUserPrompt()} disabled={userPromptLoading}>
                    {userPromptLoading ? copy.promptLoading : copy.promptRefresh}
                  </button>
                </div>
                {userPromptError && <div className="sp-system-prompt-error">{userPromptError}</div>}
                {!userPrompt && !userPromptLoading && (
                  <div className="sp-system-prompt-empty">{copy.userPromptEmpty}</div>
                )}
                <textarea
                  className="sp-system-prompt-text"
                  value={userPrompt?.prompt ?? (userPromptLoading ? copy.userPromptLoading : "")}
                  readOnly
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {activeSettingsTab === "mail" && (
        <div className="sp-mail-page">
          <MailSettingsDetail />
        </div>
      )}

      {activeSettingsTab === "memory" && (
        <MemorySettings language={language} />
      )}

      {activeSettingsTab === "models" && (
        <>
          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.modelServiceTitle}</div>
                <div className="sp-section-sub">{copy.modelServiceSub}</div>
              </div>
              <div className="sp-update-actions">
                <button className="sp-btn sp-btn-secondary" onClick={() => void loadManagedModels()} disabled={managedModelsLoading} type="button">
                  <SvgIcon name={managedModelsLoading ? "spinner" : "refresh"} size={13} />
                  {managedModelsLoading ? copy.modelSyncing : copy.modelSync}
                </button>
              </div>
            </div>
            <div className="sp-model-pair">
              <label className="sp-model-select-row">
                <span>{copy.executorModel}</span>
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
                  <span className="sp-model-select-empty">{copy.modelSyncAfterLogin}</span>
                )}
                {executorTransport ? (
                  <span
                    className={`sp-model-transport${executorTransport === "responses" ? " is-responses" : ""}`}
                    title={copy.transportHint}
                  >
                    {executorTransport === "responses" ? copy.transportResponses : copy.transportChat}
                  </span>
                ) : null}
              </label>
              <label className="sp-model-select-row">
                <span>{copy.reviewerModel}</span>
                {canSelectManagedReviewer && availableManagedModels.length > 0 ? (
                  <select
                    value={currentReviewerModel}
                    onChange={(event) => void applyManagedReviewerModel(event.target.value)}
                    className="sp-settings-select"
                  >
                    <option value="">{copy.reviewerModelOff}</option>
                    {availableManagedModels.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <span className="sp-model-select-empty">{copy.modelSyncAfterLogin}</span>
                )}
              </label>
            </div>
            <div className="sp-update-panel sp-update-panel-current">
              <div className="sp-update-main">
                <span className="sp-update-dot sp-update-dot-current" />
                <div className="sp-update-copy">
                  <div className="sp-update-title">
                    {copy.currentExecutor(currentManagedModel)}
                    {currentReviewerModel ? copy.currentReviewer(currentReviewerModel) : copy.reviewerOff}
                  </div>
                  <div className="sp-update-meta">
                    {managedModelsLoading
                      ? copy.modelSyncingStatus
                      : managedModelsError
                        ? managedModelsError
                        : availableManagedModels.length > 0
                          ? copy.modelSynced(availableManagedModels.length)
                          : copy.modelSyncAfterLoginStatus}
                  </div>
                  {managedModelPreview.length > 0 && (
                    <div className="sp-model-preview" aria-label={copy.modelSynced(availableManagedModels.length)}>
                      {managedModelPreview.map((model) => (
                        <span key={model}>{model}</span>
                      ))}
                      {availableManagedModels.length > managedModelPreview.length && (
                        <span>+{availableManagedModels.length - managedModelPreview.length}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {activeSettingsTab === "models" && (
        <div className="sp-advanced-wrap sp-advanced-wrap-tab">
          <div className="sp-advanced-body">
            {canConfigureExecutor && (
              <div className="sp-adv-section">
                <div className="sp-adv-section-title">{copy.advancedExecutor}</div>
                <div className="sp-field-group">
                  <div className="st-field-label">{copy.advancedProviderType}</div>
                  <div className="st-provider-grid">
                    {Object.keys(EXECUTOR_PROVIDERS).map((key) => (
                      <button key={key} type="button" className={`st-provider-card${advExecProvider === key ? " active" : ""}`} onClick={() => chooseExecProvider(key)}>
                        <span className="st-provider-label">{copy.executorProviderLabels[key]}</span>
                        <span className="st-provider-hint">{copy.executorProviderHints[key]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sp-adv-rows">
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldModel}</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorModel ?? ""} placeholder={advExecMeta.defaultModel || "claude-sonnet-4-6"} options={advExecMeta.models ?? EXECUTOR_MODELS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, executorModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldBaseUrl}</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorBaseUrl ?? ""} placeholder={advExecMeta.defaultBaseUrl || copy.officialDefaultPlaceholder} options={advExecMeta.baseUrls ?? OPENAI_COMPAT_URLS} formatValue={(value) => displayServerValue(value, language)} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, executorBaseUrl: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldApiKey}</span><span className="st-hint">{configView.hasExecutorKey ? copy.keySaved(configView.executorKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span></div><div className="st-row-control"><KeyInput value={execKey} placeholder={configView.hasExecutorKey ? copy.keyKeep : copy.keyPasteExecutor} masked={configView.executorKeyMasked} secretKind="executorApiKey" language={language} onChange={(value) => { resetOpState(); setExecKey(value); }} /></div></div>
                </div>
              </div>
            )}

            {canConfigureReviewerApi && (
              <div className="sp-adv-section">
                <div className="sp-adv-section-title">{copy.advancedReviewer}</div>
                <div className="sp-field-group">
                  <div className="st-field-label">{copy.advancedProviderType}</div>
                  <div className="st-provider-grid">
                    {Object.keys(REVIEWER_PROVIDERS).map((key) => (
                      <button key={key} type="button" className={`st-provider-card${advReviewerProvider === key ? " active" : ""}`} onClick={() => chooseReviewerProvider(key)}>
                        <span className="st-provider-label">{copy.reviewerProviderLabels[key]}</span>
                        <span className="st-provider-hint">{copy.reviewerProviderHints[key]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {advReviewerProvider !== "" && (
                  <div className="sp-adv-rows">
                    <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldModel}</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerModel ?? ""} placeholder={advReviewerMeta.defaultModel || "gpt-5.5"} options={advReviewerMeta.models ?? REVIEWER_MODELS} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, reviewerModel: value })); }} /></div></div>
                    <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldBaseUrl}</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerBaseUrl ?? ""} placeholder={advReviewerMeta.defaultBaseUrl || copy.providerDefaultPlaceholder} options={advReviewerMeta.baseUrls ?? OPENAI_COMPAT_URLS} formatValue={(value) => displayServerValue(value, language)} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, reviewerBaseUrl: value })); }} /></div></div>
                    <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldApiKey}</span><span className="st-hint">{configView.hasReviewerKey ? copy.keySaved(configView.reviewerKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span></div><div className="st-row-control"><KeyInput value={reviewerKey} placeholder={configView.hasReviewerKey ? copy.keyKeep : copy.keyPasteReviewer} masked={configView.reviewerKeyMasked} secretKind="reviewerApiKey" language={language} onChange={(value) => { resetOpState(); setReviewerKey(value); }} /></div></div>
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
                  <span className="sp-adv-section-title">{copy.advancedSummaryTools}</span>
                  <span className="sp-adv-section-sub">{copy.advancedSummaryToolsSub}</span>
                </span>
                <span className="sp-adv-section-toggle-state">{summaryToolsOpen ? copy.advancedCollapse : copy.advancedExpand}</span>
              </button>
              {summaryToolsOpen && (
                <div className="sp-adv-rows">
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryProvider}</span><span className="st-hint">{copy.summaryProviderHint}</span></div><div className="st-row-control"><select value={summarySelectValue} onChange={(event) => chooseSummaryProvider(event.target.value)}><option value="">{copy.summaryFollowExecutor}</option><option value="__manual">{copy.summaryManual}</option>{summaryProviderOptions.map((item) => <option key={item.key} value={item.key}>{item.label}{item.model ? ` · ${item.model}` : ""}</option>)}</select></div></div>
                  {isManualSummaryProvider && (
                    <>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryProtocol}</span></div><div className="st-row-control"><select value={advForm.summarizerProvider ?? "openai"} onChange={(event) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerProvider: event.target.value })); }}><option value="openai">{copy.protocolOpenAiCompatible}</option><option value="anthropic">Anthropic</option><option value="anthropic-compat">{copy.protocolAnthropicCompatible}</option></select></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryBaseUrl}</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerBaseUrl ?? ""} placeholder="https://api.openai.com/v1" options={[...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS]} formatValue={(value) => displayServerValue(value, language)} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerBaseUrl: value })); }} /></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryApiKey}</span><span className="st-hint">{configView.hasSummarizerKey ? copy.keySaved(configView.summarizerKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span></div><div className="st-row-control"><KeyInput value={summaryKey} placeholder={configView.hasSummarizerKey ? copy.keyKeep : copy.keyPasteSummary} masked={configView.summarizerKeyMasked} secretKind="summarizerApiKey" language={language} onChange={(value) => { resetOpState(); setSummaryKey(value); }} /></div></div>
                    </>
                  )}
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryModel}</span><span className="st-hint">{copy.summaryModelHint}</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerModel ?? ""} placeholder={copy.automaticPlaceholder} options={summaryModelOptions} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.retrievalCardModel}</span><span className="st-hint">{copy.retrievalCardModelHint}</span></div><div className="st-row-control"><PresetTextInput value={advForm.retrievalCardModel ?? ""} placeholder={copy.retrievalCardFollowExecutor} options={retrievalCardModelOptions} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, retrievalCardModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldScopusKey}</span><span className="st-hint">{configView.hasScopusKey ? copy.keySaved(configView.scopusKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span></div><div className="st-row-control"><KeyInput value={scopusKey} placeholder={configView.hasScopusKey ? copy.keyKeep : copy.keyPasteScopus} masked={configView.scopusKeyMasked} secretKind="scopusApiKey" language={language} onChange={(value) => { resetOpState(); setScopusKey(value); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldOpenalexKey}</span><span className="st-hint">{configView.hasOpenalexKey ? copy.keySaved(configView.openalexKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span></div><div className="st-row-control"><KeyInput value={openalexKey} placeholder={configView.hasOpenalexKey ? copy.keyKeep : copy.keyPasteOpenalex} masked={configView.openalexKeyMasked} secretKind="openalexApiKey" language={language} onChange={(value) => { resetOpState(); setOpenalexKey(value); }} /></div></div>
                  <div className="st-row">
                    <div className="st-row-label">
                      <span className="st-label">{copy.fieldBraveSearchKey}</span>
                      <span className="st-hint">
                        {configView.hasBraveSearchKey ? copy.keySaved(configView.braveSearchKeyMasked ?? copy.keyConfigured) : copy.keyNone}
                      </span>
                      {webProviderTestState.brave && (
                        <span className={`st-hint${webProviderTestState.brave.ok ? " ok" : " failed"}`}>
                          {webProviderTestState.brave.message}
                        </span>
                      )}
                    </div>
                    <div className="st-row-control st-search-service-control">
                      <KeyInput value={braveSearchKey} placeholder={configView.hasBraveSearchKey ? copy.keyKeep : copy.keyPasteBraveSearch} masked={configView.braveSearchKeyMasked} secretKind="braveSearchApiKey" language={language} onChange={(value) => { resetOpState(); setBraveSearchKey(value); }} />
                      <button type="button" onClick={() => void testWebProvider("brave")} disabled={webProviderTestState.brave?.testing}>
                        {language === "cn" ? "测试" : "Test"}
                      </button>
                      {configView.hasBraveSearchKey && (
                        <button type="button" className="danger" onClick={() => void clearWebProviderKey("brave", "braveSearchApiKey")}>
                          {language === "cn" ? "清除" : "Clear"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="st-row">
                    <div className="st-row-label">
                      <span className="st-label">{copy.fieldExaKey}</span>
                      <span className="st-hint">
                        {configView.hasExaKey ? copy.keySaved(configView.exaKeyMasked ?? copy.keyConfigured) : copy.keyNone}
                      </span>
                      {webProviderTestState.exa && (
                        <span className={`st-hint${webProviderTestState.exa.ok ? " ok" : " failed"}`}>
                          {webProviderTestState.exa.message}
                        </span>
                      )}
                    </div>
                    <div className="st-row-control st-search-service-control">
                      <KeyInput value={exaKey} placeholder={configView.hasExaKey ? copy.keyKeep : copy.keyPasteExa} masked={configView.exaKeyMasked} secretKind="exaApiKey" language={language} onChange={(value) => { resetOpState(); setExaKey(value); }} />
                      <button type="button" onClick={() => void testWebProvider("exa")} disabled={webProviderTestState.exa?.testing}>
                        {language === "cn" ? "测试" : "Test"}
                      </button>
                      {configView.hasExaKey && (
                        <button type="button" className="danger" onClick={() => void clearWebProviderKey("exa", "exaApiKey")}>
                          {language === "cn" ? "清除" : "Clear"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="st-row">
                    <div className="st-row-label">
                      <span className="st-label">{copy.fieldZhihuAccessSecret}</span>
                      <span className="st-hint">
                        {configView.hasZhihuAccessSecret ? copy.keySaved(configView.zhihuAccessSecretMasked ?? copy.keyConfigured) : copy.keyNone}
                      </span>
                      <span className="st-hint">{copy.zhihuSearchHint}</span>
                      {webProviderTestState.zhihu && (
                        <span className={`st-hint${webProviderTestState.zhihu.ok ? " ok" : " failed"}`}>
                          {webProviderTestState.zhihu.message}
                        </span>
                      )}
                    </div>
                    <div className="st-row-control st-search-service-control">
                      <KeyInput value={zhihuAccessSecret} placeholder={configView.hasZhihuAccessSecret ? copy.keyKeep : copy.keyPasteZhihuAccessSecret} masked={configView.zhihuAccessSecretMasked} secretKind="zhihuAccessSecret" language={language} onChange={(value) => { resetOpState(); setZhihuAccessSecret(value); }} />
                      <button type="button" onClick={() => void testWebProvider("zhihu")} disabled={webProviderTestState.zhihu?.testing}>
                        {language === "cn" ? "测试" : "Test"}
                      </button>
                      {configView.hasZhihuAccessSecret && (
                        <button type="button" className="danger" onClick={() => void clearWebProviderKey("zhihu", "zhihuAccessSecret")}>
                          {language === "cn" ? "清除" : "Clear"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.fieldConfigFile}</span></div><div className="st-row-control"><input className="st-readonly-input" value={configView.configPath} readOnly /></div></div>
                </div>
              )}
            </div>

            {testResult && (
              <div className={`st-test-panel${testResult.ok ? " ok" : " failed"}`}>
                <div className="st-test-summary">{testResult.message}</div>
                <div className="st-test-grid">
                  {canConfigureExecutor && <TestDetail detail={testResult.executor} language={language} />}
                  {canConfigureReviewerApi && testResult.reviewer && <TestDetail detail={testResult.reviewer} language={language} />}
                </div>
              </div>
            )}
            <div className="sp-detail-actions sp-advanced-actions">
              <button className="sp-btn sp-btn-secondary" onClick={test} disabled={testState === "testing" || saveState === "saving"} type="button">
                {testState === "testing" ? copy.testTesting : copy.testConnectionConfig}
              </button>
              <button className="sp-btn sp-btn-primary" onClick={save} disabled={saveState === "saving" || testState === "testing"} type="button">
                {saveState === "saving" ? copy.saveSaving : saveState === "saved" ? copy.saveSaved : copy.saveConnectionConfig}
              </button>
              {saveState === "saved" && <span className="st-save-info">{copy.saveConnectionSavedInfo}</span>}
            </div>
          </div>
        </div>
      )}

      {activeSettingsTab === "extensions" && (
        <div className="sp-extensions-embed">
          <Extensions />
        </div>
      )}

      {activeSettingsTab === "remote" && (
        <div className="remote-control-page">
          <RemoteControlPanel language={language} onError={setError} initialTab="computers" />
        </div>
      )}

      {activeSettingsTab === "account" && (
        <div className="sp-update-section sp-account-section sp-account-usage-section">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">{copy.authAccountTitle}</div>
              <div className="sp-section-sub">{copy.authAccountSub}</div>
            </div>
            <div className="sp-update-actions">
              <button className="sp-btn sp-btn-secondary" onClick={refreshUsage} disabled={accountPageRefreshing} type="button">
                <SvgIcon name={accountPageRefreshing ? "spinner" : "refresh"} size={13} />
                {accountPageRefreshing ? copy.authRefreshing : copy.authRefresh}
              </button>
              <button className="sp-btn sp-btn-secondary" onClick={logout} type="button">
                <SvgIcon name="close" size={13} />
                {copy.authLogout}
              </button>
            </div>
          </div>

          <div className={`sp-update-panel ${accountError && !account ? "sp-update-panel-error" : "sp-update-panel-current"}`}>
            <div className="sp-update-main">
              <span className={`sp-account-avatar${accountError && !account ? " is-error" : ""}`}>
                <SvgIcon name={accountError && !account ? "warning" : "user"} size={18} />
              </span>
              <div className="sp-update-copy">
                <div className="sp-update-title">
                  {account ? (account.displayName || account.username || copy.authSignedIn) : copy.authSignedOut}
                  {account?.subscriptionName ? <span className="sp-status-tag sp-status-tag-version">{account.subscriptionName}</span> : null}
                  {account?.group ? <span className="sp-status-tag sp-status-tag-version sp-account-group-tag">{copy.authGroupTag(account.group)}</span> : null}
                </div>
                {!account && <div className="sp-update-meta">{accountError || copy.authSignedOutSub}</div>}
                {account && (
                  <div className="sp-account-group-control">
                    <label className="sp-account-group-field">
                      <span>{groupCopy.label}</span>
                      <select
                        className="sp-settings-select"
                        value={groupDraft}
                        onChange={(event) => setGroupDraft(event.currentTarget.value)}
                        disabled={groupLoading || groupSaving || groupOptionsWithCurrent.length === 0}
                      >
                        {groupOptionsWithCurrent.map((option) => (
                          <option value={option.name} key={option.name}>
                            {option.name}{option.ratio ? ` · ${option.ratio}` : ""}{option.desc ? ` · ${option.desc}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="sp-btn sp-btn-secondary"
                      type="button"
                      onClick={() => void saveAccountGroup()}
                      disabled={groupSaving || groupLoading || !groupDraft.trim() || groupDraft === account.group}
                    >
                      {groupSaving ? groupCopy.saving : groupCopy.save}
                    </button>
                    <div className="sp-account-group-hint">
                      {groupLoading ? groupCopy.loading : groupOptionsWithCurrent.length === 0 ? groupCopy.empty : groupCopy.hint}
                    </div>
                    {groupError && <div className="sp-update-message sp-update-message-error">{groupError}</div>}
                  </div>
                )}
                {account && accountError && <div className="sp-update-message">{copy.authRefreshFailed(accountError)}</div>}
              </div>
            </div>
          </div>

          {account ? (
            <>
              <div className="sp-usage-hero">
                <article className="sp-usage-quota-card account">
                  <div className="sp-usage-quota-head">
                    <span className="sp-usage-quota-icon"><SvgIcon name="credit" size={17} /></span>
                    <div>
                      <span>{copy.accountTotalQuota}</span>
                      <strong>{formatQuota(accountTotalQuota)}</strong>
                    </div>
                    <span className="sp-usage-quota-percent">{accountUsagePercent}%</span>
                  </div>
                  <div className="sp-usage-progress" aria-label={`${copy.accountUsageRatio} ${accountUsagePercent}%`}>
                    <div style={{ width: `${accountUsagePercent}%` }} />
                  </div>
                  <div className="sp-usage-quota-breakdown">
                    <div>
                      <span>{copy.accountUsedQuota}</span>
                      <strong>{formatQuota(accountUsedQuota)}</strong>
                      <small>{formatUsageExact(accountUsedQuota)} {copy.creditUnit}</small>
                    </div>
                    <div>
                      <span>{copy.accountBalance}</span>
                      <strong>{formatQuota(accountRemainingQuota)}</strong>
                      <small>{formatUsageExact(accountRemainingQuota)} {copy.creditUnit}</small>
                    </div>
                  </div>
                </article>

                <article className="sp-usage-quota-card subscription">
                  <div className="sp-usage-quota-head">
                    <span className="sp-usage-quota-icon"><SvgIcon name="sparkle" size={17} /></span>
                    <div>
                      <span>{copy.authSubscriptionLabel}</span>
                      <strong>{formatQuota(subscriptionTotalQuota)}</strong>
                    </div>
                    <span className="sp-usage-quota-percent">{subscriptionUsagePercent}%</span>
                  </div>
                  <div className="sp-usage-progress" aria-label={`${copy.subscriptionUsageRatio} ${subscriptionUsagePercent}%`}>
                    <div style={{ width: `${subscriptionUsagePercent}%` }} />
                  </div>
                  <div className="sp-usage-quota-breakdown">
                    <div>
                      <span>{copy.subscriptionUsed}</span>
                      <strong>{formatQuota(subscriptionUsedQuota)}</strong>
                      <small>{formatUsageExact(subscriptionUsedQuota)} {copy.creditUnit}</small>
                    </div>
                    <div>
                      <span>{copy.subscriptionBalance}</span>
                      <strong>{formatQuota(subscriptionRemainingQuota)}</strong>
                      <small>{formatUsageExact(subscriptionRemainingQuota)} {copy.creditUnit}</small>
                    </div>
                  </div>
                </article>
              </div>
              <div className="sp-usage-detail-panel">
                <div className="sp-usage-card-head">
                  <div className="sp-usage-card-title">{copy.callDetails}</div>
                  <div className="sp-usage-card-range">
                    {usageLogTotal > 0 ? copy.usageRange(usageLogStart, usageLogEnd, usageLogTotal) : copy.usageNoRecords}
                  </div>
                </div>
                {usageLogError && usageLogItems.length > 0 && (
                  <div className="sp-usage-foot">{usageLogError}</div>
                )}
                {usageLogError && usageLogItems.length === 0 ? (
                  <div className="sp-usage-empty">{usageLogError}</div>
                ) : usageLoading && !usageLogs ? (
                  <div className="sp-usage-empty">{copy.usageLoading}</div>
                ) : usageLogItems.length > 0 ? (
                  <>
                    <div className="sp-usage-table">
                      <div className="sp-usage-row sp-usage-row-call sp-usage-row-head">
                        <span>{copy.usageHeaders.time}</span>
                        <span>{copy.usageHeaders.model}</span>
                        <span>{copy.usageHeaders.token}</span>
                        <span>{copy.usageHeaders.tokens}</span>
                        <span>{copy.usageHeaders.quota}</span>
                        <span>{copy.usageHeaders.request}</span>
                      </div>
                      {usageLogItems.map((entry) => {
                        const requestId = entry.requestId || entry.upstreamRequestId;
                        const meta = usageLogMeta(entry.status, entry.typeLabel, language);
                        const createdAt = entry.createdAt > 10_000_000_000 ? entry.createdAt : entry.createdAt * 1000;
                        return (
                          <div className="sp-usage-row sp-usage-row-call" key={entry.id}>
                            <span className="sp-usage-time" title={entry.createdAt ? new Date(createdAt).toLocaleString() : undefined}>
                              {formatUsageDate(entry.createdAt)}
                            </span>
                            <span className="sp-usage-model" title={entry.model || undefined}>{entry.model || "-"}</span>
                            <span className="sp-usage-token" title={entry.tokenName || undefined}>{entry.tokenName || "-"}</span>
                            <span title={`${copy.systemPromptTitle} ${formatUsageExact(entry.promptTokens)} / ${copy.userPromptTitle} ${formatUsageExact(entry.completionTokens)}`}>
                              {formatUsageExact(entry.totalTokens)}
                            </span>
                            <span title={`${formatUsageExact(entry.quota)} ${copy.creditUnit}${meta ? ` · ${meta}` : ""}`}>{formatQuota(entry.quota)}</span>
                            <span className="sp-usage-request" title={requestId || undefined}>{shortUsageId(requestId)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="sp-usage-pagination">
                      <div className="sp-usage-pagination-summary">
                        {copy.usagePageSummary(USAGE_LOG_PAGE_SIZE, usageLogPage, usageLogPageCount)}
                      </div>
                      <div className="sp-usage-page-controls">
                        <button className="sp-usage-page-button" type="button" disabled={!canGoPrevUsageLogPage} onClick={() => goToUsageLogPage(usageLogPage - 1)}>
                          {copy.usagePrev}
                        </button>
                        <span className="sp-usage-page-indicator">{usageLoading ? "..." : usageLogPage}</span>
                        <button className="sp-usage-page-button" type="button" disabled={!canGoNextUsageLogPage} onClick={() => goToUsageLogPage(usageLogPage + 1)}>
                          {copy.usageNext}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="sp-usage-empty">{copy.usageEmpty}</div>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}

      {activeSettingsTab === "about" && (
        <div className="sp-update-section sp-about-section">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">{copy.aboutUpdateTitle}</div>
              <div className="sp-section-sub">{copy.aboutUpdateSub}</div>
            </div>
            <div className="sp-update-actions">
              <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
                <SvgIcon name={updateState === "checking" ? "spinner" : "refresh"} size={13} />
                {updateState === "checking" ? copy.aboutChecking : copy.aboutCheck}
              </button>
              {updateCanInstall && <button className="sp-btn sp-btn-primary" onClick={() => void installUpdate()} disabled={updateBusy} type="button">{copy.aboutDownloadInstall}</button>}
              {updateCanRestart && <button className="sp-btn sp-btn-primary" onClick={() => void restartForUpdate()} type="button">{copy.aboutRestart}</button>}
            </div>
          </div>
          <div className={`sp-update-panel sp-update-panel-${updateState}`}>
            <div className="sp-update-main">
              <span className={`sp-update-dot sp-update-dot-${updateState}`} />
              <div className="sp-update-copy">
                <div className="sp-update-title">
                  {updateState === "available"
                    ? copy.aboutUpdateAvailable(updateInfo?.version ?? "")
                    : updateState === "ready"
                      ? copy.aboutUpdateReady(updateInfo?.version ?? "")
                      : updateState === "downloading"
                        ? copy.aboutInstalling
                        : copy.aboutConnected}
                </div>
                <div className="sp-update-meta">
                  {copy.aboutCurrentVersion(configView.appVersion)}
                  {updateInfo?.version && updateState !== "current" ? ` -> ${copy.aboutRemoteVersion(updateInfo.version)}` : ""}
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
          <div className="sp-about-links">
            <div className="sp-section-head-text">
              <div className="sp-section-title">{copy.aboutLinksTitle}</div>
              <div className="sp-section-sub">{copy.aboutLinksSub}</div>
            </div>
            <div className="sp-about-links-row">
              <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris" target="_blank" rel="noreferrer">
                <SvgIcon name="externalLink" size={13} />{copy.aboutLinkRepo}
              </a>
              <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/releases" target="_blank" rel="noreferrer">
                <SvgIcon name="externalLink" size={13} />{copy.aboutLinkReleases}
              </a>
              <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/blob/aris-code/LICENSE" target="_blank" rel="noreferrer">
                <SvgIcon name="externalLink" size={13} />{copy.aboutLinkLicense}
              </a>
            </div>
          </div>
        </div>
      )}

      {activeSettingsTab === "environment" && (
        <div className="sp-env-section">
            <div className="sp-section-head sp-env-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.envTitle}</div>
                <div className="sp-section-sub">
                  {environmentLoading
                    ? copy.envDetectingSub
                    : environmentChecks.length > 0
                    ? copy.envReadySummary(environmentReadyCount, environmentChecks.length, environmentCheckedAt ? formatUsageDate(environmentCheckedAt) : undefined)
                    : copy.envSub}
                </div>
              </div>
              <div className="sp-update-actions">
                <button
                  className="sp-btn sp-btn-secondary"
                  onClick={() => { void localEnvironmentChecks(true).then(setEnvironmentChecks).then(() => setEnvironmentCheckedAt(Math.floor(Date.now() / 1000))).catch((e) => setEnvironmentError(formatUserFacingError(e, language))); }}
                  disabled={environmentLoading}
                  type="button"
                >
                  <SvgIcon name={environmentLoading ? "spinner" : "refresh"} size={13} />
                  {environmentLoading ? copy.envDetecting : copy.envRefresh}
                </button>
              </div>
            </div>
            <div className="sp-env-python-config">
              <div className="sp-env-python-copy">
                <strong>{copy.pythonEnvironmentTitle}</strong>
                <span>{copy.pythonEnvironmentHint}</span>
              </div>
              <div className="sp-env-python-control">
                <input
                  className="sp-input"
                  value={pythonEnvironmentPath}
                  onChange={(event) => {
                    setPythonEnvironmentPath(event.currentTarget.value);
                    setPythonEnvironmentSaved(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void savePythonEnvironment();
                  }}
                  placeholder={copy.pythonEnvironmentPlaceholder}
                  aria-label={copy.pythonEnvironmentTitle}
                />
                <button
                  className="sp-btn sp-btn-secondary"
                  type="button"
                  onClick={() => void choosePythonEnvironment()}
                  disabled={pythonEnvironmentSaving}
                >
                  {copy.pythonEnvironmentBrowse}
                </button>
                <button
                  className="sp-btn sp-btn-primary"
                  type="button"
                  onClick={() => void savePythonEnvironment()}
                  disabled={pythonEnvironmentSaving}
                >
                  {pythonEnvironmentSaving
                    ? copy.pythonEnvironmentSaving
                    : pythonEnvironmentSaved
                      ? copy.pythonEnvironmentSaved
                      : copy.pythonEnvironmentUse}
                </button>
              </div>
            </div>
            {environmentError && <div className="sp-env-error">{environmentError}</div>}
            <div className="sp-env-grid">
              {environmentLoading ? (
                ENVIRONMENT_CHECK_PLACEHOLDERS.map((item) => (
                  <div className="sp-env-card sp-env-card-loading" key={item.id}>
                    <div className="sp-env-card-top">
                      <span className="sp-env-mark"><EnvironmentIcon id={item.id} /></span>
                      <div className="sp-env-title-block">
                        <div className="sp-env-title">{item.label}</div>
                        <div className="sp-env-category">{environmentCategoryLabel(item.id, language, item.label)}</div>
                      </div>
                      <span className="sp-env-badge sp-env-badge-loading">
                        <span className="sp-env-spinner" />
                        {copy.envDetecting}
                      </span>
                    </div>
                    <div className="sp-env-loading-line" />
                    <div className="sp-env-loading-line short" />
                  </div>
                ))
              ) : environmentChecks.length === 0 ? (
                <div className="sp-env-empty">{copy.envEmpty}</div>
              ) : (
                environmentChecks.map((item) => (
                  <div className={`sp-env-card sp-env-card-${item.status}`} key={item.id}>
                    <div className="sp-env-card-top">
                      <span className="sp-env-mark"><EnvironmentIcon id={item.id} /></span>
                      <div className="sp-env-title-block">
                        <div className="sp-env-title">{item.label}</div>
                        <div className="sp-env-category">{environmentCategoryLabel(item.id, language, item.category)}</div>
                      </div>
                      <span className={`sp-env-badge sp-env-badge-${item.status}`}>{environmentStatusLabel(item, language)}</span>
                    </div>
                    <div className="sp-env-lines">
                      <div><span>{copy.envVersion}</span><strong title={item.version ?? ""}>{item.version ?? copy.envUnknownVersion}</strong></div>
                      <div><span>{copy.envPath}</span><strong title={item.path ?? ""}>{item.path ?? copy.envNotOnPath}</strong></div>
                    </div>
                    <div className="sp-env-message" title={item.detail ?? item.message}>{environmentMessage(item, language)}</div>
                    {!item.available && isInstallableEnvironment(item.id) && (
                      <div className="sp-env-card-actions">
                        <button
                          className="sp-env-install"
                          type="button"
                          onClick={() => {
                            if (isInstallableEnvironment(item.id)) handoffEnvironmentInstall(item.id, language);
                          }}
                        >
                          {copy.envInstallInChat}
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
      )}
      </div>
    </div>
  );
}

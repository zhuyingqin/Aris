import type { NewApiAccount, NewApiGroupOption, NewApiUsageLogPage } from "../api/tauri";
import type { Language } from "../store";
import type { ConfigView, SystemPromptView, UserPromptView } from "../types";
import { SETTINGS_COPY, type SettingsGeneralCopy } from "./i18n";
import { MANAGED_MODEL_SERVER_BASE_URL } from "./settingsProviderCatalog";

export const USAGE_LOG_PAGE_SIZE = 12;

export interface PreviewSettingsData {
  configView: ConfigView;
  account: NewApiAccount;
  groupOptions: NewApiGroupOption[];
  usageLogs: NewApiUsageLogPage;
  systemPrompt: SystemPromptView;
  userPrompt: UserPromptView;
}

function buildPreviewSettingsData(language: Language, copy: SettingsGeneralCopy): PreviewSettingsData {
  const configView: ConfigView = {
    appVersion: "0.4.49",
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
    memoryV2Mode: "legacy_r0_only",
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

export const PREVIEW_SETTINGS_DATA: Record<Language, PreviewSettingsData> = {
  cn: buildPreviewSettingsData("cn", SETTINGS_COPY.cn.general),
  en: buildPreviewSettingsData("en", SETTINGS_COPY.en.general),
};

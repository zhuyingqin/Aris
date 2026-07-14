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
  systemPromptView,
  userPromptView,
} from "../api/tauri";
import { useStore, type Language } from "../store";
import { notifyChatModelsUpdated } from "../modelEvents";
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestResult,
  ConfigView,
  LocalEnvironmentCheck,
  SystemPromptView,
  UserPromptView,
} from "../types";
import RemoteControlPanel from "./RemoteControlPanel";

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
type SettingsTab = "general" | "models" | "remote" | "about";

const SETTINGS_TAB_REQUEST_KEY = "somniq-settings-tab-request";
const SETTINGS_TAB_REQUEST_EVENT = "somniq-settings-tab-request";
const PREVIEW_CONFIG_VIEW: ConfigView = {
  appVersion: "0.4.5",
  configPath: "browser preview - Tauri config is not loaded",
  executorProvider: "openai",
  executorModel: "MiniMax-M3",
  executorBaseUrl: "",
  summarizerProvider: "",
  summarizerModel: "",
  summarizerBaseUrl: "",
  hasSummarizerKey: false,
  hasExecutorKey: true,
  executorKeyMasked: "sk-...preview",
  reviewerProvider: "openai",
  reviewerModel: "MiniMax-M3",
  reviewerBaseUrl: "",
  hasReviewerKey: true,
  reviewerKeyMasked: "sk-...preview",
  hasScopusKey: false,
  language: "cn",
  memoryWriteApproval: true,
  verifiedExecutors: [],
};
const PREVIEW_SYSTEM_PROMPT: SystemPromptView = {
  model: PREVIEW_CONFIG_VIEW.executorModel ?? "preview-model",
  fullToolRegistry: true,
  sections: 3,
  characters: 214,
  prompt:
    "# System\nPreview mode: Tauri is not connected, so the live system prompt is unavailable.\n\n# Environment context\n - Model: MiniMax-M3\n - Working directory: browser preview\n\n# Desktop Chat\nFull tool registry: enabled.",
};
const PREVIEW_USER_PROMPT: UserPromptView = {
  sessionId: "preview-session",
  surface: "Chat",
  capturedAt: Math.floor(Date.now() / 1000),
  blocks: 1,
  images: 0,
  characters: 86,
  prompt: "Preview mode: this panel shows the most recent user prompt sent from the Chat composer.",
};
const ENVIRONMENT_CHECK_PLACEHOLDERS = [
  { id: "python", label: "Python", category: "运行环境" },
  { id: "jupyter", label: "Jupyter", category: "Notebook" },
  { id: "matlab", label: "MATLAB", category: "数值计算" },
  { id: "latex", label: "LaTeX", category: "论文排版" },
];

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "通用" },
  { id: "models", label: "模型" },
  { id: "remote", label: "远程控制" },
  { id: "about", label: "关于" },
];

const SETTINGS_COPY: Record<Language, {
  tabs: Record<SettingsTab, string>;
  settingsCategories: string;
  loading: string;
  statusModelService: string;
  statusVersion: string;
  languageTitle: string;
  languageSub: string;
  saveSaving: string;
  saveSaved: string;
  savePrefs: string;
  appearanceTitle: string;
  appearanceSub: string;
  themeLabel: string;
  light: string;
  dark: string;
  localBehaviorTitle: string;
  localBehaviorSub: string;
  confirmBeforeWrite: string;
  autoWrite: string;
  saveBehavior: string;
  systemPromptTitle: string;
  systemPromptSub: string;
  userPromptTitle: string;
  userPromptSub: string;
  promptView: string;
  promptHide: string;
  promptModel: string;
  promptUnknown: string;
  promptSections: (count: number) => string;
  promptChars: (count: string) => string;
  promptFullTools: string;
  promptLimitedTools: string;
  promptLoading: string;
  promptRefresh: string;
  systemPromptLoading: string;
  userPromptEmpty: string;
  userPromptSource: string;
  userPromptNoSource: string;
  userPromptNotCaptured: string;
  userPromptBlocks: (count: number) => string;
  userPromptImages: (count: number) => string;
  userPromptLoading: string;
  currentModelFallback: string;
  modelServiceTitle: string;
  modelServiceSub: string;
  executorModel: string;
  reviewerModel: string;
  reviewerModelOff: string;
  currentExecutor: (model: string) => string;
  currentReviewer: (model: string) => string;
  reviewerOff: string;
  aboutUpdateTitle: string;
  aboutUpdateSub: string;
  aboutCheck: string;
  aboutChecking: string;
  aboutDownloadInstall: string;
  aboutRestart: string;
  aboutUpdateAvailable: (version: string) => string;
  aboutUpdateReady: (version: string) => string;
  aboutInstalling: string;
  aboutConnected: string;
  aboutCurrentVersion: (version: string) => string;
  aboutRemoteVersion: (version: string) => string;
  envTitle: string;
  envDetectingSub: string;
  envReadySummary: (ready: number, total: number, checkedAt?: string) => string;
  envSub: string;
  envRefresh: string;
  envDetecting: string;
  envEmpty: string;
  advancedExecutor: string;
  advancedReviewer: string;
  advancedProviderType: string;
  advancedSummaryTools: string;
  advancedSummaryToolsSub: string;
  advancedCollapse: string;
  advancedExpand: string;
  summaryProvider: string;
  summaryProviderHint: string;
  summaryFollowExecutor: string;
  summaryManual: string;
  summaryProtocol: string;
  summaryBaseUrl: string;
  summaryApiKey: string;
  summaryModel: string;
  summaryModelHint: string;
  testTesting: string;
  testConnectionConfig: string;
  saveConnectionConfig: string;
  saveConnectionSavedInfo: string;
}> = {
  cn: {
    tabs: { general: "通用", models: "模型", remote: "远程控制", about: "关于" },
    settingsCategories: "设置分类",
    loading: "加载中...",
    statusModelService: "模型服务",
    statusVersion: "版本",
    languageTitle: "界面语言",
    languageSub: "立即切换桌面界面语言；保存后也会作为助手回复偏好。",
    saveSaving: "保存中...",
    saveSaved: "已保存",
    savePrefs: "保存偏好",
    appearanceTitle: "外观主题",
    appearanceSub: "选择应用的明暗主题，立即生效。",
    themeLabel: "主题",
    light: "浅色",
    dark: "深色",
    localBehaviorTitle: "本地行为",
    localBehaviorSub: "记忆写入策略仅保存在这台设备。",
    confirmBeforeWrite: "写入前确认",
    autoWrite: "自动写入",
    saveBehavior: "保存行为",
    systemPromptTitle: "系统提示词",
    systemPromptSub: "普通对话使用的只读提示词预览。",
    userPromptTitle: "用户提示词",
    userPromptSub: "最近一次从对话或代理界面实际发送的用户提示词。",
    promptView: "查看",
    promptHide: "收起",
    promptModel: "模型",
    promptUnknown: "未知",
    promptSections: (count) => `${count} 个段落`,
    promptChars: (count) => `${count} 字符`,
    promptFullTools: "完整工具",
    promptLimitedTools: "有限工具",
    promptLoading: "加载中...",
    promptRefresh: "刷新",
    systemPromptLoading: "正在加载系统提示词...",
    userPromptEmpty: "这个应用会话中还没有发送过用户提示词。",
    userPromptSource: "来源",
    userPromptNoSource: "无",
    userPromptNotCaptured: "尚未捕获",
    userPromptBlocks: (count) => `${count} 个文本块`,
    userPromptImages: (count) => `${count} 张图片`,
    userPromptLoading: "正在加载用户提示词...",
    currentModelFallback: "未选择",
    modelServiceTitle: "模型服务",
    modelServiceSub: "模型和密钥仅保存在这台电脑；手机只会读取已验证的模型选项。",
    executorModel: "执行模型",
    reviewerModel: "审核模型",
    reviewerModelOff: "关闭审核模型",
    currentExecutor: (model) => `当前执行：${model}`,
    currentReviewer: (model) => ` · 审核：${model}`,
    reviewerOff: " · 审核：关闭",
    aboutUpdateTitle: "应用更新",
    aboutUpdateSub: "通过 GitHub Release 检查、下载并安装 SomniQ Studio 更新。",
    aboutCheck: "检查更新",
    aboutChecking: "检查中...",
    aboutDownloadInstall: "下载并安装",
    aboutRestart: "重启应用",
    aboutUpdateAvailable: (version) => `可更新到 v${version}`,
    aboutUpdateReady: (version) => `v${version} 已安装`,
    aboutInstalling: "正在安装更新",
    aboutConnected: "SomniQ Studio 已连接更新通道",
    aboutCurrentVersion: (version) => `当前版本 v${version}`,
    aboutRemoteVersion: (version) => `远端版本 v${version}`,
    envTitle: "本地环境检查",
    envDetectingSub: "正在检测本机运行环境...",
    envReadySummary: (ready, total, checkedAt) => `${ready}/${total} 项可用${checkedAt ? ` · 上次检测 ${checkedAt}` : ""}`,
    envSub: "查看 Python、MATLAB、LaTeX 等运行环境。",
    envRefresh: "刷新",
    envDetecting: "检测中...",
    envEmpty: "点击刷新后显示本机可用的科研与排版运行环境。",
    advancedExecutor: "执行器",
    advancedReviewer: "审阅",
    advancedProviderType: "Provider 类型",
    advancedSummaryTools: "摘要与工具",
    advancedSummaryToolsSub: "摘要模型、Scopus Key 与配置文件路径",
    advancedCollapse: "收起",
    advancedExpand: "展开",
    summaryProvider: "摘要供应商",
    summaryProviderHint: "Auto 会使用这里选择的供应商和已保存 key",
    summaryFollowExecutor: "跟随执行器",
    summaryManual: "手动配置",
    summaryProtocol: "摘要协议",
    summaryBaseUrl: "摘要 Base URL",
    summaryApiKey: "摘要 API Key",
    summaryModel: "摘要模型",
    summaryModelHint: "压缩上下文时生成摘要所用的模型；留空 = 自动",
    testTesting: "测试中...",
    testConnectionConfig: "测试连接配置",
    saveConnectionConfig: "保存连接配置",
    saveConnectionSavedInfo: "已保存。下次对话时生效。",
  },
  en: {
    tabs: { general: "General", models: "Models", remote: "Remote", about: "About" },
    settingsCategories: "Settings categories",
    loading: "Loading...",
    statusModelService: "Model service",
    statusVersion: "Version",
    languageTitle: "Interface Language",
    languageSub: "Switch the desktop UI immediately; save to also use it as the assistant reply preference.",
    saveSaving: "Saving...",
    saveSaved: "Saved",
    savePrefs: "Save preference",
    appearanceTitle: "Appearance",
    appearanceSub: "Choose the light or dark theme. Changes apply immediately.",
    themeLabel: "Theme",
    light: "Light",
    dark: "Dark",
    localBehaviorTitle: "Local Behavior",
    localBehaviorSub: "Memory write behavior is stored only on this device.",
    confirmBeforeWrite: "Confirm before writing",
    autoWrite: "Write automatically",
    saveBehavior: "Save behavior",
    systemPromptTitle: "System Prompt",
    systemPromptSub: "Read-only preview of the prompt used by normal Chat sessions.",
    userPromptTitle: "User Prompt",
    userPromptSub: "Most recent user prompt actually sent from Chat or an agent surface.",
    promptView: "View",
    promptHide: "Hide",
    promptModel: "Model",
    promptUnknown: "unknown",
    promptSections: (count) => `${count} sections`,
    promptChars: (count) => `${count} chars`,
    promptFullTools: "Full tools",
    promptLimitedTools: "Limited tools",
    promptLoading: "Loading...",
    promptRefresh: "Refresh",
    systemPromptLoading: "Loading system prompt...",
    userPromptEmpty: "No user prompt has been sent in this app session yet.",
    userPromptSource: "Source",
    userPromptNoSource: "none",
    userPromptNotCaptured: "Not captured",
    userPromptBlocks: (count) => `${count} blocks`,
    userPromptImages: (count) => `${count} images`,
    userPromptLoading: "Loading user prompt...",
    currentModelFallback: "Not selected",
    modelServiceTitle: "Model Service",
    modelServiceSub: "Models and keys stay on this computer; the phone sees only verified model choices.",
    executorModel: "Execution model",
    reviewerModel: "Review model",
    reviewerModelOff: "Disable review model",
    currentExecutor: (model) => `Current executor: ${model}`,
    currentReviewer: (model) => ` · reviewer: ${model}`,
    reviewerOff: " · reviewer: off",
    aboutUpdateTitle: "App Updates",
    aboutUpdateSub: "Check, download, and install SomniQ Studio updates from GitHub Releases.",
    aboutCheck: "Check for updates",
    aboutChecking: "Checking...",
    aboutDownloadInstall: "Download and install",
    aboutRestart: "Restart app",
    aboutUpdateAvailable: (version) => `Update available: v${version}`,
    aboutUpdateReady: (version) => `v${version} installed`,
    aboutInstalling: "Installing update",
    aboutConnected: "SomniQ Studio is connected to the update channel",
    aboutCurrentVersion: (version) => `Current version v${version}`,
    aboutRemoteVersion: (version) => `Remote version v${version}`,
    envTitle: "Local Environment",
    envDetectingSub: "Checking local runtime environment...",
    envReadySummary: (ready, total, checkedAt) => `${ready}/${total} available${checkedAt ? ` · last checked ${checkedAt}` : ""}`,
    envSub: "Check Python, MATLAB, LaTeX, and other runtime tools.",
    envRefresh: "Refresh",
    envDetecting: "Checking...",
    envEmpty: "Refresh to show available local research and typesetting tools.",
    advancedExecutor: "Executor",
    advancedReviewer: "Reviewer",
    advancedProviderType: "Provider Type",
    advancedSummaryTools: "Summary and Tools",
    advancedSummaryToolsSub: "Summary model, Scopus key, and config file path",
    advancedCollapse: "Collapse",
    advancedExpand: "Expand",
    summaryProvider: "Summary provider",
    summaryProviderHint: "Auto uses the provider selected here and the saved key.",
    summaryFollowExecutor: "Follow executor",
    summaryManual: "Manual config",
    summaryProtocol: "Summary protocol",
    summaryBaseUrl: "Summary Base URL",
    summaryApiKey: "Summary API Key",
    summaryModel: "Summary model",
    summaryModelHint: "Model used to summarize compressed context; leave blank for Auto.",
    testTesting: "Testing...",
    testConnectionConfig: "Test connection config",
    saveConnectionConfig: "Save connection config",
    saveConnectionSavedInfo: "Saved. Applies to the next chat.",
  },
};

function normalizeLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "cn";
}

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

function isSettingsTab(value: unknown): value is SettingsTab {
  return value === "general" || value === "models" || value === "remote" || value === "about";
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

/*
function shortUsageId(value: string): string {
  const text = value.trim();
  if (!text) return "-";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function usageLogMeta(status: string, typeLabel: string): string {
  return [typeLabel, status].map((value) => value.trim()).filter(Boolean).join(" · ");
}

*/

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

function displayServerValue(value: string): string {
  return value;
}

function suggestModels(url: string): string[] {
  const lower = url.toLowerCase();
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
  formatValue,
}: {
  value: string;
  placeholder: string;
  options: PresetOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  formatValue?: (value: string) => string;
}) {
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
        <option value="__custom">Custom / manual</option>
        {options.map((option) => (
          <option key={`${option.label}:${option.value || "blank"}`} value={option.value}>
            {option.label}{option.hint ? ` - ${option.hint}` : ""}
          </option>
        ))}
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
  const keyCopy = {
    cn: {
      noSavedSecret: "没有可显示的已保存密钥",
      hideSecret: "隐藏密钥",
      showSecret: "显示密钥",
      hide: "隐藏",
      show: "显示",
    },
    en: {
      noSavedSecret: "No saved key to reveal",
      hideSecret: "Hide key",
      showSecret: "Show key",
      hide: "Hide",
      show: "Show",
    },
  }[language];
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
        else setError(keyCopy.noSavedSecret);
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
        title={error || (visible ? keyCopy.hideSecret : keyCopy.showSecret)}
      >
        {loading ? "..." : visible ? keyCopy.hide : keyCopy.show}
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
      {detail.baseUrl && <div className="st-test-url">{formatServerLabel(detail.baseUrl)}</div>}
    </div>
  );
}

export default function Settings() {
  const setError = useStore((state) => state.setError);
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const language = useStore((state) => state.language);
  const setLanguage = useStore((state) => state.setLanguage);
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
  const [environmentCheckedAt, setEnvironmentCheckedAt] = useState<number | null>(null);
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
  const copy = SETTINGS_COPY[language];

  const loadConfig = (view: ConfigView) => {
    const nextLanguage = normalizeLanguage(view.language);
    setLanguage(nextLanguage);
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
      language: nextLanguage,
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

  const loadEnvironmentChecks = async () => {
    if (!isTauri()) return;
    setEnvironmentLoading(true);
    setEnvironmentError("");
    try {
      setEnvironmentChecks(await localEnvironmentChecks());
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
    } catch (error) {
      setEnvironmentError(String(error));
    } finally {
      setEnvironmentLoading(false);
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
      const message = String(error);
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
      const message = String(error);
      setUserPromptError(message);
      setError(message);
    } finally {
      setUserPromptLoading(false);
    }
  };

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
    if (activeSettingsTab === "about" && environmentChecks.length === 0 && !environmentError && !environmentLoading) {
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
          message: "Browser preview: connection test is simulated.",
          executor: { ok: true, label: "Executor", model: advForm.executorModel, baseUrl: advForm.executorBaseUrl, message: "Preview mode" },
          reviewer: canConfigureReviewerApi ? { ok: true, label: "Reviewer", model: advForm.reviewerModel, baseUrl: advForm.reviewerBaseUrl, message: "Preview mode" } : null,
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
      const message = String(error);
      setTestResult({ ok: false, message, executor: { ok: false, label: "Settings", message } });
      setTestState("failed");
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

  if (!configView) return <div className="board"><div className="empty">{copy.loading}</div></div>;

  const advExecProvider = advForm.executorProvider ?? "anthropic";
  const advExecMeta = EXECUTOR_PROVIDERS[advExecProvider] ?? EXECUTOR_PROVIDERS.custom;
  const canConfigureExecutor = true;
  const canConfigureReviewerApi = true;
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
    if (canConfigureReviewerApi) addOption("Reviewer", configView.reviewerProvider, configView.reviewerBaseUrl, configView.reviewerModel);
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
      canConfigureReviewerApi && advForm.reviewerProvider === advForm.summarizerProvider ? advForm.reviewerModel : "",
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
  const currentConfiguredModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const currentServerLabel = configuredServerLabel(configView);

  return (
    <div className="st-page sp-list-page sp-settings-page">
      <div className="sp-settings-tabs" role="tablist" aria-label={copy.settingsCategories}>
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={activeSettingsTab === item.id}
            className={`sp-settings-tab${activeSettingsTab === item.id ? " active" : ""}`}
            onClick={() => setActiveSettingsTab(item.id)}
          >
            {copy.tabs[item.id]}
          </button>
        ))}
      </div>

      {activeSettingsTab === "general" && (
        <>
          <div className="sp-status-bar">
            <div className="sp-status-slot">
              <span className="sp-status-tag sp-status-tag-exec">{copy.statusModelService}</span>
              <span className="sp-status-model">{currentConfiguredModel}</span>
              {configView.hasExecutorKey && <span className="sp-status-key">●</span>}
              <span className="sp-status-url">{currentServerLabel}</span>
            </div>
            <div className="sp-status-sep" />
            <div className="sp-status-slot sp-status-version">
              <span className="sp-status-tag sp-status-tag-version">{copy.statusVersion}</span>
              <span className="sp-status-model">SomniQ Studio v{configView.appVersion}</span>
            </div>
          </div>

          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.languageTitle}</div>
                <div className="sp-section-sub">{copy.languageSub}</div>
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

          <div className="sp-appearance-section">
            <div className="sp-section-head">
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
          </div>
          <div className="sp-update-section">
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

          <div className="sp-update-section">
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

          <div className="sp-update-section">
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
        </>
      )}

      {activeSettingsTab === "models" && (
        <>
          <div className="sp-update-section">
            <div className="sp-section-head">
              <div className="sp-section-head-text">
                <div className="sp-section-title">{copy.modelServiceTitle}</div>
                <div className="sp-section-sub">{copy.modelServiceSub}</div>
              </div>
            </div>
            <div className="sp-model-pair">
              <label className="sp-model-select-row">
                <span>{copy.executorModel}</span>
                <span className="sp-model-select-empty">{advForm.executorModel || copy.currentModelFallback}</span>
              </label>
              <label className="sp-model-select-row">
                <span>{copy.reviewerModel}</span>
                <span className="sp-model-select-empty">{advForm.reviewerModel || copy.reviewerModelOff}</span>
              </label>
            </div>
            <div className="sp-update-panel sp-update-panel-current">
              <div className="sp-update-main">
                <span className="sp-update-dot sp-update-dot-current" />
                <div className="sp-update-copy">
                  <div className="sp-update-title">
                    {copy.currentExecutor(currentConfiguredModel)}
                  </div>
                  <div className="sp-update-meta">
                    {language === "cn" ? "在下方配置本机模型服务；配对手机只会看到已保存的模型。" : "Configure the local model service below; paired phones only see saved models."}
                  </div>
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
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.executorBaseUrl ?? ""} placeholder={advExecMeta.defaultBaseUrl || "(official default)"} options={advExecMeta.baseUrls ?? OPENAI_COMPAT_URLS} formatValue={displayServerValue} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, executorBaseUrl: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasExecutorKey ? `Saved: ${configView.executorKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={execKey} placeholder={configView.hasExecutorKey ? "leave blank to keep" : "paste API key"} masked={configView.executorKeyMasked} secretKind="executorApiKey" language={language} onChange={(value) => { resetOpState(); setExecKey(value); }} /></div></div>
                </div>
              </div>
            )}

            {canConfigureReviewerApi && (
              <div className="sp-adv-section">
                <div className="sp-adv-section-title">{copy.advancedReviewer}</div>
                <div className="sp-field-group">
                  <div className="st-field-label">{copy.advancedProviderType}</div>
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
                    <div className="st-row"><div className="st-row-label"><span className="st-label">Base URL</span></div><div className="st-row-control"><PresetTextInput value={advForm.reviewerBaseUrl ?? ""} placeholder={advReviewerMeta.defaultBaseUrl || "(provider default)"} options={advReviewerMeta.baseUrls ?? OPENAI_COMPAT_URLS} formatValue={displayServerValue} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, reviewerBaseUrl: value })); }} /></div></div>
                    <div className="st-row"><div className="st-row-label"><span className="st-label">API Key</span><span className="st-hint">{configView.hasReviewerKey ? `Saved: ${configView.reviewerKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={reviewerKey} placeholder={configView.hasReviewerKey ? "leave blank to keep" : "paste reviewer key"} masked={configView.reviewerKeyMasked} secretKind="reviewerApiKey" language={language} onChange={(value) => { resetOpState(); setReviewerKey(value); }} /></div></div>
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
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryProtocol}</span></div><div className="st-row-control"><select value={advForm.summarizerProvider ?? "openai"} onChange={(event) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerProvider: event.target.value })); }}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="anthropic-compat">Anthropic-compatible</option></select></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryBaseUrl}</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerBaseUrl ?? ""} placeholder="https://api.openai.com/v1" options={[...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS]} formatValue={displayServerValue} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerBaseUrl: value })); }} /></div></div>
                      <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryApiKey}</span><span className="st-hint">{configView.hasSummarizerKey ? `Saved: ${configView.summarizerKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={summaryKey} placeholder={configView.hasSummarizerKey ? "leave blank to keep" : "paste summary key"} masked={configView.summarizerKeyMasked} secretKind="summarizerApiKey" language={language} onChange={(value) => { resetOpState(); setSummaryKey(value); }} /></div></div>
                    </>
                  )}
                  <div className="st-row"><div className="st-row-label"><span className="st-label">{copy.summaryModel}</span><span className="st-hint">{copy.summaryModelHint}</span></div><div className="st-row-control"><PresetTextInput value={advForm.summarizerModel ?? ""} placeholder="Auto" options={summaryModelOptions} onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerModel: value })); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Scopus Key</span><span className="st-hint">{configView.hasScopusKey ? `Saved: ${configView.scopusKeyMasked ?? "configured"}` : "No key"}</span></div><div className="st-row-control"><KeyInput value={scopusKey} placeholder={configView.hasScopusKey ? "leave blank to keep" : "paste Elsevier key"} masked={configView.scopusKeyMasked} secretKind="scopusApiKey" language={language} onChange={(value) => { resetOpState(); setScopusKey(value); }} /></div></div>
                  <div className="st-row"><div className="st-row-label"><span className="st-label">Config file</span></div><div className="st-row-control"><input className="st-readonly-input" value={configView.configPath} readOnly /></div></div>
                </div>
              )}
            </div>

            {testResult && (
              <div className={`st-test-panel${testResult.ok ? " ok" : " failed"}`}>
                <div className="st-test-summary">{testResult.message}</div>
                <div className="st-test-grid">
                  {canConfigureExecutor && <TestDetail detail={testResult.executor} />}
                  {canConfigureReviewerApi && testResult.reviewer && <TestDetail detail={testResult.reviewer} />}
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

      {activeSettingsTab === "remote" && (
        <RemoteControlPanel language={language} onError={setError} />
      )}

      {/*
      {activeSettingsTab === "usage" && (
        <div className="sp-usage-section">
          <div className="sp-usage-page-head">
            <div>
              <div className="sp-usage-page-title">{copy.usageTitle}</div>
              <div className="sp-usage-page-sub">{copy.usageSub}</div>
            </div>
            <div className="sp-usage-toolbar">
              <button className="sp-btn sp-btn-secondary" onClick={refreshUsage} disabled={usageLoading} type="button">
                {usageLoading ? copy.usageRefreshing : copy.usageRefresh}
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
                      <span>{copy.accountUsedQuota}</span>
                      <strong>{formatQuota(accountUsedQuota)}</strong>
                      <small>{formatUsageExact(accountUsedQuota)} {copy.creditUnit}</small>
                    </div>
                  </div>
                  <div className="sp-usage-summary-pill">
                    <span>{copy.accountBalance}</span>
                    <strong>{formatQuota(accountRemainingQuota)}</strong>
                  </div>
                  <div className="sp-usage-summary-pill accent">
                    <span>{copy.accountTotalQuota}</span>
                    <strong>{formatQuota(accountTotalQuota)}</strong>
                  </div>
                </div>

                <div className="sp-usage-metrics">
                  <div className="sp-usage-metric sp-usage-hit-card">
                    <span>{copy.accountUsageRatio}</span>
                    <strong>{accountUsagePercent}%</strong>
                    <div className="sp-usage-progress"><div style={{ width: `${accountUsagePercent}%` }} /></div>
                  </div>
                  <div className="sp-usage-metric">
                    <span>{copy.usedQuota}</span>
                    <strong>{formatQuota(accountUsedQuota)}</strong>
                    <small>{formatUsageExact(accountUsedQuota)} {copy.creditUnit}</small>
                  </div>
                  <div className="sp-usage-metric balance">
                    <span>{copy.remainingQuota}</span>
                    <strong>{formatQuota(accountRemainingQuota)}</strong>
                    <small>{formatUsageExact(accountRemainingQuota)} {copy.creditUnit}</small>
                  </div>
                  <div className="sp-usage-metric subscription">
                    <span>{copy.subscriptionUsed}</span>
                    <strong>{formatQuota(subscriptionUsedQuota)}</strong>
                    <small>{formatUsageExact(subscriptionUsedQuota)} {copy.creditUnit}</small>
                  </div>
                  <div className="sp-usage-metric subscription">
                    <span>{copy.subscriptionBalance}</span>
                    <strong>{formatQuota(subscriptionRemainingQuota)}</strong>
                    <small>{formatUsageExact(subscriptionRemainingQuota)} {copy.creditUnit}</small>
                  </div>
                  <div className="sp-usage-metric sp-usage-hit-card">
                    <span>{copy.subscriptionUsageRatio}</span>
                    <strong>{subscriptionUsagePercent}%</strong>
                    <div className="sp-usage-progress"><div style={{ width: `${subscriptionUsagePercent}%` }} /></div>
                  </div>
                </div>
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
                        const meta = usageLogMeta(entry.status, entry.typeLabel);
                        const createdAt = entry.createdAt > 10_000_000_000 ? entry.createdAt : entry.createdAt * 1000;
                        return (
                          <div className="sp-usage-row sp-usage-row-call" key={entry.id}>
                            <span className="sp-usage-time" title={entry.createdAt ? new Date(createdAt).toLocaleString() : undefined}>
                              {formatUsageDate(entry.createdAt)}
                            </span>
                            <span className="sp-usage-model" title={entry.model || undefined}>{entry.model || "-"}</span>
                            <span title={entry.tokenName || undefined}>{entry.tokenName || "-"}</span>
                            <span title={`${copy.systemPromptTitle} ${formatUsageExact(entry.promptTokens)} / ${copy.userPromptTitle} ${formatUsageExact(entry.completionTokens)}`}>
                              {formatUsageExact(entry.totalTokens)}
                            </span>
                            <span title={`${formatUsageExact(entry.quota)} ${copy.creditUnit}${meta ? ` · ${meta}` : ""}`}>{formatQuota(entry.quota)}</span>
                            <span title={requestId || undefined}>{shortUsageId(requestId)}</span>
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
                {accountError && <div className="sp-usage-foot">{copy.usageRefreshFailed(accountError)}</div>}
              </div>
            </>
          ) : (
            <div className="sp-usage-detail-panel">
              <div className="sp-usage-empty">{accountError || copy.usageNotSignedIn}</div>
            </div>
          )}
        </div>
      )}
      */}

      {activeSettingsTab === "about" && (
        <div className="sp-update-section">
          <div className="sp-section-head">
            <div className="sp-section-head-text">
              <div className="sp-section-title">{copy.aboutUpdateTitle}</div>
              <div className="sp-section-sub">{copy.aboutUpdateSub}</div>
            </div>
            <div className="sp-update-actions">
              <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
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
                  onClick={() => { void localEnvironmentChecks(true).then(setEnvironmentChecks).then(() => setEnvironmentCheckedAt(Math.floor(Date.now() / 1000))).catch((e) => setEnvironmentError(String(e))); }}
                  disabled={environmentLoading}
                  type="button"
                >
                  {environmentLoading ? copy.envDetecting : copy.envRefresh}
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
        </div>
      )}
    </div>
  );
}

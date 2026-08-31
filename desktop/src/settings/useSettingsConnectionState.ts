import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  configSecretClear,
  configSet,
  configTest,
  isTauri,
  newapiModels,
  webSearchProviderTest,
  type NewApiAccount,
} from "../api/tauri";
import { useStore } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { notifyChatModelsUpdated } from "../modelEvents";
import type { ConfigPatch, ConfigTestDetail, ConfigTestResult, ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { isAdminAccount } from "./settingsFormatters";
import {
  EXECUTOR_PROVIDERS,
  REVIEWER_PROVIDERS,
  normalizeExecutorProvider,
  normalizeReviewerProvider,
} from "./settingsProviderCatalog";

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "passed" | "failed";

/** How long the "saved" confirmation stays up before the button resets. */
const SAVE_STATE_RESET_MS = 3000;

interface Params {
  configView: ConfigView | null;
  setConfigView: Dispatch<SetStateAction<ConfigView | null>>;
  setManagedModels: Dispatch<SetStateAction<string[]>>;
  account: NewApiAccount | null;
  setAccount: Dispatch<SetStateAction<NewApiAccount | null>>;
  previewManagedModels: string[];
}

/**
 * Owns everything shared by the General and Models tabs: the single
 * `advForm` draft (theme/language save button + executor/reviewer/summarizer
 * config all commit through the same `save()`), the 7 API-key drafts, and
 * the model-sync/test/apply actions. `configView`/`managedModels`/`account`
 * stay parent-owned since Account and Environment also touch them.
 */
export function useSettingsConnectionState({
  configView,
  setConfigView,
  setManagedModels,
  account,
  setAccount,
  previewManagedModels,
}: Params) {
  const setError = useStore((state) => state.setError);
  const setLanguage = useStore((state) => state.setLanguage);
  const language = useStore((state) => state.language);
  const copy = SETTINGS_COPY[language].providers;

  const [advForm, setAdvForm] = useState<ConfigPatch>({});
  const [execKey, setExecKey] = useState("");
  const [summaryKey, setSummaryKey] = useState("");
  const [reviewerKey, setReviewerKey] = useState("");
  const [scopusKey, setScopusKey] = useState("");
  const [openalexKey, setOpenalexKey] = useState("");
  const [bochaKey, setBochaKey] = useState("");
  const [braveSearchKey, setBraveSearchKey] = useState("");
  const [exaKey, setExaKey] = useState("");
  const [zhihuAccessSecret, setZhihuAccessSecret] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  const [webProviderTestState, setWebProviderTestState] = useState<
    Partial<Record<"brave" | "exa" | "zhihu" | "bocha", ConfigTestDetail & { testing?: boolean }>>
  >({});
  const [managedModelsLoading, setManagedModelsLoading] = useState(false);
  const [managedModelsError, setManagedModelsError] = useState("");
  const savedTimerRef = useRef<number | null>(null);

  const canConfigureExecutor = isAdminAccount(account);
  const canConfigureReviewerApi = canConfigureExecutor;

  useEffect(() => () => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
  }, []);

  /**
   * Reseeds every draft from a freshly confirmed `ConfigView`. This is a full
   * reset, not a merge: all API-key drafts are cleared, because a key that has
   * been persisted must not linger as plaintext in component state. Callers
   * that only touch one unrelated field (e.g. the Python env path) should
   * update `configView` directly instead, or they will drop the user's
   * unsaved key edits on the Models tab.
   */
  const loadConfig = (view: ConfigView) => {
    const nextLanguage = view.language === "en" ? "en" : "cn";
    setLanguage(nextLanguage);
    setConfigView(view);
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
      webProxyUrl: view.webProxyUrl ?? "",
      language: nextLanguage,
      memoryWriteApproval: view.memoryWriteApproval,
    });
    setExecKey("");
    setSummaryKey("");
    setReviewerKey("");
    setScopusKey("");
    setOpenalexKey("");
    setBochaKey("");
    setBraveSearchKey("");
    setExaKey("");
    setZhihuAccessSecret("");
  };

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
    if (bochaKey.trim()) patch.bochaApiKey = bochaKey.trim();
    if (braveSearchKey.trim()) patch.braveSearchApiKey = braveSearchKey.trim();
    if (exaKey.trim()) patch.exaApiKey = exaKey.trim();
    if (zhihuAccessSecret.trim()) patch.zhihuAccessSecret = zhihuAccessSecret.trim();
    return patch;
  };

  const resetOpState = () => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
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
        setConfigView((current) => current ? { ...current, ...buildPatch({ includeExecutor: false, includeReviewer: false }) } : current);
        setSaveState("saved");
        savedTimerRef.current = window.setTimeout(() => setSaveState("idle"), SAVE_STATE_RESET_MS);
        notifyChatModelsUpdated();
        return;
      }
      const next = await configSet(buildPatch({ includeExecutor: false, includeReviewer: false }));
      loadConfig(next);
      setSaveState("saved");
      savedTimerRef.current = window.setTimeout(() => setSaveState("idle"), SAVE_STATE_RESET_MS);
      notifyChatModelsUpdated();
    } catch (error) {
      setError(formatUserFacingError(error, language));
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
          executor: { ok: true, label: copy.previewExecutorLabel, model: configView?.executorModel ?? "auto", baseUrl: configView?.executorBaseUrl ?? "", message: copy.previewMode },
          reviewer: configView?.reviewerModel ? { ok: true, label: copy.previewReviewerLabel, model: configView.reviewerModel, baseUrl: configView.reviewerBaseUrl ?? "", message: copy.previewMode } : null,
        };
        setTestResult(result);
        setTestState("passed");
        return;
      }
      const result = await configTest(buildPatch({ includeExecutor: false, includeReviewer: false }));
      setTestResult(result);
      setTestState(result.ok ? "passed" : "failed");
      if (result.ok) notifyChatModelsUpdated();
    } catch (error) {
      const message = formatUserFacingError(error, language);
      setTestResult({ ok: false, message, executor: { ok: false, label: copy.previewSettingsLabel, message } });
      setTestState("failed");
    }
  };

  const testWebProvider = async (provider: "brave" | "exa" | "zhihu" | "bocha") => {
    setWebProviderTestState((current) => ({
      ...current,
      [provider]: {
        ok: false,
        label: provider === "bocha" ? "Bocha AI" : provider.toUpperCase(),
        message: language === "cn" ? "正在测试连接…" : "Testing connection…",
        testing: true,
      },
    }));
    try {
      const draftKey = provider === "brave"
        ? braveSearchKey
        : provider === "exa"
          ? exaKey
          : provider === "bocha"
            ? bochaKey
            : zhihuAccessSecret;
      const result = isTauri()
        ? await webSearchProviderTest(provider, draftKey)
        : {
          ok: true,
          label: provider === "zhihu" ? "Zhihu Search" : provider === "bocha" ? "Bocha AI Search" : `${provider.toUpperCase()} Web Search`,
          provider,
          baseUrl: provider === "brave"
            ? "https://api.search.brave.com"
            : provider === "exa"
              ? "https://api.exa.ai"
              : provider === "bocha"
                ? "https://api.bochaai.com/v1/web-search"
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
          label: provider === "bocha" ? "Bocha AI" : provider.toUpperCase(),
          provider,
          message: formatUserFacingError(error, language),
        },
      }));
    }
  };

  const clearWebProviderKey = async (
    provider: "brave" | "exa" | "zhihu" | "bocha",
    kind: "braveSearchApiKey" | "exaApiKey" | "zhihuAccessSecret" | "bochaApiKey",
  ) => {
    const secretLabel = provider === "brave"
      ? copy.fieldBraveSearchKey
      : provider === "exa"
        ? copy.fieldExaKey
        : provider === "bocha"
          ? copy.fieldBochaKey
          : copy.fieldZhihuAccessSecret;
    if (!window.confirm(copy.clearProviderKeyConfirm(secretLabel))) return;
    try {
      if (isTauri()) {
        loadConfig(await configSecretClear(kind));
      }
      if (provider === "brave") setBraveSearchKey("");
      else if (provider === "exa") setExaKey("");
      else if (provider === "bocha") setBochaKey("");
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

  // The hook outlives the Models tab, so a verdict from an earlier visit would
  // otherwise still be on screen after the drafts behind it were cleared.
  // Stable identity: the Models tab uses it as an unmount cleanup.
  const resetWebProviderTests = useCallback(() => setWebProviderTestState({}), []);

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
      setConfigView(next);
      setAdvForm((current) => ({ ...current, executorModel: next.executorModel ?? "" }));
      setAccount((current) => (current ? { ...current, model } : current));
      notifyChatModelsUpdated();
    } catch (error) {
      setError(formatUserFacingError(error, language));
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
      setConfigView(next);
      setAdvForm((current) => ({
        ...current,
        reviewerProvider: normalizeReviewerProvider(next.reviewerProvider),
        reviewerModel: next.reviewerModel ?? "",
        reviewerBaseUrl: next.reviewerBaseUrl ?? "",
      }));
    } catch (error) {
      setError(formatUserFacingError(error, language));
    }
  };

  const loadManagedModels = async () => {
    if (!isTauri()) {
      setManagedModels(previewManagedModels);
      setConfigView((current) => current ? { ...current, managedModels: previewManagedModels } : current);
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

  const chooseSummaryProvider = (key: string, summaryProviderOptions: Array<{ key: string; provider: string; baseUrl: string }>) => {
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

  return {
    advForm, setAdvForm,
    execKey, setExecKey,
    summaryKey, setSummaryKey,
    reviewerKey, setReviewerKey,
    scopusKey, setScopusKey,
    openalexKey, setOpenalexKey,
    bochaKey, setBochaKey,
    braveSearchKey, setBraveSearchKey,
    exaKey, setExaKey,
    zhihuAccessSecret, setZhihuAccessSecret,
    saveState, testState, testResult, webProviderTestState,
    managedModelsLoading, managedModelsError,
    canConfigureExecutor, canConfigureReviewerApi,
    loadConfig, resetOpState, save, test, testWebProvider, clearWebProviderKey, resetWebProviderTests,
    applyManagedModel, applyManagedReviewerModel, loadManagedModels,
    chooseExecProvider, chooseReviewerProvider, chooseSummaryProvider,
  };
}

export type SettingsConnectionState = ReturnType<typeof useSettingsConnectionState>;

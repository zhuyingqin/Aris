import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  configSet,
  isTauri,
  newapiModels,
  type NewApiAccount,
} from "../api/tauri";
import { useStore, type Language } from "../store";
import { hasNativeBackend } from "../api/transport";
import { formatUserFacingError } from "../errorMessage";
import { notifyChatModelsUpdated } from "../modelEvents";
import type { ConfigPatch, ConfigView } from "../types";
import { useModelAutoSave } from "./useModelAutoSave";
import {
  normalizeExecutorProvider,
  normalizeReviewerProvider,
} from "./settingsProviderCatalog";

type SaveState = "idle" | "saving" | "saved" | "error";
type ReviewMode = NonNullable<ConfigView["reviewMode"]>;

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
 * `advForm` connection draft, independent immediate preferences, and
 * the account model actions. `configView`/`managedModels`/`account`
 * stay parent-owned since Account and Environment also touch them.
 */
export function useSettingsConnectionState({
  configView,
  setConfigView,
  setManagedModels,
  setAccount,
  previewManagedModels,
}: Params) {
  const setError = useStore((state) => state.setError);
  const setLanguage = useStore((state) => state.setLanguage);
  const language = useStore((state) => state.language);

  const [advForm, setAdvForm] = useState<ConfigPatch>({});
  const [memorySaveState, setMemorySaveState] = useState<SaveState>("idle");
  const [memorySaveError, setMemorySaveError] = useState("");
  const memorySavePending = useRef(false);
  const memorySaveTarget = useRef(false);
  const [managedModelsLoading, setManagedModelsLoading] = useState(false);
  const [managedModelsError, setManagedModelsError] = useState("");
  const modelAutoSave = useModelAutoSave({
    configView, setConfigView, draft: advForm, setDraft: setAdvForm, language,
  });

  /** Reseed confirmed settings while preserving independent preference saves. */
  const loadConfig = (view: ConfigView, preservePreferences = false) => {
    const nextLanguage = view.language === "en" ? "en" : "cn";
    if (!preservePreferences) setLanguage(nextLanguage, { syncRuntime: false });
    setConfigView((current) => preservePreferences && current ? {
      ...view, language: current.language, memoryWriteApproval: current.memoryWriteApproval,
    } : view);
    setAdvForm((current) => ({
      executorProvider: normalizeExecutorProvider(view.executorProvider, view.executorBaseUrl),
      executorModel: view.executorModel ?? "",
      executorBaseUrl: view.executorBaseUrl ?? "",
      summarizerModel: view.summarizerModel ?? "",
      retrievalCardModel: view.retrievalCardModel ?? "",
      reviewerProvider: normalizeReviewerProvider(view.reviewerProvider),
      reviewerModel: view.reviewerModel ?? "",
      reviewerBaseUrl: view.reviewerBaseUrl ?? "",
      webProxyUrl: view.webProxyUrl ?? "",
      language: preservePreferences ? current.language : nextLanguage,
      memoryWriteApproval: preservePreferences ? current.memoryWriteApproval : view.memoryWriteApproval,
      memoryV2Mode: view.memoryV2Mode,
    }));
  };

  const saveLanguage = async (value: Language) => {
    const native = hasNativeBackend();
    const confirmed = native ? (await configSet({ language: value })).language : value;
    const next = confirmed === "en" ? "en" : "cn";
    // Native config is authoritative; local storage is its startup cache.
    setLanguage(next, { syncRuntime: false, requirePersistence: !native });
    setConfigView((current) => current ? { ...current, language: next } : current);
    setAdvForm((current) => ({ ...current, language: next }));
  };

  // Keep this preference independent from pending model edits.
  // Keep the request here so switching settings tabs cannot lose its result.
  const saveMemoryWriteApproval = async (value: boolean) => {
    if (memorySavePending.current) return;
    memorySavePending.current = true;
    memorySaveTarget.current = value;
    setMemorySaveState("saving");
    setMemorySaveError("");
    try {
      const confirmed = hasNativeBackend() ? (await configSet({ memoryWriteApproval: value })).memoryWriteApproval : value;
      setConfigView((current) => current ? { ...current, memoryWriteApproval: confirmed } : current);
      setAdvForm((current) => ({ ...current, memoryWriteApproval: confirmed }));
      setMemorySaveState("saved");
    } catch (error) {
      setMemorySaveError(formatUserFacingError(error, language));
      setMemorySaveState("error");
    } finally {
      memorySavePending.current = false;
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
      const next = await configSet({ executorProvider: "openai", executorModel: model });
      setConfigView(next);
      setAdvForm((current) => ({ ...current, executorProvider: next.executorProvider ?? "openai", executorBaseUrl: next.executorBaseUrl ?? "", executorModel: next.executorModel ?? "" }));
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
        ? { reviewerProvider: "custom", reviewerModel: model }
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

  // Save the review mode independently of pending model edits.
  const applyReviewMode = async (mode: ReviewMode) => {
    if (mode === (configView?.reviewMode ?? "thread")) return;
    try {
      const confirmed = hasNativeBackend() ? (await configSet({ reviewMode: mode })).reviewMode : mode;
      setConfigView((current) => current ? { ...current, reviewMode: confirmed } : current);
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
      setAccount((current) => current ? { ...current, models } : current);
    } catch (error) {
      setManagedModelsError(formatUserFacingError(error, language));
    } finally {
      setManagedModelsLoading(false);
    }
  };

  return {
    modelAutoSave, advForm, setAdvForm,
    memorySaveState, memorySaveError, saveMemoryWriteApproval, saveLanguage,
    retryMemoryWriteApproval: () => saveMemoryWriteApproval(memorySaveTarget.current),
    managedModelsLoading, managedModelsError,
    loadConfig, applyManagedModel, applyManagedReviewerModel, applyReviewMode, loadManagedModels,
  };
}

export type SettingsConnectionState = ReturnType<typeof useSettingsConnectionState>;

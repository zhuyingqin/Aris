import { useEffect } from "react";
import type { NewApiAccount } from "../api/tauri";
import { isImageGenerationModel } from "../imageModels";
import SomniImageSettings from "./SomniImageSettings";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import KeyInput from "./KeyInput";
import PresetTextInput from "./PresetTextInput";
import type { SettingsConnectionState } from "./useSettingsConnectionState";
import { SettingRow, SettingsAdvanced, SettingsFeedback, SettingsSection } from "./SettingsPrimitives";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import "./ModelsSettings.css";
import {
  ANTHROPIC_COMPAT_URLS,
  OPENAI_COMPAT_URLS,
  detectProtocol,
  displayServerValue,
  formatServerLabel,
  providerKey,
  suggestModels,
  uniqueModelList,
  type PresetOption,
} from "./settingsProviderCatalog";

interface Props {
  language: Language;
  configView: ConfigView;
  account: NewApiAccount | null;
  managedModels: string[];
  connection: SettingsConnectionState;
}

export default function ModelsSettings({ language, configView, managedModels, connection }: Props) {
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const {
    advForm, setAdvForm,
    summaryKey, setSummaryKey,
    scopusKey, setScopusKey,
    braveSearchKey, setBraveSearchKey,
    exaKey, setExaKey,
    modelAutoSave, webProviderTestState,
    managedModelsLoading, managedModelsError,
    resetOpState, testWebProvider, clearWebProviderKey, resetWebProviderTests,
    applyManagedModel, applyManagedReviewerModel, loadManagedModels,
    chooseSummaryProvider,
  } = connection;

  // Search-provider verdicts belong to this visit: the hook that holds them
  // stays mounted for the whole Settings page, so drop them on the way out
  // rather than showing a stale pass/fail next time the tab opens.
  useEffect(() => resetWebProviderTests, [resetWebProviderTests]);

  const SUMMARIZER_MODELS: PresetOption[] = [
    { label: copy.summaryAutoLabel, value: "", hint: copy.summaryAutoHint },
    { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", hint: copy.summaryFastHint },
    { label: copy.summaryOffLabel, value: "off", hint: copy.summaryOffHint },
  ];

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
    addOption(copy.summaryProviderReviewer, configView.reviewerProvider, configView.reviewerBaseUrl, configView.reviewerModel);
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
      advForm.reviewerProvider === advForm.summarizerProvider ? advForm.reviewerModel : "",
    ].filter((model): model is string => Boolean(model?.trim())))).map((model) => ({
      label: model,
      value: model,
      hint: selectedSummaryProvider?.label,
    })),
  ];
  const retrievalCardModelOptions = uniqueModelList(
    [configView.executorModel, advForm.executorModel],
    configView.managedModels,
    (configView.verifiedExecutors ?? []).map((item) => item.model),
  ).filter((model) => !isImageGenerationModel(model)).map((model) => ({ label: model, value: model }));

  const currentManagedModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const availableManagedModels = uniqueModelList(
    managedModels,
    [configView.executorModel, configView.reviewerModel],
  ).filter((model) => !isImageGenerationModel(model));
  const currentReviewerModel = configView.reviewerModel?.trim() || "";
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

  return (
    <>
      <SettingsSection title={copy.modelServiceTitle} actions={
        <button className="sp-btn sp-btn-secondary" onClick={() => void loadManagedModels()} disabled={managedModelsLoading} type="button">
          <SvgIcon name={managedModelsLoading ? "spinner" : "refresh"} size={13} />
          {managedModelsLoading ? copy.modelSyncing : copy.modelSync}
        </button>
      }>
        <SettingRow title={copy.executorModel} description={executorTransport ? executorTransport === "responses" ? copy.transportResponses : copy.transportChat : undefined}>
          {availableManagedModels.length > 0 ? (
            <select
              aria-label={copy.executorModel}
              title={executorTransport ? copy.transportHint : undefined}
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
        </SettingRow>
        <SettingRow title={copy.reviewerModel}>
          {availableManagedModels.length > 0 ? (
            <select
              aria-label={copy.reviewerModel}
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
        </SettingRow>
        <div className="settings-model-status">
          <p>
            {copy.currentExecutor(currentManagedModel)}
            {currentReviewerModel ? copy.currentReviewer(currentReviewerModel) : copy.reviewerOff}
          </p>
          <SettingsFeedback state={managedModelsError ? "error" : managedModelsLoading ? "saving" : "saved"}
            message={managedModelsLoading
              ? copy.modelSyncingStatus
              : managedModelsError
                ? managedModelsError
                : availableManagedModels.length > 0
                  ? copy.modelSynced(availableManagedModels.length)
                  : copy.modelSyncAfterLoginStatus} />
        </div>
      </SettingsSection>

      <SomniImageSettings language={language} models={managedModels} />

      <div className="settings-model-sections">

        {/* Section 1: Auxiliary Models */}
        <SettingsSection title={copy.sectionAuxiliaryModels}>
          <SettingRow title={copy.summaryProvider}>
            <select aria-label={copy.summaryProvider} value={summarySelectValue} onChange={(event) => chooseSummaryProvider(event.target.value, summaryProviderOptions)}>
              <option value="">{copy.summaryFollowExecutor}</option>
              <option value="__manual">{copy.summaryManual}</option>
              {summaryProviderOptions.map((item) => (
                <option key={item.key} value={item.key}>{item.label}{item.model ? ` · ${item.model}` : ""}</option>
              ))}
            </select>
          </SettingRow>
          {isManualSummaryProvider && (
            <>
              <SettingRow title={copy.summaryProtocol}>
                <select aria-label={copy.summaryProtocol} value={advForm.summarizerProvider ?? "openai"} onChange={(event) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerProvider: event.target.value })); }}>
                  <option value="openai">{copy.protocolOpenAiCompatible}</option>
                  <option value="opencode">{language === "cn" ? "OpenCode（固定渠道）" : "OpenCode (fixed channel)"}</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="anthropic-compat">{copy.protocolAnthropicCompatible}</option>
                </select>
              </SettingRow>
              <SettingRow title={copy.summaryBaseUrl}>
                <PresetTextInput
                  label={copy.summaryBaseUrl}
                  value={advForm.summarizerBaseUrl ?? ""}
                  placeholder="https://api.openai.com/v1"
                  options={[...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS]}
                  formatValue={(value) => displayServerValue(value, language)}
                  onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerBaseUrl: value })); }}
                />
              </SettingRow>
              <SettingRow title={copy.summaryApiKey} description={configView.hasSummarizerKey ? copy.keySaved(configView.summarizerKeyMasked ?? copy.keyConfigured) : copy.keyNone}>
                <KeyInput
                  label={copy.summaryApiKey}
                  value={summaryKey}
                  placeholder={configView.hasSummarizerKey ? copy.keyKeep : copy.keyPasteSummary}
                  masked={configView.summarizerKeyMasked}
                  secretKind="summarizerApiKey"
                  language={language}
                  onChange={(value) => { resetOpState(); setSummaryKey(value); }}
                />
              </SettingRow>
            </>
          )}
          <SettingRow title={copy.summaryModel} description={copy.summaryModelHint}>
            <PresetTextInput
              label={copy.summaryModel}
              value={advForm.summarizerModel ?? ""}
              placeholder={copy.automaticPlaceholder}
              options={summaryModelOptions}
              onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerModel: value })); }}
            />
          </SettingRow>
          <SettingRow title={copy.retrievalCardModel} description={copy.retrievalCardModelHint}>
            <PresetTextInput
              label={copy.retrievalCardModel}
              value={advForm.retrievalCardModel ?? ""}
              placeholder={copy.retrievalCardFollowExecutor}
              options={retrievalCardModelOptions}
              onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, retrievalCardModel: value })); }}
            />
          </SettingRow>
        </SettingsSection>

        {/* Section 2: Literature APIs */}
        <SettingsSection title={copy.sectionLiteratureServices}>
          <SettingRow title={copy.fieldScopusKey} description={configView.hasScopusKey ? copy.keySaved(configView.scopusKeyMasked ?? copy.keyConfigured) : copy.keyNone}>
            <KeyInput
              label={copy.fieldScopusKey}
              value={scopusKey}
              placeholder={configView.hasScopusKey ? copy.keyKeep : copy.keyPasteScopus}
              masked={configView.scopusKeyMasked}
              secretKind="scopusApiKey"
              language={language}
              onChange={(value) => { resetOpState(); setScopusKey(value); }}
            />
          </SettingRow>
          <SettingRow title={copy.fieldOpenalexKey} description={copy.openalexGatewayHint} children={null} />
        </SettingsSection>

        {/* Section 3: Web Search & Community */}
        <SettingsSection title={copy.sectionWebSearchServices}>
          <SettingRow title={copy.fieldWebProxyUrl} description={copy.webProxyHint}>
            <input
              aria-label={copy.fieldWebProxyUrl}
              value={advForm.webProxyUrl ?? ""}
              placeholder={copy.webProxyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                resetOpState();
                setAdvForm((current) => ({ ...current, webProxyUrl: event.target.value }));
              }}
            />
          </SettingRow>
          <SettingRow title={copy.fieldBraveSearchKey}
            description={configView.hasBraveSearchKey ? copy.keySaved(configView.braveSearchKeyMasked ?? copy.keyConfigured) : copy.keyNone}
            feedback={webProviderTestState.brave && <SettingsFeedback state={webProviderTestState.brave.testing ? "saving" : webProviderTestState.brave.ok ? "saved" : "error"} message={webProviderTestState.brave.message} />}>
            <div className="settings-model-search-control">
              <KeyInput
                label={copy.fieldBraveSearchKey}
                value={braveSearchKey}
                placeholder={configView.hasBraveSearchKey ? copy.keyKeep : copy.keyPasteBraveSearch}
                masked={configView.braveSearchKeyMasked}
                secretKind="braveSearchApiKey"
                language={language}
                onChange={(value) => { resetOpState(); setBraveSearchKey(value); }}
              />
              <div className="settings-model-service-actions">
                <button type="button" className="sp-btn sp-btn-secondary" onClick={() => void testWebProvider("brave")} disabled={webProviderTestState.brave?.testing}>
                  {webProviderTestState.brave?.testing && <SvgIcon name="spinner" size={13} />}
                  {language === "cn" ? "测试" : "Test"}
                </button>
                {configView.hasBraveSearchKey && (
                  <button type="button" className="sp-btn sp-btn-secondary settings-model-button-danger" onClick={() => void clearWebProviderKey("brave", "braveSearchApiKey")}>
                    {language === "cn" ? "清除" : "Clear"}
                  </button>
                )}
              </div>
            </div>
          </SettingRow>
          <SettingRow title={copy.fieldExaKey}
            description={configView.hasExaKey ? copy.keySaved(configView.exaKeyMasked ?? copy.keyConfigured) : copy.keyNone}
            feedback={webProviderTestState.exa && <SettingsFeedback state={webProviderTestState.exa.testing ? "saving" : webProviderTestState.exa.ok ? "saved" : "error"} message={webProviderTestState.exa.message} />}>
            <div className="settings-model-search-control">
              <KeyInput
                label={copy.fieldExaKey}
                value={exaKey}
                placeholder={configView.hasExaKey ? copy.keyKeep : copy.keyPasteExa}
                masked={configView.exaKeyMasked}
                secretKind="exaApiKey"
                language={language}
                onChange={(value) => { resetOpState(); setExaKey(value); }}
              />
              <div className="settings-model-service-actions">
                <button type="button" className="sp-btn sp-btn-secondary" onClick={() => void testWebProvider("exa")} disabled={webProviderTestState.exa?.testing}>
                  {webProviderTestState.exa?.testing && <SvgIcon name="spinner" size={13} />}
                  {language === "cn" ? "测试" : "Test"}
                </button>
                {configView.hasExaKey && (
                  <button type="button" className="sp-btn sp-btn-secondary settings-model-button-danger" onClick={() => void clearWebProviderKey("exa", "exaApiKey")}>
                    {language === "cn" ? "清除" : "Clear"}
                  </button>
                )}
              </div>
            </div>
          </SettingRow>
        </SettingsSection>

        {/* Section 4: System / Config File */}
        <SettingsAdvanced title={SETTINGS_LAYOUT_COPY[language].advanced}>
          <div className="settings-section-body">
            <SettingRow title={copy.fieldConfigFile}>
              <input aria-label={copy.fieldConfigFile} className="st-readonly-input" value={configView.configPath} title={configView.configPath} readOnly />
            </SettingRow>
          </div>
        </SettingsAdvanced>

        {modelAutoSave.error && <SettingsFeedback state="error"
          message={`${GENERAL_PAGE_COPY[language].saveFailed} ${modelAutoSave.error}`}
          retryLabel={GENERAL_PAGE_COPY[language].retry} onRetry={modelAutoSave.retry} />}
      </div>
    </>
  );
}

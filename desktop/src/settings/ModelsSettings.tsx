import { useEffect } from "react";
import type { NewApiAccount } from "../api/tauri";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import KeyInput from "./KeyInput";
import PresetTextInput from "./PresetTextInput";
import TestDetail from "./TestDetail";
import type { SettingsConnectionState } from "./useSettingsConnectionState";
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

export default function ModelsSettings({ language, configView, account, managedModels, connection }: Props) {
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const {
    advForm, setAdvForm,
    summaryKey, setSummaryKey,
    scopusKey, setScopusKey,
    openalexKey, setOpenalexKey,
    braveSearchKey, setBraveSearchKey,
    exaKey, setExaKey,
    zhihuAccessSecret, setZhihuAccessSecret,
    saveState, testState, testResult, webProviderTestState,
    managedModelsLoading, managedModelsError,
    resetOpState, save, test, testWebProvider, clearWebProviderKey, resetWebProviderTests,
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
  ).map((model) => ({ label: model, value: model }));

  const currentManagedModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const availableManagedModels = uniqueModelList(
    managedModels,
    configView.managedModels,
    [configView.executorModel, configView.reviewerModel],
    account?.models,
  );
  const managedModelPreview = availableManagedModels.slice(0, 12);
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
            {availableManagedModels.length > 0 ? (
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

      <div className="sp-advanced-wrap sp-advanced-wrap-tab">
        <div className="sp-advanced-body">
          <div className="sp-adv-main-header">
            <div className="sp-section-title">{copy.advancedSummaryTools}</div>
            <div className="sp-section-sub">{copy.advancedSummaryToolsSub}</div>
          </div>

          {/* Section 1: Auxiliary Models */}
          <div className="sp-adv-section">
            <div className="sp-adv-section-head">
              <span className="sp-adv-section-title">{copy.sectionAuxiliaryModels}</span>
              <span className="sp-adv-section-sub">{copy.sectionAuxiliaryModelsSub}</span>
            </div>
            <div className="sp-adv-rows">
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.summaryProvider}</span>
                  {copy.summaryProviderHint ? <span className="st-hint">{copy.summaryProviderHint}</span> : null}
                </div>
                <div className="st-row-control">
                  <select value={summarySelectValue} onChange={(event) => chooseSummaryProvider(event.target.value, summaryProviderOptions)}>
                    <option value="">{copy.summaryFollowExecutor}</option>
                    <option value="__manual">{copy.summaryManual}</option>
                    {summaryProviderOptions.map((item) => (
                      <option key={item.key} value={item.key}>{item.label}{item.model ? ` · ${item.model}` : ""}</option>
                    ))}
                  </select>
                </div>
              </div>
              {isManualSummaryProvider && (
                <>
                  <div className="st-row">
                    <div className="st-row-label"><span className="st-label">{copy.summaryProtocol}</span></div>
                    <div className="st-row-control">
                      <select value={advForm.summarizerProvider ?? "openai"} onChange={(event) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerProvider: event.target.value })); }}>
                        <option value="openai">{copy.protocolOpenAiCompatible}</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="anthropic-compat">{copy.protocolAnthropicCompatible}</option>
                      </select>
                    </div>
                  </div>
                  <div className="st-row">
                    <div className="st-row-label"><span className="st-label">{copy.summaryBaseUrl}</span></div>
                    <div className="st-row-control">
                      <PresetTextInput
                        value={advForm.summarizerBaseUrl ?? ""}
                        placeholder="https://api.openai.com/v1"
                        options={[...OPENAI_COMPAT_URLS, ...ANTHROPIC_COMPAT_URLS]}
                        formatValue={(value) => displayServerValue(value, language)}
                        onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerBaseUrl: value })); }}
                      />
                    </div>
                  </div>
                  <div className="st-row">
                    <div className="st-row-label">
                      <span className="st-label">{copy.summaryApiKey}</span>
                      <span className="st-hint">{configView.hasSummarizerKey ? copy.keySaved(configView.summarizerKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span>
                    </div>
                    <div className="st-row-control">
                      <KeyInput
                        value={summaryKey}
                        placeholder={configView.hasSummarizerKey ? copy.keyKeep : copy.keyPasteSummary}
                        masked={configView.summarizerKeyMasked}
                        secretKind="summarizerApiKey"
                        language={language}
                        onChange={(value) => { resetOpState(); setSummaryKey(value); }}
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.summaryModel}</span>
                  <span className="st-hint">{copy.summaryModelHint}</span>
                </div>
                <div className="st-row-control">
                  <PresetTextInput
                    value={advForm.summarizerModel ?? ""}
                    placeholder={copy.automaticPlaceholder}
                    options={summaryModelOptions}
                    onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, summarizerModel: value })); }}
                  />
                </div>
              </div>
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.retrievalCardModel}</span>
                  <span className="st-hint">{copy.retrievalCardModelHint}</span>
                </div>
                <div className="st-row-control">
                  <PresetTextInput
                    value={advForm.retrievalCardModel ?? ""}
                    placeholder={copy.retrievalCardFollowExecutor}
                    options={retrievalCardModelOptions}
                    onChange={(value) => { resetOpState(); setAdvForm((current) => ({ ...current, retrievalCardModel: value })); }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Literature APIs */}
          <div className="sp-adv-section">
            <div className="sp-adv-section-head">
              <span className="sp-adv-section-title">{copy.sectionLiteratureServices}</span>
              <span className="sp-adv-section-sub">{copy.sectionLiteratureServicesSub}</span>
            </div>
            <div className="sp-adv-rows">
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.fieldScopusKey}</span>
                  <span className="st-hint">{configView.hasScopusKey ? copy.keySaved(configView.scopusKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span>
                </div>
                <div className="st-row-control">
                  <KeyInput
                    value={scopusKey}
                    placeholder={configView.hasScopusKey ? copy.keyKeep : copy.keyPasteScopus}
                    masked={configView.scopusKeyMasked}
                    secretKind="scopusApiKey"
                    language={language}
                    onChange={(value) => { resetOpState(); setScopusKey(value); }}
                  />
                </div>
              </div>
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.fieldOpenalexKey}</span>
                  <span className="st-hint">{configView.hasOpenalexKey ? copy.keySaved(configView.openalexKeyMasked ?? copy.keyConfigured) : copy.keyNone}</span>
                </div>
                <div className="st-row-control">
                  <KeyInput
                    value={openalexKey}
                    placeholder={configView.hasOpenalexKey ? copy.keyKeep : copy.keyPasteOpenalex}
                    masked={configView.openalexKeyMasked}
                    secretKind="openalexApiKey"
                    language={language}
                    onChange={(value) => { resetOpState(); setOpenalexKey(value); }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Web Search & Community */}
          <div className="sp-adv-section">
            <div className="sp-adv-section-head">
              <span className="sp-adv-section-title">{copy.sectionWebSearchServices}</span>
              <span className="sp-adv-section-sub">{copy.sectionWebSearchServicesSub}</span>
            </div>
            <div className="sp-adv-rows">
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.fieldWebProxyUrl}</span>
                  <span className="st-hint">{copy.webProxyHint}</span>
                </div>
                <div className="st-row-control">
                  <input
                    value={advForm.webProxyUrl ?? ""}
                    placeholder={copy.webProxyPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      resetOpState();
                      setAdvForm((current) => ({ ...current, webProxyUrl: event.target.value }));
                    }}
                  />
                </div>
              </div>
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
                  <KeyInput
                    value={braveSearchKey}
                    placeholder={configView.hasBraveSearchKey ? copy.keyKeep : copy.keyPasteBraveSearch}
                    masked={configView.braveSearchKeyMasked}
                    secretKind="braveSearchApiKey"
                    language={language}
                    onChange={(value) => { resetOpState(); setBraveSearchKey(value); }}
                  />
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
                  <KeyInput
                    value={exaKey}
                    placeholder={configView.hasExaKey ? copy.keyKeep : copy.keyPasteExa}
                    masked={configView.exaKeyMasked}
                    secretKind="exaApiKey"
                    language={language}
                    onChange={(value) => { resetOpState(); setExaKey(value); }}
                  />
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
                  <span className="st-label" title={copy.zhihuSearchHint}>{copy.fieldZhihuAccessSecret}</span>
                  <span className="st-hint">
                    {configView.hasZhihuAccessSecret ? copy.keySaved(configView.zhihuAccessSecretMasked ?? copy.keyConfigured) : copy.keyNone}
                  </span>
                  {webProviderTestState.zhihu && (
                    <span className={`st-hint${webProviderTestState.zhihu.ok ? " ok" : " failed"}`}>
                      {webProviderTestState.zhihu.message}
                    </span>
                  )}
                </div>
                <div className="st-row-control st-search-service-control">
                  <KeyInput
                    value={zhihuAccessSecret}
                    placeholder={configView.hasZhihuAccessSecret ? copy.keyKeep : copy.keyPasteZhihuAccessSecret}
                    masked={configView.zhihuAccessSecretMasked}
                    secretKind="zhihuAccessSecret"
                    language={language}
                    onChange={(value) => { resetOpState(); setZhihuAccessSecret(value); }}
                  />
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
            </div>
          </div>

          {/* Section 4: System / Config File */}
          <div className="sp-adv-section">
            <div className="sp-adv-rows">
              <div className="st-row">
                <div className="st-row-label">
                  <span className="st-label">{copy.fieldConfigFile}</span>
                </div>
                <div className="st-row-control">
                  <input className="st-readonly-input" value={configView.configPath} readOnly />
                </div>
              </div>
            </div>
          </div>

          {testResult && (
            <div className={`st-test-panel${testResult.ok ? " ok" : " failed"}`}>
              <div className="st-test-summary">{testResult.message}</div>
              <div className="st-test-grid">
                {testResult.executor && <TestDetail detail={testResult.executor} language={language} />}
                {testResult.reviewer && <TestDetail detail={testResult.reviewer} language={language} />}
              </div>
            </div>
          )}
          <div className="sp-detail-actions sp-advanced-actions">
            <button className="sp-btn sp-btn-secondary" onClick={() => void test()} disabled={testState === "testing" || saveState === "saving"} type="button">
              {testState === "testing" ? copy.testTesting : copy.testConnectionConfig}
            </button>
            <button className="sp-btn sp-btn-primary" onClick={() => void save()} disabled={saveState === "saving" || testState === "testing"} type="button">
              {saveState === "saving" ? copy.saveSaving : saveState === "saved" ? copy.saveSaved : copy.saveConnectionConfig}
            </button>
            {saveState === "saved" && <span className="st-save-info">{copy.saveConnectionSavedInfo}</span>}
          </div>
        </div>
      </div>
    </>
  );
}

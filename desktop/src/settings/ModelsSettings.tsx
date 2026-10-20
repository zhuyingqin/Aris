import type { NewApiAccount } from "../api/tauri";
import { isImageGenerationModel } from "../imageModels";
import SomniImageSettings from "./SomniImageSettings";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import PresetTextInput from "./PresetTextInput";
import type { SettingsConnectionState } from "./useSettingsConnectionState";
import { SettingRow, SettingsAdvanced, SettingsFeedback, SettingsSection } from "./SettingsPrimitives";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import "./ModelsSettings.css";
import { uniqueModelList } from "./settingsProviderCatalog";
import { useModelPricing } from "../useModelPricing";
import { modelPriceView, modelPricingSummary } from "../modelPricing";
import "../modelPricing.css";

interface Props {
  language: Language;
  configView: ConfigView;
  account: NewApiAccount | null;
  managedModels: string[];
  connection: SettingsConnectionState;
}

export default function ModelsSettings({ language, configView, managedModels, connection }: Props) {
  const pricing = useModelPricing();
  const priceFor = (model: string) => modelPriceView(model, pricing, language);
  const localizedCopy = SETTINGS_COPY[language];
  const copy = { ...localizedCopy.general, ...localizedCopy.providers };
  const {
    advForm, setAdvForm,
    modelAutoSave,
    managedModelsLoading, managedModelsError,
    applyManagedModel, applyManagedReviewerModel, applyReviewMode, loadManagedModels,
  } = connection;

  const summaryModelOptions = [
    { label: copy.summaryAutoLabel, value: "" },
    { label: copy.summaryOffLabel, value: "off" },
    ...uniqueModelList(managedModels, configView.managedModels ?? [])
      .filter((model) => !isImageGenerationModel(model))
      .map((model) => ({ label: model, value: model })),
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
  const executorPrice = priceFor(currentManagedModel);
  const reviewerPrice = currentReviewerModel ? priceFor(currentReviewerModel) : null;
  const priceBadge = (price: ReturnType<typeof priceFor>) => price && <span className={`model-price-badge settings-model-price is-${price.kind}`} title={price.title}>{price.label}</span>;
  const priceOptions = availableManagedModels.map((model) => {
    const price = priceFor(model);
    return <option key={model} value={model} title={price?.title}>{model}{price ? ` · ${price.label}` : ""}</option>;
  });
  // An absent or unrecognised mode is the backend's default, the resident Reviewer.
  const reviewMode = configView.reviewMode === "oneshot" ? "oneshot" : "thread";
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
        <SettingRow title={<>{copy.executorModel}{priceBadge(executorPrice)}</>} description={executorTransport ? executorTransport === "responses" ? copy.transportResponses : copy.transportChat : undefined}>
          {availableManagedModels.length > 0 ? (
            <select
              aria-label={copy.executorModel}
              title={[executorTransport ? copy.transportHint : "", executorPrice?.title].filter(Boolean).join("\n") || undefined}
              value={configView.executorModel ?? ""}
              onChange={(event) => void applyManagedModel(event.target.value)}
              className="sp-settings-select sp-model-price-select"
            >
              {priceOptions}
            </select>
          ) : (
            <span className="sp-model-select-empty">{copy.modelSyncAfterLogin}</span>
          )}
        </SettingRow>
        <SettingRow title={<>{copy.reviewerModel}{priceBadge(reviewerPrice)}</>}>
          {availableManagedModels.length > 0 ? (
            <select
              aria-label={copy.reviewerModel}
              title={reviewerPrice?.title}
              value={currentReviewerModel}
              onChange={(event) => void applyManagedReviewerModel(event.target.value)}
              className="sp-settings-select sp-model-price-select"
            >
              <option value="">{copy.reviewerModelOff}</option>
              {priceOptions}
            </select>
          ) : (
            <span className="sp-model-select-empty">{copy.modelSyncAfterLogin}</span>
          )}
        </SettingRow>
        <SettingRow title={copy.reviewMode} description={reviewMode === "oneshot" ? copy.reviewModeOneshotHint : copy.reviewModeThreadHint}>
          <select
            aria-label={copy.reviewMode}
            value={reviewMode}
            onChange={(event) => void applyReviewMode(event.target.value === "oneshot" ? "oneshot" : "thread")}
            className="sp-settings-select"
          >
            <option value="thread">{copy.reviewModeThread}</option>
            <option value="oneshot">{copy.reviewModeOneshot}</option>
          </select>
        </SettingRow>
        <div className="settings-model-status">
          {pricing && <p className="settings-model-price-basis">{modelPricingSummary(pricing, language)}</p>}
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
          <SettingRow title={copy.summaryModel} description={copy.summaryModelHint}>
            <PresetTextInput
              label={copy.summaryModel}
              value={advForm.summarizerModel ?? ""}
              placeholder={copy.automaticPlaceholder}
              options={summaryModelOptions}
              onChange={(value) => setAdvForm((current) => ({ ...current, summarizerModel: value }))}
            />
          </SettingRow>
          <SettingRow title={copy.retrievalCardModel} description={copy.retrievalCardModelHint}>
            <PresetTextInput
              label={copy.retrievalCardModel}
              value={advForm.retrievalCardModel ?? ""}
              placeholder={copy.retrievalCardFollowExecutor}
              options={retrievalCardModelOptions}
              onChange={(value) => setAdvForm((current) => ({ ...current, retrievalCardModel: value }))}
            />
          </SettingRow>
        </SettingsSection>

        {/* Section 2: Literature APIs */}
        <SettingsSection title={copy.sectionLiteratureServices}>
          <SettingRow title="Scopus" description={copy.scopusSchoolRouteHint} children={null} />
          <SettingRow title="OpenAlex" description={copy.openalexGatewayHint} children={null} />
        </SettingsSection>

        {/* Section 3: Web Search & Community */}
        <SettingsSection title={copy.sectionWebSearchServices} description={copy.sectionWebSearchServicesSub}>
          <SettingRow title={copy.fieldWebProxyUrl} description={copy.webProxyHint}>
            <input
              aria-label={copy.fieldWebProxyUrl}
              value={advForm.webProxyUrl ?? ""}
              placeholder={copy.webProxyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setAdvForm((current) => ({ ...current, webProxyUrl: event.target.value }));
              }}
            />
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

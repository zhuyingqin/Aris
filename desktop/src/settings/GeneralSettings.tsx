import { useState, type Dispatch, type SetStateAction } from "react";
import { configSet, isTauri, systemPromptView, userPromptView } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import { useStore, type Language } from "../store";
import type { ConfigPatch, ConfigView, SystemPromptView, UserPromptView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { formatUsageDate, formatUsageExact, normalizeLanguage } from "./settingsFormatters";
import { configuredServerLabel } from "./settingsProviderCatalog";

type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  language: Language;
  configView: ConfigView;
  advForm: ConfigPatch;
  setAdvForm: Dispatch<SetStateAction<ConfigPatch>>;
  saveState?: SaveState;
  save?: () => Promise<void>;
  resetOpState: () => void;
  previewSystemPrompt: SystemPromptView;
  previewUserPrompt: UserPromptView;
}

export default function GeneralSettings({
  language,
  configView,
  advForm,
  setAdvForm,
  resetOpState,
  previewSystemPrompt,
  previewUserPrompt,
}: Props) {
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const setLanguage = useStore((state) => state.setLanguage);
  const hideMail = useStore((state) => state.hideMail);
  const setHideMail = useStore((state) => state.setHideMail);
  const hideWorkflows = useStore((state) => state.hideWorkflows);
  const setHideWorkflows = useStore((state) => state.setHideWorkflows);
  const setError = useStore((state) => state.setError);
  const copy = { ...SETTINGS_COPY[language].general, ...SETTINGS_COPY[language].providers };

  const [systemPrompt, setSystemPrompt] = useState<SystemPromptView | null>(() => isTauri() ? null : previewSystemPrompt);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const [systemPromptError, setSystemPromptError] = useState("");
  const [userPrompt, setUserPrompt] = useState<UserPromptView | null>(() => isTauri() ? null : previewUserPrompt);
  const [userPromptOpen, setUserPromptOpen] = useState(false);
  const [userPromptLoading, setUserPromptLoading] = useState(false);
  const [userPromptError, setUserPromptError] = useState("");

  const loadSystemPrompt = async () => {
    if (!isTauri()) {
      setSystemPrompt(previewSystemPrompt);
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
      setUserPrompt(previewUserPrompt);
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

  const currentConfiguredModel = configView.executorModel?.trim() || copy.currentModelFallback;
  const currentServerLabel = configuredServerLabel(configView, language);

  return (
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

      <div className="sp-update-section sp-general-appearance">
        <div className="sp-section-head sp-general-preference-row">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.appearanceTitle}</div>
            <div className="sp-section-sub">{copy.appearanceSub}</div>
          </div>
          <div className="sp-theme-toggle" role="radiogroup" aria-label={copy.themeLabel}>
            {([
              { value: "light", label: copy.light, icon: "sun" as const },
              { value: "dark", label: copy.dark, icon: "moon" as const },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={theme === option.value}
                className={`sp-theme-option${theme === option.value ? " active" : ""}`}
                onClick={() => setTheme(option.value)}
              >
                <SvgIcon name={option.icon} size={14} className="sp-theme-icon" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="sp-update-section sp-general-language">
        <div className="sp-section-head sp-general-preference-row">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.languageTitle}</div>
            <div className="sp-section-sub">{copy.languageSub}</div>
          </div>
          <div className="sp-theme-toggle" role="radiogroup" aria-label={copy.languageTitle}>
            {[
              { value: "cn" as const, label: "简体中文" },
              { value: "en" as const, label: "English" },
            ].map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={language === item.value}
                className={`sp-theme-option${language === item.value ? " active" : ""}`}
                onClick={() => {
                  resetOpState();
                  const next = normalizeLanguage(item.value);
                  setLanguage(next);
                  setAdvForm((current) => ({ ...current, language: next }));
                }}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="sp-update-section sp-general-behavior">
        <div className="sp-section-head sp-general-preference-row">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.localBehaviorTitle}</div>
            <div className="sp-section-sub">{copy.localBehaviorSub}</div>
          </div>
          <div className="sp-theme-toggle" role="radiogroup" aria-label={copy.localBehaviorTitle}>
            <button
              type="button"
              role="radio"
              aria-checked={!advForm.memoryWriteApproval}
              className={`sp-theme-option${!advForm.memoryWriteApproval ? " active" : ""}`}
              onClick={() => {
                resetOpState();
                setAdvForm((current) => ({ ...current, memoryWriteApproval: false }));
                if (isTauri()) void configSet({ memoryWriteApproval: false });
              }}
            >
              <span>{copy.autoWrite}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={Boolean(advForm.memoryWriteApproval)}
              className={`sp-theme-option${advForm.memoryWriteApproval ? " active" : ""}`}
              onClick={() => {
                resetOpState();
                setAdvForm((current) => ({ ...current, memoryWriteApproval: true }));
                if (isTauri()) void configSet({ memoryWriteApproval: true });
              }}
            >
              <span>{copy.confirmBeforeWrite}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="sp-update-section sp-general-modules">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.modulesVisibilityTitle}</div>
            <div className="sp-section-sub">{copy.modulesVisibilitySub}</div>
          </div>
        </div>
        <div className="sp-modules-visibility-grid">
          <div className="sp-module-toggle-item">
            <div className="sp-module-toggle-info">
              <span className="sp-module-icon">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="2.2" y="4" width="11.6" height="8" rx="1.2" />
                  <path d="M2.6 4.6 8 8.6l5.4-4" />
                </svg>
              </span>
              <div>
                <div className="sp-module-name">{copy.moduleMailTitle}</div>
                <div className="sp-module-desc">{copy.moduleMailSub}</div>
              </div>
            </div>
            <div className="sp-theme-toggle sp-module-segmented" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={!hideMail}
                className={`sp-theme-option${!hideMail ? " active" : ""}`}
                onClick={() => setHideMail(false)}
              >
                <span>{copy.moduleShow}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={hideMail}
                className={`sp-theme-option${hideMail ? " active" : ""}`}
                onClick={() => setHideMail(true)}
              >
                <span>{copy.moduleHide}</span>
              </button>
            </div>
          </div>
          <div className="sp-module-toggle-item">
            <div className="sp-module-toggle-info">
              <span className="sp-module-icon">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="3" y="3.2" width="3.2" height="3.2" />
                  <rect x="9.8" y="9.6" width="3.2" height="3.2" />
                  <path d="M6.2 4.8h2.1a2 2 0 012 2v2.8M4.6 6.4v3.2a2 2 0 002 2h3.2" />
                </svg>
              </span>
              <div>
                <div className="sp-module-name">{copy.moduleWorkflowsTitle}</div>
                <div className="sp-module-desc">{copy.moduleWorkflowsSub}</div>
              </div>
            </div>
            <div className="sp-theme-toggle sp-module-segmented" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={!hideWorkflows}
                className={`sp-theme-option${!hideWorkflows ? " active" : ""}`}
                onClick={() => setHideWorkflows(false)}
              >
                <span>{copy.moduleShow}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={hideWorkflows}
                className={`sp-theme-option${hideWorkflows ? " active" : ""}`}
                onClick={() => setHideWorkflows(true)}
              >
                <span>{copy.moduleHide}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="sp-update-section sp-general-prompt-section">
        <button
          type="button"
          className={`sp-system-prompt-toggle${systemPromptOpen ? " open" : ""}`}
          onClick={() => {
            const nextOpen = !systemPromptOpen;
            setSystemPromptOpen(nextOpen);
            if (nextOpen && !systemPrompt) void loadSystemPrompt();
          }}
        >
          <span className="sp-section-head-text">
            <span className="sp-section-title">{copy.systemPromptTitle}</span>
            <span className="sp-section-sub">{copy.systemPromptSub}</span>
          </span>
          <span className="sp-prompt-toggle-badge">
            <span className="sp-system-prompt-toggle-state">{systemPromptOpen ? copy.promptHide : copy.promptView}</span>
            <span className={`sp-prompt-chevron${systemPromptOpen ? " open" : ""}`}>
              <SvgIcon name="chevronDown" size={14} />
            </span>
          </span>
        </button>
        {systemPromptOpen && (
          <div className="sp-system-prompt-panel">
            <div className="sp-system-prompt-toolbar">
              <div className="sp-system-prompt-meta">
                <span className="sp-meta-chip">{copy.promptModel}: {systemPrompt?.model ?? (advForm.executorModel || copy.promptUnknown)}</span>
                <span className="sp-meta-chip">{copy.promptSections(systemPrompt?.sections ?? 0)}</span>
                <span className="sp-meta-chip">{copy.promptChars(formatUsageExact(systemPrompt?.characters ?? 0))}</span>
                <span className="sp-meta-chip">{systemPrompt?.fullToolRegistry ? copy.promptFullTools : copy.promptLimitedTools}</span>
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
          className={`sp-system-prompt-toggle${userPromptOpen ? " open" : ""}`}
          onClick={() => {
            const nextOpen = !userPromptOpen;
            setUserPromptOpen(nextOpen);
            if (nextOpen && !userPrompt) void loadUserPrompt();
          }}
        >
          <span className="sp-section-head-text">
            <span className="sp-section-title">{copy.userPromptTitle}</span>
            <span className="sp-section-sub">{copy.userPromptSub}</span>
          </span>
          <span className="sp-prompt-toggle-badge">
            <span className="sp-system-prompt-toggle-state">{userPromptOpen ? copy.promptHide : copy.promptView}</span>
            <span className={`sp-prompt-chevron${userPromptOpen ? " open" : ""}`}>
              <SvgIcon name="chevronDown" size={14} />
            </span>
          </span>
        </button>
        {userPromptOpen && (
          <div className="sp-system-prompt-panel">
            <div className="sp-system-prompt-toolbar">
              <div className="sp-system-prompt-meta">
                <span className="sp-meta-chip">{copy.userPromptSource}: {userPrompt?.surface ?? copy.userPromptNoSource}</span>
                <span className="sp-meta-chip">{userPrompt ? formatUsageDate(userPrompt.capturedAt) : copy.userPromptNotCaptured}</span>
                <span className="sp-meta-chip">{copy.userPromptBlocks(userPrompt?.blocks ?? 0)}</span>
                <span className="sp-meta-chip">{copy.userPromptImages(userPrompt?.images ?? 0)}</span>
                <span className="sp-meta-chip">{copy.promptChars(formatUsageExact(userPrompt?.characters ?? 0))}</span>
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
  );
}

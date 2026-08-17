import { useState, type Dispatch, type SetStateAction } from "react";
import { isTauri, systemPromptView, userPromptView } from "../api/tauri";
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
  saveState: SaveState;
  save: () => Promise<void>;
  resetOpState: () => void;
  previewSystemPrompt: SystemPromptView;
  previewUserPrompt: UserPromptView;
}

export default function GeneralSettings({
  language,
  configView,
  advForm,
  setAdvForm,
  saveState,
  save,
  resetOpState,
  previewSystemPrompt,
  previewUserPrompt,
}: Props) {
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const setLanguage = useStore((state) => state.setLanguage);
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
              {/* Endonyms on purpose, not i18n keys: a language option has to
                  stay readable to someone who can't read the current UI
                  language, and it must not relabel itself mid-switch. */}
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
            <button className="sp-btn sp-btn-primary" onClick={() => void save()} disabled={saveState === "saving"} type="button">
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
            <button className="sp-btn sp-btn-primary" onClick={() => void save()} disabled={saveState === "saving"} type="button">
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
  );
}

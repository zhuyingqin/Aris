import { useState } from "react";
import {
  isTauri,
  systemPromptView,
  userPromptView,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import { useStore, type Language } from "../store";
import type { ConfigPatch, ConfigView, SystemPromptView, UserPromptView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { formatUsageDate, formatUsageExact } from "./settingsFormatters";
import TypographySettings, { TypographyPreview } from "./TypographySettings";
import { PreferenceFeedback, SettingsChoice, SettingsFeedback, SettingsSection, SettingRow } from "./SettingsPrimitives";
import type { PreferenceSave } from "./usePreferenceSave";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import { UI_COLOR_PRESETS } from "../uiColors";
import "./GeneralSettings.css";
import ScreenshotShortcutSettings from "./ScreenshotShortcutSettings";
import AppearanceSettings from "./AppearanceSettings";
import { useAppearance } from "../appearance";
import { selectAccentPreset } from "../appearanceTransfer";

type SaveState = "idle" | "saving" | "saved" | "error";

function ThemePreview({ theme }: { theme: "light" | "dark" }) {
  return <span className="settings-theme-preview" data-mode={theme} aria-hidden="true">
    <span className="settings-theme-sidebar"><i /><i /><i /></span>
    <span className="settings-theme-canvas"><i /><i /><span /><b /></span>
  </span>;
}

interface Props {
  language: Language;
  configView: ConfigView;
  advForm: ConfigPatch;
  preferences: PreferenceSave;
  saveLanguage: (value: Language) => Promise<void>;
  memorySaveState: SaveState;
  memorySaveError: string;
  saveMemoryWriteApproval: (value: boolean) => Promise<void>;
  retryMemoryWriteApproval: () => Promise<void>;
  previewSystemPrompt: SystemPromptView;
  previewUserPrompt: UserPromptView;
}

export default function GeneralSettings({
  language,
  configView,
  advForm,
  preferences, saveLanguage,
  memorySaveState, memorySaveError, saveMemoryWriteApproval, retryMemoryWriteApproval,
  previewSystemPrompt,
  previewUserPrompt,
}: Props) {
  const theme = useStore((state) => state.themeMode);
  const setTheme = useStore((state) => state.setTheme);
  const uiColor = useStore((state) => state.uiColor);
  const customAccent = useAppearance((state) => state.value.customAccent);
  const patchAppearance = useAppearance((state) => state.patch);
  const hideMail = useStore((state) => state.hideMail);
  const setHideMail = useStore((state) => state.setHideMail);
  const hideWorkflows = useStore((state) => state.hideWorkflows);
  const setHideWorkflows = useStore((state) => state.setHideWorkflows);
  const setError = useStore((state) => state.setError);
  const copy = { ...SETTINGS_COPY[language].general, ...SETTINGS_COPY[language].providers };

  const pageCopy = GENERAL_PAGE_COPY[language];

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

  const memoryApproval = Boolean(configView.memoryWriteApproval);
  const feedback = (preference: string) => <PreferenceFeedback preferences={preferences} preference={preference} language={language} />;

  return (
    <div className="sp-general-page settings-general">
      <SettingsSection title={pageCopy.appearance}>
        <SettingRow title={pageCopy.mode} feedback={feedback("theme")}>
          <SettingsChoice label={copy.themeLabel} value={theme} variant="preview"
            onChange={(value) => void preferences.save("theme", () => setTheme(value, { requirePersistence: true }))} options={[
            { value: "light", label: copy.light, icon: <ThemePreview theme="light" /> },
            { value: "dark", label: copy.dark, icon: <ThemePreview theme="dark" /> },
            { value: "system", label: language === "cn" ? "跟随系统" : "System", icon: <span className="appearance-system-preview"><SvgIcon name="desktop" size={28} /></span> },
          ]} />
        </SettingRow>
        <SettingRow title={pageCopy.color} feedback={feedback("color")}>
          <SettingsChoice label={pageCopy.color} value={customAccent ? "custom" : uiColor} variant="swatch"
            onChange={(value) => void preferences.save("color", () => value === "custom" ? patchAppearance({ customAccent: "#7c3aed" }) : selectAccentPreset(value))}
            options={[...UI_COLOR_PRESETS.map((value) => ({ value, label: pageCopy.colors[value],
              icon: <span className="settings-color-swatch" data-color={value} aria-hidden="true" />,
            })), { value: "custom", label: language === "cn" ? "自定义" : "Custom", icon: <span className="appearance-rainbow" aria-hidden="true" /> }]} />
        </SettingRow>
        <AppearanceSettings language={language} preferences={preferences} section="basic" />
        <SettingRow title={copy.languageTitle} description={pageCopy.languageDescription} feedback={feedback("language")}>
          <SettingsChoice label={copy.languageTitle} value={language}
            disabled={preferences.feedback.language?.state === "saving"} options={[
            { value: "cn", label: "简体中文" }, { value: "en", label: "English" },
          ]} onChange={(value) => void preferences.save("language", () => saveLanguage(value))} />
        </SettingRow>
        <TypographySettings language={language} preferences={preferences} />
      </SettingsSection>

      <AppearanceSettings language={language} preferences={preferences} section="chat" />
      <SettingsSection title={pageCopy.workspace}>
        <SettingRow title={pageCopy.mail} feedback={feedback("mail")}>
          <button type="button" className="settings-switch" role="switch" aria-label={copy.moduleMailTitle}
            aria-checked={!hideMail} onClick={() => void preferences.save("mail", () => setHideMail(!hideMail, { requirePersistence: true }))}><span /></button>
        </SettingRow>
        <SettingRow title={pageCopy.workflows} feedback={feedback("workflows")}>
          <button type="button" className="settings-switch" role="switch" aria-label={copy.moduleWorkflowsTitle}
            aria-checked={!hideWorkflows} onClick={() => void preferences.save("workflows", () => setHideWorkflows(!hideWorkflows, { requirePersistence: true }))}><span /></button>
        </SettingRow>
        <ScreenshotShortcutSettings language={language} />
        <SettingRow title={copy.localBehaviorTitle} description={pageCopy.memoryDescription}>
          <SettingsChoice label={copy.localBehaviorTitle} value={memoryApproval ? "confirm" : "auto"}
            disabled={memorySaveState === "saving"} options={[
              { value: "auto", label: copy.autoWrite }, { value: "confirm", label: copy.confirmBeforeWrite },
            ]} onChange={(value) => void saveMemoryWriteApproval(value === "confirm")} />
        </SettingRow>
        <SettingsFeedback state={memorySaveState}
          message={memorySaveState === "error" ? `${pageCopy.saveFailed} ${memorySaveError}` : memorySaveState === "saving" ? pageCopy.saving : pageCopy.saved}
          retryLabel={pageCopy.retry} onRetry={() => void retryMemoryWriteApproval()} />
      </SettingsSection>

      <details className="settings-advanced">
        <summary><span>{pageCopy.advanced}</span><SvgIcon name="chevronDown" size={14} /></summary>
        <div className="settings-advanced-body">
      <AppearanceSettings language={language} preferences={preferences} section="advanced" />
      <TypographyPreview language={language} />
      <div className="sp-update-section sp-general-prompt-section">
        <button
          type="button"
          aria-expanded={systemPromptOpen}
          aria-controls="settings-system-prompt"
          className={`sp-system-prompt-toggle${systemPromptOpen ? " open" : ""}`}
          onClick={() => {
            const nextOpen = !systemPromptOpen;
            setSystemPromptOpen(nextOpen);
            if (nextOpen && !systemPrompt) void loadSystemPrompt();
          }}
        >
          <span className="sp-section-head-text">
            <span className="sp-section-title">{copy.systemPromptTitle}</span>
          </span>
          <span className="sp-prompt-toggle-badge">
            <span className="sp-system-prompt-toggle-state">{systemPromptOpen ? copy.promptHide : copy.promptView}</span>
            <span className={`sp-prompt-chevron${systemPromptOpen ? " open" : ""}`}>
              <SvgIcon name="chevronDown" size={14} />
            </span>
          </span>
        </button>
        {systemPromptOpen && (
          <div id="settings-system-prompt" className="sp-system-prompt-panel">
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
          aria-expanded={userPromptOpen}
          aria-controls="settings-user-prompt"
          className={`sp-system-prompt-toggle${userPromptOpen ? " open" : ""}`}
          onClick={() => {
            const nextOpen = !userPromptOpen;
            setUserPromptOpen(nextOpen);
            if (nextOpen && !userPrompt) void loadUserPrompt();
          }}
        >
          <span className="sp-section-head-text">
            <span className="sp-section-title">{copy.userPromptTitle}</span>
          </span>
          <span className="sp-prompt-toggle-badge">
            <span className="sp-system-prompt-toggle-state">{userPromptOpen ? copy.promptHide : copy.promptView}</span>
            <span className={`sp-prompt-chevron${userPromptOpen ? " open" : ""}`}>
              <SvgIcon name="chevronDown" size={14} />
            </span>
          </span>
        </button>
        {userPromptOpen && (
          <div id="settings-user-prompt" className="sp-system-prompt-panel">
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
      </details>
    </div>
  );
}

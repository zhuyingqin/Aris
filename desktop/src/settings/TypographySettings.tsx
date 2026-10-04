import { useStore, type Language } from "../store";
import { UI_FONT_MAX, UI_FONT_MIN } from "../uiTypography";
import { SETTINGS_COPY } from "./i18n";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import { PreferenceFeedback, SettingRow } from "./SettingsPrimitives";
import type { PreferenceSave } from "./usePreferenceSave";

export default function TypographySettings({ language, preferences }: { language: Language; preferences: PreferenceSave }) {
  const mode = useStore((state) => state.uiFontMode);
  const customSize = useStore((state) => state.uiFontSize);
  const recommended = useStore((state) => state.uiRecommendedFontSize);
  const setMode = useStore((state) => state.setUiFontMode);
  const setSize = useStore((state) => state.setUiFontSize);
  const copy = SETTINGS_COPY[language].general;
  const pageCopy = GENERAL_PAGE_COPY[language];
  const size = mode === "auto" ? recommended : customSize;

  return (
    <SettingRow title={pageCopy.fontSize}
      feedback={<PreferenceFeedback preferences={preferences} preference="typography" language={language} />}>
      <div className="settings-font-controls">
        <select aria-label={copy.fontSizeModeLabel} value={mode}
          onChange={(event) => {
            const next = event.currentTarget.value === "auto" ? "auto" : "manual";
            void preferences.save("typography", () => setMode(next, { requirePersistence: true }));
          }}>
          <option value="auto">{copy.fontSizeAuto}</option>
          <option value="manual">{copy.fontSizeManual}</option>
        </select>
        <div className="settings-font-slider">
          <input id="ui-font-size" type="range" min={UI_FONT_MIN} max={UI_FONT_MAX} step={1}
            value={size} disabled={mode === "auto"} aria-label={copy.fontSizeLabel}
            aria-valuetext={copy.fontSizeCurrent(size)}
            title={mode === "auto" ? copy.fontSizeAutoHint : copy.fontSizeManualHint}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              void preferences.save("typography", () => setSize(value, { requirePersistence: true }));
            }} />
          <output htmlFor="ui-font-size" aria-label={copy.fontSizeCurrent(size)}>{size} px</output>
        </div>
      </div>
    </SettingRow>
  );
}

export function TypographyPreview({ language }: { language: Language }) {
  const copy = SETTINGS_COPY[language].general;
  const pageCopy = GENERAL_PAGE_COPY[language];
  return <div className="settings-text-preview" role="group" aria-label={copy.fontSizePreviewTitle}>
    <div className="settings-row-title">{copy.fontSizePreviewTitle}</div>
    <strong>{copy.fontSizePreviewHeading}</strong>
    <p>{copy.fontSizePreviewBody}</p>
    <small>{pageCopy.fontDescription}</small>
  </div>;
}

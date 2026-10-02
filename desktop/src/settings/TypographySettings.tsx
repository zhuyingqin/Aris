import { useStore, type Language } from "../store";
import { UI_FONT_MAX, UI_FONT_MIN } from "../uiTypography";
import { SETTINGS_COPY } from "./i18n";

export default function TypographySettings({ language }: { language: Language }) {
  const mode = useStore((state) => state.uiFontMode);
  const customSize = useStore((state) => state.uiFontSize);
  const recommended = useStore((state) => state.uiRecommendedFontSize);
  const setMode = useStore((state) => state.setUiFontMode);
  const setSize = useStore((state) => state.setUiFontSize);
  const copy = SETTINGS_COPY[language].general;
  const size = mode === "auto" ? recommended : customSize;

  return (
    <div className="sp-general-typography">
      <div className="sp-section-head sp-general-preference-row">
        <div className="sp-section-head-text">
          <label className="sp-section-title" htmlFor="ui-font-size">{copy.fontSizeLabel}</label>
          <div id="ui-font-size-description" className="sp-section-sub">{copy.fontSizeDescription}</div>
        </div>
        <div className="sp-theme-toggle" role="radiogroup" aria-label={copy.fontSizeModeLabel}>
          {([
            { value: "auto", label: copy.fontSizeAuto },
            { value: "manual", label: copy.fontSizeManual },
          ] as const).map((option) => (
            <button
              key={option.value}
              className={`sp-theme-option${mode === option.value ? " active" : ""}`}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              onClick={() => setMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sp-font-size-controls">
        <span className="sp-font-size-small" aria-hidden="true">A</span>
        <input
          id="ui-font-size"
          type="range"
          min={UI_FONT_MIN}
          max={UI_FONT_MAX}
          step={1}
          value={size}
          disabled={mode === "auto"}
          aria-valuetext={copy.fontSizeCurrent(size)}
          aria-describedby="ui-font-size-description ui-font-size-hint"
          onChange={(event) => setSize(Number(event.currentTarget.value))}
        />
        <span className="sp-font-size-large" aria-hidden="true">A</span>
        <output htmlFor="ui-font-size" className="sp-font-size-value" aria-label={copy.fontSizeCurrent(size)}>{size} px</output>
      </div>
      <div id="ui-font-size-hint" className="sp-font-size-hint">
        <span>{mode === "auto" ? copy.fontSizeAutoHint : copy.fontSizeManualHint}</span>
        <span className="sp-font-size-recommendation">{copy.fontSizeRecommended(recommended)}</span>
      </div>
      <div className="sp-font-size-preview" role="group" aria-label={copy.fontSizePreviewTitle}>
        <strong>{copy.fontSizePreviewHeading}</strong>
        <p>{copy.fontSizePreviewBody}</p>
        <small>{copy.fontSizePreviewMeta}</small>
      </div>
    </div>
  );
}

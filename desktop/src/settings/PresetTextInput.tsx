import { useStore } from "../store";
import { SETTINGS_COPY } from "./i18n";
import { isManagedModelServerUrl, type PresetOption } from "./settingsProviderCatalog";

export default function PresetTextInput({
  value,
  placeholder,
  options,
  onChange,
  disabled = false,
  formatValue,
}: {
  value: string;
  placeholder: string;
  options: PresetOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  formatValue?: (value: string) => string;
}) {
  const language = useStore((state) => state.language);
  const copy = SETTINGS_COPY[language].providers;
  const currentPreset = options.find((option) => option.value === value)?.value ?? "__custom";
  const inputValue = formatValue ? formatValue(value) : value;
  const displayOnlyValue = inputValue !== value;
  return (
    <div className="st-preset-control">
      <select
        value={currentPreset}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === "__custom") {
            onChange("");
            return;
          }
          onChange(event.target.value);
        }}
      >
        <option value="__custom">{copy.presetCustom}</option>
        {options.map((option) => {
          const optionLabel = isManagedModelServerUrl(option.value)
            ? copy.managedModelServerLabel
            : option.copyKey === "official"
              ? copy.presetOfficial
              : option.label;
          const optionHint = option.hint ?? (option.hintKey ? copy.presetHints[option.hintKey] : "");
          return (
            <option key={`${option.label}:${option.value || "blank"}`} value={option.value}>
              {optionLabel}{optionHint ? ` - ${optionHint}` : ""}
            </option>
          );
        })}
      </select>
      <input
        value={inputValue}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        disabled={disabled}
        readOnly={displayOnlyValue}
      />
    </div>
  );
}

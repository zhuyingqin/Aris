import { useEffect, useState } from "react";
import { configSecretGet } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type { Language } from "../store";
import type { ConfigSecretKind } from "../types";
import { SETTINGS_COPY } from "./i18n";

export default function KeyInput({
  label,
  value,
  placeholder,
  masked,
  secretKind,
  onChange,
  language,
  disabled = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  masked: string | null | undefined;
  secretKind: ConfigSecretKind;
  onChange: (value: string) => void;
  language: Language;
  disabled?: boolean;
}) {
  const keyCopy = SETTINGS_COPY[language].providers;
  const [visible, setVisible] = useState(false);
  const [savedSecret, setSavedSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const displayValue = value || savedSecret;

  useEffect(() => {
    setVisible(false);
    setSavedSecret("");
    setError("");
  }, [secretKind, masked]);

  const toggleVisible = async () => {
    setError("");
    if (visible) {
      setVisible(false);
      return;
    }
    if (!value && masked && !savedSecret) {
      setLoading(true);
      try {
        const secret = await configSecretGet(secretKind);
        if (secret) setSavedSecret(secret);
        else setError(keyCopy.keyNoSavedSecret);
      } catch (err) {
        setError(formatUserFacingError(err, language));
      } finally {
        setLoading(false);
      }
    }
    setVisible(true);
  };

  return (
    <div className="st-key-wrap" data-has-saved-secret={Boolean(masked)}>
      <input
        aria-label={label}
        type={visible ? "text" : "password"}
        value={displayValue}
        placeholder={placeholder}
        onChange={(event) => {
          if (savedSecret) setSavedSecret("");
          onChange(event.target.value);
        }}
        className="st-key-input"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="sp-btn sp-btn-secondary st-key-eye"
        onClick={() => void toggleVisible()}
        disabled={disabled || loading || (!value && !masked)}
        title={error || (visible ? keyCopy.keyHideSecret : keyCopy.keyShowSecret)}
        aria-label={`${visible ? keyCopy.keyHideSecret : keyCopy.keyShowSecret}: ${label}`}
      >
        {loading ? "..." : visible ? keyCopy.keyHide : keyCopy.keyShow}
      </button>
      {error && <span className="st-key-error" role="alert">{error}</span>}
    </div>
  );
}

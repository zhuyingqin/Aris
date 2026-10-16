import { useEffect, useState } from "react";
import { isTauri, screenshotShortcutSet, screenshotShortcutStatus, type ScreenshotShortcutStatus } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { isMacOS } from "../platform";
import type { Language } from "../store";
import { GENERAL_PAGE_COPY } from "./generalPageCopy";
import { SETTINGS_COPY } from "./i18n";
import { SettingRow, SettingsFeedback } from "./SettingsPrimitives";

function displayShortcut(value: string) {
  return value.replace("CmdOrCtrl", isMacOS() ? "⌘" : "Ctrl")
    .replace(/Key(?=[A-Z](?:\+|$))/g, "").replace(/Digit(?=\d)/g, "")
    .split("+").join(" + ");
}

export default function ScreenshotShortcutSettings({ language }: { language: Language }) {
  const copy = GENERAL_PAGE_COPY[language];
  const [status, setStatus] = useState<ScreenshotShortcutStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [pendingShortcut, setPendingShortcut] = useState("");
  const [loading, setLoading] = useState(isTauri());
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    setLoading(true);
    void screenshotShortcutStatus().then((value) => { if (!cancelled) setStatus(value); })
      .catch((reason) => {
        if (!cancelled) { setSaveState("error"); setError(formatUserFacingError(reason, language)); }
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [language]);

  const save = async (shortcut: string) => {
    setRecording(false);
    setPendingShortcut(shortcut);
    setSaveState("saving");
    setError("");
    try {
      setStatus(await screenshotShortcutSet(shortcut));
      setSaveState("saved");
    } catch (reason) {
      // Refresh actual registration state, including the rare rollback failure.
      try { setStatus(await screenshotShortcutStatus()); } catch { /* keep last known state */ }
      setError(formatUserFacingError(reason, language));
      setSaveState("error");
    }
  };

  return <SettingRow title={SETTINGS_COPY[language].general.screenshotTitle} feedback={<>
    <SettingsFeedback state={saveState} message={saveState === "error" ? error
      : saveState === "saving" ? copy.preferenceSaving : copy.preferenceSaved}
      retryLabel={copy.retry} onRetry={pendingShortcut ? () => void save(pendingShortcut) : undefined} />
    {saveState !== "error" && status && !status.registered &&
      <SettingsFeedback state="error" message={SETTINGS_COPY[language].general.screenshotUnavailable(status.error ?? "")} />}
  </>}>
    <button type="button" className="sp-btn sp-btn-secondary settings-shortcut-editor"
      aria-label={recording ? copy.shortcutRecording : copy.shortcutEdit}
      aria-pressed={recording} disabled={!isTauri() || loading || saveState === "saving"}
      title={isTauri() ? copy.shortcutHint : copy.shortcutDesktopOnly}
      onClick={() => { setRecording(!recording); setSaveState("idle"); setError(""); }}
      onBlur={() => setRecording(false)} onKeyDown={(event) => {
        if (!recording) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRecording(false); return; }
        if (event.key === "Tab") { setRecording(false); return; }
        event.preventDefault(); event.stopPropagation();
        if (event.repeat || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
        if (!(event.ctrlKey || event.metaKey || event.altKey) || !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete)$/.test(event.code)) {
          setError(copy.shortcutInvalid); setSaveState("error"); setPendingShortcut(""); return;
        }
        const keys = [event.ctrlKey && "Ctrl", event.metaKey && "Super", event.altKey && "Alt", event.shiftKey && "Shift", event.code].filter(Boolean);
        void save(keys.join("+"));
      }}>
      {recording ? copy.shortcutRecording : displayShortcut(status?.shortcut ?? "CmdOrCtrl+Shift+A")}
    </button>
  </SettingRow>;
}

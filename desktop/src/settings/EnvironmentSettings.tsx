import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { configSet, isTauri, localEnvironmentChecks } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { handoffEnvironmentInstall, isInstallableEnvironment } from "../environmentInstall";
import { SvgIcon } from "../SvgIcon";
import type { ConfigView, LocalEnvironmentCheck } from "../types";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";
import { formatUsageDate } from "./settingsFormatters";

// Category labels for these ids are resolved via `environmentCategoryLabel`,
// which already has a localized cn/en map; `label` below is only the
// language-agnostic fallback if an id isn't found there.
const ENVIRONMENT_CHECK_PLACEHOLDERS = [
  { id: "python", label: "Python" },
  { id: "jupyter", label: "Jupyter" },
  { id: "matlab", label: "MATLAB" },
  { id: "latex", label: "LaTeX" },
];

function EnvironmentIcon({ id }: { id: string }) {
  const icon = id === "python"
    ? "code"
    : id === "jupyter"
      ? "notebook"
      : id === "matlab"
        ? "graph"
        : "document";
  return <SvgIcon name={icon} size={19} />;
}

function environmentStatusLabel(item: LocalEnvironmentCheck, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  if (item.status === "ready") return copy.envStatusReady;
  if (item.status === "warning") return copy.envStatusWarning;
  return item.available ? copy.envStatusReady : copy.envStatusMissing;
}

function environmentCategoryLabel(id: string, language: Language, fallback: string): string {
  const categories = SETTINGS_COPY[language].general.envCategories;
  return categories[id as keyof typeof categories] ?? fallback;
}

function environmentMessage(item: LocalEnvironmentCheck, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  if (item.available && item.status === "warning") return copy.envExecutableWarning;
  if (item.available) return copy.envAvailable;
  if (isInstallableEnvironment(item.id)) return copy.envMissingInstallable(item.label);
  return copy.envMissing(item.label);
}

interface Props {
  language: Language;
  pythonEnvironmentPath: string;
  onConfigRefreshed: (view: ConfigView) => void;
}

export default function EnvironmentSettings({
  language,
  pythonEnvironmentPath: initialPythonEnvironmentPath,
  onConfigRefreshed,
}: Props) {
  const copy = SETTINGS_COPY[language].general;
  const [environmentChecks, setEnvironmentChecks] = useState<LocalEnvironmentCheck[]>([]);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentError, setEnvironmentError] = useState("");
  const [environmentCheckedAt, setEnvironmentCheckedAt] = useState<number | null>(null);
  const [pythonEnvironmentPath, setPythonEnvironmentPath] = useState(initialPythonEnvironmentPath);
  const [pythonEnvironmentSaving, setPythonEnvironmentSaving] = useState(false);
  const [pythonEnvironmentSaved, setPythonEnvironmentSaved] = useState(false);

  const loadEnvironmentChecks = async () => {
    setEnvironmentLoading(true);
    setEnvironmentError("");
    try {
      setEnvironmentChecks(await localEnvironmentChecks());
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      setEnvironmentLoading(false);
    }
  };

  useEffect(() => {
    void loadEnvironmentChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choosePythonEnvironment = async () => {
    if (!isTauri()) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: copy.pythonEnvironmentBrowseTitle,
      });
      if (typeof selected === "string") {
        setPythonEnvironmentPath(selected);
        setPythonEnvironmentSaved(false);
      }
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    }
  };

  // Updates configView only (not the shared executor/reviewer draft state
  // that the connection hook owns) — saving this path must not silently
  // wipe unsaved API-key edits on the Models tab.
  const savePythonEnvironment = async () => {
    setPythonEnvironmentSaving(true);
    setPythonEnvironmentSaved(false);
    setEnvironmentError("");
    try {
      if (!isTauri()) {
        setPythonEnvironmentSaved(true);
        return;
      }
      const next = await configSet({
        pythonEnvironmentPath: pythonEnvironmentPath.trim(),
      });
      onConfigRefreshed(next);
      setEnvironmentLoading(true);
      setEnvironmentChecks(await localEnvironmentChecks(true));
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
      setPythonEnvironmentSaved(true);
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      setEnvironmentLoading(false);
      setPythonEnvironmentSaving(false);
    }
  };

  const environmentReadyCount = environmentChecks.filter((item) => item.available).length;

  return (
    <div className="sp-update-section sp-env-section">
      <div className="sp-section-head sp-env-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{copy.envTitle}</div>
          <div className="sp-section-sub">
            {environmentLoading
              ? copy.envDetectingSub
              : environmentChecks.length > 0
              ? copy.envReadySummary(environmentReadyCount, environmentChecks.length, environmentCheckedAt ? formatUsageDate(environmentCheckedAt) : undefined)
              : copy.envSub}
          </div>
        </div>
        <div className="sp-update-actions">
          <button
            className="sp-btn sp-btn-secondary"
            onClick={() => { void localEnvironmentChecks(true).then(setEnvironmentChecks).then(() => setEnvironmentCheckedAt(Math.floor(Date.now() / 1000))).catch((e) => setEnvironmentError(formatUserFacingError(e, language))); }}
            disabled={environmentLoading}
            type="button"
          >
            <SvgIcon name={environmentLoading ? "spinner" : "refresh"} size={13} />
            {environmentLoading ? copy.envDetecting : copy.envRefresh}
          </button>
        </div>
      </div>
      <div className="sp-env-python-config">
        <div className="sp-env-python-copy">
          <strong>{copy.pythonEnvironmentTitle}</strong>
          <span>{copy.pythonEnvironmentHint}</span>
        </div>
        <div className="sp-env-python-control">
          <input
            className="sp-input"
            value={pythonEnvironmentPath}
            onChange={(event) => {
              setPythonEnvironmentPath(event.currentTarget.value);
              setPythonEnvironmentSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void savePythonEnvironment();
            }}
            placeholder={copy.pythonEnvironmentPlaceholder}
            aria-label={copy.pythonEnvironmentTitle}
          />
          <button
            className="sp-btn sp-btn-secondary"
            type="button"
            onClick={() => void choosePythonEnvironment()}
            disabled={pythonEnvironmentSaving}
          >
            {copy.pythonEnvironmentBrowse}
          </button>
          <button
            className="sp-btn sp-btn-primary"
            type="button"
            onClick={() => void savePythonEnvironment()}
            disabled={pythonEnvironmentSaving}
          >
            {pythonEnvironmentSaving
              ? copy.pythonEnvironmentSaving
              : pythonEnvironmentSaved
                ? copy.pythonEnvironmentSaved
                : copy.pythonEnvironmentUse}
          </button>
        </div>
      </div>
      {environmentError && <div className="sp-env-error">{environmentError}</div>}
      <div className="sp-env-grid">
        {environmentLoading ? (
          ENVIRONMENT_CHECK_PLACEHOLDERS.map((item) => (
            <div className="sp-env-card sp-env-card-loading" key={item.id}>
              <div className="sp-env-card-top">
                <span className="sp-env-mark"><EnvironmentIcon id={item.id} /></span>
                <div className="sp-env-title-block">
                  <div className="sp-env-title">{item.label}</div>
                  <div className="sp-env-category">{environmentCategoryLabel(item.id, language, item.label)}</div>
                </div>
                <span className="sp-env-badge sp-env-badge-loading">
                  <span className="sp-env-spinner" />
                  {copy.envDetecting}
                </span>
              </div>
              <div className="sp-env-loading-line" />
              <div className="sp-env-loading-line short" />
            </div>
          ))
        ) : environmentChecks.length === 0 ? (
          <div className="sp-env-empty">{copy.envEmpty}</div>
        ) : (
          environmentChecks.map((item) => (
            <div className={`sp-env-card sp-env-card-${item.status}`} key={item.id}>
              <div className="sp-env-card-top">
                <span className="sp-env-mark"><EnvironmentIcon id={item.id} /></span>
                <div className="sp-env-title-block">
                  <div className="sp-env-title">{item.label}</div>
                  <div className="sp-env-category">{environmentCategoryLabel(item.id, language, item.category)}</div>
                </div>
                <span className={`sp-env-badge sp-env-badge-${item.status}`}>{environmentStatusLabel(item, language)}</span>
              </div>
              <div className="sp-env-lines">
                <div><span>{copy.envVersion}</span><strong title={item.version ?? ""}>{item.version ?? copy.envUnknownVersion}</strong></div>
                <div><span>{copy.envPath}</span><strong title={item.path ?? ""}>{item.path ?? copy.envNotOnPath}</strong></div>
              </div>
              <div className="sp-env-message" title={item.detail ?? item.message}>{environmentMessage(item, language)}</div>
              {!item.available && isInstallableEnvironment(item.id) && (
                <div className="sp-env-card-actions">
                  <button
                    className="sp-env-install"
                    type="button"
                    onClick={() => {
                      if (isInstallableEnvironment(item.id)) handoffEnvironmentInstall(item.id, language);
                    }}
                  >
                    {copy.envInstallInChat}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

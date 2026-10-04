import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { configSet, isTauri, localEnvironmentChecks } from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { handoffEnvironmentInstall, isInstallableEnvironment } from "../environmentInstall";
import { SvgIcon } from "../SvgIcon";
import type { ConfigView, LocalEnvironmentCheck } from "../types";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";
import { formatUsageDate } from "./settingsFormatters";
import { SettingRow, SettingsFeedback, SettingsSection } from "./SettingsPrimitives";
import "./EnvironmentSettings.css";

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
  const [appliedPythonEnvironmentPath, setAppliedPythonEnvironmentPath] = useState(initialPythonEnvironmentPath);
  const [pythonEnvironmentSaving, setPythonEnvironmentSaving] = useState(false);
  const [pythonEnvironmentSaved, setPythonEnvironmentSaved] = useState(false);
  const checkingRef = useRef(false);
  const savingRef = useRef(false);
  const pythonEnvironmentChanged = pythonEnvironmentPath.trim() !== appliedPythonEnvironmentPath.trim();

  const loadEnvironmentChecks = async (forceRefresh = false) => {
    if (checkingRef.current || savingRef.current) return;
    checkingRef.current = true;
    setEnvironmentLoading(true);
    setEnvironmentError("");
    try {
      setEnvironmentChecks(await localEnvironmentChecks(forceRefresh));
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      checkingRef.current = false;
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
    if (savingRef.current || checkingRef.current || !pythonEnvironmentChanged) return;
    savingRef.current = true;
    const pathToApply = pythonEnvironmentPath.trim();
    setPythonEnvironmentSaving(true);
    setPythonEnvironmentSaved(false);
    setEnvironmentError("");
    try {
      if (!isTauri()) {
        setAppliedPythonEnvironmentPath(pathToApply);
        setPythonEnvironmentPath(pathToApply);
        setPythonEnvironmentSaved(true);
        return;
      }
      const next = await configSet({
        pythonEnvironmentPath: pathToApply,
      });
      onConfigRefreshed(next);
      setEnvironmentLoading(true);
      setEnvironmentChecks(await localEnvironmentChecks(true));
      setEnvironmentCheckedAt(Math.floor(Date.now() / 1000));
      setAppliedPythonEnvironmentPath(next.pythonEnvironmentPath ?? pathToApply);
      setPythonEnvironmentPath(next.pythonEnvironmentPath ?? pathToApply);
      setPythonEnvironmentSaved(true);
    } catch (error) {
      setEnvironmentError(formatUserFacingError(error, language));
    } finally {
      savingRef.current = false;
      setEnvironmentLoading(false);
      setPythonEnvironmentSaving(false);
    }
  };

  const environmentReadyCount = environmentChecks.filter((item) => item.available).length;
  const missingInstallableEnvironments = environmentChecks.filter((item) => !item.available && isInstallableEnvironment(item.id));

  return (
    <div className="settings-environment">
      <SettingsSection title={copy.envTitle} description={environmentLoading
                ? copy.envDetectingSub
                : environmentChecks.length > 0
                ? copy.envReadySummary(environmentReadyCount, environmentChecks.length, environmentCheckedAt ? formatUsageDate(environmentCheckedAt) : undefined)
                : copy.envSub} actions={
          <>
            <button
              className="sp-btn sp-btn-secondary"
              onClick={() => void loadEnvironmentChecks(true)}
              disabled={environmentLoading || pythonEnvironmentSaving}
              type="button"
            >
              <SvgIcon name={environmentLoading ? "spinner" : "refresh"} size={13} />
              {environmentLoading ? copy.envDetecting : copy.envRefresh}
            </button>
            {!environmentLoading && !pythonEnvironmentSaving && missingInstallableEnvironments.length > 0 && <details className="settings-environment-install"
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
              }}>
              <summary className="sp-btn sp-btn-secondary">{copy.envInstallInChat}<SvgIcon name="chevronDown" size={13} /></summary>
              <div className="settings-environment-install-menu" role="group" aria-label={copy.envInstallInChat}>
                {missingInstallableEnvironments.map((item) => <button type="button" key={item.id} onClick={() => {
                  if (isInstallableEnvironment(item.id)) handoffEnvironmentInstall(item.id, language);
                }}>{item.label}</button>)}
              </div>
            </details>}
          </>
        }>
        <SettingRow title={copy.pythonEnvironmentTitle} description={copy.pythonEnvironmentHint} feedback={
          (pythonEnvironmentSaving || pythonEnvironmentSaved) && <SettingsFeedback state={pythonEnvironmentSaving ? "saving" : "saved"}
            message={pythonEnvironmentSaving ? copy.pythonEnvironmentSaving : copy.pythonEnvironmentSaved} />
        }>
          <div className="settings-environment-path-control">
            <div className="settings-environment-path-input">
              <input
                className="sp-input"
                value={pythonEnvironmentPath}
                disabled={pythonEnvironmentSaving}
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
                disabled={pythonEnvironmentSaving || !isTauri()}
                aria-label={copy.pythonEnvironmentBrowse}
                title={copy.pythonEnvironmentBrowse}
              >
                <SvgIcon name="folder" size={15} />
              </button>
            </div>
            {(pythonEnvironmentChanged || pythonEnvironmentSaving) && <button
              className="sp-btn sp-btn-primary"
              type="button"
              onClick={() => void savePythonEnvironment()}
              disabled={pythonEnvironmentSaving || environmentLoading}
            >
              {pythonEnvironmentSaving
                ? copy.pythonEnvironmentSaving
                : copy.pythonEnvironmentUse}
            </button>}
          </div>
        </SettingRow>
        {environmentError && <SettingsFeedback state="error" message={environmentError} />}
        <div className="sp-env-grid" aria-busy={environmentLoading}>
          {environmentLoading && environmentChecks.length === 0 ? (
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
                <dl className="settings-environment-details">
                  <div><dt>{copy.envVersion}</dt><dd title={item.version ?? ""}>{item.version ?? copy.envUnknownVersion}</dd></div>
                  <div><dt>{copy.envPath}</dt><dd title={item.path ?? ""}>{item.path ?? copy.envNotOnPath}</dd></div>
                </dl>
                {(!item.available || item.status === "warning") && <div className="sp-env-message" title={item.detail ?? item.message}>{environmentMessage(item, language)}</div>}
              </div>
            ))
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

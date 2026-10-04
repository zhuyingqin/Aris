import { useState } from "react";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall } from "../api/tauri";
import type { Language } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import type { AppUpdateInfo, AppUpdateProgress } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { SettingsSection } from "./SettingsPrimitives";
import { SETTINGS_LAYOUT_COPY } from "./settingsLayoutCopy";
import { formatUpdateBytes } from "./settingsFormatters";
import "./UpdateSettings.css";

type UpdateState = "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "error";

export default function UpdateSettings({ language, appVersion }: { language: Language; appVersion: string }) {
  const copy = SETTINGS_COPY[language].general;
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");

  const checkForUpdates = async () => {
    setUpdateState("checking");
    setUpdateProgress(null);
    setUpdateMessage("");
    try {
      const result = await appUpdateCheck(language === "cn");
      setUpdateInfo(result);
      if (result.available) {
        setUpdateState("available");
        setUpdateMessage(copy.updateMsgNewVersion(result.version ?? ""));
      } else {
        setUpdateState("current");
        setUpdateMessage(copy.updateMsgUpToDate);
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const installUpdate = async () => {
    setUpdateState("downloading");
    setUpdateProgress(null);
    setUpdateMessage(copy.updateMsgDownloading);
    try {
      const result = await appUpdateDownloadAndInstall(language === "cn", (progress) => {
        setUpdateProgress(progress);
        if (progress.stage === "finished") setUpdateMessage(copy.updateMsgInstalled);
      });
      if (result.installed) {
        setUpdateState("ready");
        setUpdateInfo((current) => ({
          available: true,
          currentVersion: current?.currentVersion,
          version: result.version ?? current?.version,
          date: current?.date,
          body: current?.body,
        }));
        setUpdateMessage(copy.updateMsgInstalled);
      } else {
        setUpdateState("current");
        setUpdateMessage(copy.updateMsgNoUpdateToInstall);
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const restartForUpdate = async () => {
    try { await appRelaunch(); }
    catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const updateBusy = updateState === "checking" || updateState === "downloading";
  const updateProgressLabel = updateProgress
    ? updateProgress.contentLength
      ? `${formatUpdateBytes(updateProgress.downloadedBytes)} / ${formatUpdateBytes(updateProgress.contentLength)}${updateProgress.percent !== null && updateProgress.percent !== undefined ? ` - ${updateProgress.percent}%` : ""}`
      : copy.updateDownloaded(formatUpdateBytes(updateProgress.downloadedBytes))
    : "";
  const progressPercent = updateProgress?.percent;
  const updateTitle = updateState === "available" ? copy.aboutUpdateAvailable(updateInfo?.version ?? "")
    : updateState === "ready" ? copy.aboutUpdateReady(updateInfo?.version ?? "")
      : updateState === "downloading" ? copy.aboutInstalling
        : updateState === "checking" ? copy.aboutChecking
          : updateState === "current" ? copy.updateMsgUpToDate : "SomniQ Studio";
  // Available/current states already describe the result in the title.
  const showMessage = updateMessage && updateMessage !== updateTitle && updateState !== "available";

  return <div className="settings-updates">
    <SettingsSection title={SETTINGS_LAYOUT_COPY[language].update}>
      <div className={`settings-app-update is-${updateState}`}>
        <div className="settings-app-update-summary" aria-busy={updateBusy}>
          <span className="settings-app-update-dot" aria-hidden="true" />
          <div className="settings-app-update-copy">
            <div className="settings-app-update-title" role="status">{updateTitle}</div>
            <div className="settings-app-update-meta">
              <span>{copy.aboutCurrentVersion(appVersion)}</span>
              {updateInfo?.version && updateState !== "current" && <span>{copy.aboutRemoteVersion(updateInfo.version)}</span>}
              {updateInfo?.date && <span>{updateInfo.date}</span>}
            </div>
          </div>
        </div>
        <div className="settings-app-update-actions">
          <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
            <SvgIcon name={updateState === "checking" ? "spinner" : "refresh"} size={13} />
            {updateState === "checking" ? copy.aboutChecking : copy.aboutCheck}
          </button>
          {updateState === "available" && <button className="sp-btn sp-btn-primary" onClick={() => void installUpdate()} disabled={updateBusy} type="button">{copy.aboutDownloadInstall}</button>}
          {updateState === "ready" && <button className="sp-btn sp-btn-primary" onClick={() => void restartForUpdate()} type="button">{copy.aboutRestart}</button>}
        </div>
        {showMessage && <div className="settings-app-update-message" role={updateState === "error" ? "alert" : "status"}>{updateMessage}</div>}
        {updateState === "downloading" && updateProgress && <div className="settings-app-update-progress">
          <progress aria-label={copy.aboutInstalling} max={100} value={typeof progressPercent === "number" && Number.isFinite(progressPercent) ? Math.min(100, Math.max(0, progressPercent)) : undefined} />
          <span role="status">{updateProgressLabel}</span>
        </div>}
        {updateInfo?.body && updateState === "available" && <div className="settings-app-update-notes">{updateInfo.body}</div>}
      </div>
    </SettingsSection>
  </div>;
}

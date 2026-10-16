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
import OracleWebSettings from "./OracleWebSettings";

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

  return <>
    <SettingsSection title={SETTINGS_LAYOUT_COPY[language].update} actions={
      <div className="sp-update-actions">
        <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
          <SvgIcon name={updateState === "checking" ? "spinner" : "refresh"} size={13} />
          {updateState === "checking" ? copy.aboutChecking : copy.aboutCheck}
        </button>
        {updateState === "available" && <button className="sp-btn sp-btn-primary" onClick={() => void installUpdate()} disabled={updateBusy} type="button">{copy.aboutDownloadInstall}</button>}
        {updateState === "ready" && <button className="sp-btn sp-btn-primary" onClick={() => void restartForUpdate()} type="button">{copy.aboutRestart}</button>}
      </div>
    }>
      <div className={`sp-update-panel sp-update-panel-${updateState}`}>
        <div className="sp-update-main">
          <span className={`sp-update-dot sp-update-dot-${updateState}`} />
          <div className="sp-update-copy">
            <div className="sp-update-title">
              {updateState === "available" ? copy.aboutUpdateAvailable(updateInfo?.version ?? "")
                : updateState === "ready" ? copy.aboutUpdateReady(updateInfo?.version ?? "")
                  : updateState === "downloading" ? copy.aboutInstalling : copy.aboutConnected}
            </div>
            <div className="sp-update-meta">
              {copy.aboutCurrentVersion(appVersion)}
              {updateInfo?.version && updateState !== "current" ? ` -> ${copy.aboutRemoteVersion(updateInfo.version)}` : ""}
              {updateInfo?.date ? ` · ${updateInfo.date}` : ""}
            </div>
            {(updateMessage || updateProgressLabel) && <div className="sp-update-message" role={updateState === "error" ? "alert" : "status"}>
              {updateMessage}{updateProgressLabel ? ` · ${updateProgressLabel}` : ""}
            </div>}
            {updateInfo?.body && updateState === "available" && <div className="sp-update-notes">{updateInfo.body}</div>}
          </div>
        </div>
      </div>
    </SettingsSection>
    <OracleWebSettings language={language} runtimeOnly />
  </>;
}

import { useState } from "react";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall } from "../api/tauri";
import type { Language } from "../store";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon } from "../SvgIcon";
import EnvironmentSettings from "./EnvironmentSettings";
import type { AppUpdateInfo, AppUpdateProgress, ConfigView } from "../types";
import { SETTINGS_COPY } from "./i18n";
import { formatUpdateBytes } from "./settingsFormatters";

type UpdateState = "idle" | "checking" | "available" | "current" | "downloading" | "ready" | "error";

interface Props {
  language: Language;
  appVersion: string;
  pythonEnvironmentPath?: string;
  onConfigRefreshed?: (config: ConfigView) => void;
}

export default function AboutSettings({
  language,
  appVersion,
  pythonEnvironmentPath,
  onConfigRefreshed,
}: Props) {
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
      const result = await appUpdateCheck();
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
      const result = await appUpdateDownloadAndInstall((progress) => {
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
    try {
      await appRelaunch();
    } catch (error) {
      setUpdateState("error");
      setUpdateMessage(formatUserFacingError(error, language));
    }
  };

  const updateBusy = updateState === "checking" || updateState === "downloading";
  const updateCanInstall = updateState === "available";
  const updateCanRestart = updateState === "ready";
  const updateProgressLabel = updateProgress
    ? updateProgress.contentLength
      ? `${formatUpdateBytes(updateProgress.downloadedBytes)} / ${formatUpdateBytes(updateProgress.contentLength)}${updateProgress.percent !== null && updateProgress.percent !== undefined ? ` - ${updateProgress.percent}%` : ""}`
      : copy.updateDownloaded(formatUpdateBytes(updateProgress.downloadedBytes))
    : "";

  return (
    <>
      <div className="sp-update-section sp-about-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.aboutUpdateTitle}</div>
            <div className="sp-section-sub">{copy.aboutUpdateSub}</div>
          </div>
          <div className="sp-update-actions">
            <button className="sp-btn sp-btn-secondary" onClick={() => void checkForUpdates()} disabled={updateBusy} type="button">
              <SvgIcon name={updateState === "checking" ? "spinner" : "refresh"} size={13} />
              {updateState === "checking" ? copy.aboutChecking : copy.aboutCheck}
            </button>
            {updateCanInstall && <button className="sp-btn sp-btn-primary" onClick={() => void installUpdate()} disabled={updateBusy} type="button">{copy.aboutDownloadInstall}</button>}
            {updateCanRestart && <button className="sp-btn sp-btn-primary" onClick={() => void restartForUpdate()} type="button">{copy.aboutRestart}</button>}
          </div>
        </div>
        <div className={`sp-update-panel sp-update-panel-${updateState}`}>
          <div className="sp-update-main">
            <span className={`sp-update-dot sp-update-dot-${updateState}`} />
            <div className="sp-update-copy">
              <div className="sp-update-title">
                {updateState === "available"
                  ? copy.aboutUpdateAvailable(updateInfo?.version ?? "")
                  : updateState === "ready"
                    ? copy.aboutUpdateReady(updateInfo?.version ?? "")
                    : updateState === "downloading"
                      ? copy.aboutInstalling
                      : copy.aboutConnected}
              </div>
              <div className="sp-update-meta">
                {copy.aboutCurrentVersion(appVersion)}
                {updateInfo?.version && updateState !== "current" ? ` -> ${copy.aboutRemoteVersion(updateInfo.version)}` : ""}
                {updateInfo?.date ? ` · ${updateInfo.date}` : ""}
              </div>
              {(updateMessage || updateProgressLabel) && (
                <div className="sp-update-message">
                  {updateMessage}
                  {updateProgressLabel ? ` · ${updateProgressLabel}` : ""}
                </div>
              )}
              {updateInfo?.body && updateState === "available" && <div className="sp-update-notes">{updateInfo.body}</div>}
            </div>
          </div>
        </div>
        <div className="sp-about-links">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.aboutLinksTitle}</div>
            <div className="sp-section-sub">{copy.aboutLinksSub}</div>
          </div>
          <div className="sp-about-links-row">
            <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris" target="_blank" rel="noreferrer">
              <SvgIcon name="externalLink" size={13} />{copy.aboutLinkRepo}
            </a>
            <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/releases" target="_blank" rel="noreferrer">
              <SvgIcon name="externalLink" size={13} />{copy.aboutLinkReleases}
            </a>
            {/* HEAD, not a branch name: release branches move and a pinned one 404s. */}
            <a className="sp-about-link" href="https://github.com/zhuyingqin/Aris/blob/HEAD/LICENSE" target="_blank" rel="noreferrer">
              <SvgIcon name="externalLink" size={13} />{copy.aboutLinkLicense}
            </a>
          </div>
        </div>
      </div>

      <EnvironmentSettings
        language={language}
        pythonEnvironmentPath={pythonEnvironmentPath ?? ""}
        onConfigRefreshed={onConfigRefreshed ?? (() => {})}
      />
    </>
  );
}

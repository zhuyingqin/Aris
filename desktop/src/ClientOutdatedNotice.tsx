import { useState } from "react";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall, openExternalUrl } from "./api/tauri";
import { CLIENT_DOWNLOAD_URL } from "./clientOutdated";
import type { Language } from "./store";
import "./ClientOutdatedNotice.css";

/** The app shell's updater states (see `checkForAppUpdate` in App.tsx). */
export type ClientUpdateState = "idle" | "available" | "downloading" | "ready";

const COPY = {
  cn: {
    title: "当前版本已停止服务",
    body: "请更新 SomniQ Studio 后继续使用。",
    install: "立即更新",
    installing: "正在安装更新…",
    restart: "重启完成更新",
    download: "前往官网下载",
    dismiss: "关闭",
    update: "更新到最新版本",
    checking: "正在检查更新…",
  },
  en: {
    title: "This version is no longer supported",
    body: "Update SomniQ Studio to continue.",
    install: "Update now",
    installing: "Installing update…",
    restart: "Restart to finish",
    download: "Download from website",
    dismiss: "Dismiss",
    update: "Update to the latest version",
    checking: "Checking for updates…",
  },
} satisfies Record<Language, Record<string, string>>;

/** Shown once the gateway refused this release. The update action reuses the
 * shell's updater; without a found update it falls back to the website. */
export function ClientOutdatedNotice({
  language,
  updateState,
  onInstall,
  onDismiss,
}: {
  language: Language;
  updateState: ClientUpdateState;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const copy = COPY[language];
  const label = updateState === "ready"
    ? copy.restart
    : updateState === "downloading"
      ? copy.installing
      : updateState === "available"
        ? copy.install
        : copy.download;
  const act = () => {
    if (updateState === "idle") void openExternalUrl(CLIENT_DOWNLOAD_URL);
    else onInstall();
  };
  return (
    <div className="client-outdated-notice" role="alert" aria-live="assertive">
      <div className="client-outdated-text">
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
      </div>
      <button
        className="client-outdated-action"
        type="button"
        onClick={act}
        disabled={updateState === "downloading"}
      >
        {label}
      </button>
      <button className="client-outdated-dismiss" type="button" onClick={onDismiss} aria-label={copy.dismiss} title={copy.dismiss}>
        ×
      </button>
    </div>
  );
}

/** The login screen renders before the app shell and its updater, so it runs
 * the same check → install → restart sequence itself. Anything short of an
 * installed update falls back to the download page. */
export function LoginClientUpdateButton({ language, className }: { language: Language; className?: string }) {
  const copy = COPY[language];
  const [state, setState] = useState<"idle" | "checking" | "downloading" | "ready">("idle");
  const run = async () => {
    if (state === "ready") {
      await appRelaunch().catch(() => undefined);
      return;
    }
    const isChina = language === "cn";
    setState("checking");
    try {
      const update = await appUpdateCheck(isChina);
      if (update.available) {
        setState("downloading");
        const result = await appUpdateDownloadAndInstall(isChina);
        if (result.installed) {
          setState("ready");
          return;
        }
      }
    } catch {
      // Fall through to the website; the updater error is not actionable here.
    }
    setState("idle");
    await openExternalUrl(CLIENT_DOWNLOAD_URL).catch(() => undefined);
  };
  const label = state === "ready"
    ? copy.restart
    : state === "downloading"
      ? copy.installing
      : state === "checking"
        ? copy.checking
        : copy.update;
  return (
    <button
      type="button"
      className={className}
      onClick={() => void run()}
      disabled={state === "checking" || state === "downloading"}
    >
      {label}
    </button>
  );
}

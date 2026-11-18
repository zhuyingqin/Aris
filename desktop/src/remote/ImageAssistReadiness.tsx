import { useEffect, useState } from "react";
import { imageAssistPublish, oracleWebRuntimeInstall, oracleWebStatus } from "../api/tauri";
import type { Language } from "../store";
import type { OracleWebStatusView } from "../types";
import { storedImageAssistLocation } from "./imageAssistLocation";

const COPY = {
  cn: {
    checking: "正在检查本机出图能力…",
    incompatible: "已开启协助，但网页出图组件需要更新；更新后才能上线提供帮助。",
    missing: "已开启协助，但尚未安装网页出图组件；安装后才能上线提供帮助。",
    account: "已开启协助，但尚未绑定出图账号。请在“网页账户”中选择用于出图的 ChatGPT 账号。",
    update: "更新出图组件",
    install: "安装出图组件",
    installing: "正在安装出图组件…",
    failed: "无法检查或恢复本机出图能力：",
    retry: "重新检查",
  },
  en: {
    checking: "Checking local image generation…",
    incompatible: "Image help is on, but the web image component needs an update before this computer can help others.",
    missing: "Image help is on, but the web image component must be installed before this computer can help others.",
    account: "Image help is on, but no image account is assigned. Choose a ChatGPT account for images in ChatGPT web automation settings.",
    update: "Update image component",
    install: "Install image component",
    installing: "Installing image component…",
    failed: "Unable to check or restore local image generation: ",
    retry: "Check again",
  },
  es: {
    checking: "Comprobando la generación local de imágenes…",
    incompatible: "La ayuda con imágenes está activada, pero el componente de imágenes web necesita actualizarse antes de que este equipo pueda ayudar a otros.",
    missing: "La ayuda con imágenes está activada, pero hay que instalar el componente de imágenes web antes de que este equipo pueda ayudar a otros.",
    account: "La ayuda con imágenes está activada, pero no hay ninguna cuenta de imágenes vinculada. Selecciona una cuenta de ChatGPT para imágenes en Cuentas web.",
    update: "Actualizar el componente de imágenes",
    install: "Instalar el componente de imágenes",
    installing: "Instalando el componente de imágenes…",
    failed: "No se pudo comprobar ni restaurar la generación local de imágenes: ",
    retry: "Volver a comprobar",
  },
};

export function ImageAssistReadiness({ enabled, language }: { enabled: boolean; language: Language }) {
  const copy = COPY[language];
  const [status, setStatus] = useState<OracleWebStatusView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await oracleWebStatus();
        if (!disposed) setStatus(next);
      } catch (cause) {
        if (!disposed) setProblem(String(cause));
      }
    };
    void refresh();
    // Account binding and runtime installation can change in another settings tab.
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [enabled, revision]);

  if (!enabled) return null;
  const runtimeReady = status?.runtime.status === "ready";
  const accountBound = status?.accounts.some((account) => account.id === status.imageAccountId);
  if (runtimeReady && accountBound && !problem) return null;

  const install = async () => {
    setInstalling(true);
    setProblem(null);
    try {
      const next = await oracleWebRuntimeInstall();
      setStatus(next);
      if (next.runtime.status === "ready" && next.accounts.some((account) => account.id === next.imageAccountId)) {
        // Republish immediately using the existing opt-in and optional location.
        await imageAssistPublish(undefined, storedImageAssistLocation());
      }
    } catch (cause) {
      setProblem(String(cause));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="sp-remote-message" role="status">
      <p>{problem ? `${copy.failed}${problem}` : !status ? copy.checking : !runtimeReady
        ? status.runtime.status === "missing" ? copy.missing : copy.incompatible
        : copy.account}</p>
      {!runtimeReady && status?.runtime.installSupported && (
        <button type="button" className="sp-btn" disabled={installing} onClick={() => void install()}>
          {installing ? copy.installing : status.runtime.status === "missing" ? copy.install : copy.update}
        </button>
      )}
      {problem && <button type="button" className="sp-btn" disabled={installing} onClick={() => {
        setProblem(null);
        setRevision((value) => value + 1);
      }}>{copy.retry}</button>}
    </div>
  );
}

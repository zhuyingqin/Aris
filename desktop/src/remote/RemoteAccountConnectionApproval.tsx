import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  remoteControlApprovePairing,
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
} from "../api/tauri";
import { useStore, type Language } from "../store";
import type { RemotePendingPairing } from "../types";

interface AccountPairingStarted {
  requestId: string;
  clientLabel: string;
  pairingId: string;
  expiresAt: number;
}

interface AccountPairingFailed {
  requestId: string;
  clientLabel: string;
  message: string;
}

const STARTED_EVENT = "remote-account-pairing-started";
const FAILED_EVENT = "remote-account-pairing-failed";
const POLL_INTERVAL_MS = 900;

const COPY: Record<Language, {
  expired: string;
  title: string;
  started: (client: string) => string;
  failed: string;
  device: string;
  fingerprint: string;
  scopes: string;
  verifying: string;
  decline: string;
  approving: string;
  approve: string;
  close: string;
}> = {
  cn: {
    expired: "网页连接请求已过期，请在网页端重新发起。",
    title: "网页请求连接这台客户端",
    started: (client) => `${client} 正在使用同一账号发起连接。核对下方设备信息后再允许。`,
    failed: "网页连接请求未能建立。",
    device: "设备",
    fingerprint: "指纹",
    scopes: "权限",
    verifying: "正在验证网页端签名和一次性配对声明…",
    decline: "拒绝",
    approving: "正在允许…",
    approve: "允许连接",
    close: "关闭",
  },
  en: {
    expired: "The web connection request has expired. Start it again from the web page.",
    title: "A web page wants to connect to this client",
    started: (client) => `${client} is connecting with the same account. Check the device details below before you allow it.`,
    failed: "The web connection request could not be established.",
    device: "Device",
    fingerprint: "Fingerprint",
    scopes: "Permissions",
    verifying: "Verifying the web page's signature and one-time pairing claim…",
    decline: "Decline",
    approving: "Allowing…",
    approve: "Allow connection",
    close: "Close",
  },
  es: {
    expired: "La solicitud de conexión web ha caducado. Vuelve a iniciarla desde la página web.",
    title: "Una página web quiere conectarse a este cliente",
    started: (client) => `${client} se está conectando con la misma cuenta. Revisa los datos del dispositivo antes de permitirlo.`,
    failed: "No se pudo establecer la solicitud de conexión web.",
    device: "Dispositivo",
    fingerprint: "Huella",
    scopes: "Permisos",
    verifying: "Verificando la firma de la página web y la solicitud de emparejamiento de un solo uso…",
    decline: "Rechazar",
    approving: "Permitiendo…",
    approve: "Permitir conexión",
    close: "Cerrar",
  },
};

export function RemoteAccountConnectionApproval() {
  const language = useStore((s) => s.language);
  const copy = COPY[language];
  const [started, setStarted] = useState<AccountPairingStarted | null>(null);
  const [pending, setPending] = useState<RemotePendingPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const startedListener = listen<AccountPairingStarted>(STARTED_EVENT, (event) => {
      if (disposed) return;
      setStarted(event.payload);
      setPending(null);
      setBusy(false);
      setError(null);
    });
    const failedListener = listen<AccountPairingFailed>(FAILED_EVENT, (event) => {
      if (disposed) return;
      setStarted(null);
      setPending(null);
      setBusy(false);
      setError(`${event.payload.clientLabel}: ${event.payload.message}`);
    });
    return () => {
      disposed = true;
      void startedListener.then((stop) => stop());
      void failedListener.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (timer.current !== undefined) window.clearInterval(timer.current);
    timer.current = undefined;
    if (!started || pending) return;

    const poll = async () => {
      if (Date.now() >= started.expiresAt) {
        setError(copy.expired);
        setStarted(null);
        return;
      }
      try {
        const claim = await remoteControlPendingPairing(started.pairingId);
        if (claim) setPending(claim);
      } catch (reason) {
        setError(String(reason));
      }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (timer.current !== undefined) window.clearInterval(timer.current);
      timer.current = undefined;
    };
  }, [pending, started, copy]);

  const close = () => {
    setStarted(null);
    setPending(null);
    setBusy(false);
    setError(null);
  };

  const decline = async () => {
    if (!started) return;
    setBusy(true);
    try {
      await remoteControlDiscardPairing(started.pairingId);
      close();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await remoteControlApprovePairing({ pairingId: pending.pairingId });
      close();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  if (!started && !error) return null;
  return (
    <div className="sp-remote-approval-backdrop" role="presentation">
      <section className="sp-remote-approval-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-account-approval-title">
        <div className="sp-remote-approval-icon" aria-hidden="true">↗</div>
        <div>
          <h3 id="remote-account-approval-title">{copy.title}</h3>
          <p>{started ? copy.started(started.clientLabel) : copy.failed}</p>
        </div>
        {pending && (
          <dl className="sp-remote-approval-details">
            <div><dt>{copy.device}</dt><dd>{pending.label}</dd></div>
            <div><dt>{copy.fingerprint}</dt><dd><code>{pending.fingerprint}</code></dd></div>
            <div><dt>{copy.scopes}</dt><dd>{pending.requestedScopes.join(" · ")}</dd></div>
          </dl>
        )}
        {!pending && started && <p className="sp-remote-approval-details">{copy.verifying}</p>}
        {error && <p className="sp-remote-approval-details" role="alert">{error}</p>}
        <div className="sp-remote-approval-actions">
          {started && <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void decline()} disabled={busy}>{copy.decline}</button>}
          {pending && <button className="sp-btn sp-btn-primary" type="button" onClick={() => void approve()} disabled={busy}>{busy ? copy.approving : copy.approve}</button>}
          {!started && <button className="sp-btn sp-btn-secondary" type="button" onClick={close}>{copy.close}</button>}
        </div>
      </section>
    </div>
  );
}

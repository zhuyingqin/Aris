import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  remoteControlApprovePairing,
  remoteControlDiscardPairing,
  remoteControlPendingPairing,
} from "../api/tauri";
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

export function RemoteAccountConnectionApproval() {
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
        setError("网页连接请求已过期，请在网页端重新发起。");
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
  }, [pending, started]);

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
          <h3 id="remote-account-approval-title">网页请求连接这台客户端</h3>
          <p>{started ? `${started.clientLabel} 正在使用同一账号发起连接。核对下方设备信息后再允许。` : "网页连接请求未能建立。"}</p>
        </div>
        {pending && (
          <dl className="sp-remote-approval-details">
            <div><dt>设备</dt><dd>{pending.label}</dd></div>
            <div><dt>指纹</dt><dd><code>{pending.fingerprint}</code></dd></div>
            <div><dt>权限</dt><dd>{pending.requestedScopes.join(" · ")}</dd></div>
          </dl>
        )}
        {!pending && started && <p className="sp-remote-approval-details">正在验证网页端签名和一次性配对声明…</p>}
        {error && <p className="sp-remote-approval-details" role="alert">{error}</p>}
        <div className="sp-remote-approval-actions">
          {started && <button className="sp-btn sp-btn-secondary" type="button" onClick={() => void decline()} disabled={busy}>拒绝</button>}
          {pending && <button className="sp-btn sp-btn-primary" type="button" onClick={() => void approve()} disabled={busy}>{busy ? "正在允许…" : "允许连接"}</button>}
          {!started && <button className="sp-btn sp-btn-secondary" type="button" onClick={close}>关闭</button>}
        </div>
      </section>
    </div>
  );
}

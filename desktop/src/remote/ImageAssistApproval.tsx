import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { imageAssistConsent, imageAssistDecide, imageAssistPublish, imageAssistRoster } from "../api/tauri";
import { storedImageAssistLocation } from "./imageAssistLocation";
import {
  imageAssistActivitySnapshot,
  mergeImageAssistActivity,
  publishImageAssistActivity,
  type ImageAssistActivity,
} from "./imageAssistActivity";

/**
 * What the helper's local user is asked to approve.
 *
 * Mirrors `image_assist::ImageAssistApprovalPrompt`. It deliberately carries no
 * match secret, peer descriptor, or transport identifier: this component can
 * only answer yes or no, never open a connection.
 */
export interface ImageAssistApprovalPrompt {
  matchId: string;
  peerFingerprint: string;
  prompt: string;
  aspectRatio?: string | null;
  remainingToday: number;
  expiresAtUnixMs: number;
}

/** What the requester is asked before their prompt leaves this computer. */
export interface ImageAssistConsentPrompt {
  consentId: string;
  prompt: string;
  aspectRatio?: string | null;
}

export type ImageAssistMatchUpdate = ImageAssistActivity;

const APPROVAL_EVENT = "image-assist-approval";
const CONSENT_EVENT = "image-assist-consent";
const ERROR_EVENT = "image-assist-error";
const MATCH_EVENT = "image-assist-match";

/** How long a refusal notice stays on screen before fading out. */
const NOTICE_TIMEOUT_MS = 15_000;

/**
 * Advertisement lease renewal.
 *
 * Shorter than the gateway's 60s lease so a helper that is still willing never
 * briefly disappears from the roster between renewals.
 */
const PUBLISH_INTERVAL_MS = 30_000;
/** How often the roster is refreshed while the app is open. */
const ROSTER_INTERVAL_MS = 45_000;

/**
 * Brokered image dialogs, plus the advertisement and roster heartbeats.
 *
 * Mounted once at app root rather than inside Settings: a helper must stay
 * advertised while they use the rest of the app, and a request can arrive at
 * any moment. Publishing reads the authoritative policy in Rust, so mounting
 * this does not by itself opt anyone in.
 */
export function ImageAssistApproval() {
  const [pending, setPending] = useState<ImageAssistApprovalPrompt | null>(null);
  const [consent, setConsent] = useState<ImageAssistConsentPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A request that arrived and was refused produces no dialog, which is
  // indistinguishable from nothing arriving. Show the reason wherever the user
  // happens to be rather than only inside Settings.
  const [notice, setNotice] = useState<string | null>(null);
  const activityRef = useRef<ImageAssistActivity | null>(imageAssistActivitySnapshot());
  // A request that expires while the dialog is open must not stay clickable.
  const expiryTimer = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    if (expiryTimer.current !== undefined) window.clearTimeout(expiryTimer.current);
    expiryTimer.current = undefined;
    setPending(null);
    setBusy(false);
    setError(null);
  }, []);

  const updateActivity = useCallback((update: ImageAssistMatchUpdate) => {
    const next = mergeImageAssistActivity(activityRef.current, update);
    activityRef.current = next;
    publishImageAssistActivity(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    const approvals = listen<ImageAssistApprovalPrompt>(APPROVAL_EVENT, (event) => {
      if (disposed) return;
      setPending(event.payload);
      setBusy(false);
      setError(null);
    });
    const consents = listen<ImageAssistConsentPrompt>(CONSENT_EVENT, (event) => {
      if (disposed) return;
      setConsent(event.payload);
      setBusy(false);
      setError(null);
    });
    const notices = listen<string>(ERROR_EVENT, (event) => {
      if (disposed) return;
      setNotice(event.payload);
    });
    const matches = listen<ImageAssistMatchUpdate>(MATCH_EVENT, (event) => {
      if (disposed) return;
      updateActivity(event.payload);
    });
    return () => {
      disposed = true;
      void approvals.then((stop) => stop());
      void consents.then((stop) => stop());
      void notices.then((stop) => stop());
      void matches.then((stop) => stop());
    };
  }, [updateActivity]);

  // Advertise and refresh the roster on a heartbeat. Both are best effort: a
  // failed beat costs one interval of visibility, never correctness.
  useEffect(() => {
    let disposed = false;
    const beat = () => {
      if (disposed) return;
      void imageAssistPublish(undefined, storedImageAssistLocation()).catch(() => undefined);
      void imageAssistRoster().catch(() => undefined);
    };
    beat();
    const publishTimer = window.setInterval(
      () => void imageAssistPublish(undefined, storedImageAssistLocation()).catch(() => undefined),
      PUBLISH_INTERVAL_MS,
    );
    const rosterTimer = window.setInterval(
      () => void imageAssistRoster().catch(() => undefined),
      ROSTER_INTERVAL_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(publishTimer);
      window.clearInterval(rosterTimer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!pending) return;
    const remaining = pending.expiresAtUnixMs - Date.now();
    if (remaining <= 0) {
      dismiss();
      return;
    }
    expiryTimer.current = window.setTimeout(dismiss, remaining);
    return () => {
      if (expiryTimer.current !== undefined) window.clearTimeout(expiryTimer.current);
    };
  }, [pending, dismiss]);

  const decide = useCallback(
    async (accept: boolean) => {
      if (!pending || busy) return;
      setBusy(true);
      try {
        await imageAssistDecide(pending.matchId, accept);
        updateActivity({
          matchId: pending.matchId,
          stage: accept ? "accepted" : "declined",
          detail: accept ? "已接受请求，正在创建图片互助临时会话" : "已拒绝该图片请求",
          prompt: pending.prompt,
          aspectRatio: pending.aspectRatio,
        });
        dismiss();
      } catch (cause) {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [pending, busy, dismiss, updateActivity],
  );

  const answerConsent = useCallback(
    async (approve: boolean) => {
      if (!consent || busy) return;
      setBusy(true);
      try {
        await imageAssistConsent(consent.consentId, approve);
        if (approve) {
          updateActivity({
            matchId: null,
            stage: "matching",
            detail: "请求已提交，正在匹配在线互助用户",
            prompt: consent.prompt,
            aspectRatio: consent.aspectRatio,
          });
        }
        setConsent(null);
        setBusy(false);
        setError(null);
      } catch (cause) {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [consent, busy, updateActivity],
  );

  const noticeBanner = notice ? (
    <div className="sp-image-assist-notice" role="status">
      <span>{notice}</span>
      <button type="button" onClick={() => setNotice(null)} aria-label="关闭">
        ×
      </button>
    </div>
  ) : null;

  if (consent) {
    return (
      <>
      <div className="sp-image-assist-approval" role="dialog" aria-modal="true">
        <div className="sp-image-assist-approval-card">
          <div className="sp-image-assist-approval-head">
            <strong>把这个提示词发给另一位用户？</strong>
            <small>将请一位在线的陌生用户用他们的 ChatGPT 账号代为生成。</small>
          </div>

          <div className="sp-image-assist-approval-prompt">
            <label>将发送的内容</label>
            <pre>{consent.prompt}</pre>
            {consent.aspectRatio ? <small>比例 {consent.aspectRatio}</small> : null}
          </div>

          <p className="sp-image-assist-approval-note">
            对方必须读到这段提示词才能出图，生成的图片也会留在对方的 ChatGPT 记录里。端到端加密不能改变这一点。
          </p>

          {error ? <p className="sp-image-assist-approval-error">{error}</p> : null}

          <div className="sp-image-assist-approval-actions">
            <button type="button" onClick={() => void answerConsent(false)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="sp-primary"
              onClick={() => void answerConsent(true)}
              disabled={busy}
            >
              {busy ? "处理中…" : "发送并请求生成"}
            </button>
          </div>
        </div>
      </div>
      </>
    );
  }

  if (!pending) return <>{noticeBanner}</>;

  return (
    <>
    <div className="sp-image-assist-approval" role="dialog" aria-modal="true">
      <div className="sp-image-assist-approval-card">
        <div className="sp-image-assist-approval-head">
          <strong>另一位用户请求你代为生成图片</strong>
          <small>
            设备 {pending.peerFingerprint} · 今日还可帮助 {pending.remainingToday} 次
          </small>
        </div>

        <div className="sp-image-assist-approval-prompt">
          <label>完整提示词</label>
          {/* Rendered as text, never as markup: this string comes from a
              stranger and must not be able to inject anything. */}
          <pre>{pending.prompt}</pre>
          {pending.aspectRatio ? <small>比例 {pending.aspectRatio}</small> : null}
        </div>

        <p className="sp-image-assist-approval-note">
          同意后将使用你本机绑定的 ChatGPT 账号生成，消耗你的额度并留在你的 ChatGPT 记录中。
        </p>

        {error ? <p className="sp-image-assist-approval-error">{error}</p> : null}

        <div className="sp-image-assist-approval-actions">
          <button type="button" onClick={() => void decide(false)} disabled={busy}>
            拒绝
          </button>
          <button
            type="button"
            className="sp-primary"
            onClick={() => void decide(true)}
            disabled={busy}
          >
            {busy ? "处理中…" : "同意并生成"}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

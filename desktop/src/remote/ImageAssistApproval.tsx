import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { imageAssistConsent, imageAssistDecide, imageAssistPublish, imageAssistRoster } from "../api/tauri";
import { useStore, type Language } from "../store";
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

const COPY: Record<Language, {
  accepted: string;
  declined: string;
  matching: string;
  close: string;
  consentTitle: string;
  consentSubtitle: string;
  consentPromptLabel: string;
  aspectRatio: (ratio: string) => string;
  consentNote: string;
  cancel: string;
  working: string;
  send: string;
  requestTitle: string;
  requestMeta: (fingerprint: string, remaining: number) => string;
  fullPrompt: string;
  requestNote: string;
  decline: string;
  accept: string;
}> = {
  cn: {
    accepted: "已接受请求，正在创建图片互助临时会话",
    declined: "已拒绝该图片请求",
    matching: "请求已提交，正在匹配在线互助用户",
    close: "关闭",
    consentTitle: "把这个提示词发给另一位用户？",
    consentSubtitle: "将请一位在线的陌生用户用他们的 ChatGPT 账号代为生成。",
    consentPromptLabel: "将发送的内容",
    aspectRatio: (ratio) => `比例 ${ratio}`,
    consentNote: "对方必须读到这段提示词才能出图，生成的图片也会留在对方的 ChatGPT 记录里。端到端加密不能改变这一点。",
    cancel: "取消",
    working: "处理中…",
    send: "发送并请求生成",
    requestTitle: "另一位用户请求你代为生成图片",
    requestMeta: (fingerprint, remaining) => `设备 ${fingerprint} · 今日还可帮助 ${remaining} 次`,
    fullPrompt: "完整提示词",
    requestNote: "同意后将使用你本机绑定的 ChatGPT 账号生成，消耗你的额度并留在你的 ChatGPT 记录中。",
    decline: "拒绝",
    accept: "同意并生成",
  },
  en: {
    accepted: "Request accepted. Creating a temporary image-assist session…",
    declined: "Image request declined",
    matching: "Request sent. Looking for an online helper…",
    close: "Close",
    consentTitle: "Send this prompt to another user?",
    consentSubtitle: "An online stranger will generate the image with their ChatGPT account.",
    consentPromptLabel: "Content to send",
    aspectRatio: (ratio) => `Aspect ratio ${ratio}`,
    consentNote: "The other user must read this prompt to generate the image, and the image stays in their ChatGPT history. End-to-end encryption does not change this.",
    cancel: "Cancel",
    working: "Working…",
    send: "Send and request image",
    requestTitle: "Another user wants you to generate an image for them",
    requestMeta: (fingerprint, remaining) => `Device ${fingerprint} · ${remaining} ${remaining === 1 ? "assist" : "assists"} left today`,
    fullPrompt: "Full prompt",
    requestNote: "If you accept, the image is generated with the ChatGPT account linked on this computer. It uses your quota and stays in your ChatGPT history.",
    decline: "Decline",
    accept: "Accept and generate",
  },
  es: {
    accepted: "Solicitud aceptada. Creando una sesión temporal de ayuda con imágenes",
    declined: "Solicitud de imagen rechazada",
    matching: "Solicitud enviada. Buscando a alguien en línea que te ayude",
    close: "Cerrar",
    consentTitle: "¿Enviar este prompt a otro usuario?",
    consentSubtitle: "Una persona desconocida en línea generará la imagen con su cuenta de ChatGPT.",
    consentPromptLabel: "Contenido que se enviará",
    aspectRatio: (ratio) => `Proporción ${ratio}`,
    consentNote: "La otra persona tiene que leer este prompt para generar la imagen, y la imagen quedará en su historial de ChatGPT. El cifrado de extremo a extremo no cambia esto.",
    cancel: "Cancelar",
    working: "Procesando…",
    send: "Enviar y solicitar imagen",
    requestTitle: "Otro usuario te pide que generes una imagen por él",
    requestMeta: (fingerprint, remaining) => `Dispositivo ${fingerprint} · ${remaining === 1 ? "Puedes ayudar 1 vez más hoy" : `Puedes ayudar ${remaining} veces más hoy`}`,
    fullPrompt: "Prompt completo",
    requestNote: "Si aceptas, la imagen se generará con la cuenta de ChatGPT vinculada en este equipo, consumirá tu cuota y quedará en tu historial de ChatGPT.",
    decline: "Rechazar",
    accept: "Aceptar y generar",
  },
};

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
  const language = useStore((s) => s.language);
  const copy = COPY[language];
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
          detail: accept ? copy.accepted : copy.declined,
          prompt: pending.prompt,
          aspectRatio: pending.aspectRatio,
        });
        dismiss();
      } catch (cause) {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [pending, busy, dismiss, updateActivity, copy],
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
            detail: copy.matching,
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
    [consent, busy, updateActivity, copy],
  );

  const noticeBanner = notice ? (
    <div className="sp-image-assist-notice" role="status">
      <span>{notice}</span>
      <button type="button" onClick={() => setNotice(null)} aria-label={copy.close}>
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
            <strong>{copy.consentTitle}</strong>
            <small>{copy.consentSubtitle}</small>
          </div>

          <div className="sp-image-assist-approval-prompt">
            <label>{copy.consentPromptLabel}</label>
            <pre>{consent.prompt}</pre>
            {consent.aspectRatio ? <small>{copy.aspectRatio(consent.aspectRatio)}</small> : null}
          </div>

          <p className="sp-image-assist-approval-note">
            {copy.consentNote}
          </p>

          {error ? <p className="sp-image-assist-approval-error">{error}</p> : null}

          <div className="sp-image-assist-approval-actions">
            <button type="button" onClick={() => void answerConsent(false)} disabled={busy}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="sp-primary"
              onClick={() => void answerConsent(true)}
              disabled={busy}
            >
              {busy ? copy.working : copy.send}
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
          <strong>{copy.requestTitle}</strong>
          <small>
            {copy.requestMeta(pending.peerFingerprint, pending.remainingToday)}
          </small>
        </div>

        <div className="sp-image-assist-approval-prompt">
          <label>{copy.fullPrompt}</label>
          {/* Rendered as text, never as markup: this string comes from a
              stranger and must not be able to inject anything. */}
          <pre>{pending.prompt}</pre>
          {pending.aspectRatio ? <small>{copy.aspectRatio(pending.aspectRatio)}</small> : null}
        </div>

        <p className="sp-image-assist-approval-note">
          {copy.requestNote}
        </p>

        {error ? <p className="sp-image-assist-approval-error">{error}</p> : null}

        <div className="sp-image-assist-approval-actions">
          <button type="button" onClick={() => void decide(false)} disabled={busy}>
            {copy.decline}
          </button>
          <button
            type="button"
            className="sp-primary"
            onClick={() => void decide(true)}
            disabled={busy}
          >
            {busy ? copy.working : copy.accept}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

import type { ChatModelRetryEvent } from "../api/tauri";
import type { ErrorMessageLanguage } from "../errorMessage";
import type { ChatBlock, NoticeRetryState } from "../types";

type NoticeBlock = Extract<ChatBlock, { kind: "notice" }>;

export interface RetryNoticeView {
  /** Sentence shown to the user for the current retry state. */
  message: string;
  /** Whole seconds left in the backoff; null when nothing is being waited on. */
  countdownSeconds: number | null;
  /** Retries this notice stands for; > 1 means it absorbed a burst. */
  count: number;
  /** The turn moved on (or ended), so the retry is history, not live. */
  settled: boolean;
}

/** Backoffs are whole seconds in practice; always round up so a countdown ends
 * on "1s" instead of flashing "0s" before the request actually restarts. */
function countdownFrom(resumeAt: number | undefined, now: number): number | null {
  if (resumeAt == null) return null;
  const remaining = resumeAt - now;
  return remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : null;
}

function adjustingMessage(language: ErrorMessageLanguage): string {
  return language === "cn"
    ? "模型正在使用兼容参数重新请求，本轮上下文会保留。"
    : "Retrying the model with compatible request settings; this turn's context is retained.";
}

function retryMessage(
  retry: NoticeRetryState,
  language: ErrorMessageLanguage,
  countdownSeconds: number | null,
  settled: boolean,
): string {
  const chinese = language === "cn";
  if (settled) {
    return chinese
      ? `模型连接曾不稳定，本轮已自动重试 ${retry.count} 次。`
      : `The model connection was unstable; retried ${retry.count} ${retry.count === 1 ? "time" : "times"} this turn.`;
  }
  if (retry.attempt != null && retry.maxAttempts != null) {
    const scope = chinese
      ? `第 ${retry.attempt}/${retry.maxAttempts} 次`
      : `${retry.attempt}/${retry.maxAttempts}`;
    if (countdownSeconds != null) {
      return chinese
        ? `模型连接暂时不稳定，正在重试（${scope}，约 ${countdownSeconds} 秒后继续）。`
        : `The model connection is temporarily unstable; retrying (${scope}, continuing in about ${countdownSeconds}s).`;
    }
    return chinese
      ? `模型连接暂时不稳定，正在重新连接（${scope}）。`
      : `The model connection is temporarily unstable; reconnecting (${scope}).`;
  }
  if (retry.remaining != null) {
    return chinese
      ? `模型流式响应已中断，正在重新连接（剩余 ${retry.remaining} 次自动重试）。`
      : `The model stream was interrupted; reconnecting (${retry.remaining} automatic retries remain).`;
  }
  return chinese ? "模型正在自动重试，请稍候。" : "The model is retrying automatically; please wait.";
}

/** Projects retry state into everything the notice needs to render. Callers
 * pass `now` so the countdown can tick without the block itself changing. */
export function retryNoticeView(
  retry: NoticeRetryState,
  language: ErrorMessageLanguage,
  options: { now?: number; settled?: boolean } = {},
): RetryNoticeView {
  const settled = options.settled ?? false;
  const countdownSeconds = settled
    ? null
    : countdownFrom(retry.resumeAt, options.now ?? Date.now());
  return {
    message: retryMessage(retry, language, countdownSeconds, settled),
    countdownSeconds,
    count: retry.count,
    settled,
  };
}

/**
 * Folds one retry event into a turn's blocks.
 *
 * Every attempt of every request in the turn fires its own event, so appending
 * a notice per event buried the answer under a wall of near-identical banners.
 * Consecutive retries instead update a single live block in place and count
 * themselves; a retry that arrives after real progress (text, a tool call)
 * starts a fresh block so the transcript keeps its order.
 */
export function foldModelRetryNotice(
  blocks: ChatBlock[],
  event: ChatModelRetryEvent,
  language: ErrorMessageLanguage,
  now: number = Date.now(),
): ChatBlock[] {
  const last = blocks[blocks.length - 1];
  const previous: NoticeBlock | undefined = last?.kind === "notice" ? last : undefined;
  if (event.action === "adjusting") {
    // A one-shot body-compatibility recovery, not a transport failure: no
    // countdown, but repeating the same sentence verbatim adds nothing.
    const message = adjustingMessage(language);
    if (previous && !previous.retry && previous.message === message) return blocks;
    return [...blocks, { kind: "notice", message }];
  }
  const prior = previous?.retry;
  const backoffMs = event.backoffMs != null && event.backoffMs > 0 ? event.backoffMs : null;
  const retry: NoticeRetryState = {
    attempt: event.attempt != null && event.maxAttempts != null
      ? Math.min(event.attempt + 1, event.maxAttempts)
      : undefined,
    maxAttempts: event.maxAttempts ?? undefined,
    remaining: event.retriesRemaining ?? undefined,
    resumeAt: backoffMs != null ? now + backoffMs : undefined,
    count: (prior?.count ?? 0) + 1,
  };
  const block: NoticeBlock = {
    kind: "notice",
    message: retryNoticeView(retry, language, { now }).message,
    retry,
  };
  return prior ? [...blocks.slice(0, -1), block] : [...blocks, block];
}

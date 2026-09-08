/**
 * Process-local presentation state for one brokered image request.
 *
 * The approval controller is mounted at the application root, while the task
 * surface belongs inside Chat's project summary. A small browser event keeps
 * those ownership boundaries separate without making transport state part of
 * the global application store.
 */
export interface ImageAssistActivity {
  matchId?: string | null;
  stage: string;
  detail?: string | null;
  prompt?: string | null;
  aspectRatio?: string | null;
  images?: string[];
  transferReceivedBytes?: number | null;
  transferTotalBytes?: number | null;
  transferCompletedArtifacts?: number | null;
  transferArtifactCount?: number | null;
  transferDirection?: "sending" | "receiving" | null;
}

export const IMAGE_ASSIST_ACTIVITY_EVENT = "somniq:image-assist-activity";

let latestActivity: ImageAssistActivity | null = null;

export function imageAssistActivitySnapshot() {
  return latestActivity;
}

export function publishImageAssistActivity(activity: ImageAssistActivity | null) {
  latestActivity = activity;
  window.dispatchEvent(new CustomEvent<ImageAssistActivity | null>(IMAGE_ASSIST_ACTIVITY_EVENT, {
    detail: activity,
  }));
}

export function mergeImageAssistActivity(
  current: ImageAssistActivity | null,
  update: ImageAssistActivity,
): ImageAssistActivity {
  // A fresh request must never inherit the previous request's thumbnail list
  // or prompt. The first matching event has no match id yet, so the stage is
  // also a deliberate reset boundary.
  const freshRequest = update.stage === "matching"
    || Boolean(update.matchId && current?.matchId && update.matchId !== current.matchId);
  const base = freshRequest ? null : current;
  return {
    ...base,
    ...update,
    matchId: update.matchId ?? base?.matchId ?? null,
    detail: update.detail ?? base?.detail ?? null,
    prompt: update.prompt ?? base?.prompt ?? null,
    aspectRatio: update.aspectRatio ?? base?.aspectRatio ?? null,
    images: update.images?.length ? update.images : base?.images ?? [],
    transferReceivedBytes: update.transferReceivedBytes ?? base?.transferReceivedBytes ?? null,
    transferTotalBytes: update.transferTotalBytes ?? base?.transferTotalBytes ?? null,
    transferCompletedArtifacts: update.transferCompletedArtifacts ?? base?.transferCompletedArtifacts ?? null,
    transferArtifactCount: update.transferArtifactCount ?? base?.transferArtifactCount ?? null,
    transferDirection: update.transferDirection ?? base?.transferDirection ?? null,
  };
}

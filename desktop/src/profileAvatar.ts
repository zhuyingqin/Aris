import { useEffect, useState } from "react";

export const PROFILE_AVATAR_CACHE_KEY = "somniq-profile-avatar-v1";
export const PROFILE_AVATAR_CHANGED_EVENT = "somniq-profile-avatar-changed";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const AVATAR_EDGE_PX = 512;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,/i;

export type ProfileAvatarPrepareError = "unsupported" | "too-large" | "decode-failed";

export class ProfileAvatarError extends Error {
  readonly reason: ProfileAvatarPrepareError;

  constructor(reason: ProfileAvatarPrepareError) {
    super(reason);
    this.name = "ProfileAvatarError";
    this.reason = reason;
  }
}

export function readProfileAvatar(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(PROFILE_AVATAR_CACHE_KEY);
    return value && SUPPORTED_DATA_URL.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeProfileAvatar(value: string | null): boolean {
  if (typeof window === "undefined" || (value && !SUPPORTED_DATA_URL.test(value))) return false;
  try {
    if (value) window.localStorage.setItem(PROFILE_AVATAR_CACHE_KEY, value);
    else window.localStorage.removeItem(PROFILE_AVATAR_CACHE_KEY);
    window.dispatchEvent(new Event(PROFILE_AVATAR_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function useProfileAvatar(): string | null {
  const [avatar, setAvatar] = useState<string | null>(() => readProfileAvatar());

  useEffect(() => {
    const refresh = () => setAvatar(readProfileAvatar());
    window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return avatar;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ProfileAvatarError("decode-failed"));
    image.src = source;
  });
}

/** Crop the chosen image to a square and cap its persisted size. */
export async function prepareProfileAvatar(file: File): Promise<string> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new ProfileAvatarError("unsupported");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ProfileAvatarError("too-large");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new ProfileAvatarError("decode-failed");
    }

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE_PX;
    canvas.height = AVATAR_EDGE_PX;
    const context = canvas.getContext("2d");
    if (!context) throw new ProfileAvatarError("decode-failed");

    const sourceEdge = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceEdge) / 2;
    const sourceY = (image.naturalHeight - sourceEdge) / 2;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceEdge,
      sourceEdge,
      0,
      0,
      AVATAR_EDGE_PX,
      AVATAR_EDGE_PX,
    );
    const prepared = canvas.toDataURL("image/webp", 0.9);
    if (!SUPPORTED_DATA_URL.test(prepared)) throw new ProfileAvatarError("decode-failed");
    return prepared;
  } catch (error) {
    if (error instanceof ProfileAvatarError) throw error;
    throw new ProfileAvatarError("decode-failed");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

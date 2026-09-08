import jsQR from "jsqr";

import { base64UrlToBytes, RemoteProtocolError } from "./protocol";

const CAMERA_SCAN_INTERVAL_MS = 120;
const CAMERA_MAX_DIMENSION = 1280;
const GALLERY_MAX_DIMENSION = 2048;
const MAX_GALLERY_IMAGE_BYTES = 12 * 1024 * 1024;

export interface CameraScanHandlers {
  onResult(rawValue: string): void;
  onError(error: Error): void;
}

/**
 * A local, in-browser camera scanner. It never uploads video frames or QR
 * contents; decoded values are handed straight to the existing pairing flow.
 */
export class BrowserQrCameraScanner {
  private canvas: HTMLCanvasElement | null = null;
  private frameRequest: number | null = null;
  private generation = 0;
  private handlers: CameraScanHandlers | null = null;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  async start(video: HTMLVideoElement, handlers: CameraScanHandlers): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      throw new RemoteProtocolError("当前浏览器无法直接打开相机。请从相册选择二维码图片。");
    }

    let stream: MediaStream;
    try {
      stream = await getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch (error) {
      throw cameraAccessError(error);
    }

    if (generation !== this.generation) {
      stopMediaStream(stream);
      return;
    }

    this.stream = stream;
    this.video = video;
    this.handlers = handlers;
    this.lastScanAt = Number.NEGATIVE_INFINITY;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    try {
      await video.play();
    } catch {
      this.stop();
      throw new RemoteProtocolError("无法启动相机预览。请关闭其他正在使用相机的应用，或从相册选择二维码。");
    }

    if (generation === this.generation) {
      this.scheduleNextFrame();
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.frameRequest !== null) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    stopMediaStream(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
    }
    this.video = null;
    this.handlers = null;
    this.lastScanAt = Number.NEGATIVE_INFINITY;
  }

  private scheduleNextFrame(): void {
    this.frameRequest = requestAnimationFrame((timestamp) => this.scanNextFrame(timestamp));
  }

  private scanNextFrame(timestamp: number): void {
    this.frameRequest = null;
    const video = this.video;
    if (!this.stream || !video) {
      return;
    }

    if (timestamp - this.lastScanAt >= CAMERA_SCAN_INTERVAL_MS) {
      this.lastScanAt = timestamp;
      try {
        const rawValue = decodeQrFromVideoFrame(video, this.getCanvas());
        if (rawValue) {
          const handlers = this.handlers;
          this.stop();
          handlers?.onResult(rawValue);
          return;
        }
      } catch (error) {
        const handlers = this.handlers;
        this.stop();
        handlers?.onError(error instanceof Error
          ? error
          : new RemoteProtocolError("无法读取相机画面。请从相册选择二维码图片。"));
        return;
      }
    }

    this.scheduleNextFrame();
  }

  private getCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
    }
    return this.canvas;
  }
}

/**
 * Reads a QR image locally. This works even on browsers without the
 * experimental Barcode Detection API, and never transfers the image or QR
 * payload to a third party.
 */
export async function readPairingQrImage(file: File): Promise<string> {
  if (file.size === 0) {
    throw new RemoteProtocolError("选择的二维码图片为空。");
  }
  if (file.size > MAX_GALLERY_IMAGE_BYTES) {
    throw new RemoteProtocolError("二维码图片过大。请选择小于 12 MB 的图片。");
  }
  if (file.type && !file.type.startsWith("image/")) {
    throw new RemoteProtocolError("请选择图片格式的二维码文件。");
  }

  const rawValue = await decodeQrFromImageFile(file);
  if (!rawValue) {
    throw new RemoteProtocolError("未在图片中找到 SomniQ 配对二维码。");
  }
  return pairingPayloadFromQrContent(rawValue);
}

/**
 * Accept the P2 deep link produced by the desktop (`/remote/pair#p=<base64url>`),
 * while retaining legacy raw-JSON QR codes during the rollout. The resulting
 * invitation is still validated by `parsePairingInvitation` before it can
 * create a claim.
 */
export function pairingPayloadFromQrContent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RemoteProtocolError("配对二维码为空。");
  }

  const fragment = fragmentFromDeepLink(trimmed);
  if (fragment === null) {
    return trimmed;
  }
  const payload = pairingPayloadFromDeepLinkFragment(fragment);
  if (payload === null) {
    throw new RemoteProtocolError("这不是 SomniQ 配对链接。");
  }
  return payload;
}

/**
 * Cleans a connection code that arrived through the clipboard rather than a
 * camera.
 *
 * Copying a long code out of a chat message, an email or a terminal readily
 * introduces hard line breaks, and a deep link never legitimately contains
 * whitespace — so collapsing it turns a silent "这不是 SomniQ 配对链接" into a
 * successful pair. Legacy raw-JSON invitations are left untouched: their
 * device display names can contain real spaces.
 */
export function normalizePastedPairingCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  return trimmed.replace(/\s+/g, "");
}

/**
 * Turns anything a person can paste into the fragment the PWA reads.
 *
 * The desktop's "copy connection code" button hands over a full deep link, but
 * a code that travelled through a chat window arrives as a bare fragment, a
 * bare base64url payload, or (on older desktops) raw JSON. The dashboard
 * forwards the result to the embedded app as `./remote/<fragment>`, so this
 * has to be the one place that knows the format — a second copy of these rules
 * on the website silently dropped codes it did not recognize.
 */
export function pairingDeepLinkFragmentFromPastedCode(value: string): string {
  const trimmed = normalizePastedPairingCode(value);
  if (!trimmed) {
    throw new RemoteProtocolError("配对二维码为空。");
  }

  const fragment = fragmentFromDeepLink(trimmed);
  if (fragment !== null) {
    // Re-encoding a payload that already travels encoded could only risk
    // changing it, so the fragment is validated and then passed through.
    assertInvitationPayload(pairingPayloadFromDeepLinkFragment(fragment));
    return fragment.startsWith("#") ? fragment : `#${fragment}`;
  }

  if (trimmed.startsWith("{")) {
    return pairingDeepLinkFragment(trimmed);
  }

  if (/^https?:\/\//i.test(trimmed)) {
    // A link that reached here carries no fragment at all, so it is some other
    // page rather than a damaged code.
    throw new RemoteProtocolError("这不是 SomniQ 配对链接。");
  }

  // A bare token is already the encoded payload; confirm it decodes rather
  // than handing the PWA something it can only fail on later.
  const candidate = `#p=${trimmed}`;
  assertInvitationPayload(pairingPayloadFromDeepLinkFragment(candidate));
  return candidate;
}

function assertInvitationPayload(payload: string | null): void {
  if (payload === null || !payload.trimStart().startsWith("{")) {
    throw new RemoteProtocolError("这不是 SomniQ 配对链接。");
  }
}

/** The inverse of `pairingPayloadFromDeepLinkFragment`. */
export function pairingDeepLinkFragment(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `#p=${encoded}`;
}

/**
 * Extracts the invitation payload from `#p=<base64url-json>`. Callers that
 * read the current page fragment must clear it immediately afterwards so the
 * one-time pairing secret does not remain in browser history.
 */
export function pairingPayloadFromDeepLinkFragment(fragment: string): string | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const encoded = new URLSearchParams(raw).get("p");
  if (!encoded) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded));
  } catch {
    throw new RemoteProtocolError("SomniQ 配对链接已损坏或不受支持。");
  }
}

async function decodeQrFromImageFile(file: File): Promise<string | null> {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        return decodeQrFromRenderable(bitmap, bitmap.width, bitmap.height, GALLERY_MAX_DIMENSION);
      } finally {
        bitmap.close();
      }
    } catch {
      // Some mobile browsers cannot create an ImageBitmap for HEIC or an
      // orientation-tagged photo. Fall through to an HTML image decoder.
    }
  }

  const image = await loadImageFile(file);
  try {
    return decodeQrFromRenderable(image, image.naturalWidth, image.naturalHeight, GALLERY_MAX_DIMENSION);
  } finally {
    URL.revokeObjectURL(image.src);
  }
}

function decodeQrFromVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }
  return decodeQrFromRenderable(video, video.videoWidth, video.videoHeight, CAMERA_MAX_DIMENSION, canvas);
}

function decodeQrFromRenderable(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
  canvas = document.createElement("canvas"),
): string | null {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RemoteProtocolError("二维码图片尺寸无效。");
  }
  const { width, height } = fitWithin(sourceWidth, sourceHeight, maxDimension);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new RemoteProtocolError("当前浏览器无法读取二维码画面。");
  }
  context.drawImage(source, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return jsQR(imageData.data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

function fitWithin(sourceWidth: number, sourceHeight: number, maxDimension: number): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function loadImageFile(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new RemoteProtocolError("无法打开该图片。请换一张包含完整二维码的图片。"));
    };
    image.src = objectUrl;
  });
}

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function cameraAccessError(error: unknown): RemoteProtocolError {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new RemoteProtocolError("未取得相机权限。请允许相机访问，或从相册选择二维码图片。");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new RemoteProtocolError("未找到可用相机。请从相册选择二维码图片。");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new RemoteProtocolError("相机正被其他应用使用。请关闭占用后重试，或从相册选择二维码图片。");
  }
  return new RemoteProtocolError("无法打开相机。请检查浏览器权限，或从相册选择二维码图片。");
}

function fragmentFromDeepLink(value: string): string | null {
  if (value.startsWith("#")) {
    return value;
  }
  try {
    return new URL(value).hash || null;
  } catch {
    return null;
  }
}

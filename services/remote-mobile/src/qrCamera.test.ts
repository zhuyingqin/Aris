import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserQrCameraScanner } from "./qr";

afterEach(() => vi.unstubAllGlobals());

describe("BrowserQrCameraScanner", () => {
  it("releases camera tracks and the preview when the user closes the scanner", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const requestAnimationFrame = vi.fn(() => 42);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const video = {
      muted: false,
      playsInline: false,
      srcObject: null,
      play: vi.fn(async () => undefined),
    } as unknown as HTMLVideoElement;
    const scanner = new BrowserQrCameraScanner();

    await scanner.start(video, { onResult: vi.fn(), onError: vi.fn() });
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);

    scanner.stop();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });

  it("releases a late camera stream when the scan is cancelled during permission", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const deferredCamera = {
      resolve: (_stream: MediaStream): void => {
        throw new Error("Camera permission was not requested.");
      },
    };
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      deferredCamera.resolve = resolve;
    }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const video = {
      muted: false,
      playsInline: false,
      srcObject: null,
      play: vi.fn(async () => undefined),
    } as unknown as HTMLVideoElement;
    const scanner = new BrowserQrCameraScanner();
    const start = scanner.start(video, { onResult: vi.fn(), onError: vi.fn() });

    scanner.stop();
    deferredCamera.resolve(stream);
    await start;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });
});

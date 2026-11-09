// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  fileReadBytes: vi.fn<() => Promise<ArrayBuffer>>(),
  clipboardWriteImage: vi.fn<() => Promise<void>>(),
}));
vi.mock("./api/tauri", () => api);
import { copyImageToClipboard } from "./imageClipboard";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]).buffer;

describe("image clipboard", () => {
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
    api.isTauri.mockReturnValue(true);
    api.fileReadBytes.mockResolvedValue(png);
    api.clipboardWriteImage.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends original PNG bytes to the native clipboard without resizing or re-encoding", async () => {
    await copyImageToClipboard(".somniq/artifacts/somni-images/result.png");
    expect(api.fileReadBytes).toHaveBeenCalledWith(".somniq/artifacts/somni-images/result.png");
    expect(api.clipboardWriteImage).toHaveBeenCalledTimes(1);
    expect(api.clipboardWriteImage).toHaveBeenCalledWith(png);
  });

  it("reports native clipboard failures to the caller", async () => {
    api.clipboardWriteImage.mockRejectedValueOnce(new Error("Clipboard busy"));
    await expect(copyImageToClipboard("plot.png")).rejects.toThrow("Clipboard busy");
  });

  it("converts SVG at its natural size and releases the temporary URL", async () => {
    api.fileReadBytes.mockResolvedValueOnce(new TextEncoder().encode("<svg/>").buffer);
    const createUrl = vi.fn(() => "blob:image-source");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 1973;
      naturalHeight = 1200;
      decode = vi.fn(() => Promise.resolve());
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const sizes: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      sizes.push([this.width, this.height]);
      callback(new Blob([png], { type: "image/png" }));
    });
    await copyImageToClipboard("figures/diagram.svg");
    expect(sizes).toEqual([[1973, 1200]]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(api.clipboardWriteImage).toHaveBeenCalledWith(png);
    expect(revokeUrl).toHaveBeenCalledWith("blob:image-source");
  });

  it("starts browser clipboard writing before the asynchronous file read completes", async () => {
    api.isTauri.mockReturnValue(false);
    let finishRead!: (bytes: ArrayBuffer) => void;
    api.fileReadBytes.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    const items: Record<string, Promise<Blob>>[] = [];
    vi.stubGlobal("ClipboardItem", class {
      constructor(data: Record<string, Promise<Blob>>) { items.push(data); }
    });
    const write = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { write } });
    const copying = copyImageToClipboard("plot.png");
    expect(write).toHaveBeenCalledTimes(1);
    expect(api.clipboardWriteImage).not.toHaveBeenCalled();
    finishRead(png);
    await copying;
    expect(await (await items[0]["image/png"]).arrayBuffer()).toEqual(png);
  });

  it("fails clearly when browser image copying is unavailable", async () => {
    api.isTauri.mockReturnValue(false);
    vi.stubGlobal("navigator", {});
    await expect(copyImageToClipboard("plot.png")).rejects.toThrow("Image clipboard is unavailable");
    expect(api.fileReadBytes).not.toHaveBeenCalled();
  });
});


describe("clipboard images without workspace paths", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it.each(["data:image/png;base64,iVBORw0KGgo=", "blob:pasted-image", "https://example.com/plot.png?token=a%2Fb"])("copies the exact direct source: %s", async (src) => {
    vi.stubGlobal("Blob", NodeBlob);
    api.isTauri.mockReturnValue(true);
    api.clipboardWriteImage.mockResolvedValue(undefined);
    const fetchImage = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(png), headers: new Headers({ "content-type": "image/png" }) }));
    vi.stubGlobal("fetch", fetchImage);
    await copyImageToClipboard(src);
    expect(fetchImage).toHaveBeenCalledWith(src);
    expect(api.fileReadBytes).not.toHaveBeenCalled();
    expect(api.clipboardWriteImage).toHaveBeenCalledWith(png);
  });

  it("uses the displayed image when a library attachment is outside the active workspace", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    api.isTauri.mockReturnValue(true);
    api.fileReadBytes.mockRejectedValueOnce(new Error("Outside workspace"));
    api.clipboardWriteImage.mockResolvedValue(undefined);
    const fetchImage = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(png), headers: new Headers() }));
    vi.stubGlobal("fetch", fetchImage);
    await copyImageToClipboard("library/attachment.png", "asset://library-image");
    expect(fetchImage).toHaveBeenCalledWith("asset://library-image");
    expect(api.clipboardWriteImage).toHaveBeenCalledWith(png);
  });

  it("does not write a failed network response to the clipboard", async () => {
    api.isTauri.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
    await expect(copyImageToClipboard("https://example.com/missing.png")).rejects.toThrow("Unable to read image");
    expect(api.clipboardWriteImage).not.toHaveBeenCalled();
  });
});

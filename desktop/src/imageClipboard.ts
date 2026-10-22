import { clipboardWriteImage, fileReadBytes, isTauri } from "./api/tauri";
import { imageMimeType } from "./imageFiles";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function readImageSource(source: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (/^(data:image\/|blob:|https?:\/\/|asset:\/\/)/i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Unable to read image");
    return { bytes: await response.arrayBuffer(), mimeType: response.headers.get("content-type") || imageMimeType(source) };
  }
  return { bytes: await fileReadBytes(source), mimeType: imageMimeType(source) };
}

async function readClipboardPng(source: string, fallbackSrc?: string): Promise<Blob> {
  const { bytes, mimeType } = await readImageSource(source).catch((error: unknown) => {
    if (fallbackSrc && fallbackSrc !== source) return readImageSource(fallbackSrc);
    throw error;
  });
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PNG_SIGNATURE.length));
  if (PNG_SIGNATURE.every((value, index) => header[index] === value)) {
    return new Blob([bytes], { type: "image/png" });
  }

  // Render other formats to PNG at their natural size, never the preview size.
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("Unable to render image");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Unable to encode image")),
      "image/png",
    ));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy the original image pixels, including transparency, to the clipboard. */
export function copyImageToClipboard(source: string, fallbackSrc?: string): Promise<void> {
  if (isTauri()) {
    return readClipboardPng(source, fallbackSrc)
      .then((png) => png.arrayBuffer())
      .then(clipboardWriteImage);
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  // Start the write during the click gesture, even when the file loads later.
  return navigator.clipboard.write([new ClipboardItem({ "image/png": readClipboardPng(source, fallbackSrc) })]);
}

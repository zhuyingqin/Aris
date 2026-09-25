// Shared by the selection overlay and the pinned crops, which both have to be
// sure their pixels are decoded *before* their window is revealed — the window
// is held hidden precisely so the user never sees a frame without them.

/**
 * Resolve once the image is decoded and safe to paint.
 *
 * `HTMLImageElement.decode()` is the tidier API but Chromium can defer it
 * indefinitely while the document is hidden — which is exactly the state a
 * screenshot window is in for the first frames after it is created.
 */
export function decodeImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the screen capture could not be decoded"));
    image.src = source;
  });
}

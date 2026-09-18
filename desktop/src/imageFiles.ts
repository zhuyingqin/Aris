/**
 * What counts as an image, and what MIME type it carries.
 *
 * Shared so the surfaces that can now display a picture in-app — chat previews
 * and literature attachments — agree on the answer instead of each carrying
 * their own extension table.
 */

const IMAGE_MIME: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jfif": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

function imageExtension(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const clean = name.split("?", 1)[0].split("#", 1)[0];
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index).toLowerCase() : "";
}

/** Whether a path names an image file, judged by extension alone. */
export function isImagePath(path: string): boolean {
  return imageExtension(path) in IMAGE_MIME;
}

/**
 * MIME type for an image path. The fallback matters for files staged under a
 * rewritten name, where the caller already knows it is an image but the
 * extension no longer says so.
 */
export function imageMimeType(path: string, fallback = "application/octet-stream"): string {
  return IMAGE_MIME[imageExtension(path)] ?? fallback;
}

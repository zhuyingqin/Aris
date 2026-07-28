import { useEffect, useMemo, useState } from "react";
import { fileOpen, fileReadBytes } from "../api/tauri";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:[?#].*)?$/i;
const DIRECT_IMAGE_SOURCE_RE = /^(data:image\/|blob:|https?:\/\/)/i;

function decodeHref(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripLocationSuffix(path: string): string {
  const withoutHash = path.split("#", 1)[0];
  const withoutQuery = withoutHash.split("?", 1)[0];
  const match = withoutQuery.match(/^(.*):\d+(?::\d+)?$/);
  return match ? match[1] : withoutQuery;
}

export function isPreviewableImagePath(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = decodeHref(value.trim());
  if (/^(data:image\/|blob:)/i.test(trimmed)) return true;
  const clean = stripLocationSuffix(trimmed);
  if (!IMAGE_EXT_RE.test(clean)) return false;
  if (/^https?:\/\//i.test(clean)) return true;
  // A bare host name is neither a local relative path nor a URL. Treating it
  // as a path would make `example.com/plot.png` call the local file API.
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\\/]|$)/i.test(clean)) return false;
  if (/^[A-Za-z]:[\\/]/.test(clean)) return true;
  if (/^\.{1,2}[\\/]/.test(clean)) return true;
  if (/^[A-Za-z0-9_.-]+[\\/]/.test(clean)) return true;
  return /^[^\s"'`<>\\/]+\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(clean);
}

export function isDirectImageSource(value: string | null | undefined): value is string {
  return Boolean(value && DIRECT_IMAGE_SOURCE_RE.test(decodeHref(value.trim())));
}

function mimeTypeFromPath(path: string): string {
  const clean = stripLocationSuffix(path).toLowerCase();
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

function bytesToObjectUrl(bytes: ArrayBuffer, mimeType: string): string {
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

interface Props {
  src: string;
  alt?: string;
  title?: string;
  className?: string;
  openPath?: string;
}

export default function ChatImagePreview({
  src,
  alt,
  title,
  className,
  openPath,
}: Props) {
  const normalizedSrc = useMemo(() => decodeHref(src.trim()), [src]);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const directSrc = isDirectImageSource(normalizedSrc) ? normalizedSrc : null;
  const previewableLocalPath = isPreviewableImagePath(normalizedSrc);
  const displaySrc = directSrc ?? objectUrl;
  const canOpen = Boolean(openPath);

  useEffect(() => {
    setFailed(false);
    setObjectUrl(null);
    setImgLoaded(false);
    if (directSrc || !previewableLocalPath) return;

    let disposed = false;
    let url: string | null = null;
    const localPath = stripLocationSuffix(normalizedSrc);
    void fileReadBytes(localPath)
      .then((bytes) => {
        if (disposed) return;
        url = bytesToObjectUrl(bytes, mimeTypeFromPath(localPath));
        setObjectUrl(url);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [directSrc, normalizedSrc, previewableLocalPath]);

  if (!directSrc && !previewableLocalPath) return null;

  if (failed) {
    return (
      <button
        type="button"
        className={`chat-image-fallback${className ? ` ${className}` : ""}`}
        onClick={() => {
          if (openPath) void fileOpen(openPath).catch(() => undefined);
        }}
      >
        {title ?? alt ?? normalizedSrc}
      </button>
    );
  }

  if (!displaySrc) {
    return (
      <span className={`chat-image-loading${className ? ` ${className}` : ""}`}>
        {title ?? alt ?? "Loading image..."}
      </span>
    );
  }

  const image = (
    <img
      className={`chat-image-preview-img ${imgLoaded ? "sq-loaded" : "sq-loading"}`}
      src={displaySrc}
      alt={alt ?? title ?? ""}
      loading="lazy"
      decoding="async"
      onLoad={() => setImgLoaded(true)}
      onError={() => setFailed(true)}
    />
  );

  if (!canOpen) {
    return <span className={`chat-image-preview${className ? ` ${className}` : ""}`}>{image}</span>;
  }

  return (
    <button
      type="button"
      className={`chat-image-preview chat-image-preview-button${className ? ` ${className}` : ""}`}
      title={title ?? "Open image"}
      onClick={() => {
        void fileOpen(openPath!).catch(() => undefined);
      }}
    >
      {image}
      {title && <span className="chat-image-caption">{title}</span>}
    </button>
  );
}

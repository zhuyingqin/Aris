import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { fileAssetUrl, fileReadBytes, isTauri } from "../api/tauri";
import ImageLightbox from "../ImageLightbox";
import { imageMimeType, isImagePath } from "../imageFiles";
import { useStore } from "../store";
import { normalizeLocalFileHref } from "./localFileLinks";
import { readRenderedHeight, rememberRenderedHeight } from "./renderSizeCache";

const DIRECT_IMAGE_SOURCE_RE = /^(data:image\/|blob:|https?:\/\/|asset:\/\/)/i;

function stripLocationSuffix(path: string): string {
  const withoutHash = path.split("#", 1)[0];
  const withoutQuery = withoutHash.split("?", 1)[0];
  const match = withoutQuery.match(/^(.*):\d+(?::\d+)?$/);
  return match ? match[1] : withoutQuery;
}

export function isPreviewableImagePath(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (/^(data:image\/|blob:)/i.test(trimmed)) return true;
  const clean = stripLocationSuffix(normalizeLocalFileHref(trimmed));
  if (!isImagePath(clean)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // Bare hosts must not be sent to the local file API.
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\\/]|$)/i.test(clean)) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(clean) && !/^[a-z]:[\\/]/i.test(clean)) return false;
  return !/[\x00\r\n<>"`|?*]/.test(clean);
}

export function isDirectImageSource(value: string | null | undefined): value is string {
  return Boolean(value && DIRECT_IMAGE_SOURCE_RE.test(value.trim()));
}

function mimeTypeFromPath(path: string): string {
  return imageMimeType(stripLocationSuffix(path), "image/png");
}

function bytesToObjectUrl(bytes: ArrayBuffer, mimeType: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

interface Props {
  src: string;
  alt?: string;
  title?: string;
  className?: string;
  /** Original local file, when src is already a data/blob/asset URL. */
  openPath?: string;
  /** Override the built-in viewer, for example the image workflow's gallery. */
  onClick?: () => void;
  /** Disable a second viewer when displaying an image inside a custom viewer. */
  interactive?: boolean;
  /** Uploaded images can have a staged name that does not match their type. */
  mimeType?: string;
}

export default function ChatImagePreview({
  src, alt, title, className, openPath, onClick, interactive = true, mimeType,
}: Props) {
  const language = useStore((state) => state.language);
  // Remote query strings and percent-encoded data URLs are opaque image data.
  const normalizedSrc = useMemo(() => isDirectImageSource(src) ? src.trim() : normalizeLocalFileHref(src), [src]);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const declaredImageType = mimeType?.startsWith("image/") ? mimeType : null;
  const directSrc = isDirectImageSource(normalizedSrc) ? normalizedSrc : null;
  const previewableLocalPath = (declaredImageType !== null && normalizedSrc.length > 0)
    || isPreviewableImagePath(normalizedSrc);
  const displaySrc = directSrc ?? objectUrl;
  const imagePath = openPath ?? (directSrc ? undefined : stripLocationSuffix(normalizedSrc));

  useEffect(() => setLightboxOpen(false), [normalizedSrc, openPath]);

  useEffect(() => {
    setFailed(false);
    setObjectUrl(null);
    setImgLoaded(false);
    if (directSrc || !previewableLocalPath) return;

    let disposed = false;
    let url: string | null = null;
    const localPath = stripLocationSuffix(normalizedSrc);
    const localType = declaredImageType ?? mimeTypeFromPath(localPath);
    const imageUrlPromise = isTauri()
      ? fileAssetUrl(localPath, localType)
      : fileReadBytes(localPath).then((bytes) => bytesToObjectUrl(bytes, localType));
    void imageUrlPromise
      .then((imageUrl) => {
        if (disposed) {
          if (imageUrl.startsWith("blob:")) URL.revokeObjectURL(imageUrl);
          return;
        }
        url = imageUrl.startsWith("blob:") ? imageUrl : null;
        setObjectUrl(imageUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [declaredImageType, directSrc, normalizedSrc, previewableLocalPath, reloadKey]);

  if (!directSrc && !previewableLocalPath) return null;

  const reserved = readRenderedHeight(normalizedSrc);
  const reserveStyle: CSSProperties | undefined = reserved && !imgLoaded
    ? { minHeight: reserved }
    : undefined;
  const image = failed ? (
    <span>{language === "cn" ? "无法加载图片" : "Could not load image"} · {title ?? alt ?? normalizedSrc}</span>
  ) : !displaySrc ? (
    <span className="chat-image-loading" style={reserveStyle}>{title ?? alt ?? (language === "cn" ? "正在读取图片…" : "Loading image…")}</span>
  ) : (
    <>
      <img
        key={reloadKey}
        className={`chat-image-preview-img ${imgLoaded ? "sq-loaded" : "sq-loading"}`}
        src={displaySrc}
        data-image-path={imagePath}
        alt={alt ?? title ?? ""}
        loading="lazy"
        decoding="async"
        style={reserveStyle}
        onLoad={(event) => {
          rememberRenderedHeight(normalizedSrc, event.currentTarget.offsetHeight);
          setImgLoaded(true);
        }}
        onError={() => setFailed(true)}
      />
      {title && (openPath || onClick) && <span className="chat-image-caption">{title}</span>}
    </>
  );
  const previewClass = `${failed ? "chat-image-fallback" : "chat-image-preview"}${className ? ` ${className}` : ""}`;

  if (!interactive) return <span className={previewClass} data-image-path={imagePath}>{image}</span>;

  return (
    <>
      <button
        type="button"
        className={`${previewClass} chat-image-preview-button`}
        data-image-path={imagePath}
        title={title ?? (language === "cn" ? "查看图片" : "Open image")}
        aria-haspopup={onClick ? undefined : "dialog"}
        onClick={() => onClick ? onClick() : setLightboxOpen(true)}
      >
        {image}
      </button>
      {lightboxOpen && (
        // Keep the portal outside the trigger so closing cannot reopen it.
        <ImageLightbox
          src={displaySrc}
          alt={alt}
          title={title}
          path={imagePath}
          loadError={failed}
          onRetry={() => { setFailed(false); setReloadKey((value) => value + 1); }}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

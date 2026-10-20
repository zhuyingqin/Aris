import { useEffect, useState } from "react";
import { fileAssetUrl, fileReadBytes, isTauri } from "./api/tauri";
import { imageMimeType } from "./imageFiles";
import ImageLightbox from "./ImageLightbox";

/** Read an image only after its reference is opened, without a workspace switch. */
export default function LocalImageLightbox({
  path,
  title,
  onClose,
}: {
  path: string;
  title?: string;
  onClose: () => void;
}) {
  const [image, setImage] = useState<{ path: string; url: string } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setFailedPath(null);
    setImage(null);
    let disposed = false;
    let objectUrl: string | null = null;
    const mimeType = imageMimeType(path);
    const source = isTauri()
      ? fileAssetUrl(path, mimeType)
      : fileReadBytes(path).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: mimeType })));
    void source.then((url) => {
      if (disposed) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url.startsWith("blob:") ? url : null;
      setImage({ path, url });
    }).catch(() => {
      if (!disposed) setFailedPath(path);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, reloadKey]);

  return <ImageLightbox src={image?.path === path ? image.url : null}
    path={path} title={title} alt={title} loadError={failedPath === path}
    onRetry={() => setReloadKey((value) => value + 1)} onClose={onClose} />;
}

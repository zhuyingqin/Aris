import { useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import ImageLightbox from "../ImageLightbox";
import LocalImageLightbox from "../LocalImageLightbox";
import { resolveWorkspaceFilePath } from "../editor/workspaceFiles";
import { isDirectImageSource } from "./ChatImagePreview";
import { normalizeImagePreviewSource } from "./imagePreviewIdentity";

/** Repeated image occurrences stay usable without loading another preview. */
export default function ChatImageReference({ src, label }: { src: string; label?: string }) {
  const language = useStore((state) => state.language);
  const projectPath = useStore((state) => state.currentProject?.path ?? null);
  const [opened, setOpened] = useState<{ source: string; path?: string } | null>(null);
  const source = normalizeImagePreviewSource(src);
  const direct = isDirectImageSource(source);
  const fileName = source.split("/").pop();
  const name = label || (direct ? "" : fileName);
  return (
    <>
      <button type="button" className="chat-image-reference" title={name || undefined}
        onClick={() => setOpened({ source, path: direct ? undefined : resolveWorkspaceFilePath(source, projectPath) })}>
        <SvgIcon name="image" size={13} /><span>{language === "cn" ? "查看图片" : "View image"}{name ? ` · ${name}` : ""}</span>
      </button>
      {opened?.path ? <LocalImageLightbox key={opened.path} path={opened.path} title={name}
        onClose={() => setOpened(null)} /> : opened && <ImageLightbox src={opened.source}
          title={name} alt={name} onClose={() => setOpened(null)} />}
    </>
  );
}

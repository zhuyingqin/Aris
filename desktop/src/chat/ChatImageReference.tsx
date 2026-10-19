import { useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import LocalImageLightbox from "../LocalImageLightbox";
import { resolveWorkspaceFilePath } from "../editor/workspaceFiles";
import { isDirectImageSource } from "./ChatImagePreview";
import { normalizeImagePreviewSource } from "./imagePreviewIdentity";

/** Repeated image occurrences stay usable without loading another preview. */
export default function ChatImageReference({ src, label }: { src: string; label?: string }) {
  const language = useStore((state) => state.language);
  const projectPath = useStore((state) => state.currentProject?.path ?? null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const source = normalizeImagePreviewSource(src);
  const fileName = source.split("/").pop();
  const name = label || (isDirectImageSource(source) ? "" : fileName);
  const content = <><SvgIcon name="image" size={13} /><span>{language === "cn" ? "查看图片" : "View image"}{name ? ` · ${name}` : ""}</span></>;
  return isDirectImageSource(source) ? (
    <a className="chat-image-reference" href={source} target="_blank" rel="noreferrer" title={source}>{content}</a>
  ) : (
    <>
      <button type="button" className="chat-image-reference" title={source}
        onClick={() => setOpenPath(resolveWorkspaceFilePath(source, projectPath))}>{content}</button>
      {openPath && <LocalImageLightbox key={openPath} path={openPath} title={name}
        onClose={() => setOpenPath(null)} />}
    </>
  );
}

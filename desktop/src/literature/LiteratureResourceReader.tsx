import { useEffect, useState } from "react";
import {
  literatureAttachmentOpen,
  literatureAttachmentOpenExternal,
  literatureAttachmentReadExternalText,
  literatureAttachmentReadText,
  literatureIndexAttachmentText,
  isTauri,
} from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";

export default function LiteratureResourceReader({
  relativePath,
  externalPath,
  recordId,
  attachmentId,
  label,
}: {
  relativePath?: string;
  externalPath?: string;
  recordId?: string;
  attachmentId?: string;
  label: string;
}) {
  const copy = LITERATURE_COPY[useStore((state) => state.language)];
  const [content, setContent] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState(label);
  const [mimeType, setMimeType] = useState("text/plain");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    const localPath = relativePath?.trim() ?? "";
    const linkedPath = externalPath?.trim() ?? "";
    if (!localPath && !linkedPath) {
      setError(copy.reader.resourceMissing);
      return () => { cancelled = true; };
    }
    if (!isTauri()) {
      setError(copy.reader.desktopOnly);
      return () => { cancelled = true; };
    }
    const read = localPath
      ? literatureAttachmentReadText(localPath)
      : literatureAttachmentReadExternalText(linkedPath);
    void read
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setSourceName(result.sourceName || label);
        setMimeType(result.mimeType || "text/plain");
        if (recordId && attachmentId) {
          void literatureIndexAttachmentText(recordId, attachmentId, result.content).catch(() => undefined);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(copy.reader.loadFailed(String(reason)));
      });
    return () => { cancelled = true; };
  }, [attachmentId, copy.reader, externalPath, label, recordId, relativePath]);

  const html = mimeType.includes("html") || /\.(html?|xhtml|epub)$/i.test(sourceName);
  const canOpenSource = Boolean(relativePath?.trim() || externalPath?.trim());
  const openSource = () => {
    if (externalPath) {
      void literatureAttachmentOpenExternal(externalPath).catch(() => undefined);
    } else if (relativePath) {
      void literatureAttachmentOpen(relativePath).catch(() => undefined);
    }
  };
  return (
    <div className="lit-resource-reader">
      <div className="lit-resource-reader-bar">
        <div>
          <strong>{label}</strong>
          <small>{sourceName}</small>
        </div>
        {canOpenSource && (
          <button type="button" onClick={() => {
            openSource();
          }}>
            <SvgIcon name="externalLink" size={13} />{copy.reader.openExternal}
          </button>
        )}
      </div>
      {error ? (
        <div className="lit-resource-reader-empty" role="alert">
          <p>{error}</p>
          {canOpenSource && <button type="button" onClick={openSource}>{copy.reader.openExternal}</button>}
        </div>
      ) : content === null ? (
        <div className="lit-resource-reader-empty" role="status">
          <span className="lit-search-spinner" aria-hidden="true" />{copy.reader.loading}
        </div>
      ) : html ? (
        <iframe
          className="lit-resource-reader-frame"
          title={label}
          sandbox=""
          srcDoc={content}
        />
      ) : (
        <pre className="lit-resource-reader-text">{content}</pre>
      )}
    </div>
  );
}

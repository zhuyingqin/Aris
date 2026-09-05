// File-type glyph shared by the explorer, the start page and the toolbar.
import { extension } from "./latexText";
import { TYPESET_IMAGE_EXTENSIONS } from "./typesetPaths";

export function FileIcon({ path, dir }: { path: string; dir?: boolean }) {
  const ext = extension(path);
  return (
    <svg className={`typeset-file-icon ${dir ? "folder" : ext.slice(1) || "file"}`} viewBox="0 0 16 16" aria-hidden="true">
      {dir ? (
        <path d="M2 4.2h4l1.1 1.4H14v6.9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      ) : ext === ".pdf" ? (
        <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12M5.8 9.5h4.4M5.8 11.4h2.7" />
      ) : ext === ".tex" ? (
        <path d="M3.8 2.5h8.4v11H3.8zM5.8 5.7h4.4M8 5.7v5M6 10.7h4" />
      ) : ext === ".bib" ? (
        <path d="M3.5 2.5h7.2L13 4.8v8.7H3.5zM10.7 2.5v2.3H13M5.5 7h5M5.5 9.2h5M5.5 11.4h3" />
      ) : TYPESET_IMAGE_EXTENSIONS.has(ext) ? (
        <path d="M2.8 3.1h10.4v9.8H2.8zM4.4 11l2.4-2.7 1.8 1.9 1.2-1.3 1.8 2.1M5.3 5.7h.1" />
      ) : (
        <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />
      )}
    </svg>
  );
}

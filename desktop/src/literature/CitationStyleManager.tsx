import { useState } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import type { LiteratureLibraryCreator, LiteraturePaper } from "./literatureTypes";
import {
  formatBibliography,
  formatCitation,
  importCslStyle,
  readCitationStyle,
  readCitationStyles,
  removeCslStyle,
  writeCitationStyle,
  type CitationStyleId,
} from "./citationEngine";

const copyText = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

export default function CitationStyleManager({
  paper,
  creators,
}: {
  paper: LiteraturePaper;
  creators?: LiteratureLibraryCreator[];
}) {
  const copy = LITERATURE_COPY[useStore((state) => state.language)];
  const [styles, setStyles] = useState(() => readCitationStyles());
  const [style, setStyle] = useState<CitationStyleId>(() => readCitationStyle());
  const [copied, setCopied] = useState<"citation" | "bibliography" | null>(null);
  const citation = formatCitation(paper, style, 1, creators);
  const bibliography = formatBibliography(paper, style, 1, creators);
  const customStyles = styles.filter((candidate) => candidate.source === "csl");

  const copyValue = async (kind: "citation" | "bibliography", value: string) => {
    try {
      await copyText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1400);
    } catch {
      setCopied(null);
    }
  };

  const importStyleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const imported = importCslStyle(await file.text());
      if (!imported) {
        window.alert(copy.citation.invalidStyle);
        return;
      }
      const nextStyles = readCitationStyles();
      setStyles(nextStyles);
      setStyle(imported.id);
      writeCitationStyle(imported.id);
    } catch {
      window.alert(copy.citation.invalidStyle);
    }
  };

  return (
    <div className="lit-citation-manager">
      <div className="lit-citation-manager-head">
        <span>{copy.citation.heading}</span>
        <label>
          <span className="sr-only">{copy.citation.styleLabel}</span>
          <select
            value={style}
            aria-label={copy.citation.styleLabel}
            onChange={(event) => {
              const next = event.target.value as CitationStyleId;
              setStyle(next);
              writeCitationStyle(next);
            }}
          >
            {styles.map((option) => (
              <option value={option.id} key={option.id}>
                {option.source === "csl" ? copy.citation.customPrefix + option.name : option.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="lit-citation-style-tools">
        <label className="lit-citation-import">
          <span>{copy.citation.importStyle}</span>
          <input
            type="file"
            accept=".csl,.xml,application/xml,text/xml"
            onChange={(event) => {
              void importStyleFile(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {customStyles.map((customStyle) => (
          <button
            key={customStyle.id}
            type="button"
            className="lit-citation-remove"
            onClick={() => {
              if (!window.confirm(copy.citation.removeStyleConfirm(customStyle.name))) return;
              removeCslStyle(customStyle.id);
              const nextStyles = readCitationStyles();
              setStyles(nextStyles);
              if (style === customStyle.id) {
                setStyle("apa7");
                writeCitationStyle("apa7");
              }
            }}
          >
            {copy.citation.removeStyle}: {customStyle.name}
          </button>
        ))}
      </div>
      <div className="lit-citation-block">
        <span>{copy.citation.inText}</span>
        <code>{citation}</code>
        <button type="button" onClick={() => void copyValue("citation", citation)} title={copy.citation.copyCitation}>
          <SvgIcon name="copy" size={13} />{copied === "citation" ? copy.citation.copied : copy.citation.copyCitation}
        </button>
      </div>
      <div className="lit-citation-block">
        <span>{copy.citation.bibliography}</span>
        <p>{bibliography}</p>
        <button type="button" onClick={() => void copyValue("bibliography", bibliography)} title={copy.citation.copyBibliography}>
          <SvgIcon name="copy" size={13} />{copied === "bibliography" ? copy.citation.copied : copy.citation.copyBibliography}
        </button>
      </div>
    </div>
  );
}

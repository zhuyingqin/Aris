import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, GlobeIcon } from "./icons";
import { LANGUAGES, type Lang } from "../i18n";

type Props = {
  currentLang: Lang;
  onSelectLang: (lang: Lang) => void;
  className?: string;
};

export default function LanguageSelector({ currentLang, onSelectLang, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLang = LANGUAGES.find((l) => l.code === currentLang) ?? LANGUAGES[0];

  // Close dropdown on click outside or escape key
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`lang-selector ${className}`} ref={containerRef}>
      <button
        type="button"
        className="lang-selector-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${selectedLang.nativeLabel}`}
        title={`Language: ${selectedLang.nativeLabel}`}
      >
        <GlobeIcon width={15} height={15} />
        <span className="lang-selector-label">{selectedLang.nativeLabel}</span>
        <ChevronDownIcon width={13} height={13} className="lang-selector-chevron" />
      </button>

      {open && (
        <div className="lang-dropdown-menu" role="listbox" aria-label="Select language">
          {LANGUAGES.map((lang) => {
            const isActive = lang.code === currentLang;
            return (
              <button
                key={lang.code}
                type="button"
                className={`lang-dropdown-item ${isActive ? "is-active" : ""}`}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onSelectLang(lang.code);
                  setOpen(false);
                }}
              >
                <div className="lang-dropdown-item-left">
                  <span className="lang-selector-flag">{lang.flag}</span>
                  <span>{lang.nativeLabel}</span>
                </div>
                {isActive && <CheckIcon width={14} height={14} className="lang-dropdown-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

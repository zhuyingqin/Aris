import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";

export type LiteraturePageView = "library" | "discover";

interface LiteratureViewTabsProps {
  pageView: LiteraturePageView;
  onPageViewChange: (view: LiteraturePageView) => void;
  className?: string;
}

export default function LiteratureViewTabs({
  pageView,
  onPageViewChange,
  className,
}: LiteratureViewTabsProps) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const pageViews = [
    { id: "library" as const, label: copy.tabs.library },
    { id: "discover" as const, label: copy.tabs.discover },
  ];
  return (
    <div
      className={`lit-mode-switch${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label={copy.tabs.viewSwitchAria}
    >
      {pageViews.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={pageView === item.id}
          tabIndex={pageView === item.id ? 0 : -1}
          className={`lit-mode-tab${pageView === item.id ? " active" : ""}`}
          onClick={() => onPageViewChange(item.id)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "library" : event.key === "End" ? "discover"
              : pageView === "library" ? "discover" : "library";
            onPageViewChange(next);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next === "library" ? 0 : 1]?.focus();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

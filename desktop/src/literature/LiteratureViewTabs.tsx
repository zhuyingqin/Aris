import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import { LITERATURE_COPY } from "./i18n";

export type LiteraturePageView = "library" | "discover" | "graph";

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
    { id: "library" as const, label: copy.tabs.library, icon: "library" as const },
    { id: "discover" as const, label: copy.tabs.discover, icon: "search" as const },
    { id: "graph" as const, label: copy.tabs.graph, icon: "graph" as const },
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
          className={`lit-mode-tab${pageView === item.id ? " active" : ""}`}
          onClick={() => onPageViewChange(item.id)}
        >
          <span className="lit-mode-tab-icon" aria-hidden="true"><SvgIcon name={item.icon} size={15} /></span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

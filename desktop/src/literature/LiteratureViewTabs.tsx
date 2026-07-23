export type LiteraturePageView = "library" | "discover" | "graph";

interface LiteratureViewTabsProps {
  pageView: LiteraturePageView;
  onPageViewChange: (view: LiteraturePageView) => void;
  className?: string;
}

const LITERATURE_PAGE_VIEWS = [
  { id: "library", label: "文献库", icon: "library" },
  { id: "discover", label: "检索", icon: "search" },
  { id: "graph", label: "知识图谱", icon: "graph" },
] as const;

export default function LiteratureViewTabs({
  pageView,
  onPageViewChange,
  className,
}: LiteratureViewTabsProps) {
  return (
    <div
      className={`lit-mode-switch${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label="文献视图切换"
    >
      {LITERATURE_PAGE_VIEWS.map((item) => (
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
import { SvgIcon } from "../SvgIcon";

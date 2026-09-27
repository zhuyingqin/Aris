import { useRef } from "react";
import type { DetailTab } from "./literatureTypes";

/** Text labels keep the inspector discoverable without a column of ambiguous icons. */
export default function LiteratureDetailTabs({ tabs, activeTab, label, className, onSelect }: {
  tabs: Array<{ id: DetailTab; label: string }>;
  activeTab: DetailTab;
  label: string;
  className: string;
  onSelect: (tab: DetailTab) => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const vertical = className === "lit-reader-detail-rail";
  return (
    <nav ref={navigation} className={className} role="tablist" aria-label={label} aria-orientation={vertical ? "vertical" : "horizontal"}>
      {tabs.map((tab, index) => (
        <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={`lit-workspace-tab${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const nextKey = vertical ? "ArrowDown" : "ArrowRight";
            const previousKey = vertical ? "ArrowUp" : "ArrowLeft";
            if (![nextKey, previousKey, "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
              : (index + (event.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
            onSelect(tabs[next].id);
            navigation.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
          }}>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

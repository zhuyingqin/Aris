import { useRef } from "react";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type { DetailTab } from "./literatureTypes";

/** Text labels keep the docked inspector discoverable; the narrow rail beside
 * the PDF shows icons, with the label kept as its accessible name and tooltip. */
export default function LiteratureDetailTabs({ tabs, activeTab, label, className, icons, controls, onDismiss, onSelect }: {
  tabs: Array<{ id: DetailTab; label: string }>;
  activeTab: DetailTab | null;
  label: string;
  className: string;
  icons?: Partial<Record<DetailTab, SvgIconName>>;
  controls?: Partial<Record<DetailTab, string>>;
  onDismiss?: () => void;
  onSelect: (tab: DetailTab, options?: { toggle: boolean }) => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const vertical = className === "lit-reader-detail-rail";
  return (
    <nav ref={navigation} className={className} role="tablist" aria-label={label} aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onDismiss) {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}>
      {tabs.map((tab, index) => (
        <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
          id={`${className}-${tab.id}`}
          data-detail-tab={tab.id}
          aria-controls={controls?.[tab.id]}
          tabIndex={activeTab === tab.id || (activeTab === null && index === 0) ? 0 : -1}
          aria-label={icons?.[tab.id] ? tab.label : undefined}
          title={icons?.[tab.id] ? tab.label : undefined}
          className={`lit-workspace-tab${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onSelect(tab.id, { toggle: true })}
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
          {icons?.[tab.id] ? <SvgIcon name={icons[tab.id]!} size={17} /> : tab.label}
        </button>
      ))}
    </nav>
  );
}

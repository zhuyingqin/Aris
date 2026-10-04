import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Tab } from "./store";
import { SvgIcon } from "./SvgIcon";

export interface AppNavigationItem {
  id: Tab;
  label: string;
  icon: ReactNode;
}

interface Props {
  label: string;
  moreLabel: string;
  items: AppNavigationItem[];
  moreItems: AppNavigationItem[];
  activeTab: Tab;
  update?: ReactNode;
  account: ReactNode;
  onSelect: (tab: Tab) => void;
  onPreload: (tab: Tab) => void;
}

export default function AppNavigationRail({ label, moreLabel, items, moreItems, activeTab, update, account, onSelect, onPreload }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreActive = moreItems.some((item) => item.id === activeTab);

  const closeAndFocus = () => {
    setMoreOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => setMoreOpen(false), [activeTab]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeAndFocus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (!moreOpen) return;
    const positionMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!trigger || !menu) return;
      setMenuPosition({
        top: Math.max(8, Math.min(trigger.top, window.innerHeight - menu.height - 8)),
        left: Math.max(8, Math.min(trigger.right + 8, window.innerWidth - menu.width - 8)),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    (menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? menuRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    return () => window.removeEventListener("resize", positionMenu);
  }, [moreOpen, moreItems.length]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? buttons.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <nav className="app-navigation-rail" aria-label={label}>
      <div className="app-rail-primary" data-onboarding-target="module-navigation">
        {items.map((item) => (
          <button
            key={item.id}
            className={`app-rail-button${activeTab === item.id ? " active" : ""}`}
            type="button"
            aria-label={item.label}
            aria-current={activeTab === item.id ? "page" : undefined}
            data-onboarding-target={`nav-${item.id}`}
            onPointerEnter={() => onPreload(item.id)}
            onFocus={() => onPreload(item.id)}
            onClick={() => { setMoreOpen(false); onSelect(item.id); }}
          >
            <span className="app-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="app-rail-tooltip" aria-hidden="true">{item.label}</span>
          </button>
        ))}
        {moreItems.length > 0 && (
          <div className="app-rail-more" ref={moreRef}>
            <button
              ref={triggerRef}
              className={`app-rail-button${moreActive ? " active" : ""}`}
              type="button"
              aria-label={moreLabel}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls="app-rail-more-menu"
              onClick={() => setMoreOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMoreOpen(true); }
              }}
            >
              <SvgIcon name="moreHorizontal" size={20} />
              <span className="app-rail-tooltip" aria-hidden="true">{moreLabel}</span>
            </button>
            {moreOpen && (
              <div ref={menuRef} id="app-rail-more-menu" className="app-rail-more-menu" role="menu" aria-label={moreLabel} style={menuPosition} onKeyDown={onMenuKeyDown}>
                {moreItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeTab === item.id}
                    data-onboarding-target={item.id === "settings" ? "user-settings" : `nav-${item.id}`}
                    onPointerEnter={() => onPreload(item.id)}
                    onFocus={() => onPreload(item.id)}
                    onClick={() => { closeAndFocus(); onSelect(item.id); }}
                  >
                    <span className="app-rail-menu-icon" aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                    {activeTab === item.id && <SvgIcon name="check" size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="app-rail-footer">
        {update}
        <div className="app-rail-account">{account}</div>
      </div>
    </nav>
  );
}

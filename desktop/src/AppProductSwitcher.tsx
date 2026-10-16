import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AppNavigationItem } from "./AppNavigationRail";
import type { Tab } from "./store";
import { SvgIcon } from "./SvgIcon";

interface Props {
  label: string;
  triggerLabel: string;
  moduleName: string;
  activeTab: Tab;
  items: AppNavigationItem[];
  utilityItems: AppNavigationItem[];
  onOpen: () => void;
  onSelect: (tab: Tab) => void;
  onPreload: (tab: Tab) => void;
}

export default function AppProductSwitcher({ label, triggerLabel, moduleName, activeTab, items, utilityItems, onOpen, onSelect, onPreload }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const openMenu = () => {
    onOpen();
    setOpen(true);
  };

  useEffect(() => setOpen(false), [activeTab]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
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
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    (menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? menuRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) return;
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

  const renderItem = (item: AppNavigationItem, secondary = false) => (
    <button
      key={item.id}
      className={`product-menu-item${secondary ? " secondary" : ""}${activeTab === item.id ? " active" : ""}`}
      type="button"
      role="menuitemradio"
      aria-checked={activeTab === item.id}
      data-onboarding-target={`nav-${item.id}`}
      onPointerEnter={() => onPreload(item.id)}
      onFocus={() => onPreload(item.id)}
      onClick={() => { closeAndFocus(); onSelect(item.id); }}
    >
      <span className="product-menu-icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
      <span className="product-menu-check" aria-hidden="true">
        {activeTab === item.id && <SvgIcon name="check" size={14} />}
      </span>
    </button>
  );

  return (
    <div className="product-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className="product-switcher-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="app-product-menu"
        aria-label={triggerLabel}
        data-onboarding-target="product-switcher"
        onClick={() => { if (open) setOpen(false); else openMenu(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(); }
        }}
      >
        <span className="product-switcher-name">SomniQ</span>
        <span className="product-switcher-module">{moduleName}</span>
        <span className="product-switcher-caret" aria-hidden="true"><SvgIcon name="chevronDown" size={13} /></span>
      </button>
      {open && (
        <div id="app-product-menu" ref={menuRef} className="product-menu" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          <div className="product-menu-label">SomniQ</div>
          {items.map((item) => renderItem(item))}
          {utilityItems.length > 0 && <div className="product-menu-divider" role="separator" />}
          {utilityItems.map((item) => renderItem(item, true))}
        </div>
      )}
    </div>
  );
}

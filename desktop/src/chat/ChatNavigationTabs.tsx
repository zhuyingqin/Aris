import { useEffect, useRef, useState, type ReactNode } from "react";
import { SvgIcon } from "../SvgIcon";

export interface ChatNavigationTab {
  id: string;
  label: string;
  /** Tooltip text; falls back to the label. Useful for file tabs, whose label is truncated. */
  title?: string;
  icon?: ReactNode;
  closable?: boolean;
  closeLabel?: string;
}

export interface ChatNavigationAddOption {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface Props {
  tabs: ChatNavigationTab[];
  activeTabId: string;
  label: string;
  addLabel: string;
  /** When present, "+" opens a menu instead of immediately running `onAdd`. */
  addOptions?: ChatNavigationAddOption[];
  action?: {
    label: string;
    onClick: () => void;
  };
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

/**
 * Shared, data-driven task navigation. New workspace surfaces only need to add
 * a tab descriptor; the tab strip does not know how their content is rendered.
 */
export default function ChatNavigationTabs({
  tabs,
  activeTabId,
  label,
  addLabel,
  addOptions,
  action,
  onSelect,
  onClose,
  onAdd,
}: Props) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addMenuOpen]);

  return (
    <nav className="chat-navigation" aria-label={label}>
      <div className="chat-navigation-list" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div key={tab.id} className={`chat-navigation-item${active ? " active" : ""}`} role="presentation">
              <button
                type="button"
                className="chat-navigation-tab"
                role="tab"
                aria-selected={active}
                aria-controls={`chat-workspace-${tab.id}`}
                tabIndex={active ? 0 : -1}
                title={tab.title ?? tab.label}
                onClick={() => onSelect(tab.id)}
              >
                {tab.icon && <span className="chat-navigation-icon" aria-hidden="true">{tab.icon}</span>}
                <span className="chat-navigation-label">{tab.label}</span>
              </button>
              {tab.closable && (
                <button
                  type="button"
                  className="chat-navigation-close"
                  aria-label={tab.closeLabel}
                  onClick={() => onClose(tab.id)}
                >
                  <SvgIcon name="close" size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="chat-navigation-add-wrap" ref={addRef}>
        <button
          type="button"
          className={`chat-navigation-add${addMenuOpen ? " active" : ""}`}
          aria-label={addLabel}
          title={addLabel}
          aria-haspopup={addOptions?.length ? "menu" : undefined}
          aria-expanded={addOptions?.length ? addMenuOpen : undefined}
          onClick={() => {
            if (addOptions?.length) setAddMenuOpen((open) => !open);
            else onAdd();
          }}
        >
          <SvgIcon name="plus" size={15} />
        </button>
        {addMenuOpen && addOptions?.length ? (
          <div className="chat-navigation-add-menu" role="menu" aria-label={addLabel}>
            {addOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAddMenuOpen(false);
                  option.onSelect();
                }}
              >
                {option.icon && <span className="chat-navigation-add-icon" aria-hidden="true">{option.icon}</span>}
                <span className="chat-navigation-add-text">
                  <span className="chat-navigation-add-label">{option.label}</span>
                  {option.hint && <span className="chat-navigation-add-hint">{option.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {action && (
        <button type="button" className="chat-navigation-action" onClick={action.onClick}>
          <SvgIcon name="send" size={12} />
          {action.label}
        </button>
      )}
    </nav>
  );
}

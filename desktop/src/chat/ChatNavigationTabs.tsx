import type { ReactNode } from "react";
import { SvgIcon } from "../SvgIcon";

export interface ChatNavigationTab {
  id: string;
  label: string;
  icon?: ReactNode;
  closable?: boolean;
  closeLabel?: string;
}

interface Props {
  tabs: ChatNavigationTab[];
  activeTabId: string;
  label: string;
  addLabel: string;
  hideLabel: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  onHide: () => void;
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
  hideLabel,
  action,
  onSelect,
  onClose,
  onAdd,
  onHide,
}: Props) {
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
                title={tab.label}
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
      <button type="button" className="chat-navigation-add" aria-label={addLabel} title={addLabel} onClick={onAdd}>
        <SvgIcon name="plus" size={15} />
      </button>
      {action && (
        <button type="button" className="chat-navigation-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <button type="button" className="chat-navigation-hide" aria-label={hideLabel} title={hideLabel} onClick={onHide}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <path d="M14.5 4v16" />
        </svg>
      </button>
    </nav>
  );
}

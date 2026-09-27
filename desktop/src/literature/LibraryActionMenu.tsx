import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SvgIcon, type SvgIconName } from "../SvgIcon";

export interface LibraryMenuAction {
  id: string;
  label: string;
  icon?: SvgIconName;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** One menu interaction for adding, organizing and batch operations. */
export default function LibraryActionMenu({
  label, actions, icon = "moreHorizontal", showLabel = false, primary = false,
}: {
  label: string;
  actions: LibraryMenuAction[];
  icon?: SvgIconName;
  showLabel?: boolean;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: anchor.bottom + bounds.height + 8 <= window.innerHeight
        ? anchor.bottom + 6
        : Math.max(8, anchor.top - bounds.height - 6),
    });
    const buttons = menu.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    buttons[focusLast.current ? buttons.length - 1 : 0]?.focus();
    focusLast.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const reposition = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`lit-menu-trigger${showLabel ? " with-label" : ""}${primary ? " primary" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusLast.current = event.key === "ArrowUp";
            setOpen(true);
          }
        }}
      >
        <SvgIcon name={icon} size={16} />
        {showLabel && <><span>{label}</span><SvgIcon name="chevronDown" size={12} /></>}
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className="lit-action-menu"
          style={position}
          onKeyDown={(event) => {
            const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Tab") close(true);
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={action.danger ? "danger" : undefined}
              disabled={action.disabled}
              onClick={() => { close(true); action.onSelect(); }}
            >
              {action.icon && <SvgIcon name={action.icon} size={16} />}
              <span><strong>{action.label}</strong>{action.description && <small>{action.description}</small>}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

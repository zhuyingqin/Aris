import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
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

/** Where a menu opens: below `bottom`, or above `top` when it would not fit. */
export interface LibraryMenuAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** The portalled menu shared by button menus and context menus: arrow keys,
 * Home/End, Escape and Tab, and closing on outside pointer, scroll or resize. */
export function LibraryMenuPopup({
  id, label, actions, anchor, focusLast = false, ignore, onClose,
}: {
  id?: string;
  label: string;
  actions: LibraryMenuAction[];
  anchor: LibraryMenuAnchor;
  focusLast?: boolean;
  /** An element whose pointer events do not count as outside (the trigger). */
  ignore?: RefObject<HTMLElement>;
  /** `restoreFocus` is true when the menu was left with the keyboard or an
   * action ran, so focus should return to where the menu came from. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom });
  // Items without an icon keep their text aligned with those that have one.
  const reserveIcon = actions.some((action) => action.icon);
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: anchor.bottom + bounds.height + 8 <= window.innerHeight
        ? anchor.bottom
        : Math.max(8, anchor.top - bounds.height),
    });
    const buttons = menu.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    buttons[focusLast ? buttons.length - 1 : 0]?.focus();
  }, [anchor.bottom, anchor.left, anchor.top, focusLast]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !ignore?.current?.contains(target)) close.current(false);
    };
    const dismiss = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close.current(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [ignore]);

  return createPortal(
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      className="lit-action-menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
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
          close.current(true);
        } else if (event.key === "Tab") close.current(true);
      }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={action.danger ? "danger" : undefined}
          disabled={action.disabled}
          onClick={() => { close.current(true); action.onSelect(); }}
        >
          {action.icon
            ? <SvgIcon name={action.icon} size={16} />
            : reserveIcon && <span className="lit-action-menu-icon-space" aria-hidden="true" />}
          <span><strong>{action.label}</strong>{action.description && <small>{action.description}</small>}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
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
  const [open, setOpen] = useState<{ anchor: LibraryMenuAnchor; focusLast: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const show = (focusLast: boolean) => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setOpen({ anchor: { left: rect.left, top: rect.top - 6, bottom: rect.bottom + 6 }, focusLast });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`lit-menu-trigger${showLabel ? " with-label" : ""}${primary ? " primary" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(null) : show(false))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp");
          }
        }}
      >
        <SvgIcon name={icon} size={16} />
        {showLabel && <><span>{label}</span><SvgIcon name="chevronDown" size={12} /></>}
      </button>
      {open && (
        <LibraryMenuPopup
          id={id}
          label={label}
          actions={actions}
          anchor={open.anchor}
          focusLast={open.focusLast}
          ignore={trigger}
          onClose={(restoreFocus) => {
            setOpen(null);
            if (restoreFocus) trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

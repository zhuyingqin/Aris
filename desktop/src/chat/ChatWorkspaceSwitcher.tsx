import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ComputePeer } from "../types";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";

interface Props {
  language: Language;
  visible: boolean;
  workspaceName: string;
  workspaceDescription: string;
  selectedNodeId: string | null;
  peers: ComputePeer[];
  busy: boolean;
  onLoad?: () => void;
  onSelect?: (nodeId: string | null) => void;
}

export default function ChatWorkspaceSwitcher({ language, visible, workspaceName, workspaceDescription, selectedNodeId, peers, busy, onLoad, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const remoteMode = selectedNodeId !== null;
  const selectedPeer = peers.find((peer) => peer.nodeId === selectedNodeId);
  const label = language === "cn" ? "切换本机或远程电脑" : "Switch local or remote computer";

  // Chat owns the selected computer, while the shell owns the title row.
  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("app-chat-workspace-portal"));
  }, []);

  useEffect(() => setOpen(false), [visible, selectedNodeId]);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const openMenu = () => {
    onLoad?.();
    setOpen(true);
  };

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
    const positionMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!trigger || !menu) return;
      setMenuPosition({
        top: Math.max(8, Math.min(trigger.bottom + 6, window.innerHeight - menu.height - 8)),
        left: Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8)),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    (menuRef.current?.querySelector<HTMLButtonElement>(".active:not(:disabled)")
      ?? menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    return () => window.removeEventListener("resize", positionMenu);
  }, [open, peers.length]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
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

  if (!visible) return null;

  const picker = (
    <div className="chat-workspace-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`chat-workspace-trigger${remoteMode ? " is-remote" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="chat-workspace-menu"
        aria-label={label}
        title={`${workspaceName} · ${workspaceDescription}`}
        onClick={() => { if (open) setOpen(false); else openMenu(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(); }
        }}
      >
        <span className="chat-workspace-icon" aria-hidden="true">
          <SvgIcon name={remoteMode ? "collection" : "desktop"} size={17} />
        </span>
        {remoteMode && (
          <span
            className={`chat-workspace-connection${selectedPeer?.connected ? " is-online" : " is-connecting"}`}
            title={selectedPeer?.connected
              ? (language === "cn" ? "在线" : "Online")
              : (language === "cn" ? "正在自动连接" : "Reconnecting automatically")}
          />
        )}
      </button>
      {open && (
        <div id="chat-workspace-menu" ref={menuRef} className="chat-workspace-menu" role="menu" aria-label={label} style={menuPosition} onKeyDown={onMenuKeyDown}>
          <div className="chat-workspace-menu-label">{language === "cn" ? "运行位置" : "Run on"}</div>
          <button
            className={`chat-workspace-option${!remoteMode ? " active" : ""}`}
            type="button"
            role="menuitem"
            onClick={() => { onSelect?.(null); closeAndFocus(); }}
          >
            <span className="chat-workspace-option-icon"><SvgIcon name="desktop" size={14} /></span>
            <span><strong>{language === "cn" ? "本机" : "This computer"}</strong><small>{language === "cn" ? "本机项目、模型与工具" : "Local projects, models, and tools"}</small></span>
            {!remoteMode && <SvgIcon name="check" size={13} />}
          </button>
          {peers.map((peer) => (
            <button
              key={peer.nodeId}
              className={`chat-workspace-option${selectedNodeId === peer.nodeId ? " active" : ""}${!peer.connected ? " is-connecting" : ""}`}
              type="button"
              role="menuitem"
              disabled={!peer.agentChatAuthorized}
              onClick={() => { onSelect?.(peer.nodeId); closeAndFocus(); }}
            >
              <span className="chat-workspace-option-icon"><SvgIcon name="collection" size={14} /></span>
              <span>
                <strong>{peer.displayName}</strong>
                <small>
                  {!peer.agentChatAuthorized
                    ? (language === "cn" ? "需重新配对以启用 Agent" : "Re-pair to enable Agent")
                    : peer.connected
                      ? (language === "cn" ? "在线 · 远程项目" : "Online · Remote projects")
                      : (language === "cn" ? "正在自动连接，可先进入等待" : "Reconnecting automatically · Open to wait")}
                </small>
              </span>
              {selectedNodeId === peer.nodeId && <SvgIcon name="check" size={13} />}
            </button>
          ))}
          {peers.length === 0 && (
            <div className="chat-workspace-empty">
              {busy
                ? (language === "cn" ? "正在查找已配对电脑…" : "Looking for paired computers…")
                : (language === "cn" ? "没有可用的远程电脑" : "No remote computers available")}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return headerSlot ? createPortal(picker, headerSlot) : picker;
}

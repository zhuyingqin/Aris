import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isTauri,
  onChatCompanionHandoff,
  takeChatCompanionHandoff,
} from "../api/tauri";
import { useStore } from "../store";
import { requestWindowAction } from "../windowControls";
import Chat from "./Chat";

const CHAT_COMPANION_QUERY = "companion";
const CHAT_COMPANION_VALUE = "chat";
const CHAT_COMPANION_LABEL = "chat-companion";
const CHAT_COMPANION_DENSITY_KEY = "somniq-chat-companion-density";

export function isChatCompanionMode(search?: string, windowLabel?: string): boolean {
  const label = windowLabel ?? (isTauri() ? getCurrentWindow().label : "");
  if (label === CHAT_COMPANION_LABEL) return true;
  const value = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(value).get(CHAT_COMPANION_QUERY) === CHAT_COMPANION_VALUE;
}

export default function ChatCompanion() {
  const init = useStore((state) => state.init);
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const setPendingChatHandoff = useStore((state) => state.setPendingChatHandoff);
  const [pinned, setPinned] = useState(true);
  const [compact, setCompact] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(CHAT_COMPANION_DENSITY_KEY) !== "comfortable";
    } catch {
      return true;
    }
  });
  const copy = language === "cn"
    ? {
        title: "论文伴写",
        subtitle: currentProject?.name ?? "SomniQ Chat",
        pin: pinned ? "取消置顶" : "保持置顶",
        minimize: "最小化悬浮窗",
        maximize: "最大化或还原悬浮窗",
        close: "关闭悬浮窗",
      }
    : {
        title: "Writing companion",
        subtitle: currentProject?.name ?? "SomniQ Chat",
        pin: pinned ? "Turn off always on top" : "Keep always on top",
        minimize: "Minimize companion",
        maximize: "Maximize or restore companion",
        close: "Close companion",
      };
  const densityLabel = language === "cn"
    ? (compact ? "切换到舒展排版" : "切换到紧凑排版")
    : (compact ? "Use comfortable spacing" : "Use compact spacing");

  useEffect(() => init(), [init]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const acceptHandoff = (handoff: Parameters<typeof setPendingChatHandoff>[0]) => {
      if (!disposed && handoff) setPendingChatHandoff(handoff);
    };

    // A newly created native window cannot subscribe before the main window
    // asks Tauri to show it, so it claims the queued handoff once on mount.
    void takeChatCompanionHandoff().then(acceptHandoff).catch(() => undefined);
    void onChatCompanionHandoff(acceptHandoff).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setPendingChatHandoff]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHAT_COMPANION_DENSITY_KEY,
        compact ? "compact" : "comfortable",
      );
    } catch {
      // A locked-down WebView can deny storage without making Chat unusable.
    }
  }, [compact]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = language === "cn" ? "论文伴写 · SomniQ" : "Writing companion · SomniQ";
    document.body.classList.add("chat-companion-window");
    return () => {
      document.title = previousTitle;
      document.body.classList.remove("chat-companion-window");
    };
  }, [language]);

  useEffect(() => {
    if (!isTauri()) return;
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void currentWindow.onCloseRequested((event) => {
      event.preventDefault();
      void currentWindow.hide();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const togglePinned = async () => {
    const next = !pinned;
    if (isTauri()) {
      try {
        await getCurrentWindow().setAlwaysOnTop(next);
      } catch {
        return;
      }
    }
    setPinned(next);
  };

  const hideCompanion = () => {
    if (isTauri()) void getCurrentWindow().hide();
  };

  return (
    <div className={`chat-companion-root${compact ? " is-compact" : ""}`}>
      <header className="chat-companion-titlebar">
        <div className="chat-companion-brand" data-tauri-drag-region>
          <span className="chat-companion-mark" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3.5h12v8H9.8L7 14v-2.5H3z" />
              <path d="M6 6.5h6M6 8.8h4" />
            </svg>
          </span>
          <span className="chat-companion-titles" data-tauri-drag-region>
            <strong data-tauri-drag-region>{copy.title}</strong>
            <small data-tauri-drag-region>{copy.subtitle}</small>
          </span>
        </div>
        <div className="chat-companion-window-actions">
          <button
            type="button"
            className={compact ? "density active" : "density"}
            aria-label={densityLabel}
            title={densityLabel}
            aria-pressed={compact}
            onClick={() => setCompact((value) => !value)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden="true">
              <path d="M3 4h10M3 8h10M3 12h10" />
              <path d="M5 2.6v2.8M11 6.6v2.8M6 10.6v2.8" />
            </svg>
          </button>
          <button type="button" className={pinned ? "active" : ""} aria-label={copy.pin} title={copy.pin} aria-pressed={pinned} onClick={() => void togglePinned()}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5.2 2.5 5.6 5.6M9.8 3.3l2.9 2.9-2 1.2-2.3 3.7-3.5-3.5 3.7-2.3zM6.1 9.9 3 13" />
            </svg>
          </button>
          <button type="button" aria-label={copy.minimize} title={copy.minimize} onClick={() => requestWindowAction("minimize")}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 11.5h10" /></svg>
          </button>
          <button type="button" aria-label={copy.maximize} title={copy.maximize} onClick={() => requestWindowAction("maximize")}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3.25" y="3.25" width="9.5" height="9.5" /></svg>
          </button>
          <button type="button" className="close" aria-label={copy.close} title={copy.close} onClick={hideCompanion}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </header>
      <div className="chat-companion-content">
        <Chat />
      </div>
    </div>
  );
}

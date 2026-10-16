// Receives finished region screenshots in the primary window and parks them in
// the store for the chat composer. Mounted once by `App`, because the hotkey
// fires from anywhere — including while a non-Chat tab is open.

import { useEffect } from "react";
import { isTauri, onScreenshotAttachment } from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment } from "../types";

export function usePendingScreenshot(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void onScreenshotAttachment((event) => {
      if (disposed) return;
      const attachment: ChatAttachment = {
        id: `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: "image",
        name: event.name,
        path: event.path,
        mimeType: "image/png",
        // The overlay already has the crop in memory, so it ships the data URL
        // alongside the staged path: the thumbnail paints immediately instead
        // of waiting on a round trip through the asset protocol. Large crops
        // arrive without one and fall back to reading the staged file.
        preview: event.preview ?? undefined,
      };
      const state = useStore.getState();
      state.addPendingChatAttachment(attachment);
      state.setTab("chat");
    }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true; stop?.();
    };
  }, []);
}

// Receives finished region screenshots in the primary window and parks them in
// the store for the chat composer. Mounted once by `App`, because the hotkey
// fires from anywhere — including while a non-Chat tab is open.

import { useEffect } from "react";
import { onScreenshotAttachment } from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment } from "../types";

export function usePendingScreenshot(): void {
  useEffect(() => {
    const unlisten = onScreenshotAttachment((event) => {
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
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}

// Entry point for the screenshot windows: the per-monitor selection overlays
// and the crops pinned to the desktop afterwards.
//
// Deliberately separate from `main.tsx`: these windows have to paint an image
// as fast as WebView2 can boot. Sharing the workspace entry meant every one of
// them parsed and evaluated the whole SomniQ bundle (2.2 MB of JavaScript and
// 484 KB of CSS) before `Root` even got to decide what it was — which the user
// saw as a pause before the selection UI appeared. Both surfaces share this
// entry because a pin is tiny and the overlay's chunk is already loaded.

import React from "react";
import ReactDOM from "react-dom/client";
import ErrorBoundary from "../ErrorBoundary";
import ScreenshotOverlay from "./ScreenshotOverlay";
import ScreenshotPin, { isScreenshotPinMode } from "./ScreenshotPin";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isScreenshotPinMode() ? <ScreenshotPin /> : <ScreenshotOverlay />}
    </ErrorBoundary>
  </React.StrictMode>,
);

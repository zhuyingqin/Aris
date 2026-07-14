import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./api/tauri";
import ErrorBoundary from "./ErrorBoundary";
import { RemoteP2pBridge } from "./remote/RemoteP2pBridge";
import "./styles.css";

/**
 * The desktop workspace is local-first. Remote pairing is authorized by the
 * QR ceremony and the paired-device credential, so opening the desktop must
 * not depend on a separate gateway or account login.
 */
function Root() {
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <>
        {isTauri() && <RemoteP2pBridge />}
        <Root />
      </>
    </ErrorBoundary>
  </React.StrictMode>,
);

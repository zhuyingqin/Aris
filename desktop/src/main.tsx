import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Login from "./auth/Login";
import DesktopWindowCloseControl from "./DesktopWindowCloseControl";
import { isTauri } from "./api/tauri";
import ErrorBoundary from "./ErrorBoundary";
import { RemoteP2pBridge } from "./remote/RemoteP2pBridge";
import { useStore } from "./store";
import "./styles.css";

/** Browser-preview escape hatch: ?loginPreview=1 forces the sign-in screen
 * (plain browsers are always "authed", so Login is otherwise unreachable). */
function isLoginPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("loginPreview") === "1";
}

/** Gate the desktop workspace behind its NewAPI account login. */
function Root() {
  const authed = useStore((state) => state.authed);
  const validateAuth = useStore((state) => state.validateAuth);
  const [checkingAuth, setCheckingAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!authed) {
      setCheckingAuth(false);
      return () => {
        cancelled = true;
      };
    }
    setCheckingAuth(true);
    validateAuth().finally(() => {
      if (!cancelled) setCheckingAuth(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authed, validateAuth]);

  if (authed && checkingAuth) {
    return (
      <>
        <DesktopWindowCloseControl />
        <div className="auth-checking" role="status">Verifying sign-in...</div>
      </>
    );
  }

  return authed && !isLoginPreviewMode() ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <>
        {/* Remote pairing uses its own device credential, not the desktop account. */}
        {isTauri() && <RemoteP2pBridge />}
        <Root />
      </>
    </ErrorBoundary>
  </React.StrictMode>,
);

import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import LanguageChoice from "./auth/LanguageChoice";
import Login from "./auth/Login";
import ChatCompanion, { isChatCompanionMode } from "./chat/ChatCompanion";
import DesktopWindowControls from "./DesktopWindowControls";
import { isTauri } from "./api/tauri";
import ErrorBoundary from "./ErrorBoundary";
import { ImageAssistApproval } from "./remote/ImageAssistApproval";
import { RemoteP2pBridge } from "./remote/RemoteP2pBridge";
import { useStore } from "./store";
import "./styles.css";

/** Browser-preview escape hatch: ?loginPreview=1 forces the sign-in screen
 * (plain browsers are always "authed", so Login is otherwise unreachable). */
function isLoginPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("loginPreview") === "1";
}

/** Gate the primary desktop workspace behind its NewAPI account login. */
function AuthenticatedRoot() {
  const authed = useStore((state) => state.authed);
  const languagePreferenceSet = useStore((state) => state.languagePreferenceSet);
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
        <DesktopWindowControls />
        <div className="auth-checking" role="status">Verifying sign-in...</div>
      </>
    );
  }

  if (!authed || isLoginPreviewMode()) return <Login />;
  return languagePreferenceSet ? <App /> : <LanguageChoice />;
}

function Root() {
  // The companion can only be created by the already-authenticated main
  // process. Do not make every auxiliary WebView repeat a localStorage-based
  // login gate; it shares the same backend executor/session state.
  return isChatCompanionMode() ? <ChatCompanion /> : <AuthenticatedRoot />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <>
        {/* Remote pairing uses its own device credential, not the desktop account. */}
        {isTauri() && !isChatCompanionMode() && <RemoteP2pBridge />}
        {/* Mounted beside the bridge so a brokered request can never reach the
            ChatGPT account without this dialog being on screen first. */}
        {isTauri() && !isChatCompanionMode() && <ImageAssistApproval />}
        <Root />
      </>
    </ErrorBoundary>
  </React.StrictMode>,
);

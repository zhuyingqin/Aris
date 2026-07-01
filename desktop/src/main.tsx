import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Login from "./auth/Login";
import ErrorBoundary from "./ErrorBoundary";
import { useStore } from "./store";
import "./styles.css";

/** Gate the app shell behind the managed-gateway login. */
function Root() {
  const authed = useStore((s) => s.authed);
  const validateAuth = useStore((s) => s.validateAuth);
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
      <div className="auth-checking" role="status">
        Verifying sign-in...
      </div>
    );
  }

  return authed ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);

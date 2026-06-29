import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Login from "./auth/Login";
import ErrorBoundary from "./ErrorBoundary";
import { useStore } from "./store";
import "./styles.css";

/** Gate the app shell behind the managed-gateway login. */
function Root() {
  const authed = useStore((s) => s.authed);
  return authed ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);

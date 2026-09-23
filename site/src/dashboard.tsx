import React from "react";
import ReactDOM from "react-dom/client";
import DashboardApp from "./DashboardApp";
import IndependentAccountApp from "./IndependentAccountApp";
import { independentAccountsEnabled } from "./independentAccount";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {independentAccountsEnabled ? <IndependentAccountApp /> : <DashboardApp />}
  </React.StrictMode>
);

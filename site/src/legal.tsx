import React from "react";
import ReactDOM from "react-dom/client";
import LegalApp from "./LegalApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Legal page root is missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <LegalApp />
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import IndependentAccountApp from "./IndependentAccountApp";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><IndependentAccountApp initialTab="admin" /></React.StrictMode>);

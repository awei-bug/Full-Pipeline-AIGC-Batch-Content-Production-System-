import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.jsx";
import { initTheme } from "./theme.js";
import "./styles.css";

// 先落主题再渲染，避免首屏闪白
initTheme();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

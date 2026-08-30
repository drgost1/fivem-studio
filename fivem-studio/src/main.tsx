import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PopoutConsole from "./components/PopoutConsole";
import RendererErrorBoundary from "./components/RendererErrorBoundary";
import "./styles.css";

const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      {view === "console" ? <PopoutConsole /> : <App />}
    </RendererErrorBoundary>
  </React.StrictMode>,
);

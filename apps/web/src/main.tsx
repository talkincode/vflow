import { VFlowClient } from "@vflow/client";
import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  const client = new VFlowClient({ baseUrl: window.location.origin });
  createRoot(rootEl).render(
    <React.StrictMode>
      <App client={client} />
    </React.StrictMode>,
  );
}

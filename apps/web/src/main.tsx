import { VideoComposeClient } from "@video-compose/client";
import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Workbench } from "./Workbench.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  const client = new VideoComposeClient({ baseUrl: window.location.origin });
  createRoot(rootEl).render(
    <React.StrictMode>
      <Workbench
        client={client}
        projectId="demo"
        compositionId="episode-001"
      />
    </React.StrictMode>,
  );
}

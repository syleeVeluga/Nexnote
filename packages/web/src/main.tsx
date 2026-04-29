import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/use-auth.js";
import { WorkspaceProvider } from "./hooks/use-workspace.js";
import { App } from "./App.js";
import "./i18n/index.js";
import "./styles/tokens.css";
import "./styles/globals.css";
import "./styles/ui.css";
import "./styles/editor.css";
import "./styles/revisions.css";
import "./styles/graph.css";
import "./styles/review.css";
import "./styles/import.css";
import "./styles/admin.css";
import "./styles/activity.css";
import "./styles/layout.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

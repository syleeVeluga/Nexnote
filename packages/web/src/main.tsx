import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/use-auth.js";
import { WorkspaceProvider } from "./hooks/use-workspace.js";
import { App } from "./App.js";
import "./styles/globals.css";
import "./styles/editor.css";
import "./styles/revisions.css";

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

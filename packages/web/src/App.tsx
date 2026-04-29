import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/use-auth.js";
import { WorkspaceLayout } from "./components/layout/WorkspaceLayout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { WikiPage } from "./pages/WikiPage.js";
import { FolderPage } from "./pages/FolderPage.js";
import { PageEditorPage } from "./pages/PageEditorPage.js";
import { NewPagePage } from "./pages/NewPagePage.js";
import { ReviewQueuePage } from "./pages/ReviewQueuePage.js";
import { ActivityPage } from "./pages/ActivityPage.js";
import { IngestionDetailPage } from "./pages/IngestionDetailPage.js";
import { ImportPage } from "./pages/ImportPage.js";
import { QueueHealthPage } from "./pages/QueueHealthPage.js";
import { TrashPage } from "./pages/TrashPage.js";
import { PublicDocPage } from "./pages/PublicDocPage.js";
import { PublicDocListPage } from "./pages/PublicDocListPage.js";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="app-loading">Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function GuestOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="app-loading">Loading...</div>;
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      {/* Public docs routes — no auth required */}
      <Route path="/docs/:workspaceSlug" element={<PublicDocListPage />} />
      <Route path="/docs/:workspaceSlug/*" element={<PublicDocPage />} />

      {/* Auth routes */}
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        }
      />

      {/* Protected workspace routes */}
      <Route
        element={
          <RequireAuth>
            <WorkspaceLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="wiki" element={<WikiPage />} />
        <Route path="folders/:folderId" element={<FolderPage />} />
        <Route path="pages/new" element={<NewPagePage />} />
        <Route path="pages/:pageId" element={<PageEditorPage />} />
        <Route path="review" element={<ReviewQueuePage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route
          path="ingestions/:ingestionId"
          element={<IngestionDetailPage />}
        />
        <Route path="import" element={<ImportPage />} />
        <Route path="admin/queues" element={<QueueHealthPage />} />
        <Route path="trash" element={<TrashPage />} />
      </Route>
    </Routes>
  );
}

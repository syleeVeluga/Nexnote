import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/use-auth.js";
import { useWorkspace } from "../../hooks/use-workspace.js";
import { workspaces as wsApi } from "../../lib/api-client.js";
import { slugify } from "@wekiflow/shared";
import { Sidebar } from "./Sidebar.js";

export function WorkspaceLayout() {
  const { t } = useTranslation("common");
  const { user, logout } = useAuth();
  const { current, workspaceList, select, refresh } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 768);

  const handleCreateWorkspace = useCallback(async () => {
    const name = window.prompt(t("createWorkspacePrompt"), "")?.trim();
    if (!name) return;

    try {
      const slug = slugify(name);
      const workspace = await wsApi.create({ name, slug });
      select(workspace);
      navigate("/");
      void refresh();
    } catch (err) {
      console.error(err);
      window.alert(t("createWorkspaceFailed"));
    }
  }, [navigate, refresh, select, t]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setSidebarOpen(false);
    }
  }, [location.pathname]);

  if (!current) {
    return (
      <div className="workspace-empty">
        <p>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className={`app-shell${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <Sidebar
        workspace={current}
        workspaceList={workspaceList}
        onSelectWorkspace={(ws) => {
          select(ws);
          navigate("/");
        }}
        onCreateWorkspace={() => {
          void handleCreateWorkspace();
        }}
        onRenameWorkspace={refresh}
        onCollapse={() => setSidebarOpen(false)}
        onNewPage={() => navigate("/pages/new")}
        userName={user?.name ?? ""}
        onLogout={logout}
      />
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label={t("pagesSectionTitle")}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main
        className={`main-content${sidebarOpen ? "" : " sidebar-toggle-visible"}`}
      >
        {!sidebarOpen && (
          <button
            className="sidebar-expand-btn"
            onClick={() => setSidebarOpen(true)}
            title={t("pagesSectionTitle")}
            aria-label={t("pagesSectionTitle")}
          >
            <span aria-hidden="true">|||</span>
            <span>{t("pagesSectionTitle")}</span>
          </button>
        )}
        <Outlet />
      </main>
    </div>
  );
}

import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/use-auth.js";
import { useWorkspace } from "../../hooks/use-workspace.js";
import { Sidebar } from "./Sidebar.js";

export function WorkspaceLayout() {
  const { t } = useTranslation("common");
  const { user, logout } = useAuth();
  const { current, workspaceList, select, refresh } = useWorkspace();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
        onRenameWorkspace={refresh}
        onCollapse={() => setSidebarOpen(false)}
        onNewPage={() => navigate("/pages/new")}
        userName={user?.name ?? ""}
        onLogout={logout}
      />
      <main className="main-content">
        {!sidebarOpen && (
          <button className="sidebar-expand-btn" onClick={() => setSidebarOpen(true)} title="사이드바 열기">
            »
          </button>
        )}
        <Outlet />
      </main>
    </div>
  );
}

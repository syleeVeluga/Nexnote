import { Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/use-auth.js";
import { useWorkspace } from "../../hooks/use-workspace.js";
import { Sidebar } from "./Sidebar.js";

export function WorkspaceLayout() {
  const { t } = useTranslation("common");
  const { user, logout } = useAuth();
  const { current, workspaceList, select } = useWorkspace();
  const navigate = useNavigate();

  if (!current) {
    return (
      <div className="workspace-empty">
        <h2>{t("noWorkspace")}</h2>
        <p>{t("createWorkspaceHint")}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        workspace={current}
        workspaceList={workspaceList}
        onSelectWorkspace={(ws) => {
          select(ws);
          navigate("/");
        }}
        userName={user?.name ?? ""}
        onLogout={logout}
      />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

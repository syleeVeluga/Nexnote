import { useState, useEffect, useMemo } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  folders as foldersApi,
  pages as pagesApi,
  type Folder,
  type Page,
  type Workspace,
} from "../../lib/api-client.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";

interface SidebarProps {
  workspace: Workspace;
  workspaceList: Workspace[];
  onSelectWorkspace: (ws: Workspace) => void;
  userName: string;
  onLogout: () => void;
}

export function Sidebar({
  workspace,
  workspaceList,
  onSelectWorkspace,
  userName,
  onLogout,
}: SidebarProps) {
  const { t } = useTranslation("common");
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [pageList, setPageList] = useState<Page[]>([]);
  const [wsDropdown, setWsDropdown] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [fRes, pRes] = await Promise.all([
          foldersApi.list(workspace.id, { limit: 100 }),
          pagesApi.list(workspace.id, { limit: 200 }),
        ]);
        if (!cancelled) {
          setFolderList(fRes.data);
          setPageList(pRes.data);
        }
      } catch {
        // user may have navigated away
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workspace.id]);

  // Pre-compute lookup maps to avoid O(N) scans in each FolderNode
  const folderChildrenMap = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of folderList) {
      const key = f.parentFolderId;
      const list = map.get(key);
      if (list) list.push(f);
      else map.set(key, [f]);
    }
    return map;
  }, [folderList]);

  const pagesByFolderMap = useMemo(() => {
    const map = new Map<string | null, Page[]>();
    for (const p of pageList) {
      const key = p.folderId;
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [pageList]);

  const rootFolders = folderChildrenMap.get(null) ?? [];
  const rootPages = pagesByFolderMap.get(null) ?? [];

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <button
          className="ws-selector"
          onClick={() => setWsDropdown(!wsDropdown)}
        >
          <span className="ws-name">{workspace.name}</span>
          <span className="ws-chevron">{wsDropdown ? "\u25B2" : "\u25BC"}</span>
        </button>
        {wsDropdown && (
          <div className="ws-dropdown">
            {workspaceList.map((ws) => (
              <button
                key={ws.id}
                className={`ws-dropdown-item${ws.id === workspace.id ? " active" : ""}`}
                onClick={() => {
                  onSelectWorkspace(ws);
                  setWsDropdown(false);
                }}
              >
                {ws.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-actions">
        <button
          className="btn-new-page"
          onClick={() => navigate("/pages/new")}
        >
          {t("newPage")}
        </button>
      </div>

      <div className="sidebar-content">
        {rootFolders.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            folderChildrenMap={folderChildrenMap}
            pagesByFolderMap={pagesByFolderMap}
            untitled={t("untitled")}
          />
        ))}
        {rootPages.map((page) => (
          <PageLink key={page.id} page={page} untitled={t("untitled")} />
        ))}
        {folderList.length === 0 && pageList.length === 0 && (
          <p className="sidebar-empty">{t("noPagesYet")}</p>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-user">{userName}</span>
        <LanguageSwitcher />
        <button className="btn-logout" onClick={onLogout}>
          {t("signOut")}
        </button>
      </div>
    </nav>
  );
}

function FolderNode({
  folder,
  folderChildrenMap,
  pagesByFolderMap,
  untitled,
}: {
  folder: Folder;
  folderChildrenMap: Map<string | null, Folder[]>;
  pagesByFolderMap: Map<string | null, Page[]>;
  untitled: string;
}) {
  const [open, setOpen] = useState(true);
  const children = folderChildrenMap.get(folder.id) ?? [];
  const folderPageList = pagesByFolderMap.get(folder.id) ?? [];

  return (
    <div className="folder-node">
      <button className="folder-toggle" onClick={() => setOpen(!open)}>
        <span className="folder-icon">{open ? "\u25BE" : "\u25B8"}</span>
        <span className="folder-name">{folder.name}</span>
      </button>
      {open && (
        <div className="folder-children">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              folderChildrenMap={folderChildrenMap}
              pagesByFolderMap={pagesByFolderMap}
              untitled={untitled}
            />
          ))}
          {folderPageList.map((page) => (
            <PageLink key={page.id} page={page} untitled={untitled} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageLink({ page, untitled }: { page: Page; untitled: string }) {
  return (
    <NavLink
      to={`/pages/${page.id}`}
      className={({ isActive }) =>
        `page-link${isActive ? " active" : ""}`
      }
    >
      {page.title || untitled}
    </NavLink>
  );
}

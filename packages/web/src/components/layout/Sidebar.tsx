import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { slugify } from "@nexnote/shared";
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
  // inline folder creation state: null = hidden, string = parentFolderId (empty = root)
  const [creatingFolderParent, setCreatingFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [fRes, pRes] = await Promise.all([
          foldersApi.list(workspace.id, { limit: 100 }),
          pagesApi.list(workspace.id, { limit: 100 }),
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

  const openNewFolder = useCallback((parentFolderId: string) => {
    setCreatingFolderParent(parentFolderId);
    setNewFolderName("");
    setTimeout(() => newFolderInputRef.current?.focus(), 50);
  }, []);

  const cancelNewFolder = useCallback(() => {
    setCreatingFolderParent(null);
    setNewFolderName("");
  }, []);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const parentFolderId = creatingFolderParent === "" ? null : creatingFolderParent;
      const res = await foldersApi.create(workspace.id, {
        name,
        slug: slugify(name),
        parentFolderId,
      });
      setFolderList((prev) => [...prev, res.data]);
      setCreatingFolderParent(null);
      setNewFolderName("");
    } finally {
      setCreatingFolder(false);
    }
  }, [newFolderName, creatingFolder, creatingFolderParent, workspace.id]);

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
        <button
          className="btn-new-folder"
          title={t("newFolder")}
          onClick={() => openNewFolder("")}
        >
          +
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
            creatingFolderParent={creatingFolderParent}
            onNewFolder={openNewFolder}
            newFolderName={newFolderName}
            onNewFolderNameChange={setNewFolderName}
            onSubmitNewFolder={submitNewFolder}
            onCancelNewFolder={cancelNewFolder}
            creatingFolder={creatingFolder}
            newFolderInputRef={newFolderInputRef}
            okLabel={t("common:ok")}
            cancelLabel={t("common:cancel")}
            placeholder={t("folderNamePlaceholder")}
          />
        ))}
        {rootPages.map((page) => (
          <PageLink key={page.id} page={page} untitled={t("untitled")} />
        ))}
        {folderList.length === 0 && pageList.length === 0 && (
          <p className="sidebar-empty">{t("noPagesYet")}</p>
        )}

        {creatingFolderParent === "" && (
          <div className="folder-create-inline">
            <input
              ref={newFolderInputRef}
              className="folder-create-input"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("folderNamePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewFolder();
                if (e.key === "Escape") cancelNewFolder();
              }}
              disabled={creatingFolder}
            />
            <button className="btn-sm btn-primary" onClick={submitNewFolder} disabled={creatingFolder || !newFolderName.trim()}>
              {t("common:ok")}
            </button>
            <button className="btn-sm" onClick={cancelNewFolder}>
              {t("common:cancel")}
            </button>
          </div>
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

interface FolderNodeProps {
  folder: Folder;
  folderChildrenMap: Map<string | null, Folder[]>;
  pagesByFolderMap: Map<string | null, Page[]>;
  untitled: string;
  creatingFolderParent: string | null;
  onNewFolder: (parentFolderId: string) => void;
  newFolderName: string;
  onNewFolderNameChange: (v: string) => void;
  onSubmitNewFolder: () => void;
  onCancelNewFolder: () => void;
  creatingFolder: boolean;
  newFolderInputRef: React.RefObject<HTMLInputElement | null>;
  okLabel: string;
  cancelLabel: string;
  placeholder: string;
}

function FolderNode({
  folder,
  folderChildrenMap,
  pagesByFolderMap,
  untitled,
  creatingFolderParent,
  onNewFolder,
  newFolderName,
  onNewFolderNameChange,
  onSubmitNewFolder,
  onCancelNewFolder,
  creatingFolder,
  newFolderInputRef,
  okLabel,
  cancelLabel,
  placeholder,
}: FolderNodeProps) {
  const [open, setOpen] = useState(true);
  const children = folderChildrenMap.get(folder.id) ?? [];
  const folderPageList = pagesByFolderMap.get(folder.id) ?? [];
  const showCreateForm = creatingFolderParent === folder.id;

  return (
    <div className="folder-node">
      <div className="folder-row">
        <button className="folder-toggle" onClick={() => setOpen(!open)}>
          <span className="folder-icon">{open ? "\u25BE" : "\u25B8"}</span>
          <span className="folder-name">{folder.name}</span>
        </button>
        <button
          className="folder-add-btn"
          title="새 하위 폴더"
          onClick={(e) => { e.stopPropagation(); onNewFolder(folder.id); }}
        >
          +
        </button>
      </div>
      {open && (
        <div className="folder-children">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              folderChildrenMap={folderChildrenMap}
              pagesByFolderMap={pagesByFolderMap}
              untitled={untitled}
              creatingFolderParent={creatingFolderParent}
              onNewFolder={onNewFolder}
              newFolderName={newFolderName}
              onNewFolderNameChange={onNewFolderNameChange}
              onSubmitNewFolder={onSubmitNewFolder}
              onCancelNewFolder={onCancelNewFolder}
              creatingFolder={creatingFolder}
              newFolderInputRef={newFolderInputRef}
              okLabel={okLabel}
              cancelLabel={cancelLabel}
              placeholder={placeholder}
            />
          ))}
          {folderPageList.map((page) => (
            <PageLink key={page.id} page={page} untitled={untitled} />
          ))}
          {showCreateForm && (
            <div className="folder-create-inline">
              <input
                ref={newFolderInputRef}
                className="folder-create-input"
                value={newFolderName}
                onChange={(e) => onNewFolderNameChange(e.target.value)}
                placeholder={placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitNewFolder();
                  if (e.key === "Escape") onCancelNewFolder();
                }}
                disabled={creatingFolder}
              />
              <button className="btn-sm btn-primary" onClick={onSubmitNewFolder} disabled={creatingFolder || !newFolderName.trim()}>
                {okLabel}
              </button>
              <button className="btn-sm" onClick={onCancelNewFolder}>
                {cancelLabel}
              </button>
            </div>
          )}
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

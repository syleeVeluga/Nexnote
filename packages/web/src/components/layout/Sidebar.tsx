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

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  type: "folder" | "page";
  id: string;
  currentName: string;
}

function ContextMenu({
  menu,
  onRename,
  onDelete,
  onClose,
}: {
  menu: ContextMenuState;
  onRename: (id: string, type: "folder" | "page", currentName: string) => void;
  onDelete: (id: string, type: "folder" | "page") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 9999 }}
    >
      <button
        className="context-menu-item"
        onClick={() => { onRename(menu.id, menu.type, menu.currentName); onClose(); }}
      >
        {t("rename")}
      </button>
      <button
        className="context-menu-item context-menu-item-danger"
        onClick={() => { onDelete(menu.id, menu.type); onClose(); }}
      >
        {t("delete")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

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
  // inline folder creation
  const [creatingFolderParent, setCreatingFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  // context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // inline rename
  const [renaming, setRenaming] = useState<{ id: string; type: "folder" | "page"; value: string } | null>(null);
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
      } catch { /* navigated away */ }
    }
    load();
    return () => { cancelled = true; };
  }, [workspace.id]);

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

  // ---- folder creation ----

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
      const res = await foldersApi.create(workspace.id, { name, slug: slugify(name), parentFolderId });
      setFolderList((prev) => [...prev, res.data]);
      setCreatingFolderParent(null);
      setNewFolderName("");
    } finally {
      setCreatingFolder(false);
    }
  }, [newFolderName, creatingFolder, creatingFolderParent, workspace.id]);

  // ---- context menu actions ----

  const openContextMenu = useCallback((e: React.MouseEvent, type: "folder" | "page", id: string, currentName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type, id, currentName });
  }, []);

  const startRename = useCallback((id: string, type: "folder" | "page", currentName: string) => {
    setRenaming({ id, type, value: currentName });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name) { setRenaming(null); return; }

    if (renaming.type === "folder") {
      await foldersApi.patch(workspace.id, renaming.id, { name });
      setFolderList((prev) => prev.map((f) => f.id === renaming.id ? { ...f, name } : f));
    } else {
      await pagesApi.update(workspace.id, renaming.id, { title: name });
      setPageList((prev) => prev.map((p) => p.id === renaming.id ? { ...p, title: name } : p));
    }
    setRenaming(null);
  }, [renaming, workspace.id]);

  const handleDelete = useCallback(async (id: string, type: "folder" | "page") => {
    if (!window.confirm(t("deleteConfirm"))) return;
    if (type === "folder") {
      await foldersApi.delete(workspace.id, id);
      setFolderList((prev) => prev.filter((f) => f.id !== id));
    } else {
      await pagesApi.delete(workspace.id, id);
      setPageList((prev) => prev.filter((p) => p.id !== id));
    }
  }, [workspace.id, t]);

  const sharedFolderProps = useMemo(() => ({
    folderChildrenMap,
    pagesByFolderMap,
    untitled: t("untitled"),
    creatingFolderParent,
    onNewFolder: openNewFolder,
    newFolderName,
    onNewFolderNameChange: setNewFolderName,
    onSubmitNewFolder: submitNewFolder,
    onCancelNewFolder: cancelNewFolder,
    creatingFolder,
    newFolderInputRef,
    okLabel: t("ok"),
    cancelLabel: t("cancel"),
    placeholder: t("folderNamePlaceholder"),
    onContextMenu: openContextMenu,
    renamingId: renaming?.id ?? null,
    renameValue: renaming?.value ?? "",
    onRenameValueChange: (v: string) => setRenaming((r) => r ? { ...r, value: v } : null),
    onSubmitRename: submitRename,
    onCancelRename: () => setRenaming(null),
  }), [
    folderChildrenMap, pagesByFolderMap, t,
    creatingFolderParent, openNewFolder,
    newFolderName, submitNewFolder, cancelNewFolder,
    creatingFolder, newFolderInputRef,
    openContextMenu, renaming, submitRename,
  ]);

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <button className="ws-selector" onClick={() => setWsDropdown(!wsDropdown)}>
          <span className="ws-name">{workspace.name}</span>
          <span className="ws-chevron">{wsDropdown ? "\u25B2" : "\u25BC"}</span>
        </button>
        {wsDropdown && (
          <div className="ws-dropdown">
            {workspaceList.map((ws) => (
              <button
                key={ws.id}
                className={`ws-dropdown-item${ws.id === workspace.id ? " active" : ""}`}
                onClick={() => { onSelectWorkspace(ws); setWsDropdown(false); }}
              >
                {ws.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-actions">
        <button className="btn-new-page" onClick={() => navigate("/pages/new")}>
          {t("newPage")}
        </button>
        <button className="btn-new-folder" title={t("newFolder")} onClick={() => openNewFolder("")}>
          +
        </button>
      </div>

      <div className="sidebar-content">
        {rootFolders.map((folder) => (
          <FolderNode key={folder.id} folder={folder} {...sharedFolderProps} />
        ))}
        {rootPages.map((page) => (
          <PageLink
            key={page.id}
            page={page}
            untitled={t("untitled")}
            onContextMenu={openContextMenu}
            renamingId={renaming?.id ?? null}
            renameValue={renaming?.value ?? ""}
            onRenameValueChange={(v) => setRenaming((r) => r ? { ...r, value: v } : null)}
            onSubmitRename={submitRename}
            onCancelRename={() => setRenaming(null)}
          />
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
              {t("ok")}
            </button>
            <button className="btn-sm" onClick={cancelNewFolder}>{t("cancel")}</button>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-user">{userName}</span>
        <LanguageSwitcher />
        <button className="btn-logout" onClick={onLogout}>{t("signOut")}</button>
      </div>

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onRename={startRename}
          onDelete={handleDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// FolderNode
// ---------------------------------------------------------------------------

interface SharedFolderProps {
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
  onContextMenu: (e: React.MouseEvent, type: "folder" | "page", id: string, name: string) => void;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
}

function FolderNode({ folder, ...shared }: { folder: Folder } & SharedFolderProps) {
  const [open, setOpen] = useState(true);
  const children = shared.folderChildrenMap.get(folder.id) ?? [];
  const folderPageList = shared.pagesByFolderMap.get(folder.id) ?? [];
  const showCreateForm = shared.creatingFolderParent === folder.id;
  const isRenaming = shared.renamingId === folder.id;

  return (
    <div className="folder-node">
      <div className="folder-row" onContextMenu={(e) => shared.onContextMenu(e, "folder", folder.id, folder.name)}>
        {isRenaming ? (
          <input
            className="folder-rename-input"
            autoFocus
            value={shared.renameValue}
            onChange={(e) => shared.onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") shared.onSubmitRename();
              if (e.key === "Escape") shared.onCancelRename();
            }}
            onBlur={shared.onSubmitRename}
          />
        ) : (
          <button className="folder-toggle" onClick={() => setOpen(!open)}>
            <span className="folder-icon">{open ? "\u25BE" : "\u25B8"}</span>
            <span className="folder-name">{folder.name}</span>
          </button>
        )}
        <button
          className="folder-add-btn"
          title="새 하위 폴더"
          onClick={(e) => { e.stopPropagation(); shared.onNewFolder(folder.id); }}
        >
          +
        </button>
      </div>
      {open && (
        <div className="folder-children">
          {children.map((child) => (
            <FolderNode key={child.id} folder={child} {...shared} />
          ))}
          {folderPageList.map((page) => (
            <PageLink
              key={page.id}
              page={page}
              untitled={shared.untitled}
              onContextMenu={shared.onContextMenu}
              renamingId={shared.renamingId}
              renameValue={shared.renameValue}
              onRenameValueChange={shared.onRenameValueChange}
              onSubmitRename={shared.onSubmitRename}
              onCancelRename={shared.onCancelRename}
            />
          ))}
          {showCreateForm && (
            <div className="folder-create-inline">
              <input
                ref={shared.newFolderInputRef}
                className="folder-create-input"
                value={shared.newFolderName}
                onChange={(e) => shared.onNewFolderNameChange(e.target.value)}
                placeholder={shared.placeholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") shared.onSubmitNewFolder();
                  if (e.key === "Escape") shared.onCancelNewFolder();
                }}
                disabled={shared.creatingFolder}
              />
              <button
                className="btn-sm btn-primary"
                onClick={shared.onSubmitNewFolder}
                disabled={shared.creatingFolder || !shared.newFolderName.trim()}
              >
                {shared.okLabel}
              </button>
              <button className="btn-sm" onClick={shared.onCancelNewFolder}>{shared.cancelLabel}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageLink
// ---------------------------------------------------------------------------

function PageLink({
  page,
  untitled,
  onContextMenu,
  renamingId,
  renameValue,
  onRenameValueChange,
  onSubmitRename,
  onCancelRename,
}: {
  page: Page;
  untitled: string;
  onContextMenu: (e: React.MouseEvent, type: "folder" | "page", id: string, name: string) => void;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
}) {
  const isRenaming = renamingId === page.id;

  if (isRenaming) {
    return (
      <input
        className="page-rename-input"
        autoFocus
        value={renameValue}
        onChange={(e) => onRenameValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmitRename();
          if (e.key === "Escape") onCancelRename();
        }}
        onBlur={onSubmitRename}
      />
    );
  }

  return (
    <NavLink
      to={`/pages/${page.id}`}
      className={({ isActive }) => `page-link${isActive ? " active" : ""}`}
      onContextMenu={(e) => onContextMenu(e, "page", page.id, page.title || untitled)}
    >
      {page.title || untitled}
    </NavLink>
  );
}

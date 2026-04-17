import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  pages as pagesApi,
  workspaces as wsApi,
  decisions as decisionsApi,
  type Page,
  type Workspace,
} from "../../lib/api-client.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";
import { subscribeDecisionCountsUpdated } from "../../lib/decision-events.js";

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  pageId: string;
  currentTitle: string;
}

function ContextMenu({
  menu,
  onRename,
  onDelete,
  onClose,
}: {
  menu: ContextMenuState;
  onRename: (id: string, currentTitle: string) => void;
  onDelete: (id: string) => void;
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
        onClick={() => { onRename(menu.pageId, menu.currentTitle); onClose(); }}
      >
        {t("rename")}
      </button>
      <button
        className="context-menu-item context-menu-item-danger"
        onClick={() => { onDelete(menu.pageId); onClose(); }}
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
  onRenameWorkspace: () => void;
  onCollapse: () => void;
  onNewPage: () => void;
  userName: string;
  onLogout: () => void;
}

export function Sidebar({
  workspace,
  workspaceList,
  onSelectWorkspace,
  onRenameWorkspace,
  onCollapse,
  onNewPage,
  userName,
  onLogout,
}: SidebarProps) {
  const { t } = useTranslation("common");
  const location = useLocation();
  const navigate = useNavigate();

  const [pageList, setPageList] = useState<Page[]>([]);
  const [wsDropdown, setWsDropdown] = useState(false);
  // null = not renaming; string = editing value
  const [wsRename, setWsRename] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    pagesApi
      .list(workspace.id, { limit: 100 })
      .then((res) => { if (!cancelled) setPageList(res.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workspace.id, location.pathname, location.search]);

  useEffect(() => {
    let cancelled = false;
    decisionsApi
      .counts(workspace.id)
      .then((res) => {
        if (cancelled) return;
        const next = res.counts.pending ?? 0;
        setPendingCount((prev) => (prev === next ? prev : next));
      })
      .catch(() => {});
    const unsubscribe = subscribeDecisionCountsUpdated((detail) => {
      if (cancelled || detail.workspaceId !== workspace.id) return;
      const next = detail.counts.pending ?? 0;
      setPendingCount((prev) => (prev === next ? prev : next));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspace.id, location.pathname]);

  const pagesByParent = useMemo(() => {
    const map = new Map<string | null, Page[]>();
    for (const p of pageList) {
      const key = p.parentPageId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [pageList]);

  const rootPages = pagesByParent.get(null) ?? [];

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startRename = useCallback((id: string, currentTitle: string) => {
    setRenaming({ id, value: currentTitle });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const { id, value } = renaming;
    const title = value.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await pagesApi.update(workspace.id, id, { title });
      setPageList((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)));
    } catch { /* leave existing title on failure */ }
  }, [renaming, workspace.id]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm(t("deleteConfirm"))) return;
    await pagesApi.delete(workspace.id, id);
    setPageList((prev) => {
      const toRemove = new Set<string>();
      const collect = (pageId: string) => {
        toRemove.add(pageId);
        prev.filter((p) => p.parentPageId === pageId).forEach((c) => collect(c.id));
      };
      collect(id);
      return prev.filter((p) => !toRemove.has(p.id));
    });
  }, [workspace.id, t]);

  const openContextMenu = useCallback(
    (e: React.MouseEvent, pageId: string, currentTitle: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, pageId, currentTitle });
    },
    [],
  );

  const startWsRename = useCallback(() => {
    setWsDropdown(false);
    setWsRename(workspace.name);
  }, [workspace.name]);

  const submitWsRename = useCallback(async () => {
    const name = wsRename?.trim();
    setWsRename(null);
    if (!name || name === workspace.name) return;
    try {
      await wsApi.update(workspace.id, { name });
      onRenameWorkspace();
    } catch { /* ignore */ }
  }, [wsRename, workspace.id, workspace.name, onRenameWorkspace]);

  const onAddSubPage = useCallback(
    (parentId: string, parentTitle: string) =>
      navigate(`/pages/new?parentId=${parentId}&parentTitle=${encodeURIComponent(parentTitle)}`),
    [navigate],
  );

  const onRenameValueChange = useCallback(
    (v: string) => setRenaming((r) => (r ? { ...r, value: v } : null)),
    [],
  );

  const onCancelRename = useCallback(() => setRenaming(null), []);

  const sharedNodeProps = useMemo(
    () => ({
      pagesByParent,
      expandedIds,
      onToggle: toggleExpand,
      onAddSubPage,
      onContextMenu: openContextMenu,
      renamingId: renaming?.id ?? null,
      renameValue: renaming?.value ?? "",
      onRenameValueChange,
      onSubmitRename: submitRename,
      onCancelRename,
      untitled: t("untitled"),
    }),
    [
      pagesByParent, expandedIds, toggleExpand, onAddSubPage,
      openContextMenu, renaming, onRenameValueChange, submitRename,
      onCancelRename, t,
    ],
  );

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        {wsRename !== null ? (
          <div className="ws-header-row">
            <input
              className="ws-rename-input"
              autoFocus
              value={wsRename}
              onChange={(e) => setWsRename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitWsRename();
                if (e.key === "Escape") setWsRename(null);
              }}
              onBlur={submitWsRename}
            />
          </div>
        ) : (
          <div className="ws-header-row">
            <button
              className="ws-selector"
              onClick={() => setWsDropdown(!wsDropdown)}
            >
              <span className="ws-name">{workspace.name}</span>
              <span className="ws-chevron">&#8964;</span>
            </button>
            <button className="sidebar-icon-btn" title="사이드바 닫기" onClick={onCollapse}>
              &#171;
            </button>
            <button className="sidebar-icon-btn" title={t("newPage")} onClick={onNewPage}>
              &#x1F5CE;&#xFE0E;
            </button>
          </div>
        )}
        {wsRename === null && wsDropdown && (
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
            <div className="ws-dropdown-divider" />
            <button
              className="ws-dropdown-item"
              onClick={startWsRename}
            >
              {t("renameWorkspace")}
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-nav-top">
        <NavLink
          to="/review"
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
        >
          <span className="sidebar-nav-label">{t("review")}</span>
          {pendingCount > 0 && (
            <span className="sidebar-nav-badge">{pendingCount}</span>
          )}
        </NavLink>
      </div>

      <div className="sidebar-content">
        {rootPages.map((page) => (
          <PageNode key={page.id} page={page} {...sharedNodeProps} />
        ))}
        {rootPages.length === 0 && (
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
// PageNode — recursive
// ---------------------------------------------------------------------------

interface SharedNodeProps {
  pagesByParent: Map<string | null, Page[]>;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onAddSubPage: (parentId: string, parentTitle: string) => void;
  onContextMenu: (e: React.MouseEvent, pageId: string, currentTitle: string) => void;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  untitled: string;
}

function PageNode({ page, ...shared }: { page: Page } & SharedNodeProps) {
  const children = shared.pagesByParent.get(page.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = shared.expandedIds.has(page.id);
  const isRenaming = shared.renamingId === page.id;
  const title = page.title || shared.untitled;

  return (
    <div className="page-node">
      <div
        className="page-node-row"
        onContextMenu={(e) => shared.onContextMenu(e, page.id, title)}
      >
        <button
          className="page-expand-btn"
          onClick={(e) => { e.stopPropagation(); shared.onToggle(page.id); }}
          tabIndex={-1}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : " "}
        </button>

        {isRenaming ? (
          <input
            className="page-rename-input"
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
          <NavLink
            to={`/pages/${page.id}`}
            className={({ isActive }) => `page-node-link${isActive ? " active" : ""}`}
          >
            {title}
          </NavLink>
        )}

        <button
          className="page-add-sub-btn"
          title="하위 페이지 추가"
          onClick={(e) => { e.stopPropagation(); shared.onAddSubPage(page.id, title); }}
        >
          +
        </button>
      </div>

      {isExpanded && hasChildren && (
        <div className="page-children">
          {children.map((child) => (
            <PageNode key={child.id} page={child} {...shared} />
          ))}
        </div>
      )}
    </div>
  );
}

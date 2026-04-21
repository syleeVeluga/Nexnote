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
import { ConfirmDialog } from "../modals/ConfirmDialog.js";

const ROOT_PAGE_VALUE = "__root__";

interface MoveDialogState {
  pageId: string;
  currentTitle: string;
  parentPageId: string | null;
}

interface MoveOption {
  id: string;
  label: string;
}

interface DeleteDialogState {
  pageId: string;
  title: string;
  /** Set when the first DELETE returned 409 PUBLISHED_BLOCK. */
  publishedBlock?: boolean;
}

function extractCurrentPageId(pathname: string): string {
  const m = /^\/pages\/([^/]+)/.exec(pathname);
  return m ? m[1] : "";
}

function extractErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: string; body?: { code?: string } };
  return e.code ?? e.body?.code ?? null;
}

function comparePages(a: Page, b: Page) {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }

  const createdAtDiff = a.createdAt.localeCompare(b.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return a.title.localeCompare(b.title);
}

function buildMoveOptions(
  pagesByParent: Map<string | null, Page[]>,
  untitled: string,
  excludedIds: Set<string>,
  parentId: string | null = null,
  depth = 0,
): MoveOption[] {
  const siblings = [...(pagesByParent.get(parentId) ?? [])].sort(comparePages);
  const options: MoveOption[] = [];

  for (const page of siblings) {
    if (excludedIds.has(page.id)) continue;
    const title = page.title || untitled;
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}- `;
    options.push({ id: page.id, label: `${prefix}${title}` });
    options.push(
      ...buildMoveOptions(
        pagesByParent,
        untitled,
        excludedIds,
        page.id,
        depth + 1,
      ),
    );
  }

  return options;
}

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
  onMove,
  onRename,
  onDelete,
  onClose,
}: {
  menu: ContextMenuState;
  onMove: (id: string, currentTitle: string) => void;
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
        onClick={() => { onMove(menu.pageId, menu.currentTitle); onClose(); }}
      >
        {t("move")}
      </button>
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
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [moving, setMoving] = useState<MoveDialogState | null>(null);
  const [moveTargetId, setMoveTargetId] = useState(ROOT_PAGE_VALUE);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);

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
    for (const pages of map.values()) {
      pages.sort(comparePages);
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

  const startMove = useCallback((id: string, currentTitle: string) => {
    const currentPage = pageList.find((page) => page.id === id);
    setMoving({
      pageId: id,
      currentTitle,
      parentPageId: currentPage?.parentPageId ?? null,
    });
    setMoveTargetId(currentPage?.parentPageId ?? ROOT_PAGE_VALUE);
    setMoveError(null);
  }, [pageList]);

  const closeMoveDialog = useCallback(() => {
    if (movePending) return;
    setMoving(null);
    setMoveTargetId(ROOT_PAGE_VALUE);
    setMoveError(null);
  }, [movePending]);

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

  const collectSubtree = useCallback(
    (rootId: string, list: Page[]) => {
      const ids = new Set<string>([rootId]);
      const add = (parent: string) => {
        for (const p of list) {
          if (p.parentPageId === parent && !ids.has(p.id)) {
            ids.add(p.id);
            add(p.id);
          }
        }
      };
      add(rootId);
      return ids;
    },
    [],
  );

  const openDeleteDialog = useCallback(
    (id: string) => {
      const page = pageList.find((p) => p.id === id);
      setDeleteDialog({ pageId: id, title: page?.title || t("untitled") });
    },
    [pageList, t],
  );

  const deleteDescendantCount = useMemo(() => {
    if (!deleteDialog) return 0;
    return collectSubtree(deleteDialog.pageId, pageList).size - 1;
  }, [deleteDialog, collectSubtree, pageList]);

  const applyDelete = useCallback(
    (pageId: string) => {
      const subtree = collectSubtree(pageId, pageList);
      setPageList((prev) => prev.filter((p) => !subtree.has(p.id)));
      if (subtree.has(extractCurrentPageId(location.pathname))) {
        navigate("/");
      }
    },
    [collectSubtree, pageList, location.pathname, navigate],
  );

  const moveOptions = useMemo(() => {
    if (!moving) return [];
    const excludedIds = collectSubtree(moving.pageId, pageList);
    return buildMoveOptions(pagesByParent, t("untitled"), excludedIds);
  }, [moving, collectSubtree, pageList, pagesByParent, t]);

  const submitMove = useCallback(async () => {
    if (!moving) return;

    const nextParentPageId =
      moveTargetId === ROOT_PAGE_VALUE ? null : moveTargetId;

    if (nextParentPageId === moving.parentPageId) {
      closeMoveDialog();
      return;
    }

    setMovePending(true);
    setMoveError(null);
    try {
      const response = await pagesApi.update(workspace.id, moving.pageId, {
        parentPageId: nextParentPageId,
      });
      setPageList((prev) => prev.map((page) => (
        page.id === moving.pageId ? response.page : page
      )));
      if (nextParentPageId) {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          next.add(nextParentPageId);
          return next;
        });
      }
      setMoving(null);
      setMoveTargetId(ROOT_PAGE_VALUE);
      setMoveError(null);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : t("movePageError"));
    } finally {
      setMovePending(false);
    }
  }, [closeMoveDialog, moveTargetId, moving, t, workspace.id]);

  const runDelete = useCallback(
    async (unpublishFirst: boolean) => {
      if (!deleteDialog) return;
      setDeleteBusy(true);
      try {
        if (unpublishFirst) {
          await pagesApi.unpublish(workspace.id, deleteDialog.pageId);
        }
        await pagesApi.delete(workspace.id, deleteDialog.pageId);
        applyDelete(deleteDialog.pageId);
        setDeleteDialog(null);
      } catch (err: unknown) {
        if (!unpublishFirst && extractErrorCode(err) === "PUBLISHED_BLOCK") {
          setDeleteDialog({ ...deleteDialog, publishedBlock: true });
        } else {
          alert(t("deleteFailed"));
        }
      } finally {
        setDeleteBusy(false);
      }
    },
    [deleteDialog, workspace.id, applyDelete, t],
  );

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
        <NavLink
          to="/activity"
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
        >
          <span className="sidebar-nav-label">{t("activity")}</span>
        </NavLink>
        <NavLink
          to="/import"
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
        >
          <span className="sidebar-nav-label">{t("import")}</span>
        </NavLink>
        {(workspace.role === "owner" || workspace.role === "admin") && (
          <NavLink
            to="/admin/queues"
            className={({ isActive }) =>
              `sidebar-nav-link${isActive ? " active" : ""}`
            }
          >
            <span className="sidebar-nav-label">{t("queueHealth")}</span>
          </NavLink>
        )}
        <NavLink
          to="/trash"
          className={({ isActive }) =>
            `sidebar-nav-link${isActive ? " active" : ""}`
          }
        >
          <span className="sidebar-nav-label">{t("trash")}</span>
        </NavLink>
      </div>

      <hr className="sidebar-divider" />

      <h2 className="sidebar-section-header">
        {t("pagesSectionTitle")}
      </h2>

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
          onMove={startMove}
          onRename={startRename}
          onDelete={openDeleteDialog}
          onClose={() => setContextMenu(null)}
        />
      )}

      {moving && (
        <MovePageDialog
          currentTitle={moving.currentTitle}
          moveTargetId={moveTargetId}
          options={moveOptions}
          errorMessage={moveError}
          pending={movePending}
          onChangeTarget={setMoveTargetId}
          onClose={closeMoveDialog}
          onSubmit={submitMove}
        />
      )}

      <ConfirmDialog
        open={!!deleteDialog && !deleteDialog.publishedBlock}
        title={t("delete")}
        message={
          deleteDialog
            ? deleteDescendantCount > 0
              ? t("deleteConfirmWithChildren", {
                  title: deleteDialog.title,
                  count: deleteDescendantCount,
                })
              : t("deleteConfirmNoChildren", { title: deleteDialog.title })
            : ""
        }
        confirmLabel={t("delete")}
        confirmVariant="danger"
        onConfirm={() => runDelete(false)}
        onCancel={() => setDeleteDialog(null)}
        busy={deleteBusy}
      />

      <ConfirmDialog
        open={!!deleteDialog?.publishedBlock}
        title={t("publishedBlockTitle")}
        message={t("publishedBlockMessage")}
        confirmLabel={t("unpublishThenDelete")}
        confirmVariant="danger"
        onConfirm={() => runDelete(true)}
        onCancel={() => setDeleteDialog(null)}
        busy={deleteBusy}
      />
    </nav>
  );
}

function MovePageDialog({
  currentTitle,
  moveTargetId,
  options,
  errorMessage,
  pending,
  onChangeTarget,
  onClose,
  onSubmit,
}: {
  currentTitle: string;
  moveTargetId: string;
  options: MoveOption[];
  errorMessage: string | null;
  pending: boolean;
  onChangeTarget: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("common");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="sidebar-dialog-overlay" onClick={onClose}>
      <div
        className="sidebar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-page-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sidebar-dialog-header">
          <h3 id="move-page-title">{t("movePageTitle", { title: currentTitle })}</h3>
        </div>

        <div className="sidebar-dialog-body">
          <label className="sidebar-dialog-label" htmlFor="move-page-parent">
            {t("movePageParentLabel")}
          </label>
          <select
            id="move-page-parent"
            className="sidebar-dialog-select"
            value={moveTargetId}
            onChange={(event) => onChangeTarget(event.target.value)}
            disabled={pending}
          >
            <option value={ROOT_PAGE_VALUE}>{t("moveToRoot")}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          {errorMessage && <p className="form-error">{errorMessage}</p>}
        </div>

        <div className="sidebar-dialog-actions">
          <button
            className="sidebar-dialog-btn sidebar-dialog-btn-secondary"
            onClick={onClose}
            disabled={pending}
          >
            {t("cancel")}
          </button>
          <button
            className="sidebar-dialog-btn sidebar-dialog-btn-primary"
            onClick={onSubmit}
            disabled={pending}
          >
            {pending ? t("loading") : t("move")}
          </button>
        </div>
      </div>
    </div>
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

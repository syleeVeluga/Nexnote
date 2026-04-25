import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type DragEvent,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  pages as pagesApi,
  folders as foldersApi,
  workspaces as wsApi,
  decisions as decisionsApi,
  type Folder,
  type Page,
  type Workspace,
  type ReorderIntent,
} from "../../lib/api-client.js";
import {
  bucketFolders,
  bucketPages,
  collectFolderSubtree,
  collectPageSubtree,
  computeDropIntent,
  intentToReorder,
  type DropIntent,
  type DropPosition,
  type ExplorerKind,
  type FolderBucket,
  type PageBucket,
} from "../../lib/explorer-tree.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";
import { subscribeDecisionCountsUpdated } from "../../lib/decision-events.js";
import { subscribePagesUpdated } from "../../lib/page-events.js";
import { ConfirmDialog } from "../modals/ConfirmDialog.js";
import { slugify } from "@wekiflow/shared";

// ---------------------------------------------------------------------------
// Local state types
// ---------------------------------------------------------------------------

const ROOT_PAGE_VALUE = "__root__";
const DRAG_MIME = "application/wekiflow-explorer-node";
const AUTO_EXPAND_DELAY_MS = 500;

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
  publishedBlock?: boolean;
}

interface FolderDeleteState {
  folderId: string;
  name: string;
  error?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  target: { kind: ExplorerKind; id: string; label: string };
}

interface DragPayload {
  kind: ExplorerKind;
  id: string;
}

type RenamingState = { kind: ExplorerKind; id: string; value: string } | null;

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
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const createdAtDiff = a.createdAt.localeCompare(b.createdAt);
  if (createdAtDiff !== 0) return createdAtDiff;
  return a.title.localeCompare(b.title);
}

function buildMoveOptions(
  pageBucket: PageBucket,
  untitled: string,
  excludedIds: Set<string>,
  parentId: string | null = null,
  depth = 0,
): MoveOption[] {
  const siblings =
    parentId === null
      ? (pageBucket.byFolder.get(null) ?? []).slice().sort(comparePages)
      : (pageBucket.byPage.get(parentId) ?? []).slice().sort(comparePages);

  const options: MoveOption[] = [];
  for (const page of siblings) {
    if (excludedIds.has(page.id)) continue;
    const title = page.title || untitled;
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}- `;
    options.push({ id: page.id, label: `${prefix}${title}` });
    options.push(
      ...buildMoveOptions(
        pageBucket,
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

function ContextMenu({
  menu,
  onMove,
  onRename,
  onDelete,
  onAddChild,
  onClose,
}: {
  menu: ContextMenuState;
  onMove: (target: ContextMenuState["target"]) => void;
  onRename: (target: ContextMenuState["target"]) => void;
  onDelete: (target: ContextMenuState["target"]) => void;
  onAddChild: (target: ContextMenuState["target"]) => void;
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

  const isFolder = menu.target.kind === "folder";

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 9999 }}
    >
      <button
        className="context-menu-item"
        onClick={() => {
          onAddChild(menu.target);
          onClose();
        }}
      >
        {isFolder ? t("newPage") : t("addSubpage")}
      </button>
      {!isFolder && (
        <button
          className="context-menu-item"
          onClick={() => {
            onMove(menu.target);
            onClose();
          }}
        >
          {t("move")}
        </button>
      )}
      <button
        className="context-menu-item"
        onClick={() => {
          onRename(menu.target);
          onClose();
        }}
      >
        {t("rename")}
      </button>
      <button
        className="context-menu-item context-menu-item-danger"
        onClick={() => {
          onDelete(menu.target);
          onClose();
        }}
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
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [wsDropdown, setWsDropdown] = useState(false);
  const [wsRename, setWsRename] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [folderDelete, setFolderDelete] = useState<FolderDeleteState | null>(
    null,
  );
  const [moving, setMoving] = useState<MoveDialogState | null>(null);
  const [moveTargetId, setMoveTargetId] = useState(ROOT_PAGE_VALUE);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [dragOver, setDragOver] = useState<DropIntent | null>(null);
  const [dndError, setDndError] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<Map<string, number>>(new Map());

  // -------------------------------------------------------------------------
  // Load folders + pages
  // -------------------------------------------------------------------------

  const loadPages = useCallback(async () => {
    const res = await pagesApi.list(workspace.id, { limit: 200 });
    setPageList(res.data);
  }, [workspace.id]);

  const loadFolders = useCallback(async () => {
    const res = await foldersApi.list(workspace.id, { limit: 200 });
    setFolderList(res.data);
  }, [workspace.id]);

  useEffect(() => {
    loadPages().catch(() => {});
    loadFolders().catch(() => {});
  }, [loadPages, loadFolders, location.pathname, location.search]);

  useEffect(() => {
    return subscribePagesUpdated((detail) => {
      if (detail.workspaceId !== workspace.id) return;
      loadPages().catch(() => {});
    });
  }, [workspace.id, loadPages]);

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
  }, [workspace.id]);

  // -------------------------------------------------------------------------
  // Tree buckets
  // -------------------------------------------------------------------------

  const folderBucket: FolderBucket = useMemo(
    () => bucketFolders(folderList),
    [folderList],
  );
  const pageBucket: PageBucket = useMemo(() => bucketPages(pageList), [pageList]);

  const rootFolders = folderBucket.byParent.get(null) ?? [];
  const rootPages = pageBucket.byFolder.get(null) ?? [];

  // -------------------------------------------------------------------------
  // Expansion
  // -------------------------------------------------------------------------

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Rename
  // -------------------------------------------------------------------------

  const startRename = useCallback((target: ContextMenuState["target"]) => {
    setRenaming({ kind: target.kind, id: target.id, value: target.label });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    const name = value.trim();
    setRenaming(null);
    if (!name) return;
    try {
      if (kind === "page") {
        await pagesApi.update(workspace.id, id, { title: name });
        setPageList((prev) =>
          prev.map((p) => (p.id === id ? { ...p, title: name } : p)),
        );
      } else {
        await foldersApi.patch(workspace.id, id, { name });
        setFolderList((prev) =>
          prev.map((f) => (f.id === id ? { ...f, name } : f)),
        );
      }
    } catch {
      /* leave stale label on failure */
    }
  }, [renaming, workspace.id]);

  // -------------------------------------------------------------------------
  // Add child (page under page / page under folder / folder under folder)
  // -------------------------------------------------------------------------

  const onAddChildPage = useCallback(
    (parentKind: ExplorerKind, parentId: string, parentTitle: string) => {
      const param = parentKind === "folder" ? "parentFolderId" : "parentId";
      navigate(
        `/pages/new?${param}=${parentId}&parentTitle=${encodeURIComponent(parentTitle)}`,
      );
    },
    [navigate],
  );

  const createFolder = useCallback(
    async (parentFolderId: string | null) => {
      const name = window.prompt(t("newFolder"), "")?.trim();
      if (!name) return;
      const slug = slugify(name) || `folder-${Date.now()}`;
      try {
        const res = await foldersApi.create(workspace.id, {
          name,
          slug,
          parentFolderId,
        });
        setFolderList((prev) => [...prev, res.data]);
        if (parentFolderId) expand(parentFolderId);
      } catch {
        /* swallow — prompt may re-fire; minimal UI for now */
      }
    },
    [workspace.id, t, expand],
  );

  // -------------------------------------------------------------------------
  // Delete (page)
  // -------------------------------------------------------------------------

  const collectPageSubtreeFor = useCallback(
    (rootId: string) => collectPageSubtree(rootId, pageBucket),
    [pageBucket],
  );

  const openDeleteDialog = useCallback(
    (target: ContextMenuState["target"]) => {
      if (target.kind === "page") {
        const page = pageList.find((p) => p.id === target.id);
        setDeleteDialog({
          pageId: target.id,
          title: page?.title || t("untitled"),
        });
      } else {
        const folder = folderList.find((f) => f.id === target.id);
        if (!folder) return;
        const { folderIds, pageIds } = collectFolderSubtree(
          target.id,
          folderBucket,
          pageBucket,
        );
        const childCount = folderIds.size - 1 + pageIds.size;
        if (childCount > 0) {
          setFolderDelete({
            folderId: target.id,
            name: folder.name,
            error: t("folderDeleteBlocked", { name: folder.name }),
          });
        } else {
          setFolderDelete({ folderId: target.id, name: folder.name });
        }
      }
    },
    [pageList, folderList, folderBucket, pageBucket, t],
  );

  const deleteDescendantCount = useMemo(() => {
    if (!deleteDialog) return 0;
    return collectPageSubtreeFor(deleteDialog.pageId).size - 1;
  }, [deleteDialog, collectPageSubtreeFor]);

  const applyDelete = useCallback(
    (pageId: string) => {
      const subtree = collectPageSubtreeFor(pageId);
      setPageList((prev) => prev.filter((p) => !subtree.has(p.id)));
      if (subtree.has(extractCurrentPageId(location.pathname))) {
        navigate("/");
      }
    },
    [collectPageSubtreeFor, location.pathname, navigate],
  );

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

  const runFolderDelete = useCallback(async () => {
    if (!folderDelete || folderDelete.error) return;
    setDeleteBusy(true);
    try {
      await foldersApi.delete(workspace.id, folderDelete.folderId);
      setFolderList((prev) => prev.filter((f) => f.id !== folderDelete.folderId));
      setFolderDelete(null);
    } catch {
      setFolderDelete({ ...folderDelete, error: t("deleteFailed") });
    } finally {
      setDeleteBusy(false);
    }
  }, [folderDelete, workspace.id, t]);

  // -------------------------------------------------------------------------
  // Move dialog (legacy, page-only)
  // -------------------------------------------------------------------------

  const startMove = useCallback(
    (target: ContextMenuState["target"]) => {
      if (target.kind !== "page") return;
      const currentPage = pageList.find((p) => p.id === target.id);
      setMoving({
        pageId: target.id,
        currentTitle: target.label,
        parentPageId: currentPage?.parentPageId ?? null,
      });
      setMoveTargetId(currentPage?.parentPageId ?? ROOT_PAGE_VALUE);
      setMoveError(null);
    },
    [pageList],
  );

  const closeMoveDialog = useCallback(() => {
    if (movePending) return;
    setMoving(null);
    setMoveTargetId(ROOT_PAGE_VALUE);
    setMoveError(null);
  }, [movePending]);

  const moveOptions = useMemo(() => {
    if (!moving) return [];
    const excludedIds = collectPageSubtreeFor(moving.pageId);
    return buildMoveOptions(pageBucket, t("untitled"), excludedIds);
  }, [moving, collectPageSubtreeFor, pageBucket, t]);

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
        parentFolderId: null,
      });
      setPageList((prev) =>
        prev.map((p) => (p.id === moving.pageId ? response.page : p)),
      );
      if (nextParentPageId) expand(nextParentPageId);
      setMoving(null);
      setMoveTargetId(ROOT_PAGE_VALUE);
      setMoveError(null);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : t("movePageError"));
    } finally {
      setMovePending(false);
    }
  }, [closeMoveDialog, moveTargetId, moving, t, workspace.id, expand]);

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  const clearHoverTimers = useCallback(() => {
    for (const handle of hoverTimeoutRef.current.values()) {
      window.clearTimeout(handle);
    }
    hoverTimeoutRef.current.clear();
  }, []);

  const handleDragStart = useCallback(
    (e: DragEvent, kind: ExplorerKind, id: string) => {
      const payload: DragPayload = { kind, id };
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
      setDragPayload(payload);
      setDndError(null);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDragPayload(null);
    setDragOver(null);
    clearHoverTimers();
  }, [clearHoverTimers]);

  const blockedIdsForDrag = useMemo(() => {
    if (!dragPayload) return new Set<string>();
    if (dragPayload.kind === "folder") {
      const { folderIds, pageIds } = collectFolderSubtree(
        dragPayload.id,
        folderBucket,
        pageBucket,
      );
      return new Set<string>([...folderIds, ...pageIds]);
    }
    return collectPageSubtree(dragPayload.id, pageBucket);
  }, [dragPayload, folderBucket, pageBucket]);

  const handleDragOverRow = useCallback(
    (
      e: DragEvent<HTMLDivElement>,
      targetKind: ExplorerKind,
      targetId: string,
    ) => {
      if (!dragPayload) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const intent = computeDropIntent({
        draggedKind: dragPayload.kind,
        draggedId: dragPayload.id,
        targetKind,
        targetId,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
        blockedIds: blockedIdsForDrag,
      });
      if (!intent) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver((prev) =>
        prev &&
        prev.position === intent.position &&
        prev.targetId === intent.targetId &&
        prev.targetKind === intent.targetKind
          ? prev
          : intent,
      );

      if (intent.position === "asChild" && !expandedIds.has(targetId)) {
        const existing = hoverTimeoutRef.current.get(targetId);
        if (!existing) {
          const handle = window.setTimeout(() => {
            expand(targetId);
            hoverTimeoutRef.current.delete(targetId);
          }, AUTO_EXPAND_DELAY_MS);
          hoverTimeoutRef.current.set(targetId, handle);
        }
      }
    },
    [dragPayload, blockedIdsForDrag, expandedIds, expand],
  );

  const handleDragLeaveRow = useCallback((targetId: string) => {
    const existing = hoverTimeoutRef.current.get(targetId);
    if (existing) {
      window.clearTimeout(existing);
      hoverTimeoutRef.current.delete(targetId);
    }
  }, []);

  const applyDrop = useCallback(
    async (dragged: DragPayload, target: DropIntent) => {
      const { position, targetKind, targetId } = target;

      if (dragged.kind === "page") {
        let parentPageId: string | null = null;
        let parentFolderId: string | null = null;
        let anchorId: string | null = null;

        if (position === "asChild") {
          if (targetKind === "page") parentPageId = targetId;
          else parentFolderId = targetId;
        } else {
          const anchor = pageList.find((p) => p.id === targetId);
          if (!anchor) return;
          parentPageId = anchor.parentPageId;
          parentFolderId = anchor.parentFolderId;
          anchorId = anchor.id;
        }

        const reorderIntent: ReorderIntent =
          position === "asChild"
            ? { kind: "asFirstChild" }
            : intentToReorder(position, anchorId!);

        try {
          const response = await pagesApi.update(workspace.id, dragged.id, {
            parentPageId,
            parentFolderId,
            reorderIntent,
          });
          setPageList((prev) =>
            prev.map((p) => (p.id === dragged.id ? response.page : p)),
          );
          // Refetch so sibling sortOrders stay in sync with server
          loadPages().catch(() => {});
          if (position === "asChild") expand(targetId);
        } catch (err) {
          setDndError(err instanceof Error ? err.message : t("movePageError"));
          loadPages().catch(() => {});
        }
      } else {
        // dragged.kind === "folder"
        let parentFolderId: string | null = null;
        let reorderIntent: ReorderIntent;

        if (position === "asChild") {
          if (targetKind !== "folder") return;
          parentFolderId = targetId;
          reorderIntent = { kind: "asFirstChild" };
        } else {
          if (targetKind !== "folder") return;
          const anchor = folderList.find((f) => f.id === targetId);
          if (!anchor) return;
          parentFolderId = anchor.parentFolderId;
          reorderIntent = intentToReorder(position, anchor.id);
        }

        try {
          const response = await foldersApi.patch(workspace.id, dragged.id, {
            parentFolderId,
            reorderIntent,
          });
          setFolderList((prev) =>
            prev.map((f) => (f.id === dragged.id ? response.data : f)),
          );
          loadFolders().catch(() => {});
          if (position === "asChild") expand(targetId);
        } catch (err) {
          setDndError(err instanceof Error ? err.message : t("movePageError"));
          loadFolders().catch(() => {});
        }
      }
    },
    [pageList, folderList, workspace.id, loadPages, loadFolders, expand, t],
  );

  const handleDrop = useCallback(
    (
      e: DragEvent<HTMLDivElement>,
      targetKind: ExplorerKind,
      targetId: string,
    ) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      let dragged: DragPayload;
      try {
        dragged = JSON.parse(raw);
      } catch {
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const intent = computeDropIntent({
        draggedKind: dragged.kind,
        draggedId: dragged.id,
        targetKind,
        targetId,
        pointerY: e.clientY,
        rectTop: rect.top,
        rectHeight: rect.height,
        blockedIds: blockedIdsForDrag,
      });
      handleDragEnd();
      if (!intent) return;
      void applyDrop(dragged, intent);
    },
    [blockedIdsForDrag, handleDragEnd, applyDrop],
  );

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------

  const openContextMenu = useCallback(
    (
      e: React.MouseEvent,
      kind: ExplorerKind,
      id: string,
      label: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, target: { kind, id, label } });
    },
    [],
  );

  const onRenameValueChange = useCallback(
    (v: string) => setRenaming((r) => (r ? { ...r, value: v } : null)),
    [],
  );

  const onCancelRename = useCallback(() => setRenaming(null), []);

  // -------------------------------------------------------------------------
  // Workspace header
  // -------------------------------------------------------------------------

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
    } catch {
      /* ignore */
    }
  }, [wsRename, workspace.id, workspace.name, onRenameWorkspace]);

  // -------------------------------------------------------------------------
  // Shared row props
  // -------------------------------------------------------------------------

  const sharedNodeProps: SharedNodeProps = {
    folderBucket,
    pageBucket,
    expandedIds,
    onToggle: toggleExpand,
    onAddSubPage: (kind, id, label) => onAddChildPage(kind, id, label),
    onAddSubfolder: (id) => void createFolder(id),
    onContextMenu: openContextMenu,
    renaming,
    onRenameValueChange,
    onSubmitRename: submitRename,
    onCancelRename,
    untitled: t("untitled"),
    folderPlaceholder: t("folderPlaceholder"),
    dragPayload,
    dragOver,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    onDragOverRow: handleDragOverRow,
    onDragLeaveRow: handleDragLeaveRow,
    onDrop: handleDrop,
    dragHandleTitle: t("dragHandle"),
    addSubpageTitle: t("addSubpage"),
    addSubfolderTitle: t("newSubfolder"),
  };

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
            <button
              className="sidebar-icon-btn"
              title="사이드바 닫기"
              onClick={onCollapse}
            >
              &#171;
            </button>
            <button
              className="sidebar-icon-btn"
              title={t("newPage")}
              onClick={onNewPage}
            >
              &#x1F5CE;&#xFE0E;
            </button>
            <button
              className="sidebar-icon-btn"
              title={t("newFolder")}
              onClick={() => void createFolder(null)}
            >
              &#x1F4C1;&#xFE0E;
            </button>
          </div>
        )}
        {wsRename === null && wsDropdown && (
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
            <div className="ws-dropdown-divider" />
            <button className="ws-dropdown-item" onClick={startWsRename}>
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

      <h2 className="sidebar-section-header">{t("pagesSectionTitle")}</h2>

      <div className="sidebar-content">
        {rootFolders.map((folder) => (
          <FolderNode key={folder.id} folder={folder} {...sharedNodeProps} />
        ))}
        {rootPages.map((page) => (
          <PageNode key={page.id} page={page} {...sharedNodeProps} />
        ))}
        {rootFolders.length === 0 && rootPages.length === 0 && (
          <p className="sidebar-empty">{t("noPagesYet")}</p>
        )}
        {dndError && <p className="sidebar-empty sidebar-dnd-error">{dndError}</p>}
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
          onAddChild={(target) => {
            if (target.kind === "folder") {
              onAddChildPage("folder", target.id, target.label);
            } else {
              onAddChildPage("page", target.id, target.label);
            }
          }}
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

      <ConfirmDialog
        open={!!folderDelete}
        title={t("delete")}
        message={
          folderDelete?.error ??
          (folderDelete
            ? t("folderDeleteConfirm", { name: folderDelete.name })
            : "")
        }
        confirmLabel={t("delete")}
        confirmVariant="danger"
        onConfirm={runFolderDelete}
        onCancel={() => setFolderDelete(null)}
        busy={deleteBusy}
      />
    </nav>
  );
}

// ---------------------------------------------------------------------------
// MovePageDialog (legacy fallback)
// ---------------------------------------------------------------------------

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
      if (event.key === "Escape") onClose();
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
          <h3 id="move-page-title">
            {t("movePageTitle", { title: currentTitle })}
          </h3>
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
// Row renderers
// ---------------------------------------------------------------------------

interface SharedNodeProps {
  folderBucket: FolderBucket;
  pageBucket: PageBucket;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onAddSubPage: (parentKind: ExplorerKind, id: string, title: string) => void;
  onAddSubfolder: (id: string) => void;
  onContextMenu: (
    e: React.MouseEvent,
    kind: ExplorerKind,
    id: string,
    label: string,
  ) => void;
  renaming: RenamingState;
  onRenameValueChange: (v: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  untitled: string;
  folderPlaceholder: string;
  dragPayload: DragPayload | null;
  dragOver: DropIntent | null;
  onDragStart: (e: DragEvent, kind: ExplorerKind, id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (
    e: DragEvent<HTMLDivElement>,
    targetKind: ExplorerKind,
    targetId: string,
  ) => void;
  onDragLeaveRow: (targetId: string) => void;
  onDrop: (
    e: DragEvent<HTMLDivElement>,
    targetKind: ExplorerKind,
    targetId: string,
  ) => void;
  dragHandleTitle: string;
  addSubpageTitle: string;
  addSubfolderTitle: string;
}

function dropIndicatorClass(
  dragOver: DropIntent | null,
  targetId: string,
): string {
  if (!dragOver || dragOver.targetId !== targetId) return "";
  if (dragOver.position === "before") return " drop-before";
  if (dragOver.position === "after") return " drop-after";
  return " drop-as-child";
}

function FolderNode({
  folder,
  ...shared
}: { folder: Folder } & SharedNodeProps) {
  const childFolders = shared.folderBucket.byParent.get(folder.id) ?? [];
  const childPages = shared.pageBucket.byFolder.get(folder.id) ?? [];
  const hasChildren = childFolders.length > 0 || childPages.length > 0;
  const isExpanded = shared.expandedIds.has(folder.id);
  const isRenaming =
    shared.renaming?.kind === "folder" && shared.renaming.id === folder.id;
  const label = folder.name || shared.folderPlaceholder;
  const indicator = dropIndicatorClass(shared.dragOver, folder.id);

  return (
    <div className="page-node">
      <div
        className={`page-node-row folder-row${indicator}`}
        onContextMenu={(e) => shared.onContextMenu(e, "folder", folder.id, label)}
        onDragOver={(e) => shared.onDragOverRow(e, "folder", folder.id)}
        onDragLeave={() => shared.onDragLeaveRow(folder.id)}
        onDrop={(e) => shared.onDrop(e, "folder", folder.id)}
      >
        <span
          className="drag-handle"
          draggable
          title={shared.dragHandleTitle}
          onDragStart={(e) => shared.onDragStart(e, "folder", folder.id)}
          onDragEnd={shared.onDragEnd}
        >
          &#x2630;
        </span>
        <button
          className="page-expand-btn"
          onClick={(e) => {
            e.stopPropagation();
            shared.onToggle(folder.id);
          }}
          tabIndex={-1}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : " "}
        </button>
        <span className="folder-icon" aria-hidden>
          &#128193;&#xFE0E;
        </span>
        {isRenaming ? (
          <input
            className="page-rename-input"
            autoFocus
            value={shared.renaming?.value ?? ""}
            onChange={(e) => shared.onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") shared.onSubmitRename();
              if (e.key === "Escape") shared.onCancelRename();
            }}
            onBlur={shared.onSubmitRename}
          />
        ) : (
          <button
            className="page-node-link folder-link"
            onClick={() => shared.onToggle(folder.id)}
          >
            {label}
          </button>
        )}
        <button
          className="page-add-sub-btn"
          title={shared.addSubfolderTitle}
          onClick={(e) => {
            e.stopPropagation();
            shared.onAddSubfolder(folder.id);
          }}
        >
          &#128193;&#xFE0E;+
        </button>
        <button
          className="page-add-sub-btn"
          title={shared.addSubpageTitle}
          onClick={(e) => {
            e.stopPropagation();
            shared.onAddSubPage("folder", folder.id, label);
          }}
        >
          +
        </button>
      </div>

      {isExpanded && hasChildren && (
        <div className="page-children">
          {childFolders.map((child) => (
            <FolderNode key={child.id} folder={child} {...shared} />
          ))}
          {childPages.map((child) => (
            <PageNode key={child.id} page={child} {...shared} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageNode({ page, ...shared }: { page: Page } & SharedNodeProps) {
  const children = shared.pageBucket.byPage.get(page.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = shared.expandedIds.has(page.id);
  const isRenaming =
    shared.renaming?.kind === "page" && shared.renaming.id === page.id;
  const title = page.title || shared.untitled;
  const indicator = dropIndicatorClass(shared.dragOver, page.id);

  return (
    <div className="page-node">
      <div
        className={`page-node-row${indicator}`}
        onContextMenu={(e) => shared.onContextMenu(e, "page", page.id, title)}
        onDragOver={(e) => shared.onDragOverRow(e, "page", page.id)}
        onDragLeave={() => shared.onDragLeaveRow(page.id)}
        onDrop={(e) => shared.onDrop(e, "page", page.id)}
      >
        <span
          className="drag-handle"
          draggable
          title={shared.dragHandleTitle}
          onDragStart={(e) => shared.onDragStart(e, "page", page.id)}
          onDragEnd={shared.onDragEnd}
        >
          &#x2630;
        </span>
        <button
          className="page-expand-btn"
          onClick={(e) => {
            e.stopPropagation();
            shared.onToggle(page.id);
          }}
          tabIndex={-1}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : " "}
        </button>
        {isRenaming ? (
          <input
            className="page-rename-input"
            autoFocus
            value={shared.renaming?.value ?? ""}
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
            className={({ isActive }) =>
              `page-node-link${isActive ? " active" : ""}`
            }
          >
            {title}
          </NavLink>
        )}

        <button
          className="page-add-sub-btn"
          title={shared.addSubpageTitle}
          onClick={(e) => {
            e.stopPropagation();
            shared.onAddSubPage("page", page.id, title);
          }}
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

export type { DropPosition };

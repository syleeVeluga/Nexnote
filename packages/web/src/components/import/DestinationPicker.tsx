import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  pages as pagesApi,
  folders as foldersApi,
  type Folder,
  type Page,
} from "../../lib/api-client.js";
import { bucketFolders, bucketPages } from "../../lib/explorer-tree.js";

export type DestinationValue =
  | { kind: "root" }
  | { kind: "folder"; folderId: string }
  | { kind: "page"; pageId: string };

interface DestinationPickerProps {
  workspaceId: string;
  value: DestinationValue;
  onChange: (next: DestinationValue) => void;
  /** Optional label shown above the picker. */
  label?: string;
  /** Optional id list (folders+pages) that should be hidden — e.g. moving a page should not let you pick its own subtree as destination. */
  hiddenFolderIds?: Set<string>;
  hiddenPageIds?: Set<string>;
}

const INDENT_PX = 14;

/**
 * Compact folder/page tree selector. Used by the import flow ("send this
 * ingestion into folder X") and by the sidebar move-with-fresh-extract
 * dialog. The picker fetches up to 200 folders + 200 pages once on mount
 * and renders them as an expandable list.
 */
export function DestinationPicker({
  workspaceId,
  value,
  onChange,
  label,
  hiddenFolderIds,
  hiddenPageIds,
}: DestinationPickerProps) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [foldersRes, pagesRes] = await Promise.all([
          foldersApi.list(workspaceId, { limit: 200 }),
          pagesApi.list(workspaceId, { limit: 200 }),
        ]);
        if (cancelled) return;
        setFolders(foldersRes.data);
        setPages(pagesRes.data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load tree");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const folderBucket = useMemo(() => bucketFolders(folders), [folders]);
  const pageBucket = useMemo(() => bucketPages(pages), [pages]);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isFolderHidden = (id: string) => hiddenFolderIds?.has(id) ?? false;
  const isPageHidden = (id: string) => hiddenPageIds?.has(id) ?? false;

  // Render a folder row + its children if expanded.
  const renderFolder = (folder: Folder, depth: number): ReactElement | null => {
    if (isFolderHidden(folder.id)) return null;
    const childFolders = folderBucket.byParent.get(folder.id) ?? [];
    const childPages = pageBucket.byFolder.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0 || childPages.length > 0;
    const key = `folder:${folder.id}`;
    const isOpen = expanded.has(key);
    const selected =
      value.kind === "folder" && value.folderId === folder.id;
    return (
      <div key={key}>
        <div
          className={`destination-picker-row${selected ? " selected" : ""}`}
          style={{ paddingLeft: depth * INDENT_PX }}
        >
          <button
            type="button"
            className="destination-picker-toggle"
            onClick={() => hasChildren && toggleExpand(key)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            disabled={!hasChildren}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
          </button>
          <button
            type="button"
            className="destination-picker-label"
            onClick={() =>
              onChange({ kind: "folder", folderId: folder.id })
            }
          >
            <span className="destination-picker-icon">📁</span>
            <span>{folder.name}</span>
          </button>
        </div>
        {isOpen && hasChildren && (
          <>
            {childFolders.map((f) => renderFolder(f, depth + 1))}
            {childPages.map((p) => renderPage(p, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderPage = (page: Page, depth: number): ReactElement | null => {
    if (isPageHidden(page.id)) return null;
    const childPages = pageBucket.byPage.get(page.id) ?? [];
    const hasChildren = childPages.length > 0;
    const key = `page:${page.id}`;
    const isOpen = expanded.has(key);
    const selected = value.kind === "page" && value.pageId === page.id;
    return (
      <div key={key}>
        <div
          className={`destination-picker-row${selected ? " selected" : ""}`}
          style={{ paddingLeft: depth * INDENT_PX }}
        >
          <button
            type="button"
            className="destination-picker-toggle"
            onClick={() => hasChildren && toggleExpand(key)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            disabled={!hasChildren}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
          </button>
          <button
            type="button"
            className="destination-picker-label"
            onClick={() => onChange({ kind: "page", pageId: page.id })}
          >
            <span className="destination-picker-icon">📄</span>
            <span>{page.title}</span>
          </button>
        </div>
        {isOpen && hasChildren && (
          <>{childPages.map((p) => renderPage(p, depth + 1))}</>
        )}
      </div>
    );
  };

  const rootFolders = folderBucket.byParent.get(null) ?? [];
  const rootPages = pageBucket.byFolder.get(null) ?? [];
  const rootSelected = value.kind === "root";

  return (
    <div className="destination-picker">
      {label && <div className="destination-picker-title">{label}</div>}
      {error && <div className="destination-picker-error">{error}</div>}
      {loading ? (
        <div className="destination-picker-loading">Loading…</div>
      ) : (
        <div className="destination-picker-tree">
          <div
            className={`destination-picker-row${rootSelected ? " selected" : ""}`}
            style={{ paddingLeft: 0 }}
          >
            <span className="destination-picker-toggle disabled">·</span>
            <button
              type="button"
              className="destination-picker-label"
              onClick={() => onChange({ kind: "root" })}
            >
              <span className="destination-picker-icon">🏠</span>
              <span>Workspace root</span>
            </button>
          </div>
          {rootFolders.map((f) => renderFolder(f, 1))}
          {rootPages.map((p) => renderPage(p, 1))}
        </div>
      )}
    </div>
  );
}

export function destinationToParams(value: DestinationValue): {
  targetFolderId: string | null;
  targetParentPageId: string | null;
} {
  if (value.kind === "folder")
    return { targetFolderId: value.folderId, targetParentPageId: null };
  if (value.kind === "page")
    return { targetFolderId: null, targetParentPageId: value.pageId };
  return { targetFolderId: null, targetParentPageId: null };
}

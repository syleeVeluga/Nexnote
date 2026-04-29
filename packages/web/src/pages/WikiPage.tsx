import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileText, Folder as FolderIcon, Plus } from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  folders as foldersApi,
  pages as pagesApi,
  type Folder,
  type Page,
} from "../lib/api-client.js";
import { PageShell } from "../components/ui/PageShell.js";
import { IconButton } from "../components/ui/IconButton.js";
import { Badge } from "../components/ui/Badge.js";
import { WikiDocumentTable } from "../components/wiki/WikiDocumentTable.js";

const FETCH_LIMIT = 200;

interface WikiData {
  folders: Folder[];
  pages: Page[];
  folderTotal: number;
  pageTotal: number;
}

interface FolderGroup {
  folder: Folder;
  path: string;
  pages: Page[];
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function folderPath(folder: Folder, folderById: Map<string, Folder>): string {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: Folder | undefined = folder;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current.name);
    current = current.parentFolderId
      ? folderById.get(current.parentFolderId)
      : undefined;
  }

  return chain.join(" / ");
}

function byRecentUpdate(a: Page, b: Page) {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function WikiPage() {
  const { t } = useTranslation(["pages", "common"]);
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<WikiData>({
    folders: [],
    pages: [],
    folderTotal: 0,
    pageTotal: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      foldersApi.list(current.id, { limit: FETCH_LIMIT }),
      pagesApi.list(current.id, { limit: FETCH_LIMIT }),
    ])
      .then(([folderRes, pageRes]) => {
        if (cancelled) return;
        setData({
          folders: folderRes.data,
          pages: pageRes.data,
          folderTotal: folderRes.total,
          pageTotal: pageRes.total,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setError(
          t("wiki.loadFailed", {
            defaultValue: "Could not load the document list.",
          }),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [current, t]);

  const folderById = useMemo(() => byId(data.folders), [data.folders]);
  const folderNames = useMemo(
    () => new Map(data.folders.map((folder) => [folder.id, folder.name])),
    [data.folders],
  );

  const rootPages = useMemo(
    () =>
      data.pages
        .filter((page) => !page.parentFolderId && !page.parentPageId)
        .sort(byRecentUpdate),
    [data.pages],
  );

  const folderGroups = useMemo<FolderGroup[]>(() => {
    return data.folders
      .map((folder) => ({
        folder,
        path: folderPath(folder, folderById),
        pages: data.pages
          .filter((page) => page.parentFolderId === folder.id)
          .sort(byRecentUpdate),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [data.folders, data.pages, folderById]);

  const visibleFolderGroups = useMemo(() => {
    if (data.pages.length === 0) return folderGroups;
    return folderGroups.filter((group) => group.pages.length > 0);
  }, [data.pages.length, folderGroups]);

  const truncated =
    data.folderTotal > data.folders.length ||
    data.pageTotal > data.pages.length;
  const empty = data.pages.length === 0 && data.folders.length === 0;

  if (!current) return null;

  return (
    <PageShell
      className="wiki-page wiki-list-page"
      title={t("wiki.title", { defaultValue: "Document List" })}
      description={t("wiki.description", {
        defaultValue: "All documents used by the assistant for answers.",
      })}
      actions={
        <IconButton
          icon={<Plus size={15} />}
          label={t("wiki.newDocument", { defaultValue: "New document" })}
          showLabel
          tone="primary"
          onClick={() => navigate("/pages/new")}
        />
      }
    >
      {error && <div className="form-error">{error}</div>}
      {!loading && truncated && (
        <p className="wiki-truncation-note">
          {t("wiki.truncationNote", {
            defaultValue:
              "Showing the first {{limit}} items per section. Open child folders to see the rest.",
            limit: FETCH_LIMIT,
          })}
        </p>
      )}
      {loading ? (
        <p className="loading">{t("common:loading")}</p>
      ) : empty ? (
        <div className="wiki-empty-table">
          {t("wiki.emptyList", {
            defaultValue: "No documents yet. Create your first document.",
          })}
        </div>
      ) : (
        <div className="wiki-list-stack">
          {rootPages.length > 0 && (
            <DocumentGroup
              icon={<FileText size={15} />}
              title={t("wiki.rootFolder", { defaultValue: "Top level" })}
              count={rootPages.length}
              pages={rootPages}
              emptyMessage={t("wiki.noRootPages", {
                defaultValue: "No top-level documents.",
              })}
              folderNames={folderNames}
              showFolder={false}
            />
          )}
          {visibleFolderGroups.map((group) => (
            <DocumentGroup
              key={group.folder.id}
              icon={<FolderIcon size={15} />}
              title={group.path}
              to={`/folders/${group.folder.id}`}
              count={group.pages.length}
              pages={group.pages}
              emptyMessage={t("wiki.noFolderPages", {
                defaultValue: "No direct documents in this folder.",
              })}
              folderNames={folderNames}
              showFolder={false}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function DocumentGroup({
  icon,
  title,
  to,
  count,
  pages,
  emptyMessage,
  folderNames,
  showFolder,
}: {
  icon: ReactNode;
  title: string;
  to?: string;
  count: number;
  pages: Page[];
  emptyMessage: string;
  folderNames: Map<string, string>;
  showFolder: boolean;
}) {
  return (
    <section className="wiki-document-group">
      <header className="wiki-document-group-header">
        <div className="wiki-document-group-title">
          <span className="wiki-document-group-icon" aria-hidden="true">
            {icon}
          </span>
          <h2>
            {to ? (
              <Link to={to} className="wiki-document-group-link">
                {title}
              </Link>
            ) : (
              title
            )}
          </h2>
          <Badge className="wiki-document-count" tone="warm" size="sm">
            {count}
          </Badge>
        </div>
      </header>
      <WikiDocumentTable
        pages={pages}
        emptyMessage={emptyMessage}
        folderNames={folderNames}
        showFolder={showFolder}
      />
    </section>
  );
}

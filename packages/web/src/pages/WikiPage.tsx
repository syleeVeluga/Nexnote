import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Bot,
  FileText,
  Folder as FolderIcon,
  Globe2,
  Plus,
  UploadCloud,
} from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import {
  folders as foldersApi,
  pages as pagesApi,
  type Folder,
  type Page,
} from "../lib/api-client.js";
import { PageShell } from "../components/ui/PageShell.js";
import { IconButton } from "../components/ui/IconButton.js";
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
  childFolderCount: number;
  latestUpdatedAt: string;
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

function latestDate(values: string[], fallback: string): string {
  return values.length > 0 ? values.sort().at(-1)! : fallback;
}

export function WikiPage() {
  const { t } = useTranslation(["pages", "common"]);
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();
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
            defaultValue: "Could not load the wiki index.",
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
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.pages],
  );

  const folderGroups = useMemo<FolderGroup[]>(() => {
    return data.folders
      .map((folder) => {
        const directPages = data.pages
          .filter((page) => page.parentFolderId === folder.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const childFolderCount = data.folders.filter(
          (child) => child.parentFolderId === folder.id,
        ).length;
        const latestUpdatedAt = latestDate(
          [
            folder.updatedAt,
            ...directPages.map((page) => page.updatedAt),
          ],
          folder.updatedAt,
        );
        return {
          folder,
          path: folderPath(folder, folderById),
          pages: directPages,
          childFolderCount,
          latestUpdatedAt,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [data.folders, data.pages, folderById]);

  const stats = useMemo(() => {
    return {
      published: data.pages.filter((page) => page.status === "published")
        .length,
      aiTouched: data.pages.filter((page) => page.lastAiUpdatedAt).length,
    };
  }, [data.pages]);

  const truncated =
    data.folderTotal > data.folders.length ||
    data.pageTotal > data.pages.length;

  if (!current) return null;

  return (
    <PageShell
      className="wiki-page"
      eyebrow={t("wiki.eyebrow", { defaultValue: "Company Wiki" })}
      title={t("wiki.title", { defaultValue: "Company Wiki" })}
      description={t("wiki.description", {
        defaultValue:
          "Browse folders, check publication status, and open documents from one workspace-wide table.",
      })}
      actions={
        <>
          <IconButton
            icon={<UploadCloud size={15} />}
            label={t("common:import")}
            showLabel
            tone="quiet"
            onClick={() => navigate("/import")}
          />
          <IconButton
            icon={<Plus size={15} />}
            label={t("common:newPage")}
            showLabel
            tone="primary"
            onClick={() => navigate("/pages/new")}
          />
        </>
      }
    >
      <div className="wiki-stat-grid" aria-busy={loading}>
        <WikiStat
          icon={<FileText size={17} />}
          label={t("wiki.stats.documents", { defaultValue: "Documents" })}
          value={data.pageTotal}
        />
        <WikiStat
          icon={<FolderIcon size={17} />}
          label={t("wiki.stats.folders", { defaultValue: "Folders" })}
          value={data.folderTotal}
        />
        <WikiStat
          icon={<Globe2 size={17} />}
          label={t("wiki.stats.published", { defaultValue: "Published" })}
          value={stats.published}
        />
        <WikiStat
          icon={<Bot size={17} />}
          label={t("wiki.stats.aiTouched", { defaultValue: "AI updated" })}
          value={stats.aiTouched}
        />
      </div>

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
      ) : (
        <>
          <section className="wiki-section">
            <header className="wiki-section-header">
              <div>
                <h2>
                  {t("wiki.folderSection", { defaultValue: "Folders" })}
                </h2>
                <p>
                  {t("wiki.folderSectionDescription", {
                    defaultValue:
                      "Open a folder to see its direct child folders and documents.",
                  })}
                </p>
              </div>
            </header>
            {folderGroups.length === 0 ? (
              <div className="wiki-empty-table">
                {t("wiki.noFolders", {
                  defaultValue: "No folders yet.",
                })}
              </div>
            ) : (
              <div className="wiki-folder-grid">
                {folderGroups.map((group) => (
                  <Link
                    key={group.folder.id}
                    to={`/folders/${group.folder.id}`}
                    className="wiki-folder-card"
                  >
                    <span className="wiki-folder-card-icon" aria-hidden="true">
                      <FolderIcon size={17} />
                    </span>
                    <span className="wiki-folder-card-body">
                      <strong>{group.path}</strong>
                      <small>
                        {t("wiki.folderCardMeta", {
                          defaultValue:
                            "{{pages}} docs, {{folders}} folders, {{updated}}",
                          pages: group.pages.length,
                          folders: group.childFolderCount,
                          updated: timeAgo(group.latestUpdatedAt),
                        })}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="wiki-section">
            <header className="wiki-section-header">
              <div>
                <h2>
                  {t("wiki.documentsByFolder", {
                    defaultValue: "Documents by folder",
                  })}
                </h2>
                <p>
                  {t("wiki.documentsByFolderDescription", {
                    defaultValue:
                      "Status is based on the current page state; registration source will become more precise after the page summary DTO lands.",
                  })}
                </p>
              </div>
            </header>

            {rootPages.length === 0 && folderGroups.length === 0 ? (
              <div className="wiki-empty-table">
                {t("emptyState", {
                  defaultValue:
                    "No pages yet. Create your first page to get started.",
                })}
              </div>
            ) : (
              <div className="wiki-group-stack">
                <DocumentGroup
                  title={t("wiki.rootFolder", { defaultValue: "Top level" })}
                  subtitle={t("wiki.groupMeta", {
                    defaultValue: "{{count}} documents",
                    count: rootPages.length,
                  })}
                  pages={rootPages}
                  emptyMessage={t("wiki.noRootPages", {
                    defaultValue: "No top-level documents.",
                  })}
                  folderNames={folderNames}
                  showFolder={false}
                />
                {folderGroups.map((group) => (
                  <DocumentGroup
                    key={group.folder.id}
                    title={group.path}
                    subtitle={t("wiki.folderGroupMeta", {
                      defaultValue: "{{count}} documents, updated {{updated}}",
                      count: group.pages.length,
                      updated: timeAgo(group.latestUpdatedAt),
                    })}
                    pages={group.pages}
                    emptyMessage={t("wiki.noFolderPages", {
                      defaultValue: "No direct documents in this folder.",
                    })}
                    folderNames={folderNames}
                    showFolder={false}
                    action={
                      <Link
                        to={`/folders/${group.folder.id}`}
                        className="wiki-section-link"
                      >
                        {t("wiki.openFolder", {
                          defaultValue: "Open folder",
                        })}
                      </Link>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </PageShell>
  );
}

function WikiStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <article className="wiki-stat">
      <span className="wiki-stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function DocumentGroup({
  title,
  subtitle,
  pages,
  emptyMessage,
  folderNames,
  showFolder,
  action,
}: {
  title: string;
  subtitle: string;
  pages: Page[];
  emptyMessage: string;
  folderNames: Map<string, string>;
  showFolder: boolean;
  action?: ReactNode;
}) {
  return (
    <section className="wiki-document-group">
      <header className="wiki-document-group-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {action}
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

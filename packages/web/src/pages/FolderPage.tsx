import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  FileText,
  Folder as FolderIcon,
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

interface FolderData {
  folder: Folder | null;
  childFolders: Folder[];
  directPages: Page[];
  childFolderTotal: number;
  directPageTotal: number;
}

const EMPTY_DATA: FolderData = {
  folder: null,
  childFolders: [],
  directPages: [],
  childFolderTotal: 0,
  directPageTotal: 0,
};

export function FolderPage() {
  const { t } = useTranslation(["pages", "common"]);
  const { folderId } = useParams();
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();
  const [data, setData] = useState<FolderData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current || !folderId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      foldersApi.get(current.id, folderId),
      foldersApi.list(current.id, { parentFolderId: folderId, limit: FETCH_LIMIT }),
      pagesApi.list(current.id, { parentFolderId: folderId, limit: FETCH_LIMIT }),
    ])
      .then(([folderRes, childFolderRes, pageRes]) => {
        if (cancelled) return;
        setData({
          folder: folderRes.data,
          childFolders: childFolderRes.data,
          directPages: pageRes.data,
          childFolderTotal: childFolderRes.total,
          directPageTotal: pageRes.total,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setError(
          t("wiki.folderLoadFailed", {
            defaultValue: "Could not load this folder.",
          }),
        );
        setData(EMPTY_DATA);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [current, folderId, t]);

  const sortedChildFolders = useMemo(
    () =>
      [...data.childFolders].sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [data.childFolders],
  );

  const sortedDirectPages = useMemo(
    () =>
      [...data.directPages].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    [data.directPages],
  );

  if (!current || !folderId) return null;

  const folder = data.folder;
  const title =
    folder?.name ??
    t("wiki.folderFallbackTitle", { defaultValue: "Folder" });
  const newPageUrl = folder
    ? `/pages/new?parentFolderId=${folder.id}&parentTitle=${encodeURIComponent(folder.name)}`
    : "/pages/new";
  const parentFolderId = folder?.parentFolderId ?? null;
  const truncated =
    data.childFolderTotal > data.childFolders.length ||
    data.directPageTotal > data.directPages.length;

  return (
    <PageShell
      className="wiki-page folder-page"
      eyebrow={t("wiki.folderEyebrow", { defaultValue: "Wiki folder" })}
      title={title}
      description={
        loading
          ? t("common:loading")
          : t("wiki.folderDescription", {
              defaultValue:
                "{{pages}} direct documents and {{folders}} child folders.",
              pages: data.directPageTotal,
              folders: data.childFolderTotal,
            })
      }
      actions={
        <>
          <IconButton
            icon={<ArrowLeft size={15} />}
            label={
              parentFolderId
                ? t("wiki.parentFolder", { defaultValue: "Parent folder" })
                : t("wiki.backToWiki", { defaultValue: "Back to wiki" })
            }
            showLabel
            tone="quiet"
            onClick={() =>
              navigate(
                parentFolderId ? `/folders/${parentFolderId}` : "/wiki",
              )
            }
          />
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
            onClick={() => navigate(newPageUrl)}
          />
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {loading ? (
        <p className="loading">{t("common:loading")}</p>
      ) : !folder ? (
        <div className="wiki-empty-table">
          {t("wiki.folderMissing", {
            defaultValue: "This folder no longer exists.",
          })}
        </div>
      ) : (
        <div className="folder-page-grid">
          <section className="wiki-section folder-summary-section">
            <header className="wiki-section-header">
              <div>
                <h2>
                  {t("wiki.folderContents", {
                    defaultValue: "Folder contents",
                  })}
                </h2>
                <p>{folder.name}</p>
              </div>
            </header>
            <div className="folder-summary-grid">
              <FolderMetric
                icon={<FileText size={16} />}
                label={t("wiki.stats.documents", {
                  defaultValue: "Documents",
                })}
                value={data.directPageTotal}
              />
              <FolderMetric
                icon={<FolderIcon size={16} />}
                label={t("wiki.stats.folders", { defaultValue: "Folders" })}
                value={data.childFolderTotal}
              />
            </div>
          </section>

          {truncated && (
            <p className="wiki-truncation-note">
              {t("wiki.truncationNote", {
                defaultValue:
                  "Showing the first {{limit}} items per section. Open child folders to see the rest.",
                limit: FETCH_LIMIT,
              })}
            </p>
          )}

          {sortedChildFolders.length > 0 && (
            <section className="wiki-section">
              <header className="wiki-section-header">
                <div>
                  <h2>
                    {t("wiki.childFolders", {
                      defaultValue: "Child folders",
                    })}
                  </h2>
                  <p>
                    {t("wiki.childFoldersDescription", {
                      defaultValue:
                        "Drill into a child folder to see its direct documents.",
                    })}
                  </p>
                </div>
              </header>
              <div className="wiki-folder-grid">
                {sortedChildFolders.map((childFolder) => (
                  <Link
                    key={childFolder.id}
                    to={`/folders/${childFolder.id}`}
                    className="wiki-folder-card"
                  >
                    <span className="wiki-folder-card-icon" aria-hidden="true">
                      <FolderIcon size={17} />
                    </span>
                    <span className="wiki-folder-card-body">
                      <strong>{childFolder.name}</strong>
                      <small>
                        {t("wiki.childFolderUpdated", {
                          defaultValue: "Updated {{updated}}",
                          updated: timeAgo(childFolder.updatedAt),
                        })}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="wiki-document-group">
            <header className="wiki-document-group-header">
              <div>
                <h3>
                  {t("wiki.directDocuments", {
                    defaultValue: "Direct documents",
                  })}
                </h3>
                <p>
                  {t("wiki.groupMeta", {
                    defaultValue: "{{count}} documents",
                    count: data.directPageTotal,
                  })}
                </p>
              </div>
            </header>
            <WikiDocumentTable
              pages={sortedDirectPages}
              emptyMessage={t("wiki.noFolderPages", {
                defaultValue: "No direct documents in this folder.",
              })}
            />
          </section>
        </div>
      )}
    </PageShell>
  );
}

function FolderMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <article className="folder-metric">
      <span className="folder-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

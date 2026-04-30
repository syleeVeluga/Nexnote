import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  folders as foldersApi,
  pages as pagesApi,
  type Folder,
  type Page,
  type Workspace,
} from "../../lib/api-client.js";

interface TopBarCrumb {
  label: string;
  to?: string;
}

interface BreadcrumbsProps {
  breadcrumbs: TopBarCrumb[];
}

function extractRouteId(pathname: string, prefix: string): string | null {
  const match = new RegExp(`^/${prefix}/([^/]+)`).exec(pathname);
  return match?.[1] ?? null;
}

function requiresTree(pathname: string): boolean {
  return pathname.startsWith("/pages/") || pathname.startsWith("/folders/");
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function folderChain(
  folderId: string | null | undefined,
  foldersById: Map<string, Folder>,
): TopBarCrumb[] {
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let currentId = folderId ?? null;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const folder = foldersById.get(currentId);
    if (!folder) break;
    chain.unshift(folder);
    currentId = folder.parentFolderId;
  }

  return chain.map((folder) => ({
    label: folder.name,
    to: `/folders/${folder.id}`,
  }));
}

function pageChain(pageId: string, pagesById: Map<string, Page>): Page[] {
  const chain: Page[] = [];
  const seen = new Set<string>();
  let current = pagesById.get(pageId) ?? null;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentPageId
      ? (pagesById.get(current.parentPageId) ?? null)
      : null;
  }

  return chain;
}

export function useWorkspaceBreadcrumbs(
  workspace: Workspace | null,
): TopBarCrumb[] {
  const { t } = useTranslation("common");
  const location = useLocation();
  const [pages, setPages] = useState<Page[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);

  useEffect(() => {
    if (!workspace || !requiresTree(location.pathname)) {
      setPages([]);
      setFolders([]);
      return;
    }

    let cancelled = false;
    Promise.all([
      pagesApi.list(workspace.id, { limit: 200 }),
      foldersApi.list(workspace.id, { limit: 200 }),
    ])
      .then(([pageRes, folderRes]) => {
        if (cancelled) return;
        setPages(pageRes.data);
        setFolders(folderRes.data);
      })
      .catch(() => {
        if (cancelled) return;
        setPages([]);
        setFolders([]);
      });

    return () => {
      cancelled = true;
    };
  }, [location.pathname, workspace]);

  return useMemo(() => {
    if (!workspace) return [];

    const root: TopBarCrumb[] = [{ label: workspace.name, to: "/" }];
    const wiki = { label: t("wiki"), to: "/wiki" };
    const path = location.pathname;
    const pagesById = byId(pages);
    const foldersById = byId(folders);

    if (path === "/") {
      return [...root, { label: t("dashboard") }];
    }

    if (path.startsWith("/review")) {
      return [...root, { label: t("review") }];
    }

    if (path.startsWith("/ingestions/")) {
      return [
        ...root,
        { label: t("review"), to: "/review" },
        { label: t("ingestionBreadcrumb", { defaultValue: "Ingestion" }) },
      ];
    }

    if (path.startsWith("/import")) {
      return [...root, { label: t("import") }];
    }

    if (path.startsWith("/activity")) {
      return [...root, { label: t("activity") }];
    }

    if (path.startsWith("/settings/ai")) {
      return [
        ...root,
        { label: t("aiSettings", { defaultValue: "AI Settings" }) },
      ];
    }

    if (path.startsWith("/system/tokens")) {
      return [
        ...root,
        {
          label: t("systemStatus", { defaultValue: "System Status" }),
          to: "/system",
        },
        { label: t("apiTokens", { defaultValue: "API Tokens" }) },
      ];
    }

    if (path.startsWith("/admin/queues") || path.startsWith("/system")) {
      return [
        ...root,
        { label: t("systemStatus", { defaultValue: "System Status" }) },
      ];
    }

    if (path.startsWith("/trash")) {
      return [...root, { label: t("trash") }];
    }

    if (path.startsWith("/wiki")) {
      return [...root, { label: t("wiki") }];
    }

    if (path.startsWith("/pages/new")) {
      return [
        ...root,
        wiki,
        { label: t("newPageBreadcrumb", { defaultValue: t("newPage") }) },
      ];
    }

    const pageId = extractRouteId(path, "pages");
    if (pageId) {
      const chain = pageChain(pageId, pagesById);
      const firstPage = chain[0];
      const folderCrumbs = folderChain(firstPage?.parentFolderId, foldersById);
      const pageCrumbs = chain.map((page) => ({
        label: page.title || t("untitled"),
        to: `/pages/${page.id}`,
      }));

      return [
        ...root,
        wiki,
        ...folderCrumbs,
        ...(pageCrumbs.length > 0
          ? pageCrumbs
          : [{ label: t("pagesSingular") }]),
      ];
    }

    const folderId = extractRouteId(path, "folders");
    if (folderId) {
      return [...root, wiki, ...folderChain(folderId, foldersById)];
    }

    return root;
  }, [folders, location.pathname, pages, t, workspace]);
}

export function Breadcrumbs({ breadcrumbs }: BreadcrumbsProps) {
  return (
    <nav className="top-bar-breadcrumbs" aria-label="Breadcrumb">
      {breadcrumbs.map((crumb, index) => {
        const current = index === breadcrumbs.length - 1;
        const label = <span>{crumb.label}</span>;

        return (
          <span key={`${crumb.label}-${index}`} className="top-bar-crumb">
            {crumb.to && !current ? (
              <NavLink to={crumb.to}>{label}</NavLink>
            ) : (
              <span className={current ? "current" : ""}>{label}</span>
            )}
            {!current && <ChevronRight size={12} aria-hidden="true" />}
          </span>
        );
      })}
    </nav>
  );
}

export type { TopBarCrumb };

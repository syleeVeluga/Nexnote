import { sql } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle tx/db don't share a clean type
type AnyDb = any;

function rowsFromExecuteResult<T>(result: unknown): T[] {
  const rows =
    (result as { rows?: T[] } | undefined)?.rows ?? (result as T[] | undefined);
  return Array.isArray(rows) ? rows : [];
}

export interface FolderDescendantPagesResult {
  pageIds: string[];
  truncated: boolean;
}

export async function collectFolderDescendantPages(
  db: AnyDb,
  workspaceId: string,
  rootFolderId: string,
  opts: { includeDeleted?: boolean; maxPageIds?: number } = {},
): Promise<FolderDescendantPagesResult> {
  const deletedFilter = opts.includeDeleted
    ? sql``
    : sql`AND p."deleted_at" IS NULL`;
  const maxPageIds =
    typeof opts.maxPageIds === "number" && opts.maxPageIds > 0
      ? Math.floor(opts.maxPageIds)
      : null;
  const limitSql = maxPageIds === null ? sql`` : sql`LIMIT ${maxPageIds + 1}`;

  const rows = await db.execute(sql`
    WITH RECURSIVE folder_tree AS (
      SELECT f."id", 0 AS depth
      FROM "folders" f
      WHERE f."id" = ${rootFolderId}
        AND f."workspace_id" = ${workspaceId}
      UNION ALL
      SELECT f."id", t.depth + 1
      FROM "folders" f
      INNER JOIN folder_tree t ON f."parent_folder_id" = t."id"
      WHERE f."workspace_id" = ${workspaceId}
    ),
    folder_pages AS (
      SELECT p."id", t.depth AS folder_depth, 0 AS page_depth
      FROM "pages" p
      INNER JOIN folder_tree t ON p."parent_folder_id" = t."id"
      WHERE p."workspace_id" = ${workspaceId}
        ${deletedFilter}
      UNION ALL
      SELECT p."id", fp.folder_depth, fp.page_depth + 1
      FROM "pages" p
      INNER JOIN folder_pages fp ON p."parent_page_id" = fp."id"
      WHERE p."workspace_id" = ${workspaceId}
        ${deletedFilter}
    )
    SELECT "id"
    FROM (
      SELECT "id", MIN(folder_depth) AS folder_depth, MIN(page_depth) AS page_depth
      FROM folder_pages
      GROUP BY "id"
    ) fp
    ORDER BY folder_depth ASC, page_depth ASC, "id" ASC
    ${limitSql}
  `);

  const pageIds = rowsFromExecuteResult<{ id: string }>(rows).map(
    (row) => row.id,
  );
  const truncated = maxPageIds !== null && pageIds.length > maxPageIds;

  return {
    pageIds: truncated ? pageIds.slice(0, maxPageIds) : pageIds,
    truncated,
  };
}

export async function collectFolderDescendantPageIds(
  db: AnyDb,
  workspaceId: string,
  rootFolderId: string,
  opts: { includeDeleted?: boolean; maxPageIds?: number } = {},
): Promise<string[]> {
  const result = await collectFolderDescendantPages(
    db,
    workspaceId,
    rootFolderId,
    opts,
  );
  return result.pageIds;
}

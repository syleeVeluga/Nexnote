import { sql } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle tx/db don't share a clean type
type AnyDb = any;

function rowsFromExecuteResult<T>(result: unknown): T[] {
  const rows =
    (result as { rows?: T[] } | undefined)?.rows ?? (result as T[] | undefined);
  return Array.isArray(rows) ? rows : [];
}

export async function collectFolderDescendantPageIds(
  db: AnyDb,
  workspaceId: string,
  rootFolderId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<string[]> {
  const includeDeleted = opts.includeDeleted === true;
  const rows = await db.execute(sql`
    WITH RECURSIVE folder_tree AS (
      SELECT f."id"
      FROM "folders" f
      WHERE f."id" = ${rootFolderId}
        AND f."workspace_id" = ${workspaceId}
      UNION ALL
      SELECT f."id"
      FROM "folders" f
      INNER JOIN folder_tree t ON f."parent_folder_id" = t."id"
      WHERE f."workspace_id" = ${workspaceId}
    ),
    folder_pages AS (
      SELECT p."id"
      FROM "pages" p
      WHERE p."workspace_id" = ${workspaceId}
        AND p."parent_folder_id" IN (SELECT "id" FROM folder_tree)
        AND (p."deleted_at" IS NULL OR ${includeDeleted})
      UNION ALL
      SELECT p."id"
      FROM "pages" p
      INNER JOIN folder_pages fp ON p."parent_page_id" = fp."id"
      WHERE p."workspace_id" = ${workspaceId}
        AND (p."deleted_at" IS NULL OR ${includeDeleted})
    )
    SELECT DISTINCT "id" FROM folder_pages
  `);

  return rowsFromExecuteResult<{ id: string }>(rows).map((row) => row.id);
}

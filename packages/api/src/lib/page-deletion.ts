import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ERROR_CODES } from "@nexnote/shared";
import {
  auditLogs,
  pagePaths,
  pages,
  publishedSnapshots,
  triples,
} from "@nexnote/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle tx/db don't share a clean type
type AnyDb = any;

export class PageDeletionError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PageDeletionError";
  }
}

export async function collectDescendantPageIds(
  db: AnyDb,
  workspaceId: string,
  rootId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<string[]> {
  const filter = opts.includeDeleted
    ? sql``
    : sql`AND p."deleted_at" IS NULL`;
  const rows = await db.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT p."id", 0 AS depth
      FROM "pages" p
      WHERE p."id" = ${rootId}
        AND p."workspace_id" = ${workspaceId}
      UNION ALL
      SELECT p."id", d.depth + 1
      FROM "pages" p
      INNER JOIN descendants d ON p."parent_page_id" = d."id"
      WHERE p."workspace_id" = ${workspaceId}
        ${filter}
    )
    SELECT "id" FROM descendants ORDER BY depth ASC
  `);
  const arr = (rows as unknown as { rows?: Array<{ id: string }> }).rows ??
    (rows as unknown as Array<{ id: string }>);
  return (Array.isArray(arr) ? arr : []).map((r) => r.id);
}

export interface SoftDeleteInput {
  workspaceId: string;
  rootPageId: string;
  userId: string;
}

export interface SoftDeleteResult {
  deletedPageIds: string[];
  rootTitle: string;
}

/** Throws `PageDeletionError(PUBLISHED_BLOCK)` if any subtree page is live — */
/** the caller must unpublish first. Triples transition to 'page_deleted' so  */
/** the graph drops them atomically with the page soft-delete.                */
export async function softDeleteSubtree(
  db: AnyDb,
  input: SoftDeleteInput,
): Promise<SoftDeleteResult> {
  const { workspaceId, rootPageId, userId } = input;

  return await db.transaction(async (tx: AnyDb) => {
    const [root] = await tx
      .select({ id: pages.id, title: pages.title, deletedAt: pages.deletedAt })
      .from(pages)
      .where(
        and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!root) throw new PageDeletionError(ERROR_CODES.PAGE_NOT_FOUND);
    if (root.deletedAt) {
      return { deletedPageIds: [], rootTitle: root.title };
    }

    const subtreeIds = await collectDescendantPageIds(
      tx,
      workspaceId,
      rootPageId,
    );
    if (subtreeIds.length === 0) {
      return { deletedPageIds: [], rootTitle: root.title };
    }

    // Lock before the publish check to avoid racing with a concurrent publish.
    await tx.execute(
      sql`SELECT 1 FROM "pages" WHERE "id" = ANY(${subtreeIds}::uuid[]) FOR UPDATE`,
    );

    const liveRows = await tx
      .select({ pageId: publishedSnapshots.pageId, id: publishedSnapshots.id })
      .from(publishedSnapshots)
      .where(
        and(
          inArray(publishedSnapshots.pageId, subtreeIds),
          eq(publishedSnapshots.isLive, true),
        ),
      );

    if (liveRows.length > 0) {
      throw new PageDeletionError(ERROR_CODES.PUBLISHED_BLOCK, {
        liveSnapshots: liveRows,
      });
    }

    await tx
      .update(pages)
      .set({
        deletedAt: sql`now()`,
        deletedByUserId: userId,
        updatedAt: sql`now()`,
      })
      .where(inArray(pages.id, subtreeIds));

    // search_vector lives outside the drizzle schema — clear it so FTS hides
    // the page even if a caller forgets the deleted_at filter.
    await tx.execute(
      sql`UPDATE "pages" SET "search_vector" = NULL WHERE "id" = ANY(${subtreeIds}::uuid[])`,
    );

    await tx
      .update(triples)
      .set({ status: "page_deleted" })
      .where(
        and(
          inArray(triples.sourcePageId, subtreeIds),
          eq(triples.status, "active"),
        ),
      );

    await tx
      .update(pagePaths)
      .set({ isCurrent: false })
      .where(
        and(
          inArray(pagePaths.pageId, subtreeIds),
          eq(pagePaths.isCurrent, true),
        ),
      );

    await tx.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "page",
      entityId: rootPageId,
      action: "delete",
      beforeJson: {
        id: root.id,
        title: root.title,
        descendantIds: subtreeIds,
      },
    });

    return { deletedPageIds: subtreeIds, rootTitle: root.title };
  });
}

export interface RestoreInput {
  workspaceId: string;
  rootPageId: string;
  userId: string;
}

export interface RestoreResult {
  restoredPageIds: string[];
  rootTitle: string;
}

/** Detaches from a still-deleted parent so restored pages have a stable landing */
/** spot (they reappear at the root). Slug conflicts with an active page surface */
/** as SLUG_CONFLICT so the user can rename before retrying.                     */
export async function restoreSubtree(
  db: AnyDb,
  input: RestoreInput,
): Promise<RestoreResult> {
  const { workspaceId, rootPageId, userId } = input;

  return await db.transaction(async (tx: AnyDb) => {
    const [root] = await tx
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        parentPageId: pages.parentPageId,
        deletedAt: pages.deletedAt,
      })
      .from(pages)
      .where(
        and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!root) throw new PageDeletionError(ERROR_CODES.PAGE_NOT_FOUND);
    if (!root.deletedAt) {
      return { restoredPageIds: [], rootTitle: root.title };
    }

    const subtreeIds = await collectDescendantPageIds(
      tx,
      workspaceId,
      rootPageId,
      { includeDeleted: true },
    );

    await tx.execute(
      sql`SELECT 1 FROM "pages" WHERE "id" = ANY(${subtreeIds}::uuid[]) FOR UPDATE`,
    );

    // Pre-check so we can return the conflicting page's title; relying on the
    // partial unique index alone would only expose a generic constraint error.
    const [conflict] = await tx
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.slug, root.slug),
          isNull(pages.deletedAt),
        ),
      )
      .limit(1);
    if (conflict) {
      throw new PageDeletionError(ERROR_CODES.SLUG_CONFLICT, {
        conflictingPageId: conflict.id,
        conflictingTitle: conflict.title,
        slug: root.slug,
      });
    }

    let detachedFromParent: string | null = null;
    if (root.parentPageId) {
      const [parent] = await tx
        .select({ id: pages.id, deletedAt: pages.deletedAt })
        .from(pages)
        .where(eq(pages.id, root.parentPageId))
        .limit(1);
      if (parent && parent.deletedAt) {
        detachedFromParent = parent.id;
        await tx
          .update(pages)
          .set({ parentPageId: null, updatedAt: sql`now()` })
          .where(eq(pages.id, rootPageId));
      }
    }

    await tx
      .update(pages)
      .set({
        deletedAt: null,
        deletedByUserId: null,
        updatedAt: sql`now()`,
      })
      .where(inArray(pages.id, subtreeIds));

    await tx
      .update(triples)
      .set({ status: "active" })
      .where(
        and(
          inArray(triples.sourcePageId, subtreeIds),
          eq(triples.status, "page_deleted"),
        ),
      );

    // Flip is_current back on for the newest path per restored page in one go.
    await tx.execute(sql`
      UPDATE "page_paths" SET "is_current" = true
      WHERE "id" IN (
        SELECT DISTINCT ON ("page_id") "id"
        FROM "page_paths"
        WHERE "page_id" = ANY(${subtreeIds}::uuid[])
        ORDER BY "page_id", "created_at" DESC
      )
    `);

    await tx.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "page",
      entityId: rootPageId,
      action: "restore",
      afterJson: {
        id: root.id,
        title: root.title,
        restoredIds: subtreeIds,
        detachedFromParent,
      },
    });

    return { restoredPageIds: subtreeIds, rootTitle: root.title };
  });
}

export interface PurgeInput {
  workspaceId: string;
  rootPageId: string;
  userId: string;
}

/** After FK-cascade wipes triples, cleans up entities orphaned by the purge. */
/** Entities are workspace-scoped and created only alongside triples, so the  */
/** cleanup is limited to entities whose sole source pages were in this subtree. */
export async function purgeSubtree(
  db: AnyDb,
  input: PurgeInput,
): Promise<{ purgedPageIds: string[] }> {
  const { workspaceId, rootPageId, userId } = input;

  const result = await db.transaction(async (tx: AnyDb) => {
    const [root] = await tx
      .select({ id: pages.id, title: pages.title, deletedAt: pages.deletedAt })
      .from(pages)
      .where(
        and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!root) throw new PageDeletionError(ERROR_CODES.PAGE_NOT_FOUND);
    if (!root.deletedAt) {
      throw new PageDeletionError(ERROR_CODES.PAGE_NOT_TRASHED);
    }

    const subtreeIds = await collectDescendantPageIds(
      tx,
      workspaceId,
      rootPageId,
      { includeDeleted: true },
    );
    if (subtreeIds.length === 0) {
      return { purgedPageIds: [] };
    }

    await tx
      .update(pages)
      .set({ currentRevisionId: null, latestPublishedSnapshotId: null })
      .where(inArray(pages.id, subtreeIds));

    await tx.insert(auditLogs).values({
      workspaceId,
      userId,
      entityType: "page",
      entityId: rootPageId,
      action: "purge",
      beforeJson: { id: root.id, title: root.title, purgedIds: subtreeIds },
    });

    await tx.delete(pages).where(inArray(pages.id, subtreeIds));

    return { purgedPageIds: subtreeIds };
  });

  await db.execute(sql`
    DELETE FROM "entities" e
    WHERE e."workspace_id" = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1 FROM "triples" t
        WHERE t."workspace_id" = ${workspaceId}
          AND (t."subject_entity_id" = e."id" OR t."object_entity_id" = e."id")
          AND t."status" = 'active'
      )
  `);

  return result;
}

/** Filter shorthand for all READ paths — spread into `and(...)` clauses. */
export function notDeleted() {
  return isNull(pages.deletedAt);
}

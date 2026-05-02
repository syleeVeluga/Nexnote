import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ERROR_CODES } from "@wekiflow/shared";
import {
  auditLogs,
  ingestionDecisions,
  ingestions,
  pagePaths,
  pages,
  publishedSnapshots,
  triples,
} from "./schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle tx/db don't share a clean type
type AnyDb = any;

// postgres-js renders a JS array interpolated into a sql`` template as a
// record (`('a','b',...)`), which PostgreSQL refuses to cast to `uuid[]`.
// We render each id as its own parameter and join them so the query becomes
// `IN ($1::uuid, $2::uuid, …)` — safe and index-friendly.
export function sqlUuidList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

function sqlTextList(values: string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

function toEpochMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

export interface RestorePageSnapshot {
  id: string;
  title: string;
  slug: string;
  deletedAt: Date | string | null;
}

export interface RestorePathSnapshot {
  pageId: string;
  path: string;
}

export interface RestoreConflict {
  kind: "slug" | "path";
  restoringPageId: string;
  restoringTitle: string;
  conflictingPageId: string;
  conflictingTitle: string;
  slug?: string;
  path?: string;
}

export function selectPagesDeletedWithRoot(
  pagesToRestore: RestorePageSnapshot[],
  rootDeletedAt: Date | string | null,
): RestorePageSnapshot[] {
  const rootDeletedAtMs = toEpochMillis(rootDeletedAt);
  if (rootDeletedAtMs === null) return [];
  return pagesToRestore.filter(
    (page) => toEpochMillis(page.deletedAt) === rootDeletedAtMs,
  );
}

export function findRestoreConflict(input: {
  restoringPages: RestorePageSnapshot[];
  restoringPaths: RestorePathSnapshot[];
  activePages: Array<{ id: string; title: string; slug: string }>;
  activePaths: Array<{ pageId: string; title: string; path: string }>;
}): RestoreConflict | null {
  const activePageBySlug = new Map(
    input.activePages.map((page) => [page.slug, page]),
  );

  for (const page of input.restoringPages) {
    const conflict = activePageBySlug.get(page.slug);
    if (conflict) {
      return {
        kind: "slug",
        restoringPageId: page.id,
        restoringTitle: page.title,
        conflictingPageId: conflict.id,
        conflictingTitle: conflict.title,
        slug: page.slug,
      };
    }
  }

  const restoringPageById = new Map(
    input.restoringPages.map((page) => [page.id, page]),
  );
  const activePathByValue = new Map(
    input.activePaths.map((path) => [path.path, path]),
  );

  for (const path of input.restoringPaths) {
    const conflict = activePathByValue.get(path.path);
    if (!conflict) continue;
    const restoringPage = restoringPageById.get(path.pageId);
    if (!restoringPage) continue;
    return {
      kind: "path",
      restoringPageId: restoringPage.id,
      restoringTitle: restoringPage.title,
      conflictingPageId: conflict.pageId,
      conflictingTitle: conflict.title,
      path: path.path,
    };
  }

  return null;
}

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
  const filter = opts.includeDeleted ? sql`` : sql`AND p."deleted_at" IS NULL`;
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
  const arr =
    (rows as unknown as { rows?: Array<{ id: string }> }).rows ??
    (rows as unknown as Array<{ id: string }>);
  return (Array.isArray(arr) ? arr : []).map((r) => r.id);
}

export interface SoftDeleteInput {
  workspaceId: string;
  rootPageId: string;
  /** Set when a human triggered the delete (e.g., trash UI, /review approve). */
  userId?: string | null;
  /** Set when the agent loop auto-applied the delete with no human in the loop. */
  modelRunId?: string | null;
  /** Optional metadata recorded in the audit_log for traceability. */
  auditExtra?: Record<string, unknown>;
}

export interface SoftDeleteResult {
  deletedPageIds: string[];
  rootTitle: string;
}

export interface PurgeDeletedInput {
  workspaceId: string;
  rootPageId: string;
  userId?: string | null;
  modelRunId?: string | null;
  auditExtra?: Record<string, unknown>;
  cleanupOrphanEntities?: boolean;
}

export interface PurgeDeletedResult {
  purgedPageIds: string[];
  rootTitle: string;
  /** Archived original object keys associated with decisions for purged pages. */
  storageKeys: string[];
}

/** Throws `PageDeletionError(PUBLISHED_BLOCK)` if any subtree page is live — */
/** the caller must unpublish first. Triples transition to 'page_deleted' so  */
/** the graph drops them atomically with the page soft-delete.                */
export async function softDeleteSubtree(
  db: AnyDb,
  input: SoftDeleteInput,
): Promise<SoftDeleteResult> {
  return await db.transaction(async (tx: AnyDb) =>
    softDeleteSubtreeInTransaction(tx, input),
  );
}

export async function softDeleteSubtreeInTransaction(
  tx: AnyDb,
  input: SoftDeleteInput,
): Promise<SoftDeleteResult> {
  const { workspaceId, rootPageId } = input;
  const userId = input.userId ?? null;
  const modelRunId = input.modelRunId ?? null;

  const [root] = await tx
    .select({ id: pages.id, title: pages.title, deletedAt: pages.deletedAt })
    .from(pages)
    .where(and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)))
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

  await tx.execute(
    sql`SELECT 1 FROM "pages" WHERE "id" IN (${sqlUuidList(subtreeIds)}) FOR UPDATE`,
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

  await tx.execute(
    sql`UPDATE "pages" SET "search_vector" = NULL WHERE "id" IN (${sqlUuidList(subtreeIds)})`,
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
      and(inArray(pagePaths.pageId, subtreeIds), eq(pagePaths.isCurrent, true)),
    );

  await tx.insert(auditLogs).values({
    workspaceId,
    userId,
    modelRunId,
    entityType: "page",
    entityId: rootPageId,
    action: "delete",
    beforeJson: {
      id: root.id,
      title: root.title,
      descendantIds: subtreeIds,
      ...(input.auditExtra ?? {}),
    },
  });

  return { deletedPageIds: subtreeIds, rootTitle: root.title };
}

/**
 * Permanently removes a page subtree without leaving rows in the trash. This is
 * reserved for autonomous Scheduled Agent destructive actions where restore
 * conflicts would be worse than immediate removal.
 */
export async function purgeDeletedSubtreeInTransaction(
  tx: AnyDb,
  input: PurgeDeletedInput,
): Promise<PurgeDeletedResult> {
  const { workspaceId, rootPageId } = input;
  const userId = input.userId ?? null;
  const modelRunId = input.modelRunId ?? null;

  const [root] = await tx
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)))
    .limit(1);

  if (!root) throw new PageDeletionError(ERROR_CODES.PAGE_NOT_FOUND);

  const subtreeIds = await collectDescendantPageIds(
    tx,
    workspaceId,
    rootPageId,
    {
      includeDeleted: true,
    },
  );
  if (subtreeIds.length === 0) {
    return { purgedPageIds: [], rootTitle: root.title, storageKeys: [] };
  }

  await tx.execute(
    sql`SELECT 1 FROM "pages" WHERE "id" IN (${sqlUuidList(subtreeIds)}) FOR UPDATE`,
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

  const blobRows = await tx
    .selectDistinct({ storageKey: ingestions.storageKey })
    .from(ingestions)
    .innerJoin(
      ingestionDecisions,
      eq(ingestionDecisions.ingestionId, ingestions.id),
    )
    .where(
      and(
        inArray(ingestionDecisions.targetPageId, subtreeIds),
        sql`${ingestions.storageKey} IS NOT NULL`,
      ),
    );
  const storageKeys = (blobRows as Array<{ storageKey: string | null }>)
    .map((r) => r.storageKey)
    .filter((key): key is string => typeof key === "string" && key.length > 0);

  await tx
    .update(pages)
    .set({ currentRevisionId: null, latestPublishedSnapshotId: null })
    .where(inArray(pages.id, subtreeIds));

  await tx
    .delete(publishedSnapshots)
    .where(inArray(publishedSnapshots.pageId, subtreeIds));

  await tx.insert(auditLogs).values({
    workspaceId,
    userId,
    modelRunId,
    entityType: "page",
    entityId: rootPageId,
    action: "purge",
    beforeJson: {
      id: root.id,
      title: root.title,
      purgedIds: subtreeIds,
      ...(input.auditExtra ?? {}),
    },
  });

  await tx.delete(pages).where(inArray(pages.id, subtreeIds));

  if (input.cleanupOrphanEntities ?? true) {
    await cleanupOrphanEntities(tx, workspaceId);
  }

  return { purgedPageIds: subtreeIds, rootTitle: root.title, storageKeys };
}

/** After FK-cascade wipes triples, remove entities no longer used by active triples. */
export async function cleanupOrphanEntities(db: AnyDb, workspaceId: string) {
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

/** Restores only the pages deleted in the same trash operation as the root.    */
/** Detaches from a still-deleted parent so restored pages have a stable landing */
/** spot (they reappear at the root). Slug/path conflicts surface as             */
/** SLUG_CONFLICT so the user can rename before retrying.                        */
export async function restoreSubtree(
  db: AnyDb,
  input: RestoreInput,
): Promise<RestoreResult> {
  return await db.transaction(async (tx: AnyDb) =>
    restoreSubtreeInTransaction(tx, input),
  );
}

export async function restoreSubtreeInTransaction(
  tx: AnyDb,
  input: RestoreInput,
): Promise<RestoreResult> {
  const { workspaceId, rootPageId, userId } = input;

  const [root] = await tx
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      parentPageId: pages.parentPageId,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(and(eq(pages.id, rootPageId), eq(pages.workspaceId, workspaceId)))
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

  const subtreePages = await tx
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(inArray(pages.id, subtreeIds));

  const restoringPages = selectPagesDeletedWithRoot(
    subtreePages,
    root.deletedAt,
  );
  const restoringIds = restoringPages.map((page) => page.id);

  if (restoringIds.length === 0) {
    return { restoredPageIds: [], rootTitle: root.title };
  }

  await tx.execute(
    sql`SELECT 1 FROM "pages" WHERE "id" IN (${sqlUuidList(restoringIds)}) FOR UPDATE`,
  );

  const activePages = await tx
    .select({ id: pages.id, title: pages.title, slug: pages.slug })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        inArray(
          pages.slug,
          restoringPages.map((page) => page.slug),
        ),
        isNull(pages.deletedAt),
      ),
    );

  const latestPaths = await tx.execute(sql`
      SELECT DISTINCT ON (pp."page_id")
        pp."page_id" AS "pageId",
        pp."path" AS "path"
      FROM "page_paths" pp
      WHERE pp."page_id" IN (${sqlUuidList(restoringIds)})
      ORDER BY pp."page_id", pp."created_at" DESC
    `);

  const latestPathRows =
    (
      latestPaths as unknown as {
        rows?: Array<{ pageId: string; path: string }>;
      }
    ).rows ?? (latestPaths as Array<{ pageId: string; path: string }>);
  const restoringPaths = Array.isArray(latestPathRows) ? latestPathRows : [];

  const activePathValues = restoringPaths.map((path) => path.path);
  const activePathsResult =
    activePathValues.length === 0
      ? []
      : await tx.execute(sql`
        SELECT pp."page_id" AS "pageId", pp."path" AS "path", p."title" AS "title"
        FROM "page_paths" pp
        INNER JOIN "pages" p ON p."id" = pp."page_id"
        WHERE pp."workspace_id" = ${workspaceId}
          AND pp."is_current" = true
          AND pp."path" IN (${sqlTextList(activePathValues)})
          AND p."deleted_at" IS NULL
      `);

  const activePathRows = Array.isArray(activePathsResult)
    ? activePathsResult
    : ((
        activePathsResult as unknown as {
          rows?: Array<{ pageId: string; path: string; title: string }>;
        }
      ).rows ?? []);

  const conflict = findRestoreConflict({
    restoringPages,
    restoringPaths,
    activePages,
    activePaths: activePathRows,
  });

  if (conflict) {
    throw new PageDeletionError(ERROR_CODES.SLUG_CONFLICT, {
      kind: conflict.kind,
      restoringPageId: conflict.restoringPageId,
      restoringTitle: conflict.restoringTitle,
      conflictingPageId: conflict.conflictingPageId,
      conflictingTitle: conflict.conflictingTitle,
      slug: conflict.slug,
      path: conflict.path,
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
    .where(inArray(pages.id, restoringIds));

  await tx
    .update(triples)
    .set({ status: "active" })
    .where(
      and(
        inArray(triples.sourcePageId, restoringIds),
        eq(triples.status, "page_deleted"),
      ),
    );

  await tx.execute(sql`
      UPDATE "page_paths" SET "is_current" = true
      WHERE "id" IN (
        SELECT DISTINCT ON ("page_id") "id"
        FROM "page_paths"
        WHERE "page_id" IN (${sqlUuidList(restoringIds)})
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
      restoredIds: restoringIds,
      detachedFromParent,
    },
  });

  return { restoredPageIds: restoringIds, rootTitle: root.title };
}

/** Filter shorthand for all READ paths — spread into `and(...)` clauses. */
export function notDeleted() {
  return isNull(pages.deletedAt);
}

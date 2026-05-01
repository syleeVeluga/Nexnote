import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  ingestionDecisions,
  ingestions,
  pages,
  collectDescendantPageIds,
  PageDeletionError,
  sqlUuidList,
} from "@wekiflow/db";
import { ERROR_CODES } from "@wekiflow/shared";
import { deleteOriginals, storageEnabled } from "./storage/s3.js";

// Re-export the soft-delete / restore primitives from @wekiflow/db so existing
// import sites in the api package keep working unchanged. Worker also imports
// these directly from @wekiflow/db when running the agent loop's auto-apply
// path for delete_page / merge_pages.
export {
  collectDescendantPageIds,
  findRestoreConflict,
  notDeleted,
  PageDeletionError,
  restoreSubtree,
  restoreSubtreeInTransaction,
  selectPagesDeletedWithRoot,
  softDeleteSubtree,
  softDeleteSubtreeInTransaction,
  sqlUuidList,
  type RestoreConflict,
  type RestoreInput,
  type RestorePageSnapshot,
  type RestorePathSnapshot,
  type RestoreResult,
  type SoftDeleteInput,
  type SoftDeleteResult,
} from "@wekiflow/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle tx/db don't share a clean type
type AnyDb = any;

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
      return { purgedPageIds: [], storageKeys: [] as string[] };
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

    // Collect archived object keys tied to the subtree's ingestions before
    // the DB rows disappear. Done inside the tx so we see a consistent view,
    // but the actual S3 deletes run outside the tx — if the network blip,
    // a DB rollback shouldn't re-add objects we already removed.
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
      .filter((k): k is string => typeof k === "string" && k.length > 0);

    await tx.delete(pages).where(inArray(pages.id, subtreeIds));

    return { purgedPageIds: subtreeIds, storageKeys };
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

  if (storageEnabled && result.storageKeys.length > 0) {
    // Best-effort: orphaned S3 objects are cheaper to recover than blocking
    // the user's purge on a storage outage. A future GC sweep can catch them.
    try {
      await deleteOriginals(result.storageKeys);
    } catch (err) {
      console.warn(
        `[page-deletion] Failed to delete ${result.storageKeys.length} archived originals after purge`,
        err,
      );
    }
  }

  return { purgedPageIds: result.purgedPageIds };
}

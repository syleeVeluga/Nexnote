import { and, eq } from "drizzle-orm";
import {
  collectDescendantPageIds,
  pages,
  PageDeletionError,
  purgeDeletedSubtreeInTransaction,
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
  purgeDeletedSubtreeInTransaction,
  restoreSubtree,
  restoreSubtreeInTransaction,
  selectPagesDeletedWithRoot,
  softDeleteSubtree,
  softDeleteSubtreeInTransaction,
  sqlUuidList,
  type PurgeDeletedInput,
  type PurgeDeletedResult,
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

    return purgeDeletedSubtreeInTransaction(tx, {
      workspaceId,
      rootPageId,
      userId,
    });
  });

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

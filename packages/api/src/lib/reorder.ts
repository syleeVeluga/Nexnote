import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { pages, folders } from "@wekiflow/db";
import { ERROR_CODES, type ReorderIntent } from "@wekiflow/shared";
import { notDeleted } from "./page-deletion.js";

export type { ReorderIntent };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle tx doesn't expose a clean shared interface
type AnyTx = any;

export type PageParent =
  | { kind: "root" }
  | { kind: "page"; pageId: string }
  | { kind: "folder"; folderId: string };

export type FolderParent =
  | { kind: "root" }
  | { kind: "folder"; folderId: string };

export interface ReorderError {
  statusCode: number;
  body: { error: string; code: string };
}

/** Thrown from inside a tx callback so the transaction rolls back and the
 * route handler can translate it into the right HTTP response. */
export class ReorderFailedError extends Error {
  constructor(public readonly detail: ReorderError) {
    super(detail.body.error);
    this.name = "ReorderFailedError";
  }
}

const STEP = 1024;

function insertionIndex(
  siblings: { id: string }[],
  intent: ReorderIntent,
): ReorderError | number {
  switch (intent.kind) {
    case "asFirstChild":
      return 0;
    case "asLastChild":
      return siblings.length;
    case "before":
    case "after": {
      const idx = siblings.findIndex((s) => s.id === intent.anchorId);
      if (idx < 0) {
        return {
          statusCode: 400,
          body: {
            error: "Reorder anchor not found in target parent",
            code: ERROR_CODES.REORDER_ANCHOR_NOT_FOUND,
          },
        };
      }
      return intent.kind === "before" ? idx : idx + 1;
    }
  }
}

export async function reorderPage(
  tx: AnyTx,
  args: {
    workspaceId: string;
    movingId: string;
    parent: PageParent;
    intent?: ReorderIntent;
  },
): Promise<ReorderError | null> {
  const { workspaceId, movingId, parent } = args;
  const intent: ReorderIntent = args.intent ?? { kind: "asLastChild" };

  const parentCondition =
    parent.kind === "root"
      ? and(isNull(pages.parentPageId), isNull(pages.parentFolderId))
      : parent.kind === "page"
        ? and(
            eq(pages.parentPageId, parent.pageId),
            isNull(pages.parentFolderId),
          )
        : and(
            isNull(pages.parentPageId),
            eq(pages.parentFolderId, parent.folderId),
          );

  await tx
    .update(pages)
    .set({
      parentPageId: parent.kind === "page" ? parent.pageId : null,
      parentFolderId: parent.kind === "folder" ? parent.folderId : null,
      updatedAt: new Date(),
    })
    .where(and(eq(pages.id, movingId), eq(pages.workspaceId, workspaceId)));

  const siblings: { id: string; sortOrder: number }[] = await tx
    .select({ id: pages.id, sortOrder: pages.sortOrder })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), parentCondition, notDeleted()))
    .orderBy(pages.sortOrder, pages.createdAt);

  const ordered = orderSiblings(siblings, movingId, intent);
  if ("body" in ordered) return ordered;

  const dirty = diffSortOrders(siblings, ordered, movingId);
  if (dirty.length > 0) {
    await tx
      .update(pages)
      .set({ sortOrder: caseWhenSortOrder(pages.id, dirty) })
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          inArray(
            pages.id,
            dirty.map((r) => r.id),
          ),
        ),
      );
  }

  return null;
}

export async function reorderFolder(
  tx: AnyTx,
  args: {
    workspaceId: string;
    movingId: string;
    parent: FolderParent;
    intent?: ReorderIntent;
  },
): Promise<ReorderError | null> {
  const { workspaceId, movingId, parent } = args;
  const intent: ReorderIntent = args.intent ?? { kind: "asLastChild" };

  const parentCondition =
    parent.kind === "root"
      ? isNull(folders.parentFolderId)
      : eq(folders.parentFolderId, parent.folderId);

  await tx
    .update(folders)
    .set({
      parentFolderId: parent.kind === "folder" ? parent.folderId : null,
      updatedAt: new Date(),
    })
    .where(and(eq(folders.id, movingId), eq(folders.workspaceId, workspaceId)));

  // Folders have no soft-delete column today, so the sibling query doesn't
  // need a `notDeleted()` filter (unlike `reorderPage()` above). If folders
  // ever gain a `deletedAt` column, this query and any related listing /
  // hierarchy code must be updated together — otherwise reorder will treat
  // tombstoned folders as live siblings.
  const siblings: { id: string; sortOrder: number }[] = await tx
    .select({ id: folders.id, sortOrder: folders.sortOrder })
    .from(folders)
    .where(and(eq(folders.workspaceId, workspaceId), parentCondition))
    .orderBy(folders.sortOrder, folders.createdAt);

  const ordered = orderSiblings(siblings, movingId, intent);
  if ("body" in ordered) return ordered;

  const dirty = diffSortOrders(siblings, ordered, movingId);
  if (dirty.length > 0) {
    await tx
      .update(folders)
      .set({ sortOrder: caseWhenSortOrder(folders.id, dirty) })
      .where(
        and(
          eq(folders.workspaceId, workspaceId),
          inArray(
            folders.id,
            dirty.map((r) => r.id),
          ),
        ),
      );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pure insertion calculation — unit-testable without a DB
// ---------------------------------------------------------------------------

export interface ComputedOrder {
  id: string;
  sortOrder: number;
}

function orderSiblings(
  siblings: { id: string; sortOrder: number }[],
  movingId: string,
  intent: ReorderIntent,
): ReorderError | ComputedOrder[] {
  const sorted = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder);
  const withoutMoving = sorted.filter((s) => s.id !== movingId);
  const idxOrError = insertionIndex(withoutMoving, intent);
  if (typeof idxOrError !== "number") return idxOrError;
  const ordered: { id: string }[] = [
    ...withoutMoving.slice(0, idxOrError),
    { id: movingId },
    ...withoutMoving.slice(idxOrError),
  ];
  return ordered.map((row, i) => ({ id: row.id, sortOrder: i * STEP }));
}

function diffSortOrders(
  currentSiblings: { id: string; sortOrder: number }[],
  ordered: ComputedOrder[],
  movingId: string,
): ComputedOrder[] {
  const currentBySortOrder = new Map(
    currentSiblings.map((s) => [s.id, s.sortOrder]),
  );
  return ordered.filter((row) => {
    if (row.id === movingId) return true;
    const existing = currentBySortOrder.get(row.id);
    return existing === undefined || existing !== row.sortOrder;
  });
}

// Build a CASE id WHEN ... THEN ... END expression so one UPDATE sets every
// dirty sibling's sort_order. Avoids N round-trips on a dense reorder.
function caseWhenSortOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle column, varies per table
  idColumn: any,
  dirty: ComputedOrder[],
): SQL<number> {
  const branches = dirty.map(
    (row) => sql`WHEN ${idColumn} = ${row.id} THEN ${row.sortOrder}::integer`,
  );
  return sql<number>`CASE ${sql.join(branches, sql` `)} END`;
}

// Back-compat re-export for the existing test suite.
export function computeReorderedSortOrders(
  siblings: { id: string; sortOrder: number }[],
  movingId: string,
  intent: ReorderIntent,
): ReorderError | ComputedOrder[] {
  return orderSiblings(siblings, movingId, intent);
}

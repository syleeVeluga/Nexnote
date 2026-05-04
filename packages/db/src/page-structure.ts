import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ERROR_CODES,
  slugify,
  type PageStatus,
  type ReorderIntent,
} from "@wekiflow/shared";
import {
  auditLogs,
  folders,
  pagePaths,
  pageRedirects,
  pages,
} from "./schema/index.js";
import { notDeleted } from "./page-deletion.js";

// Drizzle does not expose a compact common type for database and transaction
// objects that still preserves the fluent query API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const STEP = 1024;

export type PageStructureActorType = "user" | "ai" | "system";

export class PageStructureError extends Error {
  constructor(
    public readonly code:
      | "page_not_found"
      | "folder_not_found"
      | "page_parent_invalid"
      | "page_parent_not_found"
      | "page_parent_cycle"
      | "page_parent_conflict"
      | "folder_parent_not_found"
      | "folder_parent_invalid"
      | "folder_parent_cycle"
      | "reorder_anchor_not_found"
      | "slug_conflict",
    message: string,
    public readonly statusCode = 400,
    public readonly errorCode: string = ERROR_CODES.NOT_FOUND,
  ) {
    super(message);
    this.name = "PageStructureError";
  }
}

export interface PageStructureSnapshot {
  id: string;
  title: string;
  slug: string;
  parentPageId: string | null;
  parentFolderId: string | null;
  status: string;
  sortOrder: number;
  currentRevisionId: string | null;
}

export interface UpdatePageStructureInput {
  db: AnyDb;
  workspaceId: string;
  pageId: string;
  actorUserId?: string | null;
  modelRunId?: string | null;
  title?: string;
  slug?: string;
  status?: PageStatus;
  parentPageId?: string | null;
  parentFolderId?: string | null;
  sortOrder?: number;
  reorderIntent?: ReorderIntent;
  auditAction?: string;
  auditAfterJson?: Record<string, unknown>;
  createRedirectOnSlugChange?: boolean;
}

export interface UpdatePageStructureResult {
  page: typeof pages.$inferSelect;
  before: PageStructureSnapshot;
  parentChanged: boolean;
  slugChanged: boolean;
}

export interface CreateFolderStructureInput {
  db: AnyDb;
  workspaceId: string;
  actorUserId?: string | null;
  modelRunId?: string | null;
  name: string;
  slug?: string;
  parentFolderId?: string | null;
  sortOrder?: number;
  allocateUniqueSlug?: boolean;
  auditAction?: string;
  auditAfterJson?: Record<string, unknown>;
}

async function withMaybeTransaction<T>(
  db: AnyDb,
  fn: (tx: AnyDb) => Promise<T>,
): Promise<T> {
  if (typeof db.transaction === "function") return db.transaction(fn);
  return fn(db);
}

function sameParentCondition(parentFolderId: string | null) {
  return parentFolderId
    ? eq(folders.parentFolderId, parentFolderId)
    : isNull(folders.parentFolderId);
}

async function loadPage(db: AnyDb, pageId: string) {
  const [row] = await db
    .select({
      id: pages.id,
      workspaceId: pages.workspaceId,
      parentPageId: pages.parentPageId,
      parentFolderId: pages.parentFolderId,
    })
    .from(pages)
    .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function loadFolder(db: AnyDb, folderId: string) {
  const [row] = await db
    .select({
      id: folders.id,
      workspaceId: folders.workspaceId,
      parentFolderId: folders.parentFolderId,
    })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  return row ?? null;
}

async function validatePageParent(
  db: AnyDb,
  params: {
    workspaceId: string;
    pageId: string;
    parentPageId: string | null | undefined;
  },
): Promise<void> {
  if (params.parentPageId == null) return;
  if (params.parentPageId === params.pageId) {
    throw new PageStructureError(
      "page_parent_invalid",
      "A page cannot be its own parent",
      400,
      ERROR_CODES.PAGE_PARENT_INVALID,
    );
  }

  const parent = await loadPage(db, params.parentPageId);
  if (!parent || parent.workspaceId !== params.workspaceId) {
    throw new PageStructureError(
      "page_parent_not_found",
      "Parent page not found in this workspace",
      400,
      ERROR_CODES.PAGE_PARENT_NOT_FOUND,
    );
  }

  const visited = new Set<string>([parent.id]);
  let cursor = parent.parentPageId;
  while (cursor) {
    if (cursor === params.pageId || visited.has(cursor)) {
      throw new PageStructureError(
        "page_parent_cycle",
        "A page cannot be moved under one of its descendants",
        400,
        ERROR_CODES.PAGE_PARENT_CYCLE,
      );
    }
    visited.add(cursor);
    const ancestor = await loadPage(db, cursor);
    if (!ancestor) break;
    if (ancestor.workspaceId !== params.workspaceId) {
      throw new PageStructureError(
        "page_parent_not_found",
        "Parent page not found in this workspace",
        400,
        ERROR_CODES.PAGE_PARENT_NOT_FOUND,
      );
    }
    cursor = ancestor.parentPageId;
  }
}

async function validateFolderParent(
  db: AnyDb,
  params: {
    workspaceId: string;
    folderId?: string;
    parentFolderId: string | null | undefined;
  },
): Promise<void> {
  if (params.parentFolderId == null) return;
  if (params.folderId && params.parentFolderId === params.folderId) {
    throw new PageStructureError(
      "folder_parent_invalid",
      "A folder cannot be its own parent",
      400,
      ERROR_CODES.FOLDER_PARENT_INVALID,
    );
  }

  const parent = await loadFolder(db, params.parentFolderId);
  if (!parent || parent.workspaceId !== params.workspaceId) {
    throw new PageStructureError(
      "folder_parent_not_found",
      "Parent folder not found in this workspace",
      400,
      ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
    );
  }

  if (!params.folderId) return;
  const visited = new Set<string>([parent.id]);
  let cursor = parent.parentFolderId;
  while (cursor) {
    if (cursor === params.folderId || visited.has(cursor)) {
      throw new PageStructureError(
        "folder_parent_cycle",
        "A folder cannot be moved under one of its descendants",
        400,
        ERROR_CODES.FOLDER_PARENT_CYCLE,
      );
    }
    visited.add(cursor);
    const ancestor = await loadFolder(db, cursor);
    if (!ancestor) break;
    if (ancestor.workspaceId !== params.workspaceId) {
      throw new PageStructureError(
        "folder_parent_not_found",
        "Parent folder not found in this workspace",
        400,
        ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
      );
    }
    cursor = ancestor.parentFolderId;
  }
}

function pageParentCondition(
  parentPageId: string | null,
  parentFolderId: string | null,
) {
  if (parentFolderId) {
    return and(
      isNull(pages.parentPageId),
      eq(pages.parentFolderId, parentFolderId),
    );
  }
  if (parentPageId) {
    return and(
      eq(pages.parentPageId, parentPageId),
      isNull(pages.parentFolderId),
    );
  }
  return and(isNull(pages.parentPageId), isNull(pages.parentFolderId));
}

async function nextPageSortOrder(
  db: AnyDb,
  workspaceId: string,
  parentPageId: string | null,
  parentFolderId: string | null,
): Promise<number> {
  const [lastSibling] = await db
    .select({ sortOrder: pages.sortOrder })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        pageParentCondition(parentPageId, parentFolderId),
        notDeleted(),
      ),
    )
    .orderBy(desc(pages.sortOrder), desc(pages.createdAt))
    .limit(1);
  return lastSibling ? lastSibling.sortOrder + 1 : 0;
}

async function nextFolderSortOrder(
  db: AnyDb,
  workspaceId: string,
  parentFolderId: string | null,
): Promise<number> {
  const [lastSibling] = await db
    .select({ sortOrder: folders.sortOrder })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, workspaceId),
        sameParentCondition(parentFolderId),
      ),
    )
    .orderBy(desc(folders.sortOrder), desc(folders.createdAt))
    .limit(1);
  return lastSibling ? lastSibling.sortOrder + 1 : 0;
}

function insertionIndex(
  siblings: { id: string }[],
  intent: ReorderIntent,
): number {
  switch (intent.kind) {
    case "asFirstChild":
      return 0;
    case "asLastChild":
      return siblings.length;
    case "before":
    case "after": {
      const idx = siblings.findIndex((s) => s.id === intent.anchorId);
      if (idx < 0) {
        throw new PageStructureError(
          "reorder_anchor_not_found",
          "Reorder anchor not found in target parent",
          400,
          ERROR_CODES.REORDER_ANCHOR_NOT_FOUND,
        );
      }
      return intent.kind === "before" ? idx : idx + 1;
    }
  }
}

function caseWhenSortOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idColumn: any,
  dirty: Array<{ id: string; sortOrder: number }>,
): SQL<number> {
  const branches = dirty.map(
    (row) => sql`WHEN ${idColumn} = ${row.id} THEN ${row.sortOrder}::integer`,
  );
  return sql<number>`CASE ${sql.join(branches, sql` `)} END`;
}

async function reorderPageInTx(
  tx: AnyDb,
  params: {
    workspaceId: string;
    pageId: string;
    parentPageId: string | null;
    parentFolderId: string | null;
    intent: ReorderIntent;
  },
): Promise<void> {
  await tx
    .update(pages)
    .set({
      parentPageId: params.parentPageId,
      parentFolderId: params.parentFolderId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(pages.id, params.pageId),
        eq(pages.workspaceId, params.workspaceId),
      ),
    );

  const siblings: Array<{ id: string; sortOrder: number }> = await tx
    .select({ id: pages.id, sortOrder: pages.sortOrder })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, params.workspaceId),
        pageParentCondition(params.parentPageId, params.parentFolderId),
        notDeleted(),
      ),
    )
    .orderBy(asc(pages.sortOrder), asc(pages.createdAt));

  const sorted = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder);
  const withoutMoving = sorted.filter((s) => s.id !== params.pageId);
  const idx = insertionIndex(withoutMoving, params.intent);
  const ordered = [
    ...withoutMoving.slice(0, idx),
    { id: params.pageId },
    ...withoutMoving.slice(idx),
  ].map((row, index) => ({ id: row.id, sortOrder: index * STEP }));

  const current = new Map(siblings.map((s) => [s.id, s.sortOrder]));
  const dirty = ordered.filter(
    (row) => row.id === params.pageId || current.get(row.id) !== row.sortOrder,
  );
  if (dirty.length === 0) return;
  await tx
    .update(pages)
    .set({ sortOrder: caseWhenSortOrder(pages.id, dirty) })
    .where(
      and(
        eq(pages.workspaceId, params.workspaceId),
        inArray(
          pages.id,
          dirty.map((row) => row.id),
        ),
      ),
    );
}

async function ensurePageSlugAvailable(
  db: AnyDb,
  workspaceId: string,
  slug: string,
  exceptPageId: string,
): Promise<void> {
  const [conflict] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.slug, slug),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (conflict && conflict.id !== exceptPageId) {
    throw new PageStructureError(
      "slug_conflict",
      "A page with this slug already exists in this workspace",
      409,
      ERROR_CODES.SLUG_CONFLICT,
    );
  }
}

async function ensureFolderSlugAvailable(
  db: AnyDb,
  workspaceId: string,
  parentFolderId: string | null,
  slug: string,
): Promise<boolean> {
  const [conflict] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, workspaceId),
        sameParentCondition(parentFolderId),
        eq(folders.slug, slug),
      ),
    )
    .limit(1);
  return !conflict;
}

async function allocateFolderSlug(
  db: AnyDb,
  workspaceId: string,
  parentFolderId: string | null,
  baseSlug: string,
): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    if (
      await ensureFolderSlugAvailable(
        db,
        workspaceId,
        parentFolderId,
        candidate,
      )
    ) {
      return candidate;
    }
  }
  throw new PageStructureError(
    "slug_conflict",
    `Could not allocate unique folder slug for "${baseSlug}"`,
    409,
    ERROR_CODES.SLUG_CONFLICT,
  );
}

export async function updatePageStructure(
  input: UpdatePageStructureInput,
): Promise<UpdatePageStructureResult> {
  const [existing] = await input.db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.id, input.pageId),
        eq(pages.workspaceId, input.workspaceId),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new PageStructureError(
      "page_not_found",
      "Page not found",
      404,
      ERROR_CODES.PAGE_NOT_FOUND,
    );
  }

  const nextParentPageId =
    input.parentPageId !== undefined
      ? input.parentPageId
      : existing.parentPageId;
  const nextParentFolderId =
    input.parentFolderId !== undefined
      ? input.parentFolderId
      : existing.parentFolderId;

  if (nextParentPageId != null && nextParentFolderId != null) {
    throw new PageStructureError(
      "page_parent_conflict",
      "A page cannot have both a parent page and a parent folder",
      400,
      ERROR_CODES.PAGE_PARENT_CONFLICT,
    );
  }

  await validatePageParent(input.db, {
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    parentPageId: nextParentPageId,
  });
  if (nextParentFolderId) {
    const folder = await loadFolder(input.db, nextParentFolderId);
    if (!folder || folder.workspaceId !== input.workspaceId) {
      throw new PageStructureError(
        "folder_not_found",
        "Parent folder not found in this workspace",
        400,
        ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
      );
    }
  }
  if (input.slug !== undefined && input.slug !== existing.slug) {
    await ensurePageSlugAvailable(
      input.db,
      input.workspaceId,
      input.slug,
      input.pageId,
    );
  }

  const parentFieldTouched =
    input.parentPageId !== undefined || input.parentFolderId !== undefined;
  const parentChanged =
    parentFieldTouched &&
    (nextParentPageId !== existing.parentPageId ||
      nextParentFolderId !== existing.parentFolderId);
  const slugChanged = input.slug !== undefined && input.slug !== existing.slug;

  const page = await withMaybeTransaction(input.db, async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: sql`now()` };
    if (input.title !== undefined) patch.title = input.title;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.status !== undefined) patch.status = input.status;

    if (Object.keys(patch).length > 1) {
      await tx.update(pages).set(patch).where(eq(pages.id, input.pageId));
    }

    if (input.reorderIntent) {
      await reorderPageInTx(tx, {
        workspaceId: input.workspaceId,
        pageId: input.pageId,
        parentPageId: nextParentPageId,
        parentFolderId: nextParentFolderId,
        intent: input.reorderIntent,
      });
    } else if (parentChanged) {
      const nextSort = await nextPageSortOrder(
        tx,
        input.workspaceId,
        nextParentPageId,
        nextParentFolderId,
      );
      await tx
        .update(pages)
        .set({
          parentPageId: nextParentPageId,
          parentFolderId: nextParentFolderId,
          sortOrder: nextSort,
          updatedAt: sql`now()`,
        })
        .where(eq(pages.id, input.pageId));
    } else if (input.sortOrder !== undefined) {
      await tx
        .update(pages)
        .set({ sortOrder: input.sortOrder, updatedAt: sql`now()` })
        .where(eq(pages.id, input.pageId));
    }

    if (slugChanged) {
      await tx
        .update(pagePaths)
        .set({ isCurrent: false })
        .where(
          and(
            eq(pagePaths.pageId, input.pageId),
            eq(pagePaths.isCurrent, true),
          ),
        );
      await tx.insert(pagePaths).values({
        workspaceId: input.workspaceId,
        pageId: input.pageId,
        path: input.slug!,
        isCurrent: true,
      });
      if (input.createRedirectOnSlugChange ?? true) {
        await tx
          .insert(pageRedirects)
          .values({
            workspaceId: input.workspaceId,
            fromPageId: input.pageId,
            toPageId: input.pageId,
            fromPath: existing.slug,
          })
          .onConflictDoNothing();
      }
    }

    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId ?? null,
      modelRunId: input.modelRunId ?? null,
      entityType: "page",
      entityId: input.pageId,
      action: input.auditAction ?? "update",
      beforeJson: {
        title: existing.title,
        slug: existing.slug,
        parentPageId: existing.parentPageId,
        parentFolderId: existing.parentFolderId,
        status: existing.status,
        sortOrder: existing.sortOrder,
      },
      afterJson: input.auditAfterJson ?? {
        title: input.title,
        slug: input.slug,
        parentPageId: input.parentPageId,
        parentFolderId: input.parentFolderId,
        status: input.status,
        sortOrder: input.sortOrder,
        reorderIntent: input.reorderIntent,
      },
    });

    const [updated] = await tx
      .select()
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .limit(1);
    return updated;
  });

  return {
    page,
    before: {
      id: existing.id,
      title: existing.title,
      slug: existing.slug,
      parentPageId: existing.parentPageId,
      parentFolderId: existing.parentFolderId,
      status: existing.status,
      sortOrder: existing.sortOrder,
      currentRevisionId: existing.currentRevisionId,
    },
    parentChanged,
    slugChanged,
  };
}

export async function createFolderStructure(
  input: CreateFolderStructureInput,
): Promise<typeof folders.$inferSelect> {
  const parentFolderId = input.parentFolderId ?? null;
  await validateFolderParent(input.db, {
    workspaceId: input.workspaceId,
    parentFolderId,
  });

  const baseSlug = input.slug ?? slugify(input.name);
  const slug = input.allocateUniqueSlug
    ? await allocateFolderSlug(
        input.db,
        input.workspaceId,
        parentFolderId,
        baseSlug,
      )
    : baseSlug;

  if (!input.allocateUniqueSlug) {
    const available = await ensureFolderSlugAvailable(
      input.db,
      input.workspaceId,
      parentFolderId,
      slug,
    );
    if (!available) {
      throw new PageStructureError(
        "slug_conflict",
        "A folder with this slug already exists in the same parent",
        409,
        ERROR_CODES.SLUG_CONFLICT,
      );
    }
  }

  return withMaybeTransaction(input.db, async (tx) => {
    const sortOrder =
      input.sortOrder ??
      (await nextFolderSortOrder(tx, input.workspaceId, parentFolderId));
    const [folder] = await tx
      .insert(folders)
      .values({
        workspaceId: input.workspaceId,
        parentFolderId,
        name: input.name,
        slug,
        sortOrder,
      })
      .returning();

    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId ?? null,
      modelRunId: input.modelRunId ?? null,
      entityType: "folder",
      entityId: folder.id,
      action: input.auditAction ?? "folder.create",
      afterJson: input.auditAfterJson ?? {
        name: input.name,
        slug,
        parentFolderId,
      },
    });

    return folder;
  });
}

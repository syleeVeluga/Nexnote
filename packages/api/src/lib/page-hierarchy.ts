import { and, desc, eq, isNull } from "drizzle-orm";
import { pages } from "@nexnote/db";
import { ERROR_CODES } from "@nexnote/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle query builder doesn't expose a clean shared interface for db/tx
type AnyDb = any;

export interface PageHierarchyRow {
  id: string;
  workspaceId: string;
  parentPageId: string | null;
}

export interface HierarchyValidationError {
  statusCode: number;
  body: {
    error: string;
    code: string;
  };
}

export async function loadPageHierarchyRow(
  db: AnyDb,
  pageId: string,
): Promise<PageHierarchyRow | null> {
  const [row] = await db
    .select({
      id: pages.id,
      workspaceId: pages.workspaceId,
      parentPageId: pages.parentPageId,
    })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  return row ?? null;
}

export async function validateParentPageAssignment(
  loadPage: (pageId: string) => Promise<PageHierarchyRow | null>,
  params: {
    workspaceId: string;
    pageId?: string;
    parentPageId: string | null | undefined;
  },
): Promise<HierarchyValidationError | null> {
  const { workspaceId, pageId, parentPageId } = params;
  if (parentPageId == null) {
    return null;
  }

  if (pageId && parentPageId === pageId) {
    return {
      statusCode: 400,
      body: {
        error: "A page cannot be its own parent",
        code: ERROR_CODES.PAGE_PARENT_INVALID,
      },
    };
  }

  const parent = await loadPage(parentPageId);
  if (!parent || parent.workspaceId !== workspaceId) {
    return {
      statusCode: 400,
      body: {
        error: "Parent page not found in this workspace",
        code: ERROR_CODES.PAGE_PARENT_NOT_FOUND,
      },
    };
  }

  if (!pageId) {
    return null;
  }

  const visited = new Set<string>([parent.id]);
  let cursor = parent.parentPageId;

  while (cursor) {
    if (cursor === pageId) {
      return {
        statusCode: 400,
        body: {
          error: "A page cannot be moved under one of its descendants",
          code: ERROR_CODES.PAGE_PARENT_CYCLE,
        },
      };
    }

    if (visited.has(cursor)) {
      return {
        statusCode: 400,
        body: {
          error: "The target parent has an invalid ancestor chain",
          code: ERROR_CODES.PAGE_PARENT_CYCLE,
        },
      };
    }

    visited.add(cursor);
    const ancestor = await loadPage(cursor);
    if (!ancestor) {
      break;
    }
    if (ancestor.workspaceId !== workspaceId) {
      return {
        statusCode: 400,
        body: {
          error: "Parent page not found in this workspace",
          code: ERROR_CODES.PAGE_PARENT_NOT_FOUND,
        },
      };
    }
    cursor = ancestor.parentPageId;
  }

  return null;
}

export async function getNextPageSortOrder(
  db: AnyDb,
  workspaceId: string,
  parentPageId: string | null,
): Promise<number> {
  const parentCondition =
    parentPageId === null
      ? isNull(pages.parentPageId)
      : eq(pages.parentPageId, parentPageId);

  const [lastSibling] = await db
    .select({ sortOrder: pages.sortOrder })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), parentCondition))
    .orderBy(desc(pages.sortOrder), desc(pages.createdAt))
    .limit(1);

  return lastSibling ? lastSibling.sortOrder + 1 : 0;
}
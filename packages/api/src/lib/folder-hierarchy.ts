import { and, desc, eq, isNull } from "drizzle-orm";
import { folders } from "@wekiflow/db";
import { ERROR_CODES } from "@wekiflow/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle query builder doesn't expose a clean shared interface for db/tx
type AnyDb = any;

export interface FolderHierarchyRow {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
}

export interface HierarchyValidationError {
  statusCode: number;
  body: {
    error: string;
    code: string;
  };
}

export async function loadFolderHierarchyRow(
  db: AnyDb,
  folderId: string,
): Promise<FolderHierarchyRow | null> {
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

export async function validateParentFolderAssignment(
  loadFolder: (folderId: string) => Promise<FolderHierarchyRow | null>,
  params: {
    workspaceId: string;
    folderId?: string;
    parentFolderId: string | null | undefined;
  },
): Promise<HierarchyValidationError | null> {
  const { workspaceId, folderId, parentFolderId } = params;
  if (parentFolderId == null) return null;

  if (folderId && parentFolderId === folderId) {
    return {
      statusCode: 400,
      body: {
        error: "A folder cannot be its own parent",
        code: ERROR_CODES.FOLDER_PARENT_INVALID,
      },
    };
  }

  const parent = await loadFolder(parentFolderId);
  if (!parent || parent.workspaceId !== workspaceId) {
    return {
      statusCode: 400,
      body: {
        error: "Parent folder not found in this workspace",
        code: ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
      },
    };
  }

  if (!folderId) return null;

  const visited = new Set<string>([parent.id]);
  let cursor = parent.parentFolderId;

  while (cursor) {
    if (cursor === folderId) {
      return {
        statusCode: 400,
        body: {
          error: "A folder cannot be moved under one of its descendants",
          code: ERROR_CODES.FOLDER_PARENT_CYCLE,
        },
      };
    }

    if (visited.has(cursor)) {
      return {
        statusCode: 400,
        body: {
          error: "The target parent has an invalid ancestor chain",
          code: ERROR_CODES.FOLDER_PARENT_CYCLE,
        },
      };
    }

    visited.add(cursor);
    const ancestor = await loadFolder(cursor);
    if (!ancestor) break;
    if (ancestor.workspaceId !== workspaceId) {
      return {
        statusCode: 400,
        body: {
          error: "Parent folder not found in this workspace",
          code: ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
        },
      };
    }
    cursor = ancestor.parentFolderId;
  }

  return null;
}

export async function validateFolderExistsInWorkspace(
  loadFolder: (folderId: string) => Promise<FolderHierarchyRow | null>,
  workspaceId: string,
  folderId: string,
): Promise<HierarchyValidationError | null> {
  const row = await loadFolder(folderId);
  if (!row || row.workspaceId !== workspaceId) {
    return {
      statusCode: 400,
      body: {
        error: "Parent folder not found in this workspace",
        code: ERROR_CODES.FOLDER_PARENT_NOT_FOUND,
      },
    };
  }
  return null;
}

export async function getNextFolderSortOrder(
  db: AnyDb,
  workspaceId: string,
  parentFolderId: string | null,
): Promise<number> {
  const parentCondition = parentFolderId
    ? eq(folders.parentFolderId, parentFolderId)
    : isNull(folders.parentFolderId);

  const [lastSibling] = await db
    .select({ sortOrder: folders.sortOrder })
    .from(folders)
    .where(and(eq(folders.workspaceId, workspaceId), parentCondition))
    .orderBy(desc(folders.sortOrder), desc(folders.createdAt))
    .limit(1);

  return lastSibling ? lastSibling.sortOrder + 1 : 0;
}

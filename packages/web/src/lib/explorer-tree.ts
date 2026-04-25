import type { Folder, Page, ReorderIntent } from "./api-client.js";

export type ExplorerKind = "folder" | "page";

export interface FolderBucket {
  byParent: Map<string | null, Folder[]>;
}

export interface PageBucket {
  byFolder: Map<string | null, Page[]>;
  byPage: Map<string, Page[]>;
}

function compareBySort<T extends { sortOrder: number; createdAt: string }>(
  a: T,
  b: T,
) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.createdAt.localeCompare(b.createdAt);
}

export function bucketFolders(folders: Folder[]): FolderBucket {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parentFolderId ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) arr.sort(compareBySort);
  return { byParent };
}

export function bucketPages(pages: Page[]): PageBucket {
  const byFolder = new Map<string | null, Page[]>();
  const byPage = new Map<string, Page[]>();
  for (const p of pages) {
    if (p.parentPageId) {
      const arr = byPage.get(p.parentPageId) ?? [];
      arr.push(p);
      byPage.set(p.parentPageId, arr);
    } else {
      const key = p.parentFolderId ?? null;
      const arr = byFolder.get(key) ?? [];
      arr.push(p);
      byFolder.set(key, arr);
    }
  }
  for (const arr of byFolder.values()) arr.sort(compareBySort);
  for (const arr of byPage.values()) arr.sort(compareBySort);
  return { byFolder, byPage };
}

// ---------------------------------------------------------------------------
// Descendant collection — used to block drops onto self/subtree
// ---------------------------------------------------------------------------

export function collectFolderSubtree(
  folderId: string,
  folderBucket: FolderBucket,
  pageBucket: PageBucket,
): { folderIds: Set<string>; pageIds: Set<string> } {
  const folderIds = new Set<string>([folderId]);
  const pageIds = new Set<string>();
  const walkFolder = (id: string) => {
    const kids = folderBucket.byParent.get(id) ?? [];
    for (const f of kids) {
      if (!folderIds.has(f.id)) {
        folderIds.add(f.id);
        walkFolder(f.id);
      }
    }
    const pages = pageBucket.byFolder.get(id) ?? [];
    for (const p of pages) {
      if (!pageIds.has(p.id)) {
        pageIds.add(p.id);
        walkPage(p.id);
      }
    }
  };
  const walkPage = (id: string) => {
    const kids = pageBucket.byPage.get(id) ?? [];
    for (const p of kids) {
      if (!pageIds.has(p.id)) {
        pageIds.add(p.id);
        walkPage(p.id);
      }
    }
  };
  walkFolder(folderId);
  return { folderIds, pageIds };
}

export function collectPageSubtree(
  pageId: string,
  pageBucket: PageBucket,
): Set<string> {
  const pageIds = new Set<string>([pageId]);
  const walk = (id: string) => {
    const kids = pageBucket.byPage.get(id) ?? [];
    for (const p of kids) {
      if (!pageIds.has(p.id)) {
        pageIds.add(p.id);
        walk(p.id);
      }
    }
  };
  walk(pageId);
  return pageIds;
}

// ---------------------------------------------------------------------------
// Drop intent — pointer Y within row decides before/after/asChild
// ---------------------------------------------------------------------------

export type DropPosition = "before" | "after" | "asChild";

export interface DropIntent {
  position: DropPosition;
  targetKind: ExplorerKind;
  targetId: string;
}

/**
 * Which drop positions are permitted, independent of which item is being
 * dragged. Folders can only become siblings of folders or children of folders.
 * Pages can interleave more freely because any row may be their parent.
 */
function positionAllowed(
  draggedKind: ExplorerKind,
  targetKind: ExplorerKind,
  position: DropPosition,
): boolean {
  if (draggedKind === "folder") {
    if (targetKind === "page") return false;
    return true;
  }
  // draggedKind === "page"
  if (targetKind === "folder") {
    return position === "asChild";
  }
  return true;
}

export interface ComputeDropIntentArgs {
  draggedKind: ExplorerKind;
  draggedId: string;
  targetKind: ExplorerKind;
  targetId: string;
  pointerY: number;
  rectTop: number;
  rectHeight: number;
  blockedIds: Set<string>;
}

export function computeDropIntent(
  args: ComputeDropIntentArgs,
): DropIntent | null {
  const {
    draggedKind,
    draggedId,
    targetKind,
    targetId,
    pointerY,
    rectTop,
    rectHeight,
    blockedIds,
  } = args;

  if (draggedId === targetId) return null;
  if (blockedIds.has(targetId)) return null;

  const rel = (pointerY - rectTop) / Math.max(rectHeight, 1);
  let position: DropPosition;
  if (rel < 0.25) position = "before";
  else if (rel > 0.75) position = "after";
  else position = "asChild";

  // Pointer near a folder's edge would naturally compute "before"/"after" —
  // but a page cannot be a sibling of a folder (distinct render groups), so
  // we quietly retarget to asChild instead of rejecting the drop.
  if (!positionAllowed(draggedKind, targetKind, position)) {
    if (positionAllowed(draggedKind, targetKind, "asChild")) {
      position = "asChild";
    } else {
      return null;
    }
  }

  return { position, targetKind, targetId };
}

export function intentToReorder(position: DropPosition, anchorId: string): ReorderIntent {
  if (position === "before") return { kind: "before", anchorId };
  if (position === "after") return { kind: "after", anchorId };
  return { kind: "asFirstChild" };
}

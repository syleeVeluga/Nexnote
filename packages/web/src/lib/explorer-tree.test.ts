import { describe, it, expect } from "vitest";
import {
  bucketFolders,
  bucketPages,
  collectFolderSubtree,
  collectPageSubtree,
  computeDropIntent,
} from "./explorer-tree.js";
import type { Folder, Page } from "./api-client.js";

function folder(
  id: string,
  parentFolderId: string | null = null,
  sortOrder = 0,
): Folder {
  return {
    id,
    workspaceId: "ws",
    parentFolderId,
    name: id,
    slug: id,
    sortOrder,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function page(
  id: string,
  opts: {
    parentPageId?: string | null;
    parentFolderId?: string | null;
    sortOrder?: number;
  } = {},
): Page {
  return {
    id,
    workspaceId: "ws",
    parentPageId: opts.parentPageId ?? null,
    parentFolderId: opts.parentFolderId ?? null,
    title: id,
    slug: id,
    status: "draft",
    sortOrder: opts.sortOrder ?? 0,
    currentRevisionId: null,
    lastAiUpdatedAt: null,
    lastHumanEditedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    latestRevisionActorType: null,
    latestRevisionSource: null,
    latestRevisionCreatedAt: null,
    latestRevisionSourceIngestionId: null,
    latestRevisionSourceDecisionId: null,
    publishedAt: null,
    isLivePublished: false,
  };
}

describe("bucketFolders + bucketPages", () => {
  it("groups folders by parent and sorts by sortOrder", () => {
    const fs = [folder("b", null, 1), folder("a", null, 0)];
    const bucket = bucketFolders(fs);
    const root = bucket.byParent.get(null);
    expect(root?.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("separates pages by folder-parent vs page-parent", () => {
    const ps = [
      page("p-root", { sortOrder: 0 }),
      page("p-in-folder", { parentFolderId: "fol-x", sortOrder: 0 }),
      page("p-child", { parentPageId: "p-root", sortOrder: 0 }),
    ];
    const bucket = bucketPages(ps);
    expect(bucket.byFolder.get(null)?.map((p) => p.id)).toEqual(["p-root"]);
    expect(bucket.byFolder.get("fol-x")?.map((p) => p.id)).toEqual(["p-in-folder"]);
    expect(bucket.byPage.get("p-root")?.map((p) => p.id)).toEqual(["p-child"]);
  });
});

describe("collectFolderSubtree / collectPageSubtree", () => {
  it("walks folders and the pages + page-descendants beneath them", () => {
    const folders = [folder("fol-a"), folder("fol-b", "fol-a")];
    const pages = [
      page("p-a", { parentFolderId: "fol-b" }),
      page("p-a-child", { parentPageId: "p-a" }),
      page("p-outside"),
    ];
    const { folderIds, pageIds } = collectFolderSubtree(
      "fol-a",
      bucketFolders(folders),
      bucketPages(pages),
    );
    expect(folderIds).toEqual(new Set(["fol-a", "fol-b"]));
    expect(pageIds).toEqual(new Set(["p-a", "p-a-child"]));
  });

  it("collects a page and all its page descendants", () => {
    const pages = [
      page("p"),
      page("p-c", { parentPageId: "p" }),
      page("p-cc", { parentPageId: "p-c" }),
    ];
    const subtree = collectPageSubtree("p", bucketPages(pages));
    expect(subtree).toEqual(new Set(["p", "p-c", "p-cc"]));
  });
});

describe("computeDropIntent", () => {
  const row = { rectTop: 100, rectHeight: 20 };

  it("returns 'before' near the top of the row", () => {
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "m",
      targetKind: "page",
      targetId: "t",
      pointerY: 102,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent?.position).toBe("before");
  });

  it("returns 'after' near the bottom of the row", () => {
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "m",
      targetKind: "page",
      targetId: "t",
      pointerY: 118,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent?.position).toBe("after");
  });

  it("returns 'asChild' in the middle of the row", () => {
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "m",
      targetKind: "page",
      targetId: "t",
      pointerY: 110,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent?.position).toBe("asChild");
  });

  it("rejects drop onto self", () => {
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "t",
      targetKind: "page",
      targetId: "t",
      pointerY: 110,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent).toBeNull();
  });

  it("rejects drop onto a descendant (subtree blocked)", () => {
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "m",
      targetKind: "page",
      targetId: "descendant",
      pointerY: 110,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(["descendant"]),
    });
    expect(intent).toBeNull();
  });

  it("rejects folder dropped on a page entirely", () => {
    const intent = computeDropIntent({
      draggedKind: "folder",
      draggedId: "m",
      targetKind: "page",
      targetId: "t",
      pointerY: 110,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent).toBeNull();
  });

  it("downgrades a page→folder before/after to asChild", () => {
    // Top quarter on a folder row would normally yield "before",
    // but page-before-folder would try to make the page a sibling of the
    // folder (disallowed), so the helper falls back to asChild.
    const intent = computeDropIntent({
      draggedKind: "page",
      draggedId: "m",
      targetKind: "folder",
      targetId: "t",
      pointerY: 102,
      rectTop: row.rectTop,
      rectHeight: row.rectHeight,
      blockedIds: new Set(),
    });
    expect(intent?.position).toBe("asChild");
  });
});

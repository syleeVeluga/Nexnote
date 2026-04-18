import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  findRestoreConflict,
  selectPagesDeletedWithRoot,
  type RestorePageSnapshot,
} from "./page-deletion.js";

function page(overrides: Partial<RestorePageSnapshot>): RestorePageSnapshot {
  return {
    id: "page-1",
    title: "Page 1",
    slug: "page-1",
    deletedAt: "2026-04-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("selectPagesDeletedWithRoot", () => {
  it("keeps only the pages deleted in the same trash batch as the root", () => {
    const result = selectPagesDeletedWithRoot(
      [
        page({ id: "root" }),
        page({ id: "child-same-batch", deletedAt: new Date("2026-04-19T10:00:00.000Z") }),
        page({ id: "child-older-batch", deletedAt: "2026-04-18T09:00:00.000Z" }),
      ],
      "2026-04-19T10:00:00.000Z",
    );

    assert.deepEqual(
      result.map((item) => item.id),
      ["root", "child-same-batch"],
    );
  });

  it("returns an empty list when the root has no delete marker", () => {
    const result = selectPagesDeletedWithRoot([page({ id: "root" })], null);
    assert.deepEqual(result, []);
  });
});

describe("findRestoreConflict", () => {
  it("detects slug conflicts for any page in the restored subtree", () => {
    const conflict = findRestoreConflict({
      restoringPages: [
        page({ id: "root", title: "Root", slug: "root" }),
        page({ id: "child", title: "Child", slug: "child" }),
      ],
      restoringPaths: [],
      activePages: [
        { id: "live-child", title: "Live Child", slug: "child" },
      ],
      activePaths: [],
    });

    assert.deepEqual(conflict, {
      kind: "slug",
      restoringPageId: "child",
      restoringTitle: "Child",
      conflictingPageId: "live-child",
      conflictingTitle: "Live Child",
      slug: "child",
    });
  });

  it("detects current path conflicts for descendant pages before restore", () => {
    const conflict = findRestoreConflict({
      restoringPages: [
        page({ id: "root", title: "Root", slug: "root" }),
        page({ id: "child", title: "Child", slug: "child" }),
      ],
      restoringPaths: [
        { pageId: "root", path: "root" },
        { pageId: "child", path: "root/child" },
      ],
      activePages: [],
      activePaths: [
        { pageId: "live-child", title: "Live Child", path: "root/child" },
      ],
    });

    assert.deepEqual(conflict, {
      kind: "path",
      restoringPageId: "child",
      restoringTitle: "Child",
      conflictingPageId: "live-child",
      conflictingTitle: "Live Child",
      path: "root/child",
    });
  });

  it("returns null when there is no slug or path collision", () => {
    const conflict = findRestoreConflict({
      restoringPages: [page({ id: "root", title: "Root", slug: "root" })],
      restoringPaths: [{ pageId: "root", path: "root" }],
      activePages: [{ id: "live", title: "Live", slug: "other" }],
      activePaths: [{ pageId: "live", title: "Live", path: "other" }],
    });

    assert.equal(conflict, null);
  });
});
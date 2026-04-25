import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ERROR_CODES } from "@wekiflow/shared";
import {
  validateParentFolderAssignment,
  type FolderHierarchyRow,
} from "./folder-hierarchy.js";

function makeLoader(rows: FolderHierarchyRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return async (folderId: string) => byId.get(folderId) ?? null;
}

describe("validateParentFolderAssignment", () => {
  it("allows moving a folder to the workspace root", async () => {
    const result = await validateParentFolderAssignment(makeLoader([]), {
      workspaceId: "ws-1",
      folderId: "fol-a",
      parentFolderId: null,
    });
    assert.equal(result, null);
  });

  it("allows assigning an existing parent in the same workspace", async () => {
    const result = await validateParentFolderAssignment(
      makeLoader([
        { id: "fol-parent", workspaceId: "ws-1", parentFolderId: null },
      ]),
      {
        workspaceId: "ws-1",
        folderId: "fol-a",
        parentFolderId: "fol-parent",
      },
    );
    assert.equal(result, null);
  });

  it("rejects a folder as its own parent", async () => {
    const result = await validateParentFolderAssignment(makeLoader([]), {
      workspaceId: "ws-1",
      folderId: "fol-a",
      parentFolderId: "fol-a",
    });
    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.FOLDER_PARENT_INVALID);
  });

  it("rejects a parent that does not exist in the workspace", async () => {
    const result = await validateParentFolderAssignment(
      makeLoader([
        { id: "fol-parent", workspaceId: "ws-2", parentFolderId: null },
      ]),
      {
        workspaceId: "ws-1",
        folderId: "fol-a",
        parentFolderId: "fol-parent",
      },
    );
    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.FOLDER_PARENT_NOT_FOUND);
  });

  it("rejects moving a folder under one of its descendants", async () => {
    // Tree: fol-a → fol-child → fol-grandchild
    const result = await validateParentFolderAssignment(
      makeLoader([
        { id: "fol-child", workspaceId: "ws-1", parentFolderId: "fol-a" },
        {
          id: "fol-grandchild",
          workspaceId: "ws-1",
          parentFolderId: "fol-child",
        },
      ]),
      {
        workspaceId: "ws-1",
        folderId: "fol-a",
        parentFolderId: "fol-grandchild",
      },
    );
    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.FOLDER_PARENT_CYCLE);
  });
});

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ERROR_CODES } from "@wekiflow/shared";
import {
  validateParentPageAssignment,
  type PageHierarchyRow,
} from "./page-hierarchy.js";

function makeLoader(rows: PageHierarchyRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return async (pageId: string) => byId.get(pageId) ?? null;
}

describe("validateParentPageAssignment", () => {
  it("allows moving a page to the workspace root", async () => {
    const result = await validateParentPageAssignment(makeLoader([]), {
      workspaceId: "ws-1",
      pageId: "page-a",
      parentPageId: null,
    });

    assert.equal(result, null);
  });

  it("allows assigning an existing parent in the same workspace", async () => {
    const result = await validateParentPageAssignment(
      makeLoader([
        { id: "page-parent", workspaceId: "ws-1", parentPageId: null },
      ]),
      {
        workspaceId: "ws-1",
        pageId: "page-a",
        parentPageId: "page-parent",
      },
    );

    assert.equal(result, null);
  });

  it("rejects assigning a page as its own parent", async () => {
    const result = await validateParentPageAssignment(makeLoader([]), {
      workspaceId: "ws-1",
      pageId: "page-a",
      parentPageId: "page-a",
    });

    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.PAGE_PARENT_INVALID);
  });

  it("rejects a parent page that does not exist in the workspace", async () => {
    const result = await validateParentPageAssignment(
      makeLoader([
        { id: "page-parent", workspaceId: "ws-2", parentPageId: null },
      ]),
      {
        workspaceId: "ws-1",
        pageId: "page-a",
        parentPageId: "page-parent",
      },
    );

    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.PAGE_PARENT_NOT_FOUND);
  });

  it("rejects moving a page under one of its descendants", async () => {
    const result = await validateParentPageAssignment(
      makeLoader([
        { id: "page-child", workspaceId: "ws-1", parentPageId: "page-a" },
        { id: "page-grandchild", workspaceId: "ws-1", parentPageId: "page-child" },
      ]),
      {
        workspaceId: "ws-1",
        pageId: "page-a",
        parentPageId: "page-grandchild",
      },
    );

    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.PAGE_PARENT_CYCLE);
  });

  it("rejects a target parent whose ancestor chain crosses workspace boundaries", async () => {
    const result = await validateParentPageAssignment(
      makeLoader([
        { id: "page-parent", workspaceId: "ws-1", parentPageId: "page-foreign" },
        { id: "page-foreign", workspaceId: "ws-2", parentPageId: null },
      ]),
      {
        workspaceId: "ws-1",
        pageId: "page-a",
        parentPageId: "page-parent",
      },
    );

    assert.ok(result);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, ERROR_CODES.PAGE_PARENT_NOT_FOUND);
  });
});
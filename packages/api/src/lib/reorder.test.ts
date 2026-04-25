import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ERROR_CODES } from "@wekiflow/shared";
import { computeReorderedSortOrders } from "./reorder.js";

const STEP = 1024;

describe("computeReorderedSortOrders", () => {
  it("inserts before the anchor and rewrites sortOrders in steps", () => {
    const siblings = [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 1024 },
      { id: "c", sortOrder: 2048 },
    ];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "before",
      anchorId: "b",
    });
    assert.deepEqual(result, [
      { id: "a", sortOrder: 0 },
      { id: "moving", sortOrder: STEP },
      { id: "b", sortOrder: STEP * 2 },
      { id: "c", sortOrder: STEP * 3 },
    ]);
  });

  it("inserts after the anchor", () => {
    const siblings = [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 1024 },
    ];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "after",
      anchorId: "a",
    });
    assert.deepEqual(result, [
      { id: "a", sortOrder: 0 },
      { id: "moving", sortOrder: STEP },
      { id: "b", sortOrder: STEP * 2 },
    ]);
  });

  it("places at first child", () => {
    const siblings = [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 1024 },
    ];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "asFirstChild",
    });
    assert.deepEqual(result, [
      { id: "moving", sortOrder: 0 },
      { id: "a", sortOrder: STEP },
      { id: "b", sortOrder: STEP * 2 },
    ]);
  });

  it("places at last child", () => {
    const siblings = [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 1024 },
    ];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "asLastChild",
    });
    assert.deepEqual(result, [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: STEP },
      { id: "moving", sortOrder: STEP * 2 },
    ]);
  });

  it("handles moving already-in-list before another sibling (no duplicate)", () => {
    // Moving row is already in the sibling set and is being reordered.
    const siblings = [
      { id: "a", sortOrder: 0 },
      { id: "moving", sortOrder: 1024 },
      { id: "b", sortOrder: 2048 },
    ];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "before",
      anchorId: "a",
    });
    assert.deepEqual(result, [
      { id: "moving", sortOrder: 0 },
      { id: "a", sortOrder: STEP },
      { id: "b", sortOrder: STEP * 2 },
    ]);
  });

  it("rejects an anchor that is not in the sibling set", () => {
    const siblings = [{ id: "a", sortOrder: 0 }];
    const result = computeReorderedSortOrders(siblings, "moving", {
      kind: "before",
      anchorId: "unknown",
    });
    assert.ok("body" in (result as object));
    if ("body" in (result as object)) {
      assert.equal(
        (result as { body: { code: string } }).body.code,
        ERROR_CODES.REORDER_ANCHOR_NOT_FOUND,
      );
    }
  });
});

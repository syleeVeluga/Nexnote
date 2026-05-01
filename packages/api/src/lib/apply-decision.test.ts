import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { findSourceSubtreeContainingPage } from "./apply-decision.js";

describe("findSourceSubtreeContainingPage", () => {
  it("returns the source page whose subtree contains the protected page", () => {
    const result = findSourceSubtreeContainingPage({
      protectedPageId: "canonical",
      sourceSubtrees: [
        { sourcePageId: "source-a", descendantPageIds: ["source-a"] },
        {
          sourcePageId: "source-b",
          descendantPageIds: ["source-b", "canonical", "child"],
        },
      ],
    });

    assert.equal(result, "source-b");
  });

  it("returns null when the protected page is outside all source subtrees", () => {
    const result = findSourceSubtreeContainingPage({
      protectedPageId: "canonical",
      sourceSubtrees: [
        { sourcePageId: "source-a", descendantPageIds: ["source-a"] },
        { sourcePageId: "source-b", descendantPageIds: ["source-b", "child"] },
      ],
    });

    assert.equal(result, null);
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deriveActivitySummary, readNumber } from "./activity-summary.js";

describe("deriveActivitySummary", () => {
  it("prefers revision notes over inferred copy", () => {
    assert.equal(
      deriveActivitySummary({
        action: "update",
        entityType: "page",
        afterJson: { source: "patch_generator_auto" },
        beforeJson: null,
        revisionNote: "Merged pricing notes",
        changedBlocks: 3,
      }),
      "Merged pricing notes",
    );
  });

  it("summarizes changed block counts when no note exists", () => {
    assert.equal(
      deriveActivitySummary({
        action: "append",
        entityType: "page",
        afterJson: null,
        beforeJson: null,
        revisionNote: null,
        changedBlocks: 1,
      }),
      "Appended 1 block",
    );
  });

  it("describes auto-created pages", () => {
    assert.equal(
      deriveActivitySummary({
        action: "create",
        entityType: "page",
        afterJson: { source: "route_classifier_auto" },
        beforeJson: null,
        revisionNote: null,
        changedBlocks: null,
      }),
      "Created from an auto-applied ingestion",
    );
  });
});

describe("readNumber", () => {
  it("accepts finite JSON numbers only", () => {
    assert.equal(readNumber(0.93), 0.93);
    assert.equal(readNumber("0.93"), null);
    assert.equal(readNumber(Number.NaN), null);
  });
});

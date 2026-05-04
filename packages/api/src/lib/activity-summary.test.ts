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

  it("summarizes completed ingestion agent runs", () => {
    assert.equal(
      deriveActivitySummary({
        action: "agent_run_completed",
        entityType: "ingestion",
        afterJson: {
          sourceName: "Slack",
          proposedMutations: 3,
          autoAppliedCount: 1,
          queuedCount: 2,
        },
        beforeJson: null,
        revisionNote: null,
        changedBlocks: null,
      }),
      "Agent ran for ingestion Slack - 3 mutations proposed (1 auto-applied, 2 queued)",
    );
  });

  it("labels agent reorganization actions", () => {
    assert.equal(
      deriveActivitySummary({
        action: "agent.move_page",
        entityType: "page",
        afterJson: { tool: "move_page" },
        beforeJson: null,
        revisionNote: null,
        changedBlocks: null,
      }),
      "AI moved the page",
    );
    assert.equal(
      deriveActivitySummary({
        action: "agent.create_folder",
        entityType: "folder",
        afterJson: { name: "Research" },
        beforeJson: null,
        revisionNote: null,
        changedBlocks: null,
      }),
      'AI created folder "Research"',
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
